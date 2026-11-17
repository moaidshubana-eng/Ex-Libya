---
version: 1
slug: "public-styles-css"
primary_target: "public/styles.css"
related_targets: ["public/index.html","public/calc.html","public/portal.html"]
---

# Staff app, public calculator, customer portal

Scope: the whole product UI (`public/styles.css`, `public/index.html`, `public/calc.html`, `public/portal.html`, views in `public/js/`). Mode: Operate. The calculator and portal landings inherit the same world.

Audience and job: the owner and staff of Golden Gate Motors entering and checking money and vehicle status, half on an office desktop, half on a phone. Constraints: Arabic RTL, logo colours binding (black, gold, red), printing and PDF outputs unchanged, vanilla JS and one stylesheet.

## Direction contract

THESIS: Money is the product, so every amount is set the way a banknote sets its denomination: engraved, exact, trusted at a glance. Refuses the grey admin dashboard of identical icon tiles.

OWN-WORLD: Banknote and security-document engraving. Ivory paper ground (#F7F3EA) with warm white sheets, ink black (#0E0D0B) rail and rules, gold (#B8892B) only for what can be pressed, red (#A3201C) for serial numbers and danger. Kufic headings (Reem Kufi), Noto Sans Arabic body, didone numerals (Bodoni Moda) for denominations, tabular figures everywhere. Crisp 6px corners, borders instead of shadows, double-ruled note frame.

STORY: The owner opens the system, reads the four amounts that need attention, sees where the cars are on their route, and reaches any job in one or two steps.

FIRST VIEWPORT: Black rail on the right with the logo and grouped navigation. Top of the dashboard: greeting, date, and the main actions with one gold primary. Below it the denomination panel, a double-bordered note with fine guilloche line work holding four large figures, each with a red serial-style reference. Under it the vehicle route drawn as one black line with ordered stations and counts. Then recent tables.

Signature move: the denomination panel (guilloche note with engraved numerals); it appears once per page at most. Raises: statuses as stations on one line (transit diagram); gold reserved for actions and a fixed bottom bar on phones (consumer app); fixed columns of tabular figures (gate board).

FORM: banknote engraving, position 7 of 7 on the grounded list; seed:f033780f5e4fab46.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
