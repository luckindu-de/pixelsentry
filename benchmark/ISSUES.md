# Known issues (QA answer key)

Plain-English list of real defects Tharindu reported, grouped by the actual
problem. The numbers in [brackets] are the original note numbers.

Most of these show up in the **1200–1399 px width range**, more often on
**subscription-EXPIRED** accounts, and some are language-specific (Bengali,
Greek showed issues even on active subscriptions). — [1, from team chat]

## A. Long QR-code name handling (mobile) — [2, 3]
- Show as many characters of the name as will fit, up to the edit (pencil) button.
- If it still doesn't fit, wrap the name to **two lines**.
- Only if it still doesn't fit, use "…".

## B. Name breaks in the middle of a word — [5, 6]
- A long user-typed name splits mid-word at some widths
  (e.g. "…dictum congue" shows as "ctum"; "condimentum" shows as "condi / mentum").
- Should break at spaces, not inside a word.

## C. Checkboxes not lined up — [4]
- The "Select All" checkbox and the row checkbox below it are not inline
  (left edges don't match).

## D. Dropdown / action menu cropped — [7, 8]
- The "…" action menu (copy / send to / pause / delete) is cut off.

## E. Text jumps over / out of its box — [9, 19]
- Text overflows its container [9]; content jumps outside the window [19].

## F. Save button cropped — [10, 14]
- The green save button is cut off.

## G. Column not vertically aligned — [11]
- Same issue as qr-list-390: a column's content is top-aligned while the other
  columns in the row are centered.

## H. Scan count + action buttons cropped at width 1200–1399 — [12, 15, 16, 17, 18]
- The "Scans" number and the Download / Detail buttons get cut off, greyed, or
  clipped in this width range. (This is the biggest cluster — same root bug.)

## I. Column widths inconsistent between rows — [13]
- Empty gaps / different widths from one row to the next.

## J. Emoji names break button alignment — [20]
- When a name contains emoji, the row's buttons shift out of alignment.

---
### How to turn these into scored tests
For each problem above I need the **clean screenshot saved as a file** (no red
boxes/arrows drawn on it) in `benchmark/cases/`. Then I write the answer key in
`cases.json` and the benchmark measures whether the AI catches it.
You do NOT need 20 files — one clean shot per problem (A–J) covers all 20 notes.
