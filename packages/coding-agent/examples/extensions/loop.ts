/**
 * Loop Extension (with proactive stuck-detection)
 *
 * Sends a prompt to the agent on a recurring basis. When the agent finishes,
 * the next prompt fires immediately. The interval is a maximum wait time —
 * if the agent is already idle, the interval timer acts as a fallback.
 *
 * Stuck detection (always active, not just in /loop):
 *   Tracks consecutive tool errors and repeated agent responses. When it
 *   detects the agent is stuck, it aborts the current run and injects a
 *   message telling the agent what happened, so it can try a different
 *   approach. If a /loop is active, the loop is also stopped.
 *
 * Usage:
 *   /loop <minutes> <prompt>  - Start looping
 *   /loop stop                - Stop the loop
 *   /loop status              - Check if a loop is running
 *
 * Examples:
 *   /loop 5 check if the build passed
 *   /loop 2 check the deploy status and report any errors
 *   /loop stop
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REPEATED_RESPONSES = 3;

export default function (pi: ExtensionAPI) {
	// --- Loop state ---
	let intervalId: NodeJS.Timeout | undefined;
	let currentPrompt = "";
	let intervalMinutes = 0;
	let loopActive = false;

	// --- Stuck detection state ---
	let consecutiveErrors = 0;
	let lastErrorSignature = "";
	let lastErrorDetail = "";
	const recentResponses: string[] = [];
	let stuckHandled = false; // prevent double-firing within the same turn

	function clearLoop() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = undefined;
		}
		loopActive = false;
		currentPrompt = "";
		intervalMinutes = 0;
	}

	function resetStuckDetection() {
		consecutiveErrors = 0;
		lastErrorSignature = "";
		lastErrorDetail = "";
		recentResponses.length = 0;
		stuckHandled = false;
	}

	function startTimer() {
		if (intervalId) {
			clearInterval(intervalId);
		}
		intervalId = setInterval(
			() => {
				if (loopActive && currentPrompt) {
					pi.sendUserMessage(currentPrompt);
				}
			},
			intervalMinutes * 60 * 1000,
		);
	}

	function fingerprint(text: string): string {
		return text.replace(/\s+/g, " ").trim().slice(0, 500);
	}

	/**
	 * Abort the agent and inject a steering message explaining what
	 * went wrong, so it can try a different approach.
	 */
	function handleStuck(ctx: any, reason: string, detail: string) {
		if (stuckHandled) return;
		stuckHandled = true;

		// Abort current execution
		ctx.abort();

		// Stop loop if active
		if (loopActive) {
			const prompt = currentPrompt;
			clearLoop();
			ctx.ui.notify(`Loop auto-stopped: "${prompt}"`, "warning");
		}

		ctx.ui.notify(reason, "warning");

		// Inject a message that the agent will see on its next turn,
		// steering it to try a different approach
		pi.sendUserMessage(
			`IMPORTANT: You appear to be stuck in a loop. ${reason}\n\n` +
				`Last repeated error/output:\n${detail}\n\n` +
				`Please stop what you are doing, analyze why this keeps failing, ` +
				`and try a fundamentally different approach. Do NOT retry the same ` +
				`command or strategy again.`,
		);

		// Reset so we don't immediately re-trigger
		resetStuckDetection();
	}

	// --- Stuck detection: track tool errors ---
	pi.on("tool_execution_end" as any, async (event: any, ctx: any) => {
		stuckHandled = false; // new tool execution, allow detection again

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

	// --- Stuck detection: track repeated agent responses ---
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

	// --- Loop: fire next prompt when agent finishes ---
	pi.on("agent_end", async (_event, ctx) => {
		if (!loopActive || !currentPrompt) return;

		setTimeout(() => {
			if (loopActive && currentPrompt && ctx.isIdle()) {
				startTimer();
				pi.sendUserMessage(currentPrompt);
			}
		}, 1000);
	});

	// --- /loop command ---
	pi.registerCommand("loop", {
		description: "Run a prompt on a recurring interval. Usage: /loop <minutes> <prompt> | /loop stop | /loop status",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (!arg || arg === "stop") {
				if (loopActive) {
					const prompt = currentPrompt;
					clearLoop();
					resetStuckDetection();
					ctx.ui.notify(`Loop stopped: "${prompt}"`, "info");
				} else {
					ctx.ui.notify("No loop running", "info");
				}
				return;
			}

			if (arg === "status") {
				if (loopActive) {
					ctx.ui.notify(`Loop active (max ${intervalMinutes}m): "${currentPrompt}"`, "info");
				} else {
					ctx.ui.notify("No loop running", "info");
				}
				return;
			}

			const match = arg.match(/^(\d+)\s+(.+)$/s);
			if (!match) {
				ctx.ui.notify("Usage: /loop <minutes> <prompt>  or  /loop stop", "warning");
				return;
			}

			const minutes = parseInt(match[1]);
			const prompt = match[2];

			if (minutes < 1) {
				ctx.ui.notify("Interval must be at least 1 minute", "warning");
				return;
			}

			if (loopActive) {
				clearLoop();
			}

			resetStuckDetection();
			currentPrompt = prompt;
			intervalMinutes = minutes;
			loopActive = true;
			startTimer();

			ctx.ui.notify(`Loop started: "${prompt}" (max ${minutes}m between runs)`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		clearLoop();
	});
}
