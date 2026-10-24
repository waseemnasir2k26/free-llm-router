"use strict";
// Dependency-free client. Start the router first: node src/server.js
// Run: node examples/client.js "Say hi in five words"   (add --stream to stream)
const base = process.env.ROUTER_URL || "http://127.0.0.1:8787/v1";
const headers = { "content-type": "application/json" };
if (process.env.ROUTER_TOKEN)
  headers.authorization = "Bearer " + process.env.ROUTER_TOKEN;

const args = process.argv.slice(2);
const stream = args.includes("--stream");
const prompt =
  args.filter((a) => a !== "--stream").join(" ") || "Say hi in five words";

(async () => {
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.ROUTER_MODEL || "fast",
      stream,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  console.error(
    `HTTP ${r.status} served by ${r.headers.get("x-router-provider")} (${r.headers.get("x-router-model")})`,
  );
  if (!stream) {
    const j = await r.json();
    console.log(
      j.choices ? j.choices[0].message.content : JSON.stringify(j, null, 2),
    );
    return;
  }
  const dec = new TextDecoder();
  for await (const chunk of r.body) process.stdout.write(dec.decode(chunk));
})();
