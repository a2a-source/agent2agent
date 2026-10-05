import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Budget } from "../src/budget.js";
import { Epochs } from "../src/epochs.js";
import { Runner } from "../src/runner.js";
import { Llm } from "../src/llm.js";
import { loadConfig } from "../src/config.js";
import { verifyQsp } from "../src/qsp.js";
test("three hosted agents finish six research roles with actual compatible HTTP calls and a signed QSP", async () => {
  const endpoint = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text),
        input = JSON.parse(body.messages[1].content);
      let result: any;
      if (input.workers)
        result = {
          assignments: input.roles.map((role: string, i: number) => ({
            role,
            agent: input.workers[i % input.workers.length],
          })),
        };
      else if (input.reports)
        result = { signals: [], risks: ["No verified market data available"] };
      else
        result = {
          summary: "No supplied data; analysis unavailable",
          sources: [],
          missing: ["source unavailable"],
        };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 50, completion_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:");
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const agents = new Agents(
      db,
      new WalletVault(
        keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        "test",
      ),
    );
    const budget = new Budget(db),
      epochs = new Epochs(db),
      config = loadConfig();
    config.llm.endpoint = `http://127.0.0.1:${(endpoint.address() as any).port}`;
    const runner = new Runner(
      agents,
      budget,
      epochs,
      new Llm(db, budget, config.llm, "test"),
      config,
    );
    for (let i = 0; i < 3; i++) {
      const u = agents.createUser(`u${i}`),
        a = agents.create(u.id, "launch", {
          name: `A${i}`,
          symbol: `A${i}`,
          meta: "bafy",
        });
      agents.update(a.id, { launch: "CONFIRMED", token: a.wallet });
      budget.credit(a.id, `test:${i}`, 10000000000000000n);
      db.put("chain-state", a.id, {
        balance: "0",
        bonded: "300000000000000000",
        exit: "0",
        known: true,
        observedAt: Date.now(),
        block: 1,
        hash: "test",
      });
    }
    const epoch = epochs.open(0, runner.candidates(), config.network);
    const qsp = await runner.run(epoch);
    assert.equal(qsp.reports.length, 6);
    assert.equal(qsp.signals.length, 0);
    assert.equal(epochs.get(epoch.id).status, "PUBLISHED");
    assert.equal(db.all("llm-call").length, 8);
    assert.ok(
      verifyQsp(
        config.chain.id,
        qsp,
        epochs.get(epoch.id).signature!,
        agents.get(epoch.master).wallet,
      ),
    );
    await assert.rejects(runner.run(epoch), /stale/);
  } finally {
    db.close();
    await new Promise<void>((r) => endpoint.close(() => r()));
  }
});
test("healthy successor completes after old Master is quarantined; late provider cannot publish", async () => {
  let delay = 0;
  let onSynthesis: (() => void) | undefined;
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const b = JSON.parse(text),
        input = JSON.parse(b.messages[1].content);
      const result = input.workers
        ? {
            assignments: input.roles.map((role: string, i: number) => ({
              role,
              agent: input.workers[i % input.workers.length],
            })),
          }
        : input.reports
          ? { signals: [], risks: ["missing data"] }
          : { summary: "No data", sources: [], missing: ["missing"] };
      if (input.reports) onSynthesis?.();
      setTimeout(
        () =>
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(result) } }],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            }),
          ),
        delay,
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:");
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      agents = new Agents(
        db,
        new WalletVault(
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          "t",
        ),
      ),
      budget = new Budget(db),
      epochs = new Epochs(db),
      config = loadConfig();
    config.llm.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    config.network.timeoutMs = 1000;
    const runner = new Runner(
      agents,
      budget,
      epochs,
      new Llm(db, budget, config.llm, "test"),
      config,
    );
    for (let i = 0; i < 7; i++) {
      const u = agents.createUser("u"),
        a = agents.create(u.id, "x", { name: "A", symbol: "A", meta: "bafy" });
      agents.update(a.id, { launch: "CONFIRMED", token: a.wallet });
      budget.credit(a.id, a.id, 10000000000000000n);
      db.put("chain-state", a.id, {
        known: true,
        bonded: "300000000000000000",
        exit: "0",
        observedAt: Date.now(),
      });
    }
    const first = epochs.open(
      0,
      runner.candidates(),
      config.network,
      Date.now() - 1001,
    );
    agents.update(first.master, { jailed: true });
    const next = epochs.takeover(first.id, 0, Date.now());
    const result = await runner.run(next);
    assert.equal(result.master, next.master);
    assert.ok(result.reports.every((r) => r.agent !== first.master));
    const revoked = epochs.open(1, runner.candidates(), config.network);
    onSynthesis = () => agents.update(revoked.master, { jailed: true });
    await assert.rejects(runner.run(revoked), /ineligible/);
    assert.notEqual(epochs.get(revoked.id).status, "PUBLISHED");
    onSynthesis = undefined;
    db.put("epoch", revoked.id, {
      ...epochs.get(revoked.id),
      status: "FAILED",
    });
    const late = epochs.open(2, runner.candidates(), config.network);
    delay = 1200;
    await assert.rejects(runner.run(late));
    assert.notEqual(epochs.get(late.id).status, "PUBLISHED");
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
