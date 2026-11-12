"""
AI Studio 导出 JSON → 记忆提取 → ChromaDB
- 解析 Google AI Studio 导出的 JSON 聊天记录
- 按日期分组，分批发给 DeepSeek 提取记忆
- 去重后写入 ChromaDB
- 跳过 thought / driveDocument 等无实际对话内容的 chunk
"""

import os
import re
import json
import time
import random
import sys
import chromadb
from datetime import datetime
from openai import OpenAI
from embedding import get_ef, embed_cleaned

# ===== 配置 =====
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "chroma_db")
COLLECTION = "memories"
PROGRESS_FILE = os.path.join(BASE_DIR, "aistudio_import_progress.json")

BATCH_MAX_CHARS = 3000
DEDUP_THRESHOLD = 0.45  # bge + normalize L2

EXTRACT_PROMPT = """从以下对话中提取值得长期记住的信息。

提取规则：
- 每条记忆独立、简洁（一两句话）
- 用第三人称，以"生生"指代用户，以"Daemon"指代AI角色
- 标注类型，只能是以下之一：event/preference/fact/note
- 标注情感强度 emotion_weight（0-1 的小数）
- 标注日期（如能推断，格式 YYYY-MM-DD，无法推断则填 null）
- 不要提取：打招呼、闲聊、角色扮演的动作描写、AI的思考过程
- 只保留有实际信息量的内容（事件、偏好、事实、心理状态等）
- 严格以 JSON 数组输出，不要输出任何其他内容

输出格式：
[
  {"content": "...", "type": "event", "emotion_weight": 0.3, "date": "2026-04-01"},
  {"content": "...", "type": "preference", "emotion_weight": 0.7, "date": null}
]"""


def parse_aistudio_json(filepath):
    """解析 AI Studio 导出 JSON，返回按日期分组的对话"""
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    chunks = data.get("chunkedPrompt", {}).get("chunks", [])

    # 过滤：只保留有文本、非 thought、非 driveDocument 的
    entries = []
    for c in chunks:
        if c.get("isThought"):
            continue
        if "driveDocument" in c and not c.get("text"):
            continue
        text = (c.get("text") or "").strip()
        if not text:
            continue
        role = c.get("role", "user")
        create_time = c.get("createTime", "")
        date = create_time[:10] if create_time else ""
        entries.append({
            "role": role,
            "text": text,
            "date": date,
            "timestamp": create_time,
        })

    # 按日期分组
    by_date = {}
    for e in entries:
        d = e["date"] or "unknown"
        by_date.setdefault(d, []).append(e)

    return by_date


def format_day_conversations(entries):
    """将一天的对话格式化为文本"""
    lines = []
    for e in entries:
        role_label = "用户" if e["role"] == "user" else "AI"
        # 截断过长的单条（角色扮演回复可能很长）
        text = e["text"]
        if len(text) > 800:
            text = text[:800] + "..."
        lines.append(f"{role_label}：{text}")
    return "\n".join(lines)


def split_to_batches(text, max_chars=BATCH_MAX_CHARS):
    """将长文本按段落切成多个 batch"""
    if len(text) <= max_chars:
        return [text]
    batches = []
    lines = text.split("\n")
    current = ""
    for line in lines:
        if len(current) + len(line) + 1 > max_chars and current:
            batches.append(current.strip())
            current = ""
        current += line + "\n"
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


def is_duplicate(col, text):
    if col.count() == 0:
        return False
    query_emb = embed_cleaned(text)
    results = col.query(query_embeddings=[query_emb], n_results=1)
    if results["distances"] and results["distances"][0]:
        return results["distances"][0][0] < DEDUP_THRESHOLD
    return False


# ===== 断点续传 =====

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {"done_dates": [], "total_added": 0, "total_skipped": 0, "errors": []}


def save_progress(progress):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


TYPE_WEIGHTS = {"fact": 1.0, "preference": 1.0, "event": 0.6, "note": 0.4}


def run(filepath):
    if not DEEPSEEK_API_KEY:
        print("错误：请设置环境变量 DEEPSEEK_API_KEY")
        sys.exit(1)

    print(f"📄 解析文件: {filepath}")
    by_date = parse_aistudio_json(filepath)
    dates = sorted(by_date.keys())
    print(f"   共 {len(dates)} 天，{sum(len(v) for v in by_date.values())} 条有效对话")

    ef = get_ef()
    client = chromadb.PersistentClient(path=DB_PATH)
    col = client.get_or_create_collection(name=COLLECTION, embedding_function=ef)
    print(f"   记忆库现有 {col.count()} 条\n")

    progress = load_progress()
    done_dates = set(progress["done_dates"])
    total_added = progress["total_added"]
    total_skipped = progress["total_skipped"]
    errors = progress["errors"]

    if done_dates:
        print(f"⏩ 已处理 {len(done_dates)} 天，从断点继续\n")

    for date_idx, date in enumerate(dates):
        if date in done_dates:
            continue

        entries = by_date[date]
        day_text = format_day_conversations(entries)
        batches = split_to_batches(day_text)

        print(f"[{date_idx + 1}/{len(dates)}] {date}  {len(entries)} 条对话  {len(batches)} 批")

        day_added = 0
        day_skipped = 0

        for batch_idx, batch_text in enumerate(batches):
            try:
                memories = call_deepseek(batch_text)
            except Exception as e:
                err = f"{date} batch {batch_idx}: {e}"
                print(f"  ❌ {err}")
                errors.append(err)
                time.sleep(2)
                continue

            if not isinstance(memories, list):
                errors.append(f"{date} batch {batch_idx}: 返回非数组")
                continue

            for item_idx, item in enumerate(memories):
                content = item.get("content", "").strip()
                if not content:
                    continue

                if is_duplicate(col, content):
                    day_skipped += 1
                    total_skipped += 1
                    continue

                doc_id = f"aistudio_{date}_{batch_idx}_{item_idx}"
                item_type = item.get("type", "note")
                meta = {
                    "type": item_type,
                    "date": item.get("date") or date,
                    "source": "aistudio",
                    "access_count": 0,
                    "emotion_weight": float(item.get("emotion_weight", 0.0) or 0.0),
                    "memory_type_weight": TYPE_WEIGHTS.get(item_type, 0.4),
                    "memory_level": "memory",
                    "expire": "",
                }

                emb = embed_cleaned(content)
                col.add(ids=[doc_id], documents=[content], embeddings=[emb], metadatas=[meta])
                day_added += 1
                total_added += 1

            time.sleep(random.uniform(1, 2))

        print(f"  ✅ 写入 {day_added}，跳过重复 {day_skipped}")

        done_dates.add(date)
        progress["done_dates"] = sorted(done_dates)
        progress["total_added"] = total_added
        progress["total_skipped"] = total_skipped
        progress["errors"] = errors
        save_progress(progress)

    # 总结
    print(f"\n{'=' * 50}")
    print(f"✅ 导入完成!")
    print(f"   写入: {total_added} 条")
    print(f"   跳过重复: {total_skipped} 条")
    print(f"   记忆库: {col.count()} 条")
    if errors:
        print(f"   ⚠️ 错误: {len(errors)} 个")
        for e in errors[:10]:
            print(f"     - {e}")

    # 清理进度文件
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)
        print("   进度文件已清理")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python import_aistudio.py <AI_Studio导出.json>")
        print("环境变量: DEEPSEEK_API_KEY=你的key")
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.isfile(filepath):
        print(f"文件不存在: {filepath}")
        sys.exit(1)

    run(filepath)
