'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';

interface GameProps {
  roomCode: string;
  playerRole: 'p1' | 'p2';
  p1Name: string;
  p2Name: string;
  broadcastPayload: (event: string, payload: any) => void;
  subscribePayload: (event: string, callback: (payload: any) => void) => () => void;
}

// ------------------------------------------------------------------
// UTILS: PRNG & Audio
// ------------------------------------------------------------------
function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

const playTone = (freq: number, type: OscillatorType, duration: number, vol = 0.1, slideFreq?: number) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideFreq) osc.frequency.exponentialRampToValueAtTime(slideFreq, ctx.currentTime + duration);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch(e) {}
};

// ------------------------------------------------------------------
// TETRIS CONSTANTS, SHAPES & TYPES
// ------------------------------------------------------------------
const COLS = 10;
const ROWS = 20;

interface Piece {
  x: number;
  y: number;
  matrix: number[][];
  type: number;
}

// Shapes and their visually balanced spawn centers
const SHAPES = [
  [], // 0: Empty
  [[0,0,0,0], [1,1,1,1], [0,0,0,0], [0,0,0,0]], // 1: I (Cyan)
  [[2,0,0], [2,2,2], [0,0,0]], // 2: J (Blue)
  [[0,0,3], [3,3,3], [0,0,0]], // 3: L (Orange)
  [[4,4], [4,4]], // 4: O (Yellow)
  [[0,5,5], [5,5,0], [0,0,0]], // 5: S (Green)
  [[0,6,0], [6,6,6], [0,0,0]], // 6: T (Purple)
  [[7,7,0], [0,7,7], [0,0,0]]  // 7: Z (Red)
];

// Block Colors: Base, Light (Highlight), Dark (Shadow)
const COLORS = [
  { base: '#000000', light: '#000000', dark: '#000000' }, // 0
  { base: '#06b6d4', light: '#22d3ee', dark: '#0891b2' }, // 1 I
  { base: '#3b82f6', light: '#60a5fa', dark: '#2563eb' }, // 2 J
  { base: '#f97316', light: '#fb923c', dark: '#ea580c' }, // 3 L
  { base: '#eab308', light: '#facc15', dark: '#ca8a04' }, // 4 O
  { base: '#22c55e', light: '#4ade80', dark: '#16a34a' }, // 5 S
  { base: '#a855f7', light: '#c084fc', dark: '#9333ea' }, // 6 T
  { base: '#ef4444', light: '#f87171', dark: '#dc2626' }, // 7 Z
  { base: '#475569', light: '#64748b', dark: '#334155' }  // 8 Garbage
];

// ------------------------------------------------------------------
// GRAPHICS ENGINE
// ------------------------------------------------------------------
const drawBlock = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, type: number, alpha = 1.0) => {
  if (type === 0) return;
  const color = COLORS[type];
  
  ctx.globalAlpha = alpha;
  
  // Base
  ctx.fillStyle = color.base;
  ctx.fillRect(x, y, size, size);
  
  // Top-Left Highlight
  ctx.fillStyle = color.light;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size - 4, y + 4);
  ctx.lineTo(x + 4, y + 4);
  ctx.lineTo(x + 4, y + size - 4);
  ctx.lineTo(x, y + size);
  ctx.fill();

  // Bottom-Right Shadow
  ctx.fillStyle = color.dark;
  ctx.beginPath();
  ctx.moveTo(x + size, y + size);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x + 4, y + size - 4);
  ctx.lineTo(x + size - 4, y + size - 4);
  ctx.lineTo(x + size - 4, y + 4);
  ctx.lineTo(x + size, y);
  ctx.fill();

  // Inner Glow / Main face
  ctx.fillStyle = color.base;
  ctx.fillRect(x + 4, y + 4, size - 8, size - 8);

  // If Garbage, draw hazard stripes
  if (type === 8) {
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 4, y + size - 8); ctx.lineTo(x + size - 8, y + 4);
    ctx.stroke();
  }

  ctx.globalAlpha = 1.0;
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------
export default function MarioRunner({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const rivalCanvasRef = useRef<HTMLCanvasElement>(null);
  const nextCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const [gameState, setGameState] = useState<'WAITING' | 'PLAYING' | 'GAMEOVER'>('WAITING');
  const [resultMsg, setResultMsg] = useState('');
  
  const [p1Lines, setP1Lines] = useState(0);
  const [p2Lines, setP2Lines] = useState(0);

  // Mutable Game State Ref (Runs at 60FPS unhindered by React renders)
  const stateRef = useRef<{
    status: 'WAITING' | 'PLAYING' | 'GAMEOVER';
    seed: number;
    pieceIndex: number;
    grid: number[][];
    piece: Piece;
    nextPiece: Piece;
    dropCounter: number;
    dropInterval: number;
    garbageQueue: number;
    lastTime: number;
    shake: number;
    redFlash: number;
    popups: { text: string; x: number; y: number; life: number; color: string }[];
    linesCleared: number;
  }>({
    status: 'WAITING',
    seed: 0,
    pieceIndex: 0,
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    piece: { x: 0, y: 0, matrix: [], type: 0 },
    nextPiece: { x: 0, y: 0, matrix: [], type: 0 },
    dropCounter: 0,
    dropInterval: 800,
    garbageQueue: 0,
    lastTime: 0,
    shake: 0,
    redFlash: 0,
    popups: [],
    linesCleared: 0
  });

  const rivalRef = useRef({
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    alive: true,
    linesCleared: 0
  });

  // Matrix Math
  const getNextPiece = useCallback((index: number, seed: number): Piece => {
    const prng = mulberry32(seed + index);
    const type = Math.floor(prng() * 7) + 1;
    // Spawn X offsets to center shapes perfectly
    const xOffset = type === 4 ? 4 : 3; 
    return { type, matrix: SHAPES[type], x: xOffset, y: 0 };
  }, []);

  const resetGame = useCallback((seed: number) => {
    stateRef.current = {
      status: 'PLAYING', seed, pieceIndex: 2,
      grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
      piece: getNextPiece(0, seed),
      nextPiece: getNextPiece(1, seed),
      dropCounter: 0, dropInterval: 800, garbageQueue: 0, lastTime: performance.now(),
      shake: 0, redFlash: 0, popups: [], linesCleared: 0
    };
    rivalRef.current = { grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)), alive: true, linesCleared: 0 };
    setP1Lines(0); setP2Lines(0);
    setGameState('PLAYING');
  }, [getNextPiece]);

  const rotateMatrix = (matrix: number[][]) => matrix[0].map((_, index) => matrix.map(row => row[index]).reverse());
  
  const collide = (grid: number[][], piece: Piece, offsetY = 0, offsetX = 0) => {
    for (let y = 0; y < piece.matrix.length; y++) {
      for (let x = 0; x < piece.matrix[y].length; x++) {
        if (piece.matrix[y][x] !== 0) {
          const newY = y + piece.y + offsetY;
          const newX = x + piece.x + offsetX;
          if (newY >= ROWS || newX < 0 || newX >= COLS || (newY >= 0 && grid[newY][newX] !== 0)) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const merge = (grid: number[][], piece: Piece) => {
    piece.matrix.forEach((row: number[], y: number) => {
      row.forEach((val, x) => {
        if (val !== 0 && y + piece.y >= 0) grid[y + piece.y][x + piece.x] = val;
      });
    });
  };

  const addPopup = (text: string, color: string) => {
    stateRef.current.popups.push({ text, x: 120, y: 240, life: 1.0, color });
  };

  // Logic Actions
  const spawnNext = useCallback(() => {
    const state = stateRef.current;
    
    // Process Incoming Garbage
    if (state.garbageQueue > 0) {
      state.shake = 15;
      state.redFlash = 1.0;
      playTone(100, 'sawtooth', 0.5, 50); // Warning/Damage sound
      
      while (state.garbageQueue > 0) {
        state.grid.shift();
        const hole = Math.floor(Math.random() * COLS);
        const row = Array(COLS).fill(8); // 8 is Garbage type
        row[hole] = 0;
        state.grid.push(row);
        state.garbageQueue--;
      }
    }

    // Spawn Piece
    state.piece = state.nextPiece;
    state.nextPiece = getNextPiece(state.pieceIndex++, state.seed);
    
    // Speed up slightly over time
    state.dropInterval = Math.max(150, 800 - (state.linesCleared * 10));

    // Death Check
    if (collide(state.grid, state.piece)) {
      state.status = 'GAMEOVER';
      setGameState('GAMEOVER');
      setResultMsg('DEFEATED');
      playTone(150, 'sawtooth', 1.0, 50);
      broadcastPayload('DEATH_TETRIS', {});
    }
  }, [getNextPiece, broadcastPayload]);

  const lineClearRoutine = useCallback(() => {
    const state = stateRef.current;
    let linesClearedNow = 0;
    
    for (let y = state.grid.length - 1; y >= 0; y--) {
      if (state.grid[y].every(cell => cell !== 0 && cell !== 8)) {
        state.grid.splice(y, 1);
        state.grid.unshift(Array(COLS).fill(0));
        linesClearedNow++;
        y++; // Re-check the same row index since everything shifted down
      }
    }

    if (linesClearedNow > 0) {
      state.linesCleared += linesClearedNow;
      if (playerRole === 'p1') setP1Lines(state.linesCleared);
      else setP2Lines(state.linesCleared);

      // Attack Mechanics
      let attackPower = 0;
      if (linesClearedNow === 1) {
        playTone(400, 'sine', 0.1);
      } else if (linesClearedNow === 2) {
        playTone(600, 'sine', 0.2);
        attackPower = 1;
        addPopup('DOUBLE!', '#4ade80');
      } else if (linesClearedNow === 3) {
        playTone(800, 'sine', 0.3);
        attackPower = 2;
        addPopup('TRIPLE!', '#3b82f6');
      } else if (linesClearedNow === 4) {
        playTone(1000, 'square', 0.5);
        state.shake = 10;
        attackPower = 4;
        addPopup('TETRIS!', '#f87171');
      }

      if (attackPower > 0) {
        // Send Attack
        addPopup(`+${attackPower} SENT`, '#fb923c');
        broadcastPayload('ATTACK_TETRIS', { lines: attackPower });
      }
    }
  }, [playerRole, broadcastPayload]);

  const playerDrop = useCallback((force = false) => {
    const state = stateRef.current;
    if (state.status !== 'PLAYING') return;

    if (!collide(state.grid, state.piece, 1, 0)) {
      state.piece.y++;
      state.dropCounter = 0;
      if (!force) playTone(150, 'square', 0.05);
    } else {
      // Lock Piece
      merge(state.grid, state.piece);
      playTone(100, 'square', 0.1);
      lineClearRoutine();
      spawnNext();
    }
  }, [lineClearRoutine, spawnNext]);

  const hardDrop = useCallback(() => {
    const state = stateRef.current;
    if (state.status !== 'PLAYING') return;
    
    let dropDist = 0;
    while (!collide(state.grid, state.piece, dropDist + 1, 0)) {
      dropDist++;
    }
    state.piece.y += dropDist;
    state.shake = 5; // Screen shake on hard drop
    playTone(80, 'square', 0.15, 40);
    
    merge(state.grid, state.piece);
    lineClearRoutine();
    spawnNext();
    state.dropCounter = 0;
  }, [lineClearRoutine, spawnNext]);

  const move = useCallback((dir: number) => {
    const state = stateRef.current;
    if (state.status !== 'PLAYING') return;
    if (!collide(state.grid, state.piece, 0, dir)) {
      state.piece.x += dir;
      playTone(300, 'sine', 0.03);
    }
  }, []);
  
  const rotate = useCallback(() => {
    const state = stateRef.current;
    if (state.status !== 'PLAYING') return;
    const p = state.piece;
    const oldMatrix = p.matrix;
    p.matrix = rotateMatrix(p.matrix);
    
    // Wall Kicks (Basic)
    let offset = 0;
    if (collide(state.grid, p, 0, 0)) {
      if (!collide(state.grid, p, 0, 1)) offset = 1;
      else if (!collide(state.grid, p, 0, -1)) offset = -1;
      else p.matrix = oldMatrix; // Fail
    }
    p.x += offset;
    
    if (p.matrix !== oldMatrix) playTone(400, 'sine', 0.05);
  }, []);

  // Keyboard Setup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (stateRef.current.status !== 'PLAYING') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); playerDrop(true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); rotate(); }
      else if (e.key === ' ') { e.preventDefault(); hardDrop(); }
    };
    window.addEventListener('keydown', handleKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [move, rotate, playerDrop, hardDrop]);

  // Network Sync Loop
  useEffect(() => {
    const unsubStart = subscribePayload('START_TETRIS', (p) => resetGame(p.seed));
    const unsubAttack = subscribePayload('ATTACK_TETRIS', (p) => { 
      stateRef.current.garbageQueue += p.lines; 
    });
    const unsubDeath = subscribePayload('DEATH_TETRIS', () => {
      if (stateRef.current.status === 'PLAYING') {
        stateRef.current.status = 'GAMEOVER';
        setGameState('GAMEOVER');
        setResultMsg('VICTORY!');
        playTone(600, 'square', 1.0, 1200); // Victory fanfare
      }
      rivalRef.current.alive = false;
    });
    const unsubSync = subscribePayload('SYNC_TETRIS', (p) => {
      if (p.role !== playerRole) {
        rivalRef.current.grid = p.grid;
        if (p.role === 'p1') setP1Lines(p.lines); else setP2Lines(p.lines);
      }
    });

    if (playerRole === 'p1') {
      setTimeout(() => broadcastPayload('START_TETRIS', { seed: Math.floor(Math.random() * 99999) }), 1000);
    }

    const syncInterval = setInterval(() => {
      if (stateRef.current.status === 'PLAYING') {
        // Send composite grid (locked blocks + active piece)
        const displayGrid = stateRef.current.grid.map(row => [...row]);
        const p = stateRef.current.piece;
        if (p && p.matrix && p.matrix.length > 0) {
          p.matrix.forEach((row, y) => {
            row.forEach((val, x) => {
              if (val !== 0 && displayGrid[y + p.y]) displayGrid[y + p.y][x + p.x] = val;
            });
          });
        }
        broadcastPayload('SYNC_TETRIS', { role: playerRole, grid: displayGrid, lines: stateRef.current.linesCleared });
      }
    }, 66); // 15 FPS Throttle

    return () => { unsubStart(); unsubAttack(); unsubDeath(); unsubSync(); clearInterval(syncInterval); };
  }, [playerRole, broadcastPayload, subscribePayload, resetGame]);

  // Main Render Engine (Canvas 60FPS)
  useEffect(() => {
    let animationId: number;
    const BW = 24; // Block Width Main
    const RW = 12; // Block Width Rival

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const state = stateRef.current;
      const dt = time - state.lastTime;
      state.lastTime = time;
      
      // Update Physics
      if (state.status === 'PLAYING') {
        state.dropCounter += dt;
        if (state.dropCounter > state.dropInterval) {
          playerDrop();
        }
      }

      // Decrement VFX
      if (state.shake > 0) state.shake *= 0.8;
      if (state.shake < 0.5) state.shake = 0;
      if (state.redFlash > 0) state.redFlash -= 0.05;
      state.popups.forEach(p => { p.life -= 0.02; p.y -= 1; });
      state.popups = state.popups.filter(p => p.life > 0);

      // -----------------------------------------------------
      // 1. DRAW MAIN CANVAS
      // -----------------------------------------------------
      const mCtx = mainCanvasRef.current?.getContext('2d');
      if (mCtx && state.status !== 'WAITING') {
        mCtx.save();
        
        // Background
        mCtx.fillStyle = '#020617'; // bg-slate-950
        mCtx.fillRect(0, 0, COLS * BW, ROWS * BW);

        // Screen Shake Apply
        if (state.shake > 0) {
          mCtx.translate((Math.random()-0.5)*state.shake, (Math.random()-0.5)*state.shake);
        }

        // Draw Grid Lines
        mCtx.strokeStyle = '#0f172a';
        mCtx.lineWidth = 1;
        for(let x=0; x<=COLS; x++) { mCtx.beginPath(); mCtx.moveTo(x*BW, 0); mCtx.lineTo(x*BW, ROWS*BW); mCtx.stroke(); }
        for(let y=0; y<=ROWS; y++) { mCtx.beginPath(); mCtx.moveTo(0, y*BW); mCtx.lineTo(COLS*BW, y*BW); mCtx.stroke(); }

        // Draw Locked Grid
        state.grid.forEach((row, y) => {
          row.forEach((val, x) => {
            if (val !== 0) drawBlock(mCtx, x * BW, y * BW, BW, val);
          });
        });

        if (state.status === 'PLAYING') {
          const p = state.piece;
          
          if (p.matrix && p.matrix.length > 0) {
            // Draw Ghost Piece
            let ghostY = p.y;
            while (!collide(state.grid, p, ghostY - p.y + 1, 0)) { ghostY++; }
            p.matrix.forEach((row, y) => {
              row.forEach((val, x) => {
                if (val !== 0) drawBlock(mCtx, (x + p.x) * BW, (y + ghostY) * BW, BW, val, 0.25);
              });
            });

            // Draw Active Piece
            p.matrix.forEach((row, y) => {
              row.forEach((val, x) => {
                if (val !== 0) drawBlock(mCtx, (x + p.x) * BW, (y + p.y) * BW, BW, val);
              });
            });
          }
        }

        // Damage Flash Overlay
        if (state.redFlash > 0) {
          mCtx.fillStyle = `rgba(220, 38, 38, ${state.redFlash * 0.4})`; // red-600
          mCtx.fillRect(0, 0, COLS * BW, ROWS * BW);
        }

        // Popups
        state.popups.forEach(popup => {
          mCtx.fillStyle = popup.color;
          mCtx.globalAlpha = Math.max(0, popup.life);
          mCtx.font = '900 24px sans-serif';
          mCtx.textAlign = 'center';
          mCtx.shadowColor = '#000';
          mCtx.shadowBlur = 4;
          mCtx.fillText(popup.text, popup.x, popup.y);
          mCtx.shadowBlur = 0;
          mCtx.globalAlpha = 1.0;
        });

        mCtx.restore();
      }

      // -----------------------------------------------------
      // 2. DRAW NEXT PIECE
      // -----------------------------------------------------
      const nCtx = nextCanvasRef.current?.getContext('2d');
      if (nCtx && state.status !== 'WAITING') {
        nCtx.fillStyle = '#0f172a';
        nCtx.fillRect(0, 0, 96, 96);
        const np = state.nextPiece;
        if (np && np.matrix && np.matrix.length > 0) {
          // Center the piece visually in the 4x4 mini-grid
          const offsetX = np.type === 4 ? 24 : np.type === 1 ? 0 : 12;
          const offsetY = np.type === 1 ? 12 : 24;
          
          np.matrix.forEach((row, y) => {
            row.forEach((val, x) => {
              if (val !== 0) drawBlock(nCtx, x * BW + offsetX, y * BW + offsetY, BW, val);
            });
          });
        }
      }

      // -----------------------------------------------------
      // 3. DRAW RIVAL MINIMAP
      // -----------------------------------------------------
      const rCtx = rivalCanvasRef.current?.getContext('2d');
      if (rCtx && state.status !== 'WAITING') {
        rCtx.fillStyle = '#020617';
        rCtx.fillRect(0, 0, COLS * RW, ROWS * RW);
        rivalRef.current.grid.forEach((row, y) => {
          row.forEach((val, x) => {
            if (val !== 0) drawBlock(rCtx, x * RW, y * RW, RW, val, 0.8);
          });
        });
        if (!rivalRef.current.alive) {
          rCtx.fillStyle = 'rgba(239, 68, 68, 0.4)';
          rCtx.fillRect(0, 0, COLS * RW, ROWS * RW);
          rCtx.fillStyle = '#fff';
          rCtx.font = '900 16px sans-serif';
          rCtx.textAlign = 'center';
          rCtx.fillText('DEAD', (COLS*RW)/2, (ROWS*RW)/2);
        }
      }
    };
    
    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [playerDrop]);

  // Touch handlers to prevent default zooming/scrolling on mobile
  const stopProp = (e: React.TouchEvent | React.MouseEvent, action: () => void) => {
    e.preventDefault(); e.stopPropagation(); action();
  };

  return (
    <div className="w-full h-full bg-slate-950 flex flex-col items-center p-2 sm:p-4 touch-none select-none relative">
      
      {/* Top HUD */}
      <div className="w-full max-w-md flex justify-between items-center mb-4 px-2 font-black uppercase tracking-widest text-lg">
        <div className={`flex flex-col drop-shadow-md ${playerRole === 'p1' ? 'text-cyan-400' : 'text-purple-400'}`}>
          <span className="text-xs text-slate-500 mb-1">{p1Name} LINES</span>
          <span>{p1Lines}</span>
        </div>
        <div className={`flex flex-col text-right drop-shadow-md ${playerRole === 'p2' ? 'text-cyan-400' : 'text-purple-400'}`}>
          <span className="text-xs text-slate-500 mb-1">{p2Name} LINES</span>
          <span>{p2Lines}</span>
        </div>
      </div>

      {/* Game Layout Wrapper */}
      <div className="flex gap-4 items-start w-full max-w-md justify-center">
        
        {/* Main Local Board */}
        <div className="bg-slate-900 p-2 rounded-xl border-2 border-slate-800 shadow-[0_0_30px_rgba(0,0,0,0.8)] relative">
          <canvas ref={mainCanvasRef} width={240} height={480} className="rounded-sm bg-slate-950" />
        </div>

        {/* Right Sidebar (Next Piece & Rival) */}
        <div className="flex flex-col gap-4">
          <div className="bg-slate-900 p-2 rounded-xl border-2 border-slate-800 flex flex-col items-center">
            <span className="text-[10px] font-bold text-slate-500 mb-2 uppercase tracking-widest">Next</span>
            <canvas ref={nextCanvasRef} width={96} height={96} className="bg-slate-950 rounded-sm" />
          </div>
          
          <div className="bg-slate-900 p-2 rounded-xl border-2 border-slate-800 flex flex-col items-center">
            <span className="text-[10px] font-bold text-slate-500 mb-2 uppercase tracking-widest">Rival</span>
            <canvas ref={rivalCanvasRef} width={120} height={240} className="bg-slate-950 rounded-sm" />
          </div>
        </div>
      </div>

      {/* Mobile Controls (Ergonomic, Side-by-Side D-Pad & Actions) */}
      <div className="w-full max-w-md mt-6 grid grid-cols-2 gap-4 px-2">
        {/* Left Side: Movement D-Pad */}
        <div className="flex gap-2 h-16">
          <button onTouchStart={(e) => stopProp(e, () => move(-1))} onMouseDown={(e) => stopProp(e, () => move(-1))} className="flex-1 bg-slate-800 active:bg-slate-700 rounded-2xl flex items-center justify-center border-b-4 border-slate-950 active:border-b-0 active:translate-y-1 transition-all">
            <span className="text-3xl text-slate-400 font-black">←</span>
          </button>
          <button onTouchStart={(e) => stopProp(e, () => playerDrop(true))} onMouseDown={(e) => stopProp(e, () => playerDrop(true))} className="flex-1 bg-slate-800 active:bg-slate-700 rounded-2xl flex items-center justify-center border-b-4 border-slate-950 active:border-b-0 active:translate-y-1 transition-all">
            <span className="text-3xl text-slate-400 font-black">↓</span>
          </button>
          <button onTouchStart={(e) => stopProp(e, () => move(1))} onMouseDown={(e) => stopProp(e, () => move(1))} className="flex-1 bg-slate-800 active:bg-slate-700 rounded-2xl flex items-center justify-center border-b-4 border-slate-950 active:border-b-0 active:translate-y-1 transition-all">
            <span className="text-3xl text-slate-400 font-black">→</span>
          </button>
        </div>

        {/* Right Side: Action Buttons */}
        <div className="flex gap-2 h-16">
          <button onTouchStart={(e) => stopProp(e, rotate)} onMouseDown={(e) => stopProp(e, rotate)} className="flex-1 bg-indigo-600 active:bg-indigo-500 rounded-2xl flex items-center justify-center border-b-4 border-indigo-900 active:border-b-0 active:translate-y-1 transition-all shadow-lg shadow-indigo-900/50">
            <span className="text-xl text-white font-black tracking-wider">⟳</span>
          </button>
          <button onTouchStart={(e) => stopProp(e, hardDrop)} onMouseDown={(e) => stopProp(e, hardDrop)} className="flex-1 bg-rose-600 active:bg-rose-500 rounded-2xl flex items-center justify-center border-b-4 border-rose-900 active:border-b-0 active:translate-y-1 transition-all shadow-lg shadow-rose-900/50">
            <span className="text-2xl text-white font-black">⤓</span>
          </button>
        </div>
      </div>

      {/* Screen Overlays */}
      {gameState !== 'PLAYING' && (
        <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-6 z-20 backdrop-blur-sm">
          {gameState === 'WAITING' ? (
            <div className="text-indigo-400 font-black text-2xl animate-pulse tracking-widest">SYNCING BOARD...</div>
          ) : (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full max-w-sm text-center shadow-2xl animate-in zoom-in-95">
              <h2 className={`text-5xl font-black mb-8 uppercase tracking-widest drop-shadow-lg ${resultMsg === 'VICTORY!' ? 'text-emerald-400' : 'text-rose-500'}`}>
                {resultMsg}
              </h2>
              <div className="flex justify-between items-center bg-slate-950 p-4 rounded-xl border border-slate-800 mb-8 font-black text-xl">
                <span className="text-slate-400">LINES CLEARED</span>
                <span className="text-white">{playerRole === 'p1' ? p1Lines : p2Lines}</span>
              </div>
              <button onClick={() => broadcastPayload('START_TETRIS', { seed: Math.floor(Math.random() * 99999) })} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xl py-5 rounded-xl transition-transform active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.4)]">
                Instant Rematch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}