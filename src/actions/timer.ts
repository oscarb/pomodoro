import { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { exec } from "child_process";
import { z } from "zod";

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

enum TimerState {
	IDLE_WORK,   // Waiting to start Work
	RUNNING_WORK,// Working
	PAUSED_WORK, // Paused during Work
	IDLE_BREAK,  // Work finished, waiting to start Break
	RUNNING_BREAK,// Break
	PAUSED_BREAK // Paused during Break
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
	lastState: any;
}

@action({ UUID: "se.oscarb.pomodoro.timer" })
export class Timer extends SingletonAction<RawTimerSettings> {
	private contexts = new Map<string, TimerContext>();

	// Default settings constants are implicit in the schema now
	// but we can keep them for reference or fallback if needed
	// private readonly DEFAULT_WORK_MINS = 25;
	// private readonly DEFAULT_BREAK_MINS = 5;

	private getContext(ev: any): TimerContext {
		const id = ev.action.id;
		let context = this.contexts.get(id);
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
			this.contexts.set(id, context);
		}
		return context;
	}

	private parseSettings(settings: unknown): ParsedTimerSettings {
		return TimerSettingsSchema.parse(settings || {});
	}

	override async onWillAppear(ev: WillAppearEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev);
		const settings = this.parseSettings(ev.payload.settings);
		this.updateStateFromSettings(settings, ctx);
		await this.updateView(ev, ctx, settings);
	}

	override async onWillDisappear(ev: WillDisappearEvent<RawTimerSettings>): Promise<void> {
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

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev);
		const settings = this.parseSettings(ev.payload.settings);
		await this.reset(ev, ctx, settings);
	}

	override async onKeyDown(ev: KeyDownEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev);
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

	override async onKeyUp(ev: KeyUpEvent<RawTimerSettings>): Promise<void> {
		const ctx = this.getContext(ev);
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

	private async reset(ev: any, ctx: TimerContext, settings: ParsedTimerSettings) {
		this.stopTimer(ctx);
		this.stopPauseAnimation(ctx);
		ctx.state = TimerState.IDLE_WORK;
		ctx.currentCycle = 0;
		ctx.remainingSeconds = settings.workTime * 60;
		await this.updateView(ev, ctx, settings);
	}

	private async advanceNextStep(ev: any, ctx: TimerContext, settings: ParsedTimerSettings) {
		this.stopPauseAnimation(ctx);
		await this.handleTimerComplete(ev, ctx, settings);
	}

	private async handleShortPress(ev: any, ctx: TimerContext, settings: ParsedTimerSettings) {
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

	private startTimer(ev: any, ctx: TimerContext, durationSeconds: number, settings: ParsedTimerSettings) {
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

	private stopTimer(ctx: TimerContext) {
		if (ctx.timer) {
			clearInterval(ctx.timer);
			ctx.timer = null;
		}
	}

	private startPauseAnimation(ev: any, ctx: TimerContext, settings: ParsedTimerSettings) {
		if (ctx.pauseAnimationTimer) clearInterval(ctx.pauseAnimationTimer);
		ctx.pauseAnimationTimer = setInterval(async () => {
			await this.updateView(ev, ctx, settings);
		}, 50);
	}

	private stopPauseAnimation(ctx: TimerContext) {
		if (ctx.pauseAnimationTimer) {
			clearInterval(ctx.pauseAnimationTimer);
			ctx.pauseAnimationTimer = null;
		}
	}

	private async handleTimerComplete(ev: any, ctx: TimerContext, settings: ParsedTimerSettings) {
		if (settings.soundEnabled) {
			exec("afplay /System/Library/Sounds/Glass.aiff"); // Built-in macOS sound
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

	private async updateView(ev: any, ctx: TimerContext, settings: ParsedTimerSettings, exactSeconds?: number) {
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

		const newState = {
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

		const svg = this.generateSvg(
			progress,
			ctx.state,
			title,
			ctx.remainingSeconds < 60,
			contentOpacity,
			globalOpacity,
			settings.numCycles,
			pulseOpacity,
			indicatorOpacity,
			ctx
		);
		const icon = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
		await ev.action.setImage(icon);
	}

	private updateStateFromSettings(settings: ParsedTimerSettings, ctx: TimerContext) {
		// If we are IDLE, ensure remaining matches settings
		if (ctx.state === TimerState.IDLE_WORK) {
			ctx.remainingSeconds = settings.workTime * 60;
		} else if (ctx.state === TimerState.IDLE_BREAK) {
			ctx.remainingSeconds = settings.breakTime * 60;
		}
	}

	private getTotalSecondsForCurrentState(ctx: TimerContext, settings: ParsedTimerSettings): number {
		if ([TimerState.RUNNING_WORK, TimerState.IDLE_WORK, TimerState.PAUSED_WORK].includes(ctx.state)) {
			return settings.workTime * 60;
		} else {
			return settings.breakTime * 60;
		}
	}

	private formatTime(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}`; // No suffix
		}
		const m = Math.floor(seconds / 60); // Use floor for minutes
		return `${m}`; // No suffix
	}

	private generateSvg(progress: number, state: TimerState, text: string, isSeconds: boolean, contentOpacity: number, globalOpacity: number, numCycles: number, pulseOpacity: number, indicatorOpacity: number, ctx: TimerContext): string {
		const isWork = [TimerState.RUNNING_WORK, TimerState.IDLE_WORK, TimerState.PAUSED_WORK].includes(state);

		// Work: Orange/Red Gradient
		const colorStart = isWork ? "#FF512F" : "#11998e";
		const colorEnd = isWork ? "#DD2476" : "#38ef7d";
		const defs = `
			<defs>
				<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" style="stop-color:${colorStart};stop-opacity:1" />
					<stop offset="100%" style="stop-color:${colorEnd};stop-opacity:1" />
				</linearGradient>
			</defs>
		`;

		const r = 31;
		const c = 36;
		const circ = 2 * Math.PI * r;
		const offset = circ * (1 - progress);

		const fgGroup = `<g transform="translate(72, 0) scale(-1, 1)" opacity="${pulseOpacity}">
			<circle cx="${c}" cy="${c}" r="${r}" stroke="url(#grad)" stroke-width="8" fill="none" 
			stroke-dasharray="${circ}" stroke-dashoffset="${offset}" 
			transform="rotate(-90 ${c} ${c})" stroke-linecap="round" />
		</g>`;

		// Text
		// Base font size is 28 for minutes
		// If it's seconds, make it smaller (e.g. 20)
		let fontSize = 28;
		let yOffset = 9;
		if (isSeconds) {
			fontSize = 20;
			yOffset = 7;
		} else if (text.length > 2) {
			fontSize = 24;
		}

		// Manually adjust Y to center: Center(36) + approx 1/3 font size
		const timeText = `<text x="${c}" y="${c + yOffset}" font-family="sans-serif" font-weight="bold" font-size="${fontSize}" fill="white" opacity="${contentOpacity}" text-anchor="middle">${text}</text>`;

		// Indicator (Cycles / Status indicators)
		let indicators = "";
		const spacing = 8;
		const r_ind = 3;
		const totalWidth = (numCycles - 1) * spacing;
		const startX = 36 - (totalWidth / 2);
		const y = 52;

		// Work Gradient colors for "completed" fills
		const workStart = "#FF512F";
		// Break color for "completed" fills
		const breakStart = "#11998e";

		for (let i = 0; i < numCycles; i++) {
			const cx = startX + i * spacing;
			if (i < ctx.currentCycle) {
				// Completed cycle: Solid green/cyan (Break color)
				indicators += `<circle cx="${cx}" cy="${y}" r="${r_ind}" fill="${breakStart}" />`;
			} else if (i === ctx.currentCycle) {
				// Current cycle
				// Use passed indicatorOpacity
				indicators += `<circle cx="${cx}" cy="${y}" r="${r_ind}" fill="url(#grad)" opacity="${indicatorOpacity}" />`;
			} else {
				// Inactive cycle: Gray/White with low opacity
				indicators += `<circle cx="${cx}" cy="${y}" r="${r_ind}" fill="white" opacity="0.2" />`;
			}
		}

		return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
			${defs}
			<g opacity="${globalOpacity}">
				${fgGroup}
				${timeText}
				${indicators}
			</g>
		</svg>`;
	}
}
