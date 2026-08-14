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
const CW = 320; // Main Canvas Width (Optimized for Mobile scaling)
const CH = 500; // Main Canvas Height
const RW = 120; // Rival Canvas Width
const RH = 240; // Rival Canvas Height

const INITIAL_BW = 140; // Initial Block Width
const BH = 36;          // Block Height

interface Block { x: number; y: number; w: number; h: number; colorHue: number; seed: number; }
interface Debris { x: number; y: number; w: number; h: number; vY: number; vX: number; colorHue: number; seed: number; }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; }
interface Popup { text: string; x: number; y: number; life: number; color: string; }

export default function TowerStack({ playerRole, p1Name, p2Name, broadcastPayload, subscribePayload }: GameProps) {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const rivalCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // UI State
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
      alive: true, score: 0, tower: [] as Block[],
      active: { x: CW/2, y: 0, w: INITIAL_BW, state: 'swinging', vY: 0, colorHue: 200, seed: 0 },
      cameraY: 0, targetCameraY: 0, combo: 0
    },
    rival: {
      alive: true, score: 0, tower: [] as Block[], cameraY: 0
    },
    debris: [] as Debris[],
    particles: [] as Particle[],
    popups: [] as Popup[],
    lastSyncTime: 0
  });

  const createBaseBlock = () => ({ x: CW/2, y: CH - BH, w: INITIAL_BW, h: BH, colorHue: 200, seed: Math.random() });

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
    l.active = { x: CW/2, y: l.targetCameraY - 250, w: INITIAL_BW, state: 'swinging', vY: 0, colorHue: Math.floor(Math.random()*360), seed: Math.random() };
    
    // Reset Rival
    const r = stateRef.current.rival;
    r.alive = true; r.score = 0;
    r.tower = [createBaseBlock()];
    r.cameraY = CH - 150;
    
    stateRef.current.debris = [];
    stateRef.current.particles = [];
    stateRef.current.popups = [];
    
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
        
        // Exact Minimap Sync using the sliced width!
        if (data.score > st.rival.score) {
          const prevBlock = st.rival.tower[st.rival.tower.length - 1] || createBaseBlock();
          st.rival.tower.push({
            x: data.lastX, y: prevBlock.y - BH, w: data.lastW, h: BH, colorHue: data.colorHue || 200, seed: data.seed || Math.random()
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
      l.active.vY = 4; // Fast initial drop
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
        
        l.cameraY += (l.targetCameraY - l.cameraY) * 0.1;

        if (l.active.state === 'swinging') {
          // Speed increases as score goes up
          const speedMultiplier = 1 + (l.score * 0.08);
          const angle = Math.sin(time * 0.003 * Math.min(speedMultiplier, 3.5));
          l.active.x = CW/2 + (angle * (CW/2.5));
          l.active.y = l.cameraY - 180;
        } 
        else if (l.active.state === 'falling') {
          l.active.vY += 1.0; // Gravity
          l.active.y += l.active.vY;

          const topBlock = l.tower[l.tower.length - 1];

          // Collision Check
          if (l.active.y + BH >= topBlock.y) {
            l.active.y = topBlock.y - BH; // Snap to top
            
            // --- THE STACKER SLICE MECHANIC ---
            const activeLeft = l.active.x - l.active.w / 2;
            const activeRight = l.active.x + l.active.w / 2;
            const topLeft = topBlock.x - topBlock.w / 2;
            const topRight = topBlock.x + topBlock.w / 2;

            const overlapLeft = Math.max(activeLeft, topLeft);
            const overlapRight = Math.min(activeRight, topRight);
            const newWidth = overlapRight - overlapLeft;

            // Difference from absolute center of the previous block
            const diffCenter = Math.abs(l.active.x - topBlock.x);

            if (newWidth <= 0) {
              // Complete Miss!
              l.alive = false;
              playTone(100, 'sawtooth', 0.5, 40);
              st.popups.push({ text: 'FELL!', x: l.active.x, y: l.active.y, life: 1.0, color: '#ef4444' });
              broadcastPayload('SYNC_TOWER', { role: playerRole, alive: false, score: l.score, lastX: l.active.x, lastW: l.active.w });
              checkGameOver();
            } else {
              // Landed Successfully! Calculate slice.
              let finalWidth = newWidth;
              let finalX = overlapLeft + newWidth / 2;

              if (diffCenter < 6) {
                // Perfect Placement (Forgiving margin)
                finalWidth = topBlock.w;
                finalX = topBlock.x;
                l.combo++;
                playTone(800 + (Math.min(l.combo, 5) * 100), 'square', 0.2);
                spawnExplosion(finalX, l.active.y + BH, '#facc15', 20);
                st.popups.push({ text: 'PERFECT!', x: finalX, y: l.active.y, life: 1.0, color: '#facc15' });
              } else {
                // Slice the overhang off
                l.combo = 0;
                playTone(250, 'square', 0.15, 100); // Thud sound
                
                // Spawn Debris for the left slice
                if (activeLeft < topLeft) {
                  const sliceW = topLeft - activeLeft;
                  st.debris.push({
                    x: activeLeft + sliceW / 2, y: l.active.y, w: sliceW, h: BH,
                    vY: 0, vX: -2, colorHue: l.active.colorHue, seed: l.active.seed
                  });
                }
                // Spawn Debris for the right slice
                if (activeRight > topRight) {
                  const sliceW = activeRight - topRight;
                  st.debris.push({
                    x: topRight + sliceW / 2, y: l.active.y, w: sliceW, h: BH,
                    vY: 0, vX: 2, colorHue: l.active.colorHue, seed: l.active.seed
                  });
                }
                
                spawnExplosion(finalX, l.active.y + BH, '#cbd5e1', 5);
              }

              // Add sliced block to tower
              l.tower.push({
                x: finalX, y: l.active.y, w: finalWidth, h: BH, colorHue: l.active.colorHue, seed: l.active.seed
              });
              
              l.score += 1;
              if (playerRole === 'p1') setP1Score(l.score); else setP2Score(l.score);

              // Prep next block with the new sliced width
              l.targetCameraY = l.active.y;
              l.active = { 
                x: CW/2, y: l.targetCameraY - 200, w: finalWidth, state: 'swinging', vY: 0, 
                colorHue: (l.active.colorHue + 45) % 360, seed: Math.random() 
              };

              // Broadcast exact placed block parameters
              broadcastPayload('SYNC_TOWER', { 
                role: playerRole, alive: true, score: l.score, 
                lastX: finalX, lastW: finalWidth, colorHue: l.active.colorHue, seed: l.active.seed 
              });
            }
          }
        }
      }

      // Physics Updates for Debris
      st.debris.forEach(d => {
        d.vY += 0.5; // Gravity
        d.y += d.vY;
        d.x += d.vX;
      });
      // Cleanup fallen debris
      st.debris = st.debris.filter(d => d.y < l.cameraY + CH);

      // VFX Updates
      st.particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.life -= 0.02; });
      st.particles = st.particles.filter(p => p.life > 0);
      st.popups.forEach(p => { p.y -= 1; p.life -= 0.02; });
      st.popups = st.popups.filter(p => p.life > 0);

      // -----------------------------------------------------
      // RENDER HELPERS
      // -----------------------------------------------------
      const drawBlock = (ctx: CanvasRenderingContext2D, b: {x: number, y: number, w: number, h: number, colorHue: number, seed: number}) => {
        ctx.fillStyle = `hsl(${b.colorHue}, 70%, 40%)`;
        ctx.fillRect(b.x - b.w/2, b.y, b.w, b.h);
        
        ctx.fillStyle = `hsl(${b.colorHue}, 70%, 60%)`;
        ctx.fillRect(b.x - b.w/2, b.y, b.w, 4); // Top highlight

        ctx.fillStyle = `hsl(${b.colorHue}, 70%, 25%)`;
        ctx.fillRect(b.x + b.w/2 - 6, b.y, 6, b.h); // Right shadow

        // Procedural Windows
        ctx.fillStyle = '#fde047';
        // Only draw windows if block is wide enough
        const winCols = Math.floor(b.w / 26);
        const startX = b.x - b.w/2 + (b.w - (winCols * 26)) / 2; // Center windows

        for(let i=0; i<winCols; i++) {
          for(let j=0; j<2; j++) {
            if ((Math.sin(b.seed * 1000 + i*10 + j) * 1000) % 1 > 0.5) {
              ctx.fillRect(startX + (i * 26), b.y + 8 + (j * 14), 12, 8);
            } else {
              ctx.fillStyle = `hsl(${b.colorHue}, 70%, 20%)`;
              ctx.fillRect(startX + (i * 26), b.y + 8 + (j * 14), 12, 8);
              ctx.fillStyle = '#fde047';
            }
          }
        }
      };

      const drawSky = (ctx: CanvasRenderingContext2D, camY: number, width: number, height: number) => {
        const altitude = Math.max(0, 464 - camY);
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        if (altitude < 1000) {
          grad.addColorStop(0, '#38bdf8');
          grad.addColorStop(1, '#bae6fd'); 
        } else if (altitude < 3000) {
          const ratio = (altitude - 1000) / 2000;
          grad.addColorStop(0, `#${Math.floor(56 - ratio*50).toString(16).padStart(2,'0')}bdf8`);
          grad.addColorStop(1, '#6366f1');
        } else {
          grad.addColorStop(0, '#0f172a');
          grad.addColorStop(1, '#312e81'); 
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        if (altitude > 2000) {
          ctx.fillStyle = '#fff';
          for(let i=0; i<20; i++) {
            const sx = (Math.sin(i*123) * 10000) % width;
            const sy = (Math.cos(i*321) * 10000) % height;
            const size = (Math.sin(time*0.005 + i) + 1) * 1.5;
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

      // Ground
      mCtx.fillStyle = '#4ade80';
      mCtx.fillRect(-1000, CH - BH, 2000, 1000);

      // Tower
      l.tower.forEach(b => drawBlock(mCtx, b));

      // Debris
      st.debris.forEach(d => drawBlock(mCtx, d));

      // Crane & Active
      if (l.alive) {
        mCtx.strokeStyle = '#94a3b8';
        mCtx.lineWidth = 2;
        mCtx.beginPath();
        mCtx.moveTo(CW/2, l.cameraY - 400); 
        mCtx.lineTo(l.active.x, l.active.y);
        mCtx.stroke();
        
        // FIX: Add h: BH to the l.active object to satisfy the TS signature for drawBlock
        drawBlock(mCtx, { ...l.active, h: BH });
      }

      // VFX
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
      
      if (r.tower.length > 0) {
        const topRivalY = r.tower[r.tower.length - 1].y;
        r.cameraY += (topRivalY - r.cameraY) * 0.1;
      }
      
      drawSky(rCtx, r.cameraY, RW, RH);

      const scale = RW / CW; 
      rCtx.scale(scale, scale);
      rCtx.translate(0, -r.cameraY + (RH/scale)/2 + 100);

      rCtx.fillStyle = '#4ade80';
      rCtx.fillRect(-1000, CH - BH, 2000, 1000);

      r.tower.forEach(b => drawBlock(rCtx, b));

      if (!r.alive) {
        rCtx.setTransform(1,0,0,1,0,0);
        rCtx.fillStyle = 'rgba(239, 68, 68, 0.4)';
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
    <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-start sm:justify-center p-2 sm:p-4 touch-none select-none relative" onTouchStart={handleDrop} onMouseDown={handleDrop}>
      
      {/* 👑 TOP HUD (Font Size Reduced for Mobile Elegance) */}
      <div className="w-full max-w-md flex justify-between items-start mb-4 px-2 z-10 font-black relative mt-2 sm:mt-0">
        
        {/* Player 1 HUD */}
        <div className="flex flex-col items-start z-10">
          <div className={`text-base sm:text-lg drop-shadow-md ${playerRole === 'p1' ? 'text-red-400' : 'text-blue-400'}`}>
            {p1Name}: {p1Score}
          </div>
          <div className="text-[9px] text-yellow-400 tracking-widest uppercase bg-slate-900/80 px-2 py-1 rounded-md mt-1 border border-yellow-400/30">
            WINS: {matchWins.p1}
          </div>
        </div>

        {/* High Score Center Crown */}
        {highScore.score > 0 && (
          <div className="absolute w-full left-0 top-0 flex flex-col items-center justify-start pointer-events-none">
            <span className="text-[9px] text-yellow-400 tracking-widest uppercase bg-slate-900/80 px-2 rounded-full border border-yellow-400/50 mb-1 drop-shadow-md">
              👑 High Score
            </span>
            <span className="text-sm sm:text-base text-white drop-shadow-md">
              {highScore.score} <span className="text-[9px] text-slate-300 ml-1">({highScore.names.join(' & ')})</span>
            </span>
          </div>
        )}

        {/* Player 2 HUD */}
        <div className="flex flex-col items-end z-10">
          <div className={`text-base sm:text-lg drop-shadow-md ${playerRole === 'p2' ? 'text-blue-400' : 'text-red-400'}`}>
            {p2Score} :{p2Name}
          </div>
          <div className="text-[9px] text-yellow-400 tracking-widest uppercase bg-slate-900/80 px-2 py-1 rounded-md mt-1 border border-yellow-400/30">
            WINS: {matchWins.p2}
          </div>
        </div>
      </div>

      {/* Main Gameplay Layout */}
      <div className="flex gap-3 items-center justify-center w-full max-w-md pointer-events-none px-2">
        
        {/* Local Main Player Canvas (Strict Aspect Ratio for cross-device consistency) */}
        <div className="relative border-4 border-slate-800 rounded-xl overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.8)] flex-1 max-w-[320px] aspect-[320/500] bg-black">
          <canvas ref={mainCanvasRef} width={CW} height={CH} className="w-full h-full object-contain" />
          <div className="absolute bottom-4 w-full text-center text-slate-400/50 font-black text-xl sm:text-2xl uppercase tracking-widest pointer-events-none">
            TAP TO DROP
          </div>
        </div>

        {/* Rival Minimap Canvas */}
        <div className="flex flex-col items-center gap-2 w-[100px] sm:w-[120px]">
          <span className={`text-[10px] font-black uppercase tracking-widest ${playerRole === 'p1' ? 'text-blue-400' : 'text-red-400'}`}>
            RIVAL
          </span>
          <div className="border-4 border-slate-800 rounded-xl overflow-hidden shadow-xl bg-black w-full aspect-[120/240]">
            <canvas ref={rivalCanvasRef} width={RW} height={RH} className="w-full h-full object-contain" />
          </div>
        </div>
      </div>
      
      {/* Game Over / Waiting Overlay */}
      {(gameState === 'WAITING' || showGameOverUI) && (
        <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-4 text-center z-20 pointer-events-auto backdrop-blur-sm transition-opacity duration-500">
          {gameState === 'WAITING' ? (
            <div className="text-white font-black text-xl sm:text-2xl animate-pulse tracking-widest">SYNCING HOST...</div>
          ) : (
            <div className="bg-slate-900 border-2 border-slate-700 p-6 sm:p-8 rounded-3xl w-full max-w-[320px] shadow-2xl transform scale-100 animate-in zoom-in-95">
              
              {/* Added break-words to ensure text never overflows on Android */}
              <h2 className="text-2xl sm:text-3xl font-black text-white mb-6 uppercase tracking-widest break-words">
                Match Over
              </h2>
              
              <div className="flex justify-between items-center text-lg sm:text-xl font-bold mb-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-400 truncate max-w-[120px]">{p1Name}</span>
                <span className="text-white whitespace-nowrap">{p1Score} Blk</span>
              </div>
              
              <div className="flex justify-between items-center text-lg sm:text-xl font-bold mb-6 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-400 truncate max-w-[120px]">{p2Name}</span>
                <span className="text-white whitespace-nowrap">{p2Score} Blk</span>
              </div>

              <div className="text-xl sm:text-2xl font-black mb-6 uppercase tracking-widest drop-shadow-lg">
                {p1Score === p2Score 
                  ? <span className="text-slate-300">DRAW!</span> 
                  : p1Score > p2Score 
                    ? <span className="text-emerald-400 truncate block max-w-full">{p1Name} WINS!</span> 
                    : <span className="text-emerald-400 truncate block max-w-full">{p2Name} WINS!</span>}
              </div>

              <button onClick={() => broadcastPayload('REMATCH_TOWER', {})} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-lg sm:text-xl py-4 rounded-xl transition-transform active:scale-95 shadow-[0_0_20px_rgba(79,70,229,0.4)]">
                Instant Rematch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}