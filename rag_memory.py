"""
极简 RAG 记忆库
- 存储：文本 → gemini-embedding-001 向量化 → ChromaDB
- 检索：用户提问 → 向量相似度搜索 → 返回最相关片段
- 导入：支持从幕布导出的 Word 文档批量导入
"""

import os
import re
import time
import chromadb
from google import genai

# ===== 配置 =====
# API key 一律走环境变量（别硬编码进仓库；历史上这里写过明文 key，已轮换）
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
EMBED_MODEL = "gemini-embedding-001"
DB_PATH = os.path.expanduser("~/my_code/chroma_db")
COLLECTION = "memory"

if not GEMINI_API_KEY:
    raise SystemExit("缺少 GEMINI_API_KEY 环境变量（不要把它写进代码里）")
client_genai = genai.Client(api_key=GEMINI_API_KEY)


def get_embedding(text):
    """调用 Google text-embedding-004 获取向量"""
    result = client_genai.models.embed_content(model=EMBED_MODEL, contents=text)
    return result.embeddings[0].values


def get_collection():
    """获取或创建 ChromaDB 集合"""
    client = chromadb.PersistentClient(path=DB_PATH)
    return client.get_or_create_collection(name=COLLECTION)


def add(text, meta=None):
    """存入一条文本记忆"""
    col = get_collection()
    doc_id = f"doc_{col.count()}"
    embedding = get_embedding(text)
    col.add(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[text],
        metadatas=[meta or {"source": "manual"}],
    )
    print(f"[+] 已存入: {text[:60]}...  (id={doc_id})")


def add_batch(texts, metas=None):
    """批量存入"""
    col = get_collection()
    start = col.count()
    ids = [f"doc_{start + i}" for i in range(len(texts))]
    embeddings = [get_embedding(t) for t in texts]
    col.add(
        ids=ids,
        embeddings=embeddings,
        documents=texts,
        metadatas=metas or [{"source": "manual"}] * len(texts),
    )
    print(f"[+] 已批量存入 {len(texts)} 条记忆")


def query(question, top_k=3):
    """根据问题检索最相关的记忆片段"""
    col = get_collection()
    embedding = get_embedding(question)
    results = col.query(query_embeddings=[embedding], n_results=top_k)
    docs = results['documents'][0]
    dists = results['distances'][0]
    print(f"\n🔍 查询: {question}")
    print(f"   找到 {len(docs)} 条相关记忆:\n")
    for i, (doc, dist) in enumerate(zip(docs, dists)):
        score = 1 - dist  # 余弦相似度
        print(f"   [{i+1}] (相似度 {score:.3f}) {doc[:100]}")
    return docs


def count():
    """查看当前记忆数量"""
    n = get_collection().count()
    print(f"📦 当前共 {n} 条记忆")
    return n


# ===== Word 文档导入 =====

def parse_docx(filepath):
    """解析 Word 文档，返回段落列表（保留缩进层级）"""
    from docx import Document
    doc = Document(filepath)
    paragraphs = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        # 幕布导出的缩进层级：通过 paragraph indent 或 list level 判断
        level = 0
        if para.paragraph_format.left_indent:
            level = int(para.paragraph_format.left_indent / 457200)  # 每级约0.5英寸=457200 EMU
        elif para.style and para.style.name.startswith('List'):
            # 尝试从样式名提取层级
            m = re.search(r'(\d+)', para.style.name)
            if m:
                level = int(m.group(1))
        paragraphs.append({"text": text, "level": level})
    return paragraphs


def chunk_paragraphs(paragraphs, max_chars=500):
    """
    将段落按语义分块：
    - 顶级段落（level 0）作为主题分隔点
    - 子级段落归入上级主题
    - 超长块按 max_chars 切分
    """
    chunks = []
    current = []
    current_len = 0

    def flush():
        nonlocal current, current_len
        if current:
            chunks.append("\n".join(current))
            current = []
            current_len = 0

    for p in paragraphs:
        line = ("  " * p["level"]) + p["text"]
        # 遇到顶级段落且当前块非空，先保存
        if p["level"] == 0 and current:
            flush()
        # 当前块加上这行会超长，先保存
        if current_len + len(line) > max_chars and current:
            flush()
        current.append(line)
        current_len += len(line)

    flush()
    return chunks


def import_docx(filepath, max_chars=500, batch_size=20):
    """
    从 Word 文档批量导入到 RAG 记忆库
    - filepath: .docx 文件路径
    - max_chars: 每个分块的最大字符数
    - batch_size: 每批发送给 embedding API 的数量（避免限速）
    """
    filename = os.path.basename(filepath)
    print(f"📄 正在解析: {filename}")

    paragraphs = parse_docx(filepath)
    print(f"   段落数: {len(paragraphs)}")

    chunks = chunk_paragraphs(paragraphs, max_chars)
    print(f"   分块数: {len(chunks)}")
    print(f"   总字符: {sum(len(c) for c in chunks)}")
    print()

    col = get_collection()
    start_id = col.count()
    imported = 0

    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        ids = [f"doc_{start_id + imported + j}" for j in range(len(batch))]
        metas = [{"source": filename, "chunk": i + j} for j in range(len(batch))]

        # 逐条获取 embedding（避免 API 批量限制）
        embeddings = []
        for text in batch:
            embeddings.append(get_embedding(text))
            time.sleep(0.1)  # 限速保护

        col.add(ids=ids, embeddings=embeddings, documents=batch, metadatas=metas)
        imported += len(batch)
        print(f"   ✓ 已导入 {imported}/{len(chunks)} 块")

    print(f"\n✅ 完成! 从 {filename} 导入了 {imported} 个记忆块")
    return imported


def import_folder(folder, max_chars=500, batch_size=20):
    """批量导入文件夹下所有 .docx 文件"""
    files = [f for f in os.listdir(folder) if f.endswith('.docx') and not f.startswith('~')]
    print(f"📁 找到 {len(files)} 个 Word 文件\n")
    total = 0
    for f in sorted(files):
        total += import_docx(os.path.join(folder, f), max_chars, batch_size)
        print()
    print(f"🎉 全部完成! 共导入 {total} 个记忆块")


# ===== 交互模式 =====
if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--demo":
        # 演示模式：存入几条示例，然后检索
        add("Python 的 GIL 是全局解释器锁，限制了多线程的并行执行")
        add("FastAPI 是一个高性能的 Python Web 框架，基于 Starlette 和 Pydantic")
        add("ChromaDB 是一个轻量级的向量数据库，适合做语义搜索和 RAG")
        add("text-embedding-004 是 Google 推出的文本嵌入模型，输出 768 维向量")
        print()
        query("什么是向量数据库？")
        print()
        query("Python 多线程有什么限制？")
        sys.exit()

    # 导入模式
    if len(sys.argv) > 2 and sys.argv[1] == "--import":
        path = sys.argv[2]
        max_chars = int(sys.argv[3]) if len(sys.argv) > 3 else 500
        if os.path.isdir(path):
            import_folder(path, max_chars=max_chars)
        elif path.endswith('.docx'):
            import_docx(path, max_chars=max_chars)
        else:
            print("请提供 .docx 文件或包含 .docx 的文件夹路径")
        sys.exit()

    # 交互式 REPL
    print("=== RAG 记忆库 ===")
    print("命令: add <文本> | query <问题> | import <路径> | count | quit")
    print()
    while True:
        try:
            line = input(">>> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not line:
            continue
        if line == "quit":
            break
        if line == "count":
            count()
        elif line.startswith("add "):
            add(line[4:])
        elif line.startswith("import "):
            path = line[7:].strip()
            if os.path.isdir(path):
                import_folder(path)
            elif path.endswith('.docx'):
                import_docx(path)
            else:
                print("请提供 .docx 文件或包含 .docx 的文件夹路径")
        elif line.startswith("query ") or line.startswith("q "):
            question = line.split(" ", 1)[1]
            query(question)
        else:
            print("未知命令。可用: add / query / import / count / quit")
