#!/usr/bin/env bash
# 接線 agent 的常駐 Monitor 本體:每 150 秒拍一次終端快照,交給 check_terminals.py 判斷。
STATE_DIR=/data/python/dev-paradigm-briefs/wiring-state
mkdir -p "$STATE_DIR"
while true; do
  orca-ide terminal list --json > "$STATE_DIR/dev.json" 2>/dev/null
  python3 /data/python/dev-paradigm/.orca-brief/roles/bin/check_terminals.py "$STATE_DIR"
  sleep 150
done
