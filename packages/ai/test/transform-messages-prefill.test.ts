import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeModel(): Model<"openai-completions"> {
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
	};
}

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
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

describe("transformMessages skipTrailingToolResultSynthesis", () => {
	it("synthesizes tool results for trailing unresolved tool calls by default", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read_file",
			arguments: { path: "/tmp/a" },
		};
		const messages: Message[] = [{ role: "user", content: "read", timestamp: 1 }, makeAssistant([toolCall])];

		const result = transformMessages(messages, makeModel());

		// The trailing assistant's unresolved tool call gets a synthetic tool result.
		expect(result[result.length - 1].role).toBe("toolResult");
		expect((result[result.length - 1] as ToolResultMessage).toolCallId).toBe("call-1");
	});

	it("skips synthesizing tool results for trailing tool calls in prefill mode", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read_file",
			arguments: { path: "/tmp/a" },
			raw: "<raw>",
		};
		const messages: Message[] = [{ role: "user", content: "read", timestamp: 1 }, makeAssistant([toolCall])];

		const result = transformMessages(messages, makeModel(), undefined, {
			skipTrailingToolResultSynthesis: true,
		});

		// The trailing assistant is preserved as the last message (no synthetic result).
		expect(result[result.length - 1].role).toBe("assistant");
		expect(result.length).toBe(2);
	});

	it("still synthesizes mid-conversation orphaned tool calls in prefill mode", () => {
		const orphanedCall: ToolCall = {
			type: "toolCall",
			id: "call-orphan",
			name: "read_file",
			arguments: { path: "/tmp/a" },
		};
		const trailingCall: ToolCall = {
			type: "toolCall",
			id: "call-trail",
			name: "read_file",
			arguments: { path: "/tmp/b" },
			raw: "<raw>",
		};
		const messages: Message[] = [
			{ role: "user", content: "read", timestamp: 1 },
			// Orphaned tool call (no following tool result, interrupted by a user message).
			makeAssistant([orphanedCall]),
			{ role: "user", content: "continue", timestamp: 2 },
			// Trailing prefill tool call.
			makeAssistant([trailingCall]),
		];

		const result = transformMessages(messages, makeModel(), undefined, {
			skipTrailingToolResultSynthesis: true,
		});

		// The orphaned call (interrupted by a user message) gets a synthetic result.
		const synthetic = result.find(
			(m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "call-orphan",
		);
		expect(synthetic).toBeDefined();
		// The trailing prefill tool call is preserved as the last message.
		expect(result[result.length - 1].role).toBe("assistant");
		const lastAssistant = result[result.length - 1] as AssistantMessage;
		expect(lastAssistant.content[0]).toMatchObject({ type: "toolCall", id: "call-trail" });
	});
});
