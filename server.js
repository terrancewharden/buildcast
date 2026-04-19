const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT          = process.env.PORT || 3000;
const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
const FILE          = path.join(__dirname, 'buildcast.html');

/* ── Replicate helpers ───────────────────────────────────────── */
function replicatePost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.replicate.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'Authorization':  `Token ${REPLICATE_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch(e) { reject(new Error('Bad JSON from Replicate: ' + out.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function replicateGet(endpoint) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.replicate.com',
      path: endpoint,
      headers: { 'Authorization': `Token ${REPLICATE_KEY}` }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch(e) { reject(new Error('Bad JSON from Replicate')); }
      });
    }).on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch(e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/* ── Server ──────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── Serve main app ── */
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    fs.readFile(FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Server error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  /* ── Start AI timelapse prediction for one photo ── */
  if (req.method === 'POST' && req.url === '/api/timelapse/start') {
    try {
      if (!REPLICATE_KEY) return json(res, 500, { error: 'REPLICATE_API_KEY not configured on server' });
      const { image } = await readBody(req);
      if (!image) return json(res, 400, { error: 'Missing image field' });

      // Stable Video Diffusion XT — reliable, ~$0.003/clip
      const prediction = await replicatePost(
        '/v1/models/stability-ai/stable-video-diffusion/predictions',
        {
          input: {
            input_image:      image,
            video_length:     '25_frames_with_svd_xt',
            fps_id:           8,
            motion_bucket_id: 80,
            cond_aug:         0.02,
            decoding_t:       14
          }
        }
      );

      if (prediction.detail || prediction.error) {
        return json(res, 500, { error: prediction.detail || prediction.error });
      }
      json(res, 200, { id: prediction.id, status: prediction.status });
    } catch(e) {
      console.error('Start error:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── Poll prediction status ── */
  if (req.method === 'GET' && req.url.startsWith('/api/timelapse/status')) {
    try {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      if (!id) return json(res, 400, { error: 'Missing id param' });

      const pred = await replicateGet(`/v1/predictions/${id}`);
      const url  = pred.status === 'succeeded'
        ? (Array.isArray(pred.output) ? pred.output[0] : pred.output)
        : null;

      json(res, 200, { status: pred.status, url, error: pred.error || null });
    } catch(e) {
      console.error('Status error:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`BuildCast live on port ${PORT}`));
