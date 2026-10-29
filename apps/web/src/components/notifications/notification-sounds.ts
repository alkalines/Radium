import type { NotificationCategory } from "backend/src/notifications/contract";

/**
 * Notification cues synthesized with Web Audio, so the app ships no audio files. Each note is a
 * small bell-like voice (a few sine partials, a 4 ms attack, and a long exponential decay) sent
 * through a low-pass filter and a short synthetic room reverb, which keeps it soft instead of
 * beepy.
 *
 * Browsers keep an `AudioContext` suspended until the page gets a user gesture.
 * `primeNotificationAudio` creates it on the first one, after which the tab can play even while
 * hidden; `previewNotificationSound` is for buttons, which are gestures themselves.
 */

type Note = {
  /** Hz. */
  frequency: number;
  /** Seconds after the cue starts. */
  at: number;
  /** Seconds until the note has faded out. */
  decay: number;
  /** Relative loudness, 0–1. */
  level?: number;
};

type Cue = {
  notes: Note[];
  /** `[frequency ratio, level]` partials of every note; the fundamental is `[1, 1]`. */
  timbre: [number, number][];
};

// Glass: bright and short. Mallet: warmer, the upper partials fade first.
const glass: Cue["timbre"] = [
  [1, 1],
  [2, 0.32],
  [3, 0.1],
  [4.2, 0.04],
];
const mallet: Cue["timbre"] = [
  [1, 1],
  [2, 0.16],
  [3.9, 0.05],
];

const cues: Record<NotificationCategory, Cue> = {
  // Rising fifth: done.
  finished: {
    timbre: glass,
    notes: [
      { frequency: 659.25, at: 0, decay: 0.7, level: 0.8 },
      { frequency: 987.77, at: 0.11, decay: 1.1 },
    ],
  },
  // Two quick taps and a lift: come back.
  attention: {
    timbre: glass,
    notes: [
      { frequency: 880, at: 0, decay: 0.35, level: 0.7 },
      { frequency: 880, at: 0.13, decay: 0.35, level: 0.7 },
      { frequency: 1318.51, at: 0.26, decay: 1 },
    ],
  },
  // Falling minor third, lower and warmer: something went wrong.
  failed: {
    timbre: mallet,
    notes: [
      { frequency: 587.33, at: 0, decay: 0.6 },
      { frequency: 493.88, at: 0.16, decay: 1.1 },
    ],
  },
  // One soft low note: informational.
  limits: {
    timbre: mallet,
    notes: [{ frequency: 523.25, at: 0, decay: 1.2, level: 0.8 }],
  },
};

const NOTE_PEAK = 0.16;
const ATTACK_SECONDS = 0.004;
const SILENCE = 0.0001;
const LOWPASS_HZ = 4200;
const REVERB_SECONDS = 1.4;
const REVERB_LEVEL = 0.2;

let context: AudioContext | undefined;
const outputs = new WeakMap<BaseAudioContext, AudioNode>();

/** Low-pass → dry + reverb bus into the destination, built once per context. */
function output(audio: BaseAudioContext): AudioNode {
  const existing = outputs.get(audio);
  if (existing) return existing;

  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = LOWPASS_HZ;
  filter.Q.value = 0.5;

  // A decaying stereo noise impulse is enough of a "room" for a few short notes.
  const length = Math.floor(audio.sampleRate * REVERB_SECONDS);
  const impulse = audio.createBuffer(2, length, audio.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const samples = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 3);
    }
  }
  const reverb = audio.createConvolver();
  reverb.buffer = impulse;
  const wet = audio.createGain();
  wet.gain.value = REVERB_LEVEL;

  filter.connect(audio.destination);
  filter.connect(reverb).connect(wet).connect(audio.destination);
  outputs.set(audio, filter);
  return filter;
}

/**
 * Schedule `category`'s cue on `audio`, starting `delay` seconds from now. Takes any
 * `BaseAudioContext` so the cue can also be rendered offline.
 */
export function scheduleNotificationCue(
  audio: BaseAudioContext,
  category: NotificationCategory,
  delay = 0.02,
) {
  const cue = cues[category];
  const bus = output(audio);
  const start = audio.currentTime + delay;

  for (const note of cue.notes) {
    const begin = start + note.at;
    for (const [ratio, partialLevel] of cue.timbre) {
      const oscillator = audio.createOscillator();
      oscillator.frequency.value = note.frequency * ratio;

      // Higher partials die away faster, like a struck bar.
      const end = begin + note.decay / Math.sqrt(ratio);
      const peak = NOTE_PEAK * (note.level ?? 1) * partialLevel;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(SILENCE, begin);
      gain.gain.exponentialRampToValueAtTime(peak, begin + ATTACK_SECONDS);
      gain.gain.exponentialRampToValueAtTime(SILENCE, end);

      oscillator.connect(gain).connect(bus);
      oscillator.start(begin);
      oscillator.stop(end + 0.05);
    }
  }
}

function createContext() {
  if (!("AudioContext" in window)) return undefined;
  context ??= new AudioContext();
  return context;
}

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
    void createContext()?.resume();
    removeListeners();
  };
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);
  return removeListeners;
}

/**
 * Play the cue for `category`. Does nothing until a gesture created the audio context; a context
 * the browser suspended again is resumed, and the scheduled notes play once it runs.
 */
export function playNotificationSound(category: NotificationCategory) {
  const audio = context;
  if (!audio || audio.state === "closed") return;
  if (audio.state === "suspended") void audio.resume();
  scheduleNotificationCue(audio, category);
}

/** Play a cue from a click handler (a gesture), creating the audio context if needed. */
export function previewNotificationSound(category: NotificationCategory) {
  const audio = createContext();
  if (!audio) return;
  void audio.resume();
  scheduleNotificationCue(audio, category);
}
