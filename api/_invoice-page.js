// Online invoice for a completed job: /invoice?token=<job id>. Shows the invoice, and while a balance is owing
// offers "Pay by card" (a fresh Stripe Checkout, so the emailed link never expires) and the bank transfer details.
// A card payment is recorded by the Stripe webhook (api/_tech.js reconcileJobPayment), which also releases the certificate.
const Q = require("./_quote");
const SB = require("./_supabase");
const Stripe = require("./_stripe");
const { checkoutUrl } = require("./_payments");
const { BANK } = require("./_job-invoice");

const esc = Q.escapeHtml, fmt = (cents) => Q.fmt(cents / 100);
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const CSP = "default-src 'none'; img-src https://smokealarms.powersmartco.com.au https://portal.powersmartco.com.au data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function page(job, thanks) {
  const items = Array.isArray(job.invoice_items) ? job.invoice_items : [];
  const total = job.invoice_total_cents || items.reduce((n, i) => n + (i.amount_cents || 0), 0);
  const owing = job.pay_status === "later" ? Math.max(0, job.amount_due_cents || 0) : 0;
  const credit = Math.max(0, total - (job.amount_due_cents == null ? total : job.amount_due_cents));
  const paid = job.pay_status === "paid" || job.pay_status === "none";
  const me = `${Q.SITE}/invoice?token=${encodeURIComponent(job.id)}`;
  const address = [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const rows = items.map((i) => `<tr><td>${esc(i.label)}</td><td class="c">${esc(i.qty)}</td><td class="r">${fmt(i.amount_cents || 0)}</td></tr>`).join("");
  const banner = paid
    ? `<div class="ok">Paid in full. Thank you!${job.certificate_sent_at ? " Your compliance certificate has been emailed to you." : " Your compliance certificate is emailed once payment is confirmed."}</div>`
    : thanks ? `<div class="ok">Thanks! We're confirming your card payment. Your compliance certificate is emailed as soon as it's received.</div>` : "";
  const pay = owing > 0 && !thanks ? `<div class="box"><h2>Pay ${fmt(owing)}</h2>
    <a class="btn" href="${me}&amp;pay=1">Pay ${fmt(owing)} by card</a>
    <p class="or">Or pay by bank transfer</p>
    <table class="bank"><tr><td>Account name</td><td><strong>${esc(BANK.name)}</strong></td></tr><tr><td>BSB</td><td><strong>${BANK.bsb}</strong></td></tr><tr><td>Account number</td><td><strong>${BANK.account}</strong></td></tr><tr><td>Reference</td><td><strong>J${esc(job.job_no)}</strong></td></tr></table>
    <p class="note">Your compliance certificate is emailed as soon as full payment is received.</p></div>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Invoice J${esc(job.job_no)} - PowerSmart</title>
<style>body{margin:0;background:#EAF2F3;font-family:Arial,Helvetica,sans-serif;color:#41585D}.w{max-width:620px;margin:0 auto;padding:18px 12px 40px}.card{background:#fff;border-radius:14px;overflow:hidden}
.hd{padding:22px 26px;border-bottom:3px solid #43A8B6;display:flex;justify-content:space-between;align-items:center;gap:12px}.hd img{width:170px;max-width:45%;height:auto}.hd b{display:block;text-align:right;color:#0B1B1F;letter-spacing:1px}.hd span{font-size:12px;color:#6B8288}
.bd{padding:20px 26px}table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:10.5px;letter-spacing:1px;color:#8AA0A5;text-transform:uppercase;text-align:left;padding:0 8px 8px}td{padding:8px;border-bottom:1px solid #E5EEEF}.c{text-align:center}.r{text-align:right}
.tot td{border:none;font-weight:bold;color:#0B1B1F}.sub td{border:none;color:#8AA0A5;font-size:12px;padding-top:0}.due td{background:#F4F9FA;font-weight:bold;color:#0B1B1F}
.ok{background:#E8F5EE;color:#256B45;padding:12px 14px;border-radius:10px;font-weight:bold;font-size:14px;margin:0 0 16px}.box{margin-top:20px;background:#F4F9FA;border-radius:12px;padding:18px}.box h2{margin:0 0 12px;font-size:18px;color:#0B1B1F}
.btn{display:block;text-align:center;background:#43A8B6;color:#0B1B1F;font-weight:bold;text-decoration:none;padding:14px;border-radius:999px;font-size:16px}.or{margin:16px 0 6px;font-size:13px;font-weight:bold}.bank td{border:none;padding:3px 0;font-size:14px}.note{font-size:12px;color:#6B8288;margin:12px 0 0}
.ft{text-align:center;font-size:12px;color:#6B8288;padding:16px 26px 22px;border-top:1px solid #E5EEEF}</style></head><body><div class="w"><div class="card">
<div class="hd"><img src="${Q.SITE}/assets/logo/power-smart-logo-full-colour.png" alt="Power Smart Co"><div><b>${paid ? "TAX INVOICE (PAID)" : "INVOICE"}</b><span>J${esc(job.job_no)} &middot; ${esc(Q.fmtDate(new Date(job.completed_at || Date.now())))}</span></div></div>
<div class="bd">${banner}<p style="margin:0 0 14px;font-size:14px;">${esc(job.customer_name || "")}${address ? `<br><span style="color:#6B8288;font-size:12px;">${esc(address)}</span>` : ""}</p>
<table><tr><th>Description</th><th class="c">Qty</th><th class="r">Amount</th></tr>${rows}
<tr class="tot"><td colspan="2">Total (incl. GST)</td><td class="r">${fmt(total)}</td></tr><tr class="sub"><td colspan="2">Includes GST of ${fmt(Math.round(total / 11))}</td><td></td></tr>
${credit ? `<tr class="sub"><td colspan="2">Less paid in advance</td><td class="r">-${fmt(credit)}</td></tr>` : ""}
<tr class="due"><td colspan="2">Balance owing</td><td class="r" style="color:${owing ? "#B3261E" : "#32925d"}">${fmt(owing)}</td></tr></table>${pay}</div>
<div class="ft"><strong>PowerSmart Pty Ltd</strong> &middot; ABN ${Q.ABN}<br>Questions? Call <a href="tel:${Q.PHONE_TEL}" style="color:#398ea0">${Q.PHONE_DISPLAY}</a></div></div></div></body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex, nofollow"); res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).send("Method not allowed"); }
  const token = String(req.query.token || "");
  const notFound = () => res.status(404).send("Invoice not found. Please contact PowerSmart on 0401 991 420.");
  if (!UUID.test(token)) return notFound();
  try {
    const job = (await SB.sb(`jobs?id=eq.${token}&select=id,job_no,customer_name,address,suburb,postcode,email,lead_id,status,pay_status,amount_due_cents,invoice_items,invoice_total_cents,completed_at,certificate_sent_at&limit=1`))?.[0];
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
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Content-Security-Policy", CSP);
    return res.status(200).send(page(job, String(req.query.thanks || "") === "1"));
  } catch (e) { console.error("invoice page failed:", e.message); return res.status(503).send("Your invoice is temporarily unavailable. Please try again or call PowerSmart on 0401 991 420."); }
};
module.exports.page = page;
