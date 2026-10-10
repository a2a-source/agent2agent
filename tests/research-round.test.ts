import { Confirmations, verifyPublishedEpoch } from "../src/confirmation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { Store } from "../src/store.js";
import { Agents } from "../src/agents.js";
import { WalletVault } from "../src/wallet.js";
import { Budget } from "../src/budget.js";
import { Epochs } from "../src/epochs.js";
import { Runner } from "../src/runner.js";
import { Llm } from "../src/llm.js";
import { AgentRuntime } from "../src/agent-runtime.js";
import { loadConfig } from "./test-config.js";
import { ResearchData } from "../src/research-data.js";
import {
  researchAssetRegistryHash,
  portfolioSnapshot,
  compareContext,
  contextSchema,
  evidence,
} from "../src/research-context.js";
import { hash } from "../src/protocol.js";
import { qspV2Schema, decisionSchema } from "../src/qsp-v2.js";
import { verifyQsp } from "../src/qsp.js";
for (const testnet of [false, true]) {
  test(`three v2 rounds bind context, reports and configured allocation identities on ${testnet ? "BSC97" : "mainnet"}`, async (t) => {
    const config = loadConfig();
    config.research.enabled = true;
    if (testnet) {
      config.chain.id = 97;
      config.research.chainId = 97;
      config.research.assets = config.research.assets.map((a, i) => ({
        ...a,
        symbol: ["QBTC", "QETH", "QBNB"][i]!,
        address: "0x" + (100 + i).toString(16).padStart(40, "0"),
      }));
      config.research.testnetProfile = {
        kind: "bsc97-test-assets/1",
        registryHash: researchAssetRegistryHash(config.research.assets),
      };
    }
    config.network.timeoutMs = 3600000;
    config.network.stateMaxAgeMs = 3600000;
    const accountingPromptRoles = new Set<string>();
    t.after(() => {
      assert.ok(accountingPromptRoles.has("positions"));
      assert.ok(accountingPromptRoles.has("master"));
    });
    const runtimeRun = AgentRuntime.prototype.run;
    t.mock.method(
      AgentRuntime.prototype,
      "run",
      async function (
        this: AgentRuntime,
        agent: string,
        id: string,
        system: string,
        input: string,
        tools: import("../src/agent-runtime.js").ResearchTool[] = [],
        signal?: AbortSignal,
        outputSchema?: Record<string, unknown>,
      ) {
        const supplied = JSON.parse(input);
        if (supplied.context) {
          assert.equal(
            supplied.context.accountingBrief.lifetimeUSDT.status,
            "UNKNOWN",
          );
          assert.match(
            supplied.context.accountingBrief.guidance,
            /Latest UNKNOWN does not erase an older KNOWN/,
          );
          if (supplied.identity?.role === "positions")
            accountingPromptRoles.add("positions");
          if (id.includes("synthesis")) accountingPromptRoles.add("master");
        }
        return runtimeRun.call(
          this,
          agent,
          id,
          system,
          input,
          tools.map((t) =>
            t.name === "research_snapshot"
              ? t
              : {
                  ...t,
                  run: async () => ({
                    data: null,
                    sources: [],
                    missing: ["fixture unavailable"],
                  }),
                },
          ),
          signal,
          outputSchema,
        );
      },
    );
    let round = 0;
    t.mock.method(ResearchData.prototype, "collect", async (previous: any) => {
      round++;
      const now = Date.now(),
        asset = config.research.assets[0]!;
      const price = String(1000000 + round * 100000),
        qty = round === 1 ? "0" : "1000000000000000000";
      const proof = evidence("market", "https://example.com/market", now, {
        round,
      });
      db.put("research-evidence", proof.id, { ...proof, data: { round } });
      const portfolio = portfolioSnapshot(
        [{ ...asset, quantity: qty, priceMicros: price, costMicros: null }],
        true,
      );
      const markets = config.research.assets.map((marketAsset) => ({
        ...marketAsset,
        priceMicros: price,
        asOf: now,
        changeBps: 100,
        volatilityBps: 50,
        smaMicros: price,
        samples: 60,
        evidenceId: proof.id,
      }));
      return contextSchema.parse({
        version: "research-context/1",
        at: now,
        chainId: config.research.chainId,
        ...(config.research.testnetProfile
          ? { testnetProfile: config.research.testnetProfile }
          : {}),
        universe: config.research.assets,
        portfolio,
        portfolioIdentity: {
          wallet: "test",
          scope: "CONFIGURED_ASSETS_AND_NATIVE",
          blockNumber: round,
          blockHash: "block" + round,
          nativeBalanceWei: "0",
          gasReserveWei: "0",
          stakeExcluded: true,
        },
        markets,
        liquidity: [],
        news: [],
        evidence: [proof],
        missing: ["No live liquidity"],
        previous: previous
          ? {
              epoch: previous.epoch,
              hash: previous.hash,
              signals: previous.signals,
            }
          : null,
        changes: compareContext(previous?.context, {
          portfolio,
          markets,
          chainId: config.research.chainId,
          ...(config.research.testnetProfile
            ? { testnetProfile: config.research.testnetProfile }
            : {}),
          universe: config.research.assets,
          portfolioIdentity: {
            wallet: "test",
            scope: "CONFIGURED_ASSETS_AND_NATIVE",
          },
        }),
        policy: {
          maxAssetBps: 3000,
          maxTotalBps: 8000,
          validForMs: 300000,
          minLiquidityUsd: 1000000,
          maxSlippageBps: 100,
        },
      });
    });
    let requests = 0;
    const masterPrompts: any[] = [];
    const constrainedRequests: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (b) => (raw += b));
      req.on("end", () => {
        requests++;
        const body = JSON.parse(raw);
        const x = JSON.parse(body.messages[1].content);
        const role = x.identity?.role;
        if (x.reports) constrainedRequests.push(body);
        if (
          ["market", "news", "macro"].includes(role) &&
          !body.messages.some((m: any) => m.role === "tool")
        ) {
          const calls =
            role === "market"
              ? [
                  { name: "research_snapshot", arguments: "{}" },
                  ...config.research.assets.map((a) => ({
                    name: "market_klines",
                    arguments: JSON.stringify({
                      symbol: a.marketSymbol,
                      interval: "1h",
                      limit: 24,
                    }),
                  })),
                ]
              : role === "news"
                ? [
                    ...["Bitcoin", "Ethereum", "BNB Chain"].map((query) => ({
                      name: "news_search",
                      arguments: JSON.stringify({ query }),
                    })),
                    {
                      name: "fetch_page",
                      arguments: JSON.stringify({ url: "https://example.com" }),
                    },
                  ]
                : [
                    {
                      name: "fetch_page",
                      arguments: JSON.stringify({ url: "https://example.com" }),
                    },
                  ];
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: calls.map((fn, i) => ({
                      id: "tool" + i,
                      type: "function",
                      function: fn,
                    })),
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          );
          return;
        }
        if (x.reports) {
          masterPrompts.push(x);
          const market = x.reports.find((r: any) => r.role === "market");
          assert.equal(market.toolEvidence.length, 4);
          assert(
            market.toolEvidence.some(
              (e: any) => e.tool === "research_snapshot",
            ),
          );
          assert.match(market.toolEvidence[0].contentHash, /^[0-9a-f]{64}$/);
        }
        const result = x.workers
          ? {
              assignments: x.roles.map((role: string, i: number) => ({
                role,
                agent: x.workers[i % x.workers.length],
              })),
            }
          : x.reports
            ? {
                summary: `Portfolio ${x.context.portfolio.status}; value ${x.context.portfolio.valueMicros}`,
                sections: x.reportTemplate.sections.map((s: any) => ({
                  id: s.id,
                  content: "Fixture analysis with explicit gaps",
                  evidenceRefs: [x.context.evidence[0].id],
                })),
                decisions: x.reports.map((r: any) => ({
                  role: r.role,
                  decision: "QUALIFY",
                  reason: "Data gaps preserved",
                })),
                disagreements: [],
                stableNetworkAllocation:
                  round === 1
                    ? null
                    : {
                        version: "stable-network-allocation/1",
                        scope: "NETWORK_MODEL_PORTFOLIO",
                        reserve: "ALLOWLISTED_STABLECOINS",
                        nativeBnb: "INCLUDED_IN_BNB_TARGET",
                        targets: config.research.assets.map((a) => ({
                          asset: a.address,
                          targetWeightBps: 0,
                          evidence: [x.context.evidence[0].id],
                          rationale: "Synthetic stable reserve",
                        })),
                        limitations: ["Synthetic research; not orders"],
                      },
                networkAllocation:
                  round === 1
                    ? null
                    : {
                        version: "network-allocation/1",
                        scope: "NETWORK_MODEL_PORTFOLIO",
                        targets: config.research.assets.map((a) => ({
                          asset: a.address,
                          targetWeightBps: 0,
                          evidence: [x.context.evidence[0].id],
                          rationale: "Synthetic zero-token model allocation",
                        })),
                        limitations: [
                          "Synthetic provider fixture; no executable quotes",
                        ],
                      },
                signals: [],
                risks: ["No verified liquidity"],
              }
            : {
                summary: `Observed ${x.context.portfolio.status}`,
                sections: x.reportTemplate.sections.map((s: any) => ({
                  id: s.id,
                  content: "Fixture analysis with explicit gaps",
                  evidenceRefs: [x.context.evidence[0].id],
                })),
                sources: [],
                missing: [],
                evidenceIds: [x.context.evidence[0].id],
                recommendation: "Observe",
                uncertainty: "Liquidity unavailable",
              };
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(result) } }],
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const db = new Store(":memory:");
    try {
      config.llm.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
      config.agent.toolsEnabled = true;
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
        agents = new Agents(
          db,
          new WalletVault(
            keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
            keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            "test",
          ),
        ),
        budget = new Budget(db),
        epochs = new Epochs(db),
        llm = new Llm(db, budget, config.llm, "test"),
        runner = new Runner(
          agents,
          budget,
          epochs,
          llm,
          config,
          {},
          new AgentRuntime(llm, config.agent),
        );
      for (let i = 0; i < 3; i++) {
        const u = agents.createUser("u" + i),
          a = agents.create(u.id, "x", {
            name: "A",
            symbol: "A",
            meta: "bafy",
          });
        agents.update(a.id, { launch: "CONFIRMED", token: a.wallet });
        budget.credit(a.id, a.id, 10000000n);
        db.put("chain-state", a.id, {
          known: true,
          bonded: "300000000000000000",
          exit: "0",
          observedAt: Date.now(),
        });
      }
      let prior: any;
      for (let i = 0; i < 3; i++) {
        const epoch = epochs.open(i, runner.candidates(), config.network);
        if (i === 0) {
          const original = agents.vault.withWallet.bind(agents.vault);
          let first = true;
          t.mock.method(agents.vault, "withWallet", (...args: any[]) => {
            if (first) {
              first = false;
              throw Error("simulated crash after commitment");
            }
            return (original as any)(...args);
          });
          await assert.rejects(runner.run(epoch), /simulated crash/);
          assert.equal(requests, 11);
          // Expiry is terminal; test that future branch on a copy rather than
          // rewinding the clock and resuming an already expired real round.
          const expiredDb = new Store(":memory:");
          for (const row of db.sql
            .prepare("SELECT kind,id,data FROM records")
            .all())
            expiredDb.put(
              String(row.kind),
              String(row.id),
              JSON.parse(String(row.data)),
            );
          const expiredRunner = new Runner(
            new Agents(expiredDb, agents.vault),
            new Budget(expiredDb),
            new Epochs(expiredDb),
            llm,
            config,
          );
          t.mock.timers.enable({
            apis: ["Date"],
            now: Date.now() + config.research.maxAgeMs + 1,
          });
          try {
            await assert.rejects(expiredRunner.run(epoch), /data expired/);
            assert.equal(expiredRunner.epochs.get(epoch.id).status, "FAILED");
            assert.equal(requests, 11);
          } finally {
            t.mock.timers.reset();
            expiredDb.close();
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        const out = await runner.run(epoch);
        assert.equal(out.version, "a2a-qsp/2");
        if (out.version !== "a2a-qsp/2") throw Error("version");
        assert.equal(out.reports.length, 6);
        if (i === 0)
          assert.equal(out.masterSummary.stableNetworkAllocation, null);
        else
          assert.equal(
            out.masterSummary.stableNetworkAllocation?.reserve,
            "ALLOWLISTED_STABLECOINS",
          );
        assert.deepEqual(
          masterPrompts.at(-1).stableNetworkAllocationInstructions
            .configuredAssets,
          config.research.assets,
        );
        assert.deepEqual(
          masterPrompts.at(-1).stableNetworkAllocationInstructions
            .testnetProfile,
          config.research.testnetProfile ?? null,
        );
        assert.equal(
          masterPrompts.at(-1).stableNetworkAllocationInstructions.scope,
          "NETWORK_MODEL_PORTFOLIO",
        );
        if (i === 0) assert.equal(out.masterSummary.networkAllocation, null);
        else {
          assert.equal(out.masterSummary.networkAllocation?.targets.length, 3);
          assert.equal(
            out.masterSummary.networkAllocation?.targets[0]?.evidence[0],
            out.context.evidence[0]?.id,
          );
        }
        assert.equal(
          masterPrompts.at(-1).networkAllocationInstructions.scope,
          "NETWORK_MODEL_PORTFOLIO",
        );
        assert.equal(out.researchChecks?.profile, "c4/1");
        assert.equal(
          qspV2Schema.safeParse({
            ...out,
            researchChecks: { ...out.researchChecks, facts: {} },
          }).success,
          false,
        );
        const { researchChecks: _checks, ...legacy } = out;
        assert.equal(qspV2Schema.safeParse(legacy).success, true);
        assert.equal(
          qspV2Schema.safeParse({
            ...out,
            masterSummary: { ...out.masterSummary, decisions: [] },
          }).success,
          false,
        );
        assert.equal(
          qspV2Schema.safeParse({ ...out, dataAt: out.dataAt + 1 }).success,
          false,
        );
        assert.equal(out.masterSummary.decisions.length, 6);
        assert.equal(out.contextHash, hash(out.context));
        assert(
          verifyQsp(
            config.chain.id,
            out,
            epochs.get(epoch.id).signature!,
            agents.get(epoch.master).wallet,
          ),
        );
        assert.equal(
          out.context.portfolio.status,
          i === 0 ? "EMPTY" : "FUNDED",
        );
        assert.equal(out.context.portfolio.returnBps, null);
        if (prior) {
          assert.equal(out.context.previous?.hash, hash(prior));
          assert.equal(
            out.context.changes.positions[0]?.quantityDelta,
            i === 1 ? "1000000000000000000" : "0",
          );
          assert.equal(out.context.changes.investmentReturnBps, null);
          assert(out.context.changes.prices[0]!.changeBps > 0);
        }
        const changed = structuredClone(out);
        changed.masterSummary.summary = "tampered";
        assert.equal(
          verifyQsp(
            config.chain.id,
            changed,
            epochs.get(epoch.id).signature!,
            agents.get(epoch.master).wallet,
          ),
          false,
        );
        const published = epochs.get(epoch.id);
        assert(verifyPublishedEpoch(config.chain.id, published));
        assert.equal(published.confirmation!.votes.length, 3);
        // Re-enter confirmation to test corruption after the candidate was frozen.
        db.put("epoch", epoch.id, { ...published, status: "RUNNING" });
        const book = new Confirmations(db);
        const evidenceId = out.context.evidence[0]!.id,
          storedEvidence = db.get<any>("research-evidence", evidenceId);
        db.put("research-evidence", evidenceId, {
          ...storedEvidence,
          data: { corrupted: true },
        });
        assert.throws(
          () => book.intent(epoch, epoch.master),
          /evidence hash changed/,
        );
        db.put("research-evidence", evidenceId, storedEvidence);
        const reportKey = `${epoch.id}:report:${out.reports[0]!.role}`,
          storedReport = db.get<any>("report", reportKey);
        db.put("report", reportKey, {
          ...storedReport,
          report: { ...storedReport.report, summary: "corrupted" },
        });
        assert.throws(
          () => book.intent(epoch, epoch.master),
          /stored report changed/,
        );
        db.put("report", reportKey, storedReport);
        if (out.context.previous) {
          const previous = epochs.get(out.context.previous.epoch);
          db.put("epoch", previous.id, { ...previous, signature: "0x" });
          assert.throws(() => book.intent(epoch, epoch.master), /previous QSP/);
          db.put("epoch", previous.id, {
            ...previous,
            confirmation: undefined,
          });
          assert.throws(() => book.intent(epoch, epoch.master), /previous QSP/);
          db.put("epoch", previous.id, previous);
        }
        book.certificate(epoch);
        db.put("epoch", epoch.id, published);
        prior = out;
      }
      assert.equal(requests, 33);
      for (const body of constrainedRequests) {
        assert.equal(body.response_format?.type, "json_schema");
        assert.equal(body.response_format.json_schema.strict, true);
        const schema = body.response_format.json_schema.schema;
        assert.equal(schema.additionalProperties, false);
        assert(schema.required.includes("sections"));
        if (schema.properties.signals)
          assert.equal(
            schema.properties.signals.items.properties.conditions.type,
            "array",
          );
      }
      for (const prompt of masterPrompts) {
        assert.deepEqual(prompt.reportTemplate, config.reportTemplates.master);
        assert(decisionSchema.safeParse(prompt.requiredOutput).success);
        assert.deepEqual(
          prompt.signalEvidenceRequirements.map((r: any) => [
            r.asset,
            r.requiredMarketEvidence,
          ]),
          prompt.context.markets.map((m: any) => [m.asset, m.evidence]),
        );
        assert.deepEqual(
          Object.keys(prompt.requiredOutput).sort(),
          [
            "sections",
            "summary",
            "decisions",
            "disagreements",
            "networkAllocation",
            "stableNetworkAllocation",
            "signals",
            "risks",
          ].sort(),
        );
        assert.deepEqual(
          prompt.requiredOutput.decisions.map((r: any) => r.role),
          prompt.reports.map((r: any) => r.role),
        );
        assert(
          prompt.requiredOutput.sections.every(
            (s: any) =>
              Object.keys(s).sort().join(",") === "content,evidenceRefs,id",
          ),
        );
      }
      assert.equal(db.all("research-context").length, 3);
    } finally {
      db.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
