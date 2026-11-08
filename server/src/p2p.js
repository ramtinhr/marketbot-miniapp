import { reserveWithEngine } from './p2pEngine.js';
import { withTransaction } from './wallets.js';
import { asciiAmount, isUUID } from './trading.js';
import { httpError, exchangeDbError } from './errors.js';

const columns = 'id, offer_id, payer_id, receiver_id, amount::text, description, status, expires_at, receipt, receipt_reference, confirmation_due_at, reviewed_by, review_reason, created_at';
export function receiptBody(body) {
  const receipt = body?.receipt;
  const reference = typeof body?.reference === 'string' ? body.reference.trim() : '';
  if (typeof receipt !== 'string' || receipt.length > 720000 ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(receipt) || !reference || reference.length > 120) {
    throw httpError(400, 'invalid_receipt', 'a receipt image and bank reference (up to 120 characters) are required');
  }
  return { receipt, reference };
}

/** Reservations allocate an entire offer exclusively, even for a partial fill.
 * Expiry only releases unpaid reservations. Uploaded receipts never auto-settle. */
export class P2P {
  constructor(pg) { this.pg = pg; }
  async run(fn) {
    try { return await withTransaction(this.pg, async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('miniapp_rial'))");
      await this.sweep(c);
      return fn(c);
    }); } catch (e) { throw exchangeDbError(e); }
  }
  async sweep(c) {
    const expired = await c.query("UPDATE miniapp_p2p_payments SET status='expired',updated_at=clock_timestamp() WHERE status='reserved' AND expires_at<=clock_timestamp() RETURNING offer_id,amount::text");
    for (const p of expired.rows) {
      await c.query(`UPDATE miniapp_rial_offers SET filled_amount=filled_amount-$2,
        status=CASE WHEN filled_amount-$2=0 THEN 'open' ELSE 'partial' END,updated_at=clock_timestamp() WHERE id=$1`, [p.offer_id,p.amount]);
    }
    await c.query("UPDATE miniapp_p2p_payments SET status='admin_review',updated_at=clock_timestamp() WHERE status='awaiting_confirmation' AND confirmation_due_at<=clock_timestamp()");
  }
  maintain() { return this.run(async () => {}); }
  list(userId) {
    return this.run(async c => ({ payments: (await c.query(`SELECT ${columns} FROM miniapp_p2p_payments
      WHERE payer_id=$1 OR receiver_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId])).rows.map(p => ({
        ...p, role: p.payer_id === userId ? 'payer' : 'receiver', payer_id: undefined, receiver_id: undefined,
      })) }));
  }
  reserve(userId, body) {
    const amount = asciiAmount(body?.amount);
    if (!amount || !/^\d+$/.test(amount)) throw httpError(400,'invalid_amount','positive whole Toman required');
    if (body?.offer_id && !isUUID(body.offer_id)) throw httpError(400,'bad_request','invalid offer id');
    return reserveWithEngine(this.pg,userId,amount,body?.offer_id || null)
      .catch(e => { throw exchangeDbError(e); });
  }

  receipt(userId, id, body) {
    if (!isUUID(id)) throw httpError(400,'bad_request','invalid payment id');
    const { receipt, reference } = receiptBody(body);
    return this.run(async c => {
      const p = (await c.query('SELECT * FROM miniapp_p2p_payments WHERE id=$1 AND payer_id=$2 FOR UPDATE',[id,userId])).rows[0];
      if (!p) throw httpError(404,'not_found','payment not found');
      if (p.status === 'awaiting_confirmation' && p.receipt === receipt && p.receipt_reference === reference) return { payment: p };
      if (p.status !== 'reserved') throw httpError(409,'reservation_expired','reservation expired or already submitted');
      return { payment: (await c.query(`UPDATE miniapp_p2p_payments SET receipt=$2,receipt_reference=$3,
        status='awaiting_confirmation',confirmation_due_at=clock_timestamp()+interval '30 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,[id,receipt,reference])).rows[0] };
    });
  }
  confirm(userId, id, dispute = false) {
    if (!isUUID(id)) throw httpError(400,'bad_request','invalid payment id');
    return this.run(async c => {
      const p = (await c.query('SELECT * FROM miniapp_p2p_payments WHERE id=$1 AND receiver_id=$2 FOR UPDATE',[id,userId])).rows[0];
      if (!p) throw httpError(404,'not_found','payment not found');
      if (p.status === 'settled' && !dispute) return { ok: true };
      if (p.status !== 'awaiting_confirmation') throw httpError(409,'payment_pending','payment is no longer awaiting your confirmation');
      if (dispute) await c.query("UPDATE miniapp_p2p_payments SET status='admin_review',updated_at=clock_timestamp() WHERE id=$1",[id]);
      else await c.query("SELECT miniapp_p2p_resolve($1,'settled',$2,'receiver confirmed bank receipt')",[id,`customer:${userId}`]);
      return { ok: true };
    });
  }
}
