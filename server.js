const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// 极简 .env 加载（同目录），存在的 process.env 不覆盖
(function loadDotenv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      // 去掉成对的引号
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
    console.log(`[env] loaded from ${envPath}`);
  } catch (e) {
    console.error('[env] load error:', e.message);
  }
})();

const PORT = 3000;
const HTTPS_PORT = 3443;
const GEMINI_HOST = 'generativelanguage.googleapis.com';

// ===== 用量审计（对账用）=====
// 每次真实 API 调用落一行到 usage/usage-YYYY-MM-DD.jsonl，字段：
//   ts / provider / model / kind / convId / in / out / think / cached / search / ok / ms
// Google 侧只给总账，这边给「谁花在哪」。关掉：USAGE_LOG=off
const USAGE_DIR = path.join(__dirname, 'usage');
const USAGE_LOG_ON = String(process.env.USAGE_LOG || 'on').toLowerCase() !== 'off';
// USD / 1M tokens：[输入, 输出, 图片输出]（图片模型才有第三项）
const SERVER_PRICE = {
  'gemini-4-carbon': [2.00, 10.00],
  'gemini-4-argon': [2.00, 10.00],
  'gemini-4-hydrogen': [1.50, 7.50],
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-3.6-flash': [0.75, 3.75],
  'gemini-3.5-flash-lite': [0.30, 2.50],
  'gemini-3.1-pro-preview': [2.00, 12.00],
  'gemini-3.1-flash-lite': [0.25, 1.50],
  'gemini-2.5-pro': [1.25, 10.00],
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-nano-banana-2.1': [1.50, 7.50, 30.00],
  'gemini-3-pro-image': [2.00, 12.00, 120.00],
  'gemini-3.1-flash-image': [0.50, 3.00, 60.00],
  'gemini-3.1-flash-lite-image': [0.25, 1.50, 30.00],
  'gemini-2.5-flash-image': [0.30, 2.50, 39.00],
  'gemini-3.7-flash': [0.75, 3.75],
  'gemini-3.5-flash': [0.75, 3.75],
  'gemini-3.1-flash-lite-preview': [0.25, 1.50],
  'gemini-3-flash-preview': [0.75, 3.75],
  'gemini-3-pro-image-preview': [2.00, 12.00, 120.00],
  'gemini-3.1-flash-image-preview': [0.50, 3.00, 60.00],
};
function logUsage(rec) {
  if (!USAGE_LOG_ON) return;
  try {
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(USAGE_DIR, `usage-${day}.jsonl`), JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
  } catch (e) { /* 审计失败不影响主流程 */ }
}
// 一份用量记录 → 美元估算（缓存命中部分按 25% 计价）
function usageCostUsd(rec) {
  const p = SERVER_PRICE[rec.model];
  if (!p) return 0;
  const cached = Math.min(rec.cached || 0, rec.in || 0);
  const fresh = Math.max(0, (rec.in || 0) - cached);
  const out = (rec.out || 0) + (rec.think || 0);
  return (fresh / 1e6) * p[0] + (cached / 1e6) * p[0] * 0.25 + (out / 1e6) * p[1];
}

// ===== 对话日志 =====
const CHAT_LOG_DIR = path.join(__dirname, 'logs');
function logChat(role, text, thought) {
  try {
    if (!text && !thought) return;
    if (!fs.existsSync(CHAT_LOG_DIR)) fs.mkdirSync(CHAT_LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(CHAT_LOG_DIR, `${date}.jsonl`);
    const entry = { timestamp: new Date().toISOString(), role, content: text || '' };
    if (thought) entry.thought = thought;
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    console.error('[logChat] write failed:', e.message);
  }
}

// Auto-detect proxy from environment
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY
               || process.env.http_proxy  || process.env.HTTP_PROXY
               || null;

if (PROXY_URL) console.log(`Using upstream proxy: ${PROXY_URL}`);
else console.log('No upstream proxy detected (direct connection)');

// HTTPS request through HTTP CONNECT tunnel
function httpsViaTunnel(proxyUrl, targetHost, targetPort, requestOptions, postData) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const connectReq = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 1080,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });
    connectReq.setTimeout(30000, () => connectReq.destroy(new Error('CONNECT tunnel timeout')));
    connectReq.on('error', reject);
    connectReq.on('connect', (_res, socket) => {
      const req = https.request({ ...requestOptions, socket, servername: targetHost }, resolve);
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('Gemini API timeout')));
      req.write(postData);
      req.end();
    });
    connectReq.end();
  });
}

// ===== RAG memory retrieval with hybrid scoring =====
const RAG_BASE = 'http://127.0.0.1:8100';
const RAG_TIMEOUT = 10000;

// Load scoring config (hot-reloadable by restarting server)
const RAG_CONFIG_PATH = path.join(__dirname, 'rag_config.json');
let RAG_CONFIG = {
  weights: { similarity: 0.40, time_decay: 0.25, frequency: 0.10, emotion: 0.15, type: 0.10 },
  time_decay_rate: 0.05,
  candidate_pool: 20,
  final_top_k: 5,
  max_distance: 1.5,
};
try {
  if (fs.existsSync(RAG_CONFIG_PATH)) {
    RAG_CONFIG = { ...RAG_CONFIG, ...JSON.parse(fs.readFileSync(RAG_CONFIG_PATH, 'utf8')) };
    console.log('Loaded rag_config.json');
  }
} catch (e) {
  console.log('rag_config.json parse error, using defaults:', e.message);
}

function ragPost(action, payload, timeout = RAG_TIMEOUT) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(payload);
    const req = http.request(`${RAG_BASE}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function scoreMemory(m, cfg) {
  const w = cfg.weights;

  // S: similarity — clamp to [0, 1]
  const S = Math.max(0, 1 - (m.distance ?? 1));

  // T: time decay. Missing date → neutral 0.5.
  const days = daysSince(m.date);
  const T = days === null ? 0.5 : Math.exp(-cfg.time_decay_rate * days);

  // F: frequency — log(1 + access_count), soft-capped to ~1.0 by /log(1+20)≈3.04
  const F = Math.log(1 + (m.access_count || 0)) / Math.log(1 + 20);

  // E / M: stored directly in metadata
  const E = typeof m.emotion_weight === 'number' ? m.emotion_weight : 0;
  const M = typeof m.memory_type_weight === 'number' ? m.memory_type_weight : 0.4;

  return w.similarity * S + w.time_decay * T + w.frequency * F + w.emotion * E + w.type * M;
}

async function queryRAG(text) {
  const data = await ragPost('query', {
    text,
    n_results: RAG_CONFIG.candidate_pool,
    max_distance: RAG_CONFIG.max_distance,
  });
  if (!data || !Array.isArray(data.memories) || data.memories.length === 0) return [];

  // Hybrid rescoring
  const scored = data.memories.map(m => ({ ...m, _score: scoreMemory(m, RAG_CONFIG) }));
  scored.sort((a, b) => b._score - a._score);
  const top = scored.slice(0, RAG_CONFIG.final_top_k);

  // Fire-and-forget: bump access_count for used memories
  if (top.length > 0) {
    ragPost('increment_access', { ids: top.map(m => m.id) }, 5000)
      .catch(() => {}); // swallow errors silently
  }

  return top;
}

async function queryMemos() {
  const data = await ragPost('query_memos', { today: todayDate() });
  if (!data || !Array.isArray(data.memos)) return [];
  return data.memos;
}

// ===== Autonomous memory saving (Gemini function calling) =====
const SAVE_MEMORY_TOOL = {
  functionDeclarations: [{
    name: 'save_memory',
    description: '当对话中出现值得长期记住的信息时调用。包括：生生分享的个人经历、偏好变化、重要事件、情感表达、新的事实信息。不要记录闲聊寒暄。静默执行，不要在文本回复中提及已保存。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: "要记住的内容，用第三人称，以'生生'指代用户，以'Daemon'指代你自己。每条只讲一件独立的事，30-60字。信息密集时拆成多次 save_memory 调用，不要把多个主题塞进一条。",
        },
        type: {
          type: 'string',
          enum: ['event', 'preference', 'fact', 'note'],
          description: '记忆类型',
        },
        emotion_weight: {
          type: 'number',
          description: '情感强度，0-1',
        },
        memory_level: {
          type: 'string',
          enum: ['memo', 'memory'],
          description: 'memo：短期重要信息，会全量注入每次对话（如近期计划、当前心情、进行中的事项）。memory：长期存档信息（如个人事实、偏好、历史事件）。默认选 memory。',
        },
      },
      required: ['content', 'type', 'emotion_weight', 'memory_level'],
    },
  }],
};

const GET_HEALTH_TREND_TOOL = {
  functionDeclarations: [{
    name: 'get_health_trend',
    description: '查询生生最近几小时的心率、步数、压力变化趋势。当用户询问自己的健康状况变化、心率走势、最近几小时状态时调用。',
    parameters: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: '查询最近几小时的数据，默认3',
        },
      },
    },
  }],
};

const DEEPSEEK_HEALTH_TREND_TOOL = {
  type: 'function',
  function: {
    name: 'get_health_trend',
    description: GET_HEALTH_TREND_TOOL.functionDeclarations[0].description,
    parameters: {
      type: 'object',
      properties: GET_HEALTH_TREND_TOOL.functionDeclarations[0].parameters.properties,
    },
  },
};

const LOCK_APP_TOOL = {
  functionDeclarations: [{
    name: 'lock_app',
    description: '锁定或解锁用户手机上的应用。锁定后用户无法打开该应用。用于帮助用户控制手机使用习惯。',
    parameters: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          items: { type: 'string' },
          description: "要操作的应用包名列表，如 ['com.xingin.xhs']。传空数组表示解锁全部。",
        },
        action: {
          type: 'string',
          enum: ['lock', 'unlock'],
          description: 'lock=锁定, unlock=解锁',
        },
      },
      required: ['apps', 'action'],
    },
  }],
};

const PROACTIVE_CATEGORIES = ['health_anomaly', 'screen_time_audit', 'homework_progress', 'brat_tease', 'soft_care'];

const SCHEDULE_NUDGE_TOOL = {
  functionDeclarations: [{
    name: 'schedule_nudge',
    description: '安排一次“主动开口”：到点后 Daemon 会自己来找生生说话（走两阶段漏斗，会重新判断当时该不该说）。用于“晚点来查我作业”“两小时后提醒我喝水”“明早叫我起床”这类定点跟进，也可以是你自己判断需要跟进的事。不要滥用，一次只排一件。调用前先看你上下文里的 [主动提醒排期]：同一件事已经排过就不要再排第二遍（服务端也会拦重复），排期到点触发后不要再重复追。',
    parameters: {
      type: 'object',
      properties: {
        delay_minutes: { type: 'number', description: '多少分钟后触发，5~1440（一天以内）' },
        condition: { type: 'string', description: '到点要做什么/要检查什么，一句话。会作为触发原因注入那次主动消息' },
        tone: { type: 'string', description: '语气提示，可选，如“验收口吻”“温柔”“揶揄”' },
        category: { type: 'string', enum: PROACTIVE_CATEGORIES, description: '切入点分类，可选；不填由到时的判断决定' },
      },
      required: ['delay_minutes', 'condition'],
    },
  }],
};

const DEEPSEEK_SCHEDULE_NUDGE_TOOL = {
  type: 'function',
  function: {
    name: 'schedule_nudge',
    description: SCHEDULE_NUDGE_TOOL.functionDeclarations[0].description,
    parameters: {
      type: 'object',
      properties: SCHEDULE_NUDGE_TOOL.functionDeclarations[0].parameters.properties,
      required: SCHEDULE_NUDGE_TOOL.functionDeclarations[0].parameters.required,
    },
  },
};

function directivePath() { return path.join(PROACTIVE_STATE_DIR, 'directives.json'); }

// --- 工具调用记录（解决"调完就忘，下一轮又重新调一次"）---
function toolCallsPath() { return path.join(PROACTIVE_STATE_DIR, 'tool-calls.json'); }
function recordToolCall({ tool, summary, status = 'ok', meta = null }) {
  const now = Date.now();
  const rec = {
    at: now,
    time: new Date(now).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }),
    tool: String(tool || '').slice(0, 24),
    status: String(status || 'ok').slice(0, 24),
    summary: String(summary || '').slice(0, 140),
    ...(meta ? { meta } : {}),
  };
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(toolCallsPath(), 'utf8')); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(rec);
    fs.mkdirSync(PROACTIVE_STATE_DIR, { recursive: true });
    fs.writeFileSync(toolCallsPath(), JSON.stringify(arr.slice(-80)), 'utf8');
  } catch (e) { console.error('[tool-calls] 写入失败:', e.message); }
  return rec;
}
function recentToolCalls(limit = 8) {
  try {
    const arr = JSON.parse(fs.readFileSync(toolCallsPath(), 'utf8'));
    return Array.isArray(arr) ? arr.slice(-limit) : [];
  } catch { return []; }
}

function hhmmLocal(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
}

// 已排期 / 刚触发过的主动提醒：明确告诉模型"这件事你已经排过了"
function formatDirectiveBlock() {
  const now = Date.now();
  const arr = listProactiveDirectives().filter(d => d && d.at);
  const upcoming = arr.filter(d => !d.consumed && d.at > now - 60000).sort((a, b) => a.at - b.at).slice(0, 5);
  const fired = arr.filter(d => d.consumed || d.at <= now).sort((a, b) => b.at - a.at).slice(0, 3)
    .filter(d => now - d.at < 8 * 3600 * 1000);
  if (!upcoming.length && !fired.length) return '';
  const lines = ['[主动提醒排期（你之前用 schedule_nudge 排的；同一件事别再排第二遍）]'];
  for (const d of upcoming) {
    const mins = Math.max(0, Math.round((d.at - now) / 60000));
    lines.push(`- ${hhmmLocal(d.at)} 触发（还有 ${mins} 分钟，未触发）：${d.condition}`);
  }
  for (const d of fired) lines.push(`- ${hhmmLocal(d.at)}（已触发）：${d.condition}`);
  lines.push('[排期结束]');
  return lines.join('\n') + '\n\n';
}

// 除了排期之外的其它工具调用（记记忆、锁应用等），避免重复调用
function formatToolCallBlock() {
  const calls = recentToolCalls(20).filter(c => c && c.tool !== 'schedule_nudge').slice(-6);
  if (!calls.length) return '';
  const lines = ['[最近工具调用（这些已经做过了，别再做一遍）]'];
  for (const c of calls) lines.push(`- ${c.time} ${c.tool}${c.status && c.status !== 'ok' ? `（${c.status}）` : ''}：${c.summary}`);
  lines.push('[工具调用记录结束]');
  return lines.join('\n') + '\n\n';
}

// 写一条管理员指令（模型调用 schedule_nudge 或人工调 API 都走这里）
function addProactiveDirective({ delay_minutes, condition, tone, category, source }) {
  const mins = Math.max(5, Math.min(1440, Math.round(Number(delay_minutes) || 60)));
  const safeCat = PROACTIVE_CATEGORIES.includes(category) ? category : null;
  const cond = String(condition || '').slice(0, 120);
  const at = Date.now() + mins * 60000;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(directivePath(), 'utf8')); } catch {}
  if (!Array.isArray(arr)) arr = [];

  // 去重硬闸门：同一件事还排着没触发 → 不再排第二条（模型经常会"忘了已经排过"）
  const dup = arr.find(d => d && !d.consumed && String(d.condition || '').trim() === cond.trim() && Math.abs((d.at || 0) - at) < 15 * 60000);
  if (dup) {
    recordToolCall({ tool: 'schedule_nudge', status: 'duplicate', summary: `重复排期被拦下：${cond}` });
    console.log(`[schedule_nudge] 已存在同一件事（${hhmmLocal(dup.at)} 触发），本次不重复排：${cond}`);
    return { ...dup, duplicate: true };
  }

  const dir = {
    at, condition: cond,
    tone: tone ? String(tone).slice(0, 40) : null,
    category: safeCat,
    source: String(source || 'model').slice(0, 20),
    consumed: false,
    created: Date.now(),
  };
  arr.push(dir);
  try {
    fs.mkdirSync(PROACTIVE_STATE_DIR, { recursive: true });
    fs.writeFileSync(directivePath(), JSON.stringify(arr.slice(-50), null, 2), 'utf8');
    console.log(`[schedule_nudge] 已排期 +${mins} 分钟（${new Date(dir.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）：${dir.condition}`);
  } catch (e) { console.error('[schedule_nudge] 写入失败:', e.message); }
  recordToolCall({
    tool: 'schedule_nudge',
    summary: `${mins} 分钟后（${hhmmLocal(dir.at)}）：${cond}`,
    meta: { at: dir.at, source: dir.source },
  });
  return dir;
}
function listProactiveDirectives() {
  try {
    const arr = JSON.parse(fs.readFileSync(directivePath(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

const DEEPSEEK_LOCK_APP_TOOL = {
  type: 'function',
  function: {
    name: 'lock_app',
    description: LOCK_APP_TOOL.functionDeclarations[0].description,
    parameters: {
      type: 'object',
      properties: LOCK_APP_TOOL.functionDeclarations[0].parameters.properties,
      required: LOCK_APP_TOOL.functionDeclarations[0].parameters.required,
    },
  },
};

// ===== AutoCLI（网站数据抓取，2026-09 接入）=====
// 单二进制 CLI，把网站变成命令行接口。
// - public 站点：VPS 本地直接执行（纯 API，无需浏览器）
// - browser 站点：经 SSH 反向隧道转发到本地电脑的 autocli daemon（复用 Chrome 登录态）
const AUTOCLI_BIN = '/usr/local/bin/autocli';
const AUTOCLI_BRIDGE_PORT = 29925; // 隧道端口：VPS 29925 → 本地电脑 daemon 19925

// 浏览器类站点（需本地 Chrome 桥接）
const AUTOCLI_BROWSER_SITES = {
  twitter: ['trending', 'search', 'timeline', 'profile', 'thread', 'post', 'reply', 'delete', 'like', 'bookmarks', 'bookmark', 'unbookmark', 'following', 'followers', 'notifications', 'article', 'download', 'follow', 'unfollow'],
};

// public 站点（VPS 本地可执行）
const AUTOCLI_PUBLIC_SITES = {
  hackernews:    ['top', 'new', 'best', 'ask', 'show', 'jobs', 'search', 'user'],
  stackoverflow: ['hot', 'search', 'bounties', 'unanswered'],
  v2ex:          ['hot', 'latest', 'topic', 'node', 'replies'],
  devto:         ['top', 'tag', 'user'],
};

const AUTOCLI_ALLOWED = { ...AUTOCLI_PUBLIC_SITES, ...AUTOCLI_BROWSER_SITES };

// 探测端口是否可连（用于判断本地桥接隧道是否在线，避免 CLI 自行 spawn 本地 daemon 占端口）
function probePort(port, timeoutMs = 1500) {
  const net = require('net');
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

const AUTOCLI_TOOL = {
  functionDeclarations: [{
    name: 'fetch_site',
    description: '抓取网站的结构化实时数据（热榜、搜索、发帖等）。可用站点：hackernews（科技热帖，top/new/best/ask/show/jobs/search）、stackoverflow（技术问答，hot/search）、v2ex（中文技术社区，hot/latest/topic）、devto（开发者博客，top/tag）、twitter/X（trending 趋势、search 搜索推文、timeline 时间线、profile 用户主页、thread 推文串、post 发推、reply 回复、like 点赞、bookmarks 书签、notifications 通知）。当用户想了解热点、搜索内容或操作 Twitter/X 时使用。注意 twitter 需用户电脑保持开机联网（本地 Chrome 桥接），不可用时会返回提示。',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '站点名：hackernews / stackoverflow / v2ex / devto / twitter' },
        command: { type: 'string', description: 'hackernews: top|new|best|ask|show|jobs|search；stackoverflow: hot|search；v2ex: hot|latest|topic；devto: top|tag；twitter: trending|search|timeline|profile|thread|post|reply|like|bookmarks|notifications' },
        query: { type: 'string', description: '搜索关键词 / 用户名 / 推文 URL / 发布内容（search、profile、thread、post 等命令需要）' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 20' },
      },
      required: ['site', 'command'],
    },
  }],
};

const DEEPSEEK_AUTOCLI_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_site',
    description: AUTOCLI_TOOL.functionDeclarations[0].description,
    parameters: AUTOCLI_TOOL.functionDeclarations[0].parameters,
  },
};

// 执行 autocli（白名单 + 超时 + 输出截断；浏览器类站点经本地桥接隧道）
function runAutocli(args = {}) {
  const { execFile } = require('child_process');
  return new Promise(async (resolve) => {
    const site = String(args.site || '').trim();
    const command = String(args.command || '').trim();
    const cmds = AUTOCLI_ALLOWED[site];
    if (!cmds) {
      return resolve({ error: `不支持的站点: ${site}`, available_sites: Object.keys(AUTOCLI_ALLOWED) });
    }
    if (!cmds.includes(command)) {
      return resolve({ error: `站点 ${site} 不支持命令: ${command}`, available_commands: cmds });
    }
    const isBridge = !!AUTOCLI_BROWSER_SITES[site];
    // 浏览器类命令需本地 Chrome：先探测隧道，断线时快速失败（不执行 CLI，避免其自行 spawn 本地 daemon 占端口）
    if (isBridge) {
      const online = await probePort(AUTOCLI_BRIDGE_PORT);
      if (!online) {
        console.log(`[autocli] bridge offline (port ${AUTOCLI_BRIDGE_PORT})`);
        return resolve({ error: '本地 Chrome 桥接未连接', hint: '需要你的电脑处于唤醒状态且隧道已启动（电脑睡眠/关机时该功能不可用）' });
      }
    }
    const n = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 20);
    const argv = [site, command];
    if (args.query) argv.push(String(args.query).slice(0, 300));
    argv.push('--limit', String(n), '--format', 'json');
    const opts = {
      timeout: isBridge ? 90000 : 25000,
      maxBuffer: 4 * 1024 * 1024,
    };
    if (isBridge) opts.env = { ...process.env, AUTOCLI_DAEMON_PORT: String(AUTOCLI_BRIDGE_PORT) };
    console.log(`[autocli] exec${isBridge ? ' (bridge)' : ''}: ${site} ${command}${args.query ? ' ' + String(args.query).slice(0, 60) : ''} (limit=${n})`);
    execFile(AUTOCLI_BIN, argv, opts, (err, stdout, stderr) => {
      if (err) {
        console.error('[autocli] failed:', err.message, String(stderr || '').slice(0, 300));
        const detail = String(stderr || err.message).slice(0, 300);
        const hint = /extension not connected|not connected to the daemon/i.test(detail)
          ? '（Chrome 扩展未连接：确认电脑上 Chrome 已打开且加载了 autocli 扩展）'
          : '';
        return resolve({ error: 'autocli 执行失败' + hint, detail });
      }
      let out = String(stdout || '').trim();
      if (!out) return resolve({ error: 'autocli 无输出（该命令可能需要浏览器桥接）' });
      if (out.length > 8000) out = out.slice(0, 8000) + '\n...(输出过长已截断)';
      console.log(`[autocli] ok: ${site} ${command}, ${out.length} chars`);
      resolve({ site, command, result: out });
    });
  });
}

const APP_PKG_MAP = `
常用应用包名：
小红书=com.xingin.xhs, X/Twitter=com.twitter.android, QQ=com.tencent.mobileqq,
微信=com.tencent.mm, B站=tv.danmaku.bili, 抖音=com.ss.android.ugc.aweme,
豆包=com.larus.nova, 钉钉=com.alibaba.android.rimet, 米画师=com.xiaomi.mipicks.drawing
`;

// ===== 滑动上下文窗口 + 历史摘要 =====
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';
// 触发压缩的阈值：现在是「整个请求」的估算 token（chars/1.5）——
// systemInstruction（含健康/记忆块）+ tools 函数声明 + 摘要 + 未摘要对话，全都算进来。
// 旧口径只算对话窗口的 60000，实测真实 prompt 会到 85-88k；这里 +~14k 固定开销折成 75000，
// 触发点和以前基本一致，但 system instruction / memo / tools 再变胖时窗口会自动让位，prompt 真正被封顶。
const TOKEN_LIMIT = 75000;
const KEEP_ROUNDS = 25;          // 保留最近 N 轮（一轮 = user + model）
const summaryCache = new Map();   // hash → summary string（无 convId 时的内存兜底）
const SUMMARIES_DIR = path.join(__dirname, 'summaries');
try { fs.mkdirSync(SUMMARIES_DIR, { recursive: true }); } catch {}

function sanitizeConvId(id) {
  if (!id || typeof id !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
  return id;
}
function summaryPath(convId) { return path.join(SUMMARIES_DIR, `${convId}.json`); }
function loadSummary(convId) {
  const safe = sanitizeConvId(convId);
  if (!safe) return null;
  try {
    const txt = fs.readFileSync(summaryPath(safe), 'utf8');
    const obj = JSON.parse(txt);
    if (obj && typeof obj.summary === 'string' && Number.isFinite(obj.summarizedCount)) return obj;
  } catch {}
  return null;
}
function saveSummary(convId, data) {
  const safe = sanitizeConvId(convId);
  if (!safe) return;
  try {
    fs.writeFileSync(summaryPath(safe), JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error('[summary] save failed:', e.message);
  }
}

function estimateTokens(contents) {
  let chars = 0;
  for (const msg of contents) {
    for (const part of (msg.parts || [])) {
      if (part.text) chars += part.text.length;
      // inline_data (images) roughly 258 tokens each
      if (part.inline_data) chars += 400;
    }
  }
  return Math.ceil(chars / 1.5);
}

// 单段文本的估算 token（同一口径：chars/1.5）
function estimateTextTokens(text) {
  return text ? Math.ceil(text.length / 1.5) : 0;
}
// tools（functionDeclarations 的 JSON）也要算进输入 token
function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try { return estimateTextTokens(JSON.stringify(tools)); } catch { return 0; }
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

const SUMMARY_PROMPT = `请将以下对话压缩为一段简洁的摘要，保留关键信息：
- 讨论的主要话题和结论
- 用户表达的偏好、决定、情绪
- 未完成的事项或待办
- 重要的事实和数据

摘要控制在 200-300 字以内，用第三人称，以"生生"指代用户。
不要逐轮复述，提炼核心信息即可。`;

const INCREMENTAL_SUMMARY_PROMPT = `下面是一段对话的旧摘要，以及之后新增的对话片段。
请把新增片段的关键信息融合进旧摘要，输出更新后的统一摘要：
- 保留旧摘要中仍然重要的内容
- 加入新片段里的新话题、新决定、新偏好、新事实
- 过期、被推翻、已完成的事项可以删掉

仍然控制在 200-400 字以内，用第三人称，以"生生"指代用户。直接输出新摘要正文，不要加前缀说明。`;

async function callDeepSeekSummary(text) {
  if (!DEEPSEEK_API_KEY) return null;
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: text },
      ],
    });
    const url = new URL(DEEPSEEK_BASE_URL + '/chat/completions');
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.choices?.[0]?.message?.content?.trim() || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

async function callDeepSeekIncrementalSummary(oldSummary, newText) {
  if (!DEEPSEEK_API_KEY) return null;
  const userMsg = `[旧摘要]\n${oldSummary}\n\n[新增对话]\n${newText}`;
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: INCREMENTAL_SUMMARY_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const url = new URL(DEEPSEEK_BASE_URL + '/chat/completions');
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.choices?.[0]?.message?.content?.trim() || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

function formatContentsForSummary(contents) {
  const lines = [];
  for (const msg of contents) {
    const role = msg.role === 'user' ? '用户' : 'AI';
    const texts = (msg.parts || []).filter(p => p.text).map(p => {
      const t = p.text;
      return t.length > 600 ? t.slice(0, 600) + '...' : t;
    });
    if (texts.length > 0) lines.push(`${role}：${texts.join('\n')}`);
  }
  return lines.join('\n');
}

// 滑动上下文窗口
// contents 可以是「完整历史」，也可以是前端按 historyOffset 裁过的尾巴。
// fixedTokens = systemInstruction（含健康/记忆块）+ tools 的估算 token：
// 以前只量对话窗口，真实 prompt 能比 TOKEN_LIMIT 大一大截（实测 88k）；现在一起算。
async function applyContextWindow(contents, convId, opts = {}) {
  const safeConv = sanitizeConvId(convId);
  const cached = safeConv ? loadSummary(safeConv) : null;
  const fixedTokens = Math.max(0, Math.round(Number(opts.fixedTokens) || 0));
  // historyOffset 是「完整历史」里的绝对起点，尾巴长度跟它无关，不能拿 contents.length 去夹
  const offset = Math.max(0, Math.round(Number(opts.historyOffset) || 0));

  // 构建工作上下文：摘要 + 未被摘要覆盖的近期消息
  const summaryMsgs = [];
  let recentStart = 0;      // 相对本次收到的 contents
  let summaryCovers = 0;    // 摘要覆盖到「完整历史」的第几条（绝对下标）

  // 至少要给模型留多少条「真实消息」：摘要只有 1-2k 字，顶不上几十轮对话。
  // 前端在「重新生成 / 历史被重载」时会发来比摘要边界长不了多少的数组，
  // 只按摘要边界切的话 recent 会掉到个位数 → 输入 token 从 8 万暴跌到 1.7 万、模型整段失忆。
  const keepCount = KEEP_ROUNDS * 2;

  if (cached && cached.summary && cached.summarizedCount > 0) {
    const rel = cached.summarizedCount - offset;   // 摘要覆盖范围内的部分，在本次 contents 里占多少条
    if (rel > contents.length) {
      // 摘要坐标和这次收到的历史对不上（前端重建/截短过历史坐标漂了）→ 把边界夹回数组内，
      // 只用「摘要 + 最近 KEEP_ROUNDS 轮真实消息」，绝不把整段历史当窗口（那会造出 400 万 token 的请求）
      recentStart = Math.max(0, contents.length - keepCount);
      summaryCovers = offset + recentStart;      // 告诉前端一个它数组里真实存在的坐标，顺便自愈漂移
      console.warn(`[context-window] 摘要 covers [0,${cached.summarizedCount}) 超出收到的 ${contents.length} 条（offset=${offset}）→ 边界夹到 ${summaryCovers}，只用摘要+最近 ${keepCount} 条`);
    } else {
      summaryCovers = cached.summarizedCount;
      recentStart = Math.max(0, rel);
    }
    summaryMsgs.push(
      { role: 'user', parts: [{ text: `[以下是之前对话的摘要]\n${cached.summary}\n[摘要结束，以下是近期对话]` }] },
      { role: 'model', parts: [{ text: '好的，我已了解之前的对话内容，请继续。' }] },
    );
  }

  // 摘要边界再靠前，也不能吃掉最近 KEEP_ROUNDS 轮（多带一点真实消息，跟摘要重叠无害）
  const minStart = Math.max(0, contents.length - keepCount);
  if (recentStart > minStart) {
    console.log(`[context-window] 摘要边界 ${recentStart} 太靠前 → 回退到 ${minStart}（保证最近 ${keepCount} 条以真实消息带给模型）`);
    recentStart = minStart;
  }

  const recentPart = contents.slice(recentStart);
  const activeContext = [...summaryMsgs, ...recentPart];
  const windowTokens = estimateTokens(activeContext);
  const activeTokens = windowTokens + fixedTokens;

  console.log(`[context-window] conv=${safeConv || '-'}, summary covers [0,${summaryCovers}), offset=${offset}, recent=${recentPart.length} msgs (cut@${recentStart}), window=${windowTokens} + fixed=${fixedTokens} = ${activeTokens} tokens / ${TOKEN_LIMIT}`);

  const state = {
    summarizedCount: summaryCovers,
    historyOffset: offset,
    windowTokens,
    fixedTokens,
    totalTokens: activeTokens,
    limit: TOKEN_LIMIT,
  };

  // 未超限 → 直接用
  if (activeTokens < TOKEN_LIMIT) {
    return { contents: activeContext, compressed: null, state };
  }

  // 超限 → 压缩：保留最近 KEEP_ROUNDS 轮，其余增量摘要
  console.log(`[context-window] ${activeTokens} tokens exceeds ${TOKEN_LIMIT}, compressing...`);
  let cutIdx = Math.max(0, recentPart.length - keepCount);
  while (cutIdx < recentPart.length && recentPart[cutIdx].role !== 'user') cutIdx++;
  if (cutIdx <= 0) return { contents: activeContext, compressed: null, state };

  const toSummarize = recentPart.slice(0, cutIdx);
  const keptRecent = recentPart.slice(cutIdx);

  // 摘要输入上限：正常增量只喂 ~20 条，但「摘要边界失效」时会一次溢出几千条
  // （实测出现过 6501 条 / 213 万字符 → DeepSeek 必然超限失败）。取最近 MAX_SUMMARY_MSGS 条，
  // 中间那段本来就由旧摘要文本代表，喂不下也不会更差。
  const MAX_SUMMARY_MSGS = 400;
  const deltaMsgs = toSummarize.length > MAX_SUMMARY_MSGS ? toSummarize.slice(-MAX_SUMMARY_MSGS) : toSummarize;

  let newSummary = null;
  let summaryUpdated = false;

  if (cached && cached.summary) {
    // 增量：把新溢出的消息合并进已有摘要
    const deltaText = formatContentsForSummary(deltaMsgs);
    if (deltaMsgs.length !== toSummarize.length) {
      console.warn(`[context-window] 溢出的 ${toSummarize.length} 条超过摘要输入上限，只喂最近 ${deltaMsgs.length} 条（${deltaText.length} chars）`);
    }
    console.log(`[context-window] incremental: +${deltaMsgs.length} msgs (${deltaText.length} chars)`);
    const merged = await callDeepSeekIncrementalSummary(cached.summary, deltaText);
    newSummary = merged || cached.summary;
    summaryUpdated = !!merged;
  } else {
    // 首次：全量摘要被截掉的部分
    const allOld = contents.slice(0, recentStart + cutIdx);
    if (offset > 0) {
      console.warn(`[context-window] 没有摘要但前端已裁掉前 ${offset} 条，本次摘要只能覆盖收到的部分`);
    }
    const oldMsgs = allOld.length > MAX_SUMMARY_MSGS ? allOld.slice(-MAX_SUMMARY_MSGS) : allOld;
    const oldText = formatContentsForSummary(oldMsgs);
    console.log(`[context-window] first-time summary: ${oldMsgs.length} msgs (${oldText.length} chars)`);
    newSummary = await callDeepSeekSummary(oldText);
    summaryUpdated = !!newSummary;
  }

  // 持久化摘要（summarizedCount 用「完整历史」的绝对下标，前端裁过尾巴也能对齐）
  const newSummarizedCount = offset + recentStart + cutIdx;
  if (newSummary && safeConv) {
    saveSummary(safeConv, { summary: newSummary, summarizedCount: newSummarizedCount, updatedAt: Date.now() });
    console.log(`[context-window] summary saved: ${newSummary.length} chars, covers [0,${newSummarizedCount})`);
  } else if (newSummary && !safeConv) {
    const hash = simpleHash(newSummary);
    summaryCache.set(hash, newSummary);
  }

  const result = [];
  if (newSummary) {
    result.push(
      { role: 'user', parts: [{ text: `[以下是之前对话的摘要]\n${newSummary}\n[摘要结束，以下是近期对话]` }] },
      { role: 'model', parts: [{ text: '好的，我已了解之前的对话内容，请继续。' }] },
    );
  }
  result.push(...keptRecent);

  if (newSummary) state.summarizedCount = newSummarizedCount;
  const newTokens = estimateTokens(result) + fixedTokens;
  console.log(`[context-window] compressed: ${contents.length} → ${result.length} msgs, ${activeTokens} → ${newTokens} tokens`);
  return {
    contents: result,
    state,
    compressed: summaryUpdated ? {
      originalMessages: activeContext.length,
      keptMessages: result.length,
      originalTokens: activeTokens,
      newTokens,
      summarizedCount: newSummarizedCount,
      historyOffset: offset,
    } : null,
  };
}

const SAVE_MEMORY_PROMPT = `
---
你可以使用 save_memory 工具记住重要信息。
判断标准：如果这个信息在未来的对话中可能有用，就记住它。仅当对话中出现极高的情感浓度时触发。
记忆用第三人称书写，用"生生"指代用户，用"Daemon"指代你自己。
每条记忆只承载一件独立的事，30-60 字。涉及多件事就拆成多次 save_memory 调用，禁止把不同主题塞进同一条。
静默执行，绝对禁止在回复中生成诸如"我已经记下了"等破坏沉浸感的废话。
调用前先扫一眼上下文里的 [最近工具调用]：同一条信息已经记过、或者只是换个说法，就不要再调一次；一次回复里最多调 3 次。

save_memory 的 memory_level 参数说明：
- memo：短期内会反复用到的信息，如近期计划、当前状态、进行中的事项、临时偏好。这些信息会全量出现在每次对话中，30天后自动降级为长期记忆。
- memory：长期有价值但不需要每次都看到的信息，如个人事实、历史事件、稳定偏好。
如果不确定，默认选 memory。memo 数量应控制精简，避免膨胀。
`;

const LOCK_APP_PROMPT = `
---
你可以使用 lock_app 工具锁定或解锁用户手机上的应用。
当用户明确要求限制自己使用某个 app、或你认为用户当前状态不适合继续刷某 app 时，可以调用 lock_app。
解锁时传 action="unlock"，apps 传要解锁的包名列表；传空数组 [] 表示解锁全部。
先看 [最近工具调用]：已经锁/解锁过的不要再重复发一遍。
${APP_PKG_MAP}`;

const WEB_SEARCH_PROMPT = `
---
当前对话已开启联网搜索，你可以使用 web_search 工具（DeepSeek 搜索，返回网页标题、链接和正文摘要）。
需要联网的情形：新闻时事、价格行情、赛事比分、天气、产品/版本发布、人物近况、任何可能超出你知识截止时间的具体事实，以及用户明确说"查一下/搜一下/帮我找找"时。
规则：
1. 该查就先查，不要凭记忆猜测或拿旧信息当现在。
2. 关键词要具体，可以带 site: / lang: / after: 语法；一次没搜到就换更短更通用的词，同一个问题最多 3 次。
3. 拿到结果后自己综合成回答，不要罗列原始搜索结果。
4. 引用关键信息时在句末附上真实存在的链接，绝不编造结果里没有的链接和事实。
`;

// Gemini 3+/4 用平台内建的 Google Search grounding（原生搜索，不用函数调用）
const GEMINI_SEARCH_PROMPT = `
---
当前对话已开启联网搜索（Gemini 内建 Google Search grounding）：需要实时信息时平台会自动联网检索，你只管用结果回答。
1. 涉及新闻时事、价格行情、赛事比分、天气、产品/版本发布、人物近况，或任何可能超出你知识截止时间的具体事实，先联网查再答，不要凭记忆猜测。
2. 引用检索到的信息时，在句末保留真实来源链接（Markdown 链接或直接贴 URL），不要编造链接。
3. 检索结果和你的旧认知冲突时，以检索结果为准，必要时说明分歧。
4. **不要在回答里另列「来源：…」清单**——界面下方已经有「🔍 搜索来源」折叠块展示链接；需要指向某个网页时用句内 Markdown 链接即可。
`;

const MAX_SAVES_PER_RESPONSE = 3;

// 图像模型（Nano Banana 系列）不支持 tools，别给它们塞搜索工具
function isImageModelName(model) {
  return /image|nano-banana/i.test(String(model || ''));
}
// bge-small-zh-v1.5 + normalize: L2 距离 ≈ sqrt(2 - 2·cos)
// cos 0.92 → L2 ≈ 0.4；cos 0.88 → L2 ≈ 0.49
const DEDUP_MAX_DISTANCE = 0.45;

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function saveMemoryAuto(args) {
  const content = (args?.content || '').trim();
  if (!content) return { status: 'empty' };
  const type = args?.type || 'note';
  const emotion_weight = typeof args?.emotion_weight === 'number' ? args.emotion_weight : 0;
  const memory_level = args?.memory_level || 'memory';

  // Dedup: query nearest, skip if too similar
  const dup = await ragPost('query', {
    text: content,
    n_results: 1,
    max_distance: DEDUP_MAX_DISTANCE,
  }, 5000);
  if (dup && Array.isArray(dup.memories) && dup.memories.length > 0) {
    console.log(`[save_memory] dedup skip: similar to ${dup.memories[0].id}`);
    recordToolCall({ tool: 'save_memory', status: 'duplicate', summary: `已存在相似记忆，跳过：${content.slice(0, 60)}` });
    return { status: 'duplicate', content, type, emotion_weight, memory_level, similarTo: dup.memories[0].id };
  }

  // memo 默认过期时间：30 天后
  let expire = '';
  if (memory_level === 'memo') {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    expire = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const added = await ragPost('add', {
    content,
    type,
    date: todayDate(),
    source: 'auto',
    emotion_weight,
    memory_level,
    expire,
  }, 5000);
  if (added && added.ok) {
    console.log(`[save_memory] added ${added.memory?.id} (${type}, level=${memory_level}, e=${emotion_weight})`);
    recordToolCall({ tool: 'save_memory', summary: `写入记忆（${memory_level}）：${content.slice(0, 70)}` });
    return { status: 'added', id: added.memory?.id, content, type, emotion_weight, memory_level };
  }
  recordToolCall({ tool: 'save_memory', status: 'error', summary: `写入失败：${content.slice(0, 60)}` });
  return { status: 'error', content, type, emotion_weight, memory_level };
}

// Low-level Gemini HTTPS call, returns parsed JSON response
function callGemini(geminiPath, reqBody) {
  const postData = JSON.stringify(reqBody);
  const requestOptions = {
    hostname: GEMINI_HOST, port: 443, path: geminiPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
  };
  return new Promise(async (resolve, reject) => {
    try {
      let proxyRes;
      if (PROXY_URL) {
        proxyRes = await httpsViaTunnel(PROXY_URL, GEMINI_HOST, 443, requestOptions, postData);
      } else {
        proxyRes = await new Promise((res2, rej2) => {
          const r = https.request(requestOptions, res2);
          r.on('error', rej2);
          r.setTimeout(180000, () => r.destroy(new Error('Gemini API timeout')));
          r.write(postData);
          r.end();
        });
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: proxyRes.statusCode, data: JSON.parse(raw || '{}') }); }
        catch { reject(new Error('Invalid response from Gemini')); }
      });
      proxyRes.on('error', reject);
    } catch (err) { reject(err); }
  });
}

// Low-level Gemini HTTPS call — returns raw IncomingMessage (for streaming)
function callGeminiRaw(geminiPath, reqBody) {
  const postData = JSON.stringify(reqBody);
  const requestOptions = {
    hostname: GEMINI_HOST, port: 443, path: geminiPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
  };
  return new Promise(async (resolve, reject) => {
    try {
      let proxyRes;
      if (PROXY_URL) {
        proxyRes = await httpsViaTunnel(PROXY_URL, GEMINI_HOST, 443, requestOptions, postData);
      } else {
        proxyRes = await new Promise((res2, rej2) => {
          const r = https.request(requestOptions, res2);
          r.on('error', rej2);
          r.setTimeout(180000, () => r.destroy(new Error('Gemini API timeout')));
          r.write(postData);
          r.end();
        });
      }
      resolve(proxyRes);
    } catch (err) { reject(err); }
  });
}

// ===== DeepSeek API support =====

function isDeepSeekModel(model) {
  return model && model.startsWith('deepseek-');
}

// Convert Gemini contents [{role:'user', parts:[{text}]}, ...] → OpenAI messages [{role, content}]
function geminiToOpenAIMessages(contents, systemText) {
  const messages = [];
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }
  for (const msg of contents) {
    const role = msg.role === 'model' ? 'assistant' : msg.role;
    const textParts = (msg.parts || []).filter(p => p.text).map(p => p.text);
    if (textParts.length > 0) {
      messages.push({ role, content: textParts.join('\n') });
    }
  }
  return messages;
}

// ===== 联网搜索：DeepSeek 官方 Search API =====
// 接口文档 https://api-docs.deepseek.com/zh-cn/guides/search/
// POST /v1/tools/search { query, count, ori_question?, need_content? }
// → { results: [{ title, url, snippet, summary, content, site_name, date, rerank_score, authority }] }
// 计费：每 1000 次「成功且结果非空」的请求 5 元；失败/空结果不计费；账号级限速 100 QPS。
// 注意：旧的「Gemini google_search grounding」实现已整套删掉（实测经常拿不到 groundingChunks，
// 且 Gemini key 不带 grounding 额度时直接返回空），DeepSeek 与 Gemini 模型现在统一走这里。
const DEEPSEEK_SEARCH_URL = DEEPSEEK_BASE_URL + '/v1/tools/search';
const SEARCH_TIMEOUT_MS = 25000;
const SEARCH_DEFAULT_COUNT = 5;
const SEARCH_MAX_COUNT = 10;
const SEARCH_CONTENT_LIMIT = 2500;   // 单条正文喂给模型的上限（字符）

const WEB_SEARCH_TOOL = {
  functionDeclarations: [{
    name: 'web_search',
    description: '联网搜索最新信息（DeepSeek 搜索）。当用户询问新闻、时事、股价、天气、比赛结果、产品价格、某个可能超出你知识截止时间的具体事实，或需要核实/查找链接时调用。返回网页标题、链接与正文摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词。支持 site:xxx.com、-排除词、"精确短语"、lang:zh,en、after:2025 / before:2026-06 等语法',
        },
        count: {
          type: 'number',
          description: '返回条数，1-10，默认 5。不确定就给 5。',
        },
      },
      required: ['query'],
    },
  }],
};

// 所有由服务端执行的函数工具（Gemini 路径用它过滤 functionCall / followup 工具列表）
const FUNCTION_CALL_NAMES = ['save_memory', 'get_health_trend', 'lock_app', 'fetch_site', 'schedule_nudge', 'web_search'];

const DEEPSEEK_WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: WEB_SEARCH_TOOL.functionDeclarations[0].description,
    parameters: {
      type: 'object',
      properties: WEB_SEARCH_TOOL.functionDeclarations[0].parameters.properties,
      required: WEB_SEARCH_TOOL.functionDeclarations[0].parameters.required,
    },
  },
};

function shorten(s, max) {
  const str = String(s || '');
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// 通用 POST（JSON in / JSON out），只给 DeepSeek 的 tools 系列接口用
function postDeepSeekJson(urlStr, payload, timeoutMs = SEARCH_TIMEOUT_MS) {
  const postData = JSON.stringify(payload);
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: timeoutMs,
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: r.statusCode, data, raw });
      });
      r.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DeepSeek tools API timeout')));
    req.write(postData);
    req.end();
  });
}

function normalizeSearchResult(r) {
  if (!r || typeof r !== 'object') return null;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!url && !title) return null;
  return {
    title: title || url,
    url,
    snippet: typeof r.snippet === 'string' ? r.snippet.trim() : '',
    summary: typeof r.summary === 'string' ? r.summary.trim() : '',
    content: typeof r.content === 'string' ? r.content.trim() : '',
    site: typeof r.site_name === 'string' ? r.site_name : '',
    date: typeof r.date === 'string' ? r.date : '',
    score: typeof r.rerank_score === 'number' ? r.rerank_score : 0,
    authority: typeof r.authority === 'number' ? r.authority : -1,
  };
}

/**
 * 调 DeepSeek Search API。
 * @returns {Promise<{ok:boolean, results:Array, sources:Array, error?:string}>}
 *   results 给模型读（含正文）；sources 给前端渲染引用列表（title/url/snippet/site/date）
 */
async function deepseekSearch(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 128);
  if (!q) return { ok: false, results: [], sources: [], error: '搜索关键词为空' };
  if (!DEEPSEEK_API_KEY) {
    return { ok: false, results: [], sources: [], error: '服务端未配置 DEEPSEEK_API_KEY，无法联网搜索' };
  }

  const count = Math.min(SEARCH_MAX_COUNT, Math.max(1, Number(opts.count) || SEARCH_DEFAULT_COUNT));
  const payload = { query: q, count, need_content: opts.needContent !== false };
  const ori = String(opts.oriQuestion || '').trim().slice(0, 128);
  if (ori && ori !== q) payload.ori_question = ori;

  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, data, raw } = await postDeepSeekJson(DEEPSEEK_SEARCH_URL, payload);
      if (status === 200 && Array.isArray(data?.results)) {
        const results = data.results.map(normalizeSearchResult).filter(Boolean);
        console.log(`[web_search] "${q}" → ${results.length} 条${count !== SEARCH_DEFAULT_COUNT ? ` (count=${count})` : ''}`);
        return {
          ok: true,
          results,
          sources: results.map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet || shorten(r.summary, 200),
            site: r.site,
            date: r.date ? r.date.slice(0, 10) : '',
          })),
        };
      }
      const apiMsg = data?.error?.message || shorten(raw, 300) || '(无响应体)';
      if (status === 402) {
        console.error('[web_search] 402 余额不足:', apiMsg);
        return { ok: false, results: [], sources: [], error: 'DeepSeek 账户余额不足（402），搜索未执行' };
      }
      if (status === 429) {
        lastErr = `限速（429）: ${apiMsg}`;
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
      console.error(`[web_search] 接口 ${status}:`, apiMsg);
      return { ok: false, results: [], sources: [], error: `搜索接口 ${status}: ${apiMsg}` };
    } catch (e) {
      lastErr = e.message || String(e);
      await new Promise(r => setTimeout(r, 600));
    }
  }
  console.error('[web_search] 最终失败:', lastErr);
  return { ok: false, results: [], sources: [], error: `搜索失败: ${lastErr}` };
}

// 搜索结果 → 喂给模型的文本（保留链接，要求引用；限制单条长度防爆上下文）
function formatSearchResults(query, results, error) {
  if (!results || results.length === 0) {
    return `搜索「${query}」没有找到结果${error ? `（${error}）` : ''}。可以换个更短/更通用的关键词再试一次；如果仍然没有，直接告诉用户没搜到，不要编造。`;
  }
  const blocks = results.map((r, i) => {
    const meta = [r.date ? r.date.slice(0, 10) : '', r.site || ''].filter(Boolean).join(' · ');
    const body = r.content ? shorten(r.content, SEARCH_CONTENT_LIMIT) : (r.summary || r.snippet || '(无正文)');
    return `[${i + 1}] ${r.title}${meta ? `（${meta}）` : ''}\n${r.url}\n${body}`;
  });
  return `搜索「${query}」共 ${results.length} 条结果：\n\n${blocks.join('\n\n---\n\n')}\n\n` +
    '以上是刚检索到的实时网页内容。回答时：优先采用权威、新近的结果，互相冲突要说清分歧；' +
    '引用具体信息时在句内用 Markdown 链接标注出处，不要编造结果里没有的事实；' +
    '不要在回答末尾另列「来源：…」清单（界面下方已有「🔍 搜索来源」折叠块）。';
}

// DeepSeek save_memory tool in OpenAI format
const DEEPSEEK_SAVE_MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'save_memory',
    description: SAVE_MEMORY_TOOL.functionDeclarations[0].description,
    parameters: {
      type: 'object',
      properties: SAVE_MEMORY_TOOL.functionDeclarations[0].parameters.properties,
      required: SAVE_MEMORY_TOOL.functionDeclarations[0].parameters.required,
    },
  },
};

// Stream DeepSeek API, returns raw IncomingMessage
function callDeepSeekStream(messages, model, genConfig, thinkingEnabled, tools) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (thinkingEnabled) {
    body.thinking = { type: 'enabled' };
    // When thinking is enabled, these params are not supported
  } else {
    body.thinking = { type: 'disabled' };
    if (genConfig.temperature !== undefined) body.temperature = genConfig.temperature;
    if (genConfig.topP !== undefined) body.top_p = genConfig.topP;
  }
  if (genConfig.maxOutputTokens) body.max_tokens = genConfig.maxOutputTokens;

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const postData = JSON.stringify(body);
  const url = new URL(DEEPSEEK_BASE_URL + '/chat/completions');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 180000,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('DeepSeek API timeout')); });
    req.write(postData);
    req.end();
  });
}

// ===== 媒体上传：代理 Gemini Files API（音频 / 视频 / PDF / 图片）=====
// 前端的 inline_data 只适合小图；音视频一律走 Files API：
//   1) POST /upload/v1beta/files（resumable start）→ 拿 X-Goog-Upload-URL
//   2) POST 该 URL（upload, finalize）把原始字节流上去
//   3) 轮询 GET /v1beta/files/<id> 到 state=ACTIVE（视频要处理几秒）
// 之后前端在 parts 里用 { file_data: { mime_type, file_uri } } 引用，请求体里只有几十字节。
const GEMINI_FILES_START_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const MEDIA_MAX_BYTES = 120 * 1024 * 1024;      // 单文件上限（Files API 本身能到 20GB，这里只是护栏）
const MEDIA_ALLOWED_MIME = /^(audio|video|image)\/|^application\/pdf/i;

function geminiHttps(opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(opts.url);
    const rq = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: opts.method || 'POST',
      headers: opts.headers || {},
      timeout: opts.timeout || 60000,
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    rq.on('error', reject);
    rq.on('timeout', () => rq.destroy(new Error('Gemini Files API timeout')));
    if (opts.body) rq.write(opts.body);
    rq.end();
  });
}

// ===== Gemini 显式上下文缓存（cachedContents）=====
// 为什么需要：按 6~7 万 token 的上下文聊天时，每轮都把整段历史按输入价重算；
// 平台自带的隐式缓存 TTL 只有几分钟（实测 cachedContentTokenCount 基本为 0），聊慢一点就全价。
// 显式缓存把「不变的历史前缀」存一份（TTL 可配，默认 1 小时），命中时输入按 25% 计价，
// 存储另算（1M token·小时约 $1；6 万前缀 ≈ $0.06/小时），聊天密集时净省 60%+。
// 只缓存 contents（历史），不缓存 systemInstruction / tools —— 那两块每轮都在变
//（健康、天气、记忆注入），塞进缓存反而保证每次都 miss。
// 开关：GEMINI_CACHE=off 关掉；GEMINI_CACHE_TTL / GEMINI_CACHE_MIN_TOKENS / GEMINI_CACHE_TAIL_MSGS 可调。
const GEMINI_CACHE_ON = String(process.env.GEMINI_CACHE || 'on').toLowerCase() !== 'off';
const GEMINI_CACHE_TTL_S = Math.max(300, Number(process.env.GEMINI_CACHE_TTL || 3600));
const GEMINI_CACHE_MIN_TOKENS = Number(process.env.GEMINI_CACHE_MIN_TOKENS || 15000);
const GEMINI_CACHE_TAIL_MSGS = Math.max(2, Number(process.env.GEMINI_CACHE_TAIL_MSGS || 8));
const GEMINI_CACHE_MAX_TAIL = Math.max(4, Number(process.env.GEMINI_CACHE_MAX_TAIL || 16));  // 尾巴涨到这么多条就重建
const geminiCaches = new Map();   // convId → {name, model, keyHash, nMsgs, tokens, exp, hash}

// 最近一次请求的「输入构成」快照（给监控台看：各注入块多大、tools 几个、有没有走缓存）
const lastContextInfo = new Map();   // convId → {...}
function recordContextInfo(convId, info) {
  try {
    lastContextInfo.set(String(convId || '__default__'), { at: Date.now(), ...info });
    if (lastContextInfo.size > 50) lastContextInfo.delete(lastContextInfo.keys().next().value);
  } catch {}
}

function geminiCacheSupported(model) {
  if (!GEMINI_CACHE_ON || !model) return false;
  if (!/^gemini-(2\.5|3|4)/.test(model)) return false;
  if (/image|nano-banana/.test(model)) return false;           // 图像模型不走缓存
  return true;
}
function sha12(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function keyHashOf(apiKey) { return sha12(String(apiKey || '')); }
function contentsHash(contents) {
  try { return sha12(JSON.stringify(contents || [])); } catch { return ''; }
}
async function createGeminiCache(apiKey, model, contents, sysText, tools, toolConfig) {
  // 注意：systemInstruction / tools / toolConfig 必须和 contents 一起进缓存，
  // 用了 cachedContent 的请求里再带这三样会 400（实测报错见 CLAUDE.md）
  const body = { model: `models/${model}`, contents, ttl: `${GEMINI_CACHE_TTL_S}s` };
  if (sysText) body.systemInstruction = { parts: [{ text: sysText }] };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (toolConfig) body.toolConfig = toolConfig;
  const r = await geminiHttps({
    url: `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 90000,
  });
  if (r.status !== 200) throw new Error(`cachedContents ${r.status}: ${String(r.body || '').slice(0, 200)}`);
  const d = JSON.parse(r.body);
  return { name: d.name, tokens: Number((d.usageMetadata && d.usageMetadata.totalTokenCount) || 0), expireTime: d.expireTime || '' };
}

async function startGeminiUpload(apiKey, mimeType, size, displayName) {  const r = await geminiHttps({
    url: `${GEMINI_FILES_START_URL}?key=${encodeURIComponent(apiKey)}`,
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: String(displayName || 'upload').slice(0, 120) } }),
  });
  const uploadUrl = r.headers && r.headers['x-goog-upload-url'];
  if (r.status !== 200 || !uploadUrl) {
    throw new Error(`Files API start 失败 ${r.status}: ${String(r.body || '').slice(0, 300)}`);
  }
  return uploadUrl;
}

function streamToGemini(uploadUrl, mimeType, size, inStream) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const up = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(size),
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
      },
      timeout: 300000,
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    up.on('error', reject);
    up.on('timeout', () => up.destroy(new Error('上传播流超时')));
    inStream.pipe(up);
  });
}

async function pollGeminiFile(apiKey, name, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await geminiHttps({ url: `${GEMINI_FILES_BASE}${name}?key=${encodeURIComponent(apiKey)}`, method: 'GET' }).catch(() => null);
    if (r && r.status === 200) {
      try { last = JSON.parse(r.body); } catch {}
      if (last && (last.state === 'ACTIVE' || last.state === 'FAILED')) return last;
    }
    await new Promise(r2 => setTimeout(r2, 1500));
  }
  return last;
}

// ===== 失效附件（Gemini Files API）=====
// 403 "You do not have permission to access the File xxx or it may not exist." 两种成因：
//   ① 上传时用的 API key 和现在不是同一个（Files API 的文件按 key/project 隔离）
//   ② 文件超过 48 小时被清理
// 一旦命中就记下来，之后所有请求前直接剔除，否则这个对话会因为一条老附件永远发不出去。
const DEAD_MEDIA_URIS = new Set();
const DEAD_MEDIA_PATH = path.join(__dirname, 'health', 'dead-media.json');
const MEDIA_DEAD_RE = /permission to access the File|may not exist|File .*not found|PERMISSION_DENIED/i;

// 落盘，避免服务重启后又拿失效附件白试一次
function loadDeadMedia() {
  try {
    const arr = JSON.parse(fs.readFileSync(DEAD_MEDIA_PATH, 'utf8'));
    if (Array.isArray(arr)) arr.forEach(u => { if (typeof u === 'string' && u) DEAD_MEDIA_URIS.add(u); });
    if (DEAD_MEDIA_URIS.size > 0) console.log(`[media] 已加载 ${DEAD_MEDIA_URIS.size} 条失效附件记录`);
  } catch {}
}
function saveDeadMedia() {
  try {
    fs.mkdirSync(path.dirname(DEAD_MEDIA_PATH), { recursive: true });
    const arr = [...DEAD_MEDIA_URIS].slice(-300);
    fs.writeFileSync(DEAD_MEDIA_PATH, JSON.stringify(arr), 'utf8');
  } catch (e) { console.warn('[media] 失效附件记录落盘失败:', e.message); }
}
loadDeadMedia();

function fileUriOfPart(p) {
  const fd = p && (p.file_data || p.fileData);
  return (fd && (fd.file_uri || fd.fileUri)) || '';
}

// 把已知失效的 file_data part 换成一行文字占位；返回 { contents, stripped }
function stripDeadMediaParts(contents) {
  let stripped = 0;
  const out = (contents || []).map(c => {
    if (!c || !Array.isArray(c.parts)) return c;
    return {
      ...c,
      parts: c.parts.map(p => {
        const uri = fileUriOfPart(p);
        if (uri && DEAD_MEDIA_URIS.has(uri)) { stripped++; return { text: '[附件已过期或不可访问，已跳过]' }; }
        return p;
      }),
    };
  });
  return { contents: out, stripped };
}

function collectFileUris(contents) {
  const uris = [];
  for (const c of contents || []) for (const p of (c && c.parts) || []) {
    const u = fileUriOfPart(p);
    if (u) uris.push(u);
  }
  return uris;
}

function formatMemoryBlock(memos, memories) {
  const parts = [];

  if (memos && memos.length > 0) {
    const memoLines = memos.map(m => {
      const tag = m.date || '';
      return `- ${tag ? tag + ': ' : ''}${m.content}`;
    });
    parts.push('[近期备忘]\n' + memoLines.join('\n') + '\n[近期备忘结束]');
  }

  if (memories && memories.length > 0) {
    const memLines = memories.map(m => {
      const tag = m.date || m.type || 'note';
      return `- [${tag}] ${m.content}`;
    });
    parts.push('[相关记忆]\n' + memLines.join('\n') + '\n[相关记忆结束]');
  }

  if (parts.length === 0) return '';
  return '以下是与用户相关的信息，供你参考（不需要主动提及，只在相关时自然使用）：\n\n' + parts.join('\n\n') + '\n\n---\n\n';
}

// ===== 健康数据 =====
const HEALTH_DIR = path.join(__dirname, 'health');
const HEALTH_DB_PATH = path.join(HEALTH_DIR, 'Gadgetbridge');
const HEALTH_JSON_PATH = path.join(HEALTH_DIR, 'today.json');
const HEALTH_REALTIME_DIR = path.join(HEALTH_DIR);
const PARSE_HEALTH_SCRIPT = path.join(__dirname, 'parse_health.py');
const HEALTH_TOKEN = process.env.HEALTH_UPLOAD_TOKEN || '';
const APP_TOKEN = process.env.APP_TOKEN || '';

// 实时数据内存缓存（最近 24 小时）
let realtimeCache = [];
let _healthPushCount = 0;
const _healthDayCache = {}; // 过去日期的日聚合永久缓存
const REALTIME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REALTIME_FRESH_MS = 5 * 60 * 1000; // 5 分钟内算实时

// 睡眠片段：滚动 24h 全量快照，每次 push 整段覆盖
const SLEEP_SEGMENTS_PATH = path.join(HEALTH_DIR, 'sleep_segments.json');
let latestSleepSegments = [];
let latestSleepSegmentsTs = 0;

// 本地时区日期（YYYY-MM-DD），不用 UTC
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseClientTimestamp(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000; // 秒或毫秒
  if (typeof ts === 'string') {
    const hasTZ = /Z$|[+-]\d{2}:?\d{2}$/.test(ts);
    // 无时区字符串：按 UTC+8（北京时间）解析
    // 因为典型客户端（手机/Termux）用 datetime.fromtimestamp().isoformat() 输出本地时间
    const s = hasTZ ? ts : ts.replace(' ', 'T') + '+08:00';
    const n = Date.parse(s);
    return isNaN(n) ? null : n;
  }
  return null;
}

function loadRealtimeFromDisk() {
  try {
    const cutoff = Date.now() - REALTIME_MAX_AGE_MS;
    const today = localDateStr();
    const yesterday = localDateStr(new Date(Date.now() - 86400000));
    const files = [yesterday, today].map(d => path.join(HEALTH_DIR, `realtime-${d}.jsonl`));
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d._ts && d._ts >= cutoff) realtimeCache.push(d);
        } catch {}
      }
    }
    realtimeCache.sort((a, b) => a._ts - b._ts);
    console.log(`[health-rt] loaded ${realtimeCache.length} entries from disk`);
  } catch {}
}
loadRealtimeFromDisk();

function loadSleepSegmentsFromDisk() {
  try {
    if (!fs.existsSync(SLEEP_SEGMENTS_PATH)) return;
    const obj = JSON.parse(fs.readFileSync(SLEEP_SEGMENTS_PATH, 'utf8'));
    if (Array.isArray(obj.segments)) {
      latestSleepSegments = obj.segments;
      latestSleepSegmentsTs = obj.updated_ts || 0;
      console.log(`[health-rt] loaded ${latestSleepSegments.length} sleep segments from disk`);
    }
  } catch (e) {
    console.error('[health-rt] sleep load error:', e.message);
  }
}
loadSleepSegmentsFromDisk();

// ===== 屏幕使用时间 =====
let screenTimeCache = null; // { data: [{pkg, mins}, ...], timestamp, _received_ts }

function loadScreenTimeFromDisk() {
  try {
    const today = localDateStr();
    const file = path.join(HEALTH_DIR, `screentime-${today}.jsonl`);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const last = JSON.parse(lines[lines.length - 1]);
    screenTimeCache = last;
    console.log(`[screen-time] loaded latest from disk (${last.data?.length || 0} apps)`);
  } catch {}
}
loadScreenTimeFromDisk();
function appendScreenTime(data, clientTs) {
  const now = Date.now();
  const entry = {
    data: data,
    timestamp: clientTs || now,
    _received_ts: now,
  };
  screenTimeCache = entry;
  trackScreenSample(entry);      // 留样本，用来推断"连续用某个 App 多久"

  try {
    if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
    const dateStr = localDateStr(new Date(now));
    const file = path.join(HEALTH_DIR, `screentime-${dateStr}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[screen-time] write error:', e.message);
  }
}

// ===== 体重数据（蓝牙智能秤，经 AletheiaBridge 推送）=====
let weightCache = []; // [{weight, ts, _received_ts}]，按 ts 升序，保留最近 90 天

function loadWeightFromDisk() {
  try {
    if (!fs.existsSync(HEALTH_DIR)) return;
    const cutoff = Date.now() - 90 * 86400000;
    const files = fs.readdirSync(HEALTH_DIR).filter(f => /^weight-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(HEALTH_DIR, f), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.ts && d.ts >= cutoff && typeof d.weight === 'number') {
            // 老记录补算新增指标（肌肉率/基础代谢等）
            if (!d.muscle_rate || !d.bmr) Object.assign(d, calcBodyMetrics(d.weight, d.impedance));
            weightCache.push(d);
          }
        } catch {}
      }
    }
    weightCache.sort((a, b) => a.ts - b.ts);
    if (weightCache.length > 0) console.log(`[weight] loaded ${weightCache.length} entries from disk`);
  } catch (e) {
    console.error('[weight] load error:', e.message);
  }
}
loadWeightFromDisk();

// 体成分计算参数：按自己的数据改这里，或用环境变量覆盖（别把真实值提交进仓库）
//   BODY_HEIGHT_CM / BODY_AGE / BODY_SEX(male|female)
const BODY_HEIGHT_CM = Number(process.env.BODY_HEIGHT_CM || 170);
const BODY_AGE = Number(process.env.BODY_AGE || 30);
const BODY_SEX = process.env.BODY_SEX === 'male' ? 1 : 0; // 男=1，女=0

function calcBodyMetrics(weight, impedance) {
  const heightM = BODY_HEIGHT_CM / 100;
  const bmi = weight / (heightM * heightM);
  let bodyFat, lbm, method;
  if (impedance && impedance > 0) {
    // BIA：LBM = (height² / impedance) × 0.73 + weight × 0.18
    lbm = (BODY_HEIGHT_CM * BODY_HEIGHT_CM / impedance) * 0.73 + weight * 0.18;
    bodyFat = (weight - lbm) / weight * 100;
    method = 'bia';
  } else {
    // BMI 估算（Deurenberg）
    bodyFat = 1.20 * bmi + 0.23 * BODY_AGE - 5.4 - 10.8 * BODY_SEX;
    lbm = weight * (1 - bodyFat / 100);
    method = 'bmi';
  }
  // clamp 到合理范围
  bodyFat = Math.max(3, Math.min(60, bodyFat));
  lbm = weight * (1 - bodyFat / 100);

  // 骨骼肌量：有阻抗用 Janssen 2000 BIA 公式，无则按瘦体重比例估算
  let smm;
  if (impedance && impedance > 0) {
    smm = (BODY_HEIGHT_CM * BODY_HEIGHT_CM / impedance) * 0.401 + BODY_SEX * 3.825 - 0.071 * BODY_AGE + 5.102;
  } else {
    smm = lbm * 0.54;
  }
  smm = Math.max(5, Math.min(weight * 0.7, smm));
  const muscleRate = smm / weight * 100;

  // 基础代谢：Katch-McArdle（基于瘦体重）
  const bmr = 370 + 21.6 * lbm;

  return {
    bmi: Math.round(bmi * 10) / 10,
    body_fat: Math.round(bodyFat * 10) / 10,
    lbm: Math.round(lbm * 10) / 10,
    muscle_rate: Math.round(muscleRate * 10) / 10,
    bmr: Math.round(bmr),
    _bf_method: method,
  };
}

function appendWeight(weight, clientTs, impedance) {
  const now = Date.now();
  const entry = { weight, ts: clientTs || now, _received_ts: now };
  if (impedance && impedance > 0) entry.impedance = impedance;
  Object.assign(entry, calcBodyMetrics(weight, impedance));
  weightCache.push(entry);
  weightCache.sort((a, b) => a.ts - b.ts);
  const cutoff = now - 90 * 86400000;
  weightCache = weightCache.filter(e => e.ts >= cutoff);

  try {
    if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
    const dateStr = localDateStr(new Date(entry.ts));
    const file = path.join(HEALTH_DIR, `weight-${dateStr}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[weight] write error:', e.message);
  }
  return entry;
}

function formatWeightBlock() {
  if (weightCache.length === 0) return '';
  const latest = weightCache[weightCache.length - 1];
  // 14 天没新数据就不注入，避免给模型过时信息
  if (Date.now() - latest.ts > 14 * 86400000) return '';

  const b = new Date(latest.ts + 8 * 3600 * 1000);
  const dateStr = `${b.getUTCMonth() + 1}-${b.getUTCDate()} ${String(b.getUTCHours()).padStart(2, '0')}:${String(b.getUTCMinutes()).padStart(2, '0')}`;
  const lines = ['[体重]', `最近：${latest.weight.toFixed(1)} kg（${dateStr}，UTC+8）`];
  if (latest.bmi) lines.push(`BMI：${latest.bmi}`);
  if (latest.body_fat) lines.push(`体脂率：${latest.body_fat}%${latest._bf_method === 'bia' ? '' : '（BMI 估算）'}，瘦体重 ${latest.lbm} kg`);
  if (latest.muscle_rate) lines.push(`肌肉率：${latest.muscle_rate}%（骨骼肌）`);
  if (latest.bmr) lines.push(`基础代谢：${latest.bmr} kcal/天`);

  const prev = weightCache.length >= 2 ? weightCache[weightCache.length - 2] : null;
  if (prev) {
    const diff = latest.weight - prev.weight;
    lines.push(`较上次：${diff >= 0 ? '+' : ''}${diff.toFixed(1)} kg`);
  }
  const weekAgoTs = latest.ts - 7 * 86400000;
  const weekAgo = [...weightCache].reverse().find(e => e.ts <= weekAgoTs);
  if (weekAgo) {
    const diff = latest.weight - weekAgo.weight;
    lines.push(`较 7 天前：${diff >= 0 ? '+' : ''}${diff.toFixed(1)} kg（${weekAgo.weight.toFixed(1)} kg）`);
  }
  lines.push('[体重结束]');
  return lines.join('\n') + '\n\n';
}

// ===== 手动睡眠记录 =====
let sleepCache = []; // [{bed, wake, minutes, _recorded_ts}]，按 bed 升序，保留 90 天

function loadSleepFromDisk() {
  try {
    if (!fs.existsSync(HEALTH_DIR)) return;
    const cutoff = Date.now() - 90 * 86400000;
    const files = fs.readdirSync(HEALTH_DIR).filter(f => /^sleep-manual-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(HEALTH_DIR, f), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.bed && d.bed >= cutoff) sleepCache.push(d);
        } catch {}
      }
    }
    sleepCache.sort((a, b) => a.bed - b.bed);
    if (sleepCache.length > 0) console.log(`[sleep] loaded ${sleepCache.length} entries from disk`);
  } catch (e) {
    console.error('[sleep] load error:', e.message);
  }
}
loadSleepFromDisk();

function appendSleep(bed, wake) {
  const now = Date.now();
  const minutes = Math.round((wake - bed) / 60000);
  if (minutes <= 0 || minutes > 24 * 60) return null;
  // 只保留最近 90 天：太老的记录直接拒收，**不要写盘**（以前先写盘再被缓存过滤掉，会留下孤儿文件）
  const cutoff = now - 90 * 86400000;
  if (bed < cutoff) return null;
  if (wake > now + 6 * 3600000) return null;      // 醒来时间不能在未来（留 6 小时容差给时区/手误）
  const entry = { bed, wake, minutes, _recorded_ts: now };
  sleepCache.push(entry);
  sleepCache.sort((a, b) => a.bed - b.bed);

  try {
    if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
    const dateStr = localDateStr(new Date(wake));
    const file = path.join(HEALTH_DIR, `sleep-manual-${dateStr}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[sleep] write error:', e.message);
  }
  return entry;
}

// ===== 天气（Open-Meteo，无需 key，支持多城市）=====
// 数据源：
//   https://api.open-meteo.com/v1/forecast           当前 + 每日 + 逐小时
//   https://air-quality-api.open-meteo.com/v1/air-quality   PM2.5 / AQI
// 配置：环境变量 WEATHER_CITIES="北京:39.9042:116.4074;上海:31.2304:121.4737"（第一个为主城市）
//       只配一个也可以用 WEATHER_CITY / WEATHER_LAT / WEATHER_LON
const WEATHER_REFRESH_MS = 10 * 60 * 1000;      // 每 10 分钟刷一次
const WEATHER_STALE_MS = 90 * 60 * 1000;        // 超过 90 分钟没刷新成功就不注入（宁可不给，也别给假天气）
const WEATHER_TZ = 'Asia/Shanghai';

// Open-Meteo 各子域其实共用同一批边缘节点，按 SNI 路由。2026-11 实测：本机 DNS 把
// api.open-meteo.com 只解析到 51.81.167.44（OVH），该 IP 从这里 TCP 全丢包（SYN 超时），
// 但同集群的 152.53.84.73 / 5.9.98.12 / 178.63.121.29 都正常返回同一份 forecast。
// 所以：直连失败就钉住这些 IP 重试（Host/SNI 不变，证书照旧校验）。
// 可用 WEATHER_PIN_IPS=ip1,ip2 覆盖；换机房后可能要在服务器上重新探一批可达 IP。
const WEATHER_PIN_IPS = String(process.env.WEATHER_PIN_IPS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const WEATHER_DEFAULT_PINS = {
  // 顺序 = 尝试顺序。2026-11-17 实测：
  //   5.9.98.12      正常（≈160ms）
  //   178.63.121.29  正常
  //   152.53.84.73   **返回 temperature_2m/weather_code 全 null 的残缺数据** → 已剔除
  //   202.61.206.6   证书只签 geocoding 域，别用
  'api.open-meteo.com': ['5.9.98.12', '178.63.121.29'],
};
const weatherPinnedIp = new Map();   // hostname → 最近一次成功的固定 IP

// WMO weather code → 中文
const WMO_DESC = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻毛毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷暴伴冰雹',
};
const WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

const weatherState = { at: 0, cities: [], err: '', lastWarnAt: 0 };

function weatherCityList() {
  const raw = String(process.env.WEATHER_CITIES || '').trim();
  const out = [];
  if (raw) {
    for (const part of raw.split(';')) {
      const [name, lat, lon] = part.split(':').map(x => (x || '').trim());
      const la = Number(lat), lo = Number(lon);
      if (name && Number.isFinite(la) && Number.isFinite(lo)) out.push({ name, lat: la, lon: lo });
    }
  }
  if (out.length === 0) {
    out.push({
      name: process.env.WEATHER_CITY || '北京',
      lat: Number(process.env.WEATHER_LAT) || 39.9042,
      lon: Number(process.env.WEATHER_LON) || 116.4074,
    });
  }
  return out;
}

function windDirCn(deg) {
  if (!Number.isFinite(deg)) return '';
  return WIND_DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8] || '';
}

// AQI（美国标准，Open-Meteo 直接给 us_aqi）→ 中文等级
function aqiLevel(aqi) {
  if (!Number.isFinite(aqi)) return '';
  if (aqi <= 50) return '优';
  if (aqi <= 100) return '良';
  if (aqi <= 150) return '轻度污染';
  if (aqi <= 200) return '中度污染';
  if (aqi <= 300) return '重度污染';
  return '严重污染';
}

function httpsGetJson(url, timeoutMs = 6000, pinIp = '') {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'aletheia-server/1.0' },
      timeout: timeoutMs,
      // Node 20+ 默认开 autoSelectFamily，会把 lookup 调用改成 all:true（要求返回数组）；
      // 关掉它，配合下面的 lookup 让「钉 IP」这条路行为可预测
      autoSelectFamily: false,
    };
    // pinIp：跳过 DNS 直连指定 IP，但 servername/Host 仍是原主机名 → 证书照常按主机名校验，不降级
    if (pinIp) {
      opts.lookup = (hostname, o, cb) => {
        const done = typeof o === 'function' ? o : cb;
        const oo = (o && typeof o === 'object') ? o : {};
        if (oo.all) return done(null, [{ address: pinIp, family: 4 }]);   // all:true 必须给数组
        done(null, pinIp, 4);
      };
    }
    let settled = false;
    let killer = null;
    const finish = (v) => { if (settled) return; settled = true; if (killer) clearTimeout(killer); resolve(v); };
    const rq = https.request(opts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        if (r.statusCode !== 200) return finish(null);
        try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); }
      });
      r.on('error', () => finish(null));
    });
    // 显式兜底计时器：`timeout` 选项在「DNS 解析 + TCP 建连」阶段并不保证按时触发
    //（实测 connect 卡住时会拖到 12s），所以自己掐表，到点直接销毁请求
    killer = setTimeout(() => { try { rq.destroy(); } catch {} finish(null); }, timeoutMs);
    rq.on('error', () => finish(null));
    rq.on('timeout', () => { rq.destroy(); finish(null); });
    rq.end();
  });
}

// 带「钉 IP 兜底」的 GET：先按 DNS 直连；失败则依次试固定 IP，并记住成功的那台
// （下次直接用，省掉一轮超时）。成功过的 IP 失效时会被清掉重新探。
// 注意：accept 回调用来校验「内容」而不只是 HTTP 200。
// 2026-11-17 踩过：152.53.84.73 这台边缘 200 但 current 全是 null，解析成功 → 界面显示「0℃ 未知」，
// 还把这个坏结果写进 weatherState 顶掉了好数据。现在内容不合格 = 这次失败，继续下一个 IP。
async function httpsGetJsonWithFallback(url, timeoutMs = 6000, accept = null) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  const ok = (v) => !!v && (typeof accept !== 'function' || accept(v));

  const cached = weatherPinnedIp.get(host);
  if (cached) {
    const r = await httpsGetJson(url, timeoutMs, cached);
    if (ok(r)) return r;
    weatherPinnedIp.delete(host);
    console.log(`[weather] ${host} 固定 IP ${cached} ${r ? '返回内容不合格' : '连不上'}，重新探测`);
  }

  const direct = await httpsGetJson(url, Math.min(timeoutMs, 4000));
  if (ok(direct)) return direct;

  // 直连不通才走固定 IP；记住成功的那台，之后每轮直接命中（省掉一次直连超时）
  const pins = WEATHER_PIN_IPS.length ? WEATHER_PIN_IPS : (WEATHER_DEFAULT_PINS[host] || []);
  for (const ip of pins) {
    const r = await httpsGetJson(url, timeoutMs, ip);
    if (ok(r)) {
      weatherPinnedIp.set(host, ip);
      console.log(`[weather] ${host} 直连失败，改用固定 IP ${ip}（后续复用）`);
      return r;
    }
    if (r) console.warn(`[weather] ${host} 固定 IP ${ip} 返回内容不合格，跳过`);
  }
  return null;
}

async function fetchCityWeather(c) {
  const fUrl = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${c.lat}&longitude=${c.lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day'
    + '&hourly=precipitation_probability,temperature_2m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
    + `&timezone=${encodeURIComponent(WEATHER_TZ)}&forecast_days=3`;
  const aUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality'
    + `?latitude=${c.lat}&longitude=${c.lon}`
    + '&current=pm2_5,us_aqi'
    + `&timezone=${encodeURIComponent(WEATHER_TZ)}`;

  // 两个请求都走「DNS 直连 → 钉 IP 兜底」：api.open-meteo.com 的 DNS 边缘在部分网络不可达
  const [fc, aq] = await Promise.all([
    // 预报：current 里必须有数字温度与 weather_code，否则视为坏数据（别把 null 当成「0℃ 未知」显示）
    httpsGetJsonWithFallback(fUrl, 6000, (d) =>
      d && d.current && Number.isFinite(d.current.temperature_2m) && d.current.weather_code != null && !!d.daily),
    httpsGetJsonWithFallback(aUrl, 6000, (d) => d && (d.current || d.hourly)),
  ]);
  if (!fc || !fc.current || !fc.daily) return null;

  const cur = fc.current;
  const d = fc.daily;
  const nowIso = String(cur.time || '');
  const days = (d.time || []).map((date, i) => ({
    date,
    code: d.weather_code?.[i],
    desc: WMO_DESC[d.weather_code?.[i]] || '未知',
    tmax: d.temperature_2m_max?.[i],
    tmin: d.temperature_2m_min?.[i],
    pop: d.precipitation_probability_max?.[i],
    sunrise: d.sunrise?.[i],
    sunset: d.sunset?.[i],
  }));

  // 未来 6 小时（从当前小时开始对齐）
  const hours = [];
  const hTimes = fc.hourly?.time || [];
  const hPop = fc.hourly?.precipitation_probability || [];
  const hTemp = fc.hourly?.temperature_2m || [];
  const curHour = nowIso.slice(0, 13);   // YYYY-MM-DDTHH
  let startIdx = hTimes.findIndex(t => String(t).slice(0, 13) >= curHour);
  if (startIdx < 0) startIdx = 0;
  for (let i = startIdx; i < Math.min(hTimes.length, startIdx + 6); i++) {
    hours.push({
      time: String(hTimes[i]).slice(11, 16),
      pop: Number.isFinite(hPop[i]) ? hPop[i] : null,
      temp: Number.isFinite(hTemp[i]) ? hTemp[i] : null,
    });
  }

  const aqiCur = aq?.current || {};
  return {
    name: c.name,
    lat: c.lat,
    lon: c.lon,
    time: nowIso.replace('T', ' '),
    now: {
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      precip: cur.precipitation,
      code: cur.weather_code,
      desc: WMO_DESC[cur.weather_code] || '未知',
      windKmh: cur.wind_speed_10m,
      windDir: windDirCn(cur.wind_direction_10m),
      isDay: cur.is_day === 1,
    },
    days,
    hours,
    aqi: Number.isFinite(aqiCur.us_aqi) || Number.isFinite(aqiCur.pm2_5)
      ? { pm25: aqiCur.pm2_5, usAqi: aqiCur.us_aqi, level: aqiLevel(aqiCur.us_aqi) }
      : null,
  };
}

async function refreshWeather() {
  const cities = weatherCityList();
  try {
    const results = await Promise.all(cities.map(c => fetchCityWeather(c).catch(() => null)));
    const ok = results.filter(Boolean);
    if (ok.length === 0) throw new Error('全部城市获取失败');
    weatherState.cities = ok;
    weatherState.at = Date.now();
    weatherState.err = '';
    console.log(`[weather] 刷新成功 ${ok.map(c => `${c.name} ${c.now.temp}℃ ${c.now.desc}`).join(' | ')}`);
  } catch (e) {
    weatherState.err = e.message || String(e);
    // 每小时最多 warn 一次，别刷屏
    if (Date.now() - weatherState.lastWarnAt > 3600000) {
      weatherState.lastWarnAt = Date.now();
      console.warn(`[weather] 刷新失败（保留旧数据 ${weatherState.at ? Math.round((Date.now() - weatherState.at) / 60000) + ' 分钟前' : '无'}）:`, weatherState.err);
    }
  }
}

function startWeatherLoop() {
  refreshWeather();
  const t = setInterval(refreshWeather, WEATHER_REFRESH_MS);
  if (t.unref) t.unref();
}

function weatherFresh() {
  return weatherState.at > 0 && Date.now() - weatherState.at <= WEATHER_STALE_MS;
}

// 给 prompt 用的一行摘要（proactive 阶段一决策门用）
function formatWeatherLine() {
  if (!weatherFresh() || weatherState.cities.length === 0) return '';
  const c = weatherState.cities[0];
  const today = c.days[0] || {};
  const bits = [`${c.name} ${Math.round(c.now.temp)}℃ ${c.now.desc}`];
  if (Number.isFinite(today.tmin) && Number.isFinite(today.tmax)) bits.push(`今天 ${Math.round(today.tmin)}～${Math.round(today.tmax)}℃`);
  if (Number.isFinite(today.pop) && today.pop >= 30) bits.push(`降水概率 ${today.pop}%`);
  if (c.aqi && c.aqi.level && c.aqi.level !== '优') bits.push(`空气${c.aqi.level}`);
  return `天气：${bits.join('，')}`;
}

function fmtHmMin(iso) {
  const m = String(iso || '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

// 注入 system prompt 的 [天气] 块
function formatWeatherBlock() {
  if (!weatherFresh() || weatherState.cities.length === 0) return '';
  const ageMin = Math.round((Date.now() - weatherState.at) / 60000);
  const out = ['[天气]'];
  for (const c of weatherState.cities) {
    const n = c.now;
    const today = c.days[0] || {};
    const tomorrow = c.days[1] || {};
    out.push(`${c.name}（${c.time}，数据 ${ageMin} 分钟前）`);
    const nowBits = [`${Math.round(n.temp)}℃`, `体感 ${Math.round(n.feels)}℃`, n.desc, `湿度 ${n.humidity}%`];
    if (Number.isFinite(n.windKmh) && n.windKmh >= 1) nowBits.push(`${n.windDir}风 ${Math.round(n.windKmh)}km/h`);
    if (Number.isFinite(n.precip) && n.precip > 0) nowBits.push(`正在下（${n.precip}mm）`);
    out.push(`现在：${nowBits.join('，')}`);
    if (Number.isFinite(today.tmin) && Number.isFinite(today.tmax)) {
      const d1 = [`${Math.round(today.tmin)}～${Math.round(today.tmax)}℃`, today.desc];
      if (Number.isFinite(today.pop)) d1.push(`降水概率 ${today.pop}%`);
      const sr = fmtHmMin(today.sunrise), ss = fmtHmMin(today.sunset);
      if (sr && ss) d1.push(`日出 ${sr} / 日落 ${ss}`);
      out.push(`今天：${d1.join('，')}`);
    }
    if (Number.isFinite(tomorrow.tmin) && Number.isFinite(tomorrow.tmax)) {
      const d2 = [`${Math.round(tomorrow.tmin)}～${Math.round(tomorrow.tmax)}℃`, tomorrow.desc];
      if (Number.isFinite(tomorrow.pop)) d2.push(`降水概率 ${tomorrow.pop}%`);
      out.push(`明天：${d2.join('，')}`);
    }
    const pops = (c.hours || []).map(h => h.pop).filter(v => Number.isFinite(v));
    if (pops.length >= 3 && Math.max(...pops) >= 20) {
      out.push(`未来 6 小时降水概率：${pops.map(p => p + '%').join(' → ')}`);
    }
    if (c.aqi && (Number.isFinite(c.aqi.pm25) || Number.isFinite(c.aqi.usAqi))) {
      const ab = [];
      if (Number.isFinite(c.aqi.pm25)) ab.push(`PM2.5 ${Math.round(c.aqi.pm25)}μg/m³`);
      if (Number.isFinite(c.aqi.usAqi)) ab.push(`AQI ${Math.round(c.aqi.usAqi)}（${c.aqi.level}）`);
      out.push(`空气质量：${ab.join('，')}`);
    }
  }
  out.push('[天气结束]');
  return out.join('\n') + '\n\n';
}

// 删除若干条手动睡眠记录（按 bed+wake 精确定位），缓存 + 磁盘文件（按醒来日期分文件）同步改
function deleteSleepEntries(items) {
  const keys = new Set((items || [])
    .map(it => ({ bed: Number(it && it.bed), wake: Number(it && it.wake) }))
    .filter(it => Number.isFinite(it.bed) && Number.isFinite(it.wake))
    .map(it => `${it.bed}-${it.wake}`));
  if (keys.size === 0) return [];
  const removed = [];
  const keep = [];
  for (const e of sleepCache) (keys.has(`${e.bed}-${e.wake}`) ? removed : keep).push(e);
  if (removed.length === 0) return [];
  sleepCache = keep;

  // 按醒来日期分组，重写对应文件（tmp + rename；整天都删光了就把文件删掉）
  const byDate = new Map();
  for (const e of removed) {
    const d = localDateStr(new Date(e.wake));
    if (!byDate.has(d)) byDate.set(d, new Set());
    byDate.get(d).add(`${e.bed}-${e.wake}`);
  }
  for (const [date, dayKeys] of byDate) {
    const file = path.join(HEALTH_DIR, `sleep-manual-${date}.jsonl`);
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const keptLines = lines.filter(line => {
        try { const d = JSON.parse(line); return !dayKeys.has(`${d.bed}-${d.wake}`); } catch { return true; }
      });
      if (keptLines.length === 0) {
        fs.unlinkSync(file);
      } else {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, keptLines.join('\n') + '\n');
        fs.renameSync(tmp, file);
      }
    } catch (e) {
      console.error('[sleep] 删除后重写文件失败:', e.message);
    }
  }
  return removed;
}

// 睡眠按「醒来日期（UTC+8）」聚合：一天里可能有多段（夜里 + 午睡/回笼觉），
// 时长要加起来，平均也要按「天」算而不是按「段」算——否则两段觉只算最后一段。
// 返回按日期升序：[{ date, totalMinutes, count, bed, wake, segments:[{bed,wake,minutes}] }]
function groupSleepByDay(entries = sleepCache) {
  const map = new Map();
  for (const e of entries) {
    if (!e || !e.bed || !e.wake) continue;
    const minutes = Number.isFinite(e.minutes) ? e.minutes : Math.round((e.wake - e.bed) / 60000);
    if (!(minutes > 0)) continue;
    const key = localDateStr(new Date(e.wake));
    let day = map.get(key);
    if (!day) { day = { date: key, totalMinutes: 0, count: 0, segments: [] }; map.set(key, day); }
    day.totalMinutes += minutes;
    day.segments.push({ bed: e.bed, wake: e.wake, minutes });
  }
  const out = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const d of out) {
    d.segments.sort((x, y) => x.bed - y.bed);
    d.count = d.segments.length;
    d.bed = d.segments[0].bed;                                  // 当天第一段的入睡时间
    d.wake = d.segments[d.segments.length - 1].wake;            // 当天最后一段的醒来时间
  }
  return out;
}

// 一段时间的平均（按天）：返回 { days, totalMinutes, avgMinutes }
function sleepStats(days) {
  if (!Array.isArray(days) || days.length === 0) return { days: 0, totalMinutes: 0, avgMinutes: 0 };
  const totalMinutes = days.reduce((a, d) => a + (d.totalMinutes || 0), 0);
  return { days: days.length, totalMinutes, avgMinutes: Math.round(totalMinutes / days.length) };
}

// 分钟 → "X 小时 Y 分钟"
function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} 小时${m ? ' ' + m + ' 分钟' : ''}` : `${m} 分钟`;
}

function fmtSleepClock(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatSleepBlock() {
  const days = groupSleepByDay();
  if (days.length === 0) return '';
  const latest = days[days.length - 1];
  if (Date.now() - latest.wake > 3 * 86400000) return '';   // 3 天没新记录就不注入

  // 一天多段时逐段列出，避免把「第一段入睡→最后一段醒来」的跨度误读成睡眠时长
  const detail = latest.count > 1
    ? latest.segments.map(s => `- ${fmtSleepClock(s.bed)}–${fmtSleepClock(s.wake)}（${fmtMinutes(s.minutes)}）`).join('\n')
    : `- ${fmtSleepClock(latest.bed)}–${fmtSleepClock(latest.wake)}`;

  // 近 7 天平均：按天算（一天多段先合并再平均）
  const weekAgoStr = localDateStr(new Date(Date.now() - 7 * 86400000));
  const recentDays = days.filter(d => d.date >= weekAgoStr);
  let avgLine = '';
  if (recentDays.length >= 2) {
    const avgMin = Math.round(recentDays.reduce((a, d) => a + d.totalMinutes, 0) / recentDays.length);
    avgLine = `\n近 ${recentDays.length} 天平均：${fmtMinutes(avgMin)}（一天多段按合计算）`;
  }

  const head = latest.count > 1
    ? `最近一次：${latest.date}（UTC+8，分 ${latest.count} 段睡，中间清醒）`
    : `最近一次：${latest.date}（UTC+8）`;
  return `[睡眠]\n${head}\n${detail}\n合计：${fmtMinutes(latest.totalMinutes)}${avgLine}\n[睡眠结束]\n\n`;
}

// 包名 → 友好名称
const PKG_NAMES = {
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.eg.android.AlipayGphone': '支付宝',
  'com.taobao.taobao': '淘宝',
  'com.jingdong.app.mall': '京东',
  'com.ss.android.ugc.aweme': '抖音',
  'com.ss.android.article.news': '今日头条',
  'com.sina.weibo': '微博',
  'tv.danmaku.bili': 'B站',
  'com.netease.cloudmusic': '网易云音乐',
  'com.tencent.qqmusic': 'QQ音乐',
  'com.kugou.android': '酷狗音乐',
  'com.zhihu.android': '知乎',
  'com.ximalaya.ting.android': '喜马拉雅',
  'com.duokan.reader': '多看阅读',
  'com.microsoft.emmx': 'Edge',
  'com.android.chrome': 'Chrome',
  'com.google.android.youtube': 'YouTube',
  'com.egnor.aletheia': 'Aletheia',
  'com.xiaomi.shop': '小米商城',
  'com.miui.health': '小米健康',
  'org.telegram.messenger': 'Telegram',
  'com.discord': 'Discord',
  'com.reddit.frontpage': 'Reddit',
  'com.twitter.android': 'X/Twitter',
  'com.instagram.android': 'Instagram',
  'com.facebook.katana': 'Facebook',
  'com.spotify.music': 'Spotify',
  'com.openai.chatgpt': 'ChatGPT',
  'com.google.android.apps.maps': 'Google Maps',
  'com.google.android.gm': 'Gmail',
  'com.xingin.xhs': '小红书',
  'com.huashi.app': '米画师',
  'com.larus.nova': '豆包',
  'com.alibaba.android.rimet': '钉钉',
};

function friendlyAppName(pkg) {
  if (PKG_NAMES[pkg]) return PKG_NAMES[pkg];
  const parts = pkg.split('.');
  return parts[parts.length - 1];
}

function getRecentNonAletheia() {
  if (!screenTimeCache || !screenTimeCache.data) return null;
  const others = screenTimeCache.data.filter(i => i.pkg !== 'com.egnor.aletheia');
  if (others.length === 0) return null;
  // 优先按 lastUsed 降序（native 补上后自动生效），否则按 mins 降序（已排序）
  if (others[0].lastUsed) {
    others.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }
  return others[0];
}

function formatScreenTimeBlock() {
  if (!screenTimeCache || !screenTimeCache.data || screenTimeCache.data.length === 0) return '';
  const age = Date.now() - (screenTimeCache._received_ts || screenTimeCache.timestamp);
  if (age > 6 * 3600 * 1000) return '';
  const lines = ['[屏幕使用时间（今日）]'];
  const recent = getRecentNonAletheia();
  if (recent) {
    lines.push(`最近使用：${friendlyAppName(recent.pkg)}`);
  }
  for (const item of screenTimeCache.data) {
    const name = friendlyAppName(item.pkg);
    const h = Math.floor(item.mins / 60);
    const m = item.mins % 60;
    const dur = h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`;
    lines.push(`${name}：${dur}`);
  }
  lines.push('[屏幕使用时间结束]');
  return lines.join('\n') + '\n\n';
}

function saveSleepSegmentsToDisk() {
  try {
    if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
    fs.writeFileSync(SLEEP_SEGMENTS_PATH, JSON.stringify({
      segments: latestSleepSegments,
      updated_ts: latestSleepSegmentsTs,
    }));
  } catch (e) {
    console.error('[health-rt] sleep write error:', e.message);
  }
}

function getSleepSegments() {
  // 超过 24h 没更新视为过期
  if (!latestSleepSegmentsTs || Date.now() - latestSleepSegmentsTs > REALTIME_MAX_AGE_MS) {
    return [];
  }
  return latestSleepSegments;
}

function appendRealtime(entry) {
  const now = Date.now();

  // sleep_segments 是 24h 全量快照，单独存储 + 整段覆盖，不进时间序列
  if (Array.isArray(entry.sleep_segments)) {
    latestSleepSegments = entry.sleep_segments
      .filter(s => s && typeof s.start === 'number' && typeof s.minutes === 'number' && s.minutes > 0)
      .map(s => ({ start: s.start, minutes: s.minutes }))
      .sort((a, b) => a.start - b.start);
    latestSleepSegmentsTs = now;
    saveSleepSegmentsToDisk();
    delete entry.sleep_segments;
  }

  // 没有时序字段（只是单纯送 sleep）就不入缓存，避免空条目
  const hasTimeseries = ['heart_rate', 'steps', 'stress', 'spo2'].some(k => entry[k] !== undefined && entry[k] !== null);
  if (!hasTimeseries) return;

  // 优先用客户端时间戳作为测量时间，没传才用服务端时间
  const clientTs = parseClientTimestamp(entry.timestamp);
  const ts = clientTs || now;
  entry._ts = ts;                   // 测量时间
  entry._time = new Date(ts).toISOString();
  entry._received_ts = now;         // 服务端接收时间（用于"新鲜度"判断）
  entry._received_time = new Date(now).toISOString();
  // 手表数据有多旧（客户端可选上报）：老数据也能看出"表断了"而不是"没数据"
  // 每 30 分钟在服务端日志里留一行推送节奏，方便从服务端侧判断断没断
  _healthPushCount++;
  if (_healthPushCount % 30 === 1) {
    console.log(`[health-rt] 第 ${_healthPushCount} 条推送，_ts=${new Date(ts).toISOString()}${entry.watch_age_minutes != null ? '，手表数据 ' + entry.watch_age_minutes + ' 分钟前' : ''}`);
  }
  realtimeCache.push(entry);
  // 保持按时间排序（客户端可能补传旧数据）
  realtimeCache.sort((a, b) => a._ts - b._ts);

  // 清理超过 24 小时的
  const cutoff = Date.now() - REALTIME_MAX_AGE_MS;
  realtimeCache = realtimeCache.filter(e => e._ts >= cutoff);

  // 追加到按天滚动的 jsonl（按 entry 自己的时间分文件，本地时区）
  try {
    if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
    const dateStr = localDateStr(new Date(ts));
    const file = path.join(HEALTH_DIR, `realtime-${dateStr}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[health-rt] write error:', e.message);
  }
}

function getLatestRealtime() {
  if (realtimeCache.length === 0) return null;
  const now = Date.now();
  // 排除：未来时间戳（客户端时钟错乱产生的脏数据）
  // 优先按 _received_ts 排序；老数据回落到 _ts，但仅当 _ts 不在未来
  const candidates = realtimeCache.filter(e => {
    const ts = e._received_ts || e._ts;
    return ts && ts <= now + 60_000; // 允许 1 分钟时钟漂移
  });
  if (candidates.length === 0) return null;
  let latest = candidates[0];
  for (const e of candidates) {
    const a = e._received_ts || e._ts;
    const b = latest._received_ts || latest._ts;
    if (a > b) latest = e;
  }
  const refTs = latest._received_ts || latest._ts;
  if (now - refTs > REALTIME_FRESH_MS) return null;
  return latest;
}

function getRealtimeTrend(hours = 3) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const entries = realtimeCache.filter(e => e._ts >= cutoff);
  if (entries.length === 0) return { error: '没有数据', hours, count: 0 };

  const hrValues = entries.map(e => e.heart_rate).filter(v => v && v > 0);
  const stressValues = entries.map(e => e.stress).filter(v => v != null && v >= 0);
  const stepsValues = entries.map(e => e.steps).filter(v => v != null);

  const result = { hours, count: entries.length, from: entries[0]._time, to: entries[entries.length - 1]._time };

  if (hrValues.length > 0) {
    result.heart_rate = {
      avg: Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length),
      max: Math.max(...hrValues),
      min: Math.min(...hrValues),
      latest: hrValues[hrValues.length - 1],
      trend: hrValues.length >= 3 ? (
        hrValues.slice(-3).reduce((a, b) => a + b, 0) / 3 > hrValues.slice(0, 3).reduce((a, b) => a + b, 0) / 3
          ? '上升' : hrValues.slice(-3).reduce((a, b) => a + b, 0) / 3 < hrValues.slice(0, 3).reduce((a, b) => a + b, 0) / 3 - 5
            ? '下降' : '平稳'
      ) : '数据不足',
    };
  }

  if (stressValues.length > 0) {
    result.stress = {
      avg: Math.round(stressValues.reduce((a, b) => a + b, 0) / stressValues.length),
      max: Math.max(...stressValues),
      min: Math.min(...stressValues),
      latest: stressValues[stressValues.length - 1],
    };
  }

  if (stepsValues.length > 0) {
    result.steps = { latest: stepsValues[stepsValues.length - 1] };
  }

  return result;
}

function parseHealthDB(dateStr) {
  return new Promise((resolve) => {
    const args = [PARSE_HEALTH_SCRIPT, HEALTH_DB_PATH];
    if (dateStr) args.push(dateStr);
    const { execFile } = require('child_process');
    execFile('python3', args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        console.error('[health] parse error:', err.message);
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (data.error) { resolve(null); return; }
        if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
        fs.writeFileSync(HEALTH_JSON_PATH, JSON.stringify(data, null, 2));
        console.log(`[health] parsed: ${data.date}, steps=${data.steps}`);
        resolve(data);
      } catch {
        resolve(null);
      }
    });
  });
}

function getHealthDataRaw() {
  try {
    if (!fs.existsSync(HEALTH_JSON_PATH)) return null;
    return JSON.parse(fs.readFileSync(HEALTH_JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function todayInUTC8() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 从实时缓存聚合指定日期（UTC+8）的日汇总
function aggregateDailyFromRealtime(dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00+08:00').getTime();
  const dayEnd = dayStart + 86400 * 1000;
  const entries = realtimeCache.filter(e => {
    const ts = e._ts || e._received_ts || 0;
    return ts >= dayStart && ts < dayEnd;
  });

  // 睡眠片段：仅当聚合"今天"时填入（push 端送的是滚动 24h 全量，不分日期）
  // 但要按「醒来时间落在这一天」过滤 —— 否则今天凌晨的汇总会显示昨晚（其实属于昨天）的那一觉
  const isToday = dateStr === todayInUTC8();
  const segs = isToday
    ? getSleepSegments().filter(s => {
        const end = Number(s && s.start) + Number(s && s.minutes || 0) * 60000;
        return Number.isFinite(end) && end >= dayStart && end < dayEnd;
      })
    : [];

  if (entries.length === 0 && segs.length === 0) return null;

  const result = { date: dateStr, _source: 'realtime' };

  if (entries.length > 0) {
    result._sample_count = entries.length;

    const stepsVals = entries.map(e => e.steps).filter(v => typeof v === 'number' && v >= 0);
    if (stepsVals.length) result.steps = Math.max(...stepsVals);

    const hrVals = entries.map(e => e.heart_rate).filter(v => typeof v === 'number' && v > 0);
    if (hrVals.length) {
      result.hr_avg = Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length);
      result.hr_max = Math.max(...hrVals);
      result.hr_min = Math.min(...hrVals);
    }

    const stressVals = entries.map(e => e.stress).filter(v => typeof v === 'number' && v > 0);
    if (stressVals.length) {
      result.stress_avg = Math.round(stressVals.reduce((a, b) => a + b, 0) / stressVals.length);
      result.stress_max = Math.max(...stressVals);
      result.stress_min = Math.min(...stressVals);
    }

    const spo2Vals = entries.map(e => e.spo2).filter(v => typeof v === 'number' && v > 0);
    if (spo2Vals.length) {
      result.spo2_avg = Math.round(spo2Vals.reduce((a, b) => a + b, 0) / spo2Vals.length);
    }
  }

  if (segs.length) {
    result.sleep_total_minutes = segs.reduce((a, s) => a + (s.minutes || 0), 0);
    result.sleep_segment_count = segs.length;
    result.sleep_segments = segs;
  }

  return result;
}

// 合并已上传 DB 的日汇总与实时聚合
// 实时聚合提供"当日动态字段"，DB 提供 calories/hr_resting 等手环原生字段
// 注意：旧的 sleep（deep/light/rem 拆分）已废弃 — Mi Band 9 通过 GB 拿不到 stage 拆分
function getMergedDaily() {
  const today = todayInUTC8();
  const stored = getHealthDataRaw();          // 来自上次手动上传的 DB
  const aggregated = aggregateDailyFromRealtime(today);

  if (aggregated && stored && stored.date === today) {
    const merged = { ...stored, ...aggregated };
    if (stored.calories != null) merged.calories = stored.calories;
    if (stored.hr_resting != null) merged.hr_resting = stored.hr_resting;
    delete merged.sleep;                       // 废弃旧字段
    merged._source = 'merged';
    return merged;
  }
  if (aggregated) return aggregated;            // 只有实时聚合
  // 兜底「上次手动上传的 DB」：**只有它确实是今天的**才拿来当"日汇总"。
  // 以前不看日期，几个月前上传的 DB（如 2026-04-30）会顶替今天的日汇总，
  // 表现就是「实时数据有、日汇总却是别的日期的数字」—— 非常误导。
  if (stored && stored.date === today) {
    const { sleep, ...rest } = stored;
    return rest;
  }
  return null;
}

function getHealthData() {
  // 只供 system prompt 注入：用合并后的日汇总，且必须是今天/昨天（UTC+8）
  const data = getMergedDaily();
  if (!data) return null;
  const today = todayInUTC8();
  const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  if (data.date !== today && data.date !== yesterday) return null;
  return data;
}

function formatHealthBlock() {
  const blocks = [];

  // 实时数据（5 分钟内有推送时）
  const rt = getLatestRealtime();
  if (rt) {
    const refTs = rt._received_ts || rt._ts;
    // 强制 UTC+8 显示 HH:MM
    const b = new Date(refTs + 8 * 3600 * 1000);
    const time = `${String(b.getUTCHours()).padStart(2,'0')}:${String(b.getUTCMinutes()).padStart(2,'0')}`;
    const lines = ['[实时健康数据]', `时间：${time}（UTC+8）`];
    if (rt.heart_rate) lines.push(`心率：${rt.heart_rate} bpm`);
    if (rt.steps != null) lines.push(`步数：${rt.steps.toLocaleString()}`);
    if (rt.stress != null) lines.push(`压力：${rt.stress}`);
    if (rt.spo2) lines.push(`血氧：${rt.spo2}%`);
    lines.push('[实时健康数据结束]');
    blocks.push(lines.join('\n'));
  }

  // 日汇总：优先用合并后的（实时聚合 + DB），保证当日数据自动更新
  const data = getMergedDaily();
  if (data) {
    const lines = [`[最近一日健康汇总]`, `日期：${data.date}`];
    if (data.steps != null) lines.push(`步数：${data.steps.toLocaleString()}`);
    if (data.calories) lines.push(`消耗热量：${data.calories} kcal`);
    if (data.hr_avg) {
      let hrLine = `心率：平均 ${data.hr_avg} bpm`;
      if (data.hr_max) hrLine += `，最高 ${data.hr_max}`;
      if (data.hr_min) hrLine += `，最低 ${data.hr_min}`;
      if (data.hr_resting) hrLine += `，静息 ${data.hr_resting}`;
      lines.push(hrLine);
    }
    if (data.stress_avg) {
      lines.push(`压力：平均 ${data.stress_avg}（最高 ${data.stress_max || '-'}，最低 ${data.stress_min || '-'}）`);
    }
    if (data.spo2_avg) lines.push(`血氧：${data.spo2_avg}%`);
    lines.push('[最近一日健康汇总结束]');
    blocks.push(lines.join('\n'));
  }

  const sleepBlock = formatSleepBlock();
  if (sleepBlock) blocks.push(sleepBlock.trim());

  const weightBlock = formatWeightBlock();
  if (weightBlock) blocks.push(weightBlock.trim());

  if (blocks.length === 0) return '';
  return blocks.join('\n\n') + '\n\n';
}

function reply(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ===== 记账（Audit）=====
// 存储：audit/tx-YYYY-MM.jsonl —— 按月分文件、追加写（查询某月只读一个文件）
// 金额一律以「分」整数落盘，杜绝 0.1+0.2 这类浮点误差；API 同时给 amount（元）与 amount_cents（权威）
// 日期 / 月份切分统一按 UTC+8（和健康、对话时间线的显示口径一致）
const AUDIT_DIR = path.join(__dirname, 'audit');
const AUDIT_CATEGORIES = ['餐饮', '零食', '饮料', '医疗', '教育', '日用', '服饰', '娱乐', '交通', '购物', '其它杂项'];
// 入账（收入）分类：和支出共用同一套存储/流水/筛选，只靠记录上的 type 区分
const AUDIT_INCOME_CATEGORIES = ['工资', '兼职', '红包', '报销', '退款', '理财', '其它收入'];
// 老记录没有 type 字段 → 一律当支出（向后兼容）
const auditTypeOf = r => (r && r.type === 'income') ? 'income' : 'expense';
const AUDIT_MAX_CENTS = 100 * 1000 * 1000;   // 单笔上限 100 万元
const AUDIT_MAX_NOTE_LEN = 200;
const AUDIT_TZ_OFFSET_MS = 8 * 3600 * 1000;
try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

// 时间戳 → 'YYYY-MM' / 'YYYY-MM-DD'（UTC+8）
function auditMonthKeyOf(ts) {
  const d = new Date(ts + AUDIT_TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function auditDayKeyOf(ts) {
  const d = new Date(ts + AUDIT_TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
// 时间戳 → UTC+8 的 'HH:MM'（给 Daemon 明细标每笔消费时刻）
function auditClockOf(ts) {
  const d = new Date(ts + AUDIT_TZ_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
// 'YYYY-MM' → 该月 1 号 00:00（UTC+8）的毫秒时间戳
function auditMonthStartMs(monthKey) {
  return Date.parse(`${monthKey}-01T00:00:00+08:00`);
}
function auditMonthEndMs(monthKey) {
  const start = auditMonthStartMs(monthKey);
  if (!Number.isFinite(start)) return NaN;
  const [y, m] = monthKey.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return auditMonthStartMs(`${ny}-${String(nm).padStart(2, '0')}`) - 1;
}
function auditFilePath(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(monthKey || '')) return null;
  return path.join(AUDIT_DIR, `tx-${monthKey}.jsonl`);
}
// 已有月份（倒序），用于「全部月份」翻页与月份下拉
function auditListMonths() {
  try {
    return fs.readdirSync(AUDIT_DIR)
      .map(f => /^tx-(\d{4}-\d{2})\.jsonl$/.exec(f))
      .filter(Boolean)
      .map(m => m[1])
      .sort()
      .reverse();
  } catch { return []; }
}

// 严格「元 → 分」：字符串按位拆，不走 `*100`（19.99*100 === 1998.9999999999998）
function parseAmountToCents(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // 数字来源按十进制字面量检查小数位：超过两位直接拒，不偷偷四舍五入；科学计数法一律拒
    const s = String(v);
    if (/e/i.test(s)) return null;
    return parseAmountToCents(s);
  }
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}
function centsToYuan(cents) { return Math.round(cents) / 100; }
// 给模型/摘要用的金额展示：整数分位补 0（28.50 → 28.5，412.00 → 412.0）
function auditFmtYuan(cents) {
  const v = Math.round(cents || 0);
  return (v % 10 === 0) ? (v / 100).toFixed(1) : (v / 100).toFixed(2);
}

function auditReadMonth(monthKey) {
  const file = auditFilePath(monthKey);
  if (!file || !fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && typeof r.id === 'string'
        && Number.isInteger(r.amount_cents) && Number.isFinite(r.timestamp));
  } catch (e) {
    console.warn(`[audit] 读取 ${monthKey} 失败:`, e.message);
    return [];
  }
}

// 整月重写（删除用）：tmp + atomic rename，断电不会留半截文件
function auditWriteMonth(monthKey, rows) {
  const file = auditFilePath(monthKey);
  if (!file) return false;
  if (!rows.length) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    return true;
  }
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

function auditAppend(monthKey, rec) {
  const file = auditFilePath(monthKey);
  if (!file) throw new Error('bad month key');
  fs.mkdirSync(AUDIT_DIR, { recursive: true });   // 目录被误删也能自愈，别让记账失败
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
}

// 对外统一形状：id / timestamp / amount / category / note（+ 元分两种精度）
function auditPublic(r) {
  return {
    id: r.id,
    timestamp: r.timestamp,
    amount: centsToYuan(r.amount_cents),
    amount_cents: r.amount_cents,
    type: auditTypeOf(r),
    category: r.category,
    note: r.note || '',
    created_at: r.created_at || null,
  };
}

// 校验并构造一条记录；返回 { error } 或 { rec }
function auditBuildRecord(body) {
  const b = body && typeof body === 'object' ? body : {};
  let cents = null;
  if (Number.isInteger(b.amount_cents)) cents = b.amount_cents;
  else if (b.amount !== undefined && b.amount !== null && b.amount !== '') cents = parseAmountToCents(b.amount);
  if (cents === null) return { error: '金额格式不正确（最多两位小数）' };
  if (cents <= 0) return { error: '金额必须大于 0' };
  if (cents > AUDIT_MAX_CENTS) return { error: '单笔金额超过上限（100 万元）' };

  let ts = Date.now();
  if (b.timestamp !== undefined && b.timestamp !== null && b.timestamp !== '') {
    const parsed = parseClientTimestamp(b.timestamp);
    if (!parsed) return { error: 'timestamp 无法解析' };
    ts = parsed;
  }
  if (ts > Date.now() + 3600 * 1000) return { error: 'timestamp 不能是未来时间（超过 1 小时）' };

  const type = b.type === 'income' ? 'income' : 'expense';
  const cats = type === 'income' ? AUDIT_INCOME_CATEGORIES : AUDIT_CATEGORIES;
  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!cats.includes(category)) {
    return { error: `${type === 'income' ? '入账' : '支出'}分类必须是：${cats.join(' / ')}` };
  }

  let note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > AUDIT_MAX_NOTE_LEN) return { error: `备注最长 ${AUDIT_MAX_NOTE_LEN} 字` };

  return {
    rec: {
      id: crypto.randomBytes(9).toString('base64url'),
      timestamp: Math.round(ts),
      amount_cents: cents,
      type,
      category,
      note,
      created_at: Date.now(),
    },
  };
}

// 取时间区间内的全部记录
function auditCollect(fromMs, toMs) {
  const rows = [];
  const lo = auditMonthKeyOf(fromMs);
  const hi = auditMonthKeyOf(toMs);
  for (const mk of auditListMonths()) {
    if (mk < lo || mk > hi) continue;   // 'YYYY-MM' 字符串比较即可
    for (const r of auditReadMonth(mk)) {
      if (r.timestamp >= fromMs && r.timestamp <= toMs) rows.push(r);
    }
  }
  return rows;
}

// 分类聚合 + 合计（分）；type 默认 'expense'，所以现有「支出」口径不受影响
function auditAggregate(rows, type = 'expense') {
  const byCat = new Map();
  const picked = rows.filter(r => auditTypeOf(r) === type);
  let total = 0;
  for (const r of picked) {
    total += r.amount_cents;
    const cur = byCat.get(r.category) || { category: r.category, total_cents: 0, count: 0 };
    cur.total_cents += r.amount_cents;
    cur.count += 1;
    byCat.set(r.category, cur);
  }
  const by_category = [...byCat.values()]
    .sort((a, b) => b.total_cents - a.total_cents)
    .map(x => ({
      category: x.category,
      total_cents: x.total_cents,
      total: centsToYuan(x.total_cents),
      count: x.count,
      pct: total > 0 ? Math.round((x.total_cents / total) * 1000) / 10 : 0,
    }));
  return { total_cents: total, total: centsToYuan(total), count: picked.length, by_category };
}

// 今日 / 最近 7 天 → 给 Daemon 的一行摘要（context-export 与 System Prompt 共用）
function buildAuditContext() {
  const now = Date.now();
  const todayStart = Date.parse(`${auditDayKeyOf(now)}T00:00:00+08:00`);
  const weekStart = todayStart - 6 * 86400000;
  const todayRows = auditCollect(todayStart, now);
  const weekRows = auditCollect(weekStart, now);

  const sumOf = (rows, type) => rows.reduce((s, r) => s + (auditTypeOf(r) === type ? r.amount_cents : 0), 0);
  const todayTotal = sumOf(todayRows, 'expense');
  const weekTotal = sumOf(weekRows, 'expense');
  const todayIn = sumOf(todayRows, 'income');
  const weekIn = sumOf(weekRows, 'income');

  // 今日明细：HH:MM 分类-备注 ¥金额（每笔带时刻和金额），列当天全部（按时间倒序，最近的在前）。
  // 只留一个 800 字的安全阀：个人记账一天很少超过 20 笔，真刷屏时截断免得把 prompt 撑爆
  const detailOf = (rows, type) => {
    const picked = rows.filter(r => auditTypeOf(r) === type);
    if (!picked.length) return '';
    let joined = picked.slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(r => {
        const label = [r.category, r.note].filter(Boolean).join('-');
        return `${auditClockOf(r.timestamp)} ${label} ¥${auditFmtYuan(r.amount_cents)}`;
      })
      .join('；');
    if (joined.length > 800) joined = joined.slice(0, 800) + '…';
    return ` (${joined})`;
  };
  const detail = detailOf(todayRows, 'expense');
  const incomeDetail = detailOf(todayRows, 'income');

  // 没有入账时保持原文案不变（老行为零变化）；有入账才追加那两段
  const incomePart = todayIn > 0
    ? `；今日已入账 ${auditFmtYuan(todayIn)} 元${incomeDetail}`
    : '';
  const weekPart = weekIn > 0
    ? `；本周累计：支出 ${auditFmtYuan(weekTotal)} 元，入账 ${auditFmtYuan(weekIn)} 元`
    : `；本周累计支出 ${auditFmtYuan(weekTotal)} 元`;
  const line = `[近期财务流水：今日已支出 ${auditFmtYuan(todayTotal)} 元${detail}${incomePart}${weekPart}]`;
  return {
    line,
    empty: weekRows.length === 0,
    today: {
      date: auditDayKeyOf(now),
      total_cents: todayTotal, total: centsToYuan(todayTotal), count: todayRows.filter(r => auditTypeOf(r) === 'expense').length,
      income_cents: todayIn, income: centsToYuan(todayIn),
    },
    week: {
      from: auditDayKeyOf(weekStart), to: auditDayKeyOf(now),
      total_cents: weekTotal, total: centsToYuan(weekTotal), count: weekRows.filter(r => auditTypeOf(r) === 'expense').length,
      income_cents: weekIn, income: centsToYuan(weekIn),
    },
  };
}

// System Prompt 注入块：有近 7 天流水才注入（否则空字符串，不占 token）
function formatAuditBlock() {
  try {
    const ctx = buildAuditContext();
    if (ctx.empty) return '';
    return `\n\n${ctx.line}\n\n`;
  } catch (e) {
    console.warn('[audit] context block failed:', e.message);
    return '';
  }
}

// ===== Conversations 持久化 =====
const CONVERSATIONS_DIR = path.join(__dirname, 'conversations');
try { fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true }); } catch {}

const convLocks = new Map();
function withConvLock(id, fn) {
  const prev = convLocks.get(id) || Promise.resolve();
  const job = prev.then(fn, fn);
  const silent = job.then(() => {}, () => {});
  convLocks.set(id, silent);
  silent.finally(() => {
    if (convLocks.get(id) === silent) convLocks.delete(id);
  });
  return job;
}

function convPath(id) { return path.join(CONVERSATIONS_DIR, `${id}.json`); }

function readConv(id) {
  try { return JSON.parse(fs.readFileSync(convPath(id), 'utf8')); }
  catch { return null; }
}

function writeConvAtomic(id, data) {
  const p = convPath(id);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, p);
}

function readJsonBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolve(txt ? JSON.parse(txt) : {});
      } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleConversations(req, res) {
  const url = new URL(req.url, 'http://x');
  // 支持 /api/conversations/<id>/since?after=N —— 轻量增量拉取，前端轮询用（主动消息实时冒出来）
  const mSince = url.pathname.match(/^\/api\/conversations\/([^\/]+)\/since$/);
  if (mSince && req.method === 'GET') {
    const sid = sanitizeConvId(decodeURIComponent(mSince[1]));
    if (!sid) return reply(res, 400, { error: 'invalid conv id' });
    return convSince(res, sid, Number(url.searchParams.get('after')) || 0);
  }
  // 小请求端点：删除/编辑/截断单条消息（前端整段 PUT 太重，34MB 会超限被打断）
  const mOp = url.pathname.match(/^\/api\/conversations\/([^\/]+)\/op$/);
  if (mOp && req.method === 'POST') {
    const oid = sanitizeConvId(decodeURIComponent(mOp[1]));
    if (!oid) return reply(res, 400, { error: 'invalid conv id' });
    return await convOp(req, res, oid);
  }
  const m = url.pathname.match(/^\/api\/conversations(?:\/([^\/]+))?$/);
  if (!m) return reply(res, 404, { error: 'not found' });
  const rawId = m[1] ? decodeURIComponent(m[1]) : null;

  // 特殊端点：导出全部
  if (rawId === 'export' && req.method === 'GET') return convExportAll(res);

  const id = rawId ? sanitizeConvId(rawId) : null;
  if (rawId && !id) return reply(res, 400, { error: 'invalid conv id' });

  try {
    if (req.method === 'GET' && !id) return convList(res);
    if (req.method === 'GET' && id)  return convGet(res, id);
    if (req.method === 'POST' && !id) return await convCreate(req, res);
    if (req.method === 'PATCH' && id) return await convPatch(req, res, id);
    if (req.method === 'PUT' && id)   return await convReplace(req, res, id);
    if (req.method === 'DELETE' && id) return await convDelete(res, id);
  } catch (e) {
    return reply(res, 400, { error: e.message || 'bad request' });
  }
  return reply(res, 405, { error: 'method not allowed' });
}

function convList(res) {
  let files;
  try { files = fs.readdirSync(CONVERSATIONS_DIR); }
  catch { return reply(res, 200, { conversations: [] }); }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
    const id = f.slice(0, -5);
    if (!sanitizeConvId(id)) continue;
    const conv = readConv(id);
    if (!conv) continue;
    out.push({
      id: conv.id || id,
      title: conv.title || '',
      created: conv.created || 0,
      updated_at: conv.updated_at || conv.created || 0,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
      settings: conv.settings || {},
    });
  }
  out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return reply(res, 200, { conversations: out });
}

function convGet(res, id) {
  const conv = readConv(id);
  if (!conv) return reply(res, 404, { error: 'not found' });
  return reply(res, 200, conv);
}

// 单条消息操作（删除/编辑/截断）—— 前端只发几百字节，服务端自己改文件
// op: delete{index} | edit{index, patch|text} | truncate{index}
async function convOp(req, res, id) {
  const body = await readJsonBody(req, 256 * 1024);
  if (!body || typeof body !== 'object') return reply(res, 400, { error: 'bad body' });
  const op = String(body.op || '');
  const idx = Math.floor(Number(body.index));
  if (!Number.isFinite(idx) || idx < 0) return reply(res, 400, { error: 'bad index' });
  let out = null;
  await withConvLock(id, async () => {
    const conv = readConv(id);
    if (!conv) { out = { code: 404, body: { error: 'not found' } }; return; }
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    const hist = Array.isArray(conv.history) ? conv.history : [];
    if (idx >= msgs.length) { out = { code: 400, body: { error: 'index out of range' } }; return; }
    const target = msgs[idx];
    // messages/history 两套数组坐标不同：按 role + 前 60 字从后往前找对应项
    const findHist = () => {
      const wantText = String(target.text || '').slice(0, 60);
      for (let i = hist.length - 1; i >= 0; i--) {
        const h = hist[i];
        if (!h || h.role !== target.role) continue;
        const t = ((h.parts || []).map(p => p.text || '').join('')).slice(0, 60);
        if (t === wantText) return i;
      }
      return -1;
    };
    const hi = findHist();

    if (op === 'delete') {
      msgs.splice(idx, 1);
      if (hi >= 0) hist.splice(hi, 1);
    } else if (op === 'edit') {
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : { text: body.text };
      for (const k of Object.keys(patch)) {
        if (patch[k] === null) delete target[k];
        else target[k] = patch[k];
      }
      if (hi >= 0 && patch.text !== undefined) {
        const h = hist[hi];
        const tp = (h.parts || []).find(p => 'text' in p);
        if (tp) tp.text = patch.text;
        else { h.parts = h.parts || []; h.parts.push({ text: patch.text }); }
      }
    } else if (op === 'truncate') {
      conv.messages = msgs.slice(0, idx + 1);
      conv.history = hist.slice(0, hi >= 0 ? hi + 1 : idx + 1);
    } else {
      out = { code: 400, body: { error: 'unknown op: ' + op } };
      return;
    }
    conv.updated_at = Date.now();
    writeConvAtomic(id, conv);
    console.log(`[conv] OP ${op} ${id} idx=${idx} → msg=${(conv.messages || []).length} hist=${(conv.history || []).length}`);
    out = { code: 200, body: { ok: true, op, messageCount: (conv.messages || []).length, historyCount: (conv.history || []).length } };
  });
  return reply(res, out ? out.code : 500, out ? out.body : { error: 'lock failed' });
}

// 增量拉取：只回 after 之后的新消息（前端轮询用，避免每次拉 9MB 全量）
function convSince(res, id, after) {
  const conv = readConv(id);
  if (!conv) return reply(res, 404, { error: 'not found' });
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  const from = Math.max(0, Math.min(Math.floor(after) || 0, msgs.length));
  // 图片占位：客户端跨端拿不到 _imgKey，统一换成 expired 占位（和 convGet 的语义一致）
  if (msgs.length > from) {
    console.log(`[conv-since] ${id} after=${from} → 返回 ${msgs.length - from} 条（total ${msgs.length}）`);
  }
  const slice = msgs.slice(from).map(m => {
    if (!m || !m.images || m.images.length === 0) return m;
    if (m.role === 'user') return { ...m, images: m.images.map(i => (typeof i === 'string' ? i : 'expired')) };
    return { ...m, images: m.images.map(i => (i && i.mimeType ? { mimeType: i.mimeType, expired: true } : 'expired')) };
  });
  return reply(res, 200, { ok: true, total: msgs.length, messages: slice, updated_at: conv.updated_at || 0 });
}

async function convCreate(req, res) {
  const body = await readJsonBody(req, 64 * 1024 * 1024);
  if (!body || typeof body !== 'object') return reply(res, 400, { error: 'bad body' });
  const id = sanitizeConvId(body.id || '');
  if (!id) return reply(res, 400, { error: 'invalid conv id' });
  if (fs.existsSync(convPath(id))) return reply(res, 409, { error: 'conv exists' });

  const now = Date.now();
  const conv = {
    id,
    title: typeof body.title === 'string' ? body.title : '',
    created: body.created || now,
    updated_at: body.updated_at || now,
    messages: Array.isArray(body.messages) ? body.messages : [],
    history: Array.isArray(body.history) ? body.history : [],
    tokens: typeof body.tokens === 'number' ? body.tokens : 0,
    settings: body.settings || {},
  };
  await withConvLock(id, async () => writeConvAtomic(id, conv));
  return reply(res, 201, conv);
}

async function convPatch(req, res, id) {
  const body = await readJsonBody(req, 64 * 1024 * 1024);
  if (!body || typeof body !== 'object') return reply(res, 400, { error: 'bad body' });

  await withConvLock(id, async () => {
    const conv = readConv(id);
    if (!conv) { reply(res, 404, { error: 'not found' }); return; }

    if (body.appendMessage) {
      if (!Array.isArray(conv.messages)) conv.messages = [];
      conv.messages.push(body.appendMessage);
    }
    if (Array.isArray(body.appendHistory)) {
      if (!Array.isArray(conv.history)) conv.history = [];
      conv.history.push(...body.appendHistory);
    }
    if (typeof body.title === 'string') conv.title = body.title;
    if (typeof body.tokens === 'number') conv.tokens = body.tokens;
    if (body.settings && typeof body.settings === 'object') conv.settings = body.settings;

    conv.updated_at = Date.now();
    writeConvAtomic(id, conv);
    console.log(`[conv] PATCH ${id} msg=${conv.messages ? conv.messages.length : 0} hist=${conv.history ? conv.history.length : 0}`);
    reply(res, 200, {
      ok: true,
      updated_at: conv.updated_at,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
      historyCount: Array.isArray(conv.history) ? conv.history.length : 0,
    });
  });
}

async function convReplace(req, res, id) {
  const body = await readJsonBody(req, 64 * 1024 * 1024);
  if (!body || typeof body !== 'object') return reply(res, 400, { error: 'bad body' });
  if (body.id && sanitizeConvId(body.id) !== id) {
    return reply(res, 400, { error: 'id mismatch' });
  }
  await withConvLock(id, async () => {
    const existed = readConv(id);
    const now = Date.now();
    const conv = {
      id,
      title: typeof body.title === 'string' ? body.title : (existed?.title || ''),
      created: body.created || existed?.created || now,
      updated_at: now,
      messages: Array.isArray(body.messages) ? body.messages : (existed?.messages || []),
      history: Array.isArray(body.history) ? body.history : (existed?.history || []),
      tokens: typeof body.tokens === 'number' ? body.tokens : (existed?.tokens || 0),
      settings: body.settings || existed?.settings || {},
    };
    writeConvAtomic(id, conv);
    console.log(`[conv] PUT ${id} msg=${conv.messages ? conv.messages.length : 0} hist=${conv.history ? conv.history.length : 0}`);
    reply(res, 200, conv);
  });
}

function convExportAll(res) {
  let files;
  try { files = fs.readdirSync(CONVERSATIONS_DIR); }
  catch { files = []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
    const id = f.slice(0, -5);
    if (!sanitizeConvId(id)) continue;
    const conv = readConv(id);
    if (conv) out.push(conv);
  }
  out.sort((a, b) => (a.created || 0) - (b.created || 0));
  return reply(res, 200, {
    exported_at: Date.now(),
    count: out.length,
    conversations: out,
  });
}

async function convDelete(res, id) {
  await withConvLock(id, async () => {
    try { fs.unlinkSync(convPath(id)); } catch {}
    reply(res, 200, { ok: true });
  });
}

async function handleTranslate(req, res) {
  try {
    const body = await readJsonBody(req, 4096);
    const text = (body.text || '').trim();
    if (!text) return reply(res, 400, { error: 'text is required' });
    if (!DEEPSEEK_API_KEY) return reply(res, 500, { error: 'DEEPSEEK_API_KEY not set' });

    const r = await fetch(DEEPSEEK_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: '你是翻译器。只输出译文，不加任何解释。中文翻英文，其他语言翻中文。' },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      }),
    });
    const data = await r.json();
    reply(res, 200, {
      translation: data.choices?.[0]?.message?.content?.trim() || '翻译失败',
    });
  } catch (err) {
    reply(res, 500, { error: 'translate error: ' + err.message });
  }
}

function handleRequest(req, res) {
  // --- Serve index.html at / ---
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error reading index.html'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // 禁用缓存：单文件 SPA，部署后客户端必须立刻拿到新版
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(data);
    });
    return;
  }

  // --- Serve WARP installer ---
  if (req.method === 'GET' && req.url === '/warp.msi') {
    const fpath = path.join(__dirname, 'warp.msi');
    try {
      const stat = fs.statSync(fpath);
      res.writeHead(200, { 'Content-Type': 'application/x-msi', 'Content-Length': stat.size });
      fs.createReadStream(fpath).pipe(res);
    } catch (e) { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // --- Serve 主动消息取件脚本（手机 Termux 一条 curl 就能装，脚本里没有密钥）---
  if (req.method === 'GET' && ['/proactive_pull.sh', '/proactive_pull.py', '/proactive.env.example', '/push_health.py'].includes(req.url)) {
    const isEnv = req.url.endsWith('.example');
    const isPy = req.url.endsWith('.py');
    const fname = req.url === '/push_health.py' ? 'push_health.py' : (isPy ? 'proactive_pull.py' : 'proactive_pull.sh');
    const fpath = isEnv ? null : path.join(__dirname, 'proactive', 'termux', fname);
    if (isEnv) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end("# 把 xxx 换成 App 里输入的那个服务端 token，然后：chmod 600 ~/proactive.env\nAPP_TOKEN=xxx\n");
    }
    try {
      const stat = fs.statSync(fpath);
      res.writeHead(200, { 'Content-Type': isPy ? 'text/x-python; charset=utf-8' : 'text/x-shellscript; charset=utf-8', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(fpath).pipe(res);
    } catch (e) { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // --- DNS-over-HTTPS proxy ---
  if (req.method === 'GET' && req.url.startsWith('/dns-query')) {
    const dohReq = http.get(`http://127.0.0.1:5353${req.url}`, (dohRes) => {
      res.writeHead(dohRes.statusCode, { 'Content-Type': 'application/dns-json', 'Access-Control-Allow-Origin': '*' });
      dohRes.pipe(res);
    });
    dohReq.on('error', () => { res.writeHead(502); res.end('DNS proxy error'); });
    dohReq.setTimeout(5000, () => { dohReq.destroy(); res.writeHead(504); res.end('DNS timeout'); });
    return;
  }

  // --- API proxy ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- Auth (X-Auth-Token / ?token=) ---
  // 白名单：静态首页（已上面返回）/ OPTIONS（已返回）/ /api/health-realtime（用 HEALTH_UPLOAD_TOKEN Bearer）
  if (!APP_TOKEN) {
    console.error('[auth] APP_TOKEN not set — refusing all /api/* requests');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server misconfigured: APP_TOKEN missing' }));
    return;
  }
  const isHealthPush = req.method === 'POST' && req.url === '/api/health-realtime';
  if (!isHealthPush) {
    let qToken = '';
    try { qToken = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch {}
    const token = req.headers['x-auth-token'] || qToken;
    if (token !== APP_TOKEN) {
      // 401 打点：不记明文，只记长度 + sha256 前 12 位，方便和客户端指纹比对
      try {
        const raw = token || '';
        const sha12 = raw ? crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12) : '-';
        const ip = (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '-').toString().split(',')[0].trim();
        console.warn(`[auth] 401 ip=${ip} ua=${(req.headers['user-agent'] || '-').toString().slice(0, 40)} url=${(req.url || '').slice(0, 60)} tokenLen=${raw.length} tokenSha12=${sha12}`);
      } catch {}
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  // --- 媒体上传（音频 / 视频 / PDF → Gemini Files API）---
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/api/media/upload') {
    const q = new URL(req.url, 'http://x').searchParams;
    const mimeType = String(q.get('mimeType') || req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const displayName = (q.get('name') || 'upload').slice(0, 120);
    const apiKey = String(req.headers['x-gemini-key'] || q.get('key') || '').trim() || loadCachedApiKey() || process.env.GEMINI_API_KEY || '';
    const size = Number(req.headers['content-length'] || 0);
    if (!MEDIA_ALLOWED_MIME.test(mimeType)) {
      return reply(res, 400, { error: `不支持的媒体类型: ${mimeType || '(空)'}` });
    }
    if (!size) return reply(res, 411, { error: '缺少 Content-Length' });
    if (size > MEDIA_MAX_BYTES) {
      return reply(res, 413, { error: `文件过大（${(size / 1048576).toFixed(1)}MB），上限 ${MEDIA_MAX_BYTES / 1048576}MB` });
    }
    if (!apiKey) return reply(res, 400, { error: '缺少 Gemini API key（X-Gemini-Key）' });

    (async () => {
      const t0 = Date.now();
      try {
        const uploadUrl = await startGeminiUpload(apiKey, mimeType, size, displayName);
        const up = await streamToGemini(uploadUrl, mimeType, size, req);
        if (up.status !== 200) throw new Error(`Files API upload 失败 ${up.status}: ${String(up.body).slice(0, 300)}`);
        let file = null;
        try { file = JSON.parse(up.body)?.file || null; } catch {}
        if (!file || !file.name) throw new Error('Files API 未返回 file.name');
        if (file.state !== 'ACTIVE') {
          const polled = await pollGeminiFile(apiKey, file.name);
          if (polled) file = { ...file, ...polled };
        }
        console.log(`[media] 上传完成 ${mimeType} ${(size / 1048576).toFixed(2)}MB → ${file.uri} (${file.state}, ${Date.now() - t0}ms)`);
        reply(res, 200, {
          ok: true,
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType || mimeType,
          size,
          state: file.state || 'ACTIVE',
          expiresAt: file.expirationTime || null,
          ms: Date.now() - t0,
        });
      } catch (e) {
        console.error('[media] 上传失败:', e.message);
        reply(res, 502, { error: '媒体上传失败: ' + e.message });
      }
    })();
    return;
  }

  // --- Conversations ---
  if (req.url.startsWith('/api/conversations')) {
    return handleConversations(req, res);
  }

  // --- 主动消息（proactive）：snapshot/decide/generate/deliver/pending/consume + 屏幕活动上报 ---
  // 注意：MacroDroid 走 query 参数，req.url 会带 ?pkg=...，不能用全等比较
  const urlPath0 = (req.url || '').split('?')[0];
  if (req.url.startsWith('/api/proactive/') || urlPath0 === '/api/activity' || urlPath0 === '/api/phone-status'
      || urlPath0 === '/api/presence' || urlPath0 === '/api/tool-calls') {
    return handleProactiveRoutes(req, res);
  }

  // --- 记账（Audit）：transactions / summary / context-export ---
  // 必须在外层放行，否则 handler 写了也是死代码（见 CLAUDE.md 路由坑）
  if ((req.url || '').split('?')[0].startsWith('/api/audit/')) {
    return handleAuditRoutes(req, res);
  }

  // --- 用量审计：/api/usage/summary?days=7 ---
  if ((req.url || '').split('?')[0].startsWith('/api/usage/')) {
    return handleUsageRoutes(req, res);
  }

  // --- 监控台：最近一次请求的输入构成 ---
  if ((req.url || '').split('?')[0].startsWith('/api/monitor/')) {
    return handleMonitorRoutes(req, res);
  }

  // --- Health DB upload ---
  if (req.method === 'POST' && req.url === '/api/upload-health-db') {
    const chunks = [];
    let size = 0;
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_SIZE) chunks.push(chunk);
    });
    req.on('end', async () => {
      if (size > MAX_SIZE) return reply(res, 413, { error: 'File too large (max 50MB)' });
      if (size === 0) return reply(res, 400, { error: 'Empty body' });
      try {
        if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
        fs.writeFileSync(HEALTH_DB_PATH, Buffer.concat(chunks));
        console.log(`[health] DB uploaded: ${size} bytes`);
        const data = await parseHealthDB();
        reply(res, 200, { ok: true, size, health: data });
      } catch (e) {
        reply(res, 500, { error: 'Upload failed: ' + e.message });
      }
    });
    return;
  }

  // --- 失效附件清单（前端启动时拉一次，把历史里的死 URI 就地替换掉，避免每轮都弹「附件已过期」）---
  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/media/dead') {
    return reply(res, 200, { ok: true, count: DEAD_MEDIA_URIS.size, uris: [...DEAD_MEDIA_URIS] });
  }

  // --- 天气（D.O. 卡片 / 调试用）---
  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/weather') {
    const fresh = weatherFresh();
    return reply(res, 200, {
      ok: true,
      fresh,
      updated_at: weatherState.at ? new Date(weatherState.at).toISOString() : null,
      age_minutes: weatherState.at ? Math.round((Date.now() - weatherState.at) / 60000) : null,
      error: weatherState.err || null,
      cities: weatherState.cities,
      line: formatWeatherLine(),
      block: formatWeatherBlock(),
    });
  }
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/api/weather/refresh') {
    refreshWeather().finally(() => reply(res, 200, { ok: true, updated_at: weatherState.at, error: weatherState.err || null, cities: weatherState.cities.length }));
    return;
  }

  // --- Health data query ---
  if (req.method === 'GET' && req.url === '/api/health') {
    const rt = getLatestRealtime();
    const daily = getMergedDaily();
    // 即使过期，也给前端一份"最后一条"信息用于诊断断联
    const now = Date.now();
    let lastPush = null;
    for (const e of realtimeCache) {
      const ts = e._received_ts || e._ts;
      if (!ts || ts > now + 60_000) continue;
      if (!lastPush || ts > lastPush.ts) lastPush = { ts, time: new Date(ts).toISOString() };
    }
    // sleep 已按「醒来日期」聚合（一天多段合并），前端/模型都按天用
    const sleepDays = groupSleepByDay().slice(-14);
    reply(res, 200, { ok: true, realtime: rt, daily, cache_count: realtimeCache.length, last_push: lastPush, screen_time: screenTimeCache, weight: weightCache.slice(-30), sleep: sleepDays, sleep_stats: sleepStats(sleepDays), phone: phoneStatusSummary(), presence: presenceSummary(), activity: activitySummary() });
    return;
  }

  // --- Health history for charts ---
  if (req.method === 'GET' && req.url.startsWith('/api/health-history')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const range = urlObj.searchParams.get('range') || 'month';
    const offset = Math.max(0, parseInt(urlObj.searchParams.get('offset') || '0'));
    const todayStr = localDateStr();

    function readDayEntries(dateStr) {
      if (dateStr === todayStr) {
        const start = new Date(`${dateStr}T00:00:00+08:00`).getTime();
        return realtimeCache.filter(e => e._ts >= start);
      }
      const file = path.join(HEALTH_DIR, `realtime-${dateStr}.jsonl`);
      if (!fs.existsSync(file)) return [];
      try {
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    }

    function aggEntries(entries) {
      const hrV = entries.map(e => e.heart_rate).filter(v => v && v > 0);
      const stV = entries.map(e => e.stress).filter(v => v != null && v >= 0);
      const spV = entries.map(e => e.spo2).filter(v => v && v > 0);
      const stpV = entries.map(e => e.steps).filter(v => v != null);
      const r = {};
      if (hrV.length) r.hr = { avg: Math.round(hrV.reduce((a, b) => a + b, 0) / hrV.length), max: Math.max(...hrV), min: Math.min(...hrV) };
      if (stV.length) r.stress = { avg: Math.round(stV.reduce((a, b) => a + b, 0) / stV.length), max: Math.max(...stV), min: Math.min(...stV) };
      if (spV.length) r.spo2 = { avg: Math.round(spV.reduce((a, b) => a + b, 0) / spV.length * 10) / 10, max: Math.max(...spV), min: Math.min(...spV) };
      if (stpV.length) r.steps = Math.max(...stpV);
      return r;
    }

    if (range === 'day') {
      const targetStr = localDateStr(new Date(Date.now() - offset * 86400000));
      const dayStart = new Date(`${targetStr}T00:00:00+08:00`).getTime();
      const dayEntries = readDayEntries(targetStr);
      const hours = [];
      for (let h = 0; h < 24; h++) {
        const hStart = dayStart + h * 3600000;
        const hEnd = hStart + 3600000;
        const hEntries = dayEntries.filter(e => e._ts >= hStart && e._ts < hEnd);
        if (hEntries.length === 0) { hours.push({ hour: h }); continue; }
        const item = { hour: h, ...aggEntries(hEntries) };
        hours.push(item);
      }
      reply(res, 200, { ok: true, range: 'day', date: targetStr, hours });
      return;
    }

    const periodDays = range === 'week' ? 7 : 30;
    const startDaysAgo = (offset + 1) * periodDays - 1;
    const endDaysAgo = offset * periodDays;
    const result = [];
    for (let i = startDaysAgo; i >= endDaysAgo; i--) {
      const dateStr = localDateStr(new Date(Date.now() - i * 86400000));
      if (dateStr !== todayStr && _healthDayCache[dateStr]) {
        result.push(_healthDayCache[dateStr]);
        continue;
      }
      const entries = readDayEntries(dateStr);
      if (entries.length === 0) continue;
      const item = { date: dateStr, count: entries.length, ...aggEntries(entries) };
      if (dateStr !== todayStr) _healthDayCache[dateStr] = item;
      result.push(item);
    }

    // 睡眠：按醒来日期聚合，一天多段合并（和 formatSleepBlock / D.O. 用同一套）
    const sleepByDate = {};
    for (const d of groupSleepByDay()) {
      sleepByDate[d.date] = { totalMinutes: d.totalMinutes, count: d.count, bed: d.bed, wake: d.wake, segments: d.segments };
    }
    // 体重：按日期取当天最后一条
    const weightByDate = {};
    for (const w of weightCache) {
      const wDate = localDateStr(new Date(w.ts));
      weightByDate[wDate] = { weight: w.weight, bmi: w.bmi, body_fat: w.body_fat };
    }

    const startDate = localDateStr(new Date(Date.now() - startDaysAgo * 86400000));
    const endDate = localDateStr(new Date(Date.now() - endDaysAgo * 86400000));
    reply(res, 200, { ok: true, range, startDate, endDate, days: result, sleep: sleepByDate, weight: weightByDate });
    return;
  }

  // --- Health realtime cache reset (drop bad entries) ---
  if (req.method === 'POST' && req.url === '/api/health-realtime/reset') {
    if (HEALTH_TOKEN) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${HEALTH_TOKEN}`) return reply(res, 401, { error: 'Unauthorized' });
    }
    const before = realtimeCache.length;
    const sleepBefore = latestSleepSegments.length;
    realtimeCache = [];
    latestSleepSegments = [];
    latestSleepSegmentsTs = 0;
    // 备份并清空当天 jsonl + sleep_segments.json
    try {
      const today = localDateStr();
      const file = path.join(HEALTH_DIR, `realtime-${today}.jsonl`);
      if (fs.existsSync(file)) fs.renameSync(file, file + '.bak.' + Date.now());
      if (fs.existsSync(SLEEP_SEGMENTS_PATH)) fs.renameSync(SLEEP_SEGMENTS_PATH, SLEEP_SEGMENTS_PATH + '.bak.' + Date.now());
    } catch {}
    reply(res, 200, { ok: true, dropped: before, sleep_dropped: sleepBefore });
    return;
  }

  // --- Health realtime push ---
  if (req.method === 'POST' && req.url === '/api/health-realtime') {
    // Bearer token 鉴权
    if (HEALTH_TOKEN) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${HEALTH_TOKEN}`) {
        return reply(res, 401, { error: 'Unauthorized' });
      }
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        appendRealtime(data);
        reply(res, 200, { ok: true, cached: realtimeCache.length });
      } catch {
        reply(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // --- 屏幕使用时间 ---
  if (req.method === 'POST' && req.url === '/api/screen-time') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const data = Array.isArray(parsed.data) ? parsed.data : [];
        appendScreenTime(data, parsed.timestamp);
        reply(res, 200, { ok: true, count: data.length });
      } catch {
        reply(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // --- 手动睡眠记录 ---
  if (req.method === 'POST' && req.url === '/api/sleep') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const bed = Number(parsed.bed);
        const wake = Number(parsed.wake);
        if (!bed || !wake || wake <= bed) {
          return reply(res, 400, { error: 'invalid bed/wake timestamps' });
        }
        const entry = appendSleep(bed, wake);
        if (!entry) return reply(res, 400, { error: 'bed/wake 不在允许范围（只保留最近 90 天，且醒来时间不能在未来）' });
        console.log(`[sleep] recorded ${entry.minutes} min (${new Date(bed).toISOString()} → ${new Date(wake).toISOString()})`);
        reply(res, 200, { ok: true, entry, count: sleepCache.length });
      } catch {
        reply(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // 删除手动睡眠记录：body { items: [{bed, wake}, ...] }
  if (req.method === 'POST' && req.url === '/api/sleep/delete') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
      const items = Array.isArray(parsed.items) ? parsed.items : (parsed.bed ? [parsed] : []);
      if (items.length === 0) return reply(res, 400, { error: 'items required' });
      const removed = deleteSleepEntries(items);
      if (removed.length === 0) return reply(res, 404, { error: '没有找到匹配的睡眠记录' });
      console.log(`[sleep] 删除 ${removed.length} 条：${removed.map(e => new Date(e.bed).toISOString()).join(', ')}`);
      reply(res, 200, { ok: true, removed, count: sleepCache.length });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sleep') {
    reply(res, 200, { ok: true, recent: sleepCache.slice(-30), count: sleepCache.length });
    return;
  }

  // --- 体重（蓝牙智能秤） ---
  if (req.method === 'POST' && req.url === '/api/weight') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const weight = Number(parsed.weight);
        if (!weight || weight < 10 || weight > 300) {
          return reply(res, 400, { error: 'invalid weight' });
        }
        const ts = typeof parsed.ts === 'number' ? parsed.ts
          : typeof parsed.timestamp === 'number' ? parsed.timestamp : undefined;
        const impedance = Number(parsed.impedance) || 0;
        const entry = appendWeight(weight, ts, impedance);
        console.log(`[weight] recorded ${weight} kg${impedance ? `, impedance=${impedance}, fat=${entry.body_fat}%` : ''}`);
        reply(res, 200, { ok: true, entry, count: weightCache.length });
      } catch {
        reply(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // --- 体重查询（最近记录 + 趋势） ---
  if (req.method === 'GET' && req.url === '/api/weight') {
    const latest = weightCache.length > 0 ? weightCache[weightCache.length - 1] : null;
    let trend = null;
    if (latest) {
      trend = {};
      if (weightCache.length >= 2) {
        trend.vs_prev = Math.round((latest.weight - weightCache[weightCache.length - 2].weight) * 10) / 10;
      }
      const weekAgo = [...weightCache].reverse().find(e => e.ts <= latest.ts - 7 * 86400000);
      if (weekAgo) trend.vs_week = Math.round((latest.weight - weekAgo.weight) * 10) / 10;
      const monthAgo = [...weightCache].reverse().find(e => e.ts <= latest.ts - 30 * 86400000);
      if (monthAgo) trend.vs_month = Math.round((latest.weight - monthAgo.weight) * 10) / 10;
    }
    reply(res, 200, { ok: true, latest, trend, recent: weightCache.slice(-30), count: weightCache.length });
    return;
  }

  // --- 翻译 (DeepSeek) ---
  if (req.method === 'POST' && req.url === '/api/translate') {
    return handleTranslate(req, res);
  }

  // --- Memory Vault CRUD proxy ---
  if (req.method === 'POST' && req.url.startsWith('/api/memory/')) {
    const action = req.url.replace('/api/memory/', '');
    if (!['query', 'list', 'add', 'update', 'delete', 'meta', 'query_memos', 'expire_memos'].includes(action)) {
      return reply(res, 404, { error: 'Unknown memory action' });
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const postData = body || '{}';
      const r = http.request(`http://127.0.0.1:8100/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 10000,
      }, (ragRes) => {
        let data = '';
        ragRes.on('data', c => { data += c; });
        ragRes.on('end', () => {
          res.writeHead(ragRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      r.on('error', (err) => reply(res, 502, { error: 'RAG server error: ' + err.message }));
      r.on('timeout', () => { r.destroy(); reply(res, 504, { error: 'RAG server timeout' }); });
      r.write(postData);
      r.end();
    });
    return;
  }

  // ===== 流式 SSE 端点 =====
  if (req.method === 'POST' && req.url === '/api/chat/stream') {
    // 请求体上限：音视频请走 /api/media/upload（请求体里只放 file_data 引用）
    const MAX_CHAT_BODY = 48 * 1024 * 1024;
    let body = '';
    let bodyTooBig = false;
    req.on('data', chunk => {
      if (bodyTooBig) return;
      body += chunk;
      if (body.length > MAX_CHAT_BODY) {
        bodyTooBig = true;
        body = '';
        console.warn(`[chat/stream] 请求体超过 ${MAX_CHAT_BODY / 1048576}MB，拒绝`);
        reply(res, 413, { error: `请求体过大（上限 ${MAX_CHAT_BODY / 1048576}MB）：音频/视频请走 /api/media/upload，请求里只放 file_data 引用` });
      }
    });
    req.on('end', async () => {
      if (bodyTooBig) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return reply(res, 400, { error: 'Invalid JSON' });
      }

      const { apiKey, model, contents, generationConfig, systemInstruction, tools, ragMemory, convId } = parsed;
      // 顺手缓存前端的 Gemini key：主动消息要「用上次对话那个模型」，服务端得留一份
      if (apiKey) cacheApiKey(apiKey);
      if (!model || !contents) {
        return reply(res, 400, { error: 'Missing model or contents' });
      }
      if (!isDeepSeekModel(model) && !apiKey) {
        return reply(res, 400, { error: 'Missing apiKey for Gemini model' });
      }
      if (!Array.isArray(contents) || contents.length === 0) {
        return reply(res, 400, { error: 'contents must be a non-empty array' });
      }

      // RAG: extract last user message and query memories + memos (before stream starts)
      let memoryBlock = '';
      let ragResults = [];
      if (ragMemory) {
        const lastUserMsg = [...contents].reverse().find(c => c.role === 'user');
        const uText = lastUserMsg?.parts?.map(p => p.text).filter(Boolean).join(' ') || '';
        const [memos, memories] = await Promise.all([
          queryMemos(),
          uText ? queryRAG(uText) : Promise.resolve([]),
        ]);
        ragResults = memories;
        memoryBlock = formatMemoryBlock(memos, memories);
      }

      // 记录用户消息
      const lastUser = [...contents].reverse().find(c => c.role === 'user');
      const userText = lastUser?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
      if (userText) logChat('user', userText);

      // 先把 systemInstruction 终稿和 tools 算出来，压缩判定才能把固定开销算进去
      // 顺序：稳定的指令在前（用户 system instruction + 工具指引），每轮都变的数据块在后
      // → 稳住 prompt 前缀，Gemini 隐式缓存才可能命中（以前健康/记忆块在最前，每轮都变，永远命中不了）
      const existingSysText = systemInstruction?.parts?.[0]?.text || '';
      const saveMemoryEnabled = !!ragMemory;
      const saveGuidance = saveMemoryEnabled ? SAVE_MEMORY_PROMPT : '';
      const weatherBlock = formatWeatherBlock();
      const healthBlock = formatHealthBlock();
      const screenBlock = formatScreenTimeBlock();
      const lockAppGuidance = LOCK_APP_PROMPT;
      const isDS = isDeepSeekModel(model);
      const webSearchEnabled = !!parsed.webSearch && !isImageModelName(model);
      // Gemini 3+/4：用平台内建 Google Search grounding（原生搜索）
      // Gemini 2.5 及以下：内建工具不能和 functionDeclarations 混用 → 走 web_search 函数工具
      // DeepSeek：一律走 web_search 函数工具（DeepSeek Search API）
      const geminiNativeSearch = webSearchEnabled && !isDS && /gemini-[3-9]/.test(model);
      const webSearchGuidance = webSearchEnabled
        ? (geminiNativeSearch ? GEMINI_SEARCH_PROMPT : WEB_SEARCH_PROMPT)
        : '';
      const contextLine = typeof parsed.contextLine === 'string' ? parsed.contextLine : '';
      const toolHistoryBlock = saveMemoryEnabled ? (formatDirectiveBlock() + formatToolCallBlock()) : '';
      const auditBlock = formatAuditBlock();
      const finalSysText = existingSysText + saveGuidance + lockAppGuidance + webSearchGuidance + weatherBlock + healthBlock + screenBlock + auditBlock + memoryBlock + toolHistoryBlock + contextLine;

      const dsTools = [];
      if (saveMemoryEnabled) dsTools.push(DEEPSEEK_SAVE_MEMORY_TOOL);
      if (webSearchEnabled) dsTools.push(DEEPSEEK_WEB_SEARCH_TOOL);
      if (realtimeCache.length > 0) dsTools.push(DEEPSEEK_HEALTH_TREND_TOOL);
      dsTools.push(DEEPSEEK_LOCK_APP_TOOL);
      dsTools.push(DEEPSEEK_AUTOCLI_TOOL);
      if (saveMemoryEnabled) dsTools.push(DEEPSEEK_SCHEDULE_NUDGE_TOOL);

      const mergedTools = [];
      if (Array.isArray(tools)) mergedTools.push(...tools);
      if (webSearchEnabled && !isDS && !geminiNativeSearch) mergedTools.push(WEB_SEARCH_TOOL);
      if (saveMemoryEnabled) mergedTools.push(SAVE_MEMORY_TOOL);
      if (realtimeCache.length > 0) mergedTools.push(GET_HEALTH_TREND_TOOL);
      mergedTools.push(LOCK_APP_TOOL);
      mergedTools.push(AUTOCLI_TOOL);
      if (saveMemoryEnabled) mergedTools.push(SCHEDULE_NUDGE_TOOL);

      const fixedTokens = estimateTextTokens(finalSysText) + estimateToolsTokens(isDS ? dsTools : mergedTools);

      // 滑动上下文窗口：截断旧对话 + DeepSeek 摘要
      let { contents: trimmedContents, compressed: compressionInfo, state: contextState } = await applyContextWindow(contents, convId, {
        fixedTokens,
        historyOffset: parsed.historyOffset,
      });

      // ===== DeepSeek 分支 =====
      if (isDS) {
        const dsMessages = geminiToOpenAIMessages(trimmedContents, finalSysText || undefined);
        const thinkingEnabled = generationConfig?.thinkingConfig?.thinkingLevel
          && generationConfig.thinkingConfig.thinkingLevel !== 'NONE';

        // SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        const sseSend = (obj) => {
          try { if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch (e) { console.error('[sse-ds] write failed:', e.message); }
        };

        // 前端通知：上下文状态（每轮都发，前端据此裁掉已被摘要覆盖的历史）
        sseSend({ type: 'context_state', ...contextState });
        // 前端通知：RAG 结果 + 上下文压缩
        if (ragResults.length > 0) {
          sseSend({ type: 'rag_results', memories: ragResults.map(m => ({ content: m.content, type: m.type, date: m.date, score: m._score })) });
        }
        if (compressionInfo) {
          sseSend({ type: 'context_compressed', ...compressionInfo });
        }

        let chunkTimer = setTimeout(() => {
          sseSend({ type: 'error', message: '流式超时：60秒无响应' });
          res.end();
        }, 60000);
        const resetTimer = () => {
          clearTimeout(chunkTimer);
          chunkTimer = setTimeout(() => {
            sseSend({ type: 'error', message: '流式超时：60秒无新数据' });
            res.end();
          }, 60000);
        };

        try {
          const dsRes = await callDeepSeekStream(dsMessages, model, generationConfig || {}, thinkingEnabled, dsTools);

          if (dsRes.statusCode !== 200) {
            const chunks = [];
            dsRes.on('data', c => chunks.push(c));
            dsRes.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let msg = `DeepSeek API Error ${dsRes.statusCode}`;
              try { msg = JSON.parse(raw).error?.message || msg; } catch {}
              sseSend({ type: 'error', message: msg });
              clearTimeout(chunkTimer);
              res.end();
            });
            return;
          }

          let buffer = '';
          let fullThought = '';
          let fullText = '';
          const saveCalls = [];
          const searchSources = [];   // 本轮搜到的引用（title/url/snippet），done 时回传前端渲染
          let usageMetadata = null;

          dsRes.on('data', (chunk) => {
            resetTimer();
            buffer += chunk.toString('utf8');
            let lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const jsonStr = line.slice(6).trim();
              if (jsonStr === '[DONE]') continue;
              if (!jsonStr) continue;

              let parsed;
              try { parsed = JSON.parse(jsonStr); } catch { continue; }

              // Usage
              if (parsed.usage) {
                usageMetadata = {
                  promptTokenCount: parsed.usage.prompt_tokens || 0,
                  candidatesTokenCount: parsed.usage.completion_tokens || 0,
                  thoughtsTokenCount: parsed.usage.completion_tokens_details?.reasoning_tokens || 0,
                  totalTokenCount: parsed.usage.total_tokens || 0,
                };
              }

              const choice = parsed.choices?.[0];
              const delta = choice?.delta;
              if (!delta) continue;

              // Debug: log first few deltas to see field names
              if (!fullThought && !fullText) {
                console.log('[ds-delta]', JSON.stringify(delta).substring(0, 200));
              }

              // Tool calls
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!saveCalls[tc.index]) {
                    saveCalls[tc.index] = { id: tc.id || '', name: '', args: '' };
                  }
                  if (tc.function?.name) saveCalls[tc.index].name = tc.function.name;
                  if (tc.function?.arguments) saveCalls[tc.index].args += tc.function.arguments;
                }
                continue;
              }

              // Reasoning / thinking (check both field names)
              const reasonText = delta.reasoning_content || delta.reasoning;
              if (reasonText) {
                fullThought += reasonText;
                sseSend({ type: 'thinking', text: reasonText });
              }
              // Answer text
              if (delta.content) {
                fullText += delta.content;
                sseSend({ type: 'answer', text: delta.content });
              }
            }
          });

          dsRes.on('end', async () => {
            clearTimeout(chunkTimer);

            // Process remaining buffer
            if (buffer.trim()) {
              const line = buffer.trim();
              if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                try {
                  const parsed = JSON.parse(line.slice(6));
                  if (parsed.usage) {
                    usageMetadata = {
                      promptTokenCount: parsed.usage.prompt_tokens || 0,
                      candidatesTokenCount: parsed.usage.completion_tokens || 0,
                      thoughtsTokenCount: parsed.usage.completion_tokens_details?.reasoning_tokens || 0,
                      totalTokenCount: parsed.usage.total_tokens || 0,
                    };
                  }
                  const delta = parsed.choices?.[0]?.delta;
                  if (delta?.reasoning_content) {
                    fullThought += delta.reasoning_content;
                    sseSend({ type: 'thinking', text: delta.reasoning_content });
                  }
                  if (delta?.content) {
                    fullText += delta.content;
                    sseSend({ type: 'answer', text: delta.content });
                  }
                } catch {}
              }
            }

            // Handle tool calls
            const allToolCalls = saveCalls.filter(sc => sc && sc.name);
            let savedMemories = [];

            if (allToolCalls.length > 0) {
              // Execute tool calls
              const toolResults = [];
              for (const sc of allToolCalls) {
                let args;
                try { args = JSON.parse(sc.args); } catch { args = {}; }

                if (sc.name === 'save_memory') {
                  const result = await saveMemoryAuto(args).catch(err => {
                    console.error('[save_memory-ds] failed:', err.message);
                    return { status: 'error', content: args?.content || '' };
                  });
                  savedMemories.push(result);
                  toolResults.push({ id: sc.id, content: JSON.stringify({ ok: true }) });
                } else if (sc.name === 'web_search') {
                  const q = String(args.query || '').slice(0, 128).trim();
                  console.log(`[web_search] query: ${q}`);
                  sseSend({ type: 'tool_call', tool: 'web_search', detail: q ? `「${q.slice(0, 60)}」` : '' });
                  const sr = await deepseekSearch(q, {
                    count: args.count,
                    needContent: true,
                    oriQuestion: userText,
                  });
                  if (sr.sources && sr.sources.length > 0) {
                    searchSources.push(...sr.sources);
                    sseSend({ type: 'search_sources', sources: sr.sources });
                  }
                  toolResults.push({ id: sc.id, content: formatSearchResults(q, sr.results, sr.error) });
                } else if (sc.name === 'get_health_trend') {
                  const trend = getRealtimeTrend(args.hours || 3);
                  console.log(`[health_trend] ${args.hours || 3}h, ${trend.count} entries`);
                  sseSend({ type: 'tool_call', tool: 'get_health_trend', detail: `近 ${args.hours || 3} 小时` });
                  toolResults.push({ id: sc.id, content: JSON.stringify(trend, null, 2) });
                } else if (sc.name === 'lock_app') {
                  console.log(`[lock_app] action=${args.action} apps=${JSON.stringify(args.apps)}`);
                  sseSend({ type: 'tool_call', tool: 'lock_app', detail: `${args.action === 'lock' ? '锁定' : '解锁'} ${(args.apps || []).length} 个应用` });
                  recordToolCall({ tool: 'lock_app', summary: `${args.action === 'lock' ? '锁定' : '解锁'} ${(args.apps || []).length} 个应用` });
                  sseSend({ type: 'lock_app', action: args.action, apps: args.apps || [] });
                  toolResults.push({ id: sc.id, content: JSON.stringify({ ok: true, action: args.action, apps: args.apps }) });
                } else if (sc.name === 'schedule_nudge') {
                  const dir = addProactiveDirective({ ...args, source: 'model-ds' });
                  sseSend({ type: 'tool_call', tool: 'schedule_nudge', detail: `${Math.round((dir.at - Date.now()) / 60000)} 分钟后：${dir.condition}` });
                  toolResults.push({ id: sc.id, content: JSON.stringify({ ok: true, scheduled_at: new Date(dir.at).toISOString(), delay_minutes: Math.round((dir.at - Date.now()) / 60000) }) });
                } else if (sc.name === 'fetch_site') {
                  console.log(`[autocli-ds] site=${args.site} command=${args.command} query=${args.query || ''}`);
                  sseSend({ type: 'tool_call', tool: 'fetch_site', detail: `${args.site} ${args.command}${args.query ? ' 「' + String(args.query).slice(0, 40) + '」' : ''}` });
                  const r = await runAutocli(args);
                  toolResults.push({ id: sc.id, content: JSON.stringify(r, null, 2) });
                } else {
                  toolResults.push({ id: sc.id, content: JSON.stringify({ error: 'unknown tool' }) });
                }
              }

              // Followup: send tool results back to model
              const needsFollowup = sc => sc.name === 'web_search' || sc.name === 'get_health_trend' || sc.name === 'lock_app' || sc.name === 'fetch_site' || sc.name === 'schedule_nudge';
              if (!fullText.trim() || allToolCalls.some(needsFollowup)) {
                const reason = allToolCalls.find(needsFollowup)?.name || 'save_memory';
                console.log(`[ds-stream] triggering followup after ${reason}...`);
                try {
                  const assistantMsg = {
                    role: 'assistant',
                    content: fullText || null,
                    // DeepSeek thinking 模式要求 followup 传回 reasoning_content
                    ...(fullThought ? { reasoning_content: fullThought } : {}),
                    tool_calls: allToolCalls.map((sc, i) => ({
                      id: sc.id || `call_${i}`,
                      type: 'function',
                      function: { name: sc.name, arguments: sc.args },
                    })),
                  };
                  const toolMsgs = toolResults.map((tr, i) => ({
                    role: 'tool',
                    tool_call_id: tr.id || allToolCalls[i]?.id || `call_${i}`,
                    content: tr.content,
                  }));

                  // Followup 不传 tools，强制模型基于已有结果直接生成回答
                  const followupTools = [];
                  const followupMessages = [...dsMessages, assistantMsg, ...toolMsgs];
                  const fRes = await callDeepSeekStream(followupMessages, model, generationConfig || {}, thinkingEnabled, followupTools);

                  if (fRes.statusCode === 200) {
                    await new Promise((resolveFollowup) => {
                      let fBuf = '';
                      fRes.on('data', (fChunk) => {
                        fBuf += fChunk.toString('utf8');
                        let fLines = fBuf.split('\n');
                        fBuf = fLines.pop();
                        for (const fLine of fLines) {
                          if (!fLine.startsWith('data: ')) continue;
                          const js = fLine.slice(6).trim();
                          if (js === '[DONE]' || !js) continue;
                          let fp;
                          try { fp = JSON.parse(js); } catch { continue; }
                          if (fp.usage) {
                            usageMetadata = {
                              promptTokenCount: fp.usage.prompt_tokens || 0,
                              candidatesTokenCount: (usageMetadata?.candidatesTokenCount || 0) + (fp.usage.completion_tokens || 0),
                              thoughtsTokenCount: (usageMetadata?.thoughtsTokenCount || 0) + (fp.usage.completion_tokens_details?.reasoning_tokens || 0),
                              totalTokenCount: fp.usage.total_tokens || 0,
                            };
                          }
                          const d = fp.choices?.[0]?.delta;
                          if (d?.content) {
                            fullText += d.content;
                            sseSend({ type: 'answer', text: d.content });
                          }
                        }
                      });
                      fRes.on('end', resolveFollowup);
                      fRes.on('error', (e) => {
                        console.error('[ds-stream] followup error:', e.message);
                        resolveFollowup();
                      });
                    });
                  } else {
                    // 非 200，读错误信息
                    const errChunks = [];
                    fRes.on('data', c => errChunks.push(c));
                    await new Promise(r => fRes.on('end', r));
                    const errBody = Buffer.concat(errChunks).toString('utf8');
                    console.error('[ds-stream] followup non-200:', fRes.statusCode, errBody.substring(0, 500));
                  }

                  if (!fullText.trim()) {
                    sseSend({ type: 'answer', text: '\n\n（系统：正文生成失败，请重试）' });
                  }
                } catch (err) {
                  console.error('[ds-stream] followup failed:', err.message);
                  sseSend({ type: 'answer', text: '\n\n（系统：正文生成失败，请重试）' });
                }
              }
            }

            // Send done
            const doneData = { type: 'done' };
            if (usageMetadata) doneData.usageMetadata = usageMetadata;
            if (savedMemories.length > 0) doneData.savedMemories = savedMemories;
            if (searchSources.length > 0) doneData.searchSources = searchSources;
            logUsage({
              provider: 'deepseek', model, kind: 'chat', convId: convId || '', ok: true,
              in: usageMetadata?.promptTokenCount || 0,
              out: usageMetadata?.candidatesTokenCount || 0,
              think: usageMetadata?.thoughtsTokenCount || 0,
              cached: usageMetadata?.cachedContentTokenCount || 0,
              search: searchSources.length,
            });
            sseSend(doneData);
            res.end();

            // 记录模型回复（thought 和 text 分字段存）
            if (fullText || fullThought) logChat('model', fullText || '', fullThought || undefined);
          });

          dsRes.on('error', (err) => {
            clearTimeout(chunkTimer);
            sseSend({ type: 'error', message: 'DeepSeek stream error: ' + err.message });
            res.end();
          });

          res.on('close', () => {
            clearTimeout(chunkTimer);
            dsRes.destroy();
          });

        } catch (err) {
          clearTimeout(chunkTimer);
          sseSend({ type: 'error', message: 'DeepSeek proxy error: ' + err.message });
          res.end();
        }
        return;
      }

      // ===== Gemini 分支 =====
      const streamPath = `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

      // ---- 缓存策略：system prompt 拆「稳定（进缓存）/ 易变（每轮随请求发）」----
      // 硬约束（2026-11 实测）：带 cachedContent 的请求里**不能再出现** systemInstruction / tools / toolConfig
      //（报错 "CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config"），
      // 它们必须一起塞进缓存。所以：persona + 规则（稳定）+ tools 进缓存，
      // 健康/天气/记忆/工具记录这些「每轮都变」的块挪到请求里的第一条 user 消息。
      // 注意：这里只能用「跟数据无关」的常量。saveGuidance 原本依赖 ragMemory（这轮有没有检索到记忆），
      // 一会有一会没有 → 稳定段变来变去 → 缓存签名每轮都不同 → 建了缓存却永远命中不了。
      const saveGuidanceStable = SAVE_MEMORY_PROMPT;
      const stableSysText = existingSysText + saveGuidanceStable + lockAppGuidance + webSearchGuidance;
      const volatileText = [weatherBlock, healthBlock, screenBlock, auditBlock, memoryBlock, toolHistoryBlock, contextLine]
        .map(x => (x || '').trim()).filter(Boolean).join('\n\n');
      const volatileMsg = volatileText
        ? [{ role: 'user', parts: [{ text: '【本轮环境数据（每轮刷新，仅供参考，不必复述）】\n' + volatileText }] }]
        : [];
      // 缓存里的 tools 必须稳定，否则每轮签名都变 → 每轮重建：不随 ragMemory/健康缓存浮动
      const cacheDecls = [];
      if (webSearchEnabled && !geminiNativeSearch) cacheDecls.push(WEB_SEARCH_TOOL);
      cacheDecls.push(SAVE_MEMORY_TOOL, GET_HEALTH_TREND_TOOL, LOCK_APP_TOOL, AUTOCLI_TOOL, SCHEDULE_NUDGE_TOOL);
      const cacheTools = geminiNativeSearch
        ? [...cacheDecls, { google_search: {} }]
        : cacheDecls;
      const cacheToolConfig = geminiNativeSearch ? { includeServerSideToolInvocations: true } : null;

      const reqBody = { contents: trimmedContents };
      const applyFullBody = () => {
        reqBody.contents = trimmedContents;
        delete reqBody.cachedContent;
        if (finalSysText) reqBody.systemInstruction = { parts: [{ text: finalSysText }] };
        if (mergedTools.length > 0) {
          reqBody.tools = [...mergedTools];
          if (geminiNativeSearch) reqBody.tools.push({ google_search: {} });
          if (geminiNativeSearch) reqBody.toolConfig = { includeServerSideToolInvocations: true };
        } else {
          delete reqBody.tools;
          delete reqBody.toolConfig;
          if (geminiNativeSearch) reqBody.tools = [{ google_search: {} }];
        }
      };

      let geminiCacheUsed = null;
      let cacheMode = false;
      if (geminiCacheSupported(model)) {
        const cKey = convId || '__default__';
        const keyHash = keyHashOf(apiKey);
        const rec = geminiCaches.get(cKey);
        // 签名要覆盖「稳定 system + tools」，任一变化都得重建
        const sigSys = contentsHash({ sys: stableSysText, tools: cacheTools });
        const msgHash = (m) => { try { return sha12(JSON.stringify(m)); } catch { return ''; } };
        // 命中判定用「锚点」：缓存里最后两条消息的指纹。
        // 前端会在拿到 context_state 后裁剪历史（offset 往前跳），此时按数组下标比对必然错位 →
        // 改成在新内容里找这两个锚点，找到就说明「缓存那段在这轮里仍然存在且连续」。
        const findAnchor = (list, aA, aB) => {
          if (!aA || !aB || list.length < 2) return -1;
          for (let i = list.length - 1; i >= 1; i--) {
            if (msgHash(list[i]) === aA && msgHash(list[i - 1]) === aB) return i;
          }
          return -1;
        };

        const recValid = !!(rec && rec.model === model && rec.exp > Date.now() + 60000 && rec.keyHash === keyHash
            && rec.sigSys === sigSys);
        const anchorIdx = recValid ? findAnchor(trimmedContents, rec.anchorA, rec.anchorB) : -1;
        const recHashOk = recValid && anchorIdx >= 0 && anchorIdx + 1 < trimmedContents.length;
        if (rec && !recHashOk && rec.model === model && rec.keyHash === keyHash) {
          const why = rec.exp - Date.now() <= 60000 ? '快过期'
            : !recValid ? '系统段/工具或 key 变了'
            : anchorIdx < 0 ? '锚点已不在本次内容里（历史被裁过）'
            : '锚点就在末尾，没有新内容';
          console.log(`[cache] 不命中（${why}）：缓存 ${rec.nMsgs} 条 / 本次 ${trimmedContents.length} 条`);
        }
        if (recHashOk) {
          reqBody.cachedContent = rec.name;
          reqBody.contents = [...volatileMsg, ...trimmedContents.slice(anchorIdx + 1)];
          delete reqBody.systemInstruction;
          delete reqBody.tools;
          delete reqBody.toolConfig;
          geminiCacheUsed = rec;
          cacheMode = true;
          console.log(`[cache] 命中 conv=${cKey} 缓存 ${rec.nMsgs} 条 / ${rec.tokens} tokens，锚点在第 ${anchorIdx} 条，本次只发 ${trimmedContents.length - anchorIdx - 1} 条 + 环境块`);
        }

        // 没命中（或尾巴太长 / 快过期）→ 后台按当前稳定段重建；本次请求仍走全量，行为不变
        const nMsgs = trimmedContents.length - GEMINI_CACHE_TAIL_MSGS;
        const needRebuild = !geminiCacheUsed && nMsgs >= 2
          && (!rec || !recValid || !recHashOk
              || rec.exp - Date.now() < 600000
              || (recHashOk && trimmedContents.length - anchorIdx - 1 > GEMINI_CACHE_MAX_TAIL)
              || rec.keyHash !== keyHash);
        if (needRebuild) {
          const prefix = trimmedContents.slice(0, nMsgs);
          const est = estimateTokens(prefix) + estimateTextTokens(stableSysText) + estimateToolsTokens(cacheTools);
          if (est >= GEMINI_CACHE_MIN_TOKENS) {
            const h = contentsHash(prefix);
            if (!rec || rec.hash !== h) {
              const capturedKey = keyHash;
              const aA = msgHash(prefix[nMsgs - 1]);
              const aB = msgHash(prefix[nMsgs - 2]);
              createGeminiCache(apiKey, model, prefix, stableSysText, cacheTools, cacheToolConfig).then(({ name, tokens }) => {
                geminiCaches.set(cKey, {
                  name, model, keyHash: capturedKey, nMsgs, tokens, hash: h,
                  anchorA: aA, anchorB: aB, sigSys,
                  exp: Date.now() + GEMINI_CACHE_TTL_S * 1000,
                });
                console.log(`[cache] 已建立 conv=${cKey} 前缀 ${nMsgs} 条 / ≈${est} tokens (调用侧报 ${tokens})，TTL ${GEMINI_CACHE_TTL_S}s`);
              }).catch(e => console.warn('[cache] 建立失败（不影响本次请求）:', e.message));
            }
          }
        }
      }
      if (!cacheMode) applyFullBody();

      recordContextInfo(convId, {
        model,
        msgs: trimmedContents.length,
        est_window_tokens: estimateTokens(trimmedContents),
        est_sys_tokens: estimateTextTokens(finalSysText),
        est_tools_tokens: estimateToolsTokens(mergedTools),
        est_total_tokens: estimateTokens(trimmedContents) + estimateTextTokens(finalSysText) + estimateToolsTokens(mergedTools),
        blocks: {
          '人设/规则': estimateTextTokens(existingSysText),
          '存记忆指引': estimateTextTokens(saveGuidance),
          '应用锁': estimateTextTokens(lockAppGuidance),
          '联网搜索': estimateTextTokens(webSearchGuidance),
          '天气': estimateTextTokens(weatherBlock),
          '健康': estimateTextTokens(healthBlock),
          '屏幕': estimateTextTokens(screenBlock),
          '记账': estimateTextTokens(auditBlock),
          '记忆': estimateTextTokens(memoryBlock),
          '工具记录': estimateTextTokens(toolHistoryBlock),
          '上下文行': estimateTextTokens(contextLine),
        },
        tools: mergedTools.length + (geminiNativeSearch ? 1 : 0),
        nativeSearch: !!geminiNativeSearch,
        cacheHit: !!geminiCacheUsed,
        cacheMode,
        cache_tokens: geminiCacheUsed ? geminiCacheUsed.tokens : 0,
        sent_msgs: cacheMode ? reqBody.contents.length : trimmedContents.length,
      });

      // systemInstruction 由 applyFullBody() / 缓存分支决定；缓存模式下**绝不能**再带（会 400）
      if (!cacheMode && finalSysText) {
        reqBody.systemInstruction = { parts: [{ text: finalSysText }] };
      }

      if (generationConfig) {
        if (generationConfig.thinkingConfig) {
          if (model && /gemini-2\.5/.test(model)) {
            const levelToBudget = { LOW: 1024, MEDIUM: 8192, HIGH: 24576 };
            const level = generationConfig.thinkingConfig.thinkingLevel;
            const budget = levelToBudget[level] || -1;
            generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
          } else if (model && /gemini-[3-9]/.test(model)) {
            const level = (generationConfig.thinkingConfig.thinkingLevel || '').toLowerCase();
            if (level && level !== 'none') {
              generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: true };
            } else {
              delete generationConfig.thinkingConfig;
            }
          } else {
            delete generationConfig.thinkingConfig;
          }
        }
        reqBody.generationConfig = generationConfig;
      }

      // 工具 / systemInstruction 已在上面由 applyFullBody() 或缓存分支决定，这里不再覆盖

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const sseSend = (obj) => {
        try { if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
        catch (e) { console.error('[sse] write failed:', e.message); }
      };

      // 前端通知：上下文状态（每轮都发，前端据此裁掉已被摘要覆盖的历史，省掉几 MB 上传）
      sseSend({ type: 'context_state', ...contextState });
      // 前端通知：RAG 结果 + 上下文压缩
      if (ragResults.length > 0) {
        sseSend({ type: 'rag_results', memories: ragResults.map(m => ({ content: m.content, type: m.type, date: m.date, score: m._score })) });
      }
      if (compressionInfo) {
        sseSend({ type: 'context_compressed', ...compressionInfo });
      }

      // 60s no-chunk timeout
      let chunkTimer = setTimeout(() => {
        sseSend({ type: 'error', message: '流式超时：60秒无响应' });
        res.end();
      }, 60000);
      const resetTimer = () => {
        clearTimeout(chunkTimer);
        chunkTimer = setTimeout(() => {
          sseSend({ type: 'error', message: '流式超时：60秒无新数据' });
          res.end();
        }, 60000);
      };

      try {
        const collectStreamText = (stream) => new Promise((resolve) => {
          const chunks = [];
          stream.on('data', c => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', () => resolve(''));
        });

        // 请求前先剔除已知失效的附件（换过 key / 超 48h 过期）
        const preStripped = stripDeadMediaParts(reqBody.contents);
        if (preStripped.stripped > 0) {
          reqBody.contents = preStripped.contents;
          // followup 用的是 trimmedContents（非缓存模式），必须同步，否则它又把死附件带回去 → 403
          if (!cacheMode) trimmedContents = preStripped.contents;
          sseSend({ type: 'tool_call', tool: 'media_expired', detail: `${preStripped.stripped} 个附件已过期，已跳过` });
        }

        let geminiRes = await callGeminiRaw(streamPath, reqBody);
        let preErrBody = '';

        if (geminiRes.statusCode !== 200) {
          preErrBody = await collectStreamText(geminiRes);

          // 缓存名失效（TTL 到期 / 被删 / 换 key）→ 丢掉缓存整段重发，别让用户看到报错
          if (reqBody.cachedContent && /cachedContent|cached_content|cache/i.test(preErrBody)) {
            console.warn('[cache] 缓存不可用，去掉 cachedContent 重试:', preErrBody.slice(0, 200));
            geminiCaches.delete(convId || '__default__');
            cacheMode = false;
            applyFullBody();          // 恢复 systemInstruction + tools + 全量 contents
            geminiRes = await callGeminiRaw(streamPath, reqBody);
            preErrBody = geminiRes.statusCode !== 200 ? await collectStreamText(geminiRes) : '';
          }

          // 附件失效（403 PERMISSION_DENIED / 过期）→ 登记 + 剔除后重试一次
          if (MEDIA_DEAD_RE.test(preErrBody)) {
            const uris = collectFileUris(reqBody.contents);
            if (uris.length > 0) {
              uris.forEach(u => DEAD_MEDIA_URIS.add(u));
              saveDeadMedia();
              console.warn(`[media] 附件失效（${uris.length} 个，换 key 或超 48h），剔除后重试:`, preErrBody.slice(0, 200));
              const again = stripDeadMediaParts(reqBody.contents);
              reqBody.contents = again.contents;
              trimmedContents = again.contents;
              sseSend({ type: 'tool_call', tool: 'media_expired', detail: `${again.stripped} 个附件已过期，已跳过` });
              geminiRes = await callGeminiRaw(streamPath, reqBody);
              preErrBody = geminiRes.statusCode !== 200 ? await collectStreamText(geminiRes) : '';
            }
          }

          // 内建搜索不可用（key 没额度 / 该模型不支持 grounding）时降级成 web_search 函数工具
          if (geminiRes.statusCode !== 200 && geminiNativeSearch && !cacheMode
              && /grounding|google search|google_search|not supported|tool/i.test(preErrBody)) {
            console.warn('[gemini] 内建搜索被拒，降级为 DeepSeek 搜索函数工具:', preErrBody.slice(0, 200));
            reqBody.tools = [...mergedTools, WEB_SEARCH_TOOL];
            delete reqBody.toolConfig;
            geminiRes = await callGeminiRaw(streamPath, reqBody);
            preErrBody = geminiRes.statusCode !== 200 ? await collectStreamText(geminiRes) : '';
          }
        }

        if (geminiRes.statusCode !== 200) {
          if (!preErrBody) preErrBody = await collectStreamText(geminiRes);
          let msg = `API Error ${geminiRes.statusCode}`;
          try { msg = JSON.parse(preErrBody).error?.message || msg; } catch {}
          sseSend({ type: 'error', message: msg });
          clearTimeout(chunkTimer);
          res.end();
          return;
        }

        // Parse Gemini SSE stream
        let buffer = '';
        let fullThought = '';
        let fullText = '';
        const saveCalls = [];
        const searchSources = [];   // 本轮搜到的引用，done 时回传前端
        let usageMetadata = null;
        let nativeSearchAnnounced = false;
        let lastFinishReason = '';

        // Gemini 内建 grounding → 与 DeepSeek 搜索结果同一套 sources 结构，前端只认一种
        const collectGrounding = (gm) => {
          if (!gm) return;
          const queries = Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries.filter(Boolean) : [];
          if (queries.length > 0 && !nativeSearchAnnounced) {
            nativeSearchAnnounced = true;
            sseSend({ type: 'tool_call', tool: 'web_search', detail: `「${String(queries[0]).slice(0, 60)}」· Gemini 搜索` });
          }
          for (const c of gm.groundingChunks || []) {
            const web = c?.web;
            if (!web || !web.uri) continue;
            searchSources.push({ title: web.title || web.uri, url: web.uri, snippet: web.title || '', site: '', date: '' });
          }
        };

        geminiRes.on('data', (chunk) => {
          resetTimer();
          buffer += chunk.toString('utf8');

          // Gemini SSE: lines starting with "data: " followed by JSON
          let lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            let parsed;
            try { parsed = JSON.parse(jsonStr); } catch { continue; }

            // Extract usage metadata
            if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;
            if (parsed.candidates?.[0]?.finishReason) lastFinishReason = parsed.candidates[0].finishReason;

            // 内建搜索的引用/命中词
            collectGrounding(parsed.candidates?.[0]?.groundingMetadata);

            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.functionCall) {
                if (FUNCTION_CALL_NAMES.includes(part.functionCall.name)) {
                  saveCalls.push(part);
                }
                continue;
              }
              if (part.thought && part.text) {
                fullThought += part.text;
                sseSend({ type: 'thinking', text: part.text });
              } else if (part.text) {
                fullText += part.text;
                sseSend({ type: 'answer', text: part.text });
              }
            }
          }
        });

        geminiRes.on('end', async () => {
          clearTimeout(chunkTimer);

          // Process any remaining buffer
          if (buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;
                collectGrounding(parsed.candidates?.[0]?.groundingMetadata);
                const parts = parsed.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  if (part.functionCall && FUNCTION_CALL_NAMES.includes(part.functionCall.name)) {
                    saveCalls.push(part);
                    continue;
                  }
                  if (part.thought && part.text) {
                    fullThought += part.text;
                    sseSend({ type: 'thinking', text: part.text });
                  } else if (part.text) {
                    fullText += part.text;
                    sseSend({ type: 'answer', text: part.text });
                  }
                }
              } catch {}
            }
          }

          // Handle function calls
          let savedMemories = [];
          const memoryCalls = saveCalls.filter(sc => sc.functionCall.name === 'save_memory');
          const healthCalls = saveCalls.filter(sc => sc.functionCall.name === 'get_health_trend');
          const lockCalls = saveCalls.filter(sc => sc.functionCall.name === 'lock_app');
          const autocliCalls = saveCalls.filter(sc => sc.functionCall.name === 'fetch_site');
          const nudgeCalls = saveCalls.filter(sc => sc.functionCall.name === 'schedule_nudge');
          const searchCalls = saveCalls.filter(sc => sc.functionCall.name === 'web_search');
          const needsFollowup = healthCalls.length > 0 || lockCalls.length > 0 || autocliCalls.length > 0 || nudgeCalls.length > 0 || searchCalls.length > 0 || (!fullText.trim() && saveCalls.length > 0);

          // 先执行 autocli（异步），结果在 functionResponses 里回传
          const autocliResults = new Map();
          if (autocliCalls.length > 0) {
            await Promise.all(autocliCalls.slice(0, 3).map(async (sc) => {
              const args = sc.functionCall.args || {};
              console.log(`[autocli-gemini] site=${args.site} command=${args.command} query=${args.query || ''}`);
              sseSend({ type: 'tool_call', tool: 'fetch_site', detail: `${args.site} ${args.command}${args.query ? ' 「' + String(args.query).slice(0, 40) + '」' : ''}` });
              autocliResults.set(sc, await runAutocli(args));
            }));
          }

          // 联网搜索（DeepSeek Search API）。串行执行，避免一次触发多条搜索打爆限速
          const searchResults = new Map();
          for (const sc of searchCalls.slice(0, 3)) {
            const args = sc.functionCall.args || {};
            const q = String(args.query || '').slice(0, 128).trim();
            sseSend({ type: 'tool_call', tool: 'web_search', detail: q ? `「${q.slice(0, 60)}」` : '' });
            const sr = await deepseekSearch(q, { count: args.count, needContent: true, oriQuestion: userText });
            if (sr.sources && sr.sources.length > 0) {
              searchSources.push(...sr.sources);
              sseSend({ type: 'search_sources', sources: sr.sources });
            }
            searchResults.set(sc, {
              ok: sr.ok,
              query: q,
              error: sr.error || undefined,
              results: sr.results.map(r => ({
                title: r.title,
                url: r.url,
                date: r.date ? r.date.slice(0, 10) : '',
                text: shorten(r.content || r.summary || r.snippet, SEARCH_CONTENT_LIMIT),
              })),
            });
          }

          if (memoryCalls.length > 0) {
            savedMemories = await Promise.all(
              memoryCalls.slice(0, MAX_SAVES_PER_RESPONSE).map(sc =>
                saveMemoryAuto(sc.functionCall.args || {}).catch(err => {
                  console.error('[save_memory] failed:', err.message);
                  return { status: 'error', content: sc.functionCall.args?.content || '' };
                })
              )
            );
          }

          for (const lc of lockCalls) {
            const args = lc.functionCall.args || {};
            console.log(`[lock_app] action=${args.action} apps=${JSON.stringify(args.apps)}`);
            sseSend({ type: 'tool_call', tool: 'lock_app', detail: `${args.action === 'lock' ? '锁定' : '解锁'} ${(args.apps || []).length} 个应用` });
            recordToolCall({ tool: 'lock_app', summary: `${args.action === 'lock' ? '锁定' : '解锁'} ${(args.apps || []).length} 个应用` });
            sseSend({ type: 'lock_app', action: args.action, apps: args.apps || [] });
          }

          const nudgeResults = new Map();
          for (const nc of nudgeCalls) {
            const args = nc.functionCall.args || {};
            const dir = addProactiveDirective({ ...args, source: 'model-gemini' });
            sseSend({ type: 'tool_call', tool: 'schedule_nudge', detail: `${Math.round((dir.at - Date.now()) / 60000)} 分钟后：${dir.condition}` });
            nudgeResults.set(nc, { ok: true, scheduled_at: new Date(dir.at).toISOString(), delay_minutes: Math.round((dir.at - Date.now()) / 60000) });
          }

          if (needsFollowup && saveCalls.length > 0) {
              const callNames = saveCalls.map(sc => sc.functionCall.name).join(', ');
              console.log(`[stream] triggering followup after ${callNames}...`);
              try {
                const firstPassUsage = usageMetadata;
                const modelContent = { role: 'model', parts: saveCalls };

                const functionResponses = saveCalls.map(sc => {
                  if (sc.functionCall.name === 'get_health_trend') {
                    const args = sc.functionCall.args || {};
                    const trend = getRealtimeTrend(args.hours || 3);
                    console.log(`[health_trend] ${args.hours || 3}h, ${trend.count} entries`);
                    sseSend({ type: 'tool_call', tool: 'get_health_trend', detail: `近 ${args.hours || 3} 小时` });
                    return { functionResponse: { name: sc.functionCall.name, response: trend } };
                  }
                  if (sc.functionCall.name === 'fetch_site') {
                    const r = autocliResults.get(sc) || { error: 'autocli 未执行' };
                    return { functionResponse: { name: sc.functionCall.name, response: r } };
                  }
                  if (sc.functionCall.name === 'lock_app') {
                    const args = sc.functionCall.args || {};
                    return { functionResponse: { name: sc.functionCall.name, response: { ok: true, action: args.action, apps: args.apps } } };
                  }
                  if (sc.functionCall.name === 'schedule_nudge') {
                    return { functionResponse: { name: sc.functionCall.name, response: nudgeResults.get(sc) || { ok: false } } };
                  }
                  if (sc.functionCall.name === 'web_search') {
                    return { functionResponse: { name: sc.functionCall.name, response: searchResults.get(sc) || { ok: false, error: '搜索未执行' } } };
                  }
                  return { functionResponse: { name: sc.functionCall.name, response: { ok: true } } };
                });
                const followupTools = (reqBody.tools || []).filter(t =>
                  !(t.functionDeclarations || []).some(f => FUNCTION_CALL_NAMES.includes(f.name))
                );
                // 缓存模式下真正发出去的是 reqBody.contents（环境块 + 尾巴），tools/toolConfig 在缓存里
                const followupBase = cacheMode ? reqBody.contents : trimmedContents;
                const followupBody = {
                  ...reqBody,
                  contents: [...followupBase, modelContent, { role: 'user', parts: functionResponses }],
                };
                if (!cacheMode) {
                  if (followupTools.length > 0) {
                    followupBody.tools = followupTools;
                  } else {
                    delete followupBody.tools;
                  }
                } else {
                  delete followupBody.tools;     // 缓存里已有 tools，请求里再带会 400
                }
                // includeServerSideToolInvocations only for gemini-2.0
                delete followupBody.toolConfig;

                // Use streaming for followup too (non-streaming times out on this VPS)
                const followupPath = `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

                // 跑一次 followup，把正文（thought 丢弃）追加到 fullText，返回本次新产生的正文
                const runFollowup = async (payload, label = '') => {
                  // 附件可能在这一轮里失效（首轮 200、跟进轮 403 的情况真的出现过）→ 先剔除已知死件
                  const fuStrip = stripDeadMediaParts(payload.contents);
                  if (fuStrip.stripped > 0) {
                    payload = { ...payload, contents: fuStrip.contents };
                    console.warn(`[stream] followup${label} 剔除 ${fuStrip.stripped} 个失效附件`);
                  }
                  console.log(`[stream] followup${label} body keys:`, Object.keys(payload), 'tools:', JSON.stringify(payload.tools)?.substring(0, 200));
                  let fRes = await callGeminiRaw(followupPath, payload);
                  console.log(`[stream] followup${label} status:`, fRes.statusCode);
                  let got = '';
                  if (fRes.statusCode !== 200) {
                    const errChunks = [];
                    fRes.on('data', c => errChunks.push(c));
                    await new Promise(r => fRes.on('end', r));
                    const errText = Buffer.concat(errChunks).toString('utf8');
                    console.error('[stream] followup non-200:', fRes.statusCode, errText.substring(0, 500));
                    // 附件失效导致的 403：登记 + 剔除 + 重试一次（否则整条回复变成「正文生成失败」）
                    if (MEDIA_DEAD_RE.test(errText)) {
                      const uris = collectFileUris(payload.contents);
                      if (uris.length > 0) {
                        uris.forEach(u => DEAD_MEDIA_URIS.add(u));
                        saveDeadMedia();
                        console.warn(`[media] followup 阶段发现 ${uris.length} 个附件失效，剔除后重试`);
                        const again = stripDeadMediaParts(payload.contents);
                        payload = { ...payload, contents: again.contents };
                        sseSend({ type: 'tool_call', tool: 'media_expired', detail: `${again.stripped} 个附件已过期，已跳过` });
                        fRes = await callGeminiRaw(followupPath, payload);
                        console.log(`[stream] followup${label}-media-retry status:`, fRes.statusCode);
                        if (fRes.statusCode !== 200) {
                          const c2 = [];
                          fRes.on('data', c => c2.push(c));
                          await new Promise(r => fRes.on('end', r));
                          console.error('[stream] followup 重试仍失败:', Buffer.concat(c2).toString('utf8').substring(0, 300));
                          return got;
                        }
                      }
                    } else {
                      return got;
                    }
                  }
                  await new Promise((resolveFollowup) => {
                    let fBuf = '';
                    fRes.on('data', (fChunk) => {
                      fBuf += fChunk.toString('utf8');
                      const fLines = fBuf.split('\n');
                      fBuf = fLines.pop();
                      for (const fLine of fLines) {
                        if (!fLine.startsWith('data: ')) continue;
                        let fp;
                        try { fp = JSON.parse(fLine.slice(6).trim()); } catch { continue; }
                        if (fp.usageMetadata) {
                          // Merge: prompt uses followup's count (it includes full history),
                          // output and thinking tokens are summed from both passes
                          if (firstPassUsage) {
                            const a = firstPassUsage, b = fp.usageMetadata;
                            usageMetadata = {
                              promptTokenCount: b.promptTokenCount || a.promptTokenCount || 0,
                              candidatesTokenCount: (a.candidatesTokenCount || 0) + (b.candidatesTokenCount || 0),
                              thoughtsTokenCount: (a.thoughtsTokenCount || 0) + (b.thoughtsTokenCount || 0),
                              totalTokenCount: (b.promptTokenCount || a.promptTokenCount || 0)
                                + (a.candidatesTokenCount || 0) + (b.candidatesTokenCount || 0)
                                + (a.thoughtsTokenCount || 0) + (b.thoughtsTokenCount || 0),
                            };
                            if (a.cachedContentTokenCount || b.cachedContentTokenCount) {
                              usageMetadata.cachedContentTokenCount = Math.max(a.cachedContentTokenCount || 0, b.cachedContentTokenCount || 0);
                            }
                          } else {
                            usageMetadata = fp.usageMetadata;
                          }
                        }
                        collectGrounding(fp.candidates?.[0]?.groundingMetadata);
                        const fParts = fp.candidates?.[0]?.content?.parts || [];
                        const fFinish = fp.candidates?.[0]?.finishReason;
                        if (fFinish && fFinish !== 'STOP') console.log('[stream] followup finishReason:', fFinish);
                        for (const p of fParts) {
                          if (p.functionCall) continue;
                          if (p.thought && p.text) {
                            // Skip followup thinking — first pass already sent it
                            continue;
                          } else if (p.text) {
                            got += p.text;
                            fullText += p.text;
                            sseSend({ type: 'answer', text: p.text });
                          }
                        }
                      }
                    });
                    fRes.on('end', resolveFollowup);
                    fRes.on('error', (e) => {
                      console.error('[stream] followup stream error:', e.message);
                      resolveFollowup();
                    });
                  });
                  return got;
                };

                let gotText = await runFollowup(followupBody);
                // Gemini 3 偶发：带工具结果回来时正文为空（finishReason 却是 STOP）。
                // 补一轮「直接回答、别调工具、别思考」的重试，避免整条回复变成「正文生成失败」。
                if (!gotText.trim()) {
                  console.warn('[stream] followup 正文为空，重试一次（追加指令）');
                  // 保留 thinkingConfig：关掉思考会让模型把推理过程当正文吐出来（会漏到回答里）
                  const retryBody = {
                    ...followupBody,
                    contents: [
                      ...followupBody.contents,
                      { role: 'user', parts: [{ text: '请直接依据上面的工具结果回答我刚才的问题，不要再调用工具，也不要只输出思考过程。' }] },
                    ],
                  };
                  gotText = await runFollowup(retryBody, '-retry');
                }

                if (!gotText.trim()) {
                  console.error('[stream] followup still no text');
                  sseSend({ type: 'answer', text: '\n\n（系统：正文生成失败，请重试）' });
                }
              } catch (err) {
                console.error('[followup] failed:', err.message);
                sseSend({ type: 'answer', text: '\n\n（系统：正文生成失败，请重试）' });
              }
          }

          // 空正文兜底：区分「输出被 max_output_tokens 截断（思考吃光预算）」和「真的没生成」
          if (!fullText.trim()) {
            const thinkTok = (usageMetadata && (usageMetadata.thoughtsTokenCount || usageMetadata.thoughts_token_count)) || 0;
            const truncated = lastFinishReason === 'MAX_TOKENS' || (usageMetadata && usageMetadata.finishReason === 'MAX_TOKENS');
            if (truncated && thinkTok > 0) {
              console.warn(`[stream] 空正文但思考用了 ${thinkTok} tokens，finishReason=${lastFinishReason || '-'} → 判定为被 max_output_tokens 截断`);
              sseSend({ type: 'answer', text: '\n\n（输出被截断：这次思考用掉了 ' + thinkTok + ' tokens，正文没有剩余预算。把「最大输出 tokens」调大，或把思考等级降到 Low / None 再试。）' });
            } else if (lastFinishReason && lastFinishReason !== 'STOP') {
              sseSend({ type: 'answer', text: `\n\n（模型没有产出正文：finishReason=${lastFinishReason}，可以重试一次。）` });
            }
          }

          // Send metadata + done
          const doneData = { type: 'done' };
          if (usageMetadata) doneData.usageMetadata = usageMetadata;
          if (searchSources.length > 0) doneData.searchSources = searchSources;
          if (savedMemories.length > 0) doneData.savedMemories = savedMemories;
          logUsage({
            provider: 'gemini', model, kind: 'chat', convId: convId || '', ok: true,
            in: usageMetadata?.promptTokenCount || 0,
            out: usageMetadata?.candidatesTokenCount || 0,
            think: usageMetadata?.thoughtsTokenCount || 0,
            cached: usageMetadata?.cachedContentTokenCount || 0,
            search: (geminiNativeSearch ? 1 : 0) + searchSources.length,
          });
          sseSend(doneData);
          res.end();

          // 记录模型回复（thought 和 text 分字段存）
          if (fullText || fullThought) logChat('model', fullText || '', fullThought || undefined);
        });

        geminiRes.on('error', (err) => {
          clearTimeout(chunkTimer);
          sseSend({ type: 'error', message: 'Gemini stream error: ' + err.message });
          res.end();
        });

        // Client disconnect
        res.on('close', () => {
          clearTimeout(chunkTimer);
          geminiRes.destroy();
        });

      } catch (err) {
        clearTimeout(chunkTimer);
        sseSend({ type: 'error', message: 'Proxy error: ' + err.message });
        res.end();
      }
    });
    return;
  }

  // ===== 非流式（旧接口，保留作为 fallback） =====
  if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) {
    return reply(res, 404, { error: 'Not found' });
  }

  const MAX_CHAT_BODY = 48 * 1024 * 1024;
  let body = '';
  let bodyTooBig = false;
  req.on('data', chunk => {
    if (bodyTooBig) return;
    body += chunk;
    if (body.length > MAX_CHAT_BODY) {
      bodyTooBig = true;
      body = '';
      console.warn(`[chat] 请求体超过 ${MAX_CHAT_BODY / 1048576}MB，拒绝`);
      reply(res, 413, { error: `请求体过大（上限 ${MAX_CHAT_BODY / 1048576}MB）` });
    }
  });
  req.on('end', async () => {
    if (bodyTooBig) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      return reply(res, 400, { error: 'Invalid JSON' });
    }

    const { apiKey, model, contents, generationConfig, systemInstruction, tools, ragMemory, convId } = parsed;
    if (apiKey) cacheApiKey(apiKey);
    if (!model || !contents) {
      return reply(res, 400, { error: 'Missing model or contents' });
    }
    if (!isDeepSeekModel(model) && !apiKey) {
      return reply(res, 400, { error: 'Missing apiKey for Gemini model' });
    }
    if (!Array.isArray(contents) || contents.length === 0) {
      return reply(res, 400, { error: 'contents must be a non-empty array' });
    }

    // RAG: extract last user message and query memories + memos (only if enabled)
    let memoryBlock = '';
    if (ragMemory) {
      const lastUserMsg = [...contents].reverse().find(c => c.role === 'user');
      const userText = lastUserMsg?.parts?.map(p => p.text).filter(Boolean).join(' ') || '';
      const [memos, memories] = await Promise.all([
        queryMemos(),
        userText ? queryRAG(userText) : Promise.resolve([]),
      ]);
      memoryBlock = formatMemoryBlock(memos, memories);
    }

    // 记录用户消息
    const lastUser = [...contents].reverse().find(c => c.role === 'user');
    const userText = lastUser?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
    if (userText) logChat('user', userText);

    // 先把 systemInstruction 终稿和 tools 算出来（压缩判定要把固定开销算进去）
    // 稳定的指令在前、每轮都变的数据块在后 → 稳住 prompt 前缀，利于隐式缓存命中
    const existingSysText = systemInstruction?.parts?.[0]?.text || '';
    const saveMemoryEnabled = !!ragMemory;
    const saveGuidance = saveMemoryEnabled ? SAVE_MEMORY_PROMPT : '';
    const weatherBlock = formatWeatherBlock();
    const healthBlock = formatHealthBlock();
    const screenBlock = formatScreenTimeBlock();
    const lockAppGuidance = LOCK_APP_PROMPT;
    const nonStreamSearchEnabled = !!parsed.webSearch && !isImageModelName(model);
    const nonStreamNativeSearch = nonStreamSearchEnabled && /gemini-[3-9]/.test(model);
    const webSearchGuidance = nonStreamSearchEnabled
      ? (nonStreamNativeSearch ? GEMINI_SEARCH_PROMPT : WEB_SEARCH_PROMPT)
      : '';
    const contextLine = typeof parsed.contextLine === 'string' ? parsed.contextLine : '';
    const toolHistoryBlock = saveMemoryEnabled ? (formatDirectiveBlock() + formatToolCallBlock()) : '';
    const auditBlock = formatAuditBlock();
    const finalSysText = existingSysText + saveGuidance + lockAppGuidance + webSearchGuidance + weatherBlock + healthBlock + screenBlock + auditBlock + memoryBlock + toolHistoryBlock + contextLine;

    const mergedTools = [];
    if (Array.isArray(tools)) mergedTools.push(...tools);
    if (nonStreamSearchEnabled && !nonStreamNativeSearch) mergedTools.push(WEB_SEARCH_TOOL);
    if (saveMemoryEnabled) mergedTools.push(SAVE_MEMORY_TOOL);
    if (realtimeCache.length > 0) mergedTools.push(GET_HEALTH_TREND_TOOL);
    mergedTools.push(LOCK_APP_TOOL);
    mergedTools.push(AUTOCLI_TOOL);
    if (saveMemoryEnabled) mergedTools.push(SCHEDULE_NUDGE_TOOL);

    // 滑动上下文窗口
    const { contents: trimmedContents, state: contextState } = await applyContextWindow(contents, convId, {
      fixedTokens: estimateTextTokens(finalSysText) + estimateToolsTokens(mergedTools),
      historyOffset: parsed.historyOffset,
    });

    const geminiPath = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const reqBody = { contents: trimmedContents };

    if (finalSysText) {
      reqBody.systemInstruction = { parts: [{ text: finalSysText }] };
    }

    if (generationConfig) {
      if (generationConfig.thinkingConfig) {
        if (model && /gemini-2\.5/.test(model)) {
          const levelToBudget = { LOW: 1024, MEDIUM: 8192, HIGH: 24576 };
          const level = generationConfig.thinkingConfig.thinkingLevel;
          const budget = levelToBudget[level] || -1;
          generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
        } else if (model && /gemini-[3-9]/.test(model)) {
          const level = (generationConfig.thinkingConfig.thinkingLevel || '').toLowerCase();
          if (level && level !== 'none') {
            generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: true };
          } else {
            delete generationConfig.thinkingConfig;
          }
        } else {
          delete generationConfig.thinkingConfig;
        }
      }
      reqBody.generationConfig = generationConfig;
    }

    // 工具：函数声明 +（Gemini 3+）内建 Google Search grounding
    if (mergedTools.length > 0) {
      reqBody.tools = [...mergedTools];
    }
    if (nonStreamNativeSearch) {
      reqBody.tools = [...(reqBody.tools || []), { google_search: {} }];
      if (mergedTools.length > 0) {
        reqBody.toolConfig = { ...(reqBody.toolConfig || {}), includeServerSideToolInvocations: true };
      }
    }

    try {
      // 请求前剔除已知失效附件（换过 key / 超 48h 过期）
      const nsStripped = stripDeadMediaParts(reqBody.contents);
      if (nsStripped.stripped > 0) reqBody.contents = nsStripped.contents;

      let { status, data } = await callGemini(geminiPath, reqBody);

      // 附件失效（403 / 过期）→ 登记 + 剔除后重试一次
      if (status !== 200 && MEDIA_DEAD_RE.test(JSON.stringify(data || {}))) {
        const uris = collectFileUris(reqBody.contents);
        if (uris.length > 0) {
          uris.forEach(u => DEAD_MEDIA_URIS.add(u));
          saveDeadMedia();
          console.warn(`[media] 附件失效（${uris.length} 个），剔除后重试（非流式）`);
          reqBody.contents = stripDeadMediaParts(reqBody.contents).contents;
          ({ status, data } = await callGemini(geminiPath, reqBody));
        }
      }

      // Detect & execute function calls
      const modelContent = data?.candidates?.[0]?.content;
      const parts = modelContent?.parts || [];
      const allFuncCalls = parts.filter(p => p.functionCall && FUNCTION_CALL_NAMES.includes(p.functionCall.name));
      const memoryCalls = allFuncCalls.filter(p => p.functionCall.name === 'save_memory').slice(0, MAX_SAVES_PER_RESPONSE);
      const healthTrendCalls = allFuncCalls.filter(p => p.functionCall.name === 'get_health_trend');
      const lockCalls2 = allFuncCalls.filter(p => p.functionCall.name === 'lock_app');
      const nudgeCalls2 = allFuncCalls.filter(p => p.functionCall.name === 'schedule_nudge');
      const searchCalls2 = allFuncCalls.filter(p => p.functionCall.name === 'web_search');

      let savedMemories = [];
      if (memoryCalls.length > 0) {
        savedMemories = await Promise.all(
          memoryCalls.map(sc => saveMemoryAuto(sc.functionCall.args || {}).catch(err => {
            console.error('[save_memory] failed:', err.message);
            return { status: 'error', content: sc.functionCall.args?.content || '' };
          }))
        );
      }

      let lockAppActions = [];
      for (const lc of lockCalls2) {
        const args = lc.functionCall.args || {};
        console.log(`[lock_app] action=${args.action} apps=${JSON.stringify(args.apps)}`);
        lockAppActions.push({ action: args.action, apps: args.apps || [] });
      }

      const nudgeResults2 = new Map();
      for (const nc of nudgeCalls2) {
        const args = nc.functionCall.args || {};
        const dir = addProactiveDirective({ ...args, source: 'model-gemini' });
        nudgeResults2.set(nc, { ok: true, scheduled_at: new Date(dir.at).toISOString(), delay_minutes: Math.round((dir.at - Date.now()) / 60000) });
      }

      // 联网搜索（DeepSeek Search API），串行执行避免打爆限速
      const searchResults2 = new Map();
      const searchSources2 = [];
      for (const sc of searchCalls2.slice(0, 3)) {
        const args = sc.functionCall.args || {};
        const q = String(args.query || '').slice(0, 128).trim();
        const sr = await deepseekSearch(q, { count: args.count, needContent: true, oriQuestion: userText });
        if (sr.sources && sr.sources.length > 0) searchSources2.push(...sr.sources);
        searchResults2.set(sc, {
          ok: sr.ok,
          query: q,
          error: sr.error || undefined,
          results: sr.results.map(r => ({
            title: r.title,
            url: r.url,
            date: r.date ? r.date.slice(0, 10) : '',
            text: shorten(r.content || r.summary || r.snippet, SEARCH_CONTENT_LIMIT),
          })),
        });
      }

      const hasText = parts.some(p => p.text && !p.thought);
      const needFollowup = healthTrendCalls.length > 0 || lockCalls2.length > 0 || nudgeCalls2.length > 0 || searchCalls2.length > 0 || (!hasText && allFuncCalls.length > 0);
      if (needFollowup && allFuncCalls.length > 0) {
          const functionResponses = allFuncCalls.map(p => {
            if (p.functionCall.name === 'get_health_trend') {
              const args = p.functionCall.args || {};
              const trend = getRealtimeTrend(args.hours || 3);
              return { functionResponse: { name: p.functionCall.name, response: trend } };
            }
            if (p.functionCall.name === 'lock_app') {
              const args = p.functionCall.args || {};
              return { functionResponse: { name: p.functionCall.name, response: { ok: true, action: args.action, apps: args.apps } } };
            }
            if (p.functionCall.name === 'schedule_nudge') {
              return { functionResponse: { name: p.functionCall.name, response: nudgeResults2.get(p) || { ok: false } } };
            }
            if (p.functionCall.name === 'web_search') {
              return { functionResponse: { name: p.functionCall.name, response: searchResults2.get(p) || { ok: false, error: '搜索未执行' } } };
            }
            return { functionResponse: { name: p.functionCall.name, response: { ok: true } } };
          });
          const followupTools = (reqBody.tools || []).filter(t =>
            !(t.functionDeclarations || []).some(f => FUNCTION_CALL_NAMES.includes(f.name))
          );
          const followupBody = {
            ...reqBody,
            contents: [
              ...trimmedContents,
              modelContent,
              { role: 'user', parts: functionResponses },
            ],
          };
          if (followupTools.length > 0) followupBody.tools = followupTools;
          else delete followupBody.tools;
          try {
            const followup = await callGemini(geminiPath, followupBody);
            status = followup.status;
            data = followup.data;
          } catch (err) {
            console.error('[followup] failed:', err.message);
          }
      } else if (allFuncCalls.length > 0) {
          // Strip functionCall parts so client doesn't see them
          const visibleParts = parts.filter(p => !p.functionCall);
          if (data?.candidates?.[0]?.content) {
            data.candidates[0].content.parts = visibleParts;
          }
      }

      if (savedMemories.length > 0) {
        data.savedMemories = savedMemories;
      }
      if (lockAppActions.length > 0) {
        data.lockAppActions = lockAppActions;
      }
      // 内建搜索的引用（Gemini grounding）也转成同一套 sources 结构
      const gm = data?.candidates?.[0]?.groundingMetadata;
      for (const c of (gm?.groundingChunks || [])) {
        const web = c?.web;
        if (!web || !web.uri) continue;
        searchSources2.push({ title: web.title || web.uri, url: web.uri, snippet: web.title || '', site: '', date: '' });
      }
      if (searchSources2.length > 0) {
        data.searchSources = searchSources2;
      }
      // 记录模型回复（按 thought flag 分两个字段）
      const modelParts = data?.candidates?.[0]?.content?.parts || [];
      const answerText = modelParts.filter(p => !p.thought).map(p => p.text).filter(Boolean).join('\n');
      const thoughtText = modelParts.filter(p => p.thought).map(p => p.text).filter(Boolean).join('\n');
      if (answerText || thoughtText) logChat('model', answerText, thoughtText || undefined);

      // 上下文状态回传（前端据此裁掉已被摘要覆盖的历史）
      data.contextState = contextState;
      reply(res, status, data);
    } catch (err) {
      console.error('Proxy error:', err.message);
      reply(res, 502, { error: 'Proxy error: ' + err.message });
    }
  });
}

// =====================================================================
// ===== 主动消息（proactive）支撑层 =====
// 调度/阈值/状态机在 proactive/ 守护进程里；server.js 只负责：
//   1) 出数据切片（snapshot）  2) 两阶段 LLM 调用  3) 投递 + 通知队列  4) 屏幕活动上报
// 所有端点都走 /api/* 的 APP_TOKEN 鉴权。
// =====================================================================
const PROACTIVE_DIR = path.join(__dirname, 'proactive');
const PROACTIVE_STATE_DIR = path.join(PROACTIVE_DIR, 'state');
const ACTIVITY_DIR = path.join(__dirname, 'activity');
try { fs.mkdirSync(PROACTIVE_STATE_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(ACTIVITY_DIR, { recursive: true }); } catch {}

const RUNTIME_KEYS_PATH = path.join(PROACTIVE_STATE_DIR, 'runtime-keys.json');
const PENDING_PATH = path.join(PROACTIVE_STATE_DIR, 'pending.json');
const PROACTIVE_CONFIG_PATH = path.join(PROACTIVE_DIR, 'config.json');

function appendJsonlSafe(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (e) { console.error('[proactive] append failed:', e.message); }
}
function readTailLines(file, maxBytes = 65536) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } catch { return []; }
}
function readProactiveConfig() {
  try { return JSON.parse(fs.readFileSync(PROACTIVE_CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// --- 前端传来的 Gemini key 顺手缓存（主动生成要用「上次对话那个模型」）---
let _lastCachedKey = '';
function cacheApiKey(key) {
  if (!key || typeof key !== 'string' || key.length < 20) return;
  if (key === _lastCachedKey) return;
  _lastCachedKey = key;
  try {
    fs.writeFileSync(RUNTIME_KEYS_PATH, JSON.stringify({ gemini: key, updatedAt: Date.now() }), { mode: 0o600 });
  } catch (e) { console.error('[proactive] cache api key failed:', e.message); }
}
function loadCachedApiKey() {
  if (_lastCachedKey) return _lastCachedKey;
  try {
    const obj = JSON.parse(fs.readFileSync(RUNTIME_KEYS_PATH, 'utf8'));
    if (obj && typeof obj.gemini === 'string') { _lastCachedKey = obj.gemini; return _lastCachedKey; }
  } catch {}
  return '';
}

// ===== 屏幕活动（MacroDroid/Tasker 上报 open/close，服务端配对算时长）=====
let activityState = { date: '', byPkg: {}, current: null, lastTs: 0 };

function applyActivityEvent(st, ev) {
  const pkg = ev && ev.pkg;
  if (!pkg) return;
  const ts = Number(ev.ts) || Date.now();
  const name = ev.label || friendlyAppName(pkg);
  if (st.current && st.current.pkg !== pkg) closeActivitySession(st, ts);   // 换 App = 隐式 close
  const kind = String(ev.event || 'open').toLowerCase();
  if (kind === 'open' || kind === 'start' || kind === 'resume') {
    if (!(st.current && st.current.pkg === pkg)) st.current = { pkg, name, since: ts };
  } else if (kind === 'close' || kind === 'stop' || kind === 'pause') {
    if (st.current && st.current.pkg === pkg) closeActivitySession(st, ts);
  }
  if (ts > st.lastTs) st.lastTs = ts;
}
function closeActivitySession(st, ts) {
  const c = st.current;
  if (!c) return;
  const minutes = Math.max(0, (ts - c.since) / 60000);
  if (minutes >= 0.2) {
    const rec = st.byPkg[c.pkg] || (st.byPkg[c.pkg] = { name: c.name, minutes: 0, sessions: 0 });
    rec.minutes += minutes;
    rec.sessions += 1;
  }
  st.current = null;
}
function loadActivityToday() {
  const date = localDateStr();
  const st = { date, byPkg: {}, current: null, lastTs: 0 };
  const file = path.join(ACTIVITY_DIR, `activity-${date}.jsonl`);
  for (const line of readTailLines(file, 4 * 1024 * 1024)) {
    try { applyActivityEvent(st, JSON.parse(line)); } catch {}
  }
  return st;
}
function recordActivityEvent(ev) {
  if (activityState.date !== localDateStr()) activityState = loadActivityToday();
  applyActivityEvent(activityState, ev);
  const date = localDateStr();
  appendJsonlSafe(path.join(ACTIVITY_DIR, `activity-${date}.jsonl`), {
    pkg: ev.pkg, label: ev.label || friendlyAppName(ev.pkg), event: ev.event || 'open',
    ts: Number(ev.ts) || Date.now(), _received_ts: Date.now(),
  });
}
function activitySummary() {
  const now = Date.now();
  if (activityState.date !== localDateStr()) activityState = loadActivityToday();
  const staleCut = 12 * 3600 * 1000;
  const cur = (activityState.current && now - activityState.current.since < staleCut) ? activityState.current : null;
  const apps = Object.entries(activityState.byPkg).map(([pkg, v]) => ({
    pkg, name: v.name, minutes: v.minutes, sessions: v.sessions,
  }));
  if (cur) {
    const live = (now - cur.since) / 60000;
    const rec = apps.find(a => a.pkg === cur.pkg);
    if (rec) rec.live_minutes = rec.minutes + live;
    else apps.push({ pkg: cur.pkg, name: cur.name, minutes: 0, sessions: 0, live_minutes: live });
  }
  apps.sort((a, b) => (b.live_minutes ?? b.minutes) - (a.live_minutes ?? a.minutes));
  const top = apps[0] || null;
  const out = {
    top_app: top ? top.name : null,
    top_app_minutes: top ? Math.round(top.live_minutes ?? top.minutes) : 0,
    current_app: cur ? cur.name : null,
    current_foreground_minutes: cur ? Math.round((now - cur.since) / 60000) : 0,
    apps: apps.slice(0, 5).map(a => ({ name: a.name, minutes: Math.round(a.live_minutes ?? a.minutes) })),
    source: apps.length ? 'macro_report' : 'none',
  };
  // MacroDroid 还没配好时，回落到 App 自己上报的「今日使用时长」
  if (!apps.length && screenTimeCache && Array.isArray(screenTimeCache.data) && screenTimeCache.data.length) {
    const others = screenTimeCache.data.filter(i => i.pkg !== 'com.egnor.aletheia');
    others.sort((a, b) => (b.mins || 0) - (a.mins || 0));
    if (others[0]) {
      out.top_app = friendlyAppName(others[0].pkg);
      out.top_app_minutes = Math.round(others[0].mins || 0);
      out.apps = others.slice(0, 5).map(i => ({ name: friendlyAppName(i.pkg), minutes: Math.round(i.mins || 0) }));
      out.source = 'app_report';
    }
  }
  // 单 App 连续使用时长（来自 App 每小时/每 10 分钟上报的"今日累计时长"差值）
  const streak = screenStreakInfo();
  if (streak) {
    out.streak = {
      app: friendlyAppName(streak.pkg),
      pkg: streak.pkg,
      minutes: Math.round(streak.minutes),
      since_minutes_ago: Math.round((now - streak.startTs) / 60000),
      ended_minutes_ago: streak.ended_minutes_ago,
      live: !!(cur && cur.pkg === streak.pkg),
      source: 'usage_delta',
    };
  } else {
    out.streak = null;
  }
  // MacroDroid 报的"当前前台"最可靠，有就覆盖成 live 版本
  if (cur) {
    out.streak = {
      app: cur.name, pkg: cur.pkg,
      minutes: Math.round((now - cur.since) / 60000),
      since_minutes_ago: Math.round((now - cur.since) / 60000),
      live: true, source: 'macro',
    };
  }
  return out;
}

// ===== 屏幕使用时长样本 → 推断"连续用某个 App 多久" =====
// UsageStats 只有在 App 前台时才会上报，所以这里用「两次上报之间某个 App 的累计时长增量」
// 反推那段时间在用它：增量/间隔 ≥ 0.5 视为一直在用，连续多对样本是同一个 App 就累加成一条。
let screenSampleHistory = [];   // [{ts, map:{pkg:mins}}]

function trackScreenSample(entry) {
  try {
    const ts = Number(entry && entry.timestamp) || Date.now();
    const map = {};
    for (const it of ((entry && entry.data) || [])) {
      if (it && it.pkg) map[it.pkg] = Number(it.mins) || 0;
    }
    if (!Object.keys(map).length) return;
    const last = screenSampleHistory[screenSampleHistory.length - 1];
    if (last && ts <= last.ts) return;          // 同一时刻重复上报忽略
    screenSampleHistory.push({ ts, map });
    if (screenSampleHistory.length > 80) screenSampleHistory.shift();
  } catch {}
}

function screenStreakInfo() {
  const hist = screenSampleHistory;
  if (hist.length < 2) return null;
  const now = Date.now();
  const maxAgeMs = 10 * 3600 * 1000;
  const CHAT_PKG = 'com.egnor.aletheia';      // 聊天 App 自己的时长不算"沉迷"

  // 把相邻两个上报样本变成"这一段时间在用什么 App"的判断
  const pairs = [];
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    if (b.ts < now - maxAgeMs) continue;
    const gap = (b.ts - a.ts) / 60000;
    // 上限放到 8 小时：用户"消失去刷了 3 小时小红书再回来"时，这一对的间隔正好就是那 3 小时，
    // 卡在 180 分钟会把最该抓的画面漏掉；比值门槛（增量/间隔 ≥ 0.5）本身就能挡掉"一天用一会儿"的情况
    if (gap < 0.5 || gap > 480) continue;
    let topPkg = null, topDelta = 0;
    for (const p of Object.keys(b.map)) {
      if (p === CHAT_PKG) continue;
      const d = (b.map[p] || 0) - (a.map[p] || 0);
      if (d > topDelta) { topDelta = d; topPkg = p; }
    }
    pairs.push({
      pkg: topPkg, delta: topDelta, gap, ts: b.ts,
      startTs: b.ts - topDelta * 60000,
      ratio: topPkg ? topDelta / gap : 0,
    });
  }
  if (!pairs.length) return null;

  // 连续同一 App 在用（增量/间隔 ≥ 0.5，相邻样本边界不超过 40 分钟）才算一段"连续使用"
  const pick = (cur, cand) => (!cur || cand.minutes > cur.minutes ? cand : cur);
  let best = null, run = null;
  for (const p of pairs) {
    const usable = !!p.pkg && p.delta >= 3 && p.ratio >= 0.5;
    // pairs 是按相邻样本生成的，所以"同一个 App 的可用户样本对"天然连续，直接合并即可
    if (usable && run && run.pkg === p.pkg) {
      run.minutes += p.delta;
      run.lastTs = p.ts;
      run.startTs = p.startTs;
    } else {
      if (run) best = pick(best, run);
      run = usable ? { pkg: p.pkg, minutes: p.delta, startTs: p.startTs, lastTs: p.ts } : null;
    }
  }
  if (run) best = pick(best, run);
  if (!best || best.minutes < 10) return null;
  if (now - best.lastTs > 90 * 60000) return null;    // 太久以前的事不算"当前状态"
  return {
    pkg: best.pkg,
    minutes: best.minutes,
    startTs: best.startTs,
    lastTs: best.lastTs,
    ended_minutes_ago: Math.round((now - best.lastTs) / 60000),
  };
}

// 屏幕使用样本：重启后从今天/昨天的 jsonl 重建，否则"单 App 连续使用"要重新攒样本
function loadScreenSamplesFromDisk() {
  try {
    const d = new Date();
    const days = [localDateStr(new Date(d.getTime() - 86400000)), localDateStr(d)];
    for (const day of days) {
      const file = path.join(HEALTH_DIR, `screentime-${day}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const parsed = [];
      for (const line of readTailLines(file, 256 * 1024)) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      parsed.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
      for (const e of parsed) trackScreenSample(e);
    }
    if (screenSampleHistory.length) console.log(`[screen-time] 重建样本 ${screenSampleHistory.length} 条`);
  } catch (e) { console.warn('[screen-time] 重建样本失败:', e.message); }
}
loadScreenSamplesFromDisk();

// ===== 手机使用状态（App 上报前台/熄屏，让 Daemon 知道"现在能不能跟我说话"）=====
// 落盘一份：chat 重启后不至于立刻变"未知"（前端每分钟还会再报，但重启那一两分钟别丢状态）
const PRESENCE_PATH = path.join(PROACTIVE_STATE_DIR, 'presence.json');
let presenceState = { visible: false, lastVisibleTs: 0, lastHiddenTs: 0, source: 'none' };
try {
  const o = JSON.parse(fs.readFileSync(PRESENCE_PATH, 'utf8'));
  if (o && typeof o === 'object') {
    presenceState = {
      visible: !!o.visible,
      lastVisibleTs: Number(o.lastVisibleTs) || 0,
      lastHiddenTs: Number(o.lastHiddenTs) || 0,
      source: String(o.source || 'none').slice(0, 24),
    };
  }
} catch {}

function savePresence() {
  try {
    fs.mkdirSync(PROACTIVE_STATE_DIR, { recursive: true });
    fs.writeFileSync(PRESENCE_PATH, JSON.stringify(presenceState), 'utf8');
  } catch {}
}

function markPresence(body = {}) {
  const now = Date.now();
  const visible = body.visible === undefined ? true : !!body.visible;
  presenceState.visible = visible;
  if (visible) presenceState.lastVisibleTs = now; else presenceState.lastHiddenTs = now;
  presenceState.source = String(body.source || 'app').slice(0, 24);
  savePresence();
  return presenceSummary();
}

function presenceSummary() {
  const now = Date.now();
  const vis = presenceState.lastVisibleTs || 0;
  const hid = presenceState.lastHiddenTs || 0;
  const ageMin = vis ? Math.round((now - vis) / 60000) : null;
  const inUse = !!(presenceState.visible && ageMin !== null && ageMin <= 3);
  return {
    in_use: inUse,
    using: inUse ? 'Aletheia（聊天界面在前台）' : null,
    last_active_minutes_ago: ageMin,
    last_hidden_minutes_ago: hid ? Math.round((now - hid) / 60000) : null,
    visible: !!presenceState.visible,
    source: presenceState.source,
  };
}

function formatPresenceBlock() {
  const p = presenceSummary();
  const act = activitySummary();
  const lines = ['[生生此刻的手机状态]'];
  if (p.in_use) {
    lines.push(`手机在使用中：Aletheia 在前台${p.last_active_minutes_ago ? `（${p.last_active_minutes_ago} 分钟前还有操作）` : '（刚刚还有操作）'}`);
  } else if (p.last_active_minutes_ago !== null) {
    lines.push(`不在聊天界面：最后操作 ${p.last_active_minutes_ago} 分钟前`);
  } else {
    lines.push('手机使用状态未知（App 还没上报过）');
  }
  if (act.current_app) lines.push(`前台 App：${act.current_app}（已 ${act.current_foreground_minutes} 分钟）`);
  const st = act.streak;
  if (st && st.app && st.minutes >= 15) {
    const when = st.live
      ? '（现在还在用）'
      : (st.ended_minutes_ago != null && st.ended_minutes_ago > 3 ? `（${st.ended_minutes_ago} 分钟前刚停下）` : '（刚刚还在用）');
    lines.push(`使用时长线索：${st.app} 连续用了约 ${st.minutes} 分钟${when}`);
  }
  const phone = phoneStatusSummary();
  if (phone && phone.alive === false && phone.age_minutes != null) {
    lines.push(`手机心跳：${phone.age_minutes} 分钟没上报（可能熄屏/没网/关机）`);
  }
  lines.push('[状态结束]');
  return lines.join('\n') + '\n\n';
}

// ===== 手机心跳（区分「手机/脚本挂了」vs「手表断了」）=====
let phoneStatus = null;   // {ts, node, note, _received_ts}
let phoneStatusLastAppend = 0;   // 落盘节流：两条通道（POST 上报 / pending 取件）共用，避免同一时刻写两行

function appendPhoneStatus() {
  const now = Date.now();
  if (now - phoneStatusLastAppend < 5 * 60000) return false;
  try {
    if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true });
    fs.appendFileSync(path.join(HEALTH_DIR, `phone-status-${localDateStr()}.jsonl`), JSON.stringify(phoneStatus) + '\n');
    phoneStatusLastAppend = now;
    return true;
  } catch { return false; }
}

function recordPhoneStatus(body = {}) {
  const now = Date.now();
  phoneStatus = {
    ts: Number(body.ts) || now,
    node: String(body.node || '').slice(0, 40),
    note: String(body.note || '').slice(0, 120),
    _received_ts: now,
  };
  appendPhoneStatus();
  return phoneStatus;
}
// 取件器每分钟都会打 /api/proactive/pending —— 这个请求本身就是"手机活着"的心跳，
// 不用等用户更新手机脚本。内存里永远更新，磁盘 5 分钟才写一次（省 IO）。
function touchPhoneSeen(note) {
  const now = Date.now();
  phoneStatus = { ts: now, node: (phoneStatus && phoneStatus.node) || 'termux-pull', note: note || 'pull', _received_ts: now };
  appendPhoneStatus();
}

function phoneStatusSummary() {
  if (!phoneStatus) return { alive: false, age_minutes: null };
  const age = Math.round((Date.now() - phoneStatus._received_ts) / 60000);
  return { alive: age <= 15, age_minutes: age, last_seen: new Date(phoneStatus._received_ts).toISOString(), node: phoneStatus.node, note: phoneStatus.note };
}

// ===== 健康切片 =====
function healthSlice() {
  const now = Date.now();
  const win30 = realtimeCache.filter(e => e._ts && now - e._ts <= 30 * 60 * 1000);
  const win5 = win30.filter(e => now - e._ts <= 5 * 60 * 1000);
  const last = win30[win30.length - 1] || null;
  const hr5 = win5.map(e => e.heart_rate).filter(v => typeof v === 'number' && v > 0);
  const stepsAll = win5.map(e => e.steps).filter(v => typeof v === 'number' && v >= 0);
  let steps5 = 0;
  if (stepsAll.length >= 2) {
    const d = Math.max(...stepsAll) - Math.min(...stepsAll);
    steps5 = d >= 0 ? d : 0;    // 跨零点重置时不当作负数
  }
  const today = localDateStr();
  const stepsToday = realtimeCache
    .filter(e => e._ts && localDateStr(new Date(e._ts)) === today && typeof e.steps === 'number')
    .reduce((m, e) => Math.max(m, e.steps), 0);
  return {
    hr: last && last.heart_rate ? last.heart_rate : null,
    hr_max_5min: hr5.length ? Math.max(...hr5) : null,
    hr_samples_5min: hr5.length,
    steps_5min: steps5,
    steps_today: stepsToday || null,
    stress: last && last.stress != null ? last.stress : null,
    spo2: last && last.spo2 != null ? last.spo2 : null,
    age_minutes: last ? Math.round((now - last._ts) / 60000) : null,
    hr_high_5min: hr5.length >= 2 && Math.max(...hr5) >= 110,
  };
}

// ===== 上次用户说话 / 上次主动 =====
function lastUserMessageInfo() {
  const days = [localDateStr(new Date(Date.now() - 86400000)), localDateStr()];
  let found = null;
  for (const d of days) {
    const file = path.join(__dirname, 'logs', `${d}.jsonl`);
    for (const line of readTailLines(file)) {
      try {
        const o = JSON.parse(line);
        if (o.role === 'user' && o.timestamp) {
          let ts = Date.parse(o.timestamp);
          if (!Number.isFinite(ts)) continue;
          if (ts > Date.now() + 60000) ts = Date.now();   // 客户端时钟跑偏时别算成负数
          found = { ts, text: String(o.content || '').slice(0, 120) };
        }
      } catch {}
    }
  }
  return found;
}
function proactiveHistory(limit = 20) {
  const file = path.join(PROACTIVE_STATE_DIR, 'history.jsonl');
  const lines = readTailLines(file, 512 * 1024).slice(-limit);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
function lastDeliveredProactive() {
  const h = proactiveHistory(50).filter(x => x.outcome === 'sent');
  return h.length ? h[h.length - 1] : null;
}
function proactiveSentCountToday() {
  const today = localDateStr();
  return proactiveHistory(200).filter(x => x.outcome === 'sent' && localDateStr(new Date(x.at)) === today).length;
}

// ===== 阶段一：数据切片 =====
function proactiveSnapshot() {
  const cfg = readProactiveConfig();
  const last = lastUserMessageInfo();
  const lastPro = lastDeliveredProactive();
  const now = new Date();
  const conv = null;
  const s = {
    now: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    weekday: ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()],
    minutes_since_user_msg: last ? Math.round((Date.now() - last.ts) / 60000) : null,
    last_user_excerpt: last ? last.text : null,
    last_topic_summary: (() => {
      try {
        const id = cfg.target_conv_id;
        const sm = id ? loadSummary(id) : null;
        return sm && sm.summary ? sm.summary.slice(-160) : null;
      } catch { return null; }
    })(),
    last_proactive: lastPro ? { text: String(lastPro.text || '').slice(0, 80), minutes_ago: Math.round((Date.now() - Date.parse(lastPro.at)) / 60000), trigger: lastPro.trigger || null, category: lastPro.category || null } : null,
    proactive_count_today: proactiveSentCountToday(),
    health: healthSlice(),
    screen: activitySummary(),
    phone: presenceSummary(),
    pending_nudges: (() => {
      const nowTs = Date.now();
      return listProactiveDirectives()
        .filter(d => d && !d.consumed && d.at > nowTs)
        .sort((a, b) => a.at - b.at).slice(0, 3)
        .map(d => ({ in_minutes: Math.round((d.at - nowTs) / 60000), at: hhmmLocal(d.at), condition: String(d.condition || '').slice(0, 60) }));
    })(),
    recent_tool_calls: recentToolCalls(10).slice(-4).map(c => ({
      minutes_ago: Math.max(0, Math.round((Date.now() - c.at) / 60000)),
      tool: c.tool, summary: String(c.summary || '').slice(0, 60),
    })),
    recent_categories: (() => {
      try {
        const h = proactiveHistory(20).filter(x => x.outcome === 'sent' && x.category);
        return h.slice(-5).map(x => x.category);
      } catch { return []; }
    })(),
    recent_memories: (() => {
      try {
        const h = proactiveHistory(10).filter(x => x.outcome === 'sent' && x.text);
        return h.slice(-3).map(x => x.text.slice(0, 40));
      } catch { return []; }
    })(),
  };
  return s;
}

// ===== DeepSeek 非流式调用 =====
function callDeepSeekChat(messages, opts = {}) {
  const body = {
    model: opts.model || DEEPSEEK_MODEL,
    messages,
    stream: false,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  if (opts.temperature !== undefined && !/reasoner/.test(body.model)) body.temperature = opts.temperature;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  const postData = JSON.stringify(body);
  const url = new URL(DEEPSEEK_BASE_URL + '/chat/completions');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 90000,
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: r.statusCode, data: JSON.parse(txt) }); }
        catch { resolve({ status: r.statusCode, data: { error: txt.slice(0, 300) } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('DeepSeek timeout')); });
    req.write(postData);
    req.end();
  });
}

// ===== 阶段一：决策门（~150 token 输入）=====
const PROACTIVE_GATE_PROMPT = `你是「Daemon 现在要不要主动开口」的判定器。只输出 JSON，不要任何解释。
判断原则：
- 刚聊完（<60 分钟）、用户显然在忙/在睡、没有新信息 → should_act=false
- 只有当下面信号里真的存在值得开口的切入点时才 true；宁可不说
- 切入点要轮换，别每次都盯着心率或屏幕
category 只能取这五个之一（必须选最贴合的一个）：
  health_anomaly（生理异常：心率/步数/睡眠不对劲）
  screen_time_audit（屏幕抓包：某个 App 用太久、深夜还在刷）
  homework_progress（作业/日程审查：课业、待办、约定该问进展）
  brat_tease（言语撩拨与规训：纯情绪驱动，想逗/想压）
  soft_care（温和关怀：心疼、累了、该吃饭该睡）
emotional_context：结合时间、心率走势、屏幕使用，推断生生此刻的精神负荷与情绪（≤15 字，如「疲惫但亢奋」「懒散拖延」「专注中」）
输出格式：
{"should_act":true|false,"urgency":"low"|"medium"|"high","category":"...","trigger_reason":"≤20字","tone_hint":"≤12字","emotional_context":"≤15字"}`;

function snapshotToText(s) {
  const h = s.health || {}, sc = s.screen || {};
  const lines = [
    `现在：${s.now}（${s.weekday}）`,
    `距生生上次说话：${s.minutes_since_user_msg == null ? '未知' : s.minutes_since_user_msg + ' 分钟'}`,
    `最近一条生生的话：${s.last_user_excerpt || '（无记录）'}`,
    `上次聊到的议题：${s.last_topic_summary || '（无摘要）'}`,
    `上次我主动开口：${s.last_proactive ? `「${s.last_proactive.text}」(${s.last_proactive.minutes_ago}分钟前, ${s.last_proactive.category || s.last_proactive.trigger})` : '（今天还没有）'}；今天已主动 ${s.proactive_count_today} 次`,
    `生理：心率${h.hr ?? '—'}（5分钟最高${h.hr_max_5min ?? '—'}，样本${h.hr_samples_5min ?? 0}），5分钟步数${h.steps_5min ?? '—'}，今日步数${h.steps_today ?? '—'}，压力${h.stress ?? '—'}${h.age_minutes != null ? `，数据${h.age_minutes}分钟前` : ''}`,
    `屏幕：当前前台${sc.current_app || '未知'}（已${sc.current_foreground_minutes || 0}分钟），今日最长${sc.top_app || '未知'} ${sc.top_app_minutes || 0}分钟`,
  ];
  // 手机使用状态（App 上报的前台/熄屏）+ 连续使用线索 + 已排期的提醒
  const ph = s.phone || {};
  const st = sc.streak;
  const phoneBits = [];
  if (ph.in_use) phoneBits.push(`生生此刻正在看手机（聊天界面在前台${ph.last_active_minutes_ago ? `，${ph.last_active_minutes_ago}分钟前有操作` : ''}）`);
  else if (ph.last_active_minutes_ago != null) phoneBits.push(`不在聊天界面（最后操作 ${ph.last_active_minutes_ago} 分钟前）`);
  else phoneBits.push('手机使用状态未知');
  if (st && st.minutes >= 15) phoneBits.push(`${st.app} 连续用了约 ${st.minutes} 分钟${st.live ? '（现在还在用）' : (st.ended_minutes_ago > 3 ? `（${st.ended_minutes_ago} 分钟前刚停）` : '（刚刚还在用）')}`);
  lines.push(`手机：${phoneBits.join('；')}`);
  const weatherLine = formatWeatherLine();
  if (weatherLine) lines.push(weatherLine);
  if (Array.isArray(s.pending_nudges) && s.pending_nudges.length) {
    lines.push(`已排好的主动提醒：${s.pending_nudges.map(d => `${d.in_minutes}分钟后「${d.condition}」`).join('；')}（这些已经安排过，不要重复安排）`);
  }
  if (Array.isArray(s.recent_tool_calls) && s.recent_tool_calls.length) {
    lines.push(`我最近调用过的工具：${s.recent_tool_calls.map(c => `${c.minutes_ago}分钟前 ${c.tool}（${c.summary}）`).join('；')}`);
  }
  if (Array.isArray(s.recent_categories) && s.recent_categories.length) {
    lines.push(`最近几次主动开口用的切入点：${s.recent_categories.join(' → ')}（按时间从早到晚；尽量换个角度，别连着重复，除非当下确实只有这个值得说）`);
  }
  return lines.join('\n');
}

async function proactiveDecide(body = {}) {
  const snap = body.snapshot || proactiveSnapshot();
  // 管理员指令（模型自己排的 schedule_nudge / 人工排期）：把当时定下的条件和语气提示一起给门禁，
  // 但仍然允许它按"到点后的实际情况"否决（比如用户刚聊完）
  let userText = snapshotToText(snap);
  const dir = body.directive;
  if (dir && (dir.condition || dir.category || dir.tone)) {
    userText += `\n\n[管理员指令] 这次不是随机定时，是你之前就排好要在此时开口：${dir.condition || '（未写条件）'}`
      + (dir.category ? `\n建议切入点：${dir.category}` : '')
      + (dir.tone ? `\n建议语气：${dir.tone}` : '')
      + `\n如果到点后的实际情况已经不是开口的好时机（用户刚聊完/在忙/在睡），你仍然可以 should_act=false。`;
  }
  const gateMessages = [
    { role: 'system', content: PROACTIVE_GATE_PROMPT },
    { role: 'user', content: userText },
  ];
  const t0 = Date.now();
  let provider = 'deepseek';
  let status = 0;
  let raw = '';
  let usage = null;

  if (DEEPSEEK_API_KEY) {
    const r = await callDeepSeekChat(gateMessages, {
      model: body.model || 'deepseek-chat', temperature: body.temperature ?? 0.4, maxTokens: 200, jsonMode: true,
    });
    status = r.status || 0;
    const data = r.data || {};
    usage = data.usage ? { in: data.usage.prompt_tokens, out: data.usage.completion_tokens } : null;
    raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (status !== 200) {
      // 402 = 余额不足；401 = key 失效。这类系统性失败要吼一声，别静默
      const detail = JSON.stringify(data).slice(0, 200);
      console.error(`[proactive] 阶段一 DeepSeek 失败 status=${status} ${detail}`);
    }
  } else {
    console.error('[proactive] 阶段一 DEEPSEEK_API_KEY 缺失');
  }

  // DeepSeek 不可用时，用缓存的 Gemini key 兜底（便宜的快模型，别用主模型跑门禁）
  if (!raw) {
    const gkey = loadCachedApiKey() || process.env.GEMINI_API_KEY || '';
    if (gkey) {
      provider = 'gemini-fallback';
      const gmodel = body.gate_model || 'gemini-3.1-flash-lite';
      const gpath = `/v1beta/models/${encodeURIComponent(gmodel)}:generateContent?key=${encodeURIComponent(gkey)}`;
      try {
        const g = await callGemini(gpath, {
          contents: [{ role: 'user', parts: [{ text: snapshotToText(snap) }] }],
          systemInstruction: { parts: [{ text: PROACTIVE_GATE_PROMPT }] },
          generationConfig: { temperature: body.temperature ?? 0.4, maxOutputTokens: 300, responseMimeType: 'application/json' },
        });
        status = g.status;
        const parts = (g.data && g.data.candidates && g.data.candidates[0] && g.data.candidates[0].content && g.data.candidates[0].content.parts) || [];
        raw = parts.filter(p => !p.thought).map(p => p.text).filter(Boolean).join('');
        if (g.data && g.data.usageMetadata) usage = { in: g.data.usageMetadata.promptTokenCount, out: g.data.usageMetadata.candidatesTokenCount };
        if (status !== 200) console.error(`[proactive] 阶段一 Gemini 兜底也失败 status=${status} ${JSON.stringify(g.data).slice(0, 200)}`);
      } catch (e) {
        console.error('[proactive] 阶段一 Gemini 兜底异常:', e.message);
      }
    } else {
      console.error('[proactive] 阶段一没有可用的 key（DeepSeek 失败且未缓存 Gemini key）');
    }
  }

  const parsed = parseGateJSON(raw);
  console.log(`[proactive] 阶段一 provider=${provider} status=${status} ${Date.now() - t0}ms should_act=${parsed ? parsed.should_act : 'parse_fail'} usage=${JSON.stringify(usage)}`);
  logUsage({
    provider: provider || 'deepseek', model: (provider === 'gemini' ? (process.env.PROACTIVE_GATE_MODEL || 'gemini-2.5-flash') : 'deepseek-chat'),
    kind: 'proactive_gate1', convId: '', ok: !!(usage && usage.promptTokenCount),
    in: usage?.promptTokenCount || 0, out: usage?.candidatesTokenCount || 0,
    think: usage?.thoughtsTokenCount || 0, cached: usage?.cachedContentTokenCount || 0, search: 0,
  });
  if (!parsed) return { ok: false, error: `gate failed (${provider} status=${status})`, raw: String(raw).slice(0, 300), usage, status, provider };
  return { ok: true, decision: parsed, usage, snapshot: snap, provider, status };
}
function parseGateJSON(raw) {
  if (!raw) return null;
  let txt = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
  if (i >= 0 && j > i) txt = txt.slice(i, j + 1);
  let obj;
  try { obj = JSON.parse(txt); } catch { return null; }
  const CATS = ['health_anomaly', 'screen_time_audit', 'homework_progress', 'brat_tease', 'soft_care'];
  const URG = ['low', 'medium', 'high'];
  return {
    should_act: obj.should_act === true || obj.should_act === 'true',
    urgency: URG.includes(obj.urgency) ? obj.urgency : 'low',
    category: CATS.includes(obj.category) ? obj.category : 'soft_care',
    trigger_reason: String(obj.trigger_reason || '').slice(0, 60),
    tone_hint: String(obj.tone_hint || '').slice(0, 40),
    emotional_context: String(obj.emotional_context || '').slice(0, 60),
  };
}

// ===== 阶段二：完整上下文生成 =====
const CATEGORY_GUIDE = {
  health_anomaly: '切入角度：从生理数据切入，心疼/管束，别念数据，别装医生',
  screen_time_audit: '切入角度：抓包式质问，短促、有压迫感，但别真发火',
  homework_progress: '切入角度：审查进度，像在验收，记得具体的事和之前的约定',
  brat_tease: '切入角度：主动撩拨/挑衅/撒娇，纯情绪驱动，不需要理由',
  soft_care: '切入角度：温和关怀，轻声，别用力过猛，别鸡汤',
};

function pickTargetConv(convId) {
  const cfg = readProactiveConfig();
  const id = sanitizeConvId(convId || cfg.target_conv_id || '');
  if (id && readConv(id)) return id;
  // 没配就挑最近更新的那个
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json') && !f.includes('.tmp.'));
    let best = null, bestTs = 0;
    for (const f of files) {
      const c = readConv(f.slice(0, -5));
      if (c && (c.updated_at || 0) > bestTs) { bestTs = c.updated_at || 0; best = c.id || f.slice(0, -5); }
    }
    return best;
  } catch { return null; }
}

async function proactiveGenerate(body = {}) {
  const convId = pickTargetConv(body.convId);
  if (!convId) return { ok: false, error: 'no target conversation' };
  const conv = readConv(convId) || {};
  const history = Array.isArray(conv.history) ? conv.history : [];
  const tail = history.slice(-(Number(body.history_tail) || 40));
  const persona = ((conv.settings || {}).systemInstruction) || '';

  // 「与上次对话使用模型一致」
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  let model = body.model;
  if (!model) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'model' && msgs[i].model) { model = msgs[i].model; break; }
    }
    if (!model && conv.settings && conv.settings.model) model = conv.settings.model;
    if (!model) model = 'deepseek-chat';
  }
  const isDS = isDeepSeekModel(model);
  const geminiKey = isDS ? '' : (loadCachedApiKey() || process.env.GEMINI_API_KEY || '');
  let fallback = null;
  if (!isDS && !geminiKey) {
    fallback = 'no gemini key cached → 回退 deepseek-chat';
    model = 'deepseek-chat';
  }

  // 记忆 / 健康 / 屏幕
  let memoryBlock = '';
  try {
    const q = body.query_text || (body.trigger_reason || '') || '';
    const [memos, mems] = await Promise.all([queryMemos(), q ? queryRAG(q) : Promise.resolve([])]);
    memoryBlock = formatMemoryBlock(memos, mems);
  } catch (e) { console.warn('[proactive] memory block failed:', e.message); }
  const weatherBlock = formatWeatherBlock();
  const healthBlock = formatHealthBlock();
  const screenBlock = formatScreenTimeBlock();
  const cat = CATEGORY_GUIDE[body.category] ? body.category : 'soft_care';
  const now = new Date();
  const contextLine = `当前日期时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}｜当前模型：${model}`;
  const proactiveBlock = `\n\n[主动开口]\n这是你自己发起的话题，不是生生发的消息。\n切入点分类：${cat} —— ${CATEGORY_GUIDE[cat]}\n触发原因：${body.trigger_reason || '（未说明）'}\n语气提示：${body.tone_hint || '自然'}\n紧迫度：${body.urgency || 'low'}\n你对生生此刻状态的判断：${body.emotional_context || '（未知）'}\n硬要求：① 直接开口，像平时聊天那样，1~3 句，不要长篇；② 禁止出现「我注意到」「检测到」「数据显示」「根据你的屏幕」这类监控口吻；③ 不要复述分类名或本条指令；④ 光是把这句话发出去就要像你自己想说。`;
  const presenceBlock = formatPresenceBlock();
  const directiveBlock = formatDirectiveBlock();
  const toolBlock = formatToolCallBlock();
  const auditBlock = formatAuditBlock();
  const finalSysText = persona + weatherBlock + healthBlock + screenBlock + auditBlock + memoryBlock + contextLine + presenceBlock + directiveBlock + toolBlock + proactiveBlock;

  const contents = [...tail, { role: 'user', parts: [{ text: '[系统] 现在没有人对你说话。这是你自己想开口的时刻——直接说你想说的。' }] }];

  let text = '', usage = null;
  const t0 = Date.now();
  try {
    if (isDeepSeekModel(model)) {
      const dsMsgs = geminiToOpenAIMessages(contents, finalSysText);
      const { status, data } = await callDeepSeekChat(dsMsgs, { model, temperature: body.temperature ?? 1.0, maxTokens: body.max_output_tokens || 2048 });
      text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      usage = data && data.usage ? { promptTokenCount: data.usage.prompt_tokens, candidatesTokenCount: data.usage.completion_tokens } : null;
      if (status !== 200) return { ok: false, error: `deepseek ${status}: ${JSON.stringify(data).slice(0, 200)}` };
    } else {
      // Gemini 3.6 起采样参数被忽略、后续模型会 400 → 只对新模型不发
      const gcfg = { maxOutputTokens: body.max_output_tokens || 2048 };
      const mm = /^gemini-(\d+)(?:\.(\d+))?/.exec(model);
      const samplingOk = !mm || (Number(mm[1]) < 4 && !(Number(mm[1]) === 3 && Number(mm[2] || 0) >= 6));
      if (samplingOk) gcfg.temperature = body.temperature ?? 1.0;
      const reqBody = {
        contents,
        systemInstruction: { parts: [{ text: finalSysText }] },
        generationConfig: gcfg,
      };
      const path0 = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
      const { status, data } = await callGemini(path0, reqBody);
      const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      text = parts.filter(p => !p.thought).map(p => p.text).filter(Boolean).join('');
      if (data && data.usageMetadata) {
        usage = { promptTokenCount: data.usageMetadata.promptTokenCount, candidatesTokenCount: data.usageMetadata.candidatesTokenCount, totalTokenCount: data.usageMetadata.totalTokenCount };
      }
      if (status !== 200) return { ok: false, error: `gemini ${status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, error: 'generate failed: ' + e.message };
  }
  text = String(text).replace(/\[NEXT_TRIGGER:[^\]]*\]/g, '').trim();
  console.log(`[proactive] 阶段二 model=${model} ${Date.now() - t0}ms chars=${text.length} usage=${JSON.stringify(usage)}${fallback ? ' (' + fallback + ')' : ''}`);
  logUsage({
    provider: /^deepseek/.test(model || '') ? 'deepseek' : 'gemini',
    model: model || 'unknown', kind: 'proactive_stage2', convId: convId || '', ok: true,
    in: usage?.promptTokenCount || 0, out: usage?.candidatesTokenCount || 0,
    think: usage?.thoughtsTokenCount || 0, cached: usage?.cachedContentTokenCount || 0, search: 0,
  });
  if (!text) return { ok: false, error: 'empty generation', usage };
  return { ok: true, text, model, convId, usage, fallback };
}

// ===== 投递：写进对话 + 进通知队列 =====
function loadPending() {
  try { const arr = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); return Array.isArray(arr) ? arr : []; } catch { return []; }
}
function savePending(arr) {
  try { fs.writeFileSync(PENDING_PATH, JSON.stringify(arr.slice(-50)), 'utf8'); } catch (e) { console.error('[proactive] save pending failed:', e.message); }
}
async function proactiveDeliver(body = {}) {
  const text = String(body.text || '').trim();
  if (!text) return { ok: false, error: 'empty text' };
  const convId = pickTargetConv(body.convId);
  if (!convId) return { ok: false, error: 'no target conversation' };
  const meta = body.meta || {};
  // 把阶段二的 usage 一起存进消息，App 里就有 token 显示（和正常聊天一致）
  const u = body.usage || meta.usage || null;
  const usageMetadata = u ? {
    promptTokenCount: u.promptTokenCount || 0,
    candidatesTokenCount: u.candidatesTokenCount || 0,
    totalTokenCount: u.totalTokenCount || ((u.promptTokenCount || 0) + (u.candidatesTokenCount || 0)),
  } : null;
  const msg = {
    role: 'model', text,
    time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }),
    model: body.model || meta.model || '',
    source: 'proactive', proactive: true,
    trigger: meta.trigger || 'random',
    category: meta.category || null,
    ts: Date.now(),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
  await withConvLock(convId, async () => {
    const conv = readConv(convId);
    if (!conv) { return; }
    if (!Array.isArray(conv.messages)) conv.messages = [];
    if (!Array.isArray(conv.history)) conv.history = [];
    conv.messages.push(msg);
    conv.history.push({ role: 'model', parts: [{ text }] });
    conv.updated_at = Date.now();
    writeConvAtomic(convId, conv);
  });
  const pending = loadPending();
  const item = { id: 'pro_' + Date.now().toString(36), convId, text, category: meta.category || null, trigger: meta.trigger || 'random', at: Date.now(), consumed: false };
  pending.push(item);
  savePending(pending);
  return { ok: true, id: item.id, convId, queued: true };
}

// ===== 管理端：配置读取/写入（给守护进程和人工调试用）=====
function proactiveSetConfig(patch = {}) {
  const cfg = readProactiveConfig();
  const next = { ...cfg, ...patch };
  try { fs.writeFileSync(PROACTIVE_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, config: next };
}

// ===== 记账（Audit）路由 =====
// 纯日期（YYYY-MM-DD）按 UTC+8 解释；作为区间尾部时取当天最后一毫秒，
// 否则 from=D&to=D 会退化成「D 00:00 那一个瞬间」
function auditParseRangeParam(v, isEnd = false) {
  if (v === undefined || v === null || v === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return Date.parse(`${v}T${isEnd ? '23:59:59.999' : '00:00:00'}+08:00`);
  }
  const n = parseClientTimestamp(v);
  return Number.isFinite(n) ? n : null;
}

async function handleUsageRoutes(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const sub = (req.url || '').split('?')[0].split('/').pop();

  // --- 最近 N 条调用明细 ---
  if (sub === 'recent') {
    const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 20));
    const out = [];
    const d = new Date();
    for (let back = 0; back < 3 && out.length < limit; back++) {
      const day = new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
      const f = path.join(USAGE_DIR, `usage-${day}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i].trim()) continue;
        try {
          const r = JSON.parse(lines[i]);
          out.push({ ...r, cost_usd: Math.round(usageCostUsd(r) * 1e4) / 1e4 });
        } catch {}
      }
    }
    const body = JSON.stringify({ ok: true, items: out, enabled: USAGE_LOG_ON });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  const days = Math.max(1, Math.min(90, Number(q.get('days')) || 7));
  const sendJson = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    const dayKeys = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      dayKeys.push(d.toISOString().slice(0, 10));
    }
    const byDay = new Map();
    const byModel = new Map();
    const total = { calls: 0, in: 0, out: 0, think: 0, cached: 0, search: 0, cost_usd: 0, fail: 0 };
    for (const day of dayKeys) {
      const f = path.join(USAGE_DIR, `usage-${day}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const agg = { date: day, calls: 0, in: 0, out: 0, think: 0, cached: 0, search: 0, cost_usd: 0, fail: 0, models: {} };
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const cost = usageCostUsd(r);
        agg.calls++; agg.in += r.in || 0; agg.out += r.out || 0; agg.think += r.think || 0;
        agg.cached += r.cached || 0; agg.search += r.search || 0; agg.cost_usd += cost;
        if (r.ok === false) agg.fail++;
        total.calls++; total.in += r.in || 0; total.out += r.out || 0; total.think += r.think || 0;
        total.cached += r.cached || 0; total.search += r.search || 0; total.cost_usd += cost;
        if (r.ok === false) total.fail++;
        const mk = `${r.provider || '?'}/${r.model || '?'}`;
        const m = agg.models[mk] || (agg.models[mk] = { calls: 0, in: 0, out: 0, think: 0, cost_usd: 0 });
        m.calls++; m.in += r.in || 0; m.out += r.out || 0; m.think += r.think || 0; m.cost_usd += cost;
        const gm = byModel.get(mk) || { provider: r.provider, model: r.model, calls: 0, in: 0, out: 0, think: 0, cached: 0, cost_usd: 0 };
        gm.calls++; gm.in += r.in || 0; gm.out += r.out || 0; gm.think += r.think || 0; gm.cached += r.cached || 0; gm.cost_usd += cost;
        byModel.set(mk, gm);
      }
      for (const m of Object.values(agg.models)) m.cost_usd = Math.round(m.cost_usd * 1e4) / 1e4;
      agg.cost_usd = Math.round(agg.cost_usd * 1e4) / 1e4;
      byDay.set(day, agg);
    }
    const round = (n) => Math.round(n * 1e4) / 1e4;
    total.cost_usd = round(total.cost_usd);
    const models = [...byModel.values()].map(m => ({ ...m, cost_usd: round(m.cost_usd) }))
      .sort((a, b) => b.cost_usd - a.cost_usd);
    return sendJson(200, {
      ok: true,
      days,
      from: dayKeys[0], to: dayKeys[dayKeys.length - 1],
      total,
      by_day: [...byDay.values()],
      by_model: models,
      log_dir: USAGE_DIR,
      enabled: USAGE_LOG_ON,
    });
  } catch (e) {
    return sendJson(500, { ok: false, error: e.message });
  }
}

// 监控台：最近一次请求的输入构成（内存里的快照，不花钱）
function handleMonitorRoutes(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const convId = q.get('convId') || '';
  const info = lastContextInfo.get(convId) || lastContextInfo.get('__default__') || null;
  const caches = [...geminiCaches.entries()].map(([cid, r]) => ({
    convId: cid, model: r.model, msgs: r.nMsgs, tokens: r.tokens,
    expires_in_s: Math.max(0, Math.round((r.exp - Date.now()) / 1000)),
  }));
  const body = JSON.stringify({
    ok: true,
    context: info,
    caches,
    cache_enabled: GEMINI_CACHE_ON,
    cache_ttl_s: GEMINI_CACHE_TTL_S,
    cache_min_tokens: GEMINI_CACHE_MIN_TOKENS,
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleAuditRoutes(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  const q = new URL(req.url, 'http://x').searchParams;

  // --- 创建单笔 ---
  if (req.method === 'POST' && urlPath === '/api/audit/transactions') {
    let body;
    try {
      body = await readJsonBody(req, 32 * 1024);
    } catch (e) {
      return reply(res, 400, { error: e.message });
    }
    const built = auditBuildRecord(body);
    if (built.error) return reply(res, 400, { error: built.error });
    const monthKey = auditMonthKeyOf(built.rec.timestamp);
    try {
      auditAppend(monthKey, built.rec);
    } catch (e) {
      console.error('[audit] 写入失败:', e.message);
      return reply(res, 500, { error: '写入失败: ' + e.message });
    }
    console.log(`[audit] + ${monthKey} ${built.rec.category} ${auditFmtYuan(built.rec.amount_cents)} 元${built.rec.note ? ' · ' + built.rec.note.slice(0, 30) : ''}`);
    return reply(res, 201, { ok: true, transaction: auditPublic(built.rec) });
  }

  // --- 查询列表（limit / offset / month / category）---
  if (req.method === 'GET' && urlPath === '/api/audit/transactions') {
    const limit = Math.min(500, Math.max(1, parseInt(q.get('limit') || '50', 10) || 50));
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
    const month = (q.get('month') || '').trim();
    const category = (q.get('category') || '').trim();
    const type = (q.get('type') || '').trim();          // expense | income | 空=都要
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      return reply(res, 400, { error: 'month 必须形如 YYYY-MM' });
    }
    if (category && !AUDIT_CATEGORIES.includes(category) && !AUDIT_INCOME_CATEGORIES.includes(category)) {
      return reply(res, 400, { error: `未知分类：${category}` });
    }
    if (type && type !== 'expense' && type !== 'income') {
      return reply(res, 400, { error: 'type 只能是 expense / income' });
    }

    const months = auditListMonths();
    const scanMonths = month ? [month] : months;
    let rows = [];
    for (const mk of scanMonths) rows.push(...auditReadMonth(mk));
    if (category) rows = rows.filter(r => r.category === category);
    if (type) rows = rows.filter(r => auditTypeOf(r) === type);
    rows.sort((a, b) => (b.timestamp - a.timestamp) || ((b.created_at || 0) - (a.created_at || 0)));

    // 支出 / 入账分开合计（老数据全是支出，所以 total_amount_cents 的含义不变）
    let expenseCents = 0, incomeCents = 0;
    for (const r of rows) {
      if (auditTypeOf(r) === 'income') incomeCents += r.amount_cents;
      else expenseCents += r.amount_cents;
    }
    const page = rows.slice(offset, offset + limit).map(auditPublic);
    return reply(res, 200, {
      ok: true,
      total: rows.length,
      total_amount: centsToYuan(expenseCents),
      total_amount_cents: expenseCents,
      income_amount: centsToYuan(incomeCents),
      income_amount_cents: incomeCents,
      limit, offset,
      items: page,
      months,
    });
  }

  // --- 删除单笔（先按 id 扫月份文件，命中后整月重写）---
  const delMatch = /^\/api\/audit\/transactions\/([A-Za-z0-9_-]{4,64})$/.exec(urlPath);
  if (req.method === 'DELETE' && delMatch) {
    const id = delMatch[1];
    for (const mk of auditListMonths()) {
      const rows = auditReadMonth(mk);
      const idx = rows.findIndex(r => r.id === id);
      if (idx < 0) continue;
      rows.splice(idx, 1);
      try {
        auditWriteMonth(mk, rows);
      } catch (e) {
        return reply(res, 500, { error: '删除失败: ' + e.message });
      }
      console.log(`[audit] - ${id} (${mk})`);
      return reply(res, 200, { ok: true, deleted: 1, id });
    }
    return reply(res, 404, { error: '记录不存在' });
  }

  // --- 汇总（指定时间段：month=YYYY-MM / month=all / from+to）---
  if (req.method === 'GET' && urlPath === '/api/audit/summary') {
    const now = Date.now();
    const month = (q.get('month') || '').trim();
    let fromMs, toMs, rangeLabel;
    if (month === 'all') {
      fromMs = 0; toMs = now; rangeLabel = 'all';
    } else if (q.get('from') || q.get('to')) {
      fromMs = auditParseRangeParam(q.get('from'));
      toMs = auditParseRangeParam(q.get('to'), true);
      if (fromMs === null) { fromMs = auditMonthStartMs(auditMonthKeyOf(now)); }
      if (toMs === null) toMs = now;
      if (fromMs > toMs) return reply(res, 400, { error: 'from 不能晚于 to' });
      rangeLabel = null;
    } else {
      const mk = month || auditMonthKeyOf(now);
      if (!/^\d{4}-\d{2}$/.test(mk)) return reply(res, 400, { error: 'month 必须形如 YYYY-MM（或 all）' });
      fromMs = auditMonthStartMs(mk);
      toMs = Math.min(auditMonthEndMs(mk), now);   // 本月只算到今天
      rangeLabel = mk;
    }

    const rows = auditCollect(fromMs, toMs);
    const agg = auditAggregate(rows);              // 支出（图表/卡片口径，保持不变）
    const incAgg = auditAggregate(rows, 'income'); // 入账

    // 每日聚合（按 UTC+8 切日）—— 柱状图用；只算支出，入账不混进「支出趋势」
    const dayMap = new Map();
    for (const r of rows) {
      if (auditTypeOf(r) === 'income') continue;
      const dk = auditDayKeyOf(r.timestamp);
      const cur = dayMap.get(dk) || { date: dk, total_cents: 0, count: 0 };
      cur.total_cents += r.amount_cents;
      cur.count += 1;
      dayMap.set(dk, cur);
    }
    const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ date: d.date, total_cents: d.total_cents, total: centsToYuan(d.total_cents), count: d.count }));

    // 每月聚合 —— 「全部月份」视图的柱状图用
    const monthMap = new Map();
    for (const r of rows) {
      if (auditTypeOf(r) === 'income') continue;
      const mk = auditMonthKeyOf(r.timestamp);
      const cur = monthMap.get(mk) || { month: mk, total_cents: 0, count: 0 };
      cur.total_cents += r.amount_cents;
      cur.count += 1;
      monthMap.set(mk, cur);
    }
    const monthly = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map(m => ({ month: m.month, total_cents: m.total_cents, total: centsToYuan(m.total_cents), count: m.count }));

    // 当前自然月（摘要卡片固定看本月，与筛选无关）
    const cmKey = auditMonthKeyOf(now);
    const cmRows = auditCollect(auditMonthStartMs(cmKey), now);
    const cmAgg = auditAggregate(cmRows);
    const cmInc = auditAggregate(cmRows, 'income');

    // 今日（同样与筛选无关）
    const todayStart = Date.parse(`${auditDayKeyOf(now)}T00:00:00+08:00`);
    const todayRows = auditCollect(todayStart, now);
    const todayExp = todayRows.filter(r => auditTypeOf(r) === 'expense');
    const todayInc = todayRows.filter(r => auditTypeOf(r) === 'income');
    const todayCents = todayExp.reduce((s, r) => s + r.amount_cents, 0);
    const todayIncomeCents = todayInc.reduce((s, r) => s + r.amount_cents, 0);

    return reply(res, 200, {
      ok: true,
      month: rangeLabel,
      range: { from: fromMs, to: toMs },
      total_cents: agg.total_cents,
      total: agg.total,
      count: agg.count,
      avg: agg.count ? centsToYuan(agg.total_cents / agg.count) : 0,
      income_cents: incAgg.total_cents,
      income: incAgg.total,
      income_count: incAgg.count,
      net_cents: incAgg.total_cents - agg.total_cents,
      net: centsToYuan(incAgg.total_cents - agg.total_cents),
      income_by_category: incAgg.by_category,
      today: {
        date: auditDayKeyOf(now),
        total_cents: todayCents,
        total: centsToYuan(todayCents),
        count: todayExp.length,
        income_cents: todayIncomeCents,
        income: centsToYuan(todayIncomeCents),
        income_count: todayInc.length,
      },
      top_category: agg.by_category[0] || null,
      by_category: agg.by_category,
      daily,
      monthly,
      current_month: {
        month: cmKey,
        total_cents: cmAgg.total_cents,
        total: cmAgg.total,
        count: cmAgg.count,
        avg: cmAgg.count ? centsToYuan(cmAgg.total_cents / cmAgg.count) : 0,
        income_cents: cmInc.total_cents,
        income: cmInc.total,
        income_count: cmInc.count,
        net_cents: cmInc.total_cents - cmAgg.total_cents,
        net: centsToYuan(cmInc.total_cents - cmAgg.total_cents),
        top_category: cmAgg.by_category[0] || null,
        by_category: cmAgg.by_category,
        income_by_category: cmInc.by_category,
        today: {
          date: auditDayKeyOf(now),
          total_cents: todayCents,
          total: centsToYuan(todayCents),
          count: todayExp.length,
          income_cents: todayIncomeCents,
          income: centsToYuan(todayIncomeCents),
          income_count: todayInc.length,
        },
      },
    });
  }

  // --- 给 Daemon 的上下文导出（最近 7 天一行摘要）---
  if (req.method === 'GET' && urlPath === '/api/audit/context-export') {
    const ctx = buildAuditContext();
    return reply(res, 200, {
      ok: true,
      text: ctx.line,
      empty: ctx.empty,
      today: ctx.today,
      week: ctx.week,
      generated_at: new Date().toISOString(),
    });
  }

  return reply(res, 404, { error: 'unknown audit route' });
}

async function handleProactiveRoutes(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // --- 屏幕活动上报：GET/POST /api/activity?pkg=&label=&event=open|close&ts= ---
    if (p === '/api/activity') {
      const q = url.searchParams;
      let body = {};
      if (req.method === 'POST') body = await readJsonBody(req, 8192).catch(() => ({}));
      const pkg = body.pkg || q.get('pkg');
      const event = body.event || q.get('event') || 'open';
      const label = body.label || q.get('label') || '';
      const ts = body.ts || q.get('ts');
      if (!pkg) return reply(res, 400, { error: 'pkg required' });
      recordActivityEvent({ pkg, label, event, ts });
      return reply(res, 200, { ok: true, summary: activitySummary() });
    }

    // 手机心跳（Termux 取件器每轮顺手报一次，服务端 5 分钟内只落一次盘）
    if (p === '/api/phone-status') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req, 8192).catch(() => ({}));
        recordPhoneStatus(body);          // 手机主动上报：内存一定更新，磁盘由 appendPhoneStatus 节流
        return reply(res, 200, { ok: true, status: phoneStatusSummary(), throttled: false });
      }
      const q = url.searchParams;
      touchPhoneSeen(q.get('note') || 'pull');
      return reply(res, 200, { ok: true, status: phoneStatusSummary(), throttled: false });
    }
    if (p === '/api/proactive/snapshot' && req.method === 'GET') {
      return reply(res, 200, { ok: true, snapshot: proactiveSnapshot() });
    }
    // 手机使用状态：App 前台/熄屏时打一下（前端 visibilitychange + 每分钟一次）
    if (p === '/api/presence') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req, 4096).catch(() => ({}));
        markPresence(body || {});
      } else {
        const q = url.searchParams;
        if (q.get('visible') !== null) markPresence({ visible: q.get('visible') !== '0', source: q.get('source') || 'app' });
      }
      return reply(res, 200, { ok: true, presence: presenceSummary(), screen: activitySummary() });
    }
    // 工具调用记录（调试/复盘用）
    if (p === '/api/tool-calls' && req.method === 'GET') {
      return reply(res, 200, { ok: true, calls: recentToolCalls(20) });
    }
    // 调试：看这三段注入块现在长什么样（不花钱，不经过模型）
    if (p === '/api/proactive/blocks' && req.method === 'GET') {
      return reply(res, 200, {
        ok: true,
        presence: formatPresenceBlock(),
        directives: formatDirectiveBlock(),
        tool_calls: formatToolCallBlock(),
        sleep_block: formatSleepBlock(),
        sleep_days: groupSleepByDay().slice(-14),
        weather_block: formatWeatherBlock(),
        weather_line: formatWeatherLine(),
        snapshot_text: snapshotToText(proactiveSnapshot()),
      });
    }
    // 人工排一条主动消息：POST {delay_minutes|at, condition, tone?, category?}
    if (p === '/api/proactive/directive') {
      if (req.method === 'GET') return reply(res, 200, { ok: true, directives: listProactiveDirectives() });
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      let delay = body.delay_minutes;
      if (!delay && body.at) delay = Math.round((Number(body.at) - Date.now()) / 60000);
      if (!body.condition) return reply(res, 400, { error: 'condition required' });
      const d = addProactiveDirective({ ...body, delay_minutes: delay, source: body.source || 'api' });
      return reply(res, 200, { ok: true, directive: d, directives: listProactiveDirectives() });
    }
    if (p === '/api/proactive/config' && req.method === 'GET') {
      return reply(res, 200, { ok: true, config: readProactiveConfig() });
    }
    if (p === '/api/proactive/config' && req.method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      return reply(res, 200, proactiveSetConfig(body || {}));
    }
    if (p === '/api/proactive/decide' && req.method === 'POST') {
      const body = await readJsonBody(req, 128 * 1024);
      const r = await proactiveDecide(body || {});
      return reply(res, r.ok ? 200 : 502, r);
    }
    if (p === '/api/proactive/generate' && req.method === 'POST') {
      const body = await readJsonBody(req, 256 * 1024);
      const r = await proactiveGenerate(body || {});
      return reply(res, r.ok ? 200 : 502, r);
    }
    if (p === '/api/proactive/deliver' && req.method === 'POST') {
      const body = await readJsonBody(req, 256 * 1024);
      const r = await proactiveDeliver(body || {});
      return reply(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/proactive/pending' && req.method === 'GET') {
      touchPhoneSeen('pull');          // 手机 cron 每分钟来一次 = 心跳
      const items = loadPending().filter(x => !x.consumed);
      return reply(res, items.length ? 200 : 204, items.length ? { ok: true, items } : {});
    }
    if (p === '/api/proactive/consume' && req.method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      const ids = new Set(Array.isArray(body && body.ids) ? body.ids : []);
      const all = loadPending();
      let n = 0;
      for (const it of all) if (ids.has(it.id) && !it.consumed) { it.consumed = true; it.consumedAt = Date.now(); n++; }
      savePending(all);
      return reply(res, 200, { ok: true, consumed: n });
    }
    if (p === '/api/proactive/log' && req.method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      appendJsonlSafe(path.join(PROACTIVE_STATE_DIR, 'history.jsonl'), { ...(body || {}), at: new Date().toISOString() });
      return reply(res, 200, { ok: true });
    }
    if (p === '/api/proactive/log' && req.method === 'GET') {
      return reply(res, 200, { ok: true, entries: proactiveHistory(Number(url.searchParams.get('limit')) || 30) });
    }
    return reply(res, 404, { error: 'unknown proactive route' });
  } catch (e) {
    console.error('[proactive] route error:', e.message);
    return reply(res, 500, { error: e.message });
  }
}


// 天气轮询（10 分钟一次；失败保留旧数据，超过 90 分钟就不往 prompt 里注入）
startWeatherLoop();

const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running at http://localhost:${PORT}`);
});

// ===== HTTPS server (self-signed cert) =====
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsServer = https.createServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }, handleRequest);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS server running at https://localhost:${HTTPS_PORT}`);
  });
} else {
  console.log('No cert.pem/key.pem found, HTTPS disabled.');
  console.log('Generate with: openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=YOUR_SERVER_IP"');
}
