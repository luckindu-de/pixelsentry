# Screenshot QA Benchmark

A labeled test set for measuring how well each vision model catches **your** known
UI defects — and avoids known false positives. It **measures** models; it does not
fine-tune them (Claude/GPT-4o/Gemini are hosted and can't be trained by uploading
images). Use it to pick the best model and to prove a prompt change actually helped.

## Run it

```bash
npm run benchmark                       # all available providers, all cases
npm run benchmark -- --providers gemini # just Gemini
npm run benchmark -- --case qr-list-390 # one case
```

Output per case shows, per provider: status, **recall** (expected issues caught),
**false-flags** (things it should NOT have flagged), and any other issues it raised.
A SUMMARY aggregates recall and false-flags across cases.

## Add a case

1. Drop the screenshot in `benchmark/cases/` (e.g. `cases/login-390.png`).
2. Add an entry to `cases.json`:

```jsonc
{
  "id": "login-390",
  "image": "cases/login-390.png",
  "meta": { "page": "Login", "browser": "chrome", "language": "en",
            "viewport": { "name": "390x844", "width": 390, "height": 844 } },

  // Issues the model SHOULD catch. `pattern` is a case-insensitive regex
  // tested against each issue's "title + description".
  "expected": [
    { "id": "cta-cut-off", "category": "Button",
      "pattern": "(button|cta).*(cut|clip|crop|hidden)",
      "note": "Human-readable description of the real defect." }
  ],

  // Things the model must NOT flag (known false positives / correct behavior).
  "mustNotFlag": [
    { "id": "user-input-emoji",
      "pattern": "emoji.*(broken|missing)",
      "note": "Emojis in a user-typed title are valid content, not a bug." }
  ]
}
```

### Writing good `pattern`s
- Keep them tolerant of wording differences between models. Use alternation:
  `"(vertical|column|top).*align|align.*(vertical|column|top)"`.
- Lookahead form is handy when several words must appear in any order:
  `"(?=.*align)(?=.*(vertical|column|row|top|cent))"`.
- Test a pattern against a model's actual output before trusting a red/green mark.

## Notes
- `expected` = recall (did it find the real bug?). `mustNotFlag` = precision guard.
- "Other" issues (matching neither list) are printed but not scored — review them by
  eye; a real new find should be promoted to `expected`, a false positive to
  `mustNotFlag`.
