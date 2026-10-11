import type { Config } from "./config.js";
export function structuredOutput(
  config: Config["llm"],
  schema?: Record<string, unknown>,
) {
  if (!config.structuredOutputs || !schema) return {};
  return {
    response_format: {
      type: "json_schema",
      json_schema: { name: "a2a_research_report", strict: true, schema },
    },
    ...(new URL(config.endpoint).hostname === "openrouter.ai"
      ? { provider: { require_parameters: true } }
      : {}),
  };
}
