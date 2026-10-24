# Decizii — Sovereign Agents Demo

Data: 2026-10-24. Răspunsurile la §2 și §14 din
[design spec](2026-10-24-sovereign-agents-demo-design.md). Amendamentele din spec decurg de aici.

| # | Întrebare | Decizie |
|---|---|---|
| D-1 | Profil LLM implicit | Ambele profile rulează **local, pe Mac**; diferă doar mărimea modelului. `fast` (Qwen3.5-9B, ~10 GB) cât agenții de cod pornesc și testează aplicația; `quality` (Gemma 4 26B-A4B, ~14,5 GB, multimodal) pentru demo. Comutare: `make up PROFILE=quality` sau `LLM_PROFILE` în `.env`. Dacă tool calling-ul pe Gemma 4 nu trece smoke-ul, demo-ul rulează pe `fast`. **Actualizare 2026-10-24:** `fast` rulează Qwen3.5 9B pe **4 biți** (benchmark ops 9/9 față de 6/9 pe 8 biți, 54 față de 34 token/s, −2,6 GiB), cu prefix cache-ul vllm-mlx oprit (făcea modelul să sară peste tool-uri). |
| D-2 | Vocea / limba | **Engleza e limba principală** (UI, demo, voci). Kokoro pentru en/fr/es/it, Piper pentru de/ro. XTTS-ro iese din scop. |
| D-3 | Vizibilitatea notițelor din apel | Private la owner-ul agentului; ajung în chat doar după „Approve” (gated, ca `chat.send`). |
| D-4 | Agenți care vorbesc în apel | Nu acum. Se decide la SP7 (stretch). |
| D-5 | SDK-ul de mesagerie al clientului + sandbox | Nu avem acces (A-1). Relay-ul propriu simulează serverul și rămâne înlocuibil. |
| D-6 | Vector DB / memory layer (Couchbase Lite?) | Rămâne **PostgreSQL + pgvector** pentru demo, în spatele unui port `MemoryStore`. Detalii mai jos. |
| D-7 | Locația codului | Repo nou `sovereign-agents`, separat de edge-ai; remote `github.com/cube-digital/souverign-ai`. |
| D-8 | Cum testăm cu 3–4 oameni | **MacBook-ul e serverul**, testerii folosesc doar browserul și intră prin **Tailscale** (node sharing, HTTPS prin `tailscale serve`). Nu fiecare pe laptopul lui: modelele cer un M4 Max cu 36 GB, iar 4 instanțe separate nu s-ar vedea între ele. Fără cloud: un VPS n-are GPU pentru modele, iar Cloudflare Tunnel nu duce UDP pentru apeluri și decriptează TLS-ul. Comunicarea dintre testeri se face chiar prin aplicație; Slack/WhatsApp rămân rezervă pentru coordonare și bug-uri. Sub-proiect nou SP1.5. |
| D-9 | Cum își are fiecare spațiul lui de memorie și cum împarte | Fiecare agent are un spațiu privat (`agent:<id>`); fiecare chat are spațiul lui (`chat:<id>`). **Agenții împart informația doar în chat-ul pe care îl au în comun, altfel nu.** Într-un chat, un agent folosește doar memoria acelui chat și ce știe el, nu ce a aflat în alte chat-uri. Proprietarul aduce agentul în chat; asta e acordul (setarea `share_private_in_chats`, implicit `always`, opțional `ask`/`never`). Agenții aceluiași om nu își împart memoria. Detalii mai jos. |

## D-6 pe larg: de ce nu Couchbase Lite acum

Couchbase Lite e o bază de date embedded pentru device (iOS, Android, desktop, browser), cu sync
prin Sync Gateway. Pentru demo nu se potrivește:

- **Vector search e doar în Enterprise Edition**, cu o bibliotecă de extensie separată.
- **Nu are SDK pentru serverul nostru.** SDK-ul JavaScript e oficial doar în browser (Node, Deno și
  Bun nu sunt suportate), iar pentru Python nu există SDK oficial. Serviciul `memory` e Python pe
  Mac.
- **Ce ne trebuie e într-un singur SQL în pgvector:** hibridul vector + full-text (RRF), plus ACL-ul
  pe `namespace` și pe chat-urile în care agentul e membru.

Unde are sens: memoria **on-device** din aplicația mobilă a clientului (SDK-ul edge-ai), unde contează
E2E + sync + offline. Ca să rămână drumul deschis, serviciul `memory` scrie printr-un port
`MemoryStore`; un backend Couchbase Lite se poate adăuga fără să schimbe API-ul.

**Memory layers gata făcute** (mem0, Zep, Letta) cheamă LLM-ul la fiecare scriere, ceea ce adaugă
latență pe un singur Mac, și nu dau citări + ACL per chat cum cere spec-ul. Memoria proprie a
Hermes rămâne dezactivată din același motiv. Agentul are o singură memorie, cea citată și cu ACL.

## D-9 pe larg: spațiile de memorie și împărtășirea

Regula, în cuvintele tale: **agenții pot împărți informația în același chat, altfel nu.**

### Spațiile

| Spațiu | Ce conține | Cine îl citește |
|---|---|---|
| `agent:<id>` (privat) | documentele învățate, lecțiile, corecțiile, transcriptul și notițele din apelurile la care a participat (nepublicate), ce își notează singur (`memory.remember`). Fiecare chunk are `origin_chat_id`: chat-ul în care a aflat lucrul respectiv, sau gol pentru ce l-a învățat proprietarul direct | doar agentul respectiv, după regulile de mai jos; proprietarul îl vede în UI („What the agent knows”) și poate șterge din el |
| `chat:<id>` (comun) | doar mesajele chat-ului, inclusiv ce au postat agenții și notițele publicate | oamenii membri văd oricum mesajele; un agent îl citește doar cât e membru activ și doar mesajele de după momentul invitației (`source.ts ≥ joined_at`) |

Mesajele unui chat se ingerează o singură dată, în `chat:<id>`, nu în spațiul fiecărui agent.

### Ce primește un agent la `memory.recall`

Lista o calculează bridge-ul la fiecare cerere, din chat-ul în care lucrează agentul și din
`chat_members`; agentul nu o poate alege.

| Unde lucrează agentul | Primește | Nu primește niciodată |
|---|---|---|
| În chat-ul X (comun) | `chat:X` de la intrarea lui; din `agent:<self>`: ce a aflat în X (`origin_chat_id = X`) și ce l-a învățat proprietarul (`origin_chat_id` gol), după `share_private_in_chats` | spațiul altui agent; spațiile altor chat-uri; ce a aflat el însuși în alte chat-uri |
| În chat-ul 1:1 cu proprietarul | tot `agent:<self>` + `chat:<c>` pentru chat-urile în care sunt membri activi și el, și proprietarul | spațiul altui agent |

### Clarificarea 1: „chat-urile permise” la recall

Formularea veche („namespace-ul propriu + chat-urile permise”) lăsa două scurgeri: Max, intrat mai
târziu în „Project”, ar fi putut citi mesaje de dinainte de invitația lui, iar un agent ar fi putut
duce în chat-ul B ce a aflat în chat-ul A. Decizie: recall-ul e limitat la chat-ul curent (tabelul de
mai sus), iar din `chat:<id>` agentul primește doar mesajele de după intrarea lui.

### Clarificarea 2: cunoștințele proprietarului într-un chat comun

Setare per agent, `share_private_in_chats`, care privește doar ce l-a învățat proprietarul direct
(`origin_chat_id` gol):

- `always` (implicit): agentul le poate folosi și cita în chat-urile în care l-a adus proprietarul.
  Invitația în chat e acordul.
- `ask`: dacă agentul a primit asemenea chunk-uri în tura curentă, bridge-ul ține răspunsul și îi
  arată proprietarului un card („Nora wants to cite contract.pdf in Project”). Approve → mesajul
  pleacă. Deny → agentul primește o notă și răspunde fără sursa privată.
- `never`: în chat-urile comune, recall-ul nu întoarce nimic din ce l-a învățat proprietarul.

Poarta `ask` se declanșează pe **acces** (bridge-ul vede ce a întors `memory.recall` prin MCP), nu pe
detectarea citării în text. E deterministă și nu depinde de judecata unui model. Lecțiile țin de
comportament (stau în `SOUL.md`), nu de fapte, deci nu sunt filtrate.

### Clarificarea 3: agenții aceluiași om

Nu își împart memoria. Ana poate învăța același document mai multor agenți ai ei; fiecare primește
propriile chunk-uri în spațiul lui. Dacă doi agenți ai Anei sunt în același chat, împart ca oricare
alți doi agenți: prin chat.

### Limita, spusă cinstit

În demo toți agenții rulează pe același MacBook. Separarea dintre oameni e impusă de bridge
(verificări de acces, profile Hermes și spații separate), nu de criptografie: cine administrează
Mac-ul poate vedea tot. Relay-ul și LiveKit rămân partea neîncrezătoare și văd doar ciphertext. În
producție, fiecare organizație sau om își rulează agenții pe cutia sau device-ul lui; atunci separarea
e și fizică.

### Unde se implementează

- SP3: spațiile `agent:` / `chat:`, `origin_chat_id`, ingest-ul o singură dată per mesaj, filtrul
  `joined_at`, recall-ul limitat la chat-ul curent, testele ACL.
- SP4: `share_private_in_chats` în UI și poarta `ask` (folosește aprobările).
- Teste: (a) Max nu primește chunk-uri din `agent:nora`, nici în „Project”; (b) Max, invitat după
  mesajul M, nu primește M; (c) Max, membru în „Project” și în „Ops”, nu primește în „Ops” nimic din
  `chat:project` și nici notițele lui cu `origin_chat_id = project`; (d) al doilea agent al Anei nu
  citește `agent:nora`; (e) cu `ask`, un răspuns în „Project” după un recall din cunoștințele Anei
  creează o aprobare și nu pleacă înainte de Approve; (f) cu `never`, recall-ul din „Project” nu
  întoarce nimic cu `origin_chat_id` gol.
