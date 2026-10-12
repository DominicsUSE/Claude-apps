# Tradebot

One trading bot for **FOMO** (your Solana wallet), **Liquid** (crypto and stock perps on Hyperliquid) and
**TradingView** (your chart alerts), with a dashboard, a backtest lab and hard risk limits.

It starts in **paper mode**: practice money and live prices, so nothing can go wrong while you learn
it. Real trading needs two separate switches in Settings, plus your keys.

> **Read this first.** No bot makes money by itself. Memecoins can go to zero in minutes, leverage
> can wipe out an account, and any strategy that worked in the past can stop working. Only trade with
> money you can afford to lose. This software is a tool, not financial advice.

## Start it

**Windows:** install Python from [python.org](https://www.python.org/downloads/) (tick *Add python.exe
to PATH*), then double-click **`Start Tradebot (Windows).bat`**.

**Mac:** install Python from [python.org](https://www.python.org/downloads/), then double-click
**`Start Tradebot (Mac).command`**. If macOS refuses, right-click it, choose *Open*, then *Open* again.

The first start takes a minute to install what it needs. The dashboard then opens at
<http://localhost:8787>. Keep the window open: closing it stops the bot. Stops on Liquid stay
on the exchange even then.

## Memecoin trading: the main strategy

The **meme scalper** trades short-term memecoin moves and decides by reading the chart, not by
headlines or hype. It trades in two places:

| | FOMO wallet (Solana tokens) | Liquid (memecoin perps) |
|---|---|---|
| Markets | the 12 most-traded trending tokens with real liquidity (over $50k) and volume (over $250k a day) | kPEPE, WIF, FARTCOIN, kBONK, POPCAT, PENGU, TRUMP, MOODENG and more (Settings → `liquid_markets`) |
| Direction | buy only | **long and short** (shorts read the same rules on the chart turned upside down) |
| Cost per buy or sell | about 1% (swap fee + price impact) | about 0.1% |
| Charts | GeckoTerminal 5-minute candles | Liquid's own 5-minute candles |
| Extra protection | rug checks, sells at once if liquidity is pulled, buys at most 0.5% of the pool, needs more buyers than sellers | stop-loss also placed on the exchange |

Costs matter for short-term trading: on a DEX swap a trade has to gain over 2% just to break even,
on Liquid about 0.2%. The first real-data training run (12 October 2026) found the Solana setups
**losing** on unseen charts, though on only 15 trades from the 11 charts GeckoTerminal let it
download. That is too few to be sure either way, but it is why live money is gated (below).

**What it watches.** Each minute it reads each market's 5-minute chart once per candle.

**When it buys** (any one of these, on a closed candle):

- **Breakout.** A tight range (consolidation), then a candle closes above it on at least 2x normal volume, above VWAP. Stop under the range.
- **Pullback.** An uptrend (higher highs and higher lows) dips into the 21 EMA, VWAP or the 0.382-0.618 Fibonacci zone, then prints a hammer or bullish engulfing candle. Stop under the dip.
- **VWAP reclaim.** After trading under VWAP, price closes back above it on 1.5x volume. Stop under that candle.

**When it never buys:** more than 30% above VWAP (chasing), RSI over 80, a long upper wick (sellers
rejected the move), bearish RSI divergence, a downtrend, a stop wider than 15%, or a token failing
the rug checks (mint or freeze authority on, top holders over 35%, RugCheck danger flags).

**When it sells:**

- Half at +1R (R = the distance from entry to stop) and another quarter at +2R. The stop then moves to break-even.
- After +1R the stop trails under each new higher low (or the 9 EMA).
- Everything goes when the last higher low breaks, a candle closes under the 21 EMA after a good
  move, a shooting star or bearish engulfing candle shows up on volume at the highs, RSI diverges,
  volume dries up, or 4 hours pass without the move.

Every trade has a written reason, e.g. *"Breakout: closed above a 12-candle range (4% tall) on 8x
volume, above VWAP. Chart: 9 EMA above 21 EMA, RSI 73, bullish engulfing…"*. The **Charts** tab
shows each token's candles with VWAP, the EMAs, swing points and the bot's buys and sells.

**How it learns.**

- **Training on fresh charts.** Once a day (or when you press *Train now* or run `python run.py train`), it downloads the 5-minute charts of up to 60 tokens. These are all tokens it has watched, not only the ones that pumped. It tries a grid of settings on the first 60% of every chart, then grades the best on the last 40%, which the optimiser never saw (walk-forward, as in your video). Setups that lose money on those unseen charts are switched off.
- **Learning from its own trades.** After 10 closed paper or live trades, a setup that is losing money is paused.
- **Real money only follows proof.** In live mode, each venue makes new trades only while its latest training says *works on unseen charts* or *slight edge*. In paper mode it always trades, so it keeps collecting evidence. (Settings → `trade_unproven_live` overrides this; not recommended.)

Liquid trains on about 17 days of 5-minute history for every memecoin perp, long and short:
`python run.py train --profile liquid`.

The **Training** tab shows all of it. Change the chart settings in Settings → Meme scalper → `chart`,
for example `{"interval": "1m"}` for faster scalping.

Chart rules come from *Every Trading Strategy Explained*: market structure, dynamic
support/resistance, breakouts, candlestick patterns, divergence and volume. The testing rules come
from the look-ahead-bias, walk-forward and risk-of-ruin videos.

## The dashboard

| Tab | What it's for |
|---|---|
| **Overview** | Account value chart, open positions (with a Close button), the activity log, strategies on/off, and a manual trade form. |
| **Charts** | The memecoins the bot is watching, each with its candle chart, VWAP/EMAs, swing points, the bot's trades and its written read. |
| **Training** | What the bot learned from recent memecoin charts (graded on charts it never saw), and how each setup is doing in your own trades. |
| **Backtest lab** | Test any strategy on real history: single backtest, **walk-forward test**, or **compare all** next to buy-and-hold. Includes a Monte Carlo reshuffle of the trades. |
| **Risk** | Risk-of-ruin calculator (simple and Ralph Vince formulas), your real results per strategy, and a checklist for going live. |
| **Settings** | Every limit and strategy setting, saved to `config.json`. |
| **Connections** | Paste your keys (they go into `.env` on your computer and are never shown again), with step-by-step help for FOMO, Liquid and TradingView. |
| **Trade journal** | Every fill, with the reason. Also saved to `data/trades.csv`. |

**Pause** stops new trades; open positions keep their stops and targets. **Close all** closes every position the bot opened.

## Connecting your accounts

### FOMO

FOMO has no official bot API. It does let you **export your wallet's private key**, though. With
it, the bot trades that same Solana wallet through Jupiter (the swap router most Solana apps use),
so the bot's trades show up in your FOMO app like your own.

1. In FOMO: Settings → Account → Export (needs Face ID). Copy the **Solana** key.
2. Dashboard → Connections → paste it into `FOMO_WALLET_PRIVATE_KEY` → Save keys.
3. Keep USDC in the wallet (what the bot buys with) and about 0.05 SOL for network fees.
4. Get a free Jupiter API key at [portal.jup.ag](https://portal.jup.ag) and save it as `JUPITER_API_KEY`:
   swaps go through Jupiter, which needs it. A free private Solana RPC (e.g. Helius) in `SOLANA_RPC_URL`
   is optional but more reliable than the public one.

> Anyone with that key can take everything in the wallet. Never paste it into a chat, a website or
> a message. A separate FOMO account just for the bot keeps your main money apart.

The bot never touches tokens it did not buy itself.

### Liquid

Liquid runs on Hyperliquid. Hyperliquid has no API keys. Instead you create an **API wallet**,
which can place trades but can **never withdraw**.

1. Go to [app.hyperliquid.xyz](https://app.hyperliquid.xyz) → More → API, connect the wallet your Liquid account uses, and create an API wallet.
2. Paste its private key into `HL_API_PRIVATE_KEY`, and your account address (`0x…`, shown in Liquid) into `HL_ACCOUNT_ADDRESS`.
3. Run `python run.py check` (or restart the bot) to confirm the account is found.

If your Liquid login can't connect to the Hyperliquid site, use a Hyperliquid account directly for
the bot. Stocks such as NVDA trade as `xyz:NVDA`.

### TradingView

TradingView can't place trades itself, but its alerts can tell the bot to trade.

1. Set any long password as `TV_WEBHOOK_SECRET` in Connections.
2. TradingView must reach your computer from the internet. A free tunnel does it:
   `cloudflared tunnel --url http://localhost:8788`
   ([download cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
   Your webhook URL is the `https://…trycloudflare.com` address it prints, plus `/webhook`.
   Only tunnel port **8788** (the alert port), never 8787 (the dashboard).
3. In TradingView, create an alert, tick *Webhook URL*, and use this message:
   ```json
   {"secret": "your password", "symbol": "{{ticker}}", "action": "buy", "size_usd": 25, "stop_pct": 4}
   ```
   `action` can be `buy`, `sell` (short) or `close`. Optional fields: `stop_price`,
   `take_profit_pct`, `take_profit_price`, `leverage`, and `venue` (`liquid` or `fomo`). A Solana token
   address as the symbol trades it in your FOMO wallet.
4. Ready-made Pine strategies are in [`tradingview/`](tradingview):
   - `tradebot_strategy.pine` is the bot's EMA trend strategy.
   - `btc_volatility_regime.pine` is the Bitcoin video strategy.

   Add one to a chart, set its webhook secret, and create the alert with the message `{{strategy.order.alert_message}}`.

**Practising on TradingView:** the Strategy Tester (free) backtests the Pine scripts on any chart.
TradingView's paper trading is separate from the bot. To practise with the bot itself, keep it in
paper mode: alerts then trade the practice account. Webhook alerts need a paid TradingView plan.

## Strategies

| Strategy | Where | Idea | Source |
|---|---|---|---|
| **Meme scalper** (main) | FOMO | Reads 5-minute memecoin charts and trades breakouts, pullbacks and VWAP reclaims, then sells in steps as the chart turns (see above). | chart-reading video, walk-forward training |
| **FOMO momentum** (off) | FOMO | Buys trending Solana memecoins with real liquidity, volume and more buyers than sellers. Skips anything under 2 hours old or already up 60%+ in an hour, and anything failing rug checks: mint/freeze authority still on, top holders over 35%, RugCheck danger flags. Small fixed size, -15% stop, sells 50% at +30% and 25% at +80%, then moves the stop to break-even. 18% trailing stop, 12-hour time limit. | DexScreener, Jupiter, RugCheck |
| **EMA trend** | Liquid | 20/50 EMA crossover, only in the direction of the 200 EMA, RSI 50-75 (25-50 for shorts), ATR stop with a 2.5x target. Same as the Pine script. | classic trend following |
| **BTC volatility regime** | Liquid | Bands around fast/slow EMAs of the typical price. Long in a bull regime, cash in a bear regime. | *The Bitcoin Strategy That Beats Buy & Hold* |
| **BTC/ETH pair** | Liquid | When BTC/ETH drops below its 30-day mean minus 1 std, go long BTC + short ETH. Close above mean plus 2 std. | *ETH Pair Trading Strategy* |
| **Congress buys** | Liquid | Buys stocks that several members of Congress recently reported buying, as stock perps. | your QuiverQuant data source (needs a [Quiver](https://www.quiverquant.com) key) |
| **TradingView alerts** | both | Whatever your alerts say. | your charts |

The backtest lab also has Donchian breakout, Supertrend, MACD, Heikin Ashi and an RSI pullback strategy
(from *Every Trading Strategy Explained*) so you can compare them. Only the **meme scalper** and
**TradingView alerts** are on by default; turn others on after they pass your own tests.

### What the first real-data tests showed (12 October 2026)

These come from the automatic test run (default settings, fees included, full position, no leverage).
They are not a promise. They are why only two strategies are on by default.

| Test | Result | Buy and hold | Verdict |
|---|---|---|---|
| BTC volatility regime, 10 years daily (Coinbase) | +9,162%, max drawdown 71% | +13,061% | Lags simply holding; walk-forward **WEAK** (unseen data +137% vs +616% holding) |
| BTC volatility regime, last 900 days | +53.8%, max drawdown 24% | +30.3% | Best of the 7 strategies over this stretch |
| BTC/ETH pair, 4 years daily | +33.8% (81% of trades won, but losers were big) | ratio +161% | BTC kept outperforming ETH, so buying "cheap" BTC vs ETH was early; risky |
| EMA trend on ETH, 4h, last year | walk-forward −26.7% on unseen data | −31.8% | **Fails out-of-sample**, so it is off by default |
| FOMO momentum | cannot be backtested (no history of the screens) | | Paper trade it for weeks first |

In short: the trend strategies mostly cut drawdowns rather than beat holding, the pair trade is a
bet that BTC/ETH reverts, and memecoin momentum is unproven until your paper results say otherwise.

**News check (optional):** with a Perplexity or xAI (Grok) key, the bot asks for the last 48 hours of
news and social sentiment before each trade, and skips buys into clearly bad news. Turn it on in
Settings → News check.

## How the testing works (and why)

Your videos made three points the backtester enforces:

- **No look-ahead bias** (Dr. Ernest Chan). Signals are computed from finished candles only, and the
  trade happens at the next candle's open. The tests check every strategy for this: adding future
  data never changes a past signal. The congress strategy dates filings by when they were *reported*,
  never by when the trade happened.
- **Walk-forward testing.** Settings are optimised on one stretch of history, then traded on the next
  stretch the optimiser never saw. This repeats across the whole history. Only the stitched unseen
  result counts. The verdict is ROBUST, MODERATE, WEAK or FAILS OUT-OF-SAMPLE. Fees and slippage are
  always included.
- **Risk of ruin.** Both formulas from the video, plus a Monte Carlo reshuffle of the trades.

Then paper trade for 1 to 3 months and compare with the backtest before risking real money.

## Risk limits (Settings → Risk limits)

Every trade, from a strategy, an alert or you, goes through these:

- **Position size from the stop.** 1% of the account is at risk per trade by default; a 10% stop means a position of 10% of the account.
- **Hard caps.** $100 per position, 5 open positions, 3 per strategy, 150% total exposure and 3x leverage.
- **Daily loss limit.** At -5% in a day, no new trades until midnight UTC.
- **Max drawdown.** At -20% from the peak, no new trades until you press Resume.
- **Cooldown.** After a losing exit, no re-entry into that market for 60 minutes.
- **Repeated failures.** After 5 failed orders in a row, the bot pauses.
- **Stops everywhere.** Every position has a stop. On Liquid it is also placed on the exchange, so it works even when your computer is off.

## Going live

1. Test the strategies (walk-forward), then paper trade for weeks and check the Risk tab.
2. Connect your accounts and run `python run.py check`.
3. Settings → General: set `mode` to `live` **and** tick `live_trading_acknowledged`. Save, then restart.
4. Start small: lower `max_position_usd` and `risk_per_trade_pct`.

The dashboard shows a red **LIVE** badge whenever real money is in play.

## Command line

```
python run.py                    start the bot and dashboard
python run.py --paper            force paper mode
python run.py check              test every connection
python run.py train              study recent Solana memecoin charts and pick the meme scalper's settings
python run.py train --profile liquid   the same for memecoin perps on Liquid (long and short)
python run.py backtest --strategy btc_regime --symbol BTC --source coinbase --days 3650
python run.py walkforward --strategy trend --symbol ETH --interval 4h --days 730
python run.py backtest --strategy eth_btc_pair --symbol BTC/ETH --source coinbase --days 1500
python run.py compare --symbol BTC --interval 1d
```

Liquid history only goes back to 2023. `--source coinbase` gives Bitcoin, Ethereum and Solana back to 2015.

## With Claude

- `.mcp.json` adds the TradingView MCP server you sent (screeners, technical analysis, backtests), so
  Claude Code opened in this folder can research markets for you. It needs [uv](https://docs.astral.sh/uv/).
- Your Liquid connector in Claude can analyse markets and place trades you approve one by one. The
  bot is for the automatic part.

## Files

```
bot/engine.py           main loop: values the account, enforces limits, manages exits, runs strategies
bot/risk.py             position sizing and every risk limit
bot/brokers/            paper.py (practice), fomo_wallet.py (Solana/Jupiter), hyperliquid_live.py (Liquid)
bot/chart.py            memecoin chart reading: structure, VWAP/EMAs, patterns, setups, exits, chart backtest
bot/training.py         daily training on recent memecoin charts + learning from the journal
bot/strategies/         meme (meme scalper), fomo_momentum, signals (candle strategies), pair, congress
bot/backtest.py         backtester, walk-forward, Monte Carlo, risk of ruin
bot/data/               Hyperliquid, DexScreener/Jupiter/RugCheck, GeckoTerminal memecoin candles, Quiver, Coinbase
bot/tradingview.py      alert parsing
bot/server.py           dashboard and webhook servers
bot/static/dashboard.html
tradingview/            Pine scripts
tests/                  unit tests (python -m pytest tests) and a live paper-trading smoke test
config.example.json     every setting with its default
.env.example            every key the bot can use
data/                   created on first run: state, trade journal, equity history, log
```
