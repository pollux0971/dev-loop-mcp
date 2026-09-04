#!/usr/bin/env bash
# 把模板的守門腳本複製進目標 repo,並寫入版本標頭;靠版本號防漂移,不靠路徑(CI 上沒有模板路徑)。
#
# 用法:
#   <template>/scripts/sync-gates.sh <目標 repo 根> [目標子目錄,預設 scripts]
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --check   # 只比對,不寫:版本或內容不同 → exit 1
#
# 複製的檔:_root.ts、check-*.ts、boundaries.allow.json(只在目標不存在時)。
# 每個 .ts 檔頭插入:// SOURCE: template vX.Y.Z (<commit>) — 勿手改;升版用 sync-gates.sh
# 本地急修:在檔頭第 2 行加 `// HOTFIX: YYYY-MM-DD <理由>`,--check 只警告不紅;超過 24 小時未回流模板 → 紅。
# 反向驗證:改目標 repo 裡任一守門檔一個字 → --check 紅;加今天的 HOTFIX 行 → 警告綠;把日期改成三天前 → 紅;重跑 sync → 綠。
set -euo pipefail
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?目標 repo 根目錄}"; SUBDIR="${2:-scripts}"; MODE="${3:-}"
[ "$SUBDIR" = "--check" ] && { SUBDIR=scripts; MODE=--check; }
VERSION="$(cat "$TEMPLATE_DIR/VERSION")"
COMMIT="$(git -C "$TEMPLATE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
HEADER="// SOURCE: template v${VERSION} (${COMMIT}) — 勿手改;升版用 sync-gates.sh"
DEST="$TARGET/$SUBDIR"; mkdir -p "$DEST"
fail=0; n=0
for src in "$TEMPLATE_DIR"/scripts/_root.ts "$TEMPLATE_DIR"/scripts/check-*.ts; do
  name="$(basename "$src")"; dst="$DEST/$name"; n=$((n+1))
  tmp="$(mktemp)"; { echo "$HEADER"; cat "$src"; } > "$tmp"
  if [ "$MODE" = "--check" ]; then
    if [ ! -f "$dst" ]; then echo "✗ 缺 $dst"; fail=1
    elif ! head -1 "$dst" | grep -q "template v${VERSION} "; then echo "✗ $name 版本不同:$(head -1 "$dst")"; fail=1
    elif ! cmp -s "$tmp" "$dst"; then
      # 本地 hotfix 規則:檔頭第 2 行寫 `// HOTFIX: YYYY-MM-DD <理由>` 可暫時偏離模板,24 小時內要回流模板;過期即紅
      hot="$(sed -n '2p' "$dst" | grep -oE '^// HOTFIX: [0-9]{4}-[0-9]{2}-[0-9]{2}' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"
      if [ -n "$hot" ]; then
        age=$(( ( $(date +%s) - $(date -d "$hot" +%s) ) / 3600 ))
        if [ "$age" -le 24 ]; then echo "⚠ $name 有本地 HOTFIX($hot,${age}h),24 小時內要回流模板"; else echo "✗ $name 的 HOTFIX($hot)已超過 24 小時未回流模板"; fail=1; fi
      else echo "✗ $name 內容被改過(版本相同但 diff 不空;急修請在第 2 行加 // HOTFIX: <日期> <理由>)"; fail=1; fi
    else echo "✓ $name"; fi
  else
    mv "$tmp" "$dst"; echo "→ $dst"
  fi
  rm -f "$tmp" 2>/dev/null || true
done
if [ "$MODE" != "--check" ] && [ ! -f "$DEST/boundaries.allow.json" ]; then cp "$TEMPLATE_DIR/scripts/boundaries.allow.json" "$DEST/"; echo "→ $DEST/boundaries.allow.json(新建)"; fi
[ "$n" -gt 0 ] || { echo "掃到 0 支守門,這不是很乾淨,是腳本壞了"; exit 1; }
if [ "$MODE" = "--check" ]; then [ "$fail" = 0 ] && echo "✓ 守門與 template v${VERSION} 一致" || exit 1
else echo "已同步 $n 支守門到 $DEST(template v${VERSION} ${COMMIT});目標 repo 的 CLAUDE.md 記「採用模板 v${VERSION}」"; fi
