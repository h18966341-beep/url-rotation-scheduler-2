const { guard, ch, pick } = require('./_lib');

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    let list = pick(await ch('', {}));
    if (!Array.isArray(list)) list = Object.values(list || {});
    res.json({
      flows: list.map(f => ({
        id: f.id ?? f.flow_id,
        name: f.name || 'Flow ' + (f.id ?? f.flow_id),
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
