#!/usr/bin/env node
// Local viewer server for run-test-plan. Binds to 127.0.0.1 only. Serves the viewer, the run
// folders (evidence), a small JSON API the viewer polls, reviewer verdicts, screenshot
// annotations, the per-case agent chat, and the recording endpoints the Playwright MCP snippets
// stream screencast frames to.
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { imageSize, readAnnotations, writeAnnotations } from './annotations.mjs';
import { chatState, resetChat, sendChat, stopChat } from './chat.mjs';
import { addMemory, findMemory, loadMemories, removeMemory, updateMemory } from './memory.mjs';
import { answerQuestion } from './questions.mjs';
import { PRICING_AS_OF } from './pricing.mjs';
import { runCost } from './usage.mjs';
import {
  PORT,
  RUNS_DIR,
  REVIEW_VERDICTS,
  SKILL_DIR,
  countStatuses,
  dashboardData,
  viewerConfig,
  listRuns,
  loadRun,
  readJson,
  runDir,
  safeJoin,
  tcDir,
  writeJson,
} from './lib.mjs';

const VIEWER_DIR = join(SKILL_DIR, 'viewer');
const MAX_BODY = 12 * 1024 * 1024;
const MAX_FRAME_GAP_SECONDS = 2;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const recordings = new Map();
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// Any web page can make a browser fire requests at 127.0.0.1, so writes are refused when they
// come from another origin, and the viewer's own writes must carry a custom header (which a
// cross-site page cannot set without a preflight this server never approves).
function forbidden(req, { needsHeader }) {
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return true;
  return needsHeader && req.headers['x-qa-viewer'] !== '1';
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolveBody(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });

function serveFile(req, res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  const { size } = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

const route = async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] === 'api') {
    const [, resource, runId, tcId, action] = parts;
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && forbidden(req, { needsHeader: resource !== 'rec' }))
      return send(res, 403, { error: 'forbidden origin' });
    if (resource === 'health') return send(res, 200, { ok: true, runsDir: RUNS_DIR });
    if (resource === 'runs' && tcId === 'annotations') return annotations(req, res, runId, parts[4], parts[5]);
    if (resource === 'runs' && tcId === 'export' && req.method === 'POST')
      return exportPng(req, res, runId, parts[4], parts[5]);
    if (resource === 'chat') return chat(req, res, runId, tcId, action);
    if (resource === 'memory') return memory(req, res, runId, tcId);
    if (resource === 'dashboard' && req.method === 'GET') {
      const memories = loadMemories({ all: true });
      return send(res, 200, {
        runs: dashboardData().map((run) => {
          const { entries, ...cost } = runCost(run.id, run.cases);
          return { ...run, cost };
        }),
        pricingAsOf: PRICING_AS_OF,
        config: viewerConfig(),
        memory: {
          active: memories.filter((m) => m.status === 'active').length,
          proposed: memories.filter((m) => m.status === 'proposed').length,
          reused: memories.reduce((sum, m) => sum + (m.stats?.used || 0), 0),
        },
      });
    }
    if (resource === 'runs' && tcId === 'answer' && req.method === 'POST')
      return answer(req, res, runId, parts[4], parts[5]);
    if (resource === 'runs' && !runId) return send(res, 200, listRuns());
    if (resource === 'runs' && req.method === 'GET') {
      if (!existsSync(runDir(runId))) return send(res, 404, { error: 'unknown run' });
      const run = loadRun(runId);
      const { entries, ...cost } = runCost(runId, run.testCases);
      return send(res, 200, { ...run, counts: countStatuses(run), cost });
    }
    if (resource === 'runs' && tcId === 'review' && req.method === 'PUT') return saveReview(req, res, runId, action);
    if (resource === 'rec' && req.method === 'POST') return recording(req, res, runId, tcId, action);
    return send(res, 404, { error: 'unknown endpoint' });
  }

  // Dot-folders inside a run (.answers, .rec, .capture.js) are agent plumbing, never evidence.
  // Only the URL segments are checked: the runs folder itself usually lives under .qa/.
  if (parts[0] === 'runs') {
    if (parts.slice(1).some((part) => part.startsWith('.'))) return send(res, 404, { error: 'not found' });
    return serveFile(req, res, safeJoin(RUNS_DIR, ...parts.slice(1)));
  }
  return serveFile(req, res, safeJoin(VIEWER_DIR, ...(parts.length ? parts : ['index.html'])));
};

async function answer(req, res, runId, tcId, qid) {
  if (!existsSync(join(runDir(runId), 'plan.json'))) return send(res, 404, { error: 'unknown run' });
  const body = await readBody(req);
  try {
    const remember = ['project', 'user'].includes(body.remember) ? body.remember : null;
    return send(
      res,
      200,
      answerQuestion(runId, tcId, qid, { answer: body.answer, sensitive: Boolean(body.sensitive), remember }),
    );
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
}

// The reviewer curates memory from the viewer: approve or reject what agents proposed, retire
// what went stale, bring back what was retired by mistake.
async function memory(req, res, id, action) {
  if (req.method === 'GET') return send(res, 200, loadMemories({ all: true }).map(({ file, ...e }) => e));
  if (req.method !== 'POST' || !id) return send(res, 405, { error: 'use GET, or POST /api/memory/<id>/<action>' });
  const entry = findMemory(id);
  if (!entry) return send(res, 404, { error: 'unknown memory' });
  try {
    if (action === 'approve' || action === 'activate') {
      const { file, share, ...rest } = updateMemory(id, {
        status: 'active',
        stats: { ...entry.stats, failed: 0 },
        source: { ...entry.source, confirmedBy: 'reviewer' },
      });
      return send(res, 200, rest);
    }
    if (action === 'stale') return send(res, 200, updateMemory(id, { status: 'stale' }).id);
    if (action === 'reject' || action === 'delete') return send(res, 200, removeMemory(id).id);
    if (action === 'move' && entry.share === 'user') {
      const { id: _, file, share, stats, source, ...rest } = entry;
      const moved = addMemory({ ...rest, source: { ...source, movedFrom: 'user' } }, 'project');
      removeMemory(id);
      return send(res, 200, moved.id);
    }
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
  return send(res, 400, { error: 'action must be approve, activate, stale, reject, delete or move' });
}

async function saveReview(req, res, runId, tcId) {
  const file = join(runDir(runId), 'review.json');
  if (!existsSync(join(runDir(runId), 'plan.json'))) return send(res, 404, { error: 'unknown run' });
  const body = await readBody(req);
  const review = readJson(file, {});
  if (!body.verdict) delete review[tcId];
  else if (!REVIEW_VERDICTS.includes(body.verdict))
    return send(res, 400, { error: `verdict must be one of ${REVIEW_VERDICTS.join(', ')}` });
  else
    review[tcId] = {
      verdict: body.verdict,
      comment: String(body.comment || '').slice(0, 4000),
      reviewer: String(body.reviewer || '').slice(0, 120) || null,
      at: new Date().toISOString(),
    };
  writeJson(file, review);
  return send(res, 200, review[tcId] || {});
}

function evidenceFor(runId, tcId) {
  const base = tcDir(runId, tcId);
  if (!existsSync(join(base, 'evidence'))) throw Object.assign(new Error('unknown test case'), { status: 404 });
  return join(base, 'evidence');
}

async function annotations(req, res, runId, tcId, image) {
  const evidence = evidenceFor(runId, tcId);
  if (!image || basename(image) !== image) return send(res, 400, { error: 'image name required' });
  if (req.method === 'GET')
    return send(res, 200, { ...readAnnotations(evidence, image), size: imageSize(join(evidence, image)) });
  if (req.method !== 'PUT') return send(res, 405, { error: 'use GET or PUT' });
  const body = await readBody(req);
  try {
    const data = writeAnnotations(evidence, image, {
      items: body.items || [],
      elements: body.elements,
      mode: body.mode === 'replace' ? 'replace' : 'append',
      author: ['agent', 'reviewer', 'chat'].includes(body.author) ? body.author : 'agent',
      summary: body.summary,
    });
    return send(res, 200, { ok: true, image, items: data.items.length, width: data.width, height: data.height });
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
}

// The viewer flattens the annotated canvas in the browser and posts the PNG here, so a reviewer
// gets a file ready to attach to an issue without the server needing an image library.
async function exportPng(req, res, runId, tcId, image) {
  const evidence = evidenceFor(runId, tcId);
  if (!image || basename(image) !== image) return send(res, 400, { error: 'image name required' });
  const body = await readBody(req);
  const png = Buffer.from(String(body.png || ''), 'base64');
  if (png.subarray(1, 4).toString('ascii') !== 'PNG') return send(res, 400, { error: 'body.png must be a base64 PNG' });
  const dir = join(evidence, '..', 'exports');
  mkdirSync(dir, { recursive: true });
  const name = `${image.replace(/\.[^.]+$/, '')}.annotated.png`;
  writeFileSync(join(dir, name), png);
  return send(res, 200, { ok: true, file: `tc/${tcId}/exports/${name}` });
}

async function chat(req, res, runId, tcId, action) {
  evidenceFor(runId, tcId);
  if (req.method === 'GET') return send(res, 200, chatState(runId, tcId));
  if (req.method === 'DELETE') {
    resetChat(runId, tcId);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && action === 'stop') return send(res, 200, { stopped: stopChat(runId, tcId) });
  if (req.method !== 'POST') return send(res, 405, { error: 'unsupported' });
  const body = await readBody(req);
  try {
    sendChat(runId, tcId, { message: body.message, image: body.image && basename(body.image) });
    return send(res, 202, { ok: true });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message });
  }
}

async function recording(req, res, runId, tcId, action) {
  const base = tcDir(runId, tcId);
  if (!existsSync(base)) return send(res, 404, { error: 'unknown test case' });
  const framesDir = join(base, '.rec', 'frames');
  const key = `${runId}/${tcId}`;

  if (action === 'start') {
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    recordings.set(key, []);
    return send(res, 200, { ok: true });
  }
  if (action === 'frame') {
    const body = await readBody(req);
    const frames = recordings.get(key);
    if (!frames) return send(res, 409, { error: 'call start first' });
    const name = `${String(body.n).padStart(6, '0')}.jpg`;
    writeFileSync(join(framesDir, name), Buffer.from(body.data, 'base64'));
    frames.push({ name, n: Number(body.n), ts: Number(body.ts) });
    return send(res, 200, { ok: true });
  }
  if (action === 'stop') {
    const frames = (recordings.get(key) || []).sort((a, b) => a.n - b.n);
    recordings.delete(key);
    if (!frames.length) return send(res, 200, 'no frames were captured', 'text/plain; charset=utf-8');
    const evidence = join(base, 'evidence');
    const take = readdirSync(evidence).filter((f) => /^recording-\d+\.mp4$/.test(f)).length + 1;
    const output = join(evidence, `recording-${take}.mp4`);
    const list = frames
      .map((frame, i) => {
        const next = frames[i + 1];
        const gap = next ? Math.min(Math.max(next.ts - frame.ts, 0.04), MAX_FRAME_GAP_SECONDS) : 1.5;
        return `file '${join(framesDir, frame.name).replace(/\\/g, '/')}'\nduration ${gap.toFixed(3)}`;
      })
      .join('\n');
    const listFile = join(framesDir, 'list.txt');
    writeFileSync(listFile, `${list}\nfile '${join(framesDir, frames.at(-1).name).replace(/\\/g, '/')}'\n`);
    const ffmpeg = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-r',
        '25',
        '-c:v',
        'libx264',
        '-movflags',
        '+faststart',
        output,
      ],
      { encoding: 'utf8' },
    );
    if (ffmpeg.status !== 0)
      return send(res, 500, `ffmpeg failed: ${ffmpeg.error?.message || ffmpeg.stderr}`, 'text/plain; charset=utf-8');
    rmSync(framesDir, { recursive: true, force: true });
    const seconds = frames.at(-1).ts - frames[0].ts;
    return send(
      res,
      200,
      `saved recording-${take}.mp4 (${frames.length} frames, ~${Math.round(seconds)}s real time)`,
      'text/plain; charset=utf-8',
    );
  }
  return send(res, 404, { error: 'unknown recording action' });
}

createServer((req, res) =>
  route(req, res).catch((error) => {
    if (!res.headersSent) send(res, error.status || 500, { error: String(error.message) });
  }),
)
  .on('error', (error) => {
    console.error(`ERROR ${error.message}`);
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`OK viewer=http://127.0.0.1:${PORT}/ runs=${RUNS_DIR}`));
