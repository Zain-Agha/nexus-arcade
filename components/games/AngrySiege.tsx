'use client';

import React, { useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import { supabase } from '@/lib/supabase';
import { generateGameAnnounce } from '@/lib/groq';
import { Shield, Target, Play, RotateCcw, Volume2, Award, Zap, Flame, Wind, Sparkles } from 'lucide-react';

/* ============================================================
   AngrySiege.tsx — Multiplayer Angry Birds Castle Siege Duel
   ============================================================ */

interface GameProps {
  roomCode?: string;
  playerRole?: 'p1' | 'p2';
  p1Name?: string;
  p2Name?: string;
}

type BirdType = 'red' | 'yellow' | 'black';
type Screen = 'menu' | 'lobby' | 'game' | 'gameover';
type Turn = 1 | 2;

interface Block {
  body: Matter.Body;
  type: 'wood' | 'stone' | 'ice' | 'obsidian';
  hp: number;
  maxHp: number;
  w: number;
  h: number;
}

interface CastleTarget {
  body: Matter.Body;
  hp: number;
  maxHp: number;
  side: 'left' | 'right';
  x: number;
  y: number;
  r: number;
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
  kind: 'feather' | 'smoke' | 'spark' | 'debris' | 'ice';
}

interface LevelConfig {
  name: string;
  subtitle: string;
  theme: 'meadow' | 'glacial' | 'volcanic';
  gravity: number;
  crosswind: number;
  sky: [string, string];
  ground: string;
}

const LEVELS: LevelConfig[] = [
  {
    name: 'Meadow Siege',
    subtitle: 'Level 1 — Rolling Green Hills',
    theme: 'meadow',
    gravity: 1,
    crosswind: 0,
    sky: ['#8fd3ff', '#c8f0c2'],
    ground: '#5a9e3a',
  },
  {
    name: 'Glacial Peak',
    subtitle: 'Level 2 — Frozen Ramparts',
    theme: 'glacial',
    gravity: 1.05,
    crosswind: -0.012,
    sky: ['#bfe6ff', '#eef7ff'],
    ground: '#cfe6f0',
  },
  {
    name: 'Volcanic Keep',
    subtitle: 'Level 3 — Magma Stronghold',
    theme: 'volcanic',
    gravity: 1.25,
    crosswind: 0.018,
    sky: ['#3a1410', '#8a2a14'],
    ground: '#2a1410',
  },
];

const BIRD_INFO: Record<BirdType, { name: string; mass: number; radius: number; color: string }> = {
  red: { name: 'Red — Heavy Breaker', mass: 0.05, radius: 18, color: '#e23b2e' },
  yellow: { name: 'Chuck — Speedster', mass: 0.032, radius: 16, color: '#ffd23b' },
  black: { name: 'Bomb — Demolition', mass: 0.07, radius: 19, color: '#2b2b2b' },
};

const SHOTS_PER_TURN = 1;
const MAX_BIRD_RADIUS = 20;

export default function AngrySiege({ roomCode: propRoomCode, playerRole: propPlayerRole }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);
  const rafRef = useRef<number | null>(null);
  const channelRef = useRef<any>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const mutedRef = useRef<boolean>(false);

  // Game data refs (mutable, used by render/physics loops)
  const blocksRef = useRef<Block[]>([]);
  const targetsRef = useRef<CastleTarget[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const flyingBirdRef = useRef<{
    body: Matter.Body;
    type: BirdType;
    abilityUsed: boolean;
    launched: boolean;
    trail: { x: number; y: number }[];
    side: 'left' | 'right';
  } | null>(null);
  const loadedBirdRef = useRef<{ type: BirdType; x: number; y: number } | null>(null);
  const slingshotRef = useRef<{
    left: { x: number; y: number; forkY: number };
    right: { x: number; y: number; forkY: number };
  }>({ left: { x: 0, y: 0, forkY: 0 }, right: { x: 0, y: 0, forkY: 0 } });
  const draggingRef = useRef<{ active: boolean; startX: number; startY: number; curX: number; curY: number }>({
    active: false,
    startX: 0,
    startY: 0,
    curX: 0,
    curY: 0,
  });
  const turnRef = useRef<Turn>(1);
  const levelRef = useRef<number>(0);
  const playerSideRef = useRef<'left' | 'right'>('left');
  const shotInProgressRef = useRef<boolean>(false);
  const settleTimerRef = useRef<number>(0);
  const cleanupFnRef = useRef<(() => void) | null>(null);

  // UI state
  const [screen, setScreen] = useState<Screen>('menu');
  const [roomCode, setRoomCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(true);
  const [connected, setConnected] = useState<boolean>(false);
  const [turn, setTurn] = useState<Turn>(1);
  const [scores, setScores] = useState<{ p1: number; p2: number }>({ p1: 0, p2: 0 });
  const [targetHp, setTargetHp] = useState<{ left: number; right: number }>({ left: 100, right: 100 });
  const [selectedBird, setSelectedBird] = useState<BirdType>('red');
  const [level, setLevel] = useState<number>(0);
  const [announcement, setAnnouncement] = useState<string>('Prepare your siege engines…');
  const [winner, setWinner] = useState<null | 1 | 2>(null);
  const [muted, setMuted] = useState<boolean>(false);
  const [abilityHint, setAbilityHint] = useState<string>('');
  const [p1Birds, setP1Birds] = useState<BirdType[]>(['red', 'yellow', 'black', 'red', 'yellow']);
  const [p2Birds, setP2Birds] = useState<BirdType[]>(['red', 'yellow', 'black', 'red', 'yellow']);
  const [error, setError] = useState<string>('');

  // Sync refs with state where necessary
  useEffect(() => { turnRef.current = turn; }, [turn]);
  useEffect(() => { levelRef.current = level; }, [level]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // Auto-start logic if props are provided
  useEffect(() => {
    if (propRoomCode && propPlayerRole) {
      setRoomCode(propRoomCode);
      const hostStatus = propPlayerRole === 'p1';
      setIsHost(hostStatus);
      playerSideRef.current = hostStatus ? 'left' : 'right';
      setScreen('lobby');
      setupChannel(propRoomCode, hostStatus);
    }
  }, [propRoomCode, propPlayerRole]);

  /* ---------------------------------------------------------
     AUDIO — Web Audio API synthesized SFX
     --------------------------------------------------------- */
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

  const playTone = (
    freq: number,
    duration: number,
    type: OscillatorType = 'sine',
    gain = 0.15,
    freqEnd?: number
  ) => {
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

  const playNoise = (duration: number, gain = 0.2, filterFreq = 1000) => {
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
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start();
  };

  const sfx = {
    stretch: () => playTone(180, 0.12, 'sawtooth', 0.08, 90),
    launch: () => {
      playTone(420, 0.18, 'square', 0.12, 760);
      playNoise(0.18, 0.12, 1800);
    },
    boost: () => {
      playTone(300, 0.25, 'sawtooth', 0.14, 1400);
      playNoise(0.2, 0.1, 2400);
    },
    bomb: () => {
      playNoise(0.5, 0.35, 600);
      playTone(80, 0.4, 'sine', 0.18, 30);
    },
    impact: (intensity = 1) => {
      playNoise(0.12, Math.min(0.3, 0.1 * intensity), 1200);
      playTone(120, 0.1, 'square', 0.08 * intensity, 60);
    },
    victory: () => {
      const seq = [523, 659, 784, 1047];
      seq.forEach((f, i) => setTimeout(() => playTone(f, 0.25, 'triangle', 0.15), i * 130));
    },
    defeat: () => {
      const seq = [440, 392, 329, 261];
      seq.forEach((f, i) => setTimeout(() => playTone(f, 0.3, 'sine', 0.13), i * 160));
    },
    ui: () => playTone(660, 0.06, 'square', 0.07),
  };

  /* ---------------------------------------------------------
     AI ANNOUNCER
     --------------------------------------------------------- */
  const announce = async (event: string) => {
    setAnnouncement('…');
    try {
      const text = await generateGameAnnounce('Angry Birds Siege', event);
      setAnnouncement(text || event);
    } catch {
      setAnnouncement(event);
    }
  };

  /* ---------------------------------------------------------
     SUPABASE REALTIME
     --------------------------------------------------------- */
  const setupChannel = (code: string, asHost: boolean) => {
    if (channelRef.current) {
      try { channelRef.current.unsubscribe(); } catch {}
      channelRef.current = null;
    }
    const ch = supabase.channel('angry_siege_' + code, {
      config: { broadcast: { self: false } },
    });

    ch.on('broadcast', { event: 'JOIN_EVENT' }, () => {
      setConnected(true);
      setAnnouncement('Oppendant has joined the siege!');
      if (asHost) {
        // Host auto-starts game after guest joins
        setTimeout(() => {
          ch.send({ type: 'broadcast', event: 'START_GAME', payload: { level: 0 } });
          startGame(0, 'left');
        }, 600);
      }
    })
      .on('broadcast', { event: 'START_GAME' }, (msg: any) => {
        startGame(msg?.payload?.level ?? 0, 'right');
      })
      .on('broadcast', { event: 'FIRE_BIRD' }, (msg: any) => {
        handleRemoteFire(msg?.payload);
      })
      .on('broadcast', { event: 'TRIGGER_ABILITY' }, (msg: any) => {
        handleRemoteAbility(msg?.payload);
      })
      .on('broadcast', { event: 'NEXT_LEVEL' }, (msg: any) => {
        proceedToNextLevel(msg?.payload?.level ?? (levelRef.current + 1));
      })
      .on('broadcast', { event: 'GAME_OVER' }, (msg: any) => {
        setWinner(msg?.payload?.winner ?? 1);
        setScreen('gameover');
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

  const createRoom = async () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    setRoomCode(code);
    setIsHost(true);
    playerSideRef.current = 'left';
    setScreen('lobby');
    setError('');
    announce('Player 1 is preparing the meadow siege arena.');
    setupChannel(code, true);
  };

  const joinRoom = async () => {
    if (!/^\d{4}$/.test(inputCode)) {
      setError('Enter a valid 4-digit room code.');
      return;
    }
    setRoomCode(inputCode);
    setIsHost(false);
    playerSideRef.current = 'right';
    setScreen('lobby');
    setError('');
    announce('Player 2 is joining the siege duel.');
    setupChannel(inputCode, false);
  };

  /* ---------------------------------------------------------
     PHYSICS & GAME INITIALIZATION
     --------------------------------------------------------- */
  const W = 1280;
  const H = 720;
  const GROUND_Y = 640;

  const startGame = (lvl: number, side: 'left' | 'right') => {
    setLevel(lvl);
    levelRef.current = lvl;
    setScreen('game');
    setWinner(null);
    setScores({ p1: 0, p2: 0 });
    setTurn(1);
    turnRef.current = 1;
    playerSideRef.current = side;
    setP1Birds(['red', 'yellow', 'black', 'red', 'yellow']);
    setP2Birds(['red', 'yellow', 'black', 'red', 'yellow']);
    setTimeout(() => initPhysics(lvl), 50);
    announce(`${LEVELS[lvl].name} — Battle commence!`);
  };

  const initPhysics = (lvl: number) => {
    // Clean previous
    if (engineRef.current) {
      if (runnerRef.current) Matter.Runner.stop(runnerRef.current);
      Matter.World.clear(engineRef.current.world, false);
      Matter.Engine.clear(engineRef.current);
    }
    cleanupFnRef.current?.();

    const engine = Matter.Engine.create();
    const cfg = LEVELS[lvl];
    engine.gravity.y = cfg.gravity;
    engine.gravity.x = cfg.crosswind;
    engineRef.current = engine;

    // Ground
    const ground = Matter.Bodies.rectangle(W / 2, GROUND_Y + 30, W, 60, {
      isStatic: true,
      friction: 0.9,
      label: 'ground',
    });
    // Side walls (invisible)
    const leftWall = Matter.Bodies.rectangle(-20, H / 2, 40, H, { isStatic: true });
    const rightWall = Matter.Bodies.rectangle(W + 20, H / 2, 40, H, { isStatic: true });
    Matter.World.add(engine.world, [ground, leftWall, rightWall]);

    // Slingshots
    const leftSling = { x: 180, y: GROUND_Y, forkY: GROUND_Y - 110 };
    const rightSling = { x: W - 180, y: GROUND_Y, forkY: GROUND_Y - 110 };
    slingshotRef.current = { left: leftSling, right: rightSling };

    // Castles
    blocksRef.current = [];
    targetsRef.current = [];
    buildCastle(engine, 'left', leftSling.x + 320, GROUND_Y, lvl);
    buildCastle(engine, 'right', rightSling.x - 320, GROUND_Y, lvl);

    // Load first bird for player 1 (left side)
    loadBird('red', 1);

    // Collision events
    Matter.Events.on(engine, 'collisionStart', (evt) => {
      for (const pair of evt.pairs) {
        const a = pair.bodyA;
        const b = pair.bodyB;
        const speed = Math.hypot((a.velocity.x + b.velocity.x) / 2, (a.velocity.y + b.velocity.y) / 2);
        if (speed > 3) {
          sfx.impact(Math.min(2, speed / 6));
          // Spawn impact particles
          const cx = (a.position.x + b.position.x) / 2;
          const cy = (a.position.y + b.position.y) / 2;
          for (let i = 0; i < 6; i++) {
            particlesRef.current.push({
              x: cx, y: cy,
              vx: (Math.random() - 0.5) * 4,
              vy: (Math.random() - 0.5) * 4 - 1,
              life: 0.6, maxLife: 0.6,
              color: '#fff3b0', size: 2 + Math.random() * 2,
              kind: 'spark',
            });
          }
          // Damage blocks
          damageBlock(a, speed);
          damageBlock(b, speed);
        }
      }
    });

    // Start runner
    const runner = Matter.Runner.create();
    runnerRef.current = runner;
    Matter.Runner.run(runner, engine);

    // Start render loop
    startRenderLoop();
  };

  const damageBlock = (body: Matter.Body, speed: number) => {
    const blk = blocksRef.current.find((b) => b.body === body);
    if (!blk) return;
    const dmg = speed * (blk.type === 'stone' ? 0.6 : blk.type === 'obsidian' ? 0.3 : blk.type === 'ice' ? 1.6 : 1) * 1.5;
    blk.hp -= dmg;
    if (blk.hp <= 0) {
      // Debris particles
      for (let i = 0; i < 14; i++) {
        const colorMap: Record<string, string> = {
          wood: '#a0651b', stone: '#8a8a8a', ice: '#a8e6ff', obsidian: '#1a0d1a',
        };
        particlesRef.current.push({
          x: blk.body.position.x, y: blk.body.position.y,
          vx: (Math.random() - 0.5) * 6,
          vy: -Math.random() * 5 - 1,
          life: 1.2, maxLife: 1.2,
          color: colorMap[blk.type] || '#888',
          size: 3 + Math.random() * 4,
          kind: blk.type === 'ice' ? 'ice' : 'debris',
        });
      }
      Matter.World.remove(engineRef.current!.world, blk.body);
      blocksRef.current = blocksRef.current.filter((b) => b !== blk);
    }
  };

  const buildCastle = (
    engine: Matter.Engine,
    side: 'left' | 'right',
    baseX: number,
    groundY: number,
    lvl: number
  ) => {
    const cfg = LEVELS[lvl];
    const dir = side === 'left' ? 1 : -1;
    const makeBlock = (
      x: number, y: number, w: number, h: number,
      type: Block['type']
    ): Block => {
      const hpMap = { wood: 60, stone: 120, ice: 30, obsidian: 200 };
      const densityMap = { wood: 0.0018, stone: 0.004, ice: 0.0012, obsidian: 0.006 };
      const body = Matter.Bodies.rectangle(x, y, w, h, {
        density: densityMap[type],
        friction: 0.8,
        restitution: 0.05,
        label: 'block_' + type,
      });
      Matter.World.add(engine.world, body);
      const blk: Block = { body, type, hp: hpMap[type], maxHp: hpMap[type], w, h };
      blocksRef.current.push(blk);
      return blk;
    };

    // Determine block types based on theme
    const pillarType: Block['type'] = cfg.theme === 'glacial' ? 'ice' : cfg.theme === 'volcanic' ? 'obsidian' : 'wood';
    const beamType: Block['type'] = cfg.theme === 'volcanic' ? 'obsidian' : cfg.theme === 'glacial' ? 'ice' : 'stone';

    // Two-story castle
    const storyH = 60;
    const storyGap = 14;
    const pillarW = 18;
    const beamH = 18;

    for (let story = 0; story < 2; story++) {
      const y = groundY - 30 - story * (storyH + storyGap);
      // 4 pillars
      for (let i = 0; i < 4; i++) {
        const px = baseX + dir * (i - 1.5) * 50;
        makeBlock(px, y - storyH / 2, pillarW, storyH, pillarType);
      }
      // Beam
      makeBlock(baseX, y - storyH - beamH / 2 + 4, 240, beamH, beamType);
    }

    // Top tower
    const topY = groundY - 30 - 2 * (storyH + storyGap);
    makeBlock(baseX - 60, topY - 30, pillarW, 60, pillarType);
    makeBlock(baseX + 60, topY - 30, pillarW, 60, pillarType);
    makeBlock(baseX, topY - 70, 150, beamH, beamType);
    makeBlock(baseX, topY - 95, 100, beamH, beamType);

    // Target pig/crystal inside
    const targetY = groundY - 30 - 35;
    const targetBody = Matter.Bodies.circle(baseX, targetY, 22, {
      isStatic: true,
      label: 'target_' + side,
    });
    Matter.World.add(engine.world, targetBody);
    targetsRef.current.push({
      body: targetBody,
      hp: 100,
      maxHp: 100,
      side,
      x: baseX,
      y: targetY,
      r: 22,
    });
  };

  /* ---------------------------------------------------------
     BIRD LOADING / LAUNCH
     --------------------------------------------------------- */
  const loadBird = (type: BirdType, forTurn: Turn) => {
    const sling = forTurn === 1 ? slingshotRef.current.left : slingshotRef.current.right;
    loadedBirdRef.current = { type, x: sling.x, y: sling.forkY - 20 };
    if (forTurn === 1) {
      setP1Birds((b) => (b[0] === type ? b.slice(1) : b));
    } else {
      setP2Birds((b) => (b[0] === type ? b.slice(1) : b));
    }
  };

  const handleRemoteFire = (payload: any) => {
    if (!payload) return;
    const side: 'left' | 'right' = payload.side === 'left' ? 'left' : 'right';
    const type: BirdType = payload.type === 'yellow' ? 'yellow' : payload.type === 'black' ? 'black' : 'red';
    const vx = Number(payload.vx) || 0;
    const vy = Number(payload.vy) || 0;
    const sling = side === 'left' ? slingshotRef.current.left : slingshotRef.current.right;
    spawnFlyingBird(type, side, sling.x, sling.forkY - 20, vx, vy);
    shotInProgressRef.current = true;
    setAbilityHint(type === 'yellow' ? 'Click canvas for SPEED BOOST' : type === 'black' ? 'Click canvas for BOMB BLAST' : '');
  };

  const handleRemoteAbility = (payload: any) => {
    if (!payload || !flyingBirdRef.current) return;
    const fb = flyingBirdRef.current;
    if (payload.type === 'boost') triggerBoost(fb);
    else if (payload.type === 'bomb') triggerBomb(fb);
  };

  const spawnFlyingBird = (
    type: BirdType,
    side: 'left' | 'right',
    x: number, y: number,
    vx: number, vy: number
  ) => {
    const info = BIRD_INFO[type];
    const body = Matter.Bodies.circle(x, y, info.radius, {
      density: info.mass,
      friction: 0.4,
      restitution: 0.35,
      label: 'bird_' + type,
      frictionAir: 0.005,
    });
    Matter.Body.setVelocity(body, { x: vx, y: vy });
    Matter.World.add(engineRef.current!.world, body);
    flyingBirdRef.current = {
      body,
      type,
      abilityUsed: false,
      launched: true,
      trail: [],
      side,
    };
    loadedBirdRef.current = null;
    sfx.launch();
  };

  const fireBird = (vx: number, vy: number) => {
    const side = playerSideRef.current;
    const type = selectedBird;
    const sling = side === 'left' ? slingshotRef.current.left : slingshotRef.current.right;
    spawnFlyingBird(type, side, sling.x, sling.forkY - 20, vx, vy);
    shotInProgressRef.current = true;
    setAbilityHint(
      type === 'yellow' ? 'Click canvas for SPEED BOOST' :
      type === 'black' ? 'Click canvas for BOMB BLAST' : ''
    );
    channelRef.current?.send({
      type: 'broadcast', event: 'FIRE_BIRD',
      payload: { side, type, vx, vy },
    });
  };

  const triggerBoost = (fb: NonNullable<typeof flyingBirdRef.current>) => {
    if (fb.abilityUsed || fb.type !== 'yellow') return;
    fb.abilityUsed = true;
    const v = fb.body.velocity;
    const boostMul = 2.4;
    Matter.Body.setVelocity(fb.body, { x: v.x * boostMul, y: v.y * boostMul });
    sfx.boost();
    for (let i = 0; i < 20; i++) {
      particlesRef.current.push({
        x: fb.body.position.x, y: fb.body.position.y,
        vx: (Math.random() - 0.5) * 6 - v.x * 0.3,
        vy: (Math.random() - 0.5) * 6 - v.y * 0.3,
        life: 0.5, maxLife: 0.5,
        color: ['#ffd23b', '#ff8c1a', '#fff3b0'][i % 3],
        size: 3 + Math.random() * 3,
        kind: 'spark',
      });
    }
    setAbilityHint('BOOST ENGAGED!');
    announce('Chuck goes supersonic!');
  };

  const triggerBomb = (fb: NonNullable<typeof flyingBirdRef.current>) => {
    if (fb.abilityUsed || fb.type !== 'black') return;
    fb.abilityUsed = true;
    const cx = fb.body.position.x;
    const cy = fb.body.position.y;
    const radius = 130;
    sfx.bomb();
    // Radial impulse to nearby bodies
    const allBodies = Matter.Composite.allBodies(engineRef.current!.world);
    for (const b of allBodies) {
      if (b.isStatic && b.label !== 'target_left' && b.label !== 'target_right') continue;
      const dx = b.position.x - cx;
      const dy = b.position.y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < radius && dist > 0) {
        const force = (1 - dist / radius) * 0.4;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force - 0.05;
        if (!b.isStatic) {
          Matter.Body.applyForce(b, b.position, { x: fx, y: fy });
        }
        // Damage nearby blocks heavily
        damageBlock(b, 18 * (1 - dist / radius) + 4);
        // Damage target
        const tgt = targetsRef.current.find((t) => t.body === b);
        if (tgt) {
          tgt.hp -= 25 * (1 - dist / radius) + 5;
          updateTargetHpState();
        }
      }
    }
    // Explosion particles
    for (let i = 0; i < 60; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 2 + Math.random() * 8;
      particlesRef.current.push({
        x: cx, y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 0.9, maxLife: 0.9,
        color: ['#ff3b1a', '#ffb01a', '#ffd23b', '#1a1a1a', '#666'][i % 5],
        size: 3 + Math.random() * 5,
        kind: 'spark',
      });
    }
    // Smoke
    for (let i = 0; i < 20; i++) {
      particlesRef.current.push({
        x: cx + (Math.random() - 0.5) * 30,
        y: cy + (Math.random() - 0.5) * 30,
        vx: (Math.random() - 0.5) * 2,
        vy: -Math.random() * 2 - 0.5,
        life: 1.5, maxLife: 1.5,
        color: 'rgba(60,60,60,0.6)',
        size: 8 + Math.random() * 10,
        kind: 'smoke',
      });
    }
    setAbilityHint('BOOM!');
    announce('Bomb bird detonates the ramparts!');
    // Remove the bomb bird body
    Matter.World.remove(engineRef.current!.world, fb.body);
    flyingBirdRef.current = null;
    shotInProgressRef.current = false;
    scheduleTurnAdvance();
  };

  const updateTargetHpState = () => {
    const left = targetsRef.current.find((t) => t.side === 'left');
    const right = targetsRef.current.find((t) => t.side === 'right');
    setTargetHp({
      left: left ? Math.max(0, Math.round(left.hp)) : 0,
      right: right ? Math.max(0, Math.round(right.hp)) : 0,
    });
  };

  /* ---------------------------------------------------------
     TURN MANAGEMENT
     --------------------------------------------------------- */
  const scheduleTurnAdvance = () => {
    settleTimerRef.current = 90; // ~1.5s at 60fps
  };

  const advanceTurn = () => {
    // Check victory first
    const left = targetsRef.current.find((t) => t.side === 'left');
    const right = targetsRef.current.find((t) => t.side === 'right');
    const leftDead = !left || left.hp <= 0;
    const rightDead = !right || right.hp <= 0;

    if (leftDead || rightDead) {
      // Award point
      setScores((s) => {
        const ns = { ...s };
        if (rightDead && !leftDead) ns.p1 += 1;
        if (leftDead && !rightDead) ns.p2 += 1;
        return ns;
      });
      const lvl = levelRef.current;
      if (lvl < LEVELS.length - 1) {
        const nextLvl = lvl + 1;
        setTimeout(() => {
          channelRef.current?.send({ type: 'broadcast', event: 'NEXT_LEVEL', payload: { level: nextLvl } });
          proceedToNextLevel(nextLvl);
        }, 1400);
      } else {
        // Final game over
        setTimeout(() => {
          const w: 1 | 2 = (leftDead && !rightDead) ? 2 : (!leftDead && rightDead) ? 1 :
            (scores.p1 >= scores.p2 ? 1 : 2);
          setWinner(w);
          setScreen('gameover');
          channelRef.current?.send({ type: 'broadcast', event: 'GAME_OVER', payload: { winner: w } });
          if ((w === 1 && playerSideRef.current === 'left') || (w === 2 && playerSideRef.current === 'right')) {
            sfx.victory();
            announce('Victory! The siege is won!');
          } else {
            sfx.defeat();
            announce('Defeat… the castle has fallen.');
          }
        }, 1200);
      }
      return;
    }

    const nextTurn: Turn = turnRef.current === 1 ? 2 : 1;
    setTurn(nextTurn);
    turnRef.current = nextTurn;
    shotInProgressRef.current = false;
    setAbilityHint('');
    // Load next bird for next turn
    const birdList = nextTurn === 1 ? p1Birds : p2Birds;
    const nextType: BirdType = birdList[0] || 'red';
    setSelectedBird(nextType);
    loadBird(nextType, nextTurn);
    announce(`Player ${nextTurn}'s turn — choose your bird.`);
  };

  const proceedToNextLevel = (nextLvl: number) => {
    setLevel(nextLvl);
    levelRef.current = nextLvl;
    setTurn(1);
    turnRef.current = 1;
    setP1Birds(['red', 'yellow', 'black', 'red', 'yellow']);
    setP2Birds(['red', 'yellow', 'black', 'red', 'yellow']);
    setSelectedBird('red');
    setAnnouncement(`Advancing to ${LEVELS[nextLvl].name}…`);
    setTimeout(() => initPhysics(nextLvl), 200);
  };

  /* ---------------------------------------------------------
     INPUT HANDLING
     --------------------------------------------------------- */
  const getCanvasPos = (e: React.MouseEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    return {
      x: ((e as MouseEvent).clientX - rect.left) * scaleX,
      y: ((e as MouseEvent).clientY - rect.top) * scaleY,
    };
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (screen !== 'game') return;
    const pos = getCanvasPos(e);
    // Mid-air ability trigger
    if (flyingBirdRef.current && flyingBirdRef.current.launched && !flyingBirdRef.current.abilityUsed) {
      const fb = flyingBirdRef.current;
      if (fb.type === 'yellow') {
        triggerBoost(fb);
        channelRef.current?.send({ type: 'broadcast', event: 'TRIGGER_ABILITY', payload: { type: 'boost' } });
        return;
      } else if (fb.type === 'black') {
        triggerBomb(fb);
        channelRef.current?.send({ type: 'broadcast', event: 'TRIGGER_ABILITY', payload: { type: 'bomb' } });
        return;
      }
    }
    // Start slingshot drag only if it's player's turn
    const myTurn = (playerSideRef.current === 'left' && turnRef.current === 1) ||
                   (playerSideRef.current === 'right' && turnRef.current === 2);
    if (!myTurn || shotInProgressRef.current || !loadedBirdRef.current) return;
    const sling = playerSideRef.current === 'left' ? slingshotRef.current.left : slingshotRef.current.right;
    const dx = pos.x - sling.x;
    const dy = pos.y - sling.forkY;
    if (Math.hypot(dx, dy) < 120) {
      draggingRef.current = {
        active: true,
        startX: sling.x,
        startY: sling.forkY,
        curX: pos.x,
        curY: pos.y,
      };
      sfx.stretch();
    }
  };

  const onCanvasMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current.active) return;
    const pos = getCanvasPos(e);
    // Clamp drag distance
    const sling = playerSideRef.current === 'left' ? slingshotRef.current.left : slingshotRef.current.right;
    const dx = pos.x - sling.x;
    const dy = pos.y - sling.forkY;
    const dist = Math.hypot(dx, dy);
    const maxDrag = 110;
    const ratio = dist > maxDrag ? maxDrag / dist : 1;
    draggingRef.current.curX = sling.x + dx * ratio;
    draggingRef.current.curY = sling.y + dy * ratio;
    // Light stretch sound on movement
    if (Math.random() < 0.1) sfx.stretch();
  };

  const onCanvasMouseUp = () => {
    if (!draggingRef.current.active) return;
    const sling = playerSideRef.current === 'left' ? slingshotRef.current.left : slingshotRef.current.right;
    const dx = sling.x - draggingRef.current.curX;
    const dy = sling.forkY - draggingRef.current.curY;
    const power = 0.22;
    draggingRef.current.active = false;
    if (Math.hypot(dx, dy) < 15) return; // too small
    fireBird(dx * power, dy * power);
  };

  /* ---------------------------------------------------------
     RENDER LOOP
     --------------------------------------------------------- */
  const startRenderLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    let lastTime = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      updateParticles(dt);
      updateFlyingBirdTrail();
      checkTargetHitsByBird();
      checkBirdRest();
      if (settleTimerRef.current > 0) {
        settleTimerRef.current -= 1;
        if (settleTimerRef.current === 0) advanceTurn();
      }
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const updateParticles = (dt: number) => {
    const arr = particlesRef.current;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.kind === 'smoke' ? -0.04 : 0.18;
      p.vx *= 0.98;
      p.life -= dt;
      if (p.life <= 0) arr.splice(i, 1);
    }
    if (arr.length > 500) arr.splice(0, arr.length - 500);
  };

  const updateFlyingBirdTrail = () => {
    const fb = flyingBirdRef.current;
    if (!fb) return;
    fb.trail.push({ x: fb.body.position.x, y: fb.body.position.y });
    if (fb.trail.length > 20) fb.trail.shift();
    // Spawn feather/smoke
    if (Math.random() < 0.5) {
      const colorMap: Record<BirdType, string> = {
        red: '#e23b2e', yellow: '#ffd23b', black: '#444',
      };
      particlesRef.current.push({
        x: fb.body.position.x, y: fb.body.position.y,
        vx: (Math.random() - 0.5) * 1,
        vy: (Math.random() - 0.5) * 1 + 0.2,
        life: 0.6, maxLife: 0.6,
        color: colorMap[fb.type],
        size: 2 + Math.random() * 2,
        kind: 'feather',
      });
    }
  };

  const checkTargetHitsByBird = () => {
    const fb = flyingBirdRef.current;
    if (!fb) return;
    for (const t of targetsRef.current) {
      if (t.hp <= 0) continue;
      const d = Math.hypot(fb.body.position.x - t.x, fb.body.position.y - t.y);
      if (d < t.r + BIRD_INFO[fb.type].radius) {
        const speed = Math.hypot(fb.body.velocity.x, fb.body.velocity.y);
        if (speed > 4) {
          t.hp -= speed * 1.2;
          updateTargetHpState();
          sfx.impact(2);
          // Particles
          for (let i = 0; i < 16; i++) {
            particlesRef.current.push({
              x: t.x, y: t.y,
              vx: (Math.random() - 0.5) * 6,
              vy: (Math.random() - 0.5) * 6 - 2,
              life: 0.8, maxLife: 0.8,
              color: ['#7ccb34', '#a8e65a', '#fff'][i % 3],
              size: 3 + Math.random() * 3,
              kind: 'spark',
            });
          }
          announce('Direct hit on the royal target!');
        }
      }
    }
  };

  const checkBirdRest = () => {
    const fb = flyingBirdRef.current;
    if (!fb || !fb.launched || shotInProgressRef.current === false) return;
    const v = fb.body.velocity;
    const speed = Math.hypot(v.x, v.y);
    const offScreen = fb.body.position.x < -50 || fb.body.position.x > W + 50 ||
                      fb.body.position.y > H + 100;
    if (speed < 0.4 || offScreen) {
      Matter.World.remove(engineRef.current!.world, fb.body);
      flyingBirdRef.current = null;
      shotInProgressRef.current = false;
      scheduleTurnAdvance();
    }
  };

  /* ---------------------------------------------------------
     DRAWING
     --------------------------------------------------------- */
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const lvl = LEVELS[levelRef.current];

    // Sky gradient
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, lvl.sky[0]);
    grad.addColorStop(1, lvl.sky[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    drawScenery(ctx, lvl.theme);

    // Ground
    ctx.fillStyle = lvl.ground;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, GROUND_Y, W, 6);

    // Slingshots
    drawSlingshot(ctx, slingshotRef.current.left, 'left');
    drawSlingshot(ctx, slingshotRef.current.right, 'right');

    // Loaded bird (on player's side if it's their turn)
    if (loadedBirdRef.current) {
      drawSlingshotBird(ctx, loadedBirdRef.current.type, loadedBirdRef.current.x, loadedBirdRef.current.y);
    }

    // Drag rubber bands + trajectory
    if (draggingRef.current.active) {
      const sling = playerSideRef.current === 'left' ? slingshotRef.current.left : slingshotRef.current.right;
      const dx = sling.x - draggingRef.current.curX;
      const dy = sling.forkY - draggingRef.current.curY;
      drawRubberBands(ctx, sling, draggingRef.current.curX, draggingRef.current.curY);
      drawTrajectory(ctx, draggingRef.current.curX, draggingRef.current.curY, dx * 0.22, dy * 0.22, lvl);
      // Bird at drag position
      if (loadedBirdRef.current) {
        drawBird(ctx, loadedBirdRef.current.type, draggingRef.current.curX, draggingRef.current.curY, 0);
      }
    }

    // Blocks
    for (const b of blocksRef.current) drawBlock(ctx, b);

    // Targets
    for (const t of targetsRef.current) drawTarget(ctx, t, lvl.theme);

    // Flying bird + trail
    const fb = flyingBirdRef.current;
    if (fb) {
      drawBirdTrail(ctx, fb);
      drawBird(ctx, fb.type, fb.body.position.x, fb.body.position.y, fb.body.angle, fb.abilityUsed);
    }

    // Particles
    for (const p of particlesRef.current) drawParticle(ctx, p);

    // Turn indicator arrow
    drawTurnIndicator(ctx);

    // Crosswind indicator
    if (Math.abs(lvl.crosswind) > 0.001) {
      drawWindIndicator(ctx, lvl.crosswind);
    }
  };

  const drawScenery = (ctx: CanvasRenderingContext2D, theme: LevelConfig['theme']) => {
    if (theme === 'meadow') {
      // Clouds
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 4; i++) {
        const cx = 200 + i * 320;
        const cy = 90 + (i % 2) * 40;
        ctx.beginPath();
        ctx.arc(cx, cy, 28, 0, Math.PI * 2);
        ctx.arc(cx + 30, cy + 6, 22, 0, Math.PI * 2);
        ctx.arc(cx - 26, cy + 6, 20, 0, Math.PI * 2);
        ctx.fill();
      }
      // Distant hills
      ctx.fillStyle = '#7fbf5a';
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      for (let x = 0; x <= W; x += 40) {
        ctx.lineTo(x, GROUND_Y - 50 - Math.sin(x * 0.01) * 25 - Math.cos(x * 0.005) * 15);
      }
      ctx.lineTo(W, GROUND_Y);
      ctx.fill();
    } else if (theme === 'glacial') {
      // Mountains
      ctx.fillStyle = '#9bc4dd';
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      for (let x = 0; x <= W; x += 80) {
        const peak = GROUND_Y - 200 - Math.abs(Math.sin(x * 0.01)) * 120;
        ctx.lineTo(x, peak);
      }
      ctx.lineTo(W, GROUND_Y);
      ctx.fill();
      // Snow caps
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      for (let x = 0; x <= W; x += 80) {
        const peak = GROUND_Y - 200 - Math.abs(Math.sin(x * 0.01)) * 120;
        ctx.lineTo(x, peak + 30);
      }
      ctx.lineTo(W, GROUND_Y);
      ctx.fill();
      // Falling snow
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      const t = performance.now() * 0.001;
      for (let i = 0; i < 60; i++) {
        const x = (i * 137 + t * 30) % W;
        const y = (i * 73 + t * 50) % H;
        ctx.fillRect(x, y, 2, 2);
      }
    } else if (theme === 'volcanic') {
      // Lava glow
      const lg = ctx.createRadialGradient(W / 2, GROUND_Y, 50, W / 2, GROUND_Y, 500);
      lg.addColorStop(0, 'rgba(255,80,0,0.45)');
      lg.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, W, H);
      // Distant volcano
      ctx.fillStyle = '#1a0808';
      ctx.beginPath();
      ctx.moveTo(W * 0.3, GROUND_Y);
      ctx.lineTo(W * 0.5, GROUND_Y - 220);
      ctx.lineTo(W * 0.7, GROUND_Y);
      ctx.fill();
      // Lava streams
      ctx.fillStyle = '#ff5a1a';
      ctx.beginPath();
      ctx.moveTo(W * 0.46, GROUND_Y - 150);
      ctx.lineTo(W * 0.48, GROUND_Y - 100);
      ctx.lineTo(W * 0.5, GROUND_Y - 150);
      ctx.fill();
      // Embers
      ctx.fillStyle = 'rgba(255,140,40,0.7)';
      const t = performance.now() * 0.002;
      for (let i = 0; i < 40; i++) {
        const x = (i * 167 + t * 60) % W;
        const y = H - ((i * 91 + t * 80) % H);
        ctx.fillRect(x, y, 2, 2);
      }
    }
  };

  const drawSlingshot = (
    ctx: CanvasRenderingContext2D,
    sling: { x: number; y: number; forkY: number },
    _side: 'left' | 'right'
  ) => {
    const forkY = sling.forkY;
    // Base trunk
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(sling.x - 12, forkY + 10, 24, sling.y - forkY - 10);
    // Wood grain
    ctx.strokeStyle = '#3a2410';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(sling.x - 10 + i * 7, forkY + 15);
      ctx.lineTo(sling.x - 10 + i * 7, sling.y - 5);
      ctx.stroke();
    }
    // Y fork
    ctx.strokeStyle = '#6a4520';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sling.x, forkY + 14);
    ctx.lineTo(sling.x - 22, forkY - 12);
    ctx.moveTo(sling.x, forkY + 14);
    ctx.lineTo(sling.x + 22, forkY - 12);
    ctx.stroke();
    // Fork tips (darker)
    ctx.fillStyle = '#4a2e12';
    ctx.beginPath();
    ctx.arc(sling.x - 22, forkY - 12, 7, 0, Math.PI * 2);
    ctx.arc(sling.x + 22, forkY - 12, 7, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawSlingshotBird = (ctx: CanvasRenderingContext2D, type: BirdType, x: number, y: number) => {
    drawBird(ctx, type, x, y, 0);
  };

  const drawRubberBands = (
    ctx: CanvasRenderingContext2D,
    sling: { x: number; y: number; forkY: number },
    bx: number, by: number
  ) => {
    ctx.strokeStyle = '#3a1a0a';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sling.x - 22, sling.forkY - 12);
    ctx.lineTo(bx - 8, by);
    ctx.moveTo(sling.x + 22, sling.forkY - 12);
    ctx.lineTo(bx + 8, by);
    ctx.stroke();
    // Highlight
    ctx.strokeStyle = '#7a3a1a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sling.x - 22, sling.forkY - 12);
    ctx.lineTo(bx - 8, by);
    ctx.moveTo(sling.x + 22, sling.forkY - 12);
    ctx.lineTo(bx + 8, by);
    ctx.stroke();
  };

  const drawTrajectory = (
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    vx: number, vy: number,
    lvl: LevelConfig
  ) => {
    const g = lvl.gravity * 1.0; // Matter.js gravity scale approx
    const wind = lvl.crosswind;
    let px = x, py = y;
    let pvx = vx, pvy = vy;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 20; i++) {
      // Simulate
      const stepsPerDot = 4;
      for (let s = 0; s < stepsPerDot; s++) {
        pvy += g * 0.5; // approximate gravity per step
        pvx += wind * 2;
        px += pvx;
        py += pvy;
      }
      const r = 4 - i * 0.12;
      if (r > 0.5) {
        ctx.beginPath();
        ctx.globalAlpha = 1 - i / 22;
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  const drawBird = (
    ctx: CanvasRenderingContext2D,
    type: BirdType,
    x: number, y: number,
    angle: number = 0,
    abilityUsed = false
  ) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const r = BIRD_INFO[type].radius;

    if (type === 'red') {
      // Body
      const g = ctx.createRadialGradient(-4, -4, 2, 0, 0, r);
      g.addColorStop(0, '#ff6a4a');
      g.addColorStop(1, '#c12018');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // Belly
      ctx.fillStyle = '#f4d4b0';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.35, r * 0.55, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-5, -3, 5, 0, Math.PI * 2);
      ctx.arc(5, -3, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(-4, -3, 2, 0, Math.PI * 2);
      ctx.arc(6, -3, 2, 0, Math.PI * 2);
      ctx.fill();
      // Angry eyebrows
      ctx.strokeStyle = '#3a0808';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(-2, -6);
      ctx.moveTo(10, -10);
      ctx.lineTo(2, -6);
      ctx.stroke();
      // Beak
      ctx.fillStyle = '#ffa01a';
      ctx.beginPath();
      ctx.moveTo(-4, 3);
      ctx.lineTo(6, 5);
      ctx.lineTo(-4, 8);
      ctx.closePath();
      ctx.fill();
      // Tail feather
      ctx.fillStyle = '#c12018';
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(-r - 8, -6);
      ctx.lineTo(-r - 8, 6);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'yellow') {
      // Triangular body
      const g = ctx.createLinearGradient(0, -r, 0, r);
      g.addColorStop(0, '#ffe85a');
      g.addColorStop(1, '#e8a800');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-r, r * 0.6);
      ctx.lineTo(r * 1.1, 0);
      ctx.lineTo(-r, -r * 0.6);
      ctx.closePath();
      ctx.fill();
      // Belly
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.2, r * 0.4, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(2, -4, 4, 0, Math.PI * 2);
      ctx.arc(8, -2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(3, -4, 1.6, 0, Math.PI * 2);
      ctx.arc(8, -2, 1.4, 0, Math.PI * 2);
      ctx.fill();
      // Eyebrows
      ctx.strokeStyle = '#5a3a00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-2, -10);
      ctx.lineTo(6, -7);
      ctx.moveTo(8, -7);
      ctx.lineTo(13, -5);
      ctx.stroke();
      // Beak
      ctx.fillStyle = '#ff8c1a';
      ctx.beginPath();
      ctx.moveTo(r * 0.7, 2);
      ctx.lineTo(r * 1.1, 4);
      ctx.lineTo(r * 0.7, 7);
      ctx.closePath();
      ctx.fill();
      // Speed lines if boosted
      if (abilityUsed) {
        ctx.strokeStyle = 'rgba(255,200,40,0.8)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(-r - 4 - i * 6, -6 + i * 4);
          ctx.lineTo(-r - 14 - i * 6, -6 + i * 4);
          ctx.stroke();
        }
      }
    } else if (type === 'black') {
      // Body
      const g = ctx.createRadialGradient(-4, -4, 2, 0, 0, r);
      g.addColorStop(0, '#5a5a5a');
      g.addColorStop(1, '#1a1a1a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // Fuse
      ctx.strokeStyle = '#8a6a3a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(6, -r - 8, 10, -r - 12);
      ctx.stroke();
      // Sparking fuse if not yet used
      if (!abilityUsed) {
        const flicker = Math.random() > 0.5 ? '#ffd23b' : '#ff8c1a';
        ctx.fillStyle = flicker;
        ctx.beginPath();
        ctx.arc(10, -r - 12, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-4, -2, 4, 0, Math.PI * 2);
      ctx.arc(4, -2, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(-3, -2, 1.6, 0, Math.PI * 2);
      ctx.arc(5, -2, 1.6, 0, Math.PI * 2);
      ctx.fill();
      // Eyebrows
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-9, -8);
      ctx.lineTo(-1, -5);
      ctx.moveTo(9, -8);
      ctx.lineTo(1, -5);
      ctx.stroke();
      // Beak
      ctx.fillStyle = '#ffa01a';
      ctx.beginPath();
      ctx.moveTo(-3, 4);
      ctx.lineTo(5, 6);
      ctx.lineTo(-3, 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  const drawBirdTrail = (ctx: CanvasRenderingContext2D, fb: NonNullable<typeof flyingBirdRef.current>) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < fb.trail.length; i++) {
      const p = fb.trail[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  };

  const drawBlock = (ctx: CanvasRenderingContext2D, b: Block) => {
    const { body, type, w, h } = b;
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    const damageRatio = Math.max(0, b.hp / b.maxHp);

    if (type === 'wood') {
      ctx.fillStyle = '#b8762e';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#7a4a18';
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      // Plank lines
      ctx.strokeStyle = '#8a5520';
      ctx.lineWidth = 1;
      const planks = Math.max(1, Math.floor(h / 18));
      for (let i = 1; i < planks; i++) {
        const y = -h / 2 + (i * h) / planks;
        ctx.beginPath();
        ctx.moveTo(-w / 2, y);
        ctx.lineTo(w / 2, y);
        ctx.stroke();
      }
      // Knots
      ctx.fillStyle = '#5a3a10';
      ctx.beginPath();
      ctx.arc(-w / 4, 0, 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'stone') {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#5a5a5a';
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      // Brick pattern
      ctx.strokeStyle = '#6a6a6a';
      ctx.lineWidth = 1;
      const rows = Math.max(1, Math.floor(h / 14));
      const cols = Math.max(1, Math.floor(w / 22));
      for (let r = 0; r < rows; r++) {
        const y = -h / 2 + ((r + 0.5) * h) / rows;
        ctx.beginPath();
        ctx.moveTo(-w / 2, y);
        ctx.lineTo(w / 2, y);
        ctx.stroke();
      }
      for (let c = 0; c < cols; c++) {
        const x = -w / 2 + ((c + 0.5) * w) / cols;
        ctx.beginPath();
        ctx.moveTo(x, -h / 2);
        ctx.lineTo(x, h / 2);
        ctx.stroke();
      }
    } else if (type === 'ice') {
      ctx.fillStyle = 'rgba(160, 220, 255, 0.85)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#7ac8f0';
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      // Shine
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w * 0.3, 3);
      // Cracks based on damage
      if (damageRatio < 0.7) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-w / 4, -h / 2);
        ctx.lineTo(0, 0);
        ctx.lineTo(-w / 6, h / 2);
        ctx.stroke();
      }
    } else if (type === 'obsidian') {
      ctx.fillStyle = '#1a0a14';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#3a1a24';
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      // Glowing veins
      ctx.strokeStyle = '#ff3a1a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + 4, -h / 4);
      ctx.lineTo(w / 4, h / 4);
      ctx.moveTo(-w / 6, -h / 2 + 4);
      ctx.lineTo(w / 6, h / 2 - 4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,80,40,0.4)';
      ctx.fillRect(-w / 2, -h / 2, w, 2);
    }

    // Damage cracks overlay
    if (damageRatio < 0.5 && type !== 'ice') {
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-w / 4, -h / 2);
      ctx.lineTo(0, 0);
      ctx.lineTo(w / 4, h / 2);
      ctx.moveTo(w / 4, -h / 2);
      ctx.lineTo(0, 0);
      ctx.lineTo(-w / 4, h / 2);
      ctx.stroke();
    }

    ctx.restore();
  };

  const drawTarget = (ctx: CanvasRenderingContext2D, t: CastleTarget, theme: LevelConfig['theme']) => {
    ctx.save();
    ctx.translate(t.x, t.y);
    const hpRatio = Math.max(0, t.hp / t.maxHp);

    if (theme === 'volcanic') {
      // Heart crystal
      ctx.fillStyle = '#ff2a4a';
      ctx.beginPath();
      ctx.moveTo(0, t.r * 0.7);
      ctx.bezierCurveTo(-t.r, 0, -t.r * 0.6, -t.r, 0, -t.r * 0.3);
      ctx.bezierCurveTo(t.r * 0.6, -t.r, t.r, 0, 0, t.r * 0.7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.ellipse(-t.r * 0.3, -t.r * 0.3, 3, 5, 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Pig
      // Body
      const g = ctx.createRadialGradient(-4, -4, 2, 0, 0, t.r);
      g.addColorStop(0, '#a8e65a');
      g.addColorStop(1, '#5a9020');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, t.r, 0, Math.PI * 2);
      ctx.fill();
      // Ears
      ctx.fillStyle = '#7acb34';
      ctx.beginPath();
      ctx.moveTo(-t.r * 0.7, -t.r * 0.6);
      ctx.lineTo(-t.r * 0.4, -t.r * 1.1);
      ctx.lineTo(-t.r * 0.3, -t.r * 0.6);
      ctx.moveTo(t.r * 0.7, -t.r * 0.6);
      ctx.lineTo(t.r * 0.4, -t.r * 1.1);
      ctx.lineTo(t.r * 0.3, -t.r * 0.6);
      ctx.fill();
      // Snout
      ctx.fillStyle = '#7acb34';
      ctx.beginPath();
      ctx.ellipse(0, t.r * 0.25, t.r * 0.5, t.r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      // Nostrils
      ctx.fillStyle = '#3a6010';
      ctx.beginPath();
      ctx.arc(-4, t.r * 0.25, 2, 0, Math.PI * 2);
      ctx.arc(4, t.r * 0.25, 2, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-6, -4, 4, 0, Math.PI * 2);
      ctx.arc(6, -4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(-5, -4, 1.8, 0, Math.PI * 2);
      ctx.arc(7, -4, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // HP bar
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(-t.r, -t.r - 14, t.r * 2, 5);
    ctx.fillStyle = hpRatio > 0.5 ? '#7acb34' : hpRatio > 0.25 ? '#ffd23b' : '#e23b2e';
    ctx.fillRect(-t.r, -t.r - 14, t.r * 2 * hpRatio, 5);

    ctx.restore();
  };

  const drawParticle = (ctx: CanvasRenderingContext2D, p: Particle) => {
    const alpha = Math.max(0, p.life / p.maxLife);
    ctx.globalAlpha = alpha;
    if (p.kind === 'smoke') {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1.4 - alpha * 0.4), 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === 'feather') {
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 6);
      ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2);
      ctx.restore();
    } else if (p.kind === 'ice') {
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 4);
      ctx.beginPath();
      ctx.moveTo(0, -p.size);
      ctx.lineTo(p.size, 0);
      ctx.lineTo(0, p.size);
      ctx.lineTo(-p.size, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const drawTurnIndicator = (ctx: CanvasRenderingContext2D) => {
    const sling = turnRef.current === 1 ? slingshotRef.current.left : slingshotRef.current.right;
    const x = sling.x;
    const y = sling.forkY - 60;
    const bounce = Math.sin(performance.now() * 0.005) * 4;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 10, y - 14 + bounce);
    ctx.lineTo(x + 10, y - 14 + bounce);
    ctx.lineTo(x, y + bounce);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`P${turnRef.current}`, x, y - 20 + bounce);
  };

  const drawWindIndicator = (ctx: CanvasRenderingContext2D, wind: number) => {
    const x = W / 2;
    const y = 40;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x - 80, y - 14, 160, 28);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`WIND ${wind > 0 ? '→' : '←'} ${Math.abs(wind * 100).toFixed(1)}`, x, y + 4);
  };

  /* ---------------------------------------------------------
     UI ACTIONS
     --------------------------------------------------------- */
  const handleSelectBird = (b: BirdType) => {
    if (shotInProgressRef.current) return;
    const myTurn = (playerSideRef.current === 'left' && turnRef.current === 1) ||
                   (playerSideRef.current === 'right' && turnRef.current === 2);
    if (!myTurn) return;
    setSelectedBird(b);
    if (loadedBirdRef.current) loadedBirdRef.current.type = b;
    sfx.ui();
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
    if (engineRef.current) {
      if (runnerRef.current) Matter.Runner.stop(runnerRef.current);
      Matter.World.clear(engineRef.current.world, false);
      Matter.Engine.clear(engineRef.current);
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const handleRematch = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (engineRef.current) {
      if (runnerRef.current) Matter.Runner.stop(runnerRef.current);
      Matter.World.clear(engineRef.current.world, false);
      Matter.Engine.clear(engineRef.current);
    }
    
    // Broadcast rematch start to the same room
    channelRef.current?.send({
      type: 'broadcast', 
      event: 'START_GAME', 
      payload: { level: 0 }
    });
    
    startGame(0, playerSideRef.current);
  };

  /* ---------------------------------------------------------
     LIFECYCLE
     --------------------------------------------------------- */
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (engineRef.current) {
        if (runnerRef.current) Matter.Runner.stop(runnerRef.current);
        Matter.World.clear(engineRef.current.world, false);
        Matter.Engine.clear(engineRef.current);
      }
      if (channelRef.current) {
        try { channelRef.current.unsubscribe(); } catch {}
      }
      if (audioRef.current) {
        try { audioRef.current.close(); } catch {}
      }
    };
  }, []);

  /* ---------------------------------------------------------
     RENDER JSX
     --------------------------------------------------------- */
  const myTurn =
    (playerSideRef.current === 'left' && turn === 1) ||
    (playerSideRef.current === 'right' && turn === 2);

  return (
    <div className="relative w-full h-full min-h-[640px] flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 text-white select-none">
      {screen === 'menu' && (
        <div className="w-full max-w-2xl p-8 text-center space-y-8">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-red-600/20 border border-red-500/40 text-red-300 text-sm font-semibold">
              <Flame className="w-4 h-4" />
              MULTIPLAYER SIEGE DUEL
            </div>
            <h1 className="text-5xl md:text-6xl font-black tracking-tight bg-gradient-to-r from-red-400 via-yellow-300 to-orange-400 bg-clip-text text-transparent">
              Angry Siege
            </h1>
            <p className="text-slate-400 text-lg">
              Castles will crumble. Birds will fly. Only one siege captain survives.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <button
              onClick={createRoom}
              className="group p-6 rounded-2xl bg-gradient-to-br from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 transition-all hover:scale-[1.02] shadow-lg shadow-red-900/40 text-left"
            >
              <Shield className="w-8 h-8 mb-3 text-white" />
              <div className="text-xl font-bold">Host a Siege</div>
              <div className="text-sm text-white/80">Create a room & await your rival</div>
            </button>

            <div className="p-6 rounded-2xl bg-slate-800/80 border border-slate-700 space-y-3">
              <Target className="w-8 h-8 text-yellow-400" />
              <div className="text-xl font-bold">Join a Siege</div>
              <input
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4-digit code"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-center text-2xl tracking-[0.5em] font-bold focus:outline-none focus:border-yellow-400"
              />
              <button
                onClick={joinRoom}
                disabled={inputCode.length !== 4}
                className="w-full px-4 py-2 rounded-lg bg-yellow-500 hover:bg-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-900 font-bold transition-colors"
              >
                Join Battle
              </button>
              {error && <div className="text-red-400 text-sm">{error}</div>}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700">
              <Zap className="w-4 h-4 text-yellow-400 mx-auto mb-1" />
              <div className="font-semibold">3 Bird Types</div>
              <div className="text-slate-400 text-xs">Red, Chuck, Bomb</div>
            </div>
            <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700">
              <Wind className="w-4 h-4 text-blue-400 mx-auto mb-1" />
              <div className="font-semibold">3 Levels</div>
              <div className="text-slate-400 text-xs">Meadow, Ice, Volcano</div>
            </div>
            <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700">
              <Sparkles className="w-4 h-4 text-purple-400 mx-auto mb-1" />
              <div className="font-semibold">AI Announcer</div>
              <div className="text-slate-400 text-xs">Live commentary</div>
            </div>
          </div>
        </div>
      )}

      {screen === 'lobby' && (
        <div className="w-full max-w-md p-8 text-center space-y-6">
          <div className="space-y-2">
            <h2 className="text-3xl font-bold">{isHost ? 'Waiting for rival…' : 'Joining siege…'}</h2>
            <p className="text-slate-400">
              {isHost ? 'Share this code with your opponent:' : 'Connecting to room:'}
            </p>
          </div>
          <div className="py-6 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-dashed border-yellow-500/50">
            <div className="text-6xl font-black tracking-[0.3em] text-yellow-400">
              {roomCode}
            </div>
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
          <button
            onClick={handleRestart}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm"
          >
            ← Back to menu
          </button>
        </div>
      )}

      {screen === 'game' && (
        <div className="w-full h-full flex flex-col">
          {/* Top HUD */}
          <div className="flex-shrink-0 px-4 py-2 bg-slate-900/90 backdrop-blur border-b border-slate-700 flex items-center gap-4 text-sm">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-lg ${turn === 1 ? 'bg-red-600/40 border border-red-500/60' : 'bg-slate-800/60'}`}>
              <Shield className="w-4 h-4 text-red-400" />
              <span className="font-bold">P1</span>
              <span className="text-slate-400">{scores.p1} pts</span>
              <div className="flex gap-1 ml-1">
                {p1Birds.slice(0, 4).map((b, i) => (
                  <div key={i} className={`w-3 h-3 rounded-full ${b === 'red' ? 'bg-red-500' : b === 'yellow' ? 'bg-yellow-400' : 'bg-slate-700'}`} />
                ))}
              </div>
            </div>

            <div className="flex-1 text-center">
              <div className="text-xs text-slate-400">{LEVELS[level].subtitle}</div>
              <div className="font-bold text-yellow-300">{LEVELS[level].name}</div>
            </div>

            <div className={`flex items-center gap-2 px-3 py-1 rounded-lg ${turn === 2 ? 'bg-blue-600/40 border border-blue-500/60' : 'bg-slate-800/60'}`}>
              <div className="flex gap-1 mr-1">
                {p2Birds.slice(0, 4).map((b, i) => (
                  <div key={i} className={`w-3 h-3 rounded-full ${b === 'red' ? 'bg-red-500' : b === 'yellow' ? 'bg-yellow-400' : 'bg-slate-700'}`} />
                ))}
              </div>
              <span className="text-slate-400">{scores.p2} pts</span>
              <span className="font-bold">P2</span>
              <Shield className="w-4 h-4 text-blue-400" />
            </div>

            <button
              onClick={() => setMuted((m) => !m)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700"
              title={muted ? 'Unmute' : 'Mute'}
            >
              <Volume2 className={`w-4 h-4 ${muted ? 'text-slate-500' : 'text-white'}`} />
            </button>
          </div>

          {/* Target HP bars */}
          <div className="flex-shrink-0 px-4 py-1 bg-slate-950/80 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="text-red-400 font-bold">LEFT CASTLE</span>
              <div className="w-32 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all" style={{ width: `${targetHp.left}%` }} />
              </div>
              <span className="text-slate-400">{targetHp.left}%</span>
            </div>
            <div className="text-yellow-300 font-semibold px-3 py-0.5 rounded bg-slate-900/80 border border-yellow-500/30">
              {myTurn ? '🎯 YOUR TURN' : `⏳ Player ${turn} aiming…`}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">{targetHp.right}%</span>
              <div className="w-32 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-400 to-blue-600 transition-all" style={{ width: `${targetHp.right}%` }} />
              </div>
              <span className="text-blue-400 font-bold">RIGHT CASTLE</span>
            </div>
          </div>

          {/* Canvas */}
          <div className="flex-1 relative bg-black overflow-hidden">
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
              className="w-full h-full object-contain cursor-crosshair"
              style={{ aspectRatio: `${W}/${H}` }}
            />

            {/* Announcement banner */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 max-w-[60%] pointer-events-none">
              <div className="px-4 py-2 rounded-full bg-black/70 backdrop-blur border border-yellow-500/40 text-yellow-200 text-sm font-semibold text-center truncate">
                <Sparkles className="inline w-3.5 h-3.5 mr-1.5 text-yellow-400" />
                {announcement}
              </div>
            </div>

            {/* Ability hint */}
            {abilityHint && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none">
                <div className="px-4 py-2 rounded-lg bg-orange-600/90 border border-orange-400 text-white font-bold animate-pulse">
                  {abilityHint}
                </div>
              </div>
            )}
          </div>

          {/* Bird selector */}
          <div className="flex-shrink-0 px-4 py-3 bg-slate-900/90 border-t border-slate-700 flex items-center justify-center gap-3">
            <span className="text-xs text-slate-400 mr-2">BIRD:</span>
            {(['red', 'yellow', 'black'] as BirdType[]).map((b) => (
              <button
                key={b}
                onClick={() => handleSelectBird(b)}
                disabled={!myTurn || shotInProgressRef.current}
                className={`relative px-4 py-2 rounded-xl border-2 transition-all ${
                  selectedBird === b
                    ? 'border-yellow-400 bg-yellow-400/20 scale-105'
                    : 'border-slate-700 bg-slate-800 hover:bg-slate-700'
                } ${!myTurn || shotInProgressRef.current ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className={`w-8 h-8 rounded-full mx-auto mb-1 ${b === 'red' ? 'bg-red-500' : b === 'yellow' ? 'bg-yellow-400' : 'bg-slate-800 border border-slate-600'}`} />
                <div className="text-[10px] font-semibold">
                  {b === 'red' ? 'BREAKER' : b === 'yellow' ? 'SPEED' : 'BOMB'}
                </div>
              </button>
            ))}
            <div className="ml-4 text-xs text-slate-400 max-w-xs">
              {selectedBird === 'red' && 'High mass, balanced impact.'}
              {selectedBird === 'yellow' && 'Click mid-flight for SPEED BOOST.'}
              {selectedBird === 'black' && 'Click mid-flight for BLAST RADIUS.'}
            </div>
          </div>
        </div>
      )}

      {screen === 'gameover' && (
        <div className="w-full max-w-md p-8 text-center space-y-6">
          <div className="space-y-2">
            <Award className={`w-16 h-16 mx-auto ${winner === 1 ? 'text-red-400' : 'text-blue-400'}`} />
            <h2 className="text-4xl font-black">
              {winner === 1 ? 'PLAYER 1 VICTORIOUS' : 'PLAYER 2 VICTORIOUS'}
            </h2>
            <p className="text-slate-400">
              {((winner === 1 && playerSideRef.current === 'left') || (winner === 2 && playerSideRef.current === 'right'))
                ? 'Your siege tactics are unmatched!'
                : 'The enemy castle stands triumphant… this time.'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
              <div className="text-xs text-slate-400">Player 1</div>
              <div className="text-3xl font-bold text-red-400">{scores.p1}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
              <div className="text-xs text-slate-400">Player 2</div>
              <div className="text-3xl font-bold text-blue-400">{scores.p2}</div>
            </div>
          </div>
          <div className="px-4 py-3 rounded-xl bg-slate-800/60 border border-yellow-500/30 text-yellow-200 text-sm">
            {announcement}
          </div>
          
          <div className="flex flex-col gap-3">
            <button
              onClick={handleRematch}
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 font-bold transition-all"
            >
              <RotateCcw className="w-5 h-5" />
              Play Again / Rematch
            </button>
            <button
              onClick={handleRestart}
              className="inline-flex items-center justify-center gap-2 px-6 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold transition-all"
            >
              Disconnect & Return to Menu
            </button>
          </div>
        </div>
      )}
    </div>
  );
}