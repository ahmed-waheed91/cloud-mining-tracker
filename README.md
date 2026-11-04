# Cloud Mining Tracker

A small web app for keeping track of BTC cloud-mining contracts: what goes in, what comes back, reinvestments, payouts, and the real return on your money.

**Open the app:** https://ahmed-waheed91.github.io/cloud-mining-tracker/

## Getting started

1. Open the link above in **Chrome** (or Edge).
2. Optional: click the **Install** icon in the address bar to get a desktop icon and its own window.
3. Follow the welcome guide:
   - **Choose a data folder.** The app saves `cloud-mining.json` there, plus a daily backup.
   - **Start a cycle** with the date of your first contract and the BTC you sent in.
   - **Import your reports.** Download the *daily earnings*, *hashrate purchases* and *payout* CSV reports from the platform and drop them onto the page.

Re-import whenever you like. Rows are refreshed, never doubled, and reinvestments come in automatically with the purchases report.

## Your data stays on your computer

- Everything is stored in the folder you choose. Nothing is uploaded.
- The only thing the app fetches from the internet is the current BTC price.
- Updates to the app never touch your data file.

## What it shows

- Money in, withdrawn, still on the platform, and the net result, in BTC and in USD/AED (valued on the day the money moved)
- Return per day, per 30 days and per year in BTC, for the last 7 days, last 30 days and the whole cycle
- Profit split into bonus and mining, and loss days
- Monthly summary, daily history, and each contract's price, USD cost and margin
- Your platform's auto-reinvest and auto-payout settings per cycle: reinvest from capital, profit or both in whole blocks (min 100 TH/s), and pay out at a set amount (min 0.001 BTC)
- Projections that simulate the platform's loop day by day for each reinvest option, plus a block-size comparison showing how often blocks get bought, how much waits, and what bigger blocks cost you in profit
- Deposits paid in USDT, taken straight from your purchase orders
- Warnings for missing reports, stale data, loss streaks and bonus changes
- Amounts in BTC or sats, with USD or AED alongside

*This is a personal record-keeping tool, not financial advice.*
