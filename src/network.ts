import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type FormData,
} from "undici";
import { FetchRequest } from "ethers";
let dispatcher: Dispatcher | undefined;
export function networkFetch(
  input: string | URL,
  init?: Omit<RequestInit, "body"> & { body?: RequestInit["body"] | FormData },
): Promise<Response> {
  return undiciFetch(input, { ...init, dispatcher } as Parameters<
    typeof undiciFetch
  >[1]) as unknown as Promise<Response>;
}
/** Explicit opt-in proxy; never change the machine's system/VPN configuration. */
export function configureProxy(url = process.env.A2A_HTTP_PROXY) {
  if (!url) return;
  dispatcher = new EnvHttpProxyAgent({
    httpProxy: url,
    httpsProxy: url,
    noProxy: process.env.NO_PROXY ?? "localhost,127.0.0.1,::1",
  });
  FetchRequest.registerGetUrl(async (req, signal) => {
    signal?.checkSignal();
    const controller = new AbortController();
    signal?.addListener(() => controller.abort());
    const response = await networkFetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: new Uint8Array(req.body) } : {}),
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.min(req.timeout, 30000)),
      ]),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length > 10000000) throw Error("RPC response too large");
    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers),
      body,
    };
  });
}
