'use strict';

/* Unit tests for services/deliveryBonus.js pure helpers — no database needed.
   Run: npm test   (from backend/)  or  node --test src/services/deliveryBonus.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { pieces, groupOf, fmt } = require('./deliveryBonus');

test('pieces: the order quantity, never below 1', () => {
  assert.equal(pieces(1), 1);
  assert.equal(pieces(2), 2);
  assert.equal(pieces('3'), 3);
  assert.equal(pieces(0), 1);
  assert.equal(pieces(null), 1);
  assert.equal(pieces(undefined), 1);
  assert.equal(pieces('abc'), 1);
  assert.equal(pieces(-4), 1);
});

test('groupOf: which list an order shows in', () => {
  assert.equal(groupOf('تم التوصيل'), 'delivered');
  assert.equal(groupOf(' تم التوصيل '), 'delivered');
  assert.equal(groupOf('تم الإرجاع'), 'returned');
  assert.equal(groupOf('جاري الإعادة'), 'returned');
  assert.equal(groupOf('تم التأكيد'), 'pending');
  assert.equal(groupOf('تم الشحن'), 'pending');
  assert.equal(groupOf('مغلق - لن يشحن'), 'cancelled');
  assert.equal(groupOf('ملغي'), 'cancelled');
  assert.equal(groupOf(null), 'cancelled');
});

test('fmt: short numbers for ledger descriptions', () => {
  assert.equal(fmt(5), '5');
  assert.equal(fmt('5.00'), '5');
  assert.equal(fmt(2.5), '2.5');
  assert.equal(fmt(null), '0');
});
