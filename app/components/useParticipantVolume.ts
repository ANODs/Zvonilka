import { useEffect, useState, useCallback } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, RemoteAudioTrack, RemoteParticipant } from 'livekit-client';

const VOL_PREFIX = 'zvonilka_volume_';

export function useParticipantVolume() {
  const room = useMaybeRoomContext();
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Initialize volumes from localStorage
  useEffect(() => {
    const loadedVolumes: Record<string, number> = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(VOL_PREFIX)) {
            const identity = key.replace(VOL_PREFIX, '');
            const val = parseFloat(localStorage.getItem(key) || '1');
            if (!isNaN(val)) {
                loadedVolumes[identity] = val;
            }
        }
    }
    setVolumes(loadedVolumes);
  }, []);

  const applyVolumeToParticipant = useCallback(
    (participant: RemoteParticipant, vol: number) => {
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.track instanceof RemoteAudioTrack) {
          pub.track.setVolume(vol);
        }
      });
    },
    []
  );

  // Apply volume to existing participants when room or volumes change
  useEffect(() => {
    if (!room) return;

    // Apply to existing participants
    Array.from(room.remoteParticipants.values()).forEach((participant) => {
      const vol = volumes[participant.identity];
      if (vol !== undefined) {
        applyVolumeToParticipant(participant, vol);
      }
    });

    const handleTrackSubscribed = (track: any, publication: any, participant: RemoteParticipant) => {
      if (track instanceof RemoteAudioTrack) {
        // Find volume for this identity, default 1 but only apply if stored
        const vol = localStorage.getItem(`${VOL_PREFIX}${participant.identity}`);
        if (vol !== null) {
          const parsed = parseFloat(vol);
          if (!isNaN(parsed)) {
            track.setVolume(parsed);
          }
        }
      }
    };

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, volumes, applyVolumeToParticipant]);

  const setVolume = useCallback(
    (identity: string, vol: number) => {
      setVolumes((prev) => ({ ...prev, [identity]: vol }));
      localStorage.setItem(`${VOL_PREFIX}${identity}`, vol.toString());
      if (room) {
        const participant = Array.from(room.remoteParticipants.values()).find(
            p => p.identity === identity
        );
        if (participant) {
            applyVolumeToParticipant(participant, vol);
        }
      }
    },
    [room, applyVolumeToParticipant]
  );

  return { volumes, setVolume };
}
