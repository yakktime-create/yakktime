"use strict";

/* ========== Supabase 연결 ========== */
var SUPABASE_URL = "https://mkwcqnqfidlvsrlximbw.supabase.co";
var SUPABASE_KEY = "sb_publishable_JNoquJ1EHLtDedRI0PzHzQ_w5Nly20H";

/* storageKey는 일부러 기본값(sb-<ref>-auth-token)을 그대로 쓴다.
   여기서 바꾸면 이미 저장돼 있던 세션을 못 찾아서 전원 재로그인이 발생함. */
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,      /* 세션을 localStorage에 저장 (v2 기본값이지만 명시) */
    autoRefreshToken: true,    /* 만료 전 액세스 토큰 자동 갱신 */
    detectSessionInUrl: true,
    storage: window.localStorage
  }
});

/* ========== 유틸 ========== */
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function pad(n){ return (n<10?"0":"")+n; }
function keyOf(d){ return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
function tomorrow(){ var d=new Date(); d.setDate(d.getDate()+1); return d; }

/* ========== 동기화 토스트 ========== */
var _toastTimer=null;
function showToast(msg,isErr){
  var el=document.getElementById("sync-toast"); if(!el) return;
  el.textContent=msg;
  el.className=isErr?"sync-toast show err":"sync-toast show";
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(function(){ el.className="sync-toast"; },3000);
}
/* 되돌릴 수 있는 알림. 삭제에 확인창을 띄우면 매번 귀찮으니,
 * 대신 지운 뒤 잠깐 되돌릴 기회를 준다. */
function showUndoToast(msg,onUndo,ms){
  var el=document.getElementById("sync-toast"); if(!el){ return; }
  el.textContent="";
  var t=document.createElement("span"); t.textContent=msg; el.appendChild(t);
  var b=document.createElement("button");
  b.className="toast-undo"; b.textContent="되돌리기";
  b.onclick=function(){ clearTimeout(_toastTimer); el.className="sync-toast"; onUndo(); };
  el.appendChild(b);
  el.className="sync-toast show";
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(function(){ el.className="sync-toast"; },ms||6000);
}

/* ========== 인증 ========== */
function showLogin(){
  document.getElementById("loading").style.display="none";
  document.getElementById("login-screen").style.display="block";
  document.getElementById("app").style.display="none";
}
function showApp(){
  document.getElementById("login-screen").style.display="none";
  document.getElementById("app").style.display="flex";
}
function hideLoading(){
  var el=document.getElementById("loading");
  if(el){ el.className="loading-overlay hide"; setTimeout(function(){ el.style.display="none"; },400); }
}

function doLogin(){
  var email=(document.getElementById("login-email").value||"").trim();
  var pw=(document.getElementById("login-pw").value||"").trim();
  var errEl=document.getElementById("login-err");
  if(!email||!pw){ errEl.style.display="block"; errEl.textContent="이메일과 비밀번호를 입력해주세요."; return; }
  errEl.style.display="none";
  var btn=document.getElementById("login-btn");
  btn.textContent="로그인 중..."; btn.disabled=true;
  sb.auth.signInWithPassword({email:email,password:pw}).then(function(res){
    btn.textContent="로그인"; btn.disabled=false;
    if(res.error){ errEl.style.display="block"; errEl.textContent=res.error.message; return; }
    startApp();
  });
}
function doLogout(){
  appStarted=false;
  sb.auth.signOut().then(function(){ showLogin(); });
}

/* ========== 세션 유지 (iOS 홈 화면 PWA 대응) ==========
 * 문제: 홈 화면 아이콘으로 열면 iOS가 앱을 완전히 종료했다가 다시 띄운다.
 *   1) 콜드 스타트 시점엔 네트워크가 아직 안 붙어 있는 경우가 많다.
 *      → 토큰 갱신이 실패 → 예전 코드는 곧바로 로그인 화면을 띄웠다("세션 풀림").
 *   2) 백그라운드에서는 타이머가 정지돼 autoRefreshToken이 갱신 시점을 놓친다.
 *      → 복귀 직후 액세스 토큰이 만료 상태 → 쿼리가 401 → 데이터가 빈 채로 보인다.
 * 대응: 만료 임박이면 선제 갱신, 실패해도 오프라인이면 세션 유지, 복귀 시 재검증.
 */
var appStarted=false;

function isAuthErr(e){
  if(!e) return false;
  var msg=String(e.message||"");
  return e.status===401 || e.code==="PGRST301" || /jwt|token|expired|unauthorized/i.test(msg);
}

/* 액세스 토큰이 만료됐거나 60초 내 만료 예정이면 미리 갱신한다. */
function ensureSession(){
  return sb.auth.getSession().then(function(res){
    var s=(res&&res.data)?res.data.session:null;
    if(!s) return null;
    var msLeft=(s.expires_at||0)*1000-Date.now();
    if(msLeft>60000) return s;
    return sb.auth.refreshSession().then(function(r){
      if(r&&r.data&&r.data.session) return r.data.session;
      /* 오프라인이라 실패한 거면 세션을 버리지 않는다. 온라인 복귀 시 다시 시도. */
      if(!navigator.onLine) return s;
      return null;
    }).catch(function(){ return navigator.onLine?null:s; });
  });
}

/* 쿼리가 토큰 만료로 실패하면 한 번 갱신 후 재시도한다. */
function withAuthRetry(makeQuery){
  return Promise.resolve(makeQuery()).then(function(res){
    if(!res||!res.error||!isAuthErr(res.error)) return res;
    return sb.auth.refreshSession().then(function(r){
      if(!r||!r.data||!r.data.session) return res;
      return makeQuery();
    }).catch(function(){ return res; });
  });
}

/* 앱 복귀(포그라운드 전환/bfcache 복원/온라인 복귀) 시 세션 재검증 + 데이터 새로고침 */
var _resumeAt=0;
function onResume(){
  var now=Date.now();
  if(now-_resumeAt<3000) return;   /* 이벤트가 겹쳐 들어오므로 스로틀 */
  _resumeAt=now;
  if(sb.auth.startAutoRefresh) { try{ sb.auth.startAutoRefresh(); }catch(e){} }
  ensureSession().then(function(s){
    if(!s){ if(appStarted){ appStarted=false; showLogin(); } return; }
    if(!appStarted){ startApp(); return; }
    loadAll().then(render).catch(function(){});
  });
}

document.addEventListener("visibilitychange",function(){
  if(document.visibilityState==="visible") onResume();
  else if(sb.auth.stopAutoRefresh){ try{ sb.auth.stopAutoRefresh(); }catch(e){} }
});
window.addEventListener("pageshow",function(e){ if(e.persisted) onResume(); });
window.addEventListener("focus",onResume);
window.addEventListener("online",onResume);

/* 토큰 갱신/로그아웃을 UI에 반영 */
sb.auth.onAuthStateChange(function(event,session){
  if(event==="SIGNED_OUT"){ appStarted=false; showLogin(); return; }
  if(event==="SIGNED_IN"&&session&&!appStarted){ startApp(); return; }
});

/* 로그인 이벤트 */
document.getElementById("login-btn").addEventListener("click",doLogin);
document.getElementById("login-pw").addEventListener("keydown",function(e){ if(e.key==="Enter") doLogin(); });
document.getElementById("login-email").addEventListener("keydown",function(e){ if(e.key==="Enter") document.getElementById("login-pw").focus(); });

/* ========== DB 레이어 (Supabase) — OPUS SQL 스키마 ========== */
/* archive·docs 는 화면이 없어졌지만 표는 남겨 둔다 — 데이터와 백업이 보존된다 */
var TABLES=["schedule","events","articles","mfds","archive","docs","laws","refs"];

/*
 * OPUS SQL 컬럼명 매핑:
 *   events: event_date (date), event_time (text)
 *   docs: category (text), file_path (text), file_name (text)
 *   archive: needs_check (bool), file_path (text), file_name (text)
 *   모든 테이블: id는 uuid (서버 자동 생성)
 */
function toLocal(table,row){
  if(!row) return row;
  var o={};
  Object.keys(row).forEach(function(k){
    var lk=k;
    /* events */
    if(k==="event_date") lk="key";
    else if(k==="event_time") lk="time";
    else if(k==="due_time") lk="time";        /* mfds 업무 시간 */
    /* schedule */
    else if(k==="due_date") lk="due";
    /* archive */
    else if(k==="needs_check") lk="needsCheck";
    /* archive+docs 공통 */
    else if(k==="file_path") lk="filePath";
    else if(k==="file_name") lk="fileName";
    /* docs */
    else if(k==="category") lk="cat";
    /* 타임스탬프 */
    else if(k==="created_at") lk="createdAt";
    else if(k==="updated_at") lk="updatedAt";
    o[lk]=row[k];
  });
  return o;
}
function toRemote(table,item){
  var o={};
  Object.keys(item).forEach(function(k){
    var rk=k;
    /* events */
    if(k==="key"&&table==="events") rk="event_date";
    else if(k==="time"&&table==="events") rk="event_time";
    else if(k==="time"&&table==="mfds") rk="due_time";
    /* schedule 할 일 날짜 · mfds 업무 기한 */
    else if(k==="due"&&(table==="schedule"||table==="mfds")) rk="due_date";
    /* archive */
    else if(k==="needsCheck") rk="needs_check";
    /* archive+docs 공통 */
    else if(k==="filePath") rk="file_path";
    else if(k==="fileName") rk="file_name";
    /* docs */
    else if(k==="cat") rk="category";
    /* 타임스탬프 */
    else if(k==="createdAt") rk="created_at";
    else if(k==="updatedAt") rk="updated_at";
    /* 로컬 전용 필드 제외 */
    else if(k==="fileId") return;
    else if(k==="blob") return;
    else if(k==="num") return;
    o[rk]=item[k];
  });
  return o;
}

/* 표 하나가 실패해도 앱 전체를 막지 않는다.
 * (예: 새 기능의 표를 아직 안 만들었을 때 — 그 탭만 비고 나머지는 정상 동작) */
function loadAll(){
  var promises=TABLES.map(function(t){
    return withAuthRetry(function(){ return sb.from(t).select("*"); }).then(function(res){
      if(res.error) return {table:t, data:[], failed:res.error.message||"알 수 없는 오류"};
      return {table:t, data:(res.data||[]).map(function(r){ return toLocal(t,r); })};
    }).catch(function(err){
      return {table:t, data:[], failed:(err&&err.message)||"알 수 없는 오류"};
    });
  });
  return Promise.all(promises).then(function(results){
    var bad=results.filter(function(r){ return r.failed; }).map(function(r){ return r.table; });
    if(bad.length) setTimeout(function(){ showToast("일부 데이터를 못 읽었어요: "+bad.join(", "),true); },600);
    results.forEach(function(r){ S[r.table]=r.data; });
  });
}

function dbInsert(table,item){
  var remote=toRemote(table,item);
  return withAuthRetry(function(){ return sb.from(table).insert(remote).select(); }).then(function(res){
    if(res.error){ showToast("저장 실패: "+res.error.message,true); return null; }
    /* 서버가 생성한 uuid를 로컬 아이템에 반영 */
    if(res.data&&res.data[0]){ item.id=res.data[0].id; }
    return res.data?res.data[0]:null;
  });
}
function dbUpdate(table,id,changes){
  return withAuthRetry(function(){ return sb.from(table).update(toRemote(table,changes)).eq("id",id); }).then(function(res){
    if(res.error){ showToast("업데이트 실패: "+res.error.message,true); }
  });
}
function dbUpsert(table,item){
  return withAuthRetry(function(){ return sb.from(table).upsert(toRemote(table,item)); }).then(function(res){
    if(res.error){ showToast("저장 실패: "+res.error.message,true); }
  });
}
function dbDelete(table,id){
  return withAuthRetry(function(){ return sb.from(table).delete().eq("id",id); }).then(function(res){
    if(res.error){ showToast("삭제 실패: "+res.error.message,true); }
  });
}

/* ========== 전역 상태 ========== */
var S={ schedule:[], events:[], articles:[], mfds:[], archive:[], docs:[], laws:[], refs:[] };
var active="today";
var now0=new Date(), calYear=now0.getFullYear(), calMonth=now0.getMonth(), calSel=keyOf(now0);
var ARTICLE_STATUS=["기획","작성중","기고완료"], MFDS_STATUS=["대기","진행중","완료"];
/* group 이 있으면 누를 수 없는 머리말이다. 탭이 7줄 평평하게 늘어서
 * 관계가 안 보이던 것을 세 묶음으로 나눈다. */
var TAB_LIST=[
  {group:"일정"},
  {id:"today",label:"오늘"},
  {id:"calendar",label:"캘린더"},
  {group:"업무"},
  {id:"articles",label:"기고글",sub:"서울시약사회"},
  {id:"mfds",label:"식약처 업무"},
  {group:"자료"},
  {id:"archive",label:"민원 자료"},
  {id:"laws",label:"법령"}
];
var WD=["일","월","화","수","목","금","토"];

/* ========== NL date parser ========== */
function parseNL(input){
  var text=" "+input.trim()+" ", now=new Date();
  var year=now.getFullYear(), month=null, day=null, base=null, hasTime=false, hh=null, mm=0, m, explicitYear=false;
  m=text.match(/(\d{4})\s*년/); if(m){ year=parseInt(m[1]); explicitYear=true; text=text.replace(m[0]," "); }
  if(/오늘/.test(text)){ base=new Date(now); text=text.replace(/오늘/," "); }
  else if(/내일|낼/.test(text)){ base=new Date(now); base.setDate(base.getDate()+1); text=text.replace(/내일|낼/," "); }
  else if(/모레/.test(text)){ base=new Date(now); base.setDate(base.getDate()+2); text=text.replace(/모레/," "); }
  else if(/글피/.test(text)){ base=new Date(now); base.setDate(base.getDate()+3); text=text.replace(/글피/," "); }
  if(!base){ m=text.match(/(\d{1,2})\s*일\s*(뒤|후)/); if(m){ base=new Date(now); base.setDate(base.getDate()+parseInt(m[1])); text=text.replace(m[0]," "); } }
  if(!base){ m=text.match(/(\d{1,2})\s*주\s*(뒤|후)/); if(m){ base=new Date(now); base.setDate(base.getDate()+7*parseInt(m[1])); text=text.replace(m[0]," "); } }
  if(!base){ m=text.match(/(이번주|이번 주|다음주|다음 주|담주|차주)?\s*([일월화수목금토])요일/);
    if(m){ var map={"일":0,"월":1,"화":2,"수":3,"목":4,"금":5,"토":6}; var t=map[m[2]]; var d=new Date(now);
      var add=(t-d.getDay()+7)%7; if(/다음주|다음 주|담주|차주/.test(m[1]||"")) add+=7; d.setDate(d.getDate()+add); base=d; text=text.replace(m[0]," "); } }
  m=text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if(m){ month=parseInt(m[1])-1; day=parseInt(m[2]); text=text.replace(m[0]," "); }
  else { m=text.match(/(?:^|\s)(\d{1,2})[\/\-\.](\d{1,2})(?=\s|$)/); if(m){ month=parseInt(m[1])-1; day=parseInt(m[2]); text=text.replace(m[0]," "); } }
  m=text.match(/(오전|오후)?\s*(\d{1,2})\s*시\s*(\d{1,2})?\s*분?/);
  if(m){ hh=parseInt(m[2]); mm=m[3]?parseInt(m[3]):0; if(/오후/.test(m[1]||"")&&hh<12) hh+=12; if(/오전/.test(m[1]||"")&&hh===12) hh=0; hasTime=true; text=text.replace(m[0]," "); }
  else { m=text.match(/(\d{1,2}):(\d{2})/); if(m){ hh=parseInt(m[1]); mm=parseInt(m[2]); hasTime=true; text=text.replace(m[0]," "); } }
  var date;
  if(base) date=base;
  else if(month!=null&&day!=null){ date=new Date(year,month,day);
    if(!explicitYear){ var tm=new Date(now.getFullYear(),now.getMonth(),now.getDate()); if(date<tm) date=new Date(year+1,month,day); } }
  else return {ok:false};
  var title=text.replace(/\s+/g," ").trim();
  return {ok:true, key:keyOf(date), date:date, time: hasTime?(pad(hh)+":"+pad(mm)):null, title: title||"(제목 없음)"};
}

/* ========== 렌더링 ========== */
function view(){ return document.getElementById("view"); }
var APP_VER="v30";
function renderTabs(){
  var v=document.getElementById("ver"); if(v) v.textContent=APP_VER;
  document.getElementById("tabs").innerHTML=TAB_LIST.map(function(t){
    if(t.group) return '<div class="rail-group">'+esc(t.group)+'</div>';
    return '<button class="rail-tab '+(active===t.id?"on":"")+'" data-act="tab" data-id="'+t.id+'">'
      + '<span class="dot"></span><span class="rail-label">'+esc(t.label)
      + (t.sub?'<span class="rail-sub">'+esc(t.sub)+'</span>':'')+'</span></button>';
  }).join(""); }
function pageHead(t,s){ return '<header class="page-head"><div><h1 class="page-title">'+esc(t)+'</h1>'+(s?'<p class="page-sub">'+esc(s)+'</p>':'')+'</div></header>'; }
function seg(name,opts,def){ return '<div class="seg" data-seg="'+name+'">'+opts.map(function(o){ return '<button class="seg-btn '+(o===def?"on":"")+'" data-val="'+esc(o)+'">'+esc(o)+'</button>'; }).join("")+'</div>'; }
function wireSeg(name){ var box=document.querySelector('[data-seg="'+name+'"]'); if(!box) return; box.addEventListener("click",function(e){ var b=e.target.closest(".seg-btn"); if(!b) return; box.querySelectorAll(".seg-btn").forEach(function(x){x.classList.remove("on");}); b.classList.add("on"); }); }
function segValue(name){ var on=document.querySelector('[data-seg="'+name+'"] .seg-btn.on'); return on?on.getAttribute("data-val"):null; }
function val(id){ var e=document.getElementById(id); return e?e.value:""; }
function evSort(a,b){ if(a.key!==b.key) return a.key<b.key?-1:1; var ta=a.time||"99:99", tb=b.time||"99:99"; return ta<tb?-1:ta>tb?1:0; }

/* ========== 인라인 편집 ==========
 * 목록의 텍스트를 한 번 누르면 그 자리에서 input으로 바뀐다.
 *   Enter / 포커스 아웃 → 저장,  Esc → 취소
 * data-act="edit" data-table="..." data-field="..." data-id="..." 만 붙이면 동작한다.
 * 편집 중에는 render()가 input을 날려버리므로 editingId로 재진입을 막는다. */
var editingId=null;
function startEdit(el,table,id,field,type){
  if(!el||editingId||!S[table]) return;
  var item=S[table].find(function(x){ return x.id===id; });
  if(!item) return;
  editingId=id;
  var cur=item[field]==null?"":String(item[field]);
  var area=(type==="textarea");
  var inp=document.createElement(area?"textarea":"input");
  if(type&&!area) inp.type=type;
  inp.className="input inline-edit"+(area?" inline-area":"");
  inp.value=cur;
  el.replaceWith(inp);
  inp.focus();
  if(!type) { try{ inp.setSelectionRange(cur.length,cur.length); }catch(e){} }
  var settled=false;
  /* 날짜는 비워서 저장할 수 있어야 한다 (기한을 없애면 캘린더에서도 빠짐) */
  var allowEmpty=(type==="date"||area);   /* 기한·메모는 비워서 지울 수 있어야 한다 */
  function commit(save){
    if(settled) return;
    settled=true; editingId=null;
    var nv=inp.value.trim();
    if(save&&(nv||allowEmpty)&&nv!==cur){
      item[field]=nv||null;
      var patch={}; patch[field]=nv||null;
      dbUpdate(table,id,patch);
    }
    render();
  }
  inp.addEventListener("keydown",function(e){
    /* 메모는 줄바꿈을 써야 하므로 Enter로 저장하지 않는다 (blur 또는 ⌘/Ctrl+Enter) */
    if(e.key==="Enter"&&(!area||e.metaKey||e.ctrlKey)){ e.preventDefault(); commit(true); }
    else if(e.key==="Escape"){ e.preventDefault(); commit(false); }
  });
  inp.addEventListener("blur",function(){ commit(true); });
}

/* ========== 칸반 드래그 (포인터 이벤트) ==========
 * iOS Safari는 HTML5 드래그(draggable/dragstart)가 터치에서 동작하지 않으므로
 * 포인터 이벤트로 직접 구현한다.
 *   · 터치: 200ms 롱프레스 후 움직여야 드래그 시작 → 페이지 세로 스크롤과 충돌 안 함
 *   · 마우스: 8px 이상 움직이면 바로 시작
 *   · 드래그가 시작되지 않았으면 click이 그대로 통과 → 인라인 수정이 계속 동작
 */
var dragState=null, dragEndedAt=0;

/* 어느 탭의 칸반이든 board의 data-table을 읽어 그 표를 고친다 */
function wireBoardDrag(){
  var board=document.querySelector(".board"); if(!board) return;
  var table=board.getAttribute("data-table"); if(!table||!S[table]) return;
  board.addEventListener("pointerdown",function(e){
    if(editingId) return;                                   /* 편집 중엔 드래그 금지 */
    if(e.target.closest("input,textarea,button")) return;   /* 버튼·입력은 그대로 */
    var card=e.target.closest(".mini"); if(!card) return;
    var isTouch=(e.pointerType!=="mouse");
    dragState={ id:card.getAttribute("data-card"), card:card, active:false,
                sx:e.clientX, sy:e.clientY, pid:e.pointerId,
                holdOk:!isTouch, timer:null };
    if(isTouch) dragState.timer=setTimeout(function(){
      if(!dragState) return;
      dragState.holdOk=true;
      dragState.card.classList.add("armed");        /* 움직이기 전에 "잡혔다"를 보여준다 */
      if(navigator.vibrate){ try{ navigator.vibrate(8); }catch(err){} }
    },200);
  });
  board.addEventListener("pointermove",function(e){
    if(!dragState||e.pointerId!==dragState.pid) return;
    var dx=e.clientX-dragState.sx, dy=e.clientY-dragState.sy;
    if(!dragState.active){
      var dist=Math.sqrt(dx*dx+dy*dy);
      /* 롱프레스가 차기 전에 움직였으면 스크롤 의도로 보고 포기한다 */
      if(!dragState.holdOk){ if(dist>10) cleanupDrag(); return; }
      if(dist<8) return;
      beginDrag();
    }
    e.preventDefault();
    dragState.dx=dx; dragState.dy=dy; dragState.px=e.clientX; dragState.py=e.clientY;
    /* 프레임당 한 번만 그린다 — pointermove마다 그리면 끊긴다 */
    if(!dragState.raf) dragState.raf=requestAnimationFrame(paintDrag);
  });
  board.addEventListener("pointerup",function(e){
    if(!dragState||e.pointerId!==dragState.pid) return;
    if(!dragState.active){ cleanupDrag(); return; }         /* 그냥 탭 → click 통과 */
    var col=colFromCache(e.clientX,e.clientY), id=dragState.id;
    cleanupDrag();
    dragEndedAt=Date.now();                                 /* 뒤따르는 click 무시용 */
    var st=col?col.getAttribute("data-col"):null;
    var it=S[table].find(function(x){ return x.id===id; });
    if(it&&st&&it.status!==st){
      it.status=st; render(); dbUpdate(table,id,{status:st});
    } else render();                                        /* 원위치 */
  });
  board.addEventListener("pointercancel",function(){ cleanupDrag(); });
}

/* 드래그 시작 시점에 컬럼 좌표를 캐시해 둔다.
 * pointermove마다 elementFromPoint를 부르면 레이아웃이 매번 강제 계산돼 끊긴다.
 * 드래그 중에는 preventDefault로 스크롤이 막히므로 좌표가 변하지 않는다. */
function beginDrag(){
  dragState.active=true;
  var c=dragState.card, r=c.getBoundingClientRect();
  c.style.width=r.width+"px"; c.style.height=r.height+"px";
  c.classList.remove("armed"); c.classList.add("dragging");
  try{ c.setPointerCapture(dragState.pid); }catch(err){}
  var bd=document.querySelector(".board");
  if(bd){ bd.classList.add("drag-on"); dragState.board=bd; }   /* 세 칸의 경계를 보여준다 */
  dragState.cols=[];
  var els=document.querySelectorAll(".col");
  for(var i=0;i<els.length;i++) dragState.cols.push({el:els[i],r:els[i].getBoundingClientRect()});
}
function paintDrag(){
  if(!dragState||!dragState.active) return;
  dragState.raf=0;
  dragState.card.style.transform="translate3d("+dragState.dx+"px,"+dragState.dy+"px,0) rotate(1.5deg) scale(1.03)";
  var col=colFromCache(dragState.px,dragState.py);
  if(col!==dragState.overCol){
    if(dragState.overCol) dragState.overCol.classList.remove("drop-target");
    if(col) col.classList.add("drop-target");
    dragState.overCol=col;
  }
}
function colFromCache(x,y){
  var cs=(dragState&&dragState.cols)||[], i, r;
  /* 1차: 컬럼 영역 안에 정확히 들어온 경우 */
  for(i=0;i<cs.length;i++){ r=cs[i].r;
    if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom) return cs[i].el; }
  /* 2차: 컬럼 아래 빈 공간 — 세로는 무시하고 가로 위치로만 판정해
     카드가 없는 칸에도 아래쪽 어디서든 놓을 수 있게 한다 */
  for(i=0;i<cs.length;i++){ r=cs[i].r;
    if(y>=r.top&&x>=r.left&&x<=r.right) return cs[i].el; }
  return null;
}
function cleanupDrag(){
  if(!dragState) return;
  clearTimeout(dragState.timer);
  if(dragState.raf) cancelAnimationFrame(dragState.raf);
  var c=dragState.card;
  if(c){ c.classList.remove("dragging"); c.classList.remove("armed");
         c.style.transform=""; c.style.width=""; c.style.height=""; }
  if(dragState.board) dragState.board.classList.remove("drag-on");
  if(dragState.overCol) dragState.overCol.classList.remove("drop-target");
  dragState=null;
}

/* 캘린더에서 날짜를 누르면 아래 입력칸이 보이도록 스크롤 + 포커스 */
function focusDayPanel(){
  var panel=document.querySelector(".day-panel");
  var inp=document.getElementById("day-ev");
  if(panel&&panel.scrollIntoView) panel.scrollIntoView({behavior:"smooth",block:"center"});
  if(inp) inp.focus();
}

/* 2026-09-05 → 9월 5일(금) */
function shortDate(key){
  var d=new Date(key+"T00:00:00");
  if(isNaN(d)) return key;
  return (d.getMonth()+1)+"월 "+d.getDate()+"일("+WD[d.getDay()]+")";
}

function statTile(tab,tone,num,label){
  return '<button class="stat t-'+tone+'" data-act="tab" data-id="'+tab+'">'
    + '<span class="stat-num">'+num+'</span>'
    + '<span class="stat-lbl">'+esc(label)+'</span>'
    + '<span class="stat-go">→</span></button>';
}

function renderToday(){
  var now=new Date(), h=now.getHours();
  var greet=h<6?"새벽이에요":h<12?"좋은 아침이에요":h<18?"좋은 오후예요":"수고한 하루예요";
  var dateStr=now.toLocaleDateString("ko-KR",{year:"numeric",month:"long",day:"numeric",weekday:"long"});
  var todayKey=keyOf(now);
  var tmrKey=keyOf(tomorrow());
  /* due_date가 없는 예전 항목은 '오늘'로 본다 (마이그레이션 전 데이터 호환) */
  function dueOf(i){ return i.due||todayKey; }
  /* 오늘 = 오늘 이하(지난 미완료도 이월). 내일 = 오늘보다 뒤 전부 → 사라지는 항목 없음 */
  var todayItems=S.schedule.filter(function(i){ return dueOf(i)<=todayKey; });
  var tmrItems  =S.schedule.filter(function(i){ return dueOf(i)>todayKey; });
  var open=todayItems.filter(function(i){return !i.done;});
  var inProg=S.articles.filter(function(a){return a.status==="작성중";}).length;
  var mfdsOpen=S.mfds.filter(function(m){return m.status!=="완료";}).length;
  var refParts=0; S.refs.forEach(function(r){ refParts+=(r.parts||0); });
  var todayEv=S.events.filter(function(e){return e.key===todayKey;}).sort(evSort);
  var upcoming=S.events.filter(function(e){return e.key>todayKey;}).sort(evSort).slice(0,4);
  var evHtml="";
  if(todayEv.length){ evHtml+='<div class="card"><div class="card-head"><h2>오늘 일정</h2></div>'+todayEv.map(function(e){ return '<div class="ev-row">'
      + '<span class="ev-time">'+esc(e.time||"종일")+'</span>'
      + '<div class="ev-body"><div class="ev-line"><span class="ev-title">'+esc(e.title)+'</span></div>'
      +   (e.place? '<div class="ev-line sub"><span class="ev-place">📍 '+esc(e.place)+'</span>'
                    +'<button class="link-btn map-btn" data-act="map" data-q="'+esc(e.place)+'">지도 ↗</button></div>' : '')
      + '</div></div>'; }).join("")+'</div>'; }
  if(upcoming.length){ evHtml+='<div class="card"><div class="card-head"><h2>다가오는 일정</h2><span class="muted" data-act="tab" data-id="calendar" style="cursor:pointer">캘린더 열기 →</span></div>'+upcoming.map(function(e){ return '<div class="up-row">'
      + '<span class="up-date">'+esc(shortDate(e.key))+'</span>'
      + '<span class="up-title">'+esc(e.title)
      +   (e.place? ' <span class="up-place">📍 '+esc(e.place)+'</span>'
                    +'<button class="link-btn map-btn" data-act="map" data-q="'+esc(e.place)+'">지도 ↗</button>' : '')
      + '</span>'
      + '<span class="up-time">'+esc(e.time||"")+'</span></div>'; }).join("")+'</div>'; }
  /* 할 일 목록 HTML (오늘/내일 두 곳에서 재사용) */
  function schedRows(items,emptyMsg,showDate){
    var o=items.filter(function(i){return !i.done;}).sort(function(a,b){return (b.star?1:0)-(a.star?1:0);});
    var d=items.filter(function(i){return i.done;});
    if(!o.length&&!d.length) return '<div class="empty-box sm"><p>'+emptyMsg+'</p></div>';
    return '<ul class="list">'
      + o.map(function(i){
          var late=dueOf(i)<todayKey ? '<span class="row-late">지난</span>' : '';
          var when=(showDate&&i.due)? '<span class="row-when">'+esc(shortDate(i.due))+'</span>' : '';
          return '<li class="row'+(i.star?" star-on":"")+'"><button class="check" data-act="s-toggle" data-id="'+i.id+'">✓</button>'
            + '<span class="row-text" data-act="edit" data-table="schedule" data-field="text" data-id="'+i.id+'" title="눌러서 수정">'+esc(i.text)+'</span>'+when+late
            + '<span class="row-acts">'
            +   '<button class="star '+(i.star?"on":"")+'" data-act="s-star" data-id="'+i.id+'" title="별표">'+(i.star?"★":"☆")+'</button>'
            +   '<button class="del" data-act="s-del" data-id="'+i.id+'" title="삭제">✕</button></span></li>'; }).join("")
      + d.map(function(i){
          return '<li class="row done"><button class="check on" data-act="s-toggle" data-id="'+i.id+'">✓</button>'
            + '<span class="row-text" data-act="edit" data-table="schedule" data-field="text" data-id="'+i.id+'" title="눌러서 수정">'+esc(i.text)+'</span>'
            + '<span class="row-acts"><button class="del" data-act="s-del" data-id="'+i.id+'" title="삭제">✕</button></span></li>'; }).join("")
      + '</ul>';
  }
  var rows    = schedRows(todayItems,"아직 할 일이 없어요. 첫 항목을 추가해 하루를 시작해 보세요.");
  var tmrRows = schedRows(tmrItems,"앞으로 할 일은 아직 없어요.",true);
  var tmrD=tomorrow();
  var tmrLabel=(tmrD.getMonth()+1)+"월 "+tmrD.getDate()+"일("+WD[tmrD.getDay()]+")";
  view().innerHTML='<div class="page">'
    + '<header class="today-hero"><div class="today-date">'+esc(dateStr)+'</div><h1 class="today-greet">'+greet+', 이랑님.</h1><p class="today-line">오늘 할 일 '+open.length+'건'+(open.length?" 남았어요.":"이 없어요.")+(todayEv.length?" · 오늘 일정 "+todayEv.length+"건.":"")+'</p></header>'
    + '<section class="stat-row">'
    +   statTile("articles","brass",inProg,"작성 중 기고글")
    +   statTile("mfds","blue",mfdsOpen,"진행 중 식약처 업무")
    +   statTile("archive","accent",S.refs.length,"민원 자료"+(refParts?" · 절 "+refParts:""))
    +   statTile("laws","slate",S.laws.length,"올려둔 법령")
    + '</section>'+evHtml
    + '<section class="card"><div class="card-head"><h2>오늘 할 일</h2><span class="muted">별표는 위로 · 항목을 누르면 수정</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s" placeholder="할 일을 적고 Enter" /><button class="btn" data-act="s-add" data-id="'+todayKey+'" data-input="new-s">+ 추가</button></div>'+rows
    + '</section>'
    + '<section class="card"><div class="card-head"><h2>앞으로 할 일</h2><span class="muted">'+tmrLabel+' 부터</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s2" placeholder="앞으로 할 일을 적고 Enter (내일 날짜로 들어가요)" /><button class="btn" data-act="s-add" data-id="'+tmrKey+'" data-input="new-s2">+ 추가</button></div>'+tmrRows
    + '</section></div>';
  document.getElementById("new-s").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(todayKey,"new-s"); });
  document.getElementById("new-s2").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(tmrKey,"new-s2"); });
}

var CAL_CHIPS=3;   /* 한 칸에 보여줄 일정 수. 아이패드 가로에선 3개까지 들어간다 */
function renderCalendar(){
  var first=new Date(calYear,calMonth,1), startDay=first.getDay();
  var dim=new Date(calYear,calMonth+1,0).getDate(), todayKey=keyOf(new Date()), cells="";
  for(var i=0;i<startDay;i++) cells+='<div class="cal-cell blank"></div>';
  for(var d=1;d<=dim;d++){ var k=calYear+"-"+pad(calMonth+1)+"-"+pad(d);
    var evs=S.events.filter(function(e){return e.key===k;}).sort(evSort);
    /* 식약처 업무를 같은 칸에 함께 얹는다 (복사본이 아니라 mfds를 직접 읽음) */
    var tasks=S.mfds.filter(function(m){ return m.due===k; });
    var chipItems=tasks.map(function(m){ return {task:true,done:m.status==="완료",label:m.title}; })
      .concat(evs.map(function(e){ return {task:false,done:false,label:(e.time?e.time+" ":"")+e.title}; }));
    var chips=chipItems.slice(0,CAL_CHIPS).map(function(c){
      return '<div class="cal-ev'+(c.task?" mfds":"")+(c.done?" done":"")+'">'+esc(c.label)+'</div>'; }).join("");
    if(chipItems.length>CAL_CHIPS) chips+='<div class="cal-more">+'+(chipItems.length-CAL_CHIPS)+'</div>';
    cells+='<div class="cal-cell'+(k===todayKey?" today":"")+(k===calSel?" sel":"")+'" data-act="cal-day" data-id="'+k+'"><span class="cal-num">'+d+'</span>'+chips+'</div>'; }
  var wdHtml=WD.map(function(w,i){ return '<div class="cal-wd'+(i===0?" sun":"")+'">'+w+'</div>'; }).join("");
  var selEvs=S.events.filter(function(e){return e.key===calSel;}).sort(evSort), selD=new Date(calSel);
  var selTasks=S.mfds.filter(function(m){ return m.due===calSel; });
  var taskRows=selTasks.map(function(t){
    var done=(t.status==="완료");
    return '<li class="ev-row task'+(done?" done":"")+'">'
      + '<input class="day-check" type="checkbox" data-act="mfds-done" data-id="'+t.id+'"'+(done?' checked':'')+' />'
      + '<span class="ev-time" data-act="edit" data-table="mfds" data-field="time" data-id="'+t.id+'" title="눌러서 시간 수정">'+(t.time?esc(t.time):'<span class="none">시간</span>')+'</span>'
      + '<div class="ev-body">'
      +   '<div class="ev-line"><span class="mfds-badge">식약처</span>'
      +     '<span class="ev-title" data-act="edit" data-table="mfds" data-field="title" data-id="'+t.id+'" title="눌러서 수정">'+esc(t.title)+'</span>'
      +     '<span class="mfds-status">'+esc(t.status)+'</span></div>'
      +   '<div class="ev-line sub">'+whereHtml(t,"mfds")+'</div>'
      + '</div>'
      + '<span class="row-acts"><button class="del" data-act="mfds-del" data-id="'+t.id+'" title="삭제">✕</button></span></li>'; }).join("");
  var panel='<div class="day-panel"><div class="day-title">'+(selD.getMonth()+1)+'월 '+selD.getDate()+'일 ('+WD[selD.getDay()]+')'+(calSel===todayKey?' <span class="day-today">오늘</span>':'')+'</div>'
    + '<div class="add-row quick day-add"><input class="input day-what" id="day-ev" placeholder="할 일 / 일정 (예: 오후 2시 GMP 실사)" />'
    +   '<input class="input day-when" id="day-time" placeholder="시간 (예: 14:00)" />'
    +   '<input class="input day-where" id="day-place" placeholder="장소 (예: 오송 본관 3층)" />'
    +   '<label class="chk"><input type="checkbox" id="day-mfds" /> 식약처 업무</label>'
    +   '<button class="btn" data-act="day-add">+ 추가</button></div>'
    + ((selEvs.length||selTasks.length)? '<ul class="list">'+taskRows+selEvs.map(function(e){ return '<li class="ev-row">'
      + '<span class="ev-time" data-act="edit" data-table="events" data-field="time" data-id="'+e.id+'" title="눌러서 시간 수정">'+(e.time?esc(e.time):"종일")+'</span>'
      + '<div class="ev-body">'
      +   '<div class="ev-line"><span class="ev-title" data-act="edit" data-table="events" data-field="title" data-id="'+e.id+'" title="눌러서 수정">'+esc(e.title)+'</span></div>'
      +   '<div class="ev-line sub">'+whereHtml(e,"events")+'</div>'
      + '</div>'
      + '<span class="row-acts"><button class="del" data-act="ev-del" data-id="'+e.id+'" title="삭제">✕</button></span></li>'; }).join("")+'</ul>' : '<p class="empty">이 날은 아직 일정이 없어요.</p>')+'</div>';
  var mk=calYear+"-"+pad(calMonth+1);
  var mEv=S.events.filter(function(e){ return e.key.indexOf(mk)===0; }).length;
  var mTask=S.mfds.filter(function(m){ return m.due&&m.due.indexOf(mk)===0; }).length;
  var calPills=[]; if(mEv) calPills.push(pill("이번 달 일정 "+mEv+"건")); if(mTask) calPills.push(pill("기한 있는 업무 "+mTask+"건"));
  view().innerHTML='<div class="page">'+pageHead2("캘린더","",calPills)
    + '<div class="cal-nav"><button class="cal-arrow" data-act="cal-prev">‹</button><span class="cal-month">'+calYear+'년 '+(calMonth+1)+'월</span><button class="cal-arrow" data-act="cal-next">›</button></div>'
    + '<div class="cal-grid">'+wdHtml+cells+'</div>'+panel+'</div>';
  document.getElementById("day-ev").addEventListener("keydown",function(e){ if(e.key==="Enter") dayAdd(); });
}

function articleCard(it){
  return '<div class="mini" data-card="'+it.id+'">'
    + '<button class="mini-del" data-act="a-del" data-id="'+it.id+'" title="삭제">✕</button>'
    + '<div class="mini-title" data-act="edit" data-table="articles" data-field="title" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.title)+'</div>'
    + (it.memo
        ? '<div class="mini-memo" data-act="edit" data-table="articles" data-field="memo" data-type="textarea" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.memo)+'</div>'
        : '<div class="mini-memo none" data-act="edit" data-table="articles" data-field="memo" data-type="textarea" data-id="'+it.id+'" title="눌러서 메모 추가">＋ 주제 / 마감 / 메모</div>')
    + '</div>';
}

function renderArticles(){
  var items=S.articles;
  var counts=ARTICLE_STATUS.map(function(st){ return items.filter(function(a){return a.status===st;}).length; });

  var composer = formOpen.articles
    ? '<div class="card form composer">'
      + '<input class="input composer-title" id="a-title" placeholder="글 제목" />'
      + '<textarea class="input" id="a-memo" placeholder="주제 / 마감 / 메모 (선택)"></textarea>'
      + '<div class="composer-foot">'+segC("a-status",ARTICLE_STATUS,"기획")+composerBtns("articles","a-add")+'</div>'
      + '</div>'
    : composerBtn("articles","새 기고글 추가","기획 → 작성중 → 기고완료 순으로 관리해요");

  var pills=[pill("작성 중 "+counts[1]+"건")];
  if(counts[0]) pills.push(pill("기획 "+counts[0]+"건"));

  view().innerHTML='<div class="page">'
    + pageHead2("서울시약사회 동물약품 기고글","카드를 지그시 눌렀다 끌면 다른 칸으로 옮겨져요.",items.length?pills:null)
    + boardSearchHtml("articles","제목·메모에서 찾기 (지난 기고글까지)")
    + composer
    + boardHtml("articles",ARTICLE_STATUS,items,articleCard,{status:"기고완료",label:"지난 기고글"})
    + '</div>';

  if(formOpen.articles){ wireSeg("a-status"); focusFirst("a-title"); }
  wireBoardSearch("articles");
  wireBoardDrag();
}

/* ========== 접히는 입력창 (공용) ==========
 * 입력 폼은 평소엔 접어 둔다. 화면 위쪽 절반을 폼이 차지하면
 * 정작 봐야 할 목록이 스크롤 아래로 밀린다.
 * 탭을 옮기면 모두 다시 접힌다. */
var formOpen={mfds:false,articles:false};
function closeForms(){ Object.keys(formOpen).forEach(function(k){ formOpen[k]=false; }); }
function composerBtn(key,label,hint){
  return '<button class="composer-open" data-act="f-open" data-id="'+key+'">'
    + '<span class="composer-plus">+</span>'+esc(label)
    + (hint?'<span class="composer-hint">'+esc(hint)+'</span>':'')+'</button>';
}
function composerBtns(key,saveAct,saveLabel){
  return '<div class="composer-btns">'
    + '<button class="btn quiet sm" data-act="f-close" data-id="'+key+'">취소</button>'
    + '<button class="btn sm" data-act="'+saveAct+'">'+esc(saveLabel||"저장")+'</button></div>';
}
/* 펼친 직후 첫 칸에 커서를 둔다 */
function focusFirst(id){ var el=document.getElementById(id); if(el) el.focus(); }
/* 세그먼트 — 컴팩트(알약) 형태 */
function segC(name,opts,def){
  return '<div class="seg compact" data-seg="'+name+'">'
    + opts.map(function(o){ return '<button class="seg-btn '+(o===def?"on":"")+'" data-val="'+esc(o)+'">'+esc(o)+'</button>'; }).join("")
    + '</div>';
}
/* 페이지 머리말 + 요약 배지 */
function pageHead2(title,sub,pills){
  return '<header class="page-head"><div><h1 class="page-title">'+esc(title)+'</h1>'
    + (sub?'<p class="page-sub">'+esc(sub)+'</p>':'')
    + (pills&&pills.length?'<div class="head-meta">'+pills.join("")+'</div>':'')
    + '</div></header>';
}
function pill(label,tone){ return '<span class="meta-pill'+(tone?" "+tone:"")+'">'+esc(label)+'</span>'; }

function dayGap(a,b){ return Math.round((new Date(b+"T00:00:00")-new Date(a+"T00:00:00"))/86400000); }

/* 기한 칩 — 날짜만 적어두면 급한지 아닌지 매번 세어봐야 하므로 남은 날짜로 바꿔 보여준다 */
function mfdsDue(it,todayKey){
  var at=' data-act="edit" data-table="mfds" data-field="due" data-type="date" data-id="'+it.id+'"';
  if(!it.due) return '<span class="mini-due none"'+at+' title="눌러서 기한 추가">＋ 기한</span>';
  var d=new Date(it.due+"T00:00:00");
  var date=(d.getMonth()+1)+"월 "+d.getDate()+"일";
  var label=date, tone="";
  if(it.status!=="완료"){
    var gap=dayGap(todayKey,it.due);
    if(gap<0){ tone=" over"; label=date+" · "+(-gap)+"일 지남"; }
    else if(gap===0){ tone=" over"; label="오늘 마감"; }
    else if(gap===1){ tone=" soon"; label="내일 마감"; }
    else if(gap<=3){ tone=" soon"; label=date+" · "+gap+"일 남음"; }
  }
  return '<span class="mini-due'+tone+'"'+at+' title="눌러서 기한 수정">'+esc(label)+'</span>';
}

/* 칸반 뼈대 — 식약처 업무·기고글이 함께 쓴다 */
/* 끝난 일은 「예전에 뭐 했지」 찾을 때 쓰는 기록이다. 그런데 완료 칸에
 * 그냥 쌓아두면 카드가 수십 개로 늘어 오히려 못 찾는다.
 * 최근 것만 보여주고 나머지는 접어 둔다 — 찾을 땐 검색을 쓴다. */
var BOARD_FOLD=5;
var boardOpen={}, boardSearch={};
function byNewest(a,b){ return String(b.createdAt||"").localeCompare(String(a.createdAt||"")); }

function boardHtml(table,statuses,items,cardFn,fold){
  var q=(boardSearch[table]||"").trim().toLowerCase();
  if(q) items=items.filter(function(i){
    return ((i.title||"")+" "+(i.memo||"")).toLowerCase().indexOf(q)>=0;
  });
  var open=!!boardOpen[table];
  return '<div class="board" data-table="'+table+'">'
    + statuses.map(function(st){
        var list=items.filter(function(i){ return i.status===st; });
        var total=list.length, more=0, folded=(fold&&st===fold.status);
        if(folded){
          list=list.slice().sort(byNewest);
          if(!q&&!open&&total>BOARD_FOLD){ more=total-BOARD_FOLD; list=list.slice(0,BOARD_FOLD); }
        }
        var foot="";
        if(more) foot='<button class="col-more" data-act="board-more" data-table="'+table+'">'+esc(fold.label)+' '+more+'건 더 보기</button>';
        else if(folded&&open&&!q&&total>BOARD_FOLD) foot='<button class="col-more" data-act="board-more" data-table="'+table+'">접기</button>';
        return '<div class="col" data-col="'+esc(st)+'">'
          + '<div class="col-head"><span class="col-dot"></span>'+esc(st)+'<span class="col-count">'+total+'</span></div>'
          + (list.length
              ? list.map(cardFn).join("")
              : '<div class="col-empty">'+(q?'찾는 카드가 없어요':'여기로 카드를 끌어다<br />놓을 수 있어요')+'</div>')
          + foot
          + '</div>';
      }).join("")
    + '</div>';
}

/* 칸반 위 검색칸 — 진행 중이든 지난 것이든 한 번에 찾는다 */
function boardSearchHtml(table,ph){
  var v=boardSearch[table]||"";
  return '<div class="search-box"><span class="search-ic">⌕</span>'
    + '<input class="input search board-q" id="bq-'+table+'" placeholder="'+esc(ph)+'" value="'+esc(v)+'" />'
    + (v?'<button class="btn quiet sm board-clear" data-act="board-clear" data-table="'+table+'">지우기</button>':'')
    + '</div>';
}
function wireBoardSearch(table){
  var el=document.getElementById("bq-"+table); if(!el) return;
  el.addEventListener("input",function(e){ boardSearch[table]=e.target.value; render(); });
}

function mfdsCard(it,todayKey){
  return '<div class="mini" data-card="'+it.id+'">'
    + '<button class="mini-del" data-act="m-del" data-id="'+it.id+'" title="삭제">✕</button>'
    + '<div class="mini-title" data-act="edit" data-table="mfds" data-field="title" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.title)+'</div>'
    + (it.memo
        ? '<div class="mini-memo" data-act="edit" data-table="mfds" data-field="memo" data-type="textarea" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.memo)+'</div>'
        : '<div class="mini-memo none" data-act="edit" data-table="mfds" data-field="memo" data-type="textarea" data-id="'+it.id+'" title="눌러서 담당·메모 추가">＋ 담당 / 메모</div>')
    + '<div class="mini-foot">'+mfdsDue(it,todayKey)+'</div>'
    + '</div>';
}

function mfdsComposer(){
  if(!formOpen.mfds) return composerBtn("mfds","새 업무 추가","기한을 넣으면 캘린더에도 표시돼요");
  return '<div class="card form composer">'
    + '<input class="input composer-title" id="m-title" placeholder="업무명 (예: 바이오시밀러 사전 GMP 평가)" />'
    + '<textarea class="input" id="m-memo" placeholder="담당 / 메모 (선택)"></textarea>'
    + '<div class="composer-foot">'
    +   segC("m-status",MFDS_STATUS,"대기")
    +   '<div class="due-field"><label for="m-due">기한</label><input class="input" type="date" id="m-due" /></div>'
    +   '<div class="due-field"><label for="m-time">시간</label><input class="input" id="m-time" placeholder="14:00" /></div>'
    +   '<div class="due-field wide"><label for="m-place">장소</label><input class="input" id="m-place" placeholder="오송 본관 3층" /></div>'
    +   composerBtns("mfds","m-add")
    + '</div></div>';
}

function renderMfds(){
  var items=S.mfds, todayKey=keyOf(new Date());
  var late=items.filter(function(i){ return i.due && i.status!=="완료" && i.due<todayKey; }).length;
  var open=items.filter(function(i){ return i.status!=="완료"; }).length;

  var pills=[pill("진행 중 "+open+"건")];
  if(late) pills.push(pill("기한 지남 "+late+"건","warn"));

  view().innerHTML='<div class="page">'
    + pageHead2("식약처 업무","카드를 지그시 눌렀다 끌면 다른 칸으로 옮겨져요.",items.length?pills:null)
    + boardSearchHtml("mfds","제목·메모에서 찾기 (지난 업무까지)")
    + mfdsComposer()
    + boardHtml("mfds",MFDS_STATUS,items,function(it){ return mfdsCard(it,todayKey); },{status:"완료",label:"지난 업무"})
    + '</div>';

  if(formOpen.mfds){ wireSeg("m-status"); focusFirst("m-title"); }
  wireBoardSearch("mfds");
  wireBoardDrag();
}

/* ========== 민원 자료 ==========
 * 처음엔 「건별 카드」로 만들었는데, 실제로는 마스터 문서 하나를 계속 고쳐가며
 * 올리는 방식이었다. 그래서 법령 탭과 같은 구조로 바꿨다 —
 * 문서를 올리면 절 단위로 쪼개 저장하고, 그 안을 검색한다.
 * 같은 자료에 새 파일을 올리면 통째로 갈아끼운다(갱신). 자료가 늘지 않는다. */

var refQuery="", refTerms=[], refHits=null, refBusy=false, refListOpen=false,
    refOpen={}, refNeedOnly=false;

/* 절 머리말 — 실제 쓰시는 문서들의 표기를 읽는다.
 *   건 1.  /  제1부.  /  §1  /  1-1.  /  1-2-3.  /  ○ 무엇
 *
 * 길이 제한이 핵심이다. 「§6.4 단서는 요건 두 가지를…」처럼 조문 인용으로
 * 시작하는 본문 문장이 흔한데, 이걸 제목으로 오인하면 문장 한복판에서
 * 절이 갈린다. 제목은 짧다 — 그 성질로 가른다. */
var REF_HEAD_MAX=60;
var REF_HEAD_RE=/^\s*(건\s*\d+\s*\.|제\s*\d+\s*부\s*\.|§\s*\d+(?:\s*\.\s*\d+)?|\d+-\d+(?:-\d+)?\.|○)\s*(.*)$/;
var REF_NEED_RE=/\[\s*확인\s*필요/;
var REF_PART_MAX=40000;
var REF_MIN_BODY=80;   /* 이보다 짧은 절은 앞 절에 붙인다 */

function refHeadLevel(mark){
  if(/^건/.test(mark)) return 0;
  if(/^제/.test(mark)) return 0;
  if(/^§/.test(mark)) return 0;
  if(/^○/.test(mark)) return 1;
  return (mark.split("-").length>=3)?2:1;
}
/* 머리말처럼 생겼어도 문장이면 본문이다 */
function refIsHead(line,m){
  if(line.length>REF_HEAD_MAX) return false;
  var title=(m[2]||"").trim();
  if(/[.。]$/.test(title)&&title.length>20) return false;   /* 문장으로 끝나면 본문 */
  if(/^[○]$/.test(m[1])&&!title) return false;
  return true;
}

/* 줄 배열 → 절 배열. 머리말이 하나도 없으면 통째로 한 절이다. */
/* 번호가 안 붙은 제목 — 「공통 적용 근거」 「[역할]」처럼 짧은 줄 뒤에
 * 긴 문단이 이어지면 제목이다. 표 머리칸(「구분」 「결론」)은 뒤에 오는 것도
 * 짧으므로 걸리지 않는다. 이걸 안 잡으면 앞 절에 남의 내용이 딸려 들어간다
 * (건3 요약에 건1·건2 얘기가 섞였던 게 그 경우다). */
var REF_PLAIN_MAX=20, REF_PLAIN_NEXT=60;
function refIsPlainHead(t,next){
  if(t.length>REF_PLAIN_MAX) return false;
  if(!next||next.length<REF_PLAIN_NEXT) return false;
  if(/[.。?!]$/.test(t)) return false;
  if(REF_HEAD_RE.test(next)) return false;   /* 다음 줄이 번호 제목이면 그건 묶음 이름이다 */
  return true;
}

function buildRefParts(lines,docName){
  var parts=[], cur=null, seen={}, lastShort="", group="", lastNumbered="";
  var clean=lines.map(function(x){ return (x||"").trim(); }).filter(function(x){ return x; });
  clean.forEach(function(t,ci){
    var m=REF_HEAD_RE.exec(t);
    if(m&&!refIsHead(t,m)) m=null;
    if(!m&&refIsPlainHead(t,clean[ci+1])){
      /* 「□ 근거」만 있으면 어느 건인지 알 수 없다. 앞의 번호 절을 붙인다.
       * 이미 「A › B」로 붙어 있으면 뒤쪽만 써서 두 단으로 끝낸다. */
      var par=lastNumbered;
      if(par&&par.indexOf(" › ")>=0) par=par.split(" › ").pop();
      if(par&&par.length>30) par=par.slice(0,30)+"…";
      cur={ seq:parts.length+1, label:(par?par+" › "+t:t).slice(0,120),
            level:2, need:false, lines:[t] };
      parts.push(cur); lastShort=""; return;
    }
    if(m){
      var mark=m[1].replace(/\s+/g,""), title=(m[2]||"").trim();
      var label=(mark+(title?" "+title:""));
      /* 「건3.」 같은 번호는 문서 안에서 한 번만 나오는 게 정상이다.
       * 두 번째로 나오면 맨 뒤 요약 표처럼 본문을 다시 훑는 자리다.
       * 그대로 두면 본문 건3과 라벨이 똑같아 보여 헷갈리므로,
       * 바로 앞에 있던 짧은 줄(그 표의 제목)을 앞에 붙여 구분한다.
       * ○ 나 § 는 원래 여러 번 나오므로 이 검사에서 뺀다. */
      if(/^(건|제)/.test(mark)||/^\d+-/.test(mark)){
        if(seen[mark]){
          /* 요약 구역에 들어섰다. 표 중간에 긴 줄이 끼어도 맥락이 끊기지
           * 않도록, 한 번 잡은 제목을 그 구역 내내 붙인다. */
          if(!group) group=lastShort||"요약";
          label=group+" › "+label;
        } else {
          group="";
          seen[mark]=true;
        }
      }
      cur={ seq:parts.length+1, label:label.slice(0,120),
            level:refHeadLevel(mark), need:false, lines:[t] };
      parts.push(cur);
      lastNumbered=cur.label;
      lastShort="";
      return;
    }
    if(t.length<=30) lastShort=t; else lastShort="";
    if(!cur){ cur={seq:1,label:docName||"머리말",level:0,need:false,lines:[]}; parts.push(cur); }
    cur.lines.push(t);
  });
  /* 목차 줄이나 표 한 칸이 머리말처럼 생겨서 짧은 절로 흩어진다.
   * 알맹이가 거의 없는 절은 앞 절에 붙인다 — 글자는 그대로 남으니 검색에는 다 걸린다. */
  var merged=[];
  parts.forEach(function(pt){
    var body=pt.lines.join("\n");
    if(merged.length && body.trim().length<REF_MIN_BODY){
      merged[merged.length-1].lines=merged[merged.length-1].lines.concat(pt.lines);
      return;
    }
    merged.push(pt);
  });
  return merged.map(function(pt,i){
    var c=pt.lines.join("\n");
    if(c.length>REF_PART_MAX) c=c.slice(0,REF_PART_MAX);
    return { seq:i+1, label:pt.label, level:pt.level,
             need:REF_NEED_RE.test(c), content:c };
  }).filter(function(pt){ return pt.content.trim().length>1; });
}

/* ZIP(docx) 안에서 word/document.xml 하나만 꺼낸다.
 * 외부 라이브러리 없이 중앙 디렉터리를 직접 읽고 DecompressionStream 으로 푼다.
 * (예전 「.docx 건별 가져오기」에 딸려 있던 함수인데, 그 기능을 걷어낼 때
 *  같이 지워져서 워드 업로드가 깨졌다. 여기로 옮겨 온다.) */
function extractDocXml(arrayBuffer){
  return new Promise(function(resolve,reject){
    try{
      var bytes=new Uint8Array(arrayBuffer);
      var eocd=-1;
      for(var i=bytes.length-22;i>=0;i--){
        if(bytes[i]===0x50&&bytes[i+1]===0x4b&&bytes[i+2]===0x05&&bytes[i+3]===0x06){ eocd=i; break; }
      }
      if(eocd<0){ reject(new Error("ZIP 형식이 아닌 것 같아요")); return; }
      var dv=new DataView(arrayBuffer);
      var cdOff=dv.getUint32(eocd+16,true), cdN=dv.getUint16(eocd+10,true), pos=cdOff;
      for(var e=0;e<cdN;e++){
        var fnLen=dv.getUint16(pos+28,true), exLen=dv.getUint16(pos+30,true), cmLen=dv.getUint16(pos+32,true);
        var method=dv.getUint16(pos+10,true), compSz=dv.getUint32(pos+20,true);
        var locOff=dv.getUint32(pos+42,true);
        var fn=new TextDecoder().decode(bytes.slice(pos+46,pos+46+fnLen));
        if(fn==="word/document.xml"){
          var lfn=dv.getUint16(locOff+26,true), lex=dv.getUint16(locOff+28,true);
          var start=locOff+30+lfn+lex, raw=bytes.slice(start,start+compSz);
          if(method===0){ resolve(new TextDecoder().decode(raw)); return; }
          if(method===8){
            if(typeof DecompressionStream!=="undefined"){
              var ds=new DecompressionStream("deflate-raw");
              new Response(new Blob([raw]).stream().pipeThrough(ds)).text().then(resolve).catch(reject);
            } else { reject(new Error("이 브라우저에서는 압축 해제를 지원하지 않아요.")); }
            return;
          }
        }
        pos+=46+fnLen+exLen+cmLen;
      }
      reject(new Error("word/document.xml을 찾지 못했어요"));
    }catch(ex){ reject(ex); }
  });
}

/* 찾은 낱말에 형광펜. 원문을 건드리지 않고 표시만 입힌다.
 * HTML 특수문자를 먼저 이스케이프하므로 자료에 < & " 가 있어도 안전하다. */
function markTerms(text,terms){
  text=String(text||"");
  if(!terms||!terms.length) return esc(text);
  var lc=text.toLowerCase(), ranges=[];
  terms.forEach(function(t){
    var lt=t.toLowerCase(), from=0, at;
    while((at=lc.indexOf(lt,from))>=0){ ranges.push([at,at+t.length]); from=at+t.length; }
  });
  if(!ranges.length) return esc(text);
  ranges.sort(function(a,b){ return a[0]-b[0]; });
  var out="", pos=0;
  ranges.forEach(function(r){
    if(r[0]<pos) return;
    out+=esc(text.slice(pos,r[0]))+'<mark>'+esc(text.slice(r[0],r[1]))+'</mark>';
    pos=r[1];
  });
  return out+esc(text.slice(pos));
}

/* 워드: 문단 그대로 / PDF: 쪽 텍스트를 이어 붙여 줄로 나눈다 */
function refLinesFromDocx(buf){
  return extractDocXml(buf).then(function(xml){
    var doc=new DOMParser().parseFromString(xml,"text/xml");
    var ns="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    var ps=doc.getElementsByTagNameNS(ns,"p"), out=[];
    for(var i=0;i<ps.length;i++){
      var ts=ps[i].getElementsByTagNameNS(ns,"t"), txt="";
      for(var k=0;k<ts.length;k++) txt+=ts[k].textContent;
      txt=txt.replace(/\s+/g," ").trim();
      if(txt) out.push(txt);
    }
    return out;
  });
}
function refLinesFromPdf(buf){
  return extractPdfPages(buf,function(i,n){ showToast("텍스트 추출 "+i+"/"+n+"쪽"); })
    .then(function(pages){
      var out=[];
      pages.forEach(function(pg){
        /* 쪽 안에서도 절 머리말 앞에서 줄을 끊는다 */
        pg.content.split(/(?=\s(?:제\s*\d+\s*부\.|§\s*\d+|\d+-\d+(?:-\d+)?\.))/)
          .forEach(function(x){ x=x.trim(); if(x) out.push(x); });
      });
      return out;
    });
}

function refUploadClick(id){
  if(refBusy) return;
  refTargetId=id||null;
  document.getElementById("reffile").click();
}
var refTargetId=null;

function refUpload(f){
  if(refBusy) return;
  var target=refTargetId; refTargetId=null;
  var isDocx=/\.docx$/i.test(f.name), isPdf=/\.pdf$/i.test(f.name);
  if(!isDocx&&!isPdf){ showToast("PDF나 워드(.docx) 파일만 돼요.",true); return; }
  refBusy=true; render();
  showToast("파일 읽는 중...");
  var path=Date.now()+"_"+f.name.replace(/[^a-zA-Z0-9._-]/g,"_"), uploaded=false, lines=[];
  readBuffer(f).then(function(buf){
    return isDocx?refLinesFromDocx(buf):refLinesFromPdf(buf);
  }).then(function(ls){
    lines=ls;
    var chars=0; lines.forEach(function(l){ chars+=l.length; });
    if(chars<200) throw new Error("글자를 거의 못 뽑았어요. 스캔본이면 아직 안 돼요.");
    showToast("파일 올리는 중...");
    return sb.storage.from("files").upload(path,f);
  }).then(function(res){
    if(res.error) throw new Error("업로드 실패: "+res.error.message);
    uploaded=true;
    var chars=0; lines.forEach(function(l){ chars+=l.length; });
    var parts=buildRefParts(lines,f.name.replace(/\.(docx|pdf)$/i,""));
    if(!parts.length) throw new Error("내용을 찾지 못했어요.");
    if(target){
      var old=S.refs.find(function(x){ return x.id===target; });
      var oldPath=old&&old.filePath;
      var patch={filePath:path,fileName:f.name,chars:chars,parts:parts.length};
      if(old){ Object.keys(patch).forEach(function(k){ old[k]=patch[k]; }); }
      return dbUpdate("refs",target,patch)
        .then(function(){ if(oldPath&&oldPath!==path) sb.storage.from("files").remove([oldPath]); })
        .then(function(){ return saveRefParts(target,parts); });
    }
    var item={name:f.name.replace(/\.(docx|pdf)$/i,""),filePath:path,fileName:f.name,
              chars:chars,parts:parts.length};
    return dbInsert("refs",item).then(function(row){
      if(!row) throw new Error("자료 정보를 저장하지 못했어요.");
      S.refs.unshift(item);
      return saveRefParts(row.id,parts);
    });
  }).then(function(){
    refBusy=false; refListOpen=true;
    if(refQuery) refSearch(); else render();
    showToast(target?"✓ 자료를 갱신했어요":"✓ 자료를 추가했어요");
  }).catch(function(err){
    refBusy=false;
    if(uploaded&&!target) sb.storage.from("files").remove([path]);
    render();
    showToast((err&&err.message)||"자료를 넣지 못했어요.",true);
  });
}

function saveRefParts(refId,parts){
  return withAuthRetry(function(){
    return sb.from("ref_parts").delete().eq("ref_id",refId);
  }).then(function(res){
    if(res.error) throw new Error("옛 내용을 지우지 못했어요: "+res.error.message);
    var rows=parts.map(function(pt){
      return {ref_id:refId,seq:pt.seq,label:pt.label,level:pt.level,need:pt.need,content:pt.content};
    });
    var i=0;
    function chunk(){
      if(i>=rows.length) return Promise.resolve();
      var part=rows.slice(i,i+40); i+=40;
      showToast("저장 중 "+Math.min(i,rows.length)+"/"+rows.length);
      return withAuthRetry(function(){ return sb.from("ref_parts").insert(part); }).then(function(r){
        if(r.error) throw new Error("저장 실패: "+r.error.message);
        return chunk();
      });
    }
    return chunk();
  });
}

function refName(id){
  var r=S.refs.find(function(x){ return x.id===id; });
  return r?r.name:"(지운 자료)";
}

function refSearch(){
  var q=(val("ref-q")||"").trim();
  refQuery=q; refHits=null; refOpen={};
  refTerms=lawTerms(q);
  if(!refTerms.length&&!refNeedOnly){ renderRefResults(); showToast("두 글자 이상 입력해 주세요."); return; }
  if(!S.refs.length){ renderRefResults(); showToast("먼저 자료를 올려주세요."); return; }
  refSearching=true; renderRefResults();
  withAuthRetry(function(){
    var qb=sb.from("ref_parts").select("id,ref_id,seq,label,level,need,content");
    refTerms.forEach(function(t){ qb=qb.ilike("content","%"+escLike(t)+"%"); });
    if(refNeedOnly) qb=qb.eq("need",true);
    return qb.order("ref_id").order("seq").limit(200);
  }).then(function(res){
    refSearching=false;
    if(res.error){
      showToast(/ref_parts/.test(res.error.message||"")?"자료 표가 아직 없어요. Supabase SQL을 먼저 돌려주세요.":"검색 실패: "+res.error.message,true);
      refHits=[]; renderRefResults(); return;
    }
    refHits=buildRefHits(res.data||[],refTerms);
    renderRefResults();
  });
}
var refSearching=false;

function buildRefHits(rows,terms){
  var out=[], PAD=90, MAX=5;
  rows.forEach(function(r){
    var c=r.content||"", lc=c.toLowerCase(), found=[];
    terms.forEach(function(t){
      var lt=t.toLowerCase(), from=0, n=0, at;
      while(n<10&&(at=lc.indexOf(lt,from))>=0){ found.push({at:at,len:t.length}); from=at+t.length; n++; }
    });
    found.sort(function(a,b){ return a.at-b.at; });
    var total=found.length, wins=[];
    found.forEach(function(f){
      var st=Math.max(0,f.at-PAD), en=Math.min(c.length,f.at+f.len+PAD);
      var last=wins.length?wins[wins.length-1]:null;
      if(last&&st<=last.en){ if(en>last.en) last.en=en; }
      else wins.push({st:st,en:en});
    });
    if(!wins.length) wins=[{st:0,en:Math.min(c.length,260)}];
    if(wins.length>MAX) wins=wins.slice(0,MAX);
    out.push({ key:"r"+r.id, refId:r.ref_id, label:r.label, level:r.level, need:r.need,
               total:total,
               snips:wins.map(function(w){
                 return (w.st>0?"…":"")+c.slice(w.st,w.en)+(w.en<c.length?"…":"");
               }) });
  });
  out.sort(function(a,b){
    var na=refName(a.refId), nb=refName(b.refId);
    return na!==nb ? (na<nb?-1:1) : 0;
  });
  return out;
}

function refDel(id){
  var r=S.refs.find(function(x){ return x.id===id; }); if(!r) return;
  if(!confirm('"'+r.name+'"\n\n자료와 뽑아둔 내용이 모두 지워집니다. 계속할까요?')) return;
  if(r.filePath) sb.storage.from("files").remove([r.filePath]);
  S.refs=S.refs.filter(function(x){ return x.id!==id; });
  refHits=null; render(); dbDelete("refs",id);
}

/* 문서 인덱스 탭은 2026-08-31에 없앴다.
 * 하던 일 ① 공개 PDF 올리기 → 법령 탭이 더 잘한다(전문 검색까지 된다)
 *        ② 파일 없이 위치만 적어 두기 → 쓴 적이 없어 버렸다
 * `docs` 표와 TABLES 항목은 그대로 둔다 — 데이터도 백업도 보존되고,
 * 되돌리고 싶어지면 화면만 다시 붙이면 된다. */

/* ========== 액션 (id 없이 insert → 서버가 uuid 생성) ========== */
function addSchedule(dueKey,inputId){
  var v=(val(inputId||"new-s")||"").trim(); if(!v) return;
  var item={text:v,done:false,star:false,due:dueKey||keyOf(new Date())};
  S.schedule.unshift(item); render(); dbInsert("schedule",item);
}
function addArticle(){ var t=(val("a-title")||"").trim(); if(!t) return; var item={title:t,status:segValue("a-status")||"기획",memo:(val("a-memo")||"").trim()}; S.articles.unshift(item); formOpen.articles=false; render(); dbInsert("articles",item); }
function addMfds(){ var t=(val("m-title")||"").trim(); if(!t) return;
  var item={title:t,status:segValue("m-status")||"대기",memo:(val("m-memo")||"").trim(),
            due:(val("m-due")||"")||null,time:(val("m-time")||"").trim()||null,place:(val("m-place")||"").trim()||null};
  S.mfds.unshift(item); formOpen.mfds=false; render(); dbInsert("mfds",item); }
/* 보관 — 지우는 게 아니라 목록에서 접어 둔다.
 * 민원 자료는 나중에 「그때 뭐라고 했지」를 찾는 기록이라 지우면 안 된다. */

/* 되돌릴 수 있는 삭제.
 * 예전엔 ✕ 를 누르면 바로 사라지고 되돌릴 길이 없었다. ✕ 가 ☆ 바로 옆에
 * 붙어 있어서 손가락으로는 잘못 누르기 쉽다 — 확인창 대신 되돌리기를 준다. */
var UNDO_LABEL={schedule:"할 일",articles:"기고글",mfds:"업무",
                archive:"자료",events:"일정",docs:"문서"};
function del(name,id,quiet){
  var it=S[name].find(function(x){ return x.id===id; });
  S[name]=S[name].filter(function(x){ return x.id!==id; });
  render();
  dbDelete(name,id);
  if(quiet||!it) return;
  showUndoToast((UNDO_LABEL[name]||"항목")+"을 지웠어요", function(){
    S[name].unshift(it);
    render();
    dbUpsert(name,it);
    showToast("↩ 되돌렸어요");
  });
}

/* 그 달에 오늘이 있으면 오늘, 없으면 1일을 고른다 */
function calSyncSel(){
  var n=new Date();
  var d=(n.getFullYear()===calYear&&n.getMonth()===calMonth)?n.getDate():1;
  calSel=calYear+"-"+pad(calMonth+1)+"-"+pad(d);
}

function dayAdd(){
  var raw=(val("day-ev")||"").trim(); if(!raw) return;
  var time=(val("day-time")||"").trim();
  var place=(val("day-place")||"").trim();
  var r=parseNL(raw), title=raw;
  if(r.ok){ if(!time) time=r.time; title=r.title; }   /* 칸을 비웠으면 말로 적은 시간을 쓴다 */
  var chk=document.getElementById("day-mfds");
  if(chk&&chk.checked){
    /* 일정이 아니라 식약처 업무로 등록. 캘린더는 mfds를 직접 읽으므로 여기에도 그대로 뜬다. */
    var task={title:title,status:"대기",memo:"",due:calSel,time:time||null,place:place||null};
    S.mfds.unshift(task); render(); dbInsert("mfds",task); return;
  }
  var item={key:calSel,time:time||null,title:title,place:place||null};
  S.events.push(item); render(); dbInsert("events",item);
}
function evDel(id){ del("events",id); }

/* ========== 파일 업로드 (Supabase Storage — private bucket) ========== */

/* 장소를 네이버 지도에서 연다. 검색어로 여는 방식이라 API 키가 필요 없고,
 * 아이패드에선 지도 앱이 바로 뜬다. */
function openMap(q){
  q=(q||"").trim(); if(!q) return;
  window.open("https://map.naver.com/p/search/"+encodeURIComponent(q),"_blank","noopener");
}

/* 시간·장소 한 줄 — 일정과 식약처 업무가 같은 모양을 쓴다 */
function whereHtml(it,table){
  var at=function(f,ph){ return ' data-act="edit" data-table="'+table+'" data-field="'+f+'" data-id="'+it.id+'" title="'+ph+'"'; };
  var out='<span class="ev-place"'+at("place","눌러서 장소 수정")+'>'
    + (it.place? '📍 '+esc(it.place) : '<span class="none">＋ 장소</span>')+'</span>';
  if(it.place) out+='<button class="link-btn map-btn" data-act="map" data-q="'+esc(it.place)+'">지도 ↗</button>';
  return out;
}

/* 비공개 버킷: signed URL로 파일 열기 */
function openStorageFile(path){
  sb.storage.from("files").createSignedUrl(path,3600).then(function(res){
    if(res.error){ showToast("파일을 열지 못했어요.",true); return; }
    window.open(res.data.signedUrl,"_blank");
  });
}

/* ========== 백업 (JSON 내보내기/불러오기) ========== */
function exportData(){
  var blob=new Blob([JSON.stringify(S,null,2)],{type:"application/json"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="업무데스크_백업_"+new Date().toISOString().slice(0,10)+".json"; a.click();
}
function importData(){ document.getElementById("file").click(); }
document.getElementById("file").addEventListener("change",function(e){
  var f=e.target.files[0]; if(!f) return;
  var r=new FileReader();
  r.onload=function(){
    try{
      var d=JSON.parse(r.result);
      var promises=[];
      TABLES.forEach(function(k){
        if(Array.isArray(d[k])){
          S[k]=d[k];
          d[k].forEach(function(item){ promises.push(dbUpsert(k,item)); });
        }
      });
      render();
      Promise.all(promises).then(function(){ showToast("✓ 백업 불러오기 완료"); });
    }catch(err){ alert("백업 파일을 읽지 못했어요."); }
  };
  r.readAsText(f); e.target.value="";
});

/* ========== 법령 검색 (1단계) ==========
 * PDF → pdf.js로 쪽마다 텍스트 추출 → law_pages(쪽) + law_articles(조문) 저장.
 * 검색은 law_articles를 본다 — 한 줄이 곧 조 하나라 결과 묶기·조 전체 보기가
 * 추측 없이 정확해진다. law_pages는 "이 쪽만 보기"와 PDF 쪽 이동에 쓴다. */

var lawQuery="", lawTermList=[], lawHits=null, lawSel={}, lawOpen={}, lawBusy=false, lawSearching=false, lawListOpen=false;
/* 처음 쓰는 사람에겐 펼쳐서 보여주고, 한 번 접으면 그 뒤로는 접힌 채로 둔다 */
var lawHelpOpen=(function(){
  try{ return window.localStorage.getItem("lawHelpSeen")!=="1"; }catch(e){ return true; }
})();
function lawHelpToggle(){
  lawHelpOpen=!lawHelpOpen;
  if(!lawHelpOpen){ try{ window.localStorage.setItem("lawHelpSeen","1"); }catch(e){} }
  render();
}

/* pdf.js는 1MB가 넘으므로 이 탭을 쓸 때만 내려받는다 */
var PDFJS_BASE="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/";
var pdfjsReady=null;
function loadPdfJs(){
  if(pdfjsReady) return pdfjsReady;
  pdfjsReady=new Promise(function(resolve,reject){
    if(window.pdfjsLib){ resolve(window.pdfjsLib); return; }
    var sc=document.createElement("script");
    sc.src=PDFJS_BASE+"pdf.min.js";
    sc.onload=function(){
      if(!window.pdfjsLib){ pdfjsReady=null; reject(new Error("PDF 처리기를 불러오지 못했어요.")); return; }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDFJS_BASE+"pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    sc.onerror=function(){ pdfjsReady=null; reject(new Error("PDF 처리기를 내려받지 못했어요. 네트워크를 확인해 주세요.")); };
    document.head.appendChild(sc);
  });
  return pdfjsReady;
}

/* 일부 환경에서는 다른 도메인의 워커 파일이 막힌다.
 * 그때는 워커 파일을 본체 스레드에 직접 올려서 다시 시도한다. */
var pdfInlineReady=null;
function loadPdfWorkerInline(){
  if(pdfInlineReady) return pdfInlineReady;
  pdfInlineReady=new Promise(function(resolve,reject){
    if(window.pdfjsWorker){ resolve(); return; }
    var sc=document.createElement("script");
    sc.src=PDFJS_BASE+"pdf.worker.min.js";
    sc.onload=function(){ resolve(); };
    sc.onerror=function(){ pdfInlineReady=null; reject(new Error("PDF 처리기를 내려받지 못했어요.")); };
    document.head.appendChild(sc);
  });
  return pdfInlineReady;
}

function readBuffer(f){
  return new Promise(function(resolve,reject){
    var r=new FileReader();
    r.onload=function(){ resolve(r.result); };
    r.onerror=function(){ reject(new Error("파일을 읽지 못했어요.")); };
    r.readAsArrayBuffer(f);
  });
}

/* 쪽마다 텍스트를 뽑는다. 글자가 없는 쪽(표지·이미지)은 건너뛴다. */
function extractPdfPages(buf,onProgress){
  var bytes=new Uint8Array(buf);
  var backup=bytes.slice(0);   /* pdf.js가 워커로 넘기면 원본이 비므로 사본을 남긴다 */
  return loadPdfJs().then(function(pdfjsLib){
    return pdfjsLib.getDocument({data:bytes}).promise.catch(function(){
      return loadPdfWorkerInline().then(function(){
        return pdfjsLib.getDocument({data:backup}).promise;
      });
    });
  }).then(function(doc){
    var pages=[], total=doc.numPages;
    function step(i){
      if(i>total) return Promise.resolve(pages);
      return doc.getPage(i).then(function(pg){ return pg.getTextContent(); }).then(function(tc){
        var txt=tc.items.map(function(it){ return it.str; }).join(" ").replace(/\s+/g," ").trim();
        if(txt) pages.push({page:i,content:txt});
        if(onProgress) onProgress(i,total);
        return step(i+1);
      });
    }
    return step(1);
  });
}

function lawUploadClick(){ if(!lawBusy) document.getElementById("lawfile").click(); }

/* 파일 선택 배선 — 두 탭이 같은 방식이다.
 * (예전엔 이 리스너가 .docx 가져오기 구역 안에 섞여 있었다) */
document.getElementById("lawfile").addEventListener("change",function(e){
  var f=e.target.files[0]; e.target.value=""; if(!f) return;
  lawUpload(f);
});
document.getElementById("reffile").addEventListener("change",function(e){
  var f=e.target.files[0]; e.target.value=""; if(!f) return;
  refUpload(f);
});

function lawUpload(f){
  if(lawBusy) return;
  lawBusy=true; render();
  var path=Date.now()+"_"+f.name.replace(/[^a-zA-Z0-9._-]/g,"_");
  var uploaded=false;
  showToast("PDF 읽는 중...");
  readBuffer(f).then(function(buf){
    return extractPdfPages(buf,function(i,n){ showToast("텍스트 추출 "+i+"/"+n+"쪽"); });
  }).then(function(pages){
    /* 조가 여러 쪽에 걸치므로, 쪽마다 "시작 시점에 유효한 조"를 기록해 둔다.
     * 전체 쪽을 순서대로 들고 있는 지금이 이걸 계산할 수 있는 유일한 시점이다. */
    var carry="";
    pages.forEach(function(p){
      p.article=carry;
      var a=findArticles(p.content);
      if(a.length) carry=a[a.length-1].label;
    });
    /* 스캔본이면 글자가 거의 안 나온다 — 올려봐야 검색이 안 되므로 여기서 멈춘다 */
    var chars=0; pages.forEach(function(p){ chars+=p.content.length; });
    if(chars<200) throw new Error("SCAN");
    showToast("파일 올리는 중...");
    return sb.storage.from("files").upload(path,f).then(function(res){
      if(res.error) throw new Error("업로드 실패: "+res.error.message);
      uploaded=true;
      return pages;
    });
  }).then(function(pages){
    var item={name:f.name.replace(/\.pdf$/i,""),filePath:path,fileName:f.name,pages:pages.length};
    return dbInsert("laws",item).then(function(row){
      if(!row) throw new Error("법령 정보를 저장하지 못했어요.");
      S.laws.unshift(item);
      return saveLawPages(row.id,pages).then(function(){
        return saveLawArticles(row.id,buildLawArticles(pages),item);
      });
    });
  }).then(function(){
    lawBusy=false; lawListOpen=true; render();
    showToast("✓ 법령 추가 완료");
  }).catch(function(err){
    lawBusy=false;
    if(uploaded) sb.storage.from("files").remove([path]);
    render();
    if(err&&err.message==="SCAN"){
      alert("글자가 없는 스캔본 같아요.\n\n1단계는 글자가 들어 있는 PDF만 지원해요.\n법제처에서 받은 PDF면 대부분 됩니다.");
    } else showToast((err&&err.message)||"법령을 추가하지 못했어요.",true);
  });
}

/* 한 번에 다 넣으면 요청이 너무 커진다 — 50쪽씩 나눠 보낸다 */
function saveLawPages(lawId,pages){
  var rows=pages.map(function(p){ return {law_id:lawId,page:p.page,content:p.content,article:p.article||null}; });
  var i=0;
  function chunk(){
    if(i>=rows.length) return Promise.resolve();
    var part=rows.slice(i,i+50); i+=50;
    showToast("저장 중 "+Math.min(i,rows.length)+"/"+rows.length+"쪽");
    return withAuthRetry(function(){ return sb.from("law_pages").insert(part); }).then(function(res){
      if(res.error&&isNoArtCol(res.error)){
        lawArtCol=false;
        var plain=part.map(function(r){ return {law_id:r.law_id,page:r.page,content:r.content}; });
        return withAuthRetry(function(){ return sb.from("law_pages").insert(plain); });
      }
      return res;
    }).then(function(res){
      if(res.error) throw new Error("쪽 저장 실패: "+res.error.message);
      return chunk();
    });
  }
  return chunk();
}

/* ---------- 조문 단위로 쪼개기 ----------
 * 쪽 단위로 저장해 놓고 "조가 어디서 끝나나"를 쪽 경계로 추측하던 옛 방식은
 * 한 쪽에 조가 여러 개 들어가는 순간 반드시 틀린다(제40조를 열면 41·42조가
 * 딸려 왔다). 그래서 문서 전체를 한 줄로 이어 붙인 뒤 머리말 위치에서
 * 직접 자른다. 자른 결과가 곧 law_articles 한 줄이다. */
var LAW_ART_SAVE_MAX=60000;   /* 조 하나가 이보다 길면 잘라 저장한다 */
var SOON_RE=/\[\s*시행일\s*:\s*([^\]]{1,24})\]/;

function buildLawArticles(pages){
  var buf=[], marks=[], pos=0;
  pages.forEach(function(p){
    var t=(p.content||"").trim();
    if(!t) return;
    marks.push({at:pos,page:p.page});
    buf.push(t); pos+=t.length+1;
  });
  if(!marks.length) return [];
  var full=buf.join("\n");
  /* 쪽 경계 표시가 없으므로, 잘린 위치가 몇 쪽인지는 marks로 되짚는다 */
  function pageAt(at){
    var lo=0, hi=marks.length-1, ans=marks[0].page;
    while(lo<=hi){
      var mid=(lo+hi)>>1;
      if(marks[mid].at<=at){ ans=marks[mid].page; lo=mid+1; } else hi=mid-1;
    }
    return ans;
  }
  var heads=findArticles(full,20000), out=[];
  for(var i=0;i<heads.length;i++){
    var a=heads[i].at, b=(i+1<heads.length)?heads[i+1].at:full.length;
    var text=full.slice(a,b).replace(/\s+/g," ").trim();
    if(text.length<10) continue;
    if(text.length>LAW_ART_SAVE_MAX) text=text.slice(0,LAW_ART_SAVE_MAX);
    /* 법제처 PDF는 「곧 시행될 개정 조문」을 현행 조문 바로 뒤에 한 번 더 싣고
     * 끝에 [시행일: 2026. 10. 8.] 을 붙인다. 같은 라벨이 두 번 나오는 진짜 이유다.
     * 지우면 안 되는 정보이므로, 라벨에 시행일을 붙여 구분되게 한다. */
    var lab=heads[i].label, sh=SOON_RE.exec(text);
    if(sh) lab+=" · 시행 "+sh[1].replace(/\s+/g," ").trim();
    out.push({ seq:out.length+1, label:lab, num:artShort(heads[i].label),
               page:pageAt(a), page_end:pageAt(b-1), content:text });
  }
  /* 같은 라벨이 두 번 이상 잡히면 — 앞쪽 목차 줄이나 인용이 섞인 것이다.
   * 가장 긴 것(=진짜 본문)만 남기고, 짧은 쪽을 버린다.
   * 짧은 것만 버리므로 라벨이 진짜로 두 번 나오는 문서는 그대로 둔다. */
  var best={};
  out.forEach(function(a){
    var k=artKey(a.label);
    if(!best[k]||a.content.length>best[k].content.length) best[k]=a;
  });
  out=out.filter(function(a){
    var k=artKey(a.label);
    return best[k]===a||a.content.length>=200;
  });
  out.forEach(function(a,i){ a.seq=i+1; });

  /* 조가 없는 문서(지침서·안내서)는 쪽을 그대로 한 단위로 쓴다 */
  if(out.length<2){
    out=[];
    pages.forEach(function(p){
      var t=(p.content||"").trim();
      if(!t) return;
      out.push({ seq:out.length+1, label:p.page+"쪽", num:p.page+"쪽",
                 page:p.page, page_end:p.page, content:t });
    });
  }
  return out;
}

/* 한 법령의 조문을 통째로 갈아끼운다.
 * 지우고 넣는 사이에 같은 법령이 또 들어오면 두 벌이 섞이므로 잠근다. */
var lawSaving={};
function saveLawArticles(lawId,arts,localItem){
  if(lawSaving[lawId]) return Promise.reject(new Error("이미 조문을 만드는 중이에요."));
  lawSaving[lawId]=1;
  function unlock(v){ delete lawSaving[lawId]; return v; }
  function fail(e){ delete lawSaving[lawId]; throw e; }
  return withAuthRetry(function(){
    return sb.from("law_articles").delete().eq("law_id",lawId);
  }).then(function(res){
    if(res.error) throw new Error("옛 조문을 지우지 못했어요: "+res.error.message);
    var rows=arts.map(function(a){
      return {law_id:lawId,seq:a.seq,label:a.label,num:a.num,
              page:a.page,page_end:a.page_end,content:a.content};
    });
    var i=0;
    function chunk(){
      if(i>=rows.length) return Promise.resolve();
      var part=rows.slice(i,i+30); i+=30;
      showToast("조문 저장 "+Math.min(i,rows.length)+"/"+rows.length);
      return withAuthRetry(function(){ return sb.from("law_articles").insert(part); }).then(function(r){
        if(r.error) throw new Error("조문 저장 실패: "+r.error.message);
        return chunk();
      });
    }
    return chunk();
  }).then(function(){
    if(localItem) localItem.arts=arts.length;
    return dbUpdate("laws",lawId,{arts:arts.length});
  }).then(unlock,fail);
}

/* 조문 판별 규칙이 나아질 때마다 다시 올리지 않아도 되게,
 * 이미 저장된 쪽 텍스트만으로 조문 정보를 다시 계산한다 (PDF 안 받음). */
function lawReindex(id){
  if(lawBusy) return;
  var l=S.laws.find(function(x){ return x.id===id; });
  if(!l) return;
  lawBusy=true; render();
  showToast("쪽을 읽는 중...");
  withAuthRetry(function(){
    return sb.from("law_pages").select("id,law_id,page,content").eq("law_id",id).order("page");
  }).then(function(res){
    if(res.error) throw new Error("쪽을 읽지 못했어요: "+res.error.message);
    var rows=res.data||[];
    if(!rows.length) throw new Error("저장된 쪽이 없어요. PDF를 다시 올려주세요.");
    /* 쪽마다 "시작 시점에 유효한 조"도 같이 갱신한다 — 쪽 보기에서 쓴다 */
    var carry="";
    rows.forEach(function(r){
      r.article=carry||null;
      var a=findArticles(r.content||"");
      if(a.length) carry=a[a.length-1].label;
    });
    var arts=buildLawArticles(rows);
    if(!arts.length) throw new Error("조문을 하나도 찾지 못했어요.");
    showToast("조문 "+arts.length+"개를 찾았어요");
    var i=0;
    function pageChunk(){
      if(i>=rows.length) return Promise.resolve();
      var part=rows.slice(i,i+50); i+=50;
      return withAuthRetry(function(){ return sb.from("law_pages").upsert(part); }).then(function(r2){
        if(r2.error&&isNoArtCol(r2.error)){ lawArtCol=false; return null; }
        if(r2.error) throw new Error("쪽 저장 실패: "+r2.error.message);
        return pageChunk();
      });
    }
    return pageChunk().then(function(){ return saveLawArticles(id,arts,l); });
  }).then(function(){
    lawBusy=false; lawArtCol=true; lawPageCache={};
    if(lawQuery) lawSearch(); else render();
    showToast("✓ 조문을 다시 만들었어요");
  }).catch(function(err){
    lawBusy=false; render();
    showToast((err&&err.message)||"조문을 만들지 못했어요.",true);
  });
}

/* 아직 조문이 없는 법령을 한꺼번에 처리한다 */
function lawBuildAll(){
  if(lawBusy) return;
  var todo=S.laws.filter(function(l){ return !l.arts; });
  if(!todo.length){ showToast("모두 조문이 만들어져 있어요."); return; }
  lawBusy=true; render();
  var k=0, ok=0;
  function fin(){
    lawBusy=false; render();
    showToast("✓ "+ok+"/"+todo.length+"개 법령의 조문을 만들었어요");
  }
  function next(){
    if(k>=todo.length){ fin(); return; }
    var l=todo[k++];
    showToast("("+k+"/"+todo.length+") "+l.name);
    lawReindexOne(l).then(function(){ ok++; next(); },function(err){
      showToast(l.name+" — "+((err&&err.message)||"실패"),true);
      next();
    });
  }
  next();
}
function lawReindexOne(l){
  return withAuthRetry(function(){
    return sb.from("law_pages").select("page,content").eq("law_id",l.id).order("page");
  }).then(function(res){
    if(res.error) throw new Error(res.error.message);
    var rows=res.data||[];
    if(!rows.length) throw new Error("쪽 없음");
    var arts=buildLawArticles(rows);
    if(!arts.length) throw new Error("조문 없음");
    return saveLawArticles(l.id,arts,l);
  });
}

function lawName(id){
  var l=S.laws.find(function(x){ return x.id===id; });
  return l?l.name:"(삭제된 법령)";
}

/* ilike의 % _ \ 는 특수문자라 그대로 넣으면 엉뚱한 걸 찾는다 */
function escLike(s){ return s.replace(/([%_\\])/g,"\\$1"); }

/* article 컬럼은 나중에 추가된 것이라 아직 없는 DB가 있을 수 있다.
 * 없으면 한 번만 감지해서 그 컬럼 없이 계속 동작한다 (조문 표시만 빠진다) */
var lawArtCol=true;
function isNoArtCol(err){
  var m=((err&&err.message)||"").toLowerCase();
  return m.indexOf("article")>=0&&(m.indexOf("column")>=0||m.indexOf("does not exist")>=0);
}

function lawSearch(){
  var q=(val("law-q")||"").trim();
  lawQuery=q; lawSel={}; lawHits=null; lawOpen={};
  lawTermList=lawTerms(q);
  if(!lawTermList.length){ renderLawResults(); showToast("두 글자 이상 입력해 주세요."); return; }
  if(!S.laws.length){ renderLawResults(); showToast("먼저 법령 PDF를 올려주세요."); return; }
  lawSearching=true; renderLawResults();
  function run(){
    return withAuthRetry(function(){
      var qb=sb.from("law_articles").select("id,law_id,seq,label,num,page,page_end,content");
      /* 낱말마다 조건을 겹쳐 걸면 모두 들어 있는 조문만 남는다 (교집합) */
      lawTermList.forEach(function(t){ qb=qb.ilike("content","%"+escLike(t)+"%"); });
      return qb.order("law_id").order("seq").limit(200);
    });
  }
  run().then(function(res){
    lawSearching=false;
    if(res.error){
      if(/law_articles/.test(res.error.message||"")){
        showToast("조문 표가 아직 없어요. Supabase SQL을 먼저 돌려주세요.",true);
      } else showToast("검색 실패: "+res.error.message,true);
      lawHits=[]; renderLawResults(); return;
    }
    lawHits=buildLawHits(res.data||[],lawTermList);
    renderLawResults();
  });
}

/* 검색어 쪼개기 — 따옴표로 묶으면 붙은 말 그대로, 아니면 낱말마다 교집합(AND) */
function lawTerms(q){
  var out=[], re=/"([^"]{1,40})"|(\S+)/g, m;
  while((m=re.exec(q))!==null){
    var t=(m[1]||m[2]||"").trim();
    if(t.length>=2) out.push(t);
    if(out.length>=5) break;
  }
  return out;
}

/* 같은 조(또는 같은 쪽)에서 나온 결과는 한 덩어리로 묶는다.
 * 안 묶으면 한 조에서 키워드가 여러 번 나올 때 같은 카드가 계속 반복돼 보인다. */
function buildLawHits(rows,terms){
  var out=[], PAD=80, MAX_SNIP=6;
  rows.forEach(function(r){
    var c=r.content||"", lc=c.toLowerCase();
    var arts=findArticles(c,5), skips=metaSkips(c), found=[];
    terms.forEach(function(t){
      var lt=t.toLowerCase(), from=0, n=0;
      while(n<10){
        var at=lc.indexOf(lt,from); if(at<0) break;
        found.push({at:at,len:t.length}); from=at+t.length; n++;
      }
    });
    if(!found.length) return;
    found.sort(function(a,b){ return a.at-b.at; });
    var total=found.length;

    /* 검색어가 가까이 붙어 있으면 앞뒤 80자 창이 서로 겹쳐서
     * 같은 문장이 두세 번 나온다. 겹치는 창은 하나로 합친다.
     * 합친 창 안의 검색어는 어차피 표시할 때 전부 노랗게 칠해진다. */
    var wins=[];
    found.forEach(function(f){
      var st=Math.max(0,f.at-PAD), en=Math.min(c.length,f.at+f.len+PAD);
      var last=wins.length?wins[wins.length-1]:null;
      if(last&&st<=last.en){ if(en>last.en) last.en=en; }
      else wins.push({st:st,en:en,at:f.at});
    });
    if(wins.length>MAX_SNIP) wins=wins.slice(0,MAX_SNIP);

    var g={ key:"a"+r.id, artId:r.id, lawId:r.law_id, art:r.label,
            page:r.page, pageEnd:r.page_end||r.page,
            total:total, spots:wins.length, snips:[] };
    wins.forEach(function(w){
      var a=articleAt(arts,c,w.at,r.label,skips);
      g.snips.push({ where:(a&&a.detail)||"",
        text:(w.st>0?"…":"")+c.slice(w.st,w.en)+(w.en<c.length?"…":"") });
    });
    out.push(g);
  });
  out.sort(function(a,b){
    var na=lawName(a.lawId), nb=lawName(b.lawId);
    if(na!==nb) return na<nb?-1:1;
    return a.page-b.page;
  });
  return out;
}

/* ---------- 조 전체 보기 ----------
 * law_articles 한 줄이 곧 조 하나다. 예전에는 쪽을 좌우로 훑어 조의 범위를
 * 추측했는데, 한 쪽에 조가 여러 개면 반드시 틀렸다. 이제 계산이 없다. */
var lawPageCache={}, lawViewSeq=0;

function artKey(s){ return String(s||"").replace(/\s+/g,""); }
function artShort(label){
  var m=/^(제\s*\d+\s*조(?:\s*의\s*\d+)?|별표\s*\d+(?:의\d+)?|별지\s*제\d+호서식)/.exec(String(label||""));
  return m?m[1].replace(/\s+/g,""):String(label||"").slice(0,12);
}

function lawCacheGet(lawId,page){ return lawPageCache[lawId+"|"+page]; }
function lawCachePut(lawId,rows){
  if(Object.keys(lawPageCache).length>400) lawPageCache={};   /* 통째로 비운다 — LRU까지는 필요 없다 */
  (rows||[]).forEach(function(r){
    lawPageCache[lawId+"|"+r.page]={content:r.content||"",article:r.article||""};
  });
}
/* lo~hi 쪽을 확보한다. 이미 가진 쪽은 건너뛰고, 없는 구간만 한 번에 가져온다. */
function lawFetchPages(lawId,lo,hi){
  var need=[], p;
  for(p=lo;p<=hi;p++){ if(!lawCacheGet(lawId,p)) need.push(p); }
  if(!need.length) return Promise.resolve();
  var a=Math.min.apply(null,need), b=Math.max.apply(null,need);
  function run(){
    return withAuthRetry(function(){
      return sb.from("law_pages").select(lawArtCol?"page,content,article":"page,content")
        .eq("law_id",lawId).gte("page",a).lte("page",b).order("page");
    });
  }
  return run().then(function(res){
    if(res.error&&lawArtCol&&isNoArtCol(res.error)){ lawArtCol=false; return run(); }
    return res;
  }).then(function(res){
    if(res.error) throw new Error("쪽을 읽지 못했어요: "+res.error.message);
    lawCachePut(lawId,res.data||[]);
  });
}

/* ---------- 쪽 보기 (앱 안에서 바로) ----------
 * PDF를 여는 건 파일 전체를 내려받는 일이라 501쪽짜리는 12MB를 다 받아야
 * 한 쪽이 보인다. 쪽 텍스트는 이미 law_pages에 있으므로 그걸 바로 띄운다. */
var lawView=null;   /* {lawId,page,content,loading,err} */

function openLawView(id,page){
  var l=S.laws.find(function(x){ return x.id===id; });
  if(!l) return;
  var max=l.pages||1;
  if(page<1) page=1; if(page>max) page=max;
  lawView={lawId:id,page:page,loading:true,content:"",err:""};
  renderLawModal();
  function runPage(){
    return withAuthRetry(function(){
      return sb.from("law_pages").select(lawArtCol?"content,article":"content")
        .eq("law_id",id).eq("page",page).limit(1);
    });
  }
  runPage().then(function(res){
    if(res.error&&lawArtCol&&isNoArtCol(res.error)){ lawArtCol=false; return runPage(); }
    return res;
  }).then(function(res){
    if(!lawView||lawView.lawId!==id||lawView.page!==page) return;   /* 그새 다른 쪽으로 옮겼으면 버린다 */
    lawView.loading=false;
    if(res.error) lawView.err="쪽을 불러오지 못했어요: "+res.error.message;
    else if(!res.data||!res.data.length) lawView.content="";
    else { lawView.content=res.data[0].content; lawView.article=res.data[0].article||""; }
    renderLawModal();
  });
}
function closeLawView(){ lawView=null; renderLawModal(); }
function lawViewStep(d){
  if(!lawView) return;
  openLawView(lawView.lawId,lawView.page+d);
}
/* PDF 원문은 필요할 때만 — 파일 전체를 받으므로 느리다 */
function openLawPdf(id,page){
  var l=S.laws.find(function(x){ return x.id===id; });
  if(!l||!l.filePath){ showToast("원문 파일을 찾지 못했어요.",true); return; }
  showToast("PDF 여는 중... 파일이 크면 시간이 걸려요");
  sb.storage.from("files").createSignedUrl(l.filePath,3600).then(function(res){
    if(res.error){ showToast("파일을 열지 못했어요.",true); return; }
    window.open(res.data.signedUrl+"#page="+page,"_blank");
  });
}

/* ---------- 조문 찾기 ----------
 * 추출된 텍스트에서 "제12조(보관)" 같은 조문 머리말을 찾아,
 * 검색어가 어느 조 안에 있는지 알려준다.
 *
 * 제목이 붙은 괄호를 반드시 요구하는 이유:
 *   "제31조제2항에 따라" 처럼 다른 조를 가리키는 말이 본문에 흔한데,
 *   조문 머리말은 법제처 문서에서 항상 "제N조(제목)" 꼴이다.
 *   괄호 제목을 조건으로 걸면 참조와 머리말이 깔끔하게 갈린다.
 * PDF에서 뽑은 글자는 띄어쓰기가 들쭉날쭉해서(제 12 조 ( 보관 )) 공백을 허용한다. */
var ART_RE=/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*\(\s*([^()]{1,40}?)\s*\)/g;
/* 별표: "■ 법령명 [별표 6의2] <개정 …> 의약품등 수입관리 기준 (제60조 관련)"
 * 별지: "[별지 제80호서식] <개정 …> 조사표"  — 서식 구역도 같은 방식으로 잡는다 */
/* 제목 부분은 선택으로 둔다 — 제목 뒤에 괄호가 없는 서식이 있는데,
 * 필수로 두면 그런 쪽에서 규칙이 통째로 실패해 머리말을 아예 못 찾는다. */
var BP_RE=/\[\s*별\s*(표|지)\s*(?:제\s*)?(\d+)(?:\s*의\s*(\d+))?\s*(?:호\s*서\s*식)?\s*\]\s*(?:<[^<>]{0,40}>\s*)?(?:([^()\[\]<>]{0,40}?)\s*(?=\(|\[|<|$))?/g;
var HANG="①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/* 괄호 안이 제목이 아니라 다른 조문을 가리키는 참조인 경우를 걸러낸다.
 * 행정처분 기준 같은 표에서 "법 제47조(이 규칙 제62조)" 처럼
 * 근거법령 칸이 통째로 머리말처럼 보이는 일이 있다. */
function isRefTitle(t){
  var c=t.replace(/\s+/g,"");
  if(!c) return true;
  /* "이 규칙 제62조", "제2항은 제외한다" 처럼 다른 조항을 가리키는 말 */
  if(/제\d+(조|항|호|목)/.test(c)) return true;
  if(/^(이|같은)(규칙|법|영|고시)/.test(c)) return true;
  if(/^\d+$/.test(c)) return true;
  return false;
}

/* 한 쪽 안의 조문·별표 머리말 위치를 모두 찾는다 (쪽마다 한 번만 계산) */
function findArticles(text,max){
  var out=[], m, lim=max||200;
  ART_RE.lastIndex=0;
  while((m=ART_RE.exec(text))!==null){
    var title=m[3].replace(/\s+/g," ").trim();
    if(isRefTitle(title)) continue;
    out.push({ at:m.index, end:m.index+m[0].length,
      label:"제"+m[1]+"조"+(m[2]?"의"+m[2]:"")+"("+title+")" });
    if(out.length>lim) break;
  }
  BP_RE.lastIndex=0;
  while((m=BP_RE.exec(text))!==null){
    var t2=(m[4]||"").replace(/\s+/g," ").trim();
    var head=(m[1]==="지")
      ? "별지 제"+m[2]+(m[3]?"의"+m[3]:"")+"호서식"
      : "별표 "+m[2]+(m[3]?"의"+m[3]:"");
    out.push({ at:m.index, end:m.index+m[0].length, table:true,
      label:head+(t2.length>1?"("+t2+")":"") });
    if(out.length>lim+20) break;
  }
  out.sort(function(a,b){ return a.at-b.at; });
  return out;
}

/* 조문 안의 위치를 항(①) · 호(1.) · 목(가.)까지 짚는다.
 * 날짜(<개정 2007. 10. 17., …>)를 호로 오인하지 않도록 < > [ ] 안쪽은 건너뛴다. */
function metaSkips(text){
  var skip=[], m; META_RE.lastIndex=0;
  while((m=META_RE.exec(text))!==null) skip.push([m.index,m.index+m[0].length]);
  return skip;
}
function inRanges(rs,i){
  for(var k=0;k<rs.length;k++){ if(i>=rs[k][0]&&i<rs[k][1]) return true; }
  return false;
}
function articleAt(arts,text,at,carried,skips){
  var found=null, label=null, from=0;
  for(var i=0;i<arts.length;i++){ if(arts[i].at<=at) found=arts[i]; else break; }
  if(found){ label=found.label; from=found.end; }
  else if(carried){ label=carried; from=0; }
  else return null;
  skips=skips||[];

  var hang="", hangAt=from;
  for(var j=at;j>from;j--){
    if(HANG.indexOf(text.charAt(j))>=0&&!inRanges(skips,j)){ hang=text.charAt(j); hangAt=j; break; }
  }
  /* 호(1. 2.)와 목(가. 나.)은 항 뒤에서 가장 가까운 것을 쓴다 */
  var ho="", mok="";
  for(var k2=at;k2>hangAt;k2--){
    if(inRanges(skips,k2)) continue;
    if(k2>0&&!/\s/.test(text.charAt(k2-1))) continue;
    var seg=text.slice(k2,k2+6);
    if(!ho){
      var mh=/^(\d{1,2})\s*\.\s/.exec(seg);
      if(mh){ ho=mh[1]; continue; }
    }
    if(!mok){
      var mm=/^([가-힣])\s*\.\s/.exec(seg);
      if(mm&&MOK.indexOf(mm[1])>=0){ mok=mm[1]; }
    }
    if(ho&&mok) break;
  }
  /* 조(base)와 그 안의 위치(detail)를 나눠 돌려준다.
   * 카드는 조 단위로 묶고, 항·호·목은 조각마다 따로 보여주기 위해서다. */
  return { base:label, detail:((hang?hang:"")+(ho?" "+ho+"호":"")+(mok?" "+mok+"목":"")).trim() };
}


/* ---------- 원문 보기 좋게 나누기 ----------
 * 글자는 하나도 바꾸지 않는다. 줄바꿈과 들여쓰기만 넣는다.
 * 법령 문서는 조 → 항(①②) → 호(1. 2.) → 목(가. 나.) 구조인데
 * PDF에서 뽑으면 전부 한 줄로 이어져 읽기가 어렵다. */

var META_RE=/<[^<>]{0,400}>|\[[^\[\]]{0,200}\]/g;   /* <개정 2007. 10. 17., 2008. 2. 29., …> 처럼 긴 목록도 통째로 */
/* 목 표시로 실제 쓰이는 글자 (가나다… / 거너더… / 고노도…) */
var MOK="가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호";
var RUNHEAD_RE=/^(?:법제처\s*\d+\s*국가법령정보센터|■[^\[]{0,60}(?=\[))\s*/;  /* 쪽마다 반복되는 머리글 */

/* 별표 안의 절 제목 — "5.2 제조관리", "4.3 제품관리기준서" 꼴.
 * 제목 길이는 14자에서 끊는다. 뒤에 이어지는 본문까지 굵어지지 않게. */
var SEC_RE=/^(\d{1,2}(?:\.\d{1,2}){1,2})\s+(?=[가-힣])/;
function secHeadLen(text,at){
  var m=SEC_RE.exec(text.slice(at,at+14));
  if(!m) return 0;
  var pos=at+m[0].length, len=m[0].length, title=0;
  while(pos<text.length&&title<14){
    var sp=text.indexOf(" ",pos);
    var tok=(sp<0?text.slice(pos):text.slice(pos,sp));
    if(!tok||!/^[가-힣()ㆍ·]/.test(tok)) break;   /* "품질 ( 보증 ) 부서" 처럼 괄호가 낀 제목 */
    /* 다음이 목·호 표시면 제목 끝 */
    if(tok.length===1&&MOK.indexOf(tok)>=0) break;
    if(title+tok.length>14) break;
    title+=tok.length+1; len+=tok.length+(sp<0?0:1);
    pos=(sp<0?text.length:sp+1);
  }
  return len;
}

/* 끊을 자리 찾기 — 날짜(<개정 2022. 12. 29.>)를 호로 오인하지 않도록
 * < > 나 [ ] 안쪽은 아예 건너뛴다 */
function lawBreaks(text){
  var skip=[], m;
  META_RE.lastIndex=0;
  while((m=META_RE.exec(text))!==null) skip.push([m.index,m.index+m[0].length]);
  function inSkip(i){ for(var k=0;k<skip.length;k++){ if(i>=skip[k][0]&&i<skip[k][1]) return true; } return false; }

  var pts=[];
  findArticles(text).forEach(function(a){ if(!inSkip(a.at)) pts.push({at:a.at,lv:0,len:a.end-a.at}); });

  /* 절 제목 (5.2 제조관리). 화면에만 쓰고 조문 판별에는 넣지 않는다 —
   * 넣으면 "별표 3" 같은 상위 맥락이 절 제목으로 덮여버린다. */
  for(var si=0;si<text.length;si++){
    if(inSkip(si)) continue;
    if(si>0&&!/\s/.test(text.charAt(si-1))) continue;
    if(!/\d/.test(text.charAt(si))) continue;
    /* "별표 1 제 7.1 호다목" 처럼 조문 참조 안의 숫자는 제목이 아니다 */
    var before=text.slice(Math.max(0,si-3),si).replace(/\s+/g,"");
    if(before.slice(-1)==="제") continue;
    var sl=secHeadLen(text,si);
    if(sl>0) pts.push({at:si,lv:0,len:sl});
  }

  for(var i=0;i<text.length;i++){
    if(inSkip(i)) continue;
    var ch=text.charAt(i);
    if(HANG.indexOf(ch)>=0){ pts.push({at:i,lv:1,len:0}); continue; }
    /* 호(1. 2.) · 목(가. 나.) — 앞이 공백이고 뒤가 공백인 것만.
     * PDF에서 뽑으면 "사 ." 처럼 점 앞에 공백이 끼기도 해서 허용한다.
     * 목 글자는 실제 쓰이는 것만 열거한다 — [가-하] 범위로 잡으면
     * 한글 거의 전부가 들어가서 "…한다 ." 같은 문장 끝까지 걸린다. */
    if(i>0&&/\s/.test(text.charAt(i-1))){
      var mm=/^(\d{1,2}|[\uAC00-\uD7A3])\s*\.\s/.exec(text.slice(i,i+6));
      if(mm){
        if(/^\d+$/.test(mm[1])) pts.push({at:i,lv:2,len:0});
        else if(MOK.indexOf(mm[1])>=0) pts.push({at:i,lv:3,len:0});
      } else {
        /* 목 아래 세부는 "1)" "가)" 꼴을 쓴다 */
        var m2=/^(\d{1,2}|[\uAC00-\uD7A3])\s*\)\s/.exec(text.slice(i,i+6));
        if(m2&&(/^\d+$/.test(m2[1])||MOK.indexOf(m2[1])>=0)) pts.push({at:i,lv:4,len:0});
      }
    }
  }
  pts.sort(function(a,b){ return a.at-b.at||a.lv-b.lv; });
  /* 같은 자리 중복 제거 */
  var out=[];
  pts.forEach(function(p){ if(!out.length||out[out.length-1].at!==p.at) out.push(p); });

  /* 목(가·나·다…)은 차례대로 나온다.
   * PDF에서 "말한다 ."가 "말한 다 ."로 뽑히는 일이 있는데, 그러면 그 "다 ."가
   * 목 번호와 똑같이 생겨서 문장 한복판에서 줄이 끊긴다.
   * 차례를 어기는 목은 그런 가짜다 — 걸러낸다. */
  var expect=-1, keep=[];
  function afterEnd(at){          /* 앞의 빈칸을 건너뛴 실제 글자가 문장 끝인가 */
    for(var k=at-1;k>=0;k--){
      var c=text.charAt(k);
      if(/\s/.test(c)) continue;
      return ".)]>」』\u201D\"·;:".indexOf(c)>=0;
    }
    return true;                  /* 글 맨 앞 */
  }
  out.forEach(function(p){
    if(p.lv<3){ expect=-1; keep.push(p); return; }
    if(p.lv>3){ keep.push(p); return; }
    var idx=MOK.indexOf(text.charAt(p.at));
    if(idx<0) return;
    /* 차례가 맞거나(가→나→다), 새 목록의 시작(가)이거나,
     * 앞이 문장 끝(…한다 .)이면 진짜 목이다.
     * "말한 다 ." 처럼 낱말 한복판에서 튀어나온 것만 걸린다. */
    if(expect<0||idx===expect||idx===0||afterEnd(p.at)){ expect=idx+1; keep.push(p); }
  });
  return keep;
}

/* 한 토막을 HTML로 — 검색어 형광펜, <개정…> 같은 부가 표시는 흐리게 */
function lawSegHtml(seg,q,artLen){   /* q: 낱말 하나 또는 배열 */
  var ranges=[];
  if(artLen>0) ranges.push({s:0,e:artLen,cls:"lp-art"});
  var m;
  META_RE.lastIndex=0;
  while((m=META_RE.exec(seg))!==null) ranges.push({s:m.index,e:m.index+m[0].length,cls:"lp-meta"});
  var rh=RUNHEAD_RE.exec(seg);
  if(rh) ranges.push({s:0,e:rh[0].length,cls:"lp-meta"});
  (Array.isArray(q)?q:(q?[q]:[])).forEach(function(t){
    if(!t||t.length<2) return;
    var lt=seg.toLowerCase(), lq=t.toLowerCase(), from=0;
    while(true){
      var at=lt.indexOf(lq,from); if(at<0) break;
      ranges.push({s:at,e:at+t.length,cls:"mark"});
      from=at+t.length;
    }
  });
  ranges.sort(function(a,b){ return a.s-b.s||(b.e-b.s)-(a.e-a.s); });
  var out="", pos=0;
  ranges.forEach(function(r){
    if(r.s<pos) return;                       /* 겹치면 앞의 것만 */
    out+=esc(seg.slice(pos,r.s));
    out+=(r.cls==="mark"?"<mark>":'<span class="'+r.cls+'">')
       + esc(seg.slice(r.s,r.e))
       + (r.cls==="mark"?"</mark>":"</span>");
    pos=r.e;
  });
  return out+esc(seg.slice(pos));
}

var LP_CLASS=["lp0","lp1","lp2","lp3","lp4"];
/* startLv: 앞 쪽에서 이어진 단계. 쪽이 바뀌었다고 항 중간이 새 조처럼 보이면 안 된다.
 * 반환 lv는 다음 쪽에 물려줄 단계. */
function formatLawSeg(text,q,startLv){
  startLv=startLv||0;
  var pts=lawBreaks(text);
  if(!pts.length) return {html:'<div class="lp '+LP_CLASS[startLv]+'">'+lawSegHtml(text,q,0)+'</div>',lv:startLv};
  var html="", prev=0, prevLv=startLv, prevArt=0;
  function push(to){
    var seg=text.slice(prev,to);
    if(seg.trim()) html+='<div class="lp '+LP_CLASS[prevLv]+'">'+lawSegHtml(seg,q,prevArt)+'</div>';
  }
  if(pts[0].at>0){ prev=0; prevLv=startLv; prevArt=0; push(pts[0].at); }
  pts.forEach(function(p,i){
    prev=p.at; prevLv=p.lv; prevArt=p.len;
    push(i+1<pts.length?pts[i+1].at:text.length);
  });
  return {html:html,lv:pts[pts.length-1].lv};
}
function formatLawText(text,q){ return formatLawSeg(text,q,0).html; }



/* 조 전체 보기 열기 — law_articles 한 줄이 곧 조 하나라 계산이 필요 없다 */
function openLawArticle(artId,lawId){
  if(!artId){ openLawView(lawId,1); return; }
  var seq=++lawViewSeq;
  lawView={mode:"art",lawId:lawId,artId:artId,art:"",text:"",
           page:0,pageEnd:0,loading:true,err:"",hitIdx:-1};
  renderLawModal();
  withAuthRetry(function(){
    return sb.from("law_articles").select("id,law_id,label,page,page_end,content").eq("id",artId);
  }).then(function(res){
    if(lawViewSeq!==seq) return;
    if(res.error) throw new Error("조문을 읽지 못했어요: "+res.error.message);
    var d=(res.data||[])[0];
    if(!d) throw new Error("조문을 찾지 못했어요. 「조문 다시 만들기」를 눌러보세요.");
    lawView.loading=false; lawView.lawId=d.law_id; lawView.art=d.label;
    lawView.text=d.content||""; lawView.page=d.page; lawView.pageEnd=d.page_end||d.page;
    renderLawModal(); lawJump(0);
  }).catch(function(err){
    if(lawViewSeq!==seq) return;
    lawView.loading=false; lawView.err=(err&&err.message)||"조문을 읽지 못했어요.";
    renderLawModal();
  });
}

/* 두 모드 오가기 */
function lawArtToPage(){ if(lawView&&lawView.mode==="art") openLawView(lawView.lawId,lawView.page||1); }
/* 쪽 보기 → 조 보기. 그 쪽을 품고 있는 조문 줄을 DB에서 찾아 연다. */
function lawPageToArt(){
  if(!lawView||lawView.mode==="art") return;
  var lid=lawView.lawId, pg=lawView.page;
  withAuthRetry(function(){
    return sb.from("law_articles").select("id").eq("law_id",lid)
      .lte("page",pg).order("page",{ascending:false}).limit(1);
  }).then(function(res){
    var d=(res.data||[])[0];
    if(res.error||!d){ showToast("이 쪽의 조문을 찾지 못했어요. 「조문 다시 만들기」를 눌러보세요."); return; }
    openLawArticle(d.id,lid);
  });
}

/* 조 본문 HTML — 조문 한 줄을 통째로 그린다 */
function lawArtBodyHtml(){
  return formatLawSeg(lawView.text||"",lawTermList,0).html;
}

/* 검색어 사이 이동. DOM의 <mark>가 곧 목록이라 따로 인덱스를 만들 필요가 없다. */
function lawJump(d){
  var b=document.getElementById("lv-body"); if(!b||!lawView) return;
  var ms=b.querySelectorAll("mark"); if(!ms.length) return;
  var i=(d===0)?0:(lawView.hitIdx||0)+d;
  if(i<0) i=ms.length-1;
  if(i>=ms.length) i=0;
  lawView.hitIdx=i;
  for(var k=0;k<ms.length;k++) ms[k].className=(k===i?"on":"");
  /* scrollIntoView는 iOS에서 고정 패널까지 밀어버린다 — 패널 안에서만 움직인다 */
  b.scrollTop+=ms[i].getBoundingClientRect().top-b.getBoundingClientRect().top-b.clientHeight*0.3;
  var c=document.getElementById("lv-hit-n");
  if(c) c.textContent=(i+1)+" / "+ms.length;
}

/* 표인 쪽 판별.
 * 줄글은 "~하여야 한다." 처럼 문장이 계속 끝나지만,
 * 표는 칸 값만 늘어서서 문장 끝이 거의 없다.
 * 실제 문서로 재본 값: 줄글 1,000자당 5~12개, 표 0~1개. */
function looksLikeTable(t){
  if(!t||t.length<300) return false;
  var ends=(t.match(/다\s*\./g)||[]).length;
  return ends*1000/t.length<2;
}

function renderLawModal(){
  var el=document.getElementById("law-modal"); if(!el) return;
  if(!lawView){ el.innerHTML=""; document.body.style.overflow=""; return; }
  document.body.style.overflow="hidden";

  var l=S.laws.find(function(x){ return x.id===lawView.lawId; });
  var art=(lawView.mode==="art");
  var sig=(lawView.mode||"page")+"|"+lawView.lawId+"|"+(art?("a"+lawView.artId):lawView.page);
  var oldBody=document.getElementById("lv-body");
  var keepTop=(oldBody&&el.getAttribute("data-sig")===sig)?oldBody.scrollTop:null;

  var body, artBar="", foot;
  if(lawView.loading) body='<p class="empty">불러오는 중...</p>';
  else if(lawView.err) body='<p class="empty">'+esc(lawView.err)+'</p>';
  else if(art) body=lawArtBodyHtml();
  else if(!lawView.content) body='<p class="empty">이 쪽에는 글자가 없어요.<br />표나 그림만 있는 쪽일 수 있어요 — 아래 PDF 원문에서 확인해 주세요.</p>';
  else body='<div class="lv-text">'+formatLawText(lawView.content,lawTermList)+'</div>';
  if(art&&!lawView.loading&&!lawView.err) body='<div class="lv-text">'+body+'</div>';

  if(art){
    var span=(lawView.page===lawView.pageEnd)?(lawView.page+"쪽")
            :(lawView.page+"~"+lawView.pageEnd+"쪽");
    artBar='<div class="lv-arts">'+esc(lawView.art||"")+(lawView.page?'  ·  '+span:"")+'</div>';
    if(!lawView.loading&&!lawView.err&&looksLikeTable(lawView.text))
      artBar+='<div class="lv-hint">이 조문은 <b>표(칸)</b>가 섞여 있어요. 글자만 뽑으면 칸 경계가 사라져 한 줄로 이어져 보입니다. 아래 「PDF 원문 열기」로 확인해 주세요.</div>';
    foot='<div class="lv-foot">'
      + '<button class="btn quiet sm" data-act="lv-hit-prev" title="이전 검색어">‹</button>'
      + '<span class="lv-hit-n" id="lv-hit-n">–</span>'
      + '<button class="btn quiet sm" data-act="lv-hit-next" title="다음 검색어">›</button>'
      + '<button class="link-btn" data-act="lv-page">이 쪽만 보기</button>'
      + '<button class="link-btn lv-pdf" data-act="lv-pdf">PDF 원문 열기 ↗</button>'
      + '</div>';
  } else {
    var arts=(!lawView.loading&&lawView.content)?findArticles(lawView.content):[];
    var head0=arts.length?arts[0].label:"", tail0=arts.length?arts[arts.length-1].label:"";
    if(lawView.article){ head0=lawView.article+" (이어짐)"; if(!tail0) tail0=head0; }
    if(head0) artBar='<div class="lv-arts">'+esc(head0)+(tail0!==head0?'  ~  '+esc(tail0):'')+'</div>';
    if(!lawView.loading&&looksLikeTable(lawView.content))
      artBar+='<div class="lv-hint">이 쪽은 <b>표(칸)</b>로 되어 있어요. 글자만 뽑으면 칸 경계가 사라져 내용이 한 줄로 이어져 보입니다. '
        + '어느 칸의 값인지 확인하려면 아래 「PDF 원문 열기」를 눌러주세요.</div>';
    var max=(l&&l.pages)||1;
    foot='<div class="lv-foot">'
      + '<button class="btn quiet sm" data-act="lv-prev"'+(lawView.page<=1?" disabled":"")+'>‹ 이전 쪽</button>'
      + '<button class="btn quiet sm" data-act="lv-next"'+(lawView.page>=max?" disabled":"")+'>다음 쪽 ›</button>'
      + (arts.length||lawView.article?'<button class="link-btn" data-act="lv-art">이 조 전체 보기</button>':'')
      + '<button class="link-btn lv-pdf" data-act="lv-pdf">PDF 원문 열기 ↗</button>'
      + '</div>';
  }

  var pageLbl=art?((lawView.page===lawView.pageEnd)?(lawView.page+"쪽"):(lawView.page+"~"+lawView.pageEnd+"쪽"))
                 :(lawView.page+" / "+((l&&l.pages)||1)+"쪽");
  el.setAttribute("data-sig",sig);
  el.innerHTML='<div class="lv-back" data-act="lv-close"></div>'
    + '<div class="lv-panel" role="dialog">'
    +   '<div class="lv-head">'
    +     '<div class="lv-title">'+esc(l?l.name:"법령")+'</div>'
    +     '<div class="lv-page">'+esc(pageLbl)+'</div>'
    +     '<button class="lv-x" data-act="lv-close" title="닫기">✕</button>'
    +   '</div>'
    +   artBar
    +   '<div class="lv-body" id="lv-body">'+body+'</div>'
    +   foot
    + '</div>';
  var nb=document.getElementById("lv-body");
  if(nb){ if(keepTop!==null) nb.scrollTop=keepTop; else if(!art) nb.scrollTop=0; }
}

function lawDel(id){
  var l=S.laws.find(function(x){ return x.id===id; });
  if(!l) return;
  if(!confirm('"'+l.name+'"\n\n법령과 추출된 텍스트가 모두 지워집니다. 계속할까요?')) return;
  if(l.filePath) sb.storage.from("files").remove([l.filePath]);
  S.laws=S.laws.filter(function(x){ return x.id!==id; });
  lawHits=null; lawSel={};
  render();
  dbDelete("laws",id);   /* law_pages는 cascade로 함께 지워진다 */
}

/* ---------- 내보내기 ---------- */
function lawPicked(){
  return (lawHits||[]).filter(function(g){ return lawSel[g.key]; });
}
function lawExportText(){
  var picked=lawPicked(); if(!picked.length) return null;
  var n=0; picked.forEach(function(g){ n+=g.snips.length; });
  var lines=['법령 검색 결과 — '+lawTermList.join(" + "),
             new Date().toLocaleString("ko-KR")+" · "+picked.length+"곳 / "+n+"건",""];
  var cur=null;
  picked.forEach(function(g){
    var nm=lawName(g.lawId);
    if(nm!==cur){ cur=nm; lines.push("■ "+nm); }
    lines.push("  ["+(g.art||"")+" · "+(g.page===g.pageEnd?g.page+"쪽":g.page+"~"+g.pageEnd+"쪽")+"]");
    g.snips.forEach(function(h){
      lines.push("   - "+(h.where?"("+h.where+") ":"")+h.text);
    });
    lines.push("");
  });
  return lines.join("\n");
}

function lawCopy(){
  var t=lawExportText();
  if(!t){ showToast("먼저 결과를 골라주세요."); return; }
  var done=function(){ showToast("✓ "+lawPicked().length+"건 복사했어요"); };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(done,function(){ lawCopyFallback(t,done); });
  } else lawCopyFallback(t,done);
}
function lawCopyFallback(t,done){
  var ta=document.createElement("textarea");
  ta.value=t; ta.style.position="fixed"; ta.style.opacity="0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); done(); }
  catch(e){ showToast("복사하지 못했어요.",true); }
  document.body.removeChild(ta);
}
function lawDownload(){
  var t=lawExportText();
  if(!t){ showToast("먼저 결과를 골라주세요."); return; }
  var blob=new Blob([t],{type:"text/plain;charset=utf-8"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="법령검색_"+lawTermList.join("_").replace(/[^가-힣a-zA-Z0-9_]/g,"")+"_"+keyOf(new Date())+".txt";
  a.click();
}
function lawSelAll(on){
  (lawHits||[]).forEach(function(g){ lawSel[g.key]=on; });
  if(!on) lawSel={};
  renderLawResults();
}

/* ---------- 사용법 ----------
 * 화면만 보고는 알 수 없는 것들이 있다: 띄어쓰기가 AND라는 것,
 * 같은 조가 두 번 나오는 게 「시행 예정 조문」이라는 것,
 * 표로 된 쪽은 칸 경계가 사라진다는 것. 여기 적어 둔다. */
function lawHelpHtml(){
  if(!lawHelpOpen)
    return '<button class="law-help-open" data-act="law-help">? &nbsp;검색하는 법 · 화면 보는 법</button>';
  return '<div class="law-help">'
    + '<div class="law-help-head"><b>법령 검색 사용법</b>'
    +   '<button class="law-help-x" data-act="law-help" title="접기">접기 ✕</button></div>'

    + '<div class="law-help-sec"><div class="law-help-t">① 찾는 법</div>'
    +   '<ul>'
    +     '<li><b>낱말을 띄어 쓰면 「모두 들어 있는 곳」</b>만 나와요.<br />'
    +       '<code>냉장 운송</code> → 두 낱말이 <u>같은 조 안에</u> 다 있는 곳만.<br />'
    +       '결과가 너무 많으면 낱말을 하나 더 넣어 좁히세요.</li>'
    +     '<li><b>붙은 말 그대로</b> 찾으려면 따옴표로 묶어요. <code>"안전상비의약품"</code></li>'
    +     '<li>두 글자 이상이어야 찾아요. 최대 다섯 낱말.</li>'
    +     '<li>법에 쓰인 말로 넣어야 나와요. <u>「타이레놀」로는 안 나옵니다</u> — '
    +       '법에는 「안전상비의약품」이라고 적혀 있으니까요. '
    +       '<span class="law-help-soon">(이 부분은 다음 단계에서 AI가 대신 찾아 줄 예정)</span></li>'
    +   '</ul></div>'

    + '<div class="law-help-sec"><div class="law-help-t">② 결과 읽는 법</div>'
    +   '<ul>'
    +     '<li><b>카드 하나 = 조 하나</b>예요. 한 조 안에서 검색어가 열 번 나와도 카드는 하나입니다.</li>'
    +     '<li>조각 앞의 <span class="law-help-chip">2호 나목</span> 같은 표시는 '
    +       '<b>그 조 안에서 몇 항·몇 호·몇 목인지</b>예요.</li>'
    +     '<li><b>「제N조 전체 보기」</b> — 그 조 전체를 읽어요. 조 하나가 통째로 나옵니다.</li>'
    +     '<li><b>「이 쪽만」</b> — 조가 아니라 <b>그 쪽</b>을 봐요. 앞뒤 쪽으로 넘길 수 있어요.</li>'
    +     '<li><b>「PDF ↗」</b> — 원본 PDF를 그 쪽으로 열어요. <b>표를 볼 때 꼭 쓰세요.</b></li>'
    +     '<li>왼쪽 <b>체크박스</b>로 고른 뒤 <b>복사</b>·<b>텍스트로 저장</b>하면 모아서 가져갑니다.</li>'
    +   '</ul></div>'

    + '<div class="law-help-sec"><div class="law-help-t">③ 알아두면 헷갈리지 않는 것</div>'
    +   '<ul>'
    +     '<li><b>같은 조가 두 번 나올 때가 있어요.</b> 법제처 PDF는 '
    +       '<u>아직 시행 전인 개정 조문</u>을 현행 조문 바로 뒤에 한 번 더 싣습니다. '
    +       '끝에 <code>[시행일: 2027. 1. 1.]</code> 같은 표시가 있는 쪽이 <b>앞으로 바뀔 내용</b>이에요. '
    +       '중복이 아니라 둘 다 필요한 정보입니다.</li>'
    +     '<li><b>표로 된 쪽은 한 줄로 이어져 보여요.</b> 행정처분 기준·별표가 그렇습니다. '
    +       'PDF에서 글자만 뽑으면 칸 경계가 사라지거든요. '
    +       '<b>어느 칸의 값인지는 「PDF ↗」로 확인하세요.</b></li>'
    +     '<li><b>별표·별지도 조처럼 찾아져요.</b> '
    +       '<span class="law-help-chip">별표 8(행정처분의 기준)</span> 처럼 나옵니다.</li>'
    +     '<li>새 PDF를 올리면 <b>조문으로 쪼개는 작업</b>이 자동으로 돌아요. '
    +       '법령 목록에서 <b>「조문 다시 만들기」</b>를 누르면 다시 쪼갭니다 — '
    +       'PDF를 다시 올릴 필요는 없어요.</li>'
    +     '<li><b>공개 법령·지침서만</b> 올려주세요. 민원인 정보나 내부 검토 문서는 올리지 않습니다.</li>'
    +   '</ul></div>'
    + '</div>';
}


/* ---------- 민원 자료 화면 ---------- */
function refDate(r){
  var d=r.updatedAt||r.createdAt; if(!d) return "";
  var x=new Date(d); if(isNaN(x)) return "";
  return (x.getMonth()+1)+"월 "+x.getDate()+"일";
}

function renderRefs(){
  var items=S.refs, totalParts=0, totalChars=0;
  items.forEach(function(r){ totalParts+=(r.parts||0); totalChars+=(r.chars||0); });
  var pills=[pill("자료 "+items.length+"건")];
  if(totalParts) pills.push(pill("절 "+totalParts+"개"));

  var list="";
  if(items.length){
    list='<button class="law-toggle" data-act="ref-list">'
      + (refListOpen?"▾":"▸")+' 올려둔 자료 '+items.length+'개'
      + '<span class="law-toggle-hint">'+(refListOpen?"접기":"갱신 · 이름 수정 · 삭제")+'</span></button>';
    if(refListOpen) list+='<div class="law-list">'+items.map(function(r){
      var meta=[(r.chars?Math.round(r.chars/1000)+"천 자":""),(r.parts?"절 "+r.parts+"개":""),refDate(r)?refDate(r)+" 갱신":""].filter(Boolean).join(" · ");
      return '<div class="law-row">'
        + '<span class="doc-ic file">▤</span>'
        + '<span class="law-name" data-act="edit" data-table="refs" data-field="name" data-id="'+r.id+'" title="눌러서 이름 수정">'+esc(r.name)+'</span>'
        + '<span class="law-pages">'+esc(meta)+'</span>'
        + '<button class="link-btn" data-act="ref-update" data-id="'+r.id+'" title="새 파일로 통째로 갈아끼웁니다">다시 올려 갱신</button>'
        + (r.filePath?'<button class="doc-act" data-act="ref-open" data-id="'+r.id+'">열기 ↗</button>':'')
        + '<button class="del doc-del" data-act="ref-del" data-id="'+r.id+'" title="삭제">✕</button></div>';
    }).join("")+'</div>';
  }

  view().innerHTML='<div class="page">'
    + pageHead2("민원 자료","마스터 문서를 올려두고 그 안을 낱말로 찾아요. 고칠 때마다 다시 올리면 갱신돼요.",items.length?pills:null)
    + '<div class="search-box"><span class="search-ic">⌕</span>'
    +   '<input class="input search law-input" id="ref-q" placeholder="낱말을 띄어 쓰면 모두 포함 (예: 보완요청 문안)" value="'+esc(refQuery)+'" />'
    +   '<button class="btn sm law-go" data-act="ref-search">검색</button>'
    + '</div>'
    + '<div class="chip-row">'
    +   '<button class="chip '+(refNeedOnly?"":"on")+'" data-act="ref-need" data-id="off">전체</button>'
    +   '<button class="chip '+(refNeedOnly?"on":"")+'" data-act="ref-need" data-id="on">[확인 필요]만</button>'
    + '</div>'
    + '<button class="upload-bar'+(refBusy?" busy":"")+'" data-act="ref-upload"'+(refBusy?" disabled":"")+'>'
    +   '<span class="upload-ic">⬆</span><div class="import-bar-text">'
    +   '<div class="import-bar-title">'+(refBusy?"처리 중이에요...":"자료 올리기")+'</div>'
    +   '<div class="import-bar-sub">'+(refBusy?"창을 닫지 마세요":"워드(.docx) · PDF · 업체명·개인정보는 지우고 올려주세요")+'</div></div>'
    +   '<span class="import-bar-go">→</span></button>'
    + list
    + '<div id="ref-results"></div></div>';

  renderRefResults();
  var q=document.getElementById("ref-q");
  if(q) q.addEventListener("keydown",function(e){ if(e.key==="Enter") refSearch(); });
}

function renderRefResults(){
  var el=document.getElementById("ref-results"); if(!el) return;
  if(refSearching){ el.innerHTML='<p class="empty">찾는 중...</p>'; return; }
  if(refHits===null){
    el.innerHTML=S.refs.length
      ? '<div class="empty-box"><div class="empty-ic">⌕</div><p>찾을 단어를 넣고 Enter를 눌러요.<br />낱말을 띄어 쓰면 <b>모두 들어 있는 절</b>만 찾아요.<br /><br />문서 안에 <b>[확인 필요: ○○]</b>로 적어 두신 곳은 위의 칩으로 모아 볼 수 있어요.</p></div>'
      : '<div class="empty-box"><div class="empty-ic">▤</div><p>마스터 문서를 올리면 여기서 찾을 수 있어요.<br />업체명·제조번호 같은 특정 정보는 지우고 올려주세요.</p></div>';
    return;
  }
  if(!refHits.length){
    el.innerHTML='<p class="empty">'+(refTerms.length?'「'+esc(refTerms.join(" + "))+'」를 찾지 못했어요.':'해당하는 절이 없어요.')+'</p>';
    return;
  }
  var total=0; refHits.forEach(function(g){ total+=g.total; });
  var head='<div class="law-head"><div class="law-count"><b>'+refHits.length+'</b>곳'
    + (total?' · '+total+'건':'')
    + (refTerms.length>1?' <span class="law-and">'+esc(refTerms.join(" + "))+' 모두 포함</span>':'')+'</div></div>';

  var cur=null, body="";
  refHits.forEach(function(g){
    var nm=refName(g.refId);
    if(nm!==cur){ cur=nm; body+='<div class="law-group">'+esc(nm)+'</div>'; }
    var open=!!refOpen[g.key], list=open?g.snips:g.snips.slice(0,2);
    body+='<div class="law-hit"><div class="law-hit-body">'
      + '<div class="law-meta">'
      +   '<span class="law-art lv'+(g.level||0)+'">'+esc(g.label)+'</span>'
      +   (g.need?'<span class="entry-flag">확인 필요</span>':'')
      +   (g.total>1?'<span class="law-n">'+g.total+'건</span>':'')
      + '</div>'
      + list.map(function(t){ return '<div class="law-snip">'+markTerms(t,refTerms)+'</div>'; }).join("")
      + (g.snips.length>2
          ? '<button class="link-btn law-more-btn" data-act="ref-expand" data-key="'+esc(g.key)+'">'
            + (open?"접기":"이 절에서 "+(g.snips.length-2)+"곳 더 보기")+'</button>'
          : "")
      + '</div></div>';
  });
  el.innerHTML=head+body;
}

/* ---------- 화면 ---------- */
function renderLaws(){
  var items=S.laws;
  var totalPages=0; items.forEach(function(l){ totalPages+=(l.pages||0); });
  var pills=[pill("법령 "+items.length+"건")];
  if(totalPages) pills.push(pill("총 "+totalPages+"쪽"));

  var list="";
  if(items.length){
    var need=items.filter(function(l){ return !l.arts; }).length;
    if(need) list+='<div class="notice"><span class="notice-ic">!</span>'
      + '<div>조문으로 안 쪼개진 법령이 <b>'+need+'개</b> 있어요. 이걸 해야 검색이 조 단위로 나와요.</div>'
      + '<button class="btn sm" data-act="law-build-all"'+(lawBusy?" disabled":"")+'>'+(lawBusy?"만드는 중...":"전부 만들기")+'</button></div>';
    list+='<button class="law-toggle" data-act="law-list">'
      + (lawListOpen?"▾":"▸")+' 올려둔 법령 '+items.length+'개'
      + '<span class="law-toggle-hint">'+(lawListOpen?"접기":"조문 만들기 · 이름 수정 · 삭제")+'</span></button>';
    if(lawListOpen) list+='<div class="law-list">'+items.map(function(l){
      return '<div class="law-row">'
        + '<span class="doc-ic file">▤</span>'
        + '<span class="law-name" data-act="edit" data-table="laws" data-field="name" data-id="'+l.id+'" title="눌러서 이름 수정">'+esc(l.name)+'</span>'
        + '<span class="law-pages">'+(l.pages||0)+'쪽'+(l.arts?' · 조문 '+l.arts+'개':'')+'</span>'
        + '<button class="link-btn'+(l.arts?'':' law-need')+'" data-act="law-reindex" data-id="'+l.id+'" title="쪽 텍스트로 조문을 다시 쪼갭니다">'+(l.arts?'조문 다시 만들기':'조문 만들기')+'</button>'
        + '<button class="doc-act" data-act="law-pdf" data-id="'+l.id+'" data-page="1">PDF ↗</button>'
        + '<button class="del doc-del" data-act="law-del" data-id="'+l.id+'" title="삭제">✕</button></div>';
    }).join("")+'</div>';
  }

  view().innerHTML='<div class="page">'
    + pageHead2("법령","올려둔 법령 전체에서 단어를 찾고, 결과를 골라 모아요.",items.length?pills:null)
    + '<div class="search-box"><span class="search-ic">⌕</span>'
    +   '<input class="input search law-input" id="law-q" placeholder="낱말을 띄어 쓰면 모두 포함 (예: 냉장 운송)" value="'+esc(lawQuery)+'" />'
    +   '<button class="btn sm law-go" data-act="law-search">검색</button>'
    + '</div>'
    + lawHelpHtml()
    + '<button class="upload-bar'+(lawBusy?" busy":"")+'" data-act="law-upload"'+(lawBusy?" disabled":"")+'>'
    +   '<span class="upload-ic">⬆</span><div class="import-bar-text">'
    +   '<div class="import-bar-title">'+(lawBusy?"처리 중이에요...":"법령 PDF 올리기")+'</div>'
    +   '<div class="import-bar-sub">'+(lawBusy?"창을 닫지 마세요":"글자가 들어 있는 PDF만 (스캔본은 아직 안 돼요)")+'</div></div>'
    +   '<span class="import-bar-go">→</span></button>'
    + list
    + '<div id="law-results"></div><div id="law-modal"></div></div>';

  renderLawResults();
  renderLawModal();
  var q=document.getElementById("law-q");
  if(q) q.addEventListener("keydown",function(e){ if(e.key==="Enter") lawSearch(); });
}

function renderLawResults(){
  var el=document.getElementById("law-results"); if(!el) return;

  if(lawSearching){ el.innerHTML='<p class="empty">찾는 중...</p>'; return; }
  if(lawHits===null){
    el.innerHTML=S.laws.length
      ? '<div class="empty-box"><div class="empty-ic">⌕</div><p>찾을 단어를 넣고 Enter를 눌러요.<br />낱말을 띄어 쓰면 <b>모두 들어 있는 곳</b>만 찾아요. 붙은 말 그대로 찾으려면 "따옴표"로 묶어요.<br /><br />처음이시면 위의 <b>「검색하는 법 · 화면 보는 법」</b>을 펼쳐 보세요.</p></div>'
      : '<div class="empty-box"><div class="empty-ic">▤</div><p>법령 PDF를 올리면 여기서 검색할 수 있어요.<br />공개 법령·지침서만 올려주세요.</p></div>';
    return;
  }
  if(!lawHits.length){
    el.innerHTML='<p class="empty">「'+esc(lawTermList.join(" + "))+'」를 찾지 못했어요.<br />'
      +(lawTermList.length>1?'낱말을 줄이거나 ':'')+'띄어쓰기를 바꿔 보세요.</p>';
    return;
  }

  var total=0; lawHits.forEach(function(g){ total+=g.snips.length; });
  var picked=lawPicked().length;
  var head='<div class="law-head">'
    + '<div class="law-count"><b>'+lawHits.length+'</b>곳 · '+total+'건'
    +   (lawTermList.length>1?' <span class="law-and">'+esc(lawTermList.join(" + "))+' 모두 포함</span>':'')
    +   (picked?' · <span class="law-picked">'+picked+'곳 선택</span>':'')+'</div>'
    + '<div class="law-actions">'
    +   '<button class="link-btn" data-act="law-all">모두 선택</button>'
    +   '<button class="link-btn" data-act="law-none">해제</button>'
    +   '<button class="btn quiet sm" data-act="law-copy">복사</button>'
    +   '<button class="btn sm" data-act="law-save">텍스트로 저장</button>'
    + '</div></div>';

  var SHOW=3, cur=null, body="";
  lawHits.forEach(function(g){
    var nm=lawName(g.lawId);
    if(nm!==cur){ cur=nm; body+='<div class="law-group">'+esc(nm)+'</div>'; }
    var open=!!lawOpen[g.key], list=open?g.snips:g.snips.slice(0,SHOW);
    body+='<div class="law-hit'+(lawSel[g.key]?" on":"")+'">'
      + '<label class="law-pick"><input type="checkbox" class="law-check" data-act="law-pick" data-key="'+esc(g.key)+'"'+(lawSel[g.key]?" checked":"")+' /></label>'
      + '<div class="law-hit-body">'
      +   '<div class="law-meta">'
      +     '<span class="law-art">'+esc(g.art)+'</span>'
      +     '<span class="law-page">'+(g.page===g.pageEnd?g.page+'쪽':g.page+'~'+g.pageEnd+'쪽')+'</span>'
      +     (g.total>1?'<span class="law-n">'+g.total+'건</span>':'')
      +     '<span class="law-acts">'
      +       '<button class="link-btn law-go-art" data-act="law-art" data-art-id="'+g.artId+'" data-id="'+g.lawId+'">'+esc(artShort(g.art))+' 전체 보기</button>'
      +       '<button class="link-btn" data-act="law-view" data-id="'+g.lawId+'" data-page="'+g.page+'">이 쪽만</button>'
      +       '<button class="link-btn quiet-link" data-act="law-pdf" data-id="'+g.lawId+'" data-page="'+g.page+'">PDF ↗</button>'
      +     '</span>'
      +   '</div>'
      +   list.map(function(h){
            return '<div class="law-snip">'
              + (h.where?'<span class="law-where">'+esc(h.where)+'</span>':'')
              + lawSegHtml(h.text,lawTermList,0)+'</div>';
          }).join("")
      +   (g.snips.length>SHOW
            ? '<button class="link-btn law-more-btn" data-act="law-expand" data-key="'+esc(g.key)+'">'
              +(open?"접기":"이 조에서 "+(g.snips.length-SHOW)+"건 더 보기")+'</button>'
            : "")
      + '</div></div>';
  });

  el.innerHTML=head+'<div class="law-hits">'+body+'</div>'
    + '<p class="law-note">같은 조에서 나온 것은 한 카드로 묶었어요. 원문은 새 창에서 열리며, 기기에 따라 해당 쪽으로 바로 넘어가지 않을 수 있어요.</p>';
}

/* 쪽 보기 창은 Esc로 닫는다 */
document.addEventListener("keydown",function(e){
  if(!lawView) return;
  if(e.key==="Escape"){ e.preventDefault(); closeLawView(); return; }
  if(lawView.mode==="art"){
    if(e.key==="ArrowRight"){ e.preventDefault(); lawJump(1); }
    else if(e.key==="ArrowLeft"){ e.preventDefault(); lawJump(-1); }
  }
});

/* ========== 이벤트 위임 ========== */
document.getElementById("app").addEventListener("click",function(e){
  var el=e.target.closest("[data-act]"); if(!el) return;
  var act=el.getAttribute("data-act"), id=el.getAttribute("data-id");
  switch(act){
    case "tab": active=id; closeForms(); render(); break;
    case "s-add": addSchedule(id,el.getAttribute("data-input")); break;
    case "edit":
      if(Date.now()-dragEndedAt<350) break;   /* 드래그 직후 따라오는 click은 무시 */
      startEdit(el,el.getAttribute("data-table"),id,el.getAttribute("data-field"),el.getAttribute("data-type"));
      break;
    /* 캘린더에서 식약처 업무 완료 토글 */
    case "mfds-done": {
      var mt=S.mfds.find(function(x){return x.id===id;});
      if(mt){ mt.status=(mt.status==="완료")?"진행중":"완료"; render(); dbUpdate("mfds",id,{status:mt.status}); }
      break; }
    /* 캘린더에서 지우면 업무 자체가 사라지므로 반드시 확인받는다 */
    case "mfds-del": {
      var md=S.mfds.find(function(x){return x.id===id;});
      if(md&&confirm('"'+md.title+'"\n\n식약처 업무에서도 함께 삭제됩니다. 계속할까요?')) del("mfds",id);
      break; }
    case "s-toggle": { var it=S.schedule.find(function(x){return x.id===id;}); if(it){it.done=!it.done;render();dbUpdate("schedule",id,{done:it.done});} break; }
    case "s-star": { var i2=S.schedule.find(function(x){return x.id===id;}); if(i2){i2.star=!i2.star;render();dbUpdate("schedule",id,{star:i2.star});} break; }
    case "s-del": del("schedule",id); break;
    /* 달을 넘기면 아래 날짜 패널도 그 달로 옮긴다.
     * 안 옮기면 달력엔 없는 날짜의 일정을 보고 있게 된다. */
    case "cal-prev": calMonth--; if(calMonth<0){calMonth=11;calYear--;} calSyncSel(); render(); break;
    case "cal-next": calMonth++; if(calMonth>11){calMonth=0;calYear++;} calSyncSel(); render(); break;
    case "cal-day": calSel=id; render(); focusDayPanel(); break;
    case "map": openMap(el.getAttribute("data-q")); break;
    case "day-add": dayAdd(); break;
    case "ev-del": evDel(id); break;
    case "a-add": addArticle(); break;
    case "a-del": del("articles",id); break;
    case "f-open": formOpen[id]=true; render(); break;
    case "f-close": formOpen[id]=false; render(); break;
    case "m-add": addMfds(); break;
    case "m-del": del("mfds",id); break;
    case "law-upload": lawUploadClick(); break;
    case "law-search": lawSearch(); break;
    case "law-list": lawListOpen=!lawListOpen; render(); break;
    case "law-view": openLawView(id,parseInt(el.getAttribute("data-page"),10)||1); break;
    case "law-reindex": lawReindex(id); break;
    case "law-pdf": openLawPdf(id,parseInt(el.getAttribute("data-page"),10)||1); break;
    case "lv-close": closeLawView(); break;
    case "law-art": openLawArticle(parseInt(el.getAttribute("data-art-id"),10)||0,id); break;
    case "law-build-all": lawBuildAll(); break;
    case "law-help": lawHelpToggle(); break;
    case "ref-search": refSearch(); break;
    case "ref-list": refListOpen=!refListOpen; render(); break;
    case "ref-upload": refUploadClick(null); break;
    case "ref-update": refUploadClick(id); break;
    case "ref-open": { var rr=S.refs.find(function(x){return x.id===id;}); if(rr&&rr.filePath) openStorageFile(rr.filePath); break; }
    case "ref-del": refDel(id); break;
    case "ref-need": refNeedOnly=(id==="on"); if(refQuery||refNeedOnly) refSearch(); else render(); break;
    case "ref-expand": { var rk=el.getAttribute("data-key"); refOpen[rk]=!refOpen[rk]; renderRefResults(); break; }
    case "board-more": { var bt=el.getAttribute("data-table"); boardOpen[bt]=!boardOpen[bt]; render(); break; }
    case "board-clear": { var ct=el.getAttribute("data-table"); boardSearch[ct]=""; render(); break; }
    case "lv-art": lawPageToArt(); break;
    case "lv-page": lawArtToPage(); break;
    case "lv-hit-prev": lawJump(-1); break;
    case "lv-hit-next": lawJump(1); break;
    case "lv-prev": lawViewStep(-1); break;
    case "lv-next": lawViewStep(1); break;
    case "lv-pdf": if(lawView) openLawPdf(lawView.lawId,lawView.page); break;
    case "law-del": lawDel(id); break;
    case "law-pick": { var lk=el.getAttribute("data-key");
      if(lawSel[lk]) delete lawSel[lk]; else lawSel[lk]=true;
      renderLawResults(); break; }
    case "law-expand": { var ek=el.getAttribute("data-key");
      if(lawOpen[ek]) delete lawOpen[ek]; else lawOpen[ek]=true;
      renderLawResults(); break; }
    case "law-all": lawSelAll(true); break;
    case "law-none": lawSelAll(false); break;
    case "law-copy": lawCopy(); break;
    case "law-save": lawDownload(); break;
    case "export": exportData(); break;
    case "import": importData(); break;
    case "logout": doLogout(); break;
  }
});

/* ========== 렌더 + 초기화 ========== */
function render(){
  renderTabs();
  if(active==="today") renderToday();
  else if(active==="calendar") renderCalendar();
  else if(active==="articles") renderArticles();
  else if(active==="mfds") renderMfds();
  else if(active==="archive") renderRefs();
  else if(active==="laws") renderLaws();
}

/* 앱 시작 (로그인 후 호출) */
function startApp(){
  appStarted=true;
  showApp();
  document.getElementById("loading").style.display="flex";
  document.getElementById("loading").className="loading-overlay";
  document.getElementById("loading").querySelector(".loading-text").textContent="데이터를 불러오는 중...";
  loadAll().then(function(){
    return Promise.resolve();
  }).then(function(){
    render();
    hideLoading();
  }).catch(function(err){
    hideLoading();
    showToast("데이터 로딩 실패: "+(err.message||""),true);
    render(); /* 빈 상태라도 보여줌 */
  });
}

/* 세션 확인 → 자동 로그인 or 로그인 화면
 * ensureSession()이 만료 임박 토큰을 미리 갱신하므로, startApp()의 첫 쿼리가
 * 만료된 JWT로 나가서 전부 401로 죽는 상황(= 앱은 열리는데 데이터가 빈 화면)을 막는다. */
ensureSession().then(function(session){
  if(session){
    startApp();
  } else {
    hideLoading();
    showLogin();
  }
}).catch(function(){
  hideLoading();
  showLogin();
});
