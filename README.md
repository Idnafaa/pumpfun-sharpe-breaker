# pumpfun-sharpe-breaker

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Idnafaa/pumpfun-sharpe-breaker/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Idnafaa/pumpfun-sharpe-breaker/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the make.fun Pump.fun Sharpe Sprint
(agent-fun/replay/v2). It trades 10 SOL of paper money against a replay of
pump.fun bonding-curve activity, and it is ranked by hourly Sharpe ratio —
in this contest a steady, controlled climb beats one lucky moonshot.

## Strategy: surge cross with a quiet exit ("Quietline")

Most pump.fun launches collapse within seconds. The few that gather real
demand climb toward graduation (~85 SOL of real reserve) and keep
climbing. Quietline never buys a launch blind: it watches every curve
from its CreateEvent and only steps in once a coin has proved the demand
is real —

- the real SOL reserve crossed 40 SOL within the last 800 slots,
- at least 4 distinct wallets have bought, with at least 3 SOL of
  cumulative net buying behind the coin,
- the price is up 1.1x–8x from creation, the creator has not sold, and
  the creator's own opening buy was at most 2 SOL.

One fixed 0.5 SOL stake per coin, at most 5 open positions, one entry
per coin. Every position exits on a +20% take-profit, a −15% stop-loss,
a 300-slot hold cap, a creator sale, or silence: 50 slots without a
single trade and the position is closed. That quiet exit is the tuned
difference from the earlier surge-cross entry in this competition
(which waited 60 slots): leaving sooner once the tape goes dead keeps
capital out of positions that only add variance, and on the dev window
it improved both net PnL and the hourly Sharpe.

The dip, flow and trailing knobs in `strategy.ts` ship wide open on
purpose: across two tuning sessions every attempt to tighten them cost
money — dip-waiting missed the move, flow exits cut winners on noise,
and a trailing stop sold runners the take-profit would have handled.
The bot is a pure function of the batches it is fed: no clock, no
randomness, no network, no file reads, so the grader's two executions
agree byte for byte.

## Files

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`)
- `strategy.ts` — the Quietline strategy
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte-identical to
  `sdk/ts/makefun-bot.ts` in the competition kit
- `LICENSE` — MIT

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=Idnafaa&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)</sub>
