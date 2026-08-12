'use client';

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import AngrySiege from '@/components/games/AngrySiege';
import FruitBlade from '@/components/games/FruitBlade';
import FlappyClash from '@/components/games/FlappyClash';
import MarioRunner from '@/components/games/MarioRunner';
import { Shield, Users, Sparkles, LogOut, Trophy, Zap, Flame, Wind, User } from 'lucide-react';

export default function Home() {
  const [roomCode, setRoomCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [userName, setUserName] = useState<string>('');
  const [p1Name, setP1Name] = useState<string>('Player 1');
  const [p2Name, setP2Name] = useState<string>('Player 2');
  const [playerRole, setPlayerRole] = useState<'p1' | 'p2' | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const channelRef = useRef<any>(null);

  // --- GLOBAL ROOM WEBSOCKET SUBSCRIPTION ---
  const subscribeToArcadeRoom = (code: string, role: 'p1' | 'p2', myName: string) => {
    if (channelRef.current) {
      try { channelRef.current.unsubscribe(); } catch {}
    }

    const ch = supabase.channel(`nexus_arcade_${code}`, {
      config: { broadcast: { self: false } },
    });

    ch.on('broadcast', { event: 'JOIN_ARCADE' }, (msg: any) => {
      setConnected(true);
      const guestName = msg?.payload?.name || 'Player 2';
      setP2Name(guestName);
      if (role === 'p1') {
        ch.send({
          type: 'broadcast',
          event: 'ARCADE_CONNECTED',
          payload: { p1Name: myName || 'Player 1', p2Name: guestName },
        });
      }
    })
      .on('broadcast', { event: 'ARCADE_CONNECTED' }, (msg: any) => {
        setConnected(true);
        if (msg?.payload) {
          setP1Name(msg.payload.p1Name || 'Player 1');
          setP2Name(msg.payload.p2Name || 'Player 2');
        }
      })
      .on('broadcast', { event: 'LAUNCH_GAME' }, (msg: any) => {
        setActiveGame(msg?.payload?.gameId);
      })
      .on('broadcast', { event: 'RETURN_TO_HUB' }, () => {
        setActiveGame(null);
      });

    ch.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        if (role === 'p2') {
          ch.send({
            type: 'broadcast',
            event: 'JOIN_ARCADE',
            payload: { name: myName || 'Player 2' },
          });
          setConnected(true);
        }
      }
    });

    channelRef.current = ch;
  };

  const createArcadeRoom = () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const hostName = userName.trim() || 'Player 1';
    setP1Name(hostName);
    setRoomCode(code);
    setPlayerRole('p1');
    subscribeToArcadeRoom(code, 'p1', hostName);
    setError('');
  };

  const joinArcadeRoom = () => {
    if (!/^\d{4}$/.test(inputCode)) {
      setError('Enter a valid 4-digit code');
      return;
    }
    const guestName = userName.trim() || 'Player 2';
    setP2Name(guestName);
    setRoomCode(inputCode);
    setPlayerRole('p2');
    subscribeToArcadeRoom(inputCode, 'p2', guestName);
    setError('');
  };

  const launchGame = (gameId: string) => {
    if (!connected && playerRole === 'p1') {
      alert('Wait for Player 2 to connect before launching!');
      return;
    }
    setActiveGame(gameId);
    channelRef.current?.send({
      type: 'broadcast',
      event: 'LAUNCH_GAME',
      payload: { gameId },
    });
  };

  const returnToHub = () => {
    setActiveGame(null);
    channelRef.current?.send({
      type: 'broadcast',
      event: 'RETURN_TO_HUB',
      payload: {},
    });
  };

  const leaveRoom = () => {
    if (channelRef.current) {
      try { channelRef.current.unsubscribe(); } catch {}
      channelRef.current = null;
    }
    setRoomCode('');
    setInputCode('');
    setPlayerRole(null);
    setConnected(false);
    setActiveGame(null);
  };

  useEffect(() => {
    return () => {
      if (channelRef.current) {
        try { channelRef.current.unsubscribe(); } catch {}
      }
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4 select-none">
      {/* 1. ROOM CREATION / JOIN SCREEN */}
      {!roomCode && (
        <div className="max-w-2xl w-full text-center space-y-8 bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-sm font-semibold">
              <Sparkles className="w-4 h-4 text-cyan-400" /> NEXT-GEN MULTIPLAYER ARCADE
            </div>
            <h1 className="text-5xl font-extrabold tracking-wider bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-yellow-400 bg-clip-text text-transparent">
              NEXUS ARCADE
            </h1>
            <p className="text-slate-400">Enter your name & connect with a 4-digit code to play together!</p>
          </div>

          {/* NAME INPUT FIELD */}
          <div className="max-w-sm mx-auto space-y-1 text-left">
            <label className="text-xs font-bold text-slate-300 flex items-center gap-1">
              <User className="w-3.5 h-3.5 text-cyan-400" /> YOUR PLAYER NAME:
            </label>
            <input
              type="text"
              maxLength={12}
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="e.g. Alex"
              className="w-full px-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white font-bold text-lg focus:outline-none focus:border-cyan-400"
            />
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={createArcadeRoom}
              className="p-6 bg-gradient-to-br from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 rounded-2xl text-left transition hover:scale-[1.02] shadow-lg shadow-cyan-900/30"
            >
              <Shield className="w-8 h-8 mb-3 text-white" />
              <div className="text-xl font-bold">Host Arcade Session</div>
              <div className="text-sm text-cyan-100/80">Get a code & invite Player 2</div>
            </button>

            <div className="p-6 bg-slate-800/80 border border-slate-700 rounded-2xl text-left space-y-3">
              <Users className="w-8 h-8 text-fuchsia-400" />
              <div className="text-xl font-bold">Join Arcade Session</div>
              <input
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4-digit code"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-center text-2xl tracking-[0.4em] font-bold focus:outline-none focus:border-fuchsia-400"
              />
              <button
                onClick={joinArcadeRoom}
                disabled={inputCode.length !== 4}
                className="w-full py-2 bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-40 rounded-lg font-bold text-slate-950 transition"
              >
                Connect To Session
              </button>
              {error && <div className="text-red-400 text-xs text-center">{error}</div>}
            </div>
          </div>
        </div>
      )}

      {/* 2. ARCADE GAME SWITCHBOARD MENU (ROOM ACTIVE) */}
      {roomCode && !activeGame && (
        <div className="max-w-4xl w-full space-y-6">
          <div className="flex justify-between items-center bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <div>
              <div className="text-xs text-slate-400">ARCADE SESSION CODE</div>
              <div className="text-3xl font-black text-cyan-400 tracking-wider font-mono">{roomCode}</div>
              <div className="text-xs text-slate-300 mt-1">
                Players: <span className="font-bold text-cyan-400">{p1Name}</span> (P1) vs{' '}
                <span className="font-bold text-fuchsia-400">{p2Name}</span> (P2)
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-xl text-sm">
                <span className={`w-3 h-3 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400 animate-ping'}`} />
                <span>{connected ? `${p2Name} Connected!` : 'Waiting for Player 2...'}</span>
              </div>
              <button
                onClick={leaveRoom}
                className="p-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-xl transition"
                title="Disconnect Session"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="text-center">
            <h2 className="text-2xl font-bold text-white">Select a Game to Launch</h2>
            <p className="text-sm text-slate-400">
              {playerRole === 'p1' ? `Click any game to launch it for both ${p1Name} and ${p2Name}!` : `${p1Name} is selecting a game...`}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              onClick={() => launchGame('angry')}
              disabled={playerRole !== 'p1'}
              className="p-6 bg-slate-900 border border-slate-800 hover:border-red-500 rounded-2xl transition text-left hover:scale-[1.02] disabled:opacity-60"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold text-red-400">🏹 Angry Siege</h3>
                <Flame className="w-5 h-5 text-red-400" />
              </div>
              <p className="text-xs text-slate-400">2D Slingshot Castle Siege & Physics Destruction</p>
            </button>

            <button
              onClick={() => launchGame('fruit')}
              disabled={playerRole !== 'p1'}
              className="p-6 bg-slate-900 border border-slate-800 hover:border-cyan-500 rounded-2xl transition text-left hover:scale-[1.02] disabled:opacity-60"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold text-cyan-400">⚔️ Fruit Blade Battle</h3>
                <Zap className="w-5 h-5 text-cyan-400" />
              </div>
              <p className="text-xs text-slate-400">Real-time Slicing Duel & Combo Streak Challenge</p>
            </button>

            <button
              onClick={() => launchGame('flappy')}
              disabled={playerRole !== 'p1'}
              className="p-6 bg-slate-900 border border-slate-800 hover:border-yellow-500 rounded-2xl transition text-left hover:scale-[1.02] disabled:opacity-60"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold text-yellow-400">🐥 Flappy Clash</h3>
                <Wind className="w-5 h-5 text-yellow-400" />
              </div>
              <p className="text-xs text-slate-400">Ghost Race, Tethered Co-Op & Speed Rush</p>
            </button>

            <button
              onClick={() => launchGame('mario')}
              disabled={playerRole !== 'p1'}
              className="p-6 bg-slate-900 border border-slate-800 hover:border-blue-500 rounded-2xl transition text-left hover:scale-[1.02] disabled:opacity-60"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold text-blue-400">🍄 Mario Co-Op Runner</h3>
                <Trophy className="w-5 h-5 text-blue-400" />
              </div>
              <p className="text-xs text-slate-400">2D Side-Scrolling Co-Op Platform Runner</p>
            </button>
          </div>
        </div>
      )}

      {/* 3. ACTIVE GAME CONTAINER */}
      {roomCode && activeGame && (
        <div className="w-full max-w-5xl flex flex-col items-center">
          <div className="w-full flex justify-between items-center mb-3">
            <button
              onClick={returnToHub}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-bold rounded-xl transition flex items-center gap-2"
            >
              ← Leave Game & Return to Arcade Hub
            </button>
            <div className="text-xs font-mono text-cyan-400 bg-slate-900 px-3 py-1 rounded-lg border border-slate-800">
              Session Code: {roomCode} | {p1Name} (P1) vs {p2Name} (P2)
            </div>
          </div>

          {activeGame === 'angry' && (
            <AngrySiege roomCode={roomCode} playerRole={playerRole || 'p1'} p1Name={p1Name} p2Name={p2Name} />
          )}
          {activeGame === 'fruit' && (
            <FruitBlade roomCode={roomCode} playerRole={playerRole || 'p1'} p1Name={p1Name} p2Name={p2Name} />
          )}
          {activeGame === 'flappy' && (
            <FlappyClash roomCode={roomCode} playerRole={playerRole || 'p1'} p1Name={p1Name} p2Name={p2Name} />
          )}
          {activeGame === 'mario' && (
            <MarioRunner roomCode={roomCode} playerRole={playerRole || 'p1'} p1Name={p1Name} p2Name={p2Name} />
          )}
        </div>
      )}
    </main>
  );
}