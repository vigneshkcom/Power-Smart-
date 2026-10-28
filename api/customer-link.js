// Public customer links share one function; each handler requires a random UUID token.
const quote = require('./_view-quote');
const payment = require('./_payment-link');
module.exports = (req,res) => {
  if(req.query.kind === 'confirmation')return require('./_payment-confirmation')(req,res);
  if(req.query.kind === 'quote')return quote(req,res);
  if(req.query.kind === 'payment')return payment(req,res);
  res.setHeader('Cache-Control','no-store');return res.status(404).send('Link not found.');
};
