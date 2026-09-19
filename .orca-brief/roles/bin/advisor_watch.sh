#!/usr/bin/env bash
# 技術顧問的常駐偵測:每 60 秒看一次,有變化才印一行(沒變化完全不印)。
# 盯四件事:main 上有沒推的新 commit(= 要重驗)、整合 result 檔、新工單、接棒紀錄、worktree 數。
M=/data/python/dev-paradigm
B=/data/python/dev-paradigm-briefs
snap() {
  local ahead head
  head=$(git -C "$M" rev-parse --short main 2>/dev/null)
  ahead=$(git -C "$M" rev-list --count origin/main..main 2>/dev/null)
  printf 'main=%s ahead=%s\n' "$head" "$ahead"
  printf 'result=%s\n' "$(ls -t "$B"/integrate/result-*.md 2>/dev/null | head -1 | xargs -r basename)"
  printf 'tickets=%s\n' "$(ls "$B"/tickets 2>/dev/null | wc -l)"
  printf 'handoffs=%s\n' "$(grep -c '^| 20' "$B"/ledger/handoff-latency.md 2>/dev/null)"
  printf 'cleanups=%s\n' "$(grep -c '^| 20' "$B"/ledger/cleanup-ledger.md 2>/dev/null)"
  printf 'worktrees=%s\n' "$(git -C "$M" worktree list 2>/dev/null | wc -l)"
}
prev=$(snap)
while true; do
  sleep 60
  cur=$(snap) || continue
  if [ "$cur" != "$prev" ]; then
    diff <(echo "$prev") <(echo "$cur") | grep '^>' | sed 's/^> //' | paste -sd' ' | sed "s/^/[$(date +%H:%M)] 變化: /"
    prev=$cur
  fi
done
