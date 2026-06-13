import { describe, expect, it } from "vitest";
import { formatToolWorkingMessage } from "../src/modes/interactive/interactive-mode.ts";

describe("formatToolWorkingMessage", () => {
	it("uses file_path as the target", () => {
		expect(formatToolWorkingMessage("Edit", { file_path: "src/app.ts" })).toBe("Edit: src/app.ts");
	});

	it("falls back to path, then command, then pattern", () => {
		expect(formatToolWorkingMessage("Read", { path: "/etc/hosts" })).toBe("Read: /etc/hosts");
		expect(formatToolWorkingMessage("Bash", { command: "ls -la" })).toBe("Bash: ls -la");
		expect(formatToolWorkingMessage("Grep", { pattern: "TODO" })).toBe("Grep: TODO");
	});

	it("prefers file_path over the other fields when several are present", () => {
		expect(formatToolWorkingMessage("Edit", { file_path: "a.ts", command: "x", pattern: "y" })).toBe("Edit: a.ts");
	});

	it("truncates long targets to the last 37 chars with a leading ellipsis", () => {
		const longPath = "/very/deeply/nested/directory/structure/that/exceeds/forty/characters/file.ts";
		const result = formatToolWorkingMessage("Edit", { file_path: longPath });
		expect(result).toBe(`Edit: ...${longPath.slice(-37)}`);
		// "Edit: " (6) + "..." (3) + 37 chars = 46
		expect(result.length).toBe(46);
	});

	it("returns the bare tool name when no usable target is present", () => {
		expect(formatToolWorkingMessage("Read", {})).toBe("Read");
		expect(formatToolWorkingMessage("Read", undefined)).toBe("Read");
		expect(formatToolWorkingMessage("Read", { file_path: "" })).toBe("Read");
		expect(formatToolWorkingMessage("Read", { file_path: 123 })).toBe("Read");
	});
});
