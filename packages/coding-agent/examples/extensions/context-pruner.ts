/**
 * Context Pruner Extension
 *
 * Keeps the context lean by replacing old tool results with smart
 * summaries while preserving recent turns in full. The session history
 * stays intact — only what the LLM sees is pruned.
 *
 * Uses shared filter patterns from filters.ts for smart error extraction.
 *
 * For older turns (beyond the keep-recent threshold):
 *   - User messages: kept as-is
 *   - Assistant text: kept as-is (the conclusions/knowledge)
 *   - Assistant thinking blocks: stripped
 *   - Assistant tool calls: replaced with a one-line action summary
 *   - Tool results (success): replaced with "[tool ok: 450 lines]"
 *   - Tool results (error): smart summary extracting the key error info
 *     using language-specific patterns (Python traceback, Node.js, gcc, etc.)
 *
 * For recent turns (last N): everything kept in full.
 *
 * Usage:
 *   Copy to ~/.pi/agent/extensions/ for always-on context pruning.
 *
 * Commands:
 *   /pruner         - Show status
 *   /pruner off     - Disable pruning
 *   /pruner on      - Re-enable pruning
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatTokens, summarizeToolCall, summarizeToolResult } from "./filters.js";

const KEEP_RECENT_TURNS = 3;

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("pruner", "pruner: waiting");
	});

	/**
	 * Identify turn boundaries. A turn starts with each user message
	 * and includes everything until the next user message.
	 */
	function identifyTurns(messages: any[]): Array<{ start: number; end: number }> {
		const turns: Array<{ start: number; end: number }> = [];
		let turnStart = -1;

		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "user") {
				if (turnStart >= 0) {
					turns.push({ start: turnStart, end: i - 1 });
				}
				turnStart = i;
			}
		}
		if (turnStart >= 0) {
			turns.push({ start: turnStart, end: messages.length - 1 });
		}
		return turns;
	}

	/**
	 * Prune a single message from an older turn.
	 * Returns the pruned message, or null to remove entirely.
	 */
	function pruneMessage(msg: any): any | null {
		if (msg.role === "user") return msg;

		if (msg.role === "assistant") {
			const prunedContent: any[] = [];

			for (const block of msg.content || []) {
				if (block.type === "text") {
					if (block.text?.trim()) prunedContent.push(block);
				} else if (block.type === "toolCall") {
					prunedContent.push({
						type: "text",
						text: summarizeToolCall(block.name, block.arguments || {}),
					});
				}
				// Thinking blocks: stripped
			}

			if (prunedContent.length === 0) return null;
			return { ...msg, content: prunedContent };
		}

		if (msg.role === "toolResult") {
			const text = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");

			const summary = summarizeToolResult(msg.toolName || "?", text, msg.isError);
			return { ...msg, content: [{ type: "text", text: summary }] };
		}

		return msg;
	}

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;

		const messages = event.messages;
		const turns = identifyTurns(messages);

		if (turns.length <= KEEP_RECENT_TURNS) {
			ctx.ui.setStatus("pruner", "pruner: waiting");
			return;
		}

		const oldTurnEnd = turns[turns.length - KEEP_RECENT_TURNS - 1].end;

		let originalChars = 0;
		let prunedChars = 0;

		const pruned: any[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (i <= oldTurnEnd) {
				const msg = messages[i] as any;
				const origLen = msg.content ? JSON.stringify(msg.content).length : 0;
				originalChars += origLen;
				const result = pruneMessage(msg);
				if (result) {
					prunedChars += result.content ? JSON.stringify(result.content).length : 0;
					pruned.push(result);
				}
			} else {
				pruned.push(messages[i]);
			}
		}

		const savedTokens = Math.round((originalChars - prunedChars) / 4);
		const prunedTurns = turns.length - KEEP_RECENT_TURNS;
		ctx.ui.setStatus("pruner", `pruner: ${prunedTurns} turns ~${formatTokens(savedTokens)} saved`);

		return { messages: pruned };
	});

	pi.registerCommand("pruner", {
		description: "Toggle context pruner on/off. Usage: /pruner [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				ctx.ui.notify("Context pruner enabled", "info");
				return;
			}
			if (arg === "off") {
				enabled = false;
				ctx.ui.notify("Context pruner disabled", "info");
				return;
			}

			const status = enabled ? "ON" : "OFF";
			ctx.ui.notify(
				`Context pruner: ${status} (keeping last ${KEEP_RECENT_TURNS} turns in full, pruning older ones)`,
				"info",
			);
		},
	});
}
