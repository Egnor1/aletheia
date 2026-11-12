"""
每日定时记忆提取（兜底机制）
- 读取前一天的 logs/YYYY-MM-DD.jsonl 对话日志
- 分段发给 DeepSeek 提取记忆
- 去重后通过 rag_server API 写入 ChromaDB（不再本地加载 BGE 模型）
- 建议 cron: 0 5 * * * /var/www/app/daily_extract.sh
"""
import os
import re
import json
import time
import random
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from openai import OpenAI

# ===== 配置 =====
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, "logs")

RAG_SERVER = "http://127.0.0.1:8100"

BATCH_MAX_CHARS = 3000
DEDUP_THRESHOLD = 0.45  # bge + normalize L2 距离，对应 cos ≈ 0.9

EXTRACT_PROMPT = """从以下对话中提取值得长期记住的信息。

提取规则：
- 每条记忆只讲一件独立的事，30-60 字，绝对不超过 80 字
- 信息密集就拆成多条，宁多勿杂——把不同主题塞进同一条是严重错误
- 用第三人称，以"生生"指代用户，以"Daemon"指代AI角色
- 标注类型，只能是以下之一：event/preference/fact/note
- 标注情感强度 emotion_weight（0-1 的小数）
- 不要提取：打招呼、闲聊、已经明显重复的信息、技术指令
- 只保留有实际信息量的内容
- 严格以 JSON 数组输出，不要输出任何其他内容

输出格式：
[
  {"content": "...", "type": "event", "emotion_weight": 0.3},
  {"content": "...", "type": "preference", "emotion_weight": 0.7}
]"""


def rag_post(action, data, timeout=15):
    """调用 rag_server HTTP API"""
    url = f"{RAG_SERVER}/{action}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"rag_server {action} 请求失败: {e}")


def rag_count():
    """获取记忆库总数（用于日志展示）"""
    try:
        data = rag_post("list", {"limit": 1, "offset": 0})
        return data.get("total", "?")
    except Exception:
        return "?"


def is_duplicate(text):
    """通过 rag_server 查询去重"""
    try:
        data = rag_post("query", {
            "text": text,
            "n_results": 1,
            "max_distance": DEDUP_THRESHOLD,
        })
        return len(data.get("memories", [])) > 0
    except Exception as e:
        print(f"    ⚠ 去重查询失败: {e}")
        return False  # 查询失败不阻塞，宁可写入重复


def add_memory(content, doc_id, meta):
    """通过 rag_server 添加记忆"""
    payload = {
        "id": doc_id,
        "content": content,
        "type": meta.get("type", "note"),
        "date": meta.get("date", ""),
        "source": meta.get("source", "daily_extract"),
        "access_count": meta.get("access_count", 0),
        "emotion_weight": meta.get("emotion_weight", 0.0),
        "memory_type_weight": meta.get("memory_type_weight", 0.4),
        "memory_level": meta.get("memory_level", "memory"),
        "expire": meta.get("expire", ""),
    }
    return rag_post("add", payload)


def expire_memos():
    """通过 rag_server 降级过期 memo"""
    try:
        data = rag_post("expire_memos", {})
        n = data.get("expired", 0)
        if n > 0:
            print(f"[expire_memos] 降级 {n} 条 memo → memory")
        else:
            print("[expire_memos] 无过期 memo")
    except Exception as e:
        print(f"[expire_memos] 失败: {e}")


def load_log(date_str):
    """读取指定日期的对话日志"""
    log_file = os.path.join(LOG_DIR, f"{date_str}.jsonl")
    if not os.path.exists(log_file):
        return []
    entries = []
    with open(log_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def segment_conversations(entries, gap_minutes=30):
    """按时间间隔切分对话 session"""
    if not entries:
        return []
    sessions = []
    current = [entries[0]]
    for e in entries[1:]:
        try:
            t_prev = datetime.fromisoformat(current[-1]["timestamp"])
            t_curr = datetime.fromisoformat(e["timestamp"])
            if (t_curr - t_prev).total_seconds() > gap_minutes * 60:
                sessions.append(current)
                current = []
        except (KeyError, ValueError):
            pass
        current.append(e)
    if current:
        sessions.append(current)
    return sessions


def format_session(entries):
    """将一组对话条目格式化为文本"""
    lines = []
    for e in entries:
        role = "用户" if e.get("role") == "user" else "AI"
        lines.append(f"{role}：{e.get('content', '')}")
    return "\n".join(lines)


def merge_sessions_to_batches(sessions, max_chars=BATCH_MAX_CHARS):
    """合并小 session 为批次"""
    batches = []
    current = ""
    for sess in sessions:
        text = format_session(sess)
        if not text.strip():
            continue
        segment = text + "\n\n---\n\n"
        if len(current) + len(segment) > max_chars and current:
            batches.append(current.strip())
            current = ""
        current += segment
    if current.strip():
        batches.append(current.strip())
    return batches


def call_deepseek(text):
    """调用 DeepSeek 提取记忆"""
    client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=60)
    resp = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        temperature=0,
        messages=[
            {"role": "system", "content": EXTRACT_PROMPT},
            {"role": "user", "content": text},
        ],
    )
    raw = resp.choices[0].message.content.strip()
    m = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)
    return json.loads(raw)


def run(date_str=None):
    if not DEEPSEEK_API_KEY:
        print("错误：请设置环境变量 DEEPSEEK_API_KEY")
        sys.exit(1)

    if not date_str:
        date_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    print(f"[daily_extract] 处理日期: {date_str}")

    entries = load_log(date_str)
    if not entries:
        print(f"  没有找到 {date_str} 的对话日志")
        return

    print(f"  读取 {len(entries)} 条对话记录")

    sessions = segment_conversations(entries)
    print(f"  切分为 {len(sessions)} 段对话")

    batches = merge_sessions_to_batches(sessions)
    print(f"  合并为 {len(batches)} 批")

    initial_count = rag_count()
    print(f"  记忆库现有 {initial_count} 条 (via rag_server)")

    total_added = 0
    total_skipped = 0
    total_errors = 0

    for batch_idx, batch_text in enumerate(batches):
        print(f"\n  [{batch_idx + 1}/{len(batches)}] 提取中 ({len(batch_text)} 字)...")

        try:
            memories = call_deepseek(batch_text)
        except Exception as e:
            print(f"    ❌ DeepSeek 调用失败: {e}")
            total_errors += 1
            time.sleep(2)
            continue

        if not isinstance(memories, list):
            print(f"    ❌ 返回非数组")
            total_errors += 1
            continue

        batch_added = 0
        batch_skipped = 0

        for item_idx, item in enumerate(memories):
            content = item.get("content", "").strip()
            if not content:
                continue

            if is_duplicate(content):
                batch_skipped += 1
                total_skipped += 1
                continue

            doc_id = f"daily_{date_str}_{batch_idx}_{item_idx}"
            meta = {
                "type": item.get("type", "note"),
                "date": date_str,
                "source": "daily_extract",
                "access_count": 0,
                "emotion_weight": float(item.get("emotion_weight", 0.0) or 0.0),
                "memory_type_weight": {"fact": 1.0, "preference": 1.0, "event": 0.6, "note": 0.4}.get(
                    item.get("type", "note"), 0.4
                ),
                "memory_level": "memory",
                "expire": "",
            }

            try:
                add_memory(content, doc_id, meta)
                batch_added += 1
                total_added += 1
            except Exception as e:
                print(f"    ⚠ 写入失败 [{doc_id}]: {e}")
                total_errors += 1

        print(f"    ✅ 提取 {len(memories)} 条，写入 {batch_added}，跳过重复 {batch_skipped}")
        time.sleep(random.uniform(1, 2))

    final_count = rag_count()
    print(f"\n{'=' * 50}")
    print(f"[daily_extract] {date_str} 完成")
    print(f"  写入: {total_added} 条")
    print(f"  跳过重复: {total_skipped} 条")
    print(f"  错误: {total_errors} 批/条")
    print(f"  记忆库: {initial_count} → {final_count} 条")

    # 过期 memo 降级
    expire_memos()


if __name__ == "__main__":
    target_date = sys.argv[1] if len(sys.argv) > 1 else None
    run(target_date)
