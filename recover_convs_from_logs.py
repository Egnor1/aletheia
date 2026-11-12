#!/usr/bin/env python3
"""
从 /var/www/app/logs/*.jsonl 重建对话到 /var/www/app/conversations/
切分规则：相邻两条消息间隔 > 30 分钟 → 新对话
用法：
  sudo python3 recover_convs_from_logs.py                    # dry-run，默认 split=all
  sudo python3 recover_convs_from_logs.py --split=day        # 按 UTC+8 日历切
  sudo python3 recover_convs_from_logs.py --split=session    # 30 分钟 gap 切
  sudo python3 recover_convs_from_logs.py --split=all --apply
"""
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

LOG_DIR = Path("/var/www/app/logs")
CONV_DIR = Path("/var/www/app/conversations")
SESSION_GAP_MIN = 30
TITLE_MAX = 24
TZ_CN = timezone(timedelta(hours=8))


def load_all_entries():
    entries = []
    skipped = 0
    for f in sorted(LOG_DIR.glob("*.jsonl")):
        with f.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    ts_str = e["timestamp"].replace("Z", "+00:00")
                    ts = datetime.fromisoformat(ts_str)
                    entries.append((ts, e["role"], e["content"]))
                except Exception:
                    skipped += 1
    entries.sort(key=lambda x: x[0])
    return entries, skipped


def make_conv_id(ts):
    return f"conv_rec_{int(ts.timestamp() * 1000)}_{secrets.token_hex(3)}"


def sanitize_title(text):
    t = re.sub(r"```[\s\S]*?```", "", text)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) <= TITLE_MAX:
        return t
    return t[:TITLE_MAX] + "..."


def build_sessions(entries, split_mode):
    if split_mode == "all":
        return [entries] if entries else []
    sessions = []
    cur = []
    if split_mode == "day":
        cur_day = None
        for ts, role, content in entries:
            day = ts.astimezone(TZ_CN).date()
            if cur and day != cur_day:
                sessions.append(cur)
                cur = []
            cur_day = day
            cur.append((ts, role, content))
    else:  # "session": 30 min gap
        for ts, role, content in entries:
            if cur and (ts - cur[-1][0]).total_seconds() > SESSION_GAP_MIN * 60:
                sessions.append(cur)
                cur = []
            cur.append((ts, role, content))
    if cur:
        sessions.append(cur)
    return sessions


def to_conv_json(session):
    first_ts = session[0][0]
    last_ts = session[-1][0]
    title = ""
    for ts, role, content in session:
        if role == "user" and content.strip():
            title = sanitize_title(content)
            break
    if not title:
        title = f"恢复 {first_ts.astimezone(TZ_CN):%m-%d %H:%M}"

    messages = []
    history = []
    for ts, role, content in session:
        time_str = ts.astimezone(TZ_CN).strftime("%H:%M")
        if role == "user":
            messages.append({"role": "user", "text": content, "time": time_str})
            history.append({"role": "user", "parts": [{"text": content}]})
        else:
            messages.append({
                "role": "model",
                "text": content,
                "time": time_str,
                "model": "recovered",
            })
            history.append({"role": "model", "parts": [{"text": content}]})

    return {
        "id": make_conv_id(first_ts),
        "title": title,
        "created": int(first_ts.timestamp() * 1000),
        "updated_at": int(last_ts.timestamp() * 1000),
        "messages": messages,
        "history": history,
        "tokens": 0,
        "settings": {},
        "_recovered": True,
    }


def main():
    apply = "--apply" in sys.argv
    split_mode = "all"
    for a in sys.argv:
        if a.startswith("--split="):
            split_mode = a.split("=", 1)[1]
    if split_mode not in ("all", "day", "session"):
        print(f"ERR: split 模式无效：{split_mode}（all/day/session）")
        sys.exit(1)
    if not LOG_DIR.exists():
        print(f"ERR: {LOG_DIR} 不存在")
        sys.exit(1)

    entries, skipped = load_all_entries()
    sessions = build_sessions(entries, split_mode)
    print(f"载入 {len(entries)} 条日志（跳过解析失败 {skipped} 条），split={split_mode}，切分为 {len(sessions)} 个对话")

    # 统计
    msg_total = sum(len(s) for s in sessions)
    msg_avg = msg_total / max(1, len(sessions))
    print(f"平均每对话 {msg_avg:.1f} 条消息")
    if sessions:
        first_ts = sessions[0][0][0].astimezone(TZ_CN)
        last_ts = sessions[-1][-1][0].astimezone(TZ_CN)
        print(f"时间范围 {first_ts:%Y-%m-%d %H:%M} ~ {last_ts:%Y-%m-%d %H:%M}")

    print("\n前 5 个对话预览：")
    for s in sessions[:5]:
        ts0 = s[0][0].astimezone(TZ_CN)
        user_first = next((c for _, r, c in s if r == "user"), "")
        print(f"  {ts0:%m-%d %H:%M}  {len(s):>3} 条  {sanitize_title(user_first)}")

    if not apply:
        print("\ndry-run。重跑时加 --apply 写入 /var/www/app/conversations/")
        return

    # apply 模式：先备份现有 conversations/ 避免冲突
    if CONV_DIR.exists() and any(CONV_DIR.iterdir()):
        bak = CONV_DIR.parent / f"conversations.bak.{int(datetime.now().timestamp())}"
        CONV_DIR.rename(bak)
        print(f"现有 conversations/ 已备份到 {bak}")

    CONV_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped_empty = 0
    for s in sessions:
        # 跳过没 user 消息的（极少见）
        if not any(r == "user" and c.strip() for _, r, c in s):
            skipped_empty += 1
            continue
        conv = to_conv_json(s)
        path = CONV_DIR / f"{conv['id']}.json"
        with path.open("w", encoding="utf-8") as f:
            json.dump(conv, f, ensure_ascii=False)
        written += 1
    print(f"\n写入 {written} 个对话到 {CONV_DIR}（跳过空 session {skipped_empty}）")


if __name__ == "__main__":
    main()
