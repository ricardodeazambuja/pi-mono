import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	describe("math in the thinking trace", () => {
		initTheme("dark");
		const mathTheme = { ...getMarkdownTheme(), mathMode: "unicode" as const };
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "consider $$\\frac{a}{b}$$" },
			{ type: "text", text: "answer is $x^2$" },
		]);

		test("renders response math but leaves thinking math raw when not 'all'", () => {
			const component = new AssistantMessageComponent(message, false, mathTheme, "Thinking...", false);
			const out = stripAnsi(component.render(60).join("\n"));
			expect(out).toContain("x²"); // response math always renders
			expect(out).toContain("$$\\frac{a}{b}$$"); // thinking math stays raw
			expect(out).not.toContain("─");
		});

		test("renders thinking math when enabled ('all')", () => {
			const component = new AssistantMessageComponent(message, false, mathTheme, "Thinking...", true);
			const out = stripAnsi(component.render(60).join("\n"));
			expect(out).toContain("x²");
			expect(out).toContain("─"); // fraction rule from the thinking trace
			expect(out).not.toContain("$$\\frac{a}{b}$$");
		});
	});
});
