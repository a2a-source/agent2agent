import { z } from "zod";
import { getAddress } from "ethers";
import { hash } from "./protocol.js";
import { Store } from "./store.js";

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const unsigned = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/)
  .nullable();
const signed = z
  .string()
  .max(79)
  .regex(/^(0|-?[1-9][0-9]*)$/)
  .refine((v) => v.replace("-", "").length <= 78)
  .nullable();
const amountFields = {
  openingNAV: unsigned,
  closingNAV: unsigned,
  netCapitalFlow: signed,
  cashflowComplete: z.boolean(),
  hasCapitalFlows: z.boolean().nullable().default(null),
  missingReasons: z.array(z.string().min(1).max(240)).max(32),
};
const investmentSchema = z
  .object({
    investmentId: identifier,
    ...amountFields,
    realizedPeriodPnL: signed.optional().default(null),
    closingUnrealizedPnL: signed.optional().default(null),
  })
  .strict();
const agentSchema = z
  .object({
    agentId: identifier,
    ...amountFields,
    investments: z.array(investmentSchema).max(1000),
  })
  .strict();
const inputSchema = z
  .object({
    version: z.literal("performance-input/1"),
    currency: z.literal("micro-USDT"),
    roundId: identifier,
    chainId: z.number().int().positive().safe(),
    windowStartMs: z.number().int().nonnegative().safe(),
    windowEndMs: z.number().int().nonnegative().safe(),
    observedAt: z.number().int().nonnegative().safe(),
    roster: z
      .array(
        z.object({ agentId: identifier, wallet: z.string().max(42) }).strict(),
      )
      .min(1)
      .max(1000),
    perAgent: z.array(agentSchema).max(1000),
    supersedes: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type PerformanceInput = z.input<typeof inputSchema>;
type Amounts = z.output<typeof agentSchema>;
export interface PeriodReturn {
  numerator: string;
  denominator: string;
}
interface Derived {
  periodPnL: string | null;
  periodReturn: PeriodReturn | null;
  missingReasons: string[];
}
export type PerformanceInvestment = z.output<typeof investmentSchema> &
  Derived & { id: string; componentSource: "trusted-adapter" };
export type PerformanceAgent = Omit<Amounts, "investments"> &
  Derived & {
    id: string;
    wallet: string;
    investments: PerformanceInvestment[];
  };
export interface PerformanceRound {
  version: "performance-round/1";
  currency: "micro-USDT";
  roundId: string;
  chainId: number;
  windowStartMs: number;
  windowEndMs: number;
  observedAt: number;
  inputHash: string;
  revisionHash: string;
  revision: number;
  supersedes: string | null;
  roster: { agentId: string; wallet: string }[];
  agents: PerformanceAgent[];
  network: {
    periodPnL: string | null;
    knownPeriodPnL: string;
    knownAgentCount: number;
    missingAgentCount: number;
    periodReturn: PeriodReturn | null;
  };
}
const invalid = (): never => {
  throw Error("PERFORMANCE_INVALID_INPUT");
};
function derive(
  a: Pick<
    Amounts,
    | "openingNAV"
    | "closingNAV"
    | "netCapitalFlow"
    | "cashflowComplete"
    | "hasCapitalFlows"
    | "missingReasons"
  >,
): Derived {
  const reasons = [...a.missingReasons];
  if (a.openingNAV === null) reasons.push("OPENING_NAV_UNKNOWN");
  if (a.closingNAV === null) reasons.push("CLOSING_NAV_UNKNOWN");
  if (a.netCapitalFlow === null) reasons.push("NET_CAPITAL_FLOW_UNKNOWN");
  if (!a.cashflowComplete) reasons.push("CASHFLOW_INCOMPLETE");
  const known =
    a.openingNAV !== null &&
    a.closingNAV !== null &&
    a.netCapitalFlow !== null &&
    a.cashflowComplete;
  const pnl = known
    ? BigInt(a.closingNAV!) - BigInt(a.openingNAV!) - BigInt(a.netCapitalFlow!)
    : null;
  return {
    periodPnL: pnl?.toString() ?? null,
    periodReturn:
      pnl !== null &&
      a.hasCapitalFlows === false &&
      a.netCapitalFlow === "0" &&
      BigInt(a.openingNAV!) > 0n
        ? { numerator: pnl.toString(), denominator: a.openingNAV! }
        : null,
    missingReasons: [...new Set(reasons)].sort(),
  };
}
function parse(raw: unknown) {
  const result = inputSchema.safeParse(raw);
  if (!result.success) return invalid();
  const x = result.data;
  if (x.windowEndMs <= x.windowStartMs || x.observedAt < x.windowEndMs)
    invalid();
  const agents = new Set<string>(),
    wallets = new Set<string>();
  for (const r of x.roster) {
    try {
      r.wallet = getAddress(r.wallet).toLowerCase();
      if (r.wallet === "0x0000000000000000000000000000000000000000") invalid();
    } catch {
      invalid();
    }
    if (agents.has(r.agentId) || wallets.has(r.wallet)) invalid();
    agents.add(r.agentId);
    wallets.add(r.wallet);
  }
  const rows = new Set<string>();
  let investmentCount = 0;
  for (const a of x.perAgent) {
    if (!agents.has(a.agentId) || rows.has(a.agentId)) invalid();
    rows.add(a.agentId);
    const ids = new Set<string>();
    for (const row of [a, ...a.investments]) {
      if (
        row.hasCapitalFlows === false &&
        row.netCapitalFlow !== null &&
        row.netCapitalFlow !== "0"
      )
        invalid();
    }
    for (const i of a.investments) {
      if (ids.has(i.investmentId)) invalid();
      ids.add(i.investmentId);
      investmentCount++;
    }
    a.investments.sort((a, b) => a.investmentId.localeCompare(b.investmentId));
  }
  if (investmentCount > 10000) invalid();
  x.roster.sort((a, b) => a.agentId.localeCompare(b.agentId));
  x.perAgent.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return x;
}

/** Accounting only: observations must come from a trusted adapter; this does not verify chain truth. */
export class PerformanceLedger {
  constructor(private readonly db: Store) {}
  recordRound(raw: unknown): PerformanceRound {
    const parsed = parse(raw),
      { supersedes, ...input } = parsed;
    const inputHash = hash(input);
    return this.db.transaction(() => {
      const previous = this.list(input.roundId).filter(
        (r) => r.chainId === input.chainId,
      );
      const replay = previous.find((r) => r.inputHash === inputHash);
      if (replay) return replay;
      const current = previous.at(-1);
      if (
        (current && supersedes !== current.revisionHash) ||
        (!current && supersedes !== undefined)
      )
        throw Error("PERFORMANCE_REVISION_CONFLICT");
      const revision = (current?.revision ?? 0) + 1;
      const revisionHash = hash({
        version: "performance-revision/1",
        inputHash,
        revision,
        supersedes: current?.revisionHash ?? null,
      });
      const agents: PerformanceAgent[] = input.roster.map((r) => {
        const a = input.perAgent.find((a) => a.agentId === r.agentId) ?? {
          agentId: r.agentId,
          openingNAV: null,
          closingNAV: null,
          netCapitalFlow: null,
          cashflowComplete: false,
          hasCapitalFlows: null,
          missingReasons: ["AGENT_OBSERVATION_MISSING"],
          investments: [],
        };
        const id = hash([revisionHash, "agent", r.agentId]);
        const investments = a.investments.map((i) => ({
          ...i,
          ...derive(i),
          id: hash([revisionHash, "investment", r.agentId, i.investmentId]),
          componentSource: "trusted-adapter" as const,
        }));
        return { ...a, ...derive(a), wallet: r.wallet, id, investments };
      });
      const known = agents.filter((a) => a.periodPnL !== null),
        knownPeriodPnL = known
          .reduce((sum, a) => sum + BigInt(a.periodPnL!), 0n)
          .toString();
      const complete = known.length === agents.length;
      const noFlows =
        complete &&
        agents.every(
          (a) => a.hasCapitalFlows === false && a.netCapitalFlow === "0",
        );
      const opening = noFlows
        ? agents.reduce((s, a) => s + BigInt(a.openingNAV!), 0n)
        : 0n;
      const record: PerformanceRound = {
        version: "performance-round/1",
        currency: input.currency,
        roundId: input.roundId,
        chainId: input.chainId,
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        observedAt: input.observedAt,
        inputHash,
        revisionHash,
        revision,
        supersedes: current?.revisionHash ?? null,
        roster: input.roster,
        agents,
        network: {
          periodPnL: complete ? knownPeriodPnL : null,
          knownPeriodPnL,
          knownAgentCount: known.length,
          missingAgentCount: agents.length - known.length,
          periodReturn:
            noFlows && opening > 0n
              ? { numerator: knownPeriodPnL, denominator: opening.toString() }
              : null,
        },
      };
      for (const agent of agents) {
        for (const investment of agent.investments)
          this.db.insert("performance-investment", investment.id, {
            ...investment,
            revisionHash,
            roundId: input.roundId,
            chainId: input.chainId,
            agentId: agent.agentId,
          });
        this.db.insert("performance-agent", agent.id, {
          ...agent,
          revisionHash,
          roundId: input.roundId,
          chainId: input.chainId,
        });
      }
      this.db.insert("performance-input", inputHash, input);
      this.db.insert("performance-round", revisionHash, record);
      return record;
    });
  }
  list(roundId?: string): PerformanceRound[] {
    return this.db
      .all<PerformanceRound>("performance-round")
      .filter((r) => roundId === undefined || r.roundId === roundId)
      .sort(
        (a, b) =>
          a.roundId.localeCompare(b.roundId) ||
          a.chainId - b.chainId ||
          a.revision - b.revision,
      );
  }
  latest(roundId: string, chainId?: number): PerformanceRound | undefined {
    const rows = this.list(roundId).filter(
      (r) => chainId === undefined || r.chainId === chainId,
    );
    if (chainId === undefined && new Set(rows.map((r) => r.chainId)).size > 1)
      throw Error("PERFORMANCE_CHAIN_REQUIRED");
    return rows.at(-1);
  }
}
