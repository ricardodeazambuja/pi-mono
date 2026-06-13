/**
 * LaTeX-math → Unicode/ASCII text-art renderer.
 *
 * `renderMath` is the single entry point used by the markdown renderer. It is
 * deliberately total: any unsupported construct, parse error, or over-wide
 * result yields `null`, and the caller falls back to showing the raw `$…$`
 * source. Output is display-only; the model never sees the rendered art.
 */

import { boxToLines, cellWidth } from "./box.ts";
import { layout } from "./parser.ts";

export interface RenderMathOptions {
	/** Display math (`$$…$$`) stacks big-operator limits; inline keeps them beside. */
	display: boolean;
	/** ASCII-only output (no non-ASCII bytes) for terminals without Unicode. */
	ascii: boolean;
	/** Maximum width in cells; a wider result returns `null` (caller shows raw). */
	width: number;
}

/** Hard cap on input length — pathological inputs fall back to raw. */
const MAX_INPUT = 1000;

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start += 1;
	while (end > start && lines[end - 1].trim() === "") end -= 1;
	return lines.slice(start, end);
}

/**
 * Render LaTeX math to text rows, or `null` if it can't be rendered cleanly.
 */
export function renderMath(latex: string, opts: RenderMathOptions): string[] | null {
	const src = latex.trim();
	if (src.length === 0 || src.length > MAX_INPUT) return null;
	try {
		const box = layout(src, { ascii: opts.ascii, display: opts.display });
		const lines = trimBlankEdges(boxToLines(box));
		if (lines.length === 0) return null;
		if (lines.length === 1 && lines[0].trim() === "") return null;
		for (const line of lines) {
			if (cellWidth(line) > opts.width) return null;
		}
		return lines;
	} catch {
		return null;
	}
}
