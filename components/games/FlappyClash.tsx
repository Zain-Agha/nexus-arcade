'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { generateGameAnnounce } from '@/lib/groq';
import { Shield, Target, Play, RotateCcw, Volume2, Award, Zap, Flame, Wind, Sparkles, Heart, Crown } from 'lucide-react';

interface GameProps {
  roomCode?: string;
  playerRole?: 'p1' | 'p2';
  p1Name?: string;
  p2Name?: string;
}

interface BirdState {
  y: number;
  velocity: number;
  alive: boolean;
  score: number;
  flapFrame: number;
  lastFlap: number;
}

interface Pipe {
  x: number;
  gapY: number;
  passed: boolean;
}

interface Cloud {
  x: number;
  y: number;
  speed: number;
  size: number;
}

interface Tombstone {
  x: number;
  y: number;
  rotation: number;
}

interface ScorePopup {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

// Seeded PRNG (mulberry32) — host generates seed, both clients share
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CANVAS_W = 480;
const CANVAS_H = 640;
const GROUND_H = 80;
const GRAVITY = 0.35;
const FLAP_LIFT = -6.5;
const PIPE_GAP = 160;
const PIPE_WIDTH = 70;
const PIPE_SPACING = 240;
const PIPE_SPEED = 2.4;
const BIRD_RADIUS_VISUAL = 18;
const BIRD_HITBOX = 12;
const BIRD_X = 120;
const SYNC_FPS = 30;

export default function FlappyClash({
  roomCode: propRoomCode,
  playerRole: propPlayerRole,
  p1Name = 'Player 1',
  p2Name = 'Player 2',
}: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastSyncRef = useRef<number>(0);
  const pipesRef = useRef<Pipe[]>([]);
  const cloudsRef = useRef<Cloud[]>([]);
  const tombstonesRef = useRef<Tombstone[]>([]);
  const popupsRef = useRef<ScorePopup[]>([]);
  const rngRef = useRef<() => number>(() => 0.5);
  const seedRef = useRef<number>(Math.floor(Math.random() * 1e9));
  const lastSpawnXRef = useRef<number>(CANVAS_W + 100);
  const frameRef = useRef<number>(0);
  const gameStateRef = useRef<'menu' | 'playing' | 'gameover'>('menu');
  const localBirdRef = useRef<BirdState>({ y: CANVAS_H / 2, velocity: 0, alive: true, score: 0, flapFrame: 0, lastFlap: 0 });
  const remoteBirdRef = useRef<BirdState>({ y: CANVAS_H / 2, velocity: 0, alive: true, score: 0, flapFrame: 0, lastFlap: 0 });
  const remoteLastUpdateRef = useRef<number>(Date.now());
  const remoteTargetYRef = useRef<number>(CANVAS_H / 2);
  const mutedRef = useRef<boolean>(false);

  const [roomCode, setRoomCode] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(true);
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'gameover'>('menu');
  const [localScore, setLocalScore] = useState<number>(0);
  const [remoteScore, setRemoteScore] = useState<number>(0);
  const [localAlive, setLocalAlive] = useState<boolean>(true);
  const [remoteAlive, setRemoteAlive] = useState<boolean>(true);
  const [muted, setMuted] = useState<boolean>(false);
  const [announcer, setAnnouncer] = useState<string>('Ready your wings, rival birds are approaching!');
  const [winner, setWinner] = useState<'p1' | 'p2' | 'tie' | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [opponentJoined, setOpponentJoined] = useState<boolean>(false);
  const [seed, setSeed] = useState<number>(seedRef.current);

  const myName = isHost ? p1Name : p2Name;
  const oppName = isHost ? p2Name : p1Name;

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // ---- AUDIO (Web Audio API SFX) ----
  function ensureAudio() {
    if (typeof window === 'undefined') return null;
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (e) {
        audioCtxRef.current = null;
      }
    }
    return audioCtxRef.current;
  }

  function playTone(freq: number, duration: number, type: OscillatorType, vol: number, slideTo?: number) {
    if (mutedRef.current) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(0.01, slideTo), ctx.currentTime + duration);
    }
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }

  function sfxFlap() {
    playTone(540, 0.12, 'triangle', 0.18, 720);
  }

  function sfxPoint() {
    playTone(880, 0.08, 'square', 0.14);
    setTimeout(() => playTone(1320, 0.12, 'square', 0.14), 70);
  }

  function sfxCrash() {
    playTone(180, 0.18, 'sawtooth', 0.25, 60);
    setTimeout(() => playTone(120, 0.22, 'sawtooth', 0.22, 40), 80);
  }

  function sfxVictory() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => setTimeout(() => playTone(n, 0.22, 'triangle', 0.2), i * 130));
  }

  // ---- ANNOUNCER ----
  async function announce(event: string) {
    try {
      const text = await generateGameAnnounce('Flappy Clash', event);
      if (text && typeof text === 'string') setAnnouncer(text);
    } catch (e) {
      // silent fail
    }
  }

  // ---- GAME INIT HELPERS ----
  function resetGame(newSeed: number) {
    seedRef.current = newSeed;
    setSeed(newSeed);
    rngRef.current = mulberry32(newSeed);
    pipesRef.current = [];
    cloudsRef.current = [];
    tombstonesRef.current = [];
    popupsRef.current = [];
    lastSpawnXRef.current = CANVAS_W + 80;
    frameRef.current = 0;

    for (let i = 0; i < 5; i++) {
      cloudsRef.current.push({
        x: Math.random() * CANVAS_W,
        y: 40 + Math.random() * 180,
        speed: 0.2 + Math.random() * 0.4,
        size: 30 + Math.random() * 35,
      });
    }

    const rng = rngRef.current;
    for (let i = 0; i < 4; i++) {
      const x = CANVAS_W + 120 + i * PIPE_SPACING;
      const gapY = 130 + rng() * (CANVAS_H - GROUND_H - PIPE_GAP - 180);
      pipesRef.current.push({ x, gapY, passed: false });
      lastSpawnXRef.current = x;
    }

    localBirdRef.current = { y: CANVAS_H / 2, velocity: 0, alive: true, score: 0, flapFrame: 0, lastFlap: 0 };
    remoteBirdRef.current = { y: CANVAS_H / 2, velocity: 0, alive: true, score: 0, flapFrame: 0, lastFlap: 0 };
    remoteTargetYRef.current = CANVAS_H / 2;

    setLocalScore(0);
    setRemoteScore(0);
    setLocalAlive(true);
    setRemoteAlive(true);
    setWinner(null);
  }

  function spawnPipeIfNeeded() {
    const lastPipe = pipesRef.current[pipesRef.current.length - 1];
    if (!lastPipe) {
      const x = CANVAS_W + 100;
      const gapY = 130 + rngRef.current() * (CANVAS_H - GROUND_H - PIPE_GAP - 180);
      pipesRef.current.push({ x, gapY, passed: false });
      lastSpawnXRef.current = x;
      return;
    }
    if (lastPipe.x < CANVAS_W - PIPE_SPACING) {
      const x = lastPipe.x + PIPE_SPACING;
      const gapY = 130 + rngRef.current() * (CANVAS_H - GROUND_H - PIPE_GAP - 180);
      pipesRef.current.push({ x, gapY, passed: false });
      lastSpawnXRef.current = x;
    }
  }

  const flap = useCallback(() => {
    if (gameStateRef.current !== 'playing') return;
    if (!localBirdRef.current.alive) return;
    localBirdRef.current.velocity = FLAP_LIFT;
    localBirdRef.current.flapFrame = (localBirdRef.current.flapFrame + 1) % 4;
    localBirdRef.current.lastFlap = Date.now();
    sfxFlap();
  }, []);

  function checkBothDead() {
    const lb = localBirdRef.current;
    const rb = remoteBirdRef.current;
    if (!lb.alive && !rb.alive) {
      if (gameStateRef.current !== 'gameover') {
        let w: 'p1' | 'p2' | 'tie' = 'tie';
        if (lb.score > rb.score) w = isHost ? 'p1' : 'p2';
        else if (rb.score > lb.score) w = isHost ? 'p2' : 'p1';
        setWinner(w);
        gameStateRef.current = 'gameover';
        setGameState('gameover');
        sfxVictory();
        announce(w === 'tie' ? "It's a tie! Equally matched flappers!" : `${w === 'p1' ? p1Name : p2Name} wins the clash!`);
      }
    } else {
      setTimeout(() => {
        if (gameStateRef.current === 'playing' && !localBirdRef.current.alive && remoteBirdRef.current.alive) {
          if (Date.now() - remoteLastUpdateRef.current > 4000) {
            remoteBirdRef.current.alive = false;
            setRemoteAlive(false);
            checkBothDead();
          }
        }
      }, 4500);
    }
  }

  // ---- CHANNEL SETUP (BULLETPROOF BROADCAST) ----
  async function setupChannel(code: string, host: boolean) {
    if (channelRef.current) {
      try {
        await supabase.removeChannel(channelRef.current);
      } catch (e) {}
      channelRef.current = null;
    }

    const channelName = `flappy_clash_${code}`;
    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false, ack: false } },
    });

    channel
      .on('broadcast', { event: 'JOIN_EVENT' }, () => {
        setOpponentJoined(true);
        setConnected(true);
        if (host) {
          channel.send({ type: 'broadcast', event: 'SYNC_SEED', payload: { seed: seedRef.current } });
        }
      })
      .on('broadcast', { event: 'SYNC_SEED' }, (msg: any) => {
        const d = msg.payload;
        if (d && typeof d.seed === 'number' && d.seed !== seedRef.current) {
          resetGame(d.seed);
        }
      })
      .on('broadcast', { event: 'SYNC_BIRD' }, (msg: any) => {
        const d = msg.payload;
        if (!d) return;
        remoteBirdRef.current.y = d.y ?? remoteBirdRef.current.y;
        remoteTargetYRef.current = d.y ?? remoteTargetYRef.current;
        remoteBirdRef.current.velocity = d.v ?? remoteBirdRef.current.velocity;
        remoteBirdRef.current.alive = d.alive !== undefined ? d.alive : remoteBirdRef.current.alive;
        remoteBirdRef.current.score = d.score ?? remoteBirdRef.current.score;
        remoteBirdRef.current.flapFrame = d.flapFrame ?? remoteBirdRef.current.flapFrame;
        remoteLastUpdateRef.current = Date.now();
        setRemoteScore(remoteBirdRef.current.score);
        setRemoteAlive(remoteBirdRef.current.alive);
      })
      .on('broadcast', { event: 'REMATCH' }, (msg: any) => {
        const d = msg.payload;
        if (d && typeof d.seed === 'number') {
          resetGame(d.seed);
          gameStateRef.current = 'playing';
          setGameState('playing');
          announce('Instant rematch begins! Same pipes, fresh feathers!');
        }
      })
      .on('broadcast', { event: 'START' }, () => {
        gameStateRef.current = 'playing';
        setGameState('playing');
        announce('Both birds are airborne! Flap for your life!');
      })
      .on('broadcast', { event: 'GAME_OVER' }, (msg: any) => {
        const d = msg.payload;
        if (d) {
          if (d.score !== undefined) setRemoteScore(d.score);
          if (d.alive !== undefined) setRemoteAlive(d.alive);
          if (d.alive !== undefined) remoteBirdRef.current.alive = d.alive;
          if (d.score !== undefined) remoteBirdRef.current.score = d.score;
          checkBothDead();
        }
      });

    channelRef.current = channel;

    try {
      await channel.subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          setConnected(true);
          if (!host) {
            channel.send({ type: 'broadcast', event: 'JOIN_EVENT', payload: {} });
          }
        }
      });
    } catch (e) {}
  }

  function broadcastBird() {
    if (!channelRef.current || !connected) return;
    const b = localBirdRef.current;
    channelRef.current.send({
      type: 'broadcast',
      event: 'SYNC_BIRD',
      payload: {
        y: Math.round(b.y * 100) / 100,
        v: Math.round(b.velocity * 100) / 100,
        alive: b.alive,
        score: b.score,
        flapFrame: b.flapFrame,
      },
    });
  }

  function broadcastStart() {
    if (!channelRef.current) return;
    channelRef.current.send({ type: 'broadcast', event: 'START', payload: { t: Date.now() } });
  }

  function broadcastGameOver() {
    if (!channelRef.current) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'GAME_OVER',
      payload: { score: localBirdRef.current.score, alive: localBirdRef.current.alive },
    });
  }

  // ---- MOUNT EFFECT: Props auto-join ----
  useEffect(() => {
    if (propRoomCode && propPlayerRole) {
      setRoomCode(propRoomCode);
      const host = propPlayerRole === 'p1';
      setIsHost(host);
      const newSeed = Math.floor(Math.random() * 1e9);
      resetGame(newSeed);
      setupChannel(propRoomCode, host);
      gameStateRef.current = 'playing';
      setGameState('playing');
      if (host) {
        setTimeout(() => broadcastStart(), 800);
      }
      announce('Live multiplayer match starting!');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propRoomCode, propPlayerRole]);

  // Keyboard listener
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        flap();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [flap]);

  // ---- GAME LOOP ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function update() {
      frameRef.current++;

      const now = Date.now();
      if (now - lastSyncRef.current > 1000 / SYNC_FPS) {
        lastSyncRef.current = now;
        broadcastBird();
      }

      for (const c of cloudsRef.current) {
        c.x -= c.speed;
        if (c.x < -c.size * 2) {
          c.x = CANVAS_W + c.size;
          c.y = 40 + Math.random() * 180;
        }
      }

      if (gameStateRef.current === 'playing') {
        const lb = localBirdRef.current;
        if (lb.alive) {
          lb.velocity += GRAVITY;
          lb.y += lb.velocity;
          if (lb.y < 20) {
            lb.y = 20;
            lb.velocity = 0;
          }
          if (lb.y > CANVAS_H - GROUND_H - BIRD_RADIUS_VISUAL) {
            lb.y = CANVAS_H - GROUND_H - BIRD_RADIUS_VISUAL;
            lb.alive = false;
            sfxCrash();
            tombstonesRef.current.push({ x: BIRD_X, y: lb.y, rotation: 0 });
            announce(`Bird crashed into the ground after ${lb.score} pipes!`);
            broadcastGameOver();
            checkBothDead();
          }
        } else {
          if (lb.y < CANVAS_H - GROUND_H - BIRD_RADIUS_VISUAL) {
            lb.velocity += GRAVITY * 1.4;
            lb.y += lb.velocity;
          }
        }

        const rb = remoteBirdRef.current;
        if (rb.alive) {
          rb.y += (remoteTargetYRef.current - rb.y) * 0.4;
        } else {
          if (rb.y < CANVAS_H - GROUND_H - BIRD_RADIUS_VISUAL) {
            rb.velocity += GRAVITY * 1.2;
            rb.y += rb.velocity;
          }
        }

        for (const p of pipesRef.current) {
          p.x -= PIPE_SPEED;
          if (lb.alive) {
            const inX = BIRD_X + BIRD_HITBOX > p.x && BIRD_X - BIRD_HITBOX < p.x + PIPE_WIDTH;
            const topHit = lb.y - BIRD_HITBOX < p.gapY;
            const bottomHit = lb.y + BIRD_HITBOX > p.gapY + PIPE_GAP;
            if (inX && (topHit || bottomHit)) {
              lb.alive = false;
              sfxCrash();
              tombstonesRef.current.push({ x: BIRD_X, y: lb.y, rotation: 0 });
              announce(`Smashed into a pipe! ${lb.score} pipes cleared.`);
              broadcastGameOver();
              checkBothDead();
            }
          }
          if (!p.passed && p.x + PIPE_WIDTH < BIRD_X && lb.alive) {
            p.passed = true;
            lb.score += 1;
            setLocalScore(lb.score);
            sfxPoint();
            popupsRef.current.push({
              x: BIRD_X,
              y: lb.y - 30,
              text: '+1',
              life: 40,
              color: '#fde047',
            });
            if (lb.score === 5) announce('Five pipes down! Wings of fury!');
            else if (lb.score === 10) announce('Ten pipes cleared! Aerial mastery!');
            else if (lb.score === 20) announce('Twenty pipes! Unstoppable flap machine!');
            broadcastBird();
          }
        }
        pipesRef.current = pipesRef.current.filter((p) => p.x + PIPE_WIDTH > -10);
        spawnPipeIfNeeded();

        for (const t of tombstonesRef.current) {
          t.rotation = Math.sin(frameRef.current * 0.05) * 0.08;
        }

        for (const pp of popupsRef.current) {
          pp.y -= 1.2;
          pp.life -= 1;
        }
        popupsRef.current = popupsRef.current.filter((p) => p.life > 0);
      }

      if(ctx) draw(ctx);
      animationRef.current = requestAnimationFrame(update);
    }

    function draw(ctx: CanvasRenderingContext2D) {
      const grd = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
      grd.addColorStop(0, '#38bdf8');
      grd.addColorStop(0.5, '#7dd3fc');
      grd.addColorStop(1, '#bae6fd');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      ctx.fillStyle = '#fef08a';
      ctx.beginPath(); ctx.arc(CANVAS_W - 70, 80, 38, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#facc15';
      ctx.beginPath(); ctx.arc(CANVAS_W - 70, 80, 28, 0, Math.PI * 2); ctx.fill();

      for (const c of cloudsRef.current) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.size * 0.55, 0, Math.PI * 2);
        ctx.arc(c.x + c.size * 0.5, c.y + 4, c.size * 0.45, 0, Math.PI * 2);
        ctx.arc(c.x - c.size * 0.5, c.y + 4, c.size * 0.4, 0, Math.PI * 2);
        ctx.arc(c.x + c.size * 0.2, c.y - c.size * 0.3, c.size * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = '#86efac';
      ctx.beginPath();
      ctx.moveTo(0, CANVAS_H - GROUND_H);
      for (let x = 0; x <= CANVAS_W; x += 40) {
        ctx.lineTo(x, CANVAS_H - GROUND_H - 30 - Math.sin(x * 0.02 + frameRef.current * 0.005) * 18);
      }
      ctx.lineTo(CANVAS_W, CANVAS_H - GROUND_H);
      ctx.closePath();
      ctx.fill();

      for (const p of pipesRef.current) {
        drawPipe(ctx, p);
      }

      ctx.fillStyle = '#22c55e';
      ctx.fillRect(0, CANVAS_H - GROUND_H, CANVAS_W, GROUND_H);
      ctx.fillStyle = '#15803d';
      ctx.fillRect(0, CANVAS_H - GROUND_H, CANVAS_W, 10);
      ctx.fillStyle = '#166534';
      const offset = (frameRef.current * PIPE_SPEED) % 40;
      for (let x = -40; x < CANVAS_W; x += 40) {
        ctx.fillRect(x - offset, CANVAS_H - GROUND_H + 20, 20, 6);
      }

      for (const t of tombstonesRef.current) {
        drawTombstone(ctx, t.x, t.y, t.rotation);
      }

      // Remote Ghost Bird
      drawBird(ctx, BIRD_X, remoteBirdRef.current.y, remoteBirdRef.current.flapFrame, isHost ? '#22c55e' : '#ef4444', 0.5, false, remoteBirdRef.current.alive);

      // Local Solid Bird
      drawBird(ctx, BIRD_X, localBirdRef.current.y, localBirdRef.current.flapFrame, isHost ? '#ef4444' : '#22c55e', 1, true, localBirdRef.current.alive);

      for (const pp of popupsRef.current) {
        ctx.globalAlpha = Math.min(1, pp.life / 40);
        ctx.fillStyle = pp.color;
        ctx.font = 'bold 22px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(pp.text, pp.x, pp.y);
        ctx.globalAlpha = 1;
      }

      if (gameStateRef.current === 'playing') {
        ctx.font = 'bold 48px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillText(String(localBirdRef.current.score), CANVAS_W / 2 + 3, 70 + 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(localBirdRef.current.score), CANVAS_W / 2, 70);

        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillText(`${oppName.toUpperCase()}: ${remoteBirdRef.current.score}`, CANVAS_W / 2, 95);
      }
    }

    function drawPipe(ctx: CanvasRenderingContext2D, p: Pipe) {
      const topH = p.gapY;
      const bottomY = p.gapY + PIPE_GAP;
      const bottomH = CANVAS_H - GROUND_H - bottomY;

      const pipeGrad = ctx.createLinearGradient(p.x, 0, p.x + PIPE_WIDTH, 0);
      pipeGrad.addColorStop(0, '#16a34a');
      pipeGrad.addColorStop(0.3, '#22c55e');
      pipeGrad.addColorStop(0.6, '#4ade80');
      pipeGrad.addColorStop(1, '#15803d');

      ctx.fillStyle = pipeGrad;
      ctx.fillRect(p.x, 0, PIPE_WIDTH, topH);
      ctx.fillStyle = '#86efac';
      ctx.fillRect(p.x + 4, 0, 6, topH);
      ctx.fillStyle = '#166534';
      ctx.fillRect(p.x - 4, topH - 24, PIPE_WIDTH + 8, 24);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(p.x - 4, topH - 24, PIPE_WIDTH + 8, 6);
      ctx.fillStyle = '#86efac';
      ctx.fillRect(p.x - 4, topH - 24, 6, 24);

      ctx.fillStyle = pipeGrad;
      ctx.fillRect(p.x, bottomY, PIPE_WIDTH, bottomH);
      ctx.fillStyle = '#166534';
      ctx.fillRect(p.x - 4, bottomY, PIPE_WIDTH + 8, 24);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(p.x - 4, bottomY, PIPE_WIDTH + 8, 6);
      ctx.fillStyle = '#86efac';
      ctx.fillRect(p.x - 4, bottomY, 6, 24);
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(p.x + 6, bottomY + 24, 4, bottomH - 24);
    }

    function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, flapFrame: number, color: string, alpha: number, isLocal: boolean, alive: boolean) {
      ctx.save();
      ctx.globalAlpha = alpha;
      const wingOffsets = [0, -4, 0, 3];
      const wingY = wingOffsets[flapFrame % 4];

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, BIRD_RADIUS_VISUAL, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.arc(x - 4, y + 6, 10, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = alive ? color : '#666';
      ctx.beginPath();
      ctx.ellipse(x - 4, y + wingY, 12, 8, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(x - 4, y + wingY, 12, 8, -0.3, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + 8, y - 4, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(x + 10, y - 4, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x + 11, y - 5, 1, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(x + 14, y - 2);
      ctx.lineTo(x + 26, y + 2);
      ctx.lineTo(x + 14, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#c2410c';
      ctx.beginPath();
      ctx.moveTo(x + 14, y + 2);
      ctx.lineTo(x + 26, y + 2);
      ctx.lineTo(x + 14, y + 4);
      ctx.closePath();
      ctx.fill();

      if (isLocal) {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, BIRD_RADIUS_VISUAL + 1, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (!alive) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 5, y - 6);
        ctx.lineTo(x + 11, y - 2);
        ctx.moveTo(x + 11, y - 6);
        ctx.lineTo(x + 5, y - 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawTombstone(ctx: CanvasRenderingContext2D, x: number, y: number, rotation: number) {
      ctx.save();
      ctx.translate(x, y + 22);
      ctx.rotate(rotation);
      ctx.fillStyle = '#6b7280';
      ctx.beginPath();
      ctx.moveTo(-14, 8);
      ctx.lineTo(-14, -8);
      ctx.arc(0, -8, 14, Math.PI, 0);
      ctx.lineTo(14, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(-10, -4, 20, 4);
      ctx.fillStyle = '#4b5563';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('RIP', 0, 4);
      ctx.restore();
    }

    animationRef.current = requestAnimationFrame(update);

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isHost, muted]);

  useEffect(() => {
    if (connected && isHost && opponentJoined && gameState === 'playing') {
      channelRef.current?.send({ type: 'broadcast', event: 'SYNC_SEED', payload: { seed: seedRef.current } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponentJoined, connected]);

  async function handleStartSolo() {
    const newSeed = Math.floor(Math.random() * 1e9);
    resetGame(newSeed);
    setRoomCode('SOLO');
    setIsHost(true);
    gameStateRef.current = 'playing';
    setGameState('playing');
    announce('Solo flight mode! Practice your flaps!');
  }

  async function handleCreateRoom() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomCode(code);
    setIsHost(true);
    const newSeed = Math.floor(Math.random() * 1e9);
    resetGame(newSeed);
    await setupChannel(code, true);
    gameStateRef.current = 'playing';
    setGameState('playing');
    setTimeout(() => broadcastStart(), 1000);
    announce('Room created! Waiting for rival bird...');
  }

  async function handleJoinRoom(codeInput: string) {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    setRoomCode(code);
    setIsHost(false);
    resetGame(Math.floor(Math.random() * 1e9));
    await setupChannel(code, false);
    gameStateRef.current = 'playing';
    setGameState('playing');
    announce('Joined the clash! Awaiting host pipes...');
  }

  function handleRematch() {
    const newSeed = Math.floor(Math.random() * 1e9);
    resetGame(newSeed);
    gameStateRef.current = 'playing';
    setGameState('playing');
    if (channelRef.current) {
      channelRef.current.send({ type: 'broadcast', event: 'REMATCH', payload: { seed: newSeed } });
      channelRef.current.send({ type: 'broadcast', event: 'START', payload: { t: Date.now() } });
    }
    announce('Instant rematch! Fresh pipes, same rivals!');
  }

  function toggleMute() {
    setMuted((m) => !m);
  }

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-col items-center gap-4 p-4">
      {/* HUD */}
      <div className="w-full flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-400/40 flex items-center gap-2">
            <Flame className="w-4 h-4 text-red-400" />
            <span className="text-sm font-mono text-red-200">
              {myName.toUpperCase()}: {localScore}
            </span>
            {!localAlive && <span className="text-xs text-red-300">(CRASHED)</span>}
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-400/40 flex items-center gap-2">
            <Shield className="w-4 h-4 text-green-400" />
            <span className="text-sm font-mono text-green-200">
              {oppName.toUpperCase()}: {remoteScore}
            </span>
            {!remoteAlive && <span className="text-xs text-green-300">(CRASHED)</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {roomCode && (
            <div className="px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-400/40 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-300" />
              <span className="text-xs font-mono text-indigo-200">ROOM: {roomCode}</span>
              {connected ? <span className="text-xs text-green-400">●</span> : <span className="text-xs text-red-400">○</span>}
            </div>
          )}
          <button
            onClick={toggleMute}
            className="px-3 py-1.5 rounded-lg bg-slate-700/60 border border-slate-600/60 hover:bg-slate-600/60 transition flex items-center gap-1"
          >
            <Volume2 className={`w-4 h-4 ${muted ? 'text-slate-500' : 'text-cyan-300'}`} />
            <span className="text-xs text-slate-300">{muted ? 'OFF' : 'ON'}</span>
          </button>
        </div>
      </div>

      {/* Canvas + overlays */}
      <div className="relative w-full max-w-[420px] aspect-[9/16] rounded-2xl overflow-hidden border-4 border-slate-700 shadow-2xl shadow-cyan-500/20 bg-sky-300">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="w-full h-full block cursor-pointer touch-none"
          onMouseDown={flap}
          onTouchStart={(e) => { e.preventDefault(); flap(); }}
        />

        {/* Menu Overlay */}
        {gameState === 'menu' && (
          <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-sm flex flex-col items-center justify-center gap-5 p-6 text-center">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-8 h-8 text-yellow-400" />
              <h1 className="text-4xl font-black text-white tracking-tight">FLAPPY CLASH</h1>
              <Wind className="w-7 h-7 text-cyan-300" />
            </div>
            <p className="text-sm text-slate-300 max-w-xs">
              Real-time multiplayer ghost-race flappy arena. Floaty physics, same pipes, highest score wins!
            </p>
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <button
                onClick={handleCreateRoom}
                className="px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/30 transition"
              >
                <Play className="w-5 h-5" /> Create Room
              </button>
              <JoinRoomForm onJoin={handleJoinRoom} />
              <button
                onClick={handleStartSolo}
                className="px-5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium flex items-center justify-center gap-2 transition"
              >
                <Target className="w-4 h-4" /> Solo Practice
              </button>
            </div>
            <div className="text-[10px] text-slate-400 mt-2">SPACE / UP / TAP to flap</div>
          </div>
        )}

        {/* Waiting overlay */}
        {gameState === 'playing' && !opponentJoined && roomCode !== 'SOLO' && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-900/80 px-3 py-1.5 rounded-full text-xs text-amber-200 border border-amber-500/40 flex items-center gap-2">
            <Heart className="w-3 h-3 animate-pulse text-amber-400" />
            Waiting for rival bird to join...
          </div>
        )}

        {/* Game Over Overlay */}
        {gameState === 'gameover' && (
          <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-sm flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Crown className={`w-12 h-12 ${winner === (isHost ? 'p1' : 'p2') ? 'text-yellow-400' : winner === 'tie' ? 'text-slate-300' : 'text-slate-500'}`} />
            <h2 className="text-3xl font-black text-white">
              {winner === 'tie' ? "IT'S A TIE!" : winner === (isHost ? 'p1' : 'p2') ? `${myName.toUpperCase()} WINS!` : `${oppName.toUpperCase()} WINS!`}
            </h2>
            <div className="flex gap-6 text-sm font-mono">
              <div className="flex flex-col items-center">
                <span className="text-red-300 text-xs">{myName.toUpperCase()}</span>
                <span className="text-2xl font-bold text-white">{localScore}</span>
              </div>
              <div className="w-px bg-slate-600" />
              <div className="flex flex-col items-center">
                <span className="text-green-300 text-xs">{oppName.toUpperCase()}</span>
                <span className="text-2xl font-bold text-white">{remoteScore}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <button
                onClick={handleRematch}
                className="px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500 text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/30 transition"
              >
                <RotateCcw className="w-5 h-5" /> Instant Rematch
              </button>
              <button
                onClick={() => {
                  gameStateRef.current = 'menu';
                  setGameState('menu');
                }}
                className="px-5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium flex items-center justify-center gap-2 transition"
              >
                <Award className="w-4 h-4" /> Back to Menu
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Announcer */}
      <div className="w-full max-w-[420px] px-4 py-3 rounded-xl bg-slate-800/80 border border-cyan-500/30 flex items-start gap-3">
        <div className="mt-0.5">
          <Sparkles className="w-4 h-4 text-cyan-400 animate-pulse" />
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-wider text-cyan-400 font-bold mb-0.5">AI Announcer</div>
          <div className="text-sm text-slate-200 leading-snug">{announcer}</div>
        </div>
      </div>

      {/* Controls hint */}
      <div className="flex items-center gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-slate-700 border border-slate-600">SPACE</kbd> Flap</span>
        <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-slate-700 border border-slate-600">↑</kbd> Flap</span>
        <span className="flex items-center gap-1"><Target className="w-3 h-3" /> Tap canvas</span>
        <span className="flex items-center gap-1"><Wind className="w-3 h-3" /> Floaty physics</span>
      </div>
    </div>
  );
}

// ---- Sub-component: Join Room Form ----
function JoinRoomForm({ onJoin }: { onJoin: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
        placeholder="ROOM CODE"
        className="flex-1 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-600 text-white text-sm font-mono uppercase placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
      />
      <button
        onClick={() => onJoin(code)}
        disabled={code.length < 4}
        className="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-bold transition flex items-center gap-1"
      >
        <Shield className="w-4 h-4" /> Join
      </button>
    </div>
  );
}