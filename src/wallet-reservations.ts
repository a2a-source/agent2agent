import type { TransactionRequest } from "ethers";
import { bindReservedTransaction } from "./reservation-signing.js";
import { z } from "zod";
import { isAddress, ZeroAddress } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import type { PortfolioSnapshot } from "./portfolio-snapshot.js";
import type { TxRecord } from "./chain.js";
const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative().safe();
const amount = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(78);
const requestSchema = z
  .object({
    id,
    planId: id,
    transactionIds: z.array(id).min(1).max(16),
    amounts: z.record(
      z
        .string()
        .refine(
          (a) =>
            a === "native" || (isAddress(a) && a.toLowerCase() !== ZeroAddress),
        ),
      amount,
    ),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      !Object.keys(r.amounts).length ||
      Object.keys(r.amounts).length > 24 ||
      new Set(Object.keys(r.amounts).map((a) => a.toLowerCase())).size !==
        Object.keys(r.amounts).length ||
      new Set(r.transactionIds).size !== r.transactionIds.length
    )
      c.addIssue({ code: "custom", message: "duplicate or empty reservation" });
  });
interface Reservation {
  id: string;
  inputHash: string;
  planId: string;
  snapshotId: string;
  chainId: number;
  wallet: string;
  amounts: Record<string, string>;
  transactionIds: string[];
  createdAt: number;
  status: "RESERVED" | "CANCELLED" | "SETTLED" | "ABORTED";
  finishedAt?: number;
  reconciliationSnapshotId?: string;
}
/** Internal actual-unit exclusion ledger, not authorization to sign or a chain balance oracle. */
export class WalletReservations {
  constructor(readonly db: Store) {}
  private snapshot(id: string, now: number) {
    const s = this.db.get<PortfolioSnapshot>("portfolio-snapshot", id);
    const capture = s && this.db.get<any>("portfolio-capture", s.requestId);
    if (
      !s ||
      capture?.status !== "DONE" ||
      capture.snapshotId !== s.id ||
      now < s.observedAt ||
      now >= s.validUntil
    )
      throw Error("confirmed fresh snapshot required");
    return s;
  }
  reserve(raw: unknown, now: number): Reservation {
    time.parse(now);
    const parsed = requestSchema.parse(raw);
    const r = {
      ...parsed,
      transactionIds: [...parsed.transactionIds].sort(),
      amounts: Object.fromEntries(
        Object.entries(parsed.amounts)
          .map(([a, n]) => [a.toLowerCase(), n] as const)
          .sort(([a], [b]) => a!.localeCompare(b!)),
      ),
    };
    const inputHash = hash(r);
    return this.db.transaction(() => {
      const old = this.db.get<Reservation>("wallet-reservation", r.id);
      if (old) {
        if (old.inputHash !== inputHash) throw Error("reservation conflict");
        return old;
      }
      const p = this.db.get<any>("stable-wallet-plan", r.planId);
      if (!p || p.status !== "READY" || now >= p.validUntil)
        throw Error("plan unavailable or expired");
      const s = this.snapshot(p.snapshotId, now);
      if (
        p.wallet !== s.wallet ||
        p.chainId !== s.chainId ||
        p.agent !== s.agent
      )
        throw Error("plan snapshot mismatch");
      if (
        !this.db
          .all<any>("stable-qsp-consumption")
          .some(
            (c) =>
              c.status === "PLANNED" &&
              c.planId === p.id &&
              c.snapshotId === s.id &&
              c.source?.qspHash &&
              c.source?.confirmationHash,
          )
      )
        throw Error("confirmed consumption required");
      const key = hash([s.chainId, s.wallet]);
      const boundary = this.db.get<{ block: number }>(
        "wallet-reservation-boundary",
        key,
      );
      if (boundary && s.blockNumber <= boundary.block)
        throw Error("snapshot predates settlement boundary");
      const rows = this.db.all<Reservation>("wallet-reservation");
      if (
        rows.some(
          (x) =>
            x.chainId === s.chainId &&
            x.wallet === s.wallet &&
            x.status === "RESERVED",
        )
      )
        throw Error("wallet reservation busy");
      if (
        rows.some((x) =>
          x.transactionIds.some((t) => r.transactionIds.includes(t)),
        ) ||
        r.transactionIds.some((t) => this.db.get("transaction", t))
      )
        throw Error("journal identity already used");
      if (
        this.db
          .all<TxRecord>("transaction")
          .some(
            (t) => t.sender.toLowerCase() === s.wallet && t.state === "READY",
          )
      )
        throw Error("wallet journal busy");
      if (
        this.db
          .all<TxRecord>("transaction")
          .some(
            (t) =>
              t.sender.toLowerCase() === s.wallet &&
              t.block !== undefined &&
              t.block > s.blockNumber,
          )
      )
        throw Error("snapshot predates wallet transaction");
      const lock = this.db.get<{ expires: number }>("sender-lock", s.wallet);
      if (lock && lock.expires > now) throw Error("wallet sender busy");
      for (const [asset, n] of Object.entries(r.amounts)) {
        const h = s.holdings.find((h) => h.asset === asset);
        if (
          !h ||
          BigInt(n) >
            BigInt(h.balance) - BigInt(h.reserved) - BigInt(h.gasExcluded)
        )
          throw Error("reservation exceeds available units");
      }
      const row: Reservation = {
        ...r,
        inputHash,
        snapshotId: s.id,
        chainId: s.chainId,
        wallet: s.wallet,
        createdAt: now,
        status: "RESERVED",
      };
      this.db.insert("wallet-reservation", r.id, row);
      return row;
    });
  }
  cancel(id: string, now: number): Reservation {
    time.parse(now);
    return this.db.transaction(() => {
      const r = this.required(id);
      if (r.status === "CANCELLED") return r;
      if (r.status !== "RESERVED") throw Error("reservation terminal");
      if (r.transactionIds.some((t) => this.db.get("transaction", t)))
        throw Error("journal transaction exists; reconciliation required");
      const lock = this.db.get<{ expires: number }>("sender-lock", r.wallet);
      if (lock && lock.expires > now) throw Error("wallet signer active");
      if (now < r.createdAt) throw Error("invalid cancellation time");
      const result: Reservation = {
        ...r,
        status: "CANCELLED",
        finishedAt: now,
      };
      this.db.put("wallet-reservation", id, result);
      return result;
    });
  }
  settle(id: string, snapshotId: string, now: number): Reservation {
    return this.close(id, snapshotId, now, false);
  }
  abort(id: string, snapshotId: string, now: number): Reservation {
    return this.close(id, snapshotId, now, true);
  }
  private close(
    id: string,
    snapshotId: string,
    now: number,
    aborted: boolean,
  ): Reservation {
    time.parse(now);
    const terminal = aborted ? "ABORTED" : "SETTLED";
    return this.db.transaction(() => {
      const r = this.required(id);
      if (r.status === terminal) {
        if (r.reconciliationSnapshotId !== snapshotId)
          throw Error("settlement conflict");
        return r;
      }
      if (r.status !== "RESERVED") throw Error("reservation terminal");
      const lock = this.db.get<{ expires: number }>("sender-lock", r.wallet);
      if (lock && lock.expires > now) throw Error("wallet signer active");
      const txs = r.transactionIds.map((t) =>
        this.db.get<TxRecord>("transaction", t),
      );
      if (
        txs.some((t) =>
          !t
            ? !aborted
            : (t.state !== "CONFIRMED" &&
                !(
                  aborted &&
                  t.state === "REVERTED" &&
                  t.reservationId === r.id
                )) ||
              !t.block ||
              !t.blockHash ||
              t.sender.toLowerCase() !== r.wallet,
        )
      )
        throw Error("final journal receipts required");
      const s = this.snapshot(snapshotId, now);
      if (
        s.chainId !== r.chainId ||
        s.wallet !== r.wallet ||
        s.observedAt < r.createdAt ||
        txs.some(
          (t) =>
            t &&
            (s.blockNumber < t.block! ||
              (s.blockNumber === t.block && s.blockHash !== t.blockHash)),
        )
      )
        throw Error("snapshot does not reconcile receipts");
      const result: Reservation = {
        ...r,
        status: terminal,
        finishedAt: now,
        reconciliationSnapshotId: snapshotId,
      };
      this.db.put("wallet-reservation", id, result);
      this.db.put("wallet-reservation-boundary", hash([r.chainId, r.wallet]), {
        block: s.blockNumber,
        snapshotId,
      });
      return result;
    });
  }
  bind(
    id: string,
    transactionId: string,
    request: TransactionRequest,
    maxFeeWei: string,
    validUntil: number,
    now: number,
  ) {
    return bindReservedTransaction(
      this.db,
      id,
      transactionId,
      request,
      maxFeeWei,
      validUntil,
      now,
    );
  }
  private required(id: string) {
    const r = this.db.get<Reservation>("wallet-reservation", id);
    if (!r) throw Error("reservation missing");
    return r;
  }
}
