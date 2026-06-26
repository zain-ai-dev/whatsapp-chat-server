# TimeZone Dubai — WhatsApp Chat-State Server

Small Node.js + Express service that stores per-chat state in a JSON file
(`chat-states.json`). It powers two n8n workflows:

1. **Lead Greeting** (`lead-greeting.json`) — a Facebook Lead triggers a one-time
   WhatsApp welcome, then seeds chat state so the AI never re-greets.
2. **AI Conversation** (`ai-conversation.json`) — incoming WhatsApp messages are
   batched, answered once by the Gemini agent, with a client-takeover grace window.

Base URL (Coolify): `http://b8k404kgks8k4kowss4k0804.31.97.78.118.sslip.io`

---

## API

All `remoteJid` values are **normalized to bare digits** (e.g. `923014601801`),
so `923014601801` and `923014601801@s.whatsapp.net` always map to the same record.

| Method & path | Purpose |
|---|---|
| `GET  /api/health` | Health check |
| `GET  /api/chat/status?remoteJid=…` | Read state (`clientActive`, `aiPending`, `greetingSent`, `greetingText`, `customerName`, times) |
| `POST /api/chat/update` | Upsert fields (`lastClientTime`, `lastCustomerTime`, `lastAITime`, `lastResponder`, `clientActive`, `aiPending`, `greetingSent`) |
| `POST /api/workflow/cancel-ai` | Set `aiPending=false` (client took over) |
| `POST /api/chat/seed-greeting` | Mark greeting as the first AI turn — body `{ remoteJid, greetingText, customerName }` |
| `POST /api/chat/buffer` | Append an inbound msg — body `{ remoteJid, messageText, timestamp, id }` |
| `GET  /api/chat/buffer?remoteJid=…` | Read buffer → `{ messages, count, lastId, lastMessageTime, combinedText }` |
| `POST /api/chat/buffer/clear` | Empty the buffer — body `{ remoteJid }` |
| `POST /api/admin/cleanup` | Manually trim buffers + delete idle records |

Booleans/numbers may be sent as strings (`"true"`, `"123"`); the server coerces them.

### Storage limits (env-configurable)
- `BUFFER_MAX` (default **5**) — messages kept per chat.
- `RETENTION_DAYS` (default **7**) — records idle longer than this are deleted.
- `CLEANUP_INTERVAL_MS` (default **3600000** = 1h) — built-in cleanup cadence.

Cleanup runs automatically on that interval; you can also hit `POST /api/admin/cleanup`
from an external cron or an n8n Schedule node.

---

## How the AI conversation works

```
Webhook → Extract → If CUSTOMER?
  ├ no  → If AI or Client
  │        ├ AI     → Log (no forward to customer)
  │        └ CLIENT → Update takeover (clientActive=true) → cancel-ai
  └ yes → Buffer Append (server records lastCustomerMsgId)
          → Wait 30s (single window: batch + client takeover)
          → Get Status → If (lastCustomerMsgId == my id) AND (clientActive == false)?
               ├ yes → AI Agent (input = all buffered msgs) → Send → mark done → Clear Buffer
               └ no  → STOP (a newer message superseded me, or a human took over)
```

One **single 30s wait** serves as both the batching window and the human-takeover grace
period. After it, exactly one run passes the gate:

- **Batching / no duplicates:** the gate compares against `lastCustomerMsgId`, a persistent
  field that is **not** cleared with the buffer — so only the truly-latest message's run
  proceeds (even after a clear). All earlier runs stop. The winner answers every buffered
  message together. This removes the earlier cascade where every message generated a reply
  and all-but-one were cancelled.
- **No re-greeting:** the agent reads `greetingSent` and is told not to greet again.
- **Context:** the LangChain `Simple Memory` is keyed by `remoteJid`, so prior turns persist.
- **Client takeover:** if a human replies from the business phone during the 30s, the gate's
  `clientActive == false` check fails and the AI does not send.

> Timing note: AI latency ≈ 30s + generation. Lower the single `Wait` node for faster
> replies (shorter human-takeover window) or raise it for a longer takeover window.

---

## Deploy (Coolify)

1. Push to GitHub (`main`).
2. In Coolify → the app → **Redeploy**.
3. Verify: open `…/api/health` → `{"status":"healthy",…}`.
4. (Optional) set env vars `BUFFER_MAX`, `RETENTION_DAYS`, `CLEANUP_INTERVAL_MS`.

> Persistence: the JSON store lives in the container filesystem and resets on redeploy.
> For durable state, add a Coolify persistent volume and point storage there.

## Import the workflows into n8n

1. n8n → **Import from File** → `lead-greeting.json`, then `ai-conversation.json`.
2. Re-select credentials if prompted:
   - Facebook Lead Ads: `Timezone Dubai Facebook Lead Ads account` (`Nh0xA4yKkOaHOJ3c`)
   - Evolution API: `Evolution account` (`nUouiKyAGid2oMmY`), instance `my-whatsapp`
   - Gemini: `Gemini API Key` (`rv8Gx2C0yKGwzKZT`)
3. Point the Evolution webhook (`messages.upsert`) at the AI Conversation webhook URL.
4. Activate both workflows.

## End-to-end test

1. Create a test lead via the **Facebook Lead Ads Testing Tool** (form "BOS Salman Vol I").
2. The greeting arrives **once**; check `…/api/chat/status?remoteJid=<number>` → `greetingSent: true`.
3. From the lead's number send 3 quick messages:
   `I am looking rolex` · `Do you have?` · `What is the price range?`
4. Expect **one** reply that does NOT greet again and addresses Rolex / availability /
   price together (deferring the actual price to a private viewing, per the rules).
5. Reply from the business phone within 30s → the AI's pending reply is cancelled.

## Local run

```bash
npm install
npm start            # Server running on port 3000
curl http://localhost:3000/api/health
```
