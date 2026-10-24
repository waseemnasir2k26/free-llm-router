"use strict";

const adapters = {
  generic: require("./generic"),
  groq: require("./groq"),
  gemini: require("./gemini"),
  openrouter: require("./openrouter"),
  cerebras: require("./cerebras"),
  mistral: require("./mistral"),
};

/**
 * Resolve a provider entry from config. The adapter defaults to the provider name,
 * or "generic" for any other OpenAI-compatible endpoint (needs base_url + api_key_env).
 */
function resolveProvider(name, cfg = {}) {
  const adapter = adapters[cfg.adapter || name] || adapters.generic;
  const base_url = String(cfg.base_url || adapter.base_url || "").replace(
    /\/+$/,
    "",
  );
  const api_key_env = cfg.api_key_env || adapter.api_key_env;
  if (!base_url) throw new Error(`provider "${name}" needs a base_url`);
  if (!api_key_env) throw new Error(`provider "${name}" needs an api_key_env`);
  return { name, adapter, base_url, api_key_env, cfg };
}

module.exports = { adapters, resolveProvider };
