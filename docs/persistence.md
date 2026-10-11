# Protocol and process persistence

Persistence is a system requirement: protocol inputs, participants, state transitions, externally observed evidence, decisions, final artifacts and accounting outcomes must be durable and attributable to their round and operation. A successful pure calculation is not a completed business workflow until its required inputs and outputs have been committed. SQLite is the current local durable store; this does not make it a replicated blockchain or a distributed consensus database.

## Current storage coverage

| Domain | Current records |
| --- | --- |
| Identity and eligibility | `user`, `agent`, encrypted `wallet`, `chain-state`, staking and quarantine records |
| Election and round lifecycle | `election`, `term`, `epoch`, `incident`, `research-assignment` |
| Research inputs and work | `research-context`, `agent-context`, `llm-input`, `llm-call`, `llm-request`, `research-task`, `research-attempt`, `agent-tool-call`, `agent-tool`, `research-evidence`, `report` |
| Confirmation and final artifact | `research-final`, `commitment`, `confirmation-proposal`, `confirmation-intent`, `confirmation-vote`, published epoch data |
| Chain operations and budgets | `transaction`, transaction errors, credit/reservation/balance and reconciliation records |
| Investment preview | `investment-preview` stores validated input, evaluation time and DONE/REJECTED outcome for the CLI |
| Confirmed tracked portfolios and stable plans | `portfolio-capture`, `portfolio-observation`, `portfolio-snapshot`, `stable-wallet-plan` (read-only, unsigned reference plans) |
| Signed stable allocation consumption | `stable-qsp-consumption` binds QSP/certificate, qualification and generated wallet plan or refusal |
| Investment reference risk | `investment-risk-cycle`, `investment-risk-order` (reference reservations, not executed trades) |
| Round accounting | `performance-input`, `performance-round`, `performance-agent`, `performance-investment` |

Agent context retains the supplied prompt, input, tool definitions, output schema, final-output mode and runtime limits. The mode participates in the task fingerprint; changing it rejects cached results and in-progress contexts under the same task identity. `llm-input` retains the actual dispatched request payload separately from provider credentials; corresponding call records retain outcomes. Tool calls persist RUNNING before dispatch and then DONE, FAILED or ABORTED; pre-dispatch cancellation and call-budget refusal persist without dispatch. Success and the cached observation commit together. Tool failures retain bounded reason codes rather than raw provider error strings. Replays reuse completed observations; RUNNING is treated as uncertain and never blindly reissued under the same identity. Existing bounded research retries may create a fresh attempt; transport failures do not penalize the Worker. Historical success-only tool caches remain readable without inventing missing dispatch timestamps. Stored structured analysis is the explanation artifact; no hidden model reasoning is requested or required.

## State and history

`records` remains the current-state projection. `record_history` adds an ordered local sequence, entity kind/ID, operation, data snapshot and database recording time. SQLite triggers capture inserts, changed updates and deletions, including direct SQL mutations. Unchanged writes do not add transitions. History writes and business writes commit or roll back together. Update/delete triggers reject ordinary mutation of history. This is not tamper-proof against a database administrator who can alter schema or files.

Existing databases receive one migration-time `BASELINE` per current record. Earlier overwritten states cannot be reconstructed. Recording time is not a blockchain timestamp or proof of observation time. Cross-record relationships remain the business IDs stored in each payload; the local history sequence is not a QSP block number.

Backups must include the complete SQLite database, including history, using the existing consistent backup procedure. History retains encrypted wallet versions as well as other historical records: wallet-key rotation does not erase prior ciphertext. Access to the database and backups remains privileged. Do not persist plaintext private keys, API credentials or authenticated headers. Research request bodies and fetched content may contain sensitive contextual data and must not be exposed via unrestricted public APIs.

## Remaining integration work

This requirement is broader than the current coverage. The standalone wallet-preview CLI now commits its validated input and result/rejection. Direct calculator calls and QSP-to-wallet adaptation still need integration into the investment orchestrator; the CLI journal is not that orchestrator. Invalid input schemas are rejected before archival, rather than storing arbitrary untrusted fields as protocol data. Pre-dispatch provider refusal is not yet a complete request-attempt record. Historical hash-only contexts are not backfilled with invented content.

The [tracked portfolio collector and stable reference planner](stable-wallet-plans.md) now persist confirmed-block data and unsigned plans. The [confirmed stable-QSP consumer](confirmed-stable-qsp.md) now binds a separate signed stable allocation to registered-Worker reference plans. Automatic orchestration, complete registry/reservation integration, executable per-wallet decisions, DEX quotes, order dispatch, receipts, reconciliation and confirmed valuation/flow attribution must persist before those workflows can be accepted. They are not enabled by the reference risk guard. Current automatic round accounting explicitly records missing data rather than fabricated profit or zero returns. See [investment risk](investment-risk.md) and [performance accounting](performance-ledger.md).

Acceptance for each subsequent workflow must demonstrate: durable inputs and outputs, persisted failure/interruption state, restart recovery without duplicate side effects, atomic updates, ownership-aware queries, and links from each result back to its round and source records. Terminal logs and temporary JSON files alone do not meet this requirement.

## Durable research tasks and penalty recovery

`research-task` freezes the execute key, explicit epoch/view ownership, context hash, workers, retry bound and deadline at first dispatch. Attempts retain their original journal IDs and add task ownership, attempt index and wall-clock start/completion timestamps. Successful attempt and task completion, and final failed attempt and task exhaustion, commit in the same Store transaction. Restart reuses the frozen bound and rejects changed context; a stopped resumable call keeps its journal identity until ownership becomes irreversible.

Operational strikes are projected from terminal tasks and existing attempts, without a separate strike ledger. A DONE sibling suppresses the entire task; each actual invalid-output author contributes at most once per failed task. Quarantine records retain applied event IDs, projection policy/digest and recovered release watermarks, making repeated observation idempotent. Legacy closed groups are derived read-only from anchored attempt IDs, epoch/view and terminal evidence. Original attempts, incidents and append-only history remain available; baseline history timestamps are never treated as failure times. Missing or ambiguous provenance is reported as unresolved and cannot justify a new strike or an unsafe early release.
