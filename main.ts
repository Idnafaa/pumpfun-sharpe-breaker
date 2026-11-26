// Swiftline — entrypoint for the make.fun Pump.fun Sharpe Sprint bot.
//
// The grader starts this file directly (`node /bot/main.ts`). The wire
// protocol is handled by the vendored SDK shim in vendor/makefun-bot.ts
// (an unmodified copy of the kit's sdk/ts file); every trading decision
// is made in strategy.ts. This file only connects the two.

import { runBot } from './vendor/makefun-bot.ts';
import { buildSwiftline, SWIFTLINE_TUNING } from './strategy.ts';

const swiftline = buildSwiftline(SWIFTLINE_TUNING);

await runBot({
  onBatch: (state, batch) => swiftline.handleBatch(state, batch),
});
