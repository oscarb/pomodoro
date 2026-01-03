import streamDeck from "@elgato/streamdeck";

import { Pomodoro } from "./actions/pomodoro";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register the increment action.
streamDeck.actions.registerAction(new Pomodoro());

// Finally, connect to the Stream Deck.
streamDeck.connect();
