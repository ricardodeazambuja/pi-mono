/**
 * Token Saver Extension (inspired by RTK - Rust Token Killer)
 *
 * Intercepts bash tool results and strips noise/clutter from outputs before
 * they reach the LLM context, while preserving all meaningful content.
 *
 * Philosophy: Remove clutter, NOT content.
 *   - Strip ANSI escape codes from all bash outputs
 *   - Strip git hints ("use git add...", "use git restore...")
 *   - Strip progress bars, spinner artifacts, download counters
 *   - Collapse runs of 3+ blank lines into one
 *   - Collapse consecutive duplicate lines (log spam)
 *   - Strip boilerplate from known commands (npm install, pip, docker, etc.)
 *
 * ONLY filters bash tool outputs. Does NOT touch read/grep/find/ls/edit/write
 * results — those are already well-structured by pi-coding-agent's tool system
 * and filtering them risks losing meaningful content (code, search results, etc.).
 *
 * Filter rules only strip lines that are definitively noise for each specific
 * command. Unknown commands only get ANSI stripping and progress bar removal.
 *
 * Usage:
 *   pi -e ./token-saver.ts
 *   Or copy to ~/.pi/agent/extensions/ for global use
 *
 * Commands:
 *   /savings         - Show token savings stats for this session
 *   /savings reset   - Reset stats
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Core helpers ---

function countTokensApprox(text: string): number {
	return Math.ceil(text.length / 4);
}

function getTextContent(event: { content: Array<{ type: string; text?: string }> }): string {
	return event.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function makeResult(text: string) {
	return { content: [{ type: "text", text }] };
}

/** Strip ANSI escape sequences. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

/**
 * Collapse consecutive identical lines (3+ in a row) into the first
 * occurrence plus a count. Keeps 2 identical lines untouched since
 * that's common in legitimate output.
 */
function deduplicateLines(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let lastLine = "";
	let repeatCount = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === lastLine && trimmed !== "") {
			repeatCount++;
		} else {
			if (repeatCount > 2) {
				result.push(`  ... (repeated ${repeatCount} more times)`);
			} else if (repeatCount === 2) {
				result.push(lastLine); // keep the 2nd duplicate as-is
			}
			result.push(line);
			lastLine = trimmed;
			repeatCount = 0;
		}
	}
	if (repeatCount > 2) {
		result.push(`  ... (repeated ${repeatCount} more times)`);
	} else if (repeatCount === 2) {
		result.push(lastLine);
	}
	return result.join("\n");
}

/** Remove lines matching any of the given regex patterns. */
function stripLinesMatching(text: string, patterns: RegExp[]): string {
	return text
		.split("\n")
		.filter((line) => !patterns.some((p) => p.test(line)))
		.join("\n");
}

/** Collapse runs of 3+ blank lines into a single blank line. */
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n");
}

/** Strip trailing whitespace from each line. */
function stripTrailingWhitespace(text: string): string {
	return text
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n");
}

// --- Filter rule system (inspired by RTK's TOML filters) ---

interface FilterRule {
	name: string;
	matchCommand: RegExp;
	stripLinesMatching?: RegExp[];
	onEmpty?: string;
}

// Each rule only strips lines that are definitively noise for that command.
// If a command is not matched, ONLY ANSI stripping + progress bar removal applies.
const FILTER_RULES: FilterRule[] = [
	// --- Git ---
	{
		// git status: strip only the instructional hints, NOT branch info
		name: "git-status",
		matchCommand: /^git\s+status/,
		stripLinesMatching: [/^\s*\(use "git /, /^\s*\(create\/copy files/],
	},
	{
		// git push: strip transfer progress, keep branch refs and errors
		name: "git-push",
		matchCommand: /^git\s+push\b/,
		stripLinesMatching: [
			/^Enumerating objects:/,
			/^Counting objects:/,
			/^Delta compression/,
			/^Compressing objects:/,
			/^Writing objects:/,
			/^Total \d/,
			/^remote: Resolving deltas/,
			/^remote: Compressing/,
			/^remote:\s*$/,
		],
	},
	{
		// git pull: strip transfer progress, keep merge info and file changes
		name: "git-pull",
		matchCommand: /^git\s+pull\b/,
		stripLinesMatching: [
			/^remote: Enumerating/,
			/^remote: Counting/,
			/^remote: Compressing/,
			/^remote: Total/,
			/^Unpacking objects:/,
		],
	},
	{
		// git fetch: strip transfer progress
		name: "git-fetch",
		matchCommand: /^git\s+fetch\b/,
		stripLinesMatching: [
			/^remote: Enumerating/,
			/^remote: Counting/,
			/^remote: Compressing/,
			/^remote: Total/,
			/^Unpacking objects:/,
		],
		onEmpty: "ok",
	},
	{
		// git clone: strip transfer progress
		name: "git-clone",
		matchCommand: /^git\s+clone\b/,
		stripLinesMatching: [
			/^remote: Enumerating/,
			/^remote: Counting/,
			/^remote: Compressing/,
			/^remote: Total/,
			/^Receiving objects:/,
			/^Resolving deltas:/,
			/^Unpacking objects:/,
		],
	},
	// --- npm/pnpm/yarn ---
	{
		// npm install: strip warnings, notices, http logs, progress
		name: "npm-install",
		matchCommand: /^(npm|pnpm|yarn)\s+(install|i|add|ci)\b/,
		stripLinesMatching: [/^npm warn/i, /^npm notice/i, /^npm http/, /^Progress:/, /^\.\.\.\s*$/],
	},
	{
		// npm run: strip the "> package@version scriptname" boilerplate line
		name: "npm-run",
		matchCommand: /^(npm|pnpm|yarn)\s+run\b/,
		stripLinesMatching: [/^>\s+\S+@[\d.]+\s+/],
	},
	// --- pip/uv ---
	{
		// pip install: strip download/cache progress, keep what was installed
		name: "pip-install",
		matchCommand: /^(pip|pip3|uv pip)\s+install\b/,
		stripLinesMatching: [/^\s+Downloading /, /^\s+Using cached /, /^Preparing metadata/, /^Building wheel/, /^\s+━+/],
	},
	// --- cargo ---
	{
		// cargo build/check: strip per-crate compile lines, keep errors/warnings
		name: "cargo-build",
		matchCommand: /^cargo\s+(build|check)\b/,
		stripLinesMatching: [
			/^\s*Compiling /,
			/^\s*Downloading /,
			/^\s*Downloaded /,
			/^\s*Blocking /,
			/^\s*Updating /,
			/^\s*Locking /,
			/^\s*Fresh /,
		],
		onEmpty: "ok",
	},
	// --- docker ---
	{
		// docker build: strip internal layer operations, keep build steps and errors
		name: "docker-build",
		matchCommand: /^docker\s+(build|buildx)\b/,
		stripLinesMatching: [
			/^#\d+ sha256:/,
			/^#\d+ DONE/,
			/^#\d+ CACHED/,
			/^#\d+ transferring/,
			/^#\d+ extracting/,
			/^#\d+ resolve /,
		],
	},
	{
		// docker pull: strip per-layer download progress
		name: "docker-pull",
		matchCommand: /^docker\s+pull\b/,
		stripLinesMatching: [
			/^[a-f0-9]+: (Pulling|Waiting|Downloading|Extracting|Pull complete|Verifying|Already exists)/,
			/^Digest:/,
		],
	},
	// --- curl/wget ---
	{
		// curl: strip the progress table, keep response
		name: "curl-progress",
		matchCommand: /^curl\b/,
		stripLinesMatching: [
			/^\s+% Total/,
			/^ {2}% Total.*Received/,
			/^\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/, // curl progress table rows (6+ num columns)
		],
	},
	{
		// wget: strip connection and progress noise, keep result
		name: "wget-progress",
		matchCommand: /^wget\b/,
		stripLinesMatching: [
			/^\s*\d+K\s+\.+/, // progress dots
			/^Resolving /,
			/^Connecting to /,
			/^HTTP request sent/,
			/^Length:/,
			/^Saving to:/,
		],
	},
	// --- make ---
	{
		// make: strip directory enter/leave noise
		name: "make",
		matchCommand: /^make\b/,
		stripLinesMatching: [/^make\[\d+\]: (Entering|Leaving) directory/],
	},
	// --- ping ---
	{
		// ping: strip per-packet lines (but keep timeout/error lines), keep summary
		name: "ping",
		matchCommand: /^ping\b/,
		stripLinesMatching: [/^PING /, /^Pinging /, /^\d+ bytes from /, /^Reply from .+: bytes=/],
	},
	// --- rsync ---
	{
		// rsync: strip progress boilerplate
		name: "rsync",
		matchCommand: /^rsync\b/,
		stripLinesMatching: [/^sending incremental file list$/, /^sent \d+.*bytes\s+received/],
	},
];

/** Apply the filter rule engine to a command's output. */
function applyFilters(command: string, text: string): string {
	// Always strip ANSI — this is safe for any command
	let result = stripAnsi(text);

	// Find matching specific rules (NOT a catch-all)
	const matchingRules = FILTER_RULES.filter((rule) => rule.matchCommand.test(command));

	// Apply command-specific noise stripping
	for (const rule of matchingRules) {
		if (rule.stripLinesMatching) {
			result = stripLinesMatching(result, rule.stripLinesMatching);
		}
	}

	// Safe universal cleanup: progress bars and carriage-return overwrites
	// These are rendering artifacts, never meaningful content
	result = stripLinesMatching(result, [
		/^\r/, // carriage-return progress overrides
		/^\s*\d+%\s*[|█▓░▒]{3,}/, // progress bars (require 3+ bar chars to avoid false matches)
	]);

	result = stripTrailingWhitespace(result);
	result = collapseBlankLines(result);
	result = deduplicateLines(result);
	result = result.trim();

	// onEmpty only for commands where empty output means success
	if (!result) {
		const specificRule = matchingRules.find((r) => r.onEmpty);
		if (specificRule?.onEmpty) {
			return specificRule.onEmpty;
		}
	}

	return result;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let savedTokens = 0;
	let compressedCount = 0;
	let totalToolResults = 0;

	pi.on("tool_result" as any, async (event: any, _ctx: any) => {
		totalToolResults++;

		if (!enabled) return undefined;

		// ONLY filter bash tool outputs. Other tools (read, grep, find, ls, edit,
		// write) produce well-structured output from pi-coding-agent's tool system.
		// Filtering those risks losing meaningful content like source code,
		// search results, or file listings.
		if (event.toolName !== "bash") return undefined;

		const text = getTextContent(event);
		if (!text) return undefined;

		const command = (event.input.command as string) || "";
		const originalTokens = countTokensApprox(text);
		const filtered = applyFilters(command, text);

		// Only apply if we actually removed something meaningful
		if (filtered.length < text.length) {
			const newTokens = countTokensApprox(filtered);
			const saved = originalTokens - newTokens;
			if (saved > 10) {
				savedTokens += saved;
				compressedCount++;
				return makeResult(filtered);
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

			// No args or unknown args: show status + stats
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
