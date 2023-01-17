import { assets } from "@zetamarkets/sdk";
import { Theo, TopLevelMsg, Quote } from "./types";
import {
  roundLotSize,
  calculateFair,
  calculateSpread,
  convertPriceToOrderPrice,
} from "./math";
import { AssetParam, Instrument } from "./configuration";
import { diffInBps } from "./math";
import { convertDecimalToNativeLotSize } from "@zetamarkets/sdk/dist/utils";

export class State {
  private assetParams: Map<assets.Asset, AssetParam>;
  private desiredQuotes: Map<string, Quote[]> = new Map();
  private theos: Map<assets.Asset, Theo> = new Map();
  private positions: Map<string, number> = new Map();

  constructor(assetParams: Map<assets.Asset, AssetParam>) {
    this.assetParams = assetParams;
  }

  getCurrentQuotes(asset: assets.Asset): Quote[] {
    return this.desiredQuotes.get(asset);
  }

  setMarkPriceUpdate(msg: TopLevelMsg, timestamp: number) {
    this.theos.set(msg.asset, {
      theo: calculateFair(msg),
      topBid: msg.topLevel.bid,
      topAsk: msg.topLevel.ask,
      timestamp,
    });
  }

  setPositionUpdate(asset: assets.Asset, marketIndex: number, size: number) {
    this.positions.set(`${asset}-${marketIndex}`, size);
  }

  getTheo(asset: assets.Asset): Theo {
    return this.theos.get(asset);
  }

  calcQuotes(asset: assets.Asset): Quote[] {
    const theo = this.theos.get(asset);
    if (!theo) return [];

    const quotes = this._calcQuotes(
      asset,
      this.assetParams.get(asset).instruments,
      theo
    );

    // compare with desired quotes bid/ask sizes
    const desiredQuotes = this.desiredQuotes.get(asset);
    if (!desiredQuotes) {
      console.log(`Will issue new ${asset} quotes ${JSON.stringify(quotes)}`);
      this.desiredQuotes.set(asset, quotes);
      return quotes;
    } else {
      // if find any diffs with desiredQuotes, add re-issue all quotes for this asset
      const requoteBps = this.assetParams.get(asset).requoteBps;
      const shouldRequote = quotes.some((quote) => {
        const desiredQuote = desiredQuotes.find(
          (x) => x.asset == quote.asset && x.marketIndex == quote.marketIndex
        );

        if (desiredQuote) {
          const bidPriceMovementBps = diffInBps(
            desiredQuote.bidPrice,
            quote.bidPrice
          );
          const askPriceMovementBps = diffInBps(
            desiredQuote.askPrice,
            quote.askPrice
          );
          return (
            desiredQuote.bidSize != quote.bidSize ||
            desiredQuote.askSize != quote.askSize ||
            bidPriceMovementBps > requoteBps ||
            askPriceMovementBps > requoteBps
          );
        } else return false;
      });
      if (shouldRequote) {
        console.log(`Will issue ${asset} quotes ${JSON.stringify(quotes)}`);
        this.desiredQuotes.set(asset, quotes);
        return quotes;
      } else return [];
    }
  }

  // calculate quotes based on current exposure and quoteCashDelta/maxCashDelta params, price spread
  private _calcQuotes(
    asset: assets.Asset,
    instruments: Instrument[],
    theo: Theo
  ): Quote[] {
    // get zeta position totals
    if (theo == undefined) {
      console.log(`No theo for ${asset} yet`);
      return [];
    }

    const quotes = [];
    for (var instrument of instruments) {
      let baseDelta =
        this.positions.get(`${asset}-${instrument.marketIndex}`) ?? 0;

      let cashDelta = Math.abs(baseDelta * theo.theo);
      const params = this.assetParams.get(asset);
      let bidQuoteCashDelta = Math.min(
        instrument.quoteCashDelta,
        params.maxCashDelta
      ); // should always be quoteCashDelta
      let askQuoteCashDelta = bidQuoteCashDelta;

      const maxCashDeltaRemainder = Math.max(
        0,
        params.maxCashDelta - cashDelta
      );
      if (baseDelta > 0) {
        bidQuoteCashDelta = Math.min(bidQuoteCashDelta, maxCashDeltaRemainder);
      } else {
        askQuoteCashDelta = Math.min(askQuoteCashDelta, maxCashDeltaRemainder);
      }

      let bidQuoteSize = roundLotSize(
        bidQuoteCashDelta / theo.theo,
        params.quoteLotSize
      );
      let askQuoteSize = roundLotSize(
        askQuoteCashDelta / theo.theo,
        params.quoteLotSize
      );

      let spread = calculateSpread(
        theo.theo,
        this.assetParams.get(asset).widthBps
      );

      quotes.push({
        asset,
        marketIndex: instrument.marketIndex,
        bidPrice: convertPriceToOrderPrice(spread.bid, true),
        askPrice: convertPriceToOrderPrice(spread.ask, false),
        bidSize: convertDecimalToNativeLotSize(bidQuoteSize),
        askSize: convertDecimalToNativeLotSize(askQuoteSize),
      });
      cashDelta += bidQuoteSize - askQuoteSize;
    }
    return quotes;
  }
}
