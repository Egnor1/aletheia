// 一次性运维：查 OOM 记录 + 加 2G swap（VPS 只有 1G 内存，整段 PUT 会打爆）
// sudo pm2 start /var/www/app/proactive/tools/ops-swap.js --name ops-swap --cwd /var/www/app/proactive --no-autorestart
const { execSync } = require('child_process');
const fs = require('fs');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', timeout: 120000 }); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || e.message); } };

console.log('=== 当前内存 ===');
console.log(sh('free -m'));
console.log('=== OOM 记录（最近 5 条）===');
console.log(sh("dmesg -T 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -5") || '(无)');

const SWAP = '/swapfile2';
if (!fs.existsSync(SWAP)) {
  console.log(`=== 创建 ${SWAP} (2G) ===`);
  console.log(sh(`fallocate -l 2G ${SWAP} || dd if=/dev/zero of=${SWAP} bs=1M count=2048`));
  console.log(sh(`chmod 600 ${SWAP} && mkswap ${SWAP}`));
  console.log(sh(`swapon ${SWAP}`));
  let fstab = '';
  try { fstab = fs.readFileSync('/etc/fstab', 'utf8'); } catch {}
  if (!fstab.includes(SWAP)) {
    fs.appendFileSync('/etc/fstab', `${SWAP} none swap sw 0 0\n`);
    console.log('已写入 /etc/fstab（重启后自动挂）');
  }
} else {
  console.log(`${SWAP} 已存在，尝试启用`);
  console.log(sh(`swapon ${SWAP} 2>&1 || true`));
}
console.log('=== 调整 swappiness=20（少换出、只在尖峰时兜底）===');
console.log(sh('sysctl -w vm.swappiness=20'));
sh("grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=20' >> /etc/sysctl.conf");
console.log('=== 完成后内存 ===');
console.log(sh('free -m'));
