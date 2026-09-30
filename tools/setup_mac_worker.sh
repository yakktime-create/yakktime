#!/bin/sh
# 맥 AI 일꾼 설치 — 토큰 파일 하나로 서버 준비까지 끝낸다 (2026-09-28)
#   1) /토큰넣기 로 ~/.yakktime-supabase-token (sbp_… 개인 액세스 토큰) 을 넣은 뒤
#   2) sh tools/setup_mac_worker.sh
# 하는 일: service_role 열쇠를 받아 ~/.yakktime-service-key 에 저장(600) → ai_jobs 표 만들기(SQL) →
#          law-pick · law-draft 배포 → launchd 에 일꾼 등록·시작 → 심장박동 확인.
# 토큰·열쇠는 화면에 찍지 않는다.
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"; REF=mkwcqnqfidlvsrlximbw
T=$(tr -d '[:space:]' < "$HOME/.yakktime-supabase-token")
H="Authorization: Bearer $T"; UA="User-Agent: curl/8.4"
code=$(curl -s -o /dev/null -w "%{http_code}" "https://api.supabase.com/v1/projects/$REF/functions" -H "$H" -H "$UA")
[ "$code" = "200" ] || { echo "토큰이 죽었어요(HTTP $code) — /토큰넣기 로 새 토큰"; exit 1; }

echo "1) service_role 열쇠 → ~/.yakktime-service-key"
curl -s "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true" -H "$H" -H "$UA" \
  | python3 -c "import json,sys; print([x for x in json.load(sys.stdin) if x.get('name')=='service_role'][0]['api_key'])" > "$HOME/.yakktime-service-key"
chmod 600 "$HOME/.yakktime-service-key"; echo "   저장됨 ($(wc -c < "$HOME/.yakktime-service-key") 바이트)"

echo "2) ai_jobs 표"
python3 - "$APP/OPUS 4.8 생성/ai_jobs-테이블추가.sql" <<'PY' > /tmp/sql.json
import json,sys; print(json.dumps({"query": open(sys.argv[1],encoding="utf-8").read()}))
PY
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H "$H" -H "$UA" -H "Content-Type: application/json" --data @/tmp/sql.json -o /tmp/sql.out -w "   HTTP %{http_code}\n"; head -c 200 /tmp/sql.out; echo; rm -f /tmp/sql.json

for FN in law-pick law-draft; do
  echo "3) $FN 배포"
  python3 - "$APP/supabase/functions/$FN/index.ts" <<'PY' > /tmp/fn.json
import json,sys; print(json.dumps({"body": open(sys.argv[1],encoding="utf-8").read(), "verify_jwt": True}))
PY
  curl -s -X PATCH "https://api.supabase.com/v1/projects/$REF/functions/$FN" -H "$H" -H "$UA" -H "Content-Type: application/json" --data @/tmp/fn.json -o /tmp/fn.out -w "   HTTP %{http_code}\n"
  python3 -c "import json; d=json.load(open('/tmp/fn.out')); print('   ', d.get('slug'), 'v', d.get('version'), d.get('status'))" 2>/dev/null || head -c 200 /tmp/fn.out
  rm -f /tmp/fn.json /tmp/fn.out
done

echo "4) launchd 에 일꾼 등록"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/.yakktime"
# launchd 가 띄운 프로그램은 iCloud 폴더를 못 연다 → 일꾼 스크립트를 밖에 복사해 둔다(고칠 때마다 이 스크립트를 다시 돌린다)
cp "$APP/tools/ai_worker.py" "$HOME/.yakktime/ai_worker.py"
cp "$APP/tools/com.yakktime.aiworker.plist" "$HOME/Library/LaunchAgents/"
launchctl unload "$HOME/Library/LaunchAgents/com.yakktime.aiworker.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.yakktime.aiworker.plist"
sleep 6
echo "5) 심장박동"
K=$(cat "$HOME/.yakktime-service-key")
curl -s "https://$REF.supabase.co/rest/v1/ai_jobs?id=eq.00000000-0000-0000-0000-000000000001&select=status,updated_at" -H "apikey: $K" -H "Authorization: Bearer $K"; echo
tail -3 "$HOME/Library/Logs/yakktime-ai-worker.log" 2>/dev/null || true
echo "끝. 이제 토큰을 Revoke 해도 돼요(일꾼은 service_role 열쇠 파일로 돈다)."
