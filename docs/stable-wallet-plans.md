# Stable-reserve wallet snapshots and reference plans

This increment adds a read-only, database-backed path from a configured wallet's confirmed-block balances and USD oracle observations to a stable-reserve reference investment plan. It does not sign or submit trades, automatically schedule investments, verify an Agent's identity/eligibility, or itself consume a committee-signed QSP. The separate [confirmed stable-QSP consumer](confirmed-stable-qsp.md) now supplies verified shared targets and checks registered Worker state. Existing `network-allocation/1` and residual-BNB wallet previews keep their original meaning.

## Confirmed-block collection

`PortfolioCollector` accepts a trusted asset registry and a capture request. `EthersPortfolioReader` reads native balance, ERC20 `balanceOf` and decimals, and Chainlink-compatible `decimals`, `description`, and `latestRoundData` at one numeric block tag: current tip minus configured confirmations. It validates chain ID, block age, feed description/round/positive answer/timestamp, token decimals, complete reservation entries and gas availability. Initial and final block-hash reads use raw JSON-RPC to bypass provider block caches; the final check rejects an observed reorganization. This depends on the configured RPC's honesty and is not a cryptographic finality proof.

Each registry entry explicitly identifies the token address (or `native`), underlying bucket BTC/ETH/BNB/STABLE, decimals, price feed address and expected description. Exactly one native entry is required and must be 18-decimal BNB. All four buckets must be represented; duplicate assets are rejected. Mainnet token/feed addresses are deliberately not guessed or selected by symbol. Operators must verify chain-specific contracts, wrappers and feed mappings. A BTC/USD feed for a bridged BTC token is a configured reference valuation, not proof of redeemability or an executable token price.

Stablecoins are valued using their observed USD feed rather than a hard-coded dollar. Native BNB after operational Gas and all configured BNB wrappers contribute to the same BNB exposure. Pending balances remain part of NAV but are unavailable for trading. Gas and pending-native reservations are separate amounts and must not overlap. Bonded and compute-account funds must not be supplied as wallet balances. The reservation source is a caller-provided provenance identifier, not a verified execution-ledger lock.

Values use integer USD micro-units and round down. A snapshot is a **tracked-universe valuation**: the collector reads configured tokens and cannot discover arbitrary unlisted ERC20s, authenticate their economics, or verify that the registry covers every asset. The snapshot must not be treated as complete execution NAV until registry coverage and execution-reservation integration are established. USD reference values must not be silently written into the existing micro-USDT performance ledger; accounting denomination/flow attribution remains a separate integration.

## Durable records and recovery

- `portfolio-capture`: request, registry, input fingerprint, start/end status, snapshot link or bounded failure code. Identical completed requests return their historical snapshot; changed input under the same chain/request ID conflicts. Incomplete or failed requests require a new capture ID.
- `portfolio-observation`: asset metadata and block identity committed before RPC dispatch, READING/RETURNED/FAILED status, and raw returned balance/feed data including subsequently rejected stale or mismatched observations. RETURNED means RPC data arrived, not that valuation validation succeeded.
- `portfolio-snapshot`: immutable holdings, prices, NAV, available values, BNB-aggregated exposures, block identity, registry and reservation provenance, observation time and validity.
- `stable-wallet-plan`: frozen strategy, risk policy, eligibility input, snapshot link, reference orders or rejection/no-action reason. SQLite history retains transitions.

A returned cached record is historical retrieval, not fresh execution permission. No scheduler is installed by these libraries; an orchestrator must generate new capture identities and respect deadlines automatically. API credentials and RPC URLs are not persisted in these records.

## Deterministic adaptation

`StableWalletPlanner.plan(snapshotId, strategy, workerEligible, now)` reads a locally stored successful capture. The new unsigned input is:

```json
{
  "version": "stable-allocation-preview/1",
  "epoch": "example-round",
  "chainId": 97,
  "createdAt": 1000,
  "validUntil": 2000,
  "targets": { "BTC": 2000, "ETH": 2000, "BNB": 2000 }
}
```

This is a reference input, not a new signed QSP version. Targets are NAV basis points; residual value is intended as stable reserve. The planner freezes `investmentRisk` defaults (20% per underlying, 60% aggregate, 10% per-order and per-cycle buy budget, 10 USD minimum reference notional). Explicit targets above policy are rejected rather than silently clipped. Planner policy can tighten the 20%/60%/10%/10% ceilings but cannot relax them; the older standalone reference risk library remains separately configurable. Native BNB cannot be considered stable residual cash.

If any bucket exceeds its target, generate only available reductions and require a fresh snapshot after confirmed fills. No estimated proceeds finance buys. Unsellable or dust reductions block accumulation. Otherwise, eligible Workers receive buy amounts proportional to target deficits, bounded by starting available stable funds and the order/cycle caps; rounding and minimum trade size may leave budget unused. Ineligible Workers cannot receive buy plans, but protective reduction previews remain possible. No additional opt-in is introduced.

One immutable plan is allowed per chain/wallet/epoch. Identical input replays; changed snapshot, strategy, policy or eligibility conflicts. Replanning requires a subsequent epoch in this increment. READY means a reference plan exists; every output remains `previewOnly: true`, `executed: false`. It is not a reservation or order authorization. There is no implied stablecoin liquidation path for a bucket-level order.

## Local CLI

```sh
A2A_PORTFOLIO_RPC_URL='<local or approved RPC endpoint>' npm run investment:stable-preview -- local-input.json var/local-preview.sqlite
```

The local JSON contains `registry`, `request`, `strategy`, `workerEligible` and optional `policy`. Registry fields are `chainId`, `confirmations`, `maxBlockAgeMs`, `maxPriceAgeMs`, and `assets` (entry fields described above). Request fields are `id`, `agent`, `wallet`, `gasReserveWei`, `reservationSource` and `reserved` (every asset ID mapped to its integer base-unit reserved amount). Policy uses the existing `investmentRisk` schema. Use current epoch timestamps; the example above is deliberately synthetic. Configure the existing `A2A_HTTP_PROXY` when needed. Inputs, database and wallet output are local/private. No key or signer is needed for collection.

## Validation and remaining work

Tests include real local EVM token/feed contract reads and three simulated portfolio rounds, plus stale feeds, wrong decimals, reorganization, excess reservations, idempotency and immutable plan conflicts. This is not live BSC feed/DEX acceptance.

Before execution: wire the signed-QSP consumer and fresh registered Worker/exit checks into automatic orchestration, complete canonical reservation reconciliation, complete asset coverage, stablecoin depeg policy, exact token selection, executable DEX quotes and Gas, fund locks, idempotent signing, receipts, and denomination-consistent P&L are still required. Fees, slippage, price impact and economic feasibility must pass the execution guard using an actual quote; this planner cannot establish them from oracle marks. B1 post-migration tax and C4 research-quality boundaries remain unchanged.
