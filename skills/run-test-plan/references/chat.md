# Chat with your agent

The viewer's **Chat with your agent** button (shortcut `t`) and each screenshot's chat icon open
a drawer scoped to the selected test case. The server runs one headless `claude -p` turn per
message and keeps the session id per case, so follow-ups continue the conversation.

The chat agent starts with a short system prompt (case id and file paths only) and no MCP
servers or slash commands. It opens the brief, result, plan or mark syntax only when a question
needs them. It can:

- read the run's files and images (Read, Glob, Grep);
- run `qa-runs.mjs annotate`, its only write path, to mark or re-focus screenshots.

It cannot edit results, verdicts or code, drive the browser, or use MCP servers.

`QA_CHAT_MODEL` sets the model (default `sonnet`), `QA_CLAUDE_BIN` the binary. The drawer shows
the cost of each turn; "+" archives the conversation and starts a new one. Writes from the
browser need the viewer's `x-qa-viewer` header and its own origin, so another web page cannot
trigger the agent.
