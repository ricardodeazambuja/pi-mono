/**
 * Token Saver Extension (inspired by RTK - Rust Token Killer)
 *
 * Intercepts bash tool results and strips noise/clutter from outputs before
 * they reach the LLM context, while preserving all meaningful content.
 *
 * Uses shared filter patterns from filters.ts.
 *
 * ONLY filters bash tool outputs. Does NOT touch read/grep/find/ls/edit/write.
 *
 * Usage:
 *   Copy to ~/.pi/agent/extensions/ for global use.
 *
 * Commands:
 *   /token-saver         - Show status and stats
 *   /token-saver off     - Disable filtering
 *   /token-saver on      - Re-enable filtering
 *   /token-saver reset   - Reset stats
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { countTokensApprox, formatTokens, stripNoise } from "./filters.js";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let savedTokens = 0;
	let compressedCount = 0;
	let totalToolResults = 0;

	function getTextContent(event: any): string {
		return (event.content || [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("token-saver", "saver: ready");
	});

	pi.on("tool_result" as any, async (event: any, ctx: any) => {
		totalToolResults++;

		if (!enabled) return undefined;

		// ONLY filter bash tool outputs.
		if (event.toolName !== "bash") return undefined;

		const text = getTextContent(event);
		if (!text) return undefined;

		const command = (event.input.command as string) || "";
		const originalTokens = countTokensApprox(text);
		const filtered = stripNoise(command, text);

		if (filtered.length < text.length) {
			const newTokens = countTokensApprox(filtered);
			const saved = originalTokens - newTokens;
			if (saved > 10) {
				savedTokens += saved;
				compressedCount++;
				ctx.ui.setStatus("token-saver", `saver: ~${formatTokens(savedTokens)} saved`);
				return { content: [{ type: "text", text: filtered }] };
			}
		}

		return undefined;
	});

	pi.registerCommand("token-saver", {
		description: "Toggle token saver on/off, show stats, or reset. Usage: /token-saver [on|off|reset]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				ctx.ui.notify("Token saver enabled", "info");
				return;
			}
			if (arg === "off") {
				enabled = false;
				ctx.ui.notify("Token saver disabled", "info");
				return;
			}
			if (arg === "reset") {
				savedTokens = 0;
				compressedCount = 0;
				totalToolResults = 0;
				ctx.ui.notify("Token savings stats reset", "info");
				return;
			}

			const status = enabled ? "ON" : "OFF";
			const pct = totalToolResults > 0 ? Math.round((compressedCount / totalToolResults) * 100) : 0;
			pi.sendMessage({
				customType: "token-saver-stats",
				content: [
					`Token Saver: ${status}`,
					`─────────────────`,
					`Tool results processed: ${totalToolResults}`,
					`Bash results filtered:  ${compressedCount} (${pct}%)`,
					`Tokens saved:           ~${savedTokens.toLocaleString()}`,
				].join("\n"),
				display: true,
			});
		},
	});
}
