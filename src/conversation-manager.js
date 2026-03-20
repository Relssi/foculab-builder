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
const whatsappApi = require('./whatsapp-adapter');
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

// ─── Seed de demonstração ─────────────────────────────────────────────────────
function seedDemo() {
  const now = new Date();
  const ts = (minAgo) => new Date(now - minAgo * 60000).toISOString();

  const demo = [
    {
      phone: '5511999990001',
      name: 'João Witor',
      mode: 'escalated',
      escalateReason: 'Cliente pronto para fechar — quer negociar condições de pagamento e NF',
      escalateSummary: 'Cliente interessado no plano Pro. Pediu desconto para pagamento anual e nota fiscal. Boa oportunidade de fechamento.',
      leadStage: 'decisao',
      leadNotes: 'Alta intenção de compra, só precisa de condições especiais',
      messages: [
        { role:'client', content:{type:'text',text:'Oi, vi vocês no Instagram, queria saber mais sobre os planos'}, ts:ts(45), fromAI:false },
        { role:'assistant', content:{type:'text',text:'Olá João! Que bom que chegou até nós 😊 Me fala um pouco do seu negócio, qual segmento você atua?'}, ts:ts(44), fromAI:true },
        { role:'client', content:{type:'text',text:'Tenho uma clínica odontológica, 3 unidades'}, ts:ts(40) },
        { role:'assistant', content:{type:'text',text:'Perfeito! Clínicas odontológicas têm um potencial enorme nas redes sociais. Vocês já têm presença hoje ou estão começando do zero?'}, ts:ts(39), fromAI:true },
        { role:'client', content:{type:'text',text:'Temos Instagram mas não tá funcionando bem, poucos seguidores e zero vendas vindo de lá'}, ts:ts(35) },
        { role:'assistant', content:{type:'text',text:'Entendo! Isso é bem comum — postar sem estratégia não gera resultado. Nosso plano Pro foi feito exatamente pra isso: 5 posts/semana + gestão de tráfego pago. A maioria dos nossos clientes começa a ver leads em 30 dias.\n\nO investimento é R$1.997/mês, já com R$500 de verba de anúncios incluso. Faz sentido pro seu momento?'}, ts:ts(30), fromAI:true },
        { role:'client', content:{type:'text',text:'Interessante. Mas eu quero pagar anual, tem desconto? E preciso de nota fiscal'}, ts:ts(5) },
      ],
      unreadByOperator: 1,
      createdAt: ts(50),
      updatedAt: ts(5),
    },
    {
      phone: '5511999990002',
      name: 'Mariana Costa',
      mode: 'ai',
      escalateReason: null,
      escalateSummary: null,
      leadStage: 'interesse',
      leadNotes: 'Loja de roupas femininas, 2 anos no mercado',
      messages: [
        { role:'client', content:{type:'text',text:'Boa tarde! Quero entender melhor como funciona o serviço'}, ts:ts(20) },
        { role:'assistant', content:{type:'text',text:'Boa tarde, Mariana! Claro, vou explicar tudo 😊 Você já tem alguma presença nas redes ou está começando agora?'}, ts:ts(19), fromAI:true },
        { role:'client', content:{type:'text',text:'Tenho Instagram e TikTok, mas só eu que cuido e não tenho tempo'}, ts:ts(15) },
        { role:'assistant', content:{type:'text',text:'Faz todo sentido! Cuidar das redes junto com o negócio é puxado. A gente assume tudo — criação, publicação e se quiser a parte de anúncios também.\n\nMe conta: qual o maior desafio hoje? Falta de tempo pra criar conteúdo, ou você sente que o que posta não tá convertendo?'}, ts:ts(14), fromAI:true },
        { role:'client', content:{type:'text',text:'Os dois rs. Que planos vocês têm?'}, ts:ts(10) },
      ],
      unreadByOperator: 0,
      createdAt: ts(25),
      updatedAt: ts(10),
    },
    {
      phone: '5511999990003',
      name: 'Carlos Mendes',
      mode: 'human',
      assignedOperator: 'operador-demo',
      escalateReason: null,
      escalateSummary: null,
      leadStage: 'pos-venda',
      leadNotes: 'Cliente fechou o plano Enterprise ontem',
      messages: [
        { role:'client', content:{type:'text',text:'Oi, fechei o plano ontem, quando começa?'}, ts:ts(8) },
        { role:'assistant', content:{type:'text',text:'Olá Carlos! Parabéns pela decisão 🎉 Vou passar aqui o próximo passo para você.'}, ts:ts(7), fromAI:false },
        { role:'client', content:{type:'text',text:'Ótimo! Aguardo'}, ts:ts(6) },
      ],
      unreadByOperator: 0,
      createdAt: ts(10),
      updatedAt: ts(6),
    },
    {
      phone: '5511999990004',
      name: 'Ana Paula',
      mode: 'ai',
      escalateReason: null,
      escalateSummary: null,
      leadStage: 'curiosidade',
      leadNotes: '',
      messages: [
        { role:'client', content:{type:'audio',mediaId:'demo',voice:true}, ts:ts(3) },
        { role:'assistant', content:{type:'text',text:'Olá, Ana Paula! Ouvi sua mensagem 😊 Pode me contar um pouco mais sobre o que você está procurando? Trabalho com redes sociais ou outra área?'}, ts:ts(2), fromAI:true },
      ],
      unreadByOperator: 1,
      createdAt: ts(5),
      updatedAt: ts(2),
    },
  ];

  demo.forEach(d => {
    conversations.set(d.phone, {
      ...createConversation(d.phone, d.name),
      ...d,
    });
  });

  console.log('[Demo] 4 conversas de demonstração carregadas');
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
  seedDemo,
};
