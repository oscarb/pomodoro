import { TimerState } from "./timer-types";

interface TimerViewOptions {
	progress: number;
	state: TimerState;
	text: string;
	isSeconds: boolean;
	contentOpacity: number;
	globalOpacity: number;
	numCycles: number;
	pulseOpacity: number;
	indicatorOpacity: number;
	currentCycle: number;
}

export function generateSvg(options: TimerViewOptions): string {
	const {
		progress,
		state,
		text,
		isSeconds,
		contentOpacity,
		globalOpacity,
		numCycles,
		pulseOpacity,
		indicatorOpacity,
		currentCycle
	} = options;

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

	// Break color for "completed" fills (using the Break Start color from original code)
	const breakStart = "#11998e";

	for (let i = 0; i < numCycles; i++) {
		const cx = startX + i * spacing;
		if (i < currentCycle) {
			// Completed cycle: Solid green/cyan (Break color)
			indicators += `<circle cx="${cx}" cy="${y}" r="${r_ind}" fill="${breakStart}" />`;
		} else if (i === currentCycle) {
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
