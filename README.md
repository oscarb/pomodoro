# Stream Deck Pomodoro Timer

A robust Pomodoro timer plugin for the Elgato Stream Deck, built with TypeScript.

## Features

- **Visual Timer**: Circular progress bar with distinct colors for Work (Focus) and Break phases.
- **Customizable Intervals**: Set your preferred duration for Work, Short Break, and Long Break (implicit via cycles).
- **Cycle Tracking**: visual indicators for completed Pomodoro cycles.
- **Sound Alerts**: Optional sound effect when a timer completes.
- **macOS Do Not Disturb Integration**: Automatically toggles DND on during work sessions and off during breaks (requires macOS Shortcuts).
- **Background Operation**: accurately tracks time even if you switch pages or the Stream Deck restarts (state is persisted).

## Installation

1. Download the latest release (coming soon).
2. Double-click the `.streamDeckPlugin` file to install it in your Stream Deck software.
3. Drag the **Pomodoro** action to a key.

## Settings

- **Work Time**: Duration of the focus session in minutes (Default: 25).
- **Break Time**: Duration of the break session in minutes (Default: 5).
- **Cycles**: Number of work intervals before a longer break (Visual indicator only for now).
- **Sound**: Enable or disable the glass ping sound on completion.

## Usage

- **Tap**: Start or Pause/Resume the timer.
- **Long Press (1.5s)**: Reset the timer (if running) or Skip to next phase (if paused).

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v20 or newer recommended)
- [Elgato Stream Deck SDK](https://docs.elgato.com/sdk/)

### Build & Run

1. Clone the repository.
    ```bash
    git clone https://github.com/oscarb/pomodoro.git
    cd pomodoro
    ```
2. Install dependencies.
    ```bash
    npm install
    ```
3. Build the plugin.
    ```bash
    npm run build
    ```
4. Watch for changes (for development).
    ```bash
    npm run watch
    ```
    This will automatically rebuild and reload the plugin in the Stream Deck software (debugging must be enabled).

## License

MIT
