// This is a public, website-restricted browser key, never a server API key.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const key = String(process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  return res.status(200).json({ enabled: !!key, key });
};
