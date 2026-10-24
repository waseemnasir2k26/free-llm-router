"use strict";
const { genericPrepare } = require("./generic");

module.exports = {
  name: "cerebras",
  base_url: "https://api.cerebras.ai/v1",
  api_key_env: "CEREBRAS_API_KEY",
  headers(key) {
    return { authorization: "Bearer " + key };
  },
  prepareBody: genericPrepare,
};
