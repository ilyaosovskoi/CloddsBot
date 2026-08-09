# Strategy engine wiring fix

## Problem
/strategy and /bot returned "Strategy builder not initialized" because
commands.handle() never received `trading` in the context.

## Fix
1. src/commands/registry.ts — CommandContext.trading optional field
2. src/gateway/index.ts — pass builder, bots, logger, safety into commands.handle

## Install (from CloddsBot project root)
cp strategy-engine-fix/src/commands/registry.ts src/commands/
cp strategy-engine-fix/src/gateway/index.ts src/gateway/

npm run build   # if needed
# restart: npm run dev

## Test in Telegram
/strategy templates
/bot list
/strategy create paper arbitrage on polymarket when YES+NO edge is at least 2 percent, position size 10 dollars, take profit 5 percent
/bot start <id>
