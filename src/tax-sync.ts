import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { Agent, Agents } from "./agents.js";
import { Budget, type ChainCredit } from "./budget.js";
import type { Journal } from "./chain.js";
interface Cursor {
  height: number;
  hash: string;
}
interface Scan {
  id: string;
  target: Cursor;
  next: number;
  full: boolean;
  base?: Cursor;
}
/** Durable bounded scans. Income becomes spendable only after the snapshot is verified. */
export class TaxSync {
  private iface = new Interface([
    "event PlatformPaid(uint256 amount,uint256 compute)",
  ]);
  constructor(
    readonly agents: Agents,
    readonly budget: Budget,
    readonly journal: Journal,
    readonly fromBlock: number,
    readonly pagesPerTick = 4,
  ) {}
  private discard(agent: string, scan: Scan) {
    this.agents.db.transaction(() => {
      for (const row of this.agents.db.entries<ChainCredit>("tax-scan-receipt"))
        if (row.id.startsWith(`${scan.id}:`))
          this.agents.db.remove("tax-scan-receipt", row.id);
      this.agents.db.remove("tax-scan", agent);
    });
  }
  private freeze(agent: string) {
    this.budget.setChainSync(agent, true);
    const old = this.agents.db.get<any>("chain-state", agent);
    this.agents.db.put("chain-state", agent, { ...old, known: false });
  }
  async sync(agent: Agent, target: Cursor): Promise<boolean> {
    const db = this.agents.db,
      p = this.journal.provider;
    if (!agent.splitter) {
      this.budget.setChainSync(agent.id, false);
      return true;
    }
    let cursor = db.get<Cursor>("cursor", agent.id);
    if (cursor && target.height < cursor.height) {
      this.freeze(agent.id);
      return false;
    }
    const version = db.get("tax-index-version", agent.id);
    const reorg =
      !!cursor && (await p.getBlock(cursor.height))?.hash !== cursor.hash;
    let scan = db.get<Scan>("tax-scan", agent.id);
    if (
      scan &&
      ((await p.getBlock(scan.target.height))?.hash !== scan.target.hash ||
        (reorg && !scan.full))
    ) {
      this.discard(agent.id, scan);
      scan = undefined;
    }
    if (!scan) {
      const full = !cursor || !version || reorg;
      if (!full && cursor!.height >= target.height) {
        this.budget.setChainSync(agent.id, false);
        return true;
      }
      scan = {
        id: randomUUID(),
        target,
        next: full ? this.fromBlock : cursor!.height + 1,
        full,
        base: cursor,
      };
      if (full) this.freeze(agent.id);
      db.put("tax-scan", agent.id, scan);
    }
    if (scan.full) this.freeze(agent.id);
    let pages = 0;
    while (scan.next <= scan.target.height && pages++ < this.pagesPerTick) {
      const end = Math.min(scan.next + 999, scan.target.height);
      const logs = await p.getLogs({
        address: agent.splitter,
        fromBlock: scan.next,
        toBlock: end,
        topics: [this.iface.getEvent("PlatformPaid")!.topicHash],
      });
      const hashes = new Map<number, string>();
      const receipts: ChainCredit[] = [];
      for (const log of logs) {
        if (
          log.removed ||
          log.blockNumber < scan.next ||
          log.blockNumber > end ||
          log.address.toLowerCase() !== agent.splitter.toLowerCase()
        )
          throw Error("invalid tax log");
        if (!hashes.has(log.blockNumber)) {
          const block = await p.getBlock(log.blockNumber);
          if (!block?.hash) throw Error("tax block unavailable");
          hashes.set(log.blockNumber, block.hash);
        }
        if (log.blockHash !== hashes.get(log.blockNumber))
          throw Error("tax log changed during scan");
        const parsed = this.iface.parseLog(log)!;
        receipts.push({
          source: `${this.journal.chainId}:${log.transactionHash}:${log.index}`,
          amount: String(parsed.args.compute),
          block: log.blockNumber,
          blockHash: log.blockHash,
        });
      }
      db.transaction(() => {
        for (const receipt of receipts)
          db.put("tax-scan-receipt", `${scan!.id}:${receipt.source}`, receipt);
        scan!.next = end + 1;
        db.put("tax-scan", agent.id, scan);
      });
    }
    if (scan.next <= scan.target.height) return false;
    if (
      (await p.getBlock(scan.target.height))?.hash !== scan.target.hash ||
      (!scan.full &&
        scan.base &&
        (await p.getBlock(scan.base.height))?.hash !== scan.base.hash)
    ) {
      this.freeze(agent.id);
      this.discard(agent.id, scan);
      return false;
    }
    const completed = scan;
    db.transaction(() => {
      const receipts = db
        .entries<ChainCredit>("tax-scan-receipt")
        .filter((row) => row.id.startsWith(`${completed.id}:`))
        .map((row) => row.data);
      if (completed.full)
        this.budget.reconcileChain(agent.id, this.journal.chainId, receipts);
      else
        for (const receipt of receipts)
          this.budget.creditChain(agent.id, this.journal.chainId, receipt);
      db.put("cursor", agent.id, completed.target);
      db.put("tax-index-version", agent.id, { version: 1 });
      db.put("tax-recovery", agent.id, {
        status: "SYNCED",
        height: completed.target.height,
        reconciled: completed.full,
      });
      this.discard(agent.id, completed);
      this.budget.setChainSync(agent.id, false);
    });
    return true;
  }
}
