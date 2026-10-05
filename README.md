# qa-runner

A Claude Code plugin that runs manual-style end-to-end test plans with browser agents, shows the
results in a local viewer, and reruns only the cases a human rejects.

```
plan.json ──init──▶ brief.md per case ──Test Agent (browser)──▶ result.json + evidence/
   ▲                                                                   │
   └──── retest ◀── review.json ◀── viewer (human review) ◀── validate
```

- **Plans as data.** Test cases, steps, variants and guardrails live in a JSON plan.
- **One agent per group.** Each Test Agent gets only its briefs, so the main session stays small.
- **Contract checks.** `validate` flags missing evidence, unexplained failures, missing
  recordings and leaked credentials before anyone trusts a verdict.
- **Dashboard.** The viewer opens on how your agents are doing: pass rate, failures, blocked
  cases, average agent time per case (excluding time waiting on you), reviewer agreement and
  questions asked, plus cost per run (API list-price equivalent, exact from agent
  transcripts), with outcomes by run and by variant, cases that need attention, the slowest
  cases, and your recent runs. Filter by date range and plan.
- **Local viewer.** Live progress, screenshots with non-destructive marks (arrows, boxes,
  spotlight, blur), recordings, a per-case agent chat, and Approve / Needs retest / Reject.
- **Reference comparison.** Optionally compare each case against another app (legacy,
  production, a design) and report deviations.
- **Memory.** When an agent needs a value it does not have, it asks you in the viewer and waits.
  Tick "Remember" and later runs in the same situation reuse the answer. Agents also propose
  what they learned; nothing is reused until you approve it. Secrets are stored only as
  `env:NAME` references.

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- Node.js 20+ (no npm dependencies)
- The [Playwright MCP server](https://github.com/microsoft/playwright-mcp), registered as `playwright`
- `ffmpeg` on the PATH, only for recordings

## Install

1. Add this repo as a plugin marketplace and install the plugin:

   ```bash
   claude plugin marketplace add jorgeebits/qa-runner
   ```

   ```bash
   claude plugin install qa-runner@qa-runner
   ```

   Inside a Claude Code session the same steps are `/plugin marketplace add jorgeebits/qa-runner`
   and `/plugin install qa-runner@qa-runner`. Restart Claude Code afterwards so the
   `run-test-plan` skill loads.

2. Register the Playwright MCP server. Test Agents call its tools as `mcp__playwright__*`, so
   the server name must be `playwright`:

   ```bash
   claude mcp add playwright -- npx @playwright/mcp@latest
   ```

3. Optional, for recordings: install `ffmpeg` (`winget install Gyan.FFmpeg`,
   `brew install ffmpeg` or `sudo apt install ffmpeg`) and make sure it is on the PATH.

4. Check the install with `claude plugin list` and `claude mcp list`.

To update, run `claude plugin marketplace update qa-runner` and then
`claude plugin update qa-runner@qa-runner`. To remove it, run
`claude plugin uninstall qa-runner@qa-runner`.

To work on the plugin itself, clone the repo and add the local folder instead:
`claude plugin marketplace add ./qa-runner`.

## Set up a project

Create `.qa/config.json` in the project you test (every field is optional; see
`skills/run-test-plan/schemas/config.schema.json`):

```json
{
  "tracker": { "name": "GitHub", "issueUrl": "https://github.com/org/repo/issues/{key}" },
  "targets": { "app": "New checkout", "reference": "Legacy checkout" },
  "variants": { "country": { "label": "Country", "values": ["US", "CA", "MX"] } },
  "capabilities": { "login": "my-app-login" }
}
```

Add `.qa/runs/` to `.gitignore`; commit `.qa/memory/` to share what agents learned with your
team. `examples/` holds a complete config, plan and memory.

## Use

Ask Claude to run a test plan ("run the test plan for SHOP-42", "corre los test cases"). The
`run-test-plan` skill drafts or reuses `.qa/plans/<KEY>.plan.json`, asks you to approve the
cases, runs them, and opens the viewer at `http://127.0.0.1:4321`.

The CLI also works on its own:

```bash
node skills/run-test-plan/scripts/qa-runs.mjs init .qa/plans/SHOP-42.plan.json --label smoke
node skills/run-test-plan/scripts/qa-runs.mjs open
node skills/run-test-plan/scripts/qa-runs.mjs validate <runId>
node skills/run-test-plan/scripts/qa-runs.mjs memory --help
```

| Variable | Default | Purpose |
|---|---|---|
| `QA_PROJECT_DIR` | current directory | Project whose `.qa/` folder is used |
| `QA_RUNS_DIR` | `.qa/runs` | Where runs are written |
| `QA_VIEWER_PORT` | `4321` | Viewer port |
| `QA_CHAT_MODEL` | `sonnet` | Model behind the viewer's agent chat |
| `QA_CLAUDE_BIN` | `claude` | Claude Code binary the chat runs |
| `QA_USER_MEMORY_DIR` | `~/.claude/qa-memory` | Personal memory folder |

Plans and results written with `schemaVersion: 1` still load; they are mapped to version 2 when
read.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
