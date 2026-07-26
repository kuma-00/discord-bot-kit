import { entersState, joinVoiceChannel } from "@discordjs/voice";
import type { VoiceConnectionAdapter } from "./types.ts";

/** Production adapter backed by `@discordjs/voice` join and state utilities. */
export const defaultVoiceConnectionAdapter: VoiceConnectionAdapter = {
    join: joinVoiceChannel,
    enterState: (connection, status, timeoutOrSignal) =>
        entersState(connection, status, timeoutOrSignal),
};
