import { createApi } from "../src/server.js";
import { Budget } from "../src/budget.js";
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
  const forgedFirst = { ...first, committeeHash: "not-the-frozen-committee" },
    forgedSecond = { ...second, committeeHash: "not-the-frozen-committee" };
  const f1 = await vault.withWallet(w, (k) =>
    k.signMessage(signingMessage(97, forgedFirst)),
  );
  const f2 = await vault.withWallet(w, (k) =>
    k.signMessage(signingMessage(97, forgedSecond)),
  );
  assert.throws(
    () => penalties.evidence(forgedFirst, f1, forgedSecond, f2),
    /committee/,
  );
  assert.equal(db.all("evidence").length, 0);
  const other = nodes.find((n) => n.id !== e.master)!;
  const wrongFirst = { ...first, master: other.id },
    wrongSecond = { ...second, master: other.id };
  const otherWallet = db.get<EncryptedWallet>("wallet", other.id)!;
  const wrong1 = await vault.withWallet(otherWallet, (k) =>
    k.signMessage(signingMessage(97, wrongFirst)),
  );
  const wrong2 = await vault.withWallet(otherWallet, (k) =>
    k.signMessage(signingMessage(97, wrongSecond)),
  );
  assert.throws(
    () => penalties.evidence(wrongFirst, wrong1, wrongSecond, wrong2),
    /elected Master/,
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
  const adminToken = "admin-token-long-enough-for-tests";
  const server = createApi({
    agents,
    budget: new Budget(db),
    epochs,
    penalties,
    adminToken,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/admin/unjail`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agent: e.master }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(agents.get(e.master).jailed, true);
    assert.equal(db.all("evidence").length, 1);
    // Ordinary operational isolation remains explicitly releasable through the same route.
    agents.update(other.id, { jailed: true });
    db.put("quarantine", other.id, {
      agent: other.id,
      reason: "REPEATED_PLATFORM_FAILURE",
      until: 0,
    });
    const released = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/admin/unjail`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agent: other.id }),
      },
    );
    assert.equal(released.status, 200);
    assert.equal(agents.get(other.id).jailed, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  db.close();
});

test("operational quarantine recovers automatically after cooldown and health proof, conflicting signatures do not", async () => {
  const db = new Store(":memory:");
  const rows = new Map([
    ["worker", { id: "worker", jailed: false }],
    ["evidence", { id: "evidence", jailed: true }],
  ]);
  const agents: any = {
    db,
    get: (id: string) => rows.get(id),
    update: (id: string, change: any) => {
      const a = { ...rows.get(id), ...change };
      rows.set(id, a);
      return a;
    },
  };
  let now = 1000;
  const penalties = new Penalties(
    agents,
    new Epochs(db),
    97,
    1,
    100,
    () => now,
  );
  penalties.failure("first", "worker", 1000);
  db.put("quarantine", "evidence", {
    agent: "evidence",
    reason: "CONFLICTING_SIGNATURE",
    until: null,
  });
  now = 1050;
  await penalties.recoverOperational(async () => true, now);
  assert.equal(rows.get("worker")!.jailed, true);
  now = 1200;
  await penalties.recoverOperational(async () => false, now);
  assert.equal(rows.get("worker")!.jailed, true);
  now = 1300;
  await penalties.recoverOperational(async () => true, now);
  assert.equal(rows.get("worker")!.jailed, false);
  assert.equal(rows.get("evidence")!.jailed, true);
  assert.equal(db.get<any>("quarantine", "worker").automatic, true);
  db.close();
});

test("operational incidents never downgrade conflicting-signature quarantine", async () => {
  const db = new Store(":memory:");
  let agent = { id: "a", jailed: true };
  const agents: any = {
    db,
    get: () => agent,
    update: (_id: string, change: any) => (agent = { ...agent, ...change }),
  };
  db.put("quarantine", "a", {
    agent: "a",
    reason: "CONFLICTING_SIGNATURE",
    until: null,
    financialPenalty: "0",
  });
  const penalties = new Penalties(agents, new Epochs(db), 97, 1, 10);
  penalties.failure("invalid", "a", 100, "INVALID_OUTPUT");
  await penalties.recoverOperational(async () => true, 200);
  assert.equal(agent.jailed, true);
  assert.equal(db.get<any>("quarantine", "a").reason, "CONFLICTING_SIGNATURE");
  db.close();
});

test("manual release cannot clear security evidence or unknown quarantine reasons", () => {
  const db = new Store(":memory:");
  let agent = { id: "a", jailed: true };
  const agents: any = {
    db,
    get: () => agent,
    update: (_id: string, change: any) => (agent = { ...agent, ...change }),
  };
  const penalties = new Penalties(agents, new Epochs(db), 97, 1, 10);
  try {
    for (const reason of ["CONFLICTING_SIGNATURE", "STATE_INTEGRITY_FAILURE"]) {
      db.put("quarantine", "a", { agent: "a", reason, until: null });
      assert.throws(() => penalties.release("a"), /security|operational/);
      assert.equal(agent.jailed, true);
    }
    db.put("quarantine", "a", {
      agent: "a",
      reason: "REPEATED_PLATFORM_FAILURE",
      until: 0,
    });
    db.put("evidence", "verified", { id: "verified", agent: "a" });
    assert.throws(() => penalties.release("a"), /security/);
    db.remove("evidence", "verified");
    penalties.release("a");
    assert.equal(agent.jailed, false);
  } finally {
    db.close();
  }
});
test("persisted security evidence restores an old release and blocks automatic recovery", async () => {
  const db = new Store(":memory:");
  let agent = { id: "a", jailed: false };
  const agents: any = {
    db,
    get: () => agent,
    update: (_id: string, change: any) => (agent = { ...agent, ...change }),
  };
  const penalties = new Penalties(agents, new Epochs(db), 97, 1, 10);
  try {
    db.put("evidence", "verified", { id: "verified", agent: "a" });
    db.put("quarantine", "a", { agent: "a", releasedAt: 1 });
    penalties.observeResearch(100);
    assert.equal(agent.jailed, true);
    assert.equal(
      db.get<any>("quarantine", "a").reason,
      "CONFLICTING_SIGNATURE",
    );
    penalties.failure("attempt", "a", 100, "INVALID_OUTPUT");
    await penalties.recoverOperational(async () => true, 1000);
    assert.equal(agent.jailed, true);
    assert.equal(db.all("evidence").length, 1);
    assert.equal(db.all("slash").length, 0);
  } finally {
    db.close();
  }
});
test("security evidence arriving during a health probe prevents an operational release", async () => {
  const db = new Store(":memory:");
  let agent = { id: "a", jailed: true };
  const agents: any = {
    db,
    get: () => agent,
    update: (_id: string, change: any) => (agent = { ...agent, ...change }),
  };
  const penalties = new Penalties(agents, new Epochs(db), 97, 1, 10);
  try {
    db.put("quarantine", "a", {
      agent: "a",
      reason: "REPEATED_PLATFORM_FAILURE",
      until: 1,
    });
    await penalties.recoverOperational(async () => {
      // The evidence ledger is authoritative even if an old release/operational row remains.
      db.put("evidence", "verified", { id: "verified", agent: "a" });
      return true;
    }, 100);
    assert.equal(agent.jailed, true);
  } finally {
    db.close();
  }
});
