#!/usr/bin/env node
// One-time helper: turns a Dropbox app key + secret into a long-lived refresh token.
//   node scripts/dropbox-refresh-token.js <APP_KEY> <APP_SECRET>
// 1. Open the printed link, click Allow, copy the code Dropbox shows.
// 2. Paste it here. Put the three values into Vercel (never commit them).
const readline = require("node:readline");
const [key, secret] = process.argv.slice(2);
if (!key || !secret) { console.error("Usage: node scripts/dropbox-refresh-token.js <APP_KEY> <APP_SECRET>"); process.exit(1); }
console.log("\n1. Open this link and click Allow:\n\nhttps://www.dropbox.com/oauth2/authorize?client_id=" + encodeURIComponent(key) + "&response_type=code&token_access_type=offline\n");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("2. Paste the code Dropbox shows here: ", async (code) => {
  rl.close();
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: code.trim(), grant_type: "authorization_code" }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) { console.error("\nFailed:", data); process.exit(1); }
  console.log("\nAdd these three variables in Vercel → Settings → Environment Variables, then redeploy:\n");
  console.log("DROPBOX_APP_KEY=" + key + "\nDROPBOX_APP_SECRET=" + secret + "\nDROPBOX_REFRESH_TOKEN=" + data.refresh_token + "\n");
});
