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
// UTILS: Audio & Math
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
const CW = 300; // Main Canvas Width
const CH = 500; // Main Canvas Height
const RW = 120; // Rival Canvas Width
const RH = 240; // Rival Canvas Height

const BW = 120; // Block Width
const BH = 36;  // Block Height

interface Block { x: number; y: number; w: number; h: number; colorHue: number; seed: number; }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; }
interface Popup { text: string; x: number; y: number; life: number; color: string; }

export default function TowerStack({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const rivalCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // High-Level UI State
  const [gameState, setGameState] = useState<'WAITING' | 'PLAYING' | 'GAMEOVER'>('WAITING');
  const [showGameOverUI, setShowGameOverUI] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [matchWins, setMatchWins] = useState({ p1: 0, p2: 0 });
  const [highScore, setHighScore] = useState({ score: 0, names: [] as string[] });

  // Dynamic High Score Watcher
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

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 60FPS Physics Engine State
  const stateRef = useRef({
    status: 'WAITING',
    local: {
      alive: true,
      score: 0,
      tower: [] as Block[],
      active: { x: CW/2, y: 0, state: 'swinging', vY: 0, colorHue: 200, seed: 0 },
      cameraY: 0,
      targetCameraY: 0,
      combo: 0
    },
    rival: {
      alive: true,
      score: 0,
      tower: [] as Block[],
      cameraY: 0
    },
    particles: [] as Particle[],
    popups: [] as Popup[],
    lastSyncTime: 0
  });

  const createBaseBlock = () => ({ x: CW/2, y: CH - BH, w: BW, h: BH, colorHue: 200, seed: Math.random() });

  const spawnExplosion = useCallback((x: number, y: number, color: string, count = 15) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 4 + 1;
      stateRef.current.particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1.0, color
      });
    }
  }, []);

  const resetMatch = useCallback(() => {
    stateRef.current.status = 'PLAYING';
    
    // Reset Local
    const l = stateRef.current.local;
    l.alive = true; l.score = 0; l.combo = 0;
    l.tower = [createBaseBlock()];
    l.targetCameraY = CH - 150;
    l.cameraY = CH - 150;
    l.active = { x: CW/2, y: l.targetCameraY - 250, state: 'swinging', vY: 0, colorHue: Math.floor(Math.random()*360), seed: Math.random() };
    
    // Reset Rival
    const r = stateRef.current.rival;
    r.alive = true; r.score = 0;
    r.tower = [createBaseBlock()];
    r.cameraY = CH - 150;
    
    setP1Score(0); setP2Score(0);
    setGameState('PLAYING');
    setShowGameOverUI(false);
  }, []);

  // Check absolute end condition
  const checkGameOver = useCallback(() => {
    const st = stateRef.current;
    if (!st.local.alive && !st.rival.alive && st.status !== 'GAMEOVER') {
        st.status = 'GAMEOVER';
        setGameState('GAMEOVER');

        const finalP1 = playerRole === 'p1' ? st.local.score : st.rival.score;
        const finalP2 = playerRole === 'p2' ? st.local.score : st.rival.score;
        if (finalP1 > finalP2) setMatchWins(prev => ({ ...prev, p1: prev.p1 + 1 }));
        else if (finalP2 > finalP1) setMatchWins(prev => ({ ...prev, p2: prev.p2 + 1 }));

        timeoutRef.current = setTimeout(() => setShowGameOverUI(true), 1200);
    }
  }, [playerRole]);

  // Network Sync Handlers
  useEffect(() => {
    const unsubStart = subscribePayload('START_TOWER', () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      resetMatch();
    });

    const unsubSync = subscribePayload('SYNC_TOWER', (data) => {
      if (data.role !== playerRole) {
        const st = stateRef.current;
        st.rival.alive = data.alive;
        
        // If rival score increased, build their tower in our minimap
        if (data.score > st.rival.score) {
          const prevBlock = st.rival.tower[st.rival.tower.length - 1] || createBaseBlock();
          st.rival.tower.push({
            x: data.lastX, y: prevBlock.y - BH, w: BW, h: BH, colorHue: Math.floor(Math.random()*360), seed: Math.random()
          });
          st.rival.cameraY = (prevBlock.y - BH) - 100;
        }
        
        st.rival.score = data.score;
        
        if (data.role === 'p1') setP1Score(data.score);
        else setP2Score(data.score);
        
        checkGameOver();
      }
    });

    const unsubRematch = subscribePayload('REMATCH_TOWER', () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      resetMatch();
    });

    if (playerRole === 'p1') {
      setTimeout(() => broadcastPayload('START_TOWER', {}), 1000);
    }

    return () => { unsubStart(); unsubSync(); unsubRematch(); };
  }, [playerRole, broadcastPayload, subscribePayload, resetMatch, checkGameOver]);

  // Interaction
  const handleDrop = (e?: React.TouchEvent | React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const l = stateRef.current.local;
    if (stateRef.current.status !== 'PLAYING' || !l.alive) return;
    
    if (l.active.state === 'swinging') {
      l.active.state = 'falling';
      l.active.vY = 2; // Initial drop velocity
      playTone(400, 'sine', 0.1);
    }
  };

  // Main Render & Physics Engine (60 FPS)
  useEffect(() => {
    const mCtx = mainCanvasRef.current?.getContext('2d');
    const rCtx = rivalCanvasRef.current?.getContext('2d');
    if (!mCtx || !rCtx) return;
    
    let animationId: number;

    const render = (time: number) => {
      animationId = requestAnimationFrame(render);
      const st = stateRef.current;
      const l = st.local;

      // -----------------------------------------------------
      // PHYSICS UPDATE
      // -----------------------------------------------------
      if (st.status === 'PLAYING' && l.alive) {
        
        // Camera Follow
        l.cameraY += (l.targetCameraY - l.cameraY) * 0.1;

        if (l.active.state === 'swinging') {
          // Crane swings block horizontally based on time and height (faster as it goes up)
          const speedMultiplier = 1 + (l.score * 0.05);
          const angle = Math.sin(time * 0.002 * Math.min(speedMultiplier, 3));
          l.active.x = CW/2 + (angle * 90);
          l.active.y = l.cameraY - 180;
        } 
        else if (l.active.state === 'falling') {
          // Apply Gravity
          l.active.vY += 0.8;
          l.active.y += l.active.vY;

          const topBlock = l.tower[l.tower.length - 1];

          // Collision Check
          if (l.active.y + BH >= topBlock.y) {
            l.active.y = topBlock.y - BH; // Snap to top
            
            const diffX = Math.abs(l.active.x - topBlock.x);
            
            // Tolerance Check (If more than half the block overhangs, it falls off)
            if (diffX > BW / 1.7) {
              // Missed! Game Over
              l.alive = false;
              playTone(100, 'sawtooth', 0.5, 40);
              st.popups.push({ text: 'FELL!', x: l.active.x, y: l.active.y, life: 1.0, color: '#ef4444' });
              
              // Broadcast Death instantly
              broadcastPayload('SYNC_TOWER', { role: playerRole, alive: false, score: l.score, lastX: l.active.x });
              checkGameOver();
            } else {
              // Landed Successfully!
              let points = 1;
              if (diffX < 5) {
                // Perfect Placement
                l.active.x = topBlock.x; // Snap exact center
                l.combo++;
                points = 1 + Math.floor(l.combo / 3);
                playTone(800 + (l.combo * 100), 'square', 0.2);
                spawnExplosion(l.active.x, l.active.y + BH, '#facc15', 20);
                st.popups.push({ text: 'PERFECT!', x: l.active.x, y: l.active.y, life: 1.0, color: '#facc15' });
              } else {
                // Normal Placement
                l.combo = 0;
                playTone(300, 'square', 0.1);
                spawnExplosion(l.active.x, l.active.y + BH, '#cbd5e1', 5);
              }

              // Add to tower
              l.tower.push({
                x: l.active.x, y: l.active.y, w: BW, h: BH, colorHue: l.active.colorHue, seed: l.active.seed
              });
              
              l.score += points;
              if (playerRole === 'p1') setP1Score(l.score); else setP2Score(l.score);

              // Prep next block
              l.targetCameraY = l.active.y;
              l.active = { 
                x: CW/2, y: l.targetCameraY - 180, state: 'swinging', vY: 0, 
                colorHue: (l.active.colorHue + 40) % 360, seed: Math.random() 
              };

              // Broadcast placement
              broadcastPayload('SYNC_TOWER', { role: playerRole, alive: true, score: l.score, lastX: l.active.x });
            }
          }
        }
      }

      // VFX Updates
      st.particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.life -= 0.02; });
      st.particles = st.particles.filter(p => p.life > 0);
      st.popups.forEach(p => { p.y -= 1; p.life -= 0.02; });
      st.popups = st.popups.filter(p => p.life > 0);

      // -----------------------------------------------------
      // RENDER HELPERS
      // -----------------------------------------------------
      const drawBlock = (ctx: CanvasRenderingContext2D, b: Block) => {
        // Base structure
        ctx.fillStyle = `hsl(${b.colorHue}, 70%, 40%)`;
        ctx.fillRect(b.x - b.w/2, b.y, b.w, b.h);
        
        // 3D Highlight Top
        ctx.fillStyle = `hsl(${b.colorHue}, 70%, 60%)`;
        ctx.fillRect(b.x - b.w/2, b.y, b.w, 4);

        // 3D Shadow Right
        ctx.fillStyle = `hsl(${b.colorHue}, 70%, 25%)`;
        ctx.fillRect(b.x + b.w/2 - 6, b.y, 6, b.h);

        // Lit Windows
        ctx.fillStyle = '#fde047';
        for(let i=0; i<4; i++) {
          for(let j=0; j<2; j++) {
            // Pseudo-random deterministic window lights based on block seed
            if ((Math.sin(b.seed * 1000 + i*10 + j) * 1000) % 1 > 0.5) {
              ctx.fillRect(b.x - b.w/2 + 15 + (i * 26), b.y + 8 + (j * 14), 12, 8);
            } else {
              ctx.fillStyle = `hsl(${b.colorHue}, 70%, 20%)`; // Dark window
              ctx.fillRect(b.x - b.w/2 + 15 + (i * 26), b.y + 8 + (j * 14), 12, 8);
              ctx.fillStyle = '#fde047'; // reset for next
            }
          }
        }
      };

      const drawSky = (ctx: CanvasRenderingContext2D, camY: number, width: number, height: number) => {
        // Altitude calculation (Base Y is ~ 464, goes negative as we go up)
        const altitude = Math.max(0, 464 - camY);
        
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        if (altitude < 1000) {
          grad.addColorStop(0, '#38bdf8'); // Sky Blue
          grad.addColorStop(1, '#bae6fd'); 
        } else if (altitude < 3000) {
          const ratio = (altitude - 1000) / 2000;
          grad.addColorStop(0, `#${Math.floor(56 - ratio*50).toString(16).padStart(2,'0')}bdf8`); // Transition to dusk
          grad.addColorStop(1, '#6366f1'); // Indigo
        } else {
          grad.addColorStop(0, '#0f172a'); // Space
          grad.addColorStop(1, '#312e81'); 
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        // Stars if high enough
        if (altitude > 2000) {
          ctx.fillStyle = '#fff';
          for(let i=0; i<20; i++) {
            const sx = (Math.sin(i*123) * 10000) % width;
            const sy = (Math.cos(i*321) * 10000) % height;
            const size = (Math.sin(time*0.005 + i) + 1) * 1.5; // Twinkle
            ctx.beginPath(); ctx.arc(Math.abs(sx), Math.abs(sy), size, 0, Math.PI*2); ctx.fill();
          }
        }
      };

      // -----------------------------------------------------
      // RENDER MAIN CANVAS (LOCAL)
      // -----------------------------------------------------
      mCtx.save();
      drawSky(mCtx, l.cameraY, CW, CH);

      mCtx.translate(0, -l.cameraY + CH/2 + 100);

      // Draw Ground
      mCtx.fillStyle = '#4ade80'; // Grass
      mCtx.fillRect(0, CH - BH, CW, 1000);

      // Draw Tower
      l.tower.forEach(b => drawBlock(mCtx, b));

      // Draw Crane & Active Block (Only if alive)
      if (l.alive) {
        mCtx.strokeStyle = '#94a3b8'; // Cable
        mCtx.lineWidth = 2;
        mCtx.beginPath();
        mCtx.moveTo(CW/2, l.cameraY - 400); // Crane top anchor
        mCtx.lineTo(l.active.x, l.active.y);
        mCtx.stroke();
        
        drawBlock(mCtx, { ...l.active, w: BW, h: BH });
      }

      // Draw Particles & Popups
      st.particles.forEach(p => {
        mCtx.fillStyle = p.color;
        mCtx.globalAlpha = Math.max(0, p.life);
        mCtx.beginPath(); mCtx.arc(p.x, p.y, 4 * p.life, 0, Math.PI*2); mCtx.fill();
      });
      mCtx.globalAlpha = 1.0;

      st.popups.forEach(p => {
        mCtx.fillStyle = p.color;
        mCtx.globalAlpha = Math.max(0, p.life);
        mCtx.font = '900 24px sans-serif';
        mCtx.textAlign = 'center';
        mCtx.shadowColor = '#000'; mCtx.shadowBlur = 4;
        mCtx.fillText(p.text, p.x, p.y);
        mCtx.shadowBlur = 0;
      });
      mCtx.globalAlpha = 1.0;
      
      mCtx.restore();

      // -----------------------------------------------------
      // RENDER RIVAL CANVAS (MINIMAP)
      // -----------------------------------------------------
      const r = st.rival;
      rCtx.save();
      
      // Target camera smooth follow for rival
      if (r.tower.length > 0) {
        const topRivalY = r.tower[r.tower.length - 1].y;
        r.cameraY += (topRivalY - r.cameraY) * 0.1;
      }
      
      drawSky(rCtx, r.cameraY, RW, RH);

      // Scale down rival view to fit minimap
      const scale = RW / CW; 
      rCtx.scale(scale, scale);
      rCtx.translate(0, -r.cameraY + (RH/scale)/2 + 100);

      rCtx.fillStyle = '#4ade80';
      rCtx.fillRect(0, CH - BH, CW, 1000);

      r.tower.forEach(b => drawBlock(rCtx, b));

      if (!r.alive) {
        rCtx.setTransform(1,0,0,1,0,0);
        rCtx.fillStyle = 'rgba(239, 68, 68, 0.4)'; // Red death overlay
        rCtx.fillRect(0, 0, RW, RH);
        rCtx.fillStyle = '#fff';
        rCtx.font = '900 20px sans-serif';
        rCtx.textAlign = 'center';
        rCtx.fillText('CRASHED', RW/2, RH/2);
      }

      rCtx.restore();
    };

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [playerRole, broadcastPayload, checkGameOver, spawnExplosion]);

  return (
    <div className="w-full h-full bg-slate-950 flex flex-col items-center p-2 sm:p-4 touch-none select-none relative" onTouchStart={handleDrop} onMouseDown={handleDrop}>
      
      {/* 👑 TOP HUD WITH STATS & HIGH SCORE */}
      <div className="w-full max-w-md flex justify-between items-start mb-4 px-2 z-10 font-black relative">
        
        {/* Player 1 HUD */}
        <div className="flex flex-col items-start z-10">
          <div className={`text-2xl drop-shadow-md ${playerRole === 'p1' ? 'text-red-400' : 'text-blue-400'}`}>
            {p1Name}: {p1Score}
          </div>
          <div className="text-[10px] text-yellow-400 tracking-widest uppercase bg-slate-900/80 px-2 py-1 rounded-md mt-1 border border-yellow-400/30">
            WINS: {matchWins.p1}
          </div>
        </div>

        {/* High Score Center Crown */}
        {highScore.score > 0 && (
          <div className="absolute w-full left-0 top-0 flex flex-col items-center justify-start pointer-events-none">
            <span className="text-[10px] text-yellow-400 tracking-widest uppercase bg-slate-900/80 px-2 rounded-full border border-yellow-400/50 mb-1 drop-shadow-md">
              👑 High Score
            </span>
            <span className="text-lg text-white drop-shadow-md">
              {highScore.score} <span className="text-[10px] text-slate-300 ml-1">({highScore.names.join(' & ')})</span>
            </span>
          </div>
        )}

        {/* Player 2 HUD */}
        <div className="flex flex-col items-end z-10">
          <div className={`text-2xl drop-shadow-md ${playerRole === 'p2' ? 'text-blue-400' : 'text-red-400'}`}>
            {p2Score} :{p2Name}
          </div>
          <div className="text-[10px] text-yellow-400 tracking-widest uppercase bg-slate-900/80 px-2 py-1 rounded-md mt-1 border border-yellow-400/30">
            WINS: {matchWins.p2}
          </div>
        </div>
      </div>

      {/* Main Gameplay Layout */}
      <div className="flex gap-4 items-center justify-center w-full max-w-md pointer-events-none">
        
        {/* Local Main Player Canvas */}
        <div className="relative border-4 border-slate-800 rounded-xl overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.8)]">
          <canvas ref={mainCanvasRef} width={CW} height={CH} className="bg-black" />
          <div className="absolute bottom-4 w-full text-center text-slate-400/50 font-black text-2xl uppercase tracking-widest pointer-events-none">
            TAP TO DROP
          </div>
        </div>

        {/* Rival Minimap Canvas */}
        <div className="flex flex-col items-center gap-2">
          <span className={`text-xs font-black uppercase tracking-widest ${playerRole === 'p1' ? 'text-blue-400' : 'text-red-400'}`}>
            RIVAL TOWER
          </span>
          <div className="border-4 border-slate-800 rounded-xl overflow-hidden shadow-xl bg-black">
            <canvas ref={rivalCanvasRef} width={RW} height={RH} />
          </div>
        </div>
      </div>
      
      {/* Game Over / Waiting Overlay */}
      {(gameState === 'WAITING' || showGameOverUI) && (
        <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-6 text-center z-20 pointer-events-auto backdrop-blur-sm transition-opacity duration-500">
          {gameState === 'WAITING' ? (
            <div className="text-white font-black text-2xl animate-pulse tracking-widest">SYNCING HOST...</div>
          ) : (
            <div className="bg-slate-900 border-2 border-slate-700 p-8 rounded-3xl w-full max-w-sm shadow-2xl transform scale-100 animate-in zoom-in-95">
              
              <h2 className="text-4xl font-black text-white mb-6 uppercase tracking-widest">Construction Over</h2>
              
              <div className="flex justify-between text-2xl font-bold mb-3 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <span className="text-slate-400">{p1Name}</span>
                <span className="text-white">{p1Score} Blocks</span>
              </div>
              
              <div className="flex justify-between text-2xl font-bold mb-6 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <span className="text-slate-400">{p2Name}</span>
                <span className="text-white">{p2Score} Blocks</span>
              </div>

              <div className="text-2xl font-black mb-8 uppercase tracking-widest drop-shadow-lg">
                {p1Score === p2Score 
                  ? <span className="text-slate-300">DRAW!</span> 
                  : p1Score > p2Score 
                    ? <span className="text-emerald-400">{p1Name} WINS!</span> 
                    : <span className="text-emerald-400">{p2Name} WINS!</span>}
              </div>

              <button onClick={() => broadcastPayload('REMATCH_TOWER', {})} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xl py-5 rounded-xl transition-transform active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.4)]">
                Instant Rematch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}