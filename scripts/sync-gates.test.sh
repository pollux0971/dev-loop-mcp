#!/usr/bin/env bash
# sync-gates.sh 的接線檢查(CHANGELOG 1.4.0)測試。template/scripts/ 底下沒有既有的
# bash 測試框架,所以這是一支獨立可執行的小測試腳本,跟消費者專案裡 `*.test.ts` 用
# vitest 的角色一樣——造一次性的假 consumer(git init + package.json),同步進去,
# 斷言 `--check` 的接線檢查行為;不碰真的 repo。
#
# 用法:bash template/scripts/sync-gates.test.sh
# 退出碼:0 全部斷言通過;1 任一斷言失敗(印出失敗的斷言與實際輸出)。
set -uo pipefail

TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC_GATES="$TEMPLATE_DIR/scripts/sync-gates.sh"

FAILURES=0
CONSUMER=""
CONSUMER2=""
HOTFIX_NEW_CONSUMER=""
HOTFIX_OLD_CONSUMER=""
HOTFIX_LIST_CONSUMER=""
HOTFIX_ROUTE_CONSUMER=""
HOTFIX_VALID_ROUTE_CONSUMER=""

cleanup() {
  [ -n "$CONSUMER" ] && [ -d "$CONSUMER" ] && rm -rf "$CONSUMER"
  [ -n "$CONSUMER2" ] && [ -d "$CONSUMER2" ] && rm -rf "$CONSUMER2"
  [ -n "$HOTFIX_NEW_CONSUMER" ] && [ -d "$HOTFIX_NEW_CONSUMER" ] && rm -rf "$HOTFIX_NEW_CONSUMER"
  [ -n "$HOTFIX_OLD_CONSUMER" ] && [ -d "$HOTFIX_OLD_CONSUMER" ] && rm -rf "$HOTFIX_OLD_CONSUMER"
  [ -n "$HOTFIX_LIST_CONSUMER" ] && [ -d "$HOTFIX_LIST_CONSUMER" ] && rm -rf "$HOTFIX_LIST_CONSUMER"
  [ -n "$HOTFIX_ROUTE_CONSUMER" ] && [ -d "$HOTFIX_ROUTE_CONSUMER" ] && rm -rf "$HOTFIX_ROUTE_CONSUMER"
  [ -n "$HOTFIX_VALID_ROUTE_CONSUMER" ] && [ -d "$HOTFIX_VALID_ROUTE_CONSUMER" ] && rm -rf "$HOTFIX_VALID_ROUTE_CONSUMER"
}
trap cleanup EXIT

fail() {
  FAILURES=$((FAILURES + 1))
  echo "✗ FAIL: $1"
}

pass() {
  echo "✓ pass: $1"
}

# $1=描述、$2=實際文字、$3=要包含的子字串
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    pass "$desc"
  else
    fail "$desc(輸出裡沒有找到:$needle)"
    echo "--- 實際輸出 ---"
    echo "$haystack"
    echo "--- 輸出結束 ---"
  fi
}

# $1=描述、$2=實際文字、$3=不該出現的子字串
assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    fail "$desc(輸出裡不該出現:$needle)"
  else
    pass "$desc"
  fi
}

# $1=描述、$2=實際退出碼、$3=預期退出碼
assert_exit_code() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$desc(exit $actual)"
  else
    fail "$desc(預期 exit $expected,實際 $actual)"
  fi
}

# $1=描述、$2=實際值、$3=預期值(泛用字串相等,不假設是 exit code——用來比對 sha256 之類)
assert_eq() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc(預期 $expected,實際 $actual)"
  fi
}

contains_text() {
  case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

# 建立一個所有同步進來的 check-*.ts 都已接線的假 consumer,讓 HOTFIX fixture 的
# --check 退出碼只反映 HOTFIX 行為,不被接線檢查的既有紅燈干擾。
make_hotfix_consumer() {
  local dest
  dest="$(mktemp -d)"
  (
    cd "$dest"
    git init -q
    git config user.email "sync-gates-hotfix-test@example.com"
    git config user.name "sync-gates-hotfix-test"
  )
  cp "$TEMPLATE_DIR/package.json" "$dest/package.json"
  "$SYNC_GATES" "$dest" scripts >/dev/null 2>&1 || return 1
  echo "$dest"
}

# 在已同步的檔案第 2 行放 HOTFIX,再在檔身插入一行變更,確保會走 HOTFIX
# 判斷分支而不是因為雜湊相同直接顯示「未被更動」。
add_hotfix_fixture() {
  local file="$1" hotfix_line="$2"
  sed -i "2i\\$hotfix_line" "$file"
  sed -i '3i// HOTFIX fixture body change' "$file"
}

# $1=檔案路徑 → sha256(用來斷言「這個檔案完全沒被動過」)
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

CONSUMER="$(mktemp -d)"
(
  cd "$CONSUMER"
  git init -q
  git config user.email "sync-gates-test@example.com"
  git config user.name "sync-gates-test"
  git config commit.gpgsign false
)

cat > "$CONSUMER/package.json" <<'EOF'
{
  "name": "fake-consumer",
  "private": true,
  "scripts": {
    "test": "echo no-op"
  }
}
EOF

echo "== 步驟 1:plain sync,建立 scripts/ 與佔位設定檔 =="
sync_out="$("$SYNC_GATES" "$CONSUMER" 2>&1)"
sync_code=$?
assert_exit_code "plain sync 本身要成功" "$sync_code" "0"
assert_contains "plain sync 印出 needs-config 清單(consumer 一開始什麼設定都沒有)" "$sync_out" "needs-config:"
assert_contains "plain sync 建議接線 check-boundaries.ts" "$sync_out" "check:boundaries"

echo
echo "== 步驟 2:--check,check-boundaries.ts 還沒接線 → 要紅 =="
check_out_1="$("$SYNC_GATES" "$CONSUMER" scripts --check 2>&1)"
check_code_1=$?
assert_exit_code "沒接線時 --check 要失敗" "$check_code_1" "1"
assert_contains "訊息明講 check-boundaries.ts 同步進來但沒接線" "$check_out_1" "✗ check-boundaries.ts 同步進來但沒接線"

echo
echo "== 步驟 3:package.json 加一行呼叫 check-boundaries.ts,重跑 --check → 那一項要轉綠 =="
cat > "$CONSUMER/package.json" <<'EOF'
{
  "name": "fake-consumer",
  "private": true,
  "scripts": {
    "test": "echo no-op",
    "boundaries": "tsx scripts/check-boundaries.ts"
  }
}
EOF
check_out_2="$("$SYNC_GATES" "$CONSUMER" scripts --check 2>&1)"
assert_contains "接上線之後 check-boundaries.ts 顯示已接線" "$check_out_2" "✓ check-boundaries.ts 已接線"
assert_not_contains "check-boundaries.ts 不再出現沒接線的訊息" "$check_out_2" "✗ check-boundaries.ts 同步進來但沒接線"

echo
echo "== 步驟 4:改用 unwired allowlist,但不填 reason → allowlist 條目本身要判失敗 =="
cat > "$CONSUMER/package.json" <<'EOF'
{
  "name": "fake-consumer",
  "private": true,
  "scripts": {
    "test": "echo no-op"
  }
}
EOF
cat > "$CONSUMER/scripts/gates.config.json" <<'EOF'
{
  "unwired": [
    { "file": "check-boundaries.ts" }
  ]
}
EOF
check_out_3="$("$SYNC_GATES" "$CONSUMER" scripts --check 2>&1)"
check_code_3=$?
assert_exit_code "沒填 reason 的 unwired 條目要讓整體 --check 失敗" "$check_code_3" "1"
assert_contains "訊息明講 allowlist 條目本身不合法(缺 reason)" "$check_out_3" "但沒填 reason"

echo
echo "== 步驟 5:補上 reason → 那個 allowlist 條目要轉綠(不再是「沒接線」的紅) =="
cat > "$CONSUMER/scripts/gates.config.json" <<'EOF'
{
  "unwired": [
    { "file": "check-boundaries.ts", "reason": "這個 consumer 只用 check-all 的 chain,不逐條接線" }
  ]
}
EOF
check_out_4="$("$SYNC_GATES" "$CONSUMER" scripts --check 2>&1)"
assert_contains "補上 reason 之後印允許清單那一行" "$check_out_4" "○ check-boundaries.ts(允許清單:"
assert_not_contains "不再出現沒接線的訊息" "$check_out_4" "✗ check-boundaries.ts 同步進來但沒接線"
assert_not_contains "也不再出現「缺 reason」的訊息" "$check_out_4" "但沒填 reason"

echo
echo "== 步驟 6:--check 本身仍然是自包含的(不需要模板路徑),用不存在的路徑騙 PATH 也要能跑 =="
# 只驗證 --check 這個分支不會嘗試讀 $TEMPLATE_DIR 以外、consumer 裝好的檔案之外的任何東西——
# 這裡簡化驗證:確認上一步驟的 --check 輸出裡沒有任何提到 $TEMPLATE_DIR 路徑本身的行
# (它只應該印 consumer 端的相對檔名)。
assert_not_contains "--check 輸出不洩漏模板路徑" "$check_out_4" "$TEMPLATE_DIR"

echo
echo "== 步驟 7:S12 pre-commit hook 同步進 hooks/ 子目錄,但不自動裝進 .git/hooks/ =="
HOOK_SYNCED="$CONSUMER/scripts/hooks/pre-commit"
if [ -f "$HOOK_SYNCED" ]; then
  pass "同步後 scripts/hooks/pre-commit 存在"
else
  fail "同步後 scripts/hooks/pre-commit 不存在"
fi
if [ -x "$HOOK_SYNCED" ]; then
  pass "同步後 scripts/hooks/pre-commit 可執行"
else
  fail "同步後 scripts/hooks/pre-commit 不可執行"
fi
if [ -f "$CONSUMER/.git/hooks/pre-commit" ]; then
  fail "sync 不該自動把 hook 裝進 .git/hooks/(那是使用者自己的選擇)"
else
  pass "sync 沒有自動把 hook 裝進 .git/hooks/"
fi
assert_contains "plain sync 印出手動安裝 hook 的指令(1.8.0 起指向 git 實際的 hooks 目錄)" "$sync_out" "要裝:cp scripts/hooks/pre-commit "
assert_contains "plain sync 的 hook 提示指到 .git/hooks/pre-commit" "$sync_out" ".git/hooks/pre-commit && chmod +x"
assert_contains "plain sync 的 hook 提示同時告訴 consumer 怎麼表達「決定不裝」(#17)" "$sync_out" "不裝:寫一行理由到 scripts/hooks/pre-commit.local.md"
assert_contains "--check 印出 pre-commit hook 未安裝(資訊性,不算失敗)" "$check_out_4" "○ pre-commit hook 未安裝"

echo
echo "== 步驟 8:pre-commit hook 本身的行為(檔案鎖,live pid 擋、無鎖放行) =="
# hook 內部用 `git rev-parse --show-toplevel` 找 repo 根,cwd 一定要在 $CONSUMER 底下
# 才會找到 $CONSUMER(不是 sync-gates.test.sh 自己執行時的 cwd)。
if (cd "$CONSUMER" && bash "$HOOK_SYNCED" >/dev/null 2>&1); then
  pass "沒有任何鎖檔時 hook 允許 commit(exit 0)"
else
  fail "沒有任何鎖檔時 hook 應該允許 commit(exit 0)"
fi

printf '{"pid": %s, "file": "x.ts", "started_at": "2026-01-01T00:00:00Z", "cmd": "test"}' "$$" > "$CONSUMER/.mutate.lock"
hook_out="$(cd "$CONSUMER" && bash "$HOOK_SYNCED" 2>&1)"
hook_code=$?
rm -f "$CONSUMER/.mutate.lock"
assert_exit_code "own pid(保證活著)的 .mutate.lock 存在時 hook 拒絕 commit" "$hook_code" "1"
assert_contains "hook 訊息講清楚是哪個鎖檔跟 pid" "$hook_out" ".mutate.lock"

echo
echo "== 步驟 9(CHANGELOG 1.5.0,P-85):sync 拒絕蓋掉 consumer 自己的無標頭檔 =="
# 用一個乾淨的第二個假 consumer,跟上面 8 個步驟共用的 $CONSUMER 隔開——這裡要驗證的是
# 「目的檔已經存在」這件事本身,不想跟前面步驟裝好的一堆有標頭的檔案糾纏。

CONSUMER2="$(mktemp -d)"
(
  cd "$CONSUMER2"
  git init -q
  git config user.email "sync-gates-test@example.com"
  git config user.name "sync-gates-test"
  git config commit.gpgsign false
)
cat > "$CONSUMER2/package.json" <<'EOF'
{
  "name": "fake-consumer-2",
  "private": true,
  "scripts": {
    "test": "echo no-op"
  }
}
EOF

echo
echo "-- 9a:consumer 自己先放一支無標頭的 check-boundaries.test.ts,sync 要整批拒絕 --"
mkdir -p "$CONSUMER2/scripts"
own_file="$CONSUMER2/scripts/check-boundaries.test.ts"
cat > "$own_file" <<'EOF'
// 這是 consumer 自己寫的測試,不是模板同步進來的,沒有 SOURCE 標頭
describe("placeholder", () => {});
EOF
own_hash_before="$(sha256_of "$own_file")"

sync9a_out="$("$SYNC_GATES" "$CONSUMER2" 2>&1)"
sync9a_code=$?
assert_exit_code "已有無標頭同名檔時,sync 要整批拒絕" "$sync9a_code" "1"
assert_contains "訊息含衝突檔名 check-boundaries.test.ts" "$sync9a_out" "check-boundaries.test.ts"
assert_contains "訊息講清楚沒有 SOURCE 標頭" "$sync9a_out" "沒有 SOURCE 標頭"

own_hash_after="$(sha256_of "$own_file")"
assert_eq "consumer 自己的檔案內容原封不動(sha256 相同)" "$own_hash_after" "$own_hash_before"
if [ -f "$CONSUMER2/scripts/_root.ts" ]; then
  fail "拒絕時應該一個檔都不寫,但 _root.ts 出現了"
else
  pass "拒絕時一個檔都沒寫:_root.ts 不存在"
fi

echo
echo "-- 9b:改名為 .local.test.ts 後重跑,sync 要放行,且 .local 檔不被動 --"
local_file="$CONSUMER2/scripts/check-boundaries.local.test.ts"
mv "$own_file" "$local_file"
local_hash_before="$(sha256_of "$local_file")"

sync9b_out="$("$SYNC_GATES" "$CONSUMER2" 2>&1)"
sync9b_code=$?
assert_exit_code "改名成 .local.test.ts 後 sync 要放行" "$sync9b_code" "0"

if [ -f "$local_file" ]; then
  pass ".local 檔仍然存在"
else
  fail ".local 檔不見了"
fi
local_hash_after="$(sha256_of "$local_file")"
assert_eq ".local 檔內容不被動(sha256 相同)" "$local_hash_after" "$local_hash_before"

echo
echo "-- 9c:已有 SOURCE 標頭的舊版同名檔,sync 要照舊覆蓋(回歸,不受先掃後寫影響) --"
current_version="$(cat "$TEMPLATE_DIR/VERSION")"
target_file="$CONSUMER2/scripts/check-boundaries.test.ts"
if [ -f "$target_file" ]; then
  pass "9b 的 sync 已經把 check-boundaries.test.ts 同步進來(帶 SOURCE 標頭)"
else
  fail "9b 之後 check-boundaries.test.ts 應該已經存在"
fi
version_escaped="${current_version//./\\.}"
sed -i "1s/template v${version_escaped}/template v0.0.1/" "$target_file"
assert_contains "改版本號後第一行變成舊版標頭" "$(sed -n '1p' "$target_file")" "template v0.0.1"

sync9c_out="$("$SYNC_GATES" "$CONSUMER2" 2>&1)"
sync9c_code=$?
assert_exit_code "有 SOURCE 標頭的舊版同名檔,sync 要照舊覆蓋成功" "$sync9c_code" "0"
assert_contains "覆蓋後第一行變回目前版本的標頭" "$(sed -n '1p' "$target_file")" "template v${current_version}"
assert_not_contains "舊版標頭字串不再出現" "$(sed -n '1p' "$target_file")" "v0.0.1"

local_hash_final="$(sha256_of "$local_file")"
assert_eq ".local 檔在整個步驟 9 期間內容都不變" "$local_hash_final" "$local_hash_before"

echo "== 步驟 10(1.6.6,P-94):假 consumer 想擴充——裝完之後能不能加一支自己的東西? =="
# 來源:專案 A 協調者 2026-09-12。他問的不是「要不要設計一套 consumer 身分的驗收」,
# 而是「**`sync-gates.test.sh` 的假 consumer,為什麼從來不試著擴充?**」
# 步驟 1~9 驗的都是「裝得對不對」,沒有一項驗「裝完之後我能不能加自己的東西」。
# 那個缺口的代價:他們的 worker 想加一支需要設定的 gate,第一直覺是去手改模板的
# `_root.ts`(並留一條 HOTFIX)——而正確做法(自帶設定檔)模板裡早就有先例,
# 只是**存在但沒有被指出來**。

# (a) 往 gates.config.json 加一個自己的頂層鍵 → 必須紅,而且訊息要**指出正確的路**
printf '{\n  "myOwnGate": { "x": 1 }\n}\n' > "$CONSUMER/scripts/gates.config.json"
ext_out="$(cd "$CONSUMER" && npx tsx scripts/check-known-defects.ts 2>&1 || true)"
assert_contains "consumer 自己的頂層鍵被擋下(不認識的鍵)" "$ext_out" "不認識的鍵:myOwnGate"
assert_contains "訊息要說『不要改模板的 KNOWN_GATES_CONFIG_KEYS』" "$ext_out" "不要改模板的 KNOWN_GATES_CONFIG_KEYS"
assert_contains "訊息要指出自帶設定檔這條路與先例" "$ext_out" "doc-rot.blacklist.json"

# (b) 照那條路做 → 自帶設定檔的 gate 不受 KNOWN_GATES_CONFIG_KEYS 管,現有 gate 照常運作
rm -f "$CONSUMER/scripts/gates.config.json"
printf '{\n  "scope": ["src"]\n}\n' > "$CONSUMER/scripts/my-own-gate.scope.json"
own_out="$(cd "$CONSUMER" && npx tsx scripts/check-known-defects.ts 2>&1 || true)"
assert_not_contains "自帶設定檔不會讓既有 gate 紅" "$own_out" "不認識的鍵"
rm -f "$CONSUMER/scripts/my-own-gate.scope.json"

echo "== 步驟 11(1.6.10,P-96):兩份排除清單的差集必須為空(跨語言,不能靠 import) =="
# 來源:專案 A 協調者 2026-09-12 的更正。`sync-gates.sh` 是 bash、`DEFAULT_SKIP_DIRS` 是
# TypeScript 的 export,**它沒辦法呼叫** —— 所以 1.6.9 的修法在 shell 裡硬寫了第二份清單。
# 那不是「接上共用層」,是「**共用層跨不過語言邊界**」:兩份清單,將來會漂。
#
# 提報方把它寫成一個**可以被關閉**的陳述(而「應該用共用層」不能):
#   「sync-gates.sh 的偵測排除清單與 DEFAULT_SKIP_DIRS 的差集不為空,而差集裡有 .stryker-tmp」
# 這一步就是關閉它:**TS 那份的每一項,bash 偵測那段都要排除到。**
ts_dirs="$(sed -n '/^export const DEFAULT_SKIP_DIRS/,/^];/p' "$TEMPLATE_DIR/scripts/_root.ts" \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u)"
sh_dirs="$(sed -n '/for d in node_modules/,/; do$/p' "$TEMPLATE_DIR/scripts/sync-gates.sh" \
  | sed 's/^ *for d in //; s/; do$//; s/\\$//' | tr ' ' '\n' | grep -v '^$' | sort -u)"
missing=""
for d in $ts_dirs; do
  case " $(echo $sh_dirs) " in *" $d "*) ;; *) missing="$missing $d";; esac
done
assert_eq "DEFAULT_SKIP_DIRS 的每一項,bash 偵測那段都排除到了(差集為空)" "${missing# }" ""
if [ -n "$missing" ]; then echo "      差集:$missing"; fi

echo "== 步驟 12(1.8.0,#12 #17):pre-commit hook 在 linked worktree 與「consumer 決定不裝」 =="
# 【驗】linked worktree 裡 `.git` 是檔案、hooks 目錄在主 repo 且全部 worktree 共用。1.8.0 以前寫死 `.git/hooks`,
# 安裝指令在 worktree 裡直接失敗、「有沒有裝」永遠判成沒裝;而且 consumer 無法表達「決定不裝」,
# 提示每輪重播,worker 照著把它「修好」,把 consumer 的決定靜默推翻(專案 A 實例)。
HWT="$(mktemp -d)"
(
  cd "$HWT" && git init -q main && cd main && cp "$TEMPLATE_DIR/package.json" . && git add -A && git -c user.name=t -c user.email=t@t commit -q -m x
  bash "$SYNC_GATES" . scripts >/dev/null 2>&1; git add -A; git -c user.name=t -c user.email=t@t commit -q -m sync
  git worktree add -q ../wt
) >/dev/null 2>&1
hook_line() { (cd "$HWT/wt" && bash "$SYNC_GATES" . scripts --check 2>&1 | grep "pre-commit hook"); }
h1="$(hook_line)"
assert_contains "worktree 裡未裝:說出 worktree 共用 hooks 目錄" "$h1" "個 worktree,共用同一個 hooks 目錄"
assert_contains "worktree 裡未裝:安裝路徑是主 repo 的 hooks 目錄,不是 .git/hooks" "$h1" "/main/.git/hooks/pre-commit"
cmd="$(echo "$h1" | grep -oE 'cp [^)]*pre-commit && chmod \+x [^)]*pre-commit')"
( cd "$HWT/wt" && eval "$cmd" ) >/dev/null 2>&1
assert_contains "照印出的指令在 worktree 裡安裝後,判定為已安裝" "$(hook_line)" "✓ pre-commit hook 已安裝"
rm -f "$HWT/main/.git/hooks/pre-commit"
printf '# 不裝:沒有 inPlace 的 Stryker 設定,見 ADR-048\n' > "$HWT/wt/scripts/hooks/pre-commit.local.md"
h2="$(hook_line)"
assert_contains "consumer 寫了決定:印出決定" "$h2" "consumer 決定:不裝:沒有 inPlace 的 Stryker 設定,見 ADR-048"
assert_not_contains "consumer 寫了決定:不再印安裝指令" "$h2" "cp "
rm -rf "$HWT"

echo "== 步驟 13(1.8.0,#12):pre-commit hook 依「變異測試會不會改工作區」分流 =="
# mutate.py 一定直接改檔 → 活鎖、殘留鎖都擋(殘留鎖代表檔案可能還沒還原,外部提案的「殘留放行」對它不成立);
# Stryker 只有 inPlace: true 才改檔 → 沒設就放行(兩個 consumer 都量到 inPlace 全未設定)。
HK="$(mktemp -d)"; ( cd "$HK" && git init -q . )
sleep 300 & HK_LIVE=$!
hook_rc() { (cd "$HK" && bash "$TEMPLATE_DIR/scripts/hooks/pre-commit" >/dev/null 2>&1); echo $?; rm -f "$HK/.stryker.lock" "$HK/.mutate.lock" "$HK"/stryker*.json; }
echo "{\"pid\":$HK_LIVE}" > "$HK/.stryker.lock"
assert_eq "stryker 活鎖、沒有 inPlace 設定 → 放行" "$(hook_rc)" "0"
echo "{\"pid\":$HK_LIVE}" > "$HK/.stryker.lock"; echo '{"inPlace":true}' > "$HK/stryker.config.json"
assert_eq "stryker 活鎖、inPlace:true → 擋" "$(hook_rc)" "1"
echo '{"pid":999999}' > "$HK/.stryker.lock"; echo '{"inPlace":true}' > "$HK/stryker.config.json"
assert_eq "stryker 殘留鎖、inPlace:true → 擋" "$(hook_rc)" "1"
echo "{\"pid\":$HK_LIVE}" > "$HK/.stryker.lock"; echo '{"note":"inPlace true 只是說明","inPlace":false}' > "$HK/stryker.config.json"
assert_eq "字串裡提到 inPlace 但實際 false → 放行(不用 grep 判斷,P-89)" "$(hook_rc)" "0"
echo "{\"pid\":$HK_LIVE}" > "$HK/.mutate.lock"
assert_eq "mutate.py 活鎖 → 擋" "$(hook_rc)" "1"
echo '{"pid":999999}' > "$HK/.mutate.lock"
assert_eq "mutate.py 殘留鎖 → 擋(檔案可能還沒還原)" "$(hook_rc)" "1"
kill "$HK_LIVE" 2>/dev/null; wait "$HK_LIVE" 2>/dev/null || true; rm -rf "$HK"

echo "== 步驟 14(1.8.0):目標還不是 git repo 時,sync 與 --check 不能因為 hook 狀態偵測而崩潰 =="
# npx init 刻意不 git init,所以「還不是 git repo」是 consumer 第一次跑 sync 的正常狀態。
# 1.8.0 的 hook 偵測第一版在這裡以 128 靜默結束(pipefail 下 git worktree list 失敗),是 npx 黑箱 gate 抓到的。
NG="$(mktemp -d)"
bash "$TEMPLATE_DIR/scripts/sync-gates.sh" "$NG" scripts > "$NG.sync.out" 2>&1
assert_eq "非 git 目標:sync 退出碼" "$?" "0"
bash "$TEMPLATE_DIR/scripts/sync-gates.sh" "$NG" scripts --check > "$NG.check.out" 2>&1
NG_CODE=$?
# 空目錄沒有 package.json,「同步進來但沒接線」會正確地讓 --check 回 1——那不是這一步要驗的。
# 這一步只驗「沒有崩潰」:退出碼是 --check 自己的判定(0 或 1),不是 shell 被 set -e 砍掉的 128。
case "$NG_CODE" in 0|1) NG_CODE=ok ;; esac
assert_eq "非 git 目標:--check 跑完自己的判定(0/1),不是崩潰" "$NG_CODE" "ok"
grep -q "pre-commit hook" "$NG.check.out"
assert_eq "非 git 目標:--check 仍印出 hook 狀態那一行" "$?" "0"
rm -rf "$NG" "$NG.sync.out" "$NG.check.out"

echo "== 步驟 15(1.11.0,hotfix-traceability):HOTFIX 新格式、舊格式與尾端清單 =="
# 這三組 fixture 刻意各自隔離:新格式的兩個時間點、舊格式的格式錯誤、清單的空/非空
# 兩種狀態都只碰同步進來的檔案,不把前面步驟的 consumer 狀態帶進來。
hotfix_today="$(date +%F)"
hotfix_expired="$(date -d '3 days ago' +%F)"
hotfix_today_age=$(( ( $(date +%s) - $(date -d "$hotfix_today" +%s) ) / 3600 ))

HOTFIX_NEW_CONSUMER="$(make_hotfix_consumer || true)"
if [ -z "$HOTFIX_NEW_CONSUMER" ]; then
  fail "新格式 fixture 建立成功"
else
  new_file="$HOTFIX_NEW_CONSUMER/scripts/check-boundaries.ts"
  add_hotfix_fixture "$new_file" "// HOTFIX: ${hotfix_today} DECISIONS-14 new-format recent"
  new_recent_out="$("$SYNC_GATES" "$HOTFIX_NEW_CONSUMER" scripts --check 2>&1)"
  new_recent_code=$?
  new_recent_tail="$(printf '%s\n' "$new_recent_out" | tail -n 12)"

  sed -i "2s/${hotfix_today}/${hotfix_expired}/" "$new_file"
  new_expired_out="$("$SYNC_GATES" "$HOTFIX_NEW_CONSUMER" scripts --check 2>&1)"
  new_expired_code=$?
  if [ "$new_recent_code" = "0" ] \
    && contains_text "$new_recent_out" "⚠ check-boundaries.ts 有本地 HOTFIX(${hotfix_today}," \
    && contains_text "$new_recent_tail" "HOTFIX 清單" \
    && contains_text "$new_recent_tail" "DECISIONS-14" \
    && contains_text "$new_recent_tail" "new-format recent" \
    && contains_text "$new_recent_tail" "${hotfix_today_age}h" \
    && [ "$new_expired_code" = "1" ] \
    && contains_text "$new_expired_out" "HOTFIX(${hotfix_expired})"; then
    pass "新格式 HOTFIX:24 小時內警告不紅、超過 24 小時紅,且清單含完整欄位"
  else
    fail "新格式 HOTFIX:24 小時內警告不紅、超過 24 小時紅,且清單含完整欄位"
    echo "--- 新格式 24 小時內實際輸出 ---"
    echo "$new_recent_out"
    echo "--- 新格式超過 24 小時實際輸出 ---"
    echo "$new_expired_out"
    echo "--- 輸出結束 ---"
  fi
fi

HOTFIX_OLD_CONSUMER="$(make_hotfix_consumer || true)"
if [ -z "$HOTFIX_OLD_CONSUMER" ]; then
  fail "舊格式 fixture 建立成功"
else
  old_file="$HOTFIX_OLD_CONSUMER/scripts/check-boundaries.ts"
  add_hotfix_fixture "$old_file" "// HOTFIX: ${hotfix_today} legacy-format-without-route"
  old_format_out="$("$SYNC_GATES" "$HOTFIX_OLD_CONSUMER" scripts --check 2>&1)"
  old_format_code=$?
  if [ "$old_format_code" = "1" ] && contains_text "$old_format_out" "HOTFIX 行缺回流去向"; then
    pass "舊格式 HOTFIX:--check 紅且印出缺回流去向的新訊息"
  else
    fail "舊格式 HOTFIX:--check 紅且印出缺回流去向的新訊息"
    echo "--- 舊格式實際輸出 ---"
    echo "$old_format_out"
    echo "--- 輸出結束 ---"
  fi
fi

HOTFIX_LIST_CONSUMER="$(make_hotfix_consumer || true)"
if [ -z "$HOTFIX_LIST_CONSUMER" ]; then
  fail "清單 fixture 建立成功"
else
  list_empty_out="$("$SYNC_GATES" "$HOTFIX_LIST_CONSUMER" scripts --check 2>&1)"
  list_empty_code=$?
  assert_exit_code "沒有 HOTFIX 時 --check 維持成功" "$list_empty_code" "0"
  assert_not_contains "沒有 HOTFIX 時不印清單段落" "$list_empty_out" "HOTFIX 清單"

  list_file_a="$HOTFIX_LIST_CONSUMER/scripts/check-boundaries.ts"
  list_file_b="$HOTFIX_LIST_CONSUMER/scripts/check-dag.ts"
  add_hotfix_fixture "$list_file_a" "// HOTFIX: ${hotfix_today} #23 list-first"
  add_hotfix_fixture "$list_file_b" "// HOTFIX: ${hotfix_today} JIRA-1234 list-second"
  list_out="$("$SYNC_GATES" "$HOTFIX_LIST_CONSUMER" scripts --check 2>&1)"
  list_code=$?
  list_tail="$(printf '%s\n' "$list_out" | tail -n 20)"
  if [ "$list_empty_code" = "0" ] \
    && ! contains_text "$list_empty_out" "HOTFIX 清單" \
    && [ "$list_code" = "0" ] \
    && contains_text "$list_tail" "HOTFIX 清單" \
    && contains_text "$list_tail" "check-boundaries.ts" \
    && contains_text "$list_tail" "check-dag.ts" \
    && contains_text "$list_tail" "$hotfix_today" \
    && contains_text "$list_tail" "JIRA-1234" \
    && contains_text "$list_tail" "list-first" \
    && contains_text "$list_tail" "list-second" \
    && contains_text "$list_tail" "${hotfix_today_age}h"; then
    pass "HOTFIX 清單:無 HOTFIX 時不印,有兩筆時尾端列出完整欄位"
  else
    fail "HOTFIX 清單:無 HOTFIX 時不印,有兩筆時尾端列出完整欄位"
    echo "--- 無 HOTFIX 實際輸出 ---"
    echo "$list_empty_out"
    echo "--- 兩筆 HOTFIX 實際輸出尾端 ---"
    echo "$list_tail"
    echo "--- 輸出結束 ---"
  fi
fi

echo
echo "== 步驟 16(修補記錄第二輪,leg 2r2):HOTFIX 回流去向白名單下限 =="
HOTFIX_ROUTE_CONSUMER="$(make_hotfix_consumer || true)"
if [ -z "$HOTFIX_ROUTE_CONSUMER" ]; then
  fail "普通英文字回流去向 fixture 建立成功"
else
  route_file="$HOTFIX_ROUTE_CONSUMER/scripts/check-boundaries.ts"
  add_hotfix_fixture "$route_file" "// HOTFIX: ${hotfix_today} forgot ordinary-word-route"
  route_out="$("$SYNC_GATES" "$HOTFIX_ROUTE_CONSUMER" scripts --check 2>&1)"
  route_code=$?
  if [ "$route_code" = "1" ] && contains_text "$route_out" "HOTFIX 行缺回流去向"; then
    pass "普通英文字作為回流去向時 --check 紅且印出缺回流去向訊息"
  else
    fail "普通英文字作為回流去向時 --check 紅且印出缺回流去向訊息"
    echo "--- 普通英文字回流去向實際輸出(exit $route_code) ---"
    echo "$route_out"
    echo "--- 輸出結束 ---"
  fi
fi

HOTFIX_VALID_ROUTE_CONSUMER="$(make_hotfix_consumer || true)"
if [ -z "$HOTFIX_VALID_ROUTE_CONSUMER" ]; then
  fail "有效回流去向 fixture 建立成功"
else
  valid_route_file="$HOTFIX_VALID_ROUTE_CONSUMER/scripts/check-boundaries.ts"
  add_hotfix_fixture "$valid_route_file" "// HOTFIX: ${hotfix_today} DECISIONS-14 valid-route"
  valid_route_out="$("$SYNC_GATES" "$HOTFIX_VALID_ROUTE_CONSUMER" scripts --check 2>&1)"
  valid_route_code=$?
  if [ "$valid_route_code" = "0" ] && contains_text "$valid_route_out" "DECISIONS-14"; then
    pass "有效回流去向 DECISIONS-14 仍允許 24 小時內 HOTFIX"
  else
    fail "有效回流去向 DECISIONS-14 仍允許 24 小時內 HOTFIX"
    echo "--- 有效回流去向實際輸出(exit $valid_route_code) ---"
    echo "$valid_route_out"
    echo "--- 輸出結束 ---"
  fi
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "sync-gates.test.sh: 全部通過"
  exit 0
else
  echo "sync-gates.test.sh: $FAILURES 個斷言失敗"
  exit 1
fi
