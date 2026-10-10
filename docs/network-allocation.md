# Shared QSP allocation and independent-wallet previews

QSP v2 now supports the optional signed field `masterSummary.networkAllocation`. Its `network-allocation/1` payload has scope `NETWORK_MODEL_PORTFOLIO`, complete per-asset `targetWeightBps`, evidence references, rationale and explicit limitations. This is shared model-portfolio research for independent Agent wallets. Existing `signals` remain proposals specific to the observed `context.portfolioIdentity.wallet`.

The same shared 20% token target can imply buying for an empty wallet and selling for an overweight wallet. Wallet principal stays separate. The planner uses deterministic rules and makes no extra LLM request per wallet. This does not pool funds or implement returns distribution.

## Production and validation

The configured Master prompt (`config/default.json`) and synthesis task instructions distinguish common market allocation from observed-wallet risk correction. Unsupported common allocation returns `null`; omission remains supported for old packages/providers. Neither absent nor null means a zero target or liquidation. An explicit zero target, by contrast, is a model allocation of zero for that asset.

For a non-null allocation, validation requires:

- Exactly one target for every configured research asset; no duplicates or foreign assets.
- Per-asset and total target caps from the frozen research policy.
- Fresh frozen market evidence cited by a role and by each target. Wallet/accounting evidence cannot justify a common target.
- For positive targets, recent matching-asset liquidity above the policy minimum, with the matching frozen DEX evidence cited by the target and a role.

These checks bind data and enforce structural constraints; they do not prove that the LLM's thesis is correct or entirely free of portfolio influence. Native residual is volatile BNB, not dollar-stable cash. Observed pool liquidity is not an executable quote. Existing C4 research-quality limitations still apply.

The complete Master summary is covered by the original QSP signature and committee certificate, so changing a shared target invalidates the signed package. This is an additive schema extension: old packages retain their original hash, but older software with strict schemas may reject newly extended packages and needs updating. New software does not manufacture missing shared targets.

## Consumer interface

`previewQspForWallet(epoch, snapshot, policy, chainId, now)` in `src/qsp-wallet-preview.ts` accepts an Epoch from **trusted local network state**, an explicit independent-wallet snapshot and its local policy. Do not accept an arbitrary externally supplied Epoch/committee as a trust anchor.

The consumer requires a published package with mandatory committee confirmation, verifies signatures, matches the research chain, checks publication/data expiry, and rejects missing shared allocation. Old wallet-specific signals are never promoted to common targets. Snapshot token identities and decimals must match the signed research universe. Local allocation/freshness limits can tighten network limits, not loosen them. It then invokes the [wallet preview planner](investment-preview.md) and binds its result to the QSP and confirmation hashes.

The output is still `previewOnly: true`, `executed: false`. Snapshot prices, balances, reservations, Agent identity and ownership remain caller-supplied; this API does not verify them onchain or authorize their use. Preview hashes are reproducibility identifiers, not order deduplication keys. The interface is a library integration point; it is not exposed as a wallet transaction endpoint or an automatic scheduler job.

## Verification and remaining execution work

Automated tests cover the schema and evidence checks, real local wallet signatures and a three-member certificate, distinct wallet outcomes, authentic legacy/null-allocation rejection, tampering, wrong chain, insufficient votes, expiry and metadata mismatch. The research-round integration test uses a synthetic provider over HTTP for three rounds, passes Master output through schema/reference normalization and signing, and confirms that carrying shared allocation adds no per-wallet LLM calls. These are local fixtures, not new live market/LLM/DEX acceptance runs.

Before trades can run, the next increment must establish current Worker eligibility and protocol limits (automatic participation, without an additional opt-in), actual wallet/qualification/exit checks, fresh chain snapshots and shared transaction reservations, machine-checkable execution conditions, approved DEX routes and quotes, idempotent submission, receipts and independent P&L. LLM rationale and limitations are not executable conditions. No mainnet transaction is enabled by publishing or previewing a model allocation.

The separate [stable-reserve collector and planner](stable-wallet-plans.md) now provide a durable read-only adaptation path. Their new unsigned input is not silently derived from `network-allocation/1`; signed stable-reserve QSP semantics and the consumer bridge remain to be implemented.
