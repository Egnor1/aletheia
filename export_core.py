"""
从 Chroma 导出 type=fact / preference 的记忆，供人工筛选核心事实。
输出: core_candidates.json — 含全部候选
后续人工编辑为 core_facts.json（保留 10-20 条）
"""

import os
import json
import chromadb

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
COLLECTION = "memories"
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "core_candidates.json")

client = chromadb.PersistentClient(path=DB_PATH)
col = client.get_or_create_collection(name=COLLECTION)

results = col.get(
    where={"type": {"$in": ["fact", "preference"]}},
    include=["documents", "metadatas"],
)

items = []
for i, doc_id in enumerate(results["ids"]):
    meta = results["metadatas"][i] or {}
    items.append({
        "id": doc_id,
        "content": results["documents"][i],
        "type": meta.get("type", ""),
        "date": meta.get("date", ""),
    })

# 按 type 再按日期排序，方便人工浏览
items.sort(key=lambda x: (x["type"], x["date"] or "9999"))

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

fact_n = sum(1 for x in items if x["type"] == "fact")
pref_n = sum(1 for x in items if x["type"] == "preference")
print(f"导出完成: {OUTPUT}")
print(f"  fact:       {fact_n} 条")
print(f"  preference: {pref_n} 条")
print(f"  合计:       {len(items)} 条")
