import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(): Model<"openai-completions"> {
	return {
		id: "llama-server",
		name: "llama-server",
		api: "openai-completions",
		provider: "llama-server",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
		compat,
	};
}

function buildAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "llama-server",
		model: "llama-server",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function buildContext(...messages: AssistantMessage[]): Context {
	return {
		messages: [{ role: "user", content: "Read the file", timestamp: 1 }, ...messages],
	};
}

type AssistantParams = {
	role: string;
	tool_calls_raw?: string;
	tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	reasoning_content?: string;
	content?: string | null | unknown[];
};

function asAssistant(msg: unknown): AssistantParams {
	return msg as AssistantParams;
}

describe("openai-completions convertMessages tool-call prefill", () => {
	it("sends tool_calls_raw for the trailing assistant when prefill is set and all calls have raw", () => {
		const assistant = buildAssistant([
			{
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "/tmp/a.txt" },
				raw: "<raw-call-1>",
			},
			{
				type: "toolCall",
				id: "call-2",
				name: "read_file",
				arguments: { path: "/tmp/b.txt" },
				raw: "<raw-call-2>",
			},
		]);
		const messages = convertMessages(buildModel(), buildContext(assistant), compat, {
			prefill: true,
		});

		const last = asAssistant(messages[messages.length - 1]);
		expect(last.role).toBe("assistant");
		expect(last.tool_calls_raw).toBe("<raw-call-1><raw-call-2>");
		expect(last.tool_calls).toBeUndefined();
		// No synthetic tool results appended after the trailing assistant.
		expect(messages.some((m) => m.role === "tool")).toBe(false);
	});

	it("sends reasoning_content alongside tool_calls_raw for the prefill", () => {
		const assistant = buildAssistant([
			{ type: "thinking", thinking: "I should read the file.", thinkingSignature: "reasoning_content" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "/tmp/a.txt" },
				raw: "<raw-call-1>",
			},
		]);
		const messages = convertMessages(buildModel(), buildContext(assistant), compat, {
			prefill: true,
		});

		const last = asAssistant(messages[messages.length - 1]);
		expect(last.role).toBe("assistant");
		expect(last.reasoning_content).toBe("I should read the file.");
		expect(last.tool_calls_raw).toBe("<raw-call-1>");
		expect(last.tool_calls).toBeUndefined();
	});

	it("falls back to structured tool_calls when raw is unavailable", () => {
		const assistant = buildAssistant([
			{
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "/tmp/a.txt" },
			},
		]);
		const messages = convertMessages(buildModel(), buildContext(assistant), compat, {
			prefill: true,
		});

		const last = asAssistant(messages[messages.length - 1]);
		expect(last.role).toBe("assistant");
		expect(last.tool_calls_raw).toBeUndefined();
		expect(Array.isArray(last.tool_calls)).toBe(true);
		expect(last.tool_calls?.[0].function.name).toBe("read_file");
	});

	it("sends structured tool_calls for non-trailing assistant messages even in prefill mode", () => {
		const first = buildAssistant([
			{
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "/tmp/a.txt" },
				raw: "<raw-call-1>",
			},
		]);
		const trailing = buildAssistant([{ type: "text", text: "continuing" }]);
		const messages = convertMessages(
			buildModel(),
			{
				messages: [
					{ role: "user", content: "Read the file", timestamp: 1 },
					first,
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read_file",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: 2,
					},
					trailing,
				],
			},
			compat,
			{ prefill: true },
		);

		// The first assistant (non-trailing) sends structured tool_calls.
		const firstAssistant = asAssistant(
			messages.find((m) => m.role === "assistant" && "tool_calls" in (m as AssistantParams)),
		);
		expect(firstAssistant).toBeDefined();
		expect(firstAssistant.tool_calls_raw).toBeUndefined();
		expect(Array.isArray(firstAssistant.tool_calls)).toBe(true);
		// The trailing assistant (text only) is the last message.
		const last = asAssistant(messages[messages.length - 1]);
		expect(last.role).toBe("assistant");
		expect(last.content).toBe("continuing");
	});

	it("sends structured tool_calls and synthesizes tool results when prefill is not set", () => {
		const assistant = buildAssistant([
			{
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "/tmp/a.txt" },
				raw: "<raw-call-1>",
			},
		]);
		const messages = convertMessages(buildModel(), buildContext(assistant), compat);

		// Trailing unresolved tool calls get synthetic tool results appended.
		expect(messages[messages.length - 1].role).toBe("tool");
		// The assistant sends structured tool_calls (not tool_calls_raw).
		const assistantMsg = asAssistant(messages.find((m) => m.role === "assistant"));
		expect(assistantMsg.tool_calls_raw).toBeUndefined();
		expect(Array.isArray(assistantMsg.tool_calls)).toBe(true);
	});

	it("does not skip a tool-call-only prefill assistant (sends tool_calls_raw)", () => {
		const assistant = buildAssistant([
			{
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "/tmp/a.txt" },
				raw: "<raw-call-1>",
			},
		]);
		const messages = convertMessages(buildModel(), buildContext(assistant), compat, {
			prefill: true,
		});

		// The assistant must not be skipped (it has tool_calls_raw).
		const assistants = messages.filter((m) => m.role === "assistant");
		expect(assistants.length).toBe(1);
		const last = asAssistant(assistants[0]);
		expect(last.tool_calls_raw).toBe("<raw-call-1>");
	});
});
