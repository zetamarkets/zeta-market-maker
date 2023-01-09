import { assets } from "@zetamarkets/sdk";
import { Theo, TopLevelMsg, Quote } from "./types";
import { roundLotSize, calculateFair, calculateSpread } from "./math";
import { AssetParam, Instrument } from "./configuration";
import { diffInBps } from "./math";
import { idCreator } from "./utils";

export class State {
  private assetParams: Map<assets.Asset, AssetParam>;
  private desiredQuotes: Map<string, Quote[]> = new Map();
  private theos: Map<assets.Asset, Theo> = new Map();
  private funding: Map<assets.Asset, number> = new Map();
  private positions: Map<string, number> = new Map();
  private createClientId = idCreator();

  constructor(assetParams: Map<assets.Asset, AssetParam>) {
    this.assetParams = assetParams;
  }

  getCurrentQuotes(asset: assets.Asset): Quote[] {
    return this.desiredQuotes.get(asset);
  }

  calcNewQuotes(asset: assets.Asset): Quote[] {
    const theo = this.theos.get(asset);
    if (!theo) [];

    const zetaQuotes = this.calcQuotes(
      asset,
      this.assetParams.get(asset).instruments,
      theo
    );
    this.desiredQuotes.set(asset, zetaQuotes);
    return zetaQuotes;
  }

  setMarkPriceUpdate(msg: TopLevelMsg, timestamp: number): Quote[] {
    const newTheo = {
      theo: calculateFair(msg),
      topBid: msg.topLevel.bid,
      topAsk: msg.topLevel.ask,
      timestamp,
    };
    this.theos.set(msg.asset, newTheo);
    const newQuotes = this.calcQuotes(
      msg.asset,
      this.assetParams.get(msg.asset).instruments,
      newTheo
    );

    // compare with desired quotes bid/ask sizes
    const desiredQuotes = this.desiredQuotes.get(msg.asset);
    if (!desiredQuotes) {
      console.log(
        `Will issue new ${msg.asset} quotes ${JSON.stringify(newQuotes)}`
      );
      this.desiredQuotes.set(msg.asset, newQuotes);
      return newQuotes;
    } else {
      // if find any diffs with desiredQuotes, add re-issue all quotes for this asset
      const requoteBps = this.assetParams.get(msg.asset).requoteBps;
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
        console.log(
          `Will issue ${msg.asset} quotes ${JSON.stringify(newQuotes)}`
        );
        this.desiredQuotes.set(msg.asset, newQuotes);
        return newQuotes;
      } else return [];
    }
  }

  setPositionUpdate(asset: assets.Asset, marketIndex: number, size: number) {
    this.positions.set(`${asset}-${marketIndex}`, size);
  }

  getTheo(asset: assets.Asset): Theo {
    return this.theos.get(asset);
  }

  // calculate quotes based on current exposure and quoteCashDelta/maxCashDelta params, price spread
  private calcQuotes(
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
        bidPrice: spread.bid,
        askPrice: spread.ask,
        bidSize: bidQuoteSize,
        askSize: askQuoteSize,
        bidClientOrderId: this.createClientId(),
        askClientOrderId: this.createClientId(),
      });
      cashDelta += bidQuoteSize - askQuoteSize;
    }
    return quotes;
  }
}
