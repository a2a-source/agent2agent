# BSC97 QSP execution verification

Verified on 2026-10-10 using three independent funded test wallets, actual 0.3 BNB bonds, the official PancakeSwap V2 testnet router and real on-chain ERC20 approvals/swaps. Three trading rounds completed: two accumulation rounds followed by reduction. All 9 trading jobs finished; 24 swaps and 24 approvals were confirmed. Three later rounds verified cost-guard expiry, missing-wallet accounting coverage, and a complete quiet NO_ACTION round without further transactions.

**Boundary:** all six rounds used deterministic, committee-signed QSP fixtures and synthetic fixed test-oracle prices. They did not call an LLM or prove live research/election quality. Test tokens and reported micro-USD valuations have no asserted real-world monetary value. Initial compute credits and launch identities were explicit test bootstrap state; this run did not repeat Flap token creation or tax funding.

The harness restarted during the run and replayed completed rounds without issuing duplicate logical trades. One harness assertion initially counted new work belonging to the next round as a duplicate; it was corrected to compare transaction identities within the completed round. No duplicate transaction was found.

## Results

| Round | Scenario | Wallet jobs | Swaps | Accounting |
|---|---|---:|---:|---|
| 101 | Accumulate BTC/ETH/BNB fixture assets | 3 DONE | 9 | NAV/fills persisted; UNKNOWN cashflow in the pre-proof runtime |
| 102 | Repeat allocation against updated holdings | 3 DONE | 9 | NAV/fills persisted; UNKNOWN cashflow in the pre-proof runtime |
| 103 | Reduce BTC/ETH allocations to zero | 3 DONE | 6 | All 3 wallets have canonical zero-external-flow proofs and KNOWN NAV returns |
| 104 | BNB target still required uneconomic buys | 3 ABORTED on source expiry | 0 | No wallet observations; network UNKNOWN |
| 105 | Quiet allocation with one unavailable wallet | 2 DONE/NO_ACTION; third planning job FAILED | 0 | Two wallets KNOWN at zero; network UNKNOWN |
| 106 | Quiet allocation after prior work and leases expired | 3 DONE/NO_ACTION | 0 | All wallets and network KNOWN at zero |

Round 103 aggregate return was **-0.649837 test USD**, including pool costs and Gas through ending balances. Per-wallet figures were -0.254592, -0.178618 and -0.216627. These are test-fixture valuations, not investment performance claims. Historical UNKNOWN observations were preserved when the new proof adapter was introduced.

Each subsequent signed fixture included the latest completed execution feedback, with references to the recorded opening and closing snapshots. Jobs, source plans, concrete bindings, quotes, raw signed transactions, receipts, fills, balances, per-wallet observations and network summaries are persisted in SQLite. Local scripts, RPC configuration, keystores and database files are gitignored.

## Quiet-round and failure-boundary verification

Round 104 was initially intended as a quiet round, but its signed 1000-bps BNB target produced three READY buy orders of 16.637662–16.644273 test USD. The configured maximum fee of 0.0001 BNB per transaction, two transactions per order, and synthetic 600 USD/BNB valuation implied a 0.12 test-USD gas budget. This exceeded the 50-bps limit of approximately 0.0832 test USD per order. The executor therefore created no reservations or signed transactions. Its NEW jobs retried until the original source deadline, then all became `ABORTED / SOURCE_WINDOW_CLOSED`. The guard was not relaxed, and no historical plan or deadline was rewritten.

Round 105 used a freshly signed 850-bps BNB target with BTC/ETH targets at zero. The remaining BNB deficits were below the 10 test-USD trade minimum, so the two successfully planned wallets completed NO_ACTION with KNOWN zero PnL. Stopping the previous harness had left an unexpired sender lease for `investment-test-3`; that wallet exhausted three planning attempts with `WALLET_BUSY`. Network accounting retained all three expected wallets and correctly reported UNKNOWN, rather than treating the missing wallet as zero. This partial round remains in history.

Round 106 began after round 104 expired normally and the sender lease had expired naturally. With the same 850-bps quiet target, all three funded wallets completed `DONE / NO_ACTION`. The measured transaction-count change was zero: no approvals, swaps, fills, or fund reservations were created. Each wallet had a later confirmed closing snapshot and a persisted zero-external-flow proof with an empty transaction set and two-confirmation requirement:

| Wallet | Opening block | Closing block | Period PnL, micro-USD |
|---|---:|---:|---:|
| investment-test-1 | 135990267 | 135990292 | 0 |
| investment-test-2 | 135990264 | 135990285 | 0 |
| investment-test-3 | 135990272 | 135990300 | 0 |

These proofs cover the registered tokens and native balance of each EOA over its own recorded snapshot interval. They check canonical boundaries, nonce coverage, transfer logs and balance reconciliation; they are not a blanket claim that all possible external assets or arbitrary future intervals have no flows. KNOWN zero PnL reflects unchanged tracked balances and the fixed synthetic prices, not a live-market return. Network PnL was KNOWN at zero, and the persisted next-research evidence selected round 106 with all three wallet observations.

Local evidence is retained in `var/testnet/investment/qsp-execution-e2e.sqlite`, `qsp-execution-quiet-result.json`, and `qsp-execution-quiet-106.log` in the same directory. The earlier quiet-run logs and incomplete rounds were preserved. The aggregate trading count remained 48 transactions and 24 fills; preparation deployments, pool provisioning and initial stakes are separate fixture activity.

## Deployments

| Asset | Test address | Fixed fixture valuation |
|---|---|---:|
| qSTABLE | `0x50ce37d163dcb333c5b164e6ac00e152ead7de9b` | 1 |
| qBTC | `0xf3e87e6eb773ab52f7005a46d077403b90bf9273` | 100000 |
| qETH | `0xaf45bf26ec0551c683037729cecf6111dc89a60b` | 3000 |
| qBNB | `0xd1dfd4ec26fe763277cf2dbd1232db2b4050820a` | 600 |

Router: `0xd99d1c33f9fc3444f8101754abc46c52416550d1`. Stake contract: `0xeed3bc5fd1c31ba28bb348dc418b477eb30aa2fe`. All three wallets were observed with exactly 0.3 BNB bonded and no pending exits.

## Swap receipts

| Round | Wallet | Side | Transaction |
|---|---|---|---|
| 101 | investment-test-1 | BUY BTC | [0x256ae91d…](https://testnet.bscscan.com/tx/0x256ae91db76f4e96d87ff0a3d9c5dce2e7465a168e4f33fa3bc22088ffb4813b) |
| 101 | investment-test-1 | BUY ETH | [0xfb032b61…](https://testnet.bscscan.com/tx/0xfb032b619cb7d618df18488d4743dc76f3e0a9d4ca44bdff69665c6305732c4a) |
| 101 | investment-test-1 | BUY BNB | [0x5f4ea4a4…](https://testnet.bscscan.com/tx/0x5f4ea4a4dd0ba0f1f9d1b822f19413c704b56f936d26388d51fb9c4ef5c3c037) |
| 101 | investment-test-2 | BUY BTC | [0x6aef079f…](https://testnet.bscscan.com/tx/0x6aef079f14a803080478648724f68fb3c97bb63734ca1e4164bd6987a522d72b) |
| 101 | investment-test-2 | BUY ETH | [0xa9f294cb…](https://testnet.bscscan.com/tx/0xa9f294cb3fad36c7d3472805e19a5bbc2d9cc62f9cfc1396df477ac5b27650a5) |
| 101 | investment-test-2 | BUY BNB | [0xc82e365f…](https://testnet.bscscan.com/tx/0xc82e365f781407fedc273989f4f7819180b656f9ac901ca8371f3a1679870e13) |
| 101 | investment-test-3 | BUY BTC | [0x07852ace…](https://testnet.bscscan.com/tx/0x07852acef3df363d7640dfb52eab322677c53f44f3f29811428cd88f35bf18b0) |
| 101 | investment-test-3 | BUY ETH | [0xc415c6bf…](https://testnet.bscscan.com/tx/0xc415c6bfc0f1c6e6a09185747fc5799d736adb3a99772bbedb280da2714aed04) |
| 101 | investment-test-3 | BUY BNB | [0xcbe8bb3f…](https://testnet.bscscan.com/tx/0xcbe8bb3f3bc3bc5a1efdd734c519230f92cd84db67e0258073ec418b8d2964fd) |
| 102 | investment-test-1 | BUY BTC | [0x3d80bf27…](https://testnet.bscscan.com/tx/0x3d80bf27ed77da6f77deb0e5226673de4da310d57f816d4e6ec98f61949d019d) |
| 102 | investment-test-1 | BUY ETH | [0x3ee74d33…](https://testnet.bscscan.com/tx/0x3ee74d33fa995744b58987d138e6dce529f9aedf62bb3d62424bd3a64182bf10) |
| 102 | investment-test-1 | BUY BNB | [0x1659e5ea…](https://testnet.bscscan.com/tx/0x1659e5ea66883fdc8bacc21b453d939e90f791356f7d754e6548361db0c66615) |
| 102 | investment-test-2 | BUY BTC | [0x7e5d7bd8…](https://testnet.bscscan.com/tx/0x7e5d7bd8aab617502728c6a91ea058414d505b55012a714f96c133ec30e399f7) |
| 102 | investment-test-2 | BUY ETH | [0x5adc87a7…](https://testnet.bscscan.com/tx/0x5adc87a71e33affea01f57b526146be9096dcbc68ab6267f6bd4e444068e93fb) |
| 102 | investment-test-2 | BUY BNB | [0x3e38ed83…](https://testnet.bscscan.com/tx/0x3e38ed8353f01fd5cd26a6dcde32175bd3cd90a6c7b2062247e389d067c3e812) |
| 102 | investment-test-3 | BUY BTC | [0x689e5133…](https://testnet.bscscan.com/tx/0x689e5133121ee49d9ada51f23a42cf9df1d31955bcf40269ad195b095485f1c2) |
| 102 | investment-test-3 | BUY ETH | [0x64f13f8f…](https://testnet.bscscan.com/tx/0x64f13f8fc177cf73ca07073d27d5388d0ec1b7cc675a15e7d8d003c9b4b75078) |
| 102 | investment-test-3 | BUY BNB | [0x4a307253…](https://testnet.bscscan.com/tx/0x4a307253cbb46333ddefa2e1c589e25faafa9a48612c9cd4bd390fb401f33a93) |
| 103 | investment-test-1 | SELL BTC | [0x40aa5e00…](https://testnet.bscscan.com/tx/0x40aa5e000681da7a8dd9f3f1139d39cc280e158b80520fb8224e4c7d52c806cb) |
| 103 | investment-test-1 | SELL ETH | [0x4810d858…](https://testnet.bscscan.com/tx/0x4810d8583324ffa50368f9918c49a06a951f41935f0c4955b81ede98435b9f49) |
| 103 | investment-test-2 | SELL BTC | [0xc3758a63…](https://testnet.bscscan.com/tx/0xc3758a632be66a24cb8d216203ae2c17a39abbf730e7a6ba885b6cf28493e22c) |
| 103 | investment-test-2 | SELL ETH | [0xd0c89b29…](https://testnet.bscscan.com/tx/0xd0c89b29ebf1696c51223786c679c071a78b3a3527e9c4023185432f4deec104) |
| 103 | investment-test-3 | SELL BTC | [0xb33b9249…](https://testnet.bscscan.com/tx/0xb33b92491c0fd17ad40ef280267ea2ca02210f28c820885fe8ae1b2edf82a0e6) |
| 103 | investment-test-3 | SELL ETH | [0x48d8f46d…](https://testnet.bscscan.com/tx/0x48d8f46d0b153013d8794507a23dc859f8b56e0b563a02130aac601ae83fb4e1) |

This evidence is a bounded real-chain execution test, not a six-hour stability acceptance. Live LLM-to-execution testing, prolonged cadence/failover verification and priced external-flow accounting remain separate acceptance items. The native scenarios below separately verify native BNB conversion.

## Subsequent live research checks

A separate run used real OpenRouter free-model calls, the production role prompts, research task recovery and committee confirmation. It combined actual underlying BTC/ETH/BNB market/news research with explicitly labeled BSC97 fixture valuations, actual wallet balances and pinned test-pool reserves. Registration and compute credits remained a laboratory bootstrap; this did not repeat token launch or tax funding acceptance.

Epoch `1791642074908` published a committee-confirmed QSP after 22 dispatched model requests. It had no stable allocation: two fixture pools were below the unchanged research liquidity floor, and the Master retained market uncertainty. An explicit underlying-news mapping issue was fixed while preserving completed reports and failed attempts. Publication without an allocation is not evidence of LLM-driven trading.

Operator-owned fixture liquidity was then redistributed on-chain so BTC, ETH and BNB pools exceeded that floor, without reducing the risk threshold. Epoch `1791643428357` consumed round 106 accounting feedback and the refreshed pool evidence. Five role reports completed, including bounded retries for invalid output. The remaining onchain role exhausted its two attempts after a 240-second provider timeout; no new QSP or trade resulted from this attempt. At that point the separate research database contained 54 dispatched requests in total. These outcomes are retained for subsequent scheduler recovery; neither failed output nor a null allocation is rewritten into a trade signal.

The 24 confirmed swaps above therefore remain a signed-fixture-QSP execution proof. Full live-LLM-to-trade acceptance and the six-hour stability verdict must be established separately from these research outcomes.

The first long-run attempt was interrupted and retained with a `NOT_ESTABLISHED` verdict. Read-only replay identified a laboratory configuration change across the unfinished epoch: single-round mode used an 80-request daily limit, while long-run mode used 800. The immutable research configuration hash correctly rejected that change. At takeover, the frozen research context had also exceeded its 30-minute lifetime. Neither changing the Master nor retrying with the old configuration could repair that round.

The runner now records allowlisted failure codes and automatically terminates an unconfirmed round whose frozen research configuration changed or whose context expired. Generation and confirmation fences remain enforced; the scheduler waits the normal end-relative interval before collecting fresh data for a new round. Provider failures retain the existing takeover path. A new full-duration run is required after this correction; the interrupted interval is not counted as six-hour acceptance.

## Native BNB funding scenarios

A separate chain97 run on commit `14fb20b` used a newly created independent Worker, `0xFf5A746F6b913F52023364A98Aa4dC00974dC796`, with an actual 0.3 BNB bond and initially no registered ERC20 holdings. Its investment wallet received 0.32 tBNB before bonding. The separate registry uses canonical testnet WBNB `0xae13d989dac2f0debff460ac112a837c89baa7cd`; it does not reinterpret earlier qBNB plans. Router `WETH()`, factory and runtime code identities were checked. Operator-owned liquidity supplied 10 tBNB and 6,000 fixture qUSD to pair `0x3eA4bAc2Bd9DF671aF6A98fE7A8BB964a591B4B6`.

| Round | Scenario | Result | Period PnL, micro test-USD |
|---|---|---|---:|
| 201 | Native-only funding; signed BNB reduction | One payable swap, no approval; 0.01881764245 tBNB became approximately 11.246883 qUSD | -48348 |
| 202 | Fresh BTC allocation against small proceeds | NO_ACTION / BUY_BUDGET_BELOW_ECONOMIC_FLOOR; no transaction | 0 |
| 203 | Explicit external funding of 200 fixture qUSD before the opening snapshot | One capped 20.165710 qUSD BTC buy, with one approval and one swap | -45815 |

All three jobs finished with KNOWN wallet and network accounting. Confirmed closing snapshots, native-aware zero-external-flow proofs, canonical fills and subsequent-round feedback were persisted. The test reverified each fill from its canonical receipt and checked the BTC buy against the 10% available-stable budget. The 0.3 BNB bond remained unchanged. No native Gas refill was needed between these rounds; reduction retained protected Gas and operating fee headroom. Subsequent signed allocations retained a small 100-bps BNB target to accommodate that residual without bypassing the planner's reduction-first rule.

Native swap: [0x56f36dad…](https://testnet.bscscan.com/tx/0x56f36dadde107cdfb0f2f57bd797a4e9c744e784a8f1616c7c62a30c1b82f013). BTC swap: [0x4c199e99…](https://testnet.bscscan.com/tx/0x4c199e99d95192c012f3d4971ee031cb14acd8ad3403866877c9160843b2e934).

These three scenarios used synthetic committee-signed QSP fixtures and fixed test-oracle valuations, not live LLM signals. Round203's additional qUSD was external test funding, not profit or proceeds attributed to round201. This verifies the native execution/accounting path separately; it does not establish the real-LLM trading loop or six-hour stability acceptance. Local evidence is retained in `var/testnet/investment/native-execution-e2e.sqlite` and `native-execution-e2e-result.json`.

The corrected scheduler subsequently ended the obsolete round and automatically opened epoch `1791643428358` after its normal interval. That round dispatched 25 additional real model requests (79 total in the research database). Positions and macro completed; market/news exhausted their bounded output-validation retries. Read-only replay identified misplaced tool URLs in frozen `evidenceIds`, object-valued section content with extra template fields, and two news sections exceeding the unchanged 2,400-character bound. Retry feedback now identifies sanitized field/type/length errors and distinguishes frozen evidence IDs from observed tool-source URLs; report prompts explicitly require concise string sections. These corrections have automated regression coverage, but this unsuccessful live round remains a failure and is not traded-QSP evidence.
