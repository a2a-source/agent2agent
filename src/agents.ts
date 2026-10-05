import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { WalletVault } from "./wallet.js";
export const tokenInput = z
  .object({
    name: z.string().trim().min(1).max(64),
    symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
    meta: z.string().min(1).max(256),
  })
  .strict();
export interface Agent {
  id: string;
  owner: string;
  wallet: string;
  name: string;
  symbol: string;
  meta: string;
  token?: string;
  splitter?: string;
  launch: "PENDING" | "CONFIRMED" | "FAILED";
  autoStake: boolean;
  jailed: boolean;
  createdAt: number;
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export class Agents {
  constructor(
    readonly db: Store,
    readonly vault: WalletVault,
  ) {}
  createUser(name: string) {
    if (!name.trim() || name.length > 100) throw Error("invalid name");
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    this.db.insert("user", digest(token), { id, name });
    return { id, name, token };
  }
  authenticate(token: string) {
    return this.db.get<{ id: string; name: string }>("user", digest(token));
  }
  create(owner: string, key: string, input: unknown): Agent {
    if (!key || key.length > 128) throw Error("invalid idempotency key");
    const data = tokenInput.parse(input),
      fingerprint = digest(JSON.stringify(data)),
      request = digest(owner + ":" + key);
    return this.db.transaction(() => {
      const old = this.db.get<{ id: string; fingerprint: string }>(
        "launch-request",
        request,
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw Error("idempotency conflict");
        return this.get(old.id);
      }
      const id = randomUUID(),
        wallet = this.vault.create();
      const agent: Agent = {
        id,
        owner,
        ...data,
        wallet: wallet.address,
        launch: "PENDING",
        autoStake: true,
        jailed: false,
        createdAt: Date.now(),
      };
      this.db.insert("wallet", id, wallet);
      this.db.insert("agent", id, agent);
      this.db.insert("launch-request", request, { id, fingerprint });
      return agent;
    });
  }
  get(id: string): Agent {
    const a = this.db.get<Agent>("agent", id);
    if (!a) throw Error("agent not found");
    return a;
  }
  list(owner?: string) {
    return this.db
      .all<Agent>("agent")
      .filter((a) => !owner || a.owner === owner);
  }
  update(
    id: string,
    change: Partial<
      Pick<Agent, "autoStake" | "jailed" | "token" | "splitter" | "launch">
    >,
  ) {
    return this.db.transaction(() => {
      const a = { ...this.get(id), ...change };
      this.db.put("agent", id, a);
      return a;
    });
  }
}
