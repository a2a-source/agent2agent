# Running Agent2Agent v0.1

Agent2Agent provides a custodial Agent API, BSC token launch and staking adapters, and a hosted Smart QSP research network. It produces signed research reports and proposed signals. It does not execute investments or distribute investment profits.

## Requirements and local startup

Use Node.js 22.13 or newer and npm. SQLite is bundled through `node:sqlite`; Node 22 may print its experimental-feature warning. No Redis, separate database server, or local LLM is required.

```sh
npm ci
npm run build
npm test
npm run demo
npm run init
npm start
```

The demo runs seven Agents against explicitly simulated chain state and a local compatible LLM fixture. It makes no real token launches or investments. Contract tests use Ganache and real deployed local EVM contracts; the Flap fixture implements the integration ABI, not Flap's bonding curve. Ganache may fall back to its JavaScript transport when a native µWS binary is unavailable.

`init` creates RSA keys in `var/keys/` and an administrative API credential in `var/admin-token`, with restricted file permissions. It refuses to overwrite existing credentials. Keep a separate, protected backup of the RSA private key: the database cannot recover encrypted wallet keys without it. These runtime files are ignored by Git.

The default API listens on `127.0.0.1:3000`, with chain writes disabled. Protect remote access with TLS and access controls. Administrative credentials must never be distributed to ordinary users. User enrollment is operator managed in this version.

## Configuration

`config/default.json` contains the supported defaults. Set `A2A_CONFIG` to a JSON override file, such as the Git-ignored `config/local.json`. Top-level fields replace defaults; `chain`, `network` and `llm` merge their fields. A custom `roles` array replaces the entire default array. Role IDs must be unique.

| Environment variable | Purpose |
| --- | --- |
| `A2A_CONFIG` | Configuration override path |
| `A2A_ADMIN_TOKEN` | Overrides the local admin-token file; at least 24 characters |
| `A2A_LLM_API_KEY` | Credential for the configured compatible LLM endpoint |
| `A2A_OPERATOR_PRIVATE_KEY` | Separate funded deployment and token-launch wallet; never the Agent investment wallet |
| `A2A_PLATFORM_ADDRESS` | Platform receiver used by the deployment CLI; defaults to the operator address |
| `A2A_HTTP_PROXY` | Optional explicit HTTP proxy for outbound RPC, Flap upload, data and LLM requests |
| `NO_PROXY` | Proxy bypass list; defaults to localhost and loopback |

For example, an already-running local VPN HTTP proxy can be used with `A2A_HTTP_PROXY=http://127.0.0.1:7897`. The application does not modify system VPN settings. Configure external endpoints yourself; API users cannot change them.

LLM `endpoint` is a base URL such as `https://provider.example/v1`; `/chat/completions` is appended. The provider must support JSON-object output, `max_tokens`, and `usage.prompt_tokens` / `usage.completion_tokens`. Prices are operator-specified integer wei per million tokens. These are accounting tariffs, not an automatic BNB/fiat conversion. Missing usage or ambiguous network failures retain the reserved budget for reconciliation.

Each role may have a `sourceUrl`. Its JSON response must be:

```json
{"asOf": 1791220000000, "data": {"observations": []}}
```

`asOf` is the underlying data time in Unix milliseconds. Undated, future-dated, oversized or expired data is marked missing. LLM reports cannot invent source URLs; signals must cite roles with source-backed reports. Without configured sources the system can produce a signed, explicit no-data report with no investment signals. It has no built-in access to X or commercial news subscriptions.

## Connect BSC and Flap

Supply `chain.rpcUrl` (QuickNode or compatible BSC RPC), the correct `chain.id`, and deployed `stakeAddress`, `factoryAddress`, `flapPortal` and `flapImplementation`. `flapImplementation` must be the V3 tax-token implementation used for Portal V6 CREATE2 launches. Verify addresses against the [official Flap deployment list](https://docs.flap.sh/flap/developers/deployed-contract-addresses).

```sh
A2A_CONFIG=config/local.json npm run preflight
npm run contracts:build
```

`preflight` only reads the chain ID, a confirmed block and configured contract code. All code is read at the same confirmation-depth snapshot; a changed block hash rejects the result. It lists missing contract configuration and reports `complete: false` for a partial setup. For automated integration checks, require all four contract addresses and deployed code:

```sh
A2A_CONFIG=config/local.json npm run preflight -- --require-complete
```

Strict mode exits nonzero if any required contract is missing. `complete: true` means only that configured contracts have code on the expected chain; it does not establish ABI compatibility, correct receivers, supported Flap versions, available funding, an audited contract or launch readiness. The launch adapter performs additional checks during execution. RPC failures are reported without printing endpoint credentials.

Start a local override with `cp config/example.json config/local.json`, then replace the `.invalid` URL placeholders and fill in verified contract addresses. The example keeps chain writes disabled and contains no credentials. Set `fromBlock` to your earliest required activity before enabling indexing.

`npm run deploy` deploys the A2A stake contract and splitter factory using the operator wallet. This command spends real funds on the configured network. It requires `chain.writesEnabled=true` and an operator key. Deployment prints addresses to add to local configuration. There is no automatic mainnet deployment at startup.

The splitter has immutable platform/Agent recipients and forwards 30%/70% of actual BNB receipts. Within the platform share, 15 percentage points are credited to the Agent's compute budget. Failed recipient transfers remain pending and anyone can call `flush()` to retry. Compute credit is indexed only after `PlatformPaid` is confirmed. This is a direct Portal beneficiary contract, not a Flap verified Vault or an upgradeable Guardian-controlled vault.

Use a pinned Flap metadata CID when requesting a token. The upload helper calls the documented Flap multipart API:

```sh
npm run metadata:upload -- image.png "Token description"
```

Portal V6 creates the token with 300 bps buy and sell tax, no initial purchase, native BNB quote, and the Agent's splitter as beneficiary. The worker searches the required `7777` CREATE2 suffix and persists the result. The default tax duration is ten years, not perpetual. Flap protocol fees are additional and may change; 3% token tax does not imply 3% total trading cost.

The adapter verifies creation-event identity, tax rates, TaxProcessor market receiver and splitter recipients before marking a launch confirmed. After funding and enabling chain writes, the scheduler advances pending launches. Read-only mode does not broadcast them. A supported Flap testnet deployment is not assumed; supply and verify the actual network configuration.

Set `chain.fromBlock` to the earliest splitter activity you need to index. `confirmations` defaults to 12; this is a configurable confirmation-depth policy, not a promise of BSC fast finality. Balance monitoring uses confirmed native BNB state, so external people/programs can fund an Agent. It supplements observations with periodic polling.

## API workflow

All endpoints except `/health` require `Authorization: Bearer <token>`. Set `ADMIN_TOKEN` from your local credential and obtain user tokens through the admin API. The server never returns Agent private keys.

```sh
ADMIN_TOKEN=$(cat var/admin-token)
curl -s http://127.0.0.1:3000/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice"}'
```

Save the returned user token securely. With `USER_TOKEN` set to that value:

```sh
curl -s http://127.0.0.1:3000/agents \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Idempotency-Key: alice-token-1' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice Agent","symbol":"ALICE","meta":"YOUR_PINNED_CID"}'
```

The initial response provides the Agent ID and BSC wallet. Repeating the same key and body returns the same identity; changing the body rejects the request. Ownership is derived from the user token, never from a supplied owner ID. Initial chain state is unknown until a successful sync.

| Method and path | Authorization | Behavior |
| --- | --- | --- |
| `GET /health` | Public | Process liveness |
| `POST /admin/users` | Admin | Create user, return user credential once |
| `POST /agents` | User | Create token request, encrypted wallet and Agent identity |
| `GET /agents` | User or admin | List owned Agents, or all for admin |
| `GET /agents/:id` | Owner or admin | Public identity, qualification and balance observations |
| `POST /agents/:id/launch` | Owner or admin | Advance configured chain launch, return pending or confirmed state |
| `POST /agents/:id/exit` | Owner or admin | Disable auto-staking and request guarantee unbonding |
| `POST /agents/:id/withdraw` | Owner or admin | Claim unlocked guarantee back to the same Agent wallet |
| `GET /network/epochs` | Authenticated | Committee, generation, status, published QSP and signature |
| `POST /admin/compute/credit` | Admin | Record externally reconciled compute funding using unique reference |
| `POST /admin/compute/reconcile` | Admin | Settle an uncertain call using actual wei cost |
| `POST /admin/tick` | Admin | Trigger a scheduler pass; work proceeds in the background |
| `POST /admin/evidence` | Admin | Validate conflicting signed commitments and quarantine identity |
| `POST /admin/unjail` | Admin | Explicitly release operational quarantine after investigation |

Compute credit body: `{"agent":"ID","reference":"UNIQUE_RECEIPT","amountWei":"10000000000000000"}`. Reconciliation body: `{"callId":"ID","actualWei":"1000"}`. Neither action transfers investment principal. Manual credits require the operator to verify the funding source first.

Exit and withdrawal concern the bonded guarantee only. v0.1 does not expose arbitrary investment-wallet transfers or investment execution. Pending operations and unknown provider charges survive restart.

## Operations and limitations

Use one service process per SQLite database. Durable signing locks additionally prevent separate Journal instances from allocating conflicting sender nonces. The operator signing wallet must not be concurrently used by external programs. Do not directly edit ledger rows or clear pending transactions to force a retry.

Back up SQLite using SQLite's backup facility or after a clean shutdown; copying only the main file while WAL writes are active is insufficient. Keep keys and database backups separate. Runtime recovery retries the exact signed transaction bytes and reconciles receipts. Insufficient Gas, reverted transactions and provider outages do not authorize a new spend with a guessed nonce.

A confirmed-cursor block hash change marks chain state unknown and requires operator reconciliation; this version does not automatically reverse already-consumed compute credit after a deep reorganization. There is no production monitoring service, remote worker transport, independent-validator consensus, or audited mainnet deployment bundled with v0.1. Smart QSP and all Agent keys remain under one operator's custody.

See [the implemented protocol](protocol.md) for election, failover and penalties. `npm test` covers SQLite recovery, authenticated ownership, RPC transaction recovery, hosted LLM calls, signed QSP production and local contract behavior. Real provider credentials and a configured network are needed for deployment-specific validation.

For a runtime-only deployment, build first in the development environment, retain `dist/`, and install with `npm ci --omit=dev`. Start with `node dist/src/main.js`. Initialize credentials with `node dist/scripts/init.js` if needed. Solidity compilation and deployment helpers require the development tooling and should run in a separate operator environment.

The Ganache development fixture currently bundles dependencies with npm audit advisories, including high and critical findings. These packages are excluded by a clean `--omit=dev` installation; do not expose the test EVM or copy the development `node_modules` tree into production. The full dependency audit is not clean.
