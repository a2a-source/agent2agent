import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { WalletVault } from "./wallet.js";
/** Configuration references local key files. PEM contents never enter public config or API. */
export function loadVault(config: Config): WalletVault {
  if (!config.rsaKeyRingFile)
    return new WalletVault(
      readFileSync(config.rsaPublicKey, "utf8"),
      readFileSync(config.rsaPrivateKey, "utf8"),
      config.rsaKeyId,
    );
  const entries = z
    .array(
      z
        .object({
          id: z.string().min(1),
          publicKeyPath: z.string().min(1),
          privateKeyPath: z.string().min(1),
        })
        .strict(),
    )
    .min(1)
    .parse(JSON.parse(readFileSync(config.rsaKeyRingFile, "utf8")));
  return new WalletVault(
    entries.map((e) => ({
      id: e.id,
      publicPem: readFileSync(e.publicKeyPath, "utf8"),
      privatePem: readFileSync(e.privateKeyPath, "utf8"),
    })),
    config.rsaKeyId,
  );
}
