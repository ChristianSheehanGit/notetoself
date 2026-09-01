import { instrument, type Player } from 'soundfont-player';

const INSTRUMENT = 'acoustic_grand_piano';

/**
 * The sample-player loads and decodes per-note AudioBuffers into `buffers`,
 * keyed by MIDI note number (after note-name → midi mapping). We drive these
 * buffers directly with raw Web Audio nodes so that note-off reliably cuts
 * the sound short — independent of sample-player's envelope behavior.
 */
interface PianoInstrument extends Player {
  buffers: Record<string, AudioBuffer>;
}

let audioContext: AudioContext | null = null;
let piano: PianoInstrument | null = null;
let loadingPromise: Promise<PianoInstrument> | null = null;

const getAudioContext = (): AudioContext => {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
};

/**
 * Lazily load the acoustic grand piano soundfont (MusyngKite rendering of
 * Benjamin Gleitzman's MIDI.js soundfonts, served from gleitz.github.io).
 * The instrument is loaded once and cached for the lifetime of the page.
 */
const getPiano = (): Promise<PianoInstrument> => {
  if (piano) return Promise.resolve(piano);
  if (loadingPromise) return loadingPromise;

  const ctx = getAudioContext();
  loadingPromise = instrument(ctx, INSTRUMENT).then((inst) => {
    piano = inst as PianoInstrument;
    return piano;
  });

  return loadingPromise;
};

/**
 * A cell in the grid represents a 16th note.
 * One beat (quarter note) = 4 cells = 60 / bpm seconds.
 */
const cellDuration = (bpm: number): number => 60 / bpm / 4;

export interface ScheduledNote {
  pitch: number;
  start: number; // column (16th note)
  length: number; // in columns
}

interface PlaybackHandle {
  stop: () => void;
}

const RELEASE_SECONDS = 0.15;
const NOTE_GAIN = 0.8;

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** Voices currently sounding for interactive preview, keyed by pitch. */
const activeVoices = new Map<number, ActiveVoice[]>();

/**
 * Pitches the user is currently holding down. Used to suppress async
 * note-ons that resolve after the matching note-off (first-load edge case).
 */
const heldPitches = new Set<number>();

/** Voices scheduled by playNotes so the Stop button can cut them all. */
let playbackVoices: ActiveVoice[] = [];

const connectVoice = (
  buffer: AudioBuffer,
  when: number
): ActiveVoice | null => {
  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  // Tiny attack ramp to avoid an audible click at note-on
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(NOTE_GAIN, when + 0.01);

  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(when);

  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };

  return { source, gain };
};

const releaseVoice = (voice: ActiveVoice, now: number): void => {
  const { source, gain } = voice;
  // Force a clear fade-out from the full sustain level down to silence.
  // A linear ramp is deterministic regardless of prior automation, and we
  // know the note holds at NOTE_GAIN once past the 10ms attack ramp.
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(NOTE_GAIN, now);
  gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
  source.stop(now + RELEASE_SECONDS + 0.02);
};

/**
 * Start a piano note from the soundfont's decoded buffer. The sound rings
 * out (sustains) until matching noteOff is called. Used when pressing down
 * on the grid or the piano keys. The AudioContext is created and resumed
 * within the user gesture call chain, satisfying autoplay policies.
 */
export const noteOn = (pitch: number): void => {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }
  heldPitches.add(pitch);
  void getPiano().then((inst) => {
    if (!heldPitches.has(pitch)) return; // released before the instrument loaded
    const buffer = inst.buffers[String(pitch)];
    if (!buffer) return;
    const voice = connectVoice(buffer, ctx.currentTime);
    if (!voice) return;
    const list = activeVoices.get(pitch) ?? [];
    list.push(voice);
    activeVoices.set(pitch, list);
  });
};

/**
 * Stop all sounding preview notes for the given pitch. Forces a clear linear
 * fade from the sustain level to silence (~150ms) so quick clicks sound
 * distinctly shorter than held notes.
 */
export const noteOff = (pitch: number): void => {
  heldPitches.delete(pitch);
  const list = activeVoices.get(pitch);
  if (!list) return;
  activeVoices.delete(pitch);

  const ctx = getAudioContext();
  const now = ctx.currentTime;
  for (const voice of list) {
    releaseVoice(voice, now);
  }
};

/**
 * Schedule all notes for playback using deterministic start/stop times on
 * raw buffer sources. Returns a handle that can be used to stop.
 * A small lookahead (0.1s) is used so all notes start cleanly together.
 */
export const playNotes = (
  notes: ScheduledNote[],
  bpm: number,
  startColumn: number,
  onPlayhead: (column: number) => void,
  onEnded: () => void
): PlaybackHandle => {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }

  const startTime = ctx.currentTime + 0.1;
  let stopped = false;

  // Only play notes that overlap the playback window starting at startColumn
  const playableNotes = notes.filter((n) => n.start + n.length > startColumn);

  if (playableNotes.length > 0) {
    const cell = cellDuration(bpm);
    void getPiano().then((inst) => {
      if (stopped) return; // stopped before the instrument finished loading
      for (const note of playableNotes) {
        const buffer = inst.buffers[String(note.pitch)];
        if (!buffer) continue;
        const start = startTime + (note.start - startColumn) * cell;
        const duration = note.length * cell;
        const voice = connectVoice(buffer, start);
        if (!voice) continue;
        const end = start + duration;
        // Hold at full gain for the note's sustain, then fade out to silence
        // exactly at the note's end. Clamp the fade start so it never
        // precedes the attack ramp (very short notes at high BPM).
        const fadeStart = Math.max(start + 0.01, end - RELEASE_SECONDS);
        voice.gain.gain.setValueAtTime(NOTE_GAIN, fadeStart);
        voice.gain.gain.linearRampToValueAtTime(0, end);
        voice.source.stop(end);
        playbackVoices.push(voice);
      }
    });
  }

  // Total columns from startColumn to the end of the last note
  const maxEndColumn =
    playableNotes.length > 0
      ? Math.max(...playableNotes.map((n) => n.start + n.length))
      : startColumn;
  let rafId: number | null = null;

  const tick = () => {
    if (stopped) return;
    const elapsed = ctx.currentTime - startTime;
    if (elapsed < 0) {
      onPlayhead(startColumn);
      rafId = requestAnimationFrame(tick);
      return;
    }
    const column = elapsed / cellDuration(bpm) + startColumn;
    if (column >= maxEndColumn) {
      onPlayhead(maxEndColumn);
      onEnded();
      return;
    }
    onPlayhead(column);
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      const now = ctx.currentTime;
      for (const voice of playbackVoices) {
        releaseVoice(voice, now);
      }
      playbackVoices = [];
    },
  };
};