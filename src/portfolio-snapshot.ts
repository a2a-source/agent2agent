import {
  observationBoundarySchema,
  type ObservationBoundary,
} from "./performance-ledger.js";
import { z } from "zod";
import { Contract, isAddress, JsonRpcApiProvider, ZeroAddress } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(96);
const integer = z.number().int().nonnegative().safe();
const address = z
  .string()
  .refine(isAddress)
  .transform((x) => x.toLowerCase())
  .refine((x) => x !== ZeroAddress);
const assetId = z.union([z.literal("native"), address]);
const assetSchema = z
  .object({
    asset: assetId,
    bucket: z.enum(["BTC", "ETH", "BNB", "STABLE"]),
    decimals: integer.max(36),
    feed: address,
    description: z.string().min(1).max(80),
  })
  .strict();
export const portfolioRegistrySchema = z
  .object({
    chainId: integer.positive(),
    confirmations: integer.positive(),
    maxBlockAgeMs: integer.positive(),
    maxPriceAgeMs: integer.positive(),
    assets: z.array(assetSchema).min(4).max(24),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      new Set(c.assets.map((a) => a.asset)).size !== c.assets.length ||
      !["BTC", "ETH", "BNB", "STABLE"].every((b) =>
        c.assets.some((a) => a.bucket === b),
      ) ||
      !c.assets.some(
        (a) => a.asset === "native" && a.bucket === "BNB" && a.decimals === 18,
      ) ||
      c.assets.some(
        (a) =>
          a.asset === "native" && (a.bucket !== "BNB" || a.decimals !== 18),
      )
    )
      ctx.addIssue({ code: "custom", message: "invalid portfolio registry" });
  });
const requestSchema = z
  .object({
    id: z.string().min(1).max(128),
    agent: z.string().min(1).max(128),
    wallet: address,
    gasReserveWei: uint,
    reservationSource: z.string().min(1).max(128),
    reserved: z.record(assetId, uint),
  })
  .strict();
const observationSchema = z
  .object({
    balance: uint,
    decimals: integer.max(36),
    price: z
      .object({
        answer: uint,
        decimals: integer.max(36),
        description: z.string().max(80),
        roundId: uint,
        answeredInRound: uint,
        updatedAt: integer.positive(),
      })
      .strict(),
  })
  .strict();
type Asset = z.infer<typeof assetSchema>;
export interface PortfolioReader {
  chainId(): Promise<number>;
  tip(): Promise<number>;
  block(
    number: number,
  ): Promise<{ number: number; hash: string; timestamp: number }>;
  read(
    asset: Asset,
    wallet: string,
    block: number,
  ): Promise<z.infer<typeof observationSchema>>;
}
export class EthersPortfolioReader implements PortfolioReader {
  constructor(readonly provider: JsonRpcApiProvider) {}
  async chainId() {
    return Number((await this.provider.getNetwork()).chainId);
  }
  tip() {
    return this.provider.getBlockNumber();
  }
  async block(number: number) {
    // A second getBlock() can return ethers' short-lived cached first result.
    // Raw JSON-RPC is required for an independent canonical hash check.
    const b = await this.provider.send("eth_getBlockByNumber", [
      "0x" + number.toString(16),
      false,
    ]);
    if (!b?.hash) throw Error("portfolio block unavailable");
    return {
      number: Number(BigInt(b.number)),
      hash: b.hash,
      timestamp: Number(BigInt(b.timestamp)),
    };
  }
  async read(asset: Asset, wallet: string, block: number) {
    const opts = { blockTag: block };
    const feed = new Contract(
      asset.feed,
      [
        "function decimals() view returns(uint8)",
        "function description() view returns(string)",
        "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
      ],
      this.provider,
    );
    const token =
      asset.asset === "native"
        ? null
        : new Contract(
            asset.asset,
            [
              "function decimals() view returns(uint8)",
              "function balanceOf(address) view returns(uint256)",
            ],
            this.provider,
          );
    const [balance, decimals, fd, description, round] = await Promise.all([
      token
        ? token.balanceOf!(wallet, opts)
        : this.provider.getBalance(wallet, block),
      token ? token.decimals!(opts) : Promise.resolve(18),
      feed.decimals!(opts),
      feed.description!(opts),
      feed.latestRoundData!(opts),
    ]);
    return {
      balance: String(balance),
      decimals: Number(decimals),
      price: {
        answer: String(round[1]),
        decimals: Number(fd),
        description,
        roundId: String(round[0]),
        answeredInRound: String(round[4]),
        updatedAt: Number(round[3]),
      },
    };
  }
}
export interface PortfolioSnapshot {
  id: string;
  requestId: string;
  agent: string;
  wallet: string;
  chainId: number;
  version: "tracked-portfolio/1";
  observedAt: number;
  validUntil: number;
  blockNumber: number;
  blockHash: string;
  registryHash: string;
  reservationSource: string;
  navMicros: string;
  stableValueMicros: string;
  availableStableMicros: string;
  exposures: Record<"BTC" | "ETH" | "BNB", string>;
  availableExposures: Record<"BTC" | "ETH" | "BNB", string>;
  holdings: {
    asset: string;
    bucket: Asset["bucket"];
    balance: string;
    reserved: string;
    gasExcluded: string;
    valueMicros: string;
    availableMicros: string;
    priceMicros: string;
  }[];
}
export class PortfolioCollector {
  readonly registry: z.infer<typeof portfolioRegistrySchema>;
  constructor(
    readonly db: Store,
    readonly reader: PortfolioReader,
    registry: unknown,
    readonly clock = Date.now,
  ) {
    this.registry = portfolioRegistrySchema.parse(registry);
  }
  async collect(raw: unknown): Promise<PortfolioSnapshot> {
    return this.collectWithPolicy(raw);
  }
  async collectAt(
    raw: unknown,
    boundary: ObservationBoundary,
  ): Promise<PortfolioSnapshot> {
    return this.collectWithPolicy(
      raw,
      observationBoundarySchema.parse(boundary),
    );
  }
  private async collectWithPolicy(
    raw: unknown,
    boundary?: ObservationBoundary,
  ): Promise<PortfolioSnapshot> {
    const request = requestSchema.parse(raw),
      c = this.registry;
    if (
      Object.keys(request.reserved).length !== c.assets.length ||
      c.assets.some((a) => request.reserved[a.asset] === undefined)
    )
      throw Error("complete reservation snapshot required");
    const key = hash([c.chainId, request.id]),
      fingerprint = boundary
        ? hash({ request, registry: c, mode: "round-observation", boundary })
        : hash({ request, registry: c });
    if (
      boundary &&
      (request.gasReserveWei !== "0" ||
        request.reservationSource !== "round-observation" ||
        Object.values(request.reserved).some((v) => v !== "0"))
    )
      throw Error("accounting requires full unreserved NAV");
    const prior = this.db.get<any>("portfolio-capture", key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw Error("portfolio capture conflict");
      if (prior.status !== "DONE")
        throw Error("portfolio capture incomplete; use a new capture identity");
      const saved = this.db.get<PortfolioSnapshot>(
        "portfolio-snapshot",
        prior.snapshotId,
      );
      if (!saved) throw Error("portfolio snapshot missing");
      return saved;
    }
    const startedAt = integer.parse(this.clock());
    const capture = {
      request,
      registry: c,
      fingerprint,
      startedAt,
      status: "READING",
      ...(boundary ? { mode: "round-observation", boundary } : {}),
    };
    this.db.insert("portfolio-capture", key, capture);
    try {
      if ((await this.reader.chainId()) !== c.chainId)
        throw Error("chain mismatch");
      const tip = integer.parse(await this.reader.tip());
      if (tip < c.confirmations) throw Error("insufficient confirmations");
      const target = boundary?.blockNumber ?? tip - c.confirmations;
      if (target > tip - c.confirmations)
        throw Error("insufficient boundary confirmations");
      const block = await this.reader.block(target);
      if (
        block.number !== target ||
        (boundary &&
          (block.hash.toLowerCase() !== boundary.blockHash.toLowerCase() ||
            block.timestamp * 1000 !== boundary.blockTimeMs)) ||
        !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
        !Number.isSafeInteger(block.timestamp) ||
        block.timestamp <= 0 ||
        block.timestamp * 1000 > startedAt ||
        (!boundary && startedAt - block.timestamp * 1000 >= c.maxBlockAgeMs)
      )
        throw Error("invalid or stale block");
      let validUntil = block.timestamp * 1000 + c.maxBlockAgeMs;
      const holdings: PortfolioSnapshot["holdings"] = [];
      // All evidence is read and stored against the same numeric block; a final
      // hash check rejects observed reorgs. This is not a cryptographic finality proof.
      for (const asset of c.assets) {
        const observationId = hash([key, asset.asset]);
        const observation = {
          captureId: key,
          asset,
          block,
        };
        this.db.insert("portfolio-observation", observationId, {
          ...observation,
          status: "READING",
        });
        let rawObservation;
        try {
          rawObservation = await this.reader.read(
            asset,
            request.wallet,
            block.number,
          );
        } catch {
          this.db.put("portfolio-observation", observationId, {
            ...observation,
            status: "FAILED",
            reason: "RPC_READ_FAILED",
          });
          throw Error("portfolio asset read failed");
        }
        this.db.put("portfolio-observation", observationId, {
          ...observation,
          status: "RETURNED",
          data: rawObservation,
        });
        const o = observationSchema.parse(rawObservation),
          p = o.price;
        if (
          o.decimals !== asset.decimals ||
          p.description !== asset.description ||
          BigInt(p.answer) <= 0n ||
          BigInt(p.roundId) <= 0n ||
          BigInt(p.answeredInRound) < BigInt(p.roundId) ||
          p.updatedAt > block.timestamp ||
          (boundary ? block.timestamp * 1000 : startedAt) -
            p.updatedAt * 1000 >=
            c.maxPriceAgeMs
        )
          throw Error("invalid or stale asset oracle");
        validUntil = Math.min(validUntil, p.updatedAt * 1000 + c.maxPriceAgeMs);
        const balance = BigInt(o.balance),
          reserved = BigInt(request.reserved[asset.asset]!),
          gas = asset.asset === "native" ? BigInt(request.gasReserveWei) : 0n;
        if (gas + reserved > balance)
          throw Error("reserved balance unavailable");
        const price = (BigInt(p.answer) * 1000000n) / 10n ** BigInt(p.decimals);
        if (price <= 0n) throw Error("price below precision");
        const value = ((balance - gas) * price) / 10n ** BigInt(asset.decimals),
          available =
            ((balance - gas - reserved) * price) /
            10n ** BigInt(asset.decimals);
        holdings.push({
          asset: asset.asset,
          bucket: asset.bucket,
          balance: o.balance,
          reserved: reserved.toString(),
          gasExcluded: gas.toString(),
          valueMicros: value.toString(),
          availableMicros: available.toString(),
          priceMicros: price.toString(),
        });
      }
      const check = await this.reader.block(block.number),
        observedAt = integer.parse(this.clock());
      if (
        check.hash !== block.hash ||
        check.number !== block.number ||
        check.timestamp !== block.timestamp ||
        observedAt < startedAt ||
        (!boundary && observedAt >= validUntil)
      )
        throw Error("reorg or expired observation");
      const sum = (bucket: string, field: "valueMicros" | "availableMicros") =>
        holdings
          .filter((h) => h.bucket === bucket)
          .reduce((n, h) => n + BigInt(h[field]), 0n)
          .toString();
      const body = {
        version: "tracked-portfolio/1" as const,
        requestId: key,
        agent: request.agent,
        wallet: request.wallet,
        chainId: c.chainId,
        observedAt,
        validUntil,
        blockNumber: block.number,
        blockHash: block.hash,
        registryHash: hash(c),
        reservationSource: request.reservationSource,
        navMicros: holdings
          .reduce((n, h) => n + BigInt(h.valueMicros), 0n)
          .toString(),
        stableValueMicros: sum("STABLE", "valueMicros"),
        availableStableMicros: sum("STABLE", "availableMicros"),
        exposures: {
          BTC: sum("BTC", "valueMicros"),
          ETH: sum("ETH", "valueMicros"),
          BNB: sum("BNB", "valueMicros"),
        },
        availableExposures: {
          BTC: sum("BTC", "availableMicros"),
          ETH: sum("ETH", "availableMicros"),
          BNB: sum("BNB", "availableMicros"),
        },
        holdings,
      };
      const snapshot = { ...body, id: hash(body) };
      this.db.transaction(() => {
        this.db.insert("portfolio-snapshot", snapshot.id, snapshot);
        this.db.put("portfolio-capture", key, {
          ...capture,
          status: "DONE",
          snapshotId: snapshot.id,
          finishedAt: observedAt,
        });
      });
      return snapshot;
    } catch {
      this.db.put("portfolio-capture", key, {
        ...capture,
        status: "FAILED",
        reason: "CAPTURE_FAILED",
        finishedAt: this.clock(),
      });
      throw Error(
        "portfolio capture failed: verify chain, feed, balance and freshness",
      );
    }
  }
}
