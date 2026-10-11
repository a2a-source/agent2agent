import { z } from "zod";
export const templateSchema = z
  .object({
    version: z.literal("role-report/1"),
    title: z.string().min(1).max(120),
    sections: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z_]+$/)
              .max(64),
            title: z.string().min(1).max(120),
            instruction: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .refine(
    (t) => new Set(t.sections.map((s) => s.id)).size === t.sections.length,
    "duplicate template sections",
  );
export const reportSectionSchema = z
  .object({
    id: z.string().min(1).max(64),
    content: z.string().min(1).max(2400),
    evidenceRefs: z.array(z.string().min(1).max(2048)).max(24),
  })
  .strict();
export type ReportTemplate = z.infer<typeof templateSchema>;
export function validateReportSections(
  template: ReportTemplate,
  sections: unknown,
  allowed: Set<string>,
) {
  const rows = z.array(reportSectionSchema).max(8).parse(sections);
  if (
    rows.length !== template.sections.length ||
    rows.some((r, i) => r.id !== template.sections[i]?.id)
  )
    throw Error("report template sections missing, reordered or duplicated");
  if (rows.some((r) => r.evidenceRefs.some((ref) => !allowed.has(ref))))
    throw Error("report template fabricated evidence");
  return rows;
}
