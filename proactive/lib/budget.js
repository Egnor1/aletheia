// 配额与随机间隔
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// [120, 360] 分钟区间随机
function rollRandomInterval(cfg) {
  const { min, max } = cfg.random_interval_minutes || { min: 120, max: 360 };
  return randInt(min, max) * 60000;
}

// 用户长聊之后重置：把下次触发推到 now + 新随机间隔
function resetAfterUserActivity(st, cfg, now) {
  st.nextTriggerAt = now + rollRandomInterval(cfg);
  return st.nextTriggerAt;
}

function localDate(ts = Date.now()) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function resetDailyCounters(st, now = Date.now()) {
  const today = localDate(now);
  if (!st.dayCounters || st.dayCounters.date !== today) {
    st.dayCounters = { date: today, stage1: 0, stage2: 0, sent: 0 };
  }
  return st.dayCounters;
}

function quotaLeft(cfg, st) {
  const lim = cfg.daily_limits || {};
  const c = st.dayCounters || { stage1: 0, stage2: 0, sent: 0 };
  return {
    stage1: Math.max(0, (lim.stage1_calls ?? 30) - (c.stage1 || 0)),
    stage2: Math.max(0, (lim.stage2_calls ?? 6) - (c.stage2 || 0)),
    delivered: Math.max(0, (lim.delivered ?? 5) - (c.sent || 0)),
  };
}

// "01:30" → 分钟数
function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 夜间静默：支持跨零点（如 23:30–08:00）
function inWindow(now, startStr, endStr) {
  const start = hhmmToMinutes(startStr), end = hhmmToMinutes(endStr);
  if (start == null || end == null) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

// 距离静默结束还有多少毫秒
function msUntilWindowEnd(now, endStr) {
  const end = hhmmToMinutes(endStr);
  if (end == null) return 0;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  let delta = end - cur;
  if (delta <= 0) delta += 24 * 60;
  return (delta + 1) * 60000;
}

module.exports = { randInt, rollRandomInterval, resetAfterUserActivity, localDate, resetDailyCounters, quotaLeft, inWindow, msUntilWindowEnd };
