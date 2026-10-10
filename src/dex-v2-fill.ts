import { Interface, Transaction, type JsonRpcProvider } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import type { TxRecord } from "./chain.js";
import type { V2Quote } from "./dex-v2.js";
const transfer = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const swap = new Interface([
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
]);
export function transferDeltas(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  wallet: string,
  path: readonly string[],
) {
  const owner = wallet.toLowerCase(),
    tokens = path.map((a) => a.toLowerCase());
  const deltas = [0n, 0n];
  for (const l of logs) {
    const index = tokens.indexOf(l.address.toLowerCase());
    if (index < 0) continue;
    const event = transfer.parseLog({ topics: [...l.topics], data: l.data });
    if (!event) continue;
    const [from, to, value] = event.args;
    if (String(from).toLowerCase() === owner)
      deltas[index] = deltas[index]! - BigInt(value);
    if (String(to).toLowerCase() === owner)
      deltas[index] = deltas[index]! + BigInt(value);
  }
  return { input: -deltas[0]!, output: deltas[1]! };
}
/** Canonical confirmed transfer quantities. Does not assign USD value or cost basis. */
export async function recordV2Fill(
  db: Store,
  p: JsonRpcProvider,
  quoteId: string,
  transactionId: string,
  confirmations = 2,
) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1)
    throw Error("invalid confirmations");
  const q = db.get<V2Quote>("dex-v2-quote", quoteId),
    t = db.get<TxRecord>("transaction", transactionId);
  if (!q || !t || t.state !== "CONFIRMED")
    throw Error("confirmed trade source required");
  const { id, ...body } = q;
  if (id !== quoteId || hash(body) !== id) throw Error("quote integrity");
  let raw = Transaction.from(t.raw);
  if (raw.hash !== t.hash) {
    // A previous gas replacement may be mined; SQLite retains its signed bytes.
    const versions = db.sql
      .prepare(
        "SELECT data FROM record_history WHERE kind = 'transaction' AND id = ? AND json_extract(data, '$.hash') = ? ORDER BY sequence DESC",
      )
      .all(transactionId, t.hash);
    for (const version of versions) {
      const candidate = Transaction.from(
        JSON.parse(version.data as string).raw,
      );
      if (candidate.hash === t.hash) {
        raw = candidate;
        break;
      }
    }
  }
  const data = swap.encodeFunctionData("swapExactTokensForTokens", [
    q.amountIn,
    q.minimumOut,
    q.path,
    q.wallet,
    Math.floor(q.validUntil / 1000),
  ]);
  if (
    raw.chainId !== BigInt(q.chainId) ||
    raw.from?.toLowerCase() !== q.wallet ||
    raw.to?.toLowerCase() !== q.router ||
    raw.data !== data ||
    raw.value !== 0n ||
    raw.hash !== t.hash
  )
    throw Error("signed trade mismatch");
  if ((await p.getNetwork()).chainId !== BigInt(q.chainId))
    throw Error("wrong chain");
  const r = await p.getTransactionReceipt(t.hash);
  if (
    !r ||
    r.hash !== t.hash ||
    r.from.toLowerCase() !== q.wallet ||
    r.to?.toLowerCase() !== q.router ||
    r.status !== 1 ||
    r.blockNumber !== t.block ||
    r.blockHash !== t.blockHash ||
    (await r.confirmations()) < confirmations
  )
    throw Error("receipt not confirmed");
  const b = await p.send("eth_getBlockByNumber", [
    "0x" + r.blockNumber.toString(16),
    false,
  ]);
  if (!b || b.hash !== r.blockHash) throw Error("receipt not canonical");
  const amounts = transferDeltas(r.logs, q.wallet, q.path);
  if (
    amounts.input !== BigInt(q.amountIn) ||
    amounts.output < BigInt(q.minimumOut)
  )
    throw Error("fill quantity mismatch");
  const result = {
    id: hash(["dex-v2-fill/1", q.chainId, t.hash]),
    version: "dex-v2-fill/1",
    quoteId,
    transactionId,
    chainId: q.chainId,
    wallet: q.wallet,
    inputAsset: q.path[0]!,
    outputAsset: q.path[1]!,
    amountIn: amounts.input.toString(),
    amountOut: amounts.output.toString(),
    gasWei: (r.gasUsed * r.gasPrice).toString(),
    hash: t.hash,
    block: r.blockNumber,
    blockHash: r.blockHash,
  };
  return db.transaction(() => {
    const prior = db.get<typeof result>("dex-v2-fill", result.id);
    if (prior && hash(prior) !== hash(result)) throw Error("fill conflict");
    if (!prior) db.insert("dex-v2-fill", result.id, result);
    return prior ?? result;
  });
}
