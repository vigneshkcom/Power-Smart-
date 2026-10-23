# PowerSmart — QLD Smoke Alarms

Static site deployed on Vercel (production branch: `main`).

## Live links

| Purpose | URL | Source file |
|---|---|---|
| **Customer landing page** (public, for ads/marketing) | `https://smokealarms.powersmartco.com.au/` | `index.html` |
| **Staff quote tool** (internal — build & send quotes) | `https://smokealarms.powersmartco.com.au/tools` | `tools/index.html` |
| **SMS portal** (internal) | `https://smokealarms.powersmartco.com.au/sms` | `sms/index.html` |

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
tools/schedule.html   Fieldworker job schedule (/tools/schedule) — assign jobs to electricians
tech.html             Electrician phone app (/tech) — jobs, alarms installed, invoice, card payment
api/_quote.js         Shared pricing + quote-email rendering (not a route)
api/_supabase.js      Server-side Supabase REST helper (not a route)
api/_senders.js       Sender identities (Customer Service/Mani/Vignesh) + signature (not a route)
api/_maillog.js       Logs every outbound email to Supabase sent_emails (not a route)
api/send-quote.js     POST /api/send-quote  - emails a customer their quotation
api/send-email.js     POST /api/send-email  — free-form branded email (composer)
api/accept-quote.js   POST /api/accept-quote - notifies staff a quote was accepted
api/lead.js           POST /api/lead         — emails staff a new website lead
api/pipeline.js       GET/POST /api/pipeline — kanban board CRUD (needs portal key)
api/_jobs.js          Job schedule + electricians CRUD, served via /api/pipeline?resource=jobs
api/_tech.js          Electrician app API (code sign-in), served via /api/pipeline?resource=tech
api/sms.js            GET/POST /api/sms — two-way SMS portal API
sms/index.html        Staff SMS inbox and composer (cyan PowerSmart interface)
supabase/sms.sql      Run once — SMS message storage table and indexes
supabase/schema.sql   Run once in Supabase SQL Editor — leads + comments tables
supabase/emails.sql   Run once — sent_emails log table
supabase/jobs.sql     Run once — electricians + jobs tables for the job schedule
supabase/tech-app.sql Run once (after jobs.sql) — unique electrician codes, alarms installed/type, invoice + payment columns
supabase/pipeline-quote-accepted-and-numbering.sql  Run once - quote accepted stage + quote numbers from 7000
supabase/stage-assigned.sql Run once — adds the Job Assigned pipeline stage
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
| `SMSGATE_USERNAME` | for SMS | SMS Gate Cloud Server username from the gateway phone |
| `SMSGATE_PASSWORD` | for SMS | SMS Gate Cloud Server password from the gateway phone |
| `SMSGATE_DEVICE_ID` | for SMS | SMS Gate device ID from the gateway phone |

## Sales pipeline (/tools/pipeline)

GHL-style kanban backed by Supabase. Stages: New Lead, Quote Accepted,
Follow-Up, Shopping Around, Quote Sent, Job Assigned, Installed, Not Reachable, Out of Area.
(Installed is stored as `won`.) Job Assigned and Installed follow the job schedule automatically.

- Website enquiries land in **New Lead** automatically (`/api/lead` inserts them).
- Sending a quote from /tools moves (or creates) the lead in **Quote Sent**
  with the quote ref + total, and logs a comment.
- A customer accepting their quote moves the lead directly to Quote Accepted and logs a comment.
- Before sending the next quote, run `supabase/pipeline-quote-accepted-and-numbering.sql` once to create the Quote Accepted database stage and quote numbers beginning at 7000.
- Drag cards between stages, click a card for details + comments, add leads
  manually, search by name/phone/postcode.
- Access requires the portal passcode `2026`, hardcoded in `api/pipeline.js`
  and `api/send-email.js` (asked once per device).
- Data lives in Supabase with RLS enabled and **no** anon policies — only the
  serverless functions (service_role key) can touch it.

Setup: run `supabase/schema.sql` in the Supabase SQL Editor, then add the
two Supabase env vars in Vercel and redeploy. The portal passcode needs no
env var — it lives in the code.

## Job schedule (/tools/schedule)

Dispatch board for assigning smoke alarm jobs to electricians (phase 1 of field
service management). Same portal passcode and Mani/Vignesh picker as the pipeline.

- **Day view**: one row per electrician on an hourly timeline (07:00–24:00), job
  blocks coloured by status (scheduled, en route, on site, completed, cancelled)
  and a red line at the current time.
- **3 Days / Week**: one column per day with readable job cards.
- **Book**: click an empty slot (pre-fills electrician + time) or *New job*. Pick a
  lead from the sales pipeline to fill in the customer and address automatically.
  The pipeline's lead card has a **Schedule job** button that does the same.
- **Reschedule**: drag a job to another electrician/time/day. Jobs without an
  electrician sit in the **waiting list**; drag them onto a row to assign.
- **Job card**: customer, address, alarms, notes, status, *Navigate* (Google Maps)
  and *Call customer*. The yellow route button opens that electrician's stops
  for the visible range in Google Maps.
- **Pipeline sync**: creating, rescheduling or changing status logs a note on the
  linked lead. Assigning the job to an electrician moves the lead to **Job Assigned**;
  completing it moves the lead to **Installed**; taking it off the schedule (waiting
  list, cancelled or deleted) moves a Job Assigned lead back to **Quote Accepted**.
- **Electricians**: add, edit and deactivate fieldworkers from the *Electricians* button.
- **Report**: completed jobs for This week / Last week / This month / Last month or any
  dates, optionally one electrician. Per-electrician totals (jobs, battery and hardwired
  alarms, controllers, inspections, invoiced, paid by card, to collect) — use it to pay
  electricians — plus every job. *Download Excel* gives a two-sheet workbook. Jobs count
  by completion date (weeks run Monday–Sunday).

Setup: run `supabase/jobs.sql` once in the Supabase SQL Editor (after `schema.sql`).

## Electrician app (/tech)

Phone web app for electricians on site — `portal.powersmartco.com.au/tech`.

- **Sign in**: the electrician types their code (e.g. 1011) from
  /tools/schedule → *Electricians*; codes are unique. Each electrician only sees
  their own jobs. Use hard-to-guess codes — anyone with a code can open that
  electrician's jobs.
- **My jobs**: today's schedule, ‹ › to change day, and a **Calendar** button (month
  view with job counts per day). An empty day shows the next booked job.
  *Navigate*, *Call*, *On my way* / *Arrived on site* update the board and the lead.
- **Alarms installed**: separate counts for **battery** and **hardwired** alarms (a job
  can be a mix); each is its own invoice line. The quoted count is shown as a guide.
- **Invoice**: the electrician can also add remote controllers, an inspection or an
  "other" item. Prices come
  from `api/_quote.js` on the server. Advance payments other than the booking fee
  (e.g. a prepaid inspection) are deducted.
- **Approval + payment**: the customer approves the invoice on the phone, then
  *Take card payment* opens Stripe Checkout for the amount due and returns to the
  app. The job is marked paid by the app's check or the Stripe webhook
  (`metadata.job_id`). *Customer pays later* completes the job with the balance
  flagged for the office.
- **Complete**: job → Completed, lead → Won, and a note with the alarms installed,
  invoice and payment is added to the lead. The office sees the electrician's
  report on the job card in /tools/schedule.
- **Edit job**: a completed job can be reopened from the app to correct it and be
  completed again (logged on the lead). A card-paid invoice stays locked.

Setup: run `supabase/tech-app.sql` once, then give each electrician their code.

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
