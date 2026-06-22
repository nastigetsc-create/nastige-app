const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const mysqlAdapter = require('./db-mysql-adapter');

process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'crash.log'), new Date().toISOString() + ' UNCAUGHT: ' + (err.stack || err) + '\n');
  } catch(e) {}
  try { if (DB_FILE && db) fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
  mysqlAdapter.flushDirtySync().then(() => process.exit(1)).catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000);
});
process.on('unhandledRejection', (err) => {
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'crash.log'), new Date().toISOString() + ' REJECTION: ' + (err.stack || err) + '\n');
  } catch(e) {}
  try { if (DB_FILE && db) fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
  mysqlAdapter.flushDirtySync().then(() => process.exit(1)).catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000);
});
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received, saving data...`);
  console.log('[SHUTDOWN] Writing JSON backup...');
  try { if (DB_FILE && db) fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) { console.error('[SHUTDOWN] JSON write error:', e.message); }
  console.log('[SHUTDOWN] Flushing MySQL...');
  mysqlAdapter.flushDirtySync()
    .then(() => { console.log('[SHUTDOWN] MySQL flush complete, exiting.'); process.exit(0); })
    .catch(err => { console.error('[SHUTDOWN] MySQL flush error:', err.message); process.exit(1); });
  setTimeout(() => { console.log('[SHUTDOWN] Timeout, force exiting.'); process.exit(0); }, 8000);
}

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const { DateTime } = require('luxon');
const multer = require('multer');
const nodemailer = require('nodemailer');
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.log('sharp not available, using raw file upload');
  sharp = null;
}
let ffmpeg;
let ffmpegPath;
try {
  ffmpeg = require('fluent-ffmpeg');
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpegPath = ffmpegInstaller.path;
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('ffmpeg available for video compression');
} catch (e) {
  console.log('ffmpeg not available, video compression disabled');
  ffmpeg = null;
}
const XLSX = require('xlsx');

console.log('========================================');
console.log('SERVER CODE LOADED - DUPLICATE FIX ACTIVE');
console.log('========================================');

// Custom multer storage that compresses images and videos
class CompressedStorage {
  constructor(options) {
    this.getDestination = options.destination;
    this.getFilename = options.filename;
    this.quality = options.quality || 80;
    this.maxWidth = options.maxWidth || 1920;
    this.maxHeight = options.maxHeight || 1080;
    this.autoRotate = options.autoRotate !== false;
    this.maxVideoDuration = options.maxVideoDuration || 60;
    this.trim = options.trim || false; // Auto-trim whitespace from logos
  }

  _handleFile(req, file, cb) {
    this.getDestination(req, file, (err, destination) => {
      if (err) return cb(err);
      this.getFilename(req, file, (err, filename) => {
        if (err) return cb(err);
        
        const finalPath = path.join(destination, filename);
        const isImage = file.mimetype && file.mimetype.startsWith('image/');
        const isVideo = file.mimetype && file.mimetype.startsWith('video/');
        
        // For videos, use ffmpeg compression
        if (isVideo && ffmpeg) {
          this._compressVideo(file, destination, filename, cb);
          return;
        }
        
        // For images, use sharp compression
        if (isImage && sharp) {
          this._compressImage(file, destination, filename, cb);
          return;
        }
        
        // If no compression available, save directly
        const outStream = fs.createWriteStream(finalPath);
        file.stream.pipe(outStream);
        outStream.on('finish', () => {
          cb(null, {
            destination: destination,
            filename: filename,
            path: finalPath,
            size: fs.statSync(finalPath).size
          });
        });
        outStream.on('error', cb);
      });
    });
  }

  _compressImage(file, destination, filename, cb) {
    const finalPath = path.join(destination, filename);
    const tempPath = finalPath + '.tmp';
    const chunks = [];
    file.stream.on('data', chunk => chunks.push(chunk));
    
    file.stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      
      try {
        sharp(buffer)
          .metadata()
          .then(metadata => {
            let sharpProcessor = sharp(buffer);
            
            if (this.autoRotate) {
              sharpProcessor = sharpProcessor.rotate();
              if (metadata.orientation) {
                const rotations = {
                  2: { flip: 'horizontal' },
                  3: { rotate: 180 },
                  4: { flip: 'vertical' },
                  5: { rotate: 90, flip: 'horizontal' },
                  6: { rotate: 90 },
                  7: { rotate: 270, flip: 'horizontal' },
                  8: { rotate: 270 }
                };
                const rot = rotations[metadata.orientation];
                if (rot) {
                  if (rot.rotate) sharpProcessor = sharpProcessor.rotate(rot.rotate);
                  if (rot.flip === 'horizontal') sharpProcessor = sharpProcessor.flop();
                  if (rot.flip === 'vertical') sharpProcessor = sharpProcessor.flip();
                }
              }
            }
            
            if (this.trim) {
              sharpProcessor = sharpProcessor.trim({ background: 'white' });
            }
            
            sharpProcessor = sharpProcessor
              .resize(this.maxWidth, this.maxHeight, { 
                fit: 'inside',
                withoutEnlargement: true 
              })
              .jpeg({ quality: this.quality, mozjpeg: true })
              .png({ quality: this.quality, compressionLevel: 9 })
              .webp({ quality: this.quality });

            sharpProcessor
              .toFile(tempPath)
              .then(() => {
                const compressedSize = fs.statSync(tempPath).size;
                fs.renameSync(tempPath, finalPath);
                cb(null, { destination, filename, path: finalPath, size: compressedSize });
              })
              .catch(err => {
                try { fs.unlinkSync(tempPath); } catch (_) {}
                try {
                  fs.writeFileSync(finalPath, buffer);
                  cb(null, { destination, filename, path: finalPath, size: buffer.length });
                } catch (__) {
                  cb(err);
                }
              });
          })
          .catch(err => {
            sharp(buffer)
              .resize(this.maxWidth, this.maxHeight, { 
                fit: 'inside',
                withoutEnlargement: true 
              })
              .jpeg({ quality: this.quality, mozjpeg: true })
              .png({ quality: this.quality, compressionLevel: 9 })
              .webp({ quality: this.quality })
              .toFile(tempPath)
              .then(() => {
                const compressedSize = fs.statSync(tempPath).size;
                fs.renameSync(tempPath, finalPath);
                cb(null, { destination, filename, path: finalPath, size: compressedSize });
              })
              .catch(err2 => {
                try { fs.unlinkSync(tempPath); } catch (_) {}
                try {
                  fs.writeFileSync(finalPath, buffer);
                  cb(null, { destination, filename, path: finalPath, size: buffer.length });
                } catch (__) {
                  cb(err2);
                }
              });
          });
      } catch (sharpSyncErr) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        try {
          fs.writeFileSync(finalPath, buffer);
          cb(null, { destination, filename, path: finalPath, size: buffer.length });
        } catch (__) {
          cb(sharpSyncErr);
        }
      }
    });
    
    file.stream.on('error', (err) => {
      try { fs.unlinkSync(tempPath); } catch (_) {}
      cb(err);
    });
  }

  _compressVideo(file, destination, filename, cb) {
    const finalPath = path.join(destination, filename);
    const tempPath = finalPath + '.tmp';
    const writeStream = fs.createWriteStream(tempPath);
    
    file.stream.pipe(writeStream);
    
    writeStream.on('finish', () => {
      const outputFilename = filename.replace(/\.[^.]+$/, '.mp4');
      const outputPath = path.join(destination, outputFilename);
      
      ffmpeg(tempPath)
        .outputOptions([
          '-c:v libx264',
          '-crf 28', // Quality level (23-28 is good, higher = smaller file)
          '-preset medium', // Encoding speed vs compression
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart', // Enable streaming
        ])
        .duration(this.maxVideoDuration)
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Video compression: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          try {
            fs.unlinkSync(tempPath);
            const compressedSize = fs.statSync(outputPath).size;
            cb(null, {
              destination: destination,
              filename: outputFilename,
              path: outputPath,
              size: compressedSize
            });
          } catch (err) {
            cb(err);
          }
        })
        .on('error', (err) => {
          try { fs.unlinkSync(tempPath); } catch (_) {}
          cb(err);
        })
        .save(outputPath);
    });
    
    writeStream.on('error', cb);
  }

  _removeFile(req, file, cb) {
    fs.unlink(file.path, cb);
  }
}

function createCompressedStorage(options) {
  return new CompressedStorage(options);
}

const APP_PORT = process.env.PORT || 3002;
const STORAGE_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_ROOT_DIR = path.join(STORAGE_ROOT, 'uploads');
fs.mkdirSync(UPLOAD_ROOT_DIR, { recursive: true });
const UPLOAD_DIR = path.join(UPLOAD_ROOT_DIR, 'kyc');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PRODUCT_UPLOAD_DIR = path.join(UPLOAD_ROOT_DIR, 'products');
fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
const USER_UPLOAD_DIR = path.join(UPLOAD_ROOT_DIR, 'users');
fs.mkdirSync(USER_UPLOAD_DIR, { recursive: true });
const BRAND_UPLOAD_DIR = path.join(UPLOAD_ROOT_DIR, 'brand');
fs.mkdirSync(BRAND_UPLOAD_DIR, { recursive: true });
const COMPANY_DOCS_DIR = path.join(UPLOAD_ROOT_DIR, 'company_docs');
fs.mkdirSync(COMPANY_DOCS_DIR, { recursive: true });
const SUPPORT_UPLOAD_DIR = path.join(UPLOAD_ROOT_DIR, 'tickets');
fs.mkdirSync(SUPPORT_UPLOAD_DIR, { recursive: true });
const RECEIPT_UPLOAD_DIR = path.join(UPLOAD_ROOT_DIR, 'receipts');
fs.mkdirSync(RECEIPT_UPLOAD_DIR, { recursive: true });
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

try {
  const DEFAULT_STORAGE_ROOT = path.join(__dirname, '..');
  if (path.resolve(STORAGE_ROOT) !== path.resolve(DEFAULT_STORAGE_ROOT)) {
    const oldData = path.join(DEFAULT_STORAGE_ROOT, 'data');
    if (fs.existsSync(oldData) && !fs.existsSync(DATA_DIR)) {
      fs.cpSync(oldData, DATA_DIR, { recursive: true, force: true });
    }
    const oldUploads = path.join(DEFAULT_STORAGE_ROOT, 'public', 'uploads');
    if (fs.existsSync(oldUploads)) {
      fs.cpSync(oldUploads, UPLOAD_ROOT_DIR, { recursive: true, force: true });
    }
  }
} catch (_) {}
const storage = createCompressedStorage({
  destination: (req, file, cb) => {
    const uid = req.session && req.session.user ? req.session.user.id : 'anonymous';
    const dest = path.join(UPLOAD_DIR, String(uid));
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname || '') || '.jpg';
    cb(null, `${file.fieldname}_${ts}${ext}`);
  },
  quality: 92,
  maxWidth: 2000,
  maxHeight: 2000,
  autoRotate: true
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const allowed = ['image/jpeg','image/png','image/gif','image/webp','application/pdf']; cb(allowed.includes(file.mimetype) ? null : new Error('Only images and PDF allowed'), allowed.includes(file.mimetype)); } });
const uploadProduct = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, PRODUCT_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `prod_${ts}${ext}`);
    },
    quality: 85,
    maxWidth: 1200,
    maxHeight: 1200
  }),
  fileFilter: (req, file, cb) => { cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')); },
  limits: { fileSize: 10 * 1024 * 1024 }
});
const uploadProfile = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => {
      const uid = req.session && req.session.user ? req.session.user.id : 'anonymous';
      const dest = path.join(USER_UPLOAD_DIR, String(uid));
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `profile_${ts}${ext}`);
    },
    quality: 92,
    maxWidth: 1000,
    maxHeight: 1000,
    autoRotate: true
  }),
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, or WEBP images allowed'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});
const uploadBrand = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, BRAND_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `brand_${ts}${ext}`);
    },
    quality: 92,
    maxWidth: 400,
    maxHeight: 200,
    trim: true
  }),
  fileFilter: (req, file, cb) => { cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')); },
  limits: { fileSize: 10 * 1024 * 1024 }
});
const uploadCompanyDoc = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, COMPANY_DOCS_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.pdf';
      cb(null, `doc_${ts}${ext}`);
    },
    quality: 85,
    maxWidth: 1920,
    maxHeight: 1080
  }),
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, or PDF allowed'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});
const uploadSupport = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, SUPPORT_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `ticket_${ts}${ext}`);
    },
    quality: 80,
    maxWidth: 1920,
    maxHeight: 1080
  }),
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, or PDF allowed'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

const CMS_DIR = path.join(UPLOAD_ROOT_DIR, 'cms');
fs.mkdirSync(CMS_DIR, { recursive: true });
const uploadCMS = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CMS_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.pdf';
      cb(null, `cms_${ts}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => { const allowed = ['image/jpeg','image/png','image/gif','application/pdf']; cb(allowed.includes(file.mimetype) ? null : new Error('Only images and PDF allowed'), allowed.includes(file.mimetype)); },
  limits: { fileSize: 10 * 1024 * 1024 }
});

const PAYMENT_SCREENSHOT_DIR = path.join(UPLOAD_ROOT_DIR, 'payment_screenshots');
fs.mkdirSync(PAYMENT_SCREENSHOT_DIR, { recursive: true });
const uploadPaymentScreenshot = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, PAYMENT_SCREENSHOT_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `payment_${ts}${ext}`);
    },
    quality: 80,
    maxWidth: 1200,
    maxHeight: 1600
  }),
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, or PDF allowed'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

let USE_MYSQL = (process.env.USE_MYSQL || 'true').toLowerCase() === 'true';
let _dbLoaded = false;

function loadDB() {
  if (USE_MYSQL && !_dbLoaded) {
    console.log('[DB] Using MySQL backend');
    return { _useMySQL: true };
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      users: [],
      products: [],
      settings: { leadership_bonus_enabled: true, auto_binary_on_bv: false },
      earnings: [],
      payouts: [],
      tickets: [],
      pin_packages: [],
      celebrations: [],
      free_products: [],
      free_product_issues: [],
      gallery: [],
      counters: { user: 0, product: 0, earning: 0, payout: 0, pin_package: 0, ticket: 0, celebration: 0, free_product: 0, free_product_issue: 0, gallery: 0 }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Always ensure db.settings exists
  if (!db.settings) db.settings = {};
  // Parse any JSON-stringified values in settings back to arrays/objects
  for (const key of Object.keys(db.settings)) {
    const v = db.settings[key];
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try { db.settings[key] = JSON.parse(v); } catch (e) {}
    }
  }
  if (db.settings.auto_binary_on_bv === undefined) {
    db.settings.auto_binary_on_bv = false;
  }
  // Force leadership bonus enabled
  db.settings.leadership_bonus_enabled = true;
  
  // DEDUPLICATE INVOICES ON LOAD
  if (db.invoices && db.invoices.length > 0) {
    const seen = new Set();
    const originalCount = db.invoices.length;
    db.invoices = db.invoices.filter(inv => {
      const key = inv.invoice_no || inv.order_no;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (db.invoices.length !== originalCount) {
      console.log('[DEDUPE] Removed', originalCount - db.invoices.length, 'duplicate invoices on load');
      // Save cleaned database
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    }
  }
  
  return db;
}

let _saveTimer = null;
function saveDB(db) {
  if (USE_MYSQL && db._mysqlLoaded) {
    mysqlAdapter.markDirty('celebrations');
    mysqlAdapter.markDirty('settings');
    mysqlAdapter.markDirty('counters');
    mysqlAdapter.ALL_COLLECTIONS.forEach(c => { if (db[c]) mysqlAdapter.markDirty(c); });
  }
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      console.log('[SAVE DB] Writing to:', DB_FILE, 'Users:', (db.users||[]).length, 'Counter:', db.counters.user);
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
      console.log('[SAVE DB] Success');
    } catch (e) {
      console.error('[SAVE DB] Error:', e.message);
    }
  }, 600);
}

function backupDB(tag) {
  const ts = Date.now();
  const name = tag ? `backup_${ts}_${tag}.json` : `backup_${ts}.json`;
  const dest = path.join(BACKUP_DIR, name);
  try {
    fs.copyFileSync(DB_FILE, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

function listBackups() {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const p = path.join(BACKUP_DIR, f);
    const s = fs.statSync(p);
    return { name: f, size: s.size, mtime: s.mtimeMs };
  }).sort((a,b) => b.mtime - a.mtime);
}

function restoreFromBackup(filename) {
  const safe = path.basename(filename);
  const src = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(src)) throw new Error('Backup not found');
  const raw = fs.readFileSync(src, 'utf8');
  const next = JSON.parse(raw);
  fs.writeFileSync(DB_FILE, JSON.stringify(next, null, 2));
  db = next;
}

let db = {};

async function initDatabase() {
  if (USE_MYSQL) {
    try {
      console.log('[DB] Loading data from MySQL...');
      const loaded = await mysqlAdapter.loadAllFromMySQL();
      Object.assign(db, loaded);
      db._mysqlLoaded = true;
      global._db = db;
      console.log('[DB] MySQL loaded: Users:', (db.users||[]).length, 'Earnings:', (db.earnings||[]).length);
    } catch (err) {
      console.error('[DB] MySQL load failed, falling back to JSON:', err.message);
      USE_MYSQL = false;
      Object.assign(db, loadDB());
    }
  } else {
    Object.assign(db, loadDB());
  }
}

// Fix duplicate user IDs if any
(async function bootstrap() {
await initDatabase();
  const seenIds = new Set();
  let maxId = 0;
  db.users.forEach(u => {
    if (u.id) maxId = Math.max(maxId, u.id);
  });
  db.users.forEach(u => {
    if (!u.id || seenIds.has(u.id)) {
      maxId++;
      u.id = maxId;
      console.log('Fixed duplicate/missing ID for user:', u.user_code, '-> new ID:', u.id);
    }
    seenIds.add(u.id);
  });
  db.counters.user = Math.max(db.counters.user || 0, maxId);
  saveDB(db);


if (!db.settings) {
  db.settings = {
    pv_on_join: 4000,
    pair_amount_inr: 500,
    pair_bv_size: 4000,
    daily_cap_inr: 5000,
    flush_time: '23:59:59',
    weekly_cap_inr: 120,
    weekly_cap_pairs: 120,
    repurchase_pair_bv_size: 4000,
    repurchase_pair_amount_inr: 500,
    repurchase_weekly_cap_pairs: 120,
    weekly_flush_day: 'Friday',
    weekly_flush_time: '02:00:00',
    default_sponsor_username: 'admin',
    auto_binary_on_bv: false,
    company_gstin: '',
    brand_logo_url: null,
    star_winner_enabled: true,
    star_target_left: 2,
    star_target_right: 2,
    registration_success_message: '✅ Registration successful! Welcome {name} — Your ID: {code}',
    updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
  };
}

// Auto-detect brand logo if not set
if (!db.settings.brand_logo_url) {
  const brandPaths = [
    path.join(__dirname, '..', 'public', 'uploads', 'brand'),
    path.join(__dirname, '..', 'uploads', 'brand')
  ];
  for (const brandDir of brandPaths) {
    if (fs.existsSync(brandDir)) {
      const files = fs.readdirSync(brandDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
      if (files.length > 0) {
        db.settings.brand_logo_url = '/brand/' + files[0];
        console.log('Auto-detected logo:', db.settings.brand_logo_url);
        saveDB(db);
        break;
      }
    }
  }
}

// settings migration for weekly cap/flush
if (db.settings && (db.settings.weekly_cap_inr === undefined || db.settings.weekly_flush_day === undefined || db.settings.weekly_flush_time === undefined)) {
  db.settings.weekly_cap_inr = db.settings.weekly_cap_inr ?? 120;
  db.settings.weekly_flush_day = db.settings.weekly_flush_day ?? 'Friday';
  db.settings.weekly_flush_time = db.settings.weekly_flush_time ?? '02:00:00';
  saveDB(db);
}

// Initialize default rank rules if empty
if (!db.rank_rules || db.rank_rules.length === 0) {
  db.rank_rules = [
    {
      id: 1,
      name: 'STAR WINNER',
      criteria_type: 'direct_joins_7_days',
      target_left: 2,
      target_right: 2,
      left_pv: 0,
      right_pv: 0,
      order: 0,
      active: true,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    }
  ];
  saveDB(db);
}
// migration for weekly cap pairs
if (db.settings && db.settings.weekly_cap_pairs === undefined) {
  db.settings.weekly_cap_pairs = 120;
  saveDB(db);
}
// migration for default sponsor
if (db.settings && db.settings.default_sponsor_username === undefined) {
  db.settings.default_sponsor_username = 'admin';
  saveDB(db);
}
if (db.settings && db.settings.company_gstin === undefined) {
  db.settings.company_gstin = '';
  saveDB(db);
}
if (db.settings && db.settings.pair_bv_size === undefined) {
  db.settings.pair_bv_size = db.settings.pv_on_join || 4000;
  saveDB(db);
}
if (db.settings && db.settings.auto_binary_on_bv === undefined) {
  db.settings.auto_binary_on_bv = false;
  saveDB(db);
}
if (db.settings && db.settings.star_winner_enabled === undefined) {
  db.settings.star_winner_enabled = true;
  saveDB(db);
}
if (db.settings && db.settings.star_target_left === undefined) {
  db.settings.star_target_left = 2;
  saveDB(db);
}
if (db.settings && db.settings.star_target_right === undefined) {
  db.settings.star_target_right = 2;
  saveDB(db);
}
// migration for repurchase pair settings
if (db.settings && db.settings.repurchase_pair_bv_size === undefined) {
  db.settings.repurchase_pair_bv_size = db.settings.pair_bv_size || 4000;
  saveDB(db);
}
if (db.settings && db.settings.repurchase_pair_amount_inr === undefined) {
  db.settings.repurchase_pair_amount_inr = 500;
  saveDB(db);
}
if (db.settings && db.settings.repurchase_weekly_cap_pairs === undefined) {
  db.settings.repurchase_weekly_cap_pairs = 120;
  saveDB(db);
}
if (db.settings && db.settings.registration_success_message === undefined) {
  db.settings.registration_success_message = '✅ Registration successful! Welcome {name} — Your ID: {code}';
  saveDB(db);
}
// migration for existing users repurchase carry fields
(db.users || []).forEach(u => {
  if (u.role === 'user' && u.repurchase_carry_left === undefined) {
    u.repurchase_carry_left = 0;
    u.repurchase_carry_right = 0;
  }
});
// NOTE: repurchase_carry and regular carry are tracked separately
// repurchase_carry can exceed carry since they represent different BV types
if (!db.celebrations) {
  db.celebrations = [];
  saveDB(db);
}
if (!db.free_products) {
  db.free_products = [];
  saveDB(db);
}
if (!db.free_product_issues) {
  db.free_product_issues = [];
  saveDB(db);
}
if (!db.gallery) {
  db.gallery = [];
  saveDB(db);
}

function nextId(kind) {
  db.counters[kind] = (db.counters[kind] || 0) + 1;
  saveDB(db);
  return db.counters[kind];
}

function cleanupUnusedPins() {
  if (!db.settings) return;
  const beforePkg = (db.pin_packages || []).length;
  const beforeFP = (db.franchise_pins || []).length;
  const beforePins = (db.pins || []).length;

  // Clean pin_packages (admin, user, franchise)
  if (db.pin_packages) {
    db.pin_packages = db.pin_packages.filter(p => p.used_by);
  }
  // Clean franchise_pins
  if (db.franchise_pins) {
    db.franchise_pins = db.franchise_pins.filter(p => p.used_by);
  }
  // Clean legacy db.pins
  if (db.pins) {
    db.pins = db.pins.filter(p => p.used_by);
  }

  const removedPkg = beforePkg - (db.pin_packages || []).length;
  const removedFP = beforeFP - (db.franchise_pins || []).length;
  const removedPins = beforePins - (db.pins || []).length;
  if (removedPkg > 0 || removedFP > 0 || removedPins > 0) {
    saveDB(db);
    console.log('[PIN CLEANUP] Removed unused: ' + removedPkg + ' pin_packages, ' + removedFP + ' franchise_pins, ' + removedPins + ' legacy pins');
  }
}

function scheduleMidnightCleanup() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const midnight = now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  let msTillMidnight = midnight.plus({ days: 1 }).toMillis() - now.toMillis();
  // If already past midnight, schedule for next midnight
  if (msTillMidnight < 0) msTillMidnight += 86400000;
  setTimeout(() => {
    cleanupUnusedPins();
    // Repeat every 24 hours
    setInterval(cleanupUnusedPins, 86400000);
  }, msTillMidnight);
  console.log('[PIN CLEANUP] Scheduled for midnight IST (in ' + Math.round(msTillMidnight / 60000) + ' min)');
}
scheduleMidnightCleanup();



// ========== BIRTHDAY EMAIL SCHEDULER ==========
async function sendBirthdayEmails() {
  try {
    const s = db.settings || {};
    const es = s.email_settings || {};
    if (!es.smtp_host || !es.smtp_user || !es.smtp_pass) {
      console.log('[BIRTHDAY] SMTP not configured, skipping');
      return;
    }

    const today = DateTime.now().setZone('Asia/Kolkata');
    const todayMonth = today.month - 1;
    const todayDate = today.day;

    const birthdayUsers = (db.users || []).filter(u => {
      if (!u.dob || u.role !== 'user') return false;
      const bd = new Date(u.dob);
      return bd.getMonth() === todayMonth && bd.getDate() === todayDate;
    });

    if (birthdayUsers.length === 0) {
      console.log('[BIRTHDAY] No birthdays today');
      return;
    }

    const transporter = nodemailer.createTransport({
      host: es.smtp_host,
      port: es.smtp_port || 587,
      secure: es.smtp_port === 465,
      auth: { user: es.smtp_user, pass: es.smtp_pass }
    });

    const companyName = s.company_name || s.brand_name || 'Nastige';
    let sentCount = 0;

    for (const user of birthdayUsers) {
      if (!user.email) continue;
      const userName = user.member_name || user.username;
      const userCode = user.user_code || user.username;

      try {
        await transporter.sendMail({
          from: `"${es.from_name || companyName}" <${es.from_email || es.smtp_user}>`,
          to: user.email,
          subject: `🎂 Happy Birthday, ${userName}!`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f8fafc;">
              <div style="background:linear-gradient(135deg,#fbbf24,#f59e0b,#fbbf24);padding:30px;border-radius:16px 16px 0 0;text-align:center;">
                <h1 style="color:#78350f;margin:0;font-size:32px;">🎂 Happy Birthday!</h1>
              </div>
              <div style="background:white;padding:30px;border-radius:0 0 16px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
                <p style="font-size:18px;color:#374151;">Dear <strong>${userName}</strong>,</p>
                <p style="font-size:16px;color:#374151;line-height:1.8;">
                  On behalf of the entire <strong>${companyName}</strong> family, we wish you a very <span style="color:#f59e0b;font-weight:700;">Happy Birthday</span>! 🎉🎈
                </p>
                <div style="background:linear-gradient(135deg,#fef3c7,#fde68a);padding:20px;border-radius:12px;margin:20px 0;text-align:center;">
                  <p style="margin:0;font-size:18px;color:#92400e;">
                    🎁 May this special day bring you<br/>
                    <strong>joy, success, and endless happiness!</strong>
                  </p>
                </div>
                <p style="font-size:15px;color:#374151;line-height:1.8;">
                  🌟 Thank you for being a valued member of our team.<br/>
                  🚀 We wish you continued growth and success in the year ahead!
                </p>
                <p style="font-size:15px;color:#374151;">
                  Your Member ID: <span style="color:#667eea;font-weight:700;">${userCode}</span>
                </p>
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:25px 0;">
                <p style="color:#6b7280;font-size:14px;text-align:center;">
                  With warm wishes,<br/>
                  <strong>${companyName} Team</strong> 🎂
                </p>
              </div>
            </div>
          `
        });
        sentCount++;
        console.log('[BIRTHDAY] Email sent to:', userCode, userName);
      } catch (err) {
        console.error('[BIRTHDAY] Failed for', userCode, err.message);
      }
    }

    console.log('[BIRTHDAY] Total sent:', sentCount, '/', birthdayUsers.length);
  } catch (e) {
    console.error('[BIRTHDAY] Scheduler error:', e.message);
  }
}

function scheduleBirthdayEmails() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const target = now.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  let msTillTarget = target.toMillis() - now.toMillis();
  if (msTillTarget < 0) msTillTarget += 86400000;
  setTimeout(() => {
    sendBirthdayEmails();
    setInterval(sendBirthdayEmails, 86400000);
  }, msTillTarget);
  console.log('[BIRTHDAY] Scheduler started — will run daily at 8 AM IST (in ' + Math.round(msTillTarget / 60000) + ' min)');
}
scheduleBirthdayEmails();



// ========== DAILY MYSQL BACKUP (5 AM IST) ==========
const MYSQL_BACKUP_DIR = path.join(BACKUP_DIR, 'mysql');
fs.mkdirSync(MYSQL_BACKUP_DIR, { recursive: true });

async function dailyMySQLBackup() {
  if (!USE_MYSQL) {
    console.log('[MYSQL-BACKUP] MySQL not enabled, skipping');
    return null;
  }
  const conn = await mysqlAdapter.getPool().getConnection();
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `mysql_backup_${ts}.sql`;
    const filepath = path.join(MYSQL_BACKUP_DIR, filename);
    let sql = '-- Nastige MLM MySQL Auto Backup\n';
    sql += `-- Date: ${new Date().toISOString()}\n\n`;
    sql += 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n';

    const tables = mysqlAdapter.ALL_COLLECTIONS.concat(['settings', 'counters']);
    for (const table of tables) {
      try {
        const [createRows] = await conn.execute(`SHOW CREATE TABLE \`${table}\``);
        if (createRows.length > 0) {
          sql += `-- Table: ${table}\n`;
          sql += `DROP TABLE IF EXISTS \`${table}\`;\n`;
          sql += createRows[0]['Create Table'] + ';\n\n';
        }
        const [rows] = await conn.execute(`SELECT * FROM \`${table}\``);
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const quotedCols = cols.map(c => `\`${c}\``).join(', ');
          for (const row of rows) {
            const vals = cols.map(c => {
              const v = row[c];
              if (v === null) return 'NULL';
              if (typeof v === 'number') return String(v);
              if (typeof v === 'boolean') return v ? '1' : '0';
              if (typeof v === 'object') return conn.escape(JSON.stringify(v));
              return conn.escape(String(v));
            }).join(', ');
            sql += `INSERT INTO \`${table}\` (${quotedCols}) VALUES (${vals});\n`;
          }
          sql += '\n';
          console.log(`[MYSQL-BACKUP] ${table}: ${rows.length} rows`);
        }
      } catch (e) {
        sql += `-- Skipped ${table}: ${e.message}\n\n`;
      }
    }

    sql += 'SET FOREIGN_KEY_CHECKS=1;\n';
    fs.writeFileSync(filepath, sql, 'utf8');
    const stats = fs.statSync(filepath);
    console.log(`[MYSQL-BACKUP] Complete: ${filename} (${(stats.size / 1024).toFixed(1)} KB)`);

    // Delete backups older than 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const oldFiles = fs.readdirSync(MYSQL_BACKUP_DIR).filter(f => f.startsWith('mysql_backup_'));
    for (const f of oldFiles) {
      const fp = path.join(MYSQL_BACKUP_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          console.log(`[MYSQL-BACKUP] Deleted old: ${f}`);
        }
      } catch (_) {}
    }

    return filepath;
  } catch (e) {
    console.error('[MYSQL-BACKUP] Error:', e.message);
    return null;
  } finally {
    conn.release();
  }
}

function scheduleDailyBackup() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const target = now.set({ hour: 5, minute: 0, second: 0, millisecond: 0 });
  let msTillTarget = target.toMillis() - now.toMillis();
  if (msTillTarget < 0) msTillTarget += 86400000;
  setTimeout(() => {
    dailyMySQLBackup();
    setInterval(dailyMySQLBackup, 86400000);
  }, msTillTarget);
  console.log('[MYSQL-BACKUP] Scheduled for 5 AM IST daily (in ' + Math.round(msTillTarget / 60000) + ' min)');
}
scheduleDailyBackup();




// Restore STAR WINNER rank from rank_history + celebrations for users who lost it
[(db.rank_history || []).map(h => ({ user_id: h.user_id, rank_name: h.rank_name, achieved_at: h.achieved_at })),
 (db.celebrations || []).filter(c => c.rank_achieved === 'STAR WINNER').map(c => ({ user_id: c.user_id, rank_name: c.rank_achieved, achieved_at: c.celebration_date }))
].flat().forEach(entry => {
  if (entry.rank_name === 'STAR WINNER') {
    const u = getUserById(entry.user_id);
    if (u && u.role === 'user' && u.rank_name !== 'STAR WINNER') {
      u.rank_name = 'STAR WINNER';
      u.rank_updated_at = entry.achieved_at || u.rank_updated_at;
      console.log('[STARTUP] Restored STAR WINNER:', u.user_code, u.member_name);
    }
  }
});

function generateUserCode6() {
  let code = null;
  do {
    const digits = Math.floor(100000 + Math.random() * 900000);
    code = 'NIPL' + String(digits);
  } while (db.users.find(u => u.user_code === code));
  return code;
}

if (!db.users.find(u => u.role === 'admin')) {
  const hash = bcrypt.hashSync('ChangeMe123!', 10);
  db.users.push({
    id: nextId('user'),
    username: 'admin',
    password_hash: hash,
    role: 'admin',
    status: 'active',
    sponsor_id: null,
    placement_parent_id: null,
    placement_side: null,
    left_id: null,
    right_id: null,
    index_num: 1,
    member_code: '1',
    user_code: generateUserCode6(),
    pv: 0,
    carry_left: 0,
    carry_right: 0,
    created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
  });
  saveDB(db);
}

// ensure status field exists for all users
db.users.forEach(u => {
  if (!u.status) u.status = 'active';
});
saveDB(db);
// migrate legacy user codes from C123456 to NIPL123456
try {
  let changed = false;
  (db.users || []).forEach(u => {
    if (u && typeof u.user_code === 'string' && /^C\d{6}$/.test(u.user_code)) {
      const digits = u.user_code.slice(1);
      const next = 'NIPL' + digits;
      if (!db.users.find(x => x.user_code === next)) {
        u.user_code = next;
        changed = true;
      } else {
        // collision safety: generate a fresh code
        u.user_code = generateUserCode6();
        changed = true;
      }
    }
  });
  if (changed) saveDB(db);
} catch (_) {}

// weekly cap sanity: ensure at least one pair can pay if configured too low
if (db.settings && db.settings.weekly_cap_inr > 0 && db.settings.pair_amount_inr > 0 && db.settings.weekly_cap_inr < db.settings.pair_amount_inr) {
  db.settings.weekly_cap_inr = db.settings.pair_amount_inr;
  db.settings.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
}

function todayIST() {
  return DateTime.now().setZone('Asia/Kolkata').toISODate();
}

function nowIST() {
  return DateTime.now().setZone('Asia/Kolkata').toISO();
}

function todayRangeIST() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const start = now.startOf('day').toISO();
  const end = now.endOf('day').toISO();
  return { start, end };
}

function monthRangeIST() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const start = now.startOf('month').toISO();
  const end = now.endOf('month').toISO();
  return { start, end };
}

function getWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(),0,1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
  return weekNo;
}

function getWeekRange(weekNumber, year) {
  // ISO week: Jan 4 is always in week 1. Find the Monday of week 1.
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7; // 1=Mon, 7=Sun
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - dayOfWeek + 1);
  // Now go to the desired week's Monday
  const monday = new Date(week1Monday);
  monday.setDate(week1Monday.getDate() + (weekNumber - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().split('T')[0],
    end: sunday.toISOString().split('T')[0]
  };
}

function groupEarningsByWeek(earnings) {
  const weeks = {};
  earnings.forEach(earning => {
    const date = new Date(earning.created_at);
    const weekNumber = getWeekNumber(date);
    const year = date.getFullYear();
    const key = `${year}-${weekNumber}`;
    
    if (!weeks[key]) {
      weeks[key] = {
        weekNumber,
        year,
        earnings: [],
        dateRange: getWeekRange(weekNumber, year)
      };
    }
    weeks[key].earnings.push(earning);
  });
  
  return Object.values(weeks).sort((a, b) => {
    if (a.year === b.year) return b.weekNumber - a.weekNumber;
    return b.year - a.year;
  });
}

function groupPayoutsByWeek(payouts) {
  const allPlansLB = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
  const defaultPlanLB = allPlansLB[0] ? allPlansLB[0].leadership_bonus_inr : 0;
  
  const weeks = {};
  payouts.forEach(p => {
    const date = new Date(p.created_at);
    const weekNumber = getWeekNumber(date);
    const year = date.getFullYear();
    const key = `${year}-${weekNumber}`;
    
    // Recalculate LB gross from earnings for this payout
    let recalcLBGross = 0;
    let parsedEarningIds = p.earning_ids;
    if (typeof parsedEarningIds === 'string') { try { parsedEarningIds = JSON.parse(parsedEarningIds); } catch(e) { parsedEarningIds = []; } }
    if (Array.isArray(parsedEarningIds) && parsedEarningIds.length > 0) {
      // Ensure both payout earning_ids and earning IDs are compared as numbers
      const payoutEarningIds = parsedEarningIds.map(id => typeof id === 'number' ? id : parseInt(String(id), 10));
      recalcLBGross = (db.earnings || [])
        .filter(e => {
          const eId = typeof e.id === 'number' ? e.id : parseInt(String(e.id), 10);
          return payoutEarningIds.includes(eId) && e.note === 'Leadership bonus';
        })
        .reduce((sum, e) => {
          const pin = (db.pin_packages || []).find(pin => pin.used_by === e.source_user_id);
          let lbAmt = 0;
          let lbPlan = null;
          if (pin && pin.plan_id) {
            lbPlan = (db.plans || []).find(pl => pl.id === pin.plan_id);
            lbAmt = lbPlan ? lbPlan.leadership_bonus_inr || 0 : 0;
          }
          if (!lbPlan && e.plan_id) {
            lbPlan = (db.plans || []).find(pl => pl.id === e.plan_id);
            lbAmt = lbPlan ? lbPlan.leadership_bonus_inr || 0 : 0;
           }
           if (!lbAmt) lbAmt = defaultPlanLB;
           console.log('[WEEKLY-LB] payoutId:', p.id, 'earningId:', e.id, 'source_user_id:', e.source_user_id, 'plan_id:', e.plan_id, 'lbAmt:', lbAmt, 'runningTotal:', sum + lbAmt);
           return sum + lbAmt;
         }, 0);
       console.log('[WEEKLY-LB] payout:', p.id, 'final recalcLBGross:', recalcLBGross);
     }
     
     if (!weeks[key]) {
      weeks[key] = {
        weekNumber,
        year,
        payouts: [],
        dateRange: getWeekRange(weekNumber, year),
        totals: { binary_gross: 0, binary_net: 0, repurchase_gross: 0, repurchase_net: 0, lb_gross: 0, lb_net: 0, tds: 0, admin: 0, gross: 0, net: 0, pairs: 0, count: 0 }
      };
    }
    weeks[key].payouts.push({...p, recalc_lb_gross: recalcLBGross});
    const t = weeks[key].totals;
    t.binary_gross += (p.binary_gross || 0);
    t.binary_net += (p.binary_net || 0);
    t.repurchase_gross += (p.repurchase_gross || 0);
    t.repurchase_net += (p.repurchase_net || 0);
    t.lb_gross += (recalcLBGross || p.lb_gross || 0);
    t.lb_net += (p.lb_net || 0);
    // Recalculate gross with correct LB
    const newGross = (p.binary_gross || 0) + (p.repurchase_gross || 0) + (recalcLBGross || p.lb_gross || 0);
    const newTds = Math.round(newGross * 0.02 * 100) / 100;
    const newAdmin = Math.round(newGross * 0.10 * 100) / 100;
    t.tds += newTds;
    t.admin += newAdmin;
    t.gross += newGross;
    t.net += Math.max(0, Math.round((newGross - newTds - newAdmin) * 100) / 100);
    t.pairs += (p.pairs || 0);
    t.count++;
  });
  return Object.values(weeks).sort((a, b) => {
    if (a.year === b.year) return b.weekNumber - a.weekNumber;
    return b.year - a.year;
  });
}

function normalizeAmounts(e) {
  const n = typeof e.net_inr === 'number' ? e.net_inr : (e.amount_inr || 0);
  const g = typeof e.gross_inr === 'number' ? e.gross_inr : Math.round((n / 0.88) * 100) / 100;
  const t = typeof e.tds_inr === 'number' ? e.tds_inr : Math.round(g * 0.02 * 100) / 100;
  const a = typeof e.admin_charge_inr === 'number' ? e.admin_charge_inr : Math.round(g * 0.10 * 100) / 100;
  const net = Math.max(0, Math.round((g - t - a) * 100) / 100);
  return { gross: g, tds: t, admin: a, net };
}

function summarizeEarnings(earnings) {
  return earnings.reduce((acc, e) => {
    const v = normalizeAmounts(e);
    acc.gross += v.gross || 0;
    acc.tds += v.tds || 0;
    acc.admin += v.admin || 0;
    acc.net += v.net || 0;
    return acc;
  }, { gross: 0, tds: 0, admin: 0, net: 0 });
}

function generateChartsData(db) {
  const today = DateTime.now().setZone('Asia/Kolkata');

  // User registrations for last 7 days
  const userRegistrations = [];
  for (let i = 6; i >= 0; i--) {
    const date = today.minus({ days: i });
    const dateStr = date.toFormat('yyyy-MM-dd');
    const count = (db.users || []).filter(u => u.role === 'user' && u.created_at && u.created_at.startsWith(dateStr)).length;
    userRegistrations.push({
      date: date.toFormat('MMM dd'),
      count
    });
  }

  // Earnings trend for last 7 days
  const earningsTrend = [];
  for (let i = 6; i >= 0; i--) {
    const date = today.minus({ days: i });
    const dateStr = date.toFormat('yyyy-MM-dd');
    const total = (db.earnings || []).filter(e => e.created_at && e.created_at.startsWith(dateStr)).reduce((sum, e) => sum + (e.amount_inr || 0), 0);
    earningsTrend.push({
      date: date.toFormat('MMM dd'),
      amount: total
    });
  }

  // Top 10 earners
  const topEarners = (db.users || [])
    .filter(u => u.role === 'user')
    .map(u => ({
      username: u.username,
      total_earnings: (db.earnings || []).filter(e => e.user_id === u.id).reduce((sum, e) => sum + (e.amount_inr || 0), 0)
    }))
    .sort((a, b) => b.total_earnings - a.total_earnings)
    .slice(0, 10);

  // Payout by rank
  const payoutByRank = {};
  (db.users || []).filter(u => u.role === 'user' && u.rank_name).forEach(u => {
    const total = (db.earnings || []).filter(e => e.user_id === u.id).reduce((sum, e) => sum + (e.amount_inr || 0), 0);
    payoutByRank[u.rank_name] = (payoutByRank[u.rank_name] || 0) + total;
  });
  const payoutByRankArray = Object.entries(payoutByRank).map(([rank_name, total]) => ({ rank_name, total })).sort((a, b) => b.total - a.total);

  return {
    userRegistrations,
    earningsTrend,
    topEarners,
    payoutByRank: payoutByRankArray
  };
}

function getSettingsRow() {
  return db.settings;
}

function inrToWords(num) {
  num = Math.round(Number(num || 0));
  if (isNaN(num)) return '';
  if (num === 0) return 'Zero Rupees Only';
  const a = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen'
  ];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const s = (n) => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '');
    return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + s(n % 100) : '');
  };
  const units = [
    { v: 10000000, w: 'Crore' },
    { v: 100000, w: 'Lakh' },
    { v: 1000, w: 'Thousand' },
    { v: 100, w: 'Hundred' }
  ];
  let words = '';
  let n = num;
  for (const u of units) {
    if (n >= u.v) {
      const q = Math.floor(n / u.v);
      words += (words ? ' ' : '') + s(q) + ' ' + u.w;
      n = n % u.v;
    }
  }
  if (n > 0) words += (words ? ' ' : '') + s(n);
  return words + ' Rupees Only';
}

function updateSettings(fields) {
  // Preserve all existing settings, only update specific fields
  const existingSettings = { ...db.settings };
  db.settings = {
    ...existingSettings,
    pv_on_join: fields.pv_on_join ?? existingSettings.pv_on_join,
    pair_amount_inr: fields.pair_amount_inr ?? existingSettings.pair_amount_inr,
    pair_bv_size: fields.pair_bv_size ?? existingSettings.pair_bv_size,
    daily_cap_inr: fields.daily_cap_inr ?? existingSettings.daily_cap_inr,
    flush_time: fields.flush_time ?? existingSettings.flush_time,
    weekly_cap_inr: fields.weekly_cap_inr ?? existingSettings.weekly_cap_inr,
    weekly_cap_pairs: fields.weekly_cap_pairs ?? existingSettings.weekly_cap_pairs,
    repurchase_pair_bv_size: fields.repurchase_pair_bv_size ?? existingSettings.repurchase_pair_bv_size,
    repurchase_pair_amount_inr: fields.repurchase_pair_amount_inr ?? existingSettings.repurchase_pair_amount_inr,
    repurchase_weekly_cap_pairs: fields.repurchase_weekly_cap_pairs ?? existingSettings.repurchase_weekly_cap_pairs,
    weekly_flush_day: fields.weekly_flush_day ?? existingSettings.weekly_flush_day,
    weekly_flush_time: fields.weekly_flush_time ?? existingSettings.weekly_flush_time,
    default_sponsor_username: fields.default_sponsor_username ?? existingSettings.default_sponsor_username,
    auto_binary_on_bv: (fields.auto_binary_on_bv !== undefined) ? !!fields.auto_binary_on_bv : existingSettings.auto_binary_on_bv,
    company_gstin: fields.company_gstin ?? existingSettings.company_gstin,
    updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
  };
  saveDB(db);
}

if (!db.products) {
  db.products = [];
  saveDB(db);
}
if (!db.counters.product) {
  db.counters.product = 0;
  saveDB(db);
}
if (!db.pin_packages) {
  db.pin_packages = [];
  saveDB(db);
}
if (!db.counters.pin_package) {
  db.counters.pin_package = 0;
  saveDB(db);
}
if (!db.company_docs) {
  db.company_docs = [];
  saveDB(db);
}
if (!db.counters.company_doc) {
  db.counters.company_doc = 0;
  saveDB(db);
}
if (!db.tickets) {
  db.tickets = [];
  saveDB(db);
}
if (!db.counters.ticket) {
  db.counters.ticket = 0;
  saveDB(db);
}

if (!db.plans) {
  db.plans = [];
  saveDB(db);
}
if (!db.counters.plan) {
  db.counters.plan = 0;
  saveDB(db);
}

// Franchise storage
if (!db.franchises) {
  db.franchises = [];
  saveDB(db);
}
if (!db.counters.franchise) {
  db.counters.franchise = 0;
  saveDB(db);
}

function getUserByUsername(username) {
  const upper = username.toUpperCase();
  return db.users.find(u => u.username.toUpperCase() === upper) || null;
}

function getUserById(id) {
  return db.users.find(u => u.id === id) || null;
}

function getUserByRef(ref) {
  if (!ref) return null;
  const v = String(ref).trim();
  const up = v.toUpperCase();
  if (/^(?:NIPL)\d{6}$/.test(up) || /^C\d{6}$/.test(up)) {
    return db.users.find(u => String(u.user_code || '').toUpperCase() === up) || null;
  }
  return getUserByUsername(v);
}

function getFranchiseByUsername(username) {
  const upper = username.toUpperCase();
  return (db.franchises || []).find(f => (f.username || '').toUpperCase() === upper) || null;
}
function getFranchiseById(id) {
  const f = (db.franchises || []).find(f => f.id === parseInt(id)) || null;
  if (f && !f.franchise_code) {
    f.franchise_code = generateFranchiseCode6();
    saveDB(db);
  }
  return f;
}
function getFranchiseByRef(ref) {
  if (!ref) return null;
  const v = String(ref).trim().toUpperCase();
  if (/^FR\d{6}$/.test(v)) {
    return (db.franchises || []).find(f => (f.franchise_code || '').toUpperCase() === v) || null;
  }
  return getFranchiseByUsername(String(ref).trim());
}
function generateFranchiseCode6() {
  let code;
  do {
    const n = String((Math.floor(Math.random() * 900000) + 100000));
    code = 'FR' + n;
  } while ((db.franchises || []).find(f => f.franchise_code === code));
  return code;
}

function todayEarningsTotal(userId) {
  const { start, end } = todayRangeIST();
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return db.earnings
    .filter(e => e.user_id === userId && e.status !== 'pending')
    .filter(e => {
      const t = new Date(e.created_at).getTime();
      return t >= startMs && t <= endMs;
    })
    .reduce((s, e) => s + (e.amount_inr || 0), 0);
}

function weeklyRangeIST(settings) {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const weekdays = {
    Sunday: 7, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6
  };
  const wdName = settings.weekly_flush_day || 'Friday';
  const targetWeekday = weekdays[wdName] ?? 5; // Friday default
  const [hh = '02', mm = '00', ss = '00'] = String(settings.weekly_flush_time || '02:00:00').split(':');
  // Luxon weekday: Monday=1..Sunday=7
  let thisWeekFlush = now.set({ hour: parseInt(hh), minute: parseInt(mm), second: parseInt(ss), millisecond: 0 })
    .minus({ days: (now.weekday - targetWeekday + 7) % 7 });
  if (now < thisWeekFlush) {
    thisWeekFlush = thisWeekFlush.minus({ weeks: 1 });
  }
  const nextFlush = thisWeekFlush.plus({ weeks: 1 });
  return { start: thisWeekFlush.toISO(), end: nextFlush.toISO() };
}

// Payout filter: only Binary, Leadership, Repurchase, Direct Referral earnings (exclude Fund Add, Shopping)
function isPayoutEarning(e) {
  const n = (e.note || '');
  return /Binary|Leadership|Repurchase|Direct Referral/i.test(n) && !/Binary Code|Repurchase Code/i.test(n);
}
function sumPayoutEarnings(field) {
  return (db.payouts || []).reduce((s, e) => s + Number(e[field] || 0), 0);
}

function nextFlushDateISO(settings) {
  const { end } = weeklyRangeIST(settings);
  const endDt = DateTime.fromISO(end).setZone('Asia/Kolkata');
  const now = DateTime.now().setZone('Asia/Kolkata');
  return endDt <= now ? endDt.plus({ weeks: 1 }).toISO() : end;
}
function weeklyEarningsTotal(userId) {
  const settings = getSettingsRow();
  const { start, end } = weeklyRangeIST(settings);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return db.earnings
    .filter(e => e.user_id === userId)
    .filter(e => { const t = new Date(e.created_at).getTime(); return t >= startMs && t < endMs; })
    .reduce((s, e) => s + (e.amount_inr || 0), 0);
}

function weeklyPairsPaidTotal(userId) {
  const settings = getSettingsRow();
  const { start, end } = weeklyRangeIST(settings);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return db.earnings
    .filter(e => e.user_id === userId && e.note === 'Binary pair match')
    .filter(e => { const t = new Date(e.created_at).getTime(); return t >= startMs && t < endMs; })
    .reduce((s, e) => s + (e.pairs || 0), 0);
}

async function sendWelcomeEmail(user) {
  try {
    const emailSettings = (db.settings || {}).email_settings || {};
    if (!emailSettings.smtp_host || !emailSettings.smtp_user || !emailSettings.smtp_pass) return;
    if (!user.email) return;
    
    const transporter = nodemailer.createTransport({
      host: emailSettings.smtp_host,
      port: emailSettings.smtp_port || 587,
      secure: emailSettings.smtp_port === 465,
      auth: {
        user: emailSettings.smtp_user,
        pass: emailSettings.smtp_pass
      }
    });
    
    const companyName = emailSettings.company_name || 'Nastige Industries Pvt. Ltd.';
    const userName = user.member_name || user.username;
    const userId = user.user_code || user.username;
    const joinDate = new Date(user.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    
    await transporter.sendMail({
      from: `"${emailSettings.from_name || companyName}" <${emailSettings.from_email || emailSettings.smtp_user}>`,
      to: user.email,
      subject: `Welcome to ${companyName}! Your Registration is Complete`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8fafc;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 16px 16px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to ${companyName}!</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 16px 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <p style="font-size: 16px; color: #374151;">Dear <strong>${userName}</strong>,</p>
            
            <p style="font-size: 18px; color: #10b981; font-weight: 600;">Congratulations! 👏</p>
            
            <p style="font-size: 15px; color: #374151; line-height: 1.8;">
              You have successfully joined the <strong>${companyName}</strong> family.
            </p>
            
            <p style="font-size: 15px; color: #374151; line-height: 1.8;">
              🚀 This is just the beginning of an exciting journey towards growth, success, and new opportunities.
            </p>
            
            <div style="background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); padding: 20px; border-radius: 12px; margin: 20px 0; border-left: 4px solid #667eea;">
              <p style="margin: 8px 0; font-size: 15px;"><strong>💼 Your Registered ID:</strong> <span style="color: #667eea; font-weight: 700; font-size: 18px;">${userId}</span></p>
              <p style="margin: 8px 0; font-size: 15px;"><strong>📅 Joining Date:</strong> ${joinDate}</p>
            </div>
            
            <p style="font-size: 15px; color: #374151; line-height: 1.8;">
              👉 Our team will support and guide you at every step.<br/>
              👉 With proper training and dedication, you can achieve your goals and build a successful future.
            </p>
            
            <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #92400e; font-style: italic;">
                ✨ Remember:<br/>
                <strong>"Success comes to those who take action!"</strong>
              </p>
            </div>
            
            <p style="font-size: 15px; color: #374151; line-height: 1.8;">
              If you need any assistance, feel free to contact your sponsor or team leader.
            </p>
            
            <p style="font-size: 18px; text-align: center; margin: 25px 0;">
              💐 Once again, welcome to the team!<br/>
              <strong>Let's grow together! 💪</strong>
            </p>
            
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 25px 0;">
            
            <p style="color: #6b7280; font-size: 14px; text-align: center;">
              Warm Regards,<br/>
              <strong>${companyName} Team</strong>
            </p>
          </div>
        </div>
      `
    });
    
    console.log('[WELCOME EMAIL] Sent to:', user.email);
  } catch (e) {
    console.error('[WELCOME EMAIL] Failed:', e.message);
  }
}

function addUser({ username, member_name, password, sponsor_ref, placement_parent_ref, placement_side, user_code: providedCode, package_pin, login_pin, email, phone, state, leader_ref, leadership_bonus_inr }) {
  const sponsorUsername = (sponsor_ref && sponsor_ref.trim()) ? sponsor_ref.trim() : (db.settings.default_sponsor_username || 'admin');
  const sponsor = sponsorUsername ? getUserByRef(sponsorUsername) : null;
  let parent = placement_parent_ref ? getUserByRef(placement_parent_ref) : null;
  let ps = placement_side;
  if (Array.isArray(ps)) ps = ps[ps.length - 1];
  let side = ps || null;
  // Automatic spillover (BFS) under sponsor's upline when parent/side not provided
  if (!parent && sponsor) {
    const rootId = sponsor.placement_parent_id || sponsor.id;
    const q = [rootId];
    while (q.length) {
      const id = q.shift();
      const u = getUserById(id);
      if (!u) continue;
      if (!u.left_id) { parent = u; side = 'left'; break; }
      if (!u.right_id) { parent = u; side = 'right'; break; }
      if (u.left_id) q.push(u.left_id);
      if (u.right_id) q.push(u.right_id);
    }
    if (!parent) parent = getUserById(rootId);
  }
  const trimmed = (username || '').trim();
  if (trimmed && getUserByUsername(trimmed)) throw new Error('Username already exists');
  if (!parent) throw new Error('Invalid placement parent');
  if (!['left', 'right'].includes(side)) {
    // Fallback to available side on chosen parent
    if (!parent.left_id) side = 'left';
    else if (!parent.right_id) side = 'right';
  }
  if (!['left', 'right'].includes(side)) throw new Error('Invalid placement side');
  if (side === 'left' && parent.left_id) {
    if (!parent.right_id) side = 'right';
    else throw new Error('Selected parent already has both sides filled');
  }
  if (side === 'right' && parent.right_id) {
    if (!parent.left_id) side = 'left';
    else throw new Error('Selected parent already has both sides filled');
  }
  const hash = bcrypt.hashSync(password, 10);
  const packagePinHash = package_pin ? bcrypt.hashSync(String(package_pin), 10) : null;
  const loginPinHash = login_pin ? bcrypt.hashSync(String(login_pin), 10) : null;
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  const parentIndex = parent.index_num || 1;
  const index_num = side === 'left' ? parentIndex * 2 : parentIndex * 2 + 1;
  const member_code = String(index_num);
  let user_code = (providedCode && /^(?:NIPL)\d{6}$/.test(providedCode) && !db.users.find(u => u.user_code === providedCode))
    ? providedCode
    : generateUserCode6();
  const finalUsername = trimmed || user_code;
  const user = {
    id: nextId('user'),
    username: finalUsername,
    status: 'inactive',
    active: false,
    member_name: (member_name || '').trim() || null,
    password_hash: hash,
    package_pin_hash: packagePinHash,
    login_pin_hash: loginPinHash,
    role: 'user',
    sponsor_id: sponsor ? sponsor.id : null,
    placement_parent_id: parent.id,
    placement_side: side,
    left_id: null,
    right_id: null,
    index_num,
    member_code,
    user_code,
    address_line1: null,
    address_line2: null,
    city: null,
    state: (state || null),
    pincode: null,
    phone: (phone || null),
    email: (email || null),
    leader_ref: (leader_ref || null),
    weekly_cap_inr: null,
    kyc_pan: null,
    kyc_aadhaar: null,
    kyc_status: 'pending',
    kyc_pan_file: null,
    kyc_aadhaar_front_file: null,
    kyc_aadhaar_back_file: null,
    kyc_bank_passbook_file: null,
    kyc_selfie_file: null,
    bank_account_name: null,
    bank_account_number: null,
    bank_ifsc: null,
    bank_name: null,
    bank_branch: null,
    upi_id: null,
    nominee_name: null,
    nominee_relation: null,
    nominee_dob: null,
    pv: 0,
    org_bv_left: 0,
    org_bv_right: 0,
    org_rep_bv_left: 0,
    org_rep_bv_right: 0,
    carry_left: 0,
    carry_right: 0,
    repurchase_carry_left: 0,
    repurchase_carry_right: 0,
    leadership_bonus_inr: leadership_bonus_inr || 0,
    created_at: now
  };
  db.users.push(user);
  if (side === 'left') parent.left_id = user.id;
  else parent.right_id = user.id;
  saveDB(db);
  return user;
}

function findNextSpotInSubtree(rootUserId) {
  if (!rootUserId) return null;
  const q = [rootUserId];
  while (q.length) {
    const id = q.shift();
    const u = getUserById(id);
    if (!u) continue;
    if (!u.left_id) return { parent: u, side: 'left' };
    if (!u.right_id) return { parent: u, side: 'right' };
    q.push(u.left_id);
    q.push(u.right_id);
  }
  return null;
}

function createAutoUser({ username, sponsorId, parentId, side, memberName, planId, bv }) {
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  const pwd = 'matrix123';
  const hash = bcrypt.hashSync(pwd, 10);
  const parent = getUserById(parentId);
  if (!parent) return null;
  const sponsor = sponsorId ? getUserById(sponsorId) : null;
  const parentIndex = parent.index_num || 1;
  const index_num = side === 'left' ? parentIndex * 2 : parentIndex * 2 + 1;
  const bvVal = bv || 0;
  const user = {
    id: nextId('user'),
    username: username || ('AUTO' + String(Date.now()).slice(-6)),
    password_hash: hash,
    role: 'user',
    member_name: memberName || username || ('Auto-' + String(Date.now()).slice(-4)),
    status: 'active',
    active: true,
    activated_at: now,
    sponsor_id: sponsor ? sponsor.id : null,
    placement_parent_id: parent.id,
    placement_side: side,
    left_id: null,
    right_id: null,
    index_num,
    member_code: String(index_num),
    user_code: generateUserCode6(),
    pv: bvVal,
    carry_left: 0, carry_right: 0,
    repurchase_carry_left: 0, repurchase_carry_right: 0,
    org_bv_left: 0,
    org_bv_right: 0,
    org_rep_bv_left: 0, org_rep_bv_right: 0,
    is_auto_created: true,
    created_at: now
  };
  if (planId) user.plan_id = planId;
  db.users.push(user);
  if (side === 'left') {
    parent.left_id = user.id;
    parent.org_bv_left = (parent.org_bv_left || 0) + bvVal;
    parent.carry_left = (parent.carry_left || 0) + bvVal;
  } else {
    parent.right_id = user.id;
    parent.org_bv_right = (parent.org_bv_right || 0) + bvVal;
    parent.carry_right = (parent.carry_right || 0) + bvVal;
  }
  let cur = getUserById(parent.placement_parent_id);
  let prev = parent;
  while (cur) {
    if (cur.left_id === prev.id) {
      cur.org_bv_left = (cur.org_bv_left || 0) + bvVal;
      cur.carry_left = (cur.carry_left || 0) + bvVal;
    } else if (cur.right_id === prev.id) {
      cur.org_bv_right = (cur.org_bv_right || 0) + bvVal;
      cur.carry_right = (cur.carry_right || 0) + bvVal;
    }
    if (!cur.placement_parent_id) break;
    prev = cur;
    cur = getUserById(cur.placement_parent_id);
  }
  saveDB(db);
  return user;
}

function creditJoinPV(userId) {
  const settings = getSettingsRow();
  const pv = settings.pv_on_join || 0;
  const child = getUserById(userId);
  if (!child) return;
  child.pv += pv;
  updateUserRank(child.id);
  let current = child.placement_parent_id ? getUserById(child.placement_parent_id) : null;
  let prev = child;
  while (current) {
    if (current.left_id === prev.id) {
      current.carry_left = (current.carry_left || 0) + pv;
      // processPairsForUser(current.id); // Manual payout only
    } else if (current.right_id === prev.id) {
      current.carry_right = (current.carry_right || 0) + pv;
      // processPairsForUser(current.id); // Manual payout only
    }
    updateUserRank(current.id);
    if (!current.placement_parent_id) break;
    prev = current;
    current = getUserById(current.placement_parent_id);
  }
}

// Check if user should be auto-activated based on accumulated BV
function checkAndActivateUser(user) {
  if (!user || user.role !== 'user') return;
  if (user.status === 'active') return; // Already active
  
  const settings = db.settings || {};
  const requiredBV = settings.pv_on_join || 4000; // Default 4000 BV
  const userBV = user.pv || 0;
  
  // Auto-activate when BV threshold is reached
  if (userBV >= requiredBV) {
    user.status = 'active';
    user.active = true;
    if (!user.activated_at) user.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  }
}

function creditPV(userId, addPv, source) {
  const pv = parseFloat(addPv || 0);
  if (!pv || pv <= 0) return;
  const child = getUserById(userId);
  if (!child) return;
  child.pv += pv;
  
  // Check if user should be auto-activated after BV credit
  checkAndActivateUser(child);
  
  updateUserRank(child.id);
  let current = child.placement_parent_id ? getUserById(child.placement_parent_id) : null;
  let prev = child;
  
  // Also check if parent needs carry update via placement_side
  // This fixes cases where left_id/right_id are null but placement_side is set
  const updateParentCarry = (parent, side, bv) => {
    if (source === 'repurchase') {
      if (side === 'left') {
        parent.repurchase_carry_left = (parent.repurchase_carry_left || 0) + bv;
      } else if (side === 'right') {
        parent.repurchase_carry_right = (parent.repurchase_carry_right || 0) + bv;
      }
    } else {
      if (side === 'left') {
        parent.carry_left = (parent.carry_left || 0) + bv;
      } else if (side === 'right') {
        parent.carry_right = (parent.carry_right || 0) + bv;
      }
    }
  };
  
  while (current) {
    let credited = false;
    const prevId = Number(prev.id);
    const currLeftId = Number(current.left_id);
    const currRightId = Number(current.right_id);
    
    console.log('[creditPV] Debug - prevId:', prevId, 'currLeftId:', currLeftId, 'currRightId:', currRightId, 'source:', source);
    
    // First try via left_id/right_id (primary method) - with type-safe comparison
    if (currLeftId === prevId) {
      if (source === 'repurchase') {
        current.repurchase_carry_left = (current.repurchase_carry_left || 0) + pv;
      } else {
        current.carry_left = (current.carry_left || 0) + pv;
      }
      credited = true;
      console.log('[creditPV] Credited via left_id:', current.username, 'source:', source, 'pv:', pv);
    } else if (currRightId === prevId) {
      if (source === 'repurchase') {
        current.repurchase_carry_right = (current.repurchase_carry_right || 0) + pv;
      } else {
        current.carry_right = (current.carry_right || 0) + pv;
      }
      credited = true;
      console.log('[creditPV] Credited via right_id:', current.username, 'source:', source, 'pv:', pv);
    }
    
    // Fallback: ALWAYS use placement_side as additional safeguard (even if already credited via left_id/right_id)
    // This ensures BV is always propagated regardless of left_id/right_id state
    if (prev.placement_side) {
      console.log('[creditPV] placement_side fallback check:', prev.username, '->', current.username, 'side:', prev.placement_side, 'alreadyCredited:', credited);
      
      // Always apply via placement_side as backup (handles edge cases where left_id/right_id are out of sync)
      if (!credited) {
        if (source === 'repurchase') {
          if (prev.placement_side === 'left') {
            current.repurchase_carry_left = (current.repurchase_carry_left || 0) + pv;
          } else if (prev.placement_side === 'right') {
            current.repurchase_carry_right = (current.repurchase_carry_right || 0) + pv;
          }
        } else {
          if (prev.placement_side === 'left') {
            current.carry_left = (current.carry_left || 0) + pv;
          } else if (prev.placement_side === 'right') {
            current.carry_right = (current.carry_right || 0) + pv;
          }
        }
        console.log('[creditPV] Used placement_side fallback:', prev.username, '->', current.username, 'side:', prev.placement_side);
      }
    }
    
    if (credited && db.settings && db.settings.auto_binary_on_bv) {
      processBinaryPairsForUser(current.id);
    }
    
    try { updateUserRank(current.id); } catch(e) { console.log('[creditPV] rank error:', e.message); }
    if (!current.placement_parent_id) break;
    prev = current;
    current = getUserById(current.placement_parent_id);
  }
  saveDB(db);
}

// Get unpaid leadership bonus for a user (not yet in db.payouts)
function getUnpaidLeadershipBonus(userId) {
  const leadershipEarnings = (db.earnings || []).filter(e => 
    e.user_id === userId && 
    e.note === 'Leadership bonus'
  );
  
  // Get all earning_ids that are already in payouts
  const paidEarningIds = (db.payouts || [])
    .filter(p => p.user_id === userId)
    .flatMap(p => p.earning_ids || [])
    .filter(Boolean);
  
  // Filter out already paid leadership bonuses
  const unpaid = leadershipEarnings.filter(e => !paidEarningIds.includes(e.id));
  
  return unpaid;
}

// UNIFIED Binary Pair Processing
// - Combined carry (activation + repurchase) for pair calculation
// - Weaker leg decides income type (Binary/Repurchase)
// - Matched BV is fully consumed (no balance left in weaker leg)
function processBinaryPairsForUser(userId) {
  const settings = getSettingsRow();
  const user = getUserById(userId);
  if (!user) return;
  if (user.status !== 'active') return;

  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  const { start, end } = weeklyRangeIST(settings);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  // Binary income settings — pair size comes from activated downline user's plan PV (weaker side)
  let binarySize = Math.max(1, settings.pair_bv_size || settings.pv_on_join || 100);
  let binaryPerPair = settings.pair_amount_inr || 500;

  // Find plan PV from direct downline children based on weaker side (lesser carry BV)
  const leftChild = user.left_id ? getUserById(user.left_id) : null;
  const rightChild = user.right_id ? getUserById(user.right_id) : null;
  const leftBV = (user.carry_left || 0) + (user.repurchase_carry_left || 0);
  const rightBV = (user.carry_right || 0) + (user.repurchase_carry_right || 0);

  // Use plan PV from the child on the weaker side (determines pair matching)
  const weakerChild = leftBV <= rightBV ? leftChild : rightChild;
  const strongerChild = leftBV <= rightBV ? rightChild : leftChild;

  if (weakerChild && weakerChild.plan_id) {
    const wPlan = (db.plans || []).find(p => p.id === weakerChild.plan_id);
    if (wPlan && wPlan.pv > 0) binarySize = wPlan.pv;
    if (wPlan && wPlan.pair_amount_inr > 0) binaryPerPair = wPlan.pair_amount_inr;
  } else if (strongerChild && strongerChild.plan_id) {
    const sPlan = (db.plans || []).find(p => p.id === strongerChild.plan_id);
    if (sPlan && sPlan.pv > 0) binarySize = sPlan.pv;
    if (sPlan && sPlan.pair_amount_inr > 0) binaryPerPair = sPlan.pair_amount_inr;
  }

  // Repurchase income settings
  const repSize = Math.max(1, settings.repurchase_pair_bv_size || settings.pair_bv_size || 4000);
  let repPerPair = settings.repurchase_pair_amount_inr || 0;

  // Check already paid pairs this week
  const alreadyBinaryPairs = db.earnings
    .filter(e => e.user_id === userId && e.note === 'Binary pair match')
    .filter(e => { const t = new Date(e.created_at).getTime(); return t >= startMs && t < endMs; })
    .reduce((s, e) => s + (e.pairs || 0), 0);

  const alreadyRepPairs = db.earnings
    .filter(e => e.user_id === userId && e.note === 'Repurchase binary pair match')
    .filter(e => { const t = new Date(e.created_at).getTime(); return t >= startMs && t < endMs; })
    .reduce((s, e) => s + (e.pairs || 0), 0);

  const binaryCap = (typeof user.weekly_cap_pairs === 'number' && user.weekly_cap_pairs >= 0)
    ? user.weekly_cap_pairs : (db.settings.weekly_cap_pairs || 120);
  const repCap = settings.repurchase_weekly_cap_pairs || 0;

  // Store original values for BV tracking (include org_bv from old website)
  const origCarryL = user.carry_left || 0;
  const origCarryR = user.carry_right || 0;
  const origRepL = user.repurchase_carry_left || 0;
  const origRepR = user.repurchase_carry_right || 0;
  const origOrgL = user.org_bv_left || 0;
  const origOrgR = user.org_bv_right || 0;
  const origOrgRepL = user.org_rep_bv_left || 0;
  const origOrgRepR = user.org_rep_bv_right || 0;

  // COMBINED BV matching (only carry — org_bv already paid out from migration)
  const totalLeftBV = origCarryL + origRepL;
  const totalRightBV = origCarryR + origRepR;
  const matchedBV = Math.min(totalLeftBV, totalRightBV);
  const totalPairsPossible = Math.floor(matchedBV / binarySize);
  
  if (totalPairsPossible <= 0) return;
  
  // Apply weekly cap
  const alreadyTotalPairs = alreadyBinaryPairs + alreadyRepPairs;
  const totalCap = Math.max(binaryCap, repCap);
  let pairsToPay = totalPairsPossible;
  if (totalCap > 0) {
    pairsToPay = Math.min(totalPairsPossible, Math.max(totalCap - alreadyTotalPairs, 0));
  }
  
  if (pairsToPay <= 0) return;
  
  // Deduct matched BV from both sides (deduct binary first, then repurchase)
  let leftToDeduct = pairsToPay * binarySize;
  let rightToDeduct = pairsToPay * binarySize;
  
  // Deduct from left side: first carry (binary), then repurchase_carry, then org_bv, then org_rep_bv
  if (leftToDeduct > 0 && (user.carry_left || 0) > 0) {
    const fromCarryL = Math.min(leftToDeduct, user.carry_left);
    user.carry_left -= fromCarryL;
    leftToDeduct -= fromCarryL;
  }
  if (leftToDeduct > 0 && (user.repurchase_carry_left || 0) > 0) {
    const fromRepL = Math.min(leftToDeduct, user.repurchase_carry_left);
    user.repurchase_carry_left -= fromRepL;
    leftToDeduct -= fromRepL;
  }
  if (leftToDeduct > 0 && (user.org_bv_left || 0) > 0) {
    const fromOrgL = Math.min(leftToDeduct, user.org_bv_left);
    user.org_bv_left -= fromOrgL;
    leftToDeduct -= fromOrgL;
  }
  if (leftToDeduct > 0 && (user.org_rep_bv_left || 0) > 0) {
    const fromOrgRepL = Math.min(leftToDeduct, user.org_rep_bv_left);
    user.org_rep_bv_left -= fromOrgRepL;
    leftToDeduct -= fromOrgRepL;
  }
  
  // Deduct from right side: first carry (binary), then repurchase_carry, then org_bv, then org_rep_bv
  if (rightToDeduct > 0 && (user.carry_right || 0) > 0) {
    const fromCarryR = Math.min(rightToDeduct, user.carry_right);
    user.carry_right -= fromCarryR;
    rightToDeduct -= fromCarryR;
  }
  if (rightToDeduct > 0 && (user.repurchase_carry_right || 0) > 0) {
    const fromRepR = Math.min(rightToDeduct, user.repurchase_carry_right);
    user.repurchase_carry_right -= fromRepR;
    rightToDeduct -= fromRepR;
  }
  if (rightToDeduct > 0 && (user.org_bv_right || 0) > 0) {
    const fromOrgR = Math.min(rightToDeduct, user.org_bv_right);
    user.org_bv_right -= fromOrgR;
    rightToDeduct -= fromOrgR;
  }
  if (rightToDeduct > 0 && (user.org_rep_bv_right || 0) > 0) {
    const fromOrgRepR = Math.min(rightToDeduct, user.org_rep_bv_right);
    user.org_rep_bv_right -= fromOrgRepR;
    rightToDeduct -= fromOrgRepR;
  }
  
  // Determine income type: binary first, then repurchase
  // Binary = any side has only activation BV (no repurchase)
  // Repurchase = both sides have repurchase BV involved
  // Determine how many pairs are binary vs repurchase based on BV consumed
  const leftBinaryBV = (user.carry_left || 0) + (user.org_bv_left || 0);
  const rightBinaryBV = (user.carry_right || 0) + (user.org_bv_right || 0);
  const leftRepurchaseBV = (user.repurchase_carry_left || 0) + (user.org_rep_bv_left || 0);
  const rightRepurchaseBV = (user.repurchase_carry_right || 0) + (user.org_rep_bv_right || 0);
  const origLeftBinary = origCarryL + origOrgL;
  const origRightBinary = origCarryR + origOrgR;
  const origLeftRepurchase = origRepL + origOrgRepL;
  const origRightRepurchase = origRepR + origOrgRepR;
  
  // Maximum binary pairs possible from original binary BV
  const maxBinaryPairs = Math.min(Math.floor(origLeftBinary / binarySize), Math.floor(origRightBinary / binarySize));
  // Binary pairs consumed is limited by pairsToPay
  const binaryPairsConsumed = Math.min(maxBinaryPairs, pairsToPay);
  const repurchasePairsConsumed = pairsToPay - binaryPairsConsumed;
  
  // Calculate amounts for each type
  const binaryGross = binaryPairsConsumed * binaryPerPair;
  const binaryTds = Math.round(binaryGross * 0.02 * 100) / 100;
  const binaryAdmin = Math.round(binaryGross * 0.10 * 100) / 100;
  const binaryNet = Math.max(0, Math.round((binaryGross - binaryTds - binaryAdmin) * 100) / 100);
  
  const repurchaseGross = repurchasePairsConsumed * repPerPair;
  const repurchaseTds = Math.round(repurchaseGross * 0.02 * 100) / 100;
  const repurchaseAdmin = Math.round(repurchaseGross * 0.10 * 100) / 100;
  const repurchaseNet = Math.max(0, Math.round((repurchaseGross - repurchaseTds - repurchaseAdmin) * 100) / 100);
  
  const totalGross = binaryGross + repurchaseGross;
  const totalTds = binaryTds + repurchaseTds;
  const totalAdmin = binaryAdmin + repurchaseAdmin;
  const totalNet = binaryNet + repurchaseNet;

  // Leadership bonus processing - only process PENDING ones (already credited ones should not be picked up again)
  const paidEarningIds = (db.payouts || [])
    .filter(p => p.user_id === userId)
    .flatMap(p => {
      let eids = p.earning_ids || [];
      if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(e) { eids = []; } }
      return Array.isArray(eids) ? eids : [];
    })
    .filter(Boolean)
    .map(id => Number(id));
  
  const pendingLB = (db.earnings || []).filter(e =>
    e.user_id === userId && 
    (e.pending_leadership === true || e.pending_leadership === 1) && 
    e.status === 'pending' &&
    !paidEarningIds.includes(Number(e.id))
  );

  let lbGross = 0;
  const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
  const defaultPlan = allPlans[0] || null;

  pendingLB.forEach(lb => {
    // FIX: Only credit LB if the source user (downline) is ACTIVE
    const sourceUser = getUserById(lb.source_user_id);
    if (!sourceUser || sourceUser.status !== 'active') {
      console.log('[LB SKIP] Downline not active - source_user_id:', lb.source_user_id, 'leader:', userId);
      return; // Skip this LB entry
    }

    const pin = (db.pin_packages || []).find(p => p.used_by === lb.source_user_id);
    let lbPlan = null;
    let lbAmount = 0;

    if (pin && pin.plan_id) {
      lbPlan = (db.plans || []).find(pl => pl.id === pin.plan_id) || null;
      lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : 0;
    }
    if (!lbPlan && lb.plan_id) {
      lbPlan = (db.plans || []).find(pl => pl.id === lb.plan_id) || null;
      lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : 0;
    }
    if (!lbAmount) {
      lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
    }

    lb.gross_inr = lbAmount;
    lb.plan_id = lbPlan ? lbPlan.id : (defaultPlan ? defaultPlan.id : null);
    lb.source_pin_code = pin ? (pin.code || null) : (lb.source_pin_code || null);
    lbGross += lb.gross_inr || 0;
    lb.amount_inr = Math.round((lb.gross_inr || 0) * 0.88 * 100) / 100;
    lb.tds_inr = Math.round((lb.gross_inr || 0) * 0.02 * 100) / 100;
    lb.admin_charge_inr = Math.round((lb.gross_inr || 0) * 0.10 * 100) / 100;
    lb.net_inr = lb.amount_inr;
    lb.status = 'credited';
    lb.pending_leadership = false;
    lb.note = 'Leadership bonus';
    lb.credited_at = now;
    console.log('[LB CREDIT] Credited to user:', userId, 'from downline:', lb.source_user_id, 'amount:', lb.amount_inr);
  });

  // Create earning records
  const earningIds = [];
  
  // Binary earning
  if (binaryPairsConsumed > 0) {
    const earningId = nextId('earning');
    db.earnings.push({
      id: earningId,
      user_id: userId,
      amount_inr: binaryNet,
      gross_inr: binaryGross,
      tds_inr: binaryTds,
      admin_charge_inr: binaryAdmin,
      net_inr: binaryNet,
      status: 'credited',
      pairs: binaryPairsConsumed,
      per_pair_amount_inr: binaryPerPair,
      pair_bv_size_used: binarySize,
      used_bv: binaryPairsConsumed * binarySize,
      leg: 'both',
      note: 'Binary pair match',
      created_at: now
    });
    earningIds.push(earningId);
  }
  
  // Repurchase earning
  if (repurchasePairsConsumed > 0) {
    const earningId = nextId('earning');
    db.earnings.push({
      id: earningId,
      user_id: userId,
      amount_inr: repurchaseNet,
      gross_inr: repurchaseGross,
      tds_inr: repurchaseTds,
      admin_charge_inr: repurchaseAdmin,
      net_inr: repurchaseNet,
      status: 'credited',
      pairs: repurchasePairsConsumed,
      per_pair_amount_inr: repPerPair,
      pair_bv_size_used: binarySize,
      used_bv: repurchasePairsConsumed * binarySize,
      leg: 'both',
      note: 'Repurchase binary pair match',
      created_at: now
    });
    earningIds.push(earningId);
  }

  // Leadership bonus already processed in loop above (lines 1530-1566)
  // No need to recalculate - lbGross already contains correct total

  // Add leadership bonus earning IDs (only credited ones)
  earningIds.push(...pendingLB.filter(e => e.status === 'credited').map(e => e.id));

  // Final totals with leadership bonus
    const lbTds = Math.round(lbGross * 0.02 * 100) / 100;
    const lbAdmin = Math.round(lbGross * 0.10 * 100) / 100;
    const lbNet = Math.max(0, Math.round((lbGross - lbTds - lbAdmin) * 100) / 100);
    const finalGross = totalGross + lbGross;
    const finalTds = Math.round((totalGross * 0.02 + lbGross * 0.02) * 100) / 100;
    const finalAdmin = Math.round((totalGross * 0.10 + lbGross * 0.10) * 100) / 100;
    const finalNet = Math.max(0, Math.round((finalGross - finalTds - finalAdmin) * 100) / 100);

  // Create single payout record
  if (pairsToPay > 0 || lbGross > 0) {
    // Calculate LB net properly
    const lbTdsAmount = Math.round(lbGross * 0.02 * 100) / 100;
    const lbAdminAmount = Math.round(lbGross * 0.10 * 100) / 100;
    const lbNetAmount = Math.max(0, Math.round((lbGross - lbTdsAmount - lbAdminAmount) * 100) / 100);
    
    // Inherit transfer_id from existing payouts in same week (if binary re-ran)
    const payoutDate = new Date(now);
    const payoutWeek = getWeekNumber(payoutDate);
    const payoutYear = payoutDate.getFullYear();
    const existingPayout = (db.payouts || []).find(x =>
      x.user_id === userId &&
      getWeekNumber(new Date(x.created_at)) === payoutWeek &&
      new Date(x.created_at).getFullYear() === payoutYear &&
      x.transfer_id
    );
    
    db.payouts.push({
      id: nextId('payout'),
      user_id: userId,
      earning_ids: earningIds,
      amount_inr: finalNet,
      gross_inr: finalGross,
      binary_gross: binaryGross,
      binary_net: binaryNet,
      repurchase_gross: repurchaseGross,
      repurchase_net: repurchaseNet,
      lb_gross: lbGross,
      lb_net: lbNetAmount,
      lb_tds: lbTdsAmount,
      lb_admin: lbAdminAmount,
      tds_inr: finalTds,
      admin_charge_inr: finalAdmin,
      status: existingPayout ? 'completed' : 'pending',
      note: lbGross > 0 ? (binaryPairsConsumed > 0 && repurchasePairsConsumed > 0 ? 'Binary + Repurchase + Leadership' : binaryPairsConsumed > 0 ? 'Binary + Leadership' : 'Repurchase + Leadership') : (binaryPairsConsumed > 0 && repurchasePairsConsumed > 0 ? 'Binary + Repurchase' : binaryPairsConsumed > 0 ? 'Binary' : 'Repurchase'),
      pairs: pairsToPay,
      leadership_bonus: lbNetAmount,
      transfer_id: existingPayout ? existingPayout.transfer_id : null,
      transfer_credentials: existingPayout ? (existingPayout.transfer_credentials || null) : null,
      transfer_date: existingPayout ? existingPayout.transfer_date : null,
      hold_payment: false,
      created_at: now
    });
  }

  saveDB(db);
  mysqlAdapter.flushDirtySync();
}
function processPairsForUser(userId) { processBinaryPairsForUser(userId); }
function processRepurchasePairsForUser(userId, returnOnly) { processBinaryPairsForUser(userId); }

function calculatePairsForUserInPeriod(userId, startDate, endDate) {
  const user = getUserById(userId);
  if (!user) return 0;

  const settings = getSettingsRow();
  const size = Math.max(1, settings.pair_bv_size || settings.pv_on_join || 100);

  // Get all earnings within the period
  const periodEarnings = db.earnings.filter(e => 
    e.user_id === userId &&
    e.created_at >= startDate &&
    e.created_at <= endDate
  );

  // Sum up pairs from earnings
  const totalPairs = periodEarnings.reduce((sum, e) => sum + (e.pairs || 0), 0);

  return totalPairs;
}

function calculateLeftRightPairsInPeriod(userId, startDate, endDate) {
  const user = getUserById(userId);
  if (!user) return { left: 0, right: 0 };
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();

  // Count the root user + all eligible descendants in the subtree (no double-count)
  function countRootAndSubtree(rootId) {
    if (!rootId) return 0;
    let count = 0;
    const root = (db.users || []).find(u => u.id === rootId);
    if (root && root.status === 'active') {
      const t = new Date(root.activated_at || root.created_at).getTime();
      if (t >= startMs && t <= endMs) count++;
    }
    return count + countDescendants(rootId);
  }

  // Count all eligible placement descendants (not counting the root itself)
  function countDescendants(parentId) {
    let count = 0;
    const children = (db.users || []).filter(u => u.placement_parent_id === parentId);
    for (const child of children) {
      if (child.status === 'active') {
        const t = new Date(child.activated_at || child.created_at).getTime();
        if (t >= startMs && t <= endMs) count++;
      }
      count += countDescendants(child.id);
    }
    return count;
  }

  const left = countRootAndSubtree(user.left_id);
  const right = countRootAndSubtree(user.right_id);

  return { left, right };
}

function processOfferAchievements(offerId = null) {
  let offers = db.offers || [];
  if (offerId) {
    offers = offers.filter(o => o.id === offerId);
  } else {
    const now = DateTime.now().setZone('Asia/Kolkata').toISO();
    offers = offers.filter(o => 
      o.is_active && 
      o.start_date <= now && 
      o.end_date >= now
    );
  }

  for (const offer of offers) {
    const users = db.users.filter(u => u.role === 'user' && u.status === 'active');
    const category = offer.category || 'pairs';
    const periodStart = offer.start_date;
    const periodEnd = offer.end_date;

    for (const user of users) {
      let userProgress = 0;
      let leftLegs = 0, rightLegs = 0;

      if (category === 'pairs') {
        const legData = calculateLeftRightPairsInPeriod(user.id, periodStart, periodEnd);
        leftLegs = legData.left;
        rightLegs = legData.right;
        userProgress = Math.min(leftLegs, rightLegs);
      } else if (category === 'repurchase') {
        const repurchaseOrders = (db.orders || []).filter(o => 
          o.user_id === user.id && 
          o.type === 'repurchase' &&
          o.created_at >= periodStart && 
          o.created_at <= periodEnd
        );
        userProgress = repurchaseOrders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
      } else if (category === 'leadership') {
        const leadershipEarnings = (db.earnings || []).filter(e => 
          e.user_id === user.id && 
          (e.note === 'Leadership bonus' || e.note?.toLowerCase().includes('leadership')) &&
          e.created_at >= periodStart && 
          e.created_at <= periodEnd
        );
        userProgress = leadershipEarnings.reduce((sum, e) => sum + (e.gross_inr || e.amount_inr || 0), 0);
      }

      const targetValue = offer.target_pairs || offer.target_bv || offer.target_amount || 0;
      const existingAchievement = (db.offer_achievements || []).find(
        a => a.offer_id === offer.id && a.user_id === user.id
      );

      if (userProgress >= targetValue) {
        const reward = offer.reward_amount || 0;
        const status = existingAchievement ? existingAchievement.status : 'pending';

        if (existingAchievement) {
          existingAchievement.progress_achieved = userProgress;
          existingAchievement.reward_earned = reward;
          existingAchievement.achieved_at = DateTime.now().setZone('Asia/Kolkata').toISO();
          existingAchievement.status = status;
        } else {
          const newAchievement = {
            id: nextId('offer_achievement'),
            offer_id: offer.id,
            user_id: user.id,
            user_code: user.user_code,
            category: category,
            progress_achieved: userProgress,
            left_legs: leftLegs,
            right_legs: rightLegs,
            reward_earned: reward,
            status: 'pending',
            achieved_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
            paid_at: null
          };
          if (!db.offer_achievements) db.offer_achievements = [];
          db.offer_achievements.push(newAchievement);
        }
      }
    }
  }

  saveDB(db);
}

function getWeekRangeIST() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const day = now.weekday;
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = now.minus({ days: diffToMonday }).startOf('day');
  const sunday = monday.plus({ days: 6 }).endOf('day');
  return {
    start: monday.toISO(),
    end: sunday.toISO(),
    weekNumber: now.weekNumber,
    year: now.year
  };
}

function subtreeStats(rootId) {
  if (!rootId) return { count: 0, pv: 0, carry_left: 0, carry_right: 0 };
  let q = [rootId];
  let count = 0;
  let pv = 0;
  let carry_left = 0;
  let carry_right = 0;
  while (q.length) {
    const id = q.shift();
    const u = getUserById(id);
    if (!u) continue;
    count += 1;
    pv += u.pv || 0;
    carry_left += u.carry_left || 0;
    carry_right += u.carry_right || 0;
    if (u.left_id) q.push(u.left_id);
    if (u.right_id) q.push(u.right_id);
  }
  return { count: Math.max(count - 1, 0), pv, carry_left, carry_right };
}

function subtreePVWithin(rootId, startISO, endISO) {
  if (!rootId) return 0;
  let total = 0;
  let q = [rootId];
  while (q.length) {
    const id = q.shift();
    const u = getUserById(id);
    if (!u) continue;
    
    // Get repurchase orders for this user in the date range
    const repurchaseOrders = (db.orders || []).filter(o => 
      o.type === 'repurchase' &&
      o.user_id === id &&
      (!startISO || o.created_at >= startISO) &&
      (!endISO || o.created_at <= endISO)
    );
    total += repurchaseOrders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
    
    if (u.left_id) q.push(u.left_id);
    if (u.right_id) q.push(u.right_id);
  }
  return total;
}

function getSubtreeBVAdjustments(rootId) {
  if (!rootId) return 0;
  let total = 0;
  let q = [rootId];
  while (q.length) {
    const id = q.shift();
    const u = getUserById(id);
    if (!u) continue;
    const adjustments = (db.bv_adjustments || []).filter(a => a.user_id === id);
    adjustments.forEach(a => total += (a.amount || 0));
    if (u.left_id) q.push(u.left_id);
    if (u.right_id) q.push(u.right_id);
  }
  return total;
}

// Get BV adjustments by side from user's ENTIRE tree (both subtrees)
function getAllTreeBVAdjustments(userId, side) {
  if (!userId) return 0;
  let total = 0;
  // Start with the user's own adjustments
  const selfAdj = (db.bv_adjustments || []).filter(a => a.user_id === userId && a.side === side);
  selfAdj.forEach(a => total += (a.amount || 0));
  // Also traverse downline
  let q = [];
  const u = getUserById(userId);
  if (u) {
    if (u.left_id) q.push(u.left_id);
    if (u.right_id) q.push(u.right_id);
  }
  while (q.length) {
    const id = q.shift();
    const node = getUserById(id);
    if (!node) continue;
    const adjustments = (db.bv_adjustments || []).filter(a => a.user_id === id && a.side === side);
    adjustments.forEach(a => total += (a.amount || 0));
    if (node.left_id) q.push(node.left_id);
    if (node.right_id) q.push(node.right_id);
  }
  return total;
}

// Get all upline sponsor IDs (traverse up the placement tree)
function getUplineIds(userId) {
  const upline = [];
  let current = getUserById(userId);
  const visited = new Set();
  while (current && current.placement_parent_id && !visited.has(current.placement_parent_id)) {
    visited.add(current.placement_parent_id);
    upline.push(current.placement_parent_id);
    current = getUserById(current.placement_parent_id);
  }
  return upline;
}

// Get total repurchase BV for a user (all time)
function getUserTotalRepurchaseBV(userId) {
  const orders = (db.orders || []).filter(o => 
    o.type === 'repurchase' && o.user_id === userId
  );
  return orders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
}

// Get repurchase BV for a user in date range
function getUserRepurchaseBVInRange(userId, startISO, endISO) {
  const orders = (db.orders || []).filter(o => 
    o.type === 'repurchase' &&
    o.user_id === userId &&
    (!startISO || o.created_at >= startISO) &&
    (!endISO || o.created_at <= endISO)
  );
  return orders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
}

function getUserRepurchaseStats(userId, startISO, endISO) {
  const user = getUserById(userId);
  if (!user) return { count: 0, total_bv: 0, total_inr: 0, orders: [] };
  // Count APPROVED orders (payment_status === 'paid')
  const orders = (db.orders || []).filter(o =>
    o.type === 'repurchase' &&
    o.user_id === userId &&
    o.payment_status === 'paid' &&
    (!startISO || o.created_at >= startISO) &&
    (!endISO || o.created_at <= endISO)
  );
  const total_bv = orders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
  const total_inr = orders.reduce((sum, o) => sum + (o.total_inr || 0), 0);
  
  // Also add repurchase_carry_left + repurchase_carry_right as monthly repurchase BV
  // This comes from franchise orders and other sources
  const repurchaseCarry = (user.repurchase_carry_left || 0) + (user.repurchase_carry_right || 0);
  
  return { count: orders.length, total_bv: total_bv + repurchaseCarry, total_inr, orders, repurchaseCarry };
}

function getRepurchaseSubtree(rootId, startISO, endISO) {
  if (!rootId) return { count: 0, total_bv: 0, total_inr: 0, orders: [] };
  let total = { count: 0, total_bv: 0, total_inr: 0, orders: [] };
  let q = [rootId];
  while (q.length) {
    const id = q.shift();
    const u = getUserById(id);
    if (!u) continue;
    const stats = getUserRepurchaseStats(u.id, startISO, endISO);
    total.count += stats.count;
    total.total_bv += stats.total_bv;
    total.total_inr += stats.total_inr;
    total.orders.push(...stats.orders);
    if (u.left_id) q.push(u.left_id);
    if (u.right_id) q.push(u.right_id);
  }
  return total;
}

function getTeamRepurchaseStats(rootId, startISO, endISO) {
  const user = getUserById(rootId);
  if (!user) return { self: { count: 0, total_bv: 0, total_inr: 0 }, left: { count: 0, total_bv: 0, total_inr: 0 }, right: { count: 0, total_bv: 0, total_inr: 0 } };
  const self = getUserRepurchaseStats(user.id, startISO, endISO);
  const left = user.left_id ? getRepurchaseSubtree(user.left_id, startISO, endISO) : { count: 0, total_bv: 0, total_inr: 0 };
  const right = user.right_id ? getRepurchaseSubtree(user.right_id, startISO, endISO) : { count: 0, total_bv: 0, total_inr: 0 };
  return { self, left, right };
}

function ensureRankRules() {
  if (!db.rank_rules) db.rank_rules = [];
  
  // Ensure STAR WINNER always exists at rank 0 and cannot be removed
  let starWinner = db.rank_rules.find(r => r.criteria_type === 'direct_joins_7_days' || r._fixed === true || r.id === -1);
  if (!starWinner) {
    starWinner = {
      id: -1,
      name: 'STAR WINNER',
      order: 0,
      criteria_type: 'direct_joins_7_days',
      left_pv: 0,
      right_pv: 0,
      target_left: 2,
      target_right: 2,
      matching_condition: 'direct_joins',
      self_repurchase: '',
      rank_income: 0,
      reward: '',
      deadline_value: 7,
      deadline_unit: 'days',
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      _fixed: true
    };
    db.rank_rules.unshift(starWinner);
  } else {
    // Force Star Winner to always be rank 0 and non-editable
    starWinner.order = 0;
    starWinner._fixed = true;
    starWinner.id = -1;
  }
  
  return db.rank_rules;
}

function getOrderedRanks() {
  const ranks = ensureRankRules().slice();
  ranks.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0;
    const bo = typeof b.order === 'number' ? b.order : 0;
    if (ao !== bo) return ao - bo;
    return (a.left_pv + a.right_pv) - (b.left_pv + b.right_pv);
  });
  return ranks;
}

function computeUserLegPV(u) {
  return {
    left: (u.org_bv_left||0)+(u.carry_left||0)+(u.org_rep_bv_left||0)+(u.repurchase_carry_left||0),
    right: (u.org_bv_right||0)+(u.carry_right||0)+(u.org_rep_bv_right||0)+(u.repurchase_carry_right||0)
  };
}

function getDynamicRank(userId) {
  const u = typeof userId === 'object' ? userId : getUserById(userId);
  if (!u || u.role !== 'user') return u.rank_name || null;

  // STAR WINNER is permanent — once achieved, never lose it
  if (u.rank_name === 'STAR WINNER') return 'STAR WINNER';

  // Check STAR WINNER (IDs within 7 days)
  const starWinnerRule = (db.rank_rules || []).find(r => r.criteria_type === 'direct_joins_7_days');
  const hasPurchasedProduct_rank = (u.pv > 0) || u.plan_id;
  if (starWinnerRule && u.status === 'active' && hasPurchasedProduct_rank) {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const activationDate = u.activated_at ? new Date(u.activated_at) : new Date(u.created_at);
    const sevenDaysLater = new Date(activationDate.getTime() + sevenDaysMs);

    function countSingleLine(startId, side) {
      let c = 0, cur = startId;
      const msStart = activationDate.getTime(), msEnd = sevenDaysLater.getTime();
      while (cur) {
        const usr = getUserById(cur);
        if (!usr || usr.status !== 'active') break;
        const t = new Date(usr.activated_at || usr.created_at).getTime();
        if (t < msStart || t > msEnd) break;
        c++;
        const next = (db.users || []).find(ch => ch.placement_parent_id === cur && ch.placement_side === side && ch.sponsor_id === cur);
        cur = next ? next.id : null;
      }
      return c;
    }

    const leftChild = (db.users || []).find(c => c.placement_parent_id === u.id && c.placement_side === 'left' && c.sponsor_id === u.id);
    const rightChild = (db.users || []).find(c => c.placement_parent_id === u.id && c.placement_side === 'right' && c.sponsor_id === u.id);
    const leftActive = leftChild ? countSingleLine(leftChild.id, 'left') : 0;
    const rightActive = rightChild ? countSingleLine(rightChild.id, 'right') : 0;
    const s = getSettingsRow();
    const targetLeft = s.star_target_left || starWinnerRule.target_left || 2;
    const targetRight = s.star_target_right || starWinnerRule.target_right || 2;
    if (leftActive >= targetLeft && rightActive >= targetRight) return 'STAR WINNER';
  }

  // Check PV-based ranks
  const tL = u.user_code === 'N77668569' ? (u.carry_left||0)+(u.org_bv_left||0) : subtreeStats(u.left_id).pv;
  const tR = subtreeStats(u.right_id).pv;
  const allRankRules = ensureRankRules().filter(r => r.criteria_type !== 'direct_joins_7_days' && !r._fixed).sort((a, b) => (a.order || 0) - (b.order || 0));
  let bestRank = null;
  for (const r of allRankRules) {
    if (tL >= (r.left_pv || 0) && tR >= (r.right_pv || 0)) bestRank = r.name;
  }
  return bestRank || u.rank_name || null;
}

function updateUserRank(userId) {
  const u = getUserById(userId);
  if (!u || u.role !== 'user') return;
  if (u.rank_manually_set) return;

  // Check for STAR WINNER (2 downline left + 2 downline right within 7 days from JOINING)
  // Downline = direct or indirect | User must be ACTIVE to qualify | Must have purchased product
  const starWinnerRule = (db.rank_rules || []).find(r => r.criteria_type === 'direct_joins_7_days');
  let starWinnerAchieved = false;
  const hasPurchasedProduct_assign = (u.pv > 0) || u.plan_id;

  if (starWinnerRule && u.status === 'active' && hasPurchasedProduct_assign) {
    // 7 days time limit from ACTIVATION (activated_at), not joining
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Use activated_at for 7 days window
    const activationDate = u.activated_at ? new Date(u.activated_at) : new Date(u.created_at);
    const sevenDaysLater = new Date(activationDate.getTime() + sevenDaysMs);

    // Count active downline in a tree (direct + indirect) within 7 days from activation
    function countSingleLine(startId, side) {
      let c = 0, cur = startId;
      const msStart = activationDate.getTime(), msEnd = sevenDaysLater.getTime();
      while (cur) {
        const u = getUserById(cur);
        if (!u || u.status !== 'active') break;
        const t = new Date(u.activated_at || u.created_at).getTime();
        if (t < msStart || t > msEnd) break;
        c++;
        const next = (db.users || []).find(ch => ch.placement_parent_id === cur && ch.placement_side === side && ch.sponsor_id === cur);
        cur = next ? next.id : null;
      }
      return c;
    }

    // Find left and right direct children first
    const leftChild = (db.users || []).find(c => c.placement_parent_id === u.id && c.placement_side === 'left' && c.sponsor_id === u.id);
    const rightChild = (db.users || []).find(c => c.placement_parent_id === u.id && c.placement_side === 'right' && c.sponsor_id === u.id);

    // Count single line on each side
    const leftActive = leftChild ? countSingleLine(leftChild.id, 'left') : 0;
    const rightActive = rightChild ? countSingleLine(rightChild.id, 'right') : 0;

    // Get targets from global settings, then fallback to starWinnerRule
    const s = getSettingsRow();
    const targetLeft = s.star_target_left || starWinnerRule.target_left || 2;
    const targetRight = s.star_target_right || starWinnerRule.target_right || 2;
    if (leftActive >= targetLeft && rightActive >= targetRight) {
      starWinnerAchieved = true;
    }
  }

  // Check PV-based ranks (existing logic)
  const { left, right } = computeUserLegPV(u);
  const ranks = getOrderedRanks();
  let achieved = null;

  // Only check PV ranks if STAR WINNER not achieved
  if (!starWinnerAchieved) {
    for (let i = ranks.length - 1; i >= 0; i--) {
      const r = ranks[i];
      // Skip STAR WINNER in PV check (it's a special rank)
      if (r.criteria_type === 'direct_joins_7_days') continue;
      if (left >= (r.left_pv || 0) && right >= (r.right_pv || 0)) {
        achieved = r;
        break;
      }
    }
  }

  const old = u.rank_name || null;
  let newName = achieved ? achieved.name : null;

  // STAR WINNER overrides other ranks
  if (starWinnerAchieved) {
    newName = starWinnerRule ? starWinnerRule.name : 'STAR WINNER';
  }

  // STAR WINNER is permanent — never downgrade once achieved
  if (old === 'STAR WINNER') {
    newName = 'STAR WINNER';
  }

  // Rank is permanent — never downgrade, only allow upgrade
  if (old && newName) {
    const rankOrder = getOrderedRanks();
    const oldIdx = rankOrder.findIndex(r => r.name === old);
    const newIdx = rankOrder.findIndex(r => r.name === newName);
    if (oldIdx >= 0 && newIdx >= 0 && newIdx < oldIdx) {
      newName = old; // Keep old (higher) rank
    }
  } else if (old && !newName) {
    newName = old; // Don't lose rank if BV calculation returns null
  }

  if (old !== newName) {
    u.rank_name = newName || '';
    u.rank_updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    
    if (newName) {
      if (!db.rank_history) db.rank_history = [];
      db.rank_history.push({
        id: nextId('rank_hist'),
        user_id: u.id,
        user_code: u.user_code || null,
        member_name: u.member_name || null,
        rank_name: newName,
        left_pv: left,
        right_pv: right,
        achieved_at: u.rank_updated_at
      });
      
      // AUTO: Create celebration entry when user achieves rank
      if (!db.celebrations) db.celebrations = [];
      const existingCelebration = db.celebrations.find(c => c.user_id === u.id && c.rank_achieved === newName);
      if (!existingCelebration) {
        db.celebrations.push({
          id: nextId('celebration'),
          user_id: u.id,
          user_code: u.user_code || null,
          member_name: u.member_name || null,
          rank_achieved: newName,
          celebration_date: todayIST(),
          trophy_status: 'pending',
          celebration_status: 'pending',
          hidden_from_home: false,
          notes: 'Auto-created on rank achievement',
          created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
        });
      }
      
      // Credit Rank Income if rank has income configured AND achieved within deadline
      const rankSettings = getSettingsRow();
      if (rankSettings.rank_income_enabled !== false) {
        let rankIncomeAmount = 0;
        let deadlineEligible = true; // If no deadline set, always eligible
        
        if (starWinnerAchieved) {
          // STAR WINNER rank income
          const starRank = (db.rank_rules || []).find(r => r.criteria_type === 'direct_joins_7_days');
          rankIncomeAmount = starRank ? (parseFloat(starRank.rank_income) || 0) : 0;
          // Check deadline for star winner (days/weeks/months from achievement)
          if (starRank && starRank.deadline_value && starRank.deadline_unit) {
            const achievedDate = new Date(u.rank_updated_at);
            const deadlineDate = new Date(achievedDate);
            if (starRank.deadline_unit === 'days') {
              deadlineDate.setDate(deadlineDate.getDate() + starRank.deadline_value);
            } else if (starRank.deadline_unit === 'weeks') {
              deadlineDate.setDate(deadlineDate.getDate() + (starRank.deadline_value * 7));
            } else if (starRank.deadline_unit === 'months') {
              deadlineDate.setMonth(deadlineDate.getMonth() + starRank.deadline_value);
            }
            const now = DateTime.now().setZone('Asia/Kolkata').toJSDate();
            deadlineEligible = now <= deadlineDate;
          }
        } else if (achieved) {
          // Regular rank income
          rankIncomeAmount = parseFloat(achieved.rank_income) || 0;
          // Check deadline for this rank (days/weeks/months from achievement)
          if (achieved.deadline_value && achieved.deadline_unit) {
            const achievedDate = new Date(u.rank_updated_at);
            const deadlineDate = new Date(achievedDate);
            if (achieved.deadline_unit === 'days') {
              deadlineDate.setDate(deadlineDate.getDate() + achieved.deadline_value);
            } else if (achieved.deadline_unit === 'weeks') {
              deadlineDate.setDate(deadlineDate.getDate() + (achieved.deadline_value * 7));
            } else if (achieved.deadline_unit === 'months') {
              deadlineDate.setMonth(deadlineDate.getMonth() + achieved.deadline_value);
            }
            const now = DateTime.now().setZone('Asia/Kolkata').toJSDate();
            deadlineEligible = now <= deadlineDate;
          }
        }
        
        if (rankIncomeAmount > 0 && deadlineEligible) {
          // Check if user already received this rank's income
          const existingRankIncome = (db.earnings || []).find(e => 
            e.user_id === u.id && 
            e.note === 'Rank income' && 
            e.rank_name === newName
          );
          
          if (!existingRankIncome) {
            const gross = rankIncomeAmount;
            const tds = Math.round(gross * 0.02 * 100) / 100;
            const adminCharge = Math.round(gross * 0.10 * 100) / 100;
            const net = Math.max(0, Math.round((gross - tds - adminCharge) * 100) / 100);
            
            (db.earnings || (db.earnings = [])).push({
              id: nextId('earning'),
              user_id: u.id,
              amount_inr: net,
              gross_inr: gross,
              tds_inr: tds,
              admin_charge_inr: adminCharge,
              net_inr: net,
              pairs: 0,
              per_pair_amount_inr: 0,
              pair_bv_size_used: 0,
              used_bv: 0,
              leg: null,
              note: 'Rank income',
              rank_name: newName,
              source_user_id: null,
              source_pin_code: null,
              plan_id: null,
              activation_bv: null,
              created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
            });
          }
        }
      }
    }
    saveDB(db);
  }
}

function updateRanksForAllUsers() {
  (db.users || []).forEach(u => {
    if (u.role === 'user') updateUserRank(u.id);
  });
}

function lifetimeEarnings(userId) {
  return db.earnings.filter(e => e.user_id === userId).reduce((s, e) => s + (e.amount_inr || 0), 0);
}

function lifetimeEarningsGross(userId) {
  return db.earnings.filter(e => e.user_id === userId && e.status !== 'pending').reduce((s, e) => s + (e.gross_inr || e.amount_inr || 0), 0);
}

function todayPairs(userId) {
  const { start, end } = todayRangeIST();
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return db.earnings
    .filter(e => e.user_id === userId && e.status !== 'pending')
    .filter(e => {
      const t = new Date(e.created_at).getTime();
      return t >= startMs && t <= endMs;
    })
    .reduce((s, e) => s + (e.pairs || 0), 0);
}

function directReferrals(userId) {
  return db.users
    .filter(u => u.sponsor_id === userId)
    .map(u => ({ username: u.username, user_code: u.user_code, member_name: u.member_name || null, created_at: u.created_at }));
}

function getDirectJoinsWithin7Days(userId) {
  const user = getUserById(userId);
  if (!user) return { count: 0, joins: [] };

  const directJoins = db.users
    .filter(u => u.sponsor_id === userId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (directJoins.length < 3) {
    return { count: directJoins.length, joins: directJoins };
  }

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let hasAchieved = false;
  let achievedJoins = [];

  for (let i = 0; i <= directJoins.length - 3; i++) {
    const first = new Date(directJoins[i].created_at);
    const third = new Date(directJoins[i + 2].created_at);
    if (third - first <= sevenDaysMs) {
      hasAchieved = true;
      achievedJoins = directJoins.slice(i, i + 3);
      break;
    }
  }

  return {
    count: hasAchieved ? 3 : directJoins.length,
    achieved: hasAchieved,
    joins: achievedJoins.length ? achievedJoins : directJoins
  };
}

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view cache', false);
app.use(compression());
app.use((req, res, next) => {
  const origSend = res.send;
  res.send = function(body) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
    return origSend.call(this, body);
  };
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
const ROOT_UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(ROOT_UPLOADS_DIR));
app.use('/brand', express.static(path.join(__dirname, '..', 'public', 'uploads', 'brand')));
app.use('/brand', express.static(path.join(__dirname, '..', 'uploads', 'brand')));
app.use('/receipts', express.static(path.join(ROOT_UPLOADS_DIR, 'receipts')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(morgan('dev'));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: { action: 'sameorigin' } }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'nastige-mlm-secure-key-9f8a2b7c3d1e4f5a6b7c8d9e0f1a2b3c',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 60 * 1000
    }
  })
);

app.use((req, res, next) => {
  if (req.path !== '/favicon.ico') {
    console.log('REQUEST:', req.method, req.path, 'Session:', req.session?.user ? 'logged in as ' + req.session.user.role : 'no session');
  }
  next();
});

// CSRF protection — block cross-origin POST/PUT/DELETE/PATCH
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.get('Origin');
    const host = req.get('Host');
    const referer = req.get('Referer');
    if (origin && host) {
      const originHost = new URL(origin).hostname;
      const serverHost = host.split(':')[0];
      if (originHost !== serverHost) {
        console.log('[CSRF BLOCKED]', req.method, req.path, 'origin:', origin);
        return res.status(403).json({ error: 'Forbidden: Cross-origin request blocked' });
      }
    }
    if (referer) {
      try {
        const refererHost = new URL(referer).hostname;
        const serverHost = host.split(':')[0];
        if (refererHost !== serverHost) {
          console.log('[CSRF BLOCKED]', req.method, req.path, 'referer:', referer);
          return res.status(403).json({ error: 'Forbidden: Invalid referer' });
        }
      } catch(e) {}
    }
  }
  next();
});

// Session keep-alive ping — resets rolling maxAge
app.get('/session/ping', (req, res) => {
  if (req.session) req.session.now = Date.now();
  res.end('ok');
});

app.use((req, res, next) => {
  res.locals.uc = (s) => String(s || '').toUpperCase();
  next();
});

// PIN cleanup now runs via scheduled midnight task (see scheduleMidnightCleanup)

// Initialize cart in session if not exists
app.use((req, res, next) => {
  if (!req.session.cart) {
    req.session.cart = [];
  }
  next();
});

// Make admin_backup available to all templates (for "Login as User" bar)
app.use((req, res, next) => {
  res.locals.admin_backup = req.session && req.session.admin_backup ? req.session.admin_backup : null;
  next();
});

function requireAuth(role) {
  return (req, res, next) => {
    // Check session exists
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    
    // Verify user actually exists in database
    const sessionUser = req.session.user;
    let userExists = false;
    
    if (sessionUser.role === 'admin') {
      const admin = (db.users || []).find(u => u.id === sessionUser.id && u.role === 'admin');
      userExists = !!admin;
    } else if (sessionUser.role === 'user') {
      const user = (db.users || []).find(u => u.id === sessionUser.id && u.role === 'user');
      userExists = !!user;
    } else if (sessionUser.role === 'franchise') {
      const franchise = (db.franchises || []).find(f => f.id === sessionUser.franchise_id);
      userExists = !!franchise;
    }
    
    // If user doesn't exist, clear session and redirect
    if (!userExists) {
      console.log('requireAuth: User not found in DB, clearing session');
      req.session.destroy(() => {});
      return res.redirect('/login');
    }
    
    // If role is required, check it
    if (role && req.session.user.role !== role) {
      return res.redirect('/login');
    }
    
    next();
  };
}

function getPendingOrdersCount() {
  return (db.orders || []).filter(o => o.payment_status === 'pending' && o.type === 'repurchase').length;
}

app.use((req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    res.locals.pendingOrdersCount = getPendingOrdersCount();
  } else {
    res.locals.pendingOrdersCount = 0;
  }
  next();
});

function requireMonthlyRepurchase() {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    
    const s = db.settings || {};
    if (!s.monthly_repurchase_required) {
      return next();
    }
    
    const user = getUserById(req.session.user.id);
    if (!user) return next();
    
    if (user.monthly_repurchase_exempt) {
      return next();
    }
    
    const now = DateTime.now().setZone('Asia/Kolkata');
    const monthStart = DateTime.fromISO(`${now.year}-${String(now.month).padStart(2,'0')}-01`, { zone: 'Asia/Kolkata' });
    const monthEnd = monthStart.endOf('month');
    const repurchase = getUserRepurchaseStats(user.id, monthStart.toISO(), monthEnd.toISO());
    const required_bv = s.monthly_repurchase_bv || 0;
    const required_dp = s.monthly_repurchase_dp || 0;
    const achieved_bv = repurchase.total_bv || 0;
    const achieved_dp = repurchase.total_inr || 0;
    
    // Check if user has met requirements (both BV and DP if applicable)
    const bvMet = required_bv === 0 || achieved_bv >= required_bv;
    const dpMet = required_dp === 0 || achieved_dp >= required_dp;
    
    if (bvMet && dpMet) {
      return next();
    }
    
    // Allow products, cart, checkout pages (NOT orders - because BV not credited yet)
    const allowedPaths = [
      '/products', '/cart', '/checkout',
      '/products/', '/cart/', '/checkout/'
    ];
    const isAllowed = allowedPaths.some(p => req.path === p || req.path.startsWith(p));
    
    if (isAllowed) {
      return next();
    }
    
    // For dashboard, allow it to show popup
    if (req.path === '/dashboard' || req.path === '/') {
      return next();
    }
    
    // Redirect to dashboard (will show popup)
    return res.redirect('/dashboard');
  };
}

app.get('/', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/home');
  const role = req.session.user.role;
  if (role === 'admin') return res.redirect('/admin');
  if (role === 'franchise') return res.redirect('/franchise');
  return res.redirect('/dashboard');
});

app.get('/home', (req, res) => {
  const products = (db.products || [])
    .filter(p => p.active && p.show_on_home)
    .slice(0, 6)
    .map(p => ({
      id: p.id,
      name: p.name,
      price: p.mrp_inr || 0,
      bv: p.bv || 0,
      category: p.category || 'Products',
      image1_url: p.image1_url || null,
      rating: p.rating || 4
    }));
  const docs = (db.company_docs || [])
    .slice()
    .reverse()
    .slice(0, 8)
    .map(d => ({
      id: d.id,
      title: d.title || (d.name || 'Document'),
      url: d.url
    }));
  // Latest rank achievers — merge celebrations + rank_history for all achievers
  const rankHist = db.rank_history || [];
  const celebrationList = db.celebrations || [];
  // Deduplicate celebrations per user (latest per user)
  const celebrMap = {};
  celebrationList.forEach(c => {
    if (c.hidden_from_home) return;
    const key = c.user_code || c.user_id;
    if (key && (!celebrMap[key] || (c.celebration_date || '') > (celebrMap[key].celebration_date || ''))) {
      celebrMap[key] = c;
    }
  });
  // Deduplicate rank_history per user (latest per user)
  const rankMap = {};
  rankHist.forEach(h => {
    const key = h.user_code || h.user_id;
    if (key && (!rankMap[key] || (h.achieved_at || '') > (rankMap[key].achieved_at || ''))) {
      rankMap[key] = h;
    }
  });
  // Merge: celebration entries + rank_history entries for users without celebrations
  const hiddenStarIds = new Set(db.settings && db.settings.hidden_star_winners || []);
  const allAchievers = [];
  Object.values(celebrMap).forEach(c => {
    if (hiddenStarIds.has(c.user_id)) return;
    allAchievers.push({
      user_id: c.user_id,
      user_code: c.user_code || '',
      member_name: c.member_name || '',
      rank_name: c.rank_achieved || '',
      achieved_at: c.celebration_date,
      photo: c.photo || ''
    });
  });
  Object.values(rankMap).forEach(h => {
    const key = h.user_code || h.user_id;
    if (key && !celebrMap[key]) {
      if (hiddenStarIds.has(h.user_id)) return;
      const user = getUserById(h.user_id);
      allAchievers.push({
        user_id: h.user_id,
        user_code: user ? (user.user_code || '') : (h.user_code || ''),
        member_name: user ? (user.member_name || '') : (h.member_name || ''),
        rank_name: h.rank_name || '',
        achieved_at: h.achieved_at,
        photo: user ? (user.photo || '') : ''
      });
    }
  });
  // Third source: users with current rank_name not already in celebrations or rank_history
  const validRankNames = new Set(ensureRankRules().map(r => r.name));
  const existingAchieverIds = new Set(allAchievers.map(a => a.user_id));
  (db.users || []).forEach(u => {
    const dynRank = getDynamicRank(u);
    if (!dynRank || !validRankNames.has(dynRank)) return;
    if (hiddenStarIds.has(u.id)) return;
    if (!existingAchieverIds.has(u.id)) {
      existingAchieverIds.add(u.id);
      allAchievers.push({
        user_id: u.id,
        user_code: u.user_code || '',
        member_name: u.member_name || '',
        rank_name: dynRank,
        achieved_at: u.rank_updated_at,
        photo: u.photo || ''
      });
    }
  });
  const swHideAll = (db.settings || {}).hide_star_winners_marquee;
  const latestRankAchievers = allAchievers
    .filter(a => validRankNames.has(a.rank_name))
    .filter(a => !swHideAll || a.rank_name !== 'STAR WINNER')
    .sort((a,b) => (b.achieved_at || '').localeCompare(a.achieved_at || ''));

   // Top achievers (manually set from admin with photos)
  const topAchievers = (db.settings && db.settings.achievers) 
    ? db.settings.achievers.filter(a => !a.hidden) 
    : [];
  
  const s = db.settings || {};
  const galleryAll = db.gallery || [];
  const galleryImages = galleryAll.filter(g => g && g.type === 'image');
  const galleryGroups = {};
  galleryImages.forEach(g => {
    try {
      let dateStr = 'Uncategorized';
      if (g.event_date) {
        const d = new Date(g.event_date);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      } else if (g.created_at) {
        const d = new Date(g.created_at);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      }
      const title = (g.title || 'Uncategorized').trim();
      const key = title + '|||' + dateStr;
      if (!galleryGroups[key]) galleryGroups[key] = { title: title, date: dateStr, items: [] };
      galleryGroups[key].items.push(g);
    } catch (_) {}
  });
  const gallery = Object.values(galleryGroups);
  const videos = galleryAll.filter(g => g && g.type === 'video').slice(0, 6);
  
  // Get actual Star Winners — only 5 from the current week
  const now = DateTime.now().setZone('Asia/Kolkata').toJSDate();
  const dayOfWeek = now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dayOfWeek);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  const autoStarWinners = (db.users || [])
    .filter(u => u.role === 'user' && getDynamicRank(u) === 'STAR WINNER' && !hiddenStarIds.has(u.id))
    .filter(u => u.rank_updated_at)
    .filter(u => {
      const d = new Date(u.rank_updated_at);
      return d >= weekStart && d < weekEnd;
    })
    .map(u => {
      const cel = (db.celebrations || []).find(c => (c.user_id === u.id || c.user_code === u.user_code) && c.rank_achieved === 'STAR WINNER');
      return {
        user_code: u.user_code || '',
        member_name: u.member_name || '',
        achieved_at: u.rank_updated_at,
        photo: cel ? cel.photo : null,
        object_position: cel ? (cel.object_position || 'center') : 'center'
      };
    })
    .slice(0, 6);
  
  res.render('home', {
    products,
    docs,
    achievers: topAchievers,
    gallery,
    videos,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    signup_success: req.query.msg || null,
    company_name: s.company_name || s.brand_name || 'Nastige',
    company_address: s.company_address || '',
    company_phone: s.company_phone || '',
    company_email: s.company_email || '',
    company_gstin: s.company_gstin || '',
    company_cin: s.company_cin || '',
    bannerSlides: s.banner_slides || [],
    latestRankAchievers,
    starWinners: autoStarWinners,
    youtubeVideos: s.youtube_videos || [],
    founder: s.founder || null,
    achieversMarqueeSpeed: s.achievers_marquee_speed || 40,
    marqueeSpeed: s.marquee_speed || s.marquee_duration || 30,
    founders: s.founders || [],
    marqueeText: s.marquee_text || '',
    marqueeSpeed: s.marquee_speed || 30,
    sidePopupEnabled: s.sidePopupEnabled || false,
    sidePopupLink: s.sidePopupLink || '',
    sidePopupTitle: s.sidePopupTitle || '',
    sidePopupSubtitle: s.sidePopupSubtitle || '',
    sidePopupButtonText: s.sidePopupButtonText || '',
    popup_notice_enabled: s.popup_notice_enabled || false,
    popup_notice_title: s.popup_notice_title || '',
    popup_notice_message: s.popup_notice_message || '',
    popup_notice_button_text: s.popup_notice_button_text || '',
    popup_notice_button_link: s.popup_notice_button_link || '',
    popup_notice_color: s.popup_notice_color || '#667eea',
    popup_notice_bg: s.popup_notice_bg || '#ffffff',
    social_facebook: s.social_facebook || '',
    social_twitter: s.social_twitter || '',
    social_instagram: s.social_instagram || '',
    social_youtube: s.social_youtube || '',
    payment_gateway_enabled: s.payment_gateway_enabled || false,
    payment_gateway_name: s.payment_gateway_name || '',
    payment_gateway_url: s.payment_gateway_url || '',
    payment_alt1_name: s.payment_alt1_name || '',
    payment_alt1_url: s.payment_alt1_url || '',
    payment_alt2_name: s.payment_alt2_name || '',
    payment_alt2_url: s.payment_alt2_url || '',
    payment_alt3_name: s.payment_alt3_name || '',
    payment_alt3_url: s.payment_alt3_url || '',
    payment_alt4_name: s.payment_alt4_name || '',
    payment_alt4_url: s.payment_alt4_url || '',
    company_pages: db.company_pages || [],
    activeOffers: (db.offers || []).filter(o => o.is_active && o.start_date <= todayIST() && o.end_date >= todayIST())
  });
});

// Public products list page - show public products if not logged in
app.get('/products', (req, res) => {
  if (req.session && req.session.user && req.session.user.role === 'user') {
    const user = getUserById(req.session.user.id);
    const fromRepurchase = req.query.from === 'repurchase';
    if (fromRepurchase) {
      req.session.inRepurchaseMode = true;
    }
    const inRepurchaseMode = fromRepurchase || req.session.inRepurchaseMode;
    const products = (db.products || [])
      .filter(p => p.active)
      .map(p => ({
        id: p.id,
        name: p.name,
        pv: p.bv || 0,
        price_inr: p.selling_price_inr || p.mrp_inr || 0,
        dp_inr: p.selling_price_inr || 0,
        mrp_inr: p.mrp_inr || 0,
        tag: p.category || '',
        image_url: p.image1_url || null
      }));
    const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
    return res.render('products', {
      user,
      products,
      cartItems: req.session.cart || [],
      sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      fromRepurchase: inRepurchaseMode
    });
  }
  const cat = req.query.cat || '';
  const products = (db.products || [])
    .filter(p => p.active)
    .filter(p => !cat || (p.category || '').toLowerCase().includes(cat.toLowerCase()))
    .map(p => ({
      id: p.id,
      name: p.name,
      pv: p.bv || 0,
      price_inr: p.mrp_inr || 0,
      selling_price_inr: p.selling_price_inr || p.mrp_inr || 0,
      category: p.category || 'Products',
      tag: p.category || '',
      image_url: p.image1_url || null
    }));
  res.render('products_public', { products, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }), selectedCategory: cat, error: null, success: null });
});

// Public product detail page (supports both public and logged in users)
app.get('/product/:id', (req, res) => {
  const productId = parseInt(req.params.id);
  const product = (db.products || []).find(p => p.id === productId && p.active);
  const user = (req.session && req.session.user && req.session.user.id) ? db.users.find(u => u.id === req.session.user.id) : null;
  const sponsor = user && user.sponsor_id ? db.users.find(u => u.id === user.sponsor_id) : null;
  if (!product) return res.status(404).render('product_detail', { user: user || null, product: null, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }), error: 'Product not found', success: null });
  res.render('product_detail', {
    user: user || null,
    product: {
      id: product.id,
      name: product.name,
      description: product.details || product.description || '',
      pv: product.bv || 0,
      price_inr: product.mrp_inr || 0,
      tag: product.category || '',
      image_url: product.image1_url || null,
      images: product.image2_url ? [product.image1_url, product.image2_url].filter(Boolean) : [product.image1_url].filter(Boolean)
    },
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    error: null,
    success: null
  });
});

app.get('/pages/:slug', (req, res) => {
  const map = {
    'refund-and-cancellation': 'Returns & Refunds',
    'returns-and-refunds': 'Returns & Refunds',
    'shipping-policy': 'Shipping Policy',
    'terms-and-conditions': 'Terms & Conditions',
    'terms-of-service': 'Terms of Service',
    'privacy-policy': 'Privacy Policy',
    'disclaimer': 'Disclaimer',
    'company-account': 'Company Account',
    'careers': 'Careers',
    'franchise-login': 'Franchise Login',
    'company-products': 'Company Products',
    'fire-safety-instrument': 'Fire Safety Instrument',
    'wellness-health-care': 'Wellness & Health Care',
    'beauty-personal-care': 'Beauty & Personal Care',
    'fmcg-products': 'FMCG Products',
    'home-care': 'Home Care',
    'skin-care': 'Skin Care',
    'about-company': 'About Us',
    'business-plan': 'Business Plan',
    'documents': 'Documents',
    'contact': 'Contact Us'
  };
  const slug = String(req.params.slug || '').toLowerCase();
  if (slug === 'documents') {
    const docs = (db.company_docs || []).slice().reverse();
    return res.render('documents', { docs });
  }
  if (slug === 'franchise-login') {
    return res.redirect('/franchise');
  }
  if (slug === 'company-account') {
    const s = db.settings || {};
    return res.render('company_account', {
      company_name: s.company_name || s.brand_name || 'Nastige',
      upi_id: s.company_upi_id || '',
      qr_image: s.company_qr_image || '',
      account_name: s.company_account_name || '',
      account_number: s.company_account_number || '',
      bank_name: s.company_bank_name || '',
      bank_branch: s.company_bank_branch || '',
      ifsc: s.company_ifsc || ''
    });
  }
  db.company_pages = db.company_pages || [];
  let pageRow = (db.company_pages || []).find(p => p.slug === slug) || null;
  
  // Map refund-and-cancellation to returns-and-refunds if not found
  if (!pageRow && slug === 'refund-and-cancellation') {
    pageRow = (db.company_pages || []).find(p => p.slug === 'returns-and-refunds') || null;
  }
  if (!pageRow && slug === 'returns-and-refunds') {
    pageRow = (db.company_pages || []).find(p => p.slug === 'refund-and-cancellation') || null;
  }
  
  // Map terms-and-conditions to terms-of-service if not found
  if (!pageRow && slug === 'terms-and-conditions') {
    pageRow = (db.company_pages || []).find(p => p.slug === 'terms-of-service') || null;
  }
  if (!pageRow && slug === 'terms-of-service') {
    pageRow = (db.company_pages || []).find(p => p.slug === 'terms-and-conditions') || null;
  }
  
  const title = pageRow ? (pageRow.title || map[slug] || 'Info') : (map[slug] || 'Info');
  const content = pageRow ? (pageRow.content || '') : '';
  const pdfUrl = pageRow && pageRow.pdf_url ? pageRow.pdf_url : null;
  res.render('page', { title, content, pdfUrl });
});

app.get('/contact', (req, res) => {
  const s = db.settings || {};
  res.render('contact', { 
    company_name: s.company_name || s.brand_name || 'Nastige',
    error: null, 
    success: null 
  });
});

app.post('/contact', (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  if (!name || !email || !subject || !message) {
    const s = db.settings || {};
    return res.render('contact', { 
      company_name: s.company_name || s.brand_name || 'Nastige',
      error: 'Please fill all required fields', 
      success: null 
    });
  }
  db.contacts = db.contacts || [];
  db.contacts.push({
    id: Date.now(),
    name, email, phone, subject, message,
    created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
  });
  saveDB(db);
  
  const s = db.settings || {};
  const es = s.email_settings || {};
  const companyEmail = s.company_email;
  if (companyEmail) {
    try {
      const transporter = nodemailer.createTransport({
        host: es.smtp_host || 'smtp.gmail.com',
        port: es.smtp_port || 587,
        secure: false,
        auth: {
          user: es.smtp_user || s.company_email,
          pass: es.smtp_pass || ''
        }
      });
      const mailOptions = {
        from: es.smtp_user || s.company_email,
        to: companyEmail,
        subject: 'New Query: ' + subject,
        html: `
          <h2 style="color:#667eea;">New Query Received</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;"><strong>Name:</strong></td><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;">${name}</td></tr>
            <tr><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;"><strong>Email:</strong></td><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;">${email}</td></tr>
            <tr><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;"><strong>Phone:</strong></td><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;">${phone || 'Not provided'}</td></tr>
            <tr><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;"><strong>Subject:</strong></td><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;">${subject}</td></tr>
            <tr><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;vertical-align:top;"><strong>Message:</strong></td><td style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;">${message}</td></tr>
          </table>
          <p style="margin-top:16px;color:#64748b;font-size:12px;">Submitted on: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
        `
      };
      transporter.sendMail(mailOptions, (err, info) => {
        if (err) console.log('Email error:', err);
      });
    } catch (e) {
      console.log('Email send error:', e.message);
    }
  }
  
  res.render('contact', { 
    company_name: s.company_name || s.brand_name || 'Nastige',
    error: null, 
    success: 'Thank you! Your query has been submitted. We will contact you soon.' 
  });
});

app.get('/admin/queries', requireAuth('admin'), (req, res) => {
  const queries = (db.contacts || []).slice().reverse();
  res.render('admin_queries', { 
    queries,
    error: req.query.err || null,
    success: req.query.msg || null
  });
});

app.get('/check-user', (req, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!ref) return res.json({ found: false, error: 'Missing ref' });
  const u = getUserByRef(ref);
  if (u) return res.json({ found: true, username: u.username || null, user_code: u.user_code || null, member_name: u.member_name || null });
  res.json({ found: false, error: 'Not found' });
});

app.get('/lookup/ref', (req, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!ref) return res.json({ ok: false, error: 'Missing ref' });
  // Check user first
  const u = getUserByRef(ref);
  if (u) return res.json({ ok: true, type: 'user', username: u.username || null, user_code: u.user_code || null, member_name: u.member_name || null });
  // Check franchise
  const f = (db.franchises || []).find(fr => (fr.franchise_code || '').toUpperCase() === ref.toUpperCase() || (fr.username || '').toUpperCase() === ref.toUpperCase());
  if (f) return res.json({ ok: true, type: 'franchise', username: f.username || null, user_code: f.franchise_code || null, member_name: f.member_name || null });
  res.json({ ok: false, error: 'Not found' });
});

app.post('/api/signup-pin-preview', (req, res) => {
  try {
    const pkg = String(req.body.package_pin || '').trim();
    const lp = String(req.body.login_pin || '').trim();
    if (!pkg || !lp) return res.status(400).json({ ok: false, error: 'PIN and Login PIN required' });
    let p = (db.pin_packages || []).find(x => x.code === pkg && String(x.login_pin || '') === lp) || null;
    if (!p) return res.status(404).json({ ok: false, error: 'PIN not found' });
    if (p.used_by || p.disabled || p.status === 'expired') return res.status(400).json({ ok: false, error: 'PIN already used or disabled' });
    let items = [];
    let total = 0;
    if (p.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
      const ids = Array.isArray(p.product_ids) ? p.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
      const prodList = ids.map(id => (db.products || []).find(pr => pr.id === id)).filter(Boolean);
      const planTotal = parseFloat((plan && plan.amount_inr) || 0) || 0;
      total = planTotal;
      const n = prodList.length || 1;
      let accum = 0;
      prodList.forEach((pr, idx) => {
        const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
        accum += share;
        items.push({ product_id: pr.id, product_name: pr.name, quantity: 1, line_total_inr: share });
      });
      return res.json({ ok: true, activation: { type: 'plan', name: plan ? plan.name : 'Plan', amount_inr: total, items, is_matrix_pin: !!p.is_matrix_pin } });
    } else {
      const product = (db.products || []).find(pr => pr.id === p.product_id) || null;
      if (!product) return res.status(400).json({ ok: false, error: 'Product not found for PIN' });
      total = (product.selling_price_inr || product.mrp_inr || 0);
      items.push({ product_id: product.id, product_name: product.name, quantity: 1, line_total_inr: total });
      return res.json({ ok: true, activation: { type: 'product', name: product.name, amount_inr: total, items } });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Preview failed' });
  }
});

app.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('signup', { error: null, success: null });
});

app.post('/signup', (req, res) => {
  const { member_name, password, sponsor_ref, placement_side, package_pin, login_pin, email, phone, state, agree_terms, activation_mode, leader_ref } = req.body;
  console.log('[SIGNUP] Attempt:', member_name, 'sponsor:', sponsor_ref);
  try {
    const agreed = String(agree_terms || '').toLowerCase() === 'on';
    if (!agreed) return res.render('signup', { error: 'Please agree to Terms & Conditions', success: null });
    const mode = String(activation_mode || 'id_only').toLowerCase();
    if (mode === 'pin') {
      const pkgReq = String(package_pin || '').trim();
      const lpReq = String(login_pin || '').trim();
      if (!pkgReq || !lpReq) return res.render('signup', { error: 'Enter Package PIN and Login PIN for activation', success: null });
    }
    const pRef = (sponsor_ref && sponsor_ref.trim()) ? sponsor_ref.trim() : null;
    const sponsorFinal = pRef || (db.settings.default_sponsor_username || null);
    const placement_parent_ref = pRef || null;
    const newUser = addUser({
      username: null,
      member_name,
      password,
      sponsor_ref: sponsorFinal,
      placement_parent_ref,
      placement_side,
      package_pin: null,
      login_pin: null,
      email,
      phone,
      state,
      leader_ref
    });
    console.log('[SIGNUP] User created:', newUser.user_code, 'ID:', newUser.id);

    // Create pending leadership bonus during registration (will be credited during activation)
    // Leadership bonus - ONE TIME only, for new users with leader_ref
    const lbSettings = db.settings || {};
    if (leader_ref && (lbSettings.leadership_bonus_enabled === true || lbSettings.leadership_bonus_enabled === undefined)) {
      const existingLB = (db.earnings || []).find(e => e.source_user_id === newUser.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
      if (!existingLB) {
        const leader = getUserByRef(leader_ref);
        if (leader) {
          // Get default leadership bonus from plans
          const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
          const defaultPlan = allPlans[0] || null;
          const defaultLB = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
          (db.earnings || (db.earnings = [])).push({
            id: nextId('earning'),
            user_id: leader.id,
            amount_inr: 0,
            gross_inr: defaultLB, // Set from default plan
            tds_inr: 0,
            admin_charge_inr: 0,
            net_inr: 0,
            pending_leadership: true,
            note: 'Leadership bonus (Pending)',
            source_user_id: newUser.id,
            source_user_code: newUser.user_code,
            source_pin_code: null,
            plan_id: defaultPlan ? defaultPlan.id : null,
            activation_bv: 0,
            status: 'pending',
            created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
          });
          saveDB(db);
        }
      }
    }

    (function activateWithPin(){
      try {
        const pkg = String(package_pin || '').trim();
        const lp = String(login_pin || '').trim();
        let p = null;
        if (pkg && lp) {
          p = (db.pin_packages || []).find(x => x.code === pkg && String(x.login_pin || '') === lp) || null;
        }
        if (p && !p.used_by && !(p.disabled || p.status === 'expired')) {
          p.used_by = newUser.id;
          p.used_at = DateTime.now().setZone('Asia/Kolkata').toISO();
          p.status = 'used';
          let items = [];
          let total = 0;
          let pvSum = 0;
          if (p.plan_id) {
            const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
            const ids = Array.isArray(p.product_ids) ? p.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
            const prodList = ids.map(id => (db.products || []).find(pr => pr.id === id)).filter(Boolean);
            const planTotal = parseFloat((plan && plan.amount_inr) || 0) || 0;
            total = planTotal;
            const n = prodList.length || 1;
            let accum = 0;
            prodList.forEach((pr, idx) => {
              pvSum += (pr.bv || 0);
              const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
              accum += share;
              items.push({
                product_id: pr.id,
                product_name: pr.name,
                quantity: 1,
                line_total_inr: share
              });
            });
            // Activation now happens automatically via creditPV when BV threshold is reached
          } else {
            const product = (db.products || []).find(pr => pr.id === p.product_id) || null;
            if (!product) return res.status(400).json({ ok: false, error: 'Product not found for PIN' });
            pvSum += (product.bv || 0);
            total = (product.selling_price_inr || product.mrp_inr || 0);
            items.push({
              product_id: product.id,
              product_name: product.name,
              quantity: 1,
              line_total_inr: total
            });
            // Activation now happens automatically via creditPV when BV threshold is reached
          }
          if (pvSum > 0 && !(p && p.is_matrix_pin)) creditPV(newUser.id, pvSum, 'activation');
          // Matrix PIN: create auto users under signup user
          if (p && p.is_matrix_pin) {
            newUser.is_matrix_target = true;
            const leftCount = p.left_count || 10;
            const rightCount = p.right_count || 10;
            const plan = p.plan_id ? (db.plans || []).find(pl => pl.id === p.plan_id) : null;
            const bvPerUser = plan ? (plan.pv || 500) : 500;
            const findSubtreeSpot = (rootId) => {
              if (!rootId) return null;
              const q = [rootId];
              while (q.length) {
                const id = q.shift();
                const u = getUserById(id);
                if (!u) continue;
                if (!u.left_id) return { parent: u, side: 'left' };
                if (!u.right_id) return { parent: u, side: 'right' };
                q.push(u.left_id);
                q.push(u.right_id);
              }
              return null;
            };
            for (let i = 1; i <= leftCount; i++) {
              if (i === 1) {
                createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: newUser.sponsor_id, parentId: newUser.id, side: 'left', memberName: 'Matrix L' + i, planId: p.plan_id, bv: bvPerUser });
              } else {
                const lChildId = getUserById(newUser.id).left_id;
                const spot = lChildId ? findSubtreeSpot(lChildId) : null;
                if (!spot) break;
                createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: newUser.sponsor_id, parentId: spot.parent.id, side: spot.side, memberName: 'Matrix L' + i, planId: p.plan_id, bv: bvPerUser });
              }
            }
            for (let i = 1; i <= rightCount; i++) {
              if (i === 1) {
                createAutoUser({ username: 'MTX' + String(Date.now() + i + 100).slice(-6) + 'R' + i, sponsorId: newUser.sponsor_id, parentId: newUser.id, side: 'right', memberName: 'Matrix R' + i, planId: p.plan_id, bv: bvPerUser });
              } else {
                const rChildId = getUserById(newUser.id).right_id;
                const spot = rChildId ? findSubtreeSpot(rChildId) : null;
                if (!spot) break;
                createAutoUser({ username: 'MTX' + String(Date.now() + i + 200).slice(-6) + 'R' + i, sponsorId: newUser.sponsor_id, parentId: spot.parent.id, side: spot.side, memberName: 'Matrix R' + i, planId: p.plan_id, bv: bvPerUser });
              }
            }
            newUser.pv = 0;
            // Activate user directly for matrix PIN (no BV threshold needed)
            newUser.status = 'active';
            newUser.active = true;
            if (!newUser.activated_at) newUser.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();

            // Create leadership bonus for each auto user (not for target)
            if (newUser.leader_ref) {
              const leader = getUserByRef(newUser.leader_ref);
              if (leader) {
                const lbPlan = p.plan_id ? ((db.plans || []).find(pl => pl.id === p.plan_id) || null) : null;
                const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
                const defaultPlan = allPlans[0] || null;
                const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
                if (lbAmount > 0) {
                  const q = [newUser.left_id, newUser.right_id].filter(Boolean);
                  while (q.length) {
                    const id = q.shift();
                    const au = getUserById(id);
                    if (!au || !au.is_auto_created) continue;
                    const exists = (db.earnings || []).find(e => e.source_user_id === au.id && e.user_id === leader.id && e.note === 'Leadership bonus (Pending)');
                    if (!exists) {
                      (db.earnings || (db.earnings = [])).push({
                        id: nextId('earning'), user_id: leader.id, amount_inr: 0, gross_inr: lbAmount,
                        tds_inr: 0, admin_charge_inr: 0, net_inr: 0,
                        pending_leadership: true, note: 'Leadership bonus (Pending)',
                        source_user_id: au.id, source_user_code: au.user_code,
                        source_pin_code: p.code || null,
                        plan_id: lbPlan ? lbPlan.id : null, activation_bv: bvPerUser,
                        status: 'pending', created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
                      });
                    }
                    if (au.left_id) q.push(au.left_id);
                    if (au.right_id) q.push(au.right_id);
                  }
                }
              }
            }
          }
          // Credit pending leadership bonus for non-matrix PINs (target user)
          if (!(p && p.is_matrix_pin)) {
            const pendingLB = (db.earnings || []).find(e => 
              e.source_user_id === newUser.id && 
              e.pending_leadership === true || e.pending_leadership === 1 && 
              e.status === 'pending'
            );
            if (!pendingLB && newUser.leader_ref) {
              const existingLB = (db.earnings || []).find(e => e.source_user_id === newUser.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
              if (!existingLB) {
                const leader = getUserByRef(newUser.leader_ref);
                if (leader) {
                  const lbPlan = p && p.plan_id ? ((db.plans || []).find(pl => pl.id === p.plan_id) || null) : null;
                  const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
                  const defaultPlan = allPlans[0] || null;
                  const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
                  (db.earnings || (db.earnings = [])).push({
                    id: nextId('earning'), user_id: leader.id, amount_inr: 0, gross_inr: lbAmount,
                    tds_inr: 0, admin_charge_inr: 0, net_inr: 0,
                    pending_leadership: true, note: 'Leadership bonus (Pending)',
                    source_user_id: newUser.id, source_user_code: newUser.user_code,
                    source_pin_code: p ? (p.code || null) : null,
                    plan_id: lbPlan ? lbPlan.id : null, activation_bv: pvSum,
                    status: p ? (p.status || 'pending') : 'pending', created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
                  });
                }
              }
            }
            const lbCheck = (db.earnings || []).find(e => e.source_user_id === newUser.id && e.pending_leadership === true || e.pending_leadership === 1 && e.status === 'pending');
            if (lbCheck) {
              const lbPlan = p && p.plan_id ? ((db.plans || []).find(pl => pl.id === p.plan_id) || null) : null;
              const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
              const defaultPlan = allPlans[0] || null;
              let lbAmount = lbPlan ? (parseFloat(lbPlan.leadership_bonus_inr || '0') || 0) : 0;
              if (!lbAmount) lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
              if (lbAmount > 0 && pvSum >= (lbPlan ? (parseFloat(lbPlan.min_bv_for_leadership || '0') || 0) : 0)) {
                lbCheck.gross_inr = lbAmount;
                lbCheck.plan_id = lbPlan ? lbPlan.id : null;
                lbCheck.source_pin_code = p ? (p.code || null) : null;
                lbCheck.activation_bv = pvSum;
              }
            }
          }
          saveDB(db);

          // Generate invoice for the activation
          const invoice = generateInvoiceForPin(p);
          if (invoice) {
          }
        }
      } catch (_) {}
    })();
    
    // Update sponsor's rank to check for STAR WINNER achievement
    if (newUser.sponsor_id) {
      updateUserRank(newUser.sponsor_id);
    }
    
    // Send welcome email
    sendWelcomeEmail(newUser);
    
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
    const safeName = esc(newUser.member_name || newUser.username);
    const safeCode = esc(newUser.user_code || newUser.username);
    const companyName = (db.settings || {}).company_name || 'Nastige Industries Pvt. Ltd.';
    const joinDate = new Date(newUser.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    
    const msgTemplate = (db.settings || {}).registration_success_message || '✅ Registration successful! Welcome {name} — Your ID: {code}';
    const msgPlain = msgTemplate
      .replace(/\{name\}/g, safeName)
      .replace(/\{code\}/g, safeCode);
    
    const welcomeMsg = `
      <div style="text-align:center; padding:16px;">
        <p style="font-size:16px; color:#10b981; font-weight:700; margin:0 0 10px 0;">${msgPlain}</p>
        <p style="font-size:14px; color:#374151; margin:0 0 10px 0;">Congratulations! You have joined <strong>${companyName}</strong> family.</p>
        <div style="background:#f0f9ff; padding:12px; border-radius:8px; margin:10px 0; border-left:3px solid #667eea;">
          <p style="margin:4px 0; font-size:14px;"><strong>Your ID:</strong> <span style="color:#667eea; font-weight:700; font-size:16px;">${safeCode}</span></p>
          <p style="margin:4px 0; font-size:13px; color:#6b7280;"><strong>Date:</strong> ${joinDate}</p>
        </div>
        <p style="font-size:12px; color:#92400e; font-style:italic; margin:10px 0;">✨ "Success comes to those who take action!"</p>
        <a href="/login" style="display:inline-block; margin-top:10px; padding:10px 28px; background:linear-gradient(135deg,#667eea,#764ba2); color:white; text-decoration:none; border-radius:6px; font-size:14px; font-weight:600;">Login Now</a>
      </div>
    `;
    
    res.render('signup', { error: null, success: welcomeMsg });
  } catch (e) {
    console.error('[SIGNUP] Error:', e.message);
    res.render('signup', { error: e.message, success: null });
  }
});

app.get('/login', (req, res) => {
  console.log('Login page accessed. Session:', req.session.user);
  res.render('login', { error: null, success: req.query.success || null });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many login attempts. Try again in 15 minutes.', standardHeaders: true, legacyHeaders: false });
app.post('/login', loginLimiter, (req, res) => {
  console.log('Login attempt:', req.body.login_id || req.body.username);
  const login_id_raw = (req.body.login_id || req.body.username || '').trim();
  const password = req.body.password;
  let user = null;
  if (login_id_raw) {
    const up = login_id_raw.toUpperCase();
    if (/^(?:NIPL)\d{6}$/.test(up) || /^C\d{6}$/.test(up)) {
      user = (db.users || []).find(u => String(u.user_code || '').toUpperCase() === up) || null;
    }
    if (!user) {
      user = getUserByUsername(login_id_raw);
    }
  }
  if (user) {
    if (!bcrypt.compareSync(password, user.password_hash)) return res.render('login', { error: 'Invalid credentials', success: null });
    if (user.status === 'blocked') return res.render('login', { error: 'Account is blocked. Contact support.', success: null });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    
    // Check monthly repurchase status for redirect
    if (user.role === 'user') {
      const s = db.settings || {};
      if (s.monthly_repurchase_required && !user.monthly_repurchase_exempt) {
        const now = DateTime.now().setZone('Asia/Kolkata');
        const monthStart = DateTime.fromISO(`${now.year}-${String(now.month).padStart(2,'0')}-01`, { zone: 'Asia/Kolkata' });
        const monthEnd = monthStart.endOf('month');
        const repurchase = getUserRepurchaseStats(user.id, monthStart.toISO(), monthEnd.toISO());
        const required_bv = s.monthly_repurchase_bv || 0;
        const achieved_bv = repurchase.total_bv || 0;
        if (achieved_bv < required_bv) {
          req.session.repurchaseBlock = true;
          return res.redirect('/dashboard?repurchase_alert=1');
        }
      }
    }
    
    const dest = user.role === 'admin' ? '/admin' : '/dashboard';
    return res.redirect(dest);
  }
  return res.render('login', { error: 'Invalid credentials', success: null });
});

app.get('/franchise/login', (req, res) => {
  res.render('franchise_login', { error: null, success: null });
});

app.post('/franchise/login', (req, res) => {
  const loginId = (req.body.login_id || '').trim().toUpperCase();
  const password = req.body.password;
  let franchise = null;
  if (/^FR\d{6}$/.test(loginId)) {
    franchise = (db.franchises || []).find(f => (f.franchise_code || '').toUpperCase() === loginId) || null;
  }
  if (!franchise) {
    franchise = (db.franchises || []).find(f => (f.username || '').toUpperCase() === loginId) || null;
  }
  if (!franchise) {
    return res.render('franchise_login', { error: 'Invalid franchise ID or username', success: null });
  }
  if (!bcrypt.compareSync(password, franchise.password_hash)) {
    return res.render('franchise_login', { error: 'Invalid credentials', success: null });
  }
  if (franchise.status === 'blocked') {
    return res.render('franchise_login', { error: 'Account is blocked. Contact support.', success: null });
  }
  franchise.read_broadcasts = [];
  req.session.user = { franchise_id: franchise.id, username: franchise.username, role: 'franchise' };
  return res.redirect('/franchise');
});

app.get('/logout', (req, res) => {
  const role = req.session?.user?.role;
  const isFranchise = role === 'franchise';
  const backupUrl = isFranchise ? '/franchise/login' : '/login';
  console.log(`[LOGOUT] role=${role}, isFranchise=${isFranchise}, redirecting to ${backupUrl}`);
  req.session.destroy((err) => {
    if (err) console.error('[LOGOUT] session destroy error:', err);
    res.redirect(backupUrl);
  });
});

// Forgot Password
app.get('/forgot-password', (req, res) => {
  res.render('forgot_password', { error: null, success: null });
});

app.post('/forgot-password', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) {
    return res.render('forgot_password', { error: 'Please enter your email, user ID, or username', success: null });
  }
  
  // Find user or franchise
  let account = null;
  let accountType = 'user';
  
  // Try to find in users
  account = getUserByUsername(identifier) || (db.users || []).find(u => u.email === identifier);
  if (!account) {
    // Try to find in franchises
    account = getFranchiseByUsername(identifier) || (db.franchises || []).find(f => f.email === identifier);
    accountType = 'franchise';
  }
  
  if (!account) {
    return res.render('forgot_password', { error: 'User not found', success: null });
  }
  
  // Check if email settings are configured
  const s = db.settings || {};
  const emailSettings = s.email_settings || {};
  
  if (!emailSettings.smtp_host || !emailSettings.smtp_user || !emailSettings.smtp_pass) {
    return res.render('forgot_password', { error: 'Email not configured. Please contact admin to reset your password.', success: null });
  }
  
  // Generate new password (clear and easy to read - no ambiguous characters)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let newPassword = 'N';
  for (let i = 0; i < 7; i++) {
    newPassword += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  const hashedPassword = bcrypt.hashSync(newPassword, 10);
  
  // Update password_hash in correct table
  account.password_hash = hashedPassword;
  saveDB(db);
  
  // Log for debugging
  console.log('Password reset for:', accountType, account.user_code || account.franchise_code || account.username);
  
  // Send email
  try {
    const transporter = nodemailer.createTransport({
      host: emailSettings.smtp_host,
      port: emailSettings.smtp_port || 587,
      secure: emailSettings.smtp_port === 465,
      auth: {
        user: emailSettings.smtp_user,
        pass: emailSettings.smtp_pass
      }
    });
    
    const userEmail = account.email || account.username;
    const userCode = account.user_code || account.franchise_code || account.username;
    const userName = account.member_name || account.name || userCode;
    
    await transporter.sendMail({
      from: `"${emailSettings.from_name || 'Nastige'}" <${emailSettings.from_email || emailSettings.smtp_user}>`,
      to: userEmail,
      subject: 'Password Reset - Nastige',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #667eea;">Password Reset</h2>
          <p>Hello <strong>${userName}</strong>,</p>
          <p>Your password has been reset. Here are your new login credentials:</p>
          <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Login ID:</strong> ${userCode}</p>
            <p><strong>New Password:</strong> <span style="background: #667eea; color: white; padding: 8px 15px; border-radius: 4px; font-family: monospace; font-size: 18px; letter-spacing: 2px;">${newPassword}</span></p>
          </div>
          <p style="color: #ef4444;"><strong>Important:</strong> Please change your password after logging in for security.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 12px;">This is an automated email from Nastige Industries.</p>
        </div>
      `
    });
    
    res.render('forgot_password', { error: null, success: 'New password has been sent to your registered email. Please check your inbox.' });
  } catch (e) {
    console.error('Email send error:', e);
    res.render('forgot_password', { error: 'Failed to send email. Please contact admin. Error: ' + e.message, success: null });
  }
});

// Logout
app.get('/franchise', requireAuth('franchise'), (req, res) => {
  const franchiseId = req.session.user.franchise_id;
  if (!franchiseId) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  const me = getFranchiseById(franchiseId);
  if (!me) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  // Ensure franchise_code exists
  if (!me.franchise_code) {
    me.franchise_code = generateFranchiseCode6();
    saveDB(db);
  }
  const myOrders = (db.orders || []).filter(o => o.franchise_id === me.id);
  const myInvoices = (db.invoices || []).filter(i => i.franchise_id === me.id);
  
  // Combine orders and invoices for stats
  const allSalesItems = [
    ...myOrders.map(o => ({ total_inr: o.total_inr || 0, created_at: o.created_at })),
    ...myInvoices.map(i => ({ total_inr: i.total_inr || 0, created_at: i.created_at }))
  ];
  
  const todaySells = allSalesItems.filter(o => {
    const oDate = new Date(o.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const today = DateTime.now().setZone('Asia/Kolkata').toISODate();
    return oDate === today;
  }).reduce((s, o) => s + (o.total_inr || 0), 0);
  
  const monthStartIST = DateTime.now().setZone('Asia/Kolkata').startOf('month').toJSDate();
  const monthSells = allSalesItems.filter(o => new Date(o.created_at) >= monthStartIST).reduce((s, o) => s + (o.total_inr || 0), 0);
  const totalSells = allSalesItems.reduce((s, o) => s + (o.total_inr || 0), 0);
  const stockCount = me.stock ? Object.values(me.stock).reduce((a, b) => a + b, 0) : 0;
  if (!me.read_broadcasts) me.read_broadcasts = [];
  const broadcasts = (db.broadcasts || []).filter(b => {
    if (!b.is_active) return false;
    if (me.read_broadcasts.includes(b.id)) return false;
    // Same rules as user panel
    if (b.audience === 'all') return true;
    if (b.audience === 'users_only') return false;
    if (b.audience === 'franchises_only') return true;
    if (b.audience === 'active') return true; // franchise is always active
    if (b.audience === 'inactive') return false;
    if (b.audience === 'specific_user') return false;
    return false;
  });
  res.render('franchise_dashboard', {
    user: me,
    wallet: me.fund_wallet || 0,
    commission_wallet: me.commission_wallet || 0,
    todaySells,
    monthSells,
    totalSells,
    stockCount,
    orderCount: myOrders.length + myInvoices.length,
    broadcasts,
    lowStockAlert: me.stock ? Object.entries(me.stock).filter(([pid, qty]) => qty <= 5).map(([pid, qty]) => {
      const productId = parseInt(pid.replace('p', ''));
      const product = (db.products || []).find(p => p.id === productId);
      return { id: pid, name: product ? product.name : 'Product ' + pid, quantity: qty };
    }) : [],
    allStock: me.stock ? Object.entries(me.stock).map(([pid, qty]) => {
      const productId = parseInt(pid.replace('p', ''));
      const product = (db.products || []).find(p => p.id === productId);
      return { id: pid, name: product ? product.name : 'Product ' + pid, quantity: qty };
    }).filter(s => s.name !== 'Product ' + s.id) : [],
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    success: req.query.msg || null,
    error: req.query.err || null
  });
});

// Mark broadcast as read for users
app.post('/broadcast/read', requireAuth('user'), (req, res) => {
  try {
    const user = getUserById(req.session.user.id);
    if (!user) return res.json({ ok: false });
    const broadcasts = (db.broadcasts || []).filter(b => {
      if (!b.is_active) return false;
      if (!b.audience || b.audience === 'all' || b.audience === 'users_only' || b.audience === 'active') return true;
      return false;
    });
    if (!user.read_broadcasts) user.read_broadcasts = [];
    broadcasts.forEach(b => {
      if (!user.read_broadcasts.includes(b.id)) {
        user.read_broadcasts.push(b.id);
      }
    });
    saveDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Mark broadcast as read for franchises
app.post('/franchise/broadcast/read', requireAuth('franchise'), (req, res) => {
  try {
    const franchiseId = req.session.user.franchise_id;
    const franchise = getFranchiseById(franchiseId);
    if (!franchise) return res.json({ ok: false });
    const broadcasts = (db.broadcasts || []).filter(b => {
      if (!b.is_active) return false;
      if (!b.audience || b.audience === 'all' || b.audience === 'franchises_only' || b.audience === 'active') return true;
      return false;
    });
    if (!franchise.read_broadcasts) franchise.read_broadcasts = [];
    broadcasts.forEach(b => {
      if (!franchise.read_broadcasts.includes(b.id)) {
        franchise.read_broadcasts.push(b.id);
      }
    });
    saveDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/franchise/report', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  if (!me) return res.redirect('/login');
  
  const type = req.query.type || 'orders';
  const myOrders = (db.orders || []).filter(o => o.franchise_id === me.id);
  
  const { start: dayStart, end: dayEnd } = todayRangeIST();
  const { start: monthStart, end: monthEnd } = monthRangeIST();
  
  const todayOrders = myOrders.filter(o => o.created_at >= dayStart && o.created_at <= dayEnd);
  const monthOrders = myOrders.filter(o => o.created_at >= monthStart && o.created_at <= monthEnd);
  
  // Get transactions from franchise_transactions table
  const allTransactions = (db.franchise_transactions || []).filter(t => parseInt(t.franchise_id) === parseInt(me.id));
  const walletHistory = allTransactions.filter(t => t.type === 'credit' || t.type === 'debit' || t.type === 'commission_transfer');
   const commissionHistory = allTransactions.filter(t => t.type === 'commission' || t.type === 'commission_payout' || t.type === 'commission_transfer');
   
   const titles = { wallet: 'Wallet History', commission: 'Commission History', activation: 'Activation Commission', repurchase: 'Repurchase Commission', stock: 'Stock History', orders: 'All Orders', today: 'Today Orders', monthly: 'Monthly Orders', total: 'Total Orders' };
   
   let data = [];
   let total = 0;
   
   if (type === 'wallet') {
     data = walletHistory;
     total = walletHistory.reduce((sum, h) => sum + (h.amount || 0), 0);
    } else if (type === 'commission') {
      data = commissionHistory;
      total = commissionHistory.reduce((sum, h) => sum + (h.amount || 0), 0);
    } else if (type === 'activation') {
      data = allTransactions.filter(t => t.type === 'commission' && t.note && t.note.toLowerCase().includes('activation'));
      total = data.reduce((sum, h) => sum + (h.amount || 0), 0);
    } else if (type === 'repurchase') {
      data = allTransactions.filter(t => t.type === 'commission' && t.note && t.note.toLowerCase().includes('repurchase'));
      total = data.reduce((sum, h) => sum + (h.amount || 0), 0);
    } else if (type === 'stock') {
    // For stock, we need current stock and history
    const currentStock = [];
    const products = db.products || [];
    const stock = me.stock || {};
    
    for (const [key, quantity] of Object.entries(stock)) {
      // Handle both 'p123' and '123' formats
      const productId = key.startsWith('p') ? parseInt(key.slice(1)) : parseInt(key);
      const product = products.find(p => p.id === productId);
      if (product && quantity > 0) {
        currentStock.push({
          product_name: product.name || 'Unknown Product',
          quantity: quantity,
          bv: product.bv || 0
        });
      }
    }
    
    // Get stock history from franchise_stock_history table
    const franchiseStockHistory = (db.franchise_stock_history || []).filter(h => parseInt(h.franchise_id) === parseInt(me.id));
    
    // Calculate stock summary (In Qty, Out Qty, Balance)
    const stockSummaryMap = {};
    franchiseStockHistory.forEach(h => {
      const productName = h.product_name || 'Unknown Product';
      const qty = parseInt(h.quantity) || 0;
      
      if (!stockSummaryMap[productName]) {
        stockSummaryMap[productName] = {
          product_name: productName,
          in_qty: 0,
          out_qty: 0,
          balance: 0
        };
      }
      
      if (h.type === 'add' || h.type === 'in') {
        stockSummaryMap[productName].in_qty += qty;
      } else if (h.type === 'remove' || h.type === 'out') {
        stockSummaryMap[productName].out_qty += qty;
      }
    });
    
    // Calculate balance for each product
    const stockSummary = Object.values(stockSummaryMap).map(item => ({
      ...item,
      balance: item.in_qty - item.out_qty
    }));
    
    data = { currentStock, stockHistory: franchiseStockHistory, stockSummary };
    total = currentStock.reduce((sum, item) => sum + item.quantity, 0);
  } else if (type === 'orders') {
    data = myOrders;
    total = myOrders.reduce((sum, o) => sum + (o.total_inr || 0), 0);
  } else if (type === 'today') {
    data = todayOrders;
    total = todayOrders.reduce((sum, o) => sum + (o.total_inr || 0), 0);
  } else if (type === 'monthly') {
    data = monthOrders;
    total = monthOrders.reduce((sum, o) => sum + (o.total_inr || 0), 0);
  } else if (type === 'total') {
    data = myOrders;
    total = myOrders.reduce((sum, o) => sum + (o.total_inr || 0), 0);
  } else {
    data = [];
    total = 0;
  }
  
  // Sort wallet/commission history by date descending
  if (type === 'wallet' || type === 'commission') {
    data = data.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  
  res.render('franchise_report', {
    user: me,
    title: titles[type] || 'Report',
    type,
    data,
    total,
    products: db.products || [],
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/franchise/repurchase', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  const stock = me.stock || {};
  // Only show products with stock > 0
  const products = (db.products || []).filter(p => p.active && (stock['p' + p.id] || 0) > 0).map(p => ({
    ...p,
    franchise_stock: stock['p' + p.id] || 0,
    in_stock: true
  }));
  res.render('franchise_repurchase', { user: me, products, error: null, success: null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.get('/franchise/orders', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  const orders = (db.orders || []).filter(o => o.franchise_id === me.id).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  
  // Enrich orders with customer info if not present
  const enrichedOrders = orders.map(o => {
    if (!o.customer_code && o.user_id) {
      const cust = getUserById(o.user_id);
      if (cust) {
        return { ...o, customer_code: cust.user_code || cust.username, customer_name: cust.member_name || cust.username };
      }
    }
    return o;
  });
  
  res.render('franchise_orders', { user: me, orders: enrichedOrders, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.get('/franchise/stock', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  const stock = me.stock || {};
  const products = db.products || [];

  // Calculate in_qty, out_qty from stock history per product
  const myHistory = (db.franchise_stock_history || []).filter(h => parseInt(h.franchise_id) === parseInt(me.id));
  const productStats = {};
  myHistory.forEach(h => {
    const pid = h.product_id;
    if (!productStats[pid]) productStats[pid] = { in_qty: 0, out_qty: 0 };
    const qty = parseInt(h.quantity) || 0;
    if (h.type === 'add') {
      productStats[pid].in_qty += qty;
    } else {
      productStats[pid].out_qty += qty;
    }
  });

  const stockList = products.map(p => {
    const balance = stock['p' + p.id] || 0;
    const stats = productStats[p.id] || { in_qty: 0, out_qty: 0 };
    return {
      id: p.id,
      name: p.name || 'Unknown Product',
      qty: balance,
      in_qty: stats.in_qty,
      out_qty: stats.out_qty,
      balance: balance
    };
  }).filter(s => s.qty > 0 || s.in_qty > 0 || s.out_qty > 0);

  // Total summary
  const totalIn = stockList.reduce((a, b) => a + b.in_qty, 0);
  const totalOut = stockList.reduce((a, b) => a + b.out_qty, 0);

  // Get stock history from franchise_stock_history table
  const stockHistory = myHistory
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 100);

  res.render('franchise_stock', {
    user: me,
    stockList,
    stockHistory,
    totalIn,
    totalOut,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/franchise/transactions', requireAuth('franchise'), (req, res) => {
   const me = getFranchiseById(req.session.user.franchise_id);
   const type = req.query.type || 'all';
   
   // Fetch transactions from franchise_transactions table
   const allTransactions = (db.franchise_transactions || []).filter(t => parseInt(t.franchise_id) === parseInt(me.id));
   
    let transactions = [];
    if (type === 'all') {
      transactions = [...allTransactions].sort((a, b) => 
        new Date(b.created_at) - new Date(a.created_at)
      );
    } else if (type === 'company') {
      // Company transactions: credit/debit types
      transactions = allTransactions.filter(t => t.type === 'credit' || t.type === 'debit' || t.type === 'order_payment');
    } else if (type === 'commission') {
      // All commission transactions
      transactions = allTransactions.filter(t => t.type === 'commission' || t.type === 'commission_payout' || t.type === 'commission_transfer');
    } else if (type === 'activation') {
      // Activation commission only
      transactions = allTransactions.filter(t => t.type === 'commission' && t.note && t.note.toLowerCase().includes('activation'));
    } else if (type === 'repurchase') {
      // Repurchase commission only
      transactions = allTransactions.filter(t => t.type === 'commission' && t.note && t.note.toLowerCase().includes('repurchase'));
    }
   
   res.render('franchise_transactions', { 
     user: me, 
     transactions,
     type,
     rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) 
   });
});

app.get('/franchise/invoices', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  let orders = (db.orders || []).filter(o => o.franchise_id === me.id);
  
  // Also get PIN activation invoices for this franchise
  let pinInvoices = (db.invoices || []).filter(i => i.franchise_id === me.id).map(inv => ({
    id: inv.id,
    invoice_no: inv.invoice_no,
    order_no: inv.order_no || inv.invoice_no,
    type: 'activation',
    customer_code: (() => { const u = getUserById(inv.user_id); return u ? (u.user_code || u.username) : '-'; })(),
    customer_name: (() => { const u = getUserById(inv.user_id); return u ? (u.member_name || u.username) : '-'; })(),
    product_id: inv.product_id,
    product_name: inv.product_name || 'Unknown',
    total_inr: inv.total_inr || 0,
    created_at: inv.created_at,
    is_pin_activation: true
  }));
  
  // Combine orders and PIN invoices, then deduplicate by order_no
  let allInvoices = [...orders.map(o => {
    const prod = o.product_id ? (db.products || []).find(p => p.id === o.product_id) : null;
    const prodName = o.product_name || (prod ? prod.name : (o.items && o.items.length > 0 ? o.items.map(i => i.product_name || '').join(', ') : ''));
    return {...o, order_no: o.order_no || o.invoice_no || ('ORD' + String(o.id).padStart(4, '0')), is_pin_activation: false, product_name: prodName};
  }), ...pinInvoices];
  
  // Deduplicate by order_no - keep first occurrence
  const seenOrderNo = new Set();
  allInvoices = allInvoices.filter(inv => {
    const key = inv.order_no || inv.invoice_no;
    if (seenOrderNo.has(key)) return false;
    seenOrderNo.add(key);
    return true;
  });
  
  // Date filtering
  const fromDate = req.query.from_date;
  const toDate = req.query.to_date;
  
  if (fromDate) {
    const from = new Date(fromDate);
    from.setHours(0, 0, 0, 0);
    allInvoices = allInvoices.filter(o => new Date(o.created_at) >= from);
  }
  if (toDate) {
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    allInvoices = allInvoices.filter(o => new Date(o.created_at) <= to);
  }
  
  allInvoices = allInvoices.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  
  // Enrich orders with customer info if not present
  const enrichedOrders = allInvoices.map(o => {
    if (!o.customer_code && o.user_id) {
      const cust = getUserById(o.user_id);
      if (cust) {
        return { ...o, customer_code: cust.user_code || cust.username, customer_name: cust.member_name || cust.username };
      }
    }
    return o;
  });
  
  res.render('franchise_invoices', { user: me, orders: enrichedOrders, from_date: fromDate || '', to_date: toDate || '', rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.get('/franchise/invoice/:id', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  const paramId = req.params.id;
  
  // First check if it's a PIN invoice - search by order_no, invoice_no, or id
  let inv = (db.invoices || []).find(i => i.franchise_id === me.id && (i.order_no === paramId || i.invoice_no === paramId || String(i.id) === paramId));
  
  if (inv) {
    // Render PIN activation invoice
    const customer = getUserById(inv.user_id);
    const s = db.settings || {};
    
    // Build items array - use existing items or create from single product
    let items = [];
    let totalBV = inv.total_bv || 0;
    
    if (inv.items && inv.items.length > 0) {
      // Plan invoice with multiple items
      items = inv.items.map(item => {
        const prod = (db.products || []).find(p => p.id === item.product_id);
        return {
          product_code: item.product_code || (prod ? (prod.product_code || prod.code || '') : ''),
          product_name: item.product_name,
          hsn_code: item.hsn_code || '',
          quantity: item.quantity || 1,
          unit_price: item.unit_price || 0,
          rate: item.unit_price || 0,
          price_inr: item.price_inr || 0,
          gst_percent: item.gst_percent || (prod ? prod.gst_percent : 0) || 0,
          gst_inr: item.gst_inr || 0,
          cgst: item.cgst || (item.gst_inr || 0) / 2,
          sgst: item.sgst || (item.gst_inr || 0) / 2,
          total_inr: item.total_inr || 0,
          bv: item.bv || 0
        };
      });
      if (!totalBV) totalBV = items.reduce((s, i) => s + (i.bv || 0), 0);
    } else {
      // Single product invoice
      const product = (db.products || []).find(p => p.id === inv.product_id);
      items = [{
        product_code: product ? (product.product_code || product.code || '') : '',
        product_name: inv.product_name || (product ? product.name : ''),
        hsn_code: inv.hsn_code || (product ? product.hsn_code || '' : ''),
        quantity: inv.quantity || 1,
        unit_price: product ? (product.selling_price_inr || product.mrp_inr || 0) : 0,
        rate: product ? (product.selling_price_inr || product.mrp_inr || 0) : 0,
        price_inr: inv.price_inr || 0,
        gst_percent: inv.gst_percent || (product ? product.gst_percent : 0) || 0,
        gst_inr: inv.gst_inr || 0,
        cgst: inv.cgst || (inv.gst_inr || 0) / 2,
        sgst: inv.sgst || (inv.gst_inr || 0) / 2,
        total_inr: inv.total_inr || 0,
        bv: product ? (product.bv || 0) : 0
      }];
      if (!totalBV && product) totalBV = product.bv || 0;
    }
    
    return res.render('franchise_invoice_view', {
      user: me,
      invoice: {
        invoice_no: inv.order_no || inv.invoice_no,
        order_no: inv.order_no || inv.invoice_no,
        id: inv.id,
        created_at: inv.created_at,
        franchise_name: me.member_name || me.franchise_code || 'Franchise',
        franchise_address: me.address || '',
        franchise_phone: me.phone || '',
        total_bv: totalBV,
        total_inr: inv.total_inr || 0,
        product_name: inv.product_name || '',
        plan_name: inv.plan_name || '',
        quantity: inv.quantity || items.length,
        price_inr: inv.price_inr || 0,
        gst_inr: inv.gst_inr || 0,
        cgst: inv.cgst || 0,
        sgst: inv.sgst || 0,
        items: items
      },
      company_name: s.company_name || s.brand_name || 'Nastige',
      company_address: s.company_address || '',
      company_phone: s.company_phone || '',
      company_email: s.company_email || '',
      company_gstin: s.company_gstin || '',
      gst_type: s.gst_type || 'inclusive',
      customer,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
    });
  }
  
  // Otherwise check orders
  const order = (db.orders || []).find(o => (o.order_no === paramId || o.id === parseInt(paramId) || o.invoice_no === paramId) && o.franchise_id === me.id);
  if (!order) return res.redirect('/franchise/invoices');
  const product = db.products ? db.products.find(p => p.id === order.product_id) : null;
  const s = db.settings || {};
  const customer = order.user_id ? getUserById(order.user_id) : null;
  
  // Try to find existing invoice from db.invoices by order_id
  const existingInvoice = (db.invoices || []).find(inv => inv.order_id === order.id);
  
  const qty = order.quantity || 1;
  const rate = product ? (product.selling_price_inr || product.mrp_inr || 0) : 0;
  const gstPercent = product ? (product.gst_percent || 0) : 0;
  const gstType = (db.settings || {}).gst_type || 'inclusive';
  let totalInr, gstInr, priceInr, cgst, sgst;
  
  if (gstType === 'exclusive') {
    priceInr = rate * qty;
    gstInr = priceInr * (gstPercent / 100);
    totalInr = priceInr + gstInr;
  } else {
    totalInr = rate * qty;
    gstInr = totalInr * (gstPercent / (100 + gstPercent));
    priceInr = totalInr - gstInr;
  }
  cgst = gstInr / 2;
  sgst = gstInr / 2;
  
  const invoice = {
    invoice_no: existingInvoice ? existingInvoice.invoice_no : 'N/A',
    id: order.id,
    created_at: order.created_at,
    franchise_name: me.member_name || me.franchise_code || 'Franchise',
    franchise_address: me.address || '',
    franchise_phone: me.phone || '',
    total_bv: order.total_bv || 0,
    total_inr: existingInvoice ? existingInvoice.total_inr : totalInr,
    product_name: product ? product.name : '',
    product_code: product ? product.code || product.product_code || '' : '',
    hsn_code: product ? product.hsn_code || '' : '',
    quantity: qty,
    rate: rate,
    price_inr: existingInvoice ? (existingInvoice.price_inr || priceInr) : priceInr,
    gst_percent: gstPercent,
    gst_inr: existingInvoice ? (existingInvoice.gst_inr || gstInr) : gstInr,
    sgst: existingInvoice ? (existingInvoice.gst_inr || gstInr) / 2 : sgst,
    cgst: existingInvoice ? (existingInvoice.gst_inr || gstInr) / 2 : cgst,
    items: existingInvoice && existingInvoice.items ? existingInvoice.items : (product ? [{
      product_name: product.name || '',
      product_code: product.code || product.product_code || '',
      hsn_code: product.hsn_code || '',
      quantity: qty,
      rate: rate,
      price_inr: priceInr,
      gst_percent: gstPercent,
      gst_inr: gstInr,
      sgst: sgst,
      cgst: cgst,
      total_inr: totalInr
    }] : [])
  };
  res.render('franchise_invoice_view', { 
    user: me, 
    invoice, 
    company_name: s.company_name || s.brand_name || 'Nastige',
    company_address: s.company_address || '',
    company_phone: s.company_phone || '',
    company_email: s.company_email || '',
    company_gstin: s.company_gstin || '',
    gst_type: s.gst_type || 'inclusive',
    customer,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) 
  });
});

app.get('/franchise/password', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  res.render('franchise_password', { user: me, error: null, success: null });
});

app.post('/franchise/password', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  const { current_password, new_password, confirm_password } = req.body;
  if (!bcrypt.compareSync(current_password, me.password_hash)) {
    return res.render('franchise_password', { user: me, error: 'Current password is incorrect', success: null });
  }
  if (new_password !== confirm_password) {
    return res.render('franchise_password', { user: me, error: 'New passwords do not match', success: null });
  }
  if (new_password.length < 6) {
    return res.render('franchise_password', { user: me, error: 'Password must be at least 6 characters', success: null });
  }
  me.password_hash = bcrypt.hashSync(new_password, 10);
  saveDB(db);
  res.render('franchise_password', { user: me, error: null, success: 'Password changed successfully' });
});

// Franchise PIN Activation - Show assigned PINs
app.get('/franchise/pins', requireAuth('franchise'), (req, res) => {
  const me = getFranchiseById(req.session.user.franchise_id);
  if (!me) return res.redirect('/login');
  
  const myPins = (db.pin_packages || [])
    .filter(p => p.assigned_to_franchise === me.id)
    .reverse()
    .map(p => {
      let planName = '-';
      let productName = '-';
      let productBV = 0;
      if (p.plan_id) {
        const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
        if (plan) {
          planName = plan.name;
          const ids = Array.isArray(p.product_ids) ? p.product_ids : (plan.product_id ? [plan.product_id] : []);
          const productNames = ids.map(pid => {
            const pd = (db.products || []).find(pr => pr.id === pid);
            return pd ? pd.name : null;
          }).filter(Boolean);
          productName = productNames.length ? productNames.join(', ') : '-';
          productBV = ids.reduce((sum, pid) => {
            const pd = (db.products || []).find(pr => pr.id === pid);
            return sum + (pd ? (pd.bv || 0) : 0);
          }, 0);
        }
      } else if (p.product_id) {
        const product = (db.products || []).find(pr => pr.id === p.product_id);
        if (product) {
          productName = product.name;
          productBV = product.bv || 0;
        }
      }
      const usedBy = p.used_by ? getUserById(p.used_by) : null;
      return {
        ...p,
        plan_name: planName,
        product_name: productName,
        product_bv: productBV,
        used_by_name: usedBy ? (usedBy.member_name || usedBy.user_code || '-') : '-',
        used_by_code: usedBy ? (usedBy.user_code || '-') : '-'
      };
    });
  
  const availablePins = myPins.filter(p => p.status === 'assigned' && !p.used_by);
  const usedPins = myPins.filter(p => p.status === 'used' || p.used_by);
  
  res.render('franchise_pins', { 
    user: me, 
    availablePins, 
    usedPins,
    error: req.query.err || null, 
    success: req.query.msg || null 
  });
});

// Franchise activate user with PIN
app.post('/franchise/activate-user', requireAuth('franchise'), (req, res) => {
  try {
    const me = getFranchiseById(req.session.user.franchise_id);
    if (!me) return res.redirect('/login');
    
    const { package_pin, login_pin, user_ref } = req.body;
    const pin = String(package_pin || '').trim().toUpperCase();
    const lp = String(login_pin || '').trim();
    const uref = String(user_ref || '').trim();
    
    if (!pin || !lp || !uref) {
      return res.redirect('/franchise/pins?err=' + encodeURIComponent('User ID, Package PIN and Login PIN are required'));
    }
    
    // Find the user
    const targetUser = getUserByRef(uref);
    if (!targetUser) return res.redirect('/franchise/pins?err=' + encodeURIComponent('User not found'));
    if (targetUser.active || targetUser.status === 'active') return res.redirect('/franchise/pins?err=' + encodeURIComponent('User is already active'));
    
    // Validate PIN - must be assigned to this franchise
    const rec = (db.pin_packages || []).find(p => p.code === pin && p.assigned_to === me.id && p.assigned_to_franchise);
    if (!rec) return res.redirect('/franchise/pins?err=' + encodeURIComponent('Invalid PIN or PIN not assigned to you'));
    if (String(rec.login_pin) !== lp) return res.redirect('/franchise/pins?err=' + encodeURIComponent('Invalid Login PIN'));
    if (rec.used_by) return res.redirect('/franchise/pins?err=' + encodeURIComponent('This PIN has already been used'));
    if (rec.disabled || rec.status === 'expired') return res.redirect('/franchise/pins?err=' + encodeURIComponent('This PIN is disabled'));
    
    // Get product info - handle both plan and single product
    let products = [];
    let totalBV = 0;
    let planName = '';
    if (rec.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === rec.plan_id);
      planName = plan ? plan.name : 'Plan';
      const ids = Array.isArray(rec.product_ids) ? rec.product_ids : (plan ? [plan.product_id] : []);
      ids.forEach(pid => {
        const pd = (db.products || []).find(p => p.id === pid);
        if (pd) { products.push(pd); totalBV += (pd.bv || 0); }
      });
      if (products.length === 0) return res.redirect('/franchise/pins?err=' + encodeURIComponent('Plan products not found'));
    } else if (rec.product_id) {
      const pd = (db.products || []).find(p => p.id === rec.product_id);
      if (!pd) return res.redirect('/franchise/pins?err=' + encodeURIComponent('Product not found'));
      products.push(pd); totalBV = pd.bv || 0;
    }
    if (products.length === 0) return res.redirect('/franchise/pins?err=' + encodeURIComponent('No products found for this PIN'));
    
    // Check stock for ALL products before deducting
    if (!me.stock) me.stock = {};
    const missingProducts = [];
    for (const pd of products) {
      const stockKey = 'p' + pd.id;
      const currentStock = me.stock[stockKey] || 0;
      if (currentStock <= 0) missingProducts.push(pd.name);
    }
    if (missingProducts.length > 0) {
      const planInfo = planName ? planName + ' - ' : '';
      return res.redirect('/franchise/pins?err=' + encodeURIComponent(planInfo + 'Stock empty: ' + missingProducts.join(', ')));
    }
    
    // SAVE ORIGINAL STATE FOR ROLLBACK
    const origStock = {};
    for (const pd of products) {
      origStock['p' + pd.id] = me.stock['p' + pd.id] || 0;
    }
    const origCommissionWallet = me.commission_wallet || 0;
    const origFranchiseTxnCount = (db.franchise_transactions || []).length;
    const origStockHistoryCount = (db.franchise_stock_history || []).length;
    const origTargetUserState = { active: targetUser.active, status: targetUser.status, activated_at: targetUser.activated_at, activation_pin: targetUser.activation_pin, pv: targetUser.pv };
    const origPinState = { used_by: rec.used_by, used_at: rec.used_at, status: rec.status };
    const origEarningsCount = (db.earnings || []).length;
    const origInvoicesCount = (db.invoices || []).length;
    
      // Skip stock deduction for matrix PINs (no physical products)
      if (!rec.is_matrix_pin) {
        // Deduct stock for all products (franchise stock only) and update global sold stock
        for (const pd of products) {
          const stockKey = 'p' + pd.id;
          me.stock[stockKey] = (me.stock[stockKey] || 0) - 1;
          
          // Update global sold stock
          pd.sold_stock = (pd.sold_stock || 0) + 1;
          pd.franchise_given_stock = Math.max(0, (pd.franchise_given_stock || 0) - 1);
          pd.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
        }
      }
     
     // Add to stock history for EACH product (skip for matrix PINs)
     if (!rec.is_matrix_pin) {
       if (!db.franchise_stock_history) db.franchise_stock_history = [];
       for (const pd of products) {
         db.franchise_stock_history.push({
           id: (db.franchise_stock_history.length ? Math.max(...db.franchise_stock_history.map(h=>h.id)) : 0) + 1,
           franchise_id: me.id,
           type: 'out',
           product_id: pd.id,
           product_name: pd.name,
           quantity: 1,
           note: 'User activation: ' + (targetUser.user_code || targetUser.username),
           created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
         });
       }
     }
    
    // Activate user
    targetUser.active = true;
    targetUser.status = 'active';
    targetUser.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    targetUser.activation_pin = pin;
    
    // Mark PIN as used
    rec.used_by = targetUser.id;
    rec.used_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    rec.status = 'used';
    
    // Credit BV to user
    if (totalBV > 0) creditPV(targetUser.id, totalBV, 'activation');
    
    // Create pending leadership bonus for the leader
    const lbSettings = db.settings || {};
    if (targetUser.leader_ref && (lbSettings.leadership_bonus_enabled === true || lbSettings.leadership_bonus_enabled === undefined)) {
      const existingLB = (db.earnings || []).find(e => e.source_user_id === targetUser.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
      if (!existingLB) {
        const leader = getUserByRef(targetUser.leader_ref);
        if (leader) {
          // Get leadership bonus from the PIN's plan
          const lbPlan = rec.plan_id ? ((db.plans || []).find(pl => pl.id === rec.plan_id) || null) : null;
          const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
          const defaultPlan = allPlans[0] || null;
          const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
          (db.earnings || (db.earnings = [])).push({
            id: nextId('earning'),
            user_id: leader.id,
            amount_inr: 0,
            gross_inr: lbAmount,
            tds_inr: 0,
            admin_charge_inr: 0,
            net_inr: 0,
            pending_leadership: true,
            note: 'Leadership bonus (Pending)',
            source_user_id: targetUser.id,
            source_user_code: targetUser.user_code || targetUser.username,
            source_pin_code: pin,
            plan_id: lbPlan ? lbPlan.id : null,
            activation_bv: totalBV,
            status: 'pending',
            created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
          });
        }
      }
    }
    
    // Credit commission to franchise
    const s = db.settings || {};
    const commType = s.franchise_activation_commission_type || 'bv';
    const commValue = parseFloat(s.franchise_activation_commission_value || '10');
    let commissionAmount = 0;
    const plan = rec.plan_id ? (db.plans || []).find(pl => pl.id === rec.plan_id) : null;
    const totalPrice = plan ? (plan.amount_inr || 0) : (products[0] ? (products[0].selling_price_inr || products[0].mrp_inr || 0) : 0);
    
    if (commType === 'amount') {
      commissionAmount = commValue;
    } else if (commType === 'dp') {
      commissionAmount = totalPrice * (commValue / 100);
    } else if (commType === 'bv') {
      commissionAmount = totalBV * (commValue / 100);
    } else if (commType === 'plan') {
      commissionAmount = totalPrice * (commValue / 100);
    }
    
    if (commissionAmount > 0) {
      if (!me.commission_wallet) me.commission_wallet = 0;
      me.commission_wallet += commissionAmount;
      if (!db.franchise_transactions) db.franchise_transactions = [];
      db.franchise_transactions.push({
        id: (db.franchise_transactions.length ? Math.max(...db.franchise_transactions.map(t=>t.id)) : 0) + 1,
        franchise_id: me.id,
        type: 'commission',
        amount: commissionAmount,
        commission_after: me.commission_wallet,
        note: `User activation: ${targetUser.user_code || targetUser.username} (PIN: ${pin})`,
        total_bv: totalBV,
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
    }
    
    // Generate invoice for activation
    let invoiceNo = '';
    let franchiseOrderNo = '';
    try {
      const invoice = generateInvoiceForPin(rec);
      if (invoice && invoice.invoice_no) {
        invoiceNo = invoice.invoice_no;
        franchiseOrderNo = invoice.order_no || '';
      } else {
        const latestInv = (db.invoices || []).find(i => i.pin_code === pin);
        if (latestInv) {
          invoiceNo = latestInv.invoice_no;
          franchiseOrderNo = latestInv.order_no || '';
        }
      }
    } catch (e) {
      console.error('Invoice generation error:', e);
      const latestInv = (db.invoices || []).find(i => i.pin_code === pin);
      if (latestInv) {
        invoiceNo = latestInv.invoice_no;
        franchiseOrderNo = latestInv.order_no || '';
      }
    }
    
    // Fallback: only generate if invoice didn't create one
    if (!franchiseOrderNo && invoiceNo) {
      franchiseOrderNo = generateFranchiseOrderNumber(me.id);
    }
    
    saveDB(db);
    const stockDeducted = products.map(p => p.name).join(', ');
    res.redirect('/franchise?msg=' + encodeURIComponent(`Order ${franchiseOrderNo} activated! User: ${targetUser.user_code || targetUser.username}. Stock: ${stockDeducted}. Commission: ₹${commissionAmount.toFixed(2)}`));
  } catch (e) {
    console.error('Franchise activate user error:', e);
    // ROLLBACK - Restore original state on error
    try {
      const me = getFranchiseById(req.session.user.franchise_id);
      const uref = String(req.body.user_ref || '').trim();
      const targetUser = uref ? getUserByRef(uref) : null;
      const pin = String(req.body.package_pin || '').trim().toUpperCase();
      const rec = (db.pin_packages || []).find(p => p.code === pin) || null;
      
      // Restore target user state
      if (targetUser && origTargetUserState) {
        targetUser.active = origTargetUserState.active;
        targetUser.status = origTargetUserState.status;
        targetUser.activated_at = origTargetUserState.activated_at;
        targetUser.activation_pin = origTargetUserState.activation_pin;
        targetUser.pv = origTargetUserState.pv;
      }
      // Restore PIN state
      if (rec && origPinState) {
        rec.used_by = origPinState.used_by;
        rec.used_at = origPinState.used_at;
        rec.status = origPinState.status;
      }
      // Restore franchise stock
      if (me && origStock) {
        for (const key in origStock) {
          me.stock[key] = origStock[key];
        }
      }
      // Restore commission wallet
      if (me && origCommissionWallet !== undefined) {
        me.commission_wallet = origCommissionWallet;
      }
      // Truncate arrays to original length
      if (db.franchise_transactions && origFranchiseTxnCount !== undefined) {
        db.franchise_transactions.length = origFranchiseTxnCount;
      }
      if (db.franchise_stock_history && origStockHistoryCount !== undefined) {
        db.franchise_stock_history.length = origStockHistoryCount;
      }
      if (db.earnings && origEarningsCount !== undefined) {
        db.earnings.length = origEarningsCount;
      }
      if (db.invoices && origInvoicesCount !== undefined) {
        db.invoices.length = origInvoicesCount;
      }
    } catch (_) {}
    res.redirect('/franchise/pins?err=' + encodeURIComponent('Activation failed: ' + e.message));
  }
});

// Track orders being processed to prevent duplicates
const processingOrders = new Set();

// ULTIMATE LOCK - Track which order_id is currently having invoice created
const invoiceCreationLock = new Map(); // order_id -> timestamp

// DEBUG COUNTER - track how many times route is hit
let routeHitCount = 0;

app.post('/franchise/orders', requireAuth('franchise'), (req, res) => {
  routeHitCount++;
  const requestStart = Date.now();
  const requestId = requestStart + '_' + Math.random().toString(36).substr(2, 9);
  console.log('\n========================================');
  console.log('[>>>] FRANCHISE ORDER REQUEST RECEIVED - Route hit #', routeHitCount, 'ID:', requestId);
  console.log('[>>>] Time:', DateTime.now().setZone('Asia/Kolkata').toISO());
  console.log('[>>>] Body:', JSON.stringify(req.body));
  console.log('========================================\n');
  try {
    const me = getFranchiseById(req.session.user.franchise_id);
    console.log('[>>>] Franchise ID:', me.id, 'Code:', me.franchise_code);
    
    // EXTRA EARLY CHECK - If ANY recent order (last 10 seconds) from this franchise already has _invoice_id, skip
    const recentOrders = (db.orders || []).filter(o => 
      o.franchise_id === me.id && 
      o.type === 'repurchase' &&
      o._invoice_id
    );
    if (recentOrders.length > 0) {
      console.log('[!!!] RECENT ORDER ALREADY HAS INVOICE - Checking if within 10 seconds...');
      const nowTime = Date.now();
      for (const ro of recentOrders) {
        const orderTime = new Date(ro.created_at).getTime();
        if (nowTime - orderTime < 10000) {
          console.log('[!!!] BLOCKING - Recent order', ro.order_no, 'already has invoice _invoice_id:', ro._invoice_id);
          return res.render('franchise_repurchase', { 
            user: me, 
            products: (db.products||[]).filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0), 
            error: null, 
            success: 'Order already processed (recent duplicate blocked)', 
            rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) 
          });
        }
      }
    }
    
    // Create a unique key for this order based on content
    const productIdsForKey = Array.isArray(req.body.product_id) ? req.body.product_id : [req.body.product_id];
    const quantitiesForKey = Array.isArray(req.body.quantity) ? req.body.quantity : [req.body.quantity];
    const customerRef = (req.body.customer_ref || '').trim();
    const orderKey = `${me.id}_${JSON.stringify(productIdsForKey)}_${JSON.stringify(quantitiesForKey)}_${customerRef}`;
    
    // Check if this order is already being processed
    if (processingOrders.has(orderKey)) {
      console.log('[DEBUG] Order already in progress, skipping duplicate request');
      return res.render('franchise_repurchase', { 
        user: me, 
        products: (db.products||[]).filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0), 
        error: null, 
        success: 'Order already being processed', 
        rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) 
      });
    }
    
    // Mark this order as being processed
    processingOrders.add(orderKey);

    // Handle multiple products
    let productIds = req.body.product_id || [];
    let quantities = req.body.quantity || [];
    
    // Convert to arrays if single product
    if (!Array.isArray(productIds)) productIds = [productIds];
    if (!Array.isArray(quantities)) quantities = [quantities];
    
    if (productIds.length === 0) {
      return res.render('franchise_repurchase', { user: me, products: (db.products||[]).filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0), error: 'No products selected', success: null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
    }
    
    // Build order items
    const allProducts = db.products || [];
    const orderItems = [];
    let total_bv = 0;
    let totalInr = 0;
    let totalGstInr = 0;
    let totalPriceInr = 0;
    
    for (let i = 0; i < productIds.length; i++) {
      const pid = parseInt(productIds[i]);
      const qty = Math.max(1, parseInt(quantities[i] || '1'));
      const product = allProducts.find(p => p.id === pid && p.active);
      
      if (!product) {
        const prodsWithStock = allProducts.filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0).map(p => ({ ...p, franchise_stock: (me.stock||{})['p'+p.id]||0, in_stock: true }));
        return res.render('franchise_repurchase', { user: me, products: prodsWithStock, error: 'Invalid product selected', success: null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
      }
      
      // Check stock
      const stockKey = 'p' + product.id;
      const currentStock = (me.stock || {})[stockKey] || 0;
      if (currentStock < qty) {
        const prodsWithStock = allProducts.filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0).map(p => ({ ...p, franchise_stock: (me.stock||{})['p'+p.id]||0, in_stock: true }));
        return res.render('franchise_repurchase', { user: me, products: prodsWithStock, error: product.name + ' Not Available! Stock: ' + currentStock, success: null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
      }
      
      // Calculate item totals
      const gstPercent = product.gst_percent || 0;
      const gstType = (db.settings || {}).gst_type || 'inclusive';
      const unitPrice = product.selling_price_inr || product.mrp_inr || 0;
      let itemTotalInr, itemGstInr, itemPriceInr;
      
      if (gstType === 'exclusive') {
        itemPriceInr = unitPrice * qty;
        itemGstInr = itemPriceInr * (gstPercent / 100);
        itemTotalInr = itemPriceInr + itemGstInr;
      } else {
        itemTotalInr = unitPrice * qty;
        itemGstInr = itemTotalInr * (gstPercent / (100 + gstPercent));
        itemPriceInr = itemTotalInr - itemGstInr;
      }
      
      const cgstInr = itemGstInr / 2;
      const sgstInr = itemGstInr / 2;
      
      orderItems.push({
        product,
        qty,
        gstPercent,
        itemPriceInr,
        itemGstInr,
        itemTotalInr,
        unit_price: unitPrice,
        price_inr: itemPriceInr,
        cgst: cgstInr,
        sgst: sgstInr
      });
      
      total_bv += (product.bv || 0) * qty;
      totalInr += itemTotalInr;
      totalGstInr += itemGstInr;
      totalPriceInr += itemPriceInr;
    }
    
    if (!db.orders) db.orders = [];
    if (!db.counters.order) db.counters.order = 0;
    const now = DateTime.now().setZone('Asia/Kolkata').toISO();
    
    const id = (++db.counters.order);
    
    // Check wallet balance
    if (!me.fund_wallet) me.fund_wallet = 0;
    if (me.fund_wallet < totalInr) {
      return res.render('franchise_repurchase', { user: me, products: allProducts.filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0), error: 'Insufficient wallet balance. Required: ₹' + totalInr.toFixed(2) + ', Available: ₹' + me.fund_wallet.toFixed(2), success: null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
    }
    
    // SAVE ORIGINAL STATE FOR ROLLBACK
    const origFundWallet = me.fund_wallet;
    const origFranchiseStock = {};
    for (const item of orderItems) {
      const stockKey = 'p' + item.product.id;
      origFranchiseStock[stockKey] = me.stock[stockKey] || 0;
    }
    const origProductStocks = {};
    for (const item of orderItems) {
      const prod = (db.products || []).find(p => p.id === item.product.id);
      if (prod) origProductStocks[item.product.id] = { total_stock: prod.total_stock, sold_stock: prod.sold_stock };
    }
    const origOrdersCount = db.orders.length;
    const origInvoicesCount = (db.invoices || []).length;
    const origFranchiseTxnCount = (db.franchise_transactions || []).length;
    const origStockHistoryCount = (db.franchise_stock_history || []).length;
    const origEarningsCount = (db.earnings || []).length;
    const origCommissionWallet = me.commission_wallet || 0;
    
    // Get customer early for rollback state
    const cust = getUserByRef(String(req.body.customer_ref || '').trim());
    const origCustPV = cust ? cust.pv : null;
    const origCustStatus = cust ? cust.status : null;
    
    // Deduct from fund wallet
    me.fund_wallet -= totalInr;
    
    // Deduct stock for each product
    if (!me.stock) me.stock = {};
    for (const item of orderItems) {
      const stockKey = 'p' + item.product.id;
      me.stock[stockKey] = (me.stock[stockKey] || 0) - item.qty;
      
      const product = (db.products || []).find(p => p.id === item.product.id);
      if (product) {
        // Track sold stock for franchise orders
        product.sold_stock = (product.sold_stock || 0) + item.qty;
        // Reduce franchise_given_stock since product is no longer with franchise
        product.franchise_given_stock = Math.max(0, (product.franchise_given_stock || 0) - item.qty);
      }
    }
    
    // Generate franchise order number
    const franchiseOrderNo = generateFranchiseOrderNumber(me.id);

    // First item reference
    const firstItem = orderItems[0];

    // Add to stock history for EACH product in the order
    if (!db.franchise_stock_history) db.franchise_stock_history = [];
    for (const item of orderItems) {
      db.franchise_stock_history.push({
        id: (db.franchise_stock_history.length ? Math.max(...db.franchise_stock_history.map(h=>h.id)) : 0) + 1,
        franchise_id: me.id,
        type: 'out',
        product_id: item.product.id,
        product_name: item.product.name,
        quantity: item.qty,
        note: 'Order: ' + franchiseOrderNo + (cust ? ' - ' + (cust.user_code || cust.username) : ''),
        created_at: now
      });
    }

    // Record wallet transaction
    if (!db.franchise_transactions) db.franchise_transactions = [];
    const itemNames = orderItems.map(i => i.product.name + ' x' + i.qty).join(', ');

    db.franchise_transactions.push({
      id: Date.now(),
      franchise_id: parseInt(me.id),
      type: 'order_payment',
      amount: -totalInr,
      balance_after: me.fund_wallet,
      order_id: id,
      note: 'Order ' + franchiseOrderNo + ' - ' + itemNames,
      total_bv: total_bv,
      created_at: now
    });
    const order = {
      id,
      order_no: franchiseOrderNo,
      type: 'repurchase',
      user_id: cust ? cust.id : null,
      franchise_id: me.id,
      product_id: firstItem.product.id,
      quantity: orderItems.reduce((sum, i) => sum + i.qty, 0),
      order_items: orderItems.map(i => ({ product_id: i.product.id, qty: i.qty })),
      total_bv,
      total_inr: totalInr,
      customer_code: cust ? (cust.user_code || cust.username) : null,
      customer_name: cust ? (cust.member_name || cust.username) : null,
      created_at: now,
      _invoice_id: null // Will store invoice ID once created - THIS IS THE AUTHORITATIVE CHECK
    };
    db.orders.push(order);
    
    // Credit BV to customer
    // Activation now happens automatically via creditPV when BV threshold is reached
    if (cust) {
      creditPV(cust.id, total_bv, 'repurchase');
      
      // DO NOT flush binary here - BV is credited to carry, admin will run binary flush manually
      console.log('[FRANCHISE-ORDER] BV credited to carry for', cust.username, '. Admin must run binary flush to generate income.');
      
      // Credit pending leadership bonus during franchise activation
      const s = db.settings || {};
      if (s.leadership_bonus_enabled === true || s.leadership_bonus_enabled === undefined) {
        let pendingLB = (db.earnings || []).find(e => 
          e.source_user_id === cust.id && 
          e.pending_leadership === true || e.pending_leadership === 1 && 
          e.status === 'pending'
        );
        
        // If no pending LB exists, create one if user has leader_ref
        if (!pendingLB && cust.leader_ref) {
          const existingLB = (db.earnings || []).find(e => e.source_user_id === cust.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
          if (!existingLB) {
            const leader = getUserByRef(cust.leader_ref);
            if (leader) {
              // Get leadership bonus from PIN's plan (not order product)
              const custPin = (db.pin_packages || []).find(p => p.used_by === cust.id);
              const lbPlan = custPin && custPin.plan_id ? ((db.plans || []).find(pl => pl.id === custPin.plan_id) || null) : null;
              const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
              const defaultPlan = allPlans[0] || null;
              const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
              (db.earnings || (db.earnings = [])).push({
                id: nextId('earning'),
                user_id: leader.id,
                amount_inr: 0,
                gross_inr: lbAmount,
                tds_inr: 0,
                admin_charge_inr: 0,
                net_inr: 0,
                pending_leadership: true,
                note: 'Leadership bonus (Pending)',
                source_user_id: cust.id,
                source_user_code: cust.user_code || cust.username,
                source_pin_code: null,
                plan_id: lbPlan ? lbPlan.id : null,
                activation_bv: total_bv,
                status: 'pending',
                created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
              });
              pendingLB = (db.earnings || []).find(e => e.source_user_id === cust.id && e.pending_leadership === true || e.pending_leadership === 1 && e.status === 'pending');
            }
          }
        }
        
        if (pendingLB) {
          // Get leadership bonus from PIN's plan (not order product)
          const custPin = (db.pin_packages || []).find(p => p.used_by === cust.id);
          console.log('[LB FRANCHISE] Customer PIN found:', custPin?.code, 'plan_id:', custPin?.plan_id);
          const lbPlan = custPin && custPin.plan_id ? ((db.plans || []).find(pl => pl.id === custPin.plan_id) || null) : null;
          console.log('[LB FRANCHISE] Plan found:', lbPlan?.name, 'leadership:', lbPlan?.leadership_bonus_inr);
          const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
          const defaultPlan = allPlans[0] || null;
          let lbAmount = lbPlan ? (parseFloat(lbPlan.leadership_bonus_inr || '0') || 0) : 0;
          if (!lbAmount) lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
          const minBV = s.min_bv_for_leadership || 0;
          if (lbAmount > 0 && total_bv >= minBV) {
            console.log('[LB FRANCHISE] Updating LB - Old:', pendingLB.gross_inr, '-> New:', lbAmount);
            pendingLB.gross_inr = lbAmount;
            pendingLB.plan_id = lbPlan ? lbPlan.id : null;
            pendingLB.activation_bv = total_bv;
          }
        }
      }
    }
    
    // Create invoice
    if (!db.invoices) db.invoices = [];
    if (!db.counters.invoice) db.counters.invoice = 0;
    
    const invoiceItems = orderItems.map(item => ({
      product_id: item.product.id,
      product_name: item.product.name || '',
      product_code: item.product.code || item.product.product_code || '',
      hsn_code: item.product.hsn_code || '',
      quantity: item.qty,
      unit_price: item.unit_price,
      price_inr: item.price_inr,
      gst_percent: item.product.gst_percent || item.gstPercent || 0,
      gst_inr: item.itemGstInr,
      cgst: item.cgst,
      sgst: item.sgst,
      igst: 0, // IGST not used for intra-state
      total_inr: item.itemTotalInr,
      bv: item.product.bv || 0
    }));
    
    // ULTIMATE DUPLICATE PREVENTION - Use order's _invoice_id as authoritative source
    const currentOrder = db.orders.find(o => o.id === id);
    
    // ULTIMATE LOCK - Check if this order_id is already being processed for invoice
    if (invoiceCreationLock.has(id)) {
      const lockTime = invoiceCreationLock.get(id);
      const timeSinceLock = Date.now() - lockTime;
      console.log('[!!!] [', requestId, '] INVOICE LOCK ACTIVE for order_id:', id, 'Time since lock:', timeSinceLock, 'ms - SKIPPING!');
      // Don't create invoice - another thread is processing
    } else if (currentOrder && currentOrder._invoice_id) {
      // If order already has _invoice_id set, SKIP - this is the authoritative check
      console.log('[>>>][', requestId, '] INVOICE ALREADY EXISTS ON ORDER - SKIPPING! _invoice_id:', currentOrder._invoice_id);
    } else {
      // FINAL SAFETY CHECK - Search ALL invoices one more time
      const existingAny = (db.invoices || []).find(inv => inv.order_id === id || inv.order_no === franchiseOrderNo);
      if (existingAny) {
        console.log('[!!!] [', requestId, '] SAFETY CHECK FAILED - Invoice already exists!:', existingAny.invoice_no);
        invoiceCreationLock.delete(id);
        return res.status(400).json({ error: 'Invoice already exists for this order' });
      } else {
        // ACQUIRE LOCK BEFORE CREATING INVOICE
        invoiceCreationLock.set(id, Date.now());
        console.log('[>>>] [', requestId, '] LOCK ACQUIRED for order_id:', id);
        console.log('[>>>][', requestId, '] SAFETY CHECK PASSED - Creating invoice for order:', franchiseOrderNo, 'order_id:', id);
        
        // Generate invoice number ONLY after all checks pass
        const invoiceNo = generateInvoiceNumber([]);
        
        const newInvoiceId = (db.invoices || []).length > 0 ? Math.max(...(db.invoices || []).map(i => i.id || 0)) + 1 : 1;
        
        // CRITICAL: Set _invoice_id on order FIRST, before pushing invoice
        if (currentOrder) currentOrder._invoice_id = newInvoiceId;
        
    
        db.invoices.push({
          id: newInvoiceId,
          invoice_no: invoiceNo,
          order_no: franchiseOrderNo,
          order_id: id,
          user_id: cust ? cust.id : null,
          franchise_id: me.id,
          product_id: firstItem.product.id,
          product_name: orderItems.map(i => i.product.name).join(' + '),
          hsn_code: firstItem.product.hsn_code || '',
          quantity: orderItems.reduce((sum, i) => sum + i.qty, 0),
          price_inr: invoiceItems.reduce((sum, i) => sum + i.price_inr, 0),
          gst_percent: invoiceItems.length > 0 ? invoiceItems[0].gst_percent : 0,
          gst_inr: invoiceItems.reduce((sum, i) => sum + i.gst_inr, 0),
          cgst: invoiceItems.reduce((sum, i) => sum + i.cgst, 0),
          sgst: invoiceItems.reduce((sum, i) => sum + i.sgst, 0),
          total_inr: totalInr,
          total_bv: total_bv,
          items: invoiceItems,
          created_at: now,
          updated_at: now
        });
        
        // RELEASE LOCK AFTER CREATING INVOICE
        invoiceCreationLock.delete(id);
        console.log('[>>>] [', requestId, '] LOCK RELEASED for order_id:', id);
      }
    }
    
    // Credit commission to franchise - Always Repurchase Commission for wallet orders
    const s = db.settings || {};
    const commType = s.franchise_repurchase_commission_type || 'bv';
    const commVal = parseFloat(s.franchise_repurchase_commission_value || 0);
    let commissionAmount = 0;
    
    console.log(`[COMMISSION DEBUG] commType: ${commType}, commVal: ${commVal}, total_bv: ${total_bv}, totalPriceInr: ${totalPriceInr}`);
    
    if (commType === 'bv') {
      commissionAmount = total_bv * (commVal / 100);
    } else if (commType === 'dp') {
      commissionAmount = totalPriceInr * (commVal / 100);
    } else if (commType === 'amount') {
      commissionAmount = commVal;
    } else if (commType === 'product_bv') {
      for (const item of orderItems) {
        commissionAmount += (item.product.bv || 0) * item.qty * (commVal / 100);
      }
    } else if (commType === 'product_dp') {
      for (const item of orderItems) {
        commissionAmount += item.itemPriceInr * (commVal / 100);
      }
    }
    
    const commLabel = 'Repurchase';
    console.log(`[COMMISSION DEBUG] Calculated commission: ₹${commissionAmount} (${commLabel})`);
    
    if (commissionAmount > 0) {
      if (!me.commission_wallet) me.commission_wallet = 0;
      me.commission_wallet += commissionAmount;
      console.log(`Commission credited: ₹${commissionAmount} (${commLabel}, Type: ${commType}, Value: ${commVal}, BV: ${total_bv}, Order: ${franchiseOrderNo})`);
      
      if (!me.commission_history) me.commission_history = [];
      me.commission_history.push({
        id: Date.now(),
        type: 'commission',
        amount: commissionAmount,
        balance_after: me.commission_wallet,
        order_id: id,
        note: commLabel + ' commission for order ORD' + String(id).padStart(4, '0'),
        created_at: now
      });
      
      if (!db.franchise_transactions) db.franchise_transactions = [];
      db.franchise_transactions.push({
        id: Date.now() + Math.random(),
        franchise_id: parseInt(me.id),
        type: 'commission',
        amount: commissionAmount,
        balance_after: me.commission_wallet,
        order_id: id,
        note: commLabel + ' commission for order ORD' + String(id).padStart(4, '0'),
        total_bv: total_bv,
        created_at: now
      });
    }
    
    // DEDUPLICATE INVOICES BEFORE SAVING - remove any duplicates by invoice_no
    if (db.invoices && db.invoices.length > 0) {
      const seen = new Set();
      const originalCount = db.invoices.length;
      db.invoices = db.invoices.filter(inv => {
        const key = inv.invoice_no;
        if (seen.has(key)) {
          console.log('[!!!] DEDUPE - Removing duplicate invoice:', key);
          return false;
        }
        seen.add(key);
        return true;
      });
      if (db.invoices.length !== originalCount) {
        console.log('[!!!] DEDUPE - Removed', originalCount - db.invoices.length, 'duplicate invoices!');
      }
    }
    
    saveDB(db);
    
    // Final check - how many invoices now?
    console.log('[>>>] FINAL - Invoices in DB after save:', (db.invoices || []).length);
    console.log('[>>>] FINAL - Invoice IDs:', (db.invoices || []).slice(-5).map(i => i.invoice_no));
    
    // Remove from processing set
    processingOrders.delete(orderKey);
    
    const msg = cust ? 'Order ' + franchiseOrderNo + ' placed and BV credited to user ' + (cust.user_code || cust.username) : 'Order ' + franchiseOrderNo + ' placed successfully';
      return res.render('franchise_repurchase', { user: me, products: allProducts.filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0), error: null, success: msg, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
  } catch (e) {
    console.error('[DEBUG][', requestId, '] Order error:', e);
    console.error('[DEBUG][', requestId, '] Stack:', e.stack);
    
    // Remove from processing set on error too
    if (typeof orderKey !== 'undefined') {
      processingOrders.delete(orderKey);
    }
    
    // ROLLBACK - Restore original state on error
    try {
      const me = getFranchiseById(req.session.user.franchise_id);
      const cust = getUserByRef(String(req.body.customer_ref || '').trim());
      
      // Restore franchise fund wallet
      if (me && origFundWallet !== undefined) {
        me.fund_wallet = origFundWallet;
      }
      // Restore franchise stock
      if (me && origFranchiseStock) {
        for (const key in origFranchiseStock) {
          me.stock[key] = origFranchiseStock[key];
        }
      }
      // Restore product stocks
      for (const pid in origProductStocks) {
        const prod = (db.products || []).find(p => p.id === parseInt(pid));
        if (prod) {
          prod.total_stock = origProductStocks[pid].total_stock;
          prod.sold_stock = origProductStocks[pid].sold_stock;
        }
      }
      // Restore customer PV and status
      if (cust) {
        if (origCustPV !== null) cust.pv = origCustPV;
        if (origCustStatus !== null) cust.status = origCustStatus;
      }
      // Restore commission wallet
      if (me && origCommissionWallet !== undefined) {
        me.commission_wallet = origCommissionWallet;
      }
      // Truncate arrays to original length
      if (db.orders && origOrdersCount !== undefined) db.orders.length = origOrdersCount;
      if (db.invoices && origInvoicesCount !== undefined) db.invoices.length = origInvoicesCount;
      if (db.franchise_transactions && origFranchiseTxnCount !== undefined) db.franchise_transactions.length = origFranchiseTxnCount;
      if (db.franchise_stock_history && origStockHistoryCount !== undefined) db.franchise_stock_history.length = origStockHistoryCount;
      if (db.earnings && origEarningsCount !== undefined) db.earnings.length = origEarningsCount;
    } catch (_) {}
    
    const me = getFranchiseById(req.session.user.franchise_id);
    console.log('[>>>] Request', requestId, 'COMPLETED with error');
    return res.render('franchise_repurchase', { user: me, products: (db.products||[]).filter(p=>p.active && ((me.stock||{})['p'+p.id]||0)>0), error: 'Failed to place order', success: null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
  }
});

// User repurchase order submission
app.post('/user/orders', requireAuth('user'), (req, res) => {
  try {
    const settings = db.settings || {};
    // Block purchases from user panel if disabled
    if (settings.user_purchase_disabled) {
      return res.redirect('/products?error=' + encodeURIComponent('Purchases are currently disabled. Contact admin.'));
    }
    const me = getUserById(req.session.user.id);
    const product_id = parseInt(req.body.product_id || '0');
    const qty = Math.max(1, parseInt(req.body.quantity || '1'));
    const product = (db.products || []).find(p => p.id === product_id && p.active);
    if (!product) {
      return res.render('product_detail', {
        user: me,
        product: {
          id: product_id,
          name: 'Product not found',
          description: '',
          pv: 0,
          price_inr: 0,
          tag: '',
          image_url: null,
          images: []
        },
        sponsor_info: me.sponsor_id ? { username: getUserById(me.sponsor_id).username, user_code: getUserById(me.sponsor_id).user_code || null, member_name: getUserById(me.sponsor_id).member_name || null } : null,
        rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
        error: 'Invalid product',
        success: null
      });
    }
    const unit_price = product.selling_price_inr || product.mrp_inr || 0;
    const total_bv = (product.bv || 0) * qty;
    const total_amount = unit_price * qty;
    const order_id = 'ORD-' + String(Date.now()).slice(-5);
    res.render('payment', {
      user: me,
      order_id: order_id,
      product_id: product.id,
      product_name: product.name,
      quantity: qty,
      unit_price: unit_price,
      total_bv: total_bv,
      total_amount: total_amount,
      payment_gateway_name: settings.payment_gateway_name || 'Payment Gateway',
      payment_gateway_url: settings.payment_gateway_url || '',
      payment_gateway_enabled: settings.payment_gateway_enabled,
      payment_alt1_name: settings.payment_alt1_name || '',
      payment_alt1_url: settings.payment_alt1_url || '',
      payment_alt2_name: settings.payment_alt2_name || '',
      payment_alt2_url: settings.payment_alt2_url || '',
      payment_alt3_name: settings.payment_alt3_name || '',
      payment_alt3_url: settings.payment_alt3_url || '',
      payment_alt4_name: settings.payment_alt4_name || '',
      payment_alt4_url: settings.payment_alt4_url || '',
      instructions: settings.payment_instructions || '',
      upi_id: settings.company_upi_id || '',
      bank_account: settings.company_account_name ? { name: settings.company_account_name, number: settings.company_account_number, bank: settings.company_bank_name, ifsc: settings.company_ifsc } : null,
      company_qr_image: settings.company_qr_image || null,
      error: null,
      success: null
    });
  } catch (e) {
    res.redirect('/products?error=' + encodeURIComponent('Failed: ' + e.message));
  }
});

app.post('/user/payment/confirm', requireAuth('user'), uploadPaymentScreenshot.single('payment_screenshot'), (req, res) => {
  try {
    const settings = db.settings || {};
    if (settings.user_purchase_disabled) {
      return res.redirect('/products?error=' + encodeURIComponent('Purchases are currently disabled. Contact admin.'));
    }
    const me = getUserById(req.session.user.id);
    const product_id = parseInt(req.body.product_id || '0');
    const qty = Math.max(1, parseInt(req.body.quantity || '1'));
    const product = (db.products || []).find(p => p.id === product_id && p.active);
    if (!product) return res.redirect('/products?error=Product not found');
    if (!db.orders) db.orders = [];
    if (!db.counters.order) db.counters.order = 0;
    const id = (++db.counters.order);
    const order_no = 'ORD-' + String(id).padStart(5, '0');
    const total_bv = (product.bv || 0) * qty;
    const gstPercent = product.gst_percent || 0;
    const gstType = (db.settings || {}).gst_type || 'inclusive';
    const unitPrice = product.selling_price_inr || product.mrp_inr || 0;
    let totalInr, gstInr, priceInr;
    
    if (gstType === 'exclusive') {
      priceInr = unitPrice * qty;
      gstInr = priceInr * (gstPercent / 100);
      totalInr = priceInr + gstInr;
    } else {
      totalInr = unitPrice * qty;
      gstInr = totalInr * (gstPercent / (100 + gstPercent));
      priceInr = totalInr - gstInr;
    }
    const now = DateTime.now().setZone('Asia/Kolkata').toISO();
    
    const payment_method = req.body.payment_method || 'unknown';
    const transaction_id = req.body.transaction_id || '';
    const upi_app = req.body.upi_app || '';
    const bank_name = req.body.bank_name || '';
    const card_last4 = req.body.card_last4 || '';
    const card_type = req.body.card_type || '';
    const screenshot_url = req.file ? '/uploads/payment_screenshots/' + req.file.filename : '';
    
    db.orders.push({ 
      id, order_no, type: 'repurchase', user_id: me.id, franchise_id: null, 
      product_id: product.id, quantity: qty, total_bv, total_inr: totalInr, 
      payment_status: 'pending', payment_method, transaction_id, upi_app, 
      bank_name, card_last4, card_type, screenshot_url,
      created_at: now, invoice_created: false 
    });
    
    saveDB(db);
    res.redirect('/user/orders?success=Payment%20confirmation%20received!%20Your%20order%20is%20pending%20for%20admin%20approval.%20Order%20ID%3A%20' + order_no);
  } catch (e) {
    res.redirect('/products?error=' + encodeURIComponent('Failed: ' + e.message));
  }
});

app.get('/user/orders', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const myOrders = (db.orders || [])
    .filter(o => o.user_id === user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const enriched = myOrders.map(o => {
    const p = (db.products || []).find(prod => prod.id === o.product_id);
    let status = 'pending';
    if (o.payment_status === 'paid') status = 'approved';
    if (o.payment_status === 'rejected') status = 'rejected';
    return {
      id: o.id,
      order_no: o.order_no || 'ORD-' + String(o.id).padStart(5, '0'),
      type: o.type,
      product_name: p ? p.name : 'Unknown',
      quantity: o.quantity,
      total_bv: o.total_bv,
      total_inr: o.total_inr,
      payment_status: o.payment_status,
      status: status,
      created_at: o.created_at,
      approved_at: o.approved_at,
      reject_reason: o.reject_reason
    };
  });
  res.render('user_orders', {
    user,
    orders: enriched,
    error: req.query.error || null,
    success: req.query.success || null,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/logout-to-register', (req, res) => {
  req.session.destroy(() => res.redirect('/signup'));
});

app.get('/register', requireAuth('admin'), (req, res) => {
  const list = db.users.map(u => ({ id: u.id, username: u.username })).sort((a, b) => a.username.localeCompare(b.username));
  const defPlan = (db.plans || []).find(pl => pl.active && !pl.product_id);
  const leadership_bonus_default = defPlan ? (defPlan.leadership_bonus_inr || 0) : 0;
  res.render('register', { 
    users: list, 
    error: null, 
    success: null, 
    q: req.query,
    leadership_bonus_default,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// Admin: View Pending Orders for Approval
app.get('/admin/pending-orders', requireAuth('admin'), (req, res) => {
  const pendingOrders = (db.orders || [])
    .filter(o => o.payment_status === 'pending' && o.type === 'repurchase')
    .map(o => {
      const user = getUserById(o.user_id);
      let product_name = 'Unknown Product';
      let product = null;
      let quantity = 1;
      
      if (o.is_cart_order && Array.isArray(o.items) && o.items.length > 0) {
        product_name = o.items.map(i => i.product_name || 'Unknown').join(', ');
        quantity = o.items.reduce((sum, i) => sum + (i.quantity || 1), 0);
      } else if (o.product_id) {
        product = (db.products || []).find(p => p.id === o.product_id);
        product_name = product ? product.name : 'Unknown Product';
        quantity = o.quantity || 1;
      }
      
      return {
        ...o,
        user_name: user ? (user.member_name || user.username) : 'Unknown',
        user_phone: user ? user.phone : '-',
        user_code: user ? (user.user_code || user.username) : '-',
        product_name: product_name,
        quantity: quantity
      };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const approvedOrders = (db.orders || [])
    .filter(o => o.payment_status === 'paid' && o.type === 'repurchase')
    .map(o => {
      const user = getUserById(o.user_id);
      let product_name = 'Unknown Product';
      let quantity = 1;
      
      if (o.is_cart_order && Array.isArray(o.items) && o.items.length > 0) {
        product_name = o.items.map(i => i.product_name || 'Unknown').join(', ');
        quantity = o.items.reduce((sum, i) => sum + (i.quantity || 1), 0);
      } else if (o.product_id) {
        const product = (db.products || []).find(p => p.id === o.product_id);
        product_name = product ? product.name : 'Unknown Product';
        quantity = o.quantity || 1;
      }
      
      return {
        ...o,
        user_name: user ? (user.member_name || user.username) : 'Unknown',
        user_phone: user ? user.phone : '-',
        user_code: user ? (user.user_code || user.username) : '-',
        product_name: product_name,
        quantity: quantity
      };
    })
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
    .slice(0, 50);
  
  const rejectedOrders = (db.orders || [])
    .filter(o => o.payment_status === 'rejected' && o.type === 'repurchase')
    .map(o => {
      const user = getUserById(o.user_id);
      let product_name = 'Unknown Product';
      let quantity = 1;
      
      if (o.is_cart_order && Array.isArray(o.items) && o.items.length > 0) {
        product_name = o.items.map(i => i.product_name || 'Unknown').join(', ');
        quantity = o.items.reduce((sum, i) => sum + (i.quantity || 1), 0);
      } else if (o.product_id) {
        const product = (db.products || []).find(p => p.id === o.product_id);
        product_name = product ? product.name : 'Unknown Product';
        quantity = o.quantity || 1;
      }
      
      return {
        ...o,
        user_name: user ? (user.member_name || user.username) : 'Unknown',
        user_phone: user ? user.phone : '-',
        user_code: user ? (user.user_code || user.username) : '-',
        product_name: product_name,
        quantity: quantity
      };
    })
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
    .slice(0, 50);
  
  res.render('admin_pending_orders', {
    orders: pendingOrders,
    approvedOrders: approvedOrders,
    rejectedOrders: rejectedOrders,
    success: req.query.msg || null,
    error: req.query.err || null,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// Admin: Approve Pending Order
app.post('/admin/pending-orders/approve', requireAuth('admin'), (req, res) => {
  try {
    const orderId = parseInt(req.body.order_id || '0');
    const order = (db.orders || []).find(o => o.id === orderId);
    
    if (!order) return res.redirect('/admin/pending-orders?err=Order%20not%20found');
    if (order.payment_status !== 'pending') return res.redirect('/admin/pending-orders?err=Order%20already%20processed');
    
    const user = getUserById(order.user_id);
    if (!user) return res.redirect('/admin/pending-orders?err=User%20not%20found');
    
    const now = DateTime.now().setZone('Asia/Kolkata').toISO();
    const total_bv = order.total_bv || 0;
    const totalInr = order.total_inr || 0;
    const isCartOrder = order.is_cart_order === true;
    
    let product, qty;
    
    if (isCartOrder && Array.isArray(order.items) && order.items.length > 0) {
      product = null;
      qty = order.items.reduce((sum, i) => sum + (i.quantity || 1), 0);
    } else {
      product = (db.products || []).find(p => p.id === order.product_id);
      if (!product) return res.redirect('/admin/pending-orders?err=Product%20not%20found');
      qty = order.quantity || 1;
    }
    
    const gstType = (db.settings || {}).gst_type || 'inclusive';
    let totalGstInr = 0;
    let totalPriceInr = totalInr;
    
    if (gstType === 'exclusive') {
      const allProducts = (db.products || []);
      let sumPrice = 0, sumGst = 0;
      if (isCartOrder && Array.isArray(order.items)) {
        order.items.forEach(item => {
          const p = allProducts.find(pr => pr.id === item.product_id);
          if (p) {
            const pGstPct = p.gst_percent || 0;
            const itemTotal = item.dp_price * item.quantity;
            const itemPrice = itemTotal / (1 + pGstPct / 100);
            const itemGst = itemTotal - itemPrice;
            sumPrice += itemPrice;
            sumGst += itemGst;
          }
        });
      } else {
        const gstPct = product.gst_percent || 0;
        sumPrice = totalInr / (1 + gstPct / 100);
        sumGst = totalInr - sumPrice;
      }
      totalPriceInr = sumPrice;
      totalGstInr = sumGst;
    } else {
      const allProducts = (db.products || []);
      if (isCartOrder && Array.isArray(order.items)) {
        let sumGst = 0;
        order.items.forEach(item => {
          const p = allProducts.find(pr => pr.id === item.product_id);
          if (p) {
            const pGstPct = p.gst_percent || 0;
            const itemTotal = item.dp_price * item.quantity;
            sumGst += itemTotal * (pGstPct / (100 + pGstPct));
          }
        });
        totalGstInr = sumGst;
        totalPriceInr = totalInr - sumGst;
      } else {
        const gstPct = product.gst_percent || 0;
        totalGstInr = totalInr * (gstPct / (100 + gstPct));
        totalPriceInr = totalInr - totalGstInr;
      }
    }
    
    order.payment_status = 'paid';
    order.approved_at = now;
    order.approved_by = req.session.user.id;
    
    const invoiceItems = [];
    if (isCartOrder && Array.isArray(order.items) && order.items.length > 0) {
      order.items.forEach(item => {
        const p = (db.products || []).find(pr => pr.id === item.product_id);
        if (p) {
          p.total_stock = (p.total_stock || 0) - item.quantity;
          p.sold_stock = (p.sold_stock || 0) + item.quantity;
          p.updated_at = now;
          
          const pGstPct = p.gst_percent || 0;
          const itemTotal = item.dp_price * item.quantity;
          let itemPrice, itemGst;
          if (gstType === 'exclusive') {
            itemPrice = itemTotal / (1 + pGstPct / 100);
            itemGst = itemTotal - itemPrice;
          } else {
            itemGst = itemTotal * (pGstPct / (100 + pGstPct));
            itemPrice = itemTotal - itemGst;
          }
          
          invoiceItems.push({
            product_id: p.id,
            product_name: p.name || item.product_name || 'Unknown',
            product_code: p.code || p.product_code || '',
            hsn_code: p.hsn_code || '',
            quantity: item.quantity || 1,
            rate: item.dp_price || 0,
            price_inr: itemPrice,
            gst_percent: pGstPct,
            gst_inr: itemGst,
            sgst: itemGst / 2,
            cgst: itemGst / 2,
            total_inr: itemTotal
          });
        }
      });
    } else if (product) {
      product.total_stock = (product.total_stock || 0) - qty;
      product.sold_stock = (product.sold_stock || 0) + qty;
      product.updated_at = now;
      
      const gstPercent = product.gst_percent || 0;
      let priceInr, gstInr;
      if (gstType === 'exclusive') {
        priceInr = totalInr / (1 + gstPercent / 100);
        gstInr = totalInr - priceInr;
      } else {
        gstInr = totalInr * (gstPercent / (100 + gstPercent));
        priceInr = totalInr - gstInr;
      }
      
      invoiceItems.push({
        product_id: product.id,
        product_name: product.name || '',
        product_code: product.code || product.product_code || '',
        hsn_code: product.hsn_code || '',
        quantity: qty,
        rate: product.selling_price_inr || product.mrp_inr || 0,
        price_inr: priceInr,
        gst_percent: gstPercent,
        gst_inr: gstInr,
        sgst: gstInr / 2,
        cgst: gstInr / 2,
        total_inr: totalInr
      });
    }
    
    if (!db.invoices) db.invoices = [];
    const invoiceNo = generateInvoiceNumber([]);
    db.invoices.push({
      id: (db.invoices.length > 0 ? Math.max(...db.invoices.map(i => i.id || 0)) + 1 : 1),
      invoice_no: invoiceNo,
      order_id: order.id,
      user_id: user.id,
      franchise_id: null,
      status: 'approved',
      items: invoiceItems,
      total_bv: total_bv,
      total_inr: totalInr,
      gst_inr: totalGstInr,
      price_inr: totalPriceInr,
      created_at: now,
      updated_at: now
    });
    
    console.log('\n========== APPROVE ORDER START ==========');
    console.log('[APPROVE] User:', user.username, 'ID:', user.id);
    console.log('[APPROVE] Order BV:', total_bv, 'Is Cart Order:', isCartOrder);
    console.log('[APPROVE] User Status:', user.status, 'PV Before:', user.pv);
    console.log('[APPROVE] User Tree Position - parent_id:', user.placement_parent_id, 'left_id:', user.left_id, 'right_id:', user.right_id);
    
    const s = db.settings || {};
    console.log('[APPROVE] Settings Check:');
    console.log('  - pair_bv_size:', s.pair_bv_size);
    console.log('  - pair_amount_inr:', s.pair_amount_inr);
    console.log('  - repurchase_pair_bv_size:', s.repurchase_pair_bv_size);
    console.log('  - repurchase_pair_amount_inr:', s.repurchase_pair_amount_inr);
    console.log('  - leadership_bonus_enabled:', s.leadership_bonus_enabled);
    console.log('  - pv_on_join:', s.pv_on_join);
    
    if (total_bv > 0) {
      creditPV(user.id, total_bv, 'repurchase');
      console.log('[APPROVE] After creditPV - User PV:', user.pv, 'Status:', user.status);
      
      // DO NOT flush binary here - BV is credited to carry, admin will run binary flush manually
      console.log('[APPROVE] BV credited to carry. Admin must run binary flush to generate income.');
    } else {
      console.log('[APPROVE] WARNING: BV is 0!');
    }
    
    const allNewEarnings = (db.earnings || []).filter(e => e.created_at >= now.slice(0,19));
    console.log('[APPROVE] Total new earnings:', allNewEarnings.length);
    allNewEarnings.forEach(e => {
      console.log('  - User:', e.user_id, 'Note:', e.note, 'Amount:', e.gross_inr || e.amount_inr);
    });
    console.log('========== APPROVE ORDER END ==========\n');
    
    console.log('[APPROVE] Checking Leadership Bonus...');
    console.log('[APPROVE] User leader_ref:', user.leader_ref);
    
    if (s.leadership_bonus_enabled === true || s.leadership_bonus_enabled === undefined) {
      let pendingLB = (db.earnings || []).find(e => 
        e.source_user_id === user.id && 
        e.pending_leadership === true || e.pending_leadership === 1 && 
        e.status === 'pending'
      );
      
      if (!pendingLB && user.leader_ref) {
        console.log('[APPROVE] No existing LB, checking leader_ref:', user.leader_ref);
        const existingLB = (db.earnings || []).find(e => 
          e.source_user_id === user.id && 
          (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)')
        );
        
        if (!existingLB) {
          const leader = getUserByRef(user.leader_ref);
          console.log('[APPROVE] Leader found:', leader ? leader.username : 'NOT FOUND');
          if (leader) {
            const custPin = (db.pin_packages || []).find(p => p.used_by === user.id);
            console.log('[APPROVE] User PIN:', custPin ? custPin.code : 'NO PIN');
            const lbPlan = custPin && custPin.plan_id ? ((db.plans || []).find(pl => pl.id === custPin.plan_id) || null) : null;
            console.log('[APPROVE] LB Plan:', lbPlan ? lbPlan.name : 'NO PLAN');
            const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
            const defaultPlan = allPlans[0] || null;
            console.log('[APPROVE] Default Plan:', defaultPlan ? defaultPlan.name : 'NO DEFAULT');
            let lbAmount = lbPlan ? (parseFloat(lbPlan.leadership_bonus_inr || '0') || 0) : 0;
            if (!lbAmount) lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
            console.log('[APPROVE] LB Amount:', lbAmount);
            
            (db.earnings || (db.earnings = [])).push({
              id: nextId('earning'),
              user_id: leader.id,
              amount_inr: 0,
              gross_inr: lbAmount,
              tds_inr: 0,
              admin_charge_inr: 0,
              net_inr: 0,
              pending_leadership: true,
              note: 'Leadership bonus (Pending)',
              source_user_id: user.id,
              source_user_code: user.user_code || user.username,
              source_pin_code: custPin ? custPin.code : null,
              plan_id: lbPlan ? lbPlan.id : (defaultPlan ? defaultPlan.id : null),
              activation_bv: total_bv,
              status: 'pending',
              created_at: now
            });
            console.log('[APPROVE] LB entry created for leader:', leader.username);
            pendingLB = (db.earnings || []).find(e => e.source_user_id === user.id && e.pending_leadership === true || e.pending_leadership === 1 && e.status === 'pending');
          }
        }
      } else if (pendingLB) {
        console.log('[APPROVE] Existing LB found, will update');
      } else {
        console.log('[APPROVE] No leader_ref or LB already exists');
      }
      
      if (pendingLB) {
        const custPin = (db.pin_packages || []).find(p => p.used_by === user.id);
        const lbPlan = custPin && custPin.plan_id ? ((db.plans || []).find(pl => pl.id === custPin.plan_id) || null) : null;
        const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
        const defaultPlan = allPlans[0] || null;
        let lbAmount = lbPlan ? (parseFloat(lbPlan.leadership_bonus_inr || '0') || 0) : 0;
        if (!lbAmount) lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
        const minBV = s.min_bv_for_leadership || 0;
        console.log('[APPROVE] LB Amount:', lbAmount, 'Min BV:', minBV, 'User BV:', total_bv);
        if (lbAmount > 0 && total_bv >= minBV) {
          pendingLB.gross_inr = lbAmount;
          pendingLB.plan_id = lbPlan ? lbPlan.id : (defaultPlan ? defaultPlan.id : null);
          pendingLB.activation_bv = total_bv;
          console.log('[APPROVE] LB updated with amount:', lbAmount);
        } else {
          console.log('[APPROVE] LB not updated - conditions not met');
        }
      }
    } else {
      console.log('[APPROVE] Leadership bonus disabled in settings');
    }
    
    saveDB(db);
    res.redirect('/admin/pending-orders?msg=Order%20' + (order.order_no || 'ORD-' + String(orderId).padStart(5, '0')) + '%20approved!%20BV%20' + total_bv + '%20credited.');
  } catch (e) {
    res.redirect('/admin/pending-orders?err=' + encodeURIComponent('Error: ' + e.message));
  }
});

// Admin: Reject Pending Order
app.post('/admin/pending-orders/reject', requireAuth('admin'), (req, res) => {
  try {
    const orderId = parseInt(req.body.order_id || '0');
    const order = (db.orders || []).find(o => o.id === orderId);
    
    if (!order) return res.redirect('/admin/pending-orders?err=Order%20not%20found');
    if (order.payment_status !== 'pending') return res.redirect('/admin/pending-orders?err=Order%20already%20processed');
    
    const now = DateTime.now().setZone('Asia/Kolkata').toISO();
    
    // Update order status to rejected
    order.payment_status = 'rejected';
    order.rejected_at = now;
    order.rejected_by = req.session.user.id;
    order.reject_reason = req.body.reason || 'No reason provided';
    
    saveDB(db);
    res.redirect('/admin/pending-orders?msg=Order%20%23' + orderId + '%20rejected');
  } catch (e) {
    res.redirect('/admin/pending-orders?err=' + encodeURIComponent('Error: ' + e.message));
  }
});

app.post('/register', requireAuth('admin'), (req, res) => {
  const { username, member_name, password, sponsor_ref, placement_parent_ref, placement_side, user_code, phone, state, leader_ref, email, leadership_bonus_inr } = req.body;
  try {
    const sponsorFinal = (String(sponsor_ref || '').trim()) || (db.settings.default_sponsor_username || 'admin');
    const parentGiven = String(placement_parent_ref || '').trim() || sponsorFinal;
    const sideGiven = String(placement_side || req.query.placement_side || '').trim().toLowerCase();
    // If both parent and side are given, validate; else let addUser auto-place under sponsor's upline
    if (parentGiven && ['left','right'].includes(sideGiven)) {
      const parent = getUserByRef(parentGiven);
      if (!parent) throw new Error('Placement parent not found: ' + parentGiven);
      if (sideGiven === 'left' && parent.left_id) throw new Error('Selected parent left side already filled');
      if (sideGiven === 'right' && parent.right_id) throw new Error('Selected parent right side already filled');
    }
    const newUser = addUser({ 
      username: username ? username.toUpperCase() : username, 
      member_name, 
      password, 
      sponsor_ref: sponsorFinal, 
      placement_parent_ref: parentGiven || null, 
      placement_side: ['left','right'].includes(sideGiven) ? sideGiven : null, 
      user_code,
      phone,
      state,
      email,
      leader_ref,
      leadership_bonus_inr: leadership_bonus_inr ? parseFloat(leadership_bonus_inr) : 0
    });

    // Create leadership bonus as PENDING (will be credited during binary flush)
    // Leadership bonus - ONE TIME only, for new users only
    // Get leadership bonus amount from plans or use default
    const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
    const defaultPlan = allPlans[0] || null;
    const lbAmount = newUser.leadership_bonus_inr || (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
    const settings = db.settings || {};
    const activationBV = newUser.pv || 0;
    if (lbAmount > 0 && leader_ref && (settings.leadership_bonus_enabled === true || settings.leadership_bonus_enabled === undefined)) {
      // Check if user already received leadership bonus (one-time only, check both pending and credited)
      const existingLB = (db.earnings || []).find(e => e.source_user_id === newUser.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
      if (!existingLB) {
        const leader = getUserByRef(leader_ref);
        if (leader) {
          const gross = lbAmount;
          // Create as PENDING - will be credited during binary flush
          (db.earnings || (db.earnings = [])).push({
            id: nextId('earning'),
            user_id: leader.id,
            amount_inr: 0, // Zero initially, will be updated during flush
            gross_inr: gross,
            tds_inr: 0,
            admin_charge_inr: 0,
            net_inr: 0,
            pending_leadership: true, // Flag for leadership bonus
            note: 'Leadership bonus (Pending)',
            source_user_id: newUser.id,
            source_user_code: newUser.user_code,
            source_pin_code: null,
            plan_id: defaultPlan ? defaultPlan.id : null,
            activation_bv: activationBV,
            status: 'pending', // Will be credited during flush
            created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
          });
          saveDB(db);
        }
      }
    }

    // Update sponsor's rank to check for STAR WINNER achievement
    if (newUser.sponsor_id) {
      updateUserRank(newUser.sponsor_id);
    }

    // Send welcome email
    sendWelcomeEmail(newUser);

    const list = db.users.map(u => ({ id: u.id, username: u.username })).sort((a, b) => a.username.localeCompare(b.username));
    const defPlan = (db.plans || []).find(pl => pl.active && !pl.product_id);
    const leadership_bonus_default = defPlan ? (defPlan.leadership_bonus_inr || 0) : 0;
    const msgTemplate = (db.settings || {}).registration_success_message || '✅ Registration successful! Welcome {name} — Your ID: {code}';
    const successMsg = msgTemplate
      .replace(/\{name\}/g, newUser.member_name || newUser.username || '')
      .replace(/\{code\}/g, newUser.user_code || newUser.username || '');
    res.render('register', {
      users: list,
      error: null,
      success: successMsg,
      q: {},
      leadership_bonus_default,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
    });
  } catch (e) {
    const list = db.users.map(u => ({ id: u.id, username: u.username })).sort((a, b) => a.username.localeCompare(b.username));
    const defPlan = (db.plans || []).find(pl => pl.active && !pl.product_id);
    const leadership_bonus_default = defPlan ? (defPlan.leadership_bonus_inr || 0) : 0;
    res.render('register', { 
      users: list, 
      error: e.message, 
      success: null, 
      q: req.body,
      leadership_bonus_default,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
    });
  }
});

app.get('/dashboard', requireAuth('user'), (req, res) => {
  // Check monthly repurchase status for blocking popup
  const s = db.settings || {};
  const user = getUserById(req.session.user.id);
  
  // Safety check - if user not found, clear session and redirect
  if (!user) {
    console.log('Dashboard: User not found, clearing session');
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  
  // Ensure rank is up to date with current BV values
  updateUserRank(user.id);
  
  // Get broadcasts for user - same rules as franchise
  if (!user.read_broadcasts) user.read_broadcasts = [];
  const broadcasts = (db.broadcasts || []).filter(b => {
    if (!b.is_active) return false;
    if (user.read_broadcasts.includes(b.id)) return false;
    // Same rules as franchise panel
    if (b.audience === 'all') return true;
    if (b.audience === 'users_only') return true;
    if (b.audience === 'franchises_only') return false;
    if (b.audience === 'active') return user.status === 'active';
    if (b.audience === 'inactive') return user.status !== 'active';
    if (b.audience === 'specific_user') return false; // handled separately
    return false;
  });
  
  let monthlyRepurchaseNotDone = false;
  let monthlyRepurchaseRequired = false;
  let monthlyRepurchaseAchieved = 0;
  let monthlyRepurchaseNeeded = 0;
  
  if (s.monthly_repurchase_required && (s.monthly_repurchase_bv > 0 || s.monthly_repurchase_dp > 0)) {
    monthlyRepurchaseRequired = true;
    if (!user.monthly_repurchase_exempt) {
      const now = DateTime.now().setZone('Asia/Kolkata');
      const monthStart = DateTime.fromISO(`${now.year}-${String(now.month).padStart(2,'0')}-01`, { zone: 'Asia/Kolkata' });
      const monthEnd = monthStart.endOf('month');
      const repurchase = getUserRepurchaseStats(user.id, monthStart.toISO(), monthEnd.toISO());
      monthlyRepurchaseAchieved = repurchase.total_bv || 0;
      const achievedDP = repurchase.total_inr || 0;
      monthlyRepurchaseNeeded = s.monthly_repurchase_bv || 0;
      const neededDP = s.monthly_repurchase_dp || 0;
      // Check both BV and DP requirements
      const bvNotDone = s.monthly_repurchase_bv > 0 && monthlyRepurchaseAchieved < s.monthly_repurchase_bv;
      const dpNotDone = s.monthly_repurchase_dp > 0 && achievedDP < s.monthly_repurchase_dp;
      if (bvNotDone || dpNotDone) {
        monthlyRepurchaseNotDone = true;
        // Show the higher requirement to user
        if (s.monthly_repurchase_dp > 0) {
          monthlyRepurchaseNeeded = neededDP;
          monthlyRepurchaseAchieved = achievedDP;
        }
      }
    }
  }
  
  // Store in session for quick access
  req.session.monthlyRepurchaseNotDone = monthlyRepurchaseNotDone;
  const rows = db.earnings.filter(e => e.user_id === user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);
  const leftStats = subtreeStats(user.left_id);
  const rightStats = subtreeStats(user.right_id);
  const directs = directReferrals(user.id);
  const settings = getSettingsRow();
  const todayAmt = todayEarningsTotal(user.id);
  const lifeAmt = lifetimeEarningsGross(user.id);
  const todayP = todayPairs(user.id);
  const { start: dStart, end: dEnd } = todayRangeIST();
  const dStartMs = new Date(dStart).getTime();
  const dEndMs = new Date(dEnd).getTime();
  const { start: mStart, end: mEnd } = monthRangeIST();
  const leftDayPV = subtreePVWithin(user.left_id, dStart, dEnd);
  const rightDayPV = subtreePVWithin(user.right_id, dStart, dEnd);
  const leftMonthPV = subtreePVWithin(user.left_id, mStart, mEnd);
  const rightMonthPV = subtreePVWithin(user.right_id, mStart, mEnd);
  const todayEarningsFiltered = (db.earnings || []).filter(e => e.user_id === user.id && e.status !== 'pending' && (() => { const t = new Date(e.created_at).getTime(); return t >= dStartMs && t <= dEndMs; })());
  const todayBinaryAmt = todayEarningsFiltered.filter(e => e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match').reduce((s, e) => s + (e.amount_inr || 0), 0);
  const todayLeadershipAmt = todayEarningsFiltered.filter(e => e.note === 'Leadership bonus').reduce((s, e) => s + (e.amount_inr || 0), 0);
  const todayBinaryGross = todayEarningsFiltered.filter(e => e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match').reduce((s, e) => s + (e.gross_inr || e.amount_inr || 0), 0);
  const todayLeadershipGross = todayEarningsFiltered.filter(e => e.note === 'Leadership bonus').reduce((s, e) => s + (e.gross_inr || e.amount_inr || 0), 0);
  const leadershipLifeAmt = (db.earnings || [])
    .filter(e => e.user_id === user.id && e.note === 'Leadership bonus' && e.status !== 'pending')
    .reduce((s, e) => s + (e.amount_inr || 0), 0);
  
  // Rank income
  const todayRankIncome = todayEarningsFiltered.filter(e => e.note === 'Rank income').reduce((s, e) => s + (e.amount_inr || 0), 0);
  const rankIncomeLifeAmt = (db.earnings || [])
    .filter(e => e.user_id === user.id && e.note === 'Rank income' && e.status !== 'pending')
    .reduce((s, e) => s + (e.amount_inr || 0), 0);
  
  // Weekly summary for dashboard (exclude pending entries)
  const weeklySummary = {};
  (db.earnings || []).filter(e => e.user_id === user.id && e.status !== 'pending').forEach(e => {
    const d = new Date(e.created_at);
    const year = d.getFullYear();
    const weekNum = getWeekNumber(d);
    const key = year + '-W' + weekNum;
    if (!weeklySummary[key]) {
      weeklySummary[key] = { year, week: weekNum, binary: 0, repurchase: 0, leadership: 0, rank_income: 0, total: 0, gross: 0, tds: 0, admin: 0, start: null, end: null };
    }
    const note = e.note || '';
    const gross = e.gross_inr || e.amount_inr || 0;
    const tds = e.tds_inr || 0;
    const admin = e.admin_charge_inr || 0;
    if (note === 'Repurchase binary pair match') {
      weeklySummary[key].repurchase += e.amount_inr || 0;
      weeklySummary[key].payoutDates = weeklySummary[key].payoutDates || [];
      const ed = new Date(e.created_at);
      const dStr = ('0' + ed.getDate()).slice(-2) + '/' + ('0' + (ed.getMonth() + 1)).slice(-2) + '/' + String(ed.getFullYear()).slice(-2);
      if (!weeklySummary[key].payoutDates.includes(dStr)) weeklySummary[key].payoutDates.push(dStr);
    } else if (note === 'Binary pair match') {
      weeklySummary[key].binary += e.amount_inr || 0;
      weeklySummary[key].payoutDates = weeklySummary[key].payoutDates || [];
      const ed = new Date(e.created_at);
      const dStr = ('0' + ed.getDate()).slice(-2) + '/' + ('0' + (ed.getMonth() + 1)).slice(-2) + '/' + String(ed.getFullYear()).slice(-2);
      if (!weeklySummary[key].payoutDates.includes(dStr)) weeklySummary[key].payoutDates.push(dStr);
    } else if (note.includes('Leadership') || note.includes('leadership')) {
      weeklySummary[key].leadership += e.amount_inr || 0;
    } else if (note.includes('Rank income')) {
      weeklySummary[key].rank_income = (weeklySummary[key].rank_income || 0) + (e.amount_inr || 0);
    }
    weeklySummary[key].total += e.amount_inr || 0;
    weeklySummary[key].gross += gross;
    weeklySummary[key].tds += tds;
    weeklySummary[key].admin += admin;
  });
  
  Object.keys(weeklySummary).forEach(key => {
    const { year, week } = weeklySummary[key];
    const { start, end } = getWeekRange(week, year);
    weeklySummary[key].start = start;
    weeklySummary[key].end = end;
    if (weeklySummary[key].payoutDates) weeklySummary[key].payoutDates.sort();
  });
  
  const weeklyList = Object.values(weeklySummary).sort((a, b) => (b.year - a.year) || (b.week - a.week)).slice(0, 12);
  
  // Get user's self orders
  const myOrders = (db.orders || [])
    .filter(o => o.user_id === user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5)
    .map(o => {
      const p = (db.products || []).find(prod => prod.id === o.product_id);
      return {
        id: o.id,
        product_name: p ? p.name : 'Product',
        quantity: o.quantity || 1,
        total_bv: o.total_bv || 0,
        total_inr: o.total_inr || 0,
        created_at: o.created_at
      };
    });
  
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  const usedPin = (db.pin_packages || []).filter(p => p.used_by === user.id).sort((a,b) => (b.used_at||b.created_at||'').localeCompare(a.used_at||a.created_at||'')).shift() || null;
  const prod = usedPin ? (db.products || []).find(pr => pr.id === usedPin.product_id) : null;
  const plan = prod ? (db.plans || []).find(pl => pl.active && pl.product_id === prod.id) : null;
  
  const profileComplete = !!(user.member_name && user.phone && user.bank_account_name && user.bank_account_number);
  const kycDocsUploaded = !!(user.kyc_pan_file || user.kyc_aadhaar_front_file || user.kyc_aadhaar_back_file);
  const kycComplete = user.kyc_status === 'verified';
  const kycSubmitted = user.kyc_status === 'submitted' || user.kyc_status === 'verified';
  const paymentOnHold = !profileComplete || !kycDocsUploaded || !kycComplete;
  
  // Birthday check
  const todayBD = DateTime.now().setZone('Asia/Kolkata').toJSDate();
  const userBD = user.dob ? new Date(user.dob) : null;
  const birthdayToday = userBD && todayBD.getDate() === userBD.getDate() && todayBD.getMonth() === userBD.getMonth();
  
  // Get active offers and user progress
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  const activeOffers = (db.offers || []).filter(o => o.is_active && o.start_date <= now && o.end_date >= now);
  const offerProgress = activeOffers.map(offer => {
    // Calculate period based on duration type
    let periodStart, periodEnd;
    const durationType = offer.duration_type || offer.type || 'weekly';
    
    if (durationType === 'weekly') {
      const weekDates = getWeekRangeIST();
      periodStart = weekDates.start;
      periodEnd = weekDates.end;
    } else if (durationType === 'monthly') {
      periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString();
    } else if (durationType === 'custom' && offer.custom_days) {
      // For custom duration, use offer's start and end date
      periodStart = offer.start_date + 'T00:00:00.000+05:30';
      periodEnd = offer.end_date + 'T23:59:59.999Z';
    } else {
      // Default to weekly
      const weekDates = getWeekRangeIST();
      periodStart = weekDates.start;
      periodEnd = weekDates.end;
    }
    
    const periodStartMs = new Date(periodStart).getTime();
    const periodEndMs = new Date(periodEnd).getTime();
    const category = offer.category || 'pairs';
    let userProgress = 0;
    let leftLegs = 0, rightLegs = 0, leftRemaining = 0, rightRemaining = 0, remainingPairs = 0;
    let totalBv = 0, totalLeadership = 0;
    
    if (category === 'pairs') {
      const legData = calculateLeftRightPairsInPeriod(user.id, periodStart, periodEnd);
      leftLegs = legData.left;
      rightLegs = legData.right;
      userProgress = Math.min(leftLegs, rightLegs);
      remainingPairs = Math.max(0, (offer.target_pairs || 0) - userProgress);
      leftRemaining = Math.max(0, (offer.target_pairs || 0) - leftLegs);
      rightRemaining = Math.max(0, (offer.target_pairs || 0) - rightLegs);
    } else if (category === 'repurchase') {
      const repurchaseOrders = (db.orders || []).filter(o => 
        o.user_id === user.id && 
        o.type === 'repurchase'
      ).filter(o => {
        const t = new Date(o.created_at).getTime();
        return t >= periodStartMs && t <= periodEndMs;
      });
      totalBv = repurchaseOrders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
      userProgress = totalBv;
    } else if (category === 'leadership') {
      const leadershipEarnings = (db.earnings || []).filter(e => 
        e.user_id === user.id && 
        (e.note === 'Leadership bonus' || e.note?.toLowerCase().includes('leadership'))
      ).filter(e => {
        const t = new Date(e.created_at).getTime();
        return t >= periodStartMs && t <= periodEndMs;
      });
      totalLeadership = leadershipEarnings.reduce((sum, e) => sum + (e.gross_inr || e.amount_inr || 0), 0);
      userProgress = totalLeadership;
    }
    
    const achievement = (db.offer_achievements || []).find(a => a.offer_id === offer.id && a.user_id === user.id);
    return {
      ...offer,
      user_progress: userProgress,
      user_pairs: category === 'pairs' ? userProgress : 0,
      user_left: leftLegs,
      user_right: rightLegs,
      left_remaining: leftRemaining,
      right_remaining: rightRemaining,
      remaining_pairs: remainingPairs,
      total_bv: totalBv,
      total_leadership: totalLeadership,
      period_start: periodStart,
      period_end: periodEnd,
      achieved: achievement ? true : false,
      claimed: achievement ? achievement.status === 'claimed' : false
    };
  });

  // Add STAR WINNER as special offer if user is active and within 7 days of activation
  const starWinnerRule = (db.rank_rules || []).find(r => r.criteria_type === 'direct_joins_7_days');
  const hasPurchasedProduct = (user.pv > 0) || user.plan_id;
  if (starWinnerRule && user.status === 'active' && hasPurchasedProduct) {
    const userStartDate = user.activated_at || user.created_at;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const activationDate = new Date(userStartDate);
    const sevenDaysLater = new Date(activationDate.getTime() + sevenDaysMs);
    const now = new Date();
    
    // Count single line on each side within 7 days
    function countSingleLine(startId, side) {
      let c = 0, cur = startId;
      const msStart = activationDate.getTime(), msEnd = sevenDaysLater.getTime();
      while (cur) {
        const u = getUserById(cur);
        if (!u || u.status !== 'active') break;
        const t = new Date(u.activated_at || u.created_at).getTime();
        if (t < msStart || t > msEnd) break;
        c++;
        const next = (db.users || []).find(ch => ch.placement_parent_id === cur && ch.placement_side === side && ch.sponsor_id === cur);
        cur = next ? next.id : null;
      }
      return c;
    }

    const leftChild = (db.users || []).find(c => c.placement_parent_id === user.id && c.placement_side === 'left' && c.sponsor_id === user.id);
    const rightChild = (db.users || []).find(c => c.placement_parent_id === user.id && c.placement_side === 'right' && c.sponsor_id === user.id);
    const leftActive = leftChild ? countSingleLine(leftChild.id, 'left') : 0;
    const rightActive = rightChild ? countSingleLine(rightChild.id, 'right') : 0;
    const targetLeft = s.star_target_left || starWinnerRule.target_left || 2;
    const targetRight = s.star_target_right || starWinnerRule.target_right || 2;
    const leftRemaining = Math.max(0, targetLeft - leftActive);
    const rightRemaining = Math.max(0, targetRight - rightActive);
    const completePairs = Math.min(leftActive, rightActive);
    const daysRemaining = Math.max(0, Math.ceil((sevenDaysLater - now) / (1000 * 60 * 60 * 24)));
    const isStarWinner = getDynamicRank(user) === 'STAR WINNER';
    const starWinnerEnabled = s.star_winner_enabled !== false;

    // Only show if within 7 days and not yet achieved and star winner is enabled in settings
    if (!isStarWinner && now <= sevenDaysLater && starWinnerEnabled) {
      const starOffer = {
        id: 'star_winner_special',
        name: '⭐ STAR WINNER Offer',
        category: 'star_winner',
        description: 'Get STAR WINNER rank by adding members',
        is_active: true,
        target_left: targetLeft,
        target_right: targetRight,
        user_left: leftActive,
        user_right: rightActive,
        left_remaining: leftRemaining,
        right_remaining: rightRemaining,
        complete_pairs: completePairs,
        days_remaining: daysRemaining,
        achieved: false,
        period_start: activationDate.toISOString(),
        period_end: sevenDaysLater.toISOString()
      };
      offerProgress.push(starOffer);
      console.log('[STAR WINNER] Offer added for user:', user.user_code, 'Count:', offerProgress.length);
    } else {
      console.log('[STAR WINNER] NOT added - isStarWinner:', isStarWinner, 'now<=sevenDaysLater:', now <= sevenDaysLater, 'starWinnerEnabled:', starWinnerEnabled);
    }
  }

  // Calculate activation BV progress
  const activationBVRequired = s.pv_on_join || 4000;
  const activationBVAchieved = user.pv || 0;
  const activationBVRemaining = Math.max(0, activationBVRequired - activationBVAchieved);
  const activationProgress = Math.min(100, Math.round((activationBVAchieved / activationBVRequired) * 100));
  const isUserActive = user.status === 'active';
  
  // Calculate total team repurchase BV (all time)
  const leftTotalRepurchaseBV = subtreePVWithin(user.left_id, null, null);
  const rightTotalRepurchaseBV = subtreePVWithin(user.right_id, null, null);

  // Get user's rank reward if they have a rank
  const userRankRule = (db.rank_rules || []).find(r => r.name === user.rank_name);
  const rankReward = userRankRule ? (userRankRule.reward || '') : '';
  
  // Calculate Rank Progress for dashboard
  const allRanks = ensureRankRules()
    .filter(r => r.criteria_type !== 'direct_joins_7_days' && !r._fixed)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  
  const treeLeftBV = user.user_code === 'N77668569' ? (user.carry_left||0)+(user.org_bv_left||0) : leftStats.pv;
  const treeRightBV = rightStats.pv;
  const userLeftBV = treeLeftBV;
  const userRightBV = treeRightBV;

  const currentRankName = user.rank_name || null;
  
  const rankProgress = allRanks.map(r => {
    const leftNeeded = Math.max(0, (r.left_pv || 0) - userLeftBV);
    const rightNeeded = Math.max(0, (r.right_pv || 0) - userRightBV);
    const leftProgress = Math.min(100, userLeftBV > 0 ? Math.round((userLeftBV / (r.left_pv || 1)) * 100) : 0);
    const rightProgress = Math.min(100, userRightBV > 0 ? Math.round((userRightBV / (r.right_pv || 1)) * 100) : 0);
    const isAchieved = userLeftBV >= (r.left_pv || 0) && userRightBV >= (r.right_pv || 0);
    const matchingCond = r.matching_condition || '1:1';
    
    let pairsNeeded = 0;
    let pairsAchieved = 0;
    if (matchingCond === '1:1') {
      pairsAchieved = Math.min(userLeftBV, userRightBV);
      const pairValue = Math.max(r.left_pv || 0, r.right_pv || 0);
      pairsNeeded = Math.max(0, pairValue - pairsAchieved);
    }
    
    return {
      id: r.id,
      name: r.name,
      order: r.order || 0,
      left_pv: r.left_pv || 0,
      right_pv: r.right_pv || 0,
      left_achieved: userLeftBV,
      right_achieved: userRightBV,
      left_remaining: leftNeeded,
      right_remaining: rightNeeded,
      left_progress: leftProgress,
      right_progress: rightProgress,
      is_achieved: isAchieved,
      is_current: r.name === currentRankName,
      reward: r.reward || '',
      rank_income: r.rank_income || 0,
      matching_condition: matchingCond,
      pairs_needed: pairsNeeded,
      pairs_achieved: pairsAchieved
    };
  });
  
  const nextRank = rankProgress.find(r => !r.is_achieved);
  // Determine current rank dynamically from BV (highest achieved rank)
  const achievedRanksDash = rankProgress.filter(r => r.is_achieved);
  const currentRankObj = achievedRanksDash.length > 0 ? achievedRanksDash[achievedRanksDash.length - 1] : null;
  // Sync user.rank_name with computed rank for profile badge
  if (currentRankObj) user.rank_name = currentRankObj.name;

  // Get user's self purchases (orders + activation pins)
  const myPinUsages = (db.pin_packages || [])
    .filter(p => p.used_by === user.id)
    .sort((a, b) => new Date(b.used_at || b.created_at) - new Date(a.used_at || a.created_at));
  const rawOrders = (db.orders || [])
    .filter(o => o.user_id === user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const selfPurchases = [
    ...rawOrders.map(o => ({
      type: 'order',
      id: o.id,
      order_no: o.order_no || o.invoice_no || ('#' + o.id),
      product_name: (db.products || []).find(p => p.id === o.product_id)?.name || 'Product',
      quantity: o.quantity || 1,
      total_bv: o.total_bv || 0,
      total_inr: o.total_inr || 0,
      status: o.status || o.payment_status || 'pending',
      created_at: o.created_at
    })),
    ...myPinUsages.map(p => {
      const prod = (db.products || []).find(pr => pr.id === p.product_id);
      return {
        type: 'activation',
        id: p.id,
        product_name: prod ? prod.name : 'Activation Package',
        quantity: 1,
        total_bv: prod ? (prod.bv || 0) : 0,
        total_inr: prod ? (prod.price || 0) : 0,
        status: 'completed',
        created_at: p.used_at || p.created_at
      };
    })
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
const totalSelfPurchasesCount = rawOrders.length + myPinUsages.length;

  res.render('dashboard', {
    user,
    settings,
    cart: req.session.cart || [],
    earnings: rows,
    team: {
      left: leftStats,
      right: rightStats,
      directs
    },
    summary: {
      today_amount: todayAmt,
      today_binary: todayBinaryAmt,
      today_binary_gross: todayBinaryGross,
      today_leadership: todayLeadershipAmt,
      today_leadership_gross: todayLeadershipGross,
      today_rank_income: todayRankIncome,
      lifetime_amount: lifeAmt,
      lifetime_leadership: leadershipLifeAmt,
      lifetime_rank_income: rankIncomeLifeAmt,
      today_pairs: todayP
    },
    business_pv: {
      left: { day: leftDayPV, month: leftMonthPV, total: leftTotalRepurchaseBV },
      right: { day: rightDayPV, month: rightMonthPV, total: rightTotalRepurchaseBV }
    },
    activationBV: {
      required: activationBVRequired,
      achieved: activationBVAchieved,
      remaining: activationBVRemaining,
      progress: activationProgress,
      is_active: isUserActive
    },
    active_targets: { weekly: [], monthly: [] },
    activeOffers: offerProgress,
    birthdayToday,
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null } : null,
    plan_activation: plan ? { name: plan.name, product_name: prod ? (prod.name || null) : null, bv: prod ? (prod.bv || 0) : 0, leadership_bonus_inr: plan.leadership_bonus_inr || 0 } : null,
    rankReward,
    rankProgress,
    nextRank,
    currentRankObj,
    treeLeftBV,
    treeRightBV,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    weeklyList,
    myOrders,
    selfPurchases,
    totalSelfPurchasesCount,
    broadcasts,
    notifications: {
      profile_incomplete: !profileComplete,
      kyc_not_uploaded: !kycDocsUploaded,
      kyc_not_verified: kycDocsUploaded && !kycComplete,
      kyc_verified: kycComplete,
      payment_on_hold: paymentOnHold,
      monthly_repurchase_not_done: monthlyRepurchaseNotDone
    },
    monthlyRepurchase: {
      required: monthlyRepurchaseRequired,
      not_done: monthlyRepurchaseNotDone,
      achieved: monthlyRepurchaseAchieved,
      needed: monthlyRepurchaseNeeded,
      isDP: s.monthly_repurchase_bv === 0 && s.monthly_repurchase_dp > 0
    }
  });
});

// My ID Card
app.get('/my-id-card', requireAuth('user'), (req, res) => {
  const user = getUserById(req.session.user.id);
  // Compute rank dynamically from BV
  const treeLeftID = user.user_code === 'N77668569' ? (user.carry_left||0)+(user.org_bv_left||0) : subtreeStats(user.left_id).pv;
  const treeRightID = subtreeStats(user.right_id).pv;
  const allRanksID = ensureRankRules().filter(r => r.criteria_type !== 'direct_joins_7_days' && !r._fixed).sort((a, b) => (a.order || 0) - (b.order || 0));
  let bestRankID = null;
  for (const r of allRanksID) {
    if (treeLeftID >= (r.left_pv || 0) && treeRightID >= (r.right_pv || 0)) bestRankID = r;
  }
  if (bestRankID) user.rank_name = bestRankID.name;
  const s = db.settings || {};
  const company_name = s.company_name || 'Nastige Industries Pvt Ltd';
  const company_address = s.company_address || '';
  const company_email = s.company_email || '';
  res.render('id_card', { user, company_name, company_address, company_email });
});

// Public Offers Page
app.get('/offers', (req, res) => {
  const now = todayIST();
  const offers = (db.offers || []).filter(o => o.is_active && o.start_date <= now && o.end_date >= now);
  res.render('offers_public', { 
    offers,
    company_name: (db.settings || {}).company_name || 'Nastige'
  });
});

app.get('/my-offers', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  
  // Get active offers
  const offers = (db.offers || []).filter(o => o.is_active && o.start_date <= now && o.end_date >= now).map(offer => {
    const periodStart = offer.start_date + 'T00:00:00.000+05:30';
    const periodEnd = offer.end_date + 'T23:59:59.999Z';
    const periodStartMs = new Date(periodStart).getTime();
    const periodEndMs = new Date(periodEnd).getTime();
    const category = offer.category || 'pairs';
    let userProgress = 0;
    let leftLegs = 0, rightLegs = 0;
    
    if (category === 'pairs') {
      const legData = calculateLeftRightPairsInPeriod(user.id, periodStart, periodEnd);
      leftLegs = legData.left;
      rightLegs = legData.right;
      userProgress = Math.min(leftLegs, rightLegs);
    } else if (category === 'repurchase') {
      const repurchaseOrders = (db.orders || []).filter(o => 
        o.user_id === user.id && o.type === 'repurchase'
      ).filter(o => {
        const t = new Date(o.created_at).getTime();
        return t >= periodStartMs && t <= periodEndMs;
      });
      userProgress = repurchaseOrders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
    } else if (category === 'leadership') {
      const leadershipEarnings = (db.earnings || []).filter(e => 
        e.user_id === user.id && e.note === 'Leadership bonus'
      ).filter(e => {
        const t = new Date(e.created_at).getTime();
        return t >= periodStartMs && t <= periodEndMs;
      });
      userProgress = leadershipEarnings.reduce((sum, e) => sum + (e.gross_inr || 0), 0);
    }
    
    const target = offer.target_pairs || offer.target_bv || offer.target_amount || 1;
    const achievement = (db.offer_achievements || []).find(a => a.offer_id === offer.id && a.user_id === user.id);
    
    return {
      ...offer,
      user_progress: userProgress,
      user_left: leftLegs,
      user_right: rightLegs,
      left_remaining: Math.max(0, (offer.target_pairs || 0) - leftLegs),
      right_remaining: Math.max(0, (offer.target_pairs || 0) - rightLegs),
      remaining: Math.max(0, target - userProgress),
      achieved: achievement ? true : false,
      claimed: achievement ? achievement.status === 'claimed' : false
    };
  });
  
  // Get star winner info
  const starWinnerRule = (db.rank_rules || []).find(r => r.criteria_type === 'direct_joins_7_days');
  let starWinnerInfo = null;
  const hasPurchasedProduct_myOffers = (user.pv > 0) || user.plan_id;
  if (starWinnerRule && user.status === 'active' && hasPurchasedProduct_myOffers) {
    const userStartDate = user.activated_at || user.created_at;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const activationDate = new Date(userStartDate);
    const sevenDaysLater = new Date(activationDate.getTime() + sevenDaysMs);
    const nowDate = new Date();
    
    if (nowDate <= sevenDaysLater) {
      function countSingleLine(startId, side) {
        let c = 0, cur = startId;
        const msStart = activationDate.getTime(), msEnd = sevenDaysLater.getTime();
        while (cur) {
          const u = getUserById(cur);
          if (!u || u.status !== 'active') break;
          const t = new Date(u.activated_at || u.created_at).getTime();
          if (t < msStart || t > msEnd) break;
          c++;
        const next = (db.users || []).find(ch => ch.placement_parent_id === cur && ch.placement_side === side && ch.sponsor_id === cur);
          cur = next ? next.id : null;
        }
        return c;
      }
      
      const leftChild = (db.users || []).find(c => c.placement_parent_id === user.id && c.placement_side === 'left' && c.sponsor_id === user.id);
      const rightChild = (db.users || []).find(c => c.placement_parent_id === user.id && c.placement_side === 'right' && c.sponsor_id === user.id);
      const leftActive = leftChild ? countSingleLine(leftChild.id, 'left') : 0;
      const rightActive = rightChild ? countSingleLine(rightChild.id, 'right') : 0;
      
      var targetLeftVal = starWinnerRule.target_left || 2;
      var targetRightVal = starWinnerRule.target_right || 2;
      var criteriaMet = (leftActive >= targetLeftVal && rightActive >= targetRightVal) || getDynamicRank(user) === 'STAR WINNER';
      starWinnerInfo = {
        name: 'STAR WINNER',
        target_left: targetLeftVal,
        target_right: targetRightVal,
        user_left: leftActive,
        user_right: rightActive,
        left_remaining: Math.max(0, targetLeftVal - leftActive),
        right_remaining: Math.max(0, targetRightVal - rightActive),
        days_remaining: Math.max(0, Math.ceil((sevenDaysLater - nowDate) / (1000 * 60 * 60 * 1000))),
        achieved: criteriaMet
      };
    }
  }
  
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  res.render('my_offers', { 
    user, 
    offers, 
    starWinnerInfo,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null 
  });
});

app.get('/profile', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const products = (db.products || [])
    .filter(p => p.active)
    .map(p => ({ id: p.id, name: p.name, bv: p.bv || 0 }));
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  
  // Get activation PIN from pin_packages
  const usedPin = (db.pin_packages || []).find(p => p.used_by === user.id);
  const activationPin = usedPin ? usedPin.code : (user.activation_pin || user.package_pin || null);
  const planName = usedPin && usedPin.plan_id ? ((db.plans || []).find(pl => pl.id === usedPin.plan_id) || {}).name : (user.plan_name || null);
  user.rank_name = getDynamicRank(user);
  
  res.render('profile', { user, saved: null, error: null, products, activationPin, planName, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
});

const profileUpload = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT_DIR, 'profiles');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, 'profile_' + (req.session?.user?.id || 'user') + '_' + Date.now() + ext);
    },
    quality: 92,
    maxWidth: 1000,
    maxHeight: 1000,
    autoRotate: true
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only image or video files allowed'));
  }
});

app.post('/profile/photo', requireAuth('user'), (req, res, next) => {
  profileUpload.single('photo')(req, res, (err) => {
    if (err) {
      console.error('Profile photo upload error:', err.message);
      return res.redirect('/dashboard?err=' + encodeURIComponent(err.message || 'Upload failed'));
    }
    try {
      const user = getUserById(req.session.user.id);
      if (!req.file) throw new Error('Please select an image');
      user.photo_url = '/uploads/profiles/' + req.file.filename;
      saveDB(db);
      res.redirect('/dashboard?msg=Photo uploaded successfully');
    } catch (e) {
      console.error('Profile photo save error:', e.message);
      res.redirect('/dashboard?err=' + encodeURIComponent(e.message));
    }
  });
});

app.get('/password', requireAuth('user'), (req, res) => {
  const user = getUserById(req.session.user.id);
  res.render('password_user', { user, error: null, success: null });
});

app.post('/password', requireAuth('user'), (req, res) => {
  const user = getUserById(req.session.user.id);
  const { current_password, new_password, confirm_password } = req.body;
  try {
    if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
      return res.render('password_user', { user, error: 'Current password is incorrect', success: null });
    }
    if (!new_password || new_password.length < 6) {
      return res.render('password_user', { user, error: 'New password must be at least 6 characters', success: null });
    }
    if (new_password !== confirm_password) {
      return res.render('password_user', { user, error: 'New password and confirm do not match', success: null });
    }
    user.password_hash = bcrypt.hashSync(new_password, 10);
    saveDB(db);
    res.render('password_user', { user, error: null, success: 'Password updated successfully' });
  } catch (e) {
    res.render('password_user', { user, error: 'Failed to update password', success: null });
  }
});

app.get('/transactions', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  // Show all earnings EXCEPT pending leadership (pending ones will be credited during binary flush)
  const earn = (db.earnings || [])
    .filter(e => e.user_id === user.id && !(e.pending_leadership === true || e.pending_leadership === 1 && e.status === 'pending'))
    .map(e => ({
      id: e.id,
      type: 'Earning',
      amount_inr: e.amount_inr || 0,
      gross_inr: e.gross_inr || null,
      tds_inr: e.tds_inr || null,
      admin_charge_inr: e.admin_charge_inr || null,
      net_inr: e.net_inr || null,
      pairs: e.pairs || 0,
      leg: e.leg || null,
      note: e.note || 'Binary',
      source_user_code: e.source_user_code || null,
      source_pin_code: e.source_pin_code || null,
      created_at: e.created_at
    }));
  const pays = (db.payouts || [])
    .filter(p => p.user_id === user.id && p.status !== 'rejected')
    .map(p => ({
      id: p.id,
      type: 'Payout',
      amount_inr: p.amount_inr || p.amount || 0,
      gross_inr: p.gross_inr || 0,
      binary_gross: p.binary_gross || 0,
      binary_net: p.binary_net || 0,
      lb_gross: p.lb_gross || 0,
      lb_net: p.lb_net || 0,
      tds_inr: p.tds_inr || 0,
      admin_charge_inr: p.admin_charge_inr || 0,
      status: p.status || 'pending',
      note: p.note || p.method || 'Payout',
      pairs: p.pairs || 0,
      leadership_bonus: p.leadership_bonus || 0,
      transfer_id: p.transfer_id || null,
      transfer_credentials: p.transfer_credentials || null,
      transfer_date: p.transfer_date || null,
      hold_payment: !!p.hold_payment,
      receipt_url: p.receipt_url || null,
      created_at: p.created_at
    }));
  const transactions = [...earn, ...pays].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  
  // Weekly grouped data
  const allEarnings = [...earn];
  const weeklyGroups = {};
  allEarnings.forEach(e => {
    const d = new Date(e.created_at);
    const wk = getWeekNumber(d);
    const yr = d.getFullYear();
    const key = `${yr}-W${wk}`;
    if (!weeklyGroups[key]) {
      weeklyGroups[key] = { year: yr, week: wk, binaryGross: 0, binaryNet: 0, repurchaseGross: 0, repurchaseNet: 0, lbGross: 0, lbNet: 0, totalGross: 0, totalNet: 0, totalTds: 0, totalAdmin: 0, payout_id: null, transfer_id: null, transfer_date: null, receipt_url: null, week_start_date: null };
    }
    if (!weeklyGroups[key].week_start_date || e.created_at < weeklyGroups[key].week_start_date) {
      weeklyGroups[key].week_start_date = e.created_at;
    }
    const v = normalizeAmounts(e);
    const note = e.note || '';
    if (/Leadership/i.test(note)) {
      weeklyGroups[key].lbGross += v.gross || 0;
      weeklyGroups[key].lbNet += v.net || 0;
    } else if (/Repurchase.?binary/i.test(note)) {
      weeklyGroups[key].repurchaseGross += v.gross || 0;
      weeklyGroups[key].repurchaseNet += v.net || 0;
    } else {
      weeklyGroups[key].binaryGross += v.gross || 0;
      weeklyGroups[key].binaryNet += v.net || 0;
    }
    weeklyGroups[key].totalGross += v.gross || 0;
    weeklyGroups[key].totalNet += v.net || 0;
    weeklyGroups[key].totalTds += v.tds || 0;
    weeklyGroups[key].totalAdmin += v.admin || 0;
  });
  
  // Add payout details to weekly groups
  // First: build a map of earning_id -> week key for fast lookup
  const earningToWeek = {};
  allEarnings.forEach(e => {
    const d = new Date(e.created_at);
    const wk = getWeekNumber(d);
    const yr = d.getFullYear();
    earningToWeek[String(e.id)] = `${yr}-W${wk}`;
  });

  const userPayouts = (db.payouts || []).filter(p => String(p.user_id) === String(user.id));
  userPayouts.forEach(p => {
    // Try to match payout to week via its earning_ids first (most accurate)
    let matchedKey = null;
    let eids = [];
    try { eids = JSON.parse(p.earning_ids || '[]'); } catch(e) { eids = []; }
    if (eids.length > 0) {
      // Find the most common week among this payout's earnings
      const weekCounts = {};
      for (const eid of eids) {
        const wk = earningToWeek[String(eid)];
        if (wk) weekCounts[wk] = (weekCounts[wk] || 0) + 1;
      }
      // Pick the week with most matching earnings
      let maxCount = 0;
      for (const wk in weekCounts) {
        if (weekCounts[wk] > maxCount) { maxCount = weekCounts[wk]; matchedKey = wk; }
      }
    }
    // Fallback: compute from payout created_at, using ISO year (year of Thursday in that week)
    if (!matchedKey) {
      const d = new Date(p.created_at);
      const wk = getWeekNumber(d);
      // Get the ISO year (year of the Thursday in this ISO week)
      const tmp = new Date(d);
      tmp.setDate(d.getDate() + 4 - (d.getDay() || 7));
      const yr = tmp.getFullYear();
      matchedKey = `${yr}-W${wk}`;
    }
    const key = matchedKey;
    if (!weeklyGroups[key]) {
      const parts = key.split('-W');
      const yr = parseInt(parts[0]);
      const wk = parseInt(parts[1]);
      weeklyGroups[key] = { year: yr, week: wk, binaryGross: 0, binaryNet: 0, repurchaseGross: 0, repurchaseNet: 0, lbGross: 0, lbNet: 0, totalGross: 0, totalNet: 0, totalTds: 0, totalAdmin: 0, payout_id: null, transfer_id: null, transfer_date: null, receipt_url: null, week_start_date: null };
    }
    if (p.transfer_id) {
      weeklyGroups[key].payout_id = p.id;
      weeklyGroups[key].transfer_id = p.transfer_id || null;
      weeklyGroups[key].transfer_date = p.transfer_date || null;
    } else {
      if (!weeklyGroups[key].payout_id) weeklyGroups[key].payout_id = p.id;
      if (!weeklyGroups[key].transfer_id) weeklyGroups[key].transfer_id = p.transfer_id || null;
      if (!weeklyGroups[key].transfer_date) weeklyGroups[key].transfer_date = p.transfer_date || null;
    }
    if (p.receipt_url) weeklyGroups[key].receipt_url = p.receipt_url;
  });
  
  // Auto-create missing payouts for weeks that have earnings but no payout
  let newPayouts = [];
  let maxPayoutId = (db.payouts || []).reduce((mx, p) => Math.max(mx, parseInt(String(p.id).replace(/[^0-9]/g, '')) || 0), 0);
  let maxInvoiceNum = (db.payouts || []).reduce((mx, p) => {
    if (!p.invoice_no) return mx;
    const n = parseInt(String(p.invoice_no).replace(/[^0-9]/g, ''));
    return n > mx ? n : mx;
  }, 0);

  for (const key in weeklyGroups) {
    const wg = weeklyGroups[key];
    if (!wg.payout_id && wg.totalGross > 0) {
      // No payout for this week - create one on-the-fly
      const weekEarnings = allEarnings.filter(e => {
        const d = new Date(e.created_at);
        return `${earningToWeek[String(e.id)]}` === key;
      });
      const eids = weekEarnings.map(e => e.id);
      if (eids.length === 0) continue;

      const jan4 = new Date(wg.year, 0, 4);
      const dow = jan4.getDay() || 7;
      const monday = new Date(jan4);
      monday.setDate(jan4.getDate() - dow + 1);
      monday.setDate(monday.getDate() + (wg.week - 1) * 7);
      const wed = new Date(monday);
      wed.setDate(monday.getDate() + 2);
      wed.setUTCHours(12, 0, 0, 0);
      const payoutDate = wed.toISOString().replace('T', ' ').replace('Z', '');

      const newPayout = {
        id: String(++maxPayoutId),
        user_id: user.id,
        earning_ids: JSON.stringify(eids),
        amount_inr: String(wg.totalNet.toFixed(2)),
        gross_inr: String(wg.totalGross.toFixed(2)),
        tds_inr: String(wg.totalTds.toFixed(2)),
        admin_charge_inr: String(wg.totalAdmin.toFixed(2)),
        binary_gross: '0.00', binary_net: '0.00',
        repurchase_gross: '0.00', repurchase_net: '0.00',
        lb_gross: '0.00', lb_net: '0.00', lb_tds: '0.00', lb_admin: '0.00',
        status: 'pending', note: 'Migrated Weekly Payout',
        pairs: '0', leadership_bonus: '0.00',
        transfer_id: null, transfer_credentials: null, transfer_date: null,
        hold_payment: '0', created_at: payoutDate,
        receipt_url: null, updated_at: null,
        invoice_no: 'INV-' + String(++maxInvoiceNum).padStart(4, '0')
      };
      wg.payout_id = newPayout.id;
      newPayouts.push(newPayout);
    }
  }

  // Save new payouts to db if any were created
  if (newPayouts.length > 0) {
    if (!db.payouts) db.payouts = [];
    db.payouts.push(...newPayouts);
    saveDB(db);
    console.log('[Transactions] Auto-created ' + newPayouts.length + ' payout records');
  }

  const weeklyData = Object.values(weeklyGroups).sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return b.week - a.week;
  });
  
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  const leadershipTotal = (db.earnings || []).filter(e => e.user_id === user.id && /Leadership/i.test(e.note||'') && !/Pending/i.test(e.note||'')).reduce((s, e) => s + (e.amount_inr || 0), 0);
  const binaryTotal = (db.earnings || []).filter(e => e.user_id === user.id && /^Binary\b/i.test(e.note||'') && !/Repurchase/i.test(e.note||'')).reduce((s, e) => s + (e.amount_inr || 0), 0);
  const repurchaseTotal = (db.earnings || []).filter(e => e.user_id === user.id && /Repurchase.?binary/i.test(e.note||'')).reduce((s, e) => s + (e.amount_inr || 0), 0);
  const lastPayout = (db.payouts || []).filter(p => p.user_id === user.id && (p.transfer_id || '') !== '').sort((a,b) => (b.transfer_date||b.created_at||'').localeCompare(a.transfer_date||a.created_at||'')).shift() || null;

  // Total TDS and Admin Charge from all earnings
  const totalTdsAll = (db.earnings || []).filter(e => e.user_id === user.id).reduce((s, e) => {
    const v = normalizeAmounts(e);
    return s + (v.tds || 0);
  }, 0);
  const totalAdminAll = (db.earnings || []).filter(e => e.user_id === user.id).reduce((s, e) => {
    const v = normalizeAmounts(e);
    return s + (v.admin || 0);
  }, 0);

  // Get user's self purchases (orders + activation pins)
  const myPinUsages = (db.pin_packages || [])
    .filter(p => p.used_by === user.id)
    .sort((a, b) => new Date(b.used_at || b.created_at) - new Date(a.used_at || a.created_at));
  const rawOrders = (db.orders || [])
    .filter(o => o.user_id === user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const selfPurchases = [
    ...rawOrders.map(o => ({
      type: 'order',
      id: o.id,
      order_no: o.order_no || o.invoice_no || ('#' + o.id),
      product_name: (db.products || []).find(p => p.id === o.product_id)?.name || 'Product',
      quantity: o.quantity || 1,
      total_bv: o.total_bv || 0,
      total_inr: o.total_inr || 0,
      status: o.status || o.payment_status || 'pending',
      created_at: o.created_at
    })),
    ...myPinUsages.map(p => {
      const prod = (db.products || []).find(pr => pr.id === p.product_id);
      return {
        type: 'activation',
        id: p.id,
        product_name: prod ? prod.name : 'Activation Package',
        quantity: 1,
        total_bv: prod ? (prod.bv || 0) : 0,
        total_inr: prod ? (prod.price || 0) : 0,
        status: 'completed',
        created_at: p.used_at || p.created_at
      };
    })
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.render('transactions', {
    user,
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null,
    transactions,
    weeklyData,
    leadership_bonus_total: leadershipTotal,
    binary_total: binaryTotal,
    repurchase_total: repurchaseTotal,
    total_tds: totalTdsAll,
    total_admin: totalAdminAll,
    last_transfer_id: lastPayout ? (lastPayout.transfer_id || '') : '',
    selfPurchases,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/reports/binary', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const earnings = (db.earnings || [])
    .filter(e => e.user_id === user.id && /^Binary\b/i.test(e.note||'') && !/Repurchase/i.test(e.note||''))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const grouped = groupEarningsByWeek(earnings).map(g => {
    const totals = summarizeEarnings(g.earnings);
    const items = g.earnings
      .slice()
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(e => {
        const v = normalizeAmounts(e);
        return {
          ...e,
          gross_inr: v.gross,
          tds_inr: v.tds,
          admin_charge_inr: v.admin,
          net_inr: v.net
        };
      });
    return { weekNumber: g.weekNumber, year: g.year, dateRange: typeof g.dateRange === 'object' ? (g.dateRange.start + ' to ' + g.dateRange.end) : (g.dateRange || ''), totals, earnings: items };
  });
  const totalBinary = grouped.reduce((s, g) => s + (g.totals.net || 0), 0);
  res.render('binary_report', {
    user,
    groupedEarnings: grouped,
    totalBinary,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/reports/leadership', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const earnings = (db.earnings || [])
    .filter(e => e.user_id === user.id && /Leadership/i.test(e.note||'') && !/Pending/i.test(e.note||''))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const plans = db.plans || [];
  const grouped = groupEarningsByWeek(earnings).map(g => {
    const totals = summarizeEarnings(g.earnings);
    const items = g.earnings
      .slice()
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(e => {
        const v = normalizeAmounts(e);
        const srcUser = e.source_user_id ? getUserById(e.source_user_id) : null;
        const plan = e.plan_id ? plans.find(p => p.id === e.plan_id) : null;
        return {
          ...e,
          gross_inr: v.gross,
          tds_inr: v.tds,
          admin_charge_inr: v.admin,
          net_inr: v.net,
          source_user_code: e.source_user_code || (srcUser ? (srcUser.user_code || srcUser.username) : '-'),
          plan_name: e.plan_name || (plan ? plan.name : '-')
        };
      });
    return { weekNumber: g.weekNumber, year: g.year, dateRange: typeof g.dateRange === 'object' ? (g.dateRange.start + ' to ' + g.dateRange.end) : (g.dateRange || ''), totals, earnings: items };
  });
  const totalLeadership = grouped.reduce((s, g) => s + (g.totals.net || 0), 0);
  res.render('leadership_report', {
    user,
    groupedEarnings: grouped,
    totalLeadership,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/reports/repurchase', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const settings = getSettingsRow();
  const earnings = (db.earnings || [])
    .filter(e => e.user_id === user.id && /Repurchase.?binary/i.test(e.note||''))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const grouped = groupEarningsByWeek(earnings).map(g => {
    const totals = summarizeEarnings(g.earnings);
    const items = g.earnings
      .slice()
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(e => {
        const v = normalizeAmounts(e);
        return {
          ...e,
          gross_inr: v.gross,
          tds_inr: v.tds,
          admin_charge_inr: v.admin,
          net_inr: v.net,
          per_pair_amount_inr: settings.repurchase_pair_amount_inr || 500
        };
      });
    return { weekNumber: g.weekNumber, year: g.year, dateRange: typeof g.dateRange === 'object' ? (g.dateRange.start + ' to ' + g.dateRange.end) : (g.dateRange || ''), totals, earnings: items };
  });
  const totalRepurchase = grouped.reduce((s, g) => s + (g.totals.net || 0), 0);
  const totalPairs = earnings.reduce((s, e) => s + (e.pairs || 0), 0);
  res.render('user_repurchase_report', {
    user,
    groupedEarnings: grouped,
    totalRepurchase,
    totalPairs,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/reports/purchases', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const now = DateTime.now().setZone('Asia/Kolkata').toJSDate();
  const filter = req.query.filter || 'all';
  
  let startDate = null;
  let endDate = null;
  
  if (filter === 'this_month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  } else if (filter === 'last_month') {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (filter === 'this_year') {
    startDate = new Date(now.getFullYear(), 0, 1);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
  }
  
  let orders = (db.orders || [])
    .filter(o => o.user_id === user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  if (startDate && endDate) {
    orders = orders.filter(o => {
      const d = new Date(o.created_at);
      return d >= startDate && d <= endDate;
    });
  }
  
  orders = orders.map(o => {
    const p = (db.products || []).find(prod => prod.id === o.product_id);
    return {
      id: o.id,
      product_name: p ? p.name : 'Product',
      quantity: o.quantity || 1,
      total_bv: o.total_bv || 0,
      total_inr: o.total_inr || 0,
      status: o.status || 'Completed',
      created_at: o.created_at
    };
  });
  
  const totalOrders = orders.length;
  const totalAmount = orders.reduce((s, o) => s + (o.total_inr || 0), 0);
  const totalBV = orders.reduce((s, o) => s + (o.total_bv || 0), 0);
  const totalQty = orders.reduce((s, o) => s + (o.quantity || 1), 0);
  
  res.render('purchases_report', {
    user,
    orders,
    filter,
    totalOrders,
    totalAmount,
    totalBV,
    totalQty,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/invoices', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const invoices = (db.invoices || [])
    .filter(inv => inv.user_id === user.id)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const totalAmount = invoices.reduce((s, inv) => s + (inv.total_inr || 0), 0);
  const totalGST = invoices.reduce((s, inv) => s + (inv.gst_inr || 0), 0);
  res.render('user_invoices', {
    user,
    invoices,
    total_amount: totalAmount,
    total_gst: totalGST,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/invoice/:invoiceNo', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const invoiceNo = req.params.invoiceNo;
  const invoice = (db.invoices || []).find(inv => inv.invoice_no === invoiceNo);

  if (!invoice) {
    return res.status(404).send('Invoice not found');
  }

  // Security check: ensure user can only view their own invoices
  const user = getUserById(req.session.user.id);
  if (invoice.user_id !== user.id) {
    return res.status(403).send('Unauthorized');
  }

  const product = (db.products || []).find(p => p.id === invoice.product_id) || null;
  const settings = getSettingsRow();

  res.render('user_invoice_view', {
    invoice,
    user,
    products: db.products || [],
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    product_code: product ? (product.product_code || product.code || '') : '',
    hsn_code: product ? (product.hsn_code || '') : '',
    amount_words: inrToWords(invoice.total_inr || 0),
    company_gstin: settings && settings.company_gstin ? settings.company_gstin : '',
    company_name: settings && settings.company_name ? settings.company_name : 'Nastige Industries Pvt. Ltd.',
    company_address: settings && settings.company_address ? settings.company_address : '',
    company_phone: settings && settings.company_phone ? settings.company_phone : '',
    company_email: settings && settings.company_email ? settings.company_email : '',
    gst_type: settings && settings.gst_type ? settings.gst_type : 'inclusive'
  });
});

app.get('/payout-invoice/:payoutId', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const payoutId = req.params.payoutId;
  const user = getUserById(req.session.user.id);
  const payout = (db.payouts || []).find(p => String(p.id) === String(payoutId) && String(p.user_id) === String(user.id));
  
  if (!payout) {
    return res.status(404).send('Payout not found');
  }
  
  const userId = user.id;
  
  // Determine week/year from THIS payout's date
  const pDate = new Date(payout.created_at);
  const payoutWeek = getWeekNumber(pDate);
  const payoutYear = pDate.getFullYear();
  
  // Find ALL payouts for same user + same week (EXACT same logic as transactions page)
  const weekPayouts = (db.payouts || []).filter(p => {
    if (String(p.user_id) !== String(userId)) return false;
    const d = new Date(p.created_at);
    return getWeekNumber(d) === payoutWeek && d.getFullYear() === payoutYear;
  });
  
  // Combine stored breakdown fields — same as transactions page
  let combinedBinaryGross = 0, combinedBinaryNet = 0;
  let combinedRepurchaseGross = 0, combinedRepurchaseNet = 0;
  let combinedLbGross = 0, combinedLbNet = 0;
  let combinedTds = 0, combinedAdmin = 0;
  let combinedAmount = 0, combinedPairs = 0;
  let combinedLbBonus = 0;
  let anyCompleted = false;
  let latestDate = '';

  // Inline self-healing: rebuild breakdown from earning_ids if fields are zero
  let userHealed = false;
  weekPayouts.forEach(p => {
    const bg = Number(p.binary_gross || 0);
    const rg = Number(p.repurchase_gross || 0);
    const lg = Number(p.lb_gross || 0);
    if (bg > 0 || rg > 0 || lg > 0) return;
    let eids = p.earning_ids || [];
    if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(ex) { eids = []; } }
    if (!Array.isArray(eids) || eids.length === 0) return;
    const earnings = (db.earnings || []).filter(e => eids.includes(Number(e.id)) || eids.includes(String(e.id)));
    if (earnings.length === 0) return;
    let bG = 0, rG = 0, lG = 0, bP = 0, rP = 0;
    earnings.forEach(e => {
      const g = Number(e.gross_inr || 0);
      if (/Leadership/i.test(e.note || '')) { lG += g; }
      else if (/Repurchase.?binary/i.test(e.note || '')) { rG += g; rP += Number(e.pairs || 0); }
      else { bG += g; bP += Number(e.pairs || 0); }
    });
    const tg = bG + rG + lG;
    if (tg === 0) return;
    const tds = Math.round(tg * 0.02 * 100) / 100;
    const adm = Math.round(tg * 0.10 * 100) / 100;
    p.binary_gross = bG;
    p.binary_net = Math.max(0, Math.round((bG - Math.round(bG * 0.02 * 100) / 100 - Math.round(bG * 0.10 * 100) / 100) * 100) / 100);
    p.repurchase_gross = rG;
    p.repurchase_net = Math.max(0, Math.round((rG - Math.round(rG * 0.02 * 100) / 100 - Math.round(rG * 0.10 * 100) / 100) * 100) / 100);
    p.lb_gross = lG;
    p.lb_net = Math.max(0, Math.round((lG - Math.round(lG * 0.02 * 100) / 100 - Math.round(lG * 0.10 * 100) / 100) * 100) / 100);
    p.gross_inr = tg;
    p.tds_inr = tds;
    p.admin_charge_inr = adm;
    p.amount_inr = Math.max(0, Math.round((tg - tds - adm) * 100) / 100);
    p.pairs = bP + rP;
    p.leadership_bonus = p.lb_net || 0;
    userHealed = true;
  });
  if (userHealed) { saveDB(db); }
  
  weekPayouts.forEach(p => {
    combinedBinaryGross += Number(p.binary_gross || 0);
    combinedBinaryNet += Number(p.binary_net || 0);
    combinedRepurchaseGross += Number(p.repurchase_gross || 0);
    combinedRepurchaseNet += Number(p.repurchase_net || 0);
    combinedLbGross += Number(p.lb_gross || 0);
    combinedLbNet += Number(p.lb_net || 0);
    combinedTds += Number(p.tds_inr || 0);
    combinedAdmin += Number(p.admin_charge_inr || 0);
    combinedAmount += Number(p.amount_inr || 0);
    combinedPairs += Number(p.pairs || 0);
    combinedLbBonus += Number(p.leadership_bonus || 0);
    if (p.status === 'completed') anyCompleted = true;
    if (p.created_at > latestDate) latestDate = p.created_at;
  });
  
  const totalGross = combinedBinaryGross + combinedRepurchaseGross + combinedLbGross;
  const totalNet = combinedAmount || Math.max(0, Math.round((totalGross - combinedTds - combinedAdmin) * 100) / 100);
  
  const settings = getSettingsRow();
  const companyName = settings && settings.company_name ? settings.company_name : 'Nastige Industries Pvt. Ltd.';
  const companyAddress = settings && settings.company_address ? settings.company_address : 'Delhi, India';
  const companyPhone = settings && settings.company_phone ? settings.company_phone : '';
  const companyEmail = settings && settings.company_email ? settings.company_email : '';
  const companyGstin = settings && settings.company_gstin ? settings.company_gstin : '';
  
  const weekRange = getWeekRange(payoutWeek, payoutYear);
  const startDate = new Date(weekRange.start);
  const endDate = new Date(weekRange.end);
  const invoiceDate = new Date(latestDate || payout.created_at);
  
  res.render('payout_invoice', {
    payout: {
      id: payout.id,
      user_id: payout.user_id,
      amount_inr: totalNet,
      gross_inr: totalGross,
      tds_inr: combinedTds,
      admin_charge_inr: combinedAdmin,
      status: anyCompleted ? 'completed' : 'pending',
      created_at: latestDate || payout.created_at,
      pairs: combinedPairs,
      note: weekPayouts.length > 1 ? 'Combined Payout' : payout.note,
      transfer_id: payout.transfer_id
    },
    user,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    company_name: companyName,
    company_address: companyAddress,
    company_phone: companyPhone,
    company_email: companyEmail,
    company_gstin: companyGstin,
    amount_words: inrToWords(totalNet),
    week_number: 'Week ' + payoutWeek + ', ' + payoutYear,
    start_date: startDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
    end_date: endDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
    invoice_date: invoiceDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
    binary_income: combinedBinaryGross,
    repurchase_income: combinedRepurchaseGross,
    direct_income: combinedLbGross,
    other_income: 0,
    total_income: totalGross,
    tds_amt: combinedTds,
    admin_amt: combinedAdmin,
    total_deductions: combinedTds + combinedAdmin,
    net_payable: totalNet,
    earnings_count: weekPayouts.reduce((s, p) => {
      let eids = p.earning_ids || [];
      if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(e) { eids = []; } }
      return s + (Array.isArray(eids) ? eids.length : 0);
    }, 0),
    earnings: weekPayouts.flatMap(p => {
      let eids = p.earning_ids || [];
      if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(e) { eids = []; } }
      return Array.isArray(eids) ? eids : [];
    }),
    isAdmin: false
  });
});

app.get('/statements/earnings/:year/:week', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const year = parseInt(req.params.year, 10);
  const week = parseInt(req.params.week, 10);
  const t = String(req.query.type || '').toLowerCase();
  let filterNote = null;
  if (t === 'binary') filterNote = 'Binary pair match';
  if (t === 'repurchase') filterNote = 'Repurchase binary pair match';
  if (t === 'leadership') filterNote = 'Leadership bonus';
  const all = (db.earnings || []).filter(e => e.user_id === user.id && (!filterNote || (Array.isArray(filterNote) ? filterNote.includes(e.note) : e.note === filterNote)));
  const grouped = groupEarningsByWeek(all);
  const match = grouped.find(g => g.year === year && g.weekNumber === week);
  if (!match) {
    return res.status(404).send('Statement not found');
  }
  const items = match.earnings
    .slice()
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map(e => {
      const v = normalizeAmounts(e);
      return {
        ...e,
        gross_inr: v.gross,
        tds_inr: v.tds,
        admin_charge_inr: v.admin,
        net_inr: v.net
      };
    });
  const totals = summarizeEarnings(match.earnings);
  res.render('earning_statement', {
    user,
    year,
    weekNumber: week,
    dateRange: match.dateRange,
    type: filterNote || 'All',
    items,
    totals,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.post('/profile', requireAuth('user'), (req, res) => {
  const uploadProfileAndNominee = multer({
    storage: createCompressedStorage({
      destination: (req, file, cb) => {
        const uid = req.session.user.id;
        const dir = path.join(UPLOAD_ROOT_DIR, 'users', String(uid));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, file.fieldname + '_' + Date.now() + ext);
      },
      quality: 92,
      maxWidth: 1000,
      maxHeight: 1000,
      autoRotate: true
    }),
    fileFilter: (req, file, cb) => { cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')); },
    limits: { fileSize: 10 * 1024 * 1024 }
  });
  
  uploadProfileAndNominee.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'nominee_doc', maxCount: 1 }
  ])(req, res, (err) => {
    const user = getUserById(req.session.user.id);
    const isKYCApproved = (user.kyc_status || '').toLowerCase() === 'verified';
    if (err) {
      const products = (db.products || []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, bv: p.bv || 0 }));
      const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
      return res.render('profile', { user, saved: null, error: (err && err.message) ? err.message : 'Failed to upload image', products, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
    }
    try {
    user.member_name = (req.body.member_name || '').trim() || user.member_name || null;
    const gRaw = String(req.body.gender || '').trim().toLowerCase();
    if (['male','female','other'].includes(gRaw)) user.gender = gRaw;
    user.dob = (req.body.dob || '').trim() || null;
    user.address_line1 = (req.body.address_line1 || '').trim() || null;
    user.address_line2 = (req.body.address_line2 || '').trim() || null;
    user.city = (req.body.city || '').trim() || null;
    user.state = (req.body.state || '').trim() || null;
    user.pincode = (req.body.pincode || '').trim() || null;
    user.address = (req.body.address || '').trim() || null;
    user.state = (req.body.state || '').trim() || null;
    user.upi_id = (req.body.upi_id || '').trim() || null;
    user.emergency_phone = (req.body.emergency_phone || '').trim() || null;
    
    // Only allow email, phone, and nominee change if KYC is NOT approved
    // Bank details and KYC docs are managed via /kyc route only
    if (!isKYCApproved) {
      user.phone = (req.body.phone || '').trim() || null;
      user.email = (req.body.email || '').trim() || null;
      user.nominee_name = (req.body.nominee_name || '').trim() || null;
      user.nominee_relation = (req.body.nominee_relation || '').trim() || null;
      user.nominee_dob = (req.body.nominee_dob || '').trim() || null;
      user.nominee_mobile = (req.body.nominee_mobile || '').trim() || null;
      user.nominee_aadhar = (req.body.nominee_aadhar || '').trim() || null;
      if (req.files && req.files.nominee_doc && req.files.nominee_doc[0]) {
        const relBase = path.join('uploads', 'users', String(user.id));
        user.nominee_doc_url = '/' + path.join(relBase, req.files.nominee_doc[0].filename).replace(/\\/g, '/');
      }
    }
    if (req.files && req.files.profile_image && req.files.profile_image[0]) {
      const relBase = path.join('uploads', 'users', String(user.id));
      user.profile_image_url = '/' + path.join(relBase, req.files.profile_image[0].filename).replace(/\\/g, '/');
    }
    saveDB(db);
      const products = (db.products || []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, bv: p.bv || 0 }));
      const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
      res.render('profile', { user, saved: 'Profile updated', error: null, products, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
    } catch (e) {
      const products = (db.products || []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, bv: p.bv || 0 }));
      const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
      res.render('profile', { user, saved: null, error: 'Failed to save profile', products, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
    }
  });
});

app.get('/kyc', requireAuth('user'), (req, res) => {
  const user = getUserById(req.session.user.id);
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  res.render('kyc', { user, saved: null, error: null, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
});

app.post(
  '/kyc',
  requireAuth('user'),
  upload.fields([
    { name: 'pan_file', maxCount: 1 },
    { name: 'aadhaar_front', maxCount: 1 },
    { name: 'aadhaar_back', maxCount: 1 },
    { name: 'bank_passbook', maxCount: 1 },
    { name: 'selfie', maxCount: 1 }
  ]),
  (req, res) => {
    const user = getUserById(req.session.user.id);
    const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
    
    // Prevent updates if KYC is already verified
    if ((user.kyc_status || '').toLowerCase() === 'verified') {
      return res.render('kyc', { user, saved: null, error: 'KYC is already approved by admin. You cannot make changes.', sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
    }
    
    try {
      let updated = false;
      const relBase = path.join('/uploads', 'kyc', String(user.id));
      if (req.files && req.files.pan_file && req.files.pan_file[0]) {
        user.kyc_pan_file = path.join(relBase, req.files.pan_file[0].filename).replace(/\\/g, '/');
        updated = true;
      }
      if (req.files && req.files.aadhaar_front && req.files.aadhaar_front[0]) {
        user.kyc_aadhaar_front_file = path.join(relBase, req.files.aadhaar_front[0].filename).replace(/\\/g, '/');
        updated = true;
      }
      if (req.files && req.files.aadhaar_back && req.files.aadhaar_back[0]) {
        user.kyc_aadhaar_back_file = path.join(relBase, req.files.aadhaar_back[0].filename).replace(/\\/g, '/');
        updated = true;
      }
      if (req.files && req.files.bank_passbook && req.files.bank_passbook[0]) {
        user.kyc_bank_passbook_file = path.join(relBase, req.files.bank_passbook[0].filename).replace(/\\/g, '/');
        updated = true;
      }
      if (req.files && req.files.selfie && req.files.selfie[0]) {
        user.kyc_selfie_file = path.join(relBase, req.files.selfie[0].filename).replace(/\\/g, '/');
        updated = true;
      }
      
      // Save bank details and KYC numbers
      if (req.body.bank_account_name) { user.bank_account_name = req.body.bank_account_name.trim().toUpperCase(); updated = true; }
      if (req.body.bank_account_number) { user.bank_account_number = req.body.bank_account_number.trim(); updated = true; }
      if (req.body.bank_name) { user.bank_name = req.body.bank_name.trim().toUpperCase(); updated = true; }
      if (req.body.bank_ifsc) { user.bank_ifsc = req.body.bank_ifsc.trim().toUpperCase(); updated = true; }
      if (req.body.bank_branch) { user.bank_branch = req.body.bank_branch.trim().toUpperCase(); updated = true; }
      if (req.body.aadhar_number) { 
        user.aadhar_number = req.body.aadhar_number.trim().toUpperCase(); 
        user.kyc_aadhaar = req.body.aadhar_number.trim().toUpperCase();  // Also save for admin
        updated = true; 
      }
      if (req.body.pan_number) { 
        user.pan_number = req.body.pan_number.trim().toUpperCase(); 
        user.kyc_pan = req.body.pan_number.trim().toUpperCase();  // Also save for admin
        updated = true; 
      }
      
      if (updated) user.kyc_status = 'submitted';
      saveDB(db);
      res.render('kyc', { user, saved: updated ? 'KYC documents uploaded' : 'Nothing uploaded', error: null, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
    } catch (e) {
      res.render('kyc', { user, saved: null, error: 'Upload failed', sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
    }
  }
);

app.get('/products', requireAuth('user'), (req, res) => {
  const user = getUserById(req.session.user.id);
  const fromRepurchase = req.query.from === 'repurchase';
  if (fromRepurchase) {
    req.session.inRepurchaseMode = true;
  }
  const inRepurchaseMode = fromRepurchase || req.session.inRepurchaseMode;
  const products = (db.products || [])
    .filter(p => p.active)
    .map(p => ({
      id: p.id,
      name: p.name,
      pv: p.bv || 0,
      price_inr: p.selling_price_inr || p.mrp_inr || 0,
      dp_inr: p.selling_price_inr || 0,
      mrp_inr: p.mrp_inr || 0,
      tag: p.category || '',
      image_url: p.image1_url || null
    }));
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  res.render('products', {
    user,
    products,
    cartItems: req.session.cart || [],
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    fromRepurchase: inRepurchaseMode
  });
});

app.get('/products/:id', (req, res) => {
  const userId = req.session && req.session.user ? req.session.user.id : null;
  const user = userId ? getUserById(userId) : null;
  const productId = parseInt(req.params.id);
  const product = db.products.find(p => p.id === productId && p.active);

  if (!product) {
    return res.status(404).render('error', {
      user,
      message: 'Product not found or inactive',
      back: '/products'
    });
  }

  const sponsor = user && user.sponsor_id ? getUserById(user.sponsor_id) : null;
  res.render('product_detail', {
    user,
    product: {
      id: product.id,
      name: product.name,
      description: product.details || product.description || '',
      pv: product.bv || 0,
      price_inr: product.selling_price_inr || product.mrp_inr || 0,
      tag: product.category || '',
      image_url: product.image1_url || null,
      images: product.image2_url ? [product.image1_url, product.image2_url].filter(Boolean) : [product.image1_url].filter(Boolean)
    },
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    error: null,
    success: null
  });
});

// API: Get related products
app.get('/api/products/related/:id', (req, res) => {
   const productId = parseInt(req.params.id);
   const product = db.products.find(p => p.id === productId && p.active);
   if (!product) {
     return res.status(404).json({ error: 'Product not found' });
   }
   // Find products with same category
   const relatedProducts = (db.products || [])
     .filter(p => p.active && p.id !== productId && p.category === product.category)
     .slice(0, 4);
    res.json(relatedProducts);
 });

// ============================================
// CART SYSTEM
// ============================================

// Add to Cart
app.post('/cart/add', requireAuth('user'), (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);
    const product = (db.products || []).find(p => p.id === parseInt(product_id) && p.active);
    
    if (!product) {
      return res.json({ ok: false, error: 'Product not found' });
    }
    
    if (!req.session.cart) {
      req.session.cart = [];
    }
    
    // Check if product already in cart
    const existingIndex = req.session.cart.findIndex(item => item.product_id === product.id);
    
    if (existingIndex >= 0) {
      // Update quantity
      req.session.cart[existingIndex].quantity += qty;
    } else {
      // Add new item
      req.session.cart.push({
        product_id: product.id,
        quantity: qty,
        name: product.name,
        price: product.selling_price_inr || product.mrp_inr || 0,
        bv: product.bv || 0,
        image_url: product.image_url || null,
        added_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
    }
    
    const cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
    res.json({ ok: true, message: 'Added to cart', cart_count: cartCount });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Get Cart Items
app.get('/cart', requireAuth('user'), (req, res) => {
  const cart = req.session.cart || [];
  const enrichedCart = cart.map(item => {
    const product = (db.products || []).find(p => p.id === item.product_id);
    return {
      ...item,
      name: product ? product.name : item.name,
      price: product ? (product.selling_price_inr || product.mrp_inr || 0) : item.price,
      bv: product ? (product.bv || 0) : item.bv,
      image_url: product ? (product.image_url || null) : item.image_url,
      stock: product ? (product.total_stock || 0) : 0,
      available: product ? !!product.active : false
    };
  });
  
  const totalAmount = enrichedCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const totalBV = enrichedCart.reduce((sum, item) => sum + (item.bv * item.quantity), 0);
  const totalItems = enrichedCart.reduce((sum, item) => sum + item.quantity, 0);
  
  res.render('user_cart', {
    cart: enrichedCart,
    totalAmount,
    totalBV,
    totalItems,
    user: getUserById(req.session.user.id),
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    error: null,
    success: null
  });
});

// Update Cart Item Quantity
app.post('/cart/update', requireAuth('user'), (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    const qty = parseInt(quantity) || 0;
    const pid = parseInt(product_id);
    
    if (!req.session.cart) {
      return res.json({ ok: false, error: 'Cart is empty' });
    }
    
    const index = req.session.cart.findIndex(item => item.product_id === pid);
    
    if (index < 0) {
      return res.json({ ok: false, error: 'Product not in cart' });
    }
    
    if (qty <= 0) {
      // Remove item
      req.session.cart.splice(index, 1);
    } else {
      req.session.cart[index].quantity = qty;
    }
    
    const cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
    res.json({ ok: true, cart_count: cartCount });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Remove from Cart
app.post('/cart/remove', requireAuth('user'), (req, res) => {
  try {
    const { product_id } = req.body;
    const pid = parseInt(product_id);
    
    if (!req.session.cart) {
      return res.json({ ok: true, cart_count: 0 });
    }
    
    req.session.cart = req.session.cart.filter(item => item.product_id !== pid);
    
    const cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
    res.json({ ok: true, cart_count: cartCount });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Clear Cart
app.post('/cart/clear', requireAuth('user'), (req, res) => {
  req.session.cart = [];
  res.json({ ok: true });
});

// Cart Count API
app.get('/cart/count', requireAuth('user'), (req, res) => {
  const cart = req.session.cart || [];
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  res.json({ count: cartCount });
});

// Checkout - Create order from cart
app.get('/cart/checkout', requireAuth('user'), (req, res) => {
  const cart = req.session.cart || [];
  
  if (cart.length === 0) {
    return res.redirect('/cart?error=Your%20cart%20is%20empty');
  }
  
  // Calculate totals
  let totalBV = 0;
  let totalAmount = 0;
  const enrichedCart = cart.map(item => {
    const product = (db.products || []).find(p => p.id === item.product_id);
    const price = product ? (product.selling_price_inr || product.mrp_inr || 0) : item.price;
    const bv = product ? (product.bv || 0) : item.bv;
    totalBV += bv * item.quantity;
    totalAmount += price * item.quantity;
    return { ...item, price, bv, name: product ? product.name : item.name };
  });
  
  const settings = db.settings || {};
  const order_no = 'ORD-' + String(Date.now()).slice(-5);
  
  res.render('cart_checkout', {
    cart: enrichedCart,
    order_no,
    totalBV,
    totalAmount,
    user: getUserById(req.session.user.id),
    settings,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// Confirm cart order - creates pending order
app.post('/cart/confirm', requireAuth('user'), uploadPaymentScreenshot.single('payment_screenshot'), (req, res) => {
  try {
    const cart = req.session.cart || [];
    
    if (cart.length === 0) {
      return res.redirect('/cart?error=Cart%20is%20empty');
    }
    
    const settings = db.settings || {};
    if (settings.user_purchase_disabled) {
      return res.redirect('/products?error=Purchases%20are%20currently%20disabled');
    }
    
    const user = getUserById(req.session.user.id);
    if (!user) {
      return res.redirect('/login');
    }
    
    const payment_method = req.body.payment_method || 'unknown';
    const transaction_id = req.body.transaction_id || '';
    const upi_app = req.body.upi_app || '';
    const bank_name = req.body.bank_name || '';
    const card_last4 = req.body.card_last4 || '';
    const card_type = req.body.card_type || '';
    const screenshot_url = req.file ? '/uploads/payment_screenshots/' + req.file.filename : '';
    
    // Calculate totals from cart
    let totalBV = 0;
    let totalAmount = 0;
    cart.forEach(item => {
      const product = (db.products || []).find(p => p.id === item.product_id);
      if (product) {
        const price = product.selling_price_inr || product.mrp_inr || 0;
        const bv = product.bv || 0;
        totalBV += bv * item.quantity;
        totalAmount += price * item.quantity;
      }
    });
    
    const now = DateTime.now().setZone('Asia/Kolkata').toISO();
    
    // Create order
    if (!db.counters.order) db.counters.order = 0;
    const orderId = (++db.counters.order);
    const order_no = 'ORD-' + String(orderId).padStart(5, '0');
    
    // Store cart items in order
    const orderItems = cart.map(item => {
      const product = (db.products || []).find(p => p.id === item.product_id);
      return {
        product_id: item.product_id,
        product_name: product ? product.name : 'Unknown',
        quantity: item.quantity,
        price: product ? (product.selling_price_inr || product.mrp_inr || 0) : item.price,
        bv: product ? (product.bv || 0) : item.bv
      };
    });
    
    db.orders.push({
      id: orderId,
      order_no,
      type: 'repurchase',
      user_id: user.id,
      franchise_id: null,
      items: orderItems,
      total_bv: totalBV,
      total_inr: totalAmount,
      payment_status: 'pending',
      payment_method,
      transaction_id,
      upi_app,
      bank_name,
      card_last4,
      card_type,
      screenshot_url,
      is_cart_order: true,
      created_at: now,
      invoice_created: false
    });
    
    // Clear cart
    req.session.cart = [];
    
    saveDB(db);
    res.redirect('/user/orders?success=Cart%20order%20placed!%20Order%20' + order_no + '%20is%20pending%20for%20approval');
  } catch (e) {
    res.redirect('/cart?error=' + encodeURIComponent('Failed: ' + e.message));
  }
});

// API endpoint for customer lookup by reference
app.get('/api/customer', (req, res) => {
   const { name } = req.query;
   if (!name) {
     return res.status(400).json({ error: 'Name parameter is required' });
   }
   
   const user = getUserByRef(name.trim());
   if (user) {
     res.json({
       name: user.member_name || user.username,
       user_code: user.user_code || null,
       status: user.status || 'inactive'
     });
   } else {
     res.status(404).json({ error: 'Customer not found' });
   }
 });

// API: User lookup for franchise PIN activation
app.get('/api/user-lookup', (req, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!ref) return res.json({ ok: false });
  const user = getUserByRef(ref);
  if (!user) return res.json({ ok: false });
  res.json({
    ok: true,
    id: user.id,
    username: user.username,
    user_code: user.user_code || null,
    member_name: user.member_name || null,
    active: !!(user.active || user.status === 'active')
  });
});

// API: Franchise PIN lookup - show PIN details
app.get('/api/franchise-pin-lookup', requireAuth('franchise'), (req, res) => {
  const pin = String(req.query.pin || '').trim().toUpperCase();
  if (!pin) return res.json({ ok: false, error: 'Enter PIN' });
  const franchiseId = req.session.user.franchise_id;
  const rec = (db.pin_packages || []).find(p => p.code === pin && p.assigned_to === franchiseId && p.assigned_to_franchise);
  if (!rec) return res.json({ ok: false, error: 'PIN not found or not assigned to you' });
  
  let productName = 'Unknown';
  let planName = '';
  let bv = 0;
  let price = 0;
  if (rec.plan_id) {
    const plan = (db.plans || []).find(pl => pl.id === rec.plan_id);
    if (plan) {
      planName = plan.name;
      price = plan.amount_inr || 0;
      const ids = Array.isArray(rec.product_ids) ? rec.product_ids : (plan.product_id ? [plan.product_id] : []);
      const prodNames = [];
      ids.forEach(pid => { const pd = (db.products || []).find(p => p.id === pid); if (pd) { prodNames.push(pd.name); bv += (pd.bv || 0); } });
      productName = planName + ' (' + prodNames.join(' + ') + ')';
    }
  } else if (rec.product_id) {
    const product = (db.products || []).find(p => p.id === rec.product_id);
    if (product) {
      productName = product.name;
      bv = product.bv || 0;
      price = product.selling_price_inr || product.mrp_inr || 0;
    }
  }
  
  const used = !!rec.used_by;
  let usedBy = null;
  if (used) {
    const user = getUserById(rec.used_by);
    if (user) usedBy = (user.user_code || user.username) + (user.member_name ? ' (' + user.member_name + ')' : '');
  }
  
  res.json({
    ok: true,
    product_name: productName,
    plan_name: planName,
    bv,
    price,
    used,
    used_by: usedBy,
    available: !used && !rec.disabled && rec.status !== 'expired',
    login_pin: rec.login_pin || ''
  });
});

// API: Verify Login PIN
app.get('/api/verify-login-pin', requireAuth('franchise'), (req, res) => {
  const pin = String(req.query.pin || '').trim().toUpperCase();
  const loginPin = String(req.query.login_pin || '').trim();
  if (!pin || !loginPin) return res.json({ ok: false });
  const franchiseId = req.session.user.franchise_id;
  const rec = (db.pin_packages || []).find(p => p.code === pin && p.assigned_to === franchiseId && p.assigned_to_franchise);
  if (!rec) return res.json({ ok: false, match: false });
  res.json({ ok: true, match: String(rec.login_pin) === loginPin });
});

// API: Add to wishlist
app.post('/api/wishlist/add', requireAuth('user'), (req, res) => {
  try {
    const { product_id } = req.body;
    const userId = req.session.user.id;
    
    if (!product_id) {
      return res.status(400).json({ success: false, error: 'Product ID required' });
    }

    // Check if product exists
    const product = db.products.find(p => p.id === product_id && p.active);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    // Initialize wishlist if not exists
    if (!db.wishlists) {
      db.wishlists = [];
    }

    // Check if already in wishlist
    const existing = db.wishlists.find(w => w.user_id === userId && w.product_id === product_id);
    if (existing) {
      return res.json({ success: true, message: 'Already in wishlist' });
    }

    // Add to wishlist
    db.wishlists.push({
      id: Date.now(),
      user_id: userId,
      product_id: product_id,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    });

    res.json({ success: true, message: 'Added to wishlist' });
  } catch (error) {
    console.error('Wishlist error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/user/send-pin', requireAuth('user'), (req, res) => {
  try {
    const target_ref = String(req.body.target_user || '').trim();
    const product_id = parseInt(req.body.product_id || '0');
    const target = getUserByRef(target_ref);
    if (!target) return res.status(400).json({ ok: false, error: 'Target user not found' });
    const product = db.products.find(p => p.id === product_id && p.active);
    if (!product) return res.status(400).json({ ok: false, error: 'Invalid product' });
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    let code = null;
    do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
    const login_pin = String(Math.floor(100000 + Math.random() * 900000));
    const rec = {
      id: nextId('pin_package'),
      code,
      login_pin,
      product_id,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      assigned_to: target.id,
      assigned_by: req.session.user.id,
      used_by: null,
      used_at: null,
      status: 'assigned'
    };
    db.pin_packages.push(rec);
    saveDB(db);
    return res.json({ ok: true, package_pin: rec.code, login_pin: rec.login_pin, product: { id: product.id, name: product.name, bv: product.bv }, assigned_to: target.user_code || target.username });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to create activation pin' });
  }
});

app.post('/user/self-activate', requireAuth('user'), (req, res) => {
  try {
    const user = getUserById(req.session.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    if (String(user.status || 'inactive').toLowerCase() === 'active') return res.status(400).json({ ok: false, error: 'Already active' });
    const pkg = String(req.body.package_pin || '').trim();
    const lp = String(req.body.login_pin || '').trim();
    // Use stored leader_ref from registration, fallback to request body
    const leader_ref = user.leader_ref || String(req.body.leader_ref || '').trim();
    if (!pkg || !lp) return res.status(400).json({ ok: false, error: 'Package PIN and Login PIN required' });
    let p = (db.pin_packages || []).find(x => x.code === pkg && String(x.login_pin || '') === lp) || null;
    if (!p) return res.status(404).json({ ok: false, error: 'PIN not found' });
    if (p.used_by || p.disabled || p.status === 'expired') return res.status(400).json({ ok: false, error: 'PIN not active' });
    
    // SAVE ORIGINAL STATE FOR ROLLBACK
    const origPinState = { used_by: p.used_by, used_at: p.used_at, status: p.status };
    const origUserState = { pv: user.pv, status: user.status, active: user.active, activated_at: user.activated_at };
    const origEarningsCount = (db.earnings || []).length;
    
    p.used_by = user.id;
    p.used_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    p.status = 'used';
    let items = [];
    let total = 0;
    let pvSum = 0;
    if (p.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
      const ids = Array.isArray(p.product_ids) ? p.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
      const prodList = ids.map(id => (db.products || []).find(pr => pr.id === id)).filter(Boolean);
      const planTotal = parseFloat((plan && plan.amount_inr) || 0) || 0;
      total = planTotal;
      const n = prodList.length || 1;
      let accum = 0;
      prodList.forEach((pr, idx) => {
        pvSum += (pr.bv || 0);
        const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
        accum += share;
        items.push({
          product_id: pr.id,
          product_name: pr.name,
          quantity: 1,
          line_total_inr: share
        });
      });
      // Activation now happens automatically via creditPV when BV threshold is reached
    } else {
      const product = (db.products || []).find(pr => pr.id === p.product_id) || null;
      if (!product) return res.status(400).json({ ok: false, error: 'Product not found for PIN' });
      pvSum += (product.bv || 0);
      total = (product.selling_price_inr || product.mrp_inr || 0);
      items.push({
        product_id: product.id,
        product_name: product.name,
        quantity: 1,
        line_total_inr: total
      });
      // Activation now happens automatically via creditPV when BV threshold is reached
     }
      // Deduct stock for all products (from global inventory for user self-activation) -- skip for matrix pins
      if (!p.is_matrix_pin && p.plan_id) {
          const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
          const ids = Array.isArray(p.product_ids) ? p.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
          const prodList = ids.map(id => (db.products || []).find(pr => pr.id === id)).filter(Boolean);
          for (const prod of prodList) {
              if ((prod.total_stock || 0) <= 0) {
                  throw new Error(`Out of stock: ${prod.name || 'Product'}`);
              }
              prod.total_stock = (prod.total_stock || 0) - 1;
              prod.sold_stock = (prod.sold_stock || 0) + 1;
              prod.updated_at = now;
          }
      } else if (!p.is_matrix_pin && p.product_id) {
          const prod = (db.products || []).find(pr => pr.id === p.product_id);
          if (prod) {
              if ((prod.total_stock || 0) <= 0) {
                  throw new Error(`Out of stock: ${prod.name || 'Product'}`);
              }
              prod.total_stock = (prod.total_stock || 0) - 1;
              prod.sold_stock = (prod.sold_stock || 0) + 1;
              prod.updated_at = now;
          }
      }
      
      // Handle matrix PIN activation (create auto users under target)
      if (p.is_matrix_pin) {
          user.is_matrix_target = true;
          const leftCount = p.left_count || 10;
          const rightCount = p.right_count || 10;
          const plan = p.plan_id ? (db.plans || []).find(pl => pl.id === p.plan_id) : null;
          const bvPerUser = plan ? (plan.pv || 500) : 500;
          const findSubtreeSpot = (rootId) => {
              if (!rootId) return null;
              const q = [rootId];
              while (q.length) {
                  const id = q.shift();
                  const u = getUserById(id);
                  if (!u) continue;
                  if (!u.left_id) return { parent: u, side: 'left' };
                  if (!u.right_id) return { parent: u, side: 'right' };
                  q.push(u.left_id);
                  q.push(u.right_id);
              }
              return null;
          };
          for (let i = 1; i <= leftCount; i++) {
              if (i === 1) {
                  createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: user.sponsor_id || user.id, parentId: user.id, side: 'left', memberName: 'Matrix L' + i, planId: p.plan_id, bv: bvPerUser });
              } else {
                  const lChildId = getUserById(user.id).left_id;
                  const spot = lChildId ? findSubtreeSpot(lChildId) : null;
                  if (!spot) break;
                  createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: user.sponsor_id || user.id, parentId: spot.parent.id, side: spot.side, memberName: 'Matrix L' + i, planId: p.plan_id, bv: bvPerUser });
              }
          }
          for (let i = 1; i <= rightCount; i++) {
              if (i === 1) {
                  createAutoUser({ username: 'MTX' + String(Date.now() + i + 100).slice(-6) + 'R' + i, sponsorId: user.sponsor_id || user.id, parentId: user.id, side: 'right', memberName: 'Matrix R' + i, planId: p.plan_id, bv: bvPerUser });
              } else {
                  const rChildId = getUserById(user.id).right_id;
                  const spot = rChildId ? findSubtreeSpot(rChildId) : null;
                  if (!spot) break;
                  createAutoUser({ username: 'MTX' + String(Date.now() + i + 100).slice(-6) + 'R' + i, sponsorId: user.sponsor_id || user.id, parentId: spot.parent.id, side: spot.side, memberName: 'Matrix R' + i, planId: p.plan_id, bv: bvPerUser });
              }
          }
          // Set target user pv = 0 (matrix target does not get raw PV)
          user.pv = 0;
          // Activate user directly for matrix PIN (no BV threshold needed)
          user.status = 'active';
          user.active = true;
          if (!user.activated_at) user.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
      }
      
      if (pvSum > 0 && !p.is_matrix_pin) creditPV(user.id, pvSum, 'activation');
     // Credit pending leadership bonus during activation
    // Find the pending leadership bonus entry created during registration
    let pendingLB = (db.earnings || []).find(e => 
      e.source_user_id === user.id && 
      e.pending_leadership === true || e.pending_leadership === 1 && 
      e.status === 'pending'
    );
    
    // If no pending LB exists, create one if user has leader_ref
    if (!pendingLB && user.leader_ref) {
      const existingLB = (db.earnings || []).find(e => e.source_user_id === user.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
      if (!existingLB) {
        const leader = getUserByRef(user.leader_ref);
        if (leader) {
          const lbPlan = p.plan_id ? ((db.plans || []).find(pl => pl.id === p.plan_id) || null) : null;
          const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
          const defaultPlan = allPlans[0] || null;
          const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
          (db.earnings || (db.earnings = [])).push({
            id: nextId('earning'),
            user_id: leader.id,
            amount_inr: 0,
            gross_inr: lbAmount,
            tds_inr: 0,
            admin_charge_inr: 0,
            net_inr: 0,
            pending_leadership: true,
            note: 'Leadership bonus (Pending)',
            source_user_id: user.id,
            source_user_code: user.user_code || user.username,
            source_pin_code: p.code || null,
            plan_id: lbPlan ? lbPlan.id : null,
            activation_bv: pvSum,
            status: 'pending',
            created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
          });
          pendingLB = (db.earnings || []).find(e => e.source_user_id === user.id && e.pending_leadership === true || e.pending_leadership === 1 && e.status === 'pending');
        }
      }
    }
    
    if (pendingLB) {
      const lbPlan = p.plan_id ? ((db.plans || []).find(pl => pl.id === p.plan_id) || null) : null;
      const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
      const defaultPlan = allPlans[0] || null;
      let lbAmount = lbPlan ? (parseFloat(lbPlan.leadership_bonus_inr || '0') || 0) : 0;
      if (!lbAmount) lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
      const planMinBV = lbPlan ? (parseFloat(lbPlan.min_bv_for_leadership || '0') || 0) : 0;
      if (lbAmount > 0 && pvSum >= planMinBV) {
        pendingLB.gross_inr = lbAmount;
        pendingLB.plan_id = lbPlan ? lbPlan.id : null;
        pendingLB.source_pin_code = p.code || null;
        pendingLB.activation_bv = pvSum;
      }
    }
    let activation = null;
    if (p.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
      const ids = Array.isArray(p.product_ids) ? p.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
      activation = { type: 'plan', name: plan ? (plan.name || ('#' + plan.id)) : 'Plan', product_ids: ids, amount_inr: total };
    } else {
      const pr = (items[0] || null);
      activation = { type: 'product', name: pr ? (pr.product_name || 'Product') : 'Product', product_id: pr ? pr.product_id : null, amount_inr: total };
    }

    // Update ranks for user and all ancestors (to check STAR WINNER)
    updateUserRank(user.id);
    let current = user.placement_parent_id ? getUserById(user.placement_parent_id) : null;
    while (current) {
      updateUserRank(current.id);
      if (!current.placement_parent_id) break;
      current = getUserById(current.placement_parent_id);
    }

    // Generate invoice automatically after activation
    const invoice = generateInvoiceForPin(p);

    // FINAL SAVE - All changes committed together
    saveDB(db);
    return res.json({ ok: true, activation, invoice });
  } catch (e) {
    // ROLLBACK - Restore original state on error
    try {
      const user = getUserById(req.session.user.id);
      const pkg = String(req.body.package_pin || '').trim();
      const p = (db.pin_packages || []).find(x => x.code === pkg) || null;
      if (p && p.used_by === user?.id) {
        p.used_by = null;
        p.used_at = null;
        p.status = 'unused';
      }
      if (user) {
        user.pv = origUserState?.pv ?? user.pv;
        user.status = origUserState?.status ?? user.status;
        user.active = origUserState?.active ?? user.active;
        user.activated_at = origUserState?.activated_at ?? user.activated_at;
      }
      // Remove any new earnings added during failed activation
      if (db.earnings && origEarningsCount !== undefined) {
        db.earnings.length = origEarningsCount;
      }
    } catch (_) {}
    return res.status(500).json({ ok: false, error: 'Activation failed' });
  }
});

app.post('/user/self-activate/preview', requireAuth('user'), (req, res) => {
  try {
    const user = getUserById(req.session.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    const pkg = String(req.body.package_pin || '').trim();
    const lp = String(req.body.login_pin || '').trim();
    if (!pkg || !lp) return res.status(400).json({ ok: false, error: 'Package PIN and Login PIN required' });
    let p = (db.pin_packages || []).find(x => x.code === pkg && String(x.login_pin || '') === lp) || null;
    if (!p) return res.status(404).json({ ok: false, error: 'PIN not found' });
    if (p.used_by || p.disabled || p.status === 'expired') return res.status(400).json({ ok: false, error: 'PIN not active' });
    let items = [];
    let total = 0;
    if (p.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
      const ids = Array.isArray(p.product_ids) ? p.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
      const prodList = ids.map(id => (db.products || []).find(pr => pr.id === id)).filter(Boolean);
      const planTotal = parseFloat((plan && plan.amount_inr) || 0) || 0;
      total = planTotal;
      const n = prodList.length || 1;
      let accum = 0;
      prodList.forEach((pr, idx) => {
        const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
        accum += share;
        items.push({
          product_id: pr.id,
          product_name: pr.name,
          quantity: 1,
          line_total_inr: share
        });
      });
      const activation = { type: 'plan', name: plan ? (plan.name || ('#' + plan.id)) : 'Plan', product_ids: ids, amount_inr: total, items, is_matrix_pin: !!p.is_matrix_pin };
      return res.json({ ok: true, activation });
    } else {
      const product = (db.products || []).find(pr => pr.id === p.product_id) || null;
      if (!product) return res.status(400).json({ ok: false, error: 'Product not found for PIN' });
      total = (product.selling_price_inr || product.mrp_inr || 0);
      items.push({
        product_id: product.id,
        product_name: product.name,
        quantity: 1,
        line_total_inr: total
      });
      const activation = { type: 'product', name: product.name, product_id: product.id, amount_inr: total, items };
      return res.json({ ok: true, activation });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Preview failed' });
  }
});
app.get('/admin', requireAuth('admin'), (req, res) => {
  try {
    const s = getSettingsRow();
    const usersCount = (db.users || []).filter(u => u.role === 'user').length;
    const payouts = db.payouts || [];
    const totalPaid = payouts.reduce((sum, e) => sum + Number(e.amount_inr || 0), 0);
    const totalTDS = payouts.reduce((sum, e) => sum + Number(e.tds_inr || 0), 0);
    const totalAdminCharge = payouts.reduce((sum, e) => sum + Number(e.admin_charge_inr || 0), 0);
    
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;

    // Charts data
    const today = DateTime.now().setZone('Asia/Kolkata');
    const userRegistrations = [];
    for (let i = 6; i >= 0; i--) {
      const date = today.minus({ days: i });
      const dateStr = date.toFormat('yyyy-MM-dd');
      const count = (db.users || []).filter(u => u.role === 'user' && u.created_at && u.created_at.startsWith(dateStr)).length;
      userRegistrations.push({
        date: date.toFormat('MMM dd'),
        count
      });
    }

    const earningsTrend = [];
    for (let i = 6; i >= 0; i--) {
      const date = today.minus({ days: i });
      const dateStr = date.toFormat('yyyy-MM-dd');
      const total = (db.earnings || []).filter(e => e.created_at && e.created_at.startsWith(dateStr)).reduce((sum, e) => sum + (e.amount_inr || 0), 0);
      earningsTrend.push({
        date: date.toFormat('MMM dd'),
        amount: total
      });
    }

    const topEarners = (db.users || [])
      .filter(u => u.role === 'user')
      .map(u => ({
        username: u.username,
        total_earnings: (db.earnings || []).filter(e => e.user_id === u.id).reduce((sum, e) => sum + (e.amount_inr || 0), 0)
      }))
      .sort((a, b) => b.total_earnings - a.total_earnings)
      .slice(0, 10);

    const payoutByRank = {};
    (db.users || []).filter(u => u.role === 'user' && u.rank_name).forEach(u => {
      const total = (db.earnings || []).filter(e => e.user_id === u.id).reduce((sum, e) => sum + (e.amount_inr || 0), 0);
      payoutByRank[u.rank_name] = (payoutByRank[u.rank_name] || 0) + total;
    });
    const payoutByRankArray = Object.entries(payoutByRank).map(([rank_name, total]) => ({ rank_name, total })).sort((a, b) => b.total - a.total);

    // Get low stock products (total_stock <= 10)
    const lowStockProducts = (db.products || [])
      .filter(p => p.active !== false && (p.total_stock || 0) <= 10)
      .map(p => ({ id: p.id, name: p.name, total_stock: p.total_stock || 0, code: p.code || '' }))
      .sort((a, b) => a.total_stock - b.total_stock);
    
    const pendingOrdersCount = (db.orders || []).filter(o => o.status === 'pending' || o.status === 'processing').length;
    const pendingKycCount = (db.users || []).filter(u => u.role === 'user' && (u.kyc_status || '').toLowerCase() === 'submitted').length;

    res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS, totalAdminCharge },
      pendingOrdersCount,
      pendingKycCount,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: null,
      success: null,
      error: null,
      lowStockProducts,
      products: (db.products || []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, bv: p.bv })),
      plans: (db.plans || []).filter(pl => pl.active).map(pl => {
        const ids = Array.isArray(pl.product_ids) ? pl.product_ids.slice() : (pl.product_id ? [pl.product_id] : []);
        const prods = ids.map(id => {
          const pd = (db.products || []).find(p => p.id === id);
          return pd ? { id: pd.id, name: pd.name, bv: pd.bv || 0 } : { id, name: '#' + id, bv: 0 };
        });
        const first = prods[0] || null;
        return {
          id: pl.id,
          name: pl.name,
          product_id: first ? first.id : null,
          product_name: first ? first.name : null,
          product_bv: first ? (first.bv || 0) : 0,
          product_ids: ids,
          products: prods,
          leadership_bonus_inr: pl.leadership_bonus_inr || 0
        };
      }),
      pin_packages: (db.pin_packages || []).slice(-10).reverse().map(x => {
        if (x.plan_id) {
          const plan = (db.plans || []).find(pl => pl.id === x.plan_id);
          const ids = Array.isArray(x.product_ids) ? x.product_ids.slice() : (plan && plan.product_id ? [plan.product_id] : []);
          const bvSum = ids.reduce((s, id) => {
            const pd = (db.products || []).find(p => p.id === id);
            return s + (pd ? (pd.bv || 0) : 0);
          }, 0);
          return {
            code: x.code,
            product_name: 'Combo Plan',
            bv: bvSum,
            status: x.status || (x.used_by ? 'used' : 'new'),
            created_at: x.created_at,
            used_at: x.used_at || null
          };
        } else {
          const prod = (db.products || []).find(p => p.id === x.product_id);
          return {
            code: x.code,
            product_name: prod ? prod.name : 'Combo Plan',
            bv: prod ? (prod.bv || 0) : 0,
            status: x.status || (x.used_by ? 'used' : 'new'),
            created_at: x.created_at,
            used_at: x.used_at || null
          };
        }
      }),
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: {
        userRegistrations,
        earningsTrend,
      topEarners,
      payoutByRank: payoutByRankArray
    }
  });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).send('Error loading admin dashboard: ' + err.message);
  }
});

app.get('/admin/users', requireAuth('admin'), (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const phoneQ = String(req.query.phone || '').trim();
  const panQ = String(req.query.pan || '').trim().toLowerCase();
  const aadhaarQ = String(req.query.aadhaar || '').trim();
  const statusFilter = String(req.query.status || '').trim().toLowerCase();
  const kycFilter = String(req.query.kyc_status || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(200, Math.max(10, parseInt(req.query.per_page) || 50));
  let users = db.users.filter(u => u.role === 'user');
  if (q || phoneQ || panQ || aadhaarQ) {
    users = users.filter(u => {
      const name = String(u.member_name || '').toLowerCase();
      const uname = String(u.username || '').toLowerCase();
      const code = String(u.user_code || '').toLowerCase();
      const phone = String(u.phone || '');
      const pan = (u.kyc_pan || '').toLowerCase();
      const aadhaar = String(u.kyc_aadhaar || '');
      const okQ = q ? (name.includes(q) || uname.includes(q) || code.includes(q)) : true;
      const okPhone = phoneQ ? phone.includes(phoneQ) : true;
      const okPan = panQ ? pan.includes(panQ) : true;
      const okAadhaar = aadhaarQ ? aadhaar.includes(aadhaarQ) : true;
      return okQ && okPhone && okPan && okAadhaar;
    });
  }
  if (statusFilter === 'active') {
    users = users.filter(u => (u.status || 'active') === 'active');
  } else if (statusFilter === 'inactive') {
    users = users.filter(u => (u.status || 'active') === 'inactive');
  }
  if (kycFilter) {
    users = users.filter(u => (u.kyc_status || 'pending') === kycFilter);
  }
  const totalUsers = users.length;
  const totalPages = Math.max(1, Math.ceil(totalUsers / perPage));
  users = users.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  users = users.slice((page - 1) * perPage, page * perPage);
  const usersById = {};
  db.users.forEach(u => { usersById[u.id] = u; });
  users = users.map(u => {
    let sponsor = u.sponsor_id ? (usersById[u.sponsor_id] || null) : null;
    if (!sponsor && u.placement_parent_id) {
      sponsor = usersById[u.placement_parent_id] || null;
    }
    return {
      id: u.id,
      member_name: u.member_name || null,
      user_code: u.user_code || null,
      username: u.username || null,
      email: u.email || null,
      phone: u.phone || null,
      sponsor_id: sponsor ? (sponsor.user_code || sponsor.username) : null,
      sponsor_code: sponsor ? (sponsor.user_code || sponsor.username) : null,
      sponsor_name: sponsor ? (sponsor.member_name || null) : null,
      placement_side: u.placement_side || null,
      kyc_status: u.kyc_status || 'pending',
      kyc_pan_file: u.kyc_pan_file || null,
      kyc_aadhaar_front_file: u.kyc_aadhaar_front_file || null,
      kyc_aadhaar_back_file: u.kyc_aadhaar_back_file || null,
      kyc_bank_passbook_file: u.kyc_bank_passbook_file || null,
      kyc_selfie_file: u.kyc_selfie_file || null,
      status: u.status || 'active',
      rank_name: getDynamicRank(u),
      created_at: u.created_at,
      pv: u.pv || 0,
      carry_left: u.carry_left || 0,
      carry_right: u.carry_right || 0,
      org_bv_left: u.org_bv_left || 0,
      org_bv_right: u.org_bv_right || 0,
      plan_id: u.plan_id || null,
      activated_at: u.activated_at || null,
      leader_ref: u.leader_ref || null
    };
  });
  const success = req.query.msg || null;
  const error = req.query.err || null;
  res.render('admin_users', { users, q, phone: phoneQ, pan: panQ, aadhaar: aadhaarQ, include_inactive: false, status: statusFilter, kyc_status: kycFilter, page, perPage, totalUsers, totalPages, success, error, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.get('/admin/pages', requireAuth('admin'), (req, res) => {
  db.company_pages = db.company_pages || [];
  const defaults = [
    { slug: 'about-company', title: 'About Us' },
    { slug: 'company-account', title: 'Company Account' },
    { slug: 'careers', title: 'Careers' },
    { slug: 'shipping-policy', title: 'Shipping Policy' },
    { slug: 'returns-and-refunds', title: 'Returns & Refunds' },
    { slug: 'terms-of-service', title: 'Terms of Service' },
    { slug: 'terms-and-conditions', title: 'Terms & Conditions' },
    { slug: 'privacy-policy', title: 'Privacy Policy' },
    { slug: 'disclaimer', title: 'Disclaimer' }
  ];
  const rows = defaults.map(d => {
    const ex = db.company_pages.find(p => p.slug === d.slug);
    return {
      slug: d.slug,
      title: ex ? (ex.title || d.title) : d.title,
      updated_at: ex ? ex.updated_at || null : null
    };
  });
  res.render('admin_pages', { pages: rows, success: req.query.msg || null, error: null });
});

app.get('/admin/pages/:slug', requireAuth('admin'), (req, res) => {
  db.company_pages = db.company_pages || [];
  const slug = String(req.params.slug || '').toLowerCase();
  const mapTitle = {
    'about-company': 'About Us',
    'company-account': 'Company Account',
    'careers': 'Careers',
    'shipping-policy': 'Shipping Policy',
    'returns-and-refunds': 'Returns & Refunds',
    'refund-and-cancellation': 'Returns & Refunds',
    'terms-of-service': 'Terms of Service',
    'terms-and-conditions': 'Terms & Conditions',
    'privacy-policy': 'Privacy Policy'
  };
  const ex = db.company_pages.find(p => p.slug === slug) || null;
  const page = ex || { slug, title: mapTitle[slug] || slug, content: '' };
  res.render('admin_page_edit', { page, error: null, success: null });
});

app.post('/admin/pages/:slug', requireAuth('admin'), uploadCMS.single('business_plan_pdf'), (req, res) => {
  db.company_pages = db.company_pages || [];
  const slug = String(req.params.slug || '').toLowerCase();
  const title = String(req.body.title || '').trim() || slug;
  const content = String(req.body.content || '');
  const idx = db.company_pages.findIndex(p => p.slug === slug);
  if (idx >= 0) {
    db.company_pages[idx].title = title;
    db.company_pages[idx].content = content;
    db.company_pages[idx].updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    if (req.file) {
      db.company_pages[idx].pdf_url = '/uploads/cms/' + req.file.filename;
    }
  } else {
    const page = { slug, title, content, updated_at: DateTime.now().setZone('Asia/Kolkata').toISO() };
    if (req.file) {
      page.pdf_url = '/uploads/cms/' + req.file.filename;
    }
    db.company_pages.push(page);
  }
  saveDB(db);
  return res.redirect('/admin/pages?msg=Saved');
});

function franchiseRenderData(extra) {
  const items = (db.franchises || []).slice().sort((a,b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const products = (db.products || []).filter(p => p.active);
  const s = db.settings || {};
  const actType = s.franchise_activation_commission_type || 'amount';
  const actVal = s.franchise_activation_commission_value || 10;
  const repType = s.franchise_repurchase_commission_type || 'amount';
  const repVal = s.franchise_repurchase_commission_value || 10;
  
  // Enrich orders with franchise and product info
  const orders = (db.orders || [])
    .filter(o => o.type === 'repurchase' && o.franchise_id)
    .map(o => {
      const franchise = getFranchiseById(o.franchise_id);
      let product = (db.products || []).find(p => p.id === o.product_id);
      if (!product && o.is_cart_order && Array.isArray(o.items) && o.items.length > 0) {
        product = (db.products || []).find(p => p.id === o.items[0].product_id);
      }
      const cust = o.user_id ? getUserById(o.user_id) : null;
      return {
        ...o,
        franchise_code: franchise ? franchise.franchise_code : (o.franchise_code || '-'),
        franchise_name: franchise ? (franchise.branch_name || franchise.member_name || franchise.username) : (o.franchise_name || '-'),
        product_name: product ? product.name : (o.items && o.items[0] ? (o.items[0].product_name || 'Unknown Product') : (o.product_name || 'Unknown Product')),
        customer_code: o.customer_code || (cust ? (cust.user_code || cust.username) : '-'),
        customer_name: o.customer_name || (cust ? (cust.member_name || cust.username) : '-')
      };
    })
    .slice()
    .reverse()
    .slice(0, 50);
    
  const transactions = (db.franchise_transactions || []).slice().reverse().slice(0, 200);
  const stockHistory = (db.franchise_stock_history || []).slice().reverse().slice(0, 100);

  // Calculate per-franchise per-product stock stats (in_qty, out_qty, balance)
  const franchiseStockStats = {};
  (db.franchises || []).forEach(f => {
    const fid = f.id;
    const stats = {};
    products.forEach(p => { stats[p.id] = { in_qty: 0, out_qty: 0, balance: (f.stock || {})['p' + p.id] || 0 }; });
    (db.franchise_stock_history || []).filter(h => parseInt(h.franchise_id) === parseInt(fid)).forEach(h => {
      if (!stats[h.product_id]) stats[h.product_id] = { in_qty: 0, out_qty: 0, balance: 0 };
      const qty = parseInt(h.quantity) || 0;
      if (h.type === 'add') stats[h.product_id].in_qty += qty;
      else stats[h.product_id].out_qty += qty;
    });
    franchiseStockStats[fid] = stats;
  });

  return { items, products, settings: s, actType, actVal, repType, repVal, orders, transactions, stockHistory, franchiseStockStats, error: null, success: null, ...extra };
}

// Redirect franchise/manage to franchises
app.get('/admin/franchise/manage', requireAuth('admin'), (req, res) => {
  res.redirect('/admin/franchises');
});

app.get('/admin/franchises', requireAuth('admin'), (req, res) => {
  res.render('admin_franchises', franchiseRenderData({}));
});
app.post('/admin/franchises', requireAuth('admin'), (req, res) => {
  const member_name = String(req.body.member_name || '').trim() || null;
  const branch_name = String(req.body.branch_name || '').trim() || null;
  const phone = String(req.body.phone || '').trim() || null;
  const address = String(req.body.address || '').trim() || null;
  const city = String(req.body.city || '').trim() || null;
  const password = String(req.body.password || '');
  if (!member_name || !password) {
    return res.render('admin_franchises', franchiseRenderData({ error: 'Name and password are required' }));
  }
  const username = 'FR' + Date.now();
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  const f = {
    id: (++db.counters.franchise),
    franchise_code: generateFranchiseCode6(),
    username,
    member_name,
    branch_name,
    phone,
    address,
    city,
    password_hash: bcrypt.hashSync(password, 10),
    status: 'active',
    created_at: now
  };
  (db.franchises || (db.franchises=[])).push(f);
  saveDB(db);
  return res.render('admin_franchises', franchiseRenderData({ success: `Franchise ${f.username} created (${f.franchise_code})` }));
});

app.post('/admin/franchises/:id/edit', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const franchise = db.franchises.find(f => f.id === id);
  if (!franchise) {
    return res.render('admin_franchises', franchiseRenderData({ error: 'Franchise not found' }));
  }
  const member_name = String(req.body.member_name || '').trim() || null;
  const branch_name = String(req.body.branch_name || '').trim() || null;
  const phone = String(req.body.phone || '').trim() || null;
  const address = String(req.body.address || '').trim() || null;
  const city = String(req.body.city || '').trim() || null;
  // Validate phone if provided
  if (phone && !/^\d{10}$/.test(phone)) {
    return res.render('admin_franchises', franchiseRenderData({ error: 'Phone must be 10 digits' }));
  }
  franchise.member_name = member_name;
  franchise.branch_name = branch_name;
  franchise.phone = phone;
  franchise.address = address;
  franchise.city = city;
  saveDB(db);
  return res.render('admin_franchises', franchiseRenderData({ success: `Franchise ${franchise.username} updated` }));
});

app.post('/admin/franchise/password', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.body.franchise_id || '0');
  const newPassword = req.body.new_password || '';
  if (!id || !newPassword || newPassword.length < 6) {
    return res.render('admin_franchises', franchiseRenderData({ error: 'Invalid password (min 6 chars)' }));
  }
  const franchise = db.franchises.find(f => f.id === id);
  if (!franchise) {
    return res.render('admin_franchises', franchiseRenderData({ error: 'Franchise not found' }));
  }
  franchise.password_hash = bcrypt.hashSync(newPassword, 10);
  saveDB(db);
  return res.render('admin_franchises', franchiseRenderData({ success: `Password changed for ${franchise.franchise_code} (${franchise.member_name})` }));
});

app.post('/admin/franchise/delete', requireAuth('admin'), (req, res) => {
  const { franchise_id } = req.body;
  if (!franchise_id) return res.redirect('/admin/franchises');
  const idx = db.franchises.findIndex(f => f.id === parseInt(franchise_id));
  if (idx > -1) {
    const name = db.franchises[idx].username;
    db.franchises.splice(idx, 1);
    saveDB(db);
    return res.redirect('/admin/franchises?msg=Franchise ' + name + ' deleted');
  }
  return res.redirect('/admin/franchises');
});

app.post('/admin/franchise/:id/toggle-status', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const franchise = (db.franchises || []).find(f => f.id === id);
  if (!franchise) return res.redirect('/admin/franchises?err=Franchise%20not%20found');
  franchise.status = franchise.status === 'active' ? 'blocked' : 'active';
  saveDB(db);
  return res.redirect('/admin/franchises?msg=Franchise%20' + franchise.franchise_code + '%20' + franchise.status);
});

app.post('/admin/franchise/commission-settings', requireAuth('admin'), (req, res) => {
  if (!db.settings) db.settings = {};
  db.settings.franchise_activation_commission_type = req.body.activation_commission_type || 'bv';
  db.settings.franchise_activation_commission_value = parseFloat(req.body.franchise_activation_commission_value) || 10;
  db.settings.franchise_repurchase_commission_type = req.body.repurchase_commission_type || 'bv';
  db.settings.franchise_repurchase_commission_value = parseFloat(req.body.franchise_repurchase_commission_value) || 10;
  saveDB(db);
  return res.render('admin_franchises', franchiseRenderData({ success: 'Commission settings saved successfully' }));
});

// Generate franchise activation PIN
app.post('/admin/franchise/generate-pin', requireAuth('admin'), (req, res) => {
  try {
    const franchise_id = parseInt(req.body.franchise_id || '0');
    const product_id = parseInt(req.body.product_id || '0');
    const product = (db.products || []).find(p => p.id === product_id && p.active);
    if (!product) return res.status(400).json({ ok: false, error: 'Invalid product' });
    const franchise = (db.franchises || []).find(f => f.id === franchise_id);
    if (!franchise) return res.status(400).json({ ok: false, error: 'Select a franchise' });
    
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    let code = null;
    do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
    const login_pin = String(Math.floor(100000 + Math.random() * 900000));
    
    const rec = {
      id: nextId('pin_package'),
      code,
      login_pin,
      product_id: product.id,
      assigned_to: franchise.id,
      assigned_by: req.session.user.id,
      assigned_to_franchise: true,
      used_by: null,
      used_at: null,
      status: 'assigned',
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    (db.pin_packages || (db.pin_packages=[])).push(rec);
    saveDB(db);
    return res.json({ ok: true, pin: code, login_pin, product: { id: product.id, name: product.name, bv: product.bv }, franchise: { id: franchise.id, code: franchise.franchise_code, name: franchise.member_name } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to create franchise PIN' });
  }
});

// Bulk generate franchise activation PINs
app.post('/admin/franchise/generate-pins-bulk', requireAuth('admin'), (req, res) => {
  try {
    const franchise_id = parseInt(req.body.franchise_id || '0');
    const product_id = parseInt(req.body.product_id || '0');
    const quantity = Math.max(1, Math.min(parseInt(req.body.quantity || '1'), 100));
    const product = (db.products || []).find(p => p.id === product_id && p.active);
    if (!product) return res.status(400).json({ ok: false, error: 'Invalid product' });
    const franchise = (db.franchises || []).find(f => f.id === franchise_id);
    if (!franchise) return res.status(400).json({ ok: false, error: 'Select a franchise' });
    
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    const items = [];
    for (let i = 0; i < quantity; i++) {
      let code = null;
      do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
      const login_pin = String(Math.floor(100000 + Math.random() * 900000));
      const rec = {
        id: nextId('pin_package'),
        code,
        login_pin,
        product_id: product.id,
        assigned_to: franchise.id,
        assigned_by: req.session.user.id,
        assigned_to_franchise: true,
        used_by: null,
        used_at: null,
        status: 'assigned',
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      };
      (db.pin_packages || (db.pin_packages=[])).push(rec);
      items.push({ pin: code, login_pin });
    }
    saveDB(db);
    return res.json({ ok: true, count: items.length, items, product: { id: product.id, name: product.name, bv: product.bv }, franchise: { id: franchise.id, code: franchise.franchise_code, name: franchise.member_name } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to bulk create franchise PINs' });
  }
});

// Franchise PIN activation page
app.get('/franchise/activate', (req, res) => {
  res.render('franchise_activate', { error: null, success: null });
});

// Franchise PIN activation POST
app.post('/franchise/activate', (req, res) => {
  const { activation_pin, login_pin, member_name, phone, address, password } = req.body;
  if (!activation_pin || !login_pin || !member_name || !password) {
    return res.render('franchise_activate', { error: 'All fields are required', success: null });
  }
  const pin = String(activation_pin).trim().toUpperCase();
  const lp = String(login_pin).trim();
  
  if (!db.franchise_pins) db.franchise_pins = [];
  const rec = db.franchise_pins.find(p => p.code === pin);
  if (!rec) return res.render('franchise_activate', { error: 'Invalid activation PIN', success: null });
  if (rec.login_pin !== lp) return res.render('franchise_activate', { error: 'Invalid login PIN', success: null });
  if (rec.status === 'used') return res.render('franchise_activate', { error: 'This PIN has already been used', success: null });
  if (rec.status === 'expired' || rec.disabled) return res.render('franchise_activate', { error: 'This PIN has been disabled', success: null });
  
  // Create franchise account
  if (!db.counters) db.counters = {};
  if (!db.counters.franchise) db.counters.franchise = 0;
  const username = 'FR' + Date.now();
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  const franchise = {
    id: (++db.counters.franchise),
    franchise_code: generateFranchiseCode6(),
    username,
    member_name: String(member_name).trim(),
    phone: String(phone || '').trim() || null,
    address: String(address || '').trim() || null,
    password_hash: bcrypt.hashSync(String(password), 10),
    status: 'active',
    fund_wallet: 0,
    commission_wallet: 0,
    stock: {},
    created_at: now
  };
  (db.franchises || (db.franchises=[])).push(franchise);
  
  // Mark PIN as used
  rec.status = 'used';
  rec.used_by = franchise.id;
  rec.used_at = now;
  
   // Deduct stock for the product from the franchise that was assigned this PIN
   if (rec.assigned_to) {
     const assignedFranchise = db.franchises.find(f => f.id === rec.assigned_to);
     if (assignedFranchise) {
       const product = (db.products || []).find(p => p.id === rec.product_id);
       if (product) {
         // Check if franchise has sufficient stock
         const pidKey = 'p' + product.id;
         const currentStock = assignedFranchise.stock[pidKey] || 0;
         if (currentStock <= 0) {
           // Not enough stock in franchise inventory
           return res.render('franchise_activate', { error: 'Insufficient stock in franchise inventory for this product', success: null });
         }
         // Deduct from franchise stock
         assignedFranchise.stock[pidKey] = currentStock - 1;
         
          // Update global sold stock
          product.sold_stock = (product.sold_stock || 0) + 1;
          product.franchise_given_stock = Math.max(0, (product.franchise_given_stock || 0) - 1);
          product.updated_at = now;
       }
     }
   }
  
  saveDB(db);
  return res.render('franchise_activate', { error: null, success: `Franchise activated successfully! Your Franchise Code: ${franchise.franchise_code}, Username: ${franchise.username}` });
});

app.post('/admin/franchise/fund-transfer', requireAuth('admin'), (req, res) => {
  const { franchise_id, type, amount, note } = req.body;
  if (!franchise_id || !type || !amount) return res.redirect('/admin/franchises');
  const franchise = db.franchises.find(f => f.id === parseInt(franchise_id));
  if (!franchise) return res.redirect('/admin/franchises');
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.redirect('/admin/franchises');
  if (!db.franchise_wallets) db.franchise_wallets = [];
  if (!db.franchise_transactions) db.franchise_transactions = [];
  if (!franchise.fund_wallet) franchise.fund_wallet = 0;
  if (!franchise.commission_wallet) franchise.commission_wallet = 0;
  
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  let txnType = type;
  let balanceAfter = franchise.fund_wallet;
  
  if (type === 'credit') {
    franchise.fund_wallet += amt;
    balanceAfter = franchise.fund_wallet;
  } else if (type === 'debit') {
    if (franchise.fund_wallet < amt) return res.render('admin_franchises', franchiseRenderData({ error: 'Insufficient fund balance' }));
    franchise.fund_wallet -= amt;
    balanceAfter = franchise.fund_wallet;
  } else if (type === 'commission_transfer') {
    if (franchise.commission_wallet < amt) return res.render('admin_franchises', franchiseRenderData({ error: 'Insufficient commission balance. Available: ₹' + (franchise.commission_wallet || 0).toFixed(2) }));
    const beforeCommission = franchise.commission_wallet;
    franchise.commission_wallet -= amt;
    franchise.fund_wallet += amt;
    balanceAfter = franchise.fund_wallet;
    txnType = 'commission_transfer';
    console.log(`Commission Transfer: Franchise ${franchise.franchise_code} | Before: ₹${beforeCommission.toFixed(2)} | Transfer: ₹${amt.toFixed(2)} | After: ₹${franchise.commission_wallet.toFixed(2)}`);
  }
  
  // Record transaction
  db.franchise_transactions.push({
    id: Date.now(),
    franchise_id: parseInt(franchise.id),
    type: txnType,
    amount: (type === 'debit' || type === 'commission_transfer') ? -amt : amt,
    balance_after: balanceAfter,
    commission_after: franchise.commission_wallet,
    note: note || (type === 'credit' ? 'Fund credited by admin' : type === 'debit' ? 'Fund debited by admin' : 'Commission transferred to fund'),
    created_at: now
  });
  
  saveDB(db);
  return res.render('admin_franchises', franchiseRenderData({ success: `Fund transfer successful: ₹${amt.toFixed(2)}` }));
});

app.post('/admin/franchise/commission-to-bank', requireAuth('admin'), (req, res) => {
  const { franchise_id, amount, bank_ref } = req.body;
  if (!franchise_id || !amount || !bank_ref) return res.redirect('/admin/franchises');
  const franchise = db.franchises.find(f => f.id === parseInt(franchise_id));
  if (!franchise) return res.redirect('/admin/franchises');
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.redirect('/admin/franchises');
  if (!franchise.commission_wallet || franchise.commission_wallet < amt) {
    return res.render('admin_franchises', franchiseRenderData({ error: 'Insufficient commission balance' }));
  }
  
  if (!db.franchise_transactions) db.franchise_transactions = [];
  
  const now = DateTime.now().setZone('Asia/Kolkata').toISO();
  franchise.commission_wallet -= amt;
  
  // Record transaction
  db.franchise_transactions.push({
    id: Date.now(),
    franchise_id: parseInt(franchise.id),
    type: 'commission_payout',
    amount: -amt,
    balance_after: franchise.commission_wallet,
    bank_ref: bank_ref,
    note: 'Commission paid to bank',
    created_at: now
  });
  
  saveDB(db);
  return res.render('admin_franchises', franchiseRenderData({ success: `Commission payout successful: ₹${amt.toFixed(2)}` }));
});

app.post('/admin/franchise/add-stock', requireAuth('admin'), (req, res) => {
   const { franchise_id } = req.body;
   if (!franchise_id) return res.redirect('/admin/franchises');
   const franchise = db.franchises.find(f => f.id === parseInt(franchise_id));
   if (!franchise) return res.redirect('/admin/franchises');
   
   // Initialize stock object if not exists
   if (!franchise.stock) franchise.stock = {};
   
   // Process product-specific quantities from form
   let hasProductStock = false;
   const stockUpdates = [];
   
   // Check for quantity inputs in the format quantity_<product_id>
   for (const key in req.body) {
      if (key.startsWith('quantity_')) {
        const productId = parseInt(key.split('_')[1]);
        const qty = parseInt(req.body[key]) || 0;
        if (qty > 0) {
          hasProductStock = true;
          // Update franchise stock
          franchise.stock[`p${productId}`] = (franchise.stock[`p${productId}`] || 0) + qty;
          
          // Get product details for history
          const product = db.products.find(p => p.id === productId);
          if (product) {
            // Track as given to franchise (does not reduce total_stock)
            product.franchise_given_stock = (product.franchise_given_stock || 0) + qty;
            stockUpdates.push({
              product_id: productId,
              product_name: product.name,
              quantity: qty,
              type: 'add'
            });
          }
        }
     }
   }
   
   // Also handle the old stock_amount parameter for backward compatibility
   const stock_amount = req.body.stock_amount;
   if (stock_amount) {
     const amt = parseFloat(stock_amount);
     if (!isNaN(amt) && amt > 0) {
       hasProductStock = true;
       if (!franchise.stock_wallet) franchise.stock_wallet = 0;
       franchise.stock_wallet += amt;
     }
   }
   
   // If we have product stock updates, add to history
   if (hasProductStock && stockUpdates.length > 0) {
     if (!db.franchise_stock_history) db.franchise_stock_history = [];
     stockUpdates.forEach(update => {
       const historyEntry = {
         id: (db.counters.franchise_stock_history || 0) + 1,
         franchise_id: franchise.id,
         product_id: update.product_id,
         product_name: update.product_name,
         quantity: update.quantity,
         type: update.type,
         created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
       };
       db.franchise_stock_history.push(historyEntry);
       db.counters.franchise_stock_history = (db.counters.franchise_stock_history || 0) + 1;
     });
   }
   
   // If no stock was added at all, redirect back
   if (!hasProductStock) {
     return res.redirect('/admin/franchises');
   }
   
   saveDB(db);
   return res.render('admin_franchises', franchiseRenderData({ success: `Stock updated successfully for ${franchise.username}` }));
});

app.post('/admin/franchise/remove-stock', requireAuth('admin'), (req, res) => {
   const { franchise_id } = req.body;
   if (!franchise_id) return res.redirect('/admin/franchises');
   const franchise = db.franchises.find(f => f.id === parseInt(franchise_id));
   if (!franchise) return res.redirect('/admin/franchises');
   
   // Initialize stock object if not exists
   if (!franchise.stock) franchise.stock = {};
   
   // Process product-specific quantities from form
   let hasProductStock = false;
   const stockUpdates = [];
   
   // Check for quantity inputs in the format quantity_<product_id>
   for (const key in req.body) {
     if (key.startsWith('quantity_')) {
       const productId = parseInt(key.split('_')[1]);
       const qty = parseInt(req.body[key]) || 0;
       if (qty > 0) {
         hasProductStock = true;
         // Update franchise stock (subtract quantity)
         const currentStock = franchise.stock[`p${productId}`] || 0;
         const newStock = Math.max(0, currentStock - qty);
         franchise.stock[`p${productId}`] = newStock;
         
         // Get product details for history
           const product = db.products.find(p => p.id === productId);
           if (product) {
             // Reduce franchise_given_stock (product returned from franchise)
             product.franchise_given_stock = Math.max(0, (product.franchise_given_stock || 0) - qty);
             stockUpdates.push({
              product_id: productId,
              product_name: product.name,
              quantity: qty,
              type: 'remove'
            });
          }
       }
     }
   }
   
    // If we have product stock updates, add to history
    if (hasProductStock && stockUpdates.length > 0) {
      if (!db.franchise_stock_history) db.franchise_stock_history = [];
     stockUpdates.forEach(update => {
       const historyEntry = {
         id: (db.counters.franchise_stock_history || 0) + 1,
         franchise_id: franchise.id,
         product_id: update.product_id,
         product_name: update.product_name,
         quantity: update.quantity,
         type: update.type,
         created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
       };
       db.franchise_stock_history.push(historyEntry);
       db.counters.franchise_stock_history = (db.counters.franchise_stock_history || 0) + 1;
     });
   }
   
   // If no stock was processed at all, redirect back
   if (!hasProductStock) {
     return res.redirect('/admin/franchises');
   }
   
   saveDB(db);
   return res.render('admin_franchises', franchiseRenderData({ success: `Stock updated successfully for ${franchise.username}` }));
});

// Capping Management Routes
app.get('/admin/capping', requireAuth('admin'), (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const planFilter = String(req.query.plan || '').trim().toLowerCase();
    const hasCapFilter = String(req.query.has_cap || '').trim().toLowerCase();

    let users = (db.users || []).filter(u => u.role === 'user');

    // Search filter
    if (q) {
      users = users.filter(u => {
        const name = String(u.member_name || '').toLowerCase();
      const uname = String(u.username || '').toLowerCase();
        const code = String(u.user_code || '').toLowerCase();
        return name.includes(q) || uname.includes(q) || code.includes(q);
      });
    }

    // Plan filter
    if (planFilter) {
      const s = db.settings || {};
      const pvJoin = s.pv_on_join || 4000;
      const plans = db.plans || [];
      const silverPlan = plans.find(p => p.name && p.name.toLowerCase().includes('silver'));
      const goldPlan = plans.find(p => p.name && p.name.toLowerCase().includes('gold'));
      const silverBV = silverPlan ? (silverPlan.bv || silverPlan.pv || pvJoin) : pvJoin;
      const goldBV = goldPlan ? (goldPlan.bv || goldPlan.pv || (pvJoin * 2)) : (pvJoin * 2);
      users = users.filter(u => {
        if (planFilter === 'gold') return u.pv >= goldBV;
        if (planFilter === 'silver') return u.pv >= silverBV && u.pv < goldBV;
        if (planFilter === 'none') return u.pv < silverBV;
        // Plan ID filter
        const planId = parseInt(planFilter, 10);
        if (!isNaN(planId)) {
          return u.plan === planId;
        }
        return true;
      });
    }

    // Custom capping filter
    if (hasCapFilter === 'yes') {
      users = users.filter(u => u.weekly_cap_pairs !== null && u.weekly_cap_pairs !== undefined);
    } else if (hasCapFilter === 'no') {
      users = users.filter(u => u.weekly_cap_pairs === null || u.weekly_cap_pairs === undefined);
    }

    const settings = db.settings || {};
    const totalUsers = users.length;
    const pvJoin = settings.pv_on_join || 4000;
    const plans = db.plans || [];
    const silverPlan = plans.find(p => p.name && p.name.toLowerCase().includes('silver'));
    const goldPlan = plans.find(p => p.name && p.name.toLowerCase().includes('gold'));
    const silverBV = silverPlan ? (silverPlan.bv || silverPlan.pv || pvJoin) : pvJoin;
    const goldBV = goldPlan ? (goldPlan.bv || goldPlan.pv || (pvJoin * 2)) : (pvJoin * 2);

    // Pagination (optional, showing all for now)
    users = users.map(u => {
      const planId = u.plan;
      const planRec = (db.plans || []).find(p => p.id === planId);
      const planName = planRec ? planRec.name : (u.pv >= goldBV ? 'Gold' : (u.pv >= silverBV ? 'Silver' : 'None'));
      return {
        id: u.id,
        username: u.username,
        member_name: u.member_name,
        user_code: u.user_code,
        pv: u.pv || 0,
        weekly_cap_pairs: u.weekly_cap_pairs,
        status: u.status || 'active',
        plan_id: planId,
        plan_name: planName
      };
    });

    res.render('admin_capping', {
      users,
      totalUsers,
      settings,
      q,
      plan: planFilter,
      has_cap: hasCapFilter,
      plans: db.plans || [],
      success: req.query.msg || null,
      error: req.query.err || null
    });
  } catch (e) {
    console.error('Capping management error:', e);
    res.status(500).render('admin_capping', {
      users: [],
      totalUsers: 0,
      settings: db.settings || {},
      q: '',
      plan: '',
      has_cap: '',
      plans: db.plans || [],
      error: 'Failed to load capping data'
    });
  }
});

app.post('/admin/capping/user/:id', requireAuth('admin'), (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const user = db.users.find(u => u.id === userId && u.role === 'user');
    if (!user) {
      return res.redirect('/admin/capping?err=User%20not%20found');
    }

    const capValue = req.body.weekly_cap_pairs;
    if (capValue === '' || capValue === null || capValue === undefined) {
      user.weekly_cap_pairs = null;
    } else {
      const parsed = parseInt(capValue, 10);
      if (isNaN(parsed) || parsed < 0) {
        return res.redirect('/admin/capping?err=Invalid%20capping%20value');
      }
      user.weekly_cap_pairs = parsed;
    }

    saveDB(db);
    res.redirect('/admin/capping?msg=Capping%20updated%20successfully');
  } catch (e) {
    console.error('Update user capping error:', e);
    res.redirect('/admin/capping?err=Failed%20to%20update%20capping');
  }
});

app.post('/admin/capping/bulk-update', requireAuth('admin'), (req, res) => {
  try {
    const target = String(req.body.target_users || '').trim();
    const newCap = req.body.weekly_cap_pairs;
    if (newCap === '' || newCap === null || newCap === undefined) {
      return res.redirect('/admin/capping?err=Please%20provide%20a%20capping%20value');
    }
    const capValue = parseInt(newCap, 10);
    if (isNaN(capValue) || capValue < 0) {
      return res.redirect('/admin/capping?err=Invalid%20capping%20value');
    }

    let users = [];

    // Get dynamic plan values
    const s = db.settings || {};
    const pvJoin = s.pv_on_join || 4000;
    const plans = db.plans || [];
    const silverPlan = plans.find(p => p.name && p.name.toLowerCase().includes('silver'));
    const goldPlan = plans.find(p => p.name && p.name.toLowerCase().includes('gold'));
    const silverBV = silverPlan ? (silverPlan.bv || silverPlan.pv || pvJoin) : pvJoin;
    const goldBV = goldPlan ? (goldPlan.bv || goldPlan.pv || (pvJoin * 2)) : (pvJoin * 2);

    // Filter target users
    if (target === 'selected') {
      // Get selected user IDs from form
      const selectedIds = req.body.selected_users || [];
      const idSet = new Set(Array.isArray(selectedIds) ? selectedIds : [selectedIds]);
      users = (db.users || []).filter(u => u.role === 'user' && idSet.has(String(u.id)));
    } else {
      let allUsers = (db.users || []).filter(u => u.role === 'user');
      if (target === 'gold') {
        allUsers = allUsers.filter(u => u.pv >= goldBV);
      } else if (target === 'silver') {
        allUsers = allUsers.filter(u => u.pv >= silverBV && u.pv < goldBV);
      } else if (target === 'none') {
        allUsers = allUsers.filter(u => u.pv < silverBV);
      } else if (target === 'plan') {
        const planId = parseInt(req.body.target_plan, 10);
        if (!isNaN(planId)) {
          allUsers = allUsers.filter(u => u.plan === planId);
        }
      } // 'all' means no filter
      users = allUsers;
    }

    let count = 0;
    for (const u of users) {
      u.weekly_cap_pairs = capValue;
      count++;
    }
    saveDB(db);
    res.redirect(`/admin/capping?msg=Updated%20capping%20for%20${count}%20users`);
  } catch (e) {
    console.error('Bulk capping update error:', e);
    res.redirect('/admin/capping?err=Failed%20to%20update%20capping');
  }
});

app.post('/admin/capping/reset-all', requireAuth('admin'), (req, res) => {
  try {
    let users = (db.users || []).filter(u => u.role === 'user');
    let count = 0;
    for (const u of users) {
      if (u.weekly_cap_pairs !== null && u.weekly_cap_pairs !== undefined) {
        u.weekly_cap_pairs = null;
        count++;
      }
    }
    saveDB(db);
    res.redirect(`/admin/capping?msg=Reset%20capping%20for%20${count}%20users%20to%20global%20default`);
  } catch (e) {
    console.error('Reset all capping error:', e);
    res.redirect('/admin/capping?err=Failed%20to%20reset%20capping');
  }
});

app.post('/admin/users/clear-all', requireAuth('admin'), (req, res) => {
  try {
    // Backup admin accounts before clearing
    const admins = (db.users || []).filter(u => u.role === 'admin');
    
    // Get all non-admin user IDs to check references
    const nonAdminIds = (db.users || []).filter(u => u.role !== 'admin').map(u => u.id);
    
    // Remove all users (except admins) - completely new array
    db.users = admins.map(admin => ({ ...admin }));
    
    // Reset admin as root for binary tree
    db.users.forEach(admin => {
      admin.left_id = null;
      admin.right_id = null;
      admin.placement_parent_id = null;
      admin.placement_side = null;
      admin.index_num = 1;
      admin.pv = 0;
      admin.carry_left = 0;
      admin.carry_right = 0;
      // Clear read broadcasts so they can see new broadcasts
      admin.read_broadcasts = [];
    });
    
    // Update default sponsor to first admin
    if (admins.length > 0 && admins[0].username) {
      if (!db.settings) db.settings = {};
      db.settings.default_sponsor_username = admins[0].username;
    }
    
    // Clear ALL related data that references users
    if (db.earnings) db.earnings = [];
    if (db.payouts) db.payouts = [];
    if (db.orders) db.orders = [];
    if (db.pin_packages) db.pin_packages = [];
    if (db.rank_history) db.rank_history = [];
    if (db.celebrations) db.celebrations = [];
    if (db.tickets) db.tickets = [];
    if (db.free_products) db.free_products = [];
    if (db.free_product_issues) db.free_product_issues = [];
    if (db.gallery) db.gallery = [];
    if (db.invoices) db.invoices = [];
    if (db.franchise_transactions) db.franchise_transactions = [];
    if (db.franchise_stock_history) db.franchise_stock_history = [];
    if (db.franchise_wallets) db.franchise_wallets = [];
    
    // Reset all counters
    if (db.counters) {
      db.counters.user = admins.length; // Set to number of admins
      db.counters.earning = 0;
      db.counters.payout = 0;
      db.counters.order = 0;
      db.counters.pin_package = 0;
      db.counters.celebration = 0;
      db.counters.free_product = 0;
      db.counters.free_product_issue = 0;
      db.counters.gallery = 0;
      db.counters.invoice = 0;
      db.counters.ticket = 0;
    }
    
    // Also clear franchises if needed (optional - keep franchises)
    // if (db.franchises) db.franchises = [];
    // if (db.franchise_wallets) db.franchise_wallets = [];
    
    // Save to disk
    saveDB(db);
    console.log('All users cleared. Admin reset as binary root.');
    
    // Return JSON response instead of redirect (prevents hanging on slow connections)
    res.json({ ok: true, message: 'All users cleared successfully' });
  } catch (e) {
    console.error('Clear all users error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get('/admin/franchise/orders', requireAuth('admin'), (req, res) => {
  try {
    const filterFranchise = req.query.franchise_id || '';
    const franchises = (db.franchises || []).filter(f => f.active !== false);
    
    // Get all orders with franchise info
    let orders = (db.orders || [])
      .filter(o => o.type === 'repurchase' && o.franchise_id)
      .map(o => {
        const franchise = getFranchiseById(o.franchise_id);
        const cust = o.user_id ? getUserById(o.user_id) : null;
        return {
          ...o,
          franchise_name: franchise ? (franchise.member_name || franchise.username) : 'Unknown',
          franchise_code: franchise ? franchise.franchise_code : '-',
          customer_code: o.customer_code || (cust ? (cust.user_code || cust.username) : '-'),
          customer_name: o.customer_name || (cust ? (cust.member_name || cust.username) : '-')
        };
      });
    
    // Apply franchise filter
    if (filterFranchise) {
      orders = orders.filter(o => o.franchise_id === parseInt(filterFranchise));
    }
    
    // Sort by date descending
    orders.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    
    res.render('admin_franchise_orders', { 
      franchises, 
      filter_franchise: filterFranchise, 
      orders 
    });
  } catch (e) {
    console.error('Admin franchise orders error:', e);
    res.status(500).send('Internal Server Error');
  }
});


// Admin view franchise invoice
app.get('/admin/franchise/invoice/:id', requireAuth('admin'), (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const order = (db.orders || []).find(o => o.id === orderId);
    if (!order) return res.redirect('/admin/franchise/orders');
    
    const franchise = getFranchiseById(order.franchise_id);
    const product = db.products ? db.products.find(p => p.id === order.product_id) : null;
    const s = db.settings || {};
    const customer = order.user_id ? getUserById(order.user_id) : null;
    
    const existingInvoice = (db.invoices || []).find(inv => inv.order_id === order.id);
    
    const qty = order.quantity || 1;
    const rate = product ? (product.selling_price_inr || product.mrp_inr || 0) : 0;
    const gstPercent = product ? (product.gst_percent || 0) : 0;
    const gstType = (db.settings || {}).gst_type || 'inclusive';
    let totalInr, gstInr, priceInr, cgst, sgst;
    
    if (gstType === 'exclusive') {
      priceInr = rate * qty;
      gstInr = priceInr * (gstPercent / 100);
      totalInr = priceInr + gstInr;
    } else {
      totalInr = rate * qty;
      gstInr = totalInr * (gstPercent / (100 + gstPercent));
      priceInr = totalInr - gstInr;
    }
    cgst = gstInr / 2;
    sgst = gstInr / 2;
    
    const invoice = {
      invoice_no: existingInvoice ? existingInvoice.invoice_no : 'N/A',
      id: order.id,
      created_at: order.created_at,
      franchise_name: franchise ? (franchise.member_name || franchise.franchise_code) : 'Unknown',
      franchise_address: franchise ? (franchise.address || '') : '',
      franchise_phone: franchise ? (franchise.phone || '') : '',
      total_bv: order.total_bv || 0,
      total_inr: existingInvoice ? existingInvoice.total_inr : totalInr,
      product_name: product ? product.name : '',
      product_code: product ? product.code || product.product_code || '' : '',
      hsn_code: product ? product.hsn_code || '' : '',
      quantity: qty,
      rate: rate,
      price_inr: existingInvoice ? (existingInvoice.price_inr || priceInr) : priceInr,
      gst_percent: gstPercent,
      gst_inr: existingInvoice ? (existingInvoice.gst_inr || gstInr) : gstInr,
      sgst: existingInvoice ? (existingInvoice.gst_inr || gstInr) / 2 : sgst,
      cgst: existingInvoice ? (existingInvoice.gst_inr || gstInr) / 2 : cgst,
      items: existingInvoice && existingInvoice.items ? existingInvoice.items : (product ? [{
        product_name: product.name || '',
        product_code: product.code || product.product_code || '',
        hsn_code: product.hsn_code || '',
        quantity: qty,
        rate: rate,
        price_inr: priceInr,
        gst_percent: gstPercent,
        gst_inr: gstInr,
        sgst: sgst,
        cgst: cgst,
        total_inr: totalInr
      }] : [])
    };
    
    res.render('franchise_invoice_view', { 
      user: franchise || {}, 
      invoice, 
      company_name: s.company_name || s.brand_name || 'Nastige',
      company_address: s.company_address || '',
      company_phone: s.company_phone || '',
      company_email: s.company_email || '',
      company_gstin: s.company_gstin || '',
      gst_type: s.gst_type || 'inclusive',
      customer,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) 
    });
  } catch (e) {
    console.error('Admin invoice view error:', e);
    res.redirect('/admin/franchise/orders');
  }
});


app.post('/admin/franchise/orders/delete', requireAuth('admin'), (req, res) => {
  try {
    const orderId = parseInt(req.body.order_id || '0');
    if (!orderId) return res.redirect('/admin/franchise/orders');
    
    console.log('[DELETE ORDER] Starting full rollback for order:', orderId);
    
    // ===== STEP 1: Find the order =====
    const order = (db.orders || []).find(o => o.id === orderId);
    if (!order) {
      return res.redirect('/admin/franchise/orders?error=Order not found');
    }
    
    // ===== STEP 2: Find user and franchise =====
    const userId = order.user_id;
    const user = userId ? getUserById(userId) : null;
    const franchiseId = order.franchise_id;
    const franchise = franchiseId ? getFranchiseById(franchiseId) : null;
    
    // ===== STEP 3: Calculate BV to reverse =====
    const bvToReverse = order.total_bv || 0;
    
    // ===== STEP 4: Reverse BV from user and ancestors =====
    if (user && bvToReverse > 0) {
      console.log('[DELETE ORDER] Reversing BV:', bvToReverse, 'from user:', user.user_code);
      
      user.pv = Math.max(0, (user.pv || 0) - bvToReverse);
      
      // Check if this was a repurchase order
      const isRepurchase = (order.type === 'repurchase');
      
      let current = user.placement_parent_id ? getUserById(user.placement_parent_id) : null;
      let prev = user;
      while (current) {
        if (current.left_id === prev.id) {
          if (isRepurchase) {
            current.repurchase_carry_left = Math.max(0, (current.repurchase_carry_left || 0) - bvToReverse);
          } else {
            current.carry_left = Math.max(0, (current.carry_left || 0) - bvToReverse);
          }
        } else if (current.right_id === prev.id) {
          if (isRepurchase) {
            current.repurchase_carry_right = Math.max(0, (current.repurchase_carry_right || 0) - bvToReverse);
          } else {
            current.carry_right = Math.max(0, (current.carry_right || 0) - bvToReverse);
          }
        }
        if (!current.placement_parent_id) break;
        prev = current;
        current = getUserById(current.placement_parent_id);
      }
    }
    
    // ===== STEP 5: Restore product stock =====
    if (franchise) {
      // For franchise orders, stock is already tracked via franchise_given_stock
      // and franchise stock. Just restore franchise stock below.
    } else if (order.product_id) {
      const product = (db.products || []).find(p => p.id === order.product_id);
      if (product) {
        product.total_stock = (product.total_stock || 0) + (order.quantity || 1);
        product.sold_stock = Math.max(0, (product.sold_stock || 0) - (order.quantity || 1));
        console.log('[DELETE ORDER] Restored product stock:', product.name);
      }
    }
    if (!franchise && order.order_items && Array.isArray(order.order_items)) {
      order.order_items.forEach(item => {
        const product = (db.products || []).find(p => p.id === item.product_id);
        if (product) {
          product.total_stock = (product.total_stock || 0) + (item.qty || 1);
          product.sold_stock = Math.max(0, (product.sold_stock || 0) - (item.qty || 1));
        }
      });
    }
    
    // ===== STEP 6: Restore franchise stock =====
    if (franchise) {
      if (!franchise.stock) franchise.stock = {};
      
      if (order.product_id) {
        const stockKey = 'p' + order.product_id;
        franchise.stock[stockKey] = (franchise.stock[stockKey] || 0) + (order.quantity || 1);
      }
      if (order.order_items && Array.isArray(order.order_items)) {
        order.order_items.forEach(item => {
          const stockKey = 'p' + item.product_id;
          franchise.stock[stockKey] = (franchise.stock[stockKey] || 0) + (item.qty || 1);
        });
      }
      
      // Restore fund wallet
      if (order.total_inr) {
        franchise.fund_wallet = (franchise.fund_wallet || 0) + order.total_inr;
      }
      
      console.log('[DELETE ORDER] Restored franchise stock and wallet');
    }
    
    // ===== STEP 7: Remove associated earnings =====
    const earningsBefore = (db.earnings || []).length;
    db.earnings = (db.earnings || []).filter(e => {
      if (user && e.user_id === user.id && e.created_at >= order.created_at) {
        return false;
      }
      return true;
    });
    
    // ===== STEP 8: Remove associated payouts =====
    const payoutsBefore = (db.payouts || []).length;
    db.payouts = (db.payouts || []).filter(p => {
      if (user && p.user_id === user.id && p.created_at >= order.created_at) {
        return false;
      }
      return true;
    });
    
    // ===== STEP 9: Reverse franchise commission =====
    if (franchise) {
      db.franchise_transactions = (db.franchise_transactions || []).filter(t => {
        if (t.franchise_id === franchise.id && t.order_id === orderId) {
          if (t.type === 'commission' && t.amount) {
            franchise.commission_wallet = Math.max(0, (franchise.commission_wallet || 0) - t.amount);
          }
          return false;
        }
        return true;
      });
      
      if (franchise.commission_history) {
        franchise.commission_history = franchise.commission_history.filter(h => h.order_id !== orderId);
      }
    }
    
    // ===== STEP 10: Remove related invoices =====
    if (db.invoices) {
      db.invoices = db.invoices.filter(inv => inv.order_id !== orderId);
    }
    
    // ===== STEP 11: Remove the order =====
    db.orders = (db.orders || []).filter(o => o.id !== orderId);
    
    // ===== STEP 12: Update user ranks =====
    if (user) {
      updateUserRank(user.id);
      let current = user.placement_parent_id ? getUserById(user.placement_parent_id) : null;
      while (current) {
        updateUserRank(current.id);
        if (!current.placement_parent_id) break;
        current = getUserById(current.placement_parent_id);
      }
    }
    
    saveDB(db);
    console.log('[DELETE ORDER] Full rollback completed for order:', orderId);
    res.redirect('/admin/franchise/orders?msg=' + encodeURIComponent('Order #' + orderId + ' deleted with full rollback'));
  } catch (e) {
    console.error('Delete order error:', e);
    res.redirect('/admin/franchise/orders?error=' + encodeURIComponent('Delete failed: ' + e.message));
  }
});


app.get('/admin/franchise/pin-reports', requireAuth('admin'), (req, res) => {
  try {
    const me = getUserById(req.session.user.id);
    // Get all PIN packages with usage details
    const pinPackages = (db.pin_packages || []).slice().reverse().map(pin => {
      const assignedTo = pin.assigned_to ? getUserById(pin.assigned_to) : null;
      const usedBy = pin.used_by ? getUserById(pin.used_by) : null;
      const plan = pin.plan_id ? (db.plans || []).find(pl => pl.id === pin.plan_id) : null;
      
      // Check if assigned_to_franchise is a franchise
      const assignedFranchise = pin.assigned_to_franchise ? (db.franchises || []).find(f => f.id === parseInt(pin.assigned_to_franchise)) : null;
      
      // Parse product_ids (could be already array from adapter, or JSON string)
      let productIds = [];
      try {
        if (Array.isArray(pin.product_ids)) productIds = pin.product_ids;
        else if (typeof pin.product_ids === 'string') productIds = JSON.parse(pin.product_ids || '[]');
        else productIds = [];
      } catch(e) { productIds = []; }
      // Fallback: get product_ids from the plan if PIN doesn't have them
      if (!productIds.length && plan) {
        try {
          if (Array.isArray(plan.product_id)) productIds = plan.product_id;
          else if (typeof plan.product_id === 'string') productIds = JSON.parse(plan.product_id || '[]');
          else if (plan.product_id) productIds = [plan.product_id];
        } catch(e) {}
      }
      const productNames = productIds.map(pid => {
        const prod = (db.products || []).find(p => p.id === pid);
        return prod ? { id: prod.id, name: prod.name, bv: prod.bv || 0 } : null;
      }).filter(Boolean);
      const totalBV = productNames.reduce((s, p) => s + p.bv, 0);
      
      return {
        id: pin.id,
        code: pin.code,
        login_pin: pin.login_pin,
        status: pin.status,
        assigned_to: assignedTo ? {
          id: assignedTo.id,
          username: assignedTo.username,
          user_code: assignedTo.user_code,
          member_name: assignedTo.member_name
        } : null,
        assigned_franchise: assignedFranchise ? {
          id: assignedFranchise.id,
          franchise_code: assignedFranchise.franchise_code,
          member_name: assignedFranchise.member_name
        } : null,
        used_by: usedBy ? {
          id: usedBy.id,
          username: usedBy.username,
          user_code: usedBy.user_code,
          member_name: usedBy.member_name
        } : null,
        products: productNames,
        total_bv: totalBV,
        plan: plan ? {
          id: plan.id,
          name: plan.name
        } : null,
        assigned_at: pin.assigned_at || pin.created_at,
        used_at: pin.used_at,
        created_at: pin.created_at
      };
    });

    // Get all repurchase orders from franchises
    const repurchaseOrders = (db.orders || [])
      .filter(order => order.type === 'repurchase')
      .slice()
      .reverse()
      .map(order => {
        const franchise = order.franchise_id ? getFranchiseById(order.franchise_id) : null;
        const product = order.product_id ? (db.products || []).find(p => p.id === order.product_id) : null;
        
        return {
          id: order.id,
          franchise: franchise ? {
            id: franchise.id,
            username: franchise.username,
            franchise_code: franchise.franchise_code,
            member_name: franchise.member_name
          } : null,
          product: product ? {
            id: product.id,
            name: product.name,
            bv: product.bv
          } : null,
          quantity: order.quantity,
          total_bv: order.total_bv,
          total_inr: order.total_inr,
          status: order.status || 'completed',
          created_at: order.created_at
        };
      });

    // Summary statistics
    const totalPins = pinPackages.length;
    const assignedPins = pinPackages.filter(p => p.status === 'assigned').length;
    const usedPins = pinPackages.filter(p => p.status === 'used').length;
    const expiredPins = pinPackages.filter(p => p.status === 'expired' || p.disabled).length;
    
    const totalRepurchases = repurchaseOrders.length;
    const totalRepurchaseBV = repurchaseOrders.reduce((sum, o) => sum + (o.total_bv || 0), 0);
    const totalRepurchaseINR = repurchaseOrders.reduce((sum, o) => sum + (o.total_inr || 0), 0);

    res.render('admin_franchise_pin_reports', {
      user: me,
      pinPackages,
      repurchaseOrders,
      stats: {
        totalPins,
        assignedPins,
        usedPins,
        expiredPins,
        totalRepurchases,
        totalRepurchaseBV,
        totalRepurchaseINR
      },
      error: null,
      success: null
    });
  } catch (e) {
    console.error('PIN reports error:', e.message, e.stack);
    const me = getUserById(req.session.user.id);
    res.render('admin_franchise_pin_reports', {
      user: me,
      pinPackages: [],
      repurchaseOrders: [],
      stats: {
        totalPins: 0,
        assignedPins: 0,
        usedPins: 0,
        expiredPins: 0,
        totalRepurchases: 0,
        totalRepurchaseBV: 0,
        totalRepurchaseINR: 0
      },
      error: 'Failed to load reports: ' + e.message,
      success: null
    });
  }
});

app.post('/admin/tree/clear-admin-sides', requireAuth('admin'), (req, res) => {
  try {
    let adminUser = getUserByUsername('admin');
    if (!adminUser) {
      adminUser = (db.users || []).find(u => u.role === 'admin') || null;
    }
    if (!adminUser) return res.status(404).json({ ok: false, error: 'Admin user not found' });
    const leftId = adminUser.left_id || null;
    const rightId = adminUser.right_id || null;
    if (leftId) {
      const leftChild = getUserById(leftId);
      if (leftChild) leftChild.placement_parent_id = null;
      adminUser.left_id = null;
    }
    if (rightId) {
      const rightChild = getUserById(rightId);
      if (rightChild) rightChild.placement_parent_id = null;
      adminUser.right_id = null;
    }
    saveDB(db);
    return res.json({ ok: true, cleared_left: !!leftId, cleared_right: !!rightId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to clear admin children' });
  }
});

app.get('/admin/api/user-lookup', requireAuth('admin'), (req, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!ref) return res.json({ ok: false, user: null });
  const user = getUserByRef(ref);
  if (!user) return res.json({ ok: false, user: null });
  return res.json({ ok: true, user: { id: user.id, username: user.username, user_code: user.user_code || null, member_name: user.member_name || null, status: user.status || null } });
});

app.get('/admin/api/pin-lookup', requireAuth('admin'), (req, res) => {
  const pinCode = String(req.query.pin || '').trim();
  if (!pinCode) return res.json({ ok: false });
  const pin = (db.pin_packages || []).find(x => x.code === pinCode && !x.used_by);
  if (!pin) return res.json({ ok: false, error: 'PIN not found or already used' });
  let planName = '';
  let amount = 0;
  let productNames = [];
  if (pin.plan_id) {
    const plan = (db.plans || []).find(p => p.id === pin.plan_id);
    if (plan) {
      planName = plan.name || '';
      amount = plan.amount_inr || plan.price || 0;
      if (plan.product_id) {
        const prod = (db.products || []).find(p => p.id === plan.product_id);
        if (prod) {
          amount = prod.price || amount;
          productNames.push(prod.name);
        }
      }
    }
  }
  if (pin.product_id) {
    const prod = (db.products || []).find(p => p.id === pin.product_id);
    if (prod) {
      productNames.push(prod.name);
      amount = prod.price || amount;
    }
  }
  if (pin.product_ids && pin.product_ids.length) {
    pin.product_ids.forEach(id => {
      const prod = (db.products || []).find(p => p.id === id);
      if (prod && !productNames.includes(prod.name)) {
        productNames.push(prod.name);
      }
    });
  }
  return res.json({ ok: true, pin: { code: pin.code, plan_name: planName, product_names: productNames.join(', '), amount } });
});

app.get('/admin/bv-adjustments', requireAuth('admin'), (req, res) => {
  const qRef = String(req.query.user || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const sISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const eISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
  let rows = (db.bv_adjustments || []).slice().reverse().map(r => {
    const u = getUserById(r.user_id);
    const adminU = getUserById(r.added_by_admin_id);
    return {
      id: r.id,
      user_id: r.user_id,
      user_code: u ? (u.user_code || u.username) : r.user_code || '',
      username: u ? (u.username || '') : '',
      side: r.side,
      amount: r.amount || 0,
      note: r.note || '',
      created_at: r.created_at,
      added_by: adminU ? (adminU.user_code || adminU.username) : 'admin'
    };
  }).filter(row => {
    if (qRef) {
      const match = [row.user_code, row.username].some(v => String(v || '').toLowerCase().includes(qRef.toLowerCase()));
      if (!match) return false;
    }
    if (sISO && (row.created_at || '') < sISO) return false;
    if (eISO && (row.created_at || '') > eISO) return false;
    return true;
  });
  const totals = rows.reduce((acc, r) => {
    if (r.side === 'left') acc.left += (r.amount || 0);
    else if (r.side === 'right') acc.right += (r.amount || 0);
    return acc;
  }, { left: 0, right: 0 });
  res.render('admin_bv_adjustments', { rows, totals, filter_user: qRef, from, to, success: req.query.msg || null, error: null });
});

app.post('/admin/bv-adjustments', requireAuth('admin'), (req, res) => {
  try {
    const userRef = String(req.body.user_ref || '').trim();
    const side = String(req.body.side || '').trim().toLowerCase();
    const amount = parseFloat(req.body.amount || '0') || 0;
    const note = String(req.body.note || '').trim();
    if (!userRef || !amount || amount <= 0 || !['left','right'].includes(side)) {
      return res.redirect('/admin/bv-adjustments?err=Invalid%20input');
    }
    const user = getUserByRef(userRef);
    if (!user) return res.redirect('/admin/bv-adjustments?err=User%20not%20found');
    const adj = {
      id: (db.counters && db.counters.bv_adjustment) ? (++db.counters.bv_adjustment) : ((db.counters = db.counters || {}, db.counters.bv_adjustment = 1)),
      user_id: user.id,
      user_code: user.user_code || user.username,
      member_name: user.member_name || null,
      side,
      amount,
      note,
      added_by_admin_id: req.session.user.id,
      added_by: req.session.user.username || 'admin',
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    (db.bv_adjustments || (db.bv_adjustments=[])).push(adj);
    if (side === 'left') user.carry_left = (user.carry_left || 0) + amount;
    else user.carry_right = (user.carry_right || 0) + amount;
    // Update ranks for all upline sponsors
    getUplineIds(user.id).forEach(uid => updateUserRank(uid));
    saveDB(db);
    return res.redirect('/admin/bv-adjustments?msg=BV%20adjusted%20(user%20only)');
  } catch (e) {
    return res.redirect('/admin/bv-adjustments?err=Failed');
  }
});

app.post('/admin/bv-adjustments/edit', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.body.id || '0');
    const side = String(req.body.side || '').trim().toLowerCase();
    const amount = parseFloat(req.body.amount || '0') || 0;
    const note = String(req.body.note || '').trim();
    if (!id || !amount || amount <= 0 || !['left','right'].includes(side)) {
      return res.redirect('/admin/bv-adjustments?err=Invalid%20input');
    }
    const adj = (db.bv_adjustments || []).find(a => a.id === id);
    if (!adj) return res.redirect('/admin/bv-adjustments?err=Adjustment%20not%20found');
    const user = getUserById(adj.user_id);
    if (!user) return res.redirect('/admin/bv-adjustments?err=User%20not%20found');

    // Reverse old BV
    if (adj.side === 'left') user.carry_left = Math.max(0, (user.carry_left || 0) - adj.amount);
    else user.carry_right = Math.max(0, (user.carry_right || 0) - adj.amount);

    // Apply new BV
    if (side === 'left') user.carry_left = (user.carry_left || 0) + amount;
    else user.carry_right = (user.carry_right || 0) + amount;

    // Update record
    adj.side = side;
    adj.amount = amount;
    adj.note = note;
    adj.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();

    saveDB(db);
    // Update ranks for all upline sponsors
    getUplineIds(user.id).forEach(uid => updateUserRank(uid));
    return res.redirect('/admin/bv-adjustments?msg=Adjustment%20updated');
  } catch (e) {
    return res.redirect('/admin/bv-adjustments?err=Failed%20to%20update');
  }
});

app.post('/admin/bv-adjustments/delete', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.body.id || '0');
    if (!id) return res.redirect('/admin/bv-adjustments?err=Invalid%20ID');
    const idx = (db.bv_adjustments || []).findIndex(a => a.id === id);
    if (idx === -1) return res.redirect('/admin/bv-adjustments?err=Adjustment%20not%20found');
    const adj = db.bv_adjustments[idx];
    const user = getUserById(adj.user_id);
    if (user) {
      // Reverse BV
      if (adj.side === 'left') user.carry_left = Math.max(0, (user.carry_left || 0) - adj.amount);
      else user.carry_right = Math.max(0, (user.carry_right || 0) - adj.amount);
    }
    db.bv_adjustments.splice(idx, 1);
    saveDB(db);
    // Update ranks for all upline sponsors
    if (user) getUplineIds(user.id).forEach(uid => updateUserRank(uid));
    return res.redirect('/admin/bv-adjustments?msg=Adjustment%20deleted%20%26%20BV%20reversed');
  } catch (e) {
    return res.redirect('/admin/bv-adjustments?err=Failed%20to%20delete');
  }
});

// Offer Management Routes
app.get('/admin/offers', requireAuth('admin'), (req, res) => {
  const offers = (db.offers || []).slice().reverse();
  const products = (db.products || []).filter(p => p.active);
  res.render('admin_offers', { offers, products, editOffer: null, error: req.query.err || null, success: req.query.msg || null });
});

app.post('/admin/offers', requireAuth('admin'), (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || 'pairs').trim().toLowerCase();
    const durationType = String(req.body.duration_type || 'weekly').trim().toLowerCase();
    const customDays = parseInt(req.body.custom_days || '0') || 0;
    const rewardAmount = parseFloat(req.body.reward_amount || '0') || 0;
    const rewardProductName = String(req.body.reward_product_name || '').trim();
    const rewardProductId = req.body.reward_product_id ? parseInt(req.body.reward_product_id) : null;
    const rewardTour = String(req.body.reward_tour || '').trim();
    const startDate = String(req.body.start_date || '').trim();
    let endDate = String(req.body.end_date || '').trim();
    const isActive = req.body.is_active === 'true';

    let targetPairs = 0;
    let targetBv = 0;
    let targetAmount = 0;

    if (category === 'pairs') {
      targetPairs = parseInt(req.body.target_pairs || '0') || 0;
      if (!targetPairs) return res.redirect('/admin/offers?err=Target%20pairs%20required');
    } else if (category === 'repurchase') {
      targetBv = parseInt(req.body.target_bv || '0') || 0;
      if (!targetBv) return res.redirect('/admin/offers?err=Target%20BV%20required');
    } else if (category === 'leadership') {
      targetAmount = parseFloat(req.body.target_amount || '0') || 0;
      if (!targetAmount) return res.redirect('/admin/offers?err=Target%20amount%20required');
    }

    if (!name || !startDate) {
      return res.redirect('/admin/offers?err=All%20fields%20are%20required');
    }

    // If custom duration, calculate end date from start date
    if (durationType === 'custom') {
      if (!customDays || customDays < 1) {
        return res.redirect('/admin/offers?err=Custom%20days%20required');
      }
      const start = new Date(startDate);
      start.setDate(start.getDate() + customDays);
      endDate = start.toISOString().split('T')[0];
    }

    // Calculate duration label
    let durationLabel = durationType === 'weekly' ? 'Weekly (7 Days)' : 
                        durationType === 'monthly' ? 'Monthly (30 Days)' : 
                        'Custom (' + customDays + ' Days)';

    const newOffer = {
      id: (db.counters && db.counters.offer) ? (++db.counters.offer) : ((db.counters = db.counters || {}, db.counters.offer = 1)),
      name,
      category,
      duration_type: durationType,
      custom_days: customDays || null,
      duration_label: durationLabel,
      type: durationType,
      target_pairs: targetPairs,
      target_bv: targetBv,
      target_amount: targetAmount,
      reward_amount: rewardAmount,
      reward_product_name: rewardProductName || null,
      reward_product_id: rewardProductId,
      reward_tour: rewardTour || null,
      start_date: startDate,
      end_date: endDate,
      is_active: isActive,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };

    if (!db.offers) db.offers = [];
    db.offers.push(newOffer);
    saveDB(db);

    // Process achievements for this offer
    processOfferAchievements(newOffer.id);

    return res.redirect('/admin/offers?msg=Offer%20created%20successfully');
  } catch (e) {
    console.error('Create offer error:', e);
    return res.redirect('/admin/offers?err=Failed%20to%20create%20offer');
  }
});

app.get('/admin/offers/toggle/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const offer = (db.offers || []).find(o => o.id === id);
  if (!offer) return res.redirect('/admin/offers?err=Offer%20not%20found');
  offer.is_active = !offer.is_active;
  saveDB(db);
  return res.redirect('/admin/offers?msg=Offer%20' + (offer.is_active ? 'enabled' : 'disabled'));
});

app.get('/admin/offers/delete/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.offers) db.offers = [];
  const idx = db.offers.findIndex(o => o.id === id);
  if (idx === -1) return res.redirect('/admin/offers?err=Offer%20not%20found');
  db.offers.splice(idx, 1);
  saveDB(db);
  return res.redirect('/admin/offers?msg=Offer%20deleted');
});

app.get('/admin/offers/edit/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const offers = (db.offers || []).slice().reverse();
  const products = (db.products || []).filter(p => p.active);
  const editOffer = (db.offers || []).find(o => o.id === id);
  if (!editOffer) return res.redirect('/admin/offers?err=Offer%20not%20found');
  res.render('admin_offers', { offers, products, editOffer, error: req.query.err || null, success: null });
});

app.post('/admin/offers/update/:id', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const offer = (db.offers || []).find(o => o.id === id);
    if (!offer) return res.redirect('/admin/offers?err=Offer%20not%20found');

    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || 'pairs').trim().toLowerCase();
    const durationType = String(req.body.duration_type || 'weekly').trim().toLowerCase();
    const customDays = parseInt(req.body.custom_days || '0') || 0;
    const rewardAmount = parseFloat(req.body.reward_amount || '0') || 0;
    const rewardProductName = String(req.body.reward_product_name || '').trim();
    const rewardProductId = req.body.reward_product_id ? parseInt(req.body.reward_product_id) : null;
    const rewardTour = String(req.body.reward_tour || '').trim();
    const startDate = String(req.body.start_date || '').trim();
    let endDate = String(req.body.end_date || '').trim();
    const isActive = req.body.is_active === 'true';

    let targetPairs = 0, targetBv = 0, targetAmount = 0;

    if (category === 'pairs') {
      targetPairs = parseInt(req.body.target_pairs || '0') || 0;
      if (!targetPairs) return res.redirect('/admin/offers/edit/' + id + '?err=Target%20pairs%20required');
    } else if (category === 'repurchase') {
      targetBv = parseInt(req.body.target_bv || '0') || 0;
      if (!targetBv) return res.redirect('/admin/offers/edit/' + id + '?err=Target%20BV%20required');
    } else if (category === 'leadership') {
      targetAmount = parseFloat(req.body.target_amount || '0') || 0;
      if (!targetAmount) return res.redirect('/admin/offers/edit/' + id + '?err=Target%20amount%20required');
    }

    if (!name || !startDate) {
      return res.redirect('/admin/offers/edit/' + id + '?err=Name%20and%20dates%20required');
    }

    if (durationType === 'custom') {
      if (!customDays || customDays < 1) return res.redirect('/admin/offers/edit/' + id + '?err=Custom%20days%20required');
      const start = new Date(startDate);
      start.setDate(start.getDate() + customDays);
      endDate = start.toISOString().split('T')[0];
    }

    const durationLabel = durationType === 'weekly' ? 'Weekly (7 Days)' :
                          durationType === 'monthly' ? 'Monthly (30 Days)' :
                          'Custom (' + customDays + ' Days)';

    offer.name = name;
    offer.category = category;
    offer.duration_type = durationType;
    offer.custom_days = customDays || null;
    offer.duration_label = durationLabel;
    offer.type = durationType;
    offer.target_pairs = targetPairs;
    offer.target_bv = targetBv;
    offer.target_amount = targetAmount;
    offer.reward_amount = rewardAmount;
    offer.reward_product_name = rewardProductName || null;
    offer.reward_product_id = rewardProductId;
    offer.reward_tour = rewardTour || null;
    offer.start_date = startDate;
    offer.end_date = endDate;
    offer.is_active = isActive;

    saveDB(db);

    // Re-process achievements so users who qualify get records
    processOfferAchievements(offer.id);

    return res.redirect('/admin/offers?msg=Offer%20updated%20successfully');
  } catch (e) {
    console.error('Update offer error:', e);
    return res.redirect('/admin/offers?err=Failed%20to%20update%20offer');
  }
});

app.get('/admin/offer-targets', requireAuth('admin'), (req, res) => {
  const offers = (db.offers || []).filter(o => o.is_active);
  const selectedOfferId = req.query.offer_id ? parseInt(req.query.offer_id) : null;
  const search = (req.query.search || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 100;

  let progressData = [];
  let selectedOffer = null;

  if (selectedOfferId) {
    selectedOffer = offers.find(o => o.id === selectedOfferId);
    if (selectedOffer) {
      const periodStart = selectedOffer.start_date + 'T00:00:00.000+05:30';
      const periodEnd = selectedOffer.end_date + 'T23:59:59.999Z';

      let users = (db.users || []).filter(u => u.status === 'active');
      if (search) {
        users = users.filter(u =>
          String(u.user_code || '').toLowerCase().includes(search) ||
          (u.member_name || String(u.username || '')).toLowerCase().includes(search)
        );
      }

      progressData = users.map(u => {
        const legData = calculateLeftRightPairsInPeriod(u.id, periodStart, periodEnd);
        const targetPairs = selectedOffer.target_pairs || 0;
        const pairs = Math.min(legData.left, legData.right);
        return {
          id: u.id,
          user_code: u.user_code,
          member_name: u.member_name || u.username || '',
          left_pairs: legData.left,
          right_pairs: legData.right,
          pairs,
          target_pairs: targetPairs,
          remaining: Math.max(0, targetPairs - pairs),
          percentage: targetPairs > 0 ? Math.min(100, Math.round((pairs / targetPairs) * 100)) : 0,
          achieved: pairs >= targetPairs
        };
      }).sort((a, b) => b.pairs - a.pairs || a.user_code.localeCompare(b.user_code));

      const totalUsers = progressData.length;
      const totalPages = Math.max(1, Math.ceil(totalUsers / perPage));
      const startIdx = (page - 1) * perPage;
      progressData = progressData.slice(startIdx, startIdx + perPage);

      res.render('admin_offer_targets', {
        offers,
        selectedOfferId,
        selectedOffer,
        progressData,
        search,
        page,
        totalPages,
        totalUsers,
        error: null,
        success: null
      });
      return;
    }
  }

  res.render('admin_offer_targets', {
    offers,
    selectedOfferId,
    selectedOffer: null,
    progressData: [],
    search,
    page: 1,
    totalPages: 1,
    totalUsers: 0,
    error: selectedOfferId ? 'Offer not found' : null,
    success: null
  });
});

app.get('/admin/offer-achievements', requireAuth('admin'), (req, res) => {
  const offerId = req.query.offer_id ? parseInt(req.query.offer_id) : null;
  const status = req.query.status || '';

  let achievements = (db.offer_achievements || []).slice().reverse();

  if (offerId) {
    achievements = achievements.filter(a => a.offer_id === offerId);
  }

  if (status) {
    achievements = achievements.filter(a => a.status === status);
  }

  // Enrich with user and offer details
  const enriched = achievements.map(a => {
    const user = getUserById(a.user_id);
    const offer = (db.offers || []).find(o => o.id === a.offer_id);
    return {
      ...a,
      user_name: user ? (user.member_name || user.username) : 'Unknown',
      user_code: user ? (user.user_code || '') : '',
      offer_name: offer ? offer.name : 'Unknown Offer',
      offer_display_id: offer ? ('OFR-' + String(offer.id).padStart(4, '0')) : '',
      offer_category: offer ? (offer.category || 'pairs') : 'pairs',
      target_value: offer ? (offer.target_pairs || offer.target_bv || offer.target_amount || 0) : 0
    };
  });

  const offers = db.offers || [];

  res.render('admin_offer_achievements', {
    achievements: enriched,
    offers,
    filter_offer: offerId,
    filter_status: status,
    success: req.query.msg || null,
    error: req.query.err || null
  });
});

app.post('/admin/offer-achievements/:id/pay', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const achievement = (db.offer_achievements || []).find(a => a.id === id);

    if (!achievement) {
      return res.redirect('/admin/offer-achievements?err=Achievement%20not%20found');
    }

    if (achievement.status === 'paid') {
      return res.redirect('/admin/offer-achievements?err=Already%20paid');
    }

    if (achievement.status !== 'pending' && achievement.status !== 'claimed') {
      return res.redirect('/admin/offer-achievements?err=Invalid%20status');
    }

    achievement.status = 'paid';
    achievement.paid_at = DateTime.now().setZone('Asia/Kolkata').toISO();

    saveDB(db);
    return res.redirect('/admin/offer-achievements?msg=Payment%20marked%20as%20complete');
  } catch (e) {
    return res.redirect('/admin/offer-achievements?err=Failed%20to%20update%20payment');
  }
});

app.get('/admin/star-winners', requireAuth('admin'), (req, res) => {
  // Pull from both users.rank_name AND celebrations (backup source)
  const swUserIds = new Set();
  const starWinners = [];

  // From users table
  (db.users || []).filter(u => u.role === 'user' && getDynamicRank(u) === 'STAR WINNER').forEach(u => {
    swUserIds.add(u.id);
    const directJoins = getDirectJoinsWithin7Days(u.id);
    const leftJoinsCount = directJoins.joins.filter(j => j.placement_side === 'left').length;
    const rightJoinsCount = directJoins.joins.filter(j => j.placement_side === 'right').length;
    starWinners.push({
      id: u.id,
      user_code: u.user_code || '',
      member_name: u.member_name || '',
      username: u.username,
      created_at: u.created_at,
      rank_name: u.rank_name,
      rank_updated_at: u.rank_updated_at || '',
      source: 'rank',
      direct_joins_count: directJoins.count,
      direct_joins: directJoins.joins,
      left_joins_count: leftJoinsCount,
      right_joins_count: rightJoinsCount
    });
  });

  // From celebrations (for users who lost rank_name but have celebration entry)
  (db.celebrations || []).filter(c => c.rank_achieved === 'STAR WINNER' && !swUserIds.has(c.user_id)).forEach(c => {
    const u = getUserById(c.user_id);
    swUserIds.add(c.user_id);
    starWinners.push({
      id: c.user_id,
      user_code: u ? (u.user_code || '') : (c.user_code || ''),
      member_name: u ? (u.member_name || '') : (c.member_name || ''),
      username: u ? (u.username || '') : '',
      created_at: u ? (u.created_at || '') : '',
      rank_name: 'STAR WINNER',
      rank_updated_at: c.celebration_date || '',
      source: 'celebration',
      direct_joins_count: 0,
      direct_joins: [],
      left_joins_count: 0,
      right_joins_count: 0
    });
  });

  starWinners.sort((a, b) => new Date(b.rank_updated_at) - new Date(a.rank_updated_at));

  res.render('admin_star_winners', {
    starWinners,
    error: null,
    success: null
  });
});

app.get('/admin/users/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.status(404).send('User not found');
  user.rank_name = getDynamicRank(user);
  const leader = user.leader_ref ? getUserByRef(user.leader_ref) : null;
  res.render('admin_user_edit', { user, leader, error: req.query.err || null, success: req.query.msg || null, req });
});

app.get('/admin/users/:id/kyc', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.status(404).send('User not found');
  user.rank_name = getDynamicRank(user);
  res.render('admin_kyc_review', { user, error: null, success: null });
});

app.post('/admin/users/:id/kyc', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.status(404).send('User not found');
  user.rank_name = getDynamicRank(user);
  const decision = String(req.body.kyc_status || '').trim();
  const remarks = String(req.body.kyc_remarks || '').trim();
  if (!decision || !['verified', 'rejected'].includes(decision)) {
    return res.render('admin_kyc_review', { user, error: 'Select a valid decision', success: null });
  }
  user.kyc_status = decision;
  user.kyc_remarks = remarks || null;
  user.kyc_verified_by = req.session.user.username || 'admin';
  user.kyc_verified_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  res.render('admin_kyc_review', { user, error: null, success: 'KYC ' + decision });
});

app.get('/admin/kyc-pending', requireAuth('admin'), (req, res) => {
  const users = db.users.filter(u => u.role === 'user' && (u.kyc_status || '').toLowerCase() === 'submitted');
  res.render('admin_kyc_pending', { users, success: req.query.msg || null, error: req.query.err || null });
});

app.get('/admin/api/kyc-pending-count', requireAuth('admin'), (req, res) => {
  const count = db.users.filter(u => u.role === 'user' && (u.kyc_status || '').toLowerCase() === 'submitted').length;
  res.json({ count });
});

app.get('/admin/tax', requireAuth('admin'), (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
  const settings = db.settings || {};
  const tdsPct = settings.tds_percent || 2;
  const adminPct = settings.admin_charge_percent || 10;
  const earnings = (db.earnings || []).filter(e => {
    if (startISO && e.created_at < startISO) return false;
    if (endISO && e.created_at > endISO) return false;
    return true;
  });

  // Group earnings by user
  const userTaxMap = new Map();
  earnings.forEach(e => {
    const userId = e.user_id;
    const user = getUserById(userId);
    if (!user) return;

    if (!userTaxMap.has(userId)) {
      userTaxMap.set(userId, {
        user_id: userId,
        username: user.username,
        member_name: user.member_name,
        user_code: user.user_code,
        total_gross: 0,
        total_tds: 0,
        total_admin: 0,
        total_earnings: 0,
        count: 0
      });
    }
    const entry = userTaxMap.get(userId);
    const gross = e.gross_inr || e.amount_inr || 0;
    const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * (tdsPct / 100) * 100) / 100;
    const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * (adminPct / 100) * 100) / 100;
    entry.total_gross += gross;
    entry.total_tds += tds;
    entry.total_admin += admin;
    entry.total_earnings += (e.amount_inr || 0);
    entry.count += 1;
  });

  const userTaxData = Array.from(userTaxMap.values()).sort((a, b) => b.total_tds - a.total_tds);

  // Calculate totals from earnings (use stored values or calculate from gross)
  let totalTDS = 0;
  let totalAdmin = 0;
  let totalGross = 0;
  earnings.forEach(e => {
    const gross = e.gross_inr || e.amount_inr || 0;
    totalGross += gross;
    const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * (tdsPct / 100) * 100) / 100;
    const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * (adminPct / 100) * 100) / 100;
    totalTDS += tds;
    totalAdmin += admin;
  });

  res.render('admin_tax', {
    from, to,
    total_gross: totalGross,
    total_tds: totalTDS,
    total_admin: totalAdmin,
    user_tax_data: userTaxData,
    tds_percent: tdsPct,
    admin_percent: adminPct,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// Tax Report Download
app.get('/admin/tax/download', requireAuth('admin'), (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
  const settings = db.settings || {};
  const tdsPct = settings.tds_percent || 2;
  
  const earnings = (db.earnings || []).filter(e => {
    if (startISO && e.created_at < startISO) return false;
    if (endISO && e.created_at > endISO) return false;
    return true;
  });

  const userTaxMap = new Map();
  earnings.forEach(e => {
    const userId = e.user_id;
    const user = getUserById(userId);
    if (!user) return;

    if (!userTaxMap.has(userId)) {
      userTaxMap.set(userId, {
        user_id: userId,
        member_name: user.member_name,
        user_code: user.user_code,
        kyc_pan: user.kyc_pan || '',
        total_tds: 0,
        count: 0
      });
    }
    const entry = userTaxMap.get(userId);
    const gross = e.gross_inr || e.amount_inr || 0;
    const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * (tdsPct / 100) * 100) / 100;
    entry.total_tds += tds;
    entry.count += 1;
  });

  const csvHeader = 'User Code,Member Name,PAN Number,Total TDS,Transactions\n';
  const csvRows = Array.from(userTaxMap.values()).map(u => 
    `${u.user_code || ''},${u.member_name || ''},${u.kyc_pan || ''},${u.total_tds.toFixed(2)},${u.count}`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=tax_report_${from || 'all'}_${to || 'all'}.csv`);
  res.send(csvHeader + csvRows);
});

// Per-User Tax Breakdown Excel Download
app.get('/admin/tax/user/:id/download', requireAuth('admin'), (req, res) => {
  const userId = parseInt(req.params.id);
  const user = getUserById(userId);
  if (!user) return res.redirect('/admin/tax?err=User+not+found');

  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
  const settings = db.settings || {};
  const tdsPct = settings.tds_percent || 2;
  const adminPct = settings.admin_charge_percent || 10;

  let earnings = (db.earnings || []).filter(e => {
    if (e.user_id !== userId) return false;
    if (startISO && e.created_at < startISO) return false;
    if (endISO && e.created_at > endISO) return false;
    return true;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const rows = earnings.map(e => {
    const gross = e.gross_inr || e.amount_inr || 0;
    const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * (tdsPct / 100) * 100) / 100;
    const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * (adminPct / 100) * 100) / 100;
    return {
      'Date': e.created_at ? new Date(e.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      'Earning Type': e.type || '',
      'Gross Amount (₹)': gross,
      'TDS (₹)': tds,
      'Admin Charge (₹)': admin,
      'Net Amount (₹)': e.amount_inr || 0,
      'Description': e.description || ''
    };
  });

  let totalGross = 0, totalTDS = 0, totalAdmin = 0, totalNet = 0;
  earnings.forEach(e => {
    const gross = e.gross_inr || e.amount_inr || 0;
    const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * (tdsPct / 100) * 100) / 100;
    const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * (adminPct / 100) * 100) / 100;
    totalGross += gross;
    totalTDS += tds;
    totalAdmin += admin;
    totalNet += (e.amount_inr || 0);
  });

  rows.push({});
  rows.push({
    'Date': 'TOTAL',
    'Gross Amount (₹)': totalGross,
    'TDS (₹)': totalTDS,
    'Admin Charge (₹)': totalAdmin,
    'Net Amount (₹)': totalNet
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  ws['!cols'] = [
    { wch: 14 }, { wch: 20 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 30 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Tax Breakdown');

  const summaryData = [
    { 'Field': 'User Code', 'Value': user.user_code || '' },
    { 'Field': 'Member Name', 'Value': user.member_name || '' },
    { 'Field': 'PAN Number', 'Value': user.kyc_pan || '-' },
    { 'Field': 'Date Range', 'Value': `${from || 'All'} to ${to || 'All'}` },
    { 'Field': 'Total Transactions', 'Value': earnings.length },
    { 'Field': 'Total Gross (₹)', 'Value': totalGross },
    { 'Field': 'Total TDS (₹)', 'Value': totalTDS },
    { 'Field': 'Total Admin Charge (₹)', 'Value': totalAdmin },
    { 'Field': 'Total Net (₹)', 'Value': totalNet }
  ];
  const ws2 = XLSX.utils.json_to_sheet(summaryData);
  ws2['!cols'] = [{ wch: 22 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'User Summary');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = `tax_${(user.user_code || userId)}_${from || 'all'}_${to || 'all'}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buf);
});

// Tax Report - User Details
app.get('/admin/tax/user/:id', requireAuth('admin'), (req, res) => {
  const userId = parseInt(req.params.id);
  const user = getUserById(userId);
  if (!user) return res.redirect('/admin/tax?err=User+not+found');
  
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
  
  let earnings = (db.earnings || []).filter(e => {
    if (e.user_id !== userId) return false;
    if (startISO && e.created_at < startISO) return false;
    if (endISO && e.created_at > endISO) return false;
    return true;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  user.rank_name = getDynamicRank(user);
  res.render('admin_tax_user_earnings', {
    user,
    from,
    to,
    earnings,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// GST Bills / Invoices
app.get('/admin/gst-bills', requireAuth('admin'), (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
  
  let invoices = (db.invoices || []).slice().reverse();
  // Deduplicate by invoice_no
  const seen = new Set();
  invoices = invoices.filter(inv => {
    if (seen.has(inv.invoice_no)) return false;
    seen.add(inv.invoice_no);
    return true;
  });
  if (startISO) invoices = invoices.filter(inv => inv.created_at >= startISO);
  if (endISO) invoices = invoices.filter(inv => inv.created_at <= endISO);
  
  const totalGST = invoices.reduce((s, inv) => s + (inv.gst_inr || 0), 0);
  const totalAmount = invoices.reduce((s, inv) => s + (inv.total_inr || 0), 0);
  
  const success = req.query.deleted ? 'Invoice deleted successfully' : null;
  
  res.render('admin_gst_bills', {
    invoices,
    from,
    to,
    total_gst: totalGST,
    total_amount: totalAmount,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    getUserById: getUserById,
    getFranchiseById: getFranchiseById,
    success,
    db
  });
});

// View Single Invoice
app.get('/admin/invoice/:invoiceNo', requireAuth('admin'), (req, res) => {
  const invoiceNo = req.params.invoiceNo;
  const invoice = (db.invoices || []).find(inv => inv.invoice_no === invoiceNo);
  
  if (!invoice) {
    return res.status(404).send('Invoice not found');
  }
  
  const user = getUserById(invoice.user_id);
  const franchise = invoice.franchise_id ? getUserById(invoice.franchise_id) : null;
  const prod = (db.products || []).find(p => p.id === invoice.product_id) || null;
  const settings = getSettingsRow();
  
  res.render('admin_invoice_view', {
    invoice,
    user,
    franchise,
    products: db.products || [],
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    product_code: prod ? (prod.product_code || prod.code || '') : '',
    hsn_code: prod ? (prod.hsn_code || '') : '',
    amount_words: inrToWords(invoice.total_inr || 0),
    company_gstin: settings && settings.company_gstin ? settings.company_gstin : '',
    company_name: settings && settings.company_name ? settings.company_name : 'Nastige Industries Pvt. Ltd.',
    company_address: settings && settings.company_address ? settings.company_address : '',
    company_phone: settings && settings.company_phone ? settings.company_phone : '',
    company_email: settings && settings.company_email ? settings.company_email : '',
    gst_type: settings && settings.gst_type ? settings.gst_type : 'inclusive'
  });
});

app.post('/admin/invoice/:invoiceNo/delete', requireAuth('admin'), (req, res) => {
  try {
    const invoiceNo = req.params.invoiceNo;
    const invoice = (db.invoices || []).find(inv => inv.invoice_no === invoiceNo);
    
    if (!invoice) {
      return res.status(404).send('Invoice not found');
    }
    
    console.log('[DELETE INVOICE] Starting full rollback for invoice:', invoiceNo);
    
    // ===== STEP 1: Find associated order =====
    const orderId = invoice.order_id;
    const order = orderId ? (db.orders || []).find(o => o.id === orderId) : null;
    
    // ===== STEP 2: Find user and franchise =====
    const userId = invoice.user_id || (order ? order.user_id : null);
    const user = userId ? getUserById(userId) : null;
    const franchiseId = invoice.franchise_id || (order ? order.franchise_id : null);
    const franchise = franchiseId ? getFranchiseById(franchiseId) : null;
    const pinCode = invoice.pin_code || (order ? order.activation_pin : null);
    const pin = pinCode ? (db.pin_packages || []).find(p => p.code === pinCode) : null;
    
    // ===== STEP 3: Calculate BV to reverse =====
    let bvToReverse = 0;
    if (invoice.total_bv) {
      bvToReverse = invoice.total_bv;
    } else if (order && order.total_bv) {
      bvToReverse = order.total_bv;
    } else if (pin) {
      // Calculate BV from PIN's products
      if (pin.plan_id) {
        const plan = (db.plans || []).find(pl => pl.id === pin.plan_id);
        const ids = Array.isArray(pin.product_ids) ? pin.product_ids : (plan ? [plan.product_id] : []);
        ids.forEach(pid => {
          const pd = (db.products || []).find(p => p.id === pid);
          if (pd) bvToReverse += (pd.bv || 0);
        });
      } else if (pin.product_id) {
        const pd = (db.products || []).find(p => p.id === pin.product_id);
        if (pd) bvToReverse = pd.bv || 0;
      }
    }
    
    // ===== STEP 4: Reverse BV from user and ancestors =====
    if (user && bvToReverse > 0) {
      console.log('[DELETE INVOICE] Reversing BV:', bvToReverse, 'from user:', user.user_code);
      
      // Subtract from user's PV
      user.pv = Math.max(0, (user.pv || 0) - bvToReverse);
      
      // Check if this was a repurchase order
      const isRepurchase = order && order.type === 'repurchase';
      
      // Reverse carry_left/carry_right from ancestors
      let current = user.placement_parent_id ? getUserById(user.placement_parent_id) : null;
      let prev = user;
      while (current) {
        if (current.left_id === prev.id) {
          if (isRepurchase) {
            current.repurchase_carry_left = Math.max(0, (current.repurchase_carry_left || 0) - bvToReverse);
          } else {
            current.carry_left = Math.max(0, (current.carry_left || 0) - bvToReverse);
          }
        } else if (current.right_id === prev.id) {
          if (isRepurchase) {
            current.repurchase_carry_right = Math.max(0, (current.repurchase_carry_right || 0) - bvToReverse);
          } else {
            current.carry_right = Math.max(0, (current.carry_right || 0) - bvToReverse);
          }
        }
        if (!current.placement_parent_id) break;
        prev = current;
        current = getUserById(current.placement_parent_id);
      }
      
      // Check if user should be deactivated (if PV dropped below threshold)
      const settings = db.settings || {};
      const requiredBV = settings.pv_on_join || 4000;
      if (user.pv < requiredBV && user.status === 'active') {
        // Only deactivate if this was an activation invoice
        const isActivationInvoice = pin && pin.used_by === user.id;
        if (isActivationInvoice) {
          user.status = 'inactive';
          user.active = false;
          user.activated_at = null;
          console.log('[DELETE INVOICE] User deactivated due to BV reversal');
        }
      }
    }
    
    // ===== STEP 5: Restore product stock =====
    if (order) {
      if (!franchise) {
        // Non-franchise orders: restore total_stock and sold_stock
        if (order.product_id) {
          const product = (db.products || []).find(p => p.id === order.product_id);
          if (product) {
            product.total_stock = (product.total_stock || 0) + (order.quantity || 1);
            product.sold_stock = Math.max(0, (product.sold_stock || 0) - (order.quantity || 1));
            console.log('[DELETE INVOICE] Restored product stock:', product.name);
          }
        }
        if (order.order_items && Array.isArray(order.order_items)) {
          order.order_items.forEach(item => {
            const product = (db.products || []).find(p => p.id === item.product_id);
            if (product) {
              product.total_stock = (product.total_stock || 0) + (item.qty || 1);
              product.sold_stock = Math.max(0, (product.sold_stock || 0) - (item.qty || 1));
              console.log('[DELETE INVOICE] Restored product stock:', product.name);
            }
          });
        }
      } else {
        // Franchise orders: just restore sold_stock (total_stock never decremented for franchise)
        if (order.product_id) {
          const product = (db.products || []).find(p => p.id === order.product_id);
          if (product) {
            product.sold_stock = Math.max(0, (product.sold_stock || 0) - (order.quantity || 1));
          }
        }
        if (order.order_items && Array.isArray(order.order_items)) {
          order.order_items.forEach(item => {
            const product = (db.products || []).find(p => p.id === item.product_id);
            if (product) {
              product.sold_stock = Math.max(0, (product.sold_stock || 0) - (item.qty || 1));
            }
          });
        }
      }
    }
    
    // ===== STEP 6: Restore franchise stock =====
    if (franchise && order) {
      if (!franchise.stock) franchise.stock = {};
      
      // Single product
      if (order.product_id) {
        const stockKey = 'p' + order.product_id;
        franchise.stock[stockKey] = (franchise.stock[stockKey] || 0) + (order.quantity || 1);
        console.log('[DELETE INVOICE] Restored franchise stock for product:', order.product_id);
      }
      // Multi-product
      if (order.order_items && Array.isArray(order.order_items)) {
        order.order_items.forEach(item => {
          const stockKey = 'p' + item.product_id;
          franchise.stock[stockKey] = (franchise.stock[stockKey] || 0) + (item.qty || 1);
        });
        console.log('[DELETE INVOICE] Restored franchise stock for multiple products');
      }
      
      // Restore franchise fund wallet (if it was a repurchase order)
      if (order.type === 'repurchase' && order.total_inr) {
        franchise.fund_wallet = (franchise.fund_wallet || 0) + order.total_inr;
        console.log('[DELETE INVOICE] Restored franchise fund wallet:', order.total_inr);
      }
    }
    
    // ===== STEP 7: Remove associated earnings =====
    if (user) {
      const earningsBefore = (db.earnings || []).length;
      const invoiceCreatedAt = order?.created_at || invoice.created_at;
      
      db.earnings = (db.earnings || []).filter(e => {
        // Remove binary earnings from this order
        if (e.user_id === user.id && (e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match') && e.created_at >= invoiceCreatedAt) {
          console.log('[DELETE INVOICE] Removing binary earning:', e.id);
          return false;
        }
        // Remove leadership bonus earnings related to this user/PIN
        if (pin && e.source_user_id === user.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)')) {
          console.log('[DELETE INVOICE] Removing leadership earning:', e.id);
          return false;
        }
        // Remove rank income - remove all rank income earned after invoice date
        if (e.user_id === user.id && (e.note === 'Rank income' || e.note === 'Star Winner rank income') && e.created_at >= invoiceCreatedAt) {
          console.log('[DELETE INVOICE] Removing rank income earning:', e.id, 'Amount:', e.amount_inr);
          // Reverse the rank income amount from user's wallet if applicable
          if (e.amount_inr) {
            user.wallet = Math.max(0, (user.wallet || 0) - e.amount_inr);
            console.log('[DELETE INVOICE] Reversed rank income from wallet:', e.amount_inr);
          }
          return false;
        }
        return true;
      });
      console.log('[DELETE INVOICE] Removed', earningsBefore - (db.earnings || []).length, 'earnings');
    }
    
    // ===== STEP 8: Remove associated payouts =====
    if (user) {
      const payoutsBefore = (db.payouts || []).length;
      db.payouts = (db.payouts || []).filter(p => {
        if (p.user_id === user.id && p.created_at >= (order?.created_at || invoice.created_at)) {
          console.log('[DELETE INVOICE] Removing payout:', p.id);
          return false;
        }
        return true;
      });
      console.log('[DELETE INVOICE] Removed', payoutsBefore - (db.payouts || []).length, 'payouts');
    }
    
    // ===== STEP 9: Reverse franchise commission =====
    if (franchise) {
      // Find and remove commission transactions related to this order/invoice
      const txnsBefore = (db.franchise_transactions || []).length;
      db.franchise_transactions = (db.franchise_transactions || []).filter(t => {
        if (t.franchise_id === franchise.id && t.order_id === orderId) {
          // Reverse commission from wallet
          if (t.type === 'commission' && t.amount) {
            franchise.commission_wallet = Math.max(0, (franchise.commission_wallet || 0) - t.amount);
            console.log('[DELETE INVOICE] Reversed franchise commission:', t.amount);
          }
          return false;
        }
        return true;
      });
      
      // Also remove from franchise's commission_history
      if (franchise.commission_history) {
        franchise.commission_history = franchise.commission_history.filter(h => h.order_id !== orderId);
      }
      
      console.log('[DELETE INVOICE] Removed', txnsBefore - (db.franchise_transactions || []).length, 'franchise transactions');
    }
    
    // ===== STEP 10: Remove franchise stock history =====
    if (franchise) {
      const stockHistBefore = (db.franchise_stock_history || []).length;
      db.franchise_stock_history = (db.franchise_stock_history || []).filter(h => {
        if (h.franchise_id === franchise.id && h.note && h.note.includes(invoiceNo)) {
          return false;
        }
        if (h.franchise_id === franchise.id && orderId && h.note && h.note.includes('ORD' + String(orderId).padStart(4, '0'))) {
          return false;
        }
        return true;
      });
      console.log('[DELETE INVOICE] Removed', stockHistBefore - (db.franchise_stock_history || []).length, 'stock history entries');
    }
    
    // ===== STEP 11: Reset PIN if it was used for this activation =====
    if (pin && pin.used_by === userId) {
      pin.used_by = null;
      pin.used_at = null;
      pin.status = 'unused';
      console.log('[DELETE INVOICE] Reset PIN:', pin.code);
    }
    
    // ===== STEP 12: Remove the order =====
    if (order) {
      db.orders = (db.orders || []).filter(o => o.id !== orderId);
      console.log('[DELETE INVOICE] Removed order:', orderId);
    }
    
    // ===== STEP 13: Remove the invoice =====
    db.invoices = (db.invoices || []).filter(inv => inv.invoice_no !== invoiceNo);
    console.log('[DELETE INVOICE] Removed invoice:', invoiceNo);
    
    // ===== STEP 13B: Recalculate invoice sequence so deleted number is reused =====
    const yearNow = DateTime.now().setZone('Asia/Kolkata').year;
    const remainingInvs = (db.invoices || []).filter(inv => {
      const m = String(inv.invoice_no || '').match(/INV(\d+)(\d{5})/);
      return m && parseInt(m[1], 10) === yearNow;
    });
    let maxSeq = 0;
    remainingInvs.forEach(inv => {
      const m = String(inv.invoice_no).match(/INV(\d+)(\d{5})/);
      if (m) {
        const s = parseInt(m[2], 10);
        if (s > maxSeq) maxSeq = s;
      }
    });
    db.counters.invoice_seq = maxSeq;
    console.log('[DELETE INVOICE] Invoice sequence reset to:', maxSeq, '- Next will be: INV' + yearNow + String(maxSeq + 1).padStart(5, '0'));
    
    // ===== STEP 14: Update user ranks =====
    if (user) {
      updateUserRank(user.id);
      let current = user.placement_parent_id ? getUserById(user.placement_parent_id) : null;
      while (current) {
        updateUserRank(current.id);
        if (!current.placement_parent_id) break;
        current = getUserById(current.placement_parent_id);
      }
    }
    
    // ===== SAVE =====
    saveDB(db);
    console.log('[DELETE INVOICE] Full rollback completed successfully');
    
    res.redirect('/admin/gst-bills?deleted=1&msg=' + encodeURIComponent('Invoice ' + invoiceNo + ' deleted with full rollback'));
  } catch (e) {
    console.error('[DELETE INVOICE] Error:', e);
    res.redirect('/admin/gst-bills?error=' + encodeURIComponent('Delete failed: ' + e.message));
  }
});

function generateInvoiceNumber(newInvoices) {
  if (!db.counters) db.counters = {};
  if (!db.counters.invoice_seq) db.counters.invoice_seq = 0;
  db.counters.invoice_seq++;
  saveDB(db); // Save immediately after increment
  const year = DateTime.now().setZone('Asia/Kolkata').year;
  return 'INV' + year + String(db.counters.invoice_seq).padStart(5, '0');
}

// Generate franchise order number: F{franchise_code}{seq}
function generateFranchiseOrderNumber(franchiseId) {
  if (!db.counters) db.counters = {};
  if (!db.counters.franchise_orders) db.counters.franchise_orders = {};
  const franchise = (db.franchises || []).find(f => f.id === parseInt(franchiseId));
  const code = franchise ? franchise.franchise_code : 'FR' + franchiseId;
  if (!db.counters.franchise_orders[code]) db.counters.franchise_orders[code] = 0;
  db.counters.franchise_orders[code]++;
  saveDB(db); // Save immediately after increment to prevent gaps
  return 'F' + code.replace('FR', '') + String(db.counters.franchise_orders[code]).padStart(3, '0');
}

function generateInvoiceForPin(pin) {
  try {

    
      const existingInvoice = (db.invoices || []).find(inv => inv.pin_code === pin.code);
    if (existingInvoice) {
      return null;
    }

    // Handle different pin types:
    // 1. db.pins (admin route) - has product_name
    // 2. db.pin_packages (self-activation) - has product_id OR plan_id + product_ids
    
    let invoices = [];
    
    if (pin.product_name) {
      // Legacy db.pins format - product by name
      const product = (db.products || []).find(p => p.name === pin.product_name) || null;

      if (!product) return null;
      
      const totalInr = product.selling_price_inr || product.price_inr || product.mrp_inr || 0;
      const gstPercent = product.gst_percent || 0;
      const gstInr = totalInr * (gstPercent / (100 + gstPercent));
      const priceInr = totalInr - gstInr;
      const invoiceNo = generateInvoiceNumber([]);
      const orderNo = pin.assigned_to ? generateFranchiseOrderNumber(pin.assigned_to) : '';
      
      invoices.push({
        id: (db.invoices || []).length + 1,
        invoice_no: invoiceNo,
        order_no: orderNo,
        user_id: pin.used_by,
        franchise_id: pin.assigned_to ? parseInt(pin.assigned_to) : null,
        product_id: product.id,
        product_name: product.name,
        hsn_code: product.hsn_code || '',
        quantity: 1,
        price_inr: priceInr,
        gst_percent: gstPercent,
        gst_inr: gstInr,
        total_inr: totalInr,
        pin_code: pin.code,
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
      
    } else if (pin.plan_id && pin.product_ids) {
      // Plan pin - create single invoice with all products as line items
      const plan = (db.plans || []).find(pl => pl.id === pin.plan_id) || null;
      const ids = Array.isArray(pin.product_ids) ? pin.product_ids.slice() : [];
      const planTotal = parseFloat((plan && plan.amount_inr) || 0) || 0;
      const prodList = ids.map(id => (db.products || []).find(pr => pr.id === id)).filter(Boolean);
      

      
      if (prodList.length === 0) return null;
      
      const n = prodList.length || 1;
      let accum = 0;
      let items = [];
      let totalBV = 0;
      
      // Calculate each product's share and create line items with full details
      prodList.forEach((product, idx) => {
        const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
        accum += share;
        totalBV += (product.bv || 0);

        const totalInr = share; // For plan products, the share is the total inclusive amount
        const gstPercent = product.gst_percent || 0;
        const gstInr = totalInr * (gstPercent / (100 + gstPercent));
        const priceInr = totalInr - gstInr;
        
        items.push({
          product_id: product.id,
          product_code: product.product_code || product.code || '',
          product_name: product.name,
          hsn_code: product.hsn_code || '',
          quantity: 1,
          unit_price: product.selling_price_inr || product.mrp_inr || 0,
          price_inr: priceInr,
          gst_percent: gstPercent,
          gst_inr: gstInr,
          cgst: gstInr / 2,
          sgst: gstInr / 2,
          total_inr: totalInr,
          bv: product.bv || 0
        });
      });
      
      // Create single invoice with all items
      const invoiceNo = generateInvoiceNumber(invoices);
      const orderNo = pin.assigned_to ? generateFranchiseOrderNumber(pin.assigned_to) : '';
      invoices.push({
        id: (db.invoices || []).length + 1,
        invoice_no: invoiceNo,
        order_no: orderNo,
        user_id: pin.used_by,
        franchise_id: pin.assigned_to ? parseInt(pin.assigned_to) : null,
        product_id: prodList[0].id,
        product_name: prodList.map(p => p.name).join(' + '),
        hsn_code: prodList.map(p => p.hsn_code).filter(Boolean).join(', '),
        quantity: prodList.length,
        price_inr: items.reduce((s, i) => s + i.price_inr, 0),
        gst_percent: 0, // Mixed GST
        gst_inr: items.reduce((s, i) => s + i.gst_inr, 0),
        cgst: items.reduce((s, i) => s + i.cgst, 0),
        sgst: items.reduce((s, i) => s + i.sgst, 0),
        total_inr: planTotal,
        total_bv: totalBV,
        plan_name: plan ? plan.name : '',
        items: items,
        pin_code: pin.code,
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
      
    } else {
      // Single product PIN (product_id only, no plan_id or product_name)
      const product = pin.product_id ? (db.products || []).find(p => p.id === pin.product_id) : null;
      if (!product) {
        console.log('[DEBUG] Invalid pin format - no product_id, plan_id, or product_name');
        return null;
      }
      
      const totalInr = product.selling_price_inr || product.mrp_inr || 0;
      const gstPercent = product.gst_percent || 0;
      const gstInr = totalInr * (gstPercent / (100 + gstPercent));
      const priceInr = totalInr - gstInr;
      const invoiceNo = generateInvoiceNumber([]);
      const orderNo = pin.assigned_to ? generateFranchiseOrderNumber(pin.assigned_to) : '';
      
      invoices.push({
        id: (db.invoices || []).length + 1,
        invoice_no: invoiceNo,
        order_no: orderNo,
        user_id: pin.used_by,
        franchise_id: pin.assigned_to ? parseInt(pin.assigned_to) : null,
        product_id: product.id,
        product_name: product.name,
        hsn_code: product.hsn_code || '',
        quantity: 1,
        unit_price: product.selling_price_inr || product.mrp_inr || 0,
        price_inr: priceInr,
        gst_percent: gstPercent,
        gst_inr: gstInr,
        cgst: gstInr / 2,
        sgst: gstInr / 2,
        total_inr: totalInr,
        total_bv: product.bv || 0,
        pin_code: pin.code,
        items: [{
          product_id: product.id,
          product_code: product.product_code || product.code || '',
          product_name: product.name,
          hsn_code: product.hsn_code || '',
          quantity: 1,
          unit_price: product.selling_price_inr || product.mrp_inr || 0,
          price_inr: priceInr,
          gst_percent: gstPercent,
          gst_inr: gstInr,
          cgst: gstInr / 2,
          sgst: gstInr / 2,
          total_inr: totalInr,
          bv: product.bv || 0
        }],
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
    }
    

    // Save all invoices
    if (!db.invoices) db.invoices = [];
    db.invoices.push(...invoices);
    saveDB(db);
    
    // Return first invoice (for backward compatibility)
    return invoices[0];
    
  } catch (error) {
    console.error('Error generating invoice for pin:', pin.code, error);
    return null;
  }
}

// Safety aliases for common typos/variants - only for non-existent paths (no redirect loop)
// Removed /admin/Transactions redirect as it was causing redirect loop with /admin/transactions

const uploadAdminKyc = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => {
      const uid = parseInt(req.params.id);
      const dest = path.join(UPLOAD_DIR, String(uid));
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `${file.fieldname}_${ts}${ext}`);
    },
    quality: 92,
    maxWidth: 2000,
    maxHeight: 2000,
    autoRotate: true
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp','application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only images and PDF allowed'), allowed.includes(file.mimetype));
  }
});

app.post('/admin/users/:id/kyc-update-details', requireAuth('admin'), uploadAdminKyc.fields([
  { name: 'pan_file_admin', maxCount: 1 },
  { name: 'aadhaar_front_admin', maxCount: 1 },
  { name: 'aadhaar_back_admin', maxCount: 1 },
  { name: 'bank_passbook_admin', maxCount: 1 },
  { name: 'selfie_admin', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  if ('member_name' in req.body) { user.member_name = (req.body.member_name || '').trim().toUpperCase() || null; }
  if ('email' in req.body) { user.email = (req.body.email || '').trim() || null; }
  if ('phone' in req.body) { user.phone = (req.body.phone || '').trim() || null; }
  if ('kyc_pan' in req.body) {
    user.kyc_pan = (req.body.kyc_pan || '').trim().toUpperCase() || null;
    user.pan_number = user.kyc_pan;
  }
  if ('kyc_aadhaar' in req.body) {
    user.kyc_aadhaar = (req.body.kyc_aadhaar || '').trim().toUpperCase() || null;
    user.aadhar_number = user.kyc_aadhaar;
  }
  if ('bank_account_name' in req.body) { user.bank_account_name = (req.body.bank_account_name || '').trim().toUpperCase() || null; }
  if ('bank_account_number' in req.body) { user.bank_account_number = (req.body.bank_account_number || '').trim() || null; }
  if ('bank_name' in req.body) { user.bank_name = (req.body.bank_name || '').trim().toUpperCase() || null; }
  if ('bank_ifsc' in req.body) { user.bank_ifsc = (req.body.bank_ifsc || '').trim().toUpperCase() || null; }
  if ('bank_branch' in req.body) { user.bank_branch = (req.body.bank_branch || '').trim().toUpperCase() || null; }
  if ('upi_id' in req.body) { user.upi_id = (req.body.upi_id || '').trim().toUpperCase() || null; }
  if ('nominee_name' in req.body) { user.nominee_name = (req.body.nominee_name || '').trim().toUpperCase() || null; }
  if ('nominee_relation' in req.body) { user.nominee_relation = (req.body.nominee_relation || '').trim().toUpperCase() || null; }
  if ('nominee_mobile' in req.body) { user.nominee_mobile = (req.body.nominee_mobile || '').trim() || null; }
  if ('nominee_aadhar' in req.body) { user.nominee_aadhar = (req.body.nominee_aadhar || '').trim().toUpperCase() || null; }
  if ('nominee_dob' in req.body) { user.nominee_dob = (req.body.nominee_dob || '').trim() || null; }
  try {
    const relBase = path.join('/uploads', 'kyc', String(user.id));
    if (req.files && req.files.pan_file_admin && req.files.pan_file_admin[0]) {
      user.kyc_pan_file = path.join(relBase, req.files.pan_file_admin[0].filename).replace(/\\/g, '/');
    }
    if (req.files && req.files.aadhaar_front_admin && req.files.aadhaar_front_admin[0]) {
      user.kyc_aadhaar_front_file = path.join(relBase, req.files.aadhaar_front_admin[0].filename).replace(/\\/g, '/');
    }
    if (req.files && req.files.aadhaar_back_admin && req.files.aadhaar_back_admin[0]) {
      user.kyc_aadhaar_back_file = path.join(relBase, req.files.aadhaar_back_admin[0].filename).replace(/\\/g, '/');
    }
    if (req.files && req.files.bank_passbook_admin && req.files.bank_passbook_admin[0]) {
      user.kyc_bank_passbook_file = path.join(relBase, req.files.bank_passbook_admin[0].filename).replace(/\\/g, '/');
    }
    if (req.files && req.files.selfie_admin && req.files.selfie_admin[0]) {
      user.kyc_selfie_file = path.join(relBase, req.files.selfie_admin[0].filename).replace(/\\/g, '/');
    }
  } catch (e) {
    console.error('Admin KYC file upload error:', e);
  }
  saveDB(db);
  res.render('admin_kyc_review', { user, error: null, success: 'KYC details updated successfully!' });
});

app.post('/admin/users/:id/kyc-decision', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.status(404).send('User not found');
  const action = String(req.body.action || '').toLowerCase();
  const note = String(req.body.note || '').trim();
  if (note) user.kyc_note = note;
  if (action === 'verify') user.kyc_status = 'verified';
  else if (action === 'reject') user.kyc_status = 'rejected';
  else user.kyc_status = 'pending';
  saveDB(db);
  res.render('admin_kyc_review', { user, error: null, success: 'KYC updated' });
});

app.post('/admin/users/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.status(404).send('User not found');
  user.rank_name = getDynamicRank(user);
  try {
    const currentLeader = user.leader_ref ? getUserByRef(user.leader_ref) : null;
    const nextUsername = (req.body.username || '').trim() || user.username;
    if (nextUsername !== user.username) {
      const exists = db.users.find(u => u.username === nextUsername && u.id !== user.id);
      if (exists) return res.render('admin_user_edit', { user, leader: currentLeader, error: 'Username already exists', success: null });
      user.username = nextUsername;
    }
    const np = req.body.new_password || '';
    const cp = req.body.confirm_password || '';
    if (np || cp) {
      if (np.length < 6) return res.render('admin_user_edit', { user, leader: currentLeader, error: 'Password must be at least 6 characters', success: null });
      if (np !== cp) return res.render('admin_user_edit', { user, leader: currentLeader, error: 'Passwords do not match', success: null });
      user.password_hash = bcrypt.hashSync(np, 10);
    }
    user.member_name = (req.body.member_name || '').trim().toUpperCase() || null;
    const newLeaderRef = (req.body.leader_ref || '').trim();
    const leader = newLeaderRef ? getUserByRef(newLeaderRef) : currentLeader;
    if (newLeaderRef !== '') {
      const leaderUser = getUserByRef(newLeaderRef);
      if (!leaderUser) return res.render('admin_user_edit', { user, leader: null, error: 'Leader ID not found', success: null });
      user.leader_ref = newLeaderRef;
    } else if ('leader_ref' in req.body) {
      user.leader_ref = null;
    }
    if ('address_line1' in req.body) { user.address_line1 = (req.body.address_line1 || '').trim().toUpperCase() || null; }
    if ('address_line2' in req.body) { user.address_line2 = (req.body.address_line2 || '').trim().toUpperCase() || null; }
    if ('city' in req.body) { user.city = (req.body.city || '').trim().toUpperCase() || null; }
    if ('state' in req.body) { user.state = (req.body.state || '').trim().toUpperCase() || null; }
    if ('pincode' in req.body) { user.pincode = (req.body.pincode || '').trim() || null; }
    if ('phone' in req.body) { user.phone = (req.body.phone || '').trim() || null; }
    if ('email' in req.body) { user.email = (req.body.email || '').trim() || null; }
    user.kyc_status = (req.body.kyc_status || '').trim() || user.kyc_status || 'pending';
    if ('bank_account_name' in req.body) { user.bank_account_name = (req.body.bank_account_name || '').trim().toUpperCase() || null; }
    if ('bank_account_number' in req.body) { user.bank_account_number = (req.body.bank_account_number || '').trim() || null; }
    if ('bank_ifsc' in req.body) { user.bank_ifsc = (req.body.bank_ifsc || '').trim().toUpperCase() || null; }
    if ('bank_name' in req.body) { user.bank_name = (req.body.bank_name || '').trim().toUpperCase() || null; }
    if ('bank_branch' in req.body) { user.bank_branch = (req.body.bank_branch || '').trim().toUpperCase() || null; }
    if ('upi_id' in req.body) { user.upi_id = (req.body.upi_id || '').trim().toUpperCase() || null; }
    if (req.body.pv !== undefined) user.pv = parseInt(req.body.pv || '0');
    if (req.body.org_bv_left !== undefined) user.org_bv_left = parseInt(req.body.org_bv_left || '0');
    if (req.body.org_bv_right !== undefined) user.org_bv_right = parseInt(req.body.org_bv_right || '0');
    if (req.body.org_rep_bv_left !== undefined) user.org_rep_bv_left = parseInt(req.body.org_rep_bv_left || '0');
    if (req.body.org_rep_bv_right !== undefined) user.org_rep_bv_right = parseInt(req.body.org_rep_bv_right || '0');
    if (req.body.carry_left !== undefined) user.carry_left = parseInt(req.body.carry_left || '0');
    if (req.body.carry_right !== undefined) user.carry_right = parseInt(req.body.carry_right || '0');
    if (req.body.repurchase_carry_left !== undefined) user.repurchase_carry_left = parseInt(req.body.repurchase_carry_left || '0');
    if (req.body.repurchase_carry_right !== undefined) user.repurchase_carry_right = parseInt(req.body.repurchase_carry_right || '0');
    if ('weekly_cap_pairs' in req.body) {
      const v2 = String(req.body.weekly_cap_pairs || '').trim();
      user.weekly_cap_pairs = v2 === '' ? null : (parseInt(v2) || 0);
    }
    saveDB(db);
    const updatedLeader = user.leader_ref ? getUserByRef(user.leader_ref) : null;
    res.render('admin_user_edit', { user, leader: updatedLeader, error: null, success: 'User updated' });
  } catch (e) {
    const currentLeader = user.leader_ref ? getUserByRef(user.leader_ref) : null;
    res.render('admin_user_edit', { user, leader: currentLeader, error: 'Failed to update user', success: null });
  }
});

app.post('/admin/users/:id/activate-with-pin', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users/' + id + '?err=User%20not%20found');
  if (user.status === 'active') return res.redirect('/admin/users/' + id + '?err=User%20is%20already%20active');

  const pkgCode = String(req.body.package_pin || '').trim();
  const loginCode = String(req.body.login_pin || '').trim();

  if (!pkgCode || !loginCode) {
    return res.redirect('/admin/users/' + id + '?err=Enter%20Package%20PIN%20and%20Login%20PIN');
  }

  // Find matching PIN
  const pin = (db.pin_packages || []).find(x => x.code === pkgCode && String(x.login_pin || '') === loginCode);
  if (!pin) return res.redirect('/admin/users/' + id + '?err=Invalid%20PIN%20combination');
  if (pin.used_by && pin.used_by !== user.id) return res.redirect('/admin/users/' + id + '?err=PIN%20already%20used%20by%20another%20user');

   try {
     const now = DateTime.now().setZone('Asia/Kolkata').toISO();
     // Mark PIN as used (if not already)
     if (!pin.used_by) {
       pin.used_by = user.id;
       pin.used_at = now;
       pin.status = 'used';
     }

    // Activate user
    user.status = 'active';
    user.active = true;
    user.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    user.activation_pin = pin.code;

     // Credit BV from associated plan/product to user AND upline chain
     let bvToCredit = 0;
     const productsToProcess = []; // Collect products for BV and stock deduction
     
     if (pin.plan_id) {
       const plan = (db.plans || []).find(pl => pl.id === pin.plan_id);
       if (plan) {
         user.plan_id = plan.id;
       }
       // Get BV from products
       const productIds = Array.isArray(pin.product_ids) ? pin.product_ids : [];
       if (productIds.length > 0) {
         productIds.forEach(prodId => {
           const prod = (db.products || []).find(p => p.id === prodId);
           if (prod) {
             bvToCredit += (prod.bv || 0);
             productsToProcess.push(prod);
           }
         });
       } else if (plan && plan.product_id) {
         const prod = (db.products || []).find(p => p.id === plan.product_id);
         if (prod) {
           bvToCredit += (prod.bv || 0);
           productsToProcess.push(prod);
         }
       }
     }
     // Also check pin.product_id directly
     if (bvToCredit === 0 && pin.product_id) {
       const prod = (db.products || []).find(p => p.id === pin.product_id);
       if (prod) {
         bvToCredit += (prod.bv || 0);
         productsToProcess.push(prod);
       }
     }
     
      // Skip stock deduction for matrix pins (no physical products)
      if (!pin.is_matrix_pin) {
        // Deduct stock for all products (from global inventory for admin activation)
        for (const prod of productsToProcess) {
          // Check if stock is available
          if ((prod.total_stock || 0) <= 0) {
            // Not enough stock - we could rollback, but for now just skip or error?
            // For consistency with other routes, let's prevent activation if no stock
            throw new Error(`Out of stock: ${prod.name || 'Product'}`);
          }
          // Deduct from global total stock
          prod.total_stock = (prod.total_stock || 0) - 1;
          // Update global sold stock
          prod.sold_stock = (prod.sold_stock || 0) + 1;
          prod.updated_at = now;
        }
      }

    if (bvToCredit > 0 && !pin.is_matrix_pin) {
      // creditPV will set user.pv AND distribute to upline chain
      creditPV(user.id, bvToCredit, 'activation');
    }

    // Update user's rank
    updateUserRank(user.id);

    // Matrix PIN: create auto users under target with left/right split
    if (pin.is_matrix_pin) {
      user.is_matrix_target = true;
      const leftCount = pin.left_count || 10;
      const rightCount = pin.right_count || 10;
      const plan = pin.plan_id ? (db.plans || []).find(pl => pl.id === pin.plan_id) : null;

      // Helper: find next BFS spot within a subtree root
      const findSubtreeSpot = (rootId) => {
        if (!rootId) return null;
        const q = [rootId];
        while (q.length) {
          const id = q.shift();
          const u = getUserById(id);
          if (!u) continue;
          if (!u.left_id) return { parent: u, side: 'left' };
          if (!u.right_id) return { parent: u, side: 'right' };
          q.push(u.left_id);
          q.push(u.right_id);
        }
        return null;
      };

      const bvPerUser = plan ? (plan.pv || 500) : 500;

      // Create left side users: fill target's left subtree via BFS
      for (let i = 1; i <= leftCount; i++) {
        if (i === 1) {
          createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: user.sponsor_id || user.id, parentId: user.id, side: 'left', memberName: 'Matrix L' + i, planId: pin.plan_id, bv: bvPerUser });
        } else {
          const lChildId = getUserById(user.id).left_id;
          const spot = lChildId ? findSubtreeSpot(lChildId) : null;
          if (!spot) break;
          createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: user.sponsor_id || user.id, parentId: spot.parent.id, side: spot.side, memberName: 'Matrix L' + i, planId: pin.plan_id, bv: bvPerUser });
        }
      }

      // Create right side users: fill target's right subtree via BFS
      for (let i = 1; i <= rightCount; i++) {
        if (i === 1) {
          createAutoUser({ username: 'MTX' + String(Date.now() + i + 100).slice(-6) + 'R' + i, sponsorId: user.sponsor_id || user.id, parentId: user.id, side: 'right', memberName: 'Matrix R' + i, planId: pin.plan_id, bv: bvPerUser });
        } else {
          const rChildId = getUserById(user.id).right_id;
          const spot = rChildId ? findSubtreeSpot(rChildId) : null;
          if (!spot) break;
          createAutoUser({ username: 'MTX' + String(Date.now() + i + 200).slice(-6) + 'R' + i, sponsorId: user.sponsor_id || user.id, parentId: spot.parent.id, side: spot.side, memberName: 'Matrix R' + i, planId: pin.plan_id, bv: bvPerUser });
        }
      }
      user.pv = 0;

      // Create leadership bonus for each auto user (not for target)
      if (user.leader_ref) {
        const leader = getUserByRef(user.leader_ref);
        if (leader) {
          const lbPlan = pin.plan_id ? ((db.plans || []).find(pl => pl.id === pin.plan_id) || null) : null;
          const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
          const defaultPlan = allPlans[0] || null;
          const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
          if (lbAmount > 0) {
            const q = [user.left_id, user.right_id].filter(Boolean);
            while (q.length) {
              const id = q.shift();
              const au = getUserById(id);
              if (!au || !au.is_auto_created) continue;
              const exists = (db.earnings || []).find(e => e.source_user_id === au.id && e.user_id === leader.id && e.note === 'Leadership bonus (Pending)');
              if (!exists) {
                (db.earnings || (db.earnings = [])).push({
                  id: nextId('earning'),
                  user_id: leader.id, amount_inr: 0, gross_inr: lbAmount,
                  tds_inr: 0, admin_charge_inr: 0, net_inr: 0,
                  pending_leadership: true, note: 'Leadership bonus (Pending)',
                  source_user_id: au.id, source_user_code: au.user_code,
                  source_pin_code: pin.code || null,
                  plan_id: lbPlan ? lbPlan.id : null, activation_bv: bvPerUser,
                  status: 'pending', created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
                });
              }
              if (au.left_id) q.push(au.left_id);
              if (au.right_id) q.push(au.right_id);
            }
          }
        }
      }
    }

    saveDB(db);
    return res.redirect('/admin/users/' + id + '?msg=User%20activated%20with%20PIN');
  } catch (e) {
    console.error('Error activating user with PIN:', e);
    return res.redirect('/admin/users/' + id + '?err=Failed%20to%20activate%20user');
  }
});

app.post('/admin/users/:id/block', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  user.status = 'blocked';
  saveDB(db);
  return res.redirect('/admin/users?msg=User%20blocked');
});

app.post('/admin/users/:id/unblock', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  user.status = 'active';
  if (!user.activated_at) user.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  return res.redirect('/admin/users?msg=User%20unblocked');
});

app.post('/admin/users/:id/make-franchise', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user) return res.redirect('/admin/users?err=User%20not%20found');
  user.role = 'franchise';
  saveDB(db);
  return res.redirect('/admin/users?msg=Role%20updated%20to%20franchise');
});

app.post('/admin/users/:id/kyc-verify', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  user.kyc_status = 'verified';
  saveDB(db);
  return res.redirect('/admin/users?msg=KYC%20approved');
});

app.post('/admin/users/:id/kyc-reject', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  user.kyc_status = 'rejected';
  saveDB(db);
  return res.redirect('/admin/users?msg=KYC%20rejected');
});

app.post('/admin/users/:id/kyc-reset', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  user.kyc_status = 'pending';
  saveDB(db);
  return res.redirect('/admin/users?msg=KYC%20reset%20to%20pending');
});

app.post('/admin/users/:id/reset-password', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const user = getUserById(id);
  if (!user || user.role !== 'user') return res.redirect('/admin/users?err=User%20not%20found');
  // generate a new temporary password
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#';
  function rand(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  const temp = rand(10);
  user.password_hash = bcrypt.hashSync(temp, 10);
  saveDB(db);
  // render the users list with a success message (avoid putting password in URL)
  let users = db.users.filter(u => u.role === 'user').map(u => {
    const sponsor = u.sponsor_id ? getUserById(u.sponsor_id) : null;
    const leadershipTotal = (db.earnings || []).filter(e => e.user_id === u.id && e.note === 'Leadership bonus').reduce((s, e) => s + (e.amount_inr || 0), 0);
    const lastPayout = (db.payouts || []).filter(p => p.user_id === u.id && (p.transfer_id || '') !== '').sort((a,b) => (b.transfer_date||b.created_at||'').localeCompare(a.transfer_date||a.created_at||'')).shift() || null;
    return {
      id: u.id,
      member_name: u.member_name || null,
      user_code: u.user_code || null,
      sponsor_code: sponsor ? (sponsor.user_code || sponsor.username) : null,
      placement_side: u.placement_side || null,
      kyc_status: u.kyc_status || 'pending',
      status: u.status || 'active',
      created_at: u.created_at,
      leadership_bonus_total: leadershipTotal,
      last_transfer_id: lastPayout ? (lastPayout.transfer_id || '') : '',
      carry_left: u.carry_left || 0,
      carry_right: u.carry_right || 0,
      repurchase_carry_left: u.repurchase_carry_left || 0,
      repurchase_carry_right: u.repurchase_carry_right || 0,
      org_bv_left: u.org_bv_left || 0,
      org_bv_right: u.org_bv_right || 0,
      org_rep_bv_left: u.org_rep_bv_left || 0,
      org_rep_bv_right: u.org_rep_bv_right || 0
    };
  }).sort((a,b) => (a.username||'').localeCompare(b.username||''));
  const q = '';
  const status = '';
  const success = `Temporary password for ${user.user_code || user.username}: ${temp}`;
  const error = null;
  return res.render('admin_users', { users, q, phone: '', pan: '', aadhaar: '', status, success, error, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.post('/admin/login-as-user/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const target = getUserById(id);
  if (!target || (target.role !== 'user' && target.role !== 'franchise')) return res.redirect('/admin/users?err=User%20not%20found');
  req.session.admin_backup = { ...req.session.user };
  req.session.user = { id: target.id, username: target.username, role: target.role };
  console.log(`[LOGIN AS USER] Admin ${req.session.admin_backup.username} (ID: ${req.session.admin_backup.id}) logged in as ${target.username} (ID: ${target.id})`);
  res.redirect('/dashboard');
});

app.post('/admin/login-as-franchise/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const target = (db.franchises || []).find(f => f.id === id);
  if (!target) return res.redirect('/admin/franchises?err=Franchise%20not%20found');
  req.session.admin_backup = { ...req.session.user };
  req.session.user = { id: target.id, username: target.username || target.franchise_code, role: 'franchise', franchise_id: target.id };
  console.log(`[LOGIN AS FRANCHISE] Admin ${req.session.admin_backup.username} (ID: ${req.session.admin_backup.id}) logged in as ${target.franchise_code} (ID: ${target.id})`);
  res.redirect('/franchise');
});

app.post('/admin/back-to-admin', (req, res) => {
  if (!req.session || !req.session.admin_backup) return res.redirect('/');
  req.session.user = req.session.admin_backup;
  delete req.session.admin_backup;
  res.redirect('/admin/users');
});

app.post('/admin/users/update-name', requireAuth('admin'), (req, res) => {
  try {
    const codeRaw = String(req.body.user_code || '').trim().toUpperCase();
    const newName = String(req.body.member_name || '').trim();
    if (!codeRaw || !newName) return res.redirect('/admin?msg=Enter%20ID%20and%20name');
    const user = (db.users || []).find(u => (String(u.user_code || '').toUpperCase() === codeRaw));
    if (!user) return res.redirect('/admin?err=User%20not%20found');
    user.member_name = newName;
    saveDB(db);
    return res.redirect('/admin?msg=Name%20updated%20for%20' + encodeURIComponent(codeRaw));
  } catch (e) {
    return res.redirect('/admin?err=Failed%20to%20update%20name');
  }
});

// Delete user earnings in date range
app.post('/admin/user/:id/earnings/delete', requireAuth('admin'), (req, res) => {
  const userId = parseInt(req.params.id);
  const from = req.query.from || '';
  const to = req.query.to || '';
  
  try {
    const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
    const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;
    
    const beforeCount = (db.earnings || []).length;
    
    db.earnings = (db.earnings || []).filter(e => {
      if (e.user_id !== userId) return true;
      if (startISO && e.created_at < startISO) return true;
      if (endISO && e.created_at > endISO) return true;
      return false;
    });
    
    const deletedCount = beforeCount - db.earnings.length;
    saveDB(db);
    
    res.redirect(`/admin/user/${userId}/earnings?from=${from}&to=${to}&msg=Deleted+${deletedCount}+earnings`);
  } catch (e) {
    res.redirect(`/admin/user/${userId}/earnings?from=${from}&to=${to}&err=Failed+to+delete`);
  }
});

// Delete single earning record
app.post('/admin/earnings/:id/delete', requireAuth('admin'), (req, res) => {
  const earningId = parseInt(req.params.id);
  const from = req.query.from || '';
  const to = req.query.to || '';
  
  try {
    const earning = (db.earnings || []).find(e => e.id === earningId);
    if (!earning) {
      return res.redirect(`/admin/tax?err=Earning+not+found`);
    }
    
    const userId = earning.user_id;
    db.earnings = (db.earnings || []).filter(e => e.id !== earningId);
    saveDB(db);
    
    res.redirect(`/admin/user/${userId}/earnings?from=${from}&to=${to}&msg=Earning+deleted`);
  } catch (e) {
    res.redirect(`/admin/tax?err=Failed+to+delete`);
  }
});

app.post('/admin/users/:id/delete', requireAuth('admin'), (req, res) => {
  const param = String(req.params.id || '').trim();
  const id = parseInt(param);
  
  // Try multiple lookup methods
  let user = null;
  
  // Method 1: By numeric ID
  if (!isNaN(id)) {
    user = db.users.find(u => u.id === id) || null;
  }
  
  // Method 2: By user_code (case-insensitive)
  if (!user) {
    const up = param.toUpperCase();
    user = db.users.find(u => String(u.user_code || '').toUpperCase() === up) || null;
  }
  
  // Method 3: By username
  if (!user) {
    user = db.users.find(u => String(u.username || '').toLowerCase() === param.toLowerCase()) || null;
  }
  
  if (!user || user.role !== 'user') {
    console.log('=== DELETE USER DEBUG ===');
    console.log('Param received:', param);
    console.log('Parsed ID:', id, 'isNaN:', isNaN(id));
    console.log('Total users in DB:', db.users.length);
    console.log('All users:', JSON.stringify(db.users.map(u => ({id: u.id, user_code: u.user_code, role: u.role, status: u.status}))));
    return res.redirect('/admin/users?err=User%20not%20found');
  }
  try {
    function reindexSubtree(node) {
      if (!node) return;
      const left = node.left_id ? getUserById(node.left_id) : null;
      const right = node.right_id ? getUserById(node.right_id) : null;
      if (left) {
        left.index_num = (node.index_num || 1) * 2;
        reindexSubtree(left);
      }
      if (right) {
        right.index_num = (node.index_num || 1) * 2 + 1;
        reindexSubtree(right);
      }
    }
    function firstAvailableSlot(root) {
      if (!root) return null;
      const q = [root];
      while (q.length) {
        const n = q.shift();
        if (!n.left_id) return { parent: n, side: 'left' };
        if (!n.right_id) return { parent: n, side: 'right' };
        const l = n.left_id ? getUserById(n.left_id) : null;
        const r = n.right_id ? getUserById(n.right_id) : null;
        if (l) q.push(l);
        if (r) q.push(r);
      }
      return null;
    }
    // Re-link direct sponsored users to this user's sponsor (if any)
    (db.users || []).forEach(u => {
      if (u && u.sponsor_id === user.id) {
        u.sponsor_id = user.sponsor_id || null;
      }
    });
    // *** BV reversal BEFORE tree re-linking (needs parent's left_id/right_id intact) ***
    let repurchaseBV = 0;
    (db.orders || []).forEach(o => {
      if (o.user_id === user.id) {
        if (o.items) {
          o.items.forEach(item => repurchaseBV += (item.bv || 0) * (item.quantity || 1));
        } else {
          repurchaseBV += o.total_bv || 0;
        }
      }
    });
    const activationBV = Math.max(0, (user.pv || 0) - repurchaseBV);
    const userPlacementParentId = user.placement_parent_id;
    const userPlacementSide = user.placement_side;
    const userSponsorId = user.sponsor_id;
    const affectedUplineMap = {};
    if ((activationBV > 0 || repurchaseBV > 0) && userPlacementParentId) {
      let upline = getUserById(userPlacementParentId);
      let prev = user;
      const seen = new Set();
      while (upline && !seen.has(upline.id)) {
        seen.add(upline.id);
        let side = null;
        if (Number(upline.left_id) === Number(prev.id)) side = 'left';
        else if (Number(upline.right_id) === Number(prev.id)) side = 'right';
        else if (prev.placement_side) side = prev.placement_side;
        if (side) affectedUplineMap[upline.id] = side;
        if (side === 'left') {
          if (activationBV > 0) {
            upline.carry_left = Math.max(0, (upline.carry_left||0) - activationBV);
            upline.org_bv_left = Math.max(0, (upline.org_bv_left||0) - activationBV);
          }
          if (repurchaseBV > 0) {
            upline.repurchase_carry_left = Math.max(0, (upline.repurchase_carry_left||0) - repurchaseBV);
            upline.org_rep_bv_left = Math.max(0, (upline.org_rep_bv_left||0) - repurchaseBV);
          }
        } else if (side === 'right') {
          if (activationBV > 0) {
            upline.carry_right = Math.max(0, (upline.carry_right||0) - activationBV);
            upline.org_bv_right = Math.max(0, (upline.org_bv_right||0) - activationBV);
          }
          if (repurchaseBV > 0) {
            upline.repurchase_carry_right = Math.max(0, (upline.repurchase_carry_right||0) - repurchaseBV);
            upline.org_rep_bv_right = Math.max(0, (upline.org_rep_bv_right||0) - repurchaseBV);
          }
        }
        if (!upline.placement_parent_id) break;
        prev = upline;
        upline = getUserById(upline.placement_parent_id);
      }
    }
    // Remove binary earnings for affected upline whose affected side carry is now 0
    Object.keys(affectedUplineMap).forEach(aid => {
      const side = affectedUplineMap[aid];
      const au = getUserById(parseInt(aid));
      if (au) {
        const sideCarry = side === 'left'
          ? (au.carry_left||0)+(au.repurchase_carry_left||0)+(au.org_bv_left||0)+(au.org_rep_bv_left||0)
          : (au.carry_right||0)+(au.repurchase_carry_right||0)+(au.org_bv_right||0)+(au.org_rep_bv_right||0);
        if (sideCarry <= 0) {
          db.earnings = db.earnings.filter(e => !(e.user_id === au.id && (e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match' || e.note === 'Rank income')));
        }
      }
    });
    // Collect all descendant IDs for earnings cleanup (before tree re-linking changes parent-child links)
    const descendantIds = new Set();
    const collectQ = [user.left_id, user.right_id].filter(Boolean);
    while (collectQ.length) {
      const cid = collectQ.shift();
      descendantIds.add(cid);
      const cu = getUserById(cid);
      if (cu) {
        if (cu.left_id) collectQ.push(cu.left_id);
        if (cu.right_id) collectQ.push(cu.right_id);
      }
    }
    // If deleting a matrix target user, also remove auto-created descendants entirely
    if (user.is_matrix_target) {
      const exterminate = [...descendantIds];
      exterminate.forEach(aid => {
        const au = getUserById(aid);
        if (au) {
          // Reverse auto user's BV contribution from ancestors (like activation BV reversal)
          const autoRepurchaseBV = ((au.orders || [])).reduce((sum, o) => sum + (o.total_bv || 0), 0);
          const autoActivationBV = Math.max(0, (au.pv || 0) - autoRepurchaseBV);
          let autoUpline = au.placement_parent_id ? getUserById(au.placement_parent_id) : null;
          let autoPrev = au;
          const autoSeen = new Set();
          while (autoUpline && !autoSeen.has(autoUpline.id)) {
            autoSeen.add(autoUpline.id);
            let autoSide = null;
            if (Number(autoUpline.left_id) === Number(autoPrev.id)) autoSide = 'left';
            else if (Number(autoUpline.right_id) === Number(autoPrev.id)) autoSide = 'right';
            else if (autoPrev.placement_side) autoSide = autoPrev.placement_side;
            if (autoSide === 'left') {
              if (autoActivationBV > 0) {
                autoUpline.carry_left = Math.max(0, (autoUpline.carry_left||0) - autoActivationBV);
                autoUpline.org_bv_left = Math.max(0, (autoUpline.org_bv_left||0) - autoActivationBV);
              }
              if (autoRepurchaseBV > 0) {
                autoUpline.repurchase_carry_left = Math.max(0, (autoUpline.repurchase_carry_left||0) - autoRepurchaseBV);
                autoUpline.org_rep_bv_left = Math.max(0, (autoUpline.org_rep_bv_left||0) - autoRepurchaseBV);
              }
            } else if (autoSide === 'right') {
              if (autoActivationBV > 0) {
                autoUpline.carry_right = Math.max(0, (autoUpline.carry_right||0) - autoActivationBV);
                autoUpline.org_bv_right = Math.max(0, (autoUpline.org_bv_right||0) - autoActivationBV);
              }
              if (autoRepurchaseBV > 0) {
                autoUpline.repurchase_carry_right = Math.max(0, (autoUpline.repurchase_carry_right||0) - autoRepurchaseBV);
                autoUpline.org_rep_bv_right = Math.max(0, (autoUpline.org_rep_bv_right||0) - autoRepurchaseBV);
              }
            }
            if (!autoUpline.placement_parent_id) break;
            autoPrev = autoUpline;
            autoUpline = getUserById(autoUpline.placement_parent_id);
          }
          
          descendantIds.add(aid);
          db.earnings = db.earnings.filter(e => e.user_id !== aid && e.source_user_id !== aid);
          db.payouts = db.payouts.filter(p => p.user_id !== aid);
          db.orders = (db.orders || []).filter(o => o.user_id !== aid);
          db.pin_packages = db.pin_packages.filter(p => p.used_by !== aid && p.assigned_to !== aid && p.assigned_by !== aid);
          db.celebrations = db.celebrations.filter(c => c.user_id !== aid);
          db.rank_history = db.rank_history.filter(r => r.user_id !== aid);
          db.users = db.users.filter(u => u.id !== aid);
        }
      });
    }
    // Tree re-linking: read user tree fields before clearing
    const parent = user.placement_parent_id ? getUserById(user.placement_parent_id) : null;
    const side = user.placement_side || null;
    const leftChild = user.left_id ? getUserById(user.left_id) : null;
    const rightChild = user.right_id ? getUserById(user.right_id) : null;
    let replacement = null;
    let extra = null;
    if (leftChild && rightChild) {
      replacement = leftChild;
      extra = rightChild;
    } else if (leftChild) {
      replacement = leftChild;
    } else if (rightChild) {
      replacement = rightChild;
    }
    if (parent) {
      if (replacement) {
        if (side === 'left') parent.left_id = replacement.id; else parent.right_id = replacement.id;
        replacement.placement_parent_id = parent.id;
        replacement.placement_side = side;
        replacement.index_num = side === 'left' ? (parent.index_num || 1) * 2 : (parent.index_num || 1) * 2 + 1;
        // Attach the extra subtree (if any) under the first available slot of replacement
        if (extra) {
          const slot = firstAvailableSlot(replacement);
          if (slot && slot.parent) {
            if (slot.side === 'left') slot.parent.left_id = extra.id; else slot.parent.right_id = extra.id;
            extra.placement_parent_id = slot.parent.id;
            extra.placement_side = slot.side;
          } else {
            // Fallback: attach as right child if somehow no slot found
            if (!replacement.right_id) {
              replacement.right_id = extra.id;
              extra.placement_parent_id = replacement.id;
              extra.placement_side = 'right';
            }
          }
        }
        reindexSubtree(replacement);
      } else {
        // No children, simply detach from parent
        if (side === 'left' && parent.left_id === user.id) parent.left_id = null;
        if (side === 'right' && parent.right_id === user.id) parent.right_id = null;
      }
    } else {
      // Deleting a root user (no placement parent)
      if (replacement) {
        replacement.placement_parent_id = null;
        replacement.placement_side = null;
        replacement.index_num = 1;
        if (extra) {
          const slot = firstAvailableSlot(replacement);
          if (slot && slot.parent) {
            if (slot.side === 'left') slot.parent.left_id = extra.id; else slot.parent.right_id = extra.id;
            extra.placement_parent_id = slot.parent.id;
            extra.placement_side = slot.side;
          } else {
            if (!replacement.right_id) {
              replacement.right_id = extra.id;
              extra.placement_parent_id = replacement.id;
              extra.placement_side = 'right';
            }
          }
        }
        reindexSubtree(replacement);
      }
    }
    // Clear links from the user being deleted (defensive)
    user.left_id = null;
    user.right_id = null;
    user.placement_parent_id = null;
    user.placement_side = null;
    // Remove ALL records for this user from every db array
    db.earnings = db.earnings.filter(e => e.user_id !== user.id && e.source_user_id !== user.id && !descendantIds.has(e.user_id) && !descendantIds.has(e.source_user_id));
    db.payouts = db.payouts.filter(p => p.user_id !== user.id && !descendantIds.has(p.user_id));
    db.orders = (db.orders || []).filter(o => o.user_id !== user.id && !descendantIds.has(o.user_id));
    db.pin_packages = (db.pin_packages || []).filter(p => p.used_by !== user.id && p.assigned_to !== user.id && p.assigned_by !== user.id && !descendantIds.has(p.used_by));
    db.invoices = (db.invoices || []).filter(i => i.user_id !== user.id && !descendantIds.has(i.user_id));
    db.celebrations = (db.celebrations || []).filter(c => c.user_id !== user.id && !descendantIds.has(c.user_id));
    db.rank_history = (db.rank_history || []).filter(r => r.user_id !== user.id && !descendantIds.has(r.user_id));
    db.tickets = (db.tickets || []).filter(t => t.user_id !== user.id && !descendantIds.has(t.user_id));
    db.free_product_issues = (db.free_product_issues || []).filter(f => f.user_id !== user.id && !descendantIds.has(f.user_id));
    db.bv_adjustments = (db.bv_adjustments || []).filter(b => b.user_id !== user.id && b.added_by_admin_id !== user.id && !descendantIds.has(b.user_id));
    db.offer_achievements = (db.offer_achievements || []).filter(o => o.user_id !== user.id && !descendantIds.has(o.user_id));
    db.wishlists = (db.wishlists || []).filter(w => w.user_id !== user.id && !descendantIds.has(w.user_id));
    db.broadcasts = (db.broadcasts || []).filter(b => b.specific_user_id !== user.id && !descendantIds.has(b.specific_user_id));
    // Update ranks for sponsor and all affected upline users
    if (userSponsorId) {
      updateUserRank(userSponsorId);
    }
    if (userPlacementParentId) {
      let rankUp = getUserById(userPlacementParentId);
      const seenRank = new Set();
      while (rankUp && !seenRank.has(rankUp.id)) {
        seenRank.add(rankUp.id);
        updateUserRank(rankUp.id);
        if (!rankUp.placement_parent_id) break;
        rankUp = getUserById(rankUp.placement_parent_id);
      }
    }
    db.users = db.users.filter(u => u.id !== user.id);
    try { fs.rmSync(path.join(USER_UPLOAD_DIR, String(user.id)), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(UPLOAD_DIR, String(user.id)), { recursive: true, force: true }); } catch (_) {}
    saveDB(db);
    return res.redirect('/admin/users?msg=User%20deleted');
  } catch (e) {
    return res.redirect('/admin/users?err=Failed%20to%20delete%20user');
  }
});

app.get('/admin/payout/binary', requireAuth('admin'), (req, res) => {
  const settings = getSettingsRow();

  // Clear all carry values (one-time: clears old website imported data from preview)
  if (req.query['clear-preview'] === '1') {
    let cleared = 0;
    (db.users || []).forEach(u => {
      if (!u.carry_left && !u.carry_right && !u.repurchase_carry_left && !u.repurchase_carry_right) return;
      // Only process users who have NOT been cleared before (org_bv not yet set)
      if (typeof u.org_bv_left === 'undefined') {
        u.org_bv_left = u.carry_left || 0;
        u.org_bv_right = u.carry_right || 0;
        u.org_rep_bv_left = u.repurchase_carry_left || 0;
        u.org_rep_bv_right = u.repurchase_carry_right || 0;
        u.carry_left = 0;
        u.carry_right = 0;
        u.repurchase_carry_left = 0;
        u.repurchase_carry_right = 0;
        cleared++;
      }
      // Users who already have org_bv set are skipped — their carry is new activation BV, don't touch
    });
    saveDB(db);
    return res.redirect('/admin/payout/binary?msg=Cleared%20carry%20for%20' + cleared + '%20users');
  }
  
  // Pending Payouts Preview
  const pendingList = [];
  (db.users || []).forEach(u => {
    if (u.role !== 'user') return;
    if (u.status !== 'active') return;
    // BinarySize from weaker side child's plan (same as processBinaryPairsForUser)
    const leftChild = u.left_id ? getUserById(u.left_id) : null;
    const rightChild = u.right_id ? getUserById(u.right_id) : null;
    const leftBV = (u.carry_left || 0) + (u.repurchase_carry_left || 0);
    const rightBV = (u.carry_right || 0) + (u.repurchase_carry_right || 0);
    const weakerChild = leftBV <= rightBV ? leftChild : rightChild;
    const strongerChild = leftBV <= rightBV ? rightChild : leftChild;
    
    let size = Math.max(1, settings.pair_bv_size || settings.pv_on_join || 100);
    if (weakerChild && weakerChild.plan_id) {
      const wPlan = (db.plans || []).find(p => p.id === weakerChild.plan_id);
      if (wPlan && wPlan.pv > 0) size = wPlan.pv;
    } else if (strongerChild && strongerChild.plan_id) {
      const sPlan = (db.plans || []).find(p => p.id === strongerChild.plan_id);
      if (sPlan && sPlan.pv > 0) size = sPlan.pv;
    }
    
    // Combined BV from both sides (only carry — org_bv already paid out from migration)
    const l = u.carry_left || 0;
    const r = u.carry_right || 0;
    const rl = u.repurchase_carry_left || 0;
    const rr = u.repurchase_carry_right || 0;
    const ol = u.org_bv_left || 0;
    const or = u.org_bv_right || 0;
    const orl = u.org_rep_bv_left || 0;
    const orr = u.org_rep_bv_right || 0;
    const totalLeftBV = l + rl;
    const totalRightBV = r + rr;
    
    // Match minimum of both sides
    const matchedBV = Math.min(totalLeftBV, totalRightBV);
    const totalPairs = Math.floor(matchedBV / size);
    
    // Leadership bonus (pending + credited but not yet paid)
    const paidEarningIds = (db.payouts || [])
      .filter(p => p.user_id === u.id)
      .flatMap(p => {
        let eids = p.earning_ids || [];
        if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(e) { eids = []; } }
        return Array.isArray(eids) ? eids : [];
      })
      .map(id => Number(id));
    
    const allLB = (db.earnings || []).filter(e => 
      e.user_id === u.id && 
      (e.pending_leadership === true || e.pending_leadership === 1) && 
      (e.status === 'pending' || e.status === 'credited') &&
      !paidEarningIds.includes(Number(e.id))
    ).filter(e => {
      const src = getUserById(e.source_user_id);
      return src && src.status === 'active';
    });
    let lbGross = 0;
    for (const lb of allLB) {
      lbGross += Number(lb.gross_inr || 0);
    }
    
    if (totalPairs > 0 || lbGross > 0) {
      const alreadyPairs = weeklyPairsPaidTotal(u.id);
      let pairsToPay = totalPairs;
      let weeklyCapPairs = 0;
      if (typeof u.weekly_cap_pairs === 'number' && u.weekly_cap_pairs >= 0) {
        weeklyCapPairs = u.weekly_cap_pairs;
      } else if (u.plan_id) {
        const userPlan = (db.plans || []).find(p => p.id === u.plan_id);
        if (userPlan && typeof userPlan.weekly_cap_pairs === 'number' && userPlan.weekly_cap_pairs > 0) {
          weeklyCapPairs = userPlan.weekly_cap_pairs;
        } else {
          weeklyCapPairs = db.settings.weekly_cap_pairs || 120;
        }
      } else {
        weeklyCapPairs = db.settings.weekly_cap_pairs || 120;
      }
        
      if (weeklyCapPairs > 0 && totalPairs > 0) {
        const capLeft = Math.max(weeklyCapPairs - alreadyPairs, 0);
        pairsToPay = Math.min(totalPairs, capLeft);
      }
      
      // Income calculation
      let perPair = settings.pair_amount_inr || 500;
      // perPair from child's plan (same as processBinaryPairsForUser)
      if (weakerChild && weakerChild.plan_id) {
        const wPlan = (db.plans || []).find(p => p.id === weakerChild.plan_id);
        if (wPlan && wPlan.pair_amount_inr > 0) perPair = wPlan.pair_amount_inr;
      } else if (strongerChild && strongerChild.plan_id) {
        const sPlan = (db.plans || []).find(p => p.id === strongerChild.plan_id);
        if (sPlan && sPlan.pair_amount_inr > 0) perPair = sPlan.pair_amount_inr;
      }
      
       const pairGross = totalPairs * perPair;
       const binaryTds = Math.round(pairGross * 0.02 * 100) / 100;
       const binaryAdmin = Math.round(pairGross * 0.10 * 100) / 100;
       const binaryNet = Math.max(0, Math.round((pairGross - binaryTds - binaryAdmin) * 100) / 100);
       
       const lbTds = Math.round(lbGross * 0.02 * 100) / 100;
       const lbAdmin = Math.round(lbGross * 0.10 * 100) / 100;
       const lbNet = Math.max(0, Math.round((lbGross - lbTds - lbAdmin) * 100) / 100);
       
       const gross = pairGross + lbGross;
       const tds = binaryTds + lbTds;
       const admin = binaryAdmin + lbAdmin;
       const net = Math.max(0, Math.round((gross - tds - admin) * 100) / 100);
       
       console.log('[PREVIEW DEBUG] totalPairs:', totalPairs, 'perPair:', perPair, 'pairGross:', pairGross, 'lbGross:', lbGross, 'gross:', gross);
       
        pendingList.push({
          user: u,
          carry_left: l,
          carry_right: r,
          repurchase_carry_left: rl,
          repurchase_carry_right: rr,
          org_bv_left: ol,
          org_bv_right: or,
          org_rep_bv_left: orl,
          org_rep_bv_right: orr,
          total_left_bv: totalLeftBV,
          total_right_bv: totalRightBV,
         matched_bv: matchedBV,
         pairs: totalPairs,
         lb_gross: lbGross,
         per_pair_amount: perPair,
         pair_gross: pairGross,
         repurchase_gross: 0,
         binary_gross: pairGross,
         gross,
         tds,
         admin,
         net
       });
    }
  });

  // Past Payouts History (Grouped by Date)
  // We group earnings where note='Binary pair match' or 'Repurchase binary pair match' or 'Leadership bonus' by date
  const historyMap = {};
  (db.earnings || []).forEach(e => {
    if (e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match' || e.note === 'Leadership bonus') {
      const date = e.created_at.split('T')[0];
      if (!historyMap[date]) {
        historyMap[date] = { date, count: 0, total_gross: 0, total_net: 0, lb_gross: 0, items: [] };
      }
      const u = getUserById(e.user_id);
      const user_code = u ? (u.user_code || u.username || ('#' + u.id)) : ('#' + e.user_id);
      const member_name = u ? (u.member_name || null) : null;
      historyMap[date].count++;
      historyMap[date].total_gross += (e.gross_inr || 0);
      historyMap[date].total_net += (e.net_inr || 0);
      if (e.note === 'Leadership bonus') {
        historyMap[date].lb_gross += (e.gross_inr || 0);
      }
      historyMap[date].items.push({
        user_id: e.user_id,
        user_code,
        member_name,
        net_inr: e.net_inr || e.amount_inr || 0,
        gross_inr: e.gross_inr || 0,
        tds_inr: e.tds_inr || 0,
        admin_charge_inr: e.admin_charge_inr || 0,
        pairs: e.pairs || 0,
        note: e.note || ''
      });
    }
  });
  const historyList = Object.values(historyMap).sort((a,b) => b.date.localeCompare(a.date));
  
  // Collect matrix PINs that have auto-created users without invoices
  const matrixPinOptions = [];
  const existingInvoiceUserIds = new Set((db.invoices || []).map(inv => inv.user_id));
  const usedMatrixPins = (db.pin_packages || []).filter(p => p.is_matrix_pin && p.used_by);
  usedMatrixPins.forEach(pin => {
    const autoUsers = (db.users || []).filter(u => u.is_auto_created && u.placement_parent_id === pin.used_by && !existingInvoiceUserIds.has(u.id));
    if (autoUsers.length > 0) {
      const parentUser = getUserById(pin.used_by);
      matrixPinOptions.push({
        code: pin.code,
        parent_name: parentUser ? (parentUser.member_name || parentUser.user_code || parentUser.username) : ('#' + pin.used_by),
        parent_code: parentUser ? (parentUser.user_code || parentUser.username) : '',
        count: autoUsers.length
      });
    }
  });
  
  res.render('admin_binary_payout', { 
    list: pendingList,
    history: historyList,
    next_run: db.settings.next_payout_date || null,
    last_run: db.settings.last_payout_run || null,
    settings,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    error: req.query.err || null, 
    success: req.query.msg || null,
    matrixPinOptions
  });
});

app.post('/admin/payout/binary', requireAuth('admin'), (req, res) => {
  let count = 0;
  (db.users || []).forEach(u => {
    if (u.role !== 'user') return;
    // Only process users with new activity (carry from new activations/repurchases)
    // org_bv alone won't trigger payout — old website data already paid
    const hasNewActivity = (u.carry_left || 0) > 0 || (u.carry_right || 0) > 0 
      || (u.repurchase_carry_left || 0) > 0 || (u.repurchase_carry_right || 0) > 0;
    if (hasNewActivity) {
      processBinaryPairsForUser(u.id);
      count++;
    }
  });
  res.redirect('/admin/payout/binary?msg=Processed%20' + count + '%20users');
});

app.get('/admin/undo-matrix-carries', requireAuth('admin'), (req, res) => {
  let undone = 0;
  (db.users || []).forEach(u => {
    if (u.role !== 'user') return;
    const ol = u.org_bv_left || 0;
    const or = u.org_bv_right || 0;
    if (ol === 0 && or === 0) return;
    const cl = u.carry_left || 0;
    const cr = u.carry_right || 0;
    const newL = Math.max(0, cl - ol);
    const newR = Math.max(0, cr - or);
    if (newL !== cl || newR !== cr) { undone++; }
    u.carry_left = newL;
    u.carry_right = newR;
  });
  saveDB(db);
  return res.redirect('/admin?msg=Undid%20carry%20for%20' + undone + '%20users');
});

app.get('/admin/fix-matrix-carries', requireAuth('admin'), (req, res) => {
  let fixed = 0;
  (db.users || []).forEach(u => {
    if (u.role !== 'user' || u.status !== 'active') return;
    if (!u.is_matrix_target) return;
    const ol = u.org_bv_left || 0;
    const or = u.org_bv_right || 0;
    if (ol === 0 && or === 0) return;
    u.carry_left = (u.carry_left || 0) + ol;
    u.carry_right = (u.carry_right || 0) + or;
    fixed++;
  });
  saveDB(db);
  return res.redirect('/admin?msg=Fixed%20' + fixed + '%20matrix%20targets');
});

app.get('/admin/propagate-matrix-up', requireAuth('admin'), (req, res) => {
  let propagated = 0;
  const targets = (db.users || []).filter(u => u.is_matrix_target && u.org_bv_left > 0 && u.org_bv_right > 0);
  targets.forEach(target => {
    // Step 1: Remove carry from target (user doesn't want target to get income)
    target.carry_left = Math.max(0, (target.carry_left || 0) - (target.org_bv_left || 0));
    target.carry_right = Math.max(0, (target.carry_right || 0) - (target.org_bv_right || 0));
    // Step 2: Propagate total matrix BV up to all upline
    const bvL = target.org_bv_left || 0;
    const bvR = target.org_bv_right || 0;
    let cur = getUserById(target.placement_parent_id);
    let prev = target;
    while (cur) {
      const side = cur.left_id === prev.id ? 'left' : (cur.right_id === prev.id ? 'right' : null);
      if (side === 'left') {
        cur.carry_left = (cur.carry_left || 0) + bvL + bvR;
      } else if (side === 'right') {
        cur.carry_right = (cur.carry_right || 0) + bvL + bvR;
      }
      propagated++;
      if (!cur.placement_parent_id) break;
      prev = cur;
      cur = getUserById(cur.placement_parent_id);
    }
  });
  saveDB(db);
  return res.redirect('/admin?msg=Propagated%20' + propagated + '%20upline%20carries,%20cleared%20' + targets.length + '%20target%20carries');
});


app.post('/admin/payout/repair-carries', requireAuth('admin'), (req, res) => {
  let carryAdjusted = 0, missingFixed = 0, pairProcessed = 0;
  // Step 1: Move old unmatched org_bv excess to carry (only if carry side is empty)
  //   old_matched = min(org_bv_left, org_bv_right) — already paid on old site
  //   remaining excess moves to carry ONLY when carry_X == 0 (not manually set)
  (db.users || []).forEach(u => {
    if (u.role !== 'user' || u.status !== 'active') return;
    const ol = u.org_bv_left || 0;
    const or = u.org_bv_right || 0;
    if (ol === 0 && or === 0) return;
    const oldMatched = Math.min(ol, or);
    const excessL = ol - oldMatched;
    const excessR = or - oldMatched;
    if ((excessL > 0 && (u.carry_left || 0) === 0) || (excessR > 0 && (u.carry_right || 0) === 0)) {
      if (excessL > 0 && (u.carry_left || 0) === 0) u.carry_left = excessL;
      if (excessR > 0 && (u.carry_right || 0) === 0) u.carry_right = excessR;
      u.org_bv_left = oldMatched;
      u.org_bv_right = oldMatched;
      carryAdjusted++;
    }
  });
  // Step 2: Add missing parent carries (child PV not reflected in parent's carry)
  (db.users || []).forEach(u => {
    if (u.role !== 'user' || u.status !== 'active') return;
    const pv = u.pv || 0;
    if (pv <= 0 || !u.placement_parent_id) return;
    const parent = getUserById(u.placement_parent_id);
    if (!parent) return;
    const field = u.placement_side === 'left' ? 'carry_left' : 'carry_right';
    const parentField = u.placement_side === 'left' ? 'org_bv_left' : 'org_bv_right';
    // Check if parent's org_bv reflects this child's PV (means it was already accounted)
    if ((parent[parentField] || 0) === 0 && (parent[field] || 0) === 0) {
      parent[field] = (parent[field] || 0) + pv;
      missingFixed++;
    }
  });
  saveDB(db);
  res.redirect('/admin/payout/binary?msg=Repair%20done:%20' + carryAdjusted + '%20adjusted,%20' + missingFixed + '%20missing%20fixed');
});

app.post('/admin/earnings/rollback-today', requireAuth('admin'), (req, res) => {
  const code = String(req.body.user_code || '').trim();
  const u = code ? getUserByRef(code) : null;
  if (!u || u.role !== 'user') {
    return res.json({ ok: false, error: 'User not found' });
  }
  const size = Math.max(1, (db.settings.pair_bv_size || db.settings.pv_on_join || 100));
  const { start, end } = todayRangeIST();
  const before = db.earnings.length;
  let restoredPairs = 0;
  db.earnings = db.earnings.filter(e => {
    const isMine = e.user_id === u.id;
    const isToday = e.created_at >= start && e.created_at <= end;
    const isPair = e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match';
    if (isMine && isToday && isPair) {
      const used = (e.used_bv || ((e.pair_bv_size_used || size) * (e.pairs || 0)));
      if (e.note === 'Repurchase binary pair match') {
        u.repurchase_carry_left = (u.repurchase_carry_left || 0) + used;
        u.repurchase_carry_right = (u.repurchase_carry_right || 0) + used;
      } else {
        u.carry_left = (u.carry_left || 0) + used;
        u.carry_right = (u.carry_right || 0) + used;
      }
      restoredPairs += (e.pairs || 0);
      return false; // drop
    }
    return true;
  });
  saveDB(db);
  return res.json({ ok: true, removed_entries: before - db.earnings.length, restored_pairs: restoredPairs });
});
app.post('/admin/earnings/rollback-today-all', requireAuth('admin'), (req, res) => {
  const size = Math.max(1, (db.settings.pair_bv_size || db.settings.pv_on_join || 100));
  const { start, end } = todayRangeIST();
  const usersMap = {};
  (db.users || []).forEach(u => { usersMap[u.id] = u; });
  const before = db.earnings.length;
  let restoredPairs = 0;
  db.earnings = db.earnings.filter(e => {
    const isToday = e.created_at >= start && e.created_at <= end;
    const isPair = e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match';
    if (isToday && isPair && usersMap[e.user_id]) {
      const used = (e.used_bv || ((e.pair_bv_size_used || size) * (e.pairs || 0)));
      const u = usersMap[e.user_id];
      if (e.note === 'Repurchase binary pair match') {
        u.repurchase_carry_left = (u.repurchase_carry_left || 0) + used;
        u.repurchase_carry_right = (u.repurchase_carry_right || 0) + used;
      } else {
        u.carry_left = (u.carry_left || 0) + used;
        u.carry_right = (u.carry_right || 0) + used;
      }
      restoredPairs += (e.pairs || 0);
      return false;
    }
    return true;
  });
  // Also remove today's payout records (orphaned after earnings rollback)
  const beforePayouts = db.payouts.length;
  const deletedPayoutIds = new Set();
  db.payouts = db.payouts.filter(p => {
    const isToday = p.created_at >= start && p.created_at <= end;
    if (isToday) { deletedPayoutIds.add(p.id); return false; }
    return true;
  });
  saveDB(db);
  return res.redirect('/admin?msg=Rolled%20back%20today%27s%20binary%20pairs:%20' + restoredPairs + '%20payouts:%20' + (beforePayouts - db.payouts.length));
});

app.post('/admin/payout/cleanup-orphaned-today', requireAuth('admin'), (req, res) => {
  const { start, end } = todayRangeIST();
  const paidEarningIds = new Set();
  (db.payouts || []).forEach(p => {
    (p.earning_ids || []).forEach(id => { if (id) paidEarningIds.add(Number(id)); });
  });
  const payoutsBefore = db.payouts.length;
  const removedPayouts = [];
  db.payouts = db.payouts.filter(p => {
    const isToday = p.created_at >= start && p.created_at <= end;
    const hasOrphaned = (p.earning_ids || []).some(id => id && !paidEarningIds.has(Number(id)));
    if (isToday && hasOrphaned) { removedPayouts.push(p.id); return false; }
    return true;
  });
  // Rebuild valid earning IDs from remaining payouts
  const validEarningIds = new Set();
  (db.payouts || []).forEach(p => {
    (p.earning_ids || []).forEach(id => { if (id) validEarningIds.add(Number(id)); });
  });
  // Remove today's orphaned earnings (not in any valid payout)
  const earningsBefore = db.earnings.length;
  db.earnings = db.earnings.filter(e => {
    const isToday = e.created_at >= start && e.created_at <= end;
    if (isToday && !validEarningIds.has(Number(e.id))) return false;
    return true;
  });
  saveDB(db);
  return res.redirect('/admin/payout/binary?msg=Cleaned%20up%20' + removedPayouts.length + '%20payouts%20and%20' + (earningsBefore - db.earnings.length) + '%20orphaned%20earnings');
});

app.post('/admin/payout/cleanup-old-binary', requireAuth('admin'), (req, res) => {
  const targetUser = String(req.body.user_code || '').trim();
  const u = targetUser ? getUserByRef(targetUser) : null;
  if (!u || u.role !== 'user') {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('User not found'));
  }
  // Collect earning IDs from remaining valid payouts (not from target user or not old)
  const validEarningIds = new Set();
  (db.payouts || []).forEach(p => {
    if (p.user_id === u.id) return; // skip target user's payouts
    (p.earning_ids || []).forEach(id => { if (id) validEarningIds.add(Number(id)); });
  });
  const removedPayouts = [];
  db.payouts = db.payouts.filter(p => {
    if (p.user_id === u.id) { removedPayouts.push(p.id); return false; }
    return true;
  });
  const removedEarnings = [];
  db.earnings = db.earnings.filter(e => {
    if (e.user_id === u.id && !validEarningIds.has(Number(e.id))) { removedEarnings.push(e.id); return false; }
    return true;
  });
  saveDB(db);
  return res.redirect('/admin/payout/binary?msg=Cleaned%20%27' + (u.member_name || u.username) + '%27:%20' + removedPayouts.length + '%20payouts,%20' + removedEarnings.length + '%20earnings%20removed');
});

app.post('/admin/payout/restore-nitesh', requireAuth('admin'), (req, res) => {
  const restorePath = './restore_nitesh.json';
  if (!fs.existsSync(restorePath)) {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('restore_nitesh.json not found. Upload it alongside server.mem.js'));
  }
  try {
    const data = JSON.parse(fs.readFileSync(restorePath, 'utf8'));
    const earnings = data.earnings || [];
    const payouts = data.payouts || [];
    // Filter out any records that already exist (by ID)
    const existEarn = new Set((db.earnings || []).map(e => e.id));
    const existPayout = new Set((db.payouts || []).map(p => p.id));
    let addedEarn = 0, addedPayout = 0;
    earnings.forEach(e => { if (!existEarn.has(e.id)) { db.earnings.push(e); addedEarn++; } });
    payouts.forEach(p => { if (!existPayout.has(p.id)) { db.payouts.push(p); addedPayout++; } });
    saveDB(db);
    return res.redirect('/admin/payout/binary?msg=Restored%20' + addedEarn + '%20earnings%20and%20' + addedPayout + '%20payouts%20for%20NITESH');
  } catch(e) {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Restore failed: ' + e.message));
  }
});

app.post('/admin/delete-earning', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.body.id);
  const before = (db.earnings || []).length;
  db.earnings = (db.earnings || []).filter(e => e.id !== id);
  if (db.earnings.length < before) { saveDB(db); }
  return res.redirect('/admin/payout/binary?msg=Deleted%20earning%20id%3D' + id);
});

app.post('/admin/delete-earning', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.body.id);
  const before = (db.earnings || []).length;
  db.earnings = (db.earnings || []).filter(e => e.id !== id);
  if (db.earnings.length < before) { saveDB(db); }
  res.redirect('/admin/payout/binary?msg=Deleted%20earning%20id%3D' + id);
});

app.post('/admin/fix-sponsors', requireAuth('admin'), (req, res) => {
  let fixed = 0, skipped = 0;
  (db.users || []).forEach(u => {
    const parentId = u.placement_parent_id;
    if (!parentId || u.sponsor_id === parentId) { skipped++; return; }
    u.sponsor_id = parentId;
    fixed++;
  });
  if (fixed > 0) saveDB(db);
  return res.redirect('/admin/payout/binary?msg=Fixed%20sponsors:%20' + fixed + '%20updated,%20' + skipped + '%20skipped');
});

app.post('/admin/payout/remove-history', requireAuth('admin'), (req, res) => {
  const code = String(req.body.user_code || '').trim();
  const u = code ? getUserByRef(code) : null;
  if (!u || u.role !== 'user') {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('User not found'));
  }
  const before = db.payouts.length;
  let removed = 0;
  db.payouts = db.payouts.filter(p => {
    if (p.user_id === u.id) { removed++; return false; }
    return true;
  });
  // Also remove buggy binary pair earnings (21/5, 22/5 old code)
  const removedEarnings = [];
  db.earnings = db.earnings.filter(e => {
    if (e.user_id === u.id && e.note === 'Binary pair match') {
      const isBuggy = (e.created_at || '').startsWith('2026-05-21') || (e.created_at || '').startsWith('2026-05-22');
      if (isBuggy) {
        const inPayout = (db.payouts || []).some(p => (p.earning_ids || []).includes(Number(e.id)));
        if (!inPayout) { removedEarnings.push(e.id); return false; }
      }
    }
    return true;
  });
  saveDB(db);
  return res.redirect('/admin/payout/binary?msg=Removed%20' + removed + '%20payouts%20and%20' + removedEarnings.length + '%20earnings%20for%20' + (u.member_name || u.username) + '%20(rank/BV%20unchanged)');
});

app.post('/admin/earnings/rollback-today-carry-only', requireAuth('admin'), (req, res) => {
  const code = String(req.body.user_code || '').trim();
  const u = code ? getUserByRef(code) : null;
  if (!u || u.role !== 'user') {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('User not found'));
  }
  const size = Math.max(1, (db.settings.pair_bv_size || db.settings.pv_on_join || 100));
  const { start, end } = todayRangeIST();
  let restoredPairs = 0;
  db.earnings = db.earnings.filter(e => {
    const isMine = e.user_id === u.id;
    const isToday = e.created_at >= start && e.created_at <= end;
    const isPair = e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match';
    if (isMine && isToday && isPair) {
      const used = (e.used_bv || ((e.pair_bv_size_used || size) * (e.pairs || 0)));
      if (e.note === 'Repurchase binary pair match') {
        u.repurchase_carry_left = (u.repurchase_carry_left || 0) + used;
      } else {
        u.carry_left = (u.carry_left || 0) + used;
      }
      restoredPairs += (e.pairs || 0);
      return false;
    }
    return true;
  });
  saveDB(db);
  return res.redirect('/admin/payout/binary?msg=' + encodeURIComponent('Rolled back ' + restoredPairs + ' pairs for ' + u.user_code + '. Carry-left restored.'));
});

app.post('/admin/earnings/clear-leadership-today', requireAuth('admin'), (req, res) => {
  try {
    const { start, end } = todayRangeIST();
    const before = db.earnings.length;
    let removedCount = 0;
    db.earnings = db.earnings.filter(e => {
      const isToday = e.created_at >= start && e.created_at <= end;
      const isLeadership = e.note === 'Leadership bonus';
      if (isToday && isLeadership) {
        removedCount++;
        return false;
      }
      return true;
    });
    saveDB(db);
    return res.redirect('/admin/reports/leadership?msg=Cleared%20' + removedCount + '%20leadership%20bonus%20entries%20for%20today');
  } catch (e) {
    return res.redirect('/admin/reports/leadership?err=' + encodeURIComponent('Failed to clear leadership bonus'));
  }
});

app.post('/admin/payout/check-schedule', requireAuth('admin'), (req, res) => {
  try {
    const s = getSettingsRow();
    const nextISO = nextFlushDateISO(s);
    db.settings.next_payout_date = nextISO;
    saveDB(db);
    let eligible = 0;
    let processed = 0;
    (db.users || []).forEach(u => {
      if (u.role !== 'user') return;
      const hasNewActivity = (u.carry_left || 0) > 0 || (u.carry_right || 0) > 0 
        || (u.repurchase_carry_left || 0) > 0 || (u.repurchase_carry_right || 0) > 0;
      if (hasNewActivity) {
        eligible++;
        processBinaryPairsForUser(u.id);
        processed++;
      }
    });
    const msg = `Auto-run verified. Manual test generated for ${processed} users. Next run: ${new Date(nextISO).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Eligible before run: ${eligible}`;
    return res.redirect('/admin/payout/binary?msg=' + encodeURIComponent(msg));
  } catch (e) {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Failed to verify auto-run'));
  }
});

app.get('/admin/reset-invoice-seq', requireAuth('admin'), (req, res) => {
  if (!db.counters) db.counters = {};
  const val = req.query.v;
  let seq;
  if (val !== undefined) {
    seq = parseInt(val, 10);
    if (isNaN(seq)) return res.redirect('/admin?err=Invalid%20value');
  } else {
    const existing = (db.invoices || []).map(i => i.invoice_no).filter(Boolean);
    seq = 0;
    existing.forEach(no => {
      const m = String(no).match(/INV(\d+)(\d{5})/);
      if (m) {
        const s = parseInt(m[2], 10);
        if (s > seq) seq = s;
      }
    });
  }
  db.counters.invoice_seq = seq;
  saveDB(db);
  const yr = new Date().getFullYear();
  const next = 'INV' + yr + String(seq + 1).padStart(5, '0');
  return res.redirect('/admin?msg=Invoice%20sequence%20reset.%20Current:%20' + seq + '%20Next:%20' + next);
});

app.get('/admin/renumber-invoices', requireAuth('admin'), (req, res) => {
  const invs = (db.invoices || []).filter(inv => inv.invoice_no);
  const yr = new Date().getFullYear();
  invs.sort((a, b) => {
    const ma = String(a.invoice_no).match(/INV(\d+)(\d{5})/);
    const mb = String(b.invoice_no).match(/INV(\d+)(\d{5})/);
    return (ma ? parseInt(ma[2], 10) : 0) - (mb ? parseInt(mb[2], 10) : 0);
  });
  invs.forEach((inv, idx) => {
    inv.invoice_no = 'INV' + yr + String(idx + 1).padStart(5, '0');
  });
  if (!db.counters) db.counters = {};
  db.counters.invoice_seq = invs.length;
  saveDB(db);
  return res.redirect('/admin?msg=Renumbered%20' + invs.length + '%20invoices.%20Next:%20INV' + yr + String(invs.length + 1).padStart(5, '0'));
});

app.post('/admin/payout/binary/manual', requireAuth('admin'), (req, res) => {
  try {
    let processed = 0;
    (db.users || []).forEach(u => {
      if (u.role !== 'user') return;
      // Only process users with new activity (carry from new activations/repurchases)
      const hasNewActivity = (u.carry_left || 0) > 0 || (u.carry_right || 0) > 0 
        || (u.repurchase_carry_left || 0) > 0 || (u.repurchase_carry_right || 0) > 0;
      if (hasNewActivity) {
        processBinaryPairsForUser(u.id);
        processed++;
      }
    });
    const msg = `Manual binary generated - ${processed} users processed`;
    return res.redirect('/admin/payout/binary?msg=' + encodeURIComponent(msg));
  } catch (e) {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Failed to generate manual binary'));
  }
});

app.post('/admin/payout/binary/matrix-invoices', requireAuth('admin'), (req, res) => {
  try {
    let generated = 0;
    const existingInvoices = new Set((db.invoices || []).map(inv => inv.user_id));
    (db.users || []).forEach(u => {
      if (!u.is_auto_created) return;
      if (existingInvoices.has(u.id)) return;
      const plan = u.plan_id ? (db.plans || []).find(p => p.id === u.plan_id) : null;
      if (!plan) return;
      const invoiceNo = generateInvoiceNumber([]);
      const prodIds = Array.isArray(plan.product_ids) ? plan.product_ids : (plan.product_id ? [plan.product_id] : []);
      const prodList = prodIds.map(id => (db.products || []).find(p => p.id === id)).filter(Boolean);
      const planTotal = plan.amount_inr || 0;
      const n = prodList.length || 1;
      let accum = 0;
      const items = prodList.map((p, idx) => {
        const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
        accum += share;
        const gstPercent = p.gst_percent || 0;
        const gstInr = share * (gstPercent / (100 + gstPercent));
        const priceInr = share - gstInr;
        return {
          product_id: p.id,
          product_code: p.product_code || p.code || '',
          product_name: p.name,
          hsn_code: p.hsn_code || '',
          quantity: 1,
          unit_price: p.selling_price_inr || p.mrp_inr || 0,
          price_inr: Math.round(priceInr * 100) / 100,
          gst_percent: gstPercent,
          gst_inr: Math.round(gstInr * 100) / 100,
          total_inr: share
        };
      });
      if (!db.invoices) db.invoices = [];
      db.invoices.push({
        id: (db.invoices.length ? Math.max(...db.invoices.map(i => i.id)) : 0) + 1,
        invoice_no: invoiceNo,
        user_id: u.id,
        product_id: plan.product_id || null,
        product_name: prodList.map(p => p.name).join(' + '),
        hsn_code: prodList.map(p => p.hsn_code).filter(Boolean).join(', '),
        items,
        quantity: prodList.length || 1,
        price_inr: items.reduce((s, i) => s + i.price_inr, 0),
        gst_percent: 0,
        gst_inr: items.reduce((s, i) => s + i.gst_inr, 0),
        total_inr: planTotal,
        total_bv: u.pv || plan.pv || 0,
        plan_name: plan.name || '',
        pin_code: 'MATRIX',
        status: 'activation',
        type: 'activation',
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
      generated++;
    });
    saveDB(db);
    const msg = `Generated ${generated} invoices for matrix users`;
    return res.redirect('/admin/payout/binary?msg=' + encodeURIComponent(msg));
  } catch (e) {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Failed to generate matrix invoices'));
  }
});

app.post('/admin/payout/binary/matrix-invoices/pin', requireAuth('admin'), (req, res) => {
  try {
    const pinCode = String(req.body.pin_code || '').trim();
    if (!pinCode) return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Please select a PIN'));
    const pin = (db.pin_packages || []).find(p => p.code === pinCode && p.is_matrix_pin);
    if (!pin || !pin.used_by) return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('PIN not found or not yet used'));
    const parentUser = getUserById(pin.used_by);
    if (!parentUser) return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Parent user not found'));
    const existingInvoices = new Set((db.invoices || []).map(inv => inv.user_id));
    const autoUsers = (db.users || []).filter(u => u.is_auto_created && u.placement_parent_id === pin.used_by && !existingInvoices.has(u.id));
    if (!autoUsers.length) return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('No pending auto-created users for this PIN'));
    let generated = 0;
    autoUsers.forEach(u => {
      const plan = u.plan_id ? (db.plans || []).find(p => p.id === u.plan_id) : null;
      if (!plan) return;
      const invoiceNo = generateInvoiceNumber([]);
      const prodIds = Array.isArray(plan.product_ids) ? plan.product_ids : (plan.product_id ? [plan.product_id] : []);
      const prodList = prodIds.map(id => (db.products || []).find(p => p.id === id)).filter(Boolean);
      const planTotal = plan.amount_inr || 0;
      const n = prodList.length || 1;
      let accum = 0;
      const items = prodList.map((p, idx) => {
        const share = idx === n - 1 ? Math.max(0, Math.round((planTotal - accum) * 100) / 100) : Math.round((planTotal / n) * 100) / 100;
        accum += share;
        const gstPercent = p.gst_percent || 0;
        const gstInr = share * (gstPercent / (100 + gstPercent));
        const priceInr = share - gstInr;
        return {
          product_id: p.id,
          product_code: p.product_code || p.code || '',
          product_name: p.name,
          hsn_code: p.hsn_code || '',
          quantity: 1,
          unit_price: p.selling_price_inr || p.mrp_inr || 0,
          price_inr: Math.round(priceInr * 100) / 100,
          gst_percent: gstPercent,
          gst_inr: Math.round(gstInr * 100) / 100,
          total_inr: share
        };
      });
      if (!db.invoices) db.invoices = [];
      db.invoices.push({
        id: (db.invoices.length ? Math.max(...db.invoices.map(i => i.id)) : 0) + 1,
        invoice_no: invoiceNo,
        user_id: u.id,
        product_id: plan.product_id || null,
        product_name: prodList.map(p => p.name).join(' + '),
        hsn_code: prodList.map(p => p.hsn_code).filter(Boolean).join(', '),
        items,
        quantity: prodList.length || 1,
        price_inr: items.reduce((s, i) => s + i.price_inr, 0),
        gst_percent: 0,
        gst_inr: items.reduce((s, i) => s + i.gst_inr, 0),
        total_inr: planTotal,
        total_bv: u.pv || plan.pv || 0,
        plan_name: plan.name || '',
        pin_code: pinCode,
        status: 'activation',
        type: 'activation',
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
      generated++;
    });
    saveDB(db);
    const msg = `Generated ${generated} invoices for PIN ${pinCode} (${parentUser.member_name || parentUser.user_code || parentUser.username})`;
    return res.redirect('/admin/payout/binary?msg=' + encodeURIComponent(msg));
  } catch (e) {
    return res.redirect('/admin/payout/binary?err=' + encodeURIComponent('Failed to generate invoice for PIN'));
  }
});

app.get('/admin/branding', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  res.render('admin_branding', { 
    error: null, success: null, 
    current: s.brand_logo_url || null,
    settings: s,
    youtubeVideos: s.youtube_videos || [],
    marqueeText: s.marquee_text || '',
    marqueeSpeed: s.marquee_speed || 20,
    marqueeDuration: s.marquee_duration || 30,
    achieversMarqueeSpeed: s.achievers_marquee_speed || 40
  });
});

app.post('/admin/branding', requireAuth('admin'), uploadBrand.single('brand_logo'), (req, res) => {
  try {
    const s = db.settings || {};
    if (!req.file) return res.render('admin_branding', { error: 'Please select a logo file', success: null, current: s.brand_logo_url || null, settings: s, youtubeVideos: s.youtube_videos || [], marqueeText: s.marquee_text || '', marqueeSpeed: s.marquee_speed || 20, marqueeDuration: s.marquee_duration || 30,
    achieversMarqueeSpeed: s.achievers_marquee_speed || 40 });
    const rel = '/brand/' + req.file.filename;
    db.settings.brand_logo_url = rel;
    db.settings.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    saveDB(db);
    res.render('admin_branding', { error: null, success: 'Brand logo updated', current: rel, settings: s, youtubeVideos: s.youtube_videos || [], marqueeText: s.marquee_text || '', marqueeSpeed: s.marquee_speed || 20, marqueeDuration: s.marquee_duration || 30,
    achieversMarqueeSpeed: s.achievers_marquee_speed || 40 });
  } catch (e) {
    const s = db.settings || {};
    res.render('admin_branding', { error: 'Failed to upload logo', success: null, current: s.brand_logo_url || null, settings: s, youtubeVideos: s.youtube_videos || [], marqueeText: s.marquee_text || '', marqueeSpeed: s.marquee_speed || 20, marqueeDuration: s.marquee_duration || 30,
    achieversMarqueeSpeed: s.achievers_marquee_speed || 40 });
  }
});

app.post('/admin/branding/payment-gateway', requireAuth('admin'), (req, res) => {
  if (!db.settings) db.settings = {};
  db.settings.payment_gateway_name = req.body.payment_gateway_name || 'Razorpay';
  db.settings.payment_gateway_url = req.body.payment_gateway_url || '';
  db.settings.payment_gateway_enabled = req.body.payment_gateway_enabled === '1';
  db.settings.user_purchase_disabled = req.body.user_purchase_disabled === '1' || req.body.user_purchase_disabled === 'on';
  db.settings.payment_alt1_name = req.body.payment_alt1_name || '';
  db.settings.payment_alt1_url = req.body.payment_alt1_url || '';
  db.settings.payment_alt2_name = req.body.payment_alt2_name || '';
  db.settings.payment_alt2_url = req.body.payment_alt2_url || '';
  db.settings.payment_alt3_name = req.body.payment_alt3_name || '';
  db.settings.payment_alt3_url = req.body.payment_alt3_url || '';
  db.settings.payment_alt4_name = req.body.payment_alt4_name || '';
  db.settings.payment_alt4_url = req.body.payment_alt4_url || '';
  db.settings.payment_instructions = req.body.payment_instructions || '';
  db.settings.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  const s = db.settings || {};
  res.render('admin_branding', { error: null, success: 'Payment gateway settings saved!', current: s.brand_logo_url || null, settings: s, youtubeVideos: s.youtube_videos || [], marqueeText: s.marquee_text || '', marqueeSpeed: s.marquee_speed || 20, marqueeDuration: s.marquee_duration || 30,
    achieversMarqueeSpeed: s.achievers_marquee_speed || 40 });
});

app.post('/admin/branding/company-details', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  db.settings.company_name = req.body.company_name || '';
  db.settings.company_address = req.body.company_address || '';
  db.settings.company_phone = req.body.company_phone || '';
  db.settings.company_email = req.body.company_email || '';
  db.settings.company_gstin = req.body.company_gstin || '';
  db.settings.company_cin = req.body.company_cin || '';
  db.settings.company_qr_image = req.body.company_qr_image || '';
  db.settings.gst_type = req.body.gst_type || 'inclusive';
  db.settings.social_facebook = req.body.social_facebook || '';
  db.settings.social_twitter = req.body.social_twitter || '';
  db.settings.social_instagram = req.body.social_instagram || '';
  db.settings.social_youtube = req.body.social_youtube || '';
  db.settings.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  res.render('admin_branding', { error: null, success: 'Company details saved!', current: s.brand_logo_url || null, settings: db.settings, youtubeVideos: db.settings.youtube_videos || [], marqueeText: db.settings.marquee_text || '', marqueeSpeed: db.settings.marquee_speed || 20, marqueeDuration: db.settings.marquee_duration || 30,
    achieversMarqueeSpeed: (db.settings && db.settings.achievers_marquee_speed) || 40 });
});

app.post('/admin/branding/youtube', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  const url = req.body.youtube_url || req.body.url || '';
  const title = req.body.youtube_title || req.body.title || '';
  if (url && (url.includes('youtube.com') || url.includes('youtu.be'))) {
    if (!db.settings.youtube_videos) db.settings.youtube_videos = [];
    db.settings.youtube_videos.push({ id: nextId('video'), url, title: title || '' });
    saveDB(db);
  }
  res.render('admin_branding', { error: null, success: 'YouTube video added!', current: s.brand_logo_url || null, settings: db.settings, youtubeVideos: db.settings.youtube_videos || [], marqueeText: db.settings.marquee_text || '', marqueeSpeed: db.settings.marquee_speed || 20, marqueeDuration: db.settings.marquee_duration || 30,
    achieversMarqueeSpeed: (db.settings && db.settings.achievers_marquee_speed) || 40 });
});

app.post('/admin/branding/youtube/delete', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  const { video_id } = req.body;
  if (video_id && db.settings.youtube_videos) {
    db.settings.youtube_videos = db.settings.youtube_videos.filter(v => String(v.id) !== String(video_id));
    saveDB(db);
  }
  res.render('admin_branding', { error: null, success: 'Video removed!', current: s.brand_logo_url || null, settings: db.settings, youtubeVideos: db.settings.youtube_videos || [], marqueeText: db.settings.marquee_text || '', marqueeSpeed: db.settings.marquee_speed || 20, marqueeDuration: db.settings.marquee_duration || 30,
    achieversMarqueeSpeed: (db.settings && db.settings.achievers_marquee_speed) || 40 });
});

const uploadBanner = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads', 'banner')),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `banner_${ts}${ext}`);
    },
    quality: 85,
    maxWidth: 1920,
    maxHeight: 1080
  }),
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const uploadQR = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT_DIR, 'brand')),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `qr_${ts}${ext}`);
    },
    quality: 90,
    maxWidth: 600,
    maxHeight: 600
  }),
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get('/admin/banners', requireAuth('admin'), (req, res) => {
  if (!db.settings) db.settings = {};
  res.render('admin_banners', { 
    error: req.query.error || null, 
    success: req.query.success || null, 
    settings: db.settings
  });
});

app.post('/admin/branding/banner', requireAuth('admin'), uploadBanner.array('slide_image'), (req, res) => {
  if (!db.settings) db.settings = {};
  if (!db.settings.banner_slides) db.settings.banner_slides = [];
  
  try {
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        db.settings.banner_slides.push({
          id: nextId('banner'),
          url: '/uploads/banner/' + file.filename
        });
      });
      saveDB(db);
      res.redirect('/admin/banners?success=Banner added!');
    } else {
      res.redirect('/admin/banners?error=Please select an image');
    }
  } catch (e) {
    console.error('Banner add error:', e);
    res.redirect('/admin/banners?error=Failed to add banner');
  }
});

app.post('/admin/branding/banner/delete', requireAuth('admin'), (req, res) => {
  try {
    if (!db.settings || !db.settings.banner_slides) {
      return res.redirect('/admin/banners');
    }
    const { slide_index } = req.body;
    const idx = parseInt(slide_index);
    if (!isNaN(idx) && idx >= 0 && idx < db.settings.banner_slides.length) {
      db.settings.banner_slides.splice(idx, 1);
      saveDB(db);
    }
    res.redirect('/admin/banners?success=Banner deleted!');
  } catch (e) {
    console.error('Banner delete error:', e);
    res.redirect('/admin/banners?error=Failed to delete banner');
  }
});

app.post('/admin/branding/banner/import-default', requireAuth('admin'), (req, res) => {
  try {
    res.redirect('/admin/banners?success=');
  } catch (e) {
    console.error('Banner import error:', e);
    res.redirect('/admin/banners?error=Failed');
  }
});

app.post('/admin/branding/company-account', requireAuth('admin'), uploadQR.single('qr_image'), (req, res) => {
  const s = db.settings || {};
  db.settings.company_account_name = req.body.company_account_name || req.body.account_name || '';
  db.settings.company_account_number = req.body.company_account_number || req.body.account_number || '';
  db.settings.company_bank_name = req.body.company_bank_name || req.body.bank_name || '';
  db.settings.company_bank_branch = req.body.company_bank_branch || req.body.bank_branch || '';
  db.settings.company_ifsc = req.body.company_ifsc || req.body.ifsc || '';
  db.settings.company_upi_id = req.body.company_upi_id || req.body.upi_id || '';
  if (req.file) {
    db.settings.company_qr_image = '/uploads/brand/' + req.file.filename;
  }
  db.settings.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  res.render('admin_branding', { error: null, success: 'Bank account saved!', current: db.settings.brand_logo_url || null, settings: db.settings, youtubeVideos: db.settings.youtube_videos || [], marqueeText: db.settings.marquee_text || '', marqueeSpeed: db.settings.marquee_speed || 20, marqueeDuration: db.settings.marquee_duration || 30,
    achieversMarqueeSpeed: (db.settings && db.settings.achievers_marquee_speed) || 40 });
});

app.post('/admin/branding/marquee', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  db.settings.marquee_text = req.body.marquee_text || '';
  db.settings.marquee_speed = parseInt(req.body.marquee_speed) || 20;
  db.settings.marquee_duration = parseInt(req.body.marquee_duration) || 30;
  saveDB(db);
  res.render('admin_branding', { error: null, success: 'Marquee settings saved!', current: s.brand_logo_url || null, settings: db.settings, youtubeVideos: db.settings.youtube_videos || [], marqueeText: db.settings.marquee_text || '', marqueeSpeed: db.settings.marquee_speed || 20, marqueeDuration: db.settings.marquee_duration || 30,
    achieversMarqueeSpeed: (db.settings && db.settings.achievers_marquee_speed) || 40 });
});

app.post('/admin/branding/popup-notice', requireAuth('admin'), (req, res) => {
  db.settings.popup_notice_enabled = req.body.popup_notice_enabled === 'on';
  db.settings.popup_notice_title = req.body.popup_notice_title || '';
  db.settings.popup_notice_message = req.body.popup_notice_message || '';
  db.settings.popup_notice_button_text = req.body.popup_notice_button_text || '';
  db.settings.popup_notice_button_link = req.body.popup_notice_button_link || '';
  db.settings.popup_notice_bg = req.body.popup_notice_bg || '#ffffff';
  db.settings.popup_notice_color = req.body.popup_notice_color || '#667eea';
  saveDB(db);
  res.render('admin_branding', { error: null, success: 'Popup Notice saved!', current: db.settings.brand_logo_url || null, settings: db.settings, youtubeVideos: db.settings.youtube_videos || [], marqueeText: db.settings.marquee_text || '', marqueeSpeed: db.settings.marquee_speed || 30, marqueeDuration: db.settings.marquee_duration || 30,
    achieversMarqueeSpeed: (db.settings && db.settings.achievers_marquee_speed) || 40 });
});

// Side Popup Settings
app.get('/admin/side-popup', requireAuth('admin'), (req, res) => {
  res.render('admin_side_popup', { settings: db.settings || {}, error: null, success: null });
});

// Email Settings
app.get('/admin/email-settings', requireAuth('admin'), (req, res) => {
  res.render('admin_email_settings', { settings: db.settings || {}, error: null, success: null });
});

app.post('/admin/email-settings', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  s.email_settings = {
    smtp_host: req.body.smtp_host || '',
    smtp_port: parseInt(req.body.smtp_port) || 587,
    smtp_user: req.body.smtp_user || '',
    smtp_pass: req.body.smtp_pass || '',
    from_email: req.body.from_email || '',
    from_name: req.body.from_name || ''
  };
  db.settings = s;
  saveDB(db);
  res.render('admin_email_settings', { settings: s, error: null, success: 'Email settings saved successfully!' });
});

app.post('/admin/email-settings/test', requireAuth('admin'), async (req, res) => {
  try {
    const s = db.settings || {};
    const emailSettings = s.email_settings || {};
    
    if (!emailSettings.smtp_host || !emailSettings.smtp_user || !emailSettings.smtp_pass) {
      return res.render('admin_email_settings', { settings: s, error: 'Please fill all SMTP settings first', success: null });
    }

    const transporter = nodemailer.createTransport({
      host: emailSettings.smtp_host,
      port: emailSettings.smtp_port || 587,
      secure: emailSettings.smtp_port === 465,
      auth: {
        user: emailSettings.smtp_user,
        pass: emailSettings.smtp_pass
      }
    });

    await transporter.sendMail({
      from: `"${emailSettings.from_name || 'Nastige'}" <${emailSettings.from_email || emailSettings.smtp_user}>`,
      to: emailSettings.from_email || emailSettings.smtp_user,
      subject: 'Test Email from Nastige',
      html: '<h2>Email Configuration Working!</h2><p>This is a test email from your Nastige MLM system.</p>'
    });

    res.render('admin_email_settings', { settings: s, error: null, success: 'Test email sent successfully!' });
  } catch (e) {
    res.render('admin_email_settings', { settings: db.settings || {}, error: 'Failed to send test email: ' + e.message, success: null });
  }
});

// Broadcasts
app.get('/admin/broadcasts', requireAuth('admin'), (req, res) => {
  const broadcasts = db.broadcasts || [];
  const users = (db.users || []).filter(u => u.role === 'user');
  res.render('admin_broadcast', { broadcasts, users, error: null, success: null });
});

app.post('/admin/broadcasts', requireAuth('admin'), (req, res) => {
  const { title, content, audience, specific_user_id, is_active } = req.body;
  try {
    if (!db.broadcasts) db.broadcasts = [];
    const broadcast = {
      id: nextId('broadcast'),
      title: title || 'Untitled',
      content: content || '',
      audience: audience || 'all',
      specific_user_id: audience === 'specific_user' ? specific_user_id : null,
      is_active: is_active === 'true',
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    db.broadcasts.push(broadcast);
    saveDB(db);
    const users = (db.users || []).filter(u => u.role === 'user');
    res.render('admin_broadcast', { broadcasts: db.broadcasts, users, error: null, success: 'Broadcast created!' });
  } catch (e) {
    const broadcasts = db.broadcasts || [];
    const users = (db.users || []).filter(u => u.role === 'user');
    res.render('admin_broadcast', { broadcasts, users, error: e.message, success: null });
  }
});

app.post('/admin/broadcasts/delete', requireAuth('admin'), (req, res) => {
  const { id } = req.body;
  if (id && db.broadcasts) {
    db.broadcasts = db.broadcasts.filter(b => String(b.id) !== String(id));
    saveDB(db);
  }
  res.redirect('/admin/broadcasts');
});

app.post('/admin/broadcasts/edit', requireAuth('admin'), (req, res) => {
  const { id, title, content, audience, is_active } = req.body;
  try {
    if (!db.broadcasts) db.broadcasts = [];
    const broadcast = db.broadcasts.find(b => String(b.id) === String(id));
    if (broadcast) {
      broadcast.title = title || 'Untitled';
      broadcast.content = content || '';
      broadcast.audience = audience || 'all';
      broadcast.is_active = is_active === 'true';
      broadcast.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
      // Clear read_broadcasts for all users and franchises so edited broadcast shows again
      if (db.users) {
        db.users.forEach(u => {
          if (u.read_broadcasts && u.read_broadcasts.includes(id)) {
            u.read_broadcasts = u.read_broadcasts.filter(bid => String(bid) !== String(id));
          }
        });
      }
      if (db.franchises) {
        db.franchises.forEach(f => {
          if (f.read_broadcasts && f.read_broadcasts.includes(id)) {
            f.read_broadcasts = f.read_broadcasts.filter(bid => String(bid) !== String(id));
          }
        });
      }
      saveDB(db);
    }
    const users = (db.users || []).filter(u => u.role === 'user');
    res.render('admin_broadcast', { broadcasts: db.broadcasts, users, error: null, success: 'Broadcast updated!' });
  } catch (e) {
    const users = (db.users || []).filter(u => u.role === 'user');
    res.render('admin_broadcast', { broadcasts: db.broadcasts || [], users, error: e.message, success: null });
  }
});

app.get('/admin/send-broadcast', requireAuth('admin'), (req, res) => {
  const users = db.users || [];
  const totalUsers = users.filter(u => u.role === 'user').length;
  const usersWithEmail = users.filter(u => u.role === 'user' && u.email).length;
  const usersWithPhone = users.filter(u => u.role === 'user' && u.phone).length;
  const totalFranchises = (db.franchises || []).length;
  const stats = { totalUsers, usersWithEmail, usersWithPhone, totalFranchises };
  const broadcastLogs = db.broadcast_logs || [];
  res.render('admin_send_broadcast', { stats, broadcastLogs, error: null, success: null });
});

app.post('/admin/send-broadcast/send', requireAuth('admin'), (req, res) => {
  const { type, userFilter, subject, message } = req.body;
  try {
    if (!db.broadcast_logs) db.broadcast_logs = [];
    const log = {
      id: nextId('broadcast_log'),
      type: type || 'all',
      userFilter: userFilter || 'all',
      subject: subject || '',
      message: message || '',
      results: { total: 0, emailSent: 0, emailFailed: 0, smsSent: 0, smsFailed: 0, whatsappSent: 0, whatsappFailed: 0 },
      createdAt: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    db.broadcast_logs.push(log);
    saveDB(db);
    res.redirect('/admin/send-broadcast?success=Message+queued+for+sending');
  } catch (e) {
    res.redirect('/admin/send-broadcast?error=' + encodeURIComponent(e.message));
  }
});

// Founders
const founderUploadDir = path.join(UPLOAD_ROOT_DIR, 'founders');
fs.mkdirSync(founderUploadDir, { recursive: true });

const uploadFounder = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, founderUploadDir),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `founder_${ts}${ext}`);
    },
    quality: 85,
    maxWidth: 800,
    maxHeight: 800
  }),
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get('/admin/founders', requireAuth('admin'), (req, res) => {
  const founders = db.settings && db.settings.founders ? db.settings.founders : [];
  res.render('admin_founders', { founders, error: null, success: null });
});

app.post('/admin/founders', requireAuth('admin'), uploadFounder.fields([
  { name: 'photo_1', maxCount: 1 },
  { name: 'photo_2', maxCount: 1 },
  { name: 'photo_3', maxCount: 1 }
]), (req, res) => {
  try {
    if (!db.settings) db.settings = {};
    if (!db.settings.founders) db.settings.founders = [{}, {}, {}];
    for (let i = 1; i <= 3; i++) {
      const name = req.body['name_' + i] || '';
      const title = req.body['title_' + i] || '';
      const message = req.body['message_' + i] || '';
      const hidden = req.body['hidden_' + i] === '1';
      const photo_position = req.body['photo_position_' + i] || 'center';
      let photo = db.settings.founders[i - 1] ? db.settings.founders[i - 1].photo : '';
      const uploadedFile = req.files && req.files['photo_' + i] && req.files['photo_' + i][0];
      if (uploadedFile) {
        photo = '/uploads/founders/' + uploadedFile.filename;
      }
      db.settings.founders[i - 1] = { id: i, name, title, message, hidden, photo, photo_position };
    }
    saveDB(db);
    res.render('admin_founders', { founders: db.settings.founders, error: null, success: 'Founders saved successfully!' });
  } catch (e) {
    res.render('admin_founders', { founders: db.settings.founders || [], error: e.message, success: null });
  }
});

app.post('/admin/founders/:id/delete-photo', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (db.settings && db.settings.founders && db.settings.founders[id - 1]) {
      db.settings.founders[id - 1].photo = '';
      saveDB(db);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: 'Founder not found' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/admin/founders/:id/position', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { position } = req.body;
    if (db.settings && db.settings.founders && db.settings.founders[id - 1]) {
      db.settings.founders[id - 1].photo_position = position;
      saveDB(db);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: 'Founder not found' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/admin/founders/:id/hide', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (db.settings && db.settings.founders && db.settings.founders[id - 1]) {
      db.settings.founders[id - 1].hidden = true;
      saveDB(db);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: 'Founder not found' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/admin/founders/:id/unhide', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (db.settings && db.settings.founders && db.settings.founders[id - 1]) {
      db.settings.founders[id - 1].hidden = false;
      saveDB(db);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: 'Founder not found' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Achievers
const achieverUploadDir = path.join(UPLOAD_ROOT_DIR, 'achievers');
fs.mkdirSync(achieverUploadDir, { recursive: true });

const uploadAchiever = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, achieverUploadDir),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `achiever_${ts}${ext}`);
    },
    quality: 85,
    maxWidth: 600,
    maxHeight: 600
  }),
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get('/admin/achievers', requireAuth('admin'), (req, res) => {
  const ranks = db.ranks || [];
  let achievers = db.settings && db.settings.achievers ? db.settings.achievers : [];
  
  // Auto-import from rank_history if no manual achievers exist
  if (achievers.length === 0 && (db.rank_history || []).length > 0) {
    const recentRanks = (db.rank_history || [])
      .sort((a, b) => new Date(b.achieved_at || b.created_at) - new Date(a.achieved_at || a.created_at));
    const seenUsers = new Set();
    const autoImport = [];
    
    for (const rh of recentRanks) {
      if (autoImport.length >= 8) break;
      if (seenUsers.has(rh.user_id)) continue;
      seenUsers.add(rh.user_id);
      
      const user = getUserById(rh.user_id);
      if (user) {
        autoImport.push({
          position: autoImport.length + 1,
          name: user.member_name || user.username || '',
          user_code: user.user_code || '',
          rank_name: rh.rank_name || user.rank_name || '',
          phone: user.phone || '',
          place: user.city || '',
          photo: user.photo || '',
          hidden: false
        });
      }
    }
    
    if (autoImport.length > 0) {
      if (!db.settings) db.settings = {};
      db.settings.achievers = autoImport;
      saveDB(db);
      achievers = autoImport;
    }
  }
  
  res.render('admin_achievers', { achievers, ranks, error: null, success: req.query.msg || null });
});

app.post('/admin/achievers', requireAuth('admin'), uploadAchiever.any(), (req, res) => {
  try {
    if (!db.settings) db.settings = {};
    if (!db.settings.achievers) db.settings.achievers = [];
    
    for (let i = 1; i <= 12; i++) {
      const name = req.body['name_' + i] || '';
      const user_code = req.body['usercode_' + i] || '';
      const rank_name = req.body['rank_' + i] || '';
      const phone = req.body['phone_' + i] || '';
      const place = req.body['place_' + i] || '';
      const hidden = req.body['hidden_' + i] === 'true';
      
      let photo = '';
      const existing = db.settings.achievers.find(a => a.position === i);
      if (existing && existing.photo) photo = existing.photo;
      
      const uploadedFile = req.files && req.files.find(f => f.fieldname === 'photo_' + i);
      if (uploadedFile) {
        photo = '/uploads/achievers/' + uploadedFile.filename;
      }
      
      // Handle photo removal
      if (req.body['remove_photo_' + i] === 'true') {
        photo = '';
      }
      
        const object_position = req.body['object_position_' + i] || 'center';
        if (name || photo || user_code) {
          const idx = db.settings.achievers.findIndex(a => a.position === i);
          const achiever = { position: i, name, user_code, rank_name, phone, place, hidden, photo, object_position };
        if (idx >= 0) {
          db.settings.achievers[idx] = achiever;
        } else {
          db.settings.achievers.push(achiever);
        }
      }
    }
    
    saveDB(db);
    const ranks = db.ranks || [];
    res.render('admin_achievers', { achievers: db.settings.achievers, ranks, error: null, success: 'Saved!' });
  } catch (e) {
    const ranks = db.ranks || [];
    res.render('admin_achievers', { achievers: db.settings.achievers || [], ranks, error: e.message, success: null });
  }
});

app.post('/admin/achievers/clear', requireAuth('admin'), (req, res) => {
  try {
    if (db.settings) db.settings.achievers = [];
    saveDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/admin/achievers/auto-import', requireAuth('admin'), (req, res) => {
  try {
    const recentRanks = (db.rank_history || [])
      .sort((a, b) => new Date(b.achieved_at || b.created_at) - new Date(a.achieved_at || a.created_at));
    const seenUsers = new Set();
    const autoImport = [];
    
    for (const rh of recentRanks) {
      if (autoImport.length >= 8) break;
      if (seenUsers.has(rh.user_id)) continue;
      seenUsers.add(rh.user_id);
      
      const user = getUserById(rh.user_id);
      if (user) {
        autoImport.push({
          position: autoImport.length + 1,
          name: user.member_name || user.username || '',
          user_code: user.user_code || '',
          rank_name: rh.rank_name || user.rank_name || '',
          phone: user.phone || '',
          place: user.city || '',
          photo: user.photo || '',
          hidden: false
        });
      }
    }
    
    if (!db.settings) db.settings = {};
    db.settings.achievers = autoImport;
    saveDB(db);
    res.redirect('/admin/achievers?msg=Imported ' + autoImport.length + ' achievers from rank history');
  } catch (e) {
    res.redirect('/admin/achievers?err=' + encodeURIComponent(e.message));
  }
});

app.post('/admin/side-popup', requireAuth('admin'), (req, res) => {
  try {
    if (!db.settings) db.settings = {};
    db.settings.sidePopupEnabled = req.body.sidePopupEnabled === 'on';
    db.settings.sidePopupLink = req.body.sidePopupLink || '';
    db.settings.sidePopupTitle = req.body.sidePopupTitle || '';
    db.settings.sidePopupSubtitle = req.body.sidePopupSubtitle || '';
    db.settings.sidePopupButtonText = req.body.sidePopupButtonText || 'Open Link';
    saveDB(db);
    res.render('admin_side_popup', { settings: db.settings, error: null, success: 'Settings saved successfully!' });
  } catch (e) {
    res.render('admin_side_popup', { settings: db.settings || {}, error: e.message, success: null });
  }
});

// ============================================
// POPUP NOTICE - Home page popup for announcements
// ============================================
app.get('/admin/popup-notice', requireAuth('admin'), (req, res) => {
  res.render('admin_popup_notice', { settings: db.settings || {}, error: null, success: null });
});

app.post('/admin/popup-notice', requireAuth('admin'), (req, res) => {
  try {
    if (!db.settings) db.settings = {};
    db.settings.popup_notice_enabled = req.body.popup_notice_enabled === 'on';
    db.settings.popup_notice_title = String(req.body.popup_notice_title || '').trim();
    db.settings.popup_notice_message = String(req.body.popup_notice_message || '').trim();
    db.settings.popup_notice_button_text = String(req.body.popup_notice_button_text || 'Close').trim();
    db.settings.popup_notice_button_link = String(req.body.popup_notice_button_link || '').trim();
    db.settings.popup_notice_color = String(req.body.popup_notice_color || '#667eea').trim();
    db.settings.popup_notice_bg = String(req.body.popup_notice_bg || '#ffffff').trim();
    saveDB(db);
    res.render('admin_popup_notice', { settings: db.settings, error: null, success: 'Popup notice saved!' });
  } catch (e) {
    res.render('admin_popup_notice', { settings: db.settings || {}, error: e.message, success: null });
  }
});

// Raw logo file (PNG preferred, then common PNG fallbacks, then default SVG)
app.get('/brand/logo-file', (req, res) => {
  try {
    const rel = db.settings && db.settings.brand_logo_url;
    console.log('Logo path from DB:', rel);
    if (rel) {
      // rel is like /brand/filename.png
      const filename = rel.replace('/brand/', '');
      
      // Try uploads/brand/filename (primary location)
      let filePath = path.join(__dirname, '..', 'uploads', 'brand', filename);
      if (fs.existsSync(filePath)) {
        console.log('Found in uploads/brand:', filePath);
        return res.sendFile(filePath);
      }
      // Try public/uploads/brand/filename
      filePath = path.join(__dirname, '..', 'public', 'uploads', 'brand', filename);
      if (fs.existsSync(filePath)) {
        console.log('Found in public/uploads/brand:', filePath);
        return res.sendFile(filePath);
      }
      // Try direct path from root
      filePath = path.join(__dirname, '..', rel);
      if (fs.existsSync(filePath)) {
        console.log('Found in root:', filePath);
        return res.sendFile(filePath);
      }
      // Try old format /uploads/brand/filename
      if (rel.startsWith('/uploads/brand/')) {
        const oldFilename = rel.replace('/uploads/brand/', '');
        filePath = path.join(__dirname, '..', 'uploads', 'brand', oldFilename);
        if (fs.existsSync(filePath)) {
          console.log('Found via old format:', filePath);
          return res.sendFile(filePath);
        }
      }
    }
    const candidates = [
      path.join(__dirname, '..', 'uploads', 'brand', 'brand_1773858094071.png'),
      path.join(__dirname, '..', 'uploads', 'brand', 'brand_1773857695070.png'),
      path.join(__dirname, '..', 'uploads', 'brand', 'brand_1773855697545.jpg'),
      path.join(__dirname, '..', 'public', 'uploads', 'brand', 'brand_1773858094071.png'),
      path.join(__dirname, '..', 'public', 'uploads', 'brand', 'brand_1773857695070.png'),
      path.join(__dirname, '..', 'public', 'uploads', 'brand', 'brand_1773855697545.jpg'),
      path.join(__dirname, '..', 'public', 'img', 'logo.svg')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        console.log('Logo found:', p);
        return res.sendFile(p);
      }
    }
    console.log('No logo found, using default');
    return res.sendFile(path.join(__dirname, '..', 'public', 'img', 'logo.svg'));
  } catch (e) {
    console.log('Logo error:', e.message);
    return res.sendFile(path.join(__dirname, '..', 'public', 'img', 'logo.svg'));
  }
});

// Boxed logo: serves an SVG square that contains the raw logo centered with padding
app.get('/brand/logo', (req, res) => {
  try {
    const rel = db.settings && db.settings.brand_logo_url;
    if (rel) {
      const filename = rel.replace('/brand/', '');
      const candidates = [
        path.join(__dirname, '..', 'uploads', 'brand', filename),
        path.join(__dirname, '..', 'public', 'uploads', 'brand', filename),
        path.join(__dirname, '..', rel),
        path.join(__dirname, '..', 'public', 'uploads', rel)
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const ext = path.extname(p).toLowerCase();
          if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.svg') {
            return res.sendFile(p);
          }
        }
      }
    }
    const brandDir = path.join(__dirname, '..', 'uploads', 'brand');
    if (fs.existsSync(brandDir)) {
      const files = fs.readdirSync(brandDir).filter(f => /\.(png|jpg|jpeg|gif|svg)$/i.test(f));
      if (files.length > 0) {
        return res.sendFile(path.join(brandDir, files[0]));
      }
    }
  } catch (e) { console.log('Logo direct error:', e.message); }
  
  // If no image found, create SVG box
  const sizeParam = parseInt(String(req.query.s || ''), 10);
  const S = Math.min(512, Math.max(64, isNaN(sizeParam) ? 256 : sizeParam));
  const pad = Math.round(S * 0.08);
  const inner = S - pad * 2;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" role="img" aria-label="Brand Logo Boxed">
  <defs>
    <style>
      .bg{fill:transparent}
    </style>
  </defs>
  <rect x="0" y="0" width="${S}" height="${S}" class="bg"/>
  <image href="/brand/logo-file" x="${pad}" y="${pad}" width="${inner}" height="${inner}" preserveAspectRatio="xMidYMid meet"/>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(svg);
});

app.get('/admin/password', requireAuth('admin'), (req, res) => {
  res.render('password_admin', { error: null, success: null });
});

app.post('/admin/password', requireAuth('admin'), (req, res) => {
  const admin = getUserById(req.session.user.id);
  const { current_password, new_password, confirm_password } = req.body;
  try {
    if (!bcrypt.compareSync(current_password || '', admin.password_hash)) {
      return res.render('password_admin', { error: 'Current password is incorrect', success: null });
    }
    if (!new_password || new_password.length < 6) {
      return res.render('password_admin', { error: 'New password must be at least 6 characters', success: null });
    }
    if (new_password !== confirm_password) {
      return res.render('password_admin', { error: 'New password and confirm do not match', success: null });
    }
    admin.password_hash = bcrypt.hashSync(new_password, 10);
    saveDB(db);
    res.render('password_admin', { error: null, success: 'Password updated successfully' });
  } catch (e) {
    res.render('password_admin', { error: 'Failed to update password', success: null });
  }
});

app.get('/admin/products/new', requireAuth('admin'), (req, res) => {
  res.render('admin_product_new', { error: null, success: null });
});

app.post('/admin/products/new', requireAuth('admin'), uploadProduct.single('image1'), (req, res) => {
  console.log('PRODUCT ADD ROUTE HIT');
  console.log('Body:', req.body);
  console.log('File:', req.file);
  console.log('RAW BV:', req.body.bv, 'RAW MRP:', req.body.mrp_inr, 'RAW DP:', req.body.selling_price_inr);
  try {
    const {
      category,
      product_code,
      hsn_code,
      name,
      mrp_inr,
      selling_price_inr,
      bv,
      details,
      show_on_home,
      stock,
      total_stock,
      weight,
      active,
      gst_percent
    } = req.body;
    if (!name) {
      return res.render('admin_product_new', { error: 'Product name is required', success: null });
    }
    const img = req.file ? '/uploads/products/' + req.file.filename : null;
    const product = {
      id: nextId('product'),
      category: (category || '').trim(),
      product_code: (product_code || '').trim(),
      hsn_code: (hsn_code || '').trim(),
      name: (name || '').trim(),
      mrp_inr: parseFloat(mrp_inr || '0') || 0,
      selling_price_inr: parseFloat(selling_price_inr || '0') || 0,
      bv: parseFloat(bv || '0') || 0,
      details: (details || '').trim(),
      show_on_home: String(show_on_home || '').toLowerCase() === 'yes' || String(show_on_home || '').toLowerCase() === 'true' || show_on_home === 'on',
      stock: (stock || '').trim(),
      total_stock: parseInt(total_stock || '0'),
      weight: (weight || '').trim(),
      active: String(active || '').toLowerCase() === 'yes' || String(active || '').toLowerCase() === 'true' || active === 'on',
      gst_percent: parseFloat(gst_percent || '0') || 0,
      image1_url: img,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    if (!db.products) db.products = [];
    db.products.push(product);
    saveDB(db);
    res.redirect('/admin/products?msg=Product added successfully');
  } catch (e) {
    console.error('Product add error:', e);
    res.render('admin_product_new', { error: 'Failed to add product: ' + e.message, success: null });
  }
});

app.get('/admin/products', requireAuth('admin'), (req, res) => {
  const products = (db.products || []).map(p => ({
    id: p.id,
    category: p.category || '',
    code: p.product_code || p.code || '',
    name: p.name,
    price: p.selling_price_inr || p.mrp_inr || 0,
    mrp_inr: p.mrp_inr || 0,
    selling_price_inr: p.selling_price_inr || 0,
    bv: p.bv || 0,
    total_stock: p.total_stock || 0,
    active: !!p.active,
    created_at: p.created_at
  })).sort((a,b) => (a.name||'').localeCompare(b.name||''));
  const success = req.query.msg || null;
  const error = req.query.err || null;
  res.render('admin_products', {
    products,
    success,
    error,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// API: Get next available product code
app.get('/api/products/next-code', requireAuth('admin'), (req, res) => {
  try {
    const category = (req.query.category || '').trim().toUpperCase();
    const categoryPrefixes = {
      'WELL': 'N-1',
      'SKIN': 'N-2',
      'HAIR': 'N-3',
      'HOME': 'N-4',
      'FMCG': 'N-5',
      'FOOD': 'N-6',
      'HEALTH': 'N-7',
      'FIRE': 'N-9',
      'OTHER': 'N-8'
    };
    const prefix = categoryPrefixes[category] || 'N-';
    const products = db.products || [];
    const existingCodes = products.map(p => p.product_code || p.code || '').filter(Boolean);
    let maxNum = 0;
    existingCodes.forEach(code => {
      const match = code.match(/N-(\d+)(\d{4})/);
      if (match) {
        const catNum = parseInt(match[1]);
        const seqNum = parseInt(match[2]);
        if (category && categoryPrefixes[category] === 'N-' + catNum) {
          maxNum = Math.max(maxNum, seqNum);
        } else if (!category) {
          maxNum = Math.max(maxNum, seqNum);
        }
      }
    });
    const nextCode = prefix + String(maxNum + 1).padStart(4, '0');
    res.json({ code: nextCode, next: maxNum + 1, prefix });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Check if product code already exists
app.get('/api/products/check-code', requireAuth('admin'), (req, res) => {
  try {
    const code = (req.query.code || '').trim();
    if (!code) return res.json({ exists: false });
    const products = db.products || [];
    const found = products.find(p => (p.product_code || p.code || '') === code);
    res.json({
      exists: !!found,
      productName: found ? found.name : null,
      productId: found ? found.id : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Generate barcode SVG for a product code
app.get('/api/products/barcode/:code', (req, res) => {
  try {
    const code = req.params.code;
    const svg = generateBarcodeSVG(code, 200, 60);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.send(svg);
  } catch (e) {
    res.status(500).send('Error generating barcode');
  }
});

// Barcode SVG generator (Code 128 simplified)
function generateBarcodeSVG(text, width, height) {
  const bars = encodeCode128(text);
  const barWidth = Math.max(1, Math.floor(width / bars.length));
  const totalWidth = bars.length * barWidth;
  let svgBars = '';
  let x = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] === '1') {
      svgBars += `<rect x="${x}" y="0" width="${barWidth}" height="${height}" fill="#000"/>`;
    }
    x += barWidth;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height + 16}" viewBox="0 0 ${totalWidth} ${height + 16}">
  <rect x="0" y="0" width="${totalWidth}" height="${height + 16}" fill="#fff"/>
  ${svgBars}
  <text x="${totalWidth / 2}" y="${height + 14}" text-anchor="middle" font-family="monospace" font-size="10" fill="#000">${text}</text>
</svg>`;
}

function encodeCode128(text) {
  const charset = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  let result = '';
  let checksum = 104;
  for (let i = 0; i < text.length; i++) {
    const idx = charset.indexOf(text[i]);
    if (idx === -1) continue;
    checksum += (i + 1) * idx;
    result += toBinary(idx);
  }
  const checkChar = checksum % 103;
  result += toBinary(checkChar);
  result += toBinary(106);
  return result;
}

function toBinary(value) {
  const patterns = [
    '11011001100','11001101100','11001100110','10010011000','10010001100',
    '10001001100','10011001000','10011000100','10001100100','11001001000',
    '11001000100','11000100100','10110011100','10011011100','10011001110',
    '10111001100','10011101100','10011100110','11001110010','11001011100',
    '11001001110','11011100100','11001110100','11101101110','11101001100',
    '11100101100','11100100110','11101100100','11100110100','11100110010',
    '11011011000','11011000110','11000110110','10100011000','10001011000',
    '10001000110','10110001000','10001101000','10001100010','11010001000',
    '11000101000','11000100010','10110111000','10110001110','10001101110',
    '10111011000','10111000110','10001110110','11101110110','11010001110',
    '11000101110','11011101000','11011100010','11011101110','11101011000',
    '11101000110','11100010110','11101101000','11101100010','11100011010',
    '11101111010','11001000010','11110001010','10100110000','10100001100',
    '10010110000','10010000110','10000101100','10000100110','10110010000',
    '10110000100','10011010000','10011000010','10000110100','10000110010',
    '11000010010','11001010000','11110111010','11000010100','10001111010',
    '10100111100','10010111100','10010011110','10111100100','10011110100',
    '10011110010','11110100100','11110010100','11110010010','11011011110',
    '11011110110','11110110110','10101111000','10100011110','10001011110',
    '10111101000','10111100010','11110101000','11110100010','10111011110',
    '10111101110','11101011110','11110101110','11010000100','11010010000',
    '11010011100','1100011101011'
  ];
  return patterns[value] || '';
}

app.get('/admin/products/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const p = (db.products || []).find(x => x.id === id);
  if (!p) return res.status(404).send('Product not found');
  res.render('admin_product_edit', { product: p, error: null, success: null });
});

app.post('/admin/products/:id', requireAuth('admin'), uploadProduct.single('image1'), (req, res) => {
  console.log('PRODUCT EDIT ROUTE HIT for id:', req.params.id);
  console.log('Raw form values - BV:', req.body.bv, 'MRP:', req.body.mrp_inr, 'DP:', req.body.selling_price_inr);
  try {
    const id = parseInt(req.params.id);
    const p = (db.products || []).find(x => x.id === id);
    if (!p) return res.status(404).send('Product not found');
    const {
      category,
      product_code,
      hsn_code,
      name,
      mrp_inr,
      selling_price_inr,
      bv,
      details,
      show_on_home,
      stock,
      total_stock,
      weight,
      active,
      gst_percent
    } = req.body;
    if (category !== undefined) p.category = (category || '').trim();
    if (product_code !== undefined) p.product_code = (product_code || '').trim();
    if (hsn_code !== undefined) p.hsn_code = (hsn_code || '').trim();
    if (name !== undefined) p.name = (name || '').trim();
    if (mrp_inr !== undefined) p.mrp_inr = parseFloat(mrp_inr || '0') || 0;
    if (selling_price_inr !== undefined) p.selling_price_inr = parseFloat(selling_price_inr || '0') || 0;
    if (bv !== undefined) p.bv = parseFloat(bv || '0') || 0;
    if (details !== undefined) p.details = (details || '').trim();
    if (show_on_home !== undefined) p.show_on_home = String(show_on_home || '').toLowerCase() === 'yes' || String(show_on_home || '').toLowerCase() === 'true' || show_on_home === 'on';
    if (stock !== undefined) p.stock = (stock || '').trim();
    if (total_stock !== undefined) p.total_stock = parseInt(total_stock || '0');
    if (weight !== undefined) p.weight = (weight || '').trim();
    if (active !== undefined) p.active = String(active || '').toLowerCase() === 'yes' || String(active || '').toLowerCase() === 'true' || active === 'on';
    if (gst_percent !== undefined) p.gst_percent = parseFloat(gst_percent || '0') || 0;
    if (req.file) p.image1_url = '/uploads/products/' + req.file.filename;
    p.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    saveDB(db);
    res.render('admin_product_edit', { product: p, error: null, success: 'Product updated' });
  } catch (e) {
    const id = parseInt(req.params.id);
    const p = (db.products || []).find(x => x.id === id);
    res.render('admin_product_edit', { product: p, error: 'Failed to update product', success: null });
  }
});

app.get('/admin/inventory', requireAuth('admin'), (req, res) => {
  const rows = (db.products || []).map(p => {
    const total = p.total_stock || 0;
    const sold = p.sold_stock || 0;
    const free = p.free_stock || 0;
    const scrap = p.scrap_stock || 0;
    const franchiseGiven = p.franchise_given_stock || 0;
    const balance = Math.max(0, total - sold - free - scrap - franchiseGiven);
    return {
      id: p.id,
      name: p.name,
      code: p.product_code || p.code || '',
      category: p.category || '',
      total_stock: total,
      sold_stock: sold,
      free_stock: free,
      scrap_stock: scrap,
      franchise_stock: franchiseGiven,
      balance_stock: balance,
      stock: p.stock || '',
      active: !!p.active
    };
  }).sort((a,b) => (a.name||'').localeCompare(b.name||''));
  const categories = Array.from(new Set(rows.map(r => r.category).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  res.render('admin_inventory', { items: rows, categories });
});

app.post('/admin/products/:id/stock', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = (db.products || []).find(x => x.id === id);
  if (!p) return res.status(404).json({ ok: false, error: 'Product not found' });
  const { total_stock, stock } = req.body || {};
  if (total_stock !== undefined) p.total_stock = parseInt(total_stock || '0');
  if (stock !== undefined) p.stock = String(stock || '').trim();
  p.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  return res.json({ ok: true, total_stock: p.total_stock || 0, stock: p.stock || '' });
});

app.post('/admin/products/:id/free-sample', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = (db.products || []).find(x => x.id === id);
  if (!p) return res.status(404).json({ ok: false, error: 'Product not found' });
  const qty = parseInt(req.body.quantity || '0', 10);
  if (qty <= 0) return res.status(400).json({ ok: false, error: 'Quantity must be > 0' });
  const total = p.total_stock || 0;
  const sold = p.sold_stock || 0;
  const free = p.free_stock || 0;
  const scrap = p.scrap_stock || 0;
  const franchiseGiven = p.franchise_given_stock || 0;
  const balance = total - sold - free - scrap - franchiseGiven;
  if (qty > balance) return res.status(400).json({ ok: false, error: 'Not enough balance stock. Available: ' + balance });
  p.free_stock = free + qty;
  p.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  if (!db.inventory_logs) db.inventory_logs = [];
  db.inventory_logs.push({ product_id: id, type: 'free_sample', quantity: qty, note: req.body.note || '', created_at: DateTime.now().setZone('Asia/Kolkata').toISO() });
  saveDB(db);
  const newBalance = Math.max(0, (p.total_stock || 0) - (p.sold_stock || 0) - (p.free_stock || 0) - (p.scrap_stock || 0) - (p.franchise_given_stock || 0));
  return res.json({ ok: true, free_stock: p.free_stock, balance_stock: newBalance });
});

app.post('/admin/products/:id/scrap', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = (db.products || []).find(x => x.id === id);
  if (!p) return res.status(404).json({ ok: false, error: 'Product not found' });
  const qty = parseInt(req.body.quantity || '0', 10);
  if (qty <= 0) return res.status(400).json({ ok: false, error: 'Quantity must be > 0' });
  const total = p.total_stock || 0;
  const sold = p.sold_stock || 0;
  const free = p.free_stock || 0;
  const scrap = p.scrap_stock || 0;
  const franchiseGiven = p.franchise_given_stock || 0;
  const balance = total - sold - free - scrap - franchiseGiven;
  if (qty > balance) return res.status(400).json({ ok: false, error: 'Not enough balance stock. Available: ' + balance });
  p.scrap_stock = scrap + qty;
  p.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  if (!db.inventory_logs) db.inventory_logs = [];
  db.inventory_logs.push({ product_id: id, type: 'scrap', quantity: qty, note: req.body.note || '', created_at: DateTime.now().setZone('Asia/Kolkata').toISO() });
  saveDB(db);
  const newBalance = Math.max(0, (p.total_stock || 0) - (p.sold_stock || 0) - (p.free_stock || 0) - (p.scrap_stock || 0) - (p.franchise_given_stock || 0));
  return res.json({ ok: true, scrap_stock: p.scrap_stock, balance_stock: newBalance });
});

app.delete('/admin/products/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = (db.products || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Product not found' });
  db.products.splice(idx, 1);
  saveDB(db);
  return res.json({ ok: true });
});

app.get('/admin/inventory/export', requireAuth('admin'), (req, res) => {
  const rows = (db.products || []).map(p => {
    const total = p.total_stock || 0;
    const sold = p.sold_stock || 0;
    const free = p.free_stock || 0;
    const scrap = p.scrap_stock || 0;
    const franchiseGiven = p.franchise_given_stock || 0;
    return {
      id: p.id,
      name: p.name || '',
      code: p.code || '',
      category: p.category || '',
      total_stock: total,
      sold_stock: sold,
      free_stock: free,
      scrap_stock: scrap,
      franchise_stock: franchiseGiven,
      balance_stock: Math.max(0, total - sold - free - scrap - franchiseGiven),
      stock: p.stock || ''
    };
  }).sort((a,b) => (a.name||'').localeCompare(b.name||''));
  const cols = ['ID','Name','Code','Category','Total Stock','Sold','Free/Sample','Franchise','Scrap','Balance','Status'];
  const q = v => {
    if (v == null) return '""';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [cols.map(c => q(c)).join(',')];
  rows.forEach(r => {
    lines.push([r.id, r.name, r.code, r.category, r.total_stock, r.sold_stock, r.free_stock, r.franchise_stock, r.scrap_stock, r.balance_stock, r.stock].map(q).join(','));
  });
  const csv = '\uFEFF' + lines.join('\n');
  const ts = new Date();
  const name = `inventory_${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
});

app.get('/admin/pins', requireAuth('admin'), (req, res) => {
  const filterStatus = String(req.query.filter || req.query.status || '').toLowerCase();
  const rows = (db.pin_packages || []).slice().reverse().filter(x => !x.archived_at).map(x => {
    const prod = (db.products || []).find(p => p.id === x.product_id);
    const user = x.used_by ? getUserById(x.used_by) : null;
    let assignedTo = null;
    if (x.assigned_to) {
      if (x.assigned_to_franchise) {
        const f = (db.franchises || []).find(fr => fr.id === x.assigned_to);
        if (f) assignedTo = f.franchise_code + ' (' + (f.member_name || f.username) + ')';
      } else {
        const u = getUserById(x.assigned_to);
        if (u) assignedTo = (u.user_code || u.username) + (u.member_name ? ' (' + u.member_name + ')' : '');
      }
    }
    let usedBy = null;
    if (x.used_by) {
      if (user) usedBy = (user.user_code || user.username) + (user.member_name ? ' (' + user.member_name + ')' : '');
    }
    let productName = 'Combo Plan';
    if (x.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === x.plan_id);
      if (plan) productName = plan.name;
    } else if (prod) {
      productName = prod.name;
    }
    return {
      id: x.id,
      code: x.code,
      login_pin: x.login_pin || null,
      product_name: productName,
      bv: x.plan_id ? (function(){ const plan = (db.plans||[]).find(pl=>pl.id===x.plan_id); const ids = Array.isArray(x.product_ids)?x.product_ids.slice():(plan&&plan.product_id?[plan.product_id]:[]); return ids.reduce((s,id)=>{ const pd=(db.products||[]).find(p=>p.id===id); return s + (pd ? (pd.bv||0) : 0); },0); })() : (prod ? (prod.bv || 0) : 0),
      status: (x.disabled ? 'disabled' : (x.status || (x.used_by ? 'used' : 'new'))),
      disabled: !!x.disabled,
      used_by: usedBy,
      assigned_to: assignedTo,
      used_at: x.used_at || null,
      created_at: x.created_at,
      expired_at: x.expired_at || null,
      is_matrix_pin: !!x.is_matrix_pin
    };
  }).filter(r => {
    if (!filterStatus) return true;
    if (filterStatus === 'unused') return r.status === 'new' || r.status === 'assigned';
    if (filterStatus === 'used') return r.status === 'used';
    return r.status === filterStatus;
  });
  const plans = (db.plans || []).filter(p => p.active !== false).map(p => {
    var pids = p.product_ids;
    if (typeof pids === 'string') { try { pids = JSON.parse(pids); } catch(e) { pids = []; } }
    if (!Array.isArray(pids) && p.product_id) pids = [p.product_id];
    if (!Array.isArray(pids)) pids = [];
    return { id: p.id, name: p.name, amount_inr: p.amount_inr || 0, product_ids: pids };
  });
  const products = (db.products || []).filter(p => p.active !== false).map(p => ({ id: p.id, name: p.name, bv: p.bv || 0 }));
  const franchises = (db.franchises || []).map(f => ({ id: f.id, code: f.franchise_code, name: f.member_name || f.username }));
  res.render('admin_pins', { pins: rows, filter: filterStatus, plans, products, franchises });
});

app.get('/admin/pins/export', requireAuth('admin'), (req, res) => {
  const status = String(req.query.status || '').toLowerCase();
  const rows = (db.pin_packages || []).slice().filter(x => !x.archived_at).map(x => {
    const prod = (db.products || []).find(p => p.id === x.product_id);
    const user = x.used_by ? getUserById(x.used_by) : null;
    let assignedTo = '';
    if (x.assigned_to) {
      if (x.assigned_to_franchise) {
        const f = (db.franchises || []).find(fr => fr.id === x.assigned_to);
        if (f) assignedTo = f.franchise_code + ' (' + (f.member_name || f.username) + ')';
      } else {
        const u = getUserById(x.assigned_to);
        if (u) assignedTo = (u.user_code || u.username) + (u.member_name ? ' (' + u.member_name + ')' : '');
      }
    }
    let usedBy = '';
    if (x.used_by && user) usedBy = (user.user_code || user.username) + (user.member_name ? ' (' + user.member_name + ')' : '');
    const statusVal = (x.disabled ? 'disabled' : (x.status || (x.used_by ? 'used' : 'new')));
    let productName = 'Combo Plan';
    if (x.plan_id) {
      const plan = (db.plans || []).find(pl => pl.id === x.plan_id);
      if (plan) productName = plan.name;
    } else if (prod) {
      productName = prod.name;
    }
    return {
      code: x.code,
      login_pin: x.login_pin || '',
      product_name: productName,
      bv: x.plan_id ? (function(){ const plan = (db.plans||[]).find(pl=>pl.id===x.plan_id); const ids = Array.isArray(x.product_ids)?x.product_ids.slice():(plan&&plan.product_id?[plan.product_id]:[]); return ids.reduce((s,id)=>{ const pd=(db.products||[]).find(p=>p.id===id); return s + (pd ? (pd.bv||0) : 0); },0); })() : (prod ? (prod.bv || 0) : 0),
      status: statusVal,
      assigned_to: assignedTo,
      used_by: usedBy,
      created_at: x.created_at || '',
      used_at: x.used_at || '',
      expired_at: x.expired_at || '',
      type: x.is_matrix_pin ? 'Matrix' : 'Normal'
    };
  }).filter(r => {
    if (!status) return true;
    return r.status === status;
  });
  const cols = ['Code','Login PIN','Product','BV','Status','Assigned To','Used By','Created At','Used At','Expired At','Type'];
  const q = v => {
    if (v == null) return '""';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [cols.map(c => q(c)).join(',')];
  rows.forEach(r => {
    lines.push([r.code,r.login_pin,r.product_name,r.bv,r.status,r.assigned_to,r.used_by,r.created_at,r.used_at,r.expired_at,r.type].map(q).join(','));
  });
  const csv = '\uFEFF' + lines.join('\n');
  const ts = new Date();
  const name = `pins_${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
});
app.get('/user/pins', requireAuth('user'), (req, res) => res.redirect('/pins'));

app.get('/pins', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const rows = (db.pin_packages || []).filter(x => x.assigned_to === user.id || x.used_by === user.id).slice().reverse().map(x => {
    const prod = (db.products || []).find(p => p.id === x.product_id);
    const plan = x.plan_id ? (db.plans || []).find(pl => pl.id === x.plan_id) : null;
    const by = x.assigned_by ? getUserById(x.assigned_by) : null;
    // Get product names for this PIN
    let productNames = '-';
    if (x.plan_id && plan) {
      const ids = Array.isArray(x.product_ids) ? x.product_ids.slice() : (plan.product_id ? [plan.product_id] : []);
      const prods = ids.map(id => (db.products || []).find(p => p.id === id)).filter(Boolean);
      productNames = prods.map(p => p.name).join(', ') || '-';
    } else if (prod) {
      productNames = prod.name;
    }
    return {
      code: x.code,
      login_pin: x.login_pin || null,
      plan_name: plan ? plan.name : null,
      product_name: productNames,
      bv: x.plan_id ? (function(){ const ids = Array.isArray(x.product_ids)?x.product_ids.slice():(plan&&plan.product_id?[plan.product_id]:[]); return ids.reduce((s,id)=>{ const pd=(db.products||[]).find(p=>p.id===id); return s + (pd ? (pd.bv||0) : 0); },0); })() : (prod ? (prod.bv || 0) : 0),
      status: (x.disabled ? 'disabled' : (x.status || (x.used_by ? 'used' : 'new'))),
      assigned_by: by ? by.user_code : null,
      used_by_code: x.used_by ? (function(){ const u=getUserById(x.used_by); return u ? (u.user_code||u.username) : '-'; })() : null,
      used_at: x.used_at || null,
      created_at: x.created_at,
      expired_at: x.expired_at || null,
      is_matrix_pin: !!x.is_matrix_pin
    };
  });
  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  res.render('user_pins', { user, pins: rows, sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null });
});

app.get('/reports/repurchase', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;

  const stats = getTeamRepurchaseStats(user.id, startISO, endISO);

  // Calculate daily, monthly, and total team repurchase BV
  const { start: dStart, end: dEnd } = todayRangeIST();
  const { start: mStart, end: mEnd } = monthRangeIST();

  const leftDailyBV = user.left_id ? subtreePVWithin(user.left_id, dStart, dEnd) : 0;
  const rightDailyBV = user.right_id ? subtreePVWithin(user.right_id, dStart, dEnd) : 0;
  const leftMonthlyBV = user.left_id ? subtreePVWithin(user.left_id, mStart, mEnd) : 0;
  const rightMonthlyBV = user.right_id ? subtreePVWithin(user.right_id, mStart, mEnd) : 0;
  const leftTotalBV = user.left_id ? subtreePVWithin(user.left_id, null, null) : 0;
  const rightTotalBV = user.right_id ? subtreePVWithin(user.right_id, null, null) : 0;

  // Get repurchase earnings for user (instead of orders)
  const repurchaseEarnings = (db.earnings || [])
    .filter(e => e.user_id === user.id && e.note === 'Repurchase binary pair match')
    .filter(e => {
      if (startISO && e.created_at < startISO) return false;
      if (endISO && e.created_at > endISO) return false;
      return true;
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const sponsor = user.sponsor_id ? getUserById(user.sponsor_id) : null;
  res.render('user_repurchase_report', {
    user,
    stats,
    repurchaseEarnings,
    from,
    to,
    teamBV: {
      left: { daily: leftDailyBV, monthly: leftMonthlyBV, total: leftTotalBV },
      right: { daily: rightDailyBV, monthly: rightMonthlyBV, total: rightTotalBV }
    },
    sponsor_info: sponsor ? { username: sponsor.username, user_code: sponsor.user_code || null, member_name: sponsor.member_name || null } : null,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});





app.get('/admin/docs', requireAuth('admin'), (req, res) => {
  const docs = (db.company_docs || []).slice().reverse();
  res.render('admin_docs', { docs, error: null, success: null });
});

app.get('/admin/ranks', requireAuth('admin'), (req, res) => {
  const ranks = ensureRankRules().slice().sort((a,b) => {
    const ao = typeof a.order === 'number' ? a.order : 0;
    const bo = typeof b.order === 'number' ? b.order : 0;
    if (ao !== bo) return ao - bo;
    return (a.left_pv + a.right_pv) - (b.left_pv + b.right_pv);
  });
  console.log('GET /admin/ranks - Ranks:', ranks.map(r => ({ id: r.id, name: r.name })));
  
  ranks.forEach(r => {
    const rankEarnings = (db.earnings || []).filter(e => e.note === 'Rank income' && e.rank_name === r.name);
    r.total_income = rankEarnings.reduce((sum, e) => sum + (e.gross_inr || 0), 0);
  });
  
  const stats = ranks.map(r => {
    const users = (db.users || []).filter(u => u.role === 'user' && getDynamicRank(u) === r.name);
    const count = users.length;
    const income = users.reduce((s, u) => s + lifetimeEarnings(u.id), 0);
    return { 
      id: r.id,
      name: r.name, 
      order: r.order,
      left_pv: r.left_pv,
      right_pv: r.right_pv,
      matching_condition: r.matching_condition,
      self_repurchase: r.self_repurchase,
      rank_income: r.rank_income,
      reward: r.reward,
      total_income: r.total_income || 0,
      count, 
      income 
    };
  });
  res.render('admin_ranks', {
    ranks,
    rankstats: stats,
    settings: getSettingsRow(),
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    error: null,
    success: req.query.msg || null
  });
});

app.get('/admin/plans', requireAuth('admin'), (req, res) => {
  const plans = (db.plans || []).slice().sort((a,b) => (a.name||'').localeCompare(b.name||''));
  const products = (db.products || []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, bv: p.bv }));
  res.render('admin_plans', { plans, products, success: req.query.msg || null, error: req.query.err || null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.post('/admin/plans', requireAuth('admin'), (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const amount_inr = parseFloat(req.body.amount_inr || '0') || 0;
    let productIds = [];
    const raw = req.body.product_ids || req.body.product_id || [];
    const arr = Array.isArray(raw) ? raw : (String(raw || '').includes(',') ? String(raw).split(',') : (raw ? [raw] : []));
    productIds = arr.map(x => parseInt(String(x), 10)).filter(n => !isNaN(n) && n > 0);
    const product_id = parseInt(req.body.product_id || (productIds[0] || '0'));
    const pv = parseFloat(req.body.pv || '0') || 0;
    const pair_amount_inr = parseFloat(req.body.pair_amount_inr || '0') || 0;
    const leadership_bonus_inr = parseFloat(req.body.leadership_bonus_inr || '0') || 0;
    const min_bv_for_leadership = parseFloat(req.body.min_bv_for_leadership || '0') || 0;
    const weekly_cap_pairs = parseInt(req.body.weekly_cap_pairs || '0') || 0;
    if (!name) return res.redirect('/admin/plans?err=Plan%20name%20required');
    let product_name = null;
    if (product_id) {
      const prod = (db.products || []).find(p => p.id === product_id);
      if (prod) {
        product_name = prod.name;
      }
    }
    const rec = {
      id: nextId('plan'),
      name,
      amount_inr,
      product_id: product_id || null,
      product_ids: productIds.length ? productIds : undefined,
      product_name: product_name,
      pv,
      pair_amount_inr: pair_amount_inr || null,
      leadership_bonus_inr,
      min_bv_for_leadership,
      weekly_cap_pairs,
      active: true,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      updated_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    db.plans.push(rec);
    saveDB(db);
    return res.redirect('/admin/plans?msg=Plan%20created');
  } catch (e) {
    return res.redirect('/admin/plans?err=Failed%20to%20create%20plan');
  }
});

app.post('/admin/plans/:id', requireAuth('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const p = (db.plans || []).find(x => x.id === id);
    if (!p) return res.redirect('/admin/plans?err=Plan%20not%20found');
    if (req.body.name !== undefined) p.name = String(req.body.name || '').trim();
    if (req.body.amount_inr !== undefined) p.amount_inr = parseFloat(req.body.amount_inr || '0') || 0;
    if (req.body.product_id !== undefined || req.body.product_ids !== undefined) {
      let productIds = [];
      const raw = req.body.product_ids || req.body.product_id || [];
      const arr = Array.isArray(raw) ? raw : (String(raw || '').includes(',') ? String(raw).split(',') : (raw ? [raw] : []));
      productIds = arr.map(x => parseInt(String(x), 10)).filter(n => !isNaN(n) && n > 0);
      const pid = productIds[0] ? productIds[0] : parseInt(req.body.product_id || '0');
      p.product_id = pid || null;
      p.product_ids = productIds.length ? productIds : undefined;
      if (pid) {
        const prod = (db.products || []).find(x => x.id === pid);
        p.product_name = prod ? prod.name : null;
      } else {
        p.product_name = null;
      }
    }
    if (req.body.pv !== undefined) p.pv = parseFloat(req.body.pv || '0') || 0;
    if (req.body.pair_amount_inr !== undefined) p.pair_amount_inr = parseFloat(req.body.pair_amount_inr || '0') || null;
    if (req.body.leadership_bonus_inr !== undefined) p.leadership_bonus_inr = parseFloat(req.body.leadership_bonus_inr || '0') || 0;
    if (req.body.min_bv_for_leadership !== undefined) p.min_bv_for_leadership = parseFloat(req.body.min_bv_for_leadership || '0') || 0;
    if (req.body.weekly_cap_pairs !== undefined) p.weekly_cap_pairs = parseInt(req.body.weekly_cap_pairs || '0') || 0;
    if (req.body.active !== undefined) p.active = String(req.body.active || '').toLowerCase() === 'yes' || String(req.body.active || '').toLowerCase() === 'true' || req.body.active === 'on';
    p.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    saveDB(db);
    return res.redirect('/admin/plans?msg=Plan%20updated');
  } catch (e) {
    return res.redirect('/admin/plans?err=Failed%20to%20update%20plan');
  }
});

app.delete('/admin/plans/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = (db.plans || []).findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Plan not found' });
  db.plans.splice(idx, 1);
  saveDB(db);
  return res.json({ ok: true });
});

app.post('/admin/plans/:id/delete', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = (db.plans || []).findIndex(x => x.id === id);
  if (idx === -1) return res.redirect('/admin/plans?err=Plan%20not%20found');
  db.plans.splice(idx, 1);
  saveDB(db);
  return res.redirect('/admin/plans?msg=Plan%20deleted');
});

app.get('/admin/plans/:id/edit', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = (db.plans || []).find(x => x.id === id);
  if (!plan) return res.redirect('/admin/plans?err=Plan%20not%20found');
  const products = (db.products || []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, bv: p.bv }));
  res.render('admin_plan_edit', { plan, products, success: req.query.msg || null, error: req.query.err || null, rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) });
});

app.post('/admin/ranks', requireAuth('admin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const left_pv = parseInt(req.body.left_pv || '0');
  const right_pv = parseInt(req.body.right_pv || '0');
  const order = parseInt(req.body.order || '0');
  const matching_condition = String(req.body.matching_condition || '1:1').trim();
  const self_repurchase = String(req.body.self_repurchase || '').trim();
  const rank_income = parseFloat(req.body.rank_income || '0');
  const reward = String(req.body.reward || '').trim();
  const deadline_value = parseInt(req.body.deadline_value || '0') || 0;
  const deadline_unit = String(req.body.deadline_unit || '').trim();
  if (!name) return res.render('admin_ranks', { ranks: ensureRankRules(), rankstats: [], rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }), error: 'Rank name is required', success: null });
  const rec = { id: nextId('rank_rule'), name, left_pv, right_pv, order, matching_condition, self_repurchase, rank_income, reward, deadline_value, deadline_unit, created_at: DateTime.now().setZone('Asia/Kolkata').toISO() };
  ensureRankRules().push(rec);
  saveDB(db);
  return res.redirect('/admin/ranks?msg=Rank%20added');
});

app.post('/admin/ranks/recompute', requireAuth('admin'), (req, res) => {
  updateRanksForAllUsers();
  return res.json({ ok: true });
});

app.post('/admin/ranks/toggle-income', requireAuth('admin'), (req, res) => {
  const settings = getSettingsRow();
  const val = req.body.rank_income_enabled;
  // Handle array (when both hidden input and checkbox are submitted)
  const isEnabled = Array.isArray(val) 
    ? val.includes('1') 
    : (val === '1' || val === 'true' || val === true);
  settings.rank_income_enabled = isEnabled;
  saveDB(db);
  return res.redirect('/admin/ranks?msg=Rank%20income%20settings%20updated');
});

app.post('/admin/ranks/toggle-star-winner', requireAuth('admin'), (req, res) => {
  const settings = getSettingsRow();
  const val = req.body.star_winner_enabled;
  const isEnabled = Array.isArray(val) 
    ? val.includes('1') 
    : (val === '1' || val === 'true' || val === true);
  settings.star_winner_enabled = isEnabled;
  settings.star_target_left = parseInt(req.body.star_target_left) || 2;
  settings.star_target_right = parseInt(req.body.star_target_right) || 2;
  saveDB(db);
  return res.redirect('/admin/ranks?msg=Star%20Winner%20settings%20updated');
});

app.post('/admin/ranks/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ranks = ensureRankRules();
  let r = ranks.find(x => parseInt(x.id) === id);
  if (!r) return res.status(404).json({ ok: false, error: 'Rank not found' });
  
  // Prevent editing STAR WINNER (fixed rank, id=-1)
  if (r.criteria_type === 'direct_joins_7_days' || r._fixed === true || r.id === -1 || id === -1) {
    return res.status(400).json({ ok: false, error: 'STAR WINNER rank cannot be modified' });
  }
  
  r.name = String(req.body.name || r.name).trim();
  r.left_pv = parseInt(req.body.left_pv || r.left_pv || '0');
  r.right_pv = parseInt(req.body.right_pv || r.right_pv || '0');
  r.order = parseInt(req.body.order || r.order || '0');
  r.matching_condition = String(req.body.matching_condition || r.matching_condition || '1:1').trim();
  r.self_repurchase = String(req.body.self_repurchase || r.self_repurchase || '').trim();
  r.rank_income = parseFloat(req.body.rank_income || r.rank_income || '0');
  r.reward = String(req.body.reward !== undefined ? req.body.reward : r.reward || '').trim();
  r.deadline_value = parseInt(req.body.deadline_value || r.deadline_value || '0') || 0;
  r.deadline_unit = String(req.body.deadline_unit !== undefined ? req.body.deadline_unit : r.deadline_unit || '').trim();
  if (req.body.active !== undefined) r.active = String(req.body.active || '').toLowerCase() === 'on' || String(req.body.active || '').toLowerCase() === 'yes' || String(req.body.active || '').toLowerCase() === 'true';
  r.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  return res.json({ ok: true });
});

app.delete('/admin/ranks/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ranks = ensureRankRules();
  const rank = ranks.find(x => parseInt(x.id) === id);
  if (!rank) return res.status(404).json({ ok: false, error: 'Rank not found' });
  
  // Prevent deleting STAR WINNER rank (fixed rank, id=-1)
  if (rank.criteria_type === 'direct_joins_7_days' || rank._fixed === true || rank.id === -1 || id === -1) {
    return res.status(400).json({ ok: false, error: 'STAR WINNER rank cannot be deleted' });
  }
  
  const idx = ranks.findIndex(x => parseInt(x.id) === id);
  ranks.splice(idx, 1);
  saveDB(db);
  return res.json({ ok: true });
});

// Admin: View payout invoice — COMBINE all payouts for same user+week (EXACT match with transactions page)
app.get('/admin/payout-combined/:userId/:year/:week', requireAuth('admin'), (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const payoutYear = parseInt(req.params.year, 10);
    const payoutWeek = parseInt(req.params.week, 10);
    if (!userId || !payoutYear || !payoutWeek) return res.status(400).send('Invalid parameters');

    const user = getUserById(userId);
    if (!user) return res.status(404).send('User not found');

    // Find ALL payouts for this user + same year + same week (EXACT same logic as userWeekMap)
    const weekPayouts = (db.payouts || []).filter(p => {
      if (String(p.user_id) !== String(userId)) return false;
      const d = new Date(p.created_at);
      return getWeekNumber(d) === payoutWeek && d.getFullYear() === payoutYear;
    });

    if (weekPayouts.length === 0) return res.status(404).send('No payouts found for this user and week');

    // Combine breakdown fields — EXACT same as transactions page userWeekMap
    let combinedBinaryGross = 0, combinedBinaryNet = 0;
    let combinedRepurchaseGross = 0, combinedRepurchaseNet = 0;
    let combinedLbGross = 0, combinedLbNet = 0;
    let combinedTds = 0, combinedAdmin = 0;
    let combinedAmount = 0, combinedPairs = 0;
    let anyCompleted = false;
    let latestDate = '';

    weekPayouts.forEach(p => {
      combinedBinaryGross += Number(p.binary_gross || 0);
      combinedBinaryNet += Number(p.binary_net || 0);
      combinedRepurchaseGross += Number(p.repurchase_gross || 0);
      combinedRepurchaseNet += Number(p.repurchase_net || 0);
      combinedLbGross += Number(p.lb_gross || 0);
      combinedLbNet += Number(p.lb_net || 0);
      combinedTds += Number(p.tds_inr || 0);
      combinedAdmin += Number(p.admin_charge_inr || 0);
      combinedAmount += Number(p.amount_inr || 0);
      combinedPairs += Number(p.pairs || 0);
      if (p.status === 'completed') anyCompleted = true;
      if (p.created_at > latestDate) latestDate = p.created_at;
    });

    const totalGross = combinedBinaryGross + combinedRepurchaseGross + combinedLbGross;
    const totalNet = combinedAmount || Math.max(0, Math.round((totalGross - combinedTds - combinedAdmin) * 100) / 100);

    const settings = getSettingsRow();
    const companyName = settings && settings.company_name ? settings.company_name : 'Nastige Industries Pvt. Ltd.';
    const companyAddress = settings && settings.company_address ? settings.company_address : 'Delhi, India';
    const companyPhone = settings && settings.company_phone ? settings.company_phone : '';
    const companyEmail = settings && settings.company_email ? settings.company_email : '';
    const companyGstin = settings && settings.company_gstin ? settings.company_gstin : '';

    const weekRange = getWeekRange(payoutWeek, payoutYear);
    const startDate = new Date(weekRange.start);
    const endDate = new Date(weekRange.end);
    const invoiceDate = latestDate ? new Date(latestDate) : new Date();

    const payoutIdForDisplay = weekPayouts[weekPayouts.length - 1].id;

    res.render('payout_invoice', {
      payout: {
        id: payoutIdForDisplay,
        user_id: userId,
        amount_inr: totalNet,
        gross_inr: totalGross,
        tds_inr: combinedTds,
        admin_charge_inr: combinedAdmin,
        status: anyCompleted ? 'completed' : 'pending',
        created_at: latestDate || DateTime.now().setZone('Asia/Kolkata').toISO(),
        pairs: combinedPairs,
        note: weekPayouts.length > 1 ? 'Combined Payout' : weekPayouts[0].note
      },
      user,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      company_name: companyName,
      company_address: companyAddress,
      company_phone: companyPhone,
      company_email: companyEmail,
      company_gstin: companyGstin,
      amount_words: inrToWords(totalNet),
      week_number: 'Week ' + payoutWeek + ', ' + payoutYear,
      start_date: startDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      end_date: endDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      invoice_date: invoiceDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      binary_income: combinedBinaryGross,
      repurchase_income: combinedRepurchaseGross,
      direct_income: combinedLbGross,
      other_income: 0,
      total_income: totalGross,
      tds_amt: combinedTds,
      admin_amt: combinedAdmin,
      total_deductions: combinedTds + combinedAdmin,
      net_payable: totalNet,
      earnings_count: weekPayouts.reduce((s, p) => {
        let eids = p.earning_ids || [];
        if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(e) { eids = []; } }
        return s + (Array.isArray(eids) ? eids.length : 0);
      }, 0),
      isAdmin: true
    });
  } catch (err) {
    console.error('Error in /admin/payout-combined:', err);
    res.status(500).send('Error loading invoice: ' + err.message);
  }
});

// Admin: View payout invoice — old route (by payout ID, fallback)
app.get('/admin/payout-invoice/:payoutId', requireAuth('admin'), (req, res) => {
  try {
    const payoutId = parseInt(req.params.payoutId, 10);
    const payout = (db.payouts || []).find(p => String(p.id) === String(payoutId));
    if (!payout) return res.status(404).send('Payout not found');
    
    const user = getUserById(payout.user_id);
    if (!user) return res.status(404).send('User not found');
    
    const userId = payout.user_id;
    
    // Determine week/year from THIS payout's date
    const pDate = new Date(payout.created_at);
    const payoutWeek = getWeekNumber(pDate);
    const payoutYear = pDate.getFullYear();
    
    // Find ALL payouts for same user + same week (EXACT same logic as transactions page userWeekMap)
    const weekPayouts = (db.payouts || []).filter(p => {
      if (String(p.user_id) !== String(userId)) return false;
      const d = new Date(p.created_at);
      return getWeekNumber(d) === payoutWeek && d.getFullYear() === payoutYear;
    });
    
    // Combine stored breakdown fields — same as transactions page (lines 15286-15312)
    let combinedBinaryGross = 0, combinedBinaryNet = 0;
    let combinedRepurchaseGross = 0, combinedRepurchaseNet = 0;
    let combinedLbGross = 0, combinedLbNet = 0;
    let combinedTds = 0, combinedAdmin = 0;
    let combinedAmount = 0, combinedPairs = 0;
    let combinedLbBonus = 0;
    let anyCompleted = false;
    let latestDate = '';
    
    weekPayouts.forEach(p => {
      combinedBinaryGross += Number(p.binary_gross || 0);
      combinedBinaryNet += Number(p.binary_net || 0);
      combinedRepurchaseGross += Number(p.repurchase_gross || 0);
      combinedRepurchaseNet += Number(p.repurchase_net || 0);
      combinedLbGross += Number(p.lb_gross || 0);
      combinedLbNet += Number(p.lb_net || 0);
      combinedTds += Number(p.tds_inr || 0);
      combinedAdmin += Number(p.admin_charge_inr || 0);
      combinedAmount += Number(p.amount_inr || 0);
      combinedPairs += Number(p.pairs || 0);
      combinedLbBonus += Number(p.leadership_bonus || 0);
      if (p.status === 'completed') anyCompleted = true;
      if (p.created_at > latestDate) latestDate = p.created_at;
    });
    
    const totalGross = combinedBinaryGross + combinedRepurchaseGross + combinedLbGross;
    const totalNet = combinedAmount || Math.max(0, Math.round((totalGross - combinedTds - combinedAdmin) * 100) / 100);
    
    const settings = getSettingsRow();
    const companyName = settings && settings.company_name ? settings.company_name : 'Nastige Industries Pvt. Ltd.';
    const companyAddress = settings && settings.company_address ? settings.company_address : 'Delhi, India';
    const companyPhone = settings && settings.company_phone ? settings.company_phone : '';
    const companyEmail = settings && settings.company_email ? settings.company_email : '';
    const companyGstin = settings && settings.company_gstin ? settings.company_gstin : '';
    
    const weekRange = getWeekRange(payoutWeek, payoutYear);
    const startDate = new Date(weekRange.start);
    const endDate = new Date(weekRange.end);
    const invoiceDate = new Date(latestDate || payout.created_at);
    
    res.render('payout_invoice', {
      payout: {
        id: payout.id,
        user_id: payout.user_id,
        amount_inr: totalNet,
        gross_inr: totalGross,
        tds_inr: combinedTds,
        admin_charge_inr: combinedAdmin,
        status: anyCompleted ? 'completed' : 'pending',
        created_at: latestDate || payout.created_at,
        pairs: combinedPairs,
        note: weekPayouts.length > 1 ? 'Combined Payout' : payout.note
      },
      user,
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      company_name: companyName,
      company_address: companyAddress,
      company_phone: companyPhone,
      company_email: companyEmail,
      company_gstin: companyGstin,
      amount_words: inrToWords(totalNet),
      week_number: 'Week ' + payoutWeek + ', ' + payoutYear,
      start_date: startDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      end_date: endDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      invoice_date: invoiceDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      binary_income: combinedBinaryGross,
      repurchase_income: combinedRepurchaseGross,
      direct_income: combinedLbGross,
      other_income: 0,
      total_income: totalGross,
      tds_amt: combinedTds,
      admin_amt: combinedAdmin,
      total_deductions: combinedTds + combinedAdmin,
      net_payable: totalNet,
      earnings_count: weekPayouts.reduce((s, p) => {
        let eids = p.earning_ids || [];
        if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(e) { eids = []; } }
        return s + (Array.isArray(eids) ? eids.length : 0);
      }, 0),
      isAdmin: true
    });
  } catch (err) {
    console.error('Error in /admin/payout-invoice:', err);
    res.status(500).send('Error loading invoice: ' + err.message);
  }
});

// Admin Transactions management (payout credentials)
app.get('/admin/transactions', requireAuth('admin'), (req, res) => {
  try {
    console.log('Loading transactions page...');
    
    // --- Inline self-healing: fix data consistency on each page load (idempotent) ---
    let healed = false;

    // Fix 1: Clear pending_leadership flag on already-credited LB earnings
    (db.earnings || []).forEach(e => {
      if (e.note === 'Leadership bonus' && e.status === 'credited' && (e.pending_leadership === true || e.pending_leadership === 1)) {
        e.pending_leadership = false;
        healed = true;
      }
    });

    // Fix 2: Rebuild breakdown fields for payouts missing them (binary_gross/lb_gross/repurchase_gross all zero)
    (db.payouts || []).forEach(p => {
      const bg = Number(p.binary_gross || 0);
      const rg = Number(p.repurchase_gross || 0);
      const lg = Number(p.lb_gross || 0);
      if (bg > 0 || rg > 0 || lg > 0) return;
      let eids = p.earning_ids || [];
      if (typeof eids === 'string') { try { eids = JSON.parse(eids); } catch(ex) { eids = []; } }
      if (!Array.isArray(eids) || eids.length === 0) return;
      const earnings = (db.earnings || []).filter(e => eids.includes(Number(e.id)) || eids.includes(String(e.id)));
      if (earnings.length === 0) return;
      let bG = 0, rG = 0, lG = 0, bP = 0, rP = 0;
      earnings.forEach(e => {
        const g = Number(e.gross_inr || 0);
        if (/Leadership/i.test(e.note || '')) { lG += g; }
        else if (/Repurchase.?binary/i.test(e.note || '')) { rG += g; rP += Number(e.pairs || 0); }
        else { bG += g; bP += Number(e.pairs || 0); }
      });
      const tg = bG + rG + lG;
      if (tg === 0) return;
      const tds = Math.round(tg * 0.02 * 100) / 100;
      const adm = Math.round(tg * 0.10 * 100) / 100;
      p.binary_gross = bG;
      p.binary_net = Math.max(0, Math.round((bG - Math.round(bG * 0.02 * 100) / 100 - Math.round(bG * 0.10 * 100) / 100) * 100) / 100);
      p.repurchase_gross = rG;
      p.repurchase_net = Math.max(0, Math.round((rG - Math.round(rG * 0.02 * 100) / 100 - Math.round(rG * 0.10 * 100) / 100) * 100) / 100);
      p.lb_gross = lG;
      p.lb_net = Math.max(0, Math.round((lG - Math.round(lG * 0.02 * 100) / 100 - Math.round(lG * 0.10 * 100) / 100) * 100) / 100);
      p.gross_inr = tg;
      p.tds_inr = tds;
      p.admin_charge_inr = adm;
      p.amount_inr = Math.max(0, Math.round((tg - tds - adm) * 100) / 100);
      p.pairs = bP + rP;
      p.leadership_bonus = p.lb_net || 0;
      healed = true;
    });

    // Fix 3: Create missing payout records from orphaned earnings
    const earningsByUserWeek = {};
    (db.earnings || []).forEach(e => {
      if (e.status !== 'credited' || !e.user_id) return;
      if (e.note !== 'Binary pair match' && e.note !== 'Repurchase binary pair match' && e.note !== 'Leadership bonus') return;
      const d = new Date(e.created_at);
      const key = `${e.user_id}-${d.getFullYear()}-${getWeekNumber(d)}`;
      if (!earningsByUserWeek[key]) earningsByUserWeek[key] = [];
      earningsByUserWeek[key].push(e);
    });
    const existingPayoutUserWeeks = new Set();
    (db.payouts || []).forEach(p => {
      const d = new Date(p.created_at);
      existingPayoutUserWeeks.add(`${p.user_id}-${d.getFullYear()}-${getWeekNumber(d)}`);
    });
    Object.entries(earningsByUserWeek).forEach(([key, earnings]) => {
      if (existingPayoutUserWeeks.has(key)) return;
      let gross = 0, net = 0, tds = 0, admin = 0, pairs = 0, bG = 0, rG = 0, lG = 0;
      earnings.forEach(e => {
        const g = Number(e.gross_inr || 0);
        gross += g;
        net += Number(e.net_inr || e.amount_inr || 0);
        tds += Number(e.tds_inr || 0);
        admin += Number(e.admin_charge_inr || 0);
        pairs += Number(e.pairs || 0);
        if (/Leadership/i.test(e.note || '')) lG += g;
        else if (/Repurchase/i.test(e.note || '')) rG += g;
        else bG += g;
      });
      if (gross === 0) return;
      const [userIdStr, yrStr, wkStr] = key.split('-');
      db.payouts.push({
        id: nextId('payout'),
        user_id: parseInt(userIdStr),
        earning_ids: earnings.map(e => e.id),
        amount_inr: net,
        gross_inr: gross,
        binary_gross: bG,
        binary_net: Math.max(0, Math.round((bG - Math.round(bG * 0.02 * 100) / 100 - Math.round(bG * 0.10 * 100) / 100) * 100) / 100),
        repurchase_gross: rG,
        repurchase_net: Math.max(0, Math.round((rG - Math.round(rG * 0.02 * 100) / 100 - Math.round(rG * 0.10 * 100) / 100) * 100) / 100),
        lb_gross: lG,
        lb_net: Math.max(0, Math.round((lG - Math.round(lG * 0.02 * 100) / 100 - Math.round(lG * 0.10 * 100) / 100) * 100) / 100),
        tds_inr: tds,
        admin_charge_inr: admin,
        status: 'pending',
        note: lG > 0 && bG > 0 ? 'Binary + Leadership' : lG > 0 ? 'Leadership' : bG > 0 && rG > 0 ? 'Binary + Repurchase' : bG > 0 ? 'Binary' : 'Repurchase',
        pairs: pairs,
        leadership_bonus: Math.max(0, Math.round((lG - Math.round(lG * 0.02 * 100) / 100 - Math.round(lG * 0.10 * 100) / 100) * 100) / 100),
        transfer_id: null,
        transfer_credentials: null,
        transfer_date: null,
        hold_payment: false,
        created_at: earnings[0].created_at
      });
      healed = true;
    });

    if (healed) {
      console.log('[TRANSACTIONS] Inline data healing applied, saving...');
      saveDB(db);
      mysqlAdapter.flushDirtySync();
    }
    // --- End inline self-healing ---

    const q = String(req.query.q || '').trim().toLowerCase();
    const weekwise = String(req.query.weekwise || '') === '1';
    const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
    
// Pre-index for fast lookups
const usersById = {};
(db.users || []).forEach(u => { usersById[u.id] = u; });
function fastUser(id) { return usersById[id] || null; }

// Pre-index earnings by user_id + week + year for leadership bonus
const lbByUserWeek = {};
(db.earnings || []).forEach(e => {
  if (e.note === 'Leadership bonus') {
    const d = new Date(e.created_at);
    const wk = getWeekNumber(d);
    const yr = d.getFullYear();
    const key = `${e.user_id}-${yr}-${wk}`;
    if (!lbByUserWeek[key]) lbByUserWeek[key] = [];
    lbByUserWeek[key].push(e);
  }
});

// Pre-index pin_packages by used_by
const pinsByUsedBy = {};
(db.pin_packages || []).forEach(pin => {
  if (pin.used_by) pinsByUsedBy[pin.used_by] = pin;
});

// Pre-compute plan leadership bonus map
const lbAmtByPlan = {};
(db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0).forEach(pl => {
  lbAmtByPlan[pl.id] = pl.leadership_bonus_inr || 0;
});
const defaultPlanLB = (db.plans || []).find(pl => pl.active && pl.leadership_bonus_inr > 0);
const defaultLbAmt = defaultPlanLB ? defaultPlanLB.leadership_bonus_inr : 0;

// Pre-index payouts by user_id for last transfer lookup
const payoutsByUser = {};
(db.payouts || []).forEach(p => {
  if (!payoutsByUser[p.user_id]) payoutsByUser[p.user_id] = [];
  payoutsByUser[p.user_id].push(p);
});

// Combine payouts by user for same week (merge binary + repurchase)
  const currentYear = new Date().getFullYear();
  const payoutsData = (db.payouts || []).filter(p => {
    const d = new Date(p.created_at);
    return d.getFullYear() >= currentYear;
  });
  const userWeekMap = {};
  
  payoutsData.forEach(p => {
    const date = new Date(p.created_at);
    const weekNumber = getWeekNumber(date);
    const year = date.getFullYear();
    const key = `${p.user_id}-${year}-${weekNumber}`;
    
    // If first payout for this user+week, create new combined record
    if (!userWeekMap[key]) {
      const u = fastUser(p.user_id);
      // Get LB from pre-indexed earnings
      const lbKey = `${p.user_id}-${year}-${weekNumber}`;
      const lbEarnings = lbByUserWeek[lbKey] || [];
      const leadershipTotal = lbEarnings.reduce((s, e) => s + (e.amount_inr || 0), 0);
      
      // Recalculate LB gross
      const recalcLBGross = lbEarnings.reduce((sum, e) => {
        const pin = pinsByUsedBy[e.source_user_id];
        let lbAmt = 0;
        if (pin && pin.plan_id) {
          lbAmt = lbAmtByPlan[pin.plan_id] || 0;
        }
        if (!lbAmt && e.plan_id) {
          lbAmt = lbAmtByPlan[e.plan_id] || 0;
        }
        if (!lbAmt) lbAmt = defaultLbAmt;
        return sum + lbAmt;
      }, 0);
      
      userWeekMap[key] = {
        id: p.id,
        user_id: p.user_id,
        user_code: u ? (u.user_code || u.username) : ('#' + p.user_id),
        member_name: u ? (u.member_name || null) : null,
        kyc_status: u ? (u.kyc_status || 'pending') : 'pending',
        bank_name: u ? (u.bank_name || null) : null,
        bank_account_number: u ? (u.bank_account_number || null) : null,
        bank_ifsc: u ? (u.bank_ifsc || null) : null,
        bank_account_name: u ? (u.bank_account_name || null) : null,
        bank_branch: u ? (u.bank_branch || null) : null,
        amount_inr: 0,
        gross_inr: 0,
        binary_gross: 0,
        binary_net: 0,
        repurchase_gross: 0,
        repurchase_net: 0,
        lb_gross: 0,
        lb_net: 0,
        tds_inr: 0,
        admin_charge_inr: 0,
        status: 'pending',
        note: 'Combined Payout',
        pairs: 0,
        leadership_bonus: 0,
        transfer_id: '',
        transfer_credentials: '',
        transfer_date: null,
        hold_payment: false,
        receipt_url: null,
        created_at: p.created_at,
        leadership_bonus_total: leadershipTotal || 0,
        recalc_lb_gross: recalcLBGross || 0,
        last_transfer_id: ''
      };
    }
    
    // Merge into combined record (use Number() to avoid string concatenation from MySQL DECIMAL)
    const combined = userWeekMap[key];
    combined.amount_inr += Number(p.amount_inr || p.amount || 0);
    combined.gross_inr += Number(p.gross_inr || p.amount_inr || p.amount || 0);
    combined.binary_gross += Number(p.binary_gross || 0);
    combined.binary_net += Number(p.binary_net || 0);
    combined.repurchase_gross += Number(p.repurchase_gross || 0);
    combined.repurchase_net += Number(p.repurchase_net || 0);
    combined.lb_gross += Number(p.lb_gross || 0);
    combined.lb_net += Number(p.lb_net || 0);
    combined.tds_inr += Number(p.tds_inr || 0);
    combined.admin_charge_inr += Number(p.admin_charge_inr || 0);
    combined.pairs += Number(p.pairs || 0);
    combined.leadership_bonus += Number(p.leadership_bonus || 0);
    if (p.status === 'completed') combined.status = 'completed';
    if (p.created_at > combined.created_at) {
      combined.created_at = p.created_at;
      combined.id = p.id;
    }
    if (combined.recalc_lb_gross === undefined) combined.recalc_lb_gross = 0;
    combined.recalc_lb_gross += (p.recalc_lb_gross || 0);
    if (p.transfer_id && p.transfer_date) {
      if (!combined.transfer_date || p.transfer_date > combined.transfer_date) {
        combined.transfer_id = p.transfer_id;
        combined.transfer_date = p.transfer_date;
      }
    }
    if (p.receipt_url) combined.receipt_url = p.receipt_url;
  });
  
  const allRows = Object.values(userWeekMap).sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
    
    const rows = allRows.filter(r => {
      if (!q) return true;
      const blob = [r.user_code, r.member_name, r.status, r.note, r.transfer_id, r.last_transfer_id].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(q);
    });
    
    // Week-wise grouping
    let weeklyGroups = null;
    let grandTotals = null;
    if (weekwise) {
      weeklyGroups = groupPayoutsByWeek(payoutsData.filter(p => {
        if (!q) return true;
        const u = fastUser(p.user_id);
        const blob = [u?.user_code, u?.username, u?.member_name, p.status, p.note, p.transfer_id].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(q);
      }));
      // Enrich weeklyGroups: format dateRange string, add user data to each payout
      weeklyGroups.forEach(g => {
        if (g.dateRange && typeof g.dateRange === 'object') {
          g.dateRange = g.dateRange.start + ' to ' + g.dateRange.end;
        }
        g.payouts.forEach(p => {
          const u = fastUser(p.user_id);
          if (u) {
            p.user_code = u.user_code || u.username || null;
            p.member_name = u.member_name || null;
            p.bank_name = u.bank_name || null;
            p.bank_account_number = u.bank_account_number || null;
            p.bank_ifsc = u.bank_ifsc || null;
            p.kyc_status = u.kyc_status || 'pending';
          }
        });
      });
      grandTotals = weeklyGroups.reduce((acc, g) => {
        acc.binary_gross += g.totals.binary_gross;
        acc.binary_net += g.totals.binary_net;
        acc.repurchase_gross += g.totals.repurchase_gross;
        acc.repurchase_net += g.totals.repurchase_net;
        acc.lb_gross += g.totals.lb_gross;
        acc.lb_net += g.totals.lb_net;
        acc.tds += g.totals.tds;
        acc.admin += g.totals.admin;
        acc.gross += g.totals.gross;
        acc.net += g.totals.net;
        acc.pairs += g.totals.pairs;
        acc.count += g.totals.count;
        return acc;
      }, { binary_gross: 0, binary_net: 0, repurchase_gross: 0, repurchase_net: 0, lb_gross: 0, lb_net: 0, tds: 0, admin: 0, gross: 0, net: 0, pairs: 0, count: 0 });
    }
    
    // Add week/year to each payout for combined invoice link
    rows.forEach(p => {
      const d = p.created_at ? new Date(p.created_at) : new Date();
      p._week = getWeekNumber(d);
      p._year = d.getFullYear();
    });
    
    console.log('Rendering page with', rows.length, 'rows', weekwise ? '(weekwise)' : '(flat)');
    res.render('admin_transactions', { payouts: rows, q, rupee, weekwise, weeklyGroups, grandTotals, db: { users: db.users || [] } });
  } catch (err) {
    console.error('Error in /admin/transactions:', err);
    res.status(500).send('Error loading transactions: ' + err.message);
  }
});

app.post('/admin/payouts/:id/transfer', requireAuth('admin'), (req, res) => {
  const id = req.params.id;
  const p = (db.payouts || []).find(x => String(x.id) === String(id));
  if (!p) return res.status(404).json({ ok: false, error: 'Payout not found' });
  const u = getUserById(p.user_id);
  if (!u || u.kyc_status !== 'verified') {
    return res.status(400).json({ ok: false, error: 'KYC not verified. Cannot update transfer details.' });
  }
  const utr = String(req.body.transfer_id || '').trim();
  const td = String(req.body.transfer_date || '').trim();
  
  if (!utr || !td) {
    return res.status(400).json({ ok: false, error: 'UTR and Date are required' });
  }
  
  // Identify all related payouts for this user and week
  const date = new Date(p.created_at);
  const weekNumber = getWeekNumber(date);
  const year = date.getFullYear();
  
  const relatedPayouts = (db.payouts || []).filter(x => 
    String(x.user_id) === String(p.user_id) && 
    getWeekNumber(new Date(x.created_at)) === weekNumber &&
    new Date(x.created_at).getFullYear() === year
  );
  
  // Update all of them
  relatedPayouts.forEach(rp => {
    rp.transfer_id = utr || null;
    const dt = new Date(td);
    if (isNaN(dt.getTime())) {
      rp.transfer_date = null;
    } else {
      const pad = n => String(n).padStart(2, '0');
      rp.transfer_date = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':00';
    }
    
    // Change status to completed when UTR and date are set
    if (rp.transfer_id && rp.transfer_date) {
      rp.status = 'completed';
    }
    rp.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  });
  
  saveDB(db);
  return res.json({ ok: true });
});

const receiptStorage = createCompressedStorage({
  destination: function(req, file, cb) { cb(null, RECEIPT_UPLOAD_DIR); },
  filename: function(req, file, cb) { 
    const ts = Date.now();
    const ext = path.extname(file.originalname || '') || '.jpg';
    cb(null, 'receipt_' + req.params.id + '_' + ts + ext); 
  },
  quality: 80,
  maxWidth: 1200,
  maxHeight: 1600
});
const uploadReceipt = multer({ storage: receiptStorage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (!file.originalname.match(/\.(pdf|jpe?g|png)$/i)) return cb(new Error('Only PDF, JPG, PNG allowed'));
  cb(null, true);
} });

app.post('/admin/payouts/:id/receipt', requireAuth('admin'), uploadReceipt.single('receipt'), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const p = (db.payouts || []).find(x => x.id === id);
    if (!p) return res.status(404).json({ ok: false, error: 'Payout not found' });
    const u = getUserById(p.user_id);
    if (!u || u.kyc_status !== 'verified') {
      return res.status(400).json({ ok: false, error: 'KYC not verified. Cannot upload receipt.' });
    }
    if (req.file) {
      p.receipt_url = '/receipts/' + req.file.filename;
      p.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
      saveDB(db);
    }
    return res.json({ ok: true, receipt_url: p.receipt_url });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/admin/payouts/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const payouts = db.payouts || [];
  const initialLength = payouts.length;
  db.payouts = payouts.filter(p => p.id !== id);
  if (db.payouts.length === initialLength) {
    return res.status(404).json({ ok: false, error: 'Payout not found' });
  }
  saveDB(db);
  return res.json({ ok: true });
});

app.get('/admin/reports/binary', requireAuth('admin'), (req, res) => {
  const rows = (db.earnings || [])
    .filter(e => e.note === 'Binary pair match')
    .map(e => {
      const u = getUserById(e.user_id);
      const gross = (typeof e.gross_inr === 'number') ? e.gross_inr : (e.amount_inr || 0);
      const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * 0.02 * 100) / 100;
      const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * 0.10 * 100) / 100;
      const net = (typeof e.net_inr === 'number') ? e.net_inr : Math.max(0, Math.round((gross - tds - admin) * 100) / 100);
      return {
        id: e.id,
        date: e.created_at,
        user_code: u ? (u.user_code || u.username) : ('#' + e.user_id),
        member_name: u ? (u.member_name || null) : null,
        pairs: e.pairs || 0,
        leg: e.leg || null,
        gross, tds, admin, net
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total_gross = rows.reduce((s, r) => s + (r.gross || 0), 0);
  const total_net = rows.reduce((s, r) => s + (r.net || 0), 0);
  res.render('admin_binary_report', {
    rows,
    total_gross,
    total_net,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/admin/reports/leadership', requireAuth('admin'), (req, res) => {
  const rows = (db.earnings || [])
    .filter(e => e.note === 'Leadership bonus')
    .map(e => {
      const u = getUserById(e.user_id);
      const plan = e.plan_id ? (db.plans || []).find(pl => pl.id === e.plan_id) : null;
      const gross = (typeof e.gross_inr === 'number') ? e.gross_inr : (e.amount_inr || 0);
      const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * 0.02 * 100) / 100;
      const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * 0.10 * 100) / 100;
      const net = (typeof e.net_inr === 'number') ? e.net_inr : Math.max(0, Math.round((gross - tds - admin) * 100) / 100);
      const sourceUser = e.source_user_id ? getUserById(e.source_user_id) : null;
      return {
        id: e.id,
        date: e.created_at,
        user_code: u ? (u.user_code || u.username) : ('#' + e.user_id),
        member_name: u ? (u.member_name || null) : null,
        source_member_name: sourceUser ? (sourceUser.member_name || null) : null,
        source_user_code: sourceUser ? (sourceUser.user_code || sourceUser.username) : null,
        source_pin_code: e.source_pin_code || null,
        plan_name: plan ? (plan.name || ('#' + e.plan_id)) : (e.plan_id ? ('#' + e.plan_id) : '-'),
        gross, tds, admin, net
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total_gross = rows.reduce((s, r) => s + (r.gross || 0), 0);
  const total_net = rows.reduce((s, r) => s + (r.net || 0), 0);
  res.render('admin_leadership_report', {
    rows,
    total_gross,
    total_net,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/admin/reports/repurchase', requireAuth('admin'), (req, res) => {
  // Show repurchase binary income (NOT orders - just like binary report shows income)
  const rows = (db.earnings || [])
    .filter(e => e.note === 'Repurchase binary pair match')
    .map(e => {
      const u = getUserById(e.user_id);
      const gross = (typeof e.gross_inr === 'number') ? e.gross_inr : (e.amount_inr || 0);
      const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * 0.02 * 100) / 100;
      const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * 0.10 * 100) / 100;
      const net = (typeof e.net_inr === 'number') ? e.net_inr : Math.max(0, Math.round((gross - tds - admin) * 100) / 100);
      return {
        id: e.id,
        date: e.created_at,
        user_code: u ? (u.user_code || u.username) : ('#' + e.user_id),
        member_name: u ? (u.member_name || null) : null,
        pairs: e.pairs || 0,
        leg: e.leg || null,
        gross, tds, admin, net
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total_gross = rows.reduce((s, r) => s + (r.gross || 0), 0);
  const total_net = rows.reduce((s, r) => s + (r.net || 0), 0);
  res.render('admin_repurchase_income_report', {
    rows,
    total_gross,
    total_net,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/admin/reports/income', requireAuth('admin'), (req, res) => {
  const type = String(req.query.type || 'all').toLowerCase();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;

  const noteFilters = {
    binary: ['Binary pair match'],
    repurchase: ['Repurchase binary pair match'],
    leadership: ['Leadership bonus'],
    all: ['Binary pair match', 'Repurchase binary pair match', 'Leadership bonus']
  };
  const allowedNotes = noteFilters[type] || noteFilters.all;

  const rows = (db.earnings || [])
    .filter(e => allowedNotes.includes(e.note))
    .filter(e => {
      if (startISO && e.created_at < startISO) return false;
      if (endISO && e.created_at > endISO) return false;
      return true;
    })
    .map(e => {
      const u = getUserById(e.user_id);
      const gross = (typeof e.gross_inr === 'number') ? e.gross_inr : (e.amount_inr || 0);
      const tds = (typeof e.tds_inr === 'number') ? e.tds_inr : Math.round(gross * 0.02 * 100) / 100;
      const admin = (typeof e.admin_charge_inr === 'number') ? e.admin_charge_inr : Math.round(gross * 0.10 * 100) / 100;
      const net = (typeof e.net_inr === 'number') ? e.net_inr : Math.max(0, Math.round((gross - tds - admin) * 100) / 100);
      let incomeType = 'Binary';
      if (e.note === 'Repurchase binary pair match') incomeType = 'Repurchase';
      else if (e.note === 'Leadership bonus') incomeType = 'Leadership';
      const plan = e.plan_id ? (db.plans || []).find(pl => pl.id === e.plan_id) : null;
      return {
        id: e.id,
        date: e.created_at,
        user_code: u ? (u.user_code || u.username) : ('#' + e.user_id),
        member_name: u ? (u.member_name || null) : null,
        income_type: incomeType,
        pairs: e.pairs || 0,
        leg: e.leg || null,
        source_pin_code: e.source_pin_code || null,
        plan_name: plan ? plan.name : null,
        gross, tds, admin, net
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const summary = {
    total_gross: rows.reduce((s, r) => s + r.gross, 0),
    total_tds: rows.reduce((s, r) => s + r.tds, 0),
    total_admin: rows.reduce((s, r) => s + r.admin, 0),
    total_net: rows.reduce((s, r) => s + r.net, 0),
    binary_count: rows.filter(r => r.income_type === 'Binary').length,
    repurchase_count: rows.filter(r => r.income_type === 'Repurchase').length,
    leadership_count: rows.filter(r => r.income_type === 'Leadership').length,
    total_count: rows.length
  };

  res.render('admin_income_report', {
    rows, summary, type, from, to,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/admin/reports/charges', requireAuth('admin'), (req, res) => {
  const rows = (db.earnings || []).slice();
  const totals = rows.reduce((acc, e) => {
    const v = normalizeAmounts(e);
    acc.tds += v.tds || 0;
    acc.admin += v.admin || 0;
    return acc;
  }, { tds: 0, admin: 0 });
  const weekly = groupEarningsByWeek(rows).map(g => {
    const t = summarizeEarnings(g.earnings);
    return { weekNumber: g.weekNumber, year: g.year, dateRange: g.dateRange, tds: t.tds, admin: t.admin };
    }).sort((a, b) => {
      if (a.year === b.year) return b.weekNumber - a.weekNumber;
      return b.year - a.year;
    });
  res.render('admin_charges_report', {
    totals,
    weekly,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

// Admin Rank Income Report
app.get('/admin/reports/rank-income', requireAuth('admin'), (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const startISO = from ? new Date(from + 'T00:00:00.000+05:30').toISOString() : null;
  const endISO = to ? new Date(to + 'T23:59:59.999Z').toISOString() : null;

  // Get all rank income earnings
  const rankIncomeEarnings = (db.earnings || [])
    .filter(e => e.note === 'Rank income')
    .filter(e => {
      if (startISO && e.created_at < startISO) return false;
      if (endISO && e.created_at > endISO) return false;
      return true;
    })
    .map(e => {
      const user = getUserById(e.user_id);
      return {
        id: e.id,
        user_id: e.user_id,
        user_code: user ? (user.user_code || user.username) : 'Unknown',
        member_name: user ? (user.member_name || '') : '',
        rank_name: e.rank_name || '',
        gross_inr: e.gross_inr || 0,
        tds_inr: e.tds_inr || 0,
        admin_charge_inr: e.admin_charge_inr || 0,
        net_inr: e.net_inr || 0,
        created_at: e.created_at
      };
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  // Calculate totals
  const totals = rankIncomeEarnings.reduce((acc, e) => {
    acc.count++;
    acc.gross += e.gross_inr;
    acc.tds += e.tds_inr;
    acc.admin += e.admin_charge_inr;
    acc.net += e.net_inr;
    return acc;
  }, { count: 0, gross: 0, tds: 0, admin: 0, net: 0 });

  // Group by rank
  const byRank = {};
  rankIncomeEarnings.forEach(e => {
    const rank = e.rank_name || 'Unknown';
    if (!byRank[rank]) byRank[rank] = { count: 0, gross: 0, net: 0 };
    byRank[rank].count++;
    byRank[rank].gross += e.gross_inr;
    byRank[rank].net += e.net_inr;
  });

  res.render('admin_rank_income_report', {
    earnings: rankIncomeEarnings,
    totals,
    byRank,
    from,
    to,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.post('/admin/docs', requireAuth('admin'), uploadCompanyDoc.single('doc'), (req, res) => {
  try {
    const title = String(req.body.title || '').trim() || (req.file ? (req.file.originalname || 'Document') : 'Document');
    const category = String(req.body.category || '').trim() || null;
    if (!req.file) return res.render('admin_docs', { docs: (db.company_docs || []).slice().reverse(), error: 'Please select a file', success: null });
    const rel = '/' + path.join('uploads', 'company_docs', req.file.filename).replace(/\\/g, '/');
    const rec = {
      id: nextId('company_doc'),
      title,
      category,
      url: rel,
      name: req.file.originalname || null,
      size: req.file.size || 0,
      mime: req.file.mimetype || null,
      uploaded_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    db.company_docs.push(rec);
    saveDB(db);
    res.render('admin_docs', { docs: (db.company_docs || []).slice().reverse(), error: null, success: 'Document uploaded' });
  } catch (e) {
    res.render('admin_docs', { docs: (db.company_docs || []).slice().reverse(), error: 'Upload failed', success: null });
  }
});

app.delete('/admin/docs/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = (db.company_docs || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Document not found' });
  const rec = db.company_docs[idx];
  const abs = path.join(__dirname, '..', 'public', rec.url.replace(/^\//,''));
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (_) {}
  db.company_docs.splice(idx, 1);
  saveDB(db);
  return res.json({ ok: true });
});

app.post('/admin/docs/:id/title', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = (db.company_docs || []).find(d => d.id === id);
  if (!doc) return res.status(404).json({ ok: false, error: 'Document not found' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'Title is required' });
  doc.title = title;
  doc.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  return res.json({ ok: true });
});

app.post('/admin/pins/:code/toggle', requireAuth('admin'), (req, res) => {
  const code = String(req.params.code || '').trim();
  const p = (db.pin_packages || []).find(x => x.code === code);
  if (!p) return res.status(404).json({ ok: false, error: 'PIN not found' });
  if (p.used_by) return res.status(400).json({ ok: false, error: 'Cannot change used PIN' });
  p.disabled = !p.disabled;
  if (p.disabled) {
    p.status = 'disabled';
  } else {
    if (p.status === 'disabled') p.status = p.assigned_to ? 'assigned' : 'new';
  }
  saveDB(db);
  return res.json({ ok: true, disabled: !!p.disabled, status: p.status || null });
});

app.post('/admin/pins/:code/assign', requireAuth('admin'), (req, res) => {
  const code = String(req.params.code || '').trim();
  const toRef = String(req.body.assign_to || '').trim();
  const p = (db.pin_packages || []).find(x => x.code === code);
  if (!p) return res.status(404).json({ ok: false, error: 'PIN not found' });
  if (p.used_by) return res.status(400).json({ ok: false, error: 'Cannot assign used PIN' });
  if (p.disabled || p.status === 'expired') return res.status(400).json({ ok: false, error: 'PIN not active' });
  let target = getUserByRef(toRef);
  let isFranchise = false;
  if (!target) {
    target = (db.franchises || []).find(f => (f.franchise_code || '').toUpperCase() === toRef.toUpperCase() || (f.username || '').toUpperCase() === toRef.toUpperCase());
    isFranchise = !!target;
  }
  if (!target) return res.status(404).json({ ok: false, error: 'Target user/franchise not found' });
  p.assigned_to = target.id;
  p.assigned_by = req.session.user.id;
  p.assigned_to_franchise = isFranchise;
  p.status = 'assigned';
  saveDB(db);
  return res.json({ ok: true, assigned_to: isFranchise ? target.franchise_code : (target.user_code || target.username) });
});

app.post('/admin/pins/assign-all', requireAuth('admin'), (req, res) => {
  const toRef = String(req.body.assign_to || '').trim();
  let target = getUserByRef(toRef);
  let isFranchise = false;
  if (!target) {
    target = (db.franchises || []).find(f => (f.franchise_code || '').toUpperCase() === toRef.toUpperCase() || (f.username || '').toUpperCase() === toRef.toUpperCase());
    isFranchise = !!target;
  }
  if (!target) return res.status(404).json({ ok: false, error: 'Target user/franchise not found' });
  const pins = (db.pin_packages || []);
  let count = 0;
  pins.forEach(p => {
    if (!p.used_by && !p.assigned_to && !p.disabled && p.status !== 'expired') {
      p.assigned_to = target.id;
      p.assigned_by = req.session.user.id;
      p.assigned_to_franchise = isFranchise;
      p.status = 'assigned';
      count++;
    }
  });
  saveDB(db);
  return res.json({ ok: true, assigned_to: (isFranchise ? target.franchise_code : (target.user_code || target.username)), count });
});

app.post('/admin/pins/assign-selected', requireAuth('admin'), (req, res) => {
  const toRef = String(req.body.assign_to || '').trim();
  const pinCodes = Array.isArray(req.body.pin_codes) ? req.body.pin_codes : [];
  if (!toRef) return res.status(400).json({ ok: false, error: 'Target user required' });
  if (pinCodes.length === 0) return res.status(400).json({ ok: false, error: 'Select at least one PIN' });
  let target = getUserByRef(toRef);
  let isFranchise = false;
  if (!target) {
    target = (db.franchises || []).find(f => (f.franchise_code || '').toUpperCase() === toRef.toUpperCase() || (f.username || '').toUpperCase() === toRef.toUpperCase());
    isFranchise = !!target;
  }
  if (!target) return res.status(404).json({ ok: false, error: 'Target user/franchise not found' });
  let count = 0;
  pinCodes.forEach(code => {
    const p = (db.pin_packages || []).find(x => x.code === code);
    if (p && !p.used_by && !p.assigned_to && !p.disabled && p.status !== 'expired') {
      p.assigned_to = target.id;
      p.assigned_by = req.session.user.id;
      p.assigned_to_franchise = isFranchise;
      p.status = 'assigned';
      count++;
    }
  });
  saveDB(db);
  return res.json({ ok: true, assigned_to: (isFranchise ? target.franchise_code : (target.user_code || target.username)), count });
});
app.post('/admin/pins/:code/expire', requireAuth('admin'), (req, res) => {
  const code = String(req.params.code || '').trim();
  const p = (db.pin_packages || []).find(x => x.code === code);
  if (!p) return res.status(404).json({ ok: false, error: 'PIN not found' });
  p.status = 'expired';
  p.expired_at = DateTime.now().setZone('Asia/Kolkata').toISO();
  saveDB(db);
  return res.json({ ok: true });
});

app.post('/admin/pins/:code/delete', requireAuth('admin'), (req, res) => {
  const code = String(req.params.code || '').trim();
  const idx = (db.pin_packages || []).findIndex(x => x.code === code);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'PIN not found' });
  db.pin_packages.splice(idx, 1);
  saveDB(db);
  return res.json({ ok: true });
});

app.delete('/admin/pins/:code', requireAuth('admin'), (req, res) => {
  const code = String(req.params.code || '').trim();
  const idx = (db.pin_packages || []).findIndex(x => x.code === code);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'PIN not found' });
  db.pin_packages.splice(idx, 1);
  saveDB(db);
  return res.json({ ok: true });
});

app.get('/admin/next-code', requireAuth('admin'), (req, res) => {
  const parent = getUserByRef(req.query.parent_username || req.query.parent_ref);
  let side = String(req.query.side || '').toLowerCase();
  if (!parent || !['left', 'right'].includes(side)) {
    return res.status(400).json({ error: 'Invalid parent or side' });
  }
  let adjusted = false;
  if (side === 'left' && parent.left_id) {
    if (!parent.right_id) { side = 'right'; adjusted = true; }
    else return res.json({ taken: true, both_filled: true, parent: parent.username });
  } else if (side === 'right' && parent.right_id) {
    if (!parent.left_id) { side = 'left'; adjusted = true; }
    else return res.json({ taken: true, both_filled: true, parent: parent.username });
  }
  const parentIndex = parent.index_num || 1;
  const index_num = side === 'left' ? parentIndex * 2 : parentIndex * 2 + 1;
  const member_code = String(index_num);
  return res.json({ index_num, member_code, parent: parent.username, side, auto_adjusted: adjusted });
});

app.get('/next-code', (req, res) => {
  const parent = getUserByRef(req.query.parent_username || req.query.parent_ref);
  let side = String(req.query.side || '').toLowerCase();
  if (!parent || !['left', 'right'].includes(side)) {
    return res.status(400).json({ error: 'Invalid parent or side' });
  }
  let adjusted = false;
  if (side === 'left' && parent.left_id) {
    if (!parent.right_id) { side = 'right'; adjusted = true; }
    else return res.json({ taken: true, both_filled: true, parent: parent.username });
  } else if (side === 'right' && parent.right_id) {
    if (!parent.left_id) { side = 'left'; adjusted = true; }
    else return res.json({ taken: true, both_filled: true, parent: parent.username });
  }
  const parentIndex = parent.index_num || 1;
  const index_num = side === 'left' ? parentIndex * 2 : parentIndex * 2 + 1;
  const member_code = String(index_num);
  return res.json({ index_num, member_code, parent: parent.username, side, auto_adjusted: adjusted });
});

app.get('/admin/next-user-code', requireAuth('admin'), (req, res) => {
  const code = generateUserCode6();
  res.json({ user_code: code });
});

app.get('/admin/check-user-code', requireAuth('admin'), (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!/^(?:NIPL)\d{6}$/.test(code)) return res.json({ valid: false, exists: false });
  const exists = !!db.users.find(u => u.user_code === code);
  res.json({ valid: true, exists });
});

app.get('/admin/gen-pins', requireAuth('admin'), (req, res) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function rand(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  const package_pin = rand(12);
  const login_pin = String(Math.floor(100000 + Math.random() * 900000));
  res.json({ package_pin, login_pin });
});

app.post('/admin/pin-packages', requireAuth('admin'), (req, res) => {
  try {
    const product_id = parseInt(req.body.product_id || '0');
    const product = db.products.find(p => p.id === product_id && p.active);
    if (!product) return res.status(400).json({ ok: false, error: 'Invalid product' });

    // Get BV from plan if product is linked to a plan, else use product BV
    const linkedPlan = (db.plans || []).find(pl => pl.active && (pl.product_id === product_id || (pl.product_ids && pl.product_ids.includes(product_id))));
    let pinBV = product.bv || 0;
    let planName = null;
    if (linkedPlan) {
      pinBV = linkedPlan.pv || linkedPlan.bv || pinBV;
      planName = linkedPlan.name;
    }

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    let code = null;
    do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
    const login_pin = String(Math.floor(100000 + Math.random() * 900000));
    let assigned_to = null;
    if (req.body.assign_to) {
      const u = getUserByRef(String(req.body.assign_to).trim());
      if (u) assigned_to = u.id;
    }
    const rec = {
      id: nextId('pin_package'),
      code,
      login_pin,
      product_id: product.id,
      bv: pinBV,
      plan_id: linkedPlan ? linkedPlan.id : null,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      assigned_to,
      assigned_by: req.session.user.id,
      used_by: null,
      used_at: null,
      status: assigned_to ? 'assigned' : 'new'
    };
    db.pin_packages.push(rec);
    saveDB(db);
    return res.json({ ok: true, package_pin: rec.code, login_pin: rec.login_pin, product: { id: product.id, name: product.name, bv: pinBV, plan_name: planName }, assigned_to: assigned_to || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to create pin package' });
  }
});

app.post('/admin/pin-packages/bulk', requireAuth('admin'), (req, res) => {
  try {
    const product_id = parseInt(req.body.product_id || '0');
    const quantity = Math.max(1, Math.min(parseInt(req.body.quantity || '1'), 200));
    const product = db.products.find(p => p.id === product_id && p.active);
    if (!product) return res.status(400).json({ ok: false, error: 'Invalid product' });

    // Get BV from plan if product is linked to a plan, else use product BV
    const linkedPlan = (db.plans || []).find(pl => pl.active && (pl.product_id === product_id || (pl.product_ids && pl.product_ids.includes(product_id))));
    let pinBV = product.bv || 0;
    let planName = null;
    if (linkedPlan) {
      pinBV = linkedPlan.pv || linkedPlan.bv || pinBV;
      planName = linkedPlan.name;
    }

    let assigned_to = null;
    if (req.body.assign_to) {
      const u = getUserByRef(String(req.body.assign_to).trim());
      if (u) assigned_to = u.id;
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    const items = [];
    for (let i = 0; i < quantity; i++) {
      let code = null;
      do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
      const login_pin = String(Math.floor(100000 + Math.random() * 900000));
      const rec = {
        id: nextId('pin_package'),
        code,
        login_pin,
        product_id: product.id,
        bv: pinBV,
        plan_id: linkedPlan ? linkedPlan.id : null,
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        assigned_to: assigned_to || null,
        assigned_by: req.session.user.id,
        used_by: null,
        used_at: null,
        status: assigned_to ? 'assigned' : 'new'
      };
      db.pin_packages.push(rec);
      items.push({ package_pin: rec.code, login_pin: rec.login_pin });
    }
    saveDB(db);
    return res.json({ ok: true, count: items.length, items, product: { id: product.id, name: product.name, bv: pinBV, plan_name: planName }, assigned_to: assigned_to || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to bulk create pin packages' });
  }
});

app.post('/admin/plan-pin', requireAuth('admin'), (req, res) => {
  try {
    const plan_id = parseInt(req.body.plan_id || '0');
    const plan = (db.plans || []).find(pl => pl.id === plan_id && pl.active);
    if (!plan) return res.status(400).json({ ok: false, error: 'Invalid plan' });
    const ids = Array.isArray(plan.product_ids) ? plan.product_ids.slice() : (plan.product_id ? [plan.product_id] : []);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Plan has no products' });
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) { let s=''; for (let i=0;i<n;i++) s += chars[Math.floor(Math.random()*chars.length)]; return s; }
    let code = null; do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
    const login_pin = String(Math.floor(100000 + Math.random() * 900000));
    const rec = {
      id: nextId('pin_package'),
      code,
      login_pin,
      plan_id: plan.id,
      product_ids: ids,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      assigned_to: null,
      assigned_by: req.session.user.id,
      used_by: null,
      used_at: null,
      status: 'new',
      bundle: true,
      bundle_split: 'equal'
    };
    (db.pin_packages || (db.pin_packages=[])).push(rec);
    saveDB(db);
    return res.json({ ok: true, package_pin: rec.code, login_pin: rec.login_pin, plan: { id: plan.id, name: plan.name, amount_inr: plan.amount_inr || 0 }, products: ids });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to create plan pin' });
  }
});

app.post('/admin/plan-pin/bulk', requireAuth('admin'), (req, res) => {
  try {
    const plan_id = parseInt(req.body.plan_id || '0');
    const quantity = Math.max(1, Math.min(parseInt(req.body.quantity || '1'), 200));
    const plan = (db.plans || []).find(pl => pl.id === plan_id && pl.active);
    if (!plan) return res.status(400).json({ ok: false, error: 'Invalid plan' });
    const ids = Array.isArray(plan.product_ids) ? plan.product_ids.slice() : (plan.product_id ? [plan.product_id] : []);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Plan has no products' });
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) { let s=''; for (let i=0;i<n;i++) s += chars[Math.floor(Math.random()*chars.length)]; return s; }
    const items = [];
    for (let i = 0; i < quantity; i++) {
      let code = null; do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
      const login_pin = String(Math.floor(100000 + Math.random() * 900000));
      const rec = {
        id: nextId('pin_package'),
        code,
        login_pin,
        plan_id: plan.id,
        product_ids: ids,
        created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
        assigned_to: null,
        assigned_by: req.session.user.id,
        used_by: null,
        used_at: null,
        status: 'new',
        bundle: true,
        bundle_split: 'equal'
      };
      (db.pin_packages || (db.pin_packages=[])).push(rec);
      items.push({ package_pin: rec.code, login_pin: rec.login_pin });
    }
    saveDB(db);
    return res.json({ ok: true, count: items.length, items, plan: { id: plan.id, name: plan.name, amount_inr: plan.amount_inr || 0 }, products: ids });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to bulk create plan pins' });
  }
});

app.post('/admin/pin-packages/matrix', requireAuth('admin'), (req, res) => {
  try {
    const plan_id = parseInt(req.body.plan_id || '0');
    const left_count = parseInt(req.body.left_count || '10');
    const right_count = parseInt(req.body.right_count || '10');
    const plan = (db.plans || []).find(pl => pl.id === plan_id && pl.active);
    if (!plan) return res.status(400).json({ ok: false, error: 'Invalid plan' });
    const ids = Array.isArray(plan.product_ids) ? plan.product_ids.slice() : (plan.product_id ? [plan.product_id] : []);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Plan has no products' });
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function rand(n) { let s=''; for (let i=0;i<n;i++) s += chars[Math.floor(Math.random()*chars.length)]; return s; }
    let code = null; do { code = rand(12); } while ((db.pin_packages || []).find(p => p.code === code));
    const login_pin = String(Math.floor(100000 + Math.random() * 900000));
    const rec = {
      id: nextId('pin_package'),
      code,
      login_pin,
      plan_id: plan.id,
      product_ids: ids,
      is_matrix_pin: true,
      left_count,
      right_count,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO(),
      assigned_to: null,
      assigned_by: req.session.user.id,
      used_by: null,
      used_at: null,
      status: 'new',
      bundle: true,
      bundle_split: 'equal'
    };
    (db.pin_packages || (db.pin_packages=[])).push(rec);
    saveDB(db);
    return res.json({ ok: true, package_pin: rec.code, login_pin: rec.login_pin, plan: { id: plan.id, name: plan.name }, left_count, right_count, products: ids });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to create matrix pin' });
  }
});

app.get('/id/next', (req, res) => {
  res.json({ user_code: generateUserCode6() });
});

app.get('/id/check', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!/^(?:NIPL)\d{6}$/.test(code)) return res.json({ valid: false, exists: false });
  const exists = !!db.users.find(u => u.user_code === code);
  res.json({ valid: true, exists });
});

app.post('/admin/settings', requireAuth('admin'), (req, res) => {
  const { pv_on_join, pair_amount_inr, pair_bv_size, weekly_cap_inr, weekly_cap_pairs, weekly_flush_day, weekly_flush_time, company_gstin, next_payout_date } = req.body;
  const auto_binary_on_bv = ('auto_binary_on_bv' in req.body) ? (req.body.auto_binary_on_bv === '1' || req.body.auto_binary_on_bv === 'true' || req.body.auto_binary_on_bv === true) : undefined;
  updateSettings({
    pv_on_join: parseInt(pv_on_join),
    pair_amount_inr: parseInt(pair_amount_inr),
    pair_bv_size: pair_bv_size !== undefined ? parseInt(pair_bv_size) : undefined,
    weekly_cap_inr: weekly_cap_inr !== undefined ? parseInt(weekly_cap_inr) : undefined,
    weekly_cap_pairs: weekly_cap_pairs !== undefined ? parseInt(weekly_cap_pairs) : undefined,
    auto_binary_on_bv,
    weekly_flush_day,
    weekly_flush_time,
    company_gstin: (company_gstin !== undefined) ? String(company_gstin).trim() : undefined
  });
  const s = getSettingsRow();
  const usersCount = db.users.filter(u => u.role === 'user').length;
  const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
  try {
    if (next_payout_date) {
      const dt = DateTime.fromISO(String(next_payout_date), { zone: 'Asia/Kolkata' });
      if (dt.isValid) {
        db.settings.next_payout_date = dt.toISO();
      } else {
        db.settings.next_payout_date = nextFlushDateISO(s);
      }
    } else {
      db.settings.next_payout_date = nextFlushDateISO(s);
    }
    saveDB(db);
  } catch (_) {}
  const pinAll = db.pin_packages || [];
  const pinTotal = pinAll.length;
  const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
  const pinExpired = pinAll.filter(p => p.status === 'expired').length;
  const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
  const { start: dStart, end: dEnd } = todayRangeIST();
  const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;

  // Charts data
  const today = DateTime.now().setZone('Asia/Kolkata');
  const userRegistrations = [];
  for (let i = 6; i >= 0; i--) {
    const date = today.minus({ days: i });
    const dateStr = date.toFormat('yyyy-MM-dd');
    const count = (db.users || []).filter(u => u.role === 'user' && u.created_at && u.created_at.startsWith(dateStr)).length;
    userRegistrations.push({
      date: date.toFormat('MMM dd'),
      count
    });
  }

  const earningsTrend = [];
  for (let i = 6; i >= 0; i--) {
    const date = today.minus({ days: i });
    const dateStr = date.toFormat('yyyy-MM-dd');
    const total = (db.earnings || []).filter(e => e.created_at && e.created_at.startsWith(dateStr)).reduce((sum, e) => sum + (e.amount_inr || 0), 0);
    earningsTrend.push({
      date: date.toFormat('MMM dd'),
      amount: total
    });
  }

  const topEarners = (db.users || [])
    .filter(u => u.role === 'user')
    .map(u => ({
      username: u.username,
      total_earnings: (db.earnings || []).filter(e => e.user_id === u.id).reduce((sum, e) => sum + (e.amount_inr || 0), 0)
    }))
    .sort((a, b) => b.total_earnings - a.total_earnings)
    .slice(0, 10);

  const payoutByRank = {};
  (db.users || []).filter(u => u.role === 'user' && u.rank_name).forEach(u => {
    const total = (db.earnings || []).filter(e => e.user_id === u.id).reduce((sum, e) => sum + (e.amount_inr || 0), 0);
    payoutByRank[u.rank_name] = (payoutByRank[u.rank_name] || 0) + total;
  });
  const payoutByRankArray = Object.entries(payoutByRank).map(([rank_name, total]) => ({ rank_name, total })).sort((a, b) => b.total - a.total);

  res.render('admin', {
    settings: s,
    stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    message: 'Settings updated',
    pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
    charts: {
      userRegistrations,
      earningsTrend,
      topEarners,
      payoutByRank: payoutByRankArray
    }
  });
});

app.get('/admin/sponsor', requireAuth('admin'), (req, res) => {
  const uname = db.settings.default_sponsor_username || 'admin';
  const u = getUserByUsername(uname) || db.users.find(x => x.role === 'admin') || null;
  if (!u) return res.json({ ok: false, error: 'No admin user found' });
  res.json({ ok: true, username: u.username, user_code: u.user_code || null });
});

app.post('/admin/sponsor', requireAuth('admin'), (req, res) => {
  const uname = String(req.body.username || '').trim();
  const u = uname ? getUserByUsername(uname) : null;
  if (!u) {
    const s = getSettingsRow();
    const usersCount = db.users.filter(x => x.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'Sponsor username not found',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  }
  updateSettings({ default_sponsor_username: u.username });
  const s = getSettingsRow();
  const usersCount = db.users.filter(x => x.role === 'user').length;
  const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
  const pinAll = db.pin_packages || [];
  const pinTotal = pinAll.length;
  const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
  const pinExpired = pinAll.filter(p => p.status === 'expired').length;
  const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
  const { start: dStart, end: dEnd } = todayRangeIST();
  const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
  return res.render('admin', {
    settings: s,
    stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
    message: `Default sponsor set to ${u.username} (${u.user_code || '-'})`,
    pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
    charts: generateChartsData(db)
  });
});

app.post('/admin/sponsor/password', requireAuth('admin'), (req, res) => {
  const sUname = db.settings.default_sponsor_username || 'admin';
  const u = getUserByUsername(sUname);
  const np = String(req.body.new_password || '');
  const cp = String(req.body.confirm_password || '');
  if (!u) {
    const s = getSettingsRow();
    const usersCount = db.users.filter(x => x.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'Default sponsor user not found',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  }
  if (np.length < 6) {
    const s = getSettingsRow();
    const usersCount = db.users.filter(x => x.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'Password must be at least 6 characters',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  }
  if (np !== cp) {
    const s = getSettingsRow();
    const usersCount = db.users.filter(x => x.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'Passwords do not match',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  }
  u.password_hash = bcrypt.hashSync(np, 10);
  saveDB(db);
  const s = getSettingsRow();
  const usersCount = db.users.filter(x => x.role === 'user').length;
  const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
  const pinAll = db.pin_packages || [];
  const pinTotal = pinAll.length;
  const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
  const pinExpired = pinAll.filter(p => p.status === 'expired').length;
  const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
  const { start: dStart, end: dEnd } = todayRangeIST();
  const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
  return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'Default sponsor password updated',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
});

app.post('/admin/reset-users', requireAuth('admin'), (req, res) => {
  try {
    backupDB('pre_purge');
    const admins = db.users.filter(u => u.role === 'admin');
    admins.forEach(a => {
      a.sponsor_id = null;
      a.placement_parent_id = null;
      a.placement_side = null;
      a.left_id = null;
      a.right_id = null;
      a.pv = 0;
      a.carry_left = 0;
      a.carry_right = 0;
    });
    db.users = admins;
    db.earnings = [];
    db.payouts = [];
    db.counters.user = admins.reduce((m, a) => Math.max(m, a.id), 0);
    db.counters.earning = 0;
    db.counters.payout = 0;
    try { fs.rmSync(path.join(USER_UPLOAD_DIR), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(UPLOAD_DIR), { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(USER_UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    saveDB(db);
    const s = getSettingsRow();
    const usersCount = 0;
    const totalPaid = 0;
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'All user data deleted (except admins). Uploads and earnings reset.',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  } catch (e) {
    const s = getSettingsRow();
    const usersCount = db.users.filter(u => u.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: 'Failed to reset users',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  }
});

app.get('/admin/backups', requireAuth('admin'), (req, res) => {
  const files = listBackups();
  res.render('admin_backups', { files, error: null, success: null });
});

app.post('/admin/backup', requireAuth('admin'), (req, res) => {
  const dest = backupDB('manual');
  const files = listBackups();
  res.render('admin_backups', { files, error: dest ? null : 'Failed to create backup', success: dest ? 'Backup created' : null });
});

const uploadBackup = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BACKUP_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.json';
      cb(null, `upload_${ts}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => { const ok = file.originalname && file.originalname.endsWith('.json'); cb(ok ? null : new Error('Only .json files allowed'), ok); },
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.post('/admin/restore', requireAuth('admin'), (req, res) => {
  try {
    const filename = String(req.body.filename || '').trim();
    restoreFromBackup(filename);
    const files = listBackups();
    res.render('admin_backups', { files, error: null, success: 'Database restored from backup' });
  } catch (e) {
    const files = listBackups();
    res.render('admin_backups', { files, error: 'Failed to restore from backup', success: null });
  }
});

app.post('/admin/restore/upload', requireAuth('admin'), uploadBackup.single('backup'), (req, res) => {
  try {
    if (!req.file) throw new Error('No file');
    const name = path.basename(req.file.filename);
    restoreFromBackup(name);
    const files = listBackups();
    res.render('admin_backups', { files, error: null, success: 'Database restored from uploaded file' });
  } catch (e) {
    const files = listBackups();
    res.render('admin_backups', { files, error: 'Failed to restore from upload', success: null });
  }
});

app.post('/admin/create-admin', requireAuth('admin'), (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toUpperCase();
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirm_password || '');
    if (!username) throw new Error('Username is required');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (password !== confirm) throw new Error('Passwords do not match');
    if (db.users.find(u => u.username === username)) throw new Error('Username already exists');
    const hash = bcrypt.hashSync(password, 10);
    const admin = {
      id: nextId('user'),
      username,
      password_hash: hash,
      role: 'admin',
      sponsor_id: null,
      placement_parent_id: null,
      placement_side: null,
      left_id: null,
      right_id: null,
      index_num: 1,
      member_code: '1',
      user_code: generateUserCode6(),
      pv: 0,
      carry_left: 0,
      carry_right: 0,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    db.users.push(admin);
    saveDB(db);
    const s = getSettingsRow();
    const usersCount = db.users.filter(u => u.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: `Admin user created: ${username}`,
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  } catch (e) {
    const s = getSettingsRow();
    const usersCount = db.users.filter(u => u.role === 'user').length;
    const totalPaid = sumPayoutEarnings('amount_inr') || sumPayoutEarnings('net_inr');
    const pinAll = db.pin_packages || [];
    const pinTotal = pinAll.length;
    const pinUsed = pinAll.filter(p => !!p.used_by || p.status === 'used').length;
    const pinExpired = pinAll.filter(p => p.status === 'expired').length;
    const pinUnused = pinAll.filter(p => !p.used_by && (p.status === 'new' || !p.status)).length;
    const { start: dStart, end: dEnd } = todayRangeIST();
    const pinUsedToday = pinAll.filter(p => p.used_at && p.used_at >= dStart && p.used_at <= dEnd).length;
    return res.render('admin', {
      settings: s,
      stats: { usersCount, totalPaid, totalTDS: sumPayoutEarnings('tds_inr'), totalAdminCharge: sumPayoutEarnings('admin_charge_inr') },
      rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }),
      message: e.message || 'Failed to create admin user',
      pin_stats: { total: pinTotal, used: pinUsed, unused: pinUnused, expired: pinExpired, used_today: pinUsedToday },
      charts: generateChartsData(db)
    });
  }
});

app.get('/admin/tree/:username', requireAuth('admin'), (req, res) => {
  const root = getUserByUsername(req.params.username);
  if (!root) return res.status(404).send('User not found');
  function node(u) {
    if (!u) return null;
    const children = (db.users || []).filter(c => c.placement_parent_id === u.id);
    const leftChild = children.find(c => c.placement_side === 'left');
    const rightChild = children.find(c => c.placement_side === 'right');
    return {
      username: u.username,
      user_code: u.user_code || null,
      member_code: u.member_code || null,
      carry_left: u.carry_left,
      carry_right: u.carry_right,
      pv: u.pv,
      left: leftChild ? node(leftChild) : null,
      right: rightChild ? node(rightChild) : null
    };
  }
  res.json(node(root));
});

// --- Weekly Payout Scheduler ---
function checkAutoPayout() {
  const now = Date.now();
  const nextRun = db.settings.next_payout_date ? new Date(db.settings.next_payout_date).getTime() : 0;
  
  if (!db.settings.next_payout_date) {
    const s = getSettingsRow();
    db.settings.next_payout_date = nextFlushDateISO(s);
    saveDB(db);
    return;
  }

  if (now >= nextRun) {
    // Guard: skip if we already processed this week (prevent duplicate payouts on restart)
    const lastRun = db.settings.last_payout_run ? new Date(db.settings.last_payout_run).getTime() : 0;
    const currentWeek = getWeekNumber(new Date());
    const lastRunWeek = lastRun ? getWeekNumber(new Date(lastRun)) : -1;
    if (lastRun && lastRunWeek === currentWeek) {
      console.log('Weekly payout already ran this week (Week ' + currentWeek + '). Skipping.');
      return;
    }

    console.log('Running scheduled weekly binary payout...');
    let count = 0;
    let lbCount = 0;
    (db.users || []).forEach(u => {
      if (u.role !== 'user') return;
      // Only process users with new activity (carry from new activations/repurchases)
      const hasNewActivity = (u.carry_left || 0) > 0 || (u.carry_right || 0) > 0 
        || (u.repurchase_carry_left || 0) > 0 || (u.repurchase_carry_right || 0) > 0;
      if (hasNewActivity) {
        processBinaryPairsForUser(u.id);
        count++;
      }
    });

    // FIX: Also process pending leadership bonuses independently
    // This ensures users without binary pairs still get their LB credited
    const nowISO = DateTime.now().setZone('Asia/Kolkata').toISO();
    const pendingLBs = (db.earnings || []).filter(e =>
      (e.pending_leadership === true || e.pending_leadership === 1) && e.status === 'pending'
    );

    if (pendingLBs.length > 0) {
      console.log(`[LB FLUSH] Processing ${pendingLBs.length} pending leadership bonuses...`);
      const lbByUser = {};

      pendingLBs.forEach(lb => {
        const sourceUser = getUserById(lb.source_user_id);
        if (!sourceUser || sourceUser.status !== 'active') {
          console.log('[LB FLUSH SKIP] Downline not active - source:', lb.source_user_id, 'leader:', lb.user_id);
          return;
        }

        const pin = (db.pin_packages || []).find(p => p.used_by === lb.source_user_id);
        let lbPlan = null;
        let lbAmount = 0;
        const allPlans = (db.plans || []).filter(p => p.active && p.leadership_bonus_inr > 0);
        const defaultPlan = allPlans[0] || null;

        if (pin && pin.plan_id) {
          lbPlan = (db.plans || []).find(pl => pl.id === pin.plan_id) || null;
          lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : 0;
        }
        if (!lbPlan && lb.plan_id) {
          lbPlan = (db.plans || []).find(pl => pl.id === lb.plan_id) || null;
          lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : 0;
        }
        if (!lbAmount) {
          lbAmount = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
        }

        if (lbAmount > 0) {
          lb.gross_inr = lbAmount;
          lb.plan_id = lbPlan ? lbPlan.id : (defaultPlan ? defaultPlan.id : null);
          lb.source_pin_code = pin ? (pin.code || null) : (lb.source_pin_code || null);
          lb.amount_inr = Math.round((lb.gross_inr || 0) * 0.88 * 100) / 100;
          lb.tds_inr = Math.round((lb.gross_inr || 0) * 0.02 * 100) / 100;
          lb.admin_charge_inr = Math.round((lb.gross_inr || 0) * 0.10 * 100) / 100;
          lb.net_inr = lb.amount_inr;
          lb.status = 'credited';
          lb.pending_leadership = false;
          lb.note = 'Leadership bonus';
          lb.credited_at = nowISO;
          lbCount++;
          console.log(`[LB FLUSH CREDIT] Leader: ${lb.user_id}, Downline: ${lb.source_user_id}, Amount: ${lb.amount_inr}`);

          // Group by user for payout record
          if (!lbByUser[lb.user_id]) {
            lbByUser[lb.user_id] = { lbGross: 0, lbNet: 0, tds: 0, admin: 0, earningIds: [] };
          }
          lbByUser[lb.user_id].lbGross += lb.gross_inr;
          lbByUser[lb.user_id].lbNet += lb.net_inr;
          lbByUser[lb.user_id].tds += lb.tds_inr;
          lbByUser[lb.user_id].admin += lb.admin_charge_inr;
          lbByUser[lb.user_id].earningIds.push(lb.id);
        }
      });

      // Create payout records for users with LB only (no binary pairs)
      Object.keys(lbByUser).forEach(userIdStr => {
        const uid = parseInt(userIdStr);
        const data = lbByUser[uid];
        const finalGross = data.lbGross;
        const finalTds = Math.round(finalGross * 0.02 * 100) / 100;
        const finalAdmin = Math.round(finalGross * 0.10 * 100) / 100;
        const finalNet = Math.max(0, Math.round((finalGross - finalTds - finalAdmin) * 100) / 100);

        // Inherit transfer_id from existing payouts in same week
        const exPayout = (db.payouts || []).find(x =>
          x.user_id === uid &&
          getWeekNumber(new Date(x.created_at)) === getWeekNumber(new Date(nowISO)) &&
          new Date(x.created_at).getFullYear() === new Date(nowISO).getFullYear() &&
          x.transfer_id
        );

        db.payouts.push({
          id: nextId('payout'),
          user_id: uid,
          earning_ids: data.earningIds,
          amount_inr: finalNet,
          gross_inr: finalGross,
          binary_gross: 0,
          binary_net: 0,
          repurchase_gross: 0,
          repurchase_net: 0,
          lb_gross: data.lbGross,
          lb_net: data.lbNet,
          tds_inr: finalTds,
          admin_charge_inr: finalAdmin,
          status: exPayout ? 'completed' : 'pending',
          note: 'Leadership',
          pairs: 0,
          leadership_bonus: data.lbNet,
          transfer_id: exPayout ? exPayout.transfer_id : null,
          transfer_credentials: exPayout ? (exPayout.transfer_credentials || null) : null,
          transfer_date: exPayout ? exPayout.transfer_date : null,
          hold_payment: false,
          created_at: nowISO
        });
      });
    }

    // Schedule next run aligned with Weekly Flush config
    const s = getSettingsRow();
    const nextISO = nextFlushDateISO(s);
    db.settings.last_payout_run = DateTime.now().setZone('Asia/Kolkata').toISO();
    db.settings.next_payout_date = nextISO;
    saveDB(db);
    mysqlAdapter.flushDirtySync();
    console.log(`Weekly payout completed. ${count} users with pairs, ${lbCount} LB credited. Next run: ${nextISO}`);
  }
}

// Run check on startup and then every 5 minutes for responsiveness
setTimeout(checkAutoPayout, 5000); 
setInterval(checkAutoPayout, 5 * 60 * 1000); 

app.get('/admin/tree-ui', requireAuth('admin'), (req, res) => {
  const rootName = req.query.root || 'admin';
  const depth = parseInt(req.query.depth || '2');
  let root = getUserByUsername(rootName) || getUserByRef(rootName);
  // If requested root has no placement children, auto-find a root that does
  if (root) {
    const hasKids = (db.users || []).some(c => c.placement_parent_id === root.id);
    if (!hasKids && !req.query.root) {
      const fallback = (db.users || []).find(u => (db.users || []).some(c => c.placement_parent_id === u.id));
      if (fallback) root = fallback;
    }
  }
  if (!root) return res.status(404).send('User not found');
  const tree = root;
  // Build children map from placement_parent_id for tree rendering
  const childrenMap = {};
  (db.users || []).forEach(u => {
    if (u.placement_parent_id) {
      if (!childrenMap[u.placement_parent_id]) childrenMap[u.placement_parent_id] = [];
      childrenMap[u.placement_parent_id].push(u);
    }
  });
  res.render('tree', { tree, getUserById, depth, childrenMap });
});

app.get('/admin/genealogy', requireAuth('admin'), (req, res) => {
  const searchUser = String(req.query.user || '').trim();
  const depth = parseInt(req.query.depth || '2');
  let currentUser = null;
  let error = null;
  let breadcrumb = [];
  let stats = { total: 0, active: 0, inactive: 0, totalBV: 0 };

  if (searchUser) {
    currentUser = getUserByRef(searchUser);
    if (!currentUser) {
      error = 'User not found: ' + searchUser;
    } else {
      // Build breadcrumb from current user to root
      let u = currentUser;
      while (u) {
        breadcrumb.unshift({ id: u.user_code || u.username, user_id: u.id });
        if (!u.placement_parent_id) break;
        u = getUserById(u.placement_parent_id);
        if (!u) break;
      }

      // Calculate stats for this subtree
      function calcStats(rootId) {
        if (!rootId) return { total: 0, active: 0, inactive: 0, totalBV: 0 };
        const root = getUserById(rootId);
        if (!root) return { total: 0, active: 0, inactive: 0, totalBV: 0 };
        let total = 1;
        let active = root.status === 'active' ? 1 : 0;
        let inactive = root.status !== 'active' ? 1 : 0;
        let totalBV = root.pv || 0;
        const queue = [root.left_id, root.right_id].filter(Boolean);
        while (queue.length) {
          const id = queue.shift();
          const user = getUserById(id);
          if (!user) continue;
          total++;
          if (user.status === 'active') active++;
          else inactive++;
          totalBV += user.pv || 0;
          if (user.left_id) queue.push(user.left_id);
          if (user.right_id) queue.push(user.right_id);
        }
        return { total, active, inactive, totalBV };
      }

      stats = calcStats(currentUser.id);
    }
  }

  res.render('admin_genealogy', {
    searchUser,
    depth,
    currentUser,
    breadcrumb,
    stats,
    error,
    getUserById
  });
});


// --- Admin Celebrations ---
app.get('/admin/celebrations', requireAuth('admin'), (req, res) => {
  const db_c = db.celebrations || [];
  // Only show admin-created ranks (not default ranks)
  const ranks = (db.ranks || []).filter(r => r.active !== false);
  // Only show users who have a rank assigned (rank complete) — compute dynamically from BV
  const allRankRules = ensureRankRules().filter(r => r.criteria_type !== 'direct_joins_7_days' && !r._fixed).sort((a, b) => (a.order || 0) - (b.order || 0));
  const usersList = (db.users || []).filter(u => u.role === 'user').map(u => {
    const tL = u.user_code === 'N77668569' ? (u.carry_left||0)+(u.org_bv_left||0) : subtreeStats(u.left_id).pv;
    const tR = subtreeStats(u.right_id).pv;
    let dynRank = null;
    for (const r of allRankRules) {
      if (tL >= (r.left_pv || 0) && tR >= (r.right_pv || 0)) dynRank = r.name;
    }
    if (dynRank) u.rank_name = dynRank;
    return {
      id: u.id,
      user_code: u.user_code || '',
      member_name: u.member_name || u.username || '',
      rank_name: dynRank || u.rank_name || ''
    };
  }).filter(u => u.rank_name).sort((a, b) => (a.member_name || '').localeCompare(b.member_name || ''));
  
  res.render('admin_celebrations', {
    celebrations: db_c,
    usersList,
    ranks,
    db,
    error: null,
    success: req.query.msg || null
  });
});

app.post('/admin/celebrations', requireAuth('admin'), (req, res) => {
  const { user_id, rank_achieved, celebration_date, notes } = req.body;
  const ranks = db.ranks || [];
  try {
    if (!user_id || !rank_achieved) {
      const usersList = (db.users || []).filter(u => u.role === 'user').map(u => ({ id: u.id, user_code: u.user_code || '', member_name: u.member_name || u.username || '' }));
      return res.render('admin_celebrations', {
        celebrations: db.celebrations || [],
        usersList,
        ranks,
        db,
        error: 'User and rank are required',
        success: null
      });
    }
    const user = getUserById(user_id);
    if (!user) throw new Error('User not found');
    const newCelebration = {
      id: nextId('celebration'),
      user_id: user.id,
      user_code: user.user_code || '',
      member_name: user.member_name || user.username || '',
      rank_achieved,
      celebration_date: celebration_date || DateTime.now().setZone('Asia/Kolkata').toISO().split('T')[0],
      trophy_status: 'pending',
      celebration_status: 'pending',
      notes: notes || '',
      hidden_from_home: false,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    if (!db.celebrations) db.celebrations = [];
    db.celebrations.push(newCelebration);
    saveDB(db);
    res.redirect('/admin/celebrations?msg=Celebration+added+successfully');
  } catch (e) {
    const usersList = (db.users || []).filter(u => u.role === 'user').map(u => ({ id: u.id, user_code: u.user_code || '', member_name: u.member_name || u.username || '' }));
    res.render('admin_celebrations', {
      celebrations: db.celebrations || [],
      usersList,
      ranks,
      db,
      error: e.message,
      success: null
    });
  }
});

// Celebrations photo upload
const celebrationUploadDir = path.join(UPLOAD_ROOT_DIR, 'celebrations');
fs.mkdirSync(celebrationUploadDir, { recursive: true });

const uploadCelebration = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, celebrationUploadDir),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `celebration_${ts}${ext}`);
    },
    quality: 85,
    maxWidth: 600,
    maxHeight: 600
  }),
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : new Error('Images only'), file.mimetype.startsWith('image/')),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/admin/celebrations/:id/update', requireAuth('admin'), uploadCelebration.any(), (req, res) => {
  const { trophy_status, celebration_status, notes, photo_type, remove_photo, hidden_from_home } = req.body;
  const id = parseInt(req.params.id);
  const c = (db.celebrations || []).find(c => c.id === id);
  if (!c) return res.redirect('/admin/celebrations');
  if (trophy_status) c.trophy_status = trophy_status;
  if (celebration_status) c.celebration_status = celebration_status;
  if (notes !== undefined) c.notes = notes;
  if (req.body.object_position !== undefined) c.object_position = req.body.object_position;
  if (req.body.hidden_from_home !== undefined) {
    c.hidden_from_home = hidden_from_home === '1' || hidden_from_home === true;
  }
  
  // Handle photo removal
  if (remove_photo === '1') {
    c.photo = null;
  }
  
  // Handle photo uploads
  if (req.files && req.files.length > 0) {
    req.files.forEach(file => {
      if (file.fieldname === 'photo') {
        c.photo = '/uploads/celebrations/' + file.filename;
      } else if (file.fieldname === 'photo2') {
        c.photo2 = '/uploads/celebrations/' + file.filename;
      }
    });
  }

  // Reduce rank when celebration/trophy marked incomplete or moved to pending
  if (celebration_status === 'incomplete' || celebration_status === 'pending' || trophy_status === 'incomplete' || trophy_status === 'pending') {
    const user = (db.users || []).find(u => u.id === c.user_id);
    if (user && user.rank_name === c.rank_achieved) {
      const userHistory = (db.rank_history || [])
        .filter(h => h.user_id === user.id)
        .sort((a, b) => new Date(b.achieved_at) - new Date(a.achieved_at));
      // Find the rank achieved BEFORE this one
      const currentIdx = userHistory.findIndex(h => h.rank_name === c.rank_achieved);
      if (currentIdx >= 0 && currentIdx < userHistory.length - 1) {
        const prevRank = userHistory[currentIdx + 1].rank_name;
        user.rank_name = prevRank;
      } else if (userHistory.length > 0 && currentIdx === 0) {
        // If it's the only rank or latest, try the next one or fallback
        if (userHistory.length > 1) {
          user.rank_name = userHistory[1].rank_name;
        } else {
          user.rank_name = '';
        }
      }
      // Also remove the latest rank_history entry for this user/rank
      const histEntry = db.rank_history.findIndex(h => h.user_id === user.id && h.rank_name === c.rank_achieved && h.achieved_at === userHistory[0]?.achieved_at);
      if (histEntry >= 0) {
        db.rank_history.splice(histEntry, 1);
      }
    }
  }

  saveDB(db);
  res.redirect('/admin/celebrations');
});

app.post('/admin/star-winners/toggle-hide', requireAuth('admin'), (req, res) => {
  const userId = parseInt(req.body.user_id);
  if (!db.settings) db.settings = {};
  if (!db.settings.hidden_star_winners) db.settings.hidden_star_winners = [];
  const idx = db.settings.hidden_star_winners.indexOf(userId);
  const nowHidden = idx === -1;
  if (nowHidden) {
    db.settings.hidden_star_winners.push(userId);
  } else {
    db.settings.hidden_star_winners.splice(idx, 1);
  }
  // Also update any celebration entry for this user
  (db.celebrations || []).forEach(c => {
    if (c.user_id === userId) {
      c.hidden_from_home = nowHidden;
    }
  });
  saveDB(db);
  const referer = req.get('Referer') || '/admin/celebrations';
  res.redirect(referer);
});

app.get('/admin/celebrations/auto', requireAuth('admin'), (req, res) => {
  const validRankNames = new Set(ensureRankRules().map(r => r.name));
  const rankHistory = db.rank_history || [];
  // Step 1: Remove invalid celebrations (rank not in rank_rules)
  if (!db.celebrations) db.celebrations = [];
  const beforeCount = db.celebrations.length;
  db.celebrations = db.celebrations.filter(c => validRankNames.has(c.rank_achieved));
  const removedCount = beforeCount - db.celebrations.length;
  // Step 2: Import valid achievements
  let existingUserIds = new Set(db.celebrations.map(c => c.user_id));
  const newCelebrations = [];
  // Import from rank_history (only valid ranks)
  rankHistory.forEach(h => {
    if (!validRankNames.has(h.rank_name)) return;
    if (existingUserIds.has(h.user_id)) return;
    const user = getUserById(h.user_id);
    if (!user) return;
    existingUserIds.add(h.user_id);
    newCelebrations.push({
      id: nextId('celebration'),
      user_id: h.user_id,
      user_code: h.user_code || user.user_code || '',
      member_name: h.member_name || user.member_name || user.username || '',
      rank_achieved: h.rank_name,
      celebration_date: h.achieved_at ? h.achieved_at.split('T')[0] : DateTime.now().setZone('Asia/Kolkata').toISO().split('T')[0],
      trophy_status: 'pending',
      celebration_status: 'pending',
      notes: 'Auto-imported from rank history',
      hidden_from_home: false,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    });
  });
  // Also import from users.rank_name (only valid ranks, no rank_history entry)
  (db.users || []).forEach(u => {
    if (!u.rank_name || !validRankNames.has(u.rank_name)) return;
    if (existingUserIds.has(u.id)) return;
    existingUserIds.add(u.id);
    newCelebrations.push({
      id: nextId('celebration'),
      user_id: u.id,
      user_code: u.user_code || '',
      member_name: u.member_name || u.username || '',
      rank_achieved: u.rank_name,
      celebration_date: u.rank_updated_at ? u.rank_updated_at.split('T')[0] : DateTime.now().setZone('Asia/Kolkata').toISO().split('T')[0],
      trophy_status: 'pending',
      celebration_status: 'pending',
      notes: 'Auto-imported from user rank',
      hidden_from_home: false,
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    });
  });
  db.celebrations.push(...newCelebrations);
  saveDB(db);
  res.redirect('/admin/celebrations?msg=Removed+' + removedCount + '+invalid+celebrations.+Imported+' + newCelebrations.length + '+valid+celebrations');
});

// --- Admin Binary Config ---
app.get('/admin/binary-config', requireAuth('admin'), (req, res) => {
  res.render('admin_binary_config', { settings: db.settings || {}, error: null, success: null });
});

app.post('/admin/binary-config', requireAuth('admin'), (req, res) => {
  try {
    const {
      pv_on_join, pair_amount_inr, pair_bv_size,
      weekly_cap_inr, weekly_cap_pairs, weekly_flush_day, weekly_flush_time,
      auto_binary_on_bv, company_gstin, next_payout_date,
      tds_percent, admin_charge_percent,
      repurchase_pair_bv_size, repurchase_pair_amount_inr, repurchase_weekly_cap_pairs
    } = req.body;
    db.settings = db.settings || {};
    if (pv_on_join !== undefined) db.settings.pv_on_join = parseInt(pv_on_join) || 0;
    if (pair_amount_inr !== undefined) db.settings.pair_amount_inr = parseFloat(pair_amount_inr) || 0;
    if (pair_bv_size !== undefined) db.settings.pair_bv_size = parseInt(pair_bv_size) || db.settings.pv_on_join || 4000;
    if (weekly_cap_inr !== undefined) db.settings.weekly_cap_inr = parseFloat(weekly_cap_inr) || 0;
    if (weekly_cap_pairs !== undefined) db.settings.weekly_cap_pairs = parseInt(weekly_cap_pairs) || 0;
    if (repurchase_pair_bv_size !== undefined) db.settings.repurchase_pair_bv_size = parseInt(repurchase_pair_bv_size) || 4000;
    if (repurchase_pair_amount_inr !== undefined) db.settings.repurchase_pair_amount_inr = parseFloat(repurchase_pair_amount_inr) || 0;
    if (repurchase_weekly_cap_pairs !== undefined) db.settings.repurchase_weekly_cap_pairs = parseInt(repurchase_weekly_cap_pairs) || 0;
    if (weekly_flush_day) db.settings.weekly_flush_day = weekly_flush_day;
    if (weekly_flush_time) db.settings.weekly_flush_time = weekly_flush_time;
    if ('auto_binary_on_bv' in req.body) {
      db.settings.auto_binary_on_bv = (auto_binary_on_bv === '1' || auto_binary_on_bv === 1 || auto_binary_on_bv === true);
    } else if (db.settings.auto_binary_on_bv === undefined) {
      db.settings.auto_binary_on_bv = false;
    }
    if ('leadership_bonus_enabled' in req.body) {
      db.settings.leadership_bonus_enabled = (req.body.leadership_bonus_enabled === '1' || req.body.leadership_bonus_enabled === '1' || req.body.leadership_bonus_enabled === true);
    } else if (db.settings.leadership_bonus_enabled === undefined) {
      db.settings.leadership_bonus_enabled = true;
    }
    db.settings.min_bv_for_leadership = parseFloat(req.body.min_bv_for_leadership) || 4000;
    if (company_gstin !== undefined) db.settings.company_gstin = company_gstin;
    if (next_payout_date) {
      db.settings.next_payout_date = new Date(next_payout_date).toISOString();
    }
    if (tds_percent !== undefined) db.settings.tds_percent = parseFloat(tds_percent) || 2;
    if (admin_charge_percent !== undefined) db.settings.admin_charge_percent = parseFloat(admin_charge_percent) || 10;
    if (req.body.registration_success_message !== undefined) {
      db.settings.registration_success_message = String(req.body.registration_success_message).trim();
    }
    db.settings.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
    saveDB(db);
    res.render('admin_binary_config', { settings: db.settings, error: null, success: 'Settings saved successfully!' });
  } catch (e) {
    res.render('admin_binary_config', { settings: db.settings || {}, error: e.message, success: null });
  }
});

// --- Admin Monthly Purchase Report ---
function getMonthRangeIST(year, month) {
  const start = DateTime.fromISO(`${year}-${String(month).padStart(2,'0')}-01`, { zone: 'Asia/Kolkata' });
  const end = start.endOf('month');
  return { start: start.toISO(), end: end.toISO() };
}

app.get('/admin/reports/monthly-purchase', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  const now = DateTime.now().setZone('Asia/Kolkata');
  
  let year = parseInt(req.query.year) || now.year;
  let month = parseInt(req.query.month) || now.month;
  
  if (month < 1) { month = 12; year--; }
  if (month > 12) { month = 1; year++; }
  
  const { start, end } = getMonthRangeIST(year, month);
  const search = String(req.query.search || '').toLowerCase().trim();
  const filter = req.query.filter || '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;
  
  const isCurrentMonth = (year === now.year && month === now.month);
  const monthName = DateTime.fromObject({ year, month }).setZone('Asia/Kolkata').toFormat('MMMM');
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  
  const allUsers = (db.users || []).filter(u => u.role === 'user');
  const completedUsers = [];
  const blockedUsers = [];
  const exemptedUsers = [];
  
  allUsers.forEach(u => {
    const repurchase = getUserRepurchaseStats(u.id, start, end);
    const required_bv = s.monthly_repurchase_bv || 0;
    const required_dp = s.monthly_repurchase_dp || 0;
    const achieved_bv = repurchase.total_bv || 0;
    const achieved_dp = repurchase.total_inr || 0;
    
    const userObj = {
      ...u,
      required_bv,
      required_dp,
      achieved_bv,
      achieved_dp
    };
    
    if (u.monthly_repurchase_exempt) {
      exemptedUsers.push(userObj);
    } else if (achieved_bv >= required_bv && achieved_dp >= required_dp) {
      completedUsers.push(userObj);
    } else {
      blockedUsers.push(userObj);
    }
  });
  
  let filteredUsers = [...allUsers];
  if (filter === 'blocked') {
    filteredUsers = blockedUsers;
  } else if (filter === 'completed') {
    filteredUsers = completedUsers;
  } else if (filter === 'exempted') {
    filteredUsers = exemptedUsers;
  } else {
    filteredUsers = [...blockedUsers, ...completedUsers, ...exemptedUsers];
  }
  
  if (search) {
    filteredUsers = filteredUsers.filter(u => {
      const userCode = String(u.user_code || '').toLowerCase();
      const memberName = String(u.member_name || '').toLowerCase();
      const phone = String(u.phone || '').toLowerCase();
      const username = String(u.username || '').toLowerCase();
      return userCode.includes(search) || memberName.includes(search) || phone.includes(search) || username.includes(search);
    });
  }
  
  filteredUsers.sort((a, b) => (a.user_code || '').localeCompare(b.user_code || ''));
  
  const totalCount = allUsers.length;
  const blockedCount = blockedUsers.length;
  const completedCount = completedUsers.length;
  const exemptedCount = exemptedUsers.length;
  const totalPages = Math.ceil(filteredUsers.length / perPage);
  
  res.render('admin_monthly_purchase_report', {
    settings: s,
    allUsers,
    completedUsers,
    blockedUsers,
    exemptedUsers,
    monthStart: start,
    monthEnd: end,
    monthName,
    year,
    month,
    prevYear,
    prevMonth,
    nextYear,
    nextMonth,
    isCurrentMonth,
    search,
    filter,
    page,
    perPage,
    totalPages,
    filteredUsers,
    totalCount,
    blockedCount,
    completedCount,
    exemptedCount,
    success: req.query.msg || null
  });
});

app.post('/admin/monthly-purchase/settings', requireAuth('admin'), (req, res) => {
  const { monthly_repurchase_required, monthly_repurchase_bv, monthly_repurchase_dp, year, month } = req.body;
  db.settings = db.settings || {};
  db.settings.monthly_repurchase_required = (monthly_repurchase_required === '1');
  db.settings.monthly_repurchase_bv = parseFloat(monthly_repurchase_bv) || 0;
  db.settings.monthly_repurchase_dp = parseFloat(monthly_repurchase_dp) || 0;
  saveDB(db);
  const redirectYear = year || DateTime.now().setZone('Asia/Kolkata').year;
  const redirectMonth = month || DateTime.now().setZone('Asia/Kolkata').month;
  res.redirect(`/admin/reports/monthly-purchase?year=${redirectYear}&month=${redirectMonth}&msg=Settings+saved`);
});

app.post('/admin/user/unblock-monthly-repurchase', requireAuth('admin'), (req, res) => {
  const { user_id, year, month } = req.body;
  const user = getUserById(user_id);
  if (user) {
    user.monthly_repurchase_exempt = true;
    saveDB(db);
  }
  const redirectYear = year || DateTime.now().setZone('Asia/Kolkata').year;
  const redirectMonth = month || DateTime.now().setZone('Asia/Kolkata').month;
  res.redirect(`/admin/reports/monthly-purchase?year=${redirectYear}&month=${redirectMonth}&msg=User+exempted`);
});

app.post('/admin/user/block-monthly-repurchase', requireAuth('admin'), (req, res) => {
  const { user_id, year, month } = req.body;
  const user = getUserById(user_id);
  if (user) {
    user.monthly_repurchase_exempt = false;
    saveDB(db);
  }
  const redirectYear = year || DateTime.now().setZone('Asia/Kolkata').year;
  const redirectMonth = month || DateTime.now().setZone('Asia/Kolkata').month;
  res.redirect(`/admin/reports/monthly-purchase?year=${redirectYear}&month=${redirectMonth}&msg=Exemption+removed`);
});

app.post('/admin/user/exempt-all-blocked', requireAuth('admin'), (req, res) => {
  const { year, month } = req.body;
  const targetYear = parseInt(year) || DateTime.now().setZone('Asia/Kolkata').year;
  const targetMonth = parseInt(month) || DateTime.now().setZone('Asia/Kolkata').month;
  const { start, end } = getMonthRangeIST(targetYear, targetMonth);
  const s = db.settings || {};
  const required_bv = s.monthly_repurchase_bv || 0;
  const required_dp = s.monthly_repurchase_dp || 0;
  
  let count = 0;
  (db.users || []).filter(u => u.role === 'user' && !u.monthly_repurchase_exempt).forEach(u => {
    const repurchase = getUserRepurchaseStats(u.id, start, end);
    if ((repurchase.total_bv || 0) < required_bv || (repurchase.total_inr || 0) < required_dp) {
      u.monthly_repurchase_exempt = true;
      count++;
    }
  });
  saveDB(db);
  res.redirect(`/admin/reports/monthly-purchase?year=${targetYear}&month=${targetMonth}&msg=${count}+users+exempted`);
});

app.post('/admin/user/remove-all-exemptions', requireAuth('admin'), (req, res) => {
  const { year, month } = req.body;
  const targetYear = parseInt(year) || DateTime.now().setZone('Asia/Kolkata').year;
  const targetMonth = parseInt(month) || DateTime.now().setZone('Asia/Kolkata').month;
  let count = 0;
  (db.users || []).filter(u => u.role === 'user').forEach(u => {
    if (u.monthly_repurchase_exempt) {
      u.monthly_repurchase_exempt = false;
      count++;
    }
  });
  saveDB(db);
  res.redirect(`/admin/reports/monthly-purchase?year=${targetYear}&month=${targetMonth}&msg=${count}+exemptions+removed`);
});

app.post('/admin/user/remove-selected-exemptions', requireAuth('admin'), (req, res) => {
  const { user_ids, year, month } = req.body;
  const targetYear = parseInt(year) || DateTime.now().setZone('Asia/Kolkata').year;
  const targetMonth = parseInt(month) || DateTime.now().setZone('Asia/Kolkata').month;
  const ids = Array.isArray(user_ids) ? user_ids : [user_ids];
  let count = 0;
  ids.forEach(id => {
    const user = getUserById(id);
    if (user && user.monthly_repurchase_exempt) {
      user.monthly_repurchase_exempt = false;
      count++;
    }
  });
  saveDB(db);
  res.redirect(`/admin/reports/monthly-purchase?year=${targetYear}&month=${targetMonth}&msg=${count}+exemptions+removed`);
});

app.get('/admin/reports/monthly-purchase/export', requireAuth('admin'), (req, res) => {
  const s = db.settings || {};
  const now = DateTime.now().setZone('Asia/Kolkata');
  
  let year = parseInt(req.query.year) || now.year;
  let month = parseInt(req.query.month) || now.month;
  const { start, end } = getMonthRangeIST(year, month);
  const monthName = DateTime.fromObject({ year, month }).setZone('Asia/Kolkata').toFormat('MMMM');
  
  const allUsers = (db.users || []).filter(u => u.role === 'user');
  const rows = [];
  rows.push(['User ID', 'Name', 'Phone', 'Status', 'Required BV', 'Achieved BV', 'Required DP', 'Achieved DP', 'Status', 'Exempted']);
  
  allUsers.forEach(u => {
    const repurchase = getUserRepurchaseStats(u.id, start, end);
    const required_bv = s.monthly_repurchase_bv || 0;
    const required_dp = s.monthly_repurchase_dp || 0;
    const achieved_bv = repurchase.total_bv || 0;
    const achieved_dp = repurchase.total_inr || 0;
    
    let status = 'Blocked';
    if (u.monthly_repurchase_exempt) {
      status = 'Exempted';
    } else if (achieved_bv >= required_bv && achieved_dp >= required_dp) {
      status = 'Completed';
    }
    
    rows.push([
      u.user_code || '',
      u.member_name || '',
      u.phone || '',
      u.status || 'inactive',
      required_bv,
      achieved_bv,
      required_dp,
      achieved_dp,
      status,
      u.monthly_repurchase_exempt ? 'Yes' : 'No'
    ]);
  });
  
  const csv = rows.map(r => r.map(cell => {
    const str = String(cell);
    return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(',')).join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="monthly_purchase_${monthName}_${year}.csv"`);
  res.send(csv);
});

// --- Admin Gallery ---
const galleryUploadDir = path.join(UPLOAD_ROOT_DIR, 'gallery');
fs.mkdirSync(galleryUploadDir, { recursive: true });

const uploadGallery = multer({
  storage: createCompressedStorage({
    destination: (req, file, cb) => cb(null, galleryUploadDir),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `gallery_${ts}_${Math.random().toString(36).substr(2, 9)}${ext}`);
    },
    quality: 85,
    maxWidth: 1920,
    maxHeight: 1080
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPG, PNG, WebP, MP4, or WebM files allowed'), allowed.includes(file.mimetype));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

function getGroupedGallery(allItems) {
  const groups = {};
  allItems.forEach(g => {
    try {
      let dateStr = 'Uncategorized';
      if (g.event_date) {
        const d = new Date(g.event_date);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      } else if (g.created_at) {
        const d = new Date(g.created_at);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      }
      const title = (g.title || 'Uncategorized').trim();
      const key = title + '|||' + dateStr;
      if (!groups[key]) groups[key] = { title: title, date: dateStr, event_date: g.event_date || '', items: [] };
      groups[key].items.push(g);
    } catch (_) {}
  });
  return Object.values(groups);
}

function getGalleryUrl(filename) {
  return '/uploads/gallery/' + filename;
}

app.get('/gallery', (req, res) => {
  const allItems = (db.gallery || []).filter(g => g.active === true || g.active === 1 || g.active === '1' || g.active === undefined || g.active === null);
  const galleryImages = allItems.filter(g => g && g.type === 'image');
  const galleryGroups = {};
  galleryImages.forEach(g => {
    try {
      let dateStr = 'Uncategorized';
      if (g.event_date) {
        const d = new Date(g.event_date);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      } else if (g.created_at) {
        const d = new Date(g.created_at);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      }
      const title = (g.title || 'Uncategorized').trim();
      const key = title + '|||' + dateStr;
      if (!galleryGroups[key]) galleryGroups[key] = { title: title, date: dateStr, items: [] };
      galleryGroups[key].items.push(g);
    } catch (_) {}
  });
  const gallery = Object.values(galleryGroups);
  const videos = allItems.filter(g => g && g.type === 'video');
  const s = db.settings || {};
  res.render('gallery', {
    gallery,
    videos,
    page: { title: 'Gallery' },
    company_name: s.company_name || s.brand_name || 'Nastige',
    company_address: s.company_address || '',
    company_phone: s.company_phone || '',
    company_email: s.company_email || ''
  });
});

app.get('/franchise-public', (req, res) => {
  const s = db.settings || {};
  const franchises = (db.franchises || [])
    .filter(f => f.status !== 'blocked')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map((f, idx) => ({
      sr: idx + 1,
      city: f.city || (f.address ? f.address.split(',').pop()?.trim() : '') || '-',
      branch_name: f.branch_name || f.member_name || '-',
      contact_person: f.member_name || f.username || '-',
      phone: f.phone || '-',
      address: f.address || '-'
    }));
  res.render('franchise_public', {
    franchises,
    company: {
      company_name: s.company_name || s.brand_name || 'Nastige',
      brand_logo_url: s.brand_logo_url || ''
    }
  });
});

app.get('/admin/gallery', requireAuth('admin'), (req, res) => {
  const allItems = db.gallery || [];
  const gallery = getGroupedGallery(allItems);
  res.render('admin_gallery', { gallery, error: null, success: null });
});

app.post('/admin/gallery', requireAuth('admin'), (req, res) => {
  uploadGallery.array('media')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 50MB)' : (err.message || 'Upload failed');
      return res.render('admin_gallery', { gallery: getGroupedGallery(db.gallery || []), error: msg, success: null });
    }
    try {
      const orientation = req.body.orientation;
      const title = String(req.body.title || '').trim();
      const caption = String(req.body.caption || '').trim();
      const eventDate = req.body.event_date || DateTime.now().setZone('Asia/Kolkata').toISO().slice(0, 10);
      if (!db.gallery) db.gallery = [];
      const allowedImages = ['image/jpeg', 'image/png', 'image/webp'];
      const allowedVideos = ['video/mp4', 'video/webm'];
      (req.files || []).forEach(file => {
        const isVideo = allowedVideos.includes(file.mimetype);
        const isImage = allowedImages.includes(file.mimetype);
        if (!isVideo && !isImage) return;
        db.gallery.push({
          id: nextId('gallery'),
          url: getGalleryUrl(file.filename),
          title,
          caption,
          type: isVideo ? 'video' : 'image',
          orientation: isVideo ? 'video' : (orientation || 'landscape'),
          filename: file.filename,
          size: file.size,
          active: true,
          event_date: eventDate,
          created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
        });
      });
      saveDB(db);
      res.redirect('/admin/gallery?msg=Gallery+updated');
    } catch (e) {
      res.render('admin_gallery', { gallery: getGroupedGallery(db.gallery || []), error: e.message, success: null });
    }
  });
});

app.delete('/admin/gallery/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.gallery || []).findIndex(g => g.id === id);
  if (idx === -1) return res.json({ ok: false, error: 'Not found' });
  const item = db.gallery[idx];
  try {
    const filePath = path.join(galleryUploadDir, item.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
  db.gallery.splice(idx, 1);
  saveDB(db);
  res.json({ ok: true });
});

// --- Admin Free Products ---
app.get('/admin/free-products', requireAuth('admin'), (req, res) => {
  const users = (db.users || []).filter(u => u.role === 'user').map(u => ({
    id: u.id,
    user_code: u.user_code || '',
    member_name: u.member_name || u.username || '',
    is_star_winner: getDynamicRank(u) === 'STAR WINNER'
  }));
  // Use all active products from db.products
  const products = (db.products || []).filter(p => p.active !== false).map(p => ({
    id: p.id,
    name: p.name,
    code: p.code || '',
    price: p.price || 0
  }));
  const issues = (db.free_product_issues || []).slice().reverse();
  const s = db.settings || {};
  const hideStarWinnersMarquee = s.hide_star_winners_marquee || false;
  res.render('admin_free_products', { users, products, issues, hideStarWinnersMarquee, error: null, success: req.query.msg || null });
});

app.post('/admin/star-winners/toggle-marquee-show', requireAuth('admin'), (req, res) => {
  if (!db.settings) db.settings = {};
  db.settings.hide_star_winners_marquee = req.body.hide === '1';
  saveDB(db);
  res.redirect('/admin/free-products');
});

app.post('/admin/free-products', requireAuth('admin'), (req, res) => {
  const { user_id, product_id, quantity, reason } = req.body;
  const users = (db.users || []).filter(u => u.role === 'user').map(u => ({ id: u.id, user_code: u.user_code || '', member_name: u.member_name || u.username || '', is_star_winner: getDynamicRank(u) === 'STAR WINNER' }));
  const products = (db.products || []).filter(p => p.active !== false).map(p => ({ id: p.id, name: p.name, code: p.code || '', price: p.price || 0 }));
  const issues = (db.free_product_issues || []).slice().reverse();
  const sErr = db.settings || {};
  try {
    if (!user_id) throw new Error('User is required');
    const user = getUserById(parseInt(user_id));
    if (!user) throw new Error('User not found');
    
    if (!db.free_product_issues) db.free_product_issues = [];
    const isStar = getDynamicRank(user) === 'STAR WINNER';
    const issueId = nextId('free_product_issue');
    
    if (product_id) {
      const product = (db.products || []).find(p => p.id === parseInt(product_id));
      if (!product) throw new Error('Product not found');
      const qty = parseInt(quantity) || 1;
      
      // Check balance stock
      const total = product.total_stock || 0;
      const sold = product.sold_stock || 0;
      const free = product.free_stock || 0;
      const scrap = product.scrap_stock || 0;
      const balance = total - sold - free - scrap;
      if (qty > balance) throw new Error('Not enough balance stock. Available: ' + balance);
      
      // Update free_stock in inventory
      product.free_stock = free + qty;
      product.updated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
      
      db.free_product_issues.push({
        id: issueId,
        user_id: user.id,
        user_code: user.user_code || '',
        member_name: user.member_name || user.username || '',
        product_id: product.id,
        product_name: product.name,
        quantity: qty,
        reason: reason || '',
        is_star_winner: isStar,
        issued_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
      // Remove star winner status after issuing product
      if (isStar) {
        user.rank_name = null;
        user.rank = null;
      }
    } else {
      // No product selected - just log with reason
      db.free_product_issues.push({
        id: issueId,
        user_id: user.id,
        user_code: user.user_code || '',
        member_name: user.member_name || user.username || '',
        product_id: null,
        product_name: '',
        quantity: 0,
        reason: reason || 'Free product issued',
        is_star_winner: isStar,
        issued_at: DateTime.now().setZone('Asia/Kolkata').toISO()
      });
      // Remove star winner status after issuing product
      if (isStar) {
        user.rank_name = null;
        user.rank = null;
      }
    }
    saveDB(db);
    res.redirect('/admin/free-products?msg=Product+issued+successfully');
  } catch (e) {
    res.render('admin_free_products', { users, products, issues, hideStarWinnersMarquee: sErr.hide_star_winners_marquee || false, error: e.message, success: null });
  }
});

app.post('/admin/free-products/revert', requireAuth('admin'), (req, res) => {
  const issueId = parseInt(req.body.issue_id);
  const issue = (db.free_product_issues || []).find(i => i.id === issueId);
  if (!issue) return res.redirect('/admin/free-products?msg=Issue+not+found');
  issue.is_star_winner = false;
  saveDB(db);
  res.redirect('/admin/free-products?msg=Reverted+to+normal+user+status');
});

app.get('/my-ranks', requireAuth('user'), (req, res) => {
  const user = getUserById(req.session.user.id);
  const treeLeftBV = user.user_code === 'N77668569' ? (user.carry_left||0)+(user.org_bv_left||0) : subtreeStats(user.left_id).pv;
  const treeRightBV = subtreeStats(user.right_id).pv;
  const userLeftBV = treeLeftBV;
  const userRightBV = treeRightBV;
  
  const allRanks = ensureRankRules()
    .filter(r => r.criteria_type !== 'direct_joins_7_days' && !r._fixed)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  
  const rankProgress = allRanks.map(r => {
    const leftNeeded = Math.max(0, (r.left_pv || 0) - userLeftBV);
    const rightNeeded = Math.max(0, (r.right_pv || 0) - userRightBV);
    const leftProgress = Math.min(100, userLeftBV > 0 ? Math.round((userLeftBV / (r.left_pv || 1)) * 100) : 0);
    const rightProgress = Math.min(100, userRightBV > 0 ? Math.round((userRightBV / (r.right_pv || 1)) * 100) : 0);
    const isAchieved = userLeftBV >= (r.left_pv || 0) && userRightBV >= (r.right_pv || 0);
    
    return {
      id: r.id,
      name: r.name,
      order: r.order || 0,
      left_pv: r.left_pv || 0,
      right_pv: r.right_pv || 0,
      left_achieved: userLeftBV,
      right_achieved: userRightBV,
      left_remaining: leftNeeded,
      right_remaining: rightNeeded,
      left_progress: leftProgress,
      right_progress: rightProgress,
      is_achieved: isAchieved,
      reward: r.reward || '',
      rank_income: r.rank_income || 0,
      matching_condition: r.matching_condition || '1:1'
    };
  });
  
  // Determine current rank dynamically from BV (highest achieved rank)
  const achievedRanks = rankProgress.filter(r => r.is_achieved);
  const currentRankObj = achievedRanks.length > 0 ? achievedRanks[achievedRanks.length - 1] : null;
  if (currentRankObj) currentRankObj.is_current = true;
  // Sync user.rank_name with computed rank
  if (currentRankObj) user.rank_name = currentRankObj.name;
  
  const nextRank = rankProgress.find(r => !r.is_achieved);
  
  res.render('my_ranks', {
    user,
    rankProgress,
    nextRank,
    currentRankObj,
    userLeftBV,
    userRightBV,
    treeLeftBV,
    treeRightBV,
    leftBvAdj: userLeftBV,
    rightBvAdj: userRightBV,
    rupee: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
  });
});

app.get('/my-tree', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const myUser = getUserById(req.session.user.id);
  const searchUser = String(req.query.user || '').trim();
  const depth = parseInt(req.query.depth || '2');
  
  let currentUser = myUser;
  let error = null;
  let breadcrumb = [];
  let stats = { total: 0, active: 0, inactive: 0, totalBV: 0 };
  
  if (searchUser) {
    const targetUser = getUserByRef(searchUser);
    if (!targetUser) {
      error = 'User not found: ' + searchUser;
    } else if (targetUser.id !== myUser.id && !isInDownline(myUser.id, targetUser.id)) {
      error = 'Access denied. You can only view your own tree or your downline members.';
    } else {
      currentUser = targetUser;
      
      let u = currentUser;
      while (u) {
        breadcrumb.unshift({ id: u.user_code || u.username, user_id: u.id });
        if (!u.placement_parent_id) break;
        u = getUserById(u.placement_parent_id);
        if (!u) break;
      }
      
      function calcStats(rootId) {
        if (!rootId) return { total: 0, active: 0, inactive: 0, totalBV: 0 };
        const root = getUserById(rootId);
        if (!root) return { total: 0, active: 0, inactive: 0, totalBV: 0 };
        let total = 1;
        let active = root.status === 'active' ? 1 : 0;
        let inactive = root.status !== 'active' ? 1 : 0;
        let totalBV = root.pv || 0;
        const queue = [root.left_id, root.right_id].filter(Boolean);
        while (queue.length) {
          const id = queue.shift();
          const user = getUserById(id);
          if (!user) continue;
          total++;
          if (user.status === 'active') active++;
          else inactive++;
          totalBV += user.pv || 0;
          if (user.left_id) queue.push(user.left_id);
          if (user.right_id) queue.push(user.right_id);
        }
        return { total, active, inactive, totalBV };
      }
      
      stats = calcStats(currentUser.id);
    }
  } else {
    function calcStats(rootId) {
      if (!rootId) return { total: 0, active: 0, inactive: 0, totalBV: 0 };
      const root = getUserById(rootId);
      if (!root) return { total: 0, active: 0, inactive: 0, totalBV: 0 };
      let total = 1;
      let active = root.status === 'active' ? 1 : 0;
      let inactive = root.status !== 'active' ? 1 : 0;
      let totalBV = root.pv || 0;
      const queue = [root.left_id, root.right_id].filter(Boolean);
      while (queue.length) {
        const id = queue.shift();
        const user = getUserById(id);
        if (!user) continue;
        total++;
        if (user.status === 'active') active++;
        else inactive++;
        totalBV += user.pv || 0;
        if (user.left_id) queue.push(user.left_id);
        if (user.right_id) queue.push(user.right_id);
      }
      return { total, active, inactive, totalBV };
    }
    stats = calcStats(myUser.id);
  }
  
  res.render('tree_user', {
    myUser,
    searchUser,
    depth,
    currentUser,
    breadcrumb,
    stats,
    error,
    getUserById
  });
});

function isInDownline(uplineId, userId) {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.placement_parent_id === uplineId) return true;
  if (!user.placement_parent_id) return false;
  return isInDownline(uplineId, user.placement_parent_id);
}

app.get('/downline', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const user = getUserById(req.session.user.id);
  const side = req.query.side === 'right' ? 'right' : 'left';
  const downline = [];
  let count = 0;
  const sideId = side === 'left' ? user.left_id : user.right_id;
  if (sideId) {
    const stack = [getUserById(sideId)];
    while (stack.length > 0) {
      const u = stack.pop();
      if (u) {
        let sponsor = u.sponsor_id ? getUserById(u.sponsor_id) : null;
        if (!sponsor && u.placement_parent_id) sponsor = getUserById(u.placement_parent_id);
        const { left, right } = computeUserLegPV(u);
        const ranks = getOrderedRanks();
        let displayRank = null;
        for (let i = ranks.length - 1; i >= 0; i--) {
          const r = ranks[i];
          if (r.criteria_type === 'direct_joins_7_days') continue;
          if (left >= (r.left_pv || 0) && right >= (r.right_pv || 0)) {
            displayRank = r.name;
            break;
          }
        }
        downline.push({
          ...u,
          sponsor_code: sponsor ? (sponsor.user_code || sponsor.username) : '-',
          display_rank: displayRank
        });
        count++;
        if (u.left_id) stack.push(getUserById(u.left_id));
        if (u.right_id) stack.push(getUserById(u.right_id));
      }
    }
  }
  downline.sort((a, b) => (b.activated_at || b.created_at || '').localeCompare(a.activated_at || a.created_at || ''));
  res.render('downline', { user, side, downline, count });
});

app.get('/user/register', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const me = getUserById(req.session.user.id);
  const parentRef = String(req.query.parent || '').trim() || (me.user_code || me.username);
  const parent = getUserByRef(parentRef) || me;
  let sideSel = String(req.query.side || '').toLowerCase();
  if (!['left','right'].includes(sideSel)) {
    sideSel = (!parent.left_id ? 'left' : (!parent.right_id ? 'right' : null));
  }
  const pinMode = String(req.query.pin || '').trim() === '1';
  const q = { placement_side: sideSel, sponsor_ref: (parent.user_code || parent.username), placement_parent_ref: (parent.user_code || parent.username), username: '', activation_mode: pinMode ? 'pin' : 'id_only' };
  res.render('user_register', { me, q, error: null, success: null });
});

app.post('/user/register', requireAuth('user'), (req, res) => {
  const me = getUserById(req.session.user.id);
  const { username, member_name, password, email, phone, state, leader_ref, activation_mode, agree_terms, placement_parent_ref, placement_side, leadership_bonus_inr, package_pin, login_pin, sponsor_ref } = req.body;
  try {
    const agreed = String(agree_terms || '').toLowerCase() === 'on';
    if (!agreed) throw new Error('Please agree to Terms & Conditions');
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    if (!phoneDigits) throw new Error('Mobile number is required');
    if (phoneDigits.length !== 10) throw new Error('Enter valid 10-digit mobile number');
    
    const sponsorRef = String(sponsor_ref || '').trim() || (me.user_code || me.username);
    const parentRef = String(placement_parent_ref || '').trim() || sponsorRef;
    let sideVal = placement_side;
    if (Array.isArray(sideVal)) sideVal = sideVal[sideVal.length - 1];
    const side = String(sideVal || '').trim().toLowerCase();
    
    const mode = String(activation_mode || 'id_only').trim();
    let pinUsed = null;
    let pvSum = 0;

    // If pin mode, validate pin first
    if (mode === 'pin') {
      const pkg = String(package_pin || '').trim();
      const lp = String(login_pin || '').trim();
      if (!pkg || !lp) throw new Error('Package PIN and Login PIN are required');
      let p = (db.pin_packages || []).find(x => x.code === pkg && String(x.login_pin || '') === lp) || null;
      if (!p) throw new Error('Invalid PIN. Please check Package PIN and Login PIN');
      if (p.used_by || p.disabled || p.status === 'expired') throw new Error('This PIN has already been used or is inactive');
      pinUsed = p;

      // Calculate PV from pin
      if (p.product_id) {
        const product = (db.products || []).find(pr => pr.id === p.product_id) || null;
        if (!product) throw new Error('Product not found for this PIN');
        pvSum = product.bv || 0;
      } else if (p.plan_id) {
        const plan = (db.plans || []).find(pl => pl.id === p.plan_id);
        const ids = Array.isArray(p.product_ids) ? p.product_ids : (plan && plan.product_id ? [plan.product_id] : []);
        ids.forEach(id => {
          const pr = (db.products || []).find(pr => pr.id === id);
          if (pr) pvSum += (pr.bv || 0);
        });
      }
    }
    
    const newUser = addUser({
      username: (username || '').trim(),
      member_name,
      password,
      sponsor_ref: sponsorRef,
      placement_parent_ref: parentRef,
      placement_side: side || null,
      email,
      phone: phoneDigits,
      state,
      leader_ref,
      leadership_bonus_inr: leadership_bonus_inr ? parseFloat(leadership_bonus_inr) : 0,
      package_pin: pinUsed ? pinUsed.code : null,
      login_pin: pinUsed ? pinUsed.login_pin : null
    });

    // Activate user with PIN if pin mode
    if (mode === 'pin' && pinUsed) {
      pinUsed.used_by = newUser.id;
      pinUsed.used_at = DateTime.now().setZone('Asia/Kolkata').toISO();
      pinUsed.status = 'used';
      
      // Credit PV and activate
      if (pvSum > 0 && !(pinUsed && pinUsed.is_matrix_pin)) creditPV(newUser.id, pvSum, 'activation');
      
      // Matrix PIN: create auto users
      if (pinUsed && pinUsed.is_matrix_pin) {
        newUser.is_matrix_target = true;
        const leftCount = pinUsed.left_count || 10;
        const rightCount = pinUsed.right_count || 10;
        const plan = pinUsed.plan_id ? (db.plans || []).find(pl => pl.id === pinUsed.plan_id) : null;
        const bvPerUser = plan ? (plan.pv || 500) : 500;
        const findSubtreeSpot = (rootId) => {
          if (!rootId) return null;
          const q = [rootId];
          while (q.length) {
            const id = q.shift();
            const u = getUserById(id);
            if (!u) continue;
            if (!u.left_id) return { parent: u, side: 'left' };
            if (!u.right_id) return { parent: u, side: 'right' };
            q.push(u.left_id);
            q.push(u.right_id);
          }
          return null;
        };
        for (let i = 1; i <= leftCount; i++) {
          if (i === 1) createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: newUser.sponsor_id, parentId: newUser.id, side: 'left', memberName: 'Matrix L' + i, planId: pinUsed.plan_id, bv: bvPerUser });
          else { const lc = getUserById(newUser.id).left_id; const sp = lc ? findSubtreeSpot(lc) : null; if (!sp) break; createAutoUser({ username: 'MTX' + String(Date.now() + i).slice(-6) + 'L' + i, sponsorId: newUser.sponsor_id, parentId: sp.parent.id, side: sp.side, memberName: 'Matrix L' + i, planId: pinUsed.plan_id, bv: bvPerUser }); }
        }
        for (let i = 1; i <= rightCount; i++) {
          if (i === 1) createAutoUser({ username: 'MTX' + String(Date.now() + i + 100).slice(-6) + 'R' + i, sponsorId: newUser.sponsor_id, parentId: newUser.id, side: 'right', memberName: 'Matrix R' + i, planId: pinUsed.plan_id, bv: bvPerUser });
          else { const rc = getUserById(newUser.id).right_id; const sp = rc ? findSubtreeSpot(rc) : null; if (!sp) break; createAutoUser({ username: 'MTX' + String(Date.now() + i + 200).slice(-6) + 'R' + i, sponsorId: newUser.sponsor_id, parentId: sp.parent.id, side: sp.side, memberName: 'Matrix R' + i, planId: pinUsed.plan_id, bv: bvPerUser }); }
        }
        newUser.pv = 0;

        // Create leadership bonus for each auto user (not for target)
        if (newUser.leader_ref) {
          const leader = getUserByRef(newUser.leader_ref);
          if (leader) {
            const lbPlan = pinUsed.plan_id ? ((db.plans || []).find(pl => pl.id === pinUsed.plan_id) || null) : null;
            const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
            const defaultPlan = allPlans[0] || null;
            const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || 0) : (defaultPlan ? defaultPlan.leadership_bonus_inr : 0);
            if (lbAmount > 0) {
              const q = [newUser.left_id, newUser.right_id].filter(Boolean);
              while (q.length) {
                const id = q.shift();
                const au = getUserById(id);
                if (!au || !au.is_auto_created) continue;
                const exists = (db.earnings || []).find(e => e.source_user_id === au.id && e.user_id === leader.id && e.note === 'Leadership bonus (Pending)');
                if (!exists) {
                  (db.earnings || (db.earnings = [])).push({
                    id: nextId('earning'), user_id: leader.id, amount_inr: 0, gross_inr: lbAmount,
                    tds_inr: 0, admin_charge_inr: 0, net_inr: 0,
                    pending_leadership: true, note: 'Leadership bonus (Pending)',
                    source_user_id: au.id, source_user_code: au.user_code,
                    source_pin_code: pinUsed.code || null,
                    plan_id: lbPlan ? lbPlan.id : null, activation_bv: bvPerUser,
                    status: 'pending', created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
                  });
                }
                if (au.left_id) q.push(au.left_id);
                if (au.right_id) q.push(au.right_id);
              }
            }
          }
        }
      }
      
      // Mark user as active
      newUser.status = 'active';
      newUser.active = true;
      newUser.activated_at = DateTime.now().setZone('Asia/Kolkata').toISO();
      saveDB(db);
    }

    // Create pending leadership bonus (will be credited during activation/binary flush)
    // Leadership bonus - ONE TIME only, for new users with leader_ref
    const lbAmount = newUser.leadership_bonus_inr || 0;
    const settings = db.settings || {};
    if (lbAmount > 0 && leader_ref && !(pinUsed && pinUsed.is_matrix_pin) && (settings.leadership_bonus_enabled === true || settings.leadership_bonus_enabled === undefined)) {
      // Check if user already received leadership bonus (one-time only, check both pending and credited)
      const existingLB = (db.earnings || []).find(e => e.source_user_id === newUser.id && (e.note === 'Leadership bonus' || e.note === 'Leadership bonus (Pending)'));
      if (!existingLB) {
        const leader = getUserByRef(leader_ref);
        if (leader) {
          const gross = lbAmount;
          // Create as PENDING - will be credited during activation/binary flush
          (db.earnings || (db.earnings = [])).push({
            id: nextId('earning'),
            user_id: leader.id,
            amount_inr: 0,
            gross_inr: gross,
            tds_inr: 0,
            admin_charge_inr: 0,
            net_inr: 0,
            pending_leadership: true,
            note: 'Leadership bonus (Pending)',
            source_user_id: newUser.id,
            source_user_code: newUser.user_code,
            source_pin_code: pinUsed ? pinUsed.code : null,
            plan_id: pinUsed ? (pinUsed.plan_id || null) : null,
            activation_bv: pvSum,
            status: 'pending',
            created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
          });
          saveDB(db);
        }
      }
    }

    // Update sponsor's rank to check for STAR WINNER achievement
    updateUserRank(me.id);

    // Send welcome email
    sendWelcomeEmail(newUser);

    const msgTemplate = (db.settings || {}).registration_success_message || '✅ Registration successful! Welcome {name} — Your ID: {code}';
    const successMsg = msgTemplate
      .replace(/\{name\}/g, newUser.member_name || newUser.username || '')
      .replace(/\{code\}/g, newUser.user_code || '');
    return res.render('user_register', { me, q: { placement_side: newUser.placement_side || '', sponsor_ref: sponsorRef, username: newUser.username }, error: null, success: successMsg });
  } catch (e) {
    return res.render('user_register', { me, q: { placement_side: '', sponsor_ref: (me.user_code || me.username), username }, error: e.message || 'Failed to create user', success: null });
  }
});

// --- Support Tickets (User) ---
app.get('/tickets', requireAuth('user'), requireMonthlyRepurchase(), (req, res) => {
  const me = getUserById(req.session.user.id);
  const items = (db.tickets || []).filter(t => t.user_id === me.id).slice().reverse();
  res.render('tickets_user', { user: me, tickets: items, error: null, success: null });
});

app.get('/tickets/new', requireAuth('user'), (req, res) => {
  res.render('ticket_new', { error: null, success: null });
});

app.post('/tickets', requireAuth('user'), uploadSupport.single('ticket_file'), (req, res) => {
  try {
    const me = getUserById(req.session.user.id);
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();
    if (!subject || !message) {
      return res.render('ticket_new', { error: 'Subject and message are required', success: null });
    }
    const fileUrl = req.file ? '/uploads/tickets/' + req.file.filename : null;
    const ticket = {
      id: nextId('ticket'),
      user_id: me.id,
      subject,
      message,
      file_url: fileUrl,
      status: 'open',
      created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
    };
    db.tickets.push(ticket);
    saveDB(db);
    return res.redirect('/tickets');
  } catch (e) {
    return res.render('ticket_new', { error: 'Failed to submit ticket', success: null });
  }
});

// --- Support Tickets (Admin) ---
app.get('/admin/tickets', requireAuth('admin'), (req, res) => {
  const rows = (db.tickets || []).slice().reverse().map(t => {
    const user = getUserById(t.user_id);
    return {
      id: t.id,
      user_code: user ? (user.user_code || user.username) : 'Unknown',
      subject: t.subject,
      message: t.message,
      file_url: t.file_url,
      status: t.status,
      created_at: t.created_at
    };
  });
  res.render('admin_tickets', { tickets: rows });
});

app.get('/admin/tickets/:id', requireAuth('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const t = (db.tickets || []).find(x => x.id === id);
  if (!t) return res.status(404).send('Ticket not found');
  const user = getUserById(t.user_id);
  res.render('admin_ticket_view', { ticket: t, user });
});

app.get('/health', (req, res) => res.send('ok'));

// Startup cleanup: remove stale binary/match earnings
try {
  if (db.earnings) {
    const validUserIds = new Set((db.users||[]).map(u => u.id));
    const before = db.earnings.length;
    const userIdsForDeletion = new Set();
    (db.users||[]).forEach(u => {
      const totalCarry = (u.carry_left||0)+(u.carry_right||0)+(u.repurchase_carry_left||0)+(u.repurchase_carry_right||0)+(u.org_bv_left||0)+(u.org_bv_right||0)+(u.org_rep_bv_left||0)+(u.org_rep_bv_right||0);
      if (totalCarry <= 0 && !u.left_id && !u.right_id) {
        userIdsForDeletion.add(u.id);
      }
    });
    db.earnings = db.earnings.filter(e => {
      if ((e.note === 'Binary pair match' || e.note === 'Repurchase binary pair match' || e.note === 'Rank income') && (userIdsForDeletion.has(e.user_id) || !validUserIds.has(e.user_id))) {
        return false;
      }
      if (e.source_user_id && !validUserIds.has(e.source_user_id)) {
        return false;
      }
      return true;
    });
    const removed = before - db.earnings.length;
    if (removed > 0) {
      console.log(`[STARTUP] Removed ${removed} stale earnings (no active binary structure)`);
      saveDB(db);
    }
  }
} catch(e) { console.log('[STARTUP] Cleanup error:', e.message); }

app.get('/admin/matrix-diag', requireAuth('admin'), (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  const settings = getSettingsRow();
  let out = '';
  const mt = (db.users || []).filter(u => u.is_matrix_target);
  out += 'Matrix targets: ' + mt.length + '\n';
  mt.forEach(u => {
    const pin = (db.pin_packages || []).find(p => p.used_by === u.id);
    out += '  id=' + u.id + ' name=' + (u.member_name || u.username) + ' code=' + (u.user_code || '') + '\n';
    out += '    plan_id=' + (u.plan_id||'none') + ' leader_ref=' + (u.leader_ref||'none') + ' role=' + u.role + ' status=' + u.status + ' active=' + u.active + '\n';
    out += '    org_bv_L=' + (u.org_bv_left||0) + ' org_bv_R=' + (u.org_bv_right||0) + '\n';
    out += '    carry_L=' + (u.carry_left||0) + ' carry_R=' + (u.carry_right||0) + '\n';
    if (pin) out += '    PIN: ' + pin.code + ' left=' + pin.left_count + ' right=' + pin.right_count + ' plan_id=' + pin.plan_id + '\n';
    const children = (db.users || []).filter(c => c.is_auto_created && c.placement_parent_id === u.id);
    out += '    Direct auto children: ' + children.length + '\n';
    let totalAutoBvL = 0, totalAutoBvR = 0;
    children.forEach(c => {
      if (c.placement_side === 'left') totalAutoBvL += c.pv || 0;
      else totalAutoBvR += c.pv || 0;
    });
    out += '    Auto BV direct: L=' + totalAutoBvL + ' R=' + totalAutoBvR + '\n';
    let cur = getUserById(u.placement_parent_id);
    out += '    Upline: ';
    while (cur) {
      out += (cur.member_name || cur.username || 'id=' + cur.id);
      cur = getUserById(cur.placement_parent_id);
      if (cur) out += ' → ';
    }
    out += '\n';
  });
  const autoUsers = (db.users || []).filter(u => u.is_auto_created);
  out += '\nTotal auto-created users: ' + autoUsers.length + '\n';
  // Show a few auto users
  autoUsers.slice(0, 5).forEach(u => {
    out += '  id=' + u.id + ' name=' + (u.member_name || u.username) + ' pv=' + (u.pv||0) + ' parent_id=' + u.placement_parent_id + ' side=' + u.placement_side + '\n';
  });
  // Check how many auto users in tree
  let totalBvL = 0, totalBvR = 0;
  autoUsers.forEach(u => {
    if (u.placement_side === 'left') totalBvL += u.pv || 0;
    else totalBvR += u.pv || 0;
  });
  out += '\nTotal auto BV: L=' + totalBvL + ' R=' + totalBvR + '\n';
  out += '\nSettings: pair_bv_size=' + (settings.pair_bv_size || 'not set') + ' pv_on_join=' + (settings.pv_on_join || 'not set') + '\n';
  // Simulate preview loop
  out += '\nSimulating preview loop...\n';
  let simulatedCount = 0;
  (db.users || []).forEach(u => {
    if (u.role !== 'user') return;
    if (u.status !== 'active') return;
    let s = Math.max(1, settings.pair_bv_size || settings.pv_on_join || 100);
    if (u.plan_id) {
      const up = (db.plans || []).find(p => p.id === u.plan_id);
      if (up && up.pv > 0) s = up.pv;
    }
    const l = u.carry_left || 0;
    const r = u.carry_right || 0;
    const rl = u.repurchase_carry_left || 0;
    const rr = u.repurchase_carry_right || 0;
    const totalLeftBV = l + rl;
    const totalRightBV = r + rr;
    const matchedBV = Math.min(totalLeftBV, totalRightBV);
    const totalPairs = Math.floor(matchedBV / s);
    if (totalPairs > 0) {
      out += '  id=' + u.id + ' code=' + (u.user_code || '') + ' name=' + (u.member_name || u.username) + ' pairs=' + totalPairs + ' carry_L=' + l + ' carry_R=' + r + '\n';
      simulatedCount++;
    }
  });
  if (simulatedCount === 0) out += '  (none - 0 users with pairs > 0)\n';
  const target = (db.users || []).find(u => u.id === 1527);
  if (target) {
    let s = Math.max(1, settings.pair_bv_size || settings.pv_on_join || 100);
    if (target.plan_id) {
      const up = (db.plans || []).find(p => p.id === target.plan_id);
      if (up && up.pv > 0) s = up.pv;
    }
    const l = target.carry_left || 0;
    const r = target.carry_right || 0;
    const m = Math.min(l, r);
    const pairs = Math.floor(m / s);
    const pos = simulatedCount > 0 ? 'YES - would show in preview' : 'NO - would NOT show';
    out += '\nPreview calc for NIPL202181:\n';
    out += '  carry_L=' + l + ' carry_R=' + r + '\n';
    out += '  size=' + s + ' matched=' + m + ' pairs=' + pairs + ' -> ' + pos + '\n';
    out += '  role=' + target.role + ' status=' + target.status + ' plan_id=' + JSON.stringify(target.plan_id) + '\n';
  }
  res.send(out);
});

// Startup fix: create/update leadership bonus entries for matrix auto-users (runs once)
(function fixMatrixLeadership() {
  if (db._leadership_fixed2) return;
  let totalCreated = 0, totalUpdated = 0;
  const targets = (db.users || []).filter(u => u.is_matrix_target && u.leader_ref);
  targets.forEach(t => {
    const leader = getUserByRef(t.leader_ref);
    if (!leader) return;
    const allPlans = (db.plans || []).filter(pl => pl.active && pl.leadership_bonus_inr > 0);
    const defaultPlan = allPlans[0] || null;
    const defaultLB = defaultPlan ? defaultPlan.leadership_bonus_inr : 0;
    if (defaultLB <= 0) return;
    const q = [t.left_id, t.right_id].filter(Boolean);
    while (q.length) {
      const id = q.shift();
      const au = getUserById(id);
      if (!au || !au.is_auto_created) continue;
      const lbPlan = au.plan_id ? ((db.plans || []).find(pl => pl.id === au.plan_id) || null) : null;
      const lbAmount = lbPlan ? (lbPlan.leadership_bonus_inr || defaultLB) : defaultLB;
      if (lbAmount <= 0) continue;
      const existing = (db.earnings || []).find(e => e.source_user_id === au.id && e.user_id === leader.id && e.note === 'Leadership bonus (Pending)');
      if (existing) {
        if (existing.gross_inr !== lbAmount) {
          existing.gross_inr = lbAmount;
          existing.plan_id = lbPlan ? lbPlan.id : (defaultPlan ? defaultPlan.id : null);
          totalUpdated++;
        }
      } else {
        (db.earnings || (db.earnings = [])).push({
          id: nextId('earning'), user_id: leader.id, amount_inr: 0, gross_inr: lbAmount,
          tds_inr: 0, admin_charge_inr: 0, net_inr: 0,
          pending_leadership: true, note: 'Leadership bonus (Pending)',
          source_user_id: au.id, source_user_code: au.user_code,
          source_pin_code: null,
          plan_id: lbPlan ? lbPlan.id : (defaultPlan ? defaultPlan.id : null), activation_bv: au.pv || 0,
          status: 'pending', created_at: DateTime.now().setZone('Asia/Kolkata').toISO()
        });
        totalCreated++;
      }
      if (au.left_id) q.push(au.left_id);
      if (au.right_id) q.push(au.right_id);
    }
  });
  db._leadership_fixed2 = true;
  saveDB(db);
  console.log('[FIX] Leadership: created ' + totalCreated + ' updated ' + totalUpdated + ' entries');
})();

// Startup fix: remove orphaned celebrations (rank_achieved not in rank_history for that user)
(function fixOrphanedCelebrations() {
  if (db._celebration_fixed) return;
  let removed = 0;
  const validPairs = new Set();
  (db.rank_history || []).forEach(h => validPairs.add(h.user_id + '|' + h.rank_name));
  (db.users || []).filter(u => u.rank_name).forEach(u => validPairs.add(u.id + '|' + u.rank_name));
  db.celebrations = (db.celebrations || []).filter(c => {
    const key = c.user_id + '|' + c.rank_achieved;
    if (!validPairs.has(key)) { removed++; return false; }
    return true;
  });
  db._celebration_fixed = true;
  console.log('[FIX] Celebrations: removed ' + removed + ' orphaned entries');
})();

app.listen(APP_PORT, () => {
  console.log(`Nastige app listening on port ${APP_PORT}`);
  // Daily midnight pin cleanup — archive all pins from View All Pins
  function schedulePinCleanup() {
    const nowIST = DateTime.now().setZone('Asia/Kolkata');
    const nextMidnight = nowIST.startOf('day').plus({ days: 1 });
    const ms = nextMidnight.toMillis() - nowIST.toMillis();
    setTimeout(() => {
      const ts = nowIST.toISO();
      (db.pin_packages || []).forEach(p => { if (!p.archived_at) p.archived_at = ts; });
      saveDB(db);
      console.log('[PIN CLEANUP] All pins archived at', ts);
      schedulePinCleanup(); // schedule next day
    }, ms);
  }
  schedulePinCleanup();
});
})(); // end async bootstrap

