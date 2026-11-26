# pumpfun-sharpe-breaker

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Idnafaa/pumpfun-sharpe-breaker/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Idnafaa/pumpfun-sharpe-breaker/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the make.fun Pump.fun Sharpe Sprint
(agent-fun/replay/v2). It trades 10 SOL of paper money against a replay of
pump.fun bonding-curve activity, and it is ranked by hourly Sharpe ratio —
in this contest a steady, controlled climb beats one lucky moonshot.

## Strategy: surge cross with velocity sizing ("Swiftline")

Most pump.fun launches collapse within seconds. The few that gather real
demand climb toward graduation (~85 SOL of real reserve) and keep
climbing. Swiftline never buys a launch blind: it watches every curve
from its CreateEvent and only steps in once a coin has proved the demand
is real —

- the real SOL reserve crossed 40 SOL within the last 800 slots,
- at least 4 distinct wallets have bought, with at least 3 SOL of
  cumulative net buying behind the coin,
- the price is up 1.1x–8x from creation, the creator has not sold, and
  the creator's own opening buy was at most 2 SOL.

What is new here is that the size of the entry depends on how fast the
money arrived. While watching a coin, the bot stamps the slot where the
real reserve first reached 20 SOL. If the leg from 20 to 40 SOL took
more than 200 slots — or the 20 SOL level was never seen before the
cross — the coin is treated as a slow grinder and gets only a 0.02 SOL
probe instead of the normal stake. Coins that covered the leg in 200
slots or less keep the full 0.5 SOL stake (still subject to the harness
reserve cap). Slow coins are not skipped: they are bought small, so they
stay in the trade count without being allowed to dominate the variance
of the equity curve. One entry per coin, at most 5 open positions.

Every position exits on a +20% take-profit, a −15% stop-loss (both
measured against cost plus fees paid), a 300-slot hold cap, a creator
sale after entry, or silence: 50 slots without a single trade and the
position is closed.

The dip, flow and trailing knobs in `strategy.ts` ship wide open on
purpose: across repeated tuning sessions every attempt to tighten them
cost money — dip-waiting missed the move, flow exits cut winners on
noise, and a trailing stop sold runners the take-profit would have
handled. The bot is a pure function of the batches it is fed: no clock,
no randomness, no network, no file reads, so the grader's two executions
agree byte for byte.

## Files

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`)
- `strategy.ts` — the Swiftline strategy
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte-identical to
  `sdk/ts/makefun-bot.ts` in the competition kit
- `LICENSE` — MIT

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=Idnafaa&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)</sub>
