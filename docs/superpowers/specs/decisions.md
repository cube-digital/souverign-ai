# Decizii — Sovereign Agents Demo

Data: 2026-10-24. Răspunsurile la §2 și §14 din
[design spec](2026-10-24-sovereign-agents-demo-design.md). Amendamentele din spec decurg de aici.

| # | Întrebare | Decizie |
|---|---|---|
| D-1 | Profil LLM implicit | Ambele profile rulează **local, pe Mac**; diferă doar mărimea modelului. `fast` (Qwen3.5-9B, ~10 GB) cât agenții de cod pornesc și testează aplicația; `quality` (Gemma 4 26B-A4B, ~14,5 GB, multimodal) pentru demo. Comutare: `make up PROFILE=quality` sau `LLM_PROFILE` în `.env`. Dacă tool calling-ul pe Gemma 4 nu trece smoke-ul, demo-ul rulează pe `fast`. |
| D-2 | Vocea / limba | **Engleza e limba principală** (UI, demo, voci). Kokoro pentru en/fr/es/it, Piper pentru de/ro. XTTS-ro iese din scop. |
| D-3 | Vizibilitatea notițelor din apel | Private la owner-ul agentului; ajung în chat doar după „Approve” (gated, ca `chat.send`). |
| D-4 | Agenți care vorbesc în apel | Nu acum. Se decide la SP7 (stretch). |
| D-5 | `client SDK` + sandbox the messaging server | Nu avem acces (A-1). Relay-ul propriu simulează the messaging server și rămâne înlocuibil. |
| D-6 | Vector DB / memory layer (Couchbase Lite?) | Rămâne **PostgreSQL + pgvector** pentru demo, în spatele unui port `MemoryStore`. Detalii mai jos. |
| D-7 | Locația codului | Repo nou `~/Workspaces/sovereign-agents`, separat de edge-ai; remote `github.com/cube-digital/souverign-ai`. |
| D-8 | Cum testăm cu 3–4 oameni | **MacBook-ul e serverul**, testerii folosesc doar browserul și intră prin **Tailscale** (node sharing, HTTPS prin `tailscale serve`). Nu fiecare pe laptopul lui: modelele cer un M4 Max cu 36 GB, iar 4 instanțe separate nu s-ar vedea între ele. Fără cloud: un VPS n-are GPU pentru modele, iar Cloudflare Tunnel nu duce UDP pentru apeluri și decriptează TLS-ul. Comunicarea dintre testeri se face chiar prin aplicație; Slack/WhatsApp rămân rezervă pentru coordonare și bug-uri. Sub-proiect nou SP1.5. |

## D-6 pe larg: de ce nu Couchbase Lite acum

Couchbase Lite e o bază de date embedded pentru device (iOS, Android, desktop, browser), cu sync
prin Sync Gateway. Pentru demo nu se potrivește:

- **Vector search e doar în Enterprise Edition**, cu o bibliotecă de extensie separată.
- **Nu are SDK pentru serverul nostru.** SDK-ul JavaScript e oficial doar în browser (Node, Deno și
  Bun nu sunt suportate), iar pentru Python nu există SDK oficial. Serviciul `memory` e Python pe
  Mac.
- **Ce ne trebuie e într-un singur SQL în pgvector:** hibridul vector + full-text (RRF), plus ACL-ul
  pe `namespace` și pe chat-urile în care agentul e membru.

Unde are sens: memoria **on-device** din aplicația mobilă client (SDK-ul edge-ai), unde contează
E2E + sync + offline. Ca să rămână drumul deschis, serviciul `memory` scrie printr-un port
`MemoryStore`; un backend Couchbase Lite se poate adăuga fără să schimbe API-ul.

**Memory layers gata făcute** (mem0, Zep, Letta) cheamă LLM-ul la fiecare scriere, ceea ce adaugă
latență pe un singur Mac, și nu dau citări + ACL per chat cum cere spec-ul. Memoria proprie a
Hermes rămâne dezactivată din același motiv. Agentul are o singură memorie, cea citată și cu ACL.
