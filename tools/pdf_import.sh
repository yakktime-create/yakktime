#!/bin/sh
# 지침서 PDF 를 앱의 진짜 올리기 코드(lawUpload)로 넣는다 — 이랑님이 「PDF 올리기」를 누르는 것과 같다 (2026-10-12)
#   sh tools/pdf_import.sh "/경로/파일.pdf" "임상시험용의약품 GMP 평가 가이드라인[민원인 안내서]"
#   둘째 인자가 앱에 보일 이름(파일 이름의 .pdf 앞부분). 생략하면 파일 이름 그대로.
# 어떻게: law_import.sh 와 같은 index_real.html(진짜 supabase-js + service_role) 위에서 PDF 를 fetch → File → lawUpload(f).
# 함정: ① 크롬은 **매번 새 프로필 폴더**로, --virtual-time-budget·--dump-dom 없이 띄운다. 가상 시계를 주면 pdf.js 가 읽기 전에 꺼지고(10/12 「PDF 읽는 중…」에서 멈춤),
#         쓰던 프로필을 또 쓰면 떠 있는 크롬에 주소만 넘기고 아무것도 안 한다(run.log 가 빈 채 끝남).
#       ② 같은 이름이 이미 있으면 confirm 을 false 로 눌러 **올리지 않는다** — 바꾸려면 앱에서 지우고 다시.
#       ③ 지문(emb)은 안 만든다 — 끝난 뒤 tools/embed_slow.sh <lawId> 로.
set -e
[ -f "$1" ] || { echo "PDF 파일이 없어요: $1"; exit 1; }
APP="$(cd "$(dirname "$0")/.." && pwd)"; R="$HOME/.yakktime-uitest/real"
sh "$APP/tools/law_import.sh" >/dev/null 2>&1 || true     # index_real.html·serve.py 를 최신 app.js 로 다시 만든다(이름 없이 부르면 아무것도 안 받는다)
NAME="${2:-$(basename "$1" .pdf)}"
cp "$1" "$R/up.pdf"
python3 - "$R" <<'PY'
import io,sys
R=sys.argv[1]; h=io.open(R+"/index_real.html",encoding="utf-8").read()
i=h.index("<script>\nfunction LOG(s)"); j=h.index("</script></body>",i)
tail='''<script>
function LOG(s){ return fetch("/log",{method:"POST",body:s}).catch(function(){}); }
var FNAME=decodeURIComponent(new URLSearchParams(location.search).get("fname")||"up.pdf");
function waitApp(n){ if(window.appStarted&&S&&S.laws&&S.laws.length) return Promise.resolve(); if(n>60) return Promise.reject(new Error("앱이 안 떴어요"));
  return new Promise(function(r){ setTimeout(r,1000); }).then(function(){ return waitApp(n+1); }); }
setTimeout(function(){
  lawEmbedRun=function(){ return Promise.resolve(); }; showToast=function(m){ LOG("toast "+m); }; window.confirm=function(m){ LOG("confirm "+m.slice(0,80)); return false; };
  waitApp(0).then(function(){ LOG("앱 준비 · 법령 "+S.laws.length+"개");
    if(S.laws.some(function(l){ return lawBare(l.name)===lawBare(lawParse(FNAME).base); })) return LOG("이미 있음 "+FNAME);
    return fetch("/up.pdf").then(function(r){ return r.blob(); }).then(function(b){
      var f=new File([b],FNAME,{type:"application/pdf"}); var n0=S.laws.length;
      lawUpload(f);
      return new Promise(function(res,rej){ var k=0; (function w(){ k++; if(!lawBusy&&S.laws.length>n0) return res(); if(!lawBusy&&k>5) return rej(new Error("올리기가 끝났는데 법령이 안 늘었어요")); if(k>280) return rej(new Error("시간 초과")); setTimeout(w,1000); })(); });
    }).then(function(){ var l=S.laws[0]; return LOG("OK "+l.name+" · 쪽 "+l.pages+" · 종류 "+(l.kind||"?")+" · 시행 "+(l.eff||"?")); });
  }).then(function(){ return LOG("DONE"); },function(e){ return LOG("DONE ERR "+(e&&e.message||e)); });
},1500);
'''
io.open(R+"/pdf_upload.html","w",encoding="utf-8").write(h[:i]+tail+h[j:])
PY
curl -s -o /dev/null localhost:8778 || (cd "$R" && nohup python3 serve.py >/dev/null 2>&1 &); sleep 1
: > "$R/run.log"; pkill -f "headless=new" 2>/dev/null || true; sleep 1
FN=$(python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]+'.pdf'))" "$NAME")
P="/tmp/claude-501/cprof_$$"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --user-data-dir="$P" --no-first-run \
  --disable-background-timer-throttling --disable-renderer-backgrounding "http://localhost:8778/pdf_upload.html?tab=laws&fname=$FN" >/dev/null 2>&1 &
CP=$!
for i in $(seq 1 300); do sleep 1; grep -q "DONE" "$R/run.log" 2>/dev/null && break; done
kill $CP 2>/dev/null || true; rm -rf "$P"
grep -v " toast 텍스트 추출\| toast 조문 저장" "$R/run.log"
