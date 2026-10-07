import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { openaiClient } from "./openai-client";

/**
 * The model behind the chat: OpenAI (the default) or Claude. The chat engine (chat.ts) and the short
 * judgment calls (memory, watches, suggested replies) ask for a reply here in one shape, the one the
 * OpenAI Responses API takes, and get one shape back. Threads on a computer (sessions.ts) and calls
 * (phone.ts) stay on OpenAI: they run on its agents and live audio.
 *
 * Claude is on with BOPS_MODEL_PROVIDER=claude and ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in
 * .env.local; BOPS_CLAUDE_MODEL picks the model. Bops Cloud only carries OpenAI, so Claude always
 * calls Anthropic directly with the key on this Mac.
 */

export type Provider = "openai" | "claude";

export function provider(): Provider {
  return process.env.BOPS_MODEL_PROVIDER === "claude" && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ? "claude" : "openai";
}

const CLAUDE_MODEL = process.env.BOPS_CLAUDE_MODEL ?? "claude-opus-5-5";

/** A tool the model may call, as chat.ts writes them (the Responses API's function tools). */
export type FnTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict: boolean };

type Part = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" };
/** A message in the conversation, or a tool's answer to a call from the last reply. */
export type InputItem = { role: "user" | "assistant"; content: string | Part[] } | { type: "function_call_output"; call_id: string; output: string };

export type Ask = {
  /** The model when it's OpenAI (each caller keeps its own, set by env); Claude uses BOPS_CLAUDE_MODEL. */
  openaiModel: string;
  effort?: "low" | "medium" | "high";
  instructions: string;
  input: string | InputItem[];
  tools?: FnTool[];
  /** Continue from a reply (its id) with the tools' answers as `input`. */
  previous?: string;
  /** Answer as JSON matching this schema (strict). */
  json?: { name: string; schema: Record<string, unknown> };
};

export type FunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };
export type Reply = {
  id: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
  output_text: string;
  /** The tools it called, in order. */
  calls: FunctionCall[];
};

export function respond(ask: Ask): Promise<Reply> {
  return provider() === "claude" ? claude(ask) : openai(ask);
}

// ── OpenAI ────────────────────────────────────────────────────────────────────────────────────────

const oa = openaiClient();

async function openai(ask: Ask): Promise<Reply> {
  const res = await oa.responses.create({
    model: ask.openaiModel,
    reasoning: { effort: ask.effort ?? "low" },
    instructions: ask.instructions,
    input: ask.input as never,
    ...(ask.tools ? { tools: ask.tools } : {}),
    ...(ask.previous ? { previous_response_id: ask.previous } : {}),
    ...(ask.json ? { text: { format: { type: "json_schema" as const, name: ask.json.name, strict: true, schema: ask.json.schema } } } : {}),
  });
  return {
    id: res.id,
    model: res.model,
    usage: res.usage ? { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } : undefined,
    output_text: res.output_text ?? "",
    calls: res.output.filter((o) => o.type === "function_call").map((o) => ({ type: "function_call", call_id: o.call_id, name: o.name, arguments: o.arguments })),
  };
}

// ── Claude ────────────────────────────────────────────────────────────────────────────────────────

// Made on first use, so a Mac without an Anthropic key never constructs one.
let anthropic: Anthropic | undefined;
const claudeClient = () => (anthropic ??= new Anthropic());

/**
 * A reply's whole conversation, so a tool round can continue it (Claude has no previous_response_id).
 * Kept briefly: a turn's rounds follow each other within seconds.
 */
const conversations = new Map<string, { messages: Anthropic.Beta.BetaMessageParam[]; at: number }>();
const KEEP_MS = 10 * 60_000;

/** Claude's strict schemas take nullable fields as anyOf, not a list of types. */
function forClaude(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forClaude);
  if (!schema || typeof schema !== "object") return schema;
  const s = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, d]) => [p, forClaude(d)])) : k === "items" ? forClaude(v) : v]));
  if (Array.isArray(s.type)) {
    const { type, description, ...rest } = s as { type: string[]; description?: string };
    return { ...(description ? { description } : {}), anyOf: type.map((t) => (t === "null" ? { type: "null" } : { ...rest, type: t })) };
  }
  return s;
}

const IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/;
const nonEmpty = (t: string) => (t.trim() ? t : "(empty)");

function contentOf(content: string | Part[]): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (typeof content === "string") return nonEmpty(content);
  return content.flatMap((p): Anthropic.Beta.BetaContentBlockParam[] => {
    if (p.type === "input_text") return [{ type: "text", text: nonEmpty(p.text) }];
    const m = IMAGE.exec(p.image_url);
    if (m) return [{ type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2] } }];
    return /^https?:/.test(p.image_url) ? [{ type: "image", source: { type: "url", url: p.image_url } }] : [];
  });
}

function messagesOf(ask: Ask): Anthropic.Beta.BetaMessageParam[] {
  if (ask.previous) {
    const prior = conversations.get(ask.previous);
    if (!prior) throw new Error("That conversation expired; send the message again.");
    const items = typeof ask.input === "string" ? [] : ask.input;
    const results = items.filter((i) => "type" in i && i.type === "function_call_output") as Extract<InputItem, { type: "function_call_output" }>[];
    // Every tool call in the last reply gets its answer, together, in one message.
    return [...prior.messages, { role: "user", content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.call_id, content: nonEmpty(r.output) })) }];
  }
  const items: InputItem[] = typeof ask.input === "string" ? [{ role: "user", content: ask.input }] : ask.input;
  const messages = items.filter((i): i is Extract<InputItem, { role: string }> => "role" in i).map((i) => ({ role: i.role, content: contentOf(i.content) }));
  // Claude's conversation starts with the user; a chat can start with the bot (a greeting, a routine's result).
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: "(The conversation so far.)" });
  return messages;
}

async function claude(ask: Ask): Promise<Reply> {
  const now = Date.now();
  for (const [id, c] of conversations) if (now - c.at > KEEP_MS) conversations.delete(id);
  const messages = messagesOf(ask);
  const res = await claudeClient().beta.messages.create({
    model: CLAUDE_MODEL,
    // make_page writes a whole HTML page as a tool's input.
    max_tokens: 16000,
    // The tools and the start of the conversation repeat from turn to turn and round to round.
    cache_control: { type: "ephemeral" },
    system: ask.instructions,
    messages,
    output_config: { effort: ask.effort ?? "low", ...(ask.json ? { format: { type: "json_schema", schema: forClaude(ask.json.schema) as Record<string, unknown> } } : {}) },
    ...(ask.tools?.length
      ? { tools: ask.tools.map((t) => ({ name: t.name, description: t.description, input_schema: forClaude(t.parameters) as Anthropic.Beta.BetaTool.InputSchema, ...(t.strict ? { strict: true } : {}) })) }
      : {}),
    // A request the model declines is run again on the model Anthropic recommends for it.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  // The reply goes back unchanged (thinking blocks included) when a tool round continues it.
  conversations.set(res.id, { messages: [...messages, { role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] }], at: now });
  const text = res.stop_reason === "refusal" ? "" : res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  return {
    id: res.id,
    model: res.model,
    usage: { input_tokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), output_tokens: res.usage.output_tokens },
    output_text: text,
    calls: res.content.flatMap((b) => (b.type === "tool_use" ? [{ type: "function_call" as const, call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : [])),
  };
}
