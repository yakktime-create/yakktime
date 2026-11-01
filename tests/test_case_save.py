# -*- coding: utf-8 -*-
"""사례 꼬리표 저장 흐름 — 시험대(가짜 Supabase)에서 Playwright 로 (지시서 3단계 · 2026-11-01)
  sh tools/harness.sh && PYTHONPATH=~/.yakktime-uitest/pw python3 tests/test_case_save.py
흐름: 초안 창(?draft=1) → 「민원 답변에 담기」 → 꼬리표 판 → 유형·축·메모 → 업체명 넣으면 경고 → 고치면 저장 토스트.
실제 DB 는 안 건드린다(시험대는 가짜 표). 저장 꼴(보내는 칸)은 화면 제목에 찍어 확인한다."""
import os, sys, json
from playwright.sync_api import sync_playwright
OUT = os.path.expanduser("~/.yakktime-uitest")
ok = True
def check(name, cond, extra=""):
    global ok
    print(("  ✓ " if cond else "  ✗ ") + name + (" — " + extra if extra else ""))
    ok = ok and bool(cond)

with sync_playwright() as p:
    b = p.chromium.launch()
    for W in (620, 900):
        pg = b.new_page(viewport={"width": W, "height": 1300})
        pg.goto("http://localhost:8777/index.html?tab=laws&draft=1&nohelp=1"); pg.wait_for_timeout(1200)
        check("초안 창 열림(%d)" % W, pg.locator(".ans-win").count() == 1, pg.title())
        check("판은 아직 닫힘", pg.locator(".ans-case").count() == 0)
        pg.locator('[data-act="ans-save"]').first.click(); pg.wait_for_timeout(300)
        check("「담기」 → 꼬리표 판 열림", pg.locator(".ans-case").count() == 1)
        on = pg.locator(".ans-case .chip.on").inner_text() if pg.locator(".ans-case .chip.on").count() else ""
        check("유형이 먼저 채워짐(대상여부)", on == "대상여부", on)
        sit = pg.locator("#ans-case-sit").input_value()
        check("상황 한 줄이 먼저 채워짐", bool(sit.strip()), sit)
        check("판단 축 5개", pg.locator(".ans-axis").count() == 5)
        pg.locator(".ans-axis").nth(1).click(); pg.wait_for_timeout(200)   # 변경허가 vs 변경신고
        check("축 체크", pg.locator(".ans-axis.on").count() == 1)
        # 메모 → 축 제안(낱말 겹침)
        pg.fill("#ans-case-memo", "사전 GMP 평가 대상으로 봄, 실태조사 필요"); pg.wait_for_timeout(200)
        check("메모로 축 제안", pg.locator(".ans-case-sug").count() == 1, pg.locator("#ans-case-sug").inner_text()[:40])
        pg.locator('[data-act="ans-case-sug-ok"]').click(); pg.wait_for_timeout(200)
        check("제안 수락 → 축 둘", pg.locator(".ans-axis.on").count() == 2)
        # 업체명 → 경고
        pg.fill("#ans-case-memo", "한국바이오로직스 담당자 김철수 과장과 통화"); pg.locator('[data-act="ans-case-commit"]').click(); pg.wait_for_timeout(300)
        warn = pg.locator(".ans-case-warn")
        check("업체명·사람 이름 경고로 저장 막힘", warn.count() == 1 and pg.locator(".ans-win").count() == 1, warn.inner_text()[:60] if warn.count() else "")
        pg.locator(".ans-case").scroll_into_view_if_needed(); pg.wait_for_timeout(150)
        pg.locator(".ans-case").screenshot(path=os.path.join(OUT, "shot_casepanel_%d.png" % W))
        # 고치고 저장
        pg.fill("#ans-case-memo", "A사 담당자와 통화 — 재량 조항이지만 지침 기준이 있어 실태조사 대상으로 봄")
        pg.locator('[data-act="ans-case-commit"]').click(); pg.wait_for_timeout(600)
        toast = pg.locator(".sync-toast").inner_text() if pg.locator(".sync-toast").count() else ""
        check("저장 토스트에 「사례로도」", "사례" in toast, toast)
        check("저장 뒤 민원 답변 탭으로", pg.evaluate("active") == "answers")
        pg.screenshot(path=os.path.join(OUT, "shot_case_%d.png" % W), full_page=False)
        pg.close()
    # 저장 꼴 — 보내는 칸 이름
    pg = b.new_page(viewport={"width": 900, "height": 1300})
    pg.goto("http://localhost:8777/index.html?tab=laws&draft=1&nohelp=1"); pg.wait_for_timeout(1000)
    pg.evaluate("""() => { window.__sent=null; var o=window.dbInsert; window.dbInsert=function(t,i){ window.__sent={table:t,keys:Object.keys(i)}; return o(t,i); }; }""")
    pg.locator('[data-act="ans-save"]').first.click(); pg.wait_for_timeout(200)
    pg.locator('[data-act="ans-case-commit"]').click(); pg.wait_for_timeout(500)
    sent = pg.evaluate("window.__sent")
    check("answers 에 네 칸 보냄", sent and sent["table"] == "answers" and all(k in sent["keys"] for k in ("question_type", "situation", "axis_ids", "memo")), json.dumps(sent, ensure_ascii=False))
    b.close()
print("RESULT", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
