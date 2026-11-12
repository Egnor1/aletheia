"""
给所有已有记忆补两个 metadata 字段：
- access_count   → 0（若缺失）
- memory_type_weight → 根据 type 自动赋值（若缺失）

纯本地操作，不调用任何 API。幂等，重跑无害。
"""

import os
import chromadb

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
COLLECTION = "memories"
BATCH = 500

TYPE_WEIGHTS = {
    "fact": 1.0,
    "preference": 1.0,
    "event": 0.6,
    "note": 0.4,
}

def type_weight(t):
    return TYPE_WEIGHTS.get((t or "note").lower(), 0.4)


def main():
    client = chromadb.PersistentClient(path=DB_PATH)
    col = client.get_or_create_collection(name=COLLECTION)
    total = col.count()
    print(f"记忆库共 {total} 条，开始补 metadata...")

    patched = 0
    for offset in range(0, total, BATCH):
        results = col.get(
            include=["metadatas"],
            limit=BATCH,
            offset=offset,
        )
        ids = results["ids"]
        metas = results["metadatas"]

        update_ids = []
        update_metas = []
        for doc_id, meta in zip(ids, metas):
            meta = dict(meta or {})
            changed = False
            if "access_count" not in meta:
                meta["access_count"] = 0
                changed = True
            # 始终按 type 重算 memory_type_weight（保证一致性）
            expected_tw = type_weight(meta.get("type", ""))
            if meta.get("memory_type_weight") != expected_tw:
                meta["memory_type_weight"] = expected_tw
                changed = True
            if changed:
                update_ids.append(doc_id)
                update_metas.append(meta)

        if update_ids:
            col.update(ids=update_ids, metadatas=update_metas)
            patched += len(update_ids)
            print(f"  [{offset}-{offset+len(ids)}] 更新 {len(update_ids)} 条")

    print(f"\n✅ 完成：共 {total} 条，补齐/更新 {patched} 条")


if __name__ == "__main__":
    main()
