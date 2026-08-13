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

  // 60FPS Mutable Physics State (Bypasses React Render Cycle)
  const state = useRef({
    status: 'WAITING',
    ball: { x: CW/2, y: CH/2, vx: 0, vy: 0, speed: 6, isSmash: false },
    p1: { x: CW/2, lastX: CW/2 }, // Bottom Paddle (Host)
    p2: { x: CW/2, lastX: CW/2 }, // Top Paddle (Guest)
    particles: [] as Particle[],
    trail: [] as Trail[],
    shake: 0,
    lastTime: 0
  });

  // Generate Particle Explosion
  const spawnExplosion = useCallback((x: number, y: number, color: string, count = 15) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      state.current.particles.push({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 1.0, color
      });
    }
  }, []);

  // Central Hub Logic (Host acts as server for Ball physics)
  const resetRound = useCallback((serverDirection: 1 | -1) => {
    state.current.ball = { 
      x: CW/2, y: CH/2, 
      vx: (Math.random() > 0.5 ? 2 : -2), 
      vy: 6 * serverDirection, 
      speed: 6, isSmash: false 
    };
    state.current.trail = [];
  }, []);

  // Network Sync Handlers
  useEffect(() => {
    const s1 = subscribePayload('START_MATCH', () => {
      setP1Score(0); setP2Score(0);
      setGameState('PLAYING'); state.current.status = 'PLAYING';
      if (playerRole === 'p1') resetRound(1);
    });

    const s2 = subscribePayload('SYNC_BALL', (b) => {
      // Guest accepts host ball physics
      if (playerRole === 'p2') state.current.ball = b;
    });

    const s3 = subscribePayload('SYNC_PADDLE', (p) => {
      if (p.role !== playerRole) {
        if (p.role === 'p1') state.current.p1.x = p.x;
        else state.current.p2.x = p.x;
      }
    });

    const s4 = subscribePayload('SCORE_EVENT', (p) => {
      spawnExplosion(p.ballX, p.ballY, '#facc15', 30);
      state.current.shake = 15;
      playTone(150, 'sawtooth', 0.5, 50); // Explosion sound
      
      if (p.winner === 'p1') setP1Score(s => s + 1);
      else setP2Score(s => s + 1);
      
      setGameState('SCORE'); state.current.status = 'SCORE';
      
      // Serve next round
      if (playerRole === 'p1') {
        setTimeout(() => {
          if (p.newP1Score >= WIN_SCORE || p.newP2Score >= WIN_SCORE) {
            broadcastPayload('GAME_OVER', { winner: p.newP1Score >= WIN_SCORE ? 'p1' : 'p2' });
          } else {
            resetRound(p.winner === 'p1' ? -1 : 1);
            broadcastPayload('RESUME_PLAY', {});
          }
        }, 2000);
      }
    });

    const s5 = subscribePayload('RESUME_PLAY', () => {
      setGameState('PLAYING'); state.current.status = 'PLAYING';
    });

    const s6 = subscribePayload('GAME_OVER', (p) => {
      setGameState('GAMEOVER'); state.current.status = 'GAMEOVER';
      setResultMsg(p.winner === playerRole ? 'YOU WIN!' : 'DEFEATED!');
      playTone(p.winner === playerRole ? 600 : 200, 'square', 1.0, p.winner === playerRole ? 1200 : 50);
    });

    if (playerRole === 'p1') {
      setTimeout(() => broadcastPayload('START_MATCH', {}), 1000);
    }

    // Host continuously broadcasts ball state to keep Guest in sync
    const syncInterval = setInterval(() => {
      if (playerRole === 'p1' && state.current.status === 'PLAYING') {
        broadcastPayload('SYNC_BALL', state.current.ball);
      }
    }, 50);

    return () => { s1(); s2(); s3(); s4(); s5(); s6(); clearInterval(syncInterval); };
  }, [playerRole, broadcastPayload, subscribePayload, resetRound, spawnExplosion]);

  // Input Handling (1:1 Touch Tracking)
  const handlePointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (state.current.status !== 'PLAYING') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = CW / rect.width;
    let x = (e.clientX - rect.left) * scaleX;
    
    // CRITICAL: Mirror X-axis for Player 2 so they can play locally exactly like P1
    if (playerRole === 'p2') x = CW - x;

    // Clamp to screen
    x = Math.max(PW/2, Math.min(CW - PW/2, x));

    if (playerRole === 'p1') state.current.p1.x = x;
    else state.current.p2.x = x;
    
    broadcastPayload('SYNC_PADDLE', { role: playerRole, x });
  };

  // Main Render & Physics Engine (60 FPS)
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let animationId: number;

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const st = state.current;
      const b = st.ball;

      // Calculate Paddle Velocities for Smash Mechanics
      const p1Vel = st.p1.x - st.p1.lastX; st.p1.lastX = st.p1.x;
      const p2Vel = st.p2.x - st.p2.lastX; st.p2.lastX = st.p2.x;

      // ---------------------------------------------------------
      // PHYSICS (Host Only - P1 runs authority to prevent lag disputes)
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
            
            // Normalize Vector based on new speed
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

        // Scoring
        if (b.y < 0) {
          const newP1 = p1Score + 1;
          broadcastPayload('SCORE_EVENT', { winner: 'p1', ballX: b.x, ballY: 10, newP1Score: newP1, newP2Score: p2Score });
        } else if (b.y > CH) {
          const newP2 = p2Score + 1;
          broadcastPayload('SCORE_EVENT', { winner: 'p2', ballX: b.x, ballY: CH-10, newP1Score: p1Score, newP2Score: newP2 });
        }
      }

      // Guest Interpolation (Predict movement between Host syncs for smooth visuals)
      if (playerRole === 'p2' && st.status === 'PLAYING') {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x <= BR || b.x >= CW - BR) b.vx *= -1; // Local wall bounce
      }

      // Record Trail
      if (st.status === 'PLAYING') {
        st.trail.unshift({ x: b.x, y: b.y, age: 1.0 });
        if (st.trail.length > 20) st.trail.pop();
      }

      // ---------------------------------------------------------
      // RENDER (Mirrored flawlessly so everyone plays Bottom-Up!)
      // ---------------------------------------------------------
      // Map Internal Coordinates to Local Screen Coordinates
      // If you are P2, your Y=0 becomes Y=600, and your X=0 becomes X=400.
      const mapX = (x: number) => playerRole === 'p2' ? CW - x : x;
      const mapY = (y: number) => playerRole === 'p2' ? CH - y : y;

      ctx.save();
      ctx.fillStyle = '#020617'; // Deep space background
      ctx.fillRect(0, 0, CW, CH);

      // Screen Shake
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

      // Draw Paddles
      // Local Player is ALWAYS rendered at the Bottom (CH - 40)
      // Rival Player is ALWAYS rendered at the Top (40)
      const localColor = '#06b6d4'; // Cyan
      const rivalColor = '#ec4899'; // Pink
      
      const drawPaddle = (x: number, y: number, color: string) => {
        ctx.shadowColor = color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = color;
        // Draw with rounded corners
        ctx.beginPath();
        ctx.roundRect(x - PW/2, y, PW, PH, 6);
        ctx.fill();
        ctx.shadowBlur = 0; // reset
        
        // Inner core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(x - PW/2 + 4, y + 2, PW - 8, PH - 4, 3);
        ctx.fill();
      };

      if (playerRole === 'p1') {
        drawPaddle(mapX(st.p1.x), mapY(CH - 40), localColor); // P1 at bottom
        drawPaddle(mapX(st.p2.x), mapY(40), rivalColor);      // P2 at top
      } else {
        drawPaddle(mapX(st.p2.x), mapY(40), localColor);      // P2 (Local) rendered at bottom!
        drawPaddle(mapX(st.p1.x), mapY(CH - 40), rivalColor); // P1 rendered at top!
      }

      // Draw Ball Trail
      st.trail.forEach((t, i) => {
        t.age -= 0.05;
        if (t.age > 0) {
          ctx.beginPath();
          ctx.arc(mapX(t.x), mapY(t.y), BR * t.age, 0, Math.PI*2);
          ctx.fillStyle = b.isSmash 
            ? `rgba(239, 68, 68, ${t.age})` // Red Smash Trail
            : `rgba(255, 255, 255, ${t.age * 0.5})`; // Normal Trail
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

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [playerRole, p1Score, p2Score, broadcastPayload]);

  return (
    <div className="w-full h-full bg-black flex flex-col items-center justify-center relative touch-none select-none overflow-hidden">
      
      {/* Dynamic HUD */}
      <div className="absolute top-8 w-full max-w-[400px] flex justify-between px-6 z-10 pointer-events-none drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
        {/* Opponent is always displayed on the TOP physically, so their score goes on the left to indicate top */}
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
        <div className="absolute inset-0 bg-slate-950/70 flex flex-col items-center justify-center p-6 z-20 backdrop-blur-sm transition-opacity duration-300">
          
          {gameState === 'WAITING' && (
            <div className="text-cyan-400 font-black text-2xl animate-pulse tracking-widest drop-shadow-[0_0_15px_rgba(6,182,212,0.8)]">SYNCING ARENA...</div>
          )}

          {gameState === 'SCORE' && (
            <div className="text-yellow-400 font-black text-5xl italic tracking-widest drop-shadow-[0_0_20px_rgba(250,204,21,1)] animate-bounce">GOAL!</div>
          )}

          {gameState === 'GAMEOVER' && (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full max-w-[340px] text-center shadow-2xl animate-in zoom-in-95">
              <h2 className={`text-5xl font-black mb-8 uppercase tracking-widest drop-shadow-lg ${resultMsg === 'YOU WIN!' ? 'text-cyan-400' : 'text-rose-500'}`}>
                {resultMsg}
              </h2>
              <button 
                onClick={() => broadcastPayload('START_MATCH', {})} 
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