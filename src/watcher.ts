import { Contract, Interface, Transaction } from "ethers";
import { Agents } from "./agents.js";
import { Budget } from "./budget.js";
import { TaxSync } from "./tax-sync.js";
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
    readonly scanPagesPerTick = 4,
  ) {}
  async tick(now = Date.now()) {
    const p = this.journal.provider;
    if ((await p.getNetwork()).chainId !== BigInt(this.journal.chainId))
      throw Error("wrong chain");
    const height = (await p.getBlockNumber()) - this.confirmations + 1;
    if (height < 0) return;
    const block = await p.getBlock(height);
    if (!block?.hash) throw Error("confirmed block unavailable");
    const stake = new Contract(this.stakeAddress, STAKE_ABI, p);
    const sync = new TaxSync(
      this.agents,
      this.budget,
      this.journal,
      this.fromBlock,
      this.scanPagesPerTick,
    );
    for (const a of this.agents.list()) {
      try {
        if (!(await sync.sync(a, { height, hash: block.hash }))) continue;
        const launch = this.agents.db.get<TxRecord>(
          "transaction",
          `launch:${a.id}`,
        );
        if (
          a.launch === "CONFIRMED" &&
          launch &&
          (launch.state !== "CONFIRMED" ||
            launch.block === undefined ||
            launch.block > height)
        )
          throw Error("launch confirmation unavailable");
        const [balance, bonded, exit] = await Promise.all([
          p.getBalance(a.wallet, height),
          stake.getFunction("bonded")(a.wallet, { blockTag: height }),
          stake.getFunction("exits")(a.wallet, { blockTag: height }),
        ]);
        if ((await p.getBlock(height))?.hash !== block.hash)
          throw Error("balance snapshot changed");
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
        if (previous?.state === "CONFIRMED") {
          round++;
          this.agents.db.put("stake-round", a.id, { sequence: round });
          previous = undefined;
        }
        if (
          previous?.state === "READY" &&
          a.autoStake &&
          !a.jailed &&
          this.journal.enabled
        ) {
          const tx = Transaction.from(previous.raw),
            record = this.agents.db.get<EncryptedWallet>("wallet", a.id)!;
          await this.journal.send(
            previous.id,
            a.wallet,
            () => this.agents.vault.withWallet(record, (w) => w),
            { to: tx.to, value: tx.value, data: tx.data },
          );
          continue;
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
            {
              confirmations: this.confirmations,
              safeRetry: async () => {
                const [currentBonded, currentExit] = await Promise.all([
                  stake.getFunction("bonded")(a.wallet),
                  stake.getFunction("exits")(a.wallet),
                ]);
                return (
                  currentBonded === bonded &&
                  currentExit[0] === 0n &&
                  this.agents.get(a.id).autoStake
                );
              },
            },
          );
          await this.journal.confirmed(id, this.confirmations);
        }
      } catch (e) {
        this.budget.setChainSync(a.id, true);
        const old = this.agents.db.get<ChainState>("chain-state", a.id);
        this.agents.db.put("chain-state", a.id, {
          ...old,
          known: false,
          observedAt: now,
        });
        this.agents.db.put("chain-error", a.id, {
          at: now,
          message: "CHAIN_SYNC_OR_OPERATION_PENDING",
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
