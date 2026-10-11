import { z } from "zod";
const uint = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(78);
export const executionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    dex: z.unknown().optional(),
    maxTransactionFeeWei: uint.default("100000000000000"),
    retryMs: z.number().int().min(100).max(60000).default(5000),
    leaseMs: z.number().int().min(1000).max(300000).default(120000),
    maxJobsPerTick: z.number().int().min(1).max(32).default(4),
  })
  .strict();
