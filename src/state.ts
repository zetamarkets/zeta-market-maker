import { constants } from "@zetamarkets/sdk";
import { Theo, TopLevelMsg, Quote } from "./types";
import { roundLotSize, calculateFair, calculateSpread } from "./math";
import { AssetParam } from "./configuration";
import { diffInBps } from "./math";

export class State {
  private assetParams: Map<constants.Asset, AssetParam>;
  private desiredQuotes: Map<string, Quote> = new Map();
  private theos: Map<constants.Asset, Theo> = new Map();

  constructor(assetParams: Map<constants.Asset, AssetParam>) {
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

  getTheo(asset: constants.Asset): Theo {
    return this.theos.get(asset);
  }

  getCurrentQuotes(asset: constants.Asset): Quote {
    return this.desiredQuotes.get(asset);
  }

  calcQuoteRefreshes(asset: constants.Asset): Quote {
    const theo = this.theos.get(asset);
    if (!theo) return undefined;

    const params = this.assetParams.get(asset);
    const newQuotes = this._calcQuotes(asset, params.quoteCashDelta, theo);

    // compare with desired quotes bid/ask sizes
    const desiredQuote = this.desiredQuotes.get(asset);
    if (!desiredQuote) {
      this.desiredQuotes.set(asset, newQuotes);
      return newQuotes;
    } else {
      // if find any diffs with desiredQuotes, add re-issue all quotes for this asset
      const requoteBps = this.assetParams.get(asset).requoteBps;

      const bidPriceMovementBps = diffInBps(
        desiredQuote.bidPrice,
        newQuotes.bidPrice
      );
      const askPriceMovementBps = diffInBps(
        desiredQuote.askPrice,
        newQuotes.askPrice
      );
      if (
        desiredQuote.bidSize != newQuotes.bidSize ||
        desiredQuote.askSize != newQuotes.askSize ||
        bidPriceMovementBps > requoteBps ||
        askPriceMovementBps > requoteBps
      ) {
        this.desiredQuotes.set(asset, newQuotes);
        return newQuotes;
      } else return undefined;
    }
  }

  private _calcQuotes(
    asset: constants.Asset,
    cashDelta: number,
    theo: Theo
  ): Quote {
    const params = this.assetParams.get(asset);
    let quoteSize = roundLotSize(cashDelta / theo.theo, params.quoteLotSize);

    let spread = calculateSpread(
      theo.theo,
      this.assetParams.get(asset).widthBps
    );

    return {
      asset,
      bidPrice: spread.bid,
      askPrice: spread.ask,
      bidSize: quoteSize,
      askSize: quoteSize,
    };
  }
}
