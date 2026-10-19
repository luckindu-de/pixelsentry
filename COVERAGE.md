# PixelSentry — coverage map

What PixelSentry checks per **language × viewport**, and how. This is the QA
target list; it's honest about what's caught for free vs. what needs the AI
judgment layer or is still on the roadmap.

**Legend**
- ✅ **Free check** — deterministic, runs on the live page, no AI (high precision)
- 🔶 **AI / partial** — needs the vision layer's judgment, or only partly covered
- ⬜ **Roadmap** — not yet implemented
- 🚫 **Framing artifact** — deliberately IGNORED (it's the capture tool, not the app)

---

## Layout
| Item | Status | How |
| --- | --- | --- |
| Horizontal scroll / page too wide | ✅ | `overflow` |
| Clipping — element cut by its container | ✅ | `clipped` (interactive); text/content → roadmap `clippedText` |
| Element off the screen edge | ✅ | `offViewport` |
| Overlapping elements | 🔶 | `overlap` (hint) + `clickability` (covered controls) |
| Broken grid / flex | 🔶 | AI (hard to prove deterministically) |
| Fixed widths/heights causing overflow | ✅ | symptom caught by `overflow` |
| Sticky headers/footers covering content **at rest** | 🔶 | AI; mid-scroll overlap is 🚫 (normal) |
| Safe areas / notches / device-frame corners | 🚫 | ignored — capture chrome, not the app |

## Text
| Item | Status | How |
| --- | --- | --- |
| Truncation / ellipsis — is critical text hidden? | 🔶 | `textOverflow` finds it; "is it critical" → AI |
| Cut-off text inside a container | ✅ | roadmap `clippedText` (promote `textOverflow` clipped logic) |
| Long words / URLs / emails overflowing | ✅ | `overflow` + `textOverflow` spilling |
| Wrapping / hyphenation / line breaks | 🔶 | AI |
| Font fallback, missing glyphs (tofu) | ⬜ | AI/vision |
| Line height, font size, bold/italic | ⬜ | — |
| Placeholders and labels | ⬜ | — |

## RTL (Arabic, Hebrew, …)
| Item | Status | How |
| --- | --- | --- |
| Full mirroring of layout / nav / icons | ⬜ | AI/manual |
| Bidi text (Arabic + Latin brand names, numbers, URLs) | ⬜ | AI |
| Scrollbars, progress bars, carousels | ⬜ | — |
| Form fields, validation, date pickers | ⬜ | — |

## CJK / Indic / Thai
| Item | Status | How |
| --- | --- | --- |
| Font loading & rendering | 🔶 | failed-font requests via `NETWORK_ERROR` |
| Line-breaking rules, punctuation, spacing | ⬜ | AI |
| Combining marks / shaping | ⬜ | AI/vision |
| Vertical text (if supported) | ⬜ | — |

## Content formats
| Item | Status | How |
| --- | --- | --- |
| Dates, times, numbers, currency, decimals | ⬜ | out of visual scope (data validation) |
| Addresses, names, phone numbers | ⬜ | — |
| Sorting / filtering / search | ⬜ | functional (out of scope) |
| Pagination, tables, columns | 🔶 | column alignment via `alignment`; rest → AI |

## Components
| Item | Status | How |
| --- | --- | --- |
| Buttons / links / tooltips | ✅ | `clickability` (real actionability) |
| Nav / tabs / accordions / dropdowns | 🔶 | `clickability` + `clipped` (only if the menu is OPEN at capture) |
| Forms / inputs / validation messages | ⬜ | AI |
| Modals / popups / notifications | 🔶 | `clipped` (dialogs) + AI |
| Checkbox / radio / row-control alignment | ✅ | `alignment` |
| Tables / charts / maps / PDFs | ⬜ | — |
| Images (broken) | ✅ | `brokenImages` |
| Images with embedded text / banners | 🔶 | AI/vision |
| Colour contrast (solid backgrounds) | ✅ | `contrast` (WCAG math) |

---

**Design principle:** deterministic checks carry the mechanical/geometric bugs
(high precision, no cost, no rate limits); the AI vision layer is used **only**
for cases geometry can't judge, and anything uncertain is reported as
**NEEDS_REVIEW** rather than a confident FAIL — so we never assert a bug we
can't substantiate.
