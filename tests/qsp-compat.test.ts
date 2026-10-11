import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { hash } from "../src/protocol.js";
import { signingMessage, verifyQsp } from "../src/qsp.js";
test("historical v1 signing domain stays byte-for-byte compatible", async () => {
  // Public deterministic test-only key, never an operational wallet.
  const signer = new Wallet("0x" + "11".repeat(32));
  const legacy = {
    version: "a2a-qsp/1",
    epoch: "7",
    view: 0,
    master: "legacy",
    committeeHash: "c",
    configHash: "f",
    dataAt: 1,
    reports: [
      {
        role: "risk",
        agent: "worker",
        summary: "No data",
        sources: [],
        missing: ["market"],
      },
    ],
    signals: [],
    risks: ["No market data"],
    executed: false,
  };
  const original = `A2A-QSP:1:97:${hash(legacy)}`;
  const signature = await signer.signMessage(original);
  assert.equal(signingMessage(97, legacy), original);
  assert(verifyQsp(97, legacy, signature, signer.address));
  assert.equal(verifyQsp(56, legacy, signature, signer.address), false);
});
