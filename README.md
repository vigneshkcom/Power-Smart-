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
index.html            Customer-facing landing page (root of the site)
tools/index.html      Staff sales portal — quote calculator, SMS/email/PDF
vercel.json           Clean URLs + redirects (preserves old links)
assets/logo/          PowerSmart logo files (upload via GitHub web UI)
assets/email/         Images for quote emails (upload via GitHub web UI)
api/                  (planned) Vercel serverless functions
archive/              Retired / other-brand files, kept for reference
```

See `assets/README.md` for how to upload media and get its public URL.

## Sending quotes via Resend

The tools portal's **Email Quote to Customer** button POSTs quantities to
`api/send-quote.js`, which computes pricing server-side, renders a branded
HTML quote email (logo + product photos hosted in `assets/`) and sends it
through [Resend](https://resend.com) from `support@powersmartco.com.au`.

Environment variables (Vercel → Settings → Environment Variables):

| Name | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | yes | Resend API key |
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
