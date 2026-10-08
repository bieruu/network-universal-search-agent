# ARCHITECTURE — Network Universal Search Agent

## 1. System Overview

```
[ Browser: Next.js App Router ] 
   │ Better Auth session + fetch via /api/* (Next proxy)
   ▼
[ Next Route Handlers (/api/* proxy) ] ── verifies session ──▶ [ FastAPI :8000 /api/v1/* ]
                                                                      │ asyncio.gather
                                    ┌─────────────────┬────────────────┼──────────────┐
                                    ▼                 ▼                ▼              ▼
                              Shodan API      crt.sh / Cert Spotter  WHOIS lib     SQLite cache (TTL 24h)
                                    │                 │                │              │
                                    └─────────────────┴────────────────┴──────┬───────┘
                                                                              ▼
                                                              PostgreSQL (users/targets/scans/findings)
```

Principles:
- Secrets never leave backend. Frontend never calls external OSINT providers directly.
- FastAPI is stateless orchestrator; Postgres is source of truth; SQLite is quota-saving cache.
- Partial failure is first-class: `partial` status + per-source errors.

## 2. Repository Layout (Clean, Modular)

```
/
├── PRD.md ARCHITECTURE.md AGENTS.md TODO.md WORKFLOW.md
├── docker-compose.yml
├── frontend/                       # Next.js
│   ├── app/
│   │   ├── (auth)/sign-in/page.tsx
│   │   ├── (dashboard)/dashboard/page.tsx
│   │   │   ├── TargetSearch.tsx     # input + validation (zod)
│   │   │   ├── ScanStatus.tsx       # polling
│   │   │   └── _components/
│   │   │       ├── OverviewCards.tsx
│   │   │       ├── PortsTable.tsx
│   │   │       ├── SubdomainsTable.tsx
│   │   │       ├── WhoisCard.tsx
│   │   │       ├── PortsChart.tsx   # doughnut + bar (chart.js)
│   │   │       └── RiskTrendChart.tsx
│   │   ├── api/scan/[...path]/route.ts  # proxy → FastAPI, attaches session
│   │   ├── layout.tsx  globals.css (dark default)
│   │   └── middleware.ts (Better Auth guard)
│   ├── components/ui/              # shadcn/ui (button, card, table, badge, skeleton, chart wrapper)
│   ├── lib/{auth-client.ts, api.ts, utils.ts, validators.ts}
│   └── .env.local.example
└── backend/
    ├── app/
    │   ├── main.py                 # FastAPI factory, CORS, lifespan, routers
    │   ├── core/{config.py, security.py, rate_limit.py, logging.py, cache.py}
    │   ├── routers/{scan.py, history.py, health.py}
    │   ├── services/{orchestrator.py, shodan_service.py, crtsh_service.py,
    │   │            certspotter_service.py, subfinder_service.py,
    │   │            whois_service.py, nvd_service.py, cpe_util.py, risk.py}
    │   ├── models/{target.py, scan.py, finding.py}  # SQLAlchemy 2.0
    │   ├── schemas/{scan.py, common.py}             # Pydantic v2
    │   └── db/{session.py, base.py}
    ├── alembic/
    ├── data/.gitkeep              # SQLite file lives here (gitignored)
    ├── requirements.txt
    └── .env.example
```

## 3. Frontend Design

- **Routing:** App Router groups `(auth)` public, `(dashboard)` protected. `middleware.ts` checks Better Auth session.
- **Data fetching:** Client components use SWR/poll every 2s on `GET /api/scan/{id}` until `completed|partial|failed`. Server components for history list (SSR via FastAPI `GET /history`).
- **UI:** Tailwind dark class default (`<html class="dark">`), shadcn `Card, Table, Badge, Skeleton, Tabs`. Charts lazy-loaded (`next/dynamic ssr:false`) to avoid hydration mismatch.
- **Validation:** `z.object({ target: z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$/i) })`, block `localhost, 10/8, 192.168/16, 172.16/12`.

## 4. Backend Design (FastAPI Async)

### 4.1 API Contract (v1)

```
POST /api/v1/scan            { target, force?:bool } → { scan_id, status }
GET  /api/v1/scan/{id}       → { scan_id, target, status, risk_score, results:{shodan,crtsh,whois}, errors[] }
GET  /api/v1/history?target=&page=&limit= → { items[], total }
GET  /api/v1/target/{t}/trend → { points: [{scan_id, created_at, risk_score}] }
GET  /health /ready
```

Pydantic example:

```python
class ScanRequest(BaseModel):
    target: str = Field(pattern=r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$")
    force: bool = False

class ScanResult(BaseModel):
    scan_id: UUID; target: str; status: Literal["pending","running","completed","partial","failed"]
    risk_score: int | None; results: dict; errors: list[SourceError]
```

### 4.1a Analysis API (v2, per-capability)

One endpoint per capability under `/api/v1/analysis`, deliberately *not* a combined "analyse this target" call: a module that fails must not take down the others, so there is no shared fan-out to fail.

```
POST /api/v1/analysis/headers     { url, force? }   → AnalysisResponse   (behind the SSRF guard)
POST /api/v1/analysis/redirects   { url, force? }   → AnalysisResponse   (behind the SSRF guard)
POST /api/v1/analysis/sitemap     { url, force? }   → AnalysisResponse   (behind the SSRF guard)
POST /api/v1/analysis/contacts    { url, force? }   → AnalysisResponse   (behind the SSRF guard)
POST /api/v1/analysis/dns         { target, force? }→ AnalysisResponse
POST /api/v1/analysis/tls         { target, force? }→ AnalysisResponse
POST /api/v1/analysis/exif        { data:base64, filename? } → AnalysisResponse
GET  /api/v1/analysis/phone/{number} → AnalysisResponse
GET  /api/v1/analysis/capabilities  → { always_available[], optional_sources{} }
```

Shared envelope:

```python
class AnalysisResponse(BaseModel):
    capability: str; target: str; source: str
    status: Literal["ok", "error"]
    data: dict[str, Any]
    errors: list[SourceError]        # policy/upstream failure → HTTP 200 + an entry here
    fetched_at: str
```

Two rules the router owns:

- **A policy or upstream failure is HTTP 200 with `errors[]`.** Only a caller mistake is 4xx. A blocked target must never look like a server error *and* must never look like "no findings" — the error text says what was refused.
- **Capabilities that cost no Shodan credit use `check_free_rate_limit`, not `check_rate_limit`.** The hourly scan quota is a billing decision about one shared paid key (see `PRODUCTION_RATE_LIMIT_CEILING`); aliasing them would burn money budget on free work and let a contact lookup exhaust a user's scan allowance. Separate quota + keyspace, shared sweep and memory ceiling.

`GET /capabilities` exists because several sources ship dark by design. It lets the UI say *why* a card is empty instead of leaving the user to guess whether they found something or mis-configured something.

### 4.1b SSRF guard (`app/core/ssrf.py`)

The existing `assert_target_allowed` / `assert_resolved_target_allowed` checks are a **string check plus one resolution of the name the user typed**. That is sufficient for a target we only ever look up in Shodan/crt.sh/WHOIS. It is *not* sufficient for any module that makes the backend **connect** to a target, because the connection follows a path the initial check never sees: a 302 to `169.254.169.254`, a 302 to `localhost:5432`, a public name that resolves to loopback *at connect time*, or `http://2130706433/` (which glibc's resolver reads as `127.0.0.1`).

`SafeFetcher` is the only sanctioned path for a target fetch, and it makes four guarantees:

1. Only `http`/`https`, and no userinfo in the URL (removes the `https://expected@evil/` ambiguity rather than picking one reading).
2. **Every** address the name resolves to is re-checked, and the request is then sent to a **pinned IP literal** with the original `Host` header and SNI restored. Pinning is what closes the rebinding gap — the socket cannot end up somewhere the check did not approve, because the address validated is the address dialled. `validate_host(host, port)` is the public seam for anything that opens its own socket (the TLS handshake uses it).
3. Redirects are followed **manually**, one hop at a time, each re-validated, capped at `SCAN_TIMEOUT_*`-style `FETCH_MAX_REDIRECTS` (10). httpx never gets `follow_redirects=True` for a target fetch: a redirect it follows alone is a redirect nobody validated.
4. Response bytes are capped while streaming, and the client is built with `trust_env=False` — with the default, an `HTTP_PROXY` in the environment would silently move the connection off the pinned IP and undo all of the above.

Two source classes, worth keeping distinct: **passive** (query a third-party API about a target — Shodan, crt.sh, DNS) and **active but read-only** (connect to the target ourselves). Only the second goes through the guard. No module ever probes a port or interacts with a target: `host_enrichment_service` derives open ports purely from Shodan's passive records, and a test asserts it imports nothing networking-related.

### 4.1c Rate-limit exemption (testing only)

`rate_limit._is_exempt` lets an operator exempt named subjects from both buckets, so load/QA work is not stopped by our own 429 before it reaches the provider limits that actually govern it. Two properties make it safe:

- **It is keyed on the subject, and the only subject reachable without a secret is `user:service`.** `require_user()` returns `user:<db-id>` for a session cookie and `user:service` *only* for `Authorization: Bearer <SERVICE_TOKEN>` compared with `hmac.compare_digest`. Exempting the service identity therefore exempts something that needs a secret which never reaches a browser; a stolen cookie or an XSS yields `user:<db-id>` and stays capped. Exempting a browser subject would delete the per-user quota — the control whose whole purpose is to stop one compromised account becoming a cost vector on the paid Shodan key.
- **An exempt call is not charged, not merely uncapped.** It creates no bucket and skips `_count_instance`, so a load test cannot drain `RATE_LIMIT_DAILY_TOTAL` and hand the next real user a 429 for the test's spending.

Matching is exact (never a prefix, so `user:service` cannot exempt `user:service-admin`), the setting is read per call so flipping it takes effect without a restart, and every exempt call logs at WARNING with the subject name so a setting left on in production is visible in the logs. Default is empty. See WORKFLOW.md §3.1.

**It does not raise provider limits.** OTX (100 req/hour per IP) and Leak-Lookup (10 req/day per key) are bounded by the deployment's single egress IP and single key, so they remain shared across all users no matter what this setting says.

### 4.2 Orchestrator (core logic)

`services/orchestrator.py`:

```python
async def run_scan(target, force=False):
    scan_id = new_uuid(); persist(status="running")
    if not force: check sqlite cache per source
    sh, ct, wh = await asyncio.gather(
        with_timeout(shodan_service.lookup(target), 12),
        with_timeout(crtsh_service.lookup(target), 15),
        with_timeout(whois_service.lookup(target), 10),
        return_exceptions=True)
    normalize → risk.py score → persist scans + findings (JSONB snapshot, immutable)
    return aggregated
```

- Timeout per source, `return_exceptions=True`, exception → `{ source, message }` in `errors[]`.
- httpx.AsyncClient shared, connection pool, UA `osint-dashboard/1.0`, 2 retries with backoff for 429/5xx (crt.sh flaky).
- Never trust external JSON: Pydantic parse + `.get()` defaults + truncate banners to 2KB.

### 4.3 Services Detail
- **Shodan:** `https://api.shodan.io/shodan/host/{ip}?key=` — if target is domain, resolve DNS first, then re-check the resolved address. Map `ports, data[{port, transport, product, version, banner, cpes}], vulns, cpes, isp, asn, city/country`. Only exact `cpe:2.3:` identifiers are kept (keyword/product matching rejected). On HTTP 403 or 404, fall back to Shodan's public, keyless InternetDB endpoint for ports, vulnerability identifiers, and CPEs; label fallback data and treat its 404 as no indexed result.
- **NVD CVE enrichment:** after Shodan succeeds, `nvd_service.enrich_cpes(shodan.cpes)` queries `GET https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=<exact CPE>` (never `isVulnerable` — verified unstable 2026-10-05).
  - Client-side filter keeps only CVEs whose `configurations[].nodes[].cpeMatch[]` has `vulnerable=true` matching the observed CPE (exact criteria or provable version-range containment).
  - Result contract: `results.nvd = { source, status: found|no_match|insufficient_evidence|unavailable, checked_cpes[], cves[{id, description, cvss, severity, published, references[], evidence_cpe}], truncated, errors[], note }`.
  - Caps & limits: `NVD_MAX_CPES=5`, `NVD_CVES_PER_CPE=20`, page `NVD_PAGE_SIZE=100`; sequential requests with 6s delay (0.7s with `NVD_API_KEY`); per-CPE cache 7d; timeout `SCAN_TIMEOUT_NVD=12`.
  - Errors: NVD 404 with empty body = `no_match`; timeouts/429/5xx = `unavailable` (+ `errors[]`, scan stays `partial`).
  - Risk scoring unions `shodan.vulns` + `nvd.cves` and flags `breakdown.vulns_incomplete` when coverage is missing — missing data never renders as `0`.

- **CVE validity tiers (Phase 17, 2026-10-05):** `nvd_service.build_cve_rows(shodan.vulns, nvd, client)` cross-checks each Shodan-reported CVE ID against NVD (`GET ...?cveId=<id>`, cap `NVD_CVE_ID_LOOKUP_CAP=20`/scan, per-ID cache 7d keyed `nvd:cve:<id>`).
  - **Keyword fallback (v2):** when the CPE path yields nothing usable — `no_match`, `insufficient_evidence`, `unavailable`, or a missing block — `nvd_service.search_keywords` runs `GET .../cves/2.0?keywordSearch=<term>` with terms derived from detected products, under a new status **`keyword_derived`**. It is a strict gap-filler: it never replaces a `found` result. `keywordSearch` matches CVE **descriptions**, so a hit means "a CVE whose text mentions nginx exists", which says nothing about this host. Three locks keep that from leaking:
    - Every emitted CVE carries `keyword_derived: true`, and `build_cve_rows` checks both that marker **and** the result-level status/method, so a lost marker still cannot produce `verified`. `evidence_cpe` is forced to `None` and the row is sourced as `NVD (keyword)`.
    - `risk.score` skips keyword rows in **both** the tiered (`cve_rows`) and legacy (`cves`) paths. Without this a single CRITICAL description-mention would set `vulns = 1.0` and take a target to 100. Leads are counted as `breakdown["keyword_leads"]` instead, and `keyword_derived` joins `nvd_uncertain` so the card never reads as "checked, fine".
    - The UI renders an explicit "Keyword leads only" badge plus an `NVD (keyword)` source cell, and the note is reserved before truncation so no cap can drop the caveat.
  - Capped at `NVD_MAX_KEYWORDS=3` terms and `NVD_CVES_PER_KEYWORD=10` per term, because every term costs a rate-limited NVD request (6s apart, 0.7s with a key). Failures are deliberately **not** cached — caching a single 429 for the 7-day CPE TTL would guarantee a week of no keyword data after one rate-limit blip.
  - Row contract: `results.nvd.cve_rows[] = {id, tier, source, severity, cvss, evidence_cpe, vuln_status, description, url, keyword_derived?}`.
  - Tiers: `verified` (NVD CPE-exact match, or ID cross-checked with non-rejected status) · `unverified` (ID valid-looking but not confirmed: NVD down, cap hit, or CPE mismatch) · `rejected` (NVD `vulnStatus` Rejected/Disputed — shown in UI, excluded from scoring).
  - NVD total failure degrades every Shodan ID to `unverified`, never hidden. `risk.score` counts only `verified`+`unverified` IDs, reports `breakdown.rejected_cves`, and keeps `vulns_incomplete`.
  - CPE 2.2 URIs (`cpe:/a:vendor:...`) are normalized to CPE 2.3 by `services/cpe_util.py:normalize_cpe` (deterministic 1-to-1, missing segments → `*`), accepted by both Shodan CPE collection and NVD validation — this unblocks InternetDB hosts that only emit `cpe:/...`.
  - UI: `VulnerabilitiesCard` renders columns CVE (NVD link) / Tier badge / Severity / CVSS / Evidence CPE / Source, plus a tier legend; `getCveEvidence` excludes `rejected` IDs from the dashboard count. No new env vars; fallback chain (crt.sh → Cert Spotter → Subfinder) unchanged.
- **Certificate Transparency:** query crt.sh first; on failure use the public Cert Spotter API, then the bounded Subfinder CLI. Successful fallback data is cached and identifies its provider; report an error only when all passive certificate sources fail. Results deduplicate and cap names at 500, retaining `{ subdomain, issuer, not_before/after }`.

- **Passive host enrichment (v2):** `host_enrichment_service.enrich(shodan_payload)` — a **synchronous, pure derivation** with no network call and no second paid key. Diffed against the existing Shodan service first, as the TODO required: Shodan already pays for all fifteen fields (IP, ASN, org, ISP, geo, lat/long, timezone, network, domain, OS, hostnames, ports), but the normalisation boundary was dropping 11 of them. This module passes them through in a UI-ready shape rather than adding Censys/MaxMind/ipinfo. Open ports are read **only** from Shodan's passive records; `AGENTS.md §7` excludes active scanning, and a test asserts the module imports nothing networking-related so it cannot drift into a scanner. Safe to compute on a cache hit (no I/O), which is why it sits after the fan-out in `gather_results`.

- **DNS records (v2):** `dns_service.lookup(target)` queries A, AAAA, MX, NS, TXT, CNAME, SOA through `dns.asyncresolver` (asyncio-native; the **sync** resolver is never used on the event loop). All seven types are queried concurrently against one resolver, so the worst case is one timeout rather than seven. **Per-type isolation is the core behaviour**: one type failing records an entry in `errors[]` and the other six still return. TXT is truncated to 512 chars (SPF/DKIM blobs run to several KB); record counts cap at 50/type; NXDOMAIN is reported distinctly from an empty answer, because they lead to different conclusions.

- **TLS certificate detail (v2):** `tls_service.lookup(target)` performs a live handshake — the only module that opens a raw socket, and the first to use `validate_host()` instead of `SafeFetcher`. Client-side verification is deliberately **disabled** (`check_hostname=False`, `CERT_NONE`) because an OSINT scan must *report* an expired, self-signed or mismatched certificate rather than fail on it; rejecting it client-side would hide the finding the module exists to surface. The peer DER is parsed with `cryptography` (the stdlib refuses to decode it when verification is off; hand-rolling a DER walk would be worse). Note the overlap with CT: crt.sh and Cert Spotter return the same names and issuance windows, but they return *logged issuance history*, deduped per name — so their `not_after` can be a stale entry rather than the live certificate. Render validity once, from this source.

- **Cookies & response headers (v2):** `http_headers_service.lookup(url)` reads one response behind the guard. `Set-Cookie` values are **credentials and never emitted** — only the cookie name and its attributes. The `headers` list carries `set-cookie` rows as `[redacted]` too, because echoing `name=VALUE` there would leak the same secret through a second door. `authorization` / `proxy-authorization` are redacted for the same reason. Control characters and surrounding quotes are stripped from every emitted value (httpx does **not** sanitise header values, so an ESC/newline really can reach the renderer); markup is preserved verbatim and rendered as plain text (§6).

- **Redirect chain trace (v2):** `redirect_service.lookup(url)` reports the chain hop by hop with the status per hop, from the `hops` the guard already recorded — it does **not** re-implement resolution or run its own redirect follower. Flags an https→http transition as `downgrades_to_http` (an all-plaintext chain is *not* a downgrade, since it never left http), a repeated URL as `loop_detected`, and a host change. The guard's hop cap surfaces as `truncated: true` with an honest empty chain, never as a 500.

- **Sitemap + links (v2):** `sitemap_service.lookup(url)` fetches `{origin}/sitemap.xml` under the guard and classifies URLs internal/external against the requested host. **XML hardening is the point:** ElementTree resolves no external entities (it errors on undefined ones) but *does* expand internal ones, and expat's amplification ceiling is a threshold rather than a guarantee. So a `<!DOCTYPE`/`<!ENTITY` in the prolog is rejected by string scan before any parser sees the bytes. A `<sitemapindex>` is reported honestly and its children are **not** crawled — a large split site will show `found: true` with an empty list, which the UI must not present as "no pages".

- **Contact extraction (v2):** `contact_service.lookup(url)` regexes page source for emails (`mailto:` first) and phone-shaped strings. This is an **address-harvesting primitive**, so: a hard cap of **100 matches total** across both lists (one shared counter, so the limit cannot be gamed by page shape), bidi overrides and zero-widths stripped (a bidi override could visually reorder a number), no verification or enrichment of any kind, and a `contact` rate-limit scope of its own.

- **EXIF (v2):** `exif_service.extract(bytes)` parses image metadata **in-process with Pillow** rather than shelling out to `exiftool` — no new system binary, no shell-out over untrusted bytes, and no temp file (exiftool wants a path, so the usual pattern spills uploads to disk). Trade-off stated in the docstring: Pillow covers EXIF in JPEG/TIFF/PNG/WebP and does not decode maker notes, where exiftool covers far more containers. Type is decided from **content**, never the extension or `Content-Type`. Render-only by default: GPS and device serials are outside §7's audit minimum, so the default reports `has_gps: true` with the coordinates **withheld** — presence is truthful, the value is opt-in — and the withheld values are redacted inside `tags` too, or the dedicated fields would be bypassable.

- **Phone validation (v2):** `phone_lookup_service.lookup(number)` is **offline and synchronous** (`libphonenumber` is a local library; wrapping it in async would be cargo-culting). It ships honestly as **format-and-country validation only** — carrier and line-type lookup needs a paid data source, so it is omitted entirely rather than stubbed behind a config knob. `is_valid_number()` means "well-formed for a country", never "this number exists"; the `note` says so on every result. Its own endpoint and rate-limit bucket, so phone data never rides the domain-scan path.

- **Threat & incident history (v2, fallback):** when official CVE data comes back **empty**, `_threat_history_fallback` runs the breach/defacement sources so the dashboard has something honest to show instead of a blank vulnerability tab. It reuses the `_certificate_fallback` shape (sequential, per-source timeout, aggregated error) rather than adding a parallel mechanism, and each source is independent — one being down, unconfigured or empty never suppresses the others. Three rules make it safe to ship:
  - **It states why it ran.** `trigger_reason` travels with the payload, so the UI says "no official CVEs; showing breach history instead" rather than silently substituting different evidence for what the user asked about.
  - **A populated CVE list disables it entirely.** Substituting breach history for real CVE data would hide the data the user actually asked for.
  - **A total source failure disables it too.** When Shodan, crt.sh and WHOIS *all* failed we learned nothing about the target, so "no CVE data" means "we could not check", not "there is none" — dressing an outage up as a result would be the dishonest outcome.

  Cache-aware like every other job: never spends an upstream request on a pure cache hit unless `force=true`, which is why the chain only runs when the scan itself did work.

- **AlienVault OTX (`otx_service`)** — the replacement that actually carries detail, and the reason the history card is no longer a list of names with empty columns. One request to `/indicators/{slug}/{value}/general` returns pulse count, the community **pulse** list, `validation[]` and `false_positive[]`. **`OTX_API_KEY` is optional**: the `/general` lookup works fully anonymously at a measured **100 requests/hour per IP** (there are no rate-limit headers, so the budget is client-side, which is why it is the first source in the chain and cached).
  - **`reputation` is deliberately not surfaced.** OTX returns an always-`0` integer inside `/general` for IPs and `null` from the `/reputation` section; the docs define no scale and no meaning for either. A `0` could be the clamped floor of a negative scale or a default for "not scored", and those are very different claims. The result is built on `pulse_info.count` plus OTX's own `validation[]`/`false_positive[]` words instead.
  - **TLP amber/red pulses are withheld.** By LevelBlue's own SDK rule those are non-public, so the name and description are dropped and `tlp_restricted: true` is set — counted, dated, but not shown. The label is never invented: an absent or unrecognised `TLP` becomes `""`, never a guessed value.
  - `404` is **not** the not-found signal — an unknown indicator returns `200` with `pulse_info.count == 0`. A missing `pulse_info` is `unavailable`; zero pulses is `ok`. The two must never look alike. `base_indicator: {}` maps to `in_base_set: false`, which is explicitly *not* benign.
  - OTX's own IP guard is weaker and differently shaped than ours (it 400s on loopback/IPv4-private but answers for multicast, broadcast, and IPv6 ULA), so `app/core/security.py` stays the pre-flight control and an OTX 400 never becomes a 500.

- **VirusTotal is intentionally not integrated.** Its free Public API is explicitly barred from commercial products — stated three times in VT's own docs with "immediate permanent ban" as the penalty (https://virustotal.readme.io/reference/getting-started) — and querying an indicator publishes it to the VT community dataset. This is a licensing gate, not a rate-limit gate. `VIRUSTOTAL_API_KEY` remains a **user-supplied (BYOK)** setting: the operator supplies their own key and accepts VT's terms for their own account; we ship no key of our own.

- **Censys is deliberately not integrated** — a separate paid key, and Shodan already covers exposed services, infrastructure and banners for this product.

- **History sources — PII discipline.** The credential-leak source returns **counts and aggregate metadata only**: per-source breach name and a match **count**, never an email address, account list, password or hash. Rows are counted without their contents ever being read, and the error path is scrubbed independently, with a test that plants a realistic leaked pair and asserts neither the address nor the hash appears anywhere in the output.

- **Threat-intel sources, replacing the defacement mirror.** Zone-H was dropped: it has no API (`api.zone-h.org` is NXDOMAIN, the archive is behind an anti-scraping gate), its general RSS was **withdrawn by the operator** for abuse, and the surviving special RSS carries no banner text, has no per-domain query, and is **CC BY-NC-ND** — non-commercial, no-derivatives, which cannot back this dashboard. The gap it left (threat history when CVE data is empty) is filled by two sources with real APIs:
  - **`virustotal_service`** — domain / IP / URL / file-hash reputation. The verdict is `last_analysis_stats` (`malicious`/`suspicious`/`undetected`/`harmless`/`timeout`/…), reduced to a single explicit `verdict` plus the **raw counts kept alongside it**: collapsing 3 engines of `undetected` into "0 malicious" would read as clean when it means the opposite. `popular_threat_classification` supplies a suggested threat label, which is a *suggestion from the community*, not a verdict, and is labelled as such.
  - **`otx_service`** — AlienVault OTX indicator reputation and the community **pulse** list. The honesty trap here is OTX's `reputation: null`, which means **no data**, not zero; it is passed through as `null` with a note rather than coerced to `0`, because "not known to be malicious" and "known to have score 0" are different claims.
  - **Censys is deliberately not added.** It is a separate paid source, and Shodan already covers exposed services, infrastructure and banners for this product — adding a second paid key for the same fields is what the host-enrichment diff avoided.

  Remaining sources keep their documented behaviour: `leaklookup` needs a key (free tier 10 queries/day) and its ToS restricts queries to targets the operator is authorised to search; `urlscan` search works keyless but its free tier caps history at **30 days / 100 results per page** (verified against the live API), so nothing may promise "full history". A missing key yields `status: "not_configured"`, which the UI renders as *switched off*, deliberately distinct from *found nothing*.
- **WHOIS:** `python-whois` in `asyncio.to_thread` (blocking) — map registrar, creation/expiry, name_servers, emails (may be None due to GDPR — show "redacted").

## 5. Data Model (PostgreSQL)

```sql
targets(id UUID PK, value TEXT UNIQUE, type TEXT, first_seen TIMESTAMPTZ, last_scan_at TIMESTAMPTZ);
scans(id UUID PK, target_id FK, user_id TEXT, status TEXT, risk_score INT,
      result_snapshot JSONB NOT NULL, errors JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ);
findings(id UUID PK, scan_id FK, source TEXT, kind TEXT, severity TEXT, data JSONB);
-- Better Auth manages users table separately.
CREATE INDEX ON scans(target_id, created_at DESC);
```

SQLite cache (separate file, not migrated):

```sql
CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, payload TEXT, expires_at INTEGER);
-- key = 'shodan:1.1.1.1', payload = raw JSON string
```

## 6. Auth & Security

- Better Auth (OAuth + email/password) issues session cookie (httpOnly, Secure, SameSite=Lax).
- Next `middleware.ts` guards `/dashboard/*` and fails closed (503) when `BETTER_AUTH_URL` is non-localhost plain http in production. Next proxy `app/api/scan/[...path]/route.ts` reads session, forwards it (cookie / `Authorization` header) to FastAPI.
- FastAPI `core/security.py: require_user()` verifies the Better Auth session via the shared secret + shared PostgreSQL session store; rejects missing/invalid with 401. Enforces per-user rate limit (in-memory fixed window; see limitation below).
- Machine-to-machine access uses a dedicated `SERVICE_TOKEN` env (`Authorization: Bearer <token>` → `user:service`); the session-signing `BETTER_AUTH_SECRET` is never accepted as an API key.
- **Known limitation — rate limiting:** `app/core/rate_limit.py` is a per-process in-memory fixed window. Counters reset on restart and are not shared across uvicorn workers, so every bound below multiplies with worker count. Run a single worker in production (the default) or move the counter to Redis/Postgres before scaling out (v2).
  - Buckets are per-user, so the quota is also per account: N accounts mean N × `RATE_LIMIT_PER_HOUR` scans per hour against one Shodan key. The per-account window cannot express a budget for the shared key, which is what `RATE_LIMIT_DAILY_TOTAL` exists for — an opt-in instance-wide ceiling on *admitted* scans per rolling 24h, counted in hourly buckets so the counter itself stays bounded. Disabled by default (0), because the right number is a billing decision.
  - Production refuses to boot unless `RATE_LIMIT_PER_HOUR` is set in the process environment and is at most `PRODUCTION_RATE_LIMIT_CEILING` (5). An unset quota is a silent budget decision on a paid API key. The constant lives in code so raising it is a reviewable change rather than a quiet env edit.
  - `RATE_LIMIT_MAX_KEYS` (default 10000) is the absolute ceiling on live bucket keys. The periodic sweep only bounds growth relative to arrival rate — "keys touched in the last ~65 minutes" — not absolute size. At the cap, an *unknown* key is refused with 429 until the next sweep. Fail closed on purpose: LRU eviction would reset a live user's remaining quota, so anyone able to mint keys could mint free scans. The cost is that a signup burst can lock out new users for up to one sweep interval; existing accounts are never affected.
  - **Account-age quota weighting was evaluated and rejected.** The limiter receives the opaque string `user:<better-auth-user-id>` and has no DB session, so weighting a new account's quota by its age needs an awaitable query on the hot path of every scan, in a module that is currently synchronous and dependency-free — and it still fails open exactly when the DB is down. The instance daily cap covers the same blast-radius concern without the per-request cost.
- **Known limitation — CSP is report-only, so XSS enforcement is absent:** `frontend/next.config.mjs` sends `Content-Security-Policy-Report-Only`. The policy is telemetry; the browser does not block anything. Enforcement needs a nonce for Next's own inline hydration scripts (`self.__next_f`). Do not list CSP as an active control in a production risk register — the other headers it ships with (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) are enforced, the CSP itself is not.
- **Known limitation — every `SERVICE_TOKEN` shares one identity:** `app/core/security.py` returns `user:service` for any `Authorization: Bearer` value matching `SERVICE_TOKEN`. All machine-to-machine scans therefore land on one owner, one history row per target, and one rate-limit bucket. Acceptable while there is a single consumer; more than one consumer needs a per-token identity before it ships.
- **Target validation has two layers.** `assert_target_allowed` checks the literal string (catches `localhost`, RFC1918, link-local, IPv6 ranges); `assert_resolved_target_allowed` additionally resolves a hostname and re-checks the address it points at, so a public-looking name pointing at `127.0.0.1` or `169.254.169.254` is rejected. Resolution runs through `asyncio.to_thread` under a `wait_for` bound (`SCAN_TIMEOUT_SHODAN`) — `gethostbyname` blocks for as long as the resolver takes and would otherwise stall the whole worker (AGENTS.md §3).
- The resolved-IP check runs in `routers/scan.py`, **not** in a source service: the orchestrator folds every source exception into `errors[]` and still answers `200`, so an `HTTPException` raised inside a service can never reach the client. `shodan_service.lookup` keeps its own `assert_target_allowed(resolved_ip)` as the enforcement point that guarantees no request is sent upstream.
- It sits **after** `check_rate_limit` deliberately. It costs a DNS query, so placing it ahead of the limiter would hand out a free oracle for enumerating internal names; rate-limited callers only pay for it. The consequence is that a blocked target still consumes one rate-limit stamp.
- Hardening: CORS allowlist only `APP_URL`, `TrustedHost`, Pydantic input regex + block private ranges, ORM parametrized, no `eval`, banners rendered as text (no `dangerouslySetInnerHTML`), structlog without passwords/keys, `X-Request-ID` tracing.

## 7. Observability & Config

- `/health` (liveness, no DB), `/ready` (DB + SQLite ping).
- JSON logs: `{ request_id, user_id, target, source, latency_ms, status }`.
- Config via `pydantic-settings`, all secrets from env, `.env.example` committed, `.env` gitignored.
- Cache backend flag: `CACHE_BACKEND=sqlite|postgres` (`app/core/config.py`). `sqlite` = local file at `SQLITE_PATH`; `postgres` = `osint_cache` table via asyncpg (DSN derived from `DATABASE_URL`, `CREATE TABLE IF NOT EXISTS`, 2s timeout). Async entry points `cache_get_async`/`cache_set_async` in `app/core/cache.py` (orchestrator uses these; sync helpers kept for compat). Either backend failing never fails a scan — get returns `None`, set swallows.

## 8. Deployment

- Local: `docker compose up postgres` + `uvicorn` + `npm run dev` (see WORKFLOW.md).
- Prod minimal: Frontend on Vercel, FastAPI on Fly/Render (Docker), Postgres managed (Neon/Supabase). CORS + `APP_URL` updated. SQLite replaced by Postgres cache table or Redis in prod (env flag `CACHE_BACKEND=sqlite|postgres` — set `postgres` on hosts without a persistent volume; the table is auto-created, see §7).
- **Known limitation — migrations run in the container CMD:** `backend/Dockerfile` ends with `python -m alembic upgrade head && python -m uvicorn ...`. Correct for a single replica, but concurrent replicas race on the same DDL during a scale-out, and the release step in WORKFLOW.md §8.2 (step 2) runs the same migration independently. Keep one replica until migrations move out of the CMD into a dedicated release step.

## 9. Trade-offs & v2

- SQLAlchemy chosen over Prisma for single Python stack; Prisma viable if BFF moves to Node.
- Polling over WebSocket for simplicity; upgrade to SSE when scan >15s common.
- v2: scheduled monitoring, diff alerts, PDF export, org RBAC, Nuclei passive checks.
