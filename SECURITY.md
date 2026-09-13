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

| Threat                                                    | The control that should stop it                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in email content driving a mailbox write | Every mutation resolves through the policy engine; `ask` requires an out-of-band human approval                        |
| A model fabricating or relaying an approval               | Approval is bound to a browser session or MCP URL-mode elicitation. A code relayed through the model is never accepted |
| Substituting a different attachment after approval        | Reserved handles are read out of the approved, hashed payload, never from a caller argument                            |
| Replaying an approved action                              | The claim is a single atomic transition; a second attempt finds nothing to claim                                       |
| Duplicate sends after a crash or timeout                  | Every external side effect is journaled; ambiguous outcomes become `delivery_unknown` and are never auto-retried       |
| Reaching another account's data                           | Ownership is enforced by composite foreign keys in the schema, not by remembering to filter                            |
| A stolen approval URL                                     | The approval page requires a session whose identity matches the pending action's owner                                 |
| A stolen bearer token used on the wrong surface           | Tokens are scoped: an `mcp` token cannot reach staging routes, and a `staging` token cannot reach the MCP endpoint     |
| Path traversal or symlink escape when saving a file       | The companion uses logical roots, validates relative components and refuses traversal and symlink escape               |
| A hostile filename hiding its extension                   | Filenames are normalised, control and bidirectional-override characters are replaced, and truncation is UTF-8 safe     |
| Header injection through a subject or recipient           | Carriage return, line feed and NUL are refused in every header value                                                   |
| Permanent, unrecoverable deletion                         | No tool exposes it, and the requested Google scope cannot perform it                                                   |

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

The project is pre-release. Local verification covers synthetic OAuth/Gmail traffic and native filesystem recovery. It does not establish deployment readiness, power-loss durability on every volume, or successful login in installed Claude clients.

The companion uses macOS descriptor-relative operations and exclusive publication. It refuses overwrites, network volumes, hard-linked sources, and private-state overlap. This confines tool-selected paths under owner-configured roots; it is not a sandbox against an arbitrary process running as the same macOS user.

An unknown R2 writer retains its storage charge after lease expiry. A local publication with uncertain identity retains its receipt and save reservation. These states can exhaust capacity until the owner investigates; deleting their evidence to restore capacity can invalidate replay and cleanup guarantees.

## Handling secrets

- `worker/.dev.vars` is gitignored and must never be committed. `worker/.dev.vars.example` holds
  throwaway placeholders.
- Google refresh tokens are encrypted with AES-256-GCM under a rotatable keyring. The additional
  authenticated data binds each ciphertext to its owner, account and field, so a ciphertext copied into
  another row fails to decrypt.
- Tokens never appear in tool results, audit rows or logs. The audit log records counts and identifiers,
  and the module renders its own summaries, so a caller cannot push message content through it.

Companion OAuth credentials use Security.framework directly, with a permanent cross-process lock and a persisted logout epoch. Credentials do not enter process arguments or environment variables. The companion disables HTTP redirects for token and staging requests.
