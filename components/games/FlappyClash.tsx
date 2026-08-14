'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

// Singleton Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const hasSupabase = supabaseUrl.startsWith('http') && supabaseKey.length > 0;

let supabase: ReturnType<typeof createClient> | null = null;
if (hasSupabase) {
  if (typeof window !== 'undefined') {
    if (!(window as any).__supabase) {
      (window as any).__supabase = createClient(supabaseUrl, supabaseKey);
    }
    supabase = (window as any).__supabase;
  } else {
    supabase = createClient(supabaseUrl, supabaseKey);
  }
}

interface GameProps {
  roomCode: string;
  playerRole: 'p1' | 'p2';
  p1Name: string;
  p2Name: string;
  broadcastPayload: (event: string, payload: any) => void;
  subscribePayload: (event: string, callback: (payload: any) => void) => () => void;
}

type GlobalScore = { id: string, name: string, score: number };

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

const playTone = (freq: number, type: OscillatorType, duration: number, vol = 0.1) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (type === 'sine') osc.frequency.exponentialRampToValueAtTime(freq * 2, ctx.currentTime + duration);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
};

// ------------------------------------------------------------------
// GRAPHICS ENGINE (CANVAS 2D) - UNTOUCHED!
// ------------------------------------------------------------------
const drawBackground = (ctx: CanvasRenderingContext2D, width: number, height: number, cameraX: number) => {
  const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
  skyGrad.addColorStop(0, '#4cb8c4');
  skyGrad.addColorStop(1, '#3cd3ad');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  const cloudOffset = (cameraX * 0.1) % (width * 2);
  for(let i = 0; i < 5; i++) {
     const cx = (i * 200) - cloudOffset + (i % 2 === 0 ? width : 0);
     const cy = 60 + (i * 40);
     ctx.beginPath();
     ctx.arc(cx, cy, 30, 0, Math.PI*2);
     ctx.arc(cx + 25, cy - 10, 40, 0, Math.PI*2);
     ctx.arc(cx + 50, cy, 30, 0, Math.PI*2);
     ctx.fill();
  }

  const treeOffset = (cameraX * 0.3) % 200;
  ctx.fillStyle = '#2c8f79';
  for(let i = -1; i < width / 100 + 2; i++) {
     const tx = (i * 100) - treeOffset;
     ctx.beginPath();
     ctx.moveTo(tx + 50, height - 30);
     ctx.lineTo(tx + 10, height - 140 + (i%3)*20);
     ctx.lineTo(tx + 90, height - 140 + (i%3)*20);
     ctx.fill();
  }
};

const drawGround = (ctx: CanvasRenderingContext2D, width: number, height: number, cameraX: number) => {
  const groundY = height - 30;
  ctx.fillStyle = '#ded895';
  ctx.fillRect(0, groundY, width, 30);
  ctx.fillStyle = '#73bf2e';
  ctx.fillRect(0, groundY, width, 8);
  ctx.strokeStyle = '#558f22';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(width, groundY); ctx.stroke();

  const scrollOffset = (cameraX * 1) % 40;
  ctx.fillStyle = '#c9c381';
  for(let i = -1; i < (width / 40) + 2; i++) {
     const sx = (i * 40) - scrollOffset;
     ctx.beginPath();
     ctx.moveTo(sx, groundY + 8);
     ctx.lineTo(sx + 12, groundY + 8);
     ctx.lineTo(sx - 8, groundY + 30);
     ctx.lineTo(sx - 20, groundY + 30);
     ctx.fill();
  }
};

const drawPipe = (ctx: CanvasRenderingContext2D, x: number, topHeight: number, bottomY: number, width: number, height: number) => {
  const pipeColor = '#73bf2e';
  const shadowColor = '#4a851b';
  const highlight = '#9de659';
  const capH = 24;
  const over = 4;

  const drawCylinder = (cx: number, cy: number, cw: number, ch: number) => {
    const grad = ctx.createLinearGradient(cx, 0, cx + cw, 0);
    grad.addColorStop(0, shadowColor);
    grad.addColorStop(0.2, pipeColor);
    grad.addColorStop(0.6, highlight);
    grad.addColorStop(0.8, pipeColor);
    grad.addColorStop(1, shadowColor);
    ctx.fillStyle = grad;
    ctx.fillRect(cx, cy, cw, ch);
    ctx.strokeStyle = '#2c4a11';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx, cy, cw, ch);
  };

  drawCylinder(x, 0, width, topHeight - capH);
  drawCylinder(x - over, topHeight - capH, width + over*2, capH);
  drawCylinder(x, bottomY + capH, width, height - bottomY - capH);
  drawCylinder(x - over, bottomY, width + over*2, capH);
};

const drawBird = (ctx: CanvasRenderingContext2D, x: number, y: number, color: string, vel: number, isGhost: boolean, isAlive: boolean, time: number) => {
  ctx.save();
  ctx.translate(x + 15, y + 15);
  const rotation = isAlive ? Math.min(Math.PI / 4, Math.max(-Math.PI / 6, vel * 0.12)) : Math.PI / 2.5;
  ctx.rotate(rotation);

  if (isGhost) ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000';

  const flap = isAlive ? Math.sin(time / 80) * 6 : 0;

  ctx.strokeStyle = '#f97316';
  ctx.beginPath(); ctx.moveTo(-4, 10); ctx.lineTo(-4, 16); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(4, 12); ctx.lineTo(4, 18); ctx.stroke();
  ctx.strokeStyle = '#000';

  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 0, 16, 12, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath(); ctx.ellipse(4, 4, 8, 5, -0.2, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(8, -4, 6, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  
  if (isAlive) {
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(10, -4, 2.5, 0, Math.PI*2); ctx.fill();
  } else {
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.moveTo(6, -6); ctx.lineTo(10, -2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10, -6); ctx.lineTo(6, -2); ctx.stroke();
  }

  ctx.fillStyle = '#f97316';
  ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(24, 2); ctx.lineTo(12, 6); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(-4, 2 + (vel < 0 && isAlive ? flap : 0), 8, 5, 0.2, 0, Math.PI*2); ctx.fill(); ctx.stroke();

  ctx.restore();
};

const drawTombstone = (ctx: CanvasRenderingContext2D, x: number, y: number, isGhost: boolean) => {
  ctx.save();
  if (isGhost) ctx.globalAlpha = 0.5;
  ctx.translate(x, y - 30);
  
  ctx.fillStyle = '#94a3b8';
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(3, 30);
  ctx.lineTo(3, 12);
  ctx.arc(15, 12, 12, Math.PI, 0);
  ctx.lineTo(27, 30);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#334155';
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RIP', 15, 16);
  ctx.fillRect(13, 20, 4, 8); 
  ctx.fillRect(10, 22, 10, 3); 

  ctx.restore();
};

// ------------------------------------------------------------------
// MAIN GAME COMPONENT
// ------------------------------------------------------------------
export default function FlappyClash({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // UI State
  const [gameState, setGameState] = useState<'WAITING' | 'PLAYING' | 'GAMEOVER'>('WAITING');
  const [showGameOverUI, setShowGameOverUI] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);

  // Match Wins & High Score State
  const [matchWins, setMatchWins] = useState({ p1: 0, p2: 0 });
  const [highScore, setHighScore] = useState({ score: 0, names: [] as string[] });
  
  // Global Database Leaderboard
  const [globalLeaderboard, setGlobalLeaderboard] = useState<GlobalScore[]>([]);
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(false);

  // Fetch Leaderboard from Supabase
  const fetchGlobalLeaderboard = useCallback(async () => {
    if (!hasSupabase || !supabase) return;
    const { data, error } = await (supabase.from('flappy_highscores') as any)
      .select('*')
      .order('score', { ascending: false })
      .limit(10);
    
    if (error) {
      console.error("[LEADERBOARD FETCH ERROR]:", error.message);
    } else if (data) {
      setGlobalLeaderboard(data as GlobalScore[]);
    }
  }, []);

  useEffect(() => {
    fetchGlobalLeaderboard();
  }, [fetchGlobalLeaderboard]);

  // Dynamically watch scores for the top HUD
  useEffect(() => {
    const currentHighest = Math.max(p1Score, p2Score);
    if (currentHighest > highScore.score) {
      setHighScore(prev => {
        if (currentHighest <= prev.score) return prev; 
        const names = [];
        if (p1Score === currentHighest) names.push(p1Name);
        if (p2Score === currentHighest) names.push(p2Name);
        return { score: currentHighest, names };
      });
    } else if (currentHighest === highScore.score && currentHighest > 0) {
      setHighScore(prev => {
        const newNames = new Set(prev.names);
        if (p1Score === currentHighest) newNames.add(p1Name);
        if (p2Score === currentHighest) newNames.add(p2Name);
        return { score: prev.score, names: Array.from(newNames) };
      });
    }
  }, [p1Score, p2Score, p1Name, p2Name]); 
  
  // Physics Constants
  const GRAVITY = 0.35;
  const FLAP_VEL = -6.5;
  const SPEED = 3;
  const PIPE_GAP = 160;
  const PIPE_WIDTH = 60;
  const PIPE_SPACING = 280;
  
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Core Mutable State
  const stateRef = useRef({
    seed: 0,
    status: 'WAITING',
    local: { x: 0, y: 320, vel: 0, alive: true, score: 0 },
    rival: { x: 0, y: 320, alive: true, score: 0 },
    lastSyncTime: 0,
    lastLocalScore: 0,
    lastRivalY: 320,
    hasSubmittedScore: false
  });

  const generatePipe = useCallback((index: number, seed: number) => {
    const prng = mulberry32(seed + index);
    const rand = prng();
    const minY = 80;
    const maxY = 746 - 80 - 30 - PIPE_GAP;
    const topHeight = minY + (rand * (maxY - minY));
    return { index, x: 400 + (index * PIPE_SPACING), topHeight, bottomY: topHeight + PIPE_GAP };
  }, []);

  const checkGameOver = useCallback(() => {
    const state = stateRef.current;
    if (!state.local.alive && !state.rival.alive && state.status !== 'GAMEOVER') {
        state.status = 'GAMEOVER';
        setGameState('GAMEOVER');

        // Match Winner Logic
        const finalP1 = playerRole === 'p1' ? state.local.score : state.rival.score;
        const finalP2 = playerRole === 'p2' ? state.local.score : state.rival.score;
        
        if (finalP1 > finalP2) {
          setMatchWins(prev => ({ ...prev, p1: prev.p1 + 1 }));
        } else if (finalP2 > finalP1) {
          setMatchWins(prev => ({ ...prev, p2: prev.p2 + 1 }));
        }

        timeoutRef.current = setTimeout(() => {
            setShowGameOverUI(true);
        }, 1200); 
    }
  }, [playerRole]);

  // SUBMIT SCORE IMMEDIATELY ON LOCAL BIRD CRASH
  const triggerDeathSync = useCallback(() => {
    const state = stateRef.current;
    
    // Broadcast death to rival
    broadcastPayload('SYNC_FLAPPY', { 
      role: playerRole, x: state.local.x, y: state.local.y, alive: false, score: state.local.score 
    });

    // SUBMIT TO SUPABASE IMMEDIATELY WHEN YOUR BIRD CRASHES
    if (!state.hasSubmittedScore && hasSupabase && supabase) {
      if (state.local.score > 0) {
        state.hasSubmittedScore = true;
        const localName = playerRole === 'p1' ? p1Name : p2Name;

        (supabase.from('flappy_highscores') as any)
          .insert([{ name: localName, score: state.local.score }])
          .select()
          .then(({ error }: any) => {
            if (error) {
              console.error("[LEADERBOARD SAVE ERROR]:", error.message);
            } else {
              fetchGlobalLeaderboard(); 
            }
          });
      }
    }

    checkGameOver();
  }, [playerRole, p1Name, p2Name, broadcastPayload, checkGameOver, fetchGlobalLeaderboard]);

  // Network Subscriptions
  useEffect(() => {
    const unsubStart = subscribePayload('START_FLAPPY', (payload) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      stateRef.current = {
        seed: payload.seed, status: 'PLAYING',
        local: { x: 0, y: 320, vel: 0, alive: true, score: 0 },
        rival: { x: 0, y: 320, alive: true, score: 0 },
        lastSyncTime: 0, lastLocalScore: 0, lastRivalY: 320, hasSubmittedScore: false
      };
      setP1Score(0); setP2Score(0);
      setGameState('PLAYING');
      setShowGameOverUI(false);
      setIsLeaderboardOpen(false);
    });

    const unsubSync = subscribePayload('SYNC_FLAPPY', (payload) => {
      if (payload.role !== playerRole) {
        stateRef.current.rival.x = payload.x;
        stateRef.current.rival.y = payload.y;
        stateRef.current.rival.alive = payload.alive;
        stateRef.current.rival.score = payload.score;
        if (payload.role === 'p1') setP1Score(payload.score);
        else setP2Score(payload.score);
        
        checkGameOver();
      }
    });

    const unsubRematch = subscribePayload('REMATCH_FLAPPY', (payload) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      stateRef.current = {
        seed: payload.seed, status: 'PLAYING',
        local: { x: 0, y: 320, vel: 0, alive: true, score: 0 },
        rival: { x: 0, y: 320, alive: true, score: 0 },
        lastSyncTime: 0, lastLocalScore: 0, lastRivalY: 320, hasSubmittedScore: false
      };
      setP1Score(0); setP2Score(0);
      setGameState('PLAYING');
      setShowGameOverUI(false);
      setIsLeaderboardOpen(false);
    });

    if (playerRole === 'p1') {
      setTimeout(() => broadcastPayload('START_FLAPPY', { seed: Math.floor(Math.random() * 100000) }), 1000);
    }

    return () => { unsubStart(); unsubSync(); unsubRematch(); };
  }, [playerRole, subscribePayload, broadcastPayload, checkGameOver]);

  const handleFlap = (e?: React.TouchEvent | React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (stateRef.current.status !== 'PLAYING') return;
    if (!stateRef.current.local.alive) return;
    
    stateRef.current.local.vel = FLAP_VEL;
    playTone(400, 'sine', 0.1, 0.05);
  };

  const triggerRematch = () => {
    broadcastPayload('REMATCH_FLAPPY', { seed: Math.floor(Math.random() * 100000) });
  };

  // Main Render & Physics Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    let animationId: number;

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const state = stateRef.current;
      const groundY = canvas.height - 30;
      
      if (state.status === 'PLAYING' || state.status === 'GAMEOVER') {
        if (state.local.alive) {
          state.local.x += SPEED;
        }

        if (state.local.y < groundY) {
            state.local.vel += GRAVITY;
            state.local.y += state.local.vel;
        }

        if (state.local.y >= groundY) {
          state.local.y = groundY;
          if (state.local.alive) {
            state.local.alive = false;
            playTone(100, 'square', 0.3, 0.1);
            triggerDeathSync();
          }
        }

        if (state.local.y < 0) {
          state.local.y = 0;
          state.local.vel = 0;
        }

        if (state.local.alive) {
          const startingIndex = Math.max(0, Math.floor((state.local.x - 400) / PIPE_SPACING));
          for (let i = startingIndex; i < startingIndex + 4; i++) {
            const pipe = generatePipe(i, state.seed);
            const localBirdScreenX = 100;
            const pipeScreenX = pipe.x - state.local.x + localBirdScreenX;
            
            if (pipeScreenX < localBirdScreenX && pipeScreenX + SPEED >= localBirdScreenX) {
               state.local.score++;
               if (state.local.score > state.lastLocalScore) {
                   state.lastLocalScore = state.local.score;
                   if (playerRole === 'p1') setP1Score(state.local.score);
                   else setP2Score(state.local.score);
               }
               playTone(800, 'sine', 0.1, 0.02);
            }

            const inset = 12;
            const hitX = localBirdScreenX + 30 > pipeScreenX + inset && localBirdScreenX < pipeScreenX + PIPE_WIDTH - inset;
            if (hitX) {
              const hitTop = state.local.y < pipe.topHeight - inset;
              const hitBottom = state.local.y + 30 > pipe.bottomY + inset;
              if (hitTop || hitBottom) {
                state.local.alive = false;
                state.local.vel = 0;
                playTone(100, 'square', 0.3, 0.1);
                triggerDeathSync();
              }
            }
          }
        }

        if (state.status === 'PLAYING' && time - state.lastSyncTime > 66) {
          state.lastSyncTime = time;
          broadcastPayload('SYNC_FLAPPY', { 
            role: playerRole, x: state.local.x, y: state.local.y, alive: state.local.alive, score: state.local.score 
          });
        }
      }

      const cameraGlobalX = Math.max(state.local.x, state.rival.x);
      
      drawBackground(ctx, canvas.width, canvas.height, cameraGlobalX);
      
      const drawStartIndex = Math.max(0, Math.floor((cameraGlobalX - 400) / PIPE_SPACING) - 1);
      for (let i = drawStartIndex; i < drawStartIndex + 5; i++) {
        const pipe = generatePipe(i, state.seed);
        const pipeScreenX = pipe.x - cameraGlobalX + 100;
        drawPipe(ctx, pipeScreenX, pipe.topHeight, pipe.bottomY, PIPE_WIDTH, canvas.height);
      }

      drawGround(ctx, canvas.width, canvas.height, cameraGlobalX);

      const p1Color = '#ef4444'; 
      const p2Color = '#3b82f6'; 
      const localColor = playerRole === 'p1' ? p1Color : p2Color;
      const rivalColor = playerRole === 'p1' ? p2Color : p1Color;

      const rivalScreenX = state.rival.x - cameraGlobalX + 100;
      if (state.rival.y >= groundY) {
        drawTombstone(ctx, rivalScreenX, groundY, true);
      } else {
        const rivalVel = state.rival.y - state.lastRivalY;
        state.lastRivalY = state.rival.y;
        drawBird(ctx, rivalScreenX, state.rival.y, rivalColor, rivalVel, true, state.rival.alive, time);
      }

      const localScreenX = state.local.x - cameraGlobalX + 100;
      if (state.local.y >= groundY) {
        drawTombstone(ctx, localScreenX, groundY, false);
      } else {
        drawBird(ctx, localScreenX, state.local.y, localColor, state.local.vel, false, state.local.alive, time);
      }
    };

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [playerRole, generatePipe, broadcastPayload, triggerDeathSync]);

  return (
    <div className="w-full max-w-[420px] aspect-[9/16] relative bg-black shadow-2xl overflow-hidden touch-none" onTouchStart={handleFlap} onMouseDown={handleFlap}>
      
      {/* 👑 TOP HUD WITH STATS & HIGH SCORE */}
      <div className="absolute top-0 w-full p-4 flex justify-between z-10 font-black pointer-events-none shadow-[inset_0_70px_70px_rgba(0,0,0,0.6)]">
        
        {/* Player 1 HUD */}
        <div className="flex flex-col items-start z-10">
          <div className={`text-lg sm:text-xl drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)] ${playerRole === 'p1' ? 'text-red-400' : 'text-blue-400'}`}>
            {p1Name}: {p1Score}
          </div>
          <div className="text-[10px] text-yellow-400 tracking-widest uppercase drop-shadow-md bg-black/40 px-2 py-1 rounded-md mt-1 border border-yellow-400/30">
            WINS: {matchWins.p1}
          </div>
        </div>

        {/* Local Session High Score */}
        {highScore.score > 0 && (
          <div className="absolute w-full left-0 top-3 flex flex-col items-center justify-start pointer-events-none">
            <span className="text-[10px] text-yellow-400 tracking-widest uppercase drop-shadow-[0_2px_4px_rgba(0,0,0,1)] bg-black/40 px-2 rounded-full border border-yellow-400/50 mb-1">
              👑 High Score
            </span>
            <span className="text-xl text-white drop-shadow-[0_2px_4px_rgba(0,0,0,1)]">
              {highScore.score} <span className="text-xs text-slate-300 ml-1">({highScore.names.join(' & ')})</span>
            </span>
          </div>
        )}

        {/* Player 2 HUD */}
        <div className="flex flex-col items-end z-10">
          <div className={`text-lg sm:text-xl drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)] ${playerRole === 'p2' ? 'text-blue-400' : 'text-red-400'}`}>
            {p2Score} :{p2Name}
          </div>
          <div className="text-[10px] text-yellow-400 tracking-widest uppercase drop-shadow-md bg-black/40 px-2 py-1 rounded-md mt-1 border border-yellow-400/30">
            WINS: {matchWins.p2}
          </div>
        </div>
      </div>
      
      <canvas ref={canvasRef} width={420} height={746} className="w-full h-full object-cover" />
      
      {/* GLOBAL LEADERBOARD OVERLAY */}
      {isLeaderboardOpen && (
        <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center p-6 z-50 pointer-events-auto backdrop-blur-md">
          <div className="bg-slate-900 border border-indigo-500/30 p-6 rounded-3xl w-full max-w-sm shadow-[0_0_50px_rgba(79,70,229,0.2)]">
            <h2 className="text-3xl font-black text-white text-center uppercase tracking-widest mb-6">
              Global <span className="text-indigo-400">Top 10</span>
            </h2>
            
            <div className="flex flex-col gap-2 mb-6 max-h-[300px] overflow-y-auto">
              {globalLeaderboard.length === 0 ? (
                <div className="text-slate-500 text-center font-bold italic py-4">No scores yet. Be the first!</div>
              ) : (
                globalLeaderboard.map((entry, index) => {
                  let rankStyle = "bg-slate-950/50 border-slate-800 text-slate-300";
                  let crown = "";
                  
                  if (index === 0) { rankStyle = "bg-yellow-500/10 border-yellow-500/50 text-yellow-400 shadow-[0_0_15px_rgba(234,179,8,0.2)]"; crown = "👑"; }
                  else if (index === 1) { rankStyle = "bg-slate-300/10 border-slate-300/50 text-slate-200"; }
                  else if (index === 2) { rankStyle = "bg-amber-700/10 border-amber-700/50 text-amber-500"; }

                  return (
                    <div key={entry.id || index} className={`flex justify-between items-center p-3 rounded-xl border ${rankStyle}`}>
                      <div className="flex items-center gap-3 font-bold">
                        <span className="w-6 text-center opacity-50">#{index + 1}</span>
                        <span className="truncate max-w-[120px]">{entry.name} {crown}</span>
                      </div>
                      <span className="font-black text-xl">{entry.score}</span>
                    </div>
                  );
                })
              )}
            </div>

            <button onClick={() => setIsLeaderboardOpen(false)} className="w-full bg-slate-800 hover:bg-slate-700 text-white font-bold py-3 rounded-xl transition-all">
              Close Leaderboard
            </button>
          </div>
        </div>
      )}

      {/* Game Over / Waiting Overlay */}
      {(gameState === 'WAITING' || showGameOverUI) && !isLeaderboardOpen && (
        <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-6 text-center z-20 pointer-events-auto backdrop-blur-sm transition-opacity duration-500">
          {gameState === 'WAITING' ? (
            <div className="text-white font-black text-2xl animate-pulse tracking-widest">SYNCING HOST...</div>
          ) : (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full shadow-2xl transform scale-100 animate-in zoom-in-95">
              
              <h2 className="text-4xl font-black text-white mb-6 uppercase tracking-widest">Match Over</h2>
              
              <div className="flex justify-between text-xl font-bold mb-3 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <span className="text-slate-400">{p1Name}</span>
                <span className="text-white">{p1Score}</span>
              </div>
              
              <div className="flex justify-between text-xl font-bold mb-6 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <span className="text-slate-400">{p2Name}</span>
                <span className="text-white">{p2Score}</span>
              </div>

              <div className="text-2xl font-black mb-6 uppercase tracking-widest drop-shadow-lg">
                {p1Score === p2Score 
                  ? <span className="text-slate-300">DRAW!</span> 
                  : p1Score > p2Score 
                    ? <span className="text-emerald-400">{p1Name} WINS!</span> 
                    : <span className="text-emerald-400">{p2Name} WINS!</span>}
              </div>

              <div className="flex flex-col gap-3">
                <button onClick={triggerRematch} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xl py-4 rounded-xl transition-transform active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.4)]">
                  Instant Rematch
                </button>
                <button onClick={() => { fetchGlobalLeaderboard(); setIsLeaderboardOpen(true); }} className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-bold text-lg py-3 rounded-xl transition-transform active:scale-95 flex items-center justify-center gap-2">
                  🏆 Global Leaderboard
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}