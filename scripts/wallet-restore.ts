import { loadConfig } from "../src/config.js";
import { loadVault } from "../src/runtime-vault.js";
import { restoreWalletBackup } from "../src/wallet-maintenance.js";
try {
  const [source, target, ...rest] = process.argv.slice(2);
  if (!source || !target || rest.length) throw Error("usage");
  const vault = loadVault(loadConfig(process.env.A2A_CONFIG));
  await restoreWalletBackup(source, target, vault);
  console.log(JSON.stringify({ restored: true, target }));
} catch {
  console.error(
    "Restore rejected: use a verified snapshot and configured keys, and an absent destination. Usage: wallet:restore -- snapshot.sqlite new.sqlite",
  );
  process.exitCode = 1;
}
