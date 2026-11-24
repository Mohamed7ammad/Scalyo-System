'use strict';

/* Unit tests for utils/phone.js — pure, no DB.
   Run: npm test (from backend/)  or  node --test src/utils/phone.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { whatsappNumbers, whatsappNumber, localForm } = require('./phone');

const N = '201001488462';

test('every shape the customer types gives the same WhatsApp number', () => {
  for (const raw of [
    '01001488462', '+201001488462', '00201001488462', '201001488462', '+2 01001488462',
    '1001488462',            // trunk 0 lost
    '10014884620',           // 0 typed at the END (RTL input)
    '٠١٠٠١٤٨٨٤٦٢',           // Arabic digits
    '۰۱۰۰۱۴۸۸۴۶۲',           // Persian digits
    '010 0148 8462', '010-0148-8462', '(010) 0148.8462',
    '2001001488462',         // "20 0100…": trunk 0 typed after the code
    '01001488462 العنوان شارع التحرير',
    1001488462,              // stored as a number
  ]) {
    assert.equal(whatsappNumber(raw), N, `input ${JSON.stringify(raw)}`);
  }
});

test('all four Egyptian mobile prefixes', () => {
  assert.equal(whatsappNumber('01012345678'), '201012345678');
  assert.equal(whatsappNumber('01112345678'), '201112345678');
  assert.equal(whatsappNumber('01212345678'), '201212345678');
  assert.equal(whatsappNumber('01512345678'), '201512345678');
});

test('two numbers in one field give both, once each', () => {
  assert.deepEqual(whatsappNumbers('01001488462#01112345678'), [N, '201112345678']);
  assert.deepEqual(whatsappNumbers('01001488462//01112345678'), [N, '201112345678']);
  assert.deepEqual(whatsappNumbers('0100148846201112345678'), [N, '201112345678']);   // glued
  assert.deepEqual(whatsappNumbers('01001488462 / 01001488462'), [N]);                // same twice
});

test('anything that is not an Egyptian mobile gives nothing', () => {
  for (const raw of [null, undefined, '', 'مفيش', '0233334444', '+966501234567', '0131234567', '12345', '0100148']) {
    assert.equal(whatsappNumber(raw), null, `input ${JSON.stringify(raw)}`);
  }
});

test('localForm shows the number the way the team reads it', () => {
  assert.equal(localForm(N), '01001488462');
  assert.equal(localForm('966501234567'), '966501234567');
  assert.equal(localForm(null), '');
});
