// 天气模块自检：直接问服务端 /api/weather，打印原始数据 + 注入块 + 过期判定
// sudo pm2 start /var/www/app/proactive/tools/test-weather.js --name test-weather --cwd /var/www/app/proactive --no-autorestart
// sudo pm2 logs test-weather --nostream --lines 60 ; sudo pm2 delete test-weather
const http = require('http');
const { loadEnv } = require('../lib/env');

const env = loadEnv();
const APP_TOKEN = process.env.APP_TOKEN || env.APP_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);

function req(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : '';
    const rq = http.request({
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: {
        'X-Auth-Token': APP_TOKEN,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    }, (r) => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    rq.on('error', e => resolve({ status: 0, body: 'error: ' + e.message }));
    rq.on('timeout', () => { rq.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (payload) rq.write(payload);
    rq.end();
  });
}

(async () => {
  console.log('APP_TOKEN:', APP_TOKEN ? `已配置(${APP_TOKEN.length})` : '缺失');

  // 1) 主动刷一次，确保是新鲜数据
  const r0 = await req('POST', '/api/weather/refresh');
  console.log('\n=== POST /api/weather/refresh ===', 'status=' + r0.status, r0.body.slice(0, 200));

  // 2) 看结果
  const r1 = await req('GET', '/api/weather');
  console.log('\n=== GET /api/weather ===', 'status=' + r1.status);
  let w = null;
  try { w = JSON.parse(r1.body); } catch {}
  if (!w) { console.log(r1.body.slice(0, 300)); process.exit(1); }

  console.log(`fresh=${w.fresh} updated_at=${w.updated_at} age=${w.age_minutes}min error=${w.error || '-'}`);
  (w.cities || []).forEach(c => {
    console.log(`  ${c.name} [${c.time}] ${c.now.temp}℃ 体感${c.now.feels}℃ ${c.now.desc} 湿度${c.now.humidity}% ${c.now.windDir}风${c.now.windKmh}km/h`);
    (c.days || []).slice(0, 2).forEach(d => console.log(`    ${d.date} ${d.tmin}~${d.tmax}℃ ${d.desc} 降水${d.pop}% 日出${(d.sunrise || '').slice(11)} 日落${(d.sunset || '').slice(11)}`));
    console.log(`    未来6小时降水概率: ${(c.hours || []).map(h => `${h.time}=${h.pop}%`).join(' ')}`);
    if (c.aqi) console.log(`    AQI us=${c.aqi.usAqi} pm2.5=${c.aqi.pm25} 等级=${c.aqi.level}`);
  });

  console.log('\n--- line（阶段一决策门用的一行）---');
  console.log(w.line || '(空)');

  console.log('\n--- block（注入 system prompt 的块）---');
  console.log((w.block || '(空)').trim());

  // 3) proactive 注入块里也要能看到
  const r2 = await req('GET', '/api/proactive/blocks');
  console.log('\n=== /api/proactive/blocks ===', 'status=' + r2.status);
  try {
    const b = JSON.parse(r2.body);
    console.log('has weather_block:', !!b.weather_block, '| weather_line:', b.weather_line || '(空)');
    const snapHasWeather = /天气：/.test(b.snapshot_text || '');
    console.log('snapshot_text 里包含天气行:', snapHasWeather);
    if (snapHasWeather) {
      console.log('  ', (b.snapshot_text || '').split('\n').filter(l => l.startsWith('天气：')).join(' / '));
    }
  } catch { console.log(r2.body.slice(0, 200)); }

  // 4) 端到端：真发一条极短 DeepSeek 消息，确认模型确实读到了 [天气] 块（约 ¥0.01）
  if (process.env.SKIP_E2E === '1') { console.log('\n(跳过端到端)'); process.exit(0); }
  console.log('\n=== E2E: 让模型复述它读到的 [天气] 块（model=deepseek-chat）===');
  const convId = 'conv_test_weather_' + Date.now().toString(36);
  const t0 = Date.now();
  const r3 = await req('POST', '/api/chat/stream', {
    model: 'deepseek-chat',
    convId,
    contents: [{ role: 'user', parts: [{ text: '不要按你的人格说话。把你 system prompt 里 [天气] 块的内容原样复述出来，只输出那个块。' }] }],
    generationConfig: { maxOutputTokens: 600, thinkingConfig: { thinkingLevel: 'NONE' } },
    systemInstruction: { parts: [{ text: '这是一次系统自检。' }] },
    contextLine: '当前日期时间：2026-11-01 20:35:00',
  });
  console.log(`status=${r3.status} 耗时=${Date.now() - t0}ms`);
  const events = (r3.body || '').split('\n').filter(l => l.startsWith('data: '))
    .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  const answer = events.filter(e => e.type === 'answer').map(e => e.text).join('');
  console.log('answer 长度:', answer.length);
  console.log('answer:', answer.slice(0, 500).replace(/\n/g, ' | '));
  console.log('→ 含「杭州」:', /杭州/.test(answer), '| 含「降水概率」:', /降水概率/.test(answer), '| 含「[天气]」:', /\[天气\]/.test(answer));

  // 清理临时对话
  try { await req('DELETE', '/api/conversations/' + encodeURIComponent(convId)); } catch {}

  console.log('\n=== done ===');
  process.exit(0);
})();
