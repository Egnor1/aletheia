"""
一次性迁移脚本：为所有现有记忆添加 memory_level 和 expire 字段
- memory_level: "memory"（默认长期记忆）
- expire: ""（无过期时间）
"""
import os
import chromadb
from embedding import get_ef

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
COLLECTION = "memories"

ef = get_ef()
client = chromadb.PersistentClient(path=DB_PATH)
col = client.get_or_create_collection(name=COLLECTION, embedding_function=ef)

total = col.count()
print(f"记忆库共 {total} 条")

if total == 0:
    print("无需迁移")
    exit()

# 分批处理，每批 500
BATCH = 500
patched = 0
skipped = 0

for offset in range(0, total, BATCH):
    results = col.get(
        include=["metadatas"],
        limit=BATCH,
        offset=offset,
    )
    ids_to_update = []
    metas_to_update = []

    for i in range(len(results["ids"])):
        meta = dict(results["metadatas"][i] or {})
        need_update = False

        if "memory_level" not in meta or not meta["memory_level"]:
            meta["memory_level"] = "memory"
            need_update = True
        if "expire" not in meta:
            meta["expire"] = ""
            need_update = True

        if need_update:
            ids_to_update.append(results["ids"][i])
            metas_to_update.append(meta)
        else:
            skipped += 1

    if ids_to_update:
        col.update(ids=ids_to_update, metadatas=metas_to_update)
        patched += len(ids_to_update)
        print(f"  批次 {offset // BATCH + 1}: 更新 {len(ids_to_update)} 条")

print(f"\n迁移完成: 更新 {patched} 条, 跳过 {skipped} 条")
