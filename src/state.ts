import { constants } from "@zetamarkets/sdk";
import {
  Theo,
  TopLevelMsg,
  PositionNotificationAgg,
  Venue,
  HedgeOrder,
  PositionNotification,
  assetToMarket,
  MarketIndex,
  Quote,
  QuoteBreach,
} from "./types";
import { roundLotSize, calculateFair, calculateSpread } from "./math";
import { PositionAgg } from "./position-agg";
import { AssetParam, Instrument } from "./configuration";
import { diffInBps, marketIndexShortDescription, toFixed } from "./utils";
import { log } from "./log";

export interface Effects {
  hedgeOrders: HedgeOrder[];
  zetaPositionNotifications: PositionNotification[];
  hedgePositionNotifications: PositionNotification[];
}

function emptyEffects(): Effects {
  return {
    hedgeOrders: [],
    zetaPositionNotifications: [],
    hedgePositionNotifications: [],
  };
}

export interface QuotingEffects {
  quotes: Quote[];
  breaches: QuoteBreach[];
}

export class State {
  private cashDeltaHedgeThreshold: number;
  private assetParams: Map<constants.Asset, AssetParam>;
  private quoting: Map<string, QuotingEffects> = new Map();
  private theos: Map<constants.Asset, Theo> = new Map();
  private funding: Map<constants.Asset, number> = new Map();
  private positionAgg: PositionAgg = new PositionAgg();
  private getInstrumentDescription: (a: constants.Asset, i?: number) => string;
  private createClientId: () => number;

  constructor(
    cashDeltaHedgeThreshold: number,
    assetParams: Map<constants.Asset, AssetParam>,
    getInstrumentDescription: (
      asset: constants.Asset,
      index?: number
    ) => string,
    createClientId: () => number
  ) {
    this.cashDeltaHedgeThreshold = cashDeltaHedgeThreshold;
    this.assetParams = assetParams;
    this.getInstrumentDescription = getInstrumentDescription;
    this.createClientId = createClientId;
  }

  getCurrentQuotes(asset: constants.Asset): QuotingEffects {
    return this.quoting.get(asset);
  }

  calcNewQuotes(asset: constants.Asset): QuotingEffects {
    const { quotes, breaches } = this.calcQuotes(
      asset,
      this.assetParams.get(asset).instruments,
      this.theos.get(asset)
    );

    this.quoting.set(asset, { quotes, breaches });
    return { quotes, breaches };
  }

  setMarkPriceUpdate(msg: TopLevelMsg, timestamp: number) {
    const newTheo = {
      theo: calculateFair(msg),
      topBid: msg.topLevel.bid,
      topAsk: msg.topLevel.ask,
      timestamp,
    };
    this.theos.set(msg.asset, newTheo);
  }

  calcQuoting(asset: constants.Asset): QuotingEffects {
    const { quotes, breaches } = this.calcQuotes(
      asset,
      this.assetParams.get(asset).instruments,
      this.theos.get(asset)
    );

    // compare price movements, re-issue only if exceeds requoteBps
    const quoting = this.quoting.get(asset);
    if (!quoting) {
      log.info(
        `Will issue new zeta quotes for ${asset} ${quotes
          .map((x) => `\n- ${JSON.stringify(x)}`)
          .join("")}`
      );
      this.quoting.set(asset, { quotes, breaches });
      return { quotes, breaches };
    } else {
      // if find any diffs with desiredQuotes, add re-issue all quotes for this asset
      // FIXME: optimize to re-issue just the changed quotes
      const changes: string[] = [];

      const requoteBps = this.assetParams.get(asset).requoteBps;
      if (quoting.quotes.length != quotes.length)
        changes.push(
          `- change in quote counts:${quoting.quotes.length} => ${quotes.length}`
        );
      for (var quote of quotes) {
        const expQuote = quoting.quotes.find(
          (x) =>
            x.asset == quote.asset &&
            x.marketIndex == quote.marketIndex &&
            x.level == quote.level &&
            x.side == quote.side
        );
        if (expQuote) {
          const priceMovementBps = diffInBps(expQuote.price, quote.price);
          if (priceMovementBps > requoteBps)
            changes.push(
              `- asset ${quote.asset}, side: ${quote.side}, marketIndex: ${
                quote.marketIndex
              }, level: ${quote.level}, size: ${expQuote.size} => ${
                quote.size
              }, price: ${toFixed(expQuote.price, 2)} => ${toFixed(
                quote.price,
                2
              )} (moved ${toFixed(priceMovementBps, 5)}bps), clientOrderId: ${
                quote.clientOrderId
              }`
            );
        } else {
          changes.push(
            `- non-existing quote asset ${quote.asset}, side: ${quote.side}, marketIndex: ${quote.marketIndex}, level: ${quote.level}, size: ${quote.size}, clientOrderId: ${quote.clientOrderId}`
          );
        }
      }

      if (changes.length > 0) {
        log.info(
          `Will issue zeta quotes for ${asset} due to price(/size) changes:\n${changes.join(
            "\n"
          )}`
        );
        this.quoting.set(asset, { quotes, breaches });
        return { quotes, breaches };
      } else {
        log.debug(
          `No quotes issued for ${JSON.stringify(
            asset
          )}, no changes compared with existing desired quotes`
        );
        return { quotes: [], breaches };
      }
    }
  }

  setPositionUpdate(
    venue: Venue,
    asset: constants.Asset,
    marketIndex: number,
    size: number,
    forceRun: boolean = false
  ): Effects {
    const prevSize =
      this.positionAgg.sum({
        venue,
        asset,
        marketIndex,
      }) ?? 0;
    if (!forceRun && size == prevSize) return emptyEffects(); // no change, early exit

    this.positionAgg.set({ venue, asset, marketIndex }, size);
    const zetaAssetBaseSize = this.positionAgg.sum({ venue: "zeta", asset });
    const hedgeAssetBaseSize = this.positionAgg.sum({ venue: "hedge", asset });
    const theo = this.theos.get(asset);

    let hedgeOrders: HedgeOrder[] = [];
    let zetaPositionNotifications: PositionNotification[] = [];
    let hedgePositionNotifications: PositionNotification[] = [];

    if (
      theo != undefined &&
      zetaAssetBaseSize != undefined &&
      hedgeAssetBaseSize != undefined
    ) {
      const baseDelta = hedgeAssetBaseSize + zetaAssetBaseSize;
      const absBaseDelta = Math.abs(baseDelta);
      const absCashDelta = absBaseDelta * theo.theo;

      if (absCashDelta > this.cashDeltaHedgeThreshold) {
        const side = baseDelta > 0 ? "sell" : "buy";
        const price = side == "buy" ? theo.topAsk.price : theo.topBid.price;
        hedgeOrders = [
          {
            asset,
            market: assetToMarket(asset),
            side,
            price,
            baseAmount: absBaseDelta,
            clientOrderId: "" + this.createClientId(),
          },
        ];
        log.info(
          `Will send ${asset} hedge order due to absCashDelta ${toFixed(
            absCashDelta,
            2
          )} > cashDeltaHedgeThreshold ${
            this.cashDeltaHedgeThreshold
          }: ${side} ${absBaseDelta} (zeta ${zetaAssetBaseSize} - hedge ${hedgeAssetBaseSize}) @ ${price}, trigger position change: ${venue} ${asset}-${marketIndex}: ${size} @${
            theo.theo
          }, forceRun: ${forceRun}`
        );
      } else
        log.debug(
          `No ${asset} hedge orders issued due to absCashDelta ${toFixed(
            absCashDelta,
            2
          )} (base zeta ${zetaAssetBaseSize} - hedge ${hedgeAssetBaseSize}, @ ${toFixed(
            theo.theo,
            2
          )}) <= cashDeltaHedgeThreshold ${
            this.cashDeltaHedgeThreshold
          }, trigger position change: ${venue} ${asset}-${marketIndex}: ${size} @${
            theo.theo
          }, forceRun: ${forceRun}`
        );
    } else
      log.debug(
        `No ${asset} hedge orders issued due to uninitialized: theo ${toFixed(
          theo?.theo,
          2
        )}, zetaAssetBaseSize ${zetaAssetBaseSize}, hedgeAssetBaseSize ${hedgeAssetBaseSize}, trigger position change: ${venue} ${asset}-${marketIndex}: ${size} @${
          theo?.theo
        }, forceRun: ${forceRun}`
      );

    if (venue == "zeta" && theo && size != prevSize)
      zetaPositionNotifications = [
        {
          venue,
          asset,
          marketIndex,
          instrumentDescriptionShort: marketIndexShortDescription(marketIndex),
          instrumentDescription: this.getInstrumentDescription(
            asset,
            marketIndex
          ),
          baseSize: size,
          cashSize: size * theo.theo,
          topLevels: this.toTopLevels(),
          markPrice: theo.theo,
        },
      ];
    else if (venue == "hedge" && theo && size != prevSize)
      hedgePositionNotifications = [
        {
          venue,
          asset,
          marketIndex,
          instrumentDescriptionShort: marketIndexShortDescription(marketIndex),
          instrumentDescription: this.getInstrumentDescription(
            asset,
            marketIndex
          ),
          baseSize: size,
          cashSize: size * theo.theo,
          topLevels: this.toTopLevels(),
          markPrice: theo.theo,
        },
      ];

    return {
      hedgeOrders,
      zetaPositionNotifications,
      hedgePositionNotifications,
    };
  }

  setFunding(asset: constants.Asset, funding: number) {
    // Note only recording for now
    this.funding.set(asset, funding);
  }

  getTheo(asset: constants.Asset): Theo {
    return this.theos.get(asset);
  }

  getPosition(
    venue: Venue,
    asset?: constants.Asset,
    index?: MarketIndex
  ): PositionNotificationAgg {
    const positions = this.positionAgg.get({
      venue,
      asset,
      marketIndex: index,
    });
    if (positions.length == 0) return;

    let netBaseDelta = 0;
    let netCashDelta = 0;
    var fetchedAssets = new Set();
    let theo: number;
    for (var [posKey, pos] of positions) {
      netBaseDelta += pos;
      netCashDelta += pos * this.theos.get(posKey.asset)?.theo ?? 0;
      fetchedAssets.add(posKey.asset);
    }
    return {
      positions: positions
        .filter(([posKey, _]) => this.theos.has(posKey.asset))
        .map(([posKey, pos]) => {
          theo = this.theos.get(posKey.asset).theo;
          return {
            venue: posKey.venue,
            asset: posKey.asset,
            marketIndex: posKey.marketIndex,
            instrumentDescriptionShort: marketIndexShortDescription(index),
            instrumentDescription: this.getInstrumentDescription(asset, index),
            baseSize: pos,
            topLevels: this.toTopLevels(),
            cashSize: pos * theo,
            markPrice: theo,
          };
        }),
      netCashDelta,
      // netBaseDelta only set if returned positions represent a single asset
      netBaseDelta: fetchedAssets.size <= 1 ? netBaseDelta : undefined,
      markPrice: fetchedAssets.size <= 1 ? theo : undefined,
    };
  }

  // calculate quotes based on current exposure and quoteCashDelta/maxCashDelta params, price spread
  private calcQuotes(
    asset: constants.Asset,
    instruments: Instrument[],
    theo: Theo
  ): QuotingEffects {
    // get zeta position totals
    if (theo == undefined) {
      log.debug(`No theo for ${asset} yet`);
      return { quotes: [], breaches: [] };
    }

    const quotes: Quote[] = [];
    for (var instrument of instruments) {
      let zetaBase =
        this.positionAgg.sum({
          venue: "zeta",
          asset,
          marketIndex: instrument.marketIndex,
        }) ?? 0;

      let spread = calculateSpread(
        theo.theo,
        this.assetParams.get(asset).widthBps,
        zetaBase,
        this.cashDeltaHedgeThreshold,
        this.assetParams.get(asset).leanBps
      );

      let level = 0;
      for (var { priceIncr, quoteCashDelta } of instrument.levels) {
        const params = this.assetParams.get(asset);
        let quoteSize = roundLotSize(
          quoteCashDelta / theo.theo,
          params.quoteLotSize
        );
        quotes.push({
          asset,
          side: "bid",
          marketIndex: instrument.marketIndex,
          level,
          price: spread.bid * (1 - priceIncr),
          size: quoteSize,
          clientOrderId: this.createClientId(),
        });
        quotes.push({
          asset,
          side: "ask",
          marketIndex: instrument.marketIndex,
          level,
          price: spread.ask * (1 + priceIncr),
          size: quoteSize,
          clientOrderId: this.createClientId(),
        });
        level++;
      }
    }

    const breaches = this.getQuoteBreaches(asset);
    const rejectedQuoteTypes = new Set(
      breaches.flatMap((x) => x.rejectedQuoteTypes)
    );
    if (rejectedQuoteTypes.size != 0) {
      let [rj] = rejectedQuoteTypes;
      log.info(`Reject ${rj}`);
    }
    const rejectBids = rejectedQuoteTypes.has("bid");
    const rejectAsks = rejectedQuoteTypes.has("ask");

    quotes.forEach((q) => {
      if ((rejectBids && q.side == "bid") || (rejectAsks && q.side == "ask"))
        q.size = 0;
    });

    return { quotes, breaches };
  }

  getQuoteBreaches(asset: constants.Asset): QuoteBreach[] {
    let theo = this.theos.get(asset)?.theo;
    if (theo == undefined) return [];

    const params = this.assetParams.get(asset);
    const indices = params.instruments.map((i) => i.marketIndex);
    const maxZetaCash = params.maxZetaCashExposure;
    const breachCandidates = indices.map((i) => {
      const base =
        this.positionAgg.sum({ venue: "zeta", asset, marketIndex: i }) ?? 0;
      const cash = base * theo;
      const rejectedQuoteTypes =
        Math.abs(cash) < maxZetaCash ? "neither" : cash > 0 ? "bid" : "ask";
      return {
        type: "zeta",
        rejectedQuoteTypes,
        asset: asset,
        marketIndex: i,
        cash,
        limit: maxZetaCash,
      };
    });

    const netCash = (this.positionAgg.sum({ asset }) ?? 0) * theo;
    const maxNetCash = params.maxNetCashDelta;
    const rejectedQuoteTypes =
      Math.abs(netCash) < maxNetCash ? "neither" : netCash > 0 ? "bid" : "ask";
    breachCandidates.push({
      type: "net",
      rejectedQuoteTypes,
      asset: asset,
      marketIndex: undefined,
      cash: netCash,
      limit: maxNetCash,
    });

    const breaches = breachCandidates
      .filter(({ rejectedQuoteTypes }) => rejectedQuoteTypes != "neither")
      .map((x) => x as QuoteBreach);
    return breaches;
  }

  private toTopLevels(): {
    venue: Venue;
    asset: constants.Asset;
    base: number;
    cash: number;
  }[] {
    const allAssets = Array.from(this.assetParams.keys());
    return [
      ...["zeta", "hedge"].flatMap((venue: Venue) =>
        allAssets.map((asset) => {
          return { venue, asset };
        })
      ),
      ...allAssets.map((asset) => {
        return {
          venue: undefined,
          asset,
        };
      }),
    ].map(({ venue, asset }) => {
      const base = this.positionAgg.sum({ venue, asset }) ?? 0;
      const mark = this.theos.get(asset)?.theo ?? 0;
      const cash = base * mark;
      return { venue, asset, base, cash };
    });
  }
}
