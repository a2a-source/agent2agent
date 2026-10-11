import { createHash } from "node:crypto";
import { MIN_STAKE, uint } from "./money.js";
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw Error("non-integer canonical number");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k]))
        .join(",") +
      "}"
    );
  throw Error("unsupported canonical value");
}
export const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export interface Candidate {
  id: string;
  wallet: string;
  stake: string;
  compute: string;
}
export function elect(
  input: Candidate[],
  seed: string,
  size: number,
): Candidate[] {
  if (!Number.isInteger(size) || size < 3 || size > 45)
    throw Error("committee size");
  if (
    new Set(input.map((c) => c.id)).size !== input.length ||
    new Set(input.map((c) => c.wallet.toLowerCase())).size !== input.length
  )
    throw Error("duplicate node");
  const ranked = input
    .filter((c) => uint(c.stake) >= MIN_STAKE && uint(c.compute) > 0n)
    .sort((a, b) => {
      const x = BigInt(a.stake),
        y = BigInt(b.stake);
      return x === y
        ? hash([seed, a.id]).localeCompare(hash([seed, b.id]))
        : x > y
          ? -1
          : 1;
    })
    .slice(0, 45);
  if (ranked.length < 3) throw Error("at least three workers required");
  const count = Math.min(size, ranked.length),
    cabinet = ranked.slice(0, 21),
    shuffle = (xs: Candidate[], tag: string) =>
      [...xs].sort((a, b) =>
        hash([seed, tag, a.id]).localeCompare(hash([seed, tag, b.id])),
      );
  if (ranked.length <= count)
    return ranked.sort((a, b) =>
      a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase()),
    );
  const primary = shuffle(cabinet, "primary").slice(0, count - 1),
    used = new Set(primary.map((c) => c.id));
  const extra = shuffle(
    ranked.filter((c) => !used.has(c.id)),
    "candidate",
  ).slice(0, count - primary.length);
  return [...primary, ...extra].sort((a, b) =>
    a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase()),
  );
}
export function leader(committee: Candidate[], slot: number, view: number) {
  if (
    !committee.length ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    !Number.isInteger(view) ||
    view < 0 ||
    view >= committee.length
  )
    throw Error("invalid rotation");
  return committee[(slot + view) % committee.length]!;
}
