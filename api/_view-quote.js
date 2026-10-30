const SB = require('./_supabase');
const QP = require('./_quote-payments');
module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method !== 'GET'){res.setHeader('Allow','GET');return res.status(405).send('Method not allowed');}
  const token=String(req.query.token || '');
  if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(token))return res.status(404).send('Quote not found. Please contact PowerSmart.');
  try {
    const rows=await SB.sb(`sent_emails?id=eq.${token}&kind=eq.quote&status=eq.sent&select=id,lead_id,quote_ref,quote_total,body_html&limit=1`);
    if(!rows?.[0]?.body_html)return res.status(404).send('Quote not found. Please contact PowerSmart.');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',"default-src 'none'; img-src https://smokealarms.powersmartco.com.au https://portal.powersmartco.com.au data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const payments = await QP.quotePayments(rows[0], true);
    return res.status(200).send(QP.renderPaidQuote(rows[0], payments));
  }catch(e){return res.status(503).send('Your quote is temporarily unavailable. Please try again or call PowerSmart on 0401 991 420.');}
};
