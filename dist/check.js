// Pure check functions for seo-guard: no I/O, no dependencies, unit-testable
// with node --test. index.js owns fetching and GitHub plumbing.

// ---------- robots.txt ----------

// fetchRobots(origin) fetches the origin's robots.txt. Returns
// { status, body } — body "" when missing. Network errors throw; verdict()
// never sees robots.txt on its own, the caller decides how much of a check
// is possible.
export async function fetchRobots(origin, { userAgent, timeoutSeconds = 10 } = {}) {
  const res = await fetch(origin.replace(/\/$/, "") + "/robots.txt", {
    headers: { "user-agent": userAgent },
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
    redirect: "follow",
  });
  const body = res.ok ? await readLimitedText(res) : "";
  if (!res.ok) await res.body?.cancel();
  return { status: res.status, body };
}

// Read no more than limitBytes from a response, even when the server sends
// more. Cancel the stream at the boundary rather than buffering the full body.
export async function readLimitedText(response, limitBytes = 2 << 20) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let bytesRead = 0;
  try {
    while (bytesRead < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limitBytes - bytesRead);
      parts.push(decoder.decode(chunk, { stream: true }));
      bytesRead += chunk.byteLength;
    }
    if (bytesRead >= limitBytes) await reader.cancel();
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

// parseRobotGroups(robotsTxt) → [{ agents: [lowercase tokens], rules: [{ allow, value }] }]
// Empty Allow:/Disallow: values are dropped: an empty path matches nothing.
export function parseRobotGroups(robotsTxt) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of (robotsTxt || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      current = null; // blank line ends a group
      lastWasAgent = false;
      continue;
    }
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      const agent = value.toLowerCase();
      if (lastWasAgent && current) {
        current.agents.push(agent); // consecutive User-agent lines share a group
      } else {
        current = { agents: [agent], rules: [] };
        groups.push(current);
      }
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!value) continue; // empty value matches nothing
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.rules.push({ allow: field === "allow", value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

// patternToRegExp compiles one robots.txt path per Google's rules: `*` is a
// wildcard, `$` anchors the end, everything else is literal (the path may
// include the query string).
function patternToRegExp(value) {
  let pattern = "";
  let anchored = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "$" && i === value.length - 1) {
      anchored = true;
    } else if (ch === "*") {
      pattern += ".*";
    } else {
      pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + pattern + (anchored ? "$" : ""));
}

// groupsForAgent picks the groups that govern `agent` per Google's
// semantics: groups naming the agent exactly (case-insensitive) replace the
// `*` group; when none name it, the `*` group applies; none at all means
// allow.
export function groupsForAgent(groups, agent) {
  const wanted = (agent || "*").toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(wanted));
  if (specific.length) return specific;
  return groups.filter((g) => g.agents.includes("*"));
}

// isDisallowed(robotsTxt, path, agent) — Google's evaluation: the longest
// matching rule wins; Allow beats Disallow on equal length; `*` groups apply
// only when no group names the agent.
export function isDisallowed(robotsTxt, path, agent = "googlebot") {
  const applicable = groupsForAgent(parseRobotGroups(robotsTxt), agent);
  if (!applicable.length) return false;
  let best = { length: -1, allow: false };
  let matched = false;
  for (const g of applicable) {
    for (const rule of g.rules) {
      const re = patternToRegExp(rule.value);
      if (!re.test(path)) continue;
      matched = true;
      // Longest match wins; on equal length Allow beats Disallow.
      const beatsBest =
        rule.value.length > best.length ||
        (rule.value.length === best.length && rule.allow && !best.allow);
      if (beatsBest) best = { length: rule.value.length, allow: rule.allow };
    }
  }
  return matched ? !best.allow : false;
}

// ---------- page directives ----------

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'<>]+))', "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
};

const relHas = (rel, token) => rel.toLowerCase().split(/\s+/).includes(token);

function winToken(content) {
  for (const t of (content || "").split(",")) {
    const v = t.trim().toLowerCase();
    if (v === "noindex" || v === "none") return v;
  }
  return "";
}

// extractFirstTag(html, tagName) → attribute map of the first occurrence
function firstTag(html, tagName, test) {
  const re = new RegExp("<" + tagName + "\\b[^>]*>", "gi");
  for (const m of html.matchAll(re)) {
    if (!test || test(m[0])) return m[0];
  }
  return null;
}

// parseLinkHeader(values) → array of URL strings from `Link: <u>; rel="…"` values
export function parseLinkHeader(values) {
  const out = [];
  for (const value of values || []) {
    for (const part of value.split(/,(?=\s*<)/)) {
      const m = part.match(/<([^>]*)>/);
      const rel = part.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;,]+))/i);
      const rels = rel ? (rel[1] ?? rel[2] ?? rel[3] ?? "").toLowerCase().split(/\s+/) : [];
      if (m && rels.includes("canonical")) out.push(m[1]);
    }
  }
  return out;
}

// parseXRobotsTag(values) → map of agent → directive array, "*" for global.
// An agent prefix scopes directives until the next prefix or header value.
export function parseXRobotsTag(values) {
  const out = {};
  for (const value of values || []) {
    let agent = "*";
    for (const part of (value || "").split(",")) {
      let directive = part.trim();
      const m = directive.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
      if (m && !/^(noindex|none|nofollow|noarchive|nosnippet|notranslate|noimageindex|unavailable_after|max-)/i.test(m[1])) {
        agent = m[1].toLowerCase();
        directive = m[2].trim();
      }
      if (directive) (out[agent] = out[agent] || []).push(directive);
    }
  }
  return out;
}

// sliceNoindex — shared noindex/none detection for directive arrays.
function sliceNoindex(dirs) {
  for (const d of dirs || []) {
    const v = d.toLowerCase().trim();
    if (v === "noindex" || v === "none") return true;
  }
  return false;
}

// parseDirectives(html, headers) — headers: WHATWG Headers, Map, or plain object.
export function parseDirectives(html = "", headers = {}) {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  const headerValues = (name) => {
    if (typeof h.get === "function") {
      if (h instanceof Headers || typeof h.entries === "function") {
        const all = [];
        for (const [k, v] of h.entries()) {
          if (k.toLowerCase() === name) all.push(v);
        }
        return all;
      }
      const v = h.get(name);
      return v == null ? [] : [v];
    }
    return [];
  };

  const metaRobotsValues = [];
  const metaGooglebotValues = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = attr(match[0], "name").toLowerCase();
    if (name === "robots") metaRobotsValues.push(attr(match[0], "content").toLowerCase());
    else if (name === "googlebot") metaGooglebotValues.push(attr(match[0], "content").toLowerCase());
  }
  const canonicalLinkTag = firstTag(html, "link", (t) => relHas(attr(t, "rel") || "", "canonical"));

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const h1Count = (html.match(/<h1\b/gi) || []).length;

  const xrobots = parseXRobotsTag(headerValues("x-robots-tag"));
  const canonicalFromHeader = parseLinkHeader(headerValues("link"))[0] || "";

  return {
    metaRobots: metaRobotsValues.join(", "),
    metaGooglebot: metaGooglebotValues.join(", "),
    noindexMeta: metaRobotsValues.some((value) => winToken(value) !== "") ||
      metaGooglebotValues.some((value) => winToken(value) !== ""),
    noindexHeader: sliceNoindex(xrobots["*"]) || sliceNoindex(xrobots["googlebot"]),
    canonicalLinkTag: canonicalLinkTag ? attr(canonicalLinkTag, "href") : "",
    canonicalLinkHeader: canonicalFromHeader,
    title: titleMatch ? titleMatch[1].trim() : "",
    h1Count,
  };
}

// ---------- verdict ----------

// normalize(url) — trailing-slash-insensitive comparison key for canonicals.
function normalize(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/$/, "");
    else if (x.pathname === "/" && (x.search || x.hash)) x.pathname = "";
    return x.href;
  } catch {
    return u;
  }
}

// pathWithQuery(url) — the string robots.txt rules match against.
function pathWithQuery(u) {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return "/";
  }
}

// verdict(url, { status, finalUrl, directives, robots }) →
//   { ok, failures: [{ code, message }] }
// robots may be undefined (not fetched); status 0/undefined means fetch error.
export function verdict(url, { status, finalUrl, directives, robots, expectCanonicalSelf = true } = {}) {
  const failures = [];
  const d = directives || {};

  if (!status || status < 200 || status >= 300) {
    failures.push({ code: "status", message: `HTTP ${status || "error"} (expected 2xx)` });
    return { ok: false, failures }; // no page, no further page checks
  }

  if (finalUrl && normalize(finalUrl) !== normalize(url)) {
    failures.push({ code: "redirect", message: `redirected to ${finalUrl}` });
  }

  // robots-block: a Googlebot-specific disallow, or a robots.txt the crawler
  // cannot read (5xx; also 401/403) — Google treats "rules unreadable" as
  // blocked for this fetch. 404/410 = no rules = default allow.
  if (robots) {
    if (robots.status >= 500 || robots.status === 401 || robots.status === 403) {
      failures.push({ code: "robots-block", message: `robots.txt returned ${robots.status}; treat as blocked` });
    } else if (robots.status >= 200 && robots.status < 300) {
      if (isDisallowed(robots.body, pathWithQuery(finalUrl || url), "googlebot")) {
        failures.push({ code: "robots-block", message: `robots.txt disallows Googlebot for ${pathWithQuery(finalUrl || url)}` });
      }
    }
  }

  if (d.noindexMeta) {
    failures.push({ code: "noindex-meta", message: `meta robots/googlebot says "${d.metaRobots || d.metaGooglebot}"` });
  }
  if (d.noindexHeader) {
    failures.push({ code: "noindex-header", message: "X-Robots-Tag carries noindex/none" });
  }

  if (expectCanonicalSelf) {
    const raw = d.canonicalLinkTag || d.canonicalLinkHeader;
    if (!raw) {
      failures.push({ code: "canonical-missing", message: "no canonical in <link> or Link header" });
    } else {
      let abs = raw;
      try {
        abs = new URL(raw, finalUrl || url).href;
      } catch { /* keep raw for the comparison, it will not match */ }
      if (normalize(abs) !== normalize(finalUrl || url)) {
        failures.push({ code: "canonical-mismatch", message: `canonical points to ${abs}` });
      }
    }
  }

  return { ok: failures.length === 0, failures };
}
