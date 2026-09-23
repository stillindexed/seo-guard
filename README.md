# seo-guard

A GitHub Action that fails a deploy when it introduces the exact regressions
stillindexed monitors continuously: `noindex` (meta or `X-Robots-Tag`),
robots.txt blocks for Googlebot, canonical regressions, and unexpected status
codes. One fetch per URL, no JavaScript rendering, no dependencies.

## Usage

```yaml
- uses: stillindexed/seo-guard@v1
  with:
    urls: |
      https://example.com/
      https://example.com/pricing
```

Run it after every deploy against the pages a business depends on. Newlines
or commas separate URLs.

## What it checks

| Check | Code | How |
|---|---|---|
| Page returns 2xx | `status` | HTTP status of the final response |
| No `noindex`/`none` in `<meta name="robots">` or `<meta name="googlebot">` | `noindex-meta` | parsed from the HTML |
| No `noindex`/`none` in `X-Robots-Tag` (global or Googlebot-scoped) | `noindex-header` | response headers |
| Googlebot allowed for the URL | `robots-block` | robots.txt at the final origin, Google's evaluation: longest match wins, `Allow` beats `Disallow` on equal length, a `Googlebot` group replaces `*`, `$` and `*` wildcards. A robots 5xx/401/403 counts as blocked; 404 counts as allow |
| Canonical points at itself when present | `canonical-mismatch`, `canonical-missing` | `<link rel=canonical>` and the HTTP `Link` header; trailing-slash differences tolerated; add `canonical-missing` to `fail-on` to require one |
| No unexpected redirect | `redirect` | final URL differs from the requested URL |

### Inputs

| Input | Default | |
|---|---|---|
| `urls` | — (required) | newline/comma separated |
| `fail-on` | `noindex,robots-block,canonical-mismatch,status` | which codes fail the step (`noindex` = meta + header; `canonical-missing` and `redirect` are opt-in) |
| `expect-canonical-self` | `true` | check canonical when present; add `canonical-missing` to `fail-on` to require one |
| `user-agent` | `seo-guard/1 (+https://github.com/stillindexed/seo-guard)` | |
| `timeout` | `10` | seconds per request |
| `warn-only` | `false` | report as warnings, always exit 0 |

### Outputs

| Output | |
|---|---|
| `results` | JSON array of per-URL results |
| `failed` | `"true"` when any URL failed the enabled checks |
| `summary` | Markdown table (also written to `$GITHUB_STEP_SUMMARY`) |

The Action fetches the URLs you supply, including private network addresses.
Use trusted literal workflow inputs; do not pass URLs controlled by untrusted
pull requests. Pin `@v1.0.1` (or a commit SHA) instead of `@v1` if your
workflows require an immutable version.

## What it does not do

No JavaScript rendering — pages that need a browser are checked as a
non-JS crawler sees them. No crawling — one fetch per URL plus one
robots.txt per origin. No continuous monitoring — a deploy check sees the
moment it runs, nothing else.

That last limit is the point of stillindexed. A CDN rule, a CMS plugin
update, or a DNS change can break a page's indexability between deploys, and
no post-deploy check will be there when it happens.
[stillindexed.com](https://stillindexed.com) watches robots.txt, noindex,
canonical, status, titles and certificates around the clock and tells you
when something changes.

## Development

```sh
npm test        # node --test
npm run build   # copies src/ to dist/
```

Commit changes to `src/` and the rebuilt `dist/` together: Actions run
`dist/index.js` from the published tag, without a build step in user workflows.

Licensed under [MIT](LICENSE).
