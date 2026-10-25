/** LiveKit wrapper. Imported dynamically by the call page, so the app works without a call server. */
export type MediaState = "connecting" | "connected" | "failed";

export type MediaSession = {
  mute(on: boolean): Promise<void>;
  leave(): Promise<void>;
  /** called with the LiveKit identities that are speaking now */
  onActiveSpeakers(cb: (identities: string[]) => void): () => void;
  onState(cb: (state: MediaState) => void): () => void;
};

export async function connectMedia(opts: {
  url: string;
  token: string;
  e2eeKey?: string;
}): Promise<MediaSession> {
  const { Room, RoomEvent, Track, ExternalE2EEKeyProvider } = await import("livekit-client");
  const keyProvider = opts.e2eeKey ? new ExternalE2EEKeyProvider() : undefined;
  const worker = keyProvider
    ? new Worker(new URL("livekit-client/e2ee-worker", import.meta.url))
    : undefined;
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
    ...(keyProvider
      ? {
          e2ee: {
            keyProvider,
            worker: worker as Worker,
          },
        }
      : {}),
  });

  const stateCbs = new Set<(s: MediaState) => void>();
  const speakerCbs = new Set<(ids: string[]) => void>();
  let state: MediaState = "connecting";
  const setState = (s: MediaState) => {
    state = s;
    for (const cb of stateCbs) cb(s);
  };
  const audios = new Map<string, HTMLAudioElement>();

  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach() as HTMLAudioElement;
    el.hidden = true;
    document.body.appendChild(el);
    audios.set(`${participant.identity}:${track.sid}`, el);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    for (const e of track.detach()) e.remove();
    audios.delete(`${participant.identity}:${track.sid}`);
  });
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const ids = speakers.map((s) => s.identity);
    for (const cb of speakerCbs) cb(ids);
  });
  room.on(RoomEvent.Disconnected, () => setState("failed"));

  try {
    if (keyProvider) {
      await keyProvider.setKey(opts.e2eeKey as string);
      await room.setE2EEEnabled(true);
    }
    await room.connect(opts.url, opts.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    setState("connected");
  } catch (e) {
    setState("failed");
    await room.disconnect().catch(() => {});
    worker?.terminate();
    throw e;
  }

  return {
    async mute(on) {
      await room.localParticipant.setMicrophoneEnabled(!on);
    },
    async leave() {
      for (const el of audios.values()) el.remove();
      audios.clear();
      try {
        await room.disconnect();
      } finally {
        worker?.terminate();
      }
    },
    onActiveSpeakers(cb) {
      speakerCbs.add(cb);
      return () => speakerCbs.delete(cb);
    },
    onState(cb) {
      stateCbs.add(cb);
      cb(state);
      return () => stateCbs.delete(cb);
    },
  };
}
