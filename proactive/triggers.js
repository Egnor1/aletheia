// 触发源：随机定时 / 夜间静默 / 生理与屏幕异常 / 管理员指令 / 连击追问
const { inWindow, msUntilWindowEnd, localDate } = require('./lib/budget');

// 1) 夜间静默断路器：01:30–08:00 (UTC+8) 强制挂起，不消耗任何外部 API
function blackoutCheck(now, cfg) {
  const b = cfg.blackout || { start: '01:30', end: '08:00' };
  if (!inWindow(now, b.start, b.end)) return null;
  return { reason: 'blackout', wakeAt: now + msUntilWindowEnd(now, b.end), window: b };
}

// 2) 随机定时：到点就触发
function randomCheck(now, st) {
  if (!st.nextTriggerAt || now < st.nextTriggerAt) return null;
  return { source: 'random', reason: 'random_interval' };
}

// 3) 生理与屏幕异常
function anomalyCheck(now, snap, st, cfg) {
  const a = cfg.anomaly || {};
  const out = [];
  const last = st.anomalyLastFired || {};
  const h = (snap && snap.health) || {};
  const sc = (snap && snap.screen) || {};

  // 心率异常：HR ≥ 阈值 且 5min 步数增量 < 阈值（排除运动走路）持续 ≥ N 分钟
  const hrHigh = h.hr != null && h.hr >= (a.hr_high_bpm ?? 110);
  const still = (h.steps_5min ?? 0) < (a.hr_min_delta_steps ?? 50);
  if (hrHigh && still) {
    if (!st.hrAlertSince) st.hrAlertSince = now;
    const sustained = (now - st.hrAlertSince) / 60000 >= (a.hr_sustain_minutes ?? 3);
    const gapOk = now - (last.hr || 0) >= (a.hr_min_gap_minutes ?? 180) * 60000;
    if (sustained && gapOk) out.push({ source: 'anomaly', kind: 'hr', reason: `心率 ${h.hr} 持续偏高且没在动`, hint: 'health_anomaly' });
  } else if (st.hrAlertSince) {
    st.hrAlertSince = 0;
  }

  // 屏幕沉迷：单一 App 连续前台超过阈值（深夜时段阈值放宽 → 只在配置的"安静时段"之外抓包）
  // 两种来源：
  //   macro  —— MacroDroid/Tasker 上报 open/close，能算"此刻正在用多久"（live）
  //   streak —— App 上报的今日累计时长差值反推"这段时间一直在用某个 App"（没有 MacroDroid 时的兜底）
  const quiet = a.screen_quiet_hours ? inWindow(now, a.screen_quiet_hours.start, a.screen_quiet_hours.end) : false;
  const thr = a.screen_single_app_minutes ?? 180;
  const liveMin = sc.current_foreground_minutes || 0;
  const streak = sc.streak || null;
  const streakMin = streak && streak.minutes ? streak.minutes : 0;
  const appName = sc.current_app || (streak && streak.app) || '某个 App';
  const hitMin = Math.max(liveMin, streakMin);
  if (hitMin >= thr && !quiet) {
    const gapOk = now - (last.screen || 0) >= (a.screen_min_gap_minutes ?? 240) * 60000;
    if (gapOk) {
      const how = liveMin >= thr ? `连续前台 ${Math.round(liveMin)} 分钟` : `最近累计 ${Math.round(streakMin)} 分钟`;
      out.push({
        source: 'anomaly', kind: 'screen',
        reason: `${appName} ${how}`,
        hint: 'screen_time_audit',
        detail: { app: appName, minutes: Math.round(hitMin), live: liveMin >= thr, source: liveMin >= thr ? 'macro' : 'usage_delta' },
      });
    }
  }
  return out;
}

// 4) 管理员指令：directives.json 里到点的条目优先于随机数
function directiveCheck(now, directives) {
  const idx = directives.findIndex(d => !d.consumed && d.at && now >= d.at);
  if (idx < 0) return null;
  const d = directives[idx];
  return { index: idx, source: 'override', reason: d.condition || 'admin_override', tone: d.tone || null, category: d.category || null, directive: d };
}

// 5) 连击追问：抓包/质问类发出去后 15 分钟没回复 → 20 分钟后补一次（上限 1 次）
function followupCheck(now, cfg, st, snap) {
  const f = cfg.followup || {};
  if (!f.enabled || !st.awaitingReply) return null;
  const ar = st.awaitingReply;
  if ((ar.used || 0) >= (f.max_times ?? 1)) return null;
  const userReplied = snap && snap.minutes_since_user_msg != null
    && (Date.now() - (snap.minutes_since_user_msg * 60000)) > ar.at;   // 上次用户消息比我们发出去的时间还新 → 回了
  if (userReplied) return { clear: true };
  const noReplyMs = (f.if_no_reply_minutes ?? 15) * 60000;
  const delayMs = (f.delay_minutes ?? 20) * 60000;
  if (now - ar.at >= noReplyMs && now - ar.at >= delayMs) {
    return { source: 'followup', reason: '抓包后没回话，补一句短的', tone: 'brief', category: ar.category, followup: true };
  }
  return null;
}

// 6) 用户主动长聊 → 重置随机定时器
function userActivityReset(now, snap, st, cfg) {
  const mins = snap && snap.minutes_since_user_msg;
  if (mins == null) return false;
  const userTs = now - mins * 60000;
  if (userTs > (st.lastSeenUserTs || 0) + 1000) {
    st.lastSeenUserTs = userTs;
    const active = mins <= (cfg.user_active_reset_minutes ?? 10);
    return active;      // 刚说完话 → 调用方重置 nextTriggerAt
  }
  return false;
}

module.exports = { blackoutCheck, randomCheck, anomalyCheck, directiveCheck, followupCheck, userActivityReset };
