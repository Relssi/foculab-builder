/**
 * AI Agent — Claude-powered WhatsApp sales assistant
 *
 * Responsabilidades:
 * 1. Seguir o script de vendas configurado
 * 2. Gerar respostas naturais e personalizadas
 * 3. Decidir quando escalar para humano (sem avisar o cliente)
 * 4. Transcrever áudio recebido (se necessário)
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Prompt base do sistema — envolve o script do usuário
function buildSystemPrompt(salesScript) {
  return `Você é um assistente de vendas via WhatsApp. Seu comportamento:

IDENTIDADE:
- Você se comunica como se fosse um atendente humano da empresa
- NUNCA revele que é uma IA ou sistema automatizado
- Use linguagem natural, informal mas profissional
- Use emojis com moderação quando fizer sentido

SCRIPT DE VENDAS:
${salesScript}

REGRAS DE COMUNICAÇÃO:
- Mensagens curtas e diretas (WhatsApp não é e-mail)
- Máximo 3 parágrafos por mensagem
- Se precisar passar muita informação, quebre em múltiplas mensagens (use \\n---\\n como separador)
- Nunca mande paredes de texto

QUANDO ESCALAR PARA HUMANO (campo "should_escalate: true"):
1. Cliente faz pergunta muito específica que você não consegue responder pelo script
2. Cliente demonstra frustração, reclamação ou irritação
3. Cliente está pronto para fechar negócio (precisa de contrato, valores finais, assinatura)
4. Cliente pede explicitamente para falar com uma pessoa
5. Situação ambígua onde a resposta errada pode prejudicar a venda
6. Cliente enviou áudio com conteúdo complexo/emocional

FORMATO DE RESPOSTA:
Sempre retorne JSON válido com esta estrutura exata:
{
  "messages": ["mensagem 1", "mensagem 2"],
  "should_escalate": false,
  "escalate_reason": null,
  "lead_stage": "curiosidade|interesse|consideracao|decisao|pos-venda|desqualificado",
  "lead_notes": "observação rápida sobre o lead para o operador"
}

- "messages": array de strings (pode ser 1 ou mais mensagens para enviar em sequência)
- "should_escalate": true ou false
- "escalate_reason": motivo do escalonamento (só preenche se should_escalate for true)
- "lead_stage": estágio atual do lead no funil
- "lead_notes": nota interna sobre o lead (NÃO é enviada para o cliente)`;
}

/**
 * Processa uma mensagem e retorna a resposta da IA
 * @param {Object} conversation - Estado da conversa
 * @param {string} salesScript - Script de vendas atual
 * @returns {Promise<{messages: string[], shouldEscalate: boolean, escalateReason: string, leadStage: string, leadNotes: string}>}
 */
async function processMessage(conversation, salesScript) {
  const systemPrompt = buildSystemPrompt(salesScript);

  // Monta o histórico de mensagens no formato do Claude
  const messages = conversation.messages.map(msg => {
    const role = msg.role === 'client' ? 'user' : 'assistant';
    let content = '';

    if (msg.content.type === 'text') {
      content = msg.content.text;
    } else if (msg.content.type === 'image') {
      content = `[Cliente enviou uma imagem${msg.content.caption ? `: ${msg.content.caption}` : ''}]`;
    } else if (msg.content.type === 'audio') {
      content = msg.content.transcription
        ? `[Áudio transcrito: "${msg.content.transcription}"]`
        : '[Cliente enviou um áudio de voz]';
    } else if (msg.content.type === 'operator') {
      // Mensagem enviada pelo operador humano — representa a "voz" do assistente
      content = msg.content.text;
    } else {
      content = `[${msg.content.type}]`;
    }

    return { role, content };
  });

  // Garante que começa com user e alterna corretamente
  const cleanMessages = normalizeMessageHistory(messages);

  try {
    const response = await client.messages.create({
      model: process.env.AI_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: cleanMessages,
    });

    const text = response.content[0].text.trim();

    // Tenta parsear o JSON da resposta
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Resposta da IA não contém JSON válido');

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [parsed.messages],
      shouldEscalate: parsed.should_escalate === true,
      escalateReason: parsed.escalate_reason || null,
      leadStage: parsed.lead_stage || 'curiosidade',
      leadNotes: parsed.lead_notes || '',
    };

  } catch (err) {
    console.error('[AI] Erro ao processar:', err.message, JSON.stringify(err.error || err.response?.data || ''));
    // Fallback seguro — escala para humano se a IA falhar
    return {
      messages: [],
      shouldEscalate: true,
      escalateReason: `Erro interno da IA: ${err.message}`,
      leadStage: 'curiosidade',
      leadNotes: 'IA falhou, handoff automático',
    };
  }
}

/**
 * Normaliza histórico para garantir alternância user/assistant correta
 * A API do Claude exige que as mensagens alternem entre user e assistant
 */
function normalizeMessageHistory(messages) {
  if (!messages.length) return [];

  const result = [];
  let lastRole = null;

  for (const msg of messages) {
    if (msg.role === lastRole) {
      // Agrupa mensagens consecutivas do mesmo papel
      result[result.length - 1].content += '\n' + msg.content;
    } else {
      result.push({ ...msg });
      lastRole = msg.role;
    }
  }

  // Claude exige que comece com 'user'
  if (result[0]?.role === 'assistant') {
    result.shift();
  }

  return result;
}

/**
 * Gera um resumo da conversa para o operador humano
 */
async function summarizeConversation(conversation) {
  const messages = conversation.messages.map(m => {
    const who = m.role === 'client' ? 'Cliente' : 'Assistente';
    const text = m.content.type === 'text' ? m.content.text : `[${m.content.type}]`;
    return `${who}: ${text}`;
  }).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', // modelo rápido para resumos
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Faça um resumo executivo em 3 linhas desta conversa de vendas para o operador humano que vai assumir o atendimento:\n\n${messages}`,
      }],
    });
    return response.content[0].text.trim();
  } catch {
    return 'Resumo indisponível.';
  }
}

module.exports = { processMessage, summarizeConversation };
