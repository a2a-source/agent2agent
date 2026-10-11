import { z } from "zod";
import { isAddress, ZeroAddress } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(96);
const time = z.number().int().nonnegative().safe();
const bps = time.max(10000);
const id = z.string().min(1).max(128);
const wallet = z
  .string()
  .refine(isAddress)
  .transform((x) => x.toLowerCase())
  .refine((x) => x !== ZeroAddress);
export const investmentRiskPolicySchema = z
  .object({
    maxVolatileBps: bps.default(6000),
    maxUnderlyingBps: bps.default(2000),
    maxOrderBuyBps: bps.default(1000),
    maxCycleBuyBps: bps.default(1000),
    minTradeMicros: uint.default("10000000"),
    maxGasBps: bps.default(50),
    maxSlippageBps: bps.default(50),
    maxPriceImpactBps: bps.default(50),
    quoteMaxAgeMs: time.positive().default(30000),
  })
  .strict();
const cycleSchema = z
  .object({
    epoch: id,
    agent: id,
    wallet,
    chainId: time.positive(),
    at: time,
    validUntil: time,
    complete: z.literal(true),
    navMicros: uint,
    stableValueMicros: uint,
    availableStableMicros: uint,
    exposures: z.object({ BTC: uint, ETH: uint, BNB: uint }).strict(),
  })
  .strict();
const orderSchema = z
  .object({
    id,
    side: z.enum(["BUY", "SELL"]),
    bucket: z.enum(["BTC", "ETH", "BNB"]),
    notionalMicros: uint,
    gasMicros: uint,
    slippageBps: bps,
    priceImpactBps: bps,
    quoteAt: time,
  })
  .strict();
type Cycle = z.infer<typeof cycleSchema> & {
  id: string;
  policy: z.infer<typeof investmentRiskPolicySchema>;
};
type Order = z.infer<typeof orderSchema> & {
  cycleId: string;
  reservedAt: number;
  inputHash: string;
};
/** Internal reference-budget guard. It is not an onchain balance check or Journal fund lock. */
export class InvestmentRisk {
  readonly policy: z.infer<typeof investmentRiskPolicySchema>;
  constructor(
    readonly db: Store,
    policy: unknown = {},
  ) {
    this.policy = investmentRiskPolicySchema.parse(policy);
  }
  open(raw: unknown): Cycle {
    const s = cycleSchema.parse(raw);
    if (s.validUntil <= s.at) throw Error("cycle validity");
    const total = Object.values(s.exposures).reduce(
      (n, x) => n + BigInt(x),
      0n,
    );
    if (
      total + BigInt(s.stableValueMicros) !== BigInt(s.navMicros) ||
      BigInt(s.availableStableMicros) > BigInt(s.stableValueMicros)
    )
      throw Error("inconsistent portfolio valuation");
    const cycle = {
      ...s,
      id: hash(["investment-risk/1", s.chainId, s.agent, s.epoch]),
      policy: this.policy,
    };
    return this.db.transaction(() => {
      const prior = this.db.get<Cycle>("investment-risk-cycle", cycle.id);
      if (prior) {
        if (hash(prior) !== hash(cycle)) throw Error("cycle conflict");
        return prior;
      }
      // One wallet cannot reset its budget under another Agent identity in the same epoch.
      if (
        this.db
          .all<Cycle>("investment-risk-cycle")
          .some(
            (c) =>
              c.chainId === s.chainId &&
              c.epoch === s.epoch &&
              c.wallet === s.wallet,
          )
      )
        throw Error("wallet cycle conflict");
      this.db.insert("investment-risk-cycle", cycle.id, cycle);
      return cycle;
    });
  }
  reserve(
    cycleId: string,
    raw: unknown,
    now: number,
    workerEligible: boolean,
  ): Order {
    time.parse(now);
    const o = orderSchema.parse(raw),
      inputHash = hash(o),
      key = hash([cycleId, o.id]);
    return this.db.transaction(() => {
      const c = this.db.get<Cycle>("investment-risk-cycle", cycleId);
      if (!c) throw Error("cycle missing");
      const prior = this.db.get<Order>("investment-risk-order", key);
      if (prior) {
        if (prior.inputHash !== inputHash) throw Error("order conflict");
        return prior;
      }
      const p = c.policy;
      if (now < c.at || now >= c.validUntil) throw Error("cycle expired");
      if (
        o.quoteAt < c.at ||
        o.quoteAt > now ||
        now - o.quoteAt >= p.quoteMaxAgeMs
      )
        throw Error("quote expired");
      const amount = BigInt(o.notionalMicros),
        nav = BigInt(c.navMicros);
      if (amount === 0n || amount < BigInt(p.minTradeMicros))
        throw Error("trade below economic floor");
      if (BigInt(o.gasMicros) * 10000n > amount * BigInt(p.maxGasBps))
        throw Error("gas exceeds budget");
      if (
        o.slippageBps > p.maxSlippageBps ||
        o.priceImpactBps > p.maxPriceImpactBps
      )
        throw Error("quote exceeds execution limits");
      const orders = this.db
        .all<Order>("investment-risk-order")
        .filter((x) => x.cycleId === cycleId);
      const buys = orders.filter((x) => x.side === "BUY"),
        bought = buys.reduce((n, x) => n + BigInt(x.notionalMicros), 0n);
      if (o.side === "BUY") {
        if (!workerEligible) throw Error("eligible Worker required");
        const available = BigInt(c.availableStableMicros);
        if (amount * 10000n > available * BigInt(p.maxOrderBuyBps))
          throw Error("order buy limit");
        if (
          (bought + amount) * 10000n > available * BigInt(p.maxCycleBuyBps) ||
          bought + amount > available
        )
          throw Error("cycle buy limit");
        const volatile = Object.values(c.exposures).reduce(
          (n, x) => n + BigInt(x),
          0n,
        );
        const bucketBought = buys
          .filter((x) => x.bucket === o.bucket)
          .reduce((n, x) => n + BigInt(x.notionalMicros), 0n);
        if (
          (volatile + bought + amount) * 10000n >
            nav * BigInt(p.maxVolatileBps) ||
          (BigInt(c.exposures[o.bucket]) + bucketBought + amount) * 10000n >
            nav * BigInt(p.maxUnderlyingBps)
        )
          throw Error("exposure limit");
      } else {
        const sold = orders
          .filter((x) => x.side === "SELL" && x.bucket === o.bucket)
          .reduce((n, x) => n + BigInt(x.notionalMicros), 0n);
        if (sold + amount > BigInt(c.exposures[o.bucket]))
          throw Error("sale exceeds starting exposure");
      }
      const order = { ...o, cycleId, reservedAt: now, inputHash };
      this.db.insert("investment-risk-order", key, order);
      return order;
    });
  }
}
