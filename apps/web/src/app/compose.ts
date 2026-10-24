import type { Location } from "react-router";

export type ComposeState = { text: string; quote?: string | undefined };

/** The `{text, quote?}` that "Ask", the palette and the agent pages hand over in location.state. */
export function composeFrom(location: Location): ComposeState | undefined {
  const state = location.state as { compose?: ComposeState } | null;
  return typeof state?.compose?.text === "string" ? state.compose : undefined;
}
