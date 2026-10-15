// ================================================================
// GLOBAL STATE
// ================================================================
const S = {
  apiKey: '',
  files:      [],   // File objects (raw)
  blobUrls:   {},   // filename → object URL
  papers:     [],   // extracted/manual paper data
  idx:        0,    // current verification index
  fieldsConfig: [], // loaded from fields.json / localStorage
  // CSV mode
  csvMode:     false,
  pdfOnlyMode: false, // true when session was started from PDFs without a CSV
  csvHeaders:  [],    // original column names from Scopus CSV
  csvRows:     [],    // rows with Exclusion Reason == "IN", or all rows if that column is absent
  csvFilename:  '',   // original CSV filename (for export)
  csvJobs:     {},    // { idx: { status: 'pending'|'done'|'error', message?: string } }
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Shared across fields.js (reset on config change) and api.js (set after build)
let _promptTokenCache = null;

// ================================================================
// CURRENT PAPER ACCESSORS (here to break form.js ↔ nav.js cycle)
// ================================================================
function cur() { return S.papers[S.idx]; }

function refreshCounter() {
  const verified = S.papers.filter(p => p._verified).length;
  document.getElementById('verify-counter').textContent =
    `Paper ${S.idx + 1} of ${S.papers.length}  ·  ${verified} Verified`;
}

// ================================================================
// UTILITIES
// ================================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, 56) + 'px';
}

function truncLog(s) { return String(s).slice(0, 80); }

function isoDate() { return new Date().toISOString().slice(0, 10); }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  return e;
}

function fieldLabel(labelText, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'flex items-baseline gap-2';
  wrap.appendChild(el('label', 'block text-xs font-semibold text-gray-400 uppercase tracking-wide', labelText));
  if (hint) wrap.appendChild(el('span', 'text-xs text-gray-600 normal-case font-normal', hint));
  return wrap;
}

function toast(msg, color = 'gray') {
  const palette = {
    emerald: 'bg-emerald-700 text-white',
    amber:   'bg-amber-600 text-white',
    red:     'bg-red-700 text-white',
    gray:    'bg-gray-700 text-gray-100'
  };
  const t = document.createElement('div');
  t.className = `toast ${palette[color] || palette.gray}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade');
    setTimeout(() => t.remove(), 450);
  }, 2500);
}

// CSV-safe cell: wrap in double quotes, escape internals, strip newlines
function csv(val) {
  if (val == null) return '""';
  const clean = String(val).replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
  return `"${clean}"`;
}

// Serialize an array or object to compact JSON, then CSV-escape it
function csvJson(val) {
  const json = JSON.stringify(val ?? []);
  return `"${json.replace(/"/g, '""')}"`;
}

// Normalise any evidence value to a non-empty array (backward-compat with old string sessions)
function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(s => s !== null && s !== undefined);
  return [v];
}

// First non-empty string across any number of evidence sources
function firstEvidence(...sources) {
  for (const src of sources) {
    const a = asArray(src);
    const hit = a.find(s => s && s.trim());
    if (hit) return hit;
  }
  return null;
}

// Strip LaTeX notation so a Gemini equation quote can be matched against PDF text.
// $P_{D}(h)+EV_{D}(h)$ → PD(h)+EVD(h)
function stripLatex(text) {
  return text
    .replace(/\$\$?([^$]*?)\$\$?/g, '$1')   // remove $...$ delimiters, keep content
    .replace(/\\[a-zA-Z]+\s*/g, ' ')          // \le \sum \frac etc → space
    .replace(/[_^]\{([^}]*)\}/g, '$1')        // _{abc} ^{abc} → abc
    .replace(/[_^]([a-zA-Z0-9])/g, '$1')     // _x ^x → x
    .replace(/[{}\\]/g, '')                   // remaining braces and backslashes
    .replace(/\s+/g, ' ')
    .trim();
}

// True when text looks like a LaTeX equation (has $ delimiters or backslash commands).
function isEquationLike(text) {
  return /\$/.test(text) || /\\[a-zA-Z]/.test(text);
}

// Like stripLatex but REMOVES subscript/superscript content entirely instead of keeping it.
// $P_{D}(h)+EV_{D}(h)$ → P(h)+EV(h) — keeps only base characters, no subscripts.
// This produces a fingerprint that matches the PDF baseline text even when
// subscript items appear out-of-order in the PDF content stream.
function stripLatexBaseOnly(text) {
  return text
    .replace(/\$\$?([^$]*?)\$\$?/g, '$1')
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .replace(/[_^]\{[^}]*\}/g, '')           // _{abc} → removed (not kept)
    .replace(/[_^][a-zA-Z0-9]/g, '')         // _x → removed
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detect evidence strings that contain mostly non-ASCII glyphs from PDF math fonts.
function hasEquationChars(str) {
  const nonAscii = (str.match(/[^\x20-\x7E]/g) || []).length;
  return nonAscii / str.length > 0.15;
}
