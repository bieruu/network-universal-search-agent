# TODO — Network Universal Search Agent

> Work list. An item is ticked `[x]` the moment it is genuinely done and stays here ticked until a push sweeps it into [CHANGELOG.md](./CHANGELOG.md) — so a ticked item in this file is normal, not stale. Unticked items are open work.
> Refs: [PRD.md](./PRD.md) (what) · [ARCHITECTURE.md](./ARCHITECTURE.md) (how) · [WORKFLOW.md](./WORKFLOW.md) (commands) · [AGENTS.md](./AGENTS.md) §9 (sweep rules).

## Deploy readiness — tinggal eksekusi (2026-10-06)

> Target: **Vercel (frontend) + container (backend)**. Status: 🟡 code + config siap, belum deploy.
> Item P1–P3 (boot blockers, live CI, Vercel disclosure) sudah selesai → [CHANGELOG.md](./CHANGELOG.md) entri 2026-10-07. Security review pra-deploy publik (P1 + P2) ditutup di push yang sama → entri [CHANGELOG.md](./CHANGELOG.md) paling atas.

- [ ] Siapkan secrets provider: `SHODAN_API_KEY`, `BETTER_AUTH_SECRET` (≥32 char, nilai sama di FE dan BE), `SERVICE_TOKEN` bila ada consumer machine-to-machine. Tidak pernah masuk repo atau variabel `NEXT_PUBLIC_*`.
- [ ] Pilih DB managed (Neon/Supabase) dan endpoint **pooled**-nya, lalu set `sslmode=require` — lihat WORKFLOW.md §8.1.
- [ ] Jalankan runbook deploy WORKFLOW.md §8.2 sesuai urutannya: `alembic upgrade head` → `npm run auth:migrate` → set `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` / `CORS_ORIGINS` / `APP_URL` / `SIGNUP_ENABLED` → deploy backend dulu, baru frontend. `SIGNUP_ENABLED` wajib di-set: sign-up self-service tertutup default di production, jadi langkah verifikasi signup (§8.2 langkah 6) gagal tanpa itu — lihat WORKFLOW.md §8.3.
- [ ] Set branch protection di GitHub agar 3 job `ci.yml` (backend, frontend, secrets) jadi required check — tanpa ini CI hanya informatif.
- [ ] Verifikasi end-to-end di domain production: signup → scan domain publik → sign-out. Build sukses bukan bukti auth jalan di production.

## Residual dari security review 2026-10-07 (P1 ditutup, ini sisanya)

> P1 #1–#3, P2 #1–#4, dan residual #1 / #3 / #4 sudah selesai di push 2026-10-07 dan dipindahkan ke [CHANGELOG.md](./CHANGELOG.md) (AGENTS.md §9). Yang tersisa hanya residual #2 — tidak bisa ditutup dari dalam repo, jadi mitigasinya di Vercel adalah membiarkan sign-up tertutup atau allowlist.

- [ ] **Bucket Better Auth untuk `/sign-up` mungkin global di Vercel, bukan per-IP.** (Kesimpulan "mungkin" sudah terkonfirmasi — lihat isi item. Sisa pekerjaan yang belum selesai tercatat di akhir item.) ~~**Belum diverifikasi**~~ → **terverifikasi** terhadap `better-auth@1.7.7` terpasang: `getIPFromHeader` mengembalikan `null` untuk rantai >1 hop tanpa `trustedProxies` (`ip.mjs:190`), tidak ada fallback localhost di production (`:217-218`), `null` menjadi literal `no-trusted-ip` (`rate-limiter/index.mjs:236,248`), dan `/sign-up*` dibatasi 3 request/10 detik (`:305-312`). Satu bucket bersama, dua arah: penyalahgunaan self-limit **dan** user-DoS. Ditutup sebagian lewat `BETTER_AUTH_TRUSTED_PROXIES` (default kosong) dengan parser yang lebih ketat dari Better Auth — `0.0.0.0/0`, `::/0`, dan `0.0.0.0` ditolak karena membuat limiter mempercayai token kiri kiriman klien. **Sisa tidak tertutup:** di Vercel knob ini akan tetap kosong karena Vercel tidak mempublikasikan rentang edge ingress, jadi bucket bersama itu bertahan di sana. Reordering header tidak menolong (`x-real-ip` didokumentasikan identik dengan `x-forwarded-for`), dan `rateLimit.customRules` tidak bisa dipakai karena key dihitung *sebelum* rule di-resolve — hanya bisa mempersempit/memperlebar. Mitigasi nyata di Vercel: biarkan sign-up tertutup atau allowlist (WORKFLOW.md §8.3), sehingga bucket bersama tidak terjangkau publik. Butuh limiter di luar Better Auth → v2. Ditulis di WORKFLOW.md §8.5, dipin test `frontend/lib/auth-rate-limit.test.ts`.

## Backlog (v2 — do NOT start)

- [ ] Scheduled monitoring + diff alerts
- [ ] PDF/CSV export, webhooks
- [ ] Org RBAC, Redis cache, SSE instead of polling
