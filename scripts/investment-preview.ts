import { readFileSync } from "node:fs";
import { InvestmentPreviewJournal } from "../src/investment-preview-journal.js";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
try {
  const [file, time, database, ...extra] = process.argv.slice(2);
  if (!file || !time || extra.length || !/^(0|[1-9][0-9]*)$/.test(time))
    throw Error(
      "Usage: npm run investment:preview -- <input.json> <evaluation-time-ms> [database.sqlite]",
    );
  const input: unknown = JSON.parse(readFileSync(file, "utf8"));
  const db = new Store(database ?? loadConfig().database);
  try {
    const record = new InvestmentPreviewJournal(db).preview(
      input,
      Number(time),
    );
    process.stdout.write(JSON.stringify(record, null, 2) + "\n");
    if (record.status === "REJECTED") process.exitCode = 1;
  } finally {
    db.close();
  }
} catch (e) {
  // Do not echo unvalidated file contents or potentially sensitive parser input.
  process.stderr.write(
    "Investment preview rejected: check input schema, freshness, coverage and budget.\n",
  );
  process.exitCode = 1;
}
