import { useEffect, useState, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, RemoteAudioTrack, RemoteParticipant, Track } from 'livekit-client';

const VOL_PREFIX = 'zvonilka_vol_';

export function useParticipantVolume() {
  const room = useRoomContext();
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Initialize volumes from localStorage
  useEffect(() => {
    const loadedVolumes: Record<string, number> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(VOL_PREFIX)) {
        // Key format: zvonilka_vol_{identity}_{source}
        const suffix = key.replace(VOL_PREFIX, '');
        const val = parseFloat(localStorage.getItem(key) || '1');
        if (!isNaN(val)) {
          loadedVolumes[suffix] = val;
        }
      }
    }
    setVolumes(loadedVolumes);
  }, []);

  const getStorageKey = (identity: string, source: Track.Source) => `${identity}_${source}`;

  useEffect(() => {
    if (!room) return;

    // Apply to existing participants
    Array.from(room.remoteParticipants.values()).forEach((participant) => {
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.track instanceof RemoteAudioTrack) {
          const source = pub.source || Track.Source.Microphone;
          const key = getStorageKey(participant.identity, source);
          const vol = volumes[key];

          if (vol !== undefined) {
            pub.track.setVolume(vol);
          }
        }
      });
    });

    const handleTrackSubscribed = (track: any, publication: any, participant: RemoteParticipant) => {
      if (track instanceof RemoteAudioTrack) {
        const source = publication.source || Track.Source.Microphone;
        const key = getStorageKey(participant.identity, source);
        const storedVol = localStorage.getItem(`${VOL_PREFIX}${key}`);

        if (storedVol !== null) {
          const parsed = parseFloat(storedVol);
          if (!isNaN(parsed)) {
            track.setVolume(parsed);
            setVolumes(prev => ({ ...prev, [key]: parsed }));
          }
        }
      }
    };

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, volumes]);

  const setVolume = useCallback(
    (identity: string, source: Track.Source, vol: number) => {
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
              pub.track.setVolume(vol);
            }
          });
        }
      }
    },
    [room]
  );

  return { volumes, setVolume, resumeAudioContext: () => { } };
}
