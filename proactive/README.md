# proactive/ · 主动消息守护进程

两阶段成本漏斗：**心跳 60s 不花钱** → 到点/异常/管理员指令才走「阶段一（~700 token 的决策门）」→ 只有 `should_act: true` 才装完整上下文跑「阶段二」。

## 跑法

```bash
# 常驻（线上就是它，pm2 进程名 proactive，root 身份，读 /var/www/app/.env 拿 APP_TOKEN）
sudo pm2 start /var/www/app/proactive/index.js --name proactive --cwd /var/www/app/proactive
sudo pm2 save

# 观察用（跑一次就退出，不常驻）
node index.js --status        # 打印配置 + 状态 + 当前环境切片
node index.js --once          # 跑一次 tick（尊重静默/冷却/配额）
node index.js --force         # 跑一次 tick，忽略定时器/冷却/静默
node index.js --gen brat_tease   # 跳过阶段一，直接跑阶段二看它会说什么（不投递）
```

> ⚠️ **一次性命令不要用 `pm2 start` 起**：pm2 默认退出即重启，`--force/--gen` 会被反复执行（会烧掉当天配额）。要测就用 `pm2 start ... --no-autorestart`，或者直接 `node index.js --force`（注意：手动以 egnor 身份跑读不到 root 600 的 `.env`，会提示 APP_TOKEN 缺失；根上跑或临时 `APP_TOKEN=xxx node index.js --force`）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 心跳主循环 + 状态机 + CLI |
| `triggers.js` | 夜间静默 / 随机定时 / 生理与屏幕异常 / 管理员指令 / 连击追问 / 用户长聊重置 |
| `lib/serverapi.js` | 调 server.js 的内网端点（`/api/proactive/*`） |
| `lib/store.js` | `state/state.json`、`state/history.jsonl`、`state/directives.json` |
| `lib/budget.js` | 随机间隔、配额、时间窗 |
| `config.json` | 总开关与所有阈值（改完下一次 tick 生效，不用重启） |

## 状态机

```
SUSPENDED(开关off) ─┐
BLACKOUT(01:30–08:00)┴→ 零外部 API
IDLE →(定时到点 / 异常 / 管理员指令)→ 冷却&配额闸门 → GATE1(~700 token)
  GATE1 false → 记录后重掷 120–360min
  GATE1 true  → GATE2(完整上下文, ~34k token) → 投递 → 冷却 90min
                 └ 抓包/质问类 且 15min 无回复 → 20min 后补 1 次（上限 1）
```

## 开关与管道

- 总开关：`config.json` 的 `active_push_enabled`
- 投递：`delivery.channel`
  - `dryrun`：只打日志（`[dryrun] 本应发出（category/urgency）：…`），不写对话、不通知
  - **`termux`（当前）**：消息写进目标对话 + 进 `state/pending.json`，等手机 Termux 取件弹通知

### M3 · 手机侧安装（Termux 取件器）

```bash
# 1) 装依赖（Termux:API 这个 App 也要装）
pkg install curl jq termux-api

# 2) 把 proactive/termux/proactive_pull.sh 存成 ~/proactive_pull.sh
#    编辑里面的 APP_TOKEN（= App 里输入的那个服务端 token），然后：
chmod +x ~/proactive_pull.sh
~/proactive_pull.sh          # 手动测一次，应无输出（队列空）

# 3) 加进 cron（和推健康数据同频，每分钟）
crontab -e
# * * * * * /data/data/com.termux/files/home/proactive_pull.sh >> ~/proactive_pull.log 2>&1

# 4) 自测通知链路
termux-notification --title Daemon --content "推送通道 OK" --action "am start -n com.egnor.aletheia/.MainActivity"
```

行为说明：取件时**只把最新一条弹成通知**（Termux 离线久了堆积不刷屏），但所有条都回执消费——消息本身早已写进对话，不会丢。

### 前端实时性（已上线）

App 开着时每 30s 拉一次 `/api/conversations/<id>/since?after=<已读条数>`（空结果只有 65 字节，对比全量 16MB），有新消息就追加渲染并自动滚到底；主动消息在气泡上带一个「主动 · 类别」小标签。切回前台（visibilitychange / focus）也会立刻拉一次。

## 管理端

```bash
# 看/改配置（改的是同一个 config.json）
curl -H "X-Auth-Token: $TOKEN" https://127.0.0.1:3443/api/proactive/config
curl -X POST -H "X-Auth-Token: $TOKEN" -H 'Content-Type: application/json' \
     -d '{"active_push_enabled":false}' https://127.0.0.1:3443/api/proactive/config

# 管理员指令（阶段一时优先于随机数；也支持模型 function calling 写入）
cat > state/directives.json <<'EOF'
[{"at": 1791600000000, "condition": "check_homework", "tone": "验收口吻", "category": "homework_progress", "consumed": false}]
EOF

# 看决策日志
curl -H "X-Auth-Token: $TOKEN" "https://127.0.0.1:3443/api/proactive/log?limit=30"
```

## 屏幕活动上报（MacroDroid/Tasker）

```
GET https://YOUR_SERVER_IP:3443/api/activity?pkg=com.xingin.xhs&label=小红书&event=open&token=$TOKEN
GET .../api/activity?pkg=com.xingin.xhs&label=小红书&event=close&token=$TOKEN
```
每个 App 建两个宏（打开/关闭）→ HTTP Request 动作。服务端按 pkg 配对算今日时长与"当前连续前台时长"，喂给阶段一。
