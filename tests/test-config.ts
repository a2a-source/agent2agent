import { loadConfig as load } from "../src/config.js";
/** Artificial unit-test FX rate chosen so USD0.01 costs40wei; never a market quote. */
export function loadConfig() {
  const c = load();
  c.llm.bnbUsdMicros = "250000000000000000000";
  c.research.enabled = false;
  return c;
}
