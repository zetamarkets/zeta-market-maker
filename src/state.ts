import { assets } from "@zetamarkets/sdk";
import { Theo, TopLevelMsg, Quote } from "./types";
import { roundLotSize, calculateFair, calculateSpread } from "./math";
import { AssetParam, Instrument } from "./configuration";
import { diffInBps } from "./math";

export class State {
  private assetParams: Map<assets.Asset, AssetParam>;
  private desiredQuotes: Map<string, Quote[]> = new Map();
  private theos: Map<assets.Asset, Theo> = new Map();
  private positions: Map<string, number> = new Map();

  constructor(assetParams: Map<assets.Asset, AssetParam>) {
    this.assetParams = assetParams;
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

  getCurrentQuotes(asset: assets.Asset): Quote[] {
    return this.desiredQuotes.get(asset);
  }

  calcQuoteRefreshes(asset: assets.Asset): Quote[] {
    const theo = this.theos.get(asset);
    if (!theo) return [];

    const params = this.assetParams.get(asset);
    const newQuotes = this._calcQuotes(asset, params.instruments, theo);

    // compare with desired quotes bid/ask sizes
    const desiredQuotes = this.desiredQuotes.get(asset);
    if (!desiredQuotes) {
      this.desiredQuotes.set(asset, newQuotes);
      return newQuotes;
    } else {
      // if find any diffs with desiredQuotes, add re-issue all quotes for this asset
      const requoteBps = this.assetParams.get(asset).requoteBps;
      const shouldRequote = newQuotes.some((quote) => {
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
        this.desiredQuotes.set(asset, newQuotes);
        return newQuotes;
      } else return [];
    }
  }

  private _calcQuotes(
    asset: assets.Asset,
    instruments: Instrument[],
    theo: Theo
  ): Quote[] {
    const quotes = instruments.map((instrument) => {
      const params = this.assetParams.get(asset);
      let quoteSize = roundLotSize(
        instrument.quoteCashDelta / theo.theo,
        params.quoteLotSize
      );

      let spread = calculateSpread(
        theo.theo,
        this.assetParams.get(asset).widthBps
      );

      return {
        asset,
        marketIndex: instrument.marketIndex,
        bidPrice: spread.bid,
        askPrice: spread.ask,
        bidSize: quoteSize,
        askSize: quoteSize,
      };
    });
    return quotes;
  }
}
