"use strict";
const { genericPrepare } = require("./generic");

module.exports = {
  name: "openrouter",
  base_url: "https://openrouter.ai/api/v1",
  api_key_env: "OPENROUTER_API_KEY",
  headers(key) {
    return { authorization: "Bearer " + key, "x-title": "free-llm-router" };
  },
  prepareBody: genericPrepare,
};
