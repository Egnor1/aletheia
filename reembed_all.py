"""
迁移脚本：重建 Chroma collection 为 bge-small-zh-v1.5 (512 维)
- 旧 collection 是 384 维，无法 in-place 更新 embedding，必须重建
- 流程：
  1. 读取所有 ids/documents/metadatas → 备份到 JSON
  2. delete_collection
  3. create_collection（带新 EF）
  4. 分批 add（embeddings 由 EF 在 add 时自动生成，已包含人称清洗）
- 文档与 metadata 完全保留不变
"""

import os
import json
import time
import chromadb
from embedding import get_ef, EMBEDDING_DIM, MODEL_NAME

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
COLLECTION = "memories"
BACKUP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_backup.json")
BATCH_SIZE = 64


def main():
    client = chromadb.PersistentClient(path=DB_PATH)
    col = client.get_or_create_collection(name=COLLECTION)
    total = col.count()
    print(f"旧记忆库共 {total} 条")
    if total == 0:
        return

    # 1. 全量读出
    print("读取全部记忆 ...")
    data = col.get(include=["documents", "metadatas"])
    ids = data["ids"]
    docs = data["documents"]
    metas = data["metadatas"]
    assert len(ids) == total, f"读取数量不一致: {len(ids)} vs {total}"

    # 2. 备份
    with open(BACKUP_FILE, "w", encoding="utf-8") as f:
        json.dump(
            [{"id": ids[i], "document": docs[i], "metadata": metas[i]} for i in range(total)],
            f, ensure_ascii=False,
        )
    print(f"已备份到 {BACKUP_FILE}")

    # 3. 加载新 EF
    print(f"加载 embedding 模型: {MODEL_NAME} ({EMBEDDING_DIM} 维) ...")
    ef = get_ef()
    print("模型已加载")

    # 4. 删除旧 collection 并重建
    print(f"删除旧 collection '{COLLECTION}' ...")
    client.delete_collection(name=COLLECTION)
    new_col = client.create_collection(name=COLLECTION, embedding_function=ef)
    print("已创建新 collection")

    # 5. 分批写回
    start = time.time()
    done = 0
    total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE

    for offset in range(0, total, BATCH_SIZE):
        end = min(offset + BATCH_SIZE, total)
        batch_ids = ids[offset:end]
        batch_docs = docs[offset:end]
        batch_metas = metas[offset:end]
        # 显式生成 embedding（也可以让 EF 自动算，效果一样）
        batch_embs = ef(batch_docs)
        new_col.add(
            ids=batch_ids,
            documents=batch_docs,
            embeddings=batch_embs,
            metadatas=batch_metas,
        )
        done += len(batch_ids)
        elapsed = time.time() - start
        rate = done / elapsed if elapsed > 0 else 0
        eta = (total - done) / rate if rate > 0 else 0
        batch_num = offset // BATCH_SIZE + 1
        print(f"[{batch_num}/{total_batches}] 已写入 {done}/{total}  "
              f"速率 {rate:.1f}/s  预计剩余 {eta:.0f}s")

    final = new_col.count()
    print(f"\n✅ 完成！新 collection 共 {final} 条，耗时 {time.time() - start:.1f}s")
    if final != total:
        print(f"⚠️ 数量不一致！原 {total}，新 {final}")


if __name__ == "__main__":
    main()
