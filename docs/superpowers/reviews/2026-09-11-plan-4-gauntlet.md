# Plan 4 Simurgh gauntlet

Reviewed 2026-09-11 against commit `11b1fd9` and the untracked Plan 4 draft. Scope: design review, source inspection, current primary documentation, a fresh repository verification run and isolated filesystem probes. No Gmail requests, deployments or production-code changes.

## Verdict

Continue design; do not start implementation from this document yet. The draft had the right scope, but several sentences delegated security decisions to the future implementer. The revised draft gives those decisions explicit invariants and acceptance families. Filesystem primitives, transfer recovery details and resource budgets still need an implementable design.

This review does not classify the missing companion as vulnerable code. It distinguishes integration hazards, existing behaviour and unproven requirements. The existing test gate passes; it cannot prove code that does not exist.

## Findings and disposition

Priorities refer to what must be resolved before implementing or shipping Plan 4. P1 means a core authority, integrity or recovery guarantee depends on the decision. P2 means a required contract or operational control needs definition.

| ID  | Priority | Evidence and failure                                                                                                                                                                                                                                                                           | Change to the draft                                                                                                                                                                                                   |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | P1       | `worker/src/tools/gate.ts:491` claims before executor lookup at line 512. `claimPending` does not restrict the action. A staging pending row sent to generic MCP execution could lose its approval before dispatch fails. No upload route currently exists, so this is an integration hazard.  | Require action/tool/version checks before claim in both directions. Recheck account and current policy at issuance and upload admission, with an explicit timing boundary.                                            |
| G2  | P1       | `worker/src/cron.ts:57` promotes stale executing operations without filtering their action. `staging/store.ts:93` writes R2 before D1; catch cleanup cannot cover termination. The original draft did not select upload states or define which result survives a lost response.                | Define ticket states, one admission claim, persisted transfer IDs, status recovery, completion fencing and a D1 settlement batch. Separate upload recovery from send recovery.                                        |
| G3  | P1       | The local probe followed a parent symlink despite `O_NOFOLLOW`; `rename` replaced an existing destination. The draft already named TOCTOU, but had no mechanism supporting its save promise.                                                                                                   | Make filesystem algorithm verification a gate. State that exclusive hard-link publication only demonstrates no-clobber behaviour, not full confinement. Require deterministic parent replacement and overwrite tests. |
| G4  | P1       | `worker/src/staging/store.ts:161` ACKs only an unconsumed row. `worker/test/staging.test.ts:103` expects a second ACK to return false; `staging/routes.ts:22` turns it into 404. A status message cannot recover a lost tool response after restart.                                           | Add durable local save receipts and restart recovery. Separate file publication from remote cleanup. Define tombstone retention or report cleanup as unconfirmed; never treat 404 as proof of consumption.            |
| G5  | P2       | The draft's refresh serialization did not specify its process boundary. Installed OAuth provider 0.10.3 rotates refresh credentials in `handleRefreshTokenGrant`; two client processes can contend. The draft also did not explain how Keychain writes avoid secret-bearing command arguments. | Require cross-process refresh/logout coordination, authority-bound Keychain keys and a verified secret-safe interface. Keep live Keychain validation distinct from fake tests.                                        |
| G6  | P2       | `staging/store.ts:37` allocates the declared body length for each ingest. A 25 MiB cap bounds one request, not concurrent allocations, outstanding tickets, snapshots or stored bytes.                                                                                                         | Add enforceable admission budgets, deadlines, cleanup and concurrent workerd measurements. Numeric values remain an implementation-plan prerequisite.                                                                 |
| G7  | P2       | `shared/src/schemas.ts:37` requires positive upload size; `staging/store.ts:77` accepts zero. The upload path will bypass the MCP gate that supplies normal audit/settlement behaviour.                                                                                                        | Propose empty-file support, canonical metadata and strict MIME/schema validation. Specify intent/outcome audit and terminal payload redaction.                                                                        |
| G8  | P2       | Spec 2.4 gives `stage_file` only account/path, while `UploadIntent` has `pending_id`. The draft required text-link continuation but provided no way for another tool call to select the approved transfer.                                                                                     | Propose an opaque `transfer_id` backed by a private snapshot and persisted state. Resume through staging only. Amend the client workflow rather than adding MCP credentials.                                          |
| G9  | P2       | `worker/src/auth/companion.ts:28` reserves a persistent `pending` setting. A crash can bypass catch cleanup; later requests only wait and throw at line 37. A crash after provider client creation can also lose the generated ID.                                                             | Add registration reconciliation or an owner-authenticated repair path that accounts for orphan clients. This is an existing onboarding defect; this review did not reproduce a process kill.                          |
| G10 | P2       | The root-folder question treated file reading and file creation as the same grant. A write root that includes configuration or executable project paths can allow consequential file creation without overwriting anything. MCP root discovery is not permission enforcement.                  | Propose separate read/write grants, keep config and spool outside writable roots, and prohibit client-driven grant expansion. The owner has not accepted new root defaults.                                           |

Independent review produced six findings. All six were adopted or incorporated into G1, G4, G7, G8 and G9; none were rejected. The parent review checked the cited source before changing the draft. Five tempting false positives were excluded: scope/audience checks already exist; upload bytes are not available through download GET; the client-ID discrepancy was already acknowledged; the draft already mentions TOCTOU; and a brainstorming draft need not contain implementation code.

## Fresh evidence

`npm run verify` exited 0 on 2026-09-11. Formatting, linting and typechecking passed. Shared: 1 test file, 7 tests passed. Worker: 34 test files, 243 tests passed. Total: 250 tests, zero failures. These are local tests of the current repository. They do not establish real Gmail, live Keychain, browser-login or Claude-client behaviour.

On this Mac, Node v26.8.2 produced:

```text
O_NOFOLLOW with intermediate symlink: outside fixture
rename over existing destination: replacement
exclusive link over existing destination: EEXIST
```

The probe used synthetic files inside one temporary directory and removed that directory afterward. Reproduce with:

```bash
node --input-type=module <<'JS'
import * as fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmail-plan4-probe-'));
try {
  await fs.mkdir(path.join(dir, 'root'));
  await fs.mkdir(path.join(dir, 'outside'));
  await fs.writeFile(path.join(dir, 'outside', 'fixture'), 'outside fixture');
  await fs.symlink(path.join(dir, 'outside'), path.join(dir, 'root', 'hop'));
  const f = await fs.open(path.join(dir, 'root', 'hop', 'fixture'), C.O_RDONLY | C.O_NOFOLLOW);
  console.log('O_NOFOLLOW with intermediate symlink:', await f.readFile('utf8'));
  await f.close();
  const dest = path.join(dir, 'root', 'dest');
  const tmp = path.join(dir, 'root', 'temp');
  await fs.writeFile(dest, 'original');
  await fs.writeFile(tmp, 'replacement');
  await fs.rename(tmp, dest);
  console.log('rename over existing destination:', await fs.readFile(dest, 'utf8'));
  await fs.writeFile(tmp, 'second replacement');
  try { await fs.link(tmp, dest); console.log('exclusive link: unexpectedly succeeded'); }
  catch (e) { console.log('exclusive link over existing destination:', e.code); }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
JS
```

This tests filesystem primitives, not a companion implementation. It does not prove that a future combination of checks prevents all races. Node's documented rename behaviour also permits replacement. [Node filesystem documentation](https://nodejs.org/api/fs.html#fsrenameoldpath-newpath-callback).

## External checks: four fronts

Standards: native OAuth clients use PKCE and a loopback listener with an ephemeral port. The proposed IPv4 literal callback follows that pattern; implementation must validate callback state and shut down the listener. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html).

Incidents: the reference MCP filesystem server published a symlink-validation advisory. That is evidence for including adversarial path tests, not evidence that this unfinished companion has the same vulnerability. [GHSA-q66q-fx2p-7w4m](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-q66q-fx2p-7w4m).

Prior art: the reference filesystem server allows client roots to replace configured directories. That is a deliberate feature there. This project must not copy it because its own authority model treats the client as untrusted for grants. [Reference server access control](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md#directory-access-control).

User surface: Claude's current connector documentation says Gmail attachment content is unavailable through that connector. The local companion addresses a documented workflow gap. This check does not establish market novelty or validate the historical 29-tool parity inventory. [Google Workspace connector limitations](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors).

## Simurgh ambition pass

The immediate user is Raouf, who needs mailbox attachments on disk and local files available for later sends. The blocker is the missing companion/upload path. This is integration work with stronger permission and recovery contracts, not a claim to a new category of software.

All twelve invention generators were considered:

| Generator                  | Result for this plan                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| G1, unpublished number     | Report the tested failure checkpoints and untested boundaries; avoid a synthetic security percentage.                              |
| G2, real incident          | Use the published symlink advisory to motivate path-adversary fixtures.                                                            |
| G3, incumbent limitation   | Attachment content is the documented connector gap; no claim of global novelty.                                                    |
| G4, honest consistency     | Approved metadata hash, snapshot hash and uploaded bytes must agree.                                                               |
| G5, adversarial complaint  | A mismatched transfer-ID replay must expose a conflict without writing new bytes.                                                  |
| G6, adversary choices      | A transfer either recovers its recorded status, fails its binding checks, or starts through a new intent; no silent second ticket. |
| G7, auditable absence      | Record missing completion or ACK evidence as unknown rather than successful.                                                       |
| G8, missing voice          | Show the owner the snapshot being approved and the exact replacement target.                                                       |
| G9, clock boundary         | Separate ticket admission expiry, upload lease, approval expiry and receipt retention.                                             |
| G10, unnecessary privilege | Keep companion authentication staging-only and Gmail credentials server-side.                                                      |
| G11, adversarial user      | Add same-owner cross-action approval attempts, root expansion and concurrent claims.                                               |
| G12, prose as protocol     | Turn retry promises into explicit states, receipts and reproducible crash fixtures.                                                |

The strongest useful improvement is recovery evidence for both upload and save. A local receipt is not independently trustworthy under host compromise. It supports bounded retry behaviour, not a claim of distributed exactly-once execution.

## Scorecard

These are reviewer judgments about the draft, not measured security scores. A high score requires executable evidence as well as prose.

| Axis                     | Initial | Revised | What moves it higher                                                                     |
| ------------------------ | ------- | ------- | ---------------------------------------------------------------------------------------- |
| Scope and user value     | 8/10    | 8/10    | Owner-reviewed root grants and a runnable setup example.                                 |
| Authority contract       | 6/10    | 7/10    | Passing bidirectional action-confusion and policy-race tests.                            |
| Filesystem guarantees    | 3/10    | 4/10    | A selected algorithm with parent-replacement and overwrite-race evidence.                |
| Transfer recovery        | 4/10    | 6/10    | Complete transition table and crash tests across persistence/publication/ACK boundaries. |
| Implementation readiness | 3/10    | 5/10    | Approved design, exact schema/budgets and test-first tasks for a new engineer.           |

No new feature backlog was added beyond controls needed for Plan 4's promises. Plan 5 retains its existing protected Gmail and reconciliation work. The remaining Plan 4 gates are design dependencies, not deferred guarantees disguised as completed work.
