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

## Next: Phase 3, memory

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
