import type { Source } from "./sources.js";
/** Web/news citations are research evidence, not a verified market-data clock. */
export function verifiedDataAt(source: Source, cited: string[]): number {
  return !source.missing && cited.includes(source.url) ? source.at : 0;
}
export function evidenceMissing(
  source: Source,
  observations: { output: any }[],
): string[] {
  return [
    ...new Set([
      ...(source.missing
        ? [
            "Verified market asOf unavailable; web/news citations are research only",
          ]
        : []),
      ...observations.flatMap((o) =>
        Array.isArray(o.output?.missing) ? o.output.missing : [],
      ),
    ]),
  ]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.slice(0, 256));
}
