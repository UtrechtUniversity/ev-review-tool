// ================================================================
// EPHEMERAL Q&A — ask a question about the current PDF to Gemini.
// State lives only in the DOM; never written to S.papers.
// ================================================================

function renderAskSection() {
  const pane = document.getElementById('form-pane');
  if (!pane) return;

  const section = document.createElement('div');
  section.id = 'ask-section';
  section.className = 'bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3';

  section.appendChild(el('div', 'text-xs font-semibold text-gray-400 uppercase tracking-wide', 'Ask about this paper'));

  const ta = document.createElement('textarea');
  ta.id = 'ask-input';
  ta.className = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/60 resize-none';
  ta.placeholder = 'Ask a question… (Ctrl+Enter to send)';
  ta.rows = 2;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAskQuestion();
  });
  section.appendChild(ta);

  const btnRow = document.createElement('div');
  btnRow.className = 'flex items-center gap-2';
  const sendBtn = document.createElement('button');
  sendBtn.id = 'ask-send-btn';
  sendBtn.className = 'px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors';
  sendBtn.textContent = 'Ask Gemini';
  sendBtn.onclick = sendAskQuestion;
  btnRow.appendChild(sendBtn);
  section.appendChild(btnRow);

  const responseArea = document.createElement('div');
  responseArea.id = 'ask-response-area';
  responseArea.className = 'hidden space-y-2';
  section.appendChild(responseArea);

  pane.appendChild(section);
}

async function sendAskQuestion() {
  const ta       = document.getElementById('ask-input');
  const sendBtn  = document.getElementById('ask-send-btn');
  const area     = document.getElementById('ask-response-area');
  const question = ta?.value?.trim();

  if (!question) return;

  const p = cur();
  if (!p?._filename || !S.blobUrls[p._filename]) {
    toast('No PDF loaded for this paper', 'amber'); return;
  }
  if (getModelVal() === 'none') {
    toast('No model selected', 'amber'); return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = 'Asking…';
  area.classList.remove('hidden');
  area.innerHTML = '<p class="text-xs text-indigo-400 animate-pulse">Asking Gemini…</p>';

  try {
    const pdfText = await extractPdfText(S.blobUrls[p._filename]);
    const result  = await _callAskGemini(question, pdfText);
    _renderAskResponse(area, result, question);
  } catch (err) {
    area.innerHTML = '';
    area.appendChild(el('p', 'text-xs text-red-400', `Error: ${err.message?.slice(0, 200) || 'Unknown error'}`));
    const retryBtn = document.createElement('button');
    retryBtn.className = 'text-xs px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded-lg text-white transition-colors';
    retryBtn.textContent = '↺ Retry';
    retryBtn.onclick = sendAskQuestion;
    area.appendChild(retryBtn);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Ask Gemini';
  }
}

function _renderAskResponse(area, { answer, evidence }, question) {
  area.classList.remove('hidden');
  area.innerHTML = '';

  // Answer card
  const answerEl = document.createElement('div');
  answerEl.className = 'bg-gray-800/70 rounded-lg px-3 py-2.5 text-sm text-gray-200 leading-relaxed';
  answerEl.textContent = answer || '(no answer)';
  area.appendChild(answerEl);

  // Evidence quotes
  if (evidence?.length) {
    area.appendChild(el('p', 'text-xs font-semibold text-gray-500 uppercase tracking-wide pt-1', 'Evidence'));
    for (const quote of evidence) {
      const ev = document.createElement('div');
      ev.className = 'evidence-ta evidence-view text-xs';
      ev.textContent = quote;
      area.appendChild(ev);
    }
  }

  // Retry button
  const retryBtn = document.createElement('button');
  retryBtn.className = 'text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-700 rounded-lg text-gray-400 transition-colors';
  retryBtn.textContent = '↺ Retry';
  retryBtn.onclick = sendAskQuestion;
  area.appendChild(retryBtn);
}

async function _callAskGemini(question, pdfText) {
  const prompt =
    `You are helping a researcher review a scientific paper. ` +
    `Answer the question below concisely (2–4 sentences) using ONLY the paper content. ` +
    `Be direct and specific. Do not repeat the question.\n\n` +
    `Question: ${question}\n\n` +
    `Paper:\n${pdfText.slice(0, 100000)}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      answer:   { type: 'STRING', description: 'Concise direct answer, 2–4 sentences.' },
      evidence: { type: 'ARRAY',  items: { type: 'STRING' },
                  description: '1–3 short verbatim quotes from the paper that support the answer.' }
    },
    required: ['answer', 'evidence']
  };

  const resp = await fetch(`${geminiUrl()}?key=${encodeURIComponent(S.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.1,
        maxOutputTokens: 4096,
        ...(geminiThinkingConfig() ? { thinkingConfig: geminiThinkingConfig() } : {})
      }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const data = await resp.json();
  const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error(`Empty response — finishReason: ${data?.candidates?.[0]?.finishReason ?? 'unknown'}`);
  return JSON.parse(raw);
}
