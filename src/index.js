// seo-guard entry point. Reads INPUT_* env vars (the GitHub Actions
// convention for action inputs), checks each URL, writes outputs and the
// step summary, and exits 1 when a check failed and warn-only is off.
// No dependencies beyond Node 24 built-ins.

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fetchRobots, parseDirectives, readLimitedText, verdict } from "./check.js";

// ---------- inputs ----------

const input = (name, fallback = "") => process.env["INPUT_" + name.toUpperCase()] ?? fallback;

const boolInput = (name, fallback = false) => {
  const v = input(name).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n", ""].includes(v)) return false;
  return fallback;
};

const urls = input("urls")
  .split(/[\n,]+/)
  .map((u) => u.trim())
  .filter(Boolean);

const failOnRaw = input("fail-on", "noindex,robots-block,canonical-mismatch,status")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// "noindex" is shorthand for both header and meta variants.
const failOn = new Set(
  failOnRaw.flatMap((code) => (code === "noindex" ? ["noindex-meta", "noindex-header"] : [code])),
);
const expectCanonicalSelf = boolInput("expect-canonical-self", true);
const userAgent = input("user-agent", "seo-guard/1 (+https://github.com/stillindexed/seo-guard)");
const timeoutSeconds = Number(input("timeout", "10")) || 10;
const warnOnly = boolInput("warn-only", false);

// ---------- outputs (work locally too, not just inside Actions) ----------

const inActions = Boolean(process.env.GITHUB_ACTIONS);
function emit(name, value) {
  if (inActions && process.env.GITHUB_OUTPUT) {
    const delimiter = `seo_guard_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    process.stdout.write(`${name}=${value}\n`);
  }
}
function annotate(level, message) {
  if (inActions) {
    // A URL is not a file; title carries it.
    process.stdout.write(`::${level} title=seo-guard::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`);
  } else {
    process.stdout.write(`${level.toUpperCase()}: ${message}\n`);
  }
}

// ---------- check ----------

const MAX_BODY = 2 << 20; // 2 MiB of response bytes
const robotsCache = new Map(); // origin → {status, body}

async function robotsFor(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, await fetchRobots(origin, { userAgent, timeoutSeconds }));
  }
  return robotsCache.get(origin);
}

async function checkUrl(url) {
  const result = { url, status: 0, finalUrl: url, ok: false, failures: [] };
  try {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      throw new Error("expected an HTTP(S) URL without credentials");
    }
    const res = await fetch(url, {
      headers: { "user-agent": userAgent },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    result.status = res.status;
    result.finalUrl = res.url || url;

    const isHTML = (res.headers.get("content-type") || "").toLowerCase().includes("html");
    const body = res.ok && isHTML ? await readLimitedText(res, MAX_BODY) : "";
    if (!isHTML || !res.ok) await res.body?.cancel();
    const directives = res.ok ? parseDirectives(body, res.headers) : undefined;

    // A redirect can move the URL to another host; its rules govern it.
    const robots = res.ok ? await robotsFor(new URL(result.finalUrl).origin) : undefined;
    const v = verdict(url, {
      status: res.status,
      finalUrl: result.finalUrl,
      directives: directives ?? undefined,
      robots,
      expectCanonicalSelf,
    });

    result.failures = v.failures.filter((f) => failOn.has(f.code));
    result.ok = result.failures.length === 0;
  } catch (err) {
    result.failures = [{ code: "status", message: `fetch failed: ${err.message}` }];
    result.ok = false;
  }
  return result;
}

// ---------- run ----------

const results = [];
if (urls.length === 0) {
  const failure = { code: "status", message: "urls input must contain at least one URL" };
  results.push({ url: "", status: 0, finalUrl: "", ok: false, failures: [failure] });
  annotate(warnOnly ? "warning" : "error", failure.message);
}
for (const url of urls) {
  const r = await checkUrl(url);
  results.push(r);
  for (const f of r.failures) {
    annotate(warnOnly ? "warning" : "error", `${url} — ${f.code}: ${f.message}`);
  }
}

const failed = results.some((r) => !r.ok);

const table = [
  "| URL | Status | Result | Failures |",
  "|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.url.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} | ${r.status || "—"} | ${r.ok ? "✓" : "✗"} | ${r.failures.map((f) => `\`${f.code}\``).join(", ") || "—"} |`,
  ),
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## seo-guard\n\n${table}\n`);
}

emit("results", JSON.stringify(results));
emit("failed", failed ? "true" : "false");
emit("summary", table);
if (!inActions) process.stdout.write(`\n${table}\n`);

if (failed && !warnOnly) {
  process.exitCode = 1;
}
