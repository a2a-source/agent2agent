import { hash, type Candidate } from "./protocol.js";
import { MIN_STAKE, uint } from "./money.js";
import { Store } from "./store.js";
export interface FairElection {
  version: "fair-terms/1";
  term: number;
  seed: string;
  committeeSize: number;
  configHash: string;
  candidates: Candidate[];
  participation: Record<string, number>;
  historyHash: string;
  committeeHash: string;
}
export function electFair(
  input: Candidate[],
  seed: string,
  size: number,
  participation: Record<string, number>,
): Candidate[] {
  if (!Number.isSafeInteger(size) || size < 3 || size > 45)
    throw Error("committee size");
  if (
    new Set(input.map((c) => c.id)).size !== input.length ||
    new Set(input.map((c) => c.wallet.toLowerCase())).size !== input.length
  )
    throw Error("duplicate node");
  const ranked = input
    .filter((c) => uint(c.stake) >= MIN_STAKE && uint(c.compute) > 0n)
    .map((candidate) => {
      const count = Object.hasOwn(participation, candidate.id)
        ? participation[candidate.id]!
        : 0;
      if (!Number.isSafeInteger(count) || count < 0)
        throw Error("invalid participation count");
      return {
        candidate,
        count,
        score: hash(["A2A:fair-terms/1", seed, candidate.id]),
      };
    });
  if (ranked.length < 3) throw Error("at least three workers required");
  ranked.sort(
    (a, b) =>
      a.count - b.count ||
      a.score.localeCompare(b.score) ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
  return ranked
    .slice(0, size)
    .map((r) => r.candidate)
    .sort((a, b) =>
      a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase()),
    );
}
/** Counts opportunities granted by persisted terms, including legacy terms and failed rounds. */
export function createFairElection(
  db: Store,
  term: number,
  candidates: Candidate[],
  size: number,
  configHash: string,
) {
  const history = db
    .entries<{ committee: Candidate[] }>("term")
    .map((row) => ({ term: Number(row.id), committee: row.data.committee }));
  const counts = new Map<string, number>();
  for (const row of history) {
    if (
      !Number.isSafeInteger(row.term) ||
      row.term < 0 ||
      row.term >= term ||
      !Array.isArray(row.committee) ||
      new Set(row.committee.map((c) => c.id)).size !== row.committee.length
    )
      throw Error("invalid election history");
    for (const c of row.committee)
      counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  }
  const participation = Object.fromEntries(
    candidates.map((c) => [c.id, counts.get(c.id) ?? 0]),
  );
  const seed = `A2A:fair-terms/1:term:${term}`,
    committee = electFair(candidates, seed, size, participation);
  const proof: FairElection = {
    version: "fair-terms/1",
    term,
    seed,
    committeeSize: size,
    configHash,
    candidates: [...candidates].sort((a, b) => a.id.localeCompare(b.id)),
    participation,
    historyHash: hash(
      history
        .sort((a, b) => a.term - b.term)
        .map((r) => ({ term: r.term, committeeHash: hash(r.committee) })),
    ),
    committeeHash: hash(committee),
  };
  return { proof, committee };
}
export function verifyFairElection(
  proof: FairElection,
  expectedHash: string,
  committee: Candidate[],
  configHash: string,
): boolean {
  try {
    return (
      hash(proof) === expectedHash &&
      proof.version === "fair-terms/1" &&
      Number.isSafeInteger(proof.term) &&
      proof.term >= 0 &&
      proof.seed === `A2A:fair-terms/1:term:${proof.term}` &&
      proof.configHash === configHash &&
      proof.committeeHash === hash(committee) &&
      hash(
        electFair(
          proof.candidates,
          proof.seed,
          proof.committeeSize,
          proof.participation,
        ),
      ) === hash(committee)
    );
  } catch {
    return false;
  }
}
