'use client';

import {
  LiveKitRoom,
  VideoConference,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { useEffect, useState, use, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { FullscreenButton } from '@/app/components/FullscreenButton';

export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const searchParams = useSearchParams();
  const [token, setToken] = useState('');
  const roomContainerRef = useRef<HTMLDivElement>(null);

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
    <div ref={roomContainerRef} className="relative w-full h-screen bg-black">
        <LiveKitRoom
        video={true}
        audio={true}
        token={token}
        serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL}
        data-lk-theme="default"
        style={{ height: '100%' }}
        >
        <VideoConference />
        </LiveKitRoom>
        
        <div className="absolute top-4 right-4 z-50">
            <FullscreenButton targetRef={roomContainerRef} />
        </div>
    </div>
  );
}
