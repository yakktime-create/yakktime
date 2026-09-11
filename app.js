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
var TABLES=["schedule","events","articles","mfds","archive","docs","laws","refs","answers","settings","inspections","insp_items"];

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
    if(bad.length&&navigator.onLine) setTimeout(function(){ showToast("일부 데이터를 못 읽었어요: "+bad.join(", "),true); },600);
    results.forEach(function(r){ S[r.table]=r.data; });
    /* 통신이 없으면(현장) 실사 노트·일정은 기기에 적어 둔 것으로 채운다. 아직 못 올린 것도 얹는다. */
    if(bad.length) inspApplyCache(bad);
    var dd=inspDedupe(); if(dd) console.log("실사 노트 같은 줄 "+dd+"개 정리");
    if(!bad.length) inspCacheSave();
    if(navigator.onLine) setTimeout(inspFlush,800);
  });
}

/* 새 항목의 열쇠(uuid)는 브라우저가 미리 만든다. 서버가 만들어 주기를 기다리면 그 사이 화면에는 id 가 「undefined」인
 * 줄이 그려지고, 그 ✕ 를 누르면 「삭제 실패: invalid input syntax for type uuid: "undefined"」가 난다
 * (이랑님 2026-09-09 「x 누르면 한 번에 안 지워짐」). 표 여섯 개(schedule·events·articles·mfds·laws·answers)는 전부 uuid 다. */
function uuid(){
  try{ if(window.crypto&&crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
  var h="0123456789abcdef", out="", i;
  for(i=0;i<36;i++){ out+=(i===8||i===13||i===18||i===23)?"-":(i===14?"4":(i===19?h[(Math.random()*4|0)+8]:h[Math.random()*16|0])); }
  return out;
}
function dbInsert(table,item){
  if(!item.id) item.id=uuid();
  var remote=toRemote(table,item);
  return withAuthRetry(function(){ return sb.from(table).insert(remote).select(); }).then(function(res){
    if(res.error){ showToast("저장 실패: "+res.error.message,true); return null; }
    /* 서버가 생성한 uuid를 로컬 아이템에 반영 */
    if(res.data&&res.data[0]&&res.data[0].id){ item.id=res.data[0].id; }
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
var S={ schedule:[], events:[], articles:[], mfds:[], archive:[], docs:[], laws:[], refs:[], answers:[], settings:[], inspections:[], insp_items:[] };
/* 설정 표 — 기기(아이패드·맥)가 달라도 같아야 하는 작은 값. 「AI에게 알려둔 우리 과 규칙」·답변 형식.
 * localStorage 는 기기마다 달라서 맥에서 적은 규칙이 아이패드엔 없었다(2026-09-10). */
function setGet(k){ var r=(S.settings||[]).find(function(x){ return x.key===k; }); return r?String(r.value||""):""; }
function setPut(k,v){
  var r=(S.settings||[]).find(function(x){ return x.key===k; });
  if(r) r.value=v; else (S.settings=S.settings||[]).push({key:k,value:v});
  return dbUpsert("settings",{key:k,value:v});
}
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
  {id:"insp",label:"실태조사"},
  {group:"자료"},
  {id:"laws",label:"법령"},
  {id:"answers",label:"민원 답변"}
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
var APP_VER="v174";
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
function wireSeg(name,onChange){ var box=document.querySelector('[data-seg="'+name+'"]'); if(!box) return; box.addEventListener("click",function(e){ var b=e.target.closest(".seg-btn"); if(!b) return; box.querySelectorAll(".seg-btn").forEach(function(x){x.classList.remove("on");}); b.classList.add("on"); if(onChange) onChange(b.getAttribute("data-val")); }); }
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
  /* 고치는 칸은 원래 자리만큼만 커야 한다.
   * 예전엔 전부 flex:1 이라, 좁은 「시간」 칸을 눌러도 입력창이 줄 전체를 먹었다. */
  var sizeCls="";
  if(el.classList){
    if(el.classList.contains("ev-time")) sizeCls=" ie-time";
    else if(el.classList.contains("ev-place")) sizeCls=" ie-place";
    else if(el.classList.contains("mfds-status")) sizeCls=" ie-time";
  }
  /* 제 줄을 통째로 쓰던 글자(메모처럼)를 고칠 때는 입력창도 그 줄을 통째로 쓴다.
   * 안 그러면 flex 가 옆 칩 뒤에 끼워 넣어서, 누른 자리가 아닌 엉뚱한 데
   * 입력창이 나타난다. 클래스를 하나씩 맞추면 탭마다 빠뜨리게 되므로,
   * 바꾸기 직전에 원래 글자가 어떻게 놓여 있었는지를 읽어서 따라간다. */
  if(!sizeCls&&window.getComputedStyle){
    var cs=window.getComputedStyle(el);
    if(cs&&(cs.flexBasis==="100%"||cs.display==="block")) sizeCls=" ie-row";
  }
  inp.className="input inline-edit"+(area?" inline-area":"")+sizeCls;
  inp.value=cur;
  /* 장소 칸은 기존 항목을 고칠 때도 자동완성이 떠야 한다.
   * 목록을 띄우려면 자리를 잡아줄 감싸개가 필요해서 한 겹 두른다. */
  var isPlace=(field==="place"), acBox=null;
  if(isPlace){
    var wrap=document.createElement("span");
    wrap.className="ac-wrap inline-ac";
    el.replaceWith(wrap);
    inp.id="inline-place";
    wrap.appendChild(inp);
    acBox=document.createElement("div");
    acBox.className="ac-list"; acBox.id="inline-place-ac"; acBox.style.display="none";
    wrap.appendChild(acBox);
  } else {
    el.replaceWith(inp);
  }
  inp.focus();
  if(isPlace) wirePlaceAC("inline-place","inline-place-ac");
  if(!type) { try{ inp.setSelectionRange(cur.length,cur.length); }catch(e){} }
  var settled=false;
  /* 날짜는 비워서 저장할 수 있어야 한다 (기한을 없애면 캘린더에서도 빠짐) */
  var allowEmpty=(type==="date"||area);   /* 기한·메모는 비워서 지울 수 있어야 한다 */
  function commit(save){
    if(settled) return;
    settled=true; editingId=null;
    var nv=inp.value.trim();
    if(field==="time") nv=normTime(nv);
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

/* 화면을 함부로 움직이지 않는다.
 * 예전엔 날짜를 누를 때마다 아래 입력칸을 화면 한가운데로 끌어오고
 * 자동으로 커서까지 넣었다. 그러면 아이패드에선 자판까지 올라와
 * 날짜만 이리저리 눌러보는데 화면이 계속 튀었다.
 * 이제는 「아예 안 보일 때만, 보일 만큼만」 움직인다. */
function scrollIntoViewIfHidden(el){
  if(!el||!el.getBoundingClientRect||!el.scrollIntoView) return;
  var r=el.getBoundingClientRect(), vh=window.innerHeight||document.documentElement.clientHeight;
  if(r.bottom>60 && r.top<vh-60) return;   /* 조금이라도 보이면 그대로 둔다 */
  el.scrollIntoView({behavior:"smooth",block:"nearest"});
}
/* 기간을 고르라고 해놓고 달력이 화면 밖에 있으면 안 된다 */
function focusCal(){ scrollIntoViewIfHidden(document.querySelector(".cal-grid")); }
function focusDayPanel(){ scrollIntoViewIfHidden(document.querySelector(".day-panel")); }

/* 라벨에 붙은 「· 시행 2026. 10. 8.」을 읽어, 오늘 기준으로 아직 안 온 것인지 본다.
 * 법제처 PDF는 곧 시행될 개정 조문을 현행 조문 바로 뒤에 한 번 더 싣는다.
 * 지우면 안 된다 — 「10월 8일부터 이렇게 바뀝니다」를 안내해야 할 때가 있다.
 * 대신 어느 쪽이 지금 것이고 어느 쪽이 앞으로 올 것인지 눈에 보이게 한다. */
function lawSoonDate(label){
  var m=/·\s*시행\s*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/.exec(String(label||""));
  if(!m) return null;
  return m[1]+("0"+m[2]).slice(-2)+("0"+m[3]).slice(-2);
}
function lawIsFuture(label){
  var d=lawSoonDate(label);
  return !!d && d>keyOf(new Date()).replace(/-/g,"");
}

/* 9/11~9/20 (10일) */
function spanLabel(a,b){
  var d1=new Date(a+"T00:00:00"), d2=new Date(b+"T00:00:00");
  if(isNaN(d1)||isNaN(d2)) return a+"~"+b;
  var days=Math.round((d2-d1)/86400000)+1;
  return (d1.getMonth()+1)+"/"+d1.getDate()+"~"+(d2.getMonth()+1)+"/"+d2.getDate()+" ("+days+"일)";
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
  /* 날짜 없는 할 일은 「언젠가」다(이랑님 2026-09-09 「언젠가 할 일도 따로 만들어야겠다 맨 밑에」).
     2026-09-09 실측: 표에 due_date 가 비어 있는 줄은 0개라, 옛 항목이 「언젠가」로 옮겨 갈 일은 없다. */
  function dueOf(i){ return i.due||todayKey; }
  /* 오늘 = 오늘 이하(지난 미완료도 이월). 앞으로 = 오늘보다 뒤. 언젠가 = 날짜 없음 → 사라지는 항목 없음 */
  var todayItems=S.schedule.filter(function(i){ return i.due&&i.due<=todayKey; });
  var tmrItems  =S.schedule.filter(function(i){ return i.due&&i.due>todayKey; });
  var someItems =S.schedule.filter(function(i){ return !i.due; });
  var open=todayItems.filter(function(i){return !i.done;});
  var inProg=S.articles.filter(function(a){return a.status==="작성중";}).length;
  var mfdsOpen=S.mfds.filter(function(m){return m.status!=="완료";}).length;
  var todayEv=S.events.filter(function(e){return e.key===todayKey;}).sort(evSort);
  var upcoming=S.events.filter(function(e){return e.key>todayKey;}).sort(evSort).slice(0,4);
  var evHtml="";
  if(todayEv.length){ evHtml+='<div class="card"><div class="card-head"><h2>오늘 일정</h2></div>'+todayEv.map(function(e){ return '<div class="ev-row">'
      + '<span class="ev-time">'+esc(e.time||"종일")+'</span>'
      + '<div class="ev-body"><span class="ev-title">'+esc(e.title)+'</span>'
      +   (e.place? '<span class="ev-place">\ud83d\udccd '+esc(e.place)+'</span>'
                    +'<button class="link-btn map-btn" data-act="map" data-q="'+esc(e.place)+'">지도 \u2197</button>' : '')
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
  var someRows= schedRows(someItems,"날짜를 정하지 않은 할 일을 여기에 적어 두세요.");
  var tmrD=tomorrow();
  var tmrLabel=(tmrD.getMonth()+1)+"월 "+tmrD.getDate()+"일("+WD[tmrD.getDay()]+")";
  view().innerHTML='<div class="page">'
    + '<header class="today-hero"><div class="today-date">'+esc(dateStr)+'</div><h1 class="today-greet">'+greet+', 이랑님.</h1><p class="today-line">'+(open.length?("오늘 할 일 "+open.length+"건 남았어요."):"오늘 할 일이 없어요.")+(todayEv.length?" · 오늘 일정 "+todayEv.length+"건.":"")+'</p></header>'
    + '<section class="stat-row">'
    +   statTile("articles","brass",inProg,"작성 중 기고글")
    +   statTile("mfds","blue",mfdsOpen,"진행 중 식약처 업무")
    +   statTile("laws","slate",S.laws.length,"올려둔 법령")
    +   statTile("answers","accent",(S.answers||[]).length,"담아둔 민원 답변")
    + '</section>'+evHtml
    + '<section class="card"><div class="card-head"><h2>오늘 할 일</h2><span class="muted">별표는 위로 · 항목을 누르면 수정</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s" placeholder="할 일을 적고 Enter" /><button class="btn" data-act="s-add" data-id="'+todayKey+'" data-input="new-s">+ 추가</button></div>'+rows
    + '</section>'
    + '<section class="card"><div class="card-head"><h2>앞으로 할 일</h2><span class="muted">'+tmrLabel+' 부터</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s2" placeholder="앞으로 할 일을 적고 Enter (내일 날짜로 들어가요)" /><button class="btn" data-act="s-add" data-id="'+tmrKey+'" data-input="new-s2">+ 추가</button></div>'+tmrRows
    + '</section>'
    + '<section class="card"><div class="card-head"><h2>언젠가 할 일</h2><span class="muted">날짜 없이 · 항목을 누르면 수정</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s3" placeholder="언젠가 할 일을 적고 Enter" /><button class="btn" data-act="s-add" data-id="'+SOMEDAY+'" data-input="new-s3">+ 추가</button></div>'+someRows
    + '</section></div>';
  document.getElementById("new-s").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(todayKey,"new-s"); });
  document.getElementById("new-s2").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(tmrKey,"new-s2"); });
  document.getElementById("new-s3").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(SOMEDAY,"new-s3"); });
}

/* 캘린더 입력창에서 고른 종류. 출장일 때만 「마지막 날」과 메모 칸이 나타난다 —
 * 평소엔 안 보이므로 화면이 안 늘어난다. */
var KIND_TRIP="출장·여행";   /* 어디 여행 갈 때도 같은 칸을 쓴다 */
var dayKind="일정";
var TRIP_MEMO="가는 편  09:20 인천 → 07:30 도착\n오는 편  11:00 출발 → 16:40 인천";

/* 출장의 마지막 날. 아이패드 기본 날짜 선택기는 화면 아무 데나 뜨는데다
 * 달력이 바로 위에 있는데 또 달력을 띄우는 셈이라, 네이버 항공권처럼
 * 「달력에서 시작일 → 마지막 날」을 그냥 눌러서 고른다. */
var tripUntil=null;

/* 이미 등록된 일정의 기간을 고치는 중일 때 {id}.
 * 날을 누르면 「가까운 쪽 끝」이 그리로 옮겨간다 — 시작을 당기든 마지막을
 * 늘리든 한 번만 누르면 되고, 무엇을 먼저 고를지 정할 필요가 없다.
 * 예전엔 시작·마지막을 처음부터 다시 고르게 했는데, 시작을 한 번 더 누르면
 * 하루짜리가 되면서 기간이 통째로 사라진 것처럼 보였다. */
var tripEdit=null;


/* 입력창에 치던 글자. 마지막 날을 고르면 화면을 다시 그리므로,
 * 그 사이에 적어둔 제목·장소·메모가 날아가지 않게 잠깐 들고 있는다. */
var dayDraft={title:"",time:"",place:"",memo:null};
function saveDayDraft(){
  if(!document.getElementById("day-ev")) return;
  dayDraft.title=val("day-ev"); dayDraft.time=val("day-time"); dayDraft.place=val("day-place");
  if(document.getElementById("day-memo")) dayDraft.memo=val("day-memo");
}
function clearDayDraft(){ dayDraft={title:"",time:"",place:"",memo:null}; }
function mdLabel(k){ var d=new Date(k+"T00:00:00");
  return isNaN(d)?k:(d.getMonth()+1)+"월 "+d.getDate()+"일"; }
function tripDays(){ if(!tripUntil) return 0;
  return Math.round((new Date(tripUntil+"T00:00:00")-new Date(calSel+"T00:00:00"))/86400000)+1; }
/* 고른 기간을 한 줄로 보여준다. 누르면 마지막 날만 지우고 다시 고를 수 있다. */
function tripRangeHtml(){
  return '<div class="trip-range'+(tripUntil?" set":"")+'" data-act="trip-reset" title="눌러서 다시 고르기">'
    + '<span class="tr-a">'+esc(mdLabel(calSel))+'</span><span class="tr-ar">→</span>'
    + (tripUntil
        ? '<span class="tr-b">'+esc(mdLabel(tripUntil))+'</span><span class="tr-n">'+tripDays()+'일</span>'
        : '<span class="tr-b none">달력에서 마지막 날을 누르세요</span>')
    + '</div>';
}

var CAL_CHIPS=3;   /* 한 칸에 보여줄 일정 수. 아이패드 가로에선 3개까지 들어간다 */
function renderCalendar(){
  /* 기간을 고치는 중인 일정 (지워졌으면 그만둔다) */
  var te=tripEdit?S.events.find(function(x){ return x.id===tripEdit.id; }):null;
  if(tripEdit&&!te) tripEdit=null;
  var first=new Date(calYear,calMonth,1), startDay=first.getDay();
  var dim=new Date(calYear,calMonth+1,0).getDate(), todayKey=keyOf(new Date()), cells="";
  for(var i=0;i<startDay;i++) cells+='<div class="cal-cell blank"></div>';
  for(var d=1;d<=dim;d++){ var k=calYear+"-"+pad(calMonth+1)+"-"+pad(d);
    /* 기간 일정은 시작~끝 칸에 모두 나온다 */
    var evs=S.events.filter(function(e){ return e.key<=k && k<=(e.until||e.key); }).sort(evSort);
    /* 식약처 업무를 같은 칸에 함께 얹는다 (복사본이 아니라 mfds를 직접 읽음) */
    var tasks=S.mfds.filter(function(m){ return m.due===k; });
    /* 여러 날짜리는 시작·마지막 칸에만 이름을 달고, 사이의 날은 칸 색으로만 알린다
     * (네이버 항공권의 「가는 날 / 오는 날」과 같은 방식).
     * 예전엔 매 칸을 굵은 막대로 채웠는데, 가운데가 텅 빈 큰 덩어리로 보였다. */
    var tripChips=[], evChips=[];
    evs.forEach(function(e){
      var end=e.until||e.key;
      if(end===e.key){ evChips.push({label:(e.time?e.time+" ":"")+e.title}); return; }
      if(k===e.key)    tripChips.push({trip:"l",label:e.title});
      else if(k===end) tripChips.push({trip:"r",label:e.title});
    });
    /* 출장·여행이 맨 위 — 그 날의 큰 틀이라 먼저 눈에 들어와야 한다 */
    var chipItems=tripChips
      .concat(tasks.map(function(m){ return {task:true,done:m.status==="완료",label:m.title}; }))
      .concat(evChips);
    var chips=chipItems.slice(0,CAL_CHIPS).map(function(c){
      if(c.trip) return '<div class="cal-ev trip trip-'+c.trip+'">'
        + (c.trip==="r"?'<span class="tp">‹</span>':'')
        + '<span class="tt">'+esc(c.label)+'</span>'
        + (c.trip==="l"?'<span class="tp">›</span>':'')+'</div>';
      return '<div class="cal-ev'+(c.task?" mfds":"")+(c.done?" done":"")
        +'">'+esc(c.label)+'</div>'; }).join("");
    if(chipItems.length>CAL_CHIPS) chips+='<div class="cal-more">+'+(chipItems.length-CAL_CHIPS)+'</div>';
    /* 이미 등록된 여러 날짜리 일정 안에 든 날은 옅게 깔아 이어져 보이게 한다 */
    var inTrip=evs.some(function(e){ return (e.until||e.key)!==e.key; })?" trip":"";
    /* 기간을 고르는 중이면 시작~끝 칸에 색을 깔아 한눈에 보이게 한다.
     * 새로 넣을 때(출장)와 이미 있는 걸 고칠 때(기간 칩) 모두 같은 표시를 쓴다. */
    var rng="", rs=null, re=null;
    if(te){ rs=te.key; re=te.until||null; }              /* 고치는 중인 일정의 지금 기간 */
    else if(dayKind===KIND_TRIP&&tripUntil){ rs=calSel; re=tripUntil; }
    if(rs&&k>=rs&&k<=(re||rs))
      rng=" rng"+(k===rs?" rng-s":"")+(re&&k===re?" rng-e":"");
    cells+='<div class="cal-cell'+(k===todayKey?" today":"")+(k===calSel?" sel":"")+inTrip+rng+'" data-act="cal-day" data-id="'+k+'"><span class="cal-num">'+d+'</span>'+chips+'</div>'; }
  var wdHtml=WD.map(function(w,i){ return '<div class="cal-wd'+(i===0?" sun":"")+'">'+w+'</div>'; }).join("");
  var selEvs=S.events.filter(function(e){ return e.key<=calSel && calSel<=(e.until||e.key); }).sort(evSort);
  var selD=new Date(calSel+"T00:00:00");
  var selTasks=S.mfds.filter(function(m){ return m.due===calSel; });
  var taskRows=selTasks.map(function(t){
    var done=(t.status==="완료");
    return '<li class="ev-row task'+(done?" done":"")+'">'
      + '<input class="day-check" type="checkbox" data-act="mfds-done" data-id="'+t.id+'"'+(done?' checked':'')+' />'
      + '<span class="ev-time" data-act="edit" data-table="mfds" data-field="time" data-id="'+t.id+'" title="눌러서 시간 수정">'+(t.time?esc(t.time):'<span class="none">시간</span>')+'</span>'
      + '<div class="ev-body">'
      +   '<span class="ev-title" data-act="edit" data-table="mfds" data-field="title" data-id="'+t.id+'" title="눌러서 수정">'+esc(t.title)+'</span>'
      +   whereHtml(t,"mfds")
      +   '<span class="ev-tail"><span class="mfds-badge">식약처</span>'
      +     '<span class="mfds-status">'+esc(t.status)+'</span></span>'
      + '</div>'
      + '<span class="row-acts"><button class="del" data-act="mfds-del" data-id="'+t.id+'" title="삭제">✕</button></span></li>'; }).join("");
  function evRowHtml(e){ return '<li class="ev-row'+(isTrip(e)?" trip":"")+'">'
      + '<span class="check-gap"></span>'
      /* 여러 날짜리는 「종일」이 아니라 「출장」이라고 적는다. 하루짜리 일정과
       * 한 줄에 섞여 있어도 무엇인지 바로 보인다. 시간을 적어두면 시간이 이긴다
       * (몇 시 비행기처럼 출발 시각을 적어두는 경우). */
      + '<span class="ev-time'+(isTrip(e)&&!e.time?" trip-tag":"")+'" data-act="edit" data-table="events" data-field="time" data-id="'+e.id+'" title="눌러서 시간 수정">'
      +   (e.time?esc(e.time)
            : isTrip(e)?(/여행/.test(e.title||"")?"여행":"출장")   /* 제목에 여행이라 적었으면 여행 */
            : "종일")+'</span>'
      + '<div class="ev-body">'
      +   '<span class="ev-title" data-act="edit" data-table="events" data-field="title" data-id="'+e.id+'" title="눌러서 수정">'+esc(e.title)+'</span>'
      +   whereHtml(e,"events")
      +   (e.until&&e.until!==e.key
            ? '<span class="ev-span'+(tripEdit&&tripEdit.id===e.id?" on":"")+'" data-act="trip-edit" data-id="'+e.id+'" title="눌러서 달력에서 기간 고치기">'
              + esc(spanLabel(e.key,e.until))+'</span>' : '')
      /* 메모는 적어둔 게 있을 때만 보여준다. 빈 「＋ 메모」가 모든 일정마다
       * 한 줄씩 차지해서, 한 건이 두 줄로 보였다.
       * 출장·여행은 비행·숙소를 적는 자리라 비어 있어도 남겨 둔다. */
      +   ((e.memo||isTrip(e))
            ? '<span class="ev-memo" data-act="edit" data-table="events" data-field="memo" data-type="textarea" data-id="'+e.id+'" title="눌러서 수정">'
              + (e.memo?esc(e.memo):'<span class="none">＋ 메모</span>')+'</span>'
            : '')
      + '</div>'
      + '<span class="row-acts"><button class="del" data-act="ev-del" data-id="'+e.id+'" title="삭제">✕</button></span></li>'; }
  /* 출장·여행이 맨 위 — 그 날의 큰 틀이라 먼저 눈에 들어와야 한다 (달력 칸과 같은 순서) */
  function isTrip(e){ return !!(e.until&&e.until!==e.key); }
  var tripRows=selEvs.filter(isTrip).map(evRowHtml).join("");
  var dayRows =selEvs.filter(function(e){ return !isTrip(e); }).map(evRowHtml).join("");
  var panel='<div class="day-panel"><div class="day-title">'+(selD.getMonth()+1)+'월 '+selD.getDate()+'일 ('+WD[selD.getDay()]+')'+(calSel===todayKey?' <span class="day-today">오늘</span>':'')+'</div>'
    + '<div class="card form composer day-form">'
    +   '<input class="input composer-title" id="day-ev" value="'+esc(dayDraft.title)+'" placeholder="무엇을 하나요? (예: GMP 실사 사전회의)" />'
    +   '<div class="field-row">'
    +     (dayKind===KIND_TRIP
            ? '<label class="field wide"><span class="field-lbl">기간</span>'+tripRangeHtml()+'</label>'
            : '<label class="field"><span class="field-lbl">시간</span>'
              + '<input class="input" id="day-time" inputmode="numeric" value="'+esc(dayDraft.time)+'" placeholder="14:00" /></label>')
    +     '<label class="field grow ac-wrap"><span class="field-lbl">장소</span>'
    +       '<input class="input" id="day-place" autocomplete="off" value="'+esc(dayDraft.place)+'" placeholder="두 글자 이상 치면 장소를 찾아요" />'
    +       placeACBox("day-place-ac")+'</label>'
    +   '</div>'
    +   (dayKind===KIND_TRIP
        ? '<label class="field memo"><span class="field-lbl">메모 — 비행·숙소처럼 한눈에 볼 것</span>'
          + '<textarea class="input day-memo" id="day-memo" rows="2">'+esc(dayDraft.memo===null?TRIP_MEMO:dayDraft.memo)+'</textarea></label>'
        : '')
    +   '<div class="composer-foot">'
    +     segC("day-kind",["일정","식약처 업무","출장·여행"],dayKind)
    +     '<div class="composer-btns"><button class="btn" data-act="day-add">+ 추가</button></div>'
    +   '</div>'
    + '</div>'
    + ((selEvs.length||selTasks.length)
        ? '<ul class="list">'+tripRows+taskRows+dayRows+'</ul>'
        : '<p class="empty">이 날은 아직 일정이 없어요.</p>')+'</div>';
  var mk=calYear+"-"+pad(calMonth+1);
  var mEv=S.events.filter(function(e){ return e.key.indexOf(mk)===0; }).length;
  var mTask=S.mfds.filter(function(m){ return m.due&&m.due.indexOf(mk)===0; }).length;
  var calPills=[]; if(mEv) calPills.push(pill("이번 달 일정 "+mEv+"건")); if(mTask) calPills.push(pill("기한 있는 업무 "+mTask+"건"));
  view().innerHTML='<div class="page">'+pageHead2("캘린더","",calPills)
    + (te?'<div class="trip-bar"><span class="tb-t">「'+esc(te.title)+'」 기간 고치기</span>'
          + '<span class="tb-h">날짜를 누르면 가까운 쪽 끝이 그리로 옮겨가요</span>'
          + '<button class="link-btn" data-act="trip-edit-off">완료</button></div>':'')
    + '<div class="cal-nav"><button class="cal-arrow" data-act="cal-prev">‹</button><span class="cal-month">'+calYear+'년 '+(calMonth+1)+'월</span><button class="cal-arrow" data-act="cal-next">›</button></div>'
    + '<div class="cal-grid">'+wdHtml+cells+'</div>'+panel+'</div>';
  wireSeg("day-kind",function(v){ if(v===dayKind) return;
    saveDayDraft(); dayKind=v; if(v!==KIND_TRIP) tripUntil=null; render(); });
  wirePlaceAC("day-place","day-place-ac");
  /* Enter 는 다음 칸으로 넘어간다. 추가는 버튼으로만 —
   * 시간·장소를 적기도 전에 등록돼 버리는 일이 없다. */
  var flow=["day-ev","day-time","day-place"];
  flow.forEach(function(id,i){
    var el=document.getElementById(id); if(!el) return;
    el.addEventListener("keydown",function(e){
      if(e.key!=="Enter") return;
      e.preventDefault();
      var next=document.getElementById(flow[i+1]);
      if(next) next.focus(); else el.blur();
    });
  });
  /* 시간 칸을 벗어나면 바로 13 → 13:00 으로 보여준다 */
  var t=document.getElementById("day-time");
  if(t) t.addEventListener("blur",function(){ t.value=normTime(t.value); });
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
function closeForms(){ tripEdit=null; Object.keys(formOpen).forEach(function(k){ formOpen[k]=false; }); }
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
    +   '<div class="due-field wide ac-wrap"><label for="m-place">장소</label>'
    +     '<input class="input" id="m-place" autocomplete="off" placeholder="두 글자 이상 치면 장소를 찾아요" />'
    +     placeACBox("m-place-ac")+'</div>'
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

  if(formOpen.mfds){ wireSeg("m-status"); focusFirst("m-title"); wirePlaceAC("m-place","m-place-ac"); }
  wireBoardSearch("mfds");
  wireBoardDrag();
}

/* ZIP 안에서 항목 하나를 글자로 꺼낸다 (별표 hwpx 의 Contents/section0.xml).
 * 외부 라이브러리 없이 중앙 디렉터리를 직접 읽고 DecompressionStream 으로 푼다.
 * (원래 .docx 의 word/document.xml 을 꺼내던 함수다. 마스터 문서 기능을 걷어내며
 *  이름만 남기고 일반화했다 — 지우면 hwpx 를 못 연다.) */
function zipEntryText(arrayBuffer,want){
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
        if(fn===want){
          var lfn=dv.getUint16(locOff+26,true), lex=dv.getUint16(locOff+28,true);
          var start=locOff+30+lfn+lex, raw=bytes.slice(start,start+compSz);
          if(method===0){ resolve(new TextDecoder().decode(raw)); return; }
          if(method===8){
            try{ resolve(new TextDecoder().decode(inflateRawSync(raw))); }catch(ex){ reject(ex); }
            return;
          }
        }
        pos+=46+fnLen+exLen+cmLen;
      }
      reject(new Error(want+"을 찾지 못했어요"));
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

/* 문서 인덱스 탭은 2026-08-31에 없앴다.
 * 하던 일 ① 공개 PDF 올리기 → 법령 탭이 더 잘한다(전문 검색까지 된다)
 *        ② 파일 없이 위치만 적어 두기 → 쓴 적이 없어 버렸다
 * `docs` 표와 TABLES 항목은 그대로 둔다 — 데이터도 백업도 보존되고,
 * 되돌리고 싶어지면 화면만 다시 붙이면 된다. */

/* ========== 액션 (id 없이 insert → 서버가 uuid 생성) ========== */
var SOMEDAY="someday";   /* 「언젠가 할 일」의 날짜 표시 — 표에는 null 로 들어간다 */
function addSchedule(dueKey,inputId){
  var v=(val(inputId||"new-s")||"").trim(); if(!v) return;
  var item={text:v,done:false,star:false,due:dueKey===SOMEDAY?null:(dueKey||keyOf(new Date()))};
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
                archive:"자료",events:"일정",docs:"문서",answers:"답변"};
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

/* 「출장 11~20일」처럼 적으면 기간을 알아챈다. 버튼을 늘리지 않으려고
 * 이미 쓰는 제목 칸에서 읽어낸다.
 *   출장 11~20일   → 11일 시작 · 20일까지
 *   회의 ~15일     → 고른 날 시작 · 15일까지
 *   준비 20일까지  → 고른 날 시작 · 20일까지
 * 날짜만 떼어내고 제목은 남긴다. 못 알아보면 아무것도 안 건드린다. */
function parseRange(text,baseKey){
  var t=" "+String(text||"")+" ", m, from=null, to=null, cut=null;
  if((m=/\s(\d{1,2})\s*일?\s*[~\-–]\s*(\d{1,2})\s*일(?:까지)?(?=\s)/.exec(t))){
    from=+m[1]; to=+m[2]; cut=m[0];
  } else if((m=/\s[~\-–]\s*(\d{1,2})\s*일(?:까지)?(?=\s)/.exec(t))){
    to=+m[1]; cut=m[0];
  } else if((m=/\s(\d{1,2})\s*일\s*까지(?=\s)/.exec(t))){
    to=+m[1]; cut=m[0];
  }
  if(to===null) return null;
  var b=new Date(baseKey+"T00:00:00");
  if(isNaN(b)) return null;
  var y=b.getFullYear(), mo=b.getMonth();
  function mk(yy,mm,dd){
    var d=new Date(yy,mm,dd);
    if(d.getMonth()!==mm) return null;          /* 2월 31일 같은 건 없다 */
    return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
  }
  var startKey = (from!==null) ? mk(y,mo,from) : baseKey;
  if(!startKey) return null;
  var endKey = mk(y,mo,to);
  if(!endKey) return null;
  if(endKey<startKey){                           /* 달을 넘어가는 기간 */
    endKey=mk(y,mo+1,to);
    if(!endKey||endKey<startKey) return null;
  }
  var title=String(text).replace(cut.slice(1),"").replace(/\s+/g," ").trim();
  if(!title) return null;                        /* 날짜만 적었으면 제목이 없다 */
  return {title:title,key:startKey,until:endKey};
}

/* 시간 표기 정리 — 손으로 「13」 「7」 「930」만 쳐도 되게.
 *   13 → 13:00   7 → 07:00   930 → 09:30   1330 → 13:30
 *   9시 → 09:00  9시30 → 09:30  2시반 → 02:30  오후 2시반 → 14:30
 * 못 알아보는 글자는 그대로 둔다 — 지워버리면 적은 게 사라져 더 나쁘다. */
function fitTime(h,mi){
  if(isNaN(h)||isNaN(mi)||h>23||mi>59) return null;
  return pad(h)+":"+pad(mi);
}
function normTime(v){
  v=String(v==null?"":v).trim();
  if(!v) return "";
  var ap="", m;
  m=/^(오전|오후|am|pm)\s*/i.exec(v);
  if(m){ ap=m[1].toLowerCase(); v=v.slice(m[0].length).trim(); }
  else {
    m=/\s*(오전|오후|am|pm)$/i.exec(v);
    if(m){ ap=m[1].toLowerCase(); v=v.slice(0,m.index).trim(); }
  }
  var h=null, mi=0;
  if((m=/^(\d{1,2})\s*[:시]\s*(반|\d{1,2})?\s*분?$/.exec(v))){
    h=+m[1]; mi=(m[2]==="반")?30:(m[2]?+m[2]:0);
  }
  else if((m=/^(\d{1,2})$/.exec(v))){ h=+m[1]; }
  else if((m=/^(\d{3,4})$/.exec(v))){ h=+m[1].slice(0,m[1].length-2); mi=+m[1].slice(-2); }
  if(h===null) return String(v||"").trim();
  if(/오후|pm/.test(ap)&&h<12) h+=12;
  if(/오전|am/.test(ap)&&h===12) h=0;
  return fitTime(h,mi)||String(v).trim();
}

/* 그 달에 오늘이 있으면 오늘, 없으면 1일을 고른다 */
function calSyncSel(){
  if(dayKind===KIND_TRIP) return;   /* 기간 고르는 중엔 시작일을 그대로 둔다 (달 넘겨 마지막 날 고르기) */
  var n=new Date();
  var d=(n.getFullYear()===calYear&&n.getMonth()===calMonth)?n.getDate():1;
  calSel=calYear+"-"+pad(calMonth+1)+"-"+pad(d);
}

/* 전에 적어둔 장소를 모아 자동완성으로 쓴다.
 * 같은 곳(오송 본관, 건국대…)을 반복해 적게 되므로 이것만으로도 대부분 해결된다.
 * 새 장소는 그냥 쳐 넣으면 되고, 다음부터 목록에 들어온다. */
function placeList(){
  var seen={}, out=[];
  S.events.concat(S.mfds).forEach(function(x){
    var p=(x&&x.place||"").trim();
    if(!p||seen[p]) return;
    seen[p]=1; out.push(p);
  });
  return out.sort();
}
/* ---------- 장소 자동완성 ----------
 * 두 갈래를 한 목록에 합친다.
 *   1) 전에 적은 장소  — 즉시, 자주 가는 곳
 *   2) 카카오 장소 검색 — 처음 가는 곳
 * 카카오 열쇠는 Supabase 함수 안에만 있고 앱은 그 함수만 부른다.
 * 함수가 실패해도 1)은 계속 되므로 입력이 막히지 않는다. */
var placeAC={ box:null, input:null, items:[], timer:null, seq:0 };

function placeSearch(q){
  return withAuthRetry(function(){
    return sb.functions.invoke("place-search",{body:{q:q}});
  }).then(function(res){
    if(res.error) return [];
    return (res.data&&res.data.places)||[];
  }).catch(function(){ return []; });
}

function placeACHtml(){
  if(!placeAC.items.length) return "";
  return placeAC.items.map(function(it,i){
    return '<button class="ac-item" data-act="ac-pick" data-i="'+i+'">'
      + '<span class="ac-name">'+esc(it.name)+'</span>'
      + (it.addr?'<span class="ac-addr">'+esc(it.addr)+'</span>':'')
      + (it.old?'<span class="ac-tag">전에 적음</span>':'')
      + '</button>';
  }).join("");
}
function placeACRender(){
  if(!placeAC.box) return;
  placeAC.box.innerHTML=placeACHtml();
  placeAC.box.style.display=placeAC.items.length?"block":"none";
}
function placeACHide(){ placeAC.items=[]; placeACRender(); }

function wirePlaceAC(inputId,boxId){
  var input=document.getElementById(inputId), box=document.getElementById(boxId);
  if(!input||!box) return;
  placeAC.input=input; placeAC.box=box; placeAC.items=[];
  /* 목록을 누르는 순간 입력칸이 blur 되면, 고르기도 전에 저장되고 목록이 사라진다.
   * mousedown 을 막으면 포커스가 안 옮겨가서 고르기가 먼저 끝난다. */
  box.addEventListener("mousedown",function(e){ e.preventDefault(); });
  input.addEventListener("input",function(){
    var q=input.value.trim();
    clearTimeout(placeAC.timer);
    if(q.length<2){ placeACHide(); return; }
    /* 전에 적은 곳은 기다릴 것 없이 바로 보여준다 */
    var mine=placeList().filter(function(p){ return p.toLowerCase().indexOf(q.toLowerCase())>=0; })
      .slice(0,3).map(function(p){ return {name:p,addr:"",old:true}; });
    placeAC.items=mine; placeACRender();
    var seq=++placeAC.seq;
    placeAC.timer=setTimeout(function(){
      placeSearch(q).then(function(found){
        if(seq!==placeAC.seq||document.activeElement!==input) return;
        var have={}; mine.forEach(function(m){ have[m.name]=1; });
        placeAC.items=mine.concat(found.filter(function(f){ return !have[f.name]; }));
        placeACRender();
      });
    },350);
  });
  input.addEventListener("blur",function(){ setTimeout(placeACHide,180); });
}

function placeACBox(id){ return '<div class="ac-list" id="'+id+'" style="display:none"></div>'; }

function dayAdd(){
  var raw=(val("day-ev")||"").trim(); if(!raw) return;
  var time=normTime(val("day-time"));
  var place=(val("day-place")||"").trim();
  var r=parseNL(raw), title=raw;
  if(r.ok){ if(!time) time=r.time; title=r.title; }   /* 칸을 비웠으면 말로 적은 시간을 쓴다 */
  var rng=parseRange(title,calSel);                   /* 「출장 11~20일」 같은 기간 */
  if(rng) title=rng.title;
  var kind=segValue("day-kind")||dayKind;
  if(kind===KIND_TRIP){
    var until=tripUntil||calSel;
    if(until<calSel) until=calSel;
    var memo=(val("day-memo")||"").trim();
    var trip={key:rng?rng.key:calSel,time:null,title:title,place:place||null,
              until:rng?rng.until:until,memo:memo||null};
    S.events.push(trip);
    if(rng) calSel=rng.key;
    tripUntil=null; clearDayDraft(); dayKind="일정"; render(); dbInsert("events",trip); return;
  }
  if(kind==="식약처 업무"){
    /* 일정이 아니라 식약처 업무로 등록. 캘린더는 mfds를 직접 읽으므로 여기에도 그대로 뜬다. */
    var task={title:title,status:"대기",memo:"",due:calSel,time:time||null,place:place||null};
    clearDayDraft(); S.mfds.unshift(task); render(); dbInsert("mfds",task); return;
  }
  var item={key:rng?rng.key:calSel,time:time||null,title:title,
            place:place||null,until:rng?rng.until:null};
  S.events.push(item);
  clearDayDraft();
  if(rng) calSel=rng.key;                             /* 시작일로 옮겨 바로 보이게 */
  render(); dbInsert("events",item);
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
 * 추측 없이 정확해진다. law_pages는 "쪽 그대로 보기"와 PDF 쪽 이동에 쓴다. */

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

/* ---------- PDF에서 「구조」까지 읽어내기 ----------
 * 글자만 뽑으면 제목도 본문도 한 줄로 이어져, 뒤에서 정규식으로 짐작해야 한다.
 * PDF에는 글꼴·크기·좌표·선이 들어 있으니 그걸 읽으면 짐작이 사라진다.
 * 실측(문서 10개): 지침서 09는 제목만 정확히 갈렸고, 한글에서 만든 07은
 * 글꼴이 85가지로 쪼개져 본문까지 제목으로 잡혔다.
 * 그래서 **믿을 수 있는 문서에만** 쓴다 — 나머지는 예전처럼 이어 붙인다. */

/* 글자 조각을 줄로 묶는다. 줄마다 대표 글꼴(이름+높이)을 함께 남긴다. */
function pdfLines(tc,H){
  var it=[];
  (tc.items||[]).forEach(function(x){
    if(!x.str||!x.str.trim()) return;
    it.push({s:x.str,y:H-x.transform[5],x:x.transform[4],w:x.width||0,h:x.height||0,
             f:x.fontName+"|"+Math.round(x.height||0)});
  });
  it.sort(function(a,b){ return (a.y-b.y)||(a.x-b.x); });
  var lines=[], cur=null;
  it.forEach(function(z){
    if(cur&&Math.abs(z.y-cur.y)<=3.2) cur.items.push(z);
    else { cur={y:z.y,items:[z]}; lines.push(cur); }
  });
  lines.forEach(function(l){
    l.items.sort(function(a,b){ return a.x-b.x; });
    /* **조각을 무조건 공백으로 잇고 있었다.** 자간을 벌려 조판한 문서는 글자
     * 하나가 조각 하나로 나오는데, 그러면 「제 품 명」 「효 능ㆍ효 과」가 되어
     * 「제품명」으로 검색해도 하나도 안 걸린다(외품허신 34쪽 전부가 그랬다).
     * PDF에는 조각의 x와 너비가 들어 있으니 **사이가 벌어졌을 때만** 공백을 넣는다.
     * 실측: 낱말 사이 6.0 · 글자 사이 0.0 (12pt 기준). 문턱은 글자 높이의 0.22배.
     * 줄이 접히면 x가 크게 뒤로 가는데(음수), 그건 새 낱말이니 공백을 넣는다. */
    /* **줄마다 잣대를 새로 잰다.** 자간을 벌려 조판한 줄은 낱말 사이도 좁아서
     * 한 잣대로 재면 「상기 사항 중」이 「상기사항중」이 된다. 그 줄에서 실제로
     * 나타난 **작은 간격들의 가운뎃값**을 글자 사이로 보고, 그보다 확실히 넓을
     * 때만 낱말 사이로 친다. 보통 줄은 글자 사이가 0이라 예전과 같이 동작한다. */
    var hh0=l.items[0].h||10;
    /* 이 줄이 「글자마다 쪼개진 줄」인가 — 조각의 절반 넘게 한 글자면 그렇다.
     * 그런 줄만 잣대를 다시 잰다. 보통 줄은 조각이 낱말째라 예전 그대로 둔다
     * (여기서 잣대를 바꿨더니 「상기 사항 중」이 「상기사항중」이 됐다). */
    /* **한글 한 글자짜리 조각만 센다.** 문장부호(☞ ‘ ’ .)까지 세면 「☞ 상기 사항 중
     * 어느 하나라도」처럼 조각이 낱말째인 줄도 「글자마다 쪼개진 줄」로 잘못 본다. */
    var one=0, han=0;
    l.items.forEach(function(z){
      var t=String(z.s).trim();
      if(!/[가-힣]/.test(t)) return;
      han++; if(t.length===1) one++;
    });
    var cut=Math.max(1.2,hh0*0.22);
    if(han>=6&&one>=han*0.7){
      var gaps=[];
      for(var gi=1;gi<l.items.length;gi++){
        var g=l.items[gi].x-(l.items[gi-1].x+l.items[gi-1].w);
        if(g>=0&&g<hh0*0.8) gaps.push(g);
      }
      gaps.sort(function(x,y){ return x-y; });
      /* 이 줄 안에서 **글자 사이(좁은 쪽)와 낱말 사이(넓은 쪽)의 중간**을 자른다.
       * 아래 4분의 1 지점을 글자 사이로, 가운뎃값을 낱말 사이로 보고 그 사이를 문턱으로.
       * 낱말이 없어 온통 글자 사이뿐인 줄(「지 침 서 ㆍ 안 내 서」)은 둘이 같아
       * 문턱이 그 값이 되고, 간격이 그보다 크지 않으니 전부 붙는다. */
      var q=gaps.length?gaps[Math.floor(gaps.length*0.25)]:0;
      var md=gaps.length?gaps[Math.floor(gaps.length*0.5)]:0;
      cut=Math.max(cut,q+(md-q)*0.5);
    }
    var buf="";
    l.items.forEach(function(z,i){
      if(i){
        var pv=l.items[i-1], gap=z.x-(pv.x+pv.w), hh=pv.h||z.h||10;
        /* **양쪽이 다 여러 글자면 그 사이는 낱말 사이다** — 붙일 이유가 없다.
         * 표의 한 줄에 「지 침 서」 칸과 보통 글 칸이 함께 있으면 줄 전체가
         * 「글자마다 쪼개진 줄」로 잡혀 멀쩡한 낱말까지 붙어 버렸다. */
        var both=String(pv.s).trim().length>1&&String(z.s).trim().length>1;
        if(gap>(both?Math.max(1.2,hh*0.22):cut)||gap<-hh) buf+=" ";
      }
      buf+=z.s;
    });
    l.text=buf.replace(/\s+/g," ").trim();
    var c={}, best=null;
    l.items.forEach(function(z){ c[z.f]=(c[z.f]||0)+z.s.length; if(!best||c[z.f]>c[best]) best=z.f; });
    l.font=best||"";
  });
  return lines;
}

/* 본문 글꼴 무리 — 글자 수로 위에서부터 쌓아 8할을 넘길 때까지.
 * 무리가 셋을 넘으면 글꼴을 못 믿는다(한글에서 만든 문서는 85가지로 쪼개진다). */
function pickBody(tally){
  var ks=Object.keys(tally).sort(function(a,b){ return tally[b]-tally[a]; });
  var all=0; ks.forEach(function(k){ all+=tally[k]; });
  if(!all) return null;
  var acc=0, set={}, n=0;
  for(var i=0;i<ks.length;i++){ set[ks[i]]=1; n++; acc+=tally[ks[i]]; if(acc/all>=0.8) break; }
  return n<=3?set:null;
}

/* 글꼴 이름을 못 믿는 문서에서도 **글자 크기**는 믿을 수 있다.
 * 한글(hwp)에서 만든 지침서는 글꼴이 68~85가지로 쪼개지지만, 큰 제목은
 * 언제나 본문보다 크고 **아주 드물다**. 문서 전체 글자의 2%도 안 쓰면서
 * 줄이 짧은 크기 — 그것이 제목 크기다.
 * 실측(문서 10개): 07 사전GMP평가 h18 = 「1 목적」「3 평가 개요」 등 32줄뿐,
 * 08 적합판정 h16 = 「1 목적」…「6 행정사항」 17줄, 10 전문수탁 h16 = 22줄.
 * 본문(h15·h12)은 14~39%를 차지하므로 걸리지 않는다. */
function headHeights(hc,hn){
  var hs=Object.keys(hc).map(Number), all=0, dom=0;
  hs.forEach(function(h){ all+=hc[h]; if(!dom||hc[h]>hc[dom]) dom=h; });
  if(!all) return null;
  var set={}, n=0;
  hs.forEach(function(h){
    if(h<=dom) return;                 /* 본문보다 커야 제목이다 */
    if(hc[h]/all>=0.02) return;        /* 흔하면 본문이다 */
    if(hc[h]/hn[h]>24) return;         /* 줄이 길면 제목이 아니다 */
    set[h]=1; n++;
  });
  return n?set:null;
}

/* 본문 무리에 없는 글꼴로 쓰인 줄은 제목이다. 앞뒤로 줄을 바꿔 둔다 —
 * 화면과 복사가 그 줄바꿈을 그대로 절 경계로 읽는다. */
function linesToText(lines,bodySet,bodyH,headSet){
  if(!bodySet&&!headSet) return lines.map(function(l){ return l.text; }).join(" ").replace(/\s+/g," ").trim();
  var out=[];
  lines.forEach(function(l){
    if(!l.text) return;
    /* 글꼴 무리를 못 믿는 문서는 **크기만** 본다 — 제목 크기인 줄만 떼어 낸다. */
    /* **줄 첫 글자가 심볼 글꼴이면 제목이다.** 「⑧ 기타」의 번호가 심볼이라
     * `·` 로 바뀌면서 앞 문장 꼬리에 붙어 「… 배정하여 처리 · 기타」가 됐다.
     * 크기로만 재면 이런 중간 제목을 놓친다 — 줄이 어디서 시작하는지를 함께 본다.
     * 실측(문서 10개): 07 45줄(그중 40줄이 새로 잡힘) · 09 4줄(이미 잡혀 있음) ·
     * 06·08·10·01 0줄. 글 속의 심볼(「▣의 실태조사팀」)은 줄 첫머리가 아니라 안 걸린다. */
    var isHead=bodySet?!bodySet[l.font]
      :(!!headSet[+(String(l.font).split("|")[1]||0)]||/^[\uE000-\uF8FF]/.test(l.text));
    if(!isHead){ out.push(l.text); return; }
    /* 제목 중에서도 **본문보다 큰 것**이 큰 제목이다(큰 제목 h14 · 소제목 h12).
     * 원문의 「③ 유전자변형생물체의 보관」처럼 번호가 심볼 글꼴이면 글자로는
     * 소제목과 구분이 안 된다.
     * **빈 줄로 표시하면 안 된다** — 앞 제목의 끝 줄바꿈과 합쳐져 다음 제목이
     * 큰 제목으로 뒤바뀐다. 개행으로는 앞뒤를 가릴 수 없다.
     * 대신 **큰 제목은 심볼 글머리표를 떼어** 둔다. 원문에서도 큰 제목엔 번호가
     * 붙고 소제목(○)엔 안 붙으니, 「글머리표 없는 제목 = 큰 제목」이 된다. */
    var h=+(String(l.font).split("|")[1]||0), txt=l.text;
    if(bodyH&&h>bodyH) txt=txt.replace(/^[\uE000-\uF8FF\s]+/,"").replace(/^m\s+(?=[가-힣])/,"");
    out.push("\n"+txt+"\n");
  });
  return out.join(" ").replace(/[ \t]+/g," ").replace(/[ \t]*\n[ \t]*/g,"\n")
            .replace(/\n{2,}/g,"\n").trim();
}

/* 표는 선으로 그린다. 가로줄·세로줄이 여럿이면 그 쪽에 표가 있다.
 * 밑줄만 있는 쪽은 세로줄이 없어 걸리지 않는다. */
function pdfHasGrid(pdfjsLib,ops,H){
  var O=pdfjsLib.OPS, m=[1,0,0,1,0,0], st=[], hy=[], vx=[];
  function ap(x,y){ return [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]]; }
  /* 같은 선을 여러 번 그린 것을 따로 세면 밑줄 몇 개짜리 쪽도 표가 된다.
   * 서로 다른 자리의 줄만 센다 — 세로줄이 셋이면 적어도 두 칸짜리 표다. */
  function add(x1,y1,x2,y2){
    var dx=Math.abs(x2-x1), dy=Math.abs(y2-y1);
    /* 표의 칸 구분선은 여러 줄을 가로지르므로 길다. 짧은 장식선·밑줄은 뺀다.
     * 문서 10개로 재보니 이 길이에서 표 없는 규칙(시설기준령)은 0쪽, 지침서
     * 본문 쪽도 안 걸리고, 별표 8·점검표 같은 진짜 표만 남는다. */
    if(dy<1.5&&dx>=120){ if(hy.length<400) hy.push((y1+y2)/2); }
    else if(dx<1.5&&dy>=60){ if(vx.length<400) vx.push((x1+x2)/2); }
  }
  function spread(v){
    var a=v.slice().sort(function(x,y){ return x-y; }), n=0, last=-1e9;
    for(var i=0;i<a.length;i++){ if(a[i]-last>3){ n++; last=a[i]; } }
    return n;
  }
  for(var i=0;i<ops.fnArray.length;i++){
    var fn=ops.fnArray[i], a=ops.argsArray[i];
    if(fn===O.save) st.push(m.slice());
    else if(fn===O.restore) m=st.pop()||m;
    else if(fn===O.transform){
      var n=a;
      m=[n[0]*m[0]+n[1]*m[2], n[0]*m[1]+n[1]*m[3],
         n[2]*m[0]+n[3]*m[2], n[2]*m[1]+n[3]*m[3],
         n[4]*m[0]+n[5]*m[2]+m[4], n[4]*m[1]+n[5]*m[3]+m[5]];
    }
    else if(fn===O.constructPath){
      var oa=a[0], co=a[1], k=0, cur=null;
      for(var j=0;j<oa.length;j++){
        var o=oa[j];
        if(o===O.moveTo){ cur=ap(co[k],co[k+1]); k+=2; }
        else if(o===O.lineTo){ var nx=ap(co[k],co[k+1]); k+=2;
          if(cur) add(cur[0],cur[1],nx[0],nx[1]); cur=nx; }
        else if(o===O.curveTo){ k+=6; cur=null; }
        else if(o===O.rectangle){
          var rx=co[k],ry=co[k+1],rw=co[k+2],rh=co[k+3]; k+=4;
          var p1=ap(rx,ry), p2=ap(rx+rw,ry), p3=ap(rx+rw,ry+rh);
          add(p1[0],p1[1],p2[0],p2[1]); add(p2[0],p2[1],p3[0],p3[1]);
        }
      }
    }
  }
  return spread(hy)>=4&&spread(vx)>=3;
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
    var total=doc.numPages, raw=[], tally={}, hc={}, hn={}, lib=window.pdfjsLib;
    function step(i){
      if(i>total) return Promise.resolve();
      var page;
      return doc.getPage(i).then(function(pg){
        page=pg; return pg.getTextContent();
      }).then(function(tc){
        var H=page.getViewport({scale:1}).height;
        var lines=pdfLines(tc,H);
        lines.forEach(function(l){
          if(!l.font) return;
          tally[l.font]=(tally[l.font]||0)+l.text.length;
          var lh=+(l.font.split("|")[1]||0);
          if(lh){ hc[lh]=(hc[lh]||0)+l.text.length; hn[lh]=(hn[lh]||0)+1; }
        });
        /* 선을 읽어 표가 있는 쪽을 짚는다. 글자로 짐작하던 것을 확실하게 한다. */
        return page.getOperatorList().then(function(ops){
          var tbl=false;
          try{ tbl=pdfHasGrid(lib,ops,H); }catch(e){}
          raw.push({page:i,lines:lines,tbl:tbl});
          if(onProgress) onProgress(i,total);
          return step(i+1);
        },function(){
          raw.push({page:i,lines:lines,tbl:false});
          if(onProgress) onProgress(i,total);
          return step(i+1);
        });
      });
    }
    return step(1).then(function(){
      var bodySet=pickBody(tally);
      /* 글꼴을 못 믿으면 크기로 제목만 짚는다 — 없는 것보다 낫다 */
      var headSet=bodySet?null:headHeights(hc,hn);
      /* 본문 글자 높이 — 이보다 큰 제목이 큰 제목이다 */
      var bodyH=0;
      if(bodySet){
        var bk=Object.keys(bodySet).sort(function(a,b){ return tally[b]-tally[a]; })[0];
        bodyH=+(String(bk).split("|")[1]||0);
      }
      var pages=[];
      raw.forEach(function(r){
        var txt=linesToText(r.lines,bodySet,bodyH,headSet);
        if(txt) pages.push({page:r.page,content:txt,tbl:r.tbl});
      });
      return pages;
    });
  });
}

function lawUploadClick(){ if(!lawBusy) document.getElementById("lawfile").click(); }

/* 파일 선택 배선 */
document.getElementById("lawfile").addEventListener("change",function(e){
  var f=e.target.files[0]; e.target.value=""; if(!f) return;
  lawUpload(f);
});

/* 법제처 파일 이름은 「법령명(종류)(제N호)(시행일)」로 딱 떨어진다.
 *   약사법(법률)(제21109호)(20260621)
 * 괄호 묶음을 떼면 법령명만 남고, 그게 같으면 같은 법령의 다른 판이다.
 * 개정본을 올릴 때 옛 판을 자동으로 알아채는 근거가 이것이다. */
function lawParse(name){
  var t=nfc(name).replace(/\.pdf$/i,"").trim(), m;
  var no=(m=/\(\s*제\s*([0-9\-]+)\s*호\s*\)/.exec(t))?m[1]:null;
  var date=(m=/\((\d{8})\)?/.exec(t))?m[1]:null;
  /* 괄호 묶음을 떼어 낸 것이 법령명. 지침서처럼 괄호가 없으면 이름 그대로. */
  var base=t.replace(/\([^()]*\)?/g,"").replace(/\s+/g," ").trim();
  return {base:base||t, no:no, date:date};
}
/* 시행일을 사람이 읽는 꼴로 — 20260621 → 2026.6.21 */
function lawDate(d){
  if(!d||d.length<8) return "";
  return d.slice(0,4)+"."+(+d.slice(4,6))+"."+(+d.slice(6,8));
}
/* 이름 손질 — NFD(자모 분리)를 붙이고, 괄호 묶음을 떼어 짧게 한다.
 *   약사법(법률)(제21109호)(20260621) → 약사법
 * 직접 고쳐 둔 이름은 건드리지 않는다. 「원본 파일 이름에서 확장자만 뗀 것」과
 * 같을 때 = 아직 손대지 않았을 때만 다듬는다.
 * 무거운 「조문 전부 다시 만들기」에 묶어 두면 이름 하나 고치려고 1,387쪽을
 * 다시 읽어야 한다. 목록을 열 때 저절로 하고, 한 판에 한 번만 돈다. */
var lawTidied=false;
function lawTidyNames(){
  if(lawTidied) return; lawTidied=true;
  var n=0;
  S.laws.forEach(function(l){
    if(!l.name||!l.fileName) return;
    var raw=nfc(l.fileName).replace(/\.pdf$/i,"");
    if(nfc(l.name)!==raw) return;              /* 직접 고친 이름 — 그대로 둔다 */
    var tidy=lawParse(l.fileName).base;
    if(!tidy||tidy===l.name) return;
    l.name=tidy; dbUpdate("laws",l.id,{name:tidy}); n++;
  });
  /* 여기서 곧장 render() 를 부르면 그리는 도중에 다시 그리게 된다.
   * 한 박자 뒤로 미룬다. */
  if(n){ showToast("법령 이름 "+n+"개를 짧게 정리했어요"); setTimeout(render,0); }
}

/* 판을 가르는 정보(공포번호·시행일)는 <b>원본 파일 이름</b>에서 읽는다.
 * 화면에 보이는 이름은 짧게 다듬을 것이라 거기엔 숫자가 남지 않는다. */
function lawSrc(l){ return (l&&(l.fileName||l.name))||""; }

/* 문서 안에서 종류와 시행일을 읽는다.
 * 법제처 PDF 첫 쪽에는 늘 이렇게 적혀 있다 —
 *   법제처 1 국가법령정보센터 약사법 [시행 2026. 6. 21.] [법률 제21109호, …]
 * 지침서·안내서는 [시행]이 없는 대신 표지에 이렇게 적힌다 —
 *   바이오의약품 사전 GMP 평가 지침 [공무원 지침서] 2025. 9.
 * 파일 이름보다 정확하고, 이름을 바꿔도 안 깨진다.
 * 실제 문서 8개로 확인 — 법령 6개는 종류·시행일을 정확히, 지침서 2개는
 * 「공무원 지침서」와 발행 연월을 읽어냈다. */
function lawMeta(pages){
  var head=nfc((pages||[]).slice(0,2).map(function(p){ return p.content||""; }).join(" ")).slice(0,1200);
  var kind=null, eff=null, m;
  if((m=/\[\s*(법률|대통령령|총리령|부령|훈령|예규|[가-힣]{2,14}고시|고시)\s*제?\s*[0-9\-]+\s*호/.exec(head))){
    var k=m[1];
    kind=/고시$/.test(k)?"고시":k;
  } else if(/공무원\s*지침서|민원인\s*안내서|지침서|안내서/.test(head)) kind="지침";
  if((m=/\[\s*시행\s*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/.exec(head)))
    eff=m[1]+("0"+m[2]).slice(-2)+("0"+m[3]).slice(-2);
  /* 지침서 발행 연월 — 표지에 적히는 꼴이 여러 가지다.
   *   2025. 9.   ·   2026년 06월   ·   2025-11 */
  /* 표지 날짜는 꼴이 여러 가지다. 게다가 PDF에서 뽑으면 글자 순서가 뒤엉켜
   * 「년 월 2026 06」처럼 나오는 문서도 있다(전문수탁 제조업체 평가 절차).
   *   2025. 9.  ·  2026년 06월  ·  2025-11  ·  년 월 2026 06 */
  else if((m=/(20\d{2})\s*\.\s*(\d{1,2})\s*\.|(20\d{2})\s*년\s*(\d{1,2})\s*월|(20\d{2})-(\d{1,2})(?!\d)|년\s*월\s*(20\d{2})\s+(1[0-2]|0?[1-9])(?!\d)/.exec(head))
          &&(m=[0,m[1]||m[3]||m[5]||m[7],m[2]||m[4]||m[6]||m[8]]))
    eff=m[1]+("0"+m[2]).slice(-2)+"00";
  return {kind:kind,eff:eff};
}
/* 종류를 정하는 차례 — ① 문서에서 읽은 것 ② 원본 파일 이름 */
var KIND_BY_TEXT={"법률":0,"대통령령":1,"총리령":2,"부령":2,"고시":3,"훈령":3,"예규":3,"공고":3,"지침":4,"국제기준":5};
function lawKindOf(l){
  if(l&&l.kind&&KIND_BY_TEXT[l.kind]!=null)
    return {n:KIND_BY_TEXT[l.kind],t:l.kind==="총리령"||l.kind==="부령"?"시행규칙"
            :l.kind==="대통령령"?"시행령":l.kind==="지침"?"지침·안내서":l.kind};
  return lawKind(lawSrc(l));
}
/* 시행일도 문서에서 읽은 것을 먼저 쓴다 */
function lawEffOf(l){
  if(l&&l.eff) return /00$/.test(l.eff)?l.eff.slice(0,4)+"."+(+l.eff.slice(4,6)):lawDate(l.eff);
  return lawDate(lawParse(lawSrc(l)).date);
}

/* 같은 법령의 다른 판을 찾는다 (자기 자신은 뺀다) */
function lawOtherEditions(name,skipId){
  var b=lawParse(name).base;
  if(!b) return [];
  return S.laws.filter(function(l){
    return l.id!==skipId && lawParse(lawSrc(l)).base===b;
  });
}
/* 같은 법령이 여럿이면 시행일이 가장 늦은 것만 「지금 판」이다 */
function lawIsOld(l){
  var mine=lawParse(lawSrc(l));
  if(!mine.base) return false;
  var myEff=l.eff||mine.date;
  var idx=S.laws.indexOf(l);
  return S.laws.some(function(o,oi){
    if(o.id===l.id) return false;
    var p=lawParse(lawSrc(o));
    if(p.base!==mine.base) return false;
    var oEff=o.eff||p.date;
    /* 같은 판이 두 벌이면 하나만 남긴다 — 뒤에 있는 쪽을 지울 것으로 본다.
     * 날짜가 같아서 「더 새것」으로는 안 걸리는데, 검색 결과는 두 번씩 나온다. */
    if(oEff&&myEff&&oEff===myEff) return oi<idx;
    if(oEff&&myEff) return oEff>myEff;
    if(p.no&&mine.no) return p.no>mine.no;
    return false;
  });
}

function lawUpload(f){
  if(lawBusy) return;
  var drop=[], meta=null;
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
    /* 대체 확인은 <b>PDF를 읽은 뒤, 파일을 올리기 전에</b> 묻는다.
     *  · 읽은 뒤라야 문서 안의 시행일로 견줄 수 있다 (지침서는 이름에 날짜가 없다)
     *  · 올리기 전이라야 취소했을 때 저장 공간에 쓰레기가 안 남는다 */
    meta=lawMeta(pages);
    var old=lawOtherEditions(f.name,null);
    if(old.length){
      var mine=lawParse(f.name), myEff=meta.eff||mine.date;
      var show=function(d){ return d?(/00$/.test(d)?d.slice(0,4)+"."+(+d.slice(4,6)):lawDate(d)):"날짜 없음"; };
      var lines=old.map(function(l){
        return "  · "+show(l.eff||lawParse(lawSrc(l)).date)+"  "+l.name;
      }).join("\n");
      /* 세 갈래로 갈라 말한다. 「같은 판」을 「더 새것이 아님」으로 뭉뚱그리면
       * ⚠️ 가 떠서, 같은 파일을 다시 올리는 것뿐인데 겁을 먹게 된다. */
      var same=old.every(function(l){ var oe=l.eff||lawParse(lawSrc(l)).date;
                                      return oe&&myEff&&oe===myEff; });
      var newer=!same&&old.every(function(l){ var oe=l.eff||lawParse(lawSrc(l)).date;
                                              return !(oe&&myEff)||myEff>oe; });
      var tail = same  ? "\n\n같은 판입니다. 다시 올려 덮어쓸까요?\n(내용이 바뀌었다면 이걸 고르세요)"
               : newer ? "\n\n옛 판을 지우고 새것으로 대체할까요?"
               :         "\n\n⚠️ 이미 올라온 쪽이 더 새것입니다.\n그래도 이것으로 대체할까요?";
      var msg="「"+mine.base+"」이(가) 이미 올라와 있어요.\n\n"+lines
        +"\n\n새로 올리는 것: "+show(myEff)+tail
        +"\n\n[확인] 대체 — 옛 것은 지웁니다\n[취소] 올리지 않습니다";
      /* 취소는 「올리지 않음」이다. 「둘 다 남김」은 중복을 만드는 선택지라
       * 고를 이유가 없다 — 그걸 고르면 나중에 목록에서 하나씩 지워야 한다. */
      if(!confirm(msg)) throw new Error("CANCEL");
      drop=old;
    }
    showToast("파일 올리는 중...");
    return sb.storage.from("files").upload(path,f).then(function(res){
      if(res.error) throw new Error("업로드 실패: "+res.error.message);
      uploaded=true;
      return pages;
    });
  }).then(function(pages){
    var item={name:lawParse(f.name).base,filePath:path,fileName:nfc(f.name),pages:pages.length,
              kind:meta.kind,eff:meta.eff};
    return dbInsert("laws",item).then(function(row){
      if(!row) throw new Error("법령 정보를 저장하지 못했어요.");
      S.laws.unshift(item);
      return saveLawPages(row.id,pages).then(function(){
        return saveLawArticles(row.id,buildLawArticles(pages,f.name,meta.kind),item).then(function(){
          /* 새것이 온전히 올라간 다음에 지운다 — 먼저 지우면 실패했을 때 둘 다 없다 */
          drop.forEach(function(l){ del("laws",l.id,true); });
          if(drop.length) showToast("✓ 옛 판 "+drop.length+"개를 지웠어요");
        });
      });
    });
  }).then(function(){
    lawBusy=false; lawListOpen=true; render();
    showToast("✓ 법령 추가 완료");
  }).catch(function(err){
    lawBusy=false;
    if(uploaded) sb.storage.from("files").remove([path]);
    render();
    if(err&&err.message==="CANCEL"){
      showToast("올리지 않았어요.");   /* 사람이 고른 것이지 잘못된 게 아니다 */
    } else if(err&&err.message==="SCAN"){
      alert("글자가 없는 스캔본 같아요.\n\n1단계는 글자가 들어 있는 PDF만 지원해요.\n법제처에서 받은 PDF면 대부분 됩니다.");
    } else showToast((err&&err.message)||"법령을 추가하지 못했어요.",true);
  });
}

/* 쪽 글자도 저장 전에 손질한다. 예전에는 조문만 손질해서, 「쪽 그대로 보기」에는
 * 「법제처 2 국가법령정보센터」와 쪽 번호가 그대로 남아 있었다.
 * 머리글 패턴은 문서 전체를 봐야 알 수 있으므로 한 번 구해 쪽마다 쓴다. */
/* **쪽 손질에도 법령 이름을 넘겨야 한다.** 조문을 자르는 findArticles 는 여기서
 * 손질한 글자를 보는데, 이름을 안 넘기면 식약처 고시의 머리글이 남아
 * 「…품목허가ㆍ심사 규정 제7조(심사자료의 요건)」이 인용으로 오인된다. */
function cleanPages(rows,name){
  var hre=[runHeadRe(nfc(rows.map(function(r){ return r.content||""; }).join("\n"))),
           nameHeadRe(name)];
  rows.forEach(function(r){ r.content=cleanPdfText(r.content||"",hre); });
  return rows;
}

/* 한 번에 다 넣으면 요청이 너무 커진다 — 50쪽씩 나눠 보낸다 */
function saveLawPages(lawId,pages){
  cleanPages(pages);
  var rows=pages.map(function(p){
    return {law_id:lawId,page:p.page,content:p.content,article:p.article||null,tbl:!!p.tbl};
  });
  var i=0;
  function chunk(){
    if(i>=rows.length) return Promise.resolve();
    var part=rows.slice(i,i+50); i+=50;
    showToast("저장 중 "+Math.min(i,rows.length)+"/"+rows.length+"쪽");
    function put(rs){ return withAuthRetry(function(){ return sb.from("law_pages").insert(rs); }); }
    return put(lawTblCol?part:dropTbl(part)).then(function(res){
      /* 없는 칸이면 그 칸만 빼고 다시 넣는다 (SQL을 아직 안 돌린 경우) */
      if(res.error&&isNoTblCol(res.error)){ lawTblCol=false; return put(dropTbl(part)); }
      return res;
    }).then(function(res){
      if(res.error&&isNoArtCol(res.error)){
        lawArtCol=false;
        var plain=part.map(function(r){ return {law_id:r.law_id,page:r.page,content:r.content}; });
        return put(plain);
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
/* 별표는 열 쪽이 넘기도 한다. 통짜로 두면 세 가지가 한꺼번에 나빠진다 —
 *   · 검색 결과가 「별표3 · 12건」 한 카드에 뭉쳐 어디를 볼지 모른다
 *   · 「냉장 보관」처럼 낱말 둘을 찾을 때 서로 딴 쪽에 있어도 통과한다
 *   · AI에게 먹일 때 앞부분만 잘려 들어간다
 * 안에 번호 매김 소제목(2.1 제조부서 책임자)이 있으면 그 단위로 더 쪼갠다. */
var SUB_MIN=1500;        /* 별표가 이만큼 길 때만 쪼갠다 */
var SUB_HEAD_MIN=150;    /* 첫 소제목 앞에 이만큼 있으면 「머리말」로 따로 둔다 */
var SUB_PART_MIN=80;     /* 이보다 짧은 토막은 앞 토막에 붙인다 */
/* 지침서·안내서는 본문에서 남의 법 조문을 자주 인용한다.
 *   "… 「약사법」 제31조(제조업 허가 등)에 따라 …"
 * 이걸 자기 조문으로 잡으면 20~60자짜리 껍데기가 잔뜩 생기고, 정작 지침서
 * 본문은 그 사이에 끼어 사라진다.
 * 「짧으면 인용」으로 재면 안 된다 — 약사법 제95조의2(벌칙)는 65자짜리 진짜
 * 조문이다. 대신 「앞이 문장 끝인가」로 가른다. 진짜 조문은 앞 조가 "…한다 ."
 * 로 끝난 자리에서 시작하고, 인용은 문장 한복판(」 뒤, 「에 따라」 앞)에 있다.
 * 그래도 남는 것을 위해 아주 낮은 바닥만 둔다. */
var ART_BODY_MIN=40;
/* 쓸 만한 조가 이보다 적으면 조문 문서가 아니라고 보고 쪽 단위로 돌아간다 */
var ART_DOC_MIN=5;
/* 소제목이 없는 표 별표(행정처분 기준 4만6천자, 임상시험 관리기준 3만8천자)는
 * 위 방법으로 못 쪼갠다. 표라서 「2.1」 같은 머리말이 아예 없기 때문이다.
 * 이런 것은 호(1. 2. 3.) 자리에서, 그것도 없으면 길이로 나눈다.
 * 나누는 목적은 「검색이 어디를 가리키는지」와 「AI에게 통째로 안 잘려 들어가기」
 * 둘뿐이므로, 자리가 조금 어긋나도 통짜보다는 낫다. */
var TBL_CHUNK=3000;      /* 이 길이를 목표로 나눈다 */
var TBL_SPLIT_MIN=8000;  /* 이보다 길고 소제목이 없으면 나눈다 */
var SOON_RE=/\[\s*시행일\s*:\s*([^\]]{1,24})\]/;

/* 지침서 한 쪽의 첫머리에서 제목을 뽑는다. 「20쪽」만 있으면 검색 결과에서
 * 어느 대목인지 알 수 없다. 「20쪽 · IV. 세포은행 시스템」이면 바로 보인다.
 * 문장(마침표로 끝나는 글)은 제목이 아니므로 버린다. */
/* 지침서에는 쪽 제목이 따로 없어서, 첫머리 스무 자를 잘라 제목이라고 우기게 된다.
 * 「위탁제조 판매가 가능함 다만 의약품 제」처럼 잘린 말은 제목이 아니라 방해다.
 * **없는 것이 틀린 것보다 낫다** — 문장 도막임이 확실한 것만 버린다. */
function isCutTitle(t){
  if(/^(및|또는|그리고|다만|이때|따라|관한|대한|위하여|에서|에|의|를|을|이|가|은|는|와|과|로|으로)(\s|[가-힣])/.test(t)) return true;
  if(/^(이|본|해당|위)\s*(지침서|안내서|규정|고시|기준|법|조|항)/.test(t)) return true;
  var ws=t.split(/\s+/), last=ws[ws.length-1]||"";
  /* 어절 한복판에서 잘린 것. 다만 「1 목 적」처럼 자간이 벌어져 한 글자로 뽑히는
   * 짧은 제목까지 버리면 안 되므로, 어절이 넷 이상일 때만 잘린 것으로 본다. */
  if(/^[가-힣]$/.test(last)&&(ws.length>=4||t.length>10)) return true;
  return false;
}

/* 글꼴로 알아낸 제목 줄에서 쪽 이름을 고른다. 제목은 짧은 줄로 따로 서 있다.
 * 큰 제목(숫자로 시작)을 먼저 쓰고, 없으면 소제목(글머리표)을 쓴다.
 * 쪽 첫머리만 보면 앞 쪽에서 이어진 본문이라 이름을 못 얻는다(22쪽). */
/* 큰 제목만 — 쪽마다 물려주려면 소제목은 빼야 한다.
 * 「· 교차오염방지」는 그 쪽 안의 한 대목일 뿐이고, 그 쪽이 어느 대목에
 * 속하는지는 앞에서 이어진 큰 제목이 말해 준다. */
/* half 를 주면 **그 쪽의 절반 넘게 차지하는** 큰 제목만 돌려준다.
 * 9월 4일에 본 8쪽이 그 경우다 — 위 4분의 1은 앞 절(「실태조사 경비」)의
 * 꼬리고 아래 4분의 3이 새 절(「5 평가방법」)이었는데, 첫 줄만 보니
 * 꼬리를 쪽 이름으로 삼았다. 거꾸로 22쪽처럼 새 절이 맨 끝에서야 시작하면
 * 그 쪽은 여전히 앞에서 이어진 제목의 것이다. */
function headLineBig(t,half){
  var s=String(t||""), ls=s.split("\n"), at=0;
  for(var i=0;i<ls.length;i++){
    var L=ls[i].replace(/\s+/g," ").trim();
    var ok=!(!L||L.length>30||/[.?!]$/.test(L))
        && !/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(L)
        && isBigHead(L)&&L.length>=2&&!isCutTitle(L);
    if(ok){
      /* 뒤쪽에서야 나온 제목이면 이 쪽의 이름이 아니다 */
      if(half&&(s.length-at)<=at) return "";
      return tidyTitle(L);
    }
    at+=ls[i].length+1;
  }
  return "";
}

/* 제목 줄인데 글머리표가 없으면 큰 제목이다 — 추출할 때 떼어 두었다.
 * 글머리표는 문서마다 다르다. 09 생균치료제는 ○ 자리에 **로마자 O**를,
 * 그 아래 층에는 줄표(-)를 쓴다. 그걸 안 걸러 「O 취급 병원체에 따른
 * 전용시설」이 쪽 이름으로 올라왔다. */
function isBigHead(L){
  if(!L) return false;
  if(/^[·ㆍ•▪○◦●□■◆▶⦁‧∙※*\-–—]/.test(L)) return false;
  if(/^[OoＯ]\s/.test(L)) return false;
  return true;
}

/* 제목 끝에 매달린 여는 괄호를 턴다 — 24자에서 자르면 「… 평가 결과 (서류 및
 * 증명서」처럼 괄호가 열린 채 끝난다. */
function tidyTitle(L){
  L=String(L||"").replace(/\s*[(（\[「『]\s*[)）]?\s*$/,"").trim();
  /* **낱말 한복판에서 자르면 뜻이 상한다** — 「…시설 운영 관리 방」(침이 잘림).
   * 조금(네 글자) 넘치는 것은 그대로 두고, 많이 넘치면 빈칸에서 끊는다. */
  if(L.length>28){
    var cut=L.slice(0,28), sp=cut.lastIndexOf(" ");
    L=(sp>=12?cut.slice(0,sp):cut).trim();
  }
  var o=L.lastIndexOf("(");
  if(o>0&&L.indexOf(")",o)<0) L=L.slice(0,o).trim();
  return L;
}

function headLineTitle(t){
  var ls=String(t||"").split("\n"), big="", small="";
  for(var i=0;i<ls.length;i++){
    var L=ls[i].replace(/\s+/g," ").trim();
    if(!L||L.length>30||/[.?!]$/.test(L)) continue;
    if(/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(L)) continue;            /* 쪽 번호 */
    var bare=L.replace(/^[·ㆍ•▪○\s]+/,"").trim();
    if(bare.length<2||isCutTitle(bare)) continue;
    if(!big&&/^\d/.test(bare)) big=bare;
    if(!small&&!/^\d/.test(bare)) small=bare;
  }
  return tidyTitle(big||small);
}

/* 「【붙임 2】실사 이력표 …」처럼 붙임·참고로 시작하는 쪽은 **그것이 이 쪽의 이름**이다.
 * 앞 쪽에서 이어진 큰 제목(「6 행정사항」)을 물려받으면 아주 엉뚱해진다.
 * 제목이 표 내용으로 이어지는 일이 많아 낱말 두 개까지만 쓴다. */
var ATTACH_RE=/^[\s·]*[【\[]?\s*(붙임|참고|별첨|부록)\s*(\d{1,2})?\s*[】\]]?\s*/;
function attachTitle(t){
  var s=nfc(String(t||"")).replace(/^\s+/,"");
  var m=ATTACH_RE.exec(s);
  if(!m) return "";
  var head=m[1]+(m[2]?" "+m[2]:"");
  var rest=s.slice(m[0].length).split(/[\n]/)[0].split(/\s+/).filter(Boolean);
  var add=[];
  for(var i=0;i<rest.length&&add.length<2;i++){
    var w=rest[i];
    if(!/^[가-힣A-Za-z0-9]/.test(w)||w.length>8) break;
    add.push(w);
  }
  return (head+" "+add.join(" ")).trim();
}

function pageTitle(t){
  var byLine=headLineTitle(t);
  if(byLine) return byLine;
  /* 글꼴을 못 믿는 문서(한글에서 만들어 글꼴이 잘게 쪼개진 것)에서만 여기까지 온다.
   * 앞에 붙은 글머리표는 건너뛰고, 제목은 다음 글머리표 앞에서 끊는다 —
   * 안 그러면 「1 목 적 ○ 의약품등의 품목별 사전 GM」처럼 넘어가서 잘린다. */
  var s=nfc(t).replace(/\s+/g," ").replace(RUNHEAD_RE,"").replace(/^[·ㆍ•▪⦁‧∙◦●□■◆▶○\s]+/,"").trim();
  if(s.length<20) return "";
  var m=/^((?:[IVX]{1,4}|[0-9]{1,2})\s*[.)]?\s*)?([가-힣A-Za-z][^.。○·ㆍ•▪⦁‧∙◦●□■◆▶※]{1,20})/.exec(s);
  if(!m) return "";
  var ti=((m[1]||"")+m[2]).replace(/\s+/g," ")
    .replace(/[\[\(<「『·ᆞㆍ,\-]+$/,"").trim();   /* 끝에 매달린 여는 괄호·구분점을 턴다 */
  /* 「실태조사 경비 - 수익자(품목 허가」처럼 줄표 글머리표가 이어지면 그 앞까지.
   * 빈칸으로 둘러싸인 줄표만 본다 — 「1-2 세포은행 시스템관리」는 안 잘린다. */
  ti=ti.split(/\s[-–—]\s/)[0].trim();
  if(ti.length<2) return "";      /* 「제 ⦁ 개정 이력」에서 「제」만 남는 꼴 */
  /* 조사로 끝나면 문장 도막이다. **어절 하나가 통째로 조사일 때만** 본다 —
   * 그냥 끝 글자로 보면 「우선 GMP 평가」의 「가」까지 조사로 오인한다. */
  if(/(?:^|\s)(은|는|이|가|을|를|에|의|와|과|로|으로|및)$/.test(ti)) return "";
  if(isCutTitle(ti)) return "";
  return tidyTitle(ti);
}

function buildLawArticles(pages,docName,docKind){
  /* 지침서·안내서는 남의 별표를 본문에서 인용할 뿐, 자기 별표를 갖지 않는다.
   * 그걸 머리말로 잡으면 「별표 1(통칙에 따르면 세포은행은 …)」처럼 본문이
   * 제목으로 올라온다. 아예 안 잡고 쪽 단위로 간다. */
  /* 반드시 원본 파일 이름으로 판별한다. 화면 이름은 「(식품의약품안전처고시)」를
   * 떼어 다듬으므로, 그걸로 재면 고시가 지침서로 보여 별표를 통째로 버린다.
   * 실제로 342쪽 고시가 조문 240개 → 10개로 무너졌었다. */
  var noTbl=(docKind?docKind==="지침":lawKind(docName).n>=4);
  var buf=[], marks=[], pos=0;
  /* 손질은 쪽마다 먼저 한다. 이어 붙인 뒤에 손질하면 머리글·쪽 번호를 지운
   * 만큼 글자 수가 줄어드는데 marks는 옛 위치라, 「몇 쪽인지」가 통째로
   * 어긋난다(별지 제80호서식이 475쪽에서 469쪽으로 밀렸다).
   * 머리글 패턴만은 문서 전체를 봐야 알 수 있으므로 한 번 구해 두고 쓴다. */
  var hre=[runHeadRe(nfc(pages.map(function(p){ return p.content||""; }).join("\n"))),
           nameHeadRe(docName)];
  pages.forEach(function(p){
    var t=cleanPdfText(p.content||"",hre).trim();
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
  /* 부칙에도 제1조·제2조가 있다. 「제1조(시행일)」이 본문 제1조로 보이면
   * 검색 결과에서 엉뚱한 걸 근거로 삼게 된다. 라벨에 「부칙」을 붙여 가른다.
   * 「부칙 <제21109호,2025. 11. 11.>」 꼴의 머리말만 잡는다 — 본문 속
   * "부칙 제2조에 따라" 같은 인용에는 < > 가 없다. */
  var buAt=[], bm, bre=/부\s*칙\s*<[^<>]{0,60}>/g;
  while((bm=bre.exec(full))!==null) buAt.push(bm.index);
  function inBuchik(at){ for(var i=0;i<buAt.length;i++) if(buAt[i]<at) return true; return false; }

  var heads=findArticles(full,20000).filter(function(h){ return !(noTbl&&h.table); });
  var out=[];
  /* 표가 있는 쪽 — PDF의 선을 읽어 둔 것이다. 조문이 걸친 쪽 중 하나라도
   * 표면 그 조문은 표로 본다. 글자로 짐작하던 것을 대신한다. */
  var tblPage={};
  pages.forEach(function(p){ if(p.tbl) tblPage[p.page]=1; });
  var hasTbl=false; for(var tk in tblPage){ hasTbl=true; break; }
  function addRow(lab,num,text,a,b,chunk){
    if(text.length<10) return;
    if(text.length>LAW_ART_SAVE_MAX) text=text.slice(0,LAW_ART_SAVE_MAX);
    var p1=pageAt(a), p2=pageAt(b-1), t=null;
    if(hasTbl){ t=false; for(var z=p1;z<=p2;z++) if(tblPage[z]){ t=true; break; } }
    out.push({ seq:out.length+1, label:lab, num:num, chunk:!!chunk, tbl:t,
               page:p1, page_end:p2, content:text });
  }
  for(var i=0;i<heads.length;i++){
    var a=heads[i].at, b=(i+1<heads.length)?heads[i+1].at:full.length;
    var raw=full.slice(a,b);
    var text=raw.replace(/\s+/g," ").trim();
    if(text.length<10) continue;
    /* 법제처 PDF는 「곧 시행될 개정 조문」을 현행 조문 바로 뒤에 한 번 더 싣고
     * 끝에 [시행일: 2026. 10. 8.] 을 붙인다. 같은 라벨이 두 번 나오는 진짜 이유다.
     * 지우면 안 되는 정보이므로, 라벨에 시행일을 붙여 구분되게 한다. */
    var lab=heads[i].label, sh=SOON_RE.exec(text);
    if(sh) lab+=" · 시행 "+sh[1].replace(/\s+/g," ").trim();
    if(inBuchik(a)&&!heads[i].table) lab="부칙 "+lab;
    var num=artShort(heads[i].label);

    /* 긴 별표는 소제목 단위로 더 쪼갠다 (SUB_MIN 설명 참고) */
    var isTbl=/^별표/.test(heads[i].label);
    var subs=(isTbl&&raw.length>=SUB_MIN)?subHeads(raw):[];
    /* 소제목이 없는 표 별표는 호 자리·길이로 나눈다 (TBL_CHUNK 설명 참고) */
    if(isTbl&&subs.length<2&&raw.length>=TBL_SPLIT_MIN) subs=tblChunks(raw);
    /* 법제처 별표의 격자(┃…┨) 한복판에서 자르면 표가 깨진다 — 줄 안에 떨어진 자름점은 뺀다 */
    subs=gridSafe(raw,subs);
    if(subs.length>=2){
      if(subs[0].at>=SUB_HEAD_MIN) subs.unshift({at:0,title:"머리말"});
      var parts=[];
      for(var k=0;k<subs.length;k++){
        var sa=subs[k].at, sb=(k+1<subs.length)?subs[k+1].at:raw.length;
        var st=raw.slice(sa,sb).replace(/\s+/g," ").trim();
        /* 너무 짧은 토막은 앞에 붙인다 — 버리면 그 글이 통째로 사라진다 */
        if(parts.length&&st.length<SUB_PART_MIN){
          var pv=parts[parts.length-1];
          pv.text+=" "+st; pv.b=a+sb; continue;
        }
        parts.push({title:subs[k].title,text:st,a:a+sa,b:a+sb});
      }
      /* 소제목이 한쪽에 몰려 있으면 쪼갠 뒤에도 5만 자짜리 토막이 남는다.
       * 남은 큰 토막은 길이로 한 번 더 나눈다. */
      var parts2=[];
      parts.forEach(function(pt){
        if(pt.text.length<TBL_SPLIT_MIN){ parts2.push(pt); return; }
        var cs=gridSafe(pt.text,tblChunks(pt.text));
        if(cs.length<2){ parts2.push(pt); return; }
        for(var z=0;z<cs.length;z++){
          var za=cs[z].at, zb=(z+1<cs.length)?cs[z+1].at:pt.text.length;
          /* **「1/4」은 붙이지 않는다.** 옆에 쪽 배지(199~202쪽)가 이미 어느
           * 토막인지 말해 주므로 군더더기다 — 「6/14 토막」을 뺀 것과 같은 이유. */
          parts2.push({title:pt.title,
                       text:pt.text.slice(za,zb).trim(), a:pt.a+za, b:pt.a+zb});
        }
      });
      parts=parts2;
      if(parts.length>=2){
        for(var q=0;q<parts.length;q++){
          /* tblChunks 가 낸 토막은 제목이 숫자뿐이다. 「2/4 토막」은 기계가 센
           * 번호일 뿐이라, 그 토막 첫머리에 「7. 공급관리」 같은 소제목이 있으면
           * 그걸 이름으로 쓴다. **못 찾으면 아무것도 안 붙인다** — 「6/14 토막」은
           * 기계가 센 번호라 사람에게는 뜻이 없다. 어디인지는 쪽 배지가 말해준다. */
          var t=parts[q].title, num0=/^\d+$/.test(t);
          /* 토막은 길이로 자르므로 소제목 한복판에서 시작한다(253쪽 토막은
           * 「7. 공급관리」의 중간부터다). 토막 첫머리에 소제목이 없으면
           * **그 자리에서 유효한 소제목**을 앞에서 찾아 온다. */
          if(num0) t=chunkTitle(parts[q].text)||chunkHead(text,parts[q].a-a);
          addRow(lab+(t?" · "+t:""),num,parts[q].text,parts[q].a,parts[q].b,num0&&!t);
        }
        continue;
      }
    }
    addRow(lab,num,text,a,b);
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
    if(a.chunk) return true;      /* 토막은 라벨이 같은 게 당연하다 — 지우면 안 된다 */
    var k=artKey(a.label);
    return best[k]===a||a.content.length>=200;
  });
  out.forEach(function(a,i){ a.seq=i+1; });

  /* 인용 껍데기 걷어내기 — 별표는 표만 있고 글이 짧을 수 있으므로 조문만 본다 */
  out=out.filter(function(a){
    /* 별표는 표만 있고 글이 짧을 수 있으므로 바닥을 더 낮게 둔다 */
    return a.content.length>=(/^별표|^별지/.test(a.label)?60:ART_BODY_MIN);
  });
  out.forEach(function(a,i){ a.seq=i+1; });

  /* 조가 없거나, 있어도 알맹이가 없는 문서(지침서·안내서)는 쪽을 한 단위로 쓴다.
   * 개수로만 재면 안 된다 — 지침서는 남의 조문을 스무 번씩 인용하므로 개수는
   * 채워진다. 그 조각들이 하나같이 짧다는 것이 진짜 표시다.
   * 약사법은 가운뎃값 470자, 지침서는 100자 안팎이다. */
  var body=out.filter(function(a){ return !/^별표|^별지/.test(a.label); })
              .map(function(a){ return a.content.length; }).sort(function(x,y){ return x-y; });
  var mid=body.length?body[Math.floor(body.length/2)]:0;
  if(body.length<ART_DOC_MIN||mid<200){
    out=[];
    /* 쪽 이름은 **그 쪽이 시작될 때 유효한 큰 제목**이다. 그 쪽 안의 아무 제목이나
     * 쓰면 틀린다 — 22쪽 첫머리는 21쪽의 「1-2 세포은행 시스템관리」에 속하고,
     * 「2 보관시설」은 그 쪽 끝에서 새로 시작하는 절이다. */
    var carryBig="";
    pages.forEach(function(p){
      var t=(p.content||"").trim();
      if(!t) return;
      t=cleanPdfText(t,hre);        /* 조문 쪽과 같은 손질을 여기에도 */
      var big=headLineBig(t);
      /* 붙임·참고로 시작하는 쪽이면 그것이 먼저다 — 물려받은 제목보다 앞선다 */
      var ti=attachTitle(t)||headLineBig(t,true)||carryBig||big||pageTitle(t);
      /* 「목 차」는 그 쪽만 목차다. 물려주면 붙임 보고서 열 쪽이 죄다
       * 「목 차」가 된다 — 이름은 없는 것이 틀린 것보다 낫다. */
      if(big) carryBig=/^(목\s*차|차\s*례)$/.test(big)?"":big;
      /* **표 여부를 안 넘기고 있었다.** 쪽에는 tbl 이 제대로 붙는데(선으로 판정)
       * 조문 행으로 옮기지 않아, 지침서의 표 쪽이 「칸이 뒤섞여 읽기 어려운
       * 대목이에요」로 안 바뀌고 뒤엉킨 글자가 그대로 나왔다.
       * 조 단위 문서는 findArticles 쪽에서 이미 넘기고 있다. */
      out.push({ seq:out.length+1, label:p.page+"쪽"+(ti?" · "+ti:""), num:p.page+"쪽",
                 page:p.page, page_end:p.page, content:t, tbl:!!p.tbl });
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
      var o={law_id:lawId,seq:a.seq,label:a.label,num:a.num,
             page:a.page,page_end:a.page_end,content:a.content};
      if(a.tbl!=null) o.tbl=a.tbl;
      return o;
    });
    var i=0;
    function chunk(){
      if(i>=rows.length) return Promise.resolve();
      var part=rows.slice(i,i+30); i+=30;
      showToast("조문 저장 "+Math.min(i,rows.length)+"/"+rows.length);
      function put(rs){ return withAuthRetry(function(){ return sb.from("law_articles").insert(rs); }); }
      return put(lawTblCol?part:dropTbl(part)).then(function(r){
        if(r.error&&isNoTblCol(r.error)){ lawTblCol=false; return put(dropTbl(part)); }
        return r;
      }).then(function(r){
        if(r.error) throw new Error("조문 저장 실패: "+r.error.message);
        return chunk();
      });
    }
    return chunk();
  }).then(function(){
    if(localItem) localItem.arts=arts.length;
    return dbUpdate("laws",lawId,{arts:arts.length});
  }).then(function(){ return lawEmbedRun(lawId); })   /* 조문이 새로 생겼으니 뜻 지문도 새로 */
  .then(unlock,fail);
}

/* ---------- 뜻 지문(임베딩) ----------
 * 조문마다 「뜻 지문」을 두면 낱말이 달라도 뜻이 닿는 조문을 찾는다(law-pick 이 쓴다).
 * 조문을 새로 만들면 지문도 새로 만든다. 한 번에 100개씩, 다 될 때까지 되풀이.
 * 열쇠(VOYAGE_API_KEY)가 없으면 한 번만 알리고 조용히 넘어간다 — 검색은 예전처럼 된다. */
var lawEmbedWarned=false, lawEmbedSlow=false;
function lawEmbedRun(lawId){
  var wait=function(sec){ return new Promise(function(res){ setTimeout(res,sec*1000); }); };
  return sb.functions.invoke("law-embed",{body:{op:"run",lawId:lawId||null,slow:lawEmbedSlow}}).then(function(r){
    var d=r&&r.data;
    if(!d){ showToast("뜻 지문을 만들지 못했어요: "+((r&&r.error&&r.error.message)||"응답 없음"),true); return; }
    if(d.noKey){ if(!lawEmbedWarned){ lawEmbedWarned=true; showToast("뜻 검색 열쇠(VOYAGE_API_KEY)가 아직 없어요 — 낱말로만 찾아요.",true); } return; }
    if(d.error&&d.retryAfter){
      /* 결제수단 없는 Voyage 계정은 분당 3회·1만 토큰뿐 — 3개씩 21초마다 보낸다 */
      if(d.slow&&!lawEmbedSlow){ lawEmbedSlow=true; showToast("Voyage 에 결제수단이 없어 느리게 만들어요 (분당 3개씩). 결제수단을 넣으면 1분이면 끝나요."); }
      return wait(d.retryAfter+1).then(function(){ return lawEmbedRun(lawId); });
    }
    if(d.error){ showToast(d.error,true); return; }
    if(d.remaining>0){
      showToast("뜻 지문 만드는 중 · 남은 조문 "+d.remaining+"개"+(lawEmbedSlow?" (약 "+Math.ceil(d.remaining/3*21/60)+"분)":""));
      return (lawEmbedSlow?wait(21):Promise.resolve()).then(function(){ return lawEmbedRun(lawId); });
    }
    if(d.done) showToast("✓ 뜻 지문을 만들었어요");
  },function(e){ showToast("뜻 지문을 만들지 못했어요: "+(e&&e.message),true); });
}
/* 목록을 열 때 한 번 — 지문이 없는 조문이 있으면 알림으로 채우게 한다 */
var lawEmbStat=null;
function lawEmbedCheck(){
  if(lawEmbStat!==null) return;
  lawEmbStat={missing:0,total:0,ready:true,loading:true};
  sb.functions.invoke("law-embed",{body:{op:"status"}}).then(function(r){
    var d=(r&&r.data)||{}; lawEmbStat={missing:+d.missing||0,total:+d.total||0,ready:d.ready!==false,loading:false};
    if(lawEmbStat.missing) render();
  },function(){ lawEmbStat={missing:0,total:0,ready:false,loading:false}; });
}
function lawEmbedAll(){
  if(lawBusy) return;
  lawBusy=true; render();
  lawEmbedRun(null).then(function(){ lawBusy=false; lawEmbStat=null; render(); lawEmbedCheck(); });
}

/* 조문 판별 규칙이 나아질 때마다 다시 올리지 않아도 되게 다시 계산한다.
 * **원본 PDF가 Storage에 있으면 그걸 다시 읽는다** — 글꼴·선 같은 「구조」는
 * 저장된 글자에는 없고 PDF에만 있기 때문이다. 없으면 저장된 글자로만 한다. */
function lawPagesForReindex(l){
  if(!l.filePath) return null;
  return withAuthRetry(function(){
    return sb.storage.from("files").createSignedUrl(l.filePath,3600);
  }).then(function(r){
    var u=r&&r.data&&r.data.signedUrl;
    if(r.error||!u) return null;
    showToast("원본 PDF를 받는 중...");
    return fetch(u).then(function(x){ return x.ok?x.arrayBuffer():null; });
  }).then(function(buf){
    if(!buf) return null;
    return extractPdfPages(buf,function(i,t){
      if(i%25===0||i===t) showToast("PDF 다시 읽는 중 "+i+"/"+t+"쪽");
    });
  }).catch(function(){ return null; });
}

/* 쪽 저장 — 「다시 만들기」의 두 길(하나씩·전부)이 함께 쓴다.
 * PDF에서 새로 뽑은 쪽에는 id가 없어서 upsert 하면 행이 하나 더 생긴다.
 * 그래서 옛 쪽을 통째로 지우고 넣는다. 저장된 글자로만 다시 만들 때는 upsert. */
function savePageRows(lawId,rows,isNew,loud){
  var i=0;
  function put(rs){
    return withAuthRetry(function(){
      return isNew?sb.from("law_pages").insert(rs):sb.from("law_pages").upsert(rs);
    });
  }
  function chunk(){
    if(i>=rows.length) return Promise.resolve();
    var part=rows.slice(i,i+50); i+=50;
    if(loud) showToast("쪽 저장 "+Math.min(i,rows.length)+"/"+rows.length);
    return put(lawTblCol?part:dropTbl(part)).then(function(r){
      if(r.error&&isNoTblCol(r.error)){ lawTblCol=false; return put(dropTbl(part)); }
      return r;
    }).then(function(r){
      if(r.error&&isNoArtCol(r.error)){
        lawArtCol=false;
        return put(part.map(function(x){ return {law_id:x.law_id,page:x.page,content:x.content}; }));
      }
      return r;
    }).then(function(r){
      if(r.error) throw new Error("쪽 저장 실패: "+r.error.message);
      return chunk();
    });
  }
  var pre=isNew
    ? withAuthRetry(function(){ return sb.from("law_pages").delete().eq("law_id",lawId); })
        .then(function(r){ if(r.error) throw new Error("옛 쪽을 지우지 못했어요: "+r.error.message); })
    : Promise.resolve();
  return pre.then(chunk);
}

function lawReindex(id){
  if(lawBusy) return;
  var l=S.laws.find(function(x){ return x.id===id; });
  if(!l) return;
  lawBusy=true; render();
  if(l.src==="api"){
    lawApiImport(l).then(function(r){ lawBusy=false; render(); showToast("✓ 조문 "+r.arts+"개를 새로 받았어요"); },
      function(err){ lawBusy=false; render(); showToast((err&&err.message)||"받지 못했어요.",true); });
    return;
  }
  showToast("쪽을 읽는 중...");
  var fresh=null;
  Promise.resolve(lawPagesForReindex(l)).then(function(fp){
    fresh=fp;
    if(fresh&&fresh.length) return {data:null};   /* PDF에서 새로 뽑았다 */
    return withAuthRetry(function(){
      return sb.from("law_pages").select("id,law_id,page,content").eq("law_id",id).order("page");
    });
  }).then(function(res){
    if(res&&res.error) throw new Error("쪽을 읽지 못했어요: "+res.error.message);
    var rows;
    if(fresh&&fresh.length){
      /* 새로 뽑은 쪽에는 id가 없다 — 옛 쪽을 지우고 새로 넣는다 */
      rows=fresh.map(function(p){ return {law_id:id,page:p.page,content:p.content,tbl:!!p.tbl}; });
    } else rows=(res&&res.data)||[];
    if(!rows.length) throw new Error("저장된 쪽이 없어요. PDF를 다시 올려주세요.");
    cleanPages(rows,lawSrc(l));   /* 먼저 손질하고 저장한다 — 그래야 쪽 보기도 깨끗해진다 */
    /* 쪽마다 "시작 시점에 유효한 조"도 같이 갱신한다 — 쪽 보기에서 쓴다 */
    var carry="";
    rows.forEach(function(r){
      r.article=carry||null;
      var a=findArticles(r.content||"");
      if(a.length) carry=a[a.length-1].label;
    });
    var meta=lawMeta(rows);
    if(meta.kind!==l.kind||meta.eff!==l.eff){
      l.kind=meta.kind; l.eff=meta.eff;
      dbUpdate("laws",l.id,{kind:meta.kind,eff:meta.eff});
    }
    var arts=buildLawArticles(rows,lawSrc(l),meta.kind);
    if(!arts.length) throw new Error("조문을 하나도 찾지 못했어요.");
    showToast("조문 "+arts.length+"개를 찾았어요");
    return savePageRows(id,rows,!!(fresh&&fresh.length),true)
      .then(function(){ return saveLawArticles(id,arts,l); });
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
/* 법 위계 — 이름만 보고 가른다. 법제처 PDF는 이름에 종류가 들어 있고
 * (법률)(총리령)(식품의약품안전처고시), 지침서는 [공무원 지침서] 꼴이다.
 * 목록 순서와 AI 근거 가중치에 함께 쓴다. 위가 셀수록 숫자가 작다. */
/* 맥·아이패드에서 만든 파일 이름은 한글이 「자모가 분리된 형태(NFD)」다.
 * ㅇ+ㅑ+ㄱ 처럼 쪼개져 있어서 화면엔 똑같이 「약사법」으로 보이지만,
 * 글자 비교로는 하나도 안 맞는다. 실제로 법 위계 분류가 전부 「그 밖」으로
 * 떨어졌고, 파일 여섯 개를 뜯어보니 전부 NFD였다.
 * 붙여넣는 민원 글도 마찬가지라 검색에도 같은 함정이 있다. 들어오는 글자는
 * 한 군데서 모아 NFC 로 맞춘다. */
/* PDF에서 뽑으면 글머리표(■)가 심볼 글꼴의 원래 바이트인 「m」으로 나오는
 * 문서가 있다 — 「… 한다 . m 품질위험관리 …」처럼 문장 사이에 낀다.
 * 그냥 지우면 「0.5 μm」 「등급 m3」 「200 mg」 같은 진짜 단위가 망가지므로,
 * 앞이 한글·문장부호이고 뒤에 한글이 두 자 이상 이어질 때만 바꾼다.
 * 문서 열 개로 확인 — 글머리표 30개를 모두 잡고 단위는 하나도 안 건드린다. */
var BULLET_M=/(?<=[가-힣.)\]」』\-–—])\s+m\s+(?=[가-힣]{2})/g;
/* 쪽 번호(- 27 -)를 지우고 나면 글머리표 m 이 줄 첫머리에 온다. 위 규칙은
 * 「앞 글자」를 요구하므로 그때는 안 잡힌다. 문서 10개에 3곳. */
var BULLET_M0=/(^|\n)[ \t]*m[ \t]+(?=[가-힣]{2})/g;

/* 심볼 글꼴의 글머리표는 유니코드 「사용자 영역」(U+E000~U+F8FF)으로 뽑히기도 한다.
 * 글꼴이 없으면 가로줄이 쌓인 네모(▤)처럼 보이는데, 문서 열 개에 75자 들어 있었다.
 * 실제로 쓰인 자리는 두 가지뿐이라 둘 다 가운뎃점이 맞다:
 *   「 유전자변형생물체의 취급」(글머리표) · 「위  수탁」(사이점) */
var PUA_RE=/[\uE000-\uF8FF]/g;

/* 국가법령정보센터 PDF는 쪽마다 「법제처 N 국가법령정보센터 + 법령 이름」이 찍힌다.
 * 쪽을 이어 붙이면 이 머리글이 문장 한복판에 끼어서, 「…의료기기에 해당하는」이
 * 「법제처 2 국가법령정보센터 첨단재생의료…법률 기기에 해당하는」으로 읽힌다. */
var LAWHEAD_RE=/법제처\s*\d+\s*국가법령정보센터\s*/g;
function reEsc(t){ return String(t).replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function stripRunHead(t){ return t.replace(runHeadRe(t)," "); }
/* 머리글 패턴은 문서 전체를 봐야 알 수 있다(쪽 하나에는 머리글이 하나뿐이라
 * 공통 앞부분을 못 구한다). 그래서 패턴을 먼저 구하고, 쪽마다 그것으로 지운다. */
function runHeadRe(t){
  var ms=[], m; LAWHEAD_RE.lastIndex=0;
  while((m=LAWHEAD_RE.exec(t))!==null) ms.push(m.index+m[0].length);
  if(ms.length>=2){
    /* 머리글 뒤 법령 이름은 문서마다 다르다. 미리 알 필요 없이 「머리글 다음에
     * 오는 글의 공통 앞부분」으로 알아낸다 — 쪽마다 똑같이 찍히기 때문이다. */
    /* **마지막 꼬리말 뒤에는 아무것도 없다.** 그 빈 조각까지 견주면 공통 앞부분이
     * 첫 글자에서 끊겨 이름을 못 얻는다 — 약사법 87쪽이 이것 때문에 안 지워졌다. */
    /* 별표 쪽은 머리글이 「■ 법령명 [별표 1] …」이라 ■ 가 앞에 붙는다. 그대로
     * 견주면 공통 앞부분이 첫 글자에서 깨져 이름을 못 얻는다 — 「의약품 등의
     * 안전에 관한 규칙」 71쪽이 이것 때문에 머리글이 안 지워졌고, 그 바람에
     * 「…규칙 제39조(…)」가 인용으로 오인되어 **조문 7개가 통째로 사라졌다.** */
    var tail=ms.map(function(i){ return t.slice(i,i+80).replace(/^\s*■\s*/,""); })
               .filter(function(s){ return s.trim().length>=2; });
    var n=0, same=tail.length>=2;
    while(same&&n<80){
      var c=tail[0].charAt(n); if(!c) break;
      for(var k=1;k<tail.length;k++){ if(tail[k].charAt(n)!==c){ same=false; break; } }
      if(same) n++;
    }
    var nm=tail[0].slice(0,n).replace(/\S*$/,"").trim();   /* 낱말 한복판에서 끊지 않는다 */
    /* **네 글자 이상을 요구했더니 「약사법」(세 글자)이 걸러졌다.** 그래서 약사법
     * 87쪽 전부에서 머리글이 안 지워지고 조문 끝에 「약사법」이 붙었다.
     * 두 글자부터 받되 글자로 시작하는 것만 — 숫자·기호로 시작하면 이름이 아니다. */
    if(nm.length>=2&&/^[가-힣A-Za-z]/.test(nm)){
      var e=reEsc(nm).replace(/\s+/g,"\\s+");
      /* **꼬리말과 머리글은 서로 다른 쪽에 있다.** 「법제처 N 국가법령정보센터」는
       * 앞 쪽 **끝**에 찍히고, 법령 이름은 다음 쪽 **첫머리**에 찍힌다. 둘을 한
       * 덩어리로만 지우면 쪽마다 손질할 때 이름이 영영 안 지워진다 —
       * 「…살균 · 살충 및 이와 유사한 용도로 사용되는 제제 **약사법**」처럼
       * 원문에 없는 글자가 조문 끝에 붙었다.
       * 그래서 **쪽 첫머리에 이름만 오는 것**도 함께 지운다. 손질은 쪽마다 하므로
       * ^ 는 곧 쪽의 시작이다. 실측: 약사법 87/87쪽 · 첨단재생 27/27 · 규칙 71 ·
       * 시설기준령 6/6 · 생물학적제제 45 · GMP규정 5. 지침서는 0쪽(머리글이 없다). */
      return new RegExp("(?:"+LAWHEAD_RE.source+"(?:■?\\s*"+e+"\\s*)?|^\\s*■?\\s*"+e+"\\s+)","g");
    }
  }
  return LAWHEAD_RE;
}

/* 쪽 가운데 아래에 찍히는 쪽 번호(- 15 -). 쪽을 이어 붙이면 문장에 낀다.
 * 문서 6개에 304개. 줄 첫머리에 있는 것만 지워 본문의 뺄셈과 섞이지 않게 한다. */
var PAGENO_RE=/(^|\n)[ \t]*[-–—][ \t]*\d{1,4}[ \t]*[-–—][ \t]*/g;
/* 쪽 번호가 **쪽 맨 아래**에 찍힌 문서는 위 규칙에 안 걸린다 — 이어 붙이면
 * 줄 첫머리가 아니라 글 끝에 오기 때문이다. 「… 동영상 촬영본 제출 - 12 -」가
 * 그대로 민원 답변에 복사됐다. 손질은 쪽마다 하므로 **글 끝의 것 하나**만 턴다. */
var PAGENO_END_RE=/[ \t]*[-–—][ \t]*\d{1,4}[ \t]*[-–—][ \t]*$/;

/* 글머리표는 두 가지로 쓰인다. 지침서에서는 「○ 세포·미생물의 저장시설」처럼
 * 소제목을 열고(문서 10개에 22개), 서식에서는 「총 명 ⬛ 교육 명」처럼 표 칸을
 * 가른다(83개). 앞이 문장 끝이면 소제목이니 줄을 바꾼다 — 안 바꾸면 지침서가
 * 2천 자짜리 한 덩어리가 되어 못 읽는다. */
function bullets(t){
  return t.replace(/([.?!])\s*·\s*(?=[가-힣])/g,"$1\n· ");
}
/* PDF에서 뽑으면 문장부호 앞뒤에 빈칸이 낀다 — 「한다 .」 「미생물 , 균주」
 * 「( level )」 「제 5 조 )」. 문서 10개에 31,114곳이라 글을 읽기가 힘들다.
 * **글자는 하나도 안 지우고 빈칸만 없앤다.** 낱말을 붙이는 것(「보 관」→「보관」)과
 * 달리 뜻이 바뀔 여지가 없고, 검색어에 문장부호가 들어갈 일도 없다.
 * 숫자 사이 빈칸(제 6 조 · 2 년)은 건드리지 않는다 — 그건 낱말 붙이기와 같아 위험하다.
 * 줄바꿈은 건드리지 않으므로(`[ \t]`만 본다) 글머리표 줄이 도로 붙지 않는다. */
function tidyPunct(t){
  return t.replace(/[ \t]+([,.?!;:])/g,"$1")
          .replace(/([(\[{「『‘“])[ \t]+/g,"$1")
          .replace(/[ \t]+([)\]}」』’”])/g,"$1")
          /* 아래아점(ㆍ)·나카구로(・)는 「세포 ㆍ 미생물」처럼 벌어져 나온다.
           * 글머리표로 쓰는 가운뎃점(·, U+00B7)은 건드리지 않는다 — 그건 줄을
           * 여는 표시라 뒤에 빈칸이 있어야 한다. */
          .replace(/[ \t]*([ㆍ・])[ \t]*/g,"$1");
}

/* **발행처에 기대지 않는 머리글 지우개.** 「법제처 N 국가법령정보센터」가 없는
 * 식약처 고시는 이름을 알아낼 실마리가 없어 머리글이 그대로 남았고, 그 바람에
 * 「…규정 제7조(심사자료의 요건)」이 인용으로 오인돼 조가 통째로 사라졌다.
 * **법령 이름은 이미 알고 있으니 추측할 필요가 없다** — 그걸로 바로 지운다.
 * (실측: 생물학적제제 고시 259쪽 중 45쪽이 이름으로 시작. 「쪽마다 반복되는
 *  앞부분」으로 알아내려면 6할 문턱을 못 넘어 못 잡는다.) */
function nameHeadRe(name){
  /* 파일 이름은 「약사법(법률)(제21109호)(20260621).pdf」꼴이라 괄호 묶음이
   * 여럿 붙는다. 하나만 떼면 「약사법(법률)(제21109호)」가 남는다 — 다 뗀다. */
  /* **파일 이름은 NFD(자모 분리)다.** 맥·아이패드가 그렇게 만든다. 쪽 글자는
   * nfc() 로 맞춰 두었으므로 이름도 맞춰야 글자 비교가 된다 — 안 그러면
   * 눈에는 똑같은데 하나도 안 맞아 머리글이 그대로 남는다. */
  var nm=nfc(String(name||"")).replace(/\.(pdf|docx?)$/i,"").trim();
  for(var k=0;k<6;k++){
    var m2=nm.replace(/\s*[\[(（][^\[\]()（）]*[\])）]\s*$/,"").trim();
    if(m2===nm) break; nm=m2;
  }
  if(nm.length<4) return null;
  try{ return new RegExp("^\\s*■?\\s*"+reEsc(nm).replace(/\s+/g,"\\s+")+"\\s+","g"); }
  catch(e){ return null; }
}

function cleanPdfText(t,hre){
  t=nfc(t);
  /* 지우개를 여럿 받는다 — 「법제처…센터+이름」과 「이름만」을 함께 쓴다 */
  var hs=(hre&&hre.length!=null)?hre:[hre||runHeadRe(t)];
  hs.forEach(function(rx){ if(rx) t=t.replace(rx," "); });
  t=t.replace(PAGENO_RE,"$1").replace(PAGENO_END_RE,"").replace(PUA_RE," · ");
  t=t.replace(BULLET_M0,"$1· ");
  try{ t=t.replace(BULLET_M," · "); }catch(e){}   /* 구형 사파리는 뒤돌아보기를 못 쓴다 */
  return tidyPunct(bullets(t));
}

function nfc(t){
  t=String(t==null?"":t);
  try{ return t.normalize?t.normalize("NFC"):t; }catch(e){ return t; }
}

/* 법 위계. 숫자가 작을수록 위다.
 * **파일 이름의 괄호 묶음에만 기대면 이름을 바꿔 올린 문서가 죄다 「그 밖」이 된다**
 * (「외품허신」이 그랬다). 괄호를 떼고 **이름 끝말**로도 가른다.
 *   …법 / …법률          → 법률
 *   …시행령 / …령         → 시행령       (시설기준령)
 *   …규칙                → 시행규칙
 *   고시·훈령·예규·공고 / …규정 / …기준 / 약전 → 행정규칙(고시)
 *   지침·안내서·절차·가이드·해설·질의응답    → 지침·안내서
 *   PIC/S·ICH·WHO·USP·EP·JP·ISO·EU GMP   → 국제기준 (우리 법령이 아니다)
 * 국제기준은 지침보다 아래에 둔다 — 민원 답변의 근거로는 국내 법령이 먼저다.
 * 「그 밖」은 이 중 어느 것도 아닌 문서다. 되도록 안 생기게 하는 것이 목표. */
var LAW_KINDS=[
  {n:0,t:"법률",   re:/\(법률\)|법률\s*제\s*\d|(?:^|\s)[^\s]*법$|법률$/},
  {n:1,t:"시행령", re:/\(대통령령\)|시행령$|령$/},
  {n:2,t:"시행규칙",re:/\(총리령\)|\(부령\)|규칙$/},
  {n:5,t:"국제기준",re:/PIC\/?S|\bICH\b|\bWHO\b|\bUSP\b|\bEP\b|\bJP\b|\bISO\b|EU\s*GMP|\bFDA\b/i},
  {n:3,t:"고시",   re:/고시|훈령|예규|공고|규정$|기준$|약전/},
  {n:4,t:"지침·안내서",re:/지침|안내서|절차|가이드|해설|매뉴얼|업무처리방안|질의응답|Q\s*&\s*A/i}
];
function lawKind(name){
  var s=nfc(name).replace(/\.(pdf|docx?)$/i,"").trim();
  /* 괄호 묶음을 떼고 이름만 남긴다 — 「약사법(법률)(제21109호)(20260621)」 */
  var bare=s;
  for(var k=0;k<6;k++){
    var b2=bare.replace(/\s*[\[(（][^\[\]()（）]*[\])）]\s*$/,"").trim();
    if(b2===bare) break; bare=b2;
  }
  for(var i=0;i<LAW_KINDS.length;i++){
    if(LAW_KINDS[i].re.test(s)||LAW_KINDS[i].re.test(bare)) return LAW_KINDS[i];
  }
  return {n:6,t:"그 밖"};
}
/* 위계 → 이름 순. 같은 종류끼리 모이고, 상위법이 위로 온다.
 * 반드시 <b>원본 파일 이름</b>으로 가른다 — 화면 이름은 「(식품의약품안전처고시)」
 * 같은 괄호 묶음을 떼어 짧게 다듬으므로, 그걸로 재면 고시가 「그 밖」이 된다.
 * 실제로 이름을 다듬은 뒤 고시 두 개가 목록 맨 아래로 밀려났었다. */
function lawSorted(){
  return S.laws.slice().sort(function(a,b){
    var ka=lawKindOf(a).n, kb=lawKindOf(b).n;
    return ka-kb || String(a.name).localeCompare(String(b.name),"ko");
  });
}

function lawBuildAll(all){
  if(lawBusy) return;
  var todo=all?S.laws.slice():S.laws.filter(function(l){ return !l.arts; });
  if(!todo.length){ showToast("모두 조문이 만들어져 있어요."); return; }
  if(all&&!confirm("올려둔 법령 "+todo.length+"개의 조문을 모두 다시 만듭니다.\n\n"
    +"쪼개는 방식이 바뀌었을 때 한 번 돌리면 됩니다. 문서가 크면 몇 분 걸려요. 계속할까요?")) return;
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
  if(l.src==="api") return lawApiImport(l).then(function(){});   /* 법제처 판은 다시 받는다 */
  var fresh=null;
  return Promise.resolve(lawPagesForReindex(l)).then(function(fp){
    fresh=fp;
    if(fresh&&fresh.length) return {data:null};
    return withAuthRetry(function(){
      return sb.from("law_pages").select("id,law_id,page,content").eq("law_id",l.id).order("page");
    });
  }).then(function(res){
    if(res&&res.error) throw new Error(res.error.message);
    var isNew=!!(fresh&&fresh.length), rows;
    if(isNew) rows=fresh.map(function(p){ return {law_id:l.id,page:p.page,content:p.content,tbl:!!p.tbl}; });
    else rows=(res&&res.data)||[];
    if(!rows.length) throw new Error("쪽 없음");
    cleanPages(rows,lawSrc(l));
    var carry="";
    rows.forEach(function(r){
      r.article=carry||null;
      var a=findArticles(r.content||"");
      if(a.length) carry=a[a.length-1].label;
    });
    var m2=lawMeta(rows);
    if(m2.kind!==l.kind||m2.eff!==l.eff){
      l.kind=m2.kind; l.eff=m2.eff;
      dbUpdate("laws",l.id,{kind:m2.kind,eff:m2.eff});
    }
    var arts=buildLawArticles(rows,lawSrc(l),m2.kind);
    if(!arts.length) throw new Error("조문 없음");
    return savePageRows(l.id,rows,isNew,false)
      .then(function(){ return saveLawArticles(l.id,arts,l); });
  });
}

/* ========== 법제처 OPEN API 로 법령 받기 ==========================================
 * 법령·고시는 PDF 를 올리는 대신 **법제처에서 바로 받는다.** 개정되면 「조문 다시
 * 만들기」 한 번으로 최신판이 따라오고, 별표의 표도 격자 그대로 읽을 수 있다.
 * 지침서·안내서는 법제처에 없으므로 여전히 PDF 다 (투트랙).
 *
 * 흐름은 PDF 와 같다 — 글자를 뽑아 「쪽」을 만들고 buildLawArticles() 에 넣는다.
 * 그래야 라벨(제N조(제목) · 별표 N(제목) · 부칙 제N조 · 시행예정 표시)이 PDF 판과
 * 똑같이 나온다. 조문 id 는 새로 생기지만 답변 기록은 이름+조 번호라 안전하다.
 *
 * 브라우저는 law.go.kr 을 직접 못 부른다(CORS · OC 노출). Edge Function `law-fetch` 가
 * 대신 불러 준다 — AI 를 안 쓰므로 돈이 안 든다.
 *
 * **「현행」 본문은 eflaw 로 받아야 한다.** target=law 로 받으면 시행예정판이 온다
 * (약사법은 2026-11-12 판) — 아직 시행 안 된 조문을 현행으로 보여주게 된다.
 * 시행예정 조문은 따로 받아 「· 시행 2026. 11. 12.」 라벨로 붙인다 (PDF 판과 같은 꼴). */

var API_KINDS={"법률":1,"대통령령":1,"총리령":1,"부령":1,"고시":1,"훈령":1,"예규":1};
/* 법제처에서 받을 수 있는 종류인가 (지침서는 아니다) */
function lawIsApiable(l){ return !!(l&&l.kind&&API_KINDS[l.kind]); }
function lawIsAdmrul(kind){ return kind==="고시"||kind==="훈령"||kind==="예규"||kind==="공고"; }
function lawBare(s){ return nfc(s||"").replace(/[\s·ㆍ・]/g,""); }
function todayKey(){ return keyOf(new Date()).replace(/-/g,""); }
function lawDateDots(d){ d=String(d||""); return d.length<8?d:(d.slice(0,4)+". "+(+d.slice(4,6))+". "+(+d.slice(6,8))+"."); }
function arr(x){ return x==null?[]:(Array.isArray(x)?x:[x]); }
/* 중첩된 배열·객체에서 글자만 차례로 모은다 (별표내용은 [[줄,줄],[줄]] 꼴이다) */
function flatStr(x,out){
  out=out||[];
  if(typeof x==="string") out.push(x);
  else if(Array.isArray(x)) x.forEach(function(y){ flatStr(y,out); });
  else if(x&&typeof x==="object") Object.keys(x).forEach(function(k){ flatStr(x[k],out); });
  return out;
}
function lawSiteUrl(l){
  var nm=encodeURIComponent(nfc(l.name||""));
  return l.target==="admrul"?"https://www.law.go.kr/행정규칙/"+nm:"https://www.law.go.kr/법령/"+nm;
}

function lawApiCall(body){
  return sb.functions.invoke("law-fetch",{body:body}).then(function(r){
    var d=r&&r.data;
    if(!d) throw new Error("법제처를 부르지 못했어요: "+((r&&r.error&&r.error.message)||"응답이 비었어요"));
    if(d.error) throw new Error(d.error);
    return d;
  });
}
/* 이름으로 찾는다. 법령(eflaw)에 없으면 행정규칙(admrul)도 본다.
 * 돌려주는 것: {admrul, rows:[{name,mst,eff,status,kind,code}]} — 이름이 정확히 같은 것만 */
function lawApiLocate(name,kind){
  var order=kind?[lawIsAdmrul(kind)]:[false,true];
  function tryOne(i){
    if(i>=order.length) return Promise.reject(new Error("법제처에서 「"+name+"」을(를) 못 찾았어요. 법제처에 적힌 이름 그대로인지 확인해 주세요."));
    var admrul=order[i];
    return lawApiCall({op:"search",target:admrul?"admrul":"eflaw",q:name}).then(function(d){
      var rows=(d.rows||[]).filter(function(r){ return lawBare(r.name)===lawBare(name); });
      if(!rows.length) return tryOne(i+1);
      return {admrul:admrul,rows:rows};
    });
  }
  return tryOne(0);
}
/* 법제처의 종류 이름을 앱의 kind 로 — 「보건복지부령」은 부령이다 */
function apiKindOf(k,admrul){
  k=nfc(k||"");
  if(admrul) return (/^(고시|훈령|예규|공고)$/.test(k))?k:"고시";
  if(k==="법률"||k==="대통령령"||k==="총리령") return k;
  if(/령$/.test(k)) return "부령";
  return "법률";
}

/* ---------- 본문 JSON → 「쪽」 ---------- */
/* 법령(법률·령·규칙): 조문단위가 조 → 항 → 호 → 목으로 나뉘어 온다. 줄마다 들여쓴다. */
function apiArtKey(a){ return "제"+a["조문번호"]+"조"+(a["조문가지번호"]?"의"+a["조문가지번호"]:""); }
function apiArtText(a){
  var lines=[], head=flatStr(a["조문내용"]).join(" ").replace(/\s+/g," ").trim();
  head=nfc(head);
  var hang=arr(a["항"]);
  if(/^제\d+조(의\d+)?삭제/.test(head.replace(/\s+/g,""))&&!hang.length) return "";
  if(head) lines.push(head);
  hang.forEach(function(h){
    if(typeof h==="string"){ lines.push("  "+nfc(h).trim()); return; }
    flatStr(h["항내용"]).forEach(function(x){ lines.push("  "+nfc(x).trim()); });
    arr(h["호"]).forEach(function(ho){
      if(typeof ho==="string"){ lines.push("    "+nfc(ho).trim()); return; }
      flatStr(ho["호내용"]).forEach(function(x){ lines.push("    "+nfc(x).trim()); });
      arr(ho["목"]).forEach(function(mo){
        flatStr(typeof mo==="string"?mo:mo["목내용"]).forEach(function(x){ lines.push("      "+nfc(x).trim()); });
      });
    });
  });
  return lines.join("\n");
}
function apiLawPages(doc){
  var pages=[], map={};
  arr(doc["조문"]&&doc["조문"]["조문단위"]).forEach(function(a){
    if(!a||typeof a!=="object"||a["조문여부"]!=="조문") return;   /* 「전문」은 장·절 제목이다 */
    var t=apiArtText(a); if(!t) return;
    var k=apiArtKey(a);
    map[k]=(map[k]?map[k]+"\n":"")+t;
    pages.push({text:t});
  });
  return {pages:pages,map:map};
}
/* 행정규칙(고시): 조 하나가 한 줄이고 항·호가 붙어 온다(「…말한다.1. 다음의…」).
 * 항(①)·호(1.)·목(가.) 앞에서 줄을 끊어야 화면 층이 산다. */
function admrulBreaks(t){
  return t.replace(/\s*([①-⑳])/g,"\n$1")
          .replace(/([.)\]」』])\s*(\d{1,2}\.\s)/g,"$1\n$2")
          .replace(/([.)\]」』])\s*([가-힣]\.\s)/g,"$1\n$2");
}
function apiAdmrulPages(doc){
  var pages=[];
  flatStr(doc["조문내용"]).forEach(function(l){
    l=nfc(l).trim(); if(!l) return;
    var b=l.replace(/\s+/g,"");
    if(/^제\d+(장|절|편)/.test(b)&&l.length<40) return;     /* 장·절 제목 */
    if(!/^제\d+조/.test(b)){ if(pages.length) pages[pages.length-1].text+="\n"+l; return; }
    pages.push({text:admrulBreaks(l)});
  });
  return pages;
}
/* 부칙 — 가장 최근 것 하나만. 「부칙 <제N호,날짜>」 머리말이 첫 줄이라 buildLawArticles 가
 * 「부칙 제1조(시행일)」로 라벨을 붙인다(PDF 판과 같다). */
function apiBuchikPages(doc){
  var bu=doc["부칙"]||{}, units=arr(bu["부칙단위"]);
  /* 행정규칙(고시)은 부칙단위가 없고 부칙공포일자[]·부칙내용[] 두 배열이 나란히 온다.
   * 마지막 것이 최근이다. 조가 「…시행한다.제2조(…)」처럼 붙어 있어 조 앞에서 끊는다. */
  if(!units.length&&bu["부칙내용"]!=null){
    var ds=arr(bu["부칙공포일자"]), cs=arr(bu["부칙내용"]);
    var bi=-1, bd="";
    cs.forEach(function(c,i){ var d=String(ds[i]||""); if(bi<0||d>=bd){ bi=i; bd=d; } });
    if(bi>=0){
      var t=flatStr(cs[bi]).map(function(x){ return nfc(x).trim(); }).filter(Boolean).join("\n")
        .replace(/\s*(제\d+조(?:의\d+)?\s*\()/g,"\n$1");
      units=[{"부칙공포일자":bd,"부칙내용":admrulBreaks(t)}];
    }
  }
  if(!units.length) return [];
  var best=null;
  units.forEach(function(u){ var d=String(u["부칙공포일자"]||u["부칙발령일자"]||""); if(!best||d>String(best["부칙공포일자"]||best["부칙발령일자"]||"")) best=u; });
  var lines=flatStr(best["부칙내용"]).join("\n").split("\n").map(function(x){ return nfc(x).trim(); }).filter(Boolean);
  if(!lines.length) return [];
  if(!/^부\s*칙/.test(lines[0])) lines.unshift("부칙 <"+String(best["부칙공포일자"]||best["부칙발령일자"]||"")+">");
  /* 조가 없는 부칙(「이 규칙은 공포한 날부터 시행한다」)은 머리말이 없어 앞 조 꼬리에 붙는다 — 넣지 않는다 */
  if(!lines.some(function(l){ return /^제\d+조(의\d+)?\s*\(/.test(l); })) return [];
  return [{text:lines.join("\n")}];
}

/* ---------- 표(격자) 글자 꼴 ----------
 * 표는 글자 속에 「┃칸│칸│칸┨」 한 줄로 넣는다. 공백 손질(\s+→" ")을 견디고, 법령 글에
 * 안 쓰는 기호라 검색·복사·AI 는 그대로 글자로 보고 화면만 표로 그린다. */
var GR="┃", GC="│", GE="┨";
var GRID_ROW_RE=/┃([^┃┨]*)┨/g;
function gridRowText(cells){
  return GR+cells.map(function(c){ return String(c||"").replace(/[┃│┨]/g," ").replace(/\s+/g," ").trim(); }).join(GC)+GE;
}
function gridCells(s){ return String(s||"").split(GC).map(function(c){ return c.trim(); }); }
/* 글자 → [{text} | {rows:[[칸]]}] */
function gridSplit(text){
  text=String(text||"");
  if(text.indexOf(GR)<0) return [{text:text}];
  var out=[], rows=[], pos=0, m;
  GRID_ROW_RE.lastIndex=0;
  while((m=GRID_ROW_RE.exec(text))!==null){
    var gap=text.slice(pos,m.index);
    if(gap.trim()){ if(rows.length){ out.push({rows:rows}); rows=[]; } out.push({text:gap}); }
    rows.push(gridCells(m[1]));
    pos=m.index+m[0].length;
  }
  if(rows.length) out.push({rows:rows});
  var tail=text.slice(pos);
  if(tail.trim()) out.push({text:tail});
  return out;
}
function gridHtml(rows,q){
  var terms=Array.isArray(q)?q:(q?[q]:[]);
  return '<div class="lv-gridwrap"><table class="lv-grid">'
    + rows.map(function(r,i){
        var tag=i===0?"th":"td";
        return '<tr>'+r.map(function(c){ return '<'+tag+'>'+markTerms(c,terms)+'</'+tag+'>'; }).join("")+'</tr>';
      }).join("")
    + '</table></div>';
}
/* 표를 알아보고 그린다 — 조 전체 보기·쪽 보기가 같이 쓴다 */
function gridAwareHtml(text,q){
  var html="", lv=0;
  gridSplit(text).forEach(function(s){
    if(s.rows){ html+=gridHtml(s.rows,q); return; }
    var r=formatLawSeg(s.text,q,lv); html+=r.html; lv=r.lv;
  });
  return html;
}
/* 복사·저장용 평문 — 표 한 줄은 「칸 | 칸 | 칸」 */
function gridRowsPlain(rows){ return rows.map(function(r){ return r.join(" | "); }).join("\n"); }
/* 자름점(at) 가운데 표 줄 안에 떨어진 것을 뺀다 */
function gridSafe(raw,subs){
  if(!subs||!subs.length||raw.indexOf(GR)<0) return subs||[];
  var rows=gridRowsInfo(raw);
  return subs.filter(function(sb){
    for(var i=0;i<rows.length;i++) if(sb.at>rows[i].st&&sb.at<rows[i].en) return false;
    return true;
  });
}
/* 글자 안의 표 줄 자리 — 검색 결과에서 「그 줄 전체」를 발췌로 쓰기 위해 */
function gridRowsInfo(c){
  if(c.indexOf(GR)<0) return [];
  var out=[], m, prevEnd=-1, head=null;
  GRID_ROW_RE.lastIndex=0;
  while((m=GRID_ROW_RE.exec(c))!==null){
    var cells=gridCells(m[1]);
    /* 앞 줄과 사이에 글자가 있으면 다른 표다 — 머리 줄을 새로 잡는다 */
    if(prevEnd<0||c.slice(prevEnd,m.index).trim()) head=null;
    out.push({st:m.index,en:m.index+m[0].length,cells:cells,head:head});
    if(!head) head=cells;
    prevEnd=m.index+m[0].length;
  }
  return out;
}

/* ---------- 별표 파일(hwp·hwpx) → 문단·표 ----------
 * 법제처 별표 본문 JSON 은 표의 칸이 풀려 못 쓴다. 파일에는 격자가 그대로 있다.
 * 고시 별표는 .hwpx(zip 안 XML), 법령 별표는 구형 .hwp(CFB)다.
 * 돌려주는 것: [{p:"문단"} | {tstart:true} | {row:[칸], head:bool}] */
/* **압축은 직접 푼다.** DecompressionStream("deflate-raw") 은 hwp 스트림 끝의 꼬리 바이트를
 * 오류로 보고 「Failed to fetch」를 낸다(파이썬 zlib 은 그냥 풀린다). 구형 사파리에는 아예 없다.
 * deflate 는 150줄이면 된다 — puff 의 알고리즘 그대로다. */
var INF_LBASE=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var INF_LEXT=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
var INF_DBASE=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var INF_DEXT=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
var INF_CLORDER=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
var INF_FIXED=null;
function inflateRawSync(src){
  var pos=0, bitBuf=0, bitCnt=0, i;
  function bits(n){
    while(bitCnt<n){ if(pos>=src.length) throw new Error("압축 자료가 중간에서 끝났어요"); bitBuf|=src[pos++]<<bitCnt; bitCnt+=8; }
    var v=bitBuf&((1<<n)-1); bitBuf>>>=n; bitCnt-=n; return v;
  }
  function tree(lengths,n){
    var t={count:new Uint16Array(16),symbol:new Uint16Array(n)}, offs=new Uint16Array(16), k;
    for(k=0;k<n;k++) t.count[lengths[k]]++;
    t.count[0]=0;
    for(k=1;k<16;k++) offs[k]=offs[k-1]+t.count[k-1];
    for(k=0;k<n;k++) if(lengths[k]) t.symbol[offs[lengths[k]]++]=k;
    return t;
  }
  function decode(t){
    var code=0, first=0, index=0;
    for(var len=1;len<16;len++){
      code|=bits(1);
      var count=t.count[len];
      if(code-count<first) return t.symbol[index+(code-first)];
      index+=count; first+=count; first<<=1; code<<=1;
    }
    throw new Error("압축 부호가 이상해요");
  }
  var buf=new Uint8Array(Math.max(4096,src.length*4)), n=0;
  function put(b){ if(n>=buf.length){ var nb=new Uint8Array(buf.length*2); nb.set(buf); buf=nb; } buf[n++]=b; }
  for(;;){
    var last=bits(1), type=bits(2);
    if(type===0){
      bitBuf=0; bitCnt=0;
      var len=src[pos]|(src[pos+1]<<8); pos+=4;
      for(i=0;i<len;i++) put(src[pos++]);
    } else {
      var lt, dt;
      if(type===1){
        if(!INF_FIXED){
          var fl=new Uint8Array(288); for(i=0;i<144;i++) fl[i]=8; for(;i<256;i++) fl[i]=9; for(;i<280;i++) fl[i]=7; for(;i<288;i++) fl[i]=8;
          var fd=new Uint8Array(30); for(i=0;i<30;i++) fd[i]=5;
          INF_FIXED={l:tree(fl,288),d:tree(fd,30)};
        }
        lt=INF_FIXED.l; dt=INF_FIXED.d;
      } else if(type===2){
        var hlit=bits(5)+257, hdist=bits(5)+1, hclen=bits(4)+4, cl=new Uint8Array(19);
        for(i=0;i<hclen;i++) cl[INF_CLORDER[i]]=bits(3);
        var ct=tree(cl,19), lens=new Uint8Array(hlit+hdist);
        for(i=0;i<hlit+hdist;){
          var sym=decode(ct), r;
          if(sym<16) lens[i++]=sym;
          else if(sym===16){ var prev=i?lens[i-1]:0; r=3+bits(2); while(r--) lens[i++]=prev; }
          else if(sym===17){ r=3+bits(3); while(r--) lens[i++]=0; }
          else { r=11+bits(7); while(r--) lens[i++]=0; }
        }
        lt=tree(lens.subarray(0,hlit),hlit); dt=tree(lens.subarray(hlit),hdist);
      } else throw new Error("압축 블록 종류가 이상해요");
      for(;;){
        var s=decode(lt);
        if(s<256){ put(s); continue; }
        if(s===256) break;
        s-=257;
        var length=INF_LBASE[s]+bits(INF_LEXT[s]), ds=decode(dt), dist=INF_DBASE[ds]+bits(INF_DEXT[ds]);
        for(i=0;i<length;i++) put(buf[n-dist]);
      }
    }
    if(last) break;
  }
  return buf.subarray(0,n);
}
function inflateRaw(u8){
  try{ return Promise.resolve(inflateRawSync(u8)); }catch(e){ return Promise.reject(e); }
}
function b64Bytes(b64){
  var bin=atob(b64), out=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
/* 표 하나 → 줄 목록. 폭 전체를 병합한 칸 하나짜리 줄은 제목·일반기준이므로 문단으로 돌린다.
 * 머리 줄: 첫 줄, 그리고 첫 칸이 빈 채로 이어지는 줄들(「│ │ 1차 │ 2차 │」). */
function tableItems(nr,nc,cells,out){
  var grid=[], i, j, full={};
  for(i=0;i<nr;i++){ var row=[]; for(j=0;j<nc;j++) row.push(""); grid.push(row); }
  cells.forEach(function(c){
    if(c.r>=nr||c.c>=nc) return;
    grid[c.r][c.c]=c.t.join(" ").replace(/\s+/g," ").trim();
    if(c.cs>=nc) full[c.r]=1;
  });
  out.push({tstart:true});
  var started=false, head=true;
  for(i=0;i<nr;i++){
    var r=grid[i], ne=r.filter(function(x){ return x; });
    if(!ne.length) continue;
    if(ne.length===1&&full[i]){ out.push({p:ne[0]}); continue; }
    if(head&&(!started||!r[0])){ out.push({row:r,head:true}); started=true; continue; }
    head=false; out.push({row:r});
  }
  return out;
}
/* --- 구형 hwp: CFB(복합 문서) 읽기 --- */
function cfbOpen(buf){
  var dv=new DataView(buf), u8=new Uint8Array(buf);
  if(u8[0]!==0xD0||u8[1]!==0xCF||u8[2]!==0x11||u8[3]!==0xE0) throw new Error("hwp 형식이 아니에요");
  var ss=1<<dv.getUint16(30,true), ms=1<<dv.getUint16(32,true), perSec=ss/4;
  var dirStart=dv.getUint32(48,true), cutoff=dv.getUint32(56,true);
  var miniStart=dv.getUint32(60,true), difatStart=dv.getUint32(68,true), nDifat=dv.getUint32(72,true);
  var FREE=0xFFFFFFFE, difat=[], i, j;
  for(i=0;i<109;i++){ var v=dv.getUint32(76+i*4,true); if(v<FREE) difat.push(v); }
  var ds=difatStart, g=0;
  while(ds<FREE&&g++<=nDifat){
    var off=(ds+1)*ss;
    for(j=0;j<perSec-1;j++){ var w=dv.getUint32(off+j*4,true); if(w<FREE) difat.push(w); }
    ds=dv.getUint32(off+(perSec-1)*4,true);
  }
  var fat=[];
  difat.forEach(function(sec){ var o=(sec+1)*ss; for(j=0;j<perSec;j++) fat.push(dv.getUint32(o+j*4,true)); });
  function chain(start,table){ var out=[], s=start, n=0; while(s<FREE&&n++<200000){ out.push(s); s=table[s]; if(s===undefined) break; } return out; }
  function readChain(start,size){
    var secs=chain(start,fat), out=new Uint8Array(size), p=0;
    for(i=0;i<secs.length&&p<size;i++){ var o=(secs[i]+1)*ss, n=Math.min(ss,size-p); out.set(u8.subarray(o,o+n),p); p+=n; }
    return out;
  }
  var entries=[];
  chain(dirStart,fat).forEach(function(sec){
    var o0=(sec+1)*ss;
    for(var e=0;e<ss/128;e++){
      var o=o0+e*128, nl=dv.getUint16(o+64,true);
      if(!nl){ entries.push(null); continue; }
      var name=""; for(var k=0;k<nl/2-1;k++) name+=String.fromCharCode(dv.getUint16(o+k*2,true));
      entries.push({name:name,type:u8[o+66],left:dv.getUint32(o+68,true),right:dv.getUint32(o+72,true),
                    child:dv.getUint32(o+76,true),start:dv.getUint32(o+116,true),size:dv.getUint32(o+120,true)});
    }
  });
  var root=entries[0]; if(!root) throw new Error("hwp 목록이 비었어요");
  var miniFat=[];
  chain(miniStart,fat).forEach(function(sec){ var o=(sec+1)*ss; for(j=0;j<perSec;j++) miniFat.push(dv.getUint32(o+j*4,true)); });
  var miniData=readChain(root.start,root.size);
  function read(en){
    if(en.size<cutoff){
      var secs=chain(en.start,miniFat), out=new Uint8Array(en.size), p=0;
      for(i=0;i<secs.length&&p<en.size;i++){ var o=secs[i]*ms, n=Math.min(ms,en.size-p); out.set(miniData.subarray(o,o+n),p); p+=n; }
      return out;
    }
    return readChain(en.start,en.size);
  }
  function kids(id,out,depth){
    if(id>=FREE||!entries[id]||depth>64) return out;
    var e=entries[id]; kids(e.left,out,depth+1); out.push(e); kids(e.right,out,depth+1); return out;
  }
  return { top:kids(root.child,[],0), kids:function(en){ return kids(en.child,[],0); }, read:read };
}
/* PARA_TEXT 안의 제어 문자. 1~3·11·12·14~18·21~23 은 8글자(16바이트)를 차지하는 확장 제어,
 * 4~9·19·20 도 8글자짜리 인라인 제어다. 그냥 읽으면 「捤獥 汤捯」 같은 쓰레기가 낀다. */
var HWP_CTRL8={1:1,2:1,3:1,4:1,5:1,6:1,7:1,8:1,9:1,11:1,12:1,14:1,15:1,16:1,17:1,18:1,19:1,20:1,21:1,22:1,23:1};
function hwpText(dv){
  var out="", n=dv.byteLength>>1, i=0;
  while(i<n){
    var c=dv.getUint16(i*2,true);
    if(HWP_CTRL8[c]){ i+=8; continue; }
    if(c===13||c===10) out+="\n";
    else if(c>=32) out+=String.fromCharCode(c);
    i++;
  }
  return out;
}
function hwpSectionItems(data,out){
  var dv=new DataView(data.buffer,data.byteOffset,data.byteLength), pos=0, tbl=null, cell=null, base=-1;
  while(pos+4<=data.byteLength){
    var h=dv.getUint32(pos,true), tag=h&0x3FF, lvl=(h>>10)&0x3FF, size=(h>>20)&0xFFF; pos+=4;
    if(size===0xFFF){ size=dv.getUint32(pos,true); pos+=4; }
    var len=Math.min(size,data.byteLength-pos);
    var body=new DataView(data.buffer,data.byteOffset+pos,len); pos+=size;
    if(tag===77&&len>=8){ tbl={nr:body.getUint16(4,true),nc:body.getUint16(6,true),cells:[]}; base=lvl; cell=null; continue; }
    if(tbl){
      if(tag===66&&lvl<base){ tableItems(tbl.nr,tbl.nc,tbl.cells,out); tbl=null; cell=null; base=-1; }
      else if(tag===72&&lvl===base&&len>=16){
        cell={c:body.getUint16(8,true),r:body.getUint16(10,true),cs:body.getUint16(12,true),rs:body.getUint16(14,true),t:[]};
        tbl.cells.push(cell); continue;
      }
      else if(tag===67&&cell){ cell.t.push(hwpText(body)); continue; }
      else continue;
    }
    if(tag===67) out.push({p:hwpText(body)});
  }
  if(tbl) tableItems(tbl.nr,tbl.nc,tbl.cells,out);
  return out;
}
function hwpItems(buf){
  var cfb=cfbOpen(buf), top=cfb.top, hdr=null, body=null;
  top.forEach(function(e){ if(e.name==="FileHeader") hdr=e; if(e.name==="BodyText") body=e; });
  if(!hdr||!body) throw new Error("hwp 안에 본문이 없어요");
  var flags=new DataView(cfb.read(hdr).buffer).getUint32(36,true);
  if(flags&2) throw new Error("암호가 걸린 hwp 예요");
  var secs=cfb.kids(body).filter(function(e){ return /^Section\d+$/.test(e.name); })
    .sort(function(a,b){ return parseInt(a.name.slice(7),10)-parseInt(b.name.slice(7),10); });
  var out=[], p=Promise.resolve();
  secs.forEach(function(e){
    p=p.then(function(){
      var raw=cfb.read(e);
      return (flags&1)?inflateRaw(raw):Promise.resolve(raw);
    }).then(function(data){ hwpSectionItems(data,out); });
  });
  return p.then(function(){ return out; });
}
/* --- hwpx: zip 안의 Contents/sectionN.xml --- */
function xmlUnesc(s){
  return String(s||"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#x([0-9a-fA-F]+);/g,function(m,h){ return String.fromCharCode(parseInt(h,16)); })
    .replace(/&#(\d+);/g,function(m,d){ return String.fromCharCode(+d); }).replace(/&amp;/g,"&");
}
/* <hp:t> 안에는 <hp:tab/>·<hp:lineBreak/> 같은 꼬리표가 섞여 있다 — 안 떼면 「<hp:tab width="4000" …/>」가
 * 본문에 그대로 새어 나온다(GMP 고시 별표 2의2 에서 실제로 그랬다). 탭·줄바꿈은 빈칸으로, 나머지는 뗀다. */
function hwpxParaText(p){
  var t=""; p.replace(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g,function(m,x){
    t+=xmlUnesc(x.replace(/<hp:(tab|lineBreak)\b[^>]*\/?>/g," ").replace(/<[^>]+>/g,"")); return ""; });
  return t;
}
function hwpxSectionItems(xml,out){
  var pos=0, m, re=/<hp:tbl\b[\s\S]*?<\/hp:tbl>/g;
  function paras(s){ (s.match(/<hp:p\b[\s\S]*?<\/hp:p>/g)||[]).forEach(function(p){ out.push({p:hwpxParaText(p)}); }); }
  while((m=re.exec(xml))!==null){
    paras(xml.slice(pos,m.index)); pos=m.index+m[0].length;
    var tb=m[0], nr=+(/rowCnt="(\d+)"/.exec(tb)||[0,0])[1], nc=+(/colCnt="(\d+)"/.exec(tb)||[0,0])[1], cells=[];
    (tb.match(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)||[]).forEach(function(tc){
      var ca=/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/.exec(tc), sp=/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/.exec(tc);
      var t=(tc.match(/<hp:p\b[\s\S]*?<\/hp:p>/g)||[]).map(hwpxParaText);
      cells.push({c:ca?+ca[1]:0,r:ca?+ca[2]:0,cs:sp?+sp[1]:1,rs:sp?+sp[2]:1,t:t});
    });
    if(nr&&nc) tableItems(nr,nc,cells,out);
  }
  paras(xml.slice(pos));
  return out;
}
function hwpxItems(buf){
  var out=[];
  function sec(i){
    return zipEntryText(buf,"Contents/section"+i+".xml").then(function(xml){ hwpxSectionItems(xml,out); return i<9?sec(i+1):out; },
      function(){ if(i===0) throw new Error("hwpx 안에 본문이 없어요"); return out; });
  }
  return sec(0);
}
function bylFileItems(bytes){
  var buf=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  if(bytes[0]===0x50&&bytes[1]===0x4B) return hwpxItems(buf);
  return hwpItems(buf);
}

/* ---------- 별표 → 쪽 ----------
 * 머리말은 「[별표 N] 제목」으로 만든다 — buildLawArticles 의 BP_RE 가 읽는 꼴이다.
 * 표가 길면 줄 단위로 토막 내고, 토막마다 머리 줄을 다시 붙여 어느 토막이든 표로 읽힌다.
 * 토막의 이름은 첫 자료 줄의 첫 칸이다(「1의2. 거짓이나 그 밖의…」). */
var BYL_CHUNK=4500, BYL_CHUNK_MAX=60;
function apiBylItemsPages(head,items){
  var pages=[], buf=[head], tlen=0, hdr=[], title="";
  function flush(){
    if(buf.length>1) pages.push({text:buf.join("\n"),title:title});
    buf=[head].concat(hdr.map(gridRowText)); tlen=0; title="";
  }
  items.forEach(function(it){
    if(it.tstart){ hdr=[]; tlen=0; return; }
    if(it.p!=null){ var t=it.p.replace(/\s+/g," ").trim(); if(t) buf.push(t); return; }
    var row=it.row, first=""; for(var i=0;i<row.length;i++){ if(row[i]){ first=row[i]; break; } }
    if(!first) return;
    var rt=gridRowText(row);
    if(it.head){ hdr.push(row); buf.push(rt); return; }
    /* **표 하나가** 길 때만 자른다 — 작은 표가 여럿인 글 별표는 소제목으로 나눈다(buildLawArticles) */
    if(tlen>BYL_CHUNK&&pages.length<BYL_CHUNK_MAX){ flush(); title=first.slice(0,24); }
    buf.push(rt); tlen+=rt.length;
  });
  flush();
  return pages;
}
/* JSON 별표내용(줄 목록)만으로 — 파일을 못 받았거나 서식일 때 */
function apiBylJsonPage(head,x){
  var lines=flatStr(x["별표내용"]).map(function(l){ return nfc(l).replace(/\s+/g," ").trim(); });
  /* 첫머리의 「■ … [별표 8] <개정 …>」 줄은 우리 머리말과 겹친다 — 뗀다 */
  var k=0; while(k<3&&k<lines.length&&/\[\s*별\s*[표지]/.test(lines[k])) k++;
  var body=lines.slice(k).filter(Boolean).join("\n");
  return body?{text:head+"\n"+body}:null;
}
function apiBylHead(x){
  var kind=x["별표구분"]||"별표", num=parseInt(x["별표번호"],10)||0, gaji=parseInt(x["별표가지번호"]||"0",10)||0;
  var title=nfc(x["별표제목"]||"").replace(/\s+/g," ").trim();
  var n=num+(gaji?"의"+gaji:"");
  return kind==="서식"?("[별지 제"+n+"호서식] "+title):("[별표 "+n+"] "+title);
}
function apiBylPages(doc,onStep){
  var units=arr(doc["별표"]&&doc["별표"]["별표단위"]), pages=[], p=Promise.resolve(), k=0, noInflate=false;
  units.forEach(function(x){
    p=p.then(function(){
      k++;
      var head=apiBylHead(x), kind=x["별표구분"]||"별표", link=String(x["별표서식파일링크"]||"");
      var seq=(/flSeq=(\d+)/.exec(link)||[])[1];
      if(kind==="서식"||!seq||noInflate){ var pg=apiBylJsonPage(head,x); if(pg) pages.push(pg); return; }
      if(onStep) onStep(k,units.length,head);
      return lawApiCall({op:"file",flSeq:seq}).then(function(d){
        return bylFileItems(b64Bytes(d.b64));
      }).then(function(items){
        /* 파일 첫머리의 「■ 법령 [별표 N] <개정…>」 문단은 우리 머리말과 겹친다 */
        var i=0; while(i<3&&i<items.length&&items[i].p!=null&&/\[\s*별\s*[표지]/.test(items[i].p)) i++;
        var got=apiBylItemsPages(head,items.slice(i));
        if(!got.length){ var pg2=apiBylJsonPage(head,x); if(pg2) pages.push(pg2); }
        else pages.push.apply(pages,got);
      },function(err){
        if(err&&err.message==="NOINFLATE") noInflate=true;
        var pg3=apiBylJsonPage(head,x); if(pg3) pages.push(pg3);
      });
    });
  });
  return p.then(function(){ return {pages:pages,noInflate:noInflate}; });
}

/* ---------- 받아서 저장 ---------- */
/* l: 이미 있는 법령 행(id 있음) 또는 {name, kind} 새 항목 */
function lawApiImport(l){
  var name=nfc(l.name||"").trim(), admrul=false, info=null, doc=null, pages=[], today=todayKey();
  if(!name) return Promise.reject(new Error("법령 이름이 비었어요."));
  showToast("법제처에서 「"+name+"」 찾는 중...");
  return lawApiLocate(name,l.kind).then(function(r){
    admrul=r.admrul;
    var cur=null; r.rows.forEach(function(x){ if(!cur&&x.status==="현행") cur=x; }); cur=cur||r.rows[0];
    info={mst:String(cur.mst),eff:String(cur.eff||""),code:String(cur.code||""),kind:apiKindOf(cur.kind,admrul),
          target:admrul?"admrul":"law",name:cur.name};
    var futures=admrul?[]:r.rows.filter(function(x){ return x.status==="시행예정"&&String(x.eff)>today; })
                        .sort(function(a,b){ return String(a.eff)<String(b.eff)?-1:1; }).slice(0,4);
    showToast("본문 받는 중...");
    return lawApiCall({op:"body",target:admrul?"admrul":"eflaw",mst:info.mst,efYd:info.eff}).then(function(d){
      doc=d.doc; if(!doc) throw new Error("본문이 비어 있어요.");
      var base={};
      if(admrul) pages=apiAdmrulPages(doc);
      else { var got=apiLawPages(doc); pages=got.pages; base=got.map; }
      /* 시행예정 판 — 앞 판과 다른 조만 「[시행일: …]」을 달아 넣는다 (PDF 판과 같은 꼴).
       * **부칙은 그 뒤에** 붙인다 — 부칙 머리말 뒤의 조는 전부 「부칙 제N조」가 되므로(inBuchik),
       * 시행예정 조가 부칙 뒤에 오면 「부칙 제3조(약사 자격과 면허) · 시행 …」이 된다(실제로 그랬다). */
      var chain=Promise.resolve(base);
      futures.forEach(function(f){
        chain=chain.then(function(prev){
          showToast("시행예정("+lawDateDots(f.eff)+") 조문 받는 중...");
          return lawApiCall({op:"body",target:"eflaw",mst:String(f.mst),efYd:String(f.eff)}).then(function(d2){
            var r2=apiLawPages(d2.doc||{}), m2=r2.map;
            Object.keys(m2).forEach(function(k){ if(prev[k]!==m2[k]) pages.push({text:m2[k]+"\n[시행일: "+lawDateDots(f.eff)+"]"}); });
            return m2;
          },function(){ return prev; });
        });
      });
      return chain.then(function(){ pages=pages.concat(apiBuchikPages(doc)); });
    });
  }).then(function(){
    return apiBylPages(doc,function(i,n,head){ showToast("별표 받는 중 "+i+"/"+n+" · "+head.slice(0,18)); });
  }).then(function(b){
    pages=pages.concat(b.pages);
    if(b.noInflate) showToast("이 브라우저는 압축을 못 풀어 별표의 표는 글자로만 넣었어요.",true);
    pages.forEach(function(p,i){ p.page=i+1; p.content=p.text; });
    var arts=buildLawArticles(pages,name,info.kind);
    arts.forEach(function(a){
      var pg=pages[a.page-1];
      if(pg&&pg.title&&a.label.indexOf(" · ")<0) a.label+=" · "+pg.title;
      /* 법제처 판은 전부 읽을 수 있는 글자다(격자도 표로 그린다) — tbl 은 **모든 행에** false.
       * 행마다 키가 다르면 PostgREST 가 묶음 넣기를 통째로 거부한다(PGRST102 「All object keys
       * must match」). 실제로 규칙 410조가 지워진 채 하나도 안 들어갔다. */
      a.tbl=false;
      a.page=0; a.page_end=0;
    });
    if(arts.length<3) throw new Error("조문을 "+arts.length+"개밖에 못 만들었어요. 옛 조문은 그대로 두었어요.");
    var patch={src:"api",target:info.target,mst:info.mst,lawcode:info.code,fetched:today,
               pages:0,kind:info.kind,eff:info.eff};
    if(l.id){
      /* PDF 파일은 더 쓸 데가 없다 — 지운다(이랑님: 「pdf 파일이 그대로 있을 이유가 있어?」) */
      if(l.filePath){ try{ sb.storage.from("files").remove([l.filePath]); }catch(e){} patch.filePath=null; patch.fileName=null; }
      return saveLawArticles(l.id,arts,l).then(function(){
        return withAuthRetry(function(){ return sb.from("law_pages").delete().eq("law_id",l.id); });
      }).then(function(){
        Object.keys(patch).forEach(function(k){ l[k]=patch[k]; });
        return dbUpdate("laws",l.id,patch);
      }).then(function(){ return {arts:arts.length,name:name}; });
    }
    var item={name:name,filePath:null,fileName:null,arts:0};
    Object.keys(patch).forEach(function(k){ item[k]=patch[k]; });
    return dbInsert("laws",item).then(function(row){
      if(!row) throw new Error("법령 정보를 저장하지 못했어요. 법령 표에 새 칸(src·target·mst)을 만드는 SQL 을 먼저 돌려주세요.");
      S.laws.unshift(item);
      return saveLawArticles(row.id,arts,item);
    }).then(function(){ return {arts:arts.length,name:name}; });
  });
}
/* 개정판 확인 — 한 판에 한 번. 법제처 판마다 검색 한 번씩(돈 안 듦). 현행 판의 번호(mst)나 시행일이
 * 우리가 받은 것과 다르면 l.newer 에 적어 두고 알림 한 줄을 띄운다. 버튼은 그때만 보인다. */
var lawApiChecked=false;
function lawApiCheckUpdates(){
  if(lawApiChecked) return; lawApiChecked=true;
  var todo=S.laws.filter(function(l){ return l.src==="api"&&l.mst; });
  if(!todo.length) return;
  var found=0, p=Promise.resolve();
  todo.forEach(function(l){
    p=p.then(function(){
      return lawApiCall({op:"search",target:l.target==="admrul"?"admrul":"eflaw",q:l.name}).then(function(d){
        var rows=(d.rows||[]).filter(function(r){ return lawBare(r.name)===lawBare(l.name)&&String(r.status||"")==="현행"; });
        var cur=rows[0]; if(!cur) return;
        if(String(cur.mst)!==String(l.mst)||String(cur.eff||"")>String(l.eff||"")){ l.newer={mst:String(cur.mst),eff:String(cur.eff||"")}; found++; }
      },function(){});
    });
  });
  p.then(function(){ if(found) render(); });
}
function lawApiNewer(){
  if(lawBusy) return;
  var todo=S.laws.filter(function(l){ return l.src==="api"&&l.newer; });
  if(!todo.length) return;
  lawBusy=true; render();
  var k=0, fails=[];
  function next(){
    if(k>=todo.length){ lawBusy=false; lawApiChecked=false; render(); lawApiCheckUpdates();
      showToast("✓ "+(todo.length-fails.length)+"개를 최신판으로 바꿨어요"); if(fails.length) alert("못 바꾼 것:\n\n"+fails.join("\n")); return; }
    var l=todo[k++]; showToast("("+k+"/"+todo.length+") "+l.name+" 최신판 받는 중...");
    lawApiImport(l).then(function(){ delete l.newer; next(); },function(err){ fails.push(l.name+" — "+((err&&err.message)||"실패")); next(); });
  }
  next();
}
/* 받을 수 있는 것을 한 번에 — 목록의 알림에서 부른다 */
function lawApiAll(){
  if(lawBusy) return;
  var todo=S.laws.filter(function(l){ return lawIsApiable(l)&&l.src!=="api"; });
  if(!todo.length){ showToast("법제처에서 받을 법령이 없어요."); return; }
  var msg="아래 "+todo.length+"개를 법제처 판으로 바꿉니다.\n\n"+todo.map(function(l){ return "  · "+l.name; }).join("\n")
    +"\n\n조문을 새로 만들고 쪽 번호는 없어져요(대신 「법제처에서 보기」). PDF 파일은 그대로 둡니다.\n문서가 크면 몇 분 걸려요. 계속할까요?";
  if(!confirm(msg)) return;
  lawBusy=true; render();
  var k=0, ok=0, fails=[];
  function next(){
    if(k>=todo.length){
      lawBusy=false; render();
      showToast("✓ "+ok+"/"+todo.length+"개를 법제처 판으로 바꿨어요");
      if(fails.length) alert("못 바꾼 것:\n\n"+fails.join("\n")+"\n\n옛 조문은 그대로 있어요. 나중에 「조문 만들기」로 다시 해 보세요.");
      return;
    }
    var l=todo[k++];
    showToast("("+k+"/"+todo.length+") "+l.name);
    lawApiImport(l).then(function(){ ok++; next(); },function(err){
      fails.push(l.name+" — "+((err&&err.message)||"실패")); next();
    });
  }
  next();
}
/* 이름으로 새로 받기 — 파일 없이. **이름을 다 몰라도 된다** — 「의약품」만 적어도 법제처가 준
 * 후보를 목록으로 보여주고 누르면 받는다. (처음엔 정확한 이름을 요구했다 — 이랑님: 「내가 전체
 * 이름을 모르면 못 찾잖아」.) 현행만 보이고, 이미 올린 것은 눌리지 않는다. */
var lawApiCands=null;   /* {q, rows:[{name,kind,eff,admrul}]} */
function lawApiSearchAll(q){
  return Promise.all([
    lawApiCall({op:"search",target:"eflaw",q:q}).catch(function(){ return {rows:[]}; }),
    lawApiCall({op:"search",target:"admrul",q:q}).catch(function(){ return {rows:[]}; })
  ]).then(function(rs){
    var seen={}, out=[];
    [[rs[0],false],[rs[1],true]].forEach(function(p){
      (p[0].rows||[]).forEach(function(r){
        if(String(r.status||"")!=="현행") return;          /* 연혁·시행예정은 판이지 다른 법령이 아니다 */
        var k=lawBare(r.name); if(!k||seen[k]) return; seen[k]=1;
        out.push({name:nfc(r.name),kind:nfc(r.kind||""),eff:String(r.eff||""),admrul:p[1]});
      });
    });
    return out.slice(0,40);
  });
}
function lawApiNew(){
  if(lawBusy) return;
  var name=prompt("법제처에서 찾을 이름을 적어주세요. 일부만 적어도 돼요.\n예) 의약품 · 약사법 · 생물학적제제");
  if(name==null) return;
  name=nfc(name).trim(); if(name.length<2){ showToast("두 글자 이상 적어주세요."); return; }
  lawBusy=true; render(); showToast("법제처에서 「"+name+"」 찾는 중...");
  lawApiSearchAll(name).then(function(rows){
    lawBusy=false;
    if(!rows.length){ render(); showToast("법제처에서 「"+name+"」이(가) 든 법령·고시를 못 찾았어요.",true); return; }
    var exact=rows.filter(function(r){ return lawBare(r.name)===lawBare(name); });
    if(rows.length===1&&exact.length===1){ lawApiCands=null; lawApiPick(exact[0]); return; }
    lawApiCands={q:name,rows:rows}; render();
  },function(err){ lawBusy=false; render(); showToast((err&&err.message)||"찾지 못했어요.",true); });
}
function lawApiPick(r){
  if(lawBusy||!r) return;
  if(S.laws.some(function(l){ return lawBare(l.name)===lawBare(r.name); })){ showToast("「"+r.name+"」은 이미 있어요."); return; }
  lawApiCands=null; lawBusy=true; render();
  lawApiImport({name:r.name,kind:apiKindOf(r.kind,r.admrul)}).then(function(x){
    lawBusy=false; lawListOpen=true; render();
    showToast("✓ 「"+x.name+"」 조문 "+x.arts+"개를 받았어요");
  },function(err){
    lawBusy=false; render();
    showToast((err&&err.message)||"받지 못했어요.",true);
  });
}
function lawCandsHtml(){
  var c=lawApiCands; if(!c) return "";
  return '<div class="law-cands"><div class="law-cands-h">법제처에서 「'+esc(c.q)+'」로 찾은 것 <b>'+c.rows.length+'개</b> — 누르면 받아요'
    + '<button class="link-btn quiet-link" data-act="law-cands-x">닫기</button></div>'
    + c.rows.map(function(r,i){
        var have=S.laws.some(function(l){ return lawBare(l.name)===lawBare(r.name); });
        return '<button class="law-cand'+(have?" have":"")+'" data-act="law-cand" data-id="'+i+'"'+(have?" disabled":"")+'>'
          + '<span class="law-cand-n">'+esc(r.name)+'</span>'
          + '<span class="law-cand-k">'+esc(r.kind)+(r.eff?' · 시행 '+esc(lawDate(r.eff)):'')+(have?' · 이미 있음':'')+'</span></button>';
      }).join("")
    + (c.rows.length>=40?'<div class="law-cands-more">더 있어요 — 이름을 더 적으면 좁혀져요.</div>':'')
    + '</div>';
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
/* 표 여부(tbl) 칸은 SQL을 돌려야 생긴다. 아직 없으면 조용히 빼고 저장한다 —
 * 예전 article 칸을 그렇게 다뤘고, 같은 방식이라야 사용자가 SQL을 안 돌려도 쓸 수 있다. */
var lawTblCol=true;
function isNoTblCol(err){
  var m=((err&&err.message)||"").toLowerCase();
  return m.indexOf("tbl")>=0&&(m.indexOf("column")>=0||m.indexOf("does not exist")>=0);
}
function dropTbl(rows){ return rows.map(function(r){ var o={}; for(var k in r) if(k!=="tbl") o[k]=r[k]; return o; }); }

/* ===== 법령 AI — 「어느 조를 펴 볼까」 고르기 =====
 * 답변은 쓰지 않는다. 어디를 볼지만 고른다.
 * 값이 싼 쪽(Haiku)만 쓰므로 엉뚱한 질문을 해도 재시도가 싸다.
 * API 키는 Supabase Edge Function(law-pick) 비밀값에만 있다 — 여기엔 없다. */
var lawAsk=null, lawAsking=false, lawAskMore=false;
/* 지난번에 실제로 든 값(원). 어림값을 적어 두는 것보다 이게 정직하다. */
var lawAskLast=null;
/* 어느 법령에서만 고를지. 비어 있으면 전부 본다 —
 * 「아무것도 안 고르면 아무 데서도 안 찾는다」는 헷갈리므로 그 반대로 둔다. */
var lawOnly={};
/* AI가 고른 조문 중 내가 맞다고 체크한 것 (id → true) */
var lawAskSel={};   /* (v154 부터 안 쓴다 — 체크는 lawSel 한 벌) */
function lawOnlyIds(){ return Object.keys(lawOnly).filter(function(k){ return lawOnly[k]; }); }
function lawOnlyLabel(){
  var ids=lawOnlyIds(); if(!ids.length||ids.length===S.laws.length) return "";
  /* 법령 이름이 길어서 그대로 쓰면 배지가 줄을 밀어낸다 */
  var first=String(lawName(ids[0])||"");
  if(first.length>16) first=first.slice(0,16)+"…";
  return ids.length===1?first:(first+" 등 "+ids.length+"개");
}

/* **기다리는 동안 화면이 죽어 있으면 멈춘 줄 안다.** 5~15초가 걸리는 일이라
 * ① 막대가 흐르고 ② 점 셋이 켜지고 ③ 지금 무슨 일을 하는지 글자가 바뀐다.
 * 단계는 실제 진행이 아니라 **대략의 차례**다 — 서버가 알려주지 않기 때문에
 * 시간으로 넘긴다. 그래서 「몇 %」처럼 잰 척하는 표시는 쓰지 않는다. */
var ASK_STEPS=["조 제목을 훑어 후보를 고르는 중","고른 조문의 본문을 읽는 중","근거를 원문과 대조하는 중"];
var lawAskStep=0, lawAskTimer=null;
function lawWaitHtml(){
  return '<div class="ask-wait">'
    + '<div class="ask-wait-bar"><i></i></div>'
    + '<div class="ask-wait-t">'+esc(ASK_STEPS[Math.min(lawAskStep,ASK_STEPS.length-1)])
    +   '<span class="ask-dots"><i></i><i></i><i></i></span></div>'
    + '<div class="ask-wait-s">보통 5~15초 걸려요.</div></div>';
}
function lawAskStop(){ if(lawAskTimer){ clearInterval(lawAskTimer); lawAskTimer=null; } }

function lawAskRun(){
  var q=nfc(val("law-q")||"").trim();
  if(q.length<5){ showToast("질문을 문장으로 적어주세요. 민원 글을 그대로 붙여넣어도 돼요."); return; }
  if(!S.laws.length){ showToast("먼저 법령 PDF를 올려주세요."); return; }
  lawQuery=q; lawHits=null; lawSel={}; lawOpen={};
  /* 옛 검색어 형광펜을 지운다. 안 지우면 원문 창이 노란 범벅이 되어 못 읽는다 —
   * AI 결과에서는 **근거 문장 하나만** 칠한다(창을 열 때 정한다). */
  lawTermList=[];
  /* renderLawResults() 만 부르면 결과 자리만 바뀌고 **버튼은 그대로**다 —
   * 눌러도 아무 일도 안 일어난 것처럼 보였다. 화면 전체를 다시 그린다. */
  lawAsking=true; lawAsk=null; lawAskStep=0;
  /* 사용법·법령 목록을 접어 **결과가 뜰 자리를 미리 비운다** — 안 접으면
   * 기다리는 표시가 사용법 아래로 밀려나 화면 밖에 있다. */
  lawHelpOpen=false; lawListOpen=false;
  lawAskStop();
  lawAskTimer=setInterval(function(){
    if(!lawAsking){ lawAskStop(); return; }
    lawAskStep++; renderLawResults();
  },4200);
  render();
  function done(){ lawAskStop(); lawAsking=false; render(); }
  var only=lawOnlyIds();
  sb.functions.invoke("law-pick",{body:{q:q,lawIds:(only.length&&only.length<S.laws.length)?only:null,rules:setGet("ai_rules")}}).then(function(r){
    var d=r&&r.data;
    if(!d){ showToast("물어보지 못했어요: "+((r&&r.error&&r.error.message)||"응답이 비었어요"),true); done(); return; }
    if(d.error){ showToast(d.error,true); done(); return; }
    d.q=q; lawAsk=d; lawAskMore=false; lawSel={};
    if((d.picks||[]).length){ lawHelpOpen=false; lawListOpen=false; }
    if(d.krw!=null) lawAskLast=d.krw;
    /* 처음부터 체크되는 것은 **등급(중간 이상)으로만** 정한다. 전에 답변에 쓴 조문은
     * 위로 올리고 펼쳐 둘 뿐 체크하지 않는다 — 「답변에 씀」은 「비슷한 질문에 썼다」가
     * 아니라 「어느 답변엔가 인용한 적 있다」는 뜻이라, 이번 질문에 맞는지는 이랑님이
     * 본다(2026-09-08 「애매한 것도 다 차용하게 하는 게 좋나」 → 아니다). */
    var usedOf=ansUsedMap();
    /* 처음부터 체크되는 것은 **「인용 필수」만**(이랑님: 「인용 필수만 선체크하자」). 나머지는 펼쳐 두되 체크 안 함. */
    (d.picks||[]).forEach(function(p){
      p.used=usedOf[ansUsedKey(p.law,p.label)]||0;
      if(p.need==="인용 필수") lawSel["a"+p.id]=true;
    });
    done();
  }).catch(function(e){ showToast("물어보지 못했어요: "+e.message,true); done(); });
}

/* 체크한 조문의 원문을 통째로 뽑아 온다.
 * AI 화면에는 조 제목과 「왜 골랐나」만 있으므로, 모을 때는 본문을 다시 읽어야 한다.
 * 이건 3단계(답변 초안)에서 Claude에게 보낼 것과 똑같은 묶음이다. */
/* (AI 결과 전용 내보내기·고르기는 없앴다 — 한 목록의 lawExportAll·lawSelAll 이 맡는다) */

/* ---------- AI 결과 요약 상자 ----------
 * 조문 카드는 낱말·뜻 결과와 **한 목록**에 섞여 들어가므로(lawCards), 여기서는 질문·값·요지·설명만 보인다.
 * 예전엔 AI 결과가 따로 한 덩어리라 머리줄·버튼이 두 벌이고 같은 조가 두 번 떴다(이랑님: 「스크롤 왔다갔다
 * 하면서 체크하는 게 불편해」). */
function lawAskNoteHtml(){
  var d=lawAsk; if(!d) return "";
  var head='<div class="ask-head"><span class="ask-qt">「'+esc(d.q)+'」</span>'
    + '<span class="ask-cost">이번 '+(d.krw||0)+'원</span>'
    + '<button class="link-btn quiet-link ask-x" data-act="ask-close" title="AI 결과 닫기">닫기 ✕</button></div>'
    + (d.gist?'<p class="ask-gist"><b>AI 가 읽은 핵심</b> — '+esc(d.gist)+' <span class="ask-dim">이게 아니면 질문을 고쳐 다시 물어보세요.</span></p>':'');
  if(!d.picks||!d.picks.length)
    return '<div class="ask-box">'+head
      + '<p class="ask-none">'+(d.stopped
          ? (d.stopped==="refusal"?"AI 가 답하기를 거부했어요."
            :d.stopped==="max_tokens"?"AI 답이 중간에서 잘렸어요."
            :"AI 답을 읽지 못했어요.")
          : "올려둔 법령에서는 관련 조문을 못 찾았어요.")+'</p>'
      + (d.note?'<p class="ask-note">'+esc(d.note)+'</p>':'')+'</div>';
  var extra=[];
  if(d.boosted) extra.push("낱말로 "+d.boosted+"개"+(d.words&&d.words.length?"("+d.words.join("·")+")":""));
  if(d.semantic) extra.push("뜻으로 "+d.semantic+"개");
  if(d.pastBoost) extra.push("지난 답변에서 "+d.pastBoost+"개");
  if(d.skipped) extra.push("시행 전 조문 "+d.skipped+"개 제외");
  var past=(d.similar||[]).filter(function(x){ return S.answers.some(function(a){ return a.id===x.id; }); });
  var pastHtml=past.length
    ? '<p class="ask-past"><b>비슷한 지난 답변</b> — '+past.map(function(x){
        return '<button class="link-btn ask-past-btn" data-act="ans-jump" data-id="'+esc(x.id)+'">'+esc(x.title||"(제목 없음)")+'</button>';
      }).join(" · ")+' <span class="ask-dim">그때 인용한 조문을 후보에 먼저 넣었고, 초안의 말투 본보기로도 써요.</span></p>'
    : "";
  if(d.looked) extra.push("본문 읽음 "+d.looked+"개");
  return '<div class="ask-box">'+head
    + (d.note?'<p class="ask-note">'+esc(d.note)+'</p>':'')
    + (d.truncated?'<p class="ask-warn">올려둔 조문이 너무 많아 <b>앞쪽 '+d.arts+'개만</b> 봤어요. 위에서 법령을 골라 범위를 좁혀주세요.</p>':'')
    + (extra.length?'<p class="ask-dim ask-extra">후보 보강 — '+esc(extra.join(" · "))+'</p>':'')
    + pastHtml
    + '<p class="ask-legend"><span class="ask-score n-1">인용 필수</span> 표시가 붙은 조는 처음부터 체크돼 있어요. '
    +   '<span>있으면 좋음</span><span>없어도 됨</span>은 보고 고르세요. 조문 원문은 카드를 누르면 열려요.</p>'
    + '</div>';
}

/* 관련도 등급. 서버가 세 가지 판단을 더해 매기고, 여기서는 순서와 색만 쓴다.
 * 숫자(0~100)를 그대로 보여주지 않는 이유 — 잰 값이 아닌데 잰 것처럼 보인다. */
var ASK_GRADES=["매우 높음","높음","중간","낮음","매우 낮음"];
/* 배지에는 등급어 대신 **「답변서에 인용해야 하나」**를 띄운다. 이랑님이 카드를
 * 보고 내리는 판단이 그것 하나이기 때문이다. 「매우 높음」은 무슨 뜻인지 알려면
 * 사용법을 펼쳐 열 줄을 읽어야 했다 — 그건 진 것이다.
 * 등급(grade)은 그대로 쓰되 **순서와 접기**에만 쓴다. */
var ASK_NEEDS=["인용 필수","있으면 좋음","없어도 됨"];
function needRank(n){ var i=ASK_NEEDS.indexOf(n); return (i<0?1:i)+1; }
function askRank(g){ var i=ASK_GRADES.indexOf(g); return i<0?2:i; }
/* 「중간」까지가 펼쳐지고 처음부터 체크된다. 그 아래는 접어 둔다. */
var ASK_KEEP=2;

/* 문장처럼 보이면 ✦ 를 내보낸다. 낱말 한둘일 땐 쓸 일이 없다. */
function lawAskFits(t){ return String(t||"").trim().length>=12; }
/* 칸이 내용만큼 자라게 + ✦ 줄을 보이거나 감추기 */
function lawQBox(q){
  q.style.height="auto";
  q.style.height=Math.min(q.scrollHeight,118)+"px";   /* 네 줄까지. 그 뒤는 칸 안에서 스크롤 */
  var bar=document.querySelector(".ask-bar");
  if(bar) bar.classList.toggle("gone",!lawAskFits(q.value));
}

var LAW_HIT_MAX=600;   /* 검색 결과 상한 — 닿으면 화면에 알린다 */

/* ---------- 뜻으로 찾기 (AI 없이, 공짜) ----------
 * 질문의 뜻 지문과 가까운 조문 20개를 보여준다. 낱말이 달라도 찾는다.
 * 문장을 치고 Enter 를 누르면 이리로 온다. 낱말로 0건이어도 이리로 온다. */
var lawSem=null;    /* {q, auto} — 지금 결과가 뜻으로 찾은 것일 때 */
var SEM_HITS=20, SEM_FLOOR=0.3;
function lawSemFits(q,terms){ return q.length>=14&&terms.length>=4; }
function lawSemSearch(q,auto){
  lawSem={q:q,auto:!!auto}; lawTermList=[]; lawSearching=true; renderLawResults();
  sb.functions.invoke("law-embed",{body:{op:"query",q:q,k:SEM_HITS*2}}).then(function(r){
    var d=r&&r.data;
    if(!d||d.error) throw new Error((d&&d.error)||((r&&r.error&&r.error.message)||"응답이 비었어요"));
    var rows=d.rows||[], only=lawOnlyIds();
    if(only.length&&only.length<S.laws.length) rows=rows.filter(function(x){ return only.indexOf(String(x.law_id))>=0; });
    rows=rows.filter(function(x){ return Number(x.sim)>=SEM_FLOOR; }).slice(0,SEM_HITS);
    if(!rows.length){ lawSearching=false; lawHits=[]; renderLawResults(); return; }
    var ids=rows.map(function(x){ return x.id; });
    return withAuthRetry(function(){
      return sb.from("law_articles").select("id,law_id,label,page,page_end,content"+(lawTblCol?",tbl":"")).in("id",ids);
    }).then(function(res){
      if(res.error) throw new Error(res.error.message);
      var by={}; (res.data||[]).forEach(function(a){ by[String(a.id)]=a; });
      var hits=[];
      rows.forEach(function(x){
        var a=by[String(x.id)]; if(!a) return;
        var c=cleanPdfText(a.content||""), body=c.replace(/[┃│┨]/g," ").replace(/\s+/g," ").trim();
        hits.push({ key:"a"+a.id, artId:a.id, lawId:a.law_id, art:a.label, page:a.page, pageEnd:a.page_end||a.page,
                    table:false, total:1, spots:1, sim:Number(x.sim),
                    snips:[{ where:"", full:lawPlain(c), text:body.slice(0,260)+(body.length>260?"…":"") }] });
      });
      /* 위계 → 법령 → 뜻이 가까운 순 (낱말 검색과 같은 묶음 모양) */
      hits.sort(function(a,b){
        var la=S.laws.find(function(l){ return l.id===a.lawId; }), lb=S.laws.find(function(l){ return l.id===b.lawId; });
        var ka=la?lawKindOf(la).n:9, kb=lb?lawKindOf(lb).n:9; if(ka!==kb) return ka-kb;
        var na=lawName(a.lawId), nb=lawName(b.lawId); if(na!==nb) return na<nb?-1:1;
        return b.sim-a.sim;
      });
      lawSearching=false; lawCapped=false; lawHits=hits;
      lawHelpOpen=false; lawListOpen=false; render();
    });
  }).catch(function(e){
    lawSearching=false; lawHits=[]; renderLawResults();
    showToast("뜻으로 찾지 못했어요: "+((e&&e.message)||"")+" — 낱말 두세 개로 다시 찾아보세요.",true);
  });
}
var lawCapped=false;
function lawSearch(){
  var q=nfc(val("law-q")||"").trim();
  /* AI 결과는 지우지 않는다 — 「조문을 더 보태려고」 낱말을 치는 흐름이다(이랑님: 「낱말 다시
   * 입력하면 밑에 떠 있던 AI 조문이 싹 다 날아간다」). 낱말 결과는 위에, AI 결과는 그 아래 남는다. */
  (lawHits||[]).forEach(function(g){ if(!(lawAsk&&lawAsk.picks&&lawAsk.picks.some(function(p){ return "a"+p.id===g.key; }))) delete lawSel[g.key]; });
  lawQuery=q; lawHits=null; lawOpen={}; lawAsking=false; lawSem=null;
  lawTermList=lawTerms(q);
  if(!lawTermList.length){ renderLawResults(); showToast("두 글자 이상 입력해 주세요."); return; }
  if(!S.laws.length){ renderLawResults(); showToast("먼저 법령을 받거나 올려주세요."); return; }
  /* **문장이면 뜻으로 찾는다.** 낱말 다섯 개가 모두 든 조문은 있을 수 없어서 늘 「찾지 못했어요」였다
   * (이랑님: 「문장으로 입력해서 엔터 누르면 너무 길어서 못 찾잖아」). 뜻 지문은 공짜고 AI 를 안 부른다.
   * AI 는 지금처럼 「관련 조문 찾아줘」를 눌러야만 돈다. */
  if(lawSemFits(q,lawTermList)){ lawSemSearch(q,false); return; }
  lawSearching=true; renderLawResults();
  function run(){
    return withAuthRetry(function(){
      var qb=sb.from("law_articles")
        .select("id,law_id,seq,label,num,page,page_end,content"+(lawTblCol?",tbl":""));
      /* 낱말마다 조건을 겹쳐 걸면 모두 들어 있는 조문만 남는다 (교집합) */
      lawTermList.forEach(function(t){ qb=qb.ilike("content","%"+escLike(t)+"%"); });
      /* **잘린 줄 모르는 것이 제일 위험하다.** 「제조」「의약품」「시험」「관리」
       * 「품질」「보관」은 실제로 300~400곳이 넘는데 200에서 잘렸고, 화면에는
       * 아무 표시가 없어 그게 전부인 줄 알았다. 상한을 올리고 **닿으면 알린다.** */
      return qb.order("law_id").order("seq").limit(LAW_HIT_MAX);
    });
  }
  run().then(function(res){
    /* 표 칸이 아직 없으면(SQL 전) 그 칸만 빼고 다시 찾는다 */
    if(res.error&&lawTblCol&&isNoTblCol(res.error)){ lawTblCol=false; return run(); }
    return res;
  }).then(function(res){
    lawSearching=false;
    if(res.error){
      if(/law_articles/.test(res.error.message||"")){
        showToast("조문 표가 아직 없어요. Supabase SQL을 먼저 돌려주세요.",true);
      } else showToast("검색 실패: "+res.error.message,true);
      lawHits=[]; renderLawResults(); return;
    }
    lawCapped=(res.data||[]).length>=LAW_HIT_MAX;
    lawHits=buildLawHits(res.data||[],lawTermList);
    /* 낱말로 하나도 없으면 뜻으로 한 번 더 — 「없어요」로 끝내지 않는다 */
    if(!lawHits.length&&lawTermList.length>=2){ lawSemSearch(q,true); return; }
    /* 결과가 나오면 위쪽 부속(도움말·올려둔 목록)을 접는다. 안 그러면 결과를
     * 보려고 500px 넘게 굴려 내려가야 한다. 다시 펼치는 건 한 번 누르면 된다. */
    if(lawHits.length){ lawHelpOpen=false; lawListOpen=false; render(); return; }
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
    /* 표(격자) 줄 안에 있는 낱말은 앞뒤 80자가 아니라 **그 줄 전체**를 보여준다 —
     * 칸 하나만 잘라 오면 어느 위반사항의 처분인지 알 수 없다. 머리 줄도 같이 붙인다. */
    var rinfo=gridRowsInfo(c), gridHits=[], seenRow={};
    if(rinfo.length){
      found=found.filter(function(f){
        for(var q=0;q<rinfo.length;q++){
          if(f.at>=rinfo[q].st&&f.at<rinfo[q].en){
            if(!seenRow[rinfo[q].st]){ seenRow[rinfo[q].st]=1; gridHits.push(rinfo[q]); }
            return false;
          }
        }
        return true;
      });
    }

    /* 검색어가 가까이 붙어 있으면 앞뒤 80자 창이 서로 겹쳐서
     * 같은 문장이 두세 번 나온다. 겹치는 창은 하나로 합친다.
     * 합친 창 안의 검색어는 어차피 표시할 때 전부 노랗게 칠해진다. */
    /* 끊을 자리를 먼저 구해 둔다 — 창을 합칠지 정할 때도 쓴다 */
    var pts=lawBreaks(c);
    pts.text=c;                      /* 문장 경계 폴백에서 원문을 본다 */
    /* 목·호 경계를 넘어서까지 합치면 「가목」 배지 하나에 가목과 나목이 함께
     * 들어가 버린다(「보관」이 양쪽에 있고 두 자리가 가까울 때). 경계를 넘으면
     * 새 조각으로 나눈다 — 배지가 가리키는 곳과 글이 맞는다. */
    function crossAt(a,b){       /* 두 자리 사이의 경계 위치 (없으면 -1) */
      for(var i=0;i<pts.length;i++)
        if(!pts[i].soft&&pts[i].lv<=3&&pts[i].at>a&&pts[i].at<=b) return pts[i].at;
      return -1;
    }
    /* 발췌는 **그 낱말이 든 덩어리의 첫 글자부터** 보여준다.
     * 앞 80자에서 무턱대고 자르면 「…나. 생물학적제제등」처럼 문장 한복판에서
     * 시작해 어디인지 바로 못 찾는다. 덩어리가 너무 길면 앞을 잘라 「…」을 붙인다. */
    var HEAD_MAX=380;
    function blockStart(at){
      var st=0, idx=-1;
      for(var i=0;i<pts.length;i++){
        if(pts[i].soft) continue;
        if(pts[i].at<=at){ st=pts[i].at; idx=i; } else break;
      }
      /* 덩어리 바로 앞이 제목 줄이면 그 제목부터 보여준다 — 미리보기에서
       * 「· 교차오염방지」가 빠지면 어느 대목인지 알 수 없다. */
      if(idx>0&&pts[idx].lv===1&&pts[idx-1].lv===0&&!pts[idx-1].soft) st=pts[idx-1].at;
      /* 다만 조 제목(len이 있는 지점)은 배지에 이미 있으므로 건너뛴다 —
       * 「제3조(약사 자격과 면허)」가 배지에도 발췌에도 나와 같은 말이 두 번이었다. */
      for(var k=0;k<pts.length;k++)
        if(pts[k].at===st&&pts[k].len>0){ st=pts[k].at+pts[k].len; break; }
      return st;
    }
    /* 조 제목 안의 낱말로는 발췌를 만들지 않는다 — 「제3조(약사 자격과 면허)」가
     * 배지에도, 첫 조각에도 나와 같은 말이 두 번이었다. */
    function inTitle(at){
      for(var i=0;i<arts.length;i++) if(at>=arts[i].at&&at<arts[i].end) return true;
      return false;
    }
    var wins=[];
    found.forEach(function(f){
      if(inTitle(f.at)) return;
      var bs=blockStart(f.at);
      var st=Math.max(bs,f.at-HEAD_MAX), en=Math.min(c.length,f.at+f.len+PAD);
      /* 글 조각이 표 줄을 삼키지 않게 — 앞뒤의 표 줄 경계에서 자른다 (표는 따로 그린다) */
      for(var ri=0;ri<rinfo.length;ri++){
        if(rinfo[ri].en<=f.at&&rinfo[ri].en>st) st=rinfo[ri].en;
        if(rinfo[ri].st>=f.at+f.len&&rinfo[ri].st<en) en=rinfo[ri].st;
      }
      var last=wins.length?wins[wins.length-1]:null;
      var cut=last?crossAt(last.at,f.at):-1;
      if(last&&st<=last.en&&cut<0){ if(en>last.en) last.en=en; return; }
      if(cut>=0){
        if(st<cut) st=cut;
        if(last&&last.en>cut) last.en=cut;
      }
      wins.push({st:st,en:en,at:f.at,bs:bs});
    });
    /* 검색어가 조 제목에만 있으면 조각이 하나도 안 남는다 — 그때는 하나 남긴다 */
    if(!wins.length&&found.length){
      var f0=found[0];
      wins.push({st:Math.max(0,f0.at-PAD),en:Math.min(c.length,f0.at+f0.len+PAD),at:f0.at,bs:0});
    }
    if(wins.length>MAX_SNIP) wins=wins.slice(0,MAX_SNIP);

    var g={ key:"a"+r.id, artId:r.id, lawId:r.law_id, art:r.label,
            page:r.page, pageEnd:r.page_end||r.page,
            /* PDF의 선으로 짚어 둔 것이 있으면 그걸 믿고, 없으면(옛 자료) 글자로 짐작한다 */
            table:(r.tbl==null?looksLikeTable(c):!!r.tbl),
            total:total, spots:wins.length, snips:[] };
    /* 복사·저장에 쓸 「항 전문」도 같이 만들어 둔다. 화면은 짧은 발췌가 편하지만
     * 복사한 글은 문장이 잘려 있으면 그대로 쓸 수 없다. */
    var seen={};
    wins.forEach(function(w){
      var a=articleAt(arts,c,w.at,r.label,skips);
      var rg=lawBlockRange(pts,c.length,w.at), full=null;
      if(rg){
        var bk=rg.st+"-"+rg.en;
        full=seen[bk]?"":(seen[bk]=1,lawPlain(c.slice(rg.st,rg.en)));
      }
      /* 덩어리 첫 글자부터 시작했으면 앞에 「…」을 붙이지 않는다 */
      var where=(a&&a.detail)||"";
      var body=c.slice(w.st,w.en);
      /* 배지가 「가목」인데 글도 「가.」로 시작하면 같은 말이 두 번이다 — 글에서 뗀다 */
      if(w.st===w.bs){
        var mk=/^\s*([가-힣]|\d{1,2})\s*[.)]\s+/.exec(body);
        if(mk&&where.indexOf(mk[1])>=0) body=body.slice(mk[0].length);
      }
      /* 항 표시(①)도 배지에 있으면 뗀다 — 「① ①약사(藥師)가 …」가 됐다 */
      var mh=/^\s*([\u2460-\u2473])\s*/.exec(body);
      if(mh&&where.indexOf(mh[1])>=0) body=body.slice(mh[0].length);
      /* **알맹이 없는 발췌는 버린다.** 「6호 나목 …」처럼 배지만 남고 글이 없으면
       * 화면에 자리만 차지하고 아무것도 알려주지 않는다. 검색어 자체는 남으므로
       * 「밸리데이션 …」 한 낱말짜리도 버린다 — 그건 같은 조의 다른 조각에 있다. */
      var bare=body.replace(/[\s…·]/g,"");
      /* 다만 그 조의 발췌가 전부 짧으면 카드가 통째로 사라지므로 하나는 남긴다 */
      if(bare.length<8&&g.snips.length) return;
      g.snips.push({ where:where, full:full,
        text:(w.st>(w.bs==null?0:w.bs)?"…":"")+body+(w.en<c.length?"…":"") });
    });
    gridHits.slice(0,MAX_SNIP).forEach(function(ri){
      var rows=ri.head&&ri.head!==ri.cells?[ri.head,ri.cells]:[ri.cells];
      g.snips.push({ where:"", full:gridRowsPlain(rows), grid:rows, text:ri.cells.join(" | ") });
    });
    out.push(g);
  });
  /* 법 위계 순으로 세운다 — 지침서가 법률 위에 오면 근거가 약한 것을 먼저
   * 보게 된다. 목록에서 쓰는 것과 같은 순서라 눈이 헷갈리지 않는다. */
  /* 같은 법령 안에서는 **전에 답변에 쓴 조가 먼저**, 나머지는 쪽 순서. 위계·법령
   * 순서는 그대로다 — 지침서의 쓴 조가 법률 위로 올라오면 안 된다. */
  var usedOf=ansUsedMap();
  out.forEach(function(g){ g.used=usedOf[ansUsedKey(lawName(g.lawId),g.art)]||0; });
  out.sort(function(a,b){
    var la=S.laws.find(function(x){ return x.id===a.lawId; });
    var lb=S.laws.find(function(x){ return x.id===b.lawId; });
    var ka=la?lawKindOf(la).n:9, kb=lb?lawKindOf(lb).n:9;
    if(ka!==kb) return ka-kb;
    var na=lawName(a.lawId), nb=lawName(b.lawId);
    if(na!==nb) return na<nb?-1:1;
    if((a.used?1:0)!==(b.used?1:0)) return a.used?-1:1;
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

/* 쪽 경계에서 잘린 문장 조각. PDF는 문장 한복판에서 쪽을 넘기므로
 * 「우 정지 1 개월 정지 3 개월」처럼 꼬리부터 시작하는 쪽이 나온다.
 * 앞 쪽의 마지막 문장 꼬리와 다음 쪽의 첫 문장 머리만 가져와 흐리게 붙인다. */
/* 앞 조각은 이 쪽 첫 문장을 완성하는 몫이라 조금 길어도 되고, 뒤 조각은
 * 「이어진다」는 것만 알면 되니 짧게. 표는 문장 끝이 드물어 그냥 두면
 * 둘 다 최대치까지 늘어나 정작 이 쪽 내용을 밀어낸다. */
var EDGE_PRE=180, EDGE_POST=110;
function sentTail(t){          /* 문장 끝 뒤에 남은 꼬리 */
  t=String(t||"").replace(/\s+$/,"");
  if(!t||/[.?!]$/.test(t)) return "";
  var m=/[.?!]\s/g, at=-1, x;
  while((x=m.exec(t))!==null) at=x.index+x[0].length;
  var tail=(at>=0?t.slice(at):t).replace(/^\s+/,"");
  return tail.length>EDGE_PRE?"…"+tail.slice(-EDGE_PRE):tail;
}
function sentHead(t){          /* 첫 문장 끝까지의 머리 */
  t=String(t||"").replace(/^\s+/,"");
  if(!t) return "";
  var m=/[.?!](\s|$)/.exec(t);
  var head=m?t.slice(0,m.index+1):t;
  return head.length>EDGE_POST?head.slice(0,EDGE_POST)+"…":head;
}
function edgeBits(before,here,after){
  here=String(here||"");
  if(!here.trim()) return {pre:"",post:""};
  /* 이 쪽이 문장 중간에서 시작하면 앞 쪽의 꼬리를 가져온다 */
  var pre=/^\s*[a-z가-힣0-9),·]/.test(here)?sentTail(before):"";
  /* 이 쪽이 문장 중간에서 끝나면 다음 쪽의 머리를 가져온다 */
  var post=/[.?!]\s*$/.test(here)?"":sentHead(after);
  return {pre:pre,post:post};
}

/* ---------- 쪽 보기 (앱 안에서 바로) ----------
 * PDF를 여는 건 파일 전체를 내려받는 일이라 501쪽짜리는 12MB를 다 받아야
 * 한 쪽이 보인다. 쪽 텍스트는 이미 law_pages에 있으므로 그걸 바로 띄운다. */
var lawView=null;   /* {lawId,page,content,loading,err} */
/* 조 전체 보기에서 글자를 끌어 고르면 그 문장을 그 조의 답변 근거 문장으로 삼는다(이랑님 2026-09-10 — AI 가 고른 문장이
 * 원문이긴 해도 「마.」의 일반 문장이라 핀트가 빗나갔다. 사람이 고르는 게 제일 정확하다). artId → 문장. */
var lawKeyPick={}, lawSelText="";
function lawSelWatch(){
  var btn=document.getElementById("lv-pick"); if(!btn) return;
  var sel=window.getSelection&&window.getSelection(), t=sel?String(sel).replace(/\s+/g," ").trim():"";
  var body=document.getElementById("lv-body");
  var inside=!!(t.length>=12&&sel.rangeCount&&body&&body.contains(sel.getRangeAt(0).commonAncestorContainer));
  lawSelText=inside?t:"";
  btn.style.display=inside?"":"none";
  btn.textContent=inside?"고른 문장을 답변 근거로 ("+Math.min(t.length,60)+(t.length>60?"…":"")+"자)":"";
}
document.addEventListener("selectionchange",function(){ clearTimeout(window.__lvSelT); window.__lvSelT=setTimeout(lawSelWatch,180); });
function lawPickApply(){
  if(!lawView||!lawView.artId||!lawSelText) return;
  var id=String(lawView.artId); lawKeyPick[id]=lawSelText;
  /* 초안 창이 열려 있고 그 조가 들어 있으면 바로 바꾼다 */
  if(ansDraft&&ansDraft.cites){
    var hit=ansDraft.cites.find(function(c){ return String(c.artId)===id; });
    if(hit){ hit.pick=lawSelText; hit.key=lawSelText; if(ansDraft.made){ ansRegen(true); } }
  }
  var tn=document.getElementById("lv-pick"); if(tn) tn.style.display="none";
  if(window.getSelection) window.getSelection().removeAllRanges();
  showToast("✓ 이 조의 답변 근거 문장으로 골랐어요");
  renderAnsModal(true);
}

function openLawView(id,page){
  var l=S.laws.find(function(x){ return x.id===id; });
  if(!l) return;
  var max=l.pages||1;
  if(page<1) page=1; if(page>max) page=max;
  lawView={lawId:id,page:page,loading:true,content:"",err:""};
  renderLawModal();
  /* 앞뒤 쪽도 같이 읽는다 — 쪽 경계가 문장을 자르기 때문이다.
   * 잘린 조각만 이어 붙여 흐리게 보여주면 문장이 온전히 읽힌다. */
  function runPage(){
    return withAuthRetry(function(){
      return sb.from("law_pages")
        .select("page,content"+(lawArtCol?",article":"")+(lawTblCol?",tbl":""))
        .eq("law_id",id).gte("page",page-1).lte("page",page+1).order("page");
    });
  }
  runPage().then(function(res){
    if(res.error&&lawTblCol&&isNoTblCol(res.error)){ lawTblCol=false; return runPage(); }
    return res;
  }).then(function(res){
    if(res.error&&lawArtCol&&isNoArtCol(res.error)){ lawArtCol=false; return runPage(); }
    return res;
  }).then(function(res){
    if(!lawView||lawView.lawId!==id||lawView.page!==page) return;   /* 그새 다른 쪽으로 옮겼으면 버린다 */
    lawView.loading=false;
    if(res.error) lawView.err="쪽을 불러오지 못했어요: "+res.error.message;
    else {
      var rows=res.data||[], here=null, before=null, after=null;
      rows.forEach(function(r){
        if(r.page===page) here=r; else if(r.page===page-1) before=r; else if(r.page===page+1) after=r;
      });
      /* 저장된 글자가 옛 손질본일 수 있다. 손질은 두 번 해도 결과가 같으므로
       * 화면에 그리기 전에 한 번 더 건다 — 「다시 만들기」를 안 눌렀어도 깨끗하다.
       * (머리글의 법령 이름은 문서 전체를 봐야 알 수 있어 여기선 못 지운다) */
      lawView.content=here?cleanPdfText(here.content||""):"";
      lawView.article=here?(here.article||""):"";
      lawView.tbl=(here&&here.tbl!=null)?!!here.tbl:null;
      var e=edgeBits(before&&cleanPdfText(before.content||""),lawView.content,
                     after&&cleanPdfText(after.content||""));
      lawView.pre=e.pre; lawView.post=e.post;
    }
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
/* 제목은 80자까지 받는다. 40자로 재던 때는 시설기준령 「제5조(페니실린제제, 세팔로스포린제제,
 * 카바페넴제제, 모노박탐제제, 성호르몬제제 또는 세포독성 항암제제 작업소의 시설기준)」(61자)이
 * PDF 판에서도 통째로 빠져 있었다 (2026-09-08 법제처 판을 만들다 발견). */
var ART_RE=/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*\(\s*([^()]{1,80}?)\s*\)/g;
/* 별표: "■ 법령명 [별표 6의2] <개정 …> 의약품등 수입관리 기준 (제60조 관련)"
 * 별지: "[별지 제80호서식] <개정 …> 조사표"  — 서식 구역도 같은 방식으로 잡는다 */
/* 제목 부분은 선택으로 둔다 — 제목 뒤에 괄호가 없는 서식이 있는데,
 * 필수로 두면 그런 쪽에서 규칙이 통째로 실패해 머리말을 아예 못 찾는다. */
var BP_RE=/\[\s*별\s*(표|지)\s*(?:제\s*)?(\d+)(?:\s*의\s*(\d+))?\s*(?:호\s*서\s*식)?\s*\]\s*(?:<[^<>]{0,40}>\s*)?(?:([^()\[\]<>]{0,40}?)\s*(?=\(|\[|<|$))?/g;
/* 「[별표 N]」 뒤에 이것이 오면 머리말이 아니라 인용이다 */
var BP_CITE=/^(?:[,·、]|(?:및|또는|참조|이하)(?=\s|$)|(?:에|의|을|를|은|는|이|가|와|과|에서|에는|부터|까지)(?=\s|[,·]|$))/;
/* 「말한 다.」 — 줄이 낱말 한복판에서 접히면 「다.」가 목처럼 보인다.
 * **「다」는 목 글자이면서 동시에 서술어 어미**라 유독 위험하다. 다른 목 글자는
 * 앞이 「리·료·것·우」처럼 명사 끝이라 진짜 목이지만, 「다」 앞은 어간이 온다.
 * 실측: 「다.」가 한글 뒤에 오는 461곳 중 255곳이 어간 꼴(한 200 · 있 36 …).
 * 어간 뒤의 「다.」는 목으로 보지 않는다. */
var STEM_DA="한하되된있없인는운준논친킨린았었였웠";
function prevCh(t,i){
  for(var k=i-1;k>=0;k--){ if(!/\s/.test(t.charAt(k))) return t.charAt(k); }
  return "";
}
var HANG="①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
/* 지침서가 쓰는 글머리표. 07 사전GMP평가는 「ㅇ」(홑자음)를, 09·10은 「○」를 쓴다.
 * **네모(□ ■ ◇ ◆)는 뺀다** — 그건 글머리표가 아니라 점검표의 **체크칸**이다.
 * 넣었더니 07 한 문서에서만 433곳이 걸려 「□ 예 ■ 아니오」가 줄마다 쪼개졌다.
 * 실측(문서 10개): 이 목록으로 07은 249곳(문단당 171자), 06은 353곳(632자),
 * 08·09·10은 26~27곳. 법률·고시(01·02·04·05)는 0곳이라 손대지 않는다. */
var GBUL="○◦●▶ㅇ";

/* 이 자리의 「제N조(…)」가 문서 자신의 조문인지, 본문에 낀 인용인지 가른다.
 *
 * 「앞이 문장 끝인가」로 재봤더니 약사법이 235조 → 126조로 줄었다. 조 앞에는
 * <개정 …> 도 오고 "제3장 의약품등의 제조" 도 와서, 끝나는 모양이 너무 여러
 * 가지였다. 그래서 반대쪽 — 「뒤에 무엇이 오는가」 — 를 본다.
 *   진짜 조문   제3조(약국 개설등록) ① 약국을 개설하려는 자는 …
 *   인용        「약사법」 제31조(제조업 허가 등)에 따라 …
 * 인용은 뒤에 조사가 붙고, 진짜 조문은 본문이 시작된다. 조사는 종류가 정해져
 * 있어 셀 수 있다. 여기에 「법령명」 바로 뒤인지만 더 본다. */
var JOSA_RE=/^(에서|에도|에는|에게|부터|까지|이하|에|의|를|을|은|는|와|과|로|으로|나|랑)(?![가-힣])/;
function isCitedHere(text,at,end){
  var post=text.slice(end,end+8).replace(/^\s+/,"");
  if(JOSA_RE.test(post)) return true;                 /* "…) 에 따라" */
  var pre=text.slice(Math.max(0,at-24),at).replace(/\s+/g,"");
  if(/[」』】]$/.test(pre)) return true;                /* "「약사법」 제31조" */
  /* **「기준」은 뺐다.** 「…제6조 각 호의 기준 제8조(의약외품 제조소의 시설 기준)」처럼
   * 앞 조문이 「기준」으로 끝나면 다음 조가 통째로 사라졌다(시설기준령 제8조).
   * 법령 이름의 끝말만 남긴다. */
  if(/(법|규칙|영|고시|규정)$/.test(pre)) return true; /* "약사법 제31조" */
  return false;
}

/* 별표 제목으로 인정할 수 없는 말.
 * 고시의 별표는 제목이 괄호 안에 없고 그냥 뒤에 이어진다. 그래서 「[별표 N]
 * 뒤의 아무 괄호나」 잡으면 본문이 통째로 제목이 된다 —
 *   별표 1(무균의약품 제조 1. 범위 무균의약품의 제조는 다양한…)
 *   별표 14(에 기재되어 있다 . 8.6 습열 멸균 가 . 습열 멸균은 증기)
 * 제목이라면 문장이 아니다. 마침표·숫자 목록·조사로 시작하는 말은 버린다. */
function isBadTblTitle(t){
  var c=String(t||"").trim();
  if(!c) return true;
  if(/[.]\s|\d\s*\./.test(c)) return true;            /* 문장·번호 목록이 섞였다 */
  if(/^(을|를|이|가|은|는|에|의|와|과|로|으로)\s/.test(c)) return true;   /* 조사로 시작 = 문장 도막 */
  if(/[가-힣]\s+[가-힣]{1,2}\s*\./.test(c)) return true;  /* "… 가 ." 처럼 목 표시가 들어옴 */
  return false;
}

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
    if(isCitedHere(text,m.index,m.index+m[0].length)) continue;   /* 뒤에 조사가 붙으면 인용이다 */
    out.push({ at:m.index, end:m.index+m[0].length,
      label:"제"+m[1]+"조"+(m[2]?"의"+m[2]:"")+"("+title+")" });
    if(out.length>lim) break;
  }
  BP_RE.lastIndex=0;
  while((m=BP_RE.exec(text))!==null){
    /* **「[별표 5]」가 본문에 인용될 때를 조 시작으로 오인했다.**
     * 「「의약품 등의 안전에 관한 규칙」[별표 1], [별표 3], [별표 5] 및 관련…」에서
     * 세 개가 다 조 시작이 되어, 「별표 5」 전문이 문장 한복판에서 시작하고
     * 쪽 머리말이 「별표 12 (이어짐) ~ 별표 5」처럼 앞뒤가 뒤집혔다.
     * 대괄호 **바로 뒤가 조사·쉼표**면 인용이다 — 진짜 머리말 뒤에는 제목이 온다.
     * 낱말 경계를 반드시 본다: 「의」로만 재면 「[별표 1] 의약품 제조…」가 걸린다.
     * 실측: 05 고시 115곳 중 63곳 · 06 고시 44곳 중 6곳 · 03 규칙 104곳 중 0곳. */
    var br=m.index+m[0].indexOf("]")+1;
    if(BP_CITE.test(text.slice(br,br+14).replace(/^\s+/,""))) continue;
    var t2=(m[4]||"").replace(/\s+/g," ").trim();
    if(isBadTblTitle(t2)) t2="";      /* 제목이 아니면 번호만 쓴다 (별표 14) */
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
/* 「조」 「호」 「도」는 목 글자에도 있고 조문 인용의 끝말이기도 하다.
 * 「제 5 조 · 제 6 조 )」의 「조 )」를 세부 번호로 오인해 줄이 끊겼다.
 * 앞이 숫자면 인용의 꼬리다 — 목록 번호 앞에 숫자가 오는 일은 없다. */
function afterNum(t,i){
  for(var k=i-1;k>=0&&i-k<5;k--){
    var c=t.charAt(k);
    if(/\s/.test(c)) continue;
    return /\d/.test(c);
  }
  return false;
}

/* 목 표시로 실제 쓰이는 글자 (가나다… / 거너더… / 고노도…) */
var MOK="가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호";
var RUNHEAD_RE=/^(?:법제처\s*\d+\s*국가법령정보센터|■[^\[]{0,60}(?=\[))\s*/;  /* 쪽마다 반복되는 머리글 */

/* 별표 안의 절 제목 — "5.2 제조관리", "4.3 제품관리기준서" 꼴.
 * 길이는 한글 12자에서 끊는다. 뒤에 이어지는 본문까지 굵어지지 않게.
 * 괄호·중점은 세지 않는다 — PDF에서 뽑으면 "품질 ( 보증 ) 부서" 처럼
 * 괄호마다 빈칸이 끼어서, 글자 수로 세면 정작 제목의 끝말이 잘려 나간다
 * ("2.2 품질(보증) 부서 책임자" 에서 "책임자" 가 본문으로 밀려났었다). */
var SEC_RE=/^(\d{1,2}(?:\.\d{1,2}){1,2})\s+(?=[가-힣])/;
/* 소제목으로 볼 수 없는 말 — 본문 속 참조를 잡은 것이다.
 *   "별표 3 · 2.7.3 또는" · "별표 3 · 3.65 혈장" 처럼 문장 한복판이 걸린다. */
function isBadSecTitle(t){
  var c=String(t||"").replace(/^[\d.]+\s*/,"").trim();
  if(c.length<3) return true;                       /* 번호만 있거나 한두 글자 */
  if(/^(또는|및|그리고|다만|이때|경우|항과|호와)/.test(c)) return true;
  return false;
}
function secHeadLen(text,at){
  var m=SEC_RE.exec(text.slice(at,at+14));
  if(!m) return 0;
  var pos=at+m[0].length, len=m[0].length, title=0;
  while(pos<text.length&&title<12){
    /* **낱말을 빈칸으로만 끊으면 줄바꿈에서 뚫린다.** 이 함수는 손질 전 원문
     * (subHeads 가 넘기는 raw)에도 도는데, 거기엔 \n 이 들어 있다.
     * 그러면 「방지\n가.」가 한 낱말이 되어 「한 글자 목」 검사를 통과하고,
     * 라벨이 「5.2 제조 시 교차오염의 방지 가.」처럼 목까지 물고 나온다. */
    var mm2=/\s/.exec(text.slice(pos));
    var sp=mm2?pos+mm2.index:-1;
    var tok=(sp<0?text.slice(pos):text.slice(pos,sp));
    if(!tok||!/^[가-힣()ㆍ·]/.test(tok)) break;   /* "품질 ( 보증 ) 부서" 처럼 괄호가 낀 제목 */
    /* 다음이 목·호 표시면 제목 끝.
     * 문장부호 앞 빈칸을 지우면서 「가 .」가 「가.」 한 덩어리가 되는 바람에
     * 이 검사가 뚫려서, 「5.4 원 자재 및 제품의 관리 가.」처럼 목까지 제목에
     * 딸려 들어갔다. 마침표를 떼고 본다. */
    var bare=tok.replace(/[.)]+$/,"");
    if(bare.length===1&&MOK.indexOf(bare)>=0) break;
    if(/^\d{1,2}$/.test(bare)&&tok!==bare) break;   /* 「1.」 「2)」 같은 호 표시 */
    var han=(tok.match(/[가-힣]/g)||[]).length;   /* 괄호·중점은 안 센다 */
    if(title+han>12) break;
    title+=han; len+=tok.length+(sp<0?0:1);
    pos=(sp<0?text.length:sp+1);
  }
  return len;
}

/* 토막 첫머리의 소제목 — 「7. 공급관리 가 . 공급관리업무 …」에서 「7. 공급관리」.
 * 「5.2 제조관리」 꼴(SEC_RE)과 달리 점이 하나뿐이라 소제목으로 안 잡히던 것이다.
 * 뒤에 목(가 .)이나 호(1))가 바로 오는 짧은 말만 제목으로 본다 —
 * 「1) 문서는 기록일부터 …」 같은 본문 첫 줄을 제목으로 삼지 않기 위해서다. */
function chunkTitle(text){
  var m=/^\s*(\d{1,2})\s*\.\s*([가-힣][가-힣A-Za-z0-9()ㆍ·\s]{1,14}?)\s+(?=[가-힣]\s*\.\s|\d{1,2}\s*[).]\s)/.exec(String(text||""));
  if(!m) return "";
  var ti=m[2].replace(/\s+/g," ").trim();
  if(ti.length<2||isBadSecTitle(ti)) return "";
  return m[1]+". "+ti;
}

/* 그 자리에서 유효한 소제목 — 앞에서부터 훑어 마지막으로 나온 「N. 제목」.
 * 토막 경계는 길이로 자르니 소제목 경계와 안 맞는다. */
var SUBH_RE=/(?:^|[.\s])(\d{1,2})\s*\.\s*([가-힣][가-힣A-Za-z0-9()ㆍ·\s]{1,14}?)\s+(?=[가-힣]\s*\.\s|\d{1,2}\s*[).]\s)/g;
function chunkHead(text,upto){
  var m, last=""; SUBH_RE.lastIndex=0;
  while((m=SUBH_RE.exec(text))!==null){
    if(m.index>upto) break;
    var ti=m[2].replace(/\s+/g," ").trim();
    if(ti.length>=2&&!isBadSecTitle(ti)) last=m[1]+". "+ti;
  }
  return last;
}

/* 소제목이 없는 표 별표를 토막낸다. 호(1. 2. 3.)가 있으면 그 자리에서,
 * 없으면 문장 끝에서 끊는다. 라벨은 「1~3쪽」처럼 몇 번째 토막인지로 붙인다. */
function tblChunks(text){
  var pts=[0], i;
  /* 호 자리 — 앞이 공백, "12. " 꼴. 날짜와 헷갈리지 않게 두 자리까지만. */
  for(i=1;i<text.length;i++){
    if(!/\s/.test(text.charAt(i-1))) continue;
    if(/^\d{1,2}\s*\.\s/.test(text.slice(i,i+5))) pts.push(i);
  }
  /* 호가 너무 드물면(표가 아니라 줄글) 문장 끝에서 끊는다 */
  if(pts.length<3){
    pts=[0];
    for(i=1;i<text.length;i++) if(/다\s*\.\s/.test(text.slice(i,i+4))) pts.push(i+2);
  }
  /* 목표 길이에 닿을 때까지 모았다가 끊는다 — 토막이 잘게 부서지지 않게 */
  var out=[], last=0;
  for(i=1;i<pts.length;i++){
    if(pts[i]-last < TBL_CHUNK) continue;
    out.push(pts[i]); last=pts[i];
  }
  /* 끊을 자리가 드문 문서(표가 통째로 붙어 있는 별표)는 위 방법으로 거의
   * 안 잘린다. 그럴 땐 글자 수로 그냥 자른다 — 자리가 어긋나도 통짜보다 낫다. */
  if(out.length*TBL_CHUNK < text.length*0.5){
    out=[];
    for(var c=TBL_CHUNK;c<text.length;c+=TBL_CHUNK){
      /* 가까운 공백에서 끊어 낱말이 반 토막 나지 않게 */
      /* 줄바꿈도 끊을 자리다 — 빈칸만 찾으면 원문(raw)에서 못 찾고 그냥 자른다 */
      var mws=/\s/.exec(text.slice(c,c+200));
      var sp=mws?c+mws.index:-1;
      out.push(sp>=0?sp+1:c);
    }
  }
  if(!out.length) return [];
  var res=[{at:0,title:"1"}];
  out.forEach(function(at,k){ res.push({at:at,title:String(k+2)}); });
  return res;
}

/* 별표 안의 소제목 자리만 뽑는다 (쪼개기용). 화면 표시용 lawBreaks 와
 * 같은 판별(secHeadLen)을 쓰므로 굵게 보이는 줄과 쪼개지는 줄이 늘 일치한다. */
function subHeads(text){
  var skip=[], m; META_RE.lastIndex=0;
  while((m=META_RE.exec(text))!==null) skip.push([m.index,m.index+m[0].length]);
  function inSkip(i){ for(var k=0;k<skip.length;k++){ if(i>=skip[k][0]&&i<skip[k][1]) return true; } return false; }
  var out=[];
  for(var i=0;i<text.length;i++){
    if(!/\d/.test(text.charAt(i))) continue;
    if(i>0&&!/\s/.test(text.charAt(i-1))) continue;
    if(inSkip(i)) continue;
    /* "별표 1 제 7.1 호다목" 처럼 조문 참조 안의 숫자는 제목이 아니다 */
    if(text.slice(Math.max(0,i-3),i).replace(/\s+/g,"").slice(-1)==="제") continue;
    /* 소제목은 앞 문장이 끝난 자리에서 시작한다. 문장 한복판의 "2.7.3 또는"
     * 같은 참조를 걸러내는 가장 확실한 표시다. */
    var pre=text.slice(Math.max(0,i-40),i).replace(/\s+/g," ");
    if(pre.trim()&&!/[.。:]\s*$|다\s*\.\s*$/.test(pre)) continue;
    var len=secHeadLen(text,i);
    if(!len) continue;
    /* PDF에서 뽑으면 "품질 ( 보증 ) 부서" 처럼 괄호마다 빈칸이 낀다. 라벨에 쓸
     * 것이므로 여기서 붙여 준다 → "품질(보증) 부서" */
    var ti=text.slice(i,i+len).replace(/\s+/g," ")
      .replace(/\s*\(\s*/g,"(").replace(/\s*\)/g,")").trim();
    /* 괄호가 열린 채 끝나면 그 앞까지만 — "9.5 무균공정모의시험(" 같은 꼴 */
    if((ti.match(/\(/g)||[]).length>(ti.match(/\)/g)||[]).length) ti=ti.replace(/\([^)]*$/,"").trim();
    if(isBadSecTitle(ti)) continue;
    out.push({at:i,title:ti});
    i+=len;
  }
  /* 「5.2 제조관리」처럼 점이 둘인 것만 위에서 잡힌다. 「7. 공급관리」는 점이
   * 하나라 못 알아봐서 길이로 잘렸고, 그 바람에 토막이 소제목 한복판에서
   * 시작했다. 뒤에 목(가.)이나 호(1))가 바로 오는 것만 더 받는다 —
   * 「1. 문서는 기록일부터 …」 같은 호는 그 조건에 안 걸린다. */
  SUBH_RE.lastIndex=0;
  while((m=SUBH_RE.exec(text))!==null){
    var at2=m.index+(/^\d/.test(m[0])?0:1);      /* 앞 글자 한 칸을 건너뛴다 */
    if(inSkip(at2)) continue;
    var t2=m[2].replace(/\s+/g," ").trim();
    if(t2.length<2||isBadSecTitle(t2)) continue;
    var near=false;
    for(var z=0;z<out.length;z++) if(Math.abs(out[z].at-at2)<40){ near=true; break; }
    if(!near) out.push({at:at2,title:m[1]+". "+t2});
  }
  out.sort(function(x,y){ return x.at-y.at; });
  return out;
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
    /* 줄 첫머리 글머리표(· )는 지침서의 소제목이다(원문의 ○). 손질이 줄바꿈을
     * 넣어 뒀는데 화면을 그리는 쪽이 그걸 안 봐서, 「· 세척 및 오염제거」가
     * 문단 한복판에 끼어 있었다. 새 절로 끊는다. */
    if(ch==="·"&&(i===0||text.charAt(i-1)==="\n")){ pts.push({at:i,lv:0,len:0}); continue; }
    /* 제목 줄 **다음**도 새 문단이다 — 「· 교차오염방지」와 「세포은행은 오염 또는…」이
     * 한 덩어리로 붙어 있으면 제목이 본문에 묻힌다.
     * 제목은 짧고 마침표로 끝나지 않는다. 쪽 경계의 줄바꿈(문장 한복판)과 그것으로 가른다. */
    if(ch==="\n"&&i+1<text.length&&!inSkip(i+1)){
      var ls=text.lastIndexOf("\n",i-1)+1;
      var prev=text.slice(ls,i).replace(/\s+/g," ").trim();
      var ne=text.indexOf("\n",i+1); if(ne<0) ne=text.length;
      var next=text.slice(i+1,ne).replace(/\s+/g," ").trim();
      function isHead(t){ return !!t&&t.length<=40&&!/[.?!]$/.test(t); }
      /* 숫자로 시작하면 큰 제목이다 — 「2 보관시설」 「1-2 세포은행 시스템관리」.
       * 글머리표로 여는 소제목(「· 교차오염방지」)과 크기로 가른다. */
      if(isHead(next)) pts.push({at:i+1,lv:0,len:0,big:isBigHead(next)});
      else if(isHead(prev)) pts.push({at:i+1,lv:1,len:0});   /* 앞 줄이 제목 → 본문 시작 */
      continue;
    }
    if(HANG.indexOf(ch)>=0){ pts.push({at:i,lv:1,len:0}); continue; }
    /* **지침서 글머리표.** 법령은 항(①)·호(1.)·목(가.)으로 층을 나누지만 지침서는
     * ○ · ㅇ · ※ 를 쓴다. 이걸 안 끊으면 한 쪽이 통째로 한 문단이 되어 못 읽는다
     * (「· -1 서류평가 대상 ○ 우리 처의 … ※ 생략기간 기산 : … ○ PIC/S …」).
     * 앞뒤가 공백인 것만 본다 — 글 속의 ○ 는 대개 빈칸 없이 붙어 있다. */
    if(GBUL.indexOf(ch)>=0&&(i===0||/\s/.test(text.charAt(i-1)))&&/\s/.test(text.charAt(i+1)||" ")){
      pts.push({at:i,lv:1,len:0}); continue;
    }
    if(ch==="※"&&(i===0||/\s/.test(text.charAt(i-1)))){ pts.push({at:i,lv:2,len:0}); continue; }
    /* 호(1. 2.) · 목(가. 나.) — 앞이 공백이고 뒤가 공백인 것만.
     * PDF에서 뽑으면 "사 ." 처럼 점 앞에 공백이 끼기도 해서 허용한다.
     * 목 글자는 실제 쓰이는 것만 열거한다 — [가-하] 범위로 잡으면
     * 한글 거의 전부가 들어가서 "…한다 ." 같은 문장 끝까지 걸린다.
     * **글 맨 앞(i===0)도 받는다** — 쪽을 하나만 보여줄 때 그 쪽이 「다.」로
     * 시작하면 앞 글자가 없어 안 잡혔고, 그래서 「다.」만 맨 왼쪽에 남고
     * 「라.」부터 들여쓰기되어 층이 들쭉날쭉해 보였다. */
    /* 쪽 경계에서 「…증명하여야 한 / 다 . 또한」처럼 낱말이 잘리면 그 「다 .」가
     * 목으로 보인다. 줄바꿈 앞이 한글이면 이어지는 낱말이니 목이 아니다. */
    if(i>1&&text.charAt(i-1)==="\n"&&/[가-힣]/.test(text.charAt(i-2))) continue;
    if(i===0||/\s/.test(text.charAt(i-1))){
      var mm=/^(\d{1,2}|[\uAC00-\uD7A3])\s*\.\s/.exec(text.slice(i,i+6));
      if(mm){
        if(/^\d+$/.test(mm[1])) pts.push({at:i,lv:2,len:0});
        else if(MOK.indexOf(mm[1])>=0&&!afterNum(text,i)){
          /* 「…을 말한 다.」의 「다.」는 목이 아니라 잘린 낱말이다 */
          if(mm[1]==="다"&&STEM_DA.indexOf(prevCh(text,i))>=0){}
          else pts.push({at:i,lv:3,len:0});
        }
      } else {
        /* 목 아래 세부는 "1)" "가)" 꼴을 쓴다 */
        var m2=/^(\d{1,2}|[\uAC00-\uD7A3])\s*\)\s/.exec(text.slice(i,i+6));
        if(m2&&/^\d+$/.test(m2[1])) pts.push({at:i,lv:4,len:0});
        else if(m2&&MOK.indexOf(m2[1])>=0&&!afterNum(text,i)) pts.push({at:i,lv:4,len:0});
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
      /* 물음표·느낌표도 문장 끝이다. 점검표(별지 서식)는 「…적당한가?」처럼
       * 온 문장이 물음표로 끝나는데, 이걸 빼 놓았더니 목 하나의 마침표가
       * PDF에서 빠진 순간 그 뒤 라·마·바·사·아·자·차가 연쇄로 다 죽었다. */
      return ".?!)]>」』\u201D\"·;:".indexOf(c)>=0;
    }
    return true;                  /* 글 맨 앞 */
  }
  /* 세부 번호(1) 2) 3))도 차례를 따른다. 문장 속 인용은 그 차례를 어긴다 —
   * 「3) 2)후단에도 불구하고 …」에서 「2)」를 목록으로 오인해 줄이 끊기고
   * 「3)」만 덩그러니 남았다. 앞 번호보다 크거나 새 목록의 시작(1)일 때만 받는다. */
  var seq=0;
  function afterDot(at){          /* 앞의 빈칸을 건너뛴 실제 글자가 마침표류인가 */
    for(var k=at-1;k>=0;k--){
      var c=text.charAt(k);
      if(/\s/.test(c)) continue;
      return ".?!".indexOf(c)>=0;
    }
    return true;
  }
  out.forEach(function(p){
    if(p.lv<3){ expect=-1; seq=0; keep.push(p); return; }
    if(p.lv>3){
      var m4=/^(\d{1,2})\s*\)/.exec(text.slice(p.at,p.at+5));
      if(m4){
        var n=+m4[1];
        /* 앞이 마침표면 새 줄의 시작이니 차례를 어겨도 받는다. 앞 번호가 한 번
         * 잘못 잡히면(「제5호나목 7) 단서에」) 그 뒤가 통째로 죽기 때문이다.
         * 닫는 괄호는 문장 끝으로 치지 않는다 — 「3) 2)에 따른」의 「2)」가 통과한다. */
        if(seq&&n!==1&&n<=seq&&!afterDot(p.at)) return;
        seq=n; keep.push(p); return;
      }
      keep.push(p); return;                  /* 한글형(가) 나))은 그대로 */
    }
    seq=0;                                   /* 목이 바뀌면 세부 번호도 다시 센다 */
    var idx=MOK.indexOf(text.charAt(p.at));
    if(idx<0) return;
    /* 차례가 맞거나(가→나→다), 새 목록의 시작(가)이거나,
     * 앞이 문장 끝(…한다 .)이면 진짜 목이다.
     * "말한 다 ." 처럼 낱말 한복판에서 튀어나온 것만 걸린다. */
    if(expect<0||idx===expect||idx===0||afterEnd(p.at)){ expect=idx+1; keep.push(p); }
  });
  return softBreaks(text,keep);
}

/* 지침서처럼 항·호·목이 없는 글은 한 덩어리가 2천 자를 넘는다. 원문의 문단
 * 구분은 PDF에서 사라지므로, 긴 덩어리만 문장 경계에서 더 나눈다.
 * 「덩어리를 잡는」 lawBlockRange 는 이 지점을 무시한다(soft) — 무시하지 않으면
 * 항 전문을 복사할 때 문장 하나에서 잘린다. */
var SOFT_MIN=260;
function softBreaks(text,pts){
  var add=[];
  function fill(from,to,lv){
    if(to-from<SOFT_MIN*2) return;
    var re=/[.?!]\s+(?=[가-힣「『(\d])/g, m, last=from;
    re.lastIndex=from;
    while((m=re.exec(text))!==null&&m.index<to){
      var at=m.index+m[0].length;
      if(at-last>=SOFT_MIN&&to-at>=SOFT_MIN/2){ add.push({at:at,lv:lv,len:0,soft:true}); last=at; }
    }
  }
  if(!pts.length) fill(0,text.length,1);
  else{
    fill(0,pts[0].at,1);
    pts.forEach(function(p,i){ fill(p.at+(p.len||0),i+1<pts.length?pts[i+1].at:text.length,p.lv); });
  }
  if(!add.length) return pts;
  return pts.concat(add).sort(function(a,b){ return a.at-b.at||a.lv-b.lv; });
}

/* ---------- 복사·저장에 담을 「항 전문」 ----------
 * 발췌만 복사하면 「…에 관하여 이 법에서 규정한 것을 제외하고...」처럼 잘려서
 * 민원 답변에 그대로 붙일 수 없다. 검색어가 든 항(①)을 통째로 담고,
 * 검색어가 없는 항은 담지 않는다 — 없는 내용까지 딸려오면 오히려 방해다.
 * 별표처럼 항이 없는 글은 호(1.) · 목(가.) 순으로 내려가며 잡는다. */
var BLOCK_MAX=2600;              /* 이보다 긴 덩어리는 한 단계 잘게 */
function lawBlockRange(pts,len,at){
  for(var lv=1;lv<=3;lv++){
    var any=false, st=0, en=len;
    for(var i=0;i<pts.length;i++){
      if(pts[i].soft||pts[i].lv>lv) continue;
      any=true;
      if(pts[i].at<=at) st=pts[i].at; else { en=pts[i].at; break; }
    }
    if(any&&en-st<=BLOCK_MAX) return {st:st,en:en};
  }
  return sentRange(pts.text||null,at);
}
/* 지침서처럼 항·호·목이 없는 글 — 그래도 문장 한복판에서 끊기면 안 되니
 * 앞뒤 문장 경계까지는 넓힌다. 문서 열 개 중 지침서 두 개가 여기로 온다. */
var SENT_PAD=450;
function sentRange(text,at){
  if(!text) return null;
  function edge(i,dir){
    var lim=dir<0?Math.max(0,at-SENT_PAD):Math.min(text.length,at+SENT_PAD);
    for(var k=i;dir<0?k>lim:k<lim;k+=dir){
      var c=text.charAt(k);
      if(c==="\n") return dir<0?k+1:k;
      if(c==="."&&/\s/.test(text.charAt(k+1)||" ")) return dir<0?k+2:k+1;
    }
    return lim;
  }
  return {st:edge(at,-1),en:edge(at,1)};
}

/* 화면의 「원문 보기」와 같은 모양의 평문. 글자는 하나도 바꾸지 않고
 * 줄바꿈과 들여쓰기만 넣는다 — 붙여 넣으면 층이 그대로 보인다. */
var LP_PAD=["","    ","      ","        ","          "];
function lawPlain(text){
  var segs=gridSplit(text);
  if(segs.length>1||segs[0].rows)
    return segs.map(function(sg){ return sg.rows?gridRowsPlain(sg.rows):lawPlainText(sg.text); }).join("\n");
  return lawPlainText(text);
}
function lawPlainText(text){
  var pts=lawBreaks(text), lines=[], prev=0;
  function push(to,lv){
    var seg=text.slice(prev,to).replace(/\s+/g," ").trim();
    if(seg) lines.push(LP_PAD[Math.min(lv,4)]+seg);
  }
  if(!pts.length){ push(text.length,1); return lines.join("\n"); }
  if(pts[0].at>0) push(pts[0].at,1);
  pts.forEach(function(p,i){
    prev=p.at;
    push(i+1<pts.length?pts[i+1].at:text.length,p.lv);
  });
  return lines.join("\n");
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
  var html="", prev=0, prevLv=startLv, prevArt=0, prevSoft=false, prevBig=false;
  function push(to){
    var seg=text.slice(prev,to);
    /* 긴 글을 문장에서 나눈 자리(soft)는 새 절이 아니다 — 절 사이 가로줄을
     * 문단마다 그으면 답답하다. 소제목이 여는 절에만 긋는다. */
    if(seg.trim()) html+='<div class="lp '+LP_CLASS[prevLv]
      +(prevSoft?" lp-soft":"")+(prevBig?" lp-big":"")+'">'
      +lawSegHtml(seg,q,prevArt)+'</div>';
  }
  if(pts[0].at>0){
    /* 첫 덩어리에는 앞에 끊김이 없어 제목이어도 표시가 안 붙는다 — 쪽의 첫 줄이
     * 큰 제목일 때 그 줄만 밋밋해 보였다(「유전자변형생물체의 보관」).
     * 첫 덩어리도 제목인지 직접 본다. */
    var head0=text.slice(0,pts[0].at).replace(/\s+/g," ").trim();
    var isH=!!head0&&head0.length<=40&&!/[.?!]$/.test(head0);
    prev=0; prevLv=isH?0:startLv; prevArt=0; prevSoft=false; prevBig=isH&&isBigHead(head0);
    push(pts[0].at);
  }
  pts.forEach(function(p,i){
    prev=p.at; prevLv=p.lv; prevArt=p.len; prevSoft=!!p.soft; prevBig=!!p.big;
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
           page:0,pageEnd:0,loading:true,err:""};
  renderLawModal();
  function runArt(){
    return withAuthRetry(function(){
      return sb.from("law_articles")
        .select("id,law_id,label,page,page_end,content"+(lawTblCol?",tbl":"")).eq("id",artId);
    });
  }
  runArt().then(function(res){
    if(res.error&&lawTblCol&&isNoTblCol(res.error)){ lawTblCol=false; return runArt(); }
    return res;
  }).then(function(res){
    if(lawViewSeq!==seq) return;
    if(res.error) throw new Error("조문을 읽지 못했어요: "+res.error.message);
    var d=(res.data||[])[0];
    if(!d) throw new Error("조문을 찾지 못했어요. 「조문 다시 만들기」를 눌러보세요.");
    lawView.loading=false; lawView.lawId=d.law_id; lawView.art=d.label;
    lawView.text=cleanPdfText(d.content||""); lawView.page=d.page; lawView.pageEnd=d.page_end||d.page;
    lawView.tbl=(d.tbl==null?null:!!d.tbl);
    renderLawModal();
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
  return gridAwareHtml(lawView.text||"",lawTermList);
}

/* 표인 쪽 판별.
 * 줄글은 "~하여야 한다." 처럼 문장이 계속 끝나지만,
 * 표는 칸 값만 늘어서서 문장 끝이 거의 없다.
 * 실제 문서로 재본 값: 줄글 1,000자당 5~12개, 표 0~1개. */
/* 「다.」가 드문 것만으로는 부족하다 — 약사법 벌칙 조항(「…한 자」)이나
 * 개정 이력([종전 제29조는 …로 이동])까지 표로 오인해서, 쪽 1,223개 중
 * 20%가 표로 잡혔고 대부분 오판이었다.
 * 진짜 표는 **칸 값이 되풀이된다** — 「정지 1 개월 / 정지 3 개월 / 정지 6 개월」.
 * 두 잣대를 함께 보면 갈린다(진짜 표 53~62% · 벌칙 조항 23~40%).
 * 새 잣대로는 4%만 표로 보고, 잡힌 것은 전부 행정처분 표였다. */
function repRate(t){
  var w=String(t||"").split(/\s+/).filter(function(x){ return x.length>=2; });
  if(w.length<40) return 0;
  var c={}, dup=0;
  w.forEach(function(x){ c[x]=(c[x]||0)+1; });
  Object.keys(c).forEach(function(k){ if(c[k]>=3) dup+=c[k]; });
  return dup/w.length;
}
function looksLikeTable(t){
  if(!t||t.length<300) return false;
  var ends=(t.match(/다\s*\./g)||[]).length;
  return ends*1000/t.length<2 && repRate(t)>=0.5;
}

/* 재는 것은 「표인가」가 아니라 **「읽을 수 있는가」**다. 별지 제80호서식처럼
 * 오른쪽 칸이 비어 있는 표(체크 서식)는 글자만 뽑아도 안 섞여서 그냥 보여준다.
 * 별표 8처럼 칸마다 값이 차 있는 표만 뒤엉킨다 — 그때만 PDF로 보낸다. */
/* PDF의 선으로 짚어 둔 것이 있으면 그걸 믿고, 없으면(옛 자료) 글자로 짐작한다 */
function lvIsTable(){
  if(!lawView) return false;
  if(lawView.tbl!=null) return !!lawView.tbl;
  return looksLikeTable(lawView.mode==="art"?lawView.text:lawView.content);
}

function lvTableHtml(){
  return '<div class="lv-tblmsg">'
    + '<div class="lv-tblmsg-i">▤</div>'
    + '<p><b>칸이 뒤섞여 읽기 어려운 대목이에요.</b><br />표의 칸마다 값이 차 있어서, 글자만 도려내면 뒤엉켜 버려요.<br />'
    + '아래 <b>「PDF 원문 열기」</b>로 확인해 주세요.</p>'
    + '<button class="link-btn" data-act="lv-raw">그래도 글자로 보기</button>'
    + '</div>';
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
  else if(art) body=(lvIsTable()&&!lawView.raw)?lvTableHtml():lawArtBodyHtml();
  else if(!lawView.content) body='<p class="empty">이 쪽에는 글자가 없어요.<br />표나 그림만 있는 쪽일 수 있어요 — 아래 PDF 원문에서 확인해 주세요.</p>';
  else if(lvIsTable()&&!lawView.raw) body=lvTableHtml();
  else body='<div class="lv-text">'
    + (lawView.pre?'<div class="lv-edge lv-edge-pre">'+lawSegHtml(lawView.pre,lawTermList,0)+'</div>':"")
    + formatLawText(lawView.content,lawTermList)
    + (lawView.post?'<div class="lv-edge lv-edge-post">'+lawSegHtml(lawView.post,lawTermList,0)+'</div>':"")
    + '</div>';
  if(art&&!lawView.loading&&!lawView.err) body='<div class="lv-text">'+body+'</div>';

  if(art){
    var span=(lawView.page===lawView.pageEnd)?(lawView.page+"쪽")
            :(lawView.page+"~"+lawView.pageEnd+"쪽");
    /* 지침서는 조가 없어 라벨이 「34쪽」이다. 그 옆에 또 「34쪽」을 붙이면 같은 말이
     * 두 번이다 — 검색 결과 카드와 같은 규칙을 여기에도 건다. */
    var dup=String(lawView.art||"").indexOf(span)===0;
    artBar='<div class="lv-arts">'+lawArtHtml(lawView.art||"")+((lawView.page&&!dup)?'  ·  '+span:"")+'</div>';

    foot='<div class="lv-foot">'
      + '<button class="btn sm lv-pick" id="lv-pick" data-act="lv-pick" style="display:none"></button>'
      + ((l&&l.src==="api")
          ? '<span class="lv-src">법제처 '+esc(lawEffOf(l)||"")+' 시행판</span>'
            + '<button class="link-btn lv-pdf" data-act="lv-site">법제처에서 보기 ↗</button>'
          : '<button class="link-btn" data-act="lv-page">쪽 그대로 보기</button>'
            + '<button class="link-btn lv-pdf" data-act="lv-pdf">PDF 원문 열기 ↗</button>')
      + '</div>';
  } else {
    var arts=(!lawView.loading&&lawView.content)?findArticles(lawView.content):[];
    var head0=arts.length?arts[0].label:"", tail0=arts.length?arts[arts.length-1].label:"";
    if(lawView.article){ head0=lawView.article+" (이어짐)"; if(!tail0) tail0=head0; }
    if(head0) artBar='<div class="lv-arts">'+esc(head0)+(tail0!==head0?'  ~  '+esc(tail0):'')+'</div>';

    var max=(l&&l.pages)||1;
    foot='<div class="lv-foot">'
      + '<button class="btn quiet sm" data-act="lv-prev"'+(lawView.page<=1?" disabled":"")+'>‹ 이전 쪽</button>'
      + '<button class="btn quiet sm" data-act="lv-next"'+(lawView.page>=max?" disabled":"")+'>다음 쪽 ›</button>'
      + (arts.length||lawView.article?'<button class="link-btn" data-act="lv-art">이 조 전체 보기</button>':'')
      + '<button class="link-btn lv-pdf" data-act="lv-pdf">PDF 원문 열기 ↗</button>'
      + '</div>';
  }

  var pageLbl=art?(!lawView.page?"":(lawView.page===lawView.pageEnd)?(lawView.page+"쪽"):(lawView.page+"~"+lawView.pageEnd+"쪽"))
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

/* ---------- 결과 카드(한 목록) · 고르기 · 내보내기 ----------
 * AI 가 고른 조(lawAsk.picks)와 낱말·뜻으로 찾은 조(lawHits)를 **조 하나 = 카드 하나**로 합친다.
 * 같은 조가 양쪽에 있으면 카드 하나에 AI 판단과 발췌가 함께 붙는다. 체크는 lawSel 한 벌("a"+조문 id). */
function lawCards(){
  var by={}, order=[];
  function get(id,lawId,label){
    var k="a"+id;
    if(!by[k]){ by[k]={key:k,artId:id,lawId:lawId,art:label,ai:null,hit:null}; order.push(k); }
    return by[k];
  }
  if(lawAsk&&lawAsk.picks) lawAsk.picks.forEach(function(p){ get(p.id,p.lawId,p.label).ai=p; });
  (lawHits||[]).forEach(function(g){ var c=get(g.artId,g.lawId,g.art); c.hit=g; if(!c.art) c.art=g.art; });
  var usedOf=ansUsedMap(), cards=order.map(function(k){ return by[k]; });
  cards.forEach(function(c){
    var lo=S.laws.find(function(x){ return x.id===c.lawId; });
    c.kindN=lo?lawKindOf(lo).n:9; c.lawName=lawName(c.lawId);
    c.used=usedOf[ansUsedKey(c.lawName,c.art)]||0;
    c.rank=c.ai?askRank(c.ai.grade):9;
    c.sim=c.hit&&c.hit.sim!=null?c.hit.sim:0;
    c.page=c.hit?c.hit.page:0;
  });
  /* AI 만 고른 것 가운데 등급이 낮은 조는 접어 둔다 — 화면을 넘기지 않고도 볼 것부터 보이게 */
  var folded=lawAskMore?[]:cards.filter(function(c){ return c.ai&&!c.hit&&c.rank>ASK_KEEP&&!c.used; });
  var shown=cards.filter(function(c){ return folded.indexOf(c)<0; });
  shown.sort(function(a,b){
    if(a.kindN!==b.kindN) return a.kindN-b.kindN;
    if(a.lawName!==b.lawName) return a.lawName<b.lawName?-1:1;
    if(!!a.ai!==!!b.ai) return a.ai?-1:1;                 /* AI 가 고른 것 먼저 */
    if(a.ai&&b.ai&&a.rank!==b.rank) return a.rank-b.rank;
    if((a.used?1:0)!==(b.used?1:0)) return a.used?-1:1;
    if(a.sim!==b.sim) return b.sim-a.sim;
    return (a.page||0)-(b.page||0);
  });
  return {cards:shown,folded:folded};
}
/* 고른 카드. 하나도 안 골랐으면 보이는 것 전부(예전 규칙 그대로) */
function lawPicked(){
  var all=lawCards().cards;
  var sel=all.filter(function(c){ return lawSel[c.key]; });
  return sel.length?sel:all;
}
function lawSelCount(){ return lawCards().cards.filter(function(c){ return lawSel[c.key]; }).length; }
function lawSelAll(on){
  lawCards().cards.forEach(function(c){ if(on) lawSel[c.key]=true; else delete lawSel[c.key]; });
  renderLawResults();
}
/* 내보낼 글 — 발췌가 있는 카드는 항 전문, AI 만 고른 카드는 조문 원문을 표에서 받아 온다 */
function lawExportAll(then){
  var picked=lawPicked(); if(!picked.length){ showToast("내보낼 결과가 없어요."); return; }
  var need=picked.filter(function(c){ return !(c.hit&&c.hit.snips&&c.hit.snips.length); }).map(function(c){ return c.artId; });
  function build(by){
    var title=lawAsk?("민원 질문 — "+lawAsk.q):("법령 검색 결과 — "+(lawSem?lawSem.q:lawTermList.join(" + ")));
    var lines=[title,new Date().toLocaleString("ko-KR")+" · 조문 "+picked.length+"건",""], cur=null;
    var sub=0;
    picked.forEach(function(c){
      if(c.lawName!==cur){ cur=c.lawName; lines.push("■ "+cur); }
      /* 답변에 바로 붙일 수 있게 「가. 「법령」(종류) 조항에서, …」 머리줄을 먼저 둔다(2026-09-10 국민신문고 양식) */
      var lw=S.laws.find(function(l){ return l.name===c.lawName; });
      lines.push(" "+(ANS_HAN2[sub]||String(sub+1))+". 「"+c.lawName+"」"+ansKindTag(lw?lw.kind:"")+" "+(c.art||"")+"에서,"); sub++;
      if(c.ai&&c.ai.why) lines.push("  (고른 이유) "+c.ai.why);
      if(c.hit&&c.hit.snips&&c.hit.snips.length){
        c.hit.snips.forEach(function(h){
          if(h.full==="") return;
          if(h.full){ lines.push(h.full); return; }
          lines.push("    "+(h.where?"("+h.where+") ":"")+h.text);
        });
      } else {
        var a=by[String(c.artId)];
        lines.push(a?lawPlain(cleanPdfText(nfc(a.content||""))):"(원문을 불러오지 못했어요)");
      }
      lines.push("");
    });
    then(lines.join("\n"),picked.length);
  }
  if(!need.length){ build({}); return; }
  showToast("조문 원문을 불러오는 중...");
  withAuthRetry(function(){ return sb.from("law_articles").select("id,content").in("id",need); }).then(function(res){
    if(res.error){ showToast("불러오지 못했어요: "+res.error.message,true); return; }
    var by={}; (res.data||[]).forEach(function(a){ by[String(a.id)]=a; }); build(by);
  });
}
function lawCopy(){
  lawExportAll(function(t,n){
    var done=function(){ showToast("✓ "+n+"곳을 복사했어요"); };
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done,function(){ lawCopyFallback(t,done); });
    else lawCopyFallback(t,done);
  });
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
  lawExportAll(function(t){
    var blob=new Blob([t],{type:"text/plain;charset=utf-8"});
    var a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download="법령검색_"+keyOf(new Date())+".txt"; a.click();
  });
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

    + '<div class="law-help-sec"><div class="law-help-t">◆ 조문 앞의 색 표시는 「이걸 답변에 넣을까」예요</div>'
    +   '<p>AI 가 고른 조문마다 앞에 「인용 필수」 같은 <b>색 표시</b>가 붙어요. 뜻은 <b>답변서에 인용해야 하나</b>입니다. '
    +     '읽고 바로 정하시라고 「관련도 높음」 같은 말 대신 이걸 올렸어요.</p>'
    +   '<ul>'
    +     '<li><b>인용 필수</b> — 이 조를 안 적으면 답변이 성립하지 않아요</li>'
    +     '<li><b>있으면 좋음</b> — 근거를 두텁게 하지만 없어도 답은 됩니다</li>'
    +     '<li><b>없어도 됨</b> — 배경으로만 참고</li>'
    +   '</ul>'
    +   '<p>그 아래 작은 낱말 둘은 <b>왜 그렇게 봤는지</b>예요.</p>'
    +   '<ul>'
    +     '<li><b>이 조에서 무엇을 얻나</b><br />'
    +       '<span class="law-help-dim"><b>답 확인</b> — 이 조를 펴면 답이 나와요<br />'
    +       '<b>조건 확인</b> — 답은 아니고, 몇 년까지·누구에게 같은 <b>조건</b>이 적혀 있어요<br />'
    +       '<b>배경 확인</b> — 낱말 뜻·절차·벌칙만 있어요</span></li>'
    +     '<li><b>본문에서 근거를 찾았나</b> — 근거 찾음 &gt; 비슷한 대목만 &gt; 못 찾음<br />'
    +       '<span class="law-help-dim">「근거 찾음」은 조문 안에서 <b>그 대목을 짚을 수 있을 때만</b> 붙어요. '
    +       '그때는 왼쪽 설명에도 그 대목이 그대로 적힙니다.</span></li>'
    +   '</ul>'
    +   '<p><b>차례는 이 셋을 합쳐서 매깁니다</b> — 위에 있는 것부터 펴 보시면 돼요. '
    +     '아래쪽 관련 낮은 것은 접어 둡니다.</p>'
    +   '<p class="law-help-dim">찾는 순서 — ① 조 <b>제목</b>을 훑어 후보 20개를 추리고, '
    +     '② 민원 말을 법령 말로 바꾼 낱말로 본문을 뒤져 보태고, '
    +     '③ <b>뜻이 닿는 조문</b> 12개를 더 보탭니다(낱말이 달라도 찾아요). '
    +     '그다음 후보의 <b>조문을 통째로 읽어</b> 최종 10개로 추립니다.<br />'
    +     '아주 긴 조(정의 조항·별표가 붙은 것)는 앞 2,800자까지만 읽고 「뒤가 잘림」으로 알립니다.<br />'
    +     '<b>값이 아까우면 위에서 법령 범위를 좁히세요.</b> 값의 대부분은 ①에서 조 목록을 '
    +     '통째로 보내는 데 듭니다.</p>'
    + '</div>'
    + '<div class="law-help-sec"><div class="law-help-t">① 찾는 법</div>'
    +   '<ul>'
    +     '<li><b>낱말을 띄어 쓰면 「모두 들어 있는 곳」</b>만 나와요.<br />'
    +       '<code>냉장 운송</code> → 두 낱말이 <u>같은 조 안에</u> 다 있는 곳만.<br />'
    +       '결과가 너무 많으면 낱말을 하나 더 넣어 좁히세요.</li>'
    +     '<li><b>붙은 말 그대로</b> 찾으려면 따옴표로 묶어요. <code>"안전상비의약품"</code></li>'
    +     '<li>두 글자 이상이어야 찾아요. 최대 다섯 낱말.</li>'
    +     '<li>낱말 검색은 <b>법에 쓰인 말</b>로만 찾아요. <u>「타이레놀」로는 안 나옵니다</u> — '
    +       '법에는 「안전상비의약품」이라고 적혀 있으니까요.</li>'
    +     '<li><b>문장을 치고 Enter</b> 를 누르면 낱말이 아니라 <b>뜻이 가까운 조문</b> 20개를 보여줘요. AI 를 안 부르니 0원이에요. '
    +       '민원 글을 그대로 붙여넣어도 됩니다. 낱말로 하나도 안 나와도 뜻으로 한 번 더 찾아요.</li>'
    +     '<li><b>「관련 조문 찾아줘」</b>(✦)를 누르면 AI 가 조문을 실제로 읽고 <b>인용해야 할 것을 골라</b> 줘요. 한 번에 100~200원.</li>'
    +   '</ul></div>'

    + '<div class="law-help-sec"><div class="law-help-t">② 결과 읽는 법</div>'
    +   '<ul>'
    +     '<li><b>카드 하나 = 조 하나</b>예요. 한 조 안에서 검색어가 열 번 나와도 카드는 하나입니다.</li>'
    +     '<li>조각 앞의 <span class="law-help-chip">2호 나목</span> 같은 표시는 '
    +       '<b>그 조 안에서 몇 항·몇 호·몇 목인지</b>예요.</li>'
    +     '<li><b>카드를 누르면</b> 그 조 전체가 열려요. 조 하나가 통째로 나옵니다.</li>'
    +     '<li>열린 창 아래 — 법제처에서 받은 법령은 <b>「법제처에서 보기 ↗」</b>, PDF 로 올린 지침서는 <b>「쪽 그대로 보기」</b>·<b>「PDF 원문 열기 ↗」</b>가 있어요.</li>'
    +     '<li>왼쪽 <b>체크박스</b>로 고른 뒤 <b>복사</b>·<b>텍스트로 저장</b>하면 모아서 가져갑니다.</li>'
    +   '</ul></div>'

    + '<div class="law-help-sec"><div class="law-help-t">③ 알아두면 헷갈리지 않는 것</div>'
    +   '<ul>'
    +     '<li><b>같은 조가 두 번 나올 때가 있어요.</b> '
    +       '<u>아직 시행 전인 개정 조문</u>은 이름 뒤에 <code>· 시행 2027. 1. 1.</code> 처럼 날짜가 붙어 있어요. '
    +       '그쪽이 <b>앞으로 바뀔 내용</b>이고, 날짜 없는 쪽이 지금 적용되는 조문입니다. 중복이 아니에요.</li>'
    +     '<li><b>법제처에서 받은 법령의 별표는 표가 칸 그대로 나와요.</b> 행정처분 기준처럼 칸이 많은 표도 그렇습니다. '
    +       'PDF 로 올린 지침서의 표는 여전히 한 줄로 이어져 보이니 「PDF ↗」로 확인하세요.</li>'
    +     '<li><b>별표·별지도 조처럼 찾아져요.</b> '
    +       '<span class="law-help-chip">별표 8(행정처분의 기준)</span> 처럼 나옵니다.</li>'
    +     '<li><b>법령·고시는 법제처에서 이름으로 받아요.</b> 개정되면 법령 목록의 <b>「조문 전부 다시 만들기」</b> 한 번으로 최신판이 따라와요. '
    +       '지침서·안내서만 PDF 로 올립니다.</li>'
    +     '<li><b>공개 법령·지침서만</b> 올려주세요. 민원인 정보나 내부 검토 문서는 올리지 않습니다.</li>'
    +   '</ul></div>'
    + '</div>';
}


/* ========== 민원 답변 초안 ==========================================
 * 법령 탭에서 고른 조문으로 답변 초안을 만들고, 「민원 답변」 탭에 쌓는다.
 *
 * **AI 는 답변을 쓰지 않는다.** 요지 한 문장(summary)과 실무 참고(help)만
 * 만들고, 조문 원문과 형식(1./가. · 머리말 · 맺음말)은 여기서 붙인다.
 * 그래서 답변의 몸통은 통째로 원문 복사라 AI 가 법을 고쳐 쓸 자리가 없다.
 * 형식을 바꿔도 AI 를 다시 부르지 않는다 — 돈만 나가고 결과는 같다.
 * ------------------------------------------------------------------ */

var ansDraft=null;    /* 열려 있는 초안 창 {q,cites,summary,help,mode,busy,err,krw,id} */
var ansFmtOpen=false; /* 형식 설정을 펼쳤나 */
var ansOpenId=null;   /* 「민원 답변」 탭에서 펼친 기록 */

/* 한글 항목 기호 — 「하」 다음은 단모음 순(편람 59쪽) */
var ANS_HAN="가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허".split("");
function ansMark(i){
  if(!ansFmt.hangul) return (i+1)+".";
  return (ANS_HAN[i]||String(i+1))+".";
}

/* 형식은 고칠 수 있게 둔다. 기관·과마다 쓰는 말이 다르고, 쓰다 보면
 * 바꾸고 싶어진다. 기본값은 「2025 행정업무운영 편람」 기준이다. */
var ANS_FMT0={
  /* 양식 둘. sinmungo = 국민신문고 답변(이랑님이 2026-09-10 「고친 글」로 보여주신 꼴 — 인사·요지·검토 결과 가.나.다.·담당자).
     classic = 편람식(요지 한 줄 → 조문 → 맺음말). 이랑님: 「고친 글 양식은 내가 손댄 거니까 괜찮은 거고」. */
  style:"sinmungo",
  intro:"안녕하십니까? 귀하께서 국민신문고를 통해 신청하신 민원(신청번호 {신청번호})에 대한 검토 결과를 다음과 같이 알려드립니다.",
  ask:"귀하께서 제출하신 민원의 내용은 '{주제}'에 대한 질의로 이해됩니다.",
  review:"귀하의 민원에 대한 검토 결과는 다음과 같습니다.",
  citeS:"「{법령명}」{종류} {조항}에서, ",
  close:"답변내용에 대한 추가 설명이 필요한 경우 식품의약품안전처 {담당과} {직위}({연락처})에게 연락주시면 안내해 드리도록 하겠습니다. 감사합니다.",
  dept:"", who:"주무관", phone:"",
  hangul:false,   /* (편람식) false = 1. 2. 3. · true = 가. 나. 다. */
  brief:true,     /* true = AI 가 짚고 원문과 대조해 통과한 핵심 문장(없는 조는 전체) · false = 늘 조문 전체 */
  end:true,       /* 끝. 표시 (규칙 제4조제5항) */
  head:"귀하께서 주신 내용은 {요지}(으)로 이해되며, 이에 대한 답변입니다.",
  cite:"「{법령명}」 {조항}에 따라",
  /* 「따라야 함을 알려드리니」는 위압적으로 읽힌다 — 편람 76쪽이 그런 문구를
   * 쓰지 말라고 한다. 「이러한 규정이 있다」는 사실만 전하고 판단은 넣지 않는다. */
  tail:"따라서 문의하신 사항은 위 조항에 규정되어 있음을 알려드리며, 업무에 참고하시기 바랍니다."
};
var ansFmt=(function(){
  var f={}, k;
  for(k in ANS_FMT0) f[k]=ANS_FMT0[k];
  try{
    var raw=localStorage.getItem("ansFmt");
    if(raw){ var got=JSON.parse(raw); for(k in ANS_FMT0) if(got[k]!=null) f[k]=got[k]; }
  }catch(e){}
  return f;
})();
var ansFmtTimer=null;
function ansFmtSave(){
  try{ localStorage.setItem("ansFmt",JSON.stringify(ansFmt)); }catch(e){}
  /* 기기 사이에 같게 — 설정 표에도 둔다. 글쇠마다 올리지 않게 잠깐 모아서. */
  clearTimeout(ansFmtTimer);
  ansFmtTimer=setTimeout(function(){ if(typeof sb!=="undefined"&&sb) setPut("ans_fmt",JSON.stringify(ansFmt)); },900);
}
/* 앱이 켜질 때 설정 표의 형식이 있으면 그것으로 덮는다(아이패드에서 고친 것이 맥에도) */
function ansFmtLoadRemote(){
  try{ var raw=setGet("ans_fmt"); if(!raw) return; var got=JSON.parse(raw), k; for(k in ANS_FMT0) if(got[k]!=null) ansFmt[k]=got[k]; }catch(e){}
}

/* ---------- 고른 조문 모으기 ---------- */
/* 저장에는 id 를 안 쓴다 — 「조문 전부 다시 만들기」를 누르면 id 가 새로 생겨
 * 쌓아둔 기록이 통째로 미아가 된다. 이름과 조 번호는 안 바뀐다. */
function ansNumOf(label){
  var m=/^(제\s*\d+\s*조(?:\s*의\s*\d+)?)/.exec(nfc(label||""));
  return m?m[1].replace(/\s+/g,""):nfc(label||"");
}
/* ---------- 전에 답변에 쓴 조문 ---------- */
/* 「민원 답변」에 담긴 근거 조문을 센다. 그 조문이 다시 나오면 검색·AI 결과에서
 * **위로 올리고 「답변에 씀」을 붙인다** — 한 번 근거로 삼은 조문은 다음 민원에서도
 * 근거일 확률이 높고, 그때 무엇을 인용했는지 바로 떠올릴 수 있다.
 * 열쇠는 id 가 아니라 **이름+조 번호**다. 조문 id 는 「조문 전부 다시 만들기」마다
 * 새로 생기므로 답변에도 id 는 없다(ansSave 참고). 새 버튼은 없다 — 저장된 답변이
 * 곧 신호다. */
function ansUsedKey(law,label){ return nfc(law||"").replace(/\s+/g,"")+"|"+ansNumOf(label); }
function ansUsedMap(){
  var m={};
  (S.answers||[]).forEach(function(a){
    (a.cites||[]).forEach(function(c){
      var k=ansUsedKey(c.law,c.num||c.label); m[k]=(m[k]||0)+1;
    });
  });
  return m;
}
function ansUsedCount(law,label){ return ansUsedMap()[ansUsedKey(law,label)]||0; }
/* 칩 하나. 횟수는 두 번째부터 적는다 — 「1번 씀」은 「씀」과 같은 말이다. */
/* 조 이름 「별표 17 · 5.2 제조 시 교차오염의 방지」의 가운뎃점을 세로줄로 그린다(이랑님 2026-09-09).
   저장된 라벨은 그대로고(검색·복사·답변은 「·」 그대로) 화면만 바꾼다 — 첫 「·」만, 뒤의 「·」은 제목 안의 것일 수 있다. */
function lawArtHtml(label){
  var t=String(label||""), i=t.indexOf(" · ");
  if(i<0) return esc(t);
  return esc(t.slice(0,i))+'<span class="law-art-sep">|</span>'+esc(t.slice(i+3));
}
function ansUsedChip(n){ return n?'<span class="law-used" title="「민원 답변」에 근거로 담은 조문">답변에 '+(n>1?n+'번 ':'')+'씀</span>':''; }
/* 고른 카드에서 근거 조문 묶음을 만든다. 발췌가 있는 카드(낱말 검색)는 검색어가 든 항 전문을,
 * 그 밖(AI · 뜻)은 조문 원문을 표에서 받아 온다. AI 근거 문장(quote)은 핵심 구절로 쓴다. */
function ansCitesAll(then){
  var picked=lawPicked(); if(!picked.length){ showToast("담아 갈 조문이 없어요."); return; }
  var q=(lawAsk&&lawAsk.q)||(lawSem&&lawSem.q)||lawTermList.join(" ");
  var need=picked.filter(function(c){ return !(c.hit&&c.hit.snips&&c.hit.snips.some(function(h){ return h.full; })); }).map(function(c){ return c.artId; });
  function build(by){
    var out=[], seen={};
    picked.forEach(function(c){
      var lo=S.laws.find(function(x){ return x.id===c.lawId; }), text="", table=false;
      var a=by[String(c.artId)];
      if(a){ text=lawPlain(cleanPdfText(nfc(a.content||""))); table=!!a.tbl; }
      else if(c.hit){
        var txt=[]; c.hit.snips.forEach(function(h){ if(h.full) txt.push(h.full); });
        if(!txt.length) c.hit.snips.forEach(function(h){ if(h.text) txt.push(h.text); });
        text=txt.join("\n").trim(); table=!!c.hit.table;
      }
      var k=lawBare(c.lawName)+"|"+ansNumOf(c.art); if(seen[k]) return; seen[k]=1;
      out.push({ law:c.lawName, kind:lo?lawKindOf(lo).t:(c.ai&&c.ai.kind)||"", num:ansNumOf(c.art), label:nfc(c.art||""),
                 text:text, quote:nfc((c.ai&&c.ai.quote)||""), table:table, artId:c.artId, lawId:c.lawId, pick:lawKeyPick[String(c.artId)]||"" });
    });
    if(!out.length){ showToast("담아 갈 조문이 없어요."); return; }
    then(out,q);
  }
  if(!need.length){ build({}); return; }
  showToast("조문 원문을 불러오는 중...");
  withAuthRetry(function(){ return sb.from("law_articles").select("id,law_id,label,content,tbl").in("id",need); }).then(function(res){
    if(res.error){ showToast("불러오지 못했어요: "+res.error.message,true); return; }
    var by={}; (res.data||[]).forEach(function(a){ by[String(a.id)]=a; }); build(by);
  });
}

/* ---------- 초안 창 열기 ---------- */
function ansStart(cites,q){
  if(!cites||!cites.length){ showToast("근거 조문을 하나 이상 골라주세요."); return; }
  ansDraft={ q:q||"", cites:cites, summary:"", help:"", mode:"plain",
             busy:false, err:"", krw:0, id:null, made:false };
  render();
}

/* ---------- 초안 만들기 (AI 는 요지·참고만) ---------- */
function ansMake(){
  var d=ansDraft; if(!d||d.busy) return;
  var q=(document.getElementById("ans-q")||{}).value;
  if(q!=null) d.q=q;
  if(!String(d.q||"").trim()){ showToast("민원 내용을 적어주세요."); return; }
  d.busy=true; d.err=""; render();
  /* 비슷한 지난 답변(조문 찾기가 찾아 둔 것)의 글을 본보기로 함께 보낸다 — 이랑님이 고친 글이 있으면 그것 */
  var examples=((lawAsk&&lawAsk.similar)||[]).map(function(x){
    var a=S.answers.find(function(y){ return y.id===x.id; }); if(!a) return null;
    var t=String(a.final||a.draft||"").trim(); return t.length>=40?{title:a.title||"",text:t.slice(0,1800)}:null;
  }).filter(Boolean).slice(0,2);
  sb.functions.invoke("law-draft",{body:{
    q:d.q, mode:"help",     /* 늘 둘 다 만든다 — 나란히 보여주기로 했다 */
    rules:setGet("ai_rules"), examples:examples,
    cites:d.cites.map(function(c){ return {law:c.law,num:c.num,text:c.text}; })
  }}).then(function(r){
    d.busy=false;
    var v=r&&r.data;
    if(r&&r.error){ d.err=String(r.error.message||r.error); render(); return; }
    if(!v||v.error){ d.err=(v&&v.error)||"응답이 비어 있어요."; render(); return; }
    d.summary=v.summary||""; d.title=v.title||""; d.topic=v.topic||""; d.help=v.help||""; d.krw=v.krw||0; d.made=true;
    /* 조문마다 AI 가 짚고 서버가 원문과 대조한 핵심 문장. 없는 조는 "" → 그 조는 전체를 넣는다 */
    (v.keys||[]).forEach(function(k,i){ if(d.cites[i]) d.cites[i].key=k||""; });
    d.cites.forEach(function(c){ if(c.pick) c.key=c.pick; });   /* 사람이 끌어 고른 문장이 있으면 그것 */
    d.keysDropped=v.keysDropped||0;
    d.final=ansText(d.mode||"plain"); d.gen=d.final;
    d.dropped=!!v.dropped;
    render();
  },function(e){ d.busy=false; d.err=String(e&&e.message||e); render(); });
}

/* ---------- 조립 ---------- */
/* {t:글, lv:층} 목록으로 만든다. lv 는 화면·복사·한글 파일이 함께 쓴다.
 * lv 9 는 여백·구분선처럼 층이 없는 줄이다. */
function ansCiteLines(text){
  var out=[];
  String(text||"").split("\n").forEach(function(L){
    var pad=/^\s*/.exec(L)[0].length;
    var t=L.trim(); if(!t) return;
    /* lawPlain 이 넣은 들여쓰기(4·6·8칸)를 층으로 되읽는다 */
    out.push({ t:t, lv: pad>=8?3 : pad>=6?2 : 1 });
  });
  return out;
}
/* 조문 전체를 구구절절 붙이면 답변이 길고 읽히지 않는다(이랑님: 「핵심 구절만 남기는 게 좋을 듯」).
 * 근거 문장 하나를 고른다 — ① AI 가 원문과 대조해 짚은 근거 문장 ② 없으면 검색 낱말이 가장 많이
 * 든 문장 ③ 그것도 없으면 첫 문장. 항·호·목 표시(① 1. 가.)와 소제목(8.2 포장공정관리)은 뗀다. */
function ansKeyLine(c){
  /* 규칙으로 문장을 고르면 엉뚱한 것이 잡힌다(제2조에서 「다만…」 단서를 골랐다). **확인된 근거 문장이
   * 있을 때만** 쓰고, 없으면 null — 그 조는 전체를 넣는다. 이랑님: 「AI 가 잘 찾은 게 아닐 수도 있으니
   * 내가 조문 전체를 보고 다듬는 게 맞을 수도」. */
  var q=String(c.key||"").replace(/\s+/g," ").trim();
  if(q.length<12) return null;
  return q.replace(/^\s*제\s*\d+\s*조(?:\s*의\s*\d+)?\s*\([^()]{1,80}\)\s*/,"")
          .replace(/^\s*(?:[\u2460-\u2473]|\d{1,2}(?:\.\d+)*\.?|[가-힣]\.|[가-힣]\))\s*/,"").trim();
}
/* 법령 말투 → 공문 말투. 끝만 바꾼다(편람: 「하시기 바랍니다」 꼴). */
/* 국민신문고 양식의 조문 문장: 원문을 그대로 두고 「…고 규정하고 있습니다」로 감싼다(간접 인용).
 * 이랑님(2026-09-10): 「안녕하다 → 안녕하세요 정도의 수정은 해야 하는데 원문에서 의미가 벗어나면 안 돼」
 * 「할 수 있다가 조문에 박혀 있으면 그대로 차용해도 상관없어」. 「…다」「…것」으로 안 끝나면 ansPolite 로. */
function ansQuoteForm(t){
  t=String(t||"").trim().replace(/\.$/,"");
  if(/다$/.test(t)) return t+"고 규정하고 있습니다.";
  if(/것$/.test(t)) return t+"을 규정하고 있습니다.";
  /* 목록 항목(「제조소 이전·추가하는 경우」「…이력이 없는 작업소」)은 문장이 아니라 그대로 두면 「…경우.」로 끝나 어색하다
     (2026-09-10 실측). 원문을 「」로 감싸 인용한다 — 글자는 그대로다. */
  return "「"+t+"」이라고 규정하고 있습니다.";
}
var ANS_KIND_TAG={"고시":"(식약처 고시)","총리령":"(총리령)","대통령령":"(대통령령)","부령":"(부령)"};
function ansKindTag(k){ return ANS_KIND_TAG[k]||""; }
function ansPolite(t){
  t=String(t||"").trim().replace(/\.$/,"");
  var r=[[/할 것$/,"하여야 합니다"],[/있을 것$/,"있어야 합니다"],[/일 것$/,"이어야 합니다"],[/것$/,"것입니다"],
         [/한다$/,"합니다"],[/된다$/,"됩니다"],[/있다$/,"있습니다"],[/없다$/,"없습니다"],[/이다$/,"입니다"],[/하다$/,"합니다"],[/않는다$/,"않습니다"],[/아니한다$/,"아니합니다"],[/한다\)$/,"합니다)"]];
  for(var i=0;i<r.length;i++){ if(r[i][0].test(t)) return t.replace(r[i][0],r[i][1])+"."; }
  return t+".";
}
/* 참고 붙이기·형식이 바뀌면 초안 글을 새로 만든다. 손으로 고친 글(final≠gen)이 있으면 먼저 묻는다. */
function ansRegen(force){
  var d=ansDraft; if(!d||!d.made) return;
  var fa=document.getElementById("ans-final"); if(fa) d.final=fa.value;
  if(!force&&d.final&&d.gen&&d.final!==d.gen&&!confirm("초안을 손으로 고친 게 있어요. 새로 만든 글로 바꿀까요?\n(취소하면 고친 글을 그대로 둡니다)")) return;
  d.final=ansText(d.mode||"plain"); d.gen=d.final;
}
var ANS_HAN2=["가","나","다","라","마","바","사","아","자","차","카","타","파","하"];
function ansTopicOf(d){
  var t=String(d.topic||"").trim(); if(t) return t;
  t=String(d.title||"").replace(/\s*·\s*/g," ").trim(); if(t) return t;
  return String(d.summary||"").replace(/\s*(?:에\s*관한\s*것|에\s*대한\s*것)\s*$/,"").trim()||"(주제)";
}
function ansBlocksSinmungo(mode){
  var d=ansDraft, out=[], n=1, sub=0;
  var fill=function(t){
    return String(t||"").replace("{신청번호}",d.appno||"____________").replace("{주제}",ansTopicOf(d))
      .replace("{담당과}",ansFmt.dept||"○○과").replace("{직위}",ansFmt.who||"주무관").replace("{연락처}",ansFmt.phone||"000-000-0000");
  };
  out.push({t:(n++)+". "+fill(ansFmt.intro),lv:0}); out.push({t:"",lv:9});
  out.push({t:(n++)+". "+fill(ansFmt.ask),lv:0}); out.push({t:"",lv:9});
  out.push({t:(n++)+". "+fill(ansFmt.review),lv:0}); out.push({t:"",lv:9});
  d.cites.forEach(function(c){
    var head=ansFmt.citeS.replace("{법령명}",c.law).replace("{종류}",ansKindTag(c.kind)).replace("{조항}",c.label||c.num);
    var mark=(ANS_HAN2[sub]||String(sub+1))+". "; sub++;
    if(c.table){
      out.push({t:mark+head.replace(/,\s*$/,"")+" 다음과 같이 규정하고 있습니다.",lv:1});
      out.push({t:"(칸이 뒤섞여 읽기 어려운 대목입니다. PDF 원문에서 확인해 붙여 넣어주세요.)",lv:2});
    } else if(ansFmt.brief&&ansKeyLine(c)){
      out.push({t:mark+head+ansQuoteForm(ansKeyLine(c)),lv:1});
    } else {
      out.push({t:mark+head.replace(/,\s*$/,"")+" 다음과 같이 규정하고 있습니다.",lv:1});
      ansCiteLines(c.text).forEach(function(x){ out.push({t:x.t,lv:Math.min(3,(x.lv||0)+2)}); });
    }
    out.push({t:"",lv:9});
  });
  if(mode==="help"&&d.help){
    /* AI 참고는 「- 참고로, …」 줄로 마지막 항목 아래에 — 이랑님 고친 글의 자리 그대로 */
    var hs=String(d.help).split(/\n+/).map(function(h){ return h.replace(/^\s*[○o]\s*/,"").trim(); }).filter(Boolean);
    hs.forEach(function(h,i){ out.push({t:(i?"- ":"- 참고로, ")+h,lv:2}); });
    if(hs.length) out.push({t:"",lv:9});
  }
  out.push({t:(n++)+". "+fill(ansFmt.close)+(ansFmt.end?"  끝.":""),lv:0});
  return out;
}
function ansBlocks(mode){
  var d=ansDraft; if(!d) return [];
  if(ansFmt.style!=="classic") return ansBlocksSinmungo(mode);
  var out=[], n=0;
  out.push({t:ansMark(n++)+" "+ansFmt.head.replace("{요지}",d.summary||"(요지)"),lv:0});
  d.cites.forEach(function(c){
    out.push({t:"",lv:9});
    var headLine=ansMark(n++)+" "+ansFmt.cite.replace("{법령명}",c.law).replace("{조항}",c.label||c.num);
    if(c.table){
      /* 표로 된 대목은 글자를 안 보여준다 — 칸이 뒤섞여 읽을 수 없다 */
      out.push({t:headLine,lv:0}); out.push({t:"",lv:9});
      out.push({t:"(칸이 뒤섞여 읽기 어려운 대목입니다. PDF 원문에서 확인해 붙여 넣어주세요.)",lv:1});
    } else if(ansFmt.brief&&ansKeyLine(c)){
      /* 「N. 「법령」 조항에 따라 ~하여야 합니다.」 한 문단 — 확인된 근거 문장이 있는 조만 */
      out.push({t:headLine+" "+ansPolite(ansKeyLine(c)),lv:0});
    } else {
      out.push({t:headLine,lv:0}); out.push({t:"",lv:9});
      ansCiteLines(c.text).forEach(function(x){ out.push(x); });
    }
  });
  out.push({t:"",lv:9});
  out.push({t:ansMark(n++)+" "+ansFmt.tail+(ansFmt.end?"  끝.":""),lv:0});
  if(mode==="help"&&d.help){
    out.push({t:"",lv:9});
    out.push({t:"────────────────────────────────",lv:9});
    out.push({t:"⚠ 아래는 AI가 만든 참고 의견입니다. 검토 후 지우거나 고쳐 쓰세요.",lv:9});
    out.push({t:"────────────────────────────────",lv:9});
    out.push({t:"",lv:9});
    String(d.help).split(/\n+/).forEach(function(h){
      if(h.trim()) out.push({t:h.trim(),lv:1});
    });
  }
  return out;
}
var ANS_PAD=["","  ","    ","      ",""];
function ansText(mode){
  return ansBlocks(mode).map(function(b){
    return b.lv>=9?b.t:(ANS_PAD[Math.min(b.lv,3)]+b.t);
  }).join("\n");
}

/* ---------- 내보내기 ---------- */
/* 초안 글(고친 것 포함)을 그대로 내보낸다 */
function ansFinalText(){ var fa=document.getElementById("ans-final"); return (fa?fa.value:(ansDraft&&ansDraft.final)||"")||""; }
function ansFinalBlocks(){
  return ansFinalText().split("\n").map(function(L){
    var pad=/^\s*/.exec(L)[0].length, t=L.trim();
    if(!t) return {t:"",lv:9};
    return {t:t,lv:pad>=8?3:pad>=6?2:pad>=4?1:0};
  });
}
function ansCopy(mode){
  var t=ansFinalText();
  var done=function(){ showToast("✓ 초안을 복사했어요"); };
  if(navigator.clipboard&&navigator.clipboard.writeText)
    navigator.clipboard.writeText(t).then(done,function(){ lawCopyFallback(t,done); });
  else lawCopyFallback(t,done);
}
function ansFileName(ext){
  var d=ansDraft, base=(d&&d.summary?d.summary:(d&&d.q)||"민원답변").slice(0,24);
  return "민원답변_"+base.replace(/[^가-힣a-zA-Z0-9]/g,"")+"_"+keyOf(new Date())+"."+ext;
}
function ansTxt(mode){
  var blob=new Blob([ansFinalText()],{type:"text/plain;charset=utf-8"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=ansFileName("txt"); a.click();
}
function ansHwpx(mode){
  try{
    var buf=hwpxMake(ansFinalBlocks(),(ansDraft&&ansDraft.summary)||"민원 답변 초안");
    var a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([buf],{type:"application/hwp+zip"}));
    a.download=ansFileName("hwpx"); a.click();
    showToast("✓ 한글 파일로 받았어요");
  }catch(e){ showToast("한글 파일을 만들지 못했어요: "+(e&&e.message||e),true); }
}

/* ---------- 저장 ---------- */
/* 목록 제목은 핵심 낱말 두셋(AI 가 낸 title). 없으면(옛 함수·되받기) 요지에서 「에 관한 것」을 떼고 40자에서 자른다. */
function ansTitle(d){
  var t=String(d.title||"").trim(); if(t.length>=6) return t.slice(0,40);
  var sm=String(d.summary||"").replace(/\s*(?:에\s*관한\s*것|에\s*대한\s*것)\s*$/,"").trim();
  var base=sm||String(d.q||"").trim()||"민원 답변";
  return base.length>40?base.slice(0,39)+"…":base;
}
/* 저장된 글에서 「가. 「법령」 조항에서, <문장>고 규정하고 있습니다.」의 <문장>을 되찾는다. 편람식 「조항에 따라 <문장>.」도.
 * 되찾은 문장은 조문 원문에 있어야만 쓴다(빈칸 빼고 대조). */
function ansKeyFromSaved(saved,c){
  if(!saved||!c.text) return "";
  var lab=String(c.label||c.num||""), lines=saved.split("\n"), i, L, m, key="";
  var esc_=function(t){ return t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); };
  var re1=new RegExp(esc_(lab)+"\\s*에서,\\s*(?:「)?([\\s\\S]{12,600}?)(?:」)?(?:이라|라)?(?:고|을|를)\\s*규정하고\\s*있습니다");
  var re2=new RegExp(esc_(lab)+"\\s*에\\s*따라\\s*([\\s\\S]{12,600}?)\\.?$");
  for(i=0;i<lines.length;i++){
    L=lines[i].trim(); if(L.indexOf(lab)<0) continue;
    m=re1.exec(L)||re2.exec(L); if(m){ key=m[1].trim(); break; }
  }
  if(!key) return "";
  var bare=function(t){ return String(t).replace(/\s+/g,""); };
  var k=bare(key), t=bare(c.text);
  if(t.indexOf(k)>=0) return key;
  /* 존댓말로 바뀐 꼬리(합니다→한다)만 다를 수 있다 — 앞 30자로 찾아 원문 문장을 되돌린다 */
  var head=k.slice(0,30), at=t.indexOf(head); if(at<0) return "";
  var sent=/[^.]*\./.exec(String(c.text).replace(/\s+/g," ").slice(String(c.text).replace(/\s+/g," ").replace(/\s+/g,"").indexOf(head)));
  return sent?sent[0].trim():"";
}
/* 저장된 답변을 다시 열 때 요지는 제목이 아니라 본문 첫 줄(「…은 X(으)로 이해되며」)에서 되찾는다 —
   제목이 핵심 낱말이 된 뒤로 제목을 요지로 쓰면 「1. 귀하께서 주신 내용은 보툴리눔 · 2차 포장(으)로 이해되며」가 된다. */
function ansSummaryOf(a){
  var t=String(a.final||a.draft||"");
  var m=/귀하께서\s*주신\s*내용은\s*([\s\S]{4,200}?)\(으\)로\s*이해되며/.exec(t)
       ||/민원의\s*내용은\s*['‘]([\s\S]{2,120}?)['’]에\s*대한\s*질의/.exec(t);
  return m?m[1].replace(/\s+/g," ").trim():String(a.title||"");
}
function ansSave(mode){
  var d=ansDraft; if(!d) return;
  var fin=(document.getElementById("ans-final")||{}).value;
  var item={
    title:ansTitle(d),
    question:String(d.q||""),
    cites:d.cites.map(function(c){ return {law:c.law,kind:c.kind,num:c.num,label:c.label}; }),
    mode:mode||d.mode||"plain",
    draft:ansText(mode||d.mode||"plain"),
    final:(fin!=null&&String(fin).trim())?String(fin):null
  };
  if(d.id){
    /* 다시 열어 고쳐 담을 때 **처음 초안은 그대로 둔다**(이랑님 2026-09-09 「고치기 전 글 어디서 확인?」).
       덮어쓰면 고치기 전 글이 사라진다. 처음 담을 때 초안이 비어 있었던 옛 답변만 채운다. 고친 글(final)은 늘 새것. */
    var i=S.answers.findIndex(function(x){ return x.id===d.id; });
    if(i>=0&&String(S.answers[i].draft||"").trim()) delete item.draft;
    if(i>=0){ var k; for(k in item) S.answers[i][k]=item[k]; }
    dbUpdate("answers",d.id,item);
    showToast("✓ 저장했어요");
    ansDraft=null; active="answers"; render(); return;
  }
  dbInsert("answers",item).then(function(row){
    if(row){ S.answers.unshift(row); }
    showToast("✓ 「민원 답변」에 담았어요");
    ansDraft=null; active="answers"; render();
  },function(e){ showToast("저장하지 못했어요: "+(e&&e.message||e),true); });
}
/* 지우기는 기존 del() 을 그대로 쓴다 — 되돌리기까지 이미 들어 있다 */
function ansDel(id){ if(ansOpenId===id) ansOpenId=null; del("answers",id); }

/* 저장해 둔 기록을 다시 초안 창으로 — 고치거나 다시 뽑을 때 */
function ansReopen(id){
  var a=S.answers.find(function(x){ return x.id===id; }); if(!a) return;
  showToast("조문 원문을 불러오는 중...");
  var want=(a.cites||[]);
  if(!want.length){ showToast("담긴 조문이 없어요."); return; }
  var laws={}; want.forEach(function(c){ laws[c.law]=1; });
  withAuthRetry(function(){
    return sb.from("law_articles").select("id,law_id,label,content,tbl").in("law_id",
      S.laws.filter(function(l){ return laws[nfc(l.name)]; }).map(function(l){ return l.id; }));
  }).then(function(res){
    var by={};
    if(!res.error) (res.data||[]).forEach(function(r){
      var nm=lawName(r.law_id);
      by[nm+"|"+ansNumOf(r.label)]={id:r.id,lawId:r.law_id,label:nfc(r.label||""),text:lawPlain(cleanPdfText(nfc(r.content||""))),table:!!r.tbl};
    });
    var cites=want.map(function(c){
      var hit=by[c.law+"|"+c.num];
      var ct={ law:c.law, kind:c.kind||"", num:c.num,
               label:hit?hit.label:(c.label||c.num),
               text:hit?hit.text:"", table:hit?hit.table:false,
               artId:hit?hit.id:null, lawId:hit?hit.lawId:null,
               missing:!hit };
      /* 저장된 글에서 그 조의 근거 문장을 되찾는다 — 안 그러면 참고 붙이기만 켜도 조문 전체로 다시 써진다(이랑님 2026-09-10 「조문 전체를 써버리는데?」) */
      ct.key=ansKeyFromSaved(String(a.final||a.draft||""),ct)||"";
      return ct;
    });
    var apm=/신청번호\s*([0-9A-Za-z\-]{6,24})\)/.exec(String(a.final||a.draft||""));
    ansDraft={ q:a.question||"", cites:cites, summary:ansSummaryOf(a), title:a.title||"", topic:ansSummaryOf(a), help:"",
               appno:apm?apm[1]:"",
               mode:a.mode||"plain", busy:false, err:"", krw:0, id:a.id,
               made:true, final:a.final||"" };
    /* 「다시 열어 고치기」에 글이 비어 있었다(이랑님 2026-09-09) — 옛 답변은 final 이 null 이라(고치지 않고 담으면
       null 로 저장했다) 빈 칸이 열렸다. 저장된 초안(draft)을, 그것도 없으면 조문으로 다시 만든 글을 넣는다. */
    if(!String(ansDraft.final||"").trim()) ansDraft.final=String(a.draft||"").trim()||ansText(ansDraft.mode);
    ansDraft.gen=ansDraft.final;
    var lost=cites.filter(function(c){ return c.missing; }).length;
    if(lost) showToast("조문 "+lost+"건은 지금 올려둔 법령에서 못 찾았어요 — 글자가 빈 채로 열립니다.");
    render();
  });
}

/* ---------- 초안 창 그리기 ---------- */
function ansModalHtml(){
  var d=ansDraft; if(!d) return "";
  var chips=d.cites.map(function(c,i){
    var ks=c.table?"":(c.pick?"직접 고른 문장":(c.key?"근거 문장 있음":(d.made?"문장 없음 → 조문 전체":"")));
    return '<span class="ans-chip'+(c.missing?" miss":"")+(c.artId?" can-open":"")+'"'+(c.artId?' data-act="ans-chip-open" data-id="'+i+'" title="조 전체 보기 — 글자를 끌어 고르면 근거 문장이 돼요"':'')+'>'
      + '<b>'+esc(c.law)+'</b> '+esc(c.num)
      + (ks?' <span class="ans-chip-tag'+(c.key||c.pick?" ok":" warn")+'">'+ks+'</span>':'')
      + (c.table?' <span class="ans-chip-tag">표</span>':'')
      + (c.missing?' <span class="ans-chip-tag warn">글자 없음</span>':'')
      + '<button class="ans-chip-x" data-act="ans-drop" data-id="'+i+'" title="빼기">✕</button></span>';
  }).join("");

  var fmt=ansFmtOpen
    ? '<div class="ans-fmt">'
      + '<div class="ans-fmt-row"><span class="ans-fmt-k">양식</span>'
      +   '<button class="chip '+(ansFmt.style!=="classic"?"on":"")+'" data-act="ans-style" data-id="sinmungo">국민신문고 답변<span class="ans-fmt-hint">인사 · 요지 · 검토 결과 가.나.다. · 담당자</span></button>'
      +   '<button class="chip '+(ansFmt.style==="classic"?"on":"")+'" data-act="ans-style" data-id="classic">편람식</button></div>'
      + (ansFmt.style!=="classic"
          ? '<div class="ans-fmt-row"><span class="ans-fmt-k">담당자</span>'
          +   '<input class="input ans-fmt-sm" id="ans-f-dept" value="'+esc(ansFmt.dept)+'" placeholder="담당과 (예: 바이오의약품품질관리과)" />'
          +   '<input class="input ans-fmt-xs" id="ans-f-who" value="'+esc(ansFmt.who)+'" placeholder="직위" />'
          +   '<input class="input ans-fmt-sm" id="ans-f-phone" value="'+esc(ansFmt.phone)+'" placeholder="전화 (043-719-0000)" /></div>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">인사</span><input class="input" id="ans-f-intro" value="'+esc(ansFmt.intro)+'" /></label>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">요지</span><input class="input" id="ans-f-ask" value="'+esc(ansFmt.ask)+'" /></label>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">검토</span><input class="input" id="ans-f-review" value="'+esc(ansFmt.review)+'" /></label>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">조문</span><input class="input" id="ans-f-citeS" value="'+esc(ansFmt.citeS)+'" /></label>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">맺음</span><input class="input" id="ans-f-close" value="'+esc(ansFmt.close)+'" /></label>'
          : "")
      + '<div class="ans-fmt-row"><span class="ans-fmt-k">조문 인용</span>'
      +   '<button class="chip '+(ansFmt.brief?"on":"")+'" data-act="ans-brief" data-id="on">핵심 문장<span class="ans-fmt-hint">AI 가 짚고 원문과 대조 · 못 짚은 조는 전체</span></button>'
      +   '<button class="chip '+(ansFmt.brief?"":"on")+'" data-act="ans-brief" data-id="off">조문 전체</button></div>'
      + (ansFmt.style==="classic"
          ? '<div class="ans-fmt-row"><span class="ans-fmt-k">항목 기호</span>'
          +   '<button class="chip '+(ansFmt.hangul?"":"on")+'" data-act="ans-mark" data-id="num">1. 2. 3.<span class="ans-fmt-hint">편람 기준</span></button>'
          +   '<button class="chip '+(ansFmt.hangul?"on":"")+'" data-act="ans-mark" data-id="han">가. 나. 다.</button></div>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">머리말</span>'
          +   '<input class="input" id="ans-f-head" value="'+esc(ansFmt.head)+'" /></label>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">조문</span>'
          +   '<input class="input" id="ans-f-cite" value="'+esc(ansFmt.cite)+'" /></label>'
          + '<label class="ans-fmt-row"><span class="ans-fmt-k">맺음말</span>'
          +   '<input class="input" id="ans-f-tail" value="'+esc(ansFmt.tail)+'" /></label>'
          : "")
      + '<div class="ans-fmt-row"><span class="ans-fmt-k"></span>'
      +   '<label class="ans-fmt-chk"><input type="checkbox" data-act="ans-end"'+(ansFmt.end?" checked":"")+' /> 「끝.」 표시 붙이기</label>'
      +   '<button class="link-btn" data-act="ans-fmt-reset">되돌리기</button></div>'
      + '<p class="ans-fmt-note">{신청번호}·{주제}·{법령명}·{종류}·{조항}·{담당과}·{직위}·{연락처} 자리에 값이 들어갑니다. 나머지 글자는 그대로 나갑니다. 형식은 아이패드·맥에 같이 저장돼요.</p>'
      + '</div>'
    : "";

  /* 초안은 **바로 고칠 수 있는 글 한 칸**이다. 예전엔 「초안 판 → 최종본으로 내리기 → 최종본」 두 단계였는데
   * 내리기가 안 되는 일이 있었고(이랑님: 「최종본으로 내리기 하면 안 내려와」), 결국 쓰는 곳은 고친 글 한 칸이다.
   * 참고 붙이기·형식을 바꾸면 글을 새로 만드는데, 손으로 고친 게 있으면 먼저 묻는다(ansRegen). */
  var panes="";
  if(d.made){
    var nHelp=d.help?d.help.split(/\n+/).filter(function(x){ return x.trim(); }).length:0;
    var m=d.mode==="help"&&nHelp?"help":"plain";
    panes='<div class="ans-panes" id="ans-panes"><div class="ans-pane on" data-mode="'+m+'">'
      + '<div class="ans-pane-head">초안 <span class="ans-pane-note">여기서 바로 고쳐요</span>'
      +   (nHelp
            ? ' <label class="ans-help-chk"><input type="checkbox" data-act="ans-mode" data-id="'+(m==="help"?"plain":"help")+'"'+(m==="help"?" checked":"")+' /> AI 참고 '+nHelp+'줄 뒤에 붙이기</label>'
            : ' <span class="ans-pane-note">· AI 가 참고할 것이 없다고 판단했어요</span>')
      +   (d.dropped?' <span class="ans-pane-note">· 근거에 없는 법령을 든 문장은 뺐어요</span>':'')+'</div>'
      + '<textarea class="input ans-final" id="ans-final" rows="16">'+esc(d.final||"")+'</textarea>'
      + '<div class="ans-pane-foot">'
      +   '<button class="btn quiet sm" data-act="ans-copy">복사</button>'
      +   '<button class="btn quiet sm" data-act="ans-txt">텍스트</button>'
      +   '<button class="btn quiet sm" data-act="ans-hwpx">한글</button>'
      +   '<button class="link-btn quiet-link" data-act="ans-regen" title="고친 것을 버리고 초안을 새로 씁니다">초안으로 되돌리기</button>'
      +   '<button class="btn sm ans-save-btn" data-act="ans-save" data-id="'+m+'">민원 답변에 담기 →</button>'
      + '</div></div></div>';
  }

  return '<div class="ans-back" data-act="ans-close"></div>'
    + '<div class="ans-win" role="dialog">'
    + '<div class="ans-top"><b>답변 초안</b>'
    +   (d.krw?'<span class="ans-krw">약 '+d.krw+'원</span>':'')
    +   '<button class="lv-x" data-act="ans-close">✕</button></div>'
    + '<div class="ans-scroll">'
    +   '<label class="ans-lab">민원 내용</label>'
    +   '<textarea class="input ans-q" id="ans-q" rows="3" placeholder="민원 원문을 붙여넣거나 요약해서 적어주세요.">'+esc(d.q)+'</textarea>'
    +   (ansFmt.style!=="classic"?'<label class="ans-appno"><span class="ans-lab-n">국민신문고 신청번호</span><input class="input" id="ans-appno" value="'+esc(d.appno||"")+'" placeholder="1AA-0000-0000000" /></label>':"")
    +   '<label class="ans-lab">근거 조문 <span class="ans-lab-n">'+d.cites.length+'건</span></label>'
    +   '<div class="ans-chips">'+chips+'</div>'
    +   '<div class="ans-go">'
    +     '<button class="law-toggle ans-fmt-btn" data-act="ans-fmt">'+(ansFmtOpen?"▾":"▸")+' 답변 형식</button>'
    +     '<button class="btn'+(d.busy?" busy":"")+'" data-act="ans-make"'+(d.busy?" disabled":"")+'>'
    +       (d.busy?"만드는 중...":(d.made?"다시 만들기":"만들기"))+'</button>'
    +   '</div>'
    +   fmt
    +   (d.err?'<p class="ask-warn">'+esc(d.err)+'</p>':"")
    +   panes
    /* 흐름은 한 줄이다: 초안 → 「최종본으로 내리기」 → 여기서 고친다 → 「민원 답변에 담기」 → 그 탭으로 간다.
     * (이랑님: 「이걸로 담기 하면 밑에 최종본으로 넘어오고, 최종본에서 담기 하면 민원 답변으로 가게」) */

    +   '<p class="ans-warn">⚠ 초안입니다. 보내시기 전에 반드시 확인하세요.</p>'
    + '</div></div>';
}
/* 창을 통째로 다시 그리면 스크롤이 맨 위로 튀고 쓰던 글자의 커서가 날아간다. 앱은 창이 앞으로
 * 올 때마다(window focus·visibilitychange) 자료를 새로 받고 render() 를 부르는데, 아이패드에서
 * 글쇠판을 열고 닫는 것만으로도 그 일이 난다(이랑님: 「스크롤 내리면 다시 위로 올라가서 불편해」).
 * 그래서 **보이는 내용이 바뀌었을 때만** 다시 그리고, 다시 그릴 때도 스크롤 자리를 되돌린다.
 * 민원 내용·최종본 글은 서명에 넣지 않는다 — 그 둘은 입력 리스너가 상태에 바로 적는다. */
var ansSigLast="";
function ansSig(){
  var d=ansDraft; if(!d) return "";
  return JSON.stringify([d.made,d.mode,d.busy,d.err,d.krw,d.summary,d.help,d.dropped,d.id,
    d.cites.map(function(c){ return c.law+"|"+c.label+"|"+(c.pick?"p":c.key?"k":"-"); }),ansFmtOpen,ansFmt]);
}
function renderAnsModal(force){
  var el=document.getElementById("ans-modal"); if(!el) return;
  if(!ansDraft){ el.innerHTML=""; ansSigLast=""; document.body.style.overflow=""; return; }
  document.body.style.overflow="hidden";
  var sig=ansSig();
  if(!force&&sig===ansSigLast&&el.firstChild) return;      /* 그대로 둔다 */
  ansSigLast=sig;
  var sc=el.querySelector(".ans-scroll"), top=sc?sc.scrollTop:0;
  el.innerHTML=ansModalHtml();
  var sc2=el.querySelector(".ans-scroll"); if(sc2&&top) sc2.scrollTop=top;
  var q=document.getElementById("ans-q");
  if(q) q.addEventListener("input",function(){ if(ansDraft) ansDraft.q=q.value; });
  var f=document.getElementById("ans-final");
  if(f) f.addEventListener("input",function(){ if(ansDraft) ansDraft.final=f.value; });
  ["head","cite","tail","intro","ask","review","citeS","close","dept","who","phone"].forEach(function(k){
    var i=document.getElementById("ans-f-"+k);
    if(i) i.addEventListener("input",function(){ ansFmt[k]=i.value; ansFmtSave(); ansRegen(true); var fa=document.getElementById("ans-final"); if(fa) fa.value=ansDraft.final; });
  });
  var ap=document.getElementById("ans-appno");
  if(ap) ap.addEventListener("input",function(){ if(ansDraft){ ansDraft.appno=ap.value.trim(); ansRegen(true); var fa=document.getElementById("ans-final"); if(fa) fa.value=ansDraft.final; } });
  ansSwipeWire();
}
/* 좁은 화면에서 두 판을 좌우로 넘긴다 — 버튼을 늘리지 않는다 */
function ansSwipeWire(){
  var el=document.getElementById("ans-panes"); if(!el) return;
  var x0=null;
  el.addEventListener("touchstart",function(e){ x0=e.touches[0].clientX; },{passive:true});
  el.addEventListener("touchend",function(e){
    if(x0==null||!ansDraft) return;
    var dx=e.changedTouches[0].clientX-x0; x0=null;
    if(Math.abs(dx)<60) return;
    ansDraft.mode=(dx<0)?"help":"plain";
    renderAnsModal();
  },{passive:true});
}

/* ---------- 「민원 답변」 탭 ---------- */
function ansDateOf(a){
  var t=a&&(a.created_at||a.createdAt); if(!t) return "";
  var d=new Date(t); return isNaN(d)?"":keyOf(d);
}
function renderAnswers(){
  var items=(S.answers||[]).slice().sort(function(a,b){
    return String(b.created_at||"").localeCompare(String(a.created_at||""));
  });
  var pills=items.length?[pill("답변 "+items.length+"건")]:null;

  var list=items.map(function(a){
    var open=(ansOpenId===a.id);
    var nc=(a.cites||[]).length, gist=ansSummaryOf(a).replace(/\s+/g," ").trim();
    var sameTxt=!a.final||String(a.final).trim()===String(a.draft||"").trim();
    return '<div class="ans-row'+(open?" on":"")+'">'
      + '<div class="ans-row-head" data-act="ans-open" data-id="'+esc(a.id)+'">'
      +   '<span class="doc-ic file">▤</span>'
      +   '<div class="ans-row-body">'
      +     '<div class="ans-row-t">'+esc(a.title||"(제목 없음)")+'</div>'
      /* 안 펼치고도 요지를 읽는다(이랑님 2026-09-09) — 제목이 핵심 낱말이 된 뒤로 요지 문장은 본문 첫 줄에서 되찾아
         둘째 줄에 둔다. 옛 답변처럼 제목이 곧 요지면 되풀이하지 않는다. 근거는 이름을 늘어놓지 않고 개수만. */
      +     (gist&&gist.slice(0,24)!==String(a.title||"").trim().slice(0,24)?'<div class="ans-row-g">'+esc(gist)+'</div>':'')
      +     '<div class="ans-row-s">'+esc(ansDateOf(a))+(nc?' · 근거 '+nc+'건':'')
      +       (a.mode==="help"?' · 참고 붙임':'')+(!sameTxt?' · <b>고친 글 있음</b>':'')+'</div>'
      +   '</div>'
      +   '<span class="ans-row-go">'+(open?"▾":"›")+'</span>'
      +   '<button class="del doc-del" data-act="ans-del" data-id="'+esc(a.id)+'" title="삭제">✕</button>'
      + '</div>'
      + (open?'<div class="ans-row-open">'
      +   (a.question?'<div class="ans-sec"><span class="ans-sec-k">민원 내용</span><pre class="ans-body sm">'+esc(a.question)+'</pre></div>':'')
      /* 처음 초안과 고친 글이 같으면 하나만 — 같은 글이 두 번 보이면 「어느 게 진짜냐」가 된다 */
      +   (sameTxt
            ? '<div class="ans-sec"><span class="ans-sec-k">답변</span><pre class="ans-body">'+esc(a.final||a.draft||"")+'</pre></div>'
            : '<div class="ans-sec"><span class="ans-sec-k">처음 초안 <i class="ans-sec-n">다시 열어 고치기 전</i></span><pre class="ans-body">'+esc(a.draft||"")+'</pre></div>'
            + '<div class="ans-sec"><span class="ans-sec-k">고친 글</span><pre class="ans-body">'+esc(a.final||"")+'</pre></div>')
      +   '<div class="ans-row-acts">'
      +     '<button class="btn quiet sm" data-act="ans-rcopy" data-id="'+esc(a.id)+'">복사</button>'
      +     '<button class="btn quiet sm" data-act="ans-rtxt" data-id="'+esc(a.id)+'">텍스트</button>'
      +     '<button class="btn quiet sm" data-act="ans-rhwpx" data-id="'+esc(a.id)+'">한글</button>'
      +     '<button class="btn sm" data-act="ans-edit" data-id="'+esc(a.id)+'">다시 열어 고치기</button>'
      +   '</div></div>':'')
      + '</div>';
  }).join("");

  view().innerHTML='<div class="page">'
    + pageHead2("민원 답변","법령 탭에서 조문을 고르고 「답변 초안」을 누르면 여기에 쌓여요.",pills)
    + (items.length?('<div class="ans-list">'+list+'</div>')
        :'<div class="empty-box"><div class="empty-ic">✎</div><p>아직 담아둔 답변이 없어요.<br /><b>법령</b> 탭에서 조문을 찾아 고른 뒤<br />「<b>답변 초안</b>」을 누르면 여기로 옵니다.</p></div>')
    + '<div id="ans-modal"></div></div>';
  renderAnsModal();
}
/* 저장된 기록에서 바로 꺼내 쓰기 — 최종본이 있으면 그것이 먼저다 */
function ansRowText(id){
  var a=(S.answers||[]).find(function(x){ return x.id===id; });
  return a?String(a.final||a.draft||""):"";
}
function ansRowBlocks(id){
  return ansRowText(id).split("\n").map(function(L){
    var pad=/^\s*/.exec(L)[0].length, t=L.trim();
    if(!t) return {t:"",lv:9};
    return {t:t, lv: pad>=6?3 : pad>=4?2 : pad>=2?1 : 0};
  });
}

/* ========== 한글 파일(hwpx) 만들기 ================================
 * hwpx 는 「압축 안에 XML」이라 브라우저에서도 만들 수 있다.
 * 꾸러미(라이브러리)를 안 쓴다 — 압축은 「압축 안 함(STORE)」으로 넣으면
 * 표를 계산할 일이 없어 80줄이면 되고, 외부 파일을 안 불러오므로
 * 앱 규칙(프레임워크 안 넣기)도 안 어긴다.
 *
 * 함정 셋 — 실제로 다 밟았다.
 *  1) <hp:linesegarray> 를 넣으면 안 된다. 한글은 파일에 적힌 줄 배치를
 *     그대로 믿고 그려서, 값이 틀리면 여러 줄이 한 자리에 겹친다. 빼면
 *     한글이 스스로 계산한다.
 *  2) 들여쓰기를 공백으로 밀면 둘째 줄이 왼쪽 끝으로 돌아간다.
 *     문단 여백의 **내어쓰기**(left 양수 + intent 음수)로 해야
 *     둘째 줄이 번호 뒤 글자에 맞는다 (한글의 Shift+Tab · 편람 60쪽).
 *  3) mimetype 은 **압축 안 함 + 맨 앞**이어야 한다.
 * ---------------------------------------------------------------- */
var HWPX_PT=13, HWPX_LS=160, HWPX_CD=10, HWPX_FACE="함초롬바탕";
/* 층별 「기호폭 + 1타」 배수 — 1.=1.5자 가.=2자 (편람 59~60쪽) */
var HWPX_LV=[1.5,2.0,1.5,2.0,1.5];

var _crcT=null;
function crc32(u8){
  if(!_crcT){ _crcT=new Uint32Array(256);
    for(var n=0;n<256;n++){ var c=n;
      for(var k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
      _crcT[n]=c>>>0; } }
  var crc=0xFFFFFFFF;
  for(var i=0;i<u8.length;i++) crc=(_crcT[(crc^u8[i])&0xFF]^(crc>>>8))>>>0;
  return (crc^0xFFFFFFFF)>>>0;
}
function zipMake(files){   /* files: [{name, data:Uint8Array}] */
  var parts=[], cd=[], off=0;
  function u8(n){ return new Uint8Array(n); }
  function put(a,i,v,len){ for(var k=0;k<len;k++){ a[i+k]=v&0xFF; v=Math.floor(v/256); } }
  files.forEach(function(f){
    var nm=new TextEncoder().encode(f.name), d=f.data, c=crc32(d);
    var h=u8(30+nm.length);
    put(h,0,0x04034b50,4); put(h,4,20,2); put(h,6,0x0800,2); put(h,8,0,2);
    put(h,10,0,2); put(h,12,0,2); put(h,14,c,4); put(h,18,d.length,4); put(h,22,d.length,4);
    put(h,26,nm.length,2); put(h,28,0,2); h.set(nm,30);
    parts.push(h); parts.push(d);
    var e=u8(46+nm.length);
    put(e,0,0x02014b50,4); put(e,4,20,2); put(e,6,20,2); put(e,8,0x0800,2); put(e,10,0,2);
    put(e,12,0,2); put(e,14,0,2); put(e,16,c,4); put(e,20,d.length,4); put(e,24,d.length,4);
    put(e,28,nm.length,2); put(e,30,0,2); put(e,32,0,2); put(e,34,0,2); put(e,36,0,2);
    put(e,38,0,4); put(e,42,off,4); e.set(nm,46);
    cd.push(e);
    off+=h.length+d.length;
  });
  var cdLen=0; cd.forEach(function(e){ cdLen+=e.length; });
  var end=new Uint8Array(22);
  put(end,0,0x06054b50,4); put(end,4,0,2); put(end,6,0,2);
  put(end,8,files.length,2); put(end,10,files.length,2);
  put(end,12,cdLen,4); put(end,16,off,4); put(end,20,0,2);
  var total=off+cdLen+22, out=new Uint8Array(total), at=0;
  parts.forEach(function(p){ out.set(p,at); at+=p.length; });
  cd.forEach(function(p){ out.set(p,at); at+=p.length; });
  out.set(end,at);
  return out;
}
function xesc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function hwpxParaPr(){
  var ch=Math.round(HWPX_PT*100), out="", n=HWPX_LV.length+1;
  function one(id,left,intent){
    return '<hh:paraPr id="'+id+'" tabPrIDRef="0" condense="'+HWPX_CD+'" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">'
      + '<hh:align horizontal="JUSTIFY" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>'
      + '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>'
      + '<hh:autoSpacing eAsianEng="1" eAsianNum="1"/>'
      + '<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">'
      +   '<hh:margin><hc:intent value="'+intent+'" unit="HWPUNIT"/><hc:left value="'+left+'" unit="HWPUNIT"/>'
      +   '<hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>'
      +   '<hh:lineSpacing type="PERCENT" value="'+HWPX_LS+'" unit="HWPUNIT"/></hp:case>'
      + '<hp:default><hh:margin><hc:intent value="'+intent+'" unit="HWPUNIT"/><hc:left value="'+left+'" unit="HWPUNIT"/>'
      +   '<hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>'
      +   '<hh:lineSpacing type="PERCENT" value="'+HWPX_LS+'" unit="HWPUNIT"/></hp:default></hp:switch>'
      + '<hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>';
  }
  HWPX_LV.forEach(function(mul,lv){
    var head=Math.round(ch*mul);
    out+=one(lv, ch*lv+head, -head);
  });
  out+=one(HWPX_LV.length,0,0);   /* 층 없는 줄 (여백·구분선) */
  return {xml:out,n:n};
}
function hwpxHeader(){
  var langs=["HANGUL","LATIN","HANJA","JAPANESE","OTHER","SYMBOL","USER"], ff="";
  langs.forEach(function(l){
    ff+='<hh:fontface lang="'+l+'" fontCnt="1"><hh:font id="0" face="'+xesc(HWPX_FACE)+'" type="TTF" isEmbedded="0">'
      + '<hh:typeInfo familyType="FCAT_MYUNGJO" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font></hh:fontface>';
  });
  var pp=hwpxParaPr();
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
    + '<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" version="1.4" secCnt="1">'
    + '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>'
    + '<hh:fontfaces itemCnt="7">'+ff+'</hh:fontfaces>'
    + '<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">'
    +   '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>'
    +   '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>'
    +   '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>'
    +   '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill></hh:borderFills>'
    + '<hh:charProperties itemCnt="1"><hh:charPr id="0" height="'+Math.round(HWPX_PT*100)+'" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1">'
    +   '<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>'
    +   '<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>'
    +   '<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>'
    +   '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>'
    +   '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/></hh:charPr></hh:charProperties>'
    + '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>'
    + '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead></hh:numbering></hh:numberings>'
    + '<hh:paraProperties itemCnt="'+pp.n+'">'+pp.xml+'</hh:paraProperties>'
    + '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>'
    + '</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument></hh:head>';
}
var HWPX_SECPR='<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">'
 + '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>'
 + '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>'
 + '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>'
 + '<hp:pagePr landscape="WIDELY" width="59528" height="84189" gutterType="LEFT_ONLY">'
 +   '<hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr>'
 + '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>'
 +   '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>'
 +   '<hp:noteSpacing betweenNotes="850" belowLine="567" aboveLine="850"/>'
 +   '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>'
 + '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>'
 +   '<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>'
 +   '<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>'
 +   '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>'
 + ["BOTH","EVEN","ODD"].map(function(t){
     return '<hp:pageBorderFill type="'+t+'" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">'
          + '<hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>'; }).join("")
 + '</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>';

function hwpxMake(blocks,title){
  var plain=HWPX_LV.length;   /* 층 없는 문단 */
  var body=blocks.map(function(b,i){
    var lv=(b.lv==null||b.lv>=9)?plain:Math.min(b.lv,HWPX_LV.length-1);
    var run='<hp:run charPrIDRef="0">'+(i===0?HWPX_SECPR:"")
      + (b.t?('<hp:t>'+xesc(b.t)+'</hp:t>'):'<hp:t/>')+'</hp:run>';
    return '<hp:p id="'+i+'" paraPrIDRef="'+lv+'" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'+run+'</hp:p>';
  }).join("");
  var sec='<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
    + '<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
    + 'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">'+body+'</hs:sec>';
  var hpf='<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
    + '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" version="" unique-identifier="" id="">'
    + '<opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/">'
    + '<opf:title>'+xesc(title||"민원 답변")+'</opf:title><opf:language>ko</opf:language>'
    + '<opf:meta name="CreatedDate" content=""/><opf:meta name="ModifiedDate" content=""/></opf:metadata>'
    + '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>'
    + '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>'
    + '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>'
    + '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>';
  var enc=new TextEncoder();
  var prv=blocks.map(function(b){ return b.t||""; }).join("\n").slice(0,2000);
  return zipMake([
    {name:"mimetype",data:enc.encode("application/hwp+zip")},
    {name:"version.xml",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="0" os="1" xmlVersion="1.4" application="yakktime" appVersion="1.0"/>')},
    {name:"settings.xml",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>')},
    {name:"Contents/header.xml",data:enc.encode(hwpxHeader())},
    {name:"Contents/section0.xml",data:enc.encode(sec)},
    {name:"Contents/content.hpf",data:enc.encode(hpf)},
    {name:"META-INF/container.xml",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>')},
    {name:"META-INF/manifest.xml",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>')},
    {name:"Preview/PrvText.txt",data:enc.encode(prv)}
  ]);
}

/* ---------- 화면 ---------- */
function renderLaws(){
  var items=S.laws;
  var totalPages=0; items.forEach(function(l){ totalPages+=(l.pages||0); });
  var pills=[pill("법령 "+items.length+"건")];
  if(totalPages) pills.push(pill("총 "+totalPages+"쪽"));

  var list="";
  if(items.length){
    /* 같은 법령이 두 벌 이상이면 검색 결과가 두 번씩 나오고 AI도 헷갈린다.
     * 열 몇 개를 일일이 볼 수 없으므로 여기서 세어 알린다. */
    var olds=items.filter(lawIsOld);
    if(olds.length) list+='<div class="notice"><span class="notice-ic">!</span>'
      + '<div>같은 법령이 <b>'+olds.length+'개 겹쳐</b> 있어요 (옛 판이거나 같은 판 두 벌). '
      +   '두면 검색 결과가 두 번씩 나오고 AI도 헷갈려요.</div>'
      + '<button class="btn sm" data-act="law-drop-old">겹치는 것 정리</button></div>';
    /* 법령·고시는 법제처에서 바로 받을 수 있다 — 개정판이 따라오고 별표의 표가 읽힌다.
     * 지침서는 법제처에 없으니 그대로 PDF 다. 한 번 바꾸면 이 알림은 사라진다. */
    var apiable=items.filter(function(l){ return lawIsApiable(l)&&l.src!=="api"; }).length;
    if(apiable&&!lawBusy) list+='<div class="notice"><span class="notice-ic">!</span>'
      + '<div>법제처에서 바로 받을 수 있는 법령이 <b>'+apiable+'개</b> 있어요. 받으면 <b>개정판이 저절로 따라오고</b>, '
      +   '별표의 표(행정처분 기준 등)를 칸 그대로 읽을 수 있어요.</div>'
      + '<button class="btn sm" data-act="law-api-all">법제처 판으로 바꾸기</button></div>';
    lawEmbedCheck();
    /* 「조문 전부 다시 만들기」 버튼은 뺐다(이랑님: 「필요해?」). 개정은 앱이 스스로 확인해 새 판이 있을 때만 알린다. */
    lawApiCheckUpdates();
    var newer=items.filter(function(l){ return l.src==="api"&&l.newer; });
    if(newer.length&&!lawBusy) list+='<div class="notice"><span class="notice-ic">!</span>'
      + '<div>법제처에 <b>새 판</b>이 나왔어요 — '+esc(newer.map(function(l){ return l.name+"("+lawDate(l.newer.eff)+" 시행)"; }).join(" · "))+'. 받으면 조문이 최신판으로 바뀌어요.</div>'
      + '<button class="btn sm" data-act="law-api-newer">최신판으로 바꾸기</button></div>';
    if(lawEmbStat&&!lawEmbStat.loading&&lawEmbStat.missing&&lawEmbStat.ready&&!lawBusy)
      list+='<div class="notice"><span class="notice-ic">!</span>'
        + '<div>뜻으로 찾을 준비가 안 된 조문이 <b>'+lawEmbStat.missing+'개</b> 있어요. 준비하면 <b>낱말이 달라도 뜻이 닿는 조문</b>을 AI 가 찾아요. 돈은 안 들어요.</div>'
        + '<button class="btn sm" data-act="law-embed-all">뜻 검색 준비하기</button></div>';
    var need=items.filter(function(l){ return !l.arts; }).length;
    if(need) list+='<div class="notice"><span class="notice-ic">!</span>'
      + '<div>조문으로 안 쪼개진 법령이 <b>'+need+'개</b> 있어요. 이걸 해야 검색이 조 단위로 나와요.</div>'
      + '<button class="btn sm" data-act="law-build-all"'+(lawBusy?" disabled":"")+'>'+(lawBusy?"만드는 중...":"전부 만들기")+'</button></div>';
    /* 「전부 다시 만들기」는 목록 아래에 있으면 안 보인다. 목록을 펼치는
     * 줄 오른쪽 — 목록을 다루는 것들이 모여 있는 자리에 둔다. */
    list+='<div class="law-head-row">'
      + '<button class="law-toggle" data-act="law-list">'
      +   (lawListOpen?"▾":"▸")+' 올려둔 법령 '+items.length+'개'
      +   (lawOnlyLabel()?'<span class="law-only-tag">'+esc(lawOnlyLabel())+'만</span>':'')
      +   '<span class="law-toggle-hint">'+(lawListOpen?"":"찾을 범위 고르기 · 삭제")+'</span></button>'
      + (lawListOpen
          ? '<button class="link-btn" data-act="law-only-all">☑ 전체</button>'
            + '<button class="link-btn quiet-link" data-act="law-only-none">☐ 해제</button>'
            + '<span class="law-head-sep">·</span>'
            + '<button class="link-btn" data-act="law-api-new"'+(lawBusy?" disabled":"")+'>＋ 법제처에서 받기</button>'
            + '<button class="link-btn quiet-link" data-act="law-upload"'+(lawBusy?" disabled":"")+'>PDF 올리기</button>'
            + (lawBusy?'<span class="law-head-sep">·</span><span class="law-toggle-hint">처리 중…</span>':'')
            + '<button class="link-btn quiet-link" data-act="law-list">접기</button>'
          : '')
      + '</div>';
    if(lawListOpen){
      lawTidyNames();
      /* 종류별로 묶고 위계 순으로 세운다 — 열 몇 개가 되면 이름만 죽 늘어놔서는
       * 어느 게 법이고 어느 게 지침인지 알 수 없다. 칸 높이를 잡아 그 안에서
       * 굴리게 하고, 아래 내용이 저 멀리 밀려나지 않게 한다. */
      var cur=null;
      list+='<div class="law-list grouped">'+lawSorted().map(function(l){
      var onlyOn=!!lawOnly[l.id], kd=lawKindOf(l), head="";
      if(kd.t!==cur){ cur=kd.t;
        var kn=lawSorted().filter(function(x){ return lawKindOf(x).n===kd.n; });
        var kOn=kn.length&&kn.every(function(x){ return lawOnly[x.id]; });
        /* 개수는 뺐다. 이름 옆에 붙이면 이름보다 튀고, 줄을 맞추려 칸을 넓히면
         * 이름과 멀어진다. 세어야 할 일이 있으면 목록을 보면 된다. */
        head='<button class="law-kind g'+kd.n+(kOn?" on":"")+'" data-act="law-only-kind" data-id="'+kd.n+'"'
           + ' title="이 묶음만 고르기"><span>'+esc(kd.t)+'</span>'
           + '<span class="law-kind-hint">'+(kOn?"이 묶음만 보는 중":"")+'</span></button>'; }
      return head+'<div class="law-row'+(onlyOn?" only":"")+'">'
        /* 하나도 안 고르면 전부 본다. 「고른 것만」은 좁힐 때만 쓰는 장치다. */
        + '<label class="law-only"><input type="checkbox" data-act="law-only" data-id="'+l.id+'"'+(onlyOn?" checked":"")+' title="이 법령에서만 찾기" /></label>'
        + '<span class="law-name" data-act="edit" data-table="laws" data-field="name" data-id="'+l.id+'" title="눌러서 이름 수정">'+esc(l.name)+'</span>'
        + (lawIsOld(l)?'<span class="law-old-tag">겹침</span>':'')
        /* 종류 배지는 뺐다 — 바로 위 묶음 머리말과 같은 말이다.
         * 시행일·쪽수는 폭을 고정해 세로로 줄을 맞춘다. */
        + '<span class="law-eff">'+esc(lawEffOf(l)||'')+'</span>'
        + '<span class="law-pages">'+(l.src==="api"?'<span class="law-src">법제처</span>':(l.pages||0)+'쪽')
        +   (l.arts?' · 조문 '+l.arts+'개':'')+'</span>'
        + (l.arts?'':'<button class="link-btn law-need" data-act="law-reindex" data-id="'+l.id+'">조문 만들기</button>')
        + (l.src==="api"
            ? '<button class="law-ic" data-act="law-site" data-id="'+l.id+'" title="법제처에서 보기">↗</button>'
            : '<button class="law-ic" data-act="law-pdf" data-id="'+l.id+'" data-page="1" title="PDF 원문 열기">↗</button>')
        + '<button class="law-ic del" data-act="law-del" data-id="'+l.id+'" title="삭제">✕</button></div>';
      }).join("")+'</div>';
    }
  }

  view().innerHTML='<div class="page">'
    + pageHead2("법령","법령·고시·지침 전체에서 낱말이나 뜻으로 찾고, 골라 모아 답변 초안을 만들어요.",items.length?pills:null)
    + '<div class="search-box"><span class="search-ic">⌕</span>'
    +   '<textarea class="input search law-input" id="law-q" rows="1" placeholder="낱말 두세 개는 그 낱말이 든 조문을, 문장은 뜻이 가까운 조문을 찾아요 (Enter)">'+esc(lawQuery)+'</textarea>'
    +   '<button class="btn sm law-go" data-act="law-search">검색</button>'
    + '</div>'
    /* 돈이 드는 동작이라 검색칸 안에 넣지 않는다. 눌러야만 나간다.
     * 게다가 낱말 두어 개를 칠 때는 쓸 일이 없으므로, 문장을 적었을 때만
     * 나타난다 — 평소 화면은 예전과 똑같이 조용하다. */
    + '<button class="ask-bar'+(lawAskFits(lawQuery)?"":" gone")+(lawAsking?" busy":"")+'" data-act="law-ask"'+(lawAsking?" disabled":"")+'>'
    +   '<span class="ask-ic">✦</span>'
    /* 기다리는 동안 점 셋이 차례로 켜진다. 점멸이 없으면 눌렸는지조차 모른다 —
     * 이 일은 5~15초가 걸리므로 「지금 일하는 중」이 보여야 한다. */
    +   '<span class="ask-bar-t">'+(lawAsking
          ?'조문을 고르는 중<span class="ask-dots"><i></i><i></i><i></i></span>'
          :(lawOnlyLabel()?"<b>"+esc(lawOnlyLabel())+"</b>에서 관련 조문 찾아줘"
                          :"위에 적은 말로 <b>관련 조문 찾아줘</b>"))+'</span>'
    +   '<span class="ask-bar-n">'+(lawAskLast!=null?"지난번 "+lawAskLast+"원":"한 번에 50~150원")+'</span>'
    + '</button>'
    + lawHelpHtml()
    /* 올리기·받기는 목록 머리줄 안에 있다(가끔 쓰는 것은 접어 둔다). 법령이 하나도 없을 때만 크게. */
    + (items.length?'':'<div class="empty-box"><div class="empty-ic">▤</div><p>아직 법령이 없어요.<br />'
        + '<button class="link-btn" data-act="law-api-new">법제처에서 법령·고시 받기</button> · '
        + '<button class="link-btn" data-act="law-upload">지침서 PDF 올리기</button></p></div>')
    + lawCandsHtml()
    + list
    /* 초안 창은 법령 탭에서 열리므로 여기에도 자리를 둔다 —
     * 없으면 renderAnsModal() 이 조용히 아무것도 안 해서 「눌러도 안 열린다」가 된다. */
    + '<div id="law-results"></div><div id="law-modal"></div><div id="ans-modal"></div></div>';

  renderAnsModal();
  renderLawResults();
  renderLawModal();
  var q=document.getElementById("law-q");
  if(q){
    /* Enter 는 예전처럼 검색. 줄바꿈이 필요하면 Shift+Enter.
     * (민원 글은 붙여넣기로 들어오므로 여러 줄이 그대로 살아 있다) */
    q.addEventListener("keydown",function(e){
      if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); lawSearch(); }
    });
    /* 치는 동안 render() 를 부르면 커서가 날아간다. 두 가지만 직접 손댄다. */
    q.addEventListener("input",function(){ lawQBox(q); });
    lawQBox(q);
  }
}

function renderLawResults(){
  var el=document.getElementById("law-results"); if(!el) return;
  if(lawAsking){ el.innerHTML=lawWaitHtml(); return; }
  var note=lawAsk?lawAskNoteHtml():"";
  if(lawSearching){ el.innerHTML=note+'<p class="empty">찾는 중...</p>'; return; }
  var cs=lawCards(), cards=cs.cards;
  if(!cards.length){
    if(lawHits===null&&!lawAsk){
      el.innerHTML=S.laws.length
        ? '<div class="empty-box"><div class="empty-ic">⌕</div><p>찾을 단어를 넣고 Enter를 눌러요.<br />낱말을 띄어 쓰면 <b>모두 들어 있는 곳</b>만 찾아요. 붙은 말 그대로 찾으려면 "따옴표"로 묶어요.<br />문장을 그대로 넣으면 <b>뜻이 가까운 조문</b>을 찾아요.<br /><br />처음이시면 위의 <b>「검색하는 법 · 화면 보는 법」</b>을 펼쳐 보세요.</p></div>'
        : '';
      return;
    }
    var miss=(lawHits&&!lawHits.length)
      ? (lawSem
          ? '<p class="empty">「'+esc(lawSem.q.slice(0,40))+(lawSem.q.length>40?'…':'')+'」와 뜻이 닿는 조문을 못 찾았어요.<br />낱말 두세 개로 다시 찾아보세요.</p>'
          : '<p class="empty">「'+esc(lawTermList.join(" + "))+'」를 찾지 못했어요.<br />'+(lawTermList.length>1?'낱말을 줄이거나 ':'')+'띄어쓰기를 바꿔 보세요.</p>')
      : "";
    el.innerHTML=note+miss;
    return;
  }

  /* 머리줄 하나 — 몇 곳인지, 어디서 왔는지, 고른 것으로 무엇을 할지. 스크롤해도 위에 붙어 있다. */
  var nAi=cards.filter(function(c){ return c.ai; }).length, nHit=cards.filter(function(c){ return c.hit; }).length;
  var picked=lawSelCount(), what=picked?("고른 "+picked+"곳"):"전부";
  var src=[];
  if(nAi) src.push("AI 가 고른 "+nAi);
  if(lawHits&&lawHits.length) src.push(lawSem?"뜻이 가까운 "+nHit:"「"+esc(lawTermList.join(" + "))+"」 "+nHit);
  var head='<div class="law-head sticky">'
    + '<div class="law-count"><b>'+cards.length+'</b>곳'+(src.length?' <span class="law-and">'+src.join(" · ")+'</span>':'')
    +   (lawCapped?' <span class="law-cap">'+LAW_HIT_MAX+'곳에서 끊었어요 — 낱말을 더 넣어 좁히세요</span>':'')
    +   (lawSem&&lawSem.auto?' <span class="law-sem-note">낱말로는 없어서 뜻으로 찾았어요.</span>':'')+'</div>'
    + '<div class="law-actions">'
    +   (cards.length>1
          ? (picked?'<button class="link-btn quiet-link" data-act="law-none">☐ 해제</button>'
                   :'<button class="link-btn" data-act="law-all">☑ 모두</button>'):'')
    +   '<button class="btn quiet sm" data-act="law-copy">'+what+' 복사</button>'
    +   '<button class="btn quiet sm" data-act="law-save">텍스트로 저장</button>'
    +   '<button class="btn sm" data-act="ans-start">✎ 답변 초안'+(picked?' ('+picked+')':'')+'</button>'
    + '</div></div>';

  var SHOW=3, cur=null, body="";
  cards.forEach(function(c){
    if(c.lawName!==cur){ cur=c.lawName;
      var lo=S.laws.find(function(x){ return x.id===c.lawId; });
      body+='<div class="law-group g'+c.kindN+'">'+esc(cur)+(lo?'<span class="law-group-kind">'+esc(lawKindOf(lo).t)+'</span>':'')+'</div>'; }
    var g=c.hit, p=c.ai, on=!!lawSel[c.key];
    var open=!!lawOpen[c.key], list=g?(open?g.snips:g.snips.slice(0,SHOW)):[];
    var snips="";
    if(g){
      if(g.table){
        var ws=[], seen={};
        g.snips.forEach(function(h){ if(h.where&&!seen[h.where]){ seen[h.where]=1; ws.push(h.where); } });
        var more=ws.length>3?(" 외 "+(ws.length-3)+"곳"):""; if(ws.length>3) ws=ws.slice(0,3);
        snips='<div class="law-tbl"><b>칸이 뒤섞여 읽기 어려운 대목이에요.</b>'
          + (ws.length?' <span class="law-tbl-w">'+esc(ws.join(" · "))+'</span>'+more+'에서 찾았어요.':'')+' PDF 원문에서 확인하세요.</div>';
      } else {
        snips=list.map(function(h){
          var w=h.where?'<span class="law-where">'+esc(h.where)+'</span>':'';
          if(h.grid) return '<div class="law-snip law-snip-grid">'+gridHtml(h.grid,lawTermList)+'</div>';
          return '<div class="law-snip'+(w?'':' law-snip-same')+'">'+w+lawSegHtml(h.text,lawTermList,0)+'</div>';
        }).join("")
        + (g.snips.length>SHOW?'<button class="link-btn law-more-btn" data-act="law-expand" data-key="'+esc(c.key)+'">'+(open?"접기":"이 조에서 "+(g.snips.length-SHOW)+"건 더 보기")+'</button>':"");
      }
    }
    /* AI 가 고른 조: 왜 골랐는지 + 판단 둘 + 근거 문장. 발췌가 따로 있으면 그 아래에 함께 */
    var aiPart="";
    if(p){
      aiPart='<div class="ask-why">'+esc(p.why||"")+'</div>'
        + (p.direct?'<div class="ask-parts"><span>'+esc(p.direct)+'</span><span>'+esc(p.sure)+'</span></div>':'')
        + (p.head&&(!g||p.quote)?'<div class="ask-head-txt'+(p.quote?' is-quote':'')+'">'+(p.quote?'<span class="ask-quote-tag">근거</span>':'')+esc(p.head)+'</div>':'');
    }
    body+='<div class="law-hit'+(on?" on":"")+(p?" has-ai r-"+(c.rank+1):"")+'">'
      + '<label class="law-pick"><input type="checkbox" class="law-check" data-act="law-pick" data-key="'+esc(c.key)+'"'+(on?" checked":"")+' /></label>'
      + '<div class="law-hit-body" data-act="law-art" data-art-id="'+c.artId+'" data-id="'+c.lawId+'">'
      +   '<div class="law-meta">'
      +     (p?'<span class="ask-score n-'+needRank(p.need)+'">'+esc(p.need||"있으면 좋음")+'</span>':'')
      +     '<span class="law-art">'+lawArtHtml(c.art)+'</span>'
      +     ansUsedChip(c.used)
      +     (lawIsFuture(c.art)?'<span class="law-soon">아직 시행 전</span>':'')
      +     (function(){ if(!g||!g.page) return ''; var pg=(g.page===g.pageEnd?g.page+'쪽':g.page+'~'+g.pageEnd+'쪽'); return String(c.art||"").indexOf(pg)===0?'':'<span class="law-page">'+pg+'</span>'; })()
      +     (g&&g.total>1?'<span class="law-n">'+g.total+'건</span>':'')
      +     '<span class="law-open" aria-hidden="true">›</span>'
      +   '</div>'
      +   aiPart+snips
      + '</div></div>';
  });
  var foldLine=cs.folded.length?'<button class="link-btn law-more-btn law-fold" data-act="ask-more">관련도 낮은 '+cs.folded.length+'개 더 보기</button>':"";
  el.innerHTML=note+head+'<div class="law-hits">'+body+'</div>'+foldLine
    + '<p class="law-note">같은 조는 한 카드로 묶었어요. <b>카드를 누르면 그 조 전문이 열리고</b>, 체크한 것이 「답변 초안」에 들어가요.</p>';
}

/* 쪽 보기 창은 Esc로 닫는다 */
document.addEventListener("keydown",function(e){
  if(!lawView) return;
  if(e.key==="Escape"){ e.preventDefault(); closeLawView(); }
});

/* ========== 이벤트 위임 ========== */
document.getElementById("app").addEventListener("click",function(e){
  var el=e.target.closest("[data-act]");
  /* 기간을 고치는 중에 달력 밖 아무 데나 누르면 끝낸다.
   * 고칠 때마다 이미 저장되므로 따로 확인받을 게 없다 —
   * 「완료」는 끝내는 버튼이지 저장 버튼이 아니다. */
  if(tripEdit&&!e.target.closest(".cal-grid")&&!e.target.closest(".trip-bar")){
    tripEdit=null;
    /* 빈 데를 눌렀으면 여기서 다시 그리고 끝낸다.
     * 다른 걸 눌렀을 땐 여기서 그리면 안 된다 — 지금 누른 그 요소가
     * 화면에서 사라져 버려서, 이어서 할 동작(인라인 수정 등)이 깨진다.
     * 그 동작들이 알아서 다시 그린다. */
    if(!el){ render(); return; }
  }
  if(!el) return;
  var act=el.getAttribute("data-act"), id=el.getAttribute("data-id");
  /* 카드 전체가 누르는 자리가 되면서, 발췌 글자를 끌어 고르기만 해도 창이 열렸다.
   * 글자를 고른 채 손을 뗀 것이면 열지 않는다. */
  if(act==="law-art"&&el.className.indexOf("law-hit-body")>=0){
    var sel=window.getSelection&&window.getSelection();
    if(sel&&String(sel).trim().length>1) return;
  }
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
    /* 별표를 누르면 그 줄이 **맨 위로 올라가** 손가락 밑에는 다른 줄이 온다 — 「안 눌렸다」로 보여 두 번 누르게
     * 됐다(이랑님 지적). 눌린 것을 말로 알리고, 누르는 자리도 손가락 크기로 키웠다(.star). */
    case "s-star": { var i2=S.schedule.find(function(x){return x.id===id;}); if(i2){ i2.star=!i2.star; render(); dbUpdate("schedule",id,{star:i2.star});
      showToast(i2.star?"★ 맨 위로 올렸어요":"☆ 별표를 뺐어요"); } break; }
    case "s-del": del("schedule",id); break;
    /* 달을 넘기면 아래 날짜 패널도 그 달로 옮긴다.
     * 안 옮기면 달력엔 없는 날짜의 일정을 보고 있게 된다. */
    case "cal-prev": calMonth--; if(calMonth<0){calMonth=11;calYear--;} calSyncSel(); render(); break;
    case "cal-next": calMonth++; if(calMonth>11){calMonth=0;calYear++;} calSyncSel(); render(); break;
    case "cal-day":
      /* 기간을 고치는 중 — 누른 날로 「가까운 쪽 끝」이 옮겨간다.
       * 시작 앞을 누르면 시작이 당겨지고, 마지막 뒤를 누르면 마지막이 늘어난다.
       * 기간 안쪽을 누르면 가까운 쪽이 그리로 줄어든다.
       * 한 번 누를 때마다 저장하고, 계속 고칠 수 있게 그대로 둔다. */
      if(tripEdit){
        var te2=S.events.find(function(x){ return x.id===tripEdit.id; });
        if(!te2){ tripEdit=null; render(); break; }
        var ka=te2.key, kb=te2.until||te2.key, na=ka, nb=kb;
        if(id<ka) na=id;
        else if(id>kb) nb=id;
        else if(Math.abs(dayGap(ka,id))<=Math.abs(dayGap(id,kb))) na=id; else nb=id;
        var tp={key:na,until:(na===nb)?null:nb};
        te2.key=tp.key; te2.until=tp.until;
        calSel=na; render(); dbUpdate("events",te2.id,tp);
        break;
      }
      /* 출장을 고른 상태면 두 번째 누른 날이 마지막 날이 된다.
       * 다 고른 뒤 또 누르면 그 날을 시작으로 삼고 처음부터 다시 —
       * 항공권 예매 달력과 같은 방식이라 따로 배울 게 없다. */
      saveDayDraft();
      if(dayKind===KIND_TRIP&&!tripUntil&&id>calSel){ tripUntil=id; render(); focusDayPanel(); break; }
      tripUntil=null; calSel=id; render(); focusDayPanel(); break;
    case "trip-reset": saveDayDraft(); tripUntil=null; render(); break;
    case "trip-edit":
      tripEdit=(tripEdit&&tripEdit.id===id)?null:{id:id};
      render(); focusCal(); break;
    case "trip-edit-off": tripEdit=null; render(); break;
    case "map": openMap(el.getAttribute("data-q")); break;
    case "ac-pick": {
      var it=placeAC.items[parseInt(el.getAttribute("data-i"),10)];
      var inp2=placeAC.input;
      if(it&&inp2) inp2.value=it.name;
      placeACHide();
      /* 기존 항목을 고치던 중이면 고르는 즉시 저장(= blur)하고,
       * 새로 만드는 중이면 계속 입력할 수 있게 커서를 남긴다. */
      if(inp2){ if(inp2.id==="inline-place") inp2.blur(); else inp2.focus(); }
      break;
    }
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
    case "law-ask": lawAskRun(); break;
    case "law-only": { if(lawOnly[id]) delete lawOnly[id]; else lawOnly[id]=true; render(); break; }
    case "law-only-all": { lawOnly={}; S.laws.forEach(function(l){ lawOnly[l.id]=true; }); render(); break; }
    case "law-only-none": { lawOnly={}; render(); break; }
    /* 묶음 머리말을 누르면 그 묶음만 — 「고시만 보고 싶다」가 흔한 일이다.
     * 이미 그 묶음이 다 켜져 있으면 끈다 (같은 자리를 두 번 누르면 되돌아온다). */
    case "law-only-kind": {
      var kn=S.laws.filter(function(x){ return String(lawKindOf(x).n)===id; });
      var allOn=kn.length&&kn.every(function(x){ return lawOnly[x.id]; });
      kn.forEach(function(x){ if(allOn) delete lawOnly[x.id]; else lawOnly[x.id]=true; });
      render(); break; }
    case "ask-more": lawAskMore=true; renderLawResults(); break;
    case "law-list": lawListOpen=!lawListOpen; render(); break;
    case "law-view": openLawView(id,parseInt(el.getAttribute("data-page"),10)||1); break;
    case "law-reindex": lawReindex(id); break;
    case "law-pdf": openLawPdf(id,parseInt(el.getAttribute("data-page"),10)||1); break;
    case "lv-close": closeLawView(); break;
    case "lv-pick": lawPickApply(); break;
    case "law-art": {
      var aid=parseInt(el.getAttribute("data-art-id"),10)||0;
      /* AI 가 고른 조라면 원문과 대조를 통과한 **근거 문장 하나만** 칠한다.
       * 낱말마다 칠하면 「제조소」가 스무 번 노래져 글을 못 읽는다. */
      /* 근거 문장이 없으면(「비슷한 대목만」) 아무것도 안 칠해져 어디를 볼지 몰랐다(이랑님: 「여긴 형광펜
       * 표시가 안 되네」). 그때는 AI 가 본문을 뒤진 낱말과 요지의 낱말을 칠한다. 뜻으로 찾은 결과(문장 Enter)를
       * 열 때도 질문의 낱말을 칠한다 — 글에 있는 것만 노래지므로 없는 낱말은 조용히 지나간다. */
      var pk=null;
      if(lawAsk&&lawAsk.picks) lawAsk.picks.forEach(function(x){ if(String(x.id)===String(aid)) pk=x; });
      if(pk){
        lawTermList=pk.quote?[pk.quote]:(lawAsk.words||[]).concat(lawTerms(lawAsk.gist||"")).filter(function(w,i,a){ return w.length>=2&&a.indexOf(w)===i; }).slice(0,8);
      } else if(lawSem&&!lawTermList.length){
        lawTermList=lawSem.q.split(/\s+/).map(function(w){ return w.replace(/[^\w가-힣]/g,""); }).filter(function(w,i,a){ return w.length>=2&&a.indexOf(w)===i; }).slice(0,8);
      }
      openLawArticle(aid,id);
      break;
    }
    case "lv-raw": if(lawView){ lawView.raw=true; renderLawModal(); } break;
    case "law-build-all": lawBuildAll(id==="all"); break;
    case "law-drop-old": {
      var olds=S.laws.filter(lawIsOld);
      if(!olds.length){ showToast("정리할 옛 판이 없어요."); break; }
      var lst=olds.map(function(l){ return "  · "+l.name; }).join("\n");
      if(!confirm("아래 "+olds.length+"개를 지웁니다. 같은 법령이 하나씩은 남습니다.\n\n"
        +lst+"\n\n계속할까요?")) break;
      olds.forEach(function(l){ del("laws",l.id,true); });
      showToast("✓ 옛 판 "+olds.length+"개를 지웠어요");
      break; }
    case "law-help": lawHelpToggle(); break;
    case "law-api-all": lawApiAll(); break;
    case "law-api-newer": lawApiNewer(); break;
    case "law-embed-all": lawEmbedAll(); break;
    case "law-api-new": lawApiNew(); break;
    case "law-cand": lawApiPick(lawApiCands&&lawApiCands.rows[parseInt(id,10)]); break;
    case "law-cands-x": lawApiCands=null; render(); break;
    case "law-site": { var ls=S.laws.find(function(x){ return x.id===id; }); if(ls) window.open(lawSiteUrl(ls),"_blank"); break; }
    case "lv-site": { var lv2=lawView&&S.laws.find(function(x){ return x.id===lawView.lawId; }); if(lv2) window.open(lawSiteUrl(lv2),"_blank"); break; }
    case "board-more": { var bt=el.getAttribute("data-table"); boardOpen[bt]=!boardOpen[bt]; render(); break; }
    case "board-clear": { var ct=el.getAttribute("data-table"); boardSearch[ct]=""; render(); break; }
    case "lv-art": lawPageToArt(); break;
    case "lv-page": lawArtToPage(); break;
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
    /* ---- 민원 답변 초안 ---- */
    case "ans-start": ansCitesAll(function(cs,q){ ansStart(cs,q); }); break;
    case "ask-close": { if(lawAsk&&lawAsk.picks) lawAsk.picks.forEach(function(p){ if(!(lawHits||[]).some(function(g){ return g.key==="a"+p.id; })) delete lawSel["a"+p.id]; });
      lawAsk=null; renderLawResults(); break; }
    case "ans-close": ansDraft=null; render(); break;
    case "ans-make": ansMake(); break;
    case "ans-mode": if(ansDraft){ ansDraft.mode=id; ansRegen(); renderAnsModal(true); } break;
    case "ans-regen": ansRegen(); renderAnsModal(true); break;
    case "ans-drop": if(ansDraft){ ansDraft.cites.splice(parseInt(id,10),1); renderAnsModal(); } break;
    case "ans-chip-open": { var cc=ansDraft&&ansDraft.cites[parseInt(id,10)]; if(cc&&cc.artId){ openLawArticle(cc.artId,cc.lawId); } break; }
    case "ans-fmt": ansFmtOpen=!ansFmtOpen; renderAnsModal(); break;
    case "ans-mark": ansFmt.hangul=(id==="han"); ansFmtSave(); ansRegen(); renderAnsModal(true); break;
    case "ans-style": ansFmt.style=(id==="classic")?"classic":"sinmungo"; ansFmtSave(); ansRegen(); renderAnsModal(true); break;
    case "rules": rulesOpen=!rulesOpen; renderRulesModal(); break;
    case "rules-save": { var ta=document.getElementById("rules-ta"); if(ta){ setPut("ai_rules",ta.value.trim()).then(function(){ showToast("✓ 규칙을 저장했어요 — 다음 조문 찾기·초안부터 AI 가 읽어요"); }); } rulesOpen=false; renderRulesModal(); break; }
    case "ans-brief": ansFmt.brief=(id==="on"); ansFmtSave(); ansRegen(); renderAnsModal(true); break;
    case "ans-end": ansFmt.end=!ansFmt.end; ansFmtSave(); ansRegen(); renderAnsModal(true); break;
    case "ans-fmt-reset": { var fk; for(fk in ANS_FMT0) ansFmt[fk]=ANS_FMT0[fk];
      ansFmtSave(); renderAnsModal(); break; }
    case "ans-copy": ansCopy(id); break;
    case "ans-txt": ansTxt(id); break;
    case "ans-hwpx": ansHwpx(id); break;
    case "ans-save": ansSave(id); break;
    case "ans-open": ansOpenId=(ansOpenId===id)?null:id; render(); break;
    case "ans-jump": ansOpenId=id; active="answers"; render(); break;
    /* 실태조사 노트 */
    case "insp-new": inspNewOpen=!inspNewOpen; if(inspNewOpen) inspLoadTpl().then(function(){ render(); },function(){}); render(); break;
    case "insp-newarea": { inspAreasTouched=true; var ai=inspNewAreas.indexOf(id); if(ai>=0) inspNewAreas.splice(ai,1); else inspNewAreas.push(id); el.classList.toggle("on"); break; }
    case "insp-create": inspCreate(); break;
    case "insp-open": inspOpenId=id; if(!INSP_PAGE_LABEL[inspPage]) inspPage="tour"; inspExpand={}; render(); break;
    case "insp-f": { if(id==="all") inspFilter={day:"",mine:false,bld:""}; else if(id==="mine") inspFilter.mine=!inspFilter.mine; else if(id.indexOf("day:")===0){ var dv=id.slice(4); inspFilter.day=(inspFilter.day===dv)?"":dv; } else if(id.indexOf("bld:")===0){ var bv=id.slice(4); inspFilter.bld=(inspFilter.bld===bv)?"":bv; } render(); break; }
    case "insp-areas": inspAreasOpen=!inspAreasOpen; render(); break;
    case "insp-agenda": inspAgendaOpen=!inspAgendaOpen; try{ localStorage.setItem("insp_agenda",inspAgendaOpen?"1":"0"); }catch(e){} render(); break;
    case "insp-refill": { var ir=S.inspections.find(function(x){ return x.id===id; }); if(ir&&confirm("본에서 온 줄을 새 본으로 바꿉니다. 같은 글의 체크·메모는 옮기고, 직접 적은 줄·방·발견은 남아요. 할까요?")) inspRefill(ir); break; }
    case "insp-back": inspOpenId=null; render(); break;
    case "insp-page": inspPage=id; inspExpand={}; render(); window.scrollTo(0,0); break;
    case "insp-done": { var it1=inspItem(id); if(it1){ it1.done=!it1.done; inspSave(it1); render(); } break; }
    case "insp-expand": { if(window.getSelection&&String(window.getSelection()).length) break; inspExpand[id]=!inspExpand[id]; render(); var ta=document.querySelector('.insp-memo[data-id="'+id+'"]'); if(ta&&inspExpand[id]) ta.focus(); break; }
    case "insp-add": inspAdd(id); break;
    case "insp-tofind": inspToFind(id); break;
    case "insp-grade": { var it2=inspItem(id); if(it2){ it2.grade=el.getAttribute("data-g"); inspSave(it2); render(); } break; }
    case "insp-bld": { var it3=inspItem(id); if(it3){ var g=el.getAttribute("data-g"); it3.building=(it3.building===g)?null:g; inspSave(it3); render(); } break; }
    case "insp-del": { var it4=inspItem(id); if(!it4) break; S.insp_items=S.insp_items.filter(function(x){ return x.id!==id; }); inspWrite("delete","insp_items",it4); render();
      showUndoToast("한 줄을 지웠어요",function(){ S.insp_items.push(it4); inspSave(it4); render(); }); break; }
    case "insp-area": { var ins=S.inspections.find(function(x){ return x.id===inspOpenId; }); if(!ins) break; ins.areas=ins.areas||[]; var k=ins.areas.indexOf(id); if(k>=0) ins.areas.splice(k,1); else ins.areas.push(id); inspWrite("upsert","inspections",ins); render(); break; }
    case "insp-status": { var ins2=S.inspections.find(function(x){ return x.id===id; }); if(ins2){ ins2.status=ins2.status==="끝남"?"진행":"끝남"; inspWrite("upsert","inspections",ins2); render(); } break; }
    case "insp-copyfind": inspCopyFinds(); break;
    case "ans-del": ansDel(id); break;
    case "ans-edit": ansReopen(id); break;
    case "ans-rcopy": { var rt=ansRowText(id);
      if(navigator.clipboard&&navigator.clipboard.writeText)
        navigator.clipboard.writeText(rt).then(function(){ showToast("✓ 복사했어요"); },
          function(){ lawCopyFallback(rt,function(){ showToast("✓ 복사했어요"); }); });
      else lawCopyFallback(rt,function(){ showToast("✓ 복사했어요"); });
      break; }
    case "ans-rtxt": { var b1=new Blob([ansRowText(id)],{type:"text/plain;charset=utf-8"});
      var a1=document.createElement("a"); a1.href=URL.createObjectURL(b1);
      a1.download="민원답변_"+keyOf(new Date())+".txt"; a1.click(); break; }
    case "ans-rhwpx": { try{
        var bf=hwpxMake(ansRowBlocks(id),"민원 답변");
        var a2=document.createElement("a");
        a2.href=URL.createObjectURL(new Blob([bf],{type:"application/hwp+zip"}));
        a2.download="민원답변_"+keyOf(new Date())+".hwpx"; a2.click();
        showToast("✓ 한글 파일로 받았어요");
      }catch(e2){ showToast("한글 파일을 만들지 못했어요",true); } break; }
    case "export": exportData(); break;
    case "import": importData(); break;
    case "logout": doLogout(); break;
  }
});

/* ========== 렌더 + 초기화 ========== */
/* 「AI에게 알려둔 우리 과 규칙」 — 조문 찾기(law-pick)와 초안(law-draft)이 매번 읽는 평문 메모.
 * 소관 구분·「이 말이 나오면 이 문서를 본다」 같은 것을 코드에 박으면 다음 사안에서 또 틀린다(2026-09-10 사례 정리 문서).
 * 이랑님이 평문으로 적어 두면 AI 가 프롬프트에서 읽는다. 자리는 왼쪽 아래 — 가끔 손대는 것이라 화면에 안 둔다. */
var rulesOpen=false;
function renderRulesModal(){
  var el=document.getElementById("rules-modal"); if(!el) return;
  if(!rulesOpen){ el.innerHTML=""; return; }
  el.innerHTML='<div class="ans-back" data-act="rules"></div>'
    + '<div class="ans-win rules-modal" role="dialog"><div class="ans-top"><b>AI에게 알려둔 우리 과 규칙</b><button class="ans-x" data-act="rules" title="닫기">✕</button></div>'
    + '<div class="ans-scroll">'
    + '<p class="ans-fmt-note">조문을 찾을 때와 초안을 쓸 때 AI 가 먼저 읽습니다. 평소 말로 적으세요. 한 줄에 하나.</p>'
    + '<textarea class="input" id="rules-ta" rows="12" placeholder="예)\n- 「시험생산용 적합판정서」가 나오면 바이오의약품 전문수탁 제조업체 GMP 평가 절차 9쪽 적용범위를 반드시 본다.\n- 실태조사 생략·서류평가는 바이오의약품 사전 GMP 평가 지침 3-1·3-2 가 기준이다. 규칙 제48조의2·제48조의3 은 지방청 제조소 단위 적합판정 조문이라 품목별 사전 GMP 평가 민원에는 인용하지 않는다.\n- 「…할 수 있다」 조문만으로 「필수가 아니다」라고 쓰지 않는다.">'+esc(setGet("ai_rules"))+'</textarea>'
    + '</div><div class="ans-pane-foot rules-foot"><button class="btn quiet sm" data-act="rules">닫기</button><button class="btn sm ans-save-btn" data-act="rules-save">저장</button></div></div>';
}
function render(){
  renderTabs();
  renderRulesModal();
  if(active==="today") renderToday();
  else if(active==="calendar") renderCalendar();
  else if(active==="articles") renderArticles();
  else if(active==="mfds") renderMfds();
  else if(active==="laws") renderLaws();
  else if(active==="answers") renderAnswers();
  else if(active==="insp") renderInsp();
}

/* 앱 시작 (로그인 후 호출) */
function startApp(){
  appStarted=true;
  showApp();
  document.getElementById("loading").style.display="flex";
  document.getElementById("loading").className="loading-overlay";
  document.getElementById("loading").querySelector(".loading-text").textContent="데이터를 불러오는 중...";
  loadAll().then(function(){
    ansFmtLoadRemote();
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

/* ========== 실태조사 노트 (v165 · 2026-09-10) ==========
 * 실사 한 건 = 노트 한 권. 페이지 아홉 장(준비·1~3일차·내 담당·방·서류·질문·발견)을 손가락으로 넘긴다.
 * 본(insp_template.json)을 복사해 시작한다 — 이랑님 체크리스트 + 별첨 1-5 실태조사(GMP) 45항목.
 * 현장은 통신이 끊긴다: 체크·메모는 기기(localStorage)에 먼저 적히고, 못 올린 것은 줄을 서 있다가
 * 통신이 돌아오면 올라간다(inspQ). 화면 위 「저장 대기 N」이 그 줄이다. 앱 껍데기는 sw.js 가 캐시한다. */
/* 페이지 여섯: 준비(챙길 것) · 일정(3일 흐름·서류 요청 시점) · 현장(돌면서 보기·묻기) · 서류 검토(호텔에서, 별첨 45항목 녹임) · 방 · 발견.
 * 「일차」「질문」「내 담당」 페이지는 v166 에서 뺐다 — 같은 것을 두 번 묻고 현장·서류가 섞였다(이랑님 「UX/UI 가 너무 안 좋은 것 같아」).
 * 날·내 담당·건물은 페이지가 아니라 위의 거르기(inspFilter)다. */
var INSP_PAGES=[["prep","준비"],["plan","일정"],["tour","현장"],["review","서류 검토"],["rooms","방"],["findings","발견"]];
var INSP_OLD_PAGE={d1:"plan",d2:"plan",d3:"plan",docs:"plan",questions:"review",mine:"tour"};
var INSP_DAY_LABEL={d1:"1일차",d2:"2일차",d3:"3일차",d4:"4일차",d5:"5일차"};
var inspFilter={day:"",mine:false,bld:""};
var INSP_PAGE_LABEL={}; INSP_PAGES.forEach(function(p){ INSP_PAGE_LABEL[p[0]]=p[1]; });
var inspOpenId=null, inspPage="tour", inspTpl=null, inspNewOpen=false, inspExpand={}, inspTimers={};
/* 「내 담당」 기본값은 본의 업무분장(mine)이다 — 이랑님이 칩을 열두 번 켤 일이 없게. 한 번이라도 손대면 그대로 둔다 */
var inspNewAreas=["압축공기·가스"], inspAreasTouched=false;

function inspItems(id){ return (S.insp_items||[]).filter(function(x){ return x.insp_id===id; }).sort(function(a,b){ return (a.seq||0)-(b.seq||0); }); }
function inspLoadTpl(){
  if(inspTpl) return Promise.resolve(inspTpl);
  return fetch("insp_template.json?v="+APP_VER).then(function(r){ return r.json(); }).then(function(t){
    inspTpl=t; if(t.mine&&t.mine.length&&!inspAreasTouched) inspNewAreas=t.mine.slice();
    try{ localStorage.setItem("insp_tpl",JSON.stringify(t)); }catch(e){} return t;
  }).catch(function(){
    try{ var c=localStorage.getItem("insp_tpl"); if(c){ inspTpl=JSON.parse(c); return inspTpl; } }catch(e){}
    throw new Error("체크리스트 본을 못 불러왔어요. 통신이 되는 곳에서 한 번 열어 주세요.");
  });
}

/* --- 오프라인: 기기 저장 + 올릴 줄 --- */
var inspQ=(function(){ try{ return JSON.parse(localStorage.getItem("insp_queue")||"[]"); }catch(e){ return []; } })();
function inspQSave(){ try{ localStorage.setItem("insp_queue",JSON.stringify(inspQ)); }catch(e){} }
function inspCacheSave(){ try{ localStorage.setItem("insp_cache",JSON.stringify({inspections:S.inspections||[],insp_items:S.insp_items||[],events:S.events||[]})); }catch(e){} }
function inspCache(){ try{ return JSON.parse(localStorage.getItem("insp_cache")||"null"); }catch(e){ return null; } }
function inspQPush(w){ inspQ=inspQ.filter(function(x){ return !(x.table===w.table&&x.id===w.id&&x.op===w.op); }); inspQ.push(w); inspQSave(); inspBadge(); }
function inspWrite(op,table,item){
  inspCacheSave();
  var w={op:op,table:table,item:item,id:item.id};
  if(!navigator.onLine){ inspQPush(w); return Promise.resolve(); }
  var p=op==="delete"
    ? withAuthRetry(function(){ return sb.from(table).delete().eq("id",item.id); })
    : withAuthRetry(function(){ return sb.from(table).upsert(toRemote(table,item)); });
  return p.then(function(res){ if(res&&res.error) inspQPush(w); },function(){ inspQPush(w); });
}
function inspFlush(){
  if(!inspQ.length||!navigator.onLine) return;
  var q=inspQ.slice(); inspQ=[]; inspQSave();
  var p=Promise.resolve();
  q.forEach(function(w){ p=p.then(function(){ return inspWrite(w.op,w.table,w.item); }); });
  p.then(function(){ inspBadge(); if(!inspQ.length&&q.length) showToast("✓ 현장에서 적은 "+q.length+"건을 올렸어요"); });
}
window.addEventListener("online",function(){ setTimeout(inspFlush,1500); });
function inspBadge(){ var b=document.getElementById("insp-q"); if(b){ b.textContent=inspQ.length?"저장 대기 "+inspQ.length:""; b.style.display=inspQ.length?"":"none"; } }
/* 읽어 오지 못한 표(오프라인)는 기기에 적어 둔 것으로 채운다 — loadAll 이 부른다 */
function inspApplyCache(failedTables){
  var c=inspCache(); if(!c) return;
  ["inspections","insp_items","events"].forEach(function(t){ if(failedTables.indexOf(t)>=0&&Array.isArray(c[t])) S[t]=c[t]; });
  /* 아직 못 올린 것은 서버 것보다 새것이다 — 그걸로 덮는다 */
  inspQ.forEach(function(w){
    if(w.op!=="upsert"||!S[w.table]) return;
    var i=S[w.table].findIndex(function(x){ return x.id===w.id; });
    if(i>=0) S[w.table][i]=w.item; else S[w.table].push(w.item);
  });
}

/* --- 화면 --- */
function inspCountable(x){ return x.kind!=="room"&&x.kind!=="find"; }
function inspNeedsRefill(insp){
  var it=inspItems(insp.id);
  if(inspTpl&&insp.tpl&&insp.tpl!==inspTpl.version) return true;
  return it.some(function(x){ return !!INSP_OLD_PAGE[x.page]; });
}
/* 본이 바뀌었을 때 — 본에서 온 줄은 새 본으로 갈고, 같은 글이 있으면 체크·메모를 옮긴다. 손으로 적은 줄·방·발견은 남긴다(옛 페이지면 옮긴다). */
var inspBusy=false;
/* 같은 노트에 같은 줄(페이지·묶음·글·본)이 둘이면 하나만 — 2026-09-10 「새 본으로 다시 채우기」가 두 번 눌려 252줄이 됐다.
   체크·메모 있는 쪽을 남기고 나머지는 서버에서도 지운다. 직접 적은 줄(src 없음)은 건드리지 않는다. */
function inspDedupe(){
  var seen={}, drop=[];
  (S.insp_items||[]).slice().sort(function(a,b){ return (b.done?1:0)-(a.done?1:0)||((b.memo?1:0)-(a.memo?1:0)); }).forEach(function(x){
    if(!x.src) return;
    var k=[x.insp_id,x.page,x.section||"",x.text,x.src].join("|");
    if(seen[k]) drop.push(x); else seen[k]=1;
  });
  if(!drop.length) return 0;
  var ids={}; drop.forEach(function(x){ ids[x.id]=1; });
  S.insp_items=S.insp_items.filter(function(x){ return !ids[x.id]; });
  drop.forEach(function(x){ inspWrite("delete","insp_items",x); });
  return drop.length;
}
function inspRefill(insp){
  if(inspBusy) return; inspBusy=true;
  inspLoadTpl().then(function(t){
    var old=inspItems(insp.id), norm=function(x){ return String(x||"").replace(/\s+/g,""); };
    var carry={}; old.forEach(function(x){ if(x.src&&(x.done||x.memo)) carry[norm(x.text)]={done:x.done,memo:x.memo}; });
    /* 새 본에 같은 글이 없는데 체크·메모가 달린 줄은 지우지 않는다 — 현장에서 적은 것이 조용히 사라진다.
     * (본이 3일 → 5일로 바뀌면서 일정 줄의 글이 거의 다 바뀌었다.) 직접 적은 줄로 돌려 남긴다. */
    var inTpl={}; t.items.forEach(function(x){ inTpl[norm(x.text)]=1; });
    var orphan=old.filter(function(x){ return x.src&&(x.done||x.memo)&&!inTpl[norm(x.text)]; });
    var gone=old.filter(function(x){ return !!x.src&&orphan.indexOf(x)<0; });
    var keep=old.filter(function(x){ return !x.src; }).concat(orphan);
    orphan.forEach(function(x){ x.src=null; x.section=(x.section||"직접 적음")+" · 옛 본"; });
    keep.forEach(function(x){ if(INSP_OLD_PAGE[x.page]){ x.page=INSP_OLD_PAGE[x.page]; } inspSave(x); });
    var seq=Math.max.apply(null,[0].concat(keep.map(function(x){ return x.seq||0; })))+1;
    var items=t.items.map(function(x,i){ var c=carry[norm(x.text)]||{}; return {id:uuid(),insp_id:insp.id,page:x.page,section:x.section||null,seq:seq+i,kind:x.kind||"task",text:x.text,hint:x.hint||null,building:x.building||null,area:x.area||null,day:x.day||null,done:!!c.done,memo:c.memo||null,grade:null,ref:null,src:x.src||"본"}; });
    S.insp_items=S.insp_items.filter(function(x){ return x.insp_id!==insp.id; }).concat(keep,items);
    /* 담당 영역을 아직 안 건드린 노트(한 개 이하)면 본의 업무분장대로 켜 준다 — 칩을 열둘 켤 일이 없게 */
    var areaSet=false;
    if(t.mine&&t.mine.length&&(insp.areas||[]).length<=1){ insp.areas=t.mine.slice(); areaSet=true; }
    insp.tpl=t.version; inspWrite("upsert","inspections",insp);
    gone.forEach(function(x){ inspWrite("delete","insp_items",x); });
    if(navigator.onLine){
      withAuthRetry(function(){ return sb.from("insp_items").insert(items.map(function(x){ return toRemote("insp_items",x); })); })
        .then(function(res){ if(res&&res.error) items.forEach(function(x){ inspQPush({op:"upsert",table:"insp_items",item:x,id:x.id}); }); });
    } else items.forEach(function(x){ inspQPush({op:"upsert",table:"insp_items",item:x,id:x.id}); });
    inspCacheSave(); inspPage="tour"; inspBusy=false; render();
    var moved=Object.keys(carry).length;
    showToast("✓ 새 본으로 채웠어요 — "+items.length+"줄"+(moved?", 체크·메모 "+moved+"줄 옮김":"")+(orphan.length?", 옛 줄 "+orphan.length+"개는 그대로 남겼어요":"")+(areaSet?". 「내 담당」도 업무분장대로 켰어요":""));
  },function(e){ inspBusy=false; showToast(e.message,true); });
}
function inspProgress(insp){
  var it=inspItems(insp.id).filter(inspCountable);
  var d=it.filter(function(x){ return x.done; }).length;
  return {done:d,total:it.length,finds:inspItems(insp.id).filter(function(x){ return x.kind==="find"; }).length};
}
function inspDates(insp){
  if(!insp.start_date) return "";
  var a=insp.start_date, b=insp.end_date||a;
  return shortDate(a)+(b!==a?" ~ "+shortDate(b):"");
}
function inspBuildingTags(insp){
  return (insp.buildings||[]).map(function(b){ return '<span class="insp-b">'+esc(b.name)+' <i>'+esc(b.mode||"")+'</i></span>'; }).join(" ");
}
function inspNewHtml(){
  var areas=(inspTpl&&inspTpl.areas)||["제조소 연혁","작업소","시설·환경","압축공기·가스","기준서·SOP","공정밸리데이션","적격성평가","세척밸리데이션","제조기록서","위탁제조","일탈·변경","작업원 위생"];
  if(!inspNewOpen) return '<div class="add-row quick"><button class="btn" data-act="insp-new">＋ 새 실사 노트</button><span class="muted">본(바이오 원액 5일)을 복사해서 시작해요</span></div>';
  return '<div class="card composer insp-new">'
    + '<input class="input" id="insp-title" placeholder="업체 · 제조소 (예: ○○바이오 오송)" />'
    + '<div class="insp-new-row"><label>시작일 <input class="input" type="date" id="insp-start" value="'+keyOf(new Date())+'" /></label>'
    +   '<label>일수 <input class="input insp-days" type="number" id="insp-days" value="5" min="1" max="10" /></label></div>'
    + '<input class="input" id="insp-buildings" placeholder="건물 (예: 633 변경만, 636 전체)" value="633 변경만, 636 전체, 630 창고, 660 시험실" />'
    + '<input class="input" id="insp-partner" placeholder="같이 가는 사람 (예: 김해인 선생님 — 3일차 공유)" />'
    + '<div class="insp-areas"><span class="muted">내 담당</span>'+areas.map(function(a){ return '<button class="chip'+(inspNewAreas.indexOf(a)>=0?" on":"")+'" data-act="insp-newarea" data-id="'+esc(a)+'">'+esc(a)+'</button>'; }).join("")+'</div>'
    + '<div class="composer-foot"><span class="muted">캘린더에 일정이 같이 들어가요</span><button class="btn quiet sm" data-act="insp-new">닫기</button><button class="btn sm" data-act="insp-create">노트 만들기</button></div>'
    + '</div>';
}
function inspListHtml(list){
  if(!list.length) return '<div class="empty-box"><p>아직 실사 노트가 없어요. 위에서 하나 만들어 보세요.</p></div>';
  return '<div class="insp-list">'+list.map(function(x){
    var p=inspProgress(x), pct=p.total?Math.round(p.done/p.total*100):0;
    return '<div class="card insp-card'+(x.status==="끝남"?" done":"")+'" data-act="insp-open" data-id="'+esc(x.id)+'">'
      + '<div class="insp-card-t"><span>'+esc(x.title)+'</span><span class="meta-pill'+(x.status==="끝남"?"":" accent")+'">'+esc(x.status||"진행")+'</span></div>'
      + '<div class="insp-card-s">'+esc(inspDates(x))+(x.partner?' · '+esc(x.partner):'')+(x.areas&&x.areas.length?' · '+esc(x.areas.join("·"))+' 담당':'')+'</div>'
      + '<div class="insp-card-s">'+inspBuildingTags(x)+'</div>'
      + '<div class="insp-bar"><i style="width:'+pct+'%"></i></div>'
      + '<div class="insp-card-s">체크 '+p.done+'/'+p.total+' · 발견 '+p.finds+'</div>'
      + '</div>';
  }).join("")+'</div>';
}
function inspRowHtml(x,insp){
  var open=!!inspExpand[x.id], custom=!x.src, free=(x.kind==="room"||x.kind==="find");
  var tags=(x.building?'<span class="insp-b">'+esc(x.building)+'</span>':'')+(x.area?'<span class="insp-a">'+esc(x.area)+'</span>':'')
    +(x.day&&x.page!=="plan"?'<span class="insp-d">'+esc(INSP_DAY_LABEL[x.day]||x.day)+'</span>':'');
  var kindTag=x.page==="tour"?(x.kind==="q"?'<span class="insp-k ask">묻기</span>':'<span class="insp-k look">보기</span>'):(x.kind==="doc"?'<span class="insp-k doc">서류 요청</span>':'');
  if(free){
    return '<li class="insp-row free" data-id="'+esc(x.id)+'">'
      + '<div class="insp-body">'
      +   '<div class="insp-free-h"><input class="insp-title-in" data-id="'+esc(x.id)+'" value="'+esc(x.text)+'" placeholder="'+(x.kind==="room"?"방 이름":"무엇이 이상한가")+'" />'
      +     (x.kind==="find"?'<span class="insp-grades">'+["보완 예상","참고"].map(function(g){ return '<button class="chip'+(x.grade===g?" on":"")+'" data-act="insp-grade" data-id="'+esc(x.id)+'" data-g="'+g+'">'+g+'</button>'; }).join("")
      +       (insp.buildings||[]).map(function(b){ return '<button class="chip'+(x.building===b.name?" on":"")+'" data-act="insp-bld" data-id="'+esc(x.id)+'" data-g="'+esc(b.name)+'">'+esc(b.name)+'</button>'; }).join("")+'</span>':'')
      +     '<button class="del" data-act="insp-del" data-id="'+esc(x.id)+'" title="지우기">✕</button></div>'
      +   (x.kind==="find"?'<input class="insp-ref-in" data-id="'+esc(x.id)+'" value="'+esc(x.ref||"")+'" placeholder="근거 (예: PIC/S Annex 1 · ICH Q9 · 규칙 별표 1 3.5)" />':'')
      +   '<textarea class="insp-memo" data-id="'+esc(x.id)+'" rows="2" placeholder="'+(x.kind==="room"?"이 방의 특징 — 등급, 설비, 눈에 띈 것":"본 것 · 들은 것 · 서류 번호")+'">'+esc(x.memo||"")+'</textarea>'
      + '</div></li>';
  }
  return '<li class="insp-row'+(x.done?" done":"")+(open?" open":"")+'" data-id="'+esc(x.id)+'">'
    + '<button class="check'+(x.done?" on":"")+'" data-act="insp-done" data-id="'+esc(x.id)+'">✓</button>'
    + '<div class="insp-body" data-act="insp-expand" data-id="'+esc(x.id)+'">'
    +   '<div class="insp-text">'+kindTag+esc(x.text)+' '+tags+'</div>'
    +   (x.hint?'<div class="insp-hint">'+esc(x.hint)+'</div>':'')
    +   (!open&&x.memo?'<div class="insp-memo-pv">📝 '+esc(x.memo)+'</div>':'')
    + '</div>'
    + (open?'<div class="insp-exp"><textarea class="insp-memo" data-id="'+esc(x.id)+'" rows="2" placeholder="메모 — 본 것 · 답변 · 서류 번호">'+esc(x.memo||"")+'</textarea>'
        + '<div class="insp-exp-acts"><button class="link-btn" data-act="insp-tofind" data-id="'+esc(x.id)+'">발견으로 옮기기 →</button>'
        + (custom?'<button class="link-btn quiet-link" data-act="insp-del" data-id="'+esc(x.id)+'">지우기</button>':'')+'</div></div>':'')
    + '</li>';
}
function inspSectionsHtml(items,insp,showPage){
  if(!items.length) return '<div class="empty-box sm"><p>여기엔 아직 아무것도 없어요.</p></div>';
  var order=[], by={};
  items.forEach(function(x){ var k=(showPage?INSP_PAGE_LABEL[x.page]+" · ":"")+(x.section||""); if(!by[k]){ by[k]=[]; order.push(k); } by[k].push(x); });
  return order.map(function(k){
    var rows=by[k], n=rows.filter(function(x){ return x.done; }).length, cnt=rows.filter(inspCountable).length;
    return '<section class="insp-sec"><div class="insp-sec-h"><span>'+esc(k)+'</span>'+(cnt?'<span class="muted">'+n+'/'+cnt+'</span>':'')+'</div><ul class="list">'
      + rows.map(function(x){ return inspRowHtml(x,insp); }).join("")+'</ul></section>';
  }).join("");
}
function inspAddRowHtml(page){
  var ph={rooms:"방 이름 (예: 633-2F 배양실) — Enter",findings:"발견 한 줄 — Enter 하면 아래에 생겨요",prep:"챙길 것 한 줄 더 — Enter",plan:"일정·서류 요청 한 줄 더 — Enter",tour:"현장에서 볼 것·물을 것 한 줄 더 — Enter",review:"검토 포인트 한 줄 더 — Enter"}[page];
  if(!ph) return "";
  return '<div class="add-row quick insp-add"><input class="input" id="insp-add" placeholder="'+ph+'" /><button class="btn sm" data-act="insp-add" data-id="'+page+'">＋</button></div>';
}
function inspFilterHtml(insp,items){
  var days=[]; items.forEach(function(x){ if(x.day&&days.indexOf(x.day)<0) days.push(x.day); }); days.sort();
  var chips='<button class="chip'+(!inspFilter.day&&!inspFilter.mine&&!inspFilter.bld?" on":"")+'" data-act="insp-f" data-id="all">전체</button>';
  days.forEach(function(d){ chips+='<button class="chip'+(inspFilter.day===d?" on":"")+'" data-act="insp-f" data-id="day:'+d+'">'+esc(INSP_DAY_LABEL[d]||d)+'</button>'; });
  chips+='<button class="chip mine'+(inspFilter.mine?" on":"")+'" data-act="insp-f" data-id="mine">내 담당만</button>';
  (insp.buildings||[]).forEach(function(b){ chips+='<button class="chip'+(inspFilter.bld===b.name?" on":"")+'" data-act="insp-f" data-id="bld:'+esc(b.name)+'">'+esc(b.name)+'</button>'; });
  chips+='<button class="link-btn quiet-link" data-act="insp-areas">담당 영역 고르기</button>';
  return '<div class="insp-filters">'+chips+'</div>';
}
function inspApplyFilter(items,insp){
  return items.filter(function(x){
    if(inspFilter.day&&x.day&&x.day!==inspFilter.day) return false;
    if(inspFilter.day&&!x.day&&x.page!=="prep") return false;
    if(inspFilter.mine&&!(x.area&&(insp.areas||[]).indexOf(x.area)>=0)) return false;
    if(inspFilter.bld&&x.building&&x.building!==inspFilter.bld) return false;
    return true;
  });
}
var inspAreasOpen=false;
var inspAgendaOpen=(function(){ try{ return localStorage.getItem("insp_agenda")!=="0"; }catch(e){ return true; } })();
/* 타임 스케줄 — 아젠다를 보기만 하는 자리다(이랑님 「메모 할 건 아니고 그냥 보려는 거」).
 * 본(insp_template.json)의 agenda 를 그대로 그린다. 줄이 아니라 표라서 체크·메모가 붙지 않고,
 * 위의 날 거르기(1일차…)를 켜면 그 날만 남는다 — 새 버튼을 만들지 않았다. */
function inspAgendaHtml(){
  var a=inspTpl&&inspTpl.agenda; if(!a) return "";
  var head='<div class="insp-ag-h" data-act="insp-agenda"><span>타임 스케줄</span>'
    + '<span class="muted">'+esc(a.period||"")+' · '+(inspAgendaOpen?"접기":"펴기")+'</span></div>';
  if(!inspAgendaOpen) return '<div class="insp-ag">'+head+'</div>';
  var days=(a.days||[]).filter(function(d){ return !inspFilter.day||d.day===inspFilter.day; });
  var who=(a.who||[]).map(function(x){ return '<span class="insp-ag-p'+(x.indexOf("나 —")>=0?" me":"")+'">'+esc(x)+'</span>'; }).join("");
  var body=days.map(function(d){
    return '<div class="insp-ag-d"><b>'+esc(INSP_DAY_LABEL[d.day]||d.day)+'</b><span class="muted">'+esc(d.date||"")+'</span></div>'
      + '<table class="insp-ag-t">'+(d.rows||[]).map(function(r){
          return '<tr'+(r.me?' class="me"':'')+'><td class="t">'+esc(r.t||"")+'</td><td>'
            + '<span class="w">'+esc(r.w||"")+'</span>'+(r.who?'<i>'+esc(r.who)+'</i>':'')
            + (r.sub?'<span class="sub">'+esc(r.sub)+'</span>':'')+'</td></tr>';
        }).join("")+'</table>';
  }).join("");
  return '<div class="insp-ag open">'+head+'<div class="insp-ag-who">'+who+'</div>'+body
    + '<div class="insp-ag-f">진한 줄이 내가 들어가는 자리예요 · 숫자는 조사관 번호</div></div>';
}
function inspNoteHtml(insp){
  var all=inspItems(insp.id), pg=inspPage, body="";
  var counts={}; INSP_PAGES.forEach(function(p){ var it=all.filter(function(x){ return x.page===p[0]&&inspCountable(x); }); counts[p[0]]=it.length?it.filter(function(x){ return x.done; }).length+"/"+it.length:""; });
  counts.rooms=String(all.filter(function(x){ return x.kind==="room"; }).length||"");
  counts.findings=String(all.filter(function(x){ return x.kind==="find"; }).length||"");
  var items=all.filter(function(x){ return x.page===pg; });
  var filt=(pg==="tour"||pg==="review"||pg==="plan");
  if(filt) items=inspApplyFilter(items,insp);
  var areasHtml="";
  if(inspAreasOpen){
    var areas=(inspTpl&&inspTpl.areas)||[]; (insp.areas||[]).forEach(function(a){ if(areas.indexOf(a)<0) areas=areas.concat([a]); });
    areasHtml='<div class="insp-areas"><span class="muted">내 담당 — 켜 둔 영역이 「내 담당만」에 모여요</span>'+areas.map(function(a){ return '<button class="chip'+((insp.areas||[]).indexOf(a)>=0?" on":"")+'" data-act="insp-area" data-id="'+esc(a)+'">'+esc(a)+'</button>'; }).join("")+'</div>';
  }
  body=(filt?inspFilterHtml(insp,all.filter(function(x){ return x.page===pg; }))+areasHtml:"")
    +(pg==="plan"?inspAgendaHtml():"")+inspAddRowHtml(pg)+inspSectionsHtml(items,insp,false);
  if(pg==="findings"&&items.length) body+='<div class="insp-foot-acts"><button class="btn quiet sm" data-act="insp-copyfind">발견 전부 복사</button><span class="muted">검토서에 붙일 때 — 한글 내보내기는 다음 판에</span></div>';
  var refill=inspNeedsRefill(insp)?'<div class="insp-refill">본이 새로워졌어요(준비·일정·현장·서류 검토). <button class="link-btn" data-act="insp-refill" data-id="'+esc(insp.id)+'">새 본으로 다시 채우기</button> <span class="muted">같은 글의 체크·메모는 옮기고, 직접 적은 줄·방·발견은 남아요.</span></div>':"";
  return '<div class="insp-head">'
    + '<button class="link-btn" data-act="insp-back">← 실태조사</button>'
    + '<div class="insp-head-t"><b>'+esc(insp.title)+'</b><span class="muted">'+esc(inspDates(insp))+(insp.partner?' · '+esc(insp.partner):'')+'</span><div class="insp-head-b">'+inspBuildingTags(insp)+'</div></div>'
    + '<span class="insp-q" id="insp-q" style="display:none"></span>'
    + '<button class="link-btn quiet-link" data-act="insp-status" data-id="'+esc(insp.id)+'">'+(insp.status==="끝남"?"다시 진행으로":"끝남으로")+'</button>'
    + '</div>'
    + refill
    + '<div class="insp-tabs">'+INSP_PAGES.map(function(p){ return '<button class="insp-tab'+(pg===p[0]?" on":"")+'" data-act="insp-page" data-id="'+p[0]+'">'+p[1]+(counts[p[0]]?'<i>'+counts[p[0]]+'</i>':'')+'</button>'; }).join("")+'</div>'
    + '<div class="insp-page">'+body+'</div>';
}
function renderInsp(){
  var list=(S.inspections||[]).slice().sort(function(a,b){ return String(b.start_date||"").localeCompare(String(a.start_date||"")); });
  var cur=inspOpenId?list.find(function(x){ return x.id===inspOpenId; }):null;
  /* 본이 아직 안 왔으면 오는 대로 한 번 더 그린다 — 노트를 열어 둔 채여도(타임 스케줄이 본에 있다) */
  if(!inspTpl) inspLoadTpl().then(function(){ if(active==="insp") render(); },function(){});
  if(!cur){
    inspOpenId=null;
    view().innerHTML='<div class="page">'+pageHead2("실태조사","실사 한 건이 노트 한 권이에요. 현장에서 통신이 끊겨도 체크와 메모는 되고, 돌아오면 저장돼요.",list.length?[pill("실사 "+list.length+"건")]:null)
      + inspNewHtml()+inspListHtml(list)+'</div>';
    var t=document.getElementById("insp-title"); if(t&&inspNewOpen&&!t.value) t.focus();
    return;
  }
  view().innerHTML='<div class="page insp-note">'+inspNoteHtml(cur)+'</div>';
  inspBadge(); wireInspNote(cur);
}
function inspSave(item){ inspWrite("upsert","insp_items",item); }
function inspItem(id){ return (S.insp_items||[]).find(function(x){ return x.id===id; }); }
function wireInspNote(insp){
  var root=view();
  /* 메모·이름·근거 — 글쇠마다 저장하지 않고 잠깐 모아서 */
  function wire(sel,field){
    Array.prototype.forEach.call(root.querySelectorAll(sel),function(el){
      el.addEventListener("input",function(){
        var it=inspItem(el.getAttribute("data-id")); if(!it) return;
        it[field]=el.value; clearTimeout(inspTimers[it.id+field]);
        inspTimers[it.id+field]=setTimeout(function(){ inspSave(it); },700);
      });
    });
  }
  wire(".insp-memo","memo"); wire(".insp-title-in","text"); wire(".insp-ref-in","ref");
  var add=document.getElementById("insp-add");
  if(add) add.addEventListener("keydown",function(e){ if(e.key==="Enter"){ e.preventDefault(); inspAdd(inspPage); } });
  /* 길게 누르면 발견으로 — 손가락용 */
  Array.prototype.forEach.call(root.querySelectorAll('.insp-body[data-act="insp-expand"]'),function(el){
    var t=null;
    el.addEventListener("touchstart",function(){ t=setTimeout(function(){ t=null; inspToFind(el.getAttribute("data-id")); },600); },{passive:true});
    ["touchend","touchmove","touchcancel"].forEach(function(ev){ el.addEventListener(ev,function(){ if(t){ clearTimeout(t); t=null; } },{passive:true}); });
  });
}
function inspAdd(page){
  var el=document.getElementById("insp-add"); var v=(el&&el.value||"").trim(); if(!v) return;
  var insp=S.inspections.find(function(x){ return x.id===inspOpenId; }); if(!insp) return;
  var kind=page==="rooms"?"room":page==="findings"?"find":page==="review"?"q":"task";
  var seq=Math.max.apply(null,[0].concat(inspItems(insp.id).map(function(x){ return x.seq||0; })))+1;
  var it={id:uuid(),insp_id:insp.id,page:page,section:(kind==="room"||kind==="find")?null:"직접 적음",seq:seq,kind:kind,text:v,hint:null,building:null,area:null,done:false,memo:null,grade:kind==="find"?"참고":null,ref:null,src:null};
  S.insp_items.push(it); inspSave(it); render();
  if(kind==="room"||kind==="find"){ var m=document.querySelector('.insp-memo[data-id="'+it.id+'"]'); if(m) m.focus(); }
  else { var a=document.getElementById("insp-add"); if(a) a.focus(); }
}
function inspToFind(id){
  var src=inspItem(id); if(!src||src.kind==="find") return;
  var seq=Math.max.apply(null,[0].concat(inspItems(src.insp_id).map(function(x){ return x.seq||0; })))+1;
  var it={id:uuid(),insp_id:src.insp_id,page:"findings",section:null,seq:seq,kind:"find",text:src.text,hint:null,building:src.building||null,area:src.area||null,done:false,memo:src.memo||null,grade:"참고",ref:null,src:"←"+INSP_PAGE_LABEL[src.page]};
  S.insp_items.push(it); inspSave(it); inspPage="findings"; render();
  var m=document.querySelector('.insp-memo[data-id="'+it.id+'"]'); if(m) m.focus();
  showToast("발견 페이지로 옮겼어요");
}
function inspCreate(){
  if(inspBusy) return;
  var title=(val("insp-title")||"").trim(); if(!title){ showToast("업체·제조소 이름을 적어 주세요."); return; }
  inspBusy=true;
  var start=val("insp-start")||keyOf(new Date()), days=Math.max(1,parseInt(val("insp-days")||"3",10)||3);
  var d=new Date(start+"T00:00:00"); d.setDate(d.getDate()+days-1); var end=keyOf(d);
  var buildings=(val("insp-buildings")||"").split(/[,、]/).map(function(s){ s=s.trim(); if(!s) return null; var m=/^(\S+)\s*(.*)$/.exec(s); return {name:m[1],mode:m[2]||""}; }).filter(Boolean);
  var partner=(val("insp-partner")||"").trim()||null;
  inspLoadTpl().then(function(t){
    var insp={id:uuid(),title:title,site:null,start_date:start,end_date:end,buildings:buildings,areas:inspNewAreas.slice(),partner:partner,status:"진행",notes:null,tpl:null};
    insp.tpl=t.version;
    var items=t.items.map(function(x,i){ return {id:uuid(),insp_id:insp.id,page:x.page,section:x.section||null,seq:i+1,kind:x.kind||"task",text:x.text,hint:x.hint||null,building:x.building||null,area:x.area||null,day:x.day||null,done:false,memo:null,grade:null,ref:null,src:x.src||"본"}; });
    S.inspections=S.inspections||[]; S.insp_items=S.insp_items||[];
    S.inspections.unshift(insp); S.insp_items=S.insp_items.concat(items); inspCacheSave();
    var ev={id:uuid(),key:start,until:end,title:"실태조사 · "+title,place:null,time:null,memo:(partner?partner+" 동행":null)};
    S.events.push(ev);
    if(navigator.onLine){
      dbInsert("inspections",insp).then(function(){
        return withAuthRetry(function(){ return sb.from("insp_items").insert(items.map(function(x){ return toRemote("insp_items",x); })); });
      }).then(function(res){ if(res&&res.error){ showToast("항목을 못 올렸어요 — 통신이 되면 다시 올려요",true); items.forEach(function(x){ inspQPush({op:"upsert",table:"insp_items",item:x,id:x.id}); }); } });
      dbInsert("events",ev);
    } else {
      inspQPush({op:"upsert",table:"inspections",item:insp,id:insp.id});
      items.forEach(function(x){ inspQPush({op:"upsert",table:"insp_items",item:x,id:x.id}); });
      inspQPush({op:"upsert",table:"events",item:ev,id:ev.id});
    }
    inspOpenId=insp.id; inspPage="prep"; inspNewOpen=false; inspFilter={day:"",mine:false,bld:""}; inspBusy=false; render();
    showToast("✓ 노트를 만들었어요 — 항목 "+items.length+"개, 캘린더에 일정도 넣었어요");
  },function(e){ inspBusy=false; showToast(e.message,true); });
}
function inspCopyFinds(){
  var insp=S.inspections.find(function(x){ return x.id===inspOpenId; }); if(!insp) return;
  var fs=inspItems(insp.id).filter(function(x){ return x.kind==="find"; });
  var t=fs.map(function(x,i){ return (i+1)+". ["+(x.grade||"참고")+(x.building?" · "+x.building:"")+"] "+x.text+(x.ref?" (근거: "+x.ref+")":"")+(x.memo?"\n   "+x.memo.replace(/\n/g,"\n   "):""); }).join("\n");
  var done=function(){ showToast("✓ 발견 "+fs.length+"건을 복사했어요"); };
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done,function(){ lawCopyFallback(t,done); }); else lawCopyFallback(t,done);
}
