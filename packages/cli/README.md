# davecode

**Local-first autonomous software engineer and multi-provider AI gateway.**

One OpenAI-compatible endpoint in front of Claude, GPT, Gemini and your local models (Ollama,
LM Studio, OpenRouter…), with quota-aware routing and hot failover, plus an engine that turns a
task graph into tested, merged code.

```bash
npm install -g davecode      # Node.js 22.12+

davecode doctor              # check your environment
davecode accounts add        # add a provider account (API key, Ollama, Claude Code login…)
davecode start               # gateway on http://localhost:4040/v1 + dashboard at http://localhost:4040/
davecode                     # chat TUI in your terminal
davecode init && davecode run   # let the autonomous runner work through .davecode/TASK_GRAPH.json
```

Point any OpenAI SDK at `http://localhost:4040/v1` and use the model `davecode/auto`.

Features that may violate a provider's Terms of Service (Gemini web automation, rotating several
subscription logins) are **disabled by default**.

Documentation, architecture and source: <https://github.com/DMRLZZ/DaveCode>

MIT © DaveCode contributors
