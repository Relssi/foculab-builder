/**
 * WhatsApp Cloud API wrapper
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * PONTO CRÍTICO - Áudio PTT (Push To Talk):
 * O WhatsApp renderiza áudio como mensagem de voz (ícone verde, sem amarelo)
 * quando o arquivo está no formato OGG com codec Opus (audio/ogg; codecs=opus).
 * Qualquer outro formato (MP3, M4A, AAC) aparece como upload amarelo.
 * Por isso o src/audio-processor.js converte tudo para OGG Opus antes de enviar.
 */

const axios = require('axios');
const FormData = require('form-data');
const audioProcessor = require('./audio-processor');

const BASE_URL = 'https://graph.facebook.com/v19.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

function apiClient() {
  return axios.create({
    baseURL: `${BASE_URL}/${PHONE_NUMBER_ID}`,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// ─── Enviar texto ─────────────────────────────────────────────────────────────
async function sendText(to, text) {
  const client = apiClient();
  const res = await client.post('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  });
  return res.data;
}

// ─── Enviar imagem ────────────────────────────────────────────────────────────
async function sendImage(to, mediaId, caption = '') {
  const client = apiClient();
  const res = await client.post('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { id: mediaId, caption },
  });
  return res.data;
}

// ─── Enviar imagem por URL pública ────────────────────────────────────────────
async function sendImageUrl(to, url, caption = '') {
  const client = apiClient();
  const res = await client.post('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { link: url, caption },
  });
  return res.data;
}

// ─── Enviar áudio como PTT (mensagem de voz) ──────────────────────────────────
// O segredo está aqui: converter para OGG Opus ANTES de enviar.
// Isso garante que apareça como gravação de voz (verde) e não upload amarelo.
async function sendAudio(to, audioBuffer, mimeType = 'audio/mpeg') {
  let finalBuffer = audioBuffer;

  // Só converte se não for já OGG Opus
  const isOggOpus = mimeType === 'audio/ogg' || mimeType.includes('ogg');
  if (!isOggOpus) {
    console.log(`[WhatsApp] Convertendo ${mimeType} → OGG Opus para PTT`);
    finalBuffer = await audioProcessor.convertToOggOpus(audioBuffer, mimeType);
  }

  const mediaId = await uploadMedia(finalBuffer, 'audio/ogg; codecs=opus');
  const client = apiClient();

  const res = await client.post('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'audio',
    audio: { id: mediaId },
    // Nota: a API Cloud não tem campo `ptt` explícito —
    // o codec OGG Opus é o que força a renderização como voz.
  });
  return res.data;
}

// ─── Upload de mídia ──────────────────────────────────────────────────────────
async function uploadMedia(buffer, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, {
    filename: getFilenameForMime(mimeType),
    contentType: mimeType,
  });

  const res = await axios.post(
    `${BASE_URL}/${PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...form.getHeaders(),
      },
    }
  );
  return res.data.id;
}

// ─── Download de mídia (para processar áudio/imagem recebidos) ────────────────
async function downloadMedia(mediaId) {
  // 1. Pega a URL do media
  const urlRes = await axios.get(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const mediaUrl = urlRes.data.url;
  const mimeType = urlRes.data.mime_type;

  // 2. Baixa o arquivo
  const fileRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType,
  };
}

// ─── Marcar mensagem como lida ────────────────────────────────────────────────
async function markRead(messageId) {
  const client = apiClient();
  await client.post('/messages', {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function getFilenameForMime(mimeType) {
  const map = {
    'image/jpeg': 'image.jpg',
    'image/png': 'image.png',
    'image/webp': 'image.webp',
    'audio/ogg': 'voice.ogg',
    'audio/ogg; codecs=opus': 'voice.ogg',
    'audio/mpeg': 'audio.mp3',
    'audio/mp4': 'audio.m4a',
    'video/mp4': 'video.mp4',
    'application/pdf': 'document.pdf',
  };
  return map[mimeType] || 'file';
}

module.exports = {
  sendText,
  sendImage,
  sendImageUrl,
  sendAudio,
  uploadMedia,
  downloadMedia,
  markRead,
};
