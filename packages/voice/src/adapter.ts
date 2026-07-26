import { entersState, joinVoiceChannel } from "@discordjs/voice";
import type { VoiceConnectionAdapter } from "./types.ts";

export const defaultVoiceConnectionAdapter: VoiceConnectionAdapter = {
    join: joinVoiceChannel,
    enterState: (connection, status, timeoutOrSignal) =>
        entersState(connection, status, timeoutOrSignal),
};
