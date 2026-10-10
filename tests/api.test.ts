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
