const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

let pool = null;
const BATCH = 500;
const schemaCache = {};

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'nastige_mlm',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: '+05:30',
      dateStrings: true
    });
  }
  return pool;
}

function parseJSON(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch (_) { return val; }
  }
  return val;
}

function toBool(val) {
  if (val === null || val === undefined) return false;
  return val === true || val === 1 || val === '1';
}

function rowToObject(row) {
  if (!row) return row;
  const obj = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { obj[k] = null; continue; }
    if (typeof v === 'object' && !Array.isArray(v)) {
      if (k.endsWith('_json') || k === 'stock' || k === 'items' || k === 'earning_ids' ||
          k === 'product_ids' || k === 'read_broadcasts' || k === 'banner_slides' ||
          k === 'achievers' || k === 'founders' || k === 'hidden_star_winners' ||
          k === 'youtube_videos' || k === 'franchise_orders' || k === 'null') {
        obj[k] = v;
      } else {
        obj[k] = v;
      }
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

const JSON_COLUMNS = {
  users: ['read_broadcasts'],
  pin_packages: ['product_ids'],
  plans: ['product_ids'],
  payouts: ['earning_ids'],
  invoices: ['items'],
  franchises: ['stock', 'read_broadcasts'],
  settings: ['banner_slides', 'achievers', 'founders', 'hidden_star_winners', 'youtube_videos', 'email_settings'],
  counters: ['franchise_orders'],
  orders: ['items']
};

const BOOL_COLUMNS = {
  users: ['active', 'is_auto_created', 'is_matrix_target', 'monthly_repurchase_exempt'],
  products: ['show_on_home', 'active'],
  plans: ['active'],
  pin_packages: ['bundle', 'is_matrix_pin'],
  celebrations: ['hidden_from_home'],
  offers: ['is_active', 'reward_product_id'],
  free_product_issues: ['is_star_winner'],
  settings: ['leadership_bonus_enabled', 'auto_binary_on_bv', 'star_winner_enabled',
             'sidePopupEnabled', 'hide_star_winners_marquee', 'popup_notice_enabled',
             'rank_income_enabled', 'monthly_repurchase_required',
             '_leadership_fixed', '_leadership_fixed2', '_celebration_fixed']
};

const VALID_COLUMNS = {
  company_pages: ['slug', 'title', 'content', 'updated_at'],
  contacts: ['id', 'name', 'email', 'phone', 'subject', 'message', 'created_at']
};

function serializeRow(table, row) {
  if (!row) return row;
  const out = {};
  const jsonCols = JSON_COLUMNS[table] || [];
  const boolCols = BOOL_COLUMNS[table] || [];
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (jsonCols.includes(k)) {
      if (v === null) { out[k] = null; }
      else if (typeof v === 'string') { out[k] = v; }
      else { out[k] = JSON.stringify(v); }
    } else if (boolCols.includes(k)) {
      out[k] = v ? 1 : 0;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const SKIP_NUMBER_FIELDS = [
  'username', 'user_code', 'member_name', 'email', 'phone', 'password',
  'note', 'status', 'role', 'leg', 'placement_side', 'transfer_id',
  'transfer_credentials', 'transfer_date', 'created_at', 'updated_at',
  'credited_at', 'date', 'slug', 'title', 'content', 'subject',
  'bank_name', 'bank_account_number', 'bank_ifsc', 'address', 'city',
  'state', 'pincode', 'pan_number', 'aadhaar_number', 'ifsc', 'code',
  'plan_name', 'rank_name', 'source_user_code', 'source_pin_code',
  'receipt_url', 'invoice_no', 'order_no', 'payment_method', 'type'
];

function toNumber(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val.trim())) {
    const n = Number(val);
    if (!isNaN(n)) return n;
  }
  return val;
}

function deserializeRow(table, row) {
  if (!row) return row;
  const out = {};
  const jsonCols = JSON_COLUMNS[table] || [];
  const boolCols = BOOL_COLUMNS[table] || [];
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { out[k] = null; continue; }
    if (jsonCols.includes(k)) {
      out[k] = parseJSON(v);
    } else if (boolCols.includes(k)) {
      out[k] = toBool(v);
    } else if (SKIP_NUMBER_FIELDS.includes(k)) {
      out[k] = v;
    } else {
      out[k] = toNumber(v);
    }
  }
  return out;
}

async function loadTable(conn, table) {
  try {
    const [rows] = await conn.execute(`SELECT * FROM ${table}`);
    return rows.map(r => deserializeRow(table, r));
  } catch (err) {
    console.error(`[MYSQL-LOAD] Error loading ${table}:`, err.message);
    return [];
  }
}

async function loadSettings(conn) {
  try {
    const [rows] = await conn.execute('SELECT * FROM settings WHERE id = 1');
    if (rows.length > 0) return deserializeRow('settings', rows[0]);
  } catch (err) {
    console.error('[MYSQL-LOAD] Error loading settings:', err.message);
  }
  return {};
}

async function loadCounters(conn) {
  try {
    const [rows] = await conn.execute('SELECT * FROM counters WHERE id = 1');
    if (rows.length > 0) {
      const c = {};
      const row = rows[0];
      for (const [k, v] of Object.entries(row)) {
        if (k === 'id') continue;
        if (k === 'franchise_orders') {
          c.franchise_orders = parseJSON(v) || {};
        } else if (k.endsWith('_val')) {
          c[k.replace('_val', '')] = v;
        } else {
          c[k] = v;
        }
      }
      return c;
    }
  } catch (err) {
    console.error('[MYSQL-LOAD] Error loading counters:', err.message);
  }
  return {};
}

async function loadAllFromMySQL() {
  const conn = await getPool().getConnection();
  try {
    const db = {};
    const tables = [
      'users', 'products', 'plans', 'earnings', 'payouts',
      'pin_packages', 'franchises', 'franchise_transactions',
      'franchise_stock_history', 'invoices', 'tickets',
      'celebrations', 'rank_rules', 'rank_history',
      'company_pages', 'contacts', 'bv_adjustments',
      'free_products', 'free_product_issues', 'gallery',
      'offers', 'offer_achievements', 'broadcasts', 'orders',
      'wishlists', 'pages'
    ];
    for (const t of tables) {
      db[t] = await loadTable(conn, t);
    }
    db.settings = await loadSettings(conn);
    db.counters = await loadCounters(conn);
    return db;
  } finally {
    conn.release();
  }
}

async function getTableColumns(conn, table) {
  if (schemaCache[table]) return schemaCache[table];
  try {
    const [rows] = await conn.execute(`SHOW COLUMNS FROM ${table}`);
    schemaCache[table] = new Set(rows.map(r => r.Field));
  } catch (e) {
    schemaCache[table] = new Set();
  }
  return schemaCache[table];
}

async function saveCollectionToMySQL(conn, table, rows) {
  if (!rows || !Array.isArray(rows)) return;
  const validCols = VALID_COLUMNS[table] || null;
  const dbCols = await getTableColumns(conn, table);
  if (dbCols.size === 0) {
    console.error(`[MYSQL-SAVE] No columns found for ${table}, skipping save`);
    return;
  }
  await conn.beginTransaction();
  try {
    await conn.execute(`DELETE FROM ${table}`);
    if (rows.length === 0) { await conn.commit(); return; }
    let serialized = rows.map(r => serializeRow(table, r));
    if (validCols) {
      serialized = serialized.map(row => {
        const filtered = {};
        for (const col of validCols) {
          if (row[col] !== undefined) filtered[col] = row[col];
        }
        return filtered;
      });
    }
    serialized = serialized.map(row => {
      const filtered = {};
      for (const [k, v] of Object.entries(row)) {
        if (dbCols.has(k)) filtered[k] = v;
      }
      return filtered;
    });
    const deduped = [];
    const seenIds = new Set();
    for (const row of serialized) {
      const rowId = row.id;
      if (rowId !== undefined && rowId !== null) {
        if (seenIds.has(rowId)) continue;
        seenIds.add(rowId);
      }
      deduped.push(row);
    }
    if (deduped.length === 0) { await conn.commit(); return; }
    const keys = Object.keys(deduped[0]);
    if (keys.length === 0) { await conn.commit(); return; }
    const quoted = quoteCols(keys);
    for (let i = 0; i < deduped.length; i += BATCH) {
      const batch = deduped.slice(i, i + BATCH);
      const ph = batch.map(() => `(${keys.map(() => '?').join(',')})`).join(',');
      const sql = `INSERT INTO ${table} (${quoted}) VALUES ${ph}`;
      const vals = batch.flatMap(r => keys.map(k => r[k] !== undefined ? r[k] : null));
      await conn.execute(sql, vals);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error(`[MYSQL-SAVE] Error saving ${table}, rolled back:`, err.message);
  }
}

async function saveSettingsToMySQL(conn, settings) {
  if (!settings) return;
  const dbCols = await getTableColumns(conn, 'settings');
  const serialized = serializeRow('settings', settings);
  serialized.id = 1;
  const filtered = {};
  for (const [k, v] of Object.entries(serialized)) {
    if (dbCols.size === 0 || dbCols.has(k)) filtered[k] = v;
  }
  const keys = Object.keys(filtered);
  const placeholders = keys.map(() => '?').join(', ');
  const updates = keys.filter(k => k !== 'id').map(k => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');
  const sql = `INSERT INTO settings (${quoteCols(keys)}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  await conn.execute(sql, Object.values(filtered));
}

async function saveCountersToMySQL(conn, counters) {
  if (!counters) return;
  const dbCols = await getTableColumns(conn, 'counters');
  const row = { id: 1 };
  for (const [k, v] of Object.entries(counters)) {
    if (k === 'franchise_orders' || (typeof v === 'object' && v !== null)) {
      row.franchise_orders = JSON.stringify(v);
    } else {
      row[k + '_val'] = v;
    }
  }
  const filtered = {};
  for (const [k, v] of Object.entries(row)) {
    if (dbCols.size === 0 || dbCols.has(k)) filtered[k] = v;
  }
  const keys = Object.keys(filtered);
  const placeholders = keys.map(() => '?').join(', ');
  const updates = keys.filter(k => k !== 'id').map(k => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');
  const sql = `INSERT INTO counters (${quoteCols(keys)}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  await conn.execute(sql, Object.values(filtered));
}

const ALL_COLLECTIONS = [
  'users', 'products', 'plans', 'earnings', 'payouts',
  'pin_packages', 'franchises', 'franchise_transactions',
  'franchise_stock_history', 'invoices', 'tickets',
  'celebrations', 'rank_rules', 'rank_history',
  'company_pages', 'contacts', 'bv_adjustments',
  'free_products', 'free_product_issues', 'gallery',
  'offers', 'offer_achievements', 'broadcasts', 'orders',
  'wishlists', 'pages'
];

async function saveFullDB(db) {
  const conn = await getPool().getConnection();
  try {
    for (const t of ALL_COLLECTIONS) {
      await saveCollectionToMySQL(conn, t, db[t]);
    }
    await saveSettingsToMySQL(conn, db.settings);
    await saveCountersToMySQL(conn, db.counters);
  } finally {
    conn.release();
  }
}

function quoteCols(keys) {
  return keys.map(k => `\`${k}\``).join(',');
}

let dirtySet = new Set();
let flushTimer = null;

function markDirty(collection) {
  dirtySet.add(collection);
  if (!flushTimer) {
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      const toFlush = new Set(dirtySet);
      dirtySet.clear();
      if (toFlush.size === 0) return;
      const conn = await getPool().getConnection();
      try {
        for (const t of toFlush) {
          if (t === 'settings') {
            await saveSettingsToMySQL(conn, global._db.settings);
          } else if (t === 'counters') {
            await saveCountersToMySQL(conn, global._db.counters);
          } else if (ALL_COLLECTIONS.includes(t)) {
            await saveCollectionToMySQL(conn, t, global._db[t]);
          }
        }
      } catch (err) {
        console.error('[MYSQL-FLUSH] Error:', err.message);
      } finally {
        conn.release();
      }
    }, 200);
  }
}

function flushDirtySync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirtySet.size === 0) return Promise.resolve();
  const toFlush = new Set(dirtySet);
  dirtySet.clear();
  return new Promise((resolve, reject) => {
    getPool().getConnection().then(async conn => {
      try {
        for (const t of toFlush) {
          try {
            if (t === 'settings') {
              await saveSettingsToMySQL(conn, global._db.settings);
            } else if (t === 'counters') {
              await saveCountersToMySQL(conn, global._db.counters);
            } else if (ALL_COLLECTIONS.includes(t)) {
              await saveCollectionToMySQL(conn, t, global._db[t]);
            }
          } catch (err) {
            console.error(`[MYSQL-FLUSH] Error saving ${t}:`, err.message);
          }
        }
        conn.release();
        resolve();
      } catch (err) {
        conn.release();
        reject(err);
      }
    }).catch(err => {
      console.error('[MYSQL-FLUSH] Connection error:', err.message);
      resolve();
    });
  });
}

module.exports = {
  getPool,
  loadAllFromMySQL,
  saveFullDB,
  markDirty,
  flushDirtySync,
  parseJSON,
  ALL_COLLECTIONS,
  JSON_COLUMNS,
  BOOL_COLUMNS,
  serializeRow,
  deserializeRow
};
