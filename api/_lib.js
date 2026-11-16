const BASE = 'https://cloaking.house/api/flows';

function guard(req, res) {
  if (!process.env.APP_PASSWORD || !process.env.CLOAKING_API_KEY) {
    res.status(500).json({ error: 'APP_PASSWORD ya CLOAKING_API_KEY Vercel mein set nahi hai' });
    return false;
  }
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD) {
    res.status(401).json({ error: 'Wrong password' });
    return false;
  }
  return true;
}

async function ch(path, params) {
  const key = process.env.CLOAKING_API_KEY;
  const method = (process.env.CH_METHOD || 'POST').toUpperCase();
  const body = { api_key: key, ...params };
  let url = BASE + path;
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (method === 'GET') url += '?' + new URLSearchParams(body);
  else opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) {
    const msg = JSON.stringify(j).split(key).join('***').slice(0, 300);
    throw new Error('Cloaking.house ' + r.status + ': ' + msg);
  }
  return j;
}

function pick(j) {
  return (j && (j.data || j.result || j.flows || j.items)) || j;
}

module.exports = { guard, ch, pick };
