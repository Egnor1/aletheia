"""
对 core_candidates.json 做两遍 DeepSeek 粗筛：
  Pass 1: 按主题分类（固定 8 类）
  Pass 2: 每类内部挑选最具代表性、最稳定的 3-5 条
输出: core_shortlist.json (约 30-50 条，供人工最终筛 10-20)
"""

import os
import json
import time
import random
from collections import defaultdict
from openai import OpenAI

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

HERE = os.path.dirname(os.path.abspath(__file__))
INPUT = os.path.join(HERE, "core_candidates.json")
OUTPUT = os.path.join(HERE, "core_shortlist.json")

CATEGORIES = [
    "身份背景",   # 年龄/职业/来源/学历等
    "关系",       # 家人/朋友/伴侣/宠物
    "偏好品味",   # 喜欢/讨厌的东西
    "价值观信念", # 信念/态度/立场
    "习惯生活方式", # 作息/饮食/日常
    "技能专长",   # 会什么/在学什么
    "目标规划",   # 想做什么/计划
    "其他",
]

BATCH_SIZE_PASS1 = 40
PER_CATEGORY_KEEP = 5

CLASSIFY_PROMPT = f"""你会收到一个 JSON 数组，每项是一条关于"生生"这个人的记忆。
请为每条记忆归类到以下 8 类之一：
{chr(10).join('- ' + c for c in CATEGORIES)}

严格输出 JSON 数组，每项 {{"id": "...", "category": "..."}}。顺序与输入一致。不要输出其他内容。"""

SELECT_PROMPT = """你会收到同一主题下的多条关于"生生"的记忆。
请挑选最具代表性、最稳定、最不会随时间改变的 {n} 条作为核心事实。
要求：
- 避免内容重复/雷同（相似的只保留信息量最大的一条）
- 避免明显的一次性事件或短期感想
- 优先保留可以长期定义生生这个人的信息

严格输出 JSON 数组，每项 {{"id": "...", "reason": "一句话为什么选它"}}，共 {n} 条或更少。不要输出其他内容。"""


def extract_json(raw):
    import re
    m = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)
    return json.loads(raw)


def call_deepseek(client, system_prompt, user_content):
    resp = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        temperature=0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return extract_json(resp.choices[0].message.content.strip())


def pass1_classify(client, items):
    """分批分类，返回 id -> category"""
    id_to_cat = {}
    total_batches = (len(items) + BATCH_SIZE_PASS1 - 1) // BATCH_SIZE_PASS1

    for batch_idx in range(0, len(items), BATCH_SIZE_PASS1):
        batch = items[batch_idx:batch_idx + BATCH_SIZE_PASS1]
        batch_num = batch_idx // BATCH_SIZE_PASS1 + 1
        print(f"[Pass 1 {batch_num}/{total_batches}] 分类 {len(batch)} 条...")

        payload = [{"id": it["id"], "content": it["content"]} for it in batch]
        try:
            result = call_deepseek(client, CLASSIFY_PROMPT, json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            print(f"  ❌ 失败: {e}，降级全部归入'其他'")
            for it in batch:
                id_to_cat[it["id"]] = "其他"
            time.sleep(2)
            continue

        for r in result:
            cat = r.get("category", "其他")
            if cat not in CATEGORIES:
                cat = "其他"
            id_to_cat[r["id"]] = cat

        time.sleep(random.uniform(1, 2))

    return id_to_cat


def pass2_select(client, category, items, keep):
    """从同一类中挑 keep 条代表"""
    if len(items) <= keep:
        return [{"id": it["id"], "reason": "类内条数已少于目标，全部保留"} for it in items]

    print(f"[Pass 2] {category}: 从 {len(items)} 条中挑 {keep} 条...")
    payload = [{"id": it["id"], "content": it["content"]} for it in items]
    try:
        result = call_deepseek(
            client,
            SELECT_PROMPT.format(n=keep),
            json.dumps(payload, ensure_ascii=False),
        )
    except Exception as e:
        print(f"  ❌ 失败: {e}，回退为取前 {keep} 条")
        return [{"id": items[i]["id"], "reason": "fallback"} for i in range(keep)]

    return result


def main():
    if not DEEPSEEK_API_KEY:
        print("错误: 请设置 DEEPSEEK_API_KEY 环境变量")
        return

    with open(INPUT, "r", encoding="utf-8") as f:
        items = json.load(f)
    print(f"读入 {len(items)} 条候选")

    client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=60)

    # Pass 1
    id_to_cat = pass1_classify(client, items)

    # 按类分组
    by_cat = defaultdict(list)
    id_to_item = {it["id"]: it for it in items}
    for doc_id, cat in id_to_cat.items():
        by_cat[cat].append(id_to_item[doc_id])

    print("\n分类统计:")
    for cat in CATEGORIES:
        print(f"  {cat}: {len(by_cat[cat])} 条")
    print()

    # Pass 2
    shortlist = []
    for cat in CATEGORIES:
        if not by_cat[cat]:
            continue
        selected = pass2_select(client, cat, by_cat[cat], PER_CATEGORY_KEEP)
        for s in selected:
            item = id_to_item.get(s["id"])
            if item:
                shortlist.append({
                    "id": item["id"],
                    "content": item["content"],
                    "type": item["type"],
                    "date": item["date"],
                    "category": cat,
                    "reason": s.get("reason", ""),
                })
        time.sleep(random.uniform(1, 2))

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(shortlist, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 完成: {OUTPUT}")
    print(f"   粗筛结果: {len(shortlist)} 条")
    print(f"   下一步: 人工从中挑 10-20 条为 core_facts.json")


if __name__ == "__main__":
    main()
