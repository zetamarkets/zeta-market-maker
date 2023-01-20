# Zeta Market Maker

Provides liquidity to Zeta DEX, by issuing bid & ask quotes per asset and instrument. Monitors mark price from external exchange via web sockets, monitors quote orders via both web sockets and periodic refreshes.

```mermaid
sequenceDiagram
    participant Bybit
    participant MM as Market Maker
    participant DEX as DEX program
    actor       User

    Bybit-->>MM: orderbook updates
    MM-->>MM:    set new mark price
    MM-->>MM:    calculate bids/asks
    MM->>DEX:    issue bids/asks
    User->>DEX:  buy SOL-PERP
    DEX-->>DEX:  fill ask
    DEX-->>MM:   update Market Maker orders
    MM-->>MM:    re-calculate bids/asks
    MM->>DEX:    re-issue bids/asks
```

Comprises modules:

- [app.ts](src/app.ts) - entrypoint with stale price check
- [maker.ts](src/maker.ts) - listens to external exchange (Bybit) orderbooks for mark price, monitors Zeta order updates, maintains current state
- [state.ts](src/state.ts) - keeps mark prices (theos) and issued quotes
- [types.ts](src/types.ts) - defines common types
- [configuration.ts](src/configuration.ts) - parametrizes quoting strategy as per [config.json](config.json)
- [utils.ts](src/utils.ts) & [math.ts](src/math.ts) - mathematical and utility functions

## Setup

Ensure `makerWallet.json` file exists in project root dir, in format:

```json
[
  111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111,
  111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111,
  111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111,
  111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111, 111,
  111, 111, 111, 111
]
```

Install dependencies:

```sh
npm i
```

## Run

```sh
ts-node src/app.ts
```
