#!/bin/bash
# daily_extract.sh - cron wrapper: 加载 .env 后跑 daily_extract.py
# 用法：daily_extract.sh             # 处理前一天
#       daily_extract.sh 2026-05-10  # 处理指定日期
set -e
cd /var/www/app
set -a
source /var/www/app/.env
set +a
exec /root/rag-env/bin/python daily_extract.py "$@"
