// Home dashboard: how the Test Agents are doing across runs. Everything is aggregated in the
// browser from /api/dashboard, so the range and plan filters re-slice every tile, chart and
// table at once and the numbers always agree with each other.
const SVG = 'http://www.w3.org/2000/svg';
const OUTCOMES = [
  { key: 'pass', label: 'Passed' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'fail', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
];
const EXECUTED = new Set(['pass', 'fail', 'blocked']);
const RANGES = [
  { key: '7', label: '7 days', days: 7 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
];
const DAY = 24 * 60 * 60 * 1000;
const MAX_RUN_COLUMNS = 15;

const el = (tag, attrs = {}, ...children) => {
  const node = attrs.svg ? document.createElementNS(SVG, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'svg' || value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.setAttribute('class', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
};
const svgEl = (tag, attrs = {}, ...children) => el(tag, { ...attrs, svg: true }, ...children);

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const pct = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`);
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtStamp = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Count axes get whole-number ticks only: half a test case is not a thing.
function countAxis(value) {
  const step = Math.max(1, Math.ceil(value / 4));
  const max = Math.max(step, Math.ceil(value / step) * step);
  return { max, ticks: Array.from({ length: max / step + 1 }, (_, i) => i * step) };
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value / 4) * magnitude;
  return Math.ceil(value / step) * step;
}

// A bar's data-end is rounded (4px); its baseline end stays square.
function columnPath(x, y, w, h, roundTop) {
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
}
function barPath(x, y, w, h, roundEnd) {
  const r = roundEnd ? Math.min(4, h / 2, w) : 0;
  return `M${x},${y}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h - r}${r ? `Q${x + w},${y + h} ${x + w - r},${y + h}` : ''}H${x}Z`;
}

export function createDashboard({ host, api, icon, onOpenRun, onOpenCase }) {
  const state = { data: null, range: '30', plan: 'all', variantKey: null, showAllRuns: false };
  const tip = el('div', { class: 'dash-tip', role: 'tooltip', hidden: true });
  document.body.append(tip);

  const iconNode = (name) => {
    const span = el('span', { class: 'icon-wrap', 'aria-hidden': 'true' });
    span.innerHTML = icon(name);
    return span;
  };

  function showTip(event, rows, title) {
    tip.replaceChildren(
      el('div', { class: 'dash-tip-title', text: title }),
      ...rows.map(([key, value, label]) =>
        el(
          'div',
          { class: 'dash-tip-row' },
          key ? el('span', { class: `dash-key k-${key}` }) : null,
          el('strong', { text: value }),
          el('span', { text: label }),
        ),
      ),
    );
    tip.hidden = false;
    const rect = event.target.getBoundingClientRect?.() || { left: 0, top: 0, width: 0 };
    const x = event.clientX ?? rect.left + rect.width / 2;
    const y = event.clientY ?? rect.top;
    const { width, height } = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - width - 12, Math.max(12, x + 14))}px`;
    tip.style.top = `${Math.max(12, y - height - 12)}px`;
  }
  const hideTip = () => (tip.hidden = true);

  function hoverable(node, rows, title, onClick) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', `${title}: ${rows.map((r) => `${r[1]} ${r[2]}`).join(', ')}`);
    node.addEventListener('pointermove', (e) => showTip(e, rows, title));
    node.addEventListener('focus', (e) => showTip(e, rows, title));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('blur', hideTip);
    if (onClick) {
      node.classList.add('clickable');
      node.addEventListener('click', onClick);
      node.addEventListener('keydown', (e) => e.key === 'Enter' && onClick());
    }
    return node;
  }

  async function load() {
    state.data = await api('/api/dashboard');
    render();
  }

  function slice(offsetPeriods = 0) {
    const range = RANGES.find((r) => r.key === state.range);
    const now = Date.now();
    return state.data.runs.filter((run) => {
      if (state.plan !== 'all' && run.planId !== state.plan) return false;
      if (!range.days) return offsetPeriods === 0;
      const age = now - Date.parse(run.createdAt);
      return age >= range.days * DAY * offsetPeriods && age < range.days * DAY * (offsetPeriods + 1);
    });
  }

  function metrics(runs) {
    const cases = runs.flatMap((run) => run.cases.map((c) => ({ ...c, run })));
    const executed = cases.filter((c) => EXECUTED.has(c.status));
    const count = (status) => executed.filter((c) => c.status === status).length;
    const timed = executed.map((c) => c.agentMs).filter((v) => v !== null);
    const reviewed = cases.filter((c) => c.review);
    const waits = cases.filter((c) => c.questions).map((c) => c.waitMs || 0);
    return {
      cases,
      executed: executed.length,
      pass: count('pass'),
      fail: count('fail'),
      blocked: count('blocked'),
      passRate: executed.length ? count('pass') / executed.length : null,
      failRate: executed.length ? count('fail') / executed.length : null,
      blockedRate: executed.length ? count('blocked') / executed.length : null,
      avgMs: mean(timed),
      medianMs: median(timed),
      timed: timed.length,
      estimated: executed.some((c) => c.estimated),
      reviewed: reviewed.length,
      agreement: reviewed.length ? reviewed.filter((c) => c.review === 'approved').length / reviewed.length : null,
      questions: cases.reduce((sum, c) => sum + c.questions, 0),
      avgWaitMs: mean(waits),
      warnings: cases.reduce((sum, c) => sum + (c.warnings ? 1 : 0), 0),
      defects: cases.reduce((sum, c) => sum + c.defects, 0),
    };
  }

  function delta(current, previous, { kind, upIsGood }) {
    if (current === null || previous === null || state.range === 'all' || !state.comparable) return null;
    const diff = current - previous;
    if (diff === 0) return { text: `no change vs previous ${RANGES.find((r) => r.key === state.range).label}`, tone: 'flat' };
    if (kind === 'pts' && Math.abs(diff) < 0.005) return { text: 'no change', tone: 'flat' };
    if (kind === 'ms' && Math.abs(diff) < 1000) return { text: 'no change', tone: 'flat' };
    const up = diff > 0;
    const text =
      kind === 'pts'
        ? `${up ? '▲' : '▼'} ${Math.abs(Math.round(diff * 100))} pts`
        : kind === 'ms'
          ? `${up ? '▲' : '▼'} ${fmtDuration(Math.abs(diff))}`
          : `${up ? '▲' : '▼'} ${Math.abs(diff)}`;
    return { text: `${text} vs previous ${RANGES.find((r) => r.key === state.range).label}`, tone: up === upIsGood ? 'good' : 'bad' };
  }

  function tile({ label, value, sub, delta: d, hero, iconName }) {
    return el(
      'div',
      { class: `kpi${hero ? ' kpi-hero' : ''}` },
      el('div', { class: 'kpi-label' }, iconName ? iconNode(iconName) : null, el('span', { text: label })),
      el('div', { class: 'kpi-value', text: value }),
      d ? el('div', { class: `kpi-delta d-${d.tone}`, text: d.text }) : null,
      sub ? el('div', { class: 'kpi-sub', text: sub }) : null,
    );
  }

  function card(title, subtitle, body, table, { wide = false } = {}) {
    return el(
      'figure',
      { class: `dash-card${wide ? ' wide' : ''}` },
      el('figcaption', {}, el('h3', { text: title }), subtitle ? el('p', { text: subtitle }) : null),
      body,
      table ? el('details', { class: 'table-view' }, el('summary', { text: 'Show data' }), table) : null,
    );
  }

  function dataTable(headers, rows) {
    return el(
      'table',
      { class: 'dash-table' },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.map((cell) => el('td', { text: cell }))))),
    );
  }

  function legend(keys) {
    return el(
      'ul',
      { class: 'dash-legend' },
      OUTCOMES.filter((o) => keys.includes(o.key)).map((o) =>
        el('li', {}, el('span', { class: `dash-swatch k-${o.key}` }), iconNode(o.key), el('span', { text: o.label })),
      ),
    );
  }

  function outcomesByRun(runs) {
    const shown = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RUN_COLUMNS);
    const W = 960;
    const H = 200;
    const pad = { top: 12, right: 8, bottom: 28, left: 32 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const { max, ticks } = countAxis(Math.max(...shown.map((r) => r.cases.length), 1));
    const band = plotW / shown.length;
    const barW = Math.min(24, band * 0.6);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dash-chart', role: 'img', 'aria-label': `Outcomes of the last ${shown.length} runs` });
    for (const value of ticks) {
      const y = pad.top + plotH - (value / max) * plotH;
      svg.append(
        svgEl('line', { x1: pad.left, x2: W - pad.right, y1: y, y2: y, class: value ? 'grid' : 'baseline' }),
        svgEl('text', { x: pad.left - 8, y: y + 4, class: 'tick', 'text-anchor': 'end', text: String(value) }),
      );
    }
    let lastDay = '';
    shown.forEach((run, i) => {
      const cx = pad.left + band * i + band / 2;
      const x = cx - barW / 2;
      const counts = Object.fromEntries(OUTCOMES.map((o) => [o.key, run.cases.filter((c) => c.status === o.key).length]));
      const segments = OUTCOMES.filter((o) => counts[o.key]);
      let y = pad.top + plotH;
      segments.forEach((o, s) => {
        const h = (counts[o.key] / max) * plotH;
        const gap = s < segments.length - 1 ? 2 : 0;
        svg.append(svgEl('path', { d: columnPath(x, y - h + gap, barW, Math.max(0, h - gap), s === segments.length - 1), class: `mark k-${o.key}` }));
        y -= h;
      });
      const day = fmtDay(run.createdAt);
      if (day !== lastDay) svg.append(svgEl('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle', text: day }));
      lastDay = day;
      const rows = OUTCOMES.filter((o) => counts[o.key]).map((o) => [o.key, String(counts[o.key]), o.label]);
      const pending = run.cases.length - Object.values(counts).reduce((a, b) => a + b, 0);
      if (pending) rows.push([null, String(pending), 'In progress']);
      svg.append(
        hoverable(
          svgEl('rect', { x: cx - band / 2, y: pad.top, width: band, height: plotH, class: 'hit' }),
          rows,
          `${run.label || run.title} · ${fmtStamp(run.createdAt)}`,
          () => onOpenRun(run.id),
        ),
      );
    });
    const present = OUTCOMES.filter((o) => shown.some((r) => r.cases.some((c) => c.status === o.key))).map((o) => o.key);
    return card(
      'Outcomes by run',
      `Last ${shown.length} run${shown.length > 1 ? 's' : ''} in range. Select a column to open the run.`,
      el('div', {}, legend(present), svg),
      dataTable(
        ['Run', 'Started', ...OUTCOMES.map((o) => o.label)],
        shown.map((r) => [r.label || r.id, fmtStamp(r.createdAt), ...OUTCOMES.map((o) => String(r.cases.filter((c) => c.status === o.key).length))]),
      ),
      { wide: true },
    );
  }

  function timeByRun(runs) {
    const shown = [...runs]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((run) => {
        const times = run.cases.filter((c) => EXECUTED.has(c.status) && c.agentMs !== null).map((c) => c.agentMs);
        return { run, avg: mean(times), median: median(times), n: times.length, wait: run.cases.reduce((s, c) => s + (c.waitMs || 0), 0) };
      })
      .filter((r) => r.n)
      .slice(-MAX_RUN_COLUMNS);
    if (!shown.length) return card('Agent time per case', 'No timed cases in range yet.', el('p', { class: 'dash-empty', text: 'Timing starts with the next run.' }));
    const W = 420;
    const H = 220;
    const pad = { top: 18, right: 8, bottom: 28, left: 52 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const max = niceMax(Math.max(...shown.map((r) => r.avg)) / 60000) * 60000;
    const band = plotW / shown.length;
    const barW = Math.min(24, band * 0.6);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dash-chart', role: 'img', 'aria-label': 'Average agent time per case, by run' });
    for (let i = 0; i <= 4; i += 1) {
      const value = (max / 4) * i;
      const y = pad.top + plotH - (value / max) * plotH;
      svg.append(
        svgEl('line', { x1: pad.left, x2: W - pad.right, y1: y, y2: y, class: i ? 'grid' : 'baseline' }),
        svgEl('text', { x: pad.left - 8, y: y + 4, class: 'tick', 'text-anchor': 'end', text: fmtDuration(value) }),
      );
    }
    let lastDay = '';
    shown.forEach((r, i) => {
      const cx = pad.left + band * i + band / 2;
      const h = (r.avg / max) * plotH;
      svg.append(svgEl('path', { d: columnPath(cx - barW / 2, pad.top + plotH - h, barW, h, true), class: 'mark k-series' }));
      if (i === shown.length - 1)
        svg.append(svgEl('text', { x: cx, y: pad.top + plotH - h - 6, class: 'value-label', 'text-anchor': 'middle', text: fmtDuration(r.avg) }));
      const day = fmtDay(r.run.createdAt);
      if (day !== lastDay) svg.append(svgEl('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle', text: day }));
      lastDay = day;
      svg.append(
        hoverable(
          svgEl('rect', { x: cx - band / 2, y: pad.top, width: band, height: plotH, class: 'hit' }),
          [
            ['series', fmtDuration(r.avg), 'average per case'],
            [null, fmtDuration(r.median), 'median'],
            [null, String(r.n), `case${r.n > 1 ? 's' : ''} timed`],
            ...(r.wait ? [[null, fmtDuration(r.wait), 'waiting for a human (excluded)']] : []),
          ],
          `${r.run.label || r.run.title} · ${fmtStamp(r.run.createdAt)}`,
          () => onOpenRun(r.run.id),
        ),
      );
    });
    return card(
      'Agent time per case',
      'Average per run, excluding time spent waiting for your answers.',
      svg,
      dataTable(['Run', 'Average', 'Median', 'Cases timed'], shown.map((r) => [r.run.label || r.run.id, fmtDuration(r.avg), fmtDuration(r.median), String(r.n)])),
    );
  }

  function outcomesByVariant(cases) {
    const keys = [...new Set(cases.flatMap((c) => Object.keys(c.variants)))];
    if (!keys.length) return null;
    const key = keys.includes(state.variantKey) ? state.variantKey : keys[0];
    const label = (k) => state.data.config?.variants?.[k]?.label || k;
    const groups = new Map();
    for (const c of cases.filter((c) => EXECUTED.has(c.status) || c.status === 'skipped')) {
      const value = c.variants[key] ?? 'Not set';
      groups.set(value, [...(groups.get(value) || []), c]);
    }
    const rows = [...groups].map(([value, list]) => {
      const counts = Object.fromEntries(OUTCOMES.map((o) => [o.key, list.filter((c) => c.status === o.key).length]));
      const executed = counts.pass + counts.fail + counts.blocked;
      return { value, counts, total: list.length, rate: executed ? counts.pass / executed : null };
    });
    rows.sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2) || b.total - a.total);
    const rowH = 30;
    const W = 420;
    const labelW = 72;
    const valueW = 48;
    const barMax = W - labelW - valueW;
    const H = rows.length * rowH + 8;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dash-chart', role: 'img', 'aria-label': `Outcomes by ${label(key)}` });
    rows.forEach((row, i) => {
      const y = 4 + i * rowH;
      const barH = 16;
      const by = y + (rowH - barH) / 2;
      svg.append(svgEl('text', { x: labelW - 10, y: by + 12, class: 'cat-label', 'text-anchor': 'end', text: row.value }));
      const segments = OUTCOMES.filter((o) => row.counts[o.key]);
      let x = labelW;
      segments.forEach((o, s) => {
        const w = (row.counts[o.key] / row.total) * barMax;
        const gap = s < segments.length - 1 ? 2 : 0;
        svg.append(svgEl('path', { d: barPath(x, by, Math.max(0, w - gap), barH, s === segments.length - 1), class: `mark k-${o.key}` }));
        x += w;
      });
      svg.append(svgEl('text', { x: W - 4, y: by + 12, class: 'value-label', 'text-anchor': 'end', text: pct(row.rate) }));
      svg.append(
        hoverable(
          svgEl('rect', { x: 0, y, width: W, height: rowH, class: 'hit' }),
          [...segments.map((o) => [o.key, String(row.counts[o.key]), o.label]), [null, pct(row.rate), 'pass rate']],
          `${label(key)}: ${row.value}`,
        ),
      );
    });
    const picker =
      keys.length > 1
        ? el(
            'label',
            { class: 'dash-inline-select' },
            el('span', { text: 'Group by' }),
            el(
              'select',
              { onchange: (e) => ((state.variantKey = e.target.value), render()) },
              keys.map((k) => el('option', { value: k, text: label(k), selected: k === key })),
            ),
          )
        : null;
    return card(
      `Outcomes by ${label(key).toLowerCase()}`,
      'Share of cases per outcome; the figure on the right is the pass rate.',
      el('div', {}, picker, legend(OUTCOMES.filter((o) => rows.some((r) => r.counts[o.key])).map((o) => o.key)), svg),
      dataTable([label(key), ...OUTCOMES.map((o) => o.label), 'Pass rate'], rows.map((r) => [r.value, ...OUTCOMES.map((o) => String(r.counts[o.key])), pct(r.rate)])),
    );
  }

  function caseHistory(cases) {
    const byCase = new Map();
    for (const c of [...cases].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt))) {
      const key = `${c.run.planId}/${c.id}`;
      byCase.set(key, [...(byCase.get(key) || []), c]);
    }
    return [...byCase.values()];
  }

  function attentionTable(cases) {
    const rows = caseHistory(cases)
      .map((history) => {
        const done = history.filter((c) => EXECUTED.has(c.status));
        const latest = done.at(-1);
        const flaky = new Set(done.map((c) => c.status)).size > 1;
        return { history: done, latest, flaky };
      })
      .filter((r) => r.latest && (r.latest.status !== 'pass' || r.flaky))
      .sort((a, b) => b.latest.run.createdAt.localeCompare(a.latest.run.createdAt))
      .slice(0, 8);
    const body = rows.length
      ? el(
          'table',
          { class: 'dash-table' },
          el('thead', {}, el('tr', {}, ['Case', 'Latest', 'History', 'Why'].map((h) => el('th', { scope: 'col', text: h })))),
          el(
            'tbody',
            {},
            rows.map((r) =>
              el(
                'tr',
                { class: 'clickable', tabindex: '0', onclick: () => onOpenCase(r.latest.run.id, r.latest.id), onkeydown: (e) => e.key === 'Enter' && onOpenCase(r.latest.run.id, r.latest.id) },
                el('td', {}, el('span', { class: 'mono', text: r.latest.id }), el('div', { class: 'dash-muted', text: r.latest.title })),
                el('td', {}, el('span', { class: `dash-status s-${r.latest.status}` }, iconNode(r.latest.status), el('span', { text: OUTCOMES.find((o) => o.key === r.latest.status).label }))),
                el('td', {}, el('span', { class: 'dash-history' }, r.history.slice(-6).map((c) => el('span', { class: `dash-dot k-${c.status}`, title: `${c.status} · ${fmtStamp(c.run.createdAt)}` })))),
                el('td', { text: r.flaky ? 'Changes between runs' : r.latest.status === 'blocked' ? 'Environment or data' : 'Product behaviour' }),
              ),
            ),
          ),
        )
      : el('p', { class: 'dash-empty' }, iconNode('pass'), el('span', { text: 'Every case passed on its latest run, with no flip-flopping.' }));
    return card('Cases that need attention', 'Failing or blocked on their latest run, or changing outcome between runs.', body);
  }

  function slowestTable(cases) {
    const rows = caseHistory(cases)
      .map((history) => {
        const times = history.filter((c) => c.agentMs !== null && EXECUTED.has(c.status)).map((c) => c.agentMs);
        return { c: history.at(-1), avg: mean(times), n: times.length };
      })
      .filter((r) => r.n)
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 5);
    const body = rows.length
      ? el(
          'table',
          { class: 'dash-table' },
          el('thead', {}, el('tr', {}, ['Case', 'Avg agent time', 'Runs'].map((h) => el('th', { scope: 'col', text: h })))),
          el(
            'tbody',
            {},
            rows.map((r) =>
              el(
                'tr',
                { class: 'clickable', tabindex: '0', onclick: () => onOpenCase(r.c.run.id, r.c.id), onkeydown: (e) => e.key === 'Enter' && onOpenCase(r.c.run.id, r.c.id) },
                el('td', {}, el('span', { class: 'mono', text: r.c.id }), el('div', { class: 'dash-muted', text: r.c.title })),
                el('td', { class: 'num', text: fmtDuration(r.avg) }),
                el('td', { class: 'num', text: String(r.n) }),
              ),
            ),
          ),
        )
      : el('p', { class: 'dash-empty', text: 'No timed cases yet.' });
    return card('Slowest cases', 'Where agents spend the most time, averaged across runs.', body);
  }

  function recentRuns(runs) {
    const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const shown = state.showAllRuns ? sorted : sorted.slice(0, 10);
    const rows = shown.map((run) => {
      const m = metrics([run]);
      const counts = OUTCOMES.map((o) => [o.key, run.cases.filter((c) => c.status === o.key).length]);
      const reviewed = run.cases.filter((c) => c.review).length;
      const open = () => onOpenRun(run.id);
      return el(
        'tr',
        { class: 'clickable', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() },
        el('td', {}, el('div', { class: 'run-title', text: run.title }), el('div', { class: 'dash-muted mono', text: `${run.id}${run.label ? ` · ${run.label}` : ''}` })),
        el('td', { class: 'nowrap', text: fmtStamp(run.createdAt) }),
        el(
          'td',
          {},
          el(
            'span',
            { class: 'mini-bar', role: 'img', 'aria-label': counts.filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'pending' },
            counts.filter(([, n]) => n).map(([k, n]) => el('span', { class: `k-${k}`, style: `flex-grow:${n}` })),
          ),
          el('span', { class: 'dash-muted nowrap', text: ` ${run.cases.length} case${run.cases.length > 1 ? 's' : ''}` }),
        ),
        el('td', { class: 'num', text: pct(m.passRate) }),
        el('td', { class: 'num', text: fmtDuration(m.avgMs) }),
        el('td', { class: 'num', text: `${reviewed}/${run.cases.length}` }),
      );
    });
    return el(
      'section',
      { class: 'dash-recent', 'aria-labelledby': 'recent-title' },
      el('div', { class: 'dash-section-head' }, el('h2', { id: 'recent-title', text: 'Recent test runs' }), el('span', { class: 'dash-muted', text: `${runs.length} in range` })),
      runs.length
        ? el(
            'table',
            { class: 'dash-table runs' },
            el('thead', {}, el('tr', {}, ['Run', 'Started', 'Outcome', 'Pass rate', 'Avg per case', 'Reviewed'].map((h) => el('th', { scope: 'col', text: h })))),
            el('tbody', {}, rows),
          )
        : el('p', { class: 'dash-empty', text: 'No runs in this range.' }),
      sorted.length > 10
        ? el('button', { type: 'button', class: 'btn', onclick: () => ((state.showAllRuns = !state.showAllRuns), render()), text: state.showAllRuns ? 'Show fewer' : `Show all ${sorted.length}` })
        : null,
    );
  }

  function filters() {
    const plans = [...new Map(state.data.runs.map((r) => [r.planId, r.title])).entries()];
    return el(
      'div',
      { class: 'dash-filters' },
      el(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Date range' },
        RANGES.map((r) =>
          el('button', { type: 'button', 'aria-pressed': String(state.range === r.key), onclick: () => ((state.range = r.key), render()), text: r.label }),
        ),
      ),
      el(
        'label',
        { class: 'dash-inline-select' },
        el('span', { text: 'Plan' }),
        el(
          'select',
          { onchange: (e) => ((state.plan = e.target.value), render()) },
          el('option', { value: 'all', text: 'All plans', selected: state.plan === 'all' }),
          plans.map(([id, title]) => el('option', { value: id, text: `${id} — ${title}`, selected: state.plan === id })),
        ),
      ),
    );
  }

  function render() {
    hideTip();
    const runs = slice(0);
    const now = metrics(runs);
    const before = metrics(slice(1));
    state.comparable = before.executed > 0;
    const memory = state.data.memory || {};
    const rangeLabel = RANGES.find((r) => r.key === state.range).label.toLowerCase();
    const kpis = el(
      'div',
      { class: 'kpis' },
      tile({
        label: 'Pass rate',
        value: pct(now.passRate),
        sub: `${now.pass} of ${now.executed} executed case${now.executed === 1 ? '' : 's'}`,
        delta: delta(now.passRate, before.passRate, { kind: 'pts', upIsGood: true }),
        hero: true,
        iconName: 'pass',
      }),
      tile({
        label: 'Failed',
        value: String(now.fail),
        sub: now.executed ? `${pct(now.failRate)} of executed · ${now.defects} defect${now.defects === 1 ? '' : 's'} reported` : 'Nothing executed',
        delta: delta(now.fail, before.fail, { kind: 'count', upIsGood: false }),
        iconName: 'fail',
      }),
      tile({
        label: 'Blocked',
        value: String(now.blocked),
        sub: now.executed ? `${pct(now.blockedRate)} · environment or data, not the product` : 'Nothing executed',
        delta: delta(now.blocked, before.blocked, { kind: 'count', upIsGood: false }),
        iconName: 'blocked',
      }),
      tile({
        label: 'Avg agent time per case',
        value: fmtDuration(now.avgMs),
        sub: now.timed ? `median ${fmtDuration(now.medianMs)} · ${now.timed} timed${now.estimated ? ' · some estimated' : ''}` : 'No timed cases yet',
        delta: delta(now.avgMs, before.avgMs, { kind: 'ms', upIsGood: false }),
        iconName: 'running',
      }),
      tile({
        label: 'Reviewer agreement',
        value: pct(now.agreement),
        sub: now.reviewed ? `${now.reviewed} reviewed · approved as reported` : 'No reviews yet',
        iconName: 'approved',
      }),
      tile({
        label: 'Questions to you',
        value: String(now.questions),
        sub: `${now.questions ? `avg answer ${fmtDuration(now.avgWaitMs)} · ` : ''}memory reused ${memory.reused || 0}× overall`,
        iconName: 'question',
      }),
    );
    const grid = el('div', { class: 'dash-grid' }, outcomesByRun(runs), timeByRun(runs), outcomesByVariant(now.cases), attentionTable(now.cases), slowestTable(now.cases));
    host.replaceChildren(
      el('div', { class: 'dash-head' }, el('div', {}, el('h1', { text: 'Test agents' }), el('p', { class: 'dash-muted', text: `${runs.length} run${runs.length === 1 ? '' : 's'} · ${now.cases.length} cases · ${rangeLabel}` })), filters()),
      runs.length ? kpis : null,
      runs.length ? grid : el('p', { class: 'dash-empty', text: 'No runs in this range. Widen the range or start a run with qa-runs.mjs init.' }),
      recentRuns(runs),
    );
  }

  return { load, render, hide: hideTip };
}
