# BSC testnet DEX adapter smoke — 2026-10-10

This validates direct DEX quotes, real signed trades and Journal receipts. It is not QSP-driven investment or six-hour stability acceptance. Assets are self-deployed test fixtures without real-world value or peg. Wallet identities below are test-only.

- Chain: BSC testnet, 97
- Router: `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`
- Test qUSD: `0x50ce37D163DcB333C5B164e6aC00E152eAD7DE9B`
- Test qBTC: `0xf3E87e6Eb773AB52f7005a46d077403b90bF9273`
- Three separate wallets each received 0.35 tBNB for current and subsequent testing, and 1,000 qUSD test units.
- Each wallet bought qBTC with 100 qUSD, then sold its entire resulting qBTC balance.
- All six swaps and supporting transactions reached two confirmations.

| Wallet | Buy | Sell | Final qBTC base units |
| --- | --- | --- | --- |
| `0x7BEf6dFcc428162492335da16bA444681ba000eB` | [receipt](https://testnet.bscscan.com/tx/0x5030e31c044d7408b87b744f629e281fb3b57e6818a69344284da995d4c12205) | [receipt](https://testnet.bscscan.com/tx/0x64083d3b4d45b1a340d082c40c3b953ecf8077170c939ca3e5b59a09f27cc596) | 0 |
| `0xdAF72eE1B704E5FF08041f37DfdAcFd6C02d782A` | [receipt](https://testnet.bscscan.com/tx/0xcc275eb1022c220d676cb81f8d963bcfb739355cfcc0eb8ffc2a8e17516c663c) | [receipt](https://testnet.bscscan.com/tx/0xe4abaf63398999bd42c9b89e5ff900e9106a545e3bae3919e3e8a717f853fe0a) | 0 |
| `0xb000cD41Aa3761E8ac7287613E6aDfE62346F90F` | [receipt](https://testnet.bscscan.com/tx/0x5369411704c26d3750dea1032f70af605595c16f0c900b966c8d168676b9bda4) | [receipt](https://testnet.bscscan.com/tx/0x1fe6e0213550aeaab203e31e368b2cdd5788765675a8dff559128619e5ac0521) | 0 |

Final qUSD balances were approximately 999.60044 each, reflecting the round-trip pool trading costs. These are test-token balances, not measured USD returns; native Gas is separate. Quote observations, signed transactions, receipts and actual fill quantities are stored in local SQLite. Private keys, RPC credentials and local databases are excluded from Git.

The rounding and receipt-identity hardening added during review is covered by regression tests. The live swaps are plumbing evidence; no claim is made that these transactions exercised the full future execution policy. See [adapter boundaries](dex-v2.md).
