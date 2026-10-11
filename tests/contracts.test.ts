import { test } from "node:test";
import assert from "node:assert/strict";
import ganache from "ganache";
import { BrowserProvider, ContractFactory, Contract, parseEther } from "ethers";
import { compileContracts } from "../src/contracts.js";
test("real EVM splits receipts, locks stake and enforces delayed owner withdrawal", async () => {
  const transport = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  try {
    const provider = new BrowserProvider(transport as any);
    const platform = await provider.getSigner(0),
      agent = await provider.getSigner(1),
      outsider = await provider.getSigner(2);
    const contracts = compileContracts();
    const split = await new ContractFactory(
      contracts.RevenueSplitter!.abi,
      contracts.RevenueSplitter!.bytecode,
      platform,
    ).deploy(await platform.getAddress(), await agent.getAddress());
    await split.waitForDeployment();
    const before = await provider.getBalance(await agent.getAddress());
    const tx = await outsider.sendTransaction({
      to: await split.getAddress(),
      value: 10001n,
    });
    const receipt = await tx.wait();
    assert.equal(
      BigInt(
        await provider.send("eth_getBalance", [
          await agent.getAddress(),
          "latest",
        ]),
      ) - before,
      7001n,
    );
    const log = receipt!.logs
      .map((l) => {
        try {
          return split.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l?.name === "PlatformPaid");
    assert.equal(log?.args.compute, 1500n);
    const stake = await new ContractFactory(
      contracts.AgentStake!.abi,
      contracts.AgentStake!.bytecode,
      platform,
    ).deploy(60);
    await stake.waitForDeployment();
    const connected = stake.connect(agent) as Contract;
    await (
      await connected.getFunction("deposit")({ value: parseEther("0.3") })
    ).wait();
    assert.equal(
      await stake.getFunction("bonded")(await agent.getAddress()),
      parseEther("0.3"),
    );
    await (await connected.getFunction("requestExit")()).wait();
    assert.equal(
      await stake.getFunction("bonded")(await agent.getAddress()),
      0n,
    );
    await assert.rejects(connected.getFunction("withdraw")());
    await provider.send("evm_increaseTime", [61]);
    await provider.send("evm_mine", []);
    await assert.rejects(
      (stake.connect(outsider) as Contract).getFunction("withdraw")(),
    );
    await (
      await connected.getFunction("withdraw")({ gasLimit: 200000 })
    ).wait();
    assert.equal(
      (await stake.getFunction("exits")(await agent.getAddress()))[0],
      0n,
    );
  } finally {
    await transport.disconnect();
  }
});
