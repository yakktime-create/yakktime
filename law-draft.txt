// =====================================================================
//  law-draft — 고른 조문으로 민원 답변 초안을 만든다.
//
//  **AI 는 답변을 쓰지 않는다.** 두 가지만 만든다.
//    summary  민원의 요지 한 문장  (「…에 관한 것으로 이해되며」의 빈칸)
//    help     실무 참고 한두 문장   (mode 가 "help" 일 때만)
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

const MODEL     = "claude-haiku-4-5-20251001";
const ART_MAX   = 3000;    // 조 하나에서 AI 에게 읽힐 최대 글자
const TOTAL_MAX = 40000;   // AI 에게 넣을 글자 총량
const Q_MAX     = 4000;    // 민원 내용 상한
const KRW       = 1400;    // 원/달러
const IN_USD = 1.0, OUT_USD = 5.0;   // Haiku 100만 토큰당 달러

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
너는 아래 두 가지만 만든다.`;

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
  },
  required: ["summary", "help"],
  additionalProperties: false,
};

function readJson(res: any) {
  const c = (res?.content || []).find((x: any) => x.type === "text");
  try { return JSON.parse(c?.text || "{}"); } catch { return {}; }
}
function usdOf(u: any) {
  const i = (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0);
  const o = u?.output_tokens || 0;
  return (i / 1e6) * IN_USD + (o / 1e6) * OUT_USD;
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

    const res = await claude(apiKey, {
      model: MODEL,
      max_tokens: 900,
      system: RULES,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content:
          `mode: ${mode}\n\n` +
          `[민원 내용]\n${q}\n\n` +
          `[담당자가 고른 근거 조문]\n${shown}`,
      }],
    });

    const out = readJson(res);

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

    return json({
      summary: nfc(String(out?.summary || "")).trim(),
      help,
      // 걸러낸 게 있으면 화면에서 알린다 — 조용히 지우면 왜 짧아졌는지 모른다
      dropped: helpRaw && helpRaw !== help,
      krw: Math.round(usdOf(res?.usage) * KRW),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
