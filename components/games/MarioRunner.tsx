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

// PRNG for 100% Deterministic Piece Queues
function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Web Audio
const playTone = (freq: number, type: OscillatorType, duration: number, vol = 0.1) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch(e) {}
};

// Tetris Constants
const COLS = 10;
const ROWS = 20;
const SHAPES = [
  [], // 0
  [[1,1,1,1]], // I (1 - Cyan)
  [[2,0,0],[2,2,2]], // J (2 - Blue)
  [[0,0,3],[3,3,3]], // L (3 - Orange)
  [[4,4],[4,4]], // O (4 - Yellow)
  [[0,5,5],[5,5,0]], // S (5 - Green)
  [[0,6,0],[6,6,6]], // T (6 - Purple)
  [[7,7,0],[0,7,7]]  // Z (7 - Red)
];
const COLORS = ['#000000', '#06b6d4', '#3b82f6', '#f97316', '#eab308', '#22c55e', '#a855f7', '#ef4444', '#64748b']; // 8 is Garbage

export default function MarioRunner({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const rivalCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const [gameState, setGameState] = useState<'WAITING' | 'PLAYING' | 'GAMEOVER'>('WAITING');
  const [resultMsg, setResultMsg] = useState('');

  // Local Game State Ref
  const stateRef = useRef({
    status: 'WAITING',
    seed: 0,
    pieceIndex: 0,
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    piece: { x: 3, y: 0, matrix: [] as number[][], type: 0 },
    dropCounter: 0,
    dropInterval: 1000,
    garbageQueue: 0,
    lastTime: 0
  });

  // Rival State Ref for rendering
  const rivalRef = useRef({
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    alive: true
  });

  const getNextPiece = useCallback((index: number, seed: number) => {
    const prng = mulberry32(seed + index);
    const type = Math.floor(prng() * 7) + 1; // 1 to 7
    return { type, matrix: SHAPES[type], x: Math.floor(COLS/2)-1, y: 0 };
  }, []);

  const resetGame = (seed: number) => {
    stateRef.current = {
      status: 'PLAYING', seed, pieceIndex: 1,
      grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
      piece: getNextPiece(0, seed),
      dropCounter: 0, dropInterval: 1000, garbageQueue: 0, lastTime: performance.now()
    };
    rivalRef.current = { grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)), alive: true };
    setGameState('PLAYING');
  };

  // Matrix Math
  const rotateMatrix = (matrix: number[][]) => matrix[0].map((val, index) => matrix.map(row => row[index]).reverse());
  const collide = (grid: number[][], piece: any) => {
    for (let y = 0; y < piece.matrix.length; y++) {
      for (let x = 0; x < piece.matrix[y].length; x++) {
        if (piece.matrix[y][x] !== 0 && (grid[y + piece.y] && grid[y + piece.y][x + piece.x]) !== 0) {
          return true;
        }
      }
    }
    return false;
  };
  const merge = (grid: number[][], piece: any) => {
    piece.matrix.forEach((row: number[], y: number) => {
      row.forEach((val, x) => {
        if (val !== 0) grid[y + piece.y][x + piece.x] = val;
      });
    });
  };

  // Physics Actions
  const move = (dir: number) => {
    stateRef.current.piece.x += dir;
    if (collide(stateRef.current.grid, stateRef.current.piece)) stateRef.current.piece.x -= dir;
    else playTone(200, 'sine', 0.05);
  };
  
  const rotate = () => {
    const p = stateRef.current.piece;
    const oldMatrix = p.matrix;
    p.matrix = rotateMatrix(p.matrix);
    if (collide(stateRef.current.grid, p)) p.matrix = oldMatrix; // Undo
    else playTone(300, 'sine', 0.05);
  };

  const hardDrop = () => {
    while (!collide(stateRef.current.grid, stateRef.current.piece)) {
      stateRef.current.piece.y++;
    }
    stateRef.current.piece.y--;
    playerDrop(true);
  };

  const playerDrop = (force = false) => {
    stateRef.current.piece.y++;
    if (collide(stateRef.current.grid, stateRef.current.piece)) {
      stateRef.current.piece.y--;
      merge(stateRef.current.grid, stateRef.current.piece);
      lineClearRoutine();
      spawnNext();
    }
    stateRef.current.dropCounter = 0;
    if (!force) playTone(150, 'square', 0.05);
  };

  const lineClearRoutine = () => {
    const grid = stateRef.current.grid;
    let lines = 0;
    for (let y = grid.length - 1; y >= 0; y--) {
      if (grid[y].every(cell => cell !== 0)) {
        grid.splice(y, 1);
        grid.unshift(Array(COLS).fill(0));
        lines++;
        y++; // Check same row again
      }
    }
    if (lines > 0) {
      playTone(600 + (lines * 100), 'square', 0.2);
      if (lines >= 2) {
        const garbageCount = lines === 2 ? 1 : lines === 3 ? 2 : 4;
        broadcastPayload('ATTACK_TETRIS', { lines: garbageCount });
      }
    }
  };

  const spawnNext = () => {
    // Process Garbage first
    while (stateRef.current.garbageQueue > 0) {
      stateRef.current.grid.shift(); // Remove top line
      const hole = Math.floor(Math.random() * COLS);
      const row = Array(COLS).fill(8);
      row[hole] = 0;
      stateRef.current.grid.push(row);
      stateRef.current.garbageQueue--;
    }

    const state = stateRef.current;
    state.piece = getNextPiece(state.pieceIndex++, state.seed);
    if (collide(state.grid, state.piece)) {
      state.status = 'GAMEOVER';
      setGameState('GAMEOVER');
      setResultMsg('YOU LOST!');
      broadcastPayload('DEATH_TETRIS', {});
    }
  };

  // Keyboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (stateRef.current.status !== 'PLAYING') return;
      if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowDown') playerDrop();
      else if (e.key === 'ArrowUp') rotate();
      else if (e.key === ' ') hardDrop();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Network Sync Loop
  useEffect(() => {
    const unsubStart = subscribePayload('START_TETRIS', (p) => resetGame(p.seed));
    const unsubAttack = subscribePayload('ATTACK_TETRIS', (p) => { stateRef.current.garbageQueue += p.lines; });
    const unsubDeath = subscribePayload('DEATH_TETRIS', () => {
      if (stateRef.current.status === 'PLAYING') {
        stateRef.current.status = 'GAMEOVER';
        setGameState('GAMEOVER');
        setResultMsg('YOU WON!');
      }
      rivalRef.current.alive = false;
    });
    const unsubSync = subscribePayload('SYNC_TETRIS', (p) => {
      if (p.role !== playerRole) rivalRef.current.grid = p.grid;
    });

    if (playerRole === 'p1') {
      setTimeout(() => broadcastPayload('START_TETRIS', { seed: Math.floor(Math.random() * 9999) }), 1000);
    }

    const syncInterval = setInterval(() => {
      if (stateRef.current.status === 'PLAYING') {
        // Send combined grid (board + active piece) for rival view
        const displayGrid = stateRef.current.grid.map(row => [...row]);
        const p = stateRef.current.piece;
        p.matrix.forEach((row, y) => {
          row.forEach((val, x) => {
            if (val !== 0 && displayGrid[y + p.y]) displayGrid[y + p.y][x + p.x] = val;
          });
        });
        broadcastPayload('SYNC_TETRIS', { role: playerRole, grid: displayGrid });
      }
    }, 66); // 15 fps sync

    return () => { unsubStart(); unsubAttack(); unsubDeath(); unsubSync(); clearInterval(syncInterval); };
  }, [playerRole, broadcastPayload, subscribePayload]);

  // Render Engine
  useEffect(() => {
    let animationId: number;
    const drawGrid = (ctx: CanvasRenderingContext2D, grid: number[][], bw: number, bh: number, isGhost = false) => {
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, bw*COLS, bh*ROWS);
      grid.forEach((row, y) => {
        row.forEach((val, x) => {
          if (val !== 0) {
            ctx.fillStyle = COLORS[val];
            ctx.fillRect(x * bw, y * bh, bw - 1, bh - 1);
            if (!isGhost) {
              ctx.fillStyle = 'rgba(255,255,255,0.2)';
              ctx.fillRect(x * bw, y * bh, bw - 1, 2);
            }
          }
        });
      });
    };

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const state = stateRef.current;
      
      if (state.status === 'PLAYING') {
        const dt = time - state.lastTime;
        state.lastTime = time;
        state.dropCounter += dt;
        if (state.dropCounter > state.dropInterval) {
          playerDrop();
        }
      }

      // Draw Main
      const mCtx = mainCanvasRef.current?.getContext('2d');
      if (mCtx && state.status !== 'WAITING') {
        const displayGrid = state.grid.map(row => [...row]);
        if (state.status === 'PLAYING') {
          const p = state.piece;
          p.matrix.forEach((row, y) => {
            row.forEach((val, x) => {
              if (val !== 0 && displayGrid[y + p.y]) displayGrid[y + p.y][x + p.x] = val;
            });
          });
        }
        drawGrid(mCtx, displayGrid, 24, 24);
      }

      // Draw Rival
      const rCtx = rivalCanvasRef.current?.getContext('2d');
      if (rCtx && state.status !== 'WAITING') {
        drawGrid(rCtx, rivalRef.current.grid, 12, 12, true);
        if (!rivalRef.current.alive) {
          rCtx.fillStyle = 'rgba(239, 68, 68, 0.5)'; // red-500
          rCtx.fillRect(0, 0, 12*COLS, 12*ROWS);
        }
      }
    };
    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, []);

  return (
    <div className="w-full max-w-md bg-slate-950 flex flex-col items-center justify-center p-2 sm:p-4 touch-none">
      
      {/* Top HUD */}
      <div className="w-full flex justify-between items-end mb-4 px-2 font-black text-slate-100 uppercase tracking-widest">
        <div className="flex flex-col items-center">
          <span className="text-xs text-indigo-400 mb-1">{playerRole === 'p1' ? p1Name : p2Name}</span>
          <canvas ref={mainCanvasRef} width={240} height={480} className="bg-slate-900 border-2 border-slate-700 shadow-2xl rounded-sm" />
        </div>
        <div className="flex flex-col items-center opacity-70">
          <span className="text-xs text-rose-400 mb-1">{playerRole === 'p1' ? p2Name : p1Name}</span>
          <canvas ref={rivalCanvasRef} width={120} height={240} className="bg-slate-900 border-2 border-slate-800 rounded-sm" />
        </div>
      </div>

      {/* Mobile Ergonomic Controls */}
      <div className="w-full max-w-[240px] flex flex-col gap-2 self-start pl-2">
        <div className="flex gap-2 justify-between">
          <button onTouchStart={(e) => { e.preventDefault(); move(-1); }} className="flex-1 bg-slate-800 active:bg-slate-700 text-slate-300 py-4 rounded-xl font-bold border border-slate-700 text-xl shadow-lg">←</button>
          <button onTouchStart={(e) => { e.preventDefault(); playerDrop(); }} className="flex-1 bg-slate-800 active:bg-slate-700 text-slate-300 py-4 rounded-xl font-bold border border-slate-700 text-xl shadow-lg">↓</button>
          <button onTouchStart={(e) => { e.preventDefault(); move(1); }} className="flex-1 bg-slate-800 active:bg-slate-700 text-slate-300 py-4 rounded-xl font-bold border border-slate-700 text-xl shadow-lg">→</button>
        </div>
        <div className="flex gap-2">
          <button onTouchStart={(e) => { e.preventDefault(); rotate(); }} className="flex-1 bg-indigo-600 active:bg-indigo-500 text-white py-4 rounded-xl font-bold shadow-lg shadow-indigo-900/50">ROTATE ↻</button>
          <button onTouchStart={(e) => { e.preventDefault(); hardDrop(); }} className="flex-1 bg-rose-600 active:bg-rose-500 text-white py-4 rounded-xl font-bold shadow-lg shadow-rose-900/50">DROP ⤓</button>
        </div>
      </div>

      {/* Overlays */}
      {gameState !== 'PLAYING' && (
        <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-6 z-20">
          {gameState === 'WAITING' ? (
            <div className="text-indigo-400 font-black text-2xl animate-pulse tracking-widest">SYNCING BOARD...</div>
          ) : (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full max-w-sm text-center shadow-2xl">
              <h2 className={`text-5xl font-black mb-8 uppercase tracking-widest ${resultMsg === 'YOU WON!' ? 'text-emerald-400' : 'text-rose-500'}`}>
                {resultMsg}
              </h2>
              <button onClick={() => broadcastPayload('START_TETRIS', { seed: Math.floor(Math.random() * 9999) })} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xl py-4 rounded-xl transition-transform active:scale-95 shadow-lg shadow-indigo-900/50">
                Instant Rematch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}