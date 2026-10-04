# Manual Setup dan Checklist Rilis

Dokumen ini merangkum setup lokal dan pekerjaan yang telah diverifikasi sampai 4 Oktober 2026, lalu memisahkan tindakan yang masih membutuhkan akses provider atau keputusan pemilik proyek. File environment lokal tidak dibaca atau disalin ke dokumen ini; jangan menempelkan secret ke chat, dokumentasi, atau Git.

## Setup lokal

### Prasyarat

- Windows PowerShell
- Node.js 20.6+ dan npm
- Python 3.11+
- Docker Desktop dengan Docker Compose
- PostgreSQL
- Shodan API key untuk hasil host
- Subfinder CLI pada `PATH` jika backend dijalankan di host; image backend membundel Subfinder v2.16.0

### Konfigurasi environment

Salin template lalu isi nilai lokal sendiri:

```powershell
Copy-Item frontend\.env.local.example frontend\.env.local
Copy-Item backend\.env.example backend\.env
```

Gunakan `BETTER_AUTH_SECRET` acak yang sama di frontend dan backend (minimal 32 karakter), database PostgreSQL yang sama, dan `SHODAN_API_KEY` di backend. Format URL database:

```text
Frontend DATABASE_URL: postgresql://<user>:<password>@<host>:5432/<database>
Backend DATABASE_URL:  postgresql+asyncpg://<user>:<password>@<host>:5432/<database>
```

Kredensial Google/GitHub hanya diperlukan jika provider tersebut akan digunakan. Jangan gunakan nilai contoh di deployment, jangan simpan secret dalam variabel `NEXT_PUBLIC_*`, dan jangan commit `frontend/.env.local` atau `backend/.env`.

### Jalankan layanan dan migrasi

```powershell
docker compose up -d postgres

cd frontend
npm install
npm run auth:migrate

cd ..\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Di terminal lain:

```powershell
cd frontend
npm run dev
```

Buat akun di `http://localhost:3000/sign-up`, masuk melalui `/sign-in`, lalu gunakan `/dashboard`. Browser mengirim request melalui proxy Next.js; jangan memanggil Shodan atau crt.sh langsung dari browser.

**Database lama:** backend sekarang tidak membuat tabel otomatis saat startup. Untuk database baru, jalankan `alembic upgrade head`. Schema lokal yang sebelumnya dibuat `create_all` telah diverifikasi dan dicatat pada initial Alembic revision. Pada database lain yang pernah dibuat dengan cara lama, periksa tabel `targets`, `scans`, dan `findings` terhadap revision sebelum menjalankan `alembic stamp head`; jangan stamp schema yang tidak dikenal. Alembic tidak mengelola tabel milik Better Auth di database bersama.

Initial revision ada di [backend/alembic/versions/f24f7204c14f_initial_application_schema.py](./backend/alembic/versions/f24f7204c14f_initial_application_schema.py). Downgrade revision awal menghapus tabel aplikasi; jangan jalankan rollback tersebut pada database berisi data tanpa backup dan persetujuan eksplisit.

## Yang telah dikerjakan dan diverifikasi

- Better Auth email/password terhubung ke PostgreSQL. Backend memvalidasi signature cookie dan session aktif; alur signup → protected scan → sign-out → penolakan session yang dicabut berhasil diuji live.
- Menambahkan fallback Subfinder terbatas saat crt.sh gagal, dengan validasi/deduplikasi hasil, batas 500 nama, timeout, dan batas output.
- Membuat initial Alembic revision. Migrasi schema baru dan `alembic check` berhasil; schema lokal lama diverifikasi sebelum di-stamp. Startup aplikasi tidak lagi mengubah schema.
- Memperbarui Next.js ke 15.5.27 dan Tailwind CSS ke 4.3.3.
- Menambahkan GitHub Actions di [.github/workflows/ci.yml](./.github/workflows/ci.yml) untuk PostgreSQL migration/drift, backend tests/lint/format, frontend lint/type/tests/build, dan npm audit.
- Membuat Docker image backend dan memverifikasi jalur startup migrasi + Uvicorn, endpoint `/health` dan `/ready`, serta Subfinder v2.16.0.
- Menguji persistensi named volume PostgreSQL dengan container dan marker terisolasi; layanan PostgreSQL proyek yang sedang dipakai tidak direstart.
- Clean-room: frontend `npm ci`, lint, 53 tes, TypeScript, audit 0 vulnerability, dan production build lulus tanpa file `.env`; backend Python 3.11 image menjalankan 49 tes, Ruff, Black, dan migrasi PostgreSQL baru.
- Gitleaks v8.24.3 memindai 42 commit dan source tree terkini. Tidak ada temuan. File `.env` lokal sengaja dikecualikan.
- Tampilan production diperiksa pada 390px dan 1440px tanpa horizontal overflow. Lighthouse lab run: mobile performance 0.96, LCP 2,589 ms, CLS 0.0515; desktop performance 1.00, LCP 560 ms, CLS 0.0055.

## Tindakan manual yang masih diperlukan

### 1. Uji callback OAuth Google dan GitHub

Callback lokal yang perlu didaftarkan pada konsol masing-masing provider:

- Google: `http://localhost:3000/api/auth/callback/google`
- GitHub: `http://localhost:3000/api/auth/callback/github`

Pastikan `BETTER_AUTH_URL` cocok persis dengan origin yang dipakai. Masukkan pasangan `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` dan/atau `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` di `frontend/.env.local`, mulai ulang frontend, lalu lakukan login melalui provider dan pastikan kembali ke aplikasi dengan session aktif. Untuk production, daftarkan callback dengan origin deployment yang tepat. Jangan menandai OAuth selesai sebelum callback nyata berhasil.

### 2. Putuskan lisensi dependency

SBOM frontend terbaru mengidentifikasi `caniuse-lite` dengan lisensi CC-BY-4.0. Pemilik proyek perlu meninjau syarat penggunaan/atribusi dan memutuskan untuk menerima dependency tersebut atau mengganti jalur dependency yang membawanya. Buat catatan persetujuan/atribusi sesuai kebijakan proyek; bila tidak diterima, tentukan dan uji pengganti sebelum mengubah dependency. Ini keputusan maintainer, bukan perubahan yang aman untuk diasumsikan.

Inventaris dapat dibuat ulang dari `frontend/`:

```powershell
npm sbom --sbom-format=cyclonedx --json
```

### 3. Periksa run CI hosted

Workflow sudah disiapkan dan perintah setaranya lulus lokal. Setelah branch didorong ke GitHub, buka tab **Actions**, pastikan job backend dan frontend hijau, lalu aktifkan required status checks pada branch protection bila kebijakan repository mengharuskannya. Workflow memakai nilai placeholder CI, bukan secret deployment.

## Perintah pemeriksaan ulang

Frontend, dari `frontend/`:

```powershell
npm run lint
npm test
npm run tsc
npm run build
npm audit
```

Backend, dari `backend/` dengan virtual environment aktif:

```powershell
alembic upgrade head
alembic check
pytest -q
ruff check .
black --check .
```

Lihat [WORKFLOW.md](./WORKFLOW.md) untuk panduan operasi dan deployment, serta [TODO.md](./TODO.md) untuk status backlog. Fitur v2 di bagian backlog sengaja belum dimulai.
