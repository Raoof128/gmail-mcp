## What this changes

<!-- The behaviour that is different now, in a sentence or two. The diff shows what; explain why. -->

## How it was verified

<!-- The command you ran and what it showed. "Should work" is not verification. -->

- [ ] `npm run verify` passes locally
- [ ] A test covers the change, and it was watched failing before the fix

## Invariants

<!-- Delete any that do not apply. If one does apply, say which test demonstrates it still holds. -->

- [ ] Touches approvals: attachments still come only from the approved payload, and a pending action is
      still claimable exactly once
- [ ] Touches the operation journal: idempotency keys are still bound to one action and payload hash
- [ ] Touches policy: modifiers still only raise a level, and account ownership is still checked first
- [ ] Touches migrations: added a new numbered file rather than editing an applied one

## Anything left undone

<!-- Scope you deliberately did not cover, and why. -->
