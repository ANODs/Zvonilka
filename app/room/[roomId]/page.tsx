'use client';

import {
  LiveKitRoom,
  VideoConference,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { useEffect, useState, use } from 'react';
import { useSearchParams } from 'next/navigation';

export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const searchParams = useSearchParams();
  const [token, setToken] = useState('');

  useEffect(() => {
    const username = searchParams.get('username') || 'User_' + Math.floor(Math.random() * 1000);

    (async () => {
      try {
        const resp = await fetch(`/api/token?room=${roomId}&username=${encodeURIComponent(username)}`);
        const data = await resp.json();
        setToken(data.token);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [roomId, searchParams]);

  if (!token) return <div className="flex items-center justify-center h-screen bg-black text-white">Loading...</div>;

  return (
    <LiveKitRoom
      video={true}
      audio={true}
      token={token}
      serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL}
      data-lk-theme="default"
      style={{ height: '100vh' }}
    >
      <VideoConference />
    </LiveKitRoom>
  );
}
