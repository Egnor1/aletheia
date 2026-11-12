#!/usr/bin/env node
// ===== 主动消息守护进程（M1 骨架）=====
// 职责：什么时候该考虑开口（调度/断路器/异常/管理员指令/冷却/配额）+ 两阶段漏斗的编排。
// 不负责：人设与记忆的组装（在 server.js 里），也不负责通知投递（Termux 取 pending 队列）。
//
// 用法：
//   node index.js            常驻（默认，每 tick_seconds 一次）
//   node index.js --once     只跑一次 tick（尊重静默/冷却，用来观察）
//   node index.js --force    跑一次 tick，忽略定时器/冷却/静默（仍受总开关与配额约束）
//   node index.js --status   打印状态、配置与最近决策日志
const fs = require('fs');
const path = require('path');

const api = require('./lib/serverapi');
const budget = require('./lib/budget');
const T = require('./triggers');
const { loadState, saveState, appendHistory, readDirectives, writeDirectives } = require('./lib/store');

const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('[proactive] 读不到 config.json:', e.message); process.exit(1); }
}

function ts() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function log(...a) { console.log(`[${ts()}] [proactive]`, ...a); }

let _busy = false;
let _ticks = 0;

async function tick(opts = {}) {
  if (_busy) { log('上一次 tick 还没跑完，跳过'); return { outcome: 'busy' }; }
  _busy = true;
  try { return await runTick(opts); }
  catch (e) { log('tick 异常:', e.message); return { outcome: 'error', error: e.message }; }
  finally { _busy = false; }
}

async function runTick(opts = {}) {
  const cfg = loadConfig();
  const st = loadState();
  const now = Date.now();
  _ticks++;
  const counters = budget.resetDailyCounters(st, now);
  const quota = budget.quotaLeft(cfg, st);

  // 首次启动：先掷一次随机间隔
  if (!st.nextTriggerAt) st.nextTriggerAt = now + budget.rollRandomInterval(cfg);

  const finish = (outcome, extra = {}, logIt = true) => {
    st.lastOutcome = outcome;
    st.lastTickAt = now;
    saveState(st);
    if (logIt) {
      appendHistory({ at: new Date(now).toISOString(), outcome, counters: { ...counters }, quota: { ...quota }, ...extra });
    }
    return { outcome, ...extra };
  };

  // ---------- 0) 熔断后暂停（连续失败，别每 2-6 小时白试一次）----------
  if (st.paused && st.paused.until > now && !opts.force) {
    return finish('paused', { reason: st.paused.reason, until: new Date(st.paused.until).toISOString() }, false);
  }

  // ---------- 1) 全局物理总开关 ----------
  if (!cfg.active_push_enabled) {
    st.nextTriggerAt = 0;                       // 关掉期间不留旧定时，重开时重新掷
    return finish('suspended', {}, opts.verbose && st.lastOutcome !== 'suspended');
  }

  // ---------- 2) 夜间静默断路器：01:30–08:00，零外部 API ----------
  const bo = T.blackoutCheck(now, cfg);
  if (bo && !opts.force) {
    // 只在「刚进入静默」时记一条 + 定好醒来时间，避免每分钟刷日志
    const entering = st.lastOutcome !== 'blackout';
    if (entering) {
      st.nextTriggerAt = bo.wakeAt + budget.rollRandomInterval(cfg);
      log(`进入夜间静默，${new Date(bo.wakeAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 解除`);
    }
    return finish('blackout', { wakeAt: new Date(bo.wakeAt).toISOString() }, entering);
  }

  // ---------- 3) 取环境切片（本地调用，不花钱）----------
  const snapRes = await api.snapshot();
  if (!snapRes || !snapRes.ok) return finish('snapshot_failed', { error: snapRes && snapRes.error }, true);
  const snap = snapRes.snapshot;

  // ---------- 4) 用户主动长聊 → 重置随机定时器 ----------
  if (T.userActivityReset(now, snap, st, cfg)) {
    const next = budget.resetAfterUserActivity(st, cfg, now);
    if (opts.verbose) log(`检测到生生刚说话 → 重置定时器到 ${new Date(next).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  }

  // ---------- 5) 挑一个触发源（管理员指令 > 连击 > 异常 > 随机）----------
  const followup = T.followupCheck(now, cfg, st, snap);
  if (followup && followup.clear) st.awaitingReply = null;

  let trigger = null;
  const directives = readDirectives();
  const dir = T.directiveCheck(now, directives);
  if (dir) {
    directives[dir.index].consumed = true;
    directives[dir.index].consumedAt = new Date(now).toISOString();
    writeDirectives(directives);
    trigger = { source: 'override', reason: dir.reason, tone_hint: dir.tone, category: dir.category, urgency: 'medium' };
    log('管理员指令到点:', dir.reason);
  }
  if (!trigger && followup && !followup.clear) {
    trigger = { source: 'followup', reason: followup.reason, tone_hint: followup.tone, category: followup.category, urgency: 'medium', followup: true };
  }
  if (!trigger) {
    const anomalies = T.anomalyCheck(now, snap, st, cfg);
    if (anomalies.length) {
      const a = anomalies[0];
      st.anomalyLastFired = Object.assign({}, st.anomalyLastFired, { [a.kind]: now });
      trigger = { source: 'anomaly', reason: a.reason, tone_hint: null, category: a.hint, urgency: 'high' };
      log('异常触发:', a.reason);
    }
  }
  if (!trigger && (now >= (st.nextTriggerAt || 0) || opts.force)) {
    trigger = { source: 'random', reason: '随机定时到点', tone_hint: null, category: null, urgency: 'low' };
  }
  if (!trigger) {
    // 心跳：每 30 个 tick（约 30 分钟）记一条 idle，证明还活着、顺便留个下次触发时间
    const beat = !!opts.verbose && _ticks % 30 === 0;
    if (beat) log(`心跳：无事发生，下次候选 ${new Date(st.nextTriggerAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}，今日已用 阶段一${counters.stage1}/阶段二${counters.stage2}/已发${counters.sent}｜冷却至 ${st.cooldownUntil ? new Date(st.cooldownUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'}`);
    return finish('idle', { nextTriggerAt: new Date(st.nextTriggerAt).toISOString(), counters: { ...counters } }, beat);
  }

  // ---------- 6) 冷却 / 配额（便宜的闸门先过）----------
  if (now < (st.cooldownUntil || 0) && !opts.force) {
    return finish('cooldown', { trigger: trigger.source, until: new Date(st.cooldownUntil).toISOString() }, true);
  }
  if (quota.stage1 <= 0 || quota.stage2 <= 0 || quota.delivered <= 0) {
    return finish('quota_exhausted', { trigger: trigger.source, quota }, true);
  }

  // ---------- 7) 阶段一：决策门 ----------
  // 排期指令（模型调用 schedule_nudge / 人工排期）是显式决定，不再让门禁否决 ——
  // 否则会出现"你让我 5 分钟后提醒你，结果它自己判断不需要说"这种反直觉行为。
  // 黑名单时段/冷却/配额仍然照常管着。
  const skipGate = trigger.source === 'override' && cfg.directive_skip_gate !== false;
  let gate = null;
  let d = null;
  if (skipGate) {
    d = {
      should_act: true,
      urgency: 'medium',
      category: trigger.category || 'soft_care',
      trigger_reason: trigger.reason || '排期触发',
      tone_hint: trigger.tone_hint || '自然',
      emotional_context: '（排期触发，未过决策门）',
      _skippedGate: true,
    };
    log(`管理员指令：跳过决策门直接生成（${d.category}）：${d.trigger_reason}`);
  }
  if (!d) {
  gate = await api.decide({
    model: cfg.stage1 && cfg.stage1.model,
    temperature: cfg.stage1 && cfg.stage1.temperature,
    snapshot: snap,
    // 管理员指令额外带上当时排期时定的条件/分类/语气
    directive: trigger.source === 'override'
      ? { condition: trigger.reason, category: trigger.category, tone: trigger.tone_hint }
      : null,
  });
  counters.stage1 = (counters.stage1 || 0) + 1;
  if (!gate || !gate.ok) {
    st.nextTriggerAt = now + budget.rollRandomInterval(cfg);
    // 连续失败熔断：key 失效/余额不足这类系统性故障，别每 2-6 小时白试一次
    st.gateFailStreak = (st.gateFailStreak || 0) + 1;
    const maxStreak = cfg.gate_fail_streak_limit || 3;
    if (st.gateFailStreak >= maxStreak) {
      st.paused = { reason: `阶段一连续失败 ${st.gateFailStreak} 次（最近：${(gate && gate.error) || 'unknown'}）`, until: now + 6 * 3600 * 1000 };
      log(`⚠️ 熔断：${st.paused.reason} → 暂停到 ${new Date(st.paused.until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
    }
    log(`阶段一失败：${(gate && gate.error) || 'no response'}${gate && gate.raw ? ' | raw=' + String(gate.raw).slice(0, 160) : ''}`);
    return finish('gate_failed', { trigger: trigger.source, error: gate && gate.error, raw: gate && gate.raw, usage: gate && gate.usage, provider: gate && gate.provider, streak: st.gateFailStreak }, true);
  }
  st.gateFailStreak = 0;
  if (st.paused) st.paused = null;
  d = gate.decision;
  if (!d.should_act) {
    st.nextTriggerAt = now + budget.rollRandomInterval(cfg);
    log(`阶段一否决（${trigger.source} → ${d.category}）：${d.trigger_reason || '无切入点'}`);
    // 按需求：判定 false 也要留日志，方便复盘"为什么没说话"
    return finish('silent', { trigger: trigger.source, decision: d, usage: gate.usage }, true);
  }
  }  // end if (!d) —— 排期跳过门禁的分支不进这里

  // ---------- 8) 阶段二：装完整上下文生成 ----------
  const gen = await api.generate({
    trigger_reason: d.trigger_reason || trigger.reason,
    tone_hint: d.tone_hint || trigger.tone_hint,
    urgency: d.urgency || trigger.urgency,
    category: d.category,
    emotional_context: d.emotional_context,
    convId: cfg.target_conv_id,
    model: cfg.stage2 && cfg.stage2.model,
    temperature: cfg.stage2 && cfg.stage2.temperature,
    max_output_tokens: trigger.followup ? (cfg.followup.max_output_tokens || 300) : (cfg.stage2 && cfg.stage2.max_output_tokens),
    history_tail: cfg.stage2 && cfg.stage2.history_tail,
  });
  counters.stage2 = (counters.stage2 || 0) + 1;
  if (!gen || !gen.ok) {
    st.nextTriggerAt = now + budget.rollRandomInterval(cfg);
    return finish('generate_failed', { trigger: trigger.source, error: gen && gen.error }, true);
  }

  // ---------- 9) 投递 ----------
  const channel = (cfg.delivery && cfg.delivery.channel) || 'dryrun';
  let delivered;
  if (channel === 'dryrun') {
    log(`[dryrun] 本应发出（${d.category}/${d.urgency}）：${gen.text.slice(0, 100)}`);
    delivered = { ok: true, dryRun: true };
  } else {
    delivered = await api.deliver({
      text: gen.text, model: gen.model, convId: gen.convId, usage: gen.usage,
      meta: { trigger: trigger.source, category: d.category, urgency: d.urgency, emotional_context: d.emotional_context, tone_hint: d.tone_hint, stage1: d },
    });
  }
  if (!delivered || !delivered.ok) {
    st.nextTriggerAt = now + budget.rollRandomInterval(cfg);
    return finish('deliver_failed', { trigger: trigger.source, error: delivered && delivered.error }, true);
  }

  // ---------- 10) 冷却 + 连击安排 ----------
  counters.sent = (counters.sent || 0) + 1;
  st.cooldownUntil = now + (cfg.cooldown_minutes || 90) * 60000;
  const f = cfg.followup || {};
  const cat = d.category;
  st.awaitingReply = (f.enabled && Array.isArray(f.categories) && f.categories.includes(cat))
    ? { at: now, category: cat, used: trigger.followup ? 1 : 0 }
    : null;
  st.nextTriggerAt = now + budget.rollRandomInterval(cfg);

  log(`已发出（${trigger.source}/${cat}）：${gen.text.slice(0, 80)}${channel === 'dryrun' ? ' [dryrun]' : ''}`);
  return finish('sent', {
    trigger: trigger.source,
    category: cat,
    urgency: d.urgency,
    text: gen.text.slice(0, 500),
    model: gen.model,
    dryRun: channel === 'dryrun',
    usage: { gate: gate.usage, stage2: gen.usage },
    decision: d,
  }, true);
}

// ---------- CLI ----------
async function main() {
  const args = process.argv.slice(2);
  const { loadEnv } = require('./lib/env');
  const env = loadEnv();
  if (!(process.env.APP_TOKEN || env.APP_TOKEN)) {
    console.error('[proactive] 读不到 APP_TOKEN（应在 /var/www/app/.env 里）。');
    console.error('[proactive] 如果是以 egnor 身份手动运行，.env 是 root 600 读不到 —— 用 pm2（root）跑，或用 APP_TOKEN=xxx 环境变量跑。');
    if (!args.includes('--status')) process.exit(1);
  }
  if (args.includes('--status')) {
    const cfg = loadConfig();
    const st = loadState();
    console.log('配置:', JSON.stringify(cfg, null, 2));
    console.log('状态:', JSON.stringify(st, null, 2));
    const api2 = require('./lib/serverapi');
    const snap = await api2.snapshot();
    console.log('环境切片:', JSON.stringify(snap && snap.snapshot, null, 2));
    process.exit(0);
  }
  if (args.includes('--once') || args.includes('--force')) {
    const r = await tick({ force: args.includes('--force'), verbose: true });
    console.log('结果:', JSON.stringify(r, null, 2));
    process.exit(0);
  }
  // 直接跑阶段二（跳过阶段一），用来试口径/调人设：node index.js --gen brat_tease
  if (args.includes('--gen')) {
    const cfg = loadConfig();
    const i = args.indexOf('--gen');
    const category = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'soft_care';
    const snapRes = await api.snapshot();
    const snap = (snapRes && snapRes.snapshot) || {};
    const gen = await api.generate({
      trigger_reason: '（人工测试：直接跑阶段二）',
      tone_hint: '自然',
      urgency: 'low',
      category,
      emotional_context: '（测试）',
      convId: cfg.target_conv_id,
      model: cfg.stage2 && cfg.stage2.model,
      max_output_tokens: cfg.stage2 && cfg.stage2.max_output_tokens,
      history_tail: cfg.stage2 && cfg.stage2.history_tail,
    });
    console.log('阶段二结果:', JSON.stringify(gen, null, 2));
    process.exit(gen && gen.ok ? 0 : 1);
  }
  const cfg0 = loadConfig();
  const interval = Math.max(15, cfg0.tick_seconds || 60) * 1000;
  log(`守护进程启动，tick=${interval / 1000}s，总开关=${cfg0.active_push_enabled ? 'on' : 'off'}，投递管道=${(cfg0.delivery && cfg0.delivery.channel) || 'dryrun'}`);
  const st0 = loadState();
  if (st0.nextTriggerAt) log('下次候选触发:', new Date(st0.nextTriggerAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  await tick({ verbose: true });      // 启动先跑一次（会补上首次定时）
  // verbose=true 时 idle 每 30 个 tick（约 30 分钟）打一次心跳，方便确认还活着
  setInterval(() => { tick({ verbose: true }).catch(e => log('tick error:', e.message)); }, interval);
}

if (require.main === module) main();
module.exports = { tick, runTick };
