# Stable-reserve investment controls

The selected execution model is automatic participation by eligible Workers, with no extra user opt-in. The intended reserve is an allowlisted stablecoin; BTCB, ETH and native BNB/WBNB count as volatile exposure. A dedicated operating-gas reserve, guarantee and compute accounting are excluded from investable capital. This does not make stablecoins risk-free, and no stablecoin contract is inferred from a token symbol.

This increment implements the **reference budget guard**, `InvestmentRisk`, and its defaults under `investmentRisk` in `config/default.json`:

| Setting | Default |
| --- | --- |
| Volatile allocation cap | 60% of investment NAV |
| Underlying allocation cap | 20%; BNB and WBNB belong to the same BNB bucket |
| Maximum single BUY | 10% of cycle-start available stablecoin funds |
| Maximum aggregate BUY per Agent/QSP cycle | 10% of the same funds |
| Minimum reference trade value | 10 USDT |
| Maximum estimated transaction Gas | 0.5% of reference trade notional |
| Maximum slippage | 0.5% |
| Maximum quoted price impact | 0.5%, separate from slippage |
| Quote maximum age | 30 seconds; equality is expired |

These are initial engineering limits for testing and calibration, not optimized investment recommendations. Slippage and price impact are separate checks; their combined economic effect is not capped at 0.5% by this implementation. Actual execution additionally needs route, fee, quote and balance checks.

## Persistence and arithmetic

`new InvestmentRisk(db, config.investmentRisk)` freezes policy when opening a `(chainId, Agent, epoch)` cycle. Its snapshot contains investment NAV, total stablecoin value, available stablecoin value and per-underlying volatile values in integer micro-USDT. Stable plus volatile values must equal NAV; available stable funds cannot exceed total stable value. The trusted adapter must exclude operational/bonded/compute funds consistently, aggregate BNB/WBNB and derive spendability from actual reservations. This library does not authenticate its supplied balances, prices or eligibility.

A changed funding snapshot or policy cannot reopen the same cycle. A wallet cannot reopen the same epoch under a different Agent ID. Orders are persisted atomically with idempotent input hashes. Identical retries return the original reservation; changed input under the same ID conflicts. Such replay is retrieval, not fresh permission to sign or execute an expired/ineligible order.

Pending and completed reference BUY reservations both consume the cycle budget and exposure headroom. Reservations conservatively persist for that cycle; failure or cancellation does not restore them in this increment. SELL reservations cannot exceed the cycle's starting reference exposure, and never finance BUYs or release exposure headroom within that cycle. Replanning after actual fills requires the future executor and receipt integration.

New BUY reservations require current Worker eligibility supplied by the trusted executor. SELL reductions can still be represented when Worker eligibility is lost and are not subject to the BUY10% cap, but still obey the economic floor and quote checks. A recorded reduction is not a guarantee that it can be executed under adverse market conditions.

## Current scope

The guard is not yet connected to a signer, DEX, scheduler investment job or actual ERC20/native fund locks. It must not be used as a replacement for the Journal's nonce/reservation mechanism. There is no trade execution API. No swaps are triggered by becoming a Worker yet.

Existing `wallet-preview/1` and `network-allocation/1` describe the earlier residual-BNB research model. They retain that meaning and are **not silently converted into stable-reserve execution instructions**. A new explicit strategy/planner representation and verified stablecoin identity are required before enabling stable-reserve trades. The earlier generic `WALLET_AUTHORIZATION` preview prerequisite now reads `ELIGIBLE_WORKER_AND_PROTOCOL_POLICY` to match automatic participation; it does not enable signing.

Normal rebalance deadbands, per-asset cooldowns, actual route/slippage enforcement, stablecoin depeg handling, confirmed wallet collection, and live receipt/PnL reconciliation remain subsequent execution work. The [performance ledger](performance-ledger.md) records each round's known or unknown accounting status independently of trading availability.
