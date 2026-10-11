import { z } from "zod";
import { isAddress, verifyMessage } from "ethers";
import { qspV2Schema } from "./qsp-v2.js";
import { hash } from "./protocol.js";
export const reportSchema = z
  .object({
    summary: z.string().min(1).max(12000),
    sources: z.array(z.string().url()).max(32),
    missing: z.array(z.string().max(256)).max(32),
  })
  .strict();
export const signalSchema = z
  .object({
    chainId: z.number().int().positive(),
    asset: z.string().refine(isAddress),
    action: z.enum(["BUY", "SELL", "HOLD"]),
    allocationBps: z.number().int().min(0).max(10000),
    rationale: z.string().min(1).max(4000),
    evidence: z.array(z.string()).min(1).max(24),
  })
  .strict();
export const synthesisSchema = z
  .object({
    signals: z.array(signalSchema).max(32),
    risks: z.array(z.string().min(1).max(2000)).min(1).max(32),
  })
  .strict()
  .refine(
    (s) =>
      s.signals
        .filter((x) => x.action === "BUY")
        .reduce((n, x) => n + x.allocationBps, 0) <= 10000,
    "aggregate BUY allocation exceeds 100%",
  );
export const qspV1Schema = z
  .object({
    version: z.literal("a2a-qsp/1"),
    epoch: z.string(),
    view: z.number().int().nonnegative(),
    master: z.string(),
    committeeHash: z.string(),
    configHash: z.string(),
    dataAt: z.number().int().nonnegative(),
    reports: z
      .array(reportSchema.extend({ role: z.string(), agent: z.string() }))
      .min(1),
    signals: z.array(signalSchema),
    risks: z.array(z.string()).min(1),
    executed: z.literal(false),
  })
  .strict();
export const qspSchema = z.union([qspV1Schema, qspV2Schema]);
export function signingMessage(chainId: number, payload: unknown) {
  return `A2A-QSP:${(payload as any)?.version === "a2a-qsp/2" ? "2" : "1"}:${chainId}:${hash(payload)}`;
}
export function verifyQsp(
  chainId: number,
  payload: unknown,
  signature: string,
  wallet: string,
) {
  qspSchema.parse(payload);
  return (
    verifyMessage(signingMessage(chainId, payload), signature).toLowerCase() ===
    wallet.toLowerCase()
  );
}
