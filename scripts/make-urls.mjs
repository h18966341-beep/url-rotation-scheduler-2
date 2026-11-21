// Forge URL robot.  node scripts/make-urls.mjs <make|refill|delete>
//  make   : make COUNT new URLs for FLOW_ID and add them to the rotator queue
//  refill : for every stream in streams.json, if few URLs are left in its queue, make more
//  delete : remove URLs from a stream's queue and delete their Forge sites
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const E = process.env;
const MODE = process.argv[2];
for (const k of ['FORGE_TOKEN', 'FORGE_ORG', 'FORGE_SERVER', 'ROTATOR_URL', 'ROTATOR_KEY']) {
  if (!E[k]) { console.error('Missing setting: ' + k); process.exit(1); }
}
const API = 'https://forge.laravel.com/api';
const base = `${API}/orgs/${E.FORGE_ORG}/servers/${E.FORGE_SERVER}`;
const ROT = E.ROTATOR_URL.replace(/\/$/, '');
const MAX_SITES = Number(E.MAX_SITES || 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const streams = JSON.parse(readFileSync('streams.json', 'utf8'));

async function forge(method, path, body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(path.startsWith('http') ? path : base + path, {
      method,
      headers: { Authorization: 'Bearer ' + E.FORGE_TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`Forge ${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 600)}`);
    return j;
  }
  throw new Error(`Forge ${method} ${path} kept failing`);
}

async function rot(method, path, body) {
  const r = await fetch(ROT + path, {
    method, headers: { Authorization: 'Bearer ' + E.ROTATOR_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(`Rotator ${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const host = u => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.toLowerCase(); } catch { return ''; } };

async function listSites() {
  const all = [];
  let next = '/sites';
  for (let p = 0; next && p < 50; p++) {
    const j = await forge('GET', next);
    for (const s of j.data || []) all.push({ id: s.id, host: host(s.attributes.url || s.attributes.name) });
    next = j.links && j.links.next ? j.links.next : null;
  }
  return all;
}

const rand = () => 'p' + randomBytes(16).toString('hex').slice(0, 30);

async function waitSite(id, ok, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const s = (await forge('GET', `${API}/orgs/${E.FORGE_ORG}/sites/${id}`)).data.attributes;
    if (s.status === 'failed') throw new Error(`site ${id} failed while ${what}`);
    if (ok(s)) return s;
    await sleep(5000);
  }
  throw new Error(`site ${id}: timed out while ${what}`);
}

async function pageOpens(url) {
  for (let i = 0; i < 24; i++) {
    try { const r = await fetch(url, { redirect: 'follow' }); if (r.status === 200) return true; } catch {}
    await sleep(5000);
  }
  return false;
}

async function makeOne(repo, branch, label) {
  const name = rand();
  console.log(`[${label}] creating ${name}`);
  const created = await forge('POST', '/sites', {
    type: 'static-html', name, domain_mode: 'on-forge',
    source_control_provider: 'custom', repository: repo, branch,
    generate_deploy_key: false, push_to_deploy: false, www_redirect_type: 'none',
  });
  const id = created.data.id;
  try {
    let url = created.data.attributes && created.data.attributes.url;
    const s = await waitSite(id, x => ['never-deployed', 'installed', 'deployed'].includes(x.status) && (!x.repository || x.repository.status !== 'installing'), 'installing');
    url = s.url || url;
    await forge('POST', `/sites/${id}/deployments`);
    await waitSite(id, x => x.status === 'deployed' || (x.status === 'installed' && x.deployment_status === 'finished'), 'deploying');
    url = (/^https?:/.test(url) ? url : 'https://' + url).replace(/\/+$/, '').replace(/^http:/, 'https:') + '/';
    if (!(await pageOpens(url))) throw new Error(`${url} does not open (200)`);
    console.log(`[${label}] OK ${url}`);
    return url;
  } catch (e) {
    console.error(`[${label}] failed, deleting the half-made site ${id}: ${e.message}`);
    await forge('DELETE', `/sites/${id}`).catch(() => {});
    throw e;
  }
}

// makes `count` URLs (5 at a time) and puts each into the queue the moment it is ready
async function makeMany(flowId, count) {
  const cfg = streams[flowId] || {};
  const repo = E.REPO_OVERRIDE || cfg.repo, branch = E.BRANCH_OVERRIDE || cfg.branch || 'main';
  if (!repo) throw new Error(`No page repo for stream ${flowId}. Add it to streams.json.`);
  const sites = await listSites();
  const have = sites.filter(s => s.host.endsWith('.on-forge.com')).length;
  if (have + count > MAX_SITES) throw new Error(`Safety limit: ${have} sites exist, limit is ${MAX_SITES}. Delete old ones first.`);
  console.log(`Stream ${flowId}: making ${count} URL(s) from ${repo} (${branch}); ${have} on-forge sites exist now`);
  let made = 0, failed = 0, nextI = 0;
  async function worker() {
    while (nextI < count && failed < 3) {
      const i = ++nextI;
      try {
        const url = await makeOne(repo, branch, `${flowId} #${i}`);
        const r = await rot('POST', '/api/add-urls', { flow_id: Number(flowId), urls: [url] });
        console.log(`[${flowId} #${i}] queued`, JSON.stringify(r));
        made++;
      } catch (e) { failed++; console.error(`[${flowId} #${i}] FAILED: ${e.message}`); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  console.log(`Stream ${flowId}: ${made} URL(s) added, ${failed} failed`);
  return failed === 0;
}

async function main() {
  if (MODE === 'make') {
    const n = Number(E.COUNT);
    if (!E.FLOW_ID || !(n >= 1 && n <= 50)) throw new Error('Need FLOW_ID and COUNT between 1 and 50');
    return makeMany(E.FLOW_ID, n);
  }
  if (MODE === 'refill') {
    const { schedules } = await rot('GET', '/api/queue');
    let allOk = true;
    for (const [flowId, cfg] of Object.entries(streams)) {
      if (cfg.auto === false) { console.log(`Stream ${flowId}: auto-refill is off`); continue; }
      const s = schedules.find(x => String(x.flow_id) === flowId);
      if (!s) { console.log(`Stream ${flowId}: no schedule yet, skipping`); continue; }
      if (!s.enabled) { console.log(`Stream ${flowId}: rotation is stopped, skipping`); continue; }
      if (s.end_mode === 'rev') { console.log(`Stream ${flowId}: Reverse mode is not supported by auto-refill, skipping`); continue; }
      const n = s.urls.length, idx = Number(s.idx);
      const ahead = idx < 0 ? n : n - 1 - idx;
      const interval = Number(s.interval_min) || 5;
      const timeLeft = ahead * interval;                       // minutes until the queue runs out
      const leadMin = Number(cfg.lead_min ?? 60);              // refill when this many minutes (or fewer) are left
      const minLeft = Number(cfg.min_left ?? 5);               // ...or when this many URLs (or fewer) are left
      const targetMin = Number(cfg.target_min ?? 180);         // after refill the queue should last at least this long
      const batch = Math.min(60, Math.max(Number(cfg.batch ?? 20), Math.ceil(targetMin / interval) - ahead));
      console.log(`Stream ${flowId}: ${ahead} URL(s) left = about ${timeLeft} min (refill at ${leadMin} min or ${minLeft} URLs)`);
      if (ahead > minLeft && timeLeft > leadMin) continue;
      console.log(`Stream ${flowId}: queue is getting low, making ${batch} URL(s)`);
      allOk = (await makeMany(flowId, batch)) && allOk;
    }
    return allOk;
  }
  if (MODE === 'delete') {
    const flowId = E.FLOW_ID, mode = E.DELETE_MODE;
    if (!flowId) throw new Error('Need FLOW_ID');
    const urls = (E.URLS || '').split(/\s+/).filter(Boolean);
    const r = await rot('POST', '/api/queue', { action: 'remove', flow_id: Number(flowId), mode, urls });
    console.log(`Removed ${r.removed.length} URL(s) from the queue, ${r.kept} left`);
    const hosts = new Set(r.removed.map(host).filter(h => h.endsWith('.on-forge.com')));
    if (!hosts.size) { console.log('Nothing to delete on Forge'); return true; }
    const delay = Number(E.DELAY_MIN ?? 30);
    if (delay > 0) {
      console.log(`Removed from the queue. Waiting ${delay} minute(s) so visitors who already opened these pages are not cut off...`);
      await sleep(delay * 60000);
      // safety: never delete a site that is back in some queue
      const { schedules } = await rot('GET', '/api/queue');
      const queued = new Set(schedules.flatMap(x => x.urls).map(host));
      for (const h of [...hosts]) if (queued.has(h)) { hosts.delete(h); console.log('Skipping (back in a queue):', h); }
    }
    const sites = await listSites();
    let del = 0, miss = 0;
    for (const h of hosts) {
      const site = sites.find(s => s.host === h);
      if (!site) { miss++; console.log('No Forge site found for', h); continue; }
      await forge('DELETE', `/sites/${site.id}`);
      del++; console.log('Deleted site', h);
    }
    console.log(`Deleted ${del} Forge site(s), ${miss} not found`);
    return true;
  }
  throw new Error('Mode must be make, refill or delete');
}

main().then(ok => process.exit(ok === false ? 1 : 0)).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
