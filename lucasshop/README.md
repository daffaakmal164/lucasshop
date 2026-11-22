# Lucasshop - Website dan Aplikasi Bengkel Motor

Aplikasi bengkel dengan dua peran pengguna (Admin dan Kasir) dan website informasi untuk umum, mengikuti SRS v2.0 Kelompok 7. Data tersimpan di database SQLite (file `data/lucasshop.db`), foto di `data/uploads/`.

## Menjalankan
1. Pasang Node.js versi 18 atau lebih baru (https://nodejs.org).
2. Buka terminal di folder ini, lalu jalankan:
   npm install
   npm start
3. Buka http://localhost:3000

Lokal (non-produksi): akun awal admin / admin123 dan kasir / kasir123. Di produksi (NODE_ENV=production atau Railway) sandi awal diambil dari ADMIN_PASSWORD dan KASIR_PASSWORD; kalau kosong, dibuat acak dan dicetak sekali di log. Ganti lewat Panel Admin > Akun.
Node.js yang dibutuhkan: 22 atau lebih baru (syarat better-sqlite3 13).

## Pengaturan (variabel lingkungan)
- PORT: port server (default 3000)
- DATA_DIR: lokasi database dan foto (default ./data)
- HTTPS=1: aktifkan cookie Secure kalau situs dipakai lewat HTTPS
- TZ: zona waktu (default Asia/Jakarta)
- ADMIN_EMAIL: email untuk akun admin awal (dipakai fitur lupa kata sandi)
- BASE_URL: alamat website, dipakai di tautan reset, contoh https://lucasshop.com (default http://localhost:PORT)
- FONNTE_TOKEN: token Fonnte untuk kirim WhatsApp otomatis (opsional, lihat bagian WhatsApp)
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM: akun email pengirim

## Deploy ke Railway
Lihat DEPLOY-RAILWAY.md. Wajib: Volume (DATA_DIR), variabel ADMIN_PASSWORD dan KASIR_PASSWORD, satu replika saja.

## Dipakai di internet (VPS)
1. Sewa VPS (Ubuntu), pasang Node.js, salin folder ini, jalankan `npm install`.
2. Jalankan terus-menerus dengan pm2: `npm i -g pm2 && pm2 start server.js --name lucasshop && pm2 save`
3. Pasang Nginx atau Caddy di depannya untuk HTTPS (wajib, supaya kata sandi aman), lalu jalankan dengan HTTPS=1.

## Cadangan
Admin > Pengaturan > Unduh cadangan database. Atau salin folder `data/` secara berkala.

## Isi
- Website umum (tanpa login): Beranda, Product, Service, Booking Servis. Pengunjung tidak punya akun (SRS 1.4 dan 2.4). Booking online dari website nonaktif secara bawaan dan bisa diaktifkan admin di Pengaturan.
- Kasir: antrean servis, transaksi penjualan (stok otomatis berkurang), laporan.
- Admin: semua milik kasir ditambah dashboard, kelola produk dan layanan beserta foto, kelola akun, pengaturan isi website.
- Laporan (hanya Admin): harian atau bulanan, laporan keuangan, laporan servis beserta pemakaian sparepart, dan tombol cetak laporan.

## Lupa kata sandi lewat email
Pengguna membuka Masuk > Lupa kata sandi, memasukkan email, lalu menerima tautan reset yang berlaku 30 menit dan hanya bisa dipakai sekali.
Supaya email benar-benar terkirim, isi pengaturan SMTP. Contoh dengan Gmail (pakai "App Password", bukan sandi biasa):
  SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=emailkamu@gmail.com SMTP_PASS=app-password MAIL_FROM="Lucasshop <emailkamu@gmail.com>" BASE_URL=https://domainmu.com npm start
Kalau SMTP belum diisi, tautan reset hanya dicetak di layar server (terminal), jadi cocok untuk uji coba.
Akun admin dan kasir bawaan belum punya email: isi lewat Panel Admin > Akun > Ubah email (atau ADMIN_EMAIL untuk admin).

## Cetak nota
Di menu Kasir, isi "Uang diterima" untuk melihat kembalian, lalu klik "Bayar dan cetak nota". Nota berukuran kertas thermal 80 mm. Pilih printer thermal di dialog cetak browser.
Nota lama bisa dicetak ulang dari Laporan > Transaksi penjualan.

## Galeri foto produk
Admin > Produk: pilih beberapa foto sekaligus (maksimal 8 per produk). Klik Ubah pada produk untuk menghapus foto atau menjadikannya sampul. Di halaman Produk, pengunjung mengklik foto untuk membuka galeri.

## Nota servis
Menu Antrean > tombol Tagih pada baris pelanggan. Isi biaya servis (otomatis terisi harga layanan, bisa diubah), tambahkan sparepart yang dipakai (stok otomatis berkurang), isi uang diterima, lalu Bayar dan cetak nota. Status booking otomatis menjadi Selesai. Setiap booking hanya bisa ditagih satu kali, dan nota bisa dicetak ulang dari Antrean atau Laporan. Pendapatan servis tercatat di Laporan.

## Notifikasi WhatsApp saat motor selesai
- Manual (tanpa biaya, selalu tersedia): saat status booking Selesai, muncul tombol Kirim WA di Antrean. Klik untuk membuka WhatsApp dengan pesan yang sudah terisi, lalu tekan kirim.
- Otomatis: daftar di penyedia gateway Fonnte (https://fonnte.com), sambungkan nomor WhatsApp bengkel, lalu jalankan server dengan FONNTE_TOKEN=tokenmu. Pesan terkirim sendiri saat status menjadi Selesai atau saat tagihan dibayar, tepat satu kali per booking, dan muncul label "WA terkirim".
- Isi pesan bisa diubah di Admin > Pengaturan. Pakai {nama} {motor} {layanan} {jam}.
- Nomor yang diawali 0 atau 8 otomatis diubah ke format 62.
Catatan: gateway WhatsApp pihak ketiga bukan layanan resmi WhatsApp dan bisa berubah aturannya. Cek syarat dan tarif di penyedianya.

## Kesesuaian dengan dokumen perancangan
Alur servis mengikuti state machine: Menunggu, Dikerjakan, Selesai, Lunas (plus Batal dari Menunggu). Status tidak bisa dilompati, sparepart hanya bisa dicatat saat Dikerjakan (stok langsung berkurang), tagihan hanya bisa dibayar setelah Selesai, dan total dihitung otomatis dari tarif layanan ditambah sparepart.
Hak akses diperiksa di server: fitur Admin tidak bisa dibuka Kasir dan sebaliknya. Sesi berakhir otomatis setelah 30 menit tidak aktif (ubah dengan SESSION_IDLE_MIN). Cadangan database dibuat otomatis ke data/backups/.
Di luar daftar use case SRS: menu Penjualan (jual sparepart langsung di kasir), lupa kata sandi lewat email, notifikasi WhatsApp, dan galeri foto produk.
