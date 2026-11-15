# Card Picker for Collectr

A small Chrome extension for buying cards from someone's [Collectr](https://getcollectr.com) showcase. Click the cards you want, then copy a clean, ready-to-send list for the seller. No more screenshots or typing card names into Messenger.

> Unofficial. Not affiliated with or endorsed by Collectr. Pokémon and card names are trademarks of their respective owners.

## Features
- **Click to pick.** On any `app.getcollectr.com/showcase/...` page, click a card to add it to your want list and click again to remove it. Picked cards get a green outline and ✓.
- **Works in grid and list view**, including cards that load as you scroll.
- **Quantities.** If the seller has more than one copy, choose how many you want.
- **One-click message.** Copies a numbered list with set, card number, condition, finish and (optionally) Collectr market price plus a total.
- **Saved per seller/collection.** Close the tab and come back later.
- **Select mode toggle.** Turn it off to click cards normally.
- **★ Cards you need.** Import your "still needed" list from a spreadsheet and matching cards get a gold **★ NEED** badge in the grid. The panel lists them (click one to jump to it) with **+ Add all to want list**, and the toolbar icon shows the count.

### Importing your needs list
Click **Import list** in the panel, then either:
- **Paste from Google Sheets or Excel:** select your rows *including the header row* and copy them. You need a card name column (`Card`, `Card Name` or `Name`) and a `Number` column. `Set` and `Owned` columns are used if present, and rows marked `Yes`/`Coming`/`Owned` are skipped.
- **Choose a CSV file:** a single sheet, or a whole-workbook export. If the workbook has a tab named like *Still Needed*, *Wants* or *Missing*, only that tab is used.

Cards match on **card number + name**, so `Mega Gengar ex 269/217` won't be flagged when you need `284/217`. Variants like *(Master Ball Pattern)* only match if their number matches too. Click **Scan whole showcase** to scroll through and load every card so nothing is missed.

Example of what gets copied:

```
Hi! I'm interested in these cards from your Collectr showcase (@seller):

1. Mewtwo ex — 30th Celebration 151/128 — Near Mint, Holofoil — $30.91
2. Gwynn — Pitch Black 119/084 — Near Mint, Holofoil (x2) — $24.48 ea

3 cards — Collectr market total $79.87
```

## Install (unpacked)
1. Download this repo (**Code → Download ZIP**) and unzip it somewhere permanent.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Optional: pin the extension. Its toolbar icon shows and hides the panel.

Works in Chrome and other Chromium browsers (Edge, Brave, Arc).

## Privacy & permissions
- **Runs only on `https://app.getcollectr.com/*`.** It has no access to any other site.
- **The only permission is `storage`**, used to save your want lists and imported needs list locally in your browser. Your spreadsheet is never uploaded anywhere: the extension only reads what you paste or the file you pick.
- **No network requests, analytics, or remote code.** Nothing leaves your machine except what you paste yourself.

See [PRIVACY.md](PRIVACY.md) for the privacy policy and [SECURITY.md](SECURITY.md) for the security review notes.

## How it works
`content.js` finds Collectr's `.product-card` elements, reads the visible card details, and intercepts clicks while Select mode is on. The panel lives in a closed Shadow DOM so it doesn't clash with the site's styles. If Collectr changes its markup, the parser in `parseCard()` is the place to update.

## License
MIT
