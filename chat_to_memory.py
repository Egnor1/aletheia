"""
聊天记录 → 记忆提取 → ChromaDB
- 读取幕布导出的 txt 聊天记录
- 按对话 session 分批切割
- 调用 DeepSeek API 提取记忆点
- 去重后写入 ChromaDB
- 支持断点续传
"""

import os
import re
import json
import time
import random
import chromadb
from datetime import datetime, timedelta
from openai import OpenAI
from embedding import get_ef, embed_cleaned

# ===== 配置 =====
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

DB_PATH = os.path.expanduser("~/my_code/chroma_db")
COLLECTION = "memories"
PROGRESS_FILE = os.path.expanduser("~/my_code/chat_import_progress.json")

EXTRACT_PROMPT = """从以下对话中提取值得长期记住的信息。
要求：
- 每条信息独立、简洁（一两句话）
- 标注类型，只能是以下之一：event/preference/note/fact
- 标注日期（如能从上下文推断，格式 YYYY-MM-DD，无法推断则填 null）
- 只保留有实际信息量的内容，忽略寒暄、重复、无意义闲聊
- 用"生生"指代用户，用"Daemon"指代AI角色，全程统一
- 严格以 JSON 数组输出，不要输出任何其他内容

输出格式：
[
  {"content": "...", "type": "event", "date": "2026-04-01"},
  {"content": "...", "type": "preference", "date": null}
]"""

# 起始日期：第 1 天 = 2025-11-23
START_DATE = datetime(2025, 11, 24)

# ===== 解析聊天记录 =====

def parse_chat_file(filepath):
    """
    解析幕布导出的聊天记录（支持 .txt 和 .docx）。
    格式：
      一级主题（level 0）= 一天，纯数字=第几天（从 2025-11-23 起算）
      二级主题（level 1）= 一轮对话，纯数字=当天第几轮
      后续内容为对话正文
    返回：[(date_str, session_label, text), ...]
    """
    if filepath.endswith(".docx"):
        lines_with_level = _parse_docx_lines(filepath)
    else:
        lines_with_level = _parse_txt_lines(filepath)

    sessions = []
    current_date = None
    current_session_label = None
    current_lines = []

    def flush():
        if current_lines and current_date:
            text = "\n".join(current_lines).strip()
            if text:
                sessions.append((current_date, current_session_label or "unknown", text))

    for level, text in lines_with_level:
        # 一级主题：level 0 且内容为纯数字 → 天数
        if level == 0 and re.match(r'^\d+$', text):
            flush()
            current_lines = []
            day_num = int(text)
            date_obj = START_DATE + timedelta(days=day_num - 1)
            current_date = date_obj.strftime("%Y-%m-%d")
            current_session_label = None
            continue

        # 二级主题：level 1 且内容为数字（含 4.1 这种）→ 对话轮次
        if level == 1 and re.match(r'^[\d.]+$', text) and current_date:
            flush()
            current_lines = []
            current_session_label = f"session_{text}"
            continue

        # 普通内容
        if text:
            current_lines.append(text)

    flush()
    return sessions


def _parse_docx_lines(filepath):
    """解析幕布导出的 docx，通过 XML numPr/ilvl 获取层级，返回 [(level, text), ...]"""
    from docx import Document
    from docx.oxml.ns import qn
    doc = Document(filepath)
    result = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        # 跳过 Heading（文档标题）
        if para.style and para.style.name.startswith('Heading'):
            continue
        # 从 XML 的 numPr/ilvl 读取列表层级
        level = 0
        pPr = para._element.find(qn('w:pPr'))
        if pPr is not None:
            numPr = pPr.find(qn('w:numPr'))
            if numPr is not None:
                ilvl = numPr.find(qn('w:ilvl'))
                if ilvl is not None:
                    level = int(ilvl.get(qn('w:val')))
        result.append((level, text))
    return result


def _parse_txt_lines(filepath):
    """解析 txt，通过行首空格/tab 判断层级，返回 [(level, text), ...]"""
    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()
    result = []
    for line in lines:
        stripped = line.rstrip()
        if not stripped.strip():
            continue
        # 计算缩进：tab=1级，每2个空格=1级
        indent = len(stripped) - len(stripped.lstrip())
        tabs = stripped.count('\t', 0, indent)
        spaces = indent - tabs
        level = tabs + spaces // 2
        text = stripped.strip()
        # 去掉开头的 bullet 符号
        text = re.sub(r'^[•·]\s*', '', text)
        result.append((level, text))
    return result


def merge_sessions_to_batches(sessions, max_chars=2500):
    """
    将 sessions 合并为批次，每批约 max_chars 字。
    同一天的连续小对话会合并；超长单条会单独成批。
    返回：[(batch_text, date_str, session_info), ...]
    """
    batches = []
    current_text = ""
    current_date = None
    current_info = []

    def flush():
        nonlocal current_text, current_date, current_info
        if current_text.strip():
            info = ", ".join(current_info) if current_info else "unknown"
            batches.append((current_text.strip(), current_date, info))
        current_text = ""
        current_info = []

    for date_str, session_label, text in sessions:
        header = f"[{date_str} {session_label}]\n"
        segment = header + text + "\n\n"

        # 日期变了，先 flush
        if current_date and date_str != current_date:
            flush()
            current_date = date_str

        if not current_date:
            current_date = date_str

        # 加上这段会超长，先 flush
        if len(current_text) + len(segment) > max_chars and current_text:
            flush()
            current_date = date_str

        current_text += segment
        current_info.append(f"{date_str}/{session_label}")

    flush()
    return batches


# ===== DeepSeek API =====

def call_deepseek(text):
    """调用 DeepSeek 提取记忆点，返回 JSON 列表"""
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
    # 尝试从 markdown code block 中提取 JSON
    m = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)
    return json.loads(raw)


# ===== Chroma 操作 =====

def get_collection():
    client = chromadb.PersistentClient(path=DB_PATH)
    return client.get_or_create_collection(name=COLLECTION, embedding_function=get_ef())


def is_duplicate(col, text, threshold=0.9):
    """查询相似度，余弦距离 < (1 - threshold) 视为重复"""
    if col.count() == 0:
        return False
    query_emb = embed_cleaned(text)
    results = col.query(query_embeddings=[query_emb], n_results=1)
    if results["distances"] and results["distances"][0]:
        dist = results["distances"][0][0]
        similarity = 1 - dist
        return similarity > threshold
    return False


# ===== 断点续传 =====

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {"last_batch": -1, "total_added": 0, "total_skipped": 0, "errors": []}


def save_progress(progress):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


# ===== 主流程 =====

def process_file(filepath, max_chars=2500):
    if not DEEPSEEK_API_KEY:
        print("错误：请设置环境变量 DEEPSEEK_API_KEY")
        return

    print(f"📄 读取文件: {filepath}")
    sessions = parse_chat_file(filepath)
    print(f"   解析出 {len(sessions)} 段对话")

    batches = merge_sessions_to_batches(sessions, max_chars)
    total_chars = sum(len(b[0]) for b in batches)
    print(f"   合并为 {len(batches)} 批，共 {total_chars:,} 字")
    print()

    col = get_collection()
    progress = load_progress()
    start_batch = progress["last_batch"] + 1
    total_added = progress["total_added"]
    total_skipped = progress["total_skipped"]
    errors = progress["errors"]

    if start_batch > 0:
        print(f"⏩ 从第 {start_batch + 1} 批继续（已处理 {start_batch} 批，"
              f"已添加 {total_added} 条，跳过 {total_skipped} 条）\n")

    for batch_idx in range(start_batch, len(batches)):
        batch_text, batch_date, batch_info = batches[batch_idx]
        print(f"[{batch_idx + 1}/{len(batches)}] {batch_info} ({len(batch_text)} 字)")

        try:
            memories = call_deepseek(batch_text)
        except Exception as e:
            err_msg = f"批次 {batch_idx + 1} DeepSeek 调用失败: {e}"
            print(f"   ❌ {err_msg}")
            errors.append(err_msg)
            progress["last_batch"] = batch_idx
            progress["errors"] = errors
            save_progress(progress)
            time.sleep(2)
            continue

        if not isinstance(memories, list):
            err_msg = f"批次 {batch_idx + 1} 返回非数组: {type(memories)}"
            print(f"   ❌ {err_msg}")
            errors.append(err_msg)
            progress["last_batch"] = batch_idx
            save_progress(progress)
            continue

        batch_added = 0
        batch_skipped = 0

        for item_idx, item in enumerate(memories):
            content = item.get("content", "").strip()
            if not content:
                continue

            # 去重检查
            if is_duplicate(col, content):
                batch_skipped += 1
                total_skipped += 1
                continue

            doc_id = f"hist_{batch_idx}_{item_idx}"
            meta = {
                "type": item.get("type", "note"),
                "date": item.get("date") or batch_date or "",
                "source": "chat",
                "batch_id": batch_idx,
            }

            emb = embed_cleaned(content)
            col.add(ids=[doc_id], documents=[content], embeddings=[emb], metadatas=[meta])
            batch_added += 1
            total_added += 1

        print(f"   ✅ 提取 {len(memories)} 条，写入 {batch_added} 条，跳过重复 {batch_skipped} 条")

        # 更新进度
        progress["last_batch"] = batch_idx
        progress["total_added"] = total_added
        progress["total_skipped"] = total_skipped
        progress["errors"] = errors
        save_progress(progress)

        # 限速
        time.sleep(random.uniform(1, 2))

    # 总结
    print("\n" + "=" * 50)
    print(f"✅ 处理完成!")
    print(f"   总字符: {total_chars:,}")
    print(f"   总批次: {len(batches)}")
    print(f"   写入记忆: {total_added} 条")
    print(f"   跳过重复: {total_skipped} 条")
    if errors:
        print(f"   ⚠️  错误: {len(errors)} 个")
        for e in errors:
            print(f"      - {e}")

    # 清理进度文件
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)
        print("   进度文件已清理")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("用法: python chat_to_memory.py <聊天记录.txt/.docx> [每批最大字符数]")
        print("  示例: python chat_to_memory.py chat.txt 2500")
        print("  示例: python chat_to_memory.py 聊天记录.docx 3000")
        print()
        print("环境变量: DEEPSEEK_API_KEY=你的key")
        sys.exit(1)

    filepath = sys.argv[1]
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 2500

    if not os.path.isfile(filepath):
        print(f"文件不存在: {filepath}")
        sys.exit(1)

    process_file(filepath, max_chars)
