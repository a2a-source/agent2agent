import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Agents } from "./agents.js";
import { Budget } from "./budget.js";
import { Epochs } from "./epochs.js";
import { nodeStatus, uint } from "./money.js";
import type { Watcher, ChainState } from "./watcher.js";
import type { FlapLauncher } from "./flap.js";
import type { Penalties } from "./penalties.js";
interface Services {
  agents: Agents;
  budget: Budget;
  epochs: Epochs;
  adminToken: string;
  watcher?: Watcher;
  launcher?: FlapLauncher;
  penalties?: Penalties;
  tick?: () => Promise<void>;
  minimumCompute?: bigint | (() => bigint | undefined);
  stateMaxAgeMs?: number;
}
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req: IncomingMessage) {
  let n = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    n += c.length;
    if (n > 131072) throw Error("request too large");
    parts.push(c);
  }
  return JSON.parse(Buffer.concat(parts).toString() || "{}");
}
export function createApi(s: Services) {
  if (s.adminToken.length < 24)
    throw Error("admin token must contain at least 24 characters");
  return createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost"),
        path = url.pathname;
      if (path === "/health" && req.method === "GET") {
        send(200, { status: "ok", version: "0.1.0" });
        return;
      }
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        admin = equal(token, s.adminToken),
        user = admin ? undefined : s.agents.authenticate(token);
      if (!admin && !user) {
        send(401, { error: "authentication required" });
        return;
      }
      if (path.startsWith("/admin/") && !admin) {
        send(403, { error: "admin required" });
        return;
      }
      if (path === "/admin/users" && req.method === "POST") {
        send(
          201,
          s.agents.createUser(
            z
              .object({ name: z.string() })
              .strict()
              .parse(await body(req)).name,
          ),
        );
        return;
      }
      if (path === "/agents" && req.method === "POST") {
        if (!user) {
          send(403, { error: "user token required" });
          return;
        }
        send(
          201,
          s.agents.create(
            user.id,
            String(req.headers["idempotency-key"] ?? ""),
            await body(req),
          ),
        );
        return;
      }
      const present = (a: ReturnType<Agents["get"]>) => {
        const state = s.agents.db.get<ChainState>("chain-state", a.id),
          available = s.budget.available(a.id);
        const known =
          state?.known &&
          Date.now() - state.observedAt <= (s.stateMaxAgeMs ?? 120000);
        return {
          ...a,
          computeAvailableWei: String(available),
          chainState: state,
          status: known
            ? nodeStatus(
                (() => {
                  const min =
                    typeof s.minimumCompute === "function"
                      ? s.minimumCompute()
                      : (s.minimumCompute ?? 1n);
                  return min !== undefined && available >= min ? available : 0n;
                })(),
                BigInt(state.bonded),
                a.jailed,
              )
            : "CHAIN_UNKNOWN",
        };
      };
      if (path === "/agents" && req.method === "GET") {
        send(200, s.agents.list(user?.id).map(present));
        return;
      }
      const match = path.match(
        /^\/agents\/([^/]+)(?:\/(exit|withdraw|launch))?$/,
      );
      if (match) {
        let a;
        try {
          a = s.agents.get(match[1]!);
        } catch {
          send(404, { error: "not found" });
          return;
        }
        if (!admin && a.owner !== user!.id) {
          send(404, { error: "not found" });
          return;
        }
        if (!match[2] && req.method === "GET") {
          send(200, present(a));
          return;
        }
        if (req.method === "POST" && match[2] === "launch") {
          if (!s.launcher) {
            send(503, { error: "chain integration not configured" });
            return;
          }
          send(202, await s.launcher.advance(a.id));
          return;
        }
        if (
          req.method === "POST" &&
          (match[2] === "exit" || match[2] === "withdraw")
        ) {
          if (!s.watcher) {
            send(503, { error: "chain integration not configured" });
            return;
          }
          const tx = await s.watcher.exit(a.id, match[2] === "withdraw");
          send(202, { hash: tx.hash, state: tx.state });
          return;
        }
      }
      if (path === "/network/epochs" && req.method === "GET") {
        send(200, s.agents.db.all("epoch"));
        return;
      }
      if (path === "/admin/compute/credit" && req.method === "POST") {
        const b = z
          .object({
            agent: z.string(),
            reference: z.string().min(1),
            amountWei: z.string(),
          })
          .strict()
          .parse(await body(req));
        s.agents.get(b.agent);
        s.budget.credit(b.agent, `manual:${b.reference}`, uint(b.amountWei));
        send(200, { availableWei: String(s.budget.available(b.agent)) });
        return;
      }
      if (path === "/admin/compute/reconcile" && req.method === "POST") {
        const b = z
          .object({ callId: z.string(), actualWei: z.string() })
          .strict()
          .parse(await body(req));
        s.budget.settle(b.callId, uint(b.actualWei));
        send(200, { reconciled: true });
        return;
      }
      if (path === "/admin/tick" && req.method === "POST") {
        if (!s.tick) {
          send(503, { error: "scheduler not configured" });
          return;
        }
        await s.tick();
        send(200, { processed: true });
        return;
      }
      if (path === "/admin/unjail" && req.method === "POST" && s.penalties) {
        const b = z
          .object({ agent: z.string() })
          .strict()
          .parse(await body(req));
        s.penalties.release(b.agent);
        send(200, { released: true });
        return;
      }
      if (path === "/admin/evidence" && req.method === "POST" && s.penalties) {
        const b = z
          .object({
            first: z.unknown(),
            signature1: z.string(),
            second: z.unknown(),
            signature2: z.string(),
          })
          .strict()
          .parse(await body(req));
        send(
          200,
          s.penalties.evidence(b.first, b.signature1, b.second, b.signature2),
        );
        return;
      }
      send(404, { error: "not found" });
    } catch (e) {
      const validation = e instanceof z.ZodError;
      send(400, {
        error: validation ? "invalid request" : "operation rejected",
        ...(validation
          ? { fields: e.issues.map((x) => x.path.join(".")) }
          : {}),
      });
    }
  });
}
