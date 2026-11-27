import streamDeck from "@elgato/streamdeck";

import { TimerDial } from "./actions/timer-dial";

// "info" keeps the log readable; switch to "trace" while developing to see every
// message between Stream Deck and the plugin. Logs: <plugin>.sdPlugin/logs/
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new TimerDial());
streamDeck.connect();
