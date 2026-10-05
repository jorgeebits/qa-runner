const SUGGESTIONS = [
  'Why did this case end with this result?',
  'Point an arrow at the error message in the screenshot',
  'Spotlight the field that was validated',
  'Summarize the case in 3 lines for the issue tracker',
];

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;

function markdown(text) {
  const lines = esc(text).split('\n');
  const html = [];
  let list = false;
  for (const line of lines) {
    const item = /^\s*[-*]\s+(.*)/.exec(line);
    if (item && !list) {
      html.push('<ul>');
      list = true;
    }
    if (!item && list) {
      html.push('</ul>');
      list = false;
    }
    const inline = (item ? item[1] : line)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html.push(item ? `<li>${inline}</li>` : inline ? `<p>${inline}</p>` : '');
  }
  if (list) html.push('</ul>');
  return html.join('');
}

function activity(list = [], running = false) {
  if (!list.length) return '';
  return `<ul class="activity">${list
    .map(
      (a, i) =>
        `<li class="${a.failed ? 'failed' : ''}">${icon(a.tool === 'annotate' ? 'pencil' : a.tool === 'Read' ? 'file' : 'terminal')}<span>${esc(a.tool === 'annotate' ? `Annotated · ${a.detail}` : `${a.tool} · ${a.detail}`)}</span>${running && i === list.length - 1 ? '<span class="dots" aria-hidden="true"></span>' : ''}</li>`,
    )
    .join('')}</ul>`;
}

export function createChat({ api, getContext, onTurnFinished, toast }) {
  const panel = document.querySelector('#chat');
  const list = panel.querySelector('.chat-messages');
  const form = panel.querySelector('form');
  const input = panel.querySelector('textarea');
  const send = panel.querySelector('[data-chat="send"]');
  const stop = panel.querySelector('[data-chat="stop"]');
  const chip = panel.querySelector('.chat-context');
  const state = { open: false, key: null, busy: false, timer: null, image: null, lastRender: '' };

  const base = () => {
    const { runId, tcId } = getContext();
    return `/api/chat/${encodeURIComponent(runId)}/${encodeURIComponent(tcId)}`;
  };

  function renderContext() {
    const { tcId } = getContext();
    panel.querySelector('.chat-subtitle').textContent = tcId || '';
    chip.hidden = !state.image;
    chip.querySelector('span').textContent = state.image ? `Viendo ${state.image}` : '';
  }

  function render(data) {
    const snapshot = JSON.stringify(data);
    if (snapshot === state.lastRender) return;
    state.lastRender = snapshot;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const messages = data.messages || [];
    list.innerHTML =
      messages.length || data.pending
        ? [
            ...messages.map((m) =>
              m.role === 'user'
                ? `<div class="msg user">${m.image ? `<span class="msg-context">${icon('image')}${esc(m.image)}</span>` : ''}${markdown(m.text)}</div>`
                : `<div class="msg agent ${m.error ? 'error' : ''}">${activity(m.activity)}${markdown(m.text || '')}${m.error ? `<p class="msg-error">${icon('warn')}${esc(m.error)}</p>` : ''}${m.cost != null ? `<span class="msg-cost">≈ $${Number(m.cost).toFixed(3)}</span>` : ''}</div>`,
            ),
            data.pending
              ? `<div class="msg agent pending">${activity(data.pending.activity, true)}${data.pending.text ? markdown(data.pending.text) : '<p class="thinking"><span class="dots" aria-hidden="true"></span>Thinking…</p>'}</div>`
              : '',
          ].join('')
        : `<div class="chat-empty">
          <p>Ask the agent about this case, or have it mark up the screenshots: arrows, boxes, text, spotlight or blur.</p>
          <div class="suggestions">${SUGGESTIONS.map((s) => `<button type="button" class="suggestion">${esc(s)}</button>`).join('')}</div>
          <p class="chat-note">Cada respuesta corre un agente de Claude (${esc(data.model || 'sonnet')}) que solo puede leer los archivos de esta corrida y anotar capturas.</p>
        </div>`;
    if (atBottom || data.pending) list.scrollTop = list.scrollHeight;
  }

  async function refresh() {
    if (!state.open) return;
    try {
      const data = await api(base());
      const wasBusy = state.busy;
      state.busy = data.busy;
      send.hidden = data.busy;
      stop.hidden = !data.busy;
      render(data);
      if (wasBusy && !data.busy) onTurnFinished();
      clearTimeout(state.timer);
      state.timer = setTimeout(refresh, data.busy ? 700 : 4000);
    } catch (error) {
      toast(`Chat: ${error.message}`, true);
    }
  }

  async function submit(text) {
    const message = text.trim();
    if (!message || state.busy) return;
    input.value = '';
    autosize();
    state.busy = true;
    send.hidden = true;
    stop.hidden = false;
    try {
      await api(base(), { method: 'POST', body: JSON.stringify({ message, image: state.image }) });
    } catch (error) {
      toast(`No se pudo enviar: ${error.message}`, true);
    }
    refresh();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit(input.value);
    }
    if (event.key === 'Escape') close();
  });
  input.addEventListener('input', autosize);
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.classList.contains('suggestion')) submit(button.textContent);
    else if (button.dataset.chat === 'close') close();
    else if (button.dataset.chat === 'stop')
      await api(`${base()}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
    else if (button.dataset.chat === 'clear-image') {
      state.image = null;
      renderContext();
    } else if (button.dataset.chat === 'reset') {
      if (!confirm('Start a new conversation? The current one is archived.')) return;
      await api(base(), { method: 'DELETE' });
      state.lastRender = '';
      refresh();
    }
  });

  function open({ image } = {}) {
    const { runId, tcId } = getContext();
    const key = `${runId}/${tcId}`;
    if (key !== state.key) {
      state.key = key;
      state.lastRender = '';
      list.innerHTML = '';
    }
    if (image !== undefined) state.image = image;
    state.open = true;
    panel.hidden = false;
    document.body.classList.add('chat-open');
    renderContext();
    refresh();
    input.focus();
  }

  function close() {
    state.open = false;
    clearTimeout(state.timer);
    panel.hidden = true;
    document.body.classList.remove('chat-open');
    document.querySelector('#open-chat')?.focus();
  }

  return {
    open,
    close,
    toggle: () => (state.open ? close() : open()),
    caseChanged: () => {
      state.image = null;
      if (state.open) open();
    },
    isOpen: () => state.open,
  };
}
