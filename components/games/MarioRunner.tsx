'use client';

import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { generateGameAnnounce } from '@/lib/groq';
import { Shield, Target, Play, RotateCcw, Volume2, Award, Zap, Flame, Wind, Sparkles, Heart, Crown, ArrowDown, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';

interface GameProps {
  roomCode?: string;
  playerRole?: 'p1' | 'p2';
  p1Name?: string;
  p2Name?: string;
}

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const CELL_SIZE = 30;
const RIVAL_CELL_SIZE = 14;

const TETROMINOES: Record<string, { shape: number[][]; color: string }> = {
  I: { shape: [[1, 1, 1, 1]], color: '#00e5ff' },
  J: { shape: [[1, 0, 0], [1, 1, 1]], color: '#3b82f6' },
  L: { shape: [[0, 0, 1], [1, 1, 1]], color: '#ff9500' },
  O: { shape: [[1, 1], [1, 1]], color: '#ffd700' },
  S: { shape: [[0, 1, 1], [1, 1, 0]], color: '#22c55e' },
  T: { shape: [[0, 1, 0], [1, 1, 1]], color: '#a855f7' },
  Z: { shape: [[1, 1, 0], [0, 1, 1]], color: '#ef4444' },
};

const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
const GARBAGE_COLOR = '#6b7280';

function mulberry32(seed: number) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createBoard(): (string | null)[][] {
  return Array.from({ length: BOARD_HEIGHT }, () =>
    Array<string | null>(BOARD_WIDTH).fill(null)
  );
}

function rotateMatrix(matrix: number[][]): number[][] {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result: number[][] = Array.from({ length: cols }, () =>
    Array(rows).fill(0)
  );
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      result[c][rows - 1 - r] = matrix[r][c];
    }
  }
  return result;
}

function generateBag(rng: () => number): string[] {
  const bag = [...PIECE_TYPES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

interface Piece {
  type: string;
  shape: number[][];
  color: string;
  x: number;
  y: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  maxLife: number;
  size: number;
}

export default function MarioRunner({
  roomCode: propRoomCode,
  playerRole: propPlayerRole,
  p1Name = 'Player 1',
  p2Name = 'Player 2',
}: GameProps) {
  const [gameState, setGameState] = useState<
    'menu' | 'connecting' | 'playing' | 'gameover' | 'won'
  >('menu');
  const [roomCode, setRoomCode] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(true);
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(1);
  const [rivalScore, setRivalScore] = useState(0);
  const [rivalLines, setRivalLines] = useState(0);
  const [rivalConnected, setRivalConnected] = useState(false);
  const [nextPieceType, setNextPieceType] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const [muted, setMuted] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [combo, setCombo] = useState(0);
  const [pendingGarbageDisplay, setPendingGarbageDisplay] = useState(0);

  const localCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rivalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const animationFrameRef = useRef<number>(0);
  const broadcastIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localBoardRef = useRef<(string | null)[][]>(createBoard());
  const rivalBoardRef = useRef<(string | null)[][]>(createBoard());
  const currentPieceRef = useRef<Piece | null>(null);
  const pieceQueueRef = useRef<string[]>([]);
  const rngRef = useRef<(() => number) | null>(null);
  const seedRef = useRef<number>(0);
  const pendingGarbageRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);
  const shakeRef = useRef(0);
  const flashRef = useRef(0);
  const gravityTimerRef = useRef(0);
  const dropSpeedRef = useRef(1000);
  const gameOverRef = useRef(false);
  const lastTimeRef = useRef(0);
  const mutedRef = useRef(false);
  const gameStateRef = useRef<string>('menu');
  const scoreRef = useRef(0);
  const linesRef = useRef(0);
  const comboRef = useRef(0);
  const tickRef = useRef<() => void>(() => {});

  const mobileDasTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileDasIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const myName = isHost ? p1Name : p2Name;
  const rivalName = isHost ? p2Name : p1Name;

  const ensureAudio = () => {
    if (typeof window === 'undefined') return;
    if (!audioContextRef.current) {
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        audioContextRef.current = new Ctx();
      } catch {}
    }
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }
  };

  const playSFX = (type: string) => {
    if (mutedRef.current) return;
    ensureAudio();
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;

    switch (type) {
      case 'move': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(180, now);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.04);
        break;
      }
      case 'rotate': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(500, now + 0.08);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      }
      case 'drop': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(40, now + 0.15);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
        break;
      }
      case 'lock': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.08);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      }
      case 'lineClear': {
        const freqs = [523, 659, 784, 1047];
        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.05);
          gain.gain.setValueAtTime(0.1, now + i * 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 0.25);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + i * 0.05);
          osc.stop(now + i * 0.05 + 0.25);
        });
        break;
      }
      case 'attack': {
        const bufferSize = Math.floor(ctx.sampleRate * 0.3);
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800, now);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        noise.connect(filter).connect(gain).connect(ctx.destination);
        noise.start(now);

        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(80, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.3);
        oscGain.gain.setValueAtTime(0.3, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(oscGain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
        break;
      }
      case 'gameOver': {
        const freqs = [392, 349, 311, 261];
        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(freq, now + i * 0.15);
          gain.gain.setValueAtTime(0.12, now + i * 0.15);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.3);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + i * 0.15);
          osc.stop(now + i * 0.15 + 0.3);
        });
        break;
      }
      case 'victory': {
        const freqs = [523, 659, 784, 1047, 1319];
        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now + i * 0.1);
          gain.gain.setValueAtTime(0.15, now + i * 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.4);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + i * 0.1);
          osc.stop(now + i * 0.1 + 0.4);
        });
        break;
      }
    }
  };

  const announceEvent = (event: string) => {
    generateGameAnnounce('Block Drop Battle', event)
      .then((msg) => {
        if (msg) {
          setAnnouncement(msg);
          if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
          announceTimerRef.current = setTimeout(() => setAnnouncement(''), 5000);
        }
      })
      .catch(() => {});
  };

  const collides = (
    board: (string | null)[][],
    piece: Piece,
    offsetX = 0,
    offsetY = 0,
    shape?: number[][]
  ): boolean => {
    const s = shape || piece.shape;
    for (let r = 0; r < s.length; r++) {
      for (let c = 0; c < s[r].length; c++) {
        if (s[r][c]) {
          const nx = piece.x + c + offsetX;
          const ny = piece.y + r + offsetY;
          if (nx < 0 || nx >= BOARD_WIDTH || ny >= BOARD_HEIGHT) return true;
          if (ny >= 0 && board[ny] && board[ny][nx] !== null) return true;
        }
      }
    }
    return false;
  };

  const mergePiece = (board: (string | null)[][], piece: Piece): (string | null)[][] => {
    const newBoard = board.map((row) => [...row]);
    for (let r = 0; r < piece.shape.length; r++) {
      for (let c = 0; c < piece.shape[r].length; c++) {
        if (piece.shape[r][c]) {
          const ny = piece.y + r;
          const nx = piece.x + c;
          if (ny >= 0 && ny < BOARD_HEIGHT && nx >= 0 && nx < BOARD_WIDTH) {
            newBoard[ny][nx] = piece.color;
          }
        }
      }
    }
    return newBoard;
  };

  const clearLines = (board: (string | null)[][]): { board: (string | null)[][]; cleared: number[] } => {
    const cleared: number[] = [];
    const newBoard: (string | null)[][] = [];
    for (let r = 0; r < board.length; r++) {
      if (board[r].every((cell) => cell !== null)) {
        cleared.push(r);
      } else {
        newBoard.push([...board[r]]);
      }
    }
    while (newBoard.length < BOARD_HEIGHT) {
      newBoard.unshift(Array<string | null>(BOARD_WIDTH).fill(null));
    }
    return { board: newBoard, cleared };
  };

  const spawnPiece = () => {
    const board = localBoardRef.current;

    if (pendingGarbageRef.current > 0) {
      const count = Math.min(pendingGarbageRef.current, BOARD_HEIGHT - 2);
      pendingGarbageRef.current = 0;
      setPendingGarbageDisplay(0);
      const gap = Math.floor((rngRef.current ? rngRef.current() : Math.random()) * BOARD_WIDTH);
      let overflow = false;
      for (let i = 0; i < count; i++) {
        if (board[i] && board[i].some((cell) => cell !== null)) {
          overflow = true;
          break;
        }
      }
      if (overflow) {
        handleGameOver();
        return;
      }
      const newBoard = board.slice(count);
      for (let i = 0; i < count; i++) {
        const row: (string | null)[] = Array(BOARD_WIDTH).fill(GARBAGE_COLOR);
        row[gap] = null;
        newBoard.push(row);
      }
      localBoardRef.current = newBoard;
      shakeRef.current = Math.min(20, shakeRef.current + count * 5);
      playSFX('attack');
    }

    if (!rngRef.current) return;

    while (pieceQueueRef.current.length < 7) {
      const newBag = generateBag(rngRef.current);
      pieceQueueRef.current = pieceQueueRef.current.concat(newBag);
    }

    const type = pieceQueueRef.current.shift()!;
    const tetro = TETROMINOES[type];
    const piece: Piece = {
      type,
      shape: tetro.shape.map((row) => [...row]),
      color: tetro.color,
      x: Math.floor((BOARD_WIDTH - tetro.shape[0].length) / 2),
      y: 0,
    };

    if (collides(localBoardRef.current, piece)) {
      handleGameOver();
      return;
    }

    currentPieceRef.current = piece;

    while (pieceQueueRef.current.length < 7) {
      const newBag = generateBag(rngRef.current);
      pieceQueueRef.current = pieceQueueRef.current.concat(newBag);
    }
    setNextPieceType(pieceQueueRef.current[0] || null);
  };

  const movePiece = (dx: number, dy: number, isSoftDrop: boolean) => {
    const piece = currentPieceRef.current;
    if (!piece || gameOverRef.current) return;
    const testPiece: Piece = { ...piece, x: piece.x + dx, y: piece.y + dy };
    if (!collides(localBoardRef.current, testPiece)) {
      currentPieceRef.current = testPiece;
      if (dx !== 0) playSFX('move');
      if (isSoftDrop) {
        scoreRef.current += 1;
        setScore(scoreRef.current);
      }
    } else if (dy > 0) {
      lockPiece();
    }
  };

  const rotateCurrent = () => {
    const piece = currentPieceRef.current;
    if (!piece || gameOverRef.current) return;
    if (piece.type === 'O') return;
    const rotated = rotateMatrix(piece.shape);
    const kicks = [0, -1, 1, -2, 2];
    for (const kick of kicks) {
      const testPiece: Piece = {
        ...piece,
        shape: rotated,
        x: piece.x + kick,
      };
      if (!collides(localBoardRef.current, testPiece)) {
        currentPieceRef.current = testPiece;
        playSFX('rotate');
        return;
      }
    }
  };

  const hardDrop = () => {
    const piece = currentPieceRef.current;
    if (!piece || gameOverRef.current) return;
    let dropDistance = 0;
    while (!collides(localBoardRef.current, { ...piece, y: piece.y + 1 })) {
      piece.y++;
      dropDistance++;
    }
    scoreRef.current += dropDistance * 2;
    setScore(scoreRef.current);
    playSFX('drop');
    lockPiece();
  };

  const lockPiece = () => {
    const piece = currentPieceRef.current;
    if (!piece) return;

    localBoardRef.current = mergePiece(localBoardRef.current, piece);
    playSFX('lock');

    const { board: newBoard, cleared } = clearLines(localBoardRef.current);
    localBoardRef.current = newBoard;

    if (cleared.length > 0) {
      playSFX('lineClear');
      cleared.forEach((rowIdx) => {
        for (let c = 0; c < BOARD_WIDTH; c++) {
          for (let p = 0; p < 3; p++) {
            particlesRef.current.push({
              x: c * CELL_SIZE + CELL_SIZE / 2,
              y: rowIdx * CELL_SIZE + CELL_SIZE / 2,
              vx: (Math.random() - 0.5) * 10,
              vy: -Math.random() * 8 - 2,
              color: piece.color,
              life: 700,
              maxLife: 700,
              size: 2 + Math.random() * 4,
            });
          }
        }
      });

      const points = [0, 100, 300, 500, 800][cleared.length];
      scoreRef.current += points;
      setScore(scoreRef.current);
      linesRef.current += cleared.length;
      setLines(linesRef.current);

      const newLevel = Math.floor(linesRef.current / 10) + 1;
      setLevel(newLevel);
      dropSpeedRef.current = Math.max(100, 1000 - (newLevel - 1) * 100);

      comboRef.current += 1;
      setCombo(comboRef.current);

      const garbageMap = [0, 0, 1, 2, 4];
      const garbageCount = garbageMap[cleared.length];

      if (cleared.length >= 2 && channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'GARBAGE',
          payload: { count: garbageCount },
        });
        playSFX('attack');
        shakeRef.current = Math.min(15, shakeRef.current + garbageCount * 2);
      }

      if (cleared.length === 4) {
        flashRef.current = 1;
        announceEvent('tetris');
      } else if (cleared.length === 3) {
        announceEvent('triple');
      } else if (cleared.length === 2) {
        announceEvent('double');
      } else {
        announceEvent('single');
      }

      if (comboRef.current >= 3) {
        announceEvent('combo');
      }
    } else {
      comboRef.current = 0;
      setCombo(0);
    }

    spawnPiece();
  };

  const handleGameOver = () => {
    if (gameOverRef.current) return;
    gameOverRef.current = true;
    setGameState('gameover');
    playSFX('gameOver');
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'GAME_OVER',
        payload: {},
      });
    }
    announceEvent('gameover');
  };

  const handleWin = () => {
    if (gameOverRef.current) return;
    gameOverRef.current = true;
    setGameState('won');
    playSFX('victory');
    announceEvent('victory');
  };

  const drawBlock = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) => {
    ctx.fillStyle = color;
    ctx.shadowBlur = size > 20 ? 10 : 4;
    ctx.shadowColor = color;
    ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + 2, y + 2, size - 4, Math.max(2, size * 0.12));
    ctx.fillRect(x + 2, y + 2, Math.max(2, size * 0.12), size - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 2, y + size - 2 - Math.max(2, size * 0.12), size - 4, Math.max(2, size * 0.12));
    ctx.fillRect(x + size - 2 - Math.max(2, size * 0.12), y + 2, Math.max(2, size * 0.12), size - 4);
  };

  const drawPiece = (ctx: CanvasRenderingContext2D, piece: Piece, cellSize: number, isGhost: boolean) => {
    for (let r = 0; r < piece.shape.length; r++) {
      for (let c = 0; c < piece.shape[r].length; c++) {
        if (piece.shape[r][c]) {
          const x = (piece.x + c) * cellSize;
          const y = (piece.y + r) * cellSize;
          if (isGhost) {
            ctx.strokeStyle = piece.color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.4;
            ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
            ctx.globalAlpha = 1;
          } else {
            drawBlock(ctx, x, y, cellSize, piece.color);
          }
        }
      }
    }
  };

  const drawBlocks = (ctx: CanvasRenderingContext2D, board: (string | null)[][], cellSize: number) => {
    for (let r = 0; r < BOARD_HEIGHT; r++) {
      for (let c = 0; c < BOARD_WIDTH; c++) {
        const cell = board[r] ? board[r][c] : null;
        if (cell) {
          drawBlock(ctx, c * cellSize, r * cellSize, cellSize, cell);
        }
      }
    }
  };

  const drawLocal = () => {
    const canvas = localCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const shakeX = (Math.random() - 0.5) * shakeRef.current;
    const shakeY = (Math.random() - 0.5) * shakeRef.current;

    ctx.save();
    ctx.translate(shakeX, shakeY);

    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(-20, -20, canvas.width + 40, canvas.height + 40);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= BOARD_WIDTH; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL_SIZE, 0);
      ctx.lineTo(i * CELL_SIZE, BOARD_HEIGHT * CELL_SIZE);
      ctx.stroke();
    }
    for (let i = 0; i <= BOARD_HEIGHT; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * CELL_SIZE);
      ctx.lineTo(BOARD_WIDTH * CELL_SIZE, i * CELL_SIZE);
      ctx.stroke();
    }

    drawBlocks(ctx, localBoardRef.current, CELL_SIZE);

    const piece = currentPieceRef.current;
    if (piece && !gameOverRef.current) {
      let ghostY = piece.y;
      while (!collides(localBoardRef.current, { ...piece, y: ghostY + 1 })) {
        ghostY++;
      }
      drawPiece(ctx, { ...piece, y: ghostY }, CELL_SIZE, true);
      drawPiece(ctx, piece, CELL_SIZE, false);
    }

    particlesRef.current.forEach((p) => {
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.shadowBlur = 8;
      ctx.shadowColor = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (flashRef.current > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flashRef.current * 0.4})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (pendingGarbageRef.current > 0) {
      const gb = pendingGarbageRef.current;
      ctx.fillStyle = 'rgba(239,68,68,0.3)';
      ctx.fillRect(0, canvas.height - gb * CELL_SIZE, 4, gb * CELL_SIZE);
    }

    ctx.restore();
  };

  const drawRival = () => {
    const canvas = rivalCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= BOARD_WIDTH; i++) {
      ctx.beginPath();
      ctx.moveTo(i * RIVAL_CELL_SIZE, 0);
      ctx.lineTo(i * RIVAL_CELL_SIZE, BOARD_HEIGHT * RIVAL_CELL_SIZE);
      ctx.stroke();
    }
    for (let i = 0; i <= BOARD_HEIGHT; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * RIVAL_CELL_SIZE);
      ctx.lineTo(BOARD_WIDTH * RIVAL_CELL_SIZE, i * RIVAL_CELL_SIZE);
      ctx.stroke();
    }

    drawBlocks(ctx, rivalBoardRef.current, RIVAL_CELL_SIZE);
  };

  tickRef.current = () => {
    const now = performance.now();
    const delta = Math.min(now - lastTimeRef.current, 100);
    lastTimeRef.current = now;

    if (gameStateRef.current === 'menu' || gameStateRef.current === 'connecting') return;

    if (gameStateRef.current === 'playing' && !gameOverRef.current) {
      gravityTimerRef.current += delta;
      if (gravityTimerRef.current >= dropSpeedRef.current) {
        gravityTimerRef.current = 0;
        movePiece(0, 1, false);
      }
    }

    particlesRef.current = particlesRef.current.filter((p) => {
      p.x += (p.vx * delta) / 16;
      p.y += (p.vy * delta) / 16;
      p.vy += (0.3 * delta) / 16;
      p.life -= delta;
      return p.life > 0;
    });

    if (shakeRef.current > 0) {
      shakeRef.current = Math.max(0, shakeRef.current - delta * 0.04);
    }
    if (flashRef.current > 0) {
      flashRef.current = Math.max(0, flashRef.current - delta * 0.003);
    }

    drawLocal();
    drawRival();
  };

  const broadcastSync = () => {
    if (!channelRef.current) return;
    if (gameStateRef.current !== 'playing') return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'SYNC_GRID',
      payload: {
        board: localBoardRef.current,
        score: scoreRef.current,
        lines: linesRef.current,
      },
    });
  };

  // ---- FIXED BULLETPROOF HANDSHAKE & WEBSOCKET CHANNEL ----
  const setupChannel = (code: string, host: boolean) => {
    if (channelRef.current) {
      try { supabase.removeChannel(channelRef.current); } catch {}
      channelRef.current = null;
    }

    const channelName = `mario_runner_${code}`;
    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    // 1. Guest sends JOIN_GAME once upon subscribing
    channel.on('broadcast', { event: 'JOIN_GAME' }, () => {
      setRivalConnected(true);
      if (host) {
        // Host generates random seed ONCE and broadcasts START
        const newSeed = Math.floor(Math.random() * 1000000);
        seedRef.current = newSeed;
        channel.send({
          type: 'broadcast',
          event: 'START',
          payload: { seed: newSeed },
        });
        startGame(newSeed);
      }
    });

    // 2. Both receive START
    channel.on('broadcast', { event: 'START' }, (msg: any) => {
      const seed = msg?.payload?.seed ?? 123456;
      seedRef.current = seed;
      setRivalConnected(true);
      startGame(seed);
    });

    // 3. Sync Rival Board
    channel.on('broadcast', { event: 'SYNC_GRID' }, (msg: any) => {
      if (!msg?.payload) return;
      const { board, score: rScore, lines: rLines } = msg.payload;
      if (board) rivalBoardRef.current = board;
      if (typeof rScore === 'number') setRivalScore(rScore);
      if (typeof rLines === 'number') setRivalLines(rLines);
    });

    // 4. Garbage Attacks
    channel.on('broadcast', { event: 'GARBAGE' }, (msg: any) => {
      const count = msg?.payload?.count || 0;
      pendingGarbageRef.current += count;
      setPendingGarbageDisplay(pendingGarbageRef.current);
      shakeRef.current = Math.min(15, shakeRef.current + count * 2);
    });

    // 5. Game Over / Victory
    channel.on('broadcast', { event: 'GAME_OVER' }, () => {
      if (!gameOverRef.current) {
        handleWin();
      }
    });

    // 6. Rematch
    channel.on('broadcast', { event: 'REMATCH' }, (msg: any) => {
      const seed = msg?.payload?.seed ?? Math.floor(Math.random() * 1000000);
      seedRef.current = seed;
      startGame(seed);
    });

    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        if (!host) {
          // Guest sends JOIN_GAME once
          channel.send({ type: 'broadcast', event: 'JOIN_GAME', payload: {} });
        }
      }
    });

    channelRef.current = channel;
  };

  const startGame = (seed: number) => {
    // Clear old network intervals to prevent timer/memory leaks!
    if (broadcastIntervalRef.current) {
      clearInterval(broadcastIntervalRef.current);
      broadcastIntervalRef.current = null;
    }

    rngRef.current = mulberry32(seed);
    pieceQueueRef.current = generateBag(rngRef.current);
    localBoardRef.current = createBoard();
    rivalBoardRef.current = createBoard();
    currentPieceRef.current = null;
    pendingGarbageRef.current = 0;
    particlesRef.current = [];
    shakeRef.current = 0;
    flashRef.current = 0;
    gravityTimerRef.current = 0;
    dropSpeedRef.current = 1000;
    gameOverRef.current = false;
    scoreRef.current = 0;
    linesRef.current = 0;
    comboRef.current = 0;

    setScore(0);
    setLines(0);
    setLevel(1);
    setCombo(0);
    setPendingGarbageDisplay(0);
    setRivalScore(0);
    setRivalLines(0);
    setGameState('playing');

    spawnPiece();

    lastTimeRef.current = performance.now();

    // Throttled 15 FPS network grid sync to keep WebSockets light & fast!
    broadcastIntervalRef.current = setInterval(broadcastSync, 66);

    announceEvent('start');
  };

  const handleRematch = () => {
    ensureAudio();
    const newSeed = Math.floor(Math.random() * 1000000);
    seedRef.current = newSeed;
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'REMATCH',
        payload: { seed: newSeed },
      });
    }
    startGame(newSeed);
  };

  const handleCreateRoom = () => {
    ensureAudio();
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomCode(code);
    setIsHost(true);
    setGameState('connecting');
    setupChannel(code, true);
  };

  const handleJoinRoom = () => {
    if (!joinCodeInput.trim()) return;
    ensureAudio();
    const code = joinCodeInput.trim().toUpperCase();
    setRoomCode(code);
    setIsHost(false);
    setGameState('connecting');
    setupChannel(code, false);
  };

  const handlePractice = () => {
    ensureAudio();
    setIsHost(true);
    setRoomCode('');
    setRivalConnected(false);
    const seed = Math.floor(Math.random() * 1000000);
    seedRef.current = seed;
    startGame(seed);
  };

  const handleBackToMenu = () => {
    if (channelRef.current) {
      try { supabase.removeChannel(channelRef.current); } catch {}
      channelRef.current = null;
    }
    if (broadcastIntervalRef.current) {
      clearInterval(broadcastIntervalRef.current);
      broadcastIntervalRef.current = null;
    }
    gameOverRef.current = false;
    setRivalConnected(false);
    setGameState('menu');
    setRoomCode('');
    setJoinCodeInput('');
  };

  const stopMobileDAS = () => {
    if (mobileDasTimeoutRef.current) {
      clearTimeout(mobileDasTimeoutRef.current);
      mobileDasTimeoutRef.current = null;
    }
    if (mobileDasIntervalRef.current) {
      clearInterval(mobileDasIntervalRef.current);
      mobileDasIntervalRef.current = null;
    }
  };

  const startMobileDAS = (action: () => void) => {
    stopMobileDAS();
    mobileDasTimeoutRef.current = setTimeout(() => {
      mobileDasIntervalRef.current = setInterval(action, 60);
    }, 160);
  };

  useEffect(() => {
    let raf: number;
    const loop = () => {
      tickRef.current();
      raf = requestAnimationFrame(loop);
    };
    lastTimeRef.current = performance.now();
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (propRoomCode && propPlayerRole) {
      const host = propPlayerRole === 'p1';
      setRoomCode(propRoomCode);
      setIsHost(host);
      setGameState('connecting');
      setupChannel(propRoomCode, host);
    }
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (broadcastIntervalRef.current) clearInterval(broadcastIntervalRef.current);
      if (channelRef.current) {
        try { supabase.removeChannel(channelRef.current); } catch {}
        channelRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
      stopMobileDAS();
      if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propRoomCode, propPlayerRole]);

  useEffect(() => {
    if (gameState !== 'playing') return;

    let dasTimeout: ReturnType<typeof setTimeout> | null = null;
    let dasInterval: ReturnType<typeof setInterval> | null = null;
    let heldKey: string | null = null;

    const stopDAS = () => {
      if (dasTimeout) {
        clearTimeout(dasTimeout);
        dasTimeout = null;
      }
      if (dasInterval) {
        clearInterval(dasInterval);
        dasInterval = null;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (gameOverRef.current) return;
      if (e.repeat) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          movePiece(-1, 0, false);
          heldKey = 'ArrowLeft';
          stopDAS();
          dasTimeout = setTimeout(() => {
            dasInterval = setInterval(() => movePiece(-1, 0, false), 50);
          }, 150);
          break;
        case 'ArrowRight':
          e.preventDefault();
          movePiece(1, 0, false);
          heldKey = 'ArrowRight';
          stopDAS();
          dasTimeout = setTimeout(() => {
            dasInterval = setInterval(() => movePiece(1, 0, false), 50);
          }, 150);
          break;
        case 'ArrowDown':
          e.preventDefault();
          movePiece(0, 1, true);
          heldKey = 'ArrowDown';
          stopDAS();
          dasTimeout = setTimeout(() => {
            dasInterval = setInterval(() => movePiece(0, 1, true), 50);
          }, 150);
          break;
        case 'ArrowUp':
          e.preventDefault();
          rotateCurrent();
          break;
        case ' ':
          e.preventDefault();
          hardDrop();
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (heldKey === e.key) {
        heldKey = null;
        stopDAS();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      stopDAS();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState]);

  const toggleMute = () => {
    ensureAudio();
    setMuted((m) => !m);
  };

  const controlBtnClass =
    'select-none touch-none flex items-center justify-center rounded-xl bg-white/5 border border-cyan-500/30 active:bg-cyan-500/30 active:scale-95 transition-all text-cyan-300 font-bold shadow-lg shadow-cyan-500/10';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-950 flex items-center justify-center p-2 sm:p-4 overflow-x-hidden select-none">
      <div className="w-full max-w-5xl">
        {gameState === 'menu' && (
          <div className="flex flex-col items-center gap-8 py-12">
            <div className="text-center">
              <div className="flex items-center justify-center gap-3 mb-3">
                <Sparkles className="w-8 h-8 text-cyan-400" />
                <h1 className="text-4xl sm:text-6xl font-black bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400 bg-clip-text text-transparent tracking-tight">
                  BLOCK DROP BATTLE
                </h1>
                <Sparkles className="w-8 h-8 text-pink-400" />
              </div>
              <p className="text-slate-400 text-sm sm:text-base">
                Real-time multiplayer Tetris duel. Clear lines. Send garbage. Survive.
              </p>
            </div>

            <div className="flex flex-col gap-4 w-full max-w-md">
              <button
                onClick={handleCreateRoom}
                className="flex items-center justify-center gap-3 px-6 py-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-lg shadow-lg shadow-cyan-500/30 transition-all hover:scale-105 active:scale-95"
              >
                <Play className="w-5 h-5" />
                Create Room
              </button>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value)}
                  placeholder="Enter room code..."
                  maxLength={6}
                  className="flex-1 px-4 py-4 rounded-xl bg-white/5 border border-purple-500/30 text-white placeholder-slate-500 focus:outline-none focus:border-purple-400 uppercase"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleJoinRoom();
                  }}
                />
                <button
                  onClick={handleJoinRoom}
                  className="px-6 py-4 rounded-xl bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-400 hover:to-pink-500 text-white font-bold shadow-lg shadow-purple-500/30 transition-all hover:scale-105 active:scale-95"
                >
                  Join
                </button>
              </div>

              <div className="h-px bg-gradient-to-r from-transparent via-slate-600 to-transparent my-2" />

              <button
                onClick={handlePractice}
                className="flex items-center justify-center gap-3 px-6 py-3 rounded-xl bg-white/5 border border-slate-600/50 hover:bg-white/10 text-slate-300 font-semibold transition-all"
              >
                <Target className="w-5 h-5" />
                Practice Solo
              </button>
            </div>
          </div>
        )}

        {gameState === 'connecting' && (
          <div className="flex flex-col items-center gap-6 py-20">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-4 border-cyan-500/20 border-t-cyan-400 animate-spin" />
              <Heart className="w-8 h-8 text-pink-400 absolute inset-0 m-auto" />
            </div>
            <div className="text-center">
              <p className="text-slate-400 text-sm mb-2">Room Code</p>
              <p className="text-4xl font-black text-cyan-400 tracking-widest font-mono">
                {roomCode}
              </p>
            </div>
            <p className="text-slate-300 text-lg">
              Waiting for <span className="text-purple-400 font-bold">{rivalName}</span> to join...
            </p>
            <button
              onClick={handleBackToMenu}
              className="px-6 py-2 rounded-lg bg-white/5 border border-slate-600 text-slate-300 hover:bg-white/10 transition-all"
            >
              Cancel
            </button>
          </div>
        )}

        {(gameState === 'playing' || gameState === 'gameover' || gameState === 'won') && (
          <div className="flex flex-col gap-3">
            {announcement && (
              <div className="px-4 py-2 rounded-lg bg-gradient-to-r from-purple-900/60 to-pink-900/60 border border-purple-500/40 text-center text-sm text-purple-200 italic">
                <span className="text-pink-400 font-bold mr-2">AI CASTER:</span>
                {announcement}
              </div>
            )}

            <div className="flex flex-col lg:flex-row gap-4 items-center lg:items-start justify-center">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/5 border border-cyan-500/30">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-cyan-400" />
                    <span className="text-cyan-300 font-bold text-sm sm:text-base">
                      {myName}
                    </span>
                  </div>
                  <button onClick={toggleMute} className="p-1 rounded hover:bg-white/10 transition-colors">
                    <Volume2 className={`w-4 h-4 ${muted ? 'text-slate-600' : 'text-cyan-400'}`} />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="flex flex-col items-center px-2 py-1.5 rounded bg-white/5 border border-white/10">
                    <Award className="w-3 h-3 text-yellow-400 mb-0.5" />
                    <span className="text-slate-400">Score</span>
                    <span className="text-white font-bold text-sm">{score.toLocaleString()}</span>
                  </div>
                  <div className="flex flex-col items-center px-2 py-1.5 rounded bg-white/5 border border-white/10">
                    <Sparkles className="w-3 h-3 text-green-400 mb-0.5" />
                    <span className="text-slate-400">Lines</span>
                    <span className="text-white font-bold text-sm">{lines}</span>
                  </div>
                  <div className="flex flex-col items-center px-2 py-1.5 rounded bg-white/5 border border-white/10">
                    <Flame className="w-3 h-3 text-orange-400 mb-0.5" />
                    <span className="text-slate-400">Level</span>
                    <span className="text-white font-bold text-sm">{level}</span>
                  </div>
                </div>

                <div className="relative">
                  <canvas
                    ref={localCanvasRef}
                    width={BOARD_WIDTH * CELL_SIZE}
                    height={BOARD_HEIGHT * CELL_SIZE}
                    className="rounded-lg border-2 border-cyan-500/40 shadow-2xl shadow-cyan-500/20 max-w-full h-auto"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  {(gameState === 'gameover' || gameState === 'won') && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 rounded-lg backdrop-blur-sm p-4 text-center">
                      {gameState === 'won' ? (
                        <>
                          <Crown className="w-12 h-12 text-yellow-400 mb-2" />
                          <p className="text-3xl font-black text-yellow-400 mb-1">VICTORY!</p>
                          <p className="text-slate-300 text-sm mb-4">You outlasted {rivalName}!</p>
                        </>
                      ) : (
                        <>
                          <Heart className="w-12 h-12 text-red-400 mb-2" />
                          <p className="text-3xl font-black text-red-400 mb-1">GAME OVER</p>
                          <p className="text-slate-300 text-sm mb-4">{rivalName} won the match!</p>
                        </>
                      )}
                      <button
                        onClick={handleRematch}
                        className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold shadow-lg transition-all mb-2"
                      >
                        <RotateCcw className="w-5 h-5" /> Instant Rematch
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10">
                  <span className="text-xs text-slate-400">Next:</span>
                  {nextPieceType && (
                    <div
                      className="grid gap-px"
                      style={{
                        gridTemplateColumns: `repeat(${TETROMINOES[nextPieceType].shape[0].length}, 1fr)`,
                      }}
                    >
                      {TETROMINOES[nextPieceType].shape.flat().map((cell, i) => (
                        <div
                          key={i}
                          className="w-3 h-3 rounded-sm"
                          style={{
                            backgroundColor: cell ? TETROMINOES[nextPieceType].color : 'transparent',
                          }}
                        />
                      ))}
                    </div>
                  ))}
                  {combo > 1 && (
                    <span className="ml-auto text-xs text-orange-400 font-bold">{combo}x COMBO</span>
                  )}
                  {pendingGarbageDisplay > 0 && (
                    <span className="ml-auto text-xs text-red-400 font-bold animate-pulse">+{pendingGarbageDisplay} INCOMING</span>
                  )}
                </div>
              </div>

              {/* RIVAL BOARD */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/5 border border-pink-500/30">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 text-pink-400" />
                    <span className="text-pink-300 font-bold text-sm">{rivalName}</span>
                    {rivalConnected ? <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /> : <span className="w-2 h-2 rounded-full bg-slate-600" />}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex flex-col items-center px-2 py-1.5 rounded bg-white/5 border border-white/10">
                    <span className="text-slate-400">Score</span>
                    <span className="text-white font-bold text-sm">{rivalScore.toLocaleString()}</span>
                  </div>
                  <div className="flex flex-col items-center px-2 py-1.5 rounded bg-white/5 border border-white/10">
                    <span className="text-slate-400">Lines</span>
                    <span className="text-white font-bold text-sm">{rivalLines}</span>
                  </div>
                </div>

                <canvas
                  ref={rivalCanvasRef}
                  width={BOARD_WIDTH * RIVAL_CELL_SIZE}
                  height={BOARD_HEIGHT * RIVAL_CELL_SIZE}
                  className="rounded-lg border-2 border-pink-500/40 shadow-xl shadow-pink-500/10 max-w-full h-auto"
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
            </div>

            {/* MOBILE TOUCH BUTTONS */}
            {gameState === 'playing' && (
              <div className="lg:hidden flex flex-col gap-2 mt-2">
                <div className="flex gap-2 justify-center">
                  <button
                    className={`${controlBtnClass} w-16 h-16`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      ensureAudio();
                      movePiece(-1, 0, false);
                      startMobileDAS(() => movePiece(-1, 0, false));
                    }}
                    onPointerUp={stopMobileDAS}
                    onPointerLeave={stopMobileDAS}
                  >
                    <ArrowLeft className="w-7 h-7" />
                  </button>
                  <button
                    className={`${controlBtnClass} w-16 h-16`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      ensureAudio();
                      rotateCurrent();
                    }}
                  >
                    <RotateCw className="w-7 h-7" />
                  </button>
                  <button
                    className={`${controlBtnClass} w-16 h-16`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      ensureAudio();
                      movePiece(1, 0, false);
                      startMobileDAS(() => movePiece(1, 0, false));
                    }}
                    onPointerUp={stopMobileDAS}
                    onPointerLeave={stopMobileDAS}
                  >
                    <ArrowRight className="w-7 h-7" />
                  </button>
                </div>
                <div className="flex gap-2 justify-center">
                  <button
                    className={`${controlBtnClass} w-24 h-12 text-xs`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      ensureAudio();
                      movePiece(0, 1, true);
                      startMobileDAS(() => movePiece(0, 1, true));
                    }}
                    onPointerUp={stopMobileDAS}
                    onPointerLeave={stopMobileDAS}
                  >
                    <ArrowDown className="w-5 h-5 mr-1" /> SOFT
                  </button>
                  <button
                    className="select-none touch-none flex items-center justify-center rounded-xl w-24 h-12 bg-gradient-to-r from-pink-500/80 to-red-600/80 border border-pink-400/50 active:scale-95 transition-all text-white font-bold text-xs shadow-lg shadow-pink-500/20"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      ensureAudio();
                      hardDrop();
                    }}
                  >
                    <ArrowDown className="w-5 h-5 mr-1" /> HARD
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}