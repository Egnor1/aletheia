// 往待推队列塞一条「通道测试」消息（不写对话），用来验证手机通知链路
// sudo pm2 start /var/www/app/proactive/tools/queue-test-nudge.js --name queue-test --cwd /var/www/app/proactive --no-autorestart
const fs = require('fs');
const path = require('path');
const PENDING = path.join(__dirname, '..', 'state', 'pending.json');

const TEXT = process.argv[2] || '【通道测试】这条只用来验证通知链路，不会进对话。收到就说明取件通了。';
const CAT = process.argv[3] || 'soft_care';

let arr = [];
try { arr = JSON.parse(fs.readFileSync(PENDING, 'utf8')) || []; } catch {}
const item = { id: 'pro_test_' + Date.now().toString(36), convId: null, text: TEXT, category: CAT, trigger: 'test', at: Date.now(), consumed: false };
arr.push(item);
fs.writeFileSync(PENDING, JSON.stringify(arr), 'utf8');
console.log(`已入队 ${item.id}（当前队列未消费 ${arr.filter(x => !x.consumed).length} 条）`);
console.log('手机端跑 ~/proactive_pull.sh 后应该弹出通知；日志里会有「推送 pro_test_...」');
