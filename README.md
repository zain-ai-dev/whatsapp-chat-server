# TimeZone Dubai — WhatsApp Chat-State Server

Small Node.js + Express service that stores per-chat state in a JSON file
(`chat-states.json`). It powers two n8n workflows:

1. **Lead Greeting** (`lead-greeting.json`) — a Facebook Lead triggers a one-time
   WhatsApp welcome, then seeds chat state so the AI never re-greets.
2. **AI Conversation** (`ai-conversation.json`) — incoming WhatsApp messages are
   batched and answered once by the Gemini agent. The AI permanently stops in a chat
   once the human agent (Shaheer) sends any manual message, or once it has finished
   qualifying the lead.

`n8n-workflow-fixed.json` is kept identical to `ai-conversation.json` (import either).

Base URL (Coolify): `http://b8k404kgks8k4kowss4k0804.31.97.78.118.sslip.io`

---

## API

All `remoteJid` values are **normalized to bare digits** (e.g. `923014601801`),
so `923014601801` and `923014601801@s.whatsapp.net` always map to the same record.

| Method & path | Purpose |
|---|---|
| `GET  /api/health` | Health check |
| `GET  /api/chat/status?remoteJid=…` | Read state (`aiDisabled`, `aiDisabledReason`, `clientActive`, `greetingSent`, `lastCustomerMsgId`, `combinedText`, times…) |
| `POST /api/chat/update` | Upsert fields (`lastClientTime`, `lastCustomerTime`, `lastAITime`, `lastResponder`, `clientActive`, `aiPending`, `greetingSent`) |
| `POST /api/chat/handoff` | Human took over → `aiDisabled=true` (`reason:"client"`), permanent — body `{ remoteJid }` |
| `POST /api/chat/ai-complete` | AI finished qualifying → `aiDisabled=true` (`reason:"completed"`) — body `{ remoteJid }` |
| `POST /api/chat/reset-ai` | Re-enable the AI for a chat (`aiDisabled=false`) — body `{ remoteJid }` |
| `POST /api/chat/mark-sent` | Remember a text WE sent (echo detection) — body `{ remoteJid, text }` |
| `POST /api/chat/check-sent` | Was this text one we sent? → `{ ours: bool }` — body `{ remoteJid, text }` |
| `POST /api/workflow/cancel-ai` | Set `aiPending=false` (legacy) |
| `POST /api/chat/seed-greeting` | Mark greeting as first AI turn + record its text — body `{ remoteJid, greetingText, customerName }` |
| `POST /api/chat/buffer` | Append an inbound msg — body `{ remoteJid, messageText, timestamp, id }` |
| `GET  /api/chat/buffer?remoteJid=…` | Read buffer → `{ messages, count, lastId, lastMessageTime, combinedText }` |
| `POST /api/chat/buffer/clear` | Empty the buffer — body `{ remoteJid }` |
| `POST /api/admin/cleanup` | Trim buffers + delete idle records (keeps `aiDisabled` records) |

Booleans/numbers may be sent as strings (`"true"`, `"123"`); the server coerces them.

### Storage (env-configurable + durability)
- `DATA_DIR` (default = app dir) — folder for `chat-states.json`. Point it at a **Coolify
  persistent volume** (e.g. `/app/data`) so state survives redeploys.
- `BUFFER_MAX` (default **5**) — messages kept per chat.
- `SENT_MAX` (default **5**) — recent sent-message texts kept per chat (for echo detection).
- `RETENTION_DAYS` (default **7**) — records idle longer than this are deleted (records with
  `aiDisabled=true` are never deleted, so a handoff is permanent).
- `CLEANUP_INTERVAL_MS` (default **3600000** = 1h) — built-in cleanup cadence.

Writes are **atomic** (temp file + rename, with a `.bak` fallback) so a crash can't corrupt
the store. Express handlers are synchronous, so reads/writes are serialized — no lost updates.
Cleanup runs automatically; you can also hit `POST /api/admin/cleanup`.

---

## How the AI conversation works

```
Webhook → Extract → If CUSTOMER (fromMe=false)?
  ├ no (fromMe=true → us or Shaheer)
  │     → Wait 5s (let our own mark-sent land)
  │     → check-sent {text} → Is it our echo?
  │          ├ yes → IGNORE (our greeting/AI message coming back)
  │          └ no  → HANDOFF: aiDisabled=true (Shaheer took over, permanent)
  └ yes → Buffer Append (server records lastCustomerMsgId)
          → Wait 15s (batch + takeover window)
          → Get Status → If (lastCustomerMsgId == my id) AND (aiDisabled == false)?
               ├ yes → AI Agent (input = all buffered msgs)
               │        → Code: strip <<QUALIFIED>> token → Send → mark-sent
               │        → Clear Buffer → if qualified: ai-complete (stop AI)
               └ no  → STOP (newer message superseded me, or AI is disabled)
```

**Reliable human detection.** Shaheer and the AI send from the *same* business number
(`fromMe=true`), so `source` can't tell them apart. Instead the server remembers the **text**
of every message we send (greeting + AI replies, via `mark-sent` / `seed-greeting`). An
inbound `fromMe` message whose text we recognise (`check-sent`) is our own echo → ignored;
anything else is Shaheer → permanent `handoff`. The 5s wait covers the echo-vs-mark race.

**Permanent stop.** Once `aiDisabled=true` (Shaheer took over *or* the AI emitted its hidden
`<<QUALIFIED>>` completion token after collecting all four qualifying answers), the gate's
`aiDisabled == false` check fails forever for that chat — the AI never messages again until
`reset-ai`.

- **Batching / no duplicates:** the gate compares against `lastCustomerMsgId`, a persistent
  field **not** cleared with the buffer — so only the truly-latest run proceeds, even after a
  clear. The winner answers every buffered message together.
- **No re-greeting:** the agent reads `greetingSent` and is told not to greet again.
- **Context:** the LangChain `Simple Memory` is keyed by `remoteJid`, so prior turns persist.

> Timing note: AI latency ≈ 15s + generation. Tune the `Wait - 15s` node (lower = snappier
> replies but shorter takeover window).

---

## Deploy (Coolify)

1. Push to GitHub (`main`).
2. In Coolify → the app → **Redeploy**.
3. Verify: open `…/api/health` → `{"status":"healthy",…}`.
4. (Optional) set env vars `BUFFER_MAX`, `RETENTION_DAYS`, `CLEANUP_INTERVAL_MS`.

> Persistence: by default the JSON store resets on redeploy. For durable state, add a
> Coolify **persistent volume** (e.g. mounted at `/app/data`) and set env `DATA_DIR=/app/data`.

## Import the workflows into n8n

1. n8n → **Import from File** → `lead-greeting.json`, then `ai-conversation.json`.
2. Re-select credentials if prompted:
   - Facebook Lead Ads: `Timezone Dubai Facebook Lead Ads account` (`Nh0xA4yKkOaHOJ3c`)
   - Evolution API: `Evolution account` (`nUouiKyAGid2oMmY`), instance `my-whatsapp`
   - Gemini: `Gemini API Key` (`rv8Gx2C0yKGwzKZT`)
3. Point the Evolution webhook (`messages.upsert`) at the AI Conversation webhook URL.
4. Activate both workflows.

## End-to-end test (use a fresh number each run)

1. Create a test lead via the **Facebook Lead Ads Testing Tool** (form "BOS Salman Vol I").
   Greeting arrives **once**; `…/api/chat/status?remoteJid=<number>` → `greetingSent:true`,
   `aiDisabled:false`.
2. **Batching:** send 3 quick messages (`I want a Rolex` · `Submariner` · `in Dubai`).
   Expect **one** English reply, no re-greeting, addressing them together.
3. **Qualification stop:** finish the buyer's 4 answers (watch, budget, UAE, timing). After the
   AI's closing line, status → `aiDisabled:true, aiDisabledReason:"completed"`. Further customer
   messages get no AI reply.
4. **Permanent handoff:** on a fresh chat, while the AI is mid-conversation, send a manual
   message from the **business phone**. Status → `aiDisabled:true, aiDisabledReason:"client"`.
   The AI never replies in that chat again (until `POST /api/chat/reset-ai`).
5. **Echo safety:** confirm the AI's own replies and the greeting do **not** flip `aiDisabled`
   (only a real human message does).

> Note: Shaheer should reply from the **WhatsApp phone app**. Replies are detected by message
> text, not device, so this works regardless — but never-before-sent text is required to be
> treated as a human takeover.

## Local run

```bash
npm install
npm start            # Server running on port 3000
curl http://localhost:3000/api/health
```
