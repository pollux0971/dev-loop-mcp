#!/usr/bin/env bash
# 出版前的機械檢查:模板版每支 check-*.ts 跟目標(consumer)repo 已裝的同名檔,
# 對同一個 consumer repo 各跑一次,比對退出碼、輸出、旗標清單三件事。
#
# 這支腳本回答的問題不是「模板的程式碼寫得對不對」(那是各 check-*.ts 自己的反向驗證),
# 而是「這一版模板跟已經在用舊版的 consumer,行為對不上的地方有哪些」——包含刻意的
# 改進(consumer 該跟進)跟不小心的迴歸(模板該修)兩種,這支腳本本身不判斷是哪一種,
# 只負責找出差異、列出來,由人標。
#
# 用法:
#   <template>/scripts/verify-against.sh <consumer repo 根>
#
# 對每支 check-*.ts(check-boundaries / check-doc-links / check-gherkin-dup /
# check-phase-coverage / check-standalone / check-step-dup),consumer 有同名檔
# (`<consumer>/scripts/<name>`)才比;consumer 沒有就跳過那一支的比對。
# cwd 一律是 consumer 根,用 `npx tsx <路徑>` 執行:
#   - check-boundaries.ts  加 `--root <consumer 根>`
#   - check-standalone.ts  加 `--list`(不真的執行 manifest 裡的指令)
#   - check-phase-coverage.ts  加 `--list`(不真的跑 cucumber,以免太慢)
#   - check-doc-links.ts / check-step-dup.ts / check-gherkin-dup.ts  原樣執行
#
# 每一對(存在才比)比三件事:
#   (a) 退出碼是否相同
#   (b) 輸出(去 ANSI 顏色碼、去每行尾空白、去掉版本標頭那行)逐行是否相同,
#       不同就印 `diff -u` 的前 40 行
#   (c) 從兩邊檔案內容抓 `--[a-z-]+` 的旗標集合(去重排序)比對:
#       「模板有 consumer 無」是新旗標(consumer 還沒跟進);
#       「consumer 有模板無」是「綠著掉功能」的訊號——consumer 曾經支援的旗標,
#       模板這一版悄悄不見了,這正是本腳本要抓的迴歸類型。
#
# 結果:
#   全部一致 → 印 `✓ 與 <consumer> 的守門一致`,exit 0
#   有任何差異 → 逐項列出,最後印一行提醒「由人標每項是『刻意改進』或『迴歸』,
#     寫進 CHANGELOG 該版條目」,exit 1
#   consumer 的 scripts/ 底下一支 check-*.ts 都沒有(全新專案、第一次落地)→
#     印 `consumer 未裝守門,只跑模板版`,只對模板版本身做退出碼與「掃到 0 個目標」
#     守衛檢查(那句共用的「這不是很乾淨,是掃描器壞了」有沒有被觸發),exit 0——
#     這不是「一致」,只是沒有東西可比,不該擋出版。
#
# 反向驗證(改完要還原,不要留下改動):
#   (a) 對一個裝了舊版守門的 consumer 跑一次,預期看到差異列表(旗標、輸出字樣、
#       掃描範圍都可能不同)——這是正常結果,不代表腳本壞了。
#   (b) 對一個 scripts/ 底下什麼 check-*.ts 都沒有的目錄跑一次 → 應印
#       「consumer 未裝守門,只跑模板版」且 exit 0。
#   (c) 故意把 EXTRA 旗標表的某一項改錯(例如給 check-boundaries.ts 傳一個不存在的
#       consumer 路徑)→ 應該兩邊都非 0 退出碼,但 (b) 的輸出 diff 應該能看出差異
#       原因不同,不會被誤判成「一致」。改回來、重跑 → 應該還原原本的結果。
set -uo pipefail

TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER_ARG="${1:?用法:verify-against.sh <consumer repo 根>}"
if [ ! -d "$CONSUMER_ARG" ]; then
  echo "✗ 不是目錄:$CONSUMER_ARG"
  exit 1
fi
CONSUMER="$(cd "$CONSUMER_ARG" && pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

SCANNER_BROKEN_MARK='這不是很乾淨,是掃描器壞了'

# 掃描器清單,順序固定方便看輸出。
FILES=(check-boundaries.ts check-doc-links.ts check-gherkin-dup.ts check-phase-coverage.ts check-standalone.ts check-step-dup.ts)

# $1 = 檔名 → 把這次比對要加的旗標塞進全域陣列 FLAGS(consumer 版跟模板版用同一組旗標)。
build_flags() {
  FLAGS=()
  case "$1" in
    check-boundaries.ts) FLAGS=(--root "$CONSUMER") ;;
    check-standalone.ts) FLAGS=(--list) ;;
    check-phase-coverage.ts) FLAGS=(--list) ;;
  esac
}

# 去 ANSI、去尾空白、去掉版本標頭那行(例如 "// SOURCE: template vX.Y.Z ..." 或輸出裡
# 提到 "template vX.Y.Z" 的行)——這些差異是同步機制造成的雜訊,不是行為差異。
normalize_output() {
  sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' | sed -E 's/[[:space:]]+$//' \
    | grep -vE '^// SOURCE: template v|template v[0-9]+\.[0-9]+\.[0-9]+'
}

# $1 = 檔案路徑 → 印出檔案內容裡 --[a-z-]+ 形狀的旗標集合,去重排序。
extract_flags() {
  grep -oE -- '--[a-z][a-z-]*' "$1" 2>/dev/null | sort -u
}

# $1 = 腳本路徑,其餘為旗標 → 在 CONSUMER 目錄下跑,輸出(stdout+stderr)寫到 $2 指定的檔案,
# 印退出碼到 stdout(呼叫端用 $(...) 接)。
run_capture() {
  local script="$1" outfile="$2"; shift 2
  ( cd "$CONSUMER" && npx tsx "$script" "$@" ) >"$outfile" 2>&1
  echo $?
}

any_diff=0
any_compared=0

for name in "${FILES[@]}"; do
  template_file="$TEMPLATE_DIR/scripts/$name"
  consumer_file="$CONSUMER/scripts/$name"
  if [ ! -f "$consumer_file" ]; then
    echo "○ $name  consumer 未裝,跳過比對"
    continue
  fi
  any_compared=1
  build_flags "$name"

  out_t="$WORKDIR/${name}.template.out"
  out_c="$WORKDIR/${name}.consumer.out"
  rc_t="$(run_capture "$template_file" "$out_t" "${FLAGS[@]}")"
  rc_c="$(run_capture "$consumer_file" "$out_c" "${FLAGS[@]}")"

  norm_t="$WORKDIR/${name}.template.norm"
  norm_c="$WORKDIR/${name}.consumer.norm"
  normalize_output <"$out_t" >"$norm_t"
  normalize_output <"$out_c" >"$norm_c"

  flags_t="$WORKDIR/${name}.template.flags"
  flags_c="$WORKDIR/${name}.consumer.flags"
  extract_flags "$template_file" >"$flags_t"
  extract_flags "$consumer_file" >"$flags_c"
  only_template_flags="$(comm -23 "$flags_t" "$flags_c")"
  only_consumer_flags="$(comm -13 "$flags_t" "$flags_c")"

  file_diff=0
  echo "── $name ──"
  echo "  旗標:${FLAGS[*]:-(無)}"

  if [ "$rc_t" != "$rc_c" ]; then
    file_diff=1
    echo "  (a) 退出碼不同:模板=$rc_t  consumer=$rc_c"
  else
    echo "  (a) 退出碼相同:$rc_t"
  fi

  if cmp -s "$norm_t" "$norm_c"; then
    echo "  (b) 輸出相同"
  else
    file_diff=1
    echo "  (b) 輸出不同(diff -u 前 40 行,- 模板 / + consumer):"
    diff -u "$norm_t" "$norm_c" | head -n 40 | sed 's/^/    /'
  fi

  if [ -z "$only_template_flags" ] && [ -z "$only_consumer_flags" ]; then
    echo "  (c) 旗標清單相同"
  else
    file_diff=1
    echo "  (c) 旗標清單不同:"
    if [ -n "$only_template_flags" ]; then
      echo "      模板有、consumer 無:$(echo "$only_template_flags" | tr '\n' ' ')"
    fi
    if [ -n "$only_consumer_flags" ]; then
      echo "      consumer 有、模板無(綠著掉功能的訊號):$(echo "$only_consumer_flags" | tr '\n' ' ')"
    fi
  fi

  if [ "$file_diff" = 1 ]; then
    any_diff=1
  else
    echo "  ✓ $name 一致"
  fi
  echo
done

if [ "$any_compared" = 0 ]; then
  echo "consumer 未裝守門,只跑模板版"
  for name in "${FILES[@]}"; do
    template_file="$TEMPLATE_DIR/scripts/$name"
    build_flags "$name"
    out_t="$WORKDIR/${name}.solo.out"
    rc_t="$(run_capture "$template_file" "$out_t" "${FLAGS[@]}")"
    if grep -qF "$SCANNER_BROKEN_MARK" "$out_t"; then
      guard="✗ 觸發「$SCANNER_BROKEN_MARK」(0 目標守衛)"
    else
      guard="✓ 未觸發 0 目標守衛"
    fi
    echo "  $name  退出碼=$rc_t  $guard"
  done
  exit 0
fi

if [ "$any_diff" = 1 ]; then
  echo "由人標每項是『刻意改進』或『迴歸』,寫進 CHANGELOG 該版條目。"
  exit 1
fi

echo "✓ 與 $CONSUMER 的守門一致"
exit 0
