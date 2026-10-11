export const MIN_STAKE = 300000000000000000n;
export function uint(value: string | bigint): bigint {
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value))
    throw Error("invalid unsigned integer");
  const n = BigInt(value);
  if (n < 0n) throw Error("negative amount");
  return n;
}
export function splitTax(amount: bigint) {
  const r = uint(amount),
    platform = (r * 3000n) / 10000n,
    compute = (r * 1500n) / 10000n;
  return {
    platform,
    compute,
    operations: platform - compute,
    agent: r - platform,
  };
}
export function stakeDeficit(
  balance: bigint,
  bonded: bigint,
  gas: bigint,
  reserved: bigint,
): bigint {
  [balance, bonded, gas, reserved].forEach(uint);
  const d = MIN_STAKE > bonded ? MIN_STAKE - bonded : 0n;
  return balance >= d + gas + reserved ? d : 0n;
}
export function nodeStatus(compute: bigint, bonded: bigint, jailed: boolean) {
  return jailed
    ? "JAILED"
    : compute <= 0n
      ? "NO_COMPUTE"
      : bonded < MIN_STAKE
        ? "OBSERVER"
        : "WORKER";
}
