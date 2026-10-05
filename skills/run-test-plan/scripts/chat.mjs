// "Chat with your agent": each message from the viewer runs one headless Claude Code turn
// (`claude -p`) scoped to one test case. The session id is kept per case, so follow-up questions
// resume the same conversation. The agent can read the run's files and images, and its only write
// path is `qa-runs.mjs annotate`, so it can mark up screenshots but not touch results or code.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, SKILL_DIR, displayPath, readJson, runDir, tcDir, writeJson } from './lib.mjs';

const CLAUDE_BIN = process.env.QA_CLAUDE_BIN || 'claude';
const MODEL = process.env.QA_CHAT_MODEL || 'sonnet';
const MAX_MESSAGE = 4000;
const live = new Map();

const repoPath = displayPath;
const chatDir = (runId, tcId) => join(tcDir(runId, tcId), 'chat');
const messagesFile = (runId, tcId) => join(chatDir(runId, tcId), 'messages.json');
const sessionFile = (runId, tcId) => join(chatDir(runId, tcId), 'session.json');

export function chatState(runId, tcId) {
  const turn = live.get(`${runId}/${tcId}`);
  return {
    model: MODEL,
    messages: readJson(messagesFile(runId, tcId), []),
    busy: Boolean(turn),
    pending: turn ? { text: turn.committed + turn.delta, activity: turn.activity } : null,
  };
}

function append(runId, tcId, message) {
  const messages = readJson(messagesFile(runId, tcId), []);
  messages.push({ ...message, at: new Date().toISOString() });
  writeJson(messagesFile(runId, tcId), messages);
}

// Kept short on purpose: it is paid on every turn. The agent pulls the brief, result, plan or the
// mark syntax (`annotate --help`) only when a question needs them.
function systemPrompt(runId, tcId) {
  const base = tcDir(runId, tcId);
  const cli = `node ${repoPath(join(SKILL_DIR, 'scripts', 'qa-runs.mjs'))} annotate ${runId} ${tcId}`;
  const memoryCli = `node ${repoPath(join(SKILL_DIR, 'scripts', 'qa-runs.mjs'))} memory`;
  return `You assist a human reviewer in the local QA viewer, about test case ${tcId} of run ${runId}.

Files (Read opens images too; open only what the question needs):
- brief (what the Test Agent was told): ${repoPath(join(base, 'brief.md'))}
- result: ${repoPath(join(base, 'result.json'))}
- evidence: ${repoPath(join(base, 'evidence'))}/  (<image>.annotations.json = marks + element boxes)
- plan: ${repoPath(join(runDir(runId), 'plan.json'))} · verdicts: ${repoPath(join(runDir(runId), 'review.json'))}

Answer in the reviewer's language, short and concrete; quote exact on-screen text when it matters. Say plainly when the evidence does not show something; never invent a result.

Your only write path is marking screenshots: run \`${cli} --help\` once before your first mark, then \`${cli} <image> --list|--add|--remove\`. Never edit images, results or other files.

If the reviewer states a fact a future run should reuse (a test value, a workaround), propose it with \`${memoryCli} add --help\`; a human approves it in the Memory panel. You cannot drive the browser or re-run the test; suggest a retest instead.`;
}

export function sendChat(runId, tcId, { message, image }) {
  const key = `${runId}/${tcId}`;
  if (live.has(key)) throw Object.assign(new Error('the agent is still answering'), { status: 409 });
  const text = String(message || '')
    .trim()
    .slice(0, MAX_MESSAGE);
  if (!text) throw Object.assign(new Error('empty message'), { status: 400 });

  const session = readJson(sessionFile(runId, tcId));
  const sessionId = session?.sessionId || randomUUID();
  if (!session) writeJson(sessionFile(runId, tcId), { sessionId, createdAt: new Date().toISOString() });
  append(runId, tcId, { role: 'user', text, image: image || null });

  const prompt = image ? `[The reviewer is looking at screenshot evidence/${image}]\n${text}` : text;
  const allowed = [
    'Read',
    'Glob',
    'Grep',
    `Bash(node ${repoPath(join(SKILL_DIR, 'scripts', 'qa-runs.mjs'))} annotate:*)`,
    `Bash(node ${repoPath(join(SKILL_DIR, 'scripts', 'qa-runs.mjs'))} memory:*)`,
  ];
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    MODEL,
    '--tools',
    'Read,Glob,Grep,Bash',
    '--allowedTools',
    ...allowed,
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--exclude-dynamic-system-prompt-sections',
    '--append-system-prompt',
    systemPrompt(runId, tcId),
    ...(session ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ];

  const child = spawn(CLAUDE_BIN, args, {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'qa-viewer', QA_MEMORY_ROLE: 'chat' },
  });
  const turn = { child, committed: '', delta: '', activity: [], cost: null, error: null, stderr: '', buffer: '' };
  live.set(key, turn);

  child.stdout.on('data', (chunk) => {
    turn.buffer += chunk.toString('utf8');
    const lines = turn.buffer.split('\n');
    turn.buffer = lines.pop();
    for (const line of lines) if (line.trim()) handleEvent(turn, line);
  });
  child.stderr.on('data', (chunk) => (turn.stderr = (turn.stderr + chunk.toString('utf8')).slice(-2000)));
  child.on('error', (error) => (turn.error = `Could not start "${CLAUDE_BIN}": ${error.message}`));
  child.on('close', (code) => {
    if (turn.buffer.trim()) handleEvent(turn, turn.buffer);
    live.delete(key);
    const answer = (turn.committed + turn.delta).trim();
    const failed = turn.error || (code !== 0 && !answer);
    append(runId, tcId, {
      role: 'assistant',
      text: answer || (turn.stopped ? 'Stopped.' : ''),
      activity: turn.activity,
      cost: turn.cost,
      error: failed ? turn.error || turn.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}` : null,
    });
  });
  child.stdin.end(prompt);
}

function handleEvent(turn, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === 'stream_event') {
    const delta = event.event?.delta;
    if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta') turn.delta += delta.text;
  } else if (event.type === 'assistant') {
    for (const block of event.message?.content || []) {
      if (block.type === 'text' && block.text) {
        turn.committed += (turn.committed ? '\n\n' : '') + block.text;
        turn.delta = '';
      } else if (block.type === 'tool_use') turn.activity.push(describeTool(block));
    }
  } else if (event.type === 'user') {
    for (const block of event.message?.content || []) {
      if (block.type !== 'tool_result' || !block.is_error) continue;
      const last = turn.activity.at(-1);
      if (last) last.failed = true;
    }
  } else if (event.type === 'result') {
    turn.cost = event.total_cost_usd ?? null;
    if (event.is_error) turn.error = String(event.result || event.subtype || 'the agent reported an error');
    if (!turn.committed && event.result) turn.committed = String(event.result);
  }
}

function describeTool(block) {
  const input = block.input || {};
  if (block.name === 'Bash') {
    const command = String(input.command || '');
    const annotate = /annotate\s+\S+\s+\S+\s+(\S+)\s+(--\w+)/.exec(command);
    return annotate
      ? { tool: 'annotate', detail: `${annotate[2].slice(2)} ${annotate[1]}` }
      : { tool: 'Bash', detail: command.slice(0, 120) };
  }
  if (block.name === 'Read')
    return {
      tool: 'Read',
      detail: String(input.file_path || '')
        .split(/[\\/]/)
        .slice(-2)
        .join('/'),
    };
  return { tool: block.name, detail: String(input.pattern || input.path || '').slice(0, 120) };
}

export function stopChat(runId, tcId) {
  const turn = live.get(`${runId}/${tcId}`);
  if (!turn) return false;
  turn.stopped = true;
  turn.child.kill();
  return true;
}

export function resetChat(runId, tcId) {
  stopChat(runId, tcId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const file of [messagesFile(runId, tcId), sessionFile(runId, tcId)])
    if (existsSync(file)) renameSync(file, file.replace(/\.json$/, `.${stamp}.json`));
}
