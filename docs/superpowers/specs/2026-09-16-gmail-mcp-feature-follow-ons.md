# Gmail MCP feature follow-on design package

These proposals account for the deferred feature register. Each needs a separate implementation plan and review. They do not change V1 limits, release requirements or authorization. Status: design drafts; none of these expansions has implementation acceptance.

## P6-PHASE-B: upload continuation

Keep `phase_b_verified=false`. Before adding another MIME writer, obtain provider evidence showing that the specific preceding response authorizes continuation of that exact session and byte range. Bind that evidence to the method, URI identity, declared length, committed offset and operation. An ambiguous receipt, expired session or inconclusive range response cannot authorize another writer.

Retain an immutable encrypted MIME manifest and fixed chunks. Bind authenticated additional data to owner, account, operation, generation, chunk index, plaintext length and manifest digest. Pin input handles and their digests before materialization; reject a changed input rather than regenerating different MIME under the same operation. Keep session secrets encrypted and outside evidence files. Count ciphertext, tags, manifest and uncertain producer debt against storage quotas.

Permit one retained MIME per owner, one global materializer/writer, at most three admissions and a 24-hour retention horizon. A transaction must bind writer ownership and generation before byte admission. A lease timeout alone does not prove that an old producer has stopped. Cleanup must retain quota debt until producer termination and object deletion are established; test DELETE followed by late PUT.

Required review evidence: provider continuation semantics, source-pinning and AAD tampering tests, concurrent admission races, partial chunk publication, lost final receipt, stale producer after lease expiry, expiry during upload, quota boundaries and cleanup after restart. Live schedules must establish no duplicate send or false confirmation. An unresolved provider guarantee blocks continuation implementation.

## P4-OVERWRITE: approved native replacement

Request approval for an exact destination identity, including configured root, descriptor-rooted relative path, device/inode and current digest. Approval must expire and must not transfer to a renamed or replaced file. Show the existing filename and replacement size to the user through the native authority boundary.

Prepare replacement bytes in the same supported filesystem, verify their digest, sync them, and journal the approved old identity before publication. Choose and document a platform replacement primitive only after testing its crash semantics. Retain the old version or a recoverable journal until directory synchronization and durable receipt publication establish the promised state. Do not acknowledge an uncertain replacement.

Acceptance requires concurrent destination replacement, symlink/parent swaps, hardlinks, private-root overlap, capacity and fsync failures, helper termination at each journal boundary and separate physical durability trials. State the recoverable old/new outcome for each interruption. The existing no-overwrite behavior remains until this review passes.

## P6-BATCH: label, trash and spam batches

Define bounded arrays with per-item message/thread identity and an explicit maximum chosen from measured request costs. Apply the server-side `+bulk` modifier in addition to each action's existing policy and modifiers. Freeze account, normalized unique items and requested changes in the intent hash. Approval for one item cannot authorize a later batch.

Record one parent operation and attributable per-item outcomes. Distinguish never-admitted items from ambiguous provider results. A retry may reconcile ambiguous items but must not blindly repeat them or silently shrink the approved set. Document cancellation and partial completion in the tool result without exposing provider bodies.

Acceptance covers duplicate input, mixed foreign IDs, revoked grants, policy changes before admission, partial provider failure, response loss and a retry with changed item order/content. Verify per-item audits, exact byte/count quotas and no cross-owner access.

## P6-ALL-ACCOUNTS: bounded search fan-out

Resolve the owner's authorized account set at the start of a search. Apply each account's current grant and read policy independently. Bound total concurrent requests, result count, response bytes and elapsed time across the fan-out. Define explicit partial results with account-scoped errors; a failed account must not disappear as if it returned no matches.

Use an opaque, authenticated cursor binding owner, query digest, account set, per-account pagination positions, sort policy and expiry. Revalidate account grants on each page. Do not place OAuth tokens or raw provider page tokens in model-visible cursors. A revoked account must contribute no new results after its revocation is observed.

Acceptance covers account additions/removals between pages, repeated provider items, grant rotation, timeouts, tampered cursors and cursor reuse by another owner. Verify stable ordering and bounded aggregate work.

## P6-LOCAL-PROXY: full local tool surface

Keep Worker policy authoritative. The companion may translate an approved local path into a staged handle through the native helper; it cannot lower modifiers or replace remote approval. Define tool-by-tool argument/result parity and maintain one remote identity and idempotency chain through staging, approval and execution.

All filesystem paths must pass configured-root and descriptor checks. Keep bytes, local absolute paths, signed transport URLs and credentials out of retained model projections. The proxy must reject unknown tools and path-bearing fields rather than forwarding arbitrary objects to native commands.

Acceptance covers remote allow/ask/deny parity, lost continuation state, restart between staging and send, symlink/rename races, hostile filenames, root changes and cross-account handles. Confirm that adding the proxy does not create a second mutation authority or a general local filesystem interface.

## P6-MULTI-USER: tenant onboarding

Replace the static owner allowlist only after defining signup eligibility, consent, abuse controls and tenant lifecycle. Carry tenant identity from authenticated principal through database keys, staged objects, OAuth grants, policy, operations and audit records. Do not infer ownership from an email address or a caller-supplied account ID.

Apply tenant-scoped quotas and rate limits before resource allocation. Define logout, account unlink, tenant deletion and retention behavior for active operations and cleanup debt. Administrative support access requires a separate authorization and audit design.

Acceptance includes cross-tenant identifier substitution on every route, compound foreign-key constraints, account linking races, signup replay, quota exhaustion, revocation during a request and deletion with an uncertain producer. Broader signup remains disabled until isolation and provider-distribution requirements pass.

## P6-GOOGLE-VERIFICATION: applicability and evidence

Inventory the exact deployed OAuth scopes, user population, distribution model and data handling. At review time, check current official Google requirements and retain the source/date supporting each applicability decision. This draft makes no exemption or CASA determination.

Prepare a package with consent-screen configuration, verified domains, privacy and deletion behavior, scope-by-feature justification, demonstration steps and required security assessment evidence. Keep credentials and mailbox contents out of public submissions and repository records. Assign responsibility for renewals and changes in scope or distribution.

Acceptance is the applicable completed verification/assessment or a documented, source-supported exemption for the actual distribution. A locally working OAuth flow is not verification evidence.

## P6-LARGE-DOWNLOAD: streaming extraction above 25 MiB

Keep the current 26,214,400-byte ceiling until a streaming design passes. Define a bounded base64url decoder with carry across chunks, strict alphabet/padding handling and counted decoded bytes. Parsing a provider JSON envelope must also remain bounded; buffering its complete encoded attachment would defeat the memory requirement.

Bind the download to owner/account/message/part and the observed source digest or immutable provider identity. Reserve quota before admitting bytes, maintain backpressure to the native writer, and preserve cleanup debt after interruption. Set an explicit new ceiling from provider limits and measured isolate/native behavior rather than removing the existing cap.

Acceptance includes every decoder boundary, malformed/truncated input, excess decoded bytes, two concurrent streams, slow consumer, cancellation, grant rotation, file growth/replacement and ACK loss. Record exact output digests and attributable peak-memory measurements. Missing peak-isolate coverage keeps this expansion unqualified.

## P6-AUDIT-HEADER: retired

Do not emit `X-Claude-Audit-Id` in sent mail. Keep internal audit correlation inside the authorized service boundary. Any proposal to reopen this item needs a separate privacy review explaining why recipients should receive internal metadata. The coverage ledger retains the retired item so it cannot disappear from scope accounting.
