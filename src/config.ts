import { readFileSync } from "node:fs";
import { z } from "zod";
const wei = z.string().regex(/^(0|[1-9][0-9]*)$/);
const integer = z.number().int().positive().safe();
const schema = z.object({
  host: z.string(),
  port: z.number().int().min(0).max(65535),
  database: z.string(),
  rsaPublicKey: z.string(),
  rsaPrivateKey: z.string(),
  rsaKeyId: z.string().min(1),
  rsaKeyRingFile: z.string().default(""),
  settlement: z.object({
    minRevenueWei: wei,
    maxFeeWei: wei,
    dailyBudgetWei: wei,
    gasReserveWei: wei,
    intervalMs: integer,
  }),
  recovery: z.object({
    researchConcurrency: integer.max(16),
    researchMaxAttempts: integer.max(8),
    scanPagesPerTick: integer.max(100),
    retryBaseMs: integer,
    retryMaxMs: integer,
    maxAttempts: integer.max(100),
    deadlineMs: integer,
    cooldownMs: integer,
    bumpAfterAttempts: integer,
    maxFeeBumps: z.number().int().min(0).max(10),
    maxGasPriceWei: wei,
    maxLogicalAttempts: z.number().int().min(0).max(5),
    walletBatchSize: integer,
    backupDirectory: z.string(),
    backupIntervalMs: integer,
    maxBackups: integer.max(1000),
  }),
  chain: z.object({
    id: integer,
    rpcUrl: z.string(),
    writesEnabled: z.boolean(),
    confirmations: integer,
    fromBlock: z.number().int().nonnegative(),
    gasReserveWei: wei,
    stakeAddress: z.string(),
    factoryAddress: z.string(),
    flapPortal: z.string(),
    flapImplementation: z.string(),
    taxDuration: integer,
    launchValueWei: wei,
    flapDexThreshold: z.number().int().min(0).max(5).default(0),
  }),
  network: z.object({
    termSlots: integer,
    committeeSize: integer.min(3).max(45),
    timeoutMs: integer,
    epochMs: integer,
    pollMs: integer,
    stateMaxAgeMs: integer,
    sourceMaxAgeMs: integer,
    failureLimit: integer,
    jailMs: integer,
  }),
  llm: z.object({
    endpoint: z.string().url(),
    model: z.string().min(1),
    timeoutMs: integer,
    maxInputBytes: integer.max(1000000),
    maxOutputTokens: integer.max(32000),
    inputWeiPerMillion: wei,
    outputWeiPerMillion: wei,
  }),
  masterPrompt: z.string().min(1),
  roles: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        prompt: z.string().min(1),
        sourceUrl: z.string(),
      }),
    )
    .min(1)
    .max(24),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(path?: string): Config {
  const base = JSON.parse(
    readFileSync(new URL("../config/default.json", import.meta.url), "utf8"),
  );
  const override = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  const c = schema.parse({
    ...base,
    ...override,
    chain: { ...base.chain, ...override.chain },
    network: { ...base.network, ...override.network },
    llm: { ...base.llm, ...override.llm },
    recovery: { ...base.recovery, ...override.recovery },
    settlement: { ...base.settlement, ...override.settlement },
  });
  if (new Set(c.roles.map((r) => r.id)).size !== c.roles.length)
    throw Error("duplicate roles");
  return c;
}
