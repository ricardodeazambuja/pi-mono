/**
 * Shared Output Filters
 *
 * Pattern library for stripping noise and extracting summaries from
 * command/tool outputs. Used by both token-saver (light filtering on
 * fresh output) and context-pruner (heavy summarization of old results).
 *
 * This is a library module, not a standalone extension. It exports a
 * no-op default function so pi doesn't error when auto-discovering it.
 *
 * Two modes:
 *   - stripNoise(command, text): Remove clutter, keep content (for token-saver)
 *   - summarize(toolName, text, isError): Extract 1-3 line summary (for pruner)
 */

// No-op extension factory so pi accepts this file in auto-discovery
export default function () {}

// --- Core helpers ---

/** Strip ANSI escape sequences. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

/** Collapse consecutive identical lines (3+ in a row). */
export function deduplicateLines(text: string): string {
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
				result.push(lastLine);
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
export function stripLinesMatching(text: string, patterns: RegExp[]): string {
	return text
		.split("\n")
		.filter((line) => !patterns.some((p) => p.test(line)))
		.join("\n");
}

/** Collapse runs of 3+ blank lines into one. */
export function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n");
}

/** Strip trailing whitespace from each line. */
export function stripTrailingWhitespace(text: string): string {
	return text
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n");
}

/** Format token count as human-readable string. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

/** Approximate token count from text. */
export function countTokensApprox(text: string): number {
	return Math.ceil(text.length / 4);
}

// --- Error extraction patterns ---

interface ErrorExtractor {
	name: string;
	/** Detect if this extractor applies to the output. */
	detect: RegExp;
	/** Extract the key error info (1-3 lines). */
	extract: (text: string) => string;
}

const ERROR_EXTRACTORS: ErrorExtractor[] = [
	{
		// Python traceback: extract the last exception line + file:line
		name: "python",
		detect: /Traceback \(most recent call last\)/,
		extract: (text) => {
			const lines = text.split("\n");
			// Find the last "File" reference and the exception line
			let lastFile = "";
			let exception = "";
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i].trim();
				if (!exception && line && !line.startsWith("File ") && !line.startsWith("Traceback")) {
					exception = line;
				}
				if (!lastFile && line.startsWith("File ")) {
					const match = line.match(/File "([^"]+)", line (\d+)/);
					if (match) lastFile = `${match[1]}:${match[2]}`;
				}
				if (lastFile && exception) break;
			}
			return lastFile ? `${lastFile} - ${exception}` : exception || text.split("\n").pop() || "";
		},
	},
	{
		// Node.js error: extract Error line + first file in stack
		name: "node",
		detect: /^\w*Error:|at\s+\S+\s+\(\S+:\d+:\d+\)/m,
		extract: (text) => {
			const lines = text.split("\n");
			let errorLine = "";
			let location = "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!errorLine && /^\w*Error:/.test(trimmed)) {
					errorLine = trimmed;
				}
				if (!location && /^\s*at\s+/.test(line)) {
					const match = trimmed.match(/\(([^)]+)\)/) || trimmed.match(/at\s+(\S+:\d+:\d+)/);
					if (match) location = match[1];
				}
				if (errorLine && location) break;
			}
			return location ? `${location} - ${errorLine}` : errorLine || lines[0] || "";
		},
	},
	{
		// gcc/g++: extract "file:line: error: message" lines
		name: "gcc",
		detect: /:\d+:\d+: (error|warning):/,
		extract: (text) => {
			const errors = text
				.split("\n")
				.filter((l) => /:\d+:\d+: error:/.test(l))
				.map((l) => l.trim());
			const summary =
				errors.length > 0
					? errors.slice(0, 3).join("\n")
					: text
							.split("\n")
							.filter((l) => /:\d+:\d+: warning:/.test(l))
							.slice(0, 3)
							.map((l) => l.trim())
							.join("\n");
			const extra = errors.length > 3 ? `\n... +${errors.length - 3} more errors` : "";
			return summary + extra || text.split("\n")[0] || "";
		},
	},
	{
		// Rust/cargo: extract "error[Exxxx]: message" + file:line
		name: "rust",
		detect: /error\[E\d+\]:/,
		extract: (text) => {
			const errors: string[] = [];
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (/^error\[E\d+\]:/.test(lines[i].trim())) {
					const errorMsg = lines[i].trim();
					// Next line with --> has the file:line
					const locLine = lines[i + 1]?.trim();
					const loc = locLine?.match(/--> (.+)/)?.[1] || "";
					errors.push(loc ? `${loc} - ${errorMsg}` : errorMsg);
				}
			}
			if (errors.length === 0) return text.split("\n").pop() || "";
			const shown = errors.slice(0, 3).join("\n");
			return errors.length > 3 ? `${shown}\n... +${errors.length - 3} more errors` : shown;
		},
	},
	{
		// TypeScript (tsc): extract "file(line,col): error TSxxxx: message"
		name: "tsc",
		detect: /\(\d+,\d+\): error TS\d+:/,
		extract: (text) => {
			const errors = text
				.split("\n")
				.filter((l) => /error TS\d+:/.test(l))
				.map((l) => l.trim())
				.slice(0, 5);
			const total = text.split("\n").filter((l) => /error TS\d+:/.test(l)).length;
			const extra = total > 5 ? `\n... +${total - 5} more errors` : "";
			return errors.join("\n") + extra || text.split("\n")[0] || "";
		},
	},
	{
		// ESLint/Biome: extract "file:line rule: message" or diagnostic lines
		name: "eslint",
		detect: /\d+:\d+\s+(error|warning)\s+/,
		extract: (text) => {
			const issues = text
				.split("\n")
				.filter((l) => /\d+:\d+\s+(error|warning)\s+/.test(l))
				.map((l) => l.trim())
				.slice(0, 5);
			const total = text.split("\n").filter((l) => /\d+:\d+\s+(error|warning)\s+/.test(l)).length;
			const extra = total > 5 ? `\n... +${total - 5} more issues` : "";
			return issues.join("\n") + extra || text.split("\n")[0] || "";
		},
	},
	{
		// pytest: extract FAILED test names + short assertion
		name: "pytest",
		detect: /FAILED|AssertionError|pytest/,
		extract: (text) => {
			const failed = text
				.split("\n")
				.filter((l) => /FAILED/.test(l))
				.map((l) => l.trim())
				.slice(0, 5);
			const short = text
				.split("\n")
				.filter((l) => /AssertionError|assert\s/.test(l))
				.map((l) => l.trim())
				.slice(0, 2);
			const parts = [...failed, ...short].filter(Boolean);
			return parts.length > 0 ? parts.join("\n") : text.split("\n").pop() || "";
		},
	},
	{
		// Jest/Vitest: extract failed test names + expected/received
		name: "jest",
		detect: /FAIL\s|✕|Expected:|Received:/,
		extract: (text) => {
			const lines = text.split("\n");
			const failed = lines
				.filter((l) => /✕|FAIL\s/.test(l))
				.map((l) => l.trim())
				.slice(0, 3);
			const expected = lines
				.filter((l) => /Expected:|Received:/.test(l))
				.map((l) => l.trim())
				.slice(0, 2);
			const parts = [...failed, ...expected].filter(Boolean);
			return parts.length > 0 ? parts.join("\n") : lines.pop() || "";
		},
	},
];

/**
 * Extract a smart 1-3 line summary from error output.
 * Tries each extractor pattern; falls back to last non-empty line.
 */
export function extractErrorSummary(text: string): string {
	const clean = stripAnsi(text);
	for (const ext of ERROR_EXTRACTORS) {
		if (ext.detect.test(clean)) {
			const result = ext.extract(clean);
			if (result.trim()) return result;
		}
	}
	// Fallback: last non-empty line
	const lines = clean.split("\n").filter((l) => l.trim());
	return lines[lines.length - 1]?.trim().slice(0, 150) || "";
}

/**
 * Extract a short summary from successful output.
 * Just returns the line count — the content isn't needed once consumed.
 */
export function extractSuccessSummary(text: string): string {
	const lineCount = text.split("\n").length;
	return `${lineCount} lines`;
}

// --- Noise stripping rules (for token-saver) ---

interface NoiseRule {
	name: string;
	matchCommand: RegExp;
	stripLinesMatching?: RegExp[];
	onEmpty?: string;
}

const NOISE_RULES: NoiseRule[] = [
	{
		name: "git-status",
		matchCommand: /^git\s+status/,
		stripLinesMatching: [/^\s*\(use "git /, /^\s*\(create\/copy files/],
	},
	{
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
	{
		name: "npm-install",
		matchCommand: /^(npm|pnpm|yarn)\s+(install|i|add|ci)\b/,
		stripLinesMatching: [/^npm warn/i, /^npm notice/i, /^npm http/, /^Progress:/, /^\.\.\.\s*$/],
	},
	{
		name: "npm-run",
		matchCommand: /^(npm|pnpm|yarn)\s+run\b/,
		stripLinesMatching: [/^>\s+\S+@[\d.]+\s+/],
	},
	{
		name: "pip-install",
		matchCommand: /^(pip|pip3|uv pip)\s+install\b/,
		stripLinesMatching: [/^\s+Downloading /, /^\s+Using cached /, /^Preparing metadata/, /^Building wheel/, /^\s+━+/],
	},
	{
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
	{
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
		name: "docker-pull",
		matchCommand: /^docker\s+pull\b/,
		stripLinesMatching: [
			/^[a-f0-9]+: (Pulling|Waiting|Downloading|Extracting|Pull complete|Verifying|Already exists)/,
			/^Digest:/,
		],
	},
	{
		name: "curl-progress",
		matchCommand: /^curl\b/,
		stripLinesMatching: [/^\s+% Total/, /^ {2}% Total.*Received/, /^\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/],
	},
	{
		name: "wget-progress",
		matchCommand: /^wget\b/,
		stripLinesMatching: [
			/^\s*\d+K\s+\.+/,
			/^Resolving /,
			/^Connecting to /,
			/^HTTP request sent/,
			/^Length:/,
			/^Saving to:/,
		],
	},
	{
		name: "make",
		matchCommand: /^make\b/,
		stripLinesMatching: [/^make\[\d+\]: (Entering|Leaving) directory/],
	},
	{
		name: "ping",
		matchCommand: /^ping\b/,
		stripLinesMatching: [/^PING /, /^Pinging /, /^\d+ bytes from /, /^Reply from .+: bytes=/],
	},
	{
		name: "rsync",
		matchCommand: /^rsync\b/,
		stripLinesMatching: [/^sending incremental file list$/, /^sent \d+.*bytes\s+received/],
	},
];

/**
 * Strip noise from a bash command's output (for token-saver).
 * Returns the cleaned output with clutter removed but all content preserved.
 */
export function stripNoise(command: string, text: string): string {
	let result = stripAnsi(text);

	const matchingRules = NOISE_RULES.filter((rule) => rule.matchCommand.test(command));

	for (const rule of matchingRules) {
		if (rule.stripLinesMatching) {
			result = stripLinesMatching(result, rule.stripLinesMatching);
		}
	}

	// Universal: progress bars and carriage-return overwrites
	result = stripLinesMatching(result, [/^\r/, /^\s*\d+%\s*[|█▓░▒]{3,}/]);

	result = stripTrailingWhitespace(result);
	result = collapseBlankLines(result);
	result = deduplicateLines(result);
	result = result.trim();

	if (!result) {
		const specificRule = matchingRules.find((r) => r.onEmpty);
		if (specificRule?.onEmpty) return specificRule.onEmpty;
	}

	return result;
}

/**
 * Summarize a tool result into a short string (for context-pruner).
 * Uses error extractors for failures, line count for successes.
 */
export function summarizeToolResult(toolName: string, content: string, isError: boolean): string {
	if (!content.trim()) return `[${toolName} ok]`;

	if (isError) {
		const summary = extractErrorSummary(content);
		return `[${toolName} error: ${summary}]`;
	}

	return `[${toolName} ok: ${extractSuccessSummary(content)}]`;
}

/**
 * Summarize a tool call into a short action line (for context-pruner).
 */
export function summarizeToolCall(name: string, args: Record<string, any>): string {
	if (name === "read") return `[read: ${args.file_path || "?"}]`;
	if (name === "write") return `[write: ${args.file_path || "?"}]`;
	if (name === "edit") return `[edit: ${args.file_path || "?"}]`;
	if (name === "bash") {
		const cmd = (args.command || "").slice(0, 80);
		return `[bash: ${cmd}]`;
	}
	if (name === "grep") return `[grep: "${args.pattern || "?"}" in ${args.path || "."}]`;
	if (name === "find" || name === "ls") return `[${name}: ${args.path || args.glob || "."}]`;

	const firstArg = Object.values(args)[0];
	const argStr = typeof firstArg === "string" ? firstArg.slice(0, 60) : "";
	return `[${name}${argStr ? `: ${argStr}` : ""}]`;
}
