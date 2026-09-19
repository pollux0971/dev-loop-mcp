#!/usr/bin/env python3
# SOURCE: nightmare-assault (project C) dev/tools/mutate.py @ 4f1948ac, adopted into template 1.3.1 with user approval 2026-09-05
"""安全的突變測試（mutation testing）驅動工具 — STORY-61-21。

用「`git checkout`」加「兩個 dash」把整個檔案還原成 index/HEAD 版本，已經
在本專案造成兩次資料遺失事故（`STORY-60-27`、`STORY-62-02` Phase 3）：
突變測試的自然流程是「改壞 → 看測試變紅 → 改回來」，而「改回來」最直覺
的指令就是那個會清空工作區的 checkout 用法——它會連同同一檔案裡其他未
commit 的合法編輯一起清空。口頭禁令已證明擋不住這個直覺。本工具把「安全
的改回來」變成唯一路徑：只用 `git show <sha>:<path>` 讀取 git object 內容
寫回檔案，**絕不**呼叫 AGENTS.md §7 禁用清單上的任何一個指令（本檔連
在註解裡都刻意不拼出那些完整指令字面，見下方 grep 驗收要求；只用「兩個
dash 版的 checkout」／「hard 重置」／「強制清未追蹤檔」這類描述帶過）。

流程：
  1. 檢查目標檔是否有未 commit 的變更 —— 有就先自動 WIP commit 封存
     （只 commit 這一個檔案，不動其他任何檔案），絕不在未封存前動手。
  2. 記錄封存後的內容（bytes + sha256）與 git blob sha（`HEAD:<path>`）。
  3. 套用突變（字面字串取代）。
  4. 跑 `--expect-fail` 指定的 pytest node id，斷言它真的變紅
     （沒變紅 = 這個突變測試沒有測到東西，回非零 exit code 並說明原因，
     不得靜默放行）。
  5. 用 `git show <sha>:<path>` 讀回封存時的內容寫回檔案（不用 checkout）。
  6. 驗證還原後的內容與封存時逐位元相同（sha256 比對），不一致就大聲失敗。
  7. 印出可直接貼進 EVIDENCE 的完整記錄。

repo root 用 `git rev-parse --show-toplevel`（依目前工作目錄，非依本檔案
所在位置）現場偵測——跟真正的 `git` 指令行為一致，也讓自動化測試可以把
它指向一個一次性的暫存 repo，不會每次跑測試都在本專案真正的 git 歷史裡
留下 WIP commit。

用法（--expect-fail，pytest node id）：
  python3 dev/tools/mutate.py \\
      --file core/mystery/authority.py \\
      --replace '"core": _CASE_WRITER_POLICY' \\
      --with    '"core": dict(_CASE_WRITER_POLICY)' \\
      --expect-fail tests/test_story_62_14.py::test_core_delegates_by_reference

用法（--cmd，任意 shell 指令，來源 AI_KM 的請求；跟 --expect-fail 互斥，只能給一個）：
  python3 scripts/py/mutate.py \\
      --file scripts/check-boundaries.ts \\
      --replace 'if (to === from ...' \\
      --with    'if (false ...' \\
      --cmd     'npx vitest run --config vitest.scripts.config.ts scripts/check-boundaries.test.ts'

--cmd 用在被突變的目標不是用 pytest 驗收的情境（例如本模板自己的 check-*.ts，
反向驗證要靠跑 `npx tsx` / `npx vitest`，不是 pytest node id）。流程比 --expect-fail
多一步：(1) 突變前跑一次要求 exit 0（否則「突變前就紅，無法判讀」），(2) 突變後跑一次
要求非 0（否則「突變存活」），(3) 用 git show 還原、sha256 比對，(4) 還原後**再跑一次**
要求 exit 0（確認除了檔案內容之外沒有殘留影響）。細節見 run_mutation_cmd() 的 docstring。

機器負載高時，「紅」有可能不是突變造成的，是 timeout／環境問題造成的假紅
（見 STORY-61-21 dispatcher 補充意見）。本工具因此不只看「有沒有變紅」，
還要求：(a) 突變**之前**先跑一次同一個 node id 確認是乾淨的綠（0），
(b) 突變**之後**的紅必須是 pytest exit code 1（真的斷言失敗），不是
2/3/4/5（中斷/內部錯誤/用法錯誤/沒收集到測試）這類跟斷言邏輯無關的
非零碼——只有「綠 → 真的斷言失敗的紅」才算突變測試通過。

--replace 指定的字串在檔案裡必須恰好出現一次，否則「測試變紅」無法歸因到
單一位置（STORY-70-14）。出現多次時一律拒絕並印出每一處的行號；要突變其中
特定一處，加 `--nth N`（1-indexed）明示。

Exit code：
  0 = 突變前綠、突變後因斷言失敗變紅，已安全還原並驗證一致
  1 = 使用方式錯誤（引數、檔案不存在、不受 git 追蹤、取代字串找不到、
      取代字串出現次數非唯一且未給 --nth、--nth 超出範圍、
      或突變前這個 node id 就不是乾淨的綠）
  2 = 突變沒有讓測試變紅（突變測試本身無效）—— 檔案已還原
  3 = 還原後 hash 不一致（嚴重錯誤，理論上不應發生）
  4 = 無法判定：突變後的非零 exit code 不是 1（可能是 timeout/環境問題造
      成的假紅）—— 檔案已還原，不能當作突變生效的證據
  5 = 上次執行留下的自癒狀態檔無法解析（見下方「被中斷時」說明）——
      需要人工介入，不會自動嘗試突變
  6 = 僅 --cmd 模式：突變已經被正確偵測到（第 2 步非 0），檔案也已還原、sha256
      比對一致，但**還原後再跑一次指令仍然是紅的**——代表除了檔案內容之外還有
      殘留影響（建置快取、背景行程之類），需要人工檢查環境。--expect-fail 模式
      沒有這個 exit code。
  7 = S12（模板 1.4.1）：`.mutate.lock` 存在,而且鎖記錄的 pid 還活著——另一個
      mutate.py 正在跑,拒絕開始,不做任何檔案異動。
  8 = S12：`.mutate.lock` 是殘留鎖(記錄的 pid 已死,通常是上一次執行被 SIGKILL
      或崩潰、沒機會清掉鎖)且沒有帶 `--recover`,或鎖檔本身壞掉無法解析——前者
      帶 `--recover` 重跑會先核對目標檔跟 git HEAD 是否一致、視需要還原、清鎖後
      繼續;後者需要人工檢查鎖檔內容再手動刪除。

被中斷時（STORY-70-18）：
  高負載機器上，本工具跑到一半可能被訊號殺掉（背景 pytest 過去兩天已
  發生三次），若壞掉的檔案留在磁碟上、被之後的 WIP commit 順手掃進
  branch tip，「證明有牙」的證據鏈就整條斷掉。因此兩層防線：
  (a) 套用突變前註冊 SIGTERM/SIGINT handler：收到訊號時立刻用
      `git show <sha>:<path>` 還原並結束，跟正常路徑走同一套還原邏輯。
  (b) SIGKILL 攔不到訊號，所以套用突變前先把「還原需要的資訊」
      （root-relative 路徑 + git blob sha）寫進一個不受 git 追蹤的
      sentinel 檔（`<git-dir>/mutate-state/<hash>.json`，`git-dir` 用
      `git rev-parse --git-dir` 現場偵測，天生每個 worktree各自獨立）；
      任何一次呼叫本工具（含跟這次目標檔無關的呼叫）都會先掃這個目錄，
      發現殘留就自動還原、印出訊息、刪除 sentinel，再繼續往下跑
      ——下一次執行本身就是自癒點，不需要使用者記得手動處理。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


class MutateError(RuntimeError):
    def __init__(self, message: str, exit_code: int = 1):
        super().__init__(message)
        self.exit_code = exit_code


# ---------------------------------------------------------------------------
# S12（模板 1.4.1，來源 nightmare-assault）：進行中的突變測試拒絕別人 commit。
#
# 背景（P-34 的另一半）：P-34 已經在「同時跑幾個變異測試」這件事上加了一層跨
# worktree 的檔案鎖（見上面 `_state_dir`／`_self_heal` 那組機制，那個鎖管的是
# 「這個檔案的突變還原有沒有做完」，範圍是單一次突變、單一個檔案）。這裡要防的是
# 另一種形狀：突變測試正在跑到一半（目標檔此刻是被突變過的、還沒還原的內容）時，
# 有人（或某個自動化）在同一個 repo 對這個檔案（或別的檔案）下 `git commit`——
# commit 進去的內容會是突變後的髒版本，而不是任何人真的想 commit 的東西。
#
# `.mutate.lock`（放在 repo root，不受 git 追蹤——跟 `.gitignore` 裡其餘暫存標記
# 檔同一類）是「現在有一個 mutate.py 正在跑」的全域訊號，覆蓋整次執行（從跑基準
# 到還原完成),不是只覆蓋「危險窗口」那幾行：
#   - 啟動時寫入 `{"pid": ..., "file": ..., "started_at": "<ISO8601>", "cmd": "..."}`
#   - **每一種**結束路徑都要刪掉它（正常結束、MutateError、SIGTERM/SIGINT——見下）
#   - 鎖存在時再跑一次：
#       * pid 還活著 → 拒絕，exit 7,「另一個 mutate 正在跑」
#       * pid 已死（上一次執行被 SIGKILL 或崩潰,沒機會清掉鎖）→ 拒絕,
#         exit 8,「殘留鎖(pid 已死):先 --recover」;帶 `--recover` 才繼續——
#         先用 `git show HEAD:<file>` 核對鎖記錄的目標檔跟 git HEAD 是否一致,
#         不一致就用 git blob 內容還原,再清掉鎖。
#
# `template/scripts/hooks/pre-commit`（S12 (b)）是這個鎖在 **commit 那一刻** 的
# 防線:即使某個流程忘了先跑過 `check:*`,鎖存在就直接擋下 `git commit` 本身。
# ---------------------------------------------------------------------------

LOCK_FILENAME = ".mutate.lock"

# SIGTERM/SIGINT 的訊號處理常式需要知道「現在有沒有已經取得的 `.mutate.lock`
# 要清」——跟上面 `_ACTIVE`（危險窗口的還原資訊)是分開的兩件事:`.mutate.lock`
# 覆蓋整次執行,`_ACTIVE` 只在套用突變之後、還原之前那段窗口存在。用一個獨立的
# 全域變數記録目前持有鎖的 repo root,訊號 handler 才能在**任何時間點**被打斷都
# 清得掉這個鎖,不只是危險窗口裡。
_LOCK_ROOT: Path | None = None


def _lock_path(root: Path) -> Path:
    return root / LOCK_FILENAME


def _pid_alive(pid: int) -> bool:
    """`pid` 這個行程是否還活著。`kill(pid, 0)` 不送任何訊號,只做存在性檢查
    （Unix 慣例)。權限不足(存在但不是同一個使用者)一律當作「還活著」——保守方向,
    不要因為讀不到別人行程的狀態就誤判成死掉,錯的方向後果比較輕(頂多多等一次
    `--recover`,不會誤刪還在跑的鎖)。"""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _write_lock(root: Path, file: str, cmd: str) -> None:
    global _LOCK_ROOT
    payload = {
        "pid": os.getpid(),
        "file": file,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cmd": cmd,
    }
    _lock_path(root).write_text(json.dumps(payload), encoding="utf-8")
    _LOCK_ROOT = root


def _release_lock(root: Path) -> None:
    global _LOCK_ROOT
    try:
        _lock_path(root).unlink(missing_ok=True)
    except Exception as e:  # pragma: no cover - 清鎖本身壞掉時別再拋例外蓋掉原本的結果
        print(f"[mutate.py] 警告:清除 {LOCK_FILENAME} 失敗({e}),請人工檢查。", file=sys.stderr)
    _LOCK_ROOT = None


def _recover_stale_lock(root: Path, data: dict) -> None:
    """`--recover`:驗證殘留鎖記錄的目標檔案內容是否跟 git HEAD 一致(用
    `git show HEAD:<file>` 讀 blob 內容比對,不用「兩個 dash 版的 checkout」——
    跟本檔其餘還原邏輯同一套紀律,見檔頭說明),不一致就還原,一致就跳過還原;
    不管有沒有真的還原,最後都把鎖刪掉。"""
    rel_path = data.get("file")
    if isinstance(rel_path, str) and rel_path:
        abs_path = (root / rel_path).resolve()
        if abs_path.is_file():
            try:
                head_sha = _run_git(root, ["rev-parse", f"HEAD:{rel_path}"])
                if head_sha.returncode == 0:
                    expected = _read_blob_bytes(root, head_sha.stdout.strip())
                    actual = abs_path.read_bytes()
                    if actual != expected:
                        abs_path.write_bytes(expected)
                        print(
                            f"[mutate.py] --recover:{rel_path} 的內容跟 git HEAD 不一致(疑似殘留突變),"
                            f"已用 git show HEAD:{rel_path} 還原。",
                            file=sys.stderr,
                        )
                    else:
                        print(f"[mutate.py] --recover:{rel_path} 的內容跟 git HEAD 一致,不需還原。", file=sys.stderr)
                else:
                    print(
                        f"[mutate.py] --recover:{rel_path} 不在 git HEAD(可能是新檔案),略過還原,只清鎖。",
                        file=sys.stderr,
                    )
            except Exception as e:  # pragma: no cover - 還原本身壞掉時仍要繼續清鎖,不要卡住
                print(f"[mutate.py] --recover:核對/還原 {rel_path} 時發生錯誤({e}),略過還原,只清鎖。", file=sys.stderr)
    _lock_path(root).unlink(missing_ok=True)
    print(f"[mutate.py] --recover:殘留鎖 {LOCK_FILENAME} 已清除。", file=sys.stderr)


def _acquire_lock(root: Path, file: str, cmd: str, recover: bool) -> None:
    lock_path = _lock_path(root)
    if lock_path.is_file():
        try:
            data = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = int(data["pid"])
        except Exception as e:
            raise MutateError(
                f"殘留鎖 {lock_path} 內容無法解析({e})——需要人工檢查後手動刪除,"
                "不會自動嘗試突變。",
                exit_code=8,
            )
        if _pid_alive(pid):
            raise MutateError(
                f"另一個 mutate 正在跑(pid {pid},檔案 {data.get('file')})",
                exit_code=7,
            )
        if not recover:
            raise MutateError(
                f"殘留鎖(pid {pid} 已死):先 --recover(檔案 {data.get('file')})",
                exit_code=8,
            )
        _recover_stale_lock(root, data)
    _write_lock(root, file, cmd)


# STORY-70-18：目前進行中的突變（若有）的還原資訊。只有 SIGTERM/SIGINT
# 這種可攔截的訊號才會用到它——SIGKILL 攔不到 handler，靠磁碟上的
# sentinel 檔在下一次執行時自癒（見 _self_heal）。
_ACTIVE: dict[str, object] | None = None


def _handle_kill_signal(signum: int, frame) -> None:  # noqa: ANN001 - signal handler signature
    state = _ACTIVE
    if state is not None:
        try:
            restored = _read_blob_bytes(state["root"], state["orig_sha"])  # type: ignore[arg-type]
            state["abs_path"].write_bytes(restored)  # type: ignore[union-attr]
        except Exception as e:  # pragma: no cover - 還原本身壞掉時別再拋例外
            print(
                f"[mutate.py] 收到訊號 {signum}，但緊急還原失敗（{e}）——"
                f"下次執行 mutate.py 時的自癒機制會再嘗試一次。",
                file=sys.stderr,
            )
        else:
            try:
                state["state_file"].unlink(missing_ok=True)  # type: ignore[union-attr]
            except Exception:  # pragma: no cover
                pass
            print(
                f"[mutate.py] 收到訊號 {signum}，已在結束前還原 "
                f"{state['rel_path']}（git show {state['orig_sha']}:"
                f"{state['rel_path']}）。",
                file=sys.stderr,
            )
    # S12：`os._exit()` 會跳過 Python 的 `finally` 區塊,`main()` 裡包住
    # `.mutate.lock` 的 try/finally 因此攔不到訊號這條路——鎖要在這裡自己清,
    # 不然這次執行被 SIGTERM/SIGINT 打斷之後,`.mutate.lock` 會永遠留在磁碟上,
    # 變成下一次呼叫要用 `--recover` 才能清掉的殘留鎖(pid 已死那條路),
    # 也會讓 pre-commit hook 一直誤判成「另一個 mutate 正在跑」直到有人手動處理。
    if _LOCK_ROOT is not None:
        try:
            (_LOCK_ROOT / LOCK_FILENAME).unlink(missing_ok=True)
        except Exception:  # pragma: no cover - 收尾清鎖失敗別再拋例外蓋掉訊號處理本身
            pass
    os._exit(128 + signum)


def _install_signal_handlers() -> None:
    signal.signal(signal.SIGTERM, _handle_kill_signal)
    signal.signal(signal.SIGINT, _handle_kill_signal)


def find_repo_root(start: Path | None = None) -> Path:
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], cwd=start or Path.cwd(),
        capture_output=True, text=True, check=False,
    )
    if r.returncode != 0:
        raise MutateError(f"目前位置不在一個 git repo 裡: {r.stderr.strip()}")
    return Path(r.stdout.strip())


def _run_git(root: Path, args: list[str], *, capture_bytes: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=root,
        capture_output=True, text=not capture_bytes, check=False,
    )


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ensure_tracked(root: Path, rel_path: str) -> None:
    r = _run_git(root, ["ls-files", "--error-unmatch", "--", rel_path])
    if r.returncode != 0:
        raise MutateError(
            f"{rel_path} 不受 git 追蹤（未 commit 過）——本工具的還原機制依賴 "
            f"git object，請先 commit 這個檔案再跑突變測試。\nstderr: {r.stderr}"
        )


def _has_uncommitted_changes(root: Path, rel_path: str) -> bool:
    r = _run_git(root, ["status", "--porcelain", "--", rel_path])
    if r.returncode != 0:
        raise MutateError(f"git status 失敗: {r.stderr}")
    return bool(r.stdout.strip())


def _wip_commit(root: Path, rel_path: str) -> None:
    """只 commit 這一個檔案，絕不動其他任何檔案（`git add -- <path>`，
    不是 `git add -A`），封存目標檔目前的未 commit 內容，讓後續的突變/還原
    有一個安全的還原點。"""
    r = _run_git(root, ["add", "--", rel_path])
    if r.returncode != 0:
        raise MutateError(f"git add {rel_path} 失敗: {r.stderr}")
    r = _run_git(root, [
        "commit", "-m",
        f"WIP(mutate.py): 突變測試前自動封存 {rel_path}（STORY-61-21）",
        "--", rel_path,
    ])
    if r.returncode != 0:
        raise MutateError(f"git commit {rel_path} 失敗: {r.stderr}")


def _git_dir(root: Path) -> Path:
    r = _run_git(root, ["rev-parse", "--git-dir"])
    if r.returncode != 0:
        raise MutateError(f"讀取 git-dir 失敗: {r.stderr}")
    p = Path(r.stdout.strip())
    return p if p.is_absolute() else (root / p)


def _state_dir(root: Path) -> Path:
    # 每個 worktree 的 --git-dir 都不同（worktree 的是
    # `<main>/.git/worktrees/<name>`），sentinel 天生不會跨 worktree 互相
    # 干擾，也不受 git 追蹤（不會被誤 commit）。
    return _git_dir(root) / "mutate-state"


def _state_file_for(root: Path, rel_path: str) -> Path:
    key = hashlib.sha256(rel_path.encode("utf-8")).hexdigest()[:16]
    return _state_dir(root) / f"{key}.json"


def _write_state_file(root: Path, rel_path: str, orig_sha: str) -> Path:
    state_file = _state_file_for(root, rel_path)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(
        json.dumps({"rel_path": rel_path, "orig_sha": orig_sha, "pid": os.getpid()}),
        encoding="utf-8",
    )
    return state_file


def _self_heal(root: Path) -> None:
    """STORY-70-18：在做任何事之前，先檢查有沒有上一次執行留下的、未還原
    完成的突變（SIGKILL 讓 signal handler 完全來不及跑時就會發生）。有就
    先還原、印出訊息、刪除 sentinel，再讓這次呼叫繼續往下跑——下一次
    呼叫本身就是自癒點，不靠使用者記得。"""
    state_dir = _state_dir(root)
    if not state_dir.is_dir():
        return
    for state_file in sorted(state_dir.glob("*.json")):
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            rel_path = data["rel_path"]
            orig_sha = data["orig_sha"]
        except Exception as e:
            raise MutateError(
                f"偵測到上次執行留下的自癒狀態檔 {state_file} 但內容無法解析"
                f"（{e}）——不會自動嘗試突變。請人工檢查該檔案內容，找到 "
                f"rel_path/orig_sha 後執行「git show <orig_sha>:<rel_path> > "
                f"<rel_path>」手動還原，確認 `git status` 乾淨後刪除 "
                f"{state_file}，再重跑本工具。",
                exit_code=5,
            )
        abs_path = root / rel_path
        restored = _read_blob_bytes(root, orig_sha)
        abs_path.write_bytes(restored)
        state_file.unlink()
        print(
            f"[mutate.py] 自癒：偵測到上次執行未完成的突變殘留（{rel_path}，"
            f"可能死於 SIGKILL 或崩潰），已用 git show {orig_sha}:{rel_path} "
            f"還原並刪除殘留狀態檔 {state_file.name}。",
            file=sys.stderr,
        )


def _blob_sha(root: Path, rel_path: str) -> str:
    r = _run_git(root, ["rev-parse", f"HEAD:{rel_path}"])
    if r.returncode != 0:
        raise MutateError(f"讀取 HEAD:{rel_path} 的 git blob sha 失敗: {r.stderr}")
    return r.stdout.strip()


def _read_blob_bytes(root: Path, sha: str) -> bytes:
    r = _run_git(root, ["show", sha], capture_bytes=True)
    if r.returncode != 0:
        raise MutateError(f"git show {sha} 失敗: {r.stderr}")
    return r.stdout


def _find_occurrence_offsets(text: str, needle: str) -> list[int]:
    """回傳 needle 在 text 裡每一次出現的字元 offset（非重疊，語義對齊
    `str.count`——`str.count` 也是非重疊計數，兩者算出的次數必須一致，
    否則 --nth 選中的位置會跟使用者以為的「第幾次出現」對不上。"""
    offsets: list[int] = []
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            break
        offsets.append(idx)
        start = idx + len(needle)
    return offsets


def _offset_to_line(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _run_pytest(root: Path, node_id: str) -> subprocess.CompletedProcess:
    # STORY-70-13：突變前後兩次 pytest 是各自獨立的 subprocess，中間只隔著
    # 一次檔案寫入。若目標檔的 __pycache__ 沿用 32-bit 整數秒精度的 mtime
    # 比對，兩次呼叫落在同一秒內就會讓突變後那次 import 到突變前殘留的舊
    # bytecode，讓真正會讓測試變紅的突變被靜默吃掉（實測會重現、非恆定發
    # 生——時機取決於執行速度）。禁止這兩次呼叫寫入/沿用任何 .pyc，確保
    # 突變後永遠從磁碟上「當下」的原始碼重新編譯。
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, "-m", "pytest", node_id, "-q"],
        cwd=root, capture_output=True, text=True, check=False,
        env=env,
    )


def run_mutation(
    *, root: Path, file: str, replace: str, with_: str, expect_fail: str,
    nth: int | None = None,
) -> int:
    global _ACTIVE
    # STORY-70-18：在動任何東西之前，先處理上一次執行可能留下的爛攤子
    # （SIGKILL 讓下面註冊的 signal handler 完全來不及跑）。
    _self_heal(root)
    _install_signal_handlers()

    abs_path = (root / file).resolve()
    if not abs_path.is_file():
        raise MutateError(f"檔案不存在: {file}", exit_code=1)

    rel_path = str(abs_path.relative_to(root))
    _ensure_tracked(root, rel_path)

    committed_wip = False
    if _has_uncommitted_changes(root, rel_path):
        _wip_commit(root, rel_path)
        committed_wip = True

    orig_sha = _blob_sha(root, rel_path)
    orig_bytes = abs_path.read_bytes()
    orig_hash = _sha256(orig_bytes)

    # 保險：git blob 內容必須真的等於目前檔案內容（committed_wip 分支剛
    # commit 過理應一致；否則代表工作區跟 index/HEAD 有本工具沒預期到的
    # 落差，寧可提早失敗也不要在錯的基準上做突變）。
    blob_bytes = _read_blob_bytes(root, orig_sha)
    if blob_bytes != orig_bytes:
        raise MutateError(
            "內部一致性檢查失敗：git blob 內容與檔案目前內容不同，拒絕繼續 "
            "（可能代表檔案已被 commit 之外的方式修改）。未套用任何突變。",
            exit_code=1,
        )

    orig_text = orig_bytes.decode("utf-8")
    offsets = _find_occurrence_offsets(orig_text, replace)
    occurrences = len(offsets)
    if occurrences == 0:
        raise MutateError(
            f"在 {rel_path} 裡找不到 --replace 指定的字面字串，未套用任何突變：\n"
            f"  {replace!r}",
            exit_code=1,
        )

    # STORY-70-14：occurrences 算出來卻只拿去擋 0 的舊版本，真正套用突變時
    # 用 str.replace() 把每一處符合的字串都改掉——測試變紅之後無法歸因到
    # 工單宣稱的那一個位置，稀釋了「證明有牙」的證據力。因此 occurrences
    # 不是 1 時一律拒絕執行（除非明確給 --nth 指定要動第幾處）。
    if nth is None:
        if occurrences != 1:
            line_numbers = [_offset_to_line(orig_text, o) for o in offsets]
            raise MutateError(
                f"--replace 指定的字串在 {rel_path} 出現 {occurrences} 次（非唯一），"
                f"無法歸因是哪一處被突變，未套用任何突變。出現的行號：{line_numbers}。"
                f"請改用只出現一次的字串，或加 --nth N 明示要突變第幾處。",
                exit_code=1,
            )
        target_offset = offsets[0]
    else:
        if nth < 1 or nth > occurrences:
            raise MutateError(
                f"--nth {nth} 超出範圍：--replace 指定的字串在 {rel_path} "
                f"只出現 {occurrences} 次。",
                exit_code=1,
            )
        target_offset = offsets[nth - 1]

    # 「綠 → 紅」而非只看「紅」：機器負載高時，測試可能因為 timeout／
    # 環境問題本身就是紅的，或因為 collection error/interrupted 這類跟
    # 斷言邏輯無關的原因回非 0——那種「紅」不能證明突變真的生效，反而會
    # 製造假的突變測試通過紀錄（正是紅線 3 想擋的事，只是換了個方向）。
    # 先在**突變前**跑一次同一個 node id，要求它是乾淨的 0（真的綠、真的
    # 有被收集到），沒有這個基準就沒資格宣稱後面的紅是突變造成的。
    print(f"[mutate.py] 突變前先跑一次基準（應為綠）: {expect_fail}")
    baseline = _run_pytest(root, expect_fail)
    print(f"[mutate.py] 基準 pytest exit code = {baseline.returncode}")
    if baseline.returncode != 0:
        raise MutateError(
            f"{expect_fail} 在套用突變之前就不是綠的（exit code "
            f"{baseline.returncode}）——這個測試不是有效的突變測試基準，"
            f"無法證明後面的紅是突變造成還是本來就紅（或環境問題）。"
            f"未套用任何突變。\npytest 輸出尾段:\n"
            + "\n".join(baseline.stdout.splitlines()[-20:]),
            exit_code=1,
        )

    mutated_text = (
        orig_text[:target_offset] + with_ + orig_text[target_offset + len(replace):]
    )

    # STORY-70-18：從這裡開始到還原完成之前是「危險窗口」——sentinel 檔
    # 跟 _ACTIVE 必須在寫壞檔案**之前**就位，這樣就算訊號剛好卡在寫檔那一
    # 行也還原得回來（sentinel 記的是還原用的 blob sha，不是「已套用突
    # 變」的旗標，寫兩次還原也是還原到同一份乾淨內容，安全）。
    state_file = _write_state_file(root, rel_path, orig_sha)
    _ACTIVE = {
        "root": root, "abs_path": abs_path, "rel_path": rel_path,
        "orig_sha": orig_sha, "state_file": state_file,
    }

    print(f"[mutate.py] 已封存基準（WIP commit: {committed_wip}），blob sha = {orig_sha}")
    print(
        f"[mutate.py] 套用突變於 {rel_path}（共 {occurrences} 處出現，"
        f"只取代第 {nth or 1} 處，行號 {_offset_to_line(orig_text, target_offset)}）"
    )
    print(f"[mutate.py] 跑測試（突變後）: {expect_fail}")

    try:
        abs_path.write_text(mutated_text, encoding="utf-8")
        result = _run_pytest(root, expect_fail)
        # pytest exit code：0=全過，1=有斷言失敗，2=中斷，3=內部錯誤，
        # 4=用法錯誤，5=沒收集到測試。只有 1（真的斷言失敗）才算「因為
        # 正確的原因變紅」；2/3/4/5 代表這次執行本身不可信（可能是
        # timeout 或環境問題造成的假紅），不能當成突變生效的證據。
        print(f"[mutate.py] 突變後 pytest exit code = {result.returncode}")
        tail = "\n".join(result.stdout.splitlines()[-20:])
        print(f"[mutate.py] pytest 輸出（尾 20 行）:\n{tail}")
        outcome = (
            "assertion_failed" if result.returncode == 1
            else "passed" if result.returncode == 0
            else "inconclusive"
        )
    finally:
        # 無論測試跑成怎樣（含拋例外），都一定要走到還原這一步——
        # 這是紅線 2「未 commit 變更未被封存前絕不修改檔案」的另一半：
        # 已修改的檔案絕不能因為中途出錯就留在突變狀態。
        restored_bytes = _read_blob_bytes(root, orig_sha)
        abs_path.write_bytes(restored_bytes)
        restored_hash = _sha256(restored_bytes)
        # 危險窗口結束：sentinel 已經沒用了，刪掉；訊號 handler 之後不該
        # 再對這個（已經還原過的）檔案做任何事。
        state_file.unlink(missing_ok=True)
        _ACTIVE = None
        if restored_hash != orig_hash:
            print(
                f"[mutate.py] 嚴重錯誤：還原後 hash 不一致！"
                f"\n  預期: {orig_hash}\n  實際: {restored_hash}",
                file=sys.stderr,
            )
            return 3
        print(f"[mutate.py] 已用 git show {orig_sha}:{rel_path} 還原，hash 比對一致（{restored_hash}）")

    if outcome == "passed":
        print(
            f"[mutate.py] 突變測試無效：套用突變後 {expect_fail} 仍然通過"
            f"（exit code 0，且突變前也是綠的，不是環境問題）——這個突變"
            f"沒有測到任何東西。檔案已安全還原，但這代表 --replace/--with "
            f"或 --expect-fail 需要重新設計。",
            file=sys.stderr,
        )
        return 2

    if outcome == "inconclusive":
        print(
            f"[mutate.py] 無法判定：突變後 pytest exit code = {result.returncode}"
            f"（不是 0 也不是 1，代表中斷/內部錯誤/用法錯誤/沒收集到測試，"
            f"不是真的斷言失敗）——負載高的機器上常見成因是 timeout 或環境"
            f"問題，不能當成突變生效的證據。檔案已安全還原，請確認機器負載"
            f"、換一個更穩定的目標測試，或稍後重試。",
            file=sys.stderr,
        )
        return 4

    print(
        f"[mutate.py] 突變測試通過：{expect_fail} 突變前綠、突變後真的因斷言"
        f"失敗變紅（exit code 1，非 timeout/環境問題），已安全還原並驗證一致。"
    )
    return 0


def _run_cmd(root: Path, cmd: str) -> subprocess.CompletedProcess:
    # --cmd 允許任意語言的指令（這正是它存在的理由：consumer 想直接對 check-*.ts
    # 這類沒有獨立 pytest node id 的守門腳本做突變測試，不限本專案的 Python 程式碼）。
    # 沒辦法像 _run_pytest() 那樣精準地只對 pytest 下旗標，但把
    # PYTHONDONTWRITEBYTECODE=1 一律設進環境變數是無害的：指令若剛好也呼叫了
    # Python，一樣受惠於「不沿用 .pyc」的保護（見 STORY-70-13）；指令是其他語言，
    # 這個環境變數就只是被忽略。
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        cmd, shell=True, cwd=root, capture_output=True, text=True, check=False, env=env,
    )


def run_mutation_cmd(
    *, root: Path, file: str, replace: str, with_: str, cmd: str,
    nth: int | None = None,
) -> int:
    """跟 run_mutation() 平行的 `--cmd` 版本（來源：AI_KM 的請求）——差別只在「拿什麼
    判斷突變有沒有生效」:不是跑一個 pytest node id、看斷言是不是真的變紅,而是跑一整條
    使用者自訂的 shell 指令、看退出碼是不是非零。用在被突變的目標**不是**用 pytest 驗收
    的情境(例如本模板的 check-*.ts,反向驗證要靠跑 `npx tsx` 或 `npx vitest`,不是
    pytest node id)。

    四個步驟(比 `--expect-fail` 模式多一步):
      1. 突變**前**跑一次 `--cmd`,要求 exit 0——不是就代表這個指令本身不是有效的
         基準,「突變前就紅,無法判讀」,未套用任何突變(對應 exit code 1)。
      2. 套用突變,再跑一次 `--cmd`,要求非 0——是 0 的話代表「突變存活」,這個突變
         沒有被任何東西測到(對應 exit code 2,語意跟 `--expect-fail` 模式的 exit 2
         一致)。
      3. 用 `git show <sha>:<path>` 還原,sha256 比對,跟 run_mutation() 一樣嚴格
         (對應 exit code 3——理論上不應發生,見 run_mutation() 的說明)。
      4. 還原之後**再跑一次** `--cmd`,要求 exit 0——這是 `--expect-fail` 模式沒有的
         額外一步:任意 shell 指令可能有超出「這個檔案的內容」的殘留狀態(建置快取、
         背景行程之類),只比對 sha256 不足以證明「一切都跟突變前一樣」,所以多驗一次
         「指令本身跑起來也一樣是綠的」。這一步紅了不代表突變沒被抓到(第 2 步已經
         證明抓到了),是「還原之後環境沒有完全恢復原狀」,獨立的一種問題,對應新的
         exit code 6(`--expect-fail` 模式沒有這個 exit code,因為 pytest node id
         沒有這種「指令本身有超出檔案內容的副作用」的疑慮)。

    `--cmd` 模式沒有 `--expect-fail` 模式的「inconclusive」(exit 4)概念:任意 shell
    指令只有 exit 0 / 非 0 兩種狀態可以區分,沒有 pytest 那種「1 = 斷言失敗、
    2/3/4/5 = 中斷/內部錯誤/用法錯誤/沒收集到測試」的細分——第 2 步只要求「非 0」,
    不細究是哪一種非 0。
    """
    global _ACTIVE
    _self_heal(root)
    _install_signal_handlers()

    abs_path = (root / file).resolve()
    if not abs_path.is_file():
        raise MutateError(f"檔案不存在: {file}", exit_code=1)

    rel_path = str(abs_path.relative_to(root))
    _ensure_tracked(root, rel_path)

    committed_wip = False
    if _has_uncommitted_changes(root, rel_path):
        _wip_commit(root, rel_path)
        committed_wip = True

    orig_sha = _blob_sha(root, rel_path)
    orig_bytes = abs_path.read_bytes()
    orig_hash = _sha256(orig_bytes)

    blob_bytes = _read_blob_bytes(root, orig_sha)
    if blob_bytes != orig_bytes:
        raise MutateError(
            "內部一致性檢查失敗：git blob 內容與檔案目前內容不同，拒絕繼續 "
            "（可能代表檔案已被 commit 之外的方式修改）。未套用任何突變。",
            exit_code=1,
        )

    orig_text = orig_bytes.decode("utf-8")
    offsets = _find_occurrence_offsets(orig_text, replace)
    occurrences = len(offsets)
    if occurrences == 0:
        raise MutateError(
            f"在 {rel_path} 裡找不到 --replace 指定的字面字串，未套用任何突變：\n"
            f"  {replace!r}",
            exit_code=1,
        )

    if nth is None:
        if occurrences != 1:
            line_numbers = [_offset_to_line(orig_text, o) for o in offsets]
            raise MutateError(
                f"--replace 指定的字串在 {rel_path} 出現 {occurrences} 次（非唯一），"
                f"無法歸因是哪一處被突變，未套用任何突變。出現的行號：{line_numbers}。"
                f"請改用只出現一次的字串，或加 --nth N 明示要突變第幾處。",
                exit_code=1,
            )
        target_offset = offsets[0]
    else:
        if nth < 1 or nth > occurrences:
            raise MutateError(
                f"--nth {nth} 超出範圍：--replace 指定的字串在 {rel_path} "
                f"只出現 {occurrences} 次。",
                exit_code=1,
            )
        target_offset = offsets[nth - 1]

    print(f"[mutate.py] 突變前先跑一次基準指令（應為綠）: {cmd}")
    baseline = _run_cmd(root, cmd)
    print(f"[mutate.py] 基準指令 exit code = {baseline.returncode}")
    if baseline.returncode != 0:
        raise MutateError(
            f"--cmd 指定的指令在套用突變之前就不是綠的（exit code "
            f"{baseline.returncode}）——突變前就紅，無法判讀。未套用任何突變。\n"
            "指令輸出尾段:\n"
            + "\n".join((baseline.stdout + baseline.stderr).splitlines()[-20:]),
            exit_code=1,
        )

    mutated_text = (
        orig_text[:target_offset] + with_ + orig_text[target_offset + len(replace):]
    )

    state_file = _write_state_file(root, rel_path, orig_sha)
    _ACTIVE = {
        "root": root, "abs_path": abs_path, "rel_path": rel_path,
        "orig_sha": orig_sha, "state_file": state_file,
    }

    print(f"[mutate.py] 已封存基準（WIP commit: {committed_wip}），blob sha = {orig_sha}")
    print(
        f"[mutate.py] 套用突變於 {rel_path}（共 {occurrences} 處出現，"
        f"只取代第 {nth or 1} 處，行號 {_offset_to_line(orig_text, target_offset)}）"
    )
    print(f"[mutate.py] 跑指令（突變後）: {cmd}")

    try:
        abs_path.write_text(mutated_text, encoding="utf-8")
        result = _run_cmd(root, cmd)
        print(f"[mutate.py] 突變後指令 exit code = {result.returncode}")
        tail = "\n".join((result.stdout + result.stderr).splitlines()[-20:])
        print(f"[mutate.py] 指令輸出（尾 20 行）:\n{tail}")
        survived = result.returncode == 0
    finally:
        # 無論指令跑成怎樣（含拋例外），都一定要走到還原這一步——這是紅線 2
        # 「未 commit 變更未被封存前絕不修改檔案」的另一半：已修改的檔案絕不能因為
        # 中途出錯就留在突變狀態。
        restored_bytes = _read_blob_bytes(root, orig_sha)
        abs_path.write_bytes(restored_bytes)
        restored_hash = _sha256(restored_bytes)
        state_file.unlink(missing_ok=True)
        _ACTIVE = None
        if restored_hash != orig_hash:
            print(
                f"[mutate.py] 嚴重錯誤：還原後 hash 不一致！"
                f"\n  預期: {orig_hash}\n  實際: {restored_hash}",
                file=sys.stderr,
            )
            return 3
        print(f"[mutate.py] 已用 git show {orig_sha}:{rel_path} 還原，hash 比對一致（{restored_hash}）")

    if survived:
        print(
            "[mutate.py] 突變存活：套用突變後指令仍然通過（exit code 0，且突變前也是"
            "綠的，不是「突變前就紅」）——這個突變沒有被 --cmd 指定的指令測到。"
            "檔案已安全還原，但這代表這個突變目標需要重新設計，或是 --cmd 指到的指令"
            "覆蓋範圍不夠。",
            file=sys.stderr,
        )
        # 語意對應 run_mutation() 的退出碼(「突變沒有讓測試變紅」那一碼)——刻意不用
        # 字面的 return 語句直接寫那個數字：mutate.py 自己就是本檔的突變測試目標
        # (見 test_ac7/test_ac8)，`--replace` 是逐字串比對,兩處字面相同的字串會讓
        # 那組 meta 測試找到多個出現位置、拒絕執行(「非唯一」)。用具名變數繞開巧合,
        # 語意也更清楚——數字本身寫在下面這一行。
        cmd_mode_survived_exit_code = 2
        return cmd_mode_survived_exit_code

    # 第 4 步:還原之後再跑一次,確認指令本身也真的回到「乾淨的綠」,不只是檔案內容
    # 的 sha256 對得上——見這個函式的 docstring。
    print(f"[mutate.py] 還原後再跑一次指令（應為綠）: {cmd}")
    post_restore = _run_cmd(root, cmd)
    print(f"[mutate.py] 還原後指令 exit code = {post_restore.returncode}")
    if post_restore.returncode != 0:
        print(
            f"[mutate.py] 還原後指令仍為紅（exit code {post_restore.returncode}）——"
            "檔案內容的 sha256 已經比對一致，但指令本身還是紅的，可能有超出檔案內容"
            "的殘留影響（例如建置快取、背景行程）。請人工檢查環境。\n"
            "指令輸出尾段:\n"
            + "\n".join((post_restore.stdout + post_restore.stderr).splitlines()[-20:]),
            file=sys.stderr,
        )
        return 6

    print(
        f"[mutate.py] 突變測試通過（--cmd 模式）：指令突變前綠、突變後真的變紅"
        f"（exit code {result.returncode}），已安全還原、hash 比對一致，還原後指令也再次確認是綠的。"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="安全的突變測試驅動工具（不用兩個 dash 版的 checkout 還原，見 STORY-61-21）",
    )
    parser.add_argument("--file", required=True, help="要突變的檔案路徑（相對 repo 根目錄）")
    parser.add_argument("--replace", required=True, help="要被取代的字面字串（非 regex）")
    parser.add_argument("--with", dest="with_", required=True, help="取代成的字面字串")
    mode_group = parser.add_mutually_exclusive_group(required=True)
    mode_group.add_argument(
        "--expect-fail",
        help="套用突變後應該變紅的 pytest node id，例如 tests/foo.py::test_bar。"
             "跟 --cmd 互斥，只能給一個。",
    )
    mode_group.add_argument(
        "--cmd",
        help="套用突變後應該變紅的任意 shell 指令（不限 pytest，例如 "
             "'npx vitest run scripts/check-boundaries.test.ts'）。跟 --expect-fail 互斥。"
             "流程：突變前跑一次要求 exit 0（否則「突變前就紅，無法判讀」），突變後跑一次"
             "要求非 0（否則「突變存活」），還原後再跑一次要求 exit 0 才算通過。",
    )
    parser.add_argument("--nth", type=int, default=None,
                        help="--replace 字串出現多次時，明示要突變第幾處（1-indexed）。"
                             "省略時要求 --replace 只能出現恰好一次，否則拒絕執行。")
    parser.add_argument(
        "--recover", action="store_true",
        help="S12：`.mutate.lock` 是殘留鎖（pid 已死,上一次執行被 SIGKILL 或崩潰沒機會"
             "清掉)時,才需要這個旗標——核對鎖記錄的目標檔跟 git HEAD 是否一致、不一致"
             "就用 git show 還原,再清掉鎖,然後繼續往下跑這次的突變。鎖屬於還活著的"
             "行程時,這個旗標不生效(exit 7,不是殘留鎖的情境)。",
    )
    args = parser.parse_args(argv)

    try:
        root = find_repo_root()
    except MutateError as e:
        print(f"[mutate.py] 錯誤: {e}", file=sys.stderr)
        return e.exit_code

    # S12：`.mutate.lock` 覆蓋整次執行(不只是套用突變之後的危險窗口)——啟動時取得,
    # 不管接下來走哪條路(正常結束、MutateError、或被 os._exit 直接結束的訊號路徑,
    # 見 `_handle_kill_signal`)都要清掉,所以用 try/finally 包住整個突變流程。
    cmd_desc = args.cmd if args.cmd is not None else f"--expect-fail {args.expect_fail}"
    try:
        _acquire_lock(root, args.file, cmd_desc, args.recover)
    except MutateError as e:
        print(f"[mutate.py] 錯誤: {e}", file=sys.stderr)
        return e.exit_code

    try:
        if args.cmd is not None:
            return run_mutation_cmd(
                root=root, file=args.file, replace=args.replace, with_=args.with_,
                cmd=args.cmd, nth=args.nth,
            )
        return run_mutation(
            root=root, file=args.file, replace=args.replace, with_=args.with_,
            expect_fail=args.expect_fail, nth=args.nth,
        )
    except MutateError as e:
        print(f"[mutate.py] 錯誤: {e}", file=sys.stderr)
        return e.exit_code
    finally:
        _release_lock(root)


if __name__ == "__main__":
    sys.exit(main())
