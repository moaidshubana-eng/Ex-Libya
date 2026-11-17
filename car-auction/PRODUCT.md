# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Owner / manager of Golden Gate Motors (primary).** Runs the company day to day and enters most data himself. Works half on an office computer (data entry) and half on a phone (checking and following up). Arabic speaker (Libyan), not technical.
- **Staff with their own roles** (accountant, operations, sales, viewer): supported by the system, each sees only their side. Not yet the main daily users.
- **Customers** (public): use the public calculator to price a car from US auction to Libya, and the customer portal to track their cars and statement.

## Product Purpose

One system for a Libyan company that buys cars from US auctions (Copart, IAAI) and imports them to Libya. It follows each car from purchase to delivery (inland transport, shipping, customs, sale) and keeps the company's money straight: customer and vendor accounts, company expenses with attached invoices, cash custodies, and profit for any period. Success: the owner trusts the numbers, finds anything in seconds, and the company looks professional to its customers.

## Positioning

Built around this company's actual trade route and paperwork: US auction yards and ports, the Atlas land-transport annex prices plus the company margin, Libyan dinar with manually set exchange rates, custody statements and receipts the way the company already keeps them on paper.

## Operating Context

- All four daily jobs matter equally (confirmed): expenses, custodies and invoices; tracking cars and shipments; customer and vendor accounts; the calculator and customer prices.
- Entry mostly on a desktop in the office; lookups on a phone.
- Documents the company really uses: custody statement (كشف عهدة), expense invoices (photos/PDF), payment receipts, profit report as PDF for the manager.
- Hosting: Render free tier with a Neon database; first load after idle can take up to a minute.

## Capabilities and Constraints

- Arabic interface, right to left; amounts in LYD and USD with Latin digits.
- Staff app (`/`), public calculator (`/calc`), customer portal (`/portal`). The redesign covers all three (confirmed).
- Vanilla JS and one stylesheet, no build step. Strict CSP: scripts and images from the same origin only; fonts from Google Fonts are allowed.
- Printable and PDF outputs (custody statement, profit report, receipts) must keep working.
- Live auctions and automatic sync exist in code but integrations are off in production.

## Brand Commitments

- Name: Golden Gate Motors (GGM).
- The existing logo stays as is: red Golden Gate bridge with gold lettering on black (`public/brand/`).
- **The interface colours must follow the logo: black, gold and red (confirmed binding by the owner).**
- The owner's complaint about the current look: it is ordinary and does not feel premium. The new look should feel like a distinguished, high-end company.

## Evidence on Hand

- Real production data: vehicles, customers, expenses with invoices, custodies.
- Real price data: 366 auction yards from the Atlas annex (October 2026).
- No testimonials, awards, or marketing claims exist; none may be invented.

## Product Principles

1. The numbers are the product: money and status must be exact, legible and impossible to misread.
2. Every frequent job is reachable in one or two steps, on a computer and on a phone.
3. Look like the company: premium and confident, in the logo's own colours.
4. Plain Libyan Arabic everywhere; no jargon.
5. Nothing that works today may break: printing, PDFs, permissions.
