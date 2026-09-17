import { Midi } from '@tonejs/midi';

/**
 * MIDI import/export bridge.
 *
 * Converts between this app's internal note model and standard MIDI files
 * using the `@tonejs/midi` library (which wraps `midi-file` for robust SMF
 * parsing/writing). Time is carried in 16th-note columns internally and as
 * ticks (at the file's pulses-per-quarter-note) in MIDI.
 */

/** A note in the shared midi bridge format (timing in 16th-note columns). */
export interface MidiNoteData {
  pitch: number; // MIDI note number (21 = A0, our lowest key)
  start: number; // 16th-note column
  length: number; // 16th-note columns
  track: number; // 0..NUM_TRACKS-1
  instrument: string; // our soundfont instrument name
}

/** The number of tracks/rows this app exposes. */
export const NUM_TRACKS = 3;

/** The fallback instrument used when a MIDI program has no direct mapping. */
export const DEFAULT_INSTRUMENT = 'acoustic_grand_piano';

const INSTRUMENT_TO_PROGRAM: Record<string, number> = {
  acoustic_grand_piano: 0, // Acoustic Grand Piano
  string_ensemble_1: 48, // String Ensemble 1
  brass_section: 61, // Brass Section
};

const PROGRAM_TO_INSTRUMENT: Record<number, string> = {
  0: 'acoustic_grand_piano',
  48: 'string_ensemble_1',
  61: 'brass_section',
};

/**
 * Serialize the current notes to a Standard MIDI File.
 * @param notes Notes to export (timing in 16th-note columns).
 * @param bpm Tempo at which to write the file.
 * @param name Name stamped into the file's header track.
 */
export function notesToMidi(notes: MidiNoteData[], bpm: number, name = 'notetoself'): ArrayBuffer {
  const midi = new Midi();
  midi.name = name;
  midi.header.setTempo(bpm ?? 120);

  const sixteenthTicks = midi.header.ppq / 4; // ticks per 16th note

  // Group notes by their track id so each track becomes one MIDI track.
  const byTrack = new Map<number, MidiNoteData[]>();
  for (const note of notes) {
    const list = byTrack.get(note.track) ?? [];
    list.push(note);
    byTrack.set(note.track, list);
  }
  const trackIds = [...byTrack.keys()].sort((a, b) => a - b);

  for (const trackId of trackIds) {
    const track = midi.addTrack();
    track.name = `Track ${trackId + 1}`;
    track.channel = Math.min(trackId, 15);
    const instrument = byTrack.get(trackId)![0]?.instrument ?? DEFAULT_INSTRUMENT;
    track.instrument.number = INSTRUMENT_TO_PROGRAM[instrument] ?? 0;

    for (const note of byTrack.get(trackId)!) {
      track.addNote({
        midi: note.pitch,
        ticks: Math.round(note.start * sixteenthTicks),
        durationTicks: Math.max(1, Math.round(note.length * sixteenthTicks)),
      });
    }
  }

  const out = midi.toArray();
  const copy = new Uint8Array(out.length);
  copy.set(out);
  return copy.buffer as ArrayBuffer;
}

export interface MidiImportResult {
  notes: MidiNoteData[];
  bpm: number;
}

/**
 * Parse a Standard MIDI File back into this app's note model.
 * Timing is quantized to the nearest 16th-note column, and each parsed track
 * is mapped onto one of our tracks. Unknown instruments fall back to
 * {@link DEFAULT_INSTRUMENT}.
 */
export function midiToNotes(data: ArrayBuffer): MidiImportResult {
  const midi = new Midi(data);
  const sixteenthTicks = Math.max(1, midi.header.ppq / 4);
  // MIDI stores tempo as integer microseconds/beat, so round off float error
  // (e.g. our own 138 -> 138.000193) to keep the BPM field tidy.
  const bpm = midi.header.tempos.length
    ? Math.round(midi.header.tempos[0].bpm * 100) / 100
    : 120;

  const notes: MidiNoteData[] = [];

  midi.tracks.forEach((track, index) => {
    // Skip the percussion channel (10): we have no drum kit mapping.
    if (track.channel === 9) return;

    const program = track.instrument?.number ?? 0;
    const instrument = PROGRAM_TO_INSTRUMENT[program] ?? DEFAULT_INSTRUMENT;
    const trackId = ((track.channel !== undefined ? track.channel : index) % NUM_TRACKS);

    for (const note of track.notes) {
      if (note.midi < 21 || note.midi > 108) continue; // our 88-key range

      const start = Math.round(note.ticks / sixteenthTicks);
      const length = Math.max(1, Math.round(note.durationTicks / sixteenthTicks));

      notes.push({ pitch: note.midi, start, length, track: trackId, instrument });
    }
  });

  return { notes, bpm };
}