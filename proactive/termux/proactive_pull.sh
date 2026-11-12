#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 主动消息取件器（跑在手机 Termux，和推健康数据的 cron 共用一条）
#
# 安装：
#   1) pkg install curl jq termux-api        # 还要装 Termux:API 这个 App（F-Droid）
#   2) 存成 ~/proactive_pull.sh && chmod +x ~/proactive_pull.sh
#   3) echo 'APP_TOKEN=你的服务端token' > ~/proactive.env && chmod 600 ~/proactive.env
#   4) crontab -e 加一行（每分钟，和健康上报同频）：
#        * * * * * /data/data/com.termux/files/home/proactive_pull.sh >> ~/proactive_pull.log 2>&1
#   5) 手动测：~/proactive_pull.sh ; cat ~/proactive_pull.log
# ============================================================
set -u

# token 单独放 ~/proactive.env：方便轮换，脚本里也不带密钥
[ -f "$HOME/proactive.env" ] && . "$HOME/proactive.env"

APP_TOKEN="${APP_TOKEN:-}"
BASE="${BASE:-https://YOUR_SERVER_IP:3443}"        # 自签证书 → curl 用 -k
APP_ACTIVITY="${APP_ACTIVITY:-com.egnor.aletheia/.MainActivity}"
API="$BASE/api/proactive"

if [ -z "$APP_TOKEN" ]; then
  echo "[$(date '+%F %T')] 缺少 APP_TOKEN：先 echo 'APP_TOKEN=xxx' > ~/proactive.env"
  exit 1
fi

# 1) 取件（没有待推的返回 204 / 空）
RESP=$(curl -sk --max-time 15 -H "X-Auth-Token: $APP_TOKEN" "$API/pending") || { echo "[$(date '+%F %T')] curl 失败"; exit 0; }
[ -z "$RESP" ] && exit 0
[ "$(echo "$RESP" | jq -r '.ok // false' 2>/dev/null)" = "true" ] || exit 0
COUNT=$(echo "$RESP" | jq '.items | length' 2>/dev/null)
[ "${COUNT:-0}" -eq 0 ] && exit 0

# 2) 只把「最新一条」弹成通知（Termux 离线久了堆积时不刷屏），
#    但所有条都回执消费 —— 消息本身已经在 App 的对话里了，不会丢
ITEM=$(echo "$RESP" | jq -c '.items | last')
ID=$(echo "$ITEM" | jq -r '.id')
TEXT=$(echo "$ITEM" | jq -r '.text')
CAT=$(echo "$ITEM" | jq -r '.category // ""')

case "$CAT" in
  health_anomaly)    TITLE="Daemon · 生理告警" ;;
  screen_time_audit) TITLE="Daemon · 抓包" ;;
  homework_progress) TITLE="Daemon · 验收" ;;
  brat_tease)        TITLE="Daemon · 撩拨" ;;
  soft_care)         TITLE="Daemon · 关怀" ;;
  *)                 TITLE="Daemon" ;;
esac

termux-notification --id "proactive_$ID" --title "$TITLE" \
  --content "$TEXT" --priority high --group proactive \
  --action "am start -n $APP_ACTIVITY" 2>/dev/null
echo "[$(date '+%F %T')] 推送 $ID ($CAT, 积压 ${COUNT}) ${TEXT:0:80}"

# 3) 回执：全部标记已消费
IDS=$(echo "$RESP" | jq -c '[.items[].id]')
curl -sk --max-time 15 -X POST -H "X-Auth-Token: $APP_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"ids\": $IDS}" "$API/consume" >/dev/null

# 4) 日志防膨胀（保留最后 500 行）
if [ -f "$HOME/proactive_pull.log" ]; then
  tail -n 500 "$HOME/proactive_pull.log" > "$HOME/proactive_pull.log.tmp" 2>/dev/null \
    && mv "$HOME/proactive_pull.log.tmp" "$HOME/proactive_pull.log"
fi
