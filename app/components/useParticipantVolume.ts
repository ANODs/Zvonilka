import { useEffect, useState, useCallback, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, RemoteAudioTrack, RemoteParticipant, Track } from 'livekit-client';

const VOL_PREFIX = 'zvonilka_vol_';

// A module-level cache to ensure we only create one WebAudio context and nodes per track.
const audioContexts = new Map<string, AudioContext>();
const gainNodes = new Map<string, GainNode>();
const mediaElements = new Map<string, HTMLAudioElement>();

function getAudioContext() {
  if (!audioContexts.has('main')) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioContexts.set('main', new AudioContextClass());
    }
  }
  return audioContexts.get('main');
}

export function useParticipantVolume() {
  const room = useRoomContext();
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Track attached audio elements to manage WebAudio overrides
  const attachedAudioElements = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Initialize volumes from localStorage
  useEffect(() => {
    const loadedVolumes: Record<string, number> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(VOL_PREFIX)) {
        // Key format: zvonilka_vol_{identity}_{source}
        const suffix = key.replace(VOL_PREFIX, ''); // e.g. "user1_microphone"
        const val = parseFloat(localStorage.getItem(key) || '1');
        if (!isNaN(val)) {
          loadedVolumes[suffix] = val;
        }
      }
    }
    setVolumes(loadedVolumes);
  }, []);

  const getStorageKey = (identity: string, source: Track.Source) => `${identity}_${source}`;

  const applyVolumeToTrack = useCallback((track: RemoteAudioTrack, identity: string, vol: number) => {
    // 1. Try standard HTML volume first (works on desktop)
    track.setVolume(vol);

    // 2. Apply WebAudio Gain override for iOS/mobile if available
    const trackId = track.sid || 'unknown_track';
    const gainNode = gainNodes.get(trackId);
    if (gainNode && gainNode.context.state !== 'closed') {
      // Ramp to new volume to avoid clicking sounds
      gainNode.gain.setTargetAtTime(vol, gainNode.context.currentTime, 0.05);
    }
  }, []);

  // WebAudio interceptor - this should be called whenever a track starts playing
  const attachWebAudioGain = useCallback((track: RemoteAudioTrack, identity: string, source: Track.Source) => {
    const trackId = track.sid || 'unknown_track';
    if (gainNodes.has(trackId)) return; // Already attached

    const ctx = getAudioContext();
    if (!ctx) return; // WebAudio not supported

    // Find the audio elements created by LiveKit for this track
    // LiveKit attaches elements internally, we need to find them or LiveKit's RoomAudioRenderer
    // will do it. However, the best way in LiveKit to intercept is to use the track's mediaStream.

    const mediaStreamTrack = track.mediaStreamTrack;
    if (!mediaStreamTrack) return;

    try {
      const stream = new MediaStream([mediaStreamTrack]);
      const sourceNode = ctx.createMediaStreamSource(stream);
      const gainNode = ctx.createGain();

      const key = getStorageKey(identity, source);
      const storedVol = localStorage.getItem(`${VOL_PREFIX}${key}`);
      const initialVol = storedVol ? parseFloat(storedVol) : 1;

      gainNode.gain.value = !isNaN(initialVol) ? initialVol : 1;

      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);

      gainNodes.set(trackId, gainNode);

      // IMPORTANT: Mute the original HTML element so we don't hear double audio.
      // LiveKit handles attaching to HTMLAudioElements internally. We must find them and mute them.
      const elements = track.attachedElements;
      elements.forEach(el => {
        el.muted = true;
      });

    } catch (e) {
      console.warn("Could not attach WebAudio node for track", e);
    }
  }, []);

  useEffect(() => {
    if (!room) return;

    // Apply to existing participants
    Array.from(room.remoteParticipants.values()).forEach((participant) => {
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.track instanceof RemoteAudioTrack) {
          const source = pub.source || Track.Source.Microphone;
          const key = getStorageKey(participant.identity, source);
          const vol = volumes[key];

          attachWebAudioGain(pub.track, participant.identity, source);

          if (vol !== undefined) {
            applyVolumeToTrack(pub.track, participant.identity, vol);
          }
        }
      });
    });

    const handleTrackSubscribed = (track: any, publication: any, participant: RemoteParticipant) => {
      if (track instanceof RemoteAudioTrack) {
        const source = publication.source || Track.Source.Microphone;
        const key = getStorageKey(participant.identity, source);
        const vol = localStorage.getItem(`${VOL_PREFIX}${key}`);

        attachWebAudioGain(track, participant.identity, source);

        if (vol !== null) {
          const parsed = parseFloat(vol);
          if (!isNaN(parsed)) {
            applyVolumeToTrack(track, participant.identity, parsed);
            setVolumes(prev => ({ ...prev, [key]: parsed }));
          }
        }
      }
    };

    const handleTrackUnsubscribed = (track: any) => {
      if (track instanceof RemoteAudioTrack) {
        const trackId = track.sid || 'unknown_track';
        const gainNode = gainNodes.get(trackId);
        if (gainNode) {
          gainNode.disconnect();
          gainNodes.delete(trackId);
        }
      }
    };

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

    // Also hook into when tracks are actually played to mute the original elements
    const handleTrackMuted = () => { }; // Could handle muting here if needed

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
    };
  }, [room, volumes, attachWebAudioGain, applyVolumeToTrack]);

  // Expose a way to resume AudioContext (required by iOS/browsers on first user interaction)
  const resumeAudioContext = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(e => console.error("Could not resume AudioContext", e));
    }
  }, []);

  const setVolume = useCallback(
    (identity: string, source: Track.Source, vol: number) => {
      resumeAudioContext(); // Ensure context is awake when they try to change volume

      const key = getStorageKey(identity, source);
      setVolumes((prev) => ({ ...prev, [key]: vol }));
      localStorage.setItem(`${VOL_PREFIX}${key}`, vol.toString());

      if (room) {
        const participant = Array.from(room.remoteParticipants.values()).find(
          p => p.identity === identity
        );
        if (participant) {
          participant.audioTrackPublications.forEach(pub => {
            if (pub.source === source && pub.track instanceof RemoteAudioTrack) {
              applyVolumeToTrack(pub.track, identity, vol);
            }
          });
        }
      }
    },
    [room, applyVolumeToTrack, resumeAudioContext]
  );

  return { volumes, setVolume, resumeAudioContext };
}
