# Protocol and process persistence

Persistence is a system requirement: protocol inputs, participants, state transitions, externally observed evidence, decisions, final artifacts and accounting outcomes must be durable and attributable to their round and operation. A successful pure calculation is not a completed business workflow until its required inputs and outputs have been committed. SQLite is the current local durable store; this does not make it a replicated blockchain or a distributed consensus database.

## Current storage coverage

| Domain | Current records |
| --- | --- |
| Identity and eligibility | `user`, `agent`, encrypted `wallet`, `chain-state`, staking and quarantine records |
| Election and round lifecycle | `election`, `term`, `epoch`, `incident`, `research-assignment` |
| Research inputs and work | `research-context`, `agent-context`, `llm-input`, `llm-call`, `llm-request`, `research-attempt`, `agent-tool`, `research-evidence`, `report` |
| Confirmation and final artifact | `research-final`, `commitment`, `confirmation-proposal`, `confirmation-intent`, `confirmation-vote`, published epoch data |
| Chain operations and budgets | `transaction`, transaction errors, credit/reservation/balance and reconciliation records |
| Investment reference risk | `investment-risk-cycle`, `investment-risk-order` (reference reservations, not executed trades) |
| Round accounting | `performance-input`, `performance-round`, `performance-agent`, `performance-investment` |

Agent context retains the supplied prompt, input, tool definitions, output schema and runtime limits. `llm-input` retains the actual dispatched request payload separately from provider credentials; corresponding call records retain outcomes. Successful tool records retain tool identity, parameters and observed output. Stored structured analysis is the explanation artifact; no hidden model reasoning is requested or required.

## State and history

`records` remains the current-state projection. `record_history` adds an ordered local sequence, entity kind/ID, operation, data snapshot and database recording time. SQLite triggers capture inserts, changed updates and deletions, including direct SQL mutations. Unchanged writes do not add transitions. History writes and business writes commit or roll back together. Update/delete triggers reject ordinary mutation of history. This is not tamper-proof against a database administrator who can alter schema or files.

Existing databases receive one migration-time `BASELINE` per current record. Earlier overwritten states cannot be reconstructed. Recording time is not a blockchain timestamp or proof of observation time. Cross-record relationships remain the business IDs stored in each payload; the local history sequence is not a QSP block number.

Backups must include the complete SQLite database, including history, using the existing consistent backup procedure. History retains encrypted wallet versions as well as other historical records: wallet-key rotation does not erase prior ciphertext. Access to the database and backups remains privileged. Do not persist plaintext private keys, API credentials or authenticated headers. Research request bodies and fetched content may contain sensitive contextual data and must not be exposed via unrestricted public APIs.

## Remaining integration work

This requirement is broader than the current coverage. Standalone allocation/wallet preview calculations still need a durable business execution wrapper. Tool dispatch/failure/interruption details do not yet have a complete per-attempt journal. Pre-dispatch provider refusal is not yet a complete request-attempt record. Historical hash-only contexts are not backfilled with invented content.

Stable-reserve portfolio collection, executable per-wallet decisions, DEX quotes, order dispatch, receipts, reconciliation and confirmed valuation/flow attribution must persist before those workflows can be accepted. They are not enabled by the reference risk guard. Current automatic round accounting explicitly records missing data rather than fabricated profit or zero returns. See [investment risk](investment-risk.md) and [performance accounting](performance-ledger.md).

Acceptance for each subsequent workflow must demonstrate: durable inputs and outputs, persisted failure/interruption state, restart recovery without duplicate side effects, atomic updates, ownership-aware queries, and links from each result back to its round and source records. Terminal logs and temporary JSON files alone do not meet this requirement.
