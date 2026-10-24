import { Pill } from "./Pill";

export function TrustStrip() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill tone="teal">End-to-end encrypted</Pill>
      <Pill tone="neutral">Relay sees ciphertext only</Pill>
    </div>
  );
}
