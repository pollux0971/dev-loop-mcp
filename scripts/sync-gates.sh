#!/usr/bin/env bash
# 把模板的守門腳本複製進目標 repo,並寫入版本標頭;靠版本號 + 檔身雜湊防漂移,不靠路徑
# (CI 上沒有模板路徑——這正是 `--check` 要做到的:自包含,見下)。
#
# 用法:
#   <template>/scripts/sync-gates.sh <目標 repo 根> [目標子目錄,預設 scripts]
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --check   # 只比對,不寫:標頭壞掉或內容被動過 → exit 1
#
# 複製的檔:_root.ts、check-*.ts(程式,每次同步都覆蓋,靠版本標頭防漂移),以及
# scripts/py/*.py(定向反向驗證工具 mutate.py 與它的 meta-test test_mutate.py,同樣每次
# 同步都覆蓋、同樣靠版本標頭防漂移——只是標頭用 `#` 開頭的 Python 註解,不是 `//`)。
# 設定檔 CONFIG_FILES(boundaries.allow.json、boundaries.owners.json、gates.config.json)**只在目標不存在時**複製一次,
# 之後永遠不覆蓋——那是每個專案自己填的落點表跟例外清單,不是模板的一部分。`--check` 對這些檔案
# 一律跳過比對,印一行「(你的設定檔,不比對)」,不會因為專案改了自己的設定就報紅。
#
# 每個 .ts 檔頭插入:// SOURCE: template vX.Y.Z (<commit>) sha256=<檔身雜湊> — 勿手改;升版用 sync-gates.sh
# 每個 scripts/py/*.py 檔頭插入:# SOURCE: template vX.Y.Z (<commit>) sha256=<檔身雜湊> — 勿手改;升版用 sync-gates.sh
# (這一行插在檔案最上面,原本檔頭的 shebang / 專案 C 來源註解會被往下推一行;
#  這支工具一律用 `python3 <path>` 呼叫,不依賴 shebang 可執行,跟 .ts 檔插法一致。)
#
# `sha256=<檔身雜湊>` 是同步當下、**原始檔案內容**(不含這行 SOURCE 標頭)的 sha256(CHANGELOG
# 1.3.2 (D))。`--check` 靠這個雜湊做**自我一致性**檢查:重算已安裝檔案「標頭以外」的部分的
# sha256,跟標頭裡記的比對——相符代表這份檔案自從同步之後沒被手改過,不需要讀取
# `$TEMPLATE_DIR`(sync 才需要模板路徑,拿新內容;`--check` 只需要問「這份檔案有沒有被
# 動過」,答案就寫在檔案自己身上)。這跟舊版「重新渲染模板內容再 `cmp`」的差別是:舊版能告訴你
# 「跟現在這個模板版本比,一模一樣嗎」,新版只能告訴你「跟同步當時比,被改過嗎」——但也因此
# `--check` 能在 CI 上單獨跑,不必先 checkout 模板。要知道「有沒有跟上模板最新版」是另一件事,
# 見 README.md「版本」段的採用節奏(讀 CHANGELOG 決定要不要升版),不是 `--check` 的工作。
#
# 本地急修:在檔頭第 2 行加 `// HOTFIX: YYYY-MM-DD <理由>`(Python 檔用 `# HOTFIX: ...`),
# --check 只警告不紅;超過 24 小時未回流模板 → 紅。（HOTFIX 那行本身不算進 sha256 比對的
# 「內容」裡——比對用的是「標頭 + HOTFIX 行(如果有)」之後的所有行。）
#
# 反向驗證:
#   改目標 repo 裡任一守門檔一個字 → --check 紅(sha256 不符);加今天的 HOTFIX 行 →
#   警告綠;把日期改成三天前 → 紅;重跑 sync → 綠。
#   自包含:把已經 sync 過的目標 repo 整份複製到別的地方(模板路徑不可達,例如刪掉那個
#   路徑或搬到看不到模板的機器上)→ `--check` 照樣能跑且結果正確(綠或紅視內容而定);
#   改一個字 → 照樣紅。
#   設定檔:改目標 repo 的 boundaries.owners.json 一個字 → --check 印「(你的設定檔,不比對)」且不紅。
set -euo pipefail
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?目標 repo 根目錄}"; SUBDIR="${2:-scripts}"; MODE="${3:-}"
[ "$SUBDIR" = "--check" ] && { SUBDIR=scripts; MODE=--check; }
DEST="$TARGET/$SUBDIR"
PY_DEST="$DEST/py"
# 設定檔:專案自己的東西,sync 不覆蓋、--check 不比對。
CONFIG_FILES=(boundaries.allow.json boundaries.owners.json gates.config.json)
fail=0; n=0

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

# --check 是自包含的:不讀 $TEMPLATE_DIR,只讀已經裝好的那份檔案本身。
# sync(非 --check)才需要 $TEMPLATE_DIR 的 VERSION 與 commit,拿新內容寫進去。
if [ "$MODE" != "--check" ]; then
  mkdir -p "$DEST"
  VERSION="$(cat "$TEMPLATE_DIR/VERSION")"
  COMMIT="$(git -C "$TEMPLATE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi

# 同步單一檔案(非 --check 專用):$1=來源檔、$2=標頭註解字元(// 或 #)、$3=目的目錄。
# .ts 與 scripts/py/*.py 共用同一套邏輯(每次同步覆蓋、版本 + sha256 標頭防漂移、
# HOTFIX 例外),差別只在標頭的註解語法與目的目錄。
sync_one() {
  local src="$1" comment="$2" dstdir="$3"
  local name dst tmp body_hash header
  name="$(basename "$src")"; dst="$dstdir/$name"; n=$((n+1))
  body_hash="$(sha256_file "$src")"
  header="${comment} SOURCE: template v${VERSION} (${COMMIT}) sha256=${body_hash} — 勿手改;升版用 sync-gates.sh"
  tmp="$(mktemp)"; { echo "$header"; cat "$src"; } > "$tmp"
  mkdir -p "$dstdir"
  mv "$tmp" "$dst"; echo "→ $dst"
}

# 自我一致性檢查(--check 專用):$1=顯示用的檔名、$2=已安裝的檔案路徑、$3=標頭註解字元。
# 不碰 $TEMPLATE_DIR——這是「自包含」的核心:凡是這支函式需要的資訊,全部從 $dst 自己身上讀。
check_one() {
  local name="$1" dst="$2" comment="$3"
  if [ ! -f "$dst" ]; then echo "✗ 缺 $dst"; fail=1; return; fi
  local header embedded_hash hotfix_date skip_lines actual_hash age
  header="$(sed -n '1p' "$dst")"
  if ! echo "$header" | grep -qE "^${comment} SOURCE: template v[0-9]+\.[0-9]+\.[0-9]+ \([^)]*\) sha256=[0-9a-f]{64}"; then
    echo "✗ $name 缺 SOURCE 標頭或格式不對(第一行:$header)"; fail=1; return
  fi
  embedded_hash="$(echo "$header" | grep -oE 'sha256=[0-9a-f]{64}' | cut -d= -f2)"
  # 本地 hotfix 規則:檔頭第 2 行寫 `// HOTFIX: YYYY-MM-DD <理由>`(Python 檔用 `#`)
  # 可暫時偏離模板,24 小時內要回流模板;過期即紅。HOTFIX 那行不算進雜湊比對的內容裡,
  # 所以先偵測有沒有這行,決定雜湊要跳過標頭後的幾行。
  hotfix_date="$(sed -n '2p' "$dst" | grep -oE '^(//|#) HOTFIX: [0-9]{4}-[0-9]{2}-[0-9]{2}' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"
  if [ -n "$hotfix_date" ]; then skip_lines=2; else skip_lines=1; fi
  actual_hash="$(tail -n +$((skip_lines+1)) "$dst" | sha256_stdin)"
  if [ "$actual_hash" = "$embedded_hash" ]; then
    echo "✓ $name"
    return
  fi
  if [ -n "$hotfix_date" ]; then
    age=$(( ( $(date +%s) - $(date -d "$hotfix_date" +%s) ) / 3600 ))
    if [ "$age" -le 24 ]; then echo "⚠ $name 有本地 HOTFIX($hotfix_date,${age}h),24 小時內要回流模板"
    else echo "✗ $name 的 HOTFIX($hotfix_date)已超過 24 小時未回流模板"; fail=1; fi
  else
    echo "✗ $name 內容被改過(sha256 不符;急修請在第 2 行加 HOTFIX 註解:<日期> <理由>)"; fail=1
  fi
}

if [ "$MODE" = "--check" ]; then
  for dst in "$DEST"/_root.ts "$DEST"/check-*.ts; do
    [ -f "$dst" ] || continue
    n=$((n+1))
    check_one "$(basename "$dst")" "$dst" "//"
  done
  for dst in "$PY_DEST"/*.py; do
    [ -f "$dst" ] || continue
    n=$((n+1))
    check_one "$(basename "$dst")" "$dst" "#"
  done
else
  for src in "$TEMPLATE_DIR"/scripts/_root.ts "$TEMPLATE_DIR"/scripts/check-*.ts; do
    sync_one "$src" "//" "$DEST"
  done
  for src in "$TEMPLATE_DIR"/scripts/py/*.py; do
    sync_one "$src" "#" "$PY_DEST"
  done
fi

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
if [ "$MODE" = "--check" ]; then [ "$fail" = 0 ] && echo "✓ 守門內容自同步以來未被更動" || exit 1
else echo "已同步 $n 支守門到 $DEST(含 $PY_DEST 底下的 Python 版工具;template v${VERSION} ${COMMIT});目標 repo 的 CLAUDE.md 記「採用模板 v${VERSION}」"; fi
