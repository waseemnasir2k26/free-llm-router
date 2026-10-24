# Using free-llm-router with n8n

Your n8n AI nodes speak the OpenAI API. Point them at the router and a 429 from one provider becomes a retry on the next one, inside the same request.

## 1. Start the router

```bash
export GROQ_API_KEY=...       # set only the providers you have
export GEMINI_API_KEY=...
node src/server.js --port 8787 --config router.config.json
```

If n8n runs in Docker and the router on the host, use `--host 0.0.0.0` and set `ROUTER_TOKEN` (see below), then use `http://host.docker.internal:8787/v1` as the base URL.

## 2. Create the credential

In n8n: Credentials -> New -> **OpenAI API**.

| Field    | Value                                                      |
| -------- | ---------------------------------------------------------- |
| API Key  | anything non-empty (or your `ROUTER_TOKEN` if you set one) |
| Base URL | `http://localhost:8787/v1`                                 |

## 3. Pick a model alias

In the OpenAI Chat Model / AI Agent node, set the model by expression or name to one of the aliases from `GET /v1/models`: `fast`, `smart`, `long-context` (they are defined in `router.config.json`).

> If the node insists on a model from its own dropdown, switch the model field to "By ID" / expression mode and type the alias.

## 4. Watch it work

```bash
curl -s localhost:8787/stats | node -e "process.stdin.on('data',d=>console.log(Object.entries(JSON.parse(d).models).map(([k,v])=>k+' served='+v.served+' rpd_left='+v.rpd_remaining+' cooldown='+v.cooldown_until).join('\n')))"
```

The response header `x-router-provider` tells you which provider answered each call.

## Protecting the router

Set `ROUTER_TOKEN=some-long-random-string` before starting. Every route except `/healthz` then requires `Authorization: Bearer <token>`; put the same token in the n8n credential's API Key field.

## What it will not do

- It will not call a model that is not flagged `free: true` in the config, and there is no flag to change that.
- It cannot raise a provider's free quota. When every provider in an alias is exhausted you get a `503` with a `Retry-After` header; build a retry/wait branch for that case.

Background thread on the failure mode this exists for: https://community.n8n.io/t/308453
