#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""맥에서 도는 AI 일꾼 (2026-09-28)

Supabase 의 ai_jobs 표를 몇 초마다 들여다보고, 새 줄(status=queued)이 있으면 맥에 깔린 Claude Code(`claude -p`, 구독)로
답을 만들어 같은 줄에 적는다. 법령 탭의 law-pick · law-draft 가 API 대신 이 표에 일을 넣는다.

- 열쇠: ~/.yakktime-service-key (Supabase service_role). 채팅·화면에 적지 않는다.
- 심장박동: ai_jobs 의 고정 줄(HB_ID)을 몇 초마다 갱신 — 서버 함수가 이 시각을 보고 「맥이 깨어 있나」를 안다.
- claude -p 는 --system-prompt + --tools "" 로 부른다: 기본 설정(코드 도우미 시스템 프롬프트)이면 한 번에 $0.28어치,
  이렇게 부르면 $0.002어치 (2026-09-28 실측, 140배). 구독이라 돈은 안 나가지만 주간 한도를 먹는다.
- 돌리기: launchd (tools/com.yakktime.aiworker.plist) 가 로그인하면 띄우고 죽으면 다시 띄운다.
"""
import json, os, subprocess, time, urllib.request, urllib.error, datetime, sys

URL = "https://mkwcqnqfidlvsrlximbw.supabase.co/rest/v1"
KEY_FILE = os.path.expanduser("~/.yakktime-service-key")
CLAUDE = os.path.expanduser("~/.local/bin/claude")
HB_ID = "00000000-0000-0000-0000-000000000001"
POLL = 3           # 초
JOB_TIMEOUT = 300  # 초 — Opus 가 긴 초안을 생각하는 시간까지
LOG = os.path.expanduser("~/Library/Logs/yakktime-ai-worker.log")

def log(msg):
    line = datetime.datetime.now().strftime("%m-%d %H:%M:%S") + " " + msg
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f: f.write(line + "\n")
    except OSError: pass

def key():
    try: return open(KEY_FILE, encoding="utf-8").read().strip()
    except OSError:
        log("열쇠 파일이 없어요: " + KEY_FILE); sys.exit(1)

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

def req(method, path, data=None, prefer=None):
    body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
    r = urllib.request.Request(URL + path, method=method, data=body)
    k = key()
    for h, v in [("apikey", k), ("Authorization", "Bearer " + k), ("Content-Type", "application/json")] + ([("Prefer", prefer)] if prefer else []):
        r.add_header(h, v)
    with urllib.request.urlopen(r, timeout=20) as f:
        b = f.read()
        return json.loads(b) if b else None

def heartbeat():
    req("POST", "/ai_jobs?on_conflict=id",
        {"id": HB_ID, "kind": "heartbeat", "status": "alive", "updated_at": now()},
        prefer="resolution=merge-duplicates,return=minimal")

def claim_one():
    jobs = req("GET", "/ai_jobs?status=eq.queued&kind=neq.heartbeat&order=created_at.asc&limit=1&select=id,kind,req")
    if not jobs: return None
    j = jobs[0]
    got = req("PATCH", "/ai_jobs?id=eq." + j["id"] + "&status=eq.queued",
              {"status": "running", "updated_at": now()}, prefer="return=representation")
    return j if got else None   # 다른 일꾼이 먼저 집었으면 빈 배열

MODEL_ALIAS = {"haiku": "haiku", "sonnet": "sonnet", "opus": "opus"}

def run_claude(r):
    """r = {model, system, prompt, effort?, schema?} → {text, usage, model, cost_usd, duration_ms}"""
    model = MODEL_ALIAS.get(str(r.get("model", "haiku")).lower(), "haiku")
    cmd = [CLAUDE, "-p", "--output-format", "json", "--model", model, "--no-session-persistence", "--tools", ""]
    if r.get("system"): cmd += ["--system-prompt", r["system"]]
    if r.get("effort"): cmd += ["--effort", r["effort"]]
    if r.get("schema"): cmd += ["--json-schema", json.dumps(r["schema"], ensure_ascii=False)]
    p = subprocess.run(cmd, input=r.get("prompt", ""), capture_output=True, text=True, timeout=JOB_TIMEOUT)
    if p.returncode != 0 and not p.stdout.strip():
        raise RuntimeError("claude 종료 코드 %d: %s" % (p.returncode, (p.stderr or "")[-400:]))
    out = json.loads(p.stdout)
    if out.get("is_error"): raise RuntimeError("claude 오류: " + str(out.get("result"))[:400])
    text = out.get("structured_output")
    text = json.dumps(text, ensure_ascii=False) if isinstance(text, (dict, list)) else (text or out.get("result") or "")
    return {"text": text, "usage": out.get("usage"), "model": list((out.get("modelUsage") or {}).keys()),
            "cost_usd": out.get("total_cost_usd"), "duration_ms": out.get("duration_ms"), "via": "cli"}

def main():
    log("일꾼 시작 · " + CLAUDE)
    while True:
        try:
            heartbeat()
            j = claim_one()
            if j:
                t0 = time.time()
                try:
                    res = run_claude(j.get("req") or {})
                    req("PATCH", "/ai_jobs?id=eq." + j["id"], {"status": "done", "res": res, "updated_at": now()}, prefer="return=minimal")
                    log("%s 끝 %.1fs $%.3f" % (j.get("kind"), time.time() - t0, res.get("cost_usd") or 0))
                except Exception as e:
                    req("PATCH", "/ai_jobs?id=eq." + j["id"], {"status": "error", "err": str(e)[:1000], "updated_at": now()}, prefer="return=minimal")
                    log("%s 실패: %s" % (j.get("kind"), str(e)[:200]))
                continue   # 일이 있었으면 바로 다음 것
        except urllib.error.HTTPError as e:
            log("HTTP %d %s" % (e.code, e.read()[:200].decode(errors="ignore"))); time.sleep(10)
        except Exception as e:
            log("오류: " + str(e)[:200]); time.sleep(10)
        time.sleep(POLL)

if __name__ == "__main__":
    main()
