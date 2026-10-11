import { checkReservedSigning } from "./reservation-signing.js";
import {
  type AbstractProvider,
  type Wallet,
  type HDNodeWallet,
  type TransactionRequest,
  keccak256,
  Transaction,
} from "ethers";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
export interface TxRecord {
  id: string;
  sender: string;
  intentHash: string;
  raw: string;
  hash: string;
  state: "READY" | "CONFIRMED" | "REVERTED";
  block?: number;
  blockHash?: string;
  maxFeeWei?: string;
  reservationId?: string;
  hashes?: string[];
  recovery?: {
    attempts: number;
    feeBumps: number;
    logicalAttempts: number;
    started: number;
    nextAt: number;
    reason: string;
    isolated: boolean;
  };
}
export interface TxRecoveryPolicy {
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
  bumpAfterAttempts?: number;
  maxFeeBumps?: number;
  maxGasPriceWei?: string;
  maxTransactionFeeWei?: string;
  maxLogicalAttempts?: number;
  cooldownMs?: number;
  confirmations?: number;
  recoveryBatchSize?: number;
  terminalAuditBatchSize?: number;
}
/** Persist signed bytes before broadcast. A transport timeout retries exactly those bytes. */
export class Journal {
  private busy = new Set<string>();
  private owners = new Map<string, string>();
  private acquire(sender: string) {
    const key = sender.toLowerCase(),
      owner = randomUUID();
    if (this.busy.has(key)) throw Error("sender busy");
    this.db.transaction(() => {
      const old = this.db.get<{ expires: number }>("sender-lock", key);
      if (old && old.expires > Date.now()) throw Error("sender busy");
      this.db.put("sender-lock", key, { owner, expires: Date.now() + 120000 });
    });
    this.busy.add(key);
    this.owners.set(key, owner);
    return owner;
  }
  private fence(sender: string) {
    const key = sender.toLowerCase(),
      lock = this.db.get<{ owner: string; expires: number }>(
        "sender-lock",
        key,
      );
    if (
      !lock ||
      lock.owner !== this.owners.get(key) ||
      lock.expires <= Date.now()
    )
      throw Error("sender lease expired");
  }
  private save(row: TxRecord) {
    this.db.transaction(() => {
      this.fence(row.sender);
      this.db.put("transaction", row.id, row);
    });
  }
  private release(sender: string, owner: string) {
    const key = sender.toLowerCase();
    this.busy.delete(key);
    this.owners.delete(key);
    if (this.db.get<{ owner: string }>("sender-lock", key)?.owner === owner)
      this.db.put("sender-lock", key, { owner, expires: 0 });
  }
  constructor(
    readonly db: Store,
    readonly provider: AbstractProvider,
    readonly chainId: number,
    readonly enabled: boolean,
    readonly policy: TxRecoveryPolicy = {},
    readonly beforeSign?: (planId: string) => void,
  ) {
    if (
      !Number.isSafeInteger(policy.recoveryBatchSize ?? 16) ||
      (policy.recoveryBatchSize ?? 16) < 2 ||
      !Number.isSafeInteger(policy.terminalAuditBatchSize ?? 4) ||
      (policy.terminalAuditBatchSize ?? 4) < 1
    )
      throw Error("invalid recovery batch limits");
  }
  private checkSigning(...args: Parameters<typeof checkReservedSigning>) {
    const binding = checkReservedSigning(...args);
    if (binding) {
      const marker = this.db.get<{ planId: string }>(
        "investment-execution-reservation",
        binding.reservationId,
      );
      if (marker) {
        if (!this.beforeSign) throw Error("execution source hook required");
        if (typeof marker.planId !== "string" || !marker.planId)
          throw Error("invalid execution source marker");
        this.beforeSign(marker.planId);
      }
    }
    return binding;
  }
  async send(
    id: string,
    sender: string,
    signer: () => Wallet | HDNodeWallet,
    request: TransactionRequest,
    options?: { safeRetry: () => Promise<boolean>; confirmations?: number },
  ): Promise<TxRecord> {
    if (!this.enabled) throw Error("chain writes disabled");
    const lockKey = sender.toLowerCase(),
      owner = this.acquire(sender);
    try {
      const intentHash = hash({
        chainId: this.chainId,
        sender: sender.toLowerCase(),
        to: request.to ?? null,
        data: request.data ?? "0x",
        value: String(request.value ?? 0),
      });
      let row = this.db.get<TxRecord>("transaction", id);
      if (row) {
        if (row.intentHash !== intentHash)
          throw Error("transaction intent conflict");
        if (row.state === "REVERTED") {
          if (row.reservationId)
            throw Error(
              "reserved transaction reverted; terminal reconciliation required",
            );
          const recovery = this.meta(row);
          if (Date.now() < recovery.nextAt) return row;
          if (
            (await this.provider.getNetwork()).chainId !== BigInt(this.chainId)
          )
            throw Error("wrong chain");
          const receipt = await this.receipt(row);
          const nonce = Transaction.from(row.raw).nonce;
          if (
            !receipt ||
            receipt.status !== 0 ||
            (await receipt.confirmations()) <
              (options?.confirmations ?? this.policy.confirmations ?? 1) ||
            (await this.provider.getTransactionCount(sender, "latest")) !==
              nonce + 1 ||
            this.otherPending(row) ||
            (await this.provider.getTransactionCount(sender, "pending")) !==
              nonce + 1 ||
            !options ||
            recovery.logicalAttempts >= (this.policy.maxLogicalAttempts ?? 2) ||
            !(await options.safeRetry())
          ) {
            this.defer(row, "REVERTED_UNPROVEN", true);
            throw Error("transaction reverted");
          }
          // A canonical failed receipt consumed exactly our nonce; caller proves the same identity remains absent.
          row = {
            ...row,
            state: "READY",
            recovery: {
              ...recovery,
              logicalAttempts: recovery.logicalAttempts + 1,
              attempts: 0,
              feeBumps: recovery.feeBumps,
              started: Date.now(),
              isolated: false,
              nextAt: 0,
            },
          };
          const tx = Transaction.from(row.raw);
          const retryRequest = { to: tx.to, data: tx.data, value: tx.value };
          this.checkSigning(
            this.db,
            this.chainId,
            id,
            sender,
            retryRequest,
            tx.gasLimit * (tx.gasPrice ?? 0n),
            Date.now(),
          );
          const retrySigner = signer();
          if (retrySigner.address.toLowerCase() !== sender.toLowerCase())
            throw Error("signer mismatch");
          const raw = await retrySigner.signTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gasLimit: tx.gasLimit,
            gasPrice: tx.gasPrice,
            type: 0,
            chainId: this.chainId,
            nonce: nonce + 1,
          });
          row.hashes = [
            ...new Set([...(row.hashes ?? []), row.hash, keccak256(raw)]),
          ];
          row.raw = raw;
          row.hash = keccak256(raw);
          row.block = undefined;
          row.blockHash = undefined;
          this.db.transaction(() => {
            this.checkSigning(
              this.db,
              this.chainId,
              id,
              sender,
              retryRequest,
              tx.gasLimit * (tx.gasPrice ?? 0n),
              Date.now(),
            );
            this.save(row!);
          });
        }
        if (row.state === "CONFIRMED") {
          if (await this.receipt(row)) return row;
          row.state = "READY";
          this.defer(row, "CANONICAL_RECEIPT_MISSING", true);
          return row;
        }
      } else {
        if (
          this.db
            .all<TxRecord>("transaction")
            .some(
              (t) => t.sender.toLowerCase() === lockKey && t.state === "READY",
            )
        )
          throw Error("sender has pending transaction");
        if ((await this.provider.getNetwork()).chainId !== BigInt(this.chainId))
          throw Error("wrong chain");
        const nonce = await this.provider.getTransactionCount(
            sender,
            "pending",
          ),
          fees = await this.provider.getFeeData();
        if (fees.gasPrice === null) throw Error("gas price unavailable");
        const gasLimit =
          ((await this.provider.estimateGas({ ...request, from: sender })) *
            12n) /
          10n;
        if (
          this.policy.maxTransactionFeeWei !== undefined &&
          gasLimit * fees.gasPrice > BigInt(this.policy.maxTransactionFeeWei)
        )
          throw Error("transaction exceeds gas budget");
        if (
          this.policy.maxGasPriceWei !== undefined &&
          fees.gasPrice > BigInt(this.policy.maxGasPriceWei)
        )
          throw Error("transaction exceeds gas price budget");
        const reservedFee = gasLimit * fees.gasPrice;
        const binding = this.checkSigning(
          this.db,
          this.chainId,
          id,
          sender,
          request,
          gasLimit * fees.gasPrice,
          Date.now(),
        );
        const w = signer();
        if (w.address.toLowerCase() !== sender.toLowerCase())
          throw Error("signer mismatch");
        const raw = await w.signTransaction({
          ...request,
          type: 0,
          nonce,
          chainId: this.chainId,
          gasPrice: fees.gasPrice,
          gasLimit,
        });
        row = {
          id,
          sender,
          intentHash,
          raw,
          hash: keccak256(raw),
          state: "READY",
          maxFeeWei: binding
            ? this.policy.maxTransactionFeeWei === undefined ||
              BigInt(binding.maxFeeWei) <
                BigInt(this.policy.maxTransactionFeeWei)
              ? binding.maxFeeWei
              : this.policy.maxTransactionFeeWei
            : this.policy.maxTransactionFeeWei,
          reservationId: binding?.reservationId,
        };
        this.db.transaction(() => {
          const lock = this.db.get<{ owner: string; expires: number }>(
            "sender-lock",
            lockKey,
          );
          if (lock?.owner !== owner || lock.expires <= Date.now())
            throw Error("sender lease expired");
          if (
            this.db
              .all<TxRecord>("transaction")
              .some(
                (t) =>
                  t.sender.toLowerCase() === lockKey && t.state === "READY",
              )
          )
            throw Error("sender has pending transaction");
          this.checkSigning(
            this.db,
            this.chainId,
            id,
            sender,
            request,
            reservedFee,
            Date.now(),
          );
          this.db.insert("transaction", id, row);
        });
      }
      if (
        this.policy.retryBaseMs !== undefined &&
        Date.now() < (row.recovery?.nextAt ?? 0)
      )
        return row;
      await this.retry(row, signer);
      return row;
    } catch (e) {
      this.db.put("transaction-error", id, {
        id,
        at: Date.now(),
        reason:
          (e as { code?: string }).code === "INSUFFICIENT_FUNDS"
            ? "INSUFFICIENT_FUNDS"
            : (this.db.get<TxRecord>("transaction", id)?.recovery?.reason ??
              "SEND_UNAVAILABLE"),
      });
      throw e;
    } finally {
      this.release(sender, owner);
    }
  }
  private otherPending(row: TxRecord) {
    return this.db
      .all<TxRecord>("transaction")
      .some(
        (t) =>
          t.id !== row.id &&
          t.sender.toLowerCase() === row.sender.toLowerCase() &&
          t.state === "READY",
      );
  }
  private meta(row: TxRecord) {
    return (row.recovery ??= {
      attempts: 0,
      feeBumps: 0,
      logicalAttempts: 0,
      started: Date.now(),
      nextAt: 0,
      reason: "PENDING",
      isolated: false,
    });
  }
  private defer(row: TxRecord, reason: string, isolated = false) {
    const m = this.meta(row);
    m.reason = reason;
    m.isolated = isolated;
    m.nextAt =
      Date.now() +
      Math.min(
        this.policy.retryMaxMs ?? 60000,
        (this.policy.retryBaseMs ?? 1000) * 2 ** Math.min(m.attempts, 16),
      );
    if (
      isolated &&
      ["NONCE_CONSUMED", "CANONICAL_RECEIPT_MISSING"].includes(reason)
    )
      m.nextAt = Math.max(
        m.nextAt,
        Date.now() + (this.policy.cooldownMs ?? 60000),
      );
    this.save(row);
    this.db.put("transaction-error", row.id, {
      id: row.id,
      at: Date.now(),
      reason,
    });
  }
  private async receipt(row: TxRecord) {
    // All generations/replacements are retained. A receipt prevents any replacement.
    for (const h of [...new Set([row.hash, ...(row.hashes ?? [])])]) {
      const r = await this.provider.getTransactionReceipt(h);
      if (r) {
        if (r.hash && r.hash.toLowerCase() !== h.toLowerCase()) continue;
        if (r.blockHash && this.provider.getBlock) {
          const b = await this.provider.getBlock(r.blockNumber);
          if (!b || b.hash !== r.blockHash) continue;
        }
        // Ignore consumed reverted generations after an explicitly safe logical retry.
        if (
          h !== row.hash &&
          r.status === 0 &&
          this.meta(row).logicalAttempts > 0
        )
          continue;
        return r;
      }
    }
    return null;
  }
  private async retry(row: TxRecord, signer?: () => Wallet | HDNodeWallet) {
    if (
      this.db
        .all<{ id: string; chainId: number; wallet: string; status: string }>(
          "wallet-reservation",
        )
        .some(
          (r) =>
            r.chainId === this.chainId &&
            r.wallet === row.sender.toLowerCase() &&
            r.status === "RESERVED" &&
            r.id !== row.reservationId,
        )
    ) {
      this.defer(row, "WALLET_FUNDS_RESERVED", true);
      return;
    }
    if (
      row.reservationId &&
      this.db.get<{ status: string }>("wallet-reservation", row.reservationId)
        ?.status !== "RESERVED"
    ) {
      this.defer(row, "RESERVATION_TERMINAL", true);
      return;
    }
    if ((await this.provider.getNetwork()).chainId !== BigInt(this.chainId))
      throw Error("wrong chain");
    if (await this.receipt(row)) return;
    let halfOpen = false;
    const m = this.meta(row),
      tx = Transaction.from(row.raw);
    const latestNonce = await this.provider.getTransactionCount(
      row.sender,
      "latest",
    );
    if (latestNonce > tx.nonce) {
      this.defer(row, "NONCE_CONSUMED", true);
      return;
    }
    if (m.isolated) {
      if (Date.now() < m.nextAt) return;
      if (["NONCE_CONSUMED", "CANONICAL_RECEIPT_MISSING"].includes(m.reason)) {
        // Canonical rollback can make the originally authorized bytes usable again.
        // Require both nonce views to show this exact nonce free, and no local competing intent.
        if (
          latestNonce !== tx.nonce ||
          this.otherPending(row) ||
          (await this.provider.getTransactionCount(row.sender, "pending")) !==
            tx.nonce ||
          (await this.receipt(row))
        )
          return;
      }
      // Half-open probe reuses exact bytes, and lifetime fee/logical counters stay intact.
      halfOpen = true;
      m.isolated = false;
      m.attempts = 0;
      m.started = Date.now();
    }
    if (
      m.attempts >= (this.policy.maxAttempts ?? 12) ||
      Date.now() - m.started >= (this.policy.deadlineMs ?? 3600000)
    ) {
      this.defer(row, "RETRY_EXHAUSTED", true);
      m.nextAt = Date.now() + (this.policy.cooldownMs ?? 60000);
      this.save(row);
      return;
    }
    let replacementFee: bigint | undefined;
    const replacementRequest = { to: tx.to, data: tx.data, value: tx.value };
    const binding = row.reservationId
      ? this.db.get<{ validUntil: number }>(
          "wallet-reservation-binding",
          row.id,
        )
      : undefined;
    if (
      (!row.reservationId || (binding && binding.validUntil > Date.now())) &&
      !halfOpen &&
      signer &&
      m.attempts >= (this.policy.bumpAfterAttempts ?? 3) &&
      m.feeBumps < (this.policy.maxFeeBumps ?? 0)
    ) {
      const fee = ((tx.gasPrice ?? 0n) * 1125n + 999n) / 1000n;
      if (
        fee <= BigInt(this.policy.maxGasPriceWei ?? "0") &&
        (row.maxFeeWei === undefined ||
          fee * tx.gasLimit <= BigInt(row.maxFeeWei))
      ) {
        this.checkSigning(
          this.db,
          this.chainId,
          row.id,
          row.sender,
          replacementRequest,
          fee * tx.gasLimit,
          Date.now(),
        );
        const w = signer();
        if (w.address.toLowerCase() !== row.sender.toLowerCase())
          throw Error("signer mismatch");
        const raw = await w.signTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          gasPrice: fee,
          type: 0,
          chainId: this.chainId,
        });
        row.hashes = [
          ...new Set([...(row.hashes ?? []), row.hash, keccak256(raw)]),
        ];
        row.raw = raw;
        row.hash = keccak256(raw);
        m.feeBumps++;
        replacementFee = fee * tx.gasLimit;
      }
    }
    m.attempts++;
    this.db.transaction(() => {
      if (replacementFee !== undefined)
        this.checkSigning(
          this.db,
          this.chainId,
          row.id,
          row.sender,
          replacementRequest,
          replacementFee,
          Date.now(),
        );
      this.defer(row, "PENDING"); // durable attempt/bytes before touching transport
    });
    try {
      this.fence(row.sender);
      await this.provider.broadcastTransaction(row.raw);
    } catch (e) {
      const code = (e as { code?: string }).code;
      this.defer(
        row,
        code === "INSUFFICIENT_FUNDS"
          ? "INSUFFICIENT_FUNDS"
          : "RPC_UNAVAILABLE",
      );
      throw Error(
        code === "INSUFFICIENT_FUNDS"
          ? "insufficient funds"
          : "network transaction unavailable",
      );
    }
  }
  private async reconcile(
    row: TxRecord,
    confirmations: number,
  ): Promise<boolean> {
    const r = await this.receipt(row);
    if (!r || (await r.confirmations()) < confirmations) return false;
    const changed = row.state !== (r.status === 1 ? "CONFIRMED" : "REVERTED");
    row.state = r.status === 1 ? "CONFIRMED" : "REVERTED";
    row.hash = r.hash ?? row.hash;
    row.block = r.blockNumber;
    row.blockHash = r.blockHash;
    if (changed && row.state === "REVERTED")
      this.defer(row, "REVERTED_UNPROVEN", true);
    else this.save(row);
    return true;
  }
  async terminal(
    id: string,
    confirmations: number,
  ): Promise<"CONFIRMED" | "REVERTED" | undefined> {
    const old = this.db.get<TxRecord>("transaction", id);
    if (!old) return undefined;
    const owner = this.acquire(old.sender);
    try {
      const row = this.db.get<TxRecord>("transaction", id)!;
      if (!(await this.reconcile(row, confirmations))) return undefined;
      return row.state === "REVERTED" ? "REVERTED" : "CONFIRMED";
    } finally {
      this.release(old.sender, owner);
    }
  }
  async confirmed(id: string, confirmations: number): Promise<boolean> {
    const state = await this.terminal(id, confirmations);
    if (state === "REVERTED") throw Error("transaction reverted");
    return state === "CONFIRMED";
  }
  async recover(confirmations: number) {
    // Commit selection before RPC so concurrent callers and restarted processes
    // continue the rotation. Failed/locked rows return automatically on its next lap.
    const selected = this.db.transaction(() => {
      const key = String(this.chainId);
      const cursor =
        this.db.get<{ ready?: string; terminal?: string }>(
          "transaction-recovery-cursor",
          key,
        ) ?? {};
      const rows = this.db.all<TxRecord>("transaction");
      const ready = rows.filter((t) => t.state === "READY");
      const terminal = rows.filter((t) => t.state !== "READY");
      const batchSize = this.policy.recoveryBatchSize ?? 16;
      const auditSize = Math.min(
        terminal.length,
        this.policy.terminalAuditBatchSize ?? 4,
        ready.length ? batchSize - 1 : batchSize,
      );
      const rotate = (
        group: TxRecord[],
        after: string | undefined,
        count: number,
      ) => {
        const start =
          after === undefined ? 0 : group.findIndex((t) => t.id > after);
        const offset = start < 0 ? 0 : start;
        return [...group.slice(offset), ...group.slice(0, offset)].slice(
          0,
          count,
        );
      };
      const pendingBatch = rotate(ready, cursor.ready, batchSize - auditSize);
      const auditBatch = rotate(terminal, cursor.terminal, auditSize);
      this.db.put("transaction-recovery-cursor", key, {
        ready: pendingBatch.at(-1)?.id ?? cursor.ready,
        terminal: auditBatch.at(-1)?.id ?? cursor.terminal,
      });
      return [...pendingBatch, ...auditBatch];
    });
    for (const old of selected) {
      let owner: string;
      try {
        owner = this.acquire(old.sender);
      } catch {
        continue;
      }
      try {
        const t = this.db.get<TxRecord>("transaction", old.id)!;
        if (await this.reconcile(t, confirmations)) continue;
        if (t.state === "CONFIRMED" || t.state === "REVERTED") {
          t.state = "READY";
          this.defer(t, "CANONICAL_RECEIPT_MISSING", true);
          continue;
        }
        if (!this.enabled || Date.now() < (t.recovery?.nextAt ?? 0)) continue;
        await this.retry(t);
      } catch {
        const current = this.db.get<TxRecord>("transaction", old.id);
        if (current) {
          try {
            this.fence(current.sender);
            if (current.recovery?.reason !== "RETRY_EXHAUSTED")
              this.defer(
                current,
                current.recovery?.reason === "INSUFFICIENT_FUNDS"
                  ? "INSUFFICIENT_FUNDS"
                  : "RPC_UNAVAILABLE",
                current.recovery?.isolated ?? false,
              );
          } catch {
            /* Lease lost: no stale writes. */
          }
        }
      } finally {
        this.release(old.sender, owner);
      }
    }
  }
  reserved(sender: string, observedHeight = Number.POSITIVE_INFINITY) {
    return this.db
      .all<TxRecord>("transaction")
      .filter(
        (t) =>
          t.sender.toLowerCase() === sender.toLowerCase() &&
          (t.state === "READY" ||
            (t.state === "CONFIRMED" &&
              (t.block === undefined || t.block > observedHeight))),
      )
      .reduce((s, t) => {
        const tx = Transaction.from(t.raw);
        return s + tx.value + tx.gasLimit * (tx.gasPrice ?? 0n);
      }, 0n);
  }
}
