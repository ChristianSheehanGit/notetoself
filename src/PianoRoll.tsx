import { useState, useRef, useCallback, useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faStop, faReply } from '@fortawesome/free-solid-svg-icons';
import { playNotes, noteOn, noteOff } from './audio';

interface Note {
  pitch: number;
  start: number;
  length: number;
}

const NUM_KEYS = 88;
const FIRST_KEY = 21; // A0
const NUM_COLUMNS = 64;

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
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ pitch: number; start: number } | null>(null);
  const [currentDraw, setCurrentDraw] = useState<{ pitch: number; start: number; end: number } | null>(null);
  const [isRightClicking, setIsRightClicking] = useState(false);
  const [lastNoteLength, setLastNoteLength] = useState(1);
  const [resizingNote, setResizingNote] = useState<{ pitch: number; start: number; length: number } | null>(null);
  const [movingNote, setMovingNote] = useState<{ pitch: number; start: number; length: number; offsetX: number } | null>(null);
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<{ stop: () => void } | null>(null);
  const heldPitchRef = useRef<number | null>(null);
  const [pressedKeys, setPressedKeys] = useState<Set<number>>(new Set());
  const [markerPosition, setMarkerPosition] = useState<number>(0);
  const [isDraggingMarker, setIsDraggingMarker] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check the character directly - shifted characters tell us Shift was held
      // - key produces '-' normally, '_' with Shift
      // = key produces '=' normally, '+' with Shift
      if (e.key === '-') {
        setCellWidth(prev => Math.max(20, prev - 2));
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

  useEffect(() => {
    if (!isDraggingMarker) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + gridRef.current.scrollLeft;
      const maxPos = NUM_COLUMNS * cellWidth;
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
  }, [isDraggingMarker, cellWidth]);

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

    const handle = playNotes(
      notes,
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

  const getGridPosition = useCallback((e: React.MouseEvent) => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const col = Math.floor(x / cellWidth);
    const pitchOffset = Math.floor(y / cellHeight);
    const pitch = NUM_KEYS - 1 - pitchOffset + FIRST_KEY;
    return { pitch, start: col };
  }, [cellWidth, cellHeight]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      setIsRightClicking(true);
      const pos = getGridPosition(e);
      if (!pos) return;
      
      const clickedNote = notes.find(n => n.pitch === pos.pitch && pos.start >= n.start && pos.start < n.start + n.length);
      if (clickedNote) {
        setNotes(prev => prev.filter(n => n !== clickedNote));
      }
      return;
    }
    e.preventDefault();
    const pos = getGridPosition(e);
    if (!pos || pos.pitch < FIRST_KEY || pos.pitch >= FIRST_KEY + NUM_KEYS) return;

    heldPitchRef.current = pos.pitch;
    noteOn(pos.pitch);

    // Check if clicking on existing note
    const clickedNote = notes.find(n => n.pitch === pos.pitch && pos.start >= n.start && pos.start < n.start + n.length);
    if (clickedNote) {
      // Check if clicking on the very last cell of the note to resize
      if (pos.start === clickedNote.start + clickedNote.length - 1) {
        setResizingNote({ ...clickedNote });
        return;
      }
      // Otherwise start moving the note
      const offsetX = pos.start - clickedNote.start;
      setMovingNote({ ...clickedNote, offsetX });
      return;
    }
    
    setIsDrawing(true);
    setDrawStart(pos);
    setCurrentDraw({ ...pos, end: pos.start });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRightClicking) {
      const pos = getGridPosition(e);
      if (!pos) return;
      
      const clickedNote = notes.find(n => n.pitch === pos.pitch && pos.start >= n.start && pos.start < n.start + n.length);
      if (clickedNote) {
        setNotes(prev => prev.filter(n => n !== clickedNote));
      }
      return;
    }
    
    if (resizingNote) {
      const pos = getGridPosition(e);
      if (!pos) return;
      
      const newEnd = Math.max(resizingNote.start, pos.start);
      const newLength = Math.max(1, newEnd - resizingNote.start + 1);
      setLastNoteLength(newLength);
      setNotes(prev => prev.map(n => 
        n.pitch === resizingNote.pitch && n.start === resizingNote.start
          ? { ...n, length: newLength, pitch: pos.pitch }
          : n
      ));
      setCursorStyle('ew-resize');
      return;
    }
    
    if (movingNote) {
      const pos = getGridPosition(e);
      if (!pos) return;
      
      const newStart = Math.max(0, pos.start - movingNote.offsetX);
      const newPitch = Math.max(FIRST_KEY, Math.min(FIRST_KEY + NUM_KEYS - 1, pos.pitch));
      
      setLastNoteLength(movingNote.length);
      setNotes(prev => prev.map(n => 
        n.pitch === movingNote.pitch && n.start === movingNote.start
          ? { ...n, pitch: newPitch, start: newStart }
          : n
      ));
      
      setMovingNote({ ...movingNote, pitch: newPitch, start: newStart });
      setCursorStyle('grabbing');
      return;
    }
    
    if (!isDrawing || !drawStart) {
      // Update cursor based on what we're hovering over
      const pos = getGridPosition(e);
      if (pos) {
        const hoveredNote = notes.find(n => n.pitch === pos.pitch && pos.start >= n.start && pos.start < n.start + n.length);
        if (hoveredNote) {
          if (pos.start === hoveredNote.start + hoveredNote.length - 1) {
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
    
    const pos = getGridPosition(e);
    if (!pos) return;
    
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
      
      setNotes(prev => {
        const filtered = prev.filter(n => !(n.pitch === drawStart.pitch && n.start >= start && n.start < start + length));
        return [...filtered, { pitch: drawStart.pitch, start, length }];
      });
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
          noteOn(pitch);
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
    const groups = NUM_COLUMNS / 16;
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
      for (let col = 0; col < NUM_COLUMNS; col++) {
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
    const displayNotes = currentDraw && drawStart ? [...notes, {
      pitch: drawStart.pitch,
      start: Math.min(drawStart.start, currentDraw.end),
      length: Math.abs(currentDraw.end - drawStart.start) + 1
    }] : notes;

    displayNotes.forEach((note, index) => {
      const row = NUM_KEYS - 1 - (note.pitch - FIRST_KEY);
      const isLong = note.length > 1;
      
      noteElements.push(
        <div
          key={`note-${index}`}
          className={`note-overlay ${isLong ? 'long-note' : 'filled'}`}
          style={{
            position: 'absolute',
            left: note.start * cellWidth,
            top: row * cellHeight,
            width: note.length * cellWidth,
            height: cellHeight,
          }}
        />
      );
    });
    
    return noteElements;
  };

  return (
    <div className="piano-roll-container">
      <div className="settings-bar">
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
        </div>
        <div className="setting">
          <input 
            type="number" 
            value={bpm} 
            onChange={(e) => setBpm(Number(e.target.value))}
            min="1"
            max="300"
          />
        </div>
        <div className="setting">
          <label>Grid Width:</label>
          <input 
            type="range" 
            min="20" 
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
                <span>Notes: {notes.length}</span>
        <div className="footer-buttons">
          <button onClick={togglePlay} disabled={notes.length === 0}>
            {isPlaying ? 'Stop' : 'Play'}
          </button>
          <button onClick={() => setNotes([])}>Clear All</button>
        </div>
      </div>
      <div className="piano-roll">
        <div className="piano-keys-sticky">
          {pianoKeys}
        </div>
        <div className="grid-wrap">
          <div
            className="column-header"
            style={{ width: NUM_COLUMNS * cellWidth }}
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
              width: NUM_COLUMNS * cellWidth,
              height: NUM_KEYS * cellHeight,
              gridTemplateColumns: `repeat(64, ${cellWidth}px)`,
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
