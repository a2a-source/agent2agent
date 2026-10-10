import { readFileSync } from "node:fs";
import { planWallet } from "../src/wallet-planner.js";
try {
  const [file, time, ...extra] = process.argv.slice(2);
  if (!file || !time || extra.length || !/^(0|[1-9][0-9]*)$/.test(time))
    throw Error(
      "Usage: npm run investment:preview -- <input.json> <evaluation-time-ms>",
    );
  const input: unknown = JSON.parse(readFileSync(file, "utf8"));
  process.stdout.write(
    JSON.stringify(planWallet(input, Number(time)), null, 2) + "\n",
  );
} catch (e) {
  // Do not echo unvalidated file contents or potentially sensitive parser input.
  process.stderr.write(
    "Investment preview rejected: check input schema, freshness, coverage and budget.\n",
  );
  process.exitCode = 1;
}
