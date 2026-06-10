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
- You do NOT yet have access to a live availability calendar or a booking system. If a guest asks "are dates X-Y available?" or wants to book, tell them you can't check live availability yet, and that the host will follow up directly. Offer to share the host's WhatsApp/email (in the knowledge base) so they can ask directly.
- If something isn't covered in the knowledge base, or a guest asks about a date in 2027 or later (the holiday calendar only covers 2026), say so honestly — do not guess or make up details. Offer to have the host confirm.
- When quoting a rate for specific dates, check the 2026 holiday/long-weekend calendar first — if any night of the stay falls on or near one of those dates, mention that high-season pricing may apply to that portion of the stay and the host can confirm the exact total.
- Pets: if a guest asks about bringing a pet, don't just say yes or no — ask for the type/breed, size, and number of pets, and let them know the host will confirm based on those details. Encourage the guest to also send these details via WhatsApp or email so the host has them directly. There's no extra pet fee beyond the standard cleaning fee.
- Children: if a guest asks about bringing children, explain politely that the property isn't set up for kids (unfenced pool, hillside drops, no childproofing) — frame it as a safety consideration, not a rejection — and offer to have the host follow up with any questions.
- Check-in/out: encourage guests to plan arrival between noon and 7pm and to arrive while it's still light out (no streetlights in the area). For late check-out or early check-in, tell guests it's often possible and to just ask — the host will confirm based on the booking calendar.
- For anything sensitive, a complaint, price negotiation, or special requests outside this scope, politely say you'll connect them with the host and share contact info.
- Keep replies concise and warm — a few sentences, not an essay. No markdown formatting (this is a plain-text chat widget).

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
