import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

const stubUi = { requestRender() {} } as unknown as TUI;
const identity = (s: string) => s;

function renderedText(loader: Loader): string {
	return loader.render(80).join("");
}

describe("Loader elapsed time", () => {
	afterEach(() => {
		mock.timers.reset();
	});

	it("appends elapsed seconds to the message", () => {
		mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const loader = new Loader(stubUi, identity, identity, "Working...");
		mock.timers.tick(12_000);
		loader.setMessage("Working...");
		assert.match(renderedText(loader), /Working\.\.\. \(12s\)/);
		loader.stop();
	});

	it("formats minutes and zero-padded seconds past 60s", () => {
		mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const loader = new Loader(stubUi, identity, identity, "Working...");
		mock.timers.tick(62_000);
		loader.setMessage("Working...");
		assert.match(renderedText(loader), /\(1m02s\)/);
		loader.stop();
	});

	it("shows no elapsed suffix during the first second", () => {
		mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const loader = new Loader(stubUi, identity, identity, "Working...");
		mock.timers.tick(500);
		loader.setMessage("Working...");
		assert.doesNotMatch(renderedText(loader), /\(\d/);
		loader.stop();
	});
});
