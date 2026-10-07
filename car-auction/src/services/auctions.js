import { query, tx, audit, pool } from '../db.js';
import { validateBid, extendForAntiSnipe, resolveProxyBids, nextMinimumBid, closingOutcome, BidRejected, minIncrement } from '../domain/bidding.js';
import { toMillis } from '../domain/money.js';
import { changeStatus } from './vehicles.js';
import { publish } from './realtime.js';
import { HttpError } from '../security/middleware.js';

const LOT_LOCK_SQL = `
  SELECT l.*, e.anti_snipe_window_sec, e.extension_sec, e.status AS event_status
    FROM auction_lots l JOIN auction_events e ON e.id = l.auction_event_id
   WHERE l.id = $1 FOR UPDATE OF l`;

function toHttp(err) {
  if (err instanceof BidRejected) return new HttpError(422, err.code, err.message, { minimum: err.minimum });
  return err;
}

async function paddleMap(c, lot) {
  const { rows } = await c.query(
    `SELECT customer_id, paddle_no FROM bidder_registrations WHERE auction_event_id = $1`, [lot.auction_event_id]);
  return Object.fromEntries(rows.map((r) => [r.customer_id, r.paddle_no]));
}

/** يطبّق المزايدات الآلية ويحدّث حالة اللوت؛ يعيد قائمة المزايدات المضافة */
async function applyProxyRound(c, lot, now, actorId) {
  const { rows: proxies } = await c.query('SELECT customer_id, max_amount, created_at FROM proxy_bids WHERE lot_id = $1', [lot.id]);
  const auto = resolveProxyBids({ lot, proxies });
  const inserted = [];
  for (const b of auto) {
    const { rows } = await c.query(
      `INSERT INTO bids (lot_id, customer_id, amount, kind, placed_by) VALUES ($1,$2,$3,'PROXY',$4) RETURNING id, customer_id, amount, kind, placed_at`,
      [lot.id, b.customer_id, b.amount, actorId]);
    inserted.push(rows[0]);
    lot.current_price = b.amount;
    lot.leading_customer_id = b.customer_id;
    lot.bid_count += 1;
  }
  if (inserted.length) lot.ends_at = extendForAntiSnipe(lot.ends_at, now, lot.anti_snipe_window_sec, lot.extension_sec);
  return inserted;
}

async function persistLot(c, lot) {
  await c.query(
    `UPDATE auction_lots SET current_price = $2, leading_customer_id = $3, bid_count = $4, ends_at = $5, version = version + 1 WHERE id = $1`,
    [lot.id, lot.current_price, lot.leading_customer_id, lot.bid_count, lot.ends_at]);
}

async function broadcast(c, lot, newBids) {
  const paddles = await paddleMap(c, lot);
  await publish(c, {
    type: 'bid',
    lotId: lot.id,
    currentPrice: lot.current_price,
    bidCount: lot.bid_count,
    leaderPaddle: paddles[lot.leading_customer_id] ?? null,
    endsAt: new Date(lot.ends_at).toISOString(),
    nextMinimum: nextMinimumBid(lot),
    reserveMet: lot.reserve_price == null || toMillis(lot.current_price) >= toMillis(lot.reserve_price),
    bids: newBids.map((b) => ({ id: b.id, amount: b.amount, kind: b.kind, paddle: paddles[b.customer_id] ?? null, placedAt: b.placed_at })),
  });
}

/**
 * تسجيل مزايدة يدوية. التزامن مضمون بقفل صف اللوت (SELECT … FOR UPDATE):
 * مزايدتان متزامنتان تُعالجان بالتتابع، والثانية تُقارن بالسعر الذي أنتجته الأولى.
 */
export async function placeBid(lotId, { amount, idempotencyKey, customerId }, actor) {
  try {
    return await tx(async (c) => {
      const { rows } = await c.query(LOT_LOCK_SQL, [lotId]);
      const lot = rows[0];
      if (!lot) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
      const { rows: [{ now }] } = await c.query('SELECT clock_timestamp() AS now');

      if (idempotencyKey) {
        const { rows: dup } = await c.query('SELECT id, amount FROM bids WHERE lot_id = $1 AND customer_id = $2 AND idempotency_key = $3', [lotId, customerId, idempotencyKey]);
        if (dup[0]) return { duplicate: true, bidId: dup[0].id, leading: lot.leading_customer_id === customerId, currentPrice: lot.current_price, endsAt: lot.ends_at };
      }
      const { rows: reg } = await c.query('SELECT * FROM bidder_registrations WHERE auction_event_id = $1 AND customer_id = $2', [lot.auction_event_id, customerId]);
      validateBid({ lot, amount, customerId, registration: reg[0], now });

      const { rows: ins } = await c.query(
        `INSERT INTO bids (lot_id, customer_id, amount, kind, placed_by, ip_hash, idempotency_key) VALUES ($1,$2,$3,'MANUAL',$4,$5,$6)
         RETURNING id, customer_id, amount, kind, placed_at`,
        [lotId, customerId, amount, actor.id, actor.ipHash || null, idempotencyKey || null]);
      lot.current_price = amount;
      lot.leading_customer_id = customerId;
      lot.bid_count += 1;
      lot.ends_at = extendForAntiSnipe(lot.ends_at, now, lot.anti_snipe_window_sec, lot.extension_sec);
      const auto = await applyProxyRound(c, lot, now, actor.id);
      await persistLot(c, lot);
      await audit(c, { actorId: actor.id, action: 'BID_PLACED', entity: 'auction_lot', entityId: lotId, after: { customerId, amount, auto: auto.length }, ip: actor.ip });
      await broadcast(c, lot, [...ins, ...auto]);
      return {
        bidId: ins[0].id,
        leading: lot.leading_customer_id === customerId,
        outbidByProxy: lot.leading_customer_id !== customerId,
        currentPrice: lot.current_price,
        endsAt: lot.ends_at,
        nextMinimum: nextMinimumBid(lot),
      };
    });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'BID_RACE', 'سبقتك مزايدة بنفس المبلغ — حدّث الصفحة وزايد مجددًا');
    throw toHttp(e);
  }
}

/** ضبط/رفع الحد الأقصى للمزايدة الآلية */
export async function setProxy(lotId, { maxAmount, customerId }, actor) {
  try {
    return await tx(async (c) => {
      const { rows } = await c.query(LOT_LOCK_SQL, [lotId]);
      const lot = rows[0];
      if (!lot) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
      const { rows: [{ now }] } = await c.query('SELECT clock_timestamp() AS now');
      const { rows: reg } = await c.query('SELECT * FROM bidder_registrations WHERE auction_event_id = $1 AND customer_id = $2', [lot.auction_event_id, customerId]);
      if (lot.status !== 'OPEN' || now >= new Date(lot.ends_at)) throw new BidRejected('LOT_NOT_OPEN', 'المزاد على هذه السيارة غير مفتوح');
      if (!reg[0] || reg[0].deposit_status !== 'HELD') throw new BidRejected('DEPOSIT_REQUIRED', 'يجب إيداع التأمين واعتماده قبل المزايدة');
      if (toMillis(maxAmount) % 1000n !== 0n) throw new BidRejected('INVALID_AMOUNT', 'المزايدة بالدينار الصحيح فقط');
      const isLeader = lot.leading_customer_id === customerId;
      const min = isLeader ? lot.current_price : nextMinimumBid(lot);
      if (toMillis(maxAmount) < toMillis(min) || (isLeader && toMillis(maxAmount) <= toMillis(lot.current_price)))
        throw new BidRejected('BELOW_MINIMUM', `الحد الأقصى يجب أن يتجاوز ${Number(min).toLocaleString('en-US')} د.ل`, { minimum: min });
      await c.query(
        `INSERT INTO proxy_bids (lot_id, customer_id, max_amount) VALUES ($1,$2,$3)
         ON CONFLICT (lot_id, customer_id) DO UPDATE SET max_amount = EXCLUDED.max_amount, updated_at = clock_timestamp()`,
        [lotId, customerId, maxAmount]);
      const auto = await applyProxyRound(c, lot, now, actor.id);
      if (auto.length) await persistLot(c, lot);
      await audit(c, { actorId: actor.id, action: 'PROXY_SET', entity: 'auction_lot', entityId: lotId, after: { customerId, maxAmount }, ip: actor.ip });
      if (auto.length) await broadcast(c, lot, auto);
      return { leading: lot.leading_customer_id === customerId, currentPrice: lot.current_price, endsAt: lot.ends_at, nextMinimum: nextMinimumBid(lot) };
    });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'BID_RACE', 'تعارض مع مزايدة متزامنة — أعد المحاولة');
    throw toHttp(e);
  }
}

export async function listAuctions({ forBidder, customerId }) {
  const { rows: events } = await query(
    `SELECT id, title, starts_at, ends_at, status, deposit_required_lyd, anti_snipe_window_sec, extension_sec
       FROM auction_events WHERE status <> 'DRAFT' ORDER BY starts_at DESC LIMIT 20`);
  const { rows: lots } = await query(
    `SELECT l.id, l.auction_event_id, l.lot_no, l.status, l.starting_price, l.current_price, l.bid_count, l.starts_at, l.ends_at,
            (l.reserve_price IS NULL OR l.current_price >= l.reserve_price) AS reserve_met,
            ${forBidder ? 'NULL::numeric' : 'l.reserve_price'} AS reserve_price,
            (l.leading_customer_id = $1) AS is_leading,
            v.id AS vehicle_id, v.year, v.make, v.model, v.trim, v.odometer, v.odometer_unit, v.title_type, v.primary_damage, v.stock_no,
            (SELECT id FROM vehicle_images i WHERE i.vehicle_id = v.id ORDER BY is_primary DESC, sort_order LIMIT 1) AS image_id
       FROM auction_lots l JOIN vehicles v ON v.id = l.vehicle_id
      WHERE l.auction_event_id = ANY($2::uuid[]) ORDER BY l.lot_no`,
    [customerId || null, events.map((e) => e.id)]);
  return events.map((e) => ({ ...e, lots: lots.filter((l) => l.auction_event_id === e.id) }));
}

export async function getLot(lotId, { forBidder, customerId }) {
  const { rows } = await query(
    `SELECT l.*, e.title AS event_title, e.anti_snipe_window_sec, e.extension_sec, e.deposit_required_lyd,
            (l.reserve_price IS NULL OR l.current_price >= l.reserve_price) AS reserve_met
       FROM auction_lots l JOIN auction_events e ON e.id = l.auction_event_id WHERE l.id = $1`, [lotId]);
  const lot = rows[0];
  if (!lot) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
  const [{ rows: bids }, { rows: reg }, { rows: proxy }, { rows: [{ now }] }] = await Promise.all([
    query(`SELECT b.id, b.amount, b.kind, b.placed_at, r.paddle_no AS paddle, (b.customer_id = $2) AS mine
                  ${forBidder ? '' : ', c.full_name AS customer'}
             FROM bids b JOIN auction_lots l ON l.id = b.lot_id
             LEFT JOIN bidder_registrations r ON r.auction_event_id = l.auction_event_id AND r.customer_id = b.customer_id
             LEFT JOIN customers c ON c.id = b.customer_id
            WHERE b.lot_id = $1 ORDER BY b.amount DESC LIMIT 50`, [lotId, customerId || null]),
    customerId ? query('SELECT paddle_no, deposit_status FROM bidder_registrations WHERE auction_event_id = $1 AND customer_id = $2', [lot.auction_event_id, customerId]) : { rows: [] },
    customerId ? query('SELECT max_amount FROM proxy_bids WHERE lot_id = $1 AND customer_id = $2', [lotId, customerId]) : { rows: [] },
    query('SELECT clock_timestamp() AS now'),
  ]);
  const leaderPaddle = bids[0]?.paddle ?? null;
  const out = {
    ...lot,
    is_leading: !!customerId && lot.leading_customer_id === customerId,
    leader_paddle: leaderPaddle,
    next_minimum: nextMinimumBid(lot),
    increment: minIncrement(lot.current_price ?? lot.starting_price),
    bids,
    registration: reg[0] || null,
    my_proxy: proxy[0]?.max_amount ?? null,
    server_time: now,
  };
  if (forBidder) {
    delete out.reserve_price;
    delete out.leading_customer_id;
  }
  return out;
}

/** إنشاء لوت في مزاد: السيارة يجب أن تكون متاحة (IN_STOCK) وتنتقل إلى IN_AUCTION */
export async function createLot(eventId, { vehicleId, startingPrice, reservePrice }, actor) {
  return tx(async (c) => {
    const { rows: ev } = await c.query('SELECT * FROM auction_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!ev[0]) throw new HttpError(404, 'NOT_FOUND', 'المزاد غير موجود');
    if (!['DRAFT', 'SCHEDULED', 'LIVE'].includes(ev[0].status)) throw new HttpError(422, 'EVENT_CLOSED', 'المزاد مغلق');
    await changeStatus(c, vehicleId, 'IN_AUCTION', { actorId: actor.id, source: 'SYSTEM', reason: `إدراج في مزاد: ${ev[0].title}` });
    const { rows: n } = await c.query('SELECT COALESCE(max(lot_no),0) + 1 AS n FROM auction_lots WHERE auction_event_id = $1', [eventId]);
    const { rows } = await c.query(
      `INSERT INTO auction_lots (auction_event_id, vehicle_id, lot_no, starting_price, reserve_price, starts_at, ends_at, original_ends_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7, CASE WHEN $6 <= now() THEN 'OPEN'::lot_status ELSE 'PENDING'::lot_status END) RETURNING *`,
      [eventId, vehicleId, n[0].n, startingPrice, reservePrice || null, ev[0].starts_at, ev[0].ends_at]);
    await audit(c, { actorId: actor.id, action: 'LOT_CREATED', entity: 'auction_lot', entityId: rows[0].id, after: rows[0], ip: actor.ip });
    return rows[0];
  });
}

/**
 * دورة المزادات (كل بضع ثوانٍ): فتح اللوتات التي حان وقتها وإغلاق المنتهية.
 * قفل استشاري (advisory lock) يضمن أن نسخة واحدة فقط من الخادم تنفذها في كل مرة،
 * و SKIP LOCKED يتخطى أي لوت عليه مزايدة جارية لحظة الإغلاق.
 */
export async function auctionTick() {
  const lockClient = await pool.connect();
  try {
    const { rows: [{ ok }] } = await lockClient.query('SELECT pg_try_advisory_lock(424242) AS ok');
    if (!ok) return { skipped: true };
    try {
      await query(`UPDATE auction_lots SET status = 'OPEN' WHERE status = 'PENDING' AND starts_at <= now()`);
      await query(`UPDATE auction_events SET status = 'LIVE' WHERE status = 'SCHEDULED' AND starts_at <= now()`);
      let closed = 0;
      for (;;) {
        const did = await tx(async (c) => {
          const { rows } = await c.query(
            `SELECT * FROM auction_lots WHERE status = 'OPEN' AND ends_at <= clock_timestamp() ORDER BY ends_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
          const lot = rows[0];
          if (!lot) return false;
          await closeLot(c, lot);
          return true;
        });
        if (!did) break;
        closed++;
      }
      await query(`UPDATE auction_events e SET status = 'CLOSED' WHERE status = 'LIVE' AND ends_at <= now()
                     AND NOT EXISTS (SELECT 1 FROM auction_lots l WHERE l.auction_event_id = e.id AND l.status IN ('PENDING','OPEN'))`);
      return { closed };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(424242)');
    }
  } finally {
    lockClient.release();
  }
}

async function closeLot(c, lot) {
  const outcome = closingOutcome(lot);
  if (outcome.sold) {
    await c.query(`UPDATE auction_lots SET status = 'CLOSED_SOLD', closed_at = now() WHERE id = $1`, [lot.id]);
    const { rows: sale } = await c.query(
      `INSERT INTO sales (invoice_no, vehicle_id, customer_id, lot_id, sale_type, sale_price_lyd, payment_due_at)
       VALUES ('INV-' || to_char(now(),'YYYY') || '-' || lpad(nextval('invoice_seq')::text, 5, '0'), $1, $2, $3, 'AUCTION', $4, now() + interval '3 days')
       RETURNING invoice_no`, [lot.vehicle_id, outcome.winner, lot.id, outcome.price]);
    await changeStatus(c, lot.vehicle_id, 'SOLD', { source: 'SYSTEM', reason: `بيع بالمزاد — فاتورة ${sale[0].invoice_no}` });
    await c.query(`UPDATE bidder_registrations SET deposit_status = 'APPLIED' WHERE auction_event_id = $1 AND customer_id = $2`, [lot.auction_event_id, outcome.winner]);
  } else {
    await c.query(`UPDATE auction_lots SET status = 'CLOSED_UNSOLD', closed_at = now() WHERE id = $1`, [lot.id]);
    await changeStatus(c, lot.vehicle_id, 'IN_STOCK', { source: 'SYSTEM', reason: outcome.reason === 'NO_BIDS' ? 'انتهى المزاد بلا مزايدات' : 'لم يبلغ السعر الحد الأدنى' });
  }
  await audit(c, { action: 'LOT_CLOSED', entity: 'auction_lot', entityId: lot.id, after: outcome });
  await publish(c, { type: 'closed', lotId: lot.id, sold: outcome.sold, reason: outcome.reason, currentPrice: lot.current_price });
}
