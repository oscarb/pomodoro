import { action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { exec } from "child_process";

type PomodoroSettings = {
	workTime?: string; // Stored as string to handle input field easily, converted to number
	breakTime?: string;
	soundEnabled?: boolean;
};

enum PomodoroState {
	IDLE_WORK,   // Waiting to start Work
	RUNNING_WORK,// Working
	IDLE_BREAK,  // Work finished, waiting to start Break
	RUNNING_BREAK// Break
}

@action({ UUID: "se.oscarb.pomodoro.increment" })
export class Pomodoro extends SingletonAction<PomodoroSettings> {
	private state: PomodoroState = PomodoroState.IDLE_WORK;
	private remainingSeconds: number = 25 * 60;
	private timer: NodeJS.Timeout | null = null;
	private holdTimeout: NodeJS.Timeout | null = null;
	private didReset: boolean = false;
	
	// Default settings
	private readonly DEFAULT_WORK_MINS = 25;
	private readonly DEFAULT_BREAK_MINS = 5;

	override async onWillAppear(ev: WillAppearEvent<PomodoroSettings>): Promise<void> {
		this.updateStateFromSettings(ev.payload.settings);
		await this.updateView(ev);
	}

	override async onKeyDown(ev: KeyDownEvent<PomodoroSettings>): Promise<void> {
		this.didReset = false;
		// Start long-press detection
		this.holdTimeout = setTimeout(async () => {
			this.didReset = true;
			await this.reset(ev);
		}, 1500); // 1.5s hold to reset
	}

	override async onKeyUp(ev: KeyUpEvent<PomodoroSettings>): Promise<void> {
		if (this.holdTimeout) {
			clearTimeout(this.holdTimeout);
			this.holdTimeout = null;
		}

		if (this.didReset) {
			// Already reset, do nothing
			return;
		}

		await this.handleShortPress(ev);
	}

	private async reset(ev: KeyDownEvent<PomodoroSettings> | KeyUpEvent<PomodoroSettings>) {
		this.stopTimer();
		this.state = PomodoroState.IDLE_WORK;
		const workMins = parseInt(ev.payload.settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
		this.remainingSeconds = workMins * 60;
		await this.updateView(ev);
	}

	private async handleShortPress(ev: KeyUpEvent<PomodoroSettings>) {
		const workMins = parseInt(ev.payload.settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
		const breakMins = parseInt(ev.payload.settings.breakTime ?? "5") || this.DEFAULT_BREAK_MINS;

		switch (this.state) {
			case PomodoroState.IDLE_WORK:
				this.state = PomodoroState.RUNNING_WORK;
				this.remainingSeconds = workMins * 60;
				this.startTimer(ev);
				break;
			case PomodoroState.RUNNING_WORK:
				// Optional: Pause? Or do nothing?
				// User req: "When the timer has run out, a new press... starts next". 
				// "A press of the button starts the timer".
				// Usually clicking while running pauses or does nothing. Let's make it pause for usability?
				// User didn't ask for pause. Let's stick to simple: Pressing while running does nothing or restarts?
				// Let's assume it does nothing to avoid accidental cancels, since Long Press is Reset.
				break;
			case PomodoroState.IDLE_BREAK:
				this.state = PomodoroState.RUNNING_BREAK;
				this.remainingSeconds = breakMins * 60;
				this.startTimer(ev);
				break;
			case PomodoroState.RUNNING_BREAK:
				// Same as WORK, click does nothing
				break;
		}
		await this.updateView(ev);
	}

	private startTimer(ev: any) { // ev is needed for context to update view
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(async () => {
			this.remainingSeconds--;
			if (this.remainingSeconds <= 0) {
				this.stopTimer();
				await this.handleTimerComplete(ev);
			} else {
				await this.updateView(ev);
			}
		}, 1000);
	}

	private stopTimer() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async handleTimerComplete(ev: any) {
		if (ev.payload.settings.soundEnabled !== false) { // Default true
			exec("afplay /System/Library/Sounds/Glass.aiff"); // Built-in macOS sound
		}

		if (this.state === PomodoroState.RUNNING_WORK) {
			this.state = PomodoroState.IDLE_BREAK;
			const breakMins = parseInt(ev.payload.settings.breakTime ?? "5") || this.DEFAULT_BREAK_MINS;
			this.remainingSeconds = breakMins * 60;
		} else if (this.state === PomodoroState.RUNNING_BREAK) {
			this.state = PomodoroState.IDLE_WORK;
			const workMins = parseInt(ev.payload.settings.workTime ?? "25") || this.DEFAULT_WORK_MINS;
			this.remainingSeconds = workMins * 60;
		}
		await this.updateView(ev);
	}

	private async updateView(ev: any) {
		const title = this.formatTime(this.remainingSeconds);
		await ev.action.setTitle(title);

		const totalSeconds = this.getTotalSecondsForCurrentState(ev.payload.settings);
		const progress = Math.max(0, Math.min(1, this.remainingSeconds / totalSeconds));
		
		const svg = this.generateSvg(progress, this.state);
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
		
		if (this.state === PomodoroState.RUNNING_WORK || this.state === PomodoroState.IDLE_WORK) {
			return workMins * 60;
		} else {
			return breakMins * 60;
		}
	}

	private formatTime(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}s`;
		}
		const m = Math.ceil(seconds / 60);
		return `${m}m`;
	}

	private generateSvg(progress: number, state: PomodoroState): string {
		const isWork = (state === PomodoroState.RUNNING_WORK || state === PomodoroState.IDLE_WORK);
		
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

		const r = 32;
		const c = 36;
		const circ = 2 * Math.PI * r;
		const offset = circ * (1 - progress);

		// Background Circle
		const bg = `<circle cx="${c}" cy="${c}" r="${r}" stroke="#333" stroke-width="8" fill="none" />`;
		
		// Progress Circle
		// rotate -90 to start at top
		const fg = `<circle cx="${c}" cy="${c}" r="${r}" stroke="url(#grad)" stroke-width="8" fill="none" 
			stroke-dasharray="${circ}" stroke-dashoffset="${offset}" transform="rotate(-90 ${c} ${c})" stroke-linecap="round" />`;

		return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
			${defs}
			${bg}
			${fg}
		</svg>`;
	}
}
