const { guard, ch, pick } = require('./_lib');

// Cloaking.house "details" aur "update" mein kuch fields ke naam alag hain
const RENAME = {
  filter_countries: 'country_ids',
  filter_devices: 'device_ids',
  filter_os: 'os_ids',
  filter_browsers: 'browser_ids',
  filter_langs: 'language_ids',
  filter_time_zones: 'time_zone_ids',
  filter_connections: 'connection_ids',
};
const LISTS = Object.keys(RENAME).concat(['filter_tags', 'allowed_ips']);
const FIELDS = ['name','status','url_white_page','url_offer_page','mode_white_page','mode_offer_page',
  'filter_countries','filter_devices','filter_os','filter_browsers','filter_langs',
  'filter_time_zones','filter_connections','filter_tags','filter_cloaking_flag',
  'filter_vpn_proxy_flag','filter_ip_v6_flag','filter_referer_flag','filter_isp_flag',
  'filter_black_ip_flag','filter_tag_flag','filter_ip_clicks_per_day',
  'filter_clicks_before_filtering','mode_list_country','mode_list_device','mode_list_os',
  'mode_list_browser','mode_list_lang','mode_list_time_zone','mode_list_connection',
  'filter_id','allowed_ips'];
const OPTIONAL = ['filter_langs','filter_time_zones','filter_connections','filter_tags','filter_id','allowed_ips'];

function normalize(o) {
  const s = { ...o };
  Object.entries(RENAME).forEach(([k, v]) => { if (s[k] === undefined && s[v] !== undefined) s[k] = s[v]; });
  LISTS.forEach(k => { if (s[k] === null) s[k] = []; });
  if (s.filter_tag_flag === undefined) s.filter_tag_flag = Number(process.env.FILTER_TAG_FLAG || 0);
  return s;
}
const short = o => JSON.stringify(o).slice(0, 300);

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  const { flow_id, url } = req.body || {};
  if (!flow_id || !/^https?:\/\/\S+$/i.test(url || '')) {
    return res.status(400).json({ error: 'flow_id aur sahi URL chahiye' });
  }
  const id = Number(flow_id);
  const snap = o => {
    const s = {};
    FIELDS.forEach(k => { if (o[k] !== undefined && k !== 'url_offer_page') s[k] = o[k]; });
    return s;
  };
  try {
    const raw = pick(await ch('/details', { flow_id: id }));
    if (raw.flow_id !== undefined && Number(raw.flow_id) !== id) {
      return res.status(502).json({ error: 'Stream number match nahi hua: bheja #' + id + ', mila #' + raw.flow_id });
    }
    const before = normalize(raw);
    const missing = FIELDS.filter(k => before[k] === undefined && !OPTIONAL.includes(k));
    if (missing.length) {
      return res.status(502).json({ error: 'Details response mein ye fields nahi mile: ' + missing.join(', ') + '. Mile hue keys: ' + Object.keys(raw).join(', ') });
    }
    const payload = { flow_id: id };
    FIELDS.forEach(k => { if (before[k] !== undefined) payload[k] = before[k]; });
    payload.url_offer_page = url;

    const upd = await ch('/update', payload);
    if (upd && (upd.success === false || upd.status === 'error' || upd.error || upd.errors)) {
      return res.status(502).json({ error: 'Cloaking.house ne update reject kiya: ' + short(upd) });
    }

    const after = normalize(pick(await ch('/details', { flow_id: id })));
    if (String(after.url_offer_page || '').trim() !== url.trim()) {
      return res.status(502).json({ error: 'Update ke baad bhi offer URL badla nahi (abhi: ' + after.url_offer_page + '). Cloaking.house ka jawab: ' + short(upd) });
    }
    const a = snap(before), b = snap(after);
    const drift = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    res.json({ ok: true, drift, offer: after.url_offer_page, name: after.name, id, resp: short(upd) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
