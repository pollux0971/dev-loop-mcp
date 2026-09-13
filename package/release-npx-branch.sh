#!/usr/bin/env bash
# 把 npx 發布殼推成 GitHub 上可以 `npx github:<owner>/<repo>#npx-v<版本> init .` 的發布版。
#
# 為什麼要一個獨立的發布分支(1.7.1,使用者選 A:私有 GitHub、不發 npm):
#   `npx github:…` 讀的是 **repo 根目錄**的 package.json,而本 repo 根目錄那份是**給 consumer 的樣板**
#   (name 是 {{PROJECT_NAME}}、沒有 bin)。【驗】直接 `npx github:pollux0971/dev-paradigm#v1.7.0 init .`
#   → `npm error could not determine executable to run`。可發布的套件在 package/ 子目錄,
#   而 npm 從 git 安裝不支援子目錄。所以把 `npm pack` 的產物(package.json + src/cli.mjs + dist/template/)
#   放在一個**孤立分支**的根目錄,再打 `npx-v<版本>` tag。
#
# 為什麼要拿掉 package.json 的 scripts:
#   tarball 只含 src/cli.mjs(見 package.json 的 files),但 scripts.prepack 指向 src/build-template.mjs——
#   從 git 安裝時要是觸發它就會找不到檔。發布分支是**建好的產物**,不需要也不該再建一次。
#
# 用法:
#   bash package/release-npx-branch.sh            # 演練:建好產物並試跑 init,不建分支、不打 tag、不推
#   bash package/release-npx-branch.sh --push     # 真的推 npx-release 分支與 npx-v<版本> tag 到 origin
#
# 前提:在模板 repo 根目錄執行;VERSION 與 package/package.json 的 version 一致(版本 gate 會擋);
#       要發布的版本已經 commit(發布內容取自工作樹,但 tag 名取自 VERSION,不一致會發出錯的東西)。
set -euo pipefail

PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
PKG_VERSION="$(node -p "require('./package/package.json').version")"
if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "✗ 版本不一致:VERSION=$VERSION,package/package.json=$PKG_VERSION" >&2
  exit 1
fi
if [ -n "$(git status --porcelain -- . ':!BMAD-METHOD-main*')" ]; then
  echo "✗ 工作樹有未 commit 的變更——發布內容取自工作樹,先 commit 再發布,不然 tag 對應的原始碼查不到" >&2
  git status --short -- . ':!BMAD-METHOD-main*' >&2
  exit 1
fi

TAG="npx-v$VERSION"
BRANCH="npx-release"
SOURCE_COMMIT="$(git rev-parse --short HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 舊的 package/dist/ 會讓 cli 讀到過期快照(1.7.1 實際踩過:少落地一個檔、還印成功),先清掉再 pack。
rm -rf package/dist
mkdir -p "$WORK/art" "$WORK/x"
( cd package && npm pack --json --pack-destination "$WORK/art" > "$WORK/pack.json" )
TGZ="$(ls "$WORK/art"/*.tgz)"
tar -xzf "$TGZ" -C "$WORK/x"
rm -rf package/dist   # pack 的 prepack 會重建 dist/,發布完不留在工作樹

node -e "
const f='$WORK/x/package/package.json'; const p=require(f);
delete p.scripts; delete p.private;
require('fs').writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
"

# 發布前先在本機驗一次:從產物目錄直接跑 init,必須成功且收件匣是空的。
PROBE="$WORK/probe"; mkdir -p "$PROBE"
node "$WORK/x/package/src/cli.mjs" init "$PROBE" > "$WORK/probe.out" 2>&1 || { cat "$WORK/probe.out" >&2; echo "✗ 產物本機試跑 init 失敗,不發布" >&2; exit 1; }
if sed -n '/## 待批示/,/## 已批示/p' "$PROBE/DECISIONS_NEEDED.md" | grep -qE '^\| *[0-9]+ *\|'; then
  echo "✗ 產物落地的收件匣不是空的,不發布" >&2; exit 1
fi
echo "✓ 產物本機試跑:$(grep -m1 '^✓' "$WORK/probe.out")"

if [ "$PUSH" != 1 ]; then
  # 演練模式不碰任何 ref。1.7.1 第一版在演練時就建了本機 tag,結果正式推送時被「tag 已存在」擋下——
  # 「先演練再推」這個流程本身就會卡住。演練只負責證明產物可用、列出會發布的內容。
  echo "發布分支 $BRANCH 的根目錄會是:"; ( cd "$WORK/x/package" && ls -A | sed 's/^/  /' )
  if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    echo "✗ 遠端已有 tag $TAG。發布版不覆蓋——要重發請先升版號" >&2; exit 1
  fi
  echo "(演練模式:沒有建立分支或 tag、沒有推送。確認無誤後加 --push)"
  exit 0
fi

# 在碰任何 ref 之前先擋:本機或遠端已有這個 tag 就不發(發布版不覆蓋)。
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "✗ tag $TAG 已存在(本機)。發布版不覆蓋——要重發請先升版號" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "✗ 遠端已有 tag $TAG。發布版不覆蓋——要重發請先升版號" >&2; exit 1
fi

# 用 git worktree 操作孤立分支,不動目前的工作樹。
REL="$WORK/rel"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add -q "$REL" "$BRANCH"
elif git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch -q origin "$BRANCH:$BRANCH"
  git worktree add -q "$REL" "$BRANCH"
else
  git worktree add -q --detach "$REL"
  ( cd "$REL" && git checkout -q --orphan "$BRANCH" && git rm -rfq . )
fi
cleanup_worktree() { git worktree remove --force "$REL" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup_worktree EXIT

( cd "$REL" && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + )
cp -a "$WORK/x/package/." "$REL/"
( cd "$REL" && git add -A && git -c commit.gpgsign=false commit -qm "npx release $VERSION(來源 main@$SOURCE_COMMIT)

由 package/release-npx-branch.sh 產生。內容是 npm pack 的產物,拿掉了 package.json 的 scripts。
安裝:npx github:pollux0971/dev-paradigm#$TAG init ." )

git tag -a "$TAG" "$(cd "$REL" && git rev-parse HEAD)" -m "npx 發布版 $VERSION(來源 main@$SOURCE_COMMIT)"

echo "✓ 本機已建立分支 $BRANCH 與 tag $TAG(來源 main@$SOURCE_COMMIT)"
git push -q origin "$BRANCH"
git push -q origin "$TAG"
echo "✓ 已推送。安裝指令:npx github:pollux0971/dev-paradigm#$TAG init ."
