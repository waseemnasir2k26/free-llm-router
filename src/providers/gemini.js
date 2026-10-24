"use strict";
const { genericPrepare } = require("./generic");

// Gemini is reached through Google's OpenAI-compatible endpoint, so no body translation is needed.
module.exports = {
  name: "gemini",
  base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
  api_key_env: "GEMINI_API_KEY",
  headers(key) {
    return { authorization: "Bearer " + key };
  },
  prepareBody: genericPrepare,
};
