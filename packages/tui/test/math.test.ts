import assert from "node:assert";
import { describe, it } from "node:test";
import { renderMath } from "../src/math/index.ts";

const uni = (latex: string, display = true) => renderMath(latex, { display, ascii: false, width: 80 });

describe("math engine (renderMath)", () => {
	it("typesets a fraction as a stacked, ruled box", () => {
		const out = uni("\\frac{a}{b}");
		assert.deepStrictEqual(out, ["a", "─", "b"]);
	});

	it("uses Unicode superscripts for simple exponents (single line)", () => {
		const out = uni("x^2", false);
		assert.deepStrictEqual(out, ["x²"]);
	});

	it("uses Unicode subscripts", () => {
		const out = uni("x_{i+1}", false);
		assert.deepStrictEqual(out, ["xᵢ₊₁"]);
	});

	it("maps Greek and relation symbols", () => {
		assert.deepStrictEqual(uni("\\alpha \\le \\beta", false), ["α≤β"]);
	});

	it("renders a square root with an overline above the body", () => {
		const out = uni("\\sqrt{x}");
		assert.ok(out !== null);
		assert.ok(out[0].includes("‾"), `expected overline, got ${JSON.stringify(out)}`);
		assert.ok(
			out.some((l) => l.includes("√")),
			"expected radical sign",
		);
	});

	it("stacks big-operator limits in display mode", () => {
		const out = uni("\\sum_{k=0}^{n} k");
		assert.ok(out !== null);
		assert.ok(out.length >= 3, "sum should be at least 3 rows tall");
		assert.ok(out.some((l) => l.includes("∑")));
		assert.ok(out.some((l) => l.includes("n")));
		assert.ok(out.some((l) => l.includes("k=0")));
	});

	it("scales delimiters around tall content", () => {
		const out = uni("\\left(\\frac{a}{b}\\right)");
		assert.ok(out !== null);
		assert.ok(out[0].includes("⎛") && out[2].includes("⎝"), `got ${JSON.stringify(out)}`);
	});

	it("returns null for unsupported constructs (matrix)", () => {
		assert.strictEqual(uni("\\begin{matrix} a & b \\end{matrix}"), null);
	});

	it("returns null for an unknown command", () => {
		assert.strictEqual(uni("\\frobnicate{x}"), null);
	});

	it("returns null when the result is wider than the budget", () => {
		assert.strictEqual(renderMath("a + b + c + d", { display: true, ascii: false, width: 4 }), null);
	});

	it("ASCII mode emits only ASCII bytes", () => {
		const out = renderMath("\\frac{a}{b} \\times \\sqrt{c}", { display: true, ascii: true, width: 80 });
		assert.ok(out !== null);
		for (const line of out) {
			assert.ok(/^[\x00-\x7f]*$/.test(line), `non-ASCII in: ${JSON.stringify(line)}`);
		}
		assert.ok(
			out.some((l) => l.includes("-")),
			"fraction rule should be ASCII '-'",
		);
	});

	it("returns null for empty input", () => {
		assert.strictEqual(uni("   "), null);
	});
});
