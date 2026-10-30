const crypto = require('crypto');
const SB = require('./_supabase');
const Sms = require('./_sms-outbound');
const Senders = require('./_senders');
const QP = require('./_quote-payments');
const { logEmail } = require('./_maillog');
const DAY = 86400000;
const enc = encodeURIComponent;
const uuid = v => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(String(v || ''));
const first = rows => rows?.[0];
const settingFields = 'lead_id,quote_id,enabled,unsubscribed,reminder_count,next_at,reason,reply_baseline,updated_at';
function businessHours(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return !['Sat','Sun'].includes(parts.weekday) && Number(parts.hour)>=9 && Number(parts.hour)<17;
}
function nextWindow(value) {
  const timestamp = new Date(value).getTime();
  if(!Number.isFinite(timestamp))throw new Error('Invalid reminder date');
  const date = new Date(Math.ceil(timestamp/600000)*600000);
  while (!businessHours(date)) date.setUTCMinutes(date.getUTCMinutes()+10);
  return date.toISOString();
}
function expiresAt(q) {
  const saved = String(q.body_text || '').match(/Valid until:\s*(\d{1,2} [A-Za-z]+ \d{4})/);
  const explicit = saved ? Date.parse(saved[1]+' 23:59:59 GMT+1000') : NaN;
  return Number.isFinite(explicit) ? explicit : Date.parse(q.created_at)+30*DAY;
}
function messages(lead,q,sequence,token) {
  const name = String(lead.name || 'there').trim().split(/\s+/)[0];
  const agent = ['Mani','Sunny'].includes(lead.agent) ? lead.agent : 'the PowerSmart team';
  const link = `https://smokealarms.powersmartco.com.au/quote?token=${q.id}`;
  const stop = `https://smokealarms.powersmartco.com.au/api/customer-link?kind=reminders&token=${token}`;
  const wording = [
    "Just checking whether you've had a chance to review your Anka smoke alarm quote.",
    'Do you have any questions about your Anka smoke alarm quote, pricing or installation? We are happy to help.',
    'A final follow-up on your Anka smoke alarm quote. If you would like to go ahead, you can accept it using the link below.'
  ][sequence-1];
  const intro = `Hi ${name}, it's ${agent} from PowerSmart.`.replace('the PowerSmart team from PowerSmart','the PowerSmart team');
  const sms = `${intro} ${wording} View quote: ${link} Reply with any questions, or STOP to stop reminders. 0401 991 420`;
  const subject = `${sequence===3?'Final follow-up':'Checking in'}: your PowerSmart quote ${q.quote_ref}`;
  const email = `${intro}\n\n${wording}\n\nView or accept your quote: ${link}\n\nReply to this email or call 0401 991 420 if you have any questions.\n\nStop automatic quote reminders: ${stop}`;
  return {sms,subject,email,sender:lead.agent==='Mani'?'mani':'sunny'};
}
async function context(leadId) {
  const [settings,leads] = await Promise.all([
    SB.sb(`quote_reminder_settings?lead_id=eq.${enc(leadId)}&select=*&limit=1`),
    SB.sb(`leads?id=eq.${enc(leadId)}&select=id,name,phone,email,stage,quote_ref,agent&limit=1`)
  ]);
  const s=first(settings),lead=first(leads);
  const q=s?.quote_id ? first(await SB.sb(`sent_emails?id=eq.${enc(s.quote_id)}&select=id,lead_id,kind,status,quote_ref,created_at,body_text,body_html,to_email&limit=1`)) : null;
  return {s,lead,q};
}
function hasCurrentSentQuote({s,lead,q}) {
  return Boolean(s && lead && q && q.id===s.quote_id && q.kind==='quote' && q.status==='sent' && q.lead_id===lead.id && q.quote_ref===lead.quote_ref);
}
async function eligibility(c,now=new Date(),{ignorePaused=false,refreshPayment=false}={}) {
  const {s,lead,q}=c;
  if(!lead)return 'Customer not found';
  if(lead.stage!=='quote_sent')return 'Only customers in Quote Sent receive reminders';
  if(!s || !q)return 'No successfully sent quote';
  if(s.unsubscribed)return 'Customer stopped automatic reminders';
  if(!ignorePaused && !s.enabled)return s.reason || 'Paused by staff';
  if(q.kind!=='quote' || q.status!=='sent' || q.lead_id!==lead.id || q.quote_ref!==lead.quote_ref)return 'Quote has been replaced or is unavailable';
  if(expiresAt(q)<now.getTime())return 'Quote has expired';
  const phone=Sms.cleanPhone(lead.phone);
  if(!/^\+614\d{8}$/.test(phone))return 'A valid Australian mobile number is required';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email || ''))return 'A valid email address is required';
  // Never send an old quote to a changed recipient without issuing a new quote.
  if(String(q.to_email).toLowerCase()!==lead.email.toLowerCase())return 'Email changed since the quote; issue a new quote';
  const [consent,replies,payments] = await Promise.all([
    SB.sb(`sms_messages?phone_number=eq.${enc(phone)}&status=in.(optout,optin)&select=status&order=created_at.desc&limit=1`),
    SB.sb(`sms_messages?phone_number=eq.${enc(phone)}&direction=eq.inbound&created_at=gt.${enc(s.reply_baseline)}&select=id&limit=1`),
    refreshPayment ? QP.quotePayments(q,true) : SB.sb(`payment_requests?lead_id=eq.${lead.id}&quote_ref=eq.${enc(q.quote_ref)}&status=eq.paid&select=status,amount_paid_cents&limit=100`)
  ]);
  if(first(consent)?.status==='optout')return 'Customer opted out of SMS';
  if(replies?.length)return 'Customer replied by SMS; review before resuming';
  if(payments?.some(p=>p.status==='paid' && Number(p.amount_paid_cents)>0))return 'Payment received; reminders stopped';
  return null;
}
async function pause(leadId,reason,quoteId) {
  await SB.sb(`quote_reminder_settings?lead_id=eq.${leadId}${quoteId?`&quote_id=eq.${quoteId}`:''}`,{method:'PATCH',body:{enabled:false,next_at:null,reason,updated_at:new Date().toISOString()},prefer:'return=minimal'});
}
async function summary(leadId) {
  const c=await context(leadId);
  if(!c.lead)throw new Error('Customer not found');
  const available=c.lead.stage==='quote_sent' && hasCurrentSentQuote(c);
  const runs=available ? await SB.sb(`quote_reminder_runs?lead_id=eq.${leadId}&select=*&order=created_at.desc&limit=30`) : [];
  const reason=await eligibility(c);
  const s=c.s;
  const activeRuns=(runs || []).filter(r=>r.quote_id===s?.quote_id);
  return {available,enabled:available && Boolean(s?.enabled),unsubscribed:s?.unsubscribed || false,
    eligible:!reason,reason:reason || (s?.reminder_count>=3?'Three-reminder limit reached':null),
    next_at:!reason && s?.next_at && s.reminder_count<3?nextWindow(s.next_at):null,
    rounds_attempted:s?.reminder_count || 0,
    reminders_sent:activeRuns.filter(r=>r.sms_status==='submitted' && r.email_status==='submitted').length,
    sms_sent:activeRuns.filter(r=>r.sms_status==='submitted').length,email_sent:activeRuns.filter(r=>r.email_status==='submitted').length,
    history:runs || [],max_reminders:3,timezone:'Australia/Brisbane'};
}
async function toggle(leadId,enabled,actor) {
  let c=await context(leadId);
  if(!c.lead)throw new Error('Customer not found');
  if(c.lead.stage!=='quote_sent' || !hasCurrentSentQuote(c))throw new Error('Send a quote and keep the lead in Quote Sent before changing reminders');
  if(enabled){
    if(!c.s)throw new Error('Send a quote before enabling reminders');
    if(c.s.reminder_count>=3)throw new Error('Three reminders have already been attempted for this quote. Send a new quote to start a new sequence.');
    const pending=await SB.sb(`quote_reminder_runs?lead_id=eq.${leadId}&quote_id=eq.${c.s.quote_id}&or=(sms_status.in.(pending,sending,unknown),email_status.in.(pending,sending,unknown))&select=id&limit=1`);
    if(pending?.length)throw new Error('A previous reminder is still processing or uncertain. Review its history before resuming.');
    // Explicit staff resume acknowledges earlier replies, but never overrides STOP/unsubscribe.
    c.s.reply_baseline=new Date().toISOString();
    const reason=await eligibility(c,new Date(),{ignorePaused:true,refreshPayment:true});
    if(reason)throw new Error(reason);
    if(c.s.enabled)return summary(leadId); // no accidental postponement on repeated clicks
  }
  const patch={enabled,next_at:enabled?nextWindow(Date.now()+3*DAY):null,reason:enabled?null:`Paused by ${actor || 'staff'}`,updated_at:new Date().toISOString(),...(enabled?{reply_baseline:new Date().toISOString()}:{})};
  if(c.s)await SB.sb(`quote_reminder_settings?lead_id=eq.${leadId}`,{method:'PATCH',body:patch,prefer:'return=minimal'});
  else await SB.sb('quote_reminder_settings',{method:'POST',body:{lead_id:leadId,...patch},prefer:'return=minimal'});
  return summary(leadId);
}
async function patchRun(id,body) { await SB.sb(`quote_reminder_runs?id=eq.${id}`,{method:'PATCH',body,prefer:'return=minimal'}); }
async function processRun(run,c) {
  if(c.q?.id!==run.quote_id) {
    await patchRun(run.id,{sms_status:'skipped',email_status:'skipped',error:'Quote changed before reminder preparation',finished_at:new Date().toISOString()});
    return {run_id:run.id,review_required:true};
  }
  const content=messages(c.lead,c.q,run.sequence,c.s.unsubscribe_token);
  await patchRun(run.id,{sms_to:Sms.cleanPhone(c.lead.phone),email_to:c.lead.email,sms_body:content.sms,email_subject:content.subject,email_body:content.email});
  let issue=null;
  for(const channel of ['sms','email']) {
    const fresh=await context(run.lead_id);
    const reason=await eligibility(fresh,new Date(),{refreshPayment:true});
    if(reason || fresh.s?.quote_id!==run.quote_id || Date.parse(fresh.s?.reply_baseline)>Date.parse(run.created_at) || fresh.lead?.phone!==c.lead.phone || fresh.lead?.email!==c.lead.email) {
      issue=reason || 'Customer or quote changed during sending';
      await patchRun(run.id,{[`${channel}_status`]:'skipped',error:issue});continue;
    }
    // Persist intent before calling providers. A timeout is never blindly retried.
    const claimed=await SB.sb(`quote_reminder_runs?id=eq.${run.id}&${channel}_status=eq.pending`,{method:'PATCH',body:{[`${channel}_status`]:'sending'}});
    if(!claimed?.length)continue;
    try {
      if(channel==='sms') {
        await Sms.sendLeadSms({lead:c.lead,message:content.sms,key:`quote-reminder-${run.id}`,author:'Automatic reminders'});
        await patchRun(run.id,{sms_status:'submitted'});
      } else {
        const {Resend}=require('resend');
        const html=Senders.wrapMessageHtml({senderKey:content.sender,message:content.email}).replace(
          /https:\/\/smokealarms\.powersmartco\.com\.au\/(?:quote\?token=|api\/customer-link\?kind=reminders&amp;token=)[a-f\d-]+/g,
          url=>`<a href="${url}" style="color:#267582">${url.includes('kind=reminders')?'Stop automatic quote reminders':'View your quote'}</a>`);
        const text=content.email+Senders.signatureText(content.sender);
        const {data,error}=await new Resend(process.env.RESEND_API_KEY).emails.send({from:Senders.fromHeader(content.sender),to:c.lead.email,
          replyTo:process.env.RESEND_REPLY_TO || Senders.SUPPORT_EMAIL,subject:content.subject,html,text}, {idempotencyKey:`quote-reminder-${run.id}`});
        if(error)throw new Error(error.message || 'Email submission could not be confirmed');
        if(!data?.id)throw new Error('Email provider did not return a message reference');
        await patchRun(run.id,{email_status:'submitted',email_provider_id:data.id});
        await logEmail({kind:'email',sender:content.sender,agent:'Automatic reminders',to_email:c.lead.email,to_name:c.lead.name,subject:content.subject,body_html:html,body_text:text,lead_id:c.lead.id,provider_id:data.id,status:'sent'});
      }
    } catch(e) {
      issue=`${channel.toUpperCase()}: ${String(e.message).slice(0,300)}`;
      await patchRun(run.id,{[`${channel}_status`]:'unknown',error:issue});
    }
  }
  await patchRun(run.id,{finished_at:new Date().toISOString()});
  if(issue)await pause(run.lead_id,'Reminder needs review: '+issue,run.quote_id);
  return {run_id:run.id,review_required:Boolean(issue)};
}
async function work({dryRun=false,now=new Date()}={}) {
  if(!process.env.RESEND_API_KEY || !process.env.SMSGATE_USERNAME || !process.env.SMSGATE_PASSWORD)throw new Error('Both email and SMS services must be configured');
  if(!businessHours(now))return {skipped:'Outside Queensland weekday sending hours (9am–5pm)',dry_run:dryRun};
  // A crashed send is held for staff review, never re-submitted automatically.
  const stale=await SB.sb(`quote_reminder_runs?finished_at=is.null&created_at=lt.${enc(new Date(now-15*60000).toISOString())}&select=id,lead_id,quote_id&limit=50`);
  if(!dryRun)for(const r of stale || []) {
    await patchRun(r.id,{error:'Interrupted reminder; verify provider records before resuming',finished_at:now.toISOString()});
    await pause(r.lead_id,'Interrupted reminder needs review',r.quote_id);
  }
  const due=await SB.sb(`quote_reminder_settings?enabled=eq.true&unsubscribed=eq.false&next_at=lte.${enc(now.toISOString())}&reminder_count=lt.3&select=${settingFields}&order=next_at.asc&limit=50`);
  let inspected=0;
  for(const s of due || []) {
    const c=await context(s.lead_id); inspected++;
    const reason=await eligibility(c,now,{refreshPayment:!dryRun});
    if(reason){if(!dryRun)await pause(s.lead_id,reason,s.quote_id);continue;}
    if(dryRun)return {dry_run:true,due_count:due.length,eligible:true,inspected};
    const r=first(await SB.sb('rpc/claim_quote_reminder',{method:'POST',body:{p_lead_id:s.lead_id}}));
    if(r)return {...await processRun(r,await context(r.lead_id)),inspected};
  }
  return {dry_run:dryRun,due_count:due?.length || 0,inspected,processed:0};
}
async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  try {
    if(req.body?.action==='run') {
      if(req.method!=='POST')return res.status(405).json({error:'POST required'});
      const config=first(await SB.sb('quote_reminder_worker?id=eq.true&select=secret,active&limit=1'));
      const supplied=Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /,'')),expected=Buffer.from(config?.secret || '');
      if(!expected.length || supplied.length!==expected.length || !crypto.timingSafeEqual(supplied,expected))return res.status(401).json({error:'Invalid worker credentials'});
      if(!config.active)return res.status(200).json({skipped:'Worker paused'});
      const result=await work();
      await SB.sb('quote_reminder_worker?id=eq.true',{method:'PATCH',body:{last_run_at:new Date().toISOString(),last_result:result},prefer:'return=minimal'});
      return res.status(200).json(result);
    }
    if(req.headers['x-portal-key']!=='2026')return res.status(401).json({error:'Invalid portal key'});
    if(req.method==='POST' && req.body?.action==='preview_worker')return res.status(200).json(await work({dryRun:true}));
    const id=req.method==='GET'?req.query.lead_id:req.body?.lead_id;
    if(!uuid(id))return res.status(400).json({error:'A valid customer is required'});
    if(req.method==='GET')return res.status(200).json(await summary(id));
    if(req.method==='POST' && req.body.action==='set' && typeof req.body.enabled==='boolean')return res.status(200).json(await toggle(id,req.body.enabled,String(req.body.actor || 'staff').slice(0,120)));
    return res.status(400).json({error:'Unknown reminder action'});
  } catch(e) { console.error('Quote reminders:',e.message);return res.status(503).json({error:e.message || 'Reminders unavailable'}); }
}
async function unsubscribe(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex');
  const token=req.query.token;
  if(!uuid(token))return res.status(404).send('Link not found');
  const s=first(await SB.sb(`quote_reminder_settings?unsubscribe_token=eq.${token}&select=lead_id&limit=1`));
  if(!s)return res.status(404).send('Link not found');
  if(req.method==='POST') {
    await SB.sb(`quote_reminder_settings?unsubscribe_token=eq.${token}`,{method:'PATCH',body:{enabled:false,unsubscribed:true,next_at:null,reason:'Customer stopped automatic reminders',updated_at:new Date().toISOString()},prefer:'return=minimal'});
    return res.status(200).send('<h1>Reminders stopped</h1><p>You will receive no further automatic quote reminders by SMS or email.</p>');
  }
  if(req.method!=='GET')return res.status(405).send('Method not allowed');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>PowerSmart reminder preferences</title><main style="font:18px Arial;max-width:540px;margin:70px auto;padding:24px"><h1>Stop quote reminders?</h1><p>This stops automatic SMS and email reminders for your PowerSmart quote.</p><form method="post"><button style="padding:14px 24px;font-size:18px">Stop reminders</button></form></main>');
}
module.exports={handler,unsubscribe,businessHours,nextWindow,expiresAt,messages,eligibility,summary,toggle,work,processRun};
