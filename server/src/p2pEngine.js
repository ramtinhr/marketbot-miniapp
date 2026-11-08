import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Durable request/reply over the shared database. No local matching fallback.
 * Timeout cancels only an unprocessed command; a committed result always wins. */
export async function reserveWithEngine(pg, payerId, amount, offerId = null, { timeoutMs = 10_000 } = {}) {
  const id = randomUUID();
  await pg.query(`INSERT INTO public.marketbot_p2p_commands(id,payer_id,amount,offer_id)
    VALUES($1,$2,$3,$4)`, [id,payerId,amount,offerId]);
  const until = Date.now()+timeoutMs;
  for (;;) {
    const row = (await pg.query('SELECT status,result FROM public.marketbot_p2p_commands WHERE id=$1',[id])).rows[0];
    if (row.status==='completed') return row.result;
    if (row.status==='failed') {
      throw Object.assign(new Error(row.result.message), {code:row.result.code,statusCode:row.result.statusCode});
    }
    if (Date.now()>=until) {
      // Row locking serializes this with the worker: never report failure after
      // a successful allocation or allow a queued command to run after timeout.
      await pg.query(`UPDATE public.marketbot_p2p_commands SET status='failed',completed_at=clock_timestamp(),
        result='{"code":"p2p_engine_unavailable","message":"P2P matching engine is unavailable","statusCode":503}'
        WHERE id=$1 AND status='pending'`,[id]);
      continue;
    }
    await delay(50);
  }
}
