#!/data/data/com.termux/files/usr/bin/python3
# -*- coding: utf-8 -*-
"""
主动消息取件器（Python 版，只需要 python3，不依赖 curl / jq）

安装：
  1) 存成 ~/proactive_pull.py
  2) echo 'APP_TOKEN=你的token' > ~/proactive.env && chmod 600 ~/proactive.env
  3) 手动测：python3 ~/proactive_pull.py ; tail -5 ~/proactive_pull.log
     - 排查用：PULL_DEBUG=1 python3 ~/proactive_pull.py（打印 BASE/token 指纹/HTTP 状态）
     - 401 时会同时弹通知，并把「token 指纹（长度/sha256前12位）」写进日志，
       和服务器 /api/* 401 日志里的 tokenSha12 一比就知道谁错
  4) crontab -e 加一行（脚本自己写日志，不用再重定向）：
       * * * * * /data/data/com.termux/files/home/proactive_pull.py
  注意：弹通知要 termux-api 的命令 + Termux:API 这个 App
"""
import hashlib
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")
BASE = os.environ.get("BASE", "https://YOUR_SERVER_IP:3443")
APP_ACTIVITY = os.environ.get("APP_ACTIVITY", "com.egnor.aletheia/.MainActivity")
LOG_PATH = os.path.join(HOME, "proactive_pull.log")
NOTIFY_CMD = os.environ.get("TERMUX_NOTIFY", "termux-notification")   # 调试可设成 echo

TITLES = {
    "health_anomaly": "Daemon · 生理告警",
    "screen_time_audit": "Daemon · 抓包",
    "homework_progress": "Daemon · 验收",
    "brat_tease": "Daemon · 撩拨",
    "soft_care": "Daemon · 关怀",
}


def log(msg):
    """始终写进 ~/proactive_pull.log；在终端里跑时同时打印出来。
    这样 cron 里不用再重定向，手动跑也有日志可查（不会重复写两遍）。"""
    line = "[%s] %s" % (datetime.now().strftime("%F %T"), msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        if sys.stdout.isatty():
            print(line, flush=True)
    except Exception:
        pass


def load_token():
    tok = os.environ.get("APP_TOKEN", "")
    envfile = os.path.join(HOME, "proactive.env")
    if not tok and os.path.exists(envfile):
        for line in open(envfile, encoding="utf-8"):
            line = line.strip()
            if line.startswith("APP_TOKEN="):
                tok = line.split("=", 1)[1].strip().strip('"').strip("'")
    return tok


def fp(tok):
    """token 指纹（不泄明文），用来和服务器侧 401 日志比对"""
    try:
        return "%d/%s" % (len(tok), hashlib.sha256(tok.encode("utf-8")).hexdigest()[:12])
    except Exception:
        return "?"


def notify_err(title, content):
    """出错时也弹一条通知，避免 cron 里静默失败；30 分钟内不重复弹"""
    stamp = os.path.join(HOME, ".proactive_err_notify")
    try:
        if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 1800:
            return
        open(stamp, "a").close()
        os.utime(stamp, None)
    except Exception:
        pass
    try:
        subprocess.run([NOTIFY_CMD, "--id", "proactive_err", "--title", title,
                        "--content", content[:400], "--priority", "default"],
                       timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def http(method, path, token, body=None, timeout=8, attempts=3):
    """带重试的请求：手机网络/TLS 偶发卡住（urlopen error timed out）时，
    单次 8 秒超时 + 最多 3 次（间隔 2 秒），整轮控制在 30 秒内，不会跟下一分钟的 cron 撞车。"""
    last_err = None
    for i in range(attempts):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False          # 自签证书
        ctx.verify_mode = ssl.CERT_NONE
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method)
        req.add_header("X-Auth-Token", token)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                raw = r.read().decode("utf-8", "ignore")
                return r.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as e:
            if e.code == 401:
                log("鉴权失败(401) %s %s → token 指纹 %s（服务器日志里也有 tokenSha12，可直接比对）"
                    % (method, path, fp(token)))
            else:
                log("HTTP %s %s %s → %s" % (e.code, method, path, _err_text(e)))
            return e.code, {}           # HTTP 层错误重试没意义
        except Exception as e:
            last_err = e
            if i + 1 < attempts:
                time.sleep(2)
    log("请求失败 %s %s：%r（已重试 %d 次，BASE=%s）" % (method, path, last_err, attempts, BASE))
    return 0, {}


def _err_text(e):
    try:
        return e.read().decode("utf-8", "ignore")[:120]
    except Exception:
        return ""


def trim_log(keep=500):
    try:
        if os.path.exists(LOG_PATH):
            lines = open(LOG_PATH, encoding="utf-8", errors="ignore").read().splitlines()[-keep:]
            open(LOG_PATH, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    except Exception:
        pass


RUNS_LOG = os.path.join(HOME, ".proactive_pull_runs.log")


def acquire_lock():
    """防重叠：上一轮还在重试时下一分钟的 cron 又起来，会重复弹通知。
    拿不到锁就安静退出（返回 None）。"""
    try:
        import fcntl
        f = open(os.path.join(HOME, ".proactive_pull.lock"), "w")
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f
    except Exception:
        return None


def run_mark(text):
    """每轮都记一行（含 cron 跑成功但没东西可取的情况），用来判断 cron 到底有没有每分钟跑。
    单独一个文件，不污染 proactive_pull.log（那个只记事件）。"""
    try:
        open(os.path.join(HOME, ".proactive_pull_lastrun"), "a").close()
        os.utime(os.path.join(HOME, ".proactive_pull_lastrun"), None)
    except Exception:
        pass
    try:
        lines = []
        if os.path.exists(RUNS_LOG):
            lines = open(RUNS_LOG, encoding="utf-8", errors="ignore").read().splitlines()[-200:]
        lines.append("[%s] %s %s" % (datetime.now().strftime("%F %T"), "tty" if sys.stdout.isatty() else "cron", text))
        open(RUNS_LOG, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    except Exception:
        pass


def main():
    # 先把日志文件建出来，手动 cat 时不会"No such file"
    try:
        open(LOG_PATH, "a", encoding="utf-8").close()
    except Exception:
        pass

    lock = acquire_lock()
    if lock is None:
        return 0                       # 上一轮还在跑（重试中），跳过本轮

    token = load_token()
    if not token:
        log("缺少 APP_TOKEN：先 echo 'APP_TOKEN=xxx' > ~/proactive.env")
        notify_err("取件器缺少 token", "~/proactive.env 里没有 APP_TOKEN，主动消息取不到。")
        run_mark("no-token")
        return 1

    debug = os.environ.get("PULL_DEBUG") == "1"
    if debug:
        log("调试：BASE=%s token 指纹=%s" % (BASE, fp(token)))

    status, data = http("GET", "/api/proactive/pending", token)
    if status == 401:
        notify_err("取件器鉴权失败(401)", "APP_TOKEN 与服务端不一致（指纹 %s）。重新从 App 复制 token 写进 ~/proactive.env。" % fp(token))
        run_mark("401 token=%s" % fp(token))
        return 1
    if status == 0:
        notify_err("取件器连不上服务器", "网络或证书问题，%s 没有响应。" % BASE)
        run_mark("net-fail")
        return 1
    if debug:
        log("调试：GET pending → %s，%d 条待取" % (status, len(data.get("items") or [])))
    if status == 204 or not data.get("items"):
        hb = heartbeat(token)
        run_mark("ok empty hb=%s" % hb)
        return 0

    items = data["items"]
    # 只把最新一条弹通知（离线久了堆积不刷屏），全部回执消费
    item = items[-1]
    text = item.get("text", "")
    cat = item.get("category") or ""
    title = TITLES.get(cat, "Daemon")

    cmd = [NOTIFY_CMD, "--id", "proactive_" + str(item.get("id")),
           "--title", title, "--content", text,
           "--priority", "high", "--group", "proactive",
           "--action", "am start -n " + APP_ACTIVITY]
    debug_notify = NOTIFY_CMD != "termux-notification"   # TERMUX_NOTIFY=echo 时把命令打出来方便排查
    try:
        r = subprocess.run(cmd, timeout=25, capture_output=debug_notify,
                           stdout=None if debug_notify else subprocess.DEVNULL,
                           stderr=None if debug_notify else subprocess.DEVNULL)
        log("推送 %s (%s, 积压 %d) %s" % (item.get("id"), cat, len(items), text[:80]))
        if debug_notify:
            log("调试命令：" + " ".join(cmd))
            if getattr(r, "stdout", None):
                log("输出：" + r.stdout.decode("utf-8", "ignore").strip()[:200])
    except Exception as e:
        log("弹通知失败（Termux:API 装了吗？）：%s" % e)

    ids = [i.get("id") for i in items]
    st, _ = http("POST", "/api/proactive/consume", token, {"ids": ids})
    if st not in (200, 204):
        log("回执失败 status=%s（下轮会重复弹一次通知）" % st)
    trim_log()
    return 0


def heartbeat(token):
    """每 5 分钟给服务端报一次「手机活着」——这样手表断连时能立刻区分是手机挂了还是表断了。
    返回：skip(5 分钟内已报过) / 上报的 HTTP 状态码 / 0(失败)"""
    stamp = os.path.join(HOME, ".proactive_heartbeat")
    try:
        if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 300:
            return "skip"
        open(stamp, "a").close()
        os.utime(stamp, None)
    except Exception:
        pass
    note = ""
    try:
        note = subprocess.run(["uname", "-n"], capture_output=True, timeout=5).stdout.decode().strip()
    except Exception:
        pass
    st, _ = http("POST", "/api/phone-status", token, {"ts": int(time.time() * 1000), "node": note, "note": "pull-ok"})
    if st not in (200, 204):
        log("心跳上报失败 status=%s（手机活着这件事服务端不知道）" % st)
    return st


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:      # cron 里没有终端，异常也要落盘
        log("未捕获异常：%r" % e)
        sys.exit(1)
