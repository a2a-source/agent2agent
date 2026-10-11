import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import ganache from "ganache";
import { BrowserProvider, Contract } from "ethers";
function cli(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", script, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        p.kill();
        reject(Error("CLI timed out"));
      }, 20000);
      p.stdout.on("data", (b) => (stdout += b));
      p.stderr.on("data", (b) => (stderr += b));
      p.on("error", reject);
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );
}
test("release CLI rehearsal deploys seven-day contracts; preflight partial/strict/complete and RPC errors are redacted", async () => {
  const transport = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: 97, hardfork: "shanghai" },
    }),
    dir = mkdtempSync(join(tmpdir(), "a2a-release-cli-"));
  const provider = new BrowserProvider(transport as any);
  let failCode = false;
  const secret = "private-rpc-test-secret";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b) => (raw += b));
    req.on("end", async () => {
      const xs = JSON.parse(raw);
      const replies = await Promise.all(
        (Array.isArray(xs) ? xs : [xs]).map(async (x: any) => {
          try {
            if (failCode && x.method === "eth_getCode") throw Error(secret);
            return {
              jsonrpc: "2.0",
              id: x.id,
              result: await transport.request({
                method: x.method,
                params: x.params,
              }),
            };
          } catch (e: any) {
            return {
              jsonrpc: "2.0",
              id: x.id,
              error: { code: -32000, message: e.message },
            };
          }
        }),
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(xs) ? replies : replies[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const config = join(dir, "config.json"),
      url = `http://127.0.0.1:${(server.address() as any).port}/${secret}`;
    const accounts = transport.getInitialAccounts(),
      first = Object.values(accounts)[0]!;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      A2A_CONFIG: config,
      A2A_OPERATOR_PRIVATE_KEY: first.secretKey,
    };
    delete env.A2A_HTTP_PROXY;
    const base = {
      chain: { id: 97, rpcUrl: url, writesEnabled: true, confirmations: 1 },
      research: { enabled: false },
    };
    writeFileSync(config, JSON.stringify(base));
    const deployment = await cli("scripts/deploy.ts", [], env);
    assert.equal(deployment.code, 0, deployment.stderr);
    const deployed = deployment.stdout
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.equal(deployed.length, 2);
    const stake = deployed.find((d) => d.contract === "AgentStake").address,
      factory = deployed.find((d) => d.contract === "SplitterFactory").address;
    assert.notEqual(
      stake,
      factory,
      "deployment addresses must differ; nonce reuse",
    );
    assert.equal(
      await new Contract(
        stake,
        ["function unbondingSeconds() view returns(uint256)"],
        provider,
      ).unbondingSeconds!(),
      604800n,
    );
    assert.equal(
      (
        await new Contract(
          factory,
          ["function platform() view returns(address)"],
          provider,
        ).platform!()
      ).toLowerCase(),
      Object.keys(accounts)[0],
    );
    // Presence-only preflight: stake/factory addresses stand in for Flap contracts, not ABI compatibility.
    writeFileSync(
      config,
      JSON.stringify({
        ...base,
        chain: { ...base.chain, stakeAddress: stake, factoryAddress: factory },
      }),
    );
    for (const strict of [false, true]) {
      const r = await cli(
        "scripts/preflight.ts",
        strict ? ["--require-complete"] : [],
        env,
      );
      assert.equal(r.code, strict ? 1 : 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).complete, false);
      assert(!(r.stdout + r.stderr).includes(secret));
    }
    writeFileSync(
      config,
      JSON.stringify({
        ...base,
        chain: {
          ...base.chain,
          stakeAddress: stake,
          factoryAddress: factory,
          flapPortal: stake,
          flapImplementation: factory,
        },
      }),
    );
    const complete = await cli(
      "scripts/preflight.ts",
      ["--require-complete"],
      env,
    );
    assert.equal(complete.code, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).complete, true);
    failCode = true;
    const error = await cli(
      "scripts/preflight.ts",
      ["--require-complete"],
      env,
    );
    assert.equal(error.code, 1);
    assert(!(error.stdout + error.stderr).includes(secret));
    assert.match(error.stderr, /Preflight failed/);
  } finally {
    provider.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await transport.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
