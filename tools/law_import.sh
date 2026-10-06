#!/bin/sh
# 법제처에서 법령·고시를 앱의 진짜 코드(lawApiImport)로 받아 저장한다 — 이랑님이 앱에서 「＋ 법제처에서 받기」를 누르는 것과 같다 (2026-10-01)
#   sh tools/law_import.sh "인체세포등 및 첨단바이오의약품의 허가 및 안전 등에 관한 규정" "첨단바이오의약품 장기추적조사 관리기준"
# 어떻게: ~/.yakktime-uitest/real/ 에 index_real.html 을 만든다 — 진짜 supabase-js 를 service_role 열쇠로 띄우고(로그인 흉내),
#   app.js 를 그대로 실행한 뒤 이름마다 lawApiSearchAll → lawApiImport. 진행은 localhost:8778/log 로 POST 해 run.log 에 쌓인다.
# 함정: ① 반드시 --user-data-dir + --virtual-time-budget 으로 띄운다 — 없이 띄우면 떠 있는 크롬에 주소만 넘기고 멈춘다(10/1 실측).
#       ② 지문(emb)은 여기서 안 만든다(lawEmbedRun 을 비움) — 끝난 뒤 law-embed 를 slow 로 돌린다(CLAUDE.md 「뜻 검색」).
#       ③ service_role 열쇠가 index_real.html 에 박힌다 — ~/.yakktime-uitest 밖으로 복사하지 않는다.
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"; R="$HOME/.yakktime-uitest/real"; mkdir -p "$R"
cp "$APP/app.js" "$APP/style.css" "$APP/insp_template.json" "$R/"
python3 - "$APP/index.html" "$R" <<'PY'
import io,sys,os,json
h=io.open(sys.argv[1],encoding="utf-8").read(); R=sys.argv[2]
key=io.open(os.path.expanduser("~/.yakktime-service-key")).read().strip()
tag='<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'; assert h.count(tag)==1
h=h.replace(tag,tag+'''
<script>window.onerror=function(m,s,l,c){ try{ fetch("/log",{method:"POST",body:"ERR "+m+" @"+l+":"+c}); }catch(e){} };
(function(){ var real=window.supabase, KEY=%s;
  window.supabase={createClient:function(url){ var c=real.createClient(url,KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    var fake={data:{session:{expires_at:(Date.now()/1000|0)+99999,user:{id:"runner"}}},error:null};
    c.auth.getSession=function(){ return Promise.resolve(fake); }; c.auth.refreshSession=function(){ return Promise.resolve(fake); };
    c.auth.onAuthStateChange=function(){ return {data:{subscription:{unsubscribe:function(){}}}}; };
    c.auth.startAutoRefresh=function(){}; c.auth.stopAutoRefresh=function(){}; return c; }}; })();
</script>''' % json.dumps(key))
h=h.replace('if("serviceWorker" in navigator){ try{ navigator.serviceWorker.register("sw.js"); }catch(e){} }','')
h=h.replace("</body>",'''<script>
function LOG(s){ return fetch("/log",{method:"POST",body:s}).catch(function(){}); }
var NAMES=(new URLSearchParams(location.search).get("names")||"").split("|").filter(Boolean);
function waitApp(n){ if(window.appStarted&&S&&S.laws&&S.laws.length) return Promise.resolve(); if(n>60) return Promise.reject(new Error("앱이 안 떴어요"));
  return new Promise(function(r){ setTimeout(r,1000); }).then(function(){ return waitApp(n+1); }); }
setTimeout(function(){
  lawEmbedRun=function(){ return Promise.resolve(); }; showToast=function(m){ LOG("toast "+m); };
  waitApp(0).then(function(){ LOG("앱 준비 · 법령 "+S.laws.length+"개");
    return NAMES.reduce(function(p,name){ return p.then(function(){
      if(S.laws.some(function(l){ return lawBare(l.name)===lawBare(name); })) return LOG("이미 있음 "+name);
      return lawApiSearchAll(name).then(function(rows){
        var r=rows.filter(function(x){ return lawBare(x.name)===lawBare(name); })[0];
        if(!r) return LOG("못 찾음 "+name+" / 후보 "+rows.map(function(x){return x.name;}).join(" | "));
        return lawApiImport({name:r.name,kind:apiKindOf(r.kind,r.admrul)}).then(function(x){ return LOG("OK "+x.name+" 조문 "+x.arts+"개"); },
          function(e){ return LOG("FAIL "+name+" — "+(e&&e.message||e)); });
      });
    }); }, Promise.resolve());
  }).then(function(){ return LOG("DONE"); },function(e){ return LOG("DONE ERR "+(e&&e.message||e)); });
},1500);
</script></body>''',1)
io.open(R+"/index_real.html","w",encoding="utf-8").write(h)
io.open(R+"/serve.py","w").write('''import http.server,os,datetime
D=os.path.dirname(os.path.abspath(__file__)); os.chdir(D)
class H(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get("Content-Length") or 0); b=self.rfile.read(n).decode("utf-8","replace")
        open(os.path.join(D,"run.log"),"a",encoding="utf-8").write(datetime.datetime.now().strftime("%H:%M:%S ")+b+"\\n")
        self.send_response(204); self.end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(("127.0.0.1",8778),H).serve_forever()
''')
PY
curl -s -o /dev/null localhost:8778 || (cd "$R" && nohup python3 serve.py >/dev/null 2>&1 &); sleep 1
: > "$R/run.log"
NAMES=$(python3 -c "import sys,urllib.parse;print(urllib.parse.quote('|'.join(sys.argv[1:])))" "$@")
pkill -f "headless=new" 2>/dev/null || true; sleep 3   # set -e 라 pkill 이 아무것도 못 찾으면(1) 여기서 죽는다 — 10/6 두 번 헛돌았다
# --screenshot 모드는 10/6 부터 페이지 스크립트가 돌기 전에 멈췄다 → --dump-dom 으로 띄우고, run.log 에 DONE 이 찍히면 크롬을 죽인다(최대 300초)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --user-data-dir=/tmp/claude-501/chromeprof \
  --virtual-time-budget=120000 --dump-dom "http://localhost:8778/index_real.html?tab=laws&names=$NAMES" >/dev/null 2>&1 &
CP=$!
for i in $(seq 1 300); do sleep 1; grep -q "DONE" "$R/run.log" 2>/dev/null && break; kill -0 $CP 2>/dev/null || break; done
kill $CP 2>/dev/null; sleep 1
grep -v " toast " "$R/run.log"
