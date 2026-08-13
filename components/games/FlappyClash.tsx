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

// PRNG for 100% Deterministic Pipes
function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Web Audio API Synthesis
const playTone = (freq: number, type: OscillatorType, duration: number, vol = 0.1) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (type === 'sine') osc.frequency.exponentialRampToValueAtTime(freq * 2, ctx.currentTime + duration); // Flap swoop
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
};

export default function FlappyClash({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Game State
  const [gameState, setGameState] = useState<'WAITING' | 'PLAYING' | 'GAMEOVER'>('WAITING');
  const [gameSeed, setGameSeed] = useState(0);
  
  // HUD State (Syncs 15fps)
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  
  // Physics Constants (Floaty & Forgiving)
  const GRAVITY = 0.35;
  const FLAP_VEL = -6.5;
  const SPEED = 3;
  const PIPE_GAP = 160;
  const PIPE_WIDTH = 60;
  const PIPE_SPACING = 280;
  
  // Mutable State Refs for Game Loop to avoid dependency closures
  const stateRef = useRef<{
    seed: number;
    status: 'WAITING' | 'PLAYING' | 'GAMEOVER';
    local: { x: number; y: number; vel: number; alive: boolean; score: number };
    rival: { x: number; y: number; alive: boolean; score: number };
    lastSyncTime: number;
  }>({
    seed: 0,
    status: 'WAITING',
    local: { x: 0, y: 320, vel: 0, alive: true, score: 0 },
    rival: { x: 0, y: 320, alive: true, score: 0 },
    lastSyncTime: 0
  });

  const generatePipe = useCallback((index: number, seed: number) => {
    const prng = mulberry32(seed + index);
    const rand = prng();
    const minY = 50;
    const maxY = 640 - 50 - PIPE_GAP; // Assuming height 640
    const topHeight = minY + (rand * (maxY - minY));
    return { 
      index, 
      x: 400 + (index * PIPE_SPACING), // Absolute X position
      topHeight, 
      bottomY: topHeight + PIPE_GAP 
    };
  }, []);

  // Network Handlers
  useEffect(() => {
    const unsubStart = subscribePayload('START_FLAPPY', (payload) => {
      stateRef.current.seed = payload.seed;
      setGameSeed(payload.seed);
      resetMatch();
      setGameState('PLAYING');
      stateRef.current.status = 'PLAYING';
    });

    const unsubSync = subscribePayload('SYNC_FLAPPY', (payload) => {
      if (payload.role !== playerRole) {
        stateRef.current.rival.x = payload.x;
        stateRef.current.rival.y = payload.y;
        stateRef.current.rival.alive = payload.alive;
        stateRef.current.rival.score = payload.score;
        if (payload.role === 'p1') setP1Score(payload.score);
        else setP2Score(payload.score);
      }
    });

    const unsubRematch = subscribePayload('REMATCH_FLAPPY', (payload) => {
      stateRef.current.seed = payload.seed;
      setGameSeed(payload.seed);
      resetMatch();
      setGameState('PLAYING');
      stateRef.current.status = 'PLAYING';
    });

    if (playerRole === 'p1') {
      // Host automatically starts match
      setTimeout(() => {
        const seed = Math.floor(Math.random() * 100000);
        broadcastPayload('START_FLAPPY', { seed });
      }, 1000);
    }

    return () => { unsubStart(); unsubSync(); unsubRematch(); };
  }, [playerRole, subscribePayload, broadcastPayload]);

  const resetMatch = () => {
    stateRef.current.local = { x: 0, y: 320, vel: 0, alive: true, score: 0 };
    stateRef.current.rival = { x: 0, y: 320, alive: true, score: 0 };
    setP1Score(0);
    setP2Score(0);
  };

  const handleFlap = (e?: React.TouchEvent | React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (stateRef.current.status !== 'PLAYING') return;
    if (!stateRef.current.local.alive) return;
    
    stateRef.current.local.vel = FLAP_VEL;
    playTone(400, 'sine', 0.1, 0.05);
  };

  const triggerRematch = () => {
    const seed = Math.floor(Math.random() * 100000);
    broadcastPayload('REMATCH_FLAPPY', { seed });
  };

  // Main Game Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    let animationId: number;

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const state = stateRef.current;
      
      // Update Physics if Playing
      if (state.status === 'PLAYING') {
        if (state.local.alive) {
          state.local.vel += GRAVITY;
          state.local.y += state.local.vel;
          state.local.x += SPEED;

          // Floor/Ceiling Collision
          if (state.local.y > canvas.height - 20) {
            state.local.y = canvas.height - 20;
            state.local.alive = false;
            playTone(100, 'square', 0.3, 0.1); // Crash
          }
          if (state.local.y < 0) {
            state.local.y = 0;
            state.local.vel = 0;
          }

          // Pipe Generation & Collision Logic
          const startingPipeIndex = Math.max(0, Math.floor((state.local.x - 400) / PIPE_SPACING));
          for (let i = startingPipeIndex; i < startingPipeIndex + 4; i++) {
            const pipe = generatePipe(i, state.seed);
            
            // Bird renders at fixed screen X: 100
            const localBirdScreenX = 100;
            const pipeScreenX = pipe.x - state.local.x + localBirdScreenX;
            
            // Score tracking
            if (pipeScreenX < localBirdScreenX && pipeScreenX + SPEED >= localBirdScreenX) {
               state.local.score++;
               playTone(800, 'sine', 0.1, 0.02); // Point
               if (playerRole === 'p1') setP1Score(state.local.score);
               else setP2Score(state.local.score);
            }

            // Hitbox check (Forgiving 12px inset)
            const inset = 12;
            const hitX = localBirdScreenX + 30 > pipeScreenX + inset && localBirdScreenX < pipeScreenX + PIPE_WIDTH - inset;
            if (hitX) {
              const hitTop = state.local.y < pipe.topHeight - inset;
              const hitBottom = state.local.y + 30 > pipe.bottomY + inset;
              if (hitTop || hitBottom) {
                state.local.alive = false;
                playTone(100, 'square', 0.3, 0.1);
              }
            }
          }
        }

        // Check overall game over
        // (Removed redundant state.status check since we are already inside `if (state.status === 'PLAYING')`)
        if (!state.local.alive && !state.rival.alive) {
          state.status = 'GAMEOVER';
          setGameState('GAMEOVER');
        }

        // Throttle Network Sync (15 fps = ~66ms)
        if (time - state.lastSyncTime > 66) {
          state.lastSyncTime = time;
          broadcastPayload('SYNC_FLAPPY', { 
            role: playerRole, 
            x: state.local.x, 
            y: state.local.y, 
            alive: state.local.alive, 
            score: state.local.score 
          });
        }
      }

      // ---------------- RENDER PHASE ---------------- //
      ctx.fillStyle = '#0f172a'; // bg-slate-950
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Determine Camera X (If local dead, follow rival for spectating!)
      let cameraGlobalX = state.local.x;
      if (!state.local.alive && state.rival.alive) {
        cameraGlobalX = state.rival.x;
      }
      
      // Draw Pipes based on Camera X
      const drawStartIndex = Math.max(0, Math.floor((cameraGlobalX - 400) / PIPE_SPACING) - 1);
      ctx.fillStyle = '#10b981'; // emerald-500
      
      for (let i = drawStartIndex; i < drawStartIndex + 5; i++) {
        const pipe = generatePipe(i, state.seed);
        const pipeScreenX = pipe.x - cameraGlobalX + 100;
        
        // Top Pipe
        ctx.fillRect(pipeScreenX, 0, PIPE_WIDTH, pipe.topHeight);
        ctx.fillRect(pipeScreenX - 4, pipe.topHeight - 20, PIPE_WIDTH + 8, 20); // Cap
        // Bottom Pipe
        ctx.fillRect(pipeScreenX, pipe.bottomY, PIPE_WIDTH, canvas.height - pipe.bottomY);
        ctx.fillRect(pipeScreenX - 4, pipe.bottomY, PIPE_WIDTH + 8, 20); // Cap
      }

      // Ground
      ctx.fillStyle = '#334155'; // slate-700
      ctx.fillRect(0, canvas.height - 10, canvas.width, 10);

      // Draw Local Bird
      const localScreenX = state.local.alive || !state.rival.alive ? 100 : state.local.x - cameraGlobalX + 100;
      ctx.globalAlpha = 1.0;
      if (state.local.alive) {
        ctx.fillStyle = playerRole === 'p1' ? '#ef4444' : '#3b82f6'; // Red P1, Blue P2
        ctx.fillRect(localScreenX, state.local.y, 30, 30);
      } else {
        // Tombstone
        ctx.fillStyle = '#64748b';
        ctx.fillRect(localScreenX, canvas.height - 30, 24, 30);
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        ctx.fillText('RIP', localScreenX + 4, canvas.height - 10);
      }

      // Draw Rival Bird (Ghost)
      const rivalScreenX = state.rival.x - cameraGlobalX + 100;
      ctx.globalAlpha = 0.5;
      if (state.rival.alive) {
        ctx.fillStyle = playerRole === 'p1' ? '#3b82f6' : '#ef4444';
        ctx.fillRect(rivalScreenX, state.rival.y, 30, 30);
      } else {
        // Tombstone for rival
        ctx.fillStyle = '#64748b';
        ctx.fillRect(rivalScreenX, canvas.height - 30, 24, 30);
      }
      ctx.globalAlpha = 1.0;
    };

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [playerRole, generatePipe, broadcastPayload]);

  return (
    <div className="w-full max-w-[420px] aspect-[9/16] relative bg-black shadow-2xl overflow-hidden touch-none" onTouchStart={handleFlap} onMouseDown={handleFlap}>
      {/* Top HUD */}
      <div className="absolute top-0 w-full p-4 flex justify-between z-10 font-black pointer-events-none text-xl shadow-[inset_0_40px_40px_rgba(0,0,0,0.8)]">
        <div className={`drop-shadow-md ${playerRole === 'p1' ? 'text-red-400' : 'text-blue-400'}`}>
          {p1Name}: {p1Score}
        </div>
        <div className={`drop-shadow-md ${playerRole === 'p2' ? 'text-blue-400' : 'text-red-400'}`}>
          {p2Name}: {p2Score}
        </div>
      </div>
      
      {/* Game Canvas */}
      <canvas ref={canvasRef} width={420} height={746} className="w-full h-full object-cover" />
      
      {/* Game Over / Waiting Overlay */}
      {gameState !== 'PLAYING' && (
        <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-6 text-center z-20 pointer-events-auto">
          {gameState === 'WAITING' ? (
            <div className="text-white font-black text-2xl animate-pulse">Syncing Host...</div>
          ) : (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full">
              <h2 className="text-4xl font-black text-white mb-6 uppercase tracking-widest">Match Over</h2>
              
              <div className="flex justify-between text-2xl font-bold mb-2">
                <span className="text-slate-400">{p1Name}</span>
                <span className="text-white">{p1Score}</span>
              </div>
              <div className="flex justify-between text-2xl font-bold mb-8">
                <span className="text-slate-400">{p2Name}</span>
                <span className="text-white">{p2Score}</span>
              </div>

              <div className="text-xl font-black text-emerald-400 mb-8 uppercase bg-slate-950 py-3 rounded-lg border border-slate-800">
                {p1Score === p2Score ? 'DRAW!' : p1Score > p2Score ? `${p1Name} WINS!` : `${p2Name} WINS!`}
              </div>

              <button onClick={triggerRematch} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xl py-4 rounded-xl transition-transform active:scale-95">
                Instant Rematch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}