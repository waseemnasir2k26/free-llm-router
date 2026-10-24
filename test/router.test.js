"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  mockUpstream,
  okJson,
  status,
  makeConfig,
  fakeClock,
  startRouter,
} = require("./helpers");

async function withRig(handlers, opts, fn) {
  const ups = [];
  for (const h of handlers) ups.push(await mockUpstream(h));
  const config = makeConfig(ups, opts && opts.cfg);
  const router = await startRouter(config, opts && opts.router);
  try {
    await fn({ ups, router, config });
  } finally {
    await router.close();
    for (const u of ups) await u.close();
  }
}

test("429 with Retry-After fails over to the next provider and honours the cooldown", async () => {
  const clock = fakeClock();
  await withRig(
    [
      status(429, { error: { message: "slow down" } }, { "retry-after": "7" }),
      okJson("from-p2"),
    ],
    { router: { now: clock } },
    async ({ ups, router }) => {
      const r = await router.chat();
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-router-provider"), "p2");
      assert.equal(r.headers.get("x-router-model"), "m-p2");
      const j = await r.json();
      assert.equal(j.choices[0].message.content, "from-p2");
      assert.equal(ups[0].hits.length, 1);
      const s = router.router.stats().models["p1/m"];
      assert.equal(new Date(s.cooldown_until).getTime(), clock() + 7000);
      assert.equal(s.last_error.status, 429);
      // still cooling down: p1 must not be called again
      await router.chat();
      assert.equal(ups[0].hits.length, 1);
      assert.equal(ups[1].hits.length, 2);
      // after the cooldown p1 is tried again
      clock.advance(8000);
      await router.chat();
      assert.equal(ups[0].hits.length, 2);
    },
  );
});

test("upstream sees the mapped model name and bearer key, never the alias", async () => {
  await withRig([okJson()], {}, async ({ ups, router }) => {
    await router.chat({ temperature: 0.2 });
    const h = ups[0].hits[0];
    assert.equal(h.url, "/v1/chat/completions");
    assert.equal(h.body.model, "m-p1");
    assert.equal(h.body.temperature, 0.2);
    assert.equal(h.headers.authorization, "Bearer test-key-aaaaaa-1");
  });
});

test("5xx puts the model on exponential cooldown and fails over", async () => {
  const clock = fakeClock();
  await withRig(
    [status(503, { error: { message: "overloaded" } }), okJson("p2")],
    { router: { now: clock } },
    async ({ ups, router }) => {
      const r1 = await router.chat();
      assert.equal(r1.headers.get("x-router-provider"), "p2");
      let s = router.router.stats().models["p1/m"];
      assert.equal(s.consecutive_failures, 1);
      assert.equal(new Date(s.cooldown_until).getTime(), clock() + 10000);
      assert.equal(s.last_error.status, 503);
      clock.advance(10001);
      await router.chat(); // p1 retried, fails again -> cooldown doubles
      s = router.router.stats().models["p1/m"];
      assert.equal(s.consecutive_failures, 2);
      assert.equal(new Date(s.cooldown_until).getTime(), clock() + 20000);
      assert.equal(ups[0].hits.length, 2);
    },
  );
});

test("network error counts as a failure and fails over", async () => {
  const dead = await mockUpstream(okJson());
  const url = dead.url;
  await dead.close(); // port now refuses connections
  const live = await mockUpstream(okJson("alive"));
  const config = makeConfig([{ url }, live]);
  const router = await startRouter(config);
  try {
    const r = await router.chat();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-router-provider"), "p2");
    assert.equal(router.router.stats().models["p1/m"].consecutive_failures, 1);
  } finally {
    await router.close();
    await live.close();
  }
});

test("a removed model is skipped until its TTL expires", async () => {
  const clock = fakeClock();
  const gone = status(404, {
    error: {
      message:
        "The model `m-p1` does not exist or you do not have access to it.",
      code: "model_not_found",
    },
  });
  await withRig(
    [gone, okJson("p2")],
    { router: { now: clock } },
    async ({ ups, router }) => {
      const r = await router.chat();
      assert.equal(r.headers.get("x-router-provider"), "p2");
      const s = router.router.stats().models["p1/m"];
      assert.ok(s.removed_until);
      assert.equal(new Date(s.removed_until).getTime(), clock() + 3600 * 1000);
      await router.chat();
      await router.chat();
      assert.equal(
        ups[0].hits.length,
        1,
        "removed model must not be called again",
      );
      clock.advance(3600 * 1000 + 1);
      await router.chat();
      assert.equal(ups[0].hits.length, 2, "model retried after TTL");
    },
  );
});

test("a plain 404 (not model-gone) is a cooldown, not a removal", async () => {
  await withRig([status(404, "nope"), okJson("p2")], {}, async ({ router }) => {
    await router.chat();
    const s = router.router.stats().models["p1/m"];
    assert.equal(s.removed_until, null);
    assert.ok(s.cooldown_until);
  });
});

test("RPD exhaustion moves traffic to the next provider", async () => {
  await withRig(
    [okJson("p1"), okJson("p2")],
    { cfg: { limits: { p1: { rpd: 2 } } } },
    async ({ ups, router }) => {
      const seen = [];
      for (let i = 0; i < 4; i++)
        seen.push((await router.chat()).headers.get("x-router-provider"));
      assert.deepEqual(seen, ["p1", "p1", "p2", "p2"]);
      assert.equal(ups[0].hits.length, 2);
      const s = router.router.stats().models["p1/m"];
      assert.equal(s.rpd_used, 2);
      assert.equal(s.rpd_remaining, 0);
    },
  );
});

test("RPM bucket throttles a provider and spills to the next one", async () => {
  await withRig(
    [okJson(), okJson()],
    { cfg: { limits: { p1: { rpm: 1 } } } },
    async ({ ups, router }) => {
      const a = await router.chat();
      const b = await router.chat();
      assert.equal(a.headers.get("x-router-provider"), "p1");
      assert.equal(b.headers.get("x-router-provider"), "p2");
      assert.equal(ups[0].hits.length, 1);
    },
  );
});

test("context window check skips providers that are too small", async () => {
  const ups = [
    await mockUpstream(okJson("small")),
    await mockUpstream(okJson("big")),
  ];
  const config = makeConfig(ups, {
    extra: { p1: { context_window: 100 }, p2: { context_window: 100000 } },
  });
  const router = await startRouter(config);
  try {
    const r = await router.chat({
      messages: [{ role: "user", content: "word ".repeat(2000) }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-router-provider"), "p2");
    assert.equal(ups[0].hits.length, 0);
  } finally {
    await router.close();
    for (const u of ups) await u.close();
  }
});

test("paid-model guard: direct request for a non-free model is refused with 403 and never calls upstream", async () => {
  const ups = [await mockUpstream(okJson("paid"))];
  const config = makeConfig(ups, { extra: { p1: { free: false } } });
  const router = await startRouter(config);
  try {
    const r = await router.chat({ model: "p1/m" });
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.error.code, "paid_model_refused");
    assert.equal(ups[0].hits.length, 0);
    // free:"true" (string) or missing flag is not enough either
    const cfg2 = makeConfig(ups, { extra: { p1: { free: "true" } } });
    const r2 = await startRouter(cfg2);
    const x = await r2.chat({ model: "p1/m" });
    assert.equal(x.status, 403);
    await r2.close();
    assert.equal(ups[0].hits.length, 0);
  } finally {
    await router.close();
    await ups[0].close();
  }
});

test("paid-model guard: a non-free model inside an alias is skipped, an all-paid alias is 403", async () => {
  const ups = [
    await mockUpstream(okJson("paid")),
    await mockUpstream(okJson("free")),
  ];
  const config = makeConfig(ups, { extra: { p1: { free: false } } });
  config.aliases.onlypaid = ["p1/m"];
  const router = await startRouter(config);
  try {
    const r = await router.chat();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-router-provider"), "p2");
    assert.equal(ups[0].hits.length, 0);
    const r2 = await router.chat({ model: "onlypaid" });
    assert.equal(r2.status, 403);
    assert.equal(ups[0].hits.length, 0);
  } finally {
    await router.close();
    for (const u of ups) await u.close();
  }
});

test("unknown model name is a 404 and nothing is called", async () => {
  await withRig([okJson()], {}, async ({ ups, router }) => {
    const r = await router.chat({ model: "gpt-4o" });
    assert.equal(r.status, 404);
    assert.equal(ups[0].hits.length, 0);
  });
});

test("provider without an API key in env is skipped, never called", async () => {
  const ups = [
    await mockUpstream(okJson("p1")),
    await mockUpstream(okJson("p2")),
  ];
  const config = makeConfig(ups);
  const router = await startRouter(config, {
    env: { P2_KEY: "test-key-bbbbbb-2" },
  });
  try {
    const r = await router.chat();
    assert.equal(r.headers.get("x-router-provider"), "p2");
    assert.equal(ups[0].hits.length, 0);
    assert.equal(router.router.stats().models["p1/m"].has_api_key, false);
  } finally {
    await router.close();
    for (const u of ups) await u.close();
  }
});

test("all providers exhausted returns 503 with Retry-After and a tried list", async () => {
  await withRig(
    [
      status(429, {}, { "retry-after": "30" }),
      status(429, {}, { "retry-after": "12" }),
    ],
    {},
    async ({ router }) => {
      const r = await router.chat();
      assert.equal(r.status, 503);
      const j = await r.json();
      assert.equal(j.error.code, "all_providers_unavailable");
      assert.equal(j.error.tried.length, 2);
      const again = await router.chat();
      assert.equal(again.status, 503);
      assert.equal(again.headers.get("retry-after"), "12");
    },
  );
});

test("caller errors (400) pass through without failover or cooldown", async () => {
  await withRig(
    [status(400, { error: { message: "bad temperature" } }), okJson()],
    {},
    async ({ ups, router }) => {
      const r = await router.chat();
      assert.equal(r.status, 400);
      assert.match(await r.text(), /bad temperature/);
      assert.equal(ups[1].hits.length, 0);
      assert.equal(router.router.stats().models["p1/m"].cooldown_until, null);
    },
  );
});

test("GET /v1/models lists aliases; /healthz and /stats respond; unknown route 404", async () => {
  await withRig([okJson()], {}, async ({ router }) => {
    const m = await (await fetch(router.base + "/v1/models")).json();
    assert.equal(m.object, "list");
    assert.deepEqual(
      m.data.map((x) => x.id),
      ["fast"],
    );
    assert.equal(m.data[0].object, "model");
    assert.deepEqual(await (await fetch(router.base + "/healthz")).json(), {
      ok: true,
    });
    const s = await (await fetch(router.base + "/stats")).json();
    assert.ok(s.models["p1/m"]);
    assert.equal(s.models["p1/m"].served, 0);
    assert.equal((await fetch(router.base + "/nope")).status, 404);
  });
});

test("invalid JSON and missing messages are 400", async () => {
  await withRig([okJson()], {}, async ({ router }) => {
    const bad = await fetch(router.base + "/v1/chat/completions", {
      method: "POST",
      body: "{nope",
    });
    assert.equal(bad.status, 400);
    const noMsgs = await fetch(router.base + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "fast" }),
    });
    assert.equal(noMsgs.status, 400);
  });
});

test("ROUTER_TOKEN, when set, is required except on /healthz", async () => {
  const ups = [await mockUpstream(okJson())];
  const router = await startRouter(makeConfig(ups), {
    env: { P1_KEY: "test-key-aaaaaa-1", ROUTER_TOKEN: "router-token-xyz" },
  });
  try {
    assert.equal((await router.chat()).status, 401);
    assert.equal(
      (await router.chat({}, { authorization: "Bearer router-token-xyz" }))
        .status,
      200,
    );
    assert.equal((await fetch(router.base + "/healthz")).status, 200);
    assert.equal((await fetch(router.base + "/stats")).status, 401);
  } finally {
    await router.close();
    await ups[0].close();
  }
});

test("streaming: SSE chunks are forwarded byte-for-byte and incrementally", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" 😀 ünïcode"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const sse = (req, body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const tick = () => {
      if (i >= frames.length) return res.end();
      res.write(frames[i++]);
      setTimeout(tick, 40);
    };
    tick();
  };
  await withRig([sse], {}, async ({ ups, router }) => {
    const r = await router.chat({ stream: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    assert.equal(r.headers.get("x-router-provider"), "p1");
    const parts = [];
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    assert.ok(
      parts.length >= 2,
      "arrived in multiple chunks, not buffered into one",
    );
    assert.equal(Buffer.concat(parts).toString("utf8"), frames.join(""));
    assert.equal(ups[0].hits[0].body.stream, true);
  });
});

test("streaming: 429 before the first byte still fails over to the next provider", async () => {
  const sse = (req, body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n");
  };
  await withRig(
    [status(429, {}, { "retry-after": "5" }), sse],
    {},
    async ({ router }) => {
      const r = await router.chat({ stream: true });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-router-provider"), "p2");
      assert.equal(await r.text(), "data: [DONE]\n\n");
    },
  );
});

test("redaction: keys echoed by an upstream error never reach logs, /stats or responses", async () => {
  const leaky = (req, body, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "invalid key " + req.headers.authorization.replace("Bearer ", ""),
        },
      }),
    );
  };
  await withRig([leaky, okJson()], {}, async ({ router }) => {
    const r = await router.chat();
    const bodyText = await r.text();
    const stats = JSON.stringify(
      await (await fetch(router.base + "/stats")).json(),
    );
    const all = router.logs.join("\n") + bodyText + stats;
    assert.ok(router.logs.length > 0, "something was logged");
    assert.equal(all.includes("test-key-aaaaaa-1"), false);
    assert.equal(all.includes("test-key-bbbbbb-2"), false);
    assert.match(stats, /\[REDACTED\]/);
  });
});

test("redaction: a key that appears in an error thrown by fetch is redacted in logs", async () => {
  const ups = [await mockUpstream(okJson())];
  const config = makeConfig(ups);
  const logs = [];
  const { createApp } = require("../src/server");
  const env = { P1_KEY: "sekret-key-value-42" };
  const app = createApp({
    config,
    env,
    out: (l) => logs.push(l),
    fetchImpl: async () => {
      throw new Error("connect failed using sekret-key-value-42");
    },
  });
  let thrown = null;
  try {
    await app.router.handle({ model: "fast", messages: [] });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown && thrown.status, 503);
  assert.ok(logs.length > 0);
  assert.equal(logs.join("\n").includes("sekret-key-value-42"), false);
  assert.equal(
    JSON.stringify(app.router.stats()).includes("sekret-key-value-42"),
    false,
  );
  await ups[0].close();
});

test("persistence: daily counters, cooldowns and removals survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flr-"));
  const stateFile = path.join(dir, "state.json");
  const clock = fakeClock();
  const ups = [
    await mockUpstream(okJson("p1")),
    await mockUpstream(okJson("p2")),
  ];
  const config = makeConfig(ups, { limits: { p1: { rpd: 2, rpm: 100 } } });
  try {
    const a = await startRouter(config, { now: clock, stateFile });
    await a.chat();
    await a.chat();
    await a.close();
    assert.ok(fs.existsSync(stateFile));
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(saved.models["p1/m"].daily.count, 2);
    assert.equal(saved.models["p1/m"].served, 2);

    const b = await startRouter(config, { now: clock, stateFile });
    assert.equal(b.router.stats().models["p1/m"].rpd_used, 2);
    const r = await b.chat();
    assert.equal(
      r.headers.get("x-router-provider"),
      "p2",
      "p1 daily quota stayed spent across the restart",
    );
    await b.close();

    // next UTC day: the counter resets even though the file says 2
    clock.advance(24 * 3600 * 1000);
    const c = await startRouter(config, { now: clock, stateFile });
    assert.equal(c.router.stats().models["p1/m"].rpd_used, 0);
    await c.close();
  } finally {
    for (const u of ups) await u.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: a removed model stays removed after restart; corrupt state file is ignored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flr-"));
  const stateFile = path.join(dir, "state.json");
  const clock = fakeClock();
  const gone = status(404, { error: { message: "model not found" } });
  const ups = [await mockUpstream(gone), await mockUpstream(okJson("p2"))];
  const config = makeConfig(ups);
  try {
    const a = await startRouter(config, { now: clock, stateFile });
    await a.chat();
    await a.close();
    const b = await startRouter(config, { now: clock, stateFile });
    await b.chat();
    assert.equal(ups[0].hits.length, 1, "removed flag was restored from disk");
    await b.close();
    fs.writeFileSync(stateFile, "{not json");
    const c = await startRouter(config, { now: clock, stateFile });
    assert.equal((await c.chat()).status, 200);
    await c.close();
  } finally {
    for (const u of ups) await u.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shipped example config is valid, every model is free and every alias resolves", async () => {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "router.config.example.json"),
      "utf8",
    ),
  );
  const { createApp } = require("../src/server");
  const app = createApp({ config: cfg, env: {}, out: () => {} });
  assert.deepEqual(app.router.listAliases().sort(), [
    "fast",
    "long-context",
    "smart",
  ]);
  for (const m of cfg.models) {
    assert.equal(m.free, true, m.id);
    assert.match(m.source, /^https:\/\//, m.id);
    assert.match(m.last_verified, /^\d{4}-\d{2}-\d{2}$/, m.id);
    assert.ok(m.limits && m.context_window, m.id);
  }
  const same = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "router.config.json"), "utf8"),
  );
  assert.deepEqual(same, cfg);
});
