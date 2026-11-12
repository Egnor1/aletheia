"""
RAG 检索微服务
- /query            检索（返回 top N 候选，带完整打分字段）
- /list             分页列出记忆
- /add              添加记忆
- /update           更新记忆
- /delete           删除记忆
- /increment_access  批量 access_count +1（由 Node.js 在使用后异步触发）
"""

import os
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import chromadb
from embedding import get_ef, embed_cleaned

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
COLLECTION = "memories"
PORT = 8100

# 启动时加载 bge-small-zh-v1.5（512 维，本地 CPU）
embedding_fn = get_ef()

# type → memory_type_weight 映射
TYPE_WEIGHTS = {
    "fact": 1.0,
    "preference": 1.0,
    "event": 0.6,
    "note": 0.4,
}

def type_weight(t):
    return TYPE_WEIGHTS.get((t or "note").lower(), 0.4)


client = chromadb.PersistentClient(path=DB_PATH)
col = client.get_or_create_collection(name=COLLECTION, embedding_function=embedding_fn)
print(f"Chroma loaded: {col.count()} memories in '{COLLECTION}'")

# 预热 embedding 模型，避免首次请求冷启动超时
print("Warming up embedding model ...")
_ = embed_cleaned("预热")
print("Embedding model ready")


def _memory_obj(doc_id, doc, meta, distance=None):
    meta = meta or {}
    obj = {
        "id": doc_id,
        "content": doc,
        "type": meta.get("type", ""),
        "date": meta.get("date", ""),
        "source": meta.get("source", ""),
        "access_count": int(meta.get("access_count", 0) or 0),
        "emotion_weight": float(meta.get("emotion_weight", 0.0) or 0.0),
        "memory_type_weight": float(
            meta.get("memory_type_weight", type_weight(meta.get("type", "")))
        ),
        "memory_level": meta.get("memory_level", "memory"),
        "expire": meta.get("expire", ""),
    }
    if distance is not None:
        obj["distance"] = round(distance, 4)
    return obj


def _build_meta(body, old_meta=None):
    """构造 metadata，保留未显式传入的字段"""
    old_meta = old_meta or {}
    t = body.get("type", old_meta.get("type", "note"))
    meta = {
        "type": t,
        "date": body.get("date", old_meta.get("date", "")),
        "source": old_meta.get("source", body.get("source", "manual")),
        "access_count": int(
            body.get("access_count", old_meta.get("access_count", 0)) or 0
        ),
        "emotion_weight": float(
            body.get("emotion_weight", old_meta.get("emotion_weight", 0.0)) or 0.0
        ),
        "memory_type_weight": float(
            body.get("memory_type_weight", type_weight(t))
        ),
        "memory_level": body.get("memory_level", old_meta.get("memory_level", "memory")),
        "expire": body.get("expire", old_meta.get("expire", "")),
    }
    return meta


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError:
            self._reply({"error": "Invalid JSON"}, 400)
            return

        routes = {
            "/query": self._query,
            "/list": self._list,
            "/add": self._add,
            "/update": self._update,
            "/delete": self._delete,
            "/increment_access": self._increment_access,
            "/meta": self._meta,
            "/query_memos": self._query_memos,
            "/expire_memos": self._expire_memos,
        }
        handler = routes.get(self.path)
        if not handler:
            self._reply({"error": "Not found"}, 404)
            return
        try:
            handler(body)
        except Exception as e:
            self._reply({"error": str(e)}, 500)

    def _query(self, body):
        text = body.get("text", "").strip()
        n_results = int(body.get("n_results", 20))
        max_distance = float(body.get("max_distance", 1.5))
        where = body.get("where", None)

        if not text or col.count() == 0:
            self._reply({"memories": [], "count": col.count()})
            return

        query_emb = embed_cleaned(text)
        query_kwargs = {
            "query_embeddings": [query_emb],
            "n_results": min(n_results, col.count()),
        }
        if where:
            query_kwargs["where"] = where
        results = col.query(**query_kwargs)
        memories = []
        for doc_id, doc, meta, dist in zip(
            results["ids"][0],
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            if dist > max_distance:
                continue
            memories.append(_memory_obj(doc_id, doc, meta, dist))

        self._reply({"memories": memories, "count": col.count()})

    def _list(self, body):
        limit = int(body.get("limit", 50))
        offset = int(body.get("offset", 0))
        search = body.get("search", "").strip()
        sort_by = body.get("sort_by", "")        # date, access_count, emotion_weight, type, source
        sort_order = body.get("sort_order", "desc")  # asc or desc

        # 筛选参数
        filter_type = body.get("filter_type", "")       # event/fact/preference/note
        filter_level = body.get("filter_level", "")      # memo/memory
        filter_source = body.get("filter_source", "")    # auto/manual/aistudio/...
        filter_date_from = body.get("filter_date_from", "")
        filter_date_to = body.get("filter_date_to", "")
        filter_access_min = body.get("filter_access_min", None)
        filter_access_max = body.get("filter_access_max", None)
        filter_emotion_min = body.get("filter_emotion_min", None)
        filter_emotion_max = body.get("filter_emotion_max", None)

        total_all = col.count()

        if search:
            n = min(max(limit, 20), 200)
            search_emb = embed_cleaned(search)
            results = col.query(
                query_embeddings=[search_emb], n_results=min(n, total_all) if total_all else 1
            )
            memories = []
            for doc_id, doc, meta, dist in zip(
                results["ids"][0],
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0],
            ):
                memories.append(_memory_obj(doc_id, doc, meta, dist))
            self._reply({"memories": memories, "total": total_all, "mode": "search"})
            return

        if total_all == 0:
            self._reply({"memories": [], "total": 0, "filtered": 0, "mode": "list"})
            return

        # 构建 ChromaDB where 过滤条件
        has_filter = any([filter_type, filter_level, filter_source, filter_date_from, filter_date_to,
                          filter_access_min is not None, filter_access_max is not None,
                          filter_emotion_min is not None, filter_emotion_max is not None])
        need_sort = bool(sort_by)

        if has_filter or need_sort:
            # 需要筛选或排序：取全量后在 Python 中处理
            # ChromaDB where 只支持数值的 $gte/$lte，字符串类型用 $eq
            where_clauses = []
            if filter_type:
                where_clauses.append({"type": {"$eq": filter_type}})
            if filter_level:
                where_clauses.append({"memory_level": {"$eq": filter_level}})
            if filter_source:
                where_clauses.append({"source": {"$eq": filter_source}})
            # 数值筛选可以走 ChromaDB where
            if filter_access_min is not None:
                where_clauses.append({"access_count": {"$gte": int(filter_access_min)}})
            if filter_access_max is not None:
                where_clauses.append({"access_count": {"$lte": int(filter_access_max)}})
            if filter_emotion_min is not None:
                where_clauses.append({"emotion_weight": {"$gte": float(filter_emotion_min)}})
            if filter_emotion_max is not None:
                where_clauses.append({"emotion_weight": {"$lte": float(filter_emotion_max)}})

            where = None
            if len(where_clauses) == 1:
                where = where_clauses[0]
            elif len(where_clauses) > 1:
                where = {"$and": where_clauses}

            get_kwargs = {"include": ["documents", "metadatas"]}
            if where:
                get_kwargs["where"] = where

            results = col.get(**get_kwargs)
            all_memories = [
                _memory_obj(results["ids"][i], results["documents"][i], results["metadatas"][i])
                for i in range(len(results["ids"]))
            ]

            # 日期范围过滤：ChromaDB 不支持字符串的 $gte/$lte，在 Python 中做
            if filter_date_from:
                all_memories = [m for m in all_memories if (m.get("date") or "") >= filter_date_from]
            if filter_date_to:
                all_memories = [m for m in all_memories if (m.get("date") or "") <= filter_date_to]

            # 排序
            if sort_by:
                reverse = sort_order != "asc"
                def sort_key(m):
                    v = m.get(sort_by, "")
                    if v is None:
                        v = ""
                    if isinstance(v, str):
                        return v or ""
                    return v
                all_memories.sort(key=sort_key, reverse=reverse)

            filtered_total = len(all_memories)
            page = all_memories[offset:offset + limit]
            self._reply({"memories": page, "total": total_all, "filtered": filtered_total, "mode": "list"})
        else:
            # 无筛选无排序：直接分页取
            results = col.get(
                include=["documents", "metadatas"],
                limit=limit,
                offset=offset,
            )
            memories = [
                _memory_obj(
                    results["ids"][i], results["documents"][i], results["metadatas"][i]
                )
                for i in range(len(results["ids"]))
            ]
            self._reply({"memories": memories, "total": total_all, "filtered": total_all, "mode": "list"})

    def _meta(self, body):
        """返回所有可用的 source 和 type 值，供前端筛选下拉用"""
        total = col.count()
        if total == 0:
            self._reply({"sources": [], "types": [], "total": 0})
            return
        results = col.get(include=["metadatas"])
        sources = set()
        types = set()
        for meta in results["metadatas"]:
            s = (meta or {}).get("source", "")
            t = (meta or {}).get("type", "")
            if s:
                sources.add(s)
            if t:
                types.add(t)
        self._reply({"sources": sorted(sources), "types": sorted(types), "total": total})

    def _add(self, body):
        content = body.get("content", "").strip()
        if not content:
            self._reply({"error": "content required"}, 400)
            return

        doc_id = body.get("id") or f"manual_{int(time.time() * 1000)}"
        meta = _build_meta(body)
        emb = embed_cleaned(content)
        col.add(ids=[doc_id], documents=[content], embeddings=[emb], metadatas=[meta])
        self._reply({"ok": True, "memory": _memory_obj(doc_id, content, meta)})

    def _update(self, body):
        doc_id = body.get("id")
        if not doc_id:
            self._reply({"error": "id required"}, 400)
            return

        existing = col.get(ids=[doc_id], include=["documents", "metadatas"])
        if not existing["ids"]:
            self._reply({"error": "not found"}, 404)
            return

        old_meta = existing["metadatas"][0] or {}
        old_content = existing["documents"][0]
        new_content = body.get("content", old_content)
        new_meta = _build_meta(body, old_meta)
        if new_content != old_content:
            new_emb = embed_cleaned(new_content)
            col.upsert(
                ids=[doc_id], documents=[new_content], embeddings=[new_emb],
                metadatas=[new_meta],
            )
        else:
            col.update(ids=[doc_id], metadatas=[new_meta])
        self._reply({"ok": True, "memory": _memory_obj(doc_id, new_content, new_meta)})

    def _delete(self, body):
        doc_id = body.get("id")
        if not doc_id:
            self._reply({"error": "id required"}, 400)
            return
        col.delete(ids=[doc_id])
        self._reply({"ok": True})

    def _increment_access(self, body):
        ids = body.get("ids") or []
        if not isinstance(ids, list) or not ids:
            self._reply({"error": "ids (non-empty list) required"}, 400)
            return

        existing = col.get(ids=ids, include=["metadatas"])
        found_ids = existing["ids"]
        if not found_ids:
            self._reply({"ok": True, "updated": 0})
            return

        new_metas = []
        for meta in existing["metadatas"]:
            m = dict(meta or {})
            m["access_count"] = int(m.get("access_count", 0) or 0) + 1
            # 确保 type_weight 存在（老记忆补全）
            if "memory_type_weight" not in m:
                m["memory_type_weight"] = type_weight(m.get("type", ""))
            new_metas.append(m)

        col.update(ids=found_ids, metadatas=new_metas)
        self._reply({"ok": True, "updated": len(found_ids)})

    def _query_memos(self, body):
        """查询所有未过期的 memo（全量返回，按日期倒序）"""
        today = body.get("today", "")
        if not today:
            import datetime
            today = datetime.date.today().isoformat()

        total = col.count()
        if total == 0:
            self._reply({"memos": []})
            return

        results = col.get(
            where={"memory_level": {"$eq": "memo"}},
            include=["documents", "metadatas"],
        )
        memos = []
        for i in range(len(results["ids"])):
            meta = results["metadatas"][i] or {}
            expire = meta.get("expire", "")
            # 只返回未过期的（expire 为空或 >= today）
            if expire and expire < today:
                continue
            memos.append(_memory_obj(results["ids"][i], results["documents"][i], meta))

        # 按日期倒序
        memos.sort(key=lambda m: m.get("date", "") or "", reverse=True)
        self._reply({"memos": memos})

    def _expire_memos(self, body):
        """将过期 memo 降级为 memory，清除 expire"""
        today = body.get("today", "")
        if not today:
            import datetime
            today = datetime.date.today().isoformat()

        total = col.count()
        if total == 0:
            self._reply({"ok": True, "expired": 0})
            return

        results = col.get(
            where={"memory_level": {"$eq": "memo"}},
            include=["metadatas"],
        )

        expired_ids = []
        new_metas = []
        for i in range(len(results["ids"])):
            meta = dict(results["metadatas"][i] or {})
            expire = meta.get("expire", "")
            if expire and expire < today:
                meta["memory_level"] = "memory"
                meta["expire"] = ""
                expired_ids.append(results["ids"][i])
                new_metas.append(meta)

        if expired_ids:
            col.update(ids=expired_ids, metadatas=new_metas)
            print(f"[expire_memos] 降级 {len(expired_ids)} 条 memo → memory")

        self._reply({"ok": True, "expired": len(expired_ids)})

    def _reply(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if args and "POST" in str(args[0]):
            print(f"  {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"RAG server listening on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nRAG server stopped.")
