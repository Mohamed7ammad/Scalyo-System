'use strict';

/* «توزيع بالأعداد» planner — pure, no DB.
   Run: npm test (from backend/)  or  node --test src/services/orderSplit.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { planSplit, personResolver } = require('./orderSplit');

/* مريم has a review account Dina; هنا has Hana2. */
const USERS = [
  { id: '1', email: 'mariam@x', name: 'مريم' },
  { id: '2', email: 'dina@x',   name: 'Dina', main_account_id: '1' },
  { id: '3', email: 'hana@x',   name: 'هنا' },
  { id: '4', email: 'hana2@x',  name: 'Hana2', main_account_id: '3' },
  { id: '5', email: 'manar@x',  name: 'منار' },
  { id: '6', email: 'fedaa@x',  name: 'فداء', allowed: ['ساعة'] },
];
const { personOfUser, personOfEmail } = personResolver(USERS);
const target = (id, quota) => {
  const u = USERS.find((x) => x.id === id);
  return { id, name: u.name, email: u.email, person: personOfUser(u).key, allowed: u.allowed ?? [], quota };
};
let seq = 0;
const orders = (holder, n, product = 'داش كام') =>
  Array.from({ length: n }, () => ({ id: ++seq, holder, product, status: 'لا يرد' }));

const holderOf = (o) => personOfEmail(o.holder).key;
function check(res, targets) {
  assert.equal(res.error, null, res.error);
  for (const t of targets) {
    const got = res.byTarget.get(t.id);
    assert.equal(got.length, t.quota, `${t.name} gets exactly her number`);
    for (const o of got) assert.notEqual(holderOf(o), t.person, `#${o.id} went back to its own holder (${t.name})`);
  }
  const all = [...res.byTarget.values()].flat().map((o) => o.id);
  assert.equal(new Set(all).size, all.length, 'no order given twice');
}

test('the owner\'s example: 130, 30 with مريم — hers go only to the others', () => {
  const list = [...orders('mariam@x', 30), ...orders('hana@x', 40), ...orders('manar@x', 60)];
  const targets = [target('1', 30), target('3', 40), target('5', 60)];
  check(planSplit({ orders: list, targets, count: 130, personOfEmail }), targets);
});

test('a review account is the same girl: Dina\'s orders never go to مريم, and مريم\'s never to Dina', () => {
  const list = [...orders('dina@x', 10), ...orders('mariam@x', 10), ...orders('manar@x', 20)];
  const targets = [target('3', 20), target('2', 10), target('5', 10)];
  const res = planSplit({ orders: list, targets, count: 40, personOfEmail });
  check(res, targets);
  assert.ok(res.byTarget.get('2').every((o) => o.holder === 'manar@x'), 'Dina (= مريم) only gets منار\'s');
  /* مريم + Dina hold 20 together; with مريم and Dina both picked only منار can take them → refused. */
  const bad = planSplit({ orders: list, targets: [target('1', 20), target('2', 10), target('5', 10)], count: 40, personOfEmail });
  assert.match(bad.error, /الـ 20 اللي مع مريم/);
});

test('only part of the filter: the first N in the given order are taken', () => {
  const list = orders('manar@x', 50);
  const targets = [target('1', 10), target('3', 10)];
  const res = planSplit({ orders: list, targets, count: 20, personOfEmail });
  check(res, targets);
  const ids = [...res.byTarget.values()].flat().map((o) => o.id).sort((a, b) => a - b);
  assert.deepEqual(ids, list.slice(0, 20).map((o) => o.id));
});

test('impossible: more for a girl than the orders not hers → names her and the real limit', () => {
  const list = [...orders('mariam@x', 90), ...orders('hana@x', 30)];
  const targets = [target('1', 60), target('3', 60)];
  const res = planSplit({ orders: list, targets, count: 120, personOfEmail });
  assert.equal(res.byTarget, null);
  assert.match(res.error, /مريم ممكن تاخد 30 بس من الـ 120/);
});

test('impossible: one holder has more than the others can take together', () => {
  const list = [...orders('mariam@x', 70), ...orders('hana@x', 10)];
  const targets = [target('1', 10), target('3', 35), target('5', 35)];
  /* مريم: 10 ≤ 10 not hers; but her 70 need 70 room with هنا+منار = 70 → fine. Shift: */
  check(planSplit({ orders: list, targets, count: 80, personOfEmail }), targets);
  const tight = [target('1', 20), target('3', 30), target('5', 30)];
  const res = planSplit({ orders: list, targets: tight, count: 80, personOfEmail });
  assert.equal(res.byTarget, null);
  assert.match(res.error, /مريم ممكن تاخد 10 بس|الـ 70 اللي مع مريم/);
});

test('unassigned / unknown holders can go to anyone', () => {
  const list = [...orders(null, 5), ...orders('old@x', 5)];
  const targets = [target('1', 4), target('3', 6)];
  check(planSplit({ orders: list, targets, count: 10, personOfEmail }), targets);
});

test('product restriction respected: فداء only takes «ساعة»', () => {
  const list = [...orders('manar@x', 6, 'داش كام'), ...orders('manar@x', 4, 'ساعة ذكية')];
  const targets = [target('6', 4), target('1', 6)];
  const res = planSplit({ orders: list, targets, count: 10, personOfEmail });
  check(res, targets);
  assert.ok(res.byTarget.get('6').every((o) => o.product.includes('ساعة')));
  const bad = planSplit({ orders: list, targets: [target('6', 5), target('1', 5)], count: 10, personOfEmail });
  assert.match(bad.error, /فداء ممكن تاخد 4 بس/);
});

test('a bigger realistic split stays exact (173 orders, 5 girls)', () => {
  const list = [...orders('mariam@x', 41), ...orders('fedaa@x', 28), ...orders('hana@x', 26),
    ...orders('dina@x', 8), ...orders('hana2@x', 11), ...orders('manar@x', 19), ...orders(null, 40)];
  const targets = [target('1', 40), target('3', 40), target('5', 53), target('2', 20), target('4', 20)];
  check(planSplit({ orders: list, targets, count: 173, personOfEmail }), targets);
});
