// =====================================================================
//  law-fetch — 법제처 OPEN API 를 대신 불러 준다 (검색 · 본문 · 별표 파일).
//
//  브라우저가 law.go.kr 을 직접 부르면 CORS 에 막히고, 인증키(OC)가 공개 저장소에
//  드러난다. 그래서 여기서 대신 부른다. AI 를 안 쓰므로 돈이 안 든다.
//  OC 는 Secrets 의 LAW_OC 에 있다. Verify JWT 는 켠 채로 둔다.
//
//  op: "search"  target eflaw|law|admrul, q     → { rows:[{name,mst,eff,status,kind,code}] }
//      "body"    target eflaw(mst,efYd) | law(mst) | admrul(mst)  → { doc }
//                (개정문·제개정이유·연혁은 떼고 보낸다 — 규칙 본문이 2.2MB 다)
//      "file"    flSeq                              → { b64, name }
//  사람에게 보이는 오류는 전부 HTTP 200 + {error} 다 — supabase-js 가 200 이 아니면
//  본문을 안 넘겨주기 때문이다.
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
const BASE = "https://www.law.go.kr";

async function getText(url: string): Promise<string> {
  let last: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 yakktime-workdesk" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 800)); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
function listify(x: unknown): any[] { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const OC = Deno.env.get("LAW_OC");
    if (!OC) return json({ error: "법제처 인증키(LAW_OC)가 Secrets 에 없어요." });
    const b = await req.json().catch(() => ({}));
    const op = String(b.op || "");

    if (op === "search") {
      const target = String(b.target || "eflaw");
      const q = String(b.q || "").trim();
      if (!q) return json({ error: "찾을 이름이 비었어요." });
      if (!/^(eflaw|law|admrul)$/.test(target)) return json({ error: "target 이 이상해요." });
      const u = `${BASE}/DRF/lawSearch.do?OC=${OC}&target=${target}&type=JSON&display=100&query=${encodeURIComponent(q)}`;
      const t = await getText(u);
      let d: any; try { d = JSON.parse(t); } catch { return json({ error: "법제처가 JSON 이 아닌 답을 줬어요: " + t.slice(0, 80) }); }
      const top = d[Object.keys(d)[0]] || {};
      const list = ([] as any[]).concat(...Object.values(top).filter(Array.isArray) as any[]);
      const rows = list.map((r: any) => target === "admrul"
        ? { name: r["행정규칙명"], mst: r["행정규칙일련번호"], eff: r["시행일자"], status: r["현행연혁구분"], kind: r["행정규칙종류"], code: r["행정규칙ID"], pub: r["발령일자"] }
        : { name: r["법령명한글"], mst: r["법령일련번호"], eff: r["시행일자"], status: r["현행연혁코드"], kind: r["법령구분명"], code: r["법령ID"], pub: r["공포일자"] });
      return json({ rows, total: top["totalCnt"] ?? rows.length });
    }

    if (op === "body") {
      const target = String(b.target || "");
      const mst = String(b.mst || "").replace(/\D/g, "");
      if (!mst) return json({ error: "법령 번호(mst)가 비었어요." });
      let u: string;
      if (target === "eflaw") {
        const efYd = String(b.efYd || "").replace(/\D/g, "");
        if (efYd.length !== 8) return json({ error: "시행일자(efYd)가 비었어요." });
        u = `${BASE}/DRF/lawService.do?OC=${OC}&target=eflaw&MST=${mst}&efYd=${efYd}&type=JSON`;
      } else if (target === "law") u = `${BASE}/DRF/lawService.do?OC=${OC}&target=law&MST=${mst}&type=JSON`;
      else if (target === "admrul") u = `${BASE}/DRF/lawService.do?OC=${OC}&target=admrul&ID=${mst}&type=JSON`;
      else return json({ error: "target 이 이상해요." });
      const t = await getText(u);
      let d: any; try { d = JSON.parse(t); } catch { return json({ error: "법제처가 본문 대신 다른 답을 줬어요: " + t.slice(0, 80) }); }
      const doc = d[Object.keys(d)[0]];
      if (!doc || typeof doc !== "object") return json({ error: "본문이 비어 있어요." });
      for (const k of ["개정문", "제개정이유", "연혁", "첨부파일"]) delete doc[k];
      return json({ doc });
    }

    if (op === "file") {
      const seq = String(b.flSeq || "").replace(/\D/g, "");
      if (!seq) return json({ error: "파일 번호(flSeq)가 비었어요." });
      const r = await fetch(`${BASE}/LSW/flDownload.do?flSeq=${seq}`, { headers: { "User-Agent": "Mozilla/5.0 yakktime-workdesk" } });
      if (!r.ok) return json({ error: "별표 파일을 못 받았어요: HTTP " + r.status });
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 6_000_000) return json({ error: "별표 파일이 너무 커요 (" + Math.round(bytes.length / 1e6) + "MB)." });
      const cd = r.headers.get("content-disposition") || "";
      const m = /filename="?([^";]+)"?/.exec(cd);
      let name = "";
      try { name = m ? decodeURIComponent(m[1]) : ""; } catch { name = m ? m[1] : ""; }
      return json({ b64: b64(bytes), name, size: bytes.length, type: r.headers.get("content-type") || "" });
    }

    return json({ error: "op 이 이상해요: " + op });
  } catch (e) {
    return json({ error: "법제처를 부르지 못했어요: " + (e instanceof Error ? e.message : String(e)) });
  }
});
