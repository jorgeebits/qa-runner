# Step 3 — Execute

- Fill `references/test-agent-prompt.md` and launch one general-purpose agent (model `sonnet`)
  per group. Its prompt lists only brief paths, credentials, and the tool.
- Run groups **one at a time**. The Playwright MCP drives one shared browser, so parallel agents
  steal each other's tabs. Launch the next group when the previous one notifies.
- Each agent replies with one line per case. Don't read its transcript, the evidence, or the
  result files into this session; run `$Q status <runId>` instead.
- If `init` printed `secret needed: env:NAME`, put that variable's value in the prompt next to
  the password, labeled with the same `env:NAME`.
- An agent may stop and wait on a question (`ask`). The human answers in the viewer. If an agent
  comes back `blocked` with `needs-input`, run `$Q questions <runId>`, ask the human, record the
  answer with `$Q answer …`, and retest.
- If an agent dies mid-group, `$Q mark <runId> <tcId> pending` the unfinished cases and relaunch
  the group with only those briefs.
- Project skills listed in `.qa/config.json → capabilities` (login, navigation, bug filing…)
  appear in every brief by name only. The agent loads one when a step needs it. If the agent
  cannot invoke skills in your setup, run the login skill yourself before launching it.
