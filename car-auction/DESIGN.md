# Design

The visual world is banknote and security-document engraving, in the logo's colours. Source of truth for tokens: `public/styles.css` (`:root`).

## Colour

| Role | Token | Light | Use |
|---|---|---|---|
| Paper ground | `--bg` | `#f7f3ea` | page background |
| Sheet | `--surface` | `#fffdf8` | cards, tables, inputs |
| Sheet, tinted | `--surface-2` | `#f3eddf` | hover, quiet fills |
| Rule | `--border` | `#e0d6bf` | card and field borders |
| Ink | `--text` / `--brand` / `--ink` | `#1b1915` / `#14120e` | text, table head rule, selected state |
| Gold | `--accent` | `#b8892b` | **only** what can be pressed (primary buttons), focus ring, note frame |
| Gold, dark | `--brand-2` | `#7a5a14` | links |
| Red | `--serial` / `--danger` | `#a3201c` | document numbers, danger, negative attention |
| Rail | `--sidebar` | `#0e0d0b` | navigation rail, public headers, tab bar |

Dark theme redefines the same tokens (`[data-theme="dark"]`). Gold fills always carry dark ink text (`#1b1200`), never white.

## Type

- Headings: Noto Kufi Arabic (`--font-head`).
- Body and UI: Noto Sans Arabic (`--font`), 14.5px, tabular figures everywhere.
- Denominations: Bodoni Moda (`--font-num`), lining tabular numerals, used only in `.den-v` and `.calc-big`.

## Shape and depth

- Radius 6px (cards, dialogs), 4px (controls), 3px (badges). No pills except counters.
- Elevation is a 1px border. Shadows only on floating layers (`--shadow-lg`: dialogs, toasts, compare bar).
- Table heads: no fill, 2px ink rule underneath.

## Signature

- **Denomination panel** (`.note` > `.note-in` > `.den`): double gold frame with guilloche line work (`--guilloche`) holding up to four large engraved figures. At most once per page.
- **Route line** (`.track`): statuses as ordered stations on one ink line; filled stations have cars.
- Guilloche also textures the black surfaces that carry the logo: login panel, public headers, calculator total, waking screen. Nowhere else.

## Layout

- Desktop: black rail (248px) with a gold edge, sticky top bar, content up to 1480px.
- Phone (≤860px): rail becomes a drawer; a fixed bottom tab bar holds the four most used sections for the role plus «المزيد».

## Rules

- Gold means "press here". Do not use it for decoration or for status.
- Status colours on vehicles come from `src/domain/status.js` and stay as small dots beside ink labels.
- Printing and PDF output keep their own print styles; do not restyle them from screen tokens.
