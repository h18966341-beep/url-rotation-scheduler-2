const { guard, ch, pick } = require('./_lib');

const FIELDS = ['name','url_white_page','url_offer_page','mode_white_page','mode_offer_page',
  'filter_countries','filter_devices','filter_os','filter_browsers','filter_langs',
  'filter_time_zones','filter_connections','filter_tags','filter_cloaking_flag',
  'filter_vpn_proxy_flag','filter_ip_v6_flag','filter_referer_flag','filter_isp_flag',
  'filter_black_ip_flag','filter_tag_flag','filter_ip_clicks_per_day',
  'filter_clicks_before_filtering','mode_list_country','mode_list_device','mode_list_os',
  'mode_list_browser','mode_list_lang','mode_list_time_zone','mode_list_connection',
  'filter_id','allowed_ips'];

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  const { flow_id, url } = req.body || {};
  if (!flow_id || !/^https?:\/\/\S+$/i.test(url || '')) {
    return res.status(400).json({ error: 'flow_id aur sahi URL chahiye' });
  }
  const id = Number(flow_id);
  const snap = o => {
    const s = {};
    FIELDS.forEach(k => { if (o && o[k] !== undefined && k !== 'url_offer_page') s[k] = o[k]; });
    return s;
  };
  try {
    const before = pick(await ch('/details', { flow_id: id }));
    const payload = { flow_id: id };
    FIELDS.forEach(k => { if (before[k] !== undefined) payload[k] = before[k]; });
    payload.url_offer_page = url;
    await ch('/update', payload);
    const after = pick(await ch('/details', { flow_id: id }));
    const a = snap(before), b = snap(after);
    const drift = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    res.json({ ok: true, drift, offer: after.url_offer_page });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
