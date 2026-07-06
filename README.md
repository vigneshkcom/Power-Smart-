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

## Sending quotes via Resend (planned)

The tools portal currently copies SMS text, opens a mail draft, and downloads
a PDF quote. To email quotes directly through [Resend](https://resend.com):

1. A serverless function lives at `api/send-quote.js` and is called by the
   portal (`POST /api/send-quote`) with the quote details.
2. The Resend API key is stored as a Vercel environment variable
   (`RESEND_API_KEY`) — never in the client HTML, so it stays private.
3. Set the verified sending domain/address in the same function.

> The API key and sending address are added later — this section documents
> where they plug in.

## Local preview

Any static file server works, e.g.:

```bash
npx serve .      # then open http://localhost:3000
```
