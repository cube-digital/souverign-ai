# Mockups

Approved layout and style for the web app (2026-10-24). Live canvas:
https://claude.ai/artifact/Fv2dzhQD4tvCuFFG1kyffj (private; ask the owner for access).

The `.dc.html` files here are copies of the canvas artboards, readable as plain HTML with inline
styles. Use them for layout, spacing, colors and copy; the app is built with React + Tailwind, not
from these files.

| File | Screen | Built in |
|---|---|---|
| `Main.dc.html` | Chat, 3 columns: chats/agents, conversation, "What the relay sees" | SP1 (agent parts SP2–SP5) |
| `Approvals.dc.html` | Approval cards and agent action log | SP4 |
| `Agent.dc.html` | My agent: what it knows, teach, sharing (D-9) | SP2–SP4 |
| `Call.dc.html` | Call with a notes agent, consent, live capture | SP6 |
| `Presenter.dc.html` | Four users side by side, scene buttons | SP1.5 |

Style: dark "secure messaging" theme. Teal `#2FD3B5` = local / secure (agents use it too), amber
`#F2B44B` = waiting for your decision, Inter for text, JetBrains Mono for ciphertext. Fonts are
self-hosted in the app (no Google Fonts at runtime).
