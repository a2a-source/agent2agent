import type { Epoch } from "./epochs.js";
import { verifyPublishedEpoch } from "./confirmation.js";
import { qspV2Schema } from "./qsp-v2.js";
import { validateNetworkAllocation } from "./network-allocation.js";
import { planWallet, walletPreviewInputSchema } from "./wallet-planner.js";
import { hash } from "./protocol.js";
/** Epoch must come from trusted local network state, not a caller-supplied committee. Snapshot remains unverified preview input. */
export function previewQspForWallet(
  epoch: Epoch,
  snapshotInput: unknown,
  policyInput: unknown,
  chainId: number,
  now: number,
) {
  if (
    !epoch.confirmationRequired ||
    !epoch.confirmation ||
    !verifyPublishedEpoch(chainId, epoch)
  )
    throw Error("published committee-confirmed QSP required");
  const q = qspV2Schema.parse(epoch.output);
  if (q.context.chainId !== chainId)
    throw Error("research and execution chain mismatch");
  if (
    !Number.isSafeInteger(now) ||
    now < q.createdAt ||
    now >= q.validUntil ||
    now < epoch.confirmation.confirmedAt
  )
    throw Error("QSP expired or not yet valid");
  const allocation = q.masterSummary.networkAllocation;
  if (!allocation)
    throw Error(
      "QSP has no explicit network allocation; wallet signals cannot be promoted",
    );
  const maxAge = q.context.policy.dataMaxAgeMs ?? 600000;
  const evidenceValidity = validateNetworkAllocation(
    allocation,
    q.context,
    q.reports,
    now,
    maxAge,
  );
  const snapshot = walletPreviewInputSchema.shape.snapshot.parse(snapshotInput);
  const policy = walletPreviewInputSchema.shape.policy.parse(policyInput);
  for (const p of snapshot.positions) {
    const known = q.context.universe.find(
      (a) => a.address.toLowerCase() === p.asset,
    );
    if (!known || known.decimals !== p.decimals)
      throw Error("snapshot asset metadata differs from signed universe");
  }
  const validUntil = Math.min(
    q.validUntil,
    evidenceValidity.validUntil,
    q.dataAt + maxAge,
    q.context.at + maxAge,
  );
  if (now >= validUntil) throw Error("QSP research expired");
  const preview = planWallet(
    {
      strategy: {
        version: "allocation-preview/1",
        id: hash(q),
        chainId,
        createdAt: q.createdAt,
        validUntil,
        targets: allocation.targets.map((t) => ({
          asset: t.asset,
          weightBps: t.targetWeightBps,
        })),
      },
      policy: {
        ...policy,
        maxAssetBps: Math.min(policy.maxAssetBps, q.context.policy.maxAssetBps),
        maxTotalBps: Math.min(policy.maxTotalBps, q.context.policy.maxTotalBps),
        maxSnapshotAgeMs: Math.min(policy.maxSnapshotAgeMs, maxAge),
      },
      snapshot,
    },
    now,
  );
  const source = {
    epoch: epoch.id,
    qspHash: hash(q),
    confirmationHash: hash(epoch.confirmation),
    scope: allocation.scope,
  };
  return { ...preview, id: hash({ previewId: preview.id, source }), source };
}
