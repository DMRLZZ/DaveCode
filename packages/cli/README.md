# davecode

**Local-first autonomous software engineer and multi-provider AI gateway.**

Run Claude Code, Codex and Gemini CLI side by side behind one OpenAI-compatible endpoint, with
quota-aware routing and hot failover, plus an engine that turns a task graph into tested, merged
code.

```bash
npm install -g @dmrlzz/davecode      # Node.js 22.12+

davecode                     # first run: sign in, pick a look, connect your first agent
davecode doctor              # check your environment
davecode accounts add        # add another agent or API key (Claude Code, Codex, OpenRouter…)
davecode accounts connect <id>  # sign a subscription in with the vendor's official login
davecode start               # gateway on http://localhost:4040/v1 + dashboard at http://localhost:4040/
davecode                     # chat TUI in your terminal
davecode init && davecode run   # let the autonomous runner work through .davecode/TASK_GRAPH.json
davecode goal "<objective>"  # a team of agents plans, executes, reviews and re-plans
davecode budget              # plans, renewals and remaining quota per account
```

Point any OpenAI SDK at `http://localhost:4040/v1` and use the model `davecode/auto`.

Codex CLI 0.163.0 and Claude Code 2.1.309 passed live adapter checks on Windows.
Gemini CLI 0.65.0 completed official Google sign-in, but its backend rejected the client with
`UNSUPPORTED_CLIENT`; successful Gemini subscription completion remains unverified.
See [verification details](https://github.com/DMRLZZ/DaveCode/blob/main/docs/PROVIDER-VERIFICATION.md).

Features that may violate a provider's Terms of Service (Gemini web automation, rotating several
subscription logins) are **disabled by default**.

Documentation, architecture and source: <https://github.com/DMRLZZ/DaveCode>

MIT © DaveCode contributors
