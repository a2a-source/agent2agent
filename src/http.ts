/** Bound external data before parsing, including chunked responses. */
export async function readJson(
  response: Response,
  maxBytes = 1000000,
): Promise<unknown> {
  if (!response.body) throw Error("empty response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw Error("response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
