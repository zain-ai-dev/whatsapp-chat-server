const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const storageFile = path.join(__dirname, 'chat-states.json');

// Keep storage small so the JSON file never bloats and slows the server down.
const BUFFER_MAX = Number(process.env.BUFFER_MAX) || 5;          // messages kept per chat
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 7;  // delete records idle longer than this
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 60 * 60 * 1000; // run hourly

if (!fs.existsSync(storageFile)) {
  fs.writeFileSync(storageFile, JSON.stringify({}, null, 2));
}

// --- Helpers ------------------------------------------------------------

// Normalize any WhatsApp id to bare digits so the greeting workflow
// (sends to "923014601801") and the inbound webhook
// ("923014601801@s.whatsapp.net") always resolve to the SAME record.
// Strips @s.whatsapp.net / @c.us / @g.us suffixes and any non-digit char.
function normalizeJid(jid) {
  if (jid === undefined || jid === null) return '';
  return String(jid).replace(/@.*$/, '').replace(/\D/g, '');
}

// n8n sends booleans/numbers as strings ("true"/"false"/"123")
function toBool(v) {
  return v === true || v === 'true';
}

function loadChatStates() {
  try {
    return JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveChatStates(states) {
  try {
    fs.writeFileSync(storageFile, JSON.stringify(states, null, 2));
  } catch (err) {
    console.error('Error saving:', err);
  }
}

// Default schema for a chat record. Kept as a function so each record
// gets its own buffer array (no shared reference).
function defaultState(key) {
  return {
    remoteJid: key,
    lastCustomerTime: 0,
    lastClientTime: 0,
    lastAITime: 0,
    lastResponder: null,
    clientActive: false,
    aiPending: false,
    greetingSent: false,
    greetingText: null,
    customerName: null,
    lastCustomerMsgId: null,
    buffer: []
  };
}

// Reads a record (creating it if missing) and back-fills any fields that
// older records on disk don't have yet — keeps everything backward compatible.
function getChatState(remoteJid) {
  const key = normalizeJid(remoteJid);
  const states = loadChatStates();
  if (!states[key]) {
    states[key] = defaultState(key);
    saveChatStates(states);
  } else {
    const defaults = defaultState(key);
    let changed = false;
    for (const field of Object.keys(defaults)) {
      if (states[key][field] === undefined) {
        states[key][field] = defaults[field];
        changed = true;
      }
    }
    if (changed) saveChatStates(states);
  }
  return { key, states, chatState: states[key] };
}

// --- Routes -------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

app.get('/api/chat/status', (req, res) => {
  const { remoteJid } = req.query;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { key, chatState } = getChatState(remoteJid);
  const now = Date.now();
  const secondsSinceClient = Math.floor((now - chatState.lastClientTime) / 1000);
  const clientActive = secondsSinceClient < 60 && chatState.lastClientTime > 0;
  const buffer = chatState.buffer || [];
  res.json({
    remoteJid: key,
    lastClientTime: chatState.lastClientTime,
    lastCustomerTime: chatState.lastCustomerTime,
    lastAITime: chatState.lastAITime,
    secondsSinceClient: secondsSinceClient,
    clientActive: clientActive,
    aiPending: chatState.aiPending === true,
    greetingSent: chatState.greetingSent === true,
    greetingText: chatState.greetingText,
    customerName: chatState.customerName,
    lastResponder: chatState.lastResponder,
    // Persistent id of the most recent customer message (NOT cleared with the
    // buffer). The conversation workflow uses this to let only the latest run
    // proceed after the debounce — prevents duplicate / cancelled AI replies.
    lastCustomerMsgId: chatState.lastCustomerMsgId,
    bufferCount: buffer.length,
    combinedText: buffer.map((m) => m.messageText).filter(Boolean).join('\n')
  });
});

app.post('/api/chat/update', (req, res) => {
  const { remoteJid, lastClientTime, lastCustomerTime, lastAITime, lastResponder, clientActive, aiPending, greetingSent } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { states, chatState } = getChatState(remoteJid);
  if (lastClientTime !== undefined) chatState.lastClientTime = Number(lastClientTime) || 0;
  if (lastCustomerTime !== undefined) chatState.lastCustomerTime = Number(lastCustomerTime) || 0;
  if (lastAITime !== undefined) chatState.lastAITime = Number(lastAITime) || 0;
  if (lastResponder !== undefined) chatState.lastResponder = lastResponder;
  if (clientActive !== undefined) chatState.clientActive = toBool(clientActive);
  if (aiPending !== undefined) chatState.aiPending = toBool(aiPending);
  if (greetingSent !== undefined) chatState.greetingSent = toBool(greetingSent);
  saveChatStates(states);
  res.json({ success: true, updated: chatState });
});

app.post('/api/workflow/cancel-ai', (req, res) => {
  const { remoteJid } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { states, chatState } = getChatState(remoteJid);
  chatState.aiPending = false;
  saveChatStates(states);
  res.json({ success: true, cancelled: true });
});

// Seed the lead greeting as the first AI turn so the conversation workflow
// knows a welcome was already sent and the agent won't greet again.
app.post('/api/chat/seed-greeting', (req, res) => {
  const { remoteJid, greetingText, customerName } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { states, chatState } = getChatState(remoteJid);
  chatState.greetingSent = true;
  chatState.lastResponder = 'ai';
  chatState.aiPending = false;
  chatState.lastAITime = Date.now();
  if (greetingText !== undefined) chatState.greetingText = greetingText;
  if (customerName !== undefined) chatState.customerName = customerName;
  saveChatStates(states);
  res.json({ success: true, seeded: true, state: chatState });
});

// --- Message buffer (debounce / batching) -------------------------------
// Lets the AI workflow append rapid inbound messages, wait a few seconds,
// then read them all and answer together instead of once per message.

app.post('/api/chat/buffer', (req, res) => {
  const { remoteJid, messageText, timestamp, id } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { states, chatState } = getChatState(remoteJid);
  const entry = {
    id: id !== undefined && id !== null ? String(id) : `${timestamp || Date.now()}-${chatState.buffer.length}`,
    messageText: messageText || '',
    timestamp: Number(timestamp) || Date.now()
  };
  chatState.buffer.push(entry);
  // Persistent marker of the latest customer message — survives buffer clears.
  chatState.lastCustomerMsgId = entry.id;
  chatState.lastCustomerTime = entry.timestamp;
  // Keep only the most recent BUFFER_MAX messages so the file stays small.
  if (chatState.buffer.length > BUFFER_MAX) {
    chatState.buffer = chatState.buffer.slice(-BUFFER_MAX);
  }
  saveChatStates(states);
  const last = chatState.buffer[chatState.buffer.length - 1];
  res.json({
    success: true,
    count: chatState.buffer.length,
    lastId: last.id,
    messages: chatState.buffer
  });
});

app.get('/api/chat/buffer', (req, res) => {
  const { remoteJid } = req.query;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { chatState } = getChatState(remoteJid);
  const buffer = chatState.buffer || [];
  const last = buffer.length ? buffer[buffer.length - 1] : null;
  res.json({
    count: buffer.length,
    lastId: last ? last.id : null,
    lastMessageTime: last ? last.timestamp : 0,
    // Convenience: all buffered texts joined for direct use as agent input.
    combinedText: buffer.map((m) => m.messageText).filter(Boolean).join('\n'),
    messages: buffer
  });
});

app.post('/api/chat/buffer/clear', (req, res) => {
  const { remoteJid } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const { states, chatState } = getChatState(remoteJid);
  chatState.buffer = [];
  saveChatStates(states);
  res.json({ success: true, cleared: true });
});

// --- Storage cleanup ----------------------------------------------------
// Trims every chat buffer to BUFFER_MAX and deletes records that have been
// idle (no customer/client/AI activity) for longer than RETENTION_DAYS.
// Returns a small summary so it can also be triggered manually.
function cleanupStates() {
  const states = loadChatStates();
  const now = Date.now();
  const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let trimmed = 0;
  let removed = 0;
  for (const key of Object.keys(states)) {
    const s = states[key];
    if (Array.isArray(s.buffer) && s.buffer.length > BUFFER_MAX) {
      s.buffer = s.buffer.slice(-BUFFER_MAX);
      trimmed++;
    }
    const lastActivity = Math.max(s.lastCustomerTime || 0, s.lastClientTime || 0, s.lastAITime || 0);
    if (lastActivity > 0 && now - lastActivity > maxAge) {
      delete states[key];
      removed++;
    }
  }
  saveChatStates(states);
  return { chats: Object.keys(states).length, trimmed, removed };
}

// Manual trigger (hit from an external cron / n8n Schedule node if preferred).
app.post('/api/admin/cleanup', (req, res) => {
  res.json({ success: true, result: cleanupStates() });
});

// Built-in periodic cleanup so no external scheduler is strictly required.
setInterval(() => {
  const result = cleanupStates();
  console.log('Cleanup run:', JSON.stringify(result));
}, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
