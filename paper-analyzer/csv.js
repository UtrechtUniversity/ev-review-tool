// ================================================================
// SCOPUS CSV WORKFLOW — one paper at a time, with one-paper lookahead
// ================================================================

// Minimal RFC 4180 CSV parser — handles quoted fields, embedded commas/newlines.
function parseCsvRaw(text) {
  text = text.replace(/^﻿/, ''); // strip BOM

  const lines = [];
  let row = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        lines.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  row.push(field);
  if (row.some(v => v.trim())) lines.push(row);

  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].map(h => h.trim());
  const rows = lines.slice(1).map(cells => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

// ----------------------------------------------------------------
// CSV file input handlers (for the setup screen drop zone)
// ----------------------------------------------------------------
function handleCsvDragOver(e) {
  e.preventDefault();
  document.getElementById('csv-drop-zone').classList.add('drag-active');
}
function handleCsvDragLeave() {
  document.getElementById('csv-drop-zone').classList.remove('drag-active');
}
function handleCsvDrop(e) {
  e.preventDefault();
  document.getElementById('csv-drop-zone').classList.remove('drag-active');
  const f = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.csv'));
  if (f) readCsvFile(f);
}
function handleCsvFile(input) {
  if (input.files[0]) readCsvFile(input.files[0]);
}
function readCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => loadCsvData(e.target.result, file.name);
  reader.readAsText(file, 'utf-8');
}

// ----------------------------------------------------------------
// Parse + filter
// ----------------------------------------------------------------
function copyPrefetchTitle(offset) {
  const title = document.getElementById(`prefetch-title-${offset}`)?.textContent?.trim();
  if (!title) return;
  navigator.clipboard.writeText(title).then(() => toast(`Title copied`, 'gray'));
}

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findNextUnverifiedIdx(from) {
  for (let i = from; i < S.papers.length; i++) {
    if (!S.papers[i]._verified) return i;
  }
  return -1;
}

function loadCsvData(text, filename) {
  const { headers, rows } = parseCsvRaw(text);
  if (!headers.length) return alert('Could not parse CSV — is it a valid Scopus export?');

  // Screened CSV (from abstract-scanning.html): keep only rows marked IN.
  // Plain Scopus export without that column: keep every row.
  const excKey = headers.find(h => h.toLowerCase().replace(/\s+/g, ' ').trim() === 'exclusion reason');
  const included = excKey
    ? rows.filter(r => (r[excKey] || '').trim().toUpperCase() === 'IN')
    : rows;
  if (!included.length) {
    return alert(excKey ? 'No rows with Exclusion Reason = "IN" found.' : 'No rows found in CSV.');
  }

  // Match existing verified papers by title so they survive a re-upload / session-then-CSV flow.
  const existingByTitle = new Map();
  for (const p of S.papers) {
    if (p._verified) existingByTitle.set(normTitle(p.title), p);
  }

  S.csvHeaders  = headers;
  S.csvRows     = included;
  S.csvFilename = filename;
  S.csvMode     = true;
  S.pdfOnlyMode = false;
  S.csvJobs     = {};

  S.papers = included.map((row, i) => {
    const title   = row['Title'] || row['title'] || `Paper ${i + 1}`;

    // 1. Same-session match: reuse already-verified in-memory paper.
    const matched = existingByTitle.get(normTitle(title));
    if (matched) {
      S.csvJobs[i] = { status: 'done' };
      return { ...matched, _csvRowIdx: i };
    }

    // 2. Cross-session match: CSV was previously exported with human_verified column.
    if ((row['human_verified'] || '').toLowerCase() === 'yes') {
      const p = emptyPaper(title);
      p.title      = title;
      p._filename  = '';
      p._csvRowIdx = i;
      p._verified  = true;
      // 'IN' in export means explicitly included (empty reason); '' means not yet decided.
      const er2 = row['exclude_reason_2'] || '';
      p._excludeReason2 = (er2.toUpperCase() === 'IN') ? '' : (er2 || undefined);
      if (row['response_json']) {
        try {
          const parsed = JSON.parse(row['response_json']);
          p._rawJson = row['response_json'];
          Object.assign(p, parsed);
          // Restore private fields that Object.assign may have clobbered.
          p.title      = title;
          p._filename  = '';
          p._csvRowIdx = i;
          p._verified  = true;
        } catch (_) {}
      }
      p._note = row['note'] || row['Note'] || '';
      S.csvJobs[i] = { status: 'done' };
      return p;
    }

    const p = emptyPaper(title);
    p.title      = title;
    p._filename  = '';
    p._csvRowIdx = i;
    p._note = row['note'] || row['Note'] || '';
    return p;
  });

  const alreadyDone = S.papers.filter(p => p._verified).length;
  const remaining   = included.length - alreadyDone;

  document.getElementById('csv-status-badge').classList.remove('hidden');
  document.getElementById('csv-status-badge').textContent =
    alreadyDone > 0
      ? `${included.length} selected — ${alreadyDone} already verified, ${remaining} remaining`
      : excKey
        ? `${included.length} of ${rows.length} papers selected (Exclusion Reason = IN)`
        : `${included.length} papers loaded (no Exclusion Reason column — all rows included)`;
  document.getElementById('csv-start-row').classList.remove('hidden');
  document.getElementById('csv-summary').textContent =
    `${remaining} paper${remaining !== 1 ? 's' : ''} to review · ${filename}`;

  if (alreadyDone > 0) toast(`${alreadyDone} already verified — will skip`, 'emerald');
  else toast(`CSV loaded — ${included.length} papers ready`, 'emerald');

  // Reveal the PDF batch-upload zone now that we have CSV rows to match against.
  document.getElementById('csv-pdf-batch-zone').classList.remove('hidden');
}

// ----------------------------------------------------------------
// DOI matching
// ----------------------------------------------------------------
// PDF-only mode — start a review session from PDFs without a CSV.
// Can be called multiple times to accumulate more PDFs.
// ----------------------------------------------------------------
function guessTitleFromPdfText(text) {
  if (!text) return '';
  const skip = /^(abstract|introduction|keywords?|doi|issn|isbn|vol\.?|volume|issue|pages?|copyright|published|received|accepted|corresponding|email|figure|table)/i;
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length >= 15 && l.length <= 300 && !/^\d+$/.test(l) && !skip.test(l));
  return (lines[0] || '').slice(0, 200);
}

async function handlePdfsOnly(fileList) {
  const files = Array.from(fileList).filter(f => f.type === 'application/pdf');
  if (!files.length) return;

  const startBtn = document.getElementById('btn-start-review');
  if (startBtn) startBtn.disabled = true;

  const statusEl = document.getElementById('pdf-only-status');
  statusEl.textContent = `Scanning ${files.length} PDF${files.length !== 1 ? 's' : ''} for metadata…`;
  statusEl.classList.remove('hidden');

  const extracted = await Promise.all(files.map(async file => {
    const url = URL.createObjectURL(file);
    const { doi, text } = await extractPdfMeta(url);
    return { file, url, doi: doi || '', text };
  }));

  // First call: start fresh. Subsequent calls: accumulate.
  if (!S.pdfOnlyMode) {
    S.csvHeaders  = ['Title', 'DOI', 'Exclusion Reason'];
    S.csvRows     = [];
    S.csvFilename = 'pdf_review';
    S.csvMode     = true;
    S.pdfOnlyMode = true;
    S.csvJobs     = {};
    S.papers      = [];
    S.blobUrls    = {};
  }

  let added = 0;
  for (const { file, url, doi, text } of extracted) {
    if (S.blobUrls[file.name]) { URL.revokeObjectURL(url); continue; } // skip duplicates
    const title = guessTitleFromPdfText(text) || file.name.replace(/\.pdf$/i, '');
    const idx = S.csvRows.length;
    S.csvRows.push({ 'Title': title, 'DOI': doi, 'Exclusion Reason': 'IN' });
    const p = emptyPaper(file.name);
    p.title      = title;
    p._filename  = file.name;
    p._csvRowIdx = idx;
    S.blobUrls[file.name] = url;
    S.papers.push(p);
    added++;
  }

  const total = S.papers.length;
  document.getElementById('csv-start-row').classList.remove('hidden');
  document.getElementById('csv-summary').textContent =
    `${total} PDF${total !== 1 ? 's' : ''} ready to review`;
  document.getElementById('csv-status-badge').classList.remove('hidden');
  document.getElementById('csv-status-badge').textContent =
    `${total} PDF${total !== 1 ? 's' : ''} loaded (PDF-only mode)`;

  if (startBtn) startBtn.disabled = false;
  statusEl.textContent = added
    ? `${added} PDF${added !== 1 ? 's' : ''} added · ${total} total — click Start Review to begin`
    : 'All dropped PDFs were already loaded.';

  if (added) toast(`${added} PDF${added !== 1 ? 's' : ''} added (${total} total)`, 'emerald');
}

// ----------------------------------------------------------------
function normDoi(raw) {
  if (!raw) return null;
  const m = String(raw).toLowerCase().match(/10\.\d{4,9}\/[^\s,;)\]"'<]+/);
  return m ? m[0].replace(/[.,;:)\]"']+$/, '') : null;
}

async function handleBatchPdfs(fileList) {
  const files = Array.from(fileList).filter(f => f.type === 'application/pdf');
  if (!files.length) return;

  const startBtn = document.getElementById('btn-start-review');
  if (startBtn) startBtn.disabled = true;

  const statusEl = document.getElementById('csv-match-status');
  const resultsEl = document.getElementById('csv-match-results');
  statusEl.textContent = `Scanning ${files.length} PDF${files.length > 1 ? 's' : ''} for DOIs…`;
  statusEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');

  // Build DOI → csvIdx lookup from CSV rows
  const doiToIdx = new Map();
  for (let i = 0; i < S.csvRows.length; i++) {
    const d = normDoi(S.csvRows[i]['DOI'] || S.csvRows[i]['doi'] || '');
    if (d) doiToIdx.set(d, i);
  }

  // Extract DOI (and raw text for title fallback) from each PDF in parallel
  const extracted = await Promise.all(files.map(async file => {
    const url = URL.createObjectURL(file);
    const { doi, text } = await extractPdfMeta(url);
    return { file, url, doi: normDoi(doi), text };
  }));

  const matched = [];
  const orphans = []; // PDF not matchable to any CSV row

  // Build title → csvIdx lookup for title-match fallback
  const titleToIdx = new Map();
  for (let i = 0; i < S.csvRows.length; i++) {
    const t = (S.csvRows[i]['Title'] || S.csvRows[i]['title'] || '').trim();
    if (t) titleToIdx.set(t, i);
  }

  for (const { file, url, doi, text } of extracted) {
    // 1. Try DOI match
    const doiIdx = (doi !== null) ? doiToIdx.get(doi) : undefined;
    if (doiIdx !== undefined) {
      const p = S.papers[doiIdx];
      if (p._filename && p._filename !== file.name && S.blobUrls[p._filename]) {
        URL.revokeObjectURL(S.blobUrls[p._filename]);
        delete S.blobUrls[p._filename];
      }
      p._filename    = file.name;
      p._titleMatched = false;
      S.blobUrls[file.name] = url;
      matched.push({ idx: doiIdx, file, doi, titleMatched: false });
      continue;
    }

    // 2. Fallback: title matching (≥90% fingerprint overlap in first 3 pages)
    let bestIdx   = -1;
    let bestScore = 0;
    for (const [csvTitle, csvIdx] of titleToIdx) {
      const score = titleMatchScore(csvTitle, text);
      if (score > bestScore) { bestScore = score; bestIdx = csvIdx; }
    }
    if (bestIdx >= 0 && bestScore >= 0.9) {
      const p = S.papers[bestIdx];
      if (p._filename && p._filename !== file.name && S.blobUrls[p._filename]) {
        URL.revokeObjectURL(S.blobUrls[p._filename]);
        delete S.blobUrls[p._filename];
      }
      p._filename    = file.name;
      p._titleMatched = true;
      S.blobUrls[file.name] = url;
      matched.push({ idx: bestIdx, file, doi: null, titleMatched: true });
    } else {
      URL.revokeObjectURL(url);
      orphans.push({ file, doi });
    }
  }

  const totalMatched = S.papers.filter(p => p._filename && S.blobUrls[p._filename]).length;
  const missingCount = S.papers.filter(p =>
    !p._verified && (!p._filename || !S.blobUrls[p._filename])
  ).length;

  statusEl.classList.add('hidden');
  if (startBtn) startBtn.disabled = false;
  renderMatchResults(resultsEl, matched.length, totalMatched, orphans.length, missingCount);
}

function renderMatchResults(container, newCount, totalMatched, orphanCount, missingCount) {
  container.classList.remove('hidden');
  container.innerHTML = '';

  const matchLabel = newCount < totalMatched
    ? `${totalMatched} PDF${totalMatched !== 1 ? 's' : ''} matched by DOI (${newCount} new)`
    : `${totalMatched} PDF${totalMatched !== 1 ? 's' : ''} matched by DOI`;

  const rows = [
    { icon: '✅', color: 'text-emerald-400', label: matchLabel },
    orphanCount  && { icon: '❓', color: 'text-amber-400',  label: `${orphanCount} uploaded PDF${orphanCount !== 1 ? 's' : ''} not found in CSV (ignored)` },
    missingCount && { icon: '📄', color: 'text-gray-500',   label: `${missingCount} CSV paper${missingCount !== 1 ? 's' : ''} without a PDF — will ask one by one` },
  ].filter(Boolean);

  for (const row of rows) {
    const line = el('div', `flex items-center gap-2 text-xs ${row.color}`);
    line.appendChild(el('span', 'shrink-0', row.icon));
    line.appendChild(el('span', '', row.label));
    container.appendChild(line);
  }

  if (missingCount) {
    const exportBtn = document.createElement('button');
    exportBtn.className = 'text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white rounded-lg transition-colors mt-1';
    exportBtn.textContent = `↓ Export ${missingCount} unmatched papers (for download)`;
    exportBtn.title = 'Download a CSV with title, year, source, authors, DOI of papers still missing a PDF';
    exportBtn.onclick = exportUnmatchedCsv;
    container.appendChild(exportBtn);
  }

  if (newCount) toast(`${totalMatched} PDF${totalMatched !== 1 ? 's' : ''} matched total (${newCount} new)`, 'emerald');
}

// ----------------------------------------------------------------
// Start workflow
// ----------------------------------------------------------------
function startCsvWorkflow() {
  if (!S.csvRows || !S.csvRows.length) return alert('No included papers in CSV.');
  const first = findNextUnverifiedIdx(0);
  if (first === -1) return alert('All papers already verified! Use Export Scopus CSV to download results.');
  S.idx = first;
  S.csvJobs = {};
  document.getElementById('screen-setup').classList.add('hidden');
  document.getElementById('screen-verify').classList.add('active');
  const btnExp = document.getElementById('btn-export-scopus');
  if (btnExp) btnExp.classList.remove('hidden');

  // Auto-start analysis for first 3 unverified papers that already have PDFs
  // (from DOI batch matching). Mimics the manual N, N+1, N+2 upload flow.
  let started = 0;
  for (let i = first; i < S.papers.length && started < 3; i++) {
    const p = S.papers[i];
    if (!p._verified && p._filename && S.blobUrls[p._filename]) {
      startPaperAnalysis(i);
      started++;
    }
  }

  renderPaper();
}

// ----------------------------------------------------------------
// PDF storage helper
// ----------------------------------------------------------------
function storePdfForIdx(idx, file) {
  const p = S.papers[idx];
  if (!p) return;
  if (p._filename && p._filename !== file.name && S.blobUrls[p._filename]) {
    URL.revokeObjectURL(S.blobUrls[p._filename]);
    delete S.blobUrls[p._filename];
  }
  p._filename = file.name;
  if (!S.blobUrls[file.name]) S.blobUrls[file.name] = URL.createObjectURL(file);
}

// ----------------------------------------------------------------
// Current-paper PDF upload — auto-starts analysis
// ----------------------------------------------------------------
function handleCsvPaperPdf(file) {
  if (!file || file.type !== 'application/pdf') return;
  storePdfForIdx(S.idx, file);
  loadPdfViewer(S.blobUrls[file.name], null);
  document.getElementById('pdf-filename').textContent = file.name;
  startPaperAnalysis(S.idx); // fire-and-forget
  refreshCsvPrefetchUI();
  renderCsvPaperHeader(S.csvRows[S.idx]);
}

// ----------------------------------------------------------------
// Prefetch PDF upload — auto-starts analysis for S.idx + offset (1 or 2)
// ----------------------------------------------------------------
function handlePrefetchPdf(file, offset) {
  if (!file || file.type !== 'application/pdf') return;
  const targetIdx = S.idx + offset;
  if (targetIdx >= S.papers.length) return;
  storePdfForIdx(targetIdx, file);
  startPaperAnalysis(targetIdx); // fire-and-forget
  refreshCsvPrefetchUI();
}

// ----------------------------------------------------------------
// Prefetch strips — two compact bars in dock for N+1 and N+2.
// Both appear once the current paper's PDF is uploaded.
// ----------------------------------------------------------------
function refreshCsvPrefetchUI() {
  if (!S.csvMode) return;
  refreshOneStripUI(1);
  refreshOneStripUI(2);
}

function refreshOneStripUI(offset) {
  const strip     = document.getElementById(`csv-prefetch-strip-${offset}`);
  const uploadBtn = document.getElementById(`prefetch-upload-btn-${offset}`);
  const statusEl  = document.getElementById(`prefetch-status-${offset}`);
  if (!strip) return;

  const targetIdx = S.idx + offset;

  // Show strip only when current paper is started AND target paper exists
  if (!S.csvJobs[S.idx] || targetIdx >= S.papers.length) {
    strip.classList.add('hidden');
    return;
  }

  strip.classList.remove('hidden');

  const row   = S.csvRows[targetIdx];
  const job   = S.csvJobs[targetIdx];
  const title = row?.['Title'] || row?.['title'] || `Paper ${targetIdx + 1}`;

  document.getElementById(`prefetch-badge-${offset}`).textContent = `${targetIdx + 1}/${S.csvRows.length}`;
  document.getElementById(`prefetch-title-${offset}`).textContent = title;

  const isVerified = S.papers[targetIdx]?._verified;

  if (!job) {
    const targetPaper = S.papers[targetIdx];
    const targetHasPdf = !!(targetPaper?._filename && S.blobUrls[targetPaper._filename]);
    if (targetHasPdf) {
      // PDF already matched from batch — analysis will auto-start
      uploadBtn.classList.add('hidden');
      statusEl.textContent = '⏳ Starting…';
      statusEl.className = 'text-xs whitespace-nowrap text-indigo-400 animate-pulse';
    } else {
      uploadBtn.classList.remove('hidden');
      uploadBtn.disabled = false;
      statusEl.textContent = '';
      statusEl.className = 'text-xs whitespace-nowrap';
    }
  } else if (job.status === 'pending') {
    uploadBtn.classList.add('hidden');
    statusEl.textContent = '⏳ Analyzing…';
    statusEl.className = 'text-xs whitespace-nowrap text-indigo-400';
  } else if (job.status === 'done' && isVerified) {
    uploadBtn.classList.add('hidden');
    statusEl.textContent = '✓ Already verified — will skip';
    statusEl.className = 'text-xs whitespace-nowrap text-gray-500';
  } else if (job.status === 'done') {
    uploadBtn.classList.add('hidden');
    statusEl.textContent = '✅ Ready';
    statusEl.className = 'text-xs whitespace-nowrap text-emerald-400';
  } else if (job.status === 'error') {
    uploadBtn.classList.remove('hidden');
    uploadBtn.disabled = false;
    statusEl.textContent = `❌ ${job.message?.slice(0, 40) || 'Error'}`;
    statusEl.className = 'text-xs whitespace-nowrap text-red-400';
  }
}

// ----------------------------------------------------------------
// CSV paper header — injected at top of form-pane by renderPaper().
// Adapts to job status: no-pdf / pending / done / error.
// ----------------------------------------------------------------
function renderCsvPaperHeader(row) {
  const prev = document.getElementById('csv-paper-header');
  if (prev) prev.remove();

  const p   = cur();
  const job = S.csvJobs[S.idx];
  const hasPdf = !!(p._filename && S.blobUrls[p._filename]);

  const card = document.createElement('div');
  card.id = 'csv-paper-header';
  card.className = 'bg-gray-900/80 border border-indigo-900/40 rounded-xl p-4 space-y-3 mb-1';

  // — Queue badge + title ——————————————————————————————————
  const topRow = document.createElement('div');
  topRow.className = 'flex items-start gap-2';

  const badge = el('span',
    'shrink-0 text-xs bg-indigo-600/20 text-indigo-400 border border-indigo-600/30 rounded-full px-2.5 py-0.5 font-mono whitespace-nowrap mt-0.5',
    `${S.idx + 1} / ${S.csvRows.length}`);
  topRow.appendChild(badge);

  const titleEl = el('div', 'text-sm font-semibold text-gray-200 leading-snug flex-1',
    row?.['Title'] || row?.['title'] || '(no title)');
  topRow.appendChild(titleEl);

  // Status icon (right of title)
  if (job?.status === 'done') {
    topRow.appendChild(el('span', 'text-emerald-400 text-sm shrink-0', '✓'));
  } else if (job?.status === 'error') {
    topRow.appendChild(el('span', 'text-red-400 text-sm shrink-0', '⚠'));
  }
  card.appendChild(topRow);

  // — Metadata chips ———————————————————————————————————————
  if (row) {
    const metaParts = [];
    const rawAuthors = row['Authors'] || row['Author full names'] || row['authors'] || '';
    if (rawAuthors) {
      const first = rawAuthors.split(/[;,]/)[0].trim();
      metaParts.push('👤 ' + first + (rawAuthors.includes(';') || rawAuthors.includes(',') ? ' et al.' : ''));
    }
    const year   = row['Year'] || row['Publication Year'] || row['year'] || '';
    const source = row['Source title'] || row['Source Title'] || row['Journal'] || row['journal'] || '';
    const doi    = row['DOI'] || row['doi'] || '';
    if (year)   metaParts.push('📅 ' + year);
    if (source) metaParts.push('📰 ' + source);
    if (doi)    metaParts.push('🔗 ' + doi);

    if (metaParts.length) {
      const metaEl = document.createElement('div');
      metaEl.className = 'flex flex-wrap gap-x-4 gap-y-0.5';
      metaParts.forEach(p => metaEl.appendChild(el('span', 'text-xs text-gray-500', p)));
      card.appendChild(metaEl);
    }
  }

  // — Status row (PDF + analysis state) ————————————————————
  const statusRow = document.createElement('div');
  statusRow.className = 'flex items-center gap-2 flex-wrap';

  // Hidden file input (always present for re-upload)
  const pdfInput = document.createElement('input');
  pdfInput.type = 'file'; pdfInput.accept = '.pdf'; pdfInput.className = 'hidden';
  pdfInput.id = 'csv-pdf-input';
  pdfInput.onchange = e => handleCsvPaperPdf(e.target.files[0]);
  statusRow.appendChild(pdfInput);

  if (!hasPdf) {
    // No PDF yet
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-medium transition-colors';
    uploadBtn.textContent = '↑ Upload PDF';
    uploadBtn.title = 'Analysis starts automatically on upload';
    uploadBtn.onclick = () => pdfInput.click();
    statusRow.appendChild(uploadBtn);
    statusRow.appendChild(el('span', 'text-xs text-gray-600', '— analysis starts automatically'));
  } else if (hasPdf && !job) {
    // PDF is matched (from batch import) but analysis hasn't started yet
    statusRow.appendChild(el('span', 'text-xs text-emerald-500 truncate max-w-[180px]', p._filename));
    if (getModelVal() !== 'none') {
      const analyzeBtn = document.createElement('button');
      analyzeBtn.className = 'text-xs px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-medium transition-colors';
      analyzeBtn.textContent = '▶ Analyze';
      analyzeBtn.title = 'Send to Gemini for analysis';
      analyzeBtn.onclick = () => { startPaperAnalysis(S.idx); renderCsvPaperHeader(S.csvRows[S.idx]); };
      statusRow.appendChild(analyzeBtn);
    }
    const reUpBtn = document.createElement('button');
    reUpBtn.className = 'text-xs px-2.5 py-1 bg-gray-700 hover:bg-gray-600 border border-gray-700 rounded-lg text-gray-400 transition-colors';
    reUpBtn.textContent = '↑ Re-upload';
    reUpBtn.title = 'Replace with a different PDF';
    reUpBtn.onclick = () => pdfInput.click();
    statusRow.appendChild(reUpBtn);
  } else if (job?.status === 'pending') {
    statusRow.appendChild(el('span', 'text-xs text-emerald-500 truncate max-w-[180px]', p._filename));
    statusRow.appendChild(el('span', 'text-xs text-indigo-400 animate-pulse', '⏳ Analyzing…'));
  } else if (job?.status === 'done') {
    statusRow.appendChild(el('span', 'text-xs text-emerald-500 truncate max-w-[180px]', p._filename));
    const reBtn = document.createElement('button');
    reBtn.className = 'text-xs px-2.5 py-1 bg-gray-700 hover:bg-gray-600 border border-gray-700 rounded-lg text-gray-400 transition-colors';
    reBtn.textContent = '↑ Re-upload';
    reBtn.title = 'Upload a different PDF and re-analyze';
    reBtn.onclick = () => {
      delete S.csvJobs[S.idx];
      pdfInput.click();
    };
    statusRow.appendChild(reBtn);
    const reAnalyzeBtn = document.createElement('button');
    reAnalyzeBtn.className = 'text-xs px-2.5 py-1 bg-gray-700 hover:bg-gray-600 border border-gray-700 rounded-lg text-gray-400 transition-colors';
    reAnalyzeBtn.textContent = '↺ Re-analyze';
    reAnalyzeBtn.title = 'Keep the PDF, re-run Gemini analysis';
    reAnalyzeBtn.onclick = () => {
      delete S.csvJobs[S.idx];
      startPaperAnalysis(S.idx);
      renderCsvPaperHeader(S.csvRows[S.idx]);
    };
    statusRow.appendChild(reAnalyzeBtn);
    if (p._titleMatched) {
      statusRow.appendChild(el('span',
        'text-xs bg-amber-600/20 text-amber-400 border border-amber-600/30 rounded-full px-2 py-0.5 shrink-0',
        '≈ Title matched'));
    }
  } else if (job?.status === 'error') {
    statusRow.appendChild(el('span', 'text-xs text-red-400', `Error: ${job.message?.slice(0, 60) || 'unknown'}`));
    const retryBtn = document.createElement('button');
    retryBtn.className = 'text-xs px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded-lg text-white transition-colors';
    retryBtn.textContent = '↺ Retry';
    retryBtn.onclick = () => { delete S.csvJobs[S.idx]; startPaperAnalysis(S.idx); renderCsvPaperHeader(row); };
    statusRow.appendChild(retryBtn);
  }
  card.appendChild(statusRow);

  // — Progress bar ————————————————————————————————————————
  const pbWrap = document.createElement('div');
  pbWrap.className = 'w-full bg-gray-800 rounded-full h-0.5 mt-1';
  const pb = document.createElement('div');
  pb.className = 'bg-indigo-500 h-0.5 rounded-full transition-all';
  pb.style.width = `${(S.idx / S.csvRows.length) * 100}%`;
  pbWrap.appendChild(pb);
  card.appendChild(pbWrap);

  // — Include / Exclude pill selector ————————————————————
  const decisionRow = document.createElement('div');
  decisionRow.className = 'flex items-center gap-2 flex-wrap';
  decisionRow.appendChild(el('span', 'text-xs text-gray-600 shrink-0', 'Decision:'));

  const isInclude = p._excludeReason2 === '';
  const isExclude = p._excludeReason2 !== undefined && p._excludeReason2 !== null && p._excludeReason2 !== '';

  function pillClass(active, activeColor) {
    return `text-xs px-3 py-1 rounded-full font-medium transition-colors border ${
      active ? activeColor : 'bg-transparent text-gray-500 border-gray-700 hover:border-gray-500 hover:text-gray-400'
    }`;
  }

  const inclPill = document.createElement('button');
  inclPill.textContent = 'Include';
  inclPill.className = pillClass(isInclude, 'bg-emerald-600/25 text-emerald-400 border-emerald-600/50');
  inclPill.onclick = () => { p._excludeReason2 = ''; renderCsvPaperHeader(S.csvRows[S.idx]); };

  const exclPill = document.createElement('button');
  exclPill.textContent = 'Exclude';
  exclPill.className = pillClass(isExclude, 'bg-red-600/25 text-red-400 border-red-600/50');
  exclPill.onclick = () => {
    if (!isExclude) p._excludeReason2 = 'excluded';
    renderCsvPaperHeader(S.csvRows[S.idx]);
    setTimeout(() => document.getElementById('excl-reason-input')?.focus(), 30);
  };

  decisionRow.append(inclPill, exclPill);

  if (isExclude) {
    const reasonInput = document.createElement('input');
    reasonInput.id = 'excl-reason-input';
    reasonInput.type = 'text';
    reasonInput.className = 'flex-1 min-w-[140px] bg-gray-800 border border-red-900/50 rounded-lg px-2 py-1 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-red-500/50';
    reasonInput.placeholder = 'Exclusion reason…';
    reasonInput.value = p._excludeReason2;
    reasonInput.oninput = e => { p._excludeReason2 = e.target.value; };
    decisionRow.appendChild(reasonInput);
  }

  card.appendChild(decisionRow);

  // — Note ——————————————————————————————————————————
  const noteTextarea = document.createElement('textarea');
  noteTextarea.id = 'paper-note-input';
  noteTextarea.className = 'w-full bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 resize-none';
  noteTextarea.placeholder = 'Add a note…';
  noteTextarea.rows = 2;
  noteTextarea.value = p._note || '';
  noteTextarea.oninput = e => { cur()._note = e.target.value; };
  card.appendChild(noteTextarea);

  const formPane = document.getElementById('form-pane');
  formPane.insertBefore(card, formPane.firstChild);
}
