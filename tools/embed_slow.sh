#!/bin/sh
# 새로 넣은 법령의 뜻 지문(emb)을 천천히 만든다 — Voyage 무료 계정은 분당 3회라 3개씩 보내고 21초 쉰다 (CLAUDE.md 「뜻 검색」)
#   sh tools/embed_slow.sh <lawId> [<lawId> …]      기록: ~/.yakktime-uitest/real/embed.log
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"; PK=$(grep -o 'sb_publishable_[A-Za-z0-9_-]*' "$APP/app.js" | head -1)
B="https://mkwcqnqfidlvsrlximbw.supabase.co/functions/v1/law-embed"; LOG="$HOME/.yakktime-uitest/real/embed.log"
for ID in "$@"; do
  for i in $(seq 1 400); do
    OUT=$(curl -s -X POST "$B" -H "apikey: $PK" -H "Authorization: Bearer $PK" -H "Content-Type: application/json" -d "{\"op\":\"run\",\"lawId\":\"$ID\",\"max\":3,\"slow\":true}")
    echo "$(date +%H:%M:%S) $ID $OUT" >> "$LOG"
    echo "$OUT" | grep -q '"remaining":0' && break
    if echo "$OUT" | grep -q '"retryAfter"'; then sleep 30; else sleep 21; fi
  done
done
tail -n 2 "$LOG"
