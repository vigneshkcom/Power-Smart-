# PowerSmart — QLD Smoke Alarms

Static site deployed on Vercel (production branch: `main`).

## Live links

| Purpose | URL | Source file |
|---|---|---|
| **Customer landing page** (public, for ads/marketing) | `https://smokealarms.powersmartco.com.au/` | `index.html` |
| **Staff quote tool** (internal — build & send quotes) | `https://smokealarms.powersmartco.com.au/tools` | `tools/index.html` |

The Vercel-provided domain (`https://power-smart-two.vercel.app/`) still works and serves
the same content — `smokealarms.powersmartco.com.au` is a custom domain attached to the
same project.

Old links still work via redirects in `vercel.json`:
`/sales-portal.html` → `/tools`, `/qld-smoke-alarms.html` → `/`.

## Structure

```
index.html            Customer landing page — info + lead-capture form (no self-quoting)
accept.html           Quote acceptance page (/accept) → Stripe
tools/index.html      Staff sales portal — quote builder, SMS/email/PDF
tools/pipeline.html   Staff sales pipeline (/tools/pipeline) — GHL-style kanban
api/_quote.js         Shared pricing + quote-email rendering (not a route)
api/_supabase.js      Server-side Supabase REST helper (not a route)
api/_senders.js       Sender identities (Customer Service/Mani/Vignesh) + signature (not a route)
api/_maillog.js       Logs every outbound email to Supabase sent_emails (not a route)
api/send-quote.js     POST /api/send-quote  — emails a customer their quotation
api/send-email.js     POST /api/send-email  — free-form branded email (composer)
api/accept-quote.js   POST /api/accept-quote — notifies staff a quote was accepted
api/lead.js           POST /api/lead         — emails staff a new website lead
api/pipeline.js       GET/POST /api/pipeline — kanban board CRUD (needs portal key)
supabase/schema.sql   Run once in Supabase SQL Editor — leads + comments tables
supabase/emails.sql   Run once — sent_emails log table
vercel.json           Clean URLs + redirects (preserves old links)
assets/logo/          PowerSmart logo files (upload via GitHub web UI)
assets/email/         Product photos used on the site and in quote emails
archive/              Retired / other-brand files, kept for reference
```

See `assets/README.md` for how to upload media and get its public URL.

## Lead & quote flow

1. **Landing page** collects name / phone / email / postcode and POSTs to
   `/api/lead`, which emails the lead to the team so they can **call and quote
   over the phone**. No self-service pricing or payment on the landing page.
2. **Staff** build the quote in `/tools` and hit *Email Quote to Customer* →
   `/api/send-quote` sends a branded quotation (ref, GST, valid-until, product
   photos) with an **Accept this quote** button.
3. The button opens `/accept?...`; the customer reviews and clicks **Accept &
   pay**, which calls `/api/accept-quote` (emails the team that they accepted)
   and forwards them to the **Stripe** booking-fee payment.

## Sending quotes via Resend

The tools portal's **Email Quote to Customer** button POSTs quantities to
`api/send-quote.js`, which computes pricing server-side, renders a branded
HTML quote email (logo + product photos hosted in `assets/`) and sends it
through [Resend](https://resend.com) from `support@powersmartco.com.au`.

Environment variables (Vercel → Settings → Environment Variables):

| Name | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | yes | Resend API key (used by all email routes) |
| `SUPABASE_URL` | for pipeline | Supabase project URL (Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | for pipeline | Supabase **service_role** key — server-side only, never in HTML |
| `NOTIFY_EMAIL` | no | Where leads / acceptances / quote copies go, default `support@powersmartco.com.au` |
| `RESEND_FROM_EMAIL` | no | Override sender, default `PowerSmart <support@powersmartco.com.au>` |
| `RESEND_REPLY_TO` | no | Override reply-to, default `support@powersmartco.com.au` |

## Sales pipeline (/tools/pipeline)

GHL-style kanban backed by Supabase. Stages: New Lead, Follow-Up, Shopping
Around, Quote Sent, Won/Installed, Not Reachable, Out of Area.

- Website enquiries land in **New Lead** automatically (`/api/lead` inserts them).
- Sending a quote from /tools moves (or creates) the lead in **Quote Sent**
  with the quote ref + total, and logs a comment.
- A customer accepting their quote logs a "✅ accepted" comment on the lead.
- Drag cards between stages, click a card for details + comments, add leads
  manually, search by name/phone/postcode.
- Access requires the portal passcode `2026`, hardcoded in `api/pipeline.js`
  and `api/send-email.js` (asked once per device).
- Data lives in Supabase with RLS enabled and **no** anon policies — only the
  serverless functions (service_role key) can touch it.

Setup: run `supabase/schema.sql` in the Supabase SQL Editor, then add the
two Supabase env vars in Vercel and redeploy. The portal passcode needs no
env var — it lives in the code.

## Senders, composer & email log

- **Agent**: opening `/tools` asks who's using it — **Mani** or **Vignesh**
  (remembered per device). This tags quotes, composed emails and pipeline notes.
- **Send as**: every quote/email has a *Send as* picker — **Customer Service**,
  **Mani**, or **Vignesh**. It sets the From display name (e.g. "Mani —
  PowerSmart", address stays `support@`) and the signature. Defaults to the
  logged-in agent.
- **Compose Email**: the *Compose Email* button on `/tools` opens a box (To,
  Subject, Message, Send as). The message is wrapped in the branded template
  with the sender's signature and sent via `/api/send-email`.
- **Email log**: every email sent to a customer (quotes + composed) is recorded
  in the Supabase `sent_emails` table. Run `supabase/emails.sql` once to create it.

Optional env var `RESEND_FROM_ADDRESS` overrides the bare send address
(default `support@powersmartco.com.au`); the display name comes from the
selected sender.

Sending only works once `powersmartco.com.au` is **verified** in Resend →
Domains (SPF/DKIM DNS records added at the DNS provider). If sending fails,
the portal falls back to opening a plain mail draft.

## Local preview

Any static file server works, e.g.:

```bash
npx serve .      # then open http://localhost:3000
```
