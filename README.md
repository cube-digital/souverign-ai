# Sovereign Agents

On-prem demo for client: end-to-end encrypted chat and video calls where every user brings their
own AI agents. Every model (LLM, speech-to-text, text-to-speech, embeddings) runs locally on one Mac
(M4 Max, 36 GB). Nothing calls an external AI service.

- Design: [docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md](docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md)
- Decisions: [docs/superpowers/specs/decisions.md](docs/superpowers/specs/decisions.md)
- Plans: [docs/relay/plans/](docs/relay/plans/)

## Quick start

```bash
make prereqs   # checks host tools, prints install commands for anything missing
make install   # JS + Python dev dependencies
make check     # lint + unit tests, no models needed
make models    # downloads every model in config/models.yaml (~30 GB, resumable)
make up        # postgres, LLM (PROFILE=fast|quality), whisper, Hermes smoke gateway
make smoke     # live checks: tool calls, STT, TTS, embeddings, Hermes, no egress, <= 32 GiB
make down
```
