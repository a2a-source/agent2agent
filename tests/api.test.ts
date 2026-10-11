import { PerformanceLedger } from "../src/performance-ledger.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Budget } from "../src/budget.js";
import { Epochs } from "../src/epochs.js";
import { createApi } from "../src/server.js";
test("HTTP user identity cannot be forged and another owner cannot read or mutate an agent", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    db = new Store(":memory:");
  const vault = new WalletVault(
    keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "test",
  );
  const agents = new Agents(db, vault),
    alice = agents.createUser("a"),
    bob = agents.createUser("b");
  const server = createApi({
    agents,
    budget: new Budget(db),
    epochs: new Epochs(db),
    performance: new PerformanceLedger(db),
    adminToken: "admin-token-long-enough-for-tests",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const req = (path: string, token: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "req1",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await req("/agents", "invalid")).status, 401);
    assert.equal(
      (await req("/admin/users", alice.token, "POST", { name: "x" })).status,
      403,
    );
    const created = await req("/agents", alice.token, "POST", {
      name: "Alpha",
      symbol: "A",
      meta: "bafy",
    });
    assert.equal(created.status, 201);
    const agent = (await created.json()) as any;
    assert.equal((await req(`/agents/${agent.id}`, bob.token)).status, 404);
    assert.equal(
      (await req(`/agents/${agent.id}/performance`, bob.token)).status,
      404,
    );
    new PerformanceLedger(db).recordRound({
      version: "performance-input/1",
      currency: "micro-USDT",
      roundId: "round1",
      chainId: 56,
      windowStartMs: 1,
      windowEndMs: 2,
      observedAt: 3,
      roster: [{ agentId: agent.id, wallet: agent.wallet }],
      perAgent: [],
    });
    const performanceResponse = await req(
      `/agents/${agent.id}/performance`,
      alice.token,
    );
    assert.equal(performanceResponse.status, 200);
    const history: any = await performanceResponse.json();
    assert.equal(history.length, 1);
    assert.equal(history[0].agent.periodPnL, null);
    const aggregate = await req("/network/performance", alice.token);
    assert.equal(aggregate.status, 200);
    const summary: any = await aggregate.json();
    assert.equal(summary[0].network.periodPnL, null);
    assert.equal(JSON.stringify(summary).includes(agent.wallet), false);
    for (let i = 0; i < 110; i++)
      new PerformanceLedger(db).recordRound({
        version: "performance-input/1",
        currency: "micro-USDT",
        roundId: String(i),
        chainId: 56,
        windowStartMs: 1000 + i,
        windowEndMs: 1001 + i,
        observedAt: 2000,
        roster: [{ agentId: agent.id, wallet: agent.wallet }],
        perAgent: [],
      });
    for (const path of [
      "/network/performance",
      `/agents/${agent.id}/performance`,
    ]) {
      const recent: any = await (await req(path, alice.token)).json();
      assert.equal(recent.length, 100);
      assert.equal(recent[0].roundId, "10");
      assert.equal(recent.at(-1).roundId, "109");
    }

    assert.equal(
      (await req(`/agents/${agent.id}/exit`, bob.token, "POST", {})).status,
      404,
    );
    assert.equal(
      (await req(`/agents/${agent.id}/withdraw`, bob.token, "POST", {})).status,
      404,
    );
    for (const action of ["transfer", "export-key", "execute"]) {
      assert.equal(
        (await req(`/agents/${agent.id}/${action}`, alice.token, "POST", {}))
          .status,
        404,
      );
    }
    const detail = (await (
      await req(`/agents/${agent.id}`, alice.token)
    ).json()) as any;
    assert.equal(detail.wallet, agent.wallet);
    assert.equal(JSON.stringify(detail).includes("ciphertext"), false);
    assert.equal(
      (
        await req("/agents", alice.token, "POST", {
          name: "Alpha",
          symbol: "A",
          meta: "bafy",
          owner: bob.id,
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});
