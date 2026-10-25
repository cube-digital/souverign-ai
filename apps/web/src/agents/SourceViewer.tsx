import type { KnowledgeItemDetail } from "@sa/protocol";
import { useEffect, useState } from "react";
import { knowledgeItem } from "../api";
import { EmptyState, Modal } from "../ds";
import { knowledgeMeta } from "./knowledgeMeta";

export function SourceViewer({
  agentId,
  itemId,
  onCloseItem,
}: {
  agentId: string;
  itemId: string;
  onCloseItem: () => void;
}) {
  const [item, setItem] = useState<KnowledgeItemDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setItem(null);
    setFailed(false);
    knowledgeItem(agentId, itemId)
      .then((d) => live && setItem(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [agentId, itemId]);

  return (
    <Modal title={item?.title ?? "Source"} onClose={onCloseItem}>
      {failed && (
        <p role="alert" className="text-[12px] text-danger">
          Couldn't open this source.
        </p>
      )}
      {!item && !failed && <EmptyState>Loading…</EmptyState>}
      {item && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-text-3">{knowledgeMeta(item)}</p>
          {item.segments.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are static and ordered
            <section key={i}>
              {s.label && <h3 className="mb-1 text-[12px] font-semibold text-text-2">{s.label}</h3>}
              <p className="whitespace-pre-wrap text-[13px] text-text-0">{s.text}</p>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
