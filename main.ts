// Quietline — pump.fun Sharpe Sprint paper bot (agent-fun/replay/v2).
//
// The grader runs this file as `node /bot/main.ts`. All wire-protocol
// handling lives in the vendored SDK shim (vendor/makefun-bot.ts, a
// byte-identical copy of the kit's sdk/ts file); all trading decisions
// live in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createQuietline, QUIETLINE_DEFAULTS } from './strategy.ts';

const bot = createQuietline(QUIETLINE_DEFAULTS);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
