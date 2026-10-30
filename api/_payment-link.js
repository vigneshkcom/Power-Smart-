const SB = require('./_supabase');
const {checkoutUrl} = require('./_payments');
module.exports = async(req,res) => {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method !== 'GET'){res.setHeader('Allow','GET');return res.status(405).send('Method not allowed');}
  const token=String(req.query.token || '');
  if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(token))return res.status(404).send('Payment link not found. Please contact PowerSmart.');
  try {
    const rows=await SB.sb(`payment_requests?id=eq.${token}&select=status,checkout_url&limit=1`),p=rows?.[0];
    if(!p)return res.status(404).send('Payment link not found. Please contact PowerSmart.');
    if(p.status === 'paid')return res.status(200).send('Thank you. This PowerSmart payment has already been received.');
    if(p.status !== 'sent')return res.status(410).send('This payment link is no longer active. Please contact PowerSmart on 0401 991 420.');
    res.setHeader('Location',checkoutUrl(p.checkout_url));return res.status(302).end();
  }catch(e){return res.status(503).send('Payment link temporarily unavailable. Please try again.');}
};
