// Display the renamed staff identity without rewriting historical receipts/emails.
const name = value => typeof value === 'string' && /^vignesh$/i.test(value.trim()) ? 'Sunny' : value;
function text(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(Prepared by[: ]*|\bby |\bas |\bthis is )Vignesh\b/gi, '$1Sunny')
    .replace(/>Vignesh(?=\s*<)/g, '>Sunny')
    .replace(/(^|\n)Vignesh(?=\r?\n|$)/g, '$1Sunny')
    .replace(/([?&](?:amp;)?agent=)Vignesh(?=&|["'<>\s]|$)/gi, '$1Sunny');
}
function record(value, table) {
  if (Array.isArray(value)) return value.map(row => record(row, table));
  if (!value || typeof value !== 'object') return value;
  const row = { ...value };
  for (const key of ['agent', 'author', 'created_by']) if (key in row) row[key] = name(row[key]);
  if (row.sender === 'vignesh') row.sender = 'sunny';
  if (!table || ['sent_emails', 'lead_comments'].includes(table)) {
    for (const key of ['body', 'body_html', 'body_text']) if (key in row) row[key] = text(row[key]);
  }
  return row;
}
module.exports = { name, text, record };
