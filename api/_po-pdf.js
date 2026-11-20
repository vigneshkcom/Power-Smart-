// PDF purchase order for an electrician (A4), attached to the PO email and shown by Preview PDF.
// Layout: logo + title, buyer / supplier panels, summary strip, priced lines with GST totals, then every job included.
const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const { COMPANY, GST_PCT, dollars } = require("./_po");

const DIR = path.join(__dirname, "_cert-assets");
const W = 595.28, H = 841.89, M = 42, R = W - M;
const INK = rgb(0.043, 0.106, 0.122), BODY = rgb(0.255, 0.345, 0.365), MUTED = rgb(0.54, 0.63, 0.65);
const TEAL = rgb(0.165, 0.553, 0.62), TEAL_DEEP = rgb(0.18, 0.518, 0.58), PALE = rgb(0.957, 0.976, 0.98), LINE = rgb(0.86, 0.91, 0.92), WHITE = rgb(1, 1, 1);

async function renderPoPdf(po) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(po.title); doc.setAuthor(COMPANY.name); doc.setSubject(`Purchase order ${po.ref}`);
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const display = await doc.embedFont(fs.readFileSync(path.join(DIR, "poppins-600.ttf")));
  const logo = await doc.embedPng(fs.readFileSync(path.join(DIR, "powersmart-logo.png")));
  const ok = new Set(reg.getCharacterSet());
  const clean = (s) => Array.from(String(s == null ? "" : s)).map((c) => (ok.has(c.codePointAt(0)) ? c : c === "–" || c === "—" ? "-" : "?")).join("");
  let page, y;

  const text = (s, x, yy, { font = reg, size = 9.5, color = BODY, align = "left" } = {}) => {
    const t = clean(s), w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === "right" ? x - w : align === "center" ? x - w / 2 : x, y: yy, font, size, color });
    return w;
  };
  const fit = (s, font, size, max) => {   // shorten to fit a column
    let t = clean(s);
    if (font.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > max) t = t.slice(0, -1);
    return t.trimEnd() + "...";
  };
  const label = (s, x, yy, color = TEAL_DEEP) => text(String(s).toUpperCase(), x, yy, { font: bold, size: 7.2, color });

  function newPage(first) {
    page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: TEAL });
    if (first) return;
    const lw = 110; page.drawImage(logo, { x: M, y: H - 52, width: lw, height: lw * logo.height / logo.width });
    text(`${po.title}  -  continued`, R, H - 44, { font: bold, size: 9, color: INK, align: "right" });
    y = H - 78;
  }
  const ensure = (h, onBreak) => { if (y - h < 64) { newPage(false); if (onBreak) onBreak(); } };

  // ---- header
  newPage(true);
  const lw = 178, lh = lw * logo.height / logo.width;
  page.drawImage(logo, { x: M, y: H - 40 - lh, width: lw, height: lh });
  text("PURCHASE ORDER", R, H - 58, { font: display, size: 22, color: INK, align: "right" });
  text(po.title, R, H - 74, { font: bold, size: 10, color: TEAL_DEEP, align: "right" });
  const meta = [["PO number", po.ref], ["Issue date", po.issued], ["Week ending", po.week_ending_label], ["Payment date", po.pay_date_label || "To be confirmed"]];
  meta.forEach(([k, v], i) => {
    const yy = H - 96 - i * 14;
    text(k, R - 150, yy, { size: 8.5, color: MUTED, align: "right" });
    text(v, R, yy, { font: bold, size: 8.5, color: INK, align: "right" });
  });

  // ---- buyer / supplier panels
  y = H - 170;
  const pw = (R - M - 14) / 2, ph = 94;
  const panel = (x, title, name, rows) => {
    page.drawRectangle({ x, y: y - ph, width: pw, height: ph, color: PALE, borderColor: LINE, borderWidth: 0.8 });
    page.drawRectangle({ x, y: y - ph, width: 3, height: ph, color: TEAL });
    label(title, x + 14, y - 16);
    text(name, x + 14, y - 32, { font: bold, size: 11, color: INK });
    rows.filter(Boolean).slice(0, 5).forEach((r, i) => text(fit(r, reg, 8.6, pw - 28), x + 14, y - 46 - i * 10.5, { size: 8.6 }));
  };
  panel(M, "Buyer", COMPANY.name, [`ABN ${COMPANY.abn}`, ...COMPANY.address, `${COMPANY.phone}  |  ${COMPANY.email}`]);
  const e = po.electrician;
  panel(M + pw + 14, "Supplier (electrician)", e.name, [e.code ? `Electrician ID ${e.code}` : "", e.licence_no ? `Electrical licence ${e.licence_no}` : "", e.email, e.phone, "Registered for GST"]);
  y -= ph + 16;

  // ---- summary strip
  const sh = 46, cw = (R - M) / 3;
  page.drawRectangle({ x: M, y: y - sh, width: R - M, height: sh, color: INK });
  [["Work period", po.period.label], ["Payment date", po.pay_date_label || "To be confirmed"], ["Total (inc GST)", dollars(po.total_cents)]].forEach(([k, v], i) => {
    const x = M + i * cw + 14;
    label(k, x, y - 16, rgb(0.6, 0.82, 0.86));
    text(fit(v, i === 2 ? display : bold, i === 2 ? 15 : 9.5, cw - 24), x, y - (i === 2 ? 35 : 32), { font: i === 2 ? display : bold, size: i === 2 ? 15 : 9.5, color: WHITE });
    if (i) page.drawLine({ start: { x: M + i * cw, y: y - 9 }, end: { x: M + i * cw, y: y - sh + 9 }, thickness: 0.6, color: rgb(0.25, 0.35, 0.37) });
  });
  y -= sh + 20;

  // ---- priced lines
  const cols = { desc: M + 10, qty: R - 210, unit: R - 110, amt: R - 10 };
  const tableHead = (heads) => {
    page.drawRectangle({ x: M, y: y - 20, width: R - M, height: 20, color: TEAL });
    heads.forEach(([s, x, align]) => text(s, x, y - 13.5, { font: bold, size: 8, color: WHITE, align }));
    y -= 20;
  };
  text("Order lines", M, y, { font: display, size: 12, color: INK }); y -= 12;
  tableHead([["Description", cols.desc], ["Qty", cols.qty, "right"], ["Unit price (ex GST)", cols.unit, "right"], ["Amount (ex GST)", cols.amt, "right"]]);
  po.lines.forEach((l, i) => {
    ensure(20, () => tableHead([["Description", cols.desc], ["Qty", cols.qty, "right"], ["Unit price (ex GST)", cols.unit, "right"], ["Amount (ex GST)", cols.amt, "right"]]));
    if (i % 2) page.drawRectangle({ x: M, y: y - 20, width: R - M, height: 20, color: PALE });
    text(fit(l.label, reg, 9.5, cols.qty - cols.desc - 40), cols.desc, y - 13.5, { color: INK });
    text(String(l.qty), cols.qty, y - 13.5, { align: "right" });
    text(dollars(l.unit_cents), cols.unit, y - 13.5, { align: "right" });
    text(dollars(l.amount_cents), cols.amt, y - 13.5, { color: l.amount_cents < 0 ? rgb(0.7, 0.27, 0.23) : INK, align: "right" });
    y -= 20;
    page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.5, color: LINE });
  });

  // ---- totals
  ensure(90);
  y -= 12;
  const tx = R - 230;
  [["Subtotal (ex GST)", po.subtotal_cents], [`GST (${GST_PCT}%)`, po.gst_cents]].forEach(([k, v]) => {
    text(k, tx + 10, y - 12, { color: BODY }); text(dollars(v), R - 10, y - 12, { color: INK, align: "right" }); y -= 19;
  });
  page.drawRectangle({ x: tx, y: y - 30, width: R - tx, height: 30, color: INK });
  text("Total (inc GST)", tx + 10, y - 19.5, { font: bold, size: 10, color: WHITE });
  text(dollars(po.total_cents), R - 10, y - 20.5, { font: display, size: 13, color: WHITE, align: "right" });
  text("Rates are ex GST. GST is added because the supplier is registered for GST.", M, y - 19, { size: 7.8, color: MUTED });
  y -= 44;

  // ---- jobs included
  if (po.jobs.length) {
    const jc = { date: M + 8, job: M + 78, addr: M + 120, bat: R - 176, hw: R - 118, rem: R - 68, amt: R - 8 };
    const jhead = () => {
      page.drawRectangle({ x: M, y: y - 18, width: R - M, height: 18, color: PALE });
      [["Date", jc.date], ["Job", jc.job], ["Address", jc.addr], ["Battery", jc.bat, "right"], ["Hardwired", jc.hw, "right"], ["Remote", jc.rem, "right"], ["Ex GST", jc.amt, "right"]]
        .forEach(([s, x, align]) => text(s.toUpperCase(), x, y - 12, { font: bold, size: 7, color: TEAL_DEEP, align }));
      y -= 18;
    };
    ensure(60);
    text(`Jobs included (${po.jobs.length})`, M, y, { font: display, size: 12, color: INK }); y -= 12;
    jhead();
    po.jobs.forEach((j) => {
      ensure(17, jhead);
      const d = new Date(j.completed_at);
      text(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", ""), jc.date, y - 12, { size: 8.5 });
      text("J" + j.job_no, jc.job, y - 12, { font: bold, size: 8.5, color: INK });
      text(fit(j.address, reg, 8.5, jc.bat - jc.addr - 40), jc.addr, y - 12, { size: 8.5 });
      text(String(j.battery), jc.bat, y - 12, { size: 8.5, align: "right" });
      text(String(j.hardwired), jc.hw, y - 12, { size: 8.5, align: "right" });
      text(String(j.controllers), jc.rem, y - 12, { size: 8.5, align: "right" });
      text(dollars(j.amount_cents), jc.amt, y - 12, { size: 8.5, color: INK, align: "right" });
      y -= 17;
      page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.4, color: LINE });
    });
    y -= 8;
    text(`Each job includes the ${dollars(3000)} call-out. Amounts per job exclude GST.`, M, y - 6, { size: 7.8, color: MUTED });
  }

  // ---- footer on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    p.drawLine({ start: { x: M, y: 46 }, end: { x: R, y: 46 }, thickness: 0.6, color: LINE });
    text(`${COMPANY.name}  |  ABN ${COMPANY.abn}  |  ${COMPANY.address.join(", ")}`, M, 32, { size: 7.5, color: MUTED });
    text(`${COMPANY.email}  |  ${COMPANY.phone}`, M, 21, { size: 7.5, color: MUTED });
    text(`${po.ref}  |  Page ${i + 1} of ${pages.length}`, R, 32, { size: 7.5, color: MUTED, align: "right" });
  });
  return doc.save();
}

module.exports = { renderPoPdf };
