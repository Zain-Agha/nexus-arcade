'use client';

import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { generateGameAnnounce } from '@/lib/groq';
import { Shield, Target, Play, RotateCcw, Volume2, Award, Zap, Flame, Wind, Sparkles, Scissors, Bomb } from 'lucide-react';

/* ============================================================
   FruitBlade.tsx — Multiplayer Fruit Ninja Duel
   ============================================================ */

interface GameProps {
  roomCode?: string;
  playerRole?: 'p1' | 'p2';
}

type Screen = 'menu' | 'lobby' | 'game' | 'gameover';
type FruitType = 'watermelon' | 'orange' | 'apple' | 'banana' | 'strawberry' | 'pineapple';

interface Fruit {
  id: string;
  type: FruitType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rotation: number;
  spin: number;
  sliced: boolean;
}

interface HalfFruit {
  id: string;
  type: FruitType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rotation: number;
  spin: number;
  sliceAngle: number;
  life: number;
}

interface BombItem {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rotation: number;
  spin: number;
  sliced: boolean;
  drifting?: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  kind: 'juice' | 'spark' | 'smoke';
}

interface Splatter {
  x: number;
  y: number;
  color: string;
  alpha: number;
  radius: number;
  seed: number;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
  vy: number;
  color: string;
}

interface Point {
  x: number;
  y: number;
}

interface LevelConfig {
  name: string;
  spawnRate: number;
  maxFruits: number;
  bombChance: number;
  multiplier: number;
  duration: number;
}

const LEVELS: LevelConfig[] = [
  { name: 'Classic Dojo', spawnRate: 1400, maxFruits: 4, bombChance: 0.08, multiplier: 1, duration: 45000 },
  { name: 'Frenzy Garden', spawnRate: 900, maxFruits: 7, bombChance: 0.12, multiplier: 2, duration: 45000 },
  { name: 'Dragon Dojo', spawnRate: 600, maxFruits: 10, bombChance: 0.15, multiplier: 5, duration: 60000 },
];

const FRUIT_COLORS: Record<FruitType, { skin: string; pulp: string; juice: string }> = {
  watermelon: { skin: '#3a8c2a', pulp: '#e23b2e', juice: '226, 59, 46' },
  orange: { skin: '#ff8c1a', pulp: '#ffb84d', juice: '255, 140, 26' },
  apple: { skin: '#e23b2e', pulp: '#fff5e0', juice: '226, 59, 46' },
  banana: { skin: '#ffd23b', pulp: '#fffff0', juice: '255, 210, 59' },
  strawberry: { skin: '#e23b2e', pulp: '#ff7373', juice: '226, 59, 46' },
  pineapple: { skin: '#e8b31a', pulp: '#ffd23b', juice: '232, 179, 26' },
};

// Deterministic PRNG (Mulberry32) for synced spawns
const mulberry32 = (seed: number) => {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export default function FruitBlade({ roomCode: propRoomCode, playerRole: propPlayerRole }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const channelRef = useRef<any>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const mutedRef = useRef<boolean>(false);

  // Game State Refs
  const fruitsRef = useRef<Fruit[]>([]);
  const halvesRef = useRef<HalfFruit[]>([]);
  const bombsRef = useRef<BombItem[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const splattersRef = useRef<Splatter[]>([]);
  const popupsRef = useRef<Popup[]>([]);
  const localTrailRef = useRef<Point[]>([]);
  const remoteTrailRef = useRef<{ p1: Point; p2: Point; life: number }[]>([]);
  const prngRef = useRef<(() => number) | null>(null);
  const waveIndexRef = useRef<number>(0);
  const nextSpawnRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const comboCountRef = useRef<number>(0);
  const lastSliceTimeRef = useRef<number>(0);
  const screenShakeRef = useRef<number>(0);
  const flashAlphaRef = useRef<number>(0);
  const levelTimerRef = useRef<any>(null);

  // React State
  const [screen, setScreen] = useState<Screen>('menu');
  const [roomCode, setRoomCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(true);
  const [connected, setConnected] = useState<boolean>(false);
  const [scores, setScores] = useState<{ p1: number; p2: number }>({ p1: 0, p2: 0 });
  const [level, setLevel] = useState<number>(0);
  const [announcement, setAnnouncement] = useState<string>('Preparing the dojo...');
  const [winner, setWinner] = useState<null | 1 | 2>(null);
  const [muted, setMuted] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const W = 1280;
  const H = 720;

  useEffect(() => {
    if (propRoomCode) {
      setRoomCode(propRoomCode);
      const host = propPlayerRole !== 'p2';
      setIsHost(host);
      setupChannel(propRoomCode, host);
    }
  }, [propRoomCode, propPlayerRole]);

  const ensureAudio = (): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!audioRef.current) {
      try {
        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        audioRef.current = new Ctx();
      } catch {
        return null;
      }
    }
    if (audioRef.current && audioRef.current.state === 'suspended') {
      audioRef.current.resume().catch(() => {});
    }
    return audioRef.current;
  };

  const playTone = (freq: number, duration: number, type: OscillatorType = 'sine', gain = 0.15, freqEnd?: number) => {
    if (mutedRef.current) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), ctx.currentTime + duration);
    }
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  };

  const playNoise = (duration: number, gain = 0.2, filterFreq = 1000, type: BiquadFilterType = 'lowpass') => {
    if (mutedRef.current) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start();
  };

  const sfx = {
    swish: () => playNoise(0.08, 0.08, 3000, 'highpass'),
    slice: () => {
      playNoise(0.12, 0.15, 2000, 'bandpass');
      playTone(800, 0.06, 'sine', 0.1, 400);
    },
    bombSizzle: () => playNoise(0.5, 0.08, 4000, 'highpass'),
    bombBlast: () => {
      playNoise(0.6, 0.4, 500);
      playTone(80, 0.5, 'sine', 0.2, 30);
      playTone(120, 0.3, 'sawtooth', 0.15, 40);
    },
    combo: () => {
      playTone(880, 0.08, 'square', 0.12);
      setTimeout(() => playTone(1320, 0.1, 'square', 0.12), 60);
    },
    victory: () => {
      const seq = [523, 659, 784, 1047];
      seq.forEach((f, i) => setTimeout(() => playTone(f, 0.25, 'triangle', 0.15), i * 120));
    },
    defeat: () => {
      const seq = [440, 392, 329, 261];
      seq.forEach((f, i) => setTimeout(() => playTone(f, 0.3, 'sine', 0.13), i * 150));
    },
    ui: () => playTone(660, 0.06, 'square', 0.07),
  };

  const announce = async (event: string) => {
    setAnnouncement('…');
    try {
      const text = await generateGameAnnounce('Fruit Blade Battle', event);
      setAnnouncement(text || event);
    } catch {
      setAnnouncement(event);
    }
  };

  const setupChannel = (code: string, asHost: boolean) => {
    if (channelRef.current) {
      try { channelRef.current.unsubscribe(); } catch {}
      channelRef.current = null;
    }
    const ch = supabase.channel('fruit_blade_' + code, {
      config: { broadcast: { self: false } },
    });

    ch.on('broadcast', { event: 'JOIN_EVENT' }, () => {
      setConnected(true);
      if (asHost) {
        setTimeout(() => {
          const seed = Math.floor(Math.random() * 1000000);
          ch.send({ type: 'broadcast', event: 'START_GAME', payload: { seed } });
          startGame(seed);
        }, 600);
      }
    })
      .on('broadcast', { event: 'START_GAME' }, (msg: any) => {
        startGame(msg?.payload?.seed ?? Math.random() * 1000000);
      })
      .on('broadcast', { event: 'REMATCH' }, (msg: any) => {
        startGame(msg?.payload?.seed ?? Math.random() * 1000000);
      })
      .on('broadcast', { event: 'REQUEST_REMATCH' }, () => {
        if (asHost) {
          const seed = Math.floor(Math.random() * 1000000);
          ch.send({ type: 'broadcast', event: 'REMATCH', payload: { seed } });
          startGame(seed);
        }
      })
      .on('broadcast', { event: 'SLICE_EVENT' }, (msg: any) => {
        if (msg?.payload) {
          remoteTrailRef.current.push({ p1: msg.payload.p1, p2: msg.payload.p2, life: 1 });
        }
      })
      .on('broadcast', { event: 'SCORE_UPDATE' }, (msg: any) => {
        if (msg?.payload) {
          handleRemoteScore(msg.payload);
        }
      })
      .on('broadcast', { event: 'BOMB_EXPLODED' }, (msg: any) => {
        if (msg?.payload) {
          handleRemoteBomb(msg.payload.loser);
        }
      })
      .on('broadcast', { event: 'NEXT_LEVEL' }, (msg: any) => {
        proceedToNextLevel(msg?.payload?.level ?? (level + 1));
      })
      .on('broadcast', { event: 'GAME_OVER' }, (msg: any) => {
        handleGameOver(msg?.payload?.winner ?? 1);
      });

    ch.subscribe(async (status: string) => {
      if (status === 'SUBSCRIBED') {
        if (!asHost) {
          await ch.send({ type: 'broadcast', event: 'JOIN_EVENT', payload: { code } });
          setConnected(true);
        }
      }
    });

    channelRef.current = ch;
  };

  const createRoom = () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    setRoomCode(code);
    setIsHost(true);
    setScreen('lobby');
    setError('');
    setupChannel(code, true);
  };

  const joinRoom = () => {
    if (!/^\d{4}$/.test(inputCode)) {
      setError('Enter a valid 4-digit room code.');
      return;
    }
    setRoomCode(inputCode);
    setIsHost(false);
    setScreen('lobby');
    setError('');
    setupChannel(inputCode, false);
  };

  const startGame = (seed: number) => {
    setScreen('game');
    setWinner(null);
    setScores({ p1: 0, p2: 0 });
    setLevel(0);
    fruitsRef.current = [];
    halvesRef.current = [];
    bombsRef.current = [];
    particlesRef.current = [];
    splattersRef.current = [];
    popupsRef.current = [];
    prngRef.current = mulberry32(seed);
    waveIndexRef.current = 0;
    nextSpawnRef.current = performance.now() + 500;
    lastTimeRef.current = 0;
    announce(`Level 1: ${LEVELS[0].name} — Begin!`);
    startRenderLoop();
    startLevelTimer(0);
  };

  const handleRematch = () => {
    if (isHost) {
      const seed = Math.floor(Math.random() * 1000000);
      channelRef.current?.send({ type: 'broadcast', event: 'REMATCH', payload: { seed } });
      startGame(seed);
    } else {
      channelRef.current?.send({ type: 'broadcast', event: 'REQUEST_REMATCH', payload: {} });
    }
  };

  const startLevelTimer = (lvl: number) => {
    if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
    if (isHost) {
      levelTimerRef.current = setTimeout(() => {
        if (lvl < LEVELS.length - 1) {
          const next = lvl + 1;
          channelRef.current?.send({ type: 'broadcast', event: 'NEXT_LEVEL', payload: { level: next } });
          proceedToNextLevel(next);
        } else {
          const winner = scores.p1 >= scores.p2 ? 1 : 2;
          channelRef.current?.send({ type: 'broadcast', event: 'GAME_OVER', payload: { winner } });
          handleGameOver(winner);
        }
      }, LEVELS[lvl].duration);
    }
  };

  const proceedToNextLevel = (nextLvl: number) => {
    setLevel(nextLvl);
    announce(`Level ${nextLvl + 1}: ${LEVELS[nextLvl].name} — Intensity rising!`);
    startLevelTimer(nextLvl);
  };

  const handleGameOver = (win: 1 | 2) => {
    if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
    setWinner(win);
    setScreen('gameover');
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if ((win === 1 && isHost) || (win === 2 && !isHost)) {
      sfx.victory();
      announce('Victory! The blade master has prevailed!');
    } else {
      sfx.defeat();
      announce('Defeat... sharpen your skills for the next duel.');
    }
  };

  const spawnWave = () => {
    if (!prngRef.current) return;
    const prng = prngRef.current;
    const lvl = LEVELS[level];
    const count = 1 + Math.floor(prng() * lvl.maxFruits);

    for (let i = 0; i < count; i++) {
      const isBomb = prng() < lvl.bombChance;
      waveIndexRef.current++;
      const id = `${level}-${waveIndexRef.current}-${i}`;

      const x = 200 + prng() * (W - 400);
      const y = H + 50;
      const vx = (prng() - 0.5) * 6;
      const vy = -14 - prng() * 6 - level * 2;

      if (isBomb) {
        bombsRef.current.push({
          id, x, y, vx, vy, r: 28,
          rotation: 0, spin: (prng() - 0.5) * 0.2,
          sliced: false,
          drifting: level === 2,
        });
        sfx.bombSizzle();
      } else {
        const types: FruitType[] = ['watermelon', 'orange', 'apple', 'banana', 'strawberry', 'pineapple'];
        const type = types[Math.floor(prng() * types.length)];
        const r = type === 'watermelon' ? 38 : type === 'pineapple' ? 34 : 26;
        fruitsRef.current.push({
          id, type, x, y, vx, vy, r,
          rotation: prng() * Math.PI * 2,
          spin: (prng() - 0.5) * 0.15,
          sliced: false,
        });
      }
    }
  };

  // FIXED-TIMESTEP PHYSICS UPDATE (Guarantees 100% identical fruit arcs on all monitors)
  const updatePhysics = (dt: number) => {
    const gravity = 0.35 + level * 0.05;

    fruitsRef.current.forEach((f) => {
      f.vy += gravity * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rotation += f.spin * dt;
    });
    fruitsRef.current = fruitsRef.current.filter((f) => f.y < H + 100 && f.y > -200);

    halvesRef.current.forEach((h) => {
      h.vy += gravity * 0.8 * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.rotation += h.spin * dt;
      h.life -= 0.01 * dt;
    });
    halvesRef.current = halvesRef.current.filter((h) => h.life > 0 && h.y < H + 100);

    bombsRef.current.forEach((b) => {
      b.vy += gravity * dt;
      if (b.drifting) b.vx += Math.sin(performance.now() * 0.002) * 0.1;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.rotation += b.spin * dt;
    });
    bombsRef.current = bombsRef.current.filter((b) => b.y < H + 100 && b.y > -200);

    particlesRef.current.forEach((p) => {
      p.vy += 0.2 * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= 0.02 * dt;
    });
    particlesRef.current = particlesRef.current.filter((p) => p.life > 0);

    splattersRef.current.forEach((s) => {
      s.alpha -= 0.002 * dt;
    });
    splattersRef.current = splattersRef.current.filter((s) => s.alpha > 0);

    popupsRef.current.forEach((p) => {
      p.y += p.vy * dt;
      p.life -= 0.02 * dt;
    });
    popupsRef.current = popupsRef.current.filter((p) => p.life > 0);

    remoteTrailRef.current.forEach((t) => {
      t.life -= 0.05 * dt;
    });
    remoteTrailRef.current = remoteTrailRef.current.filter((t) => t.life > 0);

    if (localTrailRef.current.length > 15) {
      localTrailRef.current.shift();
    }
  };

  const distToSegment = (p: Point, p1: Point, p2: Point) => {
    const A = p.x - p1.x;
    const B = p.y - p1.y;
    const C = p2.x - p1.x;
    const D = p2.y - p1.y;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;
    let xx, yy;
    if (param < 0) {
      xx = p1.x;
      yy = p1.y;
    } else if (param > 1) {
      xx = p2.x;
      yy = p2.y;
    } else {
      xx = p1.x + param * C;
      yy = p1.y + param * D;
    }
    return Math.hypot(p.x - xx, p.y - yy);
  };

  const checkCollisions = (p1: Point, p2: Point) => {
    if (screen !== 'game') return;
    const myPlayerId = isHost ? 1 : 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    if (Math.hypot(dx, dy) < 5) return;

    sfx.swish();
    const sliceAngle = Math.atan2(dy, dx);
    const slicedIds: string[] = [];
    let bombHit = false;

    fruitsRef.current.forEach((f) => {
      if (f.sliced) return;
      if (distToSegment(f, p1, p2) < f.r) {
        f.sliced = true;
        slicedIds.push(f.id);
        sliceFruit(f, sliceAngle);
      }
    });

    bombsRef.current.forEach((b) => {
      if (b.sliced) return;
      if (distToSegment(b, p1, p2) < b.r) {
        b.sliced = true;
        bombHit = true;
        triggerBombExplosion(b);
      }
    });

    if (slicedIds.length > 0) {
      handleScoreUpdate(slicedIds, myPlayerId);
    }
    if (bombHit) {
      handleBombExplosion(myPlayerId);
    }
  };

  const sliceFruit = (f: Fruit, sliceAngle: number) => {
    sfx.slice();
    const pushAngle = sliceAngle + Math.PI / 2;
    const pushX = Math.cos(pushAngle);
    const pushY = Math.sin(pushAngle);

    halvesRef.current.push({
      ...f, sliceAngle, life: 1,
      vx: f.vx + pushX * 3, vy: f.vy + pushY * 3, spin: 0.15,
    });
    halvesRef.current.push({
      ...f, sliceAngle: sliceAngle + Math.PI, life: 1,
      vx: f.vx - pushX * 3, vy: f.vy - pushY * 3, spin: -0.15,
    });

    const colors = FRUIT_COLORS[f.type];
    for (let i = 0; i < 12; i++) {
      particlesRef.current.push({
        x: f.x, y: f.y,
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 0.5) * 8 - 2,
        life: 1, maxLife: 1,
        color: `rgba(${colors.juice}, 1)`,
        size: 2 + Math.random() * 4,
        kind: 'juice',
      });
    }

    splattersRef.current.push({
      x: f.x, y: f.y,
      color: colors.juice,
      alpha: 0.6,
      radius: f.r * (1.2 + Math.random() * 0.4),
      seed: Math.random() * 1000,
    });
  };

  const handleScoreUpdate = (slicedIds: string[], playerId: 1 | 2) => {
    const now = performance.now();
    if (now - lastSliceTimeRef.current < 400) {
      comboCountRef.current += slicedIds.length;
    } else {
      comboCountRef.current = slicedIds.length;
    }
    lastSliceTimeRef.current = now;

    const lvl = LEVELS[level];
    let points = slicedIds.length * 10 * lvl.multiplier;

    if (comboCountRef.current >= 3) {
      const mult = Math.min(5, Math.floor(comboCountRef.current / 2));
      points *= mult;
      popupsRef.current.push({
        x: localTrailRef.current[localTrailRef.current.length - 1]?.x || W / 2,
        y: localTrailRef.current[localTrailRef.current.length - 1]?.y || H / 2,
        text: `COMBO x${mult}!`,
        life: 1.5, vy: -2,
        color: '#ffd23b',
      });
      sfx.combo();
      announce(`Player ${playerId} hits a Combo x${mult}!`);
    }

    setScores((prev) => {
      const ns = { ...prev };
      if (playerId === 1) ns.p1 += points;
      else ns.p2 += points;
      return ns;
    });

    if (playerId === (isHost ? 1 : 2)) {
      channelRef.current?.send({
        type: 'broadcast', event: 'SCORE_UPDATE',
        payload: { slicedIds, playerId, points, combo: comboCountRef.current },
      });
    }
  };

  const handleRemoteScore = (payload: any) => {
    const remoteId = payload.playerId === 1 ? 1 : 2;
    const slicedIds: string[] = payload.slicedIds || [];

    slicedIds.forEach((id) => {
      const fruit = fruitsRef.current.find((f) => f.id === id);
      if (fruit && !fruit.sliced) {
        fruit.sliced = true;
        sliceFruit(fruit, Math.random() * Math.PI * 2);
      }
    });

    setScores((prev) => {
      const ns = { ...prev };
      if (remoteId === 1) ns.p1 += payload.points || 0;
      else ns.p2 += payload.points || 0;
      return ns;
    });

    if (payload.combo >= 3) {
      announce(`Player ${remoteId} hits a Combo!`);
    }
  };

  const triggerBombExplosion = (b: BombItem) => {
    screenShakeRef.current = 20;
    flashAlphaRef.current = 1;
    sfx.bombBlast();

    for (let i = 0; i < 50; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 4 + Math.random() * 10;
      particlesRef.current.push({
        x: b.x, y: b.y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 1, maxLife: 1,
        color: ['#ff3b1a', '#ffb01a', '#1a1a1a'][i % 3],
        size: 3 + Math.random() * 6,
        kind: 'spark',
      });
    }
    for (let i = 0; i < 20; i++) {
      particlesRef.current.push({
        x: b.x, y: b.y,
        vx: (Math.random() - 0.5) * 4,
        vy: -Math.random() * 3 - 1,
        life: 1.5, maxLife: 1.5,
        color: 'rgba(40,40,40,0.8)',
        size: 10 + Math.random() * 15,
        kind: 'smoke',
      });
    }
  };

  const handleBombExplosion = (loserId: 1 | 2) => {
    const winnerId = loserId === 1 ? 2 : 1;
    announce(`Player ${loserId} sliced a bomb! Player ${winnerId} wins!`);
    if (isHost) {
      setTimeout(() => {
        channelRef.current?.send({ type: 'broadcast', event: 'GAME_OVER', payload: { winner: winnerId } });
        handleGameOver(winnerId);
      }, 1500);
    } else {
      setTimeout(() => handleGameOver(winnerId), 1500);
    }
  };

  const handleRemoteBomb = (loserId: 1 | 2) => {
    const winnerId = loserId === 1 ? 2 : 1;
    const bomb = bombsRef.current.find((b) => b.sliced);
    if (bomb) triggerBombExplosion(bomb);
    handleBombExplosion(loserId);
  };

  /* ---------------------------------------------------------
     FIXED 60 FPS PHYSICS RENDER LOOP (100% SYNCED ON ALL SCREENS)
     --------------------------------------------------------- */
  const startRenderLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const FIXED_STEP = 1000 / 60; // 16.66ms per step
    let accumulator = 0;

    const loop = (now: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = now;
      let frameTime = now - lastTimeRef.current;
      lastTimeRef.current = now;

      if (frameTime > 100) frameTime = 100; // Cap max lag spike
      accumulator += frameTime;

      // Run fixed 60 FPS physics steps
      while (accumulator >= FIXED_STEP) {
        if (now > nextSpawnRef.current && prngRef.current) {
          spawnWave();
          nextSpawnRef.current = now + LEVELS[level].spawnRate;
        }
        updatePhysics(1.0); // Exact fixed dt = 1.0
        accumulator -= FIXED_STEP;
      }

      if (screenShakeRef.current > 0) screenShakeRef.current -= 0.5;
      if (flashAlphaRef.current > 0) flashAlphaRef.current -= 0.05;

      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  /* ---------------------------------------------------------
     DRAWING
     --------------------------------------------------------- */
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();

    if (screenShakeRef.current > 0) {
      ctx.translate(
        (Math.random() - 0.5) * screenShakeRef.current,
        (Math.random() - 0.5) * screenShakeRef.current
      );
    }

    drawBackground(ctx);

    splattersRef.current.forEach((s) => drawSplatter(ctx, s));
    fruitsRef.current.forEach((f) => drawFruit(ctx, f));
    bombsRef.current.forEach((b) => drawBomb(ctx, b));
    halvesRef.current.forEach((h) => drawHalfFruit(ctx, h));
    particlesRef.current.forEach((p) => drawParticle(ctx, p));

    drawLocalTrail(ctx);
    drawRemoteTrails(ctx);

    popupsRef.current.forEach((p) => {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.text, p.x, p.y);
      ctx.globalAlpha = 1;
    });

    ctx.restore();

    if (flashAlphaRef.current > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlphaRef.current})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  const drawBackground = (ctx: CanvasRenderingContext2D) => {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#3a2410');
    grad.addColorStop(1, '#2a1808');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 4;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (H / 4) * i);
      ctx.lineTo(W, (H / 4) * i);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 30; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * W, 0);
      ctx.bezierCurveTo(
        Math.random() * W, H / 3,
        Math.random() * W, (2 * H) / 3,
        Math.random() * W, H
      );
      ctx.stroke();
    }
  };

  const drawSplatter = (ctx: CanvasRenderingContext2D, s: Splatter) => {
    ctx.globalAlpha = s.alpha;
    ctx.fillStyle = `rgba(${s.color}, 1)`;
    ctx.beginPath();
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const r = s.radius * (0.6 + Math.sin(s.seed + i) * 0.4);
      const x = s.x + Math.cos(angle) * r;
      const y = s.y + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const angle = (s.seed + i * 90) * (Math.PI / 180);
      ctx.beginPath();
      ctx.arc(
        s.x + Math.cos(angle) * s.radius * 0.8,
        s.y + Math.sin(angle) * s.radius * 0.8 + s.radius * 0.5,
        s.radius * 0.2, 0, Math.PI * 2
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const drawFruit = (ctx: CanvasRenderingContext2D, f: Fruit) => {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rotation);
    drawFruitBody(ctx, f.type, f.r);
    ctx.restore();
  };

  const drawFruitBody = (ctx: CanvasRenderingContext2D, type: FruitType, r: number) => {
    const colors = FRUIT_COLORS[type];

    if (type === 'watermelon') {
      ctx.fillStyle = colors.skin;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1a5a0f';
      ctx.lineWidth = 3;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.8, (i / 5) * Math.PI * 2, (i / 5) * Math.PI * 2 + 0.4);
        ctx.stroke();
      }
    } else if (type === 'orange') {
      ctx.fillStyle = colors.skin;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.1)';
      for (let i = 0; i < 10; i++) {
        ctx.beginPath();
        ctx.arc((Math.random() - 0.5) * r, (Math.random() - 0.5) * r, 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#3a8c2a';
      ctx.beginPath();
      ctx.ellipse(0, -r, 4, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'apple') {
      ctx.fillStyle = colors.skin;
      ctx.beginPath();
      ctx.moveTo(0, r);
      ctx.bezierCurveTo(-r, r * 0.5, -r, -r * 0.8, 0, -r * 0.6);
      ctx.bezierCurveTo(r, -r * 0.8, r, r * 0.5, 0, r);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.3, -r * 0.2, r * 0.2, r * 0.4, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#4a2a10';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.6);
      ctx.lineTo(0, -r * 1.1);
      ctx.stroke();
    } else if (type === 'banana') {
      ctx.fillStyle = colors.skin;
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.quadraticCurveTo(0, -r * 1.5, r, 0);
      ctx.quadraticCurveTo(0, r * 0.5, -r, 0);
      ctx.fill();
      ctx.fillStyle = '#5a4a10';
      ctx.fillRect(-r - 2, -2, 4, 4);
      ctx.fillRect(r - 2, -2, 4, 4);
    } else if (type === 'strawberry') {
      ctx.fillStyle = colors.skin;
      ctx.beginPath();
      ctx.moveTo(0, r);
      ctx.quadraticCurveTo(r, r * 0.2, r * 0.7, -r * 0.5);
      ctx.quadraticCurveTo(0, -r, -r * 0.7, -r * 0.5);
      ctx.quadraticCurveTo(-r, r * 0.2, 0, r);
      ctx.fill();
      ctx.fillStyle = '#fff5a0';
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.ellipse(
          (Math.random() - 0.5) * r * 1.2,
          (Math.random() - 0.5) * r * 1.2,
          1.5, 3, Math.random() * Math.PI, 0, Math.PI * 2
        );
        ctx.fill();
      }
      ctx.fillStyle = '#3a8c2a';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.6);
      ctx.lineTo(-r * 0.4, -r * 0.9);
      ctx.lineTo(0, -r * 0.4);
      ctx.lineTo(r * 0.4, -r * 0.9);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'pineapple') {
      ctx.fillStyle = colors.skin;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.1, r * 0.7, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8a6a10';
      ctx.lineWidth = 2;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.7, i * r * 0.3);
        ctx.lineTo(r * 0.7, i * r * 0.3);
        ctx.stroke();
      }
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * r * 0.3, -r * 0.9);
        ctx.lineTo(i * r * 0.3, r);
        ctx.stroke();
      }
      ctx.fillStyle = '#3a8c2a';
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(-r * 0.5, -r * 1.8);
      ctx.lineTo(0, -r * 0.8);
      ctx.lineTo(0, -r * 1.2);
      ctx.lineTo(r * 0.5, -r * 1.8);
      ctx.lineTo(0, -r);
      ctx.fill();
    }
  };

  const drawHalfFruit = (ctx: CanvasRenderingContext2D, h: HalfFruit) => {
    ctx.save();
    ctx.globalAlpha = Math.min(1, h.life);
    ctx.translate(h.x, h.y);
    ctx.rotate(h.rotation);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, h.r, h.sliceAngle, h.sliceAngle + Math.PI);
    ctx.closePath();
    ctx.clip();

    const colors = FRUIT_COLORS[h.type];
    ctx.fillStyle = colors.skin;
    ctx.beginPath();
    ctx.arc(0, 0, h.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors.pulp;
    ctx.beginPath();
    ctx.arc(0, 0, h.r * 0.85, 0, Math.PI * 2);
    ctx.fill();

    if (h.type === 'watermelon') {
      ctx.fillStyle = '#1a1a1a';
      for (let i = 0; i < 4; i++) {
        const a = h.sliceAngle + Math.random() * Math.PI;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * h.r * 0.4, Math.sin(a) * h.r * 0.4, 2, 4, a, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (h.type === 'orange' || h.type === 'pineapple') {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos((i * Math.PI) / 3) * h.r * 0.8, Math.sin((i * Math.PI) / 3) * h.r * 0.8);
        ctx.stroke();
      }
    }
    ctx.restore();

    ctx.strokeStyle = colors.skin;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(h.sliceAngle) * h.r, Math.sin(h.sliceAngle) * h.r);
    ctx.lineTo(Math.cos(h.sliceAngle + Math.PI) * h.r, Math.sin(h.sliceAngle + Math.PI) * h.r);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
    ctx.globalAlpha = 1;
  };

  const drawBomb = (ctx: CanvasRenderingContext2D, b: BombItem) => {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rotation);

    const grad = ctx.createRadialGradient(-b.r * 0.3, -b.r * 0.3, 2, 0, 0, b.r);
    grad.addColorStop(0, '#5a5a5a');
    grad.addColorStop(1, '#1a1a1a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, b.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(-4, -b.r - 6, 8, 6);

    ctx.strokeStyle = '#8a6a3a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -b.r - 6);
    ctx.quadraticCurveTo(10, -b.r - 15, 5, -b.r - 25);
    ctx.stroke();

    const sparkSize = 4 + Math.sin(performance.now() * 0.05) * 2;
    ctx.fillStyle = '#ffd23b';
    ctx.shadowColor = '#ff8c1a';
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(5, -b.r - 25, sparkSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(-b.r * 0.3, -b.r * 0.3, b.r * 0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  const drawParticle = (ctx: CanvasRenderingContext2D, p: Particle) => {
    ctx.globalAlpha = p.life / p.maxLife;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  const drawLocalTrail = (ctx: CanvasRenderingContext2D) => {
    if (localTrailRef.current.length < 2) return;
    const color = isHost ? '0, 255, 255' : '255, 0, 255';

    ctx.shadowColor = `rgba(${color}, 1)`;
    ctx.shadowBlur = 15;

    for (let i = 1; i < localTrailRef.current.length; i++) {
      const p1 = localTrailRef.current[i - 1];
      const p2 = localTrailRef.current[i];
      const alpha = i / localTrailRef.current.length;
      ctx.strokeStyle = `rgba(${color}, ${alpha})`;
      ctx.lineWidth = alpha * 12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  };

  const drawRemoteTrails = (ctx: CanvasRenderingContext2D) => {
    const color = isHost ? '255, 0, 255' : '0, 255, 255';

    ctx.shadowColor = `rgba(${color}, 1)`;
    ctx.shadowBlur = 15;

    remoteTrailRef.current.forEach((t) => {
      ctx.strokeStyle = `rgba(${color}, ${t.life})`;
      ctx.lineWidth = t.life * 10;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(t.p1.x, t.p1.y);
      ctx.lineTo(t.p2.x, t.p2.y);
      ctx.stroke();
    });
    ctx.shadowBlur = 0;
  };

  const getCanvasPos = (e: React.MouseEvent | React.Touch | MouseEvent | Touch) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    return {
      x: ((e as any).clientX - rect.left) * scaleX,
      y: ((e as any).clientY - rect.top) * scaleY,
    };
  };

  let lastSendTime = 0;
  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (screen !== 'game') return;
    const points = 'touches' in e ? Array.from(e.touches) : [e];
    points.forEach((touch) => {
      const pos = getCanvasPos(touch);
      const prev = localTrailRef.current[localTrailRef.current.length - 1] || pos;
      localTrailRef.current.push(pos);

      checkCollisions(prev, pos);

      const now = performance.now();
      if (now - lastSendTime > 33) {
        lastSendTime = now;
        channelRef.current?.send({
          type: 'broadcast', event: 'SLICE_EVENT',
          payload: { p1: prev, p2: pos },
        });
      }
    });
  };

  const handleRestart = () => {
    setScreen('menu');
    setRoomCode('');
    setInputCode('');
    setConnected(false);
    setScores({ p1: 0, p2: 0 });
    setWinner(null);
    if (channelRef.current) {
      try { channelRef.current.unsubscribe(); } catch {}
      channelRef.current = null;
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (channelRef.current) {
        try { channelRef.current.unsubscribe(); } catch {}
      }
      if (audioRef.current) {
        try { audioRef.current.close(); } catch {}
      }
      if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
    };
  }, []);

  const myPlayerId = isHost ? 1 : 2;

  return (
    <div className="relative w-full h-full min-h-[640px] flex flex-col items-center justify-center bg-slate-900 text-white select-none">
      {screen === 'menu' && (
        <div className="w-full max-w-2xl p-8 text-center space-y-8">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 text-sm font-semibold">
              <Scissors className="w-4 h-4" /> MULTIPLAYER DUEL
            </div>
            <h1 className="text-5xl md:text-6xl font-black tracking-tight bg-gradient-to-r from-cyan-400 via-fuchsia-400 to-orange-400 bg-clip-text text-transparent">
              Fruit Blade
            </h1>
            <p className="text-slate-400 text-lg">
              Slice fruits in real-time. Avoid bombs. The ultimate shared-canvas ninja duel.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <button
              onClick={createRoom}
              className="group p-6 rounded-2xl bg-gradient-to-br from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 transition-all hover:scale-[1.02] shadow-lg shadow-cyan-900/40 text-left"
            >
              <Shield className="w-8 h-8 mb-3 text-white" />
              <div className="text-xl font-bold">Host a Dojo</div>
              <div className="text-sm text-white/80">Create a room & await your rival</div>
            </button>

            <div className="p-6 rounded-2xl bg-slate-800/80 border border-slate-700 space-y-3">
              <Target className="w-8 h-8 text-fuchsia-400" />
              <div className="text-xl font-bold">Join a Dojo</div>
              <input
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4-digit code"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-center text-2xl tracking-[0.5em] font-bold focus:outline-none focus:border-fuchsia-400"
              />
              <button
                onClick={joinRoom}
                disabled={inputCode.length !== 4}
                className="w-full px-4 py-2 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-900 font-bold transition-colors"
              >
                Enter Duel
              </button>
              {error && <div className="text-red-400 text-sm">{error}</div>}
            </div>
          </div>
        </div>
      )}

      {screen === 'lobby' && (
        <div className="w-full max-w-md p-8 text-center space-y-6">
          <div className="space-y-2">
            <h2 className="text-3xl font-bold">{isHost ? 'Waiting for rival…' : 'Joining dojo…'}</h2>
            <p className="text-slate-400">{isHost ? 'Share this code with your opponent:' : 'Connecting to room:'}</p>
          </div>
          <div className="py-6 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-dashed border-cyan-500/50">
            <div className="text-6xl font-black tracking-[0.3em] text-cyan-400">{roomCode}</div>
          </div>
          <div className="flex items-center justify-center gap-3 text-slate-400">
            {!connected ? (
              <>
                <div className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse" />
                <span>Awaiting Player 2…</span>
              </>
            ) : (
              <>
                <div className="w-3 h-3 rounded-full bg-green-400" />
                <span className="text-green-400 font-semibold">Opponent connected! Starting…</span>
              </>
            )}
          </div>
        </div>
      )}

      {screen === 'game' && (
        <div className="w-full h-full flex flex-col">
          {/* Top HUD */}
          <div className="flex-shrink-0 px-4 py-2 bg-slate-900/90 backdrop-blur border-b border-slate-700 flex items-center gap-4 text-sm">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-lg ${myPlayerId === 1 ? 'bg-cyan-600/40 border border-cyan-500/60' : 'bg-slate-800/60'}`}>
              <Shield className="w-4 h-4 text-cyan-400" />
              <span className="font-bold">P1 (Cyan)</span>
              <span className="text-slate-400">{scores.p1}</span>
            </div>

            <div className="flex-1 text-center">
              <div className="text-xs text-slate-400">Level {level + 1}</div>
              <div className="font-bold text-fuchsia-300 flex items-center justify-center gap-1">
                {level === 0 && <Wind className="w-3 h-3" />}
                {level === 1 && <Sparkles className="w-3 h-3" />}
                {level === 2 && <Flame className="w-3 h-3" />}
                {LEVELS[level].name}
              </div>
            </div>

            <div className={`flex items-center gap-2 px-3 py-1 rounded-lg ${myPlayerId === 2 ? 'bg-fuchsia-600/40 border border-fuchsia-500/60' : 'bg-slate-800/60'}`}>
              <span className="text-slate-400">{scores.p2}</span>
              <span className="font-bold">P2 (Magenta)</span>
              <Target className="w-4 h-4 text-fuchsia-400" />
            </div>

            <button
              onClick={() => setMuted((m) => !m)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700"
              title={muted ? 'Unmute' : 'Mute'}
            >
              <Volume2 className={`w-4 h-4 ${muted ? 'text-slate-500' : 'text-white'}`} />
            </button>
          </div>

          {/* Canvas */}
          <div className="flex-1 relative bg-black overflow-hidden">
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              onMouseMove={handlePointerMove}
              onTouchMove={handlePointerMove}
              className="w-full h-full object-contain cursor-crosshair"
              style={{ aspectRatio: `${W}/${H}`, touchAction: 'none' }}
            />

            {/* Announcement banner */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 max-w-[60%] pointer-events-none">
              <div className="px-4 py-2 rounded-full bg-black/70 backdrop-blur border border-fuchsia-500/40 text-fuchsia-200 text-sm font-semibold text-center truncate">
                <Sparkles className="inline w-3.5 h-3.5 mr-1.5 text-fuchsia-400" />
                {announcement}
              </div>
            </div>
          </div>
        </div>
      )}

      {screen === 'gameover' && (
        <div className="w-full max-w-md p-8 text-center space-y-6">
          <div className="space-y-2">
            <Award className={`w-16 h-16 mx-auto ${winner === 1 ? 'text-cyan-400' : 'text-fuchsia-400'}`} />
            <h2 className="text-4xl font-black">
              {winner === 1 ? 'PLAYER 1 VICTORIOUS' : 'PLAYER 2 VICTORIOUS'}
            </h2>
            <p className="text-slate-400">
              {winner === myPlayerId
                ? 'Your blade cuts true! A master ninja!'
                : 'A bitter defeat. The blade requires more discipline.'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
              <div className="text-xs text-slate-400">Player 1 (Cyan)</div>
              <div className="text-3xl font-bold text-cyan-400">{scores.p1}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
              <div className="text-xs text-slate-400">Player 2 (Magenta)</div>
              <div className="text-3xl font-bold text-fuchsia-400">{scores.p2}</div>
            </div>
          </div>
          <div className="px-4 py-3 rounded-xl bg-slate-800/60 border border-fuchsia-500/30 text-fuchsia-200 text-sm">
            {announcement}
          </div>

          <div className="flex gap-3 justify-center">
            <button
              onClick={handleRematch}
              className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 font-bold transition-all shadow-lg text-slate-950 flex items-center gap-2"
            >
              <RotateCcw className="w-5 h-5" />
              Play Again / Instant Rematch
            </button>
            <button
              onClick={handleRestart}
              className="px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold transition-all border border-slate-700 text-slate-300"
            >
              Return to Menu
            </button>
          </div>
        </div>
      )}
    </div>
  );
}