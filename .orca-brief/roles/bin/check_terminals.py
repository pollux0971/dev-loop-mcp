#!/usr/bin/env python3
"""dev-paradigm 接線 agent:掃 Orca 終端,找「看起來做完」或「卡住」而且還沒回報過的 worker。

改自 AI_KM ai-km-15 的最終版(它是漏抓幾次才補齊 marker 的,這裡直接用完整版)。
讀 <state>/dev.json(`orca-ide terminal list --json` 的輸出),跟 <state>/seen.txt(handle|lastOutputAt)去重,
只在有新東西時印一整塊;沒東西完全不印,Monitor 才不會每輪吵。

只看 worker lane:~/orca/workspaces/dev-paradigm/ 底下。主 checkout(協調者/顧問的互動 session)
在兩輪對話之間也會顯示 "done 下午" 之類字樣,放進來會爆量誤報,所以完全排除。
"""
import json
import os
import sys
import time

STATE_DIR = sys.argv[1]
SEEN_FILE = os.path.join(STATE_DIR, "seen.txt")
WORKER_LANE = os.path.expanduser("~/orca/workspaces/dev-paradigm/")
# codex 閒置時畫面只剩 "› Ask Codex to do anything",AI_KM 版沒這條(它用 preview 其他字樣抓到);本機實測 2026-09-14 補上。
# 常駐 session 自己的 worktree:就算落在 worker lane 底下也不掃
PROTECTED_NAMES = {"integrate"}
IDLE_MIN = 3.0

DONE_MARKERS = [
    "REVIEW VERDICT", "Ask Codex to do anything", "Worked for", "worked for", "已完成", "完成並提交", "DONE", "RETURN",
    "Commit：", "Commit:", "commit hash", "提交",
    "new task?", "done 上午", "done 下午", "Churned for", "Baked for", "Cooked for",
    "Sauteed for", "Sautéed for", "Cogitated for", "Crunched for",
]
STUCK_MARKERS = [
    "Action Required", "action required", "approve", "Approve",
    "trust this folder", "Trust the files", "(y/n)", "[y/N]", "Yes, and don't ask again",
    "rate limit", "usage limit", "quota",
]


def load_terms(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data.get("result", {}).get("terminals", [])
    except Exception:
        return []


def main():
    now_ms = int(time.time() * 1000)
    try:
        with open(SEEN_FILE) as f:
            seen = {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        seen = set()

    rows, new_keys = [], []
    for t in load_terms(os.path.join(STATE_DIR, "dev.json")):
        path = (t.get("worktreePath") or "").rstrip("/")
        if not path.startswith(WORKER_LANE.rstrip("/") + "/"):
            continue
        name = path.split("/")[-1]
        if name in PROTECTED_NAMES:
            continue
        handle, lo = t.get("handle"), t.get("lastOutputAt")
        if not handle or not lo:
            continue
        idle = (now_ms - lo) / 60000
        preview = t.get("preview") or ""
        is_stuck = any(m in preview for m in STUCK_MARKERS)
        is_done = any(m in preview for m in DONE_MARKERS)
        if idle < IDLE_MIN or not (is_done or is_stuck):
            continue
        key = f"{handle}|{lo}"
        if key in seen:
            continue
        kind = "STUCK" if is_stuck else "DONE"
        branch = (t.get("branch") or "").replace("refs/heads/", "")
        tail = preview.replace("\n", " ")[-260:]
        rows.append(f"[{kind}] {name} (branch={branch}, agent={t.get('agentIdentity') or ''}, "
                    f"idle={idle:.1f}m, handle={handle})\n    {tail}")
        new_keys.append(key)

    # agent TUI(尤其 claude)的狀態列每秒重繪,lastOutputAt 永遠是 0 分、preview 只剩狀態列——
    # 用終端判斷會永遠抓不到 claude 審核棒交件(2026-09-15 實測)。改用交件檔當第二訊號:
    # worker lane 裡 .orca-brief/<worktree名>-REPORT.md(或 worker 誤寫的 REVIEW.md)含 REVIEW VERDICT
    # 且檔案 ≥3 分鐘沒再改 → DONE。key 用 path|mtime,檔案再改會再報一次。
    lane = WORKER_LANE.rstrip("/")
    try:
        names = sorted(os.listdir(lane))
    except FileNotFoundError:
        names = []
    for name in names:
        if name in PROTECTED_NAMES:
            continue
        for fname in (f"{name}-REPORT.md", "REVIEW.md"):
            rp = os.path.join(lane, name, ".orca-brief", fname)
            try:
                st = os.stat(rp)
                with open(rp, encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
            verdicts = [l.strip() for l in text.splitlines() if "REVIEW VERDICT" in l]
            if not verdicts or (now_ms / 1000 - st.st_mtime) / 60 < IDLE_MIN:
                continue
            key = f"{rp}|{int(st.st_mtime)}"
            if key in seen:
                continue
            rows.append(f"[DONE] {name} (report={rp}, idle={(now_ms / 1000 - st.st_mtime) / 60:.1f}m)\n    {verdicts[-1][-260:]}")
            new_keys.append(key)

    if rows:
        print(f"=== wiring-scan {time.strftime('%H:%M:%S')} — {len(rows)} new item(s) ===")
        print("\n".join(rows))
        with open(SEEN_FILE, "a") as f:
            f.writelines(k + "\n" for k in new_keys)


if __name__ == "__main__":
    main()
