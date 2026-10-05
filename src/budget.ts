import { Store } from "./store.js";
import { uint } from "./money.js";
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
    return BigInt(a.balance) - BigInt(a.reserved);
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
