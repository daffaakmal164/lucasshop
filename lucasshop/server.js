process.env.TZ = process.env.TZ || 'Asia/Jakarta';
const nodemailer = require('nodemailer'), express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const DATA = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), UP = path.join(DATA, 'uploads'), BK = path.join(DATA, 'backups');
if (PROD && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) console.warn('PERINGATAN: DATA_DIR/Volume belum diatur. Database akan HILANG setiap redeploy. Pasang Railway Volume dan set DATA_DIR.');
fs.mkdirSync(UP, { recursive: true }); fs.mkdirSync(BK, { recursive: true });
const db = new Database(path.join(DATA, 'lucasshop.db'));
db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, name TEXT, role TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT, price INTEGER, stock INTEGER, photo TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT, info TEXT DEFAULT '', price INTEGER, photo TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, code TEXT, name TEXT, phone TEXT, address TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS vehicles(id INTEGER PRIMARY KEY, customer_id INTEGER, plate TEXT, brand TEXT DEFAULT '', type TEXT, year INTEGER);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, date TEXT, time TEXT, no INTEGER, name TEXT, wa TEXT, motor TEXT, service_id INTEGER, note TEXT DEFAULT '', status TEXT DEFAULT 'Menunggu', user_id INTEGER, created INTEGER);
CREATE INDEX IF NOT EXISTS bk_date ON bookings(date);
CREATE TABLE IF NOT EXISTS service_parts(id INTEGER PRIMARY KEY, booking_id INTEGER, product_id INTEGER, name TEXT, price INTEGER, qty INTEGER);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, date TEXT, total INTEGER, user_id INTEGER, created INTEGER);
CREATE INDEX IF NOT EXISTS sl_date ON sales(date);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER, name TEXT, price INTEGER, qty INTEGER);
CREATE TABLE IF NOT EXISTS visits(date TEXT PRIMARY KEY, count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS product_photos(id INTEGER PRIMARY KEY, product_id INTEGER, path TEXT, pos INTEGER);
CREATE INDEX IF NOT EXISTS pp_prod ON product_photos(product_id);
CREATE TABLE IF NOT EXISTS reset_tokens(token_hash TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
const addCol = (t, c, def) => { if (!hasCol(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('users', 'email', 'TEXT'); addCol('users', 'active', 'INTEGER DEFAULT 1');
addCol('sessions', 'last', 'INTEGER');
addCol('products', 'code', 'TEXT'); addCol('services', 'code', 'TEXT');
addCol('sales', 'paid', 'INTEGER'); addCol('sales', 'booking_id', 'INTEGER'); addCol('sales', 'printed_at', 'INTEGER');
for (const [c, d] of [['wa_sent', 'INTEGER DEFAULT 0'], ['reg_no', 'TEXT'], ['customer_id', 'INTEGER'], ['vehicle_id', 'INTEGER'], ['svc_price', 'INTEGER'], ['mechanic', "TEXT DEFAULT ''"], ['spk_no', 'TEXT'], ['started_at', 'INTEGER'], ['finished_at', 'INTEGER'], ['source', "TEXT DEFAULT 'online'"]]) addCol('bookings', c, d);
db.exec("UPDATE users SET active=1 WHERE active IS NULL; UPDATE sessions SET last=created WHERE last IS NULL;");
db.exec("UPDATE products SET code='PRT-'||substr('000'||id,-3) WHERE code IS NULL OR code=''; UPDATE services SET code='LYN-'||substr('000'||id,-3) WHERE code IS NULL OR code='';");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_email ON users(email); CREATE UNIQUE INDEX IF NOT EXISTS ux_prod_code ON products(code); CREATE UNIQUE INDEX IF NOT EXISTS ux_svc_code ON services(code); CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_code ON customers(code); CREATE UNIQUE INDEX IF NOT EXISTS ux_sale_booking ON sales(booking_id);');
db.prepare("SELECT id,photo FROM products WHERE photo!=''").all().forEach(p => {
  if (!db.prepare('SELECT 1 FROM product_photos WHERE product_id=?').get(p.id)) { db.prepare('INSERT INTO product_photos(product_id,path,pos) VALUES(?,?,0)').run(p.id, p.photo); db.prepare("UPDATE products SET photo='' WHERE id=?").run(p.id); }
});

const pad = n => String(n).padStart(2, '0');
const ymd = t => { const x = new Date(t); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const today = () => ymd(Date.now()), ago = n => ymd(Date.now() - n * 864e5);
const hash = p => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const verify = (p, h) => { const [s, k] = h.split(':'), a = crypto.scryptSync(p, s, 64), b = Buffer.from(k, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const E = (m, s = 400) => Object.assign(new Error(m), { status: s });
const phone = v => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d; return d; };
const CFG0 = { alamat: 'Jl. Laksda Yos Sudarso - Sunter 1 Jakarta 14350, Indonesia', wa: '0838-3336-3504', email: 'customercare@lucasshop-center.com', jam: '[JAM BUKA]', hero: 'SPAREPART LENGKAP UNTUK MOTORMU', banner: 'SERVIS BERKALA: OLI + FILTER + BUSI', bannerSub: 'HANYA Rp 250.000', bookingOnline: '0', waDone: 'Halo {nama}, motor {motor} ({layanan}) sudah selesai dikerjakan di Lucasshop dan siap diambil. Jam buka: {jam}. Terima kasih.' };

function newCustomerRow(name, ph, address) {
  const id = db.prepare('INSERT INTO customers(name,phone,address) VALUES(?,?,?)').run(name, ph, address || '').lastInsertRowid;
  db.prepare('UPDATE customers SET code=? WHERE id=?').run('PLG-' + String(id).padStart(3, '0'), id); return id;
}
db.prepare("UPDATE bookings SET svc_price=(SELECT price FROM services WHERE id=bookings.service_id) WHERE svc_price IS NULL").run();
db.exec("UPDATE bookings SET reg_no='REG-'||replace(date,'-','')||'-'||substr('0'||no,-2) WHERE reg_no IS NULL; UPDATE bookings SET status='Lunas' WHERE id IN (SELECT booking_id FROM sales WHERE booking_id IS NOT NULL);");
db.prepare('SELECT id,name,wa,motor FROM bookings WHERE customer_id IS NULL').all().forEach(b => {
  const ph = phone(b.wa); let c = db.prepare('SELECT id FROM customers WHERE phone=?').get(ph);
  const cid = c ? c.id : newCustomerRow(b.name, ph, '');
  const vid = db.prepare("INSERT INTO vehicles(customer_id,plate,brand,type,year) VALUES(?,NULL,'',?,NULL)").run(cid, b.motor || '-').lastInsertRowid;
  db.prepare('UPDATE bookings SET customer_id=?,vehicle_id=? WHERE id=?').run(cid, vid, b.id);
});

if (!db.prepare('SELECT 1 FROM users').get()) {
  const rnd = () => crypto.randomBytes(9).toString('base64url');
  const adminPw = process.env.ADMIN_PASSWORD || (PROD ? rnd() : 'admin123'), kasirPw = process.env.KASIR_PASSWORD || (PROD ? rnd() : 'kasir123');
  const u = db.prepare('INSERT INTO users(username,name,role,hash) VALUES(?,?,?,?)');
  u.run('admin', 'Admin', 'admin', hash(adminPw));
  u.run('kasir', 'Kasir', 'kasir', hash(kasirPw));
  const p = db.prepare('INSERT INTO products(code,name,price,stock) VALUES(?,?,?,?)');
  [['Oli Mesin', 55000, 20], ['Kampas Rem', 45000, 15], ['Ban Motor', 280000, 8], ['Aki Motor', 320000, 5], ['Busi', 25000, 30], ['Rantai dan Gir', 180000, 6]].forEach((x, i) => p.run('PRT-' + String(i + 1).padStart(3, '0'), x[0], x[1], x[2]));
  const s = db.prepare('INSERT INTO services(code,name,info,price) VALUES(?,?,?,?)');
  [['Servis Rutin', 'Cek menyeluruh mesin, rem, rantai, dan kelistrikan.', 75000], ['Ganti Oli', 'Ganti oli mesin dan cek filter oli.', 30000], ['Tune Up', 'Setel karburator atau injeksi, busi, dan filter udara.', 100000], ['Servis Rem', 'Kampas rem, minyak rem, dan cakram.', 60000], ['Kelistrikan', 'Aki, lampu, kiprok, dan kabel body.', 80000], ['Ganti Ban', 'Ganti ban dan ban dalam, balancing, tambal.', 40000]].forEach((x, i) => s.run('LYN-' + String(i + 1).padStart(3, '0'), x[0], x[1], x[2]));
  console.log('\nAkun awal dibuat. admin: ' + (process.env.ADMIN_PASSWORD ? '(sandi dari ADMIN_PASSWORD)' : adminPw) + ' | kasir: ' + (process.env.KASIR_PASSWORD ? '(sandi dari KASIR_PASSWORD)' : kasirPw) + '. Segera ganti lewat menu Akun.\n');
}
if (process.env.ADMIN_EMAIL) db.prepare("UPDATE users SET email=? WHERE username='admin' AND email IS NULL").run(String(process.env.ADMIN_EMAIL).toLowerCase());
const cfg = () => { const c = { ...CFG0 }; db.prepare('SELECT k,v FROM config').all().forEach(r => { if (r.k in CFG0) c[r.k] = r.v; }); return c; };
const rmPhoto = p => { if (p && p.startsWith('/uploads/')) fs.rm(path.join(UP, path.basename(p)), () => {}); };
function savePhoto(d, old) {
  if (!d) return old || '';
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(d);
  if (!m) throw E('Format foto harus JPG, PNG, atau WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3e6) throw E('Ukuran foto maksimal 3 MB.');
  const f = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, f), buf); rmPhoto(old);
  return '/uploads/' + f;
}
const num = (v, name) => { if (String(v ?? '').trim() === '' || !Number.isInteger(+v) || +v < 0 || +v > 1e9) throw E(name + ' harus berupa angka bulat 0 atau lebih.'); return +v; };
const str = (v, name, max, min = 1) => { v = String(v ?? '').trim(); if (v.length < min || v.length > max) throw E(`${name} wajib diisi (maksimal ${max} karakter).`); return v; };
const code = (v, name) => { v = String(v ?? '').trim().toUpperCase(); if (!/^[A-Z0-9._-]{2,20}$/.test(v)) throw E(name + ' wajib diisi: 2 sampai 20 karakter huruf, angka, titik, atau strip.'); return v; };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const mail = (v, req) => {
  v = String(v || '').trim().toLowerCase();
  if (!v) { if (req) throw E('Email wajib diisi.'); return null; }
  if (v.length > 100 || !EMAIL.test(v)) throw E('Format email tidak valid.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(v)) throw E('Email sudah dipakai akun lain.', 409);
  return v;
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.get('/healthz', (q, r) => { db.prepare('SELECT 1').get(); r.json({ ok: true }); });
app.use((q, r, n) => { r.setHeader('X-Content-Type-Options', 'nosniff'); r.setHeader('X-Frame-Options', 'DENY'); r.setHeader('Referrer-Policy', 'same-origin'); if (q.secure) r.setHeader('Strict-Transport-Security', 'max-age=15552000'); n(); });
app.use(express.json({ limit: '5mb' }));
app.use((q, r, n) => { if (!q.body || typeof q.body !== 'object') q.body = {}; n(); });
app.use('/uploads', express.static(UP, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const cookies = r => Object.fromEntries((r.headers.cookie || '').split(';').filter(Boolean).map(c => { const i = c.indexOf('='); const v = c.slice(i + 1); let d; try { d = decodeURIComponent(v); } catch { d = v; } return [c.slice(0, i).trim(), d]; }));
const IDLE_STAFF = (+process.env.SESSION_IDLE_MIN || 30) * 6e4, IDLE_USER = 7 * 864e5;
app.use((req, res, next) => {
  req.user = null; const t = cookies(req).sid;
  if (t) {
    const s = db.prepare(`SELECT s.last,u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1 AND u.role IN ('admin','kasir')`).get(t);
    if (s) {
      const n = Date.now(), idle = IDLE_STAFF;
      if (n - (s.last || 0) <= idle) { req.user = { id: s.id, username: s.username, name: s.name, role: s.role }; if (n - s.last > 6e4) db.prepare('UPDATE sessions SET last=? WHERE token=?').run(n, t); }
      else db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    }
  }
  next();
});
const need = (...roles) => (req, res, next) => req.user && roles.includes(req.user.role) ? next() : next(E(req.user ? 'Fitur ini bukan untuk peranmu.' : 'Sesi berakhir atau belum masuk. Silakan masuk lagi.', req.user ? 403 : 401));
const admin = need('admin'), kasir = need('kasir'), both = need('admin', 'kasir'), both2 = both;
function startSession(res, id) {
  const t = crypto.randomBytes(32).toString('hex'), n = Date.now();
  db.prepare('INSERT INTO sessions(token,user_id,created,last) VALUES(?,?,?,?)').run(t, id, n, n);
  db.prepare('DELETE FROM sessions WHERE last<?').run(n - 7 * 864e5);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${(process.env.HTTPS === '1' || res.req.secure) ? '; Secure' : ''}`);
}
const tries = {};
const limited = ip => { const n = Date.now(), a = (tries[ip] || []).filter(t => n - t < 6e4); tries[ip] = a; return a.length >= 8; };

app.get('/api/me', (q, r) => r.json({ user: q.user, idleMin: IDLE_STAFF / 6e4 }));
app.post('/api/login', (q, r) => {
  if (limited(q.ip)) throw E('Terlalu banyak percobaan. Coba lagi satu menit lagi.', 429);
  const u = db.prepare(`SELECT * FROM users WHERE username=? AND role=? AND role IN ('admin','kasir') AND active=1`).get(String(q.body.u || '').toLowerCase(), String(q.body.role || ''));
  if (!u || !verify(String(q.body.p || ''), u.hash)) { tries[q.ip].push(Date.now()); throw E('Nama pengguna, kata sandi, atau peran tidak cocok.', 401); }
  startSession(r, u.id); r.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});
app.post('/api/logout', (q, r) => { const t = cookies(q).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t); r.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); r.json({ ok: true }); });

/* ---------- data publik ---------- */
const prods = () => {
  const P = db.prepare('SELECT id,code,name,price,stock FROM products ORDER BY id').all(), ph = db.prepare('SELECT id,product_id,path FROM product_photos ORDER BY pos,id').all();
  P.forEach(p => { p.photos = ph.filter(x => x.product_id === p.id).map(x => ({ id: x.id, url: x.path })); p.photo = p.photos[0] ? p.photos[0].url : ''; });
  return P;
};
const svcs = () => db.prepare('SELECT id,code,name,info AS "desc",price,photo FROM services ORDER BY id').all();
app.get('/api/public', (q, r) => r.json({ products: prods(), services: svcs(), cfg: cfg() }));
app.post('/api/visit', (q, r) => { db.prepare('INSERT INTO visits(date,count) VALUES(?,1) ON CONFLICT(date) DO UPDATE SET count=count+1').run(today()); r.json({ ok: true }); });

/* ---------- pelanggan dan kendaraan (UC-08, UC-13) ---------- */
function createCustomer(c) {
  const name = str(c.name, 'Nama pelanggan', 60, 2), ph = phone(str(c.phone, 'Nomor telepon', 20, 6));
  if (ph.length < 8) throw E('Nomor telepon tidak valid.');
  const old = db.prepare('SELECT id FROM customers WHERE phone=?').get(ph);
  return old ? old.id : newCustomerRow(name, ph, String(c.address || '').slice(0, 150));
}
function createVehicle(cid, v) {
  const type = str(v.type, 'Tipe motor', 40), brand = String(v.brand || '').trim().slice(0, 30);
  const plate = String(v.plate || '').toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 12) || null;
  const year = v.year === '' || v.year == null ? null : +v.year;
  if (year !== null && (!Number.isInteger(year) || year < 1980 || year > new Date().getFullYear() + 1)) throw E('Tahun motor tidak valid.');
  const o = plate ? db.prepare('SELECT id FROM vehicles WHERE customer_id=? AND plate=?').get(cid, plate) : db.prepare('SELECT id FROM vehicles WHERE customer_id=? AND plate IS NULL AND type=? AND brand=?').get(cid, type, brand);
  if (o) return o.id;
  return db.prepare('INSERT INTO vehicles(customer_id,plate,brand,type,year) VALUES(?,?,?,?,?)').run(cid, plate, brand, type, year).lastInsertRowid;
}
const label = v => [v.brand, v.type, v.year, v.plate].filter(Boolean).join(' ');
const custRows = () => {
  const C = db.prepare('SELECT id,code,name,phone,address FROM customers ORDER BY id').all(), V = db.prepare('SELECT id,customer_id,plate,brand,type,year FROM vehicles ORDER BY id').all();
  C.forEach(c => { c.vehicles = V.filter(v => v.customer_id === c.id).map(v => ({ ...v, label: label(v) })); }); return C;
};
app.get('/api/customers', both, (q, r) => r.json({ rows: custRows() }));
app.post('/api/customers', both, (q, r) => {
  const id = db.transaction(() => { const id = createCustomer(q.body); if (q.body.vehicle && String(q.body.vehicle.type || '').trim()) createVehicle(id, q.body.vehicle); return id; })();
  r.json({ id });
});
app.put('/api/customers/:id', admin, (q, r) => {
  const name = str(q.body.name, 'Nama pelanggan', 60, 2), ph = phone(str(q.body.phone, 'Nomor telepon', 20, 6)), id = +q.params.id;
  if (db.prepare('SELECT 1 FROM customers WHERE phone=? AND id!=?').get(ph, id)) throw E('Nomor telepon sudah dipakai pelanggan lain.', 409);
  db.prepare('UPDATE customers SET name=?,phone=?,address=? WHERE id=?').run(name, ph, String(q.body.address || '').slice(0, 150), id); r.json({ ok: true });
});
app.delete('/api/customers/:id', admin, (q, r) => {
  const id = +q.params.id;
  if (db.prepare('SELECT 1 FROM bookings WHERE customer_id=?').get(id)) throw E('Pelanggan sudah punya riwayat servis, tidak bisa dihapus.');
  db.prepare('DELETE FROM vehicles WHERE customer_id=?').run(id); db.prepare('DELETE FROM customers WHERE id=?').run(id); r.json({ ok: true });
});
app.post('/api/customers/:id/vehicles', both, (q, r) => {
  if (!db.prepare('SELECT 1 FROM customers WHERE id=?').get(+q.params.id)) throw E('Pelanggan tidak ditemukan.', 404);
  r.json({ id: createVehicle(+q.params.id, q.body) });
});
app.delete('/api/vehicles/:id', admin, (q, r) => {
  if (db.prepare('SELECT 1 FROM bookings WHERE vehicle_id=?').get(+q.params.id)) throw E('Kendaraan sudah punya riwayat servis, tidak bisa dihapus.');
  db.prepare('DELETE FROM vehicles WHERE id=?').run(+q.params.id); r.json({ ok: true });
});
app.get('/api/customers/:id/history', admin, (q, r) => r.json({ rows: db.prepare('SELECT b.id,b.reg_no,b.date,b.status,b.motor,s.name AS service,(SELECT total FROM sales WHERE booking_id=b.id) AS total FROM bookings b LEFT JOIN services s ON s.id=b.service_id WHERE b.customer_id=? ORDER BY b.id DESC').all(+q.params.id) }));

/* ---------- pendaftaran servis (UC-12) ---------- */
function register(o) {
  return db.transaction(() => {
    const date = String(o.date || today());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today()) throw E('Tanggal tidak boleh sebelum hari ini.');
    const now = new Date(), time = /^\d{2}:\d{2}$/.test(String(o.time || '')) ? o.time : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(+o.service_id);
    if (!svc) throw E('Layanan tidak ditemukan.');
    let cid;
    if (o.customer_id) { cid = +o.customer_id; if (!db.prepare('SELECT 1 FROM customers WHERE id=?').get(cid)) throw E('Pelanggan tidak ditemukan.'); }
    else cid = createCustomer(o.customer || {});
    let vid;
    if (o.vehicle_id) { vid = +o.vehicle_id; if (!db.prepare('SELECT 1 FROM vehicles WHERE id=? AND customer_id=?').get(vid, cid)) throw E('Kendaraan tidak cocok dengan pelanggan.'); }
    else vid = createVehicle(cid, o.vehicle || {});
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid), v = db.prepare('SELECT * FROM vehicles WHERE id=?').get(vid);
    const no = db.prepare('SELECT COALESCE(MAX(no),0)+1 AS n FROM bookings WHERE date=?').get(date).n, reg = 'REG-' + date.replace(/-/g, '') + '-' + pad(no);
    const id = db.prepare('INSERT INTO bookings(date,time,no,name,wa,motor,service_id,note,user_id,created,reg_no,customer_id,vehicle_id,svc_price,mechanic,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(date, time, no, c.name, c.phone, label(v), svc.id, String(o.note || '').slice(0, 300), o.user_id || null, Date.now(), reg, cid, vid, svc.price, String(o.mechanic || '').slice(0, 40), o.source || 'online').lastInsertRowid;
    return { id, no, reg_no: reg, date, time, name: c.name, service: svc.name };
  })();
}
app.post('/api/bookings', (q, r) => {
  if (cfg().bookingOnline !== '1') throw E('Pendaftaran servis dilayani kasir di bengkel. Silakan datang langsung atau hubungi WhatsApp bengkel.', 403);
  const b = q.body;
  r.json(register({ customer: { name: b.name, phone: b.wa }, vehicle: { type: b.motor }, service_id: b.sid, date: b.date, time: b.time, note: b.note, user_id: null, source: 'online' }));
});
app.post('/api/registrations', kasir, (q, r) => {
  const b = q.body;
  r.json(register({ customer_id: b.customer_id, customer: b.customer, vehicle_id: b.vehicle_id, vehicle: b.vehicle, service_id: b.service_id, date: b.date, note: b.note, mechanic: b.mechanic, user_id: q.user.id, source: 'kasir' }));
});

/* ---------- pekerjaan servis (UC-17..19) ---------- */
const bk = 'SELECT b.id,b.no,b.reg_no,b.spk_no,b.mechanic,b.date,b.time,b.name,b.wa,b.motor,b.note,b.status,b.wa_sent,b.svc_price,s.name AS service,(SELECT id FROM sales WHERE booking_id=b.id) AS sale_id,(SELECT COUNT(*) FROM service_parts WHERE booking_id=b.id) AS nparts FROM bookings b LEFT JOIN services s ON s.id=b.service_id';
app.get('/api/bookings', kasir, (q, r) => r.json({ rows: db.prepare(bk + ' WHERE b.date=? ORDER BY b.no').all(String(q.query.date || today())) }));

const fillMsg = (t, b, c) => String(t || '').replace(/\{nama\}/g, b.name).replace(/\{motor\}/g, b.motor).replace(/\{layanan\}/g, b.service || '').replace(/\{jam\}/g, c.jam);
const FONNTE = process.env.FONNTE_TOKEN, FONNTE_URL = process.env.FONNTE_URL || 'https://api.fonnte.com/send';
async function notifyDone(id) {
  const b = db.prepare('SELECT b.*,s.name AS service FROM bookings b LEFT JOIN services s ON s.id=b.service_id WHERE b.id=?').get(id);
  if (!b || b.wa_sent) return;
  const msg = fillMsg(cfg().waDone, b, cfg());
  if (!FONNTE) { console.log(`\n[WA OTOMATIS TIDAK DIKIRIM karena FONNTE_TOKEN belum diatur]\nKe: ${phone(b.wa)}\n${msg}\n`); return; }
  try {
    const res = await fetch(FONNTE_URL, { method: 'POST', headers: { Authorization: FONNTE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ target: phone(b.wa), message: msg, countryCode: '62' }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.status !== false) db.prepare('UPDATE bookings SET wa_sent=1 WHERE id=?').run(id); else console.error('WA gagal dikirim:', j.reason || res.status);
  } catch (e) { console.error('WA gagal dikirim:', e.message); }
}
const NEXT = { Menunggu: ['Dikerjakan', 'Batal'], Dikerjakan: ['Selesai'] };
const getBooking = id => { const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(+id); if (!b) throw E('Servis tidak ditemukan.', 404); return b; };
app.patch('/api/bookings/:id', kasir, (q, r) => {
  const b = getBooking(q.params.id), to = String(q.body.status || '');
  if (!(NEXT[b.status] || []).includes(to)) throw E(`Status tidak bisa diubah dari ${b.status} ke ${to || '(kosong)'}.`);
  const n = Date.now();
  if (to === 'Dikerjakan') db.prepare("UPDATE bookings SET status=?,started_at=?,spk_no=? WHERE id=?").run(to, n, 'SPK-' + String(b.id).padStart(4, '0'), b.id);
  else if (to === 'Selesai') db.prepare('UPDATE bookings SET status=?,finished_at=? WHERE id=?').run(to, n, b.id);
  else db.prepare('UPDATE bookings SET status=? WHERE id=?').run(to, b.id);
  if (to === 'Selesai') notifyDone(b.id);
  r.json({ ok: true });
});
const partsOf = id => db.prepare('SELECT id,product_id,name,price,qty FROM service_parts WHERE booking_id=? ORDER BY id').all(id);
app.get('/api/bookings/:id/parts', kasir, (q, r) => r.json({ rows: partsOf(getBooking(q.params.id).id) }));
app.post('/api/bookings/:id/parts', kasir, (q, r) => {
  const b = getBooking(q.params.id);
  if (b.status !== 'Dikerjakan') throw E('Sparepart hanya bisa dicatat saat status servis Dikerjakan.');
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(+q.body.product_id), qty = +q.body.qty;
    if (!p || !Number.isInteger(qty) || qty < 1) throw E('Sparepart atau jumlah tidak valid.');
    if (p.stock < qty) throw E(`Stok ${p.name} tidak cukup (sisa ${p.stock}).`);
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
    const o = db.prepare('SELECT id FROM service_parts WHERE booking_id=? AND product_id=?').get(b.id, p.id);
    if (o) db.prepare('UPDATE service_parts SET qty=qty+? WHERE id=?').run(qty, o.id);
    else db.prepare('INSERT INTO service_parts(booking_id,product_id,name,price,qty) VALUES(?,?,?,?,?)').run(b.id, p.id, p.name, p.price, qty);
  })();
  r.json({ rows: partsOf(b.id) });
});
app.delete('/api/bookings/:id/parts/:pid', kasir, (q, r) => {
  const b = getBooking(q.params.id);
  if (b.status !== 'Dikerjakan') throw E('Sparepart hanya bisa diubah saat status servis Dikerjakan.');
  db.transaction(() => {
    const o = db.prepare('SELECT * FROM service_parts WHERE id=? AND booking_id=?').get(+q.params.pid, b.id);
    if (o) { db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(o.qty, o.product_id); db.prepare('DELETE FROM service_parts WHERE id=?').run(o.id); }
  })();
  r.json({ rows: partsOf(b.id) });
});

/* ---------- tagihan dan pembayaran (UC-14, UC-15, UC-16) ---------- */
function billOf(b) {
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(b.service_id) || { name: 'Servis' }, parts = partsOf(b.id);
  return { svc: { name: svc.name, price: b.svc_price || 0 }, parts, total: (b.svc_price || 0) + parts.reduce((a, x) => a + x.price * x.qty, 0) };
}
app.get('/api/bookings/:id/bill', kasir, (q, r) => {
  const b = getBooking(q.params.id);
  if (b.status !== 'Selesai') throw E(b.status === 'Lunas' ? 'Servis ini sudah lunas.' : 'Tagihan hanya bisa dibuat setelah servis berstatus Selesai.');
  r.json(billOf(b));
});
app.post('/api/bookings/:id/bill', kasir, (q, r) => {
  const out = db.transaction(() => {
    const b = getBooking(q.params.id);
    if (b.status !== 'Selesai') throw E(b.status === 'Lunas' ? 'Servis ini sudah lunas.' : 'Pembayaran hanya bisa dilakukan setelah servis berstatus Selesai.');
    const bill = billOf(b), t = bill.total;
    const paid = String(q.body.paid ?? '').trim() === '' ? t : num(q.body.paid, 'Uang diterima');
    if (paid < t) throw E('Uang diterima kurang dari total biaya.');
    const sid = db.prepare('INSERT INTO sales(date,total,paid,user_id,created,booking_id) VALUES(?,?,?,?,?,?)').run(today(), t, paid, q.user.id, Date.now(), b.id).lastInsertRowid;
    db.prepare('INSERT INTO sale_items(sale_id,product_id,name,price,qty) VALUES(?,NULL,?,?,1)').run(sid, 'Servis: ' + bill.svc.name, bill.svc.price);
    for (const p of bill.parts) db.prepare('INSERT INTO sale_items(sale_id,product_id,name,price,qty) VALUES(?,?,?,?,?)').run(sid, p.product_id, p.name, p.price, p.qty);
    db.prepare("UPDATE bookings SET status='Lunas' WHERE id=?").run(b.id);
    return { id: sid, total: t };
  })();
  r.json(out);
});
app.post('/api/sales', kasir, (q, r) => {
  const items = Array.isArray(q.body.items) ? q.body.items : [];
  if (!items.length) throw E('Keranjang kosong.');
  const out = db.transaction(() => {
    let t = 0; const lines = [];
    for (const it of items) {
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(+it.id), qty = +it.qty;
      if (!p || !Number.isInteger(qty) || qty < 1) throw E('Item tidak valid.');
      if (p.stock < qty) throw E(`Stok ${p.name} tidak cukup (sisa ${p.stock}).`);
      lines.push([p, qty]); t += p.price * qty;
    }
    const paid = String(q.body.paid ?? '').trim() === '' ? t : num(q.body.paid, 'Uang diterima');
    if (paid < t) throw E('Uang diterima kurang dari total.');
    const sid = db.prepare('INSERT INTO sales(date,total,paid,user_id,created) VALUES(?,?,?,?,?)').run(today(), t, paid, q.user.id, Date.now()).lastInsertRowid;
    for (const [p, qty] of lines) {
      db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
      db.prepare('INSERT INTO sale_items(sale_id,product_id,name,price,qty) VALUES(?,?,?,?,?)').run(sid, p.id, p.name, p.price, qty);
    }
    return { id: sid, total: t };
  })();
  r.json(out);
});
app.get('/api/sales/:id', kasir, (q, r) => {
  const s = db.prepare('SELECT s.id,s.date,s.created,s.total,s.paid,s.booking_id,u.name AS cashier FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?').get(+q.params.id);
  if (!s) throw E('Transaksi tidak ditemukan.', 404);
  const t = new Date(s.created);
  s.time = `${pad(t.getHours())}:${pad(t.getMinutes())}`; s.paid = s.paid ?? s.total;
  s.no = `N-${s.date.replace(/-/g, '')}-${String(s.id).padStart(4, '0')}`;
  s.items = db.prepare('SELECT name,price,qty FROM sale_items WHERE sale_id=?').all(s.id);
  s.booking = s.booking_id ? db.prepare('SELECT no,reg_no,spk_no,mechanic,name,motor FROM bookings WHERE id=?').get(s.booking_id) : null;
  r.json({ sale: s, cfg: cfg() });
});
app.post('/api/sales/:id/printed', kasir, (q, r) => { db.prepare('UPDATE sales SET printed_at=COALESCE(printed_at,?) WHERE id=?').run(Date.now(), +q.params.id); r.json({ ok: true }); });

/* ---------- master sparepart dan layanan (UC-02..06) ---------- */
const uniq = (table, c, id) => { if (db.prepare(`SELECT 1 FROM ${table} WHERE code=? AND id!=?`).get(c, id || 0)) throw E('Kode sudah dipakai data lain.', 409); return c; };
function crud(path_, table, fields) {
  const body = (b, id) => fields.map(f => f.get(b, id));
  app.post('/api/' + path_, admin, (q, r) => {
    const v = body(q.body), photo = savePhoto(q.body.photo);
    r.json({ id: db.prepare(`INSERT INTO ${table}(${fields.map(f => f.col).join(',')},photo) VALUES(${fields.map(() => '?').join(',')},?)`).run(...v, photo).lastInsertRowid });
  });
  app.put('/api/' + path_ + '/:id', admin, (q, r) => {
    const o = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(+q.params.id); if (!o) throw E('Data tidak ditemukan.', 404);
    const v = body(q.body, o.id), photo = savePhoto(q.body.photo, o.photo);
    db.prepare(`UPDATE ${table} SET ${fields.map(f => f.col + '=?').join(',')},photo=? WHERE id=?`).run(...v, photo, o.id); r.json({ ok: true });
  });
}
const MAXPH = 8;
app.post('/api/products/:id/photos', admin, (q, r) => {
  const id = +q.params.id;
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw E('Produk tidak ditemukan.', 404);
  if (!q.body.photo) throw E('Foto kosong.');
  if (db.prepare('SELECT COUNT(*) AS n FROM product_photos WHERE product_id=?').get(id).n >= MAXPH) throw E(`Maksimal ${MAXPH} foto per produk.`);
  const file = savePhoto(q.body.photo), pos = db.prepare('SELECT COALESCE(MAX(pos),-1)+1 AS p FROM product_photos WHERE product_id=?').get(id).p;
  r.json({ id: db.prepare('INSERT INTO product_photos(product_id,path,pos) VALUES(?,?,?)').run(id, file, pos).lastInsertRowid });
});
app.delete('/api/products/:id/photos/:pid', admin, (q, r) => {
  const o = db.prepare('SELECT * FROM product_photos WHERE id=? AND product_id=?').get(+q.params.pid, +q.params.id);
  if (o) { rmPhoto(o.path); db.prepare('DELETE FROM product_photos WHERE id=?').run(o.id); }
  r.json({ ok: true });
});
app.put('/api/products/:id/photos/:pid/cover', admin, (q, r) => {
  db.prepare('UPDATE product_photos SET pos=(SELECT COALESCE(MIN(pos),0)-1 FROM product_photos WHERE product_id=?) WHERE id=? AND product_id=?').run(+q.params.id, +q.params.pid, +q.params.id);
  r.json({ ok: true });
});
app.delete('/api/products/:id', admin, (q, r) => {
  db.prepare('SELECT path FROM product_photos WHERE product_id=?').all(+q.params.id).forEach(x => rmPhoto(x.path));
  db.prepare('DELETE FROM product_photos WHERE product_id=?').run(+q.params.id);
  db.prepare('DELETE FROM products WHERE id=?').run(+q.params.id); r.json({ ok: true });
});
app.delete('/api/services/:id', admin, (q, r) => {
  const o = db.prepare('SELECT photo FROM services WHERE id=?').get(+q.params.id);
  if (db.prepare('SELECT 1 FROM bookings WHERE service_id=?').get(+q.params.id)) throw E('Layanan sudah dipakai pada servis, tidak bisa dihapus.');
  if (o) rmPhoto(o.photo); db.prepare('DELETE FROM services WHERE id=?').run(+q.params.id); r.json({ ok: true });
});
crud('products', 'products', [{ col: 'code', get: (b, id) => uniq('products', code(b.code, 'Kode sparepart'), id) }, { col: 'name', get: b => str(b.name, 'Nama', 80) }, { col: 'price', get: b => num(b.price, 'Harga') }, { col: 'stock', get: b => num(b.stock, 'Stok') }]);
crud('services', 'services', [{ col: 'code', get: (b, id) => uniq('services', code(b.code, 'Kode layanan'), id) }, { col: 'name', get: b => str(b.name, 'Nama', 80) }, { col: 'price', get: b => num(b.price, 'Tarif') }, { col: 'info', get: b => String(b.desc || '').slice(0, 200) }]);

/* ---------- laporan (UC-09, UC-10, UC-11) ---------- */
const dayVis = d => (db.prepare('SELECT count FROM visits WHERE date=?').get(d) || { count: 0 }).count;
const dayTotal = d => db.prepare('SELECT COALESCE(SUM(total),0) AS t, COUNT(*) AS n FROM sales WHERE date=?').get(d);
const dayBook = d => db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE date=?').get(d).n;
app.get('/api/dashboard', admin, (q, r) => r.json({ vis: dayVis(today()), bookings: dayBook(today()), sales: dayTotal(today()).t, low: db.prepare('SELECT name,stock FROM products WHERE stock<=3 ORDER BY stock').all() }));
function period(q) {
  if (q.mode === 'month') {
    const m = /^\d{4}-\d{2}$/.test(String(q.month)) ? q.month : today().slice(0, 7), [y, mo] = m.split('-').map(Number);
    return { mode: 'month', from: m + '-01', to: `${m}-${pad(new Date(y, mo, 0).getDate())}`, label: m };
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date)) ? q.date : today();
  return { mode: 'day', from: d, to: d, label: d };
}
app.get('/api/report', admin, (q, r) => {
  const P = period(q.query), { from, to } = P, book = { total: 0 };
  db.prepare('SELECT status,COUNT(*) AS n FROM bookings WHERE date BETWEEN ? AND ? GROUP BY status').all(from, to).forEach(x => { book[x.status] = x.n; book.total += x.n; });
  const s = db.prepare('SELECT COALESCE(SUM(total),0) AS t, COUNT(*) AS n FROM sales WHERE date BETWEEN ? AND ?').get(from, to);
  const svc = db.prepare('SELECT COALESCE(SUM(i.qty*i.price),0) AS t FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.date BETWEEN ? AND ? AND i.product_id IS NULL').get(from, to).t;
  const dates = []; const start = P.mode === 'month' ? from : ago(6), end = P.mode === 'month' ? to : from;
  if (P.mode === 'day') { for (let i = 6; i >= 0; i--) dates.push(ymd(new Date(from + 'T12:00:00').getTime() - i * 864e5)); }
  else { for (let t = new Date(from + 'T12:00:00'); ymd(t) <= to; t = new Date(t.getTime() + 864e5)) dates.push(ymd(t)); }
  r.json({
    mode: P.mode, label: P.label, from, to,
    vis: db.prepare('SELECT COALESCE(SUM(count),0) AS c FROM visits WHERE date BETWEEN ? AND ?').get(from, to).c,
    book, sales: s.n, total: s.t, svc, prod: s.t - svc,
    items: db.prepare('SELECT i.name AS name,SUM(i.qty) AS q,SUM(i.qty*i.price) AS t FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.date BETWEEN ? AND ? GROUP BY i.name ORDER BY t DESC').all(from, to),
    parts: db.prepare('SELECT p.name AS name,SUM(p.qty) AS q,SUM(p.qty*p.price) AS t FROM service_parts p JOIN bookings b ON b.id=p.booking_id WHERE b.date BETWEEN ? AND ? GROUP BY p.name ORDER BY q DESC').all(from, to),
    trx: P.mode === 'day' ? db.prepare("SELECT s.id,s.created,s.total,u.name AS cashier,CASE WHEN s.booking_id IS NULL THEN 'Penjualan' ELSE 'Servis' END AS type FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.date=? ORDER BY s.id DESC").all(from).map(x => { const t = new Date(x.created); return { id: x.id, total: x.total, cashier: x.cashier, type: x.type, time: `${pad(t.getHours())}:${pad(t.getMinutes())}` }; }) : [],
    daily: dates.map(d => ({ date: d, vis: dayVis(d), book: dayBook(d), total: dayTotal(d).t }))
  });
});

app.put('/api/config', admin, (q, r) => {
  const up = db.prepare('INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  Object.keys(CFG0).forEach(k => { if (k in q.body) up.run(k, String(q.body[k]).slice(0, k === 'waDone' ? 400 : 200)); }); r.json({ ok: true });
});

/* ---------- pengguna (UC-07) ---------- */
const otherAdmins = id => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id!=?").get(id).n;
app.get('/api/users', admin, (q, r) => r.json({ rows: db.prepare(`SELECT id,username,name,role,email,active FROM users WHERE role IN ('admin','kasir') ORDER BY role,id`).all() }));
app.post('/api/users', admin, (q, r) => {
  const username = String(q.body.username || '').toLowerCase().trim(), role = q.body.role, pw = String(q.body.password || '');
  if (!['admin', 'kasir'].includes(role)) throw E('Peran tidak valid.');
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw E('Nama pengguna 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.');
  if (pw.length < 6) throw E('Kata sandi minimal 6 karakter.');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw E('Nama pengguna sudah dipakai.', 409);
  db.prepare('INSERT INTO users(username,name,role,hash,email) VALUES(?,?,?,?,?)').run(username, str(q.body.name, 'Nama', 40, 2), role, hash(pw), mail(q.body.email)); r.json({ ok: true });
});
app.put('/api/users/:id', admin, (q, r) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id); if (!u) throw E('Akun tidak ditemukan.', 404);
  const name = str(q.body.name, 'Nama', 40, 2); let role = u.role;
  if (u.role !== 'pengunjung') {
    role = q.body.role;
    if (!['admin', 'kasir'].includes(role)) throw E('Peran tidak valid.');
    if (role !== u.role && u.role === 'admin' && (u.id === q.user.id || !otherAdmins(u.id))) throw E('Tidak bisa mengubah peran admin terakhir atau akunmu sendiri.');
  }
  db.prepare('UPDATE users SET name=?,role=? WHERE id=?').run(name, role, u.id);
  if (role !== u.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  r.json({ ok: true });
});
app.put('/api/users/:id/active', admin, (q, r) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id); if (!u) throw E('Akun tidak ditemukan.', 404);
  const on = q.body.active ? 1 : 0;
  if (!on && (u.id === q.user.id || (u.role === 'admin' && !otherAdmins(u.id)))) throw E('Tidak bisa menonaktifkan akunmu sendiri atau admin terakhir.');
  db.prepare('UPDATE users SET active=? WHERE id=?').run(on, u.id);
  if (!on) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  r.json({ ok: true });
});
app.put('/api/users/:id/email', admin, (q, r) => {
  const id = +q.params.id, v = String(q.body.email || '').trim().toLowerCase();
  if (v && (v.length > 100 || !EMAIL.test(v))) throw E('Format email tidak valid.');
  if (v && db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(v, id)) throw E('Email sudah dipakai akun lain.', 409);
  db.prepare('UPDATE users SET email=? WHERE id=?').run(v || null, id); r.json({ ok: true });
});
app.put('/api/users/:id/password', admin, (q, r) => {
  const pw = String(q.body.password || ''); if (pw.length < 6) throw E('Kata sandi minimal 6 karakter.');
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(hash(pw), +q.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(+q.params.id); r.json({ ok: true });
});

/* ---------- lupa kata sandi ---------- */
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const BASE = (process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : `http://localhost:${PORT}`)).replace(/\/$/, '');
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: +process.env.SMTP_PORT === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined }) : null;
async function sendMail(to, subject, text) {
  if (!mailer) { console.log(`\n[EMAIL TIDAK DIKIRIM karena SMTP belum diatur]\nKe: ${to}\nSubjek: ${subject}\n${text}\n`); return; }
  await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}
const fTries = {};
app.post('/api/forgot', async (q, r) => {
  const n = Date.now(), a = (fTries[q.ip] || []).filter(t => n - t < 6e5);
  if (a.length >= 5) throw E('Terlalu banyak permintaan. Coba lagi beberapa menit lagi.', 429);
  a.push(n); fTries[q.ip] = a;
  const email = String(q.body.email || '').trim().toLowerCase();
  const u = EMAIL.test(email) ? db.prepare('SELECT id,name FROM users WHERE email=? AND active=1').get(email) : null;
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM reset_tokens WHERE user_id=? OR expires<?').run(u.id, n);
    db.prepare('INSERT INTO reset_tokens VALUES(?,?,?)').run(sha(token), u.id, n + 30 * 6e4);
    try { await sendMail(email, 'Reset kata sandi Lucasshop', `Halo ${u.name},\n\nBuka tautan ini untuk membuat kata sandi baru (berlaku 30 menit):\n${BASE}/#/reset?t=${token}\n\nJika bukan kamu yang meminta, abaikan email ini.`); } catch (e) { console.error('Gagal mengirim email:', e.message); }
  }
  r.json({ ok: true });
});
app.post('/api/reset', (q, r) => {
  const pw = String(q.body.password || ''); if (pw.length < 6) throw E('Kata sandi minimal 6 karakter.');
  const t = db.prepare('SELECT * FROM reset_tokens WHERE token_hash=? AND expires>?').get(sha(String(q.body.token || '')), Date.now());
  if (!t) throw E('Tautan reset tidak valid atau sudah kedaluwarsa. Minta tautan baru.');
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(hash(pw), t.user_id);
  db.prepare('DELETE FROM reset_tokens WHERE user_id=?').run(t.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.user_id);
  r.json({ ok: true });
});

/* ---------- cadangan (NFR-06) ---------- */
app.get('/api/backup', admin, (q, r) => {
  r.setHeader('Content-Type', 'application/octet-stream'); r.setHeader('Content-Disposition', `attachment; filename="lucasshop-${today()}.db"`); r.send(db.serialize());
});
async function autoBackup() {
  const f = path.join(BK, `lucasshop-${today()}.db`);
  if (!fs.existsSync(f)) { try { await db.backup(f); } catch (e) { console.error('Cadangan otomatis gagal:', e.message); } }
  fs.readdirSync(BK).filter(x => x.endsWith('.db')).sort().slice(0, -14).forEach(x => fs.rmSync(path.join(BK, x), { force: true }));
}
autoBackup(); setInterval(autoBackup, 6 * 36e5).unref();

app.use('/api', (q, r) => r.status(404).json({ error: 'Tidak ditemukan.' }));
app.use((err, q, r, n) => { if (!err.status) console.error(err); r.status(err.status || 500).json({ error: err.status ? err.message : 'Terjadi kesalahan di server.' }); });
setInterval(() => { const n = Date.now(); for (const k in tries) { if (!tries[k].some(t => n - t < 6e4)) delete tries[k]; } for (const k in fTries) { if (!fTries[k].some(t => n - t < 6e5)) delete fTries[k]; } }, 6e4).unref();
const server = app.listen(PORT, () => console.log(`Lucasshop berjalan di port ${PORT} (data: ${DATA})`));
server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3;
const shutdown = sig => {
  console.log(`${sig} diterima, menutup server...`);
  server.close(() => { try { db.close(); } catch (e) { console.error(e.message); } process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
