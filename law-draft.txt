// =====================================================================
//  law-draft — 고른 조문으로 민원 답변 초안을 만든다.
//
//  **AI 는 답변을 쓰지 않는다.** 두 가지만 만든다.
//    summary  민원의 요지 한 문장  (「…에 관한 것으로 이해되며」의 빈칸)
//    help     실무 참고 한두 문장   (mode 가 "help" 일 때만)
//    topic    「'○○'에 대한 질의로 이해됩니다」의 빈칸 — 4~16자 명사구 (예: 반창고 품목허가)
//    title    「민원 답변」 목록에 보일 짧은 제목 — 핵심 낱말 두셋을 「·」로 이은 것 (8~24자)
//    keys     근거 조문마다 「민원에 답하는 핵심 문장」 하나 — **원문에서 그대로 옮긴 것만**.
//             서버가 원문과 대조해 없으면 빈 문자열로 만든다. 브라우저는 빈 것은 조문 전체를 넣는다.
//
//  조문 원문은 AI 를 거치지 않는다. 브라우저가 이미 갖고 있는 글자를
//  그대로 끼워 넣는다. 그래서 **AI 가 법을 고쳐 쓸 자리가 없다.**
//  형식(1./가. · 머리말 · 맺음말)도 브라우저가 붙인다 — 형식을 바꿀 때마다
//  AI 를 다시 부르면 돈만 나가고 결과는 같다.
//
//  Supabase → Edge Functions → law-draft 에 통째로 붙여넣고 Deploy.
//  비밀값(Secrets)의 ANTHROPIC_API_KEY 를 그대로 씁니다 (law-pick 과 공용).
// =====================================================================

// npm 꾸러미를 안 쓴다 — law-pick 에서 겪은 그대로, 깨어날 때 내려받다
// 시간이 넘어 WORKER_ERROR(500)만 난다. fetch 로 직접 부른다.

// ---- 어느 모델로 부를까 -----------------------------------------------
// **초안은 Opus 5 다.** 조문 찾기(law-pick)는 Haiku 인데 여기만 Opus 인 이유:
//  · 여기서 AI 가 내는 건 요지 한 문장과 참고 두어 문장뿐이라 **4원 → 23원**,
//    한 달에 500원도 안 든다. 조문 찾기는 같은 교체가 월 10만원이다.
//  · 실측(2026-09-08, 위탁제조판매업신고 민원)에서 Opus 는 민원인이 실제로
//    물은 것을 요지에 그대로 옮기고, 참고에 **조 번호를 짚어** 적었다.
//  · **거부 위험이 없다.** 조문 원문을 읽고 두 문장 쓰는 일이라, law-pick 을
//    Opus 로 올렸을 때 보툴리눔 질문이 막히던 것과 다르다.
// 요청 본문으로 모델을 고르게 두지 않는다(값이 튄다). 바꾸려면 CFG 한 줄.
type Cfg = { id: string; in: number; out: number; effort?: string; room: number };
const MODELS: Record<string, Cfg> = {
  haiku: { id: "claude-haiku-4-5-20251001", in: 1.0, out:  5.0, room: 1 },
  // Opus 5 는 생각하기가 기본으로 켜져 있고 max_tokens 가 생각한 양까지 합쳐
  // 자르므로 자리를 넉넉히 준다. effort 는 Opus 일 때만 붙인다(Haiku 는 오류).
  opus:  { id: "claude-opus-5",             in: 5.0, out: 25.0, effort: "low", room: 6 },
};
const CFG: Cfg = MODELS.opus;
const ART_MAX   = 3000;    // 조 하나에서 AI 에게 읽힐 최대 글자
const TOTAL_MAX = 40000;   // AI 에게 넣을 글자 총량
const Q_MAX     = 4000;    // 민원 내용 상한
const KRW       = 1400;    // 원/달러
// 값은 모델마다 다르다 — 아래 usd() 가 그때그때 받는다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// **사람에게 보이는 오류는 전부 HTTP 200 + {error} 로 돌려준다.**
// supabase-js 는 200 이 아닌 응답의 본문을 넘겨주지 않아서, 그러지 않으면
// 화면에 「Edge Function 오류」만 뜨고 무엇이 잘못됐는지 알 길이 없다.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function claude(apiKey: string, body: unknown) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Anthropic ${r.status}`);
  return j;
}

const HEAD = `너는 대한민국 식품의약품안전처 공무원이 민원 답변을 쓰는 것을 돕는 도구다.
답변 본문은 네가 쓰지 않는다. 조문 원문은 사람이 그대로 붙여 넣는다.
너는 아래 다섯 가지만 만든다.`;

const RULES = `${HEAD}

[1] summary — 민원의 요지를 **한 문장**으로 줄인 명사구.
    · 「귀하께서 주신 내용은 ___(으)로 이해되며」의 빈칸에 그대로 들어간다.
    · 그러므로 **「…에 관한 것」으로 끝나는 명사구**로 쓴다. 문장으로 끝내지 않는다.
      좋은 예: 「임상시험을 실시한 의약품을 위탁제조하여 판매하려는 경우의 신고 의무에 관한 것」
      나쁜 예: 「신고가 필요한지 문의하셨습니다.」(문장) / 「위탁제조」(너무 짧다)
    · 민원에 적힌 말을 쓴다. 민원에 없는 사실을 보태지 않는다.
    · 40~90자.

[2] help — 실무 참고. **mode 가 "help" 일 때만** 쓴다. 아니면 빈 문자열.
    · **법령 이름은 아래 「담당자가 고른 근거 조문」에 나온 것만 쓸 수 있다.**
      거기 없는 법령·규칙·고시 이름은 **한 글자도 쓰지 마라.** 「총리령으로 정하는 바에 따라」처럼
      조문에 그렇게 적혀 있어도, 그 총리령이 무엇인지 네가 짐작해 이름을 붙이지 마라.
      실제로 없는 「의약품 등의 제조·수입 및 판매에 관한 규칙」을 지어낸 적이 있다.
    · **조문에 이미 적힌 말을 되풀이하지 않는다.** 조문을 읽으면 아는 것은 통째로 빼라.
      「신고를 하여야 하며 품목허가를 받아야 합니다」는 조문 그 자체다 — 쓸 말이 아니다.
    · 쓸 것은 **조문에 안 적힌 실무**뿐이다 — 순서(무엇을 먼저 하는지), 함께 챙길 것,
      흔히 놓치는 대목. 그런 게 떠오르지 않으면 **빈 문자열로 두라. 그게 정답이다.**
    · 1~3문장. **각 문장은 「○ 」로 시작하고 문장마다 줄을 바꾼다(\n).**
    · **단정하지 않는다.** 「…하시면 절차가 빠릅니다」처럼 안내하는 말투.
    · 법령 해석을 새로 만들지 마라. 처분·판단·가부(可否)를 단정하지 마라.
    · **「…할 수 있다」(재량) 조문만 보고 「필수가 아니다」「안 받을 수도 있다」로 쓰지 마라.** 재량을 언제 쓰는지 정한
      지침·고시의 구체 기준이 근거 조문에 있으면 그 기준을 따라 쓴다(2026-09-10 실측: 「실태조사를 할 수 있다」를
      「재량 규정이 핵심」이라 써서 민원인이 오독할 뻔했다).
    · **민원에 든 낱말(「시험생산 배치」「상업용 배치」 등)이 조문의 판단 기준인지는 조문 본문으로 확인한다.**
      본문에 그 구분이 없으면 「다르게 취급될 수 있다」처럼 짐작해 쓰지 마라. 기준은 조문에 적힌 것뿐이다.
    · 아래 [담당자가 적어 둔 우리 과 규칙]이 있으면 그것을 조문 다음으로 따른다.

[3] topic — 「귀하께서 제출하신 민원의 내용은 '___'에 대한 질의로 이해됩니다」의 빈칸. **4~16자 명사구.**
    좋은 예: 「반창고 품목허가」 「유전자재조합의약품 제조소 변경 시 GMP 실태조사」 「위탁제조판매업 신고」
    나쁜 예: 「…에 관한 것」(summary) / 문장 / 「GMP」(너무 짧다)

[3-1] title — 목록에서 한눈에 알아볼 **짧은 제목**. 핵심 낱말 두셋을 「 · 」로 잇는다. 8~24자. 문장이 아니다.
    좋은 예: 「보툴리눔 · 다른 의약품 · 2차 포장 공용」 「임상시험 의약품 · 위탁제조 신고」
    나쁜 예: 「…에 관한 것」(summary 를 되풀이) / 「민원 답변」(아무 말도 아님) / 「신고」(너무 짧다)

[4] keys — 근거 조문마다 **민원에 답하는 핵심 문장 하나**. 조문 순서대로, 조문 수와 같은 개수.
    · **조문 본문에서 한 문장을 글자 그대로 옮긴다.** 요약·바꿔 쓰기·이어 붙이기 금지.
      서버가 원문과 대조해서 한 글자라도 다르면 버린다 — 그러면 담당자는 조문 전체를 읽어야 한다.
    · 문장 첫머리의 「①」「1.」「가.」 같은 번호는 빼고 옮긴다. 문장 끝의 마침표까지 옮긴다.
    · 고르는 기준: 민원인이 물은 것에 **직접 답하는 문장**. 정의(제2조)에서 「다만…」 단서를,
      기준에서 「…방지할 것.」 같은 꼬리 항목을 고른 적이 있다 — 그건 답이 아니다.
    · 그 조문에 민원에 답하는 문장이 없으면(표·목록·정의만 있으면) **빈 문자열**.

공통
    · 조문에 없는 조 번호·법령 이름을 지어내지 마라.
    · 민원인을 평가하거나 훈계하지 마라.`;

// **모양을 law-pick 과 똑같이 맞춘다.** 처음에 name·strict 를 함께 넣었더니
// API 가 `output_config.format.name: Extra inputs are not permitted` 로 물리쳤다.
// deno check 는 통과하는 종류라 실제로 불러 봐야만 걸린다.
const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "민원 요지 명사구 (…에 관한 것)" },
    help:    { type: "string", description: "실무 참고. mode!=help 이면 빈 문자열" },
    topic:   { type: "string", description: "'___'에 대한 질의 의 빈칸. 4~16자 명사구" },
    title:   { type: "string", description: "핵심 낱말 두셋을 「 · 」로 이은 짧은 제목 (8~24자)" },
    keys:    { type: "array", items: { type: "string" }, description: "근거 조문마다 원문 그대로 옮긴 핵심 문장 하나. 없으면 빈 문자열" },
  },
  required: ["summary", "help", "topic", "title", "keys"],
  additionalProperties: false,
};

function readJson(res: any) {
  const c = (res?.content || []).find((x: any) => x.type === "text");
  try { return JSON.parse(c?.text || "{}"); } catch { return {}; }
}
// AI 가 JSON 을 안 냈을 때 「왜」를 사람 말로. law-pick 의 whyNoJson 과 같은 규칙.
// **이게 없어서 거부가 조용히 빈 초안으로 나왔다** — 요지 칸만 비어 있고
// 아무 말도 안 뜨는, 제일 알아채기 어려운 실패였다(2026-09-08 실측).
function whyStop(res: any) {
  const sr = String(res?.stop_reason || "");
  if (sr === "refusal")
    return "AI 가 이 민원에 답하기를 거부했어요. 민원 내용에 독소·병원체 이름이 "
         + "들어 있으면 그럴 수 있어요 — 그 말을 빼고 다시 만들어 보세요.";
  if (sr === "max_tokens")
    return "AI 답이 중간에서 잘렸어요. 고른 조문을 줄여서 다시 만들어 보세요.";
  return "AI 답을 읽지 못했어요. 다시 한 번 눌러주세요."
       + (sr ? " (끝맺음: " + sr + ")" : "");
}
function usdOf(u: any, c: Cfg) {
  const i = (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0);
  const o = u?.output_tokens || 0;
  return (i / 1e6) * c.in + (o / 1e6) * c.out;
}
// 사용자가 붙여넣은 글에 남아 있을 수 있는 자모 분리(NFD)를 맞춘다.
const nfc = (s: string) => (s || "").normalize("NFC");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY 가 없어요. Supabase → Edge Functions → Secrets 에 넣어주세요." });

    const body = await req.json().catch(() => ({}));
    const q = nfc(String(body?.q || "")).trim().slice(0, Q_MAX);
    const mode = body?.mode === "help" ? "help" : "plain";
    const cites = Array.isArray(body?.cites) ? body.cites : [];
    // 담당자가 앱에 적어 둔 「우리 과 규칙」 — 소관 구분·「이 말이 나오면 이 문서」 같은 평문. 없으면 빈 문자열.
    const rules = nfc(String(body?.rules || "")).trim().slice(0, 4000);

    if (!q) return json({ error: "민원 내용을 적어주세요." });
    if (!cites.length) return json({ error: "근거 조문을 하나 이상 골라주세요." });

    // 조문을 AI 에게 보여준다. 요지를 정확히 잡으려면 무엇에 관한 조문인지
    // 알아야 하고, help 를 쓰려면 조문을 읽어야 한다.
    let used = 0;
    const shown = cites.map((c: any, i: number) => {
      const law = nfc(String(c?.law || "")).slice(0, 80);
      const num = nfc(String(c?.num || "")).slice(0, 40);
      let t = nfc(String(c?.text || "")).slice(0, ART_MAX);
      if (used + t.length > TOTAL_MAX) t = t.slice(0, Math.max(0, TOTAL_MAX - used));
      used += t.length;
      return `[${i + 1}] 「${law}」 ${num}\n${t}`;
    }).join("\n\n");

    const ask = (c: Cfg) => ({
      model: c.id,
      max_tokens: 1600 * c.room,
      system: RULES,
      output_config: c.effort
        ? { effort: c.effort, format: { type: "json_schema", schema: SCHEMA } }
        : {                   format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content:
          `mode: ${mode}\n\n` +
          `[민원 내용]\n${q}\n\n` +
          `[담당자가 고른 근거 조문]\n${shown}` +
          (rules ? `\n\n[담당자가 적어 둔 우리 과 규칙]\n${rules}` : ""),
      }],
    });

    // **거부하면 한 단계 아래 모델로 자동으로 다시 부른다.**
    // Opus 5 는 독소·병원체 이름이 든 민원을 거부한다(보툴리눔 실측). 거부는
    // 빈 답으로 돌아오므로, 안 받아내면 「요지 칸이 빈 초안」이 나온다.
    // Haiku 는 같은 민원에 멀쩡히 답한다 — 좋은 모델을 먼저 쓰고, 막히면
    // 되받는다. 사용자는 실패를 볼 일이 없다.
    const plan: Cfg[] = CFG.id === MODELS.haiku.id ? [CFG] : [CFG, MODELS.haiku];
    let res: any = null, cfg: Cfg = CFG, out: any = null;
    let krw = 0, fellBack = false, why = "";
    for (let i = 0; i < plan.length; i++) {
      cfg = plan[i];
      res = await claude(apiKey, ask(cfg));
      // 되받을 때도 값은 쌓인다 — 실제로 나간 돈을 그대로 보여준다.
      krw += Math.round(usdOf(res?.usage, cfg) * KRW);
      const got = readJson(res);
      if (String(got?.summary || "").trim()) { out = got; fellBack = i > 0; break; }
      why = whyStop(res);
    }
    if (!out) return json({ error: why || "AI 답을 읽지 못했어요.", krw });


    // **말로 시켜도 샌다 — 서버가 한 번 더 거른다.**
    // 실측: 「총리령(의약품 등의 제조·수입 및 판매에 관한 규칙)」이라는
    // 있지도 않은 법령을 지어냈다. 근거 조문에 없는 법령 이름이 든 문장은 버린다.
    const known: string[] = cites.map((c: any) => nfc(String(c?.law || "")).replace(/\s+/g, ""));
    const LAWNAME = /[가-힣A-Za-z0-9ㆍ·\s]{4,40}?(?:법|법률|시행령|시행규칙|규칙|규정|고시|예규|지침)(?=[」\)\s,.]|$)/g;
    function clean(t: string) {
      // 「○ 」로 시작하는 문장 단위로 자른다. 줄바꿈이 없어도 갈린다.
      const parts = t.split(/(?=○\s)/).map((x) => x.trim()).filter(Boolean);
      const kept = parts.filter((p) => {
        const ms = p.match(LAWNAME) || [];
        for (const m of ms) {
          const nm = m.replace(/\s+/g, "");
          if (nm.length < 4) continue;
          // 근거 조문의 법령 이름 안에 들어 있으면 통과 (약칭·부분 인용 허용)
          if (known.some((k: string) => k.includes(nm) || nm.includes(k))) continue;
          return false;   // 모르는 법령 이름이 있다 → 버린다
        }
        return true;
      });
      return kept.join("\n");
    }
    const helpRaw = mode === "help" ? nfc(String(out?.help || "")).trim() : "";
    const help = helpRaw ? clean(helpRaw) : "";

    // **핵심 문장은 원문과 대조해 통과한 것만 준다.** 빈칸을 다 지우고 견준다(줄바꿈·띄어쓰기 차이 무시).
    // 12자보다 짧은 것(「관리할 것.」)은 문장이 아니라 꼬리라 버린다.
    const sq = (t: string) => nfc(String(t || "")).replace(/\s+/g, "");
    const rawKeys: string[] = Array.isArray(out?.keys) ? out.keys.map((k: unknown) => nfc(String(k || "")).replace(/\s+/g, " ").trim()) : [];
    const keys: string[] = cites.map((c: any, i: number) => {
      const k = rawKeys[i] || "";
      if (k.length < 12 || k.length > 400) return "";
      return sq(String(c?.text || "")).includes(sq(k)) ? k : "";
    });

    return json({
      summary: nfc(String(out?.summary || "")).trim(),
      title: nfc(String(out?.title || "")).replace(/\s+/g, " ").trim().slice(0, 40),
      topic: nfc(String(out?.topic || "")).replace(/\s+/g, " ").replace(/^['‘"「]|['’"」]$/g, "").trim().slice(0, 30),
      help,
      keys,
      keysDropped: rawKeys.filter((k) => k).length - keys.filter((k) => k).length,
      // 걸러낸 게 있으면 화면에서 알린다 — 조용히 지우면 왜 짧아졌는지 모른다
      dropped: helpRaw && helpRaw !== help,
      krw,
      model: cfg.id,
      // 좋은 모델이 거부해서 아래 모델로 되받았음을 화면에서 알린다 —
      // 조용히 갈아타면 「오늘은 왜 초안이 다르지」를 알 길이 없다.
      fellBack,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
