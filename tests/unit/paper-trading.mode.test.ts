import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/utils/config';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { writeFileSync, unlinkSync, rmSync, mkdirSync, mkdtempSync } from 'fs';
import JSON5 from 'json5';

// Helper to backup and restore environment variables
function backupEnv() {
  return { ...process.env };
}

function restoreEnv(backup: NodeJS.ProcessEnv) {
  // Clear current env
  for (const key of Object.keys(process.env)) {
    // @ts-ignore
    delete process.env[key];
  }
  // Restore backup
  for (const key of Object.keys(backup)) {
    // @ts-ignore
    process.env[key] = backup[key];
  }
}

describe('Paper Trading Mode', () => {
  let envBackup: NodeJS.ProcessEnv;
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    envBackup = backupEnv();
    // Create a temporary directory for config file
    tmpDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'clodds-test-'));
    configPath = join(tmpDir, 'clodds.json');
  });

  afterEach(() => {
    restoreEnv(envBackup);
    // Clean up temporary directory
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should enable dryRun for trading when PAPER_TRADING_MODE is true', async () => {
    // Set environment variable
    process.env.PAPER_TRADING_MODE = '1';

    // Load config (will use default config + env overrides)
    const config = await loadConfig();

    // Check that trading.dryRun is true
    assert.strictEqual(config.trading.dryRun, true);
    // Also check arbitrageExecution and copyTrading
    assert.strictEqual(config.arbitrageExecution.dryRun, true);
    assert.strictEqual(config.copyTrading.dryRun, true);
  });

  it('should leave dryRun as default when PAPER_TRADING_MODE is not set', async () => {
    // Ensure PAPER_TRADING_MODE is not set
    // @ts-ignore
    delete process.env.PAPER_TRADING_MODE;

    const config = await loadConfig();

    // Default config has trading.dryRun: true
    assert.strictEqual(config.trading.dryRun, true);
    assert.strictEqual(config.arbitrageExecution.dryRun, true);
    assert.strictEqual(config.copyTrading.dryRun, true);
  });

  it('should override config file trading.dryRun to true when PAPER_TRADING_MODE is true', async () => {
    // Write a config file with trading.dryRun: false
    const configContent = { trading: { dryRun: false } };
    writeFileSync(configPath, JSON5.stringify(configContent), 'utf-8');

    // Set config path to our temporary file
    process.env.CLODDS_CONFIG_PATH = configPath;
    // Enable paper trading mode
    process.env.PAPER_TRADING_MODE = '1';

    const config = await loadConfig();

    // Should be overridden to true by paper trading mode
    assert.strictEqual(config.trading.dryRun, true);
    // Check that other sections are also affected
    assert.strictEqual(config.arbitrageExecution.dryRun, true);
    assert.strictEqual(config.copyTrading.dryRun, true);
  });

  it('should respect config file trading.dryRun when PAPER_TRADING_MODE is false', async () => {
    // Write a config file with trading.dryRun: false
    const configContent = { trading: { dryRun: false } };
    writeFileSync(configPath, JSON5.stringify(configContent), 'utf-8');

    // Set config path to our temporary file
    process.env.CLODDS_CONFIG_PATH = configPath;
    // Ensure PAPER_TRADING_MODE is not set (or set to false)
    // @ts-ignore
    delete process.env.PAPER_TRADING_MODE;
    // Explicitly set to false to be clear
    process.env.PAPER_TRADING_MODE = '0';

    const config = await loadConfig();

    // Should be false from config file
    assert.strictEqual(config.trading.dryRun, false);
    // Note: arbitrageExecution and copyTrading are not affected by PAPER_TRADING_MODE when false
    // They will use their defaults (true) unless overridden by config file or other env vars
    // But we only set trading.dryRun in the config file, so they should be default true
    assert.strictEqual(config.arbitrageExecution.dryRun, true);
    assert.strictEqual(config.copyTrading.dryRun, true);
  });

  it("should enable paper trading mode with truthy values other than '1'", async () => {
    const truthyValues = ['true', 'TRUE', 'True', 'yes', 'YES'];
    for (const value of truthyValues) {
      // Reset env for each iteration
      restoreEnv(envBackup);
      process.env.PAPER_TRADING_MODE = value;

      const config = await loadConfig();
      assert.strictEqual(config.trading.dryRun, true, `Failed for value: ${value}`);
    }
  });
});