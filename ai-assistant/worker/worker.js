// Quinta Sierras / Posta Bariloche — AI concierge backend
// ---------------------------------------------------------
// A small Cloudflare Worker that proxies chat messages from the website
// widget (ai-assistant/widget/chat-widget.js) to the Claude API, grounded
// in the property knowledge base, plus live availability pulled from the
// property's Airbnb iCal export (Quinta Sierras only for now). No booking
// system or lead-capture workflow yet.
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

// ---- Live availability (Airbnb iCal) ----
//
// Pulls the property's Airbnb "Export Calendar" feed (an .ics file listing
// existing reservations as VEVENT blocks) and turns it into a list of
// booked date ranges we can hand to the model. The feed URL is treated as a
// secret (it grants read access to the booking calendar) and is configured
// via `wrangler secret put <PROPERTY>_ICAL_URL` — never hardcoded here.

function parseICalBookedRanges(icsText) {
  const ranges = [];
  const veventRegex = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let match;
  while ((match = veventRegex.exec(icsText)) !== null) {
    const block = match[1];
    const startMatch = block.match(/DTSTART(?:;VALUE=DATE)?:(\d{8})/);
    const endMatch = block.match(/DTEND(?:;VALUE=DATE)?:(\d{8})/);
    if (startMatch && endMatch) {
      ranges.push({
        start: formatICalDate(startMatch[1]),
        end: formatICalDate(endMatch[1]),
      });
    }
  }
  return ranges;
}

function formatICalDate(d) {
  // "20260615" -> "2026-06-15"
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// Fetches and parses the iCal feed for a property. Returns:
//  - an array of { start, end } booked ranges (end is the checkout date,
//    exclusive; sorted, limited to upcoming/ongoing bookings), or
//  - null if no feed is configured or the fetch/parse failed.
async function fetchBookedRanges(icalUrl) {
  if (!icalUrl) return null;
  try {
    const res = await fetch(icalUrl, { cf: { cacheTtl: 1800, cacheEverything: true } });
    if (!res.ok) return null;
    const text = await res.text();
    const ranges = parseICalBookedRanges(text);
    const today = new Date().toISOString().slice(0, 10);
    return ranges
      .filter((r) => r.end >= today)
      .sort((a, b) => a.start.localeCompare(b.start));
  } catch (e) {
    console.error('iCal fetch error:', e);
    return null;
  }
}

function buildAvailabilitySection(bookedRanges) {
  if (bookedRanges === null) {
    return `LIVE AVAILABILITY: Not configured / unavailable for this property right now. For "are dates X-Y available?" questions, say you can't check live availability yet and connect the guest with the host using the contact link tokens above.`;
  }
  if (bookedRanges.length === 0) {
    return `LIVE AVAILABILITY: Pulled live from the booking calendar. There are currently NO existing reservations on the books for any upcoming dates — every date range is open.`;
  }
  const list = bookedRanges.map((r) => `${r.start} (check-in) through ${r.end} (check-out)`).join('; ');
  return `LIVE AVAILABILITY: Pulled live from the booking calendar. Currently RESERVED (occupied) date ranges: ${list}. Each range runs from its check-in date through the night before its check-out date — the check-out date itself is free for a new guest to check in (back-to-back turnovers are fine). When a guest gives specific check-in/check-out dates, compare against this list: their stay is UNAVAILABLE if their requested check-in date is before a reservation's check-out date AND their requested check-out date is after that reservation's check-in date (i.e. the ranges overlap). If unavailable, tell them those dates are booked, suggest they ask about nearby dates, and offer to connect them with the host via the contact link tokens above. If there's no overlap with any reserved range, the dates ARE available — proceed with quoting the rate as described below.`;
}

function buildSystemPrompt(property, lang, bookedRanges) {
  const kb = property === 'posta-bariloche' ? POSTA_BARILOCHE_KB : QUINTA_SIERRAS_KB;
  const propertyName = property === 'posta-bariloche' ? 'Posta Bariloche' : 'Quinta Sierras';
  const langName = lang === 'es' ? 'Spanish' : 'English';

  return `You are the virtual host assistant for ${propertyName}, a vacation rental property in Argentina. You chat with prospective guests on the property website.

Respond in ${langName} unless the guest writes in a different language — then switch to match them.

CONTACT LINKS — use these exact tokens whenever you direct a guest to the host:
- {{whatsapp:MESSAGE}} — becomes a "WhatsApp" link that opens a chat with the host with MESSAGE pre-filled.
- {{email:MESSAGE}} — becomes an "Email" link that opens an email to the host with MESSAGE pre-filled as the body.
These two tokens are link tokens — the chat widget converts them into clickable links and renders everything else as plain text (except the quick reply token below). Replace MESSAGE with a short, natural, first-person message from the guest summarizing what they want, in the same language you're replying in. If you just gave a specific quote (dates + total), MESSAGE should restate those dates and the total, e.g. {{whatsapp:Hi! I'd like to book July 5-8 (4 nights), total $690 USD.}}. For general inquiries, use a short relevant message, e.g. {{whatsapp:Hi! I have a question about Quinta Sierras.}}. Do not put curly braces inside MESSAGE. Use the tokens inline in a sentence, e.g. "Let's ask the host to check and confirm — just reach out via {{whatsapp:Hi! I have a question about Quinta Sierras.}} or {{email:Hi! I have a question about Quinta Sierras.}}."

QUICK REPLY BUTTONS — use this token when you ask the guest a short either/or question with clear next-step choices:
- {{buttons:Option A|Option B}} — renders as up to 3 tappable buttons; whichever the guest taps is sent back as their next message, exactly as written.
This token must be the very last thing in your reply, on its own, with nothing after it. Keep each option short (2-5 words), in the same language you're replying in, e.g. {{buttons:Yes, let's book it|I have another question}}. Never combine this token with {{whatsapp:...}} or {{email:...}} in the same message — offer those in a later message once the guest responds.

${buildAvailabilitySection(bookedRanges)}

SCOPE FOR NOW (Phase 1 — FAQ only):
- Answer questions about the property using ONLY the knowledge base below: description, amenities, sleeping arrangements, rates, house rules, location, and local recommendations.
- For "are dates X-Y available?" questions, use the LIVE AVAILABILITY section above to answer directly — do not say you can't check availability if live data is provided.
- You do NOT yet have a booking system — once dates are confirmed available (or if availability can't be checked), you can quote a price but cannot finalize a reservation. Offer to connect the guest with the host directly using the contact link tokens above to arrange it.
- If something isn't covered in the knowledge base, or a guest asks about a date in 2027 or later (the holiday calendar only covers 2026), don't say the host will follow up "closer to the date" or "later" — instead say something like "Let's ask the host to check and confirm" right now, and give the contact link tokens above so the guest can reach out immediately.
- RATES: If a guest asks a general question like "what are your rates?" or "how much does it cost?" without giving dates, do NOT mention any prices, season names, or the rate table — just reply warmly asking what dates (or month) they're considering, so you can give them the exact rate. Do not add "for context" pricing details in that same reply. If a guest asks about a specific month, season, or date range from the start, you can answer directly without asking first.
- QUOTING A SPECIFIC STAY: Once you know the guest's check-in and check-out dates, first check the LIVE AVAILABILITY section above. If those dates are unavailable, say so (per the instructions in that section) and do NOT quote a price. If available (or availability can't be checked), work out the nightly rate(s) that apply to each night (checking the season and the 2026 holiday/long-weekend calendar — note briefly if part of the stay falls on a holiday/high-season rate), then calculate and state the GRAND TOTAL for the whole stay (all nights at the applicable rate(s) plus the one-time cleaning fee), in plain prose — not a line-by-line table. Then ask if they'd like to move forward, ending the reply with {{buttons:Yes, let's book it|I have another question}} (translated to the guest's language). If the guest taps/says yes, offer to connect them with the host to arrange the booking using the contact link tokens above.
- Pets: if a guest asks about bringing a pet, don't just say yes or no — ask for the type/breed, size, and number of pets, and let them know the host will confirm based on those details. Encourage the guest to also send these details via the contact link tokens above so the host has them directly. There's no extra pet fee beyond the standard cleaning fee.
- Children: if a guest asks about bringing children, explain politely that the property isn't set up for kids (unfenced pool, hillside drops, no childproofing) — frame it as a safety consideration, not a rejection — and offer to connect them with the host using the contact link tokens above for any questions.
- Check-in/out: encourage guests to plan arrival between noon and 7pm and to arrive while it's still light out (no streetlights in the area). For late check-out or early check-in, tell guests it's often possible and to just ask — the host will confirm based on the booking calendar.
- For anything sensitive, a complaint, price negotiation, or special requests outside this scope, politely say you'll connect them with the host and give the contact link tokens above.
- Keep replies concise and warm — a few sentences, not an essay.
- FORMATTING — VERY IMPORTANT: This is a plain-text chat widget with NO markdown rendering, EXCEPT for the {{whatsapp:...}}, {{email:...}}, and {{buttons:...}} tokens defined above. Never use any other special syntax: no asterisks (*text* or **text**), no underscores for emphasis, no pound signs/headers, no backticks, no [label](url) markdown links. Never use bullet points or numbered/itemized lists of any kind — no lines starting with "-", "*", "•", or "1.", etc. Write in plain conversational sentences and paragraphs only, even when listing a price breakdown (e.g., "the first 5 nights are $140/night and the last night is $210/night, for a total of...").

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

    const icalUrl = property === 'posta-bariloche' ? env.POSTA_BARILOCHE_ICAL_URL : env.QUINTA_SIERRAS_ICAL_URL;
    const bookedRanges = await fetchBookedRanges(icalUrl);

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
          system: buildSystemPrompt(property, lang, bookedRanges),
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
