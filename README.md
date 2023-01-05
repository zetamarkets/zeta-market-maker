# Maker

Maker bot with ability to provide liquidity to Zeta DEX, fetching the mark prices from [ccxt](https://github.com/ccxt/ccxt) supported exchange (eg. bybit).

## Setup

Ensure `makerWallet.json` file exists in path, needs to be in format:

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
