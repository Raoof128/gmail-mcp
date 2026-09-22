# Documentation map

Two kinds of document live here and they answer different questions. The current set describes the system
as it is. The development record describes what was true when each entry was written, and is not edited to
keep up.

## Current

Read these for the present tense.

| Question                                              | Document                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| What is this and what is its status?                  | [README](../README.md)                                                                       |
| How is it structured, and why split that way?         | [ARCHITECTURE.md](ARCHITECTURE.md)                                                           |
| What exactly does it guarantee?                       | [INVARIANTS.md](INVARIANTS.md)                                                               |
| What is the threat model, and what is out of scope?   | [SECURITY.md](../SECURITY.md)                                                                |
| Every decision and the fact it rests on               | [The design spec](superpowers/specs/2026-09-09-gmail-mcp-design.md)                          |
| How do I develop and test?                            | [CONTRIBUTING.md](../CONTRIBUTING.md)                                                        |
| What changed, and what are the current test counts?   | [CHANGELOG.md](../CHANGELOG.md)                                                              |
| How do I set up Google Cloud?                         | [runbooks/google-cloud.md](runbooks/google-cloud.md)                                         |
| How do I install and operate the companion?           | [runbooks/companion.md](runbooks/companion.md)                                               |
| What would a release need, and why can it not happen? | [runbooks/release-qualification.md](runbooks/release-qualification.md)                       |
| What is verified privately before any release?        | [runbooks/release.md](runbooks/release.md)                                                   |
| What is deliberately not built?                       | [The deferred register](superpowers/plans/2026-09-15-gmail-mcp-deferred-feature-register.md) |

The design spec carries a dated filename because it was written as a plan input, but sections 4.7 and 4.8
have been rewritten from source and it is a current document. `ARCHITECTURE.md` and the spec are the
present tense; where they disagree, the spec wins.

## What is implemented, and what is not

The distinction between a tested refusal and a satisfied guarantee is load-bearing here, and three places
carry it:

- [README, project status](../README.md#project-status): the component table and the external gates.
- [ARCHITECTURE.md, how to read a claim](ARCHITECTURE.md#how-to-read-a-claim-in-this-repository): the
  vocabulary.
- [INVARIANTS.md](INVARIANTS.md): the guarantees themselves, and the two that hold only by construction.

Five external guarantees are recorded as `not_run` and none can be closed from this repository. Three of
them have a refusal path that is tested, which proves the system declines to proceed without the evidence
and not that the evidence exists. Never read `not_run` as `pass`.

## Development record

Historical, dated, append-only. Useful for why a decision was made and what an audit found; not a
statement about the code today.

- `superpowers/plans/` holds the seven executed plans, each ending in an execution record of what its own tests
  caught. Plan 1 built the authority core, 2 identity and the web pages, 3 the tools and the send pipeline,
  4 staging and the companion, 5 recovery, 6 qualification closure (in progress), 7 owner repair and
  documentation reconciliation.
- `superpowers/specs/` holds the design spec plus the per-plan design inputs for recovery, closure and the
  follow-on features.
- `superpowers/reviews/` holds the gauntlets and their resolutions. Two matter most:
  - [The full-project gauntlet](superpowers/reviews/2026-09-17-full-project-gauntlet.md) is canonical for
    the proof type behind each invariant as of 2026-09-18, the load-bearing predicate table, the
    source-derived tool matrix and the findings. It is appended to, never rewritten.
  - [Plan 6 feasibility](superpowers/reviews/2026-09-16-plan-6-feasibility.md) is canonical for the three
    open feasibility decisions and the evidence each one still needs.
- `handoffs/` holds session handoffs, each carrying a supersession banner.
- `parity/hosted-2026-09-09.json` is the hosted connector's captured tool schemas, the baseline Appendix A
  of the spec compares against.
