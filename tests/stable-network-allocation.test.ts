import test from "node:test";
import assert from "node:assert/strict";
import { stableFixture } from "./helpers/stable-qsp.js";
import { validateStableNetworkAllocation } from "../src/stable-network-allocation.js";
import { qspV2Schema } from "../src/qsp-v2.js";
test("explicit stable allocation is signed QSP data with independently enforced caps/evidence", async () => {
  const f = await stableFixture();
  assert.equal(
    qspV2Schema.parse(f.output).masterSummary.stableNetworkAllocation?.reserve,
    "ALLOWLISTED_STABLECOINS",
  );
  assert.deepEqual(
    validateStableNetworkAllocation(
      f.allocation,
      f.context,
      f.reports,
      1100,
      500,
    ).targets,
    { BTC: 2000, ETH: 2000, BNB: 2000 },
  );
  for (const mutate of [
    (a: any) => (a.targets[0].targetWeightBps = 2001),
    (a: any) => (a.reserve = "BNB"),
    (a: any) => a.targets[0].evidence.pop(),
    (a: any) => a.targets.pop(),
  ]) {
    const a = structuredClone(f.allocation);
    mutate(a);
    assert.throws(() =>
      validateStableNetworkAllocation(a, f.context, f.reports, 1100, 500),
    );
  }
  assert.throws(() =>
    validateStableNetworkAllocation(
      f.allocation,
      f.context,
      f.reports,
      1500,
      500,
    ),
  );
});
