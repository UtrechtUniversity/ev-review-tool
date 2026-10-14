// ================================================================
// PROMPT BUILDER
// ================================================================
let _promptTemplate = null;

async function loadPromptTemplate() {
  if (_promptTemplate) return _promptTemplate;
  const r = await fetch('./prompt.txt');
  if (!r.ok) throw new Error(`Could not load prompt.txt: ${r.status}`);
  _promptTemplate = await r.text();
  return _promptTemplate;
}

function buildFieldDefinitions(fields) {
  return fields
    .map(fd => (fd.promptText || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function buildPrompt(n) {
  const template  = await loadPromptTemplate();
  const fieldDefs = buildFieldDefinitions(S.fieldsConfig);
  return template
    .replaceAll('{N}', n)
    .replace('{FIELD_DEFINITIONS}', fieldDefs);
}

async function exportPromptText() {
  try {
    const text = await buildPrompt(1);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'prompt_export.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('Prompt downloaded — attach your PDF manually in Gemini', 'emerald');
  } catch (e) {
    toast('Could not build prompt: ' + e.message, 'red');
  }
}
