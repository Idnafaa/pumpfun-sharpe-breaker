// Breaker: a surge-cross paper trader for agent-fun/replay/v2 (pump.fun bonding curves).
//
// The core observation is that most pump.fun launches collapse within seconds,
// while the few that gather real demand climb toward graduation (~85 SOL of real
// reserve) and keep climbing. Breaker never buys a launch blind: it watches
// every curve from its CreateEvent and only steps in once a coin proves the
// demand is real — its real SOL reserve crossing 40 SOL with at least four
// distinct wallets buying behind it, at least 3 SOL of cumulative net buying,
// the creator not having sold, and the price up from creation but not vertical.
// It buys the crossing itself, in one fixed stake, and rides it with a wide
// exit ladder: a +20% take-profit, a -15% stop, a 300-slot hold cap, and an
// exit when the coin goes quiet or the creator sells. The dip and flow knobs
// (dipMinBps, minFlowLamports, exitFlowLamports, trailArmBps) are live
// parameters set wide open by default: on the dev window every one of them
// cost money when tightened — dip-waiting missed the move, flow exits cut
// winners on noise, and a trailing stop sold runners too early — so the
// shipped settings leave them off and let the take-profit and the hold cap
// do the work. One entry per coin, at most five open at once: a pure function
// of the batches it is fed, so the two graded executions agree byte for byte.
// No clock, no randomness, no network, no I/O.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface BreakerParams {
  /** Real SOL reserve a curve must reach to count as surging (lamports). */
  crossRealSolLamports: bigint;
  /** The dip must arrive within this many slots of the surge crossing. */
  crossFreshSlots: number;
  /** Price must sit at least this far below its post-surge high (bps). */
  dipMinBps: number;
  /** ...and at most this far below it (a collapse, not a breather) (bps). */
  dipMaxBps: number;
  /** Distinct non-creator wallets that must have bought before entry. */
  minBuyers: number;
  /** Cumulative net buying since creation (buys minus other wallets' sells). */
  minCumulativeNetLamports: bigint;
  /** Price now over the create price, as bps of the ratio: entry window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The creator's own buys in the create slot, at most (lamports). */
  maxCreatorBuyLamports: bigint;
  /** Largest single non-creator sell, as bps of the reserve before it, at most. */
  maxSingleSellBps: number;
  /** Recent-flow window (slots) and what it must still show at entry. */
  flowWindowSlots: number;
  minFlowLamports: bigint;
  minRecentBuyers: number;
  /** Real SOL reserve a curve must still hold at decision time (lamports). */
  minRealSolAtEntryLamports: bigint;
  /** Fixed stake per coin (lamports). */
  stakeLamports: bigint;
  /** Smallest buy worth paying the tx fee for (lamports). */
  minBuyLamports: bigint;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Sell everything once the position is worth this far over its basis (bps). */
  takeProfitBps: number;
  /** Sell everything once it is worth this far under its basis (bps). */
  stopLossBps: number;
  /** Trailing stop: once up at least this far, exit on a fall of trailBps. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots, whatever the price. */
  maxHoldSlots: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: bigint;
  /** Never buy a coin whose creator has sold. */
  skipCreatorSold: boolean;
}

export const DEFAULT_PARAMS: BreakerParams = {
  crossRealSolLamports: 40_000_000_000n,
  crossFreshSlots: 800,
  dipMinBps: 0,
  dipMaxBps: 2000,
  minBuyers: 4,
  minCumulativeNetLamports: 3_000_000_000n,
  minRunupBps: 11_000,
  maxRunupBps: 80_000,
  maxCreatorBuyLamports: 2_000_000_000n,
  maxSingleSellBps: 10_000,
  flowWindowSlots: 15,
  minFlowLamports: -1_000_000_000_000n,
  minRecentBuyers: 0,
  minRealSolAtEntryLamports: 30_000_000_000n,
  stakeLamports: 500_000_000n,
  minBuyLamports: 10_000_000n,
  buySlippageBps: 10_000,
  takeProfitBps: 2000,
  stopLossBps: 1500,
  trailArmBps: 1_000_000,
  trailBps: 1000,
  maxHoldSlots: 300,
  staleSlots: 60,
  exitFlowLamports: 1_000_000_000_000n,
  skipCreatorSold: true,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  createVq: bigint;
  createVt: bigint;
  creatorBuy: bigint;
  creatorSold: boolean;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldOthers: bigint;
  worstSellBps: number;
  /** Slot the real SOL reserve first reached the surge line, null until then. */
  crossSlot: number | null;
  /** Highest marginal price seen since the surge crossing (0 until it crosses). */
  highSinceCross: number;
  lastTradeSlot: number;
  tape: Tick[];
  /** A buy was sent for this coin and has not come back rejected or failed. */
  entered: boolean;
  /** Finished with this coin for good (exited, completed, or filtered out). */
  closed: boolean;
}

interface OpenPos {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  creatorSoldAtOpen: boolean;
}

export interface Breaker {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createBreaker(params: BreakerParams = DEFAULT_PARAMS): Breaker {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const open = new Map<Pubkey, OpenPos>();
  /** Mints with a sell already in flight. */
  const selling = new Set<Pubkey>();
  const stake = P.stakeLamports;
  const minBuy = P.minBuyLamports;

  /** Net lamports bought minus sold, and distinct buyers, over the flow window. */
  function recentFlow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindowSlots;
    let drop = 0;
    while (drop < c.tape.length && c.tape[drop]!.slot <= from) drop++;
    if (drop > 0) c.tape.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.tape) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      const txFee = state.txFeeLamports();
      const curveFeeBps =
        BigInt(state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback);

      // --- Fold the batch's events into the per-coin books. ---
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            creatorBuy: 0n,
            creatorSold: false,
            buyers: new Set(),
            bought: 0n,
            soldOthers: 0n,
            worstSellBps: 0,
            crossSlot: null,
            highSinceCross: 0,
            lastTradeSlot: e.slot,
            tape: [],
            entered: false,
            closed: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
          c.tape.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          traded.add(e.mint);
          if (c.crossSlot === null && BigInt(e.real_quote_reserves) >= P.crossRealSolLamports) {
            c.crossSlot = e.slot;
            c.highSinceCross = price;
          } else if (c.crossSlot !== null && price > c.highSinceCross) {
            c.highSinceCross = price;
          }
          const isCreator = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isCreator && e.slot === c.createdSlot) c.creatorBuy += sol;
            else if (!isCreator) c.buyers.add(e.user);
          } else if (isCreator) {
            c.creatorSold = true;
          } else {
            c.soldOthers += sol;
            const reserveBefore = BigInt(e.real_quote_reserves) + sol;
            if (reserveBefore > 0n) {
              const bps = Number((sol * BPS) / reserveBefore);
              if (bps > c.worstSellBps) c.worstSellBps = bps;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.closed = true;
        }
      }

      // --- Fold fills: open trades on filled buys, release coins whose buy
      // failed, forget positions the harness closed for us. ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
          const c = coins.get(f.mint);
          if (c !== undefined) c.closed = true;
          continue;
        }
        const t = open.get(f.mint);
        if (t !== undefined && f.status !== 'rejected') t.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy') {
          if (f.status === 'filled' && t === undefined) {
            open.set(f.mint, {
              openedSlot: f.slot,
              txPaid: BigInt(f.tx_fee_lamports),
              best: 0n,
              creatorSoldAtOpen: coins.get(f.mint)?.creatorSold ?? false,
            });
          } else if (f.status !== 'filled') {
            const c = coins.get(f.mint);
            if (c !== undefined) c.entered = false;
          }
        } else if (f.side === 'sell') {
          selling.delete(f.mint);
          if (f.status === 'filled') {
            open.delete(f.mint);
            const c = coins.get(f.mint);
            if (c !== undefined) c.closed = true;
          }
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      /** What selling `tokens` against (vq, vt) would pay after curve fees and one tx fee. */
      const exitValue = (tokens: bigint, vq: bigint, vt: bigint): bigint => {
        if (tokens <= 0n || vt <= 0n) return 0n;
        const gross = (tokens * vq) / (vt + tokens);
        const fee = (gross * curveFeeBps + BPS - 1n) / BPS;
        const net = gross - fee;
        return net > txFee ? net - txFee : 0n;
      };

      // --- Exits first: every held position is re-priced against its ladder. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let t = open.get(mint);
        if (t === undefined) {
          t = { openedSlot: now, txPaid: txFee, best: 0n, creatorSoldAtOpen: c?.creatorSold ?? false };
          open.set(mint, t);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = exitValue(pos.token_amount, mk.vq, mk.vt);
        const basis = pos.cost_lamports + t.txPaid;
        if (value > t.best) t.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.takeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.stopLossBps))) exit = true;
          if (
            t.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) &&
            value * BPS <= t.best * (BPS - BigInt(P.trailBps))
          ) {
            exit = true;
          }
        }
        if (now - t.openedSlot >= P.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (P.skipCreatorSold && c.creatorSold && !t.creatorSoldAtOpen) exit = true;
          if (now - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (recentFlow(c, now).net < -P.exitFlowLamports) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
      }

      // --- Entries: only coins that traded on this batch can have changed. ---
      let free = state.freeCashLamports();
      let openCount = state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const c = coins.get(mint);
        if (c === undefined || c.closed || c.entered) continue;
        if (openCount >= state.hello.caps.max_open_positions) break;
        if (c.crossSlot === null || now - c.crossSlot > P.crossFreshSlots) {
          if (c.crossSlot !== null && now - c.crossSlot > P.crossFreshSlots) c.closed = true;
          continue;
        }
        if (P.skipCreatorSold && c.creatorSold) {
          c.closed = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < P.minRealSolAtEntryLamports) continue;
        if (c.creatorBuy > P.maxCreatorBuyLamports) continue;
        if (c.buyers.size < P.minBuyers) continue;
        if (c.bought - c.soldOthers < P.minCumulativeNetLamports) continue;
        if (c.worstSellBps > P.maxSingleSellBps) continue;
        const vt = curve.virtual_token_reserves;
        const vq = curve.virtual_quote_reserves;
        if (vt <= 0n || c.createVt <= 0n) continue;
        const price = Number(vq) / Number(vt);
        const createPrice = Number(c.createVq) / Number(c.createVt);
        if (!(createPrice > 0) || !(price > 0)) continue;
        const runupBps = Math.floor((price / createPrice) * 10_000);
        if (runupBps < P.minRunupBps || runupBps > P.maxRunupBps) continue;
        if (c.highSinceCross <= 0) continue;
        const dipBps = Math.floor((1 - price / c.highSinceCross) * 10_000);
        if (dipBps < P.dipMinBps || dipBps > P.dipMaxBps) continue;
        const flow = recentFlow(c, now);
        if (flow.net < P.minFlowLamports || flow.buyers < P.minRecentBuyers) continue;
        const sizeCap = state.maxBuyLamports(mint);
        const amount = stake < sizeCap ? stake : sizeCap;
        if (amount < minBuy) continue;
        if (free < amount + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + txFee;
        c.entered = true;
        openCount += 1;
      }
      return orders;
    },
  };
}
