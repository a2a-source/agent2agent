import { Contract, Interface } from "ethers";
import { Agents } from "./agents.js";
import { Budget } from "./budget.js";
import { Journal, type TxRecord } from "./chain.js";
import { stakeDeficit } from "./money.js";
import type { EncryptedWallet } from "./wallet.js";
export const STAKE_ABI = [
  "function bonded(address) view returns(uint256)",
  "function exits(address) view returns(uint256 amount,uint256 unlockAt)",
  "function deposit() payable",
  "function requestExit()",
  "function withdraw()",
];
const SPLIT_ABI = ["event PlatformPaid(uint256 amount,uint256 compute)"];
export interface ChainState {
  balance: string;
  bonded: string;
  exit: string;
  block: number;
  hash: string;
  observedAt: number;
  known: boolean;
}
export class Watcher {
  constructor(
    readonly agents: Agents,
    readonly budget: Budget,
    readonly journal: Journal,
    readonly stakeAddress: string,
    readonly confirmations: number,
    readonly fromBlock: number,
    readonly gasReserve: bigint,
  ) {}
  async tick(now = Date.now()) {
    const p = this.journal.provider;
    if ((await p.getNetwork()).chainId !== BigInt(this.journal.chainId))
      throw Error("wrong chain");
    const height = (await p.getBlockNumber()) - this.confirmations + 1;
    if (height < 0) return;
    const block = await p.getBlock(height);
    if (!block?.hash) throw Error("confirmed block unavailable");
    const stake = new Contract(this.stakeAddress, STAKE_ABI, p),
      iface = new Interface(SPLIT_ABI);
    for (const a of this.agents.list()) {
      try {
        const cursor = this.agents.db.get<{ height: number; hash: string }>(
          "cursor",
          a.id,
        );
        if (cursor && (await p.getBlock(cursor.height))?.hash !== cursor.hash)
          throw Error("chain reorganization requires reconciliation");
        if (a.splitter) {
          let start = cursor ? cursor.height + 1 : this.fromBlock;
          while (start <= height) {
            const end = Math.min(start + 999, height),
              logs = await p.getLogs({
                address: a.splitter,
                fromBlock: start,
                toBlock: end,
                topics: [iface.getEvent("PlatformPaid")!.topicHash],
              });
            const endBlock = await p.getBlock(end);
            if (!endBlock?.hash) throw Error("missing log checkpoint");
            this.agents.db.transaction(() => {
              for (const l of logs) {
                if (l.removed) throw Error("removed log");
                const decoded = iface.parseLog(l)!;
                this.budget.credit(
                  a.id,
                  `${this.journal.chainId}:${l.transactionHash}:${l.index}`,
                  decoded.args.compute,
                );
              }
              this.agents.db.put("cursor", a.id, {
                height: end,
                hash: endBlock.hash,
              });
            });
            start = end + 1;
          }
        }
        const [balance, bonded, exit] = await Promise.all([
          p.getBalance(a.wallet, height),
          stake.getFunction("bonded")(a.wallet, { blockTag: height }),
          stake.getFunction("exits")(a.wallet, { blockTag: height }),
        ]);
        const state: ChainState = {
          balance: String(balance),
          bonded: String(bonded),
          exit: String(exit[0]),
          block: height,
          hash: block.hash,
          observedAt: now,
          known: true,
        };
        this.agents.db.put("chain-state", a.id, state);
        let round =
          this.agents.db.get<{ sequence: number }>("stake-round", a.id)
            ?.sequence ?? 0;
        let previous = this.agents.db.get<TxRecord>(
          "transaction",
          `stake:${a.id}:${round}`,
        );
        if (previous?.state === "READY") {
          await this.journal.confirmed(previous.id, this.confirmations);
          previous = this.agents.db.get<TxRecord>("transaction", previous.id);
        }
        // Never reuse a pre-deposit snapshot, even if the live head has advanced.
        if (
          previous?.state === "CONFIRMED" &&
          (previous.block === undefined || previous.block > height)
        )
          continue;
        if (previous && previous.state !== "READY") {
          round++;
          this.agents.db.put("stake-round", a.id, { sequence: round });
        }
        const deficit = stakeDeficit(
          balance,
          bonded,
          this.gasReserve,
          this.journal.reserved(a.wallet, height),
        );
        if (
          a.autoStake &&
          !a.jailed &&
          exit[0] === 0n &&
          deficit > 0n &&
          this.journal.enabled
        ) {
          const record = this.agents.db.get<EncryptedWallet>("wallet", a.id)!;
          const id = `stake:${a.id}:${round}`;
          await this.journal.send(
            id,
            a.wallet,
            () => this.agents.vault.withWallet(record, (w) => w),
            {
              to: this.stakeAddress,
              value: deficit,
              data: stake.interface.encodeFunctionData("deposit"),
            },
          );
          await this.journal.confirmed(id, this.confirmations);
        }
      } catch (e) {
        const old = this.agents.db.get<ChainState>("chain-state", a.id);
        this.agents.db.put("chain-state", a.id, {
          ...old,
          known: false,
          observedAt: now,
        });
        this.agents.db.put("chain-error", a.id, {
          at: now,
          message: e instanceof Error ? e.message : "chain error",
        });
      }
    }
  }
  async exit(id: string, withdraw = false) {
    const a = this.agents.get(id);
    this.agents.update(id, { autoStake: false });
    const record = this.agents.db.get<EncryptedWallet>("wallet", id)!;
    const nonce = await this.journal.provider.getTransactionCount(
      a.wallet,
      "pending",
    );
    const action = withdraw ? "withdraw" : "requestExit";
    return this.journal.send(
      `${action}:${id}:${nonce}`,
      a.wallet,
      () => this.agents.vault.withWallet(record, (w) => w),
      {
        to: this.stakeAddress,
        data: new Interface(STAKE_ABI).encodeFunctionData(action),
      },
    );
  }
}
