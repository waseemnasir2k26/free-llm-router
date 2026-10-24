"use strict";
const { genericPrepare } = require("./generic");

module.exports = {
  name: "groq",
  base_url: "https://api.groq.com/openai/v1",
  api_key_env: "GROQ_API_KEY",
  headers(key) {
    return { authorization: "Bearer " + key };
  },
  prepareBody: genericPrepare,
};
