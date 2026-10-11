import { z } from "zod";
import { isAddress } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import {
  PerformanceLedger,
  observationBoundarySchema,
} from "./performance-ledger.js";
import {
  observationProjection,
  readObservationSnapshot,
  roundObservationInputSchema,
  type RoundObservation,
} from "./round-observation.js";
import { executionFeedbackSummarySchema } from "./execution-feedback.js";
import type { ResearchContext } from "./research-context.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  uint = z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .max(96),
  signed = z
    .string()
    .regex(/^(0|-?[1-9][0-9]*)$/)
    .max(97),
  integer = z.number().int().nonnegative().safe(),
  address = z.string().refine(isAddress);
const walletSchema = z
  .object({
    agentId: z.string(),
    wallet: address,
    openingSnapshotId: digest.nullable(),
    closingSnapshotId: digest.nullable(),
    proofIds: z.array(digest),
    captureAttemptIds: z.array(z.string()),
    openingNavMicros: uint.nullable(),
    closingNavMicros: uint.nullable(),
    navDeltaMicros: signed.nullable(),
    periodPnlMicros: signed.nullable(),
    status: z.enum(["KNOWN", "UNKNOWN"]),
    missingReasons: z.array(z.string()),
    holdings: z
      .array(
        z
          .object({
            asset: z.union([z.literal("native"), address]),
            bucket: z.enum(["BNB", "BTC", "ETH", "STABLE"]),
            balance: uint,
            valueMicros: uint,
            priceMicros: uint,
          })
          .strict(),
      )
      .max(24),
  })
  .strict();
export const roundObservationSummarySchema = z
  .object({
    version: z.literal("round-observation-context/1"),
    observationId: digest,
    ledgerRevisionHash: digest,
    currency: z.literal("micro-USD"),
    scope: z.literal("REGISTERED_ASSETS_AND_NATIVE_EOA"),
    chainId: integer.positive(),
    roundId: z.string(),
    sourceStatus: z.enum(["PUBLISHED", "FAILED"]),
    terminalAt: integer.nullable(),
    observedAt: integer,
    lifecycle: z.enum(["PENDING", "COMPLETE"]),
    rosterComplete: z.boolean(),
    openingBoundary: observationBoundarySchema.nullable(),
    closingBoundary: observationBoundarySchema.nullable(),
    predecessorId: digest.nullable(),
    registryHash: digest.nullable(),
    delayMs: integer.nullable(),
    omittedWalletCount: integer,
    missingReasons: z.array(z.string()),
    network: z
      .object({
        status: z.enum(["KNOWN", "UNKNOWN"]),
        periodPnlMicros: signed.nullable(),
        knownPeriodPnlMicros: signed,
        knownWalletCount: integer,
        missingWallets: z.array(address),
        periodReturn: z
          .object({ numerator: signed, denominator: uint })
          .nullable(),
      })
      .strict(),
    wallets: z.array(walletSchema).max(32),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      (s.network.status === "KNOWN") !== (s.network.periodPnlMicros !== null) ||
      (s.network.status === "KNOWN" &&
        (!s.rosterComplete || s.network.missingWallets.length))
    )
      ctx.addIssue({ code: "custom", message: "inconsistent network status" });
    for (const w of s.wallets)
      if (
        (w.status === "KNOWN") !== (w.periodPnlMicros !== null) ||
        (w.status === "KNOWN" &&
          (!s.openingBoundary ||
            !s.closingBoundary ||
            s.closingBoundary.blockNumber <= s.openingBoundary.blockNumber ||
            !w.proofIds.length ||
            !w.openingSnapshotId ||
            !w.closingSnapshotId))
      )
        ctx.addIssue({ code: "custom", message: "inconsistent wallet status" });
  });
export type RoundObservationSummary = z.infer<
  typeof roundObservationSummarySchema
>;
export function buildRoundObservationSummary(
  db: Store,
  observationId: string,
): RoundObservationSummary {
  const r = db.get<RoundObservation>("round-observation", observationId);
  if (!r) throw Error("OBSERVATION_MISSING");
  const head = db.get<{ id: string }>(
    "round-observation-head",
    hash([r.chainId, r.roundId]),
  );
  if (!head) throw Error("OBSERVATION_HEAD_MISSING");
  let cursor = head.id,
    found = false;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) throw Error("OBSERVATION_HEAD_INTEGRITY");
    visited.add(cursor);
    const revision = db.get<RoundObservation>("round-observation", cursor);
    if (
      !revision ||
      revision.chainId !== r.chainId ||
      revision.roundId !== r.roundId
    )
      throw Error("OBSERVATION_HEAD_INTEGRITY");
    const { id, ...data } = revision;
    if (id !== cursor || hash(data) !== id)
      throw Error("OBSERVATION_HEAD_INTEGRITY");
    if (cursor === observationId) {
      found = true;
      break;
    }
    cursor = revision.supersedes ?? "";
  }
  if (!found) throw Error("OBSERVATION_HEAD_INTEGRITY");
  const { id, ...body } = r;
  if (
    id !== observationId ||
    hash(body) !== id ||
    r.version !== "round-observation/1" ||
    r.currency !== "micro-USD" ||
    r.scope !== "REGISTERED_ASSETS_AND_NATIVE_EOA"
  )
    throw Error("OBSERVATION_INTEGRITY");
  const { version, supersedes, revision, currency, scope, ...input } = body;
  roundObservationInputSchema.parse(input);
  const projected = observationProjection(db, input);
  const ledger = new PerformanceLedger(db)
    .list(r.roundId)
    .find(
      (l) =>
        l.version === "performance-round/2" &&
        l.observationId === id &&
        l.chainId === r.chainId,
    );
  if (!ledger || ledger.currency !== "micro-USD")
    throw Error("OBSERVATION_LEDGER_MISSING");
  const storedInput = db.get<any>("performance-input", ledger.inputHash);
  if (
    !storedInput ||
    hash(storedInput) !== ledger.inputHash ||
    storedInput.observationId !== id ||
    hash(storedInput.perAgent) !==
      hash([...projected].sort((a, b) => a.agentId.localeCompare(b.agentId))) ||
    hash(storedInput.roster) !==
      hash([...r.roster].sort((a, b) => a.agentId.localeCompare(b.agentId)))
  )
    throw Error("OBSERVATION_LEDGER_INTEGRITY");
  if (
    hash({
      version: "performance-revision/2",
      currency: "micro-USD",
      inputHash: ledger.inputHash,
      revision: ledger.revision,
      supersedes: ledger.supersedes,
    }) !== ledger.revisionHash
  )
    throw Error("OBSERVATION_LEDGER_INTEGRITY");
  const wallets = r.wallets.map((w) => {
    const a = projected.find((a) => a.agentId === w.agentId)!,
      pnl = a.cashflowComplete ? a.navDelta : null;
    const s = w.closingSnapshotId
      ? readObservationSnapshot(db, w.closingSnapshotId)
      : null;
    return {
      ...w,
      openingNavMicros: a.openingNAV,
      closingNavMicros: a.closingNAV,
      navDeltaMicros: a.navDelta,
      periodPnlMicros: pnl,
      status: pnl === null ? ("UNKNOWN" as const) : ("KNOWN" as const),
      holdings:
        s?.holdings.map(
          ({ asset, bucket, balance, valueMicros, priceMicros }) => ({
            asset,
            bucket,
            balance,
            valueMicros,
            priceMicros,
          }),
        ) ?? [],
    };
  });
  const known = wallets.filter((w) => w.periodPnlMicros !== null),
    sum = known.reduce((n, w) => n + BigInt(w.periodPnlMicros!), 0n).toString(),
    complete =
      r.rosterComplete && wallets.length > 0 && known.length === wallets.length;
  const opening = complete
    ? wallets.reduce((n, w) => n + BigInt(w.openingNavMicros!), 0n)
    : 0n;
  if (
    ledger.network.periodPnL !== (complete ? sum : null) ||
    ledger.network.knownPeriodPnL !== sum
  )
    throw Error("OBSERVATION_LEDGER_INTEGRITY");
  return roundObservationSummarySchema.parse({
    version: "round-observation-context/1",
    observationId: id,
    ledgerRevisionHash: ledger.revisionHash,
    currency: r.currency,
    scope: r.scope,
    chainId: r.chainId,
    roundId: r.roundId,
    sourceStatus: r.sourceStatus,
    terminalAt: r.terminalAt,
    observedAt: r.observedAt,
    lifecycle: r.lifecycle,
    rosterComplete: r.rosterComplete,
    openingBoundary: r.openingBoundary,
    closingBoundary: r.closingBoundary,
    predecessorId: r.predecessorId,
    registryHash: r.registryHash,
    delayMs:
      r.terminalAt !== null && r.closingBoundary
        ? Math.max(0, r.closingBoundary.blockTimeMs - r.terminalAt)
        : null,
    omittedWalletCount: Math.max(0, wallets.length - 32),
    missingReasons: r.missingReasons,
    network: {
      status: complete ? "KNOWN" : "UNKNOWN",
      periodPnlMicros: complete ? sum : null,
      knownPeriodPnlMicros: sum,
      knownWalletCount: known.length,
      missingWallets: wallets
        .filter((w) => w.status === "UNKNOWN")
        .map((w) => w.wallet),
      periodReturn:
        complete && opening > 0n
          ? { numerator: sum, denominator: opening.toString() }
          : null,
    },
    wallets: wallets.slice(0, 32),
  });
}
export function collectRoundObservationEvidence(
  db: Store,
  chainId: number,
  at: number,
  currentRoundId?: string,
) {
  const revisions = db
    .all<RoundObservation>("round-observation")
    .filter(
      (r) =>
        r.chainId === chainId &&
        r.roundId !== currentRoundId &&
        r.terminalAt !== null &&
        r.terminalAt <= at &&
        r.observedAt <= at,
    )
    .sort(
      (a, b) =>
        b.terminalAt! - a.terminalAt! ||
        b.roundId.localeCompare(a.roundId) ||
        b.revision - a.revision,
    );
  const latest = revisions[0];
  if (!latest) return null;
  const observation = buildRoundObservationSummary(db, latest.id),
    value = {
      kind: "accounting" as const,
      url: `round-observation://${chainId}/${latest.roundId}/${latest.id}`,
      asOf: latest.terminalAt,
      retrievedAt: at,
      contentHash: hash(observation),
    },
    evidence = { id: hash(value), ...value };
  if (!db.get("research-evidence", evidence.id))
    db.insert("research-evidence", evidence.id, {
      ...evidence,
      data: observation,
    });
  return { observation, evidence };
}
export function exactUSD(value: string | null): string | null {
  if (value === null) return null;
  const amount = BigInt(value),
    negative = amount < 0n,
    abs = negative ? -amount : amount;
  return `${negative ? "-" : ""}${abs / 1000000n}.${(abs % 1000000n).toString().padStart(6, "0")}`;
}
export function buildAccountingBrief(context: ResearchContext) {
  const wallet = context.portfolioIdentity?.wallet.toLowerCase(),
    refs = (prefix: string) =>
      context.evidence
        .filter((e) => e.url.startsWith(prefix))
        .map((e) => ({
          id: e.id,
          ref: `E${context.evidence.indexOf(e) + 1}`,
          url: e.url,
        }));
  const e = context.executionFeedback
      ? executionFeedbackSummarySchema.parse(context.executionFeedback)
      : null,
    r = context.roundObservation
      ? roundObservationSummarySchema.parse(context.roundObservation)
      : null;
  const selected = e?.wallets.find((w) => w.wallet.toLowerCase() === wallet),
    observed = r?.wallets.find((w) => w.wallet.toLowerCase() === wallet);
  const amount = (
    w:
      | {
          periodPnlMicros: string | null;
          status: string;
          wallet?: string;
          agentId?: string;
          observationId?: string;
        }
      | null
      | undefined,
  ) => (w ? { ...w, periodPnlUSD: exactUSD(w.periodPnlMicros) } : null);
  return {
    version: "accounting-brief/1" as const,
    currency: "micro-USD" as const,
    representativeWallet: wallet ?? null,
    lifetimeUSDT: {
      status: "UNKNOWN" as const,
      costBasis: null,
      realizedPnl: null,
      unrealizedPnl: null,
      reason: "LIFETIME_COST_BASIS_UNAVAILABLE",
    },
    executionWindow: e
      ? {
          kind: "EXECUTION_WINDOW" as const,
          sourceRoundId: e.roundId,
          windowLabel: "BOUNDARIES_UNAVAILABLE",
          representativeWallet: amount(
            selected
              ? {
                  wallet: selected.wallet,
                  agentId: selected.agentId,
                  observationId: selected.observationId,
                  status: selected.status,
                  periodPnlMicros: selected.periodPnlMicros,
                }
              : null,
          ),
          representativeWalletMissing: selected
            ? null
            : "MATCHED_WALLET_ACCOUNTING_UNAVAILABLE",
          network: amount(e.network),
          evidence: refs("execution-feedback://"),
        }
      : null,
    latestTerminalObservation: r
      ? {
          kind: "INTER_OBSERVATION_WINDOW" as const,
          sourceRoundId: r.roundId,
          observationId: r.observationId,
          lifecycle: r.lifecycle,
          sourceStatus: r.sourceStatus,
          terminalAt: r.terminalAt,
          openingBoundary: r.openingBoundary,
          closingBoundary: r.closingBoundary,
          windowLabel:
            r.openingBoundary && r.closingBoundary
              ? "CONFIRMED_OBSERVATION_BOUNDARIES"
              : "BOUNDARIES_UNAVAILABLE",
          delayMs: r.delayMs,
          scope: r.scope,
          representativeWallet: amount(
            observed
              ? {
                  wallet: observed.wallet,
                  agentId: observed.agentId,
                  status: observed.status,
                  periodPnlMicros: observed.periodPnlMicros,
                }
              : null,
          ),
          representativeWalletMissing: observed
            ? null
            : "MATCHED_WALLET_ACCOUNTING_UNAVAILABLE",
          network: amount(r.network),
          evidence: refs("round-observation://"),
        }
      : null,
    guidance:
      "Verified execution-window and inter-observation-window results are distinct from lifetime USDT cost basis. Report matched-wallet and network results separately. Latest UNKNOWN does not erase an older KNOWN execution window. Abstention is not zero return; UNKNOWN is not zero. Reconcile blanket missing-history statements against these verified windows and cite their evidence.",
  };
}
export type AccountingBrief = ReturnType<typeof buildAccountingBrief>;
