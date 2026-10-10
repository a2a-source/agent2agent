import { Store } from "./store.js";
import { hash } from "./protocol.js";
import type { PortfolioSnapshot } from "./portfolio-snapshot.js";
function requireEvidence(value: unknown, reason: string): asserts value {
  if (!value) throw Error(reason);
}
export function readObservationSnapshot(
  db: Store,
  id: string,
): PortfolioSnapshot {
  const s = db.get<PortfolioSnapshot>("portfolio-snapshot", id);
  requireEvidence(s, "OBSERVATION_SNAPSHOT_MISSING");
  const { id: actual, ...body } = s,
    capture = db.get<any>("portfolio-capture", s.requestId);
  requireEvidence(
    actual === id &&
      hash(body) === id &&
      capture?.status === "DONE" &&
      capture.snapshotId === id &&
      hash(capture.registry) === s.registryHash,
    "OBSERVATION_SNAPSHOT_INTEGRITY",
  );
  return s;
}
function readProof(db: Store, kind: string, id: string) {
  const p = db.get<any>(kind, id);
  requireEvidence(p, "OBSERVATION_PROOF_MISSING");
  const { id: actual, ...body } = p;
  requireEvidence(
    actual === id && hash(body) === id,
    "OBSERVATION_PROOF_INTEGRITY",
  );
  return p;
}
function executionProof(
  db: Store,
  id: string,
  a: PortfolioSnapshot,
  b: PortfolioSnapshot,
  ids: string[],
) {
  const p = readProof(db, "execution-cashflow-proof", id);
  requireEvidence(
    ["execution-cashflow-proof/1", "execution-cashflow-proof/2"].includes(
      p.version,
    ) &&
      p.status === "KNOWN" &&
      Array.isArray(p.reasons) &&
      !p.reasons.length &&
      p.scope === "REGISTERED_ASSETS_AND_NATIVE_EOA" &&
      p.openingSnapshotId === a.id &&
      p.closingSnapshotId === b.id &&
      p.chainId === a.chainId &&
      p.wallet === a.wallet &&
      p.registryHash === a.registryHash &&
      hash(p.transactionIds) === hash(ids) &&
      p.boundaries?.opening.block === a.blockNumber &&
      p.boundaries.opening.hash === a.blockHash &&
      p.boundaries?.closing.block === b.blockNumber &&
      p.boundaries.closing.hash === b.blockHash &&
      p.nonceBounds?.closing - p.nonceBounds?.opening === ids.length &&
      Array.isArray(p.transactions) &&
      p.transactions.length === ids.length &&
      ids.every((id) => p.transactions.some((t: any) => t.id === id)) &&
      Array.isArray(p.assets) &&
      p.assets.length === a.holdings.length &&
      Array.isArray(p.blockChecks) &&
      p.blockChecks.length >= 2 &&
      p.blockChecks.every(
        (c: any) => c.expected?.toLowerCase() === c.observed?.toLowerCase(),
      ),
    "OBSERVATION_PROOF_PROVENANCE_INVALID",
  );
  for (const s of [a, b])
    requireEvidence(
      p.blockChecks.some(
        (c: any) =>
          c.number === s.blockNumber &&
          c.expected.toLowerCase() === s.blockHash.toLowerCase(),
      ),
      "OBSERVATION_PROOF_PROVENANCE_INVALID",
    );
  for (const h of a.holdings) {
    const asset = p.assets.find((v: any) => v.asset === h.asset),
      closing = b.holdings.find((v) => v.asset === h.asset);
    requireEvidence(
      asset &&
        closing &&
        asset.openingBalance === h.balance &&
        asset.closingBalance === closing.balance,
      "OBSERVATION_PROOF_HOLDINGS_MISMATCH",
    );
  }
}
/** Validate immutable component references, exact cover and original snapshot bindings before projection. */
export function validateRoundCashflowProof(
  db: Store,
  id: string,
  openingSnapshotId: string | null,
  closingSnapshotId: string | null,
): "KNOWN" | "UNKNOWN" {
  const p = readProof(db, "round-cashflow-proof", id);
  requireEvidence(
    p.version === "round-cashflow-proof/1" &&
      p.scope === "REGISTERED_ASSETS_AND_NATIVE_EOA" &&
      p.openingSnapshotId === openingSnapshotId &&
      p.closingSnapshotId === closingSnapshotId &&
      ["KNOWN", "UNKNOWN"].includes(p.status) &&
      Array.isArray(p.reasons),
    "OBSERVATION_PROOF_INTEGRITY",
  );
  if (p.status === "UNKNOWN") return "UNKNOWN";
  requireEvidence(
    openingSnapshotId &&
      closingSnapshotId &&
      p.reasons.length === 0 &&
      Number.isSafeInteger(p.confirmations) &&
      p.confirmations > 0 &&
      Array.isArray(p.transactionIds) &&
      p.transactionIds.length <= 256 &&
      new Set(p.transactionIds).size === p.transactionIds.length,
    "OBSERVATION_PROOF_PROVENANCE_INVALID",
  );
  const a = readObservationSnapshot(db, openingSnapshotId),
    b = readObservationSnapshot(db, closingSnapshotId);
  requireEvidence(
    a.wallet === b.wallet &&
      a.agent === b.agent &&
      a.chainId === b.chainId &&
      a.registryHash === b.registryHash &&
      b.blockNumber > a.blockNumber &&
      b.blockNumber - a.blockNumber <= 4096,
    "OBSERVATION_PROOF_BOUNDARY_MISMATCH",
  );
  if (!p.segments?.length) {
    requireEvidence(p.directProofId, "OBSERVATION_PROOF_PROVENANCE_INVALID");
    executionProof(db, p.directProofId, a, b, p.transactionIds);
    return "KNOWN";
  }
  requireEvidence(
    p.segments.length <= 33 && Array.isArray(p.blockChecks),
    "OBSERVATION_PROOF_PROVENANCE_INVALID",
  );
  let cursor = a.id;
  const covered: string[] = [];
  const boundaries = new Set<string>([a.id, b.id]);
  for (const s of p.segments) {
    requireEvidence(
      s.openingSnapshotId === cursor && Array.isArray(s.transactionIds),
      "OBSERVATION_PROOF_COVER_INVALID",
    );
    const from = readObservationSnapshot(db, s.openingSnapshotId),
      to = readObservationSnapshot(db, s.closingSnapshotId);
    for (const x of [from, to]) {
      requireEvidence(
        x.wallet === a.wallet &&
          x.agent === a.agent &&
          x.chainId === a.chainId &&
          x.registryHash === a.registryHash,
        "OBSERVATION_PROOF_BOUNDARY_MISMATCH",
      );
      boundaries.add(x.id);
    }
    if (s.zeroLength) {
      const holdings = (x: PortfolioSnapshot) =>
        x.holdings
          .map((h) => ({ asset: h.asset, balance: h.balance }))
          .sort((a, b) => a.asset.localeCompare(b.asset));
      requireEvidence(
        !s.proofId &&
          !s.jobId &&
          !s.transactionIds.length &&
          from.blockNumber === to.blockNumber &&
          from.blockHash === to.blockHash &&
          hash(holdings(from)) === hash(holdings(to)),
        "OBSERVATION_PROOF_JOIN_INVALID",
      );
    } else {
      requireEvidence(
        to.blockNumber > from.blockNumber && s.proofId,
        "OBSERVATION_PROOF_COVER_INVALID",
      );
      executionProof(db, s.proofId, from, to, s.transactionIds);
      if (s.jobId) {
        const job = db.get<any>("investment-execution-job", s.jobId),
          plan = job ? db.get<any>("stable-wallet-plan", job.planId) : null;
        requireEvidence(
          job &&
            ["DONE", "ABORTED"].includes(job.status) &&
            job.closingSnapshotId === to.id &&
            plan?.snapshotId === from.id,
          "OBSERVATION_PROOF_JOB_BINDING_INVALID",
        );
      } else
        requireEvidence(
          s.transactionIds.length === 0,
          "OBSERVATION_PROOF_GAP_INVALID",
        );
    }
    cursor = to.id;
    covered.push(...s.transactionIds);
  }
  requireEvidence(
    cursor === b.id &&
      new Set(covered).size === covered.length &&
      hash([...covered].sort()) === hash([...p.transactionIds].sort()),
    "OBSERVATION_PROOF_COVER_INVALID",
  );
  for (const id of boundaries) {
    const s = readObservationSnapshot(db, id);
    requireEvidence(
      p.blockChecks.some(
        (c: any) =>
          c.snapshotId === id &&
          c.number === s.blockNumber &&
          c.expected === s.blockHash &&
          c.observed?.toLowerCase() === s.blockHash.toLowerCase(),
      ),
      "OBSERVATION_PROOF_PROVENANCE_INVALID",
    );
  }
  return "KNOWN";
}
