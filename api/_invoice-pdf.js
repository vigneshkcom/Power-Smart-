// A4 tax invoice PDF. Used by the online invoice's "Download PDF" button (api/_invoice-page.js) and for the
// paid invoice copy filed to Dropbox when the invoice email is sent (api/_job-invoice.js).
// Layout: logo + title, from / bill-to panels, summary strip, item lines, GST totals with payments, then how to pay.
const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const Q = require("./_quote");

const DIR = path.join(__dirname, "_cert-assets");
const W = 595.28, H = 841.89, M = 42, R = W - M;
const INK = rgb(0.043, 0.106, 0.122), BODY = rgb(0.255, 0.345, 0.365), MUTED = rgb(0.54, 0.63, 0.65);
const TEAL = rgb(0.165, 0.553, 0.62), TEAL_DEEP = rgb(0.18, 0.518, 0.58), PALE = rgb(0.957, 0.976, 0.98), LINE = rgb(0.86, 0.91, 0.92), WHITE = rgb(1, 1, 1);
const GREEN = rgb(0.196, 0.573, 0.365), RED = rgb(0.702, 0.149, 0.118);
const METHODS = { card: "card", bank_transfer: "bank transfer", cash: "cash" };
const money = (cents) => (cents < 0 ? "-" : "") + Q.fmt(Math.abs(Number(cents || 0)) / 100);
const asset = (name) => { try { return fs.readFileSync(path.join(DIR, name)); } catch (_) { return null; } };

// model: { number, date, paid, customer, billTo, property, email, items: [{ label, qty, unit_cents, amount_cents }],
//          total_cents, gst_cents, payments: [{ label, cents }], owing_cents, bank: { name, bsb, account } | null, payUrl }
async function renderInvoicePdf(model) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Tax invoice ${model.number}`); doc.setAuthor("PowerSmart Pty Ltd"); doc.setSubject(`PowerSmart tax invoice ${model.number}`);
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontBytes = asset("poppins-600.ttf"), logoBytes = asset("powersmart-logo.png");
  const display = fontBytes ? await doc.embedFont(fontBytes) : bold;
  const logo = logoBytes ? await doc.embedPng(logoBytes) : null;
  const ok = new Set(reg.getCharacterSet());
  const clean = (s) => Array.from(String(s == null ? "" : s)).map((c) => (ok.has(c.codePointAt(0)) ? c : c === "–" || c === "—" ? "-" : "?")).join("");
  let page, y;

  const text = (s, x, yy, { font = reg, size = 9.5, color = BODY, align = "left" } = {}) => {
    const t = clean(s), w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === "right" ? x - w : align === "center" ? x - w / 2 : x, y: yy, font, size, color });
    return w;
  };
  const wrap = (s, font, size, max) => {   // split into lines that fit a column; long words are broken
    const out = []; let line = "";
    for (let word of clean(s).replace(/\s+/g, " ").trim().split(" ")) {
      if (!word) continue;
      while (font.widthOfTextAtSize(word, size) > max) {
        if (line) { out.push(line); line = ""; }
        let n = 1; while (n < word.length && font.widthOfTextAtSize(word.slice(0, n + 1), size) <= max) n++;
        out.push(word.slice(0, n)); word = word.slice(n);
      }
      const next = line ? line + " " + word : word;
      if (line && font.widthOfTextAtSize(next, size) > max) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };
  const label = (s, x, yy, color = TEAL_DEEP) => text(String(s).toUpperCase(), x, yy, { font: bold, size: 7.2, color });
  const drawLogo = (x, top, width) => {
    if (logo) { const h = width * logo.height / logo.width; page.drawImage(logo, { x, y: top - h, width, height: h }); return h; }
    text("PowerSmart", x, top - 18, { font: display, size: 18, color: INK }); return 22;
  };

  function newPage(first) {
    page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: TEAL });
    if (first) return;
    drawLogo(M, H - 30, 110);
    text(`Tax invoice ${model.number}  -  continued`, R, H - 44, { font: bold, size: 9, color: INK, align: "right" });
    y = H - 78;
  }
  const ensure = (h, onBreak) => { if (y - h < 70) { newPage(false); if (onBreak) onBreak(); } };

  // ---- header
  newPage(true);
  drawLogo(M, H - 40, 178);
  text("TAX INVOICE", R, H - 60, { font: display, size: 24, color: INK, align: "right" });
  // status pill
  const pill = model.paid ? "PAID" : "PAYMENT DUE", pc = model.paid ? GREEN : RED;
  const pw = bold.widthOfTextAtSize(pill, 8) + 18;
  page.drawRectangle({ x: R - pw, y: H - 84, width: pw, height: 15, color: pc });
  text(pill, R - pw / 2, H - 79, { font: bold, size: 8, color: WHITE, align: "center" });
  const meta = [["Invoice number", model.number], ["Invoice date", model.date], ["ABN", Q.ABN]];
  meta.forEach(([k, v], i) => {
    const yy = H - 104 - i * 14;
    text(k, R - 110, yy, { size: 8.5, color: MUTED, align: "right" });
    text(v, R, yy, { font: bold, size: 8.5, color: INK, align: "right" });
  });

  // ---- from / bill to panels
  y = H - 160;
  const half = (R - M - 14) / 2, ph = 92;
  const panel = (x, title, name, rows) => {
    page.drawRectangle({ x, y: y - ph, width: half, height: ph, color: PALE, borderColor: LINE, borderWidth: 0.8 });
    page.drawRectangle({ x, y: y - ph, width: 3, height: ph, color: TEAL });
    label(title, x + 14, y - 16);
    text(wrap(name, bold, 11, half - 28)[0], x + 14, y - 32, { font: bold, size: 11, color: INK });
    rows.filter(Boolean).flatMap((r) => wrap(r, reg, 8.6, half - 28)).slice(0, 5).forEach((r, i) => text(r, x + 14, y - 46 - i * 10.5, { size: 8.6 }));
  };
  panel(M, "From", "PowerSmart Pty Ltd", [`ABN ${Q.ABN}`, Q.PHONE_DISPLAY, Q.SUPPORT_EMAIL, Q.SITE.replace(/^https?:\/\//, "")]);
  panel(M + half + 14, "Bill to", model.customer || "Customer", [model.billTo || model.property, model.email]);
  y -= ph + 16;

  // ---- summary strip
  const sh = 46, cw = (R - M) / 3;
  page.drawRectangle({ x: M, y: y - sh, width: R - M, height: sh, color: INK });
  const strip = [["Service address", model.property || "-"], ["Total (inc GST)", money(model.total_cents)], [model.paid ? "Balance due" : "Amount due", money(model.owing_cents)]];
  strip.forEach(([k, v], i) => {
    const x = M + i * cw + 14, big = i > 0;
    label(k, x, y - 16, rgb(0.6, 0.82, 0.86));
    const font = big ? display : bold, size = big ? 15 : 9;
    const lines = big ? [clean(v)] : wrap(v, font, size, cw - 24).slice(0, 2);
    lines.forEach((t, n) => text(t, x, y - (big ? 35 : 29 + n * 10.5), { font, size, color: WHITE }));
    if (i) page.drawLine({ start: { x: M + i * cw, y: y - 9 }, end: { x: M + i * cw, y: y - sh + 9 }, thickness: 0.6, color: rgb(0.25, 0.35, 0.37) });
  });
  y -= sh + 22;

  // ---- item lines
  const cols = { desc: M + 10, qty: R - 190, unit: R - 100, amt: R - 10 };
  const heads = [["Description", cols.desc], ["Qty", cols.qty, "right"], ["Unit price", cols.unit, "right"], ["Amount", cols.amt, "right"]];
  const tableHead = () => {
    page.drawRectangle({ x: M, y: y - 20, width: R - M, height: 20, color: TEAL });
    heads.forEach(([s, x, align]) => text(s, x, y - 13.5, { font: bold, size: 8, color: WHITE, align }));
    y -= 20;
  };
  tableHead();
  (model.items || []).forEach((l, i) => {
    const desc = wrap(l.label || "Item", reg, 9.5, cols.qty - cols.desc - 40), rh = Math.max(22, desc.length * 12 + 10);
    ensure(rh, tableHead);
    if (i % 2) page.drawRectangle({ x: M, y: y - rh, width: R - M, height: rh, color: PALE });
    desc.forEach((t, k) => text(t, cols.desc, y - 14.5 - k * 12, { color: INK }));
    text(l.qty == null ? "" : String(l.qty), cols.qty, y - 14.5, { align: "right" });
    text(l.unit_cents == null ? "" : money(l.unit_cents), cols.unit, y - 14.5, { align: "right" });
    text(money(l.amount_cents), cols.amt, y - 14.5, { color: INK, align: "right" });
    y -= rh;
    page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.5, color: LINE });
  });

  // ---- totals
  const payments = model.payments || [];
  ensure(110 + payments.length * 19);
  y -= 12;
  const tx = R - 250;
  const sumRow = (k, v, color = INK) => {
    const lines = wrap(k, reg, 9.5, 170);
    lines.forEach((t, n) => text(t, tx + 10, y - 12 - n * 11, { color: color === INK ? BODY : color }));
    text(v, R - 10, y - 12, { color, align: "right" });
    y -= 8 + lines.length * 11;
  };
  sumRow("Subtotal (ex GST)", money(model.total_cents - model.gst_cents));
  sumRow("GST (10%)", money(model.gst_cents));
  page.drawLine({ start: { x: tx, y: y - 2 }, end: { x: R, y: y - 2 }, thickness: 0.8, color: LINE }); y -= 4;
  sumRow("Total (inc GST)", money(model.total_cents));
  payments.forEach((p) => sumRow(p.label, "-" + money(p.cents), GREEN));
  y -= 4;
  page.drawRectangle({ x: tx, y: y - 30, width: R - tx, height: 30, color: model.paid ? GREEN : INK });
  text(model.paid ? "Balance due - PAID IN FULL" : "Amount due", tx + 10, y - 19.5, { font: bold, size: 10, color: WHITE });
  text(money(model.owing_cents), R - 10, y - 20.5, { font: display, size: 13, color: WHITE, align: "right" });
  y -= 50;

  // ---- how to pay / thank you
  if (!model.paid && model.owing_cents > 0 && model.bank) {
    const rows = [["Account name", model.bank.name], ["BSB", model.bank.bsb], ["Account number", model.bank.account], ["Reference", model.number]];
    const urlLines = model.payUrl ? wrap(model.payUrl, reg, 8, R - M - 150) : [];
    const bh = 34 + rows.length * 14 + (urlLines.length ? 20 + urlLines.length * 10 : 0);
    ensure(bh + 10);
    page.drawRectangle({ x: M, y: y - bh, width: R - M, height: bh, color: PALE, borderColor: LINE, borderWidth: 0.8 });
    page.drawRectangle({ x: M, y: y - bh, width: 3, height: bh, color: TEAL });
    label("How to pay", M + 14, y - 16);
    rows.forEach(([k, v], i) => { text(k, M + 14, y - 34 - i * 14, { size: 9 }); text(v, M + 120, y - 34 - i * 14, { font: bold, size: 9, color: INK }); });
    if (urlLines.length) {
      const yy = y - 34 - rows.length * 14 - 8;
      text("Pay by card online:", M + 14, yy, { size: 9 });
      urlLines.forEach((t, i) => text(t, M + 120, yy - i * 10, { size: 8, color: TEAL_DEEP }));
    }
    y -= bh + 16;
    ensure(30);
    wrap("Please use the reference above with your bank transfer. Your smoke alarm compliance certificate is emailed as soon as full payment is received.", reg, 8.6, R - M)
      .forEach((t) => { text(t, M, y, { size: 8.6, color: MUTED }); y -= 11; });
  } else {
    ensure(30);
    text("Thank you for choosing PowerSmart.", M, y, { font: bold, size: 10, color: INK }); y -= 14;
    text("This invoice has been paid in full. Please keep it for your records.", M, y, { size: 8.6, color: MUTED });
  }

  // ---- footer on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    p.drawLine({ start: { x: M, y: 50 }, end: { x: R, y: 50 }, thickness: 0.75, color: LINE });
    text(`PowerSmart Pty Ltd  |  ABN ${Q.ABN}  |  ${Q.PHONE_DISPLAY}  |  ${Q.SUPPORT_EMAIL}`, M, 36, { size: 8, color: MUTED });
    text(`Page ${i + 1} of ${pages.length}`, R, 36, { size: 8, color: MUTED, align: "right" });
  });
  return Buffer.from(await doc.save());
}

// Invoice lines with a unit price where the amount divides evenly by the quantity.
function itemLines(items) {
  return (Array.isArray(items) ? items : []).map((i) => {
    const qty = Number(i.qty), amount = Number(i.amount_cents || 0);
    const unit = Number.isFinite(qty) && qty > 0 ? Math.round(amount / qty) : null;
    return { label: i.label || "Item", qty: i.qty == null ? "" : i.qty, unit_cents: unit, amount_cents: amount };
  });
}

// The paid invoice filed to Dropbox when the invoice email is sent.
async function renderPaidInvoicePdf({ job, items, total, credits, bookingFee, method, billingAddress, date }) {
  const advance = Array.isArray(credits) ? credits : [];
  const fee = [3500, 5000].includes(bookingFee) && !advance.some((c) => /call-out deposit/i.test(c.label || "")) ? bookingFee : 0;
  const lines = itemLines(items);
  if (fee) lines.push({ label: "Electrician call-out fee", qty: 1, unit_cents: fee, amount_cents: fee });
  const grand = Number(total || 0) + fee;
  const payments = [];
  if (fee) payments.push({ label: "Paid: electrician call-out fee (when booked)", cents: fee });
  advance.forEach((c) => payments.push({ label: "Paid in advance: " + (c.label || "Credit"), cents: Number(c.cents || 0) }));
  const rest = grand - payments.reduce((n, p) => n + p.cents, 0);
  if (rest > 0) payments.push({ label: "Paid" + (method ? " by " + (METHODS[method] || method) : ""), cents: rest });
  const property = [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return renderInvoicePdf({
    number: "J" + job.job_no, date, paid: true, customer: job.customer_name, billTo: billingAddress, property, email: job.email,
    items: lines, total_cents: grand, gst_cents: Math.round(grand / 11), payments, owing_cents: 0, bank: null,
  });
}

module.exports = { renderInvoicePdf, renderPaidInvoicePdf, itemLines };
