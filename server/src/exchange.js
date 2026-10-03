import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';

import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { Consumer, Producer, murmur2 } from '@platformatic/kafka';

import { httpError as appError } from './errors.js';
import { OrderCommandSchema } from './gen/marketbot/exchange/v1/command_pb.js';
import { MarketDepthSchema } from './gen/marketbot/exchange/v1/depth_pb.js';
import { ExchangeEventSchema } from './gen/marketbot/exchange/v1/event_pb.js';

// The way into the exchange, which runs in marketbot-engine (src/exchange
// there). Over Kafka, with the topics and messages defined in
// marketbot-contracts: commands out, events and depth in. Ported from
// marketbot-api (src/lib/exchange.js); src/gen is generated from the contracts
// there and copied here.
//
// This service never matches or settles anything. It sends an order as a
// command and waits for the engine's one answer to it; what the order did is
// whatever that answer says.

export const Topics = {
  commands: 'exchange.commands.v1',
  events: 'exchange.events.v1',
  depth: 'exchange.depth.v1',
};

/** What each refusal means, for logs. The app translates the code itself. */
export const REJECTIONS = {
  invalid_order: 'the engine refused the order as malformed',
  unknown_user: 'no such exchange user',
  user_inactive: 'the user is not active - only active users can place orders',
  wallet_inactive: 'the wallet this order pays from is frozen or closed',
  insufficient_balance: 'insufficient balance for this order',
  order_not_found: 'no such open order for this user',
  order_closed: 'the order is already filled or cancelled',
  internal_error: 'the engine could not process the order - see its log',
};

/** Kafka's partition for a symbol: murmur2 with the high bit masked, as every other client here uses. */
function symbolPartitioner(_message, key) {
  if (!key) throw new Error('every exchange command needs a symbol key');
  return murmur2(key) & 0x7fffffff;
}

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const json = (schema, message) => toJson(schema, message, { useProtoFieldName: true, alwaysEmitImplicit: true });

function httpError(status, message) {
  return appError(status, status === 504 ? 'exchange_timeout' : 'exchange_unavailable', message);
}

/**
 * The Kafka side of the exchange. Emits:
 *   'depth'  (depth JSON)          - a pair's book changed
 *   'event'  (event JSON)          - orders or trades changed, or a command was refused
 *   'status' (status())            - connected or lost
 */
export class ExchangeBridge extends EventEmitter {
  /**
   * @param {{ brokers: string[], clientId: string, log?: object, replyTimeoutMs?: number, liveReplyTimeoutMs?: number }} opts
   */
  constructor({ brokers, clientId, log = SILENT, replyTimeoutMs = 10_000, liveReplyTimeoutMs = 70_000 }) {
    super();
    this.setMaxListeners(0);
    this.brokers = brokers;
    this.clientId = clientId;
    this.log = log;
    this.replyTimeoutMs = replyTimeoutMs;
    // In live mode the engine answers only after the bot has placed, waited for
    // and cancelled real venue orders - each call under its own timeout.
    this.liveReplyTimeoutMs = liveReplyTimeoutMs;

    this.depths = new Map();
    this.pending = new Map();
    this.state = { configured: brokers.length > 0, connected: false, error: null, since: new Date().toISOString() };
    this.closed = false;
    this.clients = [];
  }

  status() {
    return { ...this.state };
  }

  #setState(patch) {
    const before = JSON.stringify([this.state.connected, this.state.error]);
    Object.assign(this.state, patch);
    if (JSON.stringify([this.state.connected, this.state.error]) !== before) {
      this.state.since = new Date().toISOString();
      this.emit('status', this.status());
    }
  }

  /** Latest depth of a pair, as JSON, or null if the engine has not published one. */
  depth(symbol) {
    return this.depths.get(symbol) ?? null;
  }

  /** "live" or "demo", as the engine last said in its books; null before any book. */
  tradingMode() {
    for (const depth of this.depths.values()) if (depth.trading_mode) return depth.trading_mode;
    return null;
  }

  /** Every pair the engine has published a book for. */
  symbols() {
    return [...this.depths.keys()].sort();
  }

  /**
   * Connects in the background and keeps retrying; never throws. The dashboard
   * must start, and every other page work, whether or not Kafka is up.
   */
  start() {
    if (!this.state.configured) {
      this.#setState({ error: 'KAFKA_BROKERS is not set' });
      return;
    }
    const attempt = async (delayMs) => {
      if (this.closed) return;
      try {
        await this.#connect();
        this.#setState({ connected: true, error: null });
        this.log.info({ brokers: this.brokers }, 'exchange: connected to Kafka');
      } catch (err) {
        await this.#closeClients();
        this.#setState({ connected: false, error: err.message });
        this.log.warn({ err: { message: err.message } }, `exchange: Kafka unavailable, retrying in ${delayMs / 1000}s`);
        this.retryTimer = setTimeout(() => attempt(Math.min(delayMs * 2, 30_000)), delayMs);
      }
    };
    attempt(2_000);
  }

  async #connect() {
    // One group per process: every dashboard instance needs every event and
    // every book, not a share of them. Nothing is committed.
    const group = `${this.clientId}.${hostname()}.${process.pid}.${randomUUID().slice(0, 8)}`;
    const base = { clientId: this.clientId, bootstrapBrokers: this.brokers };

    this.producer = new Producer({ ...base, partitioner: symbolPartitioner, autocreateTopics: false });
    // Books are compacted state: read from the start for every pair's latest.
    this.depthConsumer = new Consumer({ ...base, groupId: `${group}.depth` });
    // Events are news: only what happens from now on.
    this.eventConsumer = new Consumer({ ...base, groupId: `${group}.events` });
    this.clients = [this.producer, this.depthConsumer, this.eventConsumer];

    const depths = await this.depthConsumer.consume({ topics: [Topics.depth], mode: 'earliest', autocommit: false });
    const events = await this.eventConsumer.consume({ topics: [Topics.events], mode: 'latest', autocommit: false });
    this.streams = [depths, events];

    depths.on('data', (message) => this.#onDepth(message.value));
    events.on('data', (message) => this.#onEvent(message.value));
    for (const stream of this.streams) {
      stream.on('error', (err) => {
        this.log.error({ err: { message: err.message } }, 'exchange: Kafka stream error');
        this.#setState({ error: err.message });
      });
    }
  }

  #onDepth(value) {
    let depth;
    try {
      depth = json(MarketDepthSchema, fromBinary(MarketDepthSchema, value));
    } catch (err) {
      this.log.warn({ err: { message: err.message } }, 'exchange: undecodable depth skipped');
      return;
    }
    const current = this.depths.get(depth.symbol);
    // A replay of the compacted topic can deliver an older book after a newer one.
    if (current && Date.parse(current.built_at) > Date.parse(depth.built_at)) return;
    this.depths.set(depth.symbol, depth);
    this.emit('depth', depth);
  }

  #onEvent(value) {
    let event;
    try {
      event = json(ExchangeEventSchema, fromBinary(ExchangeEventSchema, value));
    } catch (err) {
      this.log.warn({ err: { message: err.message } }, 'exchange: undecodable event skipped');
      return;
    }
    const waiter = event.command_id && this.pending.get(event.command_id);
    if (waiter) {
      this.pending.delete(event.command_id);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
    this.emit('event', event);
  }

  /** Sends a command and resolves with the engine's answer, or throws 503/504. */
  async #command(symbol, command) {
    if (!this.state.configured) throw httpError(503, 'the exchange is not configured - set KAFKA_BROKERS');
    if (!this.state.connected || !this.producer) {
      throw httpError(503, `the exchange is unreachable: ${this.state.error ?? 'connecting to Kafka'}`);
    }
    const commandId = randomUUID();
    const timeoutMs = this.depth(symbol)?.trading_mode === 'live' ? this.liveReplyTimeoutMs : this.replyTimeoutMs;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(
          httpError(504, `marketbot-engine did not answer within ${timeoutMs / 1000}s - is it running with EXCHANGE_ENABLED=true?`),
        );
      }, timeoutMs);
      this.pending.set(commandId, { resolve, timer });
    });

    const message = create(OrderCommandSchema, { commandId, symbol, sentAt: timestampNow(), command });
    try {
      await this.producer.send({
        messages: [{ topic: Topics.commands, key: Buffer.from(symbol), value: Buffer.from(toBinary(OrderCommandSchema, message)) }],
      });
    } catch (err) {
      clearTimeout(this.pending.get(commandId)?.timer);
      this.pending.delete(commandId);
      throw httpError(503, `sending the order to Kafka failed: ${err.message}`);
    }
    return reply;
  }

  /** Places a limit order. Resolves with the event that answered it (which may be a refusal). */
  place({ symbol, side, user_id: userId, price, quantity }) {
    const orderId = randomUUID();
    return this.#command(symbol, { case: 'place', value: { orderId, userId, side, price, quantity } });
  }

  cancel({ symbol, order_id: orderId, user_id: userId }) {
    return this.#command(symbol, { case: 'cancel', value: { orderId, userId } });
  }

  async #closeClients() {
    for (const stream of this.streams ?? []) await stream.close().catch(() => {});
    for (const client of this.clients) await client.close().catch(() => {});
    this.streams = [];
    this.clients = [];
    this.producer = null;
  }

  async close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await this.#closeClients();
  }
}

/** Stand-in when the exchange is not wired up at all, e.g. in tests that do not need it. */
export class NoExchange extends EventEmitter {
  status() {
    return { configured: false, connected: false, error: 'KAFKA_BROKERS is not set', since: null };
  }
  depth() {
    return null;
  }
  tradingMode() {
    return null;
  }
  symbols() {
    return [];
  }
  async place() {
    throw httpError(503, 'the exchange is not configured - set KAFKA_BROKERS');
  }
  async cancel() {
    throw httpError(503, 'the exchange is not configured - set KAFKA_BROKERS');
  }
  async close() {}
}
