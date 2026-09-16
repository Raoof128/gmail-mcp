# Plan 6 feasibility decisions

Checked 2026-09-16. These are source-backed prerequisite decisions, not target qualification results. No target deployment, account, provider barrier or measurement receipt was supplied for these checks.

## Provider commit barrier: unresolved

The [Gmail upload guide](https://developers.google.com/workspace/gmail/api/guides/uploads) describes resumable sessions, interruption and status queries. It does not document a control that deterministically withholds a committed send response from an unchanged deployed Worker. The repository's FakeGoogle pause demonstrates that schedule only in workerd tests.

Decision: retain `provider_barrier_unavailable` for target execution until an authorized mechanism supplies independent commit observation and identifies its effect on the exact Worker bundle/configuration. Disconnecting the MCP client does not prove loss between Gmail and Worker. A mechanism that changes deployed bytes qualifies only those changed bytes. Required falsifying test: show that an acknowledged provider commit cannot produce a direct Worker receipt while the selected status-only recovery still converges, without a second send.

## Writer quiescence and deployment exclusion: unresolved

[Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) documents cancellation of in-flight queries during restore. That does not by itself establish that an old Worker cannot submit another query afterwards. The repository has a local lock and maintenance generation fences, but no verified controller excluding every external deployment actor and old writer.

Decision: refuse restore before its POST when quiescence is unavailable; retain maintenance once entered. A boolean drain result or elapsed timeout is insufficient for the v2 controller. Required evidence: exact account/database, old and new generations, all routed versions, authoritative exclusion mechanism and expiry, plus a test releasing an old delayed writer after the proposed barrier. Production restore integration remains open.

## Peak isolate memory: unresolved

[Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) describe invocation-time memory percentiles obtained by reservoir sampling. [Local memory profiling](https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/) can investigate allocations. Neither source establishes full peak coverage for this exact deployed payload/concurrency run.

Decision: retain `measurement_unavailable` until a target-bound measurement source proves coverage of the relevant isolates and the complete operation intervals. Sampled percentiles, Node RSS and successful requests cannot certify the required peak below 128,000,000 bytes. The configured route CPU limit, version, counted payload bytes and source hashes must accompany the measurement. Ten serial runs and two concurrent streams remain unperformed.

## Consequences

Tasks 5, 8, 9, 10 and 11 retain their live gates. Local fault and native race tests can proceed independently. No finding here establishes that a supported mechanism is impossible; each decision records the evidence still missing. Tasks must not be closed merely because their runtime refuses an unavailable mechanism.
