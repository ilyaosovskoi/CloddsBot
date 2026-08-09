/**
 * Paper Execution Service
 *
 * Virtual trading simulator that fulfils the ExecutionService interface
 * used by all Polymarket order handlers. When PAPER_TRADING_MODE=1,
 * gateway wraps the real (or absent) execution service with this decorator
 * so every buy/sell goes through SQLite-backed paper tables instead of
 * sending real orders.
 *
 * Semantics:
 *  - Buying spends virtual balance (overdraft rejected) and opens/increases
 *    a position in `paper_positions` with an averaged entry price.
 *  - Selling reduces an existing position, credits balance, and records a
 *    closed trade with realised PnL in `paper_trades`.
 *  - All orders fill instantly at the requested price (no slippage / partial
 *    fills) — adequate for strategy/backtest validation.
 */

import { randomBytes } from 'crypto';
import type { Database } from '../db';
import type { User } from '../types';
import {
  ExecutionService,
  OrderRequest,
  OrderResult,
  OrderStatus,
  OpenOrder,
  OrderbookData,
  TrackedFill,
  TrackedOrder,
  PendingSettlement,
} from './index';
import type { CircuitBreaker, CircuitBreakerState } from './circuit-breaker';
import { createLogger } from '../utils/logger';

const logger = createLogger('paper-execution');

const DEFAULT_STARTING_BALANCE = 10000;

type PolyPlatform = 'polymarket' | 'kalshi' | 'opinion' | 'predictfun';

interface PaperSettings {
  user_id: string;
  balance: number;
  starting_balance: number;
}

interface PaperPosition {
  id: number;
  user_id: string;
  market_id: string;
  market_name: string | null;
  side: string;
  size: number;
  entry_price: number;
}

function paperOrderId(): string {
  return `paper-${randomBytes(8).toString('hex')}`;
}

function isPaperMode(): boolean {
  const v = process.env.PAPER_TRADING_MODE;
  return v === '1' || (v !== undefined && v.toLowerCase() === 'true');
}

/**
 * Resolve a "paper user" — a single tenant for paper trading. We use the
 * same configured user id that agents use (from PAPER_TRADING_USER_ID env,
 * defaulting to 'paper'). This keeps the simulator self-contained without
 * depending on per-request auth.
 */
function paperUserId(): string {
  return (process.env.PAPER_TRADING_USER_ID || 'paper').trim() || 'paper';
}

export interface PaperExecutionService extends ExecutionService {
  /** Internal: ensure settings row exists; returns current balance. */
  getBalance(): number;
  /** Internal: reset to starting balance (exposed for tests/reset). */
  reset(startingBalance?: number): void;
}

export function createPaperExecutionService(db: Database): PaperExecutionService {
  let circuitBreaker: CircuitBreaker | null = null;

  function ensureUserAndSettings(): void {
    const uid = paperUserId();
    const existing = db.query<PaperSettings>(
      'SELECT user_id, balance, starting_balance FROM paper_trading_settings WHERE user_id = ?',
      [uid]
    )[0];
    if (existing) return;
    // Ensure a user row exists (FK target) — INSERT OR IGNORE so we don't
    // collide with a real user that happens to share the id.
    db.run(
      'INSERT OR IGNORE INTO users (id, created_at, last_active_at) VALUES (?, ?, ?)',
      [uid, new Date().toISOString(), Date.now()]
    );
    db.run(
      `INSERT OR REPLACE INTO paper_trading_settings (user_id, enabled, balance, starting_balance, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [uid, 1, DEFAULT_STARTING_BALANCE, DEFAULT_STARTING_BALANCE]
    );
  }

  function getSettings(): PaperSettings {
    ensureUserAndSettings();
    return db.query<PaperSettings>(
      'SELECT user_id, balance, starting_balance FROM paper_trading_settings WHERE user_id = ?',
      [paperUserId()]
    )[0];
  }

  function setBalance(newBalance: number): void {
    db.run(
      'UPDATE paper_trading_settings SET balance = ? WHERE user_id = ?',
      [newBalance, paperUserId()]
    );
  }

  /**
   * Find an open paper position for the given market+side. Polymarket
   * identifies outcome by token_id — we use that as `market_id` key.
   */
  function findPosition(marketId: string, side: string): PaperPosition | undefined {
    return db.query<PaperPosition>(
      'SELECT id, user_id, market_id, market_name, side, size, entry_price FROM paper_positions WHERE user_id = ? AND market_id = ? AND side = ?',
      [paperUserId(), marketId, side]
    )[0];
  }

  function applyBuy(marketId: string, side: 'yes' | 'no', price: number, size: number, marketName: string | null): void {
    const existing = findPosition(marketId, side);
    if (existing) {
      const newSize = existing.size + size;
      const newEntry = (existing.entry_price * existing.size + price * size) / newSize;
      db.run(
        'UPDATE paper_positions SET size = ?, entry_price = ? WHERE id = ?',
        [newSize, newEntry, existing.id]
      );
    } else {
      db.run(
        `INSERT INTO paper_positions (user_id, market_id, market_name, side, size, entry_price, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [paperUserId(), marketId, marketName ?? marketId, side, size, price]
      );
    }
  }

  function recordTrade(marketId: string, side: 'yes' | 'no', size: number, price: number, pnl: number, marketName: string | null): void {
    // Round PnL to 6 decimal places to avoid floating-point noise like
    // (0.6 - 0.5) * 50 = 4.999999999999999 being persisted and breaking
    // strict-equality assertions downstream.
    const roundedPnl = Math.round((pnl + Number.EPSILON) * 1e6) / 1e6;
    db.run(
      `INSERT INTO paper_trades (user_id, market_id, market_name, side, size, price, pnl, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [paperUserId(), marketId, marketName ?? marketId, side, size, price, roundedPnl]
    );
  }

  function resolveMarketName(request: { marketId?: string; tokenId?: string; outcome?: string }): string | null {
    // The caller can pass market metadata via `request.outcome` for Kalshi,
    // but Polymarket order handlers don't currently thread market_name here.
    // We store the token id as the readable id; agent read-side already
    // truncates and shows it.
    return request.tokenId ?? request.marketId ?? null;
  }

  function resolveSide(request: { outcome?: string; tokenId?: string }): 'yes' | 'no' {
    if (request.outcome === 'no') return 'no';
    return 'yes';
  }

  function filledOrder(price: number, size: number): OrderResult {
    return {
      success: true,
      orderId: paperOrderId(),
      status: 'filled' as OrderStatus,
      filledSize: size,
      avgFillPrice: price,
    };
  }

  function failedOrder(reason: string): OrderResult {
    return { success: false, error: reason };
  }

  function buyLimitCore(req: Omit<OrderRequest, 'side'>): OrderResult {
    if (circuitBreaker && !circuitBreaker.canTrade()) {
      return failedOrder('Circuit breaker open');
    }
    const price = req.price;
    const size = req.size;
    const notional = price * size;
    if (!(price > 0) || !(size > 0)) return failedOrder('Invalid price or size');
    const settings = getSettings();
    if (settings.balance < notional) {
      logger.warn({ balance: settings.balance, notional }, 'Paper buy rejected: insufficient balance');
      return failedOrder(`Insufficient paper balance: have $${settings.balance.toFixed(2)}, need $${notional.toFixed(2)}`);
    }
    setBalance(settings.balance - notional);
    const side = resolveSide(req);
    applyBuy(req.marketId, side, price, size, resolveMarketName(req));
    logger.info({ side, marketId: req.marketId, price, size, notional, balance: settings.balance - notional }, 'Paper buy filled');
    return filledOrder(price, size);
  }

  function sellLimitCore(req: Omit<OrderRequest, 'side'>): OrderResult {
    if (circuitBreaker && !circuitBreaker.canTrade()) {
      return failedOrder('Circuit breaker open');
    }
    const price = req.price ?? 0;
    const size = req.size;
    if (!(price > 0) || !(size > 0)) return failedOrder('Invalid price or size');
    const side = resolveSide(req);
    const existing = findPosition(req.marketId, side);
    if (!existing || existing.size < size) {
      const have = existing?.size ?? 0;
      return failedOrder(`Insufficient paper position for ${side}: have ${have}, want ${size}`);
    }
    const proceeds = price * size;
    const pnl = (price - existing.entry_price) * size;
    const settings = getSettings();
    setBalance(settings.balance + proceeds);
    const newSize = existing.size - size;
    if (newSize <= 1e-9) {
      db.run('DELETE FROM paper_positions WHERE id = ?', [existing.id]);
    } else {
      db.run('UPDATE paper_positions SET size = ? WHERE id = ?', [newSize, existing.id]);
    }
    recordTrade(req.marketId, side, size, price, pnl, resolveMarketName(req));
    logger.info({ side, marketId: req.marketId, price, size, proceeds, pnl }, 'Paper sell filled');
    return filledOrder(price, size);
  }

  function marketBuyCore(req: Omit<OrderRequest, 'side' | 'price'>): OrderResult {
    // Market buy in Polymarket handlers passes `size` (shares) directly —
    // see src/agents/index.ts:10499-10504. We approximate fill price using
    // a configured paper price floor of 0.99 if no price is provided.
    const price = 0.99;
    return buyLimitCore({ ...req, price });
  }

  function marketSellCore(req: Omit<OrderRequest, 'side' | 'price'>): OrderResult {
    // Market sells use a fallback floor of 0.01 to guarantee fills; the
    // agent normally pre-resolves a sell price via /price endpoint.
    const price = 0.01;
    return sellLimitCore({ ...req, price });
  }

  const service: PaperExecutionService = {
    buyLimit(req) { return Promise.resolve(buyLimitCore(req)); },
    sellLimit(req) { return Promise.resolve(sellLimitCore(req)); },
    marketBuy(req) { return Promise.resolve(marketBuyCore(req)); },
    marketSell(req) { return Promise.resolve(marketSellCore(req)); },
    makerBuy(req) { return Promise.resolve(buyLimitCore(req)); },
    makerSell(req) { return Promise.resolve(sellLimitCore(req)); },

    protectedBuy(req, _maxSlippage) { return Promise.resolve(buyLimitCore(req)); },
    protectedSell(req, _maxSlippage) { return Promise.resolve(sellLimitCore(req)); },
    estimateSlippage(_req) {
      return Promise.resolve({ slippage: 0, expectedPrice: _req.price });
    },

    cancelOrder() { return Promise.resolve(true); },
    cancelAllOrders() { return Promise.resolve(0); },
    getOpenOrders() { return Promise.resolve([]); },
    getOrder() { return Promise.resolve(null); },

    placeOrdersBatch(orders) {
      return Promise.resolve(orders.map((o) => buyLimitCore(o)));
    },
    cancelOrdersBatch(_platform, orderIds) {
      return Promise.resolve(orderIds.map((orderId) => ({ orderId, success: true })));
    },

    estimateFill(req) {
      return Promise.resolve({ avgPrice: req.price, filledSize: req.size });
    },

    connectFillsWebSocket() { return Promise.resolve(); },
    disconnectFillsWebSocket() { /* no-op */ },
    isFillsWebSocketConnected() { return false; },
    onFill() { return () => { /* no-op */ }; },
    onOrder() { return () => { /* no-op */ }; },
    getTrackedFills() { return []; },
    getTrackedFill() { return undefined; },
    clearOldFills() { return 0; },
    waitForFill() { return Promise.resolve(null); },

    startHeartbeat() { return Promise.resolve('paper-heartbeat'); },
    sendHeartbeat(id) { return Promise.resolve(id); },
    stopHeartbeat() { /* no-op */ },
    isHeartbeatActive() { return false; },

    getPendingSettlements() { return Promise.resolve([]); },
    approveUSDC() { return Promise.resolve({ success: true }); },
    getUSDCAllowance() { return Promise.resolve(Number.POSITIVE_INFINITY); },
    getOrderbooksBatch() { return Promise.resolve(new Map()); },

    setCircuitBreaker(b) { circuitBreaker = b; },
    getCircuitBreakerState() { return circuitBreaker ? circuitBreaker.getState() : null; },

    stop() { /* no-op */ },

    getBalance() { return getSettings().balance; },
    reset(startingBalance = DEFAULT_STARTING_BALANCE) {
      ensureUserAndSettings();
      db.run('DELETE FROM paper_positions WHERE user_id = ?', [paperUserId()]);
      db.run('DELETE FROM paper_trades WHERE user_id = ?', [paperUserId()]);
      db.run(
        'UPDATE paper_trading_settings SET balance = ?, starting_balance = ? WHERE user_id = ?',
        [startingBalance, startingBalance, paperUserId()]
      );
    },
  };

  return service;
}

// Re-export helpers for tests
export { isPaperMode, paperUserId, DEFAULT_STARTING_BALANCE };
export type { PolyPlatform };
// Re-export imported types that callers may import from this module
export type { User };
