// Integration test: verify that reasoning_content="" fallback prevents 400.
//
// DeepSeek thinking mode requires every prior assistant turn to carry
// reasoning_content. When the ReasoningCache misses (empty CoT, eviction,
// fingerprint mismatch), the extension now sets reasoning_content="" as
// fallback instead of omitting the field entirely.
//
// This test validates three scenarios in sequence:
//   A. (positive ctrl) Turn 2 WITH original reasoning_content → 200
//   B. (reproduce bug) Turn 2 WITHOUT reasoning_content       → 400
//   C. (verify fix)    Turn 2 WITH reasoning_content=""       → 200
//
// Usage:
//   set DEEPSEEK_API_KEY=sk-...
//   node test/integration_cache_miss_fallback.mjs

import process from "node:process";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("Missing DEEPSEEK_API_KEY env var.");
  process.exit(1);
}

const BASE = "https://api.deepseek.com/v1";
const MODEL = "deepseek-v4-flash"; // cheapest thinking-capable model

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function chatOnce(body, label) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, body: text };
  }
  if (!res.body) {
    return { ok: false, status: 0, body: "no body" };
  }

  let reasoning = "";
  let content = "";
  const tcs = new Map();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.content) content += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = tcs.get(idx) ?? { id: undefined, name: undefined, args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
          tcs.set(idx, cur);
        }
      }
    }
  }

  const toolCalls = [...tcs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => ({
      id: v.id ?? "",
      type: "function",
      function: { name: v.name ?? "", arguments: v.args || "{}" },
    }));

  console.log(`[${label}] status=${res.status} reasoning=${reasoning.length} chars content="${content.slice(0, 60)}" toolCalls=${toolCalls.length}`);
  return { ok: true, status: res.status, reasoning, content, toolCalls };
}

function mkBody(messages, thinking) {
  return {
    model: MODEL,
    messages,
    stream: true,
    max_tokens: 4096,
    thinking: { type: thinking ? "enabled" : "disabled" },
    ...(thinking ? { tools: TOOLS, tool_choice: "auto" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function main() {
  console.log("=== Phase 1: Establish conversation (turn 1) ===\n");

  // Turn 1: user asks something that triggers a tool call
  const t1 = await chatOnce(
    mkBody(
      [{ role: "system", content: "You are a helpful assistant." },
       { role: "user", content: "What's the weather in Paris?" }],
      true
    ),
    "turn1"
  );

  assert(t1.ok, "Turn 1 returns 200");
  assert(t1.reasoning.length > 0, "Turn 1 has reasoning_content");
  assert(t1.toolCalls.length > 0, "Turn 1 has tool_calls");

  if (!t1.ok || t1.toolCalls.length === 0) {
    console.error("Cannot continue — turn 1 failed.");
    process.exit(1);
  }

  // Build the assistant message from turn 1
  const asstMsg = {
    role: "assistant",
    content: t1.content || null,
    tool_calls: t1.toolCalls,
  };

  // Send the tool result back
  const toolMsg = {
    role: "tool",
    tool_call_id: t1.toolCalls[0].id,
    content: '{"temperature": 18, "condition": "Cloudy"}',
  };

  console.log("\n=== Phase 2: Test scenarios ===\n");

  // --- Scenario A: WITH original reasoning_content (positive control) ---
  const bodyA = mkBody(
    [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What's the weather in Paris?" },
      { ...asstMsg, reasoning_content: t1.reasoning },
      toolMsg,
      { role: "user", content: "Summarize the weather." },
    ],
    true
  );
  const rA = await chatOnce(bodyA, "A. with orig reasoning");
  assert(rA.ok, "A: WITH original reasoning → 200 (positive control)");

  // --- Scenario B: WITHOUT reasoning_content (reproduce the bug) ---
  const bodyB = mkBody(
    [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What's the weather in Paris?" },
      asstMsg, // no reasoning_content
      toolMsg,
      { role: "user", content: "Summarize the weather." },
    ],
    true
  );
  const rB = await chatOnce(bodyB, "B. WITHOUT reasoning");
  assert(rB.status === 400, "B: WITHOUT reasoning → 400 (bug reproduced)");

  // --- Scenario C: WITH reasoning_content="" (verify the fix) ---
  const bodyC = mkBody(
    [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What's the weather in Paris?" },
      { ...asstMsg, reasoning_content: "" },
      toolMsg,
      { role: "user", content: "Summarize the weather." },
    ],
    true
  );
  const rC = await chatOnce(bodyC, "C. WITH empty reasoning");
  assert(rC.ok, "C: WITH reasoning_content=\"\" → 200 (fix verified)");

  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
