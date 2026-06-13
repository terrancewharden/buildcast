const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

require('dns').setDefaultResultOrder('ipv4first');

const PORT           = process.env.PORT || 3000;
const FAL_KEY        = process.env.FAL_KEY;
const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY;
const JWT_SECRET     = process.env.JWT_SECRET     || 'buildcast-jwt-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'buildcast-admin';
const FILE           = path.join(__dirname, 'buildcast.html');
const ADMIN_FILE     = path.join(__dirname, 'admin.html');
const USERS_FILE     = path.join(__dirname, 'users.json');
const STATS_FILE     = path.join(__dirname, 'stats.json');

/* ── Postgres via 'postgres' npm package (not pg) ─────────── */
let _sql = null;
function getSql() {
  if (!_sql && process.env.DATABASE_URL) {
    const postgres = require('postgres');
    // Works with Neon, Supabase, Railway Postgres, or any standard Postgres URL
    _sql = postgres(process.env.DATABASE_URL, {
      ssl: 'require',
      max: 10,
      idle_timeout: 20,
      connect_timeout: 30,
      onnotice: () => {},
    });
  }
  return _sql;
}

async function initDB() {
  const sql = getSql();
  if (!sql) { console.log('[DB] No DATABASE_URL — using JSON file fallback'); return; }
  await new Promise(r => setTimeout(r, 2000));
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS bc_users (
        id               TEXT PRIMARY KEY,
        email            TEXT UNIQUE NOT NULL,
        password         TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        videos_generated INT NOT NULL DEFAULT 0,
        last_active      TIMESTAMPTZ
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS bc_stats (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '0'
      )`;
    await sql`
      INSERT INTO bc_stats (key, value) VALUES
        ('videos', '0'), ('signups', '0'),
        ('videos_by_day', '{}'), ('signups_by_day', '{}')
      ON CONFLICT (key) DO NOTHING`;
    await sql`
      CREATE TABLE IF NOT EXISTS bc_messages (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT NOT NULL,
        message    TEXT NOT NULL,
        reply      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        replied_at TIMESTAMPTZ,
        read       BOOLEAN NOT NULL DEFAULT false
      )`;
    // Watermark profile columns (added in v2)
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS wm_logo    TEXT`;
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS wm_website TEXT`;
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS wm_phone   TEXT`;
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS avatar     TEXT`;
    // v3 — Job Board, Portfolio, Bid Mode (June 2026)
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS username      TEXT UNIQUE`;
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS business_name TEXT`;
    await sql`ALTER TABLE bc_users ADD COLUMN IF NOT EXISTS tagline       TEXT`;
    await sql`
      CREATE TABLE IF NOT EXISTS bc_jobs (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT REFERENCES bc_users(id) ON DELETE CASCADE,
        job_name    TEXT NOT NULL,
        client_name TEXT,
        job_type    TEXT,
        start_date  DATE,
        end_date    DATE,
        milestone   INT NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS bc_videos (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT REFERENCES bc_users(id) ON DELETE CASCADE,
        job_id        INT REFERENCES bc_jobs(id) ON DELETE SET NULL,
        video_url     TEXT NOT NULL,
        project_type  TEXT,
        job_name      TEXT,
        thumbnail_url TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_public     BOOLEAN NOT NULL DEFAULT TRUE
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS bc_bids (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT REFERENCES bc_users(id) ON DELETE CASCADE,
        job_id       INT REFERENCES bc_jobs(id) ON DELETE SET NULL,
        before_url   TEXT,
        render_url   TEXT,
        project_type TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    console.log('[DB] Postgres ready ✓');
  } catch(e) {
    console.error('[DB] initDB error:', e.message);
  }
}

/* ── JSON file fallback (no DATABASE_URL) ─────────────────── */
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers(u) { try { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); } catch{} }
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { return { videos:0, signups:0, signupsByDay:{}, videosByDay:{} }; }
}
function saveStats(s) { try { fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2)); } catch{} }
function _jsonIncrementStat(key) {
  const s = loadStats();
  s[key] = (s[key] || 0) + 1;
  const today = new Date().toISOString().slice(0,10);
  if (key === 'signups') { s.signupsByDay = s.signupsByDay||{}; s.signupsByDay[today] = (s.signupsByDay[today]||0)+1; }
  if (key === 'videos')  { s.videosByDay  = s.videosByDay ||{}; s.videosByDay[today]  = (s.videosByDay[today] ||0)+1; }
  saveStats(s);
}

/* ── DB abstraction layer (Postgres first, JSON fallback) ──── */

async function dbGetUserByEmail(email) {
  const sql = getSql(); const em = email.toLowerCase().trim();
  if (!sql) return loadUsers().find(u => u.email === em) || null;
  const rows = await sql`SELECT * FROM bc_users WHERE email = ${em}`;
  if (!rows[0]) return null;
  const u = rows[0];
  return { id:u.id, email:u.email, password:u.password,
    createdAt:u.created_at, videosGenerated:u.videos_generated, lastActive:u.last_active,
    wmLogo:u.wm_logo||null, wmWebsite:u.wm_website||null, wmPhone:u.wm_phone||null, avatar:u.avatar||null,
    username:u.username||null, businessName:u.business_name||null, tagline:u.tagline||null };
}

async function dbCreateUser(user) {
  const sql = getSql();
  if (!sql) { const u = loadUsers(); u.push(user); saveUsers(u); return; }
  await sql`INSERT INTO bc_users (id, email, password, created_at)
            VALUES (${user.id}, ${user.email}, ${user.password}, ${user.createdAt})`;
}

async function dbIncrementUserVideos(userId) {
  const sql = getSql();
  if (!sql) {
    const u = loadUsers(); const usr = u.find(x => x.id === userId);
    if (usr) { usr.videosGenerated = (usr.videosGenerated||0)+1; usr.lastActive = new Date().toISOString(); saveUsers(u); }
    return;
  }
  await sql`UPDATE bc_users SET videos_generated = videos_generated + 1, last_active = NOW() WHERE id = ${userId}`;
}

async function dbUpdateUserProfile(userId, { wmLogo, wmWebsite, wmPhone, username, businessName, tagline }) {
  const sql = getSql();
  if (!sql) {
    const u = loadUsers(); const usr = u.find(x => x.id === userId);
    if (usr) { usr.wmLogo = wmLogo; usr.wmWebsite = wmWebsite; usr.wmPhone = wmPhone; usr.username = username; usr.businessName = businessName; usr.tagline = tagline; saveUsers(u); }
    return;
  }
  await sql`UPDATE bc_users SET wm_logo=${wmLogo||null}, wm_website=${wmWebsite||null}, wm_phone=${wmPhone||null}, username=${username||null}, business_name=${businessName||null}, tagline=${tagline||null}, avatar=${avatar||null} WHERE id=${userId}`;
}

async function dbIncrementStat(key) {
  const sql = getSql();
  if (!sql) { _jsonIncrementStat(key); return; }
  const today = new Date().toISOString().slice(0,10);
  try {
    await sql`UPDATE bc_stats SET value = (value::int + 1)::text WHERE key = ${key}`;
    const byDayKey = `${key}_by_day`;
    const rows = await sql`SELECT value FROM bc_stats WHERE key = ${byDayKey}`;
    const map = JSON.parse(rows[0]?.value || '{}');
    map[today] = (map[today] || 0) + 1;
    await sql`UPDATE bc_stats SET value = ${JSON.stringify(map)} WHERE key = ${byDayKey}`;
  } catch(e) { console.error('[DB] incrementStat error:', e.message); }
}

async function dbGetStats() {
  const sql = getSql();
  if (!sql) return loadStats();
  const rows = await sql`SELECT key, value FROM bc_stats`;
  const s = {};
  rows.forEach(row => { try { s[row.key] = JSON.parse(row.value); } catch { s[row.key] = parseInt(row.value)||0; } });
  return { videos: s.videos||0, signups: s.signups||0, signupsByDay: s.signups_by_day||{}, videosByDay: s.videos_by_day||{} };
}

async function dbGetAllUsers(limit = 50) {
  const sql = getSql();
  if (!sql) return loadUsers().slice(-limit).reverse().map(u => ({
    email:u.email, createdAt:u.createdAt, videosGenerated:u.videosGenerated||0, lastActive:u.lastActive||null,
  }));
  const rows = await sql`SELECT email, created_at, videos_generated, last_active FROM bc_users ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(u => ({ email:u.email, createdAt:u.created_at, videosGenerated:u.videos_generated, lastActive:u.last_active }));
}

/* ── Auth helpers ─────────────────────────────────────────── */
function hashPw(pw)  { return crypto.createHmac('sha256', JWT_SECRET).update(pw).digest('hex'); }
function makeToken(id, email) {
  const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const p = Buffer.from(JSON.stringify({sub:id,email,iat:Date.now(),exp:Date.now()+864e6})).toString('base64url');
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
function parseToken(token) {
  try {
    const [h,p,s] = (token||'').split('.');
    const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
    if (s !== exp) return null;
    const d = JSON.parse(Buffer.from(p,'base64url').toString());
    return d.exp < Date.now() ? null : d;
  } catch { return null; }
}
function getBearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Kling v3 Pro — proper start+end frame anchoring (start_image_url + end_image_url)
const KLING_MODEL = 'fal-ai/kling-video/v3/pro/image-to-video';


const STRIPE_PRICES = {
  starter: 'price_1TNxQNCeomIgjT0aBnT8Fsf7',  // $10/mo
  pro:     'price_1TNxUQCeomIgjT0ahzyJb23n',   // $30/mo
  studio:  'price_1TNxVmCeomIgjT0atBzsbDTn'    // $50/mo
};

// FLUX schnell — fast photorealistic image generation
const FLUX_MODEL = 'fal-ai/flux/schnell';

// FLUX Dev image-to-image — transforms before photo into finished project look
const FLUX_IMG2IMG_MODEL = 'fal-ai/flux/dev/image-to-image';

// Image size mapping by aspect ratio
const FLUX_SIZES = {
  '9:16':  'portrait_16_9',
  '16:9':  'landscape_16_9',
  '1:1':   'square_hd',
};

// Prompt library for AI photo generation (before/after × project type)
const IMAGE_PROMPTS = {
  before: {
    'Residential New Construction':    'empty residential construction lot, site preparation stage, bare dirt ground, wood framing stakes, blue sky, photorealistic professional photography, wide shot',
    'Commercial New Construction':     'empty commercial construction site, excavated ground, heavy equipment, clear sky, photorealistic wide establishing shot',
    'Residential Interior Renovation': 'home interior before renovation, dated finishes, original walls and flooring, demo crew beginning work, photorealistic',
    'Commercial Interior Renovation':  'commercial interior space before renovation, dated finishes, old fixtures, demo crew starting work, photorealistic',
    'Residential Exterior Renovation': 'home exterior before renovation, dated paint, old windows, worn siding, photorealistic wide shot',
    'Staging':                         'empty unfurnished room, bare walls, no furniture, vacant real estate listing space, photorealistic',
    'Interior Design':                 'empty room before interior design, bare walls, plain floors, no decor or furniture, photorealistic',
    'Exterior Design':                 'plain home exterior before redesign, no landscaping, minimal details, photorealistic wide shot',
    'Landscaping':                     'bare dirt yard before landscaping, empty lot, no plantings, landscaping crew on site, photorealistic',
    'Roofing':                         'home with old worn roof before replacement, damaged shingles, weathered surface, photorealistic',
    'Framing':                         'empty construction lot or foundation slab, no framing erected yet, bare site, photorealistic',
    'Backyard':                        'bare backyard, empty dirt or dead grass, no landscaping or structures, photorealistic wide shot',
  },
  after: {
    'Residential New Construction':    'newly completed modern residential home, finished exterior, fresh landscaping, clear sky, professional real estate photography, photorealistic',
    'Commercial New Construction':     'completed modern commercial building, finished facade, professional architectural photography, photorealistic',
    'Residential Interior Renovation': 'beautifully renovated home interior, modern finishes, fresh paint, new flooring, professional interior photography, photorealistic',
    'Commercial Interior Renovation':  'renovated commercial interior, modern finishes, professional lighting, updated fixtures, clean and polished, photorealistic',
    'Residential Exterior Renovation': 'beautifully renovated home exterior, fresh paint, new windows and siding, improved curb appeal, photorealistic',
    'Staging':                         'professionally staged room, tasteful furniture, art, plants, inviting and market-ready, real estate photography, photorealistic',
    'Interior Design':                 'beautifully designed interior, curated furniture and decor, designer lighting, styled and refined, photorealistic',
    'Exterior Design':                 'stunning finished exterior design, architectural details, curated landscaping, dramatic curb appeal, photorealistic',
    'Landscaping':                     'lush completed landscaping, green lawn, planted beds, stone hardscape, professional outdoor photography, photorealistic',
    'Roofing':                         'newly completed roof installation, clean new shingles, perfect ridge line, sharp professional finish, photorealistic',
    'Framing':                         'newly completed building frame, clean wood or steel framing fully erected, roof structure visible, professional construction photography, photorealistic',
    'Backyard':                        'stunning completed backyard transformation, beautiful outdoor living space, lush landscaping, professional outdoor photography, photorealistic',
  }
};

/* ── Prompt builder ───────────────────────────────────────── */
const PROMPTS = {
  'Residential New Construction':    'residential new construction timelapse, empty lot to finished home, foundation poured, framing erected, exterior completed, smooth realistic transformation, photorealistic',
  'Commercial New Construction':     'commercial construction timelapse, excavated lot to completed building, steel structure rising, exterior cladding, professional progress, photorealistic',
  'Residential Interior Renovation': 'residential interior renovation timelapse, demo of old space transforming into modern finished room, smooth realistic construction progress, photorealistic',
  'Commercial Interior Renovation':  'commercial interior renovation timelapse, dated space being gutted and transformed into modern finished commercial interior, smooth realistic progress, photorealistic',
  'Residential Exterior Renovation': 'residential exterior renovation timelapse, worn home exterior being transformed with new siding, windows, paint and details, smooth realistic transition, photorealistic',
  'Staging':                         'room staging transformation timelapse, empty vacant room being furnished and styled into a beautifully staged space, smooth realistic transition, photorealistic',
  'Interior Design':                 'interior design transformation timelapse, bare room being transformed with curated furniture, lighting and decor into a stunning designed space, photorealistic',
  'Exterior Design':                 'exterior design transformation timelapse, plain home exterior being redesigned with architectural details, paint and landscaping, smooth realistic transformation, photorealistic',
  'Landscaping':                     'landscaping transformation timelapse, bare dirt yard transforming into lush finished outdoor space with plantings and hardscape, realistic, photorealistic',
  'Roofing':                         'roofing transformation timelapse, old worn roof being stripped and replaced with crisp new roofing material, smooth realistic installation progress, photorealistic',
  'Framing':                         'framing timelapse, bare foundation or empty lot transforming into fully framed structure with walls and roof framing erected, smooth realistic construction progress, photorealistic',
  'Backyard':                        'backyard transformation timelapse, bare empty yard transforming into stunning outdoor living space with landscaping, structures and lighting, smooth realistic transition, photorealistic',
};

// Mid-construction prompts for auto-generated FLUX midpoint (30s chained videos)
const MID_PROMPTS = {
  'Residential New Construction':    'residential home under construction, wood framing fully erected, roof structure visible, construction crew on site, blue sky, photorealistic wide shot',
  'Commercial New Construction':     'commercial building under active construction, steel skeleton structure erected, concrete floors poured, cranes visible, photorealistic wide shot',
  'Residential Interior Renovation': 'home interior mid-renovation, walls partially opened, new framing and rough plumbing visible, construction materials staged, photorealistic',
  'Commercial Interior Renovation':  'commercial interior mid-renovation, walls stripped to framing, electrical rough-in visible, construction crew working, photorealistic',
  'Residential Exterior Renovation': 'home exterior mid-renovation, old siding removed, house wrap installed, new windows partially installed, crew working, photorealistic',
  'Staging':                         'room partially staged, some furniture placed, artwork leaning against wall, styling in progress, photorealistic',
  'Interior Design':                 'room mid-design installation, furniture being arranged, lighting being hung, decor partially placed, photorealistic',
  'Exterior Design':                 'home exterior mid-redesign, painting in progress, new trim being installed, landscaping partially planted, photorealistic',
  'Landscaping':                     'landscaping mid-installation, soil graded, irrigation pipes being laid, partial plantings visible, workers on site, photorealistic',
  'Roofing':                         'roof mid-installation, old shingles partially removed, underlayment exposed, crew installing new roofing material, photorealistic',
  'Framing':                         'building mid-framing, partial wall framing erected, some walls standing and some still open, lumber stacked on site, crew working, photorealistic',
  'Backyard':                        'backyard mid-transformation, grading complete, hardscape being installed, partial plantings, crew working, photorealistic',
};

function buildPrompt(projectType) {
  return PROMPTS[projectType] || PROMPTS['Residential New Construction'];
}

/* ── fal.ai helpers ───────────────────────────────────────── */

// Upload a base64 data URL to fal.ai CDN storage and return a real HTTPS URL.
// Required for models like FLUX img2img that don't accept base64 data URIs.
function uploadBase64ToFal(base64DataUrl) {
  return new Promise((resolve, reject) => {
    const m = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) return reject(new Error('Invalid image data URL'));
    const contentType  = m[1];
    const imageBuffer  = Buffer.from(m[2], 'base64');

    // Step 1 — get presigned upload URL from fal.ai storage
    const initBody = JSON.stringify({ content_type: contentType, file_size: imageBuffer.length });
    const initReq  = https.request({
      hostname: 'rest.fal.run',
      path:     '/storage/upload/initiate',
      method:   'POST',
      headers:  {
        'Authorization':  `Key ${FAL_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(initBody),
      }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(out); } catch(e) { return reject(new Error('Bad JSON from fal.ai storage initiate')); }
        if (!data.upload_url) return reject(new Error(`fal.ai storage initiate failed: ${out.slice(0,200)}`));

        // Step 2 — PUT the image buffer to the presigned URL
        const uploadUrl = new URL(data.upload_url);
        const putReq = https.request({
          hostname: uploadUrl.hostname,
          path:     uploadUrl.pathname + uploadUrl.search,
          method:   'PUT',
          headers:  { 'Content-Type': contentType, 'Content-Length': imageBuffer.length }
        }, putRes => {
          putRes.on('data', () => {});
          putRes.on('end', () => {
            if (!data.file_url) return reject(new Error('fal.ai storage upload succeeded but no file_url returned'));
            resolve(data.file_url);
          });
        });
        putReq.on('error', reject);
        putReq.write(imageBuffer);
        putReq.end();
      });
    });
    initReq.on('error', reject);
    initReq.write(initBody);
    initReq.end();
  });
}

/* ── fal.ai error classifier ─────────────────────────────── */
function formatFalError(msgOrErr) {
  const msg = typeof msgOrErr === 'string' ? msgOrErr : (msgOrErr.message || String(msgOrErr));
  // Credit / billing exhausted
  if (/FAL_CREDITS_EXHAUSTED|insufficient.*credit|credit.*insufficient|out of credit|no.*credit|quota.*exceed|billing.*required|payment.*required|balance.*insufficient|not enough.*credit/i.test(msg)) {
    return 'AI credits are currently unavailable. Please top up your fal.ai account at fal.ai/dashboard and try again.';
  }
  // Rate limiting
  if (/FAL_RATE_LIMIT|rate.?limit|too many request/i.test(msg)) {
    return 'Too many requests — please wait a moment and try again.';
  }
  // Auth / key issues
  if (/unauthorized|invalid.*key|forbidden|403|401/i.test(msg)) {
    return 'fal.ai API key is invalid or expired. Please check FAL_KEY in Railway → Variables.';
  }
  return msg;
}

function falPost(model, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'queue.fal.run',
      path:     `/${model}`,
      method:   'POST',
      headers: {
        'Authorization':  `Key ${FAL_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        console.log(`[fal.ai POST /${model}] status=${res.statusCode} body=${out.slice(0,400)}`);
        // Catch HTTP-level credit/auth errors before JSON parsing
        if (res.statusCode === 402) {
          return reject(new Error('FAL_CREDITS_EXHAUSTED'));
        }
        if (res.statusCode === 429) {
          return reject(new Error('FAL_RATE_LIMIT'));
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('fal.ai API key is invalid or expired. Please check FAL_KEY in Railway → Variables.'));
        }
        try {
          const parsed = JSON.parse(out);
          // Also check the response body for credit-related messages (fal.ai sometimes returns 200 with an error body)
          const errText = (typeof parsed.detail === 'string' ? parsed.detail : '') +
                          (typeof parsed.error  === 'string' ? parsed.error  : '');
          if (/insufficient.*credit|credit.*insufficient|out of credit|no.*credit|quota.*exceed|billing|payment.*required|balance.*insufficient/i.test(errText)) {
            return reject(new Error('FAL_CREDITS_EXHAUSTED'));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`fal.ai returned non-JSON (status ${res.statusCode}): ${out.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function falGet(urlPath) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'queue.fal.run',
      path:     urlPath,
      headers:  { 'Authorization': `Key ${FAL_KEY}` }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        console.log(`[fal.ai GET ${urlPath}] status=${res.statusCode} body=${out.slice(0,200)}`);
        try   { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`fal.ai GET returned non-JSON (status ${res.statusCode}): ${out.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

/* ── Stripe helper ────────────────────────────────────────── */
function stripePost(endpoint, params) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(params).toString();
    const req  = https.request({
      hostname: 'api.stripe.com',
      path:     `/v1/${endpoint}`,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${STRIPE_SECRET}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error('Bad JSON from Stripe')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ── Body reader (10MB limit for base64 images) ───────────── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > 25 * 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try   { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Content-Length':              Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/* ── Server ───────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── Serve main app ── */
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?') || req.url.startsWith('/pro/'))) {
    fs.readFile(FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Server error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  /* ── Start AI timelapse generation ── */
  if (req.method === 'POST' && req.url === '/api/generate') {
    try {
      if (!FAL_KEY) {
        return json(res, 500, { error: 'FAL_KEY not configured. Add it in Railway → Variables.' });
      }

      const { before, after, projectType, aspectRatio, duration } = await readBody(req);
      if (!before || !after) return json(res, 400, { error: 'Missing before or after image' });

      const prompt = buildPrompt(projectType || 'Residential New Construction');

      // Pass base64 data URIs directly — fal.ai accepts them for both fields.
      // External storage domains (rest.fal.run, storage.fal.run) and self-hosted
      // Railway URLs are both unreachable from fal.ai's network.
      console.log(`[BuildCast] Submitting job — before len=${before.length} after len=${after.length}`);

      // Kling v3: start_image_url = first frame, end_image_url = last frame
      // v3 properly anchors both ends of the transformation
      const result = await falPost(KLING_MODEL, {
        prompt,
        start_image_url: before,
        end_image_url:   after,
        duration:        duration === '15' ? '15' : duration === '10' ? '10' : '5',
        aspect_ratio:    aspectRatio || '9:16',
        generate_audio:  true,
      });

      if (result.detail || result.error) {
        const errMsg = result.detail || result.error;
        console.error('fal.ai submit error:', errMsg);
        return json(res, 500, { error: formatFalError(errMsg) });
      }

      console.log(`[BuildCast] Job started → ${result.request_id}`);
      json(res, 200, {
        requestId:   result.request_id,
        statusUrl:   result.status_url,    // e.g. queue.fal.run/fal-ai/kling-video/requests/{id}/status
        responseUrl: result.response_url   // e.g. queue.fal.run/fal-ai/kling-video/requests/{id}
      });

    } catch(e) {
      console.error('Generate error:', e.message);
      json(res, 500, { error: formatFalError(e) });
    }
    return;
  }

  /* ── Poll generation status ── */
  if (req.method === 'GET' && req.url.startsWith('/api/status')) {
    try {
      if (!FAL_KEY) return json(res, 500, { error: 'FAL_KEY not configured' });

      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      if (!id) return json(res, 400, { error: 'Missing id param' });

      // Use fal.ai's own status_url and response_url from the generate step
      const params   = new URL(req.url, 'http://localhost').searchParams;
      const statusUrl   = params.get('statusUrl');
      const responseUrl = params.get('responseUrl');

      if (!statusUrl || !responseUrl) {
        return json(res, 400, { error: 'Missing statusUrl or responseUrl params' });
      }

      // Extract just the path from the full URL fal.ai gave us
      const statusPath   = new URL(statusUrl).pathname;
      const responsePath = new URL(responseUrl).pathname;

      // Step 1: check status
      const statusData = await falGet(statusPath);
      console.log(`[BuildCast] Status: ${statusData.status}`);

      if ((statusData.status || '').toUpperCase() === 'COMPLETED') {
        // Step 2: fetch the result
        const resultData = await falGet(responsePath);
        console.log(`[BuildCast] Result keys: ${Object.keys(resultData).join(', ')}`);

        const videoUrl =
          resultData?.video?.url               ||
          resultData?.output?.video?.url       ||
          resultData?.outputs?.[0]?.video?.url ||
          null;

        if (!videoUrl) {
          console.error('[BuildCast] No videoUrl found:', JSON.stringify(resultData).slice(0, 500));
          return json(res, 500, { error: 'Video ready but URL not found. Check logs.' });
        }

        console.log(`[BuildCast] Complete → ${videoUrl}`);
        json(res, 200, { status: 'completed', videoUrl });

      } else if ((statusData.status || '').toUpperCase() === 'FAILED' || statusData.error) {
        json(res, 200, { status: 'failed', error: statusData.error || 'AI generation failed' });
      } else {
        json(res, 200, { status: 'processing' });
      }

    } catch(e) {
      console.error('Status error:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── Stripe checkout ── */
  if (req.method === 'POST' && req.url === '/api/checkout') {
    try {
      if (!STRIPE_SECRET) return json(res, 500, { error: 'STRIPE_SECRET_KEY not configured' });
      const { plan } = await readBody(req);
      const priceId  = STRIPE_PRICES[plan];
      if (!priceId) return json(res, 400, { error: 'Invalid plan' });

      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host  = req.headers['x-forwarded-host']  || req.headers.host;
      const base  = `${proto}://${host}`;

      const session = await stripePost('checkout/sessions', {
        'mode':                    'subscription',
        'success_url':             `${base}/?success=true&plan=${plan}`,
        'cancel_url':              `${base}/?canceled=true`,
        'line_items[0][price]':    priceId,
        'line_items[0][quantity]': '1',
        'allow_promotion_codes':   'true'
      });

      if (session.error) return json(res, 500, { error: session.error.message });
      json(res, 200, { url: session.url });
    } catch(e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── AI Photo Generation (FLUX) ── */
  if (req.method === 'POST' && req.url === '/api/generate-image') {
    try {
      if (!FAL_KEY) return json(res, 500, { error: 'FAL_KEY not configured' });
      const { projectType, slot, aspectRatio, customPrompt } = await readBody(req);

      const basePrompt = customPrompt ||
        (IMAGE_PROMPTS[slot]?.[projectType] ?? IMAGE_PROMPTS['before']['Residential New Construction']);
      const fullPrompt = `${basePrompt}, high resolution, sharp focus, no text, no watermarks`;
      const imageSize  = FLUX_SIZES[aspectRatio] || 'portrait_16_9';

      console.log(`[BuildCast] Generating image — slot=${slot} size=${imageSize}`);

      // Submit to fal.ai queue
      const submit = await falPost(FLUX_MODEL, {
        prompt:               fullPrompt,
        image_size:           imageSize,
        num_inference_steps:  4,
        num_images:           1,
        enable_safety_checker: false,
      });

      if (submit.detail || submit.error) {
        return json(res, 500, { error: submit.detail || submit.error });
      }

      // Poll until complete (FLUX schnell is typically 5-20s)
      const statusPath   = new URL(submit.status_url).pathname;
      const responsePath = new URL(submit.response_url).pathname;

      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const statusData = await falGet(statusPath);
        if ((statusData.status || '').toUpperCase() === 'COMPLETED') {
          const resultData = await falGet(responsePath);
          const imageUrl = resultData?.images?.[0]?.url || resultData?.image?.url || null;
          if (!imageUrl) return json(res, 500, { error: 'Image ready but URL not found' });
          console.log(`[BuildCast] Image generated → ${imageUrl.slice(0,80)}`);
          return json(res, 200, { imageUrl });
        }
        if ((statusData.status || '').toUpperCase() === 'FAILED') {
          return json(res, 500, { error: statusData.error || 'Image generation failed' });
        }
      }
      return json(res, 500, { error: 'Image generation timed out' });

    } catch(e) {
      console.error('Generate-image error:', e.message);
      json(res, 500, { error: formatFalError(e) });
    }
    return;
  }

  /* ── Project Preview — FLUX img2img style visualizer ── */
  if (req.method === 'POST' && req.url === '/api/generate-preview') {
    try {
      if (!FAL_KEY) return json(res, 500, { error: 'FAL_KEY not configured' });

      const { beforeImage, stylePrompt, aspectRatio } = await readBody(req);
      if (!beforeImage || !stylePrompt) {
        return json(res, 400, { error: 'Missing beforeImage or stylePrompt' });
      }

      // Build the full prompt
      const fullPrompt = `${stylePrompt}, photorealistic professional photography, finished construction, no scaffolding, no construction equipment, clean and complete, high resolution`;
      const imageSize  = FLUX_SIZES[aspectRatio] || 'square_hd';

      // FLUX img2img requires a real HTTP URL — upload base64 to fal.ai CDN first
      console.log(`[BuildCast] Uploading before image to fal.ai storage...`);
      const uploadedUrl = await uploadBase64ToFal(beforeImage);
      console.log(`[BuildCast] Uploaded → ${uploadedUrl.slice(0, 80)}`);
      console.log(`[BuildCast] Generating project preview — size=${imageSize}`);

      // Submit to img2img queue
      // strength 0.75 = strong transformation while preserving spatial context
      const submit = await falPost(FLUX_IMG2IMG_MODEL, {
        image_url:           uploadedUrl,
        prompt:              fullPrompt,
        strength:            0.75,
        num_inference_steps: 28,
        guidance_scale:      3.5,
        num_images:          1,
        image_size:          imageSize,
      });

      if (submit.detail || submit.error) {
        return json(res, 500, { error: submit.detail || submit.error });
      }

      const statusPath   = new URL(submit.status_url).pathname;
      const responsePath = new URL(submit.response_url).pathname;

      // Poll until complete (FLUX Dev img2img ~15–40s)
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const sd = await falGet(statusPath);
        if ((sd.status || '').toUpperCase() === 'COMPLETED') {
          const rd       = await falGet(responsePath);
          const imageUrl = rd?.images?.[0]?.url || rd?.image?.url || null;
          if (!imageUrl) return json(res, 500, { error: 'Preview ready but URL not found' });
          console.log(`[BuildCast] Preview generated → ${imageUrl.slice(0, 80)}`);
          return json(res, 200, { imageUrl });
        }
        if ((sd.status || '').toUpperCase() === 'FAILED') {
          return json(res, 500, { error: sd.error || 'Preview generation failed' });
        }
      }
      return json(res, 500, { error: 'Preview generation timed out' });

    } catch(e) {
      console.error('Generate-preview error:', e.message);
      json(res, 500, { error: formatFalError(e) });
    }
    return;
  }

  /* ── 30-second chained generation (auto midpoint + 2 × 15s clips) ── */
  if (req.method === 'POST' && req.url === '/api/generate-30s') {
    try {
      if (!FAL_KEY) return json(res, 500, { error: 'FAL_KEY not configured' });

      const { before, after, mid: clientMid, projectType, aspectRatio } = await readBody(req);
      if (!before || !after) return json(res, 400, { error: 'Missing before or after image' });

      const prompt    = buildPrompt(projectType || 'Residential New Construction');
      const pType     = projectType || 'Residential New Construction';
      let   mid       = clientMid || null;

      // ── Step 1: Auto-generate midpoint via FLUX if contractor didn't upload one ──
      if (!mid) {
        console.log(`[BuildCast] Auto-generating midpoint for 30s — type=${pType}`);
        const midPrompt  = `${MID_PROMPTS[pType] || MID_PROMPTS['Residential New Construction']}, high resolution, sharp focus, no text, no watermarks`;
        const imageSize  = FLUX_SIZES[aspectRatio] || 'portrait_16_9';

        const fluxSubmit = await falPost(FLUX_MODEL, {
          prompt:                midPrompt,
          image_size:            imageSize,
          num_inference_steps:   4,
          num_images:            1,
          enable_safety_checker: false,
        });

        if (fluxSubmit.detail || fluxSubmit.error) {
          return json(res, 500, { error: `Midpoint generation failed: ${fluxSubmit.detail || fluxSubmit.error}` });
        }

        const mStatusPath   = new URL(fluxSubmit.status_url).pathname;
        const mResponsePath = new URL(fluxSubmit.response_url).pathname;

        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const sd = await falGet(mStatusPath);
          if ((sd.status || '').toUpperCase() === 'COMPLETED') {
            const rd = await falGet(mResponsePath);
            mid = rd?.images?.[0]?.url || rd?.image?.url || null;
            if (!mid) return json(res, 500, { error: 'Midpoint image ready but URL not found' });
            console.log(`[BuildCast] Midpoint ready → ${mid.slice(0, 80)}`);
            break;
          }
          if ((sd.status || '').toUpperCase() === 'FAILED') {
            return json(res, 500, { error: 'Midpoint auto-generation failed' });
          }
        }
        if (!mid) return json(res, 500, { error: 'Midpoint generation timed out' });
      } else {
        console.log(`[BuildCast] Using contractor-uploaded midpoint`);
      }

      // ── Step 2: Fire both 15s clips simultaneously ──
      console.log(`[BuildCast] Submitting 30s — 2 × 15s Kling clips in parallel`);
      const [result1, result2] = await Promise.all([
        falPost(KLING_MODEL, {
          prompt,
          start_image_url: before,
          end_image_url:   mid,
          duration:        '15',
          aspect_ratio:    aspectRatio || '9:16',
          generate_audio:  true,
        }),
        falPost(KLING_MODEL, {
          prompt,
          start_image_url: mid,
          end_image_url:   after,
          duration:        '15',
          aspect_ratio:    aspectRatio || '9:16',
          generate_audio:  true,
        }),
      ]);

      if (result1.detail || result1.error) return json(res, 500, { error: formatFalError(result1.detail || result1.error) });
      if (result2.detail || result2.error) return json(res, 500, { error: formatFalError(result2.detail || result2.error) });

      console.log(`[BuildCast] 30s clips → ${result1.request_id} / ${result2.request_id}`);
      json(res, 200, {
        clip1: { requestId: result1.request_id, statusUrl: result1.status_url, responseUrl: result1.response_url },
        clip2: { requestId: result2.request_id, statusUrl: result2.status_url, responseUrl: result2.response_url },
      });

    } catch(e) {
      console.error('Generate-30s error:', e.message);
      json(res, 500, { error: formatFalError(e) });
    }
    return;
  }

  /* ── POST /api/auth/signup ── */
  if (req.method === 'POST' && req.url === '/api/auth/signup') {
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return json(res, 400, { error: 'Email and password required' });
      if (password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
      const existing = await dbGetUserByEmail(email);
      if (existing) return json(res, 409, { error: 'An account with this email already exists' });
      const user = {
        id: crypto.randomUUID(), email: email.toLowerCase().trim(),
        password: hashPw(password), createdAt: new Date().toISOString(),
      };
      await dbCreateUser(user);
      await dbIncrementStat('signups');
      json(res, 200, { token: makeToken(user.id, user.email), email: user.email });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── POST /api/auth/login ── */
  if (req.method === 'POST' && req.url === '/api/auth/login') {
    try {
      const { email, password } = await readBody(req);
      const user = await dbGetUserByEmail(email || '');
      if (!user || user.password !== hashPw(password)) return json(res, 401, { error: 'Invalid email or password' });
      json(res, 200, { token: makeToken(user.id, user.email), email: user.email });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── GET /api/auth/me ── */
  if (req.method === 'GET' && req.url === '/api/auth/me') {
    const d = parseToken(getBearerToken(req));
    if (!d) return json(res, 401, { error: 'Not authenticated' });
    json(res, 200, { email: d.email, userId: d.sub });
    return;
  }

  /* ── POST /api/auth/track-video ── */
  if (req.method === 'POST' && req.url === '/api/auth/track-video') {
    try {
      const d = parseToken(getBearerToken(req));
      if (d) await dbIncrementUserVideos(d.sub);
      await dbIncrementStat('videos');
      json(res, 200, { ok: true });
    } catch(e) { json(res, 200, { ok: true }); } // non-critical, don't fail silently
    return;
  }

  /* ── GET /api/profile ── */
  if (req.method === 'GET' && req.url === '/api/profile') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const user = await dbGetUserByEmail(d.email);
      if (!user) return json(res, 404, { error: 'User not found' });
      json(res, 200, { logo: user.wmLogo||null, website: user.wmWebsite||'', phone: user.wmPhone||'', username: user.username||null, businessName: user.businessName||null, tagline: user.tagline||null, avatar: user.avatar||null });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── PUT /api/profile ── */
  if (req.method === 'PUT' && req.url === '/api/profile') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const { logo, website, phone, username, businessName, tagline, avatar } = await readBody(req);
      await dbUpdateUserProfile(d.sub, { wmLogo: logo||null, wmWebsite: website||null, wmPhone: phone||null, username: username||null, businessName: businessName||null, tagline: tagline||null, avatar: avatar||null });
      json(res, 200, { ok: true, logo: logo||null, website: website||'', phone: phone||'', username: username||null, businessName: businessName||null, tagline: tagline||null, avatar: avatar||null });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── GET /admin ── */
  if (req.method === 'GET' && (req.url === '/admin' || req.url === '/admin/')) {
    fs.readFile(ADMIN_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Admin dashboard not found — deploy admin.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  /* ── GET /api/admin/stats ── */
  if (req.method === 'GET' && req.url.startsWith('/api/admin/stats')) {
    try {
      const pw = new URL(req.url, 'http://localhost').searchParams.get('pw');
      if (pw !== ADMIN_PASSWORD) return json(res, 401, { error: 'Unauthorized' });
      const [stats, recentUsers] = await Promise.all([dbGetStats(), dbGetAllUsers(50)]);
      const sql = getSql();
      let totalUsers = recentUsers.length;
      if (sql) { const r = await sql`SELECT COUNT(*) as count FROM bc_users`; totalUsers = parseInt(r[0].count); }
      json(res, 200, { ...stats, totalUsers, recentUsers });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── POST /api/messages/send ── */
  if (req.method === 'POST' && req.url === '/api/messages/send') {
    try {
      const { name, email, message } = await readBody(req);
      if (!name || !email || !message) return json(res, 400, { error: 'Name, email and message required' });
      const id = crypto.randomUUID();
      const sql = getSql();
      if (sql) {
        await sql`INSERT INTO bc_messages (id, name, email, message) VALUES (${id}, ${name}, ${email}, ${message})`;
      }
      console.log(`[MSG] New message from ${email}`);
      json(res, 200, { ok: true });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── GET /api/admin/messages ── */
  if (req.method === 'GET' && req.url.startsWith('/api/admin/messages')) {
    try {
      const pw = new URL(req.url, 'http://localhost').searchParams.get('pw');
      if (pw !== ADMIN_PASSWORD) return json(res, 401, { error: 'Unauthorized' });
      const sql = getSql();
      if (!sql) return json(res, 200, { messages: [] });
      const messages = await sql`SELECT * FROM bc_messages ORDER BY created_at DESC LIMIT 100`;
      // Mark all as read
      await sql`UPDATE bc_messages SET read = true WHERE read = false`;
      json(res, 200, { messages });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── POST /api/admin/reply ── */
  if (req.method === 'POST' && req.url === '/api/admin/reply') {
    try {
      const { pw, id, reply } = await readBody(req);
      if (pw !== ADMIN_PASSWORD) return json(res, 401, { error: 'Unauthorized' });
      const sql = getSql();
      if (sql) await sql`UPDATE bc_messages SET reply = ${reply}, replied_at = NOW() WHERE id = ${id}`;
      json(res, 200, { ok: true });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ══════════════════════════════════════════════════════════
     JOB BOARD endpoints
  ══════════════════════════════════════════════════════════ */

  /* ── GET /api/jobs ── */
  if (req.method === 'GET' && req.url === '/api/jobs') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const sql = getSql();
      if (!sql) return json(res, 200, { jobs: [] });
      const jobs = await sql`SELECT * FROM bc_jobs WHERE user_id = ${d.sub} ORDER BY created_at DESC`;
      json(res, 200, { jobs });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── POST /api/jobs ── */
  if (req.method === 'POST' && req.url === '/api/jobs') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const { jobName, clientName, jobType, startDate, endDate } = await readBody(req);
      if (!jobName) return json(res, 400, { error: 'Job name required' });
      const sql = getSql();
      if (!sql) return json(res, 503, { error: 'Database not available' });
      const rows = await sql`
        INSERT INTO bc_jobs (user_id, job_name, client_name, job_type, start_date, end_date)
        VALUES (${d.sub}, ${jobName}, ${clientName||null}, ${jobType||null}, ${startDate||null}, ${endDate||null})
        RETURNING *`;
      json(res, 201, { job: rows[0] });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── PUT /api/jobs/:id ── */
  if (req.method === 'PUT' && req.url.startsWith('/api/jobs/')) {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const jobId = parseInt(req.url.split('/api/jobs/')[1]);
      if (!jobId) return json(res, 400, { error: 'Invalid job id' });
      const { jobName, clientName, jobType, startDate, endDate, milestone } = await readBody(req);
      const sql = getSql();
      if (!sql) return json(res, 503, { error: 'Database not available' });
      const rows = await sql`
        UPDATE bc_jobs SET
          job_name    = COALESCE(${jobName||null},    job_name),
          client_name = COALESCE(${clientName||null}, client_name),
          job_type    = COALESCE(${jobType||null},    job_type),
          start_date  = COALESCE(${startDate||null},  start_date),
          end_date    = COALESCE(${endDate||null},     end_date),
          milestone   = COALESCE(${milestone!=null?milestone:null}, milestone)
        WHERE id = ${jobId} AND user_id = ${d.sub}
        RETURNING *`;
      if (!rows[0]) return json(res, 404, { error: 'Job not found' });
      json(res, 200, { job: rows[0] });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── DELETE /api/jobs/:id ── */
  if (req.method === 'DELETE' && req.url.startsWith('/api/jobs/')) {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const jobId = parseInt(req.url.split('/api/jobs/')[1]);
      if (!jobId) return json(res, 400, { error: 'Invalid job id' });
      const sql = getSql();
      if (!sql) return json(res, 503, { error: 'Database not available' });
      await sql`DELETE FROM bc_jobs WHERE id = ${jobId} AND user_id = ${d.sub}`;
      json(res, 200, { ok: true });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ══════════════════════════════════════════════════════════
     PORTFOLIO / VIDEOS endpoints
  ══════════════════════════════════════════════════════════ */

  /* ── GET /api/portfolio/:username (PUBLIC) ── */
  if (req.method === 'GET' && req.url.startsWith('/api/portfolio/')) {
    try {
      const username = req.url.split('/api/portfolio/')[1]?.split('?')[0];
      if (!username) return json(res, 400, { error: 'Username required' });
      const sql = getSql();
      if (!sql) return json(res, 503, { error: 'Database not available' });
      const users = await sql`SELECT * FROM bc_users WHERE username = ${username.toLowerCase()}`;
      if (!users[0]) return json(res, 404, { error: 'Portfolio not found' });
      const u = users[0];
      const videos = await sql`
        SELECT id, video_url, project_type, job_name, thumbnail_url, created_at
        FROM bc_videos
        WHERE user_id = ${u.id} AND is_public = true
        ORDER BY created_at DESC`;
      json(res, 200, {
        username: u.username,
        businessName: u.business_name || null,
        tagline: u.tagline || null,
        logo: u.wm_logo || null,
        phone: u.wm_phone || null,
        website: u.wm_website || null,
        videos,
      });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── GET /api/videos ── */
  if (req.method === 'GET' && req.url === '/api/videos') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const sql = getSql();
      if (!sql) return json(res, 200, { videos: [] });
      const videos = await sql`SELECT * FROM bc_videos WHERE user_id = ${d.sub} ORDER BY created_at DESC`;
      json(res, 200, { videos });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── POST /api/videos ── */
  if (req.method === 'POST' && req.url === '/api/videos') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const { videoUrl, projectType, jobName, jobId, thumbnailUrl } = await readBody(req);
      if (!videoUrl) return json(res, 400, { error: 'videoUrl required' });
      const sql = getSql();
      if (!sql) return json(res, 200, { ok: true, id: null }); // gracefully skip without DB
      const rows = await sql`
        INSERT INTO bc_videos (user_id, job_id, video_url, project_type, job_name, thumbnail_url)
        VALUES (${d.sub}, ${jobId||null}, ${videoUrl}, ${projectType||null}, ${jobName||null}, ${thumbnailUrl||null})
        RETURNING id`;
      json(res, 201, { ok: true, id: rows[0].id });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── PUT /api/videos/:id ── */
  if (req.method === 'PUT' && req.url.startsWith('/api/videos/')) {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const videoId = parseInt(req.url.split('/api/videos/')[1]);
      if (!videoId) return json(res, 400, { error: 'Invalid video id' });
      const { isPublic, jobId } = await readBody(req);
      const sql = getSql();
      if (!sql) return json(res, 503, { error: 'Database not available' });
      const rows = await sql`
        UPDATE bc_videos SET
          is_public = COALESCE(${isPublic!=null?isPublic:null}, is_public),
          job_id    = CASE WHEN ${jobId!==undefined} THEN ${jobId||null} ELSE job_id END
        WHERE id = ${videoId} AND user_id = ${d.sub}
        RETURNING *`;
      if (!rows[0]) return json(res, 404, { error: 'Video not found' });
      json(res, 200, { video: rows[0] });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── DELETE /api/videos/:id ── */
  if (req.method === 'DELETE' && req.url.startsWith('/api/videos/')) {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const videoId = parseInt(req.url.split('/api/videos/')[1]);
      if (!videoId) return json(res, 400, { error: 'Invalid video id' });
      const sql = getSql();
      if (!sql) return json(res, 503, { error: 'Database not available' });
      await sql`DELETE FROM bc_videos WHERE id = ${videoId} AND user_id = ${d.sub}`;
      json(res, 200, { ok: true });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ══════════════════════════════════════════════════════════
     BID MODE endpoints
  ══════════════════════════════════════════════════════════ */

  /* ── GET /api/bids ── */
  if (req.method === 'GET' && req.url === '/api/bids') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const sql = getSql();
      if (!sql) return json(res, 200, { bids: [] });
      const bids = await sql`SELECT * FROM bc_bids WHERE user_id = ${d.sub} ORDER BY created_at DESC LIMIT 50`;
      json(res, 200, { bids });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ── POST /api/bids ── */
  if (req.method === 'POST' && req.url === '/api/bids') {
    try {
      const d = parseToken(getBearerToken(req));
      if (!d) return json(res, 401, { error: 'Not authenticated' });
      const { beforeUrl, renderUrl, projectType, jobId } = await readBody(req);
      const sql = getSql();
      if (!sql) return json(res, 200, { ok: true, id: null });
      const rows = await sql`
        INSERT INTO bc_bids (user_id, job_id, before_url, render_url, project_type)
        VALUES (${d.sub}, ${jobId||null}, ${beforeUrl||null}, ${renderUrl||null}, ${projectType||null})
        RETURNING id`;
      json(res, 201, { ok: true, id: rows[0].id });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`BuildCast v2 — AI Timelapse — live on port ${PORT}`);
  initDB().catch(e => console.error('[DB] startup init failed:', e.message));
});
