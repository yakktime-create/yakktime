# -*- coding: utf-8 -*-
"""4단계 — 새 질문에 「이전 유사 사례」 상자 + 조문 카드 「이전 사례에서 인용」 (시험대 ?tab=laws&ask=1, 가짜 similar)"""
import os, sys
from playwright.sync_api import sync_playwright
OUT=os.path.expanduser("~/.yakktime-uitest"); ok=True
def check(n,c,x=""):
    global ok; print(("  ✓ " if c else "  ✗ ")+n+(" — "+x if x else "")); ok=ok and bool(c)
with sync_playwright() as p:
    b=p.chromium.launch()
    for W in (620,900):
        pg=b.new_page(viewport={"width":W,"height":1400}); pg.goto("http://localhost:8777/index.html?tab=laws&ask=1&nohelp=1"); pg.wait_for_timeout(1200)
        check("상자 보임(%d)"%W, pg.locator(".ask-cases").count()==1, pg.title())
        txt=pg.locator(".ask-cases").inner_text() if pg.locator(".ask-cases").count() else ""
        check("상황·판단 축·메모·그때 조문이 들어 있음", all(k in txt for k in ("상황","판단 축","메모","그때 본 조문")), txt[:80].replace("\n"," "))
        check("판단 축 이름으로 보임", "사전 GMP 평가 대상 여부" in txt and "지방청 소관" in txt)
        check("카드에 「이전 사례에서 인용」", pg.locator(".law-used.past").count()>=1, str(pg.locator(".law-used.past").count()))
        first=pg.locator(".law-hit").first.inner_text()
        check("그 카드가 맨 위", "이전 사례에서 인용" in first, first[:60].replace("\n"," "))
        pg.locator(".ask-box").screenshot(path=os.path.join(OUT,"shot_casebox_%d.png"%W)); pg.close()
    # 사례 0건이어도 멀쩡한가
    pg=b.new_page(viewport={"width":900,"height":1200}); pg.goto("http://localhost:8777/index.html?tab=laws&ask=1&nohelp=1"); pg.wait_for_timeout(800)
    pg.evaluate("() => { lawAsk.similar=[]; S.answers=[]; render(); }"); pg.wait_for_timeout(300)
    check("사례 0건: 상자 없음·오류 없음", pg.locator(".ask-cases").count()==0 and not pg.title().startswith("ERR"), pg.title())
    b.close()
print("RESULT","PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
