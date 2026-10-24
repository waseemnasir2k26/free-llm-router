"use strict";
// Runs the real router against two LOCAL mock upstreams (no network, no keys needed):
//   mock "groq"   -> answers 429 with Retry-After: 30
//   mock "gemini" -> answers 200
// Run: node examples/demo-mock.js
const http = require("node:http");
const { createApp } = require("../src/server");

function mock(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => handler(req, res));
    });
    s.listen(0, "127.0.0.1", () =>
      resolve({ s, url: `http://127.0.0.1:${s.address().port}/v1` }),
    );
  });
}

(async () => {
  const groq = await mock((req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "30",
    });
    res.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
  });
  const gemini = await mock((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from the fallback provider.",
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const config = {
    default_alias: "fast",
    providers: {
      groq: { base_url: groq.url },
      gemini: { base_url: gemini.url },
    },
    models: [
      {
        id: "groq/llama-3.1-8b-instant",
        provider: "groq",
        model: "llama-3.1-8b-instant",
        free: true,
        context_window: 131072,
        limits: { rpm: 30, rpd: 14400 },
      },
      {
        id: "gemini/gemini-2.5-flash-lite",
        provider: "gemini",
        model: "gemini-2.5-flash-lite",
        free: true,
        context_window: 1048576,
        limits: { rpm: 15, rpd: 1000 },
      },
    ],
    aliases: {
      fast: ["groq/llama-3.1-8b-instant", "gemini/gemini-2.5-flash-lite"],
    },
  };
  const app = createApp({
    config,
    env: {
      GROQ_API_KEY: "demo-not-a-real-key",
      GEMINI_API_KEY: "demo-not-a-real-key",
    },
    out: () => {},
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ask = async (n) => {
    const r = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fast",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const j = await r.json();
    console.log(
      `request ${n}: HTTP ${r.status}  x-router-provider=${r.headers.get("x-router-provider")}  -> ${j.choices[0].message.content}`,
    );
  };
  console.log(
    "GET /v1/models ->",
    JSON.stringify(
      (await (await fetch(base + "/v1/models")).json()).data.map((m) => m.id),
    ),
  );
  await ask(1);
  await ask(2);
  const s = await (await fetch(base + "/stats")).json();
  for (const [id, m] of Object.entries(s.models)) {
    console.log(
      `stats ${id}: served=${m.served} rpd_used=${m.rpd_used} cooldown_until=${m.cooldown_until} last_error=${m.last_error ? m.last_error.status : null}`,
    );
  }
  app.server.close();
  groq.s.close();
  gemini.s.close();
  setTimeout(() => process.exit(0), 100);
})();
