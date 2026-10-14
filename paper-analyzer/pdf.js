// ================================================================
// PDF.JS VIEWER STATE & TEXT EXTRACTION
// ================================================================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const pdfViewer = {
  task: null,    // current PDFDocumentLoadingTask (so we can cancel on navigation)
  pages: []      // [{pageNum, items, viewport, hlCanvas, wrapper}]
};

async function loadPdfViewer(blobUrl, initialSearch) {
  const container = document.getElementById('pdf-pages');
  container.innerHTML = '';
  document.getElementById('pdf-page-info').textContent = '';
  pdfViewer.pages = [];

  if (pdfViewer.task) { try { pdfViewer.task.destroy(); } catch (_) {} }
  pdfViewer.task = null;

  if (!blobUrl) {
    container.innerHTML = '<p class="text-gray-700 text-sm mt-16 text-center">No PDF loaded</p>';
    return;
  }

  const loading = document.createElement('p');
  loading.className = 'text-gray-600 text-sm mt-16 text-center';
  loading.textContent = 'Loading PDF…';
  container.appendChild(loading);

  try {
    const task = pdfjsLib.getDocument(blobUrl);
    pdfViewer.task = task;
    const doc = await task.promise;
    container.innerHTML = '';
    document.getElementById('pdf-page-info').textContent = `${doc.numPages} pages`;

    let highlightDone = false;
    for (let n = 1; n <= doc.numPages; n++) {
      if (pdfViewer.task !== task) break;

      const page = await doc.getPage(n);
      const SCALE = 1.4;
      const vp    = page.getViewport({ scale: SCALE });

      const wrap = document.createElement('div');
      wrap.id = `pdf-pg-${n}`;
      wrap.style.cssText = `position:relative;width:${vp.width}px;height:${vp.height}px;flex-shrink:0;box-shadow:0 2px 10px rgba(0,0,0,.6);background:#fff;`;

      const cv = document.createElement('canvas');
      cv.width  = vp.width;
      cv.height = vp.height;
      cv.style.display = 'block';

      const hl = document.createElement('canvas');
      hl.width  = vp.width;
      hl.height = vp.height;
      hl.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';

      wrap.append(cv, hl);
      container.appendChild(wrap);

      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const tc = await page.getTextContent();
      page.cleanup();

      pdfViewer.pages.push({ pageNum: n, items: tc.items, viewport: vp, hlCanvas: hl, wrapper: wrap });

      if (!highlightDone && initialSearch) {
        const stripped = stripLatex(initialSearch);
        const score = tryHighlightOnPage(pdfViewer.pages[pdfViewer.pages.length - 1], stripped);
        if (score >= 0.38) {
          highlightDone = true;
          scrollPdfTo(wrap);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'RenderingCancelledException' && err.message !== 'Worker was destroyed') {
      container.innerHTML = `<p class="text-red-400 text-sm mt-16 text-center px-4">PDF error: ${escapeHtml(err.message)}</p>`;
    }
  }
}

// ── Normalise a single word for matching ──────────────────────────
function normWord(w) {
  return w
    .toLowerCase()
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[‐-―−−]/g, '-')
    .replace(/^[^a-z0-9\-']+|[^a-z0-9\-']+$/g, '')
    .trim();
}

// ── Levenshtein distance (for fuzzy word matching) ─────────────────
function editDist(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[b.length];
}

function wordsMatch(a, b) {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  return editDist(a, b) <= (minLen >= 8 ? 2 : 1);
}

function buildWordIndex(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (const raw of (items[i].str || '').split(/\s+/)) {
      const n = normWord(raw);
      if (n && n.length >= 2) out.push({ n, i });
    }
  }
  return out;
}

// Shared highlight drawing helper used by both matchers below.
function drawHighlight(page, firstItemIdx, lastItemIdx) {
  const ctx = page.hlCanvas.getContext('2d');
  ctx.clearRect(0, 0, page.hlCanvas.width, page.hlCanvas.height);
  ctx.fillStyle = 'rgba(255, 210, 0, 0.45)';
  const vt = page.viewport.transform;
  let sumY = 0, count = 0;
  for (let i = firstItemIdx; i <= lastItemIdx; i++) {
    const item = page.items[i];
    if (!item || !item.str || !item.str.trim()) continue;
    const [, , , d, e, f] = item.transform;
    const x = e * vt[0] + vt[4];
    const y = f * vt[3] + vt[5];
    const w = (item.width || 0) * Math.abs(vt[0]);
    const h = Math.abs(d * vt[3]) * 1.2;
    ctx.fillRect(x, y - h, Math.max(w, 5), h);
    sumY += y - h / 2;
    count++;
  }
  if (count) _lastHighlightY = sumY / count;
}

// Returns match quality 0..1 (0 = nothing found, 1 = perfect).
// Draws the highlight only when draw=true and score > 0.
function tryHighlightOnPage(page, searchText, draw = true) {
  if (!page || !searchText) return 0;

  const sWords = searchText.split(/\s+/).map(normWord).filter(w => w.length >= 2);
  if (!sWords.length) return 0;

  const pWords = buildWordIndex(page.items);
  if (!pWords.length) return 0;

  const maxSkips = Math.max(1, Math.floor(sWords.length / 6));

  let bestStart = -1, bestLen = 0, bestEndPi = -1;

  for (let pi = 0; pi < pWords.length; pi++) {
    if (!wordsMatch(pWords[pi].n, sWords[0])) continue;

    let len = 0, qi = 0, pj = pi, skips = 0, lastMatchPj = pi;

    while (qi < sWords.length && pj < pWords.length) {
      if (wordsMatch(pWords[pj].n, sWords[qi])) {
        len++; qi++; lastMatchPj = pj; pj++;
        skips = 0;
      } else if (skips < maxSkips && pWords[pj].n.length <= 3) {
        skips++; pj++;
      } else {
        break;
      }
    }

    if (len > bestLen) {
      bestLen = len;
      bestStart = pi;
      bestEndPi = lastMatchPj;
      if (bestLen === sWords.length) break;
    }
  }

  if (bestStart < 0 || bestLen === 0) return 0;

  if (draw) drawHighlight(page, pWords[bestStart].i, pWords[bestEndPi].i);

  // Scale down short-word matches (< 3 words) to avoid beating equation search on "ev" alone.
  const coveragePenalty = Math.min(sWords.length, 3) / 3;
  return (bestLen / sWords.length) * coveragePenalty;
}

// Normalize mathematical unicode variants (italic, bold, script…) to plain ASCII.
// Handles the Mathematical Alphanumeric Symbols block U+1D400–U+1D7FF used by
// some PDF math fonts. Also maps visually ambiguous chars (1↔l, 0↔o) so that
// Gemini typos like "P_{1oss}" still match the PDF's "P_{loss}".
function normEquationChar(c) {
  const cp = c.codePointAt(0);
  // Odia/Ethiopic/Malayalam chars produced by some PDF math fonts (e.g. g_d0_f8)
  // whose ToUnicode table maps custom glyph slots to these script codepoints.
  switch (cp) {
    case 0x0B48: return 'd';   // ୈ → D
    case 0x0B6A: return 'l';   // ୪ → l
    case 0x0B6D: return 'o';   // ୭ → o
    case 0x0B71: return 's';   // ୱ → s
    case 0x0B67: return 'i';   // ୧ → i
    case 0x0B6B: return 'm';   // ୫ → m
    case 0x0B5F: return 'a';   // ୟ → a
    case 0x0B76: return 'x';   // ୶ → x
    case 0x0B6C: return 'n';   // ୬ → n
    case 0x0B66: return 'h';   // ୦ → h
    case 0x0B4C: return 'cs';  // ୌ → cs (subscript ligature)
    case 0x0B69: return 'k';   // ୩ → k
    case 0x123A: return '(';   // ሺ → (
    case 0x123B: return ')';   // ሻ → )
    case 0x0D45: return '+';   // ൅ → +
    case 0x0D51: return '=';   // ൑ → ≤
    case 0x0D4C: return '=';   // ൌ → =
  }
  // Bold uppercase A-Z
  if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCharCode(0x41 + cp - 0x1D400);
  // Bold lowercase a-z
  if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCharCode(0x61 + cp - 0x1D41A);
  // Italic uppercase A-Z
  if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCharCode(0x41 + cp - 0x1D434);
  // Italic lowercase a-z (gap at 0x1D455; italic h = U+210E handled below)
  if (cp >= 0x1D44E && cp <= 0x1D467 && cp !== 0x1D455) return String.fromCharCode(0x61 + cp - 0x1D44E);
  if (cp === 0x210E) return 'h'; // Planck constant ℎ = italic h
  // Bold italic uppercase/lowercase
  if (cp >= 0x1D468 && cp <= 0x1D481) return String.fromCharCode(0x41 + cp - 0x1D468);
  if (cp >= 0x1D482 && cp <= 0x1D49B) return String.fromCharCode(0x61 + cp - 0x1D482);
  // Subscript digits ₀-₉
  if (cp >= 0x2080 && cp <= 0x2089) return String.fromCharCode(0x30 + cp - 0x2080);
  // Superscript ¹²³ and ⁰⁴-⁹
  if (cp === 0x00B9) return '1';
  if (cp === 0x00B2) return '2';
  if (cp === 0x00B3) return '3';
  if (cp === 0x2070) return '0';
  if (cp >= 0x2074 && cp <= 0x2079) return String.fromCharCode(0x30 + cp - 0x2070);
  return c;
}

// Build a canonical fingerprint: alnum only, lowercase, math unicode collapsed,
// and visually ambiguous pairs unified (1→l, 0→o) so OCR/Gemini typos don't block matches.
function makeFingerprint(str) {
  return [...str]                           // iterate by code point (handles surrogates)
    .map(normEquationChar)
    .join('')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .replace(/1/g, 'l')                     // 1 and l look identical in many fonts
    .replace(/0/g, 'o');                    // 0 and o likewise
}

// Decode PDF math-font characters (Odia/Ethiopic/Malayalam) to human-readable ASCII for display.
// Mirrors the switch in normEquationChar but keeps uppercase D and uses proper symbols (≤).
function decodePdfMathChars(text) {
  return [...text].map(c => {
    switch (c.codePointAt(0)) {
      case 0x0B48: return 'D';   // ୈ → D
      case 0x0B6A: return 'l';   // ୪ → l
      case 0x0B6D: return 'o';   // ୭ → o
      case 0x0B71: return 's';   // ୱ → s
      case 0x0B67: return 'i';   // ୧ → i
      case 0x0B6B: return 'm';   // ୫ → m
      case 0x0B5F: return 'a';   // ୟ → a
      case 0x0B76: return 'x';   // ୶ → x
      case 0x0B6C: return 'n';   // ୬ → n
      case 0x0B66: return 'h';   // ୦ → h
      case 0x0B4C: return 'cs';  // ୌ → cs
      case 0x0B69: return 'k';   // ୩ → k
      case 0x123A: return '(';   // ሺ → (
      case 0x123B: return ')';   // ሻ → )
      case 0x0D45: return '+';   // ൅ → +
      case 0x0D51: return '≤';   // ൑ → ≤
      case 0x0D4C: return '=';   // ൌ → =
      default: return c;
    }
  }).join('');
}

// Canvas Y of the most-recently drawn highlight centre (set by draw helpers, used by scrollPdfTo).
let _lastHighlightY = null;

// Draw highlights for a specific set of original item indices.
// fillStyle / doClear are optional — callers that show multiple overlapping hits set doClear=false.
function drawHighlightSet(page, origIdxSet, fillStyle = 'rgba(255, 210, 0, 0.45)', doClear = true) {
  const ctx = page.hlCanvas.getContext('2d');
  if (doClear) ctx.clearRect(0, 0, page.hlCanvas.width, page.hlCanvas.height);
  ctx.fillStyle = fillStyle;
  const vt = page.viewport.transform;
  let sumY = 0, count = 0;
  for (const i of origIdxSet) {
    const item = page.items[i];
    if (!item || !item.str || !item.str.trim()) continue;
    const [, , , d, e, f] = item.transform;
    const x = e * vt[0] + vt[4];
    const y = f * vt[3] + vt[5];
    const w = (item.width || 0) * Math.abs(vt[0]);
    const h = Math.abs(d * vt[3]) * 1.2;
    ctx.fillRect(x, y - h, Math.max(w, 5), h);
    sumY += y - h / 2;
    count++;
  }
  if (count) _lastHighlightY = sumY / count;
}

// Equation-aware matcher. Strategy:
//   1. Sort page items into reading order (top→bottom, left→right) — PDF streams
//      don't guarantee order, especially for subscripts.
//   2. Build a canonical fingerprint (alnum, math-unicode-normalized, 1↔l/0↔o unified).
//   3. Longest-contiguous-substring pass: find largest chunk of fp in pageFp.
//   4. Windowed-subsequence pass: allow other chars interspersed within a bounded window,
//      handles equations whose chars are separated by stray glyph items in the stream.
function tryHighlightEquation(page, searchText, draw = true) {
  const fp = makeFingerprint(searchText);
  if (fp.length < 4) return 0;

  // Group items into "visual lines" by y-coordinate with a threshold large enough to
  // catch math subscripts/superscripts (~10 viewport units ≈ 4–6pt at scale 1.4).
  // Within each line, sort left-to-right by x.
  // This mirrors how Gemini reads the PDF: V_{i,min} is one visual token "V i,min"
  // even though the subscript is a separate item at a slightly lower y position.
  const Y_THRESH = 10;
  const lineMap = new Map(); // representative y → [{origIdx, x, str}]
  for (let origIdx = 0; origIdx < page.items.length; origIdx++) {
    const item = page.items[origIdx];
    const y = item.transform[5];
    const x = item.transform[4];
    let lineKey = null;
    for (const [ky] of lineMap) {
      if (Math.abs(ky - y) <= Y_THRESH) { lineKey = ky; break; }
    }
    if (lineKey === null) { lineKey = y; lineMap.set(lineKey, []); }
    lineMap.get(lineKey).push({ origIdx, x, str: item.str || '' });
  }

  // Top-to-bottom line order, left-to-right within each line.
  const sortedLines = [...lineMap.entries()]
    .sort(([ya], [yb]) => yb - ya)
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x));

  const pageChars = [];
  for (const line of sortedLines) {
    for (const part of line) {
      for (const c of makeFingerprint(part.str)) {
        pageChars.push({ char: c, origIdx: part.origIdx });
      }
    }
  }
  if (pageChars.length < 4) return 0;

  const pageFp = pageChars.map(c => c.char).join('');

  if (draw) {
    console.debug('[pdf] eq search fp:', fp);
    console.debug('[pdf] page', page.pageNum, 'fp (first 150):', pageFp.slice(0, 150));
  }

  // ── Pass 1: longest contiguous substring of fp in pageFp ─────────────
  const minLen = Math.max(4, Math.floor(fp.length * 0.4));
  for (let len = fp.length; len >= minLen; len--) {
    for (let fStart = 0; fStart <= fp.length - len; fStart++) {
      const sub = fp.slice(fStart, fStart + len);
      const idx = pageFp.indexOf(sub);
      if (idx >= 0) {
        if (draw) drawHighlightSet(page, new Set(pageChars.slice(idx, idx + len).map(c => c.origIdx)));
        return len / fp.length;
      }
    }
  }

  // ── Pass 2: windowed subsequence (chars in order, gaps allowed) ───────
  // Tighter window + density penalty: chars spread sparsely across the page are
  // almost always false positives (common letters coincidentally in the right order).
  const maxWin = Math.min(fp.length * 3, 60);
  let bestScore = 0, bestChars = null;

  for (let start = 0; start <= pageFp.length - 2; start++) {
    if (pageFp[start] !== fp[0]) continue;
    let si = 0, pi = start;
    const limit = Math.min(pageFp.length, start + maxWin);
    const matched = [];
    while (si < fp.length && pi < limit) {
      if (pageFp[pi] === fp[si]) { matched.push(pi); si++; }
      pi++;
    }
    const recall  = si / fp.length;
    const span    = matched.length >= 2 ? matched[matched.length - 1] - matched[0] + 1 : 1;
    const density = matched.length / Math.max(span, 1);
    // Penalise matches where chars are spread over a much larger span than the fingerprint;
    // density < 0.5 starts losing points, density < 0.25 is heavily penalised.
    const score   = recall * Math.min(1, density * 2);
    if (score > bestScore) { bestScore = score; bestChars = matched.slice(); }
    if (bestScore >= 1) break;
  }

  if (bestScore >= 0.6 && bestChars) {
    if (draw) drawHighlightSet(page, new Set(bestChars.map(i => pageChars[i].origIdx)));
    return bestScore;
  }

  return 0;
}

function splitOnEllipsis(text) {
  const segs = text
    .split(/\[\s*[.…]{2,}\s*\]|\s\.{3,}\s/)
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).map(normWord).filter(w => w.length >= 2).length >= 3);
  return segs.length ? segs : [text];
}

function firstNTokens(text, n) {
  return text.split(/\s+/).slice(0, n).join(' ');
}

// rawText may contain LaTeX ($...$, \cmd). Equation evidence is searched two ways:
//   1. Full stripped text — subscripts kept (e.g. "PD(h)+EVD(h)")
//   2. Base-only stripped — subscripts removed (e.g. "P(h)+EV(h)")
// Both are tried so that the windowed-subsequence matcher can find base chars even
// when subscript items appear out-of-order in the PDF content stream.
function highlightPdf(rawText) {
  if (!rawText || !pdfViewer.pages.length) return;
  for (const p of pdfViewer.pages) {
    p.hlCanvas.getContext('2d').clearRect(0, 0, p.hlCanvas.width, p.hlCanvas.height);
  }

  // Build candidate search strings.
  const candidates = [stripLatex(rawText)];
  if (isEquationLike(rawText)) {
    const base = stripLatexBaseOnly(rawText);
    if (base !== candidates[0]) candidates.push(base);
  }

  // Run word-search and equation-search on completely independent tracks so a
  // good word match on one page cannot block an equation match on another page.
  let bestWordScore = 0, bestWordPage = null, bestWordPhrase = null;
  let bestEqScore   = 0, bestEqPage   = null, bestEqPhrase   = null;

  for (const candidate of candidates) {
    for (const seg of splitOnEllipsis(candidate)) {
      const wordPhrase = firstNTokens(seg, 8);
      // Use more text for equation search so the fingerprint is longer and more distinctive.
      // A longer fingerprint (e.g. 20+ chars) is far less likely to produce false positives
      // than the 6-8 char fingerprint that firstNTokens(seg, 8) typically yields for equations.
      const eqPhrase = seg.length > 120 ? seg.slice(0, 120) : seg;
      for (const page of pdfViewer.pages) {
        if (wordPhrase) {
          const ws = tryHighlightOnPage(page, wordPhrase, false);
          if (ws > bestWordScore) { bestWordScore = ws; bestWordPage = page; bestWordPhrase = wordPhrase; }
        }
        const es = tryHighlightEquation(page, eqPhrase, false);
        if (es > bestEqScore) { bestEqScore = es; bestEqPage = page; bestEqPhrase = eqPhrase; }
      }
    }
  }

  // Equation wins when the text looks like an equation (LaTeX or PDF math font chars)
  // and equation search found anything — regardless of word score.
  // Otherwise equation wins if its score is at least 75% of the word score.
  const eqLike = candidates.some(c => isEquationLike(c) || hasEquationChars(c));
  // Require a meaningful eq score even for eqLike text — prevents a barely-there fingerprint
  // match (score 0.05 from two common letters) from beating a strong word match.
  const preferEq = bestEqScore >= 0.4 && (eqLike || bestEqScore >= bestWordScore * 0.75);

  const bestPage   = preferEq ? bestEqPage   : bestWordPage;
  const bestPhrase = preferEq ? bestEqPhrase : bestWordPhrase;
  const useEq      = preferEq;
  const bestScore  = preferEq ? bestEqScore  : bestWordScore;

  console.debug('[pdf] search — word:', bestWordScore.toFixed(2), bestWordPage ? 'p'+bestWordPage.pageNum : '-',
    '| eq:', bestEqScore.toFixed(2), bestEqPage ? 'p'+bestEqPage.pageNum : '-',
    '| eqLike:', eqLike, '→ using', useEq ? 'EQ' : 'WORD', bestScore.toFixed(2));

  if (bestPage) {
    _lastHighlightY = null;
    if (useEq) tryHighlightEquation(bestPage, bestPhrase, true);
    else tryHighlightOnPage(bestPage, bestPhrase, true);
    scrollPdfTo(bestPage.wrapper, _lastHighlightY);
  }
}

function scrollPdfTo(wrapper, highlightY) {
  const container = document.getElementById('pdf-viewer-wrap');
  if (!container || !wrapper) return;
  const containerRect  = container.getBoundingClientRect();
  const wrapperRect    = wrapper.getBoundingClientRect();
  const wrapperTop     = wrapperRect.top - containerRect.top + container.scrollTop;
  const targetTop = highlightY != null
    ? wrapperTop + highlightY - container.clientHeight / 2
    : wrapperTop - 12;
  container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}

async function extractPdfText(blobUrl) {
  const task = pdfjsLib.getDocument(blobUrl);
  const doc  = await task.promise;
  const pageParts = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc   = await page.getTextContent();
    page.cleanup();

    const lines = [];
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = item.transform[5];
      const x = item.transform[4];
      let line = lines.find(l => Math.abs(l.y - y) < 4);
      if (!line) { line = { y, parts: [] }; lines.push(line); }
      line.parts.push({ x, text: item.str });
    }

    lines.sort((a, b) => b.y - a.y);
    const pageText = lines
      .map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.text).join(' '))
      .join('\n');

    pageParts.push(`--- Page ${n} ---\n${pageText}`);
  }

  doc.destroy();
  return pageParts.join('\n\n');
}

// Scan the first 3 pages of a PDF and return { doi, text }.
async function extractPdfMeta(blobUrl) {
  try {
    const doc = await pdfjsLib.getDocument(blobUrl).promise;
    const pagesToCheck = Math.min(doc.numPages, 3);
    let text = '';
    for (let n = 1; n <= pagesToCheck; n++) {
      const page = await doc.getPage(n);
      const tc   = await page.getTextContent();
      page.cleanup();
      text += tc.items.map(it => it.str).join(' ') + '\n';
    }
    doc.destroy();
    const m = text.match(/\b10\.\d{4,9}\/[^\s,;)\]"'< -]+/i);
    const doi = m ? m[0].replace(/[.,;:)\]"']+$/, '').toLowerCase() : null;
    return { doi, text };
  } catch {
    return { doi: null, text: '' };
  }
}

async function extractPdfDoi(blobUrl) {
  return (await extractPdfMeta(blobUrl)).doi;
}

// Score how well a CSV title matches a PDF text block (0–1).
// Uses the alnum fingerprint: requires >=90% of chars to appear contiguously.
function titleMatchScore(csvTitle, pdfText) {
  if (!csvTitle || csvTitle.length < 10) return 0;
  const tfp = makeFingerprint(csvTitle);
  const pfp = makeFingerprint(pdfText);
  if (tfp.length < 8) return 0;
  if (pfp.includes(tfp)) return 1.0;
  const minLen = Math.ceil(tfp.length * 0.9);
  for (let len = tfp.length - 1; len >= minLen; len--) {
    for (let s = 0; s <= tfp.length - len; s++) {
      if (pfp.includes(tfp.slice(s, s + len))) return len / tfp.length;
    }
  }
  return 0;
}

// ── Exact-match multi-hit manual search ───────────────────────────
const pdfSearch = { hits: [], idx: -1, term: '' };
// hits = [{page, itemSet: Set<origIdx>}], one entry per occurrence across all pages.

// Normalise text for case-insensitive exact matching (ligatures, dashes, whitespace).
function _normSearch(s) {
  return s.toLowerCase()
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[−‐–—]/g, '-')
    .replace(/\s+/g, ' ');
}

// Build a character-level index for a page: each entry is {char, origIdx}.
// Joining chars produces the normalised full-text of the page.
function _buildPageCharIndex(items) {
  const chars = [];
  for (let j = 0; j < items.length; j++) {
    const norm = _normSearch(items[j].str || '');
    for (const c of norm) chars.push({ char: c, origIdx: j });
    if (norm && !norm.endsWith(' ')) chars.push({ char: ' ', origIdx: j });
  }
  return chars;
}

// Find all exact (case-insensitive) occurrences of normTerm on a single page.
// Returns an array of Set<origIdx>, one per occurrence.
function _findExactOnPage(page, normTerm) {
  const chars    = _buildPageCharIndex(page.items);
  const fullText = chars.map(c => c.char).join('');
  const results  = [];
  let from = 0;
  while (from <= fullText.length - normTerm.length) {
    const idx = fullText.indexOf(normTerm, from);
    if (idx === -1) break;
    results.push(new Set(chars.slice(idx, idx + normTerm.length).map(c => c.origIdx)));
    from = idx + normTerm.length; // non-overlapping
  }
  return results;
}

function pdfSearchReset() {
  pdfSearch.hits = [];
  pdfSearch.idx  = -1;
  pdfSearch.term = '';
  const counter = document.getElementById('pdf-search-counter');
  if (counter) counter.textContent = '';
}

function searchPdfManual() {
  const raw = (document.getElementById('pdf-search-input')?.value || '').trim();
  if (!raw) return;
  if (!pdfViewer.pages.length) { toast('No PDF loaded', 'gray'); return; }

  const normTerm = _normSearch(raw);
  pdfSearch.term = raw;
  pdfSearch.hits = [];
  pdfSearch.idx  = -1;

  for (const page of pdfViewer.pages) {
    for (const itemSet of _findExactOnPage(page, normTerm)) {
      pdfSearch.hits.push({ page, itemSet });
    }
  }

  for (const p of pdfViewer.pages)
    p.hlCanvas.getContext('2d').clearRect(0, 0, p.hlCanvas.width, p.hlCanvas.height);

  if (!pdfSearch.hits.length) {
    toast('No matches found', 'gray');
    const counter = document.getElementById('pdf-search-counter');
    if (counter) counter.textContent = '0 / 0';
    return;
  }

  pdfSearch.idx = 0;
  _drawPdfSearchCurrent();
}

function _drawPdfSearchCurrent() {
  // Clear all canvases first.
  for (const p of pdfViewer.pages)
    p.hlCanvas.getContext('2d').clearRect(0, 0, p.hlCanvas.width, p.hlCanvas.height);

  // Dim overlay for every hit (accumulate on the same canvas without clearing).
  for (const { page, itemSet } of pdfSearch.hits) {
    drawHighlightSet(page, itemSet, 'rgba(255, 200, 0, 0.18)', false);
  }

  // Bright overlay for current hit (draw on top, no clear).
  const curr = pdfSearch.hits[pdfSearch.idx];
  if (!curr) return;
  _lastHighlightY = null;
  drawHighlightSet(curr.page, curr.itemSet, 'rgba(255, 165, 0, 0.55)', false);
  scrollPdfTo(curr.page.wrapper, _lastHighlightY);

  const counter = document.getElementById('pdf-search-counter');
  if (counter) counter.textContent = `${pdfSearch.idx + 1} / ${pdfSearch.hits.length}`;
}

function pdfSearchNav(dir) {
  const raw = (document.getElementById('pdf-search-input')?.value || '').trim();
  if (!raw) return;
  if (!pdfSearch.hits.length || raw !== pdfSearch.term) {
    searchPdfManual();
    return;
  }
  pdfSearch.idx = (pdfSearch.idx + dir + pdfSearch.hits.length) % pdfSearch.hits.length;
  _drawPdfSearchCurrent();
}

function cleanSearchTerm(text) {
  if (!text) return '';
  let s = text
    .replace(/["""''«»]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > 60) {
    const cut = s.substring(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    s = lastSpace > 20 ? cut.substring(0, lastSpace) : cut;
  }
  return s;
}
