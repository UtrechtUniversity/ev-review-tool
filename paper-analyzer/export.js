// ================================================================
// UNMATCHED PAPERS EXPORT — papers still missing a PDF
// ================================================================
function exportUnmatchedCsv() {
  const missing = S.papers
    .map((p, i) => ({ p, row: S.csvRows[i] }))
    .filter(({ p }) => !p._verified && (!p._filename || !S.blobUrls[p._filename]));

  if (!missing.length) return toast('No unmatched papers.', 'gray');

  const cols = ['Title', 'Year', 'Source title', 'Authors', 'DOI'];
  const getters = [
    r => r['Title']        || r['title']                                              || '',
    r => r['Year']         || r['Publication Year'] || r['year']                      || '',
    r => r['Source title'] || r['Source Title']     || r['Journal'] || r['journal']   || '',
    r => r['Authors']      || r['Author full names'] || r['authors']                  || '',
    r => r['DOI']          || r['doi']                                                || '',
  ];

  const header = cols.map(c => csv(c)).join(',');
  const dataRows = missing.map(({ row }) => getters.map(g => csv(g(row))).join(','));

  const content = [header, ...dataRows].join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `missing_pdfs_${isoDate()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast(`Exported ${missing.length} unmatched paper${missing.length !== 1 ? 's' : ''}`, 'emerald');
}

// ================================================================
// CSV EXPORT — field values only, no evidence columns
// ================================================================
function exportCSV() {
  if (!S.papers.length) return alert('No papers to export yet.');

  const COLS    = ['filename', 'title'];
  const GETTERS = [p => csv(p._filename), p => csv(p.title)];

  for (const fd of S.fieldsConfig) {
    if (fd.type === 'boolean_group') {
      for (const sub of fd.fields || []) {
        COLS.push(sub.key);
        GETTERS.push(p => csv(p[sub.key] ? 'true' : 'false'));
      }
    } else if (fd.type === 'evidence_only') {
      // evidence-only fields have no scalar value — skip in CSV
    } else if (fd.type === 'methodologies') {
      // list method names only, no evidence
      COLS.push(fd.key);
      const k = fd.key;
      GETTERS.push(p => csvJson((p[k] || []).map(m => m.methodology_name || '').filter(Boolean)));
    } else if (fd.key === 'modality_types') {
      // single comma-separated string, serialized as a one-element JSON array: ["EV, BEB"]
      COLS.push(fd.key);
      const k = fd.key;
      GETTERS.push(p => csvJson(p[k] ? [p[k]] : []));
    } else {
      COLS.push(fd.key);
      if (fd.type === 'boolean') {
        GETTERS.push(p => csv(p[fd.key] ? 'true' : 'false'));
      } else {
        GETTERS.push(p => csv(p[fd.key] ?? ''));
      }
      // evidence columns intentionally omitted
    }
  }

  COLS.push('verified');
  GETTERS.push(p => p._verified ? '"yes"' : '"no"');

  const rows = [COLS.join(',')];
  for (const p of S.papers) rows.push(GETTERS.map(g => g(p)).join(','));

  const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `ev_grid_review_${isoDate()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast(`CSV exported — ${S.papers.length} papers`, 'emerald');
}

// ================================================================
// SCOPUS CSV EXPORT — original columns + extracted fields + JSON + verified
// ================================================================
function exportScopusCsv() {
  if (!S.csvMode || !S.csvRows.length) return alert('No Scopus CSV loaded.');

  // Build extra column list from fieldsConfig (same logic as exportCSV)
  const extraCols   = [];
  const extraGetters = [];

  for (const fd of S.fieldsConfig) {
    if (fd.type === 'boolean_group') {
      for (const sub of fd.fields || []) {
        extraCols.push(sub.key);
        extraGetters.push(p => csv(p ? (p[sub.key] ? 'true' : 'false') : ''));
      }
    } else if (fd.type === 'evidence_only') {
      // no scalar value — skip
    } else if (fd.type === 'methodologies') {
      extraCols.push(fd.key);
      const k = fd.key;
      extraGetters.push(p => p ? csvJson((p[k] || []).map(m => m.methodology_name || '').filter(Boolean)) : '""');
    } else if (fd.key === 'modality_types') {
      extraCols.push(fd.key);
      const k = fd.key;
      extraGetters.push(p => csvJson(p && p[k] ? [p[k]] : []));
    } else if (fd.type === 'boolean') {
      extraCols.push(fd.key);
      extraGetters.push(p => csv(p ? (p[fd.key] ? 'true' : 'false') : ''));
    } else {
      extraCols.push(fd.key);
      extraGetters.push(p => csv(p ? (p[fd.key] ?? '') : ''));
    }
  }

  extraCols.push('exclude_reason_2', 'response_json', 'human_verified', 'note');
  extraGetters.push(
    p => {
      const er2 = p?._excludeReason2;
      if (er2 === undefined || er2 === null) return csv(''); // not yet decided
      if (er2 === '') return csv('IN');                      // explicitly included
      return csv(er2);                                       // exclusion reason
    },
    p => csv(p?._rawJson || ''),
    p => csv(p?._verified ? 'yes' : 'no'),
    p => csv(p?._note || ''),
  );

  // Build lookup: col name → getter for all extracted columns.
  const extractedByCol = new Map();
  for (let i = 0; i < extraCols.length; i++) extractedByCol.set(extraCols[i], extraGetters[i]);

  // Only append columns that don't already exist in the loaded CSV headers.
  const existingHeaderSet = new Set(S.csvHeaders);
  const appendCols    = extraCols.filter(c => !existingHeaderSet.has(c));
  const appendGetters = appendCols.map(c => extractedByCol.get(c));

  const header = [...S.csvHeaders, ...appendCols].map(h => csv(h)).join(',');
  const dataRows = S.csvRows.map((row, i) => {
    const p = S.papers[i] || null;
    // For columns that are extracted fields, use the latest extracted value (override original).
    // For all other original columns, preserve the original CSV value.
    const originalCells = S.csvHeaders.map(h => {
      const getter = extractedByCol.get(h);
      return getter ? getter(p) : csv(row[h] ?? '');
    });
    const appendCells = appendGetters.map(g => g(p));
    return [...originalCells, ...appendCells].join(',');
  });

  const content = [header, ...dataRows].join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  const baseName = (S.csvFilename || 'scopus').replace(/\.csv$/i, '');
  a.download = `${baseName}_reviewed_${isoDate()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast(`Scopus CSV exported — ${S.csvRows.length} papers`, 'emerald');
}

// ================================================================
// JSON EXPORT — full paper data including evidence
// ================================================================
function exportPapersJson() {
  if (!S.papers.length) return alert('No papers to export yet.');
  const data = S.papers.map(p => {
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (!k.startsWith('_')) out[k] = v;
    }
    return out;
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `ev_grid_review_${isoDate()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast(`JSON exported — ${S.papers.length} papers`, 'emerald');
}
