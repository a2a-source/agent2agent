import { z } from "zod";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import { planWallet, walletPreviewInputSchema } from "./wallet-planner.js";
type PreviewInput = z.infer<typeof walletPreviewInputSchema>;
interface PreviewRecord {
  id: string;
  version: "investment-preview-record/1";
  evaluatedAt: number;
  recordedAt: number;
  input: PreviewInput;
  status: "DONE" | "REJECTED";
  output?: ReturnType<typeof planWallet>;
  reason?: "PLANNER_VALIDATION_FAILED";
}
/** Local audit wrapper; does not authenticate balances or authorize execution. */
export class InvestmentPreviewJournal {
  constructor(readonly db: Store) {}
  preview(raw: unknown, now: number): PreviewRecord {
    z.number().int().safe().nonnegative().parse(now);
    // Reject arbitrary fields before archival: credentials are not protocol inputs.
    const input = walletPreviewInputSchema.parse(raw);
    const id = hash({ version: "investment-preview-record/1", input, now });
    return this.db.transaction(() => {
      const prior = this.db.get<PreviewRecord>("investment-preview", id);
      if (prior) return prior;
      let output: ReturnType<typeof planWallet> | undefined;
      try {
        output = planWallet(input, now);
      } catch {
        // Deterministic business rejection; no unbounded error text in the ledger.
      }
      const result: PreviewRecord = {
        id,
        version: "investment-preview-record/1",
        evaluatedAt: now,
        recordedAt: Date.now(),
        input,
        status: output ? "DONE" : "REJECTED",
        ...(output
          ? { output }
          : { reason: "PLANNER_VALIDATION_FAILED" as const }),
      };
      this.db.insert("investment-preview", id, result);
      return result;
    });
  }
}
