# Using free-llm-router with claude-code-router (and other OpenAI-compatible clients)

[claude-code-router](https://github.com/musistudio/claude-code-router) lets you point Claude Code at any OpenAI-compatible provider. free-llm-router can be that provider, so one upstream 429 does not stop a session.

## 1. Run the router

```bash
node src/server.js --port 8787 --config router.config.json
```

## 2. Add it as a provider

In claude-code-router's `config.json` (`~/.claude-code-router/config.json`), add a provider that targets the router. Field names follow that project's documented format; check its README if your version differs.

```json
{
  "Providers": [
    {
      "name": "free-llm-router",
      "api_base_url": "http://localhost:8787/v1/chat/completions",
      "api_key": "unused-unless-ROUTER_TOKEN-is-set",
      "models": ["fast", "smart", "long-context"]
    }
  ],
  "Router": {
    "default": "free-llm-router,smart",
    "background": "free-llm-router,fast",
    "longContext": "free-llm-router,long-context"
  }
}
```

The aliases map naturally: `fast` for background tasks, `smart` for the default model, `long-context` for big prompts.

## Honest limits

- Free-tier models are not Claude. Tool-calling quality and context handling vary by model; expect weaker agentic behaviour than a paid frontier model.
- The router estimates prompt size (roughly 4 characters per token) to skip models whose context window is too small; it is an estimate, not a tokenizer.
- This page describes the integration shape; it was not tested against a specific claude-code-router release.

## Any other OpenAI-compatible client

Set the base URL to `http://localhost:8787/v1` and the model to an alias. See `examples/client.js` for a dependency-free example.
