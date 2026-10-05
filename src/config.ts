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
  });
  if (new Set(c.roles.map((r) => r.id)).size !== c.roles.length)
    throw Error("duplicate roles");
  return c;
}
