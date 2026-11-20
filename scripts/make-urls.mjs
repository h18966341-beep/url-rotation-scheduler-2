// Makes N new Laravel Forge sites (random *.on-forge.com address), deploys the stream's page
// repo to each, checks the page really opens, then adds the working URLs to the rotator queue.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { FORGE_TOKEN, FORGE_ORG, FORGE_SERVER, FLOW_ID, COUNT, REPO_OVERRIDE, BRANCH_OVERRIDE, ROTATOR_URL, ROTATOR_KEY } = process.env;
for (const [k, v] of Object.entries({ FORGE_TOKEN, FORGE_ORG, FORGE_SERVER, FLOW_ID, COUNT, ROTATOR_URL, ROTATOR_KEY })) {
  if (!v) { console.error('Missing setting: ' + k); process.exit(1); }
}
const n = Number(COUNT);
if (!(n >= 1 && n <= 50)) { console.error('Count must be between 1 and 50'); process.exit(1); }

const map = JSON.parse(readFileSync('streams.json', 'utf8'));
const cfg = map[FLOW_ID] || {};
const repo = REPO_OVERRIDE || cfg.repo;
const branch = BRANCH_OVERRIDE || cfg.branch || 'main';
if (!repo) { console.error(`No page repo for stream ${FLOW_ID}. Add it to streams.json.`); process.exit(1); }
console.log(`Stream ${FLOW_ID}: page repo ${repo} (${branch}), making ${n} URL(s)`);

const API = 'https://forge.laravel.com/api';
const base = `${API}/orgs/${FORGE_ORG}/servers/${FORGE_SERVER}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function forge(method, path, body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: 'Bearer ' + FORGE_TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' },
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

const rand = () => 'p' + randomBytes(16).toString('hex').slice(0, 30); // random letters+digits, starts with a letter

async function waitSite(id, ok, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const s = (await forge('GET', `/sites/${id}`)).data.attributes;
    if (s.status === 'failed') throw new Error(`site ${id} failed while ${what}`);
    if (ok(s)) return s;
    await sleep(5000);
  }
  throw new Error(`site ${id}: timed out while ${what}`);
}

async function pageOpens(url) {
  for (let i = 0; i < 24; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (r.status === 200) return true;
    } catch {}
    await sleep(5000);
  }
  return false;
}

async function makeOne(i) {
  const name = rand();
  console.log(`\n== ${i}/${n}: creating ${name} ==`);
  const created = await forge('POST', '/sites', {
    type: 'static-html', name, domain_mode: 'on-forge',
    source_control_provider: 'custom', repository: repo, branch,
    generate_deploy_key: false, push_to_deploy: false, www_redirect_type: 'none',
  });
  const id = created.data.id;
  let url = created.data.attributes && created.data.attributes.url;
  console.log('site id', id, 'url', url);
  const s = await waitSite(id, x => ['never-deployed', 'installed', 'deployed'].includes(x.status) && x.repository.status !== 'installing', 'installing');
  url = s.url || url;
  await forge('POST', `/sites/${id}/deployments`);
  console.log('deploy started');
  await waitSite(id, x => x.status === 'deployed' || (x.status === 'installed' && x.deployment_status === 'finished'), 'deploying', 60);
  url = (/^https?:/.test(url) ? url : 'https://' + url).replace(/\/+$/, '') + '/';
  url = url.replace(/^http:/, 'https:');
  if (!(await pageOpens(url))) throw new Error(`deployed but ${url} does not open (200) yet`);
  console.log('OK', url);
  return url;
}

const good = [];
let failed = 0;
for (let i = 1; i <= n; i++) {
  try { good.push(await makeOne(i)); } catch (e) { failed++; console.error('FAILED:', e.message); }
}

if (good.length) {
  const r = await fetch(ROTATOR_URL.replace(/\/$/, '') + '/api/add-urls', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ROTATOR_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow_id: Number(FLOW_ID), urls: good }),
  });
  console.log('\nRotator answer:', r.status, await r.text());
  if (!r.ok) process.exit(1);
}
console.log(`\nDone: ${good.length} URL(s) added, ${failed} failed`);
if (failed) process.exit(1);
