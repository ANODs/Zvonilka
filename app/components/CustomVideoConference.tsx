'use client';

import {
  ParticipantTile,
  useTracks,
  ControlBar,
  RoomAudioRenderer,
  TrackReferenceOrPlaceholder,
  useParticipantTile,
  VideoTrack,
  Chat
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useState, useEffect, useRef } from 'react';
import { Maximize2, LayoutGrid, Minimize2, Volume2, MoreVertical, MessageCircle, X, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useParticipantVolume } from './useParticipantVolume';

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

  const { volumes, setVolume } = useParticipantVolume();
  const [activeDrawerParticipant, setActiveDrawerParticipant] = useState<TrackReferenceOrPlaceholder | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const touchTimerMap = useRef<Record<string, NodeJS.Timeout>>({});

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

  const handleContextMenu = (e: React.MouseEvent, track: TrackReferenceOrPlaceholder) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveDrawerParticipant(track);
  };

  const handleTouchStart = (e: React.TouchEvent, track: TrackReferenceOrPlaceholder) => {
    const identity = track.participant.identity;
    const timer = setTimeout(() => {
      setActiveDrawerParticipant(track);
    }, 500); // 500ms long press
    touchTimerMap.current[identity] = timer;
  };

  const handleTouchEnd = (identity: string) => {
    if (touchTimerMap.current[identity]) {
      clearTimeout(touchTimerMap.current[identity]);
      delete touchTimerMap.current[identity];
    }
  };

  const handleTouchMove = (identity: string) => {
    handleTouchEnd(identity);
  };

  useEffect(() => {
    showControls(); // Initial show

    const handleActivity = () => showControls();
    const closeMenu = () => setActiveDrawerParticipant(null);

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('touchstart', handleActivity, { passive: true });
    window.addEventListener('click', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('click', closeMenu);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('click', closeMenu);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, []);

  return (
    <div className="h-full flex flex-col relative group bg-black">
      <div className="flex-1 flex overflow-hidden">
        {/* Main Video Area */}
        <div className={cn(
          "flex-1 relative overflow-hidden transition-all duration-300",
          chatOpen ? "hidden md:block md:w-[calc(100%-320px)]" : "w-full"
        )}>
          {focusTrack ? (
            // Focus View: Show only the pinned participant
            <div
              className="w-full h-full relative group/focustile"
              onContextMenu={(e) => focusTrack && handleContextMenu(e, focusTrack)}
              onTouchStart={(e) => focusTrack && handleTouchStart(e, focusTrack)}
              onTouchEnd={() => focusTrack?.participant?.identity && handleTouchEnd(focusTrack.participant.identity)}
              onTouchMove={() => focusTrack?.participant?.identity && handleTouchMove(focusTrack.participant.identity)}
            >
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

              {/* 3 Dots on hover or mobile */}
              <button
                onClick={(e) => handleContextMenu(e as any, focusTrack)}
                className="absolute top-4 right-4 z-20 bg-black/50 p-2 rounded-full text-white backdrop-blur-sm hover:bg-black/70 md:opacity-0 group-hover/focustile:opacity-100 transition-opacity"
              >
                <MoreVertical size={20} />
              </button>

              {/* Placed physically inside Focus View, though it uses Fixed positioning */}
              {focusTrack.source === Track.Source.ScreenShare && (
                <FloatingCameraTile presenterParticipant={focusTrack.participant} />
              )}
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
                      onClick={(e) => {
                        if (!activeDrawerParticipant) {
                          handlePin(track);
                        }
                      }}
                      onContextMenu={(e) => handleContextMenu(e, track)}
                      onTouchStart={(e) => handleTouchStart(e, track)}
                      onTouchEnd={() => handleTouchEnd(track.participant.identity)}
                      onTouchMove={() => handleTouchMove(track.participant.identity)}
                    >
                      <ParticipantTile trackRef={track} className="w-full h-full" />

                      {/* Hover overlay */}
                      <div className="absolute inset-0 bg-black/0 group-hover/tile:bg-black/20 transition-colors pointer-events-none" />
                      <div className="absolute top-2 left-2 opacity-0 group-hover/tile:opacity-100 transition-opacity bg-black/50 p-1.5 rounded-full text-white backdrop-blur-sm pointer-events-none">
                        <Maximize2 size={16} />
                      </div>
                      {/* 3 Dots for menu */}
                      <button
                        onClick={(e) => handleContextMenu(e as any, track)}
                        className="absolute top-2 right-2 opacity-100 md:opacity-0 group-hover/tile:md:opacity-100 transition-opacity bg-black/50 p-1.5 rounded-full text-white backdrop-blur-sm hover:bg-black/70 z-10"
                      >
                        <MoreVertical size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Controls: Absolutely positioned at bottom to overlay video and save space */}
        <div className={cn(
          "absolute bottom-0 left-0 right-0 z-50 transition-all duration-300 transform flex justify-center pb-4",
          controlsVisible ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"
        )}>
          <div className="flex items-center gap-2 bg-zinc-900/90 backdrop-blur-md px-4 py-2 rounded-2xl border border-zinc-800 shadow-xl">
            <ControlBar variation="minimal" controls={{ screenShare: true }} className="bg-transparent border-none shadow-none" />
            <div className="w-px h-8 bg-zinc-700 mx-2" />
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className={cn(
                "p-3 rounded-xl transition-colors flex items-center gap-2 font-medium text-sm",
                chatOpen ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
              )}
            >
              <MessageCircle size={18} />
              <span className="hidden sm:inline">Chat</span>
            </button>
          </div>
        </div>

        {/* Volume Context Menu (Replaced by Drawer logic later) */}
        <RoomAudioRenderer />
      </div>

      {/* Chat Drawer (Persistent component so messages don't disappear) */}
      <div
        className={cn(
          "fixed inset-0 z-[100] flex flex-col justify-end transition-all duration-300",
          chatOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          onClick={() => setChatOpen(false)}
        />

        {/* Chat Container */}
        <div
          className={cn(
            "relative flex flex-col bg-black transition-transform duration-300",
            "rounded-t-2xl w-full max-w-2xl mx-auto h-[85vh] border-x border-t border-zinc-800",
            chatOpen ? "translate-y-0" : "translate-y-full"
          )}
        >
          {/* Drag handle */}
          <div className="w-12 h-1.5 bg-zinc-700 rounded-full mx-auto absolute top-3 left-1/2 -translate-x-1/2" />

          {/* Chat Header */}
          <div className="flex items-center justify-between p-4 pt-8 border-b border-zinc-800 shrink-0 h-16 w-full z-10">
            <div className="flex items-center gap-2 text-white font-medium">
              <MessageCircle size={20} />
              <h3>Chat</h3>
            </div>
            <button onClick={() => setChatOpen(false)} className="text-zinc-400 hover:text-white p-2 rounded-lg hover:bg-zinc-800 transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col min-w-0">
            <div
              className={cn(
                "flex-1 flex flex-col h-full min-w-0",
                "[&>.lk-chat]:flex-1 [&>.lk-chat]:w-full [&>.lk-chat]:min-w-0 [&>.lk-chat]:!max-w-none [&>.lk-chat]:!max-h-none [&>.lk-chat]:!m-0 [&>.lk-chat]:rounded-none [&>.lk-chat]:border-none [&>.lk-chat]:bg-black",
                "[&_.lk-chat-header]:hidden",
                "[&_.lk-participant-name]:!block [&_.lk-participant-name]:text-xs [&_.lk-participant-name]:text-zinc-500 [&_.lk-participant-name]:mb-1",
                "[&_.lk-chat-messages]:min-w-0 [&_.lk-chat-form-input]:min-w-0 [&_.lk-chat-entry]:min-w-0"
              )}
            >
              <Chat />
            </div>
          </div>
        </div>
      </div>

      {/* Participant Bottom Drawer */}
      <ParticipantDrawer
        participant={activeDrawerParticipant?.participant || null}
        isOpen={!!activeDrawerParticipant}
        onClose={() => setActiveDrawerParticipant(null)}
        volumes={volumes}
        onVolumeChange={(source, val) => {
          if (activeDrawerParticipant) {
            setVolume(activeDrawerParticipant.participant.identity, source, val);
          }
        }}
      />
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
        className="absolute top-4 right-16 z-20 bg-black/50 p-2 rounded-full text-white backdrop-blur-sm hover:bg-black/70 md:hidden flex items-center justify-center"
      >
        <Maximize2 size={24} />
      </button>
    </div>
  )
}

function ParticipantDrawer({
  participant,
  isOpen,
  onClose,
  volumes,
  onVolumeChange
}: {
  participant: any,
  isOpen: boolean,
  onClose: () => void,
  volumes: Record<string, number>,
  onVolumeChange: (source: Track.Source, val: number) => void
}) {
  if (!isOpen) return null;

  const identity = participant?.identity;

  // Find which audio tracks the participant actually has published
  const publications = participant?.audioTrackPublications ? Array.from(participant.audioTrackPublications.values()) : [];
  const hasMic = publications.some((p: any) => p.source === Track.Source.Microphone);
  const hasScreenAudio = publications.some((p: any) => p.source === Track.Source.ScreenShareAudio);

  const micVol = volumes[`${identity}_${Track.Source.Microphone}`] ?? 1;
  const screenVol = volumes[`${identity}_${Track.Source.ScreenShareAudio}`] ?? 1;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-zinc-900 rounded-t-2xl p-6 flex flex-col gap-6 animate-in slide-in-from-bottom-full duration-300 pointer-events-auto max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-12 h-1.5 bg-zinc-700 rounded-full mx-auto absolute top-3 left-1/2 -translate-x-1/2" />

        <div className="flex items-start justify-between mt-2">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-xl font-bold text-white uppercase">
              {participant?.identity?.charAt(0) || '?'}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">{participant?.identity || 'Unknown User'}</h2>
              <div className="flex items-center gap-2 mt-1 text-sm text-zinc-400">
                <Activity size={14} className="text-green-500" />
                <span>Connected</span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="h-px bg-zinc-800 w-full" />

        <div className="flex flex-col gap-6">
          {hasMic && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-zinc-200">
                <Volume2 size={18} />
                <span className="font-medium">Microphone Volume</span>
              </div>
              <div className="flex items-center gap-4">
                <Volume2 size={16} className="text-zinc-500" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={micVol}
                  onChange={(e) => onVolumeChange(Track.Source.Microphone, parseFloat(e.target.value))}
                  className="flex-1 accent-blue-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-zinc-400 text-sm font-medium w-8 text-right">
                  {Math.round(micVol * 100)}%
                </span>
              </div>
            </div>
          )}

          {hasScreenAudio && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-zinc-200">
                <Volume2 size={18} />
                <span className="font-medium">Screen Share Volume</span>
              </div>
              <div className="flex items-center gap-4">
                <Volume2 size={16} className="text-zinc-500" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={screenVol}
                  onChange={(e) => onVolumeChange(Track.Source.ScreenShareAudio, parseFloat(e.target.value))}
                  className="flex-1 accent-blue-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-zinc-400 text-sm font-medium w-8 text-right">
                  {Math.round(screenVol * 100)}%
                </span>
              </div>
            </div>
          )}

          {!hasMic && !hasScreenAudio && (
            <div className="text-zinc-500 text-sm italic py-2">
              No active audio streams.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Special component for the floating presenter camera (PiP)
function FloatingCameraTile({ presenterParticipant }: { presenterParticipant: any }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 16, y: 80 }); // start slightly down
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, startX: 0, startY: 0 });

  // Wait until mounted to access window safely
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !presenterParticipant) return null;

  // Find camera publication using standard Map or Array depending on LiveKit version fallback
  const _pubs = presenterParticipant.videoTrackPublications;
  const pubsArray = _pubs instanceof Map ? Array.from(_pubs.values()) : (_pubs || []);
  const cameraPub = pubsArray.find((p: any) => p.source === Track.Source.Camera);

  // Don't render if there's no camera track or it isn't subscribed/ready
  if (!cameraPub || (!cameraPub.track && !cameraPub.isSubscribed)) return null;

  const trackRef: TrackReferenceOrPlaceholder = {
    participant: presenterParticipant,
    publication: cameraPub,
    source: Track.Source.Camera,
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      startX: position.x,
      startY: position.y,
    };
    if (containerRef.current) {
      containerRef.current.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPosition({
      x: dragStart.current.startX + dx,
      y: dragStart.current.startY + dy,
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    if (containerRef.current) {
      try {
        containerRef.current.releasePointerCapture(e.pointerId);
      } catch (e) { /* Ignore rare capture lost error */ }
    }

    // Magnetic Corner Snapping
    const padding = 16;
    const { clientWidth, clientHeight } = document.documentElement;
    // Dimensions of the PiP box roughly
    const w = containerRef.current?.offsetWidth || 120;
    const h = containerRef.current?.offsetHeight || 160;

    let newX = position.x;
    let newY = position.y;

    const midX = clientWidth / 2;
    const midY = clientHeight / 2;

    // Constrain X
    if (newX + (w / 2) < midX) {
      newX = padding; // Snap Left
    } else {
      newX = clientWidth - w - padding; // Snap Right
    }

    // Constrain Y (leave ~100px padding at bottom for controls)
    if (newY + (h / 2) < midY) {
      newY = padding + 60; // Snap Top (slightly below headers)
    } else {
      newY = clientHeight - h - 120; // Snap Bottom (avoid controls)
    }

    setPosition({ x: newX, y: newY });
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        touchAction: 'none'
      }}
      className={cn(
        "fixed top-0 left-0 z-50 w-[100px] sm:w-[140px] aspect-[3/4] rounded-xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.5)] border-2 border-zinc-700/50 bg-black block",
        isDragging ? "cursor-grabbing duration-0" : "cursor-grab transition-transform duration-300 ease-out"
      )}
    >
      <ParticipantTile
        trackRef={trackRef}
        className="w-full h-full object-cover [&_video]:object-cover pointer-events-none"
      />
    </div>
  );
}
