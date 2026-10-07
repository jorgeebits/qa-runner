// Who runs what, decided by code instead of by the orchestrator's judgment, so every run is
// routed the same way and the orchestrator only launches what `next` prints.
//
// - Batches: a group's cases (one login, one set of variants), cut into chunks of at most
//   `execution.maxCasesPerAgent`, because every turn re-reads the agent's whole context and a
//   long group makes the last cases the most expensive. Chunks of one group run in order.
// - Tiers: each case is classified simple / standard / complex from the plan alone, and the
//   tier picks the model and effort. A batch takes its hardest case's tier.
// - Slots and accounts: up to `maxParallel` batches run at once, one per browser in the pool.
//   When the app allows one session per user (`sessions: "exclusive"`), each running batch needs
//   its own account, so the account pool caps the parallelism too.
// - Escalation: a case a cheaper model reports as failed, blocked or thin is re-run once by the
//   standard tier before a human sees it, so a model's mistake never reaches review as a defect.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_PREFIX, POOL_SIZE, agentBody, agentType } from './agents.mjs';
import { CONFIG, displayPath, readJson, runDir, tcDir, writeJson } from './lib.mjs';

export const TIERS = ['simple', 'standard', 'complex'];
const DEFAULT_ROUTES = {
  simple: { model: 'haiku', effort: 'medium' },
  standard: { model: 'sonnet', effort: 'medium' },
  complex: { model: 'sonnet', effort: 'high' },
};
const ESCALATION = 'standard';

export const execution = () => {
  const e = CONFIG.execution || {};
  return {
    maxParallel: Math.max(1, Math.min(Number(e.maxParallel) || POOL_SIZE, POOL_SIZE)),
    maxCasesPerAgent: Math.max(1, Number(e.maxCasesPerAgent) || 3),
    sessions: e.sessions === 'shared' ? 'shared' : 'exclusive',
    accounts: Array.isArray(e.accounts) ? e.accounts.filter((a) => a?.user) : [],
    routes: Object.fromEntries(TIERS.map((t) => [t, { ...DEFAULT_ROUTES[t], ...(e.tiers?.[t] || {}) }])),
    escalate: e.escalate !== false,
  };
};

const scheduleFile = (runId) => join(runDir(runId), 'schedule.json');
export const readSchedule = (runId) => readJson(scheduleFile(runId), null);
const writeSchedule = (runId, schedule) => writeJson(scheduleFile(runId), schedule);

// Verbs that change data, in English and Spanish: a case that creates, pays or deletes needs a
// model that notices when the app did something subtly wrong, and a mistake there is costly.
const WRITES =
  /\b(create|add|save|submit|pay|sell|buy|purchase|checkout|delete|remove|update|edit|void|refund|cancel|approve|post|transfer|crear|agregar|añadir|guardar|enviar|pagar|vender|comprar|eliminar|borrar|actualizar|editar|anular|reembols\w*|cancelar|aprobar|registrar|transferir)\b/i;

// history: earlier statuses of this case in the same plan, newest first.
export function classify(tc, plan, history = []) {
  const override = tc.agent?.complexity || plan.defaults?.agent?.complexity;
  if (TIERS.includes(override)) return { tier: override, reasons: ['set in the plan'] };
  const tags = (tc.tags || []).map((t) => String(t).toLowerCase());
  const steps = tc.steps || [];
  const text = steps.map((s) => `${s.action} ${s.expected || ''}`).join(' ');
  const writes = tags.includes('writes') || (!tags.includes('readonly') && !tags.includes('read-only') && WRITES.test(text));
  const referenceAlways = (tc.referenceCheck || plan.defaults?.referenceCheck) === 'always';
  const unstable = history.slice(0, 3).some((s) => s === 'fail' || s === 'rejected');
  const complex = [
    referenceAlways && 'always checks the reference app',
    steps.length > 10 && `${steps.length} steps`,
    unstable && 'failed or was rejected recently',
  ].filter(Boolean);
  if (complex.length) return { tier: 'complex', reasons: complex };
  const record = tc.record || plan.defaults?.record;
  const standard = [
    writes && 'changes data',
    steps.length > 6 && `${steps.length} steps`,
    record && 'records video',
    (tc.tool || plan.defaults?.tool || 'playwright-mcp') !== 'playwright-mcp' && 'non-default tool',
  ].filter(Boolean);
  if (standard.length) return { tier: 'standard', reasons: standard };
  return { tier: 'simple', reasons: [`${steps.length} read-only step${steps.length === 1 ? '' : 's'}`] };
}

// The plan may pin a model or effort for one case or for all; that beats the tier's route.
function routeFor(tier, cases, plan, routes) {
  const pinned = (key) => cases.map((tc) => tc.agent?.[key]).find(Boolean) || plan.defaults?.agent?.[key];
  return { model: pinned('model') || routes[tier].model, effort: pinned('effort') || routes[tier].effort };
}

const rank = (tier) => TIERS.indexOf(tier);
const sameVariants = (a = {}, b = {}) => Object.entries(a).every(([k, v]) => b[k] === undefined || b[k] === v);

export function buildSchedule(plan, testCases, histories = new Map()) {
  const ex = execution();
  const classified = new Map(testCases.map((tc) => [tc.id, classify(tc, plan, histories.get(tc.id))]));
  const groups = new Map();
  for (const tc of testCases) groups.set(tc.group || tc.id, [...(groups.get(tc.group || tc.id) || []), tc]);
  const batches = [];
  for (const [group, cases] of groups)
    for (let i = 0; i < cases.length; i += ex.maxCasesPerAgent) {
      const chunk = cases.slice(i, i + ex.maxCasesPerAgent);
      const tier = chunk.map((tc) => classified.get(tc.id).tier).sort((a, b) => rank(b) - rank(a))[0];
      const playwright = chunk.every((tc) => (tc.tool || plan.defaults?.tool || 'playwright-mcp') === 'playwright-mcp');
      batches.push({
        id: cases.length > ex.maxCasesPerAgent ? `${group}#${i / ex.maxCasesPerAgent + 1}` : group,
        group,
        cases: chunk.map((tc) => tc.id),
        tier,
        ...routeFor(tier, chunk, plan, ex.routes),
        variants: chunk[0].variants || {},
        user: chunk[0].environment?.user || plan.environment?.user || null,
        serial: chunk.some((tc) => (tc.tags || []).includes('serial')),
        pool: playwright,
        state: 'pending',
      });
    }
  return {
    createdAt: new Date().toISOString(),
    sessions: ex.sessions,
    maxParallel: ex.maxParallel,
    cases: Object.fromEntries([...classified].map(([id, c]) => [id, c])),
    batches,
  };
}

export function saveSchedule(runId, schedule) {
  writeSchedule(runId, schedule);
}

// Accounts come from .qa/config.json, or the plan's login when there is no pool. An account
// with variants only serves batches with the same variants (a store-bound user, say).
function accountsFor(batch) {
  const { accounts } = execution();
  const pool = accounts.length ? accounts : batch.user ? [{ user: batch.user }] : [{ user: null }];
  return pool.filter((a) => sameVariants(a.variants, batch.variants));
}

function passwordSlot(account) {
  if (!account.user) return 'the login and password the human gave you';
  return `user ${account.user}, password {{PASSWORD${account.secret ? ` ${account.secret}` : ` for ${account.user}`}}}`;
}

function batchPrompt(runId, batch, account, fallback) {
  const lines = [
    `Run these test cases in order, in one browser session (run \`${runId}\`):`,
    ...batch.cases.map((id) => `- ${id}: ${displayPath(join(tcDir(runId, id), 'brief.md'))}`),
    '',
    `Login: ${passwordSlot(account)}. Never write the password to a file.`,
  ];
  return fallback ? `${agentBody(FALLBACK_PREFIX)}\n\n---\n\n${lines.join('\n')}` : lines.join('\n');
}

// Picks the next batch that can start now, or says why none can. `fallback` means the plugin's
// agents are not available: one general-purpose agent at a time on the shared `playwright` server.
export function nextLaunch(runId, { fallback = false } = {}) {
  const schedule = readSchedule(runId);
  if (!schedule) throw new Error(`run ${runId} has no schedule.json; run init again`);
  const running = schedule.batches.filter((b) => b.state === 'running');
  const pending = schedule.batches.filter((b) => b.state === 'pending');
  if (!pending.length) return { kind: running.length ? 'wait' : 'done', running };
  const limit = fallback ? 1 : schedule.maxParallel;
  if (running.length >= limit) return { kind: 'wait', running, why: `${running.length} of ${limit} slot(s) busy` };
  const busySlots = new Set(running.map((b) => b.slot));
  const busyUsers = new Set(running.map((b) => b.account?.user).filter(Boolean));
  const busyGroups = new Set(running.map((b) => b.group));
  const serialBusy = running.some((b) => b.serial);
  const blockedBy = [];
  for (const batch of pending) {
    // Chunks of a group keep their order: a later chunk may rely on what an earlier one did.
    const earlier = schedule.batches.find((b) => b.group === batch.group && b !== batch && b.state !== 'done');
    if (busyGroups.has(batch.group) || (earlier && schedule.batches.indexOf(earlier) < schedule.batches.indexOf(batch))) continue;
    if (batch.serial && serialBusy) continue;
    if (!fallback && !batch.pool && running.length) continue;
    const account = accountsFor(batch).find((a) => schedule.sessions === 'shared' || !a.user || !busyUsers.has(a.user));
    if (!account) {
      blockedBy.push(`${batch.id} waits for a free account`);
      continue;
    }
    const slot = Array.from({ length: limit }, (_, i) => i + 1).find((s) => !busySlots.has(s));
    const usePool = !fallback && batch.pool;
    Object.assign(batch, {
      state: 'running',
      slot,
      account: { user: account.user, ...(account.secret && { secret: account.secret }) },
      agent: usePool ? agentType(slot) : 'general-purpose',
      startedAt: new Date().toISOString(),
    });
    writeSchedule(runId, schedule);
    return { kind: 'launch', batch, prompt: batchPrompt(runId, batch, account, !usePool) };
  }
  if (!running.length && pending.length)
    throw new Error(`no batch can start: ${blockedBy.join('; ') || 'check execution.accounts variants in .qa/config.json'}`);
  return { kind: 'wait', running, why: blockedBy.join('; ') || 'waiting for running batches' };
}

// done: the agent notified. pending: its agent died; only `cases` (the unfinished ones) run again.
export function finishBatch(runId, batchId, state = 'done', cases = null) {
  const schedule = readSchedule(runId);
  const batch = schedule?.batches.find((b) => b.id === batchId);
  if (!batch) throw new Error(`unknown batch ${batchId} in run ${runId}`);
  if (state === 'done') batch.finishedAt = new Date().toISOString();
  else {
    if (batch.cases.length !== cases?.length) {
      const finished = { ...batch, id: `${batch.id}~done`, cases: batch.cases.filter((id) => !cases.includes(id)), state: 'done' };
      schedule.batches.splice(schedule.batches.indexOf(batch), 0, finished);
      batch.cases = cases;
    }
    for (const key of ['slot', 'account', 'agent', 'startedAt']) delete batch[key];
  }
  batch.state = state;
  writeSchedule(runId, schedule);
  return batch;
}

// Moves a case's first attempt aside so the re-run starts clean and the viewer shows the
// verdict that a human will review; the first attempt stays on disk for comparison.
function archiveAttempt(runId, tcId) {
  const base = tcDir(runId, tcId);
  const attempts = join(base, 'attempts');
  const n = existsSync(attempts) ? readdirSync(attempts).length + 1 : 1;
  const into = join(attempts, String(n));
  mkdirSync(into, { recursive: true });
  for (const name of ['result.json', 'progress.json', 'timing.json', 'evidence'])
    if (existsSync(join(base, name))) renameSync(join(base, name), join(into, name));
  mkdirSync(join(base, 'evidence'), { recursive: true });
}

// Cases a cheaper model finished with an outcome a human would have to double-check get one
// re-run on the standard tier. Idempotent: a case escalates at most once.
export function escalate(run) {
  const schedule = readSchedule(run.id);
  if (!schedule || !execution().escalate) return [];
  const route = execution().routes[ESCALATION];
  const byId = new Map(run.testCases.map((tc) => [tc.id, tc]));
  const added = [];
  for (const batch of schedule.batches.filter((b) => b.state === 'done' && b.model === 'haiku' && !b.escalated)) {
    const redo = batch.cases
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((tc) => ({ tc, why: escalationReason(tc) }))
      .filter((x) => x.why);
    batch.escalated = true;
    if (!redo.length) continue;
    for (const { tc } of redo) archiveAttempt(run.id, tc.id);
    const next = {
      ...batch,
      id: `${batch.id}~esc`,
      cases: redo.map((x) => x.tc.id),
      tier: ESCALATION,
      model: route.model,
      effort: route.effort,
      escalatedFrom: { batch: batch.id, model: batch.model, reasons: Object.fromEntries(redo.map((x) => [x.tc.id, x.why])) },
      state: 'pending',
      escalated: true,
    };
    for (const key of ['slot', 'account', 'agent', 'startedAt', 'finishedAt']) delete next[key];
    schedule.batches.push(next);
    added.push(next);
  }
  writeSchedule(run.id, schedule);
  return added;
}

function escalationReason(tc) {
  if (tc.status === 'fail') return 'reported fail';
  if (tc.status === 'blocked' && tc.result?.blockedReason !== 'needs-input') return 'reported blocked';
  if (['pending', 'running'].includes(tc.status)) return 'did not finish';
  if (tc.warnings.length) return `${tc.warnings.length} contract warning(s)`;
  return null;
}
