// =====================================================================
//  law-embed — 조문마다 「뜻 지문」(임베딩)을 만들어 law_articles.emb 에 넣는다.
//
//  왜: 낱말 검색과 AI 의 제목 훑기는 **낱말이 맞아야** 찾는다. 「같이 2차 포장」을
//  물으면 법령은 「구획」이라 쓰므로 놓쳤다(2026-09-08). 뜻 지문은 낱말이 달라도
//  뜻이 닿는 조문을 찾는다. law-pick 이 질문의 지문으로 비슷한 조문을 후보에 보탠다.
//
//  Voyage AI(Anthropic 이 권하는 임베딩) voyage-4-large · 1024차원. 200M 토큰까지 무료.
//  Secrets: VOYAGE_API_KEY. 표: law_articles.emb (pgvector) · 함수 law_emb_put · law_match.
//
//  op "status"  { lawId? }         → { total, missing }
//  op "run"     { lawId?, max? }    → { done, remaining, tokens }   한 번에 최대 max(기본 100)개
//  사람에게 보이는 오류는 HTTP 200 + {error}. 요청 한도(429)면 { error, retryAfter } 로.
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
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MODEL = "voyage-4-large";
const DOC_CHARS = 6000;      // 조 하나에서 지문에 넣을 최대 글자 (별표 토막은 5천 자 안팎)
const REQ_CHARS = 140000;    // Voyage 한 요청의 글자 예산 (voyage-4-large 는 12만 토큰까지)
const REQ_DOCS = 100;
// 결제수단을 안 넣은 Voyage 계정은 **분당 3회 · 1만 토큰**뿐이다(429 본문에 그렇게 적혀 온다).
// 그때는 한 번에 3개·7천 자만 보내고, 부르는 쪽이 21초씩 쉬며 되풀이한다. 1,349개면 한 시간쯤.
const SLOW_CHARS = 7000, SLOW_DOCS = 3;

async function pg(method: string, path: string, body?: unknown, prefer?: string) {
  const h: Record<string, string> = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  if (prefer) h["Prefer"] = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`표 ${r.status}: ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch { return t; }
}
const inList = (xs: unknown[]) => "in.(" + xs.map((x) => '"' + String(x).replace(/"/g, "") + '"').join(",") + ")";

async function voyage(key: string, input: string[], type: "document" | "query") {
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input, model: MODEL, input_type: type, truncation: true }),
  });
  const t = await r.text();
  if (r.status === 429) { const e = new Error("RATE"); (e as any).retry = Number(r.headers.get("retry-after") || 20); (e as any).why = t.slice(0, 200); throw e; }
  if (!r.ok) throw new Error(`Voyage ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  const out: number[][] = [];
  (j.data || []).forEach((d: any) => { out[d.index] = d.embedding; });
  return { embs: out, tokens: Number(j.usage?.total_tokens || 0) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const op = String(b.op || "status");
    const lawId = b.lawId ? String(b.lawId) : null;
    const scope = lawId ? "&law_id=eq." + encodeURIComponent(lawId) : "";

    if (op === "status") {
      const tot = await fetch(`${SB_URL}/rest/v1/law_articles?select=id&limit=1${scope}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact" } });
      const mis = await fetch(`${SB_URL}/rest/v1/law_articles?select=id&limit=1&emb=is.null${scope}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact" } });
      const n = (r: Response) => Number((r.headers.get("content-range") || "0/0").split("/")[1] || 0);
      return json({ total: n(tot), missing: n(mis), model: MODEL, ready: !!Deno.env.get("VOYAGE_API_KEY") });
    }

    if (op === "run") {
      const key = Deno.env.get("VOYAGE_API_KEY");
      if (!key) return json({ error: "뜻 검색 열쇠(VOYAGE_API_KEY)가 Secrets 에 없어요.", noKey: true });
      const slow = !!b.slow;
      const reqChars = slow ? SLOW_CHARS : REQ_CHARS, reqDocs = slow ? SLOW_DOCS : REQ_DOCS;
      const max = slow ? SLOW_DOCS : Math.min(Number(b.max || REQ_DOCS), 300);
      const rows: any[] = await pg("GET", `law_articles?select=id,law_id,label,content&emb=is.null&order=law_id.asc,seq.asc&limit=${max}${scope}`);
      if (!rows.length) return json({ done: 0, remaining: 0, tokens: 0 });
      const laws: any[] = await pg("GET", "laws?select=id,name&id=" + encodeURIComponent(inList([...new Set(rows.map((r) => r.law_id))])));
      const nameOf = new Map<string, string>(laws.map((l) => [String(l.id), String(l.name)]));
      // 지문에 넣을 글: 법령 이름 + 조 이름 + 본문 앞부분. 격자 기호는 빈칸으로.
      const textOf = (r: any) => (nameOf.get(String(r.law_id)) || "") + " " + String(r.label || "") + "\n"
        + String(r.content || "").replace(/[┃│┨]/g, " ").replace(/\s+/g, " ").slice(0, DOC_CHARS);
      let done = 0, tokens = 0, i = 0;
      while (i < rows.length) {
        // 글자 예산 안에서 묶는다 — 별표 토막은 크고 조는 작다
        const batch: any[] = []; let chars = 0;
        while (i < rows.length && batch.length < reqDocs) {
          const t = textOf(rows[i]);
          if (batch.length && chars + t.length > reqChars) break;
          batch.push({ id: rows[i].id, text: t }); chars += t.length; i++;
        }
        let res;
        try { res = await voyage(key, batch.map((x) => x.text), "document"); }
        catch (e) {
          if ((e as Error).message === "RATE") {
            const why = String((e as any).why || "");
            return json({ done, remaining: -1, tokens, error: "Voyage 요청 한도에 닿았어요. 잠시 뒤 다시 이어가요.",
                          retryAfter: (e as any).retry || 20, slow: /payment method/i.test(why), why, batch: batch.length, chars });
          }
          throw e;
        }
        tokens += res.tokens;
        const put = batch.map((x, k) => ({ id: x.id, emb: "[" + res.embs[k].join(",") + "]" }));
        await pg("POST", "rpc/law_emb_put", { rows: put });
        done += batch.length;
      }
      const left = await fetch(`${SB_URL}/rest/v1/law_articles?select=id&limit=1&emb=is.null${scope}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact" } });
      const remaining = Number((left.headers.get("content-range") || "0/0").split("/")[1] || 0);
      return json({ done, remaining, tokens });
    }

    return json({ error: "op 이 이상해요: " + op });
  } catch (e) {
    return json({ error: "뜻 지문을 만들지 못했어요: " + (e instanceof Error ? e.message : String(e)) });
  }
});
