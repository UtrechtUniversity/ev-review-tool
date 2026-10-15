// ================================================================
// API KEY / MODEL — setup screen
// ================================================================
function saveApiKey() {
  const k = document.getElementById('api-key-input').value.trim();
  if (!k) return;
  S.apiKey = k;
  sessionStorage.setItem('ev_review_api_key', k);
  toast('API key saved for this tab', 'emerald');
}

function saveModel() {
  const m = document.getElementById('model-select').value;
  localStorage.setItem('ev_review_model', m);
  const btnRun = document.getElementById('btn-run');
  if (btnRun) btnRun.disabled = (m === 'none');
  toast(m === 'none' ? 'Manual import mode — use Import JSON' : `Model set: ${m}`, 'emerald');
  updateTokenEstimate();
}

// ================================================================
// TOKEN COST ESTIMATOR
// ================================================================
// Approximate pricing per 1M tokens (USD) — check ai.google.dev/pricing for current rates
const MODEL_PRICING = {
  'gemini-3.1-flash-lite':          { input: 0.10,  output: 0.40 },
  'gemini-3.1-flash-lite:thinking': { input: 0.10,  output: 0.40 },
  'gemini-2.5-flash-lite':          { input: 0.10,  output: 0.40 },
  'gemini-2.5-flash-lite:thinking': { input: 0.10,  output: 0.40 },
  'gemini-2.5-flash':               { input: 0.15,  output: 0.60 },
};
const AVG_WORDS_PER_PAPER = 11000;

async function updateTokenEstimate() {
  const div = document.getElementById('token-estimate');
  if (!div) return;
  const n = S.files.length;
  if (n === 0) { div.classList.add('hidden'); return; }

  div.classList.remove('hidden');
  div.textContent = 'Calculating estimate…';

  let promptTokens = _promptTokenCache;
  if (promptTokens === null) {
    try {
      const text = await buildPrompt(1);
      promptTokens = Math.ceil(text.length / 4);
      _promptTokenCache = promptTokens;
    } catch (_) {
      promptTokens = 2000;
    }
  }

  const batchCount   = Math.ceil(n / BATCH_SIZE);
  const paperTokens  = Math.ceil(AVG_WORDS_PER_PAPER * 4 / 3);
  const outputTokens = n * 700;
  const fullBatches  = Math.floor(n / BATCH_SIZE);
  const remainder    = n % BATCH_SIZE;
  const inputTokens  = fullBatches * (promptTokens + BATCH_SIZE * paperTokens)
                     + (remainder ? promptTokens + remainder * paperTokens : 0);

  const model  = getModelVal();
  const prices = MODEL_PRICING[model] || MODEL_PRICING['gemini-2.5-flash-lite'];
  const costUSD = (inputTokens / 1e6) * prices.input + (outputTokens / 1e6) * prices.output;
  const fmtCost = costUSD < 0.005 ? `$${costUSD.toFixed(4)}` : `$${costUSD.toFixed(2)}`;
  const fmtTok  = t => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

  div.innerHTML =
    `<span class="text-gray-600">${batchCount} batch${batchCount !== 1 ? 'es' : ''} · </span>` +
    `<span>in <b class="text-gray-400">${fmtTok(inputTokens)}</b> · out <b class="text-gray-400">${fmtTok(outputTokens)}</b> tokens · </span>` +
    `<span>≈ <b class="text-gray-400">${fmtCost}</b></span>` +
    `<span class="text-gray-600"> (${AVG_WORDS_PER_PAPER.toLocaleString()} words/paper avg, prompt ${fmtTok(promptTokens)} tok)</span>`;
}

// ================================================================
// GEMINI API
// ================================================================
const BATCH_SIZE = 3;

function getModelVal() {
  return localStorage.getItem('ev_review_model') || 'gemini-3.1-flash-lite:thinking';
}

function geminiUrl() {
  const [model] = getModelVal().split(':');
  return `${GEMINI_BASE}/${model}:generateContent`;
}

function geminiThinkingConfig() {
  const val = getModelVal();
  if (!val.includes(':thinking')) return null;
  const [model] = val.split(':');
  // Gemini 3.x uses thinkingLevel; 2.x uses thinkingBudget
  return model.startsWith('gemini-3.') ? { thinkingLevel: 'high' } : { thinkingBudget: -1 };
}

async function runExtraction() {
  if (getModelVal() === 'none') return alert('No model selected. Upload your response JSON using the Import JSON button.');
  if (!S.apiKey)        return alert('Please save an API key first.');
  if (!S.files.length)  return alert('Please select at least one PDF file.');

  S.papers = [];
  document.getElementById('progress-panel').classList.remove('hidden');
  document.getElementById('btn-run').disabled = true;

  const total      = S.files.length;
  const batchCount = Math.ceil(total / BATCH_SIZE);

  for (let b = 0; b < batchCount; b++) {
    const chunk     = S.files.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const processed = b * BATCH_SIZE;

    setProgress(processed, total,
      `Batch ${b + 1}/${batchCount}: papers ${processed + 1}–${Math.min(processed + chunk.length, total)} of ${total}`);

    for (const f of chunk) {
      if (!S.blobUrls[f.name]) S.blobUrls[f.name] = URL.createObjectURL(f);
    }

    log(`📄 Extracting text from ${chunk.length} PDF(s) in parallel…`);
    try {
      const texts = await Promise.all(chunk.map(f => extractPdfText(S.blobUrls[f.name])));

      const totalWords = texts.reduce((s, t) => s + t.split(/\s+/).length, 0);
      const model = getModelVal();
      log(`⬆️  Sending batch of ${chunk.length} to ${model} (~${totalWords.toLocaleString()} words total)…`);

      const results = await callGeminiBatch(chunk, texts);

      const covered = new Set();
      for (const result of results) {
        const idx  = Math.max(0, Math.min((result.file_index ?? 1) - 1, chunk.length - 1));
        const file = chunk[idx];
        S.papers.push({ ...result, _filename: file.name, _verified: false });
        covered.add(idx);
        log(`✅ [${idx + 1}/${chunk.length}] "${truncLog(result.title || file.name)}" — ${result.methodologies?.length ?? 0} method(s)`);
      }

      for (let j = 0; j < chunk.length; j++) {
        if (!covered.has(j)) {
          log(`⚠️  No result returned for paper ${j + 1} in batch — adding empty placeholder`, 'warn');
          S.papers.push(emptyPaper(chunk[j].name));
        }
      }

    } catch (err) {
      console.error(`[EV Reviewer] Batch ${b + 1} failed:`, err);
      log(`❌ Batch ${b + 1} failed: ${err.message}`, 'error');
      for (const f of chunk) S.papers.push(emptyPaper(f.name));
      log(`↳ Added ${chunk.length} empty placeholder(s) — verify manually`, 'warn');
    }

    if (b < batchCount - 1) {
      log(`⏳ Rate-limit pause (4 s)…`);
      await sleep(4000);
    }
  }

  setProgress(total, total, `Complete — ${total} paper${total !== 1 ? 's' : ''} processed`);
  log(`🎉 All done! Switching to verification workspace…`, 'success');
  document.getElementById('btn-run').disabled = false;
  await sleep(1000);
  openVerify();
}

// Fire-and-forget: start Gemini analysis for paper at idx.
// Safe to call multiple times — skips if already started.
// When done, auto-populates S.papers[idx] and refreshes the UI if it's currently displayed.
function startPaperAnalysis(idx) {
  if (!S.csvMode) return;
  if (S.csvJobs[idx]) return; // already started (idempotent)
  const p = S.papers[idx];
  if (!p || !p._filename || !S.blobUrls[p._filename]) return;
  if (getModelVal() === 'none') return; // manual-import mode, nothing to start

  S.csvJobs[idx] = { status: 'pending' };
  console.log(`[EV] ▶ Paper ${idx + 1}/${S.csvRows.length}: starting analysis — ${p._filename}`);
  log(`📄 [${idx + 1}/${S.csvRows.length}] Queued: ${p._filename}`);
  refreshCsvPrefetchUI();
  if (idx === S.idx) renderCsvPaperHeader(S.csvRows[idx]);

  (async () => {
    try {
      console.log(`[EV] ▶ Paper ${idx + 1}: extracting PDF text…`);
      const text = await extractPdfText(S.blobUrls[p._filename]);
      console.log(`[EV] ▶ Paper ${idx + 1}: sending to ${getModelVal()}…`);
      log(`⬆️  [${idx + 1}] Sending to ${getModelVal()}…`);
      const results = await callGeminiBatch([{ name: p._filename }], [text]);
      const result = results[0] ?? null;
      if (result) {
        const savedFilename  = p._filename;
        const savedCsvRowIdx = p._csvRowIdx;
        p._rawJson = JSON.stringify(result);
        Object.assign(p, result);
        p._filename  = savedFilename;
        p._csvRowIdx = savedCsvRowIdx;
        p._verified  = false;
      }
      S.csvJobs[idx].status = 'done';
      console.log(`[EV] ✅ Paper ${idx + 1}: done`, result);
      log(`✅ [${idx + 1}] "${(S.csvRows[idx]?.['Title'] || '').slice(0, 50)}" — done`, 'success');
      if (idx === S.idx) {
        buildFormFromConfig(p);
        renderCsvPaperHeader(S.csvRows[idx]);
        renderAskSection();
        toast('Analysis complete — review the fields below', 'emerald');
      }
    } catch (err) {
      S.csvJobs[idx] = { status: 'error', message: err.message };
      console.error(`[EV] ❌ Paper ${idx + 1}: analysis failed`, err);
      log(`❌ [${idx + 1}] ${err.message}`, 'error');
      if (idx === S.idx) {
        renderCsvPaperHeader(S.csvRows[idx]);
        toast(`Analysis failed: ${err.message}`, 'red');
      }
    }
    refreshCsvPrefetchUI();
  })();
}

async function callGeminiBatch(filesChunk, textsChunk) {
  const n      = filesChunk.length;
  const PROMPT = await buildPrompt(n);
  const SCHEMA = { type: 'ARRAY', items: buildGeminiSchemaFromConfig(S.fieldsConfig) };

  const resp = await fetch(`${geminiUrl()}?key=${encodeURIComponent(S.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: PROMPT
            + '\n\n' + '='.repeat(72)
            + '\nFIELD DEFINITIONS END — PAPER TEXTS FOLLOW\n'
            + '='.repeat(72)
            + filesChunk.map((f, i) =>
                `\n\n${'─'.repeat(72)}\nDOCUMENT ${i + 1} (file_index=${i + 1}): ${f.name}\n${'─'.repeat(72)}\n\n${textsChunk[i]}`
              ).join('')
        }]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 65536,
        ...(geminiThinkingConfig() ? { thinkingConfig: geminiThinkingConfig() } : {})
      }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.error(`[EV Reviewer] Gemini HTTP ${resp.status}:`, txt);
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const data = await resp.json();

  const usage = data.usageMetadata;
  if (usage) {
    const total  = usage.totalTokenCount      ?? '?';
    const prompt = usage.promptTokenCount     ?? '?';
    const out    = usage.candidatesTokenCount ?? '?';
    log(`📊 Tokens — prompt: ${prompt.toLocaleString()}, output: ${out.toLocaleString()}, total: ${total.toLocaleString()}`);
  }

  console.log('[EV] Gemini full response:', data);

  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.warn('[EV] Gemini finishReason:', finishReason, candidate);
  }

  const raw = candidate?.content?.parts?.[0]?.text;
  console.log('[EV] Gemini raw text:', raw);

  if (!raw) throw new Error(`Empty response — finishReason: ${finishReason ?? 'unknown'}`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[EV] JSON.parse failed. Raw text was:', raw);
    throw new Error(`JSON parse failed (${e.message}) — raw length ${raw.length}, finishReason: ${finishReason}`);
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [{ ...parsed, file_index: 1 }];
  throw new Error('Unexpected response shape — not an array');
}

// ================================================================
// PROGRESS PANEL
// ================================================================
function setProgress(done, total, label) {
  document.getElementById('progress-label').textContent   = label;
  document.getElementById('progress-counter').textContent = `${done} / ${total}`;
  const pct = total > 0 ? (done / total) * 100 : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
}

const LOG_COLORS = {
  info:    'text-gray-400',
  warn:    'text-amber-400',
  error:   'text-red-400',
  success: 'text-emerald-400'
};

function log(text, level = 'info') {
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn('[EV]', text);
  const panel = document.getElementById('log-panel');
  if (!panel) return;
  const line  = document.createElement('div');
  line.className = LOG_COLORS[level] || 'text-gray-400';
  line.textContent = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${text}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}
