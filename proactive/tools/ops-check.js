// 运维体检：防火墙/封禁/服务状态（root）
// sudo pm2 start /var/www/app/proactive/tools/ops-check.js --name opsc --cwd /var/www/app/proactive --no-autorestart
const { execSync } = require('child_process');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || e.message); } };
console.log('=== ufw ==='); console.log(sh('ufw status verbose 2>&1 | head -20'));
console.log('=== fail2ban ==='); console.log(sh('systemctl is-active fail2ban 2>&1; fail2ban-client status 2>&1 | head -10'));
console.log('=== iptables DROP/REJECT 规则数 ==='); console.log(sh('iptables -L INPUT -n 2>/dev/null | grep -cE "DROP|REJECT"'));
console.log('=== 最近的连接数（按 IP 前 5）==='); console.log(sh("ss -tn state established '( sport = :3443 or sport = :3000 )' 2>/dev/null | awk 'NR>1{print $4}' | cut -d: -f1 | sort | uniq -c | sort -rn | head -5"));
console.log('=== 系统负载/内存 ==='); console.log(sh('uptime; free -m | head -2'));
