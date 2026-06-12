export function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim()
  if (!token || token !== process.env.INGEST_ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
