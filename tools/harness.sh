#!/bin/sh
# 시험대 — Supabase 없이 앱의 진짜 코드(app.js·style.css)를 헤드리스 크롬에 띄운다 (2026-09-28)
# 세션 scratchpad 는 날짜가 바뀌면 비워져서 세 번 다시 만들었다 → 늘 같은 자리($HOME/.yakktime-uitest)에 둔다.
#   sh tools/harness.sh                  # 만들고 8777 서버 띄움 (이미 떠 있으면 그대로)
#   sh tools/harness.sh shot today 620   # 스크린샷 → ~/.yakktime-uitest/shot_today_620.png
# 주소:  http://localhost:8777/index.html?tab=today|calendar|articles|mfds|laws|answers
#        ?insp=1&page=board|prep|plan|tour|review|rooms|findings&open=<영역>&day=d1&mine=1
# 시험 걸이: index.html 의 setTimeout 안에서 window.T(이름) 으로 결과를 document.title 에 적는다.
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"
D="$HOME/.yakktime-uitest"
mkdir -p "$D"
cp "$APP/app.js" "$APP/style.css" "$APP/insp_template.json" "$D/"
cat > "$D/mocksb.js" <<'EOF'
var MOCK={inspections:[],insp_items:[],schedule:[],events:[],articles:[],mfds:[],archive:[],docs:[],laws:[],refs:[],answers:[],settings:[]};
function K(off){ var d=new Date(); d.setDate(d.getDate()+off); return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2); }
MOCK.events=[{id:"t1",event_date:K(-2),event_time:null,title:"아스트라제네카 실태조사",place:null,until:K(3),memo:"가는 편 09:20 인천"},
             {id:"t2",event_date:K(0),event_time:"11:30",title:"채주영 선생님 점심",place:"오송",memo:null},
             {id:"t3",event_date:K(5),event_time:"10:00",title:"GMP 교육",place:null,memo:null}];
MOCK.mfds=[{id:"m2",title:"이진호 선생님에게 문서 전달",status:"대기",memo:"",due_date:K(0),due_time:"09:00",place:"식약처"},
           {id:"m3",title:"국외여비명세서 물어보기",status:"완료",memo:"",due_date:K(0),due_time:"09:00",place:"식약처"}];
MOCK.schedule=[{id:"s1",text:"보완 회신 검토",due_date:K(0),done:false,star:true}];
MOCK.laws=[{id:"l1",name:"약사법",kind:"법률",src:"api",arts:216},{id:"l2",name:"의약품 등의 안전에 관한 규칙",kind:"총리령",src:"api",arts:456},
  {id:"l3",name:"의약품 제조 및 품질관리에 관한 규정",kind:"고시",src:"api",arts:261},{id:"l4",name:"바이오의약품 사전 GMP 평가 지침",kind:"지침",pages:52,arts:120},
  {id:"l5",name:"첨단바이오의약품 안전 및 지원에 관한 규칙",kind:"총리령",src:"api",arts:82},{id:"l6",name:"의약품등 품목별 사전 GMP 평가 운영지침[공무원 지침서]",kind:"지침",pages:27,arts:90},{id:"l7",name:"의약외품 품목허가·신고·심사 규정",kind:"고시",src:"api",arts:52}];
MOCK.articles=[{id:"a1",title:"반려동물 항생제 오남용",status:"기획",memo:"10월호"},{id:"a2",title:"동물용 백신 콜드체인",status:"작성중",memo:""},{id:"a3",title:"수의사 처방전 제도",status:"기고완료",memo:"9월호"}];
(function(){ var TPL=window.__TPL; if(!TPL) return; var id="insp-1";
  MOCK.inspections=[{id:id,title:"AstraZeneca Pharmaceuticals LP",site:null,start_date:"2026-09-14",end_date:"2026-09-18",buildings:[{name:"633",mode:"변경만"},{name:"636",mode:"전체"}],areas:TPL.mine.slice(),partner:"김해인 선생님",status:"진행",notes:null,tpl:TPL.version}];
  MOCK.insp_items=TPL.items.map(function(x,i){ return {id:"it"+i,insp_id:id,page:x.page,section:x.section||null,seq:i+1,kind:x.kind||"task",text:x.text,hint:x.hint||null,building:x.building||null,area:x.area||null,day:x.day||null,done:i%7===0,memo:null,grade:null,ref:null,src:"본"}; });
  MOCK.insp_items.push({id:"tr1",insp_id:id,page:"board",section:null,seq:9001,kind:"track",text:"압축공기·가스",hint:null,building:null,area:"압축공기·가스",day:null,done:false,memo:"담당 Mike · 636 사용점 OQ/PQ 요청",grade:"보는 중",ref:"4-E (633만), 1-G",src:null});
  MOCK.insp_items.push({id:"f1",insp_id:id,page:"findings",section:null,seq:9002,kind:"find",text:"636 사용점 필터 완결성 시험 기록 없음",hint:null,building:"636",area:"압축공기·가스",day:null,done:false,memo:null,grade:"보완 예상",ref:"규칙 별표 1 3.5",src:null});
  MOCK.insp_items.push({id:"r1",insp_id:id,page:"rooms",section:null,seq:9003,kind:"room",text:"배양실",hint:null,building:"633",area:null,done:false,memo:"Grade C · 2000L SUB 2대",grade:null,ref:"R-201",src:null});
})();
function q(table){ var res={data:(MOCK[table]||[]).slice(),error:null};
  var api={select:function(){return api;},insert:function(){return api;},upsert:function(){return api;},update:function(){return api;},delete:function(){return api;},eq:function(){return api;},in:function(){return api;},order:function(){return api;},limit:function(){return api;},range:function(){return api;},then:function(f,g){return Promise.resolve(res).then(f,g);}}; return api; }
window.supabase={createClient:function(){ return { from:q,
  auth:{ getSession:function(){ return Promise.resolve({data:{session:{expires_at:(Date.now()/1000|0)+9999}}}); }, refreshSession:function(){ return Promise.resolve({data:{session:{}}}); }, onAuthStateChange:function(){ return {data:{subscription:{unsubscribe:function(){}}}}; }, signInWithPassword:function(){ return Promise.resolve({error:null}); }, signOut:function(){ return Promise.resolve({}); }, startAutoRefresh:function(){}, stopAutoRefresh:function(){} },
  storage:{ from:function(){ return {createSignedUrl:function(){ return Promise.resolve({data:null,error:{message:"mock"}}); }, upload:function(){ return Promise.resolve({error:{message:"mock"}}); }, remove:function(){ return Promise.resolve({}); }}; } },
  functions:{ invoke:function(){ return Promise.resolve({data:null,error:{message:"mock"}}); } } }; }};
EOF
python3 - "$APP/index.html" "$D" <<'PY'
import io,sys
h=io.open(sys.argv[1],encoding='utf-8').read(); tpl=io.open(sys.argv[2]+'/insp_template.json',encoding='utf-8').read()
h=h.replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
  '<script>window.onerror=function(m,s,l,c){ document.title="ERR "+m+" @"+l+":"+c; };</script>\n<script>window.__TPL='+tpl+';</script>\n<script src="mocksb.js"></script>')
h=h.replace('if("serviceWorker" in navigator){ try{ navigator.serviceWorker.register("sw.js"); }catch(e){} }','')
h=h.replace('</body>','''<script>
window.T=function(s){ document.title=s; };
setTimeout(function(){ var p=new URLSearchParams(location.search);
  if(p.get("insp")){ active="insp"; inspOpenId="insp-1"; inspPage=p.get("page")||"board"; if(p.get("open")) inspExpand["b:"+p.get("open")]=true; if(p.get("day")) inspFilter.day=p.get("day"); if(p.get("mine")) inspFilter.mine=true; }
  else active=p.get("tab")||"today";
  if(p.get("list")) lawListOpen=true; if(p.get("nohelp")) lawHelpOpen=false;
  render();
},500);
</script></body>''')
io.open(sys.argv[2]+'/index.html','w',encoding='utf-8').write(h)
PY
# 이미 떠 있는 서버가 다른 폴더를 보여 주면(옛 scratchpad 등) 끄고 다시 띄운다 — 2026-10-01 v213 을 보여 줘 헛짚을 뻔했다
WANT=$(grep -m1 'var APP_VER' "$D/app.js")
if curl -s -o /dev/null localhost:8777 && [ "$(curl -s localhost:8777/app.js | grep -m1 'var APP_VER')" != "$WANT" ]; then
  lsof -tiTCP:8777 -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 1
fi
cd "$D" && (curl -s -o /dev/null localhost:8777 || (nohup python3 -m http.server 8777 >/dev/null 2>&1 &)); sleep 1
if [ "$1" = "shot" ]; then
  CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; W="${3:-620}"; OUT="$D/shot_$2_$W.png"
  "$CH" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size="$W",1400 --screenshot="$OUT" "http://localhost:8777/index.html?tab=$2" 2>/dev/null
  echo "$OUT"
else
  echo "시험대: $D  →  http://localhost:8777/index.html"
fi
