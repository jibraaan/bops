import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

/**
 * lib/server/llm.ts against fake Anthropic and OpenAI servers on localhost: what each provider is sent
 * for the chat engine's requests, and that both answer in the one shape chat.ts reads.
 * Run: node --conditions=react-server --test lib/server/llm.test.ts
 */

// What the fakes were sent: read deep into, as the tests assert on its shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
type Got = { path: string; headers: IncomingMessage["headers"]; body: Body };
const got: Got[] = [];
let replies: Record<string, unknown>[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      got.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replies.shift()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `${url}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.BOPS_SELF_HOSTED = "1";
});

after(() => new Promise((r) => server.close(r)));

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
const claudeReply = (id: string, content: unknown[], stop_reason = "end_turn") => ({ id, type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, usage });

const tools = [
  {
    type: "function" as const,
    name: "schedule",
    description: "Schedule a routine.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["time", "kind"],
      properties: {
        time: { type: ["string", "null"], description: "24h HH:MM." },
        kind: { type: "string", enum: ["daily", "once"] },
      },
    },
  },
  { type: "function" as const, name: "use_app", description: "Run an app action.", strict: false, parameters: { type: "object", properties: { arguments: { type: "object" } } } },
];

test("Claude: the chat's request, translated", async () => {
  process.env.BOPS_MODEL_PROVIDER = "claude";
  const { respond, provider } = await import("./llm");
  assert.equal(provider(), "claude");
  replies = [claudeReply("msg_1", [{ type: "text", text: "Hi Maya!" }])];
  const r = await respond({
    openaiModel: "gpt-ignored",
    effort: "low",
    instructions: "You are Boppy.",
    input: [
      { role: "assistant", content: "Good morning." },
      { role: "user", content: [{ type: "input_text", text: "What's this?" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { role: "user", content: "" },
    ],
    tools,
  });
  const sent = got.at(-1)!;
  assert.equal(sent.path, "/v1/messages?beta=true");
  assert.match(String(sent.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  const b = sent.body;
  assert.equal(b.model, "claude-opus-5-5");
  assert.equal(b.system, "You are Boppy.");
  assert.equal(b.fallbacks, "default");
  assert.deepEqual(b.output_config, { effort: "low" });
  assert.deepEqual(b.cache_control, { type: "ephemeral" });
  // Claude's conversation starts with the user; images go as base64; empty text never goes.
  assert.equal(b.messages[0].role, "user");
  assert.equal(b.messages[1].role, "assistant");
  assert.deepEqual(b.messages[2].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  assert.equal(b.messages[3].content, "(empty)");
  // Nullable fields become anyOf; each tool keeps its own strictness.
  assert.deepEqual(b.tools[0].input_schema.properties.time, { description: "24h HH:MM.", anyOf: [{ type: "string" }, { type: "null" }] });
  assert.deepEqual(b.tools[0].input_schema.properties.kind, { type: "string", enum: ["daily", "once"] });
  assert.equal(b.tools[0].strict, true);
  assert.equal(b.tools[1].strict, undefined);
  assert.deepEqual(r, { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 15, output_tokens: 5 }, output_text: "Hi Maya!", calls: [] });
});

test("Claude: a tool round continues the conversation with every call's result, the reply unchanged", async () => {
  const { respond } = await import("./llm");
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  replies = [
    claudeReply("msg_2", [thinking, { type: "tool_use", id: "tu_1", name: "recall", input: { question: "address?" } }, { type: "tool_use", id: "tu_2", name: "start_task", input: { title: "Flights" } }], "tool_use"),
    claudeReply("msg_3", [{ type: "text", text: "Done." }]),
  ];
  const first = await respond({ openaiModel: "x", instructions: "sys", input: "Find flights home", tools });
  assert.deepEqual(first.calls, [
    { type: "function_call", call_id: "tu_1", name: "recall", arguments: '{"question":"address?"}' },
    { type: "function_call", call_id: "tu_2", name: "start_task", arguments: '{"title":"Flights"}' },
  ]);
  const second = await respond({
    openaiModel: "x",
    instructions: "sys",
    previous: first.id,
    input: [
      { type: "function_call_output", call_id: "tu_1", output: "12 Main St" },
      { type: "function_call_output", call_id: "tu_2", output: "ok" },
    ],
    tools,
  });
  const m = (got.at(-1)!.body).messages;
  assert.deepEqual(m[0], { role: "user", content: "Find flights home" });
  assert.equal(m[1].role, "assistant");
  assert.deepEqual(m[1].content[0], thinking);
  assert.deepEqual(m[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "12 Main St" },
      { type: "tool_result", tool_use_id: "tu_2", content: "ok" },
    ],
  });
  assert.equal(second.output_text, "Done.");
});

test("Claude: JSON answers use output_config.format; a refusal says nothing", async () => {
  const { respond } = await import("./llm");
  replies = [claudeReply("msg_4", [{ type: "text", text: '{"replies":["Yes"]}' }]), claudeReply("msg_5", [{ type: "text", text: "partial" }], "refusal")];
  const schema = { type: "object", additionalProperties: false, required: ["replies"], properties: { replies: { type: "array", items: { type: "string" } } } };
  const r = await respond({ openaiModel: "x", instructions: "sys", input: "q", json: { name: "replies", schema } });
  assert.deepEqual((got.at(-1)!.body).output_config, { effort: "low", format: { type: "json_schema", schema } });
  assert.deepEqual(JSON.parse(r.output_text), { replies: ["Yes"] });
  assert.equal((await respond({ openaiModel: "x", instructions: "sys", input: "q" })).output_text, "");
});

test("OpenAI: the same request goes to the Responses API as before", async () => {
  process.env.BOPS_MODEL_PROVIDER = "openai";
  const { respond, provider } = await import("./llm");
  assert.equal(provider(), "openai");
  replies = [
    {
      id: "resp_1",
      object: "response",
      model: "gpt-6.1-sol",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "schedule", arguments: '{"time":null,"kind":"once"}' },
        { type: "message", id: "m_1", role: "assistant", content: [{ type: "output_text", text: "Scheduled.", annotations: [] }] },
      ],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    },
  ];
  const r = await respond({ openaiModel: "gpt-6.1-sol", effort: "medium", instructions: "sys", input: "remind me", tools, previous: "resp_0" });
  const b = got.at(-1)!.body;
  assert.equal(got.at(-1)!.path, "/v1/responses");
  assert.equal(b.model, "gpt-6.1-sol");
  assert.deepEqual(b.reasoning, { effort: "medium" });
  assert.equal(b.previous_response_id, "resp_0");
  assert.deepEqual(b.tools, tools);
  assert.deepEqual(r, {
    id: "resp_1",
    model: "gpt-6.1-sol",
    usage: { input_tokens: 7, output_tokens: 3 },
    output_text: "Scheduled.",
    calls: [{ type: "function_call", call_id: "call_1", name: "schedule", arguments: '{"time":null,"kind":"once"}' }],
  });
});

test("Claude needs its key: without one, OpenAI stays on", async () => {
  process.env.BOPS_MODEL_PROVIDER = "claude";
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const { provider } = await import("./llm");
  assert.equal(provider(), "openai");
  process.env.ANTHROPIC_API_KEY = key;
});
