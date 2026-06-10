// Quinta Sierras / Posta Bariloche — AI concierge backend
// ---------------------------------------------------------
// A small Cloudflare Worker that proxies chat messages from the website
// widget (ai-assistant/widget/chat-widget.js) to the Claude API, grounded
// in the property knowledge base. Phase 1 scope: FAQ-answering only — no
// availability checks, rate quoting, or lead capture yet.
//
// Deploy: see ai-assistant/README.md

import { QUINTA_SIERRAS_KB, POSTA_BARILOCHE_KB } from './knowledge-base.js';

const ALLOWED_ORIGINS = [
  'https://www.quintasierras.com',
  'https://quintasierras.com',
  'https://postabariloche.com',
  'https://www.postabariloche.com',
];

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_HISTORY_TURNS = 8; // cap context sent per request

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function buildSystemPrompt(property, lang) {
  const kb = property === 'posta-bariloche' ? POSTA_BARILOCHE_KB : QUINTA_SIERRAS_KB;
  const propertyName = property === 'posta-bariloche' ? 'Posta Bariloche' : 'Quinta Sierras';
  const langName = lang === 'es' ? 'Spanish' : 'English';

  return `You are the virtual host assistant for ${propertyName}, a vacation rental property in Argentina. You chat with prospective guests on the property website.

Respond in ${langName} unless the guest writes in a different language — then switch to match them.

SCOPE FOR NOW (Phase 1 — FAQ only):
- Answer questions about the property using ONLY the knowledge base below: description, amenities, sleeping arrangements, rates, house rules, location, and local recommendations.
- You do NOT yet have access to a live availability calendar or a booking system. If a guest asks "are dates X-Y available?" or wants to book, tell them you can't check live availability yet. Then immediately offer to connect them with the host directly: "Let's ask the host to check and confirm — you can reach them on WhatsApp at https://wa.me/5493518749830 or by email at quintasierras@gmail.com." Always give that exact WhatsApp link and email address (from the knowledge base) as plain text so the guest can tap/click them.
- If something isn't covered in the knowledge base, or a guest asks about a date in 2027 or later (the holiday calendar only covers 2026), don't say the host will follow up "closer to the date" or "later" — instead say something like "Let's ask the host to check and confirm" right now, and give the WhatsApp link (https://wa.me/5493518749830) and email (quintasierras@gmail.com) so the guest can reach out immediately.
- RATES: If a guest asks a general question like "what are your rates?" or "how much does it cost?" without giving dates, do NOT recite the full seasonal rate table. Instead, ask them what dates (or month/season) they're considering, so the exact rate can be confirmed. Only give specific numbers once you know the dates — then check the season and the 2026 holiday/long-weekend calendar and quote just the relevant nightly rate(s) concisely (one or two sentences), noting if part of the stay falls on a holiday/high-season rate. If a guest asks about a specific month, season, or date range from the start, you can answer directly without asking first.
- Pets: if a guest asks about bringing a pet, don't just say yes or no — ask for the type/breed, size, and number of pets, and let them know the host will confirm based on those details. Encourage the guest to also send these details via WhatsApp (https://wa.me/5493518749830) or email (quintasierras@gmail.com) so the host has them directly. There's no extra pet fee beyond the standard cleaning fee.
- Children: if a guest asks about bringing children, explain politely that the property isn't set up for kids (unfenced pool, hillside drops, no childproofing) — frame it as a safety consideration, not a rejection — and offer to connect them with the host (WhatsApp https://wa.me/5493518749830 or email quintasierras@gmail.com) for any questions.
- Check-in/out: encourage guests to plan arrival between noon and 7pm and to arrive while it's still light out (no streetlights in the area). For late check-out or early check-in, tell guests it's often possible and to just ask — the host will confirm based on the booking calendar.
- For anything sensitive, a complaint, price negotiation, or special requests outside this scope, politely say you'll connect them with the host and give the WhatsApp link (https://wa.me/5493518749830) and email (quintasierras@gmail.com).
- Keep replies concise and warm — a few sentences, not an essay.
- FORMATTING — VERY IMPORTANT: This is a plain-text chat widget with NO markdown rendering. Never use markdown syntax of any kind: no asterisks (*text* or **text**), no underscores for emphasis, no pound signs/headers, no bullet points or numbered lists, no backticks. Write in plain conversational sentences and paragraphs only. URLs and email addresses should be written as plain text (e.g. https://wa.me/5493518749830) with nothing around them.

KNOWLEDGE BASE — ${propertyName}:
${kb}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const property = body.property === 'posta-bariloche' ? 'posta-bariloche' : 'quinta-sierras';
    const lang = body.lang === 'es' ? 'es' : 'en';
    const message = (body.message || '').toString().slice(0, 2000);
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];

    if (!message.trim()) {
      return new Response(JSON.stringify({ error: 'Empty message' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const messages = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    messages.push({ role: 'user', content: message });

    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 500,
          system: buildSystemPrompt(property, lang),
          messages,
        }),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        console.error('Anthropic API error:', apiRes.status, errText);
        return new Response(JSON.stringify({ error: 'Upstream error' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      const data = await apiRes.json();
      const reply = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      return new Response(JSON.stringify({ reply }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    } catch (e) {
      console.error('Worker error:', e);
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  },
};
