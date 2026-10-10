import {
  Interface,
  Transaction,
  zeroPadValue,
  type JsonRpcProvider,
} from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import {
  portfolioRegistrySchema,
  type PortfolioSnapshot,
} from "./portfolio-snapshot.js";
import type { TxRecord } from "./chain.js";
import {
  nativeQuoteConfig,
  verifyWrappedNative,
  v2QuoteRequest,
  type V2Quote,
} from "./dex-v2.js";
import { recordV2Fill } from "./dex-v2-fill.js";
import {
  reservedRequestHash,
  type ReservationBinding,
} from "./reservation-signing.js";

async function nativeSwapIntent(
  db: Store,
  provider: JsonRpcProvider,
  row: TxRecord,
  raw: Transaction,
  opening: PortfolioSnapshot,
) {
  const reservation =
    row.reservationId && db.get<any>("wallet-reservation", row.reservationId);
  const link =
    row.reservationId &&
    db.get<any>("investment-execution-reservation", row.reservationId);
  const job = link && db.get<any>("investment-execution-job", link.jobId);
  const deployment =
    job && db.get<any>("investment-execution-config", job.configHash);
  const binding = db.get<ReservationBinding>(
    "wallet-reservation-binding",
    row.id,
  );
  const order = job?.orders?.find((o: any) => o.swapId === row.id);
  const plan = job && db.get<any>("stable-wallet-plan", job.planId);
  requireProof(
    reservation && link && job && deployment && binding && order && plan,
    "NATIVE_SWAP_BINDING_MISSING",
  );
  const quote = db.get<V2Quote>("dex-v2-quote", order.quoteId);
  requireProof(quote, "NATIVE_QUOTE_MISSING");
  const { id, ...body } = quote;
  requireProof(
    hash(body) === id && id === order.quoteId,
    "NATIVE_QUOTE_INTEGRITY",
  );
  const config = nativeQuoteConfig(db, quote);
  const request = v2QuoteRequest(quote);
  const source = plan.orders[order.sourceOrderIndex];
  requireProof(
    hash(deployment) === job.configHash &&
      hash(deployment.dex) === quote.configHash &&
      hash(deployment.registry) === opening.registryHash &&
      plan.snapshotId === opening.id &&
      reservation.snapshotId === opening.id &&
      reservation.planId === plan.id &&
      link.planId === plan.id &&
      job.reservationId === reservation.id &&
      reservation.transactionIds.includes(row.id) &&
      reservation.wallet === opening.wallet &&
      reservation.chainId === opening.chainId &&
      binding.reservationId === reservation.id &&
      binding.wallet === opening.wallet &&
      binding.chainId === opening.chainId &&
      binding.requestHash === reservedRequestHash(request) &&
      binding.nativeValueWei === String(raw.value) &&
      order.version === "investment-execution-order/2" &&
      order.inputKind === "NATIVE" &&
      order.input === "native" &&
      order.output === quote.path[1] &&
      order.amountIn === quote.amountIn &&
      source?.side === "SELL" &&
      source.bucket === "BNB" &&
      order.intendedNotionalMicros === source.notionalMicros &&
      job.orders
        .filter((o: any) => o.sourceOrderIndex === order.sourceOrderIndex)
        .reduce((n: bigint, o: any) => n + BigInt(o.notionalMicros), 0n) <=
        BigInt(source.notionalMicros) &&
      raw.to?.toLowerCase() === quote.router &&
      raw.from?.toLowerCase() === quote.wallet &&
      raw.data === request.data &&
      raw.value === request.value,
    "NATIVE_SWAP_INTENT_MISMATCH",
  );
  const registered = deployment.registry.assets.filter(
    (a: any) => a.bucket === "BNB" && a.asset !== "native",
  );
  requireProof(
    registered.length === 1 &&
      registered[0].asset === config.wrappedNative!.address &&
      registered[0].decimals === 18,
    "NATIVE_REGISTRY_MISMATCH",
  );
  await verifyWrappedNative(provider, config, quote.block);
  const block = await rpc(() =>
    provider.send("eth_getBlockByNumber", [
      "0x" + quote.block.toString(16),
      false,
    ]),
  );
  requireProof(block?.hash === quote.blockHash, "NATIVE_QUOTE_BLOCK_MISMATCH");
  return quote;
}
const transfer = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const topic = transfer.getEvent("Transfer")!.topicHash;
const digest = /^0x[0-9a-fA-F]{64}$/;
class Incomplete extends Error {}
class RpcUnavailable extends Error {}
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Incomplete(reason);
}
function units(value: unknown) {
  requireProof(
    typeof value === "bigint" || typeof value === "string",
    "INVALID_UNITS",
  );
  const text = String(value);
  requireProof(
    /^(0|[1-9][0-9]*)$/.test(text) && text.length <= 96,
    "INVALID_UNITS",
  );
  return BigInt(text);
}
function integer(value: unknown): number {
  requireProof(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "INVALID_INTEGER",
  );
  return value;
}
async function rpc<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new RpcUnavailable();
  }
}
/** Wrap transport reads only: adapter integrity failures must remain permanent UNKNOWN. */
function nativeEvidenceProvider(provider: JsonRpcProvider): JsonRpcProvider {
  const reads = new Set([
    "call",
    "getCode",
    "getNetwork",
    "getTransactionReceipt",
    "send",
  ]);
  return new Proxy(provider, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof key !== "string" || !reads.has(key)) return value;
      return (...args: unknown[]) =>
        rpc(async () => {
          const result = await value.apply(target, args);
          if (key !== "getTransactionReceipt" || !result) return result;
          return new Proxy(result, {
            get(receipt, property) {
              if (property === "confirmations")
                return () => rpc(() => receipt.confirmations());
              return Reflect.get(receipt, property, receipt);
            },
          });
        });
    },
  });
}
interface ProofLog {
  asset: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  index: number;
  from: string;
  to: string;
  quantity: string;
  delta: string;
}
function logEvidence(log: any, wallet: string): ProofLog {
  requireProof(
    log &&
      log.removed !== true &&
      typeof log.address === "string" &&
      digest.test(log.transactionHash) &&
      digest.test(log.blockHash),
    "INVALID_TRANSFER_LOG",
  );
  const parsed = transfer.parseLog({ topics: [...log.topics], data: log.data });
  requireProof(parsed?.name === "Transfer", "INVALID_TRANSFER_LOG");
  const from = String(parsed.args[0]).toLowerCase(),
    to = String(parsed.args[1]).toLowerCase(),
    quantity = units(parsed.args[2]);
  requireProof(from === wallet || to === wallet, "UNRELATED_TRANSFER_LOG");
  return {
    asset: log.address.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    blockNumber: integer(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    index: integer(log.index),
    from,
    to,
    quantity: String(quantity),
    delta: String(
      (to === wallet ? quantity : 0n) - (from === wallet ? quantity : 0n),
    ),
  };
}
const logKey = (log: ProofLog) => `${log.transactionHash}:${log.index}`;
function addLog(map: Map<string, ProofLog>, log: ProofLog) {
  const old = map.get(logKey(log));
  requireProof(!old || hash(old) === hash(log), "CONFLICTING_TRANSFER_LOG");
  map.set(logKey(log), log);
}
/** Conservative EOA/tracked-asset proof. Unknown external transfers are never priced as zero. */
export async function proveExecutionNoExternalFlow(
  db: Store,
  provider: JsonRpcProvider,
  openingSnapshotId: string,
  closingSnapshotId: string,
  transactionIds: string[],
  confirmations: number,
): Promise<
  | {
      complete: true;
      netExternalFlowMicros: "0";
      hasExternalFlows: false;
      provenance: string[];
    }
  | undefined
> {
  const body: any = {
    version: "execution-cashflow-proof/1",
    openingSnapshotId,
    closingSnapshotId,
    transactionIds: [...transactionIds],
    confirmations,
    scope: "REGISTERED_ASSETS_AND_NATIVE_EOA",
    status: "UNKNOWN",
    reasons: [],
    boundaries: null,
    nonceBounds: null,
    gasWei: null,
    transactions: [],
    assets: [],
    blocks: [],
    blockChecks: [],
  };
  let transient = false;
  const nativeProvider = nativeEvidenceProvider(provider);
  try {
    requireProof(
      Number.isSafeInteger(confirmations) && confirmations > 0,
      "INVALID_CONFIRMATIONS",
    );
    requireProof(
      new Set(transactionIds).size === transactionIds.length &&
        transactionIds.length <= 256,
      "INVALID_TRANSACTION_SET",
    );
    const readSnapshot = (id: string) => {
      const s = db.get<PortfolioSnapshot>("portfolio-snapshot", id);
      requireProof(s && s.id === id, "SNAPSHOT_MISSING");
      const { id: storedId, ...data } = s;
      requireProof(hash(data) === storedId, "SNAPSHOT_INTEGRITY");
      const capture = db.get<any>("portfolio-capture", s.requestId);
      requireProof(
        capture?.status === "DONE" && capture.snapshotId === id,
        "CAPTURE_INCOMPLETE",
      );
      const registry = portfolioRegistrySchema.parse(capture.registry);
      requireProof(
        hash(capture.registry) === s.registryHash &&
          registry.chainId === s.chainId,
        "REGISTRY_MISMATCH",
      );
      requireProof(
        s.holdings.length === registry.assets.length &&
          new Set(s.holdings.map((h) => h.asset)).size ===
            registry.assets.length &&
          registry.assets.every((a) =>
            s.holdings.some((h) => h.asset === a.asset),
          ),
        "HOLDINGS_INCOMPLETE",
      );
      for (const holding of s.holdings) units(holding.balance);
      return { snapshot: s, registry };
    };
    const { snapshot: opening, registry } = readSnapshot(openingSnapshotId),
      { snapshot: closing } = readSnapshot(closingSnapshotId);
    requireProof(
      opening.chainId === closing.chainId &&
        opening.wallet === closing.wallet &&
        opening.agent === closing.agent &&
        opening.registryHash === closing.registryHash,
      "BOUNDARY_IDENTITY_MISMATCH",
    );
    const from = integer(opening.blockNumber),
      to = integer(closing.blockNumber);
    requireProof(
      to > from && closing.observedAt > opening.observedAt,
      "INVALID_BOUNDARY_INTERVAL",
    );
    requireProof(to - from <= 4096, "INTERVAL_TOO_LARGE");
    requireProof(
      digest.test(opening.blockHash) && digest.test(closing.blockHash),
      "INVALID_BOUNDARY_HASH",
    );
    const wallet = opening.wallet.toLowerCase();
    body.chainId = opening.chainId;
    body.wallet = wallet;
    body.registryHash = opening.registryHash;
    body.boundaries = {
      opening: { block: from, hash: opening.blockHash },
      closing: { block: to, hash: closing.blockHash },
    };
    const blocks = new Map<number, string>([
      [from, opening.blockHash.toLowerCase()],
      [to, closing.blockHash.toLowerCase()],
    ]);
    const pin = async () => {
      body.blocks = [...blocks]
        .sort(([a], [b]) => a - b)
        .map(([number, blockHash]) => ({ number, hash: blockHash }));
      for (const [number, expected] of blocks) {
        const b = await rpc(() =>
          provider.send("eth_getBlockByNumber", [
            "0x" + number.toString(16),
            false,
          ]),
        );
        body.blockChecks.push({ number, expected, observed: b?.hash ?? null });
        requireProof(
          b?.hash?.toLowerCase() === expected &&
            Number(BigInt(b.number)) === number,
          "CANONICAL_BLOCK_MISMATCH",
        );
      }
    };
    await pin();
    const [network, tip, openingCode, closingCode, openingNonce, closingNonce] =
      await Promise.all([
        rpc(() => provider.getNetwork()),
        rpc(() => provider.getBlockNumber()),
        rpc(() => provider.getCode(wallet, from)),
        rpc(() => provider.getCode(wallet, to)),
        rpc(() => provider.getTransactionCount(wallet, from)),
        rpc(() => provider.getTransactionCount(wallet, to)),
      ]);
    requireProof(network.chainId === BigInt(opening.chainId), "CHAIN_MISMATCH");
    requireProof(integer(tip) >= to + confirmations, "BOUNDARY_NOT_CONFIRMED");
    requireProof(
      openingCode === "0x" && closingCode === "0x",
      "WALLET_NOT_EOA",
    );
    body.nonceBounds = {
      opening: integer(openingNonce),
      closing: integer(closingNonce),
    };
    requireProof(
      closingNonce >= openingNonce &&
        closingNonce - openingNonce === transactionIds.length,
      "NONCE_COVERAGE_INCOMPLETE",
    );
    const known = new Set<string>(),
      nonces = new Set<number>(),
      receiptLogs = new Map<string, ProofLog>();
    const tokenSet = new Set(
      registry.assets.filter((a) => a.asset !== "native").map((a) => a.asset),
    );
    let gas = 0n,
      nativeSwapValue = 0n;
    for (const transactionId of transactionIds) {
      const row = db.get<TxRecord>("transaction", transactionId);
      requireProof(
        row &&
          row.id === transactionId &&
          (row.state === "CONFIRMED" || row.state === "REVERTED"),
        "JOURNAL_TRANSACTION_NOT_FINAL",
      );
      requireProof(
        digest.test(row.hash) && row.sender.toLowerCase() === wallet,
        "JOURNAL_IDENTITY_MISMATCH",
      );
      let raw = Transaction.from(row.raw);
      if (raw.hash?.toLowerCase() !== row.hash.toLowerCase()) {
        const versions = db.sql
          .prepare(
            "SELECT data FROM record_history WHERE kind='transaction' AND id=? AND json_extract(data,'$.hash')=? ORDER BY sequence DESC",
          )
          .all(transactionId, row.hash);
        for (const version of versions) {
          const previous = Transaction.from(
            JSON.parse(version.data as string).raw,
          );
          if (previous.hash?.toLowerCase() === row.hash.toLowerCase()) {
            raw = previous;
            break;
          }
        }
      }
      requireProof(
        raw.isSigned() &&
          raw.hash?.toLowerCase() === row.hash.toLowerCase() &&
          raw.from?.toLowerCase() === wallet &&
          raw.chainId === BigInt(opening.chainId),
        "SIGNED_TRANSACTION_MISMATCH",
      );
      let nativeQuote: V2Quote | undefined;
      if (raw.value > 0n) {
        body.version = "execution-cashflow-proof/2";
        body.nativeSwaps ??= [];
        nativeQuote = await nativeSwapIntent(
          db,
          nativeProvider,
          row,
          raw,
          opening,
        );
      }
      requireProof(
        raw.nonce >= openingNonce &&
          raw.nonce < closingNonce &&
          !nonces.has(raw.nonce) &&
          !known.has(row.hash.toLowerCase()),
        "NONCE_COVERAGE_INCOMPLETE",
      );
      const receipt = await rpc(() => provider.getTransactionReceipt(row.hash));
      requireProof(
        receipt &&
          receipt.hash.toLowerCase() === row.hash.toLowerCase() &&
          receipt.from.toLowerCase() === wallet &&
          (receipt.to?.toLowerCase() ?? null) ===
            (raw.to?.toLowerCase() ?? null) &&
          receipt.status === (row.state === "REVERTED" ? 0 : 1) &&
          receipt.blockNumber === row.block &&
          receipt.blockHash === row.blockHash,
        "RECEIPT_IDENTITY_MISMATCH",
      );
      if (nativeQuote) {
        const fill =
          row.state === "CONFIRMED"
            ? await recordV2Fill(
                db,
                nativeProvider,
                nativeQuote!.id,
                row.id,
                confirmations,
              )
            : undefined;
        const value = fill ? raw.value : 0n;
        nativeSwapValue += value;
        body.nativeSwaps.push({
          transactionId,
          quoteId: nativeQuote.id,
          configHash: nativeQuote.configHash,
          reservationId: row.reservationId,
          bindingId: row.id,
          fillId: fill?.id ?? null,
          valueWei: String(value),
          signedValueWei: String(raw.value),
        });
      }
      const block = integer(receipt.blockNumber);
      requireProof(
        block > from &&
          block <= to &&
          integer(tip) - block + 1 >= confirmations,
        "RECEIPT_OUTSIDE_CONFIRMED_INTERVAL",
      );
      requireProof(
        integer(await rpc(() => receipt.confirmations())) >= confirmations,
        "RECEIPT_NOT_CONFIRMED",
      );
      requireProof(digest.test(receipt.blockHash), "INVALID_RECEIPT_BLOCK");
      const oldHash = blocks.get(block);
      requireProof(
        !oldHash || oldHash === receipt.blockHash.toLowerCase(),
        "CANONICAL_BLOCK_MISMATCH",
      );
      blocks.set(block, receipt.blockHash.toLowerCase());
      const gasUsed = units(receipt.gasUsed),
        gasPrice = units(receipt.gasPrice);
      requireProof(gasUsed > 0n && gasPrice > 0n, "GAS_EVIDENCE_MISSING");
      const fee = gasUsed * gasPrice;
      gas += fee;
      known.add(row.hash.toLowerCase());
      nonces.add(raw.nonce);
      body.transactions.push({
        id: transactionId,
        hash: row.hash,
        nonce: raw.nonce,
        block,
        blockHash: receipt.blockHash,
        status: receipt.status,
        gasUsed: String(gasUsed),
        gasPrice: String(gasPrice),
        gasWei: String(fee),
      });
      for (const log of receipt.logs) {
        if (
          !tokenSet.has(log.address.toLowerCase()) ||
          log.topics[0]?.toLowerCase() !== topic.toLowerCase()
        )
          continue;
        const parsed = transfer.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        requireProof(parsed, "INVALID_TRANSFER_LOG");
        if (
          ![
            String(parsed.args[0]).toLowerCase(),
            String(parsed.args[1]).toLowerCase(),
          ].includes(wallet)
        )
          continue;
        const evidence = logEvidence(log, wallet);
        requireProof(
          evidence.transactionHash === row.hash.toLowerCase() &&
            evidence.blockNumber === block &&
            evidence.blockHash === receipt.blockHash.toLowerCase(),
          "RECEIPT_LOG_IDENTITY_MISMATCH",
        );
        addLog(receiptLogs, evidence);
      }
    }
    body.gasWei = String(gas);
    if (body.version === "execution-cashflow-proof/2")
      body.nativeSwapValueWei = String(nativeSwapValue);
    await pin();
    for (let nonce = openingNonce; nonce < closingNonce; nonce++)
      requireProof(nonces.has(nonce), "NONCE_COVERAGE_INCOMPLETE");
    const allLogs = new Map<string, ProofLog>(),
      walletTopic = zeroPadValue(wallet, 32);
    for (const asset of registry.assets) {
      const before = units(
          opening.holdings.find((h) => h.asset === asset.asset)!.balance,
        ),
        after = units(
          closing.holdings.find((h) => h.asset === asset.asset)!.balance,
        );
      if (asset.asset === "native") {
        body.assets.push({
          asset: asset.asset,
          openingBalance: String(before),
          closingBalance: String(after),
          balanceDelta: String(after - before),
          gasWei: String(gas),
        });
        requireProof(
          after - before + gas + nativeSwapValue === 0n,
          "NATIVE_FLOW_UNEXPLAINED",
        );
        continue;
      }
      const logs = await Promise.all([
        rpc(() =>
          provider.getLogs({
            address: asset.asset,
            fromBlock: from + 1,
            toBlock: to,
            topics: [topic, walletTopic],
          }),
        ),
        rpc(() =>
          provider.getLogs({
            address: asset.asset,
            fromBlock: from + 1,
            toBlock: to,
            topics: [topic, null, walletTopic],
          }),
        ),
      ]);
      requireProof(
        logs[0].length + logs[1].length <= 20000,
        "TRANSFER_EVIDENCE_TOO_LARGE",
      );
      const tokenLogs = new Map<string, ProofLog>();
      for (const raw of logs.flat()) {
        const log = logEvidence(raw, wallet);
        requireProof(
          log.asset === asset.asset &&
            log.blockNumber > from &&
            log.blockNumber <= to,
          "TRANSFER_QUERY_MISMATCH",
        );
        addLog(tokenLogs, log);
        addLog(allLogs, log);
      }
      const delta = [...tokenLogs.values()].reduce(
        (sum, log) => sum + BigInt(log.delta),
        0n,
      );
      body.assets.push({
        asset: asset.asset,
        openingBalance: String(before),
        closingBalance: String(after),
        balanceDelta: String(after - before),
        transferDelta: String(delta),
        logs: [...tokenLogs.values()].sort(
          (a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
        ),
      });
      for (const log of tokenLogs.values()) {
        if (log.delta !== "0")
          requireProof(
            known.has(log.transactionHash),
            "EXTERNAL_TOKEN_TRANSFER",
          );
        if (known.has(log.transactionHash))
          requireProof(
            receiptLogs.has(logKey(log)) &&
              hash(receiptLogs.get(logKey(log))) === hash(log),
            "TRANSFER_RECEIPT_MISMATCH",
          );
      }
      requireProof(after - before === delta, "TOKEN_BALANCE_UNEXPLAINED");
    }
    for (const [key, log] of receiptLogs)
      requireProof(
        allLogs.has(key) && hash(allLogs.get(key)) === hash(log),
        "TRANSFER_LOG_MISSING",
      );
    await pin();
    requireProof(
      (await rpc(() => provider.getNetwork())).chainId ===
        BigInt(opening.chainId),
      "CHAIN_MISMATCH",
    );
    body.status = "KNOWN";
  } catch (error) {
    transient = error instanceof RpcUnavailable;
    body.reasons = [
      transient
        ? "RPC_UNAVAILABLE"
        : error instanceof Incomplete
          ? error.message
          : "INVALID_EVIDENCE",
    ];
  }
  const id = hash(body);
  db.put("execution-cashflow-proof", id, { ...body, id });
  if (transient) throw Error("cashflow proof RPC unavailable");
  return body.status === "KNOWN"
    ? {
        complete: true,
        netExternalFlowMicros: "0",
        hasExternalFlows: false,
        provenance: [id],
      }
    : undefined;
}
