'use client';

import {
  ParticipantTile,
  useTracks,
  ControlBar,
  RoomAudioRenderer,
  TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useState } from 'react';
import { Maximize2, LayoutGrid } from 'lucide-react';

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
      <div className="flex-1 relative overflow-hidden bg-zinc-900">
        {focusTrack ? (
          // Focus View: Show only the pinned participant
          <div className="w-full h-full relative">
            <ParticipantTile
              trackRef={focusTrack}
              className="w-full h-full object-contain"
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
                            className="relative aspect-video bg-black rounded-lg overflow-hidden group cursor-pointer border border-zinc-800"
                            onClick={() => handlePin(track)}
                        >
                            <ParticipantTile trackRef={track} className="w-full h-full" />
                            
                            {/* Hover overlay */}
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors pointer-events-none" />
                            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 p-1.5 rounded-full text-white backdrop-blur-sm">
                                <Maximize2 size={16} />
                            </div>
                        </div>
                    ))}
                </div>
             )}
          </div>
        )}
      </div>
      
      {/* Controls usually stay visible */}
      <ControlBar />
      <RoomAudioRenderer />
    </div>
  );
}
