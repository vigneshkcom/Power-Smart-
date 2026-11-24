// Online invoice for a completed job: /invoice?token=<job id> (&pdf=1 downloads it as a PDF). Shows the invoice, and while a balance is owing
// offers "Pay by card" (a fresh Stripe Checkout, so the emailed link never expires) and the bank transfer details.
// A card payment is recorded by the Stripe webhook (api/_tech.js reconcileJobPayment), which also releases the certificate.
const Q = require("./_quote");
const SB = require("./_supabase");
const Stripe = require("./_stripe");
const { checkoutUrl } = require("./_payments");
const { BANK, billingAddressFor, separateFeeFor } = require("./_job-invoice");
const { renderInvoicePdf, itemLines } = require("./_invoice-pdf");

const esc = Q.escapeHtml, fmt = (cents) => Q.fmt(cents / 100);
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// One tiny inline script (the Print button). CSP allows only this exact script, by hash.
const PRINT_JS = "document.getElementById('print-btn').addEventListener('click',function(){window.print()})";
const PRINT_HASH = "'sha256-" + require("crypto").createHash("sha256").update(PRINT_JS).digest("base64") + "'";
const CSP = `default-src 'none'; script-src ${PRINT_HASH}; img-src https://smokealarms.powersmartco.com.au https://portal.powersmartco.com.au data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;

// Everything the page and the PDF show, from the job row. fee = call-out fee paid when booking (its own line, already paid).
function model(job, billingAddress, fee) {
  fee = fee > 0 ? fee : 0;
  const raw = Array.isArray(job.invoice_items) ? job.invoice_items : [];
  const total = job.invoice_total_cents || raw.reduce((n, i) => n + (i.amount_cents || 0), 0);
  const items = itemLines(raw).concat(fee ? [{ label: "Electrician call-out fee", qty: 1, unit_cents: fee, amount_cents: fee }] : []);
  const owing = job.pay_status === "later" ? Math.max(0, job.amount_due_cents || 0) : 0;
  const credit = Math.max(0, total - (job.amount_due_cents == null ? total : job.amount_due_cents));
  const paid = job.pay_status === "paid" || job.pay_status === "none";
  const grand = total + fee;
  const payAmt = paid ? grand - fee - credit : 0;   // what the customer paid on top of the advance payments
  const payWord = { card: "card", cash: "cash", bank_transfer: "bank transfer" }[job.pay_method];
  const payments = [];
  if (fee) payments.push({ label: "Paid: electrician call-out fee (when booked)", cents: fee });
  if (credit) payments.push({ label: "Paid in advance", cents: credit });
  if (payAmt > 0) payments.push({ label: "Paid" + (payWord ? " by " + payWord : ""), cents: payAmt });
  const me = `${Q.SITE}/invoice?token=${encodeURIComponent(job.id)}`;
  return {
    number: "J" + job.job_no, date: Q.fmtDate(new Date(job.completed_at || Date.now())), paid, customer: job.customer_name || "",
    billTo: billingAddress || "", property: [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", "), email: job.email || "",
    items, total_cents: grand, gst_cents: Math.round(grand / 11), payments, owing_cents: owing,
    bank: owing > 0 ? BANK : null, payUrl: owing > 0 ? `${me}&pay=1` : "", url: me,
  };
}

const CSS = `*{box-sizing:border-box}body{margin:0;background:#EAF2F3;font-family:Arial,Helvetica,sans-serif;color:#41585D;-webkit-font-smoothing:antialiased}
.w{max-width:820px;margin:0 auto;padding:20px 16px 48px}
.bar{display:flex;justify-content:flex-end;gap:10px;margin:0 0 14px;flex-wrap:wrap}
.b1,.b2{display:inline-flex;align-items:center;gap:8px;font:bold 13px Arial,Helvetica,sans-serif;padding:10px 18px;border-radius:999px;cursor:pointer;text-decoration:none}
.b1{background:#0B1B1F;color:#fff;border:1px solid #0B1B1F}.b2{background:#fff;color:#1E5F6B;border:1px solid #43A8B6}
.b1 svg,.b2 svg{width:16px;height:16px}
.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(11,27,31,.06),0 8px 28px rgba(11,27,31,.06)}
.strip{height:6px;background:#2A8D9E}
.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:28px 36px 8px}
.hd img{width:200px;max-width:46%;height:auto;display:block}
.ttl{text-align:right}.ttl h1{margin:0;font-size:26px;letter-spacing:1.5px;color:#0B1B1F}
.pill{display:inline-block;margin-top:8px;font-size:11px;font-weight:bold;letter-spacing:1px;color:#fff;padding:4px 10px;border-radius:4px}
.pill.ok{background:#32925D}.pill.due{background:#B3261E}
.meta{margin:12px 0 0;font-size:12.5px;border-collapse:collapse;margin-left:auto}.meta td{padding:2px 0 2px 14px;text-align:right}.meta td:first-child{color:#8AA0A5}.meta td:last-child{color:#0B1B1F;font-weight:bold}
.bd{padding:18px 36px 8px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.pn{background:#F4F9FA;border:1px solid #DCE8EA;border-left:3px solid #2A8D9E;border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.55}
.lb{display:block;font-size:10.5px;font-weight:bold;letter-spacing:1.2px;color:#2E8494;text-transform:uppercase;margin-bottom:6px}
.pn strong{color:#0B1B1F;font-size:14.5px}
.sum{display:grid;grid-template-columns:1.3fr 1fr 1fr;background:#0B1B1F;color:#fff;border-radius:8px;margin:16px 0 22px}
.sum div{padding:13px 16px}.sum div+div{border-left:1px solid #2F4448}.sum .lb{color:#99D1DB;margin-bottom:4px}.sum b{font-size:19px}.sum span{font-size:13px;line-height:1.4}
table.it{width:100%;border-collapse:collapse;font-size:14px}
.it th{background:#2A8D9E;color:#fff;font-size:11px;letter-spacing:.8px;text-transform:uppercase;text-align:left;padding:10px 12px}
.it td{padding:12px;border-bottom:1px solid #E5EEEF;color:#0B1B1F;vertical-align:top}.it tr:nth-child(even) td{background:#F8FBFB}
.c{text-align:center}.r{text-align:right;white-space:nowrap}
.tw{display:flex;justify-content:flex-end;margin:18px 0 6px}
table.tot{width:340px;max-width:100%;border-collapse:collapse;font-size:14px}.tot td{padding:6px 12px}.tot .r{color:#0B1B1F}
.tot .sep td{border-top:1px solid #DCE8EA;font-weight:bold;color:#0B1B1F;padding-top:10px}
.tot .pd td{color:#32925D}.tot .bal td{background:#0B1B1F;color:#fff;font-weight:bold;font-size:15.5px;padding:12px}.tot .bal.ok td{background:#32925D}
.ok-note{background:#E8F5EE;color:#256B45;padding:12px 14px;border-radius:10px;font-weight:bold;font-size:14px;margin:0 0 16px}
.box{margin:22px 0 8px;background:#F4F9FA;border:1px solid #DCE8EA;border-left:3px solid #2A8D9E;border-radius:8px;padding:18px 20px}
.box h2{margin:0 0 12px;font-size:17px;color:#0B1B1F}
.pay{display:block;text-align:center;background:#43A8B6;color:#0B1B1F;font-weight:bold;text-decoration:none;padding:14px;border-radius:999px;font-size:16px;max-width:360px}
.or{margin:16px 0 6px;font-size:13px;font-weight:bold}.bank{border-collapse:collapse;font-size:14px}.bank td{padding:3px 18px 3px 0}
.note{font-size:12px;color:#6B8288;margin:12px 0 0}
.thx{margin:22px 0 6px;font-size:13px;color:#6B8288}.thx strong{color:#0B1B1F;display:block;font-size:14px;margin-bottom:2px}
.ft{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:12px;color:#6B8288;padding:16px 36px 22px;border-top:1px solid #E5EEEF;margin-top:18px}.ft a{color:#398EA0}
@media (max-width:600px){.hd{flex-direction:column;padding:22px 20px 4px}.hd img{max-width:70%}.ttl{text-align:left}.meta{margin-left:0}.meta td{text-align:left;padding:2px 14px 2px 0}
.bd{padding:14px 20px 6px}.panels{grid-template-columns:1fr}.sum{grid-template-columns:1fr 1fr}.sum div:first-child{grid-column:1/-1}.sum div:nth-child(2){border-left:none}.sum div:first-child{border-bottom:1px solid #2F4448}
.it .u{display:none}.it td,.it th{padding:10px 8px}.ft{padding:14px 20px 20px}}
@media print{body{background:#fff}.w{padding:0;max-width:none}.card{border-radius:0;box-shadow:none}.bar,.pay,.or-card{display:none}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
const ICON_DL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16"/></svg>`;
const ICON_PR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z"/></svg>`;

function page(job, thanks, billingAddress, fee) {
  const m = model(job, billingAddress, fee);
  const owing = m.owing_cents;
  const rows = m.items.map((i) => `<tr><td>${esc(i.label)}</td><td class="c">${esc(i.qty)}</td><td class="r u">${i.unit_cents == null ? "" : fmt(i.unit_cents)}</td><td class="r">${fmt(i.amount_cents)}</td></tr>`).join("");
  const banner = !m.paid && thanks ? `<div class="ok-note">Thanks! We're confirming your card payment. Your compliance certificate is emailed as soon as it's received.</div>` : "";
  const pay = owing > 0 && !thanks ? `<div class="box"><h2>How to pay ${fmt(owing)}</h2>
    <a class="pay" href="${m.url}&amp;pay=1">Pay ${fmt(owing)} by card</a>
    <p class="or">Or pay by bank transfer</p>
    <table class="bank"><tr><td>Account name</td><td><strong>${esc(BANK.name)}</strong></td></tr><tr><td>BSB</td><td><strong>${BANK.bsb}</strong></td></tr><tr><td>Account number</td><td><strong>${BANK.account}</strong></td></tr><tr><td>Reference</td><td><strong>${esc(m.number)}</strong></td></tr></table>
    <p class="note">Your compliance certificate is emailed as soon as full payment is received.</p></div>` : "";
  const thx = m.paid ? `<div class="thx"><strong>Thank you for choosing PowerSmart.</strong>This invoice has been paid in full. Please keep it for your records.</div>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Tax invoice ${esc(m.number)} - PowerSmart</title>
<style>${CSS}</style></head><body><div class="w">
<div class="bar"><a class="b1" href="${m.url}&amp;pdf=1" download="${esc(pdfName(job))}">${ICON_DL}Download PDF</a><button type="button" class="b2" id="print-btn">${ICON_PR}Print</button></div>
<div class="card"><div class="strip"></div>
<div class="hd"><img src="${Q.SITE}/assets/logo/power-smart-logo-full-colour.png" alt="Power Smart Co"><div class="ttl"><h1>TAX INVOICE</h1><span class="pill ${m.paid ? "ok" : "due"}">${m.paid ? "PAID" : "PAYMENT DUE"}</span>
<table class="meta"><tr><td>Invoice number</td><td>${esc(m.number)}</td></tr><tr><td>Invoice date</td><td>${esc(m.date)}</td></tr><tr><td>ABN</td><td>${Q.ABN}</td></tr></table></div></div>
<div class="bd">${banner}
<div class="panels"><div class="pn"><span class="lb">From</span><strong>PowerSmart Pty Ltd</strong><br>ABN ${Q.ABN}<br><a href="tel:${Q.PHONE_TEL}" style="color:inherit">${Q.PHONE_DISPLAY}</a><br>${esc(Q.SUPPORT_EMAIL)}</div>
<div class="pn"><span class="lb">Bill to</span><strong>${esc(m.customer || "Customer")}</strong>${m.billTo || m.property ? `<br>${esc(m.billTo || m.property)}` : ""}${m.email ? `<br>${esc(m.email)}` : ""}</div></div>
<div class="sum"><div><span class="lb">Service address</span><span>${esc(m.property || "-")}</span></div><div><span class="lb">Total (inc GST)</span><b>${fmt(m.total_cents)}</b></div><div><span class="lb">${m.paid ? "Balance due" : "Amount due"}</span><b>${fmt(owing)}</b></div></div>
<table class="it"><tr><th>Description</th><th class="c">Qty</th><th class="r u">Unit price</th><th class="r">Amount</th></tr>${rows}</table>
<div class="tw"><table class="tot"><tr><td>Subtotal (ex GST)</td><td class="r">${fmt(m.total_cents - m.gst_cents)}</td></tr><tr><td>GST (10%)</td><td class="r">${fmt(m.gst_cents)}</td></tr>
<tr class="sep"><td>Total (inc GST)</td><td class="r">${fmt(m.total_cents)}</td></tr>
${m.payments.map((p) => `<tr class="pd"><td>${esc(p.label)}</td><td class="r">-${fmt(p.cents)}</td></tr>`).join("")}
<tr class="bal${m.paid ? " ok" : ""}"><td>${m.paid ? "Balance due &middot; Paid in full" : "Amount due"}</td><td class="r">${fmt(owing)}</td></tr></table></div>
${pay}${thx}</div>
<div class="ft"><span><strong>PowerSmart Pty Ltd</strong> &middot; ABN ${Q.ABN}</span><span>Questions? Call <a href="tel:${Q.PHONE_TEL}">${Q.PHONE_DISPLAY}</a> &middot; ${esc(Q.SUPPORT_EMAIL)}</span></div></div></div><script>${PRINT_JS}</script></body></html>`;
}
const pdfName = (job) => `PowerSmart-Tax-Invoice-J${String(job.job_no).replace(/[^\w-]/g, "")}.pdf`;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex, nofollow"); res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).send("Method not allowed"); }
  const token = String(req.query.token || "");
  const notFound = () => res.status(404).send("Invoice not found. Please contact PowerSmart on 0475 184 984.");
  if (!UUID.test(token)) return notFound();
  try {
    const job = (await SB.sb(`jobs?id=eq.${token}&select=id,job_no,customer_name,address,suburb,postcode,email,lead_id,status,pay_status,amount_due_cents,invoice_items,invoice_total_cents,completed_at,certificate_sent_at,pay_method,work_type,compliance_outcome,inspection_converted_at&limit=1`))?.[0];
    if (!job || job.status !== "completed") return notFound();
    if (String(req.query.pay || "") === "1" && job.pay_status === "later" && job.amount_due_cents > 0 && Stripe.configured()) {
      const base = `${Q.SITE}/invoice?token=${job.id}`;
      const session = await Stripe.request("/checkout/sessions", {
        mode: "payment", "payment_method_types[0]": "card", ...(job.email ? { customer_email: job.email } : {}),
        success_url: `${base}&thanks=1`, cancel_url: base, client_reference_id: job.id,
        "line_items[0][price_data][currency]": "aud", "line_items[0][price_data][unit_amount]": String(job.amount_due_cents),
        "line_items[0][price_data][product_data][name]": `PowerSmart invoice J${job.job_no} - smoke alarms`, "line_items[0][quantity]": "1",
        "metadata[job_id]": job.id, "metadata[job_no]": String(job.job_no), "metadata[payment_type]": "job",
        "payment_intent_data[metadata][job_id]": job.id, "payment_intent_data[metadata][payment_type]": "job",
      });
      res.setHeader("Location", checkoutUrl(session.url)); return res.status(302).end();
    }
    const [billing, fee] = await Promise.all([billingAddressFor(job), (job.work_type === "inspection" || job.inspection_converted_at ? Promise.resolve(0) : separateFeeFor(job.lead_id))]);
    if (String(req.query.pdf || "") === "1") {
      const pdf = await renderInvoicePdf(model(job, billing, fee));
      res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${pdfName(job)}"`);
      return res.status(200).send(pdf);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Content-Security-Policy", CSP);
    return res.status(200).send(page(job, String(req.query.thanks || "") === "1", billing, fee));
  } catch (e) { console.error("invoice page failed:", e.message); return res.status(503).send("Your invoice is temporarily unavailable. Please try again or call PowerSmart on 0475 184 984."); }
};
module.exports.page = page;
module.exports.model = model;

