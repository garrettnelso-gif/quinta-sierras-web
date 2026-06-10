# AI Concierge — Phase 1 (FAQ Assistant)

This is the first phase of the AI booking assistant for Quinta Sierras and
Posta Bariloche: a website chat widget that answers guest questions from a
written knowledge base. No availability checks, rate quoting, or lead capture
yet — those are later phases.

## What's here

```
ai-assistant/
├── knowledge-base/
│   ├── quinta-sierras.md      ← human-readable property reference
│   └── posta-bariloche.md     ← human-readable property reference
├── widget/
│   ├── chat-widget.js         ← embeddable chat widget (already added to both sites)
│   └── chat-widget.css
├── worker/
│   ├── worker.js               ← Cloudflare Worker backend (Claude API proxy)
│   ├── knowledge-base.js        ← KB content embedded for the worker (keep in sync with knowledge-base/*.md)
│   └── wrangler.toml
└── README.md  (this file)
```

The widget is already wired into both `index.html` (Quinta Sierras) and
`casa-bari-web/index.html` (Posta Bariloche), but its `endpoint` is empty —
until you deploy the backend and set the URL, the widget will tell guests
the chat isn't configured yet and point them to WhatsApp/email.

## What you need to do to go live

1. **Review the knowledge base.** `knowledge-base/quinta-sierras.md` (and
   the matching `QUINTA_SIERRAS_KB` in `worker/knowledge-base.js`) is now
   filled in: house rules, seasonal rates, payment methods, deposits,
   cancellation policy, check-in/out, and a 2026 holiday calendar. Double
   check the 2026 holiday dates against argentina.gob.ar and add the 2027
   calendar once it's published. `knowledge-base/posta-bariloche.md` still
   has items marked "NOT YET DOCUMENTED" (out of scope for now — Posta
   Bariloche is a later phase).

2. **Get an Anthropic API key.** Sign up at https://console.anthropic.com,
   create an API key, and add billing. Cost for FAQ traffic on two
   low-volume properties should be a few dollars a month using the Haiku
   model (already configured in `worker.js`).

3. **Deploy the Cloudflare Worker** (free tier is plenty for this volume):
   - Install wrangler: `npm install -g wrangler`
   - `cd ai-assistant/worker`
   - `wrangler login` (one-time, opens a browser to your Cloudflare account)
   - `wrangler secret put ANTHROPIC_API_KEY` and paste your key when prompted
   - `wrangler secret put QUINTA_SIERRAS_ICAL_URL` and paste the Airbnb
     calendar export URL (Airbnb listing → Availability → Sync calendars →
     Export calendar → Copy). This powers live availability checking for
     Quinta Sierras; Posta Bariloche doesn't have one configured yet, so it
     keeps deferring to the host for date questions.
   - `wrangler deploy`
   - This prints a URL like `https://quinta-sierras-concierge.<your-subdomain>.workers.dev`

4. **Wire the widget to the worker.** In `index.html` and
   `casa-bari-web/index.html`, set:
   ```js
   endpoint: "https://quinta-sierras-concierge.<your-subdomain>.workers.dev/"
   ```

5. **Test it** on both sites — ask about amenities, rates, location, pets,
   etc. Try asking something out of scope (e.g. "are June 10–15 available?")
   to confirm it correctly defers to the host instead of guessing.

## Notes

- The worker only allows requests from quintasierras.com and
  postabariloche.com (CORS). Update `ALLOWED_ORIGINS` in `worker.js` if you
  add other domains (e.g. a staging URL).
- Conversation history is not stored anywhere — each browser session is
  independent, and nothing is logged except basic error messages in
  Cloudflare's dashboard.
- Live availability for Quinta Sierras is pulled from the Airbnb iCal export
  (`QUINTA_SIERRAS_ICAL_URL` secret), cached at Cloudflare's edge for ~30
  minutes. If the feed is unreachable, the assistant falls back to deferring
  date questions to the host, as before.
- Next phases (per the original plan): rate quoting from a structured rate
  table, and lead-capture with an approval workflow sent to your
  email/WhatsApp.
