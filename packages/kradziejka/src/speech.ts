/**
 * Phase 2 adds speech-to-text here.
 * Phase 1 does not transcribe voice. `noSpeech` returns null.
 * Replace `noSpeech` in `src/entry/common.ts` when speech is ready.
 * Do not download Telegram files in this module. A file URL contains the bot token.
 */
export interface VoiceNote {
  fileId: string;
  durationSeconds: number;
  mimeType: string | null;
}

/** Turns a voice note into text. Return null when speech is not available. */
export interface SpeechToText {
  transcribe(voice: VoiceNote): Promise<string | null>;
}

/** Phase 1 speech adapter. It does not call a service. */
export const noSpeech: SpeechToText = {
  async transcribe() {
    return null;
  },
};
