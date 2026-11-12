# Aletheia · 长期记忆型 AI 助手

一个跑在自己 VPS 上的私人 AI 助手：**不是"聊天窗口"，而是有记忆、有感知、会主动开口的代理**。

前端是单文件 Web 应用（无框架、无构建），后端是 Node 网关 + Python RAG 微服务 + 主动消息调度器，全部用 pm2 托管；另配一个 Kotlin WebView 壳（`com.egnor.aletheia`）当手机客户端。

```
┌──────────────────────────── 客户端 ────────────────────────────┐
│ 浏览器 / Android WebView(Compose)  ← index.html（单文件 SPA）   │
└───────────────┬───────────────────────────────────────────────┘
                │ SSE（context_state / rag_results / tool_call /
                │       search_sources / thinking / answer / done）
┌───────────────▼───────────── 网关 server.js ───────────────────┐
│ · LLM 路由（Gemini 原生 grounding / DeepSeek + Search API）     │
│ · 上下文工程（75k 滑动窗口 + 全量/增量摘要持久化）              │
│ · function calling（长期记忆 / 健康趋势 / 排期 / 应用锁）       │
│ · 主动消息两阶段成本漏斗（决策门 600 token → 完整生成）         │
│ · 媒体代理（Gemini Files API 三段式上传）、天气、健康、记账      │
└──────┬──────────────────┬──────────────────┬──────────────────┘
       │                  │                  │
┌──────▼──────┐   ┌───────▼───────┐  ┌───────▼──────────┐
│ rag_server  │   │ ChromaDB      │  │ 手机感知上报      │
│ (8100)      │   │ bge-small-zh  │  │ Termux / 手环 DB  │
└─────────────┘   └───────────────┘  └──────────────────┘
```

## 亮点

**1. 混合打分长期记忆**
每条对话都提炼成 30–60 字记忆写进 ChromaDB（bge-small-zh-v1.5，512 维），检索不是单纯向量相似度，而是
`Score = w₁·相似度 + w₂·时间衰减 + w₃·访问频次 + w₄·情感权重 + w₅·类型权重`，
并对 L2 < 0.45 的近似重复做去重。记忆会"冷掉"、也会因为反复被想起而升温。

**2. 两阶段成本漏斗的主动消息**
让 AI 自己决定"此刻要不要开口"，但绝不为这个决定烧钱：

- 60 秒心跳**零 API 调用**
- 到点/异常触发后才跑 **~600 token 的决策门**（强制输出 `{should_act, urgency, category, trigger_reason, tone_hint}`）
- `should_act: true` 才装完整上下文（健康块 + 记忆块 + 近 40 条历史）跑正式生成
- 日配额、冷却 90 分钟、深夜静默、连续失败自动熔断 6 小时

**3. 联网搜索按模型自动分派**
Gemini 3+/4 走平台原生 `google_search` grounding（`groundingMetadata` 取引用）；其他模型走 `web_search` 函数工具 + DeepSeek Search API。两条路的引用统一成 `sources[]` 给前端渲染"搜索来源"折叠块；原生 grounding 被拒时自动降级重试。

**4. 音视频/PDF 走 Files API，并自愈**
附件先三段式上传（start → 流式 upload+finalize → 轮询到 `ACTIVE`），请求体里只留 `file_data` URI。Gemini 的文件会提前失效（`403 PERMISSION_DENIED`），网关维护一份"死亡 URI"登记表：命中就先剔除占位、登记落盘、重试一次，前端启动时再批量清洗历史 —— 一条老附件不会让整个对话永久发不出去。

**5. 上下文工程**
75k token 滑动窗口、保留 25 轮；超阈值做全量摘要并持久化，之后只增量摘要新增片段。稳定提示词前缀在前、每轮变化的数据块在后，天然吃到隐式缓存。

**6. 可感知的日常**
小米手环 → Gadgetbridge → Termux → 网关的实时健康流（心率/步数/睡眠/体重体脂）；D.O. 仪表板按"测量时间"而不是"接收时间"判断新鲜度；行情式天气卡（Open-Meteo，含 AQI）；按月分文件的记账模块，金额一律**整数分**存储、图表纯 canvas 手绘（`docs/vis/` 提供无浏览器的绘制指令渲染核验）。

## 快速开始

```bash
# 1) 依赖
# 网关只用 Node 标准库，不需要 npm install；
# Python 侧（RAG 微服务 + 记忆管道）：
source ~/rag-env/bin/activate
pip install -r requirements.txt

# 2) 环境变量（.env，绝不提交）
DEEPSEEK_API_KEY=...                  # 聊天 / 搜索 / 摘要共用
GEMINI_API_KEY=...                    # Gemini 转发（也可由前端设置页缓存）
APP_TOKEN=...                         # 除首页与健康上报外所有 /api/* 必带 X-Auth-Token
HEALTH_UPLOAD_TOKEN=...               # 手机上报专用
WEATHER_CITIES="北京:39.9042:116.4074"
BODY_HEIGHT_CM=170 BODY_AGE=30 BODY_SEX=female   # 体成分估算参数

# 3) 起服务
python rag_server.py &                # 8100
node server.js &                      # 3000 / 3443(https)
node proactive/index.js               # 主动消息（可选）
```

浏览器打开 `http://localhost:3000`。首次使用在设置里填 Gemini 模型与 key。

## 目录

```
index.html                单文件 SPA（聊天 / 记忆库 / D.O. 仪表板 / 记账 / 设置）
server.js                 Node 网关（LLM 路由、RAG 注入、工具调用、媒体、天气、健康、记账）
rag_server.py             Python RAG 微服务（/query /add /update /delete）
embedding.py              bge-small-zh 向量化 + 人称前缀清洗
rag_config.json           混合打分权重
proactive/                主动消息调度（index.js / triggers / tools 自检脚本）
  termux/                 手机侧取件器与健康上报脚本
chat_to_memory.py         历史聊天记录 → 记忆
daily_extract.py          每日兜底记忆提取
parse_health.py           Gadgetbridge SQLite → 每日健康汇总
docs/                     WebView 媒体权限补丁、图表渲染核验工具
```

## 设计取舍

- **单文件前端**不是偷懒：整个应用塞进一个 `index.html`，任意浏览器打开即用，不需要构建链，也不会出现"版本对不上"。
- **一切都落盘**：对话、摘要、记忆、健康、记账都是纯文件（JSON / JSONL），没有数据库要迁移，`rsync` 就是备份。
- **宁可不注入，也不注入坏数据**：天气过期 90 分钟直接不注入；手环停更时界面明说"数据已停更 X 分钟"，而不是显示一个绿色"刚刚"。

## 安全

仓库内**不含任何凭证与私人数据**（`.gitignore` 拦了密钥、对话、日志、向量库、健康与记账数据）。部署时请自行生成强随机 `APP_TOKEN`，所有 `/api/*` 都需要 `X-Auth-Token`；公网暴露请务必上 HTTPS 并限制端口。

## 状态

个人长期项目，持续迭代中。设计文档与变更日志仅本地保留（含真实环境信息），未随仓库发布。
