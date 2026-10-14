// ================================================================
// SESSION SAVE / LOAD + PAPER JSON IMPORT
// ================================================================
function saveSession() {
  const data = JSON.stringify({ papers: S.papers }, null, 2);
  const blob = new Blob([data], { type: 'application/json;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ev_review_session_${isoDate()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast('Session saved as JSON', 'emerald');
}

function loadSession() {
  const inp = document.createElement('input');
  inp.type   = 'file';
  inp.accept = '.json';
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.papers)) throw new Error('Invalid session file');
      S.papers = data.papers;
      toast(`Loaded ${S.papers.length} papers from session`, 'emerald');
      if (S.files.length || Object.keys(S.blobUrls).length) {
        openVerify();
      } else {
        toast('Now select the matching PDF files to view them alongside the data', 'amber');
      }
    } catch (e) {
      alert(`Failed to load session: ${e.message}`);
    }
  });
  inp.click();
}

function importPaperJson() {
  if (!S.papers.length) return;
  const inp = document.createElement('input');
  inp.type   = 'file';
  inp.accept = '.json,application/json';
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      let data = JSON.parse(text);
      if (Array.isArray(data)) {
        if (!data.length) throw new Error('Empty array — expected at least one paper object');
        data = data[0];
      }
      if (typeof data !== 'object' || data === null) throw new Error('Expected a JSON object');
      const p = cur();
      // Build a set of all known keys (field keys + evidence keys) from the current config.
      const knownKeys = new Set(S.fieldsConfig.flatMap(f => [f.key, f.evidenceKey].filter(Boolean)));
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('_') || k === 'file_index') continue;
        let key = k.toLowerCase();
        // If the lowercased key isn't a known key, try to find a known field key that is
        // the longest prefix of this key (e.g. "grid_limit_boundary" → "grid_limit").
        // This handles manual Gemini responses where the key has an extra suffix.
        if (!knownKeys.has(key)) {
          let bestKey = null, bestLen = 0;
          for (const fk of knownKeys) {
            if (key.startsWith(fk) && fk.length > bestLen) { bestKey = fk; bestLen = fk.length; }
          }
          if (bestKey) key = bestKey;
        }
        p[key] = v;
      }
      renderPaper();
      toast('JSON imported — verify the extracted fields', 'emerald');
    } catch (e) {
      toast('Import failed: ' + e.message, 'red');
    }
  });
  inp.click();
}
