/**
 * WhatsApp Adapter — troca entre Cloud API (Meta) e Web (whatsapp-web.js)
 *
 * Configuração via .env:
 *   WHATSAPP_MODE=cloud  → usa Meta Cloud API (padrão)
 *   WHATSAPP_MODE=web    → usa whatsapp-web.js via QR Code
 */

const MODE = process.env.WHATSAPP_MODE || 'cloud';

const cloudApi = require('./whatsapp-api');
let webClient = null;

if (MODE === 'web') {
  webClient = require('./whatsapp-web-client');
}

// ─── sendText ─────────────────────────────────────────────────────────────────
async function sendText(to, text) {
  if (MODE === 'web') return webClient.sendText(to, text);
  return cloudApi.sendText(to, text);
}

// ─── sendImage ────────────────────────────────────────────────────────────────
// Cloud API: sendImage(to, mediaId, caption)
// Web:       sendImage(to, buffer, mimeType, caption)
async function sendImage(to, bufferOrMediaId, mimeTypeOrCaption = '', caption = '') {
  if (MODE === 'web') {
    return webClient.sendImage(to, bufferOrMediaId, mimeTypeOrCaption, caption);
  }
  return cloudApi.sendImage(to, bufferOrMediaId, mimeTypeOrCaption);
}

// ─── sendAudio ────────────────────────────────────────────────────────────────
async function sendAudio(to, buffer, mimeType) {
  if (MODE === 'web') return webClient.sendAudio(to, buffer, mimeType);
  return cloudApi.sendAudio(to, buffer, mimeType);
}

// ─── uploadMedia (só Cloud API) ───────────────────────────────────────────────
async function uploadMedia(buffer, mimeType) {
  if (MODE === 'web') {
    // No Web mode, não precisa fazer upload separado — retorna o buffer direto
    return { buffer, mimeType };
  }
  return cloudApi.uploadMedia(buffer, mimeType);
}

// ─── downloadMedia ────────────────────────────────────────────────────────────
async function downloadMedia(mediaId) {
  if (MODE === 'web') {
    // No Web mode, a mídia já vem como buffer no evento de mensagem
    throw new Error('downloadMedia não necessário no modo Web — mídia já vem no evento');
  }
  return cloudApi.downloadMedia(mediaId);
}

// ─── markRead ─────────────────────────────────────────────────────────────────
async function markRead(messageId) {
  if (MODE === 'web') return; // whatsapp-web.js marca automaticamente
  return cloudApi.markRead(messageId);
}

// ─── initWebClient (chamado no app.js) ───────────────────────────────────────
function initWebClient(onMessage) {
  if (MODE !== 'web') return;
  webClient.init(onMessage);
}

function getQR() {
  if (MODE !== 'web' || !webClient) return null;
  return webClient.getQR();
}

function getWebStatus() {
  if (MODE !== 'web' || !webClient) return MODE === 'cloud' ? 'cloud' : 'disconnected';
  return webClient.getStatus();
}

module.exports = {
  sendText,
  sendImage,
  sendAudio,
  uploadMedia,
  downloadMedia,
  markRead,
  initWebClient,
  getQR,
  getWebStatus,
  MODE,
};
