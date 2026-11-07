'use strict';

/* Unit tests for the pure readers in services/bostaShippingFee.js (no DB, no
   Bosta). The paymentInfo fixture mirrors the real doc of AWB 6561671166
   (delivered 2026-11-04, paid with Bosta «Flash» at the door, cod 0). */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fee    = require('./bostaShippingFee');

test('electronic payment at the door → { type, ref }', () => {
  const doc = {
    cod: 0, shipmentFees: 102,
    paymentInfo: { paymentOrderId: 'QNMik4kolks9ufNXQgeKb', paymentType: 'flash', transactionId: 'f8e717a7-a530-4947-9457-d920d8fdfee4' },
  };
  assert.deepEqual(fee.extractPaymentInfo(doc), { type: 'flash', ref: 'f8e717a7-a530-4947-9457-d920d8fdfee4' });
});

test('no paymentInfo → null (cash on delivery, or COD edited without a payment)', () => {
  assert.equal(fee.extractPaymentInfo({ cod: 1689 }), null);
  assert.equal(fee.extractPaymentInfo({ cod: 0, paymentInfo: {} }), null);
  assert.equal(fee.extractPaymentInfo({ cod: 0, paymentInfo: null }), null);
  assert.equal(fee.extractPaymentInfo(null), null);
});

test('payment reference without a type still counts as electronic', () => {
  assert.deepEqual(fee.extractPaymentInfo({ paymentInfo: { paymentOrderId: 'abc' } }), { type: 'electronic', ref: 'abc' });
});

test('the shipping fee reader is unchanged', () => {
  assert.equal(fee.extractPriceAfterVat({ shipmentFees: 102 }), 116.28, '102 + 14% VAT');
});
