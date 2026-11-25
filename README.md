# pumpfun-sharpe-breaker

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Idnafaa/pumpfun-sharpe-breaker/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Idnafaa/pumpfun-sharpe-breaker/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper trading bot for the make.fun Pump.fun Sharpe Sprint (agent-fun/replay/v2).
It trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity,
ranked by hourly Sharpe ratio — steady, controlled gains beat one lucky moonshot.

## Strategy: surge cross ("Breaker")

Most pump.fun launches collapse within seconds, while the few that gather real
demand climb toward graduation (~85 SOL of real reserve) and keep climbing.
This bot never buys a launch blind. It watches every curve from its
CreateEvent and only steps in once a coin proves the demand is real:

- the coin's real SOL reserve crossed 40 SOL within the last 800 slots,
- at least 4 distinct wallets have bought, with at least 3 SOL of cumulative
  net buying behind the coin,
- the price is up 1.1x–8x from creation, the creator has not sold, and the
  creator's own opening buy was at most 2 SOL.

One fixed 0.5 SOL stake per coin, at most 5 open positions, one entry per coin.
Every position exits on a +20% take-profit, a −15% stop-loss, a 300-slot hold
cap, 60 slots without a trade, or a creator sale. The dip, flow and trailing
knobs in `strategy.ts` are set wide open by default: on the dev window each
of them cost money when tightened — dip-waiting missed the move, flow exits
cut winners on noise, and a trailing stop sold runners too early — so the
take-profit and the hold cap do the work. No clock, no randomness, no network:
the bot is a pure function of the batches it is fed, so its two grading runs
agree byte for byte.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` on Node 22. The wire protocol lives in
the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the
kit's `sdk/ts` file); the trading logic lives in `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=Idnafaa&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)</sub>
