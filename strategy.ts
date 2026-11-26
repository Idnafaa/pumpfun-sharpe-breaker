// Swiftline — a velocity-sized surge-cross trader for agent-fun/replay/v2.
//
// The starting point is a simple observation about pump.fun launches: most
// of them are noise, and the honest signal is money arriving. A coin earns
// attention only after its real SOL reserve has pushed through 40 SOL, and
// even then it has to pass a checklist (enough independent buyers, enough
// net buying, a sane price multiple, a creator who has not sold and did not
// load up at birth). That checklist is inherited from the surge-cross design
// this bot revises.
//
// What Swiftline adds is a clock on the money itself. While watching a coin
// we note the slot where the real reserve first reached 20 SOL, halfway to
// the trigger. Coins whose 20-to-40 leg took more than 200 slots got there
// by grinding, and in testing those grinders produced almost all of the
// losses. Coins that covered the leg quickly are a different animal. So
// instead of a flat stake, entry size follows the leg:
//
//   * fast leg (<= 200 slots): the normal 0.5 SOL stake,
//   * slow leg, or no 20 SOL sighting before the cross: a token 0.02 SOL.
//
// Slow coins are still bought — the position keeps the trade count honest
// and occasionally one wakes up — but they are no longer allowed to drag
// the equity curve around at full size. Exits are unchanged from the
// surge-cross template: +20% take-profit, -15% stop-loss, a 300-slot age
// limit, an exit when the tape has been silent for 50 slots, and an exit
// if the creator sells after we are in.
//
// A handful of extra gates (dip band, recent flow, trailing stop, flow
// exit) exist in the tuning object with thresholds set so wide they never
// fire. They are deliberate placeholders: each was tightened at some point
// during tuning and each tightening lost money, so they ship parked.
//
// Everything here is deterministic: decisions depend only on the batches
// received, never on a clock, randomness, the network, or the filesystem.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

/** All knobs in one place; amounts are lamports, ratios are basis points. */
export interface SwiftlineTuning {
  crossReserve: bigint; // real reserve that marks a coin as surging
  crossFreshnessSlots: number; // how long a cross stays buyable
  waypointReserve: bigint; // halfway reserve used to time the climb
  waypointMaxLegSlots: number; // 20-to-40 leg longer than this is "slow"
  slowStake: bigint; // entry size for slow coins
  fullStake: bigint; // entry size for fast coins
  smallestOrder: bigint; // below this a buy is not worth its fee
  reserveFloorAtEntry: bigint; // reserve must still be at least this
  buyersNeeded: number; // distinct non-creator buying wallets
  netBoughtNeeded: bigint; // non-creator buys minus sells, minimum
  creatorBirthBuyMax: bigint; // creator's create-slot buying, maximum
  priceMultipleMinBps: number; // entry price vs birth price, low end
  priceMultipleMaxBps: number; // entry price vs birth price, high end
  dipBandMinBps: number; // parked gate: dip below post-cross peak
  dipBandMaxBps: number;
  biggestSellMaxBps: number; // parked gate: largest single sell share
  recentWindowSlots: number; // lookback for the parked flow gates
  recentNetMin: bigint;
  recentBuyersMin: number;
  buySlippageBps: number;
  profitExitBps: number; // sell everything this far above basis
  lossExitBps: number; // sell everything this far below basis
  trailArmBps: number; // parked gate: trailing stop arming level
  trailGivebackBps: number; // parked gate: trailing stop give-back
  maxHoldSlots: number; // age limit for any position
  silenceExitSlots: number; // exit after this long without a trade
  flowExitFloor: bigint; // parked gate: recent net flow exit level
  bailOnCreatorSale: boolean; // refuse/exit coins whose creator sold
}

export const SWIFTLINE_TUNING: SwiftlineTuning = {
  crossReserve: 40_000_000_000n,
  crossFreshnessSlots: 800,
  waypointReserve: 20_000_000_000n,
  waypointMaxLegSlots: 200,
  slowStake: 20_000_000n,
  fullStake: 500_000_000n,
  smallestOrder: 10_000_000n,
  reserveFloorAtEntry: 30_000_000_000n,
  buyersNeeded: 4,
  netBoughtNeeded: 3_000_000_000n,
  creatorBirthBuyMax: 2_000_000_000n,
  priceMultipleMinBps: 11_000,
  priceMultipleMaxBps: 80_000,
  dipBandMinBps: 0,
  dipBandMaxBps: 2000,
  biggestSellMaxBps: 10_000,
  recentWindowSlots: 15,
  recentNetMin: -1_000_000_000_000n,
  recentBuyersMin: 0,
  buySlippageBps: 10_000,
  profitExitBps: 2000,
  lossExitBps: 1500,
  trailArmBps: 1_000_000,
  trailGivebackBps: 1000,
  maxHoldSlots: 300,
  silenceExitSlots: 50,
  flowExitFloor: 1_000_000_000_000n,
  bailOnCreatorSale: true,
};

/** One trade from the tape, kept only while the flow window can see it. */
interface TapeRow {
  slot: number;
  bought: boolean;
  solAmount: bigint;
  wallet: Pubkey;
}

/** Per-mint memory, built from CreateEvent onwards. */
interface MintWatch {
  mint: Pubkey;
  creator: Pubkey;
  birthSlot: number;
  birthQuoteReserves: bigint;
  birthTokenReserves: bigint;
  creatorBirthBought: bigint;
  creatorHasSold: boolean;
  walletsThatBought: Set<Pubkey>;
  grossBought: bigint;
  grossSoldByOthers: bigint;
  largestSellShareBps: number;
  waypointSlot: number | null; // first slot real reserve reached 20 SOL
  crossSlot: number | null; // first slot real reserve reached 40 SOL
  peakPriceAfterCross: number;
  lastTradeSlot: number;
  recentTape: TapeRow[];
  buyAttempted: boolean;
  finished: boolean;
}

/** Per-position memory, separate from the mint watch. */
interface OpenDeal {
  entrySlot: number;
  feesSoFar: bigint;
  bestSeenValue: bigint;
  creatorHadSoldAtEntry: boolean;
}

export interface Swiftline {
  handleBatch(state: BotState, batch: Batch): OrderInput[];
}

export function buildSwiftline(tuning: SwiftlineTuning = SWIFTLINE_TUNING): Swiftline {
  const T = tuning;
  const watches = new Map<Pubkey, MintWatch>();
  const deals = new Map<Pubkey, OpenDeal>();
  const exitQueued = new Set<Pubkey>();

  // Net flow plus distinct buyer count over the trailing window. Rows that
  // have aged out of the window are dropped as a side effect.
  function recentFlow(w: MintWatch, atSlot: number): { net: bigint; buyers: number } {
    const earliest = atSlot - T.recentWindowSlots;
    let drop = 0;
    while (drop < w.recentTape.length && w.recentTape[drop]!.slot <= earliest) drop++;
    if (drop > 0) w.recentTape.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const row of w.recentTape) {
      if (row.bought) {
        net += row.solAmount;
        if (row.wallet !== w.creator) buyers.add(row.wallet);
      } else {
        net -= row.solAmount;
      }
    }
    return { net, buyers: buyers.size };
  }

  // The velocity verdict for a crossed coin, as a stake size. The leg is
  // measured between the two stamps (waypoint first sighting, then the
  // cross), never from "now", so a coin judged fast stays fast even if the
  // remaining entry gates take a few more slots to line up. A waypoint
  // that was never stamped counts as slow: no evidence of speed, no size.
  function stakeFor(w: MintWatch): bigint {
    if (w.crossSlot === null || w.waypointSlot === null) return T.slowStake;
    return w.crossSlot - w.waypointSlot > T.waypointMaxLegSlots ? T.slowStake : T.fullStake;
  }

  function pendingExists(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  // Every reason to close a position, checked together. Price reasons use
  // the full basis (what the position cost plus fees already paid); the
  // rest are about time passing or the coin's own story breaking down.
  function exitReasonFound(
    w: MintWatch | undefined,
    deal: OpenDeal,
    saleValue: bigint,
    basis: bigint,
    atSlot: number,
  ): boolean {
    if (basis > 0n) {
      if (saleValue * BPS >= basis * (BPS + BigInt(T.profitExitBps))) return true;
      if (saleValue * BPS <= basis * (BPS - BigInt(T.lossExitBps))) return true;
      const trailArmed = deal.bestSeenValue * BPS >= basis * (BPS + BigInt(T.trailArmBps));
      if (trailArmed && saleValue * BPS <= deal.bestSeenValue * (BPS - BigInt(T.trailGivebackBps))) {
        return true;
      }
    }
    if (atSlot - deal.entrySlot >= T.maxHoldSlots) return true;
    if (w !== undefined) {
      if (T.bailOnCreatorSale && w.creatorHasSold && !deal.creatorHadSoldAtEntry) return true;
      if (atSlot - w.lastTradeSlot >= T.silenceExitSlots) return true;
      if (recentFlow(w, atSlot).net < -T.flowExitFloor) return true;
    }
    return false;
  }

  return {
    handleBatch(state, batch) {
      const slotNow = batch.slot;
      const tradedHere = new Set<Pubkey>();
      const perTxFee = state.txFeeLamports();
      const totalFeeBps = BigInt(
        state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback,
      );

      // Pass 1: absorb events. Creations open a watch; trades update the
      // watch (including the 20 SOL waypoint stamp and the 40 SOL cross
      // stamp); anything terminal closes the watch for good.
      for (const ev of batch.events) {
        if (ev.event === 'CreateEvent') {
          watches.set(ev.mint, {
            mint: ev.mint,
            creator: ev.creator,
            birthSlot: ev.slot,
            birthQuoteReserves: BigInt(ev.virtual_quote_reserves),
            birthTokenReserves: BigInt(ev.virtual_token_reserves),
            creatorBirthBought: 0n,
            creatorHasSold: false,
            walletsThatBought: new Set(),
            grossBought: 0n,
            grossSoldByOthers: 0n,
            largestSellShareBps: 0,
            waypointSlot: null,
            crossSlot: null,
            peakPriceAfterCross: 0,
            lastTradeSlot: ev.slot,
            recentTape: [],
            buyAttempted: false,
            finished: false,
          });
          continue;
        }
        if (ev.event !== 'TradeEvent') {
          const w = watches.get(ev.mint);
          if (w !== undefined) w.finished = true;
          continue;
        }
        const w = watches.get(ev.mint);
        if (w === undefined) continue;
        const sol = BigInt(ev.sol_amount);
        const spotPrice = Number(ev.virtual_quote_reserves) / Number(ev.virtual_token_reserves);
        w.lastTradeSlot = ev.slot;
        w.recentTape.push({ slot: ev.slot, bought: ev.is_buy, solAmount: sol, wallet: ev.user });
        tradedHere.add(ev.mint);

        // The waypoint stamp comes first: a single trade can in principle
        // carry the reserve past both levels, and the leg is measured
        // between the two stamps, so order matters here.
        if (w.waypointSlot === null && BigInt(ev.real_quote_reserves) >= T.waypointReserve) {
          w.waypointSlot = ev.slot;
        }
        if (w.crossSlot === null && BigInt(ev.real_quote_reserves) >= T.crossReserve) {
          w.crossSlot = ev.slot;
          w.peakPriceAfterCross = spotPrice;
        } else if (w.crossSlot !== null && spotPrice > w.peakPriceAfterCross) {
          w.peakPriceAfterCross = spotPrice;
        }

        const isCreator = ev.user === w.creator;
        if (ev.is_buy) {
          w.grossBought += sol;
          if (isCreator && ev.slot === w.birthSlot) {
            w.creatorBirthBought += sol;
          } else if (!isCreator) {
            w.walletsThatBought.add(ev.user);
          }
        } else if (isCreator) {
          w.creatorHasSold = true;
        } else {
          w.grossSoldByOthers += sol;
          const reserveBeforeThisSell = BigInt(ev.real_quote_reserves) + sol;
          if (reserveBeforeThisSell > 0n) {
            const shareBps = Number((sol * BPS) / reserveBeforeThisSell);
            if (shareBps > w.largestSellShareBps) w.largestSellShareBps = shareBps;
          }
        }
      }

      // Pass 2: absorb fills. A filled buy opens a deal; a rejected buy
      // frees the mint for another attempt; a filled sell closes both the
      // deal and the watch. Fills the harness generated itself (client ids
      // starting with '_') retire the mint outright.
      for (const fill of batch.fills) {
        if (fill.client_id.startsWith('_')) {
          deals.delete(fill.mint);
          exitQueued.delete(fill.mint);
          const w = watches.get(fill.mint);
          if (w !== undefined) w.finished = true;
          continue;
        }
        const deal = deals.get(fill.mint);
        if (deal !== undefined && fill.status !== 'rejected') {
          deal.feesSoFar += BigInt(fill.tx_fee_lamports);
        }
        if (fill.side === 'buy') {
          if (fill.status === 'filled' && deal === undefined) {
            deals.set(fill.mint, {
              entrySlot: fill.slot,
              feesSoFar: BigInt(fill.tx_fee_lamports),
              bestSeenValue: 0n,
              creatorHadSoldAtEntry: watches.get(fill.mint)?.creatorHasSold ?? false,
            });
          } else if (fill.status !== 'filled') {
            const w = watches.get(fill.mint);
            if (w !== undefined) w.buyAttempted = false;
          }
        } else {
          exitQueued.delete(fill.mint);
          if (fill.status === 'filled') {
            deals.delete(fill.mint);
            const w = watches.get(fill.mint);
            if (w !== undefined) w.finished = true;
          }
        }
      }
      // Drop bookkeeping the harness no longer agrees with.
      for (const mint of [...exitQueued]) {
        if (!pendingExists(state, mint, 'sell')) exitQueued.delete(mint);
      }
      for (const mint of [...deals.keys()]) {
        if (!state.positions.has(mint) && !exitQueued.has(mint) && !pendingExists(state, mint, 'buy')) {
          deals.delete(mint);
        }
      }

      const out: OrderInput[] = [];
      const replyCap = state.hello.caps.max_orders_per_batch;
      const markByMint = new Map<Pubkey, { vQuote: bigint; vTokens: bigint }>();
      for (const m of batch.marks) {
        markByMint.set(m.mint, {
          vQuote: BigInt(m.virtual_quote_reserves),
          vTokens: BigInt(m.virtual_token_reserves),
        });
      }

      // What selling `tokens` on the given curve would actually net, after
      // the curve fee (rounded up) and one transaction fee.
      const netSaleValue = (tokens: bigint, vQuote: bigint, vTokens: bigint): bigint => {
        if (tokens <= 0n || vTokens <= 0n) return 0n;
        const gross = (tokens * vQuote) / (vTokens + tokens);
        const fee = (gross * totalFeeBps + BPS - 1n) / BPS;
        const afterCurveFee = gross - fee;
        return afterCurveFee > perTxFee ? afterCurveFee - perTxFee : 0n;
      };

      // Pass 3: exits. Reprice every open position and close the ones
      // whose exit reason has fired.
      for (const [mint, position] of state.positions) {
        if (out.length >= replyCap) break;
        if (exitQueued.has(mint)) continue;
        const w = watches.get(mint);
        let deal = deals.get(mint);
        if (deal === undefined) {
          deal = {
            entrySlot: slotNow,
            feesSoFar: perTxFee,
            bestSeenValue: 0n,
            creatorHadSoldAtEntry: w?.creatorHasSold ?? false,
          };
          deals.set(mint, deal);
        }
        let mark = markByMint.get(mint);
        if (mark === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mark = { vQuote: curve.virtual_quote_reserves, vTokens: curve.virtual_token_reserves };
        }
        const valueNow = netSaleValue(position.token_amount, mark.vQuote, mark.vTokens);
        const basis = position.cost_lamports + deal.feesSoFar;
        if (valueNow > deal.bestSeenValue) deal.bestSeenValue = valueNow;
        if (!exitReasonFound(w, deal, valueNow, basis, slotNow)) continue;
        out.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        exitQueued.add(mint);
      }

      // Pass 4: entries. Only mints that traded in this batch are looked
      // at, and every gate from the design has to pass before money moves.
      let spendable = state.freeCashLamports();
      let openDeals = state.committedPositionCount();
      for (const mint of tradedHere) {
        if (out.length >= replyCap) break;
        const w = watches.get(mint);
        if (w === undefined || w.finished || w.buyAttempted) continue;
        if (openDeals >= state.hello.caps.max_open_positions) break;
        if (w.crossSlot === null) continue;

        if (slotNow - w.crossSlot > T.crossFreshnessSlots) {
          w.finished = true;
          continue;
        }
        if (T.bailOnCreatorSale && w.creatorHasSold) {
          w.finished = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < T.reserveFloorAtEntry) continue;
        if (w.creatorBirthBought > T.creatorBirthBuyMax) continue;
        if (w.walletsThatBought.size < T.buyersNeeded) continue;
        if (w.grossBought - w.grossSoldByOthers < T.netBoughtNeeded) continue;
        if (w.largestSellShareBps > T.biggestSellMaxBps) continue;
        const vTokens = curve.virtual_token_reserves;
        const vQuote = curve.virtual_quote_reserves;
        if (vTokens <= 0n || w.birthTokenReserves <= 0n) continue;
        const priceNow = Number(vQuote) / Number(vTokens);
        const priceAtBirth = Number(w.birthQuoteReserves) / Number(w.birthTokenReserves);
        if (!(priceAtBirth > 0) || !(priceNow > 0)) continue;
        const multipleBps = Math.floor((priceNow / priceAtBirth) * 10_000);
        if (multipleBps < T.priceMultipleMinBps || multipleBps > T.priceMultipleMaxBps) continue;
        if (w.peakPriceAfterCross <= 0) continue;
        const dipBps = Math.floor((1 - priceNow / w.peakPriceAfterCross) * 10_000);
        if (dipBps < T.dipBandMinBps || dipBps > T.dipBandMaxBps) continue;
        const flow = recentFlow(w, slotNow);
        if (flow.net < T.recentNetMin || flow.buyers < T.recentBuyersMin) continue;

        const harnessCap = state.maxBuyLamports(mint);
        const wanted = stakeFor(w);
        const stake = wanted < harnessCap ? wanted : harnessCap;
        if (stake < T.smallestOrder) continue;
        if (spendable < stake + perTxFee) continue;
        out.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: T.buySlippageBps });
        spendable -= stake + perTxFee;
        w.buyAttempted = true;
        openDeals += 1;
      }
      return out;
    },
  };
}
