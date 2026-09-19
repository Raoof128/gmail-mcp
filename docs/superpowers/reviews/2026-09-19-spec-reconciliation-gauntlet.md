# Second gauntlet: the reconciled architecture document

The first gauntlet, recorded in `2026-09-17-full-project-gauntlet.md`, audited the implementation.
This one audits the document that now claims to describe it. Append to this file; never rewrite it.

## Baseline

| Item                    | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Commit                  | `5deefc7`                                                                    |
| Branch                  | `plan7-repair`                                                               |
| Spec revision line      | "Date: 2026-09-09. Current architecture revision: 2026-09-19."               |
| `npm run verify`        | exit 0                                                                       |
| `npm run verify:native` | exit 0, 26 native tests                                                      |
| Sections just rewritten | 4.7 in `5deefc7`, 4.8 in `8cbfdae`; this pass sweeps the ones nobody touched |

A probe here is a read: running the suite, reading source, `sqlite3` against a local journal, a
public endpoint fetch, or `wrangler tail` observing traffic the owner generated. No probe in this
pass sent mail, deployed, revoked, restored, ran a destructive native test, or produced
target-specific qualification evidence. Where a claim needs one of those, it is `not_verified` with
the reason.

## Method

Every claim was classified with its expected terminal state written down before the check ran, as
the first gauntlet did for its external gates. Eleven claims were swept, all eleven predicted to
hold. Eight did. The three that did not are the reason the pass was worth running, and predicting
them first is what makes them findings rather than observations.

## Sweep

| #   | Claim                                                                                        | Section | Predicted | Actual         | Anchor                                           |
| --- | -------------------------------------------------------------------------------------------- | ------- | --------- | -------------- | ------------------------------------------------ |
| G1  | `download_attachment` is `readOnlyHint: false, destructiveHint: false, openWorldHint: false` | 2.5     | holds     | holds          | `worker/src/tools/read.ts:221`                   |
| G2  | the `destructiveHint: true` set is `trash_*`, `unlabel_*`, `mark_*_spam`, `delete_label`     | 2.5     | holds     | **incomplete** | `worker/src/tools/labels.ts:137,176-452,313,347` |
| G3  | neither `requiresUserInteraction` nor `maxResultSizeChars` appears in the source             | 2.5     | holds     | holds          | no match in `worker/` or `shared/`               |
| G4  | body plus html body capped at 512 KB combined                                                | 2.7     | holds     | holds          | `policy/limits.ts:5` `bodyBytes: 512 * 1024`     |
| G5  | inline attachments 1 MB decoded total                                                        | 2.7     | holds     | holds          | `policy/limits.ts:6`                             |
| G6  | canonical payload JSON capped at 1 MB                                                        | 2.7     | holds     | holds          | `policy/limits.ts:8`                             |
| G7  | about 50 blocked extensions, including the fifteen named                                     | 2.7     | holds     | holds          | `policy/limits.ts:16`, 53 entries, all present   |
| G8  | addresses are parsed with a real RFC 5322 address parser                                     | 2.8     | holds     | **wrong**      | `policy/recipients.ts:9-15`                      |
| G9  | Gmail `+tag` suffixes are stripped for comparison; dots are not normalised                   | 2.8     | holds     | **partial**    | `policy/recipients.ts:53-56`                     |
| G10 | `user_id` is the `sub` from the Worker's own token and never a tool argument                 | 3.1     | holds     | holds          | `auth/principal.ts:36-39`                        |
| G11 | 38 remote tools                                                                              | 2.3     | holds     | holds          | live `tools/list` on 2026-09-19 returned 38      |

## Findings

### F1. Section 2.8 claims a real RFC 5322 parser and the code is deliberately not one. Stop-ship.

The section opens: "Addresses are parsed with a real RFC 5322 address parser." The parser's own
comment says the opposite, and says why:

> Deliberately restricted grammar: no quoted local parts, no comments, no leading, trailing or
> consecutive dots, one address per string. This is a permission boundary, so it prefers false
> negatives.

`LOCAL` and `DOMAIN` are two regular expressions. A quoted local part, a comment, and more than one
address in a string are all refused rather than parsed. The code is right and the document is
wrong: preferring false negatives at a permission boundary is the correct choice, and claiming full
RFC 5322 coverage invites someone to rely on behaviour that does not exist. Classified stop-ship
because it misdescribes a permission boundary rather than a convenience.

### F2. The `+tag` rule is scoped to two domains and the document states it flat. Stop-ship.

The section says "Gmail `+tag` suffixes are stripped for comparison" with no scope. The source:

```ts
const isGmail = domain === "gmail.com" || domain === "googlemail.com";
const local = isGmail ? localRaw.split("+")[0]!.toLowerCase() : localRaw;
```

Two things follow that the document does not say. Tag stripping applies only when the domain is
`gmail.com` or `googlemail.com`, so an allowlist entry for a Workspace or third-party domain is
compared with the tag intact. And the local part is lower-cased only for those same two domains, so
everywhere else the comparison is case-sensitive: an allowlist holding `a@corp.test` does not trust
`A@corp.test`.

The case-sensitivity half is absent from the document entirely, and it is the consequential half,
because it decides whether a send is trusted. The code carries a comment explaining the choice,
which is sound: SMTP treats local parts as potentially case sensitive, so normalising only where
the provider is known to fold is the conservative reading. Also stop-ship: a reader sizing an
allowlist from this section gets it wrong.

The "dots in the local part are not normalised" half of the sentence holds.

### F3. The destructive annotation list in 2.5 is incomplete. Precision.

2.5 names `trash_*`, `unlabel_*`, `mark_*_spam` and `delete_label`. The `trash_*` and `mark_*_spam`
entries hold: both are computed as `destructiveHint: move` and `destructiveHint: mark`, so the
mutating half of each pair carries `true` and the reversing half carries `false`. Three more tools
carry `true` and are not named:

| Tool                            | Annotation set                |
| ------------------------------- | ----------------------------- |
| `update_message_labels`         | `destructive` (labels.ts:137) |
| `apply_sensitive_message_label` | `destructive`                 |
| `apply_sensitive_thread_label`  | `destructive`                 |

The code is right in each case: `update_message_labels` can remove labels, and the two
`apply_sensitive_*` tools apply TRASH or SPAM. The risk is the bullet above them, which puts
`label_*` under `destructiveHint: false`; a reader globbing loosely lands on the wrong answer for
`update_message_labels`. Precision rather than stop-ship, because the annotations are hints and the
policy engine is the authority.

### F4. `stage_file`'s annotation line omits `destructiveHint`. Precision.

2.5 gives `stage_file` as `readOnlyHint: false, openWorldHint: false`. `companion/src/server.ts`
sets `{ readOnlyHint: false, destructiveHint: false, openWorldHint: false }`. The neighbouring
`save_attachment` bullet lists all three. Nothing behaves differently; the line is just short one
field.

## Document against itself

The first reconciliation existed because sections contradicted one another: OAuth state in KV in
one place and D1 in another, a journal heading denied three lines later, two definitions of
`requestState`. This pass looked for the same shape in the sections that reconciliation did not
touch, and found no second definition of any term and no heading contradicted by its own body. F1
through F4 are all document-against-source, not document-against-itself.

One near miss worth recording. 4.7's closing line, in its first draft during this plan's Task 5,
claimed three stale test counts had been deleted from the section. The old section contained none.
Caught before the commit and corrected there; recorded here because a self-audit that only catches
other people's drafts is not auditing.

## Not verified

| Claim                                                               | Why                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Every 1.2 external platform fact                                    | needs the vendor documentation as of today, which is outside a read of this repo |
| The protected-Gmail gates in 4.7, including Message-ID preservation | needs a real send, which is not a probe                                          |
| The five external gates in 4.8                                      | `not_run` by construction; nothing in this pass touches them                     |

## Disposition

All four findings were fixed in the same pass rather than left standing, because each is a document
defect with a source answer already in hand and the point of the reconciliation was to stop the
document drifting from the code.

| Finding | Fix                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------ |
| F1      | 2.8 now states the restricted grammar and why it prefers false negatives                               |
| F2      | 2.8 now scopes local-part normalisation to `gmail.com` and `googlemail.com` and states the consequence |
| F3      | 2.5 now names all ten tools carrying `destructiveHint: true`, and says why three of them do            |
| F4      | 2.5 now gives `stage_file` all three hints                                                             |

No code changed. In every case the code was right and the document was not, which is the outcome a
documentation gauntlet should mostly produce; a pass that keeps finding the code wrong is auditing
the wrong artifact.
