/**
 * WhatsApp Web Client (unofficial) via whatsapp-web.js
 *
 * Conecta via QR Code — sem necessidade de aprovação do Meta.
 * Ativa com: WHATSAPP_MODE=web no .env
 *
 * ATENÇÃO: uso não oficial, risco baixo mas existente de ban.
 * Recomendado para testes — para produção use um número dedicado.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { execSync } = require('child_process');

function findChromiumPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const name of candidates) {
    try {
      const p = execSync(`which ${name} 2>/dev/null`).toString().trim();
      if (p) { console.log(`[WhatsApp Web] Chromium encontrado: ${p}`); return p; }
    } catch {}
  }
  console.warn('[WhatsApp Web] Chromium não encontrado no PATH — puppeteer usará bundled');
  return undefined;
}

let client = null;
let qrDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'qr' | 'connected'
let onMessageCallback = null;

function init(onMessage) {
  onMessageCallback = onMessage;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      ...(findChromiumPath() ? { executablePath: findChromiumPath() } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', async (qr) => {
    connectionStatus = 'qr';
    console.log('\n[WhatsApp Web] QR Code gerado — escaneie no celular!\n');

    // QR no terminal
    try {
      require('qrcode-terminal').generate(qr, { small: true });
    } catch {}

    // QR como data URL (para o dashboard)
    try {
      qrDataUrl = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error('[WhatsApp Web] Erro ao gerar QR data URL:', err.message);
    }
  });

  client.on('ready', () => {
    connectionStatus = 'connected';
    qrDataUrl = null;
    console.log('[WhatsApp Web] ✅ Conectado com sucesso!');
  });

  client.on('authenticated', () => {
    console.log('[WhatsApp Web] Autenticado — sessão salva localmente.');
  });

  client.on('auth_failure', (msg) => {
    connectionStatus = 'disconnected';
    console.error('[WhatsApp Web] Falha na autenticação:', msg);
  });

  client.on('disconnected', (reason) => {
    connectionStatus = 'disconnected';
    qrDataUrl = null;
    console.warn('[WhatsApp Web] Desconectado:', reason);
    // Tenta reconectar após 10s
    setTimeout(() => {
      console.log('[WhatsApp Web] Tentando reconectar...');
      client.initialize();
    }, 10000);
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;
    if (!onMessageCallback) return;

    // Ignora grupos por enquanto
    if (message.from.endsWith('@g.us')) return;

    const from = message.from.replace('@c.us', '');
    const contactName = message._data?.notifyName || from;

    let content = null;

    try {
      if (message.type === 'chat') {
        content = { type: 'text', text: message.body };

      } else if (message.type === 'image') {
        const media = await message.downloadMedia();
        content = {
          type: 'image',
          buffer: Buffer.from(media.data, 'base64'),
          mimeType: media.mimetype,
          caption: message.body || '',
        };

      } else if (message.type === 'ptt' || message.type === 'audio') {
        const media = await message.downloadMedia();
        content = {
          type: 'audio',
          buffer: Buffer.from(media.data, 'base64'),
          mimeType: media.mimetype,
          voice: message.type === 'ptt',
        };

      } else if (message.type === 'document') {
        const media = await message.downloadMedia();
        content = {
          type: 'document',
          buffer: Buffer.from(media.data, 'base64'),
          mimeType: media.mimetype,
          filename: media.filename || 'documento',
        };

      } else {
        console.log(`[WhatsApp Web] Tipo não suportado: ${message.type}`);
        return;
      }

      await onMessageCallback(from, contactName, content);

    } catch (err) {
      console.error('[WhatsApp Web] Erro ao processar mensagem:', err.message);
    }
  });

  console.log('[WhatsApp Web] Inicializando...');
  client.initialize();
}

// ─── Enviar texto ─────────────────────────────────────────────────────────────
async function sendText(to, text) {
  if (connectionStatus !== 'connected') throw new Error('WhatsApp Web não conectado');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  await client.sendMessage(chatId, text);
}

// ─── Enviar imagem ────────────────────────────────────────────────────────────
async function sendImage(to, buffer, mimeType, caption = '') {
  if (connectionStatus !== 'connected') throw new Error('WhatsApp Web não conectado');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  const media = new MessageMedia(mimeType, buffer.toString('base64'), 'image');
  await client.sendMessage(chatId, media, { caption });
}

// ─── Enviar áudio como PTT ────────────────────────────────────────────────────
async function sendAudio(to, buffer, mimeType = 'audio/ogg') {
  if (connectionStatus !== 'connected') throw new Error('WhatsApp Web não conectado');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  const media = new MessageMedia('audio/ogg; codecs=opus', buffer.toString('base64'), 'voice.ogg');
  await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
}

// ─── Getters de estado ────────────────────────────────────────────────────────
function getQR() { return qrDataUrl; }
function getStatus() { return connectionStatus; }
function isConnected() { return connectionStatus === 'connected'; }

module.exports = { init, sendText, sendImage, sendAudio, getQR, getStatus, isConnected };
