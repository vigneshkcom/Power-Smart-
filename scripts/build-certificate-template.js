#!/usr/bin/env node
// Developer tool (not run on Vercel): pre-renders the certificate design to api/_cert-assets/template.pdf with the
// customer fields left empty, and records where each field sits (fields.json). api/_certificate.js then only draws the
// customer's details on top of the template with pdf-lib, which takes milliseconds and needs no browser.
//   CHROME_PATH=/path/to/chrome node scripts/build-certificate-template.js
// Change the design by editing scripts/certificate/page1.html / page2.html, then re-run this and commit the output.
const fs = require("fs");
const path = require("path");
const IN = path.join(__dirname, "certificate"), OUT = path.join(__dirname, "..", "api", "_cert-assets");
const read = (f) => fs.readFileSync(path.join(IN, f));
const uri = (f, mime) => `data:${mime};base64,${read(f).toString("base64")}`;
const FACES = [400, 500, 600].map((w) => `@font-face{font-family:'Inter';font-weight:${w};src:url(${uri("inter.woff2", "font/woff2")}) format('woff2')}`).join("") +
  [500, 600, 700, 800].map((w) => `@font-face{font-family:'Poppins';font-weight:${w};src:url(${uri(`poppins-${w}.woff2`, "font/woff2")}) format('woff2')}`).join("");
const FIELDS = { DATE: "30 / 10 / 2026", STATE: "QLD", POSTCODE: "4124", ADDRESS: "2 ADDISON STREET", SUBURB: "GREENBANK", ELEC_NAME: "Joshua Brindley", LICENCE: "1515658" };

function html(sample) {
  const logo = uri("logo.png", "image/png");
  const map = { LOGO: logo, SIGNATURE: `<div data-f="SIGNATURE" style="flex:1;min-height:0"></div>` };
  // The blank template keeps the same layout as the measured one: the sample text stays in place but invisible.
  for (const [k, v] of Object.entries(FIELDS)) map[k] = `<span data-f="${k}"${sample ? "" : ' style="visibility:hidden"'}>${v}${sample ? '<i data-base style="display:inline-block;width:0;height:0"></i>' : ""}</span>`;
  const fill = (t) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in map ? map[k] : ""));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${FACES}
@page{size:794px 1123px;margin:0}html,body{margin:0;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{width:794px;height:1123px;overflow:hidden;page-break-after:always}.pg:last-child{page-break-after:auto}a{color:#8AE8E4}</style></head>
<body><div class="pg">${fill(read("page1.html").toString("utf8"))}</div><div class="pg">${fill(read("page2.html").toString("utf8"))}</div></body></html>`;
}

(async () => {
  const puppeteer = require("puppeteer-core");
  if (!process.env.CHROME_PATH) throw new Error("Set CHROME_PATH to a Chrome/Chromium binary.");
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: "shell", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html(true), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const fields = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll("[data-f]")) {
        const r = el.getBoundingClientRect(), base = el.querySelector("[data-base]");
        out[el.dataset.f] = { x: r.left, y: r.top, w: r.width, h: r.height, size: parseFloat(getComputedStyle(el).fontSize), baseline: base ? base.getBoundingClientRect().bottom : null };
      }
      return out;
    });
    fs.writeFileSync(path.join(OUT, "fields.json"), JSON.stringify(fields, null, 1) + "\n");
    await page.setContent(html(false), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    fs.writeFileSync(path.join(OUT, "template.pdf"), await page.pdf({ width: "794px", height: "1123px", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
    console.log("Wrote template.pdf and fields.json", fields);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
