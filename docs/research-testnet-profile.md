# BSC97 research test asset profile

Mainnet research keeps the fixed BTCB/ETH/WBNB registry. BSC97 research requires an explicit complete test mapping and commitment in configuration:

```ts
research: {
  chainId: 97,
  assets: testAssets,
  testnetProfile: {
    kind: "bsc97-test-assets/1",
    registryHash: researchAssetRegistryHash(testAssets),
  },
}
```

`testAssets` must contain exactly three distinct contract addresses and symbols, mapped once each to `BTCUSDT`, `ETHUSDT`, and `BNBUSDT`, with explicit decimals. `researchAssetRegistryHash` is exported by `src/research-context.ts`. It hashes the full mapping using protocol SHA256 after lowercasing addresses and sorting by market symbol; the result is 64 lowercase hex characters without `0x`.

The collector includes the profile in the research context, so context hashes, Master signatures and committee confirmation bind it together with the full asset universe. QSP and stable allocation validation reject missing or mismatching profiles, incomplete mappings, and profiles on any other chain. Mainnet validation remains unchanged. Wallet execution consumers must still compare signed asset identities against their locally configured portfolio registry.

These are synthetic test assets using reference market symbols; the profile does not establish backing, economic equivalence, or executable liquidity. The public research DEX adapter remains mainnet-only. Testnet positive allocations still require fresh matching market and DEX evidence; enabling this profile does not manufacture that evidence or relax allocation limits.

Tests may use `stableFixture(epochId, {chainId: 97, assets, testnetProfile}, {now})` to create locally signed committee fixtures. The optional timing argument gives a 600000ms default validity/freshness window; omitting it preserves historical test timings.
