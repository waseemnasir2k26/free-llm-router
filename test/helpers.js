"use strict";
const http = require("node:http");
const { createApp } = require("../src/server");

/** Start a mock upstream. handler(req, bodyObj, res, hitIndex) must write the response. */
function mockUpstream(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* ignore */
      }
      hits.push({ url: req.url, headers: req.headers, body });
      handler(req, body, res, hits.length - 1);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });
}

const okJson =
  (text = "hi") =>
  (req, body, res) => {
    const out = JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: body && body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(out);
  };

const status =
  (code, payload, headers = {}) =>
  (req, body, res) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  };

/** Build a config with N mock providers named p1, p2, ... each exposing one model "pN/m". */
function makeConfig(upstreams, { limits = {}, extra = {}, aliasOrder } = {}) {
  const providers = {};
  const models = [];
  upstreams.forEach((u, i) => {
    const n = "p" + (i + 1);
    providers[n] = {
      adapter: "generic",
      base_url: u.url + "/v1",
      api_key_env: n.toUpperCase() + "_KEY",
    };
    models.push({
      id: n + "/m",
      provider: n,
      model: "m-" + n,
      free: true,
      context_window: 8000,
      limits: limits[n] || { rpm: 1000, rpd: 1000, tpm: 1000000 },
      ...(extra[n] || {}),
    });
  });
  const ids = aliasOrder || models.map((m) => m.id);
  return {
    providers,
    models,
    aliases: { fast: ids },
    default_alias: "fast",
    cooldown_base_seconds: 10,
    cooldown_max_seconds: 600,
    removed_ttl_seconds: 3600,
  };
}

function fakeClock(start = Date.parse("2026-10-12T10:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

async function startRouter(config, { env, now, stateFile } = {}) {
  const logs = [];
  const fullEnv = env || {
    P1_KEY: "test-key-aaaaaa-1",
    P2_KEY: "test-key-bbbbbb-2",
    P3_KEY: "test-key-cccccc-3",
  };
  const app = createApp({
    config,
    env: fullEnv,
    now: now || Date.now,
    out: (l) => logs.push(l),
    stateFile,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app,
    base,
    logs,
    env: fullEnv,
    close: () =>
      new Promise((r) => {
        app.server.closeAllConnections?.();
        app.server.close(r);
      }),
    chat: (body = {}, headers = {}) =>
      fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
          ...body,
        }),
      }),
  };
}

module.exports = {
  mockUpstream,
  okJson,
  status,
  makeConfig,
  fakeClock,
  startRouter,
};
