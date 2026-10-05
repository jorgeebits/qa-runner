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
- **Local viewer.** Live progress, screenshots with non-destructive marks (arrows, boxes,
  spotlight, blur), recordings, a per-case agent chat, and Approve / Needs retest / Reject.
- **Reference comparison.** Optionally compare each case against another app (legacy,
  production, a design) and report deviations.
- **Memory.** When an agent needs a value it does not have, it asks you in the viewer and waits.
  Tick "Remember" and later runs in the same situation reuse the answer. Agents also propose
  what they learned; nothing is reused until you approve it. Secrets are stored only as
  `env:NAME` references.

## Requirements

- Claude Code with the Playwright MCP server configured
- Node.js 20+ (no npm dependencies)
- `ffmpeg` on the PATH, only for recordings

## Install

```bash
claude plugin marketplace add <path-or-git-url-of-this-repo>
claude plugin install qa-runner@qa-runner
```

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
