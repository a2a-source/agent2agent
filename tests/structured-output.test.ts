import { test } from "node:test";
import assert from "node:assert/strict";
import { structuredOutput } from "../src/structured-output.js";
import { loadConfig } from "./test-config.js";
test("strict output routing requires support on OpenRouter and is explicitly optional", () => {
  const c = loadConfig().llm,
    schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
  c.structuredOutputs = true;
  c.endpoint = "https://openrouter.ai/api/v1";
  const out: any = structuredOutput(c, schema);
  assert.equal(out.response_format.json_schema.strict, true);
  assert.equal(out.provider.require_parameters, true);
  assert.deepEqual(out.response_format.json_schema.schema, schema);
  c.endpoint = "https://example.com/v1";
  assert(!("provider" in structuredOutput(c, schema)));
  c.structuredOutputs = false;
  assert.deepEqual(structuredOutput(c, schema), {});
  c.structuredOutputs = true;
  assert.deepEqual(structuredOutput(c), {});
});
