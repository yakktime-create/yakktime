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
var APP_VER="v101";
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
    var item={name:nfc(f.name).replace(/\.(docx|pdf)$/i,""),filePath:path,fileName:f.name,
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
    it.push({s:x.str,y:H-x.transform[5],x:x.transform[4],
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
    l.text=l.items.map(function(z){ return z.s; }).join(" ").replace(/\s+/g," ").trim();
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

/* 본문 무리에 없는 글꼴로 쓰인 줄은 제목이다. 앞뒤로 줄을 바꿔 둔다 —
 * 화면과 복사가 그 줄바꿈을 그대로 절 경계로 읽는다. */
function linesToText(lines,bodySet,bodyH){
  if(!bodySet) return lines.map(function(l){ return l.text; }).join(" ").replace(/\s+/g," ").trim();
  var out=[];
  lines.forEach(function(l){
    if(!l.text) return;
    if(bodySet[l.font]){ out.push(l.text); return; }
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
    var total=doc.numPages, raw=[], tally={}, lib=window.pdfjsLib;
    function step(i){
      if(i>total) return Promise.resolve();
      var page;
      return doc.getPage(i).then(function(pg){
        page=pg; return pg.getTextContent();
      }).then(function(tc){
        var H=page.getViewport({scale:1}).height;
        var lines=pdfLines(tc,H);
        lines.forEach(function(l){ if(l.font) tally[l.font]=(tally[l.font]||0)+l.text.length; });
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
      /* 본문 글자 높이 — 이보다 큰 제목이 큰 제목이다 */
      var bodyH=0;
      if(bodySet){
        var bk=Object.keys(bodySet).sort(function(a,b){ return tally[b]-tally[a]; })[0];
        bodyH=+(String(bk).split("|")[1]||0);
      }
      var pages=[];
      raw.forEach(function(r){
        var txt=linesToText(r.lines,bodySet,bodyH);
        if(txt) pages.push({page:r.page,content:txt,tbl:r.tbl});
      });
      return pages;
    });
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
var KIND_BY_TEXT={"법률":0,"대통령령":1,"총리령":2,"부령":2,"고시":3,"훈령":3,"예규":3,"지침":4};
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
function cleanPages(rows){
  var hre=runHeadRe(nfc(rows.map(function(r){ return r.content||""; }).join("\n")));
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
function headLineBig(t){
  var ls=String(t||"").split("\n");
  for(var i=0;i<ls.length;i++){
    var L=ls[i].replace(/\s+/g," ").trim();
    if(!L||L.length>30||/[.?!]$/.test(L)) continue;
    if(/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(L)) continue;
    if(!isBigHead(L)||L.length<2||isCutTitle(L)) continue;
    return L.length>24?L.slice(0,24):L;
  }
  return "";
}

/* 그 쪽 첫 줄이 새 큰 제목이면 그것이 이 쪽의 이름이다 —
 * 앞 쪽에서 이어진 제목보다 이쪽이 앞선다. */
/* 제목 줄인데 글머리표(·)가 없으면 큰 제목이다 — 추출할 때 떼어 두었다. */
function isBigHead(L){ return !!L&&!/^[·ㆍ•▪○]/.test(L); }
function firstLineBig(t){
  var L=(String(t||"").split("\n")[0]||"").replace(/\s+/g," ").trim();
  if(!L||L.length>30||/[.?!]$/.test(L)) return "";
  if(!isBigHead(L)||L.length<2||isCutTitle(L)) return "";
  return L.length>24?L.slice(0,24):L;
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
  var ti=big||small;
  return ti&&ti.length>24?ti.slice(0,24):ti;
}

function pageTitle(t){
  var byLine=headLineTitle(t);
  if(byLine) return byLine;
  /* 글꼴을 못 믿는 문서(한글에서 만들어 글꼴이 잘게 쪼개진 것)에서만 여기까지 온다.
   * 앞에 붙은 글머리표는 건너뛰고, 제목은 다음 글머리표 앞에서 끊는다 —
   * 안 그러면 「1 목 적 ○ 의약품등의 품목별 사전 GM」처럼 넘어가서 잘린다. */
  var s=nfc(t).replace(/\s+/g," ").replace(RUNHEAD_RE,"").replace(/^[·ㆍ•▪○\s]+/,"").trim();
  if(s.length<20) return "";
  var m=/^((?:[IVX]{1,4}|[0-9]{1,2})\s*[.)]?\s*)?([가-힣A-Za-z][^.。○·ㆍ•▪]{1,20})/.exec(s);
  if(!m) return "";
  var ti=((m[1]||"")+m[2]).replace(/\s+/g," ")
    .replace(/[\[\(<「『·ᆞㆍ,\-]+$/,"").trim();   /* 끝에 매달린 여는 괄호·구분점을 턴다 */
  /* 조사로 끝나면 문장 도막이다. **어절 하나가 통째로 조사일 때만** 본다 —
   * 그냥 끝 글자로 보면 「우선 GMP 평가」의 「가」까지 조사로 오인한다. */
  if(/(?:^|\s)(은|는|이|가|을|를|에|의|와|과|로|으로|및)$/.test(ti)) return "";
  if(isCutTitle(ti)) return "";
  return ti.length>24?ti.slice(0,24):ti;
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
  var hre=runHeadRe(nfc(pages.map(function(p){ return p.content||""; }).join("\n")));
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
        var cs=tblChunks(pt.text);
        if(cs.length<2){ parts2.push(pt); return; }
        for(var z=0;z<cs.length;z++){
          var za=cs[z].at, zb=(z+1<cs.length)?cs[z+1].at:pt.text.length;
          parts2.push({title:pt.title+" "+(z+1)+"/"+cs.length,
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
      var ti=firstLineBig(t)||carryBig||big||pageTitle(t);
      if(big) carryBig=big;
      out.push({ seq:out.length+1, label:p.page+"쪽"+(ti?" · "+ti:""), num:p.page+"쪽",
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
  }).then(unlock,fail);
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
    cleanPages(rows);   /* 먼저 손질하고 저장한다 — 그래야 쪽 보기도 깨끗해진다 */
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
    var tail=ms.map(function(i){ return t.slice(i,i+80); }), n=0, same=true;
    while(same&&n<80){
      var c=tail[0].charAt(n); if(!c) break;
      for(var k=1;k<tail.length;k++){ if(tail[k].charAt(n)!==c){ same=false; break; } }
      if(same) n++;
    }
    var nm=tail[0].slice(0,n).replace(/\S*$/,"").trim();   /* 낱말 한복판에서 끊지 않는다 */
    if(nm.length>=4)
      return new RegExp(LAWHEAD_RE.source+reEsc(nm).replace(/\s+/g,"\\s+")+"\\s*","g");
  }
  return LAWHEAD_RE;
}

/* 쪽 가운데 아래에 찍히는 쪽 번호(- 15 -). 쪽을 이어 붙이면 문장에 낀다.
 * 문서 6개에 304개. 줄 첫머리에 있는 것만 지워 본문의 뺄셈과 섞이지 않게 한다. */
var PAGENO_RE=/(^|\n)[ \t]*[-–—][ \t]*\d{1,4}[ \t]*[-–—][ \t]*/g;

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

function cleanPdfText(t,hre){
  t=nfc(t).replace(hre||runHeadRe(nfc(t))," ").replace(PAGENO_RE,"$1").replace(PUA_RE," · ");
  t=t.replace(BULLET_M0,"$1· ");
  try{ t=t.replace(BULLET_M," · "); }catch(e){}   /* 구형 사파리는 뒤돌아보기를 못 쓴다 */
  return tidyPunct(bullets(t));
}

function nfc(t){
  t=String(t==null?"":t);
  try{ return t.normalize?t.normalize("NFC"):t; }catch(e){ return t; }
}

var LAW_KINDS=[
  {n:0,t:"법률",   re:/\(법률\)|법률\s*제\s*\d|「[^」]*법」\s*$/},
  {n:1,t:"시행령", re:/\(대통령령\)|시행령/},
  {n:2,t:"시행규칙",re:/\(총리령\)|\(부령\)|규칙/},
  {n:3,t:"고시",   re:/고시|규정\s*\(/},
  {n:4,t:"지침·안내서",re:/지침|안내서|절차|가이드|해설/}
];
function lawKind(name){
  var s=nfc(name);
  for(var i=0;i<LAW_KINDS.length;i++) if(LAW_KINDS[i].re.test(s)) return LAW_KINDS[i];
  return {n:5,t:"그 밖"};
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
    cleanPages(rows);
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
var lawAskSel={};
function lawOnlyIds(){ return Object.keys(lawOnly).filter(function(k){ return lawOnly[k]; }); }
function lawOnlyLabel(){
  var ids=lawOnlyIds(); if(!ids.length||ids.length===S.laws.length) return "";
  /* 법령 이름이 길어서 그대로 쓰면 배지가 줄을 밀어낸다 */
  var first=String(lawName(ids[0])||"");
  if(first.length>16) first=first.slice(0,16)+"…";
  return ids.length===1?first:(first+" 등 "+ids.length+"개");
}

function lawAskRun(){
  var q=nfc(val("law-q")||"").trim();
  if(q.length<5){ showToast("질문을 문장으로 적어주세요. 민원 글을 그대로 붙여넣어도 돼요."); return; }
  if(!S.laws.length){ showToast("먼저 법령 PDF를 올려주세요."); return; }
  lawQuery=q; lawHits=null; lawSel={}; lawOpen={};
  lawAsking=true; lawAsk=null; renderLawResults();
  function done(){ lawAsking=false; renderLawResults(); }
  var only=lawOnlyIds();
  sb.functions.invoke("law-pick",{body:{q:q,lawIds:(only.length&&only.length<S.laws.length)?only:null}}).then(function(r){
    var d=r&&r.data;
    if(!d){ showToast("물어보지 못했어요: "+((r&&r.error&&r.error.message)||"응답이 비었어요"),true); done(); return; }
    if(d.error){ showToast(d.error,true); done(); return; }
    d.q=q; lawAsk=d; lawAskSel={}; lawAskMore=false;
    if((d.picks||[]).length){ lawHelpOpen=false; lawListOpen=false; }
    if(d.krw!=null) lawAskLast=d.krw;
    (d.picks||[]).forEach(function(p){ if(askRank(p.grade)<=ASK_KEEP) lawAskSel[p.id]=true; });
    done();
  }).catch(function(e){ showToast("물어보지 못했어요: "+e.message,true); done(); });
}

/* 체크한 조문의 원문을 통째로 뽑아 온다.
 * AI 화면에는 조 제목과 「왜 골랐나」만 있으므로, 모을 때는 본문을 다시 읽어야 한다.
 * 이건 3단계(답변 초안)에서 Claude에게 보낼 것과 똑같은 묶음이다. */
function lawAskExport(then){
  /* 고른 게 없으면 보이는 것 전부가 대상이다 (낱말 검색과 같은 규칙) */
  var ids=Object.keys(lawAskSel).filter(function(k){ return lawAskSel[k]; });
  if(!ids.length) ids=(lawAsk&&lawAsk.picks||[]).map(function(p){ return p.id; });
  if(!ids.length){ showToast("담아 갈 조문이 없어요."); return; }
  showToast("조문 원문을 불러오는 중...");
  withAuthRetry(function(){
    return sb.from("law_articles").select("id,law_id,label,page,page_end,content").in("id",ids);
  }).then(function(res){
    if(res.error){ showToast("불러오지 못했어요: "+res.error.message,true); return; }
    var by={}; (res.data||[]).forEach(function(a){ by[a.id]=a; });
    var lines=["민원 질문 — "+lawAsk.q,
               new Date().toLocaleString("ko-KR")+" · 조문 "+ids.length+"건",""];
    (lawAsk.picks||[]).forEach(function(p){
      var a=by[p.id]; if(!a) return;
      lines.push("■ "+p.law+"  "+a.label);
      lines.push("  (고른 이유) "+p.why);
      lines.push("  ["+(a.page===a.page_end?a.page+"쪽":a.page+"~"+a.page_end+"쪽")+"]");
      lines.push(String(a.content||"").trim());
      lines.push("");
    });
    then(lines.join("\n"),ids.length);
  });
}
function lawAskCopy(){
  lawAskExport(function(t,n){
    var done=function(){ showToast("✓ 조문 "+n+"곳을 복사했어요"); };
    if(navigator.clipboard&&navigator.clipboard.writeText)
      navigator.clipboard.writeText(t).then(done,function(){ lawCopyFallback(t,done); });
    else lawCopyFallback(t,done);
  });
}
function lawAskDownload(){
  lawAskExport(function(t){
    var blob=new Blob([t],{type:"text/plain;charset=utf-8"});
    var a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download="민원조문_"+keyOf(new Date())+".txt"; a.click();
  });
}
function lawAskSelAll(on){
  lawAskSel={};
  if(on)(lawAsk&&lawAsk.picks||[]).forEach(function(p){ lawAskSel[p.id]=true; });
  renderLawResults();
}

function lawAskHtml(){
  var d=lawAsk;
  var head='<div class="ask-head"><span class="ask-qt">「'+esc(d.q)+'」</span>'
    + '<span class="ask-cost">이번 '+(d.krw||0)+'원</span></div>';
  if(!d.picks||!d.picks.length)
    return '<div class="ask-box">'+head
      + '<p class="ask-none">올려둔 법령에서는 관련 조문을 못 찾았어요.</p>'
      + (d.note?'<p class="ask-note">'+esc(d.note)+'</p>':'')+'</div>';
  /* 점수가 낮은 것은 접어 둔다. 결과가 길어지면 위쪽 확실한 것부터 보이지 않는다 —
   * 화면을 넘기지 않고도 볼 것부터 보이게 하는 게 이 접기의 목적이다. */
  var sure=d.picks.filter(function(p){ return askRank(p.grade)<=ASK_KEEP; });
  var maybe=d.picks.filter(function(p){ return askRank(p.grade)>ASK_KEEP; });
  var shown=lawAskMore?d.picks:sure;
  function askItem(p){
    var on=!!lawAskSel[p.id];
    var band=askRank(p.grade)+1;   /* 1 매우 높음 … 5 매우 낮음 */
    return '<li class="ask-item'+(on?" on":"")+' r-'+band+'">'
      + '<label class="ask-check"><input type="checkbox" data-act="ask-pick" data-id="'+esc(p.id)+'"'+(on?" checked":"")+' /></label>'
      + '<div class="ask-item-body">'
      +   '<div class="ask-art"><span class="ask-score">'+esc(p.grade||"중간")+'</span><b>'+esc(p.label)+'</b>'
      +     '<span class="ask-law">'+esc(p.law)+'</span>'
      +     (p.kind?'<span class="ask-kind">'+esc(p.kind)+'</span>':'')
      +     '<button class="link-btn law-go-art" data-act="law-art" data-art-id="'+esc(p.id)+'" data-id="'+esc(p.lawId)+'">전체 보기</button></div>'
      +   '<div class="ask-why">'+esc(p.why)+'</div>'
      /* 점수가 어디서 나왔는지 같이 적는다. 숫자만 있으면 「87이 무슨 뜻이냐」가 된다.
       * 이 셋을 AI가 고르고, 점수는 서버가 더해서 낸다. */
      +   (p.direct?'<div class="ask-parts">'
            + '<span>'+esc(p.direct)+'</span><span>'+esc(p.need)+'</span><span>'+esc(p.sure)+'</span>'
            + '</div>':'')
      /* 본문 앞부분을 같이 보여준다 — 창을 열었다 닫지 않아도 맞는지 가늠된다 */
      +   (p.head?'<div class="ask-head-txt">'+esc(p.head)+'</div>':'')
      + '</div></li>';
  }
  var items=shown.map(askItem).join("")
    + (maybe.length&&!lawAskMore
        ? '<li class="ask-more"><button class="link-btn" data-act="ask-more">'
          + '관련도 낮은 '+maybe.length+'개 더 보기</button></li>' : '');
  var nSel=Object.keys(lawAskSel).filter(function(k){ return lawAskSel[k]; }).length;
  var nSure=sure.length;
  var askWhat=nSel?("고른 "+nSel+"곳"):"전부";
  /* 낱말 검색 결과와 같은 부품·같은 자리 — 한쪽만 다르게 생기면 매번 다시 배워야 한다 */
  var acts='<div class="law-head"><div class="law-count">'+d.picks.length+'곳'
    + (maybe.length?' <span class="law-and">「중간」 이상 '+nSure+'곳</span>':'')+'</div>'
    + '<div class="law-actions">'
    +   (d.picks.length>1
          ? (nSel?'<button class="link-btn quiet-link" data-act="ask-none">☐ 해제</button>'
                 :'<button class="link-btn" data-act="ask-all">☑ 모두</button>'):'')
    +   '<button class="btn quiet sm" data-act="ask-copy">'+askWhat+' 복사</button>'
    +   '<button class="btn sm" data-act="ask-save">텍스트로 저장</button>'
    + '</div></div>';
  return '<div class="ask-box">'+head
    + (d.note?'<p class="ask-note">'+esc(d.note)+'</p>':'')
    + (d.truncated?'<p class="ask-warn">올려둔 조문이 너무 많아 <b>앞쪽 '+d.arts+'개만</b> 봤어요. 위에서 법령을 골라 범위를 좁혀주세요.</p>':'')
    + (d.skipped?'<p class="ask-note">아직 시행 전인 개정 조문 '+d.skipped+'개는 빼고 봤어요 — 답변 근거는 <b>지금 적용되는 조문</b>이어야 하니까요. 그 조문들은 낱말 검색에서는 그대로 보입니다.</p>':'')
    /* 등급이 무슨 뜻인지 결과 바로 옆에 적어 둔다. 사용법 안에만 있으면
     * 펼쳐 보지 않는 한 「매우 높음이 뭐 기준인데」로 남는다. */
    + '<div class="ask-legend"><b>등급</b>은 셋을 합쳐서 매겨요 —'
    +   '<span>답이 이 조에 있나</span><span>답변서에 인용해야 하나</span><span>본문에서 근거를 찾았나</span>'
    +   '<i>조문마다 아래에 그 셋이 적혀 있어요.</i></div>'
    + acts+'<ol class="ask-list">'+items+'</ol>'
    /* 도구지 답변자가 아니다. 이 줄을 지우면 안 된다. */
    + '<p class="ask-foot">'
    +   '조 제목으로 후보를 추린 뒤 <b>조문을 실제로 읽고</b> 골랐어요. 그래도 마지막 확인은 직접 하세요.'
    +   (d.looked?' <span class="ask-dim">이번에 본문까지 읽어본 조문 '+d.looked+'개</span>':'')+'<br />'
    +   '골라서 「복사」하면 <b>조문 원문</b>이 통째로 따라옵니다.</p></div>';
}

/* 관련도 등급. 서버가 세 가지 판단을 더해 매기고, 여기서는 순서와 색만 쓴다.
 * 숫자(0~100)를 그대로 보여주지 않는 이유 — 잰 값이 아닌데 잰 것처럼 보인다. */
var ASK_GRADES=["매우 높음","높음","중간","낮음","매우 낮음"];
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

function lawSearch(){
  var q=nfc(val("law-q")||"").trim();
  lawQuery=q; lawSel={}; lawHits=null; lawOpen={}; lawAsk=null; lawAsking=false;
  lawTermList=lawTerms(q);
  if(!lawTermList.length){ renderLawResults(); showToast("두 글자 이상 입력해 주세요."); return; }
  if(!S.laws.length){ renderLawResults(); showToast("먼저 법령 PDF를 올려주세요."); return; }
  lawSearching=true; renderLawResults();
  function run(){
    return withAuthRetry(function(){
      var qb=sb.from("law_articles")
        .select("id,law_id,seq,label,num,page,page_end,content"+(lawTblCol?",tbl":""));
      /* 낱말마다 조건을 겹쳐 걸면 모두 들어 있는 조문만 남는다 (교집합) */
      lawTermList.forEach(function(t){ qb=qb.ilike("content","%"+escLike(t)+"%"); });
      return qb.order("law_id").order("seq").limit(200);
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
    lawHits=buildLawHits(res.data||[],lawTermList);
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
      g.snips.push({ where:where, full:full,
        text:(w.st>(w.bs==null?0:w.bs)?"…":"")+body+(w.en<c.length?"…":"") });
    });
    out.push(g);
  });
  /* 법 위계 순으로 세운다 — 지침서가 법률 위에 오면 근거가 약한 것을 먼저
   * 보게 된다. 목록에서 쓰는 것과 같은 순서라 눈이 헷갈리지 않는다. */
  out.sort(function(a,b){
    var la=S.laws.find(function(x){ return x.id===a.lawId; });
    var lb=S.laws.find(function(x){ return x.id===b.lawId; });
    var ka=la?lawKindOf(la).n:9, kb=lb?lawKindOf(lb).n:9;
    if(ka!==kb) return ka-kb;
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
var ART_RE=/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*\(\s*([^()]{1,40}?)\s*\)/g;
/* 별표: "■ 법령명 [별표 6의2] <개정 …> 의약품등 수입관리 기준 (제60조 관련)"
 * 별지: "[별지 제80호서식] <개정 …> 조사표"  — 서식 구역도 같은 방식으로 잡는다 */
/* 제목 부분은 선택으로 둔다 — 제목 뒤에 괄호가 없는 서식이 있는데,
 * 필수로 두면 그런 쪽에서 규칙이 통째로 실패해 머리말을 아예 못 찾는다. */
var BP_RE=/\[\s*별\s*(표|지)\s*(?:제\s*)?(\d+)(?:\s*의\s*(\d+))?\s*(?:호\s*서\s*식)?\s*\]\s*(?:<[^<>]{0,40}>\s*)?(?:([^()\[\]<>]{0,40}?)\s*(?=\(|\[|<|$))?/g;
var HANG="①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

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
  if(/(법|규칙|영|고시|기준|규정)$/.test(pre)) return true; /* "약사법 제31조" */
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
    var sp=text.indexOf(" ",pos);
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
      var sp=text.indexOf(" ",c);
      out.push(sp>=0&&sp-c<200?sp+1:c);
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
        else if(MOK.indexOf(mm[1])>=0&&!afterNum(text,i)) pts.push({at:i,lv:3,len:0});
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
  if(pts[0].at>0){ prev=0; prevLv=startLv; prevArt=0; prevSoft=false; prevBig=false; push(pts[0].at); }
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
  return formatLawSeg(lawView.text||"",lawTermList,0).html;
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
    artBar='<div class="lv-arts">'+esc(lawView.art||"")+((lawView.page&&!dup)?'  ·  '+span:"")+'</div>';

    foot='<div class="lv-foot">'
      + '<button class="link-btn" data-act="lv-page">쪽 그대로 보기</button>'
      + '<button class="link-btn lv-pdf" data-act="lv-pdf">PDF 원문 열기 ↗</button>'
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
/* 고른 게 없으면 전부가 대상이다.
 * 「먼저 결과를 골라주세요」라고 되돌려 보내면, 대개는 전부를 원했던 것이라
 * 「모두 선택」을 누르고 다시 「복사」를 누르게 된다. 두 번 누를 일이 아니다.
 * 법령 범위에서 쓰는 규칙(안 고르면 전부)과도 같은 결이다. */
function lawPicked(){
  var all=lawHits||[];
  var sel=all.filter(function(g){ return lawSel[g.key]; });
  return sel.length?sel:all;
}
function lawSelCount(){
  return (lawHits||[]).filter(function(g){ return lawSel[g.key]; }).length;
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
      if(h.full==="") return;                       /* 같은 항에서 또 걸린 것 */
      if(h.full){ lines.push(h.full); return; }     /* 항 전문 */
      lines.push("    "+(h.where?"("+h.where+") ":"")+h.text);
    });
    lines.push("");
  });
  return lines.join("\n");
}

function lawCopy(){
  var t=lawExportText();
  if(!t){ showToast("복사할 결과가 없어요."); return; }
  var done=function(){ showToast("✓ "+lawPicked().length+"곳을 복사했어요"); };
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
  if(!t){ showToast("저장할 결과가 없어요."); return; }
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

    + '<div class="law-help-sec"><div class="law-help-t">◆ 관련도는 이렇게 나와요</div>'
    +   '<p>AI는 등급을 직접 매기지 않아요. <b>세 가지만 고르고</b>, 등급은 그걸 합쳐서 나옵니다.</p>'
    +   '<ul>'
    +     '<li><b>답이 이 조에 있나</b><br />답이 여기 &gt; 조건이 여기 &gt; 곁가지<br />'
    +       '<span class="law-help-dim">조건이 여기 = 답 자체는 아니지만 몇 개까지·누구에게 같은 <b>조건</b>이 여기 있다<br />'
    +       '곁가지 = 정의·절차·벌칙처럼 답의 <b>둘레</b>에 있는 규정</span></li>'
    +     '<li><b>답변서에 인용해야 하나</b><br />인용 필수 &gt; 있으면 좋음 &gt; 없어도 됨</li>'
    +     '<li><b>본문에서 근거를 찾았나</b><br />근거 찾음 &gt; 비슷한 대목만 &gt; 못 찾음<br />'
    +       '<span class="law-help-dim">「근거 찾음」은 조문 안에서 <b>그 대목을 짚을 수 있을 때만</b> 붙어요. '
    +       '그때는 왼쪽 설명에도 그 대목이 그대로 적힙니다.</span></li>'
    +   '</ul>'
    +   '<p>셋 다 최고면 <b>매우 높음</b>, 셋 다 최저면 <b>매우 낮음</b>. '
    +     '고른 세 낱말이 조문마다 같이 적혀 있으니 왜 그 등급인지 바로 보여요.<br />'
    +     '<b>「낮음」부터는 접어 둡니다.</b> 등급은 정확도가 아니라 '
    +     '<b>어느 것부터 펴 볼지의 순서</b>로 보세요.</p>'
    +   '<p class="law-help-dim">찾는 순서 — ① 조 <b>제목</b>만 훑어 후보 20개를 추리고 '
    +     '② 그 20개의 <b>조문을 통째로 읽어</b> 최종 10개로 추립니다. '
    +     '한 번에 하려면 조 목록 전체에 본문을 붙여야 해서 값이 몇 배로 뜁니다.<br />'
    +     '아주 긴 조(정의 조항·별표가 붙은 것)는 앞 4천 자까지만 읽고 「뒤가 잘림」으로 알립니다.<br />'
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
    +     '<li>법에 쓰인 말로 넣어야 나와요. <u>「타이레놀」로는 안 나옵니다</u> — '
    +       '법에는 「안전상비의약품」이라고 적혀 있으니까요. '
    +       '<span class="law-help-soon">(이 부분은 다음 단계에서 AI가 대신 찾아 줄 예정)</span></li>'
    +   '</ul></div>'

    + '<div class="law-help-sec"><div class="law-help-t">② 결과 읽는 법</div>'
    +   '<ul>'
    +     '<li><b>카드 하나 = 조 하나</b>예요. 한 조 안에서 검색어가 열 번 나와도 카드는 하나입니다.</li>'
    +     '<li>조각 앞의 <span class="law-help-chip">2호 나목</span> 같은 표시는 '
    +       '<b>그 조 안에서 몇 항·몇 호·몇 목인지</b>예요.</li>'
    +     '<li><b>카드를 누르면</b> 그 조 전체가 열려요. 조 하나가 통째로 나옵니다.</li>'
    +     '<li>열린 창 아래 <b>「쪽 그대로 보기」</b> — 조로 묶은 글이 아니라 <b>PDF의 그 쪽</b>을 그대로 봐요. 앞뒤 쪽으로 넘길 수 있어요.</li>'
    +     '<li>열린 창 아래 <b>「PDF 원문 열기 ↗」</b> — 원본 PDF를 그 쪽으로 열어요. <b>표를 볼 때 꼭 쓰세요.</b></li>'
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
    /* 같은 법령이 두 벌 이상이면 검색 결과가 두 번씩 나오고 AI도 헷갈린다.
     * 열 몇 개를 일일이 볼 수 없으므로 여기서 세어 알린다. */
    var olds=items.filter(lawIsOld);
    if(olds.length) list+='<div class="notice"><span class="notice-ic">!</span>'
      + '<div>같은 법령이 <b>'+olds.length+'개 겹쳐</b> 있어요 (옛 판이거나 같은 판 두 벌). '
      +   '두면 검색 결과가 두 번씩 나오고 AI도 헷갈려요.</div>'
      + '<button class="btn sm" data-act="law-drop-old">겹치는 것 정리</button></div>';
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
            + '<button class="link-btn" data-act="law-build-all" data-id="all"'+(lawBusy?" disabled":"")+'>'
            + (lawBusy?"만드는 중…":"조문 전부 다시 만들기")+'</button>'
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
        + '<span class="law-pages">'+(l.pages||0)+'쪽'
        +   (l.arts?' · 조문 '+l.arts+'개':'')+'</span>'
        + (l.arts?'':'<button class="link-btn law-need" data-act="law-reindex" data-id="'+l.id+'">조문 만들기</button>')
        + '<button class="law-ic" data-act="law-pdf" data-id="'+l.id+'" data-page="1" title="PDF 원문 열기">↗</button>'
        + '<button class="law-ic del" data-act="law-del" data-id="'+l.id+'" title="삭제">✕</button></div>';
      }).join("")+'</div>';
    }
  }

  view().innerHTML='<div class="page">'
    + pageHead2("법령","올려둔 법령 전체에서 단어를 찾고, 결과를 골라 모아요.",items.length?pills:null)
    + '<div class="search-box"><span class="search-ic">⌕</span>'
    +   '<textarea class="input search law-input" id="law-q" rows="1" placeholder="낱말로 찾거나, 민원 질문을 그대로 붙여넣어요">'+esc(lawQuery)+'</textarea>'
    +   '<button class="btn sm law-go" data-act="law-search">검색</button>'
    + '</div>'
    /* 돈이 드는 동작이라 검색칸 안에 넣지 않는다. 눌러야만 나간다.
     * 게다가 낱말 두어 개를 칠 때는 쓸 일이 없으므로, 문장을 적었을 때만
     * 나타난다 — 평소 화면은 예전과 똑같이 조용하다. */
    + '<button class="ask-bar'+(lawAskFits(lawQuery)?"":" gone")+(lawAsking?" busy":"")+'" data-act="law-ask"'+(lawAsking?" disabled":"")+'>'
    +   '<span class="ask-ic">✦</span>'
    +   '<span class="ask-bar-t">'+(lawAsking?"관련 조문을 고르는 중..."
          :(lawOnlyLabel()?"<b>"+esc(lawOnlyLabel())+"</b>에서 관련 조문 찾아줘"
                          :"위에 적은 말로 <b>관련 조문 찾아줘</b>"))+'</span>'
    +   '<span class="ask-bar-n">'+(lawAskLast!=null?"지난번 "+lawAskLast+"원":"한 번에 50~150원")+'</span>'
    + '</button>'
    + lawHelpHtml()
    /* 결과를 보는 중에는 올리기 배너를 한 줄로 줄인다 — 지금 할 일이 아니다 */
    + '<button class="upload-bar'+(lawBusy?" busy":"")+((lawHits||lawAsk)&&!lawBusy?" slim":"")+'" data-act="law-upload"'+(lawBusy?" disabled":"")+'>'
    +   '<span class="upload-ic">⬆</span><div class="import-bar-text">'
    +   '<div class="import-bar-title">'+(lawBusy?"처리 중이에요...":"법령 PDF 올리기")+'</div>'
    +   '<div class="import-bar-sub">'+(lawBusy?"창을 닫지 마세요":"글자가 들어 있는 PDF만 (스캔본은 아직 안 돼요)")+'</div></div>'
    +   '<span class="import-bar-go">→</span></button>'
    + list
    + '<div id="law-results"></div><div id="law-modal"></div></div>';

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

  /* AI가 고른 조문이 있으면 그걸 보여준다. 낱말 검색과 한 자리를 나눠 쓴다 —
   * 둘이 같이 떠 있으면 무엇을 보고 있는지 헷갈린다. */
  if(lawAsking){ el.innerHTML='<p class="empty">질문을 읽고 관련 조문을 고르는 중이에요...</p>'; return; }
  if(lawAsk){ el.innerHTML=lawAskHtml(); return; }
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
  var picked=lawSelCount();
  /* 버튼 글자가 무엇을 담아 갈지 말한다 — 「복사」 옆에 「모두 선택」이 따로
   * 있으면 어느 쪽이 대상인지 매번 헤아려야 한다. */
  var what=picked?("고른 "+picked+"곳"):"전부";
  var head='<div class="law-head">'
    + '<div class="law-count"><b>'+lawHits.length+'</b>곳 · '+total+'건'
    +   (lawTermList.length>1?' <span class="law-and">'+esc(lawTermList.join(" + "))+' 모두 포함</span>':'')+'</div>'
    + '<div class="law-actions">'
    /* 하나뿐일 때 「모두 선택」은 말이 안 된다 */
    +   (lawHits.length>1
          ? (picked?'<button class="link-btn quiet-link" data-act="law-none">☐ 해제</button>'
                   :'<button class="link-btn" data-act="law-all">☑ 모두</button>'):'')
    +   '<button class="btn quiet sm" data-act="law-copy">'+what+' 복사</button>'
    +   '<button class="btn sm" data-act="law-save">텍스트로 저장</button>'
    + '</div></div>';

  var SHOW=3, cur=null, body="";
  lawHits.forEach(function(g){
    var nm=lawName(g.lawId);
    if(nm!==cur){ cur=nm;
      var lo=S.laws.find(function(x){ return x.id===g.lawId; });
      body+='<div class="law-group g'+(lo?lawKindOf(lo).n:9)+'">'+esc(nm)
          + (lo?'<span class="law-group-kind">'+esc(lawKindOf(lo).t)+'</span>':'')+'</div>'; }
    var open=!!lawOpen[g.key], list=open?g.snips:g.snips.slice(0,SHOW);
    body+='<div class="law-hit'+(lawSel[g.key]?" on":"")+'">'
      + '<label class="law-pick"><input type="checkbox" class="law-check" data-act="law-pick" data-key="'+esc(g.key)+'"'+(lawSel[g.key]?" checked":"")+' /></label>'
      /* 카드 자체가 「조 전체 보기」다. 카드마다 버튼을 셋씩 두면 여덟 카드에
       * 버튼이 스물넷이라 화면이 어지럽고, 좁은 화면에선 줄까지 밀렸다.
       * 「쪽 그대로 보기」·「PDF 원문」은 열린 창 아래에 이미 있으므로
       * 누를 것만 줄고 할 수 있는 일은 그대로다. */
      + '<div class="law-hit-body" data-act="law-art" data-art-id="'+g.artId+'" data-id="'+g.lawId+'">'
      +   '<div class="law-meta">'
      +     '<span class="law-art">'+esc(g.art)+'</span>'
      +     (lawIsFuture(g.art)?'<span class="law-soon">아직 시행 전</span>':'')
      /* 지침서는 조가 없어 라벨이 「22쪽」이다. 그 옆에 또 「22쪽」을 붙이면
       * 같은 말이 두 번이다. 라벨이 이미 그 쪽을 말하고 있으면 생략한다. */
      +     (function(){
              var pg=(g.page===g.pageEnd?g.page+'쪽':g.page+'~'+g.pageEnd+'쪽');
              return String(g.art||"").indexOf(pg)===0?'':'<span class="law-page">'+pg+'</span>';
            })()
      +     (g.total>1?'<span class="law-n">'+g.total+'건</span>':'')
      +     '<span class="law-open" aria-hidden="true">›</span>'
      +   '</div>'
      /* 표는 글자만 도려내면 칸이 섞여 읽을 수가 없다. 발췌를 보여주는 대신
       * 「어느 항목에 있는지」만 알려주고 PDF 원문으로 보내는 편이 낫다. */
      +   (g.table
          ? (function(){
              var ws=[], seen={};
              g.snips.forEach(function(h){ if(h.where&&!seen[h.where]){ seen[h.where]=1; ws.push(h.where); } });
              /* 자리를 다 늘어놓으면 안내가 본문보다 길어진다 — 셋까지만 */
              var more=ws.length>3?(" 외 "+(ws.length-3)+"곳"):"";
              if(ws.length>3) ws=ws.slice(0,3);
              return '<div class="law-tbl">'
                + '<b>칸이 뒤섞여 읽기 어려운 대목이에요.</b>'
                + (ws.length?' <span class="law-tbl-w">'+esc(ws.join(" · "))+'</span>'+more+'에서 찾았어요.':'')
                + ' PDF 원문에서 확인하세요.</div>';
            })()
          : (function(){
            /* 조각마다 어디인지 붙인다. 예전에는 「바뀔 때만」 적었는데, 같은 목
             * 안에서 검색어가 멀리 떨어져 조각이 나뉘면 둘째 조각에 배지가 없어
             * 「이건 어디지?」가 됐다. 조각은 점선으로 갈려 있어 반복해도 안 어지럽다. */
            return list.map(function(h){
              var w=h.where?'<span class="law-where">'+esc(h.where)+'</span>':'';
              return '<div class="law-snip'+(w?'':' law-snip-same')+'">'
                + w + lawSegHtml(h.text,lawTermList,0)+'</div>';
            }).join("");
          })())
      +   (!g.table&&g.snips.length>SHOW
            ? '<button class="link-btn law-more-btn" data-act="law-expand" data-key="'+esc(g.key)+'">'
              +(open?"접기":"이 조에서 "+(g.snips.length-SHOW)+"건 더 보기")+'</button>'
            : "")
      + '</div></div>';
  });

  el.innerHTML=head+'<div class="law-hits">'+body+'</div>'
    + '<p class="law-note">같은 조에서 나온 것은 한 카드로 묶었어요. <b>카드를 누르면 그 조 전문이 열리고</b>, 그 창에서 「쪽 그대로 보기」·「PDF 원문」으로 갈 수 있어요.</p>';
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
    case "s-star": { var i2=S.schedule.find(function(x){return x.id===id;}); if(i2){i2.star=!i2.star;render();dbUpdate("schedule",id,{star:i2.star});} break; }
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
    case "ask-pick": { if(lawAskSel[id]) delete lawAskSel[id]; else lawAskSel[id]=true;
      renderLawResults(); break; }
    case "ask-more": lawAskMore=true; renderLawResults(); break;
    case "ask-all":  lawAskSelAll(true);  break;
    case "ask-none": lawAskSelAll(false); break;
    case "ask-copy": lawAskCopy(); break;
    case "ask-save": lawAskDownload(); break;
    case "law-list": lawListOpen=!lawListOpen; render(); break;
    case "law-view": openLawView(id,parseInt(el.getAttribute("data-page"),10)||1); break;
    case "law-reindex": lawReindex(id); break;
    case "law-pdf": openLawPdf(id,parseInt(el.getAttribute("data-page"),10)||1); break;
    case "lv-close": closeLawView(); break;
    case "law-art": openLawArticle(parseInt(el.getAttribute("data-art-id"),10)||0,id); break;
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
