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
var TABLES=["schedule","events","articles","mfds","archive","docs"];

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

function loadAll(){
  var promises=TABLES.map(function(t){
    return withAuthRetry(function(){ return sb.from(t).select("*"); }).then(function(res){
      if(res.error) throw res.error;
      return {table:t, data:(res.data||[]).map(function(r){ return toLocal(t,r); })};
    });
  });
  return Promise.all(promises).then(function(results){
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
var S={ schedule:[], events:[], articles:[], mfds:[], archive:[], docs:[] };
var active="today", archiveSearch="", archiveOnlyCheck=false;
var now0=new Date(), calYear=now0.getFullYear(), calMonth=now0.getMonth(), calSel=keyOf(now0);
var ARTICLE_STATUS=["기획","작성중","기고완료"], MFDS_STATUS=["대기","진행중","완료"];
var TAB_LIST=[{id:"today",label:"오늘"},{id:"calendar",label:"캘린더"},{id:"articles",label:"기고글"},
  {id:"mfds",label:"식약처 업무"},{id:"archive",label:"민원 검토 서가"},{id:"docs",label:"문서 인덱스"}];
var WD=["일","월","화","수","목","금","토"];

/* ========== 시드 데이터 ========== */
function seedIfNeeded(){
  if(S.archive.length>0) return Promise.resolve();
  var cases=getMasterDocCases();
  /* id 없이 넣으면 Supabase가 uuid 자동 생성 */
  var inserts=cases.map(function(c){ return dbInsert("archive",c); });
  return Promise.all(inserts).then(function(){
    /* dbInsert에서 id가 채워진 cases를 S에 반영 */
    S.archive=cases;
  });
}

function getMasterDocCases(){
  return [
    {
      title:"건1. OOS 부적합 배치 — 적합판정서 갱신 가능 여부",
      guideline:"「바이오의약품 전문수탁 제조업체 GMP 평가 절차」(지침서-0980-05, 2026.6.15. 시행) §6.4·§6.5",
      summary:"[질의 요지]\nCMO 업체의 GMP 적합판정서 유효기간이 2025.12.까지로, 만료 전 갱신 신청 희망. 최근 3년 내 제조 배치 3개 중 2개 OOS 부적합, 적합 배치는 1개뿐인 상황에서 갱신 가능 여부.\n\n[쟁점]\n① OOS 부적합 배치의 \"생산 실적\" 산입 여부\n② §6.4 단서 적용 가능성\n[확인 필요: \"생산 실적\"에 OOS 부적합 배치 포함 여부]\n\n[검토 의견(안)]\n선례 없는 해석 사안 → 사무관 검토 후 해석 기준 확정 건의.",
      keywords:"OOS 부적합 갱신 생산실적 0980-05 §6.4 §6.5 적합판정서 CMO",
      needsCheck:true
    },
    {
      title:"건2. 엔지니어링 배치 — 신규 발급 및 갱신 가능 여부",
      guideline:"「바이오의약품 전문수탁 제조업체 GMP 평가 절차」(지침서-0980-05) 적용범위 나·마목, 사례11·12, §6.4·§6.5",
      summary:"[질의 요지]\n바이오 CMO 업체가 엔지니어링 배치(Engineering run) 실적으로 신규 발급 및 갱신 가능 여부.\n\n[신규 발급 — 가능]\n근거: 적용범위 나목, 사례11.\n\n[갱신]\n원칙(§6.4): 최근 3년 내 3개 단위 미달 시 평가 대상 제외.\n예외(§6.4 단서): 동시적 밸리데이션 가능 + 연간 생산 1개 이하 → 1개 단위로 평가 가능.\n[확인 필요: 회수 시점, 업체 생산 곤란 사유]",
      keywords:"엔지니어링배치 신규발급 갱신 시험생산용 0980-05 사례11 사례12 §6.4 CMO",
      needsCheck:true
    },
    {
      title:"건3. 유전자재조합의약품 — 전공정·포장 위탁 및 자사 펜 조립 시 적합판정 필요 범위",
      guideline:"「의약품 GMP 적합판정 및 적합판정서 발급 관련 업무처리방안」 / 안전규칙 제4조, [별표1]·[별표3]",
      summary:"[질의 요지]\n유전자재조합 세부제형 GMP 적합판정 수탁사(CMO)에 제조 위탁, 위탁사 펜 조립 시 별도 적합판정 필요 여부.\n\n[쟁점]\n① 완제 적합판정 위탁사 필요 여부 → 불필요\n② 펜 조립 공정 분류 → 2차 포장/조립\n③ 케미컬 포장 GMP로 생물 포장 갈음 가능 여부 → 어려움\n[확인 필요: 조립 과정 중 카트리지 밀봉 유지 여부]",
      keywords:"유전자재조합 위탁 펜조립 별표1 별표3 생물학적제제 콜드체인 세부제형 적합판정",
      needsCheck:true
    }
  ];
}

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
function renderTabs(){ document.getElementById("tabs").innerHTML=TAB_LIST.map(function(t){ return '<button class="rail-tab '+(active===t.id?"on":"")+'" data-act="tab" data-id="'+t.id+'"><span class="dot"></span>'+esc(t.label)+'</button>'; }).join(""); }
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
  var needCheck=S.archive.filter(function(a){return a.needsCheck;}).length;
  var todayEv=S.events.filter(function(e){return e.key===todayKey;}).sort(evSort);
  var upcoming=S.events.filter(function(e){return e.key>todayKey;}).sort(evSort).slice(0,4);
  var evHtml="";
  if(todayEv.length){ evHtml+='<div class="card"><div class="card-head"><h2>오늘 일정</h2></div>'+todayEv.map(function(e){ return '<div class="ev-row"><span class="ev-time">'+(e.time||"종일")+'</span><span class="ev-title">'+esc(e.title)+'</span></div>'; }).join("")+'</div>'; }
  if(upcoming.length){ evHtml+='<div class="card"><div class="card-head"><h2>다가오는 일정</h2><span class="muted" data-act="tab" data-id="calendar" style="cursor:pointer">캘린더 열기 →</span></div>'+upcoming.map(function(e){ var d=new Date(e.key); return '<div class="up-row"><span class="up-date">'+(d.getMonth()+1)+'월 '+d.getDate()+'일('+WD[d.getDay()]+')</span><span class="up-title">'+esc(e.title)+'</span><span class="up-time">'+(e.time||"")+'</span></div>'; }).join("")+'</div>'; }
  /* 할 일 목록 HTML (오늘/내일 두 곳에서 재사용) */
  function schedRows(items,emptyMsg){
    var o=items.filter(function(i){return !i.done;}).sort(function(a,b){return (b.star?1:0)-(a.star?1:0);});
    var d=items.filter(function(i){return i.done;});
    if(!o.length&&!d.length) return '<div class="empty-box sm"><p>'+emptyMsg+'</p></div>';
    return '<ul class="list">'
      + o.map(function(i){
          var late=dueOf(i)<todayKey ? '<span class="row-late">지난</span>' : '';
          return '<li class="row'+(i.star?" star-on":"")+'"><button class="check" data-act="s-toggle" data-id="'+i.id+'">✓</button>'
            + '<span class="row-text" data-act="edit" data-table="schedule" data-field="text" data-id="'+i.id+'" title="눌러서 수정">'+esc(i.text)+'</span>'+late
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
  var tmrRows = schedRows(tmrItems,"내일 할 일은 아직 없어요.");
  var tmrD=tomorrow();
  var tmrLabel=(tmrD.getMonth()+1)+"월 "+tmrD.getDate()+"일("+WD[tmrD.getDay()]+")";
  view().innerHTML='<div class="page">'
    + '<header class="today-hero"><div class="today-date">'+esc(dateStr)+'</div><h1 class="today-greet">'+greet+', 이랑님.</h1><p class="today-line">오늘 할 일 '+open.length+'건'+(open.length?" 남았어요.":"이 없어요.")+(todayEv.length?" · 오늘 일정 "+todayEv.length+"건.":"")+'</p></header>'
    + '<section class="stat-row">'
    +   statTile("articles","brass",inProg,"작성 중 기고글")
    +   statTile("mfds","blue",mfdsOpen,"진행 중 식약처 업무")
    +   statTile("archive","accent",S.archive.length,"민원 검토 건"+(needCheck?" · 확인필요 "+needCheck:""))
    +   statTile("docs","slate",S.docs.length,"문서 인덱스")
    + '</section>'+evHtml
    + '<section class="card"><div class="card-head"><h2>오늘 할 일</h2><span class="muted">별표는 위로 · 항목을 누르면 수정</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s" placeholder="할 일을 적고 Enter" /><button class="btn" data-act="s-add" data-id="'+todayKey+'" data-input="new-s">+ 추가</button></div>'+rows
    + '</section>'
    + '<section class="card"><div class="card-head"><h2>내일 할 일</h2><span class="muted">'+tmrLabel+'</span></div>'
    +   '<div class="add-row quick"><input class="input" id="new-s2" placeholder="내일 할 일을 적고 Enter" /><button class="btn" data-act="s-add" data-id="'+tmrKey+'" data-input="new-s2">+ 추가</button></div>'+tmrRows
    + '</section></div>';
  document.getElementById("new-s").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(todayKey,"new-s"); });
  document.getElementById("new-s2").addEventListener("keydown",function(e){ if(e.key==="Enter") addSchedule(tmrKey,"new-s2"); });
}

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
    var chips=chipItems.slice(0,2).map(function(c){
      return '<div class="cal-ev'+(c.task?" mfds":"")+(c.done?" done":"")+'">'+esc(c.label)+'</div>'; }).join("");
    if(chipItems.length>2) chips+='<div class="cal-more">+'+(chipItems.length-2)+'</div>';
    cells+='<div class="cal-cell'+(k===todayKey?" today":"")+(k===calSel?" sel":"")+'" data-act="cal-day" data-id="'+k+'"><span class="cal-num">'+d+'</span>'+chips+'</div>'; }
  var wdHtml=WD.map(function(w,i){ return '<div class="cal-wd'+(i===0?" sun":"")+'">'+w+'</div>'; }).join("");
  var selEvs=S.events.filter(function(e){return e.key===calSel;}).sort(evSort), selD=new Date(calSel);
  var selTasks=S.mfds.filter(function(m){ return m.due===calSel; });
  var taskRows=selTasks.map(function(t){
    var done=(t.status==="완료");
    return '<li class="ev-row task'+(done?" done":"")+'">'
      + '<input class="day-check" type="checkbox" data-act="mfds-done" data-id="'+t.id+'"'+(done?' checked':'')+' />'
      + '<span class="mfds-badge">식약처</span>'
      + '<span class="ev-title" data-act="edit" data-table="mfds" data-field="title" data-id="'+t.id+'" title="눌러서 수정">'+esc(t.title)+'</span>'
      + '<span class="mfds-status">'+esc(t.status)+'</span>'
      + '<span class="row-acts"><button class="del" data-act="mfds-del" data-id="'+t.id+'" title="삭제">✕</button></span></li>'; }).join("");
  var panel='<div class="day-panel"><div class="day-title">'+(selD.getMonth()+1)+'월 '+selD.getDate()+'일 ('+WD[selD.getDay()]+')'+(calSel===todayKey?' <span class="day-today">오늘</span>':'')+'</div>'
    + '<div class="add-row quick"><input class="input" id="day-ev" placeholder="할 일 / 일정 (예: 오후 2시 GMP 실사)" />'
    +   '<label class="chk"><input type="checkbox" id="day-mfds" /> 식약처 업무</label>'
    +   '<button class="btn" data-act="day-add">+ 추가</button></div>'
    + ((selEvs.length||selTasks.length)? '<ul class="list">'+taskRows+selEvs.map(function(e){ return '<li class="ev-row"><span class="ev-time" data-act="edit" data-table="events" data-field="time" data-id="'+e.id+'" title="눌러서 시간 수정">'+(e.time||"종일")+'</span><span class="ev-title" data-act="edit" data-table="events" data-field="title" data-id="'+e.id+'" title="눌러서 수정">'+esc(e.title)+'</span><span class="row-acts"><button class="del" data-act="ev-del" data-id="'+e.id+'" title="삭제">✕</button></span></li>'; }).join("")+'</ul>' : '<p class="empty">이 날은 아직 일정이 없어요.</p>')+'</div>';
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
    + composer
    + boardHtml("articles",ARTICLE_STATUS,items,articleCard)
    + '</div>';

  if(formOpen.articles){ wireSeg("a-status"); focusFirst("a-title"); }
  wireBoardDrag();
}

/* ========== 접히는 입력창 (공용) ==========
 * 입력 폼은 평소엔 접어 둔다. 화면 위쪽 절반을 폼이 차지하면
 * 정작 봐야 할 목록이 스크롤 아래로 밀린다.
 * 탭을 옮기면 모두 다시 접힌다. */
var formOpen={mfds:false,articles:false,archive:false,docs:false};
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
function boardHtml(table,statuses,items,cardFn){
  return '<div class="board" data-table="'+table+'">'
    + statuses.map(function(st){
        var list=items.filter(function(i){ return i.status===st; });
        return '<div class="col" data-col="'+esc(st)+'">'
          + '<div class="col-head"><span class="col-dot"></span>'+esc(st)+'<span class="col-count">'+list.length+'</span></div>'
          + (list.length
              ? list.map(cardFn).join("")
              : '<div class="col-empty">여기로 카드를 끌어다<br />놓을 수 있어요</div>')
          + '</div>';
      }).join("")
    + '</div>';
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
    + mfdsComposer()
    + boardHtml("mfds",MFDS_STATUS,items,function(it){ return mfdsCard(it,todayKey); })
    + '</div>';

  if(formOpen.mfds){ wireSeg("m-status"); focusFirst("m-title"); }
  wireBoardDrag();
}

function renderArchive(){
  var need=S.archive.filter(function(a){return a.needsCheck;}).length;
  var pills=[pill("총 "+S.archive.length+"건")];
  if(need) pills.push(pill("확인 필요 "+need+"건","warn"));

  var composer = formOpen.archive
    ? '<div class="card form composer">'
      + '<input class="input composer-title" id="ar-title" placeholder="건명 (예: 건4. OOS 배치 재시험 처리)" />'
      + '<input class="input" id="ar-law" placeholder="적용 지침서 / 근거 (예: 0980-05 §6.4)" />'
      + '<textarea class="input" id="ar-ans" placeholder="핵심 쟁점·검토 요지"></textarea>'
      + '<input class="input" id="ar-kw" placeholder="키워드 (띄어쓰기로 구분)" />'
      + '<div class="composer-foot">'
      +   '<label class="check-line"><input type="checkbox" id="ar-check" /> [확인 필요] 항목 있음</label>'
      +   composerBtns("archive","ar-add","건 추가")
      + '</div></div>'
    : composerBtn("archive","새 검토 건 추가","건명·근거·쟁점을 함께 적어 두면 나중에 검색돼요");

  view().innerHTML='<div class="page">'
    + pageHead2("민원 검토 서가","건별 검토 파일과 핵심 쟁점을 쌓아 두고, 지침서·키워드로 찾아요.",S.archive.length?pills:null)
    + '<div class="search-box"><span class="search-ic">⌕</span>'
    +   '<input class="input search" id="ar-search" placeholder="건명·지침서·키워드로 검색 (예: 0980-05 갱신, 별표3)" value="'+esc(archiveSearch)+'" />'
    + '</div>'
    + '<div class="chip-row">'
    +   '<button class="chip '+(archiveOnlyCheck?"":"on")+'" data-act="ar-filter" data-id="all">전체<span class="chip-n">'+S.archive.length+'</span></button>'
    +   '<button class="chip '+(archiveOnlyCheck?"on":"")+'" data-act="ar-filter" data-id="check">확인 필요<span class="chip-n">'+need+'</span></button>'
    + '</div>'
    + composer
    + '<button class="import-bar" data-act="ar-import-docx"><span class="import-bar-ic">📄</span><div class="import-bar-text"><div class="import-bar-title">마스터 문서(.docx)에서 가져오기</div><div class="import-bar-sub">워드 파일을 선택하면 건별로 자동 파싱해서 서가에 채워줘요.</div></div><span class="import-bar-go">→</span></button>'
    + '<div id="ar-import-msg" style="display:none;margin-bottom:14px"></div>'
    + '<div id="ar-list"></div></div>';
  renderArchiveList();
  if(formOpen.archive) focusFirst("ar-title");
  document.getElementById("ar-search").addEventListener("input",function(e){ archiveSearch=e.target.value; renderArchiveList(); });
}

function renderArchiveList(){
  var s=archiveSearch.trim().toLowerCase();
  var items=S.archive.filter(function(it){
    if(archiveOnlyCheck && !it.needsCheck) return false;
    if(!s) return true;
    return [it.title,it.guideline,it.summary,it.keywords].join(" ").toLowerCase().indexOf(s)>=0;
  });
  var el=document.getElementById("ar-list"); if(!el) return;
  if(items.length===0){ el.innerHTML='<p class="empty">'+(S.archive.length?"검색 결과가 없어요.":"검토 건을 추가하고 파일을 첨부해 쌓아 보세요.")+'</p>'; return; }
  el.innerHTML='<div class="stack">'+items.map(function(it){
    var kw=(it.keywords||"").trim()? '<div class="entry-kw">'+it.keywords.trim().split(/\s+/).map(function(k){ return '<span class="kw">'+esc(k)+'</span>'; }).join("")+'</div>' : '';
    var files= it.filePath
      ? '<div class="entry-files"><span class="file-name">📎 '+esc(it.fileName||"첨부 파일")+'</span><button class="file-btn" data-act="ar-open" data-id="'+it.id+'">열기</button><button class="file-btn plain" data-act="ar-filedel" data-id="'+it.id+'">파일 삭제</button></div>'
      : '<div class="entry-files"><button class="file-btn" data-act="ar-attach" data-id="'+it.id+'">📎 검토 파일 첨부</button></div>';
    return '<div class="entry"><div class="entry-top"><div class="entry-q"><span data-act="edit" data-table="archive" data-field="title" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.title)+'</span>'+(it.needsCheck?'<span class="entry-flag">확인 필요</span>':'')+'</div><button class="del entry-del" data-act="ar-del" data-id="'+it.id+'" title="삭제">✕</button></div>'
      + (it.guideline?'<div class="entry-law">§ '+esc(it.guideline)+'</div>':'')
      + (it.summary?'<div class="entry-ans" data-act="edit" data-table="archive" data-field="summary" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.summary)+'</div>':'')
      + kw + files + '</div>';
  }).join("")+'</div>';
}

function renderDocs(){
  var items=S.docs;
  var upCount=items.filter(function(d){return d.filePath;}).length;
  var pills=[pill("총 "+items.length+"건")];
  if(upCount) pills.push(pill("올린 파일 "+upCount+"건"));

  var body = items.length===0
    ? '<div class="empty-box"><div class="empty-ic">▤</div><p>파일을 올리거나, 자주 찾는 자료의 위치를 적어 두면<br />매번 찾아 헤매지 않아도 돼요.</p></div>'
    : '<div class="doc-list">'+items.map(function(it){
        var act=it.filePath
          ? '<button class="doc-act" data-act="d-open" data-id="'+it.id+'">열기 ↗</button>'
          : (it.link?'<a class="doc-act" href="'+esc(it.link)+'" target="_blank" rel="noreferrer">열기 ↗</a>':'');
        return '<div class="doc">'
          + '<span class="doc-ic'+(it.filePath?" file":"")+'">'+(it.filePath?"⬇":"■")+'</span>'
          + '<div class="doc-body"><span class="doc-name" data-act="edit" data-table="docs" data-field="name" data-id="'+it.id+'" title="눌러서 수정">'+esc(it.name)+'</span>'
          +   (it.cat?'<span class="doc-cat">'+esc(it.cat)+'</span>':'')+'</div>'
          + act+'<button class="del doc-del" data-act="d-del" data-id="'+it.id+'" title="삭제">✕</button></div>'; }).join("")+'</div>';

  var composer = formOpen.docs
    ? '<div class="card form composer">'
      + '<input class="input composer-title" id="d-name" placeholder="문서명 (예: 의약품 제조 및 품질관리 규정)" />'
      + '<input class="input" id="d-cat" placeholder="분류 (예: GMP / 법령 / 서식)" />'
      + '<input class="input" id="d-link" placeholder="링크 또는 위치 (예: 온나라 > 법령집 > 3권)" />'
      + '<div class="composer-foot">'+composerBtns("docs","d-add","위치만 저장")+'</div></div>'
    : composerBtn("docs","위치만 적어 두기","파일을 올리지 않고 어디에 있는지만 기록해요");

  view().innerHTML='<div class="page">'
    + pageHead2("문서 인덱스","공개 법령·지침서 PDF는 여기에 올려두고 바로 열 수 있어요.",items.length?pills:null)
    + '<div class="notice"><span class="notice-ic">!</span><div>공개 자료(법령·지침서 등)만 올려주세요. 개인정보가 든 답변 원본·내부 비공개 문서는 온나라 등 공식 시스템에 두고, 여기엔 이름·위치만 적는 걸 권해요.</div></div>'
    + '<button class="upload-bar" data-act="d-upload"><span class="upload-ic">⬆</span><div class="import-bar-text"><div class="import-bar-title">파일 올리기</div><div class="import-bar-sub">공개 법령·지침서 PDF</div></div><span class="import-bar-go">→</span></button>'
    + composer + body + '</div>';
  if(formOpen.docs) focusFirst("d-name");
}

/* ========== 액션 (id 없이 insert → 서버가 uuid 생성) ========== */
function addSchedule(dueKey,inputId){
  var v=(val(inputId||"new-s")||"").trim(); if(!v) return;
  var item={text:v,done:false,star:false,due:dueKey||keyOf(new Date())};
  S.schedule.unshift(item); render(); dbInsert("schedule",item);
}
function addArticle(){ var t=(val("a-title")||"").trim(); if(!t) return; var item={title:t,status:segValue("a-status")||"기획",memo:(val("a-memo")||"").trim()}; S.articles.unshift(item); formOpen.articles=false; render(); dbInsert("articles",item); }
function addMfds(){ var t=(val("m-title")||"").trim(); if(!t) return;
  var item={title:t,status:segValue("m-status")||"대기",memo:(val("m-memo")||"").trim(),due:(val("m-due")||"")||null};
  S.mfds.unshift(item); formOpen.mfds=false; render(); dbInsert("mfds",item); }
function addArchive(){ var t=(val("ar-title")||"").trim(); if(!t) return; var chk=document.getElementById("ar-check"); var item={title:t,guideline:(val("ar-law")||"").trim(),summary:(val("ar-ans")||"").trim(),keywords:(val("ar-kw")||"").trim(),needsCheck:chk?chk.checked:false}; S.archive.unshift(item); formOpen.archive=false; render(); dbInsert("archive",item); }
function addDocLink(){ var n=(val("d-name")||"").trim(); if(!n) return; var item={name:n,cat:(val("d-cat")||"").trim(),link:(val("d-link")||"").trim()}; S.docs.unshift(item); formOpen.docs=false; render(); dbInsert("docs",item); }

function del(name,id){ S[name]=S[name].filter(function(x){return x.id!==id;}); render(); dbDelete(name,id); }

function dayAdd(){
  var raw=(val("day-ev")||"").trim(); if(!raw) return;
  var chk=document.getElementById("day-mfds");
  if(chk&&chk.checked){
    /* 일정이 아니라 식약처 업무로 등록. 캘린더는 mfds를 직접 읽으므로 여기에도 그대로 뜬다. */
    var task={title:raw,status:"대기",memo:"",due:calSel};
    S.mfds.unshift(task); render(); dbInsert("mfds",task); return;
  }
  var r=parseNL(raw); var time=null,title=raw;
  if(r.ok){ time=r.time; title=r.title; }
  var item={key:calSel,time:time,title:title};
  S.events.push(item); render(); dbInsert("events",item);
}
function evDel(id){ S.events=S.events.filter(function(e){return e.id!==id;}); render(); dbDelete("events",id); }

/* ========== 파일 업로드 (Supabase Storage — private bucket) ========== */
var uploadTarget=null;
function docsUpload(){ uploadTarget={type:"docs"}; document.getElementById("docfile").click(); }
function archiveAttach(id){ uploadTarget={type:"archive",id:id}; document.getElementById("docfile").click(); }

document.getElementById("docfile").addEventListener("change",function(e){
  var f=e.target.files[0]; e.target.value=""; if(!f||!uploadTarget) return;
  if(f.size>60*1024*1024 && !confirm("파일이 큰 편이에요("+Math.round(f.size/1048576)+"MB). 계속할까요?")) return;
  var path=Date.now()+"_"+f.name.replace(/[^a-zA-Z0-9._-]/g,"_");
  var target=uploadTarget; uploadTarget=null;
  showToast("파일 업로드 중...");
  sb.storage.from("files").upload(path,f).then(function(res){
    if(res.error){ showToast("업로드 실패: "+res.error.message,true); return; }
    if(target.type==="docs"){
      var item={name:f.name,cat:"파일",filePath:path,fileName:f.name};
      S.docs.unshift(item); render(); dbInsert("docs",item);
    } else {
      var it=S.archive.find(function(x){return x.id===target.id;});
      if(it){ it.filePath=path; it.fileName=f.name; render(); dbUpdate("archive",target.id,{filePath:path,fileName:f.name}); }
    }
    showToast("✓ 파일 업로드 완료");
  });
});

/* 비공개 버킷: signed URL로 파일 열기 */
function openStorageFile(path){
  sb.storage.from("files").createSignedUrl(path,3600).then(function(res){
    if(res.error){ showToast("파일을 열지 못했어요.",true); return; }
    window.open(res.data.signedUrl,"_blank");
  });
}

function arFileDel(id){
  var it=S.archive.find(function(x){return x.id===id;});
  if(it&&it.filePath){
    sb.storage.from("files").remove([it.filePath]);
    it.filePath=null; it.fileName=null; render();
    dbUpdate("archive",id,{filePath:null,fileName:null});
  }
}

/* ========== .docx 가져오기 ========== */
function importDocxClick(){ document.getElementById("docxfile").click(); }
function showImportMsg(type,text){
  var el=document.getElementById("ar-import-msg"); if(!el) return;
  el.style.display="block";
  el.className=type==="ok"?"cal-toast ok":"cal-toast no";
  el.textContent=text;
}
function mergeArchiveCases(parsed){
  var added=0, updated=0;
  parsed.forEach(function(c){
    var existing=S.archive.find(function(a){
      var m=a.title.match(/^건\s*(\d+)\./);
      return m&&parseInt(m[1])===c.num;
    });
    if(existing){
      existing.title=c.title; existing.guideline=c.guideline;
      existing.summary=c.summary; existing.keywords=c.keywords;
      existing.needsCheck=c.needsCheck;
      dbUpsert("archive",existing);
      updated++;
    } else {
      var item={title:c.title,guideline:c.guideline,summary:c.summary,keywords:c.keywords,needsCheck:c.needsCheck};
      S.archive.unshift(item);
      dbInsert("archive",item);
      added++;
    }
  });
  return {added:added,updated:updated};
}

document.getElementById("docxfile").addEventListener("change",function(e){
  var f=e.target.files[0]; e.target.value=""; if(!f) return;
  var reader=new FileReader();
  reader.onload=function(){ importDocxFromBuffer(reader.result); };
  reader.readAsArrayBuffer(f);
});

function importDocxFromBuffer(buf){
  extractDocXml(buf).then(function(xml){
    var cases=parseDocxCases(xml);
    if(!cases.length){ showImportMsg("no","건을 찾지 못했어요."); return; }
    var result=mergeArchiveCases(cases);
    render();
    showImportMsg("ok","✓ 총 "+cases.length+"건 — 신규 "+result.added+"건, 갱신 "+result.updated+"건");
  }).catch(function(err){ showImportMsg("no","문서를 읽지 못했어요: "+err.message); });
}

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

function parseDocxCases(xmlText){
  var dp=new DOMParser(), doc=dp.parseFromString(xmlText,"text/xml");
  var ns="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  var paras=doc.getElementsByTagNameNS(ns,"p"), lines=[];
  for(var i=0;i<paras.length;i++){
    var txt="",ts=paras[i].getElementsByTagNameNS(ns,"t");
    for(var j=0;j<ts.length;j++) txt+=ts[j].textContent||"";
    lines.push(txt);
  }
  var starts=[],cases=[];
  for(var i=0;i<lines.length;i++){
    if(/^건\s*\d+\./.test(lines[i].trim())) starts.push(i);
    if(/^민원\s*전체\s*요약|^공통\s*적용\s*근거/.test(lines[i].trim())){ break; }
  }
  for(var c=0;c<starts.length;c++){
    var s=starts[c], e=c+1<starts.length?starts[c+1]:lines.length;
    var cl=lines.slice(s,e), title=cl[0].trim();
    var numM=title.match(/^건\s*(\d+)\./); var num=numM?parseInt(numM[1]):0;
    var guideline="",secs={},curSec=null;
    for(var k=1;k<cl.length;k++){
      var ln=cl[k].trim(); if(!ln) continue;
      if(/^적용\s*지침서/.test(ln)){ guideline=ln.replace(/^적용\s*지침서\s*[:：]?\s*/,""); curSec="_gl"; continue; }
      if(/^□/.test(ln)){ curSec=ln.replace(/^□\s*/,""); secs[curSec]=[]; continue; }
      if(curSec==="_gl"&&!guideline){ guideline=ln; continue; }
      if(curSec==="_gl"&&guideline&&/^[「\[]/.test(ln)){ guideline+=" / "+ln; continue; }
      if(curSec&&secs[curSec]) secs[curSec].push(ln);
    }
    var parts=[];
    [["질의 요지","질의 요지"],["근거","근거"],["쟁점","쟁점"],["쟁점 및 검토","쟁점 및 검토"],["검토 의견(안)","검토 의견(안)"]].forEach(function(pair){
      if(secs[pair[0]]&&secs[pair[0]].length) parts.push("["+pair[1]+"]\n"+secs[pair[0]].join("\n"));
    });
    var summary=parts.join("\n\n");
    var raw=cl.join(" ");
    var needsCheck=/\[확인\s*필요/.test(raw);
    var kwSet=[];
    (title+" "+guideline).replace(/[^가-힣a-zA-Z0-9§·]+/g," ").split(/\s+/).forEach(function(w){
      if(w.length>=2) kwSet.push(w);
    });
    var kw=[]; var seen={};
    kwSet.forEach(function(w){ var lw=w.toLowerCase(); if(!seen[lw]){seen[lw]=1;kw.push(w);} });
    cases.push({num:num,title:title,guideline:guideline,summary:summary,keywords:kw.join(" "),needsCheck:needsCheck});
  }
  return cases;
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
    case "cal-prev": calMonth--; if(calMonth<0){calMonth=11;calYear--;} render(); break;
    case "cal-next": calMonth++; if(calMonth>11){calMonth=0;calYear++;} render(); break;
    case "cal-day": calSel=id; render(); focusDayPanel(); break;
    case "day-add": dayAdd(); break;
    case "ev-del": evDel(id); break;
    case "a-add": addArticle(); break;
    case "a-del": del("articles",id); break;
    case "f-open": formOpen[id]=true; render(); break;
    case "f-close": formOpen[id]=false; render(); break;
    case "m-add": addMfds(); break;
    case "m-del": del("mfds",id); break;
    case "ar-add": addArchive(); break;
    case "ar-del": del("archive",id); break;
    case "ar-filter": archiveOnlyCheck=(id==="check"); render(); break;
    case "ar-import-docx": importDocxClick(); break;
    case "ar-attach": archiveAttach(id); break;
    case "ar-open": { var a=S.archive.find(function(x){return x.id===id;}); if(a&&a.filePath) openStorageFile(a.filePath); break; }
    case "ar-filedel": arFileDel(id); break;
    case "d-upload": docsUpload(); break;
    case "d-add": addDocLink(); break;
    case "d-open": { var dc=S.docs.find(function(x){return x.id===id;}); if(dc&&dc.filePath) openStorageFile(dc.filePath); break; }
    case "d-del": del("docs",id); break;
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
  else if(active==="archive") renderArchive();
  else if(active==="docs") renderDocs();
}

/* 앱 시작 (로그인 후 호출) */
function startApp(){
  appStarted=true;
  showApp();
  document.getElementById("loading").style.display="flex";
  document.getElementById("loading").className="loading-overlay";
  document.getElementById("loading").querySelector(".loading-text").textContent="데이터를 불러오는 중...";
  loadAll().then(function(){
    return seedIfNeeded();
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
