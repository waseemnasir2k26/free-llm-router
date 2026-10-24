# Changelog

## 1.0.0 - 2026-10-12

- Initial release.
- OpenAI-compatible `POST /v1/chat/completions` (streaming SSE passthrough and non-streaming), `GET /v1/models`, `GET /stats`, `GET /healthz`.
- Declarative alias chains over Groq, Gemini (OpenAI-compatible endpoint), OpenRouter, Cerebras and Mistral adapters, plus a generic adapter for any OpenAI-compatible endpoint.
- Token buckets for RPM / TPM, UTC-day counter for RPD, `Retry-After` support, exponential cooldown on 429/5xx, `removed` marking on model-not-found with a TTL.
- Context-window pre-check, hard free-model allowlist (403 for anything not `free: true`), JSON state persistence, key redaction in logs.
- node:test suite with mock upstream servers; CI on Linux, macOS and Windows.
