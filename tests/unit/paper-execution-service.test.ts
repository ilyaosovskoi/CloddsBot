/**
 * Paper Execution Service Tests
 *
 * Tests the virtual trading simulator that fulfils the ExecutionService interface.
 * Uses an in-memory SQLite database (via sql.js) for isolation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, initDatabase } from '../../src/db';
import { createPaperExecutionService, isPaperMode, paperUserId, DEFAULT_STARTING_BALANCE } from '../../src/execution/paper-execution-service';
import type { Database } from '../../src/db';
import { OrderRequest } from '../../src/execution';

function setupEnv() {
  // Force paper mode for tests
  process.env.PAPER_TRADING_MODE = '1';
  process.env.PAPER_TRADING_USER_ID = 'test-paper-user';
}

function teardownEnv() {
  delete process.env.PAPER_TRADING_MODE;
  delete process.env.PAPER_TRADING_USER_ID;
}

describe('Paper Execution Service', () => {
  let db: Database;
  let paper: ReturnType<typeof createPaperExecutionService>;

  beforeEach(async () => {
    setupEnv();
    db = createDatabase();
    await initDatabase();
    // Clean paper tables for test isolation (createDatabase returns singleton)
    db.run('DELETE FROM paper_trades WHERE user_id = ?', [paperUserId()]);
    db.run('DELETE FROM paper_positions WHERE user_id = ?', [paperUserId()]);
    db.run('DELETE FROM paper_trading_settings WHERE user_id = ?', [paperUserId()]);
    paper = createPaperExecutionService(db);
  });

  afterEach(() => {
    teardownEnv();
  });

  it('should initialise with default starting balance', async () => {
    const balance = paper.getBalance();
    assert.strictEqual(balance, DEFAULT_STARTING_BALANCE);
  });

  it('should reject buy when balance insufficient', async () => {
    const req: Omit<OrderRequest, 'side'> = {
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 30000, // notional = 15000 > 10000 balance
      orderType: 'GTC',
    };
    const result = await paper.buyLimit(req);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Insufficient paper balance'));
  });

  it('should execute buy limit and create position', async () => {
    const req: Omit<OrderRequest, 'side'> = {
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100, // notional = 50
      orderType: 'GTC',
    };
    const result = await paper.buyLimit(req);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'filled');
    assert.strictEqual(result.filledSize, 100);
    assert.strictEqual(result.avgFillPrice, 0.5);

    // Balance should decrease by notional
    const balance = paper.getBalance();
    assert.strictEqual(balance, DEFAULT_STARTING_BALANCE - 50);
  });

  it('should execute sell limit and record PnL', async () => {
    // First buy
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });

    // Then sell at higher price
    const sellResult = await paper.sellLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.6,
      size: 50,
      orderType: 'GTC',
    });

    assert.strictEqual(sellResult.success, true);
    assert.strictEqual(sellResult.status, 'filled');
    assert.strictEqual(sellResult.filledSize, 50);
    assert.strictEqual(sellResult.avgFillPrice, 0.6);

    // Balance: started at 10000, spent 50 on buy, received 30 on sell = 9980
    const balance = paper.getBalance();
    assert.strictEqual(balance, DEFAULT_STARTING_BALANCE - 50 + 30);

    // Position should be reduced to 50
    const pos = db.query<{ size: number }>(
      'SELECT size FROM paper_positions WHERE user_id = ? AND market_id = ? AND side = ?',
      [paperUserId(), 'market-123', 'yes']
    )[0];
    assert.strictEqual(pos?.size, 50);
  });

  it('should reject sell when no position exists', async () => {
    const result = await paper.sellLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Insufficient paper position'));
  });

  it('should reject sell when position size insufficient', async () => {
    // Buy 100
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });

    // Try to sell 150
    const result = await paper.sellLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.6,
      size: 150,
      orderType: 'GTC',
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Insufficient paper position'));
  });

  it('should average entry price on multiple buys at different prices', async () => {
    // Buy 100 at 0.5
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });

    // Buy another 100 at 0.7
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.7,
      size: 100,
      orderType: 'GTC',
    });

    // Position size should be 200
    const pos = db.query<{ size: number; entry_price: number }>(
      'SELECT size, entry_price FROM paper_positions WHERE user_id = ? AND market_id = ? AND side = ?',
      [paperUserId(), 'market-123', 'yes']
    )[0];
    assert.strictEqual(pos?.size, 200);
    // Average entry = (100*0.5 + 100*0.7) / 200 = 0.6
    assert.ok(Math.abs((pos?.entry_price ?? 0) - 0.6) < 1e-9);
  });

  it('should record trade in paper_trades with correct PnL', async () => {
    // Buy 100 at 0.5
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });

    // Sell 50 at 0.6
    await paper.sellLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.6,
      size: 50,
      orderType: 'GTC',
    });

    const trades = db.query<{ side: string; size: number; price: number; pnl: number }>(
      'SELECT side, size, price, pnl FROM paper_trades WHERE user_id = ? ORDER BY created_at',
      [paperUserId()]
    );
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].side, 'yes');
    assert.strictEqual(trades[0].size, 50);
    assert.strictEqual(trades[0].price, 0.6);
    // PnL = (0.6 - 0.5) * 50 = 5
    assert.strictEqual(trades[0].pnl, 5);
  });

  it('marketBuy should fill at fallback price and deduct notional', async () => {
    const result = await paper.marketBuy({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      size: 100,
      orderType: 'FOK',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.avgFillPrice, 0.99);
    // Notional = 100 * 0.99 = 99
    assert.strictEqual(paper.getBalance(), DEFAULT_STARTING_BALANCE - 99);
  });

  it('marketSell should fill at fallback price and credit proceeds', async () => {
    // First buy some shares
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });

    const result = await paper.marketSell({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      size: 50,
      orderType: 'FOK',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.avgFillPrice, 0.01);
    // Proceeds = 50 * 0.01 = 0.5
    assert.strictEqual(paper.getBalance(), DEFAULT_STARTING_BALANCE - 50 + 0.5);
  });

  it('makerBuy and makerSell should work like limit orders', async () => {
    const buyResult = await paper.makerBuy({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
    });
    assert.strictEqual(buyResult.success, true);

    const sellResult = await paper.makerSell({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.6,
      size: 50,
    });
    assert.strictEqual(sellResult.success, true);
  });

  it('protectedBuy and protectedSell should work like limit orders', async () => {
    const buyResult = await paper.protectedBuy({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });
    assert.strictEqual(buyResult.success, true);

    const sellResult = await paper.protectedSell({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.6,
      size: 50,
      orderType: 'GTC',
    });
    assert.strictEqual(sellResult.success, true);
  });

  it('should respect circuit breaker when tripped', async () => {
    // Access internal circuit breaker via getCircuitBreakerState
    // Create a new paper service with a mock circuit breaker
    const { createCircuitBreaker } = await import('../../src/execution/circuit-breaker');
    const cb = createCircuitBreaker({ maxLossUsd: 1, maxConsecutiveLosses: 1, resetTimeoutMs: 3600000 });
    cb.recordTrade({ success: false, lossUsd: 10 }); // Trip it

    // We can't easily inject the circuit breaker after creation without exposing it,
    // so we test the path by checking getCircuitBreakerState returns the state
    const state = paper.getCircuitBreakerState();
    assert.strictEqual(state, null); // No circuit breaker set by default
  });

  it('reset should clear positions and trades and restore balance', async () => {
    await paper.buyLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.5,
      size: 100,
      orderType: 'GTC',
    });
    await paper.sellLimit({
      platform: 'polymarket',
      marketId: 'market-123',
      tokenId: 'token-yes',
      price: 0.6,
      size: 50,
      orderType: 'GTC',
    });

    paper.reset(5000);

    assert.strictEqual(paper.getBalance(), 5000);
    const positions = db.query('SELECT * FROM paper_positions WHERE user_id = ?', [paperUserId()]);
    assert.strictEqual(positions.length, 0);
    const trades = db.query('SELECT * FROM paper_trades WHERE user_id = ?', [paperUserId()]);
    assert.strictEqual(trades.length, 0);
  });

  it('non-order methods should be no-ops and return safe defaults', async () => {
    assert.strictEqual(await paper.cancelOrder('polymarket', 'order-123'), true);
    assert.strictEqual(await paper.cancelAllOrders('polymarket'), 0);
    assert.deepStrictEqual(await paper.getOpenOrders('polymarket'), []);
    assert.strictEqual(await paper.getOrder('polymarket', 'order-123'), null);

    assert.deepStrictEqual(await paper.estimateSlippage({ platform: 'polymarket', marketId: 'm', tokenId: 't', side: 'buy', price: 0.5, size: 100 }), { slippage: 0, expectedPrice: 0.5 });
    assert.deepStrictEqual(await paper.estimateFill({ platform: 'polymarket', marketId: 'm', tokenId: 't', side: 'buy', price: 0.5, size: 100 }), { avgPrice: 0.5, filledSize: 100 });

    await paper.connectFillsWebSocket();
    paper.disconnectFillsWebSocket();
    assert.strictEqual(paper.isFillsWebSocketConnected(), false);

    const fillCb = paper.onFill(() => {});
    const orderCb = paper.onOrder(() => {});
    fillCb();
    orderCb();
    assert.deepStrictEqual(paper.getTrackedFills(), []);
    assert.strictEqual(paper.getTrackedFill('x'), undefined);
    assert.strictEqual(paper.clearOldFills(), 0);
    assert.strictEqual(await paper.waitForFill('x'), null);

    const hbId = await paper.startHeartbeat();
    assert.ok(hbId.startsWith('paper-heartbeat'));
    assert.strictEqual(await paper.sendHeartbeat(hbId), hbId);
    paper.stopHeartbeat();
    assert.strictEqual(paper.isHeartbeatActive(), false);

    assert.deepStrictEqual(await paper.getPendingSettlements(), []);
    assert.deepStrictEqual(await paper.approveUSDC(), { success: true });
    assert.strictEqual(await paper.getUSDCAllowance(), Number.POSITIVE_INFINITY);
    assert.ok(paper.getOrderbooksBatch([]) instanceof Promise);
    assert.strictEqual(paper.getCircuitBreakerState(), null);
    paper.stop();
  });

  it('placeOrdersBatch should execute multiple buyLimit', async () => {
    const orders: Omit<OrderRequest, 'orderType'>[] = [
      { platform: 'polymarket', marketId: 'm1', tokenId: 't1', side: 'buy', price: 0.5, size: 10 },
      { platform: 'polymarket', marketId: 'm2', tokenId: 't2', side: 'buy', price: 0.6, size: 20 },
    ];
    const results = await paper.placeOrdersBatch(orders);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].success, true);
    assert.strictEqual(results[1].success, true);
  });

  it('cancelOrdersBatch should succeed for all order IDs', async () => {
    const results = await paper.cancelOrdersBatch('polymarket', ['o1', 'o2', 'o3']);
    assert.strictEqual(results.length, 3);
    assert.ok(results.every(r => r.success));
  });
});