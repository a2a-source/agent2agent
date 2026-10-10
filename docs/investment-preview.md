# Independent-wallet investment preview

The next-stage foundation is a deterministic **reference-price calculator**, available as `planWallet` in `src/wallet-planner.ts`. It accepts an explicit target allocation, wallet snapshot and policy. The calculator itself does not consume published QSP, produce authorized orders, fetch balances, reserve funds, simulate DEX fills or execute trades. A separate [verified QSP consumer](network-allocation.md) can now feed explicit shared model targets into it. Each wallet's principal and future P&L remain separate.

## Run the synthetic example

```sh
npm run investment:preview -- examples/investment-preview.json 1100 var/preview-demo.sqlite
```

All addresses, times, prices and balances in this example are synthetic. The second argument is an explicit evaluation timestamp in milliseconds, enabling reproducible replay. The optional third argument chooses the SQLite database; when omitted, the default configuration database is used. The CLI commits an `investment-preview-record/1` record before printing it. The envelope includes validated input, evaluation/recording times and DONE or REJECTED status. A DONE record contains `output`; that nested result has `previewOnly: true`, `executed: false` and hashes identifying the supplied strategy, policy and snapshot. These hashes establish reproducibility, not authenticity. Caller-supplied prices and balances are not verified against a chain. Business rejection stores the validated input with `PLANNER_VALIDATION_FAILED` and prints the record with a nonzero exit status. Schema/JSON errors are rejected without echoing or storing arbitrary input. Identical normalized input and evaluation time replay the same record. These local snapshots are private wallet data, not public API responses.

The example has 10 native units priced at $100, reserves 0.1 for gas, and requests a 20% token allocation: reference portfolio value $990 and reference BUY value $198. This is an arithmetic example, not recommended asset allocation or a DEX quote.

## Input and arithmetic

`allocation-preview/1` is an unsigned calculator input, **not a new QSP protocol version**. Supply every tracked token with an explicit target, including zero when liquidation is intended; omission is rejected. Addresses are normalized and duplicates rejected. Token decimals, integer base-unit balances and USD micro-unit reference prices are explicit. Prices must be positive. The caller must provide a complete tracked universe; the calculator cannot discover unlisted wallet tokens.

Portfolio value includes native balance after gas and pending-native reservations plus full tracked-token balances. Pending token quantities remain in exposure valuation but cannot be sold. Bonded guarantees and compute credits must never be included in wallet balances. Native BNB is the residual asset, not dollar-stable cash; WBNB is a separate ERC20 exposure and no wrap/unwrap route is implied.

For each target, the planner compares target value against the wallet's current value, then rounds the required reference token quantity down to base units. At-target and sub-micro-dollar differences produce no item. Both BUY and SELL amounts are indicative; no fees, executable exchange rate or minimum received amount is inferred. Price rounding can leave residual dust and is not a guarantee that the resulting portfolio exactly reaches target.

The policy bounds per-token and aggregate target weights and absolute reference turnover. Input expiry, snapshot age, chain equality, coverage and reservations are checked. Pending sells do not finance buys: if aggregate purchases exceed currently available native value, the entire preview is rejected. A future orchestrator must stage sells and replan after confirmed balance updates. Output validity is capped by strategy and snapshot validity; preview output itself confers no execution permission.

## Integration still required

Current QSP v2 signals are tied to `context.portfolioIdentity.wallet`. A risk-reduction SELL for one wallet is not a universal market SELL. Do not copy those signals into this calculator as a network-wide strategy. The [shared-allocation extension](network-allocation.md) now distinguishes shared market allocation and binds it to committee confirmation. Machine-checkable execution conditions and Worker eligibility checks still require the execution stage.

Qualified Workers are intended to participate automatically without a separate opt-in. Execution still requires current Worker eligibility and protocol policy enforcement, fresh canonical balance checks, qualification/exit-state policy, shared transaction reservations, allowlisted DEX routes, actual quotes, slippage/deadlines, receipt reconciliation and an independent execution ledger referencing the immutable QSP hash. None is enabled by this calculator. Profit distribution remains separate. Existing [v0.1 boundaries](v0.1-boundaries.md), including B1 and C4 acceptance limits, remain in force.
