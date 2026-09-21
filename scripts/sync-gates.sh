#!/usr/bin/env bash
# 把模板的守門腳本複製進目標 repo,並寫入版本標頭;靠版本號 + 檔身雜湊防漂移,不靠路徑
# (CI 上沒有模板路徑——這正是 `--check` 要做到的:自包含,見下)。
#
# 用法:
#   <template>/scripts/sync-gates.sh <目標 repo 根> [目標子目錄,預設 scripts]
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --check     # 只比對,不寫:標頭壞掉或內容被動過 → exit 1
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --lang ts,py  # 明講語言集合
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --prune     # 同步後清掉不在本次選集內的舊檔
#   <template>/scripts/sync-gates.sh <目標 repo 根> [子目錄] --check --verbose  # --check 印出「略過的非模板檔」
#
# 旗標可以任意順序、任意組合(--check 跟 --prune 不能同時給,--check 不寫檔、--prune 會刪檔,
# 兩者互斥)。
#
# 複製的檔:_root.ts、check-*.ts、mutate-with-lock.ts(程式,每次同步都覆蓋,靠版本標頭防漂移;ts 永遠同步,
# 不受語言選集影響),以及 scripts/py/*.py(定向反向驗證工具 mutate.py 與它的 meta-test
# test_mutate.py,同樣每次同步都覆蓋、同樣靠版本標頭防漂移——只是標頭用 `#` 開頭的
# Python 註解,不是 `//`;**只在語言選集含 py 時才同步**,見下「語言選集」)。
# 設定檔 CONFIG_FILES(boundaries.allow.json、boundaries.owners.json、gates.config.json、
# doc-rot.blacklist.json、known-defects.json,模板 1.4.0 加了後兩個)**只在目標不存在時**複製一次,
# 之後永遠不覆蓋——那是每個專案自己填的落點表跟例外清單,不是模板的一部分。`--check` 對這些檔案
# 一律跳過比對,印一行「(你的設定檔,不比對)」,不會因為專案改了自己的設定就報紅。
#
# ## 語言選集(CHANGELOG 1.3.4 (1))
#
# 舊版無條件同步 `scripts/py/*.py`,把 Python 版的定向反向驗證工具塞進純 TypeScript
# 專案——多裝一條沒人用得到的路,而且那條路完全繞過該專案可能已經立好的「測試唯一入口」
# 檔案鎖(PITFALLS P-51)。改成:每次同步先決定「這次要同步哪些語言」,再只同步選中的:
#
#   1. `--lang ts,py` 旗標(逗號分隔)——明講就照講的做。
#   2. 目標安裝目錄(`$DEST/gates.config.json`,即 sync 後這份設定通常跟著裝的地方)或
#      `<目標 repo 根>/scripts/gates.config.json` 的 `sync.languages` 陣列(先找到哪個算哪個)。
#   3. 自動偵測:目標 repo 根有 `pyproject.toml` / `setup.cfg` / `requirements*.txt`,
#      或(排除 `node_modules`、`.git`、本次的安裝目錄本身之後)找得到任何 `*.py` 檔
#      → 含 `py`;否則只有 `ts`。（排除安裝目錄本身是必要的:不排除的話,同步進去的
#      `scripts/py/mutate.py` 下次跑會被自動偵測誤判成「這個 repo 有 Python」,選集
#      永遠回不去純 ts,形成自我循環。）
#
# `ts` 永遠在選集裡,不管走哪一條——`.ts` 守門(數量以 `scripts/` 底下目前的 check-*.ts
# 為準,不寫死)是這套範式的核心,沒有「純 Python 專案」這種概念。每次同步都印一行
# 「選集 <語言清單>(<依據>)」,依據是上面三種之一,不用猜這次為什麼同步了(或沒同步)Python 工具。
#
# `--prune`:同步完成後,掃目標安裝目錄(含 `py/`)裡**有 SOURCE 標頭、但所屬語言不在
# 本次選集內**的檔案,列出來刪掉(該語言目錄清空後,目錄本身也刪);**沒有 SOURCE 標頭
# 的檔案一律不碰**——那可能是這個專案自己寫的東西,不是這支腳本能判斷「不需要」的對象。
# 不加 `--prune` 只同步、不清舊檔(語言選集從 py 改回 ts,`scripts/py/*.py` 會留在原地,
# 直到有人加 `--prune` 才清)。
#
# ## `--check`(CHANGELOG 1.3.4 (2))
#
# 掃目標安裝目錄(含 `py/`)底下**所有檔案**(設定檔 CONFIG_FILES 除外,那些檔案本來就
# 印固定的「你的設定檔,不比對」一行),第一行符合 `^(//|#) SOURCE: template v` 的才當
# 「這是模板同步進來的檔案」拿去比對;不符合的印「(非模板檔,略過)」,**預設不印**,
# 只有 `--verbose` 才印。舊版用 `check-*.ts` 這個檔名 glob 列舉目標目錄,會吃到專案自己
# 寫的 `check-*.test.ts`(沒有 SOURCE 標頭,格式當然「不對」)並要求它也符合標頭格式,
# 逼專案要嘛改檔名迎合守門、要嘛容忍常態紅燈(PITFALLS P-52)——新版靠**自己留下的標記**
# (SOURCE 標頭)認自己裝的東西,不靠檔名猜。sha256 自我一致性、HOTFIX 例外邏輯不變,見下。
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
# 本地急修:在檔頭第 2 行加 `// HOTFIX: YYYY-MM-DD <回流去向> <理由>`
# (Python 檔用 `# HOTFIX: ...`),--check 只警告不紅;超過 24 小時未回流模板 → 紅。
# 回流去向必須是非空、非佔位字元的工單/issue ID;舊格式(只有日期+理由)不再相容。
# HOTFIX 那行本身不算進 sha256 比對的「內容」裡——比對用的是「標頭 + HOTFIX 行(如果有)」
# 之後的所有行。
#
# 反向驗證:
#   改目標 repo 裡任一守門檔一個字 → --check 紅(sha256 不符);加今天的 HOTFIX 行 →
#   警告綠;把日期改成三天前 → 紅;重跑 sync → 綠。
#   自包含:把已經 sync 過的目標 repo 整份複製到別的地方(模板路徑不可達,例如刪掉那個
#   路徑或搬到看不到模板的機器上)→ `--check` 照樣能跑且結果正確(綠或紅視內容而定);
#   改一個字 → 照樣紅。
#   設定檔:改目標 repo 的 boundaries.owners.json 一個字 → --check 印「(你的設定檔,不比對)」且不紅。
#   語言選集:純 TypeScript 假 repo(無任何 Python 跡象)同步 → 選集只有 ts、`scripts/py/`
#   不存在;加一個 `requirements.txt` 重跑 → 選集含 py、`scripts/py/*.py` 出現;刪掉
#   `requirements.txt` 再帶 `--prune` 重跑 → 選集回到只有 ts,`scripts/py/` 底下有 SOURCE
#   標頭的檔案被列出並刪除,目錄本身清空後也刪除,其他檔案不受影響。
#   `--check` 的檔名無關性:目標目錄放一個專案自己的 `check-foo.test.ts`(沒有 SOURCE
#   標頭)→ `--check` 仍然綠,且預設不提這個檔案;加 `--verbose` → 印一行「(非模板檔,略過)」。
#   接線檢查(CHANGELOG 1.4.0,細節見下面 `## 接線檢查` 段):同步進去的 check-boundaries.ts
#   一開始沒有任何 script 呼叫它 → `--check` 紅、印「同步進來但沒接線」;在 package.json
#   加一行 `"boundaries": "tsx scripts/check-boundaries.ts"` → 重跑 `--check` 轉綠;拿掉
#   那一行、改成在 gates.config.json 加 `"unwired": [{ "file": "check-boundaries.ts",
#   "reason": "..." }]` → 一樣綠;把 reason 清空 → 紅(allowlist 條目本身不合法)。
#   plain sync(非 --check)在全新的假 consumer 上跑一次 → 印出「建議加進 package.json」
#   清單(含每一支還沒接線的 check-*.ts)跟 `needs-config:` 清單(含 boundaries.owners.json
#   跟 gates.config.json,因為都是這次才新建的佔位檔;standalone.json 一開始就不存在,
#   也會被列出);先手動放好一份填過的 boundaries.owners.json、`standalone.json` 再同步 →
#   `needs-config:` 只剩 gates.config.json(或整條都不印,如果三個都先準備好了)。
#
# ## 先掃後寫:拒絕覆蓋 consumer 自己的檔(CHANGELOG 1.5.0)
#
# 舊版 `sync_one()` 對每支來源檔案無條件 `mv "$tmp" "$dst"`——如果 consumer 自己寫了
# 一支同名的 `check-X.test.ts`(沒有 SOURCE 標頭),會被靜默蓋掉,一句話都不講
# (專案 A 實際損失三支檔案,靠 git HEAD 復原;見 PITFALLS P-85)。新版 sync(非
# `--check`)在寫任何檔之前**先掃後寫**:對本次選集(ts 永遠在選集裡;py 看語言
# 選集)的每一支來源檔,算出對應的目的檔路徑;若目的檔已存在且第一行不符
# `^(//|#) SOURCE: template v`(判斷方式跟 `--check` 認「這是不是模板裝的」同一套,
# 見上面「## `--check`」段),就記一筆衝突。掃完只要有任何衝突,列出**全部**命中的
# 檔案路徑、每一筆都印
# 「✗ <dst> 已存在且沒有 SOURCE 標頭(是你們自己的檔);請改名(例如 <base>.local.<ext>)
# 或刪掉後重跑,sync 不會蓋掉它」,然後 exit 1,**一個檔都不寫**——不要寫一半才停,
# 那樣 consumer 的 scripts/ 會是半新半舊,比全部不寫更難排查。
# 這條規則沒有旗標可以跳過(不給 `--force`):要蓋過去是 consumer 自己的決定,方法是
# 把自己的檔案改名成 `<base>.local.<ext>`(例如 `check-boundaries.local.test.ts`)
# 或直接刪掉再重跑——不是模板幫你決定「這支我猜是舊版留下的可以蓋」。
# 設定檔(CONFIG_FILES)完全不受影響,它們本來就只在目標不存在時才複製一次,這條規則
# 跟它們的邏輯無關。`--check` 與 `--prune` 的行為不變(見上面各自的段落)。
set -euo pipefail
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?目標 repo 根目錄}"; shift || true

SUBDIR="scripts"; SUBDIR_SET=0
MODE=""
PRUNE=0
VERBOSE=0
LANG_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="--check"; shift ;;
    --prune) PRUNE=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    --lang)
      [ $# -ge 2 ] || { echo "✗ --lang 需要語言清單,例如 ts,py"; exit 1; }
      LANG_FLAG="$2"; shift 2
      ;;
    -*)
      echo "✗ 未知旗標:$1"; exit 1
      ;;
    *)
      if [ "$SUBDIR_SET" = 1 ]; then echo "✗ 未知參數:$1"; exit 1; fi
      SUBDIR="$1"; SUBDIR_SET=1
      shift
      ;;
  esac
done

if [ "$PRUNE" = 1 ] && [ "$MODE" = "--check" ]; then
  echo "✗ --prune 不能跟 --check 一起用(--check 不寫檔,--prune 會刪檔)"
  exit 1
fi

DEST="$TARGET/$SUBDIR"
PY_DEST="$DEST/py"
# 設定檔:專案自己的東西,sync 不覆蓋、--check 不比對。
CONFIG_FILES=(boundaries.allow.json boundaries.owners.json gates.config.json doc-rot.blacklist.json known-defects.json)
MANIFEST_NAME=".npx-init-manifest.json"
MANIFEST_PATH="$TARGET/$MANIFEST_NAME"
declare -a MANAGED_PATHS=()
declare -a MANAGED_SOURCES=()
declare -a MANAGED_HASHES=()
declare -a MANAGED_CONFLICTS=()
fail=0; n=0; hotfix_n=0
declare -a hotfix_reports=()

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

# $1=回流去向 → 0 = 符合白名單格式;1 = 格式不合法。
# 新格式另要求後面還要有非空理由,用來拒絕舊的日期+單一理由字串。
is_valid_hotfix_route() {
  local route="$1"
  [[ "$route" =~ ^(#[0-9]+|[A-Za-z][A-Za-z0-9_]*[-#][0-9]+)$ ]]
}

# --check 尾端的 HOTFIX 報表。這是資訊性輸出,不改變 exit code。
print_hotfix_report() {
  local entry report_name report_date report_route report_reason report_age
  [ "${#hotfix_reports[@]}" -gt 0 ] || return 0
  echo
  echo "HOTFIX 清單:"
  for entry in "${hotfix_reports[@]}"; do
    IFS=$'\t' read -r report_name report_date report_route report_reason report_age <<< "$entry"
    printf '  - 檔名:%s | 日期:%s | 回流去向:%s | 理由:%s | 經過:%s\n' \
      "$report_name" "$report_date" "$report_route" "$report_reason" "$report_age"
  done
}

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

# 自我一致性檢查(--check 專用):$1=顯示用的檔名、$2=已安裝的檔案路徑。
# 不碰 $TEMPLATE_DIR——這是「自包含」的核心:凡是這支函式需要的資訊,全部從 $dst 自己身上讀。
# 註解字元(// 或 #)不用外部傳入,從檔案自己的第一行判斷。
check_one() {
  local name="$1" dst="$2"
  if [ ! -f "$dst" ]; then echo "✗ 缺 $dst"; fail=1; return; fi
  local header embedded_hash hotfix_line hotfix_date hotfix_route hotfix_reason
  local parsed_date parsed_route parsed_reason hotfix_epoch hotfix_invalid skip_lines actual_hash age
  header="$(sed -n '1p' "$dst")"
  if ! echo "$header" | grep -qE '^(//|#) SOURCE: template v[0-9]+\.[0-9]+\.[0-9]+ \([^)]*\) sha256=[0-9a-f]{64}'; then
    echo "✗ $name 缺 SOURCE 標頭或格式不對(第一行:$header)"; fail=1; return
  fi
  embedded_hash="$(echo "$header" | grep -oE 'sha256=[0-9a-f]{64}' | cut -d= -f2)"
  # 本地 hotfix 規則:第 2 行必須是 `// HOTFIX: YYYY-MM-DD <回流去向> <理由>`
  # (Python 檔用 `#`).只有完整且有效的新格式才跳過雜湊;舊格式視同內容被改過,
  # 但額外印出明確的格式錯誤,不悄悄相容成 HOTFIX。
  hotfix_line="$(sed -n '2p' "$dst")"
  hotfix_date=""; hotfix_route=""; hotfix_reason=""; hotfix_invalid=0
  case "$hotfix_line" in
    "// HOTFIX:"*|"# HOTFIX:"*)
      if [[ "$hotfix_line" =~ ^(//|#)[[:space:]]HOTFIX:[[:space:]]([0-9]{4}-[0-9]{2}-[0-9]{2})[[:space:]]([^[:space:]]+)[[:space:]](.+)$ ]]; then
        parsed_date="${BASH_REMATCH[2]}"
        parsed_route="${BASH_REMATCH[3]}"
        parsed_reason="${BASH_REMATCH[4]}"
      else
        parsed_date=""; parsed_route=""; parsed_reason=""
      fi
      if [ -n "$parsed_date" ] \
        && is_valid_hotfix_route "$parsed_route" \
        && [[ "$parsed_reason" =~ [^[:space:]] ]]; then
        hotfix_date="$parsed_date"
        hotfix_route="$parsed_route"
        hotfix_reason="$parsed_reason"
        if hotfix_epoch="$(date -d "$hotfix_date" +%s 2>/dev/null)"; then
          age=$(( ( $(date +%s) - hotfix_epoch ) / 3600 ))
          hotfix_reports+=("$name"$'\t'"$hotfix_date"$'\t'"$hotfix_route"$'\t'"$hotfix_reason"$'\t'"${age}h")
        else
          hotfix_date=""; hotfix_route=""; hotfix_reason=""; hotfix_invalid=1
        fi
      else
        hotfix_invalid=1
      fi
      ;;
  esac
  if [ -n "$hotfix_date" ]; then skip_lines=2; else skip_lines=1; fi
  actual_hash="$(tail -n +$((skip_lines+1)) "$dst" | sha256_stdin)"
  if [ "$hotfix_invalid" = 1 ]; then
    echo "✗ $name HOTFIX 行缺回流去向(格式:\`// HOTFIX: <日期> <回流去向> <理由>\`)"
    fail=1
    return
  fi
  if [ -n "$hotfix_date" ]; then
    if [ "$age" -le 24 ]; then
      echo "⚠ $name 有本地 HOTFIX($hotfix_date,${age}h),24 小時內要回流模板"
      hotfix_n=$(( hotfix_n + 1 ))
    else
      echo "✗ $name 的 HOTFIX($hotfix_date)已超過 24 小時未回流模板"
      fail=1
    fi
    return
  fi
  if [ "$actual_hash" = "$embedded_hash" ]; then
    echo "✓ $name"
    return
  fi
  echo "✗ $name 內容被改過(sha256 不符;急修請在第 2 行加 HOTFIX 註解:<日期> <回流去向> <理由>)"; fail=1
}

# 語言選集是否含 $1(在 LANGS 全域陣列裡找)。
is_lang_selected() {
  local target="$1" l
  for l in "${LANGS[@]}"; do [ "$l" = "$target" ] && return 0; done
  return 1
}

# 受管非守門檔的集合由模板目前的檔案決定,不寫死 skill 數量。發布快照可能沒有 .git,
# 所以有版本庫時取 tracked 集合,沒有版本庫時退回同一受管目錄的 filesystem 集合。
list_managed_template_paths() {
  local root file rel
  if git -C "$TEMPLATE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$TEMPLATE_DIR" ls-files -- \
      '.claude/skills/**' \
      '.agents/skills/**' \
      'docs/templates/TASK.md.template' \
      'scripts/py/.gitignore'
    return
  fi
  for root in .claude/skills .agents/skills; do
    [ -d "$TEMPLATE_DIR/$root" ] || continue
    while IFS= read -r file; do
      rel="${file#"$TEMPLATE_DIR/$root/"}"
      printf '%s/%s\n' "$root" "$rel"
    done < <(find "$TEMPLATE_DIR/$root" -type f -print)
  done
  for rel in docs/templates/TASK.md.template scripts/py/.gitignore; do
    [ -f "$TEMPLATE_DIR/$rel" ] && printf '%s\n' "$rel"
  done
}

# `scripts/py/.gitignore` 跟 Python 守門工具走同一個語言選集;其餘受管檔與語言無關。
collect_managed_paths() {
  local rel
  MANAGED_PATHS=()
  MANAGED_SOURCES=()
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if [ "$rel" = "scripts/py/.gitignore" ] && ! is_lang_selected py; then
      continue
    fi
    [ -f "$TEMPLATE_DIR/$rel" ] || continue
    MANAGED_PATHS+=("$rel")
    MANAGED_SOURCES+=("$TEMPLATE_DIR/$rel")
  done < <(list_managed_template_paths | sort -u)
}

# 讀取與 npx init 相同的 files[].sha256;找不到條目或條目沒有雜湊時返回 1。
manifest_entry_hash() {
  node -e '
    const fs = require("fs");
    try {
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let found = false;
      let value = "";
      for (const entry of manifest.files ?? []) {
        if (entry && entry.path === process.argv[2]) {
          found = true;
          value = typeof entry.sha256 === "string" ? entry.sha256 : "";
        }
      }
      if (!found || !value) process.exit(1);
      process.stdout.write(value);
    } catch (error) {
      process.exit(1);
    }
  ' "$1" "$2"
}

# 與 package/src/cli.mjs 的 INSTALL_MANIFEST schema 對齊;不在這裡驗 manifestSha256,
# 因為 cli.mjs 的 managedPaths 也只信任 files[] 的逐檔雜湊。
manifest_is_valid() {
  node -e '
    const fs = require("fs");
    try {
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const valid = manifest && manifest.manifestVersion === 1
        && typeof manifest.packageVersion === "string"
        && typeof manifest.templateVersion === "string"
        && manifest.source === "VERSION"
        && manifest.generatedBy === "npx init"
        && Array.isArray(manifest.files)
        && manifest.files.every((entry) => entry && typeof entry.path === "string"
          && typeof entry.sha256 === "string");
      process.exit(valid ? 0 : 1);
    } catch (error) {
      process.exit(1);
    }
  ' "$1"
}

# 受管檔衝突先掃後寫。內容等於模板目前版本是 no-op,但仍要求已有 manifest
# 記錄;沒有安裝紀錄的既有檔不能靠「剛好內容一樣」推測 ownership。
prepare_managed() {
  local i rel src dst template_hash current_hash recorded_hash
  MANAGED_HASHES=()
  MANAGED_CONFLICTS=()

  if [ -e "$MANIFEST_PATH" ] && [ ! -f "$MANIFEST_PATH" ]; then
    MANAGED_CONFLICTS+=("$MANIFEST_PATH 已存在但不是檔案,不覆蓋")
    printf '%s\n' "${MANAGED_CONFLICTS[@]}"
    return 1
  fi
  if [ -f "$MANIFEST_PATH" ] && ! manifest_is_valid "$MANIFEST_PATH"; then
    echo "✗ $MANIFEST_PATH 存在但格式不是 npx init 的 manifest,不覆蓋"
    return 1
  fi

  for i in "${!MANAGED_PATHS[@]}"; do
    rel="${MANAGED_PATHS[$i]}"
    src="${MANAGED_SOURCES[$i]}"
    dst="$TARGET/$rel"
    template_hash="$(sha256_file "$src")"
    MANAGED_HASHES+=("$template_hash")
    if [ -e "$dst" ] && [ ! -f "$dst" ]; then
      MANAGED_CONFLICTS+=("$dst 已存在但不是檔案,受管同步不覆蓋")
      continue
    fi
    [ -f "$dst" ] || continue

    current_hash="$(sha256_file "$dst")"
    recorded_hash="$(manifest_entry_hash "$MANIFEST_PATH" "$rel" 2>/dev/null || true)"
    if [ -z "$recorded_hash" ]; then
      MANAGED_CONFLICTS+=("✗ $rel 已存在但沒有 .npx-init-manifest.json 的安裝紀錄(是 consumer 自有檔);不覆蓋")
    elif [ "$current_hash" != "$template_hash" ] && [ "$current_hash" != "$recorded_hash" ]; then
      MANAGED_CONFLICTS+=("✗ $rel 內容被改過(與 .npx-init-manifest.json 記錄不符);不覆蓋")
    fi
  done

  if [ "${#MANAGED_CONFLICTS[@]}" -gt 0 ]; then
    printf '%s\n' "${MANAGED_CONFLICTS[@]}"
    return 1
  fi
}

# 用 Node 寫出與 cli.mjs manifestBody 相同的 JSON,暫存檔 fsync 後再 rename。
# 已存在的 manifest 只更新受管檔的 files[].sha256,保留 npx init 的其他欄位與檔案紀錄。
write_managed_manifest() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const { createHash } = require("crypto");
    const [manifestPath, sourceRoot, packageFile, versionFile, ...managed] = process.argv.slice(1);
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const json = (value) => JSON.stringify(value, null, 2) + "\n";

    let manifest;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } else {
      const packageInfo = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      manifest = {
        manifestVersion: 1,
        packageVersion: packageInfo.version,
        templateVersion: fs.readFileSync(versionFile, "utf8").trim(),
        source: "VERSION",
        generatedBy: "npx init",
        files: [],
        manifestSha256: null,
      };
    }

    const files = Array.isArray(manifest.files) ? manifest.files.map((entry) => ({ ...entry })) : [];
    for (const relative of managed) {
      const digest = hash(fs.readFileSync(path.join(sourceRoot, relative)));
      let index = -1;
      for (let i = 0; i < files.length; i += 1) {
        if (files[i] && files[i].path === relative) index = i;
      }
      if (index >= 0) files[index] = { ...files[index], path: relative, sha256: digest };
      else files.push({ path: relative, sha256: digest });
    }

    const next = { ...manifest, files, manifestSha256: null };
    next.manifestSha256 = hash(json(next));
    const body = json(next);
    let unchanged = false;
    try { unchanged = fs.readFileSync(manifestPath, "utf8") === body; } catch (error) { /* new file */ }
    if (unchanged) {
      console.log(`✓ ${manifestPath}(內容相同,不重寫)`);
      process.exit(0);
    }

    const temporary = `${manifestPath}.sync-${process.pid}-${Date.now()}`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o644);
      fs.writeFileSync(fd, body, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, manifestPath);
      try {
        const directory = fs.openSync(path.dirname(manifestPath), "r");
        fs.fsyncSync(directory);
        fs.closeSync(directory);
      } catch (error) { /* directory fsync is not available on every platform */ }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { /* already renamed */ }
    }
    console.log(`→ ${manifestPath}(manifest)`);
  ' "$MANIFEST_PATH" "$TEMPLATE_DIR" "$TEMPLATE_DIR/package/package.json" \
    "$TEMPLATE_DIR/VERSION" "${MANAGED_PATHS[@]}"
}

sync_managed() {
  local i rel src dst dstdir tmp template_hash current_hash
  for i in "${!MANAGED_PATHS[@]}"; do
    rel="${MANAGED_PATHS[$i]}"
    src="${MANAGED_SOURCES[$i]}"
    dst="$TARGET/$rel"
    template_hash="${MANAGED_HASHES[$i]}"
    if [ -f "$dst" ]; then
      current_hash="$(sha256_file "$dst")"
      if [ "$current_hash" = "$template_hash" ]; then
        echo "✓ $rel(內容相同,不重寫)"
        continue
      fi
    fi
    dstdir="$(dirname "$dst")"
    mkdir -p "$dstdir"
    tmp="$(mktemp "$dstdir/.sync-managed.XXXXXX")"
    cp "$src" "$tmp"
    chmod --reference="$src" "$tmp" 2>/dev/null || true
    mv "$tmp" "$dst"
    echo "→ $rel(受管檔)"
  done
  write_managed_manifest
}

# --check 不讀模板,只以安裝紀錄中的受管檔逐檔驗證,因此可在沒有模板 checkout 的 CI 執行。
check_managed() {
  local rel dst recorded_hash current_hash
  local -a recorded_paths=()
  if [ ! -f "$MANIFEST_PATH" ]; then
    echo "✗ $MANIFEST_PATH 不存在,無法檢查受管檔"
    fail=1
    return
  fi
  if ! manifest_is_valid "$MANIFEST_PATH"; then
    echo "✗ $MANIFEST_PATH 格式不是 npx init 的 manifest"
    fail=1
    return
  fi
  mapfile -t recorded_paths < <(
    node -e '
      const fs = require("fs");
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const managed = (value) => value.startsWith(".claude/skills/")
        || value.startsWith(".agents/skills/")
        || value === "docs/templates/TASK.md.template"
        || value === "scripts/py/.gitignore";
      for (const entry of manifest.files ?? []) {
        if (entry && typeof entry.path === "string" && managed(entry.path)) console.log(entry.path);
      }
    ' "$MANIFEST_PATH" | sort -u
  )
  if [ "${#recorded_paths[@]}" -eq 0 ]; then
    echo "ℹ $MANIFEST_PATH 沒有受管非守門檔紀錄"
    return
  fi
  for rel in "${recorded_paths[@]}"; do
    dst="$TARGET/$rel"
    if [ ! -f "$dst" ]; then
      echo "✗ $rel 缺 $dst"
      fail=1
      continue
    fi
    recorded_hash="$(manifest_entry_hash "$MANIFEST_PATH" "$rel" 2>/dev/null || true)"
    if [ -z "$recorded_hash" ]; then
      echo "✗ $rel manifest 缺少逐檔 sha256"
      fail=1
      continue
    fi
    current_hash="$(sha256_file "$dst")"
    if [ "$current_hash" = "$recorded_hash" ]; then
      echo "✓ $rel"
    else
      echo "✗ $rel 內容被改過(sha256 不符;manifest 記錄不一致)"
      fail=1
    fi
  done
}

# $1 = gates.config.json 路徑 → 有 sync.languages 陣列就把逗號分隔的清單印到 stdout、
# exit 0;沒有這個欄位、檔案不是合法 JSON,或陣列是空的 → exit 1、不印東西。
# 用 node(這整套工具本來就依賴 node/tsx)parse,不額外依賴 jq。
read_sync_languages() {
  node -e '
    try {
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const langs = cfg && cfg.sync && Array.isArray(cfg.sync.languages) ? cfg.sync.languages : null;
      if (langs && langs.length) { process.stdout.write(langs.join(",")); process.exit(0); }
      process.exit(1);
    } catch (e) { process.exit(1); }
  ' "$1" 2>/dev/null
}

# pre-commit hook 的狀態(1.8.0,#12 #17)。設定三個全域變數給兩處提示共用:
#   HOOK_STATE  = installed | declined | absent
#   HOOK_DIR    = git 實際使用的 hooks 目錄(絕對路徑)
#   HOOK_NOTE   = declined 時是 consumer 寫的決定;其餘狀態是「幾個 worktree 共用」的說明
# 為什麼不寫死 `$TARGET/.git/hooks`:【驗】linked worktree 裡 `.git` 是一個檔案不是資料夾,真正的 hooks
# 目錄在主 repo 的 .git/hooks,**所有 worktree 共用同一個**。1.8.0 以前寫死的路徑讓安裝指令在 worktree 裡
# 直接失敗,「有沒有裝」也永遠判成沒裝;而且沒有人告訴使用者「一裝就是全部 worktree 一起生效」。
resolve_hook_state() {
  local hp common gitdir wt_count decision
  hp="$(git -C "$TARGET" rev-parse --git-path hooks 2>/dev/null || echo ".git/hooks")"
  case "$hp" in /*) HOOK_DIR="$hp" ;; *) HOOK_DIR="$(cd "$TARGET" && pwd)/$hp" ;; esac
  # 目標還不是 git repo 時(npx init 刻意不 git init),`git worktree list` 會失敗;在 pipefail + set -e 下
  # 那會讓整支 sync 直接以 128 結束、什麼都不說(1.8.0 發布前 npx 黑箱 gate 抓到)。所以結尾要 `|| true`。
  wt_count="$(git -C "$TARGET" worktree list 2>/dev/null | wc -l | tr -d ' ' || true)"
  [ -n "$wt_count" ] && [ "$wt_count" -ge 1 ] || wt_count=1
  if [ "$wt_count" -gt 1 ]; then
    HOOK_NOTE="這個 repo 有 ${wt_count} 個 worktree,共用同一個 hooks 目錄——裝一次就是全部一起生效"
  else
    HOOK_NOTE="只有一個 worktree"
  fi
  if [ -f "$HOOK_DIR/pre-commit" ] && grep -q "mutate.lock" "$HOOK_DIR/pre-commit" 2>/dev/null; then
    HOOK_STATE="installed"; return
  fi
  # consumer 可以明講「我們決定不裝」:寫 <安裝目錄>/hooks/pre-commit.local.md,第一行非空白的字就是決定。
  # 用 `.local` 命名是沿用 P-85 的慣例——sync 永遠不碰帶 `.local` 的檔。
  # 為什麼要印出決定而不是靜音(#17):靜音的話下一個人看到的是「什麼都沒有」,不會知道這裡曾經有一個決定;
  # 而一行每輪重播的「裝法:cp …」會贏過任何人的記憶——consumer 記了 ADR 決定不裝,worker 照著提示把它
  # 「修好」成 ✓,潛伏四小時後在 main 上擋下協調者的 commit(專案 A 2026-09-12 實例)。
  if [ -f "$DEST/hooks/pre-commit.local.md" ]; then
    decision="$(grep -m1 -vE '^[[:space:]]*$' "$DEST/hooks/pre-commit.local.md" | sed -E 's/^[#[:space:]]+//')"
    HOOK_STATE="declined"; HOOK_NOTE="${decision:-(pre-commit.local.md 是空的,請寫一行理由)}"; return
  fi
  HOOK_STATE="absent"
}

# 自動偵測:$1=consumer 根、$2=本次的安裝目錄(排除,見上面檔頭「語言選集」段的解釋)。
# 找到訊號時把理由寫進全域 PY_SIGNAL_REASON,供選集依據訊息使用。
detect_python_signal() {
  local root="$1" dest="$2" found
  if [ -f "$root/pyproject.toml" ]; then PY_SIGNAL_REASON="找到 pyproject.toml"; return 0; fi
  if [ -f "$root/setup.cfg" ]; then PY_SIGNAL_REASON="找到 setup.cfg"; return 0; fi
  if ls "$root"/requirements*.txt >/dev/null 2>&1; then PY_SIGNAL_REASON="找到 requirements*.txt"; return 0; fi
  # 1.6.9(P-91 第四個實例):偵測的母體必須排除**產物目錄**,否則會依據一份三、四層深的
  # 舊副本做決定。【驗】consumer 實測:偵測命中
  #   .stryker-tmp/sandbox-XXXX/.claude/worktrees/agent-…/template/scripts/py/mutate.py
  # —— 變異沙箱 ▸ 臨時副本 ▸ 7 天前凍結的 worktree ▸ repo 拆分前的舊模板副本,四層;
  # 而該 repo 的 `git ls-files '*.py'` 是空的。於是它裝了兩個沒人需要的 Python 檔。
  # 這一段原本自己列一份排除清單(只有 node_modules 與 .git),沒有用共用的那份——
  # 跟 1.6.3 的 check-doc-rot、1.6.5 的 check-doc-links 同一個病,只是這次重複在 shell 裡。
  # 危害形狀跟 P-95 的「出貨落點」是鏡像:那個是**該送的沒送到**(落在 gitignored 的目錄),
  # 這個是**不該送的送到了**(依據是 gitignored 目錄裡的東西)。兩個都是
  # 「掃描的母體包含了不該包含的層」,只是方向相反。
  local prune_args=() d
  for d in node_modules .git .stryker-tmp dist build out coverage .turbo .cache target \
           __pycache__ .venv venv reports .next .nuxt .svelte-kit .claude/worktrees archive; do
    prune_args+=(-not -path "*/$d/*")
  done
  found="$(find "$root" -name '*.py' "${prune_args[@]}" -not -path "$dest/*" 2>/dev/null | head -1)"
  if [ -n "$found" ]; then PY_SIGNAL_REASON="找到 $found"; return 0; fi
  return 1
}

# 同步完成後清掉「有 SOURCE 標頭、但所屬語言不在本次選集內」的檔案(--prune 專用)。
# 沒有 SOURCE 標頭的檔案一律不碰。
prune_unselected() {
  local prune_langs=(ts py)
  local prune_dirs=("$DEST" "$PY_DEST")
  local i=0 lang dir f
  while [ "$i" -lt "${#prune_langs[@]}" ]; do
    lang="${prune_langs[$i]}"; dir="${prune_dirs[$i]}"
    i=$((i+1))
    if is_lang_selected "$lang"; then continue; fi
    [ -d "$dir" ] || continue
    for f in "$dir"/*; do
      [ -f "$f" ] || continue
      if head -1 "$f" | grep -qE '^(//|#) SOURCE: template v'; then
        echo "− $f(不在本次選集 ${LANGS[*]} 內,已刪除)"
        rm -f "$f"
      fi
    done
    if [ -d "$dir" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
      rmdir "$dir"
      echo "− $dir(清空後已刪除)"
    fi
  done
}

# ## 接線檢查(CHANGELOG 1.4.0)
#
# 同步進來的 check-*.ts 只是「檔案存在」,不代表有人真的會跑它——沒有任何 npm script
# 呼叫到它的檔名,就是裝了但沒接線的死碼,直到哪天有人手動 `npx tsx` 才會被發現(或永遠
# 不會被發現)。`--check` 因此額外檢查:package.json 的 `scripts` 底下,是不是有某個值
# 提到這支檔案的檔名(字串包含即可,不要求精確等於某個慣例)。
#
# 三種豁免,不算「沒接線」:
#   1. `_root.ts`——共用 helper,本來就不會被 npm script 直接呼叫。
#   2. `*.test.ts`(跟著 `check-*.ts` 這個 glob 一起同步進來的測試檔,例如
#      `check-boundaries.test.ts`)——它們跑在 vitest 裡,是被測試框架的 include glob
#      找到,不是被 package.json 的某個 script 用檔名呼叫,天生不需要接線。
#   3. `check-all.ts`——只有在 consumer 的 `gates.config.json` 已經填了非空的 `chain`
#      才豁免(它是靠 chain 被間接呼叫);沒填 chain 的話它自己都跑不起來(見
#      check-all.ts 的「0 目標」規則),接不接線是次要問題,但這裡還是照樣要求接線,
#      沒填 chain 又沒接線一樣紅——這樣「裝了 check-all.ts 但既沒設定也沒接線」不會被
#      誤判成「反正 check-all 本來就會自己紅,不用管接線」。
#
# 明講的豁免:consumer 的 `gates.config.json` 可以加 `"unwired": [{ "file": "...",
# "reason": "..." }]`,理由是「這支我們刻意不接線」——但 `reason` 一定要非空字串,
# 沒填 reason 的 allowlist 條目算它自己壞掉(不是「這條允許成立」),一樣紅。

# $1=檔名(base) → 0 = 依三種內建規則之一豁免、不用檢查接線;1 = 要照走接線檢查。
is_wiring_exempt_by_default() {
  local base="$1"
  [ "$base" = "_root.ts" ] && return 0
  # 靠 package.json 的 mutate script 接線,不是 check: gate。
  [ "$base" = "mutate-with-lock.ts" ] && return 0
  case "$base" in
    *.test.ts) return 0 ;;
  esac
  return 1
}

# $1=gates.config.json 路徑 → exit 0 代表已經有非空的 "chain" 陣列(check-all.ts 因此豁免接線)。
has_chain_configured() {
  local cfg="$1"
  [ -f "$cfg" ] || return 1
  node -e '
    try {
      const fs = require("fs");
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(Array.isArray(c.chain) && c.chain.length ? 0 : 1);
    } catch (e) { process.exit(1); }
  ' "$cfg" 2>/dev/null
}

# $1=gates.config.json 路徑 → 逐行印 "檔名<TAB>理由"(理由可能是空字串,代表這條
# allowlist 本身不合法,呼叫端要把它當失敗處理,不是當「豁免成立」)。檔案不存在或
# 沒有 "unwired" 欄位就什麼都不印。
read_unwired_list() {
  local cfg="$1"
  [ -f "$cfg" ] || return 0
  node -e '
    try {
      const fs = require("fs");
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const list = Array.isArray(c.unwired) ? c.unwired : [];
      for (const e of list) {
        const file = e && typeof e.file === "string" ? e.file : "";
        const reason = e && typeof e.reason === "string" ? e.reason : "";
        if (file) process.stdout.write(file + "\t" + reason + "\n");
      }
    } catch (e) { /* 壞掉的 gates.config.json 交給讀它的人報,這裡不重複報同一個錯 */ }
  ' "$cfg" 2>/dev/null
}

# $1=package.json 路徑、$2=檔名 → exit 0 代表 scripts 底下有某個值提到這個檔名。
is_wired_in_package_json() {
  local pkg="$1" base="$2"
  [ -f "$pkg" ] || return 1
  node -e '
    try {
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      const base = process.argv[2];
      const hit = Object.values(scripts).some((v) => typeof v === "string" && v.includes(base));
      process.exit(hit ? 0 : 1);
    } catch (e) { process.exit(1); }
  ' "$pkg" "$base"
}

if [ "$MODE" = "--check" ]; then
  # --check 是自包含的:不讀 $TEMPLATE_DIR,只讀已經裝好的那份檔案本身;不需要語言選集。
  check_managed
  is_config_file() {
    local base="$1" c
    for c in "${CONFIG_FILES[@]}"; do [ "$base" = "$c" ] && return 0; done
    return 1
  }
  for dst in "$DEST"/* "$PY_DEST"/*; do
    [ -f "$dst" ] || continue
    base="$(basename "$dst")"
    is_config_file "$base" && continue
    header="$(sed -n '1p' "$dst")"
    if echo "$header" | grep -qE '^(//|#) SOURCE: template v'; then
      n=$((n+1))
      check_one "$base" "$dst"
    else
      [ "$VERBOSE" = 1 ] && echo "○ $base(非模板檔,略過)"
    fi
  done
  for cfg in "${CONFIG_FILES[@]}"; do echo "○ $cfg(你的設定檔,不比對)"; done

  # pre-commit hook 有沒有裝(S12,模板 1.4.1)——只是資訊性的一行,不算失敗:
  # git hooks 天生不受版本控制,裝不裝是每個開發者自己的選擇,`--check` 只負責提醒,
  # 不能因為沒裝就讓整個 --check 變紅。用「檔案第一行含 mutate.lock 這個字串」判斷
  # 是不是這支模板的 hook(跟其餘檔案用 SOURCE 標頭判斷「是不是模板裝的」同一個道理,
  # 只是 pre-commit 這個檔案本身**不能**有 SOURCE 標頭——那會把 shebang 往下推一行,
  # git 執行 hook 時會找不到直譯器,見 scripts/hooks/pre-commit 檔頭說明)。
  resolve_hook_state
  case "$HOOK_STATE" in
    installed) echo "✓ pre-commit hook 已安裝($HOOK_DIR;$HOOK_NOTE)" ;;
    declined)  echo "○ pre-commit hook 未安裝(consumer 決定:$HOOK_NOTE)" ;;
    *)         echo "○ pre-commit hook 未安裝(選用;$HOOK_NOTE。它只擋會直接改工作區的變異測試——模板的 mutate.py、inPlace: true 的 Stryker;沙箱模式不需要它。決定不裝就寫一行理由到 $SUBDIR/hooks/pre-commit.local.md,這行會改印你的決定。裝法:cp $SUBDIR/hooks/pre-commit $HOOK_DIR/pre-commit && chmod +x $HOOK_DIR/pre-commit)" ;;
  esac

  # 接線檢查(見上面「## 接線檢查」的說明)。只管 $DEST 底下的 .ts(py 工具不是靠
  # package.json 的 scripts 呼叫,不在這個檢查範圍內)。
  gates_cfg="$DEST/gates.config.json"
  unwired_raw="$(read_unwired_list "$gates_cfg" || true)"
  for dst in "$DEST"/*.ts; do
    [ -f "$dst" ] || continue
    base="$(basename "$dst")"
    header="$(sed -n '1p' "$dst")"
    echo "$header" | grep -qE '^// SOURCE: template v' || continue   # 非模板檔,接不接線不歸這支腳本管
    if is_wiring_exempt_by_default "$base"; then
      echo "○ $base(不需接線:helper 或測試檔)"
      continue
    fi
    if [ "$base" = "check-all.ts" ] && has_chain_configured "$gates_cfg"; then
      echo "○ $base(不需接線:gates.config.json 已設定 chain)"
      continue
    fi
    allow_hit=0; allow_reason=""
    if [ -n "$unwired_raw" ]; then
      while IFS=$'\t' read -r ufile ureason; do
        [ "$ufile" = "$base" ] || continue
        allow_hit=1; allow_reason="$ureason"
      done <<< "$unwired_raw"
    fi
    if [ "$allow_hit" = 1 ]; then
      if [ -z "$allow_reason" ]; then
        echo "✗ gates.config.json 的 unwired 允許 $base,但沒填 reason(允許清單條目本身不合法)"
        fail=1
      else
        echo "○ $base(允許清單:$allow_reason)"
      fi
      continue
    fi
    if is_wired_in_package_json "$TARGET/package.json" "$base"; then
      echo "✓ $base 已接線"
    else
      echo "✗ $base 同步進來但沒接線:package.json 沒有任何 script 呼叫它"
      fail=1
    fi
  done
else
  # sync(非 --check)才需要 $TEMPLATE_DIR 的 VERSION 與 commit,拿新內容寫進去。
  mkdir -p "$DEST"
  VERSION="$(cat "$TEMPLATE_DIR/VERSION")"
  COMMIT="$(git -C "$TEMPLATE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  # 語言選集(CHANGELOG 1.3.4 (1)):--lang 旗標 > 目標的 gates.config.json 的
  # sync.languages > 自動偵測。ts 永遠在集合裡。
  declare -a LANGS=()
  LANGS_BASIS=""
  if [ -n "$LANG_FLAG" ]; then
    IFS=',' read -ra LANGS <<< "$LANG_FLAG"
    LANGS_BASIS="--lang 旗標"
  else
    CONFIG_LANGS=""
    CONFIG_PATH=""
    for cand in "$DEST/gates.config.json" "$TARGET/scripts/gates.config.json"; do
      if [ -f "$cand" ]; then
        val="$(read_sync_languages "$cand" || true)"
        if [ -n "$val" ]; then CONFIG_LANGS="$val"; CONFIG_PATH="$cand"; break; fi
      fi
    done
    if [ -n "$CONFIG_LANGS" ]; then
      IFS=',' read -ra LANGS <<< "$CONFIG_LANGS"
      LANGS_BASIS="設定檔 $CONFIG_PATH 的 sync.languages"
    else
      PY_SIGNAL_REASON=""
      if detect_python_signal "$TARGET" "$DEST"; then
        LANGS=(ts py)
        LANGS_BASIS="自動偵測:找到 Python 跡象($PY_SIGNAL_REASON)"
      else
        LANGS=(ts)
        LANGS_BASIS="自動偵測:無 Python"
      fi
    fi
  fi
  # 去空白項、永遠含 ts。
  trimmed=()
  for l in "${LANGS[@]}"; do
    l="$(echo "$l" | tr -d '[:space:]')"
    [ -n "$l" ] && trimmed+=("$l")
  done
  LANGS=("${trimmed[@]}")
  has_ts=0
  for l in "${LANGS[@]}"; do [ "$l" = "ts" ] && has_ts=1; done
  [ "$has_ts" = 1 ] || LANGS=(ts "${LANGS[@]}")
  echo "選集 $(IFS=,; echo "${LANGS[*]}")(${LANGS_BASIS})"

  collect_managed_paths
  if ! prepare_managed; then
    exit 1
  fi

  # 先掃後寫(CHANGELOG 1.5.0,P-85):寫任何檔之前,先對本次選集的每一支來源檔,
  # 算出目的檔路徑,檢查「已存在且第一行不是 SOURCE 標頭」——那代表 consumer 自己
  # 寫了同名的檔案,不是模板裝的。任一命中就列出全部命中,exit 1,一個檔都不寫。
  conflicts=()
  for src in "$TEMPLATE_DIR"/scripts/_root.ts "$TEMPLATE_DIR"/scripts/check-*.ts "$TEMPLATE_DIR"/scripts/mutate-with-lock.ts; do
    name="$(basename "$src")"; dst="$DEST/$name"
    if [ -f "$dst" ] && ! head -1 "$dst" | grep -qE '^(//|#) SOURCE: template v'; then
      conflicts+=("$dst")
    fi
  done
  if is_lang_selected py; then
    for src in "$TEMPLATE_DIR"/scripts/py/*.py; do
      name="$(basename "$src")"; dst="$PY_DEST/$name"
      if [ -f "$dst" ] && ! head -1 "$dst" | grep -qE '^(//|#) SOURCE: template v'; then
        conflicts+=("$dst")
      fi
    done
  fi
  if [ "${#conflicts[@]}" -gt 0 ]; then
    for dst in "${conflicts[@]}"; do
      echo "✗ $dst 已存在且沒有 SOURCE 標頭(是你們自己的檔);請改名(例如 <base>.local.<ext>)或刪掉後重跑,sync 不會蓋掉它"
    done
    exit 1
  fi

  for src in "$TEMPLATE_DIR"/scripts/_root.ts "$TEMPLATE_DIR"/scripts/check-*.ts "$TEMPLATE_DIR"/scripts/mutate-with-lock.ts; do
    sync_one "$src" "//" "$DEST"
  done
  if is_lang_selected py; then
    for src in "$TEMPLATE_DIR"/scripts/py/*.py; do
      sync_one "$src" "#" "$PY_DEST"
    done
  fi

  sync_managed

  if [ "$PRUNE" = 1 ]; then
    prune_unselected
  fi

  # pre-commit hook 本身(S12,模板 1.4.1)——同步進消費者的安裝目錄底下的 hooks/
  # 子資料夾(每次同步都覆蓋,程式碼不是設定),但**不**自動裝進 `.git/hooks/`:
  # git hooks 不受版本控制,自動覆寫別人手上已經裝好的 hook 比不裝更危險。這個檔案
  # 刻意**不**插入 SOURCE 標頭(跟其餘 .ts/.py 不同)——它必須能被 git 直接執行,
  # shebang 一定要留在第一行,插標頭會把 shebang 往下推一行讓 git 找不到直譯器。
  if [ -f "$TEMPLATE_DIR/scripts/hooks/pre-commit" ]; then
    mkdir -p "$DEST/hooks"
    cp "$TEMPLATE_DIR/scripts/hooks/pre-commit" "$DEST/hooks/pre-commit"
    chmod +x "$DEST/hooks/pre-commit"
    echo "→ $DEST/hooks/pre-commit"
  fi

  # needs-config 清單(CHANGELOG 1.4.0)要記「複製設定檔之前,consumer 原本就沒有這份
  # 設定」——複製動作本身會把 boundaries.owners.json / gates.config.json 從無變有
  # (放模板的佔位範例進去),如果在複製之後才判斷存在與否,永遠測不出「這是這次同步才
  # 生出來的佔位檔」。standalone.json 不屬於 CONFIG_FILES(不是模板的一部分,見這支
  # 腳本檔頭「程式與設定分開」段),沒有任何步驟會建立它,純粹檢查存在與否。
  needs_config=()
  [ -f "$DEST/boundaries.owners.json" ] || needs_config+=(boundaries.owners.json)
  [ -f "$TARGET/standalone.json" ] || needs_config+=(standalone.json)
  [ -f "$DEST/gates.config.json" ] || needs_config+=(gates.config.json)

  for cfg in "${CONFIG_FILES[@]}"; do
    if [ ! -f "$DEST/$cfg" ]; then
      cp "$TEMPLATE_DIR/scripts/$cfg" "$DEST/"; echo "→ $DEST/$cfg(新建)"
    fi
  done

  # 接線建議(CHANGELOG 1.4.0):列出這次同步進來、目前沒有任何 npm script 呼叫的
  # check-*.ts,印出建議加進 package.json 的那一行——只印,不動 package.json(那是
  # consumer 自己的檔案,見這支腳本檔頭的分工原則)。
  suggest_lines=()
  for src in "$TEMPLATE_DIR"/scripts/_root.ts "$TEMPLATE_DIR"/scripts/check-*.ts; do
    base="$(basename "$src")"
    is_wiring_exempt_by_default "$base" && continue
    if [ "$base" = "check-all.ts" ] && has_chain_configured "$DEST/gates.config.json"; then continue; fi
    is_wired_in_package_json "$TARGET/package.json" "$base" && continue
    slug="${base#check-}"; slug="${slug%.ts}"
    suggest_lines+=("  \"check:${slug}\": \"tsx scripts/${base}\"")
  done
  if [ "${#suggest_lines[@]}" -gt 0 ]; then
    echo
    echo "建議加進 package.json 的 \"scripts\"(不會自動改,那是你的檔案):"
    printf '%s\n' "${suggest_lines[@]}"
  fi
  if is_wiring_exempt_by_default "mutate-with-lock.ts"; then
    echo "○ mutate-with-lock.ts(不需接線:靠 package.json 的 mutate script 接線,不是 check: gate)"
  fi

  if [ "${#needs_config[@]}" -gt 0 ]; then
    echo
    echo "needs-config: $(IFS=,; echo "${needs_config[*]}")(剛建立或原本就沒有,填好之前對應的 gate 會紅,不是壞了)"
  fi

  # S12(模板 1.4.1):提示怎麼裝 pre-commit hook——只印,不自動裝(理由見上面複製
  # 那一段)。已經裝過(.git/hooks/pre-commit 含 mutate.lock 這個字串)就不用再提醒。
  if [ -f "$TEMPLATE_DIR/scripts/hooks/pre-commit" ]; then
    resolve_hook_state
    if [ "$HOOK_STATE" = "absent" ]; then
      echo
      echo "hook(選用,未安裝):$HOOK_NOTE。它只擋會直接改工作區的變異測試(mutate.py、inPlace: true 的 Stryker)。"
      echo "  要裝:cp $SUBDIR/hooks/pre-commit $HOOK_DIR/pre-commit && chmod +x $HOOK_DIR/pre-commit"
      echo "  不裝:寫一行理由到 $SUBDIR/hooks/pre-commit.local.md(之後 --check 會印你的決定,不再提示安裝)"
    elif [ "$HOOK_STATE" = "declined" ]; then
      echo
      echo "hook:consumer 決定不裝($HOOK_NOTE)"
    fi
  fi
fi

[ "$n" -gt 0 ] || { echo "掃到 0 支守門,這不是很乾淨,是腳本壞了"; exit 1; }
if [ "$MODE" = "--check" ]; then
  # 1.6.5(P-93):有 HOTFIX 時不准印「未被更動」——那句會跟上面的 ⚠ 行直接矛盾,
  # 而摘要行的功能就是「讓人不必讀全部」,所以它必須自己就是對的。
  # 【驗】consumer 用 `tail -8` 只看到這行的 ✓,據此下了「check:gates 沒有比對 _root.ts」
  # 的錯誤結論,還從那個結論反推了一個不存在的機制。
  if [ "$fail" != 0 ]; then
    exit_code=1
  elif [ "${hotfix_n:-0}" -gt 0 ]; then
    echo "⚠ 守門內容有 ${hotfix_n} 處本地 HOTFIX(見上),其餘自同步以來未被更動"
    exit_code=0
  else
    echo "✓ 守門內容自同步以來未被更動"
    exit_code=0
  fi
  print_hotfix_report
  exit "$exit_code"
else
  if is_lang_selected py; then py_note="含 $PY_DEST 底下的 Python 版工具;"; else py_note=""; fi
  echo "已同步 $n 支守門到 $DEST(${py_note}template v${VERSION} ${COMMIT});目標 repo 的規則入口記「採用模板 v${VERSION}」"
fi
