/**
 * Loop Extension
 *
 * Sends a prompt to the agent on a recurring basis. When the agent finishes,
 * the next prompt fires immediately. The interval is a maximum wait time —
 * if the agent is already idle, the interval timer acts as a fallback.
 *
 * Listens for "stuck:detected" events from the stuck-detection extension
 * to auto-stop the loop when the agent is stuck.
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

export default function (pi: ExtensionAPI) {
	let intervalId: NodeJS.Timeout | undefined;
	let currentPrompt = "";
	let intervalMinutes = 0;
	let loopActive = false;
	let loopRuns = 0;

	function clearLoop() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = undefined;
		}
		loopActive = false;
		currentPrompt = "";
		intervalMinutes = 0;
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

	// Auto-stop loop when stuck-detection fires
	pi.events.on("stuck:detected", () => {
		if (loopActive) {
			const prompt = currentPrompt;
			const runs = loopRuns;
			clearLoop();
			try {
				pi.sendMessage({
					customType: "loop-stopped",
					content: `Loop auto-stopped after ${runs} runs: "${prompt}"`,
					display: true,
				});
			} catch {
				/* ignore */
			}
		}
	});

	// Fire next prompt immediately when agent finishes
	pi.on("agent_end", async (_event, ctx) => {
		if (!loopActive || !currentPrompt) return;

		loopRuns++;
		ctx.ui.setStatus("loop", `loop: run #${loopRuns}`);

		setTimeout(() => {
			if (loopActive && currentPrompt && ctx.isIdle()) {
				startTimer();
				pi.sendUserMessage(currentPrompt);
			}
		}, 1000);
	});

	pi.registerCommand("loop", {
		description: "Run a prompt on a recurring interval. Usage: /loop <minutes> <prompt> | /loop stop | /loop status",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (!arg || arg === "stop") {
				if (loopActive) {
					const prompt = currentPrompt;
					clearLoop();
					ctx.ui.setStatus("loop", undefined);
					ctx.ui.notify(`Loop stopped after ${loopRuns} runs: "${prompt}"`, "info");
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

			const minutes = parseInt(match[1], 10);
			const prompt = match[2];

			if (minutes < 1) {
				ctx.ui.notify("Interval must be at least 1 minute", "warning");
				return;
			}

			if (loopActive) {
				clearLoop();
			}

			loopRuns = 0;
			currentPrompt = prompt;
			intervalMinutes = minutes;
			loopActive = true;
			startTimer();

			ctx.ui.setStatus("loop", "loop: started");
			ctx.ui.notify(`Loop started: "${prompt}" (max ${minutes}m between runs)`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		clearLoop();
	});
}
