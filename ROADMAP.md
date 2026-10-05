# Roadmap

## Done (0.1.0)

- **Phase 0, baseline.** Context the skill loads at start, measured at about 4 bytes/token:
  `SKILL.md` ~2,660 tokens, chat system prompt ~500 tokens.
- **Phase 1, context on demand.** `SKILL.md` is a ~720-token index; each step's detail lives in
  `references/` and is read when the workflow reaches it. The chat agent gets file paths only
  and loads the mark syntax with `annotate --help` the first time it needs it.
- **Phase 2, generic contract.** `schemaVersion: 2` plans and results with `targets`,
  free-form `variants`, `referenceCheck` and `issue`; project facts in `.qa/config.json`;
  version 1 files are mapped on load.
- **Packaging.** Claude Code plugin with its own marketplace manifest.

## Done (0.3.0): dashboard

- The viewer's home is a dashboard. KPI tiles show pass rate, failures, blocked cases, average
  agent time per case, reviewer agreement and questions to the human, each with a delta against
  the previous period. Charts show outcomes by run, agent time per run and outcomes by variant.
  Two tables list the cases that need attention (failing, blocked or flaky) and the slowest cases,
  followed by the recent runs.
- The runner keeps its own clock: `mark running` writes `timing.json` and the result file
  closes the case. Older runs are estimated and flagged. Waiting on a human is excluded from
  agent time.
- Chart fills use the status palette, stacked pass → blocked → fail so green never touches red
  (validated for color-vision deficiency). Identity always also rides on icons, labels and a
  table view.

- **Cost per run (0.4.0).** `qa-runs usage` prices each Test Agent group from its transcript's
  per-message usage (exact, at list prices in `scripts/pricing.mjs`). The completion notice's
  token count is not a billing quantity, so when a transcript is gone it is priced by
  calibration against groups that have both numbers, or left unknown. Chat turns add their own
  reported cost.

Candidate metrics that need data the runner does not record yet:

- **First-pass yield.** The share of cases that pass without a retest, which needs retest
  chains followed across runs.
- **Defect yield.** Real bugs filed per run, which needs the filed issue keys.

## Done (0.2.0): Phase 3, memory

Implemented as designed below (`scripts/memory.mjs`, `scripts/questions.mjs`,
`references/memory.md`), with these details settled during the build:

- Header values are JSON, so the format needs no YAML dependency.
- Sensitive answers reach the waiting agent once through a dot-file the server never serves,
  are saved as `***`, and cannot be remembered.
- A memory is refused when its description mentions a password, PIN, token or key, or when its
  value looks like a card or account number.
- The chat agent may list, recall and propose memories only (`QA_MEMORY_ROLE=chat`).
- `init --retest` copies the previous run's answers into the new briefs.
- Environment quirks scoped to a case's variants reach its brief even without shared words.

### Design

Goal: when a Test Agent needs a value it does not have and a human provides it, a future run in
a similar situation can reuse it without asking again.

**Store.** One Markdown file per memory under `.qa/memory/` (project, versioned and reviewed in
pull requests) or `~/.claude/qa-memory/` (personal):

```markdown
---
id: m-0042
kind: data            # data | procedure | env-quirk | gotcha
scope: { variants: { country: MX }, target: app }
triggers: ["manager override", "#managerId"]
value: "qa-manager-02"   # or secretRef: env:QA_MANAGER_PASSWORD, never the secret itself
source: { run: SHOP-42_20261005-162137, tc: TC-4, confirmedBy: human }
stats: { used: 3, failed: 0, lastUsed: 2026-10-05 }
expires: 2026-12-31
status: active        # proposed | active | stale
---
Manager override in MX stores: use this user.
```

**Learn.**

1. The agent hits an unknown input, writes `tc/<id>/question.json` (field, context, screenshot)
   and waits with `qa-runs wait-answer <run> <tc> --timeout 300`.
2. The viewer shows the question live. The human answers there, or the orchestrator asks in
   the terminal. A "Remember" checkbox picks the scope.
3. On timeout the case ends `blocked` with reason `needs-input`, and the retest picks it up once
   the question has an answer.
4. Agents may also propose `learnings[]` in `result.json`. They wait in a memory inbox in the
   viewer and become active only once a human approves them.

**Recall.**

- `init` runs `memory match`, which scores memories by variant, target, tags and step keywords,
  and puts at most about 10 one-line pointers in the brief, never full entries.
- At run time the agent calls `qa-runs memory recall "<query>"` only when it hits something
  unexpected. Lexical scoring (BM25-style, no dependencies) first; embeddings only if that falls
  short.
- When a recalled value fails, the agent reports it. After two failures the memory turns
  `stale`, and `memory prune` removes expired and stale entries.

**Guardrails.** Secrets only by reference (`secretRef`). Synthetic data only. `validate` scans
memory for credentials and personal data too.

## Later

- **Phase 4.** Plugin `agents/test-agent.md` with a restricted tool list, replacing the prompt
  template.
- **Phase 5.** One browser profile per agent so groups can run in parallel, plus measured token
  budgets per turn shown in the viewer.
