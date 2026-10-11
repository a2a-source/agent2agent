import { Contract, JsonRpcProvider } from "ethers";
export interface PriceQuote {
  answer: string;
  decimals: number;
  roundId: string;
  answeredInRound: string;
  updatedAt: number;
  blockNumber: number;
  blockHash: string;
  chainId: number;
  feed: string;
  observedAt: number;
}
export interface PriceSource {
  quote(): Promise<PriceQuote>;
  maxAgeSeconds: number;
}
export function validateQuote(
  q: PriceQuote,
  maxAgeSeconds: number,
  now = Date.now(),
) {
  const seconds = Math.floor(now / 1000);
  if (
    !Number.isInteger(q.decimals) ||
    q.decimals < 0 ||
    q.decimals > 36 ||
    BigInt(q.answer) <= 0n ||
    BigInt(q.roundId) <= 0n ||
    BigInt(q.answeredInRound) < BigInt(q.roundId) ||
    !Number.isSafeInteger(q.updatedAt) ||
    q.updatedAt <= 0 ||
    q.updatedAt > seconds ||
    seconds - q.updatedAt > maxAgeSeconds ||
    !Number.isSafeInteger(q.observedAt) ||
    now - q.observedAt > 60000 ||
    q.observedAt > now
  )
    throw Error("BNB/USD oracle quote invalid or stale");
}
export function quoteCost(q: PriceQuote) {
  const numerator = 10000n * 10n ** 18n * 10n ** BigInt(q.decimals);
  const denominator = 1000000n * BigInt(q.answer);
  return (numerator + denominator - 1n) / denominator;
}
export class ChainlinkPrice implements PriceSource {
  constructor(
    readonly provider: JsonRpcProvider,
    readonly chainId: number,
    readonly feed: string,
    readonly maxAgeSeconds: number,
    readonly confirmations = 12,
  ) {}
  async quote(): Promise<PriceQuote> {
    try {
      if (!this.feed) throw Error("missing feed");
      const network = await this.provider.getNetwork();
      if (network.chainId !== BigInt(this.chainId))
        throw Error("wrong network");
      const tip = await this.provider.getBlockNumber();
      const block = await this.provider.getBlock(
        Math.max(0, tip - this.confirmations),
      );
      if (!block?.hash || Date.now() / 1000 - block.timestamp > 120)
        throw Error("stale chain");
      const contract = new Contract(
        this.feed,
        [
          "function decimals() view returns(uint8)",
          "function description() view returns(string)",
          "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
        ],
        this.provider,
      );
      const overrides = { blockTag: block.number };
      const [decimals, description, round] = await Promise.all([
        contract.decimals!(overrides),
        contract.description!(overrides),
        contract.latestRoundData!(overrides),
      ]);
      const check = await this.provider.getBlock(block.number);
      if (check?.hash !== block.hash || description !== "BNB / USD")
        throw Error("wrong feed or reorg");
      const q: PriceQuote = {
        answer: String(round[1]),
        decimals: Number(decimals),
        roundId: String(round[0]),
        answeredInRound: String(round[4]),
        updatedAt: Number(round[3]),
        blockNumber: block.number,
        blockHash: block.hash,
        chainId: this.chainId,
        feed: this.feed,
        observedAt: Date.now(),
      };
      validateQuote(q, this.maxAgeSeconds);
      if (q.updatedAt > block.timestamp) throw Error("future round");
      return q;
    } catch {
      throw Error("BNB/USD oracle unavailable or invalid");
    }
  }
}
