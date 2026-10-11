import { formatUnits } from "ethers";
import type { ResearchContext } from "./research-context.js";

const NATIVE = "0x0000000000000000000000000000000000000000";
const CANONICAL_WBNB: Record<number, string> = {
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  97: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
};
/** Readable frozen observations only: not signed facts, targets or execution authority. */
export function researchSemanticsBrief(c: ResearchContext) {
  const known = c.portfolio.status !== "UNKNOWN";
  const nav =
    known && c.portfolio.valueMicros !== null
      ? BigInt(c.portfolio.valueMicros)
      : null;
  const holdings = c.portfolio.positions.map((p) => {
    const asset = p.address.toLowerCase();
    return {
      asset,
      symbol: p.symbol,
      inResearchUniverse: c.universe.some(
        (a) => a.address.toLowerCase() === asset,
      ),
      quantity: known ? formatUnits(p.quantity, p.decimals) : null,
      valueUSDT:
        known && p.valueMicros !== null ? formatUnits(p.valueMicros, 6) : null,
      weightPercent:
        known && p.valueMicros !== null && nav !== null && nav > 0n
          ? formatUnits((BigInt(p.valueMicros) * 100000000n) / nav, 6)
          : null,
      mechanism:
        CANONICAL_WBNB[c.chainId] && asset === NATIVE
          ? "NATIVE_BNB"
          : asset === CANONICAL_WBNB[c.chainId]
            ? "CANONICAL_NATIVE_WRAPPER"
            : "UNVERIFIED",
    };
  });
  const native = holdings.filter((p) => p.asset === NATIVE);
  const gasReserveWei = c.portfolioIdentity?.gasReserveWei ?? null;
  const nativeBalanceWei = c.portfolioIdentity?.nativeBalanceWei ?? null;
  return {
    version: "research-semantics-brief/1",
    quantityGuidance:
      "Holdings quantities below are natural token units for prose; facts.assets[].quantity and facts.nativeFunding.quantity are integer base units with decimals. Never label base units as whole tokens. Small nonzero quantities can have zero rounded value. Weight percentages are truncated to six decimal places, not policy authority.",
    portfolioCoverage:
      "Positions must cover every holdings row, including stable/reserve balances outside the configured risk-research universe. Those balances do not add market/news research tasks. USDT reference valuation does not prove redeemability or execution funding approval.",
    holdings,
    gas: {
      gasReserveWei,
      gasReserveBNB:
        gasReserveWei === null ? null : formatUnits(gasReserveWei, 18),
      nativeBalanceWei,
      nativeBalanceBNB:
        nativeBalanceWei === null ? null : formatUnits(nativeBalanceWei, 18),
      snapshotNativeFundingBNB:
        native.length === 1 ? native[0]!.quantity : null,
      guidance:
        gasReserveWei === null
          ? "Gas reserve was not provided by this snapshot; do not assume zero. A null balance/funding remains unknown."
          : "Gas reserve is explicitly configured, including zero; never report it as missing. Snapshot native funding is already after reserve; do not subtract it twice. A null balance/funding remains unknown.",
    },
    mechanismGuidance:
      "CANONICAL_NATIVE_WRAPPER identifies WBNB by chain and address: a native BNB deposit/withdraw wrapper, not a Binance custodial cross-chain peg or bridge. A test-profile valuation does not make canonical WBNB a synthetic fixture token. UNVERIFIED does not establish token backing or a bridge/custody mechanism; generic contract risk is distinct from an evidenced incident.",
    bnbBucketGuidance:
      "In stableNetworkAllocation native BNB plus the configured BNBUSDT token share the BNB bucket; zero token holdings do not imply zero native exposure or no bucket reduction. Token-specific SELL still requires that token. Legacy configured-token limits keep native separate; consult allocationReferenceBrief for observed combined weights, never copy them into targets.",
    execution: {
      status: "NOT_VERIFIED",
      researchMinimumLiquidityUsd: c.policy.minLiquidityUsd,
      pools: c.liquidity.map((p) => ({
        asset: p.asset,
        liquidityUsd: p.liquidityUsd,
        meetsResearchMinimum: p.liquidityUsd >= c.policy.minLiquidityUsd,
      })),
      guidance:
        "Funding and observed liquidity are not an executable quote or approved order size. Without a matching executable quote, do not call any BUY/SELL amount feasible/executable. The frozen research liquidity minimum is a research constraint, not proof of the separate executor's preflight outcome. Conditional recommendations and null remain allowed.",
    },
  };
}

export function roleSemanticsInstruction(role: string) {
  if (role === "positions")
    return "Use researchSemanticsBrief.holdings for every portfolio asset, including stable reserves outside the research universe; report natural token units, values and weights.";
  if (role === "risk")
    return "Use researchSemanticsBrief.gas for the explicit reserve and remaining native funding, and its execution constraints; known zero is not missing.";
  if (role === "onchain")
    return "Use researchSemanticsBrief for chain/address-bound mechanisms, native/token BNB scope and liquidity-versus-quote boundaries; no executable-size claim without a quote.";
  return "Use researchSemanticsBrief for quantity units, portfolio scope and evidence limits.";
}
