# Committee-confirmed stable-reserve QSP consumption

QSP v2 now supports the optional signed field `masterSummary.stableNetworkAllocation`. Its explicit format is `stable-network-allocation/1`, scope `NETWORK_MODEL_PORTFOLIO`, reserve `ALLOWLISTED_STABLECOINS`, and native-BNB treatment `INCLUDED_IN_BNB_TARGET`. Targets use the same asset/evidence/rationale structure as the legacy allocation, but residual funds mean stable reserve and native BNB plus WBNB share the BNB underlying target.

The legacy `networkAllocation` remains independent and retains residual-BNB semantics. Missing/null stable allocation does not mean liquidation, all-cash, or permission to translate legacy targets. New producers may emit null when research is insufficient. Old packages retain their hashes; older strict consumers need updating to recognize the new optional field.

## Production and confirmation

Master prompt and synthesis task instructions explain both formats. Stable targets must explicitly cover the recognized BSC mainnet BTCB/ETH/WBNB universe, each at most 20% and aggregate at most 60%, or tighter frozen research policy limits. Each target needs matching fresh market evidence cited by a specialist report; positive targets additionally need matching fresh observed DEX liquidity and its role-cited evidence. Validation rejects invalid targets instead of clipping them. These are structural/evidence checks, not proof of investment merit, a stablecoin peg, or executable liquidity.

Research normalizes evidence aliases for the new field before building the QSP. The Master signature and committee certificate cover it as part of the complete package. No extra per-wallet LLM calls or extra LLM committee round are introduced. Existing wallet-specific signals and their research-policy semantics remain unchanged; they are not instructions for all wallets.

## Internal consumer

`ConfirmedStablePlans(db, budget, chainId, stateMaxAgeMs, minimumCompute, policy).consume(epochId, snapshotId, now)` is an internal service interface. Epoch and snapshot are loaded from trusted local SQLite state, not accepted as externally supplied trust anchors.

The consumer checks:

- Published QSP, mandatory valid committee confirmation and Master signature; chain, creation/confirmation time, package and research-evidence validity.
- Explicit stable allocation and signed asset identities matched against the collector registry (address, decimals, underlying bucket). Registry hash and capture-to-snapshot links must match.
- Agent registration and wallet identity, confirmed launch, no jail, automatic staking still enabled, known/fresh nonfuture chain state, bonded guarantee at least 0.3 BNB and no exiting stake.
- Available compute budget from `Budget`, including pending compute reservations and chain-sync freezing. The injected minimum-compute function must provide the current network requirement; unavailable pricing rejects the request. It is not a caller-supplied `workerEligible` flag.
- No active Journal sender lease, no READY transaction, no recorded transaction in a block newer than the balance snapshot, and a complete all-zero reservation map in the capture. Nonzero reservations are conservatively refused until an execution reservation reconciler exists.

The shared allocation is converted to the [stable wallet planner](stable-wallet-plans.md)'s BTC/ETH/BNB targets. The planner can tighten protocol limits and enforces per-order/per-cycle buy budgets, sale-first adaptation and immutable per-wallet/per-epoch output. No separate opt-in is introduced. This consumer currently rejects ineligible Workers entirely; protective reduction previews in the lower-level planner do not by themselves permit autonomous trading by an ineligible node.

## Persistence and replay

`stable-qsp-consumption` stores epoch/snapshot identity, evaluation time, status/reason, QSP and certificate hashes when verified, qualification evidence when available, and the generated plan ID. Successful plan creation and consumption linkage commit in one SQLite transaction. Expected prerequisite refusals are persisted instead of silently dropping the attempt. Historical consumption replay returns the original record; it does not reauthorize an expired plan or recheck present eligibility. A fresh snapshot/epoch is needed for a fresh decision, subject to the planner's one-plan-per-wallet/epoch rule.

## Verified scope and remaining work

Automated tests use real local Master/committee signatures, tampering and insufficient-vote cases, stale/legacy rejection, wallet/registry/qualification checks, occupied-wallet guards, and three signed synthetic rounds adapting to empty, overweight and at-target portfolios. The existing multi-Agent HTTP provider fixture also verifies that the field survives research synthesis, normalization, QSP validation and confirmation. These are local tests, not new live LLM or BSC investment acceptance.

The service now wires this consumer and its live minimum-compute callback into optional [automatic reference planning](automatic-investment-planning.md). It is not a trading endpoint. Registry completeness, stablecoin contract/depeg policy, canonical reservation accounting, onchain pending nonce rechecks and actual ERC20/native spend locks remain necessary. Absence of a local pending Journal record is not proof that no external pending transaction exists.

This consumer produces immutable plans, not fills. The [automatic execution coordinator](automatic-investment-execution.md) now connects eligible plans to fresh source/Worker checks, fund reservations, DEX quotes, signing, receipts and [execution feedback](execution-feedback.md). Enablement and deployment checks remain explicit; a consumed QSP alone never proves a trade. See the [testnet evidence](testnet-qsp-execution.md) for the distinction between signed fixtures, live LLM research and long-run acceptance. B1 post-DEX tax and C4 research-quality limits remain unchanged.
