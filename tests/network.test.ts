import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { JsonRpcProvider } from "ethers";
import { configureProxy } from "../src/network.js";
test("proxy transport preserves JSON-RPC bodies and bypasses localhost", async () => {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data),
        answer = (r: any) => ({ jsonrpc: "2.0", id: r.id, result: "0x61" });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  configureProxy("http://127.0.0.1:1");
  const provider = new JsonRpcProvider(
    `http://127.0.0.1:${(server.address() as any).port}`,
  );
  try {
    assert.equal((await provider.getNetwork()).chainId, 97n);
  } finally {
    provider.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
