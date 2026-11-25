// Breaker — pump.fun Sharpe Sprint paper bot (agent-fun/replay/v2).
//
// Run by the grader as `node /bot/main.ts`. The wire protocol lives in the
// vendored SDK shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts file); the trading logic lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createBreaker, DEFAULT_PARAMS } from './strategy.ts';

const breaker = createBreaker(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => breaker.onBatch(state, batch),
});
