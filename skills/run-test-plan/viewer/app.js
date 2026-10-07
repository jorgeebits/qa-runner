import { annotatedUrl, openEditor } from './annotate.js';
import { createChat } from './chat.js';
import { createDashboard, fmtUsd } from './dashboard.js';

const STATUSES = ['pass', 'fail', 'blocked', 'skipped', 'running', 'pending'];
const REVIEWS = [
  ['unreviewed', 'Unreviewed'],
  ['approved', 'Approved'],
  ['needs-retest', 'Needs retest'],
  ['rejected', 'Rejected'],
];
const VERDICTS = [
  ['approved', 'Approve', 'a'],
  ['needs-retest', 'Needs retest', 'n'],
  ['rejected', 'Reject', 'r'],
];
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const VIDEO = /\.(mp4|webm)$/i;
const TEXT = /\.(json|txt|log|md|yml|har)$/i;

const state = {
  view: 'dashboard',
  runs: [],
  run: null,
  runId: null,
  tcId: null,
  statusFilter: new Set(),
  reviewFilter: new Set(),
  query: '',
  lastPayload: '',
  drafts: new Map(),
  openFiles: new Set(),
  fileCache: new Map(),
  lightbox: { items: [], index: 0 },
  timer: null,
  saving: false,
  showMarks: true,
  editing: false,
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const statusKey = (status) => (status === 'n/a' ? 'na' : status);
const badge = (status) =>
  `<span class="badge s-${esc(statusKey(status))}">${icon(statusKey(status))}${esc(status)}</span>`;
const reviewBadge = (review) =>
  review?.verdict
    ? `<span class="badge outline r-${esc(review.verdict)}">${icon(review.verdict)}${esc(review.verdict.replace('-', ' '))}</span>`
    : '';
const fileUrl = (tcId, file) =>
  `/runs/${encodeURIComponent(state.runId)}/tc/${encodeURIComponent(tcId)}/evidence/${encodeURIComponent(file)}`;
const runFile = (tcId, file) => `/runs/${encodeURIComponent(state.runId)}/tc/${encodeURIComponent(tcId)}/${file}`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const currentCase = () => state.run?.testCases.find((tc) => tc.id === state.tcId);
const storage = {
  get: (key) => {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

async function api(path, options = {}) {
  const write = options.method && options.method !== 'GET';
  const headers = { ...(write && { 'x-qa-viewer': '1', 'Content-Type': 'application/json' }), ...options.headers };
  const response = await fetch(path, { cache: 'no-store', ...options, headers });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function parseHash() {
  const match = /^#\/run\/([^/]+)(?:\/tc\/([^/]+))?/.exec(location.hash);
  return match ? { runId: decodeURIComponent(match[1]), tcId: match[2] ? decodeURIComponent(match[2]) : null } : {};
}

function setHash() {
  if (state.view !== 'run') return;
  const next = `#/run/${encodeURIComponent(state.runId)}${state.tcId ? `/tc/${encodeURIComponent(state.tcId)}` : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

async function loadRuns() {
  state.runs = await api('/api/runs');
  $('#run-select').innerHTML =
    '<option value="">Dashboard</option>' +
    state.runs
        .map((r) => {
          const c = r.counts || {};
          const parts = [
            `${c.pass || 0} pass`,
            c.fail ? `${c.fail} fail` : '',
            c.blocked ? `${c.blocked} blocked` : '',
            `${c.total || 0} total`,
          ];
          return `<option value="${esc(r.id)}">${esc(`${r.id}${r.label ? ` · ${r.label}` : ''} — ${parts.filter(Boolean).join(', ')}`)}</option>`;
        })
        .join('');
}

function showDashboard() {
  state.view = 'dashboard';
  clearTimeout(state.timer);
  chat.close?.();
  document.body.dataset.view = 'dashboard';
  $('#run-select').value = '';
  $('#live').hidden = true;
  if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/');
  renderMemoryBadge();
  return dashboard.load().catch(showError);
}

function showRun(runId, tcId = null) {
  dashboard.hide();
  state.view = 'run';
  document.body.dataset.view = 'run';
  if (runId !== state.runId) state.drafts.clear();
  state.runId = runId;
  state.tcId = tcId;
  $('#run-select').value = runId;
  return loadRun({ force: true }).catch(showError);
}

async function loadRun({ force = false } = {}) {
  if (!state.runId || state.view !== 'run') return;
  const run = await api(`/api/runs/${encodeURIComponent(state.runId)}`);
  const payload = JSON.stringify(run);
  if (!force && payload === state.lastPayload) return scheduleNext();
  state.lastPayload = payload;
  state.run = run;
  if (!state.tcId || !run.testCases.some((tc) => tc.id === state.tcId)) state.tcId = run.testCases[0]?.id || null;
  setHash();
  renderHeader();
  renderFilters();
  renderList();
  if (force || !document.activeElement?.closest?.('.review-bar, .question-form')) renderDetail();
  renderMemoryBadge();
  scheduleNext();
}

const openQuestions = (tc) => (tc.questions || []).filter((q) => !q.answeredAt);

function questionCards(tc) {
  const answered = (tc.questions || []).filter((q) => q.answeredAt);
  const open = openQuestions(tc)
    .map(
      (q) => `
    <form class="card question-form" data-qid="${esc(q.id)}" aria-labelledby="q-${esc(q.id)}">
      <div class="card-body">
        <h3 id="q-${esc(q.id)}">${icon('question')}The agent needs: ${esc(q.field)}</h3>
        ${q.context ? `<p class="meta">${esc(q.context)}</p>` : ''}
        ${q.screenshot ? `<button type="button" class="btn" data-zoom="${esc(q.screenshot)}">${icon('image')}${esc(q.screenshot)}</button>` : ''}
        <div class="question-row">
          <label class="sr-only" for="answer-${esc(q.id)}">Answer</label>
          <input id="answer-${esc(q.id)}" name="answer" autocomplete="off" required placeholder="Answer for the agent" />
          <label class="check"><input type="checkbox" name="sensitive" /> Sensitive (not saved)</label>
          <label class="sr-only" for="remember-${esc(q.id)}">Remember</label>
          <select id="remember-${esc(q.id)}" name="remember">
            <option value="">Don't remember</option>
            <option value="project">Remember for this project</option>
            <option value="user">Remember just for me</option>
          </select>
          <button type="submit" class="btn primary">${icon('send')}Send</button>
        </div>
        <p class="meta">Waiting since ${esc(fmtDate(q.askedAt))}. Remembered answers are offered to future runs in the same variant.</p>
      </div>
    </form>`,
    )
    .join('');
  const done = answered.length
    ? `<div class="card"><div class="card-body"><h3>${icon('question')}Answers given</h3><ul class="answers">${answered
        .map(
          (q) =>
            `<li><strong>${esc(q.field)}</strong>: <span class="mono">${esc(q.answer)}</span>${q.memoryId ? ` <span class="tag">${icon('memory')}remembered ${esc(q.memoryId)}</span>` : ''}</li>`,
        )
        .join('')}</ul></div></div>`
    : '';
  return open + done;
}

async function sendAnswer(form) {
  const data = new FormData(form);
  const sensitive = data.get('sensitive') === 'on';
  if (sensitive && data.get('remember')) return toast('Sensitive answers cannot be remembered.', true);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const answered = await api(
      `/api/runs/${encodeURIComponent(state.runId)}/answer/${encodeURIComponent(state.tcId)}/${encodeURIComponent(form.dataset.qid)}`,
      { method: 'POST', body: JSON.stringify({ answer: data.get('answer'), sensitive, remember: data.get('remember') || null }) },
    );
    toast(answered.memoryId ? `Sent and remembered as ${answered.memoryId}` : 'Sent to the agent');
    document.activeElement?.blur();
    await loadRun({ force: true });
  } catch (error) {
    button.disabled = false;
    toast(error.message, true);
  }
}

async function renderMemoryBadge() {
  try {
    state.memory = await api('/api/memory');
  } catch {
    return;
  }
  const proposed = state.memory.filter((m) => m.status === 'proposed').length;
  const badge_ = $('#memory-count');
  badge_.hidden = !proposed;
  badge_.textContent = proposed;
  if ($('#memory-panel').open) renderMemoryPanel();
}

function renderMemoryPanel() {
  const groups = [
    ['proposed', 'To review', 'Proposed by agents or the chat. Nothing here is reused until you approve it.'],
    ['active', 'Active', 'Offered to Test Agents in matching cases.'],
    ['stale', 'Stale', 'Failed twice or retired by hand. Not offered.'],
  ];
  const actions = {
    proposed: [['approve', 'Approve', 'primary'], ['reject', 'Reject', '']],
    active: [['stale', 'Retire', '']],
    stale: [['activate', 'Reactivate', ''], ['delete', 'Delete', '']],
  };
  const row = (m) => `
    <li class="memory-item">
      <div>
        <span class="tag mono">${esc(m.id)}</span> <span class="tag">${esc(m.kind)}</span> <span class="tag">${esc(m.share)}</span>
        ${Object.entries(m.scope?.variants || {}).map(([k, v]) => `<span class="tag">${esc(variantLabel(k))}: ${esc(v)}</span>`).join(' ')}
        <p>${esc(m.text)}</p>
        ${m.value ? `<p class="meta">Value: <span class="mono">${esc(m.value)}</span></p>` : ''}
        ${m.secretRef ? `<p class="meta">Secret from <span class="mono">${esc(m.secretRef)}</span></p>` : ''}
        <p class="meta">${[m.source?.run && `from ${m.source.run}${m.source.tc ? ` / ${m.source.tc}` : ''}`, m.stats && `used ${m.stats.used || 0}, failed ${m.stats.failed || 0}`, m.expires && `expires ${m.expires}`].filter(Boolean).map(esc).join(' · ')}</p>
      </div>
      <div class="memory-actions">${actions[m.status]
        .map(([action, label, cls]) => `<button type="button" class="btn ${cls}" data-mem="${esc(m.id)}" data-mem-action="${action}">${label}</button>`)
        .join('')}</div>
    </li>`;
  $('#memory-body').innerHTML = groups
    .map(([status, title, hint]) => {
      const items = (state.memory || []).filter((m) => m.status === status);
      return items.length || status !== 'stale'
        ? `<section><h3>${title} <span class="count">${items.length}</span></h3><p class="meta">${hint}</p>${items.length ? `<ul class="memory-list">${items.map(row).join('')}</ul>` : '<p class="empty">Nothing here.</p>'}</section>`
        : '';
    })
    .join('');
}

async function memoryAction(id, action) {
  if ((action === 'reject' || action === 'delete') && !confirm(`Delete memory ${id}?`)) return;
  try {
    await api(`/api/memory/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    await renderMemoryBadge();
    renderMemoryPanel();
  } catch (error) {
    toast(error.message, true);
  }
}

function scheduleNext() {
  clearTimeout(state.timer);
  const live = state.run?.testCases.some((tc) => tc.status === 'pending' || tc.status === 'running');
  $('#live').hidden = !live;
  state.timer = setTimeout(() => loadRun().catch(showError), live ? 3000 : 15000);
}

function issueLink(key) {
  const template = state.run?.config?.issueUrl;
  return template
    ? `<a href="${esc(template.replace('{key}', encodeURIComponent(key)))}" target="_blank" rel="noreferrer">${esc(key)}</a>`
    : esc(key);
}

const targetLabel = (key) => state.run?.config?.targets?.[key] || key;
const variantLabel = (key) => state.run?.config?.variants?.[key]?.label || key;

function renderHeader() {
  const { plan, meta, counts, testCases } = state.run;
  const env = plan.environment || {};
  const reviewed = testCases.filter((tc) => tc.review?.verdict).length;
  const total = counts.total || 1;
  const meta_ = [
    plan.issue && issueLink(plan.issue),
    env.name && esc(env.name),
    meta.label && esc(meta.label),
    meta.createdAt && esc(fmtDate(meta.createdAt)),
    meta.recordAll && 'recording on',
    meta.retestOf && `retest of <span class="mono">${esc(meta.retestOf)}</span>`,
    state.run.cost?.totalUsd != null &&
      `<span title="API list-price equivalent${state.run.cost.estimated ? ', partly estimated' : ''}">${state.run.cost.estimated ? '≈ ' : ''}${esc(fmtUsd(state.run.cost.totalUsd))}</span>`,
  ].filter(Boolean);
  const stat = (key, label, value) =>
    `<div class="stat s-${key}"><b>${value}</b><span>${key === 'reviewed' ? icon('approved') : icon(key)}${label}</span></div>`;
  const inFlight = (counts.running || 0) + (counts.pending || 0);
  $('#run-header').innerHTML = `
    <div>
      <h1>${esc(plan.title)}</h1>
      <div class="run-meta">${meta_.map((m) => `<span>${m}</span>`).join('')}</div>
    </div>
    <div class="stats">
      ${stat('pass', 'Pass', counts.pass || 0)}
      ${stat('fail', 'Fail', counts.fail || 0)}
      ${counts.blocked ? stat('blocked', 'Blocked', counts.blocked) : ''}
      ${counts.skipped ? stat('skipped', 'Skipped', counts.skipped) : ''}
      ${inFlight ? stat('running', 'In progress', inFlight) : ''}
      ${stat('reviewed', 'Reviewed', `${reviewed}/${counts.total}`)}
    </div>
    <div class="progress" role="img" aria-label="${esc(
      STATUSES.filter((s) => counts[s])
        .map((s) => `${counts[s]} ${s}`)
        .join(', '),
    )}">
      ${['pass', 'fail', 'blocked', 'skipped', 'running']
        .filter((s) => counts[s])
        .map((s) => `<span class="bar-${s}" style="width:${(counts[s] / total) * 100}%"></span>`)
        .join('')}
    </div>`;
}

function reviewKey(tc) {
  return tc.review?.verdict || 'unreviewed';
}

function renderFilters() {
  const { counts, testCases } = state.run;
  $('#status-filters').innerHTML = STATUSES.filter((s) => counts[s])
    .map(
      (s) =>
        `<button class="chip s-${s}" type="button" data-status="${s}" aria-pressed="${state.statusFilter.has(s)}">${icon(s)}${s} <b>${counts[s]}</b></button>`,
    )
    .join('');
  const reviewCounts = Object.fromEntries(
    REVIEWS.map(([key]) => [key, testCases.filter((tc) => reviewKey(tc) === key).length]),
  );
  $('#review-filters').innerHTML = REVIEWS.filter(([key]) => reviewCounts[key])
    .map(
      ([key, label]) =>
        `<button class="chip ${key === 'unreviewed' ? '' : `r-${key}`}" type="button" data-review="${key}" aria-pressed="${state.reviewFilter.has(key)}">${key === 'unreviewed' ? icon('pending') : icon(key)}${label} <b>${reviewCounts[key]}</b></button>`,
    )
    .join('');
}

function visibleCases() {
  const q = state.query.trim().toLowerCase();
  return state.run.testCases.filter(
    (tc) =>
      (!state.statusFilter.size || state.statusFilter.has(tc.status)) &&
      (!state.reviewFilter.size || state.reviewFilter.has(reviewKey(tc))) &&
      (!q ||
        [tc.id, tc.title, ...Object.values(tc.variants || {}), tc.group, ...(tc.tags || [])]
          .join(' ')
          .toLowerCase()
          .includes(q)),
  );
}

function renderList() {
  const groups = new Map();
  for (const tc of visibleCases()) {
    const key = tc.group || 'Test cases';
    groups.set(key, [...(groups.get(key) || []), tc]);
  }
  $('#tc-list').innerHTML =
    [...groups]
      .map(([group, cases]) => {
        const passed = cases.filter((tc) => tc.status === 'pass').length;
        return `
      <div class="group-label"><span>${esc(group)}</span><span class="mono">${passed}/${cases.length} pass</span></div>
      ${cases
        .map(
          (tc) => `
        <button class="tc-item" type="button" data-tc="${esc(tc.id)}" aria-current="${tc.id === state.tcId}"
          aria-label="${esc(`${tc.id}, ${tc.status}${tc.review?.verdict ? `, reviewed ${tc.review.verdict}` : ', not reviewed'}: ${tc.title}`)}">
          <span class="status-dot s-${esc(tc.status)}">${icon(tc.status)}</span>
          <span class="id">${esc(tc.id)}</span>
          <span class="flags">
            ${openQuestions(tc).length ? `<span class="flag-ask" title="The agent is waiting for your answer">${icon('question')}</span>` : ''}
            ${tc.warnings.length ? `<span class="flag-warn" title="${tc.warnings.length} contract warning(s)">${icon('warn')}${tc.warnings.length}</span>` : ''}
            ${tc.review?.verdict ? `<span class="review-mark r-${esc(tc.review.verdict)}" title="Reviewed: ${esc(tc.review.verdict)}">${icon(tc.review.verdict)}</span>` : ''}
          </span>
          <span class="title">${esc(tc.title)}</span>
        </button>`,
        )
        .join('')}`;
      })
      .join('') || '<p class="empty">No test case matches the filters.</p>';
}

function evidenceItems(tc) {
  const listed = new Map((tc.result?.evidence || []).map((e) => [e.file, e]));
  return tc.files.map((file) => ({ file, caption: listed.get(file)?.caption || '' }));
}

function stepEvidence(tc, files) {
  if (!files?.length) return '<span class="missing">—</span>';
  return `<div class="thumbs">${files
    .map((file) => {
      const exists = tc.files.includes(file);
      if (IMAGE.test(file) && exists)
        return `<button class="thumb" type="button" data-zoom="${esc(file)}" aria-label="Open ${esc(file)}"><img src="${fileUrl(tc.id, file)}" data-annot="${esc(file)}" alt="" loading="lazy" /></button>`;
      const kind = VIDEO.test(file) ? 'video' : IMAGE.test(file) ? 'image' : 'file';
      return `<a class="file-chip" href="${exists ? (VIDEO.test(file) ? '#sec-recording' : fileUrl(tc.id, file)) : '#'}" ${exists && !VIDEO.test(file) ? 'target="_blank" rel="noreferrer"' : ''}>${icon(kind)}${esc(file)}${exists ? '' : ' (missing)'}</a>`;
    })
    .join('')}</div>`;
}

function duration(result) {
  if (!result?.startedAt || !result?.finishedAt) return '';
  const seconds = Math.round((new Date(result.finishedAt) - new Date(result.startedAt)) / 1000);
  return seconds > 0 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : '';
}

// Which model gave this verdict; an escalated case says the cheaper model's verdict was re-checked.
function executedBy(by) {
  if (!by) return '';
  const model = `${by.model}${by.effort ? ` · ${by.effort}` : ''} (${by.tier})`;
  return by.escalatedFrom ? `${model}, re-run after ${by.escalatedFrom}: ${by.reason || 'needed a second look'}` : model;
}

function renderDetail() {
  const tc = currentCase();
  if (!tc) {
    $('#detail').innerHTML = '<p class="empty">Select a test case.</p>';
    return;
  }
  const result = tc.result && !tc.result.__parseError ? tc.result : null;
  const stepResults = new Map((result?.steps || []).map((s) => [Number(s.n), s]));
  const items = evidenceItems(tc);
  const images = items.filter((i) => IMAGE.test(i.file));
  const videos = items.filter((i) => VIDEO.test(i.file));
  const texts = items.filter((i) => TEXT.test(i.file));
  const env = result?.environment || {};
  const data = { ...(tc.data || {}), ...(result?.data || {}) };
  const defects = result?.defects || [];
  const reference = result?.reference && result.reference.result !== 'n/a' ? result.reference : null;
  const facts = [
    ...Object.entries({ ...(tc.variants || {}), ...(env.variants || {}) }).map(([k, v]) => [variantLabel(k), v]),
    ...Object.entries(env.versions || {}).map(([k, v]) => [`${targetLabel(k)} version`, v]),
    ['Duration', duration(result)],
    ['Agent', executedBy(tc.executedBy)],
    ['Evidence', tc.files.length ? `${tc.files.length} file${tc.files.length > 1 ? 's' : ''}` : ''],
  ].filter(([, v]) => v);
  const sections = [
    ['steps', 'Steps', tc.steps.length],
    videos.length && ['recording', 'Recording', videos.length],
    images.length && ['screenshots', 'Screenshots', images.length],
    texts.length && ['files', 'Files', texts.length],
    Object.keys(data).length && ['data', 'Data', Object.keys(data).length],
    defects.length && ['defects', 'Defects', defects.length],
    reference && ['reference', targetLabel('reference'), ''],
  ].filter(Boolean);
  const d = draft(tc);
  const dirty = d.verdict !== (tc.review?.verdict || '') || d.comment !== (tc.review?.comment || '');

  $('#detail').innerHTML = `
    <div class="detail-head">
      <div class="crumbs">
        ${badge(tc.status)} ${reviewBadge(tc.review)}
        <span class="tag mono">${esc(tc.id)}</span>
        ${(tc.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        <a class="tag" href="${runFile(tc.id, 'brief.md')}" target="_blank" rel="noreferrer">${icon('file')}brief</a>
        ${tc.result ? `<a class="tag" href="${runFile(tc.id, 'result.json')}" target="_blank" rel="noreferrer">${icon('external')}result.json</a>` : ''}
        <button type="button" id="open-chat" class="btn chat-btn">${icon('chat')}Chat with your agent <kbd aria-hidden="true">t</kbd></button>
      </div>
      <h2>${esc(tc.title)}</h2>
    </div>

    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}

    ${
      tc.status === 'running' || tc.status === 'pending'
        ? `<div class="callout info">${icon(tc.status)}<div><strong>${tc.status === 'running' ? 'A Test Agent is executing this case' : 'Waiting for a Test Agent'}</strong>${esc(tc.progress?.note || '')} <span class="saved">${esc(fmtDate(tc.progress?.at))}</span></div></div>`
        : ''
    }
    ${questionCards(tc)}
    ${tc.result?.__parseError ? `<div class="callout">${icon('warn')}<div><strong>result.json could not be parsed</strong>${esc(tc.result.__parseError)}</div></div>` : ''}
    ${
      tc.warnings.length
        ? `<div class="callout">${icon('warn')}<div><strong>${tc.warnings.length} contract warning${tc.warnings.length > 1 ? 's' : ''} — check before trusting this verdict</strong><ul>${tc.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></div>`
        : ''
    }

    <nav class="section-nav" aria-label="Sections">
      ${sections.map(([id, label, count]) => `<a href="#sec-${id}">${esc(label)}${count !== '' ? ` <span class="count">${count}</span>` : ''}</a>`).join('')}
    </nav>

    <div class="card">
      <div class="compare">
        <div><h4>Plan expects</h4><p>${esc(tc.expected)}</p></div>
        <div><h4>Agent reports</h4><p>${result ? esc(result.summary) : '<span class="missing">No result yet.</span>'}</p></div>
      </div>
    </div>

    <section class="card" id="sec-steps" aria-labelledby="h-steps">
      <h3 id="h-steps">Steps</h3>
      <div class="table-wrap">
        <table class="steps">
          <thead><tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">Expected</th><th scope="col">Actual</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead>
          <tbody>
            ${tc.steps
              .map((step) => {
                const r = stepResults.get(Number(step.n));
                return `<tr class="${r ? `s-${esc(statusKey(r.status))}` : ''}">
                  <td class="n">${esc(step.n)}</td>
                  <td>${esc(step.action)}</td>
                  <td class="expected">${esc(step.expected || '')}</td>
                  <td class="actual">${r?.actual ? esc(r.actual) : '<span class="missing">Not reported</span>'}</td>
                  <td>${r ? badge(r.status) : ''}</td>
                  <td>${r ? stepEvidence(tc, r.evidence) : ''}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </section>

    ${
      videos.length
        ? `<section class="card" id="sec-recording" aria-labelledby="h-rec"><h3 id="h-rec">${icon('video')}Recording</h3><div class="card-body">${videos
            .map(
              (v) =>
                `<video controls preload="metadata" src="${fileUrl(tc.id, v.file)}" aria-label="${esc(v.caption || v.file)}"></video><div class="video-caption">${esc(v.file)}${v.caption ? ` — ${esc(v.caption)}` : ''}</div>`,
            )
            .join('')}</div></section>`
        : ''
    }

    ${
      images.length
        ? `<section class="card" id="sec-screenshots" aria-labelledby="h-shots"><h3 id="h-shots">${icon('image')}Screenshots
            <button type="button" class="btn small marks-toggle" data-marks-toggle aria-pressed="${state.showMarks}">${icon('eye')}Marks ${state.showMarks ? 'on' : 'off'}</button></h3>
            <div class="card-body gallery">${images
              .map((i) => {
                const marks = tc.annotations?.[i.file]?.items.length || 0;
                return `<figure>
                <button type="button" class="zoom" data-zoom="${esc(i.file)}" aria-label="Open ${esc(i.caption || i.file)}"><img src="${fileUrl(tc.id, i.file)}" data-annot="${esc(i.file)}" alt="${esc(i.caption || i.file)}" loading="lazy" /></button>
                <figcaption>
                  <div class="fig-text">${esc(i.caption)}<span class="mono">${esc(i.file)}</span></div>
                  <div class="fig-actions">
                    ${marks ? `<span class="marks-count" title="${marks} mark(s)">${icon('pencil')}${marks}</span>` : ''}
                    <button type="button" class="icon-btn small" data-edit="${esc(i.file)}" aria-label="Edit marks on ${esc(i.file)}" title="Edit marks">${icon('pencil')}</button>
                    <button type="button" class="icon-btn small" data-ask="${esc(i.file)}" aria-label="Ask the agent about ${esc(i.file)}" title="Ask the agent about this screenshot">${icon('chat')}</button>
                  </div>
                </figcaption></figure>`;
              })
              .join('')}</div></section>`
        : ''
    }

    ${
      texts.length
        ? `<section class="card" id="sec-files" aria-labelledby="h-files"><h3 id="h-files">${icon('file')}Files</h3><div class="card-body">${texts
            .map((t) => {
              const key = `${tc.id}/${t.file}`;
              const open = state.openFiles.has(key);
              return `<details class="file" data-file="${esc(t.file)}" ${open ? 'open' : ''}><summary>${icon('file')}${esc(t.file)}${t.caption ? ` <span class="caption">— ${esc(t.caption)}</span>` : ''}</summary><pre>${esc(state.fileCache.get(key) ?? 'Loading…')}</pre></details>`;
            })
            .join('')}</div></section>`
        : ''
    }

    ${
      Object.keys(data).length
        ? `<section class="card" id="sec-data" aria-labelledby="h-data"><h3 id="h-data">Data</h3><div class="card-body"><dl class="kv">${Object.entries(
            data,
          )
            .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`)
            .join('')}</dl></div></section>`
        : ''
    }

    ${
      defects.length
        ? `<section class="card" id="sec-defects" aria-labelledby="h-defects"><h3 id="h-defects">${icon('fail')}Defects</h3><div class="card-body"><ul class="defects">${defects
            .map(
              (d) =>
                `<li><strong>${esc(d.title)}</strong> <span class="meta">${[d.severity && esc(d.severity), d.reference && esc(`${targetLabel('reference')}: ${d.reference}`), d.issue && issueLink(d.issue)].filter(Boolean).join(' · ')}</span>${d.details ? `<div class="meta">${esc(d.details)}</div>` : ''}</li>`,
            )
            .join('')}</ul></div></section>`
        : ''
    }

    ${
      reference
        ? `<section class="card" id="sec-reference" aria-labelledby="h-reference"><h3 id="h-reference">Compared with ${esc(targetLabel('reference'))}</h3><div class="card-body">${reference.checked ? badge(reference.result === 'deviation' ? 'fail' : 'pass') + ` <strong>${esc(reference.result)}</strong>` : '<span class="missing">Not checked.</span>'} ${esc(reference.notes || '')}</div></section>`
        : ''
    }
    ${result?.notes ? `<section class="card"><h3>Agent notes</h3><div class="card-body">${esc(result.notes)}</div></section>` : ''}

    <form class="review-bar" id="review-form" aria-label="Review this test case">
      <div class="review-row">
        <span class="label">Your verdict</span>
        ${VERDICTS.map(
          ([value, label, key]) =>
            `<button type="button" class="btn verdict r-${value}" data-verdict="${value}" aria-pressed="${d.verdict === value}">${icon(value)}${label}<kbd aria-hidden="true">${key}</kbd></button>`,
        ).join('')}
        ${d.verdict ? '<button type="button" class="btn" data-verdict="">Clear</button>' : ''}
        <span class="spacer"></span>
        <span id="review-state" class="${dirty ? 'dirty' : 'saved'}">${dirty ? 'Unsaved changes' : tc.review?.at ? `Saved ${esc(fmtDate(tc.review.at))}${tc.review.reviewer ? ` by ${esc(tc.review.reviewer)}` : ''}` : 'Not reviewed yet'}</span>
      </div>
      <div class="review-row">
        <label class="sr-only" for="review-comment">Comment</label>
        <textarea id="review-comment" rows="1" placeholder="Comment for the orchestrator — what to retest, what to file (c)">${esc(d.comment)}</textarea>
        <label class="sr-only" for="reviewer">Reviewer</label>
        <input id="reviewer" placeholder="Reviewer name" value="${esc(storage.get('qa-reviewer'))}" autocomplete="name" />
        <button type="submit" class="btn" data-next="false" ${state.saving ? 'disabled' : ''}>Save</button>
        <button type="submit" class="btn primary" data-next="true" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save &amp; next'} <kbd aria-hidden="true">Ctrl ↵</kbd></button>
      </div>
    </form>`;

  state.lightbox.items = images;
  for (const details of document.querySelectorAll('details.file[open]')) loadFile(details);
  hydrateMarks($('#detail'));
}

async function hydrateMarks(root) {
  const tc = currentCase();
  if (!tc || !state.showMarks) return;
  for (const img of root.querySelectorAll('img[data-annot]')) {
    const marks = tc.annotations?.[img.dataset.annot];
    if (!marks?.items.length) continue;
    try {
      const key = `${state.runId}/${tc.id}/${img.dataset.annot}@${marks.updatedAt}`;
      const url = await annotatedUrl(fileUrl(tc.id, img.dataset.annot), marks.items, key);
      if (img.isConnected) img.src = url;
    } catch {}
  }
}

function draft(tc) {
  if (!state.drafts.has(tc.id))
    state.drafts.set(tc.id, { verdict: tc.review?.verdict || '', comment: tc.review?.comment || '' });
  return state.drafts.get(tc.id);
}

function refreshReviewState(tc) {
  const d = draft(tc);
  const dirty = d.verdict !== (tc.review?.verdict || '') || d.comment !== (tc.review?.comment || '');
  const label = $('#review-state');
  if (!label) return;
  label.className = dirty ? 'dirty' : 'saved';
  label.textContent = dirty ? 'Unsaved changes' : tc.review?.at ? `Saved ${fmtDate(tc.review.at)}` : 'Not reviewed yet';
}

function setVerdict(value) {
  const tc = currentCase();
  if (!tc) return;
  draft(tc).verdict = value;
  document
    .querySelectorAll('.verdict')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.verdict === value)));
  refreshReviewState(tc);
}

async function saveReview(goNext) {
  const tc = currentCase();
  if (!tc || state.saving) return;
  const current = draft(tc);
  const reviewer = $('#reviewer')?.value.trim() || storage.get('qa-reviewer');
  storage.set('qa-reviewer', reviewer);
  state.saving = true;
  renderDetail();
  try {
    await api(`/api/runs/${encodeURIComponent(state.runId)}/review/${encodeURIComponent(tc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: current.verdict || null, comment: current.comment, reviewer }),
    });
    state.drafts.delete(tc.id);
    toast(current.verdict ? `${tc.id} marked ${current.verdict.replace('-', ' ')}` : `${tc.id} review cleared`);
    if (goNext) {
      const order = visibleCases().map((t) => t.id);
      const start = order.indexOf(tc.id);
      const next = [...order.slice(start + 1), ...order.slice(0, start)]
        .map((id) => state.run.testCases.find((t) => t.id === id))
        .find((t) => !t.review?.verdict);
      if (next) state.tcId = next.id;
    }
  } catch (error) {
    toast(`Could not save: ${error.message}`, true);
  } finally {
    state.saving = false;
    await loadRun({ force: true });
    if (goNext) window.scrollTo({ top: 0 });
  }
}

function selectCase(id) {
  state.tcId = id;
  chat.caseChanged();
  setHash();
  renderList();
  renderDetail();
  window.scrollTo({ top: 0 });
  document.querySelector(`.tc-item[data-tc="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function moveCase(delta) {
  const order = visibleCases().map((tc) => tc.id);
  if (!order.length) return;
  const index = order.indexOf(state.tcId);
  selectCase(order[Math.min(Math.max(index + delta, 0), order.length - 1)] || order[0]);
}

async function loadFile(details) {
  const key = `${state.tcId}/${details.dataset.file}`;
  state.openFiles.add(key);
  if (state.fileCache.has(key)) return;
  const pre = details.querySelector('pre');
  try {
    const text = await (await fetch(fileUrl(state.tcId, details.dataset.file), { cache: 'no-store' })).text();
    let shown = text;
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
    state.fileCache.set(key, shown);
    pre.textContent = shown;
  } catch (error) {
    pre.textContent = String(error);
  }
}

function openLightbox(file, { edit = false } = {}) {
  const index = state.lightbox.items.findIndex((i) => i.file === file);
  if (index < 0) return window.open(fileUrl(state.tcId, file), '_blank');
  state.lightbox.index = index;
  state.lightbox.returnFocus = document.activeElement;
  showLightbox();
  if (edit) startEditing();
  else $('#lightbox .lightbox-close').focus();
}

const lightboxFile = () => state.lightbox.items[state.lightbox.index]?.file;
const annotationsUrl = (tcId, file) =>
  `/api/runs/${encodeURIComponent(state.runId)}/annotations/${encodeURIComponent(tcId)}/${encodeURIComponent(file)}`;

async function startEditing() {
  const tc = currentCase();
  const file = lightboxFile();
  if (!tc || !file) return;
  state.editing = true;
  const box = $('#lightbox');
  const host = box.querySelector('.lightbox-editor');
  box.querySelector('.lightbox-body').hidden = true;
  box.querySelector('.lightbox-bar').hidden = true;
  host.hidden = false;
  const editor = await openEditor({
    host,
    src: fileUrl(tc.id, file),
    items: tc.annotations?.[file]?.items || [],
    onSave: async (items) => {
      try {
        await api(annotationsUrl(tc.id, file), {
          method: 'PUT',
          body: JSON.stringify({ items, mode: 'replace', author: 'reviewer', summary: 'edited in the viewer' }),
        });
        toast(`Marks saved on ${file}`);
        stopEditing();
        await loadRun({ force: true });
        showLightbox();
      } catch (error) {
        toast(`Could not save marks: ${error.message}`, true);
      }
    },
    onExport: async (png) => {
      try {
        const url = `/api/runs/${encodeURIComponent(state.runId)}/export/${encodeURIComponent(tc.id)}/${encodeURIComponent(file)}`;
        const result = await api(url, { method: 'POST', body: JSON.stringify({ png }) });
        toast(`Exported ${result.file}`);
      } catch (error) {
        toast(`Could not export: ${error.message}`, true);
      }
    },
    onClose: stopEditing,
  });
  editor.focus();
}

function stopEditing() {
  state.editing = false;
  const box = $('#lightbox');
  const host = box.querySelector('.lightbox-editor');
  host.hidden = true;
  host.innerHTML = '';
  box.querySelector('.lightbox-body').hidden = false;
  box.querySelector('.lightbox-bar').hidden = false;
  box.querySelector('[data-lb="edit"]').focus();
}

function showLightbox() {
  const { items, index } = state.lightbox;
  const item = items[index];
  const box = $('#lightbox');
  const img = box.querySelector('img');
  img.src = fileUrl(state.tcId, item.file);
  img.dataset.annot = item.file;
  img.alt = item.caption || item.file;
  const marks = currentCase()?.annotations?.[item.file]?.items.length || 0;
  box.querySelector('.lightbox-title').textContent =
    `${item.file}${marks ? ` · ${marks} mark${marks > 1 ? 's' : ''}` : ''}`;
  box.querySelector('[data-lb="toggle"]').setAttribute('aria-pressed', String(state.showMarks));
  hydrateMarks(box);
  box.querySelector('figcaption').textContent =
    `${index + 1} / ${items.length} · ${item.file}${item.caption ? ` — ${item.caption}` : ''}`;
  box.hidden = false;
}

function closeLightbox() {
  if (state.editing) stopEditing();
  $('#lightbox').hidden = true;
  state.lightbox.returnFocus?.focus?.();
}

const moveLightbox = (delta) => {
  const { items } = state.lightbox;
  state.lightbox.index = (state.lightbox.index + delta + items.length) % items.length;
  showLightbox();
};

function toast(message, isError = false) {
  const el = $('#toast');
  el.innerHTML = `${icon(isError ? 'warn' : 'pass')}${esc(message)}`;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2400);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storage.set('qa-theme', theme);
  $('#theme').innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
  $('#theme').setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}

function showError(error) {
  $('#detail').innerHTML =
    `<div class="callout">${icon('warn')}<div><strong>Could not reach the viewer server</strong>${esc(error.message)}<br />Run <code>node .claude/skills/run-test-plan/scripts/qa-runs.mjs open</code>.</div></div>`;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => loadRun({ force: true }).catch(showError), 5000);
}

document.addEventListener('click', async (event) => {
  const anchor = event.target.closest('a[href^="#sec-"]');
  if (anchor) {
    event.preventDefault();
    document
      .getElementById(anchor.getAttribute('href').slice(1))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const target = event.target.closest(
    '[data-tc],[data-status],[data-review],[data-verdict],[data-zoom],[data-edit],[data-ask],[data-lb],[data-marks-toggle],[data-mem-action],#open-chat,#open-memory,#refresh,#theme,#shortcuts,.lightbox-close,.lightbox-prev,.lightbox-next',
  );
  if (!target) return;
  if (target.id === 'open-chat') return chat.open();
  if (target.id === 'open-memory') {
    renderMemoryPanel();
    return $('#memory-panel').showModal();
  }
  if (target.dataset.memAction) return memoryAction(target.dataset.mem, target.dataset.memAction);
  if (target.dataset.edit) return openLightbox(target.dataset.edit, { edit: true });
  if (target.dataset.ask) return chat.open({ image: target.dataset.ask });
  if (target.dataset.marksToggle !== undefined || target.dataset.lb === 'toggle') {
    state.showMarks = !state.showMarks;
    storage.set('qa-marks', state.showMarks ? 'on' : 'off');
    renderDetail();
    if (!$('#lightbox').hidden) showLightbox();
    return;
  }
  if (target.dataset.lb === 'edit') return startEditing();
  if (target.dataset.lb === 'ask') {
    const file = lightboxFile();
    closeLightbox();
    return chat.open({ image: file });
  }
  if (target.dataset.tc) selectCase(target.dataset.tc);
  else if (target.dataset.status || target.dataset.review) {
    const [set, key] = target.dataset.status
      ? [state.statusFilter, target.dataset.status]
      : [state.reviewFilter, target.dataset.review];
    set.has(key) ? set.delete(key) : set.add(key);
    renderFilters();
    renderList();
  } else if (target.dataset.verdict !== undefined) setVerdict(target.dataset.verdict);
  else if (target.dataset.zoom) openLightbox(target.dataset.zoom);
  else if (target.id === 'refresh') {
    await loadRuns();
    if (state.view === 'dashboard') await showDashboard();
    else {
      $('#run-select').value = state.runId;
      await loadRun({ force: true });
    }
    toast('Refreshed');
  } else if (target.id === 'theme') applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  else if (target.id === 'shortcuts') $('#help').showModal();
  else if (target.classList.contains('lightbox-close')) closeLightbox();
  else if (target.classList.contains('lightbox-prev')) moveLightbox(-1);
  else if (target.classList.contains('lightbox-next')) moveLightbox(1);
});

document.addEventListener('submit', (event) => {
  if (event.target.classList.contains('question-form')) {
    event.preventDefault();
    return sendAnswer(event.target);
  }
  if (event.target.id !== 'review-form') return;
  event.preventDefault();
  saveReview(event.submitter?.dataset.next === 'true');
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'search') {
    state.query = event.target.value;
    renderList();
  } else if (event.target.id === 'review-comment') {
    const tc = currentCase();
    draft(tc).comment = event.target.value;
    refreshReviewState(tc);
  }
});

document.addEventListener(
  'toggle',
  (event) => {
    const details = event.target;
    if (!details.matches?.('details.file')) return;
    const key = `${state.tcId}/${details.dataset.file}`;
    if (details.open) loadFile(details);
    else state.openFiles.delete(key);
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (state.editing) {
    if (event.key === 'Escape' && !event.target.closest?.('input')) stopEditing();
    return;
  }
  if (!$('#lightbox').hidden) {
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') moveLightbox(-1);
    if (event.key === 'ArrowRight') moveLightbox(1);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.target.closest?.('.question-form')) {
    event.preventDefault();
    return saveReview(true);
  }
  const typing = event.target.closest?.('input, textarea, select, [contenteditable]');
  if (typing) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || $('#help').open || $('#memory-panel').open) return;
  if (event.key === 'g') return void (location.hash = '#/');
  if (state.view !== 'run' && !['m', '?', '/'].includes(event.key)) return;
  const actions = {
    j: () => moveCase(1),
    k: () => moveCase(-1),
    a: () => setVerdict('approved'),
    n: () => setVerdict('needs-retest'),
    r: () => setVerdict('rejected'),
    c: () => $('#review-comment')?.focus(),
    '/': () => $('#search').focus(),
    '?': () => $('#help').showModal(),
    t: () => chat.toggle(),
    m: () => $('#open-memory').click(),
  };
  if (actions[event.key]) {
    event.preventDefault();
    actions[event.key]();
  }
});

window.addEventListener('beforeunload', (event) => {
  const dirty = state.run?.testCases.some((tc) => {
    const d = state.drafts.get(tc.id);
    return d && (d.verdict !== (tc.review?.verdict || '') || d.comment !== (tc.review?.comment || ''));
  });
  if (dirty) event.preventDefault();
});

$('#run-select').addEventListener('change', (event) => {
  location.hash = event.target.value ? `#/run/${encodeURIComponent(event.target.value)}` : '#/';
});

window.addEventListener('hashchange', () => {
  const { runId, tcId } = parseHash();
  if (!runId) {
    if (state.view !== 'dashboard') showDashboard();
  } else if (state.view !== 'run' || runId !== state.runId || tcId !== state.tcId) showRun(runId, tcId);
});

const dashboard = createDashboard({
  host: $('#dashboard'),
  api,
  icon,
  onOpenRun: (runId) => (location.hash = `#/run/${encodeURIComponent(runId)}`),
  onOpenCase: (runId, tcId) => (location.hash = `#/run/${encodeURIComponent(runId)}/tc/${encodeURIComponent(tcId)}`),
});

const chat = createChat({
  api,
  getContext: () => ({ runId: state.runId, tcId: state.tcId }),
  onTurnFinished: () => loadRun({ force: true }).catch(showError),
  toast,
});

(async function start() {
  state.showMarks = storage.get('qa-marks') !== 'off';
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  try {
    await loadRuns();
    const { runId, tcId } = parseHash();
    if (runId && state.runs.some((r) => r.id === runId)) await showRun(runId, tcId);
    else await showDashboard();
  } catch (error) {
    showError(error);
  }
})();
