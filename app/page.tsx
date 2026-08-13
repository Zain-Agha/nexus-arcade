'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import FlappyClash from '@/components/games/FlappyClash';
import MarioRunner from '@/components/games/MarioRunner';

// Supabase Initialization (Fallback to BroadcastChannel for local testing if keys are missing)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const hasSupabase = supabaseUrl.startsWith('http') && supabaseKey.length > 0;
const supabase = hasSupabase ? createClient(supabaseUrl, supabaseKey) : null;

export default function ArcadeSwitchboard() {
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [appState, setAppState] = useState<'LOGIN' | 'HUB' | 'GAME_1' | 'GAME_2'>('LOGIN');
  const [playerRole, setPlayerRole] = useState<'p1' | 'p2' | null>(null);
  
  const [p1Name, setP1Name] = useState('Player 1');
  const [p2Name, setP2Name] = useState('Waiting...');

  // PubSub Abstraction References
  const channelRef = useRef<RealtimeChannel | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const listenersRef = useRef<Record<string, ((payload: any) => void)[]>>({});

  // Unified PubSub Interface passed to Games
  const broadcastPayload = useCallback((event: string, payload: any) => {
    if (hasSupabase && channelRef.current) {
      channelRef.current.send({ type: 'broadcast', event, payload });
    } else if (bcRef.current) {
      bcRef.current.postMessage({ event, payload });
    }
  }, []);

  const subscribePayload = useCallback((event: string, callback: (payload: any) => void) => {
    if (!listenersRef.current[event]) listenersRef.current[event] = [];
    listenersRef.current[event].push(callback);
    return () => {
      listenersRef.current[event] = listenersRef.current[event].filter(cb => cb !== callback);
    };
  }, []);

  // Internal Message Router for Local BroadcastChannel Simulation
  useEffect(() => {
    if (!hasSupabase && bcRef.current) {
      const handleMessage = (e: MessageEvent) => {
        const { event, payload } = e.data;
        if (listenersRef.current[event]) {
          listenersRef.current[event].forEach(cb => cb(payload));
        }
      };
      bcRef.current.addEventListener('message', handleMessage);
      return () => bcRef.current?.removeEventListener('message', handleMessage);
    }
  }, [roomCode]);

  // Network Connection Logic
  const connectToRoom = async (code: string, role: 'p1' | 'p2', name: string) => {
    setRoomCode(code);
    setPlayerRole(role);
    if (role === 'p1') setP1Name(name);
    else setP2Name(name);

    if (hasSupabase) {
      const channel = supabase!.channel(`arcade-${code}`);
      channel.on('broadcast', { event: '*' }, (msg) => {
        const { event, payload } = msg;
        if (listenersRef.current[event]) {
          listenersRef.current[event].forEach(cb => cb(payload));
        }
      });
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED' && role === 'p2') {
          channel.send({ type: 'broadcast', event: 'JOIN_GAME', payload: { p2Name: name } });
        }
      });
      channelRef.current = channel;
    } else {
      bcRef.current = new BroadcastChannel(`arcade-${code}`);
      if (role === 'p2') {
        setTimeout(() => {
          bcRef.current?.postMessage({ event: 'JOIN_GAME', payload: { p2Name: name } });
        }, 500);
      }
    }
    setAppState('HUB');
  };

  const hostSession = () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    connectToRoom(code, 'p1', playerName || 'Player 1');
  };

  const joinSession = () => {
    if (joinCode.length === 4) {
      connectToRoom(joinCode, 'p2', playerName || 'Player 2');
    }
  };

  // Switchboard Core Network Listeners
  useEffect(() => {
    const unsubJoin = subscribePayload('JOIN_GAME', (payload) => {
      if (playerRole === 'p1') {
        setP2Name(payload.p2Name);
        // 1-way handshake complete, Host sends HUB_STATE to sync everyone
        broadcastPayload('HUB_STATE', { p1Name, p2Name: payload.p2Name });
      }
    });

    const unsubHubSync = subscribePayload('HUB_STATE', (payload) => {
      setP1Name(payload.p1Name);
      setP2Name(payload.p2Name);
    });

    const unsubLaunch = subscribePayload('LAUNCH_GAME', (payload) => {
      setAppState(payload.gameId);
    });

    const unsubReturn = subscribePayload('RETURN_TO_HUB', () => {
      setAppState('HUB');
    });

    return () => { unsubJoin(); unsubHubSync(); unsubLaunch(); unsubReturn(); };
  }, [playerRole, p1Name, p2Name, subscribePayload, broadcastPayload]);

  const launchGame = (gameId: 'GAME_1' | 'GAME_2') => {
    if (playerRole === 'p1') {
      broadcastPayload('LAUNCH_GAME', { gameId });
      setAppState(gameId);
    }
  };

  const returnToHub = () => {
    broadcastPayload('RETURN_TO_HUB', {});
    setAppState('HUB');
  };

  // UI Renders
  if (appState === 'LOGIN') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 font-sans text-slate-100">
        <div className="max-w-sm w-full bg-slate-900 rounded-2xl p-6 shadow-2xl border border-slate-800">
          <h1 className="text-2xl font-black text-center mb-6 tracking-widest text-indigo-400">NEXUS ARCADE</h1>
          <div className="space-y-6">
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Your Name</label>
              <input 
                type="text" 
                value={playerName} 
                onChange={e => setPlayerName(e.target.value)}
                placeholder="Enter Name"
                className="w-full bg-slate-800 border-2 border-slate-700 rounded-lg px-4 py-3 text-white outline-none focus:border-indigo-500 transition-colors"
                maxLength={12}
              />
            </div>
            <div className="pt-4 border-t border-slate-800">
              <button onClick={hostSession} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-4 rounded-lg transition-all active:scale-95 mb-4 shadow-lg shadow-indigo-900/50">
                Host New Session
              </button>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  value={joinCode} 
                  onChange={e => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="Code"
                  className="w-24 bg-slate-800 border-2 border-slate-700 rounded-lg px-4 py-3 text-center text-white outline-none focus:border-emerald-500 transition-colors tracking-widest"
                />
                <button onClick={joinSession} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-4 rounded-lg transition-all active:scale-95 shadow-lg shadow-emerald-900/50">
                  Join Session
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (appState === 'HUB') {
    return (
      <div className="min-h-screen bg-slate-950 p-4 sm:p-8 font-sans text-slate-100">
        <div className="max-w-4xl mx-auto">
          <header className="bg-slate-900 rounded-2xl p-6 mb-8 border border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <p className="text-sm font-bold text-slate-500 uppercase tracking-widest">Session Code</p>
              <h2 className="text-4xl font-black text-white tracking-widest">{roomCode}</h2>
            </div>
            <div className="bg-slate-950 px-6 py-4 rounded-xl border border-slate-800 flex items-center gap-4">
              <span className="font-bold text-indigo-400">{p1Name}</span>
              <span className="text-xs text-slate-600 font-black italic">VS</span>
              <span className={`font-bold ${p2Name === 'Waiting...' ? 'text-slate-500 animate-pulse' : 'text-emerald-400'}`}>
                {p2Name}
              </span>
            </div>
          </header>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button onClick={() => launchGame('GAME_1')} disabled={playerRole !== 'p1' || p2Name === 'Waiting...'} className="group bg-slate-900 rounded-2xl p-6 border-2 border-slate-800 hover:border-indigo-500 text-left transition-all disabled:opacity-50 disabled:hover:border-slate-800">
              <div className="bg-indigo-950 text-indigo-400 w-12 h-12 rounded-xl flex items-center justify-center font-black text-xl mb-4 group-hover:scale-110 transition-transform">1</div>
              <h3 className="text-xl font-black text-white mb-2">Flappy Clash</h3>
              <p className="text-sm text-slate-400">Survival race with floaty physics & ghost rivals.</p>
              {playerRole !== 'p1' && <p className="text-xs text-rose-400 mt-4 font-bold">Only Host can launch</p>}
            </button>
            <button onClick={() => launchGame('GAME_2')} disabled={playerRole !== 'p1' || p2Name === 'Waiting...'} className="group bg-slate-900 rounded-2xl p-6 border-2 border-slate-800 hover:border-emerald-500 text-left transition-all disabled:opacity-50 disabled:hover:border-slate-800">
              <div className="bg-emerald-950 text-emerald-400 w-12 h-12 rounded-xl flex items-center justify-center font-black text-xl mb-4 group-hover:scale-110 transition-transform">2</div>
              <h3 className="text-xl font-black text-white mb-2">Block Drop Battle</h3>
              <p className="text-sm text-slate-400">Action puzzle. Clear lines to send garbage!</p>
              {playerRole !== 'p1' && <p className="text-xs text-rose-400 mt-4 font-bold">Only Host can launch</p>}
            </button>
            <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 border-dashed flex flex-col items-center justify-center min-h-[200px]">
              <span className="text-slate-600 font-bold uppercase tracking-widest text-sm">Game Slot 3 (Locked)</span>
            </div>
            <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 border-dashed flex flex-col items-center justify-center min-h-[200px]">
              <span className="text-slate-600 font-bold uppercase tracking-widest text-sm">Game Slot 4 (Locked)</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Active Game Wrapper
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col touch-none select-none">
      <div className="bg-slate-900 px-4 py-3 flex items-center justify-between border-b border-slate-800 safe-top">
        <button onClick={returnToHub} className="text-xs font-bold text-slate-400 hover:text-white uppercase tracking-wider flex items-center gap-2 transition-colors">
          <span>← Return to Hub</span>
        </button>
        <div className="text-xs font-bold text-slate-500 tracking-widest">{roomCode}</div>
      </div>
      <div className="flex-1 w-full relative overflow-hidden flex items-center justify-center">
        {appState === 'GAME_1' && (
          <FlappyClash 
            roomCode={roomCode} playerRole={playerRole!} p1Name={p1Name} p2Name={p2Name} 
            broadcastPayload={broadcastPayload} subscribePayload={subscribePayload} 
          />
        )}
        {appState === 'GAME_2' && (
          <MarioRunner 
            roomCode={roomCode} playerRole={playerRole!} p1Name={p1Name} p2Name={p2Name} 
            broadcastPayload={broadcastPayload} subscribePayload={subscribePayload} 
          />
        )}
      </div>
    </div>
  );
}