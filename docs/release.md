# Release verification and contract boundaries

This guide describes the hosted prototype's release checks. It does not certify an audited mainnet deployment. See [usage](usage.md), [Agent research](agents.md) and [protocol behavior](protocol.md).

## Build and isolate the runtime

Run in the development checkout:

```sh
npm ci
npm test
npm run build
npm run format:check
npm audit --omit=dev
```

For a runtime installation, copy `package.json`, `package-lock.json` and `dist/` into a separate clean directory, then run:

```sh
npm ci --omit=dev
node dist/scripts/init.js
node dist/src/main.js
```

Initialize only a new installation: existing RSA keys and admin credentials must be retained and backed up. Supply local configuration as described in the usage guide. Check `/health`, authentication and clean shutdown before connecting an operational configuration. Do not copy development `node_modules` into the runtime directory.

Ganache and Solidity build/deployment tools are development-only. The lockfile explicitly marks Ganache's nested bundled dependencies as development dependencies too; some upstream bundled entries otherwise lack that classification. No versions or package integrity values are changed by this classification. The full development audit still reports advisories, including high/critical findings. Keep the local test EVM private. A clean production install excludes Ganache, solc and tsx; use compiled JavaScript to run the service. Audit results are time-sensitive and must be checked again for each release.

## CLI and deployment rehearsal

`tests/release-cli.test.ts` runs an isolated local EVM and exercises the real deployment and preflight CLIs:

| Check | Expected result |
| --- | --- |
| Deploy stake and splitter factory | Distinct addresses; seven-day stake delay and expected platform recipient |
| Ordinary preflight with missing contracts | Exit 0, `complete: false`, explicit missing list |
| Strict partial preflight | Exit 1 |
| Strict complete presence check | Exit 0, `complete: true` |
| RPC errors containing sensitive endpoint text | Nonzero exit with a generic error, no credential text |

The fixture uses local contracts as Flap address placeholders for presence checks. It does not prove Flap ABI compatibility or external integration. Preflight confirms code presence at a confirmed block; inspect launch readiness separately.

Deployment manages sequential nonces explicitly and disables provider caching for this operation. Use a dedicated operator environment and do not share the sender with concurrent programs. The deployment CLI is not a crash-resumable deployment journal: inspect already reported addresses, transaction receipts and sender nonce after interruption before retrying. RPC failures are redacted, so use local transaction records for detailed diagnosis.

## Funds-contract review scope

The repository's contract tests and focused source review cover receipt conservation, failed-recipient recovery, factory identity, and owner-only delayed stake withdrawal.

| Contract | Invariant and boundary |
| --- | --- |
| `RevenueSplitter` | Platform receives floor(30%); Agent receives the remainder. Compute accounting is floor(15%) within the platform share. Failed callbacks retain pending balances; reentrant receipt/flush calls are rejected. |
| `SplitterFactory` | CREATE2 binds factory, platform, request ID and Agent. Consumers must identify an allocation by both ID and Agent; the same ID with a different Agent is a different allocation. |
| `AgentStake` | Only the caller's stake/exit can change. Exit removes bonded eligibility immediately; withdrawal waits for the configured delay. Principal has no slashing or administrator-withdrawal path. |

Immutable recipients must accept BNB within the splitter's 50,000-gas callback budget. A permanently incompatible recipient can leave revenue pending indefinitely. Forced BNB transfers bypass normal receipt accounting and have no rescue path. These constraints must be considered when choosing recipients; no upgrade or arbitrary rescue role is provided.

Local EVM tests, testnet receipts and internal review are distinct forms of evidence. None substitutes for third-party auditing. DEX migration tax settlement, research factual quality and real nonempty-portfolio strategy validation retain their separately recorded acceptance boundaries. Investment execution, portfolio settlement and profit distribution remain a later phase.
