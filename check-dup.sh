#!/bin/sh
# app.js에 같은 이름의 함수·전역변수가 두 번 정의됐는지 검사한다.
# 나중에 정의된 쪽이 이겨서 "고쳤는데 반영이 안 되는" 버그가 세 번 있었다.
# 파일을 고친 뒤에는 항상 이걸 돌린다:  sh check-dup.sh
cd "$(dirname "$0")"
dup=$(grep -oE '^(function [A-Za-z_$][A-Za-z0-9_$]*|var [A-Za-z_$][A-Za-z0-9_$]*)' app.js \
      | sed 's/^function /fn /; s/^var /var /' \
      | sort | uniq -d)
if [ -n "$dup" ]; then
  echo "✗ 중복 정의가 있습니다 — 뒤에 정의된 쪽이 이깁니다:"
  echo "$dup" | sed 's/^/    /'
  echo
  echo "  위치:"
  echo "$dup" | sed 's/^fn /function /; s/^var /var /' | while read -r name; do
    grep -n "^$name" app.js | sed 's/^/    /'
  done
  exit 1
fi
echo "✓ 중복 정의 없음"

# 없는 함수를 부르고 있지 않은지도 함께 본다.
# 코드 뭉치를 걷어낼 때 다른 데서 쓰던 함수까지 딸려 지워지는 사고가 두 번 있었다.
python3 "$(dirname "$0")/check-refs.py" || exit 1
