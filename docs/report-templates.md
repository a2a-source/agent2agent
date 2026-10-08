# Standard Agent reports

Each research role and the Master has a separate template in [`config/report-templates.json`](../config/report-templates.json). Role prompts remain in `config/default.json`. Templates define a version, title, ordered section IDs and instructions; a configuration override may supply `reportTemplates`. The research configuration hash binds the selected templates for an epoch. Changing them during an active epoch is rejected.

| Role | Required sections |
| --- | --- |
| Positions | Holdings/funding; performance; cross-round changes; position recommendation |
| Market | Hourly trends for all configured assets; short-term comparison; scenarios; limitations |
| News | Per-asset news; source-body verification; potential impact; limitations |
| Macro | Verified policy facts; asset impact channels; scenarios; limitations |
| Onchain | Per-asset pools/liquidity; asset risks; trading constraints; limitations |
| Risk | Deterministic limits; funding/exposure; hard constraints; risk gaps |
| Master | Authoritative state; review of role evidence; proposed strategy; limitations |

A report retains `summary`, `recommendation`, `uncertainty`, `missing` and `evidenceIds`, and adds ordered `sections`. Each section contains `id`, `content` and `evidenceRefs`. The Master uses the same section structure alongside its existing `summary`, per-role `decisions`, `disagreements`, `signals` and `risks`.

For example, a **format illustration**, not real research:

```json
{
  "id": "verification",
  "content": "ETH: HEADLINE_ONLY. The indexed item was found, but publisher text was unavailable. Its event details remain unverified.",
  "evidenceRefs": ["E4"]
}
```

During generation, references may use frozen `E1` aliases or exact observed tool source URLs. Aliases are resolved to evidence IDs before publication. An invented URL/reference, omitted/reordered/duplicated section or oversized content is rejected. Missing data must be described explicitly; an empty reference list is permitted for limitations or unsupported observations marked as missing. Template conformance does not establish factual truth.

New QSP v2 packages include the selected `reportTemplates`, role sections, Master sections, and deterministic `researchChecks` (`c4/1`), all under the package signature. Validation recomputes checks and verifies section structure and reference membership. Historical packages without these optional extensions remain verifiable; consumers using older strict schemas must upgrade before reading new packages.

## Facts and hard rules

All roles see the same computed holdings, configured-token weights, limit comparisons and separate native-BNB funding exposure. Human-readable percentages are supplied alongside exact integer basis points. Native BNB is potential funding after the snapshot's Gas reserve, not a stablecoin or guaranteed execution balance. USDT is the valuation unit; holding USDT is not required to research a BUY.

Configured-token caps exclude native BNB and include WBNB. The portfolio denominator retains the existing net-Gas portfolio valuation. Exact limit comparisons use integer cross-products; rounded display weights cannot make an overweight HOLD compliant. A package without signals may still contain current violations. Unknown values remain null.

`researchChecks.hardRules` gives deterministic policy precedence over prose conditions or invalidations. A market move cannot remove a holdings-based concentration violation. This is a research artifact: no exchange route, fill or automatic trade is created.

Invalid output receives sanitized, persisted feedback within the existing attempt cap (default two attempts). A restarted task preserves its failure class and feedback. Source/provider failures are not classified as misconduct merely because a task could not finish.

## Tool and quality checks

When tools are enabled, trend reports must attempt candles for each configured symbol. News can use `asset_news` for one-call discovery across configured assets (then verify sources), and must attempt searches covering configured assets and, when searches return items, attempt a page fetch; macro must attempt a page fetch. Failed sources remain explicit missing data. These are minimum coverage checks, not proof that the sources are relevant or accurate.

Candle results include deterministic first-open/last-close returns, close-to-close changes and a close-price SMA, with timestamps and interval definitions. Page fetching prefers article/main content before truncation to reduce navigation crowding out evidence. The tool remains a bounded text extractor, not a universal browser or paywall bypass.

Live acceptance separately reviews source relevance, dates, numerical fidelity, inferred versus observed claims and Master's treatment of disagreements. Passing the schema, coverage checks or signature verification alone is not research-quality acceptance.

Asset identity guidance distinguishes [the native-BNB wrapper WBNB](https://www.bnbchain.org/en/blog/what-is-wbnb) from [Binance-pegged representations](https://www.bnbchain.org/en/blog/binance-presents-project-token-canal-2). This static mechanism description is not live reserve verification or evidence that an unrelated vault incident affects a wrapper/bridge.

Initial news items in model inputs are explicitly labelled `HEADLINE_ONLY`. The onchain role does not receive these unverified seed headlines in its initial context and focuses on pools, liquidity and asset mechanisms; it can still fetch sources through tools. News researches events and Master reviews the combined reports. This input projection does not mutate the frozen context or evidence. Master also receives a complete root-object example validated against the decision schema, separating report sections from trade fields.
