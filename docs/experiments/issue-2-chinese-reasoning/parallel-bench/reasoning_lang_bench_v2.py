"""
DeepSeek V4 中英文推理 Token 效率对比实验 v2

改进点：
1. 移除所有 tools —— 消除 tool_call 行为差异
2. 模拟真实 Copilot Chat 结构（英文系统提示 + Chinese 前缀）
3. 使用 Pro 模型 + reasoning_effort=max
4. 记录 finish_reason 和 response 语言
5. 每场景跑 2 轮，取平均
6. KV cache 测试加长等待时间
"""

import os
import sys
import json
import time
import statistics
from pathlib import Path

# Load API key
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
    print("ERROR: DEEPSEEK_API_KEY not found")
    sys.exit(1)

client = OpenAI(api_key=API_KEY, base_url="https://api.deepseek.com")

MODEL = "deepseek-v4-pro"

# ============================================================
# 实验配置
# ============================================================
REASONING_EFFORT = "high"  # Pro max 太慢，用 high 提速
NUM_RUNS = 2  # 每个场景跑几轮取平均

# Copilot-like system prompt (simulated)
COPILOT_SYSTEM_PROMPT = (
    "You are an AI programming assistant. "
    "Help the user with coding tasks, debugging, architecture design, and other software engineering work. "
    "Provide clear, concise, and correct answers with code examples when appropriate."
)

# Chinese reasoning instruction (the proposed change)
REASONING_CN_INSTRUCTION = (
    "You MUST think and reason internally in Simplified Chinese (简体中文). "
    "Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."
)

# ============================================================
# 测试场景（全部无 tools，纯推理任务）
# ============================================================
SCENARIOS = [
    {
        "id": "code_review",
        "category": "代码审查",
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
    },
    {
        "id": "debug_error",
        "category": "错误调试",
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
    },
    {
        "id": "architecture_design",
        "category": "架构设计",
        "user": """I need to design a real-time notification system for a chat application with 100K concurrent users. The requirements are:
1. Messages must be delivered within 500ms
2. System must handle 10K messages/second peak
3. Users can be online on multiple devices
4. Offline messages must be queued and delivered when user comes online

What architecture would you recommend? Compare WebSocket vs SSE vs Long Polling, and suggest a complete tech stack.""",
    },
    {
        "id": "refactor_pattern",
        "category": "代码重构",
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
    },
    {
        "id": "algorithm_optimization",
        "category": "算法优化",
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
    },
    {
        "id": "api_integration",
        "category": "API 集成",
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
    },
    {
        "id": "database_migration",
        "category": "数据库迁移",
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
    },
    {
        "id": "security_audit",
        "category": "安全审计",
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
    },
    {
        "id": "testing_strategy",
        "category": "测试策略",
        "user": """I have a payment processing service with the following methods:
- processPayment(amount, currency, paymentMethod)
- refundPayment(transactionId, amount)
- getTransactionStatus(transactionId)

The service depends on:
- External payment gateway (Stripe-like API)
- Database for transaction records
- Email service for receipts

Write a comprehensive testing strategy. What to mock, what to integration test, and example test cases for the most critical paths.""",
    },
]

# ============================================================
# Message 构建
# ============================================================

def build_messages(scenario, use_cn_reasoning=False):
    """
    构建消息列表，模拟真实 Copilot Chat 结构：
    - EN: system = [Copilot English prompt]
    - CN: system = [Chinese reasoning instruction] + [Copilot English prompt]
    
    这样唯一变量就是是否在 Copilot 英文提示前插入中文推理指令。
    """
    if use_cn_reasoning:
        messages = [
            {"role": "system", "content": REASONING_CN_INSTRUCTION},
            {"role": "system", "content": COPILOT_SYSTEM_PROMPT},
        ]
    else:
        messages = [
            {"role": "system", "content": COPILOT_SYSTEM_PROMPT},
        ]
    messages.append({"role": "user", "content": scenario["user"]})
    return messages


# ============================================================
# 单次测试
# ============================================================

def run_single_test(scenario, use_cn_reasoning, run_label):
    """运行单次测试"""
    messages = build_messages(scenario, use_cn_reasoning)
    lang_label = "中文" if use_cn_reasoning else "英文"
    
    print(f"    [{run_label}-{lang_label}] {scenario['id']} ", end="", flush=True)
    
    start = time.time()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=32000,
            extra_body={
                "thinking": {"type": "enabled"},
                "reasoning_effort": REASONING_EFFORT,
            }
        )
        elapsed = time.time() - start
        
        usage = response.usage
        choice = response.choices[0]
        msg = choice.message
        
        reasoning_tokens = getattr(usage.completion_tokens_details, 'reasoning_tokens', 0) if usage.completion_tokens_details else 0
        content_tokens = usage.completion_tokens - reasoning_tokens
        
        # Detect output language (simple heuristic)
        content_text = msg.content or ""
        cn_chars = sum(1 for c in content_text if '\u4e00' <= c <= '\u9fff')
        total_chars = len(content_text.replace(" ", "").replace("\n", ""))
        cn_ratio = cn_chars / total_chars if total_chars > 0 else 0
        
        has_tool_calls = bool(msg.tool_calls)
        tool_call_info = None
        if has_tool_calls:
            tool_call_info = [tc.function.name for tc in msg.tool_calls]
        
        result = {
            "scenario_id": scenario["id"],
            "category": scenario["category"],
            "reasoning_lang": "cn" if use_cn_reasoning else "en",
            "run": run_label,
            "prompt_tokens": usage.prompt_tokens,
            "prompt_cache_hit": getattr(usage, 'prompt_cache_hit_tokens', 0),
            "prompt_cache_miss": getattr(usage, 'prompt_cache_miss_tokens', 0),
            "completion_tokens": usage.completion_tokens,
            "reasoning_tokens": reasoning_tokens,
            "content_tokens": content_tokens,
            "total_tokens": usage.total_tokens,
            "elapsed_seconds": round(elapsed, 1),
            "finish_reason": choice.finish_reason,
            "has_tool_calls": has_tool_calls,
            "tool_calls": tool_call_info,
            "output_cn_ratio": round(cn_ratio, 3),
            "response_preview": content_text[:150] if content_text else "(empty)",
        }
        
        print(f"→ reasoning={reasoning_tokens} content={content_tokens} finish={choice.finish_reason} cn_ratio={cn_ratio:.1%} ({elapsed:.0f}s)")
        return result
        
    except Exception as e:
        elapsed = time.time() - start
        print(f"→ ERROR: {e} ({elapsed:.0f}s)")
        return {
            "scenario_id": scenario["id"],
            "category": scenario["category"],
            "reasoning_lang": "cn" if use_cn_reasoning else "en",
            "run": run_label,
            "error": str(e),
            "elapsed_seconds": round(elapsed, 1),
        }


# ============================================================
# KV Cache 测试
# ============================================================

def run_cache_test():
    """测试 KV Cache 命中效果"""
    print("="*80)
    print("KV Cache 命中率实验 (Pro + max)")
    print("="*80)
    
    scenario = SCENARIOS[0]
    messages = build_messages(scenario, use_cn_reasoning=False)
    
    for i in range(3):
        label = "冷启动" if i == 0 else (f"+{i*30}s 后")
        print(f"\n--- {label} ---")
        start = time.time()
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=8000,
            extra_body={
                "thinking": {"type": "enabled"},
                "reasoning_effort": REASONING_EFFORT,
            }
        )
        elapsed = time.time() - start
        
        usage = response.usage
        cache_hit = getattr(usage, 'prompt_cache_hit_tokens', 0)
        cache_miss = getattr(usage, 'prompt_cache_miss_tokens', 0)
        total = usage.prompt_tokens
        
        print(f"  Prompt: {total} tokens | cache_hit={cache_hit} | cache_miss={cache_miss}")
        print(f"  Hit rate: {cache_hit/total*100:.1f}%" if total > 0 else "  Hit rate: N/A")
        print(f"  Time: {elapsed:.1f}s")
        
        if i < 2:
            wait = 30
            print(f"  (等待 {wait}s ...)")
            time.sleep(wait)


# ============================================================
# 主实验
# ============================================================

def run_main_experiment():
    """运行主实验：所有场景 × 2 语言 × N 轮"""
    all_results = []
    
    print("="*80)
    print(f"DeepSeek V4 中英文推理 Token 效率对比实验")
    print(f"模型: {MODEL} | effort={REASONING_EFFORT} | runs={NUM_RUNS} | 场景={len(SCENARIOS)}")
    print("="*80)
    
    for si, scenario in enumerate(SCENARIOS):
        print(f"\n{'#'*80}")
        print(f"## 场景 {si+1}/{len(SCENARIOS)}: {scenario['category']} ({scenario['id']})")
        print(f"{'#'*80}")
        
        # 对抗顺序效应
        if si % 2 == 0:
            # 先中文后英文
            for run in range(NUM_RUNS):
                all_results.append(run_single_test(scenario, use_cn_reasoning=True, run_label=f"R{run+1}"))
                time.sleep(2)
            for run in range(NUM_RUNS):
                all_results.append(run_single_test(scenario, use_cn_reasoning=False, run_label=f"R{run+1}"))
                time.sleep(2)
        else:
            # 先英文后中文
            for run in range(NUM_RUNS):
                all_results.append(run_single_test(scenario, use_cn_reasoning=False, run_label=f"R{run+1}"))
                time.sleep(2)
            for run in range(NUM_RUNS):
                all_results.append(run_single_test(scenario, use_cn_reasoning=True, run_label=f"R{run+1}"))
                time.sleep(2)
        
        time.sleep(3)  # 场景间间隔
    
    return all_results


def analyze_results(all_results):
    """分析结果"""
    print("\n\n" + "="*80)
    print("实验结果分析")
    print("="*80)
    
    # 过滤错误
    valid = [r for r in all_results if "error" not in r]
    errors = [r for r in all_results if "error" in r]
    if errors:
        print(f"⚠️ {len(errors)} 个请求失败: {[e['scenario_id']+'/'+e['reasoning_lang'] for e in errors]}")
    
    cn_results = [r for r in valid if r["reasoning_lang"] == "cn"]
    en_results = [r for r in valid if r["reasoning_lang"] == "en"]
    
    # 检查是否有 tool_call 污染
    tool_call_results = [r for r in valid if r.get("has_tool_calls")]
    if tool_call_results:
        print(f"⚠️ {len(tool_call_results)} 个响应包含 tool_calls (应排除):")
        for tc in tool_call_results:
            print(f"   {tc['scenario_id']}/{tc['reasoning_lang']}/{tc['run']}: finish={tc['finish_reason']} tools={tc['tool_calls']}")
    
    # 按场景聚合
    print(f"\n{'场景':<20} {'指标':<8} {'中文(R1)':>12} {'中文(R2)':>12} {'英文(R1)':>12} {'英文(R2)':>12} {'中文均值':>12} {'英文均值':>12} {'差异%':>8}")
    print("-" * 130)
    
    total_cn_r = 0
    total_en_r = 0
    total_cn_c = 0
    total_en_c = 0
    
    for scenario in SCENARIOS:
        sid = scenario["id"]
        cn_runs = [r for r in cn_results if r["scenario_id"] == sid]
        en_runs = [r for r in en_results if r["scenario_id"] == sid]
        
        if len(cn_runs) < NUM_RUNS or len(en_runs) < NUM_RUNS:
            print(f"{scenario['category']:<20} (数据不完整，跳过)")
            continue
        
        cn_r_vals = [r["reasoning_tokens"] for r in cn_runs]
        en_r_vals = [r["reasoning_tokens"] for r in en_runs]
        cn_c_vals = [r["content_tokens"] for r in cn_runs]
        en_c_vals = [r["content_tokens"] for r in en_runs]
        
        cn_r_mean = statistics.mean(cn_r_vals)
        en_r_mean = statistics.mean(en_r_vals)
        cn_c_mean = statistics.mean(cn_c_vals)
        en_c_mean = statistics.mean(en_c_vals)
        
        diff_pct = (cn_r_mean - en_r_mean) / en_r_mean * 100 if en_r_mean > 0 else 0
        
        print(f"{scenario['category']:<20} {'Reason':<8} {cn_r_vals[0]:>12,} {cn_r_vals[1] if len(cn_r_vals)>1 else 'N/A':>12} {en_r_vals[0]:>12,} {en_r_vals[1] if len(en_r_vals)>1 else 'N/A':>12} {cn_r_mean:>12,.0f} {en_r_mean:>12,.0f} {diff_pct:>+7.1f}%")
        print(f"{'':<20} {'Content':<8} {cn_c_vals[0]:>12,} {cn_c_vals[1] if len(cn_c_vals)>1 else 'N/A':>12} {en_c_vals[0]:>12,} {en_c_vals[1] if len(en_c_vals)>1 else 'N/A':>12} {cn_c_mean:>12,.0f} {en_c_mean:>12,.0f}")
        
        total_cn_r += cn_r_mean
        total_en_r += en_r_mean
        total_cn_c += cn_c_mean
        total_en_c += en_c_mean
    
    print("-" * 130)
    total_diff = (total_cn_r - total_en_r) / total_en_r * 100 if total_en_r > 0 else 0
    print(f"{'总计':<20} {'Reason':<8} {'':>12} {'':>12} {'':>12} {'':>12} {total_cn_r:>12,.0f} {total_en_r:>12,.0f} {total_diff:>+7.1f}%")
    print(f"{'':<20} {'Content':<8} {'':>12} {'':>12} {'':>12} {'':>12} {total_cn_c:>12,.0f} {total_en_c:>12,.0f}")
    
    # 检查输出语言
    cn_output_lang = [r for r in cn_results if r.get("output_cn_ratio", 0) > 0.5]
    en_output_lang = [r for r in en_results if r.get("output_cn_ratio", 0) > 0.5]
    print(f"\n输出语言检测:")
    print(f"  中文推理 → 输出含中文比例 >50%: {len(cn_output_lang)}/{len(cn_results)} (均以中文输出)")
    print(f"  英文推理 → 输出含中文比例 >50%: {len(en_output_lang)}/{len(en_results)} (全部英文输出)")
    
    # 汇总
    print(f"\n{'='*80}")
    print("汇总结论")
    print(f"{'='*80}")
    
    avg_cn_prompt = statistics.mean([r["prompt_tokens"] for r in cn_results])
    avg_en_prompt = statistics.mean([r["prompt_tokens"] for r in en_results])
    avg_cn_time = statistics.mean([r["elapsed_seconds"] for r in cn_results])
    avg_en_time = statistics.mean([r["elapsed_seconds"] for r in en_results])
    
    print(f"  Token 效率:")
    print(f"    中文 reasoning 均值: {total_cn_r/len(SCENARIOS):,.0f} tokens/场景")
    print(f"    英文 reasoning 均值: {total_en_r/len(SCENARIOS):,.0f} tokens/场景")
    print(f"    差异: {total_diff:+.1f}%")
    print(f"    → {'中文 reasoning 更省 ✅' if total_cn_r < total_en_r else '英文 reasoning 更省 ❌'}")
    
    print(f"\n  Prompt 开销:")
    print(f"    中文 prompt 均值: {avg_cn_prompt:.0f} tokens (多一条 system message)")
    print(f"    英文 prompt 均值: {avg_en_prompt:.0f} tokens")
    print(f"    固定开销: {avg_cn_prompt - avg_en_prompt:.0f} tokens")
    
    print(f"\n  耗时:")
    print(f"    中文均值: {avg_cn_time:.1f}s")
    print(f"    英文均值: {avg_en_time:.1f}s")
    
    # 经济学
    print(f"\n{'='*80}")
    print("经济学分析 (Pro, 折扣期)")
    print(f"{'='*80}")
    
    cache_hit_usd = 0.0145  # per M tokens
    cache_miss_usd = 0.435
    output_usd = 0.87
    
    avg_reasoning_diff = (total_en_r - total_cn_r) / len(SCENARIOS)
    avg_prompt_overhead = avg_cn_prompt - avg_en_prompt
    
    # EN cost (cache hit)
    en_cost = (avg_en_prompt / 1_000_000 * cache_hit_usd + 
               total_en_r / len(SCENARIOS) / 1_000_000 * output_usd)
    
    # CN cost (cache miss - first request)
    cn_cost_miss = (avg_cn_prompt / 1_000_000 * cache_miss_usd + 
                    total_cn_r / len(SCENARIOS) / 1_000_000 * output_usd)
    
    # CN cost (cache hit - subsequent)
    cn_cost_hit = (avg_cn_prompt / 1_000_000 * cache_hit_usd + 
                   total_cn_r / len(SCENARIOS) / 1_000_000 * output_usd)
    
    print(f"  英文版 (cache hit):  ${en_cost:.6f}/request")
    print(f"  中文版 (cache miss): ${cn_cost_miss:.6f}/request ({'更贵' if cn_cost_miss > en_cost else '更便宜'} {abs(cn_cost_miss - en_cost)/en_cost*100:.0f}%)")
    print(f"  中文版 (cache hit):  ${cn_cost_hit:.6f}/request ({'更贵' if cn_cost_hit > en_cost else '更便宜'} {abs(cn_cost_hit - en_cost)/en_cost*100:.0f}%)")
    
    # Save results
    output_path = Path(__file__).parent / "bench_results_v2.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({
            "model": MODEL,
            "settings": {"reasoning_effort": REASONING_EFFORT, "runs": NUM_RUNS},
            "num_scenarios": len(SCENARIOS),
            "results": all_results,
            "summary": {
                "avg_cn_reasoning": total_cn_r / len(SCENARIOS),
                "avg_en_reasoning": total_en_r / len(SCENARIOS),
                "reasoning_diff_pct": total_diff,
                "avg_cn_content": total_cn_c / len(SCENARIOS),
                "avg_en_content": total_en_c / len(SCENARIOS),
                "avg_prompt_overhead": avg_prompt_overhead,
                "cost_en": en_cost,
                "cost_cn_miss": cn_cost_miss,
                "cost_cn_hit": cn_cost_hit,
            }
        }, f, indent=2, ensure_ascii=False)
    print(f"\n详细结果: {output_path}")


if __name__ == "__main__":
    run_cache_test()
    print("\n")
    results = run_main_experiment()
    analyze_results(results)
