#!/bin/bash
# Vercel "Ignored Build Step": exit 0 = skip deploy, exit 1 = deploy.
# 사용량 기록 데이터(페이지가 GitHub에서 직접 읽음)·앱·PC 프로그램·워크플로만 바뀐 경우 배포하지 않는다.
if [ -z "$VERCEL_GIT_PREVIOUS_SHA" ]; then exit 1; fi
if git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . \
  ':(exclude)ai-usage-calculator/data' ':(exclude)ai-usage-app' \
  ':(exclude)ai-usage-monitor' ':(exclude).github'; then
  echo "data/app-only change: skip deploy"; exit 0
fi
exit 1
