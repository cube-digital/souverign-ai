import type { Approval, ApprovalDecision, ApprovalPublic, Question } from "@sa/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiFailure,
  approvalPublic,
  cancelApproval,
  decideApproval,
  approvals as fetchApprovals,
  getQuestion,
} from "../api";
import { type BridgeEvent, dispatchBridgeEvent } from "../lib/bridge-events";
import { openEvents } from "../lib/sse";
import { isAgentDm, openAgentDm } from "../state/agentDm";
import { useSession } from "../state/session";

type Store = {
  me: string;
  approvals: ReadonlyMap<string, Approval>;
  publics: ReadonlyMap<string, ApprovalPublic>;
  questions: ReadonlyMap<string, Question>;
  putApproval(a: Approval): void;
  putPublic(p: ApprovalPublic): void;
  putQuestion(q: Question): void;
  /** Loads every approval of mine once (history after a reload). */
  loadAll(): void;
};

const Ctx = createContext<Store | null>(null);

function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("approvals hooks outside ApprovalsProvider");
  return v;
}

const withEntry = <T,>(m: ReadonlyMap<string, T>, id: string, v: T): Map<string, T> =>
  new Map(m).set(id, v);

/** Holds approvals, their public shadows and questions; fed by the event stream and refetches. */
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const { user, chats, refreshChats, engine } = useSession();
  const me = user.id;
  const sessionRef = useRef({ chats, refreshChats, engine });
  sessionRef.current = { chats, refreshChats, engine };
  // A request can sit in an agent DM this device holds no key for: the agent opened the DM just
  // now (the inviter's notes), or another device of mine keyed it. Without a key here, the agent's
  // later messages there (a "not published" reminder) could not be read on this device.
  const keyRequestDm = useCallback(async (chatId: string) => {
    const s = sessionRef.current;
    const known = s.chats.find((c) => c.id === chatId);
    const dm = known ?? (await s.refreshChats()).find((c) => c.id === chatId);
    const { engine: eng, refreshChats: refresh } = sessionRef.current;
    const agent = dm && isAgentDm(dm) ? dm.members.find((m) => m.member_type === "agent") : null;
    if (!agent || !eng || (await eng.latestEpoch(chatId)) > 0) return;
    await openAgentDm({ engine: eng, refreshChats: refresh }, agent.member_id);
  }, []);
  const [approvals, setApprovals] = useState<ReadonlyMap<string, Approval>>(new Map());
  const [publics, setPublics] = useState<ReadonlyMap<string, ApprovalPublic>>(new Map());
  const [questions, setQuestions] = useState<ReadonlyMap<string, Question>>(new Map());

  const putApproval = useCallback((a: Approval) => setApprovals((m) => withEntry(m, a.id, a)), []);
  const putPublic = useCallback(
    (p: ApprovalPublic) => setPublics((m) => withEntry(m, p.id, p)),
    [],
  );
  const putQuestion = useCallback((q: Question) => setQuestions((m) => withEntry(m, q.id, q)), []);

  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  const allLoaded = useRef(false);

  const loadAll = useCallback(() => {
    if (allLoaded.current) return;
    allLoaded.current = true;
    fetchApprovals({ status: "all" })
      .then((list) =>
        setApprovals((m) => {
          const next = new Map(m);
          for (const a of list) next.set(a.id, a);
          return next;
        }),
      )
      .catch(() => {
        allLoaded.current = false;
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different user needs a new stream
  useEffect(() => {
    const ctl = new AbortController();
    openEvents(
      (e) => {
        if (e.type === "approval") {
          putApproval(e.approval);
          void keyRequestDm(e.approval.chat_id).catch(() => {});
        } else if (e.type === "approval_public") putPublic(e.approval);
        else if (e.type === "question") putQuestion(e.question);
        else if (/^(call|voice|latency)\./.test(e.type)) dispatchBridgeEvent(e as BridgeEvent);
      },
      {
        signal: ctl.signal,
        onOpen: () => {
          fetchApprovals({ status: "pending" })
            .then((list) => {
              if (ctl.signal.aborted) return;
              const fresh = new Set(list.map((a) => a.id));
              // Entries I still hold as pending but the server no longer lists were decided or
              // expired while the stream was down: take their status from the public shadow.
              const stale = [...approvalsRef.current.values()].filter(
                (a) => a.status === "pending" && !fresh.has(a.id),
              );
              setApprovals((m) => {
                const next = new Map(m);
                for (const a of list) next.set(a.id, a);
                return next;
              });
              for (const old of stale) {
                approvalPublic(old.id)
                  .then((p) => {
                    if (ctl.signal.aborted || !p) return;
                    putPublic(p);
                    setApprovals((m) => {
                      const cur = m.get(old.id);
                      return cur && cur.status === "pending"
                        ? withEntry(m, old.id, { ...cur, status: p.status })
                        : m;
                    });
                  })
                  .catch(() => {});
              }
            })
            .catch(() => {});
          for (const id of questionsRef.current.keys()) {
            getQuestion(id)
              .then((q) => {
                if (!ctl.signal.aborted && q) putQuestion(q);
              })
              .catch(() => {});
          }
        },
      },
    );
    return () => ctl.abort();
  }, [putApproval, putPublic, putQuestion, me]);

  const value = useMemo<Store>(
    () => ({ me, approvals, publics, questions, putApproval, putPublic, putQuestion, loadAll }),
    [me, approvals, publics, questions, putApproval, putPublic, putQuestion, loadAll],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** My approvals of one tool in one chat, oldest first (requests no message carries a card for). */
export function useChatApprovals(chatId: string, tool: string): Approval[] {
  const { approvals, me } = useStore();
  return useMemo(
    () =>
      [...approvals.values()]
        .filter((a) => a.chat_id === chatId && a.tool === tool && a.approver_user_id === me)
        .sort((a, b) => a.created_at - b.created_at),
    [approvals, me, chatId, tool],
  );
}

/** The signed-in user's id. */
export const useMe = (): string => useStore().me;

/** Pending approvals where I am the approver, soonest expiry first. */
export function usePendingApprovals(): Approval[] {
  const { approvals, me } = useStore();
  return useMemo(
    () =>
      [...approvals.values()]
        .filter((a) => a.status === "pending" && a.approver_user_id === me)
        .sort((a, b) => a.expires_at - b.expires_at),
    [approvals, me],
  );
}

export const useApproval = (id: string): Approval | undefined => useStore().approvals.get(id);

/** The public shadow of an approval; fetched once when the id is unknown. */
export function useApprovalPublic(id: string): ApprovalPublic | undefined {
  const { publics, approvals, putPublic } = useStore();
  const known = publics.has(id) || approvals.has(id);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (known || asked.current.has(id)) return;
    asked.current.add(id);
    approvalPublic(id)
      .then((p) => {
        if (p) putPublic(p);
      })
      .catch(() => {});
  }, [id, known, putPublic]);
  return publics.get(id);
}

/** Stores whatever a 409 carries: the current approval, or else an expired marker. */
function recoverConflict(err: unknown, current: Approval | undefined): Approval | null {
  if (!(err instanceof ApiFailure) || err.status !== 409) return null;
  const carried = (err.body as { approval?: Approval }).approval;
  if (carried) return carried;
  return current ? { ...current, status: "expired" } : null;
}

/** Decides an approval and stores the returned approval. */
export function useDecide(): (id: string, d: ApprovalDecision) => Promise<Approval> {
  const { approvals, putApproval } = useStore();
  return useCallback(
    async (id, d) => {
      try {
        const a = await decideApproval(id, d);
        putApproval(a);
        return a;
      } catch (err) {
        const a = recoverConflict(err, approvals.get(id));
        if (!a) throw err;
        putApproval(a);
        return a;
      }
    },
    [approvals, putApproval],
  );
}

/** Cancels an approval (requester) and stores the result, full or public. */
export function useCancel(): (id: string) => Promise<void> {
  const { approvals, putApproval, putPublic } = useStore();
  return useCallback(
    async (id) => {
      try {
        const r = await cancelApproval(id);
        if ("args" in r) putApproval(r);
        else putPublic(r);
      } catch (err) {
        const a = recoverConflict(err, approvals.get(id));
        if (!a) throw err;
        putApproval(a);
      }
    },
    [approvals, putApproval, putPublic],
  );
}

/** A question's state; fetched once when unknown, then kept fresh by `question` events. */
export function useQuestion(id: string): {
  question: Question | undefined;
  put(q: Question): void;
} {
  const { questions, putQuestion } = useStore();
  const known = questions.has(id);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (known || asked.current.has(id)) return;
    asked.current.add(id);
    getQuestion(id)
      .then((q) => {
        if (q) putQuestion(q);
      })
      .catch(() => {});
  }, [id, known, putQuestion]);
  return { question: questions.get(id), put: putQuestion };
}

/** Loads the approver's decided approvals once, so a reload shows stamped cards. */
export const useLoadAllApprovals = (): (() => void) => useStore().loadAll;
