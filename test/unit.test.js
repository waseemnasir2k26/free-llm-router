"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TokenBucket, DailyCounter } = require("../src/buckets");
const { makeRedactor, createLogger } = require("../src/redact");
const { parseRetryAfter, estimatePromptTokens } = require("../src/router");
const { parseArgs } = require("../src/server");
const { fakeClock } = require("./helpers");

test("TokenBucket: refills continuously and never exceeds capacity", () => {
  const now = fakeClock();
  const b = new TokenBucket(60, 60000, now); // 1 token / second
  assert.equal(b.take(60), true);
  assert.equal(b.take(1), false);
  assert.equal(b.waitMs(1), 1000);
  now.advance(5000);
  assert.equal(Math.floor(b.available()), 5);
  assert.equal(b.take(5), true);
  now.advance(10 * 60000);
  assert.equal(b.available(), 60);
  assert.equal(b.canTake(61), false);
});

test("DailyCounter: counts, refuses at limit, rolls over at UTC midnight", () => {
  const now = fakeClock(Date.parse("2026-10-12T23:59:00Z"));
  const c = new DailyCounter(2, now);
  assert.equal(c.take(), true);
  assert.equal(c.take(), true);
  assert.equal(c.take(), false);
  assert.equal(c.remaining(), 0);
  assert.equal(c.waitMs(), 60000);
  now.advance(61000);
  assert.equal(c.remaining(), 2);
  assert.equal(c.take(), true);
});

test("DailyCounter: load only restores a snapshot from the same UTC day", () => {
  const now = fakeClock(Date.parse("2026-10-12T10:00:00Z"));
  const a = new DailyCounter(10, now);
  a.load({ day: "2026-10-12", count: 7 });
  assert.equal(a.count, 7);
  const b = new DailyCounter(10, now);
  b.load({ day: "2026-10-11", count: 9 });
  assert.equal(b.count, 0);
});

test("parseRetryAfter handles seconds, HTTP dates and garbage", () => {
  assert.equal(parseRetryAfter("7", 0), 7000);
  assert.equal(parseRetryAfter("0", 0), 0);
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter("nonsense", 0), null);
  const now = Date.parse("2026-10-12T10:00:00Z");
  assert.equal(parseRetryAfter("Mon, 12 Oct 2026 10:00:30 GMT", now), 30000);
});

test("estimatePromptTokens is about chars/4", () => {
  const small = estimatePromptTokens({
    messages: [{ role: "user", content: "hi" }],
  });
  const big = estimatePromptTokens({
    messages: [{ role: "user", content: "x".repeat(4000) }],
  });
  assert.ok(small < 30);
  assert.ok(big >= 1000 && big < 1100);
});

test("redactor strips configured secrets and common key shapes", () => {
  const r = makeRedactor(["my-secret-value-123"]);
  assert.equal(
    r("token my-secret-value-123 end").includes("my-secret-value-123"),
    false,
  );
  assert.match(r("Authorization: Bearer abcdefghijklmnop"), /\[REDACTED\]/);
  assert.equal(r("gsk_abcdefghijklmnop").includes("gsk_abcdef"), false);
  assert.equal(
    r("AIzaSyA1234567890abcdefghijklmn").includes("AIzaSyA1"),
    false,
  );
  assert.equal(
    r("https://x/y?key=SECRETKEYVALUE&a=1").includes("SECRETKEYVALUE"),
    false,
  );
  assert.equal(r("nothing to hide"), "nothing to hide");
});

test("logger routes every line through the redactor", () => {
  const lines = [];
  const log = createLogger({
    out: (l) => lines.push(l),
    redact: makeRedactor(["topsecret-9999"]),
  });
  log.info("hello", { k: "topsecret-9999" });
  log.error("boom topsecret-9999");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !l.includes("topsecret-9999")));
});

test("CLI: --paid-ok is deliberately not an option", () => {
  assert.throws(() => parseArgs(["--paid-ok"]), /unknown option/);
  assert.throws(() => parseArgs(["--allow-paid"]), /unknown option/);
  const o = parseArgs(["--port", "9000", "--config", "x.json"]);
  assert.equal(o.port, 9000);
  assert.equal(o.config, "x.json");
  assert.equal(o.host, "127.0.0.1");
  assert.throws(() => parseArgs(["--port", "abc"]), /--port/);
});
