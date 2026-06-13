/**
 * Tokenizer for the LaTeX math subset.
 *
 * Control words (`\frac`, `\alpha`) swallow trailing whitespace like TeX.
 * Control symbols (`\,`, `\{`, `\\`) become a `command` token whose value is the
 * single symbol character. Inter-atom whitespace is emitted as `space` tokens so
 * `\text{...}` can preserve word gaps while math mode ignores them.
 */

export type TokenType = "command" | "lbrace" | "rbrace" | "sup" | "sub" | "char" | "space";

export interface Token {
	type: TokenType;
	value: string;
}

const LETTER = /[a-zA-Z]/;
const SPACE = /\s/;

export function lex(src: string): Token[] {
	const cps = Array.from(src);
	const tokens: Token[] = [];
	let i = 0;
	while (i < cps.length) {
		const c = cps[i];
		if (c === "\\") {
			const next = cps[i + 1];
			if (next === undefined) throw new Error("trailing backslash");
			if (LETTER.test(next)) {
				let name = "";
				i += 1;
				while (i < cps.length && LETTER.test(cps[i])) {
					name += cps[i];
					i += 1;
				}
				while (i < cps.length && SPACE.test(cps[i])) i += 1;
				tokens.push({ type: "command", value: name });
			} else {
				tokens.push({ type: "command", value: next });
				i += 2;
			}
		} else if (c === "{") {
			tokens.push({ type: "lbrace", value: c });
			i += 1;
		} else if (c === "}") {
			tokens.push({ type: "rbrace", value: c });
			i += 1;
		} else if (c === "^") {
			tokens.push({ type: "sup", value: c });
			i += 1;
		} else if (c === "_") {
			tokens.push({ type: "sub", value: c });
			i += 1;
		} else if (SPACE.test(c)) {
			let s = "";
			while (i < cps.length && SPACE.test(cps[i])) {
				s += " ";
				i += 1;
			}
			tokens.push({ type: "space", value: s });
		} else {
			tokens.push({ type: "char", value: c });
			i += 1;
		}
	}
	return tokens;
}
