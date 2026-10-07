import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Budget } from "../src/budget.js";
import { Epochs } from "../src/epochs.js";
import { Llm } from "../src/llm.js";
import { Runner } from "../src/runner.js";
const model = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const input = JSON.parse(JSON.parse(raw).messages[1].content);
    const result = input.workers
      ? {
          assignments: input.roles.map((role: string, i: number) => ({
            role,
            agent: input.workers[i % input.workers.length],
          })),
        }
      : input.reports
        ? {
            signals: [],
            risks: ["DEMO: no real market data or investment execution"],
          }
        : {
            summary: "DEMO: source unavailable",
            sources: [],
            missing: ["Demo has no live source"],
          };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });
});
await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
const db = new Store(":memory:");
try {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    vault = new WalletVault(
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "demo",
    ),
    agents = new Agents(db, vault),
    budget = new Budget(db),
    epochs = new Epochs(db),
    config = loadConfig();
  // Explicit synthetic exchange rate for the offline demonstration.
  config.llm.bnbUsdMicros = "1000000000";
  config.llm.endpoint = `http://127.0.0.1:${(model.address() as any).port}`;
  const runner = new Runner(
    agents,
    budget,
    epochs,
    new Llm(db, budget, config.llm, "demo"),
    config,
  );
  for (let i = 0; i < 7; i++) {
    const user = agents.createUser(`demo-${i}`),
      a = agents.create(user.id, "launch", {
        name: `Demo ${i}`,
        symbol: `D${i}`,
        meta: "demo-only",
      });
    agents.update(a.id, { launch: "CONFIRMED", token: a.wallet });
    budget.credit(a.id, `demo:${i}`, 100000000000000000n);
    db.put("chain-state", a.id, {
      balance: "0",
      bonded: "300000000000000000",
      exit: "0",
      known: true,
      observedAt: Date.now(),
      block: 0,
      hash: "DEMO",
    });
  }
  const e = epochs.open(0, runner.candidates(), config.network),
    qsp = await runner.run(e);
  console.log(
    JSON.stringify(
      {
        mode: "SIMULATED_CHAIN_AND_LLM",
        committee: e.committee.length,
        master: e.master,
        qsp,
        signature: epochs.get(e.id).signature,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  await new Promise<void>((r) => model.close(() => r()));
}
