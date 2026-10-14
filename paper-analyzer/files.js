// ================================================================
// FILE HANDLING — drag-drop, file list, token estimate trigger
// ================================================================
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-active');
}
function handleDragLeave() {
  document.getElementById('drop-zone').classList.remove('drag-active');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-active');
  addFiles(Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf'));
}
function handleFiles(list) {
  addFiles(Array.from(list).filter(f => f.type === 'application/pdf'));
}
function addFiles(newFiles) {
  const seen = new Set(S.files.map(f => f.name));
  for (const f of newFiles) if (!seen.has(f.name)) S.files.push(f);
  renderFileList();
}
function clearFiles() {
  for (const url of Object.values(S.blobUrls)) URL.revokeObjectURL(url);
  S.files   = [];
  S.blobUrls = {};
  S.papers  = [];
  renderFileList();
}

function renderFileList() {
  const n     = S.files.length;
  const badge = document.getElementById('file-badge');
  const card  = document.getElementById('file-list-card');
  const ul    = document.getElementById('file-list-items');

  if (n === 0) { badge.classList.add('hidden'); card.classList.add('hidden'); updateTokenEstimate(); return; }

  badge.classList.remove('hidden');
  badge.textContent = `${n} PDF${n !== 1 ? 's' : ''} selected`;
  card.classList.remove('hidden');
  ul.innerHTML = '';
  S.files.forEach((f, i) => {
    const li   = document.createElement('li');
    li.className = 'flex items-center gap-3 px-4 py-2 hover:bg-gray-800/60';
    const num  = el('span', 'text-gray-600 w-5 text-right text-xs shrink-0', String(i + 1));
    const name = el('span', 'flex-1 text-gray-300 truncate text-xs', f.name);
    const size = el('span', 'text-gray-600 text-xs shrink-0', `${(f.size / 1024).toFixed(0)} KB`);
    li.append(num, name, size);
    ul.appendChild(li);
  });
  updateTokenEstimate();
}
