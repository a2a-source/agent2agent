import { z } from "zod";
import { isAddress, ZeroAddress } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import type { PortfolioSnapshot } from "./portfolio-snapshot.js";

const ref = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const uint = z
  .string()
  .max(96)
  .regex(/^(0|[1-9][0-9]*)$/);
const signed = z
  .string()
  .max(97)
  .regex(/^(0|-?[1-9][0-9]*)$/);
const address = z
  .string()
  .refine(isAddress)
  .transform((x) => x.toLowerCase())
  .refine((x) => x !== ZeroAddress);
const number = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const executionFeedbackSummarySchema = z
  .object({
    version: z.literal("execution-feedback-context/1"),
    currency: z.literal("micro-USD"),
    roundId: ref,
    chainId: number.positive(),
    omittedWalletCount: number.max(1000),
    network: z
      .object({
        observationId: digest,
        status: z.enum(["KNOWN", "UNKNOWN"]),
        periodPnlMicros: signed.nullable(),
        missingWallets: z.array(address).max(1000),
      })
      .strict()
      .superRefine((r, ctx) => {
        if (
          (r.status === "UNKNOWN") !== (r.periodPnlMicros === null) ||
          (r.status === "KNOWN" && r.missingWallets.length > 0)
        )
          ctx.addIssue({
            code: "custom",
            message: "inconsistent network accounting status",
          });
      })
      .nullable(),
    wallets: z
      .array(
        z
          .object({
            observationId: digest,
            wallet: address,
            agentId: ref,
            jobId: ref,
            planId: ref,
            openingSnapshotId: ref.nullable(),
            closingSnapshotId: ref.nullable(),
            fillIds: z.array(ref).max(32),
            omittedFillCount: number.max(1000),
            status: z.enum(["KNOWN", "UNKNOWN"]),
            navDeltaMicros: signed.nullable(),
            periodPnlMicros: signed.nullable(),
            missingReasons: z.array(ref).max(16),
            openingNavMicros: uint.nullable().optional(),
            closingNavMicros: uint.nullable().optional(),
            closingPortfolio: z
              .object({
                snapshotId: ref,
                blockNumber: number,
                observedAt: number,
                holdings: z
                  .array(
                    z
                      .object({
                        asset: z.union([z.literal("native"), address]),
                        bucket: z.enum(["BTC", "ETH", "BNB", "STABLE"]),
                        balance: uint,
                        valueMicros: uint,
                        priceMicros: uint,
                      })
                      .strict(),
                  )
                  .max(24),
              })
              .strict()
              .nullable()
              .optional(),
          })
          .strict()
          .superRefine((r, ctx) => {
            if (
              (r.status === "UNKNOWN") !== (r.periodPnlMicros === null) ||
              (r.status === "KNOWN" &&
                (r.missingReasons.length > 0 || r.navDeltaMicros === null))
            )
              ctx.addIssue({
                code: "custom",
                message: "inconsistent wallet accounting status",
              });
          }),
      )
      .max(32),
  })
  .strict();
const inputSchema = z
  .object({
    roundId: ref,
    chainId: number.positive(),
    agentId: ref,
    wallet: address,
    jobId: ref,
    planId: ref,
    openingSnapshotId: ref.nullable(),
    closingSnapshotId: ref.nullable(),
    fillIds: z.array(ref).max(1000),
    cashflow: z
      .object({
        complete: z.boolean(),
        netExternalFlowMicros: signed.nullable(),
        hasExternalFlows: z.boolean().nullable(),
        provenance: z.array(ref).min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();
const fillSchema = z
  .object({
    id: ref,
    version: z.enum(["dex-v2-fill/1", "dex-v2-fill/2", "dex-v2-fill/3"]),
    quoteId: ref,
    transactionId: ref,
    chainId: number.positive(),
    wallet: address,
    inputAsset: z.union([address, z.literal("native")]),
    outputAsset: address,
    amountIn: uint,
    amountOut: uint,
    gasWei: uint,
    hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    block: number,
    blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict()
  .superRefine((fill, context) => {
    if ((fill.version === "dex-v2-fill/3") !== (fill.inputAsset === "native"))
      context.addIssue({
        code: "custom",
        message: "native fill version required",
      });
  });

export type ExecutionFeedbackInput = z.input<typeof inputSchema>;
type Input = z.output<typeof inputSchema>;
export interface WalletExecutionObservation extends Omit<Input, "cashflow"> {
  id: string;
  version: "execution-feedback-wallet/1";
  currency: "micro-USD";
  cashflow: Input["cashflow"] | null;
  status: "KNOWN" | "UNKNOWN";
  missingReasons: string[];
  openingNavMicros: string | null;
  closingNavMicros: string | null;
  navDeltaMicros: string | null;
  periodPnlMicros: string | null;
  periodReturn: { numerator: string; denominator: string } | null;
  fills: z.output<typeof fillSchema>[];
}
export interface NetworkExecutionObservation {
  id: string;
  version: "execution-feedback-network/1";
  currency: "micro-USD";
  roundId: string;
  chainId: number;
  expectedWallets: string[];
  memberObservationIds: string[];
  status: "KNOWN" | "UNKNOWN";
  periodPnlMicros: string | null;
  knownPeriodPnlMicros: string;
  missingWallets: string[];
}
function unique(xs: string[]) {
  if (new Set(xs).size !== xs.length)
    throw Error("duplicate feedback reference");
}
function verify<T extends { id: string }>(row: T | undefined): T {
  if (!row) throw Error("feedback reference missing");
  const { id, ...body } = row;
  if (hash(body) !== id) throw Error("feedback integrity failure");
  return row;
}
function save<T extends { id: string }>(
  db: Store,
  kind: string,
  key: string,
  row: T,
): T {
  const previous = db.get<T>(kind, key);
  if (previous) {
    verify(previous);
    if (previous.id !== row.id) throw Error("execution feedback conflict");
    return previous;
  }
  db.insert(kind, key, row);
  return row;
}
/** Trusted local accounting boundary, not a chain verifier or a cost-basis ledger. */
export class ExecutionFeedback {
  constructor(readonly db: Store) {}
  recordWallet(raw: unknown): WalletExecutionObservation {
    const input = inputSchema.parse(raw);
    unique(input.fillIds);
    input.fillIds.sort();
    if (
      input.cashflow?.hasExternalFlows === false &&
      input.cashflow.netExternalFlowMicros !== "0"
    )
      throw Error("contradictory cashflow evidence");
    const reasons: string[] = [];
    const snapshot = (id: string | null, side: string) => {
      if (id === null) {
        reasons.push(`${side}_SNAPSHOT_MISSING`);
        return null;
      }
      const row = this.db.get<PortfolioSnapshot>("portfolio-snapshot", id);
      if (!row) {
        reasons.push(`${side}_SNAPSHOT_MISSING`);
        return null;
      }
      verify(row);
      if (
        row.id !== id ||
        row.version !== "tracked-portfolio/1" ||
        row.chainId !== input.chainId ||
        row.wallet !== input.wallet ||
        row.agent !== input.agentId
      )
        throw Error("snapshot identity mismatch");
      const capture = this.db.get<{ status: string; snapshotId: string }>(
        "portfolio-capture",
        row.requestId,
      );
      if (capture?.status !== "DONE" || capture.snapshotId !== id) {
        reasons.push(`${side}_CAPTURE_INCOMPLETE`);
        return null;
      }
      uint.parse(row.navMicros);
      number.parse(row.blockNumber);
      number.parse(row.observedAt);
      // Collector NAV excludes reserved native gas. Restore that reserve so reserve
      // policy changes cannot masquerade as PnL. Native BNB decimals are fixed at 18.
      let reserve = 0n;
      for (const h of row.holdings) {
        uint.parse(h.gasExcluded);
        uint.parse(h.priceMicros);
        if (h.gasExcluded !== "0") {
          if (h.asset !== "native") throw Error("unsupported gas reserve");
          uint.parse(h.balance);
          const balance = BigInt(h.balance),
            excluded = BigInt(h.gasExcluded),
            price = BigInt(h.priceMicros);
          if (excluded > balance) throw Error("invalid gas reserve");
          reserve +=
            (balance * price) / 10n ** 18n -
            ((balance - excluded) * price) / 10n ** 18n;
        }
      }
      return { row, nav: (BigInt(row.navMicros) + reserve).toString() };
    };
    const opening = snapshot(input.openingSnapshotId, "OPENING"),
      closing = snapshot(input.closingSnapshotId, "CLOSING");
    if (
      opening &&
      closing &&
      (closing.row.blockNumber <= opening.row.blockNumber ||
        closing.row.observedAt <= opening.row.observedAt ||
        closing.row.registryHash !== opening.row.registryHash)
    )
      throw Error("snapshot interval or registry mismatch");
    const fills = input.fillIds.map((id) => {
      const fill = fillSchema.parse(this.db.get("dex-v2-fill", id));
      if (
        fill.id !== id ||
        id !==
          hash(
            fill.version === "dex-v2-fill/2" || fill.version === "dex-v2-fill/3"
              ? [fill.version, fill.chainId, fill.hash, fill.blockHash]
              : [fill.version, fill.chainId, fill.hash],
          ) ||
        fill.chainId !== input.chainId ||
        fill.wallet !== input.wallet
      )
        throw Error("fill identity mismatch");
      if (
        (opening && fill.block <= opening.row.blockNumber) ||
        (closing && fill.block > closing.row.blockNumber)
      )
        throw Error("fill outside snapshot interval");
      return fill;
    });
    const flow = input.cashflow;
    if (!flow?.complete) reasons.push("CASHFLOW_INCOMPLETE");
    if (flow?.netExternalFlowMicros == null)
      reasons.push("NET_EXTERNAL_FLOW_UNKNOWN");
    const delta =
      opening && closing ? BigInt(closing.nav) - BigInt(opening.nav) : null;
    const pnl =
      delta !== null && reasons.length === 0
        ? delta - BigInt(flow!.netExternalFlowMicros!)
        : null;
    const body = {
      ...input,
      cashflow: flow ?? null,
      version: "execution-feedback-wallet/1" as const,
      currency: "micro-USD" as const,
      status: pnl === null ? ("UNKNOWN" as const) : ("KNOWN" as const),
      missingReasons: reasons,
      openingNavMicros: opening?.nav ?? null,
      closingNavMicros: closing?.nav ?? null,
      navDeltaMicros: delta?.toString() ?? null,
      periodPnlMicros: pnl?.toString() ?? null,
      periodReturn:
        pnl !== null &&
        flow?.hasExternalFlows === false &&
        flow.netExternalFlowMicros === "0" &&
        BigInt(opening!.nav) > 0n
          ? { numerator: pnl.toString(), denominator: opening!.nav }
          : null,
      fills,
    };
    const row = { ...body, id: hash(body) };
    return this.db.transaction(() =>
      save(
        this.db,
        "execution-feedback-wallet",
        hash([input.chainId, input.roundId, input.wallet]),
        row,
      ),
    );
  }
  recordNetwork(raw: unknown): NetworkExecutionObservation {
    const input = z
      .object({
        roundId: ref,
        chainId: number.positive(),
        memberObservationIds: z.array(ref).max(1000),
        expectedWallets: z.array(address).min(1).max(1000),
      })
      .strict()
      .parse(raw);
    unique(input.memberObservationIds);
    unique(input.expectedWallets);
    input.memberObservationIds.sort();
    input.expectedWallets.sort();
    const rows = this.db.all<WalletExecutionObservation>(
      "execution-feedback-wallet",
    );
    const members = input.memberObservationIds.map((id) =>
      verify(rows.find((r) => r.id === id)),
    );
    unique(members.map((r) => r.wallet));
    for (const m of members)
      if (
        m.roundId !== input.roundId ||
        m.chainId !== input.chainId ||
        m.currency !== "micro-USD" ||
        !input.expectedWallets.includes(m.wallet)
      )
        throw Error("network observation member mismatch");
    const missingWallets = input.expectedWallets.filter(
      (w) => !members.some((m) => m.wallet === w && m.status === "KNOWN"),
    );
    const knownPeriodPnlMicros = members
      .reduce((s, m) => s + BigInt(m.periodPnlMicros ?? "0"), 0n)
      .toString();
    const body = {
      ...input,
      version: "execution-feedback-network/1" as const,
      currency: "micro-USD" as const,
      status: missingWallets.length ? ("UNKNOWN" as const) : ("KNOWN" as const),
      periodPnlMicros: missingWallets.length ? null : knownPeriodPnlMicros,
      knownPeriodPnlMicros,
      missingWallets,
    };
    return this.db.transaction(() =>
      save(
        this.db,
        "execution-feedback-network",
        hash([input.chainId, input.roundId]),
        { ...body, id: hash(body) },
      ),
    );
  }
}
/** Compact data-only context. Callers must keep it outside model-authored instructions. */
export function buildExecutionFeedbackSummary(
  db: Store,
  raw: { roundId: string; chainId: number },
) {
  const input = z
    .object({ roundId: ref, chainId: number.positive() })
    .strict()
    .parse(raw);
  const wallets = db
    .all<WalletExecutionObservation>("execution-feedback-wallet")
    .filter((r) => r.roundId === input.roundId && r.chainId === input.chainId)
    .map(verify)
    .sort((a, b) => a.wallet.localeCompare(b.wallet));
  if (wallets.length > 1000) throw Error("feedback context too large");
  const network = db.get<NetworkExecutionObservation>(
    "execution-feedback-network",
    hash([input.chainId, input.roundId]),
  );
  if (network) verify(network);
  return executionFeedbackSummarySchema.parse({
    version: "execution-feedback-context/1" as const,
    currency: "micro-USD" as const,
    ...input,
    network: network
      ? {
          observationId: network.id,
          status: network.status,
          periodPnlMicros: network.periodPnlMicros,
          missingWallets: network.missingWallets,
        }
      : null,
    omittedWalletCount: Math.max(0, wallets.length - 32),
    wallets: wallets.slice(0, 32).map((r) => ({
      observationId: r.id,
      wallet: r.wallet,
      agentId: r.agentId,
      jobId: r.jobId,
      planId: r.planId,
      openingSnapshotId: r.openingSnapshotId,
      closingSnapshotId: r.closingSnapshotId,
      fillIds: r.fillIds.slice(0, 32),
      omittedFillCount: Math.max(0, r.fillIds.length - 32),
      status: r.status,
      navDeltaMicros: r.navDeltaMicros,
      periodPnlMicros: r.periodPnlMicros,
      missingReasons: r.missingReasons,
      openingNavMicros: r.openingNavMicros,
      closingNavMicros: r.closingNavMicros,
      closingPortfolio: (() => {
        if (!r.closingSnapshotId) return null;
        const snapshot = db.get<PortfolioSnapshot>(
          "portfolio-snapshot",
          r.closingSnapshotId,
        );
        if (!snapshot) return null;
        verify(snapshot);
        if (snapshot.wallet !== r.wallet || snapshot.chainId !== r.chainId)
          throw Error("feedback snapshot mismatch");
        return {
          snapshotId: snapshot.id,
          blockNumber: snapshot.blockNumber,
          observedAt: snapshot.observedAt,
          holdings: snapshot.holdings.map(
            ({ asset, bucket, balance, valueMicros, priceMicros }) => ({
              asset,
              bucket,
              balance,
              valueMicros,
              priceMicros,
            }),
          ),
        };
      })(),
    })),
  });
}
