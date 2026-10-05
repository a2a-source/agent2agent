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
}
/** Persist signed bytes before broadcast. A transport timeout retries exactly those bytes. */
export class Journal {
  private busy = new Set<string>();
  constructor(
    readonly db: Store,
    readonly provider: AbstractProvider,
    readonly chainId: number,
    readonly enabled: boolean,
  ) {}
  async send(
    id: string,
    sender: string,
    signer: () => Wallet | HDNodeWallet,
    request: TransactionRequest,
  ): Promise<TxRecord> {
    if (!this.enabled) throw Error("chain writes disabled");
    if (this.busy.has(sender)) throw Error("sender busy");
    const lockKey = sender.toLowerCase(),
      owner = randomUUID();
    this.db.transaction(() => {
      const lock = this.db.get<{ owner: string; expires: number }>(
        "sender-lock",
        lockKey,
      );
      if (lock && lock.expires > Date.now()) throw Error("sender busy");
      this.db.put("sender-lock", lockKey, {
        owner,
        expires: Date.now() + 120000,
      });
    });
    this.busy.add(sender);
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
        if (row.state === "REVERTED") throw Error("transaction reverted");
        if (row.state === "CONFIRMED") return row;
      } else {
        if (
          this.db
            .all<TxRecord>("transaction")
            .some((t) => t.sender === sender && t.state === "READY")
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
          this.db.insert("transaction", id, row);
        });
      }
      const receipt = await this.provider.getTransactionReceipt(row.hash);
      if (!receipt) await this.provider.broadcastTransaction(row.raw);
      return row;
    } finally {
      this.busy.delete(sender);
      this.db.transaction(() => {
        if (
          this.db.get<{ owner: string }>("sender-lock", lockKey)?.owner ===
          owner
        )
          this.db.put("sender-lock", lockKey, { owner, expires: 0 });
      });
    }
  }
  async confirmed(id: string, confirmations: number): Promise<boolean> {
    const row = this.db.get<TxRecord>("transaction", id);
    if (!row) return false;
    const r = await this.provider.getTransactionReceipt(row.hash);
    if (!r) return false;
    if ((await r.confirmations()) < confirmations) return false;
    row.state = r.status === 1 ? "CONFIRMED" : "REVERTED";
    row.block = r.blockNumber;
    this.db.put("transaction", id, row);
    if (row.state === "REVERTED") throw Error("transaction reverted");
    return true;
  }
  async recover(confirmations: number) {
    for (const t of this.db
      .all<TxRecord>("transaction")
      .filter((t) => t.state === "READY")) {
      try {
        if (await this.confirmed(t.id, confirmations)) continue;
        if (
          this.enabled &&
          !(await this.provider.getTransactionReceipt(t.hash))
        )
          await this.provider.broadcastTransaction(t.raw);
      } catch {
        this.db.put("transaction-error", t.id, {
          id: t.id,
          at: Date.now(),
          reason: "RECOVERY_PENDING_OR_REVERTED",
        });
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
