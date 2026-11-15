// Part B, spec B.8: the browser side of the call. Publishes friend-view + player-mic to the game room,
// and hands Part A the friend's camera (friend-cam) and audio (friend-audio) relayed by the agent.
// Needs livekit-client in apps/web (tested against 2.19.2).
import {
  Room, RoomEvent, Track, LocalVideoTrack, createLocalAudioTrack,
  type LocalAudioTrack, type RemoteTrack, type RemoteTrackPublication,
} from 'livekit-client';

export interface CallMedia {
  connect(opts: { url: string; token: string }): Promise<void>;
  publishFriendView(stream: MediaStream): Promise<void>; // track name "friend-view", 640x360, 15fps
  publishMic(): Promise<void>; // track name "player-mic", AEC on
  setMicEnabled(on: boolean): void; // push-to-talk support
  onFriendCam(cb: (el: HTMLVideoElement | null) => void): () => void; // from "friend-cam"
  onFriendAudio(cb: (playing: boolean) => void): () => void; // auto-plays "friend-audio"
  /** Call on the first user gesture (the Start button) so browsers allow audio. */
  startAudio(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createCallMedia(): CallMedia {
  const room = new Room({ adaptiveStream: false, dynacast: false });
  let mic: LocalAudioTrack | null = null;
  let camEl: HTMLVideoElement | null = null;
  let audioEl: HTMLMediaElement | null = null;
  const camSubs = new Set<(el: HTMLVideoElement | null) => void>();
  const audioSubs = new Set<(playing: boolean) => void>();

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
    if (pub.trackName === 'friend-cam') {
      camEl = track.attach() as HTMLVideoElement;
      camEl.muted = true;
      camEl.playsInline = true;
      camSubs.forEach((cb) => cb(camEl));
    }
    if (pub.trackName === 'friend-audio') {
      audioEl = track.attach();
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      audioSubs.forEach((cb) => cb(true));
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
    track.detach().forEach((el) => el.remove());
    if (pub.trackName === 'friend-cam') { camEl = null; camSubs.forEach((cb) => cb(null)); }
    if (pub.trackName === 'friend-audio') { audioEl = null; audioSubs.forEach((cb) => cb(false)); }
  });

  return {
    async connect({ url, token }) {
      await room.connect(url, token);
    },
    async publishFriendView(stream) {
      const mst = stream.getVideoTracks()[0];
      if (!mst) throw new Error('friend-view stream has no video track');
      await room.localParticipant.publishTrack(new LocalVideoTrack(mst), {
        name: 'friend-view', source: Track.Source.Camera, simulcast: false,
        videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 15 },
      });
    },
    async publishMic() {
      mic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      await room.localParticipant.publishTrack(mic, { name: 'player-mic', source: Track.Source.Microphone });
    },
    setMicEnabled(on) {
      if (!mic) return;
      void (on ? mic.unmute() : mic.mute());
    },
    onFriendCam(cb) {
      camSubs.add(cb);
      cb(camEl);
      return () => camSubs.delete(cb);
    },
    onFriendAudio(cb) {
      audioSubs.add(cb);
      cb(!!audioEl);
      return () => audioSubs.delete(cb);
    },
    startAudio() {
      return room.startAudio();
    },
    async disconnect() {
      await room.disconnect();
    },
  };
}
