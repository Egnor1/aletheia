"""
共享的 embedding 模块
- 模型：BAAI/bge-small-zh-v1.5（512 维，本地 CPU）
- 内置人称前缀清洗（"生生"/"Daemon"）
- 提供 Chroma EmbeddingFunction 包装与便捷 helper
"""

import re
from chromadb.api.types import EmbeddingFunction, Documents, Embeddings
from sentence_transformers import SentenceTransformer

MODEL_NAME = "BAAI/bge-small-zh-v1.5"
EMBEDDING_DIM = 512

_PRONOUN_PREFIX_RE = re.compile(r'^(生生|Daemon)+')


def clean_for_embedding(text):
    if not text:
        return ""
    cleaned = _PRONOUN_PREFIX_RE.sub('', text).strip()
    return cleaned or text


class BGEEmbeddingFunction(EmbeddingFunction):
    def __init__(self):
        self.model = SentenceTransformer(MODEL_NAME)

    def __call__(self, input: Documents) -> Embeddings:
        cleaned = [clean_for_embedding(t) for t in input]
        embs = self.model.encode(cleaned, normalize_embeddings=True)
        return embs.tolist()

    @staticmethod
    def name():
        return "bge-small-zh-v1.5"


_ef = None


def get_ef():
    global _ef
    if _ef is None:
        _ef = BGEEmbeddingFunction()
    return _ef


def embed_cleaned(text):
    return get_ef()([text])[0]


def embed_cleaned_batch(texts):
    return get_ef()(list(texts))
