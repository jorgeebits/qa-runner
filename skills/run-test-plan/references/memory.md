# Memory

Facts a human confirmed once (a test value, a workaround, a quirk of the environment) that later
runs reuse instead of asking again.

## Where it lives

One Markdown file per memory, with JSON header values:

- `.qa/memory/` — shared with the project; commit it and review changes in pull requests.
- `~/.claude/qa-memory/` — personal (`QA_USER_MEMORY_DIR` overrides).

Kinds: `data` (a value), `procedure` (how to get past something), `env-quirk` (applies to any
step in that variant, e.g. a banner to dismiss), `gotcha`. A `scope.variants` limits a memory to
matching cases. Statuses: `proposed` (waiting for a human), `active`, `stale` (failed twice or
retired; not offered).

## How it fills up

1. **Live questions.** A Test Agent missing a value runs `$Q ask <run> <tc> --field … --context …`
   and waits (5 min by default). The viewer shows the question on the case. The human answers
   there and can tick "Remember for this project / just for me". From the terminal, use
   `$Q questions <run>` and `$Q answer <run> <tc> <qid> <value> [--remember project]`. On
   timeout the case ends `blocked` with `blockedReason: "needs-input"`. A later
   `init --retest` copies the answers into the new briefs.
2. **Learnings.** Agents put reusable findings in `result.json → learnings`. `validate` imports
   them as `proposed`; the reviewer approves or rejects them in the viewer's Memory panel
   (shortcut `m`).
3. **By hand.** `$Q memory add --text … [--value …] [--variants '{…}'] [--triggers a,b]`.
4. **Chat.** The viewer's chat agent can only propose memories, never approve them.

## How it is used

- `init` puts at most 10 one-line pointers per brief (`.qa/config.json → memory.briefLimit`),
  ranked by shared words, trigger phrases and matching variants. Full entries are not copied.
- Agents run `$Q memory recall "<need>" --run R --tc T` when they hit something unexpected.
- Agents report `$Q memory used <id> [--failed]`. Two failures turn a memory `stale`.
- `$Q memory prune [--yes]` deletes stale and expired memories.

## Secrets and personal data

Memory never stores a secret. A value whose description mentions a password, PIN, token or key is
refused. So is anything that looks like a card or account number. Store
`--secret-ref env:NAME` instead: `init` lists the variables the briefs need, and you put their
values in the agent prompt like the password. Answers marked **Sensitive** in the viewer reach the
waiting agent once, are saved as `***`, and cannot be remembered. `validate` rescans the memory
folders.
