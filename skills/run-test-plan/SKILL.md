---
name: run-test-plan
description: Use when asked to execute QA test cases or a test plan (an issue-tracker test ticket, "run the test cases", "corre los test cases", "ejecuta el plan", retest a ticket) against a web app with browser agents, with a local viewer showing each case's result, evidence, and optional recording. Also use to reopen the viewer or retest the cases a reviewer rejected.
---

# Run Test Plan

Browser Test Agents execute manual-style E2E cases; a local viewer shows results; a human
reviews. You (the orchestrator) plan and consolidate. Everyone talks through files with a fixed
contract, so no agent needs the conversation and this session never holds evidence.

```
plan.json ──init──▶ tc/<id>/brief.md ──Test Agent──▶ tc/<id>/result.json + evidence/
   ▲                                                         │
   └──── retest ◀── review.json ◀── viewer (human) ◀── validate (contract warnings)
```

`$Q` below means `node <this skill's base directory>/scripts/qa-runs.mjs`, run from the project
root. Runs go to `.qa/runs/<runId>/`, plans to `.qa/plans/`, project settings to
`.qa/config.json` (`schemas/config.schema.json`). No dependencies; recording needs `ffmpeg`.

## Workflow

Read each step's reference **when you reach that step**, not before.

1. **Plan** → `references/plan.md`. Reuse or draft `.qa/plans/<KEY>.plan.json`, then get the
   human's approval of the case list before running.
2. **Init + viewer** → `$Q init <plan> [--label txt] [--record] [--only TC-1,TC-2]`, then
   `$Q open <runId>`. Open the viewer before launching agents: recording streams to it, and
   agents ask the human through it. `init` adds relevant memories to each brief, schedules the
   batches with their model and effort, and lists any `secret needed: env:NAME` you must pass
   in the agent prompt.
3. **Execute** → `references/execute.md`. Launch exactly what `$Q next <runId>` prints (agent,
   model, effort, prompt; several at once when it lists several), record each batch with
   `$Q usage --batch` the moment it finishes, and call `next` again until `DONE`.
   Never read agent transcripts, evidence or results here; use `$Q status <runId>`.
4. **Validate** → `$Q validate <runId>`. Fix credential leaks yourself; send other warnings back
   to the agent or flag them to the reviewer. Never edit a result to look better.
5. **Review + report** → `references/review.md`. The human approves, rejects or asks for a
   retest in the viewer; `$Q init <plan> --retest <runId>` reruns exactly those cases.

This orchestration is bookkeeping: the scripts decide routing, so a session on Sonnet at
medium effort runs it as well as a larger model. Spend effort on drafting the plan, not here.

Only when needed: `references/memory.md` (what agents remember, live questions, secrets),
`references/recording.md` (video), `references/annotate.md` (screenshot marks),
`references/chat.md` (the viewer's agent chat).

## Guardrails

- Viewer and server are local only (`127.0.0.1`). Keep `.qa/runs/` out of version control.
- Never write credentials into plans, briefs, results, evidence, or memory. `validate` scans
  for leaks; memory holds secrets only as `env:NAME` references.
- Nothing an agent learns is reused until a human approves it.
- Synthetic test data only. Screenshots are blurred only when `.qa/config.json → evidence.blurPersonalData`
  is true (environments that show real customer data); test environments leave it off.
- Don't post to the issue tracker or transition a ticket without explicit confirmation.
- Keep the viewer generic: run facts belong in plans and results, project facts in
  `.qa/config.json`. If a contract changes, bump `schemaVersion` and keep reading older runs.
