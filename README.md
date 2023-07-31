# Maker

Maker bot with ability to provide liquidity to Zeta DEX, and offset via Hedge exchange (eg. bybit)

[![build](../../workflows/build/badge.svg)](../../actions/workflows/build.yml)

## Setup

1. Add wallet key and bybit api key to secrets.json.
2. Choose configuration parameters in config.json.
3. Add RPC endpoint.
4. For new wallets, `ts-node src/initialize_accs.ts`, this will deposit a specified amount into Zeta DEX.

## Run

```sh
npm i
ts-node src/app.ts
```

## Remote setup

Expose port 85 used by web APIs.

```sh
# allow for port 85 usage
sudo setcap cap_net_bind_service=+ep /usr/bin/node
```

## Web interface

```
# fetches positions and top level summaries
curl localhost:85/position/zeta          # venue: zeta or hedge
curl localhost:85/position/zeta/BTC      # venue: zeta or hedge, asset: BTC, ETH or SOL

# fetches restart counter
curl localhost:85/restart

# renders auto-refreshed html dashboard
localhost:85/dashboard?refresh=10        # if no refresh param, defaults to 10s
```

## Configuration Parameters

```
  "quoteIntervalMs": 30000, // interval for periodic refresh of all quotes, regardless of price movements
  "markPriceStaleIntervalMs": 5000, // MM bot will shutdown if mark prices are stale by more than this time
  "positionRefreshIntervalMs": 10000, // How often positions will be refreshed on Zeta and hedge exchange
  "riskStatsFetchIntervalMs": 30000, // How often risk stats will be refreshed on Zeta and hedge exchange
  "lockingIntervalMs": 3000, // Mutex wrapper config, for resource locking
  "tifExpiryOffsetMs": 30000, // If using TIF orders, the maximum time orders will be live for

  "cashDeltaHedgeThreshold": 10000, // in $ terms, the delta mm bot can reach between Zeta and Hedge exchange before it auto-hedges
  "webServerPort": 85,

  "assets": {
    "SOL": {
      "maxZetaCashExposure": 25000, // in $ terms, maximum position mm bot will accumulate on zeta before it only tries to reduce it's position
      "maxNetCashDelta": 20000, // in $ terms, another safety barrier where if the delta between Zeta and hedge exchange >= maxNetCashDelta, we stop quoting
      "quoteLotSize": 0.01, // The number of lots to quote incrementally
      "widthBps": 12, // quote width
      "requoteBps": 1, // if mark price moves requoteBps, mm bot will requote
      "instruments": [ // each level is how much size you are quoting at the respective price increment in $ terms.
        {
          "marketIndex": 137,
          "levels": [
            { "priceIncr": 0.0, "quoteCashDelta": 200 },
            { "priceIncr": 0.0005, "quoteCashDelta": 1000 },
            { "priceIncr": 0.001, "quoteCashDelta": 5000 },
            { "priceIncr": 0.0015, "quoteCashDelta": 5000 },
            { "priceIncr": 0.004, "quoteCashDelta": 15000 }
          ]
        }
      ],
      "leanBps": 5 // how much the mm will lean its quotes as it accumulates a position either long or short
    }
  }
```
