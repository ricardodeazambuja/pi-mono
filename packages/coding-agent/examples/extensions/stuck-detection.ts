/**
 * Stuck Detection Extension
 *
 * Always-on guard that detects when the agent is stuck in a loop:
 *   - Same tool failing with the same error 3+ times in a row
 *   - Agent generating the same response 3+ times in a row
 *
 * When detected, it aborts the current execution and injects a
 * steering message telling the agent to try a different approach.
 *
 * Emits "stuck:detected" on the extension event bus so other
 * extensions (e.g. loop) can react.
 *
 * Usage:
 *   Copy to ~/.pi/agent/extensions/ for always-on protection.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REPEATED_RESPONSES = 3;

export default function (pi: ExtensionAPI) {
	let consecutiveErrors = 0;
	let lastErrorSignature = "";
	let lastErrorDetail = "";
	const recentResponses: string[] = [];
	let stuckHandled = false;

	function reset() {
		consecutiveErrors = 0;
		lastErrorSignature = "";
		lastErrorDetail = "";
		recentResponses.length = 0;
		stuckHandled = false;
	}

	function fingerprint(text: string): string {
		return text.replace(/\s+/g, " ").trim().slice(0, 500);
	}

	function handleStuck(ctx: any, reason: string, detail: string) {
		if (stuckHandled) return;
		stuckHandled = true;

		ctx.abort();
		ctx.ui.notify(reason, "warning");

		// Notify other extensions (e.g. loop) via event bus
		pi.events.emit("stuck:detected", { reason, detail });

		pi.sendUserMessage(
			`IMPORTANT: You appear to be stuck in a loop. ${reason}\n\n` +
				`Last repeated error/output:\n${detail}\n\n` +
				`Please stop what you are doing, analyze why this keeps failing, ` +
				`and try a fundamentally different approach. Do NOT retry the same ` +
				`command or strategy again.`,
		);

		reset();
	}

	// Track consecutive identical tool errors
	pi.on("tool_execution_end" as any, async (event: any, ctx: any) => {
		stuckHandled = false;

		if (event.isError) {
			const errorText =
				event.result?.content
					?.filter((c: any) => c.type === "text")
					?.map((c: any) => c.text)
					?.join("") || "";
			const sig = `${event.toolName}:${fingerprint(errorText)}`;

			if (sig === lastErrorSignature) {
				consecutiveErrors++;
			} else {
				consecutiveErrors = 1;
				lastErrorSignature = sig;
				lastErrorDetail = errorText.slice(0, 300);
			}

			if (consecutiveErrors >= MAX_CONSECUTIVE_FAILURES) {
				handleStuck(
					ctx,
					`${event.toolName} failed ${consecutiveErrors} times with the same error`,
					lastErrorDetail,
				);
			}
		} else {
			consecutiveErrors = 0;
			lastErrorSignature = "";
			lastErrorDetail = "";
		}
	});

	// Track repeated identical agent responses
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const text = event.message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");

		if (!text) return;

		const fp = fingerprint(text);
		recentResponses.push(fp);

		if (recentResponses.length > MAX_REPEATED_RESPONSES + 1) {
			recentResponses.shift();
		}

		if (recentResponses.length >= MAX_REPEATED_RESPONSES) {
			const lastN = recentResponses.slice(-MAX_REPEATED_RESPONSES);
			const allSame = lastN.every((r) => r === lastN[0]);

			if (allSame) {
				handleStuck(
					ctx,
					`Agent gave the same response ${MAX_REPEATED_RESPONSES} times in a row`,
					text.slice(0, 300),
				);
			}
		}
	});
}
