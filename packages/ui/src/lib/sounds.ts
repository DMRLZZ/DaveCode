/**
 * Notification sounds, synthesized with Web Audio so no sound files ship with the app. The
 * system notification itself stays silent; the chosen sound plays here instead.
 */

export const SOUND_IDS = ['chime', 'pop', 'knock', 'beep', 'none'] as const;
export type SoundId = (typeof SOUND_IDS)[number];
export const DEFAULT_SOUND: SoundId = 'chime';

export const SOUND_LABEL: Record<SoundId, string> = {
  chime: 'Chime',
  pop: 'Pop',
  knock: 'Knock',
  beep: 'Beep',
  none: 'No sound',
};

interface Note {
  /** Seconds after the start. */
  at: number;
  /** Hertz at the start, and at the end when it slides. */
  from: number;
  to?: number;
  length: number;
  type: OscillatorType;
  gain: number;
}

const NOTES: Record<Exclude<SoundId, 'none'>, Note[]> = {
  chime: [
    { at: 0, from: 880, length: 0.32, type: 'sine', gain: 0.22 },
    { at: 0.12, from: 1318.5, length: 0.45, type: 'sine', gain: 0.18 },
  ],
  pop: [{ at: 0, from: 620, to: 260, length: 0.09, type: 'sine', gain: 0.3 }],
  knock: [
    { at: 0, from: 180, to: 90, length: 0.08, type: 'triangle', gain: 0.45 },
    { at: 0.14, from: 180, to: 90, length: 0.08, type: 'triangle', gain: 0.4 },
  ],
  beep: [{ at: 0, from: 1000, length: 0.12, type: 'square', gain: 0.06 }],
};

let context: AudioContext | undefined;

/** Plays a sound; does nothing for `none` or where audio is unavailable. */
export function playSound(id: SoundId): void {
  if (id === 'none') return;
  try {
    context ??= new AudioContext();
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + 0.01;
    for (const note of NOTES[id]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = note.type;
      oscillator.frequency.setValueAtTime(note.from, start + note.at);
      if (note.to) {
        oscillator.frequency.exponentialRampToValueAtTime(note.to, start + note.at + note.length);
      }
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + note.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start + note.at);
      oscillator.stop(start + note.at + note.length + 0.02);
    }
  } catch {
    /* No audio device, or audio blocked: the notification itself still shows. */
  }
}
