import type { NotificationCategory } from "backend/src/notifications/contract";

/**
 * Short synthesized cues per notification category, played with Web Audio so the app ships no
 * audio files. Browsers keep an `AudioContext` suspended until the page gets a user gesture;
 * `primeNotificationAudio` resumes it on the first one, after which the tab can play even while
 * hidden.
 */

type Tone = { frequency: number; start: number; length: number };

// Seconds. Rising for done, a repeated tap for "come back", falling for failure, one soft note
// for limits.
const cues: Record<NotificationCategory, { wave: OscillatorType; tones: Tone[] }> = {
  finished: {
    wave: "sine",
    tones: [
      { frequency: 784, start: 0, length: 0.14 },
      { frequency: 1047, start: 0.11, length: 0.22 },
    ],
  },
  attention: {
    wave: "triangle",
    tones: [
      { frequency: 880, start: 0, length: 0.1 },
      { frequency: 880, start: 0.16, length: 0.1 },
      { frequency: 1175, start: 0.32, length: 0.18 },
    ],
  },
  failed: {
    wave: "triangle",
    tones: [
      { frequency: 659, start: 0, length: 0.16 },
      { frequency: 494, start: 0.14, length: 0.26 },
    ],
  },
  limits: {
    wave: "sine",
    tones: [{ frequency: 698, start: 0, length: 0.24 }],
  },
};

const PEAK_GAIN = 0.12;
const ATTACK_SECONDS = 0.01;

let context: AudioContext | undefined;

/**
 * Create or resume the audio context on the first user gesture, so later notifications can
 * sound. Returns the listener cleanup.
 */
export function primeNotificationAudio() {
  const removeListeners = () => {
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("keydown", resume);
  };
  const resume = () => {
    if (!("AudioContext" in window)) return;
    context ??= new AudioContext();
    void context.resume();
    removeListeners();
  };
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);
  return removeListeners;
}

/**
 * Play the cue for `category`. Does nothing until a gesture created the audio context; a context
 * the browser suspended again is resumed, and the scheduled tones play once it runs.
 */
export function playNotificationSound(category: NotificationCategory) {
  const audio = context;
  if (!audio || audio.state === "closed") return;
  if (audio.state === "suspended") void audio.resume();

  const cue = cues[category];
  const startAt = audio.currentTime + 0.01;
  for (const tone of cue.tones) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = cue.wave;
    oscillator.frequency.value = tone.frequency;

    const begin = startAt + tone.start;
    const end = begin + tone.length;
    gain.gain.setValueAtTime(0, begin);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, begin + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(begin);
    oscillator.stop(end);
  }
}
