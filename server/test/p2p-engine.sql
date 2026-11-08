-- Durable P2P allocation commands. The engine is the consumer; callers never
-- allocate locally. The shared advisory lock also protects legacy receipt,
-- cancellation and expiry operations during a rolling deployment.
CREATE TABLE IF NOT EXISTS public.marketbot_p2p_commands (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  payer_id uuid NOT NULL REFERENCES exchange.users(id),
  amount numeric NOT NULL CHECK (amount > 0 AND amount=trunc(amount) AND amount<1000000000000000),
  offer_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '10 seconds'),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS marketbot_p2p_commands_pending ON public.marketbot_p2p_commands(seq) WHERE status='pending';

-- One transaction covers command acknowledgement and every allocation. A worker
-- crash rolls both back. No SECURITY DEFINER: retain the connection's grants.
CREATE OR REPLACE FUNCTION public.marketbot_p2p_process_next() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  cmd public.marketbot_p2p_commands%ROWTYPE;
  offer record;
  expired record;
  qty numeric;
  left_amount numeric;
  payment jsonb;
  payments jsonb := '[]'::jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('miniapp_rial'));
  SELECT * INTO cmd FROM public.marketbot_p2p_commands
    WHERE status='pending' ORDER BY seq LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF cmd.deadline<=clock_timestamp() THEN
    UPDATE public.marketbot_p2p_commands SET status='failed',
      result='{"code":"p2p_engine_unavailable","message":"P2P matching deadline expired","statusCode":503}',
      completed_at=clock_timestamp() WHERE id=cmd.id;
    RETURN true;
  END IF;
  -- A block provides a savepoint: insufficient supply cannot leave partial fills.
  BEGIN
    FOR expired IN UPDATE miniapp_p2p_payments SET status='expired',updated_at=clock_timestamp()
      WHERE status='reserved' AND expires_at<=clock_timestamp() RETURNING offer_id,amount
    LOOP
      UPDATE miniapp_rial_offers SET filled_amount=filled_amount-expired.amount,
        status=CASE WHEN filled_amount-expired.amount=0 THEN 'open' ELSE 'partial' END,
        updated_at=clock_timestamp() WHERE id=expired.offer_id;
    END LOOP;
    SELECT coalesce(jsonb_agg((to_jsonb(p) - 'updated_at') || jsonb_build_object('amount',p.amount::text)
      ORDER BY o.seq),'[]'::jsonb) INTO payments
      FROM miniapp_p2p_payments p JOIN miniapp_rial_offers o ON o.id=p.offer_id
      WHERE p.payer_id=cmd.payer_id AND p.status='reserved';
    IF jsonb_array_length(payments)=0 THEN
      left_amount := cmd.amount;
      FOR offer IN SELECT o.* FROM miniapp_rial_offers o
        WHERE method='p2p' AND side='want' AND status IN ('open','partial')
          AND held>=amount-filled_amount AND exchange_user_id<>cmd.payer_id
          AND (cmd.offer_id IS NULL OR id=cmd.offer_id)
          AND NOT EXISTS (SELECT 1 FROM miniapp_p2p_payments p WHERE p.offer_id=o.id AND p.status='reserved')
        ORDER BY seq FOR UPDATE
      LOOP
        EXIT WHEN left_amount=0 OR jsonb_array_length(payments)>=100;
        qty := least(offer.amount-offer.filled_amount,left_amount);
        CONTINUE WHEN qty<=0;
        INSERT INTO miniapp_p2p_payments(offer_id,payer_id,receiver_id,amount,description)
          VALUES(offer.id,cmd.payer_id,offer.exchange_user_id,qty,offer.description)
          RETURNING (to_jsonb(miniapp_p2p_payments) - 'updated_at') || jsonb_build_object('amount',amount::text) INTO payment;
        UPDATE miniapp_rial_offers SET filled_amount=filled_amount+qty,
          status=CASE WHEN filled_amount+qty>=amount THEN 'filled' ELSE 'partial' END,
          updated_at=clock_timestamp() WHERE id=offer.id;
        payments := payments || jsonb_build_array(payment);
        left_amount := left_amount-qty;
      END LOOP;
      IF left_amount>0 THEN RAISE EXCEPTION USING ERRCODE='P2001', MESSAGE='market_short'; END IF;
    END IF;
    UPDATE public.marketbot_p2p_commands SET status='completed',
      result=jsonb_build_object('payments',payments),completed_at=clock_timestamp() WHERE id=cmd.id;
  EXCEPTION WHEN SQLSTATE 'P2001' THEN
    UPDATE public.marketbot_p2p_commands SET status='failed',
      result='{"code":"market_short","message":"not enough available requests for this amount","statusCode":409}',
      completed_at=clock_timestamp() WHERE id=cmd.id;
  END;
  RETURN true;
END;
$$;
