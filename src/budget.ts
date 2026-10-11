import { Store } from "./store.js";
import { uint } from "./money.js";
export interface ChainCredit {
  source: string;
  amount: string;
  block: number;
  blockHash: string;
}
interface Credit {
  agent: string;
  amount: string;
  active?: boolean;
  chainId?: number;
  block?: number;
  blockHash?: string;
}
interface Account {
  balance: string;
  reserved: string;
}
export interface Reservation {
  id: string;
  agent: string;
  maximum: string;
  state: "RESERVED" | "SETTLED" | "UNKNOWN";
  actual?: string;
}
export class Budget {
  constructor(readonly db: Store) {}
  account(agent: string): Account {
    return (
      this.db.get<Account>("balance", agent) ?? { balance: "0", reserved: "0" }
    );
  }
  available(agent: string) {
    const a = this.account(agent);
    const available = BigInt(a.balance) - BigInt(a.reserved);
    return this.db.get<{ frozen: boolean }>("budget-chain-sync", agent)
      ?.frozen && available > 0n
      ? 0n
      : available;
  }
  setChainSync(agent: string, frozen: boolean) {
    this.db.put("budget-chain-sync", agent, { frozen });
  }
  /** Replace only this agent/network's tax receipts, retaining actual costs and holds. */
  reconcileChain(agent: string, chainId: number, receipts: ChainCredit[]) {
    if (!Number.isSafeInteger(chainId) || chainId < 1)
      throw Error("invalid chain");
    const prefix = `${chainId}:`,
      canonical = new Map<string, ChainCredit>();
    for (const receipt of receipts) {
      uint(receipt.amount);
      if (
        !receipt.source.startsWith(prefix) ||
        canonical.has(receipt.source) ||
        !Number.isSafeInteger(receipt.block) ||
        receipt.block < 0 ||
        !receipt.blockHash
      )
        throw Error("invalid chain receipt");
      canonical.set(receipt.source, receipt);
    }
    this.db.transaction(() => {
      let before = 0n,
        after = 0n;
      const old = this.db
        .entries<Credit>("credit")
        .filter((row) => row.data.agent === agent && row.id.startsWith(prefix));
      for (const row of old) {
        if (row.data.active !== false) before += BigInt(row.data.amount);
        if (!canonical.has(row.id))
          this.db.put("credit", row.id, { ...row.data, active: false });
      }
      for (const [id, receipt] of canonical) {
        const existing = this.db.get<Credit>("credit", id);
        if (existing && existing.agent !== agent)
          throw Error("chain receipt ownership conflict");
        after += BigInt(receipt.amount);
        this.db.put("credit", id, {
          agent,
          amount: receipt.amount,
          active: true,
          chainId,
          block: receipt.block,
          blockHash: receipt.blockHash,
        });
      }
      const account = this.account(agent);
      this.db.put("balance", agent, {
        ...account,
        balance: String(BigInt(account.balance) + after - before),
      });
      this.db.put("budget-reconciliation", `${agent}:${chainId}`, {
        agent,
        chainId,
        removedOrAddedWei: String(after - before),
        balanceWei: this.account(agent).balance,
        at: Date.now(),
      });
    });
  }
  creditChain(agent: string, chainId: number, receipt: ChainCredit) {
    if (!receipt.source.startsWith(`${chainId}:`))
      throw Error("invalid chain receipt");
    this.db.transaction(() => {
      const prior = this.db.get<Credit>("credit", receipt.source);
      if (prior?.active === false)
        throw Error("orphaned receipt requires reconciliation");
      this.credit(agent, receipt.source, uint(receipt.amount));
      this.db.put("credit", receipt.source, {
        agent,
        amount: receipt.amount,
        active: true,
        chainId,
        block: receipt.block,
        blockHash: receipt.blockHash,
      });
    });
  }
  credit(agent: string, source: string, amount: bigint) {
    uint(amount);
    this.db.transaction(() => {
      const prior = this.db.get<{ agent: string; amount: string }>(
        "credit",
        source,
      );
      if (prior) {
        if (prior.agent !== agent || prior.amount !== String(amount))
          throw Error("credit conflict");
        return;
      }
      const a = this.account(agent);
      this.db.put("balance", agent, {
        ...a,
        balance: String(BigInt(a.balance) + amount),
      });
      this.db.insert("credit", source, { agent, amount: String(amount) });
    });
  }
  reserve(agent: string, id: string, maximum: bigint) {
    uint(maximum);
    if (maximum === 0n) throw Error("zero budget");
    return this.db.transaction(() => {
      const old = this.db.get<Reservation>("reservation", id);
      if (old) {
        if (old.agent !== agent || old.maximum !== String(maximum))
          throw Error("reservation conflict");
        return old;
      }
      if (this.available(agent) < maximum)
        throw Error("insufficient compute budget");
      const a = this.account(agent),
        r: Reservation = {
          id,
          agent,
          maximum: String(maximum),
          state: "RESERVED",
        };
      this.db.put("balance", agent, {
        ...a,
        reserved: String(BigInt(a.reserved) + maximum),
      });
      this.db.insert("reservation", id, r);
      return r;
    });
  }
  unknown(id: string) {
    const r = this.db.get<Reservation>("reservation", id);
    if (!r || r.state === "SETTLED") return;
    this.db.put("reservation", id, { ...r, state: "UNKNOWN" });
  }
  settle(id: string, actual: bigint) {
    uint(actual);
    this.db.transaction(() => {
      const r = this.db.get<Reservation>("reservation", id);
      if (!r) throw Error("reservation not found");
      if (r.state === "SETTLED") {
        if (r.actual !== String(actual)) throw Error("settlement conflict");
        return;
      }
      if (actual > BigInt(r.maximum)) throw Error("cost exceeds reservation");
      const a = this.account(r.agent);
      this.db.put("balance", r.agent, {
        balance: String(BigInt(a.balance) - actual),
        reserved: String(BigInt(a.reserved) - BigInt(r.maximum)),
      });
      this.db.put("reservation", id, {
        ...r,
        state: "SETTLED",
        actual: String(actual),
      });
    });
  }
}
