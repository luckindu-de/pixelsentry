# PixelSentry

> Responsive UI QA that stands guard over your site — across every viewport, browser, and language.

An AI-powered responsive QA automation platform. It scans a website across
multiple pages, viewports, browsers, and languages using Playwright, gathers
objective browser facts, uses AI vision as the verdict layer, and produces
JSON + HTML QA reports. Designed to be driven manually, from the CLI, or from
an n8n workflow.

## Hybrid QA model (why this avoids false positives)

DOM geometry alone (`getBoundingClientRect`, `display:none`, "element covered
by") is unreliable on modern responsive sites: transforms, stacking contexts,
sticky headers, intentional responsive hiding, and a11y helpers all make the
DOM disagree with what the user actually sees. Relying on it produces false
positives (e.g. "90 hidden elements" on a page that looks perfect).

So signals are split into two tiers:

- **Authoritative (trusted, sets the verdict):** deterministic facts that need
  no interpretation — horizontal overflow, broken images, WCAG **contrast**
  math, real **clickability** (`click({ trial: true })`), and console / JS /
  network errors.
- **Hints (never fail on their own):** DOM-geometry heuristics
  (hiddenElements, overlap, textOverflow). These are passed to AI vision to be
  confirmed or dismissed against the screenshot, and are shown in the report
  but not counted toward status.

The **AI vision reviewer** receives the screenshot (source of truth) plus
browser facts (accessibility tree, DOM summary, console, network, contrast,
and the DOM hints) and returns `{ overallStatus, confidence, issues[] }`. The
findings engine then **merges evidence**: when deterministic facts and AI
agree, confidence is high; when they disagree, confidence is lowered and the
result is flagged `needsHumanReview`.

## Architecture

```
config/project.json ──► configLoader ──► combinationGenerator
                                              │ (page x browser x language x viewport)
                                              ▼
                 playwright/capture (browser facts + segmented screenshots)
                    │ tiered validators + a11y tree + DOM summary
                                              ▼
                 services/findingsEngine.classify  (facts vs hints)
                                              ▼
                 ai/analyzer  (verdict layer: screenshot = source of truth)
                                              ▼
                 services/findingsEngine.buildResult (merge -> status+confidence)
                                              ▼
                         reports/jsonReport + reports/htmlReport
```

Every module is independent and communicates through plain objects, so any
piece (storage, AI provider, a new validator) can be swapped without
touching the rest.

## Install

```powershell
npm install
npx playwright install
```

`npx playwright install` downloads the chromium/firefox/webkit binaries.

## Configure

Edit [config/project.json](config/project.json):

```json
{
  "website": "https://example.com",
  "pages": [{ "name": "Home", "path": "/" }],
  "browsers": ["chromium", "firefox", "webkit"],
  "languages": ["en", "ja", "fr"],
  "viewports": [
    { "name": "iPhone 12", "width": 390, "height": 844 },
    { "name": "Desktop", "width": 1366, "height": 768 }
  ],
  "ai": {
    "enabled": true,
    "provider": "ollama",
    "model": "qwen2.5vl:3b",
    "baseURL": "http://127.0.0.1:11434",
    "timeoutMs": 300000,
    "numCtx": 4096,
    "ollamaMaxPixels": 1000000
  },
  "thresholds": { "contrastAA": 4.5, "contrastAALarge": 3.0 }
}
```

The scan runs the cartesian product of pages x browsers x languages x
viewports. `thresholds` controls the WCAG contrast pass/fail ratios (4.5:1
for normal text, 3:1 for large text by default).

## Run

### CLI (no server)

```powershell
npm run scan                     # uses config/project.json
node scripts/scanCli.js my.json  # custom config
```

Prints the summary and paths to `scans/<timestamp>/report.html` and
`report.json`.

### API server

```powershell
npm start
```

| Method | Route          | Description                                        |
| ------ | -------------- | -------------------------------------------------- |
| POST   | `/scan`        | Start a scan. Optional JSON config body. Returns `{ scanId }`. Runs async. |
| GET    | `/scan/:id`    | Poll progress: `{ status, completed, total, summary }`. `status` is `queued` -> `running` -> `done`/`error`. |
| GET    | `/report/:id`  | HTML report. Add `?format=json` for the full JSON report. |
| GET    | `/scans/...`   | Static access to raw screenshots and report files. |

Example:

```powershell
# start a scan
curl -X POST http://localhost:3000/scan
# -> { "scanId": "…", "progressUrl": "/scan/…", "reportUrl": "/report/…" }

# poll
curl http://localhost:3000/scan/<id>

# open report in a browser
start http://localhost:3000/report/<id>
```

## Validators

Located in [validators/](validators). Each exports
`{ name, tier, category, run(page, ctx) }` and returns findings
`{ status, severity, type, message }`. `tier` is `authoritative` or `hint`.

Authoritative (trusted, set the verdict):

- `overflow` – horizontal overflow (document wider than viewport)
- `brokenImages` – empty src, failed render, failed image requests
- `contrast` – WCAG AA/AAA contrast ratios (pure math, solid backgrounds only;
  translucent / image / gradient backgrounds are left to AI vision)
- `clickability` – real actionability via `locator.click({ trial: true })`
  (covered / not visible / disabled / off-screen)
- `alignment` – checkboxes / radio buttons stacked in a list that do not share
  a common left edge (conservative: only small, non-nesting offsets, WARN)
- `clipped` – interactive controls / open menus partially cut off by a
  container with `overflow: hidden`/`clip` (WARN)

Hints (forwarded to AI, never fail on their own):

- `hiddenElements` – zero-size / offscreen / invisible content elements
- `overlap` – interactive elements covered by another element (DOM geometry)
- `textOverflow` – clipped text, unexpected ellipsis, content past container

Add a validator by dropping a module in the folder (export a `tier`) and
registering it in the `PLUGINS` array in
[validators/index.js](validators/index.js).

## AI vision (the verdict layer)

[ai/analyzer.js](ai/analyzer.js) is provider-neutral and returns
`{ overallStatus, confidence, issues[] }`. The prompt (in
[ai/prompt.js](ai/prompt.js)) instructs a Senior Responsive QA Engineer to
treat the screenshot as the source of truth and DOM findings as hints only.

- **Local Ollama (recommended):** private and cost-free. Install Ollama, pull
  Qwen2.5-VL, and select `provider: "ollama"`. Screenshots remain on the local
  machine and no API key is needed:

```powershell
ollama pull qwen2.5vl:3b
ollama serve
```

  Ollama runs at `http://127.0.0.1:11434`. The configured `timeoutMs` includes
  local model loading and inference time. **`qwen2.5vl:3b` is the recommended
  default** (fast on modest hardware); `qwen2.5vl:7b` is sharper but ~6 GB and
  can be very slow on a low-RAM machine. See
  [Running on a budget](#running-on-a-budget--free-checks-first-ai-second) for
  model choice, memory settings, and the free-vs-AI layering.
- **Mock:** cost-free and conservative. It cannot see the
  screenshot, so it never invents visual issues or escalates hints — it only
  mirrors the deterministic status and reports honest, modest confidence
  (flagging unverified hints for human review). This is what removes the old
  false positives.
- **OpenAI:** set `provider: "openai"` and provide `OPENAI_API_KEY` in a local
  `.env` file (copy `.env.example`). Only combinations that have a fact or a
  hint to confirm are sent (clean pages are skipped), keeping cost/time low.

```powershell
Copy-Item .env.example .env
# Edit .env and set OPENAI_API_KEY, then:
npm start
```

Each result now includes `status`, `confidence` (0-100), `needsHumanReview`,
counted `findings[]` (facts + confirmed AI issues), uncounted `hints[]`, and
an `ai` verdict block. The scan `summary` adds a `needsHumanReview` count.

## Running on a budget — free checks first, AI second

The system is layered so you lean on paid / rate-limited AI as little as
possible. For each screenshot, in order:

1. **Free code checks (no AI, no limits, instant).** The deterministic
   validators measure facts: horizontal overflow, cut-off / clipped controls,
   misaligned checkboxes, broken images, contrast, real clickability. These
   catch the *mechanical* bugs — a button pushed past the screen edge, a
   checkbox that does not line up — reliably and for free.
2. **Local AI (free, private).** A local Ollama vision model gives a fast, rough
   visual pass on your own machine. No API key; nothing leaves the computer.
3. **Cloud AI (sharper, but rate-limited / paid).** Gemini (free tier), or
   GPT-4o / Claude (paid) for the subtle visual-judgment cases.

Nothing depends on the weakest link: if the small local model misses a subtle
bug, the free code checks still catch the mechanical ones, and a cloud model can
handle the hard few. In the web UI, each result shows the split — e.g.
**🔧 3 free code checks · 🤖 2 AI issues** — so you can see how much is caught
without paid models.

### Choosing a local model (Ollama)

`qwen2.5vl:3b` is the recommended default for a modest machine:

- The 7B model (`qwen2.5vl:7b`) is ~6 GB and can swap to disk on a low-RAM
  machine → **minutes** per image. The 3B model (~2 GB) runs in **seconds**.
- 3B is fast but **less accurate** — it misses subtle issues. That is expected,
  and exactly why the free code checks carry the mechanical bugs.

```powershell
ollama pull qwen2.5vl:3b
```

```json
"ai": { "provider": "ollama", "model": "qwen2.5vl:3b" }
```

### Local-model settings (`config/project.json` → `ai`)

| Setting           | Default        | What it does |
| ----------------- | -------------- | ------------ |
| `model`           | `qwen2.5vl:3b` | Local vision model. |
| `numCtx`          | `4096`         | Ollama context window. **Keep it small** — a bigger window allocates a larger memory buffer up front and can push a low-RAM machine into swap (very slow). |
| `ollamaMaxPixels` | `1000000`      | Large screenshots are automatically shrunk to this many pixels before the local model sees them (fewer tokens = fits the context + faster). Small screenshots are left as-is; cloud providers are never shrunk. |
| `timeoutMs`       | `300000`       | Max time per image (local models can be slow). |
| `ollamaSchema`    | *(off)*        | Strict JSON-schema output. **Off by default** — small models loop-fill the schema forever and return invalid JSON. Only enable for a large, capable local model. |

The local model's JSON is parsed **leniently** (JS-style `//` comments and
trailing commas are tolerated), because small models often emit those.

### Which vision provider

| Provider           | Cost      | Notes |
| ------------------ | --------- | ----- |
| Ollama (local)     | Free      | Private, no key, runs on your machine. Fast with 3B; quality lower than cloud. |
| Google Gemini      | Free tier | Fast and sharp; daily rate limits (HTTP 429 when the quota is used up). Set `GEMINI_API_KEY`. |
| OpenAI GPT-4o      | Paid      | Requires billing on the account. Set `OPENAI_API_KEY`. |
| Anthropic Claude   | Paid      | Requires credits on the account. Set `ANTHROPIC_API_KEY`. |

Add cloud keys to a local `.env` (copy `.env.example`). The web UI's **model
picker** shows which providers are available and lets you compare several on the
same screenshot, marking the best result.

### Measuring quality (benchmark)

`benchmark/cases.json` holds labeled screenshots with the issues each one
*should* — and *should not* — flag. Run:

```powershell
npm run benchmark                              # all available providers
npm run benchmark -- --providers gemini,ollama # specific ones
```

It scores each model on **recall** (did it catch the known bug?) and
**false-flags**, so you can see which model actually catches *your* bugs before
relying on it. Details in [benchmark/README.md](benchmark/README.md).

## n8n integration

Import [n8n/workflow.json](n8n/workflow.json) into your n8n instance
(Workflows → Import from File). Flow:

```
Manual Trigger -> Start Scan (POST /scan) -> Wait -> Check Progress (GET /scan/:id)
   -> Is Done? --true--> Get Report (GET /report/:id?format=json) -> Notify
              \--false-> Wait (loop)
```

The `Start Scan` node contains an editable JSON body; point the URLs at your
server host if it is not `localhost:3000`.

### Note on the existing workflow / response shape

The previous synchronous `/scan` returned the full results array directly.
This version is **async**: `/scan` returns a `scanId` and results are fetched
from `/report/:id`. Each result keeps the original fields (`page`, `path`,
`viewport`, `title`, `finalUrl`, `loadTime`, `consoleErrors`,
`failedRequests`) and adds `browser`, `language`, `status`, segmented
`screenshots[]`, and `findings[]`. A single-path `screenshot` field
(= `screenshots[0]`) is retained for backward compatibility with existing
n8n expressions.

## Reusing external Playwright flows (Percy bridge)

Sometimes you already have a Playwright suite that navigates, authenticates and
drives a page into a specific state (e.g. an existing **Percy/Playwright**
spec). Instead of re-implementing that navigation here, the bridge in
[services/analyzePage.js](services/analyzePage.js) lets that external suite run
**our validators + AI verdict** against its own **live, already-navigated
page** — no browser launch, no `page.goto` on our side.

```js
const { analyzePage, finalizeReport } = require("<path>/UI Automation/services/analyzePage");
const { createScanFolder } = require("<path>/UI Automation/utils/folder");
```

- **`analyzePage(page, { combination, config?, scanFolder?, imageRequestFailures? })`**
  runs `runValidators` + the shared accessibility/DOM summaries against the
  supplied live `page`, takes one in-place `state.png` screenshot, classifies
  facts vs hints, optionally calls the AI verdict layer, and returns the same
  normalized result object a native scan produces
  (`status`, `confidence`, `needsHumanReview`, `findings[]`, `hints[]`, `ai`).
  - `combination` = `{ page: <stateName>, path?, url?, browser?, language?, viewport?: { name?, width, height } }`.
    If `viewport` is omitted it is derived from `page.viewportSize()`.
  - `config` defaults to `loadConfig()`; `scanFolder` defaults to a fresh
    `createScanFolder()` — pass the **same** folder across calls so they share
    one scan/report.
- **`finalizeReport(scanFolder, config?, results)`** aggregates the collected
  results into `summary` + `buildReport` and writes `report.json` + `report.html`,
  returning `{ jsonPath, htmlPath, ... }`. Call it once at the end of the run.

**TS → CommonJS direction:** this platform is CommonJS. From a TypeScript spec
running under ts-node / jiti / tsx, consume the bridge with a runtime
`require(...)` (not `import`) as shown above — no build step or type
declarations needed. See
[examples/percy-bridge.example.ts](examples/percy-bridge.example.ts) for a full
illustrative spec that calls `analyzePage` inside its viewport loop right after
`percySnapshot(...)` and `finalizeReport` in `test.afterAll`.

**AI gating:** `analyzePage` only invokes AI when `findingsEngine.shouldReview`
finds a fact or hint to confirm. Ollama requires `ai.enabled: true`, provider
`ollama`, a running local server, and the configured model. OpenAI additionally
requires `OPENAI_API_KEY`. If the selected provider is inactive, the
conservative mock verdict is used. Clean states skip AI entirely.

## Output layout

```
scans/<timestamp>/
  report.json
  report.html
  <Page>/<browser>/<lang>/<WxH>/001.png, 002.png, ...
```

---

**PixelSentry** · © 2026 Luckindu Dissanayake | QA Engineer
