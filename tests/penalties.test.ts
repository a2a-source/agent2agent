import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Store } from "../src/store.js";
import { WalletVault, type EncryptedWallet } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Epochs } from "../src/epochs.js";
import { Penalties } from "../src/penalties.js";
import { signingMessage } from "../src/qsp.js";
import { hash } from "../src/protocol.js";
test("signed equivocation is deduplicated and quarantined without debiting principal or compute", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    db = new Store(":memory:"),
    vault = new WalletVault(
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "k",
    ),
    agents = new Agents(db, vault),
    epochs = new Epochs(db),
    penalties = new Penalties(agents, epochs, 97, 3, 1000);
  const nodes = Array.from({ length: 3 }, () => {
    const u = agents.createUser("u"),
      a = agents.create(u.id, "a", { name: "A", symbol: "A", meta: "bafy" });
    return {
      id: a.id,
      wallet: a.wallet,
      stake: "300000000000000000",
      compute: "1000",
    };
  });
  const e = epochs.open(0, nodes, {
    termSlots: 7,
    committeeSize: 7,
    timeoutMs: 60000,
  });
  const first = {
      version: "a2a-qsp/1",
      epoch: e.id,
      view: 0,
      master: e.master,
      committeeHash: hash(e.committee),
      configHash: "c",
      dataAt: 1,
      reports: [
        {
          role: "risk",
          agent: nodes[0]!.id,
          summary: "No data",
          sources: [],
          missing: ["market"],
        },
      ],
      signals: [],
      risks: ["risk"],
      executed: false,
    },
    second = { ...first, risks: ["different"] };
  const w = db.get<EncryptedWallet>("wallet", e.master)!;
  const s1 = await vault.withWallet(w, (k) =>
      k.signMessage(signingMessage(97, first)),
    ),
    s2 = await vault.withWallet(w, (k) =>
      k.signMessage(signingMessage(97, second)),
    );
  penalties.evidence(first, s1, second, s2);
  penalties.evidence(second, s2, first, s1);
  assert.equal(db.all("evidence").length, 1);
  assert.equal(agents.get(e.master).jailed, true);
  assert.equal(db.all("slash").length, 0);
  assert.equal(db.all("balance").length, 0);
  assert.throws(
    () => penalties.evidence(first, s1, first, s1),
    /not conflicting/,
  );
  db.close();
});
