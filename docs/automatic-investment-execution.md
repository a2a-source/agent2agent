# Automatic QSP wallet execution

The service can consume a confirmed explicit stable allocation, build independent Worker wallet plans, reserve actual token units and Gas, send exact ERC20 approvals and direct V2 swaps, reconcile receipts, and return persisted execution observations to subsequent research. No per-order user approval or manual signing is required. Node qualification and protocol checks run automatically before signing and again before signed bytes are saved.

Enable `investmentPlanning` with a verified asset/oracle registry, `chain.writesEnabled`, and `investmentExecution.enabled` with an explicit `dex` configuration. Public defaults disable chain writes and execution until deployment addresses are configured. This is deployment configuration, not a runtime approval queue.

`investmentExecution.dex` contains `chainId`, `router`, `factory`, `routerCodeHash`, `factoryCodeHash`, and `tokens`; optional `slippageBps` and `maxImpactBps` are capped at 50, and `quoteMaxAgeMs` is capped at 30,000. The asset registry and DEX must use the same chain. The executor supports one reserve ERC20 and one ERC20 per volatile underlying. BSC97 fixture assets require a signed [test profile](research-testnet-profile.md); mainnet assets are not silently remapped.

Other settings are `maxTransactionFeeWei` (default 0.0001 BNB per transaction), `retryMs` (5 seconds), `leaseMs` (120 seconds), and `maxJobsPerTick` (4). Actual ticks follow the service poll interval. Two transaction fee ceilings per order are reserved and checked against the economic Gas limit before any approval. Quote output is checked against oracle valuation as well as pool reserves. Buy risk budgets use the greater of input notional and quoted output valuation; execution prices can still move after quotation.

## Persisted lifecycle

Each READY plan has one deterministic execution job and one unit reservation. Its approval and swap IDs are deterministic and never reused for a new logical trade. Each step and error outcome is retained in SQLite, including record history. Plans remain immutable reference artifacts; execution status lives in separate records.

A valid NO_ACTION plan also gets an execution observation: the service revalidates the signed source and recomputes the plan, then collects a later confirmed closing snapshot without reserving funds or signing a transaction. This keeps unchanged holdings and verifiable zero-flow returns in the feedback loop. A failed wallet capture remains visible as missing coverage in the network observation.

The signing boundary verifies the committee certificate, source hashes, exact recomputed wallet plan, asset registry, QSP/evidence validity, current Worker bond and compute eligibility, and the current execution lease. Canonical source-block identity, live balances, allowances and nonces are checked before a new transaction. Concrete calldata, value, Gas ceiling and deadline are bound to the reservation. Private keys are obtained from the runtime vault only when Journal needs a signature.

An RPC timeout after broadcasting retains the original signed bytes. The Journal reconciles or rebroadcasts that intent instead of creating another trade. Once a signed intent exists, its receipt is checked even if the QSP later expires or the Worker loses eligibility. Such a change stops subsequent new trades. Failed or expired work reconciles a fresh confirmed balance snapshot before releasing its reservation; unknown pending transactions keep funds reserved. Subsequent QSP rounds can create new plans automatically.

The Scheduler runs execution independently of LLM availability and drains it on shutdown. Journal recovery processes at most 16 transactions per tick by default, including up to four terminal audits, with persistent round-robin cursors; it does not repeatedly scan every historical receipt over RPC. Disabling execution prevents fresh work and fresh signatures while allowing receipt reconciliation of existing work from persisted deployment settings, even when new planning is disabled (the original chain RPC must remain configured). Process leases and sender leases prevent stale workers from persisting new signed bytes.

Recovery reads each job's original, hash-verified deployment settings for its asset registry, confirmation count and closing-snapshot Gas reserve. Changing deployment settings cannot silently reduce the confirmations required for existing work or strand its closing observation behind a newly increased Gas reserve. Use a separate database for each chain deployment; the execution queue also refuses jobs belonging to another chain.

## Accounting and subsequent research

Final wallet observations bind opening/closing snapshots, fills, job and plan. Network observations retain the expected planning-wallet roster, including wallets with unavailable execution observations. The next research context includes the latest completed round's wallet holdings, NAV observations, actual fill references and accounting quality. See [execution feedback](execution-feedback.md).

NAV change is not automatically profit. The automatic executor proves a zero-external-flow interval only when canonical consecutive EOA nonces cover every outgoing transaction, all known transactions carry zero native value, native balance changes exactly equal actual Gas, and every registered ERC20 balance change and transfer log matches the known receipts. This produces a persisted proof and permits flow-adjusted NAV return calculation. External transfers, uncovered activity or inconsistent evidence keep return quality `UNKNOWN`; RPC failures retry. It does not fabricate zero flows or deduct Gas twice. Canonical fills use block-bound `/2` identifiers so a reminted transaction can retain distinct historical observations; legacy `/1` fills remain readable.

## Scope and remaining validation

Current execution uses direct ERC20 V2 routes. Native BNB wrapping/unwrapping, priced external-flow accounting, arbitrary native-coin transfers, mainnet execution, reward distribution, and user withdrawals are not implemented by this coordinator. A native-only reduction that cannot be funded by the registered ERC20 representation is rejected before signing. Reconciliation of active jobs revalidates fill receipts; invalidating already completed accounting after a deep reorg is not yet a complete automatic repair workflow.

Automated integration tests exercise signed QSP consumption through approvals, swaps, fills, reservation settlement and feedback with simulated RPC, including restart, pending transactions, expiry, lost eligibility, disabled execution and unavailable receipts. These tests alone do not establish real LLM research quality, real-chain acceptance, or six-hour stability. Real-chain evidence is documented separately after execution.
