const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT         = process.env.PORT || 3000;
const FAL_KEY      = process.env.FAL_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const FILE         = path.join(__dirname, 'buildcast.html');

// Kling v1.6 Pro — supports first+last frame (tail_image_url)
const KLING_MODEL = 'fal-ai/kling-video/v1.6/pro/image-to-video';

const STRIPE_PRICES = {
  starter: 'price_1TNxQNCeomIgjT0aBnT8Fsf7',  // $10/mo
  pro:     'price_1TNxUQCeomIgjT0ahzyJb23n',   // $30/mo
  studio:  'price_1TNxVmCeomIgjT0atBzsbDTn'    // $50/mo
};

/* ── Prompt builder ───────────────────────────────────────── */
const PROMPTS = {
  'Residential Build':     'construction timelapse of a residential home being built, foundation to finished house, smooth realistic transformation, natural lighting progression, photorealistic',
  'Commercial Build':      'commercial construction timelapse, steel structure and concrete building rising from empty lot to completed building, professional progress, realistic',
  'Renovation':            'home renovation transformation timelapse, worn old space transforming into modern finished room, smooth realistic construction progress',
  'Road / Infrastructure': 'road construction timelapse, raw ground and gravel transforming into finished paved road with lane markings, infrastructure progress, realistic',
  'Interior Remodel':      'interior remodeling timelapse, stripped walls and subfloor transforming into fully finished modern living space, smooth realistic transition',
  'Landscaping':           'landscaping transformation timelapse, bare dirt yard transforming into lush finished outdoor space with plantings and hardscape, realistic',
};

function buildPrompt(projectType) {
  return PROMPTS[projectType] || PROMPTS['Residential Build'];
}

/* ── fal.ai helpers ───────────────────────────────────────── */
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
        try   { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error('Bad JSON from fal.ai: ' + out.slice(0, 300))); }
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
        try   { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error('Bad JSON from fal.ai')); }
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
      if (total > 10 * 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); return; }
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
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
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

      const { before, after, projectType, aspectRatio } = await readBody(req);
      if (!before || !after) return json(res, 400, { error: 'Missing before or after image' });

      const prompt = buildPrompt(projectType || 'Residential Build');

      // Kling first+last frame: before = first frame, after = last frame
      // AI fills in the realistic construction transformation between them
      const result = await falPost(KLING_MODEL, {
        prompt,
        image_url:       before,
        tail_image_url:  after,
        duration:        '10',
        aspect_ratio:    aspectRatio || '9:16',
        negative_prompt: 'cartoon, anime, illustration, drawing, CGI, artifacts, glitch, unrealistic, blurry',
        cfg_scale:       0.5
      });

      if (result.detail || result.error) {
        console.error('fal.ai submit error:', result.detail || result.error);
        return json(res, 500, { error: result.detail || result.error });
      }

      console.log(`[BuildCast] Job started → ${result.request_id}`);
      json(res, 200, { requestId: result.request_id });

    } catch(e) {
      console.error('Generate error:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── Poll generation status ── */
  if (req.method === 'GET' && req.url.startsWith('/api/status')) {
    try {
      if (!FAL_KEY) return json(res, 500, { error: 'FAL_KEY not configured' });

      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      if (!id) return json(res, 400, { error: 'Missing id param' });

      const statusData = await falGet(`/${KLING_MODEL}/requests/${id}/status`);

      if (statusData.status === 'COMPLETED') {
        const resultData = await falGet(`/${KLING_MODEL}/requests/${id}`);

        // fal.ai Kling result shape: { video: { url: "..." } }
        const videoUrl =
          resultData?.video?.url                  ||
          resultData?.output?.video?.url          ||
          resultData?.outputs?.[0]?.video?.url    ||
          null;

        if (!videoUrl) {
          console.error('[BuildCast] Unexpected result shape:', JSON.stringify(resultData).slice(0, 400));
          return json(res, 500, { error: 'Unexpected response from AI. Please try again.' });
        }

        console.log(`[BuildCast] Job complete → ${videoUrl}`);
        json(res, 200, { status: 'completed', videoUrl });

      } else if (statusData.status === 'FAILED') {
        json(res, 200, { status: 'failed', error: statusData.error || 'AI generation failed' });
      } else {
        // IN_QUEUE or IN_PROGRESS
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

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`BuildCast v2 — AI Timelapse — live on port ${PORT}`));
