// =====================================================================
//  law-pick — 민원 질문을 읽고 「어느 조를 펴 봐야 하는지」 골라준다.
//
//  왜 서버에서 하나:
//   · API 키가 브라우저에 절대 안 나와야 한다. 여기 비밀값으로만 둔다.
//   · 조 목록(수만 토큰)을 서버에서 만들면 프롬프트 캐싱이 걸린다.
//   · 하루 몇 번까지만 부르게 여기서 막을 수 있다.
//
//  이 함수는 답변을 쓰지 않는다. 「어디를 볼지」만 고른다 (2단계).
//  답변 초안(3단계)은 따로 만든다.
//
//  Supabase → Edge Functions → law-pick 에 통째로 붙여넣고 Deploy.
//  비밀값(Secrets)에 ANTHROPIC_API_KEY 를 넣어야 동작한다.
// =====================================================================

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL      = "claude-haiku-4-5-20251001";
const DAILY_MAX  = 20;      // 하루 호출 상한 — 실수로 연타해도 여기서 막힌다
const MAX_ARTS   = 3000;    // 조 목록 상한 (토큰이 무한정 늘지 않게)
const MAX_PICKS  = 8;
const KRW        = 1400;    // 원/달러

// Haiku 4.5 값 ($/100만 토큰). 캐시 읽기는 0.1배, 캐시 쓰기는 1.25배.
const IN_USD = 1.0, OUT_USD = 5.0;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 사람에게 보여줄 사정(상한 초과·조문 없음·질문이 짧음)은 200 으로 돌려준다.
// supabase-js 는 200 이 아니면 본문을 안 넘겨주고 FunctionsHttpError 만 준다 —
// 그러면 「하루 20번 다 썼어요」 같은 말이 화면까지 오지 못한다.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const RULES = `너는 대한민국 식품의약품안전처 GMP 담당 공무원을 돕는 도구다.
다음 블록은 이 사람이 직접 올려둔 법령·지침의 「조 목록」이다. 조문 본문은 없고 제목뿐이다.

민원인의 질문을 읽고, 답을 찾으려면 어느 조를 펴 봐야 하는지 고른다.

지켜야 할 것
- 목록에 실제로 있는 번호만 고른다. 없는 번호를 지어내지 않는다.
- 많아야 ${MAX_PICKS}개. 관련이 확실한 것부터 순서대로.
- 조문 본문을 못 봤으므로 답을 만들지 않는다. 여기서 하는 일은 「어디를 볼지 고르는 것」뿐이다.
- why 에는 왜 그 조를 골랐는지 한 문장으로 적는다. 본문을 못 봤다는 사실이 드러나게
  「제목으로 보아 …」처럼 적는다.
- 질문이 이 법령들과 상관없어 보이면 picks 를 비우고, note 에 무엇이 없어서 못 골랐는지 적는다.
- note 는 한두 문장. 어느 법령을 훑었는지, 빠진 게 있어 보이면 무엇인지 적는다.
- 모두 한국어로 쓴다.`;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n:   { type: "integer" },
          why: { type: "string" },
        },
        required: ["n", "why"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["picks", "note"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY 가 없어요. Edge Functions 비밀값에 넣어주세요." });

    const { q } = await req.json().catch(() => ({ q: "" }));
    const question = String(q || "").trim();
    if (question.length < 5)   return json({ error: "질문을 조금 더 길게 적어주세요." });
    if (question.length > 4000) return json({ error: "질문이 너무 길어요. 4000자 안으로 줄여주세요." });

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- 하루 상한 ------------------------------------------------------
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await db.from("ai_log")
      .select("id", { count: "exact", head: true })
      .gte("at", since);
    if ((count ?? 0) >= DAILY_MAX) {
      return json({ error: `하루 ${DAILY_MAX}번까지만 물어볼 수 있어요. 내일 다시 해주세요.`, used: count });
    }

    // --- 조 목록 만들기 --------------------------------------------------
    const { data: laws, error: le } = await db.from("laws").select("id,name");
    if (le) return json({ error: "법령 목록을 못 읽었어요: " + le.message });
    const lawName = new Map((laws || []).map((l: any) => [l.id, l.name]));

    const { data: arts, error: ae } = await db.from("law_articles")
      .select("id,law_id,seq,label")
      .order("law_id").order("seq").limit(MAX_ARTS);
    if (ae) return json({ error: "조문을 못 읽었어요: " + ae.message });
    if (!arts || !arts.length) {
      return json({ error: "아직 조문으로 쪼개진 법령이 없어요. 법령 탭에서 「조문 만들기」를 먼저 해주세요." });
    }

    const index: any[] = [];
    let catalog = "", curLaw = "";
    arts.forEach((a: any, i: number) => {
      const nm = lawName.get(a.law_id) || "이름 없는 법령";
      if (nm !== curLaw) { curLaw = nm; catalog += `\n### ${nm}\n`; }
      const n = i + 1;
      catalog += `${n} ${a.label}\n`;
      index[n] = { id: a.id, law_id: a.law_id, law: nm, label: a.label };
    });

    // --- Claude 에게 묻기 ------------------------------------------------
    const client = new Anthropic({ apiKey });
    const res: any = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [
        { type: "text", text: RULES },
        // 조 목록은 매번 똑같으므로 캐시에 재운다. 두 번째 질문부터 1/10 값.
        { type: "text", text: `<조 목록>\n${catalog}</조 목록>`,
          cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `민원 질문:\n${question}` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as any);

    let parsed: any = { picks: [], note: "" };
    for (const b of res.content || []) {
      if (b.type === "text") { try { parsed = JSON.parse(b.text); } catch (_) {} }
    }

    const picks = (parsed.picks || []).slice(0, MAX_PICKS)
      .map((p: any) => {
        const hit = index[p.n];
        return hit ? { id: hit.id, lawId: hit.law_id, law: hit.law, label: hit.label, why: String(p.why || "") } : null;
      })
      .filter(Boolean);

    // --- 값 계산 · 기록 --------------------------------------------------
    const u = res.usage || {};
    const inTok = u.input_tokens || 0;
    const cRead = u.cache_read_input_tokens || 0;
    const cWrite = u.cache_creation_input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const usd = (inTok * IN_USD + cRead * IN_USD * 0.1 + cWrite * IN_USD * 1.25 + outTok * OUT_USD) / 1e6;
    const krw = Math.round(usd * KRW);

    await db.from("ai_log").insert({
      kind: "pick", model: MODEL, q: question.slice(0, 500),
      in_tokens: inTok, cache_read: cRead, cache_write: cWrite, out_tokens: outTok, krw,
    });

    return json({
      picks,
      note: String(parsed.note || ""),
      arts: arts.length,
      krw,
      used: (count ?? 0) + 1,
      max: DAILY_MAX,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
