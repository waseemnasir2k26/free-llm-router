"use strict";

/**
 * Copy an upstream fetch Response body to a Node ServerResponse byte-for-byte.
 * No parsing, no re-framing: SSE chunks reach the client exactly as sent.
 * Resolves with the number of bytes forwarded.
 */
async function pipeStream(upstream, res) {
  let bytes = 0;
  if (!upstream.body) return bytes;
  for await (const chunk of upstream.body) {
    bytes += chunk.length;
    if (!res.write(chunk)) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }
  return bytes;
}

module.exports = { pipeStream };
