/* ── WhatsApp order confirmation — the engine (step 6) ───────────────────────
   Does what services/whatsapp/flow.js decides:
     • a new EasyOrder order is held («بانتظار واتساب», no agent) and enrolled;
     • the per-minute worker sends the confirmation, releases the order to the
       agents when the hold ends, sends the reminders, and rescues anything stuck;
     • a customer's tap / message changes the order — ONLY through
       services/orderStatus.js (compare-and-set), so it can never race an agent;
     • an OLD «لا يرد» order the owner chose to message (kind 'recontact') gets
       the same confirmation once — it is never held, released or reminded, and
       a failure leaves the order exactly where it was, with its agent;
     • a customer who answers while the order is «لا يرد» (asks for support,
       wants to cancel, confirms but needs a deposit, or writes) is alive NOW:
       the order goes back to the top of its own agent's work — «جديد», or
       «مراجعة جديدة» for a review account — so she calls without being told.

   Safety, in order of importance:
     1. An order is never lost: every failure path RELEASES it to the agents
        (→ «جديد» + the usual auto-assign), and a watchdog releases anything
        still held after 90 minutes.
     2. A message is never sent twice: a send is claimed (pending → sending)
        before it goes; a reminder is marked done before it goes.
     3. Nothing here throws into the order webhook or Meta's webhook. */
'use strict';

const pool   = require('../../config/db');
const flow   = require('./flow');
const { whatsappNumber } = require('../../utils/phone');

const TEMPLATE = { confirm: 'order_confirm_v1', reminder: 'order_confirm_reminder_v1', language: 'ar' };
const ACTOR = Object.freeze({ label: 'whatsapp', source: 'whatsapp' });
const NO_COMMISSION = Object.freeze({ commission: false });
const LATE_SEND_MIN = 45;        // a confirmation this late is not sent — the order goes to the agents
const LATE_REMINDER_MIN = 6 * 60;
const RECONTACT_STATUS = 'لا يرد';
/* the statuses a batch order may still be in when its message goes: unreached, with its agent */
const RECONTACT_STATUSES = ['لا يرد', 'جديد'];
const NO_ANSWER        = 'لا يرد';
const REVIEW_NEW       = 'مراجعة جديدة';   // a review account's "still to call" (same no-answer cycle as «لا يرد»)
const isRecontact = (f) => f.kind === 'recontact';

/* Loaded lazily: routes/webhooks.js requires this module, and orderStatus pulls half the app. */
let deps = {
  store:       () => require('./db'),
  flows:       () => require('./flowStore'),
  cloud:       () => require('./cloudApi'),
  orderStatus: () => require('../orderStatus'),
  assign:      (orderId, businessId) => require('../../routes/webhooks').autoAssignOrder(orderId, businessId),
  /* the holder's users.agent_track: 'confirmation' | 'review' | 'both' (null = unknown) */
  trackOf:     async (businessId, email) => {
    const { rows: [u] } = await pool.query(
      'SELECT agent_track FROM users WHERE business_id = $1 AND lower(email) = lower($2) LIMIT 1', [businessId, email]);
    return u?.agent_track || null;
  },
  brandOf:     async (businessId) => {
    const { rows: [bp] } = await pool.query('SELECT brand_name FROM business_profile WHERE id = $1', [businessId]);
    return bp?.brand_name || '';
  },
  now:         () => new Date(),
};
function _setDepsForTests(over) { deps = { ...deps, ...over }; }

const log  = (...a) => console.log('[whatsapp flow]', ...a);
const warn = (...a) => console.warn('[whatsapp flow]', ...a);

/* ── a new order arrives ──────────────────────────────────────────────────── */

let lastCapWarnAt = 0;
/** Should this new order wait for WhatsApp? null = no (the order goes to the agents as always). */
async function planForNewOrder(businessId, rawPhone) {
  try {
    const auto = await deps.flows().getAuto(businessId);
    if (!auto.configured || auto.auto_mode === 'off') return null;
    const phone = whatsappNumber(rawPhone);
    if (!phone) return null;                                   // not an Egyptian mobile → agents call
    if (auto.auto_mode === 'test' && !auto.test_phones.includes(phone)) return null;
    /* live on half the customers: the other half stays with the agents alone (the trial's control) */
    if (auto.auto_mode === 'on' && auto.control_half && flow.trialGroup(phone) === 'control') return null;
    /* Meta's limit on customers per 24 hours: past it the order simply goes to the agents */
    const used = await deps.flows().customersMessaged24h(businessId);
    if (used >= flow.dailyLimits(auto.messaging_limit).new_orders) {
      if (Date.now() - lastCapWarnAt > 10 * 60000) {
        lastCapWarnAt = Date.now();
        warn(`daily limit reached (${used} customers in 24 h) — new orders go to the agents until it frees up`);
      }
      return null;
    }
    return { phone, isTest: auto.auto_mode === 'test', split: auto.split_test, holdStatus: flow.HOLD_STATUS };
  } catch (e) {
    warn('plan failed — order goes to the agents:', e.message);
    return null;
  }
}

/** The held order's diary row. False = could not enroll → the caller must release the order. */
async function enrollNewOrder(order, plan) {
  try {
    const variant = flow.variantOf(order.id, plan.split);
    const row = await deps.flows().enroll({
      orderId: order.id, businessId: order.business_id, phone: plan.phone, variant,
      sendAt: flow.sendAt(deps.now(), variant), isTest: plan.isTest,
    });
    if (row) log(`order #${order.id} held — message at ${row.send_at.toISOString?.() ?? row.send_at} (group ${variant}${plan.isTest ? ', test' : ''})`);
    return Boolean(row);
  } catch (e) {
    warn(`enroll failed for order #${order.id}:`, e.message);
    return false;
  }
}

/* ── release: the order goes to the agents, exactly like a fresh one ──────── */

async function releaseOrder(businessId, orderId, reason, error = null) {
  const os = deps.orderStatus();
  let released = false;
  try {
    const r = await os.changeStatus({ businessId, orderId, from: flow.HOLD_STATUS, to: flow.NEW_STATUS, actor: ACTOR, effects: NO_COMMISSION });
    released = r.ok === true;
    if (released) {
      const assigned = await deps.assign(orderId, businessId);
      log(`order #${orderId} released (${reason}) → ${assigned?.AssignedTo || 'no present agent — unassigned'}`);
    } else if (r.code !== 'STATUS_CONFLICT') {
      warn(`release of order #${orderId} (${reason}) did not apply: ${r.code}`);
    }
  } catch (e) {
    warn(`release of order #${orderId} failed:`, e.message);
  }
  await deps.flows().markReleased(orderId, reason, error).catch((e) => warn('markReleased:', e.message));
  return released;
}

/* The customer answered while the order sat in «لا يرد»: put it back in front
   of whoever holds it. Same agent, no commission, compare-and-set — if she moved
   it this very second, hers stands. A review account works «مراجعة جديدة», so
   her order returns there (and stays inside its no-answer cycle); with no
   holder at all it is assigned like a fresh order. Never throws. */
async function liftNoAnswer(f, cur) {
  try {
    const holder = String(cur.row.AssignedTo ?? '').trim() || null;
    let to = flow.NEW_STATUS;
    if (holder && (await deps.trackOf(f.business_id, holder).catch(() => null)) === 'review') to = REVIEW_NEW;
    const r = await deps.orderStatus().changeStatus({
      businessId: f.business_id, orderId: f.order_id, from: NO_ANSWER, to, actor: ACTOR, effects: NO_COMMISSION });
    if (!r.ok) {
      if (r.code !== 'STATUS_CONFLICT') warn(`lift of order #${f.order_id} did not apply: ${r.code}`);
      return false;
    }
    const assigned = holder ? null : await deps.assign(f.order_id, f.business_id);
    log(`order #${f.order_id}: customer answered a «${NO_ANSWER}» order → «${to}» with ${holder || assigned?.AssignedTo || 'no present agent — unassigned'}`);
    return true;
  } catch (e) {
    warn(`lift of order #${f.order_id} failed:`, e.message);
    return false;
  }
}

/* The customer tapped «إلغاء» / «طلب الدعم» on an order WhatsApp itself had
   confirmed and that has not shipped. Nobody holds it, so it would ship against
   their word: it goes back to «جديد» and to an agent (stock returns through
   orderStatus, like any un-confirm). No commission was ever paid on it; the
   agent who confirms it after the call is the one who earns. Never throws. */
async function reopenForAgent(f) {
  try {
    const labelled = await deps.flows().ensureOrdersColumn();
    const r = await deps.orderStatus().changeStatus({
      businessId: f.business_id, orderId: f.order_id, from: flow.CONFIRMED_STATUS, to: flow.NEW_STATUS,
      fields: labelled ? { confirmed_via: null } : {}, actor: ACTOR, effects: NO_COMMISSION });
    if (!r.ok) {
      if (r.code !== 'STATUS_CONFLICT') warn(`reopen of order #${f.order_id} did not apply: ${r.code}`);
      return false;                                              // shipped / moved this very second → the tag still tells the team
    }
    const assigned = await deps.assign(f.order_id, f.business_id);
    log(`order #${f.order_id}: customer went back on a WhatsApp confirmation → «${flow.NEW_STATUS}» with ${assigned?.AssignedTo || 'no present agent — unassigned'}`);
    return true;
  } catch (e) {
    warn(`reopen of order #${f.order_id} failed:`, e.message);
    return false;
  }
}

/* WhatsApp confirmed the order within minutes; the customer rating arrived
   later and it is a weak one. Before it ships it goes to an agent for the
   deposit, exactly as if the rating had been known at the tap. Never throws
   past the worker's guard. */
async function depositAfterConfirm(f) {
  const cur = await deps.orderStatus().loadOrder(f.business_id, f.order_id);
  if (!cur || String(cur.status).trim() !== flow.CONFIRMED_STATUS
      || String(cur.row.confirmed_via ?? '') !== 'whatsapp' || !flow.isWeak(cur.row)) return false;
  await showOnOrder(f, { tag: 'deposit' });
  if (!(await reopenForAgent(f))) return false;
  await deps.flows().markReply(f.order_id, { outcome: 'deposit_needed', tag: 'deposit' });
  log(`order #${f.order_id}: rated weak after its WhatsApp confirmation → to an agent for the deposit`);
  /* free text is only allowed inside the 24 hours their tap opened */
  if (f.outcome_at && deps.now() - new Date(f.outcome_at) < 23 * 3600000) await reply(f, 'deposit');
  return true;
}

/* ── the worker ───────────────────────────────────────────────────────────── */

async function logOut(f, kind, template, sent, error) {
  return deps.store().logOutbound({
    businessId: f.business_id, orderId: f.order_id, kind, phone: f.phone, template,
    waMessageId: sent?.message_id || null, status: sent ? 'sent' : 'failed',
    errorCode: Number.isInteger(error?.code) ? error.code : null, errorText: error?.metaMessage || error?.message || null,
    createdBy: 'whatsapp',
  }).catch((e) => warn('message log:', e.message));
}

/* The message will not go (or did not). A held order goes to the agents; an old
   «لا يرد» order was never taken from its agent, so only the diary is closed. */
function giveUp(f, reason, error = null) {
  return isRecontact(f)
    ? deps.flows().markReleased(f.order_id, reason, error)
    : releaseOrder(f.business_id, f.order_id, reason, error);
}

async function sendConfirmation(f) {
  const now = deps.now();
  const { GraphError } = deps.cloud();
  const recontact = isRecontact(f);
  const cur = await deps.orderStatus().loadOrder(f.business_id, f.order_id);
  const st = String(cur?.status ?? '').trim();
  if (!cur || (recontact ? !RECONTACT_STATUSES.includes(st) : st !== flow.HOLD_STATUS)) {
    await deps.flows().markReleased(f.order_id, 'moved');          // someone already handled the order
    return 'moved';
  }
  if ((now - new Date(f.send_at)) / 60000 > LATE_SEND_MIN) { await giveUp(f, 'late'); return 'late'; }
  const auto = await deps.flows().getAuto(f.business_id);
  if (auto.auto_mode === 'off' || !auto.configured) { await giveUp(f, 'switched_off'); return 'switched_off'; }
  const built = flow.templateComponents('confirm', cur.row);
  if (!built.ok) { await giveUp(f, built.reason); return built.reason; }

  const settings = await deps.store().getSettings(f.business_id);
  try {
    const sent = await deps.cloud().sendTemplate(settings, { to: f.phone, name: TEMPLATE.confirm, language: TEMPLATE.language, components: built.components });
    await logOut(f, 'confirm', TEMPLATE.confirm, sent, null);
    if (recontact) {
      await deps.flows().markRecontactSent(f.order_id, now);
      log(`order #${f.order_id}: confirmation sent to a waiting «${st}» order (stays with its agent)`);
      return 'sent';
    }
    const s = flow.scheduleAfterSend(now);
    await deps.flows().markSent(f.order_id, { sentAt: now, holdUntil: s.hold_until, reminder1At: s.reminder1_at, reminder2At: s.reminder2_at });
    log(`order #${f.order_id}: confirmation sent — held until ${s.hold_until.toISOString()}`);
    return 'sent';
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    await logOut(f, 'confirm', TEMPLATE.confirm, null, e);
    await giveUp(f, 'send_failed', `#${e.code} ${e.metaMessage || e.message}`);
    return 'send_failed';
  }
}

async function sendReminder(f, n) {
  const now = deps.now();
  const flows = deps.flows();
  const { GraphError } = deps.cloud();
  const dueAt = new Date(n === 1 ? f.reminder1_at : f.reminder2_at);
  const skip = async (why) => { await flows.markReminder(f.order_id, n, false); return why; };

  if ((now - dueAt) / 60000 > LATE_REMINDER_MIN) return skip('late');
  if (flow.outsideQuietHours(now).getTime() > now.getTime()) return 'quiet';           // try again after 10:00
  const cur = await deps.orderStatus().loadOrder(f.business_id, f.order_id);
  if (!cur || !flow.canRemind({ order: cur.row, flow: f })) return skip('not_needed');
  const auto = await flows.getAuto(f.business_id);
  if (auto.auto_mode === 'off' || !auto.configured) return skip('switched_off');
  const settings = await deps.store().getSettings(f.business_id);
  /* owner's rule: the second reminder stops if Meta lowers the number's quality */
  if (n === 2 && ['YELLOW', 'RED'].includes(String(settings?.quality_rating || '').toUpperCase())) return skip('quality');
  const built = flow.templateComponents('reminder', cur.row);
  if (!built.ok) return skip(built.reason);

  if (!(await flows.markReminder(f.order_id, n, true))) return 'taken';                 // marked BEFORE the send
  try {
    const sent = await deps.cloud().sendTemplate(settings, { to: f.phone, name: TEMPLATE.reminder, language: TEMPLATE.language, components: built.components });
    await logOut(f, 'reminder', TEMPLATE.reminder, sent, null);
    log(`order #${f.order_id}: reminder ${n} sent`);
    return 'sent';
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    await logOut(f, 'reminder', TEMPLATE.reminder, null, e);
    return 'send_failed';
  }
}

let running = false;
let ticks = 0;
/** One pass of the worker. Never throws; never overlaps itself. */
async function tick() {
  if (running) return { skipped: true };
  running = true;
  const out = { sent: 0, released: 0, reminders: 0, rescued: 0 };
  const guard = async (what, fn) => { try { return await fn(); } catch (e) { warn(`${what}:`, e.message); return null; } };
  try {
    const flows = deps.flows();
    const now = deps.now();
    for (const f of (await guard('due sends', () => flows.claimDueSends(now))) || []) {
      if ((await guard(`send #${f.order_id}`, () => sendConfirmation(f))) === 'sent') out.sent += 1;
    }
    for (const f of (await guard('due releases', () => flows.dueReleases(now))) || []) {
      if (isRecontact(f)) { await guard(`close #${f.order_id}`, () => flows.markReleased(f.order_id, 'stuck')); continue; }   // never held → nothing to release
      await guard(`release #${f.order_id}`, () => releaseOrder(f.business_id, f.order_id, f.state === 'waiting' ? 'timeout' : 'stuck'));
      out.released += 1;
    }
    for (const n of [1, 2]) {
      for (const f of (await guard(`due reminders ${n}`, () => flows.dueReminders(now, n))) || []) {
        if ((await guard(`reminder #${f.order_id}`, () => sendReminder(f, n))) === 'sent') out.reminders += 1;
      }
    }
    for (const f of (await guard('late ratings', () => flows.confirmedNowWeak())) || []) {
      await guard(`deposit #${f.order_id}`, () => depositAfterConfirm(f));
    }
    ticks += 1;
    if (ticks % 5 === 1) await guard('orders columns', () => flows.ensureOrdersColumn());   // retried here if adding them was blocked at boot
    const stranded = ticks % 5 === 1 ? await guard('watchdog', () => flows.strandedHeldOrders(flow.HOLD_STATUS)) : [];
    for (const o of stranded || []) {
      await guard(`rescue #${o.order_id}`, () => releaseOrder(o.business_id, o.order_id, 'watchdog'));
      out.rescued += 1;
    }
  } finally {
    running = false;
  }
  return out;
}

/* Ask Meta how the number is doing — quality and the daily limit tier — and
   store it: the limit guard and the "2nd reminder stops on low quality" rule
   read the stored values. One business (the owner just pressed a button) or
   every business whose flow is on (twice an hour). Two GETs each. Never throws. */
async function refreshHealth(businessId = null) {
  let done = 0;
  try {
    for (const s of await deps.flows().liveSettings(businessId)) {
      try {
        const info = await deps.cloud().checkPhoneNumber(s);
        const limit = await deps.cloud().messagingLimit(s).catch(() => null);
        await deps.flows().saveHealth(s.business_id, { quality: info?.quality_rating || null, limit });
        done += 1;
      } catch (e) {
        warn(`health check for business ${s.business_id}:`, e.message);
      }
    }
  } catch (e) {
    warn('health check:', e.message);
  }
  return done;
}

/* ── the customer answers ─────────────────────────────────────────────────── */

async function reply(f, key) {
  const text = flow.replyText(key, { brand: await deps.brandOf(f.business_id).catch(() => '') });
  if (!text) return;
  const { GraphError } = deps.cloud();
  try {
    const settings = await deps.store().getSettings(f.business_id);
    const sent = await deps.cloud().sendText(settings, { to: f.phone, body: text });
    await logOut(f, 'reply', null, sent, null);
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    await logOut(f, 'reply', null, null, e);
  }
}

/* The agent's view: the tag and the customer's words go on the order row itself. Best effort. */
async function showOnOrder(f, { tag = null, note = null }) {
  if (!tag && !note) return;
  try {
    await deps.flows().showOnOrder(f.business_id, f.order_id, { tag, note });
  } catch (e) {
    warn(`tag on order #${f.order_id}:`, e.message);
  }
}

async function handleTap(f, action) {
  const os = deps.orderStatus();
  const flows = deps.flows();
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await os.loadOrder(f.business_id, f.order_id);
    if (!cur) return { handled: false, why: 'order_gone' };
    const d = flow.decideTap({ action, order: cur.row });

    if (d.type === 'confirm') {
      /* the «واتساب» label needs orders.confirmed_via; without it the confirmation still happens */
      const labelled = await flows.ensureOrdersColumn();
      const r = await os.changeStatus({
        businessId: f.business_id, orderId: f.order_id, from: cur.status, to: flow.CONFIRMED_STATUS,
        fields: labelled ? { AssignedTo: null, confirmed_via: 'whatsapp' } : { AssignedTo: null },
        actor: ACTOR, effects: NO_COMMISSION,
      });
      if (!r.ok) {
        if (r.code === 'STATUS_CONFLICT') continue;              // an agent moved it this very second → decide again
        warn(`confirm of order #${f.order_id} failed: ${r.code}`);
        return { handled: false, why: r.code };
      }
      await flows.markReply(f.order_id, { outcome: 'confirmed', done: true });
      log(`order #${f.order_id}: customer confirmed on WhatsApp`);
      await reply(f, d.reply);
      return { handled: true, type: d.type };
    }

    await showOnOrder(f, { tag: d.tag });                        // on the row BEFORE an agent gets the order
    if (d.release && String(cur.status).trim() === flow.HOLD_STATUS) {
      await releaseOrder(f.business_id, f.order_id, d.tag);     // → «جديد» + an agent, now
    } else if (d.release && String(cur.status).trim() === NO_ANSWER) {
      await liftNoAnswer(f, cur);                               // → back on top of her work, now
    } else if (d.reopen) {
      await reopenForAgent(f);                                  // → it must not ship before somebody calls
    }
    const repeat = d.tag ? f.tag === d.tag : f.outcome === 'confirmed' && d.type === 'already_confirmed';
    await flows.markReply(f.order_id, { outcome: d.reopen ? d.outcome : (d.release ? d.type : null), tag: d.tag || null });
    log(`order #${f.order_id}: customer tapped «${action}» → ${d.type}`);
    if (!repeat) await reply(f, d.reply);                       // tapping the same button again gets no second answer
    return { handled: true, type: d.type };
  }
  return { handled: false, why: 'conflict' };
}

/* Free text (or a voice note, a picture…) instead of a button = «طلب الدعم». */
async function handleText(f, ev) {
  const flows = deps.flows();
  const cur = await deps.orderStatus().loadOrder(f.business_id, f.order_id);
  const status = String(cur?.status ?? '').trim();
  const open = flow.TAP_DECIDES.includes(status);
  const firstText = !f.text_replied;                            // read before the diary row is updated
  const tag = open && !f.tag ? 'support' : null;
  await showOnOrder(f, { tag });
  if (status === flow.HOLD_STATUS) await releaseOrder(f.business_id, f.order_id, 'support');
  else if (status === NO_ANSWER) await liftNoAnswer(f, cur);
  const r = await flows.markReply(f.order_id, {
    tag, text: ev.reply || null,
    outcome: open && !f.outcome ? 'support_requested' : null, textReplied: true,
  });
  await showOnOrder(f, { note: r?.customer_text || ev.reply || null });
  if (firstText) await reply(f, 'text');                        // one acknowledgement, not one per message
  return { handled: true, type: 'text' };
}

/** A message from a customer that Meta delivered (already stored by the webhook). Never throws. */
async function handleInbound(businessId, ev) {
  try {
    const flows = deps.flows();
    const parsed = ev.kind === 'button' ? flow.parsePayload(ev.payload) : null;
    if (parsed) {
      const f = await flows.getByOrder(businessId, parsed.orderId);
      if (!f || f.phone !== String(ev.from)) return { handled: false, why: 'not_their_order' };
      return await handleTap(f, parsed.action);
    }
    const f = await flows.latestByPhone(businessId, String(ev.from));
    if (!f) return { handled: false, why: 'no_flow' };
    return await handleText(f, ev);
  } catch (e) {
    warn('inbound failed:', e.message);
    return { handled: false, why: 'error' };
  }
}

/** Meta says our confirmation could not be delivered (no WhatsApp on the number, …). Never throws. */
async function handleFailedStatus(businessId, waMessageId) {
  try {
    const msg = await deps.store().messageByWamid(businessId, waMessageId);
    if (!msg || msg.kind !== 'confirm' || !msg.order_id) return false;
    const f = await deps.flows().getByOrder(businessId, msg.order_id);
    if (!f || f.state !== 'waiting') return false;
    await releaseOrder(businessId, msg.order_id, msg.error_code === 131026 ? 'no_whatsapp' : 'undelivered', msg.error_text);
    return true;
  } catch (e) {
    warn('failed-status handling:', e.message);
    return false;
  }
}

module.exports = {
  TEMPLATE, RECONTACT_STATUS, planForNewOrder, enrollNewOrder, releaseOrder, sendConfirmation, sendReminder, tick,
  handleInbound, handleFailedStatus, liftNoAnswer, depositAfterConfirm, refreshHealth, _setDepsForTests,
};
