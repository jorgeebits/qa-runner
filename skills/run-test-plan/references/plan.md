# Step 1 — Plan

- Reuse `.qa/plans/<KEY>.plan.json` when it exists; update it rather than writing a new one.
- Otherwise read the ticket (description, latest comments, blocking bugs) and draft the plan
  following `schemas/test-plan.schema.json` (`schemaVersion: 2`).
- If behaviour forks by a variant (country, role, plan tier…) or the comparison with the
  reference app is unclear, spawn ONE read-only research agent (model `sonnet`, effort `low`) to study the code
  and write a discovery file of at most 120 lines next to the plan, replying in at most 15 lines.
  List that file in `references` with a section hint, so Test Agents read only their slice.
- One `group` per set of cases that share a login and variant, so one agent and one login serve
  the group. Different groups may run in parallel; tag a case `serial` if it must not run while
  another `serial` case runs (shared test data). Put "never do X" rules in `guardrails`.
- Tag cases `readonly` or `writes` when the steps' wording does not make it obvious: `init`
  routes short read-only cases to a cheaper model, and anything that changes data to Sonnet.
  Set `agent.complexity` (or `model`/`effort`) only to overrule that routing.
- `variants` keys and values must match `.qa/config.json`; `init` rejects unknown ones.
- `environment.targets.app` is the system under test; add `targets.reference` only when results
  should be compared against another app, and pick `referenceCheck` per case.
- Synthetic data only. No credentials in the plan: `environment.user` holds the login user, the
  password goes only in the agent prompt.
- Show the human the case list (id, title, group, variants, record yes/no) and get approval
  before running. Ask for the password if you don't have it.
