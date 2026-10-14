// ================================================================
// FORM BUILDER — config-driven, all DOM-API (XSS-safe)
// ================================================================

// Regex matching Odia / Malayalam / Ethiopic code blocks used by PDF math fonts.
const PDF_MATH_CHARS_RE = /[଀-௿ഀ-෿ሀ-፿]/;

// Renders evidence text for display:
//  • PDF math-font chars (Odia/Ethiopic) → decoded to readable ASCII via decodePdfMathChars
//  • LaTeX ($...$) → rendered via KaTeX
//  • Plain text → shown as-is
// The raw ta.value is NEVER modified — searching still uses the original text.
function renderEvidenceView(viewDiv, text) {
  if (!text) { viewDiv.textContent = ''; return; }
  const displayText = PDF_MATH_CHARS_RE.test(text) ? decodePdfMathChars(text) : text;
  viewDiv.textContent = displayText;
  if (typeof renderMathInElement === 'function' && /\$/.test(displayText)) {
    renderMathInElement(viewDiv, {
      delimiters: [
        { left: '$$', right: '$$', display: false },
        { left: '$',  right: '$',  display: false },
      ],
      throwOnError: false,
    });
  }
}

// Dual-mode evidence widget: rendered LaTeX view by default, textarea on dblclick.
// Returns { el } — the wrapper div to insert into the DOM.
function makeEvidenceWidget(initialText, onInput, onHighlight) {
  const wrap = document.createElement('div');

  const viewDiv = document.createElement('div');
  viewDiv.className = 'evidence-ta evidence-view';
  viewDiv.title = 'Click to highlight in PDF · double-click to edit';

  const ta = document.createElement('textarea');
  ta.className = 'evidence-ta';
  ta.placeholder = 'Paste verbatim quote…';
  ta.style.display = 'none';

  function showView() {
    renderEvidenceView(viewDiv, ta.value);
    viewDiv.style.display = '';
    ta.style.display = 'none';
  }

  function showEdit() {
    viewDiv.style.display = 'none';
    ta.style.display = '';
    autoResize(ta);
    ta.focus();
  }

  ta.value = initialText || '';

  if (initialText) {
    renderEvidenceView(viewDiv, initialText);
  } else {
    // New empty item — open in edit mode immediately
    viewDiv.style.display = 'none';
    ta.style.display = '';
    requestAnimationFrame(() => { autoResize(ta); ta.focus(); });
  }

  viewDiv.addEventListener('click',    () => { const v = ta.value.trim(); if (v) onHighlight(v); });
  viewDiv.addEventListener('dblclick', showEdit);
  ta.addEventListener('input',  () => { onInput(ta.value); autoResize(ta); });
  ta.addEventListener('blur',   showView);

  wrap.append(viewDiv, ta);
  return wrap;
}

function emptyPaper(filename) {
  const p = { title: filename.replace(/\.pdf$/i, ''), methodologies: [], _filename: filename, _verified: false };
  for (const fd of (S.fieldsConfig || [])) {
    if (fd.type === 'boolean_group') {
      for (const sub of fd.fields || []) p[sub.key] = false;
    } else if (fd.type === 'methodologies') {
      p[fd.key] = [];
    } else if (fd.type === 'evidence_only') {
      p[fd.key] = [];
    } else if (fd.type === 'boolean') {
      p[fd.key] = fd.default !== undefined ? fd.default : false;
      if (fd.evidence) p[fd.evidenceKey || (fd.key + '_evidence')] = [];
    } else if (fd.type === 'integer' || fd.type === 'number') {
      p[fd.key] = fd.default !== undefined ? fd.default : 0;
      if (fd.evidence) p[fd.evidenceKey || (fd.key + '_evidence')] = [];
    } else {
      const defVal = fd.default !== undefined ? fd.default
        : (fd.type === 'enum' && fd.options?.length) ? fd.options[0] : '';
      p[fd.key] = defVal;
      if (fd.evidence) p[fd.evidenceKey || (fd.key + '_evidence')] = [];
    }
  }
  return p;
}

function buildFormFromConfig(p) {
  const pane   = document.getElementById('form-pane');
  pane.innerHTML = '';
  const blobUrl  = S.blobUrls[p._filename] || '';

  pane.appendChild(buildTextField('Paper Title', p, 'title'));

  const fieldWrappers = new Map();

  for (const fd of S.fieldsConfig) {
    const wrap = buildFieldFromConfig(p, fd, blobUrl);
    if (!wrap) continue;
    pane.appendChild(wrap);
    if (fd.type === 'boolean_group') {
      for (const sub of fd.fields || []) fieldWrappers.set(sub.key, wrap);
    }
    fieldWrappers.set(fd.key, wrap);
  }

  // Wire up showWhen conditions (post-build)
  for (const fd of S.fieldsConfig) {
    if (!fd.showWhen) continue;
    const targetWrap = fieldWrappers.get(fd.key);
    if (!targetWrap) continue;

    const check = () => {
      const val  = cur()[fd.showWhen.key];
      const show = Array.isArray(fd.showWhen.value)
        ? fd.showWhen.value.includes(val) : val === fd.showWhen.value;
      targetWrap.style.display = show ? '' : 'none';
      if (!show && fd.default !== undefined) cur()[fd.key] = fd.default;
    };
    check();

    const triggerWrap = fieldWrappers.get(fd.showWhen.key);
    if (triggerWrap) {
      const sel = triggerWrap.querySelector('select[data-field-key="' + fd.showWhen.key + '"]');
      if (sel) sel.addEventListener('change', check);
    }
  }

  // Verified checkbox (always fixed)
  const row = document.createElement('div');
  row.className = 'flex items-center gap-3 pt-1 pb-5 border-t border-gray-800 mt-2';
  const cb  = document.createElement('input');
  cb.type = 'checkbox'; cb.id = 'cb-verified';
  cb.className = 'w-4 h-4 accent-emerald-500 cursor-pointer';
  cb.checked = p._verified;
  cb.addEventListener('change', () => { cur()._verified = cb.checked; refreshCounter(); });
  const lbl = document.createElement('label');
  lbl.htmlFor = 'cb-verified';
  lbl.className = 'text-sm text-gray-300 cursor-pointer select-none';
  lbl.textContent = 'Mark as verified (human reviewed)';
  row.append(cb, lbl);
  pane.appendChild(row);
}

function buildFieldFromConfig(p, fd, blobUrl) {
  if (fd.type === 'boolean_group') return buildBooleanGroupField(p, fd);
  if (fd.type === 'evidence_only') return buildEvidenceOnlyField(p, fd, blobUrl);
  if (fd.type === 'boolean')       return buildBooleanSingleField(p, fd);
  if (fd.type === 'integer' || fd.type === 'number') return buildNumberFieldFromConfig(p, fd, blobUrl);
  if (fd.type === 'string')        return buildStringFieldFromConfig(p, fd, blobUrl);
  if (fd.type === 'enum')          return buildEnumFieldFromConfig(p, fd, blobUrl);
  if (fd.type === 'methodologies') return buildMethodsSection(p, blobUrl);
  return null;
}

function buildEnumFieldFromConfig(p, fd, blobUrl) {
  const isSubField = !!fd.subField;
  const evKey = fd.evidence ? (fd.evidenceKey || (fd.key + '_evidence')) : null;

  const outer = isSubField ? (() => {
    const d = document.createElement('div');
    d.className = 'space-y-1.5 pl-4 border-l-2 border-sky-500/40 ml-1';
    return d;
  })() : null;

  const wrap = outer || document.createElement('div');
  if (!outer) wrap.className = 'space-y-1.5';

  const lblRow = document.createElement('div');
  lblRow.className = 'flex items-baseline gap-2';
  lblRow.appendChild(el('label',
    `block text-xs font-semibold ${isSubField ? 'text-sky-300' : 'text-gray-400'} uppercase tracking-wide`,
    fd.label));
  if (fd.hint) lblRow.appendChild(el('span', 'text-xs text-gray-600 normal-case', fd.hint));
  wrap.appendChild(lblRow);

  const sel = document.createElement('select');
  sel.className = `w-full bg-gray-800 border ${isSubField ? 'border-sky-500/40' : 'border-gray-700'} rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 ${isSubField ? 'focus:ring-sky-500' : 'focus:ring-indigo-500'}`;
  sel.dataset.fieldKey = fd.key;
  for (const opt of fd.options || []) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt; o.selected = p[fd.key] === opt;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { cur()[fd.key] = sel.value; });
  wrap.appendChild(sel);

  if (evKey) {
    if (!Array.isArray(p[evKey])) { p[evKey] = asArray(p[evKey]); cur()[evKey] = p[evKey]; }
    wrap.appendChild(el('div', 'text-xs text-gray-500 mt-0.5', fd.evidenceLabel || 'Evidence — click amber card to highlight in PDF'));
    wrap.appendChild(buildEvidenceArray(p, evKey, blobUrl));
  }

  return wrap;
}

function buildStringFieldFromConfig(p, fd, blobUrl) {
  const evKey = fd.evidence ? (fd.evidenceKey || (fd.key + '_evidence')) : null;
  const wrap  = document.createElement('div');
  wrap.className = 'space-y-1.5';
  wrap.appendChild(fieldLabel(fd.label, fd.hint));
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500';
  inp.value = p[fd.key] || '';
  inp.addEventListener('input', () => { cur()[fd.key] = inp.value; });
  wrap.appendChild(inp);
  if (evKey) {
    if (!Array.isArray(p[evKey])) { p[evKey] = asArray(p[evKey]); cur()[evKey] = p[evKey]; }
    wrap.appendChild(el('div', 'text-xs text-gray-500 mt-0.5', fd.evidenceLabel || 'Evidence — click amber card to highlight in PDF'));
    wrap.appendChild(buildEvidenceArray(p, evKey, blobUrl));
  }
  return wrap;
}

function buildNumberFieldFromConfig(p, fd, blobUrl) {
  const evKey = fd.evidence ? (fd.evidenceKey || (fd.key + '_evidence')) : null;
  const wrap  = document.createElement('div');
  wrap.className = 'space-y-1.5';
  wrap.appendChild(fieldLabel(fd.label, fd.hint));
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = fd.type === 'integer' ? '1' : 'any';
  inp.className = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500';
  inp.value = p[fd.key] ?? '';
  inp.addEventListener('input', () => { cur()[fd.key] = inp.value === '' ? null : Number(inp.value); });
  wrap.appendChild(inp);
  if (evKey) {
    if (!Array.isArray(p[evKey])) { p[evKey] = asArray(p[evKey]); cur()[evKey] = p[evKey]; }
    wrap.appendChild(el('div', 'text-xs text-gray-500 mt-0.5', fd.evidenceLabel || 'Evidence — click amber card to highlight in PDF'));
    wrap.appendChild(buildEvidenceArray(p, evKey, blobUrl));
  }
  return wrap;
}

function buildBooleanSingleField(p, fd) {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1.5';
  wrap.appendChild(fieldLabel(fd.label, fd.hint));
  const row = document.createElement('label');
  row.className = 'flex items-center gap-2 cursor-pointer select-none';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'w-4 h-4 accent-indigo-500';
  cb.checked = !!p[fd.key];
  cb.addEventListener('change', () => { cur()[fd.key] = cb.checked; });
  row.append(cb, el('span', 'text-sm text-gray-300', 'yes'));
  wrap.appendChild(row);
  return wrap;
}

function buildBooleanGroupField(p, fd) {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1.5';
  wrap.appendChild(fieldLabel(fd.label, fd.hint));
  const grid = document.createElement('div');
  grid.className = 'space-y-1 pl-1';
  for (const sub of fd.fields || []) {
    const row = document.createElement('label');
    row.className = 'flex items-center gap-2 cursor-pointer select-none';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'w-3.5 h-3.5 accent-sky-500';
    cb.checked = !!p[sub.key];
    cb.addEventListener('change', () => { cur()[sub.key] = cb.checked; });
    const txt = document.createElement('span');
    txt.className = 'text-xs text-gray-400'; txt.textContent = sub.label;
    row.append(cb, txt);
    grid.appendChild(row);
  }
  wrap.appendChild(grid);
  return wrap;
}

function buildEvidenceOnlyField(p, fd, blobUrl) {
  if (!Array.isArray(p[fd.key])) { p[fd.key] = asArray(p[fd.key]); cur()[fd.key] = p[fd.key]; }
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1.5';
  wrap.appendChild(fieldLabel(fd.label, fd.hint));
  wrap.appendChild(el('div', 'text-xs text-gray-500 mt-0.5', 'Evidence — click amber card to highlight in PDF'));
  wrap.appendChild(buildEvidenceArray(p, fd.key, blobUrl));
  return wrap;
}

function buildTextField(label, paper, key) {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1.5';
  wrap.appendChild(fieldLabel(label));
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500';
  inp.value = paper[key] || '';
  inp.addEventListener('input', () => { cur()[key] = inp.value; });
  wrap.appendChild(inp);
  return wrap;
}

function buildEvidenceArray(paper, key, blobUrl) {
  const container = document.createElement('div');
  container.className = 'space-y-1.5';

  function getArr() { return cur()[key]; }

  function render() {
    container.innerHTML = '';
    const arr = getArr();

    if (!arr.length) {
      container.appendChild(el(
        'p', 'text-xs text-gray-700 italic py-0.5',
        'No evidence — click + to add a quote'
      ));
    }

    arr.forEach((text, i) => {
      const block = document.createElement('div');
      block.className = 'space-y-0.5';

      const widget = makeEvidenceWidget(
        text,
        v => { getArr()[i] = v; },
        v => highlightPdf(v)
      );

      const footer = document.createElement('div');
      footer.className = 'flex justify-end';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'text-xs text-red-400/60 hover:text-red-300 transition-colors';
      removeBtn.textContent = '× remove';
      removeBtn.addEventListener('click', () => { getArr().splice(i, 1); render(); });
      footer.appendChild(removeBtn);

      block.append(widget, footer);
      container.appendChild(block);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-500 hover:text-gray-300 rounded-full transition-colors';
    addBtn.textContent = '+ add evidence quote';
    addBtn.addEventListener('click', () => { getArr().push(''); render(); });
    container.appendChild(addBtn);
  }

  render();
  return container;
}

function buildMethodsSection(paper, blobUrl) {
  const section = document.createElement('div');
  section.className = 'space-y-3';

  function render() {
    section.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'flex items-center justify-between';
    const lbl = el('span', 'text-xs font-semibold text-gray-400 uppercase tracking-wide', 'Methodologies');
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'text-xs px-3 py-1 bg-indigo-500/20 hover:bg-indigo-500/40 border border-indigo-500/40 text-indigo-300 rounded-full transition-colors';
    addBtn.textContent = '+ Add Row';
    addBtn.addEventListener('click', () => {
      cur().methodologies.push({ methodology_name: '', method_evidence: '' });
      render();
    });
    hdr.append(lbl, addBtn);
    section.appendChild(hdr);

    if (!paper.methodologies.length) {
      section.appendChild(el(
        'p', 'text-xs text-gray-600 italic text-center py-3 border border-dashed border-gray-800 rounded-lg',
        'No methodologies extracted — click + Add Row to enter one manually'
      ));
    }

    paper.methodologies.forEach((m, i) => {
      const card = document.createElement('div');
      card.className = 'bg-gray-800/50 border border-gray-700 rounded-xl p-3 space-y-2.5';

      const cardHdr = document.createElement('div');
      cardHdr.className = 'flex items-center justify-between';
      cardHdr.appendChild(el('span', 'text-xs text-gray-500 font-semibold', `Method #${i + 1}`));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'text-xs text-red-400 hover:text-red-300 transition-colors';
      delBtn.textContent = '✕ Delete';
      delBtn.addEventListener('click', () => {
        cur().methodologies.splice(i, 1);
        render();
      });
      cardHdr.appendChild(delBtn);
      card.appendChild(cardHdr);

      const nameWrap = document.createElement('div');
      nameWrap.appendChild(el('label', 'text-xs text-gray-500 block mb-0.5', 'Algorithm Name'));
      const nameInp = document.createElement('input');
      nameInp.type      = 'text';
      nameInp.className = 'w-full bg-gray-900 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500';
      nameInp.value     = m.methodology_name || '';
      nameInp.placeholder = 'e.g. MILP, MPC, GA…';
      nameInp.addEventListener('input', () => { cur().methodologies[i].methodology_name = nameInp.value; });
      nameWrap.appendChild(nameInp);
      card.appendChild(nameWrap);

      function methEvidenceBlock(labelTxt, fieldKey) {
        const wrap = document.createElement('div');
        wrap.className = 'space-y-0.5';
        wrap.appendChild(el('label', 'text-xs text-gray-500/80 italic block', labelTxt));
        wrap.appendChild(makeEvidenceWidget(
          m[fieldKey] || '',
          v => { cur().methodologies[i][fieldKey] = v; },
          v => highlightPdf(v)
        ));
        return wrap;
      }

      if (!m.method_evidence && m.methodology_evidence) {
        m.method_evidence = m.methodology_evidence;
      }

      card.appendChild(methEvidenceBlock('Algorithm evidence (where method is described)', 'method_evidence'));
      section.appendChild(card);
    });
  }

  render();
  return section;
}
