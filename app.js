require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const conversationManager = require('./src/conversation-manager');
const whatsappApi = require('./src/whatsapp-api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dashboard WhatsApp AI → rota principal
app.use(express.static(path.join(__dirname, 'dashboard')));

// Carrossel Builder — assets (js, css) servidos da raiz sem expor index
app.use(express.static(__dirname, { index: false }));

// Rota explícita para o Carrossel Builder
app.get('/carrossel', (req, res) => {
  res.sendFile(path.join(__dirname, 'carrossel.html'));
});

// ─── WebSocket: broadcast para todos os operadores ──────────────────────────
const operators = new Set();

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  operators.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

conversationManager.setBroadcast(broadcast);

// Seed de demonstração (ativa com DEMO=true no .env)
if (process.env.DEMO === 'true') {
  conversationManager.seedDemo();
}

wss.on('connection', (ws) => {
  operators.add(ws);
  // Envia estado atual das conversas ao conectar
  ws.send(JSON.stringify({ event: 'init', data: conversationManager.getAllConversations() }));

  ws.on('message', async (raw) => {
    try {
      const { action, phone, text, operatorId } = JSON.parse(raw);

      if (action === 'takeover') {
        conversationManager.humanTakeover(phone, operatorId || 'operador');
        broadcast('update', conversationManager.getAllConversations());
      }

      if (action === 'release') {
        conversationManager.humanRelease(phone);
        broadcast('update', conversationManager.getAllConversations());
      }

      if (action === 'send') {
        await whatsappApi.sendText(phone, text);
        conversationManager.addOperatorMessage(phone, text);
        broadcast('update', conversationManager.getAllConversations());
      }
    } catch (err) {
      console.error('[WS] Erro:', err.message);
    }
  });

  ws.on('close', () => operators.delete(ws));
});

// ─── WhatsApp Webhook: verificação ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── WhatsApp Webhook: mensagens recebidas ───────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente para o WhatsApp não reenviar

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const from = message.from; // número do cliente
    const msgType = message.type;

    let content = null;

    if (msgType === 'text') {
      content = { type: 'text', text: message.text.body };
    } else if (msgType === 'image') {
      content = { type: 'image', mediaId: message.image.id, caption: message.image.caption || '' };
    } else if (msgType === 'audio') {
      content = { type: 'audio', mediaId: message.audio.id, voice: message.audio.voice || false };
    } else if (msgType === 'document') {
      content = { type: 'document', mediaId: message.document.id, filename: message.document.filename };
    } else {
      console.log(`[Webhook] Tipo não suportado: ${msgType}`);
      return;
    }

    const contactName = value.contacts?.[0]?.profile?.name || from;

    await conversationManager.handleIncoming(from, contactName, content);

  } catch (err) {
    console.error('[Webhook] Erro ao processar mensagem:', err);
  }
});

// ─── API REST para o dashboard ───────────────────────────────────────────────
app.get('/api/conversations', (req, res) => {
  res.json(conversationManager.getAllConversations());
});

// Envio manual de imagem pelo operador
app.post('/api/send-image', upload.single('image'), async (req, res) => {
  try {
    const { phone, caption } = req.body;
    if (!req.file || !phone) return res.status(400).json({ error: 'phone e imagem obrigatórios' });

    const mediaId = await whatsappApi.uploadMedia(req.file.buffer, req.file.mimetype);
    await whatsappApi.sendImage(phone, mediaId, caption || '');
    conversationManager.addOperatorMessage(phone, `[Imagem enviada: ${req.file.originalname}]`);
    broadcast('update', conversationManager.getAllConversations());
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] Erro ao enviar imagem:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Envio manual de áudio pelo operador (aparece como PTT/mensagem de voz)
app.post('/api/send-audio', upload.single('audio'), async (req, res) => {
  try {
    const { phone } = req.body;
    if (!req.file || !phone) return res.status(400).json({ error: 'phone e áudio obrigatórios' });

    await whatsappApi.sendAudio(phone, req.file.buffer, req.file.mimetype);
    conversationManager.addOperatorMessage(phone, '[Áudio de voz enviado]');
    broadcast('update', conversationManager.getAllConversations());
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] Erro ao enviar áudio:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar script de vendas em tempo real
app.post('/api/script', (req, res) => {
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'script obrigatório' });
  conversationManager.updateSalesScript(script);
  res.json({ ok: true });
});

// Retorna o script atual
app.get('/api/script', (req, res) => {
  res.json({ script: conversationManager.getSalesScript() });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   WhatsApp AI Assistant — Foculab        ║
╠══════════════════════════════════════════╣
║  Servidor: http://localhost:${PORT}          ║
║  Dashboard: http://localhost:${PORT}/        ║
║  Webhook:   http://localhost:${PORT}/webhook ║
╚══════════════════════════════════════════╝
  `);
});
