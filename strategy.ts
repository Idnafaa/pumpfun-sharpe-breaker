// Quietline: a surge-cross paper trader for agent-fun/replay/v2 (pump.fun).
//
// Why this shape? A pump.fun launch is guilty until proven innocent: the
// overwhelming majority bleed out in seconds. The minority that attract real
// money push their real SOL reserve up toward the graduation zone (~85 SOL)
// and tend to keep travelling. Quietline therefore spends nothing on a coin
// until the coin has done the proving itself:
//
//   * the real reserve has crossed 40 SOL, recently (inside 800 slots),
//   * four or more separate wallets have bought, with 3+ SOL of net buying
//     (buys minus sells by everyone except the creator) behind the move,
//   * the price sits between 1.1x and 8x of where it started — moving, but
//     not already vertical,
//   * the creator has not sold a single token, and their own opening buy in
//     the create slot was no more than 2 SOL.
//
// The entry is the crossing itself: one flat 0.5 SOL stake, one shot per
// coin, never more than five positions open at once. The position then
// answers to a short list of exits — bank at +20%, bail at -15%, a hard
// 300-slot holding cap, a creator sale, or silence: if nobody has traded
// the coin for 50 slots the story is over and the bot leaves. That quiet
// exit is the one change this revision makes to the earlier surge-cross
// tuning (which waited 60 slots): on the dev window, leaving a little
// sooner after the tape goes dead raised both net PnL and the hourly
// Sharpe, because capital parked in a dead coin is pure variance.
//
// Several knobs exist but ship parked wide open (dip band, recent-flow
// gates, trailing stop, flow exit). They are kept in the parameter set
// because they describe real ideas, but every retune so far — the original
// session's and this one — found they cost money when tightened: waiting
// for a dip misses the move, flow exits amputate winners on noise, and a
// trailing stop fires at the same moment the take-profit would anyway.
//
// The bot is a pure function of the batches it receives: no clock reads,
// no randomness, no network, no file access, so two runs over the same
// tape produce the same orders byte for byte.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface QuietlineParams {
  /** Real SOL reserve (lamports) a curve must reach to count as surging. */
  surgeReserveLamports: bigint;
  /** How long (slots) a surge stays actionable after the crossing. */
  surgeWindowSlots: number;
  /** Entry price must be within this band under the post-surge high (bps). */
  dipLowBps: number;
  dipHighBps: number;
  /** Distinct non-creator wallets that must have bought before entry. */
  minDistinctBuyers: number;
  /** Buys minus other wallets' sells since creation, at least (lamports). */
  minNetBoughtLamports: bigint;
  /** Entry price over the create price, allowed band (bps of the ratio). */
  runupLowBps: number;
  runupHighBps: number;
  /** The creator's create-slot buys, at most (lamports). */
  creatorBuyCapLamports: bigint;
  /** Biggest single non-creator sell, as bps of the reserve before it. */
  worstSellCapBps: number;
  /** Recent-flow lookback (slots) plus its entry gates. */
  flowLookbackSlots: number;
  minFlowNetLamports: bigint;
  minFlowBuyers: number;
  /** Real SOL reserve the curve must still hold when the buy is placed. */
  entryReserveFloorLamports: bigint;
  /** Flat stake per coin (lamports), also capped by the harness reserve cap. */
  stakeLamports: bigint;
  /** Smallest buy worth paying a transaction fee for (lamports). */
  minOrderLamports: bigint;
  /** Slippage tolerance attached to buys (bps). */
  buySlippageBps: number;
  /** Sell in full once the position is worth this far over basis (bps). */
  gainExitBps: number;
  /** Sell in full once the position is worth this far under basis (bps). */
  lossExitBps: number;
  /** Trailing stop: arm this far above basis, exit on this fall (bps). */
  trailArmBps: number;
  trailDropBps: number;
  /** Leave after this many slots in the position, whatever the price. */
  holdCapSlots: number;
  /** Leave when the coin has not traded for this many slots. */
  quietSlots: number;
  /** Leave when recent net flow drops below minus this (lamports). */
  flowExitLamports: bigint;
  /** Refuse (and abandon) any coin whose creator has sold. */
  skipCreatorSold: boolean;
}

export const QUIETLINE_DEFAULTS: QuietlineParams = {
  surgeReserveLamports: 40_000_000_000n,
  surgeWindowSlots: 800,
  dipLowBps: 0,
  dipHighBps: 2000,
  minDistinctBuyers: 4,
  minNetBoughtLamports: 3_000_000_000n,
  runupLowBps: 11_000,
  runupHighBps: 80_000,
  creatorBuyCapLamports: 2_000_000_000n,
  worstSellCapBps: 10_000,
  flowLookbackSlots: 15,
  minFlowNetLamports: -1_000_000_000_000n,
  minFlowBuyers: 0,
  entryReserveFloorLamports: 30_000_000_000n,
  stakeLamports: 500_000_000n,
  minOrderLamports: 10_000_000n,
  buySlippageBps: 10_000,
  gainExitBps: 2000,
  lossExitBps: 1500,
  trailArmBps: 1_000_000,
  trailDropBps: 1000,
  holdCapSlots: 300,
  quietSlots: 50,
  flowExitLamports: 1_000_000_000_000n,
  skipCreatorSold: true,
};

interface TapeEntry {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

/** Everything the bot remembers about one mint it has seen created. */
interface CoinLedger {
  mint: Pubkey;
  creator: Pubkey;
  bornSlot: number;
  bornQuote: bigint;
  bornTokens: bigint;
  creatorOpeningBuy: bigint;
  creatorHasSold: boolean;
  buyerWallets: Set<Pubkey>;
  boughtTotal: bigint;
  soldByOthers: bigint;
  biggestSellBps: number;
  surgeSlot: number | null;
  peakSinceSurge: number;
  lastTapeSlot: number;
  tape: TapeEntry[];
  buyPlaced: boolean;
  retired: boolean;
}

/** Bookkeeping for one live position, keyed separately from the ledger. */
interface PositionTrack {
  openedSlot: number;
  feesPaid: bigint;
  bestValue: bigint;
  creatorSoldWhenOpened: boolean;
}

export interface Quietline {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createQuietline(params: QuietlineParams = QUIETLINE_DEFAULTS): Quietline {
  const P = params;
  const ledgers = new Map<Pubkey, CoinLedger>();
  const tracks = new Map<Pubkey, PositionTrack>();
  /** Mints that already have a sell order in flight. */
  const sellInFlight = new Set<Pubkey>();

  /** Net flow and distinct buyers inside the lookback window ending at `slot`. */
  function windowFlow(c: CoinLedger, slot: number): { net: bigint; buyers: number } {
    const cutoff = slot - P.flowLookbackSlots;
    let stale = 0;
    while (stale < c.tape.length && c.tape[stale]!.slot <= cutoff) stale++;
    if (stale > 0) c.tape.splice(0, stale);
    let net = 0n;
    const wallets = new Set<Pubkey>();
    for (const t of c.tape) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) wallets.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: wallets.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  /**
   * The exit ladder, judged in one place. A position leaves when any rung
   * fires: the price rungs compare the live sale value against the full
   * basis (stake plus the fees already paid), the time rungs count slots,
   * and the story rungs watch the coin itself — a creator who sells after
   * we bought, a tape that has gone quiet, or a recent flow that has
   * turned into net distribution. Order among the rungs does not matter;
   * the first one that fires ends the position.
   */
  function shouldLeave(
    c: CoinLedger | undefined,
    track: PositionTrack,
    value: bigint,
    basis: bigint,
    now: number,
  ): boolean {
    if (basis > 0n) {
      if (value * BPS >= basis * (BPS + BigInt(P.gainExitBps))) return true;
      if (value * BPS <= basis * (BPS - BigInt(P.lossExitBps))) return true;
      const trailingArmed = track.bestValue * BPS >= basis * (BPS + BigInt(P.trailArmBps));
      if (trailingArmed && value * BPS <= track.bestValue * (BPS - BigInt(P.trailDropBps))) {
        return true;
      }
    }
    if (now - track.openedSlot >= P.holdCapSlots) return true;
    if (c !== undefined) {
      if (P.skipCreatorSold && c.creatorHasSold && !track.creatorSoldWhenOpened) return true;
      if (now - c.lastTapeSlot >= P.quietSlots) return true;
      if (windowFlow(c, now).net < -P.flowExitLamports) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      const now = batch.slot;
      const movedThisBatch = new Set<Pubkey>();
      const txFee = state.txFeeLamports();
      const curveFeeBps = BigInt(
        state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback,
      );

      // ---- Step 1: fold the batch's events into the per-coin ledgers. ----
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          ledgers.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            bornSlot: e.slot,
            bornQuote: BigInt(e.virtual_quote_reserves),
            bornTokens: BigInt(e.virtual_token_reserves),
            creatorOpeningBuy: 0n,
            creatorHasSold: false,
            buyerWallets: new Set(),
            boughtTotal: 0n,
            soldByOthers: 0n,
            biggestSellBps: 0,
            surgeSlot: null,
            peakSinceSurge: 0,
            lastTapeSlot: e.slot,
            tape: [],
            buyPlaced: false,
            retired: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = ledgers.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          const marginal = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.lastTapeSlot = e.slot;
          c.tape.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          movedThisBatch.add(e.mint);
          if (c.surgeSlot === null && BigInt(e.real_quote_reserves) >= P.surgeReserveLamports) {
            c.surgeSlot = e.slot;
            c.peakSinceSurge = marginal;
          } else if (c.surgeSlot !== null && marginal > c.peakSinceSurge) {
            c.peakSinceSurge = marginal;
          }
          const fromCreator = e.user === c.creator;
          if (e.is_buy) {
            c.boughtTotal += sol;
            if (fromCreator && e.slot === c.bornSlot) c.creatorOpeningBuy += sol;
            else if (!fromCreator) c.buyerWallets.add(e.user);
          } else if (fromCreator) {
            c.creatorHasSold = true;
          } else {
            c.soldByOthers += sol;
            const reserveBefore = BigInt(e.real_quote_reserves) + sol;
            if (reserveBefore > 0n) {
              const share = Number((sol * BPS) / reserveBefore);
              if (share > c.biggestSellBps) c.biggestSellBps = share;
            }
          }
        } else {
          // Completion (or any other terminal event): done with this coin.
          const c = ledgers.get(e.mint);
          if (c !== undefined) c.retired = true;
        }
      }

      // ---- Step 2: fold fills into position tracks. ----
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // The harness closed this mint itself; forget it completely.
          tracks.delete(f.mint);
          sellInFlight.delete(f.mint);
          const c = ledgers.get(f.mint);
          if (c !== undefined) c.retired = true;
          continue;
        }
        const track = tracks.get(f.mint);
        if (track !== undefined && f.status !== 'rejected') {
          track.feesPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'buy') {
          if (f.status === 'filled' && track === undefined) {
            tracks.set(f.mint, {
              openedSlot: f.slot,
              feesPaid: BigInt(f.tx_fee_lamports),
              bestValue: 0n,
              creatorSoldWhenOpened: ledgers.get(f.mint)?.creatorHasSold ?? false,
            });
          } else if (f.status !== 'filled') {
            const c = ledgers.get(f.mint);
            if (c !== undefined) c.buyPlaced = false;
          }
        } else {
          sellInFlight.delete(f.mint);
          if (f.status === 'filled') {
            tracks.delete(f.mint);
            const c = ledgers.get(f.mint);
            if (c !== undefined) c.retired = true;
          }
        }
      }
      // Reconcile with harness state: drop tracks that no longer exist.
      for (const mint of [...sellInFlight]) {
        if (!hasPending(state, mint, 'sell')) sellInFlight.delete(mint);
      }
      for (const mint of [...tracks.keys()]) {
        if (!state.positions.has(mint) && !sellInFlight.has(mint) && !hasPending(state, mint, 'buy')) {
          tracks.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const batchCap = state.hello.caps.max_orders_per_batch;
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vq: BigInt(m.virtual_quote_reserves),
          vt: BigInt(m.virtual_token_reserves),
        });
      }

      /** Lamports a sale of `tokens` on curve (vq, vt) would actually return. */
      const saleProceeds = (tokens: bigint, vq: bigint, vt: bigint): bigint => {
        if (tokens <= 0n || vt <= 0n) return 0n;
        const gross = (tokens * vq) / (vt + tokens);
        const fee = (gross * curveFeeBps + BPS - 1n) / BPS;
        const afterFees = gross - fee;
        return afterFees > txFee ? afterFees - txFee : 0n;
      };

      // ---- Step 3: exits. Every open position is repriced and judged. ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= batchCap) break;
        if (sellInFlight.has(mint)) continue;
        const c = ledgers.get(mint);
        let track = tracks.get(mint);
        if (track === undefined) {
          track = {
            openedSlot: now,
            feesPaid: txFee,
            bestValue: 0n,
            creatorSoldWhenOpened: c?.creatorHasSold ?? false,
          };
          tracks.set(mint, track);
        }
        let mark = marks.get(mint);
        if (mark === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mark = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = saleProceeds(pos.token_amount, mark.vq, mark.vt);
        const basis = pos.cost_lamports + track.feesPaid;
        if (value > track.bestValue) track.bestValue = value;

        if (!shouldLeave(c, track, value, basis, now)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        sellInFlight.add(mint);
      }

      // ---- Step 4: entries. Only coins that traded this batch can qualify. ----
      let cash = state.freeCashLamports();
      let openCount = state.committedPositionCount();
      for (const mint of movedThisBatch) {
        if (orders.length >= batchCap) break;
        const c = ledgers.get(mint);
        if (c === undefined || c.retired || c.buyPlaced) continue;
        if (openCount >= state.hello.caps.max_open_positions) break;
        if (c.surgeSlot === null) continue;
        if (now - c.surgeSlot > P.surgeWindowSlots) {
          c.retired = true;
          continue;
        }
        if (P.skipCreatorSold && c.creatorHasSold) {
          c.retired = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < P.entryReserveFloorLamports) continue;
        if (c.creatorOpeningBuy > P.creatorBuyCapLamports) continue;
        if (c.buyerWallets.size < P.minDistinctBuyers) continue;
        if (c.boughtTotal - c.soldByOthers < P.minNetBoughtLamports) continue;
        if (c.biggestSellBps > P.worstSellCapBps) continue;
        const vt = curve.virtual_token_reserves;
        const vq = curve.virtual_quote_reserves;
        if (vt <= 0n || c.bornTokens <= 0n) continue;
        const priceNow = Number(vq) / Number(vt);
        const priceAtBirth = Number(c.bornQuote) / Number(c.bornTokens);
        if (!(priceAtBirth > 0) || !(priceNow > 0)) continue;
        const runup = Math.floor((priceNow / priceAtBirth) * 10_000);
        if (runup < P.runupLowBps || runup > P.runupHighBps) continue;
        if (c.peakSinceSurge <= 0) continue;
        const dip = Math.floor((1 - priceNow / c.peakSinceSurge) * 10_000);
        if (dip < P.dipLowBps || dip > P.dipHighBps) continue;
        const flow = windowFlow(c, now);
        if (flow.net < P.minFlowNetLamports || flow.buyers < P.minFlowBuyers) continue;
        const reserveCap = state.maxBuyLamports(mint);
        const amount = P.stakeLamports < reserveCap ? P.stakeLamports : reserveCap;
        if (amount < P.minOrderLamports) continue;
        if (cash < amount + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        cash -= amount + txFee;
        c.buyPlaced = true;
        openCount += 1;
      }
      return orders;
    },
  };
}
