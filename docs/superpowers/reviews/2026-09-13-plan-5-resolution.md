# Plan 5 revision 2: finding resolution

All **13 original findings are addressed at the planning level**. The corrections change the design, implementation plan and contract appendix; they do not claim any proposed production mechanism is implemented or runtime-verified. Phase B remains an explicit separate deliverable. No live test or deployment occurred.

Reviewed against baseline `6e78bc5`. The [original gauntlet](2026-09-13-plan-5-gauntlet.md) and its [325-line ledger](2026-09-13-plan-5-line-review.csv) preserve revision 1. Its counterexample script now reconstructs those historical inputs from the ledger rather than mistaking revised documents for the original draft.

## Closure matrix

| Finding                      | Revision-2 correction                                                                                                                                                            | Required implementation regression                                                                               | Planning disposition                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| F01 · draft causality        | Design §§1,4: arbitrary draft search is manual, with no qualification override. Generated ids must equal server regeneration.                                                    | Earlier SENT copy with same Message-ID AND thread must not confirm this draft.                                   | Addressed by narrowing automatic authority; draft automation is not claimed.                               |
| F02 · credential ABA         | Design §3; plan Task2: required-version token acquisition and refresh, network admission linearization point.                                                                    | Reconnect before acquisition/401 refresh makes zero requests with new credentials.                               | Contract corrected; runtime barrier tests required.                                                        |
| F03 · writer stop proof      | Design Phase B writer rule; plan unpaid contract: promise/abort/lease/status is never a stop receipt.                                                                            | Rejection after remote acceptance permits no second writer.                                                      | Unsafe permission removed; byte continuation remains unimplemented.                                        |
| F04 · failure classification | Design §2; plan Tasks1,4: gate participates in protocol2, only claimed/no-byte may be failed-safe; late error returns winner.                                                    | Expired/401 after ambiguous bytes keeps key held; late error after success returns stored result.                | Contract corrected; no blanket 4xx safety inference.                                                       |
| F05 · evidence types         | Appendix Proof/Observation/SendResult: distinct session and search proofs, versioned result, identity excludes mutable labels.                                                   | Valid final session receipt with empty search settles once; changed labels replay first result.                  | Typed paths and normalization defined.                                                                     |
| F06 · budgets                | Design §3; appendix SQL: durable window AND rolling caps, refresh accounting, three deadlines and bounded body reads.                                                            | Concurrent disjoint cron windows cannot exceed credits; stalled/oversize body refuses.                           | SQL credit fixture passes; transport/runtime proof still required.                                         |
| F07 · Retry-After            | Design §3: typed defer retryAt, no sleep; 30m cap applies only to generated backoff.                                                                                             | 429/3600 produces no retry before one hour; beyond horizon goes manual.                                          | Contradiction removed.                                                                                     |
| F08 · qualification          | Design §6; appendix CLI/build recipe: trusted deployment operator, no public writer, verified artifact/build identity, scratch-only probe allowlist and random nonreused epochs. | Forged build, normal-profile probe, wrong account/version and prune/recreate epoch refuse.                       | Writer/bootstrap contract supplied.                                                                        |
| F09 · retention/repair       | Design §7: 24h secret erasure, 7d recovery metadata, explicit physical row caps; admin byte abandonment preserves unknown result/key.                                            | Ciphertext expiry, cap admission, foreign/unknown-producer cleanup refusal.                                      | Bounded added storage and repair policy specified; existing journal lifetime explicitly outside cap claim. |
| F10 · URL grammar            | Design §5: raw-before-normalized validation, explicit query/path grammar and typed original-upload endpoint.                                                                     | Encoded traversal refuses before token; large draft direct uploads work without recovery enrollment.             | Normalization loophole and draft regression addressed.                                                     |
| F11 · Range                  | Design §5; appendix parser fixtures: two bounded documented forms, exact status headers, awaiting_final state.                                                                   | Prefix/bare ranges accepted; overflow/regression/multiple ranges refused.                                        | Pure fixture checks pass; live wire qualification remains required.                                        |
| F12 · execution detail       | Main plan now scoped to Phase A; appendix supplies migration SQL, type contracts, transaction ordering, actual harness entry points/case registry and numerical gates.           | Workerd migration/fixtures, executable harness and every named fault case precede implementation claims.         | Original all-Plan-5 readiness overclaim removed; Phase B is explicitly unpaid.                             |
| F13 · rollback               | Design §8: transaction-permit DB guards, random enablement epochs and writer-plus-cron compatibility floor.                                                                      | Old permitless audit refuses; disable/prune/recreate fences; rollback-floor cron still cleans unrelated staging. | Mixed-writer SQL fixture passes; rollout runtime test required.                                            |

## Fresh review follow-up

An independent reviewer rechecked the revised credential, evidence, scheduler and rollback contracts. That pass found three additional contradictions in the first revision-2 draft; all were corrected before closeout:

1. Original large draft uploads share the PUT adapter. Added `UploadEndpoint` with send/draft-create/draft-update cases; automatic recovery remains send-only.
2. A pruned control record could recreate epoch 1. Replaced integer epochs with fresh internally generated 256-bit identifiers on every create/edit, including recreation. The manifest cannot choose them.
3. A pre-protocol cron can abort its whole bulk update on a protected row. Added a compatibility floor containing both the permit-aware writer and protocol-separated cron; unsupported old binaries are not valid rollback targets.

The reviewer found no remaining contradiction in those three fixes. This is review evidence, not deployed/runtime proof. The revised source requirements were checked against the actual send registry and migration schema locally.

## Verification performed

```bash
python3 docs/superpowers/reviews/2026-09-13-plan-5-conformance.py
node docs/superpowers/reviews/2026-09-13-plan-5-review-probes.mjs
npx eslint docs/superpowers/reviews/2026-09-13-plan-5-review-probes.mjs
```

The conformance script passed **10 checks**: existing migrations plus proposed migration, composite ownership, metadata bound/horizon, old-writer refusal, permit rollback/downgrade, second-success guard, both Range forms/refusals, tool registry names, rolling request credit across windows, epoch recreation, with historical ledger validation included in the suite's named tests. The count is the unittest count, not the number of assertions.

The historical probe passed all four counterexamples and reproduced both revision-1 hashes. Markdown formatting and local file links are checked separately at closeout. No full application test rerun was needed for planning-only edits; no production code or installed migration changed.

## Updated assessment

| Axis                          | Revision 1 → 2 | Remaining proof                                                               |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------- |
| Recovery direction            | 7 → 8          | Qualify exact generated search and session behavior with authorized fixtures. |
| Safety specification          | 4 → 7          | Execute token, transport, state and mixed-version races in workerd.           |
| Phase A execution readiness   | 3 → 7          | Implement the explicit contracts with red/green integration tests.            |
| Qualification reproducibility | 4 → 6          | Build/run the guarded harness on actual clients/devices and record all gates. |

Scores are review judgments, not measured reliability. No score claims Phase B readiness or production readiness. Review the revision-2 design before implementation; keep the release pre-release while mandatory live/device/resource gates remain not-run.
