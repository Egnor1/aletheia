"""
批量给 Chroma 中的记忆标注 emotion_weight（0-1 浮点数）
- 分批调 DeepSeek
- 断点续传（进度存 patch_emotion_progress.json）
- 幂等：已有 emotion_weight > 0 的条目默认跳过（--force 强制重标）

用法：
  DEEPSEEK_API_KEY=... python3 patch_emotion.py          # 处理所有缺失的
  DEEPSEEK_API_KEY=... python3 patch_emotion.py --force  # 强制全部重标
  DEEPSEEK_API_KEY=... python3 patch_emotion.py --test   # 只跑前 10 条
"""

import os
import sys
import re
import json
import time
import random
import chromadb
from openai import OpenAI

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "chroma_db")
COLLECTION = "memories"
PROGRESS_FILE = os.path.join(HERE, "patch_emotion_progress.json")
BATCH_SIZE = 30

PROMPT = """为以下记忆条目标注情感强度（0-1 的浮点数）。

标注标准：
- 0.0-0.2：纯事实、日常琐事（"生生今天上了操作系统课"）
- 0.3-0.5：有一定情感色彩（"生生对室友的行为感到不满"）
- 0.6-0.8：强烈情感（"生生因为家庭矛盾情绪很差，和Daemon聊了很久"）
- 0.9-1.0：极端情感事件（"生生哭着说想放弃考研"）

输出 JSON 数组，顺序和输入一致：
[
  {"id": "hist_1_1", "emotion_weight": 0.2},
  {"id": "hist_1_2", "emotion_weight": 0.7}
]

只输出 JSON，不要其他内容。"""


def extract_json(raw):
    m = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)
    return json.loads(raw)


def call_deepseek(client, items):
    resp = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        temperature=0,
        messages=[
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": json.dumps(items, ensure_ascii=False)},
        ],
    )
    return extract_json(resp.choices[0].message.content.strip())


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"done_ids": []}


def save_progress(progress):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f)


def main():
    if not DEEPSEEK_API_KEY:
        print("错误：请设置 DEEPSEEK_API_KEY")
        return

    force = "--force" in sys.argv
    test = "--test" in sys.argv

    chroma = chromadb.PersistentClient(path=DB_PATH)
    col = chroma.get_or_create_collection(name=COLLECTION)
    total = col.count()
    print(f"记忆库共 {total} 条")

    # 拉全部条目
    all_data = col.get(include=["documents", "metadatas"])
    all_ids = all_data["ids"]
    all_docs = all_data["documents"]
    all_metas = all_data["metadatas"]

    # 筛选需要处理的
    progress = load_progress()
    done_set = set(progress["done_ids"])

    pending = []
    for i, doc_id in enumerate(all_ids):
        meta = all_metas[i] or {}
        already = meta.get("emotion_weight", 0) or 0
        if doc_id in done_set:
            continue
        if not force and already > 0:
            continue
        pending.append((doc_id, all_docs[i], meta))

    if test:
        pending = pending[:10]

    print(f"待处理 {len(pending)} 条（已完成 {len(done_set)}）")
    if not pending:
        print("无需处理。")
        return

    client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=60)

    total_ok = 0
    total_err = 0
    for b in range(0, len(pending), BATCH_SIZE):
        batch = pending[b:b + BATCH_SIZE]
        batch_num = b // BATCH_SIZE + 1
        total_batches = (len(pending) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"\n[{batch_num}/{total_batches}] 处理 {len(batch)} 条...")

        payload = [{"id": x[0], "content": x[1]} for x in batch]
        try:
            result = call_deepseek(client, payload)
        except Exception as e:
            print(f"  ❌ DeepSeek 失败: {e}")
            total_err += len(batch)
            time.sleep(2)
            continue

        if not isinstance(result, list):
            print(f"  ❌ 返回非数组")
            total_err += len(batch)
            continue

        id_to_score = {}
        for r in result:
            try:
                rid = r.get("id")
                w = float(r.get("emotion_weight", 0))
                w = max(0.0, min(1.0, w))
                id_to_score[rid] = w
            except Exception:
                continue

        update_ids = []
        update_metas = []
        for doc_id, _doc, meta in batch:
            if doc_id not in id_to_score:
                continue
            new_meta = dict(meta or {})
            new_meta["emotion_weight"] = id_to_score[doc_id]
            update_ids.append(doc_id)
            update_metas.append(new_meta)

        if update_ids and not test:
            col.update(ids=update_ids, metadatas=update_metas)

        total_ok += len(update_ids)
        if test:
            print(f"  [试运行] 将更新 {len(update_ids)} 条")
            for doc_id, _doc, _ in batch:
                if doc_id in id_to_score:
                    print(f"    {doc_id}: {id_to_score[doc_id]}")
        else:
            print(f"  ✅ 更新 {len(update_ids)} 条")
            done_set.update(update_ids)
            progress["done_ids"] = list(done_set)
            save_progress(progress)

        time.sleep(random.uniform(1, 2))

    print("\n" + "=" * 50)
    print(f"{'[试运行] ' if test else ''}完成：成功 {total_ok}，失败 {total_err}")

    if not test and total_err == 0 and os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)
        print("进度文件已清理")


if __name__ == "__main__":
    main()
