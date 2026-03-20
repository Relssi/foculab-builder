/**
 * Conversation Manager — máquina de estado para gerenciar conversas
 *
 * Modos de uma conversa:
 * - 'ai': IA responde automaticamente seguindo o script
 * - 'human': Operador humano assumiu, IA silenciada
 * - 'escalated': IA pediu ajuda humana, aguardando operador assumir
 */

const fs = require('fs');
const path = require('path');
const whatsappApi = require('./whatsapp-api');
const aiAgent = require('./ai-agent');

// ─── Estado global ────────────────────────────────────────────────────────────
const conversations = new Map(); // phone → ConversationState
let broadcastFn = null;
let salesScript = loadDefaultScript();

function setBroadcast(fn) {
  broadcastFn = fn;
}

function loadDefaultScript() {
  const scriptPath = path.join(__dirname, '../config/sales-script.txt');
  const examplePath = path.join(__dirname, '../config/sales-script.example.txt');
  try {
    if (fs.existsSync(scriptPath)) return fs.readFileSync(scriptPath, 'utf8');
    if (fs.existsSync(examplePath)) return fs.readFileSync(examplePath, 'utf8');
  } catch {}
  return 'Seja cordial, tire dúvidas sobre nossos produtos e serviços, e conduza o cliente ao fechamento.';
}

function updateSalesScript(newScript) {
  salesScript = newScript;
  // Persiste no arquivo
  const scriptPath = path.join(__dirname, '../config/sales-script.txt');
  try {
    fs.writeFileSync(scriptPath, newScript, 'utf8');
  } catch (err) {
    console.warn('[ConvManager] Não foi possível salvar o script:', err.message);
  }
  console.log('[ConvManager] Script de vendas atualizado');
}

function getSalesScript() {
  return salesScript;
}

// ─── Estrutura de uma conversa ────────────────────────────────────────────────
function createConversation(phone, name) {
  return {
    phone,
    name: name || phone,
    mode: 'ai',            // 'ai' | 'escalated' | 'human'
    assignedOperator: null,
    escalateReason: null,
    escalateSummary: null,
    leadStage: 'curiosidade',
    leadNotes: '',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    unreadByOperator: 0,
  };
}

function getOrCreate(phone, name) {
  if (!conversations.has(phone)) {
    conversations.set(phone, createConversation(phone, name));
    console.log(`[ConvManager] Nova conversa: ${phone} (${name})`);
  }
  return conversations.get(phone);
}

// ─── Receber mensagem do cliente ──────────────────────────────────────────────
async function handleIncoming(phone, name, content) {
  const conv = getOrCreate(phone, name);

  // Registra a mensagem
  conv.messages.push({
    role: 'client',
    content,
    ts: new Date().toISOString(),
  });
  conv.updatedAt = new Date().toISOString();
  conv.unreadByOperator++;

  // Notifica dashboard em tempo real
  if (broadcastFn) {
    broadcastFn('message', { phone, name: conv.name, content, mode: conv.mode });
    broadcastFn('update', getAllConversations());
  }

  // Se estiver com humano, não faz mais nada (operador vê no dashboard)
  if (conv.mode === 'human' || conv.mode === 'escalated') {
    console.log(`[ConvManager] ${phone} — modo ${conv.mode}, mensagem entregue ao operador`);
    return;
  }

  // Modo AI: processa com Claude
  await processWithAI(conv);
}

async function processWithAI(conv) {
  console.log(`[ConvManager] ${conv.phone} — processando com IA`);

  try {
    const result = await aiAgent.processMessage(conv, salesScript);

    // Atualiza metadados do lead
    conv.leadStage = result.leadStage;
    conv.leadNotes = result.leadNotes;
    conv.updatedAt = new Date().toISOString();

    if (result.shouldEscalate) {
      // Escala para humano
      await escalate(conv, result.escalateReason);
      return;
    }

    // Envia as respostas da IA
    for (const msg of result.messages) {
      if (!msg?.trim()) continue;

      // Delay naturalista entre mensagens (500ms a 1.5s)
      if (result.messages.length > 1) {
        await sleep(500 + Math.random() * 1000);
      }

      await whatsappApi.sendText(conv.phone, msg);

      conv.messages.push({
        role: 'assistant',
        content: { type: 'text', text: msg },
        ts: new Date().toISOString(),
        fromAI: true,
      });
    }

    if (broadcastFn) broadcastFn('update', getAllConversations());

  } catch (err) {
    console.error(`[ConvManager] Erro ao processar IA para ${conv.phone}:`, err.message);
    await escalate(conv, `Erro técnico: ${err.message}`);
  }
}

// ─── Escalada para humano ─────────────────────────────────────────────────────
async function escalate(conv, reason) {
  conv.mode = 'escalated';
  conv.escalateReason = reason;
  conv.updatedAt = new Date().toISOString();

  console.log(`[ConvManager] ESCALADA: ${conv.phone} — ${reason}`);

  // Gera resumo para o operador
  try {
    conv.escalateSummary = await aiAgent.summarizeConversation(conv);
  } catch {
    conv.escalateSummary = 'Resumo indisponível.';
  }

  // Notifica dashboard
  if (broadcastFn) {
    broadcastFn('escalated', {
      phone: conv.phone,
      name: conv.name,
      reason,
      summary: conv.escalateSummary,
      leadStage: conv.leadStage,
    });
    broadcastFn('update', getAllConversations());
  }
}

// ─── Operador humano assume a conversa ───────────────────────────────────────
function humanTakeover(phone, operatorId) {
  const conv = conversations.get(phone);
  if (!conv) return;

  conv.mode = 'human';
  conv.assignedOperator = operatorId;
  conv.unreadByOperator = 0;
  conv.updatedAt = new Date().toISOString();

  console.log(`[ConvManager] ${phone} — operador "${operatorId}" assumiu`);
}

// ─── Operador devolve para a IA ───────────────────────────────────────────────
function humanRelease(phone) {
  const conv = conversations.get(phone);
  if (!conv) return;

  conv.mode = 'ai';
  conv.assignedOperator = null;
  conv.escalateReason = null;
  conv.escalateSummary = null;
  conv.updatedAt = new Date().toISOString();

  console.log(`[ConvManager] ${phone} — devolvido para IA`);
}

// ─── Operador adiciona mensagem (registra no histórico) ───────────────────────
function addOperatorMessage(phone, text) {
  const conv = conversations.get(phone);
  if (!conv) return;

  conv.messages.push({
    role: 'assistant',
    content: { type: 'operator', text },
    ts: new Date().toISOString(),
    fromAI: false,
  });
  conv.updatedAt = new Date().toISOString();
}

// ─── Lista todas as conversas para o dashboard ────────────────────────────────
function getAllConversations() {
  return Array.from(conversations.values()).map(conv => ({
    phone: conv.phone,
    name: conv.name,
    mode: conv.mode,
    assignedOperator: conv.assignedOperator,
    escalateReason: conv.escalateReason,
    escalateSummary: conv.escalateSummary,
    leadStage: conv.leadStage,
    leadNotes: conv.leadNotes,
    unreadByOperator: conv.unreadByOperator,
    updatedAt: conv.updatedAt,
    createdAt: conv.createdAt,
    messageCount: conv.messages.length,
    // Últimas 50 mensagens para o dashboard
    messages: conv.messages.slice(-50).map(m => ({
      role: m.role,
      content: m.content,
      ts: m.ts,
      fromAI: m.fromAI,
    })),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  handleIncoming,
  humanTakeover,
  humanRelease,
  addOperatorMessage,
  getAllConversations,
  updateSalesScript,
  getSalesScript,
  setBroadcast,
};
