# -*- coding: utf-8 -*-
"""없는 함수를 부르고 있지 않은지 검사한다.
코드 뭉치를 걷어낼 때 다른 데서 쓰던 함수까지 딸려 지워지는 사고가 두 번 있었다
(extractDocXml, markTerms). 문법 검사로는 안 잡힌다 — 부를 때야 터지기 때문이다."""
import io,re,sys

src=io.open("app.js",encoding="utf-8").read()
# 문자열·주석 안은 빼고 본다 (대충이지만 이 목적엔 충분하다)
code=re.sub(r'/\*.*?\*/','',src,flags=re.S)
code=re.sub(r'(?m)//.*$','',code)
code=re.sub(r'"(?:[^"\\\\\n]|\\\\.)*"','""',code)
code=re.sub(r"'(?:[^'\\\\\n]|\\\\.)*'","''",code)

defined=set()
defined |= set(re.findall(r'function\s+([A-Za-z_$][\w$]*)', code))
defined |= set(re.findall(r'var\s+([A-Za-z_$][\w$]*)\s*=', code))
for params in re.findall(r'function[^(]*\(([^)]*)\)', code):
    for pnm in params.split(","):
        pnm=pnm.strip()
        if re.match(r'^[A-Za-z_$][\w$]*$', pnm): defined.add(pnm)
# var a=1, b=2 꼴의 뒷쪽들
for chunk in re.findall(r'var\s+([^;{}\n]+)', code):
    for part in chunk.split(","):
        m=re.match(r'\s*([A-Za-z_$][\w$]*)', part)
        if m: defined.add(m.group(1))

GLOBALS=set("""if for while switch catch return typeof new delete void in of do else
function try finally throw case break continue instanceof
Promise Array Object String Number Boolean Date Math JSON RegExp Error Map Set
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame
document window navigator localStorage console alert confirm prompt fetch
Blob FileReader URL Uint8Array DataView ArrayBuffer TextDecoder TextEncoder
DOMParser Response DecompressionStream XMLHttpRequest Intl Symbol
supabase sb S""".split())

calls={}
for m in re.finditer(r'(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(', code):
    nm=m.group(1)
    if nm in GLOBALS or nm in defined: continue
    calls.setdefault(nm, code[:m.start()].count("\n")+1)

if calls:
    print("✗ 없는 함수를 부르고 있어요:")
    for nm,ln in sorted(calls.items(), key=lambda x:x[1]):
        print("   %s()  — 대략 %d번째 줄" % (nm,ln))
    sys.exit(1)
print("✓ 없는 함수 호출 없음")
