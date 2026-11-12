"""
解析 Gadgetbridge SQLite 数据库，提取指定日期的健康数据
输出 JSON 到 stdout，供 Node.js 调用

用法: python parse_health.py <db_path> [YYYY-MM-DD]
不传日期则取最新一天的数据
"""

import sys
import json
import sqlite3
from datetime import datetime, timezone, timedelta


def ts_range_for_date(date_str):
    """返回指定日期 00:00:00 ~ 23:59:59 的 Unix 秒级时间戳范围"""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    start = int(dt.timestamp())
    end = start + 86400 - 1
    return start, end


def parse_daily_summary(c, date_str):
    """从 XIAOMI_DAILY_SUMMARY_SAMPLE 提取日汇总"""
    start, end = ts_range_for_date(date_str)
    # 该表时间戳是毫秒级
    start_ms, end_ms = start * 1000, end * 1000

    c.execute(
        "SELECT * FROM XIAOMI_DAILY_SUMMARY_SAMPLE WHERE TIMESTAMP >= ? AND TIMESTAMP <= ? LIMIT 1",
        (start_ms, end_ms),
    )
    row = c.fetchone()
    if not row:
        return None

    cols = [desc[0] for desc in c.description]
    d = dict(zip(cols, row))
    return {
        "steps": d.get("STEPS", 0),
        "hr_resting": d.get("HR_RESTING", 0),
        "hr_max": d.get("HR_MAX", 0),
        "hr_min": d.get("HR_MIN", 0),
        "hr_avg": d.get("HR_AVG", 0),
        "stress_avg": d.get("STRESS_AVG", 0),
        "stress_max": d.get("STRESS_MAX", 0),
        "stress_min": d.get("STRESS_MIN", 0),
        "calories": d.get("CALORIES", 0),
        "spo2_avg": d.get("SPO2_AVG", 0),
    }


def parse_activity_samples(c, date_str):
    """从 XIAOMI_ACTIVITY_SAMPLE 聚合分钟级数据"""
    start, end = ts_range_for_date(date_str)
    # 该表时间戳是秒级

    c.execute(
        "SELECT STEPS, HEART_RATE, STRESS, SPO2 FROM XIAOMI_ACTIVITY_SAMPLE WHERE TIMESTAMP >= ? AND TIMESTAMP <= ?",
        (start, end),
    )
    rows = c.fetchall()
    if not rows:
        return None

    total_steps = sum(r[0] for r in rows)
    hr_values = [r[1] for r in rows if r[1] and r[1] > 0]
    stress_values = [r[2] for r in rows if r[2] and r[2] > 0]
    spo2_values = [r[3] for r in rows if r[3] and r[3] > 0]

    result = {"sample_count": len(rows), "total_steps": total_steps}
    if hr_values:
        result["hr_avg"] = round(sum(hr_values) / len(hr_values))
        result["hr_max"] = max(hr_values)
        result["hr_min"] = min(hr_values)
    if stress_values:
        result["stress_avg"] = round(sum(stress_values) / len(stress_values))
    if spo2_values:
        result["spo2_avg"] = round(sum(spo2_values) / len(spo2_values))
    return result


def parse_sleep(c, date_str):
    """从 XIAOMI_SLEEP_TIME_SAMPLE 提取睡眠数据"""
    start, end = ts_range_for_date(date_str)

    c.execute(
        "SELECT TOTAL_DURATION, DEEP_SLEEP_DURATION, LIGHT_SLEEP_DURATION, "
        "REM_SLEEP_DURATION, AWAKE_DURATION "
        "FROM XIAOMI_SLEEP_TIME_SAMPLE WHERE TIMESTAMP >= ? AND TIMESTAMP <= ? LIMIT 1",
        (start, end),
    )
    row = c.fetchone()
    if not row:
        return None

    total_min = (row[0] or 0) // 60  # 秒转分钟
    return {
        "total_hours": round(total_min / 60, 1),
        "total_minutes": total_min,
        "deep_minutes": (row[1] or 0) // 60,
        "light_minutes": (row[2] or 0) // 60,
        "rem_minutes": (row[3] or 0) // 60,
        "awake_minutes": (row[4] or 0) // 60,
    }


def find_latest_date(c):
    """找到数据库中最新有数据的日期"""
    # 先查日汇总表
    c.execute("SELECT MAX(TIMESTAMP) FROM XIAOMI_DAILY_SUMMARY_SAMPLE")
    row = c.fetchone()
    if row and row[0]:
        return datetime.fromtimestamp(row[0] / 1000).strftime("%Y-%m-%d")

    # 再查分钟级表
    c.execute("SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE")
    row = c.fetchone()
    if row and row[0]:
        return datetime.fromtimestamp(row[0]).strftime("%Y-%m-%d")

    return None


def parse(db_path, date_str=None):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    if not date_str:
        date_str = find_latest_date(c)
        if not date_str:
            conn.close()
            return {"error": "no data found", "date": None}

    result = {"date": date_str}

    # 优先用日汇总
    summary = parse_daily_summary(c, date_str)
    if summary:
        result["steps"] = summary["steps"]
        result["hr_resting"] = summary["hr_resting"]
        result["hr_max"] = summary["hr_max"]
        result["hr_min"] = summary["hr_min"]
        result["hr_avg"] = summary["hr_avg"]
        result["stress_avg"] = summary["stress_avg"]
        result["stress_max"] = summary["stress_max"]
        result["stress_min"] = summary["stress_min"]
        result["calories"] = summary["calories"]
        if summary["spo2_avg"] > 0:
            result["spo2_avg"] = summary["spo2_avg"]
    else:
        # 没有日汇总，从分钟级数据聚合
        activity = parse_activity_samples(c, date_str)
        if activity:
            result["steps"] = activity["total_steps"]
            if "hr_avg" in activity:
                result["hr_avg"] = activity["hr_avg"]
                result["hr_max"] = activity["hr_max"]
                result["hr_min"] = activity["hr_min"]
            if "stress_avg" in activity:
                result["stress_avg"] = activity["stress_avg"]
            if "spo2_avg" in activity:
                result["spo2_avg"] = activity["spo2_avg"]

    # 睡眠
    sleep = parse_sleep(c, date_str)
    if sleep:
        result["sleep"] = sleep

    conn.close()
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python parse_health.py <db_path> [YYYY-MM-DD]")
        sys.exit(1)

    db_path = sys.argv[1]
    date_str = sys.argv[2] if len(sys.argv) > 2 else None
    data = parse(db_path, date_str)
    print(json.dumps(data, ensure_ascii=False, indent=2))
