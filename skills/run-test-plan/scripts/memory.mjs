// Memory for Test Agents: facts a human confirmed once (a value, a workaround, a quirk of the
// environment) that later runs reuse instead of asking again. One Markdown file per memory, so a
// project's memories can be reviewed in pull requests like any other file. Header values are
// JSON, which keeps the format unambiguous without a YAML dependency.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG, PROJECT_ROOT, safeJoin } from './lib.mjs';

export const MEMORY_DIRS = {
  project: resolve(PROJECT_ROOT, CONFIG.memory?.dir || '.qa/memory'),
  user: resolve(process.env.QA_USER_MEMORY_DIR || join(homedir(), '.claude', 'qa-memory')),
};
export const KINDS = ['data', 'procedure', 'env-quirk', 'gotcha'];
export const MEMORY_STATUSES = ['proposed', 'active', 'stale'];
export const BRIEF_LIMIT = Number(CONFIG.memory?.briefLimit || 10);
const FIELDS = ['id', 'kind', 'status', 'scope', 'triggers', 'value', 'secretRef', 'source', 'stats', 'expires'];
const MAX_FAILURES = 2;
const SECRET_WORDS = /\b(pass(word|wd)?|contrase\S*|pin|token|secret|api[-_ ]?key|otp)\b/i;
const CARD_NUMBER = /\b\d{13,19}\b/;
const STOPWORDS = new Set(
  'the and for with that this from into when then than your you are was were has have not but all any can may must its'
    .split(' ')
    .concat('las los del con para por una uno que como cuando debe este esta sin sus'.split(' ')),
);

const today = () => new Date().toISOString().slice(0, 10);
export const isExpired = (entry) => Boolean(entry.expires && entry.expires < today());

function parse(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const entry = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const raw = line.slice(colon + 1).trim();
    try {
      entry[line.slice(0, colon).trim()] = JSON.parse(raw);
    } catch {
      entry[line.slice(0, colon).trim()] = raw;
    }
  }
  entry.text = match[2].trim();
  return entry;
}

function serialize(entry) {
  const header = FIELDS.filter((key) => entry[key] !== undefined && entry[key] !== null).map(
    (key) => `${key}: ${JSON.stringify(entry[key])}`,
  );
  return `---\n${header.join('\n')}\n---\n${entry.text}\n`;
}

export function loadMemories({ all = false } = {}) {
  const entries = [];
  for (const [share, dir] of Object.entries(MEMORY_DIRS)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => /^m-[\w-]+\.md$/.test(f))) {
      const entry = parse(readFileSync(join(dir, name), 'utf8'));
      if (entry?.id) entries.push({ ...entry, share, file: join(dir, name) });
    }
  }
  return all ? entries : entries.filter((e) => e.status === 'active' && !isExpired(e));
}

export const findMemory = (id) => loadMemories({ all: true }).find((e) => e.id === id);

// Secrets never live in memory: a value that looks like one is refused, and the caller is told
// to store an environment-variable reference instead.
export function checkSafe({ text = '', triggers = [], value }) {
  if (value === undefined || value === null || value === '') return null;
  if (SECRET_WORDS.test(`${text} ${triggers.join(' ')}`))
    return 'this looks like a secret; store it as --secret-ref env:NAME instead of a value';
  if (CARD_NUMBER.test(String(value))) return 'the value looks like a card or account number; use synthetic data';
  return null;
}

export function addMemory(input, share = 'project') {
  if (!MEMORY_DIRS[share]) throw new Error(`share must be ${Object.keys(MEMORY_DIRS).join(' or ')}`);
  const kind = input.kind || 'data';
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const text = String(input.text || '').trim();
  if (!text) throw new Error('a memory needs a description (text)');
  const triggers = (input.triggers || []).map((t) => String(t).trim()).filter(Boolean);
  if (input.value && input.secretRef) throw new Error('use either a value or a secretRef, not both');
  if (input.secretRef && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(input.secretRef))
    throw new Error('secretRef must look like env:NAME');
  const unsafe = checkSafe({ text, triggers, value: input.value });
  if (unsafe) throw new Error(unsafe);
  const status = input.status || 'active';
  if (!MEMORY_STATUSES.includes(status)) throw new Error(`status must be one of ${MEMORY_STATUSES.join(', ')}`);

  const id = `m-${today().replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
  const entry = {
    id,
    kind,
    status,
    scope: input.scope && Object.keys(input.scope).length ? input.scope : undefined,
    triggers: triggers.length ? triggers : undefined,
    value: input.value || undefined,
    secretRef: input.secretRef || undefined,
    source: { ...input.source, at: new Date().toISOString() },
    stats: { used: 0, failed: 0 },
    expires: input.expires || undefined,
    text,
  };
  mkdirSync(MEMORY_DIRS[share], { recursive: true });
  writeFileSync(safeJoin(MEMORY_DIRS[share], `${id}.md`), serialize(entry));
  return { ...entry, share };
}

export function updateMemory(id, patch) {
  const entry = findMemory(id);
  if (!entry) throw new Error(`unknown memory ${id}`);
  const next = { ...entry, ...patch };
  writeFileSync(entry.file, serialize(next));
  return next;
}

export function removeMemory(id) {
  const entry = findMemory(id);
  if (!entry) throw new Error(`unknown memory ${id}`);
  rmSync(entry.file);
  return entry;
}

// A memory that keeps failing is probably out of date (test data gets consumed, a user gets
// locked), so it stops being offered until a human looks at it.
export function recordUse(id, ok) {
  const entry = findMemory(id);
  if (!entry) throw new Error(`unknown memory ${id}`);
  const stats = { used: 0, failed: 0, ...entry.stats };
  stats.used += 1;
  stats.lastUsed = today();
  if (!ok) stats.failed += 1;
  const status = stats.failed >= MAX_FAILURES ? 'stale' : entry.status;
  return updateMemory(id, { stats, status });
}

const tokenize = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

function applies(entry, { variants = {}, target } = {}) {
  for (const [key, value] of Object.entries(entry.scope?.variants || {}))
    if (variants[key] !== undefined && variants[key] !== value) return false;
  return !(entry.scope?.target && target && entry.scope.target !== target);
}

// Lexical scoring is enough for a few hundred short memories and needs no index or model:
// rare shared words weigh more (IDF), a trigger phrase found verbatim weighs most, and a memory
// scoped to the case's exact variants beats a general one. Briefing a case also includes the
// environment quirks scoped to its variants, even without shared words: they apply to any step.
export function rank(query, context = {}, { limit = 5, entries = loadMemories(), includeQuirks = false } = {}) {
  const candidates = entries.filter((e) => applies(e, context));
  const docs = candidates.map((e) => new Set(tokenize(`${e.text} ${(e.triggers || []).join(' ')}`)));
  const df = new Map();
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) || 0) + 1);
  const queryTokens = new Set(tokenize(query));
  const queryText = String(query || '').toLowerCase();
  return candidates
    .map((entry, i) => {
      let score = 0;
      for (const token of queryTokens)
        if (docs[i].has(token)) score += Math.log(1 + candidates.length / df.get(token));
      for (const trigger of entry.triggers || []) if (queryText.includes(trigger.toLowerCase())) score += 3;
      const scoped = Object.keys(entry.scope?.variants || {}).filter((k) => context.variants?.[k] !== undefined);
      if (score > 0) score += scoped.length * 0.5;
      else if (includeQuirks && entry.kind === 'env-quirk' && scoped.length) score = 0.5;
      return { entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function caseQuery(tc) {
  return [
    tc.title,
    tc.expected,
    tc.notes,
    ...(tc.tags || []),
    ...(tc.preconditions || []),
    ...Object.keys(tc.data || {}),
    ...(tc.steps || []).flatMap((s) => [s.action, s.expected]),
  ]
    .filter(Boolean)
    .join(' ');
}

export function pointer(entry) {
  const first = entry.text.split('\n')[0].slice(0, 110);
  const value = entry.secretRef
    ? ` → secret \`${entry.secretRef}\` (the orchestrator puts it in your prompt)`
    : entry.value && String(entry.value).length <= 80
      ? ` → \`${entry.value}\``
      : entry.value
        ? ' → value: run `memory show`'
        : '';
  return `- \`${entry.id}\` (${entry.kind}) ${first}${value}`;
}

export function scanMemories() {
  const warnings = [];
  for (const entry of loadMemories({ all: true })) {
    const unsafe = checkSafe(entry);
    if (unsafe) warnings.push(`memory ${entry.id} (${entry.share}): ${unsafe}.`);
    if (entry.status === 'active' && isExpired(entry)) warnings.push(`memory ${entry.id} expired on ${entry.expires}.`);
  }
  return warnings;
}

export function prune({ dryRun = true } = {}) {
  const doomed = loadMemories({ all: true }).filter((e) => e.status === 'stale' || isExpired(e));
  if (!dryRun) for (const entry of doomed) rmSync(entry.file);
  return doomed;
}
