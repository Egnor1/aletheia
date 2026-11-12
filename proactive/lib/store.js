// 状态与日志持久化：state.json / history.jsonl / directives.json
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'state');
const STATE_PATH = path.join(DIR, 'state.json');
const HISTORY_PATH = path.join(DIR, 'history.jsonl');
const DIRECTIVES_PATH = path.join(DIR, 'directives.json');

try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {}; } catch {}
  return Object.assign({
    nextTriggerAt: 0,
    cooldownUntil: 0,
    dayCounters: { date: '', stage1: 0, stage2: 0, sent: 0 },
    anomalyLastFired: {},
    hrAlertSince: 0,
    lastSeenUserTs: 0,
    awaitingReply: null,
    paused: null,
    gateFailStreak: 0,
    lastOutcome: null,
    lastTickAt: 0,
  }, s);
}

function saveState(s) {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { console.error('[state] save failed:', e.message); }
}

function appendHistory(obj) {
  try { fs.appendFileSync(HISTORY_PATH, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('[state] history append failed:', e.message); }
}

function readDirectives() {
  try {
    const arr = JSON.parse(fs.readFileSync(DIRECTIVES_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeDirectives(arr) {
  try { fs.writeFileSync(DIRECTIVES_PATH, JSON.stringify(arr.slice(-50), null, 2), 'utf8'); } catch {}
}

module.exports = { DIR, loadState, saveState, appendHistory, readDirectives, writeDirectives };
