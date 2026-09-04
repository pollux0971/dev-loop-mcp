#!/usr/bin/env bash
# 把模板的守門腳本複製進目標 repo,並寫入版本標頭;靠版本號防漂移,不靠路徑(CI 上沒有模板路徑)。
#
# 用法:
#   <template>/scripts/sync-gates.sh <目標 repo 根> [目標子目錄,預設 scripts]
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --check   # 只比對,不寫:版本或內容不同 → exit 1
#
# 複製的檔:_root.ts、check-*.ts(程式,每次同步都覆蓋,靠版本標頭防漂移),以及
# scripts/py/*.py(定向反向驗證工具 mutate.py 與它的 meta-test test_mutate.py,同樣每次
# 同步都覆蓋、同樣靠版本標頭防漂移——只是標頭用 `#` 開頭的 Python 註解,不是 `//`)。
# 設定檔 CONFIG_FILES(boundaries.allow.json、boundaries.owners.json、gates.config.json)**只在目標不存在時**複製一次,
# 之後永遠不覆蓋——那是每個專案自己填的落點表跟例外清單,不是模板的一部分。`--check` 對這些檔案
# 一律跳過比對,印一行「(你的設定檔,不比對)」,不會因為專案改了自己的設定就報紅。
# 每個 .ts 檔頭插入:// SOURCE: template vX.Y.Z (<commit>) — 勿手改;升版用 sync-gates.sh
# 每個 scripts/py/*.py 檔頭插入:# SOURCE: template vX.Y.Z (<commit>) — 勿手改;升版用 sync-gates.sh
# (這一行插在檔案最上面,原本檔頭的 shebang / 專案 C 來源註解會被往下推一行;
#  這支工具一律用 `python3 <path>` 呼叫,不依賴 shebang 可執行,跟 .ts 檔插法一致。)
# 本地急修:在檔頭第 2 行加 `// HOTFIX: YYYY-MM-DD <理由>`(Python 檔用 `# HOTFIX: ...`),
# --check 只警告不紅;超過 24 小時未回流模板 → 紅。
# 反向驗證:改目標 repo 裡任一守門檔一個字 → --check 紅;加今天的 HOTFIX 行 → 警告綠;把日期改成三天前 → 紅;重跑 sync → 綠。
# 反向驗證(設定檔):改目標 repo 的 boundaries.owners.json 一個字 → --check 印「(你的設定檔,不比對)」且不紅。
set -euo pipefail
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?目標 repo 根目錄}"; SUBDIR="${2:-scripts}"; MODE="${3:-}"
[ "$SUBDIR" = "--check" ] && { SUBDIR=scripts; MODE=--check; }
VERSION="$(cat "$TEMPLATE_DIR/VERSION")"
COMMIT="$(git -C "$TEMPLATE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
HEADER="// SOURCE: template v${VERSION} (${COMMIT}) — 勿手改;升版用 sync-gates.sh"
PY_HEADER="# SOURCE: template v${VERSION} (${COMMIT}) — 勿手改;升版用 sync-gates.sh"
DEST="$TARGET/$SUBDIR"; mkdir -p "$DEST"
PY_DEST="$DEST/py"
# 設定檔:專案自己的東西,sync 不覆蓋、--check 不比對。
CONFIG_FILES=(boundaries.allow.json boundaries.owners.json gates.config.json)
fail=0; n=0

# 同步單一檔案:$1=來源檔、$2=要插入的 SOURCE 標頭(依副檔名 // 或 #)、$3=目的目錄。
# .ts 與 scripts/py/*.py 共用同一套邏輯(每次同步覆蓋、版本標頭防漂移、HOTFIX 例外),
# 差別只在標頭的註解語法與目的目錄。
sync_one() {
  local src="$1" header="$2" dstdir="$3"
  local name dst tmp hot age
  name="$(basename "$src")"; dst="$dstdir/$name"; n=$((n+1))
  tmp="$(mktemp)"; { echo "$header"; cat "$src"; } > "$tmp"
  if [ "$MODE" = "--check" ]; then
    if [ ! -f "$dst" ]; then echo "✗ 缺 $dst"; fail=1
    elif ! head -1 "$dst" | grep -q "template v${VERSION} "; then echo "✗ $name 版本不同:$(head -1 "$dst")"; fail=1
    elif ! cmp -s "$tmp" "$dst"; then
      # 本地 hotfix 規則:檔頭第 2 行寫 `// HOTFIX: YYYY-MM-DD <理由>`(Python 檔用 `#`)
      # 可暫時偏離模板,24 小時內要回流模板;過期即紅
      hot="$(sed -n '2p' "$dst" | grep -oE '^(//|#) HOTFIX: [0-9]{4}-[0-9]{2}-[0-9]{2}' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"
      if [ -n "$hot" ]; then
        age=$(( ( $(date +%s) - $(date -d "$hot" +%s) ) / 3600 ))
        if [ "$age" -le 24 ]; then echo "⚠ $name 有本地 HOTFIX($hot,${age}h),24 小時內要回流模板"; else echo "✗ $name 的 HOTFIX($hot)已超過 24 小時未回流模板"; fail=1; fi
      else echo "✗ $name 內容被改過(版本相同但 diff 不空;急修請在第 2 行加 HOTFIX 註解:<日期> <理由>)"; fail=1; fi
    else echo "✓ $name"; fi
  else
    mkdir -p "$dstdir"
    mv "$tmp" "$dst"; echo "→ $dst"
  fi
  rm -f "$tmp" 2>/dev/null || true
}

for src in "$TEMPLATE_DIR"/scripts/_root.ts "$TEMPLATE_DIR"/scripts/check-*.ts; do
  sync_one "$src" "$HEADER" "$DEST"
done
for src in "$TEMPLATE_DIR"/scripts/py/*.py; do
  sync_one "$src" "$PY_HEADER" "$PY_DEST"
done
if [ "$MODE" = "--check" ]; then
  for cfg in "${CONFIG_FILES[@]}"; do echo "○ $cfg(你的設定檔,不比對)"; done
else
  for cfg in "${CONFIG_FILES[@]}"; do
    if [ ! -f "$DEST/$cfg" ]; then
      cp "$TEMPLATE_DIR/scripts/$cfg" "$DEST/"; echo "→ $DEST/$cfg(新建)"
    fi
  done
fi
[ "$n" -gt 0 ] || { echo "掃到 0 支守門,這不是很乾淨,是腳本壞了"; exit 1; }
if [ "$MODE" = "--check" ]; then [ "$fail" = 0 ] && echo "✓ 守門與 template v${VERSION} 一致" || exit 1
else echo "已同步 $n 支守門到 $DEST(含 $PY_DEST 底下的 Python 版工具;template v${VERSION} ${COMMIT});目標 repo 的 CLAUDE.md 記「採用模板 v${VERSION}」"; fi
