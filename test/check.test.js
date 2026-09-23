import test from "node:test";
import assert from "node:assert/strict";
import {
  isDisallowed,
  readLimitedText,
  parseDirectives,
  parseLinkHeader,
  parseXRobotsTag,
  verdict,
} from "../src/check.js";

// ---------- robots precedence (Google semantics) ----------

test("star group with blanket Disallow blocks everything", () => {
  const robots = "User-agent: *\nDisallow: /\n";
  assert.equal(isDisallowed(robots, "/", "googlebot"), true);
  assert.equal(isDisallowed(robots, "/anything/here", "googlebot"), true);
});

test("a Googlebot group replaces the * group", () => {
  const robots = "User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private\n";
  assert.equal(isDisallowed(robots, "/", "googlebot"), false, "specific group governs, not the blanket *");
  assert.equal(isDisallowed(robots, "/private/x", "googlebot"), true);
  assert.equal(isDisallowed(robots, "/anything", "bingbot"), true, "other agents fall back to *");
});

test("no group for the agent falls back to *", () => {
  const robots = "User-agent: *\nDisallow: /tmp\n";
  assert.equal(isDisallowed(robots, "/tmp/f", "googlebot"), true);
  assert.equal(isDisallowed(robots, "/pub", "googlebot"), false);
});

test("longest match wins regardless of Allow/Disallow order", () => {
  const robots = "User-agent: *\nAllow: /public\nDisallow: /\n";
  assert.equal(isDisallowed(robots, "/public/x", "googlebot"), false, "longer Allow beats shorter Disallow");
  assert.equal(isDisallowed(robots, "/other", "googlebot"), true);
});

test("Allow beats Disallow on equal length", () => {
  const robots = "User-agent: *\nDisallow: /x\nAllow: /x\n";
  assert.equal(isDisallowed(robots, "/x", "googlebot"), false);
});

test("case-insensitive agent and field names", () => {
  const robots = "USER-AGENT: GOOGLEBOT\nDISALLOW: /a\n";
  assert.equal(isDisallowed(robots, "/a", "Googlebot"), true);
  assert.equal(isDisallowed(robots, "/a", "googlebot"), true);
});

test("$ anchors the match to the end", () => {
  const robots = "User-agent: *\nDisallow: *.php$\n";
  assert.equal(isDisallowed(robots, "/a.php", "googlebot"), true);
  assert.equal(isDisallowed(robots, "/a.php/x", "googlebot"), false);
});

test("* wildcard matches any sequence", () => {
  const robots = "User-agent: *\nDisallow: /private*/\n";
  assert.equal(isDisallowed(robots, "/privateXYZ/", "googlebot"), true);
  assert.equal(isDisallowed(robots, "/priv/x", "googlebot"), false);
});

test("empty Disallow value is a no-op, not a block", () => {
  const robots = "User-agent: *\nDisallow:\n";
  assert.equal(isDisallowed(robots, "/", "googlebot"), false);
});

test("rules after a blank line start a new group", () => {
  const robots = "User-agent: Googlebot\nDisallow: /one\n\nUser-agent: Googlebot\nDisallow: /two\n";
  assert.equal(isDisallowed(robots, "/one", "googlebot"), true);
  assert.equal(isDisallowed(robots, "/two", "googlebot"), true);
});

test("consecutive User-agent lines share one group", () => {
  const robots = "User-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /shared\n";
  assert.equal(isDisallowed(robots, "/shared", "bingbot"), true);
});

// ---------- X-Robots-Tag parsing ----------

test("agent-scoped X-Robots-Tag directives land under their agent", () => {
  const m = parseXRobotsTag(["googlebot: noindex", "noarchive"]);
  assert.deepEqual(m["googlebot"], ["noindex"]);
  assert.deepEqual(m["*"], ["noarchive"]);
  assert.equal(m["*"].includes("noindex"), false);
});

test("combined X-Robots-Tag agent scopes do not hide Googlebot noindex", () => {
  const header = "bingbot: noindex, googlebot: noindex";
  const scopes = parseXRobotsTag([header]);
  assert.deepEqual(scopes["bingbot"], ["noindex"]);
  assert.deepEqual(scopes["googlebot"], ["noindex"]);
  assert.equal(parseDirectives("", { "x-robots-tag": header }).noindexHeader, true);
});

// ---------- parseDirectives: meta vs header ----------

test("noindex in meta robots sets noindexMeta only", () => {
  const d = parseDirectives(
    "<html><head><meta name='robots' content='noindex, follow'><title>t</title></head><body><h1>one</h1></body></html>",
    {},
  );
  assert.equal(d.noindexMeta, true);
  assert.equal(d.noindexHeader, false);
  assert.equal(d.title, "t");
  assert.equal(d.h1Count, 1);
});

test("noindex in X-Robots-Tag sets noindexHeader only", () => {
  const d = parseDirectives("<html><head><title>t</title></head></html>", {
    "x-robots-tag": "noindex, nofollow",
  });
  assert.equal(d.noindexMeta, false);
  assert.equal(d.noindexHeader, true);
});

test("noindex via googlebot meta variant is detected", () => {
  const d = parseDirectives("<html><head><meta name='googlebot' content='none'></head></html>", {});
  assert.equal(d.noindexMeta, true);
});

test("later robots and googlebot meta tags can override earlier index tags", () => {
  const robots = parseDirectives(
    "<meta name='robots' content='index'><meta name='robots' content='noindex'>",
  );
  const googlebot = parseDirectives(
    "<meta name='googlebot' content='index'><meta name='googlebot' content='none'>",
  );
  assert.equal(robots.noindexMeta, true);
  assert.equal(googlebot.noindexMeta, true);
});

test("canonical from the HTTP Link header is captured", () => {
  const d = parseDirectives("<html><head></head></html>", {
    link: '<https://a.com/self>; rel="canonical"',
  });
  assert.equal(d.canonicalLinkHeader, "https://a.com/self");
  assert.equal(d.canonicalLinkTag, "");
});

test("canonical from <link> tag is captured", () => {
  const d = parseDirectives('<html><head><link rel="canonical" href="/self"></head></html>', {});
  assert.equal(d.canonicalLinkTag, "/self");
});

test("parseLinkHeader handles multi-value and non-canonical links", () => {
  assert.deepEqual(parseLinkHeader(['<https://a/p>; rel="preload", <https://a/c>; rel=canonical']), [
    "https://a/c",
  ]);
  assert.deepEqual(parseLinkHeader(['<https://a/p>; rel="preload"']), []);
});

// ---------- canonical comparison ----------

test("canonical matching final URL passes; trailing slash difference tolerated", () => {
  const base = { status: 200, finalUrl: "https://a.com/pricing", robots: { status: 404, body: "" } };
  const same = verdict("https://a.com/pricing", {
    ...base,
    directives: parseDirectives('<link rel="canonical" href="https://a.com/pricing/">'),
  });
  assert.equal(same.ok, true);
  const dir = verdict("https://a.com/pricing/", {
    ...base,
    finalUrl: "https://a.com/pricing/",
    directives: parseDirectives('<link rel="canonical" href="https://a.com/pricing">'),
  });
  assert.equal(dir.ok, true);
});

test("canonical pointing elsewhere is a mismatch; missing canonical is a miss", () => {
  const mk = (html) =>
    verdict("https://a.com/", {
      status: 200,
      finalUrl: "https://a.com/",
      directives: parseDirectives(html),
      robots: { status: 404, body: "" },
    });
  assert.equal(mk('<link rel="canonical" href="https://b.com/">').ok, false);
  assert.equal(mk("<html></html>").failures.some((f) => f.code === "canonical-missing"), true);
});

// ---------- status and robots states ----------

test("5xx page status fails with the status code and no page checks", () => {
  const v = verdict("https://a.com/", { status: 503, directives: undefined });
  assert.equal(v.ok, false);
  assert.deepEqual(
    v.failures.map((f) => f.code),
    ["status"],
  );
});

test("final HTTP redirect status fails even when the URL did not change", () => {
  const result = verdict("https://a.com/", {
    status: 302,
    finalUrl: "https://a.com/",
    directives: parseDirectives('<link rel="canonical" href="https://a.com/">'),
    robots: { status: 404, body: "" },
  });
  assert.deepEqual(result.failures.map((failure) => failure.code), ["status"]);
});

test("response body stops at the 2 MiB byte cap and cancels the remainder", async () => {
  const limit = 2 << 20;
  const first = new Uint8Array(limit - 2).fill(97);
  first[first.length - 1] = 0xe2;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(first);
      else if (pulls === 2) controller.enqueue(Uint8Array.of(0x82, 0xac, 88));
      else throw new Error("read beyond body cap");
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const text = await readLimitedText(new Response(body));
  assert.equal(text, "a".repeat(limit - 3) + "€");
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
});

test("robots 5xx counts as blocked; 404 counts as allow", () => {
  const blocked = verdict("https://a.com/", {
    status: 200,
    finalUrl: "https://a.com/",
    directives: parseDirectives("<html></html>"),
    robots: { status: 503, body: "" },
    expectCanonicalSelf: false,
  });
  assert.equal(blocked.failures.some((f) => f.code === "robots-block"), true);

  const allowed = verdict("https://a.com/", {
    status: 200,
    finalUrl: "https://a.com/",
    directives: parseDirectives("<html></html>"),
    robots: { status: 404, body: "" },
    expectCanonicalSelf: false,
  });
  assert.equal(allowed.ok, true);
});

test("default fail-on set is respected by the caller-side filter contract", () => {
  // verdict reports everything it sees; index.js filters. canonical-missing
  // must be present in raw failures so the caller can choose to ignore it.
  const v = verdict("https://a.com/", {
    status: 200,
    finalUrl: "https://a.com/",
    directives: parseDirectives("<html><title>t</title></html>"),
    robots: { status: 404, body: "" },
  });
  assert.equal(v.failures.some((f) => f.code === "canonical-missing"), true);
});
