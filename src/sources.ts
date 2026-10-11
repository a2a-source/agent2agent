import { networkFetch as fetch } from "./network.js";
import { readJson } from "./http.js";
export interface Source {
  url: string;
  at: number;
  missing: boolean;
  data: unknown;
}
/** Data adapters return {asOf: Unix milliseconds, data: JSON}; retrieval time is not market time. */
export async function loadSource(
  url: string,
  now: number,
  maxAgeMs: number,
  signal?: AbortSignal,
): Promise<Source> {
  const absent: Source = { url, at: now, missing: true, data: null };
  if (!url) return absent;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([
        AbortSignal.timeout(10000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) return absent;
    const body = (await readJson(response, 16000)) as any;
    if (
      !Number.isSafeInteger(body.asOf) ||
      body.asOf > now + 30000 ||
      body.asOf < now - maxAgeMs ||
      body.data === undefined
    )
      return absent;
    return { url, at: body.asOf, missing: false, data: body.data };
  } catch {
    return absent;
  }
}
