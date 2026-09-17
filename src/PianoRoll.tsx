import { useState, useRef, useCallback, useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faStop, faReply, faTrash } from '@fortawesome/free-solid-svg-icons';
import { playNotes, noteOn, noteOff, type ScheduledNote } from './audio';
import { notesToMidi, midiToNotes } from './midi';

interface Note {
  pitch: number;
  start: number;
  length: number;
  track: number;
  instrument: string;
  // Free-placement only: exact horizontal geometry in pixels. When set, the
  // note is rendered and hit-tested against these instead of `start`/`length`.
  x?: number;
  width?: number;
}

interface Track {
  id: number;
  name: string;
  color: string;
  border: string;
  instrument: string;
}

const NUM_KEYS = 88;

const TRACKS: Track[] = [
  { id: 0, name: 'Track 1', color: '#4a9eff', border: '#2c7dd0', instrument: 'acoustic_grand_piano' },
  { id: 1, name: 'Track 2', color: '#34d399', border: '#0f9d6c', instrument: 'brass_section' },
  { id: 2, name: 'Track 3', color: '#f472b6', border: '#d0468f', instrument: 'string_ensemble_1' },
];

const formatInstrumentName = (name: string) =>
  name
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
const FIRST_KEY = 21; // A0
const BASE_COLUMNS = 64;

// Free-placement tuning.
const MIN_NOTE_WIDTH = 4; // px; the smallest note a free drag can produce
const RESIZE_SENSITIVITY = 6; // px; how close to the right edge triggers resize
const DEFAULT_NOTE_WIDTH = 40; // px; single-click default in free placement

const isBlackKey = (pitch: number) => {
  const n = pitch % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
};

const getNoteName = (pitch: number) => {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(pitch / 12) - 1;
  return notes[pitch % 12] + octave;
};

export default function PianoRoll() {
  const [bpm, setBpm] = useState(120);
  const [cellWidth, setCellWidth] = useState(40);
  const [cellHeight, setCellHeight] = useState(24);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeTrack, setActiveTrack] = useState<number>(0);
  const [placementMode, setPlacementMode] = useState<'grid' | 'free'>('grid');
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const activeTrackInfo = TRACKS.find(t => t.id === activeTrack) ?? TRACKS[0];
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ pitch: number; start: number } | null>(null);
  const [currentDraw, setCurrentDraw] = useState<{ pitch: number; start: number; end: number } | null>(null);
  const [isRightClicking, setIsRightClicking] = useState(false);
  const [lastNoteLength, setLastNoteLength] = useState(1);
  const [lastNoteWidth, setLastNoteWidth] = useState(DEFAULT_NOTE_WIDTH);
  const [resizingNote, setResizingNote] = useState<Note | null>(null);
  const [movingNote, setMovingNote] = useState<{ note: Note; offsetX: number } | null>(null);
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pianoRollRef = useRef<HTMLDivElement>(null);
  const midiFileRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<{ stop: () => void } | null>(null);
  const heldPitchRef = useRef<number | null>(null);
  const [pressedKeys, setPressedKeys] = useState<Set<number>>(new Set());
  const [markerPosition, setMarkerPosition] = useState<number>(0);
  const [isDraggingMarker, setIsDraggingMarker] = useState(false);
  const [numColumns, setNumColumns] = useState(BASE_COLUMNS);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check the character directly - shifted characters tell us Shift was held
      // - key produces '-' normally, '_' with Shift
      // = key produces '=' normally, '+' with Shift
      if (e.key === '-') {
        setCellWidth(prev => Math.max(12, prev - 2));
        e.preventDefault();
      } else if (e.key === '=') {
        setCellWidth(prev => Math.min(80, prev + 2));
        e.preventDefault();
      } else if (e.key === '_') {
        setCellHeight(prev => Math.max(12, prev - 2));
        e.preventDefault();
      } else if (e.key === '+') {
        setCellHeight(prev => Math.min(48, prev + 2));
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      playbackRef.current?.stop();
    };
  }, []);

  // Load the roll scrolled halfway down the keyboard so the middle octaves
  // are visible on first render.
  useEffect(() => {
    if (!pianoRollRef.current) return;
    pianoRollRef.current.scrollTop =
      (pianoRollRef.current.scrollHeight - pianoRollRef.current.clientHeight) / 2;
  }, []);

  useEffect(() => {
    if (!isDraggingMarker) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + gridRef.current.scrollLeft;
      const maxPos = numColumns * cellWidth;
      setMarkerPosition(Math.max(0, Math.min(maxPos, x)));
    };

    const handleMouseUp = () => {
      setIsDraggingMarker(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingMarker, cellWidth, numColumns]);

  // Close the File dropdown when clicking anywhere outside of it.
  useEffect(() => {
    if (!isFileMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) {
        setIsFileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [isFileMenuOpen]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const togglePlay = () => {
    if (playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
      setIsPlaying(false);
      setPlayhead(null);
      return;
    }

    const scheduleNotes: ScheduledNote[] = notes.map((n) =>
      isFreeNote(n)
        ? {
            pitch: n.pitch,
            start: Math.max(0, Math.round(n.x / cellWidth)),
            length: Math.max(1, Math.round(n.width / cellWidth)),
            instrument: n.instrument,
          }
        : { pitch: n.pitch, start: n.start, length: n.length, instrument: n.instrument }
    );

    const handle = playNotes(
      scheduleNotes,
      bpm,
      Math.floor(markerPosition / cellWidth),
      (column) => setPlayhead(column),
      () => {
        playbackRef.current = null;
        setIsPlaying(false);
        setPlayhead(null);
      }
    );
    playbackRef.current = handle;
    setIsPlaying(true);
  };

  const startOver = () => {
    if (playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
      setIsPlaying(false);
      setPlayhead(null);
    }
    setMarkerPosition(0);
  };

  // Export the current notes (grid and free alike) as a downloadable MIDI file.
  const exportMidi = () => {
    const data = notesToMidi(
      notes.map((n) => ({
        pitch: n.pitch,
        start: Math.round((isFreeNote(n) ? n.x : n.start * cellWidth) / cellWidth),
        length: Math.max(1, Math.round((isFreeNote(n) ? n.width : n.length * cellWidth) / cellWidth)),
        track: n.track,
        instrument: n.instrument,
      })),
      bpm
    );

    const blob = new Blob([data], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'notetoself.mid';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Import a MIDI file, replacing the current notes (imports land on the grid).
  const onImportMidi = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    file.arrayBuffer()
      .then((buffer) => {
        const { notes: importedNotes, bpm: importedBpm } = midiToNotes(buffer);

        // Stop any playback before replacing the notes.
        if (playbackRef.current) {
          playbackRef.current.stop();
          playbackRef.current = null;
          setIsPlaying(false);
          setPlayhead(null);
        }

        const next = importedNotes.map((m) => ({
          pitch: m.pitch,
          start: m.start,
          length: m.length,
          track: m.track,
          instrument: m.instrument,
        }));
        setNotes(next);
        setBpm(importedBpm);
        setMarkerPosition(0);

        const maxEnd = next.length
          ? Math.max(...next.map((m) => m.start + m.length))
          : BASE_COLUMNS;
        setNumColumns(Math.max(BASE_COLUMNS, (Math.floor(maxEnd / 16) + 1) * 16));
      })
      .catch(() => {
        // Ignore import errors; the file input is reset below so it can retry.
      })
      .finally(() => {
        e.target.value = '';
      });
  };

  const getGridPosition = useCallback((e: React.MouseEvent) => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const col = Math.floor(x / cellWidth);
    const pitchOffset = Math.floor(y / cellHeight);
    const pitch = NUM_KEYS - 1 - pitchOffset + FIRST_KEY;
    return { pitch, start: col, x: col * cellWidth };
  }, [cellWidth, cellHeight]);

  // Free placement: return the raw mouse position as pixels. The row (and thus
  // pitch) is still snapped to a grid row, but the horizontal coordinate is not.
  const getFreePosition = useCallback((e: React.MouseEvent) => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const pitchOffset = Math.floor(y / cellHeight);
    const pitch = NUM_KEYS - 1 - pitchOffset + FIRST_KEY;
    const px = Math.round(x);
    return { pitch, start: px, x: px };
  }, [cellHeight]);

  // A note's placement style is fixed at creation: free notes store pixel
  // geometry (x/width); grid notes store columns (start/length).
  const isFreeNote = (note: Note): note is Note & { x: number; width: number } =>
    note.x !== undefined && note.width !== undefined;

  // Resolve the rendered rectangle for a note based on its own stored style,
  // independent of the current placement mode.
  const getNoteRect = (note: Note): { left: number; width: number } => {
    if (isFreeNote(note)) {
      return { left: note.x, width: note.width };
    }
    return { left: note.start * cellWidth, width: note.length * cellWidth };
  };

  const noteLeft = (note: Note): number => (note.x !== undefined ? note.x : getNoteRect(note).left);
  const noteWidth = (note: Note): number => (note.width !== undefined ? note.width : getNoteRect(note).width);

  // Does the pixel x fall within this note's horizontal bounds?
  const hitNoteAtX = (note: Note, x: number): boolean => {
    const r = getNoteRect(note);
    return x >= r.left && x < r.left + r.width;
  };

  // Do [a, b) and the note's horizontal bounds overlap?
  const overlapsX = (note: Note, a: number, b: number): boolean => {
    const r = getNoteRect(note);
    return r.left < b && r.left + r.width > a;
  };

  // Expand the grid to cover the given column, padded to a 16-column beat
  // boundary so it stays aligned with the column headers. Never shrinks.
  const growToColumn = (col: number) => {
    setNumColumns(prev => {
      const needed = Math.max(BASE_COLUMNS, (Math.floor(col / 16) + 1) * 16);
      return needed > prev ? needed : prev;
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      setIsRightClicking(true);
      const pos = getFreePosition(e);
      if (!pos) return;

      const clickedNote = notes.find(n => n.track === activeTrack && n.pitch === pos.pitch && hitNoteAtX(n, pos.x));
      if (clickedNote) {
        setNotes(prev => prev.filter(n => n !== clickedNote));
      }
      return;
    }
    e.preventDefault();
    const pos = getFreePosition(e);
    if (!pos || pos.pitch < FIRST_KEY || pos.pitch >= FIRST_KEY + NUM_KEYS) return;

    heldPitchRef.current = pos.pitch;
    noteOn(pos.pitch, activeTrackInfo.instrument);

    // Clicking an existing note on the active track → edit it in its own style.
    const clickedNote = notes.find(n => n.track === activeTrack && n.pitch === pos.pitch && hitNoteAtX(n, pos.x));
    if (clickedNote) {
      if (isFreeNote(clickedNote)) {
        // Right edge -> resize (px); otherwise move (px).
        if (pos.x >= noteLeft(clickedNote) + noteWidth(clickedNote) - RESIZE_SENSITIVITY) {
          setResizingNote(clickedNote);
          return;
        }
        setMovingNote({ note: clickedNote, offsetX: pos.x - noteLeft(clickedNote) });
        return;
      }
      const col = Math.floor(pos.x / cellWidth);
      // Clicking the very last cell -> resize; otherwise move.
      if (col === clickedNote.start + clickedNote.length - 1) {
        setResizingNote(clickedNote);
        return;
      }
      setMovingNote({ note: clickedNote, offsetX: col - clickedNote.start });
      return;
    }

    // No note under the cursor -> draw a new note in the current placement mode.
    growToColumn(pos.x / cellWidth);
    if (placementMode === 'free') {
      setIsDrawing(true);
      setDrawStart({ pitch: pos.pitch, start: pos.x });
      setCurrentDraw({ pitch: pos.pitch, start: pos.x, end: pos.x });
      return;
    }
    const col = Math.floor(pos.x / cellWidth);
    setIsDrawing(true);
    setDrawStart({ pitch: pos.pitch, start: col });
    setCurrentDraw({ pitch: pos.pitch, start: col, end: col });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRightClicking) {
      const pos = getFreePosition(e);
      if (!pos) return;

      const clickedNote = notes.find(n => n.track === activeTrack && n.pitch === pos.pitch && hitNoteAtX(n, pos.x));
      if (clickedNote) {
        setNotes(prev => prev.filter(n => n !== clickedNote));
      }
      return;
    }

    if (resizingNote) {
      if (isFreeNote(resizingNote)) {
        const pos = getFreePosition(e);
        if (!pos) return;
        const base = noteLeft(resizingNote);
        const newEnd = Math.max(base, pos.x);
        const newWidth = Math.max(MIN_NOTE_WIDTH, newEnd - base);
        setLastNoteWidth(newWidth);
        growToColumn((base + newWidth) / cellWidth);
        setNotes(prev => prev.map(n =>
          n === resizingNote
            ? { ...n, x: base, width: newWidth, pitch: pos.pitch }
            : n
        ));
        setCursorStyle('ew-resize');
        return;
      }
      const pos = getGridPosition(e);
      if (!pos) return;

      const newEnd = Math.max(resizingNote.start, pos.start);
      const newLength = Math.max(1, newEnd - resizingNote.start + 1);
      growToColumn(newEnd);
      setLastNoteLength(newLength);
      setNotes(prev => prev.map(n =>
        n === resizingNote
          ? { ...n, length: newLength, pitch: pos.pitch }
          : n
      ));
      setCursorStyle('ew-resize');
      return;
    }

    if (movingNote) {
      if (isFreeNote(movingNote.note)) {
        const pos = getFreePosition(e);
        if (!pos) return;
        const width = noteWidth(movingNote.note);
        const newX = Math.max(0, pos.x - movingNote.offsetX);
        growToColumn((newX + width) / cellWidth);
        setLastNoteWidth(width);
        const updated = { ...movingNote.note, x: newX, width, pitch: pos.pitch };
        setNotes(prev => prev.map(n => n === movingNote.note ? updated : n));
        setMovingNote({ note: updated, offsetX: movingNote.offsetX });
        setCursorStyle('grabbing');
        return;
      }
      const pos = getGridPosition(e);
      if (!pos) return;

      const newStart = Math.max(0, pos.start - movingNote.offsetX);
      const newPitch = Math.max(FIRST_KEY, Math.min(FIRST_KEY + NUM_KEYS - 1, pos.pitch));
      growToColumn(newStart + movingNote.note.length);

      setLastNoteLength(movingNote.note.length);
      const updated = { ...movingNote.note, pitch: newPitch, start: newStart };
      setNotes(prev => prev.map(n => n === movingNote.note ? updated : n));

      setMovingNote({ note: updated, offsetX: movingNote.offsetX });
      setCursorStyle('grabbing');
      return;
    }

    if (!isDrawing || !drawStart) {
      // Update cursor based on what we're hovering over
      const pos = getFreePosition(e);
      if (pos) {
        const hoveredNote = notes.find(n => n.track === activeTrack && n.pitch === pos.pitch && hitNoteAtX(n, pos.x));
        if (hoveredNote) {
          if (isFreeNote(hoveredNote)) {
            const rect = getNoteRect(hoveredNote);
            setCursorStyle(pos.x >= rect.left + rect.width - RESIZE_SENSITIVITY ? 'ew-resize' : 'grab');
          } else if (Math.floor(pos.x / cellWidth) === hoveredNote.start + hoveredNote.length - 1) {
            setCursorStyle('ew-resize');
          } else {
            setCursorStyle('grab');
          }
        } else {
          setCursorStyle('crosshair');
        }
      }
      return;
    }

    if (placementMode === 'free') {
      const pos = getFreePosition(e);
      if (!pos) return;
      growToColumn(pos.x / cellWidth);
      setCurrentDraw({ ...drawStart, end: pos.x });
      return;
    }
    const pos = getGridPosition(e);
    if (!pos) return;

    growToColumn(pos.start);
    setCurrentDraw({ ...drawStart, end: pos.start });
  };

  const handleMouseUp = () => {
    if (heldPitchRef.current !== null) {
      noteOff(heldPitchRef.current);
      heldPitchRef.current = null;
    }
    setIsRightClicking(false);
    setResizingNote(null);
    setMovingNote(null);
    setCursorStyle('crosshair');
    
    if (isDrawing && currentDraw && drawStart) {
      if (placementMode === 'free') {
        let x0 = Math.min(drawStart.start, currentDraw.end);
        const x1 = Math.max(drawStart.start, currentDraw.end);
        let width = Math.round(x1 - x0);

        // If no drag occurred (single click), use the remembered width.
        if (width < MIN_NOTE_WIDTH) {
          width = lastNoteWidth;
        }

        const start = Math.max(0, Math.round(x0 / cellWidth));
        const length = Math.max(1, Math.round(width / cellWidth));

        setLastNoteWidth(width);
        growToColumn((x0 + width) / cellWidth);

        setNotes(prev => {
          const filtered = prev.filter(n =>
            n.track !== activeTrack ||
            !(n.pitch === drawStart.pitch && overlapsX(n, x0, x0 + width))
          );
          return [...filtered, { pitch: drawStart.pitch, x: x0, width, start, length, track: activeTrack, instrument: activeTrackInfo.instrument }];
        });
      } else {
        let start = Math.min(drawStart.start, currentDraw.end);
        let end = Math.max(drawStart.start, currentDraw.end);
        let length = end - start + 1;

        // If no drag occurred (single click) and we have a last note length, use it
        if (length === 1 && lastNoteLength > 1) {
          length = lastNoteLength;
          end = start + length - 1;
        }

        // Remember the length of the note we just placed
        setLastNoteLength(length);
        growToColumn(end);

        setNotes(prev => {
          const filtered = prev.filter(n =>
            n.track !== activeTrack ||
            !(n.pitch === drawStart.pitch && n.start >= start && n.start < start + length)
          );
          return [...filtered, { pitch: drawStart.pitch, start, length, track: activeTrack, instrument: activeTrackInfo.instrument }];
        });
      }
    }
    setIsDrawing(false);
    setDrawStart(null);
    setCurrentDraw(null);
  };

  const pianoKeys = [];
  for (let i = NUM_KEYS - 1; i >= 0; i--) {
    const pitch = i + FIRST_KEY;
    const black = isBlackKey(pitch);
    const pressed = pressedKeys.has(pitch);
    pianoKeys.push(
      <div
        key={pitch}
        className={`piano-key ${black ? 'black' : 'white'} ${pressed ? 'pressed' : ''}`}
        style={{ height: cellHeight }}
        onMouseDown={(e) => {
          e.preventDefault();
          noteOn(pitch, activeTrackInfo.instrument);
          setPressedKeys(prev => new Set(prev).add(pitch));
        }}
        onMouseUp={() => {
          noteOff(pitch);
          setPressedKeys(prev => {
            const updated = new Set(prev);
            updated.delete(pitch);
            return updated;
          });
        }}
        onMouseLeave={() => {
          noteOff(pitch);
          setPressedKeys(prev => {
            const updated = new Set(prev);
            updated.delete(pitch);
            return updated;
          });
        }}
      >
        <span className="note-name">{getNoteName(pitch)}</span>
      </div>
    );
  }

  const renderColumnHeader = () => {
    const labels: React.ReactElement[] = [];
    const groups = numColumns / 16;
    for (let i = 0; i < groups; i++) {
      labels.push(
        <div
          key={`label-${i}`}
          className="column-header-label"
          style={{ left: i * 16 * cellWidth, width: 16 * cellWidth }}
        >
          {i + 1}
        </div>
      );
    }
    return labels;
  };

  const renderGrid = () => {
    const cells = [];
    for (let row = NUM_KEYS - 1; row >= 0; row--) {
      const pitch = row + FIRST_KEY;
      const black = isBlackKey(pitch);
      for (let col = 0; col < numColumns; col++) {
        const beatClass = col % 16 === 0 ? 'beat-16' : col % 4 === 0 ? 'beat-4' : '';
        cells.push(
          <div
            key={`${row}-${col}`}
            className={`grid-cell ${black ? 'black-row' : 'white-row'} ${beatClass}`}
            style={{
              width: cellWidth,
              height: cellHeight,
            }}
          />
        );
      }
    }
    return cells;
  };

  const renderNotes = (): React.ReactElement[] => {
    const noteElements: React.ReactElement[] = [];
    let preview: Note | null = null;
    if (currentDraw && drawStart) {
      if (placementMode === 'free') {
        const x0 = Math.min(drawStart.start, currentDraw.end);
        const x1 = Math.max(drawStart.start, currentDraw.end);
        const width = Math.max(MIN_NOTE_WIDTH, x1 - x0);
        preview = {
          pitch: drawStart.pitch,
          x: x0,
          width,
          start: Math.round(x0 / cellWidth),
          length: Math.max(1, Math.round(width / cellWidth)),
          track: activeTrack,
          instrument: activeTrackInfo.instrument,
        };
      } else {
        preview = {
          pitch: drawStart.pitch,
          start: Math.min(drawStart.start, currentDraw.end),
          length: Math.abs(currentDraw.end - drawStart.start) + 1,
          track: activeTrack,
          instrument: activeTrackInfo.instrument,
        };
      }
    }
    const displayNotes = preview ? [preview, ...notes] : notes;

    displayNotes.forEach((note, index) => {
      const row = NUM_KEYS - 1 - (note.pitch - FIRST_KEY);
      const isLong = note.length > 1;
      const track = TRACKS.find(t => t.id === note.track) ?? TRACKS[0];
      const isActive = note.track === activeTrack;
      const rect = getNoteRect(note);

      noteElements.push(
        <div
          key={`note-${index}`}
          className={`note-overlay ${isLong ? 'long-note' : 'filled'} ${isActive ? '' : 'inactive'}`}
          style={{
            position: 'absolute',
            left: rect.left,
            top: row * cellHeight,
            width: rect.width,
            height: cellHeight,
            background: track.color,
            border: `2px solid ${track.border}`,
            opacity: isActive ? 1 : 0.25,
            pointerEvents: isActive ? 'auto' : 'none',
          }}
        />
      );
    });

    return noteElements;
  };

  return (
    <div className="piano-roll-container">
      <div className="settings-bar">
        <div className="file-menu" ref={fileMenuRef}>
          <button
            type="button"
            className={`menu-trigger ${isFileMenuOpen ? 'open' : ''}`}
            onClick={() => setIsFileMenuOpen((open) => !open)}
            title="File menu"
          >
            File
            <span className="caret">▾</span>
          </button>
          {isFileMenuOpen && (
            <div className="menu-dropdown">
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setIsFileMenuOpen(false);
                  midiFileRef.current?.click();
                }}
              >
                Import MIDI…
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setIsFileMenuOpen(false);
                  exportMidi();
                }}
                disabled={notes.length === 0}
              >
                Export MIDI…
              </button>
            </div>
          )}
          <input
            ref={midiFileRef}
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            hidden
            onChange={onImportMidi}
          />
        </div>
        <div className="playback-controls">
          <button
            className="control-btn"
            onClick={togglePlay}
            disabled={notes.length === 0}
            title={isPlaying ? 'Stop' : 'Play'}
          >
            <FontAwesomeIcon icon={isPlaying ? faStop : faPlay} />
          </button>
          <button
            className="control-btn"
            onClick={startOver}
            title="Start Over"
          >
            <FontAwesomeIcon icon={faReply} />
          </button>
          <button
            className="control-btn"
            onClick={() => setNotes([])}
            title="Clear All"
          >
            <FontAwesomeIcon icon={faTrash} />
          </button>
          <span className="notes-count">Notes: {notes.length}</span>
        </div>
        <div className="setting track-select">
          <label>Track</label>
          <select
            value={activeTrack}
            onChange={(e) => setActiveTrack(Number(e.target.value))}
            style={{
              color: (TRACKS.find(t => t.id === activeTrack) ?? TRACKS[0]).color,
            }}
          >
            {TRACKS.map(t => (
              <option key={t.id} value={t.id}>
                {formatInstrumentName(t.instrument)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <label>BPM</label>
          <input 
            type="number" 
            value={bpm} 
            onChange={(e) => setBpm(Number(e.target.value))}
            min="1"
            max="300"
          />
        </div>
        <div className="setting placement-toggle">
          <label>Placement</label>
          <div className="segment">
            <button
              type="button"
              className={placementMode === 'grid' ? 'active' : ''}
              onClick={() => setPlacementMode('grid')}
              title="Snap notes to the grid"
            >
              Grid
            </button>
            <button
              type="button"
              className={placementMode === 'free' ? 'active' : ''}
              onClick={() => setPlacementMode('free')}
              title="Place notes freely, ignoring the grid"
            >
              Free
            </button>
          </div>
        </div>
        <div className="setting">
          <label>Grid Width:</label>
          <input 
            type="range" 
            min="12" 
            max="80" 
            value={cellWidth}
            onChange={(e) => setCellWidth(Number(e.target.value))}
          />
          <span>{cellWidth}px</span>
        </div>
        <div className="setting">
          <label>Grid Height:</label>
          <input 
            type="range" 
            min="12" 
            max="48" 
            value={cellHeight}
            onChange={(e) => setCellHeight(Number(e.target.value))}
          />
          <span>{cellHeight}px</span>
        </div>
      </div>
      <div className="piano-roll" ref={pianoRollRef}>
        <div className="piano-keys-sticky">
          {pianoKeys}
        </div>
        <div className="grid-wrap">
          <div
            className="column-header"
            style={{ width: numColumns * cellWidth }}
          >
            {renderColumnHeader()}
          </div>
          <div
            ref={gridRef}
            className="grid-container"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onContextMenu={handleContextMenu}
            style={{
              width: numColumns * cellWidth,
              height: NUM_KEYS * cellHeight,
              gridTemplateColumns: `repeat(${numColumns}, ${cellWidth}px)`,
              gridTemplateRows: `repeat(88, ${cellHeight}px)`,
              cursor: cursorStyle,
            }}
          >
            {renderGrid()}
            {renderNotes()}
            {!isPlaying && (
              <div
                className="marker-line"
                style={{ left: markerPosition }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDraggingMarker(true);
                }}
              />
            )}
            {playhead !== null && isPlaying && (
              <div
                className="playhead"
                style={{ left: playhead * cellWidth }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
