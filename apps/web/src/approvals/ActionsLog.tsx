import type { Approval, ApprovalGrant } from "@sa/protocol";
import { useCallback, useEffect, useState } from "react";
import { approvalGrants, approvals as fetchApprovals, revokeGrant } from "../api";
import { Button, Chip, EmptyState } from "../ds";
import { timeOf } from "../lib/format";

const TONE = {
  executed: "ok",
  approved: "ok",
  failed: "danger",
  denied: "warn",
  expired: "neutral",
  canceled: "neutral",
  pending: "ai",
} as const;

/** What an agent did: every approval row for it, plus the tools it may run without asking. */
export function ActionsLog({ agentId }: { agentId: string }) {
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [grants, setGrants] = useState<ApprovalGrant[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([fetchApprovals({ status: "all", agent_id: agentId }), approvalGrants()])
      .then(([a, g]) => {
        if (!live) return;
        setRows(a);
        setGrants(g.filter((x) => x.agent_id === agentId));
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [agentId]);

  const stop = useCallback(
    async (tool: string) => {
      try {
        await revokeGrant(agentId, tool);
        setGrants((g) => g.filter((x) => x.tool !== tool));
      } catch {
        setError(true);
      }
    },
    [agentId],
  );

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      {error && (
        <div role="alert" className="text-danger">
          Could not load or update the actions.
        </div>
      )}
      <section aria-label="Auto-approved tools" className="flex flex-col gap-1">
        {grants.map((g) => (
          <div key={g.tool} className="flex items-center gap-2">
            <span className="text-text-0">{g.tool}</span>
            <span className="text-text-2">is approved automatically</span>
            <Button size="sm" onClick={() => void stop(g.tool)}>
              Stop auto-approving
            </Button>
          </div>
        ))}
      </section>
      <section aria-label="Actions" className="flex flex-col">
        {rows?.length === 0 && <EmptyState>No actions yet.</EmptyState>}
        {rows?.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-1.5"
          >
            <span className="text-text-2">{timeOf(r.created_at)}</span>
            <span className="text-text-0">{r.tool}</span>
            <span className="text-text-1">{r.preview.target}</span>
            <Chip tone={TONE[r.status]}>{r.status}</Chip>
            {r.auto ? (
              <span className="text-text-2">auto-approved</span>
            ) : (
              r.decided_by && <span className="text-text-2">{r.decided_by}</span>
            )}
            {r.result && <span className="text-text-1">{r.result}</span>}
          </div>
        ))}
      </section>
    </div>
  );
}
