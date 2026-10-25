import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Chip } from "../ds";
import { ConsentBanner } from "./ConsentBanner";
import { NotesDraft } from "./NotesDraft";
import { mmss, NotetakerPanel } from "./NotetakerPanel";
import { ParticipantList } from "./ParticipantList";
import { useCall } from "./useCall";

const MEDIA_OFF =
  "Call audio is off: the call server is not running on this Mac. Consent and notes still work.";

export function CallPage() {
  const { chatId = "", callId = "" } = useParams();
  const navigate = useNavigate();
  const c = useCall(chatId, callId);
  const { info } = c;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!info) {
    return (
      <p role="status" className="p-6 text-[13px] text-text-2">
        {c.error ?? "Loading the call…"}
      </p>
    );
  }

  const nt = info.notetaker;
  const mine = info.participants.find((p) => p.user_id === c.me.id);
  const active = nt?.status === "active";
  const ended = info.ended_at !== null;
  const elapsed = (info.ended_at ?? now) - info.started_at;
  const back = () => navigate(`/c/${chatId}`);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header className="flex flex-wrap items-center gap-3 text-[13px] text-text-0">
        <button
          type="button"
          className="cursor-pointer text-text-1 hover:text-text-0"
          onClick={back}
        >
          {`← # ${c.chat?.title ?? ""}`}
        </button>
        <span>{`Call · ${mmss(Math.max(0, elapsed))}`}</span>
        <Chip
          tone="ai"
          title={info.e2ee ? undefined : "audio is encrypted to this Mac, not end to end yet"}
        >
          Call server runs on this Mac
        </Chip>
        <span className="ml-auto text-text-2">{`You are ${c.me.display_name}`}</span>
      </header>

      {c.media === "off" && (
        <p role="status" className="rounded-md border border-warn p-3 text-[13px] text-warn-ink">
          {MEDIA_OFF}
        </p>
      )}
      {c.media === "failed" && (
        <p role="status" className="rounded-md border border-warn p-3 text-[13px] text-warn-ink">
          Call audio could not connect, or the chat key for this call is missing. Consent and notes
          still work.
        </p>
      )}
      {c.error && (
        <p role="alert" className="text-[12px] text-danger">
          {c.error}
        </p>
      )}

      <ParticipantList
        participants={info.participants}
        meId={c.me.id}
        speaking={c.speaking}
        muted={c.muted ? new Set([c.me.id]) : new Set()}
        showCapture={nt !== null}
      />

      {nt && nt.status === "active" && mine && nt.invited_by !== c.me.id && (
        <ConsentBanner
          inviter={nt.invited_by_name}
          notetaker={nt.agent_name}
          consent={mine.consent}
          busy={c.busy}
          onAnswer={(d) => void c.consent(d)}
        />
      )}

      {nt && (
        <NotetakerPanel info={info} segments={c.segments} hideText={mine?.consent === "declined"} />
      )}
      {c.isInviter && <NotesDraft notes={c.notes} chatId={chatId} />}

      {!ended && (
        <div className="flex flex-wrap gap-2">
          {!active && (
            <Button disabled={c.busy} onClick={() => void c.addNotetaker()}>
              Add notetaker
            </Button>
          )}
          {active && (
            <Button disabled={c.busy} onClick={() => void c.stop()}>
              Stop notes
            </Button>
          )}
          <Button disabled={c.media !== "connected"} onClick={() => void c.toggleMute()}>
            {c.muted ? "Unmute" : "Mute"}
          </Button>
          <Button
            onClick={async () => {
              await c.leave();
              back();
            }}
          >
            Leave
          </Button>
          {info.started_by === c.me.id && (
            <Button variant="danger" disabled={c.busy} onClick={() => void c.end()}>
              End call
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
