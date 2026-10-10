# Direct V2 DEX quotes and confirmed fills

`V2Dex` provides direct ERC20-to-ERC20 and optional native-to-ERC20 exact-input quotes and transaction construction. It does not execute QSP, check Worker eligibility, allocate investment risk budgets or authorize signatures. The automatic planning Scheduler still produces reference plans only.

Configuration explicitly supplies chain ID, router/factory addresses and code hashes, and allowed tokens. Quotes check deployed bytecode and the router's factory, resolve the direct pair through that factory, verify both token identities, and read reserves and router output at one block. The block hash is checked again before storing the quote. Every quote attempt has a durable success/failure record; successful quotes bind the configuration, wallet recipient, path, amounts, block and expiry.

Slippage and conservative pool spot-to-output deterioration are each limited to at most 50 basis points. The latter includes pool fees and integer rounding; it is not an oracle price check. Maximum quote lifetime is 30 seconds from collection start. Transaction construction requires an unchanged stored quote, matching chain and block hash, and remaining validity. It fixes input amount, minimum output, two-token path, recipient and deadline. No arbitrary LLM calldata is accepted. It does not support multi-hop routes, separate native wrapping/unwrapping, taxed/rebasing tokens or unrestricted router selection. Deployment hashes must come from a trusted configured registry; merely reading a hash from RPC does not independently audit the deployment.

`recordV2Fill` checks the Journal's confirmed transaction, signed chain/sender/router/calldata/value, matching canonical receipt and confirmation depth. It calculates wallet net input/output from allowlisted token Transfer logs, verifies exact input and minimum output, and records actual gas cost. This depends on standard, trusted ERC20 transfer semantics. Quantities are base units, gas is wei; no USD valuation, cost basis or PnL is invented. Re-reading a fill rechecks its receipt before returning the immutable stored observation. Historical fill rows do not permanently guarantee canonicality; downstream accounting must revalidate them at its own boundary and handle reorg invalidation.

Records: `dex-v2-attempt`, `dex-v2-quote`, `dex-v2-fill`, plus existing Journal transaction/history rows. Failures do not create a successful quote or fill.

## Testnet deployment

PancakeSwap's [official V2 deployment registry](https://developer.pancakeswap.finance/contracts/v2/addresses) lists BSC testnet factory `0x6725F303b657a9451d8BA641348b6761A6CC7a17` and router `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`. These addresses were checked through chain97 RPC during testing. Test-only `InvestmentTestToken.sol` can deploy on chain97/1337, mints a fixed supply to the deployer, and provides standard ERC20 behavior. Its qUSD/qBTC labels do not represent actual dollars, Bitcoin or a guaranteed peg.

The live adapter smoke uses separately encrypted local test wallets, self-funded test-token liquidity, exact approvals, buy and sell transactions, Journal receipts and independent fill verification. That verifies DEX plumbing only; it does not establish committee-QSP-driven investment, actual Worker qualification, external market profitability, round PnL feedback or continuous six-hour stability. Those remain subsequent integration/acceptance gates.

See the [three-wallet live smoke record](testnet-dex-smoke.md) for public transaction references.

## Optional native BNB input

Set `wrappedNative: { address, codeHash }` alongside the existing deployment fields and include that address in `tokens`. Native quotes verify router `WETH()`, wrapped runtime code and router/factory deployment identity at the pinned quote block. Use `quote(wallet, "native", stableAddress, amountWei)`; the route is `[wrappedNative.address, stableAddress]`, while the persisted `/2` quote records `inputKind: "NATIVE"` and `inputAsset: "native"`. Exact `swapExactETHForTokens(minimumOut,path,wallet,deadline)` calldata carries `value=amountIn`, with no approval.

Native config is stored by hash as `dex-v2-config`. Request construction and recovery require this original record and reverify historical deployment code; current settings cannot replace missing evidence. Legacy ERC20 quote shapes, hashes and calldata remain unchanged.

A successful native fill uses `dex-v2-fill/3`, requires the exact signed payable request and canonical receipt, the exact wrapped-token router→pair funding amount, no wallet wrapped-token input debit, and reserve output at least the minimum. It records `inputAsset: "native"`; it never describes router wrapping as a wallet WBNB sale. Its ID hashes version, chain, mined transaction hash and canonical receipt block hash, including when an older gas replacement mined. The [official Pancake router source](https://raw.githubusercontent.com/pancakeswap/pancake-swap-periphery/master/contracts/PancakeRouter.sol) describes this atomic path. This is a deployment-bound standard V2 adapter, not arbitrary payable execution.
