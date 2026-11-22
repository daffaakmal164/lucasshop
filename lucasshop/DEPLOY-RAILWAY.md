# Checklist Deploy Railway (Lucasshop)

## A. Sebelum push ke GitHub
1. Pastikan file ini TIDAK ikut: `lucasshop.db`, `lucasshop.db-shm`, `lucasshop.db-wal`, `_ENV`, `.env`, `node_modules/`.
   Cek dengan: `git status` dan `git ls-files | grep -E "\.db|\.env"` (hasil harus kosong, kecuali `.env.example`).
2. Kalau file .db pernah ter-commit: `git rm --cached lucasshop.db*` lalu commit. Riwayat lama tetap menyimpannya; kalau repo publik, anggap sandi lama bocor dan ganti.
3. Struktur akhir: `server.js`, `package.json`, `package-lock.json`, `.node-version`, `railway.json`, `.gitignore`, `.env.example`, `public/index.html`.
4. Lokal: `npm install` lalu `npm start`, buka http://localhost:3000 dan http://localhost:3000/healthz. Commit `package-lock.json` yang dihasilkan.

## B. Buat service di Railway
1. railway.com > New Project > Deploy from GitHub repo > pilih repo.
2. Tab Settings > Networking > Generate Domain.
3. Tab Settings: pastikan jumlah replika = 1 (SQLite tidak boleh dipakai banyak instance).

## C. Volume (wajib, supaya data tidak hilang)
1. Klik kanan canvas > Add Volume > sambungkan ke service. Mount path: `/data`.
2. Tab Variables: `DATA_DIR=/data`.

## D. Variables
Isi di tab Variables (lihat `.env.example`):
- `NODE_ENV=production`
- `ADMIN_PASSWORD` dan `KASIR_PASSWORD` (sandi kuat, diisi SEBELUM deploy pertama)
- `TZ=Asia/Jakarta`
- Opsional: `ADMIN_EMAIL`, SMTP_*, `FONNTE_TOKEN`
- Jangan set `PORT` (diisi Railway). `BASE_URL` boleh kosong.

## E. Deploy dan verifikasi
1. Deploy. Di Deploy Logs harus muncul: `Lucasshop berjalan di port ... (data: /data)`.
2. Healthcheck `/healthz` harus hijau.
3. Buka domain: Beranda tampil, `/api/public` mengembalikan JSON.
4. Masuk sebagai admin, ganti sandi, tambah produk + foto.
5. Redeploy sekali, pastikan produk dan foto masih ada (bukti Volume bekerja).
6. Tes lupa kata sandi (kalau SMTP diisi) dan unduh cadangan dari Admin > Pengaturan.

## F. Kalau gagal
- Build error `better-sqlite3`/`node-gyp`: pastikan Node 22 (`.node-version`), lalu Redeploy dengan "clear build cache".
- `SQLITE_CANTOPEN`/`EACCES` di /data: tambahkan variabel `RAILWAY_RUN_UID=0`.
- Healthcheck timeout: lihat log, biasanya DATA_DIR salah atau crash saat start.
- Tidak bisa login terus: pastikan domain diakses lewat HTTPS.
