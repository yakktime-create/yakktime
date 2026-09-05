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

// **npm 꾸러미를 안 쓴다.** 처음엔 SDK 두 개를 npm: 으로 불러왔는데, 함수가
// 깨어날 때 그걸 내려받다 시간이 넘어 WORKER_ERROR(500)만 났다. 브라우저에는
// 「Failed to send a request to the Edge Function」으로 보인다 — 프리플라이트
// (OPTIONS)까지 500이 되기 때문이다.
// 하는 일이 「HTTP 두 번 부르기」뿐이라 fetch 로 직접 부른다. 받아올 것이
// 없으니 깨어나는 데 시간이 안 걸리고, 남의 판이 바뀌어 깨질 일도 없다.

const MODEL      = "claude-haiku-4-5-20251001";
const MAX_ARTS   = 3000;   // 조 목록 상한 — 토큰이 무한정 늘지 않게
const SHORTLIST  = 20;     // 1차에서 추릴 후보 수
const MAX_PICKS  = 10;     // 2차에서 남길 최종 수
// 2차에게는 조문을 통째로 읽힌다. 다만 정의 조항이나 별표가 붙은 조는
// 수만 자에 이르므로 한 조와 전체에 각각 뚜껑을 씌운다. 없으면 한 번에
// 몇천 원이 나갈 수 있다.
const ART_MAX    = 2800;   // 조 하나에서 읽을 최대 글자 (후보를 더 많이 읽히려고 줄임)
const TOTAL_MAX  = 60000;  // 2차에 넣을 글자 총량
const PREVIEW    = 180;    // 화면에 보여줄 미리보기
// 1차는 **조 제목만** 본다. 그래서 제목에 그 말이 없는 상위법이 통째로 빠진다 —
// 「실태조사 생략 기준」을 물었더니 지침서 둘만 나오고 「의약품 등의 안전에 관한
// 규칙」이 안 딸려왔다. 규칙의 조 제목은 「제4조(제조판매·수입 품목의 허가 신청)」이라
// 「실태조사」라는 말이 아예 없기 때문이다.
// 그래서 1차에게 **법령에 실제로 쓰일 낱말**을 같이 내게 하고, 그 낱말로
// 상위법 본문을 뒤져 후보에 보탠다. AI 를 한 번 더 부르지 않으므로 값이 안 는다.
const WORDS_MAX  = 6;      // 1차가 낼 낱말 수
const BOOST_MAX  = 12;     // 낱말로 보탤 조 수 — 양이 터지지 않게
const PER_WORD   = 1;      // 낱말 하나가 **위계 층마다** 챙겨 오는 조 수
// **순서를 안 정하고 60줄만 가져오면 뽑히는 조가 그때그때 달라진다.**
// 「제품명」이 100곳에서 걸리는데 그중 60개만 임의로 와서, 정작 답인 규칙 제11조가
// 밖으로 밀렸다. 차례를 정하고 넉넉히 가져온다.
const BOOST_ROWS = 300;    // 낱말 하나가 걸러 올 조 수 상한
const KRW        = 1400;   // 원/달러

// 법 위계 — 이름만 보고 가른다. 같은 내용이면 상위법이 더 센 근거다.
// 다만 실제 답은 고시·규칙에 적힌 경우가 많으므로 가중치는 작게 준다.
// 「답이 여기 있나」(45점)를 뒤집을 만큼 주면 엉뚱한 조를 위로 올리게 된다.
type Kind = { n:number; t:string; w:number };
const K_LAW:  Kind = { n:0, t:"법률",       w:8 };
const K_DEC:  Kind = { n:1, t:"시행령",     w:6 };
const K_RULE: Kind = { n:2, t:"시행규칙",   w:5 };
const K_NOTI: Kind = { n:3, t:"고시",       w:3 };
const K_GUID: Kind = { n:4, t:"지침·안내서", w:0 };
const K_INTL: Kind = { n:5, t:"국제기준",    w:0 };   // PIC/S·ICH·WHO — 우리 법령이 아니다
const K_ETC:  Kind = { n:6, t:"그 밖",      w:0 };
function kindOf(name: string) {
  const raw = String(name || "");
  // 꼬리표를 뗀다. 「약사법(법률)(제21109호)」 「…운영지침[공무원 지침서]」
  const s = raw.replace(/[\[(（].*$/, "").replace(/\.pdf$/i, "").trim();
  // 지침서는 이름 어디에 적혀 있어도 지침서다(꼬리표 안에 있는 일이 많다)
  // 국제기준을 먼저 본다 — 「PIC/S GMP 가이드」가 「가이드」로 지침에 걸리면 안 된다
  if (/PIC\/?S|\bICH\b|\bWHO\b|\bUSP\b|\bEP\b|\bJP\b|\bISO\b|EU\s*GMP|\bFDA\b/i.test(raw)) return K_INTL;
  if (/지침|안내서|가이드|해설|매뉴얼|업무처리방안|운영방안|질의응답/.test(raw)) return K_GUID;
  if (/절차$|방안$/.test(s)) return K_GUID;
  // 나머지는 **이름 끝**으로 가른다 — 「약사법」 「…에 관한 법률」 「…규칙」 「…규정」
  if (/규칙$/.test(s)) return K_RULE;
  if (/법률$|법$/.test(s)) return K_LAW;
  if (/시행령$|령$/.test(s)) return K_DEC;
  if (/고시|훈령|예규|공고|규정$|기준$|약전/.test(raw)) return K_NOTI;
  return K_ETC;
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

// ---- 표 읽기 (PostgREST 를 그냥 HTTP 로 부른다) ------------------------
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
async function pg(query: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${query}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const t = await r.text();
  if (!r.ok) return { data: null as any, error: { message: t.slice(0, 300) } };
  try { return { data: JSON.parse(t), error: null }; }
  catch (_) { return { data: null as any, error: { message: "읽은 값이 JSON 이 아니에요" } }; }
}
// PostgREST 는 한 번에 **1,000줄**까지만 준다. limit 을 3000 으로 걸어도 소용없다.
// 실제로 조문 1,289개 중 972개만 AI 에게 갔고, 뒤쪽 법령은 아예 안 보였다.
// (그래서 낱말로 찾아낸 조문도 「목록에 없는 번호」라 버려져 보강이 0이 됐다.)
// 나눠서 끝까지 가져온다. offset 을 쓰므로 order 가 반드시 붙어 있어야 한다.
const PG_PAGE = 1000;
async function pgAll(query: string, cap: number) {
  let out: any[] = [];
  for (let off = 0; off < cap; off += PG_PAGE) {
    const r = await pg(query + "&limit=" + PG_PAGE + "&offset=" + off);
    if (r.error) return r;
    const rows = r.data || [];
    out = out.concat(rows);
    if (rows.length < PG_PAGE) break;
  }
  return { data: out, error: null };
}
// id 목록 조건. 따옴표로 묶어야 값에 쉼표·괄호가 있어도 안 깨진다.
const inList = (xs: any[]) =>
  "in.(" + xs.map((x) => '"' + String(x).replace(/"/g, "") + '"').join(",") + ")";

// ---- Claude 부르기 ----------------------------------------------------
async function claude(apiKey: string, body: unknown) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) throw new Error(j?.error?.message || `Claude 오류 ${r.status}: ${t.slice(0, 200)}`);
  return j;
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
- note 에는 어느 법령을 훑었는지, 빠진 게 있어 보이면 무엇인지 한두 문장.

words 에는 이 질문의 답이 적혀 있을 조문을 **본문에서** 찾을 낱말을 낸다.
민원인의 말이 아니라 <b>법령에 실제로 쓰일 말</b>로 바꿔 적는다.
  「실태조사 생략」 → 실태조사 · 생략 · 면제 · 갈음
  「안 가도 되나」  → 현장조사 · 서류평가
- 두 글자 이상, 많아야 ${WORDS_MAX}개. 조사·어미를 붙이지 않는다(「실태조사를」 ✕).
- 아무 조문에나 나오는 흔한 말은 넣지 않는다(「의약품」「제조소」「경우」).
- <b>되도록 길고 드문 말을 고른다.</b> 「제품명」보다 「제품명칭」, 「생략」보다
  「생략기간」처럼. 짧은 말은 백 곳에서 걸려 아무것도 못 가린다. 다만 확신이
  없으면 긴 말과 짧은 말을 **둘 다** 넣는다.`;

const SCHEMA1 = {
  type: "object",
  properties: {
    ns:    { type: "array", items: { type: "integer" } },
    words: { type: "array", items: { type: "string" } },
    note:  { type: "string" },
  },
  required: ["ns", "words", "note"],
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
    "답 확인"   이 조를 펴면 질문의 답이 나온다.
    "조건 확인" 답 자체는 아니지만 그 답의 조건·범위·수량·기준이 여기 있다.
    "배경 확인" 낱말 뜻풀이(정의)나 신청 절차·벌칙만 있고 답은 없다.

  need — 민원 답변서를 쓸 때 이 조를 인용해야 하나?
    "인용 필수"   이 조를 안 적으면 답변이 성립하지 않는다.
    "있으면 좋음" 적어 두면 답변이 튼튼해진다.
    "없어도 됨"   안 적어도 답변은 된다.

  sure — 본문에서 근거를 찾았나?
    "근거 찾음"      준 본문 안에 근거가 실제로 보인다. 어느 대목인지 짚을 수 있다.
                     <b>「…있을 것으로 보입니다」처럼 짐작하면 이것이 아니다.</b>
    "비슷한 대목만"  관련 있어 보이는 말은 있으나 딱 떨어지는 대목을 짚기는 어렵다.
    "못 찾음"        본문에서는 못 찾았고 제목으로 짐작한다.

  세 가지를 정직하게 고른다. 다 최고로 몰면 순서를 매긴 뜻이 없다.

- quote 에는 <b>본문에서 그대로 옮긴 한 문장</b>을 적는다. 한 글자도 바꾸지 않는다.
  옮길 문장이 없으면 빈 문자열("")로 둔다. <b>지어내면 그 조는 버려진다</b> —
  이쪽에서 본문과 대조해 실제로 있는 문장인지 검사한다.
- <b>본문을 이미 받았으면 짐작하지 않는다.</b> 읽고도 근거가 없으면 그 조는 아예 빼라.
  「…있을 것으로 보입니다」는 본문을 안 읽었다는 뜻이다.
- why 에는 왜 그 조인지 한 문장. <b>근거를 찾았으면 그 대목을 짚어 적는다</b>
  (예: 「1회 1개 품목 포장단위로 판매할 것」이 여기 있습니다).
  본문에서 못 찾았으면 그렇다고 적는다.
- note 는 한두 문장. 무엇을 보고 골랐는지, 빠진 게 있어 보이면 무엇인지.
- <b>「상위법은 없다」고 단정하지 않는다.</b> 후보에 안 보이는 것은 못 찾은 것일 뿐
  없는 것이 아니다. 그런 때는 「이 후보에서는 못 찾았다」고 적는다.
- <b>번호를 글에 적지 않는다.</b> 목록의 번호(509, 835 …)는 이쪽에서 붙인 것이라
  읽는 사람에게는 아무 뜻이 없다. why·note 에는 <b>조 이름</b>으로 적는다
  (「바이오의약품 사전 GMP 평가 지침 8쪽」처럼).
- <b>지침서가 근거로 든 상위법 조항이 후보에 있으면 함께 고른다.</b> 지침서는
  「…할 수 있다」는 재량을 언제 쓸지 정할 뿐이고, 그 재량의 근거는 법률·규칙에 있다.
  민원 답변에는 둘 다 적어야 한다 (예: 생략 기준은 지침, 실태조사 권한은
  「의약품 등의 안전에 관한 규칙」[별표 1] 15.2).
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
          direct: { type: "string", enum: ["답 확인", "조건 확인", "배경 확인"] },
          need:   { type: "string", enum: ["인용 필수", "있으면 좋음", "없어도 됨"] },
          sure:   { type: "string", enum: ["근거 찾음", "비슷한 대목만", "못 찾음"] },
          why:    { type: "string" },
          quote:  { type: "string" },
        },
        required: ["n", "direct", "need", "sure", "why", "quote"],
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

    if (!SB_URL || !SB_KEY) return json({ error: "표를 읽을 열쇠가 없어요. 함수를 다시 배포해 주세요." });

    // --- 조 목록 만들기 --------------------------------------------------
    const { data: laws, error: le } = await pg(
      "laws?select=id,name" + (only ? "&id=" + encodeURIComponent(inList(only)) : ""));
    if (le) return json({ error: "법령 목록을 못 읽었어요: " + le.message });
    const lawName = new Map<string, string>((laws || []).map((l: any) => [String(l.id), String(l.name)]));
    const lawKind = new Map<string, Kind>((laws || []).map((l: any) => [String(l.id), kindOf(l.name)]));

    const { data: arts, error: ae } = await pgAll(
      "law_articles?select=id,law_id,seq,label&order=law_id.asc,seq.asc"
      + (only ? "&law_id=" + encodeURIComponent(inList(only)) : ""), MAX_ARTS);
    if (ae) return json({ error: "조문을 못 읽었어요: " + ae.message });
    if (!arts || !arts.length) {
      return json({ error: only
        ? "고른 법령에 조문이 없어요. 「조문 만들기」를 먼저 하거나 범위를 넓혀주세요."
        : "아직 조문으로 쪼개진 법령이 없어요. 법령 탭에서 「조문 만들기」를 먼저 해주세요." });
    }

    // 법제처 PDF는 곧 시행될 개정 조문을 현행 조문 뒤에 한 번 더 싣는다. 그 조문은
    // 라벨에 「· 시행 2026. 10. 8.」이 붙어 있다. 답변의 근거는 지금 적용되는
    // 조문이어야 하므로, 아직 안 온 것은 AI 에게 아예 보내지 않는다.
    // (화면에서는 그대로 보여준다 — 「10월 8일부터 이렇게 바뀝니다」를 안내해야
    //  할 때가 있기 때문이다.)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const isFuture = (label: string) => {
      const m = /·\s*시행\s*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/.exec(String(label || ""));
      return !!m && (m[1] + ("0" + m[2]).slice(-2) + ("0" + m[3]).slice(-2)) > today;
    };
    const live = arts.filter((a: any) => !isFuture(a.label));
    const skipped = arts.length - live.length;

    const index: any[] = [];
    let catalog = "", curLaw = "";
    live.forEach((a: any, i: number) => {
      const nm = lawName.get(a.law_id) || "이름 없는 법령";
      if (nm !== curLaw) { curLaw = nm; catalog += `\n### ${nm}\n`; }
      const n = i + 1;
      catalog += `${n} ${a.label}\n`;
      index[n] = { id: a.id, law_id: a.law_id, law: nm, label: a.label };
    });

    // --- 1차: 제목만 보고 후보 추리기 -------------------------------------
    const r1: any = await claude(apiKey, {
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
    });
    const p1 = readJson(r1);
    if (!p1) return json({ error: "AI 답을 읽지 못했어요. 다시 한 번 눌러주세요." });

    let cand = (p1.ns || [])
      .map((n: number) => index[n] ? { n, ...index[n] } : null)
      .filter(Boolean).slice(0, SHORTLIST);

    // --- 낱말로 후보를 보탠다 ---------------------------------------------
    // 처음엔 상위법만 뒤졌다. 「지침서는 제목만 봐도 걸린다」고 봤기 때문인데,
    // 1차가 엉뚱한 제목에 꽂히면 **지침서도 통째로 놓친다.** 실제로 그랬다 —
    // 답은 「바이오의약품 사전 GMP 평가 지침」 붙임 1에 있는데 1차가 「적합판정
    // 제외 대상」 쪽으로 새서, 상위법에만 친 그물로는 건질 수가 없었다.
    // 그물은 **전체**에 친다. 대신 낱말이 여러 개 겹치는 조부터 몇 개만.
    const upperIds = (laws || []).map((l: any) => l.id);
    const words: string[] = (p1.words || [])
      .map((w: any) => String(w || "").trim())
      .filter((w: string) => w.length >= 2 && w.length <= 20)
      .slice(0, WORDS_MAX);
    let boosted = 0;
    const dbg: Record<string, unknown> = {};
    if (upperIds.length && words.length) {
      // **id 는 숫자다**(law_articles.id = 32457). 한쪽만 String() 으로 바꿔 비교하는
      // 바람에 낱말로 찾은 193개가 전부 「목록에 없는 조문」으로 버려졌다.
      // 열쇠는 한 가지 꼴로 통일해서 쓴다.
      const have = new Set(cand.map((c: any) => String(c.id)));
      const nOf = new Map<string, number>(live.map((a: any, i: number) => [String(a.id), i + 1]));
      // 낱말마다 「어느 조에서 걸렸나」를 따로 들고 있는다.
      const score = new Map<string, number>();
      const perWord: string[][] = [];
      for (const w of words) {
        const { data: rows } = await pg("law_articles?select=id&order=law_id.asc,seq.asc&limit=" + BOOST_ROWS
          + "&law_id=" + encodeURIComponent(inList(upperIds))
          + "&content=" + encodeURIComponent("ilike.*" + w.replace(/[*,()]/g, "") + "*"));
        const ids: string[] = [];
        (rows || []).forEach((r: any) => {
          const k = String(r.id);
          score.set(k, (score.get(k) || 0) + 1);
          ids.push(k);
        });
        perWord.push(ids);
      }
      // **「둘 이상 겹칠 때만」이 정답을 떨어뜨렸다.** 「제품명 부적합 요건」을
      // 물었을 때 답은 규칙 제11조인데, 그 조에는 「제품명」 하나만 있어서 빠졌다.
      // AI 가 내는 낱말은 대개 흔한 말(제품명 100곳·부적합 75곳·요건 132곳)이라
      // 겹침만으로는 못 고른다.
      // 그래서 **낱말마다 위계 높은 것 몇 개씩**을 따로 챙기고, 겹치는 것을 위에 둔다.
      const rank = (id: string) => lawKind.get(index[nOf.get(id)!].law_id)?.n ?? 9;
      const ok = (id: string) => !have.has(id) && nOf.has(id);
      const pick: string[] = [];
      const seen = new Set<string>();
      const push = (id: string) => { if (!seen.has(id)) { seen.add(id); pick.push(id); } };
      // ① 여러 낱말이 겹치는 조부터 — **다만 절반까지만.** 다 넣으면 열두 자리를
      //    겹침만으로 채워, 아래 ②의 층별 몫이 잘려 나간다(규칙 제11조가 그랬다).
      const over = [...score.entries()].filter(([id, c]) => ok(id) && c >= 2)
        .sort((a, b) => (b[1] - a[1]) || (rank(a[0]) - rank(b[0])))
        .map(([id]) => id);
      over.slice(0, Math.floor(BOOST_MAX / 2)).forEach(push);
      // ② 낱말마다 **위계 층별로 하나씩** — 위계 순으로만 뽑으면 법률이 자리를
      //    다 차지해 정작 답이 있는 규칙·고시가 밀린다. 「제품명 부적합 요건」에서
      //    규칙 제11조(제품명칭)가 그렇게 밀렸다.
      perWord.forEach((ids) => {
        const bag = ids.filter(ok);
        for (let lv = 0; lv <= 5; lv++) {
          const one = bag.filter((id) => rank(id) === lv).slice(0, PER_WORD);
          one.forEach(push);
        }
      });
      // ③ 자리가 남으면 겹침 나머지로 채운다
      over.forEach(push);
      const extra = pick.slice(0, BOOST_MAX)
        .map((id) => { const n = nOf.get(id)!; return { n, ...index[n] }; });
      boosted = extra.length;
      dbg.upper = upperIds.length; dbg.words = words.length;
      dbg.hit = score.size; dbg.two = [...score.values()].filter((c) => c >= 2).length;
      dbg.have = have.size; dbg.inIndex = [...score.keys()].filter((id) => nOf.has(id)).length;
      // 예산은 뒤에서부터 잘리므로 보탠 것을 앞쪽에 끼워 넣는다 —
      // 뒤에 붙이면 정작 보태 놓고 못 읽힌다.
      cand = cand.slice(0, 10).concat(extra, cand.slice(10));
    }

    if (!cand.length) {
      return json({ picks: [], note: String(p1.note || "관련 조문을 찾지 못했어요."),
                    arts: live.length, skipped, truncated: arts.length >= MAX_ARTS,
                    krw: Math.round(usdOf(r1.usage) * KRW) });
    }

    // --- 후보의 본문을 읽어 온다 (2차에게 먹이고, 화면 미리보기로도 쓴다) ---
    const { data: bodies } = await pg("law_articles?select=id,content&limit=" + PG_PAGE
      + "&id=" + encodeURIComponent(inList(cand.map((c: any) => c.id))));
    const bodyOf = new Map<string, string>((bodies || []).map((b: any) => [String(b.id), String(b.content || "")]));
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();

    // 예산 안에서 위(관련 있어 보이는 것)부터 채운다. 다 못 넣으면 뒤쪽은 버린다 —
    // 억지로 잘라 넣느니 「몇 개까지 읽었다」를 화면에 알리는 편이 낫다.
    let sheet = "", used = 0, readCount = 0;
    for (const c of cand) {
      // id 는 숫자다. 열쇠를 String 으로 통일해 두었으니 찾을 때도 String 으로.
      // 이걸 안 맞춰서 2차 AI 가 **본문을 하나도 못 받고** 제목만 보고 답했다.
      const full = flat(bodyOf.get(String(c.id)) || "");
      const body = full.length > ART_MAX ? full.slice(0, ART_MAX) + " …(뒤가 잘림)" : full;
      if (used + body.length > TOTAL_MAX && readCount > 0) break;
      sheet += `\n[${c.n}] ${c.law}  ${c.label}\n${body}\n`;
      used += body.length; readCount++;
    }

    if (!sheet.trim()) return json({ error: "조문 본문을 못 읽었어요. 잠시 뒤 다시 눌러주세요." });

    // --- 2차: 본문을 읽고 최종으로 추리기 ---------------------------------
    const r2: any = await claude(apiKey, {
      model: MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: RULES2 }],
      messages: [{ role: "user", content: `민원 질문:\n${question}\n\n<조문>${sheet}</조문>` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA2 } },
    });
    const p2 = readJson(r2);
    if (!p2) return json({ error: "AI 답을 읽지 못했어요. 다시 한 번 눌러주세요." });

    // --- 등급 계산 --------------------------------------------------------
    // 세 가지 판단에 값을 매겨 더한다. AI 에게 「0~100 중 알아서」를 시키면
    // 죄다 90점대가 나오고 87 과 84 의 차이에 아무 뜻이 없다.
    // 합계는 화면에 숫자로 내보내지 않는다 — 잰 값이 아닌데 잰 것처럼 보인다.
    // 다섯 등급으로 바꿔 보여주고, 합계는 같은 등급 안의 순서에만 쓴다.
    // 낱말은 **뜻을 알려면 설명을 읽어야 하면 실패한 낱말**이다.
    // 「곁가지」→「말뜻·절차만」→「배경 확인」으로 두 번 갈았다. 배지(「인용 필수」)와
    // 결을 맞춰 셋 다 「…확인」으로 끝맺는다 — 읽으면 할 일이 보인다.
    // 옛 이름으로 오는 답이 있어도 점수가 튀지 않게 함께 받아 둔다.
    const W_DIRECT: Record<string, number> = {
      "답 확인": 45, "조건 확인": 30, "배경 확인": 12,
      "답이 여기": 45, "조건이 여기": 30, "말뜻·절차만": 12, "곁가지": 12,
    };
    const W_NEED:   Record<string, number> = { "인용 필수": 30, "있으면 좋음": 18, "없어도 됨": 6 };
    const W_SURE:   Record<string, number> = { "근거 찾음": 25, "비슷한 대목만": 15, "못 찾음": 5 };
    // 위계 가산(최대 8점)만큼 눈금도 올려 잡는다 — 안 그러면 법률이 죄다 「매우 높음」이 된다
    const gradeOf = (v: number) =>
      v >= 89 ? "매우 높음" : v >= 74 ? "높음" : v >= 58 ? "중간" : v >= 43 ? "낮음" : "매우 낮음";

    // AI 가 그래도 번호를 흘리면 이쪽에서 조 이름으로 바꿔 준다. 못 바꾸면 지운다.
    // 「[509]」 뿐 아니라 「제509조」 「509-511조」로도 샌다. 목록 번호는 세 자리를
    // 넘고 이 문서들의 진짜 조 번호는 백 번대를 넘지 않으므로 그것으로 가른다.
    const nameOf = (t: string) => String(t || "")
      .replace(/\[(\d{1,4})\]/g, (_m, d) => index[+d] ? "「" + index[+d].label + "」" : "")
      .replace(/(?:제\s*)?(\d{3,4})(?:\s*[-~–]\s*\d{3,4})?\s*조/g,
        (m, d) => (+d >= 100 && index[+d]) ? "「" + index[+d].label + "」" : m)
      .replace(/\s{2,}/g, " ").trim();

    let picks = (p2.picks || []).slice(0, MAX_PICKS)
      .map((p: any) => {
        const hit = index[p.n];
        if (!hit) return null;   // 없는 번호를 지어냈으면 조용히 버린다
        // 목록에 없는 말이 오면 가운데 값으로 본다 (등급이 튀지 않게)
        const direct = W_DIRECT[p.direct] != null ? p.direct : "조건 확인";
        const need   = W_NEED[p.need]     != null ? p.need   : "있으면 좋음";
        let   sure   = W_SURE[p.sure]     != null ? p.sure   : "비슷한 대목만";
        let   need2  = need;
        // **짐작해 놓고 「근거 찾음」이라 붙이는 일이 있다.** 「있을 수 있습니다」
        // 「가능성입니다」라고 써 놓고 근거를 찾았다고 하면 그건 거짓말이다.
        // 말로 드러난 짐작은 등급에서 한 칸 내린다.
        if (/있을 수 있|가능성|것으로 보|것으로 예상|추정|일 것/.test(String(p.why || ""))) {
          if (sure === "근거 찾음") sure = "비슷한 대목만";
          if (need2 === "인용 필수") need2 = "있으면 좋음";
        }
        const kind   = lawKind.get(hit.law_id) || { t:"그 밖", w:0 };
        // 상위법 가산 — 같은 판단이면 법률이 지침서보다 위에 선다
        const score  = W_DIRECT[direct] + W_NEED[need2] + W_SURE[sure] + kind.w;
        const t = flat(bodyOf.get(String(hit.id)) || "");
        // **옮겼다는 문장이 본문에 실제로 있는지 대조한다.** 지어낸 근거를
        // 「근거 찾음」으로 통과시키면 민원 답변에 없는 말이 들어간다.
        // 빈칸만 다를 수 있으므로 빈칸을 지우고 견준다.
        const bare = (x: string) => x.replace(/\s+/g, "");
        const qraw = String(p.quote || "").trim();
        const qok  = qraw.length >= 10 && bare(t).indexOf(bare(qraw)) >= 0;
        if (!qok && sure === "근거 찾음") sure = "비슷한 대목만";
        return { id: hit.id, lawId: hit.law_id, law: hit.law, label: hit.label,
                 direct, need: need2, sure, kind: kind.t, grade: gradeOf(score), score,
                 // 미리보기는 **근거 문장**이 낫다 — 본문 앞 180자는 대개
                 // 「붙임 1 제출자료 요건 ※…」처럼 아무 말도 안 해 준다.
                 quote: qok ? qraw : "",
                 head: qok ? qraw : (t.length > PREVIEW ? t.slice(0, PREVIEW) + "…" : t),
                 why: nameOf(p.why) };
      })
      .filter(Boolean);
    // AI가 순서를 흐트러뜨려도 화면에서는 늘 관련 높은 것부터 선다.
    picks = picks
      .map((p: any, i: number) => ({ p, i }))
      .sort((a: any, b: any) => (b.p.score - a.p.score) || (a.i - b.i))
      .map((x: any) => x.p);

    // **위계 층마다 적어도 하나는 남긴다.** 민원 답변은 상위법부터 인용해야 하는데,
    // 점수 순으로만 자르면 법률·규칙이 통째로 빠지고 지침서만 남는 일이 생긴다.
    // 층 대표를 먼저 세우고, 남은 자리를 점수 순으로 채운다.
    const kindN = (p: any) => {
      for (const k of [K_LAW, K_DEC, K_RULE, K_NOTI, K_GUID, K_INTL, K_ETC]) if (k.t === p.kind) return k.n;
      return 9;
    };
    const rep: any[] = [], rest: any[] = [], tookTier = new Set<number>();
    picks.forEach((p: any) => {
      const n = kindN(p);
      if (!tookTier.has(n)) { tookTier.add(n); rep.push(p); } else rest.push(p);
    });
    picks = rep.concat(rest).slice(0, MAX_PICKS)
      .map((p: any, i: number) => ({ p, i }))
      .sort((a: any, b: any) => (kindN(a.p) - kindN(b.p)) || (b.p.score - a.p.score) || (a.i - b.i))
      .map((x: any) => x.p);

    return json({
      picks,
      note: nameOf(p2.note || p1.note || ""),
      arts: live.length,
      // 아직 시행 전이라 빼고 본 조문 수 — 화면에서 알려 준다
      skipped,
      looked: readCount,
      // 조문이 상한에 닿으면 뒤쪽 법령을 아예 못 봤다는 뜻이라 알려준다
      truncated: arts.length >= MAX_ARTS,
      // 제목에는 안 드러나서 낱말로 찾아 보탠 상위법 조문 수
      boosted,
      words,
      dbg,
      krw: Math.round((usdOf(r1.usage) + usdOf(r2.usage)) * KRW),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
