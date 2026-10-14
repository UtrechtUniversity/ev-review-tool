// ================================================================
// FIELDS CONFIG — panel UI, persistence, schema generation
// ================================================================

const TYPE_BADGE = {
  enum:'bg-violet-500/20 text-violet-300', string:'bg-blue-500/20 text-blue-300',
  boolean:'bg-sky-500/20 text-sky-300', integer:'bg-green-500/20 text-green-300',
  number:'bg-green-500/20 text-green-300', evidence_only:'bg-amber-500/20 text-amber-300',
  boolean_group:'bg-sky-500/20 text-sky-300', methodologies:'bg-indigo-500/20 text-indigo-300'
};

let _fieldsPanelOpen = true;
let _editingFieldIdx = -1; // -1 = adding new

const BUILT_IN_FIELDS = [
  { key:'ev_charging_decision_variable', label:'EV Charging as Decision Variable', type:'enum',
    options:['yes','aggregated','no','unknown'], default:'unknown', evidence:true,
    hint:'yes = per-EV per-timestep control; aggregated = fleet-level pool; no = unmanaged/fixed' },
  { key:'online_status', label:'Online / Replanning Control', type:'enum',
    options:['offline','stochastic','online','unknown'], default:'offline', evidence:true,
    hint:'offline = all inputs known at t=0; stochastic = uncertainty modeled once; online = re-solved on real events' },
  { key:'grid_checkpoints', type:'boolean_group', label:'Grid Checkpoints',
    hint:'AI reasoning steps used to determine the grid level',
    fields:[
      {key:'check_l1_aggregate_limit',      label:'L1 — Aggregate station/transformer cap inside optimization'},
      {key:'check_l4_node_voltages',        label:'L4 — Node voltage bounds enforced inside optimization'},
      {key:'check_l5_exact_iterative_flow', label:'L5 — Exact iterative power flow solver (Newton-Raphson, etc.) in loop'}
    ]},
  { key:'grid_limit', label:'Grid Constraint Model', type:'enum',
    options:['0 - no limits','1 - single limit','4 - linearized AC power flow or convex relaxation','5 - AC-OPF balanced single-phase (exact non-linear)'],
    default:'0 - no limits', evidence:true, evidenceKey:'grid_limit_boundary_evidence',
    evidenceLabel:'Boundary constraint evidence (mathematical inequality)',
    hint:'Determined by checkpoints above — grid-side constraints only' },
  { key:'grid_limit_solver_evidence', label:'Power flow solver evidence', type:'evidence_only',
    hint:'Solver/engine used inside the optimization loop (e.g. LinDistFlow, Newton-Raphson, SOCP relaxation)' },
  { key:'linearized_ac_type', label:'AC Model Type', type:'enum',
    options:['slp - successive linearization','fixed - linear approximation','convex_relaxation - SOCP/SDP','n/a','unknown'],
    default:'n/a', subField:true,
    hint:'SLP iterative, fixed LinDistFlow, or convex relaxation (SOCP/SDP) — n/a if not level 4' },
  { key:'v2g', label:'Vehicle-to-Grid (V2G)', type:'enum',
    options:['yes','no','unknown'], default:'unknown', evidence:true,
    hint:'Bidirectional EV discharge back to the grid explicitly modeled' },
  { key:'max_evs', label:'Max EVs in Case Study', type:'string', default:'', evidence:true,
    evidenceKey:'ev_count_evidence', evidenceLabel:'Evidence (where EV count is stated)',
    hint:'Largest EV fleet in any case study — exact number, "~200", or "not simulated"' },
  { key:'methodologies', label:'Methodologies', type:'methodologies' },
  { key:'modality_types', label:'Modality Types', type:'string', default:'', evidence:true,
    evidenceKey:'modality_types_evidence', evidenceLabel:'Evidence (fleet/vehicle type studied)',
    hint:'Standardized: EV=car, BEB=bus, ET=truck, EP=plane, ES=ship. Add freeform words for anything else (taxi, e-scooter, train...)' }
];

function toggleFieldsPanel() {
  _fieldsPanelOpen = !_fieldsPanelOpen;
  document.getElementById('fields-list').style.display   = _fieldsPanelOpen ? '' : 'none';
  document.getElementById('fields-chevron').style.transform =
    _fieldsPanelOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
}

function renderFieldsList() {
  const list  = document.getElementById('fields-list');
  const badge = document.getElementById('fields-count-badge');
  const fields = S.fieldsConfig;
  badge.textContent = `${fields.length} field${fields.length !== 1 ? 's' : ''}`;

  list.innerHTML = '';
  if (!fields.length) {
    list.appendChild(el('p', 'text-xs text-gray-600 italic px-4 py-3', 'No fields configured — click "+ Add field" to begin.'));
    return;
  }

  fields.forEach((fd, i) => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 px-4 py-2.5 hover:bg-gray-800/50 group';

    const badge = el('span', `text-xs px-2 py-0.5 rounded-full font-mono shrink-0 ${TYPE_BADGE[fd.type] || 'bg-gray-700 text-gray-400'}`, fd.type);
    row.appendChild(badge);

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    info.appendChild(el('div', 'text-sm text-gray-200 truncate', fd.label || fd.key));
    if (fd.type !== 'boolean_group') {
      info.appendChild(el('div', 'text-xs text-gray-600 font-mono truncate', fd.key));
    } else {
      info.appendChild(el('div', 'text-xs text-gray-600 font-mono truncate',
        (fd.fields || []).map(f => f.key).join(', ')));
    }
    row.appendChild(info);

    const btns = document.createElement('div');
    btns.className = 'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'p-1 text-gray-600 hover:text-gray-300 transition-colors disabled:opacity-20';
    up.textContent = '↑'; up.title = 'Move up'; up.disabled = i === 0;
    up.addEventListener('click', () => { moveField(i, -1); });

    const dn = document.createElement('button');
    dn.type = 'button';
    dn.className = 'p-1 text-gray-600 hover:text-gray-300 transition-colors disabled:opacity-20';
    dn.textContent = '↓'; dn.title = 'Move down'; dn.disabled = i === fields.length - 1;
    dn.addEventListener('click', () => { moveField(i, 1); });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => { openEditFieldModal(i); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'text-xs px-2 py-0.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 rounded transition-colors';
    del.textContent = 'Delete';
    del.addEventListener('click', () => { deleteField(i); });

    btns.append(up, dn, edit, del);
    row.appendChild(btns);
    list.appendChild(row);
  });
}

function moveField(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= S.fieldsConfig.length) return;
  [S.fieldsConfig[i], S.fieldsConfig[j]] = [S.fieldsConfig[j], S.fieldsConfig[i]];
  persistFieldsConfig();
  renderFieldsList();
}

function deleteField(i) {
  S.fieldsConfig.splice(i, 1);
  persistFieldsConfig();
  renderFieldsList();
}

function persistFieldsConfig() {
  localStorage.setItem('ev_fields_config', JSON.stringify(S.fieldsConfig));
  _promptTokenCache = null; // prompt changes when field definitions change
}

function importFieldsJson() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json';
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Expected a JSON array of field configs');
      S.fieldsConfig = data;
      persistFieldsConfig();
      renderFieldsList();
      toast(`Imported ${data.length} field${data.length !== 1 ? 's' : ''} from ${f.name}`, 'emerald');
    } catch (e) {
      alert(`Failed to import: ${e.message}`);
    }
  });
  inp.click();
}

function exportFieldsJson() {
  const blob = new Blob([JSON.stringify(S.fieldsConfig, null, 2)], { type: 'application/json;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'fields.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast('fields.json downloaded — replace the file on disk to persist permanently', 'emerald');
}

async function resetFieldsFromFile() {
  if (!confirm('Reset fields to the version in fields.json? Unsaved edits will be lost.')) return;
  localStorage.removeItem('ev_fields_config');
  S.fieldsConfig = [];
  await loadFieldsConfig();
  renderFieldsList();
  toast('Fields reset from fields.json', 'emerald');
}

// ── Field editor modal ────────────────────────────────────────────
function openAddFieldModal() {
  _editingFieldIdx = -1;
  document.getElementById('field-modal-title').textContent = 'Add Field';
  ['fm-key','fm-label','fm-options','fm-default','fm-evidence-key','fm-evidence-label',
   'fm-show-when-key','fm-show-when-value','fm-hint','fm-boolgroup','fm-prompt-text'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('fm-type').value = 'enum';
  document.getElementById('fm-evidence').checked = false;
  document.getElementById('fm-subfield').checked = false;
  updateFieldModalForType();
  document.getElementById('field-modal').classList.remove('hidden');
}

function openEditFieldModal(i) {
  _editingFieldIdx = i;
  const fd = S.fieldsConfig[i];
  document.getElementById('field-modal-title').textContent = `Edit Field: ${fd.key}`;

  document.getElementById('fm-key').value   = fd.key   || '';
  document.getElementById('fm-label').value = fd.label || '';
  document.getElementById('fm-type').value  = fd.type  || 'enum';
  document.getElementById('fm-hint').value  = fd.hint  || '';

  if (fd.type === 'enum') {
    document.getElementById('fm-options').value = (fd.options || []).join('\n');
    document.getElementById('fm-default').value = fd.default !== undefined ? String(fd.default) : '';
  }
  if (fd.type === 'boolean_group') {
    document.getElementById('fm-boolgroup').value =
      (fd.fields || []).map(f => `${f.key}: ${f.label}`).join('\n');
  }

  document.getElementById('fm-evidence').checked           = !!fd.evidence;
  document.getElementById('fm-evidence-key').value         = fd.evidenceKey   || '';
  document.getElementById('fm-evidence-label').value       = fd.evidenceLabel || '';
  document.getElementById('fm-show-when-key').value        = fd.showWhen?.key   || '';
  document.getElementById('fm-show-when-value').value      = fd.showWhen?.value || '';
  document.getElementById('fm-subfield').checked           = !!fd.subField;
  document.getElementById('fm-prompt-text').value          = fd.promptText || '';

  updateFieldModalForType();
  document.getElementById('field-modal').classList.remove('hidden');
}

function closeFieldModal() {
  document.getElementById('field-modal').classList.add('hidden');
}

function updateFieldModalForType() {
  const type     = document.getElementById('fm-type').value;
  const hasEvid  = document.getElementById('fm-evidence').checked;
  const isEnum   = type === 'enum';
  const isBgroup = type === 'boolean_group';
  const isEvOnly = type === 'evidence_only';
  const isMeth   = type === 'methodologies';

  document.getElementById('fm-options-wrap').style.display    = isEnum   ? '' : 'none';
  document.getElementById('fm-boolgroup-wrap').style.display  = isBgroup ? '' : 'none';
  document.getElementById('fm-evidence-section').style.display = isEvOnly || isBgroup || isMeth ? 'none' : '';
  document.getElementById('fm-evidence-details').style.display = hasEvid  ? '' : 'none';
}

function saveFieldModal() {
  const key   = document.getElementById('fm-key').value.trim();
  const type  = document.getElementById('fm-type').value;
  const label = document.getElementById('fm-label').value.trim();

  if (!key) { alert('Key is required.'); return; }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) { alert('Key must be snake_case with letters/numbers/underscores.'); return; }

  const dupIdx = S.fieldsConfig.findIndex(f => f.key === key);
  if (dupIdx !== -1 && dupIdx !== _editingFieldIdx) {
    alert(`Key "${key}" already exists at position ${dupIdx + 1}.`); return;
  }

  const fd = { key, type };
  if (label) fd.label = label;

  const hintVal = document.getElementById('fm-hint').value.trim();
  if (hintVal) fd.hint = hintVal;

  if (type === 'enum') {
    fd.options = document.getElementById('fm-options').value.split('\n').map(s => s.trim()).filter(Boolean);
    const defVal = document.getElementById('fm-default').value.trim();
    if (defVal) fd.default = defVal;
  }
  if (type === 'boolean') {
    fd.default = false;
  }
  if (type === 'boolean_group') {
    fd.fields = document.getElementById('fm-boolgroup').value
      .split('\n')
      .map(line => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return null;
        return { key: line.slice(0, colonIdx).trim(), label: line.slice(colonIdx + 1).trim() };
      })
      .filter(f => f && f.key);
  }

  const evidenceChecked = document.getElementById('fm-evidence').checked;
  if (evidenceChecked && type !== 'boolean_group' && type !== 'evidence_only') {
    fd.evidence = true;
    const evKey = document.getElementById('fm-evidence-key').value.trim();
    if (evKey) fd.evidenceKey = evKey;
    const evLabel = document.getElementById('fm-evidence-label').value.trim();
    if (evLabel) fd.evidenceLabel = evLabel;
  }

  const swKey = document.getElementById('fm-show-when-key').value.trim();
  const swVal = document.getElementById('fm-show-when-value').value.trim();
  if (swKey && swVal) fd.showWhen = { key: swKey, value: swVal };

  if (document.getElementById('fm-subfield').checked) fd.subField = true;

  const promptTextVal = document.getElementById('fm-prompt-text').value.trim();
  if (promptTextVal) fd.promptText = promptTextVal;

  if (_editingFieldIdx === -1) {
    S.fieldsConfig.push(fd);
  } else {
    S.fieldsConfig[_editingFieldIdx] = fd;
  }

  persistFieldsConfig();
  renderFieldsList();
  closeFieldModal();
  toast(`Field "${key}" ${_editingFieldIdx === -1 ? 'added' : 'updated'}`, 'emerald');
}

async function loadFieldsConfig() {
  if (S.fieldsConfig.length) return S.fieldsConfig;

  const stored = localStorage.getItem('ev_fields_config');
  if (stored) {
    try { S.fieldsConfig = JSON.parse(stored); return S.fieldsConfig; } catch (_) {}
  }

  try {
    const r = await fetch('./fields.json');
    if (r.ok) { S.fieldsConfig = await r.json(); return S.fieldsConfig; }
  } catch (_) {}

  S.fieldsConfig = JSON.parse(JSON.stringify(BUILT_IN_FIELDS));
  return S.fieldsConfig;
}

function buildGeminiSchemaFromConfig(fields) {
  const props = { file_index: { type:'INTEGER' }, title: { type:'STRING' } };
  const req   = ['file_index', 'title'];

  for (const fd of fields) {
    if (fd.type === 'boolean_group') {
      for (const sub of fd.fields || []) { props[sub.key] = { type:'BOOLEAN' }; req.push(sub.key); }
    } else if (fd.type === 'evidence_only') {
      props[fd.key] = { type:'ARRAY', items:{ type:'STRING' } }; req.push(fd.key);
    } else if (fd.type === 'methodologies') {
      props[fd.key] = {
        type:'ARRAY', items:{ type:'OBJECT',
          properties:{ methodology_name:{type:'STRING'}, method_evidence:{type:'STRING'} },
          required:['methodology_name','method_evidence'] }
      };
      req.push(fd.key);
    } else {
      const typeMap = { enum:'STRING', string:'STRING', boolean:'BOOLEAN', integer:'INTEGER', number:'NUMBER' };
      const propDef = { type: typeMap[fd.type] || 'STRING' };
      if (fd.type === 'enum' && fd.options?.length) propDef.enum = fd.options;
      props[fd.key] = propDef; req.push(fd.key);
      if (fd.evidence) {
        const evKey = fd.evidenceKey || (fd.key + '_evidence');
        props[evKey] = { type:'ARRAY', items:{ type:'STRING' } }; req.push(evKey);
      }
    }
  }

  return { type:'OBJECT', properties:props, required:req };
}
