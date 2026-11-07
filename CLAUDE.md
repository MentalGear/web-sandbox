# Working on web-sandbox

@agents.md
@CONTRIBUTING.md

## When stuck

When you hit a local minimum or get stuck (a failure that keeps coming back, a fix that only moves the symptom, a test
that passes or fails by timing), always deconstruct until you reach the root cause, then solve it by construction as
far up the ladder as it goes: make the wrong state impossible to build, then impossible to reach, before falling back to
a check, and to a documented limit only last. "Flake" is not a root cause.

## Before asking the owner for a decision

When something seems to need the owner's decision, first deconstruct it until you reach its root, then solve it by
construction (as above). Ask the owner only if a real decision is still needed after that: a choice the root and the
construction do not settle, such as a public name, a change to a documented promise, or reversing an earlier owner
decision.
