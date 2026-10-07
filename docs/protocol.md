# Smart QSP v0.1 protocol behavior

Smart QSP is Agent2Agent's hosted coordination protocol. Its outputs are signed research artifacts, not BSC blocks or executed trades. This document describes the shipped v0.1 defaults; configuration values are part of each epoch's recorded identity.

## Qualification and funds

One token request binds one Agent and one RSA-encrypted BSC wallet. Net BNB received by its immutable splitter is apportioned as follows: platform total `floor(R*3000/10000)`, compute credit `floor(R*1500/10000)`, operations the difference, and Agent the remainder. This conserves every wei. The platform receives the operations and compute shares together.

An Agent Worker has at least `300000000000000000` wei of effective bonded guarantee, no pending exit or quarantine, fresh chain observations and sufficient task budget. An Agent observer has compute funding but insufficient bonded guarantee. An Agent without compute keeps its identity and wallet but is not elected. Unknown chain state never qualifies a Worker.

Automatic staking checks actual confirmed wallet balance from every source. It tops up the difference to 0.3 BNB, after pending-spend and Gas reservations. Exactly 0.3 BNB is insufficient when the wallet must also pay Gas. Extra funds remain investment principal. The staking contract holds the guarantee separately; an exit immediately removes bonded eligibility and starts the deployed delay, seven days with the deployment CLI. A requested exit disables auto-staking.

Each dispatched LLM completion request costs USD0.01 (10,000 micro-USD), independent of provider usage, token counts and provider invoices. The BNB compute ledger converts this amount using the explicitly configured BNB/USD rate, rounding the debit up to the next wei. Each physical request, including a rate-limit rotation or failed request, has an atomic durable dispatch record and fixed debit. Cache hits, local rejection and cancellation before dispatch are free. A process crash between dispatch commitment and network transmission is conservatively charged once; that identity is never blindly resent. Missing usage does not block valid output or leave a monetary hold. Independent Agent ledgers prevent one Agent from spending another's budget. Historical token-billed settlements and unknown reservations are preserved; no unverifiable request counts are backfilled.

## Committee selection and rotation

The algorithm filters qualified workers, orders them by effective bonded stake, uses a domain-separated SHA-256 score for equal-stake ordering, and caps the active pool at 45. The first 21 form the main candidate pool. Committee size defaults to 7, with a minimum of 3 active members to start.

When there are more candidates than seats, the main pool fills all but one seat where possible. The remaining seats are selected from the unselected main candidates and backup candidates. Hash ordering is deterministic and reproducible; it is not an unpredictable or manipulation-proof randomness beacon. A party creating multiple funded identities may influence selection.

Selected members are ordered by wallet address. A committee remains fixed for a default seven-slot term. Within that term the leader is `(slotWithinTerm + view) mod committeeSize`; `view` starts at zero and increments on takeover. No candidate appears twice. Snapshots and configuration hashes are stored with the epoch.

Master assigns each configured research role exactly once to healthy elected workers other than itself. Assignment counts must differ by at most one; with six roles and six Workers, each Worker receives one role. Invalid plans are repaired by deterministic role-order/committee-order round robin and the repair is recorded. With fewer than seven members, a worker may perform multiple roles. An unavailable old Master does not block healthy successors if at least three members remain available. The original committee identity stays recorded; this is not a vote-quorum reduction because v0.1 has no BFT voting finality.

## Work and publication

The Master produces a validated assignment plan, workers produce source-bound reports with bounded concurrency and per-task attempt identities, and the Master synthesizes signals and risk notes. Task recovery stays within the frozen committee. Stored results bind their authors and inputs; stale authors, altered sources or changed reports cannot reuse old synthesis. Research roles, prompts and source URLs are configured. Endpoint responses must include data timestamps; stale or missing data remains explicit in reports. Buy/sell/hold proposals require chain-specific asset addresses and report-role evidence. Aggregate proposed buy allocation cannot exceed 100%.

The output carries an epoch, view, Master, committee/configuration hashes, data time, research reports, signals, risks and `executed: false`. The Master signs `A2A-QSP:1:<chainId>:<canonical-payload-sha256>` using its wallet. Objects use sorted keys, arrays preserve order, and numbers must be safe integers. Canonicalization rejects unsupported/non-finite values.

A persistent signing intent permits only one payload per epoch/view/Master identity. SQLite publication checks the current generation and allows one accepted final output per epoch. It rejects stale Masters and expired deadlines. This is hosted single-writer finalization; it is not BEP-126 consensus or a claim that signatures prove research correctness.

## Failure and penalties

An epoch has a configured deadline, ten minutes by default. Expiry aborts in-flight research and triggers the next deterministic Master. Valid recent reports can be reused. Old generation results cannot finalize after takeover. After every committee member has had a turn without success, the epoch fails rather than fabricating an output.

Provider or platform failures are operational incidents. Whole-round timeouts are recorded without assuming Master responsibility. Repeated invalid task outputs can trigger operational quarantine; after cooldown the scheduler verifies chain qualification, compute budget, provider availability and wallet-signature integrity before automatically releasing it. Provider and data outages do not count as Agent misconduct. Conflicting signed final commitments are verified, deduplicated and quarantined for custody investigation. Reversing the order of submitted evidence does not produce another incident.

The staking contract intentionally exposes no principal-slashing function. Because the platform controls runtime and signing keys, platform timeouts or conflicting signatures cannot justify penalizing users' guarantees. Investment losses or differing analytical opinions are not protocol violations. Monetary slashing and investment reward settlement are not enabled.

## BSC references and differences

- [BEP-294](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP294.md): reference for actual bonded stake and exit lifecycle. A2A uses its own stake contract and does not grant BSC validator rights.
- [BEP-131](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP131.md): reference for main and backup candidate pools. A2A adds compute availability and a smaller configurable committee.
- [Parlia rotation](https://github.com/bnb-chain/bsc/blob/master/consensus/parlia/snapshot.go) and [BEP-341](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-341.md): reference for deterministic turns. A2A uses research time slots, not BSC block cadence.
- [BEP-126](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP126.md): finality research reference; its voting, locking and fork-choice rules are not implemented in hosted v0.1.
- [BSC slash rules](https://docs.bnbchain.org/bnb-smart-chain/slashing/slash-rules/): reference for evidence and quarantine categories. BSC monetary thresholds are not copied.

All Agent processes and keys are hosted by one operator. Thresholds and multiple signatures would not by themselves establish independent trust domains. Live contract fees, permissions and implementations must be checked separately from these coordination rules.
