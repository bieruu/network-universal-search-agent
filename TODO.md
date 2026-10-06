# TODO — Network Universal Search Agent

> Only actionable work lives here. Completed work → [CHANGELOG.md](./CHANGELOG.md).
> Refs: [PRD.md](./PRD.md) (what) · [ARCHITECTURE.md](./ARCHITECTURE.md) (how) · [WORKFLOW.md](./WORKFLOW.md) (commands).

## Open external actions

- [ ] Verify live OAuth callbacks on the deployed origin (Google + GitHub) — register per [WORKFLOW.md §5](./WORKFLOW.md#5-oauth-provider-setup); do not mark verified before a real callback succeeds.
- [ ] Maintainer decision: accept or replace `caniuse-lite` (CC-BY-4.0). Regenerate the inventory from `frontend/`: `npm sbom --sbom-format=cyclonedx --json`; record acceptance/attribution if kept, or pick and test a replacement before touching dependencies.
- [ ] CI decision: `.github/` stays git-ignored by owner request, so hosted GitHub Actions will not run. If wanted later: un-ignore `.github/workflows/ci.yml`, `git add` it, push, confirm jobs green on the **Actions** tab, then enable required status checks if repository policy requires them.
- [ ] Change the production database password; store it only in host/deploy secret configuration, never in the repository.

## Backlog (v2 — do NOT start)

- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
