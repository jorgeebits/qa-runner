#!/usr/bin/env node
// Writes the plugin's Test Agents (agents/test-agent-N.md) and browser pool (plugin.json →
// mcpServers; not a root .mcp.json, which would also load as this repo's own MCP servers) from
// skills/run-test-plan/scripts/agents.mjs, so the rules live in one place. Run it after changing
// that file; `--check` fails when the committed files are out of date (CI).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOL_SIZE, agentFile, mcpConfig } from '../skills/run-test-plan/scripts/agents.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join('.claude-plugin', 'plugin.json');
const plugin = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
const files = {
  ...Object.fromEntries(
    Array.from({ length: POOL_SIZE }, (_, i) => [join('agents', `test-agent-${i + 1}.md`), agentFile(i + 1)]),
  ),
  [manifest]: JSON.stringify({ ...plugin, mcpServers: mcpConfig().mcpServers }, null, 2) + '\n',
};
const stale = existsSync(join(root, 'agents'))
  ? readdirSync(join(root, 'agents'))
      .filter((f) => /^test-agent-\d+\.md$/.test(f))
      .map((f) => join('agents', f))
      .filter((f) => !(f in files))
  : [];

if (process.argv.includes('--check')) {
  const outdated = [
    ...Object.entries(files)
      .filter(([file, content]) => !existsSync(join(root, file)) || readFileSync(join(root, file), 'utf8') !== content)
      .map(([file]) => file),
    ...stale,
  ];
  if (outdated.length) {
    console.error(`out of date: ${outdated.join(', ')}. Run node scripts/build-agents.mjs`);
    process.exit(1);
  }
  console.log('agents and the browser pool in plugin.json are up to date');
} else {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
    console.log(`wrote ${file}`);
  }
  for (const file of stale) {
    rmSync(join(root, file));
    console.log(`removed ${file}`);
  }
}
