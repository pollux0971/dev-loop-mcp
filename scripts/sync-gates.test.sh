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

cleanup() {
  [ -n "$CONSUMER" ] && [ -d "$CONSUMER" ] && rm -rf "$CONSUMER"
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
if [ "$FAILURES" -eq 0 ]; then
  echo "sync-gates.test.sh: 全部通過"
  exit 0
else
  echo "sync-gates.test.sh: $FAILURES 個斷言失敗"
  exit 1
fi
