# Running Agent2Agent v0.1

Agent2Agent provides a custodial Agent API, BSC token launch and staking adapters, and a hosted Smart QSP research network. It produces signed research reports and proposed signals. It does not execute investments or distribute investment profits.

## Requirements and local startup

Use Node.js 22.13 or newer and npm. SQLite is bundled through `node:sqlite`; Node 22 may print its experimental-feature warning. No Redis, separate database server, or local LLM is required.

```sh
npm ci
npm run build
npm test
npm run demo
npm run init
npm start
```

The demo runs seven Agents against explicitly simulated chain state and a local compatible LLM fixture. It makes no real token launches or investments. Contract tests use Ganache and real deployed local EVM contracts; the Flap fixture implements the integration ABI, not Flap's bonding curve. Ganache may fall back to its JavaScript transport when a native µWS binary is unavailable.

`init` creates RSA keys in `var/keys/` and an administrative API credential in `var/admin-token`, with restricted file permissions. It refuses to overwrite existing credentials. Keep a separate, protected backup of the RSA private key: the database cannot recover encrypted wallet keys without it. These runtime files are ignored by Git.

The default API listens on `127.0.0.1:3000`, with chain writes disabled. Protect remote access with TLS and access controls. Administrative credentials must never be distributed to ordinary users. User enrollment is operator managed in this version.

## Configuration

`config/default.json` contains the supported defaults. Set `A2A_CONFIG` to a JSON override file, such as the Git-ignored `config/local.json`. Top-level fields replace defaults; `chain`, `network`, `llm` and `recovery` merge their fields. A custom `roles` array replaces the entire default array. Role IDs must be unique.

| Environment variable | Purpose |
| --- | --- |
| `A2A_CONFIG` | Configuration override path |
| `A2A_ADMIN_TOKEN` | Overrides the local admin-token file; at least 24 characters |
| `A2A_LLM_API_KEY` | Credential for the configured compatible LLM endpoint |
| `A2A_OPERATOR_PRIVATE_KEY` | Separate funded deployment and token-launch wallet; never the Agent investment wallet |
| `A2A_PLATFORM_ADDRESS` | Platform receiver used by the deployment CLI; defaults to the operator address |
| `A2A_HTTP_PROXY` | Optional explicit HTTP proxy for outbound RPC, Flap upload, data and LLM requests |
| `NO_PROXY` | Proxy bypass list; defaults to localhost and loopback |

For example, an already-running local VPN HTTP proxy can be used with `A2A_HTTP_PROXY=http://127.0.0.1:7897`. The application does not modify system VPN settings. Configure external endpoints yourself; API users cannot change them.

Agents run LangChain `createAgent` on its LangGraph runtime. Workers iterate model → tool → observation; Master planning and synthesis use the same runtime without research tools. Public configuration defaults to OpenRouter (`https://openrouter.ai/api/v1`) and `openai/gpt-6.1-sol`. Set `llm.endpoint` and `llm.model` for another compatible provider. The model must support chat completions, tool calling and `max_tokens`; final answers must follow the JSON schema in the prompt. Optional `llm.reasoningEffort` (`none`, `minimal`, `low`, `medium`, `high`) sends OpenRouter’s reasoning setting when explicitly configured; omission keeps the provider default. A reasoning model may consume its output allowance before producing an answer. For a fast protocol smoke test, use short prompts and `none` on a model that supports disabling reasoning. This validates orchestration, not research quality. Failed completion records retain bounded diagnostic metadata (generation ID, finish reason, error code and token counts), never provider error text or reasoning content. HTTP 200 bodies containing provider errors fail closed. Provider usage is optional diagnostic metadata; valid output without usage is accepted.

Supply `A2A_LLM_API_KEY`, or set `llm.apiKeyFile` to a private local text file with one key per line. Environment credentials take precedence. Keep the file outside version control. Explicit HTTP 429 responses trigger bounded rotation through the configured keys; timeouts and ambiguous failures do not trigger key rotation or SDK retries. Cooldowns and completion-attempt counts persist in SQLite. `llm.requestLimitPerDay` caps attempts across keys and models for that endpoint per UTC day (0 means unlimited). Free models can be selected in an ignored local override; there is no automatic fallback to a paid model.

`agent.maxToolRounds` defaults to 10, followed by at most one final model response; `agent.maxToolCalls` defaults to 20 across that task. Completed task/tool results are cached against their inputs.

Every physically dispatched completion request costs **USD0.01**, including failures, malformed replies and each 429 key-rotation attempt. Cache hits, provider health checks, local limits and pre-dispatch cancellations are free. The dispatch marker, daily request count and fixed debit commit atomically before network transmission. A crash at that boundary conservatively retains the charge and prevents replay; this is not a promise of exactly-once delivery to an external provider. `UNKNOWN` on a new call describes its unavailable result, not uncertain pricing.

Compute income and balances remain in BNB wei. The server reads the Chainlink BNB/USD feed on the configured chain immediately before each physical completion request. Set `llm.priceFeed` to the network's verified proxy address and `llm.priceMaxAgeSeconds` to a freshness limit appropriate to its heartbeat (default 3900 seconds). The empty feed default disables paid requests until configured. BSC testnet (97) currently uses `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526`; verify addresses in the [Chainlink directory](https://docs.chain.link/data-feeds/price-feeds/addresses) before deployment. Each request debits `ceil(10000 * 10^18 * 10^decimals / (1000000 * answer))` wei. Receipts retain the exact answer, decimals, round, update time, feed, chain and confirmed block hash. Invalid, stale or unavailable quotes prevent dispatch and debit; the scheduler retries automatically. No configured fixed rate is used by the server. Offline unit/demo fixtures alone use synthetic conversion rates. Qualification uses the most recent valid quote (at most 60 seconds old); dispatch always refreshes and rechecks affordability. Qualification reserves capacity for bounded key rotations and tool rounds. Legacy `inputWeiPerMillion` / `outputWeiPerMillion` settings no longer price new requests. Old settlements and legacy holds remain unchanged for audit; the new policy does not retroactively invent their physical request counts. Billing version changes the request fingerprint: pre-upgrade call identities are not silently replayed or repriced; interrupted work must advance to a fresh protocol attempt/view, while historical outputs and money records remain available for audit.

Built-in read-only tools provide DuckDuckGo web search, Google News RSS search and public HTTPS page retrieval. Search availability is best effort. Page retrieval blocks private/reserved addresses, validates redirects and pins DNS results; it connects directly rather than forwarding arbitrary Agent-selected URLs through the configured proxy. Fixed search-provider requests can use `A2A_HTTP_PROXY`. Response sizes, timeouts and tool calls are bounded. Search retrieval time is not market-data freshness; news publication times are preserved when provided, and undated pages remain undated. Tools cannot access wallet signing or API credentials. Web/news citations remain research evidence; actionable signals require a cited, fresh configured data adapter with a verified `asOf`. QSP `dataAt: 0` means at least one report has no verified data time. Tool limitations are carried into report `missing` fields.

Each role may have a `sourceUrl`. Its JSON response must be:

```json
{"asOf": 1791220000000, "data": {"observations": []}}
```

`asOf` is the underlying data time in Unix milliseconds. Undated, future-dated, oversized or expired data is marked missing. LLM reports cannot invent source URLs; signals must cite roles with source-backed reports. Without usable configured sources or tool results the system can produce a signed, explicit no-data report with no investment signals. It has no built-in access to X or commercial news subscriptions.

## Connect BSC and Flap

Supply `chain.rpcUrl` (QuickNode or compatible BSC RPC), the correct `chain.id`, and deployed `stakeAddress`, `factoryAddress`, `flapPortal` and `flapImplementation`. `flapImplementation` must be the V3 tax-token implementation used for Portal V6 CREATE2 launches. Verify addresses against the [official Flap deployment list](https://docs.flap.sh/flap/developers/deployed-contract-addresses).

```sh
A2A_CONFIG=config/local.json npm run preflight
npm run contracts:build
```

`preflight` only reads the chain ID, a confirmed block and configured contract code. All code is read at the same confirmation-depth snapshot; a changed block hash rejects the result. It lists missing contract configuration and reports `complete: false` for a partial setup. For automated integration checks, require all four contract addresses and deployed code:

```sh
A2A_CONFIG=config/local.json npm run preflight -- --require-complete
```

Strict mode exits nonzero if any required contract is missing. `complete: true` means only that configured contracts have code on the expected chain; it does not establish ABI compatibility, correct receivers, supported Flap versions, available funding, an audited contract or launch readiness. The launch adapter performs additional checks during execution. RPC failures are reported without printing endpoint credentials.

Start a local override with `cp config/example.json config/local.json`, then replace the `.invalid` URL placeholders and fill in verified contract addresses. The example keeps chain writes disabled and contains no credentials. Set `fromBlock` to your earliest required activity before enabling indexing.

`npm run deploy` deploys the A2A stake contract and splitter factory using the operator wallet. This command spends real funds on the configured network. It requires `chain.writesEnabled=true` and an operator key. Deployment prints addresses to add to local configuration. There is no automatic mainnet deployment at startup.

The splitter has immutable platform/Agent recipients and forwards 30%/70% of actual BNB receipts. Within the platform share, 15 percentage points are credited to the Agent's compute budget. Failed recipient transfers remain pending and anyone can call `flush()` to retry. Compute credit is indexed only after `PlatformPaid` is confirmed. This is a direct Portal beneficiary contract, not a Flap verified Vault or an upgradeable Guardian-controlled vault.

The scheduler also checks accumulated Flap revenue and pending splitter payments, and calls `TaxProcessor.dispatch()` or `RevenueSplitter.flush()` using the platform operator wallet. This works even when the Agent has no compute. Binding checks cover the confirmed launch, factory, token, processor, native quote and recipients. Only confirmed `PlatformPaid` events create compute credit. Flap may already dispatch during ordinary trading; empty balances do not trigger extra transactions.

The `settlement` settings bound this recovery work: `minRevenueWei` (default 0.001 BNB), `maxFeeWei` (0.0001 BNB per transaction), `dailyBudgetWei` (0.01 BNB of signing commitments per UTC day), `gasReserveWei` (0.001 BNB operator reserve), and `intervalMs` (60 seconds). Unsigned retries recheck the current day's allowance and current balance. Gas reservations are conservative; pending transactions authorized earlier may confirm on a later day. Fee ceilings survive restarts and replacements. Unproductive payouts back off without starving new tax receipts. A reverted operation can retire only after canonical failure confirmation, nonce checks and a fresh successful simulation; its successor observes cooldown and receives a new budget authorization.

Use a pinned Flap metadata CID when requesting a token. The upload helper calls the documented Flap multipart API:

```sh
npm run metadata:upload -- image.png "Token description"
```

Portal V6 creates the token with 300 bps buy and sell tax, no initial purchase, native BNB quote, and the Agent's splitter as beneficiary. The worker searches the required `7777` CREATE2 suffix and persists the result. The default tax duration is ten years, not perpetual. Flap protocol fees are additional and may change; 3% token tax does not imply 3% total trading cost. Flap remains an external trust dependency: its Portal administration includes privileged tax-market-wallet updates. Immutable A2A splitter recipients do not make the upstream Flap protocol immutable.

`chain.flapDexThreshold` selects the Portal migration threshold enum (0–5, default 0). Accepted values depend on the deployed Portal; simulate the launch before funding it. The BSC testnet Portal accepted value 1 (80% sold) during integration testing. This setting does not change the fixed 300 bps tax policy.

The adapter verifies creation-event identity, tax rates, TaxProcessor market receiver and splitter recipients before marking a launch confirmed. After funding and enabling chain writes, the scheduler advances pending launches. Read-only mode does not broadcast them. A supported Flap testnet deployment is not assumed; supply and verify the actual network configuration.

Set `chain.fromBlock` to the earliest splitter activity you need to index. `confirmations` defaults to 12; this is a configurable confirmation-depth policy, not a promise of BSC fast finality. Balance monitoring uses confirmed native BNB state, so external people/programs can fund an Agent. It supplements observations with periodic polling.

## API workflow

All endpoints except `/health` require `Authorization: Bearer <token>`. Set `ADMIN_TOKEN` from your local credential and obtain user tokens through the admin API. The server never returns Agent private keys.

```sh
ADMIN_TOKEN=$(cat var/admin-token)
curl -s http://127.0.0.1:3000/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice"}'
```

Save the returned user token securely. With `USER_TOKEN` set to that value:

```sh
curl -s http://127.0.0.1:3000/agents \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Idempotency-Key: alice-token-1' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice Agent","symbol":"ALICE","meta":"YOUR_PINNED_CID"}'
```

The initial response provides the Agent ID and BSC wallet. Repeating the same key and body returns the same identity; changing the body rejects the request. Ownership is derived from the user token, never from a supplied owner ID. Initial chain state is unknown until a successful sync.

| Method and path | Authorization | Behavior |
| --- | --- | --- |
| `GET /health` | Public | Process liveness |
| `POST /admin/users` | Admin | Create user, return user credential once |
| `POST /agents` | User | Create token request, encrypted wallet and Agent identity |
| `GET /agents` | User or admin | List owned Agents, or all for admin |
| `GET /agents/:id` | Owner or admin | Public identity, qualification and balance observations |
| `POST /agents/:id/launch` | Owner or admin | Advance configured chain launch, return pending or confirmed state |
| `POST /agents/:id/exit` | Owner or admin | Disable auto-staking and request guarantee unbonding |
| `POST /agents/:id/withdraw` | Owner or admin | Claim unlocked guarantee back to the same Agent wallet |
| `GET /network/epochs` | Authenticated | Committee, generation, status, published QSP and signature |
| `POST /admin/compute/credit` | Admin | Record externally reconciled compute funding using unique reference |
| `POST /admin/compute/reconcile` | Admin | Reconcile a legacy uncertain reservation; new requests have fixed settled charges |
| `POST /admin/tick` | Admin | Trigger a scheduler pass; work proceeds in the background |
| `POST /admin/evidence` | Admin | Validate conflicting signed commitments and quarantine identity |
| `POST /admin/unjail` | Admin | Explicitly release operational quarantine after investigation |

Compute credit body: `{"agent":"ID","reference":"UNIQUE_RECEIPT","amountWei":"10000000000000000"}`. Reconciliation body: `{"callId":"ID","actualWei":"1000"}`. Neither action transfers investment principal. Manual credits require the operator to verify the funding source first.

Exit and withdrawal concern the bonded guarantee only. v0.1 does not expose arbitrary investment-wallet transfers or investment execution. Pending operations and unknown provider charges survive restart.

## Operations and limitations

Use one service process per SQLite database. Durable signing locks additionally prevent separate Journal instances from allocating conflicting sender nonces. The operator signing wallet must not be concurrently used by external programs. Do not directly edit ledger rows or clear pending transactions to force a retry.

Back up SQLite using SQLite's backup facility or after a clean shutdown; copying only the main file while WAL writes are active is insufficient. Keep keys and database backups separate. Runtime recovery retries the exact signed transaction bytes and reconciles receipts. Insufficient Gas, reverted transactions and provider outages do not authorize a new spend with a guessed nonce.

A confirmed-cursor block hash change automatically freezes affected compute spending and qualification, then starts a durable paginated canonical-log scan. Completion atomically reconciles tax credits, retains fixed request debits and legacy pending holds, and restores sync status. If orphaned income has already been consumed, the compute balance may become negative; future valid credits clear that debt. The guarantee is never used to cover it. There is no production monitoring service, remote worker transport, independent-validator consensus, or audited mainnet deployment bundled with v0.1. Smart QSP and all Agent keys remain under one operator's custody.

See [the implemented protocol](protocol.md) for election, failover and penalties. `npm test` covers SQLite recovery, authenticated ownership, RPC transaction recovery, hosted LLM calls, signed QSP production and local contract behavior. Real provider credentials and a configured network are needed for deployment-specific validation.

For a runtime-only deployment, build first in the development environment, retain `dist/`, and install with `npm ci --omit=dev`. Start with `node dist/src/main.js`. Initialize credentials with `node dist/scripts/init.js` if needed. Solidity compilation and deployment helpers require the development tooling and should run in a separate operator environment.

The Ganache development fixture currently bundles dependencies with npm audit advisories, including high and critical findings. These packages are excluded by a clean `--omit=dev` installation; do not expose the test EVM or copy the development `node_modules` tree into production. The full dependency audit is not clean.


## Autonomous recovery

The `recovery` configuration bounds normal recovery work. Research runs with `researchConcurrency` parallel tasks and at most `researchMaxAttempts` attempts per role/view. Master assignments must balance work across the available elected Workers; an invalid distribution is replaced by the published deterministic round-robin rule, with an audit record. Each role call includes its Agent identity. Retries stay inside the frozen committee, preserve fixed charges for dispatched attempts, and reuse completed work only when its author, input and source remain valid. Changed inputs in an already-used attempt require a successor view rather than silently reusing old synthesis.

Provider failures open a persisted circuit after repeated errors. Cooldown probes and subsequent bounded calls automatically test recovery. A missing `/models` discovery endpoint permits a bounded real-call probe; an unavailable data source remains explicitly missing. Whole-round timeout is not proof of Master misconduct. Repeated invalid task output can trigger operational quarantine; after its cooldown, fresh chain/budget/provider and wallet-signature health checks permit automatic recovery. Conflicting-signature isolation is stronger and cannot be downgraded by ordinary task failures or a simple cooldown.

Transaction recovery persists retry timing, intent, nonce, signed bytes and replacement hashes. Exact-byte replay uses capped attempts per cooldown window. Optional fee bumps use the same nonce, recipient, data and value; `maxGasPriceWei` caps replacement pricing and `maxFeeBumps` caps lifetime fee increases. Reverted business intents can consume another nonce only under the configured logical-attempt cap, sufficient confirmations, exclusive sender ownership and a caller-specific proof that the same intended operation remains unperformed. Arbitrary external nonce use or an unprovable chain state never authorizes a guessed new spend. Status and safe diagnostic codes remain in the SQLite transaction records.

A reorganization scan processes at most `scanPagesPerTick` pages of up to 1,000 blocks each per pass and resumes after restart. Configure `chain.fromBlock` accurately before initial ingestion. Changing it after credits have been indexed can change the reconciliation range; treat such changes as an accounting migration rather than a performance tweak. The configured RPC must provide the necessary historical blocks and logs. Unavailable evidence pauses the affected activity and is retried; it is not converted to a successful reconciliation.

### Key rotation and verified snapshots

By default, periodic maintenance uses the original RSA configuration, creates a verified SQLite snapshot in `var/backups` daily, and retains 30 matching snapshots. `recovery.walletBatchSize`, `backupDirectory`, `backupIntervalMs` and `maxBackups` configure this behavior. Rotation and backup failures are persisted and retried; one failure does not grant permission to discard wallet data. Retention runs only after a new verified backup succeeds and does not remove unrelated files or symlinks.

For key rotation, place a local keyring file under the Git-ignored `var/keys/` directory. It is an array of file references, for example:

```json
[
  {"id":"v1","publicKeyPath":"var/keys/public.pem","privateKeyPath":"var/keys/private.pem"},
  {"id":"v2","publicKeyPath":"var/keys/public-v2.pem","privateKeyPath":"var/keys/private-v2.pem"}
]
```

Set `rsaKeyRingFile` to that local file and `rsaKeyId` to the new active key. Startup validates matching RSA key pairs. Maintenance verifies and re-encrypts wallet records in atomic batches; ciphertext key IDs make interruption/restart resumable. Keep historical key files separately from database snapshots, including while older snapshots are retained. No private key is sent to an LLM or included in API responses.

Restore to a **new, absent destination** with:

```sh
A2A_CONFIG=config/local.json npm run wallet:restore -- var/backups/SNAPSHOT.sqlite var/restored.sqlite
```

Restore takes a consistent SQLite snapshot, including committed source WAL data, verifies database integrity, Agent-to-wallet bindings and wallet signatures, and refuses to overwrite any destination database/WAL/SHM files. Restoration is an explicit disaster-recovery operation, not automatic replacement of a live database: an old snapshot cannot prove that newer externally published outputs or transaction intentions never existed. Ordinary task, RPC, funding and index recovery do not require this operation. Missing all key copies or all valid snapshots is not recoverable by protocol inference.

## Live research and QSP v2

Research is enabled by default (`research.enabled`). Configure `research.rpcUrl` and `research.portfolioWallet` for read-only BSC mainnet portfolio observation. This chain is separate from `chain.id`, which identifies Agent staking/signatures and may be testnet. An unconfigured/unreadable wallet produces `UNKNOWN`, never `EMPTY`. Scope is the configured assets plus native BNB; unrelated tokens are not scanned. Bonded guarantees are held outside this portfolio wallet balance, and `research.gasReserveWei` is excluded from investable native BNB.

The first asset registry supports BSC mainnet BTCB, Binance-Peg ETH and WBNB with their explicit contract addresses. The chain/address/decimals/reference-market tuple must match the registry; changing a symbol cannot reprice an arbitrary token as BTC. Registry additions require a code change and verification. Wrapped-token issuer/depeg exposure remains a research risk.

Read-only adapters use [Binance public market data](https://developers.binance.com/en/docs/products/spot/rest-api) (60 closed one-minute candles), [DEX Screener pool observations](https://docs.dexscreener.com/api/reference), configured RPC balances, free news search and [Federal Reserve monetary-policy announcements](https://www.federalreserve.gov/feeds/feeds.htm). Market marks are **USDT reference prices**, not USD parity or DEX executable quotes. Returns/SMA use integer fixed-point inputs; volatility is the population standard deviation of one-minute returns in basis points, not annualized. DEX liquidity is conservatively rounded down to whole USD, with retrieval time and an explicitly unknown source-update time. Sources may be unavailable; missing data is retained, not fabricated.

Roles are positions, macro, market, news/social, onchain/liquidity and risk. Prompts are in `config/default.json`. Each specialist has a read-only `research_snapshot` tool plus existing `web_search`, `news_search`, and `fetch_page` tools. Framework limits remain configurable; snapshots provide deterministic calculations, and model output provides interpretations. Search headlines are index metadata; social access and full macro time series are not implied by a successful search.

Models receive formatted human-readable amounts and short evidence references. The protocol resolves references to saved source IDs/URLs, rejecting unknown references. Raw adapter evidence is retained in SQLite with hashes; external JSON decimal numbers are normalized to decimal strings before hashing. Authorized operators can retrieve `GET /admin/research/evidence/:id` using their admin token. RPC URLs and credentials are never placed in QSP evidence.

### Portfolio accounting

Wallet balances establish quantities, not purchase costs or realized profit. Costs, realized PnL and returns remain `null` when history is unavailable. Empty portfolio value is zero, while its rate of return is undefined. Previous QSP signals are unexecuted proposals and never create holdings.

An optional local `research.accountingFile` can supply a trusted accounting-adapter snapshot with `{wallet,chainId,blockHash,quoteCurrency:"USDT",realizedPnlMicros,positions:[{asset,quantity,costMicros}]}`. It must match the exact observed block and quantities; zero quantities must have zero remaining cost. `costMicros` is total remaining position cost, not unit price; quantities use token base units and money uses six decimal places. This input is intended for a future verified execution/accounting adapter, not an automatic reconstruction of trade history. A stale or mismatched snapshot is ignored with explicit missing-data flags. Capital-flow-adjusted performance is deliberately unknown until cashflow history exists; value differences must not be presented as investment returns.

Each round binds an immutable snapshot and the preceding published QSP hash. Cross-round quantity/price/value deltas are computed only for the same portfolio wallet, chain and asset scope. Changing that identity resets comparison, with an explicit missing-baseline reason. Final packages are persisted before signing so restart after commitment reuses identical bytes. Stale contexts/expired final packages cannot publish.

`research.maxAssetBps`, `maxTotalBps`, `minLiquidityUsd`, `maxSlippageBps`, `maxAgeMs` and `validForMs` bound research proposals. Targets are portfolio weights, not order sizes. BUY requires investable capital, a fresh reference price and observed sufficient liquidity; SELL requires actual holdings. Omitted positions remain held and count toward policy limits. An empty signal set is valid and explicitly leaves the portfolio unchanged. Execution, route quotes, approval transactions and distribution remain outside this release.

For on-demand multi-interval closed OHLCV candles, the market specialist has `market_klines`. The same adapter runs via `npm run market:klines -- BTCUSDT 1h 30`; see [parameters and limitations](agents.md#trend-analysis-candle-tool).
