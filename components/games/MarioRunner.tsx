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
// AUDIO SYNTHESIS
// ------------------------------------------------------------------
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
// GAME CONSTANTS
// ------------------------------------------------------------------
const CW = 400; // Canvas Width
const CH = 600; // Canvas Height
const PW = 80;  // Paddle Width
const PH = 12;  // Paddle Height
const BR = 8;   // Ball Radius
const WIN_SCORE = 5;

interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; }
interface Trail { x: number; y: number; age: number; }

export default function MarioRunner({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // UI State
  const [gameState, setGameState] = useState<'WAITING' | 'PLAYING' | 'SCORE' | 'GAMEOVER'>('WAITING');
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [resultMsg, setResultMsg] = useState('');

  // 60FPS Mutable Physics State (Bypasses React Render Cycle entirely)
  const stateRef = useRef({
    status: 'WAITING',
    ball: { x: CW/2, y: CH/2, vx: 0, vy: 0, speed: 6, isSmash: false },
    p1: { x: CW/2, lastX: CW/2 }, // Bottom Paddle (Host)
    p2: { x: CW/2, lastX: CW/2 }, // Top Paddle (Guest)
    p1Score: 0,
    p2Score: 0,
    msg: '',
    particles: [] as Particle[],
    trail: [] as Trail[],
    shake: 0,
  });

  // Generate Particle Explosion
  const spawnExplosion = useCallback((x: number, y: number, color: string, count = 15) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      stateRef.current.particles.push({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 1.0, color
      });
    }
  }, []);

  const resetRound = useCallback((serverDirection: 1 | -1) => {
    stateRef.current.ball = { 
      x: CW/2, y: CH/2, 
      vx: (Math.random() > 0.5 ? 2 : -2), 
      vy: 6 * serverDirection, 
      speed: 6, isSmash: false 
    };
    stateRef.current.trail = [];
  }, []);

  // ------------------------------------------------------------------
  // NETWORK SYNC LOGIC (True Server-Client Architecture - THROTTLED)
  // ------------------------------------------------------------------
  useEffect(() => {
    // 1. Throttled Sync Loop (15 FPS = 66ms) - Prevents WebSocket Flooding!
    const syncInterval = setInterval(() => {
      const st = stateRef.current;
      if (playerRole === 'p1') {
        broadcastPayload('HOST_SYNC', {
          b: st.ball, p1x: st.p1.x, s1: st.p1Score, s2: st.p2Score, st: st.status, msg: st.msg
        });
      } else {
        broadcastPayload('GUEST_SYNC', { p2x: st.p2.x });
      }
    }, 66);

    // 2. Guest blindly accepts and applies Host's game truth
    const unsubHostSync = subscribePayload('HOST_SYNC', (data) => {
      if (playerRole === 'p2') {
        const st = stateRef.current;
        
        // Deep copy ball to prevent mutation errors during guest interpolation
        st.ball = { ...data.b }; 
        st.p1.x = data.p1x;
        
        // Handle Visual State Transitions
        if (data.st === 'SCORE' && st.status === 'PLAYING') {
            spawnExplosion(data.b.x, data.b.y, '#facc15', 30);
            st.shake = 15;
            playTone(150, 'sawtooth', 0.5, 50);
        }
        if (data.st === 'GAMEOVER' && st.status !== 'GAMEOVER') {
            const didIWin = data.msg === 'P2 WINS!';
            playTone(didIWin ? 600 : 200, 'square', 1.0, 1200);
            setResultMsg(didIWin ? 'YOU WIN!' : 'DEFEATED!');
        }

        // Apply Hard State
        st.p1Score = data.s1;
        st.p2Score = data.s2;
        st.status = data.st;
        st.msg = data.msg;

        // Safely Sync React UI (Only if changed, prevents infinite render freezing)
        setGameState(prev => prev !== data.st ? data.st : prev);
        setP1Score(prev => prev !== data.s1 ? data.s1 : prev);
        setP2Score(prev => prev !== data.s2 ? data.s2 : prev);
      }
    });

    // 3. Host receives Guest's paddle X
    const unsubGuestSync = subscribePayload('GUEST_SYNC', (data) => {
      if (playerRole === 'p1') {
        stateRef.current.p2.x = data.p2x;
      }
    });

    // 4. Rematch (Either player can trigger)
    const unsubRematch = subscribePayload('REMATCH', () => {
      const st = stateRef.current;
      st.p1Score = 0; st.p2Score = 0;
      setP1Score(0); setP2Score(0);
      st.status = 'PLAYING';
      setGameState('PLAYING');
      if (playerRole === 'p1') resetRound(1);
    });

    // Host Auto-Start on Mount
    if (playerRole === 'p1') {
      setTimeout(() => {
        stateRef.current.status = 'PLAYING';
        setGameState('PLAYING');
        resetRound(1);
      }, 1000);
    }

    return () => { 
      clearInterval(syncInterval); 
      unsubHostSync(); unsubGuestSync(); unsubRematch();
    };
  }, [playerRole, broadcastPayload, subscribePayload, resetRound, spawnExplosion]);

  // Input Handling (1:1 Touch Tracking - LOCAL ONLY, NO NETWORK CALLS)
  const handlePointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (stateRef.current.status !== 'PLAYING') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = CW / rect.width;
    let x = (e.clientX - rect.left) * scaleX;
    
    // CRITICAL: Mirror X-axis for Player 2 so they can play locally exactly like P1
    if (playerRole === 'p2') x = CW - x;

    // Clamp to screen boundaries
    x = Math.max(PW/2, Math.min(CW - PW/2, x));

    // Update local state ONLY (Network loop picks this up every 66ms)
    if (playerRole === 'p1') {
      stateRef.current.p1.x = x;
    } else {
      stateRef.current.p2.x = x;
    }
  };

  // Main Render & Physics Engine (60 FPS)
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let animationId: number;

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const st = stateRef.current;
      const b = st.ball;

      // Calculate Paddle Velocities for Smash Mechanics
      const p1Vel = st.p1.x - st.p1.lastX; st.p1.lastX = st.p1.x;
      const p2Vel = st.p2.x - st.p2.lastX; st.p2.lastX = st.p2.x;

      // ---------------------------------------------------------
      // PHYSICS (Host Only - Absolute Authority)
      // ---------------------------------------------------------
      if (playerRole === 'p1' && st.status === 'PLAYING') {
        b.x += b.vx;
        b.y += b.vy;

        // Wall Bounces
        if (b.x <= BR || b.x >= CW - BR) {
          b.vx *= -1;
          b.x = b.x <= BR ? BR : CW - BR;
          playTone(400, 'sine', 0.05);
        }

        // P1 (Bottom) Paddle Hit
        if (b.vy > 0 && b.y + BR >= CH - 40 && b.y - BR <= CH - 40 + PH) {
          if (Math.abs(b.x - st.p1.x) < PW/2 + BR) {
            b.vy *= -1;
            b.y = CH - 40 - BR;
            
            // Smash Mechanic
            if (Math.abs(p1Vel) > 3) {
              b.vx += (p1Vel * 0.15); // Add English/Curve
              b.speed = Math.min(14, b.speed + 1.5); // Speed Boost
              b.isSmash = true;
              playTone(800, 'square', 0.1);
              st.shake = 5;
            } else {
              b.speed = Math.min(12, b.speed + 0.2); // Normal speedup
              b.isSmash = false;
              playTone(600, 'sine', 0.1);
            }
            
            const mag = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
            b.vx = (b.vx / mag) * b.speed;
            b.vy = (b.vy / mag) * b.speed;
          }
        }

        // P2 (Top) Paddle Hit
        if (b.vy < 0 && b.y - BR <= 40 + PH && b.y + BR >= 40) {
          if (Math.abs(b.x - st.p2.x) < PW/2 + BR) {
            b.vy *= -1;
            b.y = 40 + PH + BR;
            
            if (Math.abs(p2Vel) > 3) {
              b.vx += (p2Vel * 0.15);
              b.speed = Math.min(14, b.speed + 1.5);
              b.isSmash = true;
              playTone(800, 'square', 0.1);
              st.shake = 5;
            } else {
              b.speed = Math.min(12, b.speed + 0.2);
              b.isSmash = false;
              playTone(600, 'sine', 0.1);
            }
            
            const mag = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
            b.vx = (b.vx / mag) * b.speed;
            b.vy = (b.vy / mag) * b.speed;
          }
        }

        // Scoring Trigger
        if (b.y < 0) triggerScore('p1', b.x, 10);
        else if (b.y > CH) triggerScore('p2', b.x, CH - 10);
      }

      // Guest Interpolation (Predicts movement between 66ms packets for buttery smooth 60fps)
      if (playerRole === 'p2' && st.status === 'PLAYING') {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x <= BR || b.x >= CW - BR) b.vx *= -1; // Local wall bounce predictive
      }

      // Record Trail for both
      if (st.status === 'PLAYING') {
        st.trail.unshift({ x: b.x, y: b.y, age: 1.0 });
        if (st.trail.length > 20) st.trail.pop();
      }

      // ---------------------------------------------------------
      // RENDER (Mirrored flawlessly so everyone plays Bottom-Up!)
      // ---------------------------------------------------------
      const mapX = (x: number) => playerRole === 'p2' ? CW - x : x;
      const mapY = (y: number) => playerRole === 'p2' ? CH - y : y;

      ctx.save();
      ctx.fillStyle = '#020617'; // Deep space background
      ctx.fillRect(0, 0, CW, CH);

      if (st.shake > 0) {
        ctx.translate((Math.random()-0.5)*st.shake, (Math.random()-0.5)*st.shake);
        st.shake *= 0.8;
        if (st.shake < 0.5) st.shake = 0;
      }

      // Midline Center Grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 4;
      ctx.setLineDash([15, 15]);
      ctx.beginPath(); ctx.moveTo(0, CH/2); ctx.lineTo(CW, CH/2); ctx.stroke();
      ctx.setLineDash([]);

      const localColor = '#06b6d4'; // Cyan
      const rivalColor = '#ec4899'; // Pink
      
      const drawPaddle = (x: number, y: number, color: string) => {
        ctx.shadowColor = color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x - PW/2, y, PW, PH, 6);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(x - PW/2 + 4, y + 2, PW - 8, PH - 4, 3);
        ctx.fill();
      };

      // Draw Paddles correctly flipped based on role
      if (playerRole === 'p1') {
        drawPaddle(mapX(st.p1.x), mapY(CH - 40), localColor);
        drawPaddle(mapX(st.p2.x), mapY(40), rivalColor);
      } else {
        drawPaddle(mapX(st.p2.x), mapY(40), localColor);
        drawPaddle(mapX(st.p1.x), mapY(CH - 40), rivalColor);
      }

      // Draw Ball Trail
      st.trail.forEach((t) => {
        t.age -= 0.05;
        if (t.age > 0) {
          ctx.beginPath();
          ctx.arc(mapX(t.x), mapY(t.y), BR * t.age, 0, Math.PI*2);
          ctx.fillStyle = b.isSmash 
            ? `rgba(239, 68, 68, ${t.age})`
            : `rgba(255, 255, 255, ${t.age * 0.5})`;
          ctx.fill();
        }
      });
      st.trail = st.trail.filter(t => t.age > 0);

      // Draw Ball
      if (st.status === 'PLAYING') {
        const ballColor = b.isSmash ? '#ef4444' : '#ffffff';
        ctx.shadowColor = ballColor;
        ctx.shadowBlur = b.isSmash ? 20 : 10;
        ctx.fillStyle = ballColor;
        ctx.beginPath();
        ctx.arc(mapX(b.x), mapY(b.y), BR, 0, Math.PI*2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Particles
      st.particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.life -= 0.02;
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.beginPath(); ctx.arc(mapX(p.x), mapY(p.y), 3 * p.life, 0, Math.PI*2); ctx.fill();
      });
      ctx.globalAlpha = 1.0;
      st.particles = st.particles.filter(p => p.life > 0);

      ctx.restore();
    };

    // Internal Scoring Logic (Only runs on Host)
    const triggerScore = (winner: 'p1'|'p2', x: number, y: number) => {
      const st = stateRef.current;
      st.status = 'SCORE';
      setGameState('SCORE');
      
      if (winner === 'p1') st.p1Score += 1; else st.p2Score += 1;
      setP1Score(st.p1Score); setP2Score(st.p2Score);
      
      spawnExplosion(x, y, '#facc15', 30);
      st.shake = 15;
      playTone(150, 'sawtooth', 0.5, 50);
      
      setTimeout(() => {
        if (st.p1Score >= WIN_SCORE || st.p2Score >= WIN_SCORE) {
          st.status = 'GAMEOVER';
          setGameState('GAMEOVER');
          const winMsg = st.p1Score >= WIN_SCORE ? 'P1 WINS!' : 'P2 WINS!';
          st.msg = winMsg;
          setResultMsg(winMsg === 'P1 WINS!' ? 'YOU WIN!' : 'DEFEATED!');
          playTone(600, 'square', 1.0, 1200);
        } else {
          st.status = 'PLAYING';
          setGameState('PLAYING');
          resetRound(winner === 'p1' ? -1 : 1);
        }
      }, 2000);
    };

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [playerRole, broadcastPayload, spawnExplosion, resetRound]);

  return (
    <div className="w-full h-full bg-black flex flex-col items-center justify-center relative touch-none select-none overflow-hidden">
      
      {/* Dynamic HUD */}
      <div className="absolute top-8 w-full max-w-[400px] flex justify-between px-6 z-10 pointer-events-none drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
        <div className={`flex flex-col items-start ${playerRole === 'p1' ? 'text-pink-400' : 'text-cyan-400'}`}>
          <span className="text-xs font-bold uppercase tracking-widest text-slate-300">RIVAL</span>
          <span className="text-4xl font-black">{playerRole === 'p1' ? p2Score : p1Score}</span>
        </div>
        <div className={`flex flex-col items-end ${playerRole === 'p1' ? 'text-cyan-400' : 'text-pink-400'}`}>
          <span className="text-xs font-bold uppercase tracking-widest text-slate-300">YOU</span>
          <span className="text-4xl font-black">{playerRole === 'p1' ? p1Score : p2Score}</span>
        </div>
      </div>

      {/* Main Gameplay Canvas - 1:1 Touch Surface */}
      <canvas 
        ref={canvasRef} 
        width={CW} 
        height={CH} 
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        className="w-full max-w-[400px] aspect-[2/3] object-cover bg-slate-950 border-x-2 border-slate-800 shadow-2xl cursor-crosshair touch-none" 
      />

      {/* Overlays */}
      {gameState !== 'PLAYING' && (
        <div className="absolute inset-0 bg-slate-950/70 flex flex-col items-center justify-center p-6 z-20 backdrop-blur-sm transition-opacity duration-300 pointer-events-auto">
          
          {gameState === 'WAITING' && (
            <div className="text-cyan-400 font-black text-2xl animate-pulse tracking-widest drop-shadow-[0_0_15px_rgba(6,182,212,0.8)]">SYNCING ARENA...</div>
          )}

          {gameState === 'SCORE' && (
            <div className="text-yellow-400 font-black text-5xl italic tracking-widest drop-shadow-[0_0_20px_rgba(250,204,21,1)] animate-bounce pointer-events-none">GOAL!</div>
          )}

          {gameState === 'GAMEOVER' && (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full max-w-[340px] text-center shadow-2xl animate-in zoom-in-95 pointer-events-auto">
              <h2 className={`text-5xl font-black mb-8 uppercase tracking-widest drop-shadow-lg ${resultMsg === 'YOU WIN!' ? 'text-cyan-400' : 'text-rose-500'}`}>
                {resultMsg}
              </h2>
              <button 
                onClick={() => broadcastPayload('REMATCH', {})} 
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xl py-5 rounded-xl transition-transform active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.4)]"
              >
                Instant Rematch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}