# Security Policy

This project mediates access to a mailbox. Constraining what an AI model can do there is the whole
point of it, so a security report outranks everything else in the queue.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report privately through
[GitHub Security Advisories](https://github.com/Raoof128/gmail-mcp/security/advisories/new), which
creates a private thread with the maintainer.

Useful things to include, to whatever extent you have them:

- What an attacker gains, and what access they need to start.
- The smallest reproduction you can manage.
- Which component is involved: the Worker, the schema, the policy engine, the approval flow, or the
  local companion.

You can expect an acknowledgement within a few days and an assessment of severity and a fix plan after
that. This is a personal project rather than a funded programme, so please read those as good-faith
intentions rather than a contractual SLA. Credit is given in the advisory unless you would rather not be
named.

## Supported versions

The project is pre-release and under active development. Only `main` is supported. There are no tagged
releases yet, and no backports.

## Threat model

The security model rests on one sentence: **the authenticated server-side policy engine is the authority.**
Neither the model, nor the MCP client, nor the tool annotations are trusted to enforce anything.

### In scope

The design is built to withstand these. A report showing any of them succeeding is a vulnerability.

| Threat                                                     | The control that should stop it                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in email content driving a mailbox write  | Every mutation resolves through the policy engine; `ask` requires an out-of-band human approval. An owner who chose `allow` (or "Allow everything") has traded that check away for those actions: `deny`, no permanent delete, the audit log and the size and recipient caps still hold |
| A model fabricating or relaying an approval                | Approval is bound to a browser session or MCP URL-mode elicitation. A code relayed through the model is never accepted                                                                                                                                                                  |
| Substituting a different attachment after approval         | Reserved handles are read out of the approved, hashed payload, never from a caller argument                                                                                                                                                                                             |
| Replaying an approved action                               | The claim is a single atomic transition; a second attempt finds nothing to claim                                                                                                                                                                                                        |
| Duplicate sends after a crash or timeout                   | Every external side effect is journaled; ambiguous outcomes become `delivery_unknown` and are never auto-retried                                                                                                                                                                        |
| Reaching another account's data                            | Ownership is enforced by composite foreign keys in the schema, not by remembering to filter                                                                                                                                                                                             |
| A stolen approval URL                                      | The approval page requires a session whose identity matches the pending action's owner                                                                                                                                                                                                  |
| A stolen bearer token used on the wrong surface            | Tokens are scoped: an `mcp` token cannot reach staging routes, and a `staging` token cannot reach the MCP endpoint                                                                                                                                                                      |
| Path traversal or symlink escape when saving a file        | The companion uses logical roots, validates relative components and refuses traversal and symlink escape                                                                                                                                                                                |
| A hostile filename hiding its extension                    | Filenames are normalised, control and bidirectional-override characters are replaced, and truncation is UTF-8 safe                                                                                                                                                                      |
| Header injection through a subject or recipient            | Carriage return, line feed and NUL are refused in every header value                                                                                                                                                                                                                    |
| Permanent, unrecoverable deletion                          | No tool exposes it, and the requested Google scope cannot perform it                                                                                                                                                                                                                    |
| A silently mistyped tool argument changing what is sent    | Every tool input schema is strict, so an unrecognised key is refused rather than dropped                                                                                                                                                                                                |
| A recovery settling against a grant that has been replaced | A recovery records the `credential_version` it was admitted under, and settlement requires the account still to match it                                                                                                                                                                |

### Out of scope

These are real risks this project does not claim to defend against, listed so the boundary is written down
rather than assumed.

- A compromised operating system or browser session on the owner's own machine.
- A compromised Google account, or Google-side compromise.
- A compromised Cloudflare account, or the deployment's root secrets.
- Google or Cloudflare infrastructure compromise.

## Honest limitations

A security document that lists only strengths is marketing, so here is the other half.

The server-side policy engine is the only enforcement layer. Client-side tool annotations are hints and
the design does not rely on them. If the engine has a bug, nothing else catches it.

Approval defeats writes started by the model or by an injected instruction. It does nothing against
someone who already controls the owner's browser session.

Attachment type checking works on the filename, and applies to outbound uploads. Archives are not
inspected. Gmail's own scanner is the authoritative check, and its rejection reaches the caller.

The project is pre-release. Local verification covers synthetic OAuth and Gmail traffic and native
filesystem recovery, and a deployed Worker has since completed the whole chain against a real mailbox.
That run is worth what it is and no more: it demonstrates that the controls behave against real Google
infrastructure, and it establishes nothing about power-loss durability on every volume, peak isolate
memory, or the external gates below.

Five guarantees sit outside this repository and are recorded as `not_run`.

| Guarantee                            | Refusal path     | Why it is open                                                 |
| ------------------------------------ | ---------------- | -------------------------------------------------------------- |
| Authoritative writer quiescence      | tested           | feasibility decision, `quiescence_unavailable`                 |
| Cross-host deployment exclusion      | tested           | same decision, `deployment_exclusion_unavailable`              |
| Restore execution and reconciliation | tested           | no restore controller exists, so no request can be issued      |
| Provider commit barrier              | **none emitted** | the provider does not expose whether a lost response committed |
| Peak isolate memory                  | **none emitted** | nothing measures, refuses or records peak memory at all        |

Quiescence and exclusion are one feasibility decision refused two ways, so three open feasibility decisions
account for four of these guarantees; restore is the fifth and is a missing controller rather than an
unresolved feasibility question. None may be closed with an operator boolean, an elapsed timeout, a
successful request, Node RSS or a mocked receipt. Release authority is unreachable while they stand, and the
served build identity is `unqualified`.

A tested refusal proves the system declines to proceed without the evidence. It does not produce the
evidence. Two of these gates do not even have that. `measurement_unavailable` and
`provider_barrier_unavailable` are both members of the `Reason` enum that nothing returns, so those two
gates are enforced by the absence of any code that measures, refuses or records, rather than by a refusal
anyone can test. A declared enum member is not an implemented refusal.

What holds instead for peak memory sits one step further out. `resources` is a mandatory member of the
release aggregate, and a missing component makes a pass arithmetically unreachable. Both facts are true and
neither substitutes for the other: the measurement is unavailable, and its absence still blocks
qualification.

The guarantees this project _does_ make, each with its implementation site and proof type, are in
[docs/INVARIANTS.md](docs/INVARIANTS.md). Two of them hold only by construction, and that document says
which.

The companion uses macOS descriptor-relative operations and exclusive publication. It refuses overwrites, network volumes, hard-linked sources, and private-state overlap. This confines tool-selected paths under owner-configured roots; it is not a sandbox against an arbitrary process running as the same macOS user.

An unknown R2 writer retains its storage charge after lease expiry, and a local publication with
uncertain identity retains its receipt and save reservation. Both are deliberate: a charge is released
only on proof, never on a timer or on an absent object. The cost is that these states can exhaust
capacity until the owner acts, and deleting their evidence by hand to free capacity is the one action
that turns recoverable debt into a permanent charge.

On the local side there is now a way out that does not require deleting evidence.
`gmail-mcp-companion debt` lists every charged receipt with the remedy that fits it, and
`debt --scope SCOPE --release HANDLE` clears a charge in exactly one state: a `publication_unknown`
receipt whose temporary is provably absent, where ENOENT is the only outcome that counts as proof. A
release repairs accounting and nothing else, so the receipt still reads `publication_unknown` afterwards.
One reachable state has no remedy: a receipt whose temporary exists but no longer matches the device and
inode recorded at creation is refused by both the collector and the release, and its charge stands until
the owner investigates. That is recorded rather than patched, because widening release authority is a
change to a permission boundary.

## Handling secrets

- `worker/.dev.vars` is gitignored and must never be committed. `worker/.dev.vars.example` holds
  throwaway placeholders.
- Google refresh tokens are encrypted with AES-256-GCM under a rotatable keyring. The additional
  authenticated data binds each ciphertext to its owner, account and field, so a ciphertext copied into
  another row fails to decrypt.
- Tokens never appear in tool results, audit rows or logs. The audit log records counts and identifiers,
  and the module renders its own summaries, so a caller cannot push message content through it.

Companion OAuth credentials use Security.framework directly, with a permanent cross-process lock and a persisted logout epoch. Credentials do not enter process arguments or environment variables. The companion disables HTTP redirects for token and staging requests.
