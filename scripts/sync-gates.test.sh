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

cleanup() {
  [ -n "$CONSUMER" ] && [ -d "$CONSUMER" ] && rm -rf "$CONSUMER"
  [ -n "$CONSUMER2" ] && [ -d "$CONSUMER2" ] && rm -rf "$CONSUMER2"
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
assert_contains "plain sync 印出手動安裝 hook 的指令" "$sync_out" "hook:cp"
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

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "sync-gates.test.sh: 全部通過"
  exit 0
else
  echo "sync-gates.test.sh: $FAILURES 個斷言失敗"
  exit 1
fi
