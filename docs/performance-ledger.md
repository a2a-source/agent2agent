# Round performance ledger

`PerformanceLedger` accepts trusted accounting observations and persists each revision in SQLite. It does not fetch prices, discover holdings, verify chain provenance, execute trades, or authenticate an adapter. Durable unknown observations on terminal rounds are **not live trading or performance acceptance**. A real collector and fill/accounting pipeline must supply complete snapshots and boundary cashflows before PnL becomes known.

```ts
const ledger = new PerformanceLedger(store);
const round = ledger.recordRound({
  version: "performance-input/1",
  currency: "micro-USDT",
  roundId: "round-1",
  chainId: 1,
  windowStartMs: 1000,
  windowEndMs: 2000,
  observedAt: 2100,
  roster: [
    {
      agentId: "worker-1",
      wallet: "0x0000000000000000000000000000000000000001",
    },
  ],
  perAgent: [
    {
      agentId: "worker-1",
      openingNAV: "100000000",
      closingNAV: "121000000",
      netCapitalFlow: "20000000",
      cashflowComplete: true,
      hasCapitalFlows: true,
      missingReasons: [],
      investments: [
        {
          investmentId: "position-1",
          openingNAV: null,
          closingNAV: null,
          netCapitalFlow: null,
          cashflowComplete: false,
          missingReasons: ["VALUATION_UNAVAILABLE"],
        },
      ],
    },
  ],
});
```

All amounts are nullable canonical decimal integer strings in micro-USDT (one USDT is 1,000,000 units), with at most 78 digits excluding sign. NAV is nonnegative; capital flow and PnL are signed. Numbers, decimals, exponent notation, leading zeros, and negative zero are rejected. Unknown values are `null`, never fabricated zeros. Investment NAV and cashflow keys are required but may be null. Optional investment `realizedPeriodPnL` and `closingUnrealizedPnL` default to null and are explicitly marked `componentSource: "trusted-adapter"`; they do not establish or override period PnL.

For both investments and agents, `periodPnL = closingNAV - openingNAV - netCapitalFlow`, only when all three amounts and complete cashflow coverage are known. Agent PnL always uses portfolio NAV, never the sum of investment rows. Positive net capital flow represents additions to the measured boundary; negative represents removals. Deposits and movements across tax/staking boundaries must be classified by the adapter consistently and excluded from gains. Funds reserved but still owned remain in NAV. Gas already reflected in closing NAV must not be deducted again. Boundaries and price conventions must remain consistent across the observation window.

Every roster member gets an agent record; omitted observations become explicit unknown rows. Network `periodPnL` is null until every roster member has known PnL. `knownPeriodPnL`, `knownAgentCount`, and `missingAgentCount` describe partial coverage. The known subtotal is zero with zero known agents; that is not a known network result. Investments that are known to the adapter must each be listed, including unknown valuation rows; the ledger cannot discover omitted investments.

`periodReturn` is an exact rational `{numerator, denominator}`, without multiplying by 100. It is available only with positive opening NAV, complete PnL, zero net flow, and explicit `hasCapitalFlows: false`. This flag defaults to null: net zero alone is insufficient because deposits and withdrawals may offset. Network returns use total portfolio PnL divided by total opening NAV and require no flows for every agent; individual returns are never summed.

Schemas reject unknown keys. Roster size is 1–1000; each agent permits up to 1000 investments, with 10,000 investments maximum per round. IDs are 1–160 ASCII letters, digits, `_`, `.`, `:`, or `-`. Missing-reason arrays contain at most 32 strings of 1–240 characters. Wallets use valid nonzero EVM addresses, checksum validation for mixed case, and normalize to lowercase. Duplicate roster IDs/wallets, agent observations, and investment IDs within an agent are rejected; an investment ID is scoped to its agent. Agents outside the roster are rejected. Timestamps are nonnegative safe integer milliseconds, with `windowStartMs < windowEndMs <= observedAt`. Chain IDs are positive safe integers.

Identical normalized input returns the original immutable record, including after restart or newer corrections. Array order for roster, agents, and investments and address casing are normalized. A changed input for the same `(chainId, roundId)` requires `supersedes` equal to the current revision hash; stale or missing values throw `PERFORMANCE_REVISION_CONFLICT`. `supersedes` is excluded from the observation hash. Each correction appends a revision and preserves every previous row. No adapter signature or onchain authenticity is implied by these hashes.

Records use kinds `performance-input` (normalized original input), `performance-round` (network result plus nested agents), `performance-agent`, and `performance-investment`. IDs and revision hashes use the repository's canonical SHA-256 hash. A single Store transaction writes all rows. Schema errors throw `PERFORMANCE_INVALID_INPUT` before any write. SQLite/storage errors preserve their original failure and roll back writes.

`latest(roundId, chainId?)` returns the latest revision or undefined. If multiple chains share the round ID, omitting the chain throws `PERFORMANCE_CHAIN_REQUIRED`. `list(roundId?)` returns all preserved revisions ordered by round ID, chain ID, then revision. Queries currently scan stored round records; callers should paginate externally for large histories. Store ownership remains with the caller.

## Scheduler and read APIs

The application wires `RoundPerformanceCapture` into scheduler polling before LLM/provider-health gates and after a research run completes. Both published and failed rounds are included; restart fills missing records idempotently. Agents created before the recorded round end form the roster, including Agents no longer eligible to trade. Until canonical valuation/cashflow adapters are connected, these generated rows explicitly contain unknown NAV and flows and `CONFIRMED_VALUATION_AND_FLOW_ADAPTER_PENDING`. They are durable coverage records, not live return calculations. Unknown historical round-end times are flagged separately. The initial accounting window starts at the earliest known roster creation time, subsequent windows at the preceding captured terminal boundary; no opening value is invented.

Authenticated `GET /agents/:id/performance` returns up to100 stored revisions containing that Agent, with existing owner/admin access rules. `GET /network/performance` returns up to100 latest round aggregates without individual wallet/agent records. There is no public write/correction API; only trusted adapters call `recordRound`. Missing/unknown observations require an explicit new revision when real data becomes available; the capture job never overwrites them with zero.

API history limits apply after chronological `windowEndMs` ordering, not string round-ID ordering. Unknown historical boundaries are not precise accounting intervals: fallback end time is marked `ROUND_END_TIME_UNKNOWN`, and the following round carries `ROUND_START_TIME_UNKNOWN` rather than inheriting that fallback as a confirmed opening boundary. `OPENING_BOUNDARY_BASELINE_ONLY` identifies the initial/uncertain baseline; real adapters must supply corrected windows together with actual values. A wallet created exactly at the recorded end is included. If its first interval would have zero duration, the unknown coverage record uses a one-millisecond envelope with the baseline flag; it is not a measured return interval.

## Terminal observations in micro-USD

Production and the source testnet harness now construct `createRoundObservationCapture`, independently of trading being enabled. It records every PUBLISHED or FAILED epoch, including null allocations, without creating a plan, reservation, signature, execution job or transaction. The old two-argument `RoundPerformanceCapture` constructor remains an explicit legacy placeholder mode with the v1 behavior described above.

The observation path uses `performance-input/2` / `performance-round/2`, currency `micro-USD`. Streams are isolated by chain, round and currency; `latest(roundId, chainId)` still defaults to legacy micro-USDT, while USD callers explicitly supply `"micro-USD"`. Legacy records and hashes are unchanged. The API groups by currency and exposes observation IDs, nullable boundaries, terminal status/time and roster completeness. Never combine these USD figures with USDT reference marks.

Each terminal transition freezes an additive full Agent/wallet roster without changing signed epoch content. Historical records without that roster carry `ROSTER_HISTORY_INCOMPLETE`; old unseen backlog also carries `HISTORIC_BOUNDARY_UNAVAILABLE`. Only the newest unseen event may establish a current baseline. Missing terminal times remain null. The first closing capture establishes a baseline; opening holdings come only from the immediately preceding observation's matching wallet/registry closing snapshot. Missing predecessors, changed registries, new wallets and nonadvancing blocks cannot invent a positive interval.

`collectAt` reads all registered assets and native EOA holdings at one confirmed block. It verifies the pinned number/hash/time and canonical recheck, uses historical block time for oracle age, and retains actual read time and historical validity. Normal execution collection still requires current freshness. Accounting excludes no gas reserve or reserved capital: economic NAV includes all registered owned holdings. Raw partial observations remain durable after a failed asset read, but partial valuation never becomes zero NAV.

Results cover actual confirmed **inter-observation windows**, often later than the research terminal event; they are not exact research-slot or strategy-attributed returns. No trade does not imply no return. Only a verified complete no-external-flow proof makes NAV delta PnL. Gas is reflected once in closing NAV. Full network PnL requires every frozen wallet over common boundaries plus complete roster history. Known subtotal and missing wallets remain separate when coverage is incomplete.

The observer persists fixed boundaries, attempt identities, phase budgets and fenced leases. Defaults are three wallets per tick, three attempts per capture/proof/pin phase, 30-second retry, 120-second lease and 600-second discovery deadline. For real allocations it waits read-only for planning disposition and terminal execution jobs before pinning; polls do not consume RPC attempts. On settlement deadline it permits one final bounded capture attempt and marks unsettled coverage. Other exhausted work completes UNKNOWN. Initial PENDING and final COMPLETE revisions are immutable and atomically projected into the ledger; intermediate retries do not create revisions. DONE captures can be recovered after a crash, while partial attempts use new identities. Scheduler accounting runs in the background and is drained at stop.

Missing adapters still produce durable UNKNOWN USD records. No automatic repair or post-completion deep-reorg watcher is provided. Completed UNKNOWN is a truthful accounting outcome, not execution acceptance. Registry/oracle/test-profile scope remains `REGISTERED_ASSETS_AND_NATIVE_EOA`, not all possible wallet wealth.
