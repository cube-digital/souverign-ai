import type { ApprovalGrant } from "@sa/protocol";
import {
  GATED_TOOLS,
  INTERACTION_TOOLS,
  MEMORY_TOOLS,
  TEMPLATE_INFO,
  TOOL_TIER_NOTES,
} from "@sa/protocol/roster";

export type ToolTier = {
  tool: string;
  tier: "free" | "needs approval" | "always approved";
  note?: string;
};

/** Every tool a template has, with whether it runs freely, asks first, or was approved for good. */
export function toolTiers(template: string, grants: ApprovalGrant[]): ToolTier[] {
  const allowed = new Set(grants.map((g) => g.tool));
  const free = [
    ...(TEMPLATE_INFO[template]?.tools ?? []),
    ...MEMORY_TOOLS,
    ...INTERACTION_TOOLS,
  ] as string[];
  const gated = (GATED_TOOLS[template] ?? []) as string[];
  const row = (tool: string, tier: ToolTier["tier"]): ToolTier => {
    const note = TOOL_TIER_NOTES[tool];
    return note ? { tool, tier, note } : { tool, tier };
  };
  return [
    ...[...new Set(free)].filter((t) => !gated.includes(t)).map((t) => row(t, "free")),
    ...gated.map((t) => row(t, allowed.has(t) ? "always approved" : "needs approval")),
  ];
}
