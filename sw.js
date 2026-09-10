/* 업무 데스크 껍데기 캐시 — 실태조사 현장(통신 없음)에서도 앱이 열리게 (v165 · 2026-09-10)
 * 늘 네트워크 먼저(network-first). 성공하면 캐시를 갈아 두고, 실패(오프라인)하면 캐시로 답한다.
 * 그래서 「고쳤는데 그대로」가 생기지 않는다. Supabase 요청은 건드리지 않는다. */
var CACHE="yakktime-shell-v1";
var SHELL=["/","/index.html","/app.js","/style.css","/insp_template.json","https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"];
self.addEventListener("install",function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return Promise.all(SHELL.map(function(u){ return c.add(u).catch(function(){}); })); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate",function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch",function(e){
  var req=e.request; if(req.method!=="GET") return;
  var url=new URL(req.url);
  var shell=(url.origin===self.location.origin&&(url.pathname==="/"||/\.(html|js|css|json)$/.test(url.pathname)))||/cdn\.jsdelivr\.net\/npm\/@supabase/.test(req.url);
  if(!shell) return;
  e.respondWith(fetch(req).then(function(res){
    if(res&&res.ok){ var copy=res.clone(); caches.open(CACHE).then(function(c){ c.put(req,copy); }); }
    return res;
  }).catch(function(){
    return caches.match(req,{ignoreSearch:true}).then(function(m){ return m||caches.match("/index.html"); });
  }));
});
