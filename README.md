# free-llm-router: OpenAI-compatible proxy for free LLM APIs (Groq, Gemini, OpenRouter, Cerebras, Mistral)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-blue.svg)

**Your n8n workflow died at 2am on a Gemini 429. This keeps it alive on free tiers.**

A zero-dependency, single-process proxy that speaks the OpenAI API and chains the free tiers of Groq, Gemini, OpenRouter, Cerebras and Mistral behind virtual model names (`fast`, `smart`, `long-context`). It tracks each provider's quotas, honors `Retry-After`, fails over on 429/5xx, and refuses to call anything that is not flagged free.

Background on the failure mode: [community.n8n.io/t/308453](https://community.n8n.io/t/308453).

## 60-second quickstart

```bash
git clone https://github.com/waseemnasir2k26/free-llm-router.git
cd free-llm-router

# set the keys you have (any subset works; keys are read from env only)
export GROQ_API_KEY=...
export GEMINI_API_KEY=...

node src/server.js --port 8787 --config router.config.json
```

```bash
curl -si localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"Say hi in five words"}]}'
# look for the header:  x-router-provider: groq
```

Now point any OpenAI client at `http://localhost:8787/v1`. For n8n, see [docs/n8n.md](docs/n8n.md); for claude-code-router, see [docs/claude-code-router.md](docs/claude-code-router.md). Docker: see the `Dockerfile`.

Requires Node 20+. No `npm install` needed: there are no dependencies.

## Features

| Feature                        | How it works                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible              | `POST /v1/chat/completions` (JSON and SSE streaming), `GET /v1/models`                                                       |
| Virtual model aliases          | `fast`, `smart`, `long-context` are ordered provider chains in `router.config.json`                                          |
| Quota tracking                 | Token buckets for RPM and TPM, a UTC-day counter for RPD, per model, from config                                             |
| 429 failover                   | Honors `Retry-After` (seconds or HTTP date) and moves to the next provider in the same request                               |
| 5xx / network cooldown         | Exponential cooldown (base 15 s, doubling, capped at 1 h by default)                                                         |
| Removed-model detection        | A "model not found / decommissioned" answer marks the model `removed` and skips it until a TTL (default 24 h) expires        |
| Context-window check           | Skips models whose context window is below the estimated prompt size (about 4 chars per token; an estimate, not a tokenizer) |
| Paid guard                     | Only models with `free: true` are ever called. Anything else gets a 403. There is deliberately no `--paid-ok` flag           |
| Streaming integrity            | SSE bytes are copied from upstream to client untouched; failover only happens before the first byte                          |
| Persistence                    | Daily counters, cooldowns and removals are saved to a JSON file and survive restarts                                         |
| Observability                  | `GET /stats`, `GET /healthz`, response headers `x-router-provider` and `x-router-model`                                      |
| Key hygiene                    | Keys come from env vars only; every log line is redacted (covered by tests)                                                  |
| Optional auth                  | Set `ROUTER_TOKEN` to require `Authorization: Bearer <token>` on every route except `/healthz`                               |
| Safe default bind              | Listens on `127.0.0.1`; refuses any other `--host` without `ROUTER_TOKEN` (Docker included) unless you pass `--insecure`    |
| Any OpenAI-compatible endpoint | A `generic` adapter takes a `base_url` and `api_key_env` for other providers                                                 |

## Real demo output

This is the output of `node examples/demo-mock.js`, which runs the real router against two **local mock upstreams** (the first answers `429 Retry-After: 30`, the second answers 200). It needs no keys and makes no network calls:

```text
GET /v1/models -> ["fast"]
request 1: HTTP 200  x-router-provider=gemini  -> Hello from the fallback provider.
request 2: HTTP 200  x-router-provider=gemini  -> Hello from the fallback provider.
stats groq/llama-3.1-8b-instant: served=0 rpd_used=1 cooldown_until=2026-10-11T23:46:53.273Z last_error=429
stats gemini/gemini-2.5-flash-lite: served=2 rpd_used=2 cooldown_until=null last_error=null
```

Request 1 hit the first provider once, got the 429, and fell through inside the same HTTP call. Request 2 never touched the cooling-down provider. (`cooldown_until` is the demo run's wall clock plus the 30 s the mock asked for; your timestamp will differ.)

Not shown here: calls against the real provider APIs. The automated tests use mock upstreams too, so live behaviour depends on each provider's current API and limits.

## Endpoints

| Route                       | What it returns                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | Proxied chat completion. `model` is an alias (or a model id from the config)                                               |
| `GET /v1/models`            | The virtual aliases                                                                                                        |
| `GET /stats`                | Per model: served, attempts, RPM/TPM available, RPD used/remaining, cooldown and removal timestamps, last error (redacted) |
| `GET /healthz`              | `{"ok":true}`                                                                                                              |

Errors use the OpenAI error shape. `503 all_providers_unavailable` includes a `Retry-After` header and a `tried` list. `403 paid_model_refused` and `404 model_not_found` never reach an upstream.

## Free-tier limits table

Defaults shipped in [`router.config.example.json`](router.config.example.json). Every entry carries a `source` URL and a `last_verified` date.

| Provider   | Model (alias use)                          | RPM | RPD    | TPM     | Context   | Source                                                         | last_verified |
| ---------- | ------------------------------------------ | --- | ------ | ------- | --------- | -------------------------------------------------------------- | ------------- |
| Groq       | llama-3.1-8b-instant (fast)                | 30  | 14,400 | 6,000   | 131,072   | [docs](https://console.groq.com/docs/rate-limits)              | 2026-10-12    |
| Groq       | llama-3.3-70b-versatile (smart)            | 30  | 1,000  | 12,000  | 131,072   | [docs](https://console.groq.com/docs/rate-limits)              | 2026-10-12    |
| Gemini     | gemini-2.5-flash (smart, long-context)     | 10  | 250    | 250,000 | 1,048,576 | [docs](https://ai.google.dev/gemini-api/docs/rate-limits)      | 2026-10-12    |
| Gemini     | gemini-2.5-flash-lite (fast, long-context) | 15  | 1,000  | 250,000 | 1,048,576 | [docs](https://ai.google.dev/gemini-api/docs/rate-limits)      | 2026-10-12    |
| OpenRouter | llama-3.3-70b-instruct:free (smart)        | 20  | 50     | n/a     | 65,536    | [docs](https://openrouter.ai/docs/api-reference/limits)        | 2026-10-12    |
| Cerebras   | llama-3.3-70b (fast, smart)                | 30  | 14,400 | 60,000  | 65,536    | [docs](https://inference-docs.cerebras.ai/support/rate-limits) | 2026-10-12    |
| Mistral    | mistral-small-latest (fast)                | 60  | n/a    | 500,000 | 32,000    | [docs](https://docs.mistral.ai/)      | 2026-10-12    |

**Honest disclaimer: free tiers change, often without notice.** These numbers are conservative starting points written from the providers' public documentation as the author understood it on the date shown. They were **not** re-checked against live dashboards when this was released, and your account, region or tier may differ. Free models also get renamed and retired (the router handles that by marking them `removed`, but you still need to update the config). Check each source link and edit `router.config.json` before relying on a number. Some providers also limit by account rather than by key, which a per-process counter cannot see.

## Configuration

Copy `router.config.example.json` to `router.config.json` (a copy is already included). Each model looks like:

```json
{
  "id": "groq/llama-3.1-8b-instant",
  "provider": "groq",
  "model": "llama-3.1-8b-instant",
  "free": true,
  "context_window": 131072,
  "limits": { "rpm": 30, "rpd": 14400, "tpm": 6000 },
  "source": "https://console.groq.com/docs/rate-limits",
  "last_verified": "2026-10-12"
}
```

Aliases are just ordered lists of model ids: `"fast": ["groq/llama-3.1-8b-instant", "cerebras/llama-3.3-70b"]`. Order is priority. Environment variables: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, optional `ROUTER_TOKEN`. A provider with no key set is skipped. The config file is trusted input: it sets upstream base URLs and file paths, so don't load one you didn't write.

CLI: `--port` (default 8787), `--host` (default 127.0.0.1), `--config`, `--state`.

## Tests

```bash
node --test
```

34 tests, 140+ assertions, using mock upstream HTTP servers: 429 with `Retry-After` failover, 5xx exponential cooldown, removed-model skipping and TTL, RPD exhaustion, RPM spill-over, context-window skipping, the paid-model guard (403, upstream never called), streaming byte-for-byte integrity, log/response redaction of keys, and state persistence across restarts. Run them with `npm test`.

## FAQ

**Is this really free?** The router costs nothing and calls only models you flag `free: true`. Whether a provider's free tier stays free is up to the provider; check their terms.

**Does it break any provider's terms?** It uses your own API keys against the providers' official endpoints. You are responsible for staying within each provider's terms, including any rules about running several accounts or keys.

**Can it call paid models if I want?** No. Models without `free: true` are refused with a 403 and never called, and there is no flag to override that. Editing the config to mark a paid model free is on you.

**Why not LiteLLM or a hosted gateway?** Those are far more capable and also heavier. This is a single file set you can read in ten minutes, built around one job: staying inside free-tier quotas.

**What happens when every free tier is exhausted?** You get `503` with `Retry-After`. Handle it in your workflow with a wait or a fallback.

**Does failover work mid-stream?** No. Once the first byte has been sent to your client the response is committed; failover applies before that.

**Is state shared across several router instances?** No. Counters live in one process and one JSON file.

**Does it support embeddings, images or tool calls?** Only `/v1/chat/completions` is routed. Request bodies are forwarded as-is (with the model name swapped), so fields such as `tools` reach the provider, but support differs per model.

## More from SkynetLabs

- [n8n-circuit-breaker-pack](https://github.com/waseemnasir2k26/n8n-circuit-breaker-pack): circuit-breaker patterns for n8n workflows
- [mcp-spend-guard](https://github.com/waseemnasir2k26/mcp-spend-guard): keep MCP tool spend under control
- [upwork-mcp-toolkit](https://github.com/waseemnasir2k26/upwork-mcp-toolkit): offline job scoring and proposal tooling for the official Upwork MCP

## Work with SkynetLabs

Built by [Waseem Nasir](https://www.skynetjoe.com/?utm_source=github&utm_medium=readme&utm_campaign=free-llm-router) at SkynetLabs — n8n + AI automation for small businesses.

**Want your agent stack running at $0 API spend? Hire SkynetLabs.**

- Hire on Fiverr: https://www.fiverr.com/agencies/skynetjoellc
- Hire on Upwork: https://www.upwork.com/freelancers/muhammadwaseemnasir
- Book a free call: https://wa.me/6281316077185

## License

MIT. See [LICENSE](LICENSE).
