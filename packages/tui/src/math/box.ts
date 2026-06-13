/**
 * The 2D text-art layout core, modelled on TeX-style boxing.
 *
 * A `Box` is a rectangle of text rows plus a `baseline` row used to align
 * boxes horizontally (so `x` and a tall fraction line up on the same row).
 * All measurement is code-point based: every glyph in our symbol tables is a
 * single display cell, so `width` == number of code points per line, and we
 * never index by UTF-16 unit (astral glyphs like 𝔸 would break `.length`).
 */

export interface Box {
	/** Rows of text; each row has exactly `width` code points. */
	lines: string[];
	/** Display width in cells (code points per row). */
	width: number;
	/** Index into `lines` of the alignment row. */
	baseline: number;
}

/** Split into code points (so astral glyphs count as one cell). */
export function toCodePoints(s: string): string[] {
	return Array.from(s);
}

/** Display width of a single-row string, in cells. */
export function cellWidth(s: string): number {
	return toCodePoints(s).length;
}

function repeat(ch: string, n: number): string {
	return n <= 0 ? "" : ch.repeat(n);
}

function padRight(s: string, width: number): string {
	return s + repeat(" ", width - cellWidth(s));
}

function padCenter(s: string, width: number): string {
	const total = width - cellWidth(s);
	if (total <= 0) return s;
	const left = total >> 1;
	return repeat(" ", left) + s + repeat(" ", total - left);
}

const ALIGN_LEFT = "left";
const ALIGN_CENTER = "center";
type Align = typeof ALIGN_LEFT | typeof ALIGN_CENTER;

/** Build a normalized box from rows, padding every row to the max width. */
export function makeBox(lines: string[], baseline: number, align: Align = ALIGN_LEFT): Box {
	const rows = lines.length > 0 ? lines : [""];
	const width = Math.max(...rows.map(cellWidth));
	const padded = rows.map((l) => (align === ALIGN_CENTER ? padCenter(l, width) : padRight(l, width)));
	return { lines: padded, width, baseline: Math.max(0, Math.min(baseline, padded.length - 1)) };
}

/** A single-row box from a string with no newlines. */
export function textBox(s: string): Box {
	return { lines: [s], width: cellWidth(s), baseline: 0 };
}

/** An empty zero-width box. */
export function emptyBox(): Box {
	return { lines: [""], width: 0, baseline: 0 };
}

function blankRow(width: number): string {
	return repeat(" ", width);
}

/** Pad a box vertically so its baseline sits at `above` and total height is `above + below + 1`. */
function vpad(box: Box, above: number, below: number): string[] {
	const topGap = above - box.baseline;
	const botGap = below - (box.lines.length - 1 - box.baseline);
	const out: string[] = [];
	for (let i = 0; i < topGap; i++) out.push(blankRow(box.width));
	for (const l of box.lines) out.push(l);
	for (let i = 0; i < botGap; i++) out.push(blankRow(box.width));
	return out;
}

/** Join two boxes side by side, aligned on their baselines. */
export function hconcat2(a: Box, b: Box): Box {
	const above = Math.max(a.baseline, b.baseline);
	const below = Math.max(a.lines.length - 1 - a.baseline, b.lines.length - 1 - b.baseline);
	const al = vpad(a, above, below);
	const bl = vpad(b, above, below);
	const lines = al.map((l, i) => l + bl[i]);
	return { lines, width: a.width + b.width, baseline: above };
}

/** Join a list of boxes horizontally, aligned on baselines. */
export function hconcat(boxes: Box[]): Box {
	const real = boxes.filter((b) => b.width > 0 || b.lines.length > 1);
	if (real.length === 0) return emptyBox();
	return real.reduce(hconcat2);
}

/** Stack a numerator over a denominator with a fraction rule between them. */
export function fraction(num: Box, den: Box, ruleChar: string): Box {
	const width = Math.max(num.width, den.width);
	const lines: string[] = [];
	for (const l of num.lines) lines.push(padCenter(l, width));
	lines.push(repeat(ruleChar, width));
	const baseline = num.lines.length;
	for (const l of den.lines) lines.push(padCenter(l, width));
	return { lines, width, baseline };
}

/**
 * Attach optional superscript and/or subscript to a base box.
 * Scripts are placed up-right (sup) and down-right (sub) of the base.
 */
export function attachScripts(base: Box, sup: Box | undefined, sub: Box | undefined): Box {
	if (!sup && !sub) return base;
	const scriptWidth = Math.max(sup?.width ?? 0, sub?.width ?? 0);
	const supH = sup ? sup.lines.length : 0;
	const subH = sub ? sub.lines.length : 0;
	const baseW = base.width;
	const lines: string[] = [];
	// Superscript rows: empty under the base column, script on the right.
	for (let i = 0; i < supH; i++) {
		const s = sup ? padRight(sup.lines[i], scriptWidth) : blankRow(scriptWidth);
		lines.push(blankRow(baseW) + s);
	}
	// Base rows: base on the left, empty on the right.
	for (const l of base.lines) lines.push(l + blankRow(scriptWidth));
	// Subscript rows.
	for (let i = 0; i < subH; i++) {
		const s = sub ? padRight(sub.lines[i], scriptWidth) : blankRow(scriptWidth);
		lines.push(blankRow(baseW) + s);
	}
	return { lines, width: baseW + scriptWidth, baseline: supH + base.baseline };
}

/** Stack `upper` / `op` / `lower` centered (display-mode big operators). */
export function stackLimits(op: Box, upper: Box | undefined, lower: Box | undefined): Box {
	const width = Math.max(op.width, upper?.width ?? 0, lower?.width ?? 0);
	const lines: string[] = [];
	if (upper) for (const l of upper.lines) lines.push(padCenter(l, width));
	const baseline = lines.length + op.baseline;
	for (const l of op.lines) lines.push(padCenter(l, width));
	if (lower) for (const l of lower.lines) lines.push(padCenter(l, width));
	return { lines, width, baseline };
}

/** A radical (square root) over `body`, with an optional index. */
export function radical(body: Box, overlineChar: string, stemChar: string, index?: Box): Box {
	const h = body.lines.length;
	const bw = body.width;
	const lines: string[] = [];
	// Overline row sits above the body, offset by one stem column.
	lines.push(` ${repeat(overlineChar, bw)}`);
	for (let i = 0; i < h; i++) {
		const prefix = i === body.baseline ? stemChar : " ";
		lines.push(prefix + body.lines[i]);
	}
	const radicalBox: Box = { lines, width: bw + 1, baseline: body.baseline + 1 };
	if (index && index.width > 0) {
		// Small index tucked into the crook of the radical, on the overline row.
		const idx = makeBox(index.lines, index.lines.length - 1);
		return hconcat2(idx, radicalBox);
	}
	return radicalBox;
}

/** Wrap `body` in scalable delimiters sized to its height. */
export function delimited(
	left: { mid: string; top: string; ext: string; bot: string } | undefined,
	body: Box,
	right: { mid: string; top: string; ext: string; bot: string } | undefined,
): Box {
	const h = body.lines.length;
	if (h === 1) {
		const l = left ? left.mid : "";
		const r = right ? right.mid : "";
		return {
			lines: [l + body.lines[0] + r],
			width: cellWidth(l) + body.width + cellWidth(r),
			baseline: body.baseline,
		};
	}
	const column = (d: { top: string; ext: string; bot: string }): string[] => {
		const col: string[] = [];
		for (let i = 0; i < h; i++) col.push(i === 0 ? d.top : i === h - 1 ? d.bot : d.ext);
		return col;
	};
	const lcol = left ? column(left) : new Array(h).fill("");
	const rcol = right ? column(right) : new Array(h).fill("");
	const lw = left ? 1 : 0;
	const rw = right ? 1 : 0;
	const lines = body.lines.map((l, i) => lcol[i] + l + rcol[i]);
	return { lines, width: lw + body.width + rw, baseline: body.baseline };
}

/** Render a finished box to trimmed output rows (trailing blank space removed per line). */
export function boxToLines(box: Box): string[] {
	return box.lines.map((l) => l.replace(/\s+$/u, ""));
}
