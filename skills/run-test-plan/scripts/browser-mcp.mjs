#!/usr/bin/env node
// Starts one browser of the Test Agents' pool: a Playwright MCP server with its own in-memory
// profile, so parallel agents never share tabs or cookies. Claude Code runs it over stdio from the
// plugin's manifest (`browser-mcp.mjs <slot>`).
//
// Claude Code starts every MCP server of a session at once and gives each a short time to answer.
// `npx` resolves the package on every start, which under that load can take longer than allowed,
// so the pinned package is installed once into a per-user cache and then started with plain node.
//
//   QA_PLAYWRIGHT_MCP   package to run instead of the pinned one, e.g. @playwright/mcp@latest
//                       (runs through npx, uncached)
//   QA_BROWSER_ARGS     extra flags for every slot, e.g. "--headless --viewport-size 1440x900"
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAYWRIGHT_MCP } from './agents.mjs';

const slot = process.argv[2] || '1';
const flags = [
  '--isolated',
  // Screenshots are evidence for the human; the agent reads the page from snapshots, so sending
  // the image back would only add tokens to every later turn.
  '--image-responses',
  'omit',
  '--output-dir',
  join(tmpdir(), `qa-browser-${slot}`),
  ...(process.env.QA_BROWSER_ARGS || '').split(/\s+/).filter(Boolean),
];

// Installs into a scratch folder and renames it into place, so slots starting together never
// see a half-written install; whichever finishes first wins and the others use it.
function cachedCli() {
  const dir = join(homedir(), '.cache', 'qa-runner', PLAYWRIGHT_MCP.replace(/[\/@]/g, '_'));
  const cli = join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (existsSync(cli)) return cli;
  const scratch = `${dir}.${process.pid}`;
  mkdirSync(scratch, { recursive: true });
  const npm = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', scratch, PLAYWRIGHT_MCP], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (npm.status === 0 && !existsSync(cli))
    try {
      renameSync(scratch, dir);
    } catch {
      // Another slot got there first.
    }
  rmSync(scratch, { recursive: true, force: true });
  return existsSync(cli) ? cli : null;
}

const cli = process.env.QA_PLAYWRIGHT_MCP ? null : cachedCli();
const child = cli
  ? spawn(process.execPath, [cli, ...flags], { stdio: 'inherit' })
  : spawn('npx', ['-y', process.env.QA_PLAYWRIGHT_MCP || PLAYWRIGHT_MCP, ...flags], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
