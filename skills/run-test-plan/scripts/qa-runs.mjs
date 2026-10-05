#!/usr/bin/env node
// run-test-plan CLI. One entry point for the orchestrator and the Test Agents:
//
//   init <plan.json> [--label txt] [--record] [--only TC-1,TC-2] [--retest <runId>]
//        Freeze the plan into a new run folder and write one brief per test case.
//   open [runId]              Start the viewer server if needed and open it in the browser.
//   serve                     Run the viewer server in the foreground.
//   mark <runId> <tcId> <running|pending> [note]
//                             Live progress the viewer shows before result.json exists.
//   validate <runId>          Check every result against the contract; writes run.json.
//   status <runId>            One line per test case (cheap for the orchestrator's context).
//   latest                    Print the newest run id.
//   annotate <runId> <tcId> <image> [--list] [--add '<json>'] [--replace] [--remove <ids|all>]
//            [--author agent|chat|reviewer] [--summary txt]
//                             Read or change a screenshot's annotations (arrows, boxes, text…).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { imageSize, readAnnotations, removeAnnotations, writeAnnotations } from './annotations.mjs';
import {
  CONFIG,
  PORT,
  PROJECT_ROOT,
  SKILL_DIR,
  countStatuses,
  displayPath,
  listRuns,
  loadRun,
  normalizePlan,
  readJson,
  runDir,
  stamp,
  tcDir,
  writeJson,
} from './lib.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    flags[key] = next && !next.startsWith('--') ? ((i += 1), next) : true;
  } else args.push(rest[i]);
}

const repoPath = displayPath;
const fail = (message) => {
  console.error(`ERROR ${message}`);
  process.exit(1);
};

const commands = { init, open, serve, mark, validate, status, latest, annotate };
if (!commands[command]) {
  console.log(
    readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 17)
      .join('\n')
      .replace(/^\/\/ ?/gm, ''),
  );
  process.exit(command ? 1 : 0);
}
await commands[command]();

async function init() {
  const planFile = args[0] && resolve(args[0]);
  if (!planFile || !existsSync(planFile)) fail('init needs an existing plan file.');
  const plan = normalizePlan(readJson(planFile));
  if (!plan || plan.__parseError) fail(`plan is not valid JSON: ${plan?.__parseError}`);
  const problems = checkPlan(plan);
  if (problems.length) fail(`plan has problems:\n- ${problems.join('\n- ')}`);

  let selected = plan.testCases;
  if (flags.only) {
    const only = new Set(String(flags.only).split(','));
    selected = selected.filter((tc) => only.has(tc.id));
  }
  if (flags.retest) {
    const previous = loadRun(flags.retest);
    const redo = new Set(
      previous.testCases
        .filter(
          (tc) =>
            ['fail', 'blocked', 'pending', 'running'].includes(tc.status) ||
            ['rejected', 'needs-retest'].includes(tc.review?.verdict),
        )
        .map((tc) => tc.id),
    );
    selected = selected.filter((tc) => redo.has(tc.id));
  }
  if (!selected.length) fail('no test case left to run after filtering.');

  const runId = `${plan.id}_${stamp()}`;
  const dir = runDir(runId);
  if (existsSync(dir)) fail(`run ${runId} already exists; run init again.`);
  mkdirSync(dir, { recursive: true });
  const frozen = { ...plan, testCases: selected };
  writeJson(join(dir, 'plan.json'), frozen);
  writeJson(join(dir, 'meta.json'), {
    createdAt: new Date().toISOString(),
    label: flags.label || null,
    planFile: repoPath(planFile),
    recordAll: Boolean(flags.record),
    retestOf: flags.retest || null,
  });
  writeJson(join(dir, 'review.json'), {});

  for (const tc of selected) {
    const base = tcDir(runId, tc.id);
    mkdirSync(join(base, 'evidence'), { recursive: true });
    const record = Boolean(flags.record || tc.record || plan.defaults?.record);
    if (record) writeRecordingSnippets(runId, tc.id);
    writeCaptureSnippet(runId, tc.id);
    writeFileSync(join(base, 'brief.md'), brief(frozen, tc, runId, record));
  }

  console.log(`OK run=${runId}`);
  console.log(`dir=${repoPath(dir)}`);
  console.log(`viewer=http://127.0.0.1:${PORT}/#/run/${encodeURIComponent(runId)}`);
  for (const [group, ids] of groupIds(selected)) console.log(`group ${group}: ${ids.join(', ')}`);
}

function checkPlan(plan) {
  const problems = [];
  if (!plan.id || !/^[A-Za-z0-9._-]+$/.test(plan.id))
    problems.push('id is required and may only use letters, digits, . _ -');
  if (!plan.title) problems.push('title is required');
  const known = Object.keys(CONFIG.variants || {});
  if (!Array.isArray(plan.testCases) || !plan.testCases.length) problems.push('testCases must be a non-empty array');
  const seen = new Set();
  for (const tc of plan.testCases || []) {
    if (!tc.id || !/^[A-Za-z0-9._-]+$/.test(tc.id)) problems.push(`test case id "${tc.id}" is invalid`);
    if (seen.has(tc.id)) problems.push(`duplicate test case id ${tc.id}`);
    seen.add(tc.id);
    if (!tc.title) problems.push(`${tc.id}: title is required`);
    if (!Array.isArray(tc.steps) || !tc.steps.length) problems.push(`${tc.id}: steps must be a non-empty array`);
    for (const step of tc.steps || [])
      if (!step.n || !step.action) problems.push(`${tc.id}: every step needs n and action`);
    if (!tc.expected) problems.push(`${tc.id}: expected is required`);
    for (const [key, value] of Object.entries(tc.variants || {})) {
      const allowed = CONFIG.variants?.[key]?.values;
      if (known.length && !known.includes(key)) problems.push(`${tc.id}: variant "${key}" is not in .qa/config.json`);
      else if (allowed && !allowed.includes(value))
        problems.push(`${tc.id}: ${key}="${value}" is not one of ${allowed.join(', ')}`);
    }
  }
  return problems;
}

function groupIds(testCases) {
  const groups = new Map();
  for (const tc of testCases) {
    const key = tc.group || tc.id;
    groups.set(key, [...(groups.get(key) || []), tc.id]);
  }
  return groups;
}

// The brief is the only input a Test Agent gets for one test case: what to do, where to write,
// and the exact shape to report back. Keeping it self-contained is what keeps agents small.
function brief(plan, tc, runId, record) {
  const base = tcDir(runId, tc.id);
  const evidence = repoPath(join(base, 'evidence'));
  const cli = repoPath(join(SKILL_DIR, 'scripts', 'qa-runs.mjs'));
  const env = { ...(plan.environment || {}), ...(tc.environment || {}) };
  const targets = { ...(plan.environment?.targets || {}), ...(tc.environment?.targets || {}) };
  const referenceCheck = tc.referenceCheck || plan.defaults?.referenceCheck || 'on-deviation';
  const label = (key) => CONFIG.targets?.[key] || key;
  const variantLabel = (key) => CONFIG.variants?.[key]?.label || key;
  const lines = [
    `# Brief ${tc.id}: ${tc.title}`,
    '',
    `Run \`${runId}\` · plan \`${plan.id}\`${plan.issue ? ` · issue ${plan.issue}` : ''}`,
    '',
    '## Context',
    ...Object.entries({
      Environment: env.name,
      ...Object.fromEntries(Object.entries(targets).map(([key, url]) => [`${label(key)} URL`, url])),
      ...Object.fromEntries(Object.entries(tc.variants || {}).map(([key, value]) => [variantLabel(key), value])),
      Tool: tc.tool || plan.defaults?.tool || 'playwright-mcp',
      [`Check against ${label('reference')}`]: targets.reference ? referenceCheck : null,
    })
      .filter(([, value]) => value)
      .map(([key, value]) => `- **${key}:** ${value}`),
    ...(tc.data
      ? [
          '- **Test data:** ' +
            Object.entries(tc.data)
              .map(([k, v]) => `${k}=${v}`)
              .join(', '),
        ]
      : []),
    '- **Credentials:** given in your prompt. Never write them to a file; redact them in saved JSON as `"***"`.',
    ...((plan.references || []).length || (tc.references || []).length
      ? [
          '',
          '## Read only if you need it',
          ...[...(plan.references || []), ...(tc.references || [])].map((r) => `- ${r}`),
        ]
      : []),
    ...(Object.keys(CONFIG.capabilities || {}).length
      ? [
          '',
          '## Project skills (invoke one only when a step needs it)',
          ...Object.entries(CONFIG.capabilities).map(([use, skill]) => `- ${use}: \`${skill}\``),
        ]
      : []),
    ...(tc.preconditions?.length ? ['', '## Preconditions', ...tc.preconditions.map((p) => `- ${p}`)] : []),
    '',
    '## Steps',
    '| # | Action | Expected |',
    '|---|---|---|',
    ...tc.steps.map((s) => `| ${s.n} | ${cell(s.action)} | ${cell(s.expected || '')} |`),
    '',
    `**Expected result:** ${tc.expected}`,
    ...(tc.notes ? ['', `**Notes:** ${tc.notes}`] : []),
    ...(plan.guardrails?.length ? ['', '## Guardrails', ...plan.guardrails.map((g) => `- ${g}`)] : []),
    '',
    '## Protocol',
    `1. Start: \`node ${cli} mark ${runId} ${tc.id} running\``,
    `2. Evidence goes in \`${evidence}/\`, named \`NN-<step-slug>.<ext>\`. Save request/response bodies you rely on as \`.json\`. Screenshots, either way:`,
    `   - **Annotated (preferred for the proof of each expected result, and for every fail/blocked):** open \`${repoPath(join(base, '.capture.js'))}\`, set \`file\` and \`marks\` (CSS or \`text=…\` selectors; types rect, ellipse, highlight, arrow, text, step, spotlight, blur; optional \`label\`, \`color\`), and run it with \`browser_run_code_unsafe\` (paste it as \`code\`, or save your edit and pass \`filename\`). It takes the screenshot and draws the marks on the element boxes. Keep marks few and meaningful: one arrow or box per point you prove. Blur any personal data.`,
    `   - **Plain:** \`browser_take_screenshot\` with \`scale: "css"\` and \`filename: "${evidence}/01-<slug>.png"\`.`,
    ...(record
      ? [
          `3. Recording is ON. Right before step 1 run \`browser_run_code_unsafe\` with \`filename: "${repoPath(join(base, '.rec', 'start.js'))}"\`; after the last step run it with \`filename: "${repoPath(join(base, '.rec', 'stop.js'))}"\`. The viewer server must be running (\`node ${cli} open\`). Stop prints the video file name; list it in \`evidence\` with kind \`video\`, and cite it in the \`evidence\` of every step that has no still of its own.`,
        ]
      : []),
    `${record ? 4 : 3}. Write \`${repoPath(join(base, 'result.json'))}\` (contract: \`${repoPath(join(SKILL_DIR, 'schemas', 'test-result.schema.json'))}\`). Use this skeleton:`,
    '',
    '```json',
    JSON.stringify(
      {
        schemaVersion: 2,
        testCaseId: tc.id,
        status: 'pass | fail | blocked | skipped',
        summary: 'one sentence a reviewer can trust',
        environment: { versions: { app: '' }, variants: tc.variants || {} },
        steps: tc.steps.map((s) => ({
          n: s.n,
          status: 'pass | fail | blocked | skipped | n/a',
          actual: '',
          evidence: [],
        })),
        evidence: [{ file: '01-<slug>.png', kind: 'screenshot', caption: '' }],
        data: {},
        defects: [],
        ...(targets.reference && {
          reference: { checked: false, result: 'same | deviation | improvement | n/a', notes: '' },
        }),
        notes: '',
      },
      null,
      2,
    ),
    '```',
    '',
    `${record ? 5 : 4}. Final reply to the orchestrator: ONE line — \`${tc.id} <STATUS> — <summary>\`. Everything else lives in result.json.`,
    '',
  ];
  return lines.join('\n');
}

// Captures a screenshot and its annotations in one Playwright call: element boxes come from the
// live DOM (text nodes are measured tightly so an arrow lands on the words, not the full-width
// block), then the marks are PUT to the viewer server, which writes the sidecar next to the image.
function writeCaptureSnippet(runId, tcId) {
  const base = tcDir(runId, tcId);
  const endpoint = `http://127.0.0.1:${PORT}/api/runs/${encodeURIComponent(runId)}/annotations/${encodeURIComponent(tcId)}/`;
  writeFileSync(
    join(base, '.capture.js'),
    `async (page) => {
  const file = '01-step-slug.png';
  const marks = [
    { selector: 'input[name="email"]', type: 'rect', label: 'Email left empty' },
    { selector: 'text=Email is required', type: 'arrow', label: 'Inline required error' },
  ];

  const evidence = ${JSON.stringify(repoPath(join(base, 'evidence')))};
  const endpoint = ${JSON.stringify(endpoint)};
  const items = [];
  const elements = {};
  for (const mark of marks) {
    const handle = await page.locator(mark.selector).first().elementHandle({ timeout: 3000 }).catch(() => null);
    const box =
      handle &&
      (await handle.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        const element = node.getBoundingClientRect();
        const r = text.width > 0 && text.width < element.width - 4 ? text : element;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
    if (!box) {
      items.push({ type: 'text', x: 12, y: 12, text: 'Not found: ' + mark.selector, color: 'yellow' });
      continue;
    }
    elements[mark.name || mark.label || mark.selector] = box;
    if (mark.type) items.push({ type: mark.type, box, label: mark.label, text: mark.text, color: mark.color, n: mark.n });
  }
  await page.screenshot({ path: evidence + '/' + file, scale: 'css' });
  const response = await page.request
    .put(endpoint + encodeURIComponent(file), {
      headers: { 'x-qa-viewer': '1' },
      data: { author: 'agent', mode: 'replace', items, elements, summary: 'captured by the Test Agent' },
    })
    .catch((error) => ({ status: () => 0, text: async () => String(error) }));
  return file + ' saved; annotations: ' + response.status() + ' ' + (await response.text());
}
`,
  );
}

// A function, not a const: commands run via top-level await before later consts initialize.
function annotateHelp() {
  return `Mark syntax for annotate --add '<json>' (one item or an array, in image pixels;
--list prints the image size, current items and the element boxes captured at test time):
  rect | ellipse | highlight {x,y,w,h,color?,label?}
  spotlight {x,y,w,h}   dims everything else
  blur {x,y,w,h}        hides personal data
  arrow {to:[x,y], from?:[x,y], color?, label?}
  text {x,y,text,color?,size?}   step {x,y,n}
Box shapes, arrow, text and step also accept "box": {x,y,width,height} (padding is added for you).
Colors: red (default), yellow, green, blue, magenta, white or #hex.
Locate elements from the captured boxes first; otherwise Read the image and estimate coordinates.
Prefer one clear arrow or box with a short label over many marks. Add --summary "<why>".`;
}

function annotate() {
  if (flags.help) return console.log(annotateHelp());
  const [runId, tcId, image] = args;
  if (!runId || !tcId || !image)
    fail("usage: annotate <runId> <tcId> <image> [--list] [--add '<json>'] [--replace] [--remove <ids|all>]");
  const evidence = join(tcDir(runId, tcId), 'evidence');
  if (!existsSync(join(evidence, image))) fail(`no image "${image}" in ${repoPath(evidence)}`);
  const author = ['agent', 'chat', 'reviewer'].includes(flags.author) ? flags.author : 'chat';
  try {
    if (flags.remove) {
      const ids = flags.remove === 'all' ? [] : String(flags.remove).split(',');
      console.log(`OK ${removeAnnotations(evidence, image, ids, author).length} annotation(s) left on ${image}`);
    } else if (flags.add) {
      let items;
      try {
        items = JSON.parse(flags.add);
      } catch (error) {
        fail(`--add is not valid JSON: ${error.message}`);
      }
      const data = writeAnnotations(evidence, image, {
        items,
        mode: flags.replace ? 'replace' : 'append',
        author,
        summary: flags.summary,
      });
      console.log(`OK ${image} now has ${data.items.length} annotation(s); the viewer shows them on its next refresh.`);
    }
  } catch (error) {
    fail(error.message);
  }
  if (flags.list || (!flags.add && !flags.remove)) {
    const data = readAnnotations(evidence, image);
    const size = imageSize(join(evidence, image));
    console.log(
      `${image}  ${size ? `${size.width}x${size.height}px` : 'size unknown'}  ${data.items.length} annotation(s)`,
    );
    for (const item of data.items) {
      const geometry =
        item.type === 'arrow'
          ? `from ${item.from} to ${item.to}`
          : `x=${item.x} y=${item.y}${item.w ? ` w=${item.w} h=${item.h}` : ''}`;
      console.log(
        `  ${item.id}  ${item.type.padEnd(9)} ${geometry}  ${item.label || item.text || ''} (${item.author})`,
      );
    }
    const elements = Object.entries(data.elements || {});
    if (elements.length) console.log('elements captured at test time:');
    for (const [name, b] of elements)
      console.log(
        `  ${name}: x=${Math.round(b.x)} y=${Math.round(b.y)} width=${Math.round(b.width)} height=${Math.round(b.height)}`,
      );
  }
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Recording runs inside the Playwright MCP process, which has no file system access, so frames
// stream over HTTP to the viewer server, which stitches them with ffmpeg on stop.
function writeRecordingSnippets(runId, tcId) {
  const dir = join(tcDir(runId, tcId), '.rec');
  mkdirSync(dir, { recursive: true });
  const endpoint = `http://127.0.0.1:${PORT}/api/rec/${encodeURIComponent(runId)}/${encodeURIComponent(tcId)}`;
  writeFileSync(
    join(dir, 'start.js'),
    `async (page) => {
  const endpoint = ${JSON.stringify(endpoint)};
  if (page.__qaRec) return 'already recording';
  const health = await page.request.get(endpoint.replace(/\\/api\\/rec\\/.*/, '/api/health')).catch(() => null);
  if (!health || !health.ok()) return 'viewer server is not running: run qa-runs.mjs open first';
  await page.request.post(endpoint + '/start');
  const session = await page.context().newCDPSession(page);
  let n = 0;
  session.on('Page.screencastFrame', (frame) => {
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    page.request.post(endpoint + '/frame', { data: { n: ++n, ts: frame.metadata.timestamp, data: frame.data } }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1000 });
  page.__qaRec = session;
  return 'recording';
}
`,
  );
  writeFileSync(
    join(dir, 'stop.js'),
    `async (page) => {
  const endpoint = ${JSON.stringify(endpoint)};
  const session = page.__qaRec;
  if (!session) return 'not recording';
  await page.waitForTimeout(1200);
  await session.send('Page.stopScreencast').catch(() => {});
  await session.detach().catch(() => {});
  delete page.__qaRec;
  await page.waitForTimeout(800);
  const response = await page.request.post(endpoint + '/stop', { timeout: 180000 });
  return await response.text();
}
`,
  );
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function open() {
  if (!(await health())) {
    const child = spawn(process.execPath, [join(SKILL_DIR, 'scripts', 'server.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: PROJECT_ROOT,
      env: { ...process.env, QA_PROJECT_DIR: PROJECT_ROOT },
    });
    child.unref();
    for (let i = 0; i < 40 && !(await health()); i += 1) await new Promise((r) => setTimeout(r, 250));
    if (!(await health())) fail(`viewer server did not start on port ${PORT}.`);
  }
  const runId = args[0] || listRuns()[0]?.id;
  const url = `http://127.0.0.1:${PORT}/${runId ? `#/run/${encodeURIComponent(runId)}` : ''}`;
  if (!flags['no-browser']) {
    const opener =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  console.log(`OK viewer=${url}`);
}

async function serve() {
  await import('./server.mjs');
}

function mark() {
  const [runId, tcId, state, ...note] = args;
  if (!runId || !tcId || !['running', 'pending'].includes(state))
    fail('usage: mark <runId> <tcId> <running|pending> [note]');
  const base = tcDir(runId, tcId);
  if (!existsSync(base)) fail(`unknown test case ${tcId} in run ${runId}`);
  writeJson(join(base, 'progress.json'), { state, note: note.join(' ') || null, at: new Date().toISOString() });
  console.log(`OK ${tcId} ${state}`);
}

function validate() {
  const runId = args[0] || listRuns()[0]?.id;
  if (!runId || !existsSync(runDir(runId))) fail('validate needs a run id.');
  const run = loadRun(runId);
  const counts = countStatuses(run);
  writeJson(join(runDir(runId), 'run.json'), {
    id: runId,
    validatedAt: new Date().toISOString(),
    counts,
    testCases: run.testCases.map(({ id, status, warnings, review }) => ({ id, status, warnings, review })),
  });
  printStatus(run, counts, true);
}

function status() {
  const runId = args[0] || listRuns()[0]?.id;
  if (!runId) fail('no runs yet.');
  const run = loadRun(runId);
  printStatus(run, countStatuses(run), false);
}

function printStatus(run, counts, withWarnings) {
  console.log(
    `${run.id}  ${Object.entries(counts)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`,
  );
  for (const tc of run.testCases) {
    const review = tc.review?.verdict ? ` review=${tc.review.verdict}` : '';
    const warn = tc.warnings.length ? ` warnings=${tc.warnings.length}` : '';
    console.log(
      `${tc.id.padEnd(16)} ${String(tc.status).padEnd(8)}${review}${warn}  ${tc.result?.summary || tc.title}`,
    );
    if (withWarnings) for (const w of tc.warnings) console.log(`    ! ${w}`);
  }
}

function latest() {
  const run = listRuns()[0];
  if (!run) fail('no runs yet.');
  console.log(run.id);
}
