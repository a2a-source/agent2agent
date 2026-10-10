# Automatic investment reference planning

The service can automatically turn a committee-confirmed, published QSP containing an explicit `stableNetworkAllocation` into independent registered-wallet reference plans. This path performs no LLM calls, signs no transactions and spends no funds. Qualifying Workers do not need individual opt-in. The separate [automatic execution coordinator](automatic-investment-execution.md) consumes READY plans when enabled.

## Configuration

`investmentPlanning` in `config/default.json` is disabled by default. Enable it only with an explicitly verified `registry` matching `chain.id` and a configured chain RPC. The registry format and confirmed-block collection rules are documented in [stable wallet plans](stable-wallet-plans.md). No asset addresses or price feeds are inferred. Signed stable-allocation evidence supports the recognized BSC mainnet asset universe and explicitly committed [BSC97 test profiles](research-testnet-profile.md). A testnet registry alone does not make a mainnet QSP valid on testnet.

Defaults are three attempts, 30-second initial retry delay, 120-second lease, and at most four claimed jobs per background tick. Attempts are capped at ten; retry and lease durations at one day; jobs per tick at 32. Failed attempts retry exponentially, bounded by the package's evidence deadline. Changing the registry, risk policy or planning options fails outstanding jobs with `PLANNING_CONFIG_CHANGED`; subsequent eligible epochs use the new configuration.

The Scheduler starts planning after maintenance, independently of LLM provider health, with one background task at a time. Planning does not block research or elections. Collection waits are bounded by the lease or package deadline, whichever comes first. Shutdown drains the current planning task before database/provider disposal. This bounds the coordinator wait; it does not cancel an underlying RPC already in flight. Late read results cannot consume QSP.

## Durable lifecycle

The first eligible discovery freezes the registered Agent roster for that epoch; later-joining Agents enter subsequent epochs. Each roster member gets one durable job. Before RPC reads, each attempt checks confirmed launch, wallet identity, jail/exit/auto-stake state, fresh chain observations, the 0.3 BNB bond, available compute budget, and local pending transactions/sender locks. Ineligible or busy wallets retry within the same bounded policy. Exhausted or expired jobs are terminal; a subsequent epoch can create new jobs.

The collector records balances and oracle observations at a confirmed block. The consumer revalidates QSP signatures, deadlines, wallet qualification, asset identities and pending local transactions before atomically storing the reference plan and job completion. See [confirmed stable QSP](confirmed-stable-qsp.md) for verification rules.

| Record kind | Contents |
| --- | --- |
| `investment-planning-epoch` | Eligibility or skip outcome for discovered published epochs |
| `investment-planning-job` | Epoch, Agent, frozen wallet/configuration, deadline, attempts, lease and final plan |
| `investment-planning-attempt` | Attempt identity, capture identity, timestamps and outcome |
| `investment-planning-check` | Qualification inputs, compute balance, local pending transactions and sender lock |
| `portfolio-capture`, portfolio observations/snapshot | Confirmed-block collection process and results |
| `stable-qsp-consumption`, `stable-wallet-plan` | Verified consumption decision and immutable wallet plan |

The existing SQLite history also retains record transitions. After a restart, an expired lease can be reclaimed; its old attempt becomes `UNKNOWN`. Ownership checks prevent late results from that attempt consuming QSP or overwriting the successor. An already committed consumption can be linked back to its job without another RPC read. Each retry has a separate capture identity.

## Execution boundary

These are reference plans only. Collection currently passes zero investment reservations after checking the local Journal. This is not proof of absence of external pending transactions and is not a canonical fund lock. Registry completeness, stablecoin/depeg rules, onchain nonce reconciliation, fund reservations, DEX quotes, transaction execution/receipts and realized-profit accounting remain separate execution work. A successful job can produce `NO_ACTION` or a blocked reference plan; `DONE` does not mean a trade occurred.

An internal [wallet reservation ledger](wallet-reservations.md) now provides actual-unit exclusion and settlement boundaries for the forthcoming execution adapter. Automatic planning still uses zero reservation inputs; the ledger is not yet integrated into this service path.
