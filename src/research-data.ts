import {
  Contract,
  JsonRpcProvider,
  FetchRequest,
  isAddress,
  parseUnits,
} from "ethers";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { networkFetch } from "./network.js";
import { readJson } from "./http.js";
import { researchTools, macroAnnouncements } from "./research-tools.js";
import { marketKlinesTool } from "./market-klines.js";
import { Store } from "./store.js";
import type { Config } from "./config.js";
import type { ResearchTool } from "./agent-runtime.js";
import {
  contextSchema,
  assertResearchAssets,
  portfolioSnapshot,
  marketMetrics,
  evidence,
  normalizeEvidence,
  promptSnapshot,
  compareContext,
  uint,
  type ResearchAsset,
  type ResearchContext,
} from "./research-context.js";
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(64);
function micros(v: unknown) {
  const s = decimal.parse(v);
  const [a, b = ""] = s.split(".");
  return String(parseUnits(a + "." + b.padEnd(6, "0").slice(0, 6), 6));
}
export function parseCandles(raw: unknown, now: number, maxAgeMs: number) {
  const rows = z.array(z.array(z.unknown()).min(7)).min(20).max(100).parse(raw);
  const candles = rows
    .map((r) => ({
      closeTime: z.number().int().parse(r[6]),
      closeMicros: micros(r[4]),
    }))
    .filter((c) => c.closeTime < now)
    .slice(-60);
  const metrics = marketMetrics(candles),
    last = candles.at(-1)!;
  if (now - last.closeTime > maxAgeMs) throw Error("market data stale");
  for (let i = 1; i < candles.length; i++)
    if (candles[i]!.closeTime - candles[i - 1]!.closeTime !== 60000)
      throw Error("market candles discontinuous");
  return {
    candles,
    metrics,
    asOf: last.closeTime,
    priceMicros: last.closeMicros,
  };
}
export function parseLiquidity(raw: unknown, address: string) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p) =>
        p?.chainId === "bsc" &&
        p.baseToken?.address?.toLowerCase() === address.toLowerCase() &&
        isAddress(p.pairAddress) &&
        typeof p.dexId === "string" &&
        Number.isFinite(p.liquidity?.usd) &&
        p.liquidity.usd >= 0,
    )
    .sort((a, b) => b.liquidity.usd - a.liquidity.usd)
    .slice(0, 3)
    .map((p) => ({
      pair: p.pairAddress,
      dex: p.dexId,
      liquidityUsd: Math.floor(p.liquidity.usd),
    }));
}
async function json(url: string, signal?: AbortSignal) {
  const response = await networkFetch(url, {
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("research data unavailable");
  }
  return readJson(response, 512000);
}
export class ResearchData {
  constructor(
    readonly db: Store,
    readonly config: Config["research"],
  ) {}
  async collect(
    previous: {
      epoch: string;
      hash: string;
      signals: unknown[];
      context: ResearchContext;
    } | null,
    signal?: AbortSignal,
  ): Promise<ResearchContext> {
    assertResearchAssets(this.config.chainId, this.config.assets);
    const c = this.config,
      at = Date.now();
    const proofs: ResearchContext["evidence"] = [],
      missing: string[] = [],
      markets: ResearchContext["markets"] = [],
      liquidity: ResearchContext["liquidity"] = [];
    const save = (
      kind: Parameters<typeof evidence>[0],
      url: string,
      asOf: number | null,
      data: unknown,
    ) => {
      const e = evidence(kind, url, asOf, data);
      this.db.put("research-evidence", e.id, {
        ...e,
        data: normalizeEvidence(data),
      });
      proofs.push(e);
      return e.id;
    };
    await Promise.all(
      c.assets.map(async (asset) => {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${asset.marketSymbol}&interval=1m&limit=61`;
        try {
          const raw = await json(url, signal),
            parsed = parseCandles(raw, Date.now(), c.maxAgeMs),
            id = save("market", url, parsed.asOf, raw);
          markets.push({
            ...asset,
            ...parsed.metrics,
            priceMicros: parsed.priceMicros,
            asOf: parsed.asOf,
            evidenceId: id,
          });
        } catch {
          missing.push(`${asset.symbol} market unavailable or stale`);
        }
        if (c.chainId !== 56) {
          missing.push(`${asset.symbol} DEX adapter supports BSC mainnet only`);
          return;
        }
        const dex = `https://api.dexscreener.com/token-pairs/v1/bsc/${asset.address}`;
        try {
          const raw = await json(dex, signal),
            pairs = parseLiquidity(raw, asset.address),
            id = save("dex", dex, null, raw);
          for (const p of pairs)
            liquidity.push({
              asset: asset.address,
              ...p,
              evidenceId: id,
              observedAt: Date.now(),
              sourceTimestamp: null,
            });
          if (!pairs.length)
            missing.push(`${asset.symbol} DEX liquidity unavailable`);
        } catch {
          missing.push(`${asset.symbol} DEX unavailable`);
        }
      }),
    );
    markets.sort((a, b) => a.symbol.localeCompare(b.symbol));
    liquidity.sort(
      (a, b) =>
        a.asset.localeCompare(b.asset) || b.liquidityUsd - a.liquidityUsd,
    );
    let known = false,
      blockNumber: number | null = null,
      blockHash: string | null = null,
      nativeBalanceWei: string | null = null;
    let rows: (ResearchAsset & {
      quantity: string;
      priceMicros: string | null;
      costMicros: string | null;
    })[] = [];
    const native: ResearchAsset = {
      symbol: "BNB",
      address: "0x0000000000000000000000000000000000000000",
      decimals: 18,
      marketSymbol: "BNBUSDT",
    };
    if (c.rpcUrl && isAddress(c.portfolioWallet)) {
      const request = new FetchRequest(c.rpcUrl);
      request.timeout = 15000;
      const provider = new JsonRpcProvider(request, undefined, {
        cacheTimeout: -1,
      });
      try {
        if ((await provider.getNetwork()).chainId !== BigInt(c.chainId))
          throw Error("wrong portfolio chain");
        const block = await provider.getBlock("latest");
        if (
          !block?.hash ||
          Date.now() / 1000 - block.timestamp > 120 ||
          block.timestamp > Date.now() / 1000 + 30
        )
          throw Error("stale portfolio block");
        blockNumber = block.number;
        blockHash = block.hash;
        const balances = await Promise.all(
          c.assets.map(async (asset) => {
            const token = new Contract(
              asset.address,
              [
                "function balanceOf(address) view returns(uint256)",
                "function decimals() view returns(uint8)",
              ],
              provider,
            );
            const [qty, decimals] = await Promise.all([
              token.balanceOf!(c.portfolioWallet, { blockTag: block.number }),
              token.decimals!({ blockTag: block.number }),
            ]);
            if (Number(decimals) !== asset.decimals)
              throw Error("asset decimals mismatch");
            return {
              ...asset,
              quantity: String(qty),
              priceMicros:
                markets.find(
                  (m) =>
                    m.address.toLowerCase() === asset.address.toLowerCase(),
                )?.priceMicros ?? null,
              costMicros: null,
            };
          }),
        );
        nativeBalanceWei = String(
          await provider.getBalance(c.portfolioWallet, block.number),
        );
        const spendable =
          BigInt(nativeBalanceWei) > BigInt(c.gasReserveWei)
            ? BigInt(nativeBalanceWei) - BigInt(c.gasReserveWei)
            : 0n;
        const check = await provider.getBlock(block.number);
        if (check?.hash !== block.hash) throw Error("portfolio reorg");
        rows = [
          ...balances,
          {
            ...native,
            quantity: String(spendable),
            priceMicros:
              markets.find((m) => m.marketSymbol === "BNBUSDT")?.priceMicros ??
              null,
            costMicros: null,
          },
        ];
        known = true;
        save(
          "portfolio",
          `chain://${c.chainId}/${c.portfolioWallet}`,
          block.timestamp * 1000,
          {
            wallet: c.portfolioWallet,
            chainId: c.chainId,
            blockNumber,
            blockHash,
            nativeBalanceWei,
            gasReserveWei: c.gasReserveWei,
            balances: rows,
          },
        );
      } catch {
        missing.push("Portfolio chain read failed; balances unknown");
        rows = [];
        nativeBalanceWei = null;
        blockNumber = null;
        blockHash = null;
      } finally {
        provider.destroy();
      }
    } else
      missing.push(
        "Portfolio wallet/RPC not configured; not evidence of an empty portfolio",
      );
    let realizedPnlMicros: string | null = null;
    if (c.accountingFile && known) {
      try {
        const book = z
          .object({
            wallet: z.string(),
            chainId: z.number(),
            blockHash: z.string(),
            quoteCurrency: z.literal("USDT"),
            realizedPnlMicros: z
              .string()
              .regex(/^-?\d+$/)
              .max(96)
              .nullable(),
            positions: z
              .array(
                z.object({
                  asset: z.string(),
                  quantity: uint,
                  costMicros: uint,
                }),
              )
              .max(32),
          })
          .strict()
          .parse(JSON.parse(readFileSync(c.accountingFile, "utf8")));
        if (
          book.wallet.toLowerCase() !== c.portfolioWallet.toLowerCase() ||
          book.chainId !== c.chainId ||
          book.blockHash !== blockHash ||
          new Set(book.positions.map((p) => p.asset.toLowerCase())).size !==
            book.positions.length
        )
          throw Error("accounting snapshot mismatch");
        for (const p of book.positions) {
          const row = rows.find(
            (r) => r.address.toLowerCase() === p.asset.toLowerCase(),
          );
          if (
            !row ||
            row.quantity !== p.quantity ||
            (p.quantity === "0" && p.costMicros !== "0")
          )
            throw Error("accounting balance mismatch");
        }
        rows = rows.map((r) => ({
          ...r,
          costMicros:
            book.positions.find(
              (p) => p.asset.toLowerCase() === r.address.toLowerCase(),
            )?.costMicros ?? null,
        }));
        realizedPnlMicros = book.realizedPnlMicros;
        save("accounting", "accounting://portfolio", null, book);
      } catch {
        missing.push(
          "Accounting snapshot unavailable or mismatched; costs and realized PnL unknown",
        );
      }
    }
    const portfolio = portfolioSnapshot(rows, known);
    portfolio.realizedPnlMicros = realizedPnlMicros;
    const news: ResearchContext["news"] = [];
    try {
      const tool = researchTools().find((t) => t.name === "news_search")!;
      const result = (await tool.run({ query: c.newsQuery }, signal)) as any;
      for (const item of result.data ?? []) {
        const publishedAt =
          Number.isSafeInteger(item.publishedAt) &&
          item.publishedAt <= Date.now()
            ? item.publishedAt
            : null;
        const id = save("news", item.url, publishedAt, {
          title: item.title,
          publishedAt,
        });
        news.push({
          title: item.title,
          url: item.url,
          publishedAt,
          evidenceId: id,
        });
      }
      if (!news.length) missing.push("News index unavailable");
    } catch {
      missing.push("News index unavailable");
    }
    try {
      const announcements = await macroAnnouncements(signal);
      for (const item of announcements) {
        const publishedAt =
          Number.isSafeInteger(item.publishedAt) &&
          item.publishedAt! <= Date.now()
            ? item.publishedAt!
            : null;
        const id = save("news", item.url, publishedAt, {
          title: item.title,
          publishedAt,
          publisher: "Federal Reserve official monetary-policy feed",
        });
        news.push({
          title: `Federal Reserve: ${item.title}`,
          url: item.url,
          publishedAt,
          evidenceId: id,
        });
      }
      if (!announcements.length)
        missing.push("Official macro announcement feed unavailable");
    } catch {
      missing.push("Official macro announcement feed unavailable");
    }
    missing.push(
      "News headlines are index metadata, not independently verified articles",
      "Social feeds, macro time series and historical onchain flows may require additional evidence",
      "Wrapped assets have issuer/bridge and depeg risks; CEX reference prices are not DEX execution prices",
    );
    if (signal?.aborted) throw signal.reason;
    const partial = {
      portfolio,
      markets,
      chainId: c.chainId,
      universe: c.assets,
      portfolioIdentity: {
        wallet: c.portfolioWallet,
        scope: "CONFIGURED_ASSETS_AND_NATIVE",
      },
    };
    return contextSchema.parse({
      version: "research-context/1",
      at,
      chainId: c.chainId,
      universe: c.assets,
      portfolio,
      portfolioIdentity: {
        wallet: c.portfolioWallet,
        scope: "CONFIGURED_ASSETS_AND_NATIVE",
        blockNumber,
        blockHash,
        nativeBalanceWei,
        gasReserveWei: c.gasReserveWei,
        stakeExcluded: true,
      },
      markets,
      liquidity,
      news,
      evidence: proofs.sort((a, b) => a.id.localeCompare(b.id)),
      missing,
      previous: previous
        ? {
            epoch: previous.epoch,
            hash: previous.hash,
            signals: previous.signals,
          }
        : null,
      changes: compareContext(previous?.context, partial),
      policy: {
        dataMaxAgeMs: c.maxAgeMs,
        maxAssetBps: c.maxAssetBps,
        maxTotalBps: c.maxTotalBps,
        validForMs: c.validForMs,
        minLiquidityUsd: c.minLiquidityUsd,
        maxSlippageBps: c.maxSlippageBps,
      },
    });
  }
}
export function contextTools(
  context: ResearchContext,
  role: string,
): ResearchTool[] {
  const sections =
    role === "positions"
      ? ["portfolio", "changes"]
      : role === "market"
        ? ["markets", "changes"]
        : role === "onchain"
          ? ["liquidity", "portfolioIdentity"]
          : role === "news"
            ? ["news"]
            : role === "macro"
              ? ["markets", "news", "changes"]
              : ["portfolio", "markets", "liquidity", "policy", "changes"];
  return [
    {
      name: "research_snapshot",
      description:
        "Inspect immutable verified research snapshot and deterministic metrics for your role. It cannot execute orders.",
      schema: z.object({}),
      run: async () => ({
        data: Object.fromEntries(
          ["facts", ...sections].map((s) => [
            s,
            (promptSnapshot(context) as any)[s],
          ]),
        ),
        evidence: context.evidence,
        missing: context.missing,
      }),
    },
    ...researchTools(),
    ...(role === "market" ? [marketKlinesTool()] : []),
  ];
}
