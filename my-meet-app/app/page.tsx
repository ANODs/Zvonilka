'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState('');
  const [username, setUsername] = useState('');

  const createMeeting = () => {
    const id = Math.random().toString(36).substring(7);
    if (!username) {
        alert('Please enter your name');
        return;
    }
    router.push(`/room/${id}?username=${encodeURIComponent(username)}`);
  };

  const joinMeeting = () => {
    if (!roomId || !username) {
        alert('Please enter room ID and username');
        return;
    }
    router.push(`/room/${roomId}?username=${encodeURIComponent(username)}`);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24 bg-gray-950 text-white">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm flex flex-col gap-8">
        <h1 className="text-4xl font-bold text-center">Video Conferencing</h1>
        
        <div className="bg-gray-900 p-8 rounded-xl border border-gray-800 flex flex-col gap-4 w-full max-w-md">
            <div className="flex flex-col gap-2">
                <label className="text-gray-400">Your Name</label>
                <input 
                    type="text" 
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your name"
                    className="p-3 rounded-lg bg-gray-800 border border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 text-white"
                />
            </div>

            <div className="flex flex-col gap-4 mt-4">
                <button 
                    onClick={createMeeting}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg transition-colors"
                >
                    New Meeting
                </button>
                
                <div className="relative flex py-2 items-center">
                    <div className="flex-grow border-t border-gray-700"></div>
                    <span className="flex-shrink mx-4 text-gray-500">OR</span>
                    <div className="flex-grow border-t border-gray-700"></div>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-gray-400">Meeting Code</label>
                    <div className="flex gap-2">
                        <input 
                            type="text" 
                            value={roomId}
                            onChange={(e) => setRoomId(e.target.value)}
                            placeholder="Enter code"
                            className="flex-1 p-3 rounded-lg bg-gray-800 border border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 text-white"
                        />
                        <button 
                            onClick={joinMeeting}
                            className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg transition-colors"
                        >
                            Join
                        </button>
                    </div>
                </div>
            </div>
        </div>
      </div>
    </main>
  );
}
