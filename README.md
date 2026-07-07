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
api/_quote.js         Shared pricing + quote-email rendering (not a route)
api/send-quote.js     POST /api/send-quote  — emails a customer their quotation
api/accept-quote.js   POST /api/accept-quote — notifies staff a quote was accepted
api/lead.js           POST /api/lead         — emails staff a new website lead
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
| `RESEND_API_KEY` | yes | Resend API key (used by all three API routes) |
| `NOTIFY_EMAIL` | no | Where leads / acceptances / quote copies go, default `support@powersmartco.com.au` |
| `RESEND_FROM_EMAIL` | no | Override sender, default `PowerSmart <support@powersmartco.com.au>` |
| `RESEND_REPLY_TO` | no | Override reply-to, default `support@powersmartco.com.au` |

Sending only works once `powersmartco.com.au` is **verified** in Resend →
Domains (SPF/DKIM DNS records added at the DNS provider). If sending fails,
the portal falls back to opening a plain mail draft.

## Local preview

Any static file server works, e.g.:

```bash
npx serve .      # then open http://localhost:3000
```
