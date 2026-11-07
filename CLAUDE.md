# Working on web-sandbox

@agents.md
@CONTRIBUTING.md

## When stuck

When you hit a local minimum or get stuck (a failure that keeps coming back, a fix that only moves the symptom, a test
that passes or fails by timing), always deconstruct until you reach the root cause, then solve it by construction as
far up the ladder as it goes: make the wrong state impossible to build, then impossible to reach, before falling back to
a check, and to a documented limit only last. "Flake" is not a root cause.

## Checking for drift

Periodically make sure you are not drifting into a local minimum, and at the latest at every step boundary (a merged PR,
a CI failure, a finished review pass, a fix that needed a follow-up). The signs: a fix that moves a symptom, a follow-up
to a follow-up, a test changed to fit the code, the same class of problem coming back. When you see one, stop and apply
"When stuck" above.

## Before asking the owner for a decision

When something seems to need the owner's decision, first deconstruct it until you reach its root, then solve it by
construction (as above). Ask the owner only if a real decision is still needed after that: a choice the root and the
construction do not settle, such as a public name, a change to a documented promise, or reversing an earlier owner
decision.
