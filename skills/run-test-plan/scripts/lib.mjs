// Shared helpers for the run-test-plan CLI and viewer server: paths, run I/O, and the contract
// checks that keep the Test Agent's result.json honest against the plan it was briefed from.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The plugin lives in Claude Code's plugin cache, so everything a run writes is anchored to the
// project being tested, never to where the plugin is installed. Agents' shells wander (a `cd`
// for a screenshot), so briefs pass --project explicitly; otherwise the nearest folder holding
// .qa/ wins, then the working directory.
export const PROJECT_ROOT = resolveProject();

function resolveProject() {
  const flag = process.argv.indexOf('--project');
  if (flag > 1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  if (process.env.QA_PROJECT_DIR) return resolve(process.env.QA_PROJECT_DIR);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.qa'))) return dir;
    if (dirname(dir) === dir) return process.cwd();
  }
}
export const CONFIG_FILE = join(PROJECT_ROOT, '.qa', 'config.json');

export const RESULT_STATUSES = ['pass', 'fail', 'blocked', 'skipped'];
export const STEP_STATUSES = ['pass', 'fail', 'blocked', 'skipped', 'n/a'];
export const REVIEW_VERDICTS = ['approved', 'rejected', 'needs-retest'];
export const EVIDENCE_KINDS = ['screenshot', 'video', 'network', 'json', 'log', 'text'];

export const readJson = (file, fallback = null) => {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    return { __parseError: String(error.message) };
  }
};

export const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

const DEFAULT_CONFIG = {
  runsDir: '.qa/runs',
  plansDir: '.qa/plans',
  viewerPort: 4321,
  tracker: null,
  targets: { app: 'App under test', reference: 'Reference app' },
  variants: {},
  capabilities: {},
};

function loadConfig() {
  const raw = readJson(CONFIG_FILE, {});
  if (raw?.__parseError) throw new Error(`${CONFIG_FILE} is not valid JSON: ${raw.__parseError}`);
  return { ...DEFAULT_CONFIG, ...raw };
}

export const CONFIG = loadConfig();
export const RUNS_DIR = resolve(PROJECT_ROOT, process.env.QA_RUNS_DIR || CONFIG.runsDir);
export const PLANS_DIR = resolve(PROJECT_ROOT, CONFIG.plansDir);
export const PORT = Number(process.env.QA_VIEWER_PORT || CONFIG.viewerPort);

// Paths inside the project are shown relative (short, portable briefs); plugin files live
// outside it and are shown absolute so an agent can still open them.
export function displayPath(path) {
  const rel = relative(PROJECT_ROOT, path);
  const shown = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
  return shown.split(sep).join('/');
}

export const issueUrl = (key) =>
  key && CONFIG.tracker?.issueUrl ? CONFIG.tracker.issueUrl.replace('{key}', encodeURIComponent(key)) : null;

// Plans and results are read as schemaVersion 2. Version 1 files (written before the runner was
// generic) are mapped on load, so old runs keep rendering without being rewritten on disk.
export function normalizePlan(plan) {
  if (!plan || plan.__parseError || plan.schemaVersion >= 2) return plan;
  const { pos3Url, pos2Url, employee, ...environment } = plan.environment || {};
  const { parityCheck, ...defaults } = plan.defaults || {};
  return {
    ...plan,
    schemaVersion: 2,
    issue: plan.issue ?? plan.jira,
    environment: {
      ...environment,
      targets: { ...(pos3Url && { app: pos3Url }), ...(pos2Url && { reference: pos2Url }) },
      ...(employee && { user: employee }),
    },
    defaults: { ...defaults, ...(parityCheck && { referenceCheck: parityCheck }) },
    testCases: (plan.testCases || []).map(({ territory, store, parityCheck: check, ...tc }) => ({
      ...tc,
      variants: { ...(territory && { territory }), ...(store && { store }), ...tc.variants },
      ...(check && { referenceCheck: check }),
    })),
  };
}

export function normalizeResult(result) {
  if (!result || result.__parseError || result.schemaVersion >= 2) return result;
  const { pos3Version, serverVersion, store, territory, ...environment } = result.environment || {};
  const { parity, ...rest } = result;
  return {
    ...rest,
    schemaVersion: 2,
    environment: {
      ...environment,
      versions: { ...(pos3Version && { app: pos3Version }), ...(serverVersion && { server: serverVersion }) },
      variants: { ...(territory && { territory }), ...(store && { store }) },
    },
    defects: (result.defects || []).map(({ pos2Parity, jira, ...d }) => ({
      ...d,
      ...(pos2Parity && { reference: pos2Parity }),
      ...((d.issue ?? jira) && { issue: d.issue ?? jira }),
    })),
    ...(parity && { reference: parity }),
  };
}

export const runDir = (runId) => safeJoin(RUNS_DIR, runId);
export const tcDir = (runId, tcId) => safeJoin(runDir(runId), 'tc', tcId);

// Every path that comes from a URL or CLI argument goes through here, so a crafted id cannot
// escape the runs folder.
export function safeJoin(base, ...parts) {
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`Path escapes ${base}`);
  return target;
}

export const isRunDir = (dir) => existsSync(join(dir, 'plan.json'));

export function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((name) => isRunDir(join(RUNS_DIR, name)))
    .map((id) => {
      const meta = readJson(join(RUNS_DIR, id, 'meta.json'), {});
      const plan = readJson(join(RUNS_DIR, id, 'plan.json'), {});
      return {
        id,
        planId: plan.id,
        title: plan.title,
        label: meta.label,
        createdAt: meta.createdAt || statSync(join(RUNS_DIR, id)).mtime.toISOString(),
        counts: countStatuses(loadRun(id)),
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function loadRun(runId) {
  const dir = runDir(runId);
  const plan = normalizePlan(readJson(join(dir, 'plan.json'), {}));
  const meta = readJson(join(dir, 'meta.json'), {});
  const review = readJson(join(dir, 'review.json'), {});
  const executed = executedBy(readJson(join(dir, 'schedule.json'), null));
  const testCases = (plan.testCases || []).map((tc) => {
    const base = join(dir, 'tc', tc.id);
    const result = normalizeResult(readJson(join(base, 'result.json')));
    const progress = readJson(join(base, 'progress.json'));
    const questions = readJson(join(base, 'questions.json'), []);
    const evidenceDir = join(base, 'evidence');
    const all = existsSync(evidenceDir)
      ? readdirSync(evidenceDir).filter((f) => !f.startsWith('.') && statSync(join(evidenceDir, f)).isFile())
      : [];
    const files = all.filter((f) => !f.endsWith('.annotations.json'));
    const annotations = Object.fromEntries(
      all
        .filter((f) => f.endsWith('.annotations.json'))
        .map((f) => [f.slice(0, -'.annotations.json'.length), readJson(join(evidenceDir, f), {})])
        .filter(([image, data]) => files.includes(image) && !data.__parseError)
        .map(([image, data]) => [
          image,
          { items: data.items || [], updatedAt: data.updatedAt, history: data.history || [] },
        ]),
    );
    const status = result && !result.__parseError ? result.status : progress?.state || 'pending';
    const timing = caseTiming(base, result, progress, questions, files, evidenceDir);
    return {
      ...tc,
      status,
      result,
      progress,
      questions,
      timing,
      files,
      annotations,
      review: review[tc.id] || null,
      executedBy: executed[tc.id] || null,
      warnings: [
        ...checkContract(tc, result, files, meta, evidenceDir, plan),
        ...(result?.blockedReason === 'needs-input' && !questions.length
          ? ['blocked for missing input, but no question was asked (use `ask`).']
          : []),
      ],
    };
  });
  return { id: runId, plan, meta, testCases, config: viewerConfig() };
}

// Which model produced each verdict, from the run's schedule.json (written by init, kept by the
// scheduler, never by an agent), and whether the verdict comes from an escalated re-run.
function executedBy(schedule) {
  const by = {};
  for (const batch of schedule?.batches || [])
    for (const id of batch.cases)
      if (batch.state !== 'pending')
        by[id] = {
          model: batch.model,
          effort: batch.effort,
          tier: batch.tier,
          ...(batch.escalatedFrom && { escalatedFrom: batch.escalatedFrom.model, reason: batch.escalatedFrom.reasons?.[id] }),
        };
  return by;
}

// What the viewer needs from the project config to label things; nothing else leaves the server.
export const viewerConfig = () => ({
  trackerName: CONFIG.tracker?.name || null,
  issueUrl: CONFIG.tracker?.issueUrl || null,
  targets: CONFIG.targets,
  variants: CONFIG.variants,
});

// Agents rarely fill startedAt/finishedAt, so the runner keeps its own clock: `mark running`
// writes timing.json and the result file's mtime closes the case. Runs from before timing.json
// get an estimate from the first progress mark, question or screenshot, flagged as such.
// Time spent waiting on a human answer is split out, so slow humans don't read as slow agents.
function caseTiming(base, result, progress, questions, files, evidenceDir) {
  if (!result || result.__parseError) return null;
  const resultFile = join(base, 'result.json');
  const finished = Date.parse(result.finishedAt || '') || statSync(resultFile).mtimeMs;
  let started = Date.parse(result.startedAt || readJson(join(base, 'timing.json'), {})?.startedAt || '');
  let estimated = false;
  if (!started) {
    const candidates = [
      progress?.at,
      ...questions.map((q) => q.askedAt),
      ...files.map((f) => statSync(join(evidenceDir, f)).mtimeMs),
    ]
      .map((t) => (typeof t === 'number' ? t : Date.parse(t || '')))
      .filter((t) => t && t < finished);
    if (!candidates.length) return null;
    started = Math.min(...candidates);
    estimated = true;
  }
  const waitMs = questions.reduce((sum, q) => {
    const asked = Date.parse(q.askedAt);
    const answered = Math.min(Date.parse(q.answeredAt || '') || finished, finished);
    return sum + Math.max(0, answered - asked);
  }, 0);
  const durationMs = Math.max(0, finished - started);
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs,
    waitMs,
    agentMs: Math.max(0, durationMs - waitMs),
    estimated,
  };
}

// Everything the dashboard aggregates, one compact row per case, so filtering by date range or
// plan happens in the browser without another round trip.
export function dashboardData() {
  return listRuns()
    .map(({ id }) => loadRun(id))
    .map((run) => ({
      id: run.id,
      planId: run.plan.id,
      title: run.plan.title,
      label: run.meta.label || null,
      createdAt: run.meta.createdAt,
      retestOf: run.meta.retestOf || null,
      cases: run.testCases.map((tc) => ({
        id: tc.id,
        title: tc.title,
        group: tc.group || null,
        status: tc.status,
        model: tc.executedBy?.model || null,
        tier: tc.executedBy?.tier || null,
        escalated: Boolean(tc.executedBy?.escalatedFrom),
        variants: tc.variants || {},
        agentMs: tc.timing?.agentMs ?? null,
        waitMs: tc.timing?.waitMs ?? null,
        estimated: tc.timing?.estimated ?? null,
        review: tc.review?.verdict || null,
        warnings: tc.warnings.length,
        questions: (tc.questions || []).length,
        defects: (tc.result?.defects || []).length,
      })),
    }));
}

export function countStatuses(run) {
  const counts = { total: 0, pass: 0, fail: 0, blocked: 0, skipped: 0, running: 0, pending: 0 };
  for (const tc of run.testCases) {
    counts.total += 1;
    counts[tc.status] = (counts[tc.status] || 0) + 1;
  }
  return counts;
}

// The contract between the plan and the Test Agent. Warnings are shown in the viewer next to the
// result, so a reviewer sees a thin or inconsistent report before trusting its verdict.
export function checkContract(tc, result, files, meta = {}, evidenceDir = null, plan = {}) {
  if (!result) return [];
  if (result.__parseError) return [`result.json is not valid JSON: ${result.__parseError}`];
  const warnings = [];
  const fileSet = new Set(files);
  if (result.testCaseId !== tc.id) warnings.push(`testCaseId "${result.testCaseId}" does not match "${tc.id}".`);
  if (!RESULT_STATUSES.includes(result.status))
    warnings.push(`status "${result.status}" is not one of ${RESULT_STATUSES.join(', ')}.`);
  if (!result.summary?.trim()) warnings.push('summary is empty.');

  const resultSteps = new Map((result.steps || []).map((s) => [Number(s.n), s]));
  for (const step of tc.steps || []) {
    const actual = resultSteps.get(Number(step.n));
    if (!actual) {
      if (['pass', 'fail'].includes(result.status)) warnings.push(`step ${step.n} has no reported result.`);
      continue;
    }
    if (!STEP_STATUSES.includes(actual.status)) warnings.push(`step ${step.n} status "${actual.status}" is invalid.`);
    if (['pass', 'fail'].includes(actual.status) && !(actual.evidence || []).length && step.evidenceRequired !== false)
      warnings.push(`step ${step.n} is ${actual.status} without evidence.`);
  }

  const referenced = new Set([
    ...(result.evidence || []).map((e) => e.file),
    ...(result.steps || []).flatMap((s) => s.evidence || []),
  ]);
  for (const file of referenced) if (!fileSet.has(file)) warnings.push(`evidence "${file}" is referenced but missing.`);

  if (result.status === 'fail' && !(result.defects || []).length && !result.notes?.trim())
    warnings.push('status is fail but no defect or note explains it.');
  if ((tc.record || meta.recordAll) && !files.some((f) => /\.(mp4|webm)$/i.test(f)))
    warnings.push('a recording was requested but no video is in evidence/.');
  if ((tc.referenceCheck || plan.defaults?.referenceCheck) === 'always' && !result.reference?.checked)
    warnings.push('the plan requires a check against the reference app.');
  if (evidenceDir) warnings.push(...scanForSecrets(evidenceDir, files));
  return warnings;
}

const SECRET_KEY = /"(password|passwd|pwd|pin|token|authorization)"\s*:\s*"(?!\*|\[?redacted|<redacted|\s*")[^"]{1,}"/i;

function scanForSecrets(evidenceDir, files) {
  const found = [];
  for (const file of files.filter((f) => /\.(json|txt|log|md)$/i.test(f))) {
    const path = join(evidenceDir, file);
    if (!existsSync(path)) continue;
    if (SECRET_KEY.test(readFileSync(path, 'utf8'))) found.push(`"${file}" seems to contain an unredacted secret.`);
  }
  return found;
}

export const stamp = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};
