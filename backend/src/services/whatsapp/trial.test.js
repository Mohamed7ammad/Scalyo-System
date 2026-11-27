'use strict';

/* Unit tests for the half-and-half trial report. Pure — no database, no network.
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/trial.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../config/db');
pool.query = async () => ({ rows: [], rowCount: 0 });          // nothing here may reach a database

const trial = require('./trial');

const WA = '01000000002', AGENTS = '01000000009';              // last digit 0–7 → WhatsApp group; 8 or 9 → agents

test('every order counts in its customer\'s half, whatever became of it', () => {
  const r = trial.summarize([
    { Phone: WA, Status: 'تم التوصيل', confirmed_via: 'whatsapp' },
    { Phone: WA, Status: 'تم الإرجاع', confirmed_via: 'whatsapp' },
    { Phone: WA, Status: 'تم الشحن', confirmed_via: null },          // WhatsApp half, but an agent confirmed it
    { Phone: WA, Status: 'تم التأكيد', confirmed_via: 'whatsapp' },
    { Phone: WA, Status: 'تم الرفض' },
    { Phone: WA, Status: 'جديد' },                                   // e.g. past the daily limit → still this half
    { Phone: AGENTS, Status: 'تم التوصيل' },
    { Phone: AGENTS, Status: 'جاري الإعادة' },
    { Phone: AGENTS, Status: 'لا يرد' },
    { Phone: AGENTS, Status: 'ملغي - عدم رد نهائي' },
    { Phone: AGENTS, Status: 'مؤجل' },
    { Phone: '0225551234', Status: 'تم التوصيل' },                   // landline → in neither half
  ]);
  assert.deepEqual(r.wa, { orders: 6, confirmed: 4, wa_confirmed: 3, rejected: 1, no_answer: 0, open: 1,
    shipped: 3, in_transit: 1, delivered: 1, returned: 1 });
  assert.deepEqual(r.control, { orders: 5, confirmed: 2, wa_confirmed: 0, rejected: 0, no_answer: 2, open: 1,
    shipped: 2, in_transit: 0, delivered: 1, returned: 1 });
  assert.equal(r.no_mobile, 1);
});

test('the same customer is in the same half however the number was typed', () => {
  const r = trial.summarize([
    { Phone: '+20 100 000 0002', Status: 'جديد' }, { Phone: '٠١٠٠٠٠٠٠٠٠٢', Status: 'جديد' }, { Phone: '201000000002', Status: 'جديد' },
  ]);
  assert.equal(r.wa.orders, 3);
  assert.equal(r.control.orders, 0);
});
