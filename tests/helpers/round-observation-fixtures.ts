import { Store } from "../../src/store.js";
import { hash } from "../../src/protocol.js";
import { PortfolioCollector } from "../../src/portfolio-snapshot.js";
import {
  RoundObservationService,
  freezeTerminalObservationRoster,
  type RoundObservationOptions,
} from "../../src/round-observation.js";
import { proveRoundNoExternalFlow } from "../../src/round-cashflow.js";
export const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
export const blockHash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export function observationFixture(
  db: Store,
  options: Partial<RoundObservationOptions> = {},
) {
  const state = {
    now: 1000000,
    block: 10,
    price: "100000000",
    fail: false,
    wait: false,
  };
  const registry = {
    chainId: 97,
    confirmations: 2,
    maxBlockAgeMs: 60000,
    maxPriceAgeMs: 60000,
    assets: ["BNB", "BTC", "ETH", "STABLE"].map((bucket, i) => ({
      asset: i ? address(i) : "native",
      bucket,
      decimals: i ? 6 : 18,
      feed: address(i + 10),
      description: bucket + " / USD",
    })),
  };
  const times = new Map<number, number>();
  const reader = {
    chainId: async () => 97,
    tip: async () => state.block + 2,
    block: async (n: number) => ({
      number: n,
      hash: blockHash(n),
      timestamp: times.get(n) ?? state.now / 1000 - 1,
    }),
    read: async (a: any) => {
      if (state.fail && a.bucket === "ETH") throw Error("offline");
      return {
        balance: a.bucket === "STABLE" ? "100000000" : "0",
        decimals: a.decimals,
        price: {
          answer: state.price,
          decimals: 8,
          description: a.description,
          roundId: "1",
          answeredInRound: "1",
          updatedAt: (times.get(state.block) ?? state.now / 1000 - 1) - 1,
        },
      };
    },
  };
  const collector = new PortfolioCollector(
    db,
    reader,
    registry,
    () => state.now,
  );
  const provider: any = {
    send: async (_m: string, args: any[]) => ({
      number: args[0],
      hash: blockHash(Number(BigInt(args[0]))),
    }),
    getNetwork: async () => ({ chainId: 97n }),
    getBlockNumber: async () => state.block + 2,
    getCode: async () => "0x",
    getTransactionCount: async () => 0,
    getLogs: async () => [],
  };
  const adapters = {
    collector,
    selectBoundary: async () => {
      times.set(state.block, state.now / 1000 - 1);
      return {
        blockNumber: state.block,
        blockHash: blockHash(state.block),
        blockTimeMs: state.now - 1000,
      };
    },
    settlementReady: () => !state.wait,
    prove: (a: string, b: string) =>
      proveRoundNoExternalFlow(db, provider, a, b, 2),
  };
  const addAgent = (id: string, n: number) =>
    db.put("agent", id, { id, wallet: address(n), createdAt: 0 });
  const addEpoch = (
    id: string,
    freeze = true,
    finishedAt: number | undefined = state.now - 2000,
  ) => {
    const e: any = {
      id,
      status: "FAILED",
      ...(finishedAt === undefined ? {} : { finishedAt }),
    };
    db.put("epoch", id, e);
    if (freeze) freezeTerminalObservationRoster(db, e);
  };
  const service = () =>
    new RoundObservationService(db, 97, adapters, options, () => state.now);
  const job = (id: string) =>
    db.get<any>("round-observation-job", hash([97, id]));
  return {
    state,
    registry,
    reader,
    provider,
    adapters,
    collector,
    addAgent,
    addEpoch,
    service,
    job,
  };
}
