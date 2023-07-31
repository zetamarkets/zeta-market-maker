import { Keypair, Transaction } from "@solana/web3.js";
import {
  CrossClient,
  constants,
  Exchange,
  types,
  utils,
} from "@zetamarkets/sdk";
import { Exchange as ExchangePro, Order } from "ccxt";
import { BlockhashFetcher } from "./blockhash";
import { convertPriceToOrderPrice } from "./math";
import { assetToMarket, HedgeOrder, Quote } from "./types";
import { groupBy, toFixed } from "./utils";
import { log } from "./log";

export class Trader {
  private assets: constants.Asset[];
  private zetaClient: CrossClient;

  private hedgeExchange: ExchangePro;
  private blockhashFetcher: BlockhashFetcher;
  private isInitialized: boolean = false;
  private isShuttingDown: boolean = false;
  private tifExpiryOffsetSecs: number;

  constructor(tifExpiryOffsetSecs: number) {
    this.tifExpiryOffsetSecs = tifExpiryOffsetSecs;
  }

  async initialize(
    assets: constants.Asset[],
    blockhashFetcher: BlockhashFetcher,
    zetaClient: CrossClient,

    hedgeExchange: ExchangePro
  ) {
    this.assets = assets;
    this.blockhashFetcher = blockhashFetcher;
    this.zetaClient = zetaClient;

    this.hedgeExchange = hedgeExchange;
    blockhashFetcher.subscribe();
    this.isInitialized = true;
  }

  async sendHedgeOrders(orders: HedgeOrder[]): Promise<string[]> {
    if (!this.isInitialized || this.isShuttingDown) {
      log.warn(
        `Trader not yet initialized or shutting down, ignoring sendHedgeOrders()`
      );
      return;
    }

    return Promise.all(
      orders.map(async (order) => {
        log.info(
          `Issuing hedge order: ${order.market} ${order.side} ${toFixed(
            order.baseAmount,
            5
          )} @ ${toFixed(order.price, 5)}`
        );
        await this.hedgeExchange.createLimitOrder(
          order.market,
          order.side,
          order.baseAmount,
          order.price,
          {
            timeInForce: `IOC`,
            order_link_id: order.clientOrderId,
            // leverage: 1,
            // position_idx as per https://medium.com/superalgos/superalgos-goes-perps-on-bybit-5dc2be9a59a7
            position_idx: 0,
          }
        );
        return order.clientOrderId;
      })
    );
  }

  async getHedgeOrders(
    asset: constants.Asset,
    linkOrderIds?: string[]
  ): Promise<Order[]> {
    if (!this.isInitialized || this.isShuttingDown) {
      log.warn(
        `Trader not yet initialized or shutting down, ignoring getHedgeOrders()`
      );
      return;
    }

    const market = assetToMarket(asset);
    const orders = await this.hedgeExchange.fetchOrders(market);
    if (linkOrderIds)
      return orders.filter((x) => linkOrderIds.includes(x.clientOrderId));
    else return orders;
  }

  async sendZetaQuotes(quotes: Quote[]) {
    if (!this.isInitialized || this.isShuttingDown) {
      log.warn(
        `Trader not yet initialized or shutting down, ignoring sendZetaQuotes()`
      );
      return;
    }

    // group by asset, marketIndex, level
    const viableQuotes = quotes.filter(
      (q) =>
        q.marketIndex == constants.PERP_INDEX ||
        Exchange.getSubExchange(q.asset).markets.markets[
          q.marketIndex
        ].expirySeries.isLive()
    );
    const quoteByAsset = groupBy(
      viableQuotes,
      (q) => `${q.asset}-${q.marketIndex}`
    );

    await Promise.all(
      quoteByAsset.map(async ([_key, quotes]) => {
        await this.sendZetaQuotesForAsset(quotes[0].asset, quotes);
      })
    );
  }

  private async sendZetaQuotesForAsset(asset: constants.Asset, msgs: Quote[]) {
    // sort by level to ensure level0 cancellations are preformed first
    const levelSorted = groupBy(msgs, (msg) => msg.level).sort(
      ([l1, _q1], [l2, _q2]) => l1 - l2
    );

    let orderStr = "";

    let clientToUse = this.zetaClient;

    let atomicCancelAndPlaceTx = new Transaction().add(
      clientToUse.createCancelAllMarketOrdersInstruction(asset)
    );
    for (var [level, quotes] of levelSorted) {
      for (var quote of quotes.filter(({ size }) => size > 0)) {
        const price = convertPriceToOrderPrice(quote.price, true);
        const size = utils.convertDecimalToNativeLotSize(quote.size);
        const marketIndex = quote.marketIndex;
        const side = quote.side;
        const clientOrderId = quote.clientOrderId;

        let orderOptions: types.OrderOptions = {
          // Note: switching to wall clock expiryTs, as means to mitigate CannotPlaceExpiredOrder errors
          // tifOptions: { expiryOffset: this.tifExpiryOffsetSecs },
          orderType: types.OrderType.POSTONLYSLIDE,
          tifOptions: {
            expiryTs: Date.now() / 1000 + this.tifExpiryOffsetSecs,
          },
          clientOrderId,
        };

        atomicCancelAndPlaceTx.add(
          clientToUse.createPlacePerpOrderInstruction(
            asset,
            price,
            size,
            side == "bid" ? types.Side.BID : types.Side.ASK,
            orderOptions
          )
        );

        const priceAsDecimal = utils.convertNativeIntegerToDecimal(price);
        orderStr = orderStr.concat(
          `\n[${side.toUpperCase()}] ${asset} index ${marketIndex}, level ${level}, ${utils.convertNativeLotSizeToDecimal(
            size
          )} lots @ $${priceAsDecimal}, ts-delta ${
            Date.now() / 1000 - Exchange.clockTimestamp
          }`
        );
      }
    }

    // execute txs with fallback of cancellation
    let blockhash = this.blockhashFetcher.blockhash;

    try {
      await utils.processTransaction(
        clientToUse.provider,
        atomicCancelAndPlaceTx,
        undefined,
        undefined,
        undefined,
        utils.getZetaLutArr(),
        blockhash
      );
      log.debug(
        `Sent new zeta quotes for ${asset} marketIndices-levels ${msgs
          .map((x) => `${x.marketIndex}-${x.level}`)
          .join(", ")}!`
      );
    } catch (e) {
      log.warn(
        `Asset: ${asset}, Failed to send txns on blockhash ${blockhash}`,
        e
      );
    }
  }

  async shutdown() {
    if (!this.isInitialized || this.isShuttingDown) {
      log.warn(
        `Trader not yet initialized or shutting down, ignoring shutdown()`
      );
      return;
    }

    this.isShuttingDown = true;
    try {
      let retry = 0;
      while (retry < 10) {
        try {
          await this.zetaClient.updateState();
          const totalOrders = this.assets
            .map((asset) => this.zetaClient.orders.get(asset).length)
            .reduce((x, y) => x + y, 0);
          if (totalOrders > 0) {
            log.info(
              `About to cancel ${totalOrders} zeta orders for assets ${this.assets.join(
                ", "
              )}`
            );
            await this.zetaClient.cancelAllOrders();
          } else {
            log.info(`Cancelled all zeta orders`);
            break;
          }
        } catch (e) {
          retry++;
          log.info(`Zeta shutdown error ${e}, retry ${retry}...`);
        }
      }
    } finally {
      this.zetaClient.close();
    }

    for (var asset of this.assets)
      await this.hedgeExchange.cancelAllOrders(assetToMarket(asset));
    this.blockhashFetcher.shutdown();
  }
}

export class PermissionedTrader {
  private trader: Trader;

  constructor(tifExpiryOffsetSecs: number) {
    this.trader = new Trader(tifExpiryOffsetSecs);
  }

  async initialize(
    assets: constants.Asset[],
    blockhashFetcher: BlockhashFetcher,
    zetaClient: CrossClient,
    hedgeExchange: ExchangePro
  ) {
    await this.trader.initialize(
      assets,
      blockhashFetcher,
      zetaClient,
      hedgeExchange
    );
  }

  async sendHedgeOrders(orders: HedgeOrder[]): Promise<string[]> {
    return await this.trader.sendHedgeOrders(orders);
  }

  async sendZetaQuotes(quotes: Quote[]) {
    await this.trader.sendZetaQuotes(quotes);
  }

  async shutdown() {
    await this.trader.shutdown();
  }

  async getHedgeOrders(
    asset: constants.Asset,
    linkOrderIds?: string[]
  ): Promise<Order[]> {
    return await this.trader.getHedgeOrders(asset, linkOrderIds);
  }
}
