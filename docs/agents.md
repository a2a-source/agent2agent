# Agent framework, roles and research tools

**English** | [简体中文](agents.zh-CN.md)

This guide describes the research capabilities implemented in the current release. See [usage](usage.md) for operational configuration and [protocol behavior](protocol.md) for elections, recovery and signatures.

## Technology and collaboration

| Layer                | Implementation                                                            | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Service and storage  | Node.js 22.13+, TypeScript, SQLite                                        | API, task state, budgets, evidence and recovery records; no cache service required   |
| Agent framework      | LangChain `createAgent`, backed by LangGraph                              | Bounded ReAct cycles of model calls, tool calls, observations and further analysis   |
| LLM integration      | `ChatOpenAI` from `@langchain/openai`, OpenAI-compatible Chat Completions | Model calls through a configurable endpoint, OpenRouter by default                   |
| Network coordination | A2A Smart QSP                                                             | Qualification, committee selection, Master rotation, task recovery and publication   |
| Research output      | QSP v2, Zod validation, signatures and evidence hashes                    | Context, specialist reports, Master decisions, strategies and previous-round linkage |

Each round collects and freezes a research context. The protocol-selected Master assigns roles, specialists analyze the shared context independently and call tools as needed, and the Master synthesizes their reports. It records accepted, rejected or qualified recommendations and disagreements before producing a programmatically validated QSP. Roles are task responsibilities rather than permanent node assignments: a Worker can cover multiple roles when the network is small.

LangChain runs individual model/tool loops. A2A implements elections, wallets, budgets and publication separately. Nodes have distinct identities, wallets and analysis tasks; their runtime and signing keys are currently hosted by the platform.

## Roles

All six specialists share the four baseline read-only tools below; `market` additionally receives `market_klines`, and `news` receives `asset_news`. `research_snapshot` emphasizes different sections for each role. Initial task context also includes the round's research information; these views are not access-control boundaries.

| Role ID     | Responsibility                                                                                 | Snapshot focus                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `positions` | Holdings, cost basis, unrealized/realized PnL, returns and concentration                       | Portfolio and cross-round changes                                                             |
| `macro`     | Market regime and dated policy catalysts; distinguish facts from scenarios                     | Markets, news and changes                                                                     |
| `market`    | Prices, trends, moving averages and volatility                                                 | Market metrics and changes                                                                    |
| `news`      | News, announcements and narratives; distinguish indexed headlines, verified content and rumors | News and announcements                                                                        |
| `onchain`   | Onchain holdings, wrapped-asset exposure and DEX liquidity                                     | Liquidity and portfolio identity                                                              |
| `risk`      | Concentration, market/liquidity risk, missing evidence and disagreements                       | Portfolio, markets, liquidity, policy and changes                                             |
| Master      | Assign roles, synthesize reports, handle disagreements and generate strategies                 | Receives complete context and reports directly; no external search tools registered currently |

## Tools

| Tool                | Input                   | Implementation and output                                                                                                                | Limits                                                                                                                         |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `web_search`        | `query`                 | DuckDuckGo HTML search; indexed titles and links                                                                                         | No search API key required; best-effort availability; results are not article bodies                                           |
| `news_search`       | `query`                 | Google News RSS; up to five headlines, links and parseable publication dates                                                             | No search API key required; not fact verification or a Twitter/X interface                                                     |
| `asset_news`        | `lookbackDays` (1 or 7) | News-role batch discovery across configured BTCB/ETH/WBNB; resolves exact-title publisher candidates for at most two headlines per asset | Up to three fixed news queries plus six bounded title searches; still index metadata until `fetch_page` returns publisher body |
| `fetch_page`        | `url`                   | Public HTTPS page retrieval; up to 12,000 characters of body-first extracted text (512,000-byte response cap)                            | No JavaScript execution; destination, redirect, size and timeout restrictions; publication time may be unknown                 |
| `research_snapshot` | Empty object            | Frozen role data, evidence references and missing inputs                                                                                 | Does not refresh markets, sign transactions or execute orders                                                                  |

Tool results are untrusted data, not instructions. SQLite records bind observations to tool names and arguments for audit and replay checks. News tasks require the role to attempt at least one publisher candidate for each asset where one was found. Google News RSS/index wrappers and empty fetches do not count as article bodies. A report can still use `HEADLINE_ONLY` when a publisher is unavailable; `FULL_TEXT` is valid only after a nonempty publisher body was returned.

## Trend-analysis candle tool

The `market` specialist can call `market_klines` to retrieve closed candles from a fixed official Binance public spot endpoint. It returns structured chart data rather than an image, suitable for analysis and downstream plotting.

| Parameter  | Supported values                    | Default  |
| ---------- | ----------------------------------- | -------- |
| `symbol`   | `BTCUSDT`, `ETHUSDT`, `BNBUSDT`     | Required |
| `interval` | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` | `1h`     |
| `limit`    | 1–100 closed bars                   | 30       |

Output includes open/close timestamps, OHLC, base-asset volume, USDT quote volume and trade count. Prices and volumes retain decimal-string precision. UTC timestamps, closed bars, continuity, price ranges and freshness are checked. Provider failure or invalid data produces explicit missing information, with no fabricated data or unverified fallback source.

No exchange API key is required. Existing tool-loop limits and evidence recording apply. Retrieval can occur after the frozen round snapshot: candles are supplementary evidence and cannot replace that snapshot or relax strategy validation. Only Binance is currently integrated; other exchanges need additional adapters.

The same implementation is available as a CLI:

```sh
npm run market:klines -- BTCUSDT 1h 30
npm run market:klines -- ETHUSDT 15m 60
```

Sources: [candle tool](../src/market-klines.ts), [CLI](../scripts/market-klines.ts). Endpoint fields follow the [official Binance spot market reference](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market).

## Automatically collected context

These adapters run before research starts; they are not additional model-callable tools.

| Source                                           | Context supplied                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Binance public market data                       | Closed one-minute BTC/ETH/BNB candles, reference prices, moving averages, price changes and volatility |
| DEX Screener                                     | BSC pools and observed liquidity for configured assets                                                 |
| Configured BSC RPC                               | Native/configured-token balances at a common observation block, wallet and chain identity              |
| Google News RSS and official Federal Reserve RSS | News index entries and dated monetary-policy announcements                                             |
| Optional local accounting snapshot               | Cost basis and realized PnL inputs matching the observed block and quantities                          |

The current registry supports BSC mainnet BTCB, Binance-Peg ETH and WBNB. Prices are USDT reference marks, not executable DEX quotes. Volatility is the population standard deviation of one-minute returns, not daily or annualized volatility. Missing costs, returns, social data and macro time series remain explicitly unknown. Deposits are not profit, and prior signals are not fills.

## Prompts and configuration

Master and specialist business prompts live in [config/default.json](../config/default.json), separate from source code but together in one configuration file, rather than one file per role.

| Setting                        | Purpose                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `masterPrompt`                 | Master assignment and synthesis instructions                     |
| `roles[].id`, `roles[].prompt` | Role identity and research responsibilities                      |
| `llm.endpoint`, `llm.model`    | OpenRouter or another compatible endpoint, and model selection   |
| `llm.apiKeyFile`               | Local credential file path; credentials are not committed        |
| `agent.toolsEnabled`           | Enable tools for specialist research                             |
| `agent.maxToolRounds`          | Tool-loop limit per task; default 10                             |
| `agent.maxToolCalls`           | Total tool-call limit per task; default 20                       |
| `research.*`                   | Wallet, RPC, assets, accounting input, risk and freshness limits |

The checked-in model setting is `openai/gpt-6.1-sol`; availability depends on the connected provider. Free models can be selected in local configuration and are not the repository default. The chosen model must support the tool calling and structured JSON output required by its tasks.

Local configuration can override prompts. Overriding `roles` replaces the entire array rather than merging by role ID. Configuration loads at startup and changes require a restart. Existing task identities bind their original configuration, so changing a prompt cannot silently rewrite an in-progress task. Code also supplies JSON-output instructions, evidence rules and validation constraints; not all instructions are externalized.

## Outputs and current limits

QSP v2 carries context, each specialist's summary/recommendation/uncertainty/missing inputs/evidence, Master synthesis and role decisions, and strategies with target weights and risk conditions. SQLite retains source evidence for the admin evidence API. Internal model reasoning is not published as a protocol report.

Validation checks structure, evidence membership, context binding, holdings and quantitative policy. It does not guarantee factual correctness of prose. Models may confuse metrics or calculate incorrect totals, and a Master's acceptance is not proof of a claim. Empty signals are valid. Dedicated Twitter/X access, complete macro time series, onchain flow analysis interfaces, order execution and profit distribution are not implemented.

## Source map

- [Agent runtime](../src/agent-runtime.ts): LangChain, tool wrappers and loop limits.
- [Search tools](../src/research-tools.ts): web search, news search and page retrieval.
- [Research data and role snapshots](../src/research-data.ts): adapters and `research_snapshot`.
- [Research rounds](../src/research-round.ts): assignments, reports and Master synthesis.
- [QSP v2](../src/qsp-v2.ts): payload, evidence and strategy validation.

## Research guidance and Master review

Role prompts specify assets, research questions, news freshness, common candle horizons and tool selection. Each task also receives asset/reference-market mappings, its research objective and available tools. Empty portfolios can still produce evidence-based watch conditions, without inventing capital or holdings.

Master receives reports and content-hash-checked tool excerpts, retaining tool inputs, source times, missing information and truncation flags; full observations remain auditable by evidence hash. Snapshots explicitly distinguish window returns, SMA deviation and one-minute return volatility. At the tool-round limit, the final model call explicitly requests synthesis without further tools. These mechanisms improve reviewable context, not guarantee factual correctness of every model statement.

See [standard role and Master report templates](report-templates.md) for required sections, deterministic checks and quality boundaries.

With tools enabled, trend/news/macro have minimum research-attempt coverage checks. Positions and risk may use their supplied snapshots directly. Missing source data is reported explicitly, not counted as successful evidence verification.

News provenance validation applies to the explicit `status=FULL_TEXT` field in standardized news rows. It requires the original discovered headline, a matching fetched page title, a nonempty body that is not a recognized challenge page, and the actual final URL in both `publisherUrl` and `evidenceRefs`. Exact-title web-search recovery is supported for previously discovered headlines. Redirect destinations are recorded by `fetch_page` as `finalUrl`, alongside `requestedUrl` and `pageTitle`. Title matching is conservative and can reject valid articles; use `HEADLINE_ONLY` when identity cannot be established. These checks do not validate arbitrary natural-language claims, all possible access barriers, article completeness, or publisher truthfulness.

The positions and Master prompts include a funding sanity check: a portfolio entirely in native BNB with zero configured tokens has no configured-token cap breach. Master is instructed to correct role prose that contradicts the frozen facts, including in its decision reasons; this prompting aid does not replace deterministic signal validation.
