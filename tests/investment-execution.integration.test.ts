import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Interface, Transaction, Wallet, keccak256 } from "ethers";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { ConfirmedStablePlans } from "../src/confirmed-stable-plans.js";
import {
  PortfolioCollector,
  type PortfolioReader,
} from "../src/portfolio-snapshot.js";
import { V2Dex } from "../src/dex-v2.js";
import { Journal } from "../src/chain.js";
import {
  InvestmentExecution,
  type ExecutionJob,
} from "../src/investment-execution.js";
import { stableFixture } from "./helpers/stable-qsp.js";
import { researchAssetRegistryHash } from "../src/research-context.js";
import { buildExecutionFeedbackSummary } from "../src/execution-feedback.js";
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const blockHash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const abi = new Interface([
  "function decimals() view returns(uint8)",
  "function description() view returns(string)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function factory() view returns(address)",
  "function getPair(address,address) view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
async function setup(
  t: TestContext,
  noAction = false,
  quietTarget = false,
  confirmations = 1,
) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const db = new Store(":memory:");
  t.after(() => db.close());
  const wallet = Wallet.createRandom();
  const owner = wallet.address.toLowerCase();
  const researchAssets = ["BTC", "ETH", "BNB"].map((s, i) => ({
    symbol: "T" + s,
    address: addr(10 + i),
    decimals: 18,
    marketSymbol: s + "USDT",
  }));
  const stable = addr(20),
    router = addr(30),
    factory = addr(31);
  const assets = [
    {
      asset: "native",
      bucket: "BNB",
      decimals: 18,
      feed: addr(40),
      description: "BNB / USD",
    },
    ...researchAssets.map((a, i) => ({
      asset: a.address,
      bucket: ["BTC", "ETH", "BNB"][i]!,
      decimals: 18,
      feed: addr(41 + i),
      description: ["BTC / USD", "ETH / USD", "BNB / USD"][i]!,
    })),
    {
      asset: stable,
      bucket: "STABLE",
      decimals: 18,
      feed: addr(44),
      description: "USDT / USD",
    },
  ];
  const balances = new Map(
    assets.map((a) => [
      a.asset,
      a.asset === stable
        ? (quietTarget ? 942n : noAction ? 1n : 1000n) * 10n ** 18n
        : a.asset === "native"
          ? 10n ** 15n
          : quietTarget && a.asset === researchAssets[2]!.address
            ? 86n * 10n ** 18n
            : 0n,
    ]),
  );
  const balancesByBlock = new Map<number, Map<string, bigint>>([
    [0, new Map(balances)],
  ]);
  const balancesAt = (block?: number) =>
    typeof block === "number"
      ? [...balancesByBlock]
          .filter(([n]) => n <= block)
          .sort(([a], [b]) => b - a)[0]![1]
      : balances;
  const allowances = new Map<string, bigint>();
  let tip = 10,
    nonce = 0,
    autoMine = true;
  const pending = new Map<string, Transaction>(),
    receipts = new Map<string, any>();
  const broadcasts: string[] = [];
  const mine = () => {
    for (const [txHash, tx] of pending) {
      const parsed = abi.parseTransaction({ data: tx.data })!;
      const logs: any[] = [];
      if (parsed.name === "approve")
        allowances.set(tx.to!.toLowerCase(), BigInt(parsed.args[1]));
      else if (parsed.name === "swapExactTokensForTokens") {
        const input = String(parsed.args[2][0]).toLowerCase(),
          output = String(parsed.args[2][1]).toLowerCase(),
          amount = BigInt(parsed.args[0]);
        assert.ok((allowances.get(input) ?? 0n) >= amount);
        balances.set(input, balances.get(input)! - amount);
        balances.set(output, balances.get(output)! + amount);
        for (const [token, from, to] of [
          [input, owner, router],
          [output, router, owner],
        ]) {
          const event = abi.encodeEventLog(abi.getEvent("Transfer")!, [
            from,
            to,
            amount,
          ]);
          logs.push({ address: token, topics: event.topics, data: event.data });
        }
      } else assert.fail("unexpected transaction " + parsed.name);
      balances.set("native", balances.get("native")! - 21000n);
      const blockNumber = ++tip;
      balancesByBlock.set(blockNumber, new Map(balances));
      for (const [index, log] of logs.entries())
        Object.assign(log, {
          index,
          transactionHash: txHash,
          blockNumber,
          blockHash: blockHash(blockNumber),
          removed: false,
        });
      receipts.set(txHash, {
        hash: txHash,
        from: owner,
        to: tx.to,
        status: 1,
        blockNumber,
        blockHash: blockHash(blockNumber),
        logs,
        gasUsed: 21000n,
        gasPrice: 1n,
        confirmations: async () => 2,
      });
      nonce++;
      pending.delete(txHash);
      tip++;
    }
  };
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getBlockNumber: async () => tip,
    getBlock: async (n: number) => ({ number: n, hash: blockHash(n) }),
    send: async (method: string, args: any[]) => {
      assert.equal(method, "eth_getBlockByNumber");
      const n = Number(BigInt(args[0]));
      return {
        hash: blockHash(n),
        number: args[0],
        timestamp: "0x" + Math.floor(now / 1000).toString(16),
      };
    },
    getCode: async (target: string) =>
      target.toLowerCase() === router || target.toLowerCase() === factory
        ? "0x6000"
        : "0x",
    getTransactionCount: async (_wallet: string, tag: string | number) =>
      typeof tag === "number"
        ? [...receipts.values()].filter((r) => r.blockNumber <= tag).length
        : nonce + (tag === "pending" ? pending.size : 0),
    getLogs: async (filter: any) =>
      [...receipts.values()]
        .flatMap((r) => r.logs)
        .filter(
          (log) =>
            log.address === filter.address &&
            log.blockNumber >= filter.fromBlock &&
            log.blockNumber <= filter.toBlock &&
            filter.topics.every(
              (topic: string | null, i: number) =>
                topic === null ||
                topic.toLowerCase() === log.topics[i]?.toLowerCase(),
            ),
        ),
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getBalance: async (_wallet: string, block?: number) =>
      balancesAt(block).get("native"),
    getTransactionReceipt: async (h: string) => receipts.get(h) ?? null,
    broadcastTransaction: async (raw: string) => {
      const tx = Transaction.from(raw);
      broadcasts.push(raw);
      if (!receipts.has(tx.hash!)) pending.set(tx.hash!, tx);
      if (autoMine) mine();
      return { hash: tx.hash };
    },
    call: async (request: any) => {
      const parsed = abi.parseTransaction(request)!;
      const target = String(request.to).toLowerCase();
      let result: unknown[];
      switch (parsed.name) {
        case "decimals":
          result = [assets.some((a) => a.feed === target) ? 8 : 18];
          break;
        case "description":
          result = [assets.find((a) => a.feed === target)!.description];
          break;
        case "latestRoundData":
          result = [
            1,
            100000000,
            Math.floor(now / 1000),
            Math.floor(now / 1000),
            1,
          ];
          break;
        case "balanceOf":
          result = [balancesAt(request.blockTag).get(target) ?? 0n];
          break;
        case "allowance":
          result = [allowances.get(target) ?? 0n];
          break;
        case "factory":
          result = [factory];
          break;
        case "getPair":
          result = [
            addr(
              100 +
                researchAssets.findIndex(
                  (a) => a.address === String(parsed.args[1]).toLowerCase(),
                ),
            ),
          ];
          break;
        case "token0":
          result = [stable];
          break;
        case "token1":
          result = [researchAssets[Number(BigInt(target)) - 100]!.address];
          break;
        case "getReserves":
          result = [10n ** 30n, 10n ** 30n, Math.floor(now / 1000)];
          break;
        case "getAmountsOut":
          result = [[parsed.args[0], parsed.args[0]]];
          break;
        default:
          throw Error("unexpected RPC call " + parsed.name);
      }
      return abi.encodeFunctionResult(parsed.name, result);
    },
  };
  const reader: PortfolioReader = {
    chainId: async () => 97,
    tip: async () => tip,
    block: async (number) => ({
      number,
      hash: blockHash(number),
      timestamp: Math.floor(now / 1000),
    }),
    read: async (asset) => ({
      balance: String(balances.get(asset.asset)),
      decimals: asset.decimals,
      price: {
        answer: "100000000",
        decimals: 8,
        description: asset.description,
        roundId: "1",
        answeredInRound: "1",
        updatedAt: Math.floor(now / 1000),
      },
    }),
  };
  const collector = new PortfolioCollector(
    db,
    reader,
    {
      chainId: 97,
      confirmations,
      maxBlockAgeMs: 600000,
      maxPriceAgeMs: 600000,
      assets,
    },
    () => now,
  );
  const opening = await collector.collect({
    id: "opening",
    agent: "investor",
    wallet: owner,
    gasReserveWei: "1000000",
    reservationSource: "empty",
    reserved: Object.fromEntries(assets.map((a) => [a.asset, "0"])),
  });
  const f = await stableFixture(
    "round",
    {
      chainId: 97,
      assets: researchAssets,
      testnetProfile: {
        kind: "bsc97-test-assets/1",
        registryHash: researchAssetRegistryHash(researchAssets),
      },
    },
    { now },
  );
  if (quietTarget) {
    f.allocation.targets.forEach((target, i) => {
      target.targetWeightBps = i === 2 ? 850 : 0;
    });
    await f.resign();
  }
  db.put("epoch", "round", f.epoch);
  db.put("agent", "investor", {
    id: "investor",
    owner: "owner",
    wallet: owner,
    launch: "CONFIRMED",
    jailed: false,
    autoStake: true,
  });
  db.put("chain-state", "investor", {
    known: true,
    observedAt: now,
    bonded: "300000000000000000",
    exit: "0",
    block: 9,
    hash: blockHash(9),
    balance: String(balances.get("native")),
  });
  const budget = new Budget(db);
  budget.credit("investor", "fund", 1000n);
  const consumer = new ConfirmedStablePlans(db, budget, 97, 600000, () => 100n);
  now += 20;
  const consumed = consumer.consume("round", opening.id, now);
  assert.equal(consumed.status, "PLANNED", consumed.reason);
  const dex = new V2Dex(
    db,
    provider,
    {
      chainId: 97,
      router,
      factory,
      routerCodeHash: keccak256("0x6000"),
      factoryCodeHash: keccak256("0x6000"),
      tokens: [stable, ...researchAssets.map((a) => a.address)],
    },
    () => now,
  );
  let executor: InvestmentExecution;
  const restart = (
    options: { enabled?: boolean; maxTransactionFeeWei?: string } = {
      enabled: true,
    },
    gasReserveWei = "1000000",
  ) => {
    const journal = new Journal(db, provider, 97, true, {}, (planId) =>
      executor.assertCanSign(planId),
    );
    executor = new InvestmentExecution(
      db,
      consumer,
      collector,
      dex,
      journal,
      () => wallet,
      {
        ...options,
        retryMs: 100,
        maxTransactionFeeWei: options.maxTransactionFeeWei ?? "100000000000",
      },
      gasReserveWei,
      () => now,
    );
  };
  restart();
  const job = () =>
    db
      .all<ExecutionJob>("investment-execution-job")
      .find((j) => j.agent === "investor")!;
  const tick = async () => {
    now += 101;
    await executor.tick();
  };
  const finish = async () => {
    for (let i = 0; i < 25 && !["DONE", "ABORTED"].includes(job()?.status); i++)
      await tick();
    return job();
  };
  return {
    db,
    consumer,
    collector,
    budget,
    provider,
    opening,
    consumed,
    balances,
    stable,
    researchAssets,
    broadcasts,
    job,
    tick,
    finish,
    restart,
    mine,
    mineEmpty: () => {
      tip += 2;
    },
    setAutoMine: (value: boolean) => (autoMine = value),
    advance: (ms: number) => (now += ms),
  };
}
test("automatic signed plan approves, swaps, settles and records feedback across restart without duplicates", async (t) => {
  const x = await setup(t);
  await x.tick();
  assert.equal(x.job().status, "ACTIVE");
  await x.tick();
  assert.equal(x.broadcasts.length, 1);
  x.restart();
  const done = await x.finish();
  assert.equal(done.status, "DONE", JSON.stringify(done));
  assert.equal(x.db.all("transaction").length, 6);
  assert.equal(x.db.all("dex-v2-fill").length, 3);
  assert.equal(
    x.db.get<any>("wallet-reservation", done.reservationId!).status,
    "SETTLED",
  );
  assert.ok(x.balances.get(x.stable)! < 1000n * 10n ** 18n);
  for (const a of x.researchAssets) assert.ok(x.balances.get(a.address)! > 0n);
  const feedback = buildExecutionFeedbackSummary(x.db, {
    chainId: 97,
    roundId: "round",
  });
  assert.equal(feedback.wallets[0]!.fillIds.length, 3);
  assert.equal(feedback.wallets[0]!.status, "KNOWN");
  // Six gas charges cross the native holding's integer micro-USD floor.
  assert.equal(feedback.wallets[0]!.periodPnlMicros, "-1");
  assert.equal(feedback.network!.status, "KNOWN");
  assert.equal(
    x.db
      .all<any>("execution-cashflow-proof")
      .filter((p) => p.status === "KNOWN").length,
    1,
  );
  assert.equal(x.db.all("investment-execution-round").length, 1);
  const before = x.broadcasts.length;
  x.restart();
  for (let i = 0; i < 3; i++) await x.tick();
  assert.equal(x.broadcasts.length, before);
  assert.equal(x.db.all("execution-feedback-wallet").length, 1);
});
test("pending approval survives expiry and is reconciled without starting a swap", async (t) => {
  const x = await setup(t);
  x.setAutoMine(false);
  await x.tick();
  await x.tick();
  assert.equal(x.broadcasts.length, 1);
  x.advance(700000);
  x.restart();
  await x.tick();
  assert.equal(x.job().status, "ACTIVE");
  assert.equal(x.broadcasts.length, 1);
  x.mine();
  const done = await x.finish();
  assert.equal(done.status, "ABORTED", JSON.stringify(done));
  assert.equal(x.db.all("transaction").length, 1);
  assert.equal(x.db.all("dex-v2-fill").length, 0);
  assert.equal(
    x.db.get<any>("wallet-reservation", done.reservationId!).status,
    "ABORTED",
  );
  assert.equal(x.db.all("execution-feedback-wallet").length, 1);
});
test("revoked worker reconciles a confirmed approval and signs no trade", async (t) => {
  const x = await setup(t);
  await x.tick();
  await x.tick();
  x.db.put("agent", "investor", {
    ...x.db.get<any>("agent", "investor"),
    jailed: true,
  });
  const done = await x.finish();
  assert.equal(done.status, "ABORTED", JSON.stringify(done));
  assert.equal(x.db.all("transaction").length, 1);
  assert.equal(x.db.all("dex-v2-fill").length, 0);
  assert.equal(x.db.all("execution-feedback-wallet").length, 1);
});

test("an already signed swap records its confirmed fill after expiry but cannot start the next order", async (t) => {
  const x = await setup(t);
  await x.tick();
  await x.tick();
  x.setAutoMine(false);
  await x.tick();
  assert.equal(x.broadcasts.length, 2);
  x.advance(700000);
  x.restart();
  await x.tick();
  assert.equal(x.db.all("dex-v2-fill").length, 0);
  assert.equal(x.broadcasts.length, 2);
  x.mine();
  const done = await x.finish();
  assert.equal(done.status, "ABORTED", JSON.stringify(done));
  assert.equal(x.db.all("transaction").length, 2);
  assert.equal(x.db.all("dex-v2-fill").length, 1);
  assert.equal(
    x.db.get<any>("wallet-reservation", done.reservationId!).status,
    "ABORTED",
  );
  assert.equal(
    buildExecutionFeedbackSummary(x.db, { chainId: 97, roundId: "round" })
      .wallets[0]!.fillIds.length,
    1,
  );
});

test("execution defaults disabled and discovers no jobs or signed intents", async (t) => {
  const x = await setup(t);
  x.restart({});
  for (let i = 0; i < 3; i++) await x.tick();
  assert.equal(x.db.all("stable-wallet-plan").length, 1);
  assert.equal(x.db.all("investment-execution-job").length, 0);
  assert.equal(x.db.all("wallet-reservation").length, 0);
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(x.broadcasts.length, 0);
});

test("a stale REVERTED journal row plus receipt RPC failure cannot release reserved funds", async (t) => {
  const x = await setup(t);
  await x.tick();
  await x.tick();
  const job = x.job(),
    approvalId = job.orders[0]!.approvalId;
  const row = x.db.get<any>("transaction", approvalId);
  x.db.put("transaction", approvalId, { ...row, state: "REVERTED" });
  t.mock.method(x.provider, "getTransactionReceipt", async () => {
    throw Error("receipt unavailable");
  });
  x.restart();
  for (let i = 0; i < 3; i++) await x.tick();
  assert.equal(
    x.db.get<any>("wallet-reservation", job.reservationId!).status,
    "RESERVED",
  );
  assert.equal(x.job().status, "ACTIVE");
  assert.equal(x.db.all("portfolio-snapshot").length, 1);
  assert.equal(x.db.all("execution-feedback-wallet").length, 0);
  assert.equal(x.broadcasts.length, 1);
});

test("an opening snapshot block hash change prevents the first approval", async (t) => {
  const x = await setup(t);
  await x.tick();
  const originalSend = x.provider.send.bind(x.provider);
  t.mock.method(x.provider, "send", async (method: string, args: any[]) => {
    const result = await originalSend(method, args);
    return Number(BigInt(args[0])) === x.opening.blockNumber
      ? { ...result, hash: blockHash(999) }
      : result;
  });
  await x.tick();
  assert.equal(x.broadcasts.length, 0);
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(
    x.db.get<any>("wallet-reservation", x.job().reservationId!).status,
    "RESERVED",
  );
});

test("NO_ACTION members get observations while unexplained balance changes remain UNKNOWN", async (t) => {
  const x = await setup(t),
    idleWallet = Wallet.createRandom().address.toLowerCase();
  const originalBalances = new Map(x.balances);
  for (const asset of x.balances.keys())
    x.balances.set(asset, asset === "native" ? 1000000n : 0n);
  const idleSnapshot = await x.collector.collect({
    id: "idle-opening",
    agent: "idle",
    wallet: idleWallet,
    gasReserveWei: "1000000",
    reservationSource: "empty",
    reserved: Object.fromEntries(
      x.collector.registry.assets.map((a) => [a.asset, "0"]),
    ),
  });
  for (const [asset, balance] of originalBalances)
    x.balances.set(asset, balance);
  x.db.put("agent", "idle", {
    ...x.db.get<any>("agent", "investor"),
    id: "idle",
    wallet: idleWallet,
  });
  x.db.put("chain-state", "idle", x.db.get("chain-state", "investor"));
  x.budget.credit("idle", "idle-fund", 1000n);
  const consumed = x.consumer.consume("round", idleSnapshot.id, Date.now());
  assert.equal(consumed.status, "PLANNED");
  assert.equal(
    x.db.get<any>("stable-wallet-plan", consumed.planId!).status,
    "NO_ACTION",
  );
  const planning = {
    id: "idle-planning",
    epoch: "round",
    agent: "idle",
    wallet: idleWallet,
    deadline: Date.now() + 600000,
    configHash: "fixture",
    status: "DONE",
    attempts: 1,
    nextAt: Date.now(),
    planId: consumed.planId,
  };
  x.db.put("investment-planning-job", planning.id, planning);
  await x.tick();
  assert.equal((await x.finish()).status, "DONE");
  const summary = buildExecutionFeedbackSummary(x.db, {
    chainId: 97,
    roundId: "round",
  });
  assert.equal(summary.network!.status, "UNKNOWN");
  assert.ok(summary.network!.missingWallets.includes(idleWallet));
  assert.equal(summary.wallets.length, 2);
  assert.equal(x.db.all("investment-execution-job").length, 2);
  x.db.put("investment-planning-job", "idle-only", {
    ...planning,
    id: "idle-only",
    epoch: "idle-only",
  });
  await x.tick();
  const idleRound = buildExecutionFeedbackSummary(x.db, {
    chainId: 97,
    roundId: "idle-only",
  });
  assert.deepEqual(idleRound.network!.missingWallets, [idleWallet]);
  assert.equal(idleRound.network!.periodPnlMicros, null);
  assert.equal(
    x.db
      .all<any>("investment-execution-round")
      .filter((r) => r.roundId === "idle-only").length,
    1,
  );
});

test("quote expiry after reservation binding and during preflight prevents swap signing", async (t) => {
  const x = await setup(t);
  await x.tick();
  await x.tick();
  const originalBalance = x.provider.getBalance.bind(x.provider);
  let expired = false;
  t.mock.method(x.provider, "getBalance", async (...args: any[]) => {
    if (!expired && x.db.all("wallet-reservation-binding").length === 2) {
      expired = true;
      x.advance(31000);
    }
    return originalBalance(...args);
  });
  await x.tick();
  assert.equal(expired, true);
  assert.equal(x.db.all("wallet-reservation-binding").length, 2);
  assert.equal(x.broadcasts.length, 1);
  assert.equal(x.db.all("transaction").length, 1);
  const done = await x.finish();
  assert.equal(done.status, "ABORTED", JSON.stringify(done));
  assert.equal(x.db.all("dex-v2-fill").length, 0);
  assert.equal(
    x.db.get<any>("wallet-reservation", done.reservationId!).status,
    "ABORTED",
  );
});

test("collector registry changes after planning cannot create reservations or approvals", async (t) => {
  const x = await setup(t);
  x.collector.registry.assets.find((a) => a.asset === x.stable)!.decimals = 6;
  x.restart();
  for (let i = 0; i < 3; i++) await x.tick();
  assert.equal(x.db.all("stable-wallet-plan").length, 1);
  assert.equal(x.db.all("wallet-reservation").length, 0);
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(x.broadcasts.length, 0);
});

test("transient closing RPC failure preserves successful execution for later settlement", async (t) => {
  const x = await setup(t);
  for (let i = 0; i < 15 && x.job()?.status !== "RECONCILING"; i++)
    await x.tick();
  assert.equal(x.job().reason, "EXECUTED");
  assert.equal(x.db.all("dex-v2-fill").length, 3);
  const originalCall = x.provider.call.bind(x.provider);
  let failed = false;
  t.mock.method(x.provider, "call", async (request: any) => {
    if (!failed && abi.parseTransaction(request)!.name === "latestRoundData") {
      failed = true;
      throw Error("transient oracle RPC failure");
    }
    return originalCall(request);
  });
  await x.tick();
  assert.equal(failed, true);
  assert.equal(x.job().status, "RECONCILING");
  assert.equal(x.job().reason, "EXECUTED");
  assert.equal(x.job().lastError, "EXECUTION_RETRY_PENDING");
  assert.equal(
    x.db.get<any>("wallet-reservation", x.job().reservationId!).status,
    "RESERVED",
  );
  x.restart();
  const done = await x.finish();
  assert.equal(done.status, "DONE", JSON.stringify(done));
  assert.equal(
    x.db.get<any>("wallet-reservation", done.reservationId!).status,
    "SETTLED",
  );
  assert.equal(x.broadcasts.length, 6);
  assert.equal(x.db.all("execution-feedback-wallet").length, 1);
});

for (const incomingStatus of ["READY", "NO_ACTION"] as const)
  test(`a ${incomingStatus} plan arriving while closing RPC awaits defers immutable network round completion`, async (t) => {
    const x = await setup(t);
    for (let i = 0; i < 15 && x.job()?.status !== "RECONCILING"; i++)
      await x.tick();
    assert.equal(x.job().reason, "EXECUTED");
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => (enter = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const originalCall = x.provider.call.bind(x.provider);
    let held = false;
    t.mock.method(x.provider, "call", async (request: any) => {
      if (!held) {
        held = true;
        enter();
        await gate;
      }
      return originalCall(request);
    });
    const closingTick = x.tick();
    await started;
    try {
      const wallet = Wallet.createRandom().address.toLowerCase();
      const previousBalances = new Map(x.balances);
      if (incomingStatus === "NO_ACTION")
        for (const asset of x.balances.keys())
          x.balances.set(asset, asset === "native" ? 1000000n : 0n);
      const snapshot = await x.collector.collect({
        id: "concurrent-plan",
        agent: "second",
        wallet,
        gasReserveWei: "1000000",
        reservationSource: "empty",
        reserved: Object.fromEntries(
          x.collector.registry.assets.map((a) => [a.asset, "0"]),
        ),
      });
      for (const [asset, balance] of previousBalances)
        x.balances.set(asset, balance);
      x.db.put("agent", "second", {
        ...x.db.get<any>("agent", "investor"),
        id: "second",
        wallet,
      });
      x.db.put("chain-state", "second", x.db.get("chain-state", "investor"));
      x.budget.credit("second", "second-fund", 1000n);
      const consumed = x.consumer.consume("round", snapshot.id, Date.now());
      assert.equal(consumed.status, "PLANNED", consumed.reason);
      assert.equal(
        x.db.get<any>("stable-wallet-plan", consumed.planId!).status,
        incomingStatus,
      );
      x.db.put("investment-planning-job", "concurrent-planning", {
        id: "concurrent-planning",
        epoch: "round",
        agent: "second",
        wallet,
        deadline: Date.now() + 600000,
        configHash: "fixture",
        status: "DONE",
        attempts: 1,
        nextAt: Date.now(),
        planId: consumed.planId,
      });
    } finally {
      release();
    }
    await closingTick;
    assert.equal(x.job().status, "DONE");
    assert.equal(x.db.all("investment-execution-job").length, 1);
    assert.equal(x.db.all("investment-execution-round").length, 0);
    assert.equal(x.db.all("execution-feedback-network").length, 0);
    await x.tick();
    assert.equal(x.db.all("investment-execution-job").length, 2);
    assert.equal(x.db.all("investment-execution-round").length, 0);
  });

test("a transient cashflow log RPC failure retries before immutable feedback is finalized", async (t) => {
  const x = await setup(t);
  for (let i = 0; i < 15 && x.job()?.status !== "RECONCILING"; i++)
    await x.tick();
  const original = x.provider.getLogs.bind(x.provider);
  let failed = false;
  t.mock.method(x.provider, "getLogs", async (filter: any) => {
    if (!failed) {
      failed = true;
      throw Error("transient log RPC failure");
    }
    return original(filter);
  });
  await x.tick();
  assert.equal(failed, true);
  assert.equal(x.job().status, "RECONCILING");
  assert.equal(x.job().reason, "EXECUTED");
  assert.equal(x.db.all("execution-feedback-wallet").length, 0);
  assert.equal(x.db.all("investment-execution-round").length, 0);
  assert.ok(
    x.db
      .all<any>("execution-cashflow-proof")
      .some(
        (p) => p.status === "UNKNOWN" && p.reasons.includes("RPC_UNAVAILABLE"),
      ),
  );
  x.restart();
  assert.equal((await x.finish()).status, "DONE");
  assert.equal(
    buildExecutionFeedbackSummary(x.db, { chainId: 97, roundId: "round" })
      .wallets[0]!.status,
    "KNOWN",
  );
  assert.equal(x.broadcasts.length, 6);
});

test("signed NO_ACTION round proves zero flow without reservations or signatures and reaches research", async (t) => {
  const x = await setup(t, true);
  assert.equal(
    x.db.get<any>("stable-wallet-plan", x.consumed.planId!).status,
    "NO_ACTION",
  );
  await x.tick();
  assert.equal(x.job()?.status, "RECONCILING");
  assert.equal(x.job().reason, "NO_ACTION");
  assert.equal(x.db.all("wallet-reservation").length, 0);
  await x.tick();
  assert.equal(x.db.all("investment-execution-round").length, 0);
  x.mineEmpty();
  x.restart();
  const done = await x.finish();
  assert.equal(done.status, "DONE", JSON.stringify(done));
  assert.equal(done.reason, "NO_ACTION");
  assert.equal(done.reservationId, undefined);
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(x.broadcasts.length, 0);
  assert.equal(x.db.all("wallet-reservation").length, 0);
  const summary = buildExecutionFeedbackSummary(x.db, {
    chainId: 97,
    roundId: "round",
  });
  assert.equal(summary.wallets[0]!.status, "KNOWN");
  assert.equal(summary.wallets[0]!.periodPnlMicros, "0");
  assert.equal(summary.network!.status, "KNOWN");
  const { collectExecutionFeedbackEvidence } =
    await import("../src/research-data.js");
  assert.equal(
    collectExecutionFeedbackEvidence(x.db, 97, Date.now())!.feedback.roundId,
    "round",
  );
  assert.deepEqual(
    x.db.all<any>("execution-cashflow-proof").find((p) => p.status === "KNOWN")
      .transactionIds,
    [],
  );
});

test("expired or missing NO_ACTION source cannot produce a known observation", async (t) => {
  for (const missing of [false, true]) {
    const x = await setup(t, true);
    if (missing) x.db.remove("epoch", "round");
    else x.advance(700000);
    await x.tick();
    assert.equal(x.job()?.status, "ABORTED");
    assert.equal(x.db.all("wallet-reservation").length, 0);
    assert.equal(x.db.all("transaction").length, 0);
    assert.equal(
      buildExecutionFeedbackSummary(x.db, { roundId: "round", chainId: 97 })
        .network!.status,
      "UNKNOWN",
    );
  }
});

test("disabled recovery leaves another chain's NEW execution job untouched", async (t) => {
  const x = await setup(t);
  x.restart({});
  const foreign: ExecutionJob = {
    id: "foreign-job",
    planId: "foreign-plan",
    roundId: "foreign-round",
    chainId: 56,
    agent: "foreign-agent",
    wallet: addr(999),
    status: "NEW",
    orders: [],
    index: 0,
    attempts: 0,
    nextAt: 0,
    configHash: "foreign-config",
  };
  x.db.put("investment-execution-job", foreign.id, foreign);
  await x.tick();
  assert.deepEqual(x.db.get("investment-execution-job", foreign.id), foreign);
  assert.equal(x.db.all("wallet-reservation").length, 0);
  assert.equal(x.broadcasts.length, 0);
});

test("a funded wallet with a below-floor target deficit completes a quiet observed round", async (t) => {
  const x = await setup(t, false, true);
  const plan = x.db.get<any>("stable-wallet-plan", x.consumed.planId!)!;
  assert.ok(BigInt(x.opening.navMicros) > 1000000000n);
  assert.equal(plan.status, "NO_ACTION");
  assert.equal(plan.reason, "BUY_BUDGET_BELOW_ECONOMIC_FLOOR");
  await x.tick();
  assert.equal(x.job().status, "RECONCILING");
  x.mineEmpty();
  assert.equal((await x.finish()).status, "DONE");
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(x.db.all("wallet-reservation").length, 0);
  const summary = buildExecutionFeedbackSummary(x.db, {
    roundId: "round",
    chainId: 97,
  });
  assert.equal(summary.network!.status, "KNOWN");
  assert.equal(summary.wallets[0]!.periodPnlMicros, "0");
});

test("a READY plan blocked by its gas budget expires without signatures or reservations", async (t) => {
  const x = await setup(t);
  x.restart({ enabled: true, maxTransactionFeeWei: "1000000000000000000" });
  await x.tick();
  assert.equal(x.job().status, "NEW");
  assert.equal(x.job().lastError, "EXECUTION_RETRY_PENDING");
  assert.equal(x.db.all("wallet-reservation").length, 0);
  assert.equal(x.broadcasts.length, 0);
  x.advance(700000);
  await x.tick();
  assert.equal(x.job().status, "ABORTED");
  assert.equal(x.job().reason, "SOURCE_WINDOW_CLOSED");
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(
    buildExecutionFeedbackSummary(x.db, { roundId: "round", chainId: 97 })
      .network!.status,
    "UNKNOWN",
  );
});

test("disabled recovery uses the job's original gas reserve after a deployment setting changes", async (t) => {
  const x = await setup(t);
  await x.tick();
  await x.tick();
  const originalConfig = x.job().configHash;
  x.restart({ enabled: false }, "1000000000000000000");
  const done = await x.finish();
  assert.equal(done.status, "ABORTED", JSON.stringify(done));
  assert.equal(done.configHash, originalConfig);
  assert.equal(
    x.db.get<any>("wallet-reservation", done.reservationId!).status,
    "ABORTED",
  );
  const closing = x.db.get<any>("portfolio-snapshot", done.closingSnapshotId!);
  const capture = x.db.get<any>("portfolio-capture", closing.requestId);
  assert.equal(capture.request.gasReserveWei, "1000000");
  assert.equal(x.broadcasts.length, 1);
});

test("recovery cannot weaken a job's confirmation count after a configuration upgrade", async (t) => {
  const x = await setup(t, false, false, 4);
  await x.tick();
  await x.tick();
  const approvalId = x.job().orders[0]!.approvalId;
  x.collector.registry.confirmations = 1;
  x.restart({ enabled: false });
  await x.tick();
  assert.equal(x.job().status, "ACTIVE");
  assert.equal(x.db.get<any>("transaction", approvalId).state, "READY");
  assert.equal(
    x.db.get<any>("wallet-reservation", x.job().reservationId!).status,
    "RESERVED",
  );
  const originalReceipt = x.provider.getTransactionReceipt.bind(x.provider);
  t.mock.method(x.provider, "getTransactionReceipt", async (id: string) => {
    const receipt = await originalReceipt(id);
    if (receipt) receipt.confirmations = async () => 4;
    return receipt;
  });
  t.mock.method(x.provider, "getBlockNumber", async () => 20);
  const done = await x.finish();
  assert.equal(done.status, "ABORTED", JSON.stringify(done));
  const closing = x.db.get<any>("portfolio-snapshot", done.closingSnapshotId!);
  assert.equal(
    x.db.get<any>("portfolio-capture", closing.requestId).registry
      .confirmations,
    4,
  );
  const proof = x.db
    .all<any>("execution-cashflow-proof")
    .find((p) => p.status === "KNOWN");
  assert.equal(proof.confirmations, 4);
  assert.equal(x.broadcasts.length, 1);
});

test("NO_ACTION rejects a changed deployment registry before starting reconciliation", async (t) => {
  const x = await setup(t, true);
  x.collector.registry.confirmations = 2;
  x.restart();
  await x.tick();
  assert.equal(x.job().status, "ABORTED");
  assert.equal(x.job().reason, "NO_ACTION_SOURCE_INVALID");
  x.mineEmpty();
  x.advance(700000);
  await x.tick();
  assert.equal(x.job().status, "ABORTED");
  assert.equal(x.db.all("transaction").length, 0);
  assert.equal(x.db.all("wallet-reservation").length, 0);
  assert.equal(x.db.all("execution-cashflow-proof").length, 0);
  assert.equal(
    buildExecutionFeedbackSummary(x.db, { roundId: "round", chainId: 97 })
      .network!.status,
    "UNKNOWN",
  );
});

test("persistent receipt RPC failures give every due recovery job a bounded turn", async (t) => {
  const x = await setup(t);
  await x.tick();
  await x.tick();
  const original = x.job();
  assert.equal(x.broadcasts.length, 1);
  x.restart({ enabled: false });
  x.db.remove("investment-execution-job", original.id);
  // Seed nine recovery queue entries from genuine signed approval state. They
  // share receipt evidence because this fault never advances past its RPC read.
  for (let i = 8; i >= 0; i--) {
    const id = `recovery-${i}`;
    x.db.put("investment-execution-job", id, {
      ...original,
      id,
      attempts: 0,
      nextAt: 0,
      leaseUntil: 0,
    });
  }
  t.mock.method(x.provider, "getTransactionReceipt", async () => {
    throw Error("receipt service unavailable");
  });
  const jobs = () => x.db.all<ExecutionJob>("investment-execution-job");
  await x.tick();
  assert.deepEqual(
    jobs()
      .filter((j) => j.attempts === 1)
      .map((j) => j.id),
    ["recovery-0", "recovery-1", "recovery-2", "recovery-3"],
  );
  // Each poll is later than retryMs: the failed first batch is always due.
  for (let i = 0; i < 2; i++) {
    x.advance(15000);
    await x.tick();
  }
  assert.ok(
    jobs().every((j) => j.attempts >= 1),
    "every job must run within ceil(9/4) ticks",
  );
  for (let i = 0; i < 3; i++) {
    x.advance(15000);
    await x.tick();
  }
  assert.ok(
    jobs().every((j) => j.attempts >= 2),
    "fairness must survive repeated failures",
  );
  assert.ok(
    jobs().every(
      (j) => j.status === "ACTIVE" && j.lastError === "EXECUTION_RETRY_PENDING",
    ),
  );
  assert.equal(x.broadcasts.length, 1);
  assert.equal(x.db.all("transaction").length, 1);
  assert.equal(
    x.db.get<any>("wallet-reservation", original.reservationId!).status,
    "RESERVED",
  );
});

test("a gas reserve change before discovery rejects old READY and NO_ACTION captures", async (t) => {
  for (const noAction of [false, true]) {
    const x = await setup(t, noAction);
    x.restart({ enabled: true }, "1000000000000000000");
    await x.tick();
    assert.equal(x.db.all("wallet-reservation").length, 0);
    assert.equal(x.db.all("transaction").length, 0);
    x.advance(700000);
    await x.tick();
    assert.equal(x.job().status, "ABORTED");
    assert.equal(x.db.all("execution-cashflow-proof").length, 0);
  }
});

test("already initialized jobs with mismatched deployment reserve recover using the opening capture", async (t) => {
  const { hash } = await import("../src/protocol.js");
  for (const noAction of [false, true]) {
    const x = await setup(t, noAction);
    await x.tick();
    const job = x.job();
    // Reproduce persisted jobs admitted before the reserve consistency guard.
    const deployment = x.db.get<any>(
      "investment-execution-config",
      job.configHash,
    );
    const changed = { ...deployment, gasReserveWei: "1000000000000000000" };
    const changedHash = hash(changed);
    x.db.put("investment-execution-config", changedHash, changed);
    x.db.put("investment-execution-job", job.id, {
      ...job,
      configHash: changedHash,
    });
    x.restart({ enabled: false }, changed.gasReserveWei);
    x.mineEmpty();
    const done = await x.finish();
    assert.equal(
      done.status,
      noAction ? "DONE" : "ABORTED",
      JSON.stringify(done),
    );
    const closing = x.db.get<any>(
      "portfolio-snapshot",
      done.closingSnapshotId!,
    );
    const capture = x.db.get<any>("portfolio-capture", closing.requestId);
    assert.equal(capture.request.gasReserveWei, "1000000");
    assert.equal(
      closing.holdings.find((h: any) => h.asset === "native").gasExcluded,
      "1000000",
    );
    assert.equal(x.db.all("transaction").length, 0);
    if (!noAction)
      assert.equal(
        x.db.get<any>("wallet-reservation", job.reservationId!).status,
        "ABORTED",
      );
  }
});

test("recovery cannot replace the opening snapshot gas exclusion with a modified capture reserve", async (t) => {
  const x = await setup(t, true);
  await x.tick();
  const capture = x.db.get<any>("portfolio-capture", x.opening.requestId);
  x.db.put("portfolio-capture", x.opening.requestId, {
    ...capture,
    request: { ...capture.request, gasReserveWei: "0" },
  });
  x.mineEmpty();
  await x.tick();
  assert.equal(x.job().status, "RECONCILING");
  assert.equal(x.job().lastError, "EXECUTION_RETRY_PENDING");
  assert.equal(x.job().closingSnapshotId, undefined);
  assert.equal(x.db.all("execution-cashflow-proof").length, 0);
  x.db.put("portfolio-capture", x.opening.requestId, capture);
  assert.equal((await x.finish()).status, "DONE");
});
