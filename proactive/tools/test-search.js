// 联网搜索（DeepSeek Search API）自检：
//   1) 直接打 /v1/tools/search，验证 key / 余额 / 返回结构
//   2) 走本机 server.js 的 /api/chat/stream 做一次端到端（模型是否真的触发 web_search、sources 是否回传）
// 跑法（一次性，别让 pm2 重启）：
//   sudo pm2 start /var/www/app/proactive/tools/test-search.js --name test-search --cwd /var/www/app/proactive --no-autorestart
//   然后 sudo pm2 logs test-search --nostream --lines 60 ; sudo pm2 delete test-search
const https = require('https');
const http = require('http');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
const DS_KEY = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';
const APP_TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);

function post(urlStr, payload, headers = {}, timeoutMs = 30000) {
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: timeoutMs,
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', e => resolve({ status: 0, raw: 'stream error: ' + e.message }));
    });
    req.on('error', e => resolve({ status: 0, raw: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== 1. /v1/tools/search 直连 ===');
  console.log('DEEPSEEK_API_KEY:', DS_KEY ? `已配置(前缀 ${DS_KEY.slice(0, 6)}…, 长度 ${DS_KEY.length})` : '缺失！');
  if (!DS_KEY) process.exit(1);

  const t0 = Date.now();
  const r = await post('https://api.deepseek.com/v1/tools/search', {
    query: 'DeepSeek 搜索 API 上线',
    count: 5,
    need_content: true,
  }, { Authorization: `Bearer ${DS_KEY}` });
  console.log(`status=${r.status} 耗时=${Date.now() - t0}ms`);
  let data = null;
  try { data = JSON.parse(r.raw); } catch {}
  if (data?.error) console.log('error:', JSON.stringify(data.error));
  const results = data?.results || [];
  console.log('results:', results.length);
  results.slice(0, 3).forEach((x, i) => {
    console.log(`  [${i + 1}] ${x.title} | ${x.url} | content=${(x.content || '').length}字 | summary=${(x.summary || '').length}字 | score=${x.rerank_score} authority=${x.authority}`);
  });

  console.log('\n=== 2. 端到端 /api/chat/stream (model=deepseek-chat, webSearch=true) ===');
  console.log('APP_TOKEN:', APP_TOKEN ? `已配置(长度 ${APP_TOKEN.length})` : '缺失！');
  if (!APP_TOKEN) process.exit(0);

  const t1 = Date.now();
  const streamRes = await post(`http://127.0.0.1:${PORT}/api/chat/stream`, {
    model: 'deepseek-chat',
    webSearch: true,
    contents: [{ role: 'user', parts: [{ text: '搜一下今天有什么 AI 新闻，给我 3 条带链接的。' }] }],
    generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingLevel: 'LOW' } },
    systemInstruction: { parts: [{ text: '' }] },
    contextLine: '当前日期时间：2026-10-21 08:00:00',
  }, { 'X-Auth-Token': APP_TOKEN }, 180000);
  console.log(`status=${streamRes.status} 耗时=${Date.now() - t1}ms`);

  if (streamRes.status !== 200) {
    console.log('body:', streamRes.raw.slice(0, 500));
  } else {
    const events = streamRes.raw.split('\n').filter(l => l.startsWith('data: ')).map(l => {
      try { return JSON.parse(l.slice(6)); } catch { return null; }
    }).filter(Boolean);
    const types = {};
    for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
    console.log('事件统计:', JSON.stringify(types));
    for (const e of events) {
      if (e.type === 'tool_call') console.log('tool_call →', e.tool, e.detail);
      if (e.type === 'search_sources') console.log('search_sources →', e.sources.map(s => `${s.title} (${s.site || '-'})`).join(' | '));
      if (e.type === 'error') console.log('ERROR →', e.message);
    }
    const done = events.find(e => e.type === 'done');
    console.log('done.searchSources:', done?.searchSources ? done.searchSources.length : 0, '条');
    if (done?.searchSources) done.searchSources.slice(0, 3).forEach((s, i) => console.log(`  [${i + 1}] ${s.title} | ${s.url}`));
    const answer = events.filter(e => e.type === 'answer').map(e => e.text).join('');
    console.log('answer 长度:', answer.length);
    console.log('answer 前 300 字:', answer.slice(0, 300).replace(/\n/g, ' '));
  }

  console.log('\n=== 3. 端到端 /api/chat/stream (model=gemini-3.1-pro-preview, webSearch=true) ===');
  let geminiKey = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || '';
  if (!geminiKey) {
    try {
      const fs = require('fs');
      const path = require('path');
      const p = path.join(__dirname, '..', 'state', 'runtime-keys.json');
      geminiKey = (JSON.parse(fs.readFileSync(p, 'utf8')) || {}).gemini || '';
    } catch {}
  }
  console.log('缓存的 Gemini key:', geminiKey ? `有(长度 ${geminiKey.length})` : '无（跳过：需要在 App 里发过一条消息）');
  if (!geminiKey) process.exit(0);

  const t2 = Date.now();
  const gRes = await post(`http://127.0.0.1:${PORT}/api/chat/stream`, {
    apiKey: geminiKey,
    model: 'gemini-3.1-pro-preview',
    webSearch: true,
    contents: [{ role: 'user', parts: [{ text: '搜一下现在日元汇率，用一句话回答并给出链接。' }] }],
    generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } },
    systemInstruction: { parts: [{ text: '' }] },
    contextLine: '当前日期时间：2026-10-21 08:00:00',
  }, { 'X-Auth-Token': APP_TOKEN }, 240000);
  console.log(`status=${gRes.status} 耗时=${Date.now() - t2}ms`);
  if (gRes.status !== 200) {
    console.log('body:', gRes.raw.slice(0, 500));
  } else {
    const gev = gRes.raw.split('\n').filter(l => l.startsWith('data: ')).map(l => {
      try { return JSON.parse(l.slice(6)); } catch { return null; }
    }).filter(Boolean);
    const gtypes = {};
    for (const e of gev) gtypes[e.type] = (gtypes[e.type] || 0) + 1;
    console.log('事件统计:', JSON.stringify(gtypes));
    for (const e of gev) {
      if (e.type === 'tool_call') console.log('tool_call →', e.tool, e.detail);
      if (e.type === 'search_sources') console.log('search_sources →', e.sources.map(s => `${s.title} (${s.site || '-'})`).join(' | '));
      if (e.type === 'error') console.log('ERROR →', e.message);
    }
    const gdone = gev.find(e => e.type === 'done');
    console.log('done.searchSources:', gdone?.searchSources ? gdone.searchSources.length : 0, '条');
    const ganswer = gev.filter(e => e.type === 'answer').map(e => e.text).join('');
    console.log('answer 长度:', ganswer.length);
    console.log('answer 前 300 字:', ganswer.slice(0, 300).replace(/\n/g, ' '));
  }

  console.log('\n=== done ===');
  process.exit(0);
})();
