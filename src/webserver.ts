import { assets, constants, Network } from "@zetamarkets/sdk";
import express from "express";
import hbs from "hbs";
import { log } from "./log";
import { DashboardState, RiskStats, Venue, ZetaRiskStats } from "./types";
import {
  isValidVenue,
  marketIndexShortDescription,
  toFixed,
  readCSV,
} from "./utils";

export function startExpress(
  port: number,
  cashDeltaHedgeThreshold: number,
  allAssets: constants.Asset[],
  network: Network,
  restartCnt: number,
  dashboardState: DashboardState
) {
  function renderPosition(
    venue: Venue,
    asset: constants.Asset,
    index: number,
    res
  ) {
    const position = dashboardState.getPosition(venue, asset, index);
    if (position == undefined) res.sendStatus(404);
    else
      res
        .setHeader(`Content-Type`, `application/json`)
        .send(JSON.stringify(position, undefined, 4));
  }

  function renderZetaOrders(res) {
    const orders = dashboardState.getZetaOrders();
    res
      .setHeader(`Content-Type`, `application/json`)
      .send(JSON.stringify(orders[0], undefined, 4));
  }

  hbs.handlebars.registerHelper("currency", function (cash: number) {
    return `$${toFixed(cash, 2)}`;
  });
  hbs.handlebars.registerHelper("baseAmount", function (cash: number) {
    return `${toFixed(cash, 5)}`;
  });
  hbs.handlebars.registerHelper(
    "currencyDeltaStyle",
    function (cashDelta: number) {
      return Math.abs(cashDelta) > cashDeltaHedgeThreshold
        ? `cashDeltaWarning`
        : `cashDeltaOk`;
    }
  );
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.set("view engine", "hbs");

  expressApp.get(`/position/:venue`, (req, res) => {
    const venue = req.params.venue;
    if (isValidVenue(venue)) renderPosition(venue, undefined, undefined, res);
    else res.sendStatus(400);
  });

  expressApp.get(`/position/:venue/:asset`, (req, res) => {
    const venue = req.params.venue;
    const asset = req.params.asset;
    if (isValidVenue(venue) && assets.isValidStr(asset))
      renderPosition(venue, asset, undefined, res);
    else res.sendStatus(400);
  });

  expressApp.get(`/position/:venue/:asset/:index`, (req, res) => {
    const venue = req.params.venue;
    const asset = req.params.asset;
    const index = +req.params.index;
    if (isValidVenue(venue) && assets.isValidStr(asset))
      renderPosition(venue, asset, index, res);
    else res.sendStatus(400);
  });

  expressApp.get(`/restart`, (_req, res) => {
    res
      .setHeader(`Content-Type`, `application/json`)
      .send(`{ "restartCnt": ${restartCnt} }`);
  });

  expressApp.get(`/orders`, (_req, res) => {
    renderZetaOrders(res);
  });

  expressApp.get("/dashboard", async (req, res) => {
    const refresh = req.query.refresh ?? 10;
    const zetaPositionAgg = dashboardState.getPosition("zeta");
    const hedgePositionAgg = dashboardState.getPosition("hedge");
    const theos = allAssets.map((asset) => dashboardState.getTheo(asset));

    const zetaBalanceValues = await readCSV("balances/zeta-balance.csv");
    const hedgeBalanceValues = await readCSV("balances/hedge-balance.csv");
    const totalBalanceValues = await readCSV("balances/total-balance.csv");
    let toGraphZTs = [];
    let toGraphZ = [];
    let toGraphHTs = [];
    let toGraphH = [];
    let toGraphTTs = [];
    let toGraphT = [];

    zetaBalanceValues.forEach((v) => {
      toGraphZTs.push(Number(v.unixTs));
      toGraphZ.push(Number(v.balance));
    });
    hedgeBalanceValues.forEach((v) => {
      toGraphHTs.push(Number(v.unixTs));
      toGraphH.push(Number(v.balance));
    });
    totalBalanceValues.forEach((v) => {
      toGraphTTs.push(Number(v.unixTs));
      toGraphT.push(Number(v.balance));
    });

    const rs = dashboardState.getRiskStats("zeta") as ZetaRiskStats;

    let riskStats = [
      {
        balance: rs.balance,
        margin: rs.marginTotal,
        availableBalance: rs.availableBalanceTotal,
        pnl: rs.pnlTotal,
        venue: "zeta",
        asset: "---",
      },
      ...allAssets.map((asset) => {
        return {
          balance: 0,
          margin: rs.perAsset.get(asset).margin,
          availableBalance: 0,
          pnl: rs.perAsset.get(asset).pnl,
          venue: "zeta",
          asset,
        };
      }),
      {
        ...(dashboardState.getRiskStats("hedge") as RiskStats),
        venue: "hedge",
        asset: "---",
      },
    ];

    res.render("dashboard", {
      now: new Date().toLocaleString(),

      refresh,
      assets: allAssets,
      // zeta
      zetaInstruments: [constants.PERP_INDEX].map((ind) => {
        let totalCash = 0;
        const prices = allAssets.map((asset) => {
          const pos = dashboardState.getPosition("zeta", asset, ind);
          totalCash += pos?.netCashDelta ?? 0;
          return { base: pos?.netBaseDelta ?? 0, cash: pos?.netCashDelta ?? 0 };
        });
        return {
          instrumentName: marketIndexShortDescription(ind),
          prices,
          totalCash,
        };
      }),
      zetaTotals: allAssets.map((a) => {
        const pos = dashboardState.getPosition("zeta", a);
        return { base: pos?.netBaseDelta ?? 0, cash: pos?.netCashDelta ?? 0 };
      }),
      zetaTotalCash: zetaPositionAgg?.netCashDelta ?? 0,

      // hedge
      hedgeTotals: allAssets.map((a) => {
        const pos = dashboardState.getPosition("hedge", a);
        return { base: pos?.netBaseDelta ?? 0, cash: pos?.netCashDelta ?? 0 };
      }),
      hedgeTotalCash: hedgePositionAgg?.netCashDelta ?? 0,

      // netCashDeltas
      netCashDeltas: allAssets.map(
        (a) =>
          (dashboardState.getPosition("zeta", a)?.netCashDelta ?? 0) +
          (dashboardState.getPosition("hedge", a)?.netCashDelta ?? 0)
      ),
      totalNetCashDelta:
        (zetaPositionAgg?.netCashDelta ?? 0) +
        (hedgePositionAgg?.netCashDelta ?? 0),

      theos,
      theosTs: theos.map((x) => new Date(x?.timestamp).toLocaleString()),

      riskStats,

      quoteBreaches: dashboardState
        .getQuoteBreaches()
        .map(
          (x) =>
            `${x.type} ${x.asset}${
              x.marketIndex
                ? `-${marketIndexShortDescription(x.marketIndex)}`
                : ""
            } rejects ${x.rejectedQuoteTypes} due to cash ${x.cash} vs limit ${
              x.limit
            }`
        ),

      network,
      restartCnt,
      zetaBalanceToGraphX: JSON.stringify(toGraphZTs),
      zetaBalanceToGraphY: JSON.stringify(toGraphZ),
      hedgeBalanceToGraphX: JSON.stringify(toGraphHTs),
      hedgeBalanceToGraphY: JSON.stringify(toGraphH),
      balanceToGraphX: JSON.stringify(toGraphTTs),
      balanceToGraphY: JSON.stringify(toGraphT),
    });
  });

  expressApp.listen(port, () =>
    log.info(`Express server started at port ${port}`)
  );
}
