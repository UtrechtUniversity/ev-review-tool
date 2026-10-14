// ================================================================
// SCREEN NAVIGATION & PAPER RENDERING
// ================================================================
function openVerify() {
  if (!S.papers.length) return alert('No papers to verify.');
  S.idx = 0;
  document.getElementById('screen-setup').classList.add('hidden');
  document.getElementById('screen-verify').classList.add('active');
  renderPaper();
}

function showSetup() {
  document.getElementById('screen-setup').classList.remove('hidden');
  document.getElementById('screen-verify').classList.remove('active');
}

function skipToVerification() {
  if (!S.files.length) return alert('Please select at least one PDF file first.');
  for (const f of S.files) {
    if (!S.blobUrls[f.name]) S.blobUrls[f.name] = URL.createObjectURL(f);
    if (!S.papers.find(p => p._filename === f.name)) S.papers.push(emptyPaper(f.name));
  }
  openVerify();
}

function renderPaper() {
  const p = cur();
  if (!p) return;

  const blobUrl = S.blobUrls[p._filename];

  const evidenceSources = [];
  for (const fd of (S.fieldsConfig || [])) {
    if (fd.type === 'evidence_only') evidenceSources.push(p[fd.key]);
    if (fd.evidence) evidenceSources.push(p[fd.evidenceKey || (fd.key + '_evidence')]);
  }
  for (const m of (p.methodologies || []))
    evidenceSources.push(m.method_evidence, m.methodology_evidence);

  const first = firstEvidence(...evidenceSources);
  loadPdfViewer(blobUrl || null, first);
  document.getElementById('pdf-filename').textContent =
    p._filename || (S.csvMode ? (S.csvRows[S.idx]?.['Title'] || '').slice(0, 60) : '');

  refreshCounter();

  document.getElementById('btn-prev').disabled = S.idx === 0;

  const btnNext   = document.getElementById('btn-next');
  const btnVerify = document.getElementById('btn-verify');
  const btnSkip   = document.getElementById('btn-skip');

  if (S.csvMode) {
    btnNext.textContent = 'Next →';
    if (btnVerify) btnVerify.classList.remove('hidden');
    if (btnSkip)   btnSkip.classList.add('hidden');
  } else {
    btnNext.textContent = S.idx === S.papers.length - 1 ? 'Save ✓' : 'Save & Next →';
    if (btnVerify) btnVerify.classList.add('hidden');
    if (btnSkip)   btnSkip.classList.add('hidden');
  }

  buildFormFromConfig(p);
  if (S.csvMode) {
    renderCsvPaperHeader(S.csvRows[S.idx]);
    refreshCsvPrefetchUI();
    // Auto-start analysis for current + next 2 papers that have a matched PDF but no job yet
    // (skip already human-verified papers — must not overwrite/unverify them in the background)
    for (let i = S.idx; i <= S.idx + 2 && i < S.papers.length; i++) {
      if (!S.papers[i]._verified) startPaperAnalysis(i); // idempotent — no-op if already running or no PDF
    }
  }
  renderAskSection();
}

// Navigate without marking verified (CSV mode: jumps to next unverified; non-CSV: auto-verifies).
function navigate(dir) {
  if (dir > 0 && !S.csvMode) cur()._verified = true;

  let next;
  if (dir > 0 && S.csvMode) {
    next = findNextUnverifiedIdx(S.idx + 1);
    if (next === -1) next = S.idx + 1; // all verified — just advance sequentially
    if (next >= S.papers.length) { toast('End of list', 'gray'); return; }
  } else {
    next = S.idx + dir;
    if (next < 0 || next >= S.papers.length) return;
  }

  S.idx = next;
  renderPaper();
  document.getElementById('form-pane').scrollTop = 0;
}

// Mark current paper as human-verified and advance to next unverified.
function verifyAndNext() {
  cur()._verified = true;
  if (S.csvMode) renderCsvPaperHeader(S.csvRows[S.idx]); // refresh header to update verify state
  const next = findNextUnverifiedIdx(S.idx + 1);
  if (next === -1) {
    toast('All papers reviewed! Export Scopus CSV to download results.', 'emerald');
    return;
  }
  S.idx = next;
  renderPaper();
  document.getElementById('form-pane').scrollTop = 0;
}

// Advance without marking current paper as verified.
function skipCurrentPaper() {
  const next = findNextUnverifiedIdx(S.idx + 1);
  if (next === -1) {
    toast('No more unreviewed papers.', 'gray');
    return;
  }
  S.idx = next;
  renderPaper();
  document.getElementById('form-pane').scrollTop = 0;
}
