#!/usr/bin/env python3
"""「칸이 뒤섞여 읽기 어려운 대목」(law_articles.tbl=true)을 맥의 Opus 가 PDF 쪽 그림을 보고 바로잡는다 (2026-09-30).

이랑님 「돈의 제약이 많이 사라졌는데… 칸이 섞여 읽을 수 없으면 직접 읽는 건 어렵나?」
실측: 전문수탁 절차 23쪽은 표가 아니라 **사례를 네모 상자에 넣은 쪽**이었다 — 상자 선을 표로 오인해 글을 숨겼다.
그래서 쪽마다 Opus 가 가른다: box(상자일 뿐 → 글 그대로) / table(진짜 표 → 「┃칸│칸┨」 격자) / text.
**원래 글자에 없는 글자가 생기면 버린다**(verify) — 순서만 바로잡고 말을 지어내지 못하게.

  python3 tools/tbl_fix.py prep   <작업폴더>   # rows.json(미리 받아 둠) + PDF 받기 + 쪽 그림
  python3 tools/tbl_fix.py run    <작업폴더> [id…]   # claude -p (구독) 로 쪽마다, 결과 out/<id>.json
  python3 tools/tbl_fix.py report <작업폴더>   # 확인 페이지 review.html
  python3 tools/tbl_fix.py apply  <작업폴더> [--skip id,id]   # 통과한 것만 저장 (content·tbl=false·emb=null)
PyMuPDF 는 작업폴더/py 에 pip --target 으로 받아 둔다.
"""
import json, os, sys, subprocess, unicodedata, collections, concurrent.futures as cf, urllib.request, html, re

REF = "mkwcqnqfidlvsrlximbw"
URL = f"https://{REF}.supabase.co"
KEY = open(os.path.expanduser("~/.yakktime-service-key")).read().strip()
CLAUDE = os.path.expanduser("~/.local/bin/claude")
W = sys.argv[2] if len(sys.argv) > 2 else "."
sys.path.insert(0, os.path.join(W, "py"))

def req(method, path, body=None, raw=False):
    r = urllib.request.Request(URL + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(r, timeout=120) as f:
        d = f.read()
    return d if raw else (json.loads(d) if d else None)

def rows():
    return json.load(open(os.path.join(W, "rows.json")))

def prep():
    import fitz
    laws = {l["id"]: l for l in req("GET", "/rest/v1/laws?select=id,name,file_path")}
    os.makedirs(os.path.join(W, "img"), exist_ok=True)
    docs = {}
    for r in rows():
        lid = r["law_id"]
        if lid not in docs:
            fp = os.path.join(W, lid + ".pdf")
            if not os.path.exists(fp):
                open(fp, "wb").write(req("GET", "/storage/v1/object/files/" + laws[lid]["file_path"], raw=True))
            docs[lid] = fitz.open(fp)
        a, b = r["page"] or 1, r["page_end"] or r["page"] or 1
        for p in range(a, min(b, a + 2) + 1):          # 한 조각은 많아야 세 쪽까지 보인다
            out = os.path.join(W, "img", f"{lid[:8]}_{p}.jpg")
            if not os.path.exists(out):
                pix = docs[lid][p - 1].get_pixmap(dpi=110)
                pix.save(out, jpg_quality=72)
    print("prep ok", len(rows()))

def imgs(r):
    a, b = r["page"] or 1, r["page_end"] or r["page"] or 1
    return [f"img/{r['law_id'][:8]}_{p}.jpg" for p in range(a, min(b, a + 2) + 1)]

SYSTEM = """너는 PDF 에서 뽑은 글자를 쪽 그림을 보고 바른 읽기 순서로 다시 쓰는 도구다.
글자를 새로 만들거나, 고치거나, 요약하거나, 설명하지 않는다. 입력 「원래 글」에 있는 글자만 쓴다.
- 「원래 글」이 다루는 범위만 쓴다. 그림에는 다른 내용도 있을 수 있다 — 그건 버린다.
- 네모 상자 안의 질문·본문처럼 행·열 구조가 없으면 kind="box". 일반 글로 쓰고 문단은 줄바꿈으로 나눈다.
- 행과 열이 있는 진짜 표면 kind="table". 표의 한 행을 한 줄에 「┃칸│칸│칸┨」 꼴로 쓴다(첫 줄은 머리 행).
  병합된 칸은 처음 한 번만 쓰고 나머지 칸은 비운다. 표 앞뒤의 글은 일반 글로 쓴다.
- 그 밖(평범한 글)은 kind="text".
- 원래 글의 순서가 뒤섞였으면 그림대로 바로잡는다. 띄어쓰기도 그림대로.
- 쪽 번호(「- 18 -」)와 쪽 머리글은 넣지 않는다.
- 답은 JSON 하나: {"kind": "box"|"table"|"text", "text": "..."}"""
SCHEMA = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["box", "table", "text"]},
          "text": {"type": "string"}}, "required": ["kind", "text"], "additionalProperties": False}

def run_one(r):
    out = os.path.join(W, "out", f"{r['id']}.json")
    if os.path.exists(out): return json.load(open(out))
    files = imgs(r)
    prompt = ("다음 그림 파일을 Read 로 열어 보라: " + ", ".join(files) +
              f"\n\n쪽 {r['page']}~{r['page_end']} · 라벨: {r['label']}\n\n<원래 글>\n{r['content']}\n</원래 글>")
    cmd = [CLAUDE, "-p", "--output-format", "json", "--model", "opus", "--no-session-persistence",
           "--tools", "Read", "--allowedTools", "Read", "--effort", "medium",
           "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
           "--system-prompt", SYSTEM, "--json-schema", json.dumps(SCHEMA, ensure_ascii=False)]
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=600, cwd=W)
    try:
        o = json.loads(p.stdout); res = o.get("structured_output") or json.loads(o.get("result") or "{}")
    except Exception:
        res = {"kind": "error", "text": (p.stdout or p.stderr)[-500:]}; o = {}
    res["sec"] = round((o.get("duration_ms") or 0) / 1000, 1)
    res["verify"] = verify(r["content"], res.get("text", "")) if res.get("kind") != "error" else {"ok": False}
    os.makedirs(os.path.join(W, "out"), exist_ok=True)
    json.dump(res, open(out, "w"), ensure_ascii=False)
    return res

def norm(s):
    s = unicodedata.normalize("NFC", s or "")
    return [c for c in s if not c.isspace() and c not in "┃│┨"]

LOOSE = set("()[]{}:;.,·ㆍ-–—~「」『』'\"“”‘’/※*•○●■□▪◦")
def verify(old, new):
    """새 글에 원래 없던 글자(문장부호 몇 개 빼고)가 하나라도 있으면 실패. 원래 글의 3% 넘게 빠져도 실패."""
    a, b = collections.Counter(norm(old)), collections.Counter(norm(new))
    extra = b - a; miss = a - b
    bad = {c: n for c, n in extra.items() if c not in LOOSE}
    loose = sum(n for c, n in extra.items() if c in LOOSE)
    total = sum(a.values()) or 1
    lost = sum(miss.values())
    ok = not bad and loose <= 6 and lost / total <= 0.03
    return {"ok": ok, "bad": "".join(sorted(bad))[:40], "loose": loose, "lost": lost, "lostPct": round(100 * lost / total, 1),
            "missing": "".join(c * n for c, n in miss.most_common(15))[:40]}

def run(ids):
    rs = [r for r in rows() if not ids or r["id"] in ids or str(r["id"]) in ids]
    with cf.ThreadPoolExecutor(4) as ex:
        for r, res in zip(rs, ex.map(run_one, rs)):
            v = res.get("verify", {})
            print(r["id"], r["label"][:30], res.get("kind"), res.get("sec"), "OK" if v.get("ok") else "FAIL", v.get("bad", ""), v.get("lostPct", ""), flush=True)

def report():
    laws = {l["id"]: l["name"] for l in req("GET", "/rest/v1/laws?select=id,name")}
    def grid(t):
        o = []
        for line in t.split("\n"):
            if line.startswith("┃"):
                cells = line.strip("┃┨").split("│")
                o.append("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in cells) + "</tr>")
            else:
                if o and o[-1] != "</table>" and o[-1].startswith("<tr"): o.append("</table>")
                o.append(f"<p>{html.escape(line)}</p>" if line.strip() else "")
        s = "".join(o)
        s = re.sub(r"(<tr>.*?)(?=<p>|$)", lambda m: "<table>" + m.group(1) + ("" if m.group(1).endswith("</table>") else "</table>"), s)
        return s
    cards, stat = [], collections.Counter()
    for i, r in enumerate(rows(), 1):
        fin = final_of(r)
        res = {"text": fin["text"]}
        v = {"ok": bool(fin["src"]), "bad": "", "lostPct": "", "missing": fin["note"]}
        if fin["src"] == "image":
            st, cls = f"그림에서 읽음 · 두 번 읽어 {fin['agree']}% 일치", "img"
        elif fin["src"] == "text":
            st, cls = ("표로 옮김" if "┃" in fin["text"] else "글로 풀었음"), "ok"
            if fin["note"]: st += " · 그림에만 있는 글자 빠짐"; cls = "warn"
        else:
            st, cls = "그대로 둠 (PDF 원문에서 확인)", "no"
        stat[st.split(" · ")[0]] += 1
        why = f"<div class=why>{'PDF 글자 정보에 없어서 그림에서 읽은 것' if cls=='img' else '참고'}: {html.escape(fin['note'][:160])}</div>" if fin["note"] else ""
        pics = "".join(f'<img loading="lazy" src="{p}" alt="원본 {html.escape(r["label"])}">' for p in imgs(r))
        cards.append(f"""<section class="card {cls}" id="n{i}"><header><span class=no>{i}</span>
<span class=law>{html.escape(laws.get(r['law_id'],'')[:40])}</span> <b>{html.escape(r['label'])}</b>
<span class="st {cls}">{st}</span></header>{why}
<div class=cols><div class=pic>{pics}</div><div class=txt>{grid(res.get('text','')) if v.get('ok') else '<p class=dim>앱은 지금처럼 「PDF 원문에서 확인하세요」로 둔다.</p>'}</div></div></section>""")
    head = " · ".join(f"{k} {n}" for k, n in stat.most_common())
    page = f"""<title>지침서 표 대목 확인</title><style>
/* 한 카드 = 한 대목: 왼쪽 원본 쪽 그림, 오른쪽 앱에 들어갈 글. 좁으면 위아래로 */
:root{{--bg:#f4f5f2;--card:#fff;--paper:#fff;--ink:#1f2a24;--dim:#66706a;--line:#dfe2dc;--ok:#2f6b4f;--no:#b4532a;--okbg:#e6f0ea;--nobg:#fbece4;--img:#35598a;--imgbg:#e7eef8}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{--bg:#151917;--card:#1e2320;--paper:#e9e9e4;--ink:#e6ebe8;--dim:#9aa39e;--line:#2e3531;--ok:#8fcaa9;--no:#f0a07c;--okbg:#1f3a2d;--nobg:#43291d;--img:#9fbfe8;--imgbg:#1f2c40;color-scheme:dark}}}}
:root[data-theme=dark]{{--bg:#151917;--card:#1e2320;--paper:#e9e9e4;--ink:#e6ebe8;--dim:#9aa39e;--line:#2e3531;--ok:#8fcaa9;--no:#f0a07c;--okbg:#1f3a2d;--nobg:#43291d;--img:#9fbfe8;--imgbg:#1f2c40;color-scheme:dark}}
body{{background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"Apple SD Gothic Neo",sans-serif;word-break:keep-all;overflow-wrap:anywhere}}
.wrap{{max-width:1200px;margin:0 auto;padding-inline:16px;padding-block:16px}} h1{{font-size:22px;margin:8px 0 4px;letter-spacing:-.02em}}
.sum{{color:var(--dim);margin-bottom:16px}} .card{{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:0 0 16px;overflow:hidden}}
header{{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line)}}
.no{{font-weight:750;color:var(--dim)}} .law{{color:var(--dim);font-size:13px}} .st{{margin-left:auto;font-size:13px;font-weight:700;padding:2px 10px;border-radius:99px}}
.st.ok{{background:var(--okbg);color:var(--ok)}} .st.no,.st.warn{{background:var(--nobg);color:var(--no)}} .st.img{{background:var(--imgbg);color:var(--img)}} .why{{padding:8px 16px;font-size:13px;color:var(--no)}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:0}} .pic{{border-right:1px solid var(--line);padding:8px;background:var(--paper);min-width:0}}
.pic img{{width:100%;display:block;margin-bottom:6px}} .txt{{padding:12px 16px;font-size:14px;min-width:0;overflow-x:auto}} .txt p{{margin:0 0 8px}} .dim{{color:var(--dim)}}
table{{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 10px}} td{{border:1px solid var(--line);padding:4px 6px;vertical-align:top}}
tr:first-child td{{font-weight:700;background:var(--okbg)}}
@media (max-width:760px){{.cols{{grid-template-columns:1fr}} .pic{{border-right:0;border-bottom:1px solid var(--line)}}}}
</style><div class=wrap><h1>지침서 표 대목 확인</h1>
<div class=sum>지침서 5개에서 「칸이 뒤섞여 읽기 어렵다」고 숨겨 둔 {len(rows())}곳. 왼쪽이 원본 쪽, 오른쪽이 앱에 들어갈 글.
<br>{head}<br>파란 표시 「그림에서 읽음」은 PDF 에 글자 정보가 없어 Opus 가 그림을 두 번 따로 읽고 서로 맞춘 곳 — 원본과 한 번 견줘 봐 주세요. 붉은 표시는 저장하지 않거나 일부가 빠진 곳입니다.<br>틀린 곳이 있으면 카드 번호만 알려 주세요 — 그 곳은 빼고 저장합니다.</div>
{''.join(cards)}</div>"""
    open(os.path.join(W, "review.html"), "w").write(page)
    print("report ok", head)

def apply(skip):
    n = 0
    for r in rows():
        if str(r["id"]) in skip: continue
        fin = final_of(r)
        if not fin["src"]: continue
        req("PATCH", f"/rest/v1/law_articles?id=eq.{r['id']}", {"content": fin["text"], "tbl": False, "emb": None})
        n += 1
    print("applied", n)

GAP_SYSTEM = """너는 PDF 쪽 그림과, 그 쪽에서 컴퓨터가 뽑은 글자(「원래 글」)를 견주는 도구다.
「원래 글」이 다루는 범위 안에서, 그림에는 보이는데 「원래 글」에는 없는 글자(숫자·영문·괄호·상자 속 글·표 칸 등)가 있는지 본다.
띄어쓰기·줄바꿈·순서 차이는 빠진 것이 아니다. 쪽 번호와 머리글은 무시한다.
그리고 그 범위의 글을 그림에서 보이는 그대로 옮겨 적는다(text). 표는 한 행을 한 줄에 「┃칸│칸│칸┨」, 병합 칸은 처음 한 번만.
답은 JSON 하나: {"gap": true|false, "examples": "빠진 글자 예 몇 개(없으면 빈칸)", "text": "그림에서 옮긴 글"}"""
GAP_SCHEMA = {"type": "object", "properties": {"gap": {"type": "boolean"}, "examples": {"type": "string"}, "text": {"type": "string"}},
              "required": ["gap", "examples", "text"], "additionalProperties": False}

def claude_img(r, system, schema, extra=""):
    files = imgs(r)
    prompt = ("다음 그림 파일을 Read 로 열어 보라: " + ", ".join(files) +
              f"\n\n쪽 {r['page']}~{r['page_end']} · 라벨: {r['label']}{extra}\n\n<원래 글>\n{r['content']}\n</원래 글>")
    cmd = [CLAUDE, "-p", "--output-format", "json", "--model", "opus", "--no-session-persistence",
           "--tools", "Read", "--allowedTools", "Read", "--effort", "medium",
           "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
           "--system-prompt", system, "--json-schema", json.dumps(schema, ensure_ascii=False)]
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=600, cwd=W)
    o = json.loads(p.stdout); return o.get("structured_output") or json.loads(o.get("result") or "{}")

def gap_one(r):
    """1차: 글자 정보에 빠진 게 있나 + 그림에서 옮긴 글(읽기 A). 빠졌으면 2차로 따로 한 번 더 읽어(읽기 B) 둘을 견준다."""
    out = os.path.join(W, "gap", f"{r['id']}.json")
    if os.path.exists(out): return json.load(open(out))
    try:
        a = claude_img(r, GAP_SYSTEM, GAP_SCHEMA)
        res = {"gap": a.get("gap"), "examples": a.get("examples", ""), "a": a.get("text", "")}
        if res["gap"]:
            b = claude_img(r, GAP_SYSTEM, GAP_SCHEMA, extra="\n(다른 사람이 이미 한 번 읽었다. 너는 처음부터 따로 읽는다.)")
            res["b"] = b.get("text", "")
            import difflib
            x, y = "".join(norm(res["a"])), "".join(norm(res["b"]))
            res["agree"] = round(difflib.SequenceMatcher(None, x, y, autojunk=False).ratio() * 100, 1)
    except Exception as e:
        res = {"gap": None, "err": str(e)[:300]}
    os.makedirs(os.path.join(W, "gap"), exist_ok=True)
    json.dump(res, open(out, "w"), ensure_ascii=False)
    return res

def gap(ids):
    rs = [r for r in rows() if not ids or str(r["id"]) in ids]
    with cf.ThreadPoolExecutor(4) as ex:
        for r, res in zip(rs, ex.map(gap_one, rs)):
            print(r["id"], r["label"][:30], "GAP" if res.get("gap") else "ok", res.get("agree", ""), res.get("examples", "")[:60], flush=True)

def final_of(r):
    """쪽마다 최종 글을 고른다.
    - 글자 정보가 온전(gap=false)하고 검사 통과 → 순서만 바로잡은 글 (src=text)
    - 글자 정보가 빠짐(gap) · 두 번 읽기 98% 이상 일치 · 원래 글의 97% 이상을 덮음 → 그림에서 읽은 글 (src=image)
    - 그 밖 → 검사 통과한 글이 있으면 그것, 없으면 저장 안 함"""
    o = os.path.join(W, "out", f"{r['id']}.json"); g = os.path.join(W, "gap", f"{r['id']}.json")
    res = json.load(open(o)) if os.path.exists(o) else {}
    gp = json.load(open(g)) if os.path.exists(g) else {}
    if gp.get("gap") and gp.get("agree", 0) >= 98:
        cover = verify(r["content"], gp["a"])
        if cover["lostPct"] <= 3:
            return {"text": gp["a"], "src": "image", "note": gp.get("examples", ""), "agree": gp["agree"]}
    if res.get("verify", {}).get("ok"):
        note = ("그림에만 있는 글자는 못 넣음: " + gp.get("examples", "")) if gp.get("gap") else ""
        return {"text": res["text"], "src": "text", "note": note, "lostPct": res["verify"].get("lostPct", 0)}
    return {"text": "", "src": None, "note": gp.get("examples", "") or "검사 불통과"}

if __name__ == "__main__":
    op = sys.argv[1]
    if op == "prep": prep()
    elif op == "run": run(set(sys.argv[3:]))
    elif op == "gap": gap(set(sys.argv[3:]))
    elif op == "report": report()
    elif op == "apply":
        sk = set(sys.argv[sys.argv.index("--skip") + 1].split(",")) if "--skip" in sys.argv else set()
        apply(sk)
