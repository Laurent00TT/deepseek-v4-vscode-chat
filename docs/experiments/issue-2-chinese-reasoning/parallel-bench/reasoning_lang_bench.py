"""
DeepSeek V4 中英文推理 Token 效率对比实验

实验目的：
1. 测量同等编程场景下，中文 vs 英文系统提示对 reasoning_tokens 的影响
2. 测量 KV cache hit/miss 的经济影响
3. 模拟 Copilot Chat 真实工作负载（代码 + 工具调用）

使用方法：
  python experiments/reasoning_lang_bench.py
  需要环境变量 DEEPSEEK_API_KEY 或在 ai-agent-learning/.env 中设置
"""

import os
import sys
import json
import time
from pathlib import Path

# Load .env from parent project
env_path = Path(__file__).parent.parent.parent / "ai-agent-learning" / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

from openai import OpenAI

API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not API_KEY:
    print("ERROR: DEEPSEEK_API_KEY not found in environment or .env file")
    sys.exit(1)

client = OpenAI(api_key=API_KEY, base_url="https://api.deepseek.com")

MODEL = "deepseek-v4-flash"  # 使用 Flash 模型（更快、更便宜）

# ============================================================
# 实验场景：模拟 Copilot Chat 的真实工作负载
# ============================================================
# 每个场景包含：
#   - system_en / system_cn: 英文/中文系统提示
#   - user: 用户问题
#   - tools: 可用的工具定义（模拟 Copilot 的工具集）
#   - category: 场景分类

SCENARIOS = [
    {
        "id": "code_review",
        "category": "代码审查",
        "system_en": "You are an AI programming assistant. Help the user with coding tasks.",
        "system_cn": "你是一个 AI 编程助手。帮助用户完成编码任务。",
        "user": """Review this TypeScript function for potential bugs and suggest improvements:

```typescript
async function fetchUserData(userId: string): Promise<User | null> {
    const response = await fetch(`/api/users/${userId}`);
    const data = await response.json();
    if (data.status === 'active') {
        return data;
    }
    return null;
}
```

What issues do you see and how would you fix them?""",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read the contents of a file",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
                }
            }
        ]
    },
    {
        "id": "debug_error",
        "category": "错误调试",
        "system_en": "You are an AI programming assistant. Help the user debug code issues.",
        "system_cn": "你是一个 AI 编程助手。帮助用户调试代码问题。",
        "user": """I'm getting this error in my Python application:

```
TypeError: 'NoneType' object is not subscriptable
  File "app.py", line 47, in process_order
    customer_name = order['customer']['name']
```

Here's the relevant code:
```python
def process_order(order_id):
    order = db.orders.find_one({'_id': order_id})
    customer_name = order['customer']['name']
    return f"Processing order for {customer_name}"
```

What's wrong and how do I fix it?""",
        "tools": [
            {"type": "function", "function": {"name": "read_file", "description": "Read file contents", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
            {"type": "function", "function": {"name": "search_code", "description": "Search codebase", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}}
        ]
    },
    {
        "id": "architecture_design",
        "category": "架构设计",
        "system_en": "You are an AI programming assistant. Help the user design software architecture.",
        "system_cn": "你是一个 AI 编程助手。帮助用户设计软件架构。",
        "user": """I need to design a real-time notification system for a chat application with 100K concurrent users. The requirements are:
1. Messages must be delivered within 500ms
2. System must handle 10K messages/second peak
3. Users can be online on multiple devices
4. Offline messages must be queued and delivered when user comes online

What architecture would you recommend? Compare WebSocket vs SSE vs Long Polling, and suggest a complete tech stack.""",
        "tools": []
    },
    {
        "id": "refactor_pattern",
        "category": "代码重构",
        "system_en": "You are an AI programming assistant. Help the user refactor code.",
        "system_cn": "你是一个 AI 编程助手。帮助用户重构代码。",
        "user": """Refactor this React component to use modern patterns (custom hooks, proper TypeScript typing, error boundaries):

```tsx
class UserProfile extends React.Component {
  constructor(props) {
    super(props);
    this.state = { user: null, loading: true, error: null };
  }
  
  componentDidMount() {
    fetch('/api/user/' + this.props.userId)
      .then(r => r.json())
      .then(user => this.setState({ user, loading: false }))
      .catch(error => this.setState({ error: error.message, loading: false }));
  }
  
  render() {
    if (this.state.loading) return <div>Loading...</div>;
    if (this.state.error) return <div>Error: {this.state.error}</div>;
    return <div>{this.state.user.name}</div>;
  }
}
```

Show the refactored version with explanations.""",
        "tools": [
            {"type": "function", "function": {"name": "read_file", "description": "Read file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}
        ]
    },
    {
        "id": "algorithm_optimization",
        "category": "算法优化",
        "system_en": "You are an AI programming assistant. Help the user optimize algorithms.",
        "system_cn": "你是一个 AI 编程助手。帮助用户优化算法。",
        "user": """I have a function that finds duplicate files in a directory by comparing file content hashes. It's O(n²) and takes 45 seconds for 100K files. How can I optimize it?

```python
def find_duplicates(directory):
    files = list(Path(directory).rglob('*'))
    duplicates = []
    for i in range(len(files)):
        for j in range(i+1, len(files)):
            if hash_file(files[i]) == hash_file(files[j]):
                duplicates.append((files[i], files[j]))
    return duplicates
```

Propose at least 3 optimization strategies with complexity analysis.""",
        "tools": []
    },
    {
        "id": "api_integration",
        "category": "API 集成",
        "system_en": "You are an AI programming assistant. Help the user integrate external APIs.",
        "system_cn": "你是一个 AI 编程助手。帮助用户集成外部 API。",
        "user": """I need to implement OAuth 2.0 PKCE flow in a Node.js backend. The auth provider's docs say:
- Authorization endpoint: https://auth.example.com/authorize
- Token endpoint: https://auth.example.com/token
- Requires code_challenge (SHA256) and code_verifier (random 43-128 chars)

Write the complete implementation with:
1. Generate code_verifier and code_challenge
2. Build authorization URL
3. Exchange code for tokens
4. Refresh token logic
5. Error handling for all edge cases""",
        "tools": [
            {"type": "function", "function": {"name": "read_file", "description": "Read file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}
        ]
    },
    {
        "id": "testing_strategy",
        "category": "测试策略",
        "system_en": "You are an AI programming assistant. Help the user write tests.",
        "system_cn": "你是一个 AI 编程助手。帮助用户编写测试。",
        "user": """I have a payment processing service with the following methods:
- processPayment(amount, currency, paymentMethod)
- refundPayment(transactionId, amount)
- getTransactionStatus(transactionId)

The service depends on:
- External payment gateway (Stripe-like API)
- Database for transaction records
- Email service for receipts

Write a comprehensive testing strategy. What to mock, what to integration test, and example test cases for the most critical paths.""",
        "tools": []
    },
    {
        "id": "database_migration",
        "category": "数据库迁移",
        "system_en": "You are an AI programming assistant. Help the user with database operations.",
        "system_cn": "你是一个 AI 编程助手。帮助用户进行数据库操作。",
        "user": """We need to migrate a PostgreSQL database from single-table design to a normalized schema with zero downtime. Current table has 50M rows:

```sql
-- Current schema (single table)
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_name TEXT,
    customer_email TEXT,
    customer_address TEXT,
    product_name TEXT,
    product_price DECIMAL,
    quantity INTEGER,
    created_at TIMESTAMP
);
```

Target schema:
```sql
CREATE TABLE customers (id, name, email, address);
CREATE TABLE products (id, name, price);
CREATE TABLE orders (id, customer_id, product_id, quantity, created_at);
```

Design a zero-downtime migration strategy. Include rollback plan, data validation, and how to handle writes during migration.""",
        "tools": []
    },
    {
        "id": "security_audit",
        "category": "安全审计",
        "system_en": "You are an AI programming assistant. Help the user with security.",
        "system_cn": "你是一个 AI 编程助手。帮助用户处理安全问题。",
        "user": """Audit this Express.js authentication middleware for security vulnerabilities:

```javascript
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    if (user && bcrypt.compareSync(password, user.password_hash)) {
        const token = jwt.sign({ id: user.id, role: user.role }, 'secret123');
        res.cookie('token', token);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Invalid credentials' });
    }
});
```

Identify ALL security issues and provide fixes. Consider OWASP Top 10.""",
        "tools": []
    },
    {
        "id": "performance_profiling",
        "category": "性能分析",
        "system_en": "You are an AI programming assistant. Help the user with performance optimization.",
        "system_cn": "你是一个 AI 编程助手。帮助用户优化性能。",
        "user": """Our React app's initial load is 4.2 seconds. The bundle analysis shows:
- main.js: 1.8MB (parsed)
- vendor.js: 2.1MB (includes moment.js, lodash, antd)
- styles.css: 450KB

The app uses:
- React 18 with Create React App
- Ant Design component library
- moment.js for dates
- lodash for utilities
- Redux for state management

Provide a concrete optimization plan with expected improvements for each change. Include code splitting, tree shaking, and lighter alternatives to heavy libraries.""",
        "tools": []
    }
]

# ============================================================
# Chinese reasoning system prompt (the proposed change)
# ============================================================
REASONING_CN_PROMPT = "You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."

# ============================================================
# Experiment
# ============================================================

def build_messages(scenario, use_cn_reasoning=False):
    """构建消息列表，模拟 Copilot Chat 结构"""
    system_content = scenario["system_cn"] if use_cn_reasoning else scenario["system_en"]
    messages = [
        {"role": "system", "content": system_content},
    ]
    # 如果使用中文推理，在前面插入额外的中文推理提示
    if use_cn_reasoning:
        messages.insert(0, {"role": "system", "content": REASONING_CN_PROMPT})
    messages.append({"role": "user", "content": scenario["user"]})
    return messages


def run_single_test(scenario, use_cn_reasoning, label):
    """运行单次测试并返回结果"""
    messages = build_messages(scenario, use_cn_reasoning)
    tools = scenario["tools"] if scenario["tools"] else None
    
    print(f"\n{'='*60}")
    print(f"[{label}] {scenario['category']}: {scenario['id']}")
    print(f"  推理语言: {'中文' if use_cn_reasoning else '英文'}")
    print(f"  工具数: {len(scenario['tools'])}")
    
    start = time.time()
    try:
        kwargs = {
            "model": MODEL,
            "messages": messages,
            "max_tokens": 32000,  # 足够大以保证完整推理链
            "extra_body": {
                "thinking": {"type": "enabled"},
                "reasoning_effort": "high",
            }
        }
        if tools:
            kwargs["tools"] = tools
        
        response = client.chat.completions.create(**kwargs)
        elapsed = time.time() - start
        
        usage = response.usage
        reasoning_tokens = usage.completion_tokens_details.reasoning_tokens if usage.completion_tokens_details else 0
        content_tokens = usage.completion_tokens_details.reasoning_tokens if usage.completion_tokens_details else 0
        actual_content = usage.completion_tokens - reasoning_tokens if usage.completion_tokens else 0
        
        result = {
            "scenario_id": scenario["id"],
            "category": scenario["category"],
            "reasoning_lang": "cn" if use_cn_reasoning else "en",
            "prompt_tokens": usage.prompt_tokens,
            "prompt_cache_hit": getattr(usage, 'prompt_cache_hit_tokens', 0),
            "prompt_cache_miss": getattr(usage, 'prompt_cache_miss_tokens', 0),
            "completion_tokens": usage.completion_tokens,
            "reasoning_tokens": reasoning_tokens,
            "content_tokens": actual_content,
            "total_tokens": usage.total_tokens,
            "elapsed_seconds": round(elapsed, 1),
            "finish_reason": response.choices[0].finish_reason if response.choices else "unknown",
            "response_preview": (response.choices[0].message.content or "")[:200] if response.choices else "",
        }
        
        print(f"  Prompt: {usage.prompt_tokens} tokens (cache hit: {result['prompt_cache_hit']})")
        print(f"  Reasoning: {reasoning_tokens} tokens")
        print(f"  Content: {actual_content} tokens")
        print(f"  Completion: {usage.completion_tokens} tokens")
        print(f"  Time: {elapsed:.1f}s")
        
        return result
    except Exception as e:
        elapsed = time.time() - start
        print(f"  ERROR after {elapsed:.1f}s: {e}")
        return {
            "scenario_id": scenario["id"],
            "category": scenario["category"],
            "reasoning_lang": "cn" if use_cn_reasoning else "en",
            "error": str(e),
            "elapsed_seconds": round(elapsed, 1),
        }


def run_all_tests():
    """运行所有测试"""
    results = []
    
    print("="*80)
    print("DeepSeek V4 中英文推理 Token 效率对比实验")
    print(f"模型: {MODEL} | reasoning_effort=high | 场景数: {len(SCENARIOS)}")
    print("="*80)
    
    for i, scenario in enumerate(SCENARIOS[:5]):
        print(f"\n{'#'*80}")
        print(f"## 实验 {i+1}/{len(SCENARIOS)}: {scenario['category']}")
        print(f"{'#'*80}")
        
        # 对抗顺序效应：交替进行中英文测试
        # 一半场景先测中文，一半先测英文
        if i % 2 == 0:
            results.append(run_single_test(scenario, use_cn_reasoning=True, label="A-CN"))
            time.sleep(1)  # 避免 rate limit
            results.append(run_single_test(scenario, use_cn_reasoning=False, label="B-EN"))
        else:
            results.append(run_single_test(scenario, use_cn_reasoning=False, label="A-EN"))
            time.sleep(1)
            results.append(run_single_test(scenario, use_cn_reasoning=True, label="B-CN"))
        
        time.sleep(2)  # 场景间隔
    
    return results


def analyze_results(results):
    """分析实验结果"""
    print("\n\n" + "="*80)
    print("实验结果分析")
    print("="*80)
    
    # 分离中英文结果
    cn_results = [r for r in results if r.get("reasoning_lang") == "cn" and "error" not in r]
    en_results = [r for r in results if r.get("reasoning_lang") == "en" and "error" not in r]
    
    if not cn_results or not en_results:
        print("ERROR: Not enough valid results for comparison")
        return
    
    # 按场景配对
    pairs = []
    for scenario in SCENARIOS:
        cn = next((r for r in cn_results if r["scenario_id"] == scenario["id"]), None)
        en = next((r for r in en_results if r["scenario_id"] == scenario["id"]), None)
        if cn and en:
            pairs.append((scenario, cn, en))
    
    print(f"\n成功配对场景: {len(pairs)}/{len(SCENARIOS)}")
    
    # 详细对比表
    print(f"\n{'场景':<20} {'中文Reasoning':>12} {'英文Reasoning':>12} {'差异':>10} {'节省%':>8} {'中文Content':>12} {'英文Content':>12}")
    print("-" * 90)
    
    total_cn_reasoning = 0
    total_en_reasoning = 0
    total_cn_content = 0
    total_en_content = 0
    total_cn_prompt = 0
    total_en_prompt = 0
    total_cn_time = 0
    total_en_time = 0
    
    for scenario, cn, en in pairs:
        cn_r = cn["reasoning_tokens"]
        en_r = en["reasoning_tokens"]
        diff = cn_r - en_r
        pct = (diff / en_r * 100) if en_r > 0 else 0
        
        print(f"{scenario['category']:<20} {cn_r:>12,} {en_r:>12,} {diff:>+10,} {pct:>+7.1f}% {cn['content_tokens']:>12,} {en['content_tokens']:>12,}")
        
        total_cn_reasoning += cn_r
        total_en_reasoning += en_r
        total_cn_content += cn["content_tokens"]
        total_en_content += en["content_tokens"]
        total_cn_prompt += cn["prompt_tokens"]
        total_en_prompt += en["prompt_tokens"]
        total_cn_time += cn["elapsed_seconds"]
        total_en_time += en["elapsed_seconds"]
    
    print("-" * 90)
    total_diff = total_cn_reasoning - total_en_reasoning
    total_pct = (total_diff / total_en_reasoning * 100) if total_en_reasoning > 0 else 0
    print(f"{'总计':<20} {total_cn_reasoning:>12,} {total_en_reasoning:>12,} {total_diff:>+10,} {total_pct:>+7.1f}% {total_cn_content:>12,} {total_en_content:>12,}")
    
    # 汇总统计
    print(f"\n{'='*80}")
    print("汇总统计")
    print(f"{'='*80}")
    print(f"  Reasoning tokens 比较:")
    print(f"    中文总计: {total_cn_reasoning:,}")
    print(f"    英文总计: {total_en_reasoning:,}")
    print(f"    差异: {total_diff:+,} ({total_pct:+.1f}%)")
    print(f"    结论: {'中文更省' if total_cn_reasoning < total_en_reasoning else '英文更省'}")
    
    print(f"\n  Content tokens 比较:")
    print(f"    中文总计: {total_cn_content:,}")
    print(f"    英文总计: {total_en_content:,}")
    
    print(f"\n  Prompt tokens 比较:")
    print(f"    中文总计: {total_cn_prompt:,} (多一条 system message)")
    print(f"    英文总计: {total_en_prompt:,}")
    
    print(f"\n  耗时比较:")
    print(f"    中文总计: {total_cn_time:.1f}s ({total_cn_time/len(pairs):.1f}s avg)")
    print(f"    英文总计: {total_en_time:.1f}s ({total_en_time/len(pairs):.1f}s avg)")
    
    # 经济学分析
    print(f"\n{'='*80}")
    print("经济学分析 (Pro 模型, 折扣期价格)")
    print(f"{'='*80}")
    
    # 使用实际测量的 prompt token 差异
    avg_prompt_diff = (total_cn_prompt - total_en_prompt) / len(pairs)
    avg_reasoning_savings = (total_en_reasoning - total_cn_reasoning) / len(pairs)
    
    print(f"  平均每请求额外 prompt tokens (中文推理提示): {avg_prompt_diff:.0f}")
    print(f"  平均每请求节省 reasoning tokens: {avg_reasoning_savings:.0f}")
    
    # 假设典型场景: 5000 prompt + 8000 reasoning
    # 计算实际成本
    cache_hit_price = 0.0145  # per M tokens (discount price)
    cache_miss_price = 0.435   # per M tokens (discount price)
    output_price = 0.87        # per M tokens (discount price)
    
    # 不加中文推理: prompt 全 cache hit
    en_cost = (total_en_prompt/1_000_000 * cache_hit_price + 
               total_en_reasoning/1_000_000 * output_price) / len(pairs)
    
    # 加中文推理: prompt cache miss (新前缀)
    cn_cost = (total_cn_prompt/1_000_000 * cache_miss_price + 
               total_cn_reasoning/1_000_000 * output_price) / len(pairs)
    
    print(f"\n  平均每请求成本:")
    print(f"    不加中文推理 (cache hit): ${en_cost:.6f}")
    print(f"    加中文推理 (cache miss):  ${cn_cost:.6f}")
    print(f"    差异: ${cn_cost - en_cost:+.6f}")
    
    if cn_cost > en_cost:
        # 计算回本所需的轮数
        # 第2轮开始 cache hit
        cn_cost_round2 = (total_cn_prompt/1_000_000 * cache_hit_price + 
                          total_cn_reasoning/1_000_000 * output_price) / len(pairs)
        breakeven = (cn_cost - en_cost) / (en_cost - cn_cost_round2) + 1
        print(f"\n  第2轮起 (cache hit 后) 成本: ${cn_cost_round2:.6f}")
        print(f"  盈亏平衡点在 ~{breakeven:.1f} 轮对话")
        if breakeven > 10:
            print(f"  ⚠️ 需要 {breakeven:.0f} 轮才能回本 — 大多数 Copilot 对话达不到")
        else:
            print(f"  多轮对话场景下经济可行")
    
    # 保存详细结果
    output_path = Path(__file__).parent / "bench_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({
            "model": MODEL,
            "settings": {"reasoning_effort": "high"},
            "results": results,
            "summary": {
                "total_cn_reasoning": total_cn_reasoning,
                "total_en_reasoning": total_en_reasoning,
                "reasoning_savings_pct": total_pct,
                "total_cn_content": total_cn_content,
                "total_en_content": total_en_content,
                "total_cn_prompt": total_cn_prompt,
                "total_en_prompt": total_en_prompt,
                "avg_prompt_overhead": avg_prompt_diff,
                "avg_reasoning_savings": avg_reasoning_savings,
                "cost_cn_per_request": cn_cost,
                "cost_en_per_request": en_cost,
            }
        }, f, indent=2, ensure_ascii=False)
    print(f"\n详细结果已保存到: {output_path}")


def run_cache_test():
    """测试 KV Cache 命中效果"""
    print("\n\n" + "="*80)
    print("KV Cache 命中率实验")
    print("="*80)
    
    scenario = SCENARIOS[0]  # 用第一个场景
    messages = build_messages(scenario, use_cn_reasoning=False)
    
    print("\n发送相同请求 2 次，观察 cache hit 差异...")
    
    for i in range(2):
        print(f"\n--- 第 {i+1} 次请求 ---")
        start = time.time()
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=16000,
            extra_body={
                "thinking": {"type": "enabled"},
                "reasoning_effort": "high",
            }
        )
        elapsed = time.time() - start
        
        usage = response.usage
        prompt_tokens = usage.prompt_tokens
        cache_hit = getattr(usage, 'prompt_cache_hit_tokens', 0)
        cache_miss = getattr(usage, 'prompt_cache_miss_tokens', 0)
        
        print(f"  Prompt tokens: {prompt_tokens}")
        print(f"  Cache hit: {cache_hit}")
        print(f"  Cache miss: {cache_miss}")
        print(f"  Hit rate: {cache_hit/prompt_tokens*100:.1f}%" if prompt_tokens > 0 else "  Hit rate: N/A")
        print(f"  Time: {elapsed:.1f}s")
        
        # 估算成本
        cost = (cache_hit/1_000_000 * 0.0145 + cache_miss/1_000_000 * 0.435)
        print(f"  Prompt cost: ${cost:.6f}")
        
        if i == 0:
            print("  (等待 5 秒让 cache 生效...)")
            time.sleep(5)


if __name__ == "__main__":
    # 先跑 KV Cache 测试
    run_cache_test()
    
    # 再跑主实验
    results = run_all_tests()
    analyze_results(results)
