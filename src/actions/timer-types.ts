export enum TimerState {
	IDLE_WORK,   // Waiting to start Work
	RUNNING_WORK,// Working
	PAUSED_WORK, // Paused during Work
	IDLE_BREAK,  // Work finished, waiting to start Break
	RUNNING_BREAK,// Break
	PAUSED_BREAK // Paused during Break
}
