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
api/_senders.js       Sender identities (Customer Service/Mani/Sunny) + signature (not a route)
api/_maillog.js       Logs every outbound email to Supabase sent_emails (not a route)
api/send-quote.js     POST /api/send-quote  - emails a customer their quotation
api/send-email.js     POST /api/send-email  — free-form branded email (composer)
api/accept-quote.js   POST /api/accept-quote - notifies staff a quote was accepted
api/lead.js           POST /api/lead         — emails staff a new website lead
api/pipeline.js       GET/POST /api/pipeline — kanban board CRUD (needs portal key)
api/_jobs.js          Job schedule + electricians CRUD, served via /api/pipeline?resource=jobs
api/_dropbox.js       Dropbox job photo storage (folders, upload, thumbnails, links)
api/_tech.js          Electrician app API (code sign-in), served via /api/pipeline?resource=tech
api/sms.js            GET/POST /api/sms — two-way SMS portal API
sms/index.html        Staff SMS inbox and composer (cyan PowerSmart interface)
supabase/sms.sql      Run once — SMS message storage table and indexes
supabase/schema.sql   Run once in Supabase SQL Editor — leads + comments tables
supabase/emails.sql   Run once — sent_emails log table
supabase/jobs.sql     Run once — electricians + jobs tables for the job schedule
supabase/tech-app.sql Run once (after jobs.sql) — unique electrician codes, alarms installed/type, invoice + payment columns
supabase/pipeline-quote-accepted-and-numbering.sql  Run once - quote accepted stage + quote numbers from 7000
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
Follow-Up, Quote Sent, Won/Installed, Not Reachable, Out of Area.

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
service management). Same portal passcode and Mani/Sunny picker as the pipeline.

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
  linked lead; marking a job **Completed** moves the lead to **Won/Installed**.
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

### Job flow (smoke alarms, payment details, sign off)

Run `supabase/tech-job-flow.sql` once (after `tech-app.sql`). In `/tech` a job is now four steps:

1. **Smoke alarms**: tap *Add smoke alarm* for each one (location, battery/hardwired, photo). The invoice alarm lines follow these records.
2. **Invoice** and customer approval.
3. **Payment details**: *Has the customer paid in full?* Yes: card (Stripe), bank transfer or cash. No: a pending invoice is emailed.
4. **Work sign off**: electrician name and signature, then *Complete job*. The customer is emailed a paid tax invoice, or an invoice showing the amount owing (`api/_job-invoice.js`). Compliance certificates are not generated yet; the pending-invoice email says one is sent once paid.

### Job photos (Dropbox)

Electricians add photos in `/tech` (Before / After / Alarms / Other). They are shrunk on the
phone (about 1600px, ~0.5 MB) and stored in Dropbox as
`/PowerSmart Jobs/J1013 - Customer - Address/<Category>/...jpg` (inside the app folder, so the
real path is `Apps/<app name>/PowerSmart Jobs/...`). A job's folder is found again by its
`J<number> - ` prefix, so edits to the customer name or address don't split photos.

- **Gallery**: the *Job photos* section in the /tools/schedule job window, and the *Job photos*
  button on Scheduled/Won leads in the pipeline. Photos are private: the API returns
  thumbnails and 4-hour links, only to people with the portal key (or an electrician's own job).
- **Setup**: create a Dropbox app (Scoped access, App folder, permissions `files.metadata.read`,
  `files.metadata.write`, `files.content.read`, `files.content.write`), run
  `node scripts/dropbox-refresh-token.js <APP_KEY> <APP_SECRET>`, then add
  `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and `DROPBOX_REFRESH_TOKEN` in Vercel and redeploy.
  Without them the photo sections say storage isn't set up and everything else works.
- **Free plan**: 2 GB (a few thousand shrunk photos). Upgrade to Plus when it fills.

## Senders, composer & email log

- **Agent**: opening `/tools` asks who's using it — **Mani** or **Sunny**
  (remembered per device). This tags quotes, composed emails and pipeline notes.
- **Send as**: every quote/email has a *Send as* picker — **Customer Service**,
  **Mani**, or **Sunny**. It sets the From display name (e.g. "Mani —
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


## Automatic quote reminders

Apply `supabase/quote-reminders.sql` and then `supabase/quote-reminder-scheduler.sql`.
The worker starts paused. After deploying and checking `/api/pipeline?resource=reminders`,
activate it with `update public.quote_reminder_worker set active=true where id=true`.
The worker secret is generated in Supabase and never exposed to the browser.
The scheduler invokes the existing pipeline function every ten minutes during Queensland
sending hours; the worker additionally restricts sends to weekdays, 9am�5pm.

Only successfully issued, current, unpaid Quote Sent quotes qualify. Both a valid Australian
mobile and the original quote email address are required. Each quote has at most three rounds
at three-day intervals. Each round records SMS and email separately in `quote_reminder_runs`.
Provider acceptance is shown as Submitted, not delivered. A crashed or uncertain submission
pauses the customer for review, with no automatic retry. Check provider records before
resolving an uncertain channel status; do not reset counters to resend it.

Customer cards expose On/Paused, the next due date, counts and full message history.
Pauses survive new quotes; a new quote resets the three-round count. SMS replies pause both
channels. Email replies arrive at support and require staff to pause the customer.
The email stop link requires a POST confirmation, so link scanners cannot unsubscribe.
Customer unsubscribe cannot be overridden by the staff dropdown.

Rollback-only database checks: `tests/quote-reminders.sql`. Provider-mocked tests:
`node --test tests/quote-reminders.test.js`. No real messages are sent by either test.


## Australian address autofill

Add `GOOGLE_MAPS_BROWSER_KEY` to Vercel Production environment variables and redeploy.
This must be a dedicated public browser key with website restrictions for
`https://portal.powersmartco.com.au/*` and `https://smokealarms.powersmartco.com.au/*`.
Enable Maps JavaScript API and Places API (New), with billing enabled in Google Cloud.
Restrict this key to those two APIs. Do not use a private server key.

The shared `/assets/address-autofill.js` picker is used in the pipeline customer card,
job schedule, PDF quote form and customer acceptance address form. Results are limited
to Australia, with a Brisbane preference. Selecting an address fills the street,
suburb, state and postcode where those fields exist. Unit numbers remain editable.
The public `GET /api/pipeline?resource=address-config` returns only this browser key;
without a key, all manual address fields continue to work. No existing addresses are
changed automatically. The landing-page enquiry asks only for a postcode.

Apply `supabase/remove-shopping-stage.sql` when upgrading an existing database.
It moves any legacy Shopping Around leads to Follow-Up before removing that stage.
