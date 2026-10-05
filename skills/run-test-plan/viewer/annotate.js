export const COLORS = {
  red: '#ef4444',
  yellow: '#facc15',
  green: '#22c55e',
  blue: '#3b82f6',
  magenta: '#d946ef',
  white: '#ffffff',
};
export const TOOLS = [
  ['select', 'Select / move', 'v'],
  ['arrow', 'Arrow', 'a'],
  ['rect', 'Box', 'b'],
  ['ellipse', 'Ellipse', 'e'],
  ['highlight', 'Highlighter', 'h'],
  ['text', 'Text', 't'],
  ['step', 'Step number', 's'],
  ['spotlight', 'Spotlight (focus)', 'f'],
  ['blur', 'Blur (hide data)', 'x'],
];
const BOX = new Set(['rect', 'ellipse', 'highlight', 'spotlight', 'blur']);
const cache = new Map();

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });

const darkText = (color) => ['#facc15', '#ffffff', '#22c55e'].includes(String(color).toLowerCase());
const unit = (img) => Math.max(1, Math.min(img.width, 2400) / 1100);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Labels try a few spots around their mark and take the first one that doesn't cover another
// label, so two marks close together stay readable.
function tag(ctx, text, spots, color, s, placed, avoid) {
  ctx.save();
  ctx.font = `600 ${Math.round(14 * s)}px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const padX = 8 * s;
  const h = 24 * s;
  const maxW = ctx.canvas.width - 8 * s;
  let label = text;
  while (ctx.measureText(label).width + padX * 2 > maxW && label.length > 4) label = `${label.slice(0, -2)}…`;
  const w = ctx.measureText(label).width + padX * 2;
  const clamp = ({ left, top }) => ({
    x: Math.min(Math.max(4 * s, left), ctx.canvas.width - w - 4 * s),
    y: Math.min(Math.max(4 * s, top), ctx.canvas.height - h - 4 * s),
    w,
    h,
  });
  const overlaps = (r) =>
    [...placed, ...(avoid ? [avoid] : [])].some(
      (o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y,
    );
  const candidates = spots.map((spot) => clamp(spot(w, h)));
  let rect = candidates.find((r) => !overlaps(r));
  for (let step = 1; !rect && step <= 8; step += 1) {
    const nudged = { ...candidates[0], y: candidates[0].y + (step % 2 ? -1 : 1) * Math.ceil(step / 2) * (h + 3 * s) };
    if (nudged.y >= 0 && nudged.y + h <= ctx.canvas.height && !overlaps(nudged)) rect = nudged;
  }
  rect ||= candidates[0];
  placed.push(rect);
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 6 * s;
  ctx.fillStyle = color;
  roundRect(ctx, rect.x, rect.y, w, h, 5 * s);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = darkText(color) ? '#0f172a' : '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, rect.x + padX, rect.y + h / 2 + s);
  ctx.restore();
}

function stroke(ctx, color, s) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5 * s;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 5 * s;
}

function pixelate(ctx, img, { x, y, w, h }) {
  const block = Math.max(6, Math.round(Math.min(w, h) / 6));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w / block));
  small.height = Math.max(1, Math.round(h / block));
  small.getContext('2d').drawImage(img, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

export function draw(ctx, img, items, { selectedId = null, draft = null } = {}) {
  const s = unit(img);
  const all = draft ? [...items, draft] : items;
  const placed = [];
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(img, 0, 0);

  for (const item of all.filter((i) => i.type === 'blur')) pixelate(ctx, img, item);
  const spots = all.filter((i) => i.type === 'spotlight');
  if (spots.length) {
    ctx.save();
    ctx.fillStyle = 'rgba(2,6,23,.62)';
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const spot of spots) ctx.roundRect(spot.x, spot.y, spot.w, spot.h, 8 * s);
    ctx.fill('evenodd');
    ctx.restore();
  }

  for (const item of all) {
    const color = item.color || COLORS.red;
    ctx.save();
    if (item.type === 'highlight') {
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = color;
      ctx.fillRect(item.x, item.y, item.w, item.h);
    } else if (item.type === 'rect') {
      stroke(ctx, color, s);
      roundRect(ctx, item.x, item.y, item.w, item.h, 4 * s);
      ctx.stroke();
    } else if (item.type === 'ellipse') {
      stroke(ctx, color, s);
      ctx.beginPath();
      ctx.ellipse(item.x + item.w / 2, item.y + item.h / 2, item.w / 2, item.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (item.type === 'arrow') {
      const [x1, y1] = item.from;
      const [x2, y2] = item.to;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = 18 * s;
      stroke(ctx, color, s);
      ctx.lineWidth = 4.5 * s;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2 - Math.cos(angle) * head * 0.6, y2 - Math.sin(angle) * head * 0.6);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
      ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (item.type === 'text') {
      ctx.font = `600 ${Math.round(item.size || 18)}px "IBM Plex Sans", "Segoe UI", sans-serif`;
      const pad = 8 * s;
      const w = ctx.measureText(item.text).width + pad * 2;
      const h = (item.size || 18) * 1.6;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 6 * s;
      ctx.fillStyle = color;
      roundRect(ctx, item.x, item.y, w, h, 6 * s);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = darkText(color) ? '#0f172a' : '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.text, item.x + pad, item.y + h / 2 + s);
    } else if (item.type === 'step') {
      const r = 15 * s;
      ctx.shadowColor = 'rgba(0,0,0,.4)';
      ctx.shadowBlur = 5 * s;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 2.5 * s;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = darkText(color) ? '#0f172a' : '#ffffff';
      ctx.font = `700 ${Math.round(15 * s)}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(item.n ?? ''), item.x, item.y + s);
    }
    ctx.restore();

    if (item.label && item.type !== 'text' && item.type !== 'step' && item.type !== 'blur') {
      const gap = 6 * s;
      if (item.type === 'arrow') {
        const [x1, y1] = item.from;
        const up = item.to[1] >= y1;
        tag(
          ctx,
          item.label,
          [
            (w, h) => ({ left: x1 - w / 2, top: up ? y1 - h - gap : y1 + gap }),
            (w, h) => ({ left: x1 - w / 2, top: up ? y1 + gap : y1 - h - gap }),
            (w, h) => ({ left: x1 - w - gap, top: y1 - h / 2 }),
            (w, h) => ({ left: x1 + gap, top: y1 - h / 2 }),
          ],
          color === COLORS.white ? '#0f172a' : color,
          s,
          placed,
        );
      } else {
        const box = { x: item.x, y: item.y, w: item.w, h: item.h };
        tag(
          ctx,
          item.label,
          [
            (w, h) => ({ left: item.x, top: item.y - h - gap }),
            (w, h) => ({ left: item.x + item.w + gap, top: item.y + item.h / 2 - h / 2 }),
            (w, h) => ({ left: item.x, top: item.y + item.h + gap }),
            (w, h) => ({ left: item.x - w - gap, top: item.y + item.h / 2 - h / 2 }),
          ],
          item.type === 'spotlight' ? '#0f172a' : color,
          s,
          placed,
          box,
        );
      }
    }
    if (item.id && item.id === selectedId) {
      const b = bounds(item, s);
      ctx.save();
      ctx.setLineDash([6 * s, 4 * s]);
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(b.x - 4 * s, b.y - 4 * s, b.w + 8 * s, b.h + 8 * s);
      ctx.restore();
    }
  }
}

function bounds(item, s = 1) {
  if (BOX.has(item.type)) return { x: item.x, y: item.y, w: item.w, h: item.h };
  if (item.type === 'arrow') {
    const [x1, y1] = item.from;
    const [x2, y2] = item.to;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 1, h: Math.abs(y2 - y1) || 1 };
  }
  if (item.type === 'step') return { x: item.x - 16 * s, y: item.y - 16 * s, w: 32 * s, h: 32 * s };
  const size = item.size || 18;
  return { x: item.x, y: item.y, w: Math.max(40, String(item.text).length * size * 0.55 + 16), h: size * 1.6 };
}

export async function annotatedUrl(src, items, key) {
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const img = await loadImage(src);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    draw(canvas.getContext('2d'), img, items);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return URL.createObjectURL(blob);
  })();
  cache.set(key, promise);
  return promise;
}

export async function renderToPngBase64(src, items) {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  draw(canvas.getContext('2d'), img, items);
  return canvas.toDataURL('image/png').split(',')[1];
}

// A small ShareX-style editor: pick a tool, drag on the image, Save. Items are kept in image
// pixels so what the reviewer draws and what an agent writes through the CLI are the same data.
export async function openEditor({ host, src, items, onSave, onExport, onClose }) {
  const img = await loadImage(src);
  const s = unit(img);
  const state = {
    tool: 'arrow',
    color: COLORS.red,
    items: structuredClone(items),
    undo: [],
    selected: null,
    drag: null,
    step: 1,
  };
  state.step = Math.max(0, ...state.items.filter((i) => i.type === 'step').map((i) => Number(i.n) || 0)) + 1;

  host.innerHTML = `
    <div class="editor-toolbar" role="toolbar" aria-label="Annotation tools">
      <div class="tool-group">
        ${TOOLS.map(
          ([id, label, key]) =>
            `<button type="button" class="tool" data-tool="${id}" aria-pressed="${id === state.tool}" title="${label} (${key})" aria-label="${label}"><svg class="icon" aria-hidden="true"><use href="#t-${id}" /></svg></button>`,
        ).join('')}
      </div>
      <div class="tool-group" role="group" aria-label="Color">
        ${Object.entries(COLORS)
          .map(
            ([name, hex]) =>
              `<button type="button" class="swatch" data-color="${hex}" aria-pressed="${hex === state.color}" aria-label="${name}" title="${name}" style="--swatch:${hex}"></button>`,
          )
          .join('')}
      </div>
      <label class="label-field"><span class="sr-only">Label or text</span><input id="editor-label" placeholder="Label / text for the next mark" maxlength="140" /></label>
      <div class="tool-group">
        <button type="button" class="icon-btn" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo"><svg class="icon"><use href="#t-undo" /></svg></button>
        <button type="button" class="icon-btn" data-act="delete" title="Delete selected (Del)" aria-label="Delete selected"><svg class="icon"><use href="#t-trash" /></svg></button>
      </div>
      <span class="spacer"></span>
      <button type="button" class="btn" data-act="export" title="Save a flattened PNG to attach to an issue">Export PNG</button>
      <button type="button" class="btn" data-act="cancel">Cancel</button>
      <button type="button" class="btn primary" data-act="save">Save marks</button>
    </div>
    <div class="editor-stage"><canvas aria-label="Screenshot being annotated"></canvas></div>`;

  const canvas = host.querySelector('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  const label = host.querySelector('#editor-label');
  const repaint = (draft) => draw(ctx, img, state.items, { selectedId: state.selected, draft });
  repaint();

  const point = (event) => {
    const r = canvas.getBoundingClientRect();
    return [
      Math.round(((event.clientX - r.left) / r.width) * canvas.width),
      Math.round(((event.clientY - r.top) / r.height) * canvas.height),
    ];
  };
  const commit = (next) => {
    state.undo.push(structuredClone(state.items));
    state.items = next;
    repaint();
  };
  const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const shape = (start, end) => {
    const [x1, y1] = start;
    const [x2, y2] = end;
    const text = label.value.trim();
    const base = { id: newId(), type: state.tool, author: 'reviewer' };
    if (state.tool === 'arrow')
      return { ...base, from: [x1, y1], to: [x2, y2], color: state.color, ...(text && { label: text }) };
    if (state.tool === 'text')
      return text ? { ...base, x: x1, y: y1, text, size: Math.round(18 * s), color: state.color } : null;
    if (state.tool === 'step') return { ...base, x: x1, y: y1, n: state.step, color: state.color };
    const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (box.w < 6 || box.h < 6) return null;
    const colored = state.tool !== 'blur' && state.tool !== 'spotlight';
    return {
      ...base,
      ...box,
      ...(colored && { color: state.color }),
      ...(text && state.tool !== 'blur' && { label: text }),
    };
  };
  const hit = ([x, y]) =>
    [...state.items].reverse().find((item) => {
      const b = bounds(item, s);
      const m = 8 * s;
      return x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m;
    });

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    const p = point(event);
    if (state.tool === 'select') {
      const item = hit(p);
      state.selected = item?.id || null;
      state.drag = item ? { mode: 'move', start: p, original: structuredClone(state.items) } : null;
      repaint();
      return;
    }
    state.drag = { mode: 'draw', start: p };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!state.drag) return;
    const p = point(event);
    if (state.drag.mode === 'draw') {
      const draft = shape(state.drag.start, p);
      repaint(draft);
    } else {
      const dx = p[0] - state.drag.start[0];
      const dy = p[1] - state.drag.start[1];
      state.items = state.drag.original.map((item) => {
        if (item.id !== state.selected) return item;
        if (item.type === 'arrow')
          return { ...item, from: [item.from[0] + dx, item.from[1] + dy], to: [item.to[0] + dx, item.to[1] + dy] };
        return { ...item, x: item.x + dx, y: item.y + dy };
      });
      repaint();
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    const drag = state.drag;
    state.drag = null;
    if (!drag) return;
    if (drag.mode === 'move') {
      state.undo.push(drag.original);
      return;
    }
    const item = shape(drag.start, point(event));
    if (!item) {
      if (state.tool === 'text') label.focus();
      repaint();
      return;
    }
    if (item.type === 'step') state.step += 1;
    if (item.type === 'text') label.value = '';
    commit([...state.items, item]);
  });

  const setTool = (tool) => {
    state.tool = tool;
    host
      .querySelectorAll('[data-tool]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  };
  setTool(state.tool);

  host.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tool) setTool(button.dataset.tool);
    else if (button.dataset.color) {
      state.color = button.dataset.color;
      host
        .querySelectorAll('[data-color]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === state.color)));
      if (state.selected)
        commit(state.items.map((i) => (i.id === state.selected && i.color ? { ...i, color: state.color } : i)));
    } else if (button.dataset.act === 'undo' && state.undo.length) {
      state.items = state.undo.pop();
      repaint();
    } else if (button.dataset.act === 'delete' && state.selected) {
      commit(state.items.filter((i) => i.id !== state.selected));
      state.selected = null;
    } else if (button.dataset.act === 'save') await onSave(state.items);
    else if (button.dataset.act === 'export') await onExport(canvasToBase64());
    else if (button.dataset.act === 'cancel') onClose();
  });

  const canvasToBase64 = () => {
    const previous = state.selected;
    state.selected = null;
    repaint();
    const data = canvas.toDataURL('image/png').split(',')[1];
    state.selected = previous;
    repaint();
    return data;
  };

  const onKey = (event) => {
    if (event.target === label) {
      if (event.key === 'Escape') label.blur();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (state.undo.length) {
        state.items = state.undo.pop();
        repaint();
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected) {
      commit(state.items.filter((i) => i.id !== state.selected));
      state.selected = null;
      return;
    }
    const tool = TOOLS.find(([, , key]) => key === event.key);
    if (tool && !event.ctrlKey && !event.metaKey) setTool(tool[0]);
  };
  host.addEventListener('keydown', onKey);
  return { focus: () => host.querySelector('[data-tool="arrow"]').focus() };
}
