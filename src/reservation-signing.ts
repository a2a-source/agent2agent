import { z } from "zod";
import { isAddress, type TransactionRequest } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
export interface ReservationBinding {
  id: string;
  reservationId: string;
  chainId: number;
  wallet: string;
  requestHash: string;
  maxFeeWei: string;
  nativeValueWei: string;
  validUntil: number;
  createdAt: number;
}
export function reservedRequestHash(request: TransactionRequest) {
  if (
    typeof request.to !== "string" ||
    !isAddress(request.to) ||
    typeof (request.data ?? "0x") !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(String(request.data ?? "0x"))
  )
    throw Error("reservation binding requires concrete call");
  const value = BigInt(request.value ?? 0);
  if (value < 0n) throw Error("negative reservation value");
  return hash({
    to: request.to.toLowerCase(),
    data: String(request.data ?? "0x").toLowerCase(),
    value: value.toString(),
  });
}
export function bindReservedTransaction(
  db: Store,
  reservationId: string,
  id: string,
  request: TransactionRequest,
  maxFeeWei: string,
  validUntil: number,
  now: number,
): ReservationBinding {
  z.number().int().nonnegative().safe().parse(now);
  z.number().int().positive().safe().parse(validUntil);
  z.string()
    .regex(/^[1-9][0-9]*$/)
    .max(78)
    .parse(maxFeeWei);
  const requestHash = reservedRequestHash(request);
  return db.transaction(() => {
    const r = db.get<any>("wallet-reservation", reservationId);
    if (!r || r.status !== "RESERVED" || !r.transactionIds.includes(id))
      throw Error("active reservation membership required");
    const old = db.get<ReservationBinding>("wallet-reservation-binding", id);
    if (old) {
      if (
        old.reservationId !== reservationId ||
        old.requestHash !== requestHash ||
        old.maxFeeWei !== maxFeeWei ||
        old.validUntil !== validUntil
      )
        throw Error("reservation binding conflict");
      return old;
    }
    const plan = db.get<any>("stable-wallet-plan", r.planId);
    if (
      !plan ||
      validUntil > plan.validUntil ||
      now >= validUntil ||
      now < r.createdAt
    )
      throw Error("reservation binding expired or outside plan");
    if (db.get("transaction", id)) throw Error("transaction already signed");
    const lock = db.get<{ expires: number }>("sender-lock", r.wallet);
    if (lock && lock.expires > now) throw Error("wallet signer active");
    const prior = db
      .all<ReservationBinding>("wallet-reservation-binding")
      .filter((b) => b.reservationId === reservationId)
      .reduce((n, b) => n + BigInt(b.maxFeeWei) + BigInt(b.nativeValueWei), 0n);
    const value = BigInt(request.value ?? 0);
    if (prior + value + BigInt(maxFeeWei) > BigInt(r.amounts.native ?? "0"))
      throw Error("reservation native budget exceeded");
    const row: ReservationBinding = {
      id,
      reservationId,
      chainId: r.chainId,
      wallet: r.wallet,
      requestHash,
      maxFeeWei,
      nativeValueWei: value.toString(),
      validUntil,
      createdAt: now,
    };
    db.insert("wallet-reservation-binding", id, row);
    return row;
  });
}
/** Must run while Journal owns sender lease, both before signing and before storing bytes. */
export function checkReservedSigning(
  db: Store,
  chainId: number,
  id: string,
  sender: string,
  request: TransactionRequest,
  fee: bigint,
  now: number,
): ReservationBinding | undefined {
  const wallet = sender.toLowerCase();
  const all = db.all<any>("wallet-reservation");
  const own = all.find((r) => r.transactionIds.includes(id));
  if (own && (own.chainId !== chainId || own.wallet !== wallet))
    throw Error("reservation wallet or chain mismatch");
  const rows = all.filter((r) => r.chainId === chainId && r.wallet === wallet);
  const active = rows.filter((r) => r.status === "RESERVED");
  if (!own) {
    if (active.length)
      throw Error("wallet funds reserved by another reservation");
    return;
  }
  if (
    own.status !== "RESERVED" ||
    active.length !== 1 ||
    active[0].id !== own.id
  )
    throw Error("reservation inactive or competing");
  const b = db.get<ReservationBinding>("wallet-reservation-binding", id);
  if (
    !b ||
    b.reservationId !== own.id ||
    b.wallet !== wallet ||
    b.chainId !== chainId ||
    now < b.createdAt ||
    now >= b.validUntil ||
    b.requestHash !== reservedRequestHash(request) ||
    fee > BigInt(b.maxFeeWei)
  )
    throw Error("reservation binding invalid, expired or over budget");
  return b;
}
