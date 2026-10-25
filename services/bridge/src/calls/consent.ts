import type { CallInfo, ConsentDecision } from "@sa/protocol";

/** The inviter always consents; everyone else is `pending` until they answer. */
export function consentOf(
  userId: string,
  inviterId: string,
  decisions: Record<string, "accepted" | "declined">,
): ConsentDecision {
  if (userId === inviterId) return "accepted";
  return decisions[userId] ?? "pending";
}

/** True only for an accepted person who is in the call while the notetaker is active. */
export function capturable(userId: string, call: CallInfo): boolean {
  if (call.notetaker?.status !== "active") return false;
  const p = call.participants.find((x) => x.user_id === userId);
  return p?.in_call === true && p.consent === "accepted";
}

/** People who ever joined and did not accept; they are counted, never named. */
export function notCapturedCount(call: CallInfo): number {
  return call.participants.filter((p) => p.consent !== "accepted").length;
}
