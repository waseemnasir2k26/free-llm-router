#!/usr/bin/env sh
# Start the router first:  GROQ_API_KEY=... node src/server.js
BASE=${ROUTER_URL:-http://127.0.0.1:8787}

echo "--- aliases"
curl -s "$BASE/v1/models"
echo
echo "--- chat (non-streaming); -i shows the x-router-provider header"
curl -si "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"Say hi in five words"}]}'
echo
echo "--- chat (streaming)"
curl -sN "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"fast","stream":true,"messages":[{"role":"user","content":"Count to five"}]}'
echo
echo "--- usage / cooldowns"
curl -s "$BASE/stats"
