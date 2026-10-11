import { mkdirSync, writeFileSync } from "node:fs";
import { compileContracts } from "../src/contracts.js";
mkdirSync("artifacts", { recursive: true });
for (const [name, artifact] of Object.entries(compileContracts()))
  writeFileSync(`artifacts/${name}.json`, JSON.stringify(artifact, null, 2));
console.log("Compiled A2A contract artifacts.");
