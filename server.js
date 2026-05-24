const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3456;
const DB_PATH = path.join(__dirname, 'errand.db');

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

function saveDb() {
  if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, p = []) {
  db.run(sql, p);
  const r = db.exec('SELECT last_insert_rowid() as id');
  const id = r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0;
  saveDb();
  return { lastInsertRowid: id, changes: db.getRowsModified() };
}

function g(sql, p = []) {
  const s = db.prepare(sql); s.bind(p);
  if (s.step()) { const c = s.getColumnNames(); const v = s.get(); const o = {}; c.forEach((x,i) => o[x] = v[i]); s.free(); return o; }
  s.free(); return undefined;
}

function a(sql, p = []) {
  const s = db.prepare(sql); if (p.length) s.bind(p);
  const r = []; const c = s.getColumnNames();
  while (s.step()) { const v = s.get(); const o = {}; c.forEach((x,i) => o[x] = v[i]); r.push(o); }
  s.free(); return r;
}

async function initDb() {
  await getDb();
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','runner','admin')), phone TEXT DEFAULT '', balance REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', reward REAL NOT NULL, address TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','completed','cancelled')), paid INTEGER DEFAULT 0, client_id INTEGER NOT NULL, runner_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, runner_id INTEGER, amount REAL, status TEXT DEFAULT 'pending', confirmed_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  if (!g("SELECT id FROM users WHERE role='admin'")) {
    db.run("INSERT INTO users (username,password,role) VALUES ('admin','admin123','admin')");
  }
  saveDb();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// AUTH
app.post('/api/login', (req, res) => {
  const u = g('SELECT * FROM users WHERE username=? AND password=? AND role=?', [req.body.username, req.body.password, req.body.role]);
  if (!u) return res.status(401).json({ error: '用户名或密码错误' });
  const { password: _, ...safe } = u;
  res.json({ user: safe, token: String(u.id) });
});

app.post('/api/register', (req, res) => {
  const { username, password, role, phone } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: '缺少必填字段' });
  if (!['user', 'runner'].includes(role)) return res.status(400).json({ error: '无效角色' });
  if (g('SELECT id FROM users WHERE username=?', [username])) return res.status(400).json({ error: '用户名已存在' });
  run('INSERT INTO users (username,password,role,phone) VALUES (?,?,?,?)', [username, password, role, phone || '']);
  const u = g('SELECT * FROM users WHERE username=?', [username]);
  if (!u) return res.status(500).json({ error: '注册失败' });
  const { password: _, ...safe } = u;
  res.json({ user: safe, token: String(u.id) });
});

// TASKS
app.post('/api/tasks', (req, res) => {
  const { title, description, reward, address, client_id } = req.body;
  if (!title || !reward || !client_id) return res.status(400).json({ error: '缺少必填字段' });
  const r = run('INSERT INTO tasks (title,description,reward,address,client_id) VALUES (?,?,?,?,?)', [title, description || '', reward, address || '', client_id]);
  res.json({ id: r.lastInsertRowid, message: '任务发布成功' });
});

app.get('/api/tasks', (req, res) => {
  let sql = "SELECT t.*, c.username as client_name, r.username as runner_name FROM tasks t LEFT JOIN users c ON t.client_id=c.id LEFT JOIN users r ON t.runner_id=r.id WHERE 1=1";
  const p = [];
  if (req.query.client_id) { sql += ' AND t.client_id=?'; p.push(Number(req.query.client_id)); }
  if (req.query.runner_id) { sql += ' AND t.runner_id=?'; p.push(Number(req.query.runner_id)); }
  if (req.query.status) { sql += ' AND t.status=?'; p.push(req.query.status); }
  if (req.query.paid !== undefined) { sql += ' AND t.paid=?'; p.push(Number(req.query.paid)); }
  sql += ' ORDER BY t.created_at DESC';
  res.json(a(sql, p));
});

app.post('/api/tasks/:id/accept', (req, res) => {
  const t = g('SELECT * FROM tasks WHERE id=?', [Number(req.params.id)]);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (t.status !== 'pending') return res.status(400).json({ error: '任务已被接取' });
  run("UPDATE tasks SET status='accepted', runner_id=?, updated_at=datetime('now','localtime') WHERE id=?", [req.body.runner_id, Number(req.params.id)]);
  res.json({ message: '接单成功' });
});

app.post('/api/tasks/:id/complete', (req, res) => {
  const t = g('SELECT * FROM tasks WHERE id=?', [Number(req.params.id)]);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (t.status !== 'accepted') return res.status(400).json({ error: '状态不正确' });
  run("UPDATE tasks SET status='completed', updated_at=datetime('now','localtime') WHERE id=?", [Number(req.params.id)]);
  if (t.runner_id) run('UPDATE users SET balance=balance+? WHERE id=?', [t.reward, t.runner_id]);
  res.json({ message: '任务完成，报酬已结算' });
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const t = g('SELECT * FROM tasks WHERE id=?', [Number(req.params.id)]);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (t.status === 'completed') return res.status(400).json({ error: '已完成的任务不能取消' });
  run("UPDATE tasks SET status='cancelled', updated_at=datetime('now','localtime') WHERE id=?", [Number(req.params.id)]);
  res.json({ message: '已取消' });
});

app.post('/api/tasks/:id/mark-paid', (req, res) => { run('UPDATE tasks SET paid=1 WHERE id=?', [Number(req.params.id)]); res.json({ message: '已标记' }); });
app.post('/api/tasks/:id/confirm-paid', (req, res) => { run('UPDATE tasks SET paid=2 WHERE id=?', [Number(req.params.id)]); res.json({ message: '已确认' }); });

app.post('/api/runner/withdraw', (req, res) => {
  const r = g('SELECT * FROM users WHERE id=?', [req.body.runner_id]);
  if (!r) return res.status(404).json({ error: '跑腿员不存在' });
  if (r.balance < req.body.amount) return res.status(400).json({ error: '余额不足' });
  run('INSERT INTO withdrawals (runner_id, amount) VALUES (?,?)', [req.body.runner_id, req.body.amount]);
  run('UPDATE users SET balance=balance-? WHERE id=?', [req.body.amount, req.body.runner_id]);
  res.json({ message: '提现申请已提交' });
});

app.get('/api/admin/withdraws', (req, res) => { res.json(a("SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON w.runner_id=u.id ORDER BY w.created_at DESC")); });
app.post('/api/admin/withdraw/:id/confirm', (req, res) => { run("UPDATE withdrawals SET status='confirmed', confirmed_at=datetime('now','localtime') WHERE id=?", [Number(req.params.id)]); res.json({ message: '已打款' }); });

app.get('/api/admin/users', (req, res) => res.json(a('SELECT id,username,role,phone,balance,created_at FROM users ORDER BY created_at DESC')));
app.get('/api/admin/tasks', (req, res) => res.json(a("SELECT t.*, c.username as client_name, r.username as runner_name FROM tasks t LEFT JOIN users c ON t.client_id=c.id LEFT JOIN users r ON t.runner_id=r.id ORDER BY t.created_at DESC")));
app.delete('/api/admin/users/:id', (req, res) => { run('DELETE FROM users WHERE id=? AND role!=?', [Number(req.params.id), 'admin']); res.json({ message: '已删除' }); });
app.delete('/api/admin/tasks/:id', (req, res) => { run('DELETE FROM tasks WHERE id=?', [Number(req.params.id)]); res.json({ message: '已删除' }); });
app.get('/api/admin/stats', (req, res) => {
  res.json({
    totalUsers: g('SELECT COUNT(*) as c FROM users').c,
    totalRunners: g("SELECT COUNT(*) as c FROM users WHERE role='runner'").c,
    totalTasks: g('SELECT COUNT(*) as c FROM tasks').c,
    pendingTasks: g("SELECT COUNT(*) as c FROM tasks WHERE status='pending'").c,
    completedTasks: g("SELECT COUNT(*) as c FROM tasks WHERE status='completed'").c,
    totalReward: g("SELECT COALESCE(SUM(reward),0) as t FROM tasks WHERE status='completed'").t,
    pendingWithdraws: g("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'").c
  });
});

app.get('/api/admin/db-export', (req, res) => {
  res.json({ data: Buffer.from(db.export()).toString('base64') });
});

app.post('/api/admin/db-import', (req, res) => {
  try {
    const SQL = require('sql.js');
    db = new SQL.Database(Buffer.from(req.body.data, 'base64'));
    db.run('PRAGMA foreign_keys = ON');
    saveDb();
    res.json({ message: '导入成功' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
});