const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const analyzer = require("../ai/analyzer");
const { loadConfig } = require("./configLoader");
const { SCANS_ROOT } = require("../utils/folder");

/**
 * Screenshot-upload analysis.
 *
 * Bridges an uploaded image straight into the existing AI vision reviewer
 * (ai/analyzer.js) without any Playwright scan. There is no DOM, so there are
 * no deterministic findings or hints to pass — the screenshot IS the source of
 * truth, which is exactly what the reviewer's system prompt already assumes.
 *
 * Uploaded files are persisted under uploads/<uuid>/ so the reviewer (which
 * reads a path) and the UI (which links back to the image) can both reach them.
 */

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

const EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
};

/**
 * Decode a `data:image/...;base64,....` URL into a Buffer + mime type.
 */
function decodeDataUrl(dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(
        String(dataUrl || "")
    );
    if (!match) {
        throw new Error("Each image must be a base64 image data URL");
    }
    const mime = match[1].toLowerCase();
    if (!EXT_BY_MIME[mime]) {
        throw new Error(`Unsupported image type: ${mime}`);
    }
    return { mime, buffer: Buffer.from(match[2], "base64") };
}

function safeName(name, ext) {
    const base = String(name || `screenshot.${ext}`)
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return base || `screenshot.${ext}`;
}

/**
 * Analyze a single uploaded screenshot.
 *
 * @param {object} input
 * @param {string} input.dataUrl  base64 image data URL.
 * @param {string} [input.filename]
 * @param {object} [input.meta]   { page, browser, language, viewport:{width,height} }.
 * @param {object} [input.config] Normalized config (defaults to loadConfig()).
 * @returns {Promise<object>} { id, filename, meta, verdict }
 */
async function analyzeImage(input = {}) {
    const config = input.config || loadConfig();

    const id = crypto.randomUUID();
    let file;
    let filename;
    let relative;

    if (input.scanRelative) {
        // Analyze a screenshot already captured on disk (from a scan) without
        // re-uploading it. Confine the path to SCANS_ROOT to prevent traversal.
        const rel = String(input.scanRelative)
            .replace(/^[\\/]+/, "")
            .replace(/\\/g, "/");
        const abs = path.resolve(SCANS_ROOT, rel);
        const root = path.resolve(SCANS_ROOT);
        if (abs !== root && !abs.startsWith(root + path.sep)) {
            throw new Error("Invalid scan path");
        }
        if (!fs.existsSync(abs)) {
            throw new Error(`Scan file not found: ${rel}`);
        }
        file = abs;
        filename = path.basename(abs);
        relative = `scans/${rel}`;
    } else {
        const { buffer, mime } = decodeDataUrl(input.dataUrl);
        const ext = EXT_BY_MIME[mime];
        const dir = path.join(UPLOADS_ROOT, id);
        fs.mkdirSync(dir, { recursive: true });
        filename = safeName(input.filename, ext);
        file = path.join(dir, filename);
        fs.writeFileSync(file, buffer);
        relative = `uploads/${id}/${filename}`;
    }

    const meta = input.meta || {};
    const rawVp = meta.viewport || {};
    const viewport = {
        name: rawVp.name,
        width: Number(rawVp.width) || 0,
        height: Number(rawVp.height) || 0
    };

    const context = {
        page: meta.page || filename || "Uploaded screenshot",
        browser: meta.browser || "n/a",
        language: meta.language || "en",
        viewport,
        config,
        // No live page: nothing to reconcile, so these are intentionally empty.
        consoleErrors: [],
        failedRequests: [],
        accessibility: {},
        domSummary: {},
        authoritativeFindings: [],
        hints: []
    };

    const resultMeta = {
        id,
        filename,
        relative,
        meta: {
            page: meta.page || filename,
            browser: meta.browser || "n/a",
            language: meta.language || "en",
            viewport
        }
    };

    // Multi-provider comparison when a provider list is supplied; otherwise the
    // original single-verdict behavior (uses the configured provider).
    const providers = Array.isArray(input.providers) ? input.providers : null;
    if (providers && providers.length) {
        const runs = await Promise.all(
            providers.map(async provider => {
                const verdict = await analyzer.runProvider(provider, file, context);
                const info = PROVIDER_META[provider] || { label: provider, free: false };
                return {
                    provider,
                    label: info.label,
                    free: info.free,
                    available: analyzer.providerAvailable(provider),
                    verdict
                };
            })
        );
        const bestProvider = pickBest(runs);
        const best = runs.find(r => r.provider === bestProvider) || runs[0];
        return {
            ...resultMeta,
            providers: runs,
            best: bestProvider,
            verdict: best ? best.verdict : null
        };
    }

    const verdict = await analyzer.analyze(file, context);
    return { ...resultMeta, verdict };
}

const PROVIDER_META = analyzer.PROVIDERS;

/**
 * Heuristic quality score for a verdict when there is no ground truth.
 * Rewards catching issues (with a bias toward the alignment/spacing/crop
 * defects we care about) and placing boxes; a failed/unavailable run scores
 * below zero so it can never be chosen as best. NOTE: this is a rough proxy —
 * more issues is treated as better coverage, so a real labeled benchmark is
 * still needed to judge precision.
 */
function scoreVerdict(verdict) {
    if (!verdict || verdict.source === "error" || verdict.source === "unavailable") {
        return -1;
    }
    const issues = verdict.issues || [];
    let score = issues.length * 2;
    for (const i of issues) {
        score += (Number(i.confidence) || 0) / 100;
        const text = `${i.title || ""} ${i.description || ""}`.toLowerCase();
        if (/align|checkbox|padding|spacing|overlap|crop|cut|clip|misalign/.test(text)) {
            score += 1.5;
        }
        if (i.box) score += 0.5;
    }
    return score;
}

// Article-informed preference for tie-breaks (Claude best at UI, then GPT-4o,
// then Gemini, then the local model).
const PROVIDER_PREFERENCE = ["anthropic", "openai", "gemini", "ollama"];

function pickBest(runs) {
    let best = null;
    let bestScore = -Infinity;
    for (const r of runs) {
        const s = scoreVerdict(r.verdict);
        const pref = PROVIDER_PREFERENCE.indexOf(r.provider);
        const tie = s === bestScore &&
            best &&
            pref < PROVIDER_PREFERENCE.indexOf(best.provider);
        if (s > bestScore || tie) {
            best = r;
            bestScore = s;
        }
    }
    return best ? best.provider : (runs[0] && runs[0].provider);
}

/**
 * Analyze a batch of uploaded screenshots sequentially (local vision models
 * are single-GPU bound, so parallelism gains little and risks timeouts).
 *
 * @param {object[]} images  Array of { dataUrl, filename, meta }.
 * @param {object} [config]
 * @returns {Promise<object[]>}
 */
async function analyzeImages(images, config, providers) {
    const cfg = config || loadConfig();
    const list = Array.isArray(images) ? images : [];
    const results = [];
    for (const img of list) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await analyzeImage({
            ...img,
            providers: img.providers || providers,
            config: cfg
        }));
    }
    return results;
}

module.exports = {
    UPLOADS_ROOT,
    analyzeImage,
    analyzeImages
};
