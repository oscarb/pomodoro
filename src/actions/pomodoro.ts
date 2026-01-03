import { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { exec } from "child_process";

type PomodoroSettings = {
	workTime?: string; // Stored as string to handle input field easily, converted to number
	breakTime?: string;
	numCycles?: string;
	soundEnabled?: boolean;
};

enum PomodoroState {
	IDLE_WORK,   // Waiting to start Work
	RUNNING_WORK,// Working
	PAUSED_WORK, // Paused during Work
	IDLE_BREAK,  // Work finished, waiting to start Break
	RUNNING_BREAK,// Break
	PAUSED_BREAK // Paused during Break
}

@action({ UUID: "se.oscarb.pomodoro.increment" })
export class Pomodoro extends SingletonAction<PomodoroSettings> {
	private state: PomodoroState = PomodoroState.IDLE_WORK;
	private currentCycle: number = 0; // 0-3
	private targetEndTime: number = 0; // Timestamp in ms
	private remainingSeconds: number = 25 * 60; // For display and state tracking
	private timer: NodeJS.Timeout | null = null;
	private pauseAnimationTimer: NodeJS.Timeout | null = null;
	private holdTimeout: NodeJS.Timeout | null = null;
	private didHoldAction: boolean = false;

	// Default settings
	private readonly DEFAULT_WORK_MINS = 25;
	private readonly DEFAULT_BREAK_MINS = 5;

	override async onWillAppear(ev: WillAppearEvent<PomodoroSettings>): Promise<void> {
		this.updateStateFromSettings(ev.payload.settings);
		await this.updateView(ev);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PomodoroSettings>): Promise<void> {
		await this.reset(ev);
	}

	override async onKeyDown(ev: KeyDownEvent<PomodoroSettings>): Promise<void> {
		this.didHoldAction = false;
		// Start long-press detection
		this.holdTimeout = setTimeout(async () => {
			this.didHoldAction = true;
			if (this.state === PomodoroState.PAUSED_WORK || this.state === PomodoroState.PAUSED_BREAK) {
				await this.advanceNextStep(ev);
			} else {
				await this.reset(ev);
			}
		}, 1500); // 1.5s hold to perform action
	}

	override async onKeyUp(ev: KeyUpEvent<PomodoroSettings>): Promise<void> {
		if (this.holdTimeout) {
			clearTimeout(this.holdTimeout);
			this.holdTimeout = null;
		}

		if (this.didHoldAction) {
			// Already performed hold action, do nothing
			return;
		}

		await this.handleShortPress(ev);
	}

	private async reset(ev: any) {
		this.stopTimer();
		this.stopPauseAnimation();
		this.state = PomodoroState.IDLE_WORK;
		this.currentCycle = 0;
		const workMins = parseInt(ev.payload.settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
		this.remainingSeconds = workMins * 60;
		await this.updateView(ev);
	}

	private async advanceNextStep(ev: any) {
		this.stopPauseAnimation();
		await this.handleTimerComplete(ev);
	}

	private async handleShortPress(ev: KeyUpEvent<PomodoroSettings>) {
		const workMins = parseInt(ev.payload.settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
		const breakMins = parseInt(ev.payload.settings.breakTime ?? "5") || this.DEFAULT_BREAK_MINS;

		switch (this.state) {
			case PomodoroState.IDLE_WORK:
				this.state = PomodoroState.RUNNING_WORK;
				this.remainingSeconds = workMins * 60;
				this.startTimer(ev, this.remainingSeconds);
				break;
			case PomodoroState.RUNNING_WORK:
				this.state = PomodoroState.PAUSED_WORK;
				this.stopTimer(); // Pause
				this.startPauseAnimation(ev);
				break;
			case PomodoroState.PAUSED_WORK:
				this.state = PomodoroState.RUNNING_WORK;
				this.stopPauseAnimation();
				this.startTimer(ev, this.remainingSeconds); // Resume
				break;
			case PomodoroState.IDLE_BREAK:
				this.state = PomodoroState.RUNNING_BREAK;
				this.remainingSeconds = breakMins * 60;
				this.startTimer(ev, this.remainingSeconds);
				break;
			case PomodoroState.RUNNING_BREAK:
				this.state = PomodoroState.PAUSED_BREAK;
				this.stopTimer(); // Pause
				this.startPauseAnimation(ev);
				break;
			case PomodoroState.PAUSED_BREAK:
				this.state = PomodoroState.RUNNING_BREAK;
				this.stopPauseAnimation();
				this.startTimer(ev, this.remainingSeconds); // Resume
				break;
		}
		await this.updateView(ev);
	}

	private startTimer(ev: any, durationSeconds: number) {
		if (this.timer) clearInterval(this.timer);
		this.stopPauseAnimation();

		this.targetEndTime = Date.now() + durationSeconds * 1000;

		// Update frequency: 20fps = 50ms. 
		this.timer = setInterval(async () => {
			const now = Date.now();
			const diffMs = this.targetEndTime - now;
			const diffSec = Math.floor(diffMs / 1000); // Use floor instead of ceil

			if (diffMs <= 0) {
				this.stopTimer();
				this.remainingSeconds = 0;
				await this.handleTimerComplete(ev);
			} else {
				this.remainingSeconds = diffSec;
				// Pass exact float for smooth animation
				await this.updateView(ev, diffMs / 1000);
			}
		}, 50);
	}

	private stopTimer() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private startPauseAnimation(ev: any) {
		if (this.pauseAnimationTimer) clearInterval(this.pauseAnimationTimer);
		this.pauseAnimationTimer = setInterval(async () => {
			await this.updateView(ev);
		}, 50);
	}

	private stopPauseAnimation() {
		if (this.pauseAnimationTimer) {
			clearInterval(this.pauseAnimationTimer);
			this.pauseAnimationTimer = null;
		}
	}

	private async handleTimerComplete(ev: any) {
		if (ev.payload.settings.soundEnabled !== false) { // Default true
			exec("afplay /System/Library/Sounds/Glass.aiff"); // Built-in macOS sound
		}

		if (this.state === PomodoroState.RUNNING_WORK || this.state === PomodoroState.PAUSED_WORK) {
			this.state = PomodoroState.IDLE_BREAK;
			const breakMins = parseInt(ev.payload.settings.breakTime ?? "5") || this.DEFAULT_BREAK_MINS;
			this.remainingSeconds = breakMins * 60;
		} else if (this.state === PomodoroState.RUNNING_BREAK || this.state === PomodoroState.PAUSED_BREAK) {
			this.state = PomodoroState.IDLE_WORK;
			const numCycles = parseInt(ev.payload.settings.numCycles ?? "4") || 4;
			this.currentCycle = (this.currentCycle + 1) % numCycles; // Increment cycle after break
			const workMins = parseInt(ev.payload.settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
			this.remainingSeconds = workMins * 60;
		}
		await this.updateView(ev);
	}

	private async updateView(ev: any, exactSeconds?: number) {
		// Use exactSeconds for progress bar if available, otherwise use remainingSeconds
		const secs = exactSeconds !== undefined ? exactSeconds : this.remainingSeconds;

		const title = this.formatTime(this.remainingSeconds); // Title always uses integer seconds
		await ev.action.setTitle("");

		const totalSeconds = this.getTotalSecondsForCurrentState(ev.payload.settings);
		const progress = Math.max(0, Math.min(1, secs / totalSeconds));

		// Content opacity for transition at 60s (fade out "1" as it hits 60)
		let contentOpacity = 1;
		const isRunning = [
			PomodoroState.RUNNING_WORK,
			PomodoroState.RUNNING_BREAK
		].includes(this.state);

		if (isRunning && secs >= 60 && secs < 61) {
			contentOpacity = secs - 60; // Fade out "1"
		}

		// Global opacity for final fade-out
		let globalOpacity = 1;
		if (isRunning && secs < 2) {
			globalOpacity = Math.max(0, secs);
		}

		const numCycles = Math.min(4, Math.max(1, parseInt(ev.payload.settings.numCycles ?? "4") || 4));
		const svg = this.generateSvg(progress, this.state, title, this.remainingSeconds < 60, contentOpacity, globalOpacity, numCycles);
		const icon = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
		await ev.action.setImage(icon);
	}

	private updateStateFromSettings(settings: PomodoroSettings) {
		// If we are IDLE, ensure remaining matches settings
		const workMins = parseInt(settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
		const breakMins = parseInt(settings.breakTime ?? "5") || this.DEFAULT_BREAK_MINS;

		if (this.state === PomodoroState.IDLE_WORK) {
			this.remainingSeconds = workMins * 60;
		} else if (this.state === PomodoroState.IDLE_BREAK) {
			this.remainingSeconds = breakMins * 60;
		}
	}

	private getTotalSecondsForCurrentState(settings: PomodoroSettings): number {
		const workMins = parseInt(settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
		const breakMins = parseInt(settings.breakTime ?? "5") || this.DEFAULT_BREAK_MINS;

		if ([PomodoroState.RUNNING_WORK, PomodoroState.IDLE_WORK, PomodoroState.PAUSED_WORK].includes(this.state)) {
			return workMins * 60;
		} else {
			return breakMins * 60;
		}
	}

	private formatTime(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}`; // No suffix
		}
		const m = Math.floor(seconds / 60); // Use floor for minutes
		return `${m}`; // No suffix
	}

	private generateSvg(progress: number, state: PomodoroState, text: string, isSeconds: boolean = false, contentOpacity: number = 1, globalOpacity: number = 1, numCycles: number = 4): string {
		const isWork = [PomodoroState.RUNNING_WORK, PomodoroState.IDLE_WORK, PomodoroState.PAUSED_WORK].includes(state);
		const isRunning = (state === PomodoroState.RUNNING_WORK || state === PomodoroState.RUNNING_BREAK);
		const isPaused = (state === PomodoroState.PAUSED_WORK || state === PomodoroState.PAUSED_BREAK);

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

		// Pulsation for pause state
		let pulseOpacity = 1;
		if (isPaused) {
			const now = Date.now();
			// Range 0.5 to 1.0 (Center 0.75, Amp 0.25)
			// Slower pulse: /600
			pulseOpacity = 0.75 + 0.25 * Math.sin(now / 600);
		}

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
			if (i < this.currentCycle) {
				// Completed cycle: Solid green/cyan (Break color)
				indicators += `<circle cx="${cx}" cy="${y}" r="${r_ind}" fill="${breakStart}" />`;
			} else if (i === this.currentCycle) {
				// Current cycle
				// Pulsate only if running, otherwise solid
				const now = Date.now();
				const opacity = (isRunning && !isPaused) ? (0.6 + 0.4 * Math.sin(now / 600)) : 1;
				indicators += `<circle cx="${cx}" cy="${y}" r="${r_ind}" fill="url(#grad)" opacity="${opacity}" />`;
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
