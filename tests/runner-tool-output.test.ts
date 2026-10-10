import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { AgentRuntime } from "../src/agent-runtime.js";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Budget } from "../src/budget.js";
import { Epochs } from "../src/epochs.js";
import { Runner } from "../src/runner.js";
import { Llm } from "../src/llm.js";
import { loadConfig } from "./test-config.js";
import { hash } from "../src/protocol.js";
import {
  contextSchema,
  portfolioSnapshot,
  compareContext,
} from "../src/research-context.js";
import { verifyPublishedEpoch } from "../src/confirmation.js";

for (const researchEnabled of [false, true]) {
  for (const mode of ["text", "tool"] as const) {
    test(`production Runner publishes ${researchEnabled ? "research v2" : "legacy v1"} through actual ${mode} AgentRuntime`, async () => {
      const config = loadConfig();
      config.research.enabled = researchEnabled;
      config.agent.finalOutputMode = mode;
      config.agent.toolsEnabled = false;
      const requests: { stage: string; body: any }[] = [];
      const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const body = JSON.parse(raw),
            input = JSON.parse(body.messages[1].content);
          const stage = input.workers
            ? "plan"
            : input.reports
              ? "synthesis"
              : "report";
          requests.push({ stage, body });
          const sections = input.reportTemplate?.sections.map((s: any) => ({
            id: s.id,
            content: "Research unavailable; preserve uncertainty.",
            evidenceRefs: [],
          }));
          const result =
            stage === "plan"
              ? // Shape-valid but unbalanced: downstream deterministic repair must remain.
                {
                  assignments: input.roles.map((role: string) => ({
                    role,
                    agent: input.workers[0],
                  })),
                }
              : stage === "synthesis"
                ? researchEnabled
                  ? {
                      summary: "No verified data; no signals",
                      sections,
                      decisions: input.reports.map((r: any) => ({
                        role: r.role,
                        decision: "QUALIFY",
                        reason: "Missing research data",
                      })),
                      disagreements: [],
                      signals: [],
                      risks: ["No verified market data"],
                      networkAllocation: null,
                      stableNetworkAllocation: null,
                    }
                  : { signals: [], risks: ["No verified market data"] }
                : researchEnabled
                  ? {
                      summary: "No verified data",
                      sections,
                      missing: ["No verified data"],
                      evidenceIds: [],
                      recommendation: "Observe",
                      uncertainty: "Data unavailable",
                    }
                  : {
                      summary: "No verified data",
                      sources: [],
                      missing: ["No verified data"],
                    };
          const message =
            mode === "tool"
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `final-${requests.length}`,
                      type: "function",
                      function: {
                        name: "a2a_final_output",
                        arguments: JSON.stringify(result),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: JSON.stringify(result) };
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  finish_reason: mode === "tool" ? "tool_calls" : "stop",
                  message,
                },
              ],
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const db = new Store(":memory:");
      try {
        config.llm.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
        const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const agents = new Agents(
          db,
          new WalletVault(
            keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
            keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            "fixture",
          ),
        );
        const budget = new Budget(db),
          epochs = new Epochs(db),
          llm = new Llm(db, budget, config.llm, "fixture");
        const runner = new Runner(
          agents,
          budget,
          epochs,
          llm,
          config,
          { maxAttempts: 1 },
          new AgentRuntime(llm, config.agent),
        );
        for (let i = 0; i < 3; i++) {
          const user = agents.createUser(`u${i}`),
            agent = agents.create(user.id, "fixture", {
              name: `A${i}`,
              symbol: `A${i}`,
              meta: "fixture",
            });
          agents.update(agent.id, { launch: "CONFIRMED", token: agent.wallet });
          budget.credit(agent.id, `fund:${i}`, 10000000000000000n);
          db.put("chain-state", agent.id, {
            known: true,
            bonded: "300000000000000000",
            exit: "0",
            observedAt: Date.now(),
          });
        }
        const epoch = epochs.open(0, runner.candidates(), config.network);
        if (researchEnabled) {
          // Frozen unavailable context avoids external data adapters, while the
          // production plan, report, synthesis, validation and signing all run.
          const context = contextSchema.parse({
            version: "research-context/1",
            at: Date.now(),
            chainId: config.research.chainId,
            universe: config.research.assets,
            portfolio: portfolioSnapshot([], false),
            portfolioIdentity: {
              wallet: "fixture",
              scope: "CONFIGURED_ASSETS_AND_NATIVE",
              blockNumber: null,
              blockHash: null,
              nativeBalanceWei: null,
              gasReserveWei: "0",
              stakeExcluded: true,
            },
            markets: [],
            liquidity: [],
            news: [],
            evidence: [],
            missing: ["Fixture data unavailable"],
            previous: null,
            changes: compareContext(undefined, {
              portfolio: portfolioSnapshot([], false),
              markets: [],
            }),
            policy: {
              maxAssetBps: 3000,
              maxTotalBps: 8000,
              validForMs: 300000,
              minLiquidityUsd: 1000000,
              maxSlippageBps: 100,
            },
          });
          const version = hash({
            roles: config.roles,
            reportTemplates: config.reportTemplates,
            master: config.masterPrompt,
            llm: config.llm,
            agent: config.agent,
            research: config.research,
          });
          db.insert("research-context", epoch.id, {
            version,
            hash: hash(context),
            context,
          });
        }
        const result = await runner.run(epoch);
        assert.equal(
          result.version,
          researchEnabled ? "a2a-qsp/2" : "a2a-qsp/1",
        );
        assert.equal(result.reports.length, 6);
        assert.equal(result.signals.length, 0);
        assert.equal(epochs.get(epoch.id).status, "PUBLISHED");
        assert(verifyPublishedEpoch(config.chain.id, epochs.get(epoch.id)));
        assert.equal(requests.length, 8);
        assert.equal(db.all("llm-call").length, 8);
        assert.equal(
          db.all<any>("research-task").filter((r) => r.status === "FAILED")
            .length,
          0,
        );
        assert.equal(
          db.get<any>("research-assignment", `${epoch.id}:0`).repaired,
          true,
        );
        assert.equal(new Set(result.reports.map((r: any) => r.agent)).size, 2);
        for (const { stage, body } of requests) {
          if (mode === "tool") {
            assert.equal(body.response_format, undefined);
            const schema = body.tools.find(
              (t: any) => t.function.name === "a2a_final_output",
            ).function.parameters;
            assert.equal(schema.type, "object");
            assert(
              schema.required.includes(
                stage === "plan"
                  ? "assignments"
                  : stage === "report"
                    ? "summary"
                    : "signals",
              ),
            );
            if (stage === "plan")
              assert.equal(schema.properties.assignments.maxItems, 24);
          } else if (stage === "plan" || !researchEnabled) {
            assert.equal(
              body.response_format,
              undefined,
              "existing text transport must stay unchanged",
            );
          }
        }
        for (const row of db.all<any>("agent-context")) {
          if (mode === "tool") assert.equal(row.outputSchema.type, "object");
        }
      } finally {
        db.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}
