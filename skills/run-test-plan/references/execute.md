# Step 3 — Execute

`init` already decided who runs what: it cut the plan into **batches** (one group's cases, at most
`execution.maxCasesPerAgent` per agent), gave each a **tier** and a model/effort, and wrote it all
to `schedule.json`. Your job is only to launch what `$Q next` prints and to report back.

## The loop

1. `$Q next <runId>` prints one `LAUNCH` block per batch that can start now, then `WAIT` or `DONE`.
2. For **every** `LAUNCH` block, in one message, start an agent with exactly what it says:
   `subagent_type`, `model`, `effort`, `run_in_background: true`, and the text between
   `<<<PROMPT` and `PROMPT>>>` as the prompt, after replacing `{{PASSWORD …}}` with the password
   (the human's, or the value of the `env:NAME` it names). Never put the password anywhere else.
3. When an agent notifies, **before anything else** record its cost; this also marks the batch
   done (the harness may clear the transcript later, so don't wait):
   `$Q usage <runId> --batch <batch> --transcript <output_file> --tokens <subagent_tokens> --tool-uses <n> --ms <duration_ms>`.
   Never Read the transcript into this session.
4. Run `$Q next <runId>` again and launch what it prints. Repeat until `DONE`.

`next` also **escalates**: a case a `haiku` batch finished as fail, blocked (not `needs-input`),
unfinished, or with contract warnings is re-run once on the standard tier; the first attempt
moves to `tc/<id>/attempts/`. You just launch the `~esc` batch like any other.

## Rules

- Don't read results, evidence or briefs here; `$Q status <runId>` gives one line per case.
- Don't change the model, effort or batch an agent gets: routing lives in the plan
  (`testCases[].agent`, `defaults.agent`) and `.qa/config.json → execution.tiers`.
- `subagent_type` `qa-runner:test-agent-N` is the plugin's agent bound to browser N. If those
  agent types are not in your list (the skill was installed without the plugin), run
  `$Q next <runId> --fallback` instead: one `general-purpose` agent at a time on the `playwright`
  MCP server, with the agent's rules inside the prompt.
- An agent may stop and wait on a question (`ask`); the human answers in the viewer. If a case
  comes back `blocked` with `needs-input`, run `$Q questions <runId>`, ask the human, record the
  answer with `$Q answer …`, and retest.
- If an agent dies mid-batch: `$Q next <runId> --release <batch>` puts its unfinished cases
  back, then launch what it prints.
- If `init` printed `secret needed: env:NAME`, put that variable's value in the prompt next to
  the password, labeled with the same `env:NAME`.
- Project procedures in `.qa/config.json → capabilities` reach every brief as a file path; the
  agent reads one only when a step needs it.

## Models and effort (what `init` picks)

| Tier | When | Default |
|---|---|---|
| simple | ≤ 6 read-only steps, no reference check, no recording, no recent failure | `haiku` / `medium` |
| standard | changes data, 7–10 steps, records video, non-default tool; escalations | `sonnet` / `medium` |
| complex | reference check `always`, > 10 steps, failed or rejected recently | `sonnet` / `high` |

A batch takes its hardest case's tier. Override per case or plan with
`"agent": { "complexity": "simple" | "standard" | "complex", "model": "…", "effort": "…" }`,
or per project in `.qa/config.json → execution.tiers`.

## Parallel runs

Up to `execution.maxParallel` batches (default 3, the pool size) run at once, each in its own
isolated browser. When the app allows one session per user (`execution.sessions: "exclusive"`,
the default), each running batch needs its own account from `execution.accounts`; with only the
plan's login, batches run one at a time. Chunks of one group always run in order, and cases
tagged `serial` never run alongside another `serial` case.
