#!/data/data/com.termux/files/usr/bin/python
# 加固版健康上报（2026-10-18）
# 相比旧版：flock 防重叠 + 每一步都记日志（能分清"没跑"和"跑但卡住"）+ sqlite busy timeout
import json, subprocess, time, os, sys, sqlite3, fcntl
from datetime import datetime, timedelta

DB = "/storage/emulated/0/Download/Gadgetbridge.db"
URL = os.environ.get("HEALTH_URL", "https://YOUR_SERVER_IP:3443/api/health-realtime")

def _load_token():
    """token 从环境变量或 ~/push_health.env 读，不要硬编码（仓库里不能有凭证）"""
    t = os.environ.get("HEALTH_TOKEN", "").strip()
    if t:
        return t
    for f in (os.path.expanduser("~/push_health.env"),):
        try:
            for line in open(f, encoding="utf-8", errors="ignore"):
                if line.strip().startswith("HEALTH_TOKEN="):
                    return line.split("=", 1)[1].strip()
        except Exception:
            pass
    return ""

TOKEN = _load_token()
if not TOKEN:
    print("缺少 HEALTH_TOKEN：echo 'HEALTH_TOKEN=xxxx' > ~/push_health.env && chmod 600 ~/push_health.env", flush=True)
    sys.exit(2)
LOCK = "/data/data/com.termux/files/home/.push_health.lock"

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def send_intent(action, extras=None):
    cmd = ["am", "broadcast", "-a", action]
    if extras:
        for k, v in extras.items():
            cmd += ["-e", k, v]
    try:
        subprocess.run(cmd, capture_output=True, timeout=5)
        return True
    except subprocess.TimeoutExpired:
        log(f"warn: am {action.split('.')[-1]} 超时（5s）")
        return False
    except Exception as e:
        log(f"warn: am {action.split('.')[-1]} 失败: {e}")
        return False

# --- 防重叠：上一轮还没结束就跳过（卡死时不会堆一堆进程）---
lock_fp = open(LOCK, "w")
try:
    fcntl.flock(lock_fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    # 只记一行，避免日志爆掉
    if int(time.time()) % 300 < 60:
        log("skip: 上一轮还在跑")
    sys.exit(0)

log("start")   # ← 关键：每轮先记一行，日志里没有 start 就是 cron 没触发（被冻结/被杀）

try:
    if not os.path.exists(DB):
        open(DB, "w").close()
    send_intent("nodomain.freeyourgadget.gadgetbridge.command.ACTIVITY_SYNC", {"dataTypesHex": "0x00000081"})
    time.sleep(8)
    send_intent("nodomain.freeyourgadget.gadgetbridge.command.TRIGGER_DATABASE_EXPORT")
    time.sleep(3)
    log("sync/export done")

    if not os.path.exists(DB):
        log("DB not found")
        sys.exit(0)

    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    c = conn.cursor()

    c.execute("SELECT TIMESTAMP, HEART_RATE FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE > 0 ORDER BY TIMESTAMP DESC LIMIT 1")
    row = c.fetchone()
    if not row:
        log("no heart rate data")
        sys.exit(0)
    ts, hr = row
    data = {"timestamp": int(ts) * 1000, "heart_rate": hr}

    c.execute("SELECT SUM(STEPS) FROM XIAOMI_ACTIVITY_SAMPLE WHERE TIMESTAMP > strftime('%s','now','start of day')")
    row = c.fetchone()
    if row and row[0]:
        data["steps"] = row[0]

    c.execute("SELECT STRESS FROM XIAOMI_ACTIVITY_SAMPLE WHERE STRESS > 0 ORDER BY TIMESTAMP DESC LIMIT 1")
    row = c.fetchone()
    if row:
        data["stress"] = row[0]

    c.execute("SELECT SPO2 FROM XIAOMI_ACTIVITY_SAMPLE WHERE SPO2 > 0 ORDER BY TIMESTAMP DESC LIMIT 1")
    row = c.fetchone()
    if row:
        data["spo2"] = row[0]

    today_start_ms = int(datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()) * 1000
    c.execute("SELECT CALORIES FROM XIAOMI_DAILY_SUMMARY_SAMPLE WHERE TIMESTAMP >= ? ORDER BY TIMESTAMP DESC LIMIT 1", (today_start_ms,))
    row = c.fetchone()
    if row and row[0]:
        data["calories"] = row[0]

    yesterday_ms = int((datetime.now() - timedelta(days=1)).timestamp()) * 1000
    c.execute("SELECT TIMESTAMP, TOTAL_DURATION FROM XIAOMI_SLEEP_TIME_SAMPLE WHERE TIMESTAMP > ? ORDER BY TIMESTAMP ASC", (yesterday_ms,))
    segments = [{"start": int(r[0]), "minutes": int(r[1])} for r in c.fetchall() if r[1] and r[1] > 0]
    if segments:
        data["sleep_segments"] = segments
    conn.close()

    # 手表数据有多旧（服务端/模型能看出"表断了"而不是"没数据"）
    data["watch_age_minutes"] = max(0, int((time.time() * 1000 - data["timestamp"]) / 60000))
    log(f"read ok: watch 数据 {data['watch_age_minutes']} 分钟前 (HR {hr})")

    try:
        r = subprocess.run([
            "curl", "-s", "-k", "--max-time", "20", "-X", "POST",
            "-H", f"Authorization: Bearer {TOKEN}",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(data),
            URL,
        ], capture_output=True, timeout=25)
        log(f"posted: {r.stdout.decode('utf-8', 'ignore')[:80]} | {data}")
    except subprocess.TimeoutExpired:
        log("post 超时（25s）")
except Exception as e:
    log(f"Error: {e}")
    # 失败时弹通知：重启后丢存储权限（termux-setup-storage）这种情况，不弹的话你根本不会发现
    try:
        hint = "（试试 termux-setup-storage）" if "unable to open database" in str(e) else ""
        subprocess.run(["termux-notification", "--id", "push_health_err",
                        "--title", "健康上报失败", "--content", f"{e} {hint}".strip(),
                        "--priority", "default"], timeout=8,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass
finally:
    try:
        fcntl.flock(lock_fp, fcntl.LOCK_UN)
        lock_fp.close()
    except Exception:
        pass
