// Screenshot annotations (ShareX-style arrows, boxes, text, step numbers, spotlight, blur).
// They live next to the image as `<image>.annotations.json` and never touch the original pixels:
// the viewer draws them on a canvas, so an annotation can be edited or removed at any time.
//
// Coordinates are image pixels. A Test Agent that captured the screenshot with `scale: 'css'`
// can pass an element's boundingBox() as `box`; normalize() turns it into the shape's geometry.
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './lib.mjs';

export const ANNOTATION_TYPES = ['rect', 'ellipse', 'arrow', 'text', 'step', 'highlight', 'spotlight', 'blur'];
export const COLORS = {
  red: '#ef4444',
  yellow: '#facc15',
  green: '#22c55e',
  blue: '#3b82f6',
  magenta: '#d946ef',
  white: '#ffffff',
};
const BOX_TYPES = new Set(['rect', 'ellipse', 'highlight', 'spotlight', 'blur']);
const MAX_ITEMS = 60;

export const sidecarPath = (evidenceDir, image) => join(evidenceDir, `${image}.annotations.json`);
export const isSidecar = (file) => file.endsWith('.annotations.json');

export function readAnnotations(evidenceDir, image) {
  const data = readJson(sidecarPath(evidenceDir, image));
  if (!data || data.__parseError)
    return { schemaVersion: 1, image, items: [], elements: {}, history: [], error: data?.__parseError };
  return { schemaVersion: 1, image, items: [], elements: {}, history: [], ...data };
}

const num = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
const color = (value) => COLORS[value] || (/^#[0-9a-f]{3,8}$/i.test(value || '') ? value : COLORS.red);
const boxOf = (item) => {
  const b = item.box;
  if (!b) return null;
  const pad = num(item.pad) ?? 6;
  return { x: num(b.x) - pad, y: num(b.y) - pad, w: num(b.width ?? b.w) + pad * 2, h: num(b.height ?? b.h) + pad * 2 };
};

// Accepts the loose shapes agents write (a `box` from boundingBox(), color names, missing ids)
// and returns the strict geometry the viewer draws. Throws with a readable message otherwise.
export function normalize(item, index, author) {
  if (!ANNOTATION_TYPES.includes(item.type))
    throw new Error(`item ${index}: type must be one of ${ANNOTATION_TYPES.join(', ')}`);
  const out = { id: item.id || `a${Date.now().toString(36)}${index}`, type: item.type, author: item.author || author };
  const box = boxOf(item);
  if (item.type !== 'blur' && item.type !== 'spotlight') out.color = color(item.color);
  if (item.label) out.label = String(item.label).slice(0, 140);

  if (BOX_TYPES.has(item.type)) {
    const g = box || { x: num(item.x), y: num(item.y), w: num(item.w), h: num(item.h) };
    if ([g.x, g.y, g.w, g.h].some((v) => v == null) || g.w <= 0 || g.h <= 0)
      throw new Error(`item ${index}: ${item.type} needs x, y, w, h or a box`);
    return { ...out, x: Math.max(0, g.x), y: Math.max(0, g.y), w: g.w, h: g.h };
  }
  if (item.type === 'arrow') {
    let to = Array.isArray(item.to) ? item.to.map(num) : null;
    if (box) to = [box.x, box.y + Math.round(box.h / 2)];
    if (!to || to.some((v) => v == null)) throw new Error(`item ${index}: arrow needs "to": [x, y] or a box`);
    let from = Array.isArray(item.from) ? item.from.map(num) : null;
    if (!from) {
      const dx = to[0] > 160 ? -130 : 130;
      from = [to[0] + dx, Math.max(12, to[1] - 80)];
    }
    return { ...out, from, to };
  }
  if (item.type === 'text') {
    const text = String(item.text || item.label || '').slice(0, 280);
    if (!text) throw new Error(`item ${index}: text needs "text"`);
    const at = box ? { x: box.x, y: Math.max(4, box.y - 40) } : { x: num(item.x), y: num(item.y) };
    if (at.x == null || at.y == null) throw new Error(`item ${index}: text needs x, y or a box`);
    delete out.label;
    return { ...out, x: at.x, y: at.y, text, size: num(item.size) || 18 };
  }
  if (item.type === 'step') {
    const at = box ? { x: box.x - 4, y: box.y - 4 } : { x: num(item.x), y: num(item.y) };
    if (at.x == null || at.y == null) throw new Error(`item ${index}: step needs x, y or a box`);
    return { ...out, x: Math.max(14, at.x), y: Math.max(14, at.y), n: num(item.n) || index + 1 };
  }
  return out;
}

// mode: 'append' adds to what is there, 'replace' swaps the whole list. Every write keeps a short
// history line so a reviewer can see who changed a screenshot and why.
export function writeAnnotations(
  evidenceDir,
  image,
  { items = [], elements, mode = 'append', author = 'agent', summary = '' },
) {
  if (!existsSync(join(evidenceDir, image))) throw new Error(`no image "${image}" in evidence/`);
  const current = readAnnotations(evidenceDir, image);
  const incoming = (Array.isArray(items) ? items : [items]).map((item, i) => normalize(item, i, author));
  const next = mode === 'replace' ? incoming : [...current.items, ...incoming];
  if (next.length > MAX_ITEMS) throw new Error(`too many annotations (${next.length} > ${MAX_ITEMS})`);
  const size = imageSize(join(evidenceDir, image));
  const data = {
    schemaVersion: 1,
    image,
    width: size?.width ?? current.width ?? null,
    height: size?.height ?? current.height ?? null,
    items: next,
    elements: { ...(current.elements || {}), ...(elements || {}) },
    updatedAt: new Date().toISOString(),
    history: [
      ...(current.history || []).slice(-19),
      {
        at: new Date().toISOString(),
        author,
        mode,
        count: incoming.length,
        summary: String(summary || '').slice(0, 200),
      },
    ],
  };
  writeJson(sidecarPath(evidenceDir, image), data);
  return data;
}

export function removeAnnotations(evidenceDir, image, ids, author = 'chat') {
  const current = readAnnotations(evidenceDir, image);
  const drop = new Set(ids);
  const items = ids.length ? current.items.filter((item) => !drop.has(item.id)) : [];
  writeJson(sidecarPath(evidenceDir, image), {
    ...current,
    items,
    updatedAt: new Date().toISOString(),
    history: [
      ...(current.history || []).slice(-19),
      { at: new Date().toISOString(), author, mode: 'remove', count: current.items.length - items.length },
    ],
  });
  return items;
}

// PNG width/height straight from the IHDR chunk, so the CLI can tell an agent the canvas size
// without an image library.
export function imageSize(file) {
  if (!/\.png$/i.test(file) || !existsSync(file)) return null;
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(24);
    readSync(fd, header, 0, 24, 0);
    if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}
