'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   «توزيع بالأعداد» — the Team Leader splits the «لا يرد» orders of her current
   filter between the agents she picks, with an exact count for each (owner,
   2026-11-28). Before: tick every order by hand, transfer, repeat per agent.

   The one hard rule: an order NEVER goes back to the agent who holds it now.
   "Agent" means the PERSON: a review account is the same girl as her main
   account (users.main_account_id — Dina is مريم, Hana2 is هنا …), so an order
   with Dina can't go to مريم either, and the other way round.
   Only the current holder is excluded — not earlier holders (owner's word).

   When she splits fewer than the whole filter, the oldest go first (or the
   newest, her choice). Product restrictions (allowed_products) are respected.
   The plan is a small max-flow (order groups → agents), so any split that CAN
   be done is found, and one that can't gets a plain reason.
   Status is untouched — only the holder changes, like the manual transfer.  */

const { agentAllowsProduct } = require('../utils/productRouting');

const SPLIT_STATUSES = ['لا يرد', 'مراجعة جديدة'];
const MAX_TARGETS = 20;

class SplitError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const norm = (e) => String(e ?? '').trim().toLowerCase();

/* person key + display name for a holder email. */
function personResolver(users) {
  const byEmail = new Map(users.map((u) => [norm(u.email), u]));
  const byId = new Map(users.map((u) => [String(u.id), u]));
  const personOfUser = (u) => {
    const main = u.main_account_id && byId.get(String(u.main_account_id));
    const p = main || u;
    return { key: `u:${p.id}`, name: p.name };
  };
  const personOfEmail = (email) => {
    if (!norm(email)) return { key: 'none', name: 'بدون موظفة' };
    const u = byEmail.get(norm(email));
    return u ? personOfUser(u) : { key: `e:${norm(email)}`, name: String(email).split('@')[0] };
  };
  return { personOfUser, personOfEmail };
}

/* Max-flow (Edmonds–Karp) on a tiny dense graph. cap[i][j] is mutated. */
function maxFlow(cap, s, t) {
  const n = cap.length;
  let flow = 0;
  for (;;) {
    const prev = new Array(n).fill(-1);
    prev[s] = s;
    const q = [s];
    while (q.length && prev[t] === -1) {
      const u = q.shift();
      for (let v = 0; v < n; v++) if (prev[v] === -1 && cap[u][v] > 0) { prev[v] = u; q.push(v); }
    }
    if (prev[t] === -1) return flow;
    let f = Infinity;
    for (let v = t; v !== s; v = prev[v]) f = Math.min(f, cap[prev[v]][v]);
    for (let v = t; v !== s; v = prev[v]) { cap[prev[v]][v] -= f; cap[v][prev[v]] += f; }
    flow += f;
  }
}

/* Pure planner.
   orders  — [{ id, holder, product, status }] already in pick order (first = taken first)
   targets — [{ id, name, email, person, allowed, quota }]
   personOfEmail — holder email → { key, name }
   Returns { picked, byTarget: Map(targetId → [order]), error? } */
function planSplit({ orders, targets, count, personOfEmail }) {
  const picked = orders.slice(0, count).map((o) => ({ ...o, holderPerson: personOfEmail(o.holder) }));
  const okFor = (t, o) => t.person !== o.holderPerson.key && agentAllowsProduct(t.allowed, o.product);

  /* Group orders that have exactly the same allowed targets. */
  const groups = new Map();
  for (const o of picked) {
    const sig = targets.map((t) => (okFor(t, o) ? '1' : '0')).join('');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(o);
  }
  const gl = [...groups.entries()];
  const G = gl.length, T = targets.length, S = 0, SINK = 1 + G + T;
  const cap = Array.from({ length: SINK + 1 }, () => new Array(SINK + 1).fill(0));
  gl.forEach(([sig, list], gi) => {
    cap[S][1 + gi] = list.length;
    for (let ti = 0; ti < T; ti++) if (sig[ti] === '1') cap[1 + gi][1 + G + ti] = list.length;
  });
  targets.forEach((t, ti) => { cap[1 + G + ti][SINK] = t.quota; });
  const orig = cap.map((r) => [...r]);
  const flow = maxFlow(cap, S, SINK);

  if (flow < picked.length) return { picked, byTarget: null, error: explain(picked, targets, okFor) };

  const byTarget = new Map(targets.map((t) => [t.id, []]));
  gl.forEach(([, list], gi) => {
    let k = 0;
    for (let ti = 0; ti < T; ti++) {
      const used = orig[1 + gi][1 + G + ti] - cap[1 + gi][1 + G + ti];
      for (let n = 0; n < used; n++) byTarget.get(targets[ti].id).push(list[k++]);
    }
  });
  return { picked, byTarget, error: null };
}

/* Why a split can't be done, in the Team Leader's words. */
function explain(picked, targets, okFor) {
  for (const t of targets) {
    const can = picked.filter((o) => okFor(t, o)).length;
    if (t.quota > can) {
      return `${t.name} ممكن تاخد ${can} بس من الـ ${picked.length} — الباقي معاها أصلاً${
        t.allowed?.length ? ' أو منتجه مش مسموح لها' : ''}. قلّلي عددها أو زوّدي غيرها`;
    }
  }
  const byHolder = new Map();
  for (const o of picked) {
    const k = o.holderPerson.key;
    if (!byHolder.has(k)) byHolder.set(k, { name: o.holderPerson.name, list: [] });
    byHolder.get(k).list.push(o);
  }
  for (const { name, list } of byHolder.values()) {
    const room = targets.filter((t) => list.some((o) => okFor(t, o))).reduce((s, t) => s + t.quota, 0);
    if (list.length > room) {
      return `الـ ${list.length} اللي مع ${name} لازم يروحوا لبنات غيرها، والبنات التانيين عليهم ${room} بس — زوّدي أعدادهم`;
    }
  }
  return 'التقسيم ده مش هينفع بالأعداد دي — غيّري الأعداد أو البنات';
}

/* ── DB side ──────────────────────────────────────────────────────────────────
   scope = { where, params } from the orders list's own filter builder, so the
   split covers exactly what she sees. body = { count, newest, allocations:
   [{ agentId, count }], dryRun }. Without allocations → just the summary. */
async function splitOrders(pool, { businessId, scope, body, actor }) {
  const newest = body?.newest === true;
  const allocations = Array.isArray(body?.allocations) ? body.allocations : [];
  const dryRun = body?.dryRun !== false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('orders_split'), $1)`, [businessId]);

    const { rows: users } = await client.query(
      `SELECT id::text AS id, email, COALESCE(NULLIF(TRIM(name), ''), SPLIT_PART(email, '@', 1)) AS name,
              main_account_id, agent_track, COALESCE(is_absent, FALSE) AS is_absent,
              COALESCE(allowed_products, '{}'::text[]) AS allowed,
              ('agent' = ANY(COALESCE(roles, ARRAY[role])) AND COALESCE(is_active, TRUE)) AS can_receive
         FROM users WHERE business_id = $1`, [businessId]);
    const { personOfUser, personOfEmail } = personResolver(users);

    const p = scope.params.length;
    const { rows: inFilter } = await client.query(
      `SELECT id, "AssignedTo" AS holder, "ProductName" AS product, btrim("Status") AS status
         FROM orders
        WHERE ${scope.where} AND btrim("Status") = ANY($${p + 1}::text[])
        ORDER BY "createdAt" ${newest ? 'DESC' : 'ASC'}, id ${newest ? 'DESC' : 'ASC'}`,
      [...scope.params, SPLIT_STATUSES]);
    const { rows: [{ n: otherStatus }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE ${scope.where} AND NOT (btrim("Status") = ANY($${p + 1}::text[]))`,
      [...scope.params, SPLIT_STATUSES]);

    /* Who holds them now (by person) + the agents she can pick. */
    const holders = new Map();
    for (const o of inFilter) {
      const h = personOfEmail(o.holder);
      if (!holders.has(h.key)) holders.set(h.key, { key: h.key, name: h.name, count: 0 });
      holders.get(h.key).count += 1;
    }
    const agents = users.filter((u) => u.can_receive).map((u) => {
      const person = personOfUser(u);
      return {
        id: u.id, name: u.name, email: u.email, track: u.agent_track, is_absent: u.is_absent,
        person: person.key, person_name: person.name,
        held: holders.get(person.key)?.count ?? 0,
      };
    }).sort((a, b) => Number(a.is_absent) - Number(b.is_absent) || a.name.localeCompare(b.name, 'ar'));

    const summary = {
      total: inFilter.length,
      other_status: otherStatus,
      statuses: SPLIT_STATUSES,
      holders: [...holders.values()].sort((a, b) => b.count - a.count),
      agents,
    };
    if (!allocations.length) { await client.query('ROLLBACK'); return { ...summary, dryRun: true }; }

    /* Validate her numbers. */
    const count = Number(body?.count);
    if (!Number.isInteger(count) || count < 1) throw new SplitError(400, 'اكتبي عدد الطلبات اللي هتتوزع');
    if (count > inFilter.length) throw new SplitError(400, `الفلتر فيه ${inFilter.length} طلب بس`);
    const seen = new Set();
    const targets = [];
    for (const a of allocations) {
      const id = String(a?.agentId ?? '');
      const quota = Number(a?.count);
      if (!Number.isInteger(quota) || quota < 0) throw new SplitError(400, 'الأعداد لازم تكون أرقام صحيحة');
      if (quota === 0) continue;
      if (seen.has(id)) throw new SplitError(400, 'نفس البنت متكررة');
      seen.add(id);
      const u = users.find((x) => x.id === id && x.can_receive);
      if (!u) throw new SplitError(400, 'واحدة من البنات المختارات مش موظفة نشطة');
      if (u.is_absent) throw new SplitError(400, `${u.name} متسجلة غايبة النهارده`);
      targets.push({ id, name: u.name, email: u.email, person: personOfUser(u).key, allowed: u.allowed, quota });
    }
    if (!targets.length) throw new SplitError(400, 'اختاري بنت واحدة على الأقل وحطي لها عدد');
    if (targets.length > MAX_TARGETS) throw new SplitError(400, `${MAX_TARGETS} بنت على الأكثر`);
    const sum = targets.reduce((s, t) => s + t.quota, 0);
    if (sum !== count) throw new SplitError(400, `مجموع الأعداد ${sum} — لازم يساوي ${count}`);

    const plan = planSplit({ orders: inFilter, targets, count, personOfEmail });
    if (plan.error) throw new SplitError(400, plan.error);

    const describe = (moved) => targets.map((t) => {
      const list = moved.get(t.id) ?? [];
      const from = {};
      for (const o of list) { const n = personOfEmail(o.holder).name; from[n] = (from[n] ?? 0) + 1; }
      return { id: t.id, name: t.name, count: list.length, from };
    });

    if (dryRun) {
      await client.query('ROLLBACK');
      return { ...summary, dryRun: true, count, plan: describe(plan.byTarget) };
    }

    /* Write: compare-and-set on holder + status, so an order confirmed or moved
       since it was read stays where it is. */
    const moved = new Map();
    let raced = 0;
    for (const t of targets) {
      const list = plan.byTarget.get(t.id);
      if (!list.length) { moved.set(t.id, []); continue; }
      const { rows } = await client.query(
        `UPDATE orders o SET "AssignedTo" = $1, "updatedAt" = NOW()
           FROM unnest($2::int[], $3::text[], $4::text[]) AS x(id, holder, status)
          WHERE o.id = x.id AND o.business_id = $5
            AND o."AssignedTo" IS NOT DISTINCT FROM x.holder AND btrim(o."Status") = x.status
          RETURNING o.id, x.holder, x.status`,
        [t.email, list.map((o) => o.id), list.map((o) => o.holder), list.map((o) => o.status), businessId]);
      raced += list.length - rows.length;
      const ok = new Set(rows.map((r) => r.id));
      moved.set(t.id, list.filter((o) => ok.has(o.id)));
      if (rows.length) {
        await client.query(
          `INSERT INTO order_assignment_log
             (order_id, business_id, from_agent, to_agent, changed_by, changed_by_id, source, order_status)
           SELECT x.id, $2, x.holder, $3, $4, $5, 'split', x.status
             FROM unnest($1::int[], $6::text[], $7::text[]) AS x(id, holder, status)`,
          [rows.map((r) => r.id), businessId, t.email, actor?.email ?? null,
           actor?.id != null ? String(actor.id) : null, rows.map((r) => r.holder), rows.map((r) => r.status)]);
      }
    }
    await client.query('COMMIT');
    const result = describe(moved);
    const done = result.reduce((s, r) => s + r.count, 0);
    console.log(`[split] ✂️ ${actor?.email}: ${done}/${count} → ${result.map((r) => `${r.name} ${r.count}`).join(' · ')}` +
      (raced ? ` · ${raced} changed meanwhile (left alone)` : ''));
    return { dryRun: false, count, moved: done, raced, plan: result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { SPLIT_STATUSES, SplitError, planSplit, personResolver, splitOrders };
