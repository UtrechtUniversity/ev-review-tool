// ================================================================
// BOOT
// ================================================================
(async () => {
  // The key is kept only for this tab (sessionStorage); remove keys saved by older versions
  localStorage.removeItem('ev_review_api_key');
  const savedKey = sessionStorage.getItem('ev_review_api_key') || '';
  document.getElementById('api-key-input').value = savedKey;
  S.apiKey = savedKey;

  const savedModel = localStorage.getItem('ev_review_model') || 'gemini-3.1-flash-lite:thinking';
  if (!localStorage.getItem('ev_review_model')) localStorage.setItem('ev_review_model', savedModel);
  const sel = document.getElementById('model-select');
  if (sel) sel.value = savedModel;
  const btnRun = document.getElementById('btn-run');
  if (btnRun) btnRun.disabled = (savedModel === 'none');

  await loadFieldsConfig();
  renderFieldsList();
})();
