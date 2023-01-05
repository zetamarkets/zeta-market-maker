import { assets } from "@zetamarkets/sdk";
import { Theo, TopLevelMsg, Quote, Venue } from "./types";
import { roundLotSize, calculateFair, calculateSpread } from "./math";
import { AssetParam, Instrument } from "./configuration";
import { diffInBps } from "./utils";
import { log } from "./log";

export class State {
  private cashDeltaLimit: number;
  private assetParams: Map<assets.Asset, AssetParam>;
  private desiredQuotes: Map<string, Quote[]> = new Map();
  private theos: Map<assets.Asset, Theo> = new Map();
  private funding: Map<assets.Asset, number> = new Map();
  private positionAgg: Map<string, number> = new Map();
  private createClientId: () => number;

  constructor(
    cashDeltaLimit: number,
    assetParams: Map<assets.Asset, AssetParam>,
    createClientId: () => number
  ) {
    this.cashDeltaLimit = cashDeltaLimit;
    this.assetParams = assetParams;
    this.createClientId = createClientId;
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
    const zetaQuotes = this.calcQuotes(
      msg.asset,
      this.assetParams.get(msg.asset).instruments,
      newTheo
    );

    // compare with desired quotes bid/ask sizes
    const desiredQuotes = this.desiredQuotes.get(msg.asset);
    if (!desiredQuotes) {
      log.info(
        `Will issue new ${msg.asset} zeta quotes ${zetaQuotes
          .map((x) => `\n- ${JSON.stringify(x)}`)
          .join("")}`
      );
      this.desiredQuotes.set(msg.asset, zetaQuotes);
      return zetaQuotes;
    } else {
      // if find any diffs with desiredQuotes, add re-issue all quotes for this asset
      const requoteBps = this.assetParams.get(msg.asset).requoteBps;
      const shouldRequote = zetaQuotes.some((quote) => {
        const desiredQuote = desiredQuotes.find(
          (x) =>
            x.asset == quote.asset &&
            x.marketIndex == quote.marketIndex &&
            x.level == quote.level
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
        log.info(`Will issue ${msg.asset} zeta quotes`);
        this.desiredQuotes.set(msg.asset, zetaQuotes);
        return zetaQuotes;
      } else return [];
    }
  }

  setPositionUpdate(
    venue: Venue,
    asset: assets.Asset,
    marketIndex: number,
    size: number
  ) {
    this.positionAgg.set(`${asset}-${marketIndex}`, size);
  }

  setFunding(asset: assets.Asset, funding: number) {
    // Note only recording for now
    this.funding.set(asset, funding);
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
      log.info(`No theo for ${asset} yet`);
      return [];
    }

    const quotes = [];
    for (var instrument of instruments) {
      let baseDelta =
        this.positionAgg.get(`${asset}-${instrument.marketIndex}`) ?? 0;

      let level = 0;
      let cashDelta = Math.abs(baseDelta * theo.theo);
      for (var { priceIncr, quoteCashDelta } of instrument.levels) {
        const params = this.assetParams.get(asset);
        let bidQuoteCashDelta = Math.min(quoteCashDelta, params.maxCashDelta); // should always be quoteCashDelta
        let askQuoteCashDelta = bidQuoteCashDelta;

        const maxCashDeltaRemainder = Math.max(
          0,
          params.maxCashDelta - cashDelta
        );
        if (baseDelta > 0) {
          bidQuoteCashDelta = Math.min(
            bidQuoteCashDelta,
            maxCashDeltaRemainder
          );
        } else {
          askQuoteCashDelta = Math.min(
            askQuoteCashDelta,
            maxCashDeltaRemainder
          );
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
          this.assetParams.get(asset).widthBps,
          baseDelta,
          this.cashDeltaLimit
        );

        quotes.push({
          asset,
          marketIndex: instrument.marketIndex,
          level,
          bidPrice: spread.bid * (1 - priceIncr),
          askPrice: spread.ask * (1 + priceIncr),
          bidSize: bidQuoteSize,
          askSize: askQuoteSize,
          bidClientOrderId: this.createClientId(),
          askClientOrderId: this.createClientId(),
        });
        level++;
        cashDelta += bidQuoteSize - askQuoteSize;
      }
    }
    return quotes;
  }
}
