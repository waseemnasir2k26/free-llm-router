#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Router, RouterError } = require("./router");
const { makeRedactor, createLogger } = require("./redact");
const { pipeStream } = require("./stream");

const MAX_BODY = 10 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseArgs(argv) {
  const opts = {
    port: 8787,
    host: "127.0.0.1",
    config: "router.config.json",
    state: null,
    help: false,
    insecure: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--port") opts.port = Number(next());
    else if (a === "--host") opts.host = next();
    else if (a === "--insecure") opts.insecure = true;
    else if (a === "--config") opts.config = next();
    else if (a === "--state") opts.state = next();
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)
    throw new Error("--port must be 0-65535");
  return opts;
}

const HELP = `free-llm-router - OpenAI-compatible proxy over free-tier LLM APIs

Usage: node src/server.js [--port 8787] [--host 127.0.0.1] [--config router.config.json] [--state router.state.json] [--insecure]

Keys are read from environment variables only (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY,
CEREBRAS_API_KEY, MISTRAL_API_KEY). Optional ROUTER_TOKEN makes clients send "Authorization: Bearer <token>".
There is intentionally no flag to allow paid models.`;

function loadConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read config ${file}: ${e.message} (copy router.config.example.json to router.config.json)`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`config ${file} is not valid JSON: ${e.message}`);
  }
}

function collectSecrets(config, env) {
  const names = new Set(["ROUTER_TOKEN"]);
  for (const [n, p] of Object.entries(config.providers || {})) {
    if (p && p.api_key_env) names.add(p.api_key_env);
    names.add(n.toUpperCase() + "_API_KEY");
  }
  return [...names].map((n) => env[n]).filter(Boolean);
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function errorBody(code, message, extra) {
  return { error: { message, type: code, code, ...(extra || {}) } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(
          new RouterError(413, "body_too_large", "request body too large"),
        );
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Build the HTTP server + router. Pure factory so tests can run it on port 0 with mock upstreams. */
function createApp({
  config,
  env = process.env,
  now = Date.now,
  out,
  fetchImpl,
  stateFile,
} = {}) {
  const redact = makeRedactor(collectSecrets(config, env));
  const logger = createLogger({ out, redact });
  const router = new Router({
    config,
    env,
    now,
    fetchImpl,
    redact,
    logger,
    stateFile,
  });
  const token = env.ROUTER_TOKEN || null;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz")
        return sendJson(res, 200, { ok: true });
      if (token) {
        const auth = req.headers.authorization || "";
        if (!safeEqual(auth, "Bearer " + token))
          return sendJson(
            res,
            401,
            errorBody("unauthorized", "missing or wrong router token"),
          );
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const data = router.listAliases().map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "free-llm-router",
        }));
        return sendJson(res, 200, { object: "list", data });
      }
      if (req.method === "GET" && url.pathname === "/stats")
        return sendJson(res, 200, router.stats());
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof RouterError) throw e;
          throw new RouterError(
            400,
            "invalid_json",
            "request body is not valid JSON",
          );
        }
        if (
          !body ||
          typeof body !== "object" ||
          !Array.isArray(body.messages)
        ) {
          throw new RouterError(
            400,
            "invalid_request",
            '"messages" array is required',
          );
        }
        const ac = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) ac.abort();
        });
        const r = await router.handle(body, { signal: ac.signal });
        const hdrs = {
          "x-router-provider": r.provider,
          "x-router-model": r.upstreamModel,
        };
        if (r.stream) {
          res.writeHead(200, {
            "content-type":
              r.upstream.headers.get("content-type") || "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
            ...hdrs,
          });
          try {
            await pipeStream(r.upstream, res);
          } catch (e) {
            logger.warn("stream aborted mid-flight", {
              provider: r.provider,
              error: e.message,
            });
          }
          res.end();
        } else {
          const buf = Buffer.from(await r.upstream.arrayBuffer());
          res.writeHead(200, {
            "content-type":
              r.upstream.headers.get("content-type") || "application/json",
            "content-length": buf.length,
            ...hdrs,
          });
          res.end(buf);
        }
        logger.info("served", {
          alias: r.requested,
          provider: r.provider,
          model: r.upstreamModel,
          stream: r.stream,
          ms: Date.now() - started,
        });
        return;
      }
      return sendJson(
        res,
        404,
        errorBody("not_found", `no route for ${req.method} ${url.pathname}`),
      );
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (e instanceof RouterError) {
        if (e.code === "upstream_client_error") {
          res.writeHead(e.status, {
            "content-type": "application/json",
            ...e.headers,
          });
          return res.end(
            e.message.trim().startsWith("{")
              ? e.message
              : JSON.stringify(errorBody(e.code, e.message)),
          );
        }
        return sendJson(
          res,
          e.status,
          errorBody(
            e.code,
            e.message,
            e.tried ? { tried: e.tried } : undefined,
          ),
          e.headers,
        );
      }
      logger.error("unhandled", { error: e.message });
      return sendJson(res, 500, errorBody("internal_error", "internal error"));
    }
  });
  return { server, router, logger };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  const configPath = path.resolve(opts.config);
  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
  const stateFile = path.resolve(
    opts.state ||
      path.join(
        path.dirname(configPath),
        config.state_file || "router.state.json",
      ),
  );
  let app;
  try {
    app = createApp({ config, stateFile });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
  if (
    opts.host !== "127.0.0.1" &&
    opts.host !== "localhost" &&
    !process.env.ROUTER_TOKEN
  ) {
    if (!opts.insecure) {
      process.stderr.write(
        "error: refusing to listen on a non-loopback host without ROUTER_TOKEN (anyone who can reach this port could spend your free quota). Set ROUTER_TOKEN, or pass --insecure if you really mean it.\n",
      );
      process.exit(2);
    }
    app.logger.warn(
      "--insecure: listening on a non-loopback host without ROUTER_TOKEN: anyone who can reach this port can spend your free quota",
    );
  }
  for (const [id, st] of app.router.models) {
    if (!st.free)
      app.logger.warn(
        "model is not flagged free:true and will never be called",
        { model: id },
      );
  }
  app.server.listen(opts.port, opts.host, () => {
    const a = app.server.address();
    app.logger.info("listening", {
      url: `http://${a.address}:${a.port}/v1`,
      aliases: app.router.listAliases(),
      state: stateFile,
    });
  });
  const stop = () => {
    app.router.persist();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (require.main === module) main();

module.exports = { createApp, parseArgs, loadConfig, collectSecrets };
