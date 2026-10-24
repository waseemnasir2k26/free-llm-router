"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TokenBucket, DailyCounter } = require("./buckets");
const { resolveProvider } = require("./providers");

class RouterError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const DEFAULTS = {
  removed_ttl_seconds: 86400,
  cooldown_base_seconds: 15,
  cooldown_max_seconds: 3600,
  request_timeout_ms: 60000,
  default_output_tokens: 256,
};

const MODEL_GONE_RE =
  /model_not_found|model_decommissioned|model[^"\n]{0,80}(not found|does not exist|decommissioned|no longer (supported|available)|not supported)/i;

function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return Math.max(0, d - nowMs);
  return null;
}

/** Rough prompt-size estimate (about 4 characters per token). */
function estimatePromptTokens(body) {
  let chars = 0;
  try {
    chars += JSON.stringify(body.messages || []).length;
  } catch {
    /* ignore */
  }
  if (body.tools) {
    try {
      chars += JSON.stringify(body.tools).length;
    } catch {
      /* ignore */
    }
  }
  return Math.ceil(chars / 4);
}

class Router {
  constructor({
    config,
    env = process.env,
    now = Date.now,
    fetchImpl,
    redact,
    logger,
    stateFile,
  } = {}) {
    if (!config || typeof config !== "object")
      throw new Error("config required");
    this.config = { ...DEFAULTS, ...config };
    this.env = env;
    this.now = now;
    this.fetch = fetchImpl || globalThis.fetch;
    this.redact = redact || ((s) => s);
    this.log = logger || { info() {}, warn() {}, error() {} };
    this.stateFile = stateFile || null;
    this.providers = new Map();
    this.models = new Map();
    this.aliases = new Map();
    this._build();
    this._loadState();
  }

  _build() {
    const c = this.config;
    for (const [name, pcfg] of Object.entries(c.providers || {})) {
      this.providers.set(name, resolveProvider(name, pcfg));
    }
    for (const m of c.models || []) {
      if (!m.id || !m.provider || !m.model)
        throw new Error("every model needs id, provider, model");
      if (!this.providers.has(m.provider))
        throw new Error(`model ${m.id}: unknown provider ${m.provider}`);
      const lim = m.limits || {};
      const st = {
        cfg: m,
        free: m.free === true, // anything else is treated as paid and never called
        rpm: lim.rpm ? new TokenBucket(lim.rpm, 60000, this.now) : null,
        tpm: lim.tpm ? new TokenBucket(lim.tpm, 60000, this.now) : null,
        rpd: lim.rpd ? new DailyCounter(lim.rpd, this.now) : null,
        fails: 0,
        cooldownUntil: 0,
        removedUntil: 0,
        lastError: null,
        served: 0,
        attempts: 0,
      };
      this.models.set(m.id, st);
    }
    for (const [alias, ids] of Object.entries(c.aliases || {})) {
      for (const id of ids)
        if (!this.models.has(id))
          throw new Error(`alias ${alias}: unknown model ${id}`);
      this.aliases.set(alias, ids);
    }
  }

  // ---- persistence ----
  _loadState() {
    if (!this.stateFile) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return;
    }
    if (!saved || typeof saved !== "object" || !saved.models) return;
    for (const [id, s] of Object.entries(saved.models)) {
      const st = this.models.get(id);
      if (!st) continue;
      if (st.rpd) st.rpd.load(s.daily);
      st.cooldownUntil = Number(s.cooldownUntil) || 0;
      st.removedUntil = Number(s.removedUntil) || 0;
      st.fails = Number(s.fails) || 0;
      st.lastError = s.lastError || null;
      st.served = Number(s.served) || 0;
    }
  }

  persist() {
    if (!this.stateFile) return;
    const out = {
      version: 1,
      saved_at: new Date(this.now()).toISOString(),
      models: {},
    };
    for (const [id, st] of this.models) {
      out.models[id] = {
        daily: st.rpd ? st.rpd.toJSON() : null,
        cooldownUntil: st.cooldownUntil,
        removedUntil: st.removedUntil,
        fails: st.fails,
        lastError: st.lastError,
        served: st.served,
      };
    }
    try {
      fs.mkdirSync(path.dirname(path.resolve(this.stateFile)), {
        recursive: true,
      });
      const tmp = this.stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      this.log.warn("state persist failed", { error: String(e.message) });
    }
  }

  // ---- resolution ----
  listAliases() {
    return [...this.aliases.keys()];
  }

  resolve(name) {
    const c = this.config;
    const requested = name || c.default_alias;
    if (!requested)
      throw new RouterError(
        400,
        "model_required",
        'request needs a "model" (an alias from GET /v1/models)',
      );
    if (this.aliases.has(requested))
      return { requested, ids: this.aliases.get(requested) };
    const direct = this.models.get(requested);
    if (direct) {
      if (!direct.free) {
        throw new RouterError(
          403,
          "paid_model_refused",
          `model "${requested}" is not flagged free:true; this router only calls free-tier models and has no override`,
        );
      }
      return { requested, ids: [requested] };
    }
    throw new RouterError(
      404,
      "model_not_found",
      `unknown model "${requested}"; use one of: ${this.listAliases().join(", ")}`,
    );
  }

  // ---- candidate filtering ----
  _skipReason(id, st, estPrompt, estTotal) {
    const now = this.now();
    const p = this.providers.get(st.cfg.provider);
    if (!st.free) return { reason: "not_free", waitMs: Infinity };
    if (!this.env[p.api_key_env])
      return { reason: "no_api_key", waitMs: Infinity };
    if (st.removedUntil > now)
      return { reason: "removed", waitMs: st.removedUntil - now };
    if (st.cooldownUntil > now)
      return { reason: "cooldown", waitMs: st.cooldownUntil - now };
    if (st.cfg.context_window && estPrompt > st.cfg.context_window)
      return { reason: "context_too_small", waitMs: Infinity };
    if (st.tpm && estTotal > st.tpm.capacity)
      return { reason: "tpm_too_small", waitMs: Infinity };
    if (st.rpm && !st.rpm.canTake(1))
      return { reason: "rpm", waitMs: st.rpm.waitMs(1) };
    if (st.rpd && !st.rpd.canTake(1))
      return { reason: "rpd_exhausted", waitMs: st.rpd.waitMs() };
    if (st.tpm && !st.tpm.canTake(estTotal))
      return { reason: "tpm", waitMs: st.tpm.waitMs(estTotal) };
    return null;
  }

  _cooldown(st, retryAfterMs, errText, status) {
    const c = this.config;
    st.fails += 1;
    let ms = retryAfterMs;
    if (ms === null || ms === undefined) {
      ms = Math.min(
        c.cooldown_base_seconds * 1000 * 2 ** (st.fails - 1),
        c.cooldown_max_seconds * 1000,
      );
    }
    ms = Math.min(ms, 86400000);
    st.cooldownUntil = this.now() + ms;
    st.lastError = {
      at: new Date(this.now()).toISOString(),
      status,
      message: this.redact(String(errText)).slice(0, 300),
    };
    return ms;
  }

  /**
   * Route one chat-completions request. Resolves with the first successful upstream
   * Response (not yet consumed) or throws RouterError. Failover only happens before
   * any byte is sent to the client.
   */
  async handle(body, { signal } = {}) {
    const { requested, ids } = this.resolve(body.model);
    const wantStream = body.stream === true;
    const estPrompt = estimatePromptTokens(body);
    const estTotal =
      estPrompt +
      (Number(body.max_tokens || body.max_completion_tokens) ||
        this.config.default_output_tokens);
    const tried = [];
    let minWait = Infinity;
    let sawFree = false;

    for (const id of ids) {
      const st = this.models.get(id);
      if (!st.free) {
        tried.push({ model: id, skipped: "not_free" });
        continue;
      }
      sawFree = true;
      const skip = this._skipReason(id, st, estPrompt, estTotal);
      if (skip) {
        tried.push({ model: id, skipped: skip.reason });
        if (skip.waitMs < minWait) minWait = skip.waitMs;
        continue;
      }
      // reserve quota
      if (st.rpm) st.rpm.take(1);
      if (st.tpm) st.tpm.take(estTotal);
      if (st.rpd) st.rpd.take(1);
      st.attempts += 1;

      const prov = this.providers.get(st.cfg.provider);
      const key = this.env[prov.api_key_env];
      const payload = prov.adapter.prepareBody(body, st.cfg, prov.cfg);
      let resp;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(
        () => ac.abort(new Error("upstream timeout")),
        this.config.request_timeout_ms,
      );
      try {
        resp = await this.fetch(prov.base_url + "/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: wantStream ? "text/event-stream" : "application/json",
            ...prov.adapter.headers(key),
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (signal && signal.aborted)
          throw new RouterError(499, "client_closed", "client closed request");
        const ms = this._cooldown(st, null, `network error: ${e.message}`, 0);
        tried.push({ model: id, failed: "network", cooldown_ms: ms });
        this.log.warn("upstream network error", {
          model: id,
          error: e.message,
        });
        this.persist();
        continue;
      }
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);

      if (resp.ok) {
        st.fails = 0;
        st.cooldownUntil = 0;
        st.served += 1;
        this.persist();
        return {
          requested,
          id,
          provider: st.cfg.provider,
          upstreamModel: st.cfg.model,
          upstream: resp,
          stream: wantStream,
        };
      }

      let text = "";
      try {
        text = (await resp.text()).slice(0, 2000);
      } catch {
        /* ignore */
      }
      const status = resp.status;
      const ra = parseRetryAfter(resp.headers.get("retry-after"), this.now());

      if (status === 429) {
        const ms = this._cooldown(st, ra, text || "rate limited", 429);
        tried.push({ model: id, failed: 429, cooldown_ms: ms });
        this.log.warn("upstream 429", { model: id, cooldown_ms: ms });
      } else if ([400, 404, 410].includes(status) && MODEL_GONE_RE.test(text)) {
        st.removedUntil = this.now() + this.config.removed_ttl_seconds * 1000;
        st.lastError = {
          at: new Date(this.now()).toISOString(),
          status,
          message: this.redact(text).slice(0, 300),
        };
        tried.push({ model: id, failed: "model_removed" });
        this.log.warn("model marked removed", {
          model: id,
          ttl_s: this.config.removed_ttl_seconds,
        });
      } else if (status === 401 || status === 403) {
        const ms = this._cooldown(st, 600000, text || "auth error", status);
        tried.push({ model: id, failed: status, cooldown_ms: ms });
        this.log.warn("upstream auth error", { model: id, status });
      } else if (status >= 500 || status === 404 || status === 408) {
        const ms = this._cooldown(st, ra, text || `upstream ${status}`, status);
        tried.push({ model: id, failed: status, cooldown_ms: ms });
        this.log.warn("upstream error", { model: id, status, cooldown_ms: ms });
      } else {
        // 4xx that is the caller's fault (bad request etc.): pass through, do not fail over.
        this.persist();
        throw new RouterError(
          status,
          "upstream_client_error",
          this.redact(text) || `upstream ${status}`,
          {
            "x-router-provider": st.cfg.provider,
            "x-router-passthrough": "1",
          },
        );
      }
      this.persist();
    }

    if (!sawFree) {
      throw new RouterError(
        403,
        "paid_model_refused",
        `no free-flagged model available for "${requested}"`,
      );
    }
    const headers = {};
    if (Number.isFinite(minWait))
      headers["retry-after"] = String(Math.max(1, Math.ceil(minWait / 1000)));
    const err = new RouterError(
      503,
      "all_providers_unavailable",
      `no provider could serve "${requested}" right now`,
      headers,
    );
    err.tried = tried;
    throw err;
  }

  stats() {
    const now = this.now();
    const out = {
      generated_at: new Date(now).toISOString(),
      aliases: Object.fromEntries(this.aliases),
      models: {},
    };
    for (const [id, st] of this.models) {
      const p = this.providers.get(st.cfg.provider);
      out.models[id] = {
        provider: st.cfg.provider,
        model: st.cfg.model,
        free: st.free,
        has_api_key: Boolean(this.env[p.api_key_env]),
        served: st.served,
        attempts: st.attempts,
        rpm_available: st.rpm ? Math.floor(st.rpm.available()) : null,
        tpm_available: st.tpm ? Math.floor(st.tpm.available()) : null,
        rpd_used: st.rpd ? st.rpd.count : null,
        rpd_remaining: st.rpd ? st.rpd.remaining() : null,
        cooldown_until:
          st.cooldownUntil > now
            ? new Date(st.cooldownUntil).toISOString()
            : null,
        removed_until:
          st.removedUntil > now
            ? new Date(st.removedUntil).toISOString()
            : null,
        consecutive_failures: st.fails,
        last_error: st.lastError,
      };
    }
    return out;
  }
}

module.exports = { Router, RouterError, parseRetryAfter, estimatePromptTokens };
