// =====================================================================
//  law-pick — 민원 질문을 읽고 「어느 조를 펴 봐야 하는지」 골라준다.
//
//  왜 서버에서 하나:
//   · API 키가 브라우저에 절대 안 나와야 한다. 여기 비밀값으로만 둔다.
//   · 조 목록(수만 토큰)을 서버에서 만들면 프롬프트 캐싱이 걸린다.
//   · 고른 조문의 본문 앞부분도 여기서 같이 붙여 보낸다 — 화면에서
//     「전체 보기」를 눌러 창을 열었다 닫지 않아도 맞는지 판단할 수 있다.
//
//  이 함수는 답변을 쓰지 않는다. 「어디를 볼지」만 고른다.
//
//  Supabase → Edge Functions → law-pick 에 통째로 붙여넣고 Deploy.
//  비밀값(Secrets)에 ANTHROPIC_API_KEY 를 넣어야 동작한다.
// =====================================================================

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL     = "claude-haiku-4-5-20251001";
const MAX_ARTS  = 3000;   // 조 목록 상한 — 토큰이 무한정 늘지 않게
const MAX_PICKS = 10;
const PREVIEW   = 180;    // 본문 미리보기 글자 수
const KRW       = 1400;   // 원/달러

// Haiku 4.5 값 ($/100만 토큰). 캐시 읽기 0.1배, 캐시 쓰기 1.25배.
const IN_USD = 1.0, OUT_USD = 5.0;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 사람에게 보여줄 사정은 200 으로 돌려준다. supabase-js 는 200 이 아니면
// 본문을 안 넘겨주고 FunctionsHttpError 만 주기 때문에, 그러면 무엇이
// 잘못됐는지가 화면까지 오지 못한다.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const RULES = `너는 대한민국 식품의약품안전처 GMP 담당 공무원을 돕는 도구다.
다음 블록은 이 사람이 직접 올려둔 법령·지침의 「조 목록」이다. 조문 본문은 없고 제목뿐이다.

민원인의 질문을 읽고, 답을 찾으려면 어느 조를 펴 봐야 하는지 고른다.

지켜야 할 것
- 목록에 실제로 있는 번호만 고른다. 없는 번호를 지어내지 않는다.
- 많아야 ${MAX_PICKS}개. 관련이 높은 것부터 순서대로 낸다.
- 관련이 어중간한 것을 채워 넣지 않는다. 확실한 게 둘뿐이면 둘만 낸다.
  목록을 길게 만드는 것보다 쳐내는 것이 이 도구의 일이다.
- 점수는 네가 매기지 않는다. 아래 세 가지만 골라라. 점수는 이쪽에서 계산한다.

  direct — 질문에 대한 답이 이 조에 들어 있나?
    "답"   이 조를 펴면 질문의 답이 나온다.
    "조건" 답 자체는 아니지만 그 답의 조건·범위·수량·기준을 정한다.
    "배경" 정의·절차·벌칙처럼 곁가지다.

  need — 민원 답변서를 쓸 때 이 조를 인용해야 하나?
    "필수"   이 조를 안 적으면 답변이 성립하지 않는다.
    "도움"   적어 두면 답변이 튼튼해진다.
    "없어도" 안 적어도 답변은 된다.

  sure — 조 제목만 보고 얼마나 확신하나? (본문은 못 봤다는 걸 잊지 마라)
    "분명" 제목에 질문의 말이 그대로 들어 있다.
    "짐작" 제목으로 미루어 그럴 것 같다.
    "막연" 아닐 수도 있다.

  세 가지를 정직하게 고른다. 다 "답·필수·분명" 으로 몰면 순서를 매긴 뜻이 없다.
  본문을 못 봤으므로 "분명" 은 제목에 질문의 낱말이 실제로 있을 때만 쓴다.
- 조문 본문을 못 봤으므로 답을 만들지 않는다. 여기서 하는 일은 「어디를 볼지 고르는 것」뿐이다.
- why 에는 왜 그 조를 골랐는지 한 문장. 본문을 못 봤다는 사실이 드러나게
  「제목으로 보아 …」처럼 적는다.
- 질문이 이 법령들과 상관없어 보이면 picks 를 비우고, note 에 무엇이 없어서 못 골랐는지 적는다.
- note 는 한두 문장. 어느 법령을 훑었는지, 빠진 게 있어 보이면 무엇인지 적는다.
- 모두 한국어로 쓴다.
- 답은 JSON 하나만 낸다. 앞뒤에 설명이나 \`\`\` 를 붙이지 않는다.`;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n:      { type: "integer" },
          direct: { type: "string", enum: ["답", "조건", "배경"] },
          need:   { type: "string", enum: ["필수", "도움", "없어도"] },
          sure:   { type: "string", enum: ["분명", "짐작", "막연"] },
          why:    { type: "string" },
        },
        required: ["n", "direct", "need", "sure", "why"],
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

    const { q, lawIds } = await req.json().catch(() => ({ q: "", lawIds: null }));
    const question = String(q || "").trim();
    if (question.length < 5)    return json({ error: "질문을 조금 더 길게 적어주세요." });
    if (question.length > 4000) return json({ error: "질문이 너무 길어요. 4000자 안으로 줄여주세요." });
    // 화면에서 법령을 골랐으면 그 안에서만 고른다. 안 골랐으면(null) 전부 본다.
    const only: string[] | null = Array.isArray(lawIds) && lawIds.length ? lawIds.map(String) : null;

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- 조 목록 만들기 --------------------------------------------------
    let lawQ = db.from("laws").select("id,name");
    if (only) lawQ = lawQ.in("id", only);
    const { data: laws, error: le } = await lawQ;
    if (le) return json({ error: "법령 목록을 못 읽었어요: " + le.message });
    const lawName = new Map((laws || []).map((l: any) => [l.id, l.name]));

    let artQ = db.from("law_articles").select("id,law_id,seq,label");
    if (only) artQ = artQ.in("law_id", only);
    const { data: arts, error: ae } = await artQ.order("law_id").order("seq").limit(MAX_ARTS);
    if (ae) return json({ error: "조문을 못 읽었어요: " + ae.message });
    if (!arts || !arts.length) {
      return json({ error: only
        ? "고른 법령에 조문이 없어요. 「조문 만들기」를 먼저 하거나 범위를 넓혀주세요."
        : "아직 조문으로 쪼개진 법령이 없어요. 법령 탭에서 「조문 만들기」를 먼저 해주세요." });
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
      max_tokens: 2000,
      system: [
        { type: "text", text: RULES },
        // 조 목록은 매번 똑같으므로 캐시에 재운다. 두 번째 질문부터 1/10 값.
        { type: "text", text: `<조 목록>\n${catalog}</조 목록>`,
          cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `민원 질문:\n${question}` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as any);

    // 보통은 output_config 덕분에 본문이 곧 JSON 이다. 그래도 앞뒤에 말이
    // 붙어 오는 경우를 대비해 { … } 만 떼어내 한 번 더 시도한다.
    let parsed: any = null, raw = "";
    for (const b of res.content || []) if (b.type === "text") raw += b.text;
    try { parsed = JSON.parse(raw); } catch (_) {
      const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
      if (i >= 0 && j > i) { try { parsed = JSON.parse(raw.slice(i, j + 1)); } catch (_) {} }
    }
    if (!parsed) return json({ error: "AI 답을 읽지 못했어요. 다시 한 번 눌러주세요." });

    // 점수는 여기서 계산한다. AI 에게 「0~100 중 알아서」를 시키면 죄다 90점대가
    // 나오고 87 과 84 의 차이에 아무 뜻이 없다. 세 가지 판단에 값을 매겨 더하면
    // 같은 판단이 늘 같은 점수가 되고, 왜 그 점수인지도 사람이 볼 수 있다.
    const W_DIRECT: Record<string, number> = { "답": 45, "조건": 30, "배경": 12 };
    const W_NEED:   Record<string, number> = { "필수": 30, "도움": 18, "없어도": 6 };
    const W_SURE:   Record<string, number> = { "분명": 25, "짐작": 15, "막연": 5 };

    let picks = (parsed.picks || []).slice(0, MAX_PICKS)
      .map((p: any) => {
        const hit = index[p.n];
        if (!hit) return null;   // 없는 번호를 지어냈으면 조용히 버린다
        // 목록에 없는 말이 오면 가운데 값으로 본다 (점수가 튀지 않게)
        const direct = W_DIRECT[p.direct] != null ? p.direct : "조건";
        const need   = W_NEED[p.need]     != null ? p.need   : "도움";
        const sure   = W_SURE[p.sure]     != null ? p.sure   : "짐작";
        const score  = W_DIRECT[direct] + W_NEED[need] + W_SURE[sure];
        return { id: hit.id, lawId: hit.law_id, law: hit.law, label: hit.label,
                 direct, need, sure, score, why: String(p.why || "") };
      })
      .filter(Boolean);
    // AI가 순서를 흐트러뜨려도 화면에서는 늘 점수 높은 것부터 선다.
    picks = picks
      .map((p: any, i: number) => ({ p, i }))
      .sort((a: any, b: any) => (b.p.score - a.p.score) || (a.i - b.i))
      .map((x: any) => x.p);

    // --- 고른 조문의 본문 앞부분을 붙인다 ---------------------------------
    if (picks.length) {
      const { data: bodies } = await db.from("law_articles")
        .select("id,content").in("id", picks.map((p: any) => p.id));
      const byId = new Map((bodies || []).map((b: any) => [b.id, b.content || ""]));
      picks.forEach((p: any) => {
        const t = String(byId.get(p.id) || "").replace(/\s+/g, " ").trim();
        p.head = t.length > PREVIEW ? t.slice(0, PREVIEW) + "…" : t;
      });
    }

    // --- 이번에 든 값 ----------------------------------------------------
    const u = res.usage || {};
    const usd = ((u.input_tokens || 0) * IN_USD
               + (u.cache_read_input_tokens || 0) * IN_USD * 0.1
               + (u.cache_creation_input_tokens || 0) * IN_USD * 1.25
               + (u.output_tokens || 0) * OUT_USD) / 1e6;

    return json({
      picks,
      note: String(parsed.note || ""),
      arts: arts.length,
      // 조문이 상한에 닿으면 뒤쪽 법령을 아예 못 봤다는 뜻이라 알려준다
      truncated: arts.length >= MAX_ARTS,
      krw: Math.round(usd * KRW),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
