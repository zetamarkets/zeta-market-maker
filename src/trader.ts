import { Transaction } from "@solana/web3.js";
import {
  assets,
  Client,
  constants,
  Exchange,
  types,
  utils,
} from "@zetamarkets/sdk";
import { convertPriceToOrderPrice } from "./math";
import { Quote } from "./types";
import { groupBy } from "./utils";
import { log } from "./log";

export class Trader {
  private assets: assets.Asset[];
  private zetaClient: Client;
  private isReady: boolean = false;

  async initialize(assets: assets.Asset[], zetaClient: Client) {
    this.assets = assets;
    this.zetaClient = zetaClient;
    this.isReady = true;
  }

  async getZetaOrders(asset: assets.Asset): Promise<types.Order[]> {
    return await this.zetaClient.getOrders(asset);
  }

  async sendZetaQuotes(msgs: Quote[]) {
    if (!this.isReady) {
      log.warn(`Trader not ready, ignoring sendZetaQuotes()`);
      return;
    }

    // group by asset, marketIndex, level
    const msgsByAsset = groupBy(msgs, (msg) => msg.asset);

    await Promise.all(
      msgsByAsset.map(
        async ([asset, msgs]) => await this.sendZetaQuotesForAsset(asset, msgs)
      )
    );
  }

  private async sendZetaQuotesForAsset(asset: assets.Asset, msgs: Quote[]) {
    let firstLevelTxs = [];
    let otherLevelTxs = [];

    const sub = Exchange.getSubExchange(asset);

    for (var msg of msgs) {
      if (
        msg.marketIndex != constants.PERP_INDEX &&
        !sub.markets.markets[msg.marketIndex].expirySeries.isLive()
      )
        continue;

      const ixs = [];
      if (msg.bidSize != 0) {
        const price = convertPriceToOrderPrice(msg.bidPrice, true);
        const size = utils.convertDecimalToNativeLotSize(msg.bidSize);
        ixs.push(
          this.zetaClient.createPlaceOrderInstruction(
            msg.asset,
            msg.marketIndex,
            price,
            size,
            types.Side.BID,
            undefined,
            msg.bidClientOrderId
          )
        );
      }

      // add asks quotes
      if (msg.askSize != 0) {
        const price = convertPriceToOrderPrice(msg.askPrice, false);
        const size = utils.convertDecimalToNativeLotSize(msg.askSize);
        ixs.push(
          this.zetaClient.createPlaceOrderInstruction(
            msg.asset,
            msg.marketIndex,
            price,
            size,
            types.Side.ASK,
            undefined,
            msg.askClientOrderId
          )
        );
      }

      if (msg.level == 0) {
        const tx = new Transaction().add(
          // preempt with a cancel ixn for the first level
          this.zetaClient.createCancelAllMarketOrdersInstruction(
            msg.asset,
            msg.marketIndex
          ),
          ...ixs
        );
        firstLevelTxs.push(tx);
      } else if (ixs.length > 0) {
        const tx = new Transaction().add(...ixs);
        otherLevelTxs.push(tx);
      }
    }

    try {
      // execute first level txs (with cancel)
      await Promise.all(
        firstLevelTxs.map(
          async (tx) =>
            await utils.processTransaction(this.zetaClient.provider, tx)
        )
      );

      // execute other level txs
      await Promise.all(
        otherLevelTxs.map(
          async (tx) =>
            await utils.processTransaction(this.zetaClient.provider, tx)
        )
      );
    } catch (e) {
      // in case of any error - cancel any newly placed orders
      log.warn("Failed to send txns, cancelling zeta quotes", e);
      try {
        const cancelTx = new Transaction();
        const marketIndices = msgs.map((x) => x.marketIndex);
        for (var index of marketIndices) {
          cancelTx.add(
            this.zetaClient.createCancelAllMarketOrdersInstruction(
              msg.asset,
              index
            )
          );
        }

        await utils.processTransaction(this.zetaClient.provider, cancelTx);
      } catch (e) {
        log.info("Failed to cancel orders", e);
      }
    }
  }

  async shutdown() {
    if (!this.isReady) {
      log.warn(`Trader not ready, ignoring shutdown()`);
      return;
    }

    this.isReady = false;
    try {
      let retry = 0;
      while (retry < 10) {
        try {
          await this.zetaClient.updateState();
          const totalOrders = this.assets
            .map((asset) => this.zetaClient.getSubClient(asset).orders.length)
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
  }
}
