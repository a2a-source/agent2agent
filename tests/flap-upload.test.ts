import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { uploadMetadata } from "../src/flap.js";

test("Flap upload sends actual multipart bytes through the production HTTP transport", async () => {
  let contentType = "",
    body = "";
  const server = createServer(async (req, res) => {
    contentType = req.headers["content-type"] ?? "";
    for await (const chunk of req) body += chunk.toString();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { create: "test-cid" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    assert.equal(
      await uploadMetadata(
        new Uint8Array([1, 2, 3]),
        "test.png",
        { description: "test" },
        `http://127.0.0.1:${address.port}`,
      ),
      "test-cid",
    );
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(body, /name="operations"/);
    assert.match(body, /name="map"/);
    assert.match(body, /filename="test.png"/);
    assert.match(body, /Create\(/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
