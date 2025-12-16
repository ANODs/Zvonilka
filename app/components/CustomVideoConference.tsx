'use client';

import {
  GridLayout,
  ParticipantTile,
  useTracks,
  ControlBar,
  RoomAudioRenderer,
  TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useState } from 'react';
import { Maximize2, Minimize2, LayoutGrid } from 'lucide-react';

export function CustomVideoConference() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );

  const [focusTrack, setFocusTrack] = useState<TrackReferenceOrPlaceholder | null>(null);

  const handlePin = (track: TrackReferenceOrPlaceholder) => {
    setFocusTrack(track);
  };

  const handleUnpin = () => {
    setFocusTrack(null);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 relative overflow-hidden">
        {focusTrack ? (
          // Focus View: Show only the pinned participant
          <div className="w-full h-full relative">
            <ParticipantTile
              trackRef={focusTrack}
              className="w-full h-full"
            />
            <button
              onClick={handleUnpin}
              className="absolute top-4 left-4 z-10 bg-black/60 hover:bg-black/80 text-white p-2 rounded-lg flex items-center gap-2 transition-colors backdrop-blur-sm"
            >
              <LayoutGrid size={20} />
              <span>Back to Grid</span>
            </button>
          </div>
        ) : (
          // Grid View: Show all participants
          <div className="h-full p-2">
             <GridLayout tracks={tracks}>
                <ClickableParticipantTile onPin={handlePin} />
             </GridLayout>
          </div>
        )}
      </div>
      
      {/* Controls usually stay visible */}
      <ControlBar />
      <RoomAudioRenderer />
    </div>
  );
}

// Wrapper to add click-to-pin functionality
function ClickableParticipantTile({ 
  trackRef, 
  onPin, 
  ...props 
}: { 
  trackRef?: TrackReferenceOrPlaceholder; 
  onPin: (t: TrackReferenceOrPlaceholder) => void;
  [key: string]: any;
}) {
    if (!trackRef) return null;

    return (
        <div className="relative w-full h-full group cursor-pointer" onClick={() => onPin(trackRef)}>
            <ParticipantTile trackRef={trackRef} {...props} />
            
            {/* Hover overlay to indicate clickable */}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none" />
            
            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 p-1.5 rounded-full text-white backdrop-blur-sm">
                <Maximize2 size={16} />
            </div>
        </div>
    );
}
