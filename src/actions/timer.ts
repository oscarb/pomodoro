import { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { exec } from "child_process";
import { z } from "zod";
import { generateSvg } from "./timer-view";
import { TimerState } from "./timer-types";

// Define the schema for settings input (what comes from PI)
// and transformation (what we use in code)
const TimerSettingsSchema = z.object({
	workTime: z.string().optional().transform(val => {
		const parsed = parseInt(val ?? "25");
		return isNaN(parsed) || parsed < 1 ? 25 : parsed;
	}),
	breakTime: z.string().optional().transform(val => {
		const parsed = parseInt(val ?? "5");
		return isNaN(parsed) || parsed < 1 ? 5 : parsed;
	}),
	numCycles: z.string().optional().transform(val => {
		const parsed = parseInt(val ?? "4");
		// Clamp between 1 and 4
		return Math.min(4, Math.max(1, isNaN(parsed) ? 4 : parsed));
	}),
	soundEnabled: z.boolean().optional().default(false)
});

// The raw settings type expected from the Stream Deck (mostly strings)
type RawTimerSettings = z.input<typeof TimerSettingsSchema>;
// The validated/transformed settings type we use internally (numbers)
type ParsedTimerSettings = z.output<typeof TimerSettingsSchema>;



interface TimerLastState {
	progressStep: number;
	title: string;
	contentOpacity: number;
	globalOpacity: number;
	pulseOpacity: number;
	indicatorOpacity: number;
	state: TimerState;
	currentCycle: number;
}

interface TimerContext {
	state: TimerState;
	currentCycle: number; // 0-3
	targetEndTime: number; // Timestamp in ms
	remainingSeconds: number; // For display and state tracking
	timer: NodeJS.Timeout | null;
	pauseAnimationTimer: NodeJS.Timeout | null;
	holdTimeout: NodeJS.Timeout | null;
	didHoldAction: boolean;
	lastState: Record<string, unknown> | TimerLastState;
}

// Define a minimal Action interface that supports what we need
// This avoids issues with strict SDK types in our helper methods
interface TimerAction {
	setTitle(title: string): Promise<void>;
	setImage(image: string): Promise<void>;
}

type ActionEvent = {
	action: TimerAction;
};

@action({ UUID: "se.oscarb.pomodoro.timer" })
export class Timer extends SingletonAction<RawTimerSettings> {
	private contexts = new Map<string, TimerContext>();

	public override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev.action.id);
		const settings = this.parseSettings(ev.payload.settings);
		await this.reset(ev, ctx, settings);
	}

	public override async onKeyDown(ev: KeyDownEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev.action.id);
		const settings = this.parseSettings(ev.payload.settings);
		ctx.didHoldAction = false;
		// Start long-press detection
		ctx.holdTimeout = setTimeout(async () => {
			ctx.didHoldAction = true;
			if (ctx.state === TimerState.PAUSED_WORK || ctx.state === TimerState.PAUSED_BREAK) {
				await this.advanceNextStep(ev, ctx, settings);
			} else {
				await this.reset(ev, ctx, settings);
			}
		}, 1500); // 1.5s hold to perform action
	}

	public override async onKeyUp(ev: KeyUpEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev.action.id);
		const settings = this.parseSettings(ev.payload.settings);
		if (ctx.holdTimeout) {
			clearTimeout(ctx.holdTimeout);
			ctx.holdTimeout = null;
		}

		if (ctx.didHoldAction) {
			// Already performed hold action, do nothing
			return;
		}

		await this.handleShortPress(ev, ctx, settings);
	}

	public override async onWillAppear(ev: WillAppearEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev.action.id);
		const settings = this.parseSettings(ev.payload.settings);
		this.updateStateFromSettings(settings, ctx);
		await this.updateView(ev, ctx, settings);
	}

	public override async onWillDisappear(ev: WillDisappearEvent<RawTimerSettings>): Promise<void> {
		const id = ev.action.id;
		const ctx = this.contexts.get(id);
		if (ctx) {
			this.stopTimer(ctx);
			this.stopPauseAnimation(ctx);
			if (ctx.holdTimeout) {
				clearTimeout(ctx.holdTimeout);
			}
			this.contexts.delete(id);
		}
	}

	private async advanceNextStep(ev: ActionEvent, ctx: TimerContext, settings: ParsedTimerSettings) {
		this.stopPauseAnimation(ctx);
		await this.handleTimerComplete(ev, ctx, settings);
	}

	private formatTime(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}`; // No suffix
		}
		const m = Math.floor(seconds / 60); // Use floor for minutes
		return `${m}`; // No suffix
	}

	private getContext(actionId: string): TimerContext {
		let context = this.contexts.get(actionId);
		if (!context) {
			context = {
				state: TimerState.IDLE_WORK,
				currentCycle: 0,
				targetEndTime: 0,
				remainingSeconds: 25 * 60, // Default initial
				timer: null,
				pauseAnimationTimer: null,
				holdTimeout: null,
				didHoldAction: false,
				lastState: {}
			};
			this.contexts.set(actionId, context);
		}
		return context;
	}

	private getTotalSecondsForCurrentState(ctx: TimerContext, settings: ParsedTimerSettings): number {
		if ([TimerState.RUNNING_WORK, TimerState.IDLE_WORK, TimerState.PAUSED_WORK].includes(ctx.state)) {
			return settings.workTime * 60;
		} else {
			return settings.breakTime * 60;
		}
	}

	private async handleShortPress(ev: ActionEvent, ctx: TimerContext, settings: ParsedTimerSettings) {
		switch (ctx.state) {
			case TimerState.IDLE_WORK:
				ctx.state = TimerState.RUNNING_WORK;
				ctx.remainingSeconds = settings.workTime * 60;
				this.startTimer(ev, ctx, ctx.remainingSeconds, settings);
				break;
			case TimerState.RUNNING_WORK:
				ctx.state = TimerState.PAUSED_WORK;
				this.stopTimer(ctx); // Pause
				this.startPauseAnimation(ev, ctx, settings);
				break;
			case TimerState.PAUSED_WORK:
				ctx.state = TimerState.RUNNING_WORK;
				this.stopPauseAnimation(ctx);
				this.startTimer(ev, ctx, ctx.remainingSeconds, settings); // Resume
				break;
			case TimerState.IDLE_BREAK:
				ctx.state = TimerState.RUNNING_BREAK;
				ctx.remainingSeconds = settings.breakTime * 60;
				this.startTimer(ev, ctx, ctx.remainingSeconds, settings);
				break;
			case TimerState.RUNNING_BREAK:
				ctx.state = TimerState.PAUSED_BREAK;
				this.stopTimer(ctx); // Pause
				this.startPauseAnimation(ev, ctx, settings);
				break;
			case TimerState.PAUSED_BREAK:
				ctx.state = TimerState.RUNNING_BREAK;
				this.stopPauseAnimation(ctx);
				this.startTimer(ev, ctx, ctx.remainingSeconds, settings); // Resume
				break;
		}
		await this.updateView(ev, ctx, settings);
	}

	private async handleTimerComplete(ev: ActionEvent, ctx: TimerContext, settings: ParsedTimerSettings) {
		if (settings.soundEnabled) {
			if (process.platform === "darwin") {
				exec("afplay /System/Library/Sounds/Glass.aiff"); // Built-in macOS sound
			}
		}

		if (ctx.state === TimerState.RUNNING_WORK || ctx.state === TimerState.PAUSED_WORK) {
			ctx.state = TimerState.IDLE_BREAK;
			ctx.remainingSeconds = settings.breakTime * 60;
		} else if (ctx.state === TimerState.RUNNING_BREAK || ctx.state === TimerState.PAUSED_BREAK) {
			ctx.state = TimerState.IDLE_WORK;
			ctx.currentCycle = (ctx.currentCycle + 1) % settings.numCycles; // Increment cycle after break
			ctx.remainingSeconds = settings.workTime * 60;
		}
		await this.updateView(ev, ctx, settings);
	}

	private parseSettings(settings: unknown): ParsedTimerSettings {
		return TimerSettingsSchema.parse(settings || {});
	}

	private async reset(ev: ActionEvent, ctx: TimerContext, settings: ParsedTimerSettings) {
		this.stopTimer(ctx);
		this.stopPauseAnimation(ctx);
		ctx.state = TimerState.IDLE_WORK;
		ctx.currentCycle = 0;
		ctx.remainingSeconds = settings.workTime * 60;
		await this.updateView(ev, ctx, settings);
	}

	private startPauseAnimation(ev: ActionEvent, ctx: TimerContext, settings: ParsedTimerSettings) {
		if (ctx.pauseAnimationTimer) clearInterval(ctx.pauseAnimationTimer);
		ctx.pauseAnimationTimer = setInterval(async () => {
			await this.updateView(ev, ctx, settings);
		}, 50);
	}

	private startTimer(ev: ActionEvent, ctx: TimerContext, durationSeconds: number, settings: ParsedTimerSettings) {
		if (ctx.timer) clearInterval(ctx.timer);
		this.stopPauseAnimation(ctx);

		ctx.targetEndTime = Date.now() + durationSeconds * 1000;

		// Update frequency: 20fps = 50ms. 
		ctx.timer = setInterval(async () => {
			const now = Date.now();
			const diffMs = ctx.targetEndTime - now;
			const diffSec = Math.floor(diffMs / 1000); // Use floor instead of ceil

			if (diffMs <= 0) {
				this.stopTimer(ctx);
				ctx.remainingSeconds = 0;
				await this.handleTimerComplete(ev, ctx, settings);
			} else {
				ctx.remainingSeconds = diffSec;
				// Pass exact float for smooth animation
				await this.updateView(ev, ctx, settings, diffMs / 1000);
			}
		}, 50);
	}

	private stopPauseAnimation(ctx: TimerContext) {
		if (ctx.pauseAnimationTimer) {
			clearInterval(ctx.pauseAnimationTimer);
			ctx.pauseAnimationTimer = null;
		}
	}

	private stopTimer(ctx: TimerContext) {
		if (ctx.timer) {
			clearInterval(ctx.timer);
			ctx.timer = null;
		}
	}

	private updateStateFromSettings(settings: ParsedTimerSettings, ctx: TimerContext) {
		// If we are IDLE, ensure remaining matches settings
		if (ctx.state === TimerState.IDLE_WORK) {
			ctx.remainingSeconds = settings.workTime * 60;
		} else if (ctx.state === TimerState.IDLE_BREAK) {
			ctx.remainingSeconds = settings.breakTime * 60;
		}
	}

	private async updateView(ev: ActionEvent, ctx: TimerContext, settings: ParsedTimerSettings, exactSeconds?: number) {
		const now = Date.now();
		// Use exactSeconds for progress bar if available, otherwise use remainingSeconds
		const secs = exactSeconds !== undefined ? exactSeconds : ctx.remainingSeconds;

		const title = this.formatTime(ctx.remainingSeconds); // Title always uses integer seconds
		await ev.action.setTitle("");

		const totalSeconds = this.getTotalSecondsForCurrentState(ctx, settings);
		const progress = Math.max(0, Math.min(1, secs / totalSeconds));

		// Content opacity for transition at 60s (fade out "1" as it hits 60)
		let contentOpacity = 1;
		const isRunning = [
			TimerState.RUNNING_WORK,
			TimerState.RUNNING_BREAK
		].includes(ctx.state);

		if (isRunning && secs >= 60 && secs < 61) {
			contentOpacity = secs - 60; // Fade out "1"
		}

		// Global opacity for final fade-out
		let globalOpacity = 1;
		if (isRunning && secs < 2) {
			globalOpacity = Math.max(0, secs);
		}

		// Calculate pulse opacities
		const isPaused = (ctx.state === TimerState.PAUSED_WORK || ctx.state === TimerState.PAUSED_BREAK);

		// Main ring pulse (when paused)
		let pulseOpacity = 1;
		if (isPaused) {
			// Quantize pulse to reduce update frequency 
			// 0.5 to 1.0. Step 0.05
			const rawPulse = 0.75 + 0.25 * Math.sin(now / 600);
			pulseOpacity = Math.round(rawPulse * 20) / 20;
		}

		// Indicator dot pulse (when running)
		// Current cycle indicator
		let indicatorOpacity = 1;
		if (ctx.currentCycle >= 0) { // Should always be true
			const isIndicatorPulsing = (isRunning && !isPaused);
			if (isIndicatorPulsing) {
				const rawOpacity = 0.6 + 0.4 * Math.sin(now / 600);
				indicatorOpacity = Math.round(rawOpacity * 20) / 20;
			}
		}

		// Check if we need to update
		// We track significant inputs for visual representation
		// Round progress to roughly pixels
		// Circumference is ~195. 0.5px precision -> ~400 steps
		const progressStep = Math.round(progress * 400);

		const newState: TimerLastState = {
			progressStep,
			title,
			contentOpacity: Math.round(contentOpacity * 20) / 20,
			globalOpacity: Math.round(globalOpacity * 20) / 20,
			pulseOpacity,
			indicatorOpacity,
			state: ctx.state, // State changes (colors) always trigger update
			currentCycle: ctx.currentCycle
		};

		// Compare with last state
		const isChanged = JSON.stringify(newState) !== JSON.stringify(ctx.lastState);

		if (!isChanged) {
			return; // Skip update
		}

		ctx.lastState = newState;

		const svg = generateSvg({
			progress,
			state: ctx.state,
			text: title,
			isSeconds: ctx.remainingSeconds < 60,
			contentOpacity,
			globalOpacity,
			numCycles: settings.numCycles,
			pulseOpacity,
			indicatorOpacity,
			currentCycle: ctx.currentCycle
		});
		
		const icon = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
		await ev.action.setImage(icon);
	}
}
