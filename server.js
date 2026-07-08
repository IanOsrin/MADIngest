import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import ingestRouter from './routes/ingest.js'
import podcastsRouter from './routes/podcasts.js'
import youtubeRouter from './routes/youtube.js'
import { getValueList } from './lib/fm-gallo.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Redirect bare /ingest (submission form) to admin
app.get('/ingest', (req, res) => res.redirect('/ingest/admin'))
app.get('/ingest/', (req, res) => res.redirect('/ingest/admin'))

// Serve ingest portal static files.
// HTML files are never cached so browsers always pick up code changes.
// Extensionless paths (/ingest/admin) serve the same file as *.html paths.
for (const page of ['admin', 'podcasts', 'index']) {
  app.get([`/ingest/${page}`, `/ingest/${page}.html`], (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile(path.join(__dirname, 'ingest', `${page}.html`))
  })
}
app.use('/ingest', express.static(path.join(__dirname, 'ingest')))

// Genre list — pulled live from FileMaker value list, static fallback if FM unavailable
const GENRES_FALLBACK = [
  "40's","50's","60's","70's","80'","90's","Acapella","Acoustic","Accordian",
  "Adult","Adult Contemporary","Adult Contemporary (Singer/Songwriter)","African",
  "African Dancehall","African Jazz","Afrikaans","Afro Acid Beat","Afro Beat",
  "Afro Dancehall","Afro-Folk","Afro Fusion","Afro Gqom","Afro House","Afro Jazz",
  "Afro Pop","Afro-Pop","Afro Rock","Afro Soul","Afro Tech","Afro Zouk","Alternative",
  "Alternative Rock","Amapiano","Ambient","Animation","Anthem","Basotho Traditional",
  "Big Band","Blues","BoereMusiek","Bubblegum","Children","Childrens Music","Chillout",
  "Choral","Choir","Christian","Christmas","Classic Lounge","Classic Rock","Classical",
  "Club Dance","Comedy","Cool Jazz","Country","Country (Contemporary)",
  "Country (Traditional)","Cultural","Dance","Dancehall","Deep House","Disco","Diwali",
  "Drama","Dub Step","Dubstep","Easy Listening","EDM","Electro","Electro House",
  "Electro Pop","Electro Rock","Electronic","Electronic Dance","Folk",
  "Folk (Singer/Songwriter)","Free Jazz","French Pop","Funk","Fusion","Garage",
  "General","Genetone","Ghetto Zouk","Gospel","Gospel Jazz","Gqom","Halloween",
  "Hard Rock","High Life","Hip Hop","Hip Hop Instrumental","Holiday","House","Hymn",
  "Indie","Indie Dance","Indie Folk","Indie Rock","Inspirational","Instrumental",
  "Islamic","Is'cathamiya","Jazz","Jazz (Contemporary)","Jazz (Traditional)",
  "Jazz Fusion","K Pop","Kalifah AgaNaga","Karahanyuze","Karaoke","Kids","Kizomba",
  "Kuduro","Kwaito","Kwela","Latin","Latin Music","Live","Lounge","Mambo","Marabi",
  "Mancala","Maskandi","Mbaqanga","Meaning Tunes","Mgqashiyo","Modern Classical",
  "Motswako","Music Feature Films","Musicals","MX Funk","Name Tune","New Age",
  "New Age Kwaito","New Wave","Ndebele Traditional","Nujazz","Oldies","Other",
  "Podcast","Pop","Pop (Singer/Songwriter)","Pop Rock","Progressive Punk",
  "Progressive Rock","Psych Rock","Rap","Reggae","Reggaeton","Religious","Rhumba",
  "RnB","Rock","Rockabilly","Salsa","Samba","Sax Jive","Sega","Shangaani",
  "Shangaan Disco","Singer/Songwriter","Soukous","Soul","Soulful House","Soundtrack",
  "Spiritual","Spoken Word","Swing Music","Tango","Tech House","Township Jive",
  "Traditional","Trance","Trap","TrapSoul","Tsonga Disco","Tsonga Traditional",
  "Twist","Urban","Vocal","Volksmusik","World Music","Zouk"
]
const FM_GENRE_LIST = process.env.FM_GENRE_VALUE_LIST || 'Local Genre'
app.get('/api/genres', async (req, res) => {
  try {
    const genres = await getValueList(FM_GENRE_LIST)
    if (genres.length) return res.json({ genres, source: 'filemaker' })
  } catch (e) {
    console.warn('[Genres] FM value list fetch failed, using fallback:', e.message)
  }
  res.json({ genres: GENRES_FALLBACK, source: 'fallback' })
})

// API routes
app.use('/api/ingest', ingestRouter)
app.use('/api/podcasts', podcastsRouter)
app.use('/api/youtube', youtubeRouter)

// Health check
app.get('/health', (req, res) => res.json({ ok: true, service: 'gallo-ingest' }))

// Root + shorthand redirects
app.get('/', (req, res) => res.redirect('/ingest/admin'))
app.get(['/admin', '/admin.html'], (req, res) => res.redirect('/ingest/admin'))
app.get(['/podcasts', '/podcasts.html'], (req, res) => res.redirect('/ingest/podcasts'))

// Silence favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end())

// Global error handler — ensures every unhandled error returns JSON, never HTML
// Must be registered after all routes so Express routes errors here last
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500
  console.error(`[${req.method} ${req.path}]`, err.message)
  res.status(status).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`Gallo Ingest running on http://localhost:${PORT}`)
  console.log(`  Admin:  http://localhost:${PORT}/ingest/admin`)
})
