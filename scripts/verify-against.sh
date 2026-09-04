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
#   <template>/scripts/verify-against.sh <consumer repo 根> --consumer-dir <子目錄>
#
# consumer 的守門安裝目錄怎麼找(CHANGELOG 1.3.2 (B);舊版寫死 `<consumer>/scripts/`,
# cucumber 設定不在根目錄的專案常把守門裝在別處,例如 `<consumer>/features/scripts/`,
# 寫死的路徑會把已經裝好的守門誤判成「未裝」):
#   1. `--consumer-dir <子目錄>` 明講(相對 consumer 根)
#   2. `<consumer>/scripts/`(有 `_root.ts` 才算數)
#   3. `<consumer>/features/scripts/`(同上)
#   4. `find <consumer> -name _root.ts -not -path '*/node_modules/*' -maxdepth 4`
#      找到的第一個檔案所在目錄
#   四層都沒有 → 視為「consumer 未裝守門」,不是報錯。
#
# 對每支 check-*.ts(check-boundaries / check-doc-links / check-gherkin-dup /
# check-phase-coverage / check-standalone / check-step-dup),consumer 安裝目錄下有
# 同名檔才比;沒有就跳過那一支的比對。cwd 一律是 consumer 根,用 `npx tsx <路徑>` 執行:
#   - check-boundaries.ts  加 `--root <consumer 根>`
#   - check-standalone.ts  加 `--list`(不真的執行 manifest 裡的指令)
#   - check-phase-coverage.ts  加 `--list`(不真的跑 cucumber,以免太慢)
#   - check-doc-links.ts / check-step-dup.ts / check-gherkin-dup.ts  原樣執行
#
# 每一對(存在才比)先各自判斷「這次執行算不算數」,再比三件事:
#
#   執行有效性(CHANGELOG 1.3.2 (C);修的是這支腳本自己的同型 bug——退出碼 127
#   〔command not found〕曾經被當成「✓ 未觸發 0 目標守衛」然後整體 exit 0,
#   等於「空檢查 = 通過」,正是本腳本要抓的那種塌縮,只是這次犯在自己身上):
#     每支 check-*.ts 結尾都固定印一行機器可讀標記
#     `gate=<name> result=PASS|FAIL scanned=<N>`。一次執行「有效」需要同時成立:
#       (i) 退出碼是 0 或 1
#       (ii) 輸出裡有那一行 `gate=` 標記
#     缺一 → 這一側判「未執行」(印退出碼),不進入下面三項比較,直接算這個檔案有差異
#     (127 / 2 / 其他退出碼,或程式在印標記前就 crash,都會落在這裡)。
#
#   兩側都有效才比:
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
#   有任何差異(含任一側「未執行」)→ 逐項列出,最後印一行提醒「由人標每項是
#     『刻意改進』或『迴歸』,寫進 CHANGELOG 該版條目」,exit 1
#   consumer 完全沒裝守門(四層都找不到安裝目錄,全新專案、第一次落地)→
#     印 `consumer 未裝守門,只跑模板版`,只對模板版本身做「執行有效性」與
#     「掃到 0 個目標」守衛檢查(那句共用的「這不是很乾淨,是掃描器壞了」有沒有被
#     觸發),模板版本身執行有效才 exit 0——這不是「一致」,只是沒有東西可比,
#     不該擋出版,但模板自己都跑不起來還是要紅。
#
# 反向驗證(改完要還原,不要留下改動):
#   (a) 對一個裝了舊版守門的 consumer 跑一次,預期看到差異列表(旗標、輸出字樣、
#       掃描範圍都可能不同)——這是正常結果,不代表腳本壞了。
#   (b) 對一個什麼守門都沒裝的目錄跑一次 → 應印「consumer 未裝守門,只跑模板版」且 exit 0。
#   (c) 故意把 EXTRA 旗標表的某一項改錯(例如給 check-boundaries.ts 傳一個不存在的
#       consumer 路徑)→ 應該兩邊都非 0 退出碼,但 (b) 的輸出 diff 應該能看出差異
#       原因不同,不會被誤判成「一致」。改回來、重跑 → 應該還原原本的結果。
#   (d) 執行有效性:把 consumer 的某支 check-*.ts 改壞讓它跑不起來(例如把它 import
#       的 `_root.ts` 改名,或把檔案內容清空成一行語法錯誤)→ 這支腳本應該紅,
#       印該側「未執行(退出碼=…)」,不能被讀成「✓ 一致」或「✓ 未觸發 0 目標守衛」。
#       改回來、重跑 → 應該還原成原本的比對結果。
#   (e) 安裝目錄搜尋:把 consumer 的守門從 `scripts/` 搬到 `features/scripts/` →
#       不加 `--consumer-dir` 也應該自動找到並正常比對(不能報「consumer 未裝」)。
#       搬到一個四層搜尋範圍以外、也不是 `scripts/` 或 `features/scripts/` 的怪目錄 →
#       應該報「consumer 未裝守門」,除非明講 `--consumer-dir` 指過去。
set -uo pipefail

TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER_ARG="${1:?用法:verify-against.sh <consumer repo 根> [--consumer-dir <子目錄>]}"
if [ ! -d "$CONSUMER_ARG" ]; then
  echo "✗ 不是目錄:$CONSUMER_ARG"
  exit 1
fi
CONSUMER="$(cd "$CONSUMER_ARG" && pwd)"

CONSUMER_DIR_OVERRIDE=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --consumer-dir)
      CONSUMER_DIR_OVERRIDE="${2:?--consumer-dir 需要一個子目錄}"
      shift 2
      ;;
    *)
      echo "✗ 未知參數:$1"
      exit 1
      ;;
  esac
done

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

SCANNER_BROKEN_MARK='這不是很乾淨,是掃描器壞了'
GATE_MARK_RE='^gate=[a-z-]+ result=(PASS|FAIL) scanned=[0-9]+$'

# 掃描器清單,順序固定方便看輸出。
FILES=(check-boundaries.ts check-doc-links.ts check-gherkin-dup.ts check-phase-coverage.ts check-standalone.ts check-step-dup.ts)

# 找 consumer 的守門安裝目錄,見檔頭「consumer 的守門安裝目錄怎麼找」。
# 印到 stdout 是找到的絕對路徑;找不到就不印東西、回傳非 0。
find_consumer_scripts_dir() {
  if [ -n "$CONSUMER_DIR_OVERRIDE" ]; then
    local override_dir="$CONSUMER/$CONSUMER_DIR_OVERRIDE"
    if [ -d "$override_dir" ]; then
      echo "$override_dir"
      return 0
    fi
    return 1
  fi
  for candidate in "$CONSUMER/scripts" "$CONSUMER/features/scripts"; do
    if [ -f "$candidate/_root.ts" ]; then
      echo "$candidate"
      return 0
    fi
  done
  local found
  found="$(find "$CONSUMER" -name _root.ts -not -path '*/node_modules/*' -maxdepth 4 2>/dev/null | head -1)"
  if [ -n "$found" ]; then
    dirname "$found"
    return 0
  fi
  return 1
}

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

# 執行有效性判定(見檔頭):$1=退出碼、$2=輸出檔。
# 印一行給人看的訊息到 stdout;回傳 0=有效、1=無效(「未執行」)。
judge_execution() {
  local rc="$1" outfile="$2"
  if [ "$rc" != "0" ] && [ "$rc" != "1" ]; then
    echo "未執行(退出碼=$rc,不是 0 或 1)"
    return 1
  fi
  if ! grep -qE "$GATE_MARK_RE" "$outfile" 2>/dev/null; then
    echo "未執行(退出碼=$rc,但輸出裡沒有 gate= 標記行——可能在印標記前就中斷了)"
    return 1
  fi
  return 0
}

any_diff=0
any_compared=0

CONSUMER_SCRIPTS_DIR="$(find_consumer_scripts_dir || true)"

if [ -n "$CONSUMER_SCRIPTS_DIR" ]; then
  echo "consumer 守門安裝目錄:$CONSUMER_SCRIPTS_DIR"
  echo
fi

for name in "${FILES[@]}"; do
  template_file="$TEMPLATE_DIR/scripts/$name"
  consumer_file="${CONSUMER_SCRIPTS_DIR:+$CONSUMER_SCRIPTS_DIR/$name}"
  if [ -z "$CONSUMER_SCRIPTS_DIR" ] || [ ! -f "$consumer_file" ]; then
    echo "○ $name  consumer 未裝,跳過比對"
    continue
  fi
  any_compared=1
  build_flags "$name"

  out_t="$WORKDIR/${name}.template.out"
  out_c="$WORKDIR/${name}.consumer.out"
  rc_t="$(run_capture "$template_file" "$out_t" "${FLAGS[@]}")"
  rc_c="$(run_capture "$consumer_file" "$out_c" "${FLAGS[@]}")"

  file_diff=0
  echo "── $name ──"
  echo "  旗標:${FLAGS[*]:-(無)}"

  judge_t_msg="$(judge_execution "$rc_t" "$out_t")"; judge_t_ok=$?
  judge_c_msg="$(judge_execution "$rc_c" "$out_c")"; judge_c_ok=$?

  if [ "$judge_t_ok" != 0 ] || [ "$judge_c_ok" != 0 ]; then
    file_diff=1
    [ "$judge_t_ok" != 0 ] && echo "  (a) 模板版$judge_t_msg"
    [ "$judge_c_ok" != 0 ] && echo "  (a) consumer 版$judge_c_msg"
    any_diff=1
    echo
    continue
  fi

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
  solo_fail=0
  for name in "${FILES[@]}"; do
    template_file="$TEMPLATE_DIR/scripts/$name"
    build_flags "$name"
    out_t="$WORKDIR/${name}.solo.out"
    rc_t="$(run_capture "$template_file" "$out_t" "${FLAGS[@]}")"
    judge_msg="$(judge_execution "$rc_t" "$out_t")"; judge_ok=$?
    if [ "$judge_ok" != 0 ]; then
      solo_fail=1
      echo "  $name  退出碼=$rc_t  ✗ $judge_msg"
      continue
    fi
    if grep -qF "$SCANNER_BROKEN_MARK" "$out_t"; then
      guard="✗ 觸發「$SCANNER_BROKEN_MARK」(0 目標守衛)"
    else
      guard="✓ 未觸發 0 目標守衛"
    fi
    echo "  $name  退出碼=$rc_t  $guard"
  done
  if [ "$solo_fail" = 1 ]; then
    echo
    echo "模板版自己有腳本跑不起來,見上面「✗」那幾行。"
    exit 1
  fi
  exit 0
fi

if [ "$any_diff" = 1 ]; then
  echo "由人標每項是『刻意改進』或『迴歸』,寫進 CHANGELOG 該版條目。"
  exit 1
fi

echo "✓ 與 $CONSUMER 的守門一致"
exit 0
