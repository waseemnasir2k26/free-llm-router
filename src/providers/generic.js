"use strict";

/** Set the upstream model name and drop any fields the provider config lists in drop_fields. */
function genericPrepare(body, modelCfg, providerCfg) {
  const out = { ...body, model: modelCfg.model };
  for (const f of (providerCfg && providerCfg.drop_fields) || []) delete out[f];
  return out;
}

module.exports = {
  name: "generic",
  base_url: null,
  api_key_env: null,
  headers(key) {
    return { authorization: "Bearer " + key };
  },
  prepareBody: genericPrepare,
  genericPrepare,
};
