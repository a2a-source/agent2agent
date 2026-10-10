import { randomUUID } from "node:crypto";
import {
  Contract,
  Interface,
  isAddress,
  keccak256,
  type JsonRpcProvider,
} from "ethers";
import { z } from "zod";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
const address = z
  .string()
  .refine(isAddress)
  .transform((a) => a.toLowerCase())
  .refine((a) => !/^0x0{40}$/.test(a));
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const configSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    router: address,
    factory: address,
    routerCodeHash: digest,
    factoryCodeHash: digest,
    tokens: z.array(address).min(2).max(24),
    slippageBps: z.number().int().min(0).max(50).default(50),
    maxImpactBps: z.number().int().min(0).max(50).default(50),
    quoteMaxAgeMs: z.number().int().min(1000).max(30000).default(30000),
  })
  .strict();
const abi = [
  "function factory() view returns(address)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])",
];
export function quoteBounds(
  input: bigint,
  output: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  slippage: number,
  maxImpact: number,
) {
  if (
    input <= 0n ||
    output <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n ||
    !Number.isSafeInteger(slippage) ||
    slippage < 0 ||
    slippage > 50 ||
    !Number.isSafeInteger(maxImpact) ||
    maxImpact < 0 ||
    maxImpact > 50
  )
    throw Error("invalid quote bounds");
  const spotNumerator = input * reserveOut;
  const difference = spotNumerator - output * reserveIn;
  if (difference < 0n) throw Error("invalid pool quote");
  const impactBps = Number(
    (difference * 10000n + spotNumerator - 1n) / spotNumerator,
  );
  if (impactBps > maxImpact) throw Error("quote impact exceeds policy");
  const minimumOut = (output * BigInt(10000 - slippage) + 9999n) / 10000n;
  if (minimumOut === 0n) throw Error("minimum output zero");
  return { minimumOut, impactBps };
}
export interface V2Quote {
  id: string;
  configHash: string;
  chainId: number;
  router: string;
  factory: string;
  pair: string;
  wallet: string;
  path: string[];
  amountIn: string;
  amountOut: string;
  minimumOut: string;
  impactBps: number;
  block: number;
  blockHash: string;
  createdAt: number;
  validUntil: number;
}
/** Exact-input ERC20 direct routes only. Quotes are not QSP authorization or gas/portfolio checks. */
export class V2Dex {
  readonly config: z.infer<typeof configSchema>;
  readonly configHash: string;
  constructor(
    readonly db: Store,
    readonly provider: JsonRpcProvider,
    config: unknown,
    readonly clock = Date.now,
  ) {
    this.config = configSchema.parse(config);
    if (new Set(this.config.tokens).size !== this.config.tokens.length)
      throw Error("duplicate tokens");
    this.configHash = hash(this.config);
  }
  private async block(number: number) {
    const b = await this.provider.send("eth_getBlockByNumber", [
      "0x" + number.toString(16),
      false,
    ]);
    if (!b?.hash) throw Error("block unavailable");
    return b;
  }
  async quote(
    wallet: string,
    input: string,
    output: string,
    quantity: string,
  ): Promise<V2Quote> {
    const id = randomUUID();
    const attempt = {
      id,
      configHash: this.configHash,
      wallet: wallet.slice(0, 80),
      input: input.slice(0, 80),
      output: output.slice(0, 80),
      quantity: quantity.slice(0, 80),
      startedAt: this.clock(),
    };
    this.db.insert("dex-v2-attempt", id, { ...attempt, status: "READING" });
    try {
      const q = await this.collectQuote(wallet, input, output, quantity);
      this.db.put("dex-v2-attempt", id, {
        ...attempt,
        status: "DONE",
        quoteId: q.id,
        finishedAt: this.clock(),
      });
      return q;
    } catch (error) {
      this.db.put("dex-v2-attempt", id, {
        ...attempt,
        status: "FAILED",
        reason: "QUOTE_UNAVAILABLE",
        finishedAt: this.clock(),
      });
      throw error;
    }
  }
  private async collectQuote(
    walletRaw: string,
    inputRaw: string,
    outputRaw: string,
    quantity: string,
  ): Promise<V2Quote> {
    const wallet = address.parse(walletRaw),
      input = address.parse(inputRaw),
      output = address.parse(outputRaw),
      amountIn = BigInt(
        z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .max(78)
          .parse(quantity),
      );
    const c = this.config;
    if (input === output || ![input, output].every((a) => c.tokens.includes(a)))
      throw Error("route not allowlisted");
    if ((await this.provider.getNetwork()).chainId !== BigInt(c.chainId))
      throw Error("wrong chain");
    const at = this.clock(),
      number = await this.provider.getBlockNumber(),
      block = await this.block(number),
      opts = { blockTag: number };
    const router = new Contract(c.router, abi, this.provider);
    const [rc, fc, actualFactory] = await Promise.all([
      this.provider.getCode(c.router, number),
      this.provider.getCode(c.factory, number),
      router.factory!(opts),
    ]);
    if (
      keccak256(rc) !== c.routerCodeHash ||
      keccak256(fc) !== c.factoryCodeHash ||
      String(actualFactory).toLowerCase() !== c.factory
    )
      throw Error("DEX deployment mismatch");
    const factory = new Contract(
      c.factory,
      ["function getPair(address,address) view returns(address)"],
      this.provider,
    );
    const pairAddress = address.parse(
      await factory.getPair!(input, output, opts),
    );
    const pair = new Contract(
      pairAddress,
      [
        "function token0() view returns(address)",
        "function token1() view returns(address)",
        "function getReserves() view returns(uint112,uint112,uint32)",
      ],
      this.provider,
    );
    const [token0, token1, reserves, amounts] = await Promise.all([
      pair.token0!(opts),
      pair.token1!(opts),
      pair.getReserves!(opts),
      router.getAmountsOut!(amountIn, [input, output], opts),
    ]);
    const first = String(token0).toLowerCase(),
      second = String(token1).toLowerCase();
    if (
      ![first, second].includes(input) ||
      ![first, second].includes(output) ||
      amounts.length !== 2 ||
      BigInt(amounts[0]) !== amountIn
    )
      throw Error("pool identity mismatch");
    const bounds = quoteBounds(
      amountIn,
      BigInt(amounts[1]),
      BigInt(reserves[first === input ? 0 : 1]),
      BigInt(reserves[first === input ? 1 : 0]),
      c.slippageBps,
      c.maxImpactBps,
    );
    if ((await this.block(number)).hash !== block.hash)
      throw Error("quote block changed");
    const validUntil = at + c.quoteMaxAgeMs;
    if (this.clock() >= validUntil)
      throw Error("quote expired during collection");
    const data = {
      configHash: this.configHash,
      chainId: c.chainId,
      router: c.router,
      factory: c.factory,
      pair: pairAddress,
      wallet,
      path: [input, output],
      amountIn: amountIn.toString(),
      amountOut: String(amounts[1]),
      minimumOut: bounds.minimumOut.toString(),
      impactBps: bounds.impactBps,
      block: number,
      blockHash: String(block.hash),
      createdAt: at,
      validUntil,
    };
    const q = { ...data, id: hash(data) };
    this.db.put("dex-v2-quote", q.id, q);
    return q;
  }
  async request(id: string) {
    const q = this.db.get<V2Quote>("dex-v2-quote", id);
    if (!q) throw Error("stored quote required");
    const { id: storedId, ...body } = q;
    if (
      storedId !== id ||
      hash(body) !== id ||
      q.configHash !== this.configHash ||
      this.clock() < q.createdAt ||
      this.clock() >= q.validUntil
    )
      throw Error("quote invalid or expired");
    if (
      (await this.provider.getNetwork()).chainId !== BigInt(q.chainId) ||
      (await this.block(q.block)).hash !== q.blockHash ||
      this.clock() >= q.validUntil
    )
      throw Error("quote chain changed or expired");
    return {
      to: q.router,
      data: new Interface(abi).encodeFunctionData("swapExactTokensForTokens", [
        q.amountIn,
        q.minimumOut,
        q.path,
        q.wallet,
        Math.floor(q.validUntil / 1000),
      ]),
      value: 0n,
    };
  }
}
