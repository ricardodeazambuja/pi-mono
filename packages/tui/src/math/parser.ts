/**
 * Recursive-descent layout: tokens -> `Box` text-art.
 *
 * Rather than build an explicit AST, each parse method returns a laid-out `Box`
 * (composition is naturally bottom-up). Anything we don't support throws, and the
 * caller (`renderMath`) turns a throw into `null` so the raw LaTeX is shown
 * instead of broken output.
 */

import {
	attachScripts,
	type Box,
	delimited,
	emptyBox,
	fraction,
	hconcat,
	makeBox,
	radical,
	stackLimits,
	textBox,
	toCodePoints,
} from "./box.ts";
import { lex, type Token } from "./lexer.ts";
import {
	BIG_OPERATORS,
	DELIM_ALIASES,
	DELIMS_ASCII,
	DELIMS_UNICODE,
	type DelimPieces,
	MATHBB,
	SUBSCRIPTS,
	SUPERSCRIPTS,
	SYMBOLS,
} from "./symbols.ts";

export interface LayoutOptions {
	ascii: boolean;
	display: boolean;
}

const MAX_DEPTH = 40;

/** Control symbols that act as inter-atom spacing. */
const SPACING: Record<string, number> = { ",": 1, ";": 1, ":": 1, " ": 1, ">": 1, "!": 0, "/": 0 };

/** Commands that only affect TeX styling/numbering — rendered as nothing. */
const IGNORED_COMMANDS = new Set([
	"displaystyle",
	"textstyle",
	"scriptstyle",
	"scriptscriptstyle",
	"notag",
	"nonumber",
	"limits",
	"nolimits",
]);

const FONT_GROUP_COMMANDS = new Set(["mathbf", "mathcal", "mathit", "mathsf", "mathtt", "boldsymbol", "mathrm", "bm"]);

class Parser {
	private readonly tokens: Token[];
	private readonly opts: LayoutOptions;
	private pos = 0;
	private depth = 0;

	constructor(tokens: Token[], opts: LayoutOptions) {
		this.tokens = tokens;
		this.opts = opts;
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private peekNonSpace(): Token | undefined {
		let i = this.pos;
		while (this.tokens[i]?.type === "space") i += 1;
		return this.tokens[i];
	}

	private skipSpaces(): void {
		while (this.peek()?.type === "space") this.pos += 1;
	}

	private next(): Token | undefined {
		return this.tokens[this.pos++];
	}

	private expect(type: Token["type"]): Token {
		const t = this.next();
		if (!t || t.type !== type) throw new Error(`expected ${type}`);
		return t;
	}

	/** Parse a horizontal run until a closing brace or EOF. */
	parseRow(stopAtRight = false): Box {
		if (++this.depth > MAX_DEPTH) throw new Error("too deep");
		const atoms: Box[] = [];
		for (;;) {
			this.skipSpaces();
			const t = this.peek();
			if (!t || t.type === "rbrace") break;
			if (stopAtRight && t.type === "command" && t.value === "right") break;
			atoms.push(this.parseScripted());
		}
		this.depth -= 1;
		return atoms.length > 0 ? hconcat(atoms) : emptyBox();
	}

	/** Parse one atom plus any trailing ^/_ scripts bound to it. */
	private parseScripted(): Box {
		const { box, bigOp } = this.parseAtom();
		let sup: Box | undefined;
		let sub: Box | undefined;
		for (;;) {
			const t = this.peekNonSpace();
			if (t?.type === "sup") {
				this.skipSpaces();
				this.next();
				if (sup) throw new Error("double superscript");
				sup = this.parseArg();
			} else if (t?.type === "sub") {
				this.skipSpaces();
				this.next();
				if (sub) throw new Error("double subscript");
				sub = this.parseArg();
			} else {
				break;
			}
		}
		let result: Box;
		if (!sup && !sub) {
			result = box;
		} else if (bigOp && this.opts.display) {
			result = stackLimits(box, sup, sub);
		} else {
			result = this.tryFastScript(box, sup, sub) ?? attachScripts(box, sup, sub);
		}
		// Big operators read better with a gap before their operand (∑ x, not ∑x).
		if (bigOp) result = hconcat([result, textBox(" ")]);
		return result;
	}

	/** Inline single-line scripts via Unicode super/subscript glyphs, when possible. */
	private tryFastScript(base: Box, sup: Box | undefined, sub: Box | undefined): Box | null {
		if (this.opts.ascii || base.lines.length !== 1) return null;
		if (sup && sub) return null;
		const script = sup ?? sub;
		if (!script || script.lines.length !== 1) return null;
		const map = sup ? SUPERSCRIPTS : SUBSCRIPTS;
		const cps = toCodePoints(script.lines[0].trimEnd());
		if (cps.length === 0) return null;
		let mapped = "";
		for (const c of cps) {
			const m = map[c];
			if (!m) return null;
			mapped += m;
		}
		return textBox(base.lines[0] + mapped);
	}

	/** Parse a single argument: a braced group or one atom. */
	private parseArg(): Box {
		this.skipSpaces();
		const t = this.peek();
		if (t?.type === "lbrace") {
			this.next();
			const body = this.parseRow();
			this.expect("rbrace");
			return body;
		}
		return this.parseAtom().box;
	}

	private parseAtom(): { box: Box; bigOp: boolean } {
		this.skipSpaces();
		const t = this.next();
		if (!t) return { box: emptyBox(), bigOp: false };
		switch (t.type) {
			case "lbrace": {
				const body = this.parseRow();
				this.expect("rbrace");
				return { box: body, bigOp: false };
			}
			case "char":
				return { box: textBox(this.mapChar(t.value)), bigOp: false };
			case "command":
				return this.parseCommand(t.value);
			case "sup":
			case "sub":
				// A script with no base (e.g. "^2"): treat base as empty.
				this.pos -= 1;
				return { box: emptyBox(), bigOp: false };
			default:
				throw new Error(`unexpected ${t.type}`);
		}
	}

	private mapChar(c: string): string {
		if (this.opts.ascii) return c;
		if (c === "-") return "−";
		if (c === "'") return "′";
		if (c === "*") return "∗";
		return c;
	}

	private parseCommand(name: string): { box: Box; bigOp: boolean } {
		// Control-symbol spacing (\, \; \quad-ish).
		if (name in SPACING) {
			const w = SPACING[name];
			return { box: w > 0 ? textBox(" ".repeat(w)) : emptyBox(), bigOp: false };
		}
		switch (name) {
			case "quad":
				return { box: textBox("  "), bigOp: false };
			case "qquad":
				return { box: textBox("    "), bigOp: false };
			case "{":
			case "}":
			case "$":
			case "%":
			case "#":
			case "_":
			case "&":
				return { box: textBox(name), bigOp: false };
			case "\\":
				throw new Error("line break unsupported");
			case "frac":
			case "dfrac":
			case "tfrac": {
				const num = this.parseArg();
				const den = this.parseArg();
				return { box: fraction(num, den, this.opts.ascii ? "-" : "─"), bigOp: false };
			}
			case "binom":
			case "dbinom": {
				const top = this.parseArg();
				const bot = this.parseArg();
				const stacked = stackLimits(textBox(" "), top, bot);
				return { box: this.wrap(stacked, "(", ")"), bigOp: false };
			}
			case "sqrt": {
				const index = this.parseOptionalBracket();
				const body = this.parseArg();
				return {
					box: radical(body, this.opts.ascii ? "_" : "‾", this.opts.ascii ? "\\" : "√", index),
					bigOp: false,
				};
			}
			case "text":
			case "mathrm":
			case "operatorname":
			case "mbox": {
				return { box: textBox(this.readRawGroup()), bigOp: false };
			}
			case "mathbb": {
				return { box: this.parseFontGroup((ch) => MATHBB[ch] ?? ch), bigOp: false };
			}
			case "left":
				return { box: this.parseLeftRight(), bigOp: false };
			case "right":
				throw new Error("unmatched \\right");
		}
		if (FONT_GROUP_COMMANDS.has(name)) {
			return { box: this.parseFontGroup((ch) => ch), bigOp: false };
		}
		if (IGNORED_COMMANDS.has(name)) {
			return { box: emptyBox(), bigOp: false };
		}
		const big = BIG_OPERATORS[name];
		if (big) {
			return { box: textBox(this.opts.ascii ? big.a : big.u), bigOp: true };
		}
		const sym = SYMBOLS[name];
		if (sym) {
			return { box: textBox(this.opts.ascii ? sym.a : sym.u), bigOp: false };
		}
		throw new Error(`unsupported command \\${name}`);
	}

	/** `\mathbf{...}` etc: render a group, mapping each plain char through `mapFn`. */
	private parseFontGroup(mapFn: (ch: string) => string): Box {
		this.skipSpaces();
		if (this.peek()?.type === "lbrace") {
			this.next();
			const boxes: Box[] = [];
			for (;;) {
				this.skipSpaces();
				const t = this.peek();
				if (!t || t.type === "rbrace") break;
				if (t.type === "char") {
					this.next();
					boxes.push(textBox(mapFn(t.value)));
				} else {
					boxes.push(this.parseScripted());
				}
			}
			this.expect("rbrace");
			return boxes.length > 0 ? hconcat(boxes) : emptyBox();
		}
		const t = this.next();
		if (t?.type === "char") return textBox(mapFn(t.value));
		return emptyBox();
	}

	/** Read a `{...}` group as raw upright text, preserving spaces. */
	private readRawGroup(): string {
		this.skipSpaces();
		if (this.peek()?.type !== "lbrace") {
			const t = this.next();
			return t ? t.value : "";
		}
		this.next();
		let out = "";
		let depth = 1;
		for (;;) {
			const t = this.next();
			if (!t) throw new Error("unterminated \\text");
			if (t.type === "lbrace") {
				depth += 1;
				out += "{";
			} else if (t.type === "rbrace") {
				depth -= 1;
				if (depth === 0) break;
				out += "}";
			} else if (t.type === "command") {
				out += t.value;
			} else {
				out += t.value;
			}
		}
		return out;
	}

	private parseOptionalBracket(): Box | undefined {
		this.skipSpaces();
		const t = this.peek();
		if (t?.type !== "char" || t.value !== "[") return undefined;
		this.next();
		const boxes: Box[] = [];
		for (;;) {
			const tk = this.peek();
			if (!tk) throw new Error("unterminated [");
			if (tk.type === "char" && tk.value === "]") {
				this.next();
				break;
			}
			if (tk.type === "space") {
				this.next();
				continue;
			}
			boxes.push(this.parseScripted());
		}
		if (boxes.length === 0) return undefined;
		const joined = hconcat(boxes);
		return makeBox(joined.lines, joined.lines.length - 1);
	}

	private parseLeftRight(): Box {
		const left = this.readDelim();
		const body = this.parseRow(true);
		const close = this.next();
		if (!close || close.type !== "command" || close.value !== "right") throw new Error("missing \\right");
		const right = this.readDelim();
		return this.wrapPieces(left, body, right);
	}

	/** Read the delimiter token following \left or \right; "." means none. */
	private readDelim(): DelimPieces | undefined {
		this.skipSpaces();
		const t = this.next();
		if (!t) throw new Error("missing delimiter");
		let key: string | undefined;
		if (t.type === "char") {
			if (t.value === ".") return undefined;
			key = DELIM_ALIASES[t.value];
		} else if (t.type === "command") {
			key = DELIM_ALIASES[t.value];
		}
		if (key === undefined) throw new Error("bad delimiter");
		if (key === "") return undefined;
		const table = this.opts.ascii ? DELIMS_ASCII : DELIMS_UNICODE;
		return table[key];
	}

	private wrap(body: Box, leftKey: string, rightKey: string): Box {
		const table = this.opts.ascii ? DELIMS_ASCII : DELIMS_UNICODE;
		return delimited(table[leftKey], body, table[rightKey]);
	}

	private wrapPieces(left: DelimPieces | undefined, body: Box, right: DelimPieces | undefined): Box {
		return delimited(left, body, right);
	}
}

export function layout(latex: string, opts: LayoutOptions): Box {
	const tokens = lex(latex);
	const parser = new Parser(tokens, opts);
	const box = parser.parseRow();
	return box;
}
