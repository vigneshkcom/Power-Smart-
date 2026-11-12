// A durable PDF copy of the paid tax invoice, using the same items, GST and credit calculations as the email.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const Q = require("./_quote");
const METHODS = { card: "card", bank_transfer: "bank transfer", cash: "cash" };

async function renderPaidInvoicePdf({ job, items, total, credits, bookingFee, method, billingAddress, date }) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const allowed = new Set(regular.getCharacterSet());
  const clean = (s) => Array.from(String(s == null ? "" : s)).map((c) =>
    allowed.has(c.codePointAt(0)) ? c : "?").join("");
  const ink = rgb(0.04, 0.10, 0.13), grey = rgb(0.31, 0.40, 0.43);
  const teal = rgb(0.16, 0.55, 0.62), pale = rgb(0.94, 0.97, 0.98);
  const pageSize = [595.28, 841.89];
  let page, y;

  function startPage(first) {
    page = doc.addPage(pageSize);
    page.drawRectangle({ x: 0, y: 734, width: pageSize[0], height: 108, color: ink });
    page.drawText("PowerSmart Pty Ltd", { x: 42, y: 799, font: bold, size: 17, color: rgb(1, 1, 1) });
    page.drawText("TAX INVOICE (PAID)", { x: 42, y: 770, font: bold, size: 15, color: rgb(1, 1, 1) });
    page.drawText(clean("J" + job.job_no + (first ? "" : " - continued")), { x: 420, y: 773, font: bold, size: 11, color: rgb(1, 1, 1) });
    y = 708;
  }
  function ensure(height) {
    if (y - height < 74) startPage(false);
  }
  function wrapped(s, font, size, max) {
    const words = clean(s).replace(/\s+/g, " ").trim().split(" ");
    const lines = []; let line = "";
    for (let word of words) {
      if (!word) continue;
      while (font.widthOfTextAtSize(word, size) > max) {
        if (line) { lines.push(line); line = ""; }
        let index = 1;
        while (index < word.length && font.widthOfTextAtSize(word.slice(0, index + 1), size) <= max) index++;
        lines.push(word.slice(0, index));
        word = word.slice(index);
      }
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) > max && line) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  function paragraph(label, value) {
    const words = wrapped(label + value, regular, 10, 507);
    ensure(words.length * 14 + 8);
    for (const line of words) { page.drawText(line, { x: 42, y, font: regular, size: 10, color: grey }); y -= 14; }
    y -= 5;
  }
  function separator() {
    ensure(16);
    page.drawLine({ start: { x: 42, y }, end: { x: 553, y }, thickness: 0.8, color: rgb(0.85, 0.91, 0.93) });
    y -= 18;
  }
  function row(description, qty, amount, { strong = false, shade = false, green = false } = {}) {
    const font = strong ? bold : regular;
    const lines = wrapped(description, font, 10, 335);
    const height = Math.max(24, lines.length * 13 + 9);
    ensure(height + 4);
    if (shade) page.drawRectangle({ x: 42, y: y - height + 11, width: 511, height, color: pale });
    lines.forEach((line, i) => page.drawText(line, { x: 48, y: y - 3 - i * 13, font, size: 10, color: green ? teal : ink }));
    if (qty !== null && qty !== undefined) page.drawText(clean(qty), { x: 413, y: y - 3, font, size: 10, color: grey });
    const value = clean(amount);
    page.drawText(value, { x: 547 - font.widthOfTextAtSize(value, 10), y: y - 3, font, size: 10, color: green ? teal : ink });
    y -= height;
  }

  const money = (cents) => Q.fmt(Number(cents || 0) / 100);
  const entries = Array.isArray(items) ? items : [];
  const advance = Array.isArray(credits) ? credits : [];
  const separateFee = [3500, 5000].includes(bookingFee) && !advance.some((c) => /call-out deposit/i.test(c.label || ""));
  const fee = separateFee ? bookingFee : 0;
  const grand = Number(total || 0) + fee;
  const paidAdvance = fee + advance.reduce((n, c) => n + Number(c.cents || 0), 0);
  const paidNow = grand - paidAdvance;

  startPage(true);
  paragraph("Invoice: ", "J" + job.job_no + "     Date: " + date);
  paragraph("Customer: ", job.customer_name || "");
  if (billingAddress) paragraph("Bill to: ", billingAddress);
  const address = [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (address) paragraph("Property: ", address);
  separator();
  row("DESCRIPTION", "QTY", "AMOUNT", { strong: true, shade: true });
  entries.forEach((item) => row(item.label || "Item", String(item.qty == null ? "" : item.qty), money(item.amount_cents)));
  if (fee) row("Electrician call-out fee", "1", money(fee));
  separator();
  row("Total (incl. GST)", null, money(grand), { strong: true });
  row("Includes GST", null, money(Math.round(grand / 11)));
  if (fee) row("Less paid in advance: Electrician call-out fee (paid when booked)", null, "-" + money(fee), { green: true });
  advance.forEach((credit) => row("Less paid in advance: " + (credit.label || "Credit"), null, "-" + money(credit.cents), { green: true }));
  if (paidNow > 0) row("Paid" + (method ? " by " + (METHODS[method] || method) : ""), null, "-" + money(paidNow), { green: true });
  row("Balance owing - PAID IN FULL", null, "$0.00", { strong: true, shade: true });
  y -= 12;
  paragraph("", "Thank you for choosing PowerSmart. Please keep this paid tax invoice for your records.");
  for (const p of doc.getPages()) {
    p.drawLine({ start: { x: 42, y: 53 }, end: { x: 553, y: 53 }, thickness: 0.75, color: rgb(0.85, 0.91, 0.93) });
    p.drawText(clean("PowerSmart Pty Ltd  |  ABN " + Q.ABN + "  |  " + Q.PHONE_DISPLAY), { x: 42, y: 38, font: regular, size: 9, color: grey });
  }
  return Buffer.from(await doc.save());
}

module.exports = { renderPaidInvoicePdf };
