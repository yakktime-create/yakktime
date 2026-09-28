#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""서버의 실사 노트를 insp_template.json 최신 판에 맞춘다 (2026-09-28)

이 세션에서 열두 번 채팅에 다시 쳤던 스크립트를 파일로. 스킬 /서버노트맞추기 가 부른다.
  python3 tools/insp_sync.py          # 맞춘다 (먼저 스냅샷을 떠 둔다)
  python3 tools/insp_sync.py --count  # 서버 줄 수만 센다 (「화면이 이상하다」면 이것부터)

- 열쇠: ~/.yakktime-supabase-token (Management API 개인 토큰 sbp_…) 으로 service_role 열쇠를 받는다. 채팅에 안 적는다.
- 본에서 온 줄(src='본')만 지우고 새로 넣는다. 체크·메모는 같은 글(빈칸·형광펜 표시 무시)에 옮긴다.
  직접 적은 줄·방·발견·관리표(track)는 안 건드린다.
"""
import json, io, os, sys, re, uuid, urllib.request, collections, datetime

REF = "mkwcqnqfidlvsrlximbw"
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
TPL = os.path.join(APP, "insp_template.json")
BACKUP_DIR = os.path.join(os.path.dirname(APP), "업무데스크-app 백업")

def pat():
    p = os.path.expanduser("~/.yakktime-supabase-token")
    if not os.path.exists(p): sys.exit("토큰 파일이 없어요 — /토큰넣기 로 sbp_ 토큰을 넣어 주세요")
    return open(p).read().strip()

def service_key():
    r = urllib.request.Request("https://api.supabase.com/v1/projects/%s/api-keys?reveal=true" % REF)
    r.add_header("Authorization", "Bearer " + pat()); r.add_header("User-Agent", "curl/8.4")
    try:
        ks = json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        sys.exit("토큰이 죽었어요(HTTP %d) — /토큰넣기 로 새 토큰" % e.code)
    return [x for x in ks if x.get("name") == "service_role"][0]["api_key"]

K = None
U = "https://%s.supabase.co/rest/v1" % REF
def req(method, path, data=None, prefer=None):
    r = urllib.request.Request(U + path, method=method, data=(json.dumps(data, ensure_ascii=False).encode() if data is not None else None))
    for h, v in [("apikey", K), ("Authorization", "Bearer " + K), ("Content-Type", "application/json"), ("Range", "0-9999")] + ([("Prefer", prefer)] if prefer else []):
        r.add_header(h, v)
    try:
        with urllib.request.urlopen(r) as f: b = f.read(); return f.status, (json.loads(b) if b else None)
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

strip = lambda s: re.sub(r"\{[녹노]:([^}]*)\}", r"\1", s or "")
norm = lambda s: re.sub(r"\s+", "", strip(s))

def main():
    global K
    K = service_key()
    t = json.load(io.open(TPL, encoding="utf-8"))
    insp = req("GET", "/inspections?select=*")[1][0]; iid = insp["id"]
    rows = req("GET", "/insp_items?select=*&insp_id=eq." + iid)[1]
    print("서버 %d줄 %s · 체크 %d · 메모 %d · 노트 판 %s (본 %s)" % (
        len(rows), dict(collections.Counter(x["page"] for x in rows)), sum(1 for x in rows if x["done"]),
        sum(1 for x in rows if (x["memo"] or "").strip()), insp.get("tpl"), t["version"]))
    if "--count" in sys.argv: return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    snap = os.path.join(BACKUP_DIR, "insp_items_snapshot_%s.json" % datetime.date.today().isoformat())
    json.dump(rows, io.open(snap, "w", encoding="utf-8"), ensure_ascii=False); print("스냅샷", snap)
    carry = {norm(x["text"]): (x["done"], (x["memo"] or "").strip() or None) for x in rows if x["src"] and (x["done"] or (x["memo"] or "").strip())}
    custom = [x for x in rows if not x["src"]]; seq = max([x["seq"] or 0 for x in custom] + [0]) + 1
    new = []
    for i, x in enumerate(t["items"]):
        c = carry.get(norm(x["text"]), (False, None))
        new.append({"id": str(uuid.uuid4()), "insp_id": iid, "page": x["page"], "section": x.get("section") or None, "seq": seq + i,
                    "kind": x.get("kind") or "task", "text": x["text"], "hint": x.get("hint") or None, "building": x.get("building") or None,
                    "area": x.get("area") or None, "day": x.get("day") or None, "done": bool(c[0]), "memo": c[1], "grade": None, "ref": None, "src": "본"})
    s1, _ = req("DELETE", "/insp_items?insp_id=eq." + iid + "&src=eq.%EB%B3%B8", prefer="return=minimal")
    s2, b = req("POST", "/insp_items", new, prefer="return=minimal")
    s3, b3 = req("PATCH", "/inspections?id=eq." + iid, {"tpl": t["version"], "areas": t["mine"]}, prefer="return=representation")
    rows = req("GET", "/insp_items?select=page,done,memo&insp_id=eq." + iid)[1]
    print("지움 %s · 넣음 %s%s · 노트 %s %s · 지금 %d줄 · 체크 %d · 메모 %d" % (
        s1, s2, ("" if s2 < 300 else " " + str(b)[:200]), s3, (b3[0]["tpl"] if s3 < 300 else b3), len(rows),
        sum(1 for x in rows if x["done"]), sum(1 for x in rows if (x["memo"] or "").strip())))

if __name__ == "__main__":
    main()
