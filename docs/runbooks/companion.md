# macOS companion

The companion adds `list_roots`, `stage_file` and `save_attachment` to a local stdio MCP client. It requires Node 22.18+, macOS 26.6+, Xcode command-line tools, and local APFS/HFS roots. V1 refuses overwrites and missing destination subdirectories.

## Build and configure

From the repository root:

```bash
npm ci
npm run verify
npm run verify:native
```

Register the companion on the deployed Worker's Accounts page after a recent owner login. Copy its client ID, then configure the local helper:

```bash
node companion/src/cli.ts init \
  --origin https://YOUR-WORKER-HOST \
  --client-id YOUR-COMPANION-CLIENT-ID \
  --read-root documents=/absolute/path/to/documents
node companion/src/cli.ts login
```

`init` creates the default writable root at `~/Downloads/Gmail MCP`. Pass `--write-root /absolute/path` to choose another directory. Read roots are optional. Roots must not overlap each other or the private configuration/state directories. Initialization refuses to replace existing configuration.

Login binds an ephemeral `127.0.0.1` listener before opening the browser. It validates PKCE state and the exact Worker issuer, then stores the staging credential in Keychain. The installed provider serves revocation at `/token`, as advertised in discovery.

Configure the MCP client to run an absolute Node executable with an absolute path to `companion/src/cli.ts` and the argument `serve`. The process writes MCP messages to stdout and diagnostics to stderr. It does not need credential environment variables.

## Tools

```json
{
  "account": "work",
  "root": "documents",
  "path": "report.pdf",
  "mime": "application/pdf",
  "idempotency_key": "report-revision-1"
}
```

Call `stage_file` with these arguments. If it returns an approval URL, approve in the Worker and repeat the same arguments. The repeated request uses the original snapshot even if the live file changed. A new explicit key requests a new snapshot. Completed transfers return their original handle; an expired handle requires a new explicit key and intent.

```json
{ "handle": "sh_REPLACE_WITH_RETURNED_HANDLE", "root": "attachments", "path": "report.pdf" }
```

Call `save_attachment` with a real download handle. The parent directory must exist. The helper verifies size and SHA-256, writes and synchronizes a temporary file, publishes with an exclusive rename and records the receipt. Existing files remain untouched.

A response with `state: published` and `acknowledged: false` means the local save succeeded but remote ACK is unconfirmed. Repeat the same save to recover the receipt and retry ACK. A `publication_unknown` result requires owner inspection; do not delete or replace the destination to force a retry.

```bash
node companion/src/cli.ts logout
```

Logout invalidates local credential use before attempting remote revocation. It reports whether the remote endpoint confirmed revocation.

## Recovery and capacity

The helper uses owner-only configuration at `~/.config/gmail-mcp/config.json` and state at `~/Library/Application Support/gmail-mcp/`. Keep these outside attachment roots. Do not unlink the lock file or edit the live SQLite database while a helper is running.

The helper reserves four snapshots/100 MiB, one temporary save/25 MiB, and at most 1,000 metadata records/16 MiB. Startup cleanup removes expired snapshots under the process lock. Recovery retains uncertain publication evidence and capacity charges. Back up the private state before manual investigation; removing the journal can destroy idempotency protection.

The Worker reserves 250 MiB per owner and 500 MiB globally, one upload/materialization slot, and bounded download and recovery-record capacity. Admission authority lasts fifteen minutes. An upload admitted before that deadline may finish within its own five-minute lease. Unknown R2 writes retain their charge after lease expiry. Before releasing such debt manually, quiesce relevant writers and verify deletion. Neither a successful delete nor an elapsed lifecycle TTL proves a delayed writer stopped.

Interrupted client registration uses a persisted attempt marker and a two-minute lease. The Accounts action reconciles a single matching provider client after lease expiry. An empty or ambiguous listing remains quarantined and must not trigger another creation. Legacy `pending` sentinels need owner investigation because they contain no reliable attempt marker. Marked, unfinalized clients cannot receive MCP scope.

## Verification boundary

`npm run verify` runs formatting, type-aware lint, TypeScript checks and shared/Worker/companion tests. The Worker suite uses workerd and a synthetic Google service. A combined test drives the companion orchestration through real Worker OAuth/staging routes with a fake native port. The stdio tests exercise the SDK transport and launch the CLI directly in Node. The 25 MiB upload test checks stored size and digest.

`npm run verify:native` runs real local filesystem/SQLite tests and builds the helper. Credential tests use an isolated store, so they do not write personal Keychain items.

Before release, verify actual Keychain login/logout, installed Claude Code/Desktop approval flows, the target deployment and power-loss behavior on the intended volume. This implementation run did not deploy, send mail or claim those checks passed. The default Linux CI job covers TypeScript; native checks require a supported Mac.
