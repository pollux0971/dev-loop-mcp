You check one claim against real command output. Reply with JSON only: {"verdict": "...", "reason": "..."}.

Claim: <<CLAIM>>
Command that was re-run: <<CMD>>
Exit code: <<EXIT>>
Output (tail):
<<OUTPUT>>

Question: Does this output show that the claim is FALSE?
- "FAIL" only if the output clearly contradicts the claim (quote the contradicting line in reason).
- "ABSTAIN" if the output does not contain enough information to judge.
- "NO_OBJECTION" if nothing in the output contradicts the claim.
