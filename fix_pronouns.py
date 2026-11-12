"""
批量修正 Chroma 记忆库中的人称
- "我/用户/他/她" → "生生"
- "AI/模型/助手/你" → "Daemon"
- 分批调用 DeepSeek 改写，upsert 回 Chroma
"""

import os
import json
import time
import random
import chromadb
from datetime import datetime
from openai import OpenAI
from embedding import get_ef, embed_cleaned_batch

# ===== 配置 =====
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
COLLECTION = "memories"
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fix_pronouns_log.jsonl")
BATCH_SIZE = 30

REWRITE_PROMPT = """将以下记忆条目统一改写人称。

规则：
- "我"、"用户"、"他/她"（指代主人公）→ "生生"
- "AI"、"模型"、"助手"、"你"（指代AI角色）→ "Daemon"
- 如果已经正确使用"生生"和"Daemon"，保持不变
- 只改人称和称谓，不要改动任何实际内容、语气或细节
- 保持每条的独立性，不要合并或拆分
- 输出 JSON 数组，顺序和输入一致

输入：
[
  {"id": "hist_1_1", "content": "我今天和室友去吃了火锅"},
  {"id": "hist_1_2", "content": "用户向AI倾诉了考试压力"},
  {"id": "hist_1_3", "content": "他正在读《第二性》第三章"}
]

输出：
[
  {"id": "hist_1_1", "content": "生生今天和室友去吃了火锅"},
  {"id": "hist_1_2", "content": "生生向Daemon倾诉了考试压力"},
  {"id": "hist_1_3", "content": "生生正在读《第二性》第三章"}
]"""


def call_deepseek(items):
    """调用 DeepSeek 改写人称"""
    client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=60)
    input_json = json.dumps(items, ensure_ascii=False)

    resp = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        temperature=0,
        messages=[
            {"role": "system", "content": REWRITE_PROMPT},
            {"role": "user", "content": input_json},
        ],
    )

    raw = resp.choices[0].message.content.strip()
    import re
    m = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)
    return json.loads(raw)


def run(dry_run=False, limit=None):
    if not DEEPSEEK_API_KEY:
        print("错误：请设置环境变量 DEEPSEEK_API_KEY")
        return

    client = chromadb.PersistentClient(path=DB_PATH)
    col = client.get_or_create_collection(name=COLLECTION, embedding_function=get_ef())
    total = col.count()
    print(f"记忆库共 {total} 条")

    if limit:
        total = min(total, limit)
        print(f"本次只处理前 {total} 条")

    total_modified = 0
    total_unchanged = 0
    total_errors = 0

    log_f = open(LOG_FILE, "a", encoding="utf-8") if not dry_run else None

    for offset in range(0, total, BATCH_SIZE):
        batch_size = min(BATCH_SIZE, total - offset)
        results = col.get(
            include=["documents", "metadatas"],
            limit=batch_size,
            offset=offset,
        )

        ids = results["ids"]
        docs = results["documents"]
        metas = results["metadatas"]

        # Build input for DeepSeek
        items = [{"id": ids[i], "content": docs[i]} for i in range(len(ids))]

        batch_num = offset // BATCH_SIZE + 1
        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"\n[{batch_num}/{total_batches}] 处理第 {offset+1}-{offset+len(ids)} 条...")

        try:
            rewritten = call_deepseek(items)
        except Exception as e:
            print(f"  ❌ DeepSeek 调用失败: {e}")
            total_errors += len(ids)
            time.sleep(2)
            continue

        if not isinstance(rewritten, list) or len(rewritten) != len(items):
            print(f"  ❌ 返回数量不匹配: 期望 {len(items)}，得到 {len(rewritten) if isinstance(rewritten, list) else '非数组'}")
            total_errors += len(ids)
            continue

        # Compare and upsert
        batch_modified = 0
        batch_unchanged = 0
        upsert_ids = []
        upsert_docs = []
        upsert_metas = []

        for i, item in enumerate(rewritten):
            new_content = item.get("content", "").strip()
            old_content = docs[i]

            if not new_content:
                batch_unchanged += 1
                continue

            if new_content != old_content:
                batch_modified += 1
                upsert_ids.append(ids[i])
                upsert_docs.append(new_content)
                upsert_metas.append(metas[i])

                if log_f:
                    log_f.write(json.dumps({
                        "id": ids[i],
                        "before": old_content,
                        "after": new_content,
                        "time": datetime.now().isoformat(),
                    }, ensure_ascii=False) + "\n")

                if dry_run:
                    print(f"  [{ids[i]}]")
                    print(f"    前: {old_content}")
                    print(f"    后: {new_content}")
            else:
                batch_unchanged += 1

        # Upsert modified entries
        if upsert_ids and not dry_run:
            upsert_embs = embed_cleaned_batch(upsert_docs)
            col.upsert(ids=upsert_ids, documents=upsert_docs, embeddings=upsert_embs, metadatas=upsert_metas)

        total_modified += batch_modified
        total_unchanged += batch_unchanged
        print(f"  ✅ 修改 {batch_modified} 条，未变 {batch_unchanged} 条")

        time.sleep(random.uniform(1, 2))

    if log_f:
        log_f.close()

    print("\n" + "=" * 50)
    print(f"{'[试运行] ' if dry_run else ''}处理完成!")
    print(f"  总条数: {total}")
    print(f"  已修改: {total_modified}")
    print(f"  未变化: {total_unchanged}")
    print(f"  错误: {total_errors}")
    if not dry_run and total_modified > 0:
        print(f"  修改日志: {LOG_FILE}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2 or sys.argv[1] == "--help":
        print("用法:")
        print("  python fix_pronouns.py --test        试运行前 10 条，只打印不修改")
        print("  python fix_pronouns.py --run         正式运行，修改所有记忆")
        print()
        print("环境变量: DEEPSEEK_API_KEY=你的key")
        sys.exit(0)

    if sys.argv[1] == "--test":
        run(dry_run=True, limit=10)
    elif sys.argv[1] == "--run":
        print("⚠️  即将修改所有记忆的人称，此操作不可撤销（但有日志记录）。")
        confirm = input("确认执行？(y/N) ").strip().lower()
        if confirm == "y":
            run(dry_run=False)
        else:
            print("已取消。")
    else:
        print(f"未知参数: {sys.argv[1]}，使用 --help 查看用法")
