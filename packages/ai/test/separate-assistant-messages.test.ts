import { describe, expect, test } from "vitest";
import type { Message } from "../src/types.ts";
import { separateConsecutiveAssistantMessages } from "../src/utils/transcript.ts";

function assistant(content: Array<{ type: string; text?: string; id?: string }>): Message {
	return {
		role: "assistant",
		content,
		api: "openai",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as unknown as Message;
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 2 } as unknown as Message;
}

function tool(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	} as unknown as Message;
}

describe("separateConsecutiveAssistantMessages", () => {
	test("leaves a normal user/assistant/tool sequence untouched", () => {
		const messages = [
			user("q"),
			assistant([{ type: "text", text: "a" }]),
			tool("r"),
			assistant([{ type: "text", text: "b" }]),
		];
		const result = separateConsecutiveAssistantMessages(messages);
		expect(result).toHaveLength(4);
		expect(result.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	test("inserts a divider between two assistant messages without a tool call", () => {
		const messages = [user("q"), assistant([{ type: "text", text: "a" }]), assistant([{ type: "text", text: "b" }])];
		const result = separateConsecutiveAssistantMessages(messages);
		expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(result[2]).toMatchObject({ role: "user" });
	});

	test("does not split an assistant message that carries tool calls from the next", () => {
		const messages = [assistant([{ type: "toolCall", id: "t1" }]), assistant([{ type: "text", text: "b" }])];
		const result = separateConsecutiveAssistantMessages(messages);
		expect(result).toHaveLength(2);
		expect(result.map((m) => m.role)).toEqual(["assistant", "assistant"]);
	});

	test("separates three consecutive assistant messages", () => {
		const messages = [
			assistant([{ type: "text", text: "a" }]),
			assistant([{ type: "text", text: "b" }]),
			assistant([{ type: "text", text: "c" }]),
		];
		const result = separateConsecutiveAssistantMessages(messages);
		expect(result.map((m) => m.role)).toEqual(["assistant", "user", "assistant", "user", "assistant"]);
	});
});
