const fs = require("fs");
const path = require("path");
const { SYSTEM_PROMPT, buildUserPrompt } = require("./prompt");

/**
 * Vision providers supported for the screenshot comparison feature.
 * `free` is informational for the UI (true only for genuinely free-to-call
 * providers: local Ollama and Google Gemini's free tier).
 */
const PROVIDERS = {
    ollama: { label: "Ollama (local)", free: true },
    gemini: { label: "Google Gemini", free: true },
    openai: { label: "OpenAI GPT-4o", free: false },
    anthropic: { label: "Claude Sonnet", free: false }
};

const DEFAULT_MODELS = {
    ollama: "qwen2.5vl:7b",
    gemini: "gemini-3-flash-preview",
    openai: "gpt-4o",
    anthropic: "claude-sonnet-4-5"
};

// Gemini model names churn: free keys 404 on deprecated ids (e.g.
// gemini-1.5-flash) and per-model free quotas 429 independently. So instead of
// trusting one configured name, we try a list (newest → lightest) and use the
// first that responds. `geminiWorkingModel` caches the winner for the session
// so later calls skip the dead ones.
const GEMINI_FALLBACK_MODELS = [
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-2.0-flash",
    "gemini-flash-lite-latest"
];
let geminiWorkingModel = null;

const MEDIA_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif"
};

function readImage(screenshotPath) {
    const ext = path.extname(screenshotPath).slice(1).toLowerCase();
    return {
        media: MEDIA_TYPES[ext] || "image/png",
        base64: fs.readFileSync(screenshotPath).toString("base64")
    };
}

/**
 * Base64 for the LOCAL (Ollama) path, shrunk to a pixel budget.
 *
 * A big screenshot turns into many image tokens; combined with our prompt that
 * blows past Ollama's context window, and raising the window blows past a
 * modest machine's RAM (it allocates the whole KV cache up front). Shrinking the
 * image keeps the token count — and therefore memory and speed — under control,
 * while staying large enough to see layout problems. Cloud providers are NOT
 * downscaled; they handle full resolution fine.
 */
async function ollamaImageBase64(screenshotPath, maxPixels) {
    const buffer = fs.readFileSync(screenshotPath);
    const budget = Number(maxPixels) || 1000000;
    try {
        // eslint-disable-next-line global-require
        const Jimp = require("jimp");
        const img = await Jimp.read(buffer);
        const w = img.getWidth();
        const h = img.getHeight();
        if (w * h > budget) {
            const scale = Math.sqrt(budget / (w * h));
            img.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
            const out = await img.getBufferAsync(Jimp.MIME_PNG);
            return out.toString("base64");
        }
    } catch (err) {
        // If resizing fails for any reason, fall back to the original image.
    }
    return buffer.toString("base64");
}

/**
 * Downscale an image to a pixel budget for the CLOUD providers (Claude / Gemini
 * / GPT). Vision tokens scale with pixels, so this meaningfully cuts per-image
 * cost while keeping layout defects legible. Returns { media, base64 }.
 */
async function downscaledImage(screenshotPath, maxPixels) {
    const buffer = fs.readFileSync(screenshotPath);
    const ext = path.extname(screenshotPath).slice(1).toLowerCase();
    const budget = Number(maxPixels) || 1500000;
    try {
        // eslint-disable-next-line global-require
        const Jimp = require("jimp");
        const img = await Jimp.read(buffer);
        const w = img.getWidth();
        const h = img.getHeight();
        if (w * h > budget) {
            const scale = Math.sqrt(budget / (w * h));
            img.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
            const out = await img.getBufferAsync(Jimp.MIME_PNG);
            return { media: "image/png", base64: out.toString("base64") };
        }
    } catch (err) {
        // Fall back to the original image on any resize failure.
    }
    return { media: MEDIA_TYPES[ext] || "image/png", base64: buffer.toString("base64") };
}

/**
 * Resolve the model id for a provider. Honors the configured model when the
 * active config targets that same provider, then an env override, then a
 * sensible default — so single-provider scans keep their configured model
 * while multi-provider comparison uses each provider's proper default.
 */
function pickModel(provider, config) {
    if (config && config.ai && config.ai.provider === provider && config.ai.model) {
        return config.ai.model;
    }
    const envKey = {
        ollama: "OLLAMA_MODEL",
        gemini: "GEMINI_MODEL",
        openai: "OPENAI_MODEL",
        anthropic: "ANTHROPIC_MODEL"
    }[provider];
    return (envKey && process.env[envKey]) || DEFAULT_MODELS[provider];
}

/**
 * Whether a provider can be called right now (local, or has an API key).
 */
function providerAvailable(provider) {
    switch (provider) {
        case "ollama":
            return true;
        case "openai":
            return Boolean(process.env.OPENAI_API_KEY);
        case "anthropic":
            return Boolean(process.env.ANTHROPIC_API_KEY);
        case "gemini":
            return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
        default:
            return false;
    }
}

/**
 * Public list of providers + availability for the UI.
 */
function listProviders() {
    return Object.entries(PROVIDERS).map(([name, meta]) => ({
        name,
        label: meta.label,
        free: meta.free,
        model: pickModel(name, null),
        available: providerAvailable(name)
    }));
}

/**
 * Pluggable AI vision reviewer (hybrid pipeline: verdict layer).
 *
 * Returns a verdict object (NOT a flat findings array):
 *   { overallStatus: "PASS"|"WARNING"|"FAIL",
 *     confidence: 0-100,
 *     issues: [{ severity, category, title, description, location,
 *                confidence, recommendation }],
 *     source: "openai" | "ollama" | "mock" }
 *
 * Three modes:
 *  1. Local Ollama vision - when config.ai.provider is "ollama".
 *  2. Real OpenAI Vision - when config.ai.provider is "openai" and an API
 *     key is available.
 *     The screenshot is the source of truth; DOM hints are passed as hints.
 *  3. Mock - conservative and cost-free. Because it cannot see the
 *     screenshot, it NEVER escalates DOM hints into failures (this is what
 *     previously produced false positives). It bases the verdict only on
 *     deterministic/authoritative facts and reports low confidence so the
 *     result is clearly flagged for human review.
 */

function getProvider(config) {
    return config && config.ai ? config.ai.provider || "mock" : "mock";
}

function aiIsActive(config) {
    if (!config || !config.ai || !config.ai.enabled) return false;
    const provider = getProvider(config);
    if (provider === "ollama") return true;
    if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
    return false;
}

/**
 * @param {string} screenshotPath Absolute path to the primary PNG.
 * @param {object} context Rich evidence (see ai/prompt.buildUserPrompt) plus
 *   { config, authoritativeFindings, hints }.
 * @returns {Promise<object>} Verdict object.
 */
async function analyze(screenshotPath, context = {}) {
    const { config } = context;

    if (aiIsActive(config)) {
        const provider = getProvider(config);
        try {
            return await analyzeWithProvider(screenshotPath, context);
        } catch (err) {
            return {
                overallStatus: deterministicStatus(context),
                confidence: 30,
                issues: [
                    {
                        severity: "LOW",
                        category: "Layout",
                        title: "AI review unavailable",
                        description:
                            `${provider} vision analysis failed: ${err.message}`,
                        location: "n/a",
                        confidence: 100,
                        recommendation:
                            provider === "ollama"
                                ? "Confirm Ollama is running and the configured model is installed."
                                : "Check OPENAI_API_KEY, quota, and model access."
                    }
                ],
                source: "error"
            };
        }
    }

    return mockAnalyze(context);
}

async function analyzeWithProvider(screenshotPath, context) {
    const provider = getProvider(context.config);
    if (provider === "ollama") {
        return analyzeWithOllama(screenshotPath, context);
    }
    return analyzeWithOpenAI(screenshotPath, context);
}

async function analyzeWithOllama(screenshotPath, context) {
    const ai = context.config.ai;
    const base64 = await ollamaImageBase64(screenshotPath, ai.ollamaMaxPixels);
    const baseURL = ai.baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "");

    const body = {
        model: pickModel("ollama", context.config),
        stream: false,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
                role: "user",
                content: buildUserPrompt(context),
                images: [base64]
            }
        ],
        options: {
            temperature: 0,
            num_ctx: ai.numCtx || 4096,
            // Smaller models (e.g. qwen2.5vl:3b) tend to repeat the same issue
            // until they run out of room — which truncates the JSON and makes it
            // unparseable. A repeat penalty breaks the loop; num_predict caps the
            // response so it always closes cleanly inside the context window.
            num_predict: ai.numPredict || 1024,
            repeat_penalty: 1.3,
            repeat_last_n: 64
        },
        keep_alive: "10m"
    };

    // The strict JSON schema (`format`) makes small models fill the required
    // `issues` array with empty objects forever instead of stopping, so it is
    // OFF by default and we parse the model's JSON leniently instead. Turn it on
    // via config.ai.ollamaSchema for a large, capable local model.
    if (ai.ollamaSchema) body.format = VERDICT_SCHEMA;

    const response = await fetch(`${baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(ai.timeoutMs),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Ollama HTTP ${response.status}: ${body.slice(0, 300)}`
        );
    }

    const result = await response.json();
    const raw = result.message && result.message.content;
    if (!raw) throw new Error("Ollama returned an empty response");
    return normalizeVerdict(parseVerdict(raw), "ollama");
}

async function analyzeWithOpenAI(screenshotPath, context) {
    // eslint-disable-next-line global-require
    const OpenAI = require("openai");
    const ai = context.config.ai;
    const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: ai.timeoutMs
    });

    const model = pickModel("openai", context.config);
    const { media, base64 } = await downscaledImage(screenshotPath, ai.maxPixels);
    const dataUrl = `data:${media};base64,${base64}`;

    const response = await client.chat.completions.create({
        model,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    { type: "text", text: buildUserPrompt(context) },
                    { type: "image_url", image_url: { url: dataUrl } }
                ]
            }
        ],
        temperature: 0,
        response_format: { type: "json_object" }
    });

    const raw = response.choices?.[0]?.message?.content || "{}";
    return normalizeVerdict(parseVerdict(raw), "openai");
}

const ANTHROPIC_API = "https://api.anthropic.com/v1";

// Set once a model id is confirmed to work, so later calls skip retired ones.
let anthropicWorkingModel = null;

/**
 * User-scoped keys (sk-ant-usr-...) are not tied to a workspace, so Anthropic
 * requires the anthropic-workspace-id header on every request.
 */
function anthropicHeaders() {
    const headers = {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
    };
    if (process.env.ANTHROPIC_WORKSPACE_ID) {
        headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID.trim();
    }
    return headers;
}

/**
 * Turn an Anthropic error response into a message a QA engineer can act on.
 */
function anthropicErrorMessage(status, bodyText) {
    let type = "";
    let message = bodyText.slice(0, 300);
    try {
        const parsed = JSON.parse(bodyText);
        type = parsed.error?.type || "";
        message = parsed.error?.message || message;
    } catch (err) {
        // Non-JSON body: keep the raw text.
    }

    if (status === 401) {
        const key = process.env.ANTHROPIC_API_KEY || "";
        // A user-scoped key (sk-ant-usr...) without a workspace id gets a
        // misleading 401 "invalid x-api-key" on /messages — the real fix is the
        // workspace id, not a new key.
        if (key.startsWith("sk-ant-usr") && !process.env.ANTHROPIC_WORKSPACE_ID) {
            return "This Claude key is user-scoped and needs a workspace. Set " +
                "ANTHROPIC_WORKSPACE_ID in .env (Console > Settings > Workspaces), or use " +
                "a workspace API key (sk-ant-api...).";
        }
        return "Claude API key was rejected (invalid or revoked). Create a new key at " +
            "console.anthropic.com and update ANTHROPIC_API_KEY in .env.";
    }
    if (status === 400 && /workspace/i.test(message)) {
        return "This Claude key is user-scoped and needs a workspace. Set " +
            "ANTHROPIC_WORKSPACE_ID in .env (Console > Settings > Workspaces), or use " +
            "a workspace API key (sk-ant-api...).";
    }
    if (status === 402 || /credit balance|billing/i.test(message)) {
        return "Claude account has no credits. Add credits at console.anthropic.com > Billing.";
    }
    if (status === 403) {
        return `Claude key lacks permission for this request: ${message}`;
    }
    if (status === 404 || type === "not_found_error") {
        return `Claude model unavailable: ${message}`;
    }
    if (status === 429) {
        return `Claude rate limit reached; try again shortly. (${message})`;
    }
    return `Anthropic HTTP ${status}: ${message}`;
}

/**
 * Newest model the key can use, preferring Sonnet. Used when the configured
 * model has been retired.
 */
async function discoverAnthropicModel(timeoutMs) {
    const response = await fetch(`${ANTHROPIC_API}/models?limit=100`, {
        headers: anthropicHeaders(),
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
        throw new Error(anthropicErrorMessage(response.status, await response.text()));
    }
    const models = (await response.json()).data || [];
    const byNewest = [...models].sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
    const sonnet = byNewest.find(m => /sonnet/i.test(m.id));
    const chosen = sonnet || byNewest[0];
    if (!chosen) throw new Error("No Claude models are available for this API key.");
    return chosen.id;
}

async function anthropicMessage(model, media, base64, context, timeoutMs) {
    return fetch(`${ANTHROPIC_API}/messages`, {
        method: "POST",
        headers: anthropicHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
            model,
            max_tokens: 2048,
            temperature: 0,
            system: SYSTEM_PROMPT,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: { type: "base64", media_type: media, data: base64 }
                        },
                        { type: "text", text: buildUserPrompt(context) }
                    ]
                }
            ]
        })
    });
}

async function analyzeWithAnthropic(screenshotPath, context) {
    const ai = context.config.ai;
    const { media, base64 } = await downscaledImage(screenshotPath, ai.maxPixels);
    let model = anthropicWorkingModel || pickModel("anthropic", context.config);

    let response = await anthropicMessage(model, media, base64, context, ai.timeoutMs);

    if (response.status === 404) {
        const retired = model;
        model = await discoverAnthropicModel(ai.timeoutMs);
        if (model !== retired) {
            response = await anthropicMessage(model, media, base64, context, ai.timeoutMs);
        }
    }

    if (!response.ok) {
        throw new Error(anthropicErrorMessage(response.status, await response.text()));
    }
    anthropicWorkingModel = model;

    const result = await response.json();
    const raw = Array.isArray(result.content)
        ? result.content.map(c => c.text).filter(Boolean).join("\n")
        : "";
    if (!raw) throw new Error("Anthropic returned an empty response");
    return normalizeVerdict(parseVerdict(raw), "anthropic");
}

/**
 * One Gemini generateContent call for a specific model. Never throws on an HTTP
 * status — returns { ok, status, raw, errorText } so the caller can decide
 * whether to fall back to another model. Network/timeout errors still throw.
 */
async function geminiGenerate(model, key, requestBody, timeoutMs) {
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: requestBody
    });
    if (!response.ok) {
        return { ok: false, status: response.status, errorText: (await response.text()).slice(0, 300) };
    }
    const result = await response.json();
    const raw = result.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .filter(Boolean)
        .join("\n") || "";
    return { ok: true, status: 200, raw };
}

async function analyzeWithGemini(screenshotPath, context) {
    const ai = context.config.ai;
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const { media, base64 } = await downscaledImage(screenshotPath, ai.maxPixels);

    // Try the cached winner, then the configured/.env model, then fallbacks.
    // A 404 (deprecated/unsupported) or 429 (per-model quota) advances to the
    // next candidate; any other failure stops and surfaces its message.
    const candidates = [...new Set(
        [geminiWorkingModel, pickModel("gemini", context.config), ...GEMINI_FALLBACK_MODELS]
            .filter(Boolean)
    )];

    const requestBody = JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
            {
                role: "user",
                parts: [
                    { inline_data: { mime_type: media, data: base64 } },
                    { text: buildUserPrompt(context) }
                ]
            }
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
    });

    const tried = [];
    for (const model of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const res = await geminiGenerate(model, key, requestBody, ai.timeoutMs);
        if (res.ok) {
            geminiWorkingModel = model; // cache for the rest of the session
            if (!res.raw) throw new Error("Gemini returned an empty response");
            return normalizeVerdict(parseVerdict(res.raw), "gemini");
        }
        tried.push(`${model} (${res.status})`);
        // Retry with a different model on a missing/unsupported model (404), a
        // per-model rate limit (429), or a transient server overload (500/502/
        // 503/504 — "high demand"). Anything else (400 bad request, 401/403
        // auth) is a real error, so stop and surface it.
        if (![404, 429, 500, 502, 503, 504].includes(res.status)) {
            throw new Error(`Gemini HTTP ${res.status}: ${res.errorText}`);
        }
        if (geminiWorkingModel === model) geminiWorkingModel = null; // cached one died
    }

    throw new Error(
        `No Gemini model is available right now — tried ${tried.join(", ")}. ` +
        `They're deprecated or rate-limited; try again later, or use another provider (e.g. Ollama).`
    );
}

/**
 * Build a non-throwing verdict describing why a provider produced no result.
 * `source` is "unavailable" (no key) or "error" (call failed) so the UI can
 * distinguish "not configured" from "tried and failed".
 */
function providerNotice(provider, source, message, context) {
    return {
        overallStatus: deterministicStatus(context),
        confidence: 0,
        issues: [
            {
                severity: "LOW",
                category: "Layout",
                title:
                    source === "unavailable"
                        ? `${provider} not configured`
                        : `${provider} review unavailable`,
                description: message,
                location: "n/a",
                confidence: 100,
                recommendation:
                    source === "unavailable"
                        ? `Add the API key for ${provider} to .env to enable it.`
                        : "Check the API key, quota, model access, and network.",
                box: null
            }
        ],
        source
    };
}

/**
 * Run ONE named provider against a screenshot, never throwing — failures come
 * back as a verdict with source "error"/"unavailable" so a multi-provider
 * comparison can render every column even when some fail.
 */
async function runProvider(provider, screenshotPath, context) {
    if (!providerAvailable(provider)) {
        return providerNotice(
            provider,
            "unavailable",
            "No API key configured for this provider.",
            context
        );
    }
    try {
        switch (provider) {
            case "ollama":
                return await analyzeWithOllama(screenshotPath, context);
            case "openai":
                return await analyzeWithOpenAI(screenshotPath, context);
            case "anthropic":
                return await analyzeWithAnthropic(screenshotPath, context);
            case "gemini":
                return await analyzeWithGemini(screenshotPath, context);
            default:
                return mockAnalyze(context);
        }
    } catch (err) {
        return providerNotice(provider, "error", err.message, context);
    }
}

const VERDICT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["overallStatus", "confidence", "issues"],
    properties: {
        overallStatus: {
            type: "string",
            enum: ["PASS", "WARNING", "FAIL"]
        },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        issues: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: [
                    "severity",
                    "category",
                    "title",
                    "description",
                    "location",
                    "confidence",
                    "recommendation",
                    "box"
                ],
                properties: {
                    severity: {
                        type: "string",
                        enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
                    },
                    category: {
                        type: "string",
                        enum: [
                            "Layout",
                            "Text",
                            "Navigation",
                            "Accessibility",
                            "Image",
                            "Interaction"
                        ]
                    },
                    title: { type: "string" },
                    description: { type: "string" },
                    location: { type: "string" },
                    confidence: {
                        type: "integer",
                        minimum: 0,
                        maximum: 100
                    },
                    recommendation: { type: "string" },
                    // Region of the image the issue refers to, as percentages
                    // (0-100) of the image dimensions. Used to draw annotations.
                    box: {
                        type: "object",
                        additionalProperties: false,
                        required: ["x", "y", "width", "height"],
                        properties: {
                            x: { type: "number", minimum: 0, maximum: 100 },
                            y: { type: "number", minimum: 0, maximum: 100 },
                            width: { type: "number", minimum: 0, maximum: 100 },
                            height: { type: "number", minimum: 0, maximum: 100 }
                        }
                    }
                }
            }
        }
    }
};

function parseVerdict(raw) {
    let text = String(raw).trim();
    if (text.startsWith("```")) {
        text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        // Smaller local models wrap valid JSON in prose, or emit JS-isms that
        // aren't strict JSON: `// comments`, /* comments */, and trailing commas.
        // Extract the outermost object and clean those up before parsing. We
        // never convert malformed output into an implicit PASS.
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 && end > start) {
            const cleaned = text
                .slice(start, end + 1)
                .replace(/\/\*[\s\S]*?\*\//g, "")        // /* block comments */
                .replace(/([^:"])\/\/[^\n\r]*/g, "$1")   // // line comments (not URLs)
                .replace(/,(\s*[}\]])/g, "$1");          // trailing commas
            try {
                return JSON.parse(cleaned);
            } catch (nestedErr) {
                // Fall through to the explicit failure below.
            }
        }
        throw new Error("Model returned invalid JSON");
    }
}

function normalizeVerdict(v, source) {
    const status = String(v.overallStatus).toUpperCase();
    if (!["PASS", "WARNING", "FAIL"].includes(status)) {
        throw new Error("Model response is missing a valid overallStatus");
    }

    const issues = Array.isArray(v.issues) ? v.issues : [];

    return {
        overallStatus: status,
        confidence: clampConfidence(v.confidence, 70),
        // A PASS means the model found no user-visible defect. Local models
        // sometimes echo a dismissed DOM hint as a LOW "issue"; do not let
        // that reintroduce the false positives the hybrid model prevents.
        issues: status === "PASS" ? [] : issues.map(normalizeIssue),
        source
    };
}

function normalizeIssue(issue) {
    const severity = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(
        String(issue.severity).toUpperCase()
    )
        ? String(issue.severity).toUpperCase()
        : "MEDIUM";
    return {
        severity,
        category: issue.category || "Layout",
        title: issue.title || issue.issue || "Visual issue",
        description: issue.description || issue.message || "",
        location: issue.location || "unspecified",
        confidence: clampConfidence(issue.confidence, 80),
        recommendation: issue.recommendation || "",
        box: normalizeBox(issue.box)
    };
}

/**
 * Validate an issue's annotation box. Returns { x, y, width, height } clamped
 * to 0-100, or null when the model omitted it or produced an unusable region.
 */
function normalizeBox(box) {
    if (!box || typeof box !== "object") return null;
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    const x = num(box.x);
    const y = num(box.y);
    const width = num(box.width);
    const height = num(box.height);
    if (x === null || y === null || width === null || height === null) {
        return null;
    }
    const clamp = v => Math.max(0, Math.min(100, v));
    if (width <= 0 || height <= 0) return null;
    return { x: clamp(x), y: clamp(y), width: clamp(width), height: clamp(height) };
}

function clampConfidence(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Verdict derived purely from authoritative (deterministic) findings.
 */
function deterministicStatus(context) {
    const auth = context.authoritativeFindings || [];
    if (auth.some(f => f.status === "FAIL")) return "FAIL";
    if (auth.some(f => f.status === "WARN")) return "WARNING";
    return "PASS";
}

/**
 * Conservative mock verdict.
 *
 * The mock cannot actually see the screenshot, so it deliberately does NOT
 * invent visual issues and does NOT duplicate the authoritative facts (those
 * are already reported by the deterministic validators). It only mirrors the
 * deterministic status and reports honest, modest confidence - low when there
 * are unverified DOM hints - so the result is clearly flagged for the human
 * to confirm visually. Real value comes from enabling OpenAI vision.
 */
function mockAnalyze(context) {
    const overallStatus = deterministicStatus(context);
    const hasAuthIssue = overallStatus !== "PASS";
    const hintCount = (context.hints || []).length;

    const confidence = hasAuthIssue
        ? 65 // deterministic facts are solid, but visual is unverified
        : hintCount
        ? 40 // hints exist but cannot be verified without vision
        : 55; // clean page, but no visual confirmation

    return { overallStatus, confidence, issues: [], source: "mock" };
}

module.exports = {
    analyze,
    aiIsActive,
    deterministicStatus,
    getProvider,
    parseVerdict,
    normalizeVerdict,
    runProvider,
    providerAvailable,
    listProviders,
    PROVIDERS
};
