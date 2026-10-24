import type { Agent, KnowledgeItem, Lesson } from "@sa/protocol";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import {
  ApiFailure,
  addLesson,
  deleteKnowledge,
  deleteLesson,
  lessons as fetchLessons,
  knowledge,
  teachDocument,
} from "../api";
import { Button, Chip, EmptyState, Modal, Textarea } from "../ds";
import { knowledgeMeta, knowledgeParts, shortDate } from "./knowledgeMeta";
import { SharingSetting } from "./SharingSetting";
import { SourceViewer } from "./SourceViewer";

const MAX_LESSON = 500;
const GROUPS: { kind: KnowledgeItem["kind"]; title: string }[] = [
  { kind: "document", title: "Documents" },
  { kind: "note", title: "Notes" },
  { kind: "correction", title: "Corrections" },
];

type Doomed = { title: string; run: () => Promise<unknown>; done: () => void };

function uploadError(e: unknown, name: string): string {
  const status = e instanceof ApiFailure ? e.status : 0;
  if (status === 415) return "That file type is not supported (PDF, DOCX, XLSX, TXT, MD).";
  if (status === 413) return "Files up to 20 MB.";
  if (status === 503) return "Memory is off on this Mac.";
  if (status === 422)
    return `No text found in ${name}. Scanned PDFs need OCR, which is not supported yet.`;
  return `Couldn't teach ${name}.`;
}

export function KnowledgeTab({
  agent,
  itemId,
  onCloseItem,
}: {
  agent: Agent;
  itemId?: string | undefined;
  onCloseItem: () => void;
}) {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [lessonList, setLessonList] = useState<Lesson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [doomed, setDoomed] = useState<Doomed | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [opened, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setItems(null);
    Promise.all([knowledge(agent.id), fetchLessons(agent.id)])
      .then(([k, l]) => {
        if (!live) return;
        setItems(k);
        setLessonList(l);
      })
      .catch(() => live && setError("Couldn't load what it knows."));
    return () => {
      live = false;
    };
  }, [agent.id]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setError(null);
    setReading(file.name);
    try {
      const created = await teachDocument(agent.id, file);
      setItems((l) => [created, ...(l ?? [])]);
    } catch (err) {
      setError(uploadError(err, file.name));
    }
    setReading(null);
  }

  async function submitLesson() {
    const t = text.trim();
    if (!t || adding) return;
    setAdding(true);
    setError(null);
    try {
      const created = await addLesson(agent.id, t);
      setLessonList((l) => [created, ...l]);
      setText("");
    } catch {
      setError("Couldn't add the lesson.");
    }
    setAdding(false);
  }

  async function confirmDelete() {
    if (!doomed) return;
    setDeleting(true);
    try {
      await doomed.run();
      doomed.done();
      setDoomed(null);
    } catch {
      setError("Couldn't delete it.");
      setDoomed(null);
    }
    setDeleting(false);
  }

  const askDeleteItem = (i: KnowledgeItem) =>
    setDoomed({
      title: i.title,
      run: () => deleteKnowledge(agent.id, i.id),
      done: () => setItems((l) => (l ?? []).filter((x) => x.id !== i.id)),
    });
  const askDeleteLesson = (l: Lesson) =>
    setDoomed({
      title: "this lesson",
      run: () => deleteLesson(agent.id, l.id),
      done: () => setLessonList((ls) => ls.filter((x) => x.id !== l.id)),
    });

  const empty = items !== null && items.length === 0 && lessonList.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <SharingSetting agent={agent} />
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-3 rounded-lg border border-border-soft p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`teach-doc-${agent.id}`} className="text-[12px] text-text-2">
            Teach a document
          </label>
          <input
            ref={fileRef}
            id={`teach-doc-${agent.id}`}
            type="file"
            accept=".pdf,.docx,.xlsx,.txt,.md"
            disabled={reading !== null}
            onChange={(e) => void onFile(e)}
            className="text-[13px] text-text-1"
          />
          {reading && (
            <p role="status" className="text-[12px] text-text-2">{`Reading ${reading}…`}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Textarea
            label="Teach a lesson"
            value={text}
            maxLength={MAX_LESSON}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-text-3">{`${text.length}/${MAX_LESSON}`}</span>
            <Button
              variant="primary"
              disabled={!text.trim() || adding}
              onClick={() => void submitLesson()}
            >
              Add lesson
            </Button>
          </div>
        </div>
      </section>

      <h2 className="text-[13px] font-semibold text-text-0">{`What ${agent.name} knows`}</h2>
      {items === null && !error && <EmptyState>Loading…</EmptyState>}
      {empty && <EmptyState>Nothing taught yet. Teach a document or a lesson.</EmptyState>}
      {GROUPS.map((g) => {
        const rows = (items ?? []).filter((i) => i.kind === g.kind);
        if (rows.length === 0) return null;
        return (
          <section key={g.kind}>
            <h3 className="mb-1 text-[12px] font-semibold text-text-2">{g.title}</h3>
            <ul className="flex flex-col gap-2">
              {rows.map((i) => {
                const parts = knowledgeParts(i);
                return (
                  <Row key={i.id} onDelete={() => askDeleteItem(i)}>
                    <button
                      type="button"
                      onClick={() => setOpen(i.id)}
                      className="cursor-pointer text-left text-text-0 hover:underline"
                    >
                      {i.title}
                    </button>
                    <p className="text-[12px] text-text-3">{knowledgeMeta(i)}</p>
                    {(parts || i.truncated) && (
                      <p className="flex items-center gap-2 text-[12px] text-text-3">
                        {parts && <span>{parts}</span>}
                        {i.truncated && <Chip>truncated</Chip>}
                      </p>
                    )}
                  </Row>
                );
              })}
            </ul>
          </section>
        );
      })}
      {lessonList.length > 0 && (
        <section>
          <h3 className="mb-1 text-[12px] font-semibold text-text-2">Lessons</h3>
          <ul className="flex flex-col gap-2">
            {lessonList.map((l) => (
              <Row key={l.id} onDelete={() => askDeleteLesson(l)}>
                <p className="text-text-0">{l.text}</p>
                <p className="text-[12px] text-text-3">
                  {`Added${l.taught_by_name ? ` by ${l.taught_by_name}` : ""} · ${shortDate(l.created_at)}`}
                </p>
              </Row>
            ))}
          </ul>
        </section>
      )}

      {doomed && (
        <Modal
          title={`Delete ${doomed.title}? ${agent.name} will forget it.`}
          onClose={() => setDoomed(null)}
          busy={deleting}
        >
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDoomed(null)}>Cancel</Button>
            <Button variant="danger" disabled={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </div>
        </Modal>
      )}
      {(opened ?? itemId) && (
        <SourceViewer
          agentId={agent.id}
          itemId={(opened ?? itemId) as string}
          onCloseItem={() => {
            setOpen(null);
            onCloseItem();
          }}
        />
      )}
    </div>
  );
}

function Row({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border-soft p-2 text-[13px]">
      <div className="min-w-0 flex-1">{children}</div>
      <Button size="sm" variant="ghost" onClick={onDelete}>
        Delete
      </Button>
    </li>
  );
}
