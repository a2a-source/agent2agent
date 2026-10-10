import { templateSchema } from "./report-templates.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { assetSchema, assertResearchAssets } from "./research-context.js";
const wei = z.string().regex(/^(0|[1-9][0-9]*)$/);
const integer = z.number().int().positive().safe();
const schema = z.object({
  confirmation: z.object({ timeoutMs: integer }).default({ timeoutMs: 60000 }),
  reportTemplates: z.record(templateSchema),
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
  agent: z.object({
    maxToolRounds: integer.max(20),
    maxToolCalls: integer.max(100),
    toolsEnabled: z.boolean(),
  }),
  llm: z.object({
    structuredOutputs: z.boolean().default(false),
    reasoningEffort: z
      .enum(["none", "minimal", "low", "medium", "high"])
      .optional(),
    apiKeyFile: z.string().default(""),
    requestLimitPerDay: z.number().int().nonnegative().default(0),
    endpoint: z.string().url(),
    model: z.string().min(1),
    timeoutMs: integer,
    maxInputBytes: integer.max(1000000),
    maxOutputTokens: integer.max(32000),
    // Fixed conversion is only used by offline fixtures; main always injects the oracle.
    bnbUsdMicros: wei.default("0"),
    priceFeed: z.string().default(""),
    priceMaxAgeSeconds: integer.default(3900),
  }),
  research: z.object({
    enabled: z.boolean().default(true),
    chainId: integer.default(56),
    rpcUrl: z.string().default(""),
    portfolioWallet: z.string().default(""),
    accountingFile: z.string().default(""),
    gasReserveWei: wei.default("1000000000000000"),
    maxAgeMs: integer.default(600000),
    maxAssetBps: integer.max(10000).default(3000),
    maxTotalBps: integer.max(10000).default(8000),
    minLiquidityUsd: z.number().int().safe().nonnegative().default(1000000),
    maxSlippageBps: integer.max(10000).default(100),
    validForMs: integer.default(300000),
    newsQuery: z
      .string()
      .max(300)
      .default("Bitcoin Ethereum BNB macro economy when:1d"),
    assets: z.array(assetSchema).min(1).max(24),
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
  base.reportTemplates = JSON.parse(
    readFileSync(
      new URL("../config/report-templates.json", import.meta.url),
      "utf8",
    ),
  );
  const override = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  const c = schema.parse({
    ...base,
    ...override,
    confirmation: { ...base.confirmation, ...override.confirmation },
    chain: { ...base.chain, ...override.chain },
    network: { ...base.network, ...override.network },
    llm: { ...base.llm, ...override.llm },
    agent: { ...base.agent, ...override.agent },
    recovery: { ...base.recovery, ...override.recovery },
    settlement: { ...base.settlement, ...override.settlement },
    research: { ...base.research, ...override.research },
  });
  if (new Set(c.roles.map((r) => r.id)).size !== c.roles.length)
    throw Error("duplicate roles");
  if (
    new Set(c.research.assets.map((a) => a.address.toLowerCase())).size !==
    c.research.assets.length
  )
    throw Error("duplicate research assets");
  if (
    c.research.enabled &&
    ["master", ...c.roles.map((r) => r.id)].some((id) => !c.reportTemplates[id])
  )
    throw Error("missing report template for configured role");
  if (c.research.enabled)
    assertResearchAssets(c.research.chainId, c.research.assets);
  return c;
}
