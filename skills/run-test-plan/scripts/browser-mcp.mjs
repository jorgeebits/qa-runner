#!/usr/bin/env node
// Starts one browser of the Test Agents' pool: a Playwright MCP server with its own in-memory
// profile, so parallel agents never share tabs or cookies. Claude Code runs it over stdio from the
// plugin's manifest (`browser-mcp.mjs <slot>`); a node wrapper keeps that entry the same on every
// OS (npx needs a shell on Windows).
//
//   QA_PLAYWRIGHT_MCP   package to run instead of the pinned one, e.g. @playwright/mcp@latest
//   QA_BROWSER_ARGS     extra flags for every slot, e.g. "--headless --viewport-size 1440x900"
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAYWRIGHT_MCP } from './agents.mjs';

const slot = process.argv[2] || '1';
const args = [
  '-y',
  process.env.QA_PLAYWRIGHT_MCP || PLAYWRIGHT_MCP,
  '--isolated',
  // Screenshots are evidence for the human; the agent reads the page from snapshots, so sending
  // the image back would only add tokens to every later turn.
  '--image-responses',
  'omit',
  '--output-dir',
  join(tmpdir(), `qa-browser-${slot}`),
  ...(process.env.QA_BROWSER_ARGS || '').split(/\s+/).filter(Boolean),
];
const child = spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
