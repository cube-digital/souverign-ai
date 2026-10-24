import { useState } from "react";
import { answerQuestion } from "../api";
import { Button, Card, Input } from "../ds";
import { useSession } from "../state/session";
import { useQuestion } from "./store";

/** A question an agent asks in a thread; only the requester can answer. */
export function QuestionCard({
  questionId,
  text,
  options,
}: {
  questionId: string;
  text: string;
  options: string[];
}) {
  const { user } = useSession();
  const { question, put } = useQuestion(questionId);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const send = async (a: { option: number } | { text: string }) => {
    setBusy(true);
    setError(false);
    try {
      put(await answerQuestion(questionId, a));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (!question) body = null;
  else if (question.status === "answered") {
    body = (
      <div className="text-text-1">{`Answered by ${question.requester_name}: ${question.answer ?? ""}`}</div>
    );
  } else if (question.status === "expired") {
    body = <div className="text-text-2">This question expired.</div>;
  } else if (question.status === "canceled") {
    body = <div className="text-text-2">This question was canceled.</div>;
  } else if (question.requester_user_id !== user.id) {
    body = <div className="text-text-2">{`Waiting for ${question.requester_name} to answer`}</div>;
  } else {
    body = (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = typed.trim();
          if (t) void send({ text: t });
        }}
      >
        <div className="flex flex-wrap gap-2">
          {options.map((o, i) => (
            <Button key={o} disabled={busy} onClick={() => void send({ option: i })}>
              {o}
            </Button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Input
            label="Or type an answer"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-64"
          />
          <Button type="submit" variant="primary" disabled={busy || !typed.trim()}>
            Send
          </Button>
        </div>
        {error && (
          <div role="alert" className="text-[12px] text-danger">
            That did not go through. Try again.
          </div>
        )}
      </form>
    );
  }

  return (
    <Card ai role="region" aria-label="Question" className="flex flex-col gap-2 text-[13px]">
      <div className="text-text-0">{text}</div>
      {body}
    </Card>
  );
}
