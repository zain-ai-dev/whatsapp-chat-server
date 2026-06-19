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

if (!fs.existsSync(storageFile)) {
  fs.writeFileSync(storageFile, JSON.stringify({}, null, 2));
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

function getChatState(remoteJid) {
  const states = loadChatStates();
  if (!states[remoteJid]) {
    states[remoteJid] = {
      remoteJid: remoteJid,
      lastCustomerTime: 0,
      lastClientTime: 0,
      lastAITime: 0,
      lastResponder: null,
      clientActive: false,
      aiPending: false
    };
    saveChatStates(states);
  }
  return states[remoteJid];
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

app.get('/api/chat/status', (req, res) => {
  const { remoteJid } = req.query;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const chatState = getChatState(remoteJid);
  const now = Date.now();
  const secondsSinceClient = Math.floor((now - chatState.lastClientTime) / 1000);
  const clientActive = secondsSinceClient < 60 && chatState.lastClientTime > 0;
  res.json({
    remoteJid: remoteJid,
    lastClientTime: chatState.lastClientTime,
    secondsSinceClient: secondsSinceClient,
    clientActive: clientActive,
    lastResponder: chatState.lastResponder
  });
});

app.post('/api/chat/update', (req, res) => {
  const { remoteJid, lastClientTime, lastAITime, lastResponder, clientActive, aiPending } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const states = loadChatStates();
  const chatState = getChatState(remoteJid);
  if (lastClientTime !== undefined) chatState.lastClientTime = lastClientTime;
  if (lastAITime !== undefined) chatState.lastAITime = lastAITime;
  if (lastResponder !== undefined) chatState.lastResponder = lastResponder;
  if (clientActive !== undefined) chatState.clientActive = clientActive;
  if (aiPending !== undefined) chatState.aiPending = aiPending;
  states[remoteJid] = chatState;
  saveChatStates(states);
  res.json({ success: true, updated: chatState });
});

app.post('/api/workflow/cancel-ai', (req, res) => {
  const { remoteJid } = req.body;
  if (!remoteJid) {
    return res.status(400).json({ error: 'remoteJid required' });
  }
  const states = loadChatStates();
  const chatState = getChatState(remoteJid);
  chatState.aiPending = false;
  states[remoteJid] = chatState;
  saveChatStates(states);
  res.json({ success: true, cancelled: true });
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
