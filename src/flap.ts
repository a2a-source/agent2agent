import { FormData } from "undici";
import { networkFetch as fetch } from "./network.js";
import {
  Contract,
  Interface,
  ZeroAddress,
  ZeroHash,
  getCreate2Address,
  keccak256,
  toUtf8Bytes,
  type Wallet,
  type HDNodeWallet,
} from "ethers";
import { Agents } from "./agents.js";
import { Journal } from "./chain.js";
export const FLAP_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion)) payable returns(address)",
];
export const FACTORY_ABI = [
  "function platform() view returns(address)",
  "function predict(bytes32 id,address agent) view returns(address)",
  "function create(bytes32 id,address agent) returns(address)",
];
export function buildLaunch(
  input: { name: string; symbol: string; meta: string },
  beneficiary: string,
  salt: string,
  taxDuration: number,
  dexThresh = 0,
) {
  return {
    ...input,
    dexThresh,
    salt,
    migratorType: 1,
    quoteToken: ZeroAddress,
    quoteAmt: 0n,
    beneficiary,
    permitData: "0x",
    extensionID: ZeroHash,
    extensionData: "0x",
    dexId: 0,
    lpFeeProfile: 0,
    buyTaxRate: 300,
    sellTaxRate: 300,
    taxDuration,
    antiFarmerDuration: 0,
    mktBps: 10000,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    minimumShareBalance: 0n,
    dividendToken: ZeroAddress,
    commissionReceiver: ZeroAddress,
    tokenVersion: 6,
  };
}
export async function findSalt(
  portal: string,
  implementation: string,
  seed: string,
) {
  const bytecode =
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    implementation.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3";
  const codeHash = keccak256(bytecode);
  let salt = keccak256(seed);
  for (let i = 0; i < 2000000; i++) {
    const address = getCreate2Address(portal, salt, codeHash);
    if (address.toLowerCase().endsWith("7777")) return { salt, address };
    salt = keccak256(salt);
    if (i % 1000 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  throw Error("vanity search exhausted");
}
export interface FlapConfig {
  portal: string;
  implementation: string;
  factory: string;
  taxDuration: number;
  launchValueWei: string;
  dexThresh?: number;
  confirmations: number;
}
export class FlapLauncher {
  constructor(
    readonly agents: Agents,
    readonly journal: Journal,
    readonly signer: Wallet | HDNodeWallet,
    readonly config: FlapConfig,
  ) {}
  async advance(id: string) {
    const a = this.agents.get(id);
    if (a.launch === "CONFIRMED") return a;
    const provider = this.journal.provider,
      c = this.config;
    if ((await provider.getNetwork()).chainId !== BigInt(this.journal.chainId))
      throw Error("wrong chain");
    for (const address of [c.portal, c.implementation, c.factory])
      if ((await provider.getCode(address)) === "0x")
        throw Error("configured contract not deployed");
    const key = keccak256(toUtf8Bytes(id)),
      factory = new Contract(c.factory, FACTORY_ABI, provider);
    const predicted = (await factory.getFunction("predict")(
      key,
      a.wallet,
    )) as string;
    const splitId = `splitter:${id}`;
    if ((await provider.getCode(predicted)) === "0x") {
      await this.journal.send(
        splitId,
        this.signer.address,
        () => this.signer,
        {
          to: c.factory,
          data: factory.interface.encodeFunctionData("create", [key, a.wallet]),
        },
        {
          confirmations: c.confirmations,
          safeRetry: async () => (await provider.getCode(predicted)) === "0x",
        },
      );
      if (!(await this.journal.confirmed(splitId, c.confirmations))) return a;
    }
    const split = new Contract(
      predicted,
      [
        "function platform() view returns(address)",
        "function agent() view returns(address)",
      ],
      provider,
    );
    if (
      (await split.getFunction("agent")()).toLowerCase() !==
        a.wallet.toLowerCase() ||
      (await split.getFunction("platform")()).toLowerCase() !==
        (await factory.getFunction("platform")()).toLowerCase()
    )
      throw Error("splitter recipient mismatch");
    this.agents.update(id, { splitter: predicted });
    let vanity = this.agents.db.get<{ salt: string; address: string }>(
      "vanity",
      id,
    );
    if (!vanity) {
      vanity = await findSalt(c.portal, c.implementation, key);
      this.agents.db.put("vanity", id, vanity);
    }
    const txId = `launch:${id}`,
      params = buildLaunch(
        a,
        predicted,
        vanity.salt,
        c.taxDuration,
        c.dexThresh,
      );
    await this.journal.send(
      txId,
      this.signer.address,
      () => this.signer,
      {
        to: c.portal,
        data: new Interface(FLAP_ABI).encodeFunctionData("newTokenV6", [
          params,
        ]),
        value: BigInt(c.launchValueWei),
      },
      {
        confirmations: c.confirmations,
        safeRetry: async () =>
          (await provider.getCode(vanity!.address)) === "0x" &&
          (await provider.getCode(predicted)) !== "0x",
      },
    );
    if (!(await this.journal.confirmed(txId, c.confirmations)))
      return this.agents.get(id);
    if ((await provider.getCode(vanity.address)) === "0x")
      throw Error("confirmed launch missing predicted token");
    // Verify the deployed token's fixed tax and beneficiary rather than trusting a successful receipt.
    const token = new Contract(
      vanity.address,
      [
        "function taxProcessor() view returns(address)",
        "function buyTaxRate() view returns(uint256)",
        "function sellTaxRate() view returns(uint256)",
      ],
      provider,
    );
    if (
      (await token.getFunction("buyTaxRate")()) !== 300n ||
      (await token.getFunction("sellTaxRate")()) !== 300n
    )
      throw Error("deployed token tax mismatch");
    const processor = new Contract(
      await token.getFunction("taxProcessor")(),
      [
        "function marketAddress() view returns(address)",
        "function taxToken() view returns(address)",
      ],
      provider,
    );
    if (
      (await processor.getFunction("marketAddress")()).toLowerCase() !==
        predicted.toLowerCase() ||
      (await processor.getFunction("taxToken")()).toLowerCase() !==
        vanity.address.toLowerCase()
    )
      throw Error("tax recipient mismatch");
    const row = this.agents.db.get<import("./chain.js").TxRecord>(
      "transaction",
      txId,
    )!;
    const receipt = await provider.getTransactionReceipt(row.hash);
    const events = new Interface([
      "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
    ]);
    const created = receipt?.logs
      .filter((l) => l.address.toLowerCase() === c.portal.toLowerCase())
      .map((l) => {
        try {
          return events.parseLog(l);
        } catch {
          return null;
        }
      })
      .find(
        (l) =>
          l?.name === "TokenCreated" &&
          l.args.token.toLowerCase() === vanity.address.toLowerCase(),
      );
    if (
      !created ||
      created.args.creator.toLowerCase() !==
        this.signer.address.toLowerCase() ||
      created.args.name !== a.name ||
      created.args.symbol !== a.symbol ||
      created.args.meta !== a.meta
    )
      throw Error("creation receipt binding mismatch");
    this.agents.db.put("launch-block", id, { height: receipt!.blockNumber });
    return this.agents.update(id, {
      token: vanity.address,
      launch: "CONFIRMED",
    });
  }
}
/** Flap's documented multipart upload. Network failure never launches a token. */
export async function uploadMetadata(
  image: Uint8Array,
  filename: string,
  meta: Record<string, string | null>,
  endpoint = "https://funcs.flap.sh/api/upload",
) {
  const form = new FormData();
  form.set(
    "operations",
    JSON.stringify({
      query:
        "mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }",
      variables: { file: null, meta },
    }),
  );
  form.set("map", JSON.stringify({ "0": ["variables.file"] }));
  form.set("0", new Blob([new Uint8Array(image)]), filename);
  const r = await fetch(endpoint, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error(`metadata upload HTTP ${r.status}`);
  const data = (await r.json()) as any;
  if (typeof data.data?.create !== "string")
    throw Error("metadata upload invalid response");
  return data.data.create as string;
}
