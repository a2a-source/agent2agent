import { Transaction, type JsonRpcProvider } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import type { TxRecord } from "./chain.js";
import type { PortfolioSnapshot } from "./portfolio-snapshot.js";
import {
  proveExecutionNoExternalFlowResult,
  type ExecutionCashflowProofResult,
} from "./execution-cashflow.js";
import {
  executionTransactionIds,
  type ExecutionJob,
} from "./investment-execution.js";
import { readObservationSnapshot } from "./round-observation-evidence.js";
export type RoundCashflowResult = ExecutionCashflowProofResult;
class Unsupported extends Error {}
function requireCover(value: unknown, reason: string): asserts value {
  if (!value) throw new Unsupported(reason);
}
/** Minimal deterministic cover. Original native plan and reservation boundaries remain authoritative. */
export async function proveRoundNoExternalFlow(
  db: Store,
  provider: JsonRpcProvider,
  openingSnapshotId: string,
  closingSnapshotId: string,
  confirmations: number,
): Promise<RoundCashflowResult> {
  const body: any = {
    version: "round-cashflow-proof/1",
    openingSnapshotId,
    closingSnapshotId,
    confirmations,
    scope: "REGISTERED_ASSETS_AND_NATIVE_EOA",
    status: "UNKNOWN",
    reasons: [],
    transactionIds: [],
    segments: [],
    blockChecks: [],
  };
  const finish = (): RoundCashflowResult => {
    const id = hash(body);
    if (!db.get("round-cashflow-proof", id))
      db.insert("round-cashflow-proof", id, { ...body, id });
    return {
      proofId: id,
      status: body.status,
      reasons: body.reasons,
      ...(body.status === "KNOWN"
        ? {
            cashflow: {
              complete: true as const,
              netExternalFlowMicros: "0" as const,
              hasExternalFlows: false as const,
              provenance: [id],
            },
          }
        : {}),
    };
  };
  try {
    const opening = readObservationSnapshot(db, openingSnapshotId),
      closing = readObservationSnapshot(db, closingSnapshotId);
    requireCover(
      opening.chainId === closing.chainId &&
        opening.wallet === closing.wallet &&
        opening.agent === closing.agent &&
        opening.registryHash === closing.registryHash,
      "BOUNDARY_IDENTITY_MISMATCH",
    );
    requireCover(
      closing.blockNumber > opening.blockNumber &&
        closing.blockNumber - opening.blockNumber <= 4096,
      "INVALID_OR_OVERSIZE_INTERVAL",
    );
    const rows = db
      .all<TxRecord>("transaction")
      .filter((r) => r.sender.toLowerCase() === opening.wallet)
      .filter((r) => {
        try {
          return Transaction.from(r.raw).chainId === BigInt(opening.chainId);
        } catch {
          throw new Unsupported("INVALID_JOURNAL_TRANSACTION");
        }
      });
    // Unresolved outgoing intents are ambiguous; never silently omit them.
    requireCover(
      !rows.some((r) => r.state === "READY"),
      "JOURNAL_TRANSACTION_NOT_FINAL",
    );
    const outer = rows
      .filter(
        (r) =>
          r.block !== undefined &&
          r.block > opening.blockNumber &&
          r.block <= closing.blockNumber,
      )
      .sort((a, b) => a.block! - b.block! || a.id.localeCompare(b.id));
    requireCover(outer.length <= 256, "INVALID_TRANSACTION_SET");
    body.transactionIds = outer.map((r) => r.id);
    const direct = await proveExecutionNoExternalFlowResult(
      db,
      provider,
      openingSnapshotId,
      closingSnapshotId,
      body.transactionIds,
      confirmations,
    );
    body.directProofId = direct.proofId;
    if (direct.status === "KNOWN") {
      body.status = "KNOWN";
      return finish();
    }
    requireCover(
      direct.reasons.includes("NATIVE_SWAP_INTENT_MISMATCH"),
      direct.reasons[0] ?? "DIRECT_PROOF_UNKNOWN",
    );
    const native = outer.filter((r) => Transaction.from(r.raw).value > 0n);
    requireCover(native.length > 0, "NATIVE_COVER_UNAVAILABLE");
    const jobs = db
      .all<ExecutionJob>("investment-execution-job")
      .filter(
        (j) =>
          j.chainId === opening.chainId &&
          j.wallet.toLowerCase() === opening.wallet &&
          j.orders.some((o) =>
            executionTransactionIds(o).some((id) =>
              native.some((r) => r.id === id),
            ),
          ),
      );
    requireCover(jobs.length > 0 && jobs.length <= 16, "NATIVE_SEGMENT_BOUND");
    const segments = jobs
      .map((j) => {
        requireCover(
          ["DONE", "ABORTED"].includes(j.status) && j.closingSnapshotId,
          "NATIVE_JOB_NOT_FINAL",
        );
        const plan = db.get<any>("stable-wallet-plan", j.planId);
        requireCover(plan?.snapshotId, "NATIVE_PLAN_MISSING");
        const a = readObservationSnapshot(db, plan.snapshotId),
          b = readObservationSnapshot(db, j.closingSnapshotId!);
        requireCover(
          a.chainId === opening.chainId &&
            b.chainId === opening.chainId &&
            a.wallet === opening.wallet &&
            b.wallet === opening.wallet &&
            a.agent === opening.agent &&
            b.agent === opening.agent &&
            a.registryHash === opening.registryHash &&
            b.registryHash === opening.registryHash,
          "NATIVE_SEGMENT_IDENTITY_MISMATCH",
        );
        requireCover(
          a.blockNumber >= opening.blockNumber &&
            b.blockNumber <= closing.blockNumber &&
            b.blockNumber > a.blockNumber,
          "NATIVE_SEGMENT_STRADDLES_BOUNDARY",
        );
        const ids = j.orders
          .flatMap(executionTransactionIds)
          .filter((id) => !!db.get("transaction", id));
        requireCover(
          new Set(ids).size === ids.length &&
            ids.every((id) => outer.some((r) => r.id === id)),
          "NATIVE_SEGMENT_TRANSACTION_MISMATCH",
        );
        return { jobId: j.id, a, b, ids };
      })
      .sort(
        (a, b) =>
          a.a.blockNumber - b.a.blockNumber || a.jobId.localeCompare(b.jobId),
      );
    const union = segments.flatMap((s) => s.ids);
    requireCover(
      new Set(union).size === union.length &&
        hash([...union].sort()) === hash([...body.transactionIds].sort()),
      "NATIVE_COVER_TRANSACTION_MISMATCH",
    );
    for (let i = 1; i < segments.length; i++)
      requireCover(
        segments[i]!.a.blockNumber >= segments[i - 1]!.b.blockNumber,
        "NATIVE_SEGMENTS_OVERLAP",
      );
    const boundaries = new Map<string, PortfolioSnapshot>([
      [opening.id, opening],
      [closing.id, closing],
    ]);
    const prove = async (
      a: PortfolioSnapshot,
      b: PortfolioSnapshot,
      ids: string[],
      jobId: string | null,
    ) => {
      boundaries.set(a.id, a);
      boundaries.set(b.id, b);
      if (a.blockNumber === b.blockNumber) {
        const raw = (s: PortfolioSnapshot) =>
          s.holdings
            .map((h) => ({ asset: h.asset, balance: h.balance }))
            .sort((a, b) => a.asset.localeCompare(b.asset));
        requireCover(
          ids.length === 0 &&
            a.blockHash === b.blockHash &&
            hash(raw(a)) === hash(raw(b)),
          "ZERO_LENGTH_JOIN_MISMATCH",
        );
        body.segments.push({
          openingSnapshotId: a.id,
          closingSnapshotId: b.id,
          transactionIds: [],
          proofId: null,
          jobId,
          zeroLength: true,
        });
        return;
      }
      requireCover(b.blockNumber > a.blockNumber, "NATIVE_COVER_ORDER_INVALID");
      const result = await proveExecutionNoExternalFlowResult(
        db,
        provider,
        a.id,
        b.id,
        ids,
        confirmations,
      );
      body.segments.push({
        openingSnapshotId: a.id,
        closingSnapshotId: b.id,
        transactionIds: ids,
        proofId: result.proofId,
        jobId,
        zeroLength: false,
      });
      requireCover(
        result.status === "KNOWN",
        result.reasons[0] ?? "COMPONENT_UNKNOWN",
      );
    };
    let cursor = opening;
    for (const s of segments) {
      await prove(cursor, s.a, [], null);
      await prove(s.a, s.b, s.ids, s.jobId);
      cursor = s.b;
    }
    await prove(cursor, closing, [], null);
    for (const s of boundaries.values()) {
      const b = await provider.send("eth_getBlockByNumber", [
        "0x" + s.blockNumber.toString(16),
        false,
      ]);
      body.blockChecks.push({
        snapshotId: s.id,
        number: s.blockNumber,
        expected: s.blockHash,
        observed: b?.hash ?? null,
      });
      requireCover(
        b?.hash?.toLowerCase() === s.blockHash.toLowerCase() &&
          Number(BigInt(b.number)) === s.blockNumber,
        "CANONICAL_JOIN_MISMATCH",
      );
    }
    requireCover(
      (await provider.getNetwork()).chainId === BigInt(opening.chainId),
      "CHAIN_MISMATCH",
    );
    body.status = "KNOWN";
  } catch (error) {
    if (error instanceof Unsupported) body.reasons = [error.message];
    else if (error instanceof Error && error.message.startsWith("OBSERVATION_"))
      body.reasons = [error.message];
    else {
      body.reasons = ["RPC_UNAVAILABLE"];
      const componentProofId = (error as { proofId?: string })?.proofId;
      if (componentProofId) body.failedComponentProofId = componentProofId;
      const result = finish();
      throw Object.assign(Error("round cashflow RPC unavailable"), {
        proofId: result.proofId,
      });
    }
  }
  return finish();
}
