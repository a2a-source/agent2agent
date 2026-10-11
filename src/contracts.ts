import { readFileSync } from "node:fs";
// solc exposes its own stable JSON compiler interface.
import solc from "solc";
import type { InterfaceAbi } from "ethers";
export interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
}
export function compileContracts(
  extra: Record<string, { content: string }> = {},
): Record<string, Artifact> {
  const input = {
    language: "Solidity",
    sources: {
      "A2A.sol": {
        content: readFileSync(
          new URL("../contracts/A2A.sol", import.meta.url),
          "utf8",
        ),
      },
      ...extra,
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length)
    throw Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  const result: Record<string, Artifact> = {};
  for (const file of Object.values(out.contracts) as any[])
    for (const [name, c] of Object.entries(file) as [string, any][])
      result[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  return result;
}
