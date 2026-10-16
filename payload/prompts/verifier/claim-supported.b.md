Reply with JSON only: {"verdict": "FAIL" | "ABSTAIN" | "NO_OBJECTION", "reason": "<one sentence>"}.

A developer says: "<<CLAIM>>"
We ran `<<CMD>>` ourselves. It exited with <<EXIT>> and printed:
<<OUTPUT>>

Does the printed output directly support what the developer says?
If it contradicts it, answer FAIL. If it neither supports nor contradicts it, answer ABSTAIN. If it supports it, answer NO_OBJECTION.
