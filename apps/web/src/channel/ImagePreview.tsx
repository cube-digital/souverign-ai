// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { MessageBody } from "@sa/protocol";
import { useEffect, useRef, useState } from "react";

type FileBody = Extract<MessageBody, { type: "file" }>;

/** Decrypts and shows an image once it scrolls into view; the object URL is revoked on unmount. */
export function ImagePreview({
  body,
  onDownload,
}: {
  body: FileBody;
  onDownload: (body: FileBody) => Promise<Uint8Array>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const download = useRef(onDownload);
  useEffect(() => {
    download.current = onDownload;
  }, [onDownload]);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (visible || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let made: string | null = null;
    let live = true;
    download
      .current(body)
      .then((bytes) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: body.mime }));
        setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [visible, body]);

  return (
    <div ref={box} className="mt-1 min-h-12">
      {url && (
        <img
          src={url}
          alt={body.name}
          loading="lazy"
          className="max-h-64 max-w-full rounded-md border border-border-soft"
        />
      )}
      {failed && <span className="text-text-2">Preview failed</span>}
    </div>
  );
}
