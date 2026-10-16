// Mechanical version of AUTONOMY.md. The user sets the level in dlm.config.json; this only decides "where this item goes".
//   L0 ask the user on every merge
//   L1 scripts all green and the Verifier has no objection -> automatic; on ABSTAIN -> ask the user
//   L2 ABSTAIN goes to the Critic; a lateral child node within the parent node's scope is approved automatically
// Always left to the user: a new top-level feature, contract major, the rules layer, budget, any @e2e hand trial.

// shared nodes (cross-cutting changes such as log, config, contracts) have the widest impact; with no accept command there is no machine acceptance,
// so they are never merged automatically at any level, and at least pass the Critic or the user.

export function acceptRoute({ level, summary, tier, criticAvailable, kind, hasAccept = true }) {
  if (!summary.ok) return 'reject';
  if (level === 0) return 'user';
  const unverifiedShared = kind === 'shared' && !hasAccept;
  const needsSecondOpinion = summary.abstains.length > 0 || tier === 'strict' || unverifiedShared;
  if (!needsSecondOpinion) return 'accept';
  if (level >= 2 && criticAvailable) return 'critic';
  return 'user';
}

export function spawnRoute({ level, contained }) {
  if (level >= 2 && contained) return 'auto';
  return 'user';
}

export function escalationRoute({ level, criticAvailable }) {
  return level >= 2 && criticAvailable ? 'critic' : 'user';
}
