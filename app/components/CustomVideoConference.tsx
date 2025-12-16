'use client';

import {
  ParticipantTile,
  useTracks,
  ControlBar,
  RoomAudioRenderer,
  TrackReferenceOrPlaceholder,
  useParticipantTile,
  VideoTrack
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useState, useEffect, useRef } from 'react';
import { Maximize2, LayoutGrid, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CustomVideoConference() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );

  const [focusTrack, setFocusTrack] = useState<TrackReferenceOrPlaceholder | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handlePin = (track: TrackReferenceOrPlaceholder) => {
    setFocusTrack(track);
  };

  const handleUnpin = () => {
    setFocusTrack(null);
  };

  // Auto-hide controls logic
  const showControls = () => {
    setControlsVisible(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3000); // Hide after 3 seconds of inactivity
  };

  useEffect(() => {
    showControls(); // Initial show
    
    const handleActivity = () => showControls();
    
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('touchstart', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('keydown', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, []);

  return (
    <div className="h-full flex flex-col relative group">
      <div className="flex-1 relative overflow-hidden bg-zinc-900">
        {focusTrack ? (
          // Focus View: Show only the pinned participant
          <div className="w-full h-full relative">
            {/* Custom Video Renderer for iOS Fullscreen support */}
            <FocusVideoTile trackRef={focusTrack} />
            
            <button
              onClick={handleUnpin}
              className={cn(
                "absolute top-4 left-4 z-10 bg-black/60 hover:bg-black/80 text-white p-2 rounded-lg flex items-center gap-2 transition-all duration-300 backdrop-blur-sm",
                controlsVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"
              )}
            >
              <LayoutGrid size={20} />
              <span>Back to Grid</span>
            </button>
          </div>
        ) : (
          // Grid View: Show all participants manually to ensure control
          <div className="h-full w-full p-2 overflow-y-auto">
             {tracks.length === 0 ? (
                 <div className="flex items-center justify-center h-full text-white">
                     Waiting for participants...
                 </div>
             ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 h-full content-center">
                    {tracks.map((track) => (
                        <div 
                            key={track.participant.identity + track.source} 
                            className="relative aspect-video bg-black rounded-lg overflow-hidden group/tile cursor-pointer border border-zinc-800"
                            onClick={() => handlePin(track)}
                        >
                            <ParticipantTile trackRef={track} className="w-full h-full" />
                            
                            {/* Hover overlay */}
                            <div className="absolute inset-0 bg-black/0 group-hover/tile:bg-black/20 transition-colors pointer-events-none" />
                            <div className="absolute top-2 right-2 opacity-0 group-hover/tile:opacity-100 transition-opacity bg-black/50 p-1.5 rounded-full text-white backdrop-blur-sm">
                                <Maximize2 size={16} />
                            </div>
                        </div>
                    ))}
                </div>
             )}
          </div>
        )}
      </div>
      
      {/* Controls: Absolutely positioned at bottom to overlay video and save space */}
      <div className={cn(
        "absolute bottom-0 left-0 right-0 z-50 transition-all duration-300 transform",
        controlsVisible ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"
      )}>
        <ControlBar variation="minimal" controls={{ screenShare: true }} />
      </div>
      
      <RoomAudioRenderer />
    </div>
  );
}

// Special component to handle direct video element access for iOS Fullscreen
function FocusVideoTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
    // We can't easily extract the raw video element from ParticipantTile without ref forwarding hacking,
    // but we can add a button that finds the video element and requests fullscreen on it directly.
    // This works on iOS because iOS supports `videoElement.webkitEnterFullscreen()`.
    
    const handleIOSFullscreen = (e: React.MouseEvent) => {
        e.stopPropagation();
        // Find the video element within this component's hierarchy
        const videoEl = document.querySelector('.focus-view-video video') as HTMLVideoElement;
        
        if (videoEl) {
            if (videoEl.requestFullscreen) {
                videoEl.requestFullscreen();
            } else if ((videoEl as any).webkitEnterFullscreen) {
                // iOS Safari specific
                (videoEl as any).webkitEnterFullscreen();
            } else if ((videoEl as any).webkitRequestFullscreen) {
                 (videoEl as any).webkitRequestFullscreen();
            }
        }
    };

    return (
        <div className="w-full h-full relative group/focus focus-view-video">
             <ParticipantTile
              trackRef={trackRef}
              className="w-full h-full object-contain"
            />
            
            {/* iOS/Mobile specific fullscreen button overlay */}
            <button 
                onClick={handleIOSFullscreen}
                className="absolute top-4 right-4 z-20 bg-black/50 p-2 rounded-full text-white backdrop-blur-sm hover:bg-black/70 md:hidden"
            >
                <Maximize2 size={24} />
            </button>
        </div>
    )
}
