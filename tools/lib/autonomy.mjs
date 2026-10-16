// AUTONOMY.md 的機械版。等級由使用者在 dlm.config.json 設;這裡只決定「這件事往哪送」。
//   L0 每一次合併都問使用者
//   L1 script 全綠且 Verifier 無異議 → 自動;有 ABSTAIN → 問使用者
//   L2 ABSTAIN 交 Critic;範圍在父節點內的側向子節點自動批准
// 永遠歸使用者:新的頂層功能、契約 major、規則層、預算、任何 @e2e 試用。

// shared 節點(log、設定、契約這類橫切改動)影響範圍最大;沒有 accept 指令就沒有機器驗收,
// 不管等級多高都不自動合併,至少過 Critic 或使用者。

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
