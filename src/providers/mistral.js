"use strict";
const { genericPrepare } = require("./generic");

module.exports = {
  name: "mistral",
  base_url: "https://api.mistral.ai/v1",
  api_key_env: "MISTRAL_API_KEY",
  headers(key) {
    return { authorization: "Bearer " + key };
  },
  prepareBody: genericPrepare,
};
