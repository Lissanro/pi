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

// llama-server-like compat: thinking is sent as reasoning_content, not as text.
const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Required<
	Omit<
		OpenAICompletionsCompat,
		"cacheControlFormat" | "deferredToolsMode" | "supportsThinkingTokenBudget" | "thinkingTokenBudgetField"
	>
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
};

function buildModel(): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "repro-provider",
		model: "repro-model",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 2,
	};
}

function buildContext(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions reasoning replay (requiresThinkingAsText: false)", () => {
	it("keeps a thinking-only assistant message and sends reasoning_content with null content", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext(
				buildAssistant([
					{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "reasoning_content" },
				]),
			),
			compat,
		);

		// The assistant message must NOT be skipped (mid-reasoning continuation).
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toBeNull();
		expect((assistant as { reasoning_content?: string }).reasoning_content).toBe("internal reasoning");
	});

	it("keeps a thinking-plus-text assistant message with both reasoning_content and content", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext(
				buildAssistant([
					{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "visible answer" },
				]),
			),
			compat,
		);

		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toBe("visible answer");
		expect((assistant as { reasoning_content?: string }).reasoning_content).toBe("internal reasoning");
	});

	it("skips an empty assistant message (no content, no thinking, no tool calls)", () => {
		const messages = convertMessages(buildModel(), buildContext(buildAssistant([])), compat);

		// The empty (harness) assistant message is skipped; only the two user messages remain.
		expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
		expect(messages).toHaveLength(2);
	});

	it("skips an assistant message with only empty text (no real content)", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext(buildAssistant([{ type: "text", text: "" }])),
			compat,
		);

		expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
	});
});
