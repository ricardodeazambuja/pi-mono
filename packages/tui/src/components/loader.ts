import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private startTime: number = Date.now();

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start() {
		this.startTime = Date.now();
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	private formatElapsed(): string {
		const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
		if (elapsed < 1) return "";
		if (elapsed < 60) return ` (${elapsed}s)`;
		const min = Math.floor(elapsed / 60);
		const sec = elapsed % 60;
		return ` (${min}m${sec.toString().padStart(2, "0")}s)`;
	}

	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		const elapsed = this.formatElapsed();
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message + elapsed)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
