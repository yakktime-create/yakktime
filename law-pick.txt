// =====================================================================
//  law-pick — 민원 질문을 읽고 「어느 조를 펴 봐야 하는지」 골라준다.
//
//  두 번에 나눠 부른다.
//    1차  조 제목 목록 전체를 훑어 후보 20개를 추린다. (제목만 — 싸다)
//    2차  그 20개의 본문을 통째로 읽고 최종 10개로 추린다.
//  한 번에 하려면 조 목록 전체에 본문을 붙여야 하는데 프롬프트가 4~5배로
//  불어난다. 나누면 값은 몇십 원 더 드는 정도로 끝나면서, 판단은 조문을
//  실제로 읽고 하게 된다.
//
//  이 함수는 답변을 쓰지 않는다. 「어디를 볼지」만 고른다.
//
//  Supabase → Edge Functions → law-pick 에 통째로 붙여넣고 Deploy.
//  비밀값(Secrets)에 ANTHROPIC_API_KEY 를 넣어야 동작한다.
// =====================================================================

// 버전을 고정한다. 안 박아 두면 어느 날 새 판이 올라오면서 조용히 깨진다.
// (2026-09-04 기준 최신)
import Anthropic from "npm:@anthropic-ai/sdk@0.123.0";
import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const MODEL      = "claude-haiku-4-5-20251001";
const MAX_ARTS   = 3000;   // 조 목록 상한 — 토큰이 무한정 늘지 않게
const SHORTLIST  = 20;     // 1차에서 추릴 후보 수
const MAX_PICKS  = 10;     // 2차에서 남길 최종 수
// 2차에게는 조문을 통째로 읽힌다. 다만 정의 조항이나 별표가 붙은 조는
// 수만 자에 이르므로 한 조와 전체에 각각 뚜껑을 씌운다. 없으면 한 번에
// 몇천 원이 나갈 수 있다.
const ART_MAX    = 4000;   // 조 하나에서 읽을 최대 글자
const TOTAL_MAX  = 60000;  // 2차에 넣을 글자 총량
const PREVIEW    = 180;    // 화면에 보여줄 미리보기
const KRW        = 1400;   // 원/달러

// 법 위계 — 이름만 보고 가른다. 같은 내용이면 상위법이 더 센 근거다.
// 다만 실제 답은 고시·규칙에 적힌 경우가 많으므로 가중치는 작게 준다.
// 「답이 여기 있나」(45점)를 뒤집을 만큼 주면 엉뚱한 조를 위로 올리게 된다.
const KINDS: {n:number; t:string; re:RegExp; w:number}[] = [
  { n:0, t:"법률",       re:/\(법률\)|법률\s*제\s*\d/,        w:8 },
  { n:1, t:"시행령",     re:/\(대통령령\)|시행령/,               w:6 },
  { n:2, t:"시행규칙",   re:/\(총리령\)|\(부령\)|규칙/,          w:5 },
  { n:3, t:"고시",       re:/고시|규정\s*\(/,                   w:3 },
  { n:4, t:"지침·안내서", re:/지침|안내서|절차|가이드|해설/,        w:0 },
];
function kindOf(name: string) {
  for (const k of KINDS) if (k.re.test(String(name || ""))) return k;
  return { n:5, t:"그 밖", re:/$^/, w:0 };
}

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

const HEAD = `너는 대한민국 식품의약품안전처 GMP 담당 공무원을 돕는 도구다.
민원인의 질문을 읽고, 답을 찾으려면 어느 조를 펴 봐야 하는지 고른다.
답변을 쓰지 않는다. 여기서 하는 일은 「어디를 볼지 고르는 것」뿐이다.
모두 한국어로 쓴다. 답은 JSON 하나만 낸다. 앞뒤에 설명이나 \`\`\` 를 붙이지 않는다.`;

// ---- 1차: 제목만 보고 후보 추리기 -------------------------------------
const RULES1 = `${HEAD}

다음 블록은 이 사람이 올려둔 법령·지침의 「조 목록」이다. 제목뿐이고 본문은 없다.
제목만 보고 <b>후보</b>를 고른다. 다음 단계에서 본문을 읽고 다시 추릴 것이므로,
여기서는 조금 넉넉하게 골라도 된다.

- 목록에 실제로 있는 번호만 고른다. 없는 번호를 지어내지 않는다.
- 많아야 ${SHORTLIST}개. 관련 있어 보이는 것부터.
- 그래도 아무 상관 없는 것을 채워 넣지는 않는다. 세 개뿐이면 세 개만 낸다.
- note 에는 어느 법령을 훑었는지, 빠진 게 있어 보이면 무엇인지 한두 문장.`;

const SCHEMA1 = {
  type: "object",
  properties: {
    ns:   { type: "array", items: { type: "integer" } },
    note: { type: "string" },
  },
  required: ["ns", "note"],
  additionalProperties: false,
};

// ---- 2차: 본문 앞부분을 읽고 추리기 -----------------------------------
const RULES2 = `${HEAD}

아래는 1차로 추린 조문들이다. <b>제목과 본문</b>이 함께 들어 있다.
이제 조문을 실제로 읽고 최종으로 남길 것을 고른다.

- 많아야 ${MAX_PICKS}개. 관련이 어중간한 것을 채워 넣지 않는다.
  확실한 게 둘뿐이면 둘만 낸다. 쳐내는 것이 이 단계의 일이다.
- 「…(뒤가 잘림)」 이라고 적힌 조는 아주 길어서 앞부분만 준 것이다.
  그런 조는 뒤에 더 있다는 걸 잊지 않는다.

점수는 네가 매기지 않는다. 아래 세 가지만 고른다. 등급은 이쪽에서 계산한다.

  direct — 질문에 대한 답이 이 조에 들어 있나?
    "답이 여기"   이 조를 펴면 질문의 답이 나온다.
    "조건이 여기" 답 자체는 아니지만 그 답의 조건·범위·수량·기준이 여기 있다.
    "곁가지"      정의·절차·벌칙처럼 답의 둘레에 있는 규정이다.

  need — 민원 답변서를 쓸 때 이 조를 인용해야 하나?
    "인용 필수"   이 조를 안 적으면 답변이 성립하지 않는다.
    "있으면 좋음" 적어 두면 답변이 튼튼해진다.
    "없어도 됨"   안 적어도 답변은 된다.

  sure — 본문에서 근거를 찾았나?
    "근거 찾음"      준 본문 안에 근거가 실제로 보인다. 어느 대목인지 짚을 수 있다.
    "비슷한 대목만"  관련 있어 보이는 말은 있으나 딱 떨어지는 대목을 짚기는 어렵다.
    "못 찾음"        본문에서는 못 찾았고 제목으로 짐작한다.

  세 가지를 정직하게 고른다. 다 최고로 몰면 순서를 매긴 뜻이 없다.

- why 에는 왜 그 조인지 한 문장. <b>근거를 찾았으면 그 대목을 짚어 적는다</b>
  (예: 「1회 1개 품목 포장단위로 판매할 것」이 여기 있습니다).
  본문에서 못 찾았으면 그렇다고 적는다.
- note 는 한두 문장. 무엇을 보고 골랐는지, 빠진 게 있어 보이면 무엇인지.
- 같은 내용이 법률과 지침서에 다 있으면 <b>법률 쪽을 고른다</b>. 지침서는 법령이
  아니라 운영 방침이라, 민원 답변의 근거로는 법률·규칙·고시가 먼저다.
  지침서만 답을 담고 있으면 그건 그대로 낸다.`;

const SCHEMA2 = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n:      { type: "integer" },
          direct: { type: "string", enum: ["답이 여기", "조건이 여기", "곁가지"] },
          need:   { type: "string", enum: ["인용 필수", "있으면 좋음", "없어도 됨"] },
          sure:   { type: "string", enum: ["근거 찾음", "비슷한 대목만", "못 찾음"] },
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

// 앞뒤에 말이 붙어 와도 { … } 만 떼어내 읽는다
function readJson(res: any) {
  let raw = "";
  for (const b of res.content || []) if (b.type === "text") raw += b.text;
  try { return JSON.parse(raw); } catch (_) {}
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(raw.slice(i, j + 1)); } catch (_) {} }
  return null;
}
function usdOf(u: any) {
  return ((u?.input_tokens || 0) * IN_USD
        + (u?.cache_read_input_tokens || 0) * IN_USD * 0.1
        + (u?.cache_creation_input_tokens || 0) * IN_USD * 1.25
        + (u?.output_tokens || 0) * OUT_USD) / 1e6;
}

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
    const lawKind = new Map((laws || []).map((l: any) => [l.id, kindOf(l.name)]));

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

    const client = new Anthropic({ apiKey });

    // --- 1차: 제목만 보고 후보 추리기 -------------------------------------
    const r1: any = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: [
        { type: "text", text: RULES1 },
        // 조 목록은 매번 똑같으므로 캐시에 재운다. 5분 안에 다시 물으면 1/10 값.
        { type: "text", text: `<조 목록>\n${catalog}</조 목록>`,
          cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `민원 질문:\n${question}` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA1 } },
    } as any);
    const p1 = readJson(r1);
    if (!p1) return json({ error: "AI 답을 읽지 못했어요. 다시 한 번 눌러주세요." });

    const cand = (p1.ns || [])
      .map((n: number) => index[n] ? { n, ...index[n] } : null)
      .filter(Boolean).slice(0, SHORTLIST);

    if (!cand.length) {
      return json({ picks: [], note: String(p1.note || "관련 조문을 찾지 못했어요."),
                    arts: arts.length, truncated: arts.length >= MAX_ARTS,
                    krw: Math.round(usdOf(r1.usage) * KRW) });
    }

    // --- 후보의 본문을 읽어 온다 (2차에게 먹이고, 화면 미리보기로도 쓴다) ---
    const { data: bodies } = await db.from("law_articles")
      .select("id,content").in("id", cand.map((c: any) => c.id));
    const bodyOf = new Map((bodies || []).map((b: any) => [b.id, String(b.content || "")]));
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();

    // 예산 안에서 위(관련 있어 보이는 것)부터 채운다. 다 못 넣으면 뒤쪽은 버린다 —
    // 억지로 잘라 넣느니 「몇 개까지 읽었다」를 화면에 알리는 편이 낫다.
    let sheet = "", used = 0, readCount = 0;
    for (const c of cand) {
      const full = flat(bodyOf.get(c.id) || "");
      const body = full.length > ART_MAX ? full.slice(0, ART_MAX) + " …(뒤가 잘림)" : full;
      if (used + body.length > TOTAL_MAX && readCount > 0) break;
      sheet += `\n[${c.n}] ${c.law}  ${c.label}\n${body}\n`;
      used += body.length; readCount++;
    }

    // --- 2차: 본문을 읽고 최종으로 추리기 ---------------------------------
    const r2: any = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: RULES2 }],
      messages: [{ role: "user", content: `민원 질문:\n${question}\n\n<조문>${sheet}</조문>` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA2 } },
    } as any);
    const p2 = readJson(r2);
    if (!p2) return json({ error: "AI 답을 읽지 못했어요. 다시 한 번 눌러주세요." });

    // --- 등급 계산 --------------------------------------------------------
    // 세 가지 판단에 값을 매겨 더한다. AI 에게 「0~100 중 알아서」를 시키면
    // 죄다 90점대가 나오고 87 과 84 의 차이에 아무 뜻이 없다.
    // 합계는 화면에 숫자로 내보내지 않는다 — 잰 값이 아닌데 잰 것처럼 보인다.
    // 다섯 등급으로 바꿔 보여주고, 합계는 같은 등급 안의 순서에만 쓴다.
    const W_DIRECT: Record<string, number> = { "답이 여기": 45, "조건이 여기": 30, "곁가지": 12 };
    const W_NEED:   Record<string, number> = { "인용 필수": 30, "있으면 좋음": 18, "없어도 됨": 6 };
    const W_SURE:   Record<string, number> = { "근거 찾음": 25, "비슷한 대목만": 15, "못 찾음": 5 };
    // 위계 가산(최대 8점)만큼 눈금도 올려 잡는다 — 안 그러면 법률이 죄다 「매우 높음」이 된다
    const gradeOf = (v: number) =>
      v >= 89 ? "매우 높음" : v >= 74 ? "높음" : v >= 58 ? "중간" : v >= 43 ? "낮음" : "매우 낮음";

    let picks = (p2.picks || []).slice(0, MAX_PICKS)
      .map((p: any) => {
        const hit = index[p.n];
        if (!hit) return null;   // 없는 번호를 지어냈으면 조용히 버린다
        // 목록에 없는 말이 오면 가운데 값으로 본다 (등급이 튀지 않게)
        const direct = W_DIRECT[p.direct] != null ? p.direct : "조건이 여기";
        const need   = W_NEED[p.need]     != null ? p.need   : "있으면 좋음";
        const sure   = W_SURE[p.sure]     != null ? p.sure   : "비슷한 대목만";
        const kind   = lawKind.get(hit.law_id) || { t:"그 밖", w:0 };
        // 상위법 가산 — 같은 판단이면 법률이 지침서보다 위에 선다
        const score  = W_DIRECT[direct] + W_NEED[need] + W_SURE[sure] + kind.w;
        const t = flat(bodyOf.get(hit.id) || "");
        return { id: hit.id, lawId: hit.law_id, law: hit.law, label: hit.label,
                 direct, need, sure, kind: kind.t, grade: gradeOf(score), score,
                 head: t.length > PREVIEW ? t.slice(0, PREVIEW) + "…" : t,
                 why: String(p.why || "") };
      })
      .filter(Boolean);
    // AI가 순서를 흐트러뜨려도 화면에서는 늘 관련 높은 것부터 선다.
    picks = picks
      .map((p: any, i: number) => ({ p, i }))
      .sort((a: any, b: any) => (b.p.score - a.p.score) || (a.i - b.i))
      .map((x: any) => x.p);

    return json({
      picks,
      note: String(p2.note || p1.note || ""),
      arts: arts.length,
      looked: readCount,
      // 조문이 상한에 닿으면 뒤쪽 법령을 아예 못 봤다는 뜻이라 알려준다
      truncated: arts.length >= MAX_ARTS,
      krw: Math.round((usdOf(r1.usage) + usdOf(r2.usage)) * KRW),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
