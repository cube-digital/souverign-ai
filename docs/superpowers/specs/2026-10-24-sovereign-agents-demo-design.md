# Sovereign Agents Demo — Design Spec

> **Locație în repo:** `docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md`
> **Pentru Claude Code:** brainstorming-ul (superpowers:brainstorming) e făcut în acest document. Pasul următor este câte un plan relay **per sub-proiect** (§11), în ordinea SP0 → SP7, în `docs/relay/plans/`. Nu scrie cod înainte de planul sub-proiectului curent.
> **Decizii:** `docs/superpowers/specs/decisions.md`. **Amendamentele de mai jos au prioritate față de restul documentului.**

**Un paragraf:** o aplicație de chat + apeluri video pentru 3–4 utilizatori, în stil client (E2E, relay care vede doar ciphertext), în care fiecare utilizator își creează și „învață” agenți proprii (Hermes Agent, un profil izolat per agent), îi invită în chat-uri și în apeluri (cu consimțământ explicit), iar toate modelele (LLM, STT, TTS, embeddings) rulează local pe un Mac M4 Pro/Max 36 GB.

---

## Amendamente (2026-10-24, după decizii)

1. **Limba principală e engleza** (D-2). UI-ul, scriptul de demo (§13), fixture-urile de test și vocile implicite sunt în engleză. Ordinea limbilor: en (prioritar), fr, de, it, es. Româna rămâne suportată (STT cu auto-detect + voce Piper), dar fără prioritate. Unde documentul spune „ro prioritar”, „bias ro” sau „set de 30 de perechi în română”, citește: STT bias `en`, full-text `english`/`simple`, setul de recall = 30 de perechi în engleză + 10 în fr/de. UI-ul e doar în engleză.
2. **TTS:** en/fr/es/it → Kokoro (`mlx-community/Kokoro-82M-bf16`, vocea implicită `af_heart`); de/ro → Piper (`de_DE-thorsten-medium`, `ro_RO-mihai-medium`). XTTS iese din scop.
3. **Modelele sunt fixate** în `config/models.yaml`: fast = `mlx-community/Qwen3.5-9B-8bit`, quality = `mlx-community/gemma-4-26b-a4b-it-4bit`, embeddings = `google/embeddinggemma-2` (Apache-2.0, 768 → 512 MRL, BF16), STT = `ggerganov/whisper.cpp` `ggml-large-v3-turbo-q5_0.bin`, fallback pentru meeting = `mlx-community/parakeet-tdt-0.6b-v3`, fallback pentru embeddings = `Qwen/Qwen3-Embedding-0.6B`. Server LLM: `vllm-mlx==0.4.1`.
4. **whisper.cpp vine din Homebrew (Metal), fără encoder CoreML.** CoreML cere build din surse, iar Metal pe M4 Max ajunge pentru demo.
5. **PostgreSQL 17 + pgvector rulează în Docker, pe `127.0.0.1:5433`.** Pe Mac rulează deja un Postgres 14 din Homebrew pe 5432.
6. **Network guard = verificare de socket-uri, nu proxy.** `make smoke` rulează cu `HF_HUB_OFFLINE=1` și `TRANSFORMERS_OFFLINE=1` și verifică (cu psutil) că niciun proces al stack-ului (nici copiii lor, nici procesul de test) nu are conexiuni către adrese non-loopback. Un proxy prinde doar clienții care respectă `HTTP_PROXY`; verificarea de socket-uri prinde tot.
7. **Memory guard = memoria folosită de sistem (total − available) ≤ 32 GiB**, cu tot stack-ul pornit. RSS nu vede alocările Metal ale MLX.
8. **Hermes:** API server-ul expune toate toolset-urile activate, inclusiv terminalul. De aceea fiecare profil de agent dezactivează toate toolset-urile built-in (`agent.disabled_toolsets`, lista în `infra/hermes/toolsets.yaml`) și primește doar tool-urile MCP ale bridge-ului. Memoria proprie Hermes e dezactivată: memoria citată, cu ACL, e serviciul `memory`. Sesiunea per chat = header `X-Hermes-Session-Id: <agent_id>:<chat_id>` pe `/v1/chat/completions`, deci riscul 1 din §12 e acoperit de API. Portul 8700 e rezervat profilului de smoke; agenții primesc 8701–8709.
9. **Instalările de sistem le face omul.** `make prereqs` doar verifică și afișează comenzile de instalare (brew, `uv tool install`, installer-ul Hermes). Agenții de cod rulează doar scripturile proiectului (`pnpm install`, `uv sync`, `make models`), niciodată `curl | bash` sau `brew`.
10. **Vector DB / memory layer:** rămâne PostgreSQL + pgvector, în spatele unui port `MemoryStore` (SP3). Couchbase Lite a fost evaluat și amânat pentru memoria on-device din aplicația mobilă (vezi D-6).
11. **Hardware confirmat:** Apple M4 Max, 36 GB, macOS 15.7.3. Node 23, pnpm 9.10, uv 0.12 și Docker sunt deja instalate.
12. **Deploy pentru teste (D-8):** MacBook-ul e serverul. Testerii (3–4, fiecare pe laptopul lui) folosesc doar browserul și ajung la Mac prin Tailscale (node sharing: văd doar acest Mac), pe HTTPS dat de `tailscale serve`. Nimic nu e expus pe internet, nimic nu rulează în cloud. Sub-proiect nou **SP1.5**, imediat după SP1. De la SP1 încolo, clientul web ia adresele serviciilor din origine/config, niciodată `localhost` scris în cod.

---

## 1. Scop, non-scop, criterii de succes

### 1.1 Scop (ce demonstrăm)
1. **Chat E2E multi-user (3–4 useri)** cu relay „neîncrezător” care stochează și rutează doar ciphertext; UI arată log-ul relay-ului ca dovadă.
2. **Agenți suverani per utilizator:** fiecare user își creează agenți (nume, personalitate, voce, tool-uri permise, limbi), îi „învață” (instrucțiuni + documente + corecții) și decide în ce chat-uri/apeluri intră. Un agent vede doar ce i-a fost dat explicit (cheia chat-ului, cheia apelului).
3. **Tool calling fiabil prin MCP** cu scrieri „gated” (agentul propune, omul aprobă) — pattern-ul Viktor.
4. **Memorie persistentă, citată, cu control de acces** (PostgreSQL + pgvector + full-text), per agent și per chat.
5. **Voce în chat** (push-to-talk → STT → agent → TTS) cu engleza + încă 2–3 limbi europene (amendamentul 1).
6. **Apel video LiveKit** în care un participant aduce un agent (al lui) care ia notițe pe transcript per vorbitor; ceilalți participanți consimt; notițele ajung în memoria agentului și în chat.
7. **Totul on-prem**, pe un singur Mac, cu latență voice-to-voice ≤ 2 s.

### 1.2 Non-scop (explicit tăiat, YAGNI)
- Generare de imagini (nu încape rezident pe 36 GB; tool-ul `image_generate` răspunde „indisponibil în acest profil”).
- Forward secrecy / double ratchet; folosim sender-keys simple (vezi §4, A4). Suficient pentru demo, documentat ca limitare.
- Mobile / Electron. Doar web (Chrome/Safari desktop).
- KMS per namespace, retenție automată, tombstones în UI (rămân doar în schemă ca coloane).
- Multi-tenant real, autentificare robustă (login = alegi un user din listă + PIN).
- Agenți care vorbesc în apel (stretch, §11 SP7).

### 1.3 Criterii de succes (scenariul de demo, §13, rulat cap-coadă)
- 4 tab-uri de browser = 4 useri; mesaje text și vocale în ambele sensuri; relay-ul nu are niciun octet de plaintext (test automat).
- Un agent învățat cu un PDF răspunde la o întrebare cu citare `[sursă · timestamp]`.
- Un `chat.send` propus de agent apare ca aprobare la owner și se execută doar după „Aprobă”.
- Apel cu 3 useri + 1 agent de notițe: transcript atribuit per vorbitor, notițe la final, publicate în chat după aprobare.
- Toate procesele rulează local; `make smoke` verifică fiecare model.

---

## 2. Ce am înțeles vs. presupuneri vs. decizii deschise

**Spus de tine:** React + backend, 3–4 useri, chat, fiecare își cheamă agenți pe care îi pregătește/învață, apel video cu agent (cineva decide să aducă un agent care înregistrează / fiecare poate veni cu agentul lui pentru meeting notes), „totul e suveran”, folosim și embeddings Gemma, demo pe M4 Pro/Max 36 GB, limbi europene (engleza principală — amendamentul 1), ștacheta funcțională = Viktor.

**Presupuneri (corectează-mă în repo dacă greșesc):**
- A-1. Nu avem un mediu client real; simulăm the messaging server cu un relay propriu. Dacă apare `client SDK` + sandbox, înlocuiește `packages/crypto` + `services/relay`, restul rămâne.
- A-2. „Suveran” înseamnă: (i) agentul aparține unui user și rulează ca identitate separată (device + chei proprii), (ii) primește cheia unui chat/apel doar când e invitat, (iii) memoria lui e în namespace-ul lui, (iv) orice acțiune cu efect extern e gated de owner, (v) toți participanții văd când un agent e prezent și ce captează.
- A-3. 1–2 agenți per user, max 6 agenți activi.
- A-4. Demo-ul rulează pe un singur Mac; separarea relay/bridge e logică (procese separate, baze de date separate), nu fizică.

**Decizii deschise:** toate au răspuns în `decisions.md` (D-1 … D-7).

---

## 3. Constrângeri globale (se aplică fiecărui plan și fiecărui task)

- **Hardware:** Apple Silicon M4 Max, 36 GB memorie unificată. Bugetul din §6 e obligatoriu; orice task care adaugă un model trebuie să actualizeze tabelul.
- **On-prem strict:** nicio cerere de rețea către servicii AI externe. `make smoke` rulează cu `NETWORK_GUARD=1` (amendamentul 6). **Edge TTS (implicitul Hermes) e interzis** — e cloud Microsoft.
- **Limbi:** en (prioritar), fr, de, it, es; ro suportat. STT auto-detect; TTS rutat după limba detectată; UI în engleză.
- **Versiuni:** Node ≥ 22, pnpm ≥ 9, Python ≥ 3.12 (uv), PostgreSQL 17 + pgvector ≥ 0.8, LiveKit server ≥ 1.9 (`brew install livekit`), Hermes Agent (ultima versiune stabilă; se fixează în `infra/hermes/VERSION`).
- **E2E:** relay-ul și LiveKit SFU nu primesc niciodată chei sau plaintext. Orice test de integrare pentru relay asertează `plaintext ∉ storage`.
- **Toate serviciile:** OpenAI-compatibile unde există convenție (`/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/audio/speech`), health la `GET /healthz`, config prin `.env` + `config/*.yaml`, log JSON pe stdout.
- **Fără secrete în repo.** Cheile de device se generează la `make seed`.
- **Testare:** vitest (TS), pytest (Python), Playwright pentru scenariul de demo (4 contexte de browser). TDD per task.
- **Nume:** monorepo `sovereign-agents`; pachetele TS cu scope `@sa/*`.

---

## 4. Decizii de arhitectură (ADR scurte)

**A1 — Apeluri: LiveKit self-hosted, nu WebRTC mesh propriu.**
LiveKit server rulează local (Homebrew), clientul folosește `@livekit/components-react`, iar agentul de notițe e un worker `livekit-agents` (Python) care intră în cameră ca participant. Avantaj decisiv: fiecare participant are propriul track audio → transcript atribuit per vorbitor **fără diarizare**. LiveKit suportă E2EE pe media cu cheie partajată, inclusiv pentru agenți Python (`rtc.E2EEOptions`), deci „agentul primește cheia doar la consimțământ” e implementabil nativ (SP7).

**A2 — Runtime de agent: Hermes Agent, un profil izolat per agent.**
Hermes are `hermes profile create <name>` → `HERMES_HOME=~/.hermes/profiles/<name>` cu `config.yaml`, `.env`, `SOUL.md` (personalitate), `skills/`, memorie și gateway proprii. Un **Agent Supervisor** în bridge creează/pornește/oprește profile și le scrie configul (provider `custom` → serverul local de LLM, `reasoning_effort: low`, API server pe port dedicat, MCP server = bridge-ul, cu token per agent). Izolarea e reală (fișiere, sesiuni, memorie), iar „învățatul” = scriere în `SOUL.md` + skills + knowledge. Interfața `AgentRuntime` din bridge e abstractă, ca să putem înlocui Hermes cu o buclă proprie dacă profilele se dovedesc prea grele. Toolset-urile built-in sunt dezactivate (amendamentul 8).

**A3 — Servire LLM: `vllm-mlx` (continuous batching), nu `mlx_lm.server`/Ollama.**
3–4 useri + agenți de notițe înseamnă cereri concurente; `mlx-lm` și `llama.cpp` procesează secvențial, `vllm-mlx` are continuous batching, prefix cache (critic pe Mac, unde prompt processing-ul e gâtul de sticlă) și poate servi și embeddings/audio din același proces. Fallback: LM Studio (MLX) dacă `vllm-mlx` are probleme cu un model.

**A4 — Criptografie E2E în chat: libsodium, sender-keys simple.**
Fiecare device (user sau agent) are o pereche X25519 (`crypto_box`). Fiecare chat are o cheie simetrică XChaCha20-Poly1305 generată de creator și distribuită fiecărui device membru cu `crypto_box_seal`. Mesajele și atașamentele se criptează cu cheia chat-ului (atașamentele cu cheie per fișier, trimisă în mesaj). **Invitarea unui agent într-un chat = trimiterea cheii către device-ul agentului.** Rotație de cheie la eliminarea unui membru (nou `key_epoch`). Fără forward secrecy — documentat.

**A5 — Embeddings: EmbeddingGemma 2 (text-only, 270M), 768 → 512 dim (MRL).**
Apache 2.0, 100+ limbi, context 8K, multimodal opțional (audio/imagine) pentru mai târziu. Se încarcă doar backbone-ul text (`config_kwargs={"vision_config": None, "audio_config": None}`), în **BF16 (nu FP16 — produce NaN)**. pgvector `vector(512)` cu HNSW cosine. Prompturi: query `task: search result | query: …`, document `title: {title} | text: …`. Fallback: Qwen3-Embedding-0.6B (1024 dim) dacă recall-ul iese slab pe setul nostru de validare (SP3).

**A6 — Două profile de modele, comutabile din `config/models.yaml`.**
`fast`: Qwen3.5-9B MLX 8-bit. `quality`: Gemma 4 26B-A4B MLX 4-bit (multimodal → imaginile din chat merg direct la LLM). Ambele rulează local. Un singur LLM încărcat la un moment dat. Thinking dezactivat/`low` pe turnurile de chat și voce; `medium` doar pe joburile asincrone (notițe de meeting, rezumate de documente).

**A7 — Scrieri gated prin „approval”.**
Orice tool MCP cu efect extern întoarce imediat `{status:"pending", approval_id}`; bridge-ul emite cardul de aprobare către owner; la decizie, execută și livrează rezultatul ca mesaj de continuare în sesiunea Hermes a agentului. Toolurile read-only și scrierea în propria memorie nu sunt gated.

**A8 — Monorepo pnpm + uv, procese separate per graniță de încredere.**
Relay-ul e proces și bază de date separate (SQLite cu ciphertext), ca să fie evident ce vede. Tot ce e „de partea userului” (bridge, memorie, agenți, audio) e de cealaltă parte a graniței.

---

## 5. Arhitectura

### 5.1 Componente și procese (toate pe același Mac)

```mermaid
flowchart LR
  subgraph untrusted["Zonă neîncrezătoare (vede doar ciphertext)"]
    RELAY["relay :8648<br/>WS + blob store (SQLite)"]
    LK["LiveKit SFU :7880/7881 + UDP"]
  end

  subgraph clients["Clienți (browser, 4 tab-uri)"]
    WEB["apps/web (React)<br/>chei device în IndexedDB"]
  end

  subgraph trusted["Zonă de încredere (bridge-side)"]
    BRIDGE["bridge :8647<br/>devices · queue/gates · knowledge · hermesClient<br/>MCP server · approvals · media I/O · LiveKit tokens · Agent Supervisor"]
    MEM["memory :8646<br/>ingest · recall · EmbeddingGemma 2"]
    AUDIO["audio-api :8645<br/>STT (whisper.cpp) · TTS (Kokoro/Piper)"]
    HER["Hermes profiles<br/>gateway :8701+N (unul per agent)"]
    LLM["vllm-mlx :8000<br/>Qwen3.5-9B | Gemma 4 26B-A4B"]
    WSP["whisper-server :8081"]
    PG[("PostgreSQL + pgvector :5433")]
    MA["meeting-agent worker (livekit-agents)"]
  end

  WEB <-->|ciphertext| RELAY
  WEB <-->|WebRTC| LK
  RELAY <-->|ciphertext| BRIDGE
  BRIDGE <--> HER
  HER -->|/v1/chat/completions| LLM
  HER -->|MCP (HTTP, token per agent)| BRIDGE
  BRIDGE --> MEM
  BRIDGE --> AUDIO
  AUDIO --> WSP
  MEM --> PG
  BRIDGE --> PG
  MA <-->|audio tracks| LK
  MA --> AUDIO
  MA --> BRIDGE
```

### 5.2 Fluxuri principale

**F1 — Mesaj text către un agent.**
`web` criptează cu cheia chat-ului → `relay` stochează ciphertext, notifică device-urile membre → `bridge` (device-ul agentului) decriptează → coadă per chat → acceptance gate (agentul e membru? mesajul îl adresează? rate limit?) → `knowledge` compune contextul compact (ultimele N mesaje decriptate + rezumat) → `hermesClient.chat(agentId, chatId, messages)` → Hermes rulează bucla cu tool-uri MCP (`chat.read`, `memory.recall`, …) → răspuns → `bridge` criptează și trimite prin relay → `memory.ingest` (user + agent turn) asincron.

**F2 — Voce în chat.** PTT în `web` (Opus/WebM, max 60 s) → blob criptat prin relay → `bridge` decriptează → `audio-api` STT (`language=auto`, bias `en`) → F1 cu textul → răspunsul → `audio-api` TTS (vocea agentului, limba răspunsului) → audio criptat + transcript înapoi. HUD de latență în UI (t_stt, t_llm_first_token, t_tts_first_audio, total).

**F3 — Învățarea unui agent.** (a) *Lecție*: text liber → se adaugă în `SOUL.md`/`skills/lessons.md` al profilului + rând în `agent_lessons`. (b) *Cunoștințe*: PDF/DOCX/XLSX → extracție locală (pdf-parse/mammoth/SheetJS) → chunking (800 tokeni, overlap 100) → `memory.ingest(namespace=agent_id, kind=knowledge)`. (c) *Corecție*: 👎 pe un răspuns + text → `memory.ingest(kind=correction)` cu prioritate la recall.

**F4 — Scriere gated.** Hermes apelează `chat.send` → bridge creează `approvals(status=pending)` → eveniment la owner → cardul „Agentul X vrea să trimită în #chat: …” → Aprobă/Respinge → bridge execută (criptează, trimite) → `hermesClient.continue(sessionId, "approval <id>: approved, sent")`.

**F5 — Agent în apel video.** Owner apasă „Adu agentul X ca să ia notițe” → bridge creează `meeting_agents(status=requested)` → banner la toți participanții cu Accept/Refuz → la acceptul tuturor (sau conform politicii camerei) bridge emite token LiveKit pentru identitatea `agent:<id>` și (SP7) trimite cheia E2EE a camerei către device-ul agentului prin chat-ul E2E → `meeting-agent` intră, se abonează la toate track-urile audio remote → VAD per track → segmente → STT → `meeting_segments` → la 5 min și la final: rezumat (via Hermes al agentului, `reasoning_effort: medium`) → `meeting_notes` → `memory.ingest(namespace=agent_id, kind=meeting)` → propunere `chat.send` gated cu notițele (D-3: private până la aprobare).

### 5.3 Porturi

| Serviciu | Port | Tehnologie |
|---|---|---|
| web (Vite dev) | 5173 | React 19, TS, Tailwind, `@livekit/components-react`, `libsodium-wrappers-sumo` |
| relay | 8648 | Node/TS, `ws`, SQLite (better-sqlite3) |
| bridge | 8647 | Node/TS, Fastify, `@modelcontextprotocol/sdk` (streamable HTTP), `livekit-server-sdk` |
| memory | 8646 | Python, FastAPI, sentence-transformers (MPS, BF16), psycopg |
| audio-api | 8645 | Python, FastAPI; proxy whisper-server; Kokoro (mlx-audio) + Piper (CPU) |
| whisper-server | 8081 | whisper.cpp `large-v3-turbo` q5_0 (Homebrew, Metal) |
| vllm-mlx | 8000 | LLM (+ opțional embeddings) |
| Hermes smoke | 8700 | profilul `sa-smoke` din `make up` |
| Hermes gateways | 8701–8709 | un API server per profil de agent |
| PostgreSQL | 5433 (host) | Postgres 17 + pgvector, Docker |
| LiveKit | 7880 (ws), 7881 (tcp), 50000–50100/udp | `livekit-server --dev` cu `infra/livekit.yaml` |

### 5.4 Fluxul de identitate și chei

- Fiecare **user** are 1 device (browser) cu cheie X25519 în IndexedDB.
- Fiecare **agent** are 1 device al cărui private key stă în bridge (`agent_devices`), criptat cu o cheie master locală (`BRIDGE_MASTER_KEY` din `.env`).
- **Chat key** (`chat_keys`: chat_id, epoch, ciphertext per device). Rotație la remove.
- **Room key LiveKit** (SP7): generată de creatorul apelului în browser, trimisă membrilor prin chat-ul E2E al camerei; agentul o primește doar după consimțământ.
- Relay-ul vede: id-uri de chat/device, timestamps, dimensiuni. Nu vede: chei, plaintext, nume de fișiere (și ele criptate în envelope).

---

## 6. Bugetul de memorie (36 GB)

| Componentă | `fast` | `quality` |
|---|---|---|
| macOS + 4 tab-uri browser + Node + Python runtime | ~8,0 GB | ~8,0 GB |
| LLM (vllm-mlx) — Qwen3.5-9B 8-bit / Gemma 4 26B-A4B 4-bit | ~10,0 GB | ~14,5 GB |
| KV cache (4 sesiuni × ~8k, prefix cache) | ~2,0 GB | ~2,5 GB |
| whisper.cpp large-v3-turbo q5_0 (Metal) | ~1,5 GB | ~1,5 GB |
| EmbeddingGemma 2 text-only BF16 | ~0,7 GB | ~0,7 GB |
| Kokoro (mlx-audio) + Piper (CPU) | ~0,6 GB | ~0,6 GB |
| Hermes profiles (≤ 6 × ~0,3 GB) | ~1,8 GB | ~1,8 GB |
| LiveKit server + meeting-agent worker | ~0,8 GB | ~0,8 GB |
| PostgreSQL (Docker VM inclus) | ~0,5 GB | ~0,5 GB |
| **Total** | **~25,9 GB** | **~30,9 GB** |

Reguli: (1) profilul `quality` cere `sudo sysctl iogpu.wired_limit_mb=30000` și închiderea altor aplicații; (2) `make smoke` eșuează dacă memoria folosită de sistem depășește 32 GiB (amendamentul 7); (3) nu se încarcă al doilea LLM niciodată — schimbarea de profil = restart `vllm-mlx`; (4) Qwen3.6-35B-A3B (~21 GB) rămâne explicit în afara acestui Mac.

---

## 7. Modelul de date (PostgreSQL, schema `sa`)

Doar coloanele care fixează decizii; tipurile exacte le decide planul SP-ului.

| Tabel | Coloane cheie | Note |
|---|---|---|
| `users` | id, display_name, pin_hash, locale | login simplu pentru demo |
| `devices` | id, owner_type (`user`\|`agent`), owner_id, pubkey, created_at | private key-ul userilor nu e aici |
| `agent_devices` | device_id, enc_private_key | criptat cu `BRIDGE_MASTER_KEY` |
| `chats` | id, title, kind (`dm`\|`group`\|`room`), created_by | `room` = chat-ul atașat unui apel |
| `chat_members` | chat_id, device_id, role (`owner`\|`member`\|`agent`), joined_at, removed_at | |
| `chat_keys` | chat_id, epoch, device_id, sealed_key | cheia chat-ului sigilată per device |
| `messages_plain` | id, chat_id, sender_device_id, epoch, kind (`text`\|`audio`\|`file`\|`system`), body, attachment_id, ts | **doar în bridge**, pentru device-urile de agent; relay-ul are tabela lui de ciphertext |
| `attachments` | id, chat_id, mime, size, local_path, extracted_text_hash | blob-ul criptat stă în relay; textul extras stă în memory |
| `agents` | id, owner_user_id, name, avatar, soul, hermes_profile, api_port, tools_allowlist (jsonb), capabilities (jsonb: chat, voice, join_calls, take_notes), voice_id, languages (text[]), status | `hermes_profile = 'agent_' + id` |
| `agent_lessons` | id, agent_id, text, applied_to (`soul`\|`skill`), ts | |
| `memory_chunks` | id, namespace, kind (`conversation`\|`knowledge`\|`correction`\|`meeting`), scope_chat_id, source (jsonb: type, id, title, ts), text, tsv (tsvector `english`/`simple`), embedding vector(512), created_at | HNSW cosine pe `embedding`; GIN pe `tsv` |
| `approvals` | id, agent_id, owner_user_id, tool, args (jsonb), status (`pending`\|`approved`\|`denied`\|`executed`\|`failed`), hermes_session_id, decided_at, result (jsonb) | |
| `meetings` | id, chat_id, livekit_room, started_by, started_at, ended_at, policy (`owner_only`\|`anyone_with_consent`) | |
| `meeting_agents` | meeting_id, agent_id, status (`requested`\|`joined`\|`left`\|`refused`), consents (jsonb: user_id → bool) | |
| `meeting_segments` | id, meeting_id, speaker_identity, t0, t1, text, lang | per track → fără diarizare |
| `meeting_notes` | id, meeting_id, agent_id, body_md, version, published_message_id | |

Controlul de acces la recall: un agent poate interoga `namespace = agent.id` și `scope_chat_id ∈ chat-urile în care device-ul lui e membru activ`. Nimic altceva.

---

## 8. Interfețe între componente

### 8.1 Protocolul relay (WS, JSON, `packages/protocol`)
```ts
type Envelope = {
  v: 1; id: string; chat_id: string; sender_device: string; epoch: number;
  kind: "msg" | "key" | "blob_ref" | "presence";
  nonce: string;            // base64, 24 bytes
  ciphertext: string;       // base64, XChaCha20-Poly1305 (sau crypto_box_seal pentru kind="key")
  ts: number;
};
// client → relay: {op:"auth", device_id, sig}, {op:"send", env}, {op:"sync", chat_id, since}
// relay → client: {op:"deliver", env}, {op:"ack", id}
```
Relay-ul validează doar semnătura device-ului și apartenența (din `chat_members` publică: chat_id ↔ device_id), nu conținutul.

### 8.2 Tool-urile MCP expuse de bridge (per token de agent)
| Tool | Gated | Semantică |
|---|---|---|
| `chat.read(chat_id, limit≤50, before?)` | nu | mesaje plaintext din chat-uri în care agentul e membru |
| `memory.recall(query, chat_id?, k≤8)` | nu | hibrid (vector + full-text) peste namespace-ul propriu + chat-urile permise; răspuns `[{text, source, ts, score}]` |
| `memory.remember(text, tags[])` | nu | scrie în namespace-ul propriu, `kind=conversation` |
| `documents.extract(attachment_id)` | nu | text extras local; fișierul nu părăsește bridge-ul |
| `meeting.transcript(meeting_id)` | nu | doar dacă agentul a participat |
| `chat.send(chat_id, text)` | **da** | `{status:"pending", approval_id}` |
| `notes.create(title, body_md, visibility)` | **da** | idem |
| `image_generate(prompt)` | — | întoarce `{error:"unavailable_in_profile"}` |

### 8.3 `AgentRuntime` (bridge, TS) — implementat de `HermesRuntime`
```ts
interface AgentRuntime {
  ensureStarted(agent: Agent): Promise<{ baseUrl: string }>;
  chat(agent: Agent, sessionId: string, messages: ChatMessage[], opts: { reasoning: "low"|"medium" }): AsyncIterable<Delta>;
  continue(agent: Agent, sessionId: string, systemNote: string): Promise<void>;
  applyLesson(agent: Agent, lesson: string): Promise<void>;     // scrie în SOUL.md / skills
  stop(agent: Agent): Promise<void>;
}
```
`HermesRuntime` generează din template `infra/hermes/config.template.yaml`: `model.provider: custom`, `model.base_url: http://127.0.0.1:8000/v1`, `model.default` din profilul activ, `agent.reasoning_effort: low`, `agent.disabled_toolsets` din `infra/hermes/toolsets.yaml`, `gateway.api_server` activ pe `agents.api_port`, MCP server `http://127.0.0.1:8647/mcp` cu header `Authorization: Bearer <agent_token>`, TTS/STT dezactivate (le face bridge-ul). Cheile de config sunt verificate în SP0 contra versiunii fixate a Hermes.

### 8.4 Memory API (Python, `services/memory`)
- `POST /ingest {namespace, kind, scope_chat_id?, source, text}` → chunking + embed + upsert; idempotent pe `(source.type, source.id, chunk_idx)`.
- `POST /recall {namespaces[], chat_ids[], query, k}` → RRF între HNSW cosine și `ts_rank` (`english` dacă limba detectată e en, altfel `simple`); întoarce citări.
- `POST /embed {texts[]}` → vectori 512-dim (MRL, re-normalizați).
- Stocarea trece printr-un port `MemoryStore` (implementare: pgvector), ca un alt backend (ex. Couchbase Lite on-device) să poată fi adăugat (D-6).

### 8.5 Audio API (Python, `services/audio-api`)
- `POST /v1/audio/transcriptions` (multipart, `language=auto|en|fr|…`, `response_format=verbose_json`) → `{text, language, segments[]}`; proxy către whisper-server.
- `POST /v1/audio/speech {input, voice, language?, response_format: "wav"|"opus", stream: bool}` → rutare: `en|fr|es|it` → Kokoro; `de|ro` → Piper (amendamentul 2).
- Streaming: chunk-uri pe propoziție; prima propoziție pleacă imediat.

### 8.6 Meeting agent worker (Python, `services/meeting-agent`)
- Job per `(meeting_id, agent_id)`; identitate LiveKit `agent:<agent_id>`; metadata JSON `{owner, purpose:"notes"}` afișată în UI.
- Per track remote: Silero VAD → segmente ≥ 0,6 s → `audio-api` STT → `POST bridge /internal/meetings/{id}/segments`.
- La `tick(5min)` și la `room_ended`: `POST bridge /internal/meetings/{id}/summarize` (bridge-ul cere rezumatul prin runtime-ul agentului).

### 8.7 Evenimente bridge → web (SSE pe `/events`)
`approval.created | approval.resolved | agent.status | meeting.agent_requested | meeting.agent_joined | meeting.notes_ready | latency.sample`.

---

## 9. Agenți suverani — modelul de produs

**Profilul unui agent** (editabil în UI, pagina „My agents”): nume, avatar, `soul` (personalitate + reguli, max 2.000 caractere), limbi, voce TTS, tool-uri permise (subset din §8.2), capabilități (`chat`, `voice`, `join_calls`, `take_notes`), profil LLM preferat (`fast`/`quality`, doar informativ — un singur LLM e încărcat).

**Învățare** (§5.2 F3): lecții, cunoștințe (documente), corecții. UI arată „What the agent knows”: lista documentelor, ultimele lecții, numărul de chunk-uri de memorie, cu butoane de ștergere (ștergerea = `DELETE memory_chunks WHERE source.id=…`; tombstones rămân în afara scopului).

**Invitare în chat:** doar owner-ul agentului îl poate adăuga într-un chat din care face parte; ceilalți membri văd un mesaj de sistem „X added agent Y (it can read messages from now on)”. Cheia chat-ului se sigilează pentru device-ul agentului **de la epoca curentă**; agentul nu primește istoricul anterior (`chat.read` filtrează `epoch ≥ join_epoch`).

**Apeluri:** politica camerei (`owner_only` / `anyone_with_consent`) e setată la creare. Un agent apare în lista de participanți cu badge „🎙 taking notes · X's agent”. Orice participant poate cere oprirea (`meeting_agents.status=left`); decizia e a owner-ului camerei, iar refuzul se loghează ca mesaj de sistem.

**Transparență:** fiecare răspuns al agentului poartă în UI tool-urile apelate și sursele citate (expandabil). Panoul relay-ului arată ultimele 50 de envelope-uri cu `ciphertext` trunchiat, pentru dovadă vizuală.

---

## 10. Structura repo-ului (monorepo)

```
sovereign-agents/
├── apps/web/                     React 19 + Vite + TS; pagini: Login, Chats, Agents, Call; HUD latență; panou relay
├── services/relay/               Node/TS; WS server; SQLite (envelopes, blobs); zero dependențe spre bridge
├── services/bridge/              Node/TS Fastify; module: devices, chats, queue, gates, knowledge, hermesClient,
│                                 mcp-server, approvals, media-io, extraction, livekit-tokens, agent-supervisor, events
├── services/memory/              Python FastAPI; EmbeddingGemma 2; ingest/recall/embed; migrații SQL
├── services/audio-api/           Python FastAPI; STT proxy; TTS (Kokoro via mlx-audio, Piper); rutare pe limbă
├── services/meeting-agent/       Python livekit-agents worker; VAD; segmente; summarize hooks
├── packages/protocol/            TS: Envelope, evenimente, DTO-uri, zod; folosit de web + relay + bridge
├── packages/crypto/              TS: libsodium wrappers (device keys, chat keys, seal/open, blob encrypt); testat izolat
├── config/models.yaml            sursa unică pentru id-urile de modele
├── infra/
│   ├── docker-compose.yaml       postgres+pgvector (LiveKit rulează nativ pentru UDP)
│   ├── livekit.yaml              dev keys, porturi, codec-uri (SP6)
│   ├── models/                   download.sh, start-llm.sh, start-whisper.sh, README.md
│   ├── hermes/                   VERSION, pin.sh, config.template.yaml, SOUL.template.md, toolsets.yaml
│   ├── scripts/                  prereqs.sh, up.sh, down.sh
│   └── py/                       pachetul Python `sa-infra`: config loader, guards, smoke tests
├── e2e/                          Playwright: scenariul de demo (4 contexte)
├── Makefile                      install / check / prereqs / models / up / smoke / down (+ seed / demo mai târziu)
└── docs/superpowers/specs/, docs/relay/plans/
```

---

## 11. Sub-proiecte și milestones (fiecare primește propriul plan relay)

Ordinea e strictă; fiecare SP livrează software funcțional și testabil singur.

### SP0 — Fundația și modelele (≈ 1 zi)
**Livrabil:** `make up && make models && make smoke` verde; toate modelele pornesc și răspund.
- Monorepo pnpm + uv, lint/test local (`make check`).
- `infra/models/download.sh`: Qwen3.5-9B MLX 8-bit, Gemma 4 26B-A4B MLX 4-bit, whisper large-v3-turbo (ggml q5_0), EmbeddingGemma 2, Kokoro, Piper de/ro. Repo-urile exacte stau în `config/models.yaml`.
- `start-llm.sh <profil>` → `vllm-mlx serve … --continuous-batching --enable-auto-tool-choice --tool-call-parser …`; `start-whisper.sh`.
- Smoke tests (pytest): tool call corect pe `/v1/chat/completions` cu 3 tool-uri; STT pe un wav englezesc de ~10 s (WER < 15% față de referință) + detecție de limbă pe un wav german; TTS en/fr (Kokoro) și de (Piper) → wav > 1 s; embedding 512-dim normalizat; pgvector ≥ 0.8; `NETWORK_GUARD=1` fără egress; memorie ≤ 32 GiB.
- Hermes fixat în `infra/hermes/VERSION`; profilul `sa-smoke` pe LLM-ul local, toolset-uri built-in dezactivate; un tool call MCP de probă prin API server.
- **Risc:** `vllm-mlx` nu încarcă Gemma 4 sau nu parsează tool call-urile ei → `tool_call_parser: auto`, apoi fallback LM Studio, documentat în `infra/models/README.md`.

### SP1 — Chat E2E multi-user (≈ 2 zile)
**Livrabil:** 4 useri discută în chat-uri de grup, cu atașamente, relay-ul stochează doar ciphertext.
- `packages/crypto`: device keys, chat keys (epoch), `seal/open`, blob encryption; teste cu vectori cunoscuți.
- `services/relay`: auth prin semnătură, `send/sync/deliver`, blob store; test „niciun plaintext în DB” (se caută 5 cuvinte-santinelă).
- `apps/web`: login (user + PIN), listă chat-uri, mesaje, atașamente, panou relay, chei în IndexedDB. Adresele relay/bridge vin din aceeași origine (căi `/relay`, `/api`), nu din `localhost` scris în cod (pregătire pentru SP1.5).
- `services/bridge`: device management, `chat_members`, distribuirea cheilor, `messages_plain` doar pentru device-uri de agent (încă fără agenți).
- Playwright: 4 contexte, mesaj de la fiecare, verificare în toate; relay DB assert.

### SP1.5 — Acces pentru testeri (≈ 0,5 zile)
**Livrabil:** 3–4 oameni, fiecare pe laptopul lui, intră din browser în aplicația care rulează pe MacBook și discută E2E. De aici încolo, fiecare SP e testabil de grup.
- O singură origine HTTPS prin `tailscale serve` (certificat Tailscale): `/` → build-ul de producție al `apps/web`, `/relay` → relay WS, `/api` și `/events` → bridge. LiveKit (SP6) pe portul lui, cu IP-ul Tailscale al Mac-ului anunțat clienților (`rtc.node_ip`).
- Mac-ul e partajat testerilor prin Tailscale node sharing; ei văd doar acest Mac. Headscale (coordonare self-hosted) doar pentru un demo extern care cere suveranitate totală.
- `make demo`: pornește tot stack-ul și ține Mac-ul treaz (`caffeinate`) cât rulează; `make seed`: conturile testerilor (user + PIN).
- Instalarea Tailscale pe Mac și invitarea testerilor le face omul (amendamentul 9).
- Test: Playwright rulat pe adresa `https://<mac>.<tailnet>.ts.net`, nu pe localhost: login, mesaj trimis și primit, permisiunea de microfon acordată (cere HTTPS).

### SP2 — Runtime de agenți + MCP (≈ 2 zile)
**Livrabil:** un user își creează un agent, îl invită într-un chat, agentul răspunde folosind `chat.read`.
- Tabelele `agents`, `agent_devices`, `approvals` (gol), `agent_lessons`.
- `agent-supervisor` + `HermesRuntime`: create/start/stop profile, template config, port allocation (8701–8709), health.
- `mcp-server` (streamable HTTP) cu token per agent și tool-urile read-only (`chat.read`, `documents.extract`, `image_generate` stub).
- `queue` per chat + `gates` (membru activ, adresare `@agent` sau chat 1:1 cu agentul, rate limit 1 răspuns/3 s).
- `knowledge` (context compact: ultimele 20 mesaje + rezumat rulant).
- UI „My agents”: creare, editare soul, invitare în chat; mesaj de sistem la invitare; `epoch ≥ join_epoch`.
- Test: agentul răspunde corect la o întrebare al cărei răspuns e într-un mesaj anterior din chat (după invitare), și **nu** la unul dinainte de invitare.

### SP3 — Memorie, învățare, citări (≈ 2 zile)
**Livrabil:** agentul învățat cu un PDF răspunde cu citare; recall respectă ACL-ul.
- `services/memory`: EmbeddingGemma 2 (BF16, text-only), chunking, hibrid vector + full-text (`english`/`simple`), RRF, citări, port `MemoryStore`.
- Migrații pgvector: `vector(512)`, HNSW cosine, GIN tsv.
- Ingest asincron al mesajelor (bridge → memory) și al documentelor (extracție locală → chunks).
- `memory.recall`, `memory.remember` în MCP; `applyLesson` în `HermesRuntime` (scrie `SOUL.md`/`skills/lessons.md`, restart soft).
- UI: tab „Teach” (lecții, documente, corecții 👎), „What the agent knows”.
- Teste: 30 de perechi întrebare→chunk în engleză + 10 în fr/de, recall@3 ≥ 0,8 (altfel se activează fallback-ul Qwen3-Embedding); test ACL: agentul B nu primește chunk-uri din namespace-ul agentului A.

### SP4 — Scrieri gated (≈ 1 zi)
**Livrabil:** `chat.send` și `notes.create` trec prin aprobare; agentul continuă după decizie.
- `approvals` flow complet, SSE `approval.*`, cardul în UI, expirare la 10 min (`denied` automat).
- `hermesClient.continue()` cu nota de sistem; test că agentul confirmă trimiterea doar după `approved`.
- Jurnal „Agent actions” per user.

### SP5 — Voce în chat (≈ 1,5 zile)
**Livrabil:** PTT în engleză și încă o limbă (fr/de), răspuns vocal, HUD de latență ≤ 2 s voice-to-voice pe profilul `fast`.
- `services/audio-api`: STT proxy, TTS cu rutare pe limbă, streaming pe propoziții; teste pe wav-uri de fixture (en, de).
- `media-io` în bridge: decriptare blob → STT → F1 → TTS → blob criptat; transcript afișat.
- UI: buton PTT, player, HUD (`latency.sample`).
- Test de latență automat (Playwright + fixture audio): total < 2.000 ms pe `fast`.

### SP6 — Apeluri video + agent de notițe (≈ 3 zile)
**Livrabil:** 3 useri în apel LiveKit, un agent de notițe acceptat de toți, transcript per vorbitor, notițe publicate în chat prin aprobare.
- LiveKit nativ (`infra/livekit.yaml`), `livekit-tokens` în bridge, pagina Call (`@livekit/components-react`), chat `room` legat de meeting.
- Politica camerei, cererea de agent, consimțământ (banner Accept/Refuz), badge „taking notes · X's agent”, cerere de oprire.
- `services/meeting-agent`: worker, VAD per track, segmente → bridge, `summarize` la 5 min și la final prin runtime-ul agentului cu `reasoning: medium`.
- `meeting.transcript` în MCP; notițele în memorie (`kind=meeting`) și `chat.send` gated (D-3).
- Teste: pytest cu 2 track-uri audio sintetice → 2 vorbitori distincți în `meeting_segments`; Playwright: consimțământ de la 3 useri → agentul apare; refuz → nu apare.
- **Risc de resurse:** 3 track-uri STT simultan + LLM pe același Mac. Mitigare: STT doar pe segmente VAD, coadă cu prioritate pentru voce în chat, `large-v3-turbo` q5_0; dacă nu ține, `parakeet-mlx` (Parakeet-TDT-0.6B-v3) pentru meeting.

### SP7 — E2EE pe media + stretch (≈ 2 zile, opțional)
- LiveKit E2EE cu cheie partajată: generată în browserul creatorului, distribuită prin chat-ul `room` E2E; `meeting-agent` primește cheia doar după consimțământ (`rtc.E2EEOptions`). Test: agent fără cheie → zero segmente.
- Dacă D-4 devine „da”: agentul răspunde vocal în apel când e strigat pe nume (pipeline STT→LLM→TTS pe track-ul lui).
- Pe profilul `quality`: imaginile din chat merg direct la Gemma 4 (multimodal).

**Dependențe:** SP1 → SP1.5 → SP2 → SP3 → SP4 → SP5 → SP6 → SP7. SP1 nu depinde de modele, deci poate porni imediat după T1 din SP0. SP5 poate rula în paralel cu SP4 (fișiere disjuncte: `audio-api`/`media-io` vs `approvals`).

---

## 12. Riscuri și fallback-uri

| Risc | Probabilitate | Mitigare / fallback |
|---|---|---|
| Hermes amestecă istoricul între chat-uri | mică | API-ul are `X-Hermes-Session-Id` (amendamentul 8); fallback: bridge-ul trimite tot istoricul compact per cerere (stateless) |
| Hermes rescrie `reasoning_effort`/tool choice pe endpoint custom | medie | pin în `infra/hermes/VERSION`; `extra_body` per provider; test de regresie în smoke |
| Hermes expune terminalul prin API server | mare dacă nu e tratat | toate toolset-urile built-in dezactivate; smoke-ul verifică că nu e expus niciun tool de shell |
| 6 profile Hermes pornite simultan consumă prea multă memorie/CPU | medie | pornire lazy la prima cerere, oprire după 15 min idle; max 3 active |
| `vllm-mlx` instabil cu Gemma 4 sau cu tool parsing | medie (raportat în mlx-lm) | profil `fast` ca default; `tool_call_parser: auto`; LM Studio ca fallback; test de tool call în smoke pe ambele profile |
| Prompt processing lent pe Mac cu schema MCP mare | mare | ≤ 8 tool-uri expuse per agent, system prompt stabil (prefix cache), context compact ≤ 6k tokeni |
| Kokoro/misaki descarcă resurse la prima rulare | medie | `make models` le încălzește; smoke-ul rulează offline și eșuează la orice egress |
| Whisper confundă limbile la fraze scurte | medie | `language` din preferința userului ca bias, auto doar la > 3 s; afișăm limba detectată cu buton de corecție |
| LiveKit UDP blocat de firewall local | mică | `livekit.yaml` cu `use_external_ip: false`, porturi fixe; TCP fallback 7881 |
| Memorie totală > 32 GiB pe `quality` | medie | gardă în `make smoke`; comutare pe `fast` |

---

## 13. Scenariul de demo (scriptul Playwright `e2e/demo.spec.ts` îl rulează identic, în engleză)

1. **Setup:** 4 useri (Ana, Vlad, Rareș, Janosch), chat „Project”. Ana își creează agentul „Nora” (en/fr, voce Kokoro), îl învață cu `contract.pdf` și lecția „answer briefly, cite the source”.
2. **E2E:** Vlad scrie în „Project”; panoul relay arată doar ciphertext.
3. **Agent în chat:** Ana invită „Nora” în „Project”; mesaj de sistem; Rareș întreabă „@Nora what is the delivery deadline in the contract?” → răspuns cu `[contract.pdf · p.3]`.
4. **Gated write:** Ana: „@Nora send Janosch the summary privately” → card de aprobare la Ana → Approve → mesaj la Janosch.
5. **Voce:** Rareș ține PTT și întreabă în engleză; Nora răspunde vocal; HUD arată < 2 s. Repetă în franceză sau germană → răspuns în aceeași limbă.
6. **Apel:** Ana pornește apel din „Project”, intră Vlad și Rareș; Ana cere „Bring Nora to take notes”; toți acceptă; badge pe Nora; discută 2 minute; Ana închide → notițe cu atribuire per vorbitor → card de aprobare → publicate în „Project” → recall ulterior „what did we decide in the call?” funcționează.
7. **Suveranitate:** Vlad își creează agentul „Max” și încearcă `memory.recall` pe ce știe Nora → nimic (test ACL vizibil în jurnal).

---

## 14. Întrebări deschise
Toate au răspuns în `docs/superpowers/specs/decisions.md`.

---

## Anexă A — Surse verificate pentru deciziile cheie
- Hermes Agent profiles (`hermes profile create`, `HERMES_HOME`, `SOUL.md`, `memories/`, gateway per profil): hermes-agent.nousresearch.com/docs/user-guide/profiles.
- Hermes API server (`gateway.api_server.*` / `API_SERVER_*`, `/v1/chat/completions`, `X-Hermes-Session-Id`, tool-urile rulează server-side, inclusiv terminalul): hermes-agent.nousresearch.com/docs/user-guide/features/api-server.
- Hermes config (`agent.disabled_toolsets`, `mcp_servers`): hermes-agent.nousresearch.com/docs/user-guide/configuration și …/features/mcp.
- LiveKit E2EE pentru agenți Python (`rtc.E2EEOptions`, cheie partajată, agent fără cheie nu decriptează): docs.livekit.io/transport/encryption/agents.
- EmbeddingGemma 2: 740M total (270M text), 768-dim cu MRL 512/256/128, 8K context, BF16 sau FP32 (nu FP16), încărcare text-only cu `config_kwargs`, Apache-2.0: huggingface.co/google/embeddinggemma-2.
- vllm-mlx 0.4.1: `--continuous-batching`, `--enable-auto-tool-choice --tool-call-parser <qwen|auto|…>`, `--reasoning-parser qwen3`, `--embedding-model`: github.com/waybarrios/vllm-mlx, vllm-mlx.is-a.dev/guides/tool-calling.
- Couchbase Lite: vector search doar în Enterprise Edition + bibliotecă de extensie; SDK JavaScript oficial doar în browser; fără SDK Python oficial: couchbase.com/products/editions/mobile, docs.couchbase.com/couchbase-lite-javascript.
- Restul cifrelor (VRAM, tok/s, WER) sunt estimări; SP0 le măsoară și le scrie în `infra/models/README.md`.
