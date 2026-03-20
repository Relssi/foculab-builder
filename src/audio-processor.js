/**
 * Audio Processor — converte áudio para OGG Opus (formato PTT do WhatsApp)
 *
 * POR QUE ISSO É NECESSÁRIO:
 * O WhatsApp distingue dois tipos de áudio:
 *   1. Mensagem de Voz (PTT) → ícone verde de microfone, aparece como gravação
 *   2. Arquivo de Áudio     → ícone amarelo, aparece como upload
 *
 * A diferença está no CODEC:
 *   ✅ audio/ogg; codecs=opus → renderiza como PTT (mensagem de voz)
 *   ❌ audio/mpeg (MP3)       → renderiza como upload amarelo
 *   ❌ audio/mp4 (M4A/AAC)   → renderiza como upload amarelo
 *   ❌ audio/wav              → renderiza como upload amarelo
 *
 * REQUISITO DO SISTEMA:
 *   ffmpeg deve estar instalado no servidor:
 *   Ubuntu/Debian: sudo apt-get install ffmpeg
 *   macOS: brew install ffmpeg
 *   Docker: adicione `RUN apt-get install -y ffmpeg` no Dockerfile
 */

const ffmpeg = require('fluent-ffmpeg');
const { Readable, Writable } = require('stream');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Converte qualquer formato de áudio para OGG Opus (PTT-compatível)
 * @param {Buffer} inputBuffer - Buffer do áudio de entrada
 * @param {string} inputMime - MIME type do áudio de entrada (ex: 'audio/mpeg')
 * @returns {Promise<Buffer>} Buffer OGG Opus pronto para upload
 */
async function convertToOggOpus(inputBuffer, inputMime) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inputExt = mimeToExt(inputMime);
  const inputPath = path.join(tmpDir, `wa_audio_in_${id}.${inputExt}`);
  const outputPath = path.join(tmpDir, `wa_audio_out_${id}.ogg`);

  try {
    // Escreve o arquivo de entrada
    fs.writeFileSync(inputPath, inputBuffer);

    // Converte com ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec('libopus')      // codec Opus — obrigatório para PTT
        .audioChannels(1)           // mono — padrão de voz
        .audioFrequency(48000)      // 48kHz — padrão Opus
        .audioBitrate('64k')        // qualidade adequada para voz
        .format('ogg')              // container OGG
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const outputBuffer = fs.readFileSync(outputPath);
    return outputBuffer;

  } finally {
    // Limpa arquivos temporários
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

/**
 * Verifica se o ffmpeg está disponível no sistema
 * @returns {Promise<boolean>}
 */
async function checkFfmpegAvailable() {
  return new Promise(resolve => {
    ffmpeg.getAvailableFormats((err, formats) => {
      resolve(!err && formats && Object.keys(formats).length > 0);
    });
  });
}

function mimeToExt(mime) {
  const map = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/3gpp': '3gp',
    'audio/amr': 'amr',
  };
  return map[mime] || 'audio';
}

// Verifica disponibilidade na inicialização
checkFfmpegAvailable().then(ok => {
  if (!ok) {
    console.warn(`
[AudioProcessor] ⚠️  AVISO: ffmpeg não encontrado no sistema.
  O envio de áudio como mensagem de voz (PTT) não funcionará.
  Instale com:
    Ubuntu/Debian: sudo apt-get install ffmpeg
    macOS: brew install ffmpeg
    `);
  } else {
    console.log('[AudioProcessor] ✅ ffmpeg disponível — conversão PTT ativa');
  }
});

module.exports = { convertToOggOpus, checkFfmpegAvailable };
