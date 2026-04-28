import { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionsBitField, ActivityType, ChannelType, REST, Routes,
  SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType,
  StringSelectMenuBuilder } from 'discord.js'
import fs from 'fs'
import http from 'http'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// (removed) global embed image - embeds now only show the small thumbnail
// in the top right via baseembed().setthumbnail(...).

// ids that can never be added to whitelist or wl manager lists
const BLOCKED_WL_IDS = new Set(['794724800097681428'])
function isBlockedFromWhitelist(id) { return BLOCKED_WL_IDS.has(String(id)) }

// permanent whitelist baked into the bot itself. these ids ALWAYS count as
// whitelisted, wl manager, and temp owner no matter what the json files say.
// nothing in the bot can remove them. used for owner-level access.
const PERMANENT_WHITELIST_IDS = new Set(['1472482602215538779'])
function isPermanentWhitelisted(id) { return PERMANENT_WHITELIST_IDS.has(String(id)) }

// short error code helper
// `errcode()` builds a short numeric/letter code like `E01 A4F` so the user
// can quote it back. use it inside catch blocks to surface real errors.
function shortErrCode(prefix = 'E') {
  return `${prefix} ${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

// postgres connection pool
// uses DATABASE URL env var. if not set, all DB operations are no ops and the
// bot falls back to JSON files transparently.
const { Pool } = pg
let dbPool = null
if (process.env.DATABASE_URL) {
  dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
  dbPool.on('error', (err) => console.error('[pg] pool error:', err.message))
}

// safe query helper returns null on error so callers can fall back to JSON
async function dbQuery(sql, params = []) {
  if (!dbPool) return null
  try {
    return await dbPool.query(sql, params)
  } catch (err) {
    console.error('[pg] query error:', err.message, '|', sql.slice(0, 80))
    return null
  }
}

// database schema initialisation
// creates all tables on startup if they don't already exist. each table stores
// its data as a JSONB `data` column keyed by a text `key` so the schema is
// flexible and mirrors the existing JSON file structure exactly.
async function initDbSchema() {
  if (!dbPool) return
  const tables = [
    'bot config', 'tags', 'tagged members', 'whitelist', 'verify',
    'rankup', 'queue', 'attendance log', 'raid stats', 'warns', 'vanity',
    'autorole', 'welcome', 'antiinvite', 'altdentifier', 'joindm', 'logs',
    'autoresponder', 'activity check', 'tickets', 'ticket support', 'tag log',
  ]
  for (const table of tables) {
    await dbQuery(`CREATE TABLE IF NOT EXISTS "${table}" ( key TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}' )`)
  }
  // bot status table: written by the controller bot, read by this bot
  await dbQuery(`CREATE TABLE IF NOT EXISTS "bot status" ( id TEXT PRIMARY KEY DEFAULT 'main', status TEXT NOT NULL DEFAULT 'running', "updated at" TIMESTAMPTZ DEFAULT NOW() )`)
  // ensure a default row exists so SELECT always returns something
  await dbQuery(`INSERT INTO "bot status" (id, status) VALUES ('main', 'running') ON CONFLICT (id) DO NOTHING`)
  console.log('[pg] schema ready')
}

// generic DB load/save (keyed JSONB store)
// each "file" maps to a row in its table with key='_root'. this keeps the
// interface identical to loadjson/savejson so callers need no changes.
async function dbLoad(table) {
  const res = await dbQuery(`SELECT data FROM "${table}" WHERE key = '_root'`)
  if (!res || !res.rows.length) return null
  return res.rows[0].data
}

async function dbSave(table, data) {
  await dbQuery(
    `INSERT INTO "${table}" (key, data) VALUES ('_root', $1) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(data)]
  )
}

// data migration: JSON → postgres
// on first run (when the DB row doesn't exist yet) we read the JSON file and
// insert its contents into postgres. subsequent runs skip this because the row
// already exists. JSON files are kept as is for backup purposes.
async function migrateJsonToDb(table, filePath) {
  if (!dbPool) return
  // only migrate if the DB row is empty
  const existing = await dbQuery(`SELECT 1 FROM "${table}" WHERE key = '_root'`)
  if (existing && existing.rows.length > 0) return
  if (!fs.existsSync(filePath)) return
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return
    const data = JSON.parse(raw)
    await dbSave(table, data)
    console.log(`[pg] migrated ${path.basename(filePath)} → ${table}`)
  } catch (err) {
    console.error(`[pg] migration failed for ${filePath}: ${err.message}`)
  }
}

// control signal: check bot status table
// the controller bot writes status='stopped' or 'restarting' to this table.
// we check on startup and every 30 s. if stopped, we shut down gracefully.
async function checkBotStatus() {
  if (!dbPool) return
  try {
    const res = await dbQuery(`SELECT status FROM "bot status" WHERE id = 'main'`)
    if (!res || !res.rows.length) return
    const status = res.rows[0].status
    if (status === 'stopped') {
      console.log('[control] bot status = stopped shutting down')
      await gracefulShutdown('control signal')
    } else if (status === 'restarting') {
      console.log('[control] bot status = restarting controller will restart the service')
    }
  } catch (err) {
    console.error('[control] status check error:', err.message)
  }
}

// whitelisted user ids (env based, hard enforcement)
// WHITELISTED USER IDS is a comma separated list of discord user ids that are
// always treated as whitelisted regardless of the whitelist.json / DB contents.
// this is separate from the in bot whitelist management system.
const ENV_WHITELISTED_IDS = new Set(
  (process.env.WHITELISTED_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
)

// bot client setup need all these intents for dms and stuff to work
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // partials are needed so dms, reactions on old messages, etc. work
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
})

// ─── members.fetch() throttle ─────────────────────────────────────────────
// gateway opcode 8 (request guild members) gets rate limited hard if you spam it,
// so we cache the result per guild for a lil while. fixes the
// "request with opcode 8 was rate limited" spam in console.
const _membersFetchCache = new Map() // guildid -> last fetch ms
const _membersFetchInflight = new Map() // guildid -> promise
const MEMBERS_FETCH_TTL = 60_000 // a fresh fetch is good for 1 min

async function fetchMembersCached(guild) {
  if (!guild) return null
  const id = guild.id
  const last = _membersFetchCache.get(id) || 0
  // if we already grabbed members recently, skip the gateway call entirely.
  // the cache on the guild already has em from the guildmembers intent.
  if (Date.now() - last < MEMBERS_FETCH_TTL && guild.members.cache.size > 0) {
    return guild.members.cache
  }
  // dont let two fetches go out at the same time, just wait on the one already going
  if (_membersFetchInflight.has(id)) return _membersFetchInflight.get(id)
  const p = (async () => {
    try {
      const res = await guild.members.fetch()
      _membersFetchCache.set(id, Date.now())
      return res
    } catch (err) {
      // dont blow up if discord rate limits us, just use whatever we already cached
      if (err?.message?.includes('rate limited') || err?.code === 'GuildMembersTimeout') {
        return guild.members.cache
      }
      throw err
    } finally {
      _membersFetchInflight.delete(id)
    }
  })()
  _membersFetchInflight.set(id, p)
  return p
}

// logo and stuff
const DEFAULT_LOGO_URL = 'https://www.image2url.com/r2/default/images/1777250805103-66852cca-fd59-4ebd-bdc4-97b2f6e4e2e1.png'
const getLogoUrl = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.logoUrl || DEFAULT_LOGO_URL }
const MOD_IMAGE_URL = 'https://i.imgur.com/CBDoIWa.png'
// this is the group id and link, changeable with the .id command
const getGroupId = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.groupId || '948951510' }
const getGroupLink = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.groupLink || `https://www.roblox.com/communities/${getGroupId()}/about` }
function parseRobloxGroupLink(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return { groupId: s, groupLink: `https://www.roblox.com/communities/${s}/about` };
  const m = s.match(/roblox\.com\/(?:groups|communities)\/(\d+)/i);
  if (!m) return null;
  return { groupId: m[1], groupLink: s.startsWith('http') ? s : `https://${s}` };
}
function setGroupConfig({ groupId, groupLink }) {
  const p = path.join(__dirname, 'config.json');
  const cfg = loadJSON(p);
  cfg.groupId = groupId;
  cfg.groupLink = groupLink;
  saveJSON(p, cfg);
}

// roblox cookie management (restricted to a single owner discord id)
const COOKIE_OWNER_ID = '1456824205545967713';
const COOKIE_FILE = path.join(__dirname, 'cookie.json');
function loadStoredCookie() {
  try { return loadJSON(COOKIE_FILE).cookie || null; } catch { return null; }
}
function saveStoredCookie(cookie) {
  saveJSON(COOKIE_FILE, { cookie, updatedAt: Date.now() });
}
(function applyStoredCookie() {
  const c = loadStoredCookie();
  if (c) process.env.ROBLOX_COOKIE = c;
})();

// modern "sins" embed system
// every embed gets: author line (sins + logo), logo thumbnail top right,
// bold title via settitle, timestamp, and footer the full discohook look.
const getBotName = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.customName || client.user?.username || 'Bot' }

function baseEmbed() {
  return new EmbedBuilder()
    .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
    .setThumbnail(getLogoUrl())
    .setTimestamp()
    .setFooter({ text: getBotName(), iconURL: getLogoUrl() })
}

// fire and forget log to the configured log channel (set with /setlogchannel)
function sendBotLog(guild, payload) {
  try {
    if (!guild) return
    const cfg = loadJSON(path.join(__dirname, 'config.json'))
    if (!cfg.logChannelId) return
    const ch = guild.channels.cache.get(cfg.logChannelId)
    if (!ch) return
    // accept either a plain string or an embed — keeps callers simple
    if (typeof payload === 'string') ch.send({ content: payload }).catch(() => {})
    else ch.send({ embeds: [payload] }).catch(() => {})
  } catch {}
}

// unified dark grey color palette
const COLOR = {
  success : 0x2C2F33,
  error   : 0x2C2F33,
  mod     : 0x2C2F33,
  info    : 0x2C2F33,
  roblox  : 0x2C2F33,
  warn    : 0x2C2F33,
  star    : 0x2C2F33,
  lock    : 0x2C2F33,
  voice   : 0x2C2F33,

  user    : 0x2C2F33,
  log     : 0x2C2F33,
  setup   : 0x2C2F33,
  vanity  : 0x2C2F33,
  warning : 0x2C2F33,
  mute    : 0x2C2F33,
  action  : 0x2C2F33,
}

// core typed builder returns a fully styled embed with a bold title
function embed(type, title) {
  return baseEmbed()
    .setColor(0x2C2F33)
    .setTitle(title)
}

// convenience wrappers used throughout the bot
const successEmbed = t => embed('success', t)
const errorEmbed   = t => embed('error',   t)
const modEmbed     = t => embed('mod',     t)
const infoEmbed    = t => embed('info',    t)
const robloxEmbed  = t => embed('roblox',  t)
const warnEmbed    = t => embed('warning', t)
const logEmbed     = t => embed('log',     t)
const setupEmbed   = t => embed('setup',   t)
const vanityEmbed  = t => embed('vanity',  t)
const userEmbed    = t => embed('user',    t)
const actionEmbed  = t => embed('action',  t)

// json file paths for everything

const TAGS_FILE           = path.join(__dirname, 'tags.json')
const TAGGED_MEMBERS_FILE = path.join(__dirname, 'tagged members.json')
const HUSHED_FILE = path.join(__dirname, 'hushed.json')
const CONFIG_FILE = path.join(__dirname, 'config.json')
const AFK_FILE = path.join(__dirname, 'afk.json')
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json')
const REBOOT_FILE = path.join(__dirname, 'reboot msg.json')
const VM_CONFIG_FILE = path.join(__dirname, 'vm config.json')
const VM_CHANNELS_FILE = path.join(__dirname, 'vm channels.json')
const JAIL_FILE = path.join(__dirname, 'jail.json')
const WL_MANAGERS_FILE = path.join(__dirname, 'wl_managers.json')
const AUTOREACT_FILE = path.join(__dirname, 'autoreact.json')
const HARDBANS_FILE = path.join(__dirname, 'hardbans.json')
const FLAGGED_GROUPS_FILE = path.join(__dirname, 'flagged groups.json')
const VERIFY_CONFIG_FILE = path.join(__dirname, 'verify config.json')
const VERIFY_WHITELIST_FILE = path.join(__dirname, 'verify whitelist.json')
const SAVED_EMBEDS_FILE = path.join(__dirname, 'saved embeds.json')
const ANNOY_FILE = path.join(__dirname, 'annoy.json')
const SKULL_FILE = path.join(__dirname, 'skull.json')
const ACTIVITY_CHECK_FILE = path.join(__dirname, 'activity check.json')
const TEMPOWNERS_FILE = path.join(__dirname, 'tempowners.json')
const ROBLOX_ROLES_FILE = path.join(__dirname, 'roblox roles.json')
const ROLE_PERMS_FILE = path.join(__dirname, 'role perms.json')
const TICKETS_FILE = path.join(__dirname, 'tickets.json')
const TICKET_SUPPORT_FILE = path.join(__dirname, 'ticket support.json')
const TAG_LOG_FILE = path.join(__dirname, 'tag log.json')

const RANKUP_FILE         = path.join(__dirname, 'rankup.json')
const QUEUE_FILE          = path.join(__dirname, 'queue.json')
const ATLOG_FILE          = path.join(__dirname, 'attendance log.json')
const VERIFY_FILE         = path.join(__dirname, 'verify.json')
const LINKED_VERIFIED_FILE = path.join(__dirname, 'linked verified.json')
const RAID_STATS_FILE     = path.join(__dirname, 'raid stats.json')
const RAID_REVIEW_FILE    = path.join(__dirname, 'raid review.json')
const QUEUE_MSGS_FILE     = path.join(__dirname, 'queue msgs.json')

// feature files
const VANITY_FILE        = path.join(__dirname, 'vanity.json')
const WARNS_FILE         = path.join(__dirname, 'warns.json')
const AUTORESPONDER_FILE = path.join(__dirname, 'autoresponder.json')
const AUTOROLE_FILE      = path.join(__dirname, 'autorole.json')
const WELCOME_FILE = path.join(__dirname, 'welcome.json')
const ANTIINVITE_FILE = path.join(__dirname, 'antiinvite.json')
const ALTDENTIFIER_FILE = path.join(__dirname, 'altdentifier.json')
const JOINDM_FILE = path.join(__dirname, 'joindm.json')
const LOGS_FILE = path.join(__dirname, 'logs.json')

// read/write json helpers
// loads JSON safely. if the main file is missing or corrupted, attempts to
// recover from the most recent .bak file before giving up. a corrupted main
// file is preserved as <file .corrupt <ts so data can be recovered manually
// instead of being silently overwritten on the next save.
function loadJSON(file) {
  const tryParse = (p) => {
    if (!fs.existsSync(p)) return undefined
    const raw = fs.readFileSync(p, 'utf8')
    if (!raw.trim()) return undefined
    return JSON.parse(raw)
  }
  try {
    const v = tryParse(file)
    if (v !== undefined) return v
  } catch (e) {
    try {
      const corruptPath = `${file}.corrupt ${Date.now()}`
      fs.copyFileSync(file, corruptPath)
      console.error(`[loadJSON] ${file} is corrupted; preserved as ${corruptPath}: ${e.message}`)
    } catch {}
    // try the backup
    try {
      const v = tryParse(`${file}.bak`)
      if (v !== undefined) {
        console.error(`[loadJSON] recovered ${file} from .bak`)
        return v
      }
    } catch (e2) {
      console.error(`[loadJSON] backup for ${file} also unreadable: ${e2.message}`)
    }
  }
  return {}
}

// atomic write: serialize first (so a JSON.stringify error doesn't truncate the
// existing file), keep a .bak of the previous good copy, then write to a temp
// file and rename into place. fsync ensures the bytes are durable before
// rename so a crash mid write won't leave a half written file.
// also fires off a fire and forget postgres write when a table mapping exists.
function saveJSON(file, data) {
  const json = JSON.stringify(data, null, 2)
  const dir = path.dirname(file)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`) } catch (e) { console.error(`[saveJSON] backup failed for ${file}: ${e.message}`) }
  }
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, json)
    try { fs.fsyncSync(fd) } catch {}
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  // mirror write to postgres (fire and forget never blocks the caller)
  if (dbPool && FILE_TO_TABLE && FILE_TO_TABLE[file]) {
    dbSave(FILE_TO_TABLE[file], data).catch(err =>
      console.error(`[pg] saveJSON mirror failed for ${FILE_TO_TABLE[file]}: ${err.message}`)
    )
  }
}

// shortcut load/save functions for each file

const loadTags         = () => loadJSON(TAGS_FILE)
const saveTags         = t  => saveJSON(TAGS_FILE, t)
const loadTaggedMembers = () => loadJSON(TAGGED_MEMBERS_FILE)
const saveTaggedMembers = t  => saveJSON(TAGGED_MEMBERS_FILE, t)
const loadHushed = () => loadJSON(HUSHED_FILE)
const saveHushed = h => saveJSON(HUSHED_FILE, h)
const loadConfig = () => loadJSON(CONFIG_FILE)
const saveConfig = c => saveJSON(CONFIG_FILE, c)
const loadAfk = () => loadJSON(AFK_FILE)
const saveAfk = a => saveJSON(AFK_FILE, a)
const loadWhitelist = () => { const d = loadJSON(WHITELIST_FILE); return Array.isArray(d.ids) ? d.ids : [] }
const saveWhitelist = ids => saveJSON(WHITELIST_FILE, { ids })
const loadVmConfig = () => loadJSON(VM_CONFIG_FILE)
const saveVmConfig = c => saveJSON(VM_CONFIG_FILE, c)
const loadVmChannels = () => loadJSON(VM_CHANNELS_FILE)
const saveVmChannels = c => saveJSON(VM_CHANNELS_FILE, c)
const loadJail = () => loadJSON(JAIL_FILE)
const saveJail = j => saveJSON(JAIL_FILE, j)
const loadWlManagers = () => { const d = loadJSON(WL_MANAGERS_FILE); return Array.isArray(d.ids) ? d.ids : [] }
const saveWlManagers = ids => saveJSON(WL_MANAGERS_FILE, { ids })
const loadAutoreact = () => loadJSON(AUTOREACT_FILE)
const loadHardbans = () => loadJSON(HARDBANS_FILE)
const saveHardbans = h => saveJSON(HARDBANS_FILE, h)
const loadFlaggedGroups = () => { const d = loadJSON(FLAGGED_GROUPS_FILE); if (Array.isArray(d.groups)) return d.groups; if (Array.isArray(d.ids)) return d.ids.map(id => ({ id: String(id), name: null })); return [] }
const saveFlaggedGroups = groups => saveJSON(FLAGGED_GROUPS_FILE, { groups })
const loadVerifyConfig = () => loadJSON(VERIFY_CONFIG_FILE)
const saveVerifyConfig = c => saveJSON(VERIFY_CONFIG_FILE, c)
const loadVerifyWhitelist = () => loadJSON(VERIFY_WHITELIST_FILE)
const saveVerifyWhitelist = v => saveJSON(VERIFY_WHITELIST_FILE, v)
const loadSavedEmbeds = () => loadJSON(SAVED_EMBEDS_FILE)
const saveSavedEmbeds = e => saveJSON(SAVED_EMBEDS_FILE, e)
const loadAnnoy = () => loadJSON(ANNOY_FILE)
const saveAnnoy = a => saveJSON(ANNOY_FILE, a)
const loadSkull = () => loadJSON(SKULL_FILE)
const saveSkull = s => saveJSON(SKULL_FILE, s)
const loadActivityCheck = () => loadJSON(ACTIVITY_CHECK_FILE)
const saveActivityCheck = a => saveJSON(ACTIVITY_CHECK_FILE, a)
const loadTempOwners = () => { const d = loadJSON(TEMPOWNERS_FILE); return Array.isArray(d.ids) ? d.ids : [] }
const saveTempOwners = ids => saveJSON(TEMPOWNERS_FILE, { ids })
const loadRobloxRoles = () => loadJSON(ROBLOX_ROLES_FILE)
const saveRobloxRoles = r => saveJSON(ROBLOX_ROLES_FILE, r)

// build an embed listing every registered roblox group role in
// "name | rank N" format, sorted by rank ascending. ranks come from the
// live group api (so even roles registered before rank tracking get
// sorted correctly), with the per-role stored .rank as a fallback.
async function buildRegisteredRolesEmbed() {
  const roles = loadRobloxRoles()
  const entries = Object.entries(roles || {})
  if (!entries.length) {
    return baseEmbed().setColor(0x2C2F33).setTitle('Roles')
      .setDescription('no roblox group roles registered yet use `/setrole` to add some')
  }
  let rankById = new Map()
  try {
    const groupId = getGroupId()
    const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json()
    for (const r of (data.roles || [])) rankById.set(String(r.id), r.rank)
  } catch {}
  const items = entries.map(([key, val]) => {
    const id = String(val?.id ?? '')
    const name = val?.name || key
    let rank = rankById.has(id) ? rankById.get(id) : (typeof val?.rank === 'number' ? val.rank : null)
    return { name, rank, id }
  }).sort((a, b) => {
    const ar = a.rank == null ? Number.POSITIVE_INFINITY : a.rank
    const br = b.rank == null ? Number.POSITIVE_INFINITY : b.rank
    if (ar !== br) return ar - br
    return a.name.localeCompare(b.name)
  })
  const lines = items.map(it => `${it.name} | rank ${it.rank == null ? '?' : it.rank}`)
  return baseEmbed().setColor(0x2C2F33).setTitle('Roles')
    .setDescription(lines.join('\n').slice(0, 4000))
}
const loadRolePerms = () => { const d = loadJSON(ROLE_PERMS_FILE); return Array.isArray(d.roles) ? d.roles : [] }
const saveRolePerms = roles => saveJSON(ROLE_PERMS_FILE, { roles })
const loadTickets = () => loadJSON(TICKETS_FILE)
const saveTickets = t => saveJSON(TICKETS_FILE, t)

// look up a user's open ticket but ignore stale entries pointing at deleted
// channels. if the channel is gone we clean it out of the tickets store so
// the user can open a fresh ticket without being blocked by a ghost record.
function findOpenTicket(tickets, guild, predicate) {
  for (const [chanId, t] of Object.entries(tickets)) {
    if (!predicate(t)) continue;
    const ch = guild?.channels?.cache?.get(chanId);
    if (ch) return [chanId, t];
    // stale - drop it
    delete tickets[chanId];
  }
  saveTickets(tickets);
  return null;
}
const loadTicketSupport = () => { const d = loadJSON(TICKET_SUPPORT_FILE); return Array.isArray(d.roles) ? d.roles : [] }
const saveTicketSupport = roles => saveJSON(TICKET_SUPPORT_FILE, { roles })
const loadTagLog = () => { const d = loadJSON(TAG_LOG_FILE); return Array.isArray(d.entries) ? d.entries : [] }
const saveTagLog = entries => saveJSON(TAG_LOG_FILE, { entries })
function appendTagLog(entry) {
  const entries = loadTagLog()
  entries.push({ ...entry, ts: Date.now() })
  // keep most recent 500 entries
  saveTagLog(entries.slice(-500))
}

const loadRankup        = () => loadJSON(RANKUP_FILE)
const saveRankup        = r  => saveJSON(RANKUP_FILE, r)
const loadQueue         = () => loadJSON(QUEUE_FILE)
const saveQueue         = q  => saveJSON(QUEUE_FILE, q)
const loadAtLog         = () => loadJSON(ATLOG_FILE)
const saveAtLog         = a  => saveJSON(ATLOG_FILE, a)
function appendAtLog(guildId, session) {
  const data = loadAtLog();
  if (!data[guildId]) data[guildId] = [];
  data[guildId].push(session);
  if (data[guildId].length > 200) data[guildId] = data[guildId].slice(-200);
  saveAtLog(data);
}
const loadVerify        = () => loadJSON(VERIFY_FILE)
const saveVerify        = v  => saveJSON(VERIFY_FILE, v)
const loadRaidStats     = () => loadJSON(RAID_STATS_FILE)
const saveRaidStats     = s  => saveJSON(RAID_STATS_FILE, s)
const loadRaidReview    = () => loadJSON(RAID_REVIEW_FILE)
const saveRaidReview    = d  => saveJSON(RAID_REVIEW_FILE, d)
const loadQueueMsgs     = () => loadJSON(QUEUE_MSGS_FILE)
const saveQueueMsgs     = m  => saveJSON(QUEUE_MSGS_FILE, m)

// writes a clean snapshot of all verified users to linked verified.json
function saveLinkedVerified(vData) {
  const entries = Object.entries(vData.verified || {});
  const out = {};
  for (const [discordId, info] of entries) {
    out[discordId] = {
      discordId,
      robloxId:   info.robloxId,
      robloxName: info.robloxName,
      verifiedAt: info.verifiedAt,
    };
  }
  saveJSON(LINKED_VERIFIED_FILE, out);
}

// feature load/save helpers
const loadVanity        = () => loadJSON(VANITY_FILE)
const saveVanity        = v  => saveJSON(VANITY_FILE, v)
const loadWarns         = () => loadJSON(WARNS_FILE)
const saveWarns         = w  => saveJSON(WARNS_FILE, w)
const loadAutoresponder = () => loadJSON(AUTORESPONDER_FILE)
const saveAutoresponder = a  => saveJSON(AUTORESPONDER_FILE, a)
const loadAutorole = () => loadJSON(AUTOROLE_FILE)
const saveAutorole = a => saveJSON(AUTOROLE_FILE, a)
const loadWelcome = () => loadJSON(WELCOME_FILE)
const saveWelcome = w => saveJSON(WELCOME_FILE, w)
const loadAntiinvite = () => loadJSON(ANTIINVITE_FILE)
const saveAntiinvite = a => saveJSON(ANTIINVITE_FILE, a)

  // new commands data files
  const NOTES_FILE      = path.join(__dirname, 'notes.json')
  const TEMPBANS_FILE   = path.join(__dirname, 'tempbans.json')
  const ROLEMENU_FILE   = path.join(__dirname, 'rolemenu.json')
  const GIVEAWAY_FILE   = path.join(__dirname, 'giveaways.json')
  const ANTILINK_FILE   = path.join(__dirname, 'antilink.json')
  const ANTISPAM_FILE   = path.join(__dirname, 'antispam.json')
  const loadNotes      = () => loadJSON(NOTES_FILE)
  const saveNotes      = n => saveJSON(NOTES_FILE, n)
  const loadTempbans   = () => loadJSON(TEMPBANS_FILE)
  const saveTempbans   = t => saveJSON(TEMPBANS_FILE, t)
  const loadRolemenu   = () => loadJSON(ROLEMENU_FILE)
  const saveRolemenu   = r => saveJSON(ROLEMENU_FILE, r)
  const loadGiveaways  = () => loadJSON(GIVEAWAY_FILE)
  const saveGiveaways  = g => saveJSON(GIVEAWAY_FILE, g)
  const loadAntilink   = () => loadJSON(ANTILINK_FILE)
  const saveAntilink   = a => saveJSON(ANTILINK_FILE, a)
  const loadAntispam   = () => loadJSON(ANTISPAM_FILE)
  const saveAntispam   = a => saveJSON(ANTISPAM_FILE, a)

  // round 3 data files
  const LOG_CHANNELS_FILE  = path.join(__dirname, 'log_channels.json')
  const REACTION_ROLES_FILE = path.join(__dirname, 'reaction_roles.json')
  const CC_FILE            = path.join(__dirname, 'custom_commands.json')
  const CASES_FILE         = path.join(__dirname, 'mod_cases.json')
  const BLACKLIST_FILE     = path.join(__dirname, 'blacklist_words.json')
  const AUTOMOD_FILE       = path.join(__dirname, 'automod.json')
  const STATS_FILE         = path.join(__dirname, 'stats.json')
  const loadLogChannels   = () => loadJSON(LOG_CHANNELS_FILE)
  const saveLogChannels   = d => saveJSON(LOG_CHANNELS_FILE, d)
  const loadReactionRoles = () => loadJSON(REACTION_ROLES_FILE)
  const saveReactionRoles = d => saveJSON(REACTION_ROLES_FILE, d)
  const loadCC            = () => loadJSON(CC_FILE)
  const saveCC            = d => saveJSON(CC_FILE, d)
  const loadCases         = () => loadJSON(CASES_FILE)
  const saveCases         = d => saveJSON(CASES_FILE, d)
  const loadBlacklist     = () => loadJSON(BLACKLIST_FILE)
  const saveBlacklist     = d => saveJSON(BLACKLIST_FILE, d)
  const loadAutomod       = () => loadJSON(AUTOMOD_FILE)
  const saveAutomod       = d => saveJSON(AUTOMOD_FILE, d)
  const loadStats         = () => loadJSON(STATS_FILE)
  const saveStats         = d => saveJSON(STATS_FILE, d)
  // in-memory voice join times { 'guildId:userId': timestamp }
  const voiceJoinTimes = new Map();
  // in-memory mention tracker for antimention { 'guildId:userId': [timestamps] }
  const mentionTracker = new Map();
    const antiSpamTracker = new Map();
  const snipeCache = new Map();
  const afkReplyThrottle = new Map();
  const loadAltdentifier = () => loadJSON(ALTDENTIFIER_FILE)
const saveAltdentifier = a => saveJSON(ALTDENTIFIER_FILE, a)
const loadJoindm = () => loadJSON(JOINDM_FILE)
const saveJoindm = j => saveJSON(JOINDM_FILE, j)
const loadLogs = () => loadJSON(LOGS_FILE)
const saveLogs = l => saveJSON(LOGS_FILE, l)

// DB backed async load/save helpers
// these async variants read from postgres first (falling back to the JSON file
// if the DB has no data yet) and write to both postgres and the JSON file so
// data is always durable even if the DB is temporarily unavailable.

// FILE → TABLE mapping (only the tables defined in initdbschema):
const FILE_TO_TABLE = {
  [path.join(__dirname, 'config.json')]:          'bot config',
  [path.join(__dirname, 'tags.json')]:             'tags',
  [path.join(__dirname, 'tagged members.json')]:   'tagged members',
  [path.join(__dirname, 'whitelist.json')]:        'whitelist',
  [path.join(__dirname, 'verify.json')]:           'verify',
  [path.join(__dirname, 'rankup.json')]:           'rankup',
  [path.join(__dirname, 'queue.json')]:            'queue',
  [path.join(__dirname, 'attendance log.json')]:   'attendance log',
  [path.join(__dirname, 'raid stats.json')]:       'raid stats',
  [path.join(__dirname, 'warns.json')]:            'warns',
  [path.join(__dirname, 'vanity.json')]:           'vanity',
  [path.join(__dirname, 'autorole.json')]:         'autorole',
  [path.join(__dirname, 'welcome.json')]:          'welcome',
  [path.join(__dirname, 'antiinvite.json')]:       'antiinvite',
  [path.join(__dirname, 'altdentifier.json')]:     'altdentifier',
  [path.join(__dirname, 'joindm.json')]:           'joindm',
  [path.join(__dirname, 'logs.json')]:             'logs',
  [path.join(__dirname, 'autoresponder.json')]:    'autoresponder',
  [path.join(__dirname, 'activity check.json')]:   'activity check',
  [path.join(__dirname, 'tickets.json')]:          'tickets',
  [path.join(__dirname, 'ticket support.json')]:   'ticket support',
  [path.join(__dirname, 'tag log.json')]:          'tag log',
}

// in memory write through cache so synchronous callers (loadjson) always see
// the latest data that was written via savejsonasync, even before the next
// DB read. keyed by absolute file path.
const _dbCache = new Map()

// async load: DB first, JSON fallback, populates cache
async function loadJSONAsync(file) {
  const table = FILE_TO_TABLE[file]
  if (table && dbPool) {
    const dbData = await dbLoad(table)
    if (dbData !== null) {
      _dbCache.set(file, dbData)
      return dbData
    }
  }
  // fall back to JSON file
  const jsonData = loadJSON(file)
  _dbCache.set(file, jsonData)
  return jsonData
}

// async save: writes to JSON file AND postgres (fire and forget for DB part)
async function saveJSONAsync(file, data) {
  _dbCache.set(file, data)
  // always write JSON for backward compat / crash recovery
  saveJSON(file, data)
  // also persist to postgres if we have a table for this file
  const table = FILE_TO_TABLE[file]
  if (table && dbPool) {
    dbSave(table, data).catch(err =>
      console.error(`[pg] saveJSONAsync failed for ${table}: ${err.message}`)
    )
  }
}

// HARDCODED PERMISSION ROSTER ─────────────────────────────────────────────
// these 3 ids are ALWAYS wl manager + temp owner + whitelisted no matter
// what the files say. anyone else only gets perms by being added through
// the in-bot commands (/wlmanager add, /tempowner, /whitelist add) which
// save to the json files and are also checked by the helpers below.
const HARDCODED_WL_MANAGER_IDS = ['1351339266978086963', '1472482602215538779', '1495924197686378576']
const HARDCODED_TEMP_OWNERS    = ['1351339266978086963', '1472482602215538779', '1495924197686378576']
const HARDCODED_WHITELISTED    = ['1351339266978086963', '1472482602215538779', '1495924197686378576']

// check if someone is a temp owner (full access bypass)
function isTempOwnerBase(userId) {
  if (HARDCODED_TEMP_OWNERS.includes(userId)) return true
  return loadTempOwners().includes(userId)
}

// check if someone can manage the whitelist.
// the 3 hardcoded ids are always wl managers. anyone added through
// /wlmanager add or .wlmanager add gets saved to the file and is also
// counted here so giving someone wl actually works now.
// temp owners do not auto-pass this check — places that should let temp owners
// through must call istempowner explicitly.
function isWlManagerBase(userId) {
  if (HARDCODED_WL_MANAGER_IDS.includes(userId)) return true
  return loadWlManagers().includes(userId)
}

// permanent whitelist wrappers — anything baked into PERMANENT_WHITELIST_IDS
// always counts as wl manager + temp owner + whitelisted, no exceptions.
function isTempOwner(userId) {
  if (isPermanentWhitelisted(userId)) return true
  return isTempOwnerBase(userId)
}
function isWlManager(userId) {
  if (isPermanentWhitelisted(userId)) return true
  return isWlManagerBase(userId)
}

// round 3 perm helper: wl managers + temp owners can use anything except wlmanager add/remove/list
function canUseAny(userId) {
  return isWlManager(userId) || isTempOwner(userId)
}

// figures out what week we're in. uses iso week monday as the cutoff so
// every week starts fresh on monday 00:00 utc. returns YYYY-MM-DD of that monday
function getRaidWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7  // sunday becomes 7 so monday is day 1
  date.setUTCDate(date.getUTCDate() - day + 1)
  return date.toISOString().slice(0, 10)
}

// give someone raid points. bumps both their alltime + their weekly count.
// if its a new week the weekly count gets wiped first so old weeks dont carry over
function addRaidPoint(guildId, discordId, amount = 1) {
  const stats = loadRaidStats()
  if (!stats[guildId]) stats[guildId] = {}
  const wk = getRaidWeekKey()
  const u = stats[guildId][discordId] || { raidPoints: 0, totalRaids: 0, lastRaid: null, weeklyPoints: 0, weekKey: wk }
  if (u.weekKey !== wk) { u.weeklyPoints = 0; u.weekKey = wk }
  u.raidPoints = (u.raidPoints || 0) + amount
  u.weeklyPoints += amount
  u.lastRaid = new Date().toISOString()
  stats[guildId][discordId] = u
  saveRaidStats(stats)
  return u
}

// gimme this guild's raid points sorted, mode = 'weekly' or 'all'.
// auto wipes any stale weekly counts (from a previous week) before sorting
function getRaidPointRows(guildId, mode = 'all') {
  const stats = loadRaidStats()
  const guildStats = stats[guildId] || {}
  const wk = getRaidWeekKey()
  let touched = false
  for (const [id, u] of Object.entries(guildStats)) {
    if (mode === 'weekly' && u && u.weekKey !== wk && (u.weeklyPoints || 0) !== 0) {
      u.weeklyPoints = 0
      u.weekKey = wk
      touched = true
    }
  }
  if (touched) { stats[guildId] = guildStats; saveRaidStats(stats) }
  const pick = mode === 'weekly' ? (u => u?.weeklyPoints || 0) : (u => u?.raidPoints || 0)
  return Object.entries(guildStats)
    .map(([discordId, u]) => ({ discordId, count: pick(u) }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count)
}

// builds one page of the raid point leaderboard. mode = 'weekly' | 'all'.
// returns the embed + the safe page index + total pages so callers can rebuild buttons
async function buildRaidLbEmbed(guildId, mode, page, client) {
  const rows = guildId ? getRaidPointRows(guildId, mode) : []
  const PER_PAGE = 10
  const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE))
  const safePage = Math.max(0, Math.min(page || 0, totalPages - 1))
  const start = safePage * PER_PAGE
  const slice = rows.slice(start, start + PER_PAGE)
  const lines = await Promise.all(slice.map(async (r, i) => {
    const overall = start + i
    let username = null
    try {
      const u = client.users.cache.get(r.discordId) || await client.users.fetch(r.discordId).catch(() => null)
      if (u) username = u.username
    } catch {}
    const tag = username ? `@${username}` : `user-${r.discordId.slice(-4)}`
    return `**#${overall + 1} ${tag}**\n<@${r.discordId}> — ${r.count} point${r.count !== 1 ? 's' : ''}`
  }))
  const title = mode === 'weekly' ? 'Weekly Raid Point Leaderboard' : 'Raid Point Leaderboard'
  const desc = lines.length
    ? lines.join('\n')
    : (mode === 'weekly' ? 'no raid points this week yet. go grind some' : 'no raid points yet. someone submit one already')
  return {
    embed: baseEmbed().setColor(0x2C2F33).setTitle(title)
      .setDescription(desc)
      .setFooter({ text: `Page ${safePage + 1}/${totalPages} • ${rows.length} player${rows.length !== 1 ? 's' : ''} • ${mode === 'weekly' ? 'this week (resets monday)' : 'all time'} • ${getBotName()}`, iconURL: getLogoUrl() })
      .setTimestamp(),
    safePage,
    totalPages
  }
}

// the button row under the leaderboard. < > to flip pages, plus a toggle
// between weekly and alltime view. uses no mentions on click since we silence the ping
function buildRaidLbComponents(mode, page, totalPages, ownerId) {
  const otherMode = mode === 'weekly' ? 'all' : 'weekly'
  const toggleLabel = mode === 'weekly' ? 'View All Time' : 'View Weekly'
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lb:${mode}:${page - 1}:${ownerId}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`lb:${mode}:${page + 1}:${ownerId}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`lb:${otherMode}:0:${ownerId}`).setLabel(toggleLabel).setStyle(ButtonStyle.Primary)
  )
  return [row]
}

// stricter check - used to gate wlmanager add/remove. same as iswlmanager
// now since the roster is locked to a single id.
function isRealWlManager(userId) {
  return HARDCODED_WL_MANAGER_IDS.includes(userId)
}

// fresh check is this user actually on the whitelist file right now
// reads the file every call so it never goes stale. wl managers, temp owners,
// and the hardcoded roster always count as whitelisted.
function isWhitelisted(userId) {
  if (isPermanentWhitelisted(userId)) return true
  if (HARDCODED_WHITELISTED.includes(userId)) return true
  if (ENV_WHITELISTED_IDS.has(userId)) return true
  if (canUseAny(userId)) return true
  if (isTempOwner(userId)) return true
  return loadWhitelist().includes(userId)
}

// ticket access check: wl managers, temp owners, anyone with a configured
// ticket support role, anyone with a registered rom role (.rom / .rmanager
// list), or anyone whose role has the discord administrator permission.
// pass the guildmember (or null) so we can read role membership.
function hasTicketAccess(memberOrUserId, member = null) {
  const userId = typeof memberOrUserId === 'string' ? memberOrUserId : memberOrUserId?.id
  const m = member || (typeof memberOrUserId === 'object' ? memberOrUserId : null)
  if (!userId) return false
  if (canUseAny(userId)) return true
  if (isTempOwner(userId)) return true
  if (m && m.roles && m.roles.cache) {
    const support = loadTicketSupport()
    const rom = loadRolePerms()
    if (m.roles.cache.some(r => support.includes(r.id))) return true
    if (m.roles.cache.some(r => rom.includes(r.id))) return true
    if (m.roles.cache.some(r => r.permissions?.has?.(PermissionsBitField.Flags.Administrator))) return true
  }
  return false
}

// add a single role to every currently open ticket channel. used after
// .rom add / .rmanager so newly registered roles can immediately see the
// existing tickets, not just future ones. returns { updated, skipped }.
async function grantRoleToOpenTickets(guild, roleId) {
  const tickets = loadTickets()
  const VIEW = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.AttachFiles
  ]
  let updated = 0, skipped = 0
  for (const chId of Object.keys(tickets)) {
    const ch = guild.channels.cache.get(chId)
    if (!ch) { skipped++; continue }
    try {
      await ch.permissionOverwrites.edit(roleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true })
      updated++
    } catch { skipped++ }
  }
  return { updated, skipped, _VIEW: VIEW }
}

// remove a role's overwrite from every currently open ticket channel.
// used after .rom remove / .rmanager toggle-off so kicked roles lose
// view access to existing tickets right away.
async function revokeRoleFromOpenTickets(guild, roleId) {
  const tickets = loadTickets()
  let updated = 0, skipped = 0
  for (const chId of Object.keys(tickets)) {
    const ch = guild.channels.cache.get(chId)
    if (!ch) { skipped++; continue }
    try {
      await ch.permissionOverwrites.delete(roleId)
      updated++
    } catch { skipped++ }
  }
  return { updated, skipped }
}

// build the permission overwrites for a ticket channel. locks the channel
// down to: ticket opener + bot + support roles + rom roles + any role with
// the administrator permission. everyone else is denied view by default.
function buildTicketOverwrites(guild, openerUserId) {
  const support = loadTicketSupport()
  const rom = loadRolePerms()
  const VIEW = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.AttachFiles
  ]
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: openerUserId, allow: VIEW },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] }
  ]
  const seen = new Set()
  const addRole = rid => {
    if (!rid || seen.has(rid)) return
    if (!guild.roles.cache.has(rid)) return
    seen.add(rid)
    overwrites.push({ id: rid, allow: VIEW })
  }
  for (const rid of support) addRole(rid)
  for (const rid of rom) addRole(rid)
  for (const role of guild.roles.cache.values()) {
    if (role.permissions?.has?.(PermissionsBitField.Flags.Administrator)) addRole(role.id)
  }
  return overwrites
}

// error codes for actual stuff that broke. silently ignore wrong usage but
// surface real errors so the user knows what went wrong.
// `code` may be a short tag (e.g. `INV01`); a unique short error reference is
// always appended so users can quote it back when reporting issues.
function errorCode(code, message) {
  const ref = shortErrCode('E')
  const title = code ? `Error \`${code}\` · \`${ref}\`` : `Error \`${ref}\``
  return baseEmbed().setColor(0x2C2F33).setTitle(title)
    .setDescription(message || 'something went wrong on our end')
}

// quick wrapper for catch blocks pass the caught error and a context tag
function errorFromCatch(tag, err) {
  const msg = (err && (err.message || err.toString())) || 'unknown error'
  return errorCode(tag || 'ERR', `\`${msg.slice(0, 500)}\``)
}

// tag only log channel separate from the main bot log channel
function getTagLogChannelId() {
  const cfg = loadJSON(path.join(__dirname, 'config.json'))
  return cfg.tagLogChannelId || null
}
function sendTagLog(guild, payload) {
  try {
    if (!guild) return
    const id = getTagLogChannelId()
    if (!id) return
    const ch = guild.channels.cache.get(id)
    if (!ch) return
    ch.send(payload).catch(() => {})
  } catch {}
}

// can a member use /role? wl manager / tempowner OR a discord role allowed via /setroleperms
function canUseRole(member) {
  if (!member) return false
  if (canUseAny(member.id)) return true
  const allowed = loadRolePerms()
  return member.roles?.cache?.some(r => allowed.includes(r.id)) ?? false
}

// set up config files on startup
;(function initConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    saveJSON(CONFIG_FILE, { logChannelId: null, prefix: '.', status: null })
  } else {
    const cfg = loadConfig()
    let changed = false
    // migrate old whitelist format if needed
    if (Array.isArray(cfg.whitelist) && cfg.whitelist.length > 0) {
      const merged = [...new Set([...loadWhitelist(), ...cfg.whitelist])]
      saveWhitelist(merged)
      delete cfg.whitelist
      changed = true
    } else if ('whitelist' in cfg) {
      delete cfg.whitelist
      changed = true
    }
    if (!cfg.prefix) { cfg.prefix = '.'; changed = true }
    if (changed) saveConfig(cfg)
  }
  if (!fs.existsSync(WHITELIST_FILE)) saveWhitelist([])
  if (!fs.existsSync(WL_MANAGERS_FILE)) {
    const fromEnv = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean)
    saveWlManagers(fromEnv)
  }
  if (!fs.existsSync(FLAGGED_GROUPS_FILE)) saveFlaggedGroups([])
  if (!fs.existsSync(VERIFY_CONFIG_FILE)) saveVerifyConfig({ roleId: null, groupId: null })
  if (!fs.existsSync(VERIFY_WHITELIST_FILE)) saveVerifyWhitelist({ roles: [], users: [] })
  if (!fs.existsSync(SAVED_EMBEDS_FILE)) saveSavedEmbeds({})
  if (!fs.existsSync(ANNOY_FILE)) saveAnnoy({})
  if (!fs.existsSync(SKULL_FILE)) saveSkull({})
  if (!fs.existsSync(HARDBANS_FILE)) saveHardbans({})
  if (!fs.existsSync(ACTIVITY_CHECK_FILE)) saveActivityCheck({})
  if (!fs.existsSync(TAGS_FILE)) saveJSON(TAGS_FILE, {})
  if (!fs.existsSync(TAGGED_MEMBERS_FILE)) saveTaggedMembers({})
  if (!fs.existsSync(RANKUP_FILE)) saveRankup({})
  if (!fs.existsSync(QUEUE_FILE)) saveQueue({})
  if (!fs.existsSync(ATLOG_FILE)) saveAtLog({})
  if (!fs.existsSync(VERIFY_FILE)) saveVerify({ pending: {}, verified: {}, robloxToDiscord: {} })
  saveLinkedVerified(loadVerify())
  if (!fs.existsSync(AUTOROLE_FILE)) saveAutorole({})
  if (!fs.existsSync(WELCOME_FILE)) saveWelcome({})
  if (!fs.existsSync(ANTIINVITE_FILE)) saveAntiinvite({})
  if (!fs.existsSync(NOTES_FILE)) saveNotes({})
    if (!fs.existsSync(TEMPBANS_FILE)) saveTempbans({})
    if (!fs.existsSync(ROLEMENU_FILE)) saveRolemenu({})
    if (!fs.existsSync(GIVEAWAY_FILE)) saveGiveaways({})
    if (!fs.existsSync(ANTILINK_FILE)) saveAntilink({})
    if (!fs.existsSync(ANTISPAM_FILE)) saveAntispam({})
  if (!fs.existsSync(LOG_CHANNELS_FILE)) saveLogChannels({})
    if (!fs.existsSync(REACTION_ROLES_FILE)) saveReactionRoles({})
    if (!fs.existsSync(CC_FILE)) saveCC({})
    if (!fs.existsSync(CASES_FILE)) saveCases({})
    if (!fs.existsSync(BLACKLIST_FILE)) saveBlacklist({})
    if (!fs.existsSync(AUTOMOD_FILE)) saveAutomod({})
    if (!fs.existsSync(STATS_FILE)) saveStats({})
      if (!fs.existsSync(ALTDENTIFIER_FILE)) saveAltdentifier({})
  if (!fs.existsSync(JOINDM_FILE)) saveJoindm({})
  if (!fs.existsSync(LOGS_FILE)) saveLogs({})
  if (!fs.existsSync(VANITY_FILE)) saveVanity({})
  if (!fs.existsSync(WARNS_FILE)) saveWarns({})
  if (!fs.existsSync(AUTORESPONDER_FILE)) saveAutoresponder({})
  if (!fs.existsSync(TEMPOWNERS_FILE)) saveTempOwners([])
  if (!fs.existsSync(ROBLOX_ROLES_FILE)) saveRobloxRoles({})
  if (!fs.existsSync(ROLE_PERMS_FILE)) saveRolePerms([])
  if (!fs.existsSync(RAID_REVIEW_FILE)) saveRaidReview({})
  if (!fs.existsSync(TICKETS_FILE)) saveTickets({})
  if (!fs.existsSync(TICKET_SUPPORT_FILE)) saveTicketSupport([])
  if (!fs.existsSync(TAG_LOG_FILE)) saveTagLog([])
})()

const getPrefix = () => loadConfig().prefix || '.'

// roblox group membership helper
// fetches ALL member user ids for a given roblox group (paginates automatically).
// returns a set<string of roblox user ids that belong to the group.
async function fetchGroupMemberIds(groupId) {
  const memberIds = new Set();
  let cursor = '';
  do {
    try {
      const url = `https://groups.roblox.com/v1/groups/${groupId}/users?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      for (const entry of (json.data || [])) {
        if (entry?.user?.userId) memberIds.add(String(entry.user.userId));
      }
      cursor = json.nextPageCursor || '';
    } catch { break; }
  } while (cursor);
  return memberIds;
}

// checks a single user's group membership directly much more reliable than
// fetching the full member list, especially for large groups.
async function isUserInGroup(robloxId, groupId) {
  try {
    const res = await fetch(`https://groups.roblox.com/v1/users/${robloxId}/groups/roles`);
    if (!res.ok) return false;
    const json = await res.json();
    return (json.data || []).some(g => String(g.group?.id) === String(groupId));
  } catch { return false; }
}
const ATTEND_GROUP_ID = '489845165';

// OCR based username extraction (no API key required)
// uses sharp for image preprocessing and tesseract.js for OCR to extract
// roblox usernames from player list panels. no AI key needed.
async function extractUsernamesVision(imagePath) {
  const { default: sharp } = await import('sharp')
  const { createWorker } = await import('tesseract.js')
  const { join } = await import('path')
  const { tmpdir } = await import('os')

  const meta = await sharp(imagePath).metadata()
  const { width = 1920, height = 1080 } = meta

  function parseUsername(raw) {
    const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, '').trim()
    if (
      cleaned.length >= 3 &&
      cleaned.length <= 20 &&
      /^[a-zA-Z0-9]/.test(cleaned) &&
      /[a-zA-Z0-9]$/.test(cleaned)
    ) return cleaned
    return null
  }

  const SKIP_WORDS = new Set([
    'CURRENT','LEAVE','LEADERBOARD','PLAYERS','SERVER','GAME','REPORT',
    'FRIEND','FOLLOW','BLOCK','MENU','TEAM','SPECTATE','SCORE','RANK',
    'PING','FPS','RESUME','RESET','SETTINGS','HELP','CHAT','INVENTORY',
    'SHOP','STORE','TRADES','PROFILE','HOME','BACK','CLOSE','EXIT',
    'ONLINE','OFFLINE','INGAME','LEADER','BOARD',
  ])

  const nameSet = new Set()
  const allTmpFiles = []

  // PSM 7 = treat the image as a single line of text perfect for one username per strip
  // PSM 8 = treat the image as a single word even tighter focus
  const workers = await Promise.all([
    createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} }),
    createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} }),
  ])
  const CHAR_WL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '
  await workers[0].setParameters({ tessedit_char_whitelist: CHAR_WL, preserve_interword_spaces: '0', tessedit_pageseg_mode: '7' })
  await workers[1].setParameters({ tessedit_char_whitelist: CHAR_WL, preserve_interword_spaces: '0', tessedit_pageseg_mode: '8' })

  async function ocrBuf(buf, tag) {
    const p = join(tmpdir(), `ocr ${tag} ${Date.now()}.png`)
    allTmpFiles.push(p)
    await sharp(buf).png().toFile(p)
    const [r0, r1] = await Promise.all([
      workers[0].recognize(p),
      workers[1].recognize(p),
    ])
    for (const text of [r0.data.text, r1.data.text]) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        for (const token of [trimmed, ...trimmed.split(/\s+/)]) {
          const name = parseUsername(token)
          if (name && !SKIP_WORDS.has(name.toUpperCase())) nameSet.add(name)
        }
      }
    }
  }

  // STRATEGY 1: horizontal strip scan
  // the roblox player list shows ~3 users at a time, each in their own row.
  // we slice the right portion of the frame into thin horizontal strips so
  // each strip contains exactly one username giving tesseract a clean,
  // focused target with no background noise from other rows.
  
  // strip layout:
  // horizontal position: right 55% of frame (where the player list lives)
  // then skip the leftmost 25% of THAT region (the avatar) so we read
  // only the text portion of each row.
  // 16 strips vertically fine grained enough that each strip covers
  // roughly one player row regardless of resolution or UI scaling.
  // each strip is also overlapped 50% with the next so a name that falls
  // on a strip boundary is still caught by the overlapping strip.

  const PANEL_LEFT  = Math.floor(width * 0.45)   // where the player list panel starts
  const PANEL_W     = width - PANEL_LEFT           // width of panel region
  const AVATAR_SKIP = Math.floor(PANEL_W * 0.28)  // skip avatar on left of each row
  const TEXT_LEFT   = PANEL_LEFT + AVATAR_SKIP
  const TEXT_W      = PANEL_W - AVATAR_SKIP

  const NUM_STRIPS  = 16
  const STRIP_H     = Math.floor(height / NUM_STRIPS)
  const OVERLAP     = Math.floor(STRIP_H * 0.5)   // 50% overlap between strips

  // preprocess the text column once (invert for white on dark roblox UI)
  const textColBuf = await sharp(imagePath)
    .extract({ left: TEXT_LEFT, top: 0, width: TEXT_W, height })
    .greyscale().normalise().negate().toBuffer()

  for (let s = 0; s < NUM_STRIPS; s++) {
    const top = Math.max(0, s * STRIP_H - OVERLAP)
    const bot = Math.min(height, (s + 1) * STRIP_H + OVERLAP)
    const stripH = bot - top
    if (stripH < 8) continue

    // try two threshold levels per strip: catches both dim and bright text
    for (const thresh of [110, 160]) {
      const stripBuf = await sharp(textColBuf)
        .extract({ left: 0, top, width: TEXT_W, height: stripH })
        .threshold(thresh)
        .toBuffer()
      await ocrBuf(stripBuf, `strip ${s} t${thresh}`)
    }
  }

  // STRATEGY 2: full right panel scan (fallback)
  // scans the whole right panel at once catches any name the strip scan
  // misses if the player list is positioned differently from expectations.
  // uses PSM 6 (block of text) which is best for multi line lists.
  const fullWorker = await createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} })
  await fullWorker.setParameters({ tessedit_char_whitelist: CHAR_WL, preserve_interword_spaces: '0', tessedit_pageseg_mode: '6' })

  try {
    for (const panelLeft of [Math.floor(width * 0.45), Math.floor(width * 0.30)]) {
      const panelW = width - panelLeft
      const panelBuf = await sharp(imagePath)
        .extract({ left: panelLeft, top: 0, width: panelW, height })
        .greyscale().normalise().negate().toBuffer()

      for (const thresh of [110, 160]) {
        const p = join(tmpdir(), `ocr full ${panelLeft} t${thresh} ${Date.now()}.png`)
        allTmpFiles.push(p)
        await sharp(panelBuf).threshold(thresh).png().toFile(p)
        const { data: { text } } = await fullWorker.recognize(p)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          for (const token of [trimmed, ...trimmed.split(/\s+/)]) {
            const name = parseUsername(token)
            if (name && !SKIP_WORDS.has(name.toUpperCase())) nameSet.add(name)
          }
        }
      }
    }
  } finally {
    await fullWorker.terminate()
    await Promise.all(workers.map(w => w.terminate()))
    for (const f of allTmpFiles) { try { fs.unlinkSync(f) } catch {} }
  }

  return [...nameSet]
}

// raid stats helpers
// EST timestamp formatter: "04/06/2026 at 05:23 PM (EST)"
function formatEstTime(ts) {
  const d = new Date(ts)
  const opts = { timeZone: 'America/New York', month: '2 digit', day: '2 digit', year: 'numeric',
    hour: '2 digit', minute: '2 digit', hour12: true }
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d)
  const get = t => parts.find(p => p.type === t)?.value ?? ''
  return `${get('month')}/${get('day')}/${get('year')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} (EST)`
}

// returns "x days ago" / "today" based on timestamp vs now
function daysAgoStr(ts) {
  const diff = Math.floor((Date.now() - ts) / 86400000)
  return diff === 0 ? '0 days ago' : diff === 1 ? '1 day ago' : `${diff} days ago`
}

// increments a discord user's raid stats (points +1, totalraids +1, lastraid = now)
function addRaidStat(guildId, discordId) {
  if (!guildId || !discordId) return
  const stats = loadRaidStats()
  if (!stats[guildId]) stats[guildId] = {}
  const user = stats[guildId][discordId] || { raidPoints: 0, totalRaids: 0, lastRaid: null }
  user.raidPoints  += 1
  user.totalRaids  += 1
  user.lastRaid     = Date.now()
  stats[guildId][discordId] = user
  saveRaidStats(stats)
}

// adds just raid points (for reaction based queue points) without incrementing totalraids
function addRaidPoints(guildId, discordId, amount = 1) {
  if (!guildId || !discordId) return
  const stats = loadRaidStats()
  if (!stats[guildId]) stats[guildId] = {}
  const user = stats[guildId][discordId] || { raidPoints: 0, totalRaids: 0, lastRaid: null }
  user.raidPoints += amount
  stats[guildId][discordId] = user
  saveRaidStats(stats)
}

// shared scan runner used by both slash and prefix scan commands.
// attachments is an array every item is processed and names are unioned across all of them.
// editfn(descriptiontext) updates the status message shown to the user.
async function runScanCommand(attachments, guild, qCh, ulCh, editFn) {
  if (!Array.isArray(attachments)) attachments = [attachments]
  attachments = attachments.filter(Boolean)
  const { tmpdir } = await import('os')
  const { extname: _ext, join } = await import('path')
  const { spawnSync } = await import('child process')

  // resolve ffmpeg binary: prefer system ffmpeg, fall back to bundled ffmpeg static
  let ffmpegBin = 'ffmpeg'
  try {
    const { default: ffmpegStatic } = await import('ffmpeg static')
    const sysCheck = spawnSync('ffmpeg', [' version'], { stdio: 'ignore' })
    if (sysCheck.error) ffmpegBin = ffmpegStatic
  } catch {}

  // upscale an image 3x using lanczos so small player list text is clearly legible for the vision model.
  // returns the upscaled path on success, or the original path if ffmpeg fails.
  function upscaleImage(srcPath) {
    const dest = srcPath.replace(/\.[^.]+$/, ' up.png')
    spawnSync(ffmpegBin, [' i', srcPath, ' vf', 'scale=iw*3:ih*3:flags=lanczos', dest, ' y'], { stdio: 'ignore' })
    return fs.existsSync(dest) ? dest : srcPath
  }

  const globalNameSet = new Set()
  const allTmpFiles = []

  for (let aIdx = 0; aIdx < attachments.length; aIdx++) {
    const attachment = attachments[aIdx]
    const label = attachments.length > 1 ? ` (file ${aIdx + 1}/${attachments.length})` : ''

    const ext = _ext(attachment.name || '').toLowerCase() || '.png'
    const isVideo = ['.mp4', '.mov', '.webm', '.avi', '.mkv'].includes(ext)
    const tmpInput = join(tmpdir(), `scan ${Date.now()} ${aIdx}${ext}`)
    allTmpFiles.push(tmpInput)

    const dlRes = await fetch(attachment.url)
    fs.writeFileSync(tmpInput, Buffer.from(await dlRes.arrayBuffer()))

    if (isVideo) {
      // extract frames at 4fps (every 0.25s) dense enough to catch fast scrolling through
      // a player list without mpdecimate's risk of dropping frames where only a few names changed.
      // cap at 120 frames = covers 30 seconds of recording at full resolution.
      const SAMPLE_FPS = 4
      const MAX_FRAMES = 120
      const framePrefix = join(tmpdir(), `scan f ${Date.now()} ${aIdx} `)
      const framePat = `${framePrefix}%05d.png`
      await editFn(`extracting frames from video${label}...`)
      spawnSync(ffmpegBin, [
        ' i', tmpInput,
        ' vf', `fps=${SAMPLE_FPS}`,
        framePat, ' y'
      ], { stdio: 'ignore' })

      // collect all frames that ffmpeg produced
      let rawFrames = []
      for (let n = 1; ; n++) {
        const fp = `${framePrefix}${String(n).padStart(5, '0')}.png`
        if (!fs.existsSync(fp)) break
        rawFrames.push(fp)
      }

      // if the video is very long, evenly subsample down to MAX FRAMES
      if (rawFrames.length > MAX_FRAMES) {
        const step = rawFrames.length / MAX_FRAMES
        rawFrames = Array.from({ length: MAX_FRAMES }, (_, i) => rawFrames[Math.round(i * step)])
      }

      if (!rawFrames.length) throw new Error(`could not extract frames from video ${aIdx + 1} make sure it is a valid mp4/mov file`)

      await editFn(`video${label}: scanning **${rawFrames.length}** frame${rawFrames.length !== 1 ? 's' : ''}...`)

      // upscale each frame 3x for the vision model, register every file for cleanup
      const frameFiles = []
      for (const fp of rawFrames) {
        allTmpFiles.push(fp)
        const upscaled = upscaleImage(fp)
        if (upscaled !== fp) allTmpFiles.push(upscaled)
        frameFiles.push(upscaled)
      }

      // one OCR pass per frame OCR is deterministic so repeating gives the same result
      let lastErr = null
      for (let i = 0; i < frameFiles.length; i++) {
        await editFn(`scanning video${label} frame ${i + 1}/${frameFiles.length}...`)
        try {
          const names = await extractUsernamesVision(frameFiles[i])
          for (const n of names) globalNameSet.add(n)
        } catch (e) {
          lastErr = e
        }
      }
      if (globalNameSet.size === 0 && lastErr) throw lastErr

    } else {
      // upscale the image 3x before scanning so small player list text is readable without manual zoom
      await editFn(`reading image${label}...`)
      const upscaled = upscaleImage(tmpInput)
      if (upscaled !== tmpInput) allTmpFiles.push(upscaled)
      const names = await extractUsernamesVision(upscaled)
      for (const n of names) globalNameSet.add(n)
    }
  }

  for (const f of allTmpFiles) { try { fs.unlinkSync(f) } catch {} }

  const allNames = [...globalNameSet]
  if (!allNames.length) throw new Error("couldn't find any usernames make sure the player list is clearly visible")

  await editFn(`found **${allNames.length}** name${allNames.length !== 1 ? 's' : ''}, verifying on Roblox...`)

  const verifiedUsers = []
  for (let i = 0; i < allNames.length; i += 100) {
    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: allNames.slice(i, i + 100), excludeBannedUsers: false })
      })).json()
      if (res.data) verifiedUsers.push(...res.data)
    } catch {}
  }

  if (!verifiedUsers.length) throw new Error("none of the detected names matched real Roblox users try a clearer image")

  const vData = loadVerify()
  const registeredMembers = verifiedUsers.filter(u => vData.robloxToDiscord?.[String(u.id)])
  const unregisteredCandidates = verifiedUsers.filter(u => !vData.robloxToDiscord?.[String(u.id)])

  if (!verifiedUsers.length) {
    return `scan complete no Roblox users detected`
  }

  // filter unregistered users to only those who are in the group
  await editFn(`checking group membership for ${unregisteredCandidates.length} unregistered user${unregisteredCandidates.length !== 1 ? 's' : ''}...`)
  const groupMembers = await fetchGroupMemberIds(ATTEND_GROUP_ID)
  const unregisteredMembers = unregisteredCandidates.filter(u => groupMembers.has(String(u.id)))

  const totalToLog = registeredMembers.length + unregisteredMembers.length
  await editFn(`**${totalToLog}** member${totalToLog !== 1 ? 's' : ''} found (${registeredMembers.length} registered, ${unregisteredMembers.length} unregistered in group), logging attendance...`)

  let posted = 0

  for (const robloxUser of registeredMembers) {
    const discordId = vData.robloxToDiscord?.[String(robloxUser.id)]
    if (!discordId) continue
    let avatarUrl = null
    try {
      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json()
      avatarUrl = avatarData.data?.[0]?.imageUrl ?? null
    } catch {}
    const attendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid').setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Discord', value: `<@${discordId}> `, inline: false }, { name: 'Roblox', value: `\`${robloxUser.name}\``, inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() })
    if (avatarUrl) attendEmbed.setThumbnail(avatarUrl)
    await qCh.send({ embeds: [attendEmbed] })
    addRaidStat(guild.id, discordId)
    posted++
    await new Promise(r => setTimeout(r, 300))
  }

  for (const robloxUser of unregisteredMembers) {
    let avatarUrl = null
    try {
      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json()
      avatarUrl = avatarData.data?.[0]?.imageUrl ?? null
    } catch {}
    const unregEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('unregistered user joined this raid').setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Roblox', value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: false }, { name: 'Status', value: 'not mverify\'d', inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() })
    if (avatarUrl) unregEmbed.setThumbnail(avatarUrl)
    await qCh.send({ embeds: [unregEmbed] })
    posted++
    await new Promise(r => setTimeout(r, 300))
  }

  return `scan complete logged **${posted}** member${posted !== 1 ? 's' : ''} to ${qCh} (${registeredMembers.length} registered, ${unregisteredMembers.length} unregistered in group)`
}

// API based group scan
// takes a roblox game URL / place ID, finds every member of group 206868002
// currently in that game, then posts attendance embeds no image needed.
const GSCAN_GROUP_ID = 206868002

async function runGroupScanCommand(input, guild, qCh, ulCh, editFn) {
  let placeId = null
  let serverInstanceId = null
  let displayLabel = input

  // check if input is a server invite link containing gameinstanceid
  // format: roblox.com/games/start?placeid=x&gameinstanceid=y
  const instanceMatch = input.match(/gameInstanceId=([a-f0-9-]+)/i)
  const placeFromLink = input.match(/[?&]placeId=(\d+)/i) || input.match(/roblox\.com\/games\/(\d+)/i)

  if (instanceMatch) {
    // direct server link skip presence API entirely
    serverInstanceId = instanceMatch[1]
    placeId = placeFromLink?.[1]
    if (!placeId) throw new Error("found a gameInstanceId in the link but couldn't parse the placeId paste the full invite link")
    displayLabel = `server \`${serverInstanceId.slice(0, 8)}...\``
    await editFn(`server link detected, resolving game...`)
  } else {
    // treat input as a roblox username and use the presence API
    const robloxUsername = input.trim()
    await editFn(`looking up **${robloxUsername}** on Roblox...`)
    const userLookup = await (await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false })
    })).json()
    const targetUser = userLookup.data?.[0]
    if (!targetUser) throw new Error(`couldn't find Roblox user **${robloxUsername}**`)

    // the cookie is required for the API to return gameid reliably even on public profiles
    await editFn(`found **${targetUser.name}**, checking their presence...`)
    const cookie = process.env.ROBLOX_COOKIE
    const presenceHeaders = { 'Content-Type': 'application/json' }
    if (cookie) presenceHeaders['Cookie'] = `.ROBLOSECURITY=${cookie}`
    const presenceRes = await (await fetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST', headers: presenceHeaders,
      body: JSON.stringify({ userIds: [targetUser.id] })
    })).json()
    const presence = presenceRes.userPresences?.[0]
    // userpresencetype: 0=offline, 1=online, 2=ingame, 3=instudio
    if (!presence || presence.userPresenceType !== 2) {
      const type = presence?.userPresenceType ?? 'unknown'
      throw new Error(`**${targetUser.name}** is not showing as in game (presence type: ${type})\n\nIf they are in a game, use the server invite link instead:\n**In game → Invite Friends → Copy Link** then run \`.ingame <paste link \``)
    }
    if (!presence.placeId) throw new Error(`**${targetUser.name}** is in a game but the place ID is unavailable`)
    if (!presence.gameId) throw new Error(`**${targetUser.name}** is in a game but the server ID is hidden\n\nUse the server invite link instead: **In game → Invite Friends → Copy Link** then run \`.ingame <paste link \``)

    placeId = presence.placeId
    serverInstanceId = presence.gameId
    displayLabel = `**${targetUser.name}**'s server`
  }

  // step 3: resolve place ID → universe ID + game name
  const placeDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`)).json()
  const universeId = placeDetail?.data?.[0]?.universeId
  if (!universeId) throw new Error(`couldn't resolve game for place ID \`${placeId}\``)

  let gameName = `Place ${placeId}`
  try {
    const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json()
    if (gr?.data?.[0]?.name) gameName = gr.data[0].name
  } catch {}

  await editFn(`**${targetUser.name}** is in **${gameName}** finding their server...`)

  // step 4: page through public servers until we find the one matching the instance ID
  let serverTokens = []
  let sCur = ''; let found = false
  do {
    try {
      const res = await (await fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100${sCur ? `&cursor=${sCur}` : ''}`)).json()
      for (const srv of (res.data || [])) {
        if (srv.id === serverInstanceId) {
          serverTokens = (srv.players || []).map(p => p.playerToken).filter(Boolean)
          found = true
          break
        }
      }
      sCur = found ? '' : (res.nextPageCursor || '')
    } catch { sCur = ''; break }
  } while (sCur && !found)

  if (!found || !serverTokens.length) throw new Error(`found the game but couldn't locate the specific server it may be private or the server list may not have updated yet`)

  // step 5: resolve player tokens → roblox user ids
  await editFn(`found the server (${serverTokens.length} player${serverTokens.length !== 1 ? 's' : ''}), loading group members...`)
  const resolvedIds = new Set()
  for (let i = 0; i < serverTokens.length; i += 100) {
    try {
      const batch = serverTokens.slice(i, i + 100).map((token, idx) => ({
        requestId: `${i + idx}`, token, type: 'AvatarHeadShot', size: '150x150', format: 'png', isCircular: false
      }))
      const res = await (await fetch('https://thumbnails.roblox.com/v1/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch)
      })).json()
      for (const item of (res.data || [])) { if (item.targetId && item.targetId !== 0) resolvedIds.add(item.targetId) }
    } catch {}
  }

  // step 6: load group members and filter to those in the server
  const memberIds = new Set()
  const memberNames = {}
  let cur = ''
  do {
    try {
      const res = await (await fetch(`https://members.roblox.com/v1/groups/${GSCAN_GROUP_ID}/users?limit=100&sortOrder=Asc${cur ? `&cursor=${cur}` : ''}`)).json()
      for (const m of (res.data || [])) {
        memberIds.add(m.user.userId)
        memberNames[m.user.userId] = m.user.username
      }
      cur = res.nextPageCursor || ''
    } catch { cur = ''; break }
  } while (cur)
  if (!memberIds.size) throw new Error('could not load group members Roblox API may be unavailable')

  const inServer = [...resolvedIds].filter(id => memberIds.has(id))
  if (!inServer.length) throw new Error(`no group members found in ${displayLabel} in **${gameName}** (${resolvedIds.size} total players checked)`)

  await editFn(`found **${inServer.length}** group member${inServer.length !== 1 ? 's' : ''} in ${displayLabel}, looking up Discord accounts...`)

  // post attendance embeds only registered (mverify'd) members
  const localVerify = loadVerify()
  let posted = 0
  for (const robloxId of inServer) {
    const robloxName = memberNames[robloxId] || String(robloxId)
    const discordId = localVerify.robloxToDiscord?.[String(robloxId)]
    if (!discordId) continue

    let avatarUrl = null
    try {
      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`)).json()
      avatarUrl = avatarData.data?.[0]?.imageUrl ?? null
    } catch {}

    const attendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
      .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Discord', value: `<@${discordId}> `, inline: false }, { name: 'Roblox', value: `\`${robloxName}\``, inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() })
    if (avatarUrl) attendEmbed.setThumbnail(avatarUrl)
    await qCh.send({ embeds: [attendEmbed] })
    addRaidStat(guild.id, discordId)
    posted++
    await new Promise(r => setTimeout(r, 300))
  }

  return `scan complete **${inServer.length}** group member${inServer.length !== 1 ? 's' : ''} in ${displayLabel} in **${gameName}**, logged **${posted}** registered members`
}

// sends a log embed to the log channel if one is set
async function sendLog(guild, embed) {
  const cfg = loadConfig()
  if (!cfg.logChannelId) return
  try {
    const ch = await guild.channels.fetch(cfg.logChannelId)
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] })
  } catch (err) {
    console.error('log channel error:', err.message)
  }
}

// sends a log embed to the dedicated strip log channel if one is set, else falls back to main log
async function sendStripLog(guild, embed) {
  const cfg = loadConfig()
  const channelId = cfg.stripLogChannelId || cfg.logChannelId
  if (!channelId) return
  try {
    const ch = await guild.channels.fetch(channelId)
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] })
  } catch (err) {
    console.error('strip log channel error:', err.message)
  }
}

// roblox ranking
async function rankRobloxUser(robloxUsername, roleId) {
  const cookie  = process.env.ROBLOX_COOKIE;
  const groupId = process.env.ROBLOX_GROUP_ID;
  if (!cookie || !groupId) throw new Error('ROBLOX COOKIE or ROBLOX GROUP ID is not configured.');

  const lookupRes  = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false })
  });
  const userBasic = (await lookupRes.json()).data?.[0];
  if (!userBasic) throw new Error(`Roblox user "${robloxUsername}" not found.`);
  const userId = userBasic.id;

  const memberData = await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json();
  if (!memberData.data?.some(g => String(g.group.id) === String(groupId)))
    throw new Error(`**${userBasic.name}** isn't in the group (ID: ${groupId}). They need to join first.`);

  const csrfRes   = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` }
  });
  const csrfToken = csrfRes.headers.get('x-csrf-token');
  if (!csrfToken) throw new Error('Could not get CSRF token. Check your ROBLOX COOKIE.');

  const rankRes = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken },
    body: JSON.stringify({ roleId: Number(roleId) })
  });
  if (!rankRes.ok) {
    const errData = await rankRes.json().catch(() => ({}));
    const code = errData.errors?.[0]?.code;
    const msg  = errData.errors?.[0]?.message ?? `HTTP ${rankRes.status}`;
    if (code === 4) throw new Error(`Bot doesn't have permission to rank this user.`);
    if (code === 2) throw new Error(`Role ID \`${roleId}\` doesn't exist.`);
    throw new Error(`Ranking failed: ${msg}`);
  }

  const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json();
  return { userId, displayName: userBasic.name, avatarUrl: avatarData.data?.[0]?.imageUrl ?? null };
}

async function acceptRobloxJoinRequest(robloxUserId, groupId) {
  const cookie = process.env.ROBLOX_COOKIE;
  if (!cookie) throw new Error('ROBLOX COOKIE is not configured on the bot');
  if (!groupId) throw new Error('no roblox group id is configured (use `.rg <link `)');
  const csrfRes = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` }
  });
  const csrfToken = csrfRes.headers.get('x-csrf-token');
  if (!csrfToken) throw new Error('could not get CSRF token check ROBLOX COOKIE');
  const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/join-requests/users/${robloxUserId}`, {
    method: 'POST',
    headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const code = err.errors?.[0]?.code;
    const msg = err.errors?.[0]?.message || `HTTP ${res.status}`;
    if (code === 4) throw new Error(`bot account doesn't have permission to accept join requests in this group`);
    if (res.status === 404) throw new Error(`no pending join request found for that user in group ${groupId}`);
    throw new Error(msg);
  }
}

async function buildJoinButton(userId) {
  try {
    const cookie = process.env.ROBLOX_COOKIE;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = `.ROBLOSECURITY=${cookie}`;
    const presData = await (await fetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST', headers, body: JSON.stringify({ userIds: [userId] })
    })).json();
    const p = presData.userPresences?.[0];
    if (p?.userPresenceType === 2 && p.placeId && p.gameId) {
      const joinUrl = `https://www.roblox.com/games/start?placeId=${p.placeId}&gameInstanceId=${p.gameId}`;
      return new ButtonBuilder().setLabel('JOIN').setStyle(ButtonStyle.Link).setURL(joinUrl);
    }
  } catch {}
  return new ButtonBuilder().setLabel('Not In Game').setStyle(ButtonStyle.Secondary).setCustomId('noop notingame').setDisabled(true);
}

// jail helpers
async function jailMember(guild, member, reason, modTag) {
  const jailData = loadJail();
  if (!jailData[guild.id]) jailData[guild.id] = {};
  if (jailData[guild.id][member.id]) throw new Error(`**${member.user.tag}** is already jailed`);

  let jailChannel = guild.channels.cache.find(c => c.name === 'jail' && c.isTextBased());
  if (!jailChannel) {
    jailChannel = await guild.channels.create({
      name: 'jail', type: ChannelType.GuildText,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] }]
    });
  }
  await jailChannel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true });

  const deniedChannels = [];
  for (const [, ch] of guild.channels.cache) {
    if (!ch.isTextBased() && ch.type !== ChannelType.GuildAnnouncement) continue;
    if (ch.id === jailChannel.id) continue;
    if (ch.permissionOverwrites.cache.get(member.id)?.deny.has(PermissionsBitField.Flags.ViewChannel)) continue;
    try { await ch.permissionOverwrites.edit(member.id, { ViewChannel: false }); deniedChannels.push(ch.id); } catch {}
  }

  jailData[guild.id][member.id] = { jailChannelId: jailChannel.id, deniedChannels };
  saveJail(jailData);
  return baseEmbed().setTitle('jailed').setColor(0x2C2F33).setThumbnail(member.user.displayAvatarURL())
    .addFields({ name: 'user', value: member.user.tag, inline: true }, { name: 'mod', value: modTag, inline: true }, { name: 'reason', value: reason })
    .setDescription(`they can only see ${jailChannel}`).setTimestamp();
}

async function unjailMember(guild, member, modTag) {
  const jailData = loadJail();
  const entry = jailData[guild.id]?.[member.id];
  if (!entry) throw new Error(`**${member.user.tag}** isn't jailed`);
  for (const chId of entry.deniedChannels) {
    try { const ch = guild.channels.cache.get(chId); if (ch) await ch.permissionOverwrites.delete(member.id); } catch {}
  }
  try { const jailCh = guild.channels.cache.get(entry.jailChannelId); if (jailCh) await jailCh.permissionOverwrites.delete(member.id); } catch {}
  delete jailData[guild.id][member.id];
  saveJail(jailData);
  return baseEmbed().setTitle('unjailed').setColor(0x2C2F33).setThumbnail(member.user.displayAvatarURL())
    .addFields({ name: 'user', value: member.user.tag, inline: true }, { name: 'mod', value: modTag, inline: true }).setTimestamp();
}

// help pages
// note: the "unwhitelisted" page was removed because unwhitelisted users no longer
// have access to .help / /help only `roblox` and `register` work for them silently.
//
// the help system is now organized into named categories. each page shows
// up to HELP_PER_PAGE commands from a single category, with the category
// name shown in the embed title and footer. categories with more commands
// than HELP_PER_PAGE simply span multiple pages.
const HELP_CATEGORIES = [
  { name: 'Moderation', cmds: [
    "{p}ban [user] [reason] bans someone from the server (mention or ID)",
    "{p}unban [id] [reason] unbans someone by their ID",
    "{p}hb [user] [reason] hardbans so they can't rejoin even after unban",
    "{p}unhb [id] [reason] removes a hardban",
    "{p}kick [user] [reason] boots them from the server",
    "{p}mute [user] [reason] mutes them everywhere",
    "{p}unmute [user] gives them their voice back",
    "{p}timeout [user] [mins] [reason] puts them in a timeout",
    "{p}untimeout [user] ends the timeout early",
    "{p}tempban [user] [duration] [reason] bans for a set time",
    "{p}tempmute [user] [duration] [reason] mutes for a set time",
    "{p}softban [user] [reason] ban + unban (clears their messages)",
    "{p}warn [user] [reason] gives them a warning",
    "{p}warns [user] check someone's warning history",
    "{p}clearwarns [user] wipes all their warns",
    "{p}delwarn [user] [#] deletes one specific warn",
    "{p}jail [user] [reason] jails them — only the jail channel for them",
    "{p}unjail [user] lets them out of jail",
    "{p}hush [user] auto-deletes everything they post",
    "{p}unhush [user] stops the auto-delete",
    "{p}cases [user] list mod cases for someone",
    "{p}case [#] view a single mod case",
    "{p}delcase [#] delete a mod case",
    "{p}softban [user] [reason] ban + instant unban (clears their messages)",
    "{p}tempmute [user] [duration] mute someone for a set time",
    "{p}tempban [user] [duration] [reason] ban someone temporarily",
    "{p}massban [id1 id2...] [reason] ban a bunch of users at once",
    "{p}slowmode [seconds | off] set channel slowmode",
    "{p}note [user] [text] leave a staff note on someone",
    "{p}notes [user] view all notes on someone",
    "{p}dm [user] [message] send a DM to a user as the bot",
  ]},
  { name: 'Channels', cmds: [
    "{p}lock locks the channel so no one can talk",
    "{p}unlock opens the channel back up",
    "{p}nuke deletes and recreates this channel (wipes everything)",
    "{p}slowmode [seconds | off] sets channel slowmode",
    "{p}snipe shows the last deleted message here",
    "{p}autopurge [#channel] [seconds | off] auto-delete old messages",
  ]},
  { name: 'Purges', cmds: [
    "{p}purge [amount] deletes a bunch of messages at once",
    "{p}purgebot [n] only deletes bot messages",
    "{p}purgeuser [user] [n] deletes a specific user's messages",
    "{p}purgematch [text] [n] deletes messages containing certain text",
    "{p}purgelinks [n] deletes recent messages with links",
    "{p}purgeimages [n] deletes recent messages with images",
  ]},
  { name: 'Tickets', cmds: [
    "{p}setuptickets [channel] [type] sends a ticket panel — type is verification, tag, or both (default both)",
    "{p}closeticket closes the current ticket channel",
    "{p}ticket supportroles add/remove/list manage who can see tickets",
  ]},
  { name: 'Roblox', cmds: [
    "{p}roblox [username] look up a roblox user",
    "{p}rid [id] look up a roblox user by their numeric ID",
    "{p}gc [username] list a user's roblox groups",
    "{p}rg [link/id] change the bot's tracked roblox group",
    "{p}cookie [value] set the .ROBLOSECURITY cookie (owner only)",
    "{p}group view or edit group config",
    "{p}flag [id] flag a roblox group",
    "{p}unflag [id] unflag a roblox group",
    "{p}flagged list flagged groups",
    "{p}grouproles list roles in the current group",
    "{p}whoisin [game URL/place id] who from the group is in this game",
  ]},
  { name: 'Roles & Tags', cmds: [
    "{p}role [user] [role] set a roblox group role on someone",
    "{p}setrole [name] [id] register a group role by name",
    "{p}setroleperms add/remove/list let a discord role use {p}role",
    "{p}rom @role / add / remove / list register management roles",
    "{p}rmanager @role one-shot toggle a management role",
    "{p}r [member] [roles...] toggle discord roles on someone",
    "{p}tag [user] [role] same as {p}role but logged to the tag channel",
    "{p}taglog [#] view recent tag log entries",
    "{p}inrole [role] list members with a role",
    "{p}give1 give the bot and you the highest role possible",
  ]},
  { name: 'Reaction Roles', cmds: [
    "{p}rradd [msgid] [emoji] @role add a reaction role",
    "{p}rrremove [msgid] [emoji] remove a reaction role",
    "{p}rrlist [msgid] list reaction roles on a message",
    "{p}rrclear [msgid] clear all reaction roles on a message",
    "{p}rrpost [#channel] [text] post a base message for reaction roles",
  ]},
  { name: 'Verification', cmds: [
    "{p}register start the verification flow",
    "{p}pregister pre-register someone (whitelist only)",
    "{p}verify finish verification",
    "{p}registeredlist see who's verified",
    "{p}linked list every roblox-discord link",
    "{p}setverifyrole [role] role given when someone verifies",
  ]},
  { name: 'Raids & Activity', cmds: [
    "{p}rollcall start a rollcall (members react to confirm they're in)",
    "{p}endrollcall close the rollcall and log everyone",
    "{p}setrollcallchannel [channel] where the rollcall summary posts",
    "{p}lb show the raid points leaderboard (10 per page)",
    "{p}lbreset wipe the raid leaderboard for this server",
    "{p}atlog browse past rollcall sessions",
    "{p}setupraidpoints drop the \"get raid point\" button panel",
    "{p}setraidreview [#channel] where raid point requests get sent for review",
  ]},
  { name: 'Whitelist & Owners', cmds: [
    "{p}whitelist add/remove/list/check manage the whitelist",
    "{p}wlmanager add/remove/list manage whitelist managers",
    "{p}tempowner [user] grant temp owner access",
    "{p}untempowner [user] revoke temp owner",
    "{p}permcheck [user] show what bot-level roles a user has",
    "{p}joinserver [invite] one-click link to add the bot to that server",
    "{p}leaveserver [server id] make the bot leave a server",
    "{p}servers list every server the bot is in",
    "{p}invite get the bot invite link (whitelist only)",
  ]},
  { name: 'Bot Settings', cmds: [
    "{p}prefix [new] view or change the bot prefix",
    "{p}name [text] change bot display name in embeds",
    "{p}logo [url] change the embed logo",
    "{p}status [type] [text] change bot activity status",
    "{p}presence [state] online / idle / dnd / invisible",
    "{p}vanityset [vanity] [role] tie a vanity status to a role",
    "{p}setlogchannel [channel] set the action log channel",
    "{p}setlogchanneltag [channel] set the tag log channel",
    "{p}logstatus show the current log channel setting",
    "{p}restore (attach .backup zip) restore state files from a backup",
  ]},
  { name: 'Auto-roles & Anti-spam', cmds: [
    "{p}autorole @role / off / status auto-give a role to people who join",
    "{p}setautoroleage [days] require accounts to be N days old before autorole",
    "{p}antinuke status / enable / disable / punishment / logs / whitelist / threshold configure antinuke",
    "{p}antimention on / off / status [threshold] auto-warn on mass mentions",
    "{p}antiemoji on / off / status [threshold] auto-delete emoji spam",
    "{p}capslimit on / off / status [threshold] delete CAPS-spam messages",
    "{p}raidmode on / off / status enable a heavy slowmode raid mode",
    "{p}blacklistword add / remove / list manage blacklisted words",
  ]},
  { name: 'Stats', cmds: [
    "{p}invitelb top inviters leaderboard",
  ]},
  { name: 'Nicknames', cmds: [
    "{p}nick [user] [name] change someone's nickname",
    "{p}resetnick [user] reset their nickname",
    "{p}nickall [prefix] add a prefix to every member's nickname",
  ]},
  { name: 'Rank Ladder', cmds: [
    "{p}rankup [user] [levels] rank a member up the configured ladder",
    "{p}setrankroles set / list / clear configure the rank ladder",
    "{p}fileroles download the rank ladder as a JSON file",
  ]},
  { name: 'Fun & Utility', cmds: [
    "{p}say [text] make the bot say something",
    "{p}flip flip a coin",
    "{p}choose opt1, opt2, opt3 ... pick a random option",
  ]},
  { name: 'Help', cmds: [
    "{p}help show this menu (you're already here!)",
  ]},
];

// kept for back-compat with anything still reading HELP_COMMANDS as a flat list.
const HELP_COMMANDS = HELP_CATEGORIES.flatMap(c => c.cmds);

// flatten categories into ordered pages. each page belongs to ONE category and
// lists up to HELP_PER_PAGE commands from that category.
const HELP_PAGES = [];
// CATEGORY_FIRST_PAGE[i] = page index where category i starts. used by the
// dropdown so picking a category jumps straight to its first page.
const CATEGORY_FIRST_PAGE = [];
for (const cat of HELP_CATEGORIES) {
  const per = 10;
  CATEGORY_FIRST_PAGE.push(HELP_PAGES.length);
  for (let i = 0; i < cat.cmds.length; i += per) {
    HELP_PAGES.push({ category: cat.name, cmds: cat.cmds.slice(i, i + per) });
  }
}
// keep this here so the dummy old array below doesn't get parsed.
const _HELP_OLD_DEAD = [
    "{p}hb @user [reason] hardban a user (won't be able to rejoin)",
  "{p}unhb [id] [reason] remove a hardban",
  "{p}ban @user [reason] ban a user",
  "{p}unban [id] [reason] unban a user",
  "{p}kick @user [reason] kick a user",
  "{p}purge [amount] bulk delete messages",
  "{p}timeout @user [mins] [reason] timeout a user",
  "{p}untimeout @user remove a timeout",
  "{p}mute @user [reason] mute a user",
  "{p}unmute @user unmute a user",
  "{p}hush @user auto delete a user's messages",
  "{p}unhush @user stop auto deleting",
  "{p}jail @user [reason] jail a user",
  "{p}unjail @user release them from jail",
  "{p}lock lock the current channel",
  "{p}unlock unlock the current channel",
  "{p}nuke wipe the channel by recreating it",
  "{p}warn @user [reason] warn a member",
  "{p}warns @user check warnings",
  "{p}clearwarns @user clear all warns",
  "{p}delwarn @user [#] delete a single warn",
  "{p}antinuke status / enable / disable / punishment / logs / whitelist / threshold configure antinuke",
  "{p}roblox [username] look up a roblox user",
  "{p}rid [id] look up a roblox user by id",
  "{p}gc [username] list a user's roblox groups",
  "{p}rg [link/id] change the bot's tracked roblox group",
  "{p}cookie [value] set the .ROBLOSECURITY cookie (owner only)",
  "{p}group view or edit group config",
  "{p}flag [id] flag a roblox group",
  "{p}unflag [id] unflag a roblox group",
  "{p}flagged list flagged groups",
  "{p}grouproles list roles in the current group",
  "{p}role [user] [role] set a roblox group role on a user",
  "{p}setrole [name] [id] register a group role by name",
  "{p}setroleperms add/remove/list let a discord role use {p}role",
  "{p}rom @role / add / remove / list register roles of management",
  "{p}rmanager @role one-shot toggle a role of management",
  "{p}r @member [roles...] toggle discord roles on a member",
  "{p}register start a registration flow",
  "{p}pregister pre-register someone (whitelist only)",
  "{p}verify finish verification",
  "{p}registeredlist see who's registered",
  "{p}linked see all roblox-discord links",
  "{p}rollcall start a rollcall (members react to confirm they're in)",
  "{p}endrollcall close the rollcall and log everyone",
  "{p}setrollcallchannel [channel] where the rollcall summary posts",
  "{p}lb show the raid points leaderboard (10 per page)",
  "{p}lbreset wipe the raid leaderboard for this server",
  "{p}atlog browse past rollcall sessions",
  "{p}whoisin [game URL/place id] check which group members are in a game",
  "{p}setupraidpoints drop the \"get raid point\" button panel",
  "{p}setraidreview [#channel] where raid point requests get sent for review",
  "{p}setuptickets [channel] send a ticket panel",
  "{p}closeticket close the current ticket",
  "{p}ticket supportroles add/remove/list manage support roles",
  "{p}give1 give the bot and you the highest role possible",
  "{p}tag [user] [role] same as {p}role but logged",
  "{p}taglog [#] view recent tag log",
  "{p}setlogchannel [channel] set the action log channel",
  "{p}setlogchanneltag [channel] set the tag log channel",
  "{p}logstatus show current log channel",
  "{p}setverifyrole [role] set the role given on verification",
  "{p}prefix [new] view or change the bot prefix",
  "{p}name [text] change bot display name in embeds",
  "{p}logo [url] change embed logo",
  "{p}config show bot config",
  "{p}status [type] [text] change bot activity status",
  "{p}presence [state] change bot online status (online/idle/dnd/invisible)",
  "{p}vanityset [vanity] [role] tie a vanity status to a role",
  "{p}whitelist add/remove/list/check manage whitelist",
  "{p}wlmanager add/remove/list manage whitelist managers",
  "{p}tempowner [user] grant temp owner access",
  "{p}untempowner [user] revoke temp owner access",
  "{p}permcheck [user] show what bot roles a user has",
  "{p}autorole @role / off / status pick a role to give every joiner",
  "{p}joinserver [invite] one-click link to add me to that server",
  "{p}leaveserver [server id] make me leave a server",
  "{p}servers list every server I'm in",
  "{p}backup zip every json state file and DM it to you",
  "{p}restore (attach .backup zip) restore json state files",
  "{p}inrole [role] list members with a role",
  "{p}id [user] get the numeric id of a user",
  "{p}help show this help",
  "{p}rankup [user] [levels] rank a member up the ladder",
  "{p}setrankroles set/list/clear configure the rank ladder",
  "{p}fileroles download the rank ladder json",
  "{p}rfile / lvfile / import handle role files / verify imports",
  "{p}tempban @user [duration] [reason] ban a user for a set duration",
    "{p}lockdown lock every text channel in the server",
    "{p}unlockdown reverse lockdown across every text channel",
    "{p}massban [id1] [id2] ... hardban many users by id at once",
    "{p}modlogs @user show warns, tempbans, hardbans and notes for a user",
    "{p}slowmode [seconds | off] set slowmode in this channel",
    "{p}note @user [text] save a private staff note about a user",
    "{p}notes @user list staff notes for a user",
    "{p}snipe show the last deleted message in this channel",
    "{p}avatar [@user] show a user's avatar",
    "{p}serverinfo show info about this server",
    "{p}userinfo [@user] show info about a member",
    "{p}afk [reason] set yourself as afk",
    "{p}activitycheck post an activity check button for members to confirm",
    '{p}poll "question" "opt1" "opt2" ... create a reaction poll',
    "{p}raidpoints @user show a user's raid points",
    "{p}rp @user shorthand for raidpoints",
    "{p}removepoint @user [count] subtract raid points",
    "{p}grouprank [robloxUser] show that user's rank in the tracked group",
    "{p}welcome setup #channel [text] | off | status configure join greeting",
    '{p}rolemenu create #channel "title" @role1 @role2 post a self-assign role dropdown',
    "{p}giveaway start [duration] [winners] [prize] | end [msgid] run a giveaway",
    "{p}antilink on / off / status auto-delete url posts",
    "{p}antispam on / off / status [threshold] [seconds] [muteSec] auto-mute spammers",
    "{p}antiinvite on / off / status auto-delete discord invite links",
    "{p}createchannel [name] [text|voice] create a channel",
    "{p}delchannel [#channel] delete a channel",
    "{p}clonechannel [#channel] duplicate a channel",
    "{p}renamechannel [#channel] [newname] rename a channel",
    "{p}hidechannel [#channel] hide a channel from @everyone",
    "{p}unhidechannel [#channel] unhide a channel",
    "{p}settopic [#channel] [text] set a channel topic",
    "{p}archivechannel [#channel] hide and lock a channel",
    "{p}pin pin the message you replied to",
    "{p}unpin [msgid] unpin a message",
    "{p}vckick @user kick a user out of voice",
    "{p}vcmove @user [#voice] move a user to another voice channel",
    "{p}vcmute @user server-mute someone in voice",
    "{p}vcunmute @user undo server mute",
    "{p}vcdeafen @user server-deafen in voice",
    "{p}vcundeafen @user undo server deafen",
    "{p}vclimit [#voice] [n] set voice channel user limit",
    "{p}vcname [#voice] [name] rename a voice channel",
    "{p}vctotal show how many people are in voice across the server",
    "{p}vcdisconnectall [#voice] kick everyone out of a voice channel",
    "{p}createrole [name] [hex] create a role",
    "{p}delrole [@role] delete a role",
    "{p}rolecolor [@role] [hex] change role color",
    "{p}rolename [@role] [name] rename a role",
    "{p}rolepos [@role] [pos] move a role position",
    "{p}rolehoist [@role] toggle role display separately",
    "{p}rolemention [@role] toggle role mentionable",
    "{p}rolemembers [@role] list members with a role",
    "{p}allroles list all server roles with member counts",
    "{p}removeallroles @user strip every role from a user",
    "{p}ping show bot latency",
    "{p}uptime show how long the bot has been online",
    "{p}botinfo show bot stats",
    "{p}members count total server members",
    "{p}online count online members",
    "{p}bots count bots in the server",
    "{p}humans count human members",
    "{p}roleinfo @role show role info",
    "{p}channelinfo [#channel] show channel info",
    "{p}emoji [emoji] show emoji url and id",
    "{p}emojis list every server emoji",
    "{p}servericon show the server icon",
    "{p}banner [@user] show a user banner",
    "{p}invites list active server invites",
    "{p}permissions @user show a user permissions",
    "{p}inviteinfo [code] inspect an invite code",
    "{p}firstmsg show the first message in this channel",
    "{p}msgcount @user count a user last 100 messages here",
    "{p}roles @user list a user roles",
    "{p}usercount how many members in this server",
    "{p}setjoinlog [#channel] log joins to a channel",
    "{p}setleavelog [#channel] log leaves to a channel",
    "{p}setvoicelog [#channel] log voice activity to a channel",
    "{p}setmsglog [#channel] log message edits and deletes to a channel",
    "{p}logsoff disable all extra logging",
    "{p}rradd [msgid] [emoji] @role add a reaction role",
    "{p}rrremove [msgid] [emoji] remove a reaction role",
    "{p}rrlist [msgid] list reaction roles on a message",
    "{p}rrclear [msgid] clear all reaction roles from a message",
    "{p}rrpost [#channel] [text] post a base message for reaction roles",
    "{p}ccadd [name] [response] add a custom command",
    "{p}ccdel [name] delete a custom command",
    "{p}cclist list custom commands",
    "{p}ccedit [name] [response] edit a custom command",
    "{p}ccshow [name] show a custom command response",
    "{p}embed [#channel] title desc [hex] post a custom embed",
    "{p}embedjson [#channel] {json} post a raw json embed",
    "{p}embededit [msgid] title desc edit an embed",
    "{p}embedfield [msgid] name value add a field to an embed",
    "{p}embedcolor [msgid] [hex] change an embed color",
    "{p}invitelb top inviters leaderboard",
    "{p}nick @user [name] change a user nickname",
    "{p}resetnick @user reset a user nickname",
    "{p}nickall [prefix] nickname every member with a prefix",
    "{p}softban @user [reason] ban and instantly unban (purges messages)",
    "{p}tempmute @user [duration] [reason] mute for a set duration",
    "{p}tempban @user [duration] [reason] ban someone for a limited time",
    "{p}massban id1 id2... [reason] ban a bunch of user IDs at once",
    "{p}slowmode [seconds|off] set channel slowmode",
    "{p}note @user [text] add a staff note on someone",
    "{p}notes @user view all notes on someone",
    "{p}cases @user list mod cases for a user",
    "{p}case [#] view a single mod case",
    "{p}delcase [#] delete a mod case",
    "{p}dm @user [message] send a DM to a user as the bot",
    "{p}say [text] make the bot say something",
    "{p}flip flip a coin",
    "{p}choose opt1, opt2, opt3 ... pick a random option",
    "{p}purgebot [n] delete only bot messages",
    "{p}purgeuser @user [n] delete a user recent messages",
    "{p}purgematch [text] [n] delete messages containing text",
    "{p}purgelinks [n] delete recent messages with links",
    "{p}purgeimages [n] delete recent messages with images",
    "{p}raidmode on / off / status enable a heavy slowmode raid mode",
    "{p}antimention on / off / status [threshold] auto-warn on mass mentions",
    "{p}antiemoji on / off / status [threshold] auto-delete emoji spam",
    "{p}blacklistword add / remove / list manage blacklisted words",
    "{p}autopurge [#channel] [seconds | off] auto-delete old messages in a channel",
    "{p}capslimit on / off / status [threshold] delete messages with too many caps",
    "{p}setautoroleage [days] require accounts to be N days old for autorole",
    ];

  const HELP_PER_PAGE = 10;

  const GC_PER_PAGE = 10;

  function buildHelpEmbed(page) {
    const p = getPrefix();
    const totalPages = HELP_PAGES.length;
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageData = HELP_PAGES[safe];
    const lines = pageData.cmds.map(c => {
      const full = c.replace(/\{p\}/g, p);
      const i = full.indexOf(' ');
      if (i === -1) return `**\`${full}\`**`;
      return `**\`${full.slice(0, i)}\`** — ${full.slice(i + 1)}`;
    });
    const header = `**prefix:** \`${p}\`  •  **slash:** \`/\`\nevery command works as both a prefix command and a slash command — flip through the pages with the buttons below.\n`;
    return new EmbedBuilder()
      .setColor(0x2C2F33)
      .setAuthor({ name: `${getBotName()} help`, iconURL: getLogoUrl() })
      .setThumbnail(getLogoUrl())
      .setTitle(pageData.category)
      .setDescription(header + '\n' + lines.join('\n'))
      .setFooter({ text: `${pageData.category}  •  page ${safe + 1} of ${totalPages}  •  prefix: ${p}`, iconURL: getLogoUrl() })
      .setTimestamp();
  }

  function buildHelpRow(page) {
    const totalPages = HELP_PAGES.length;
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`help ${safe - 1}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(safe === 0),
      new ButtonBuilder().setCustomId(`help ${safe + 1}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(safe >= totalPages - 1)
    );
  }

  // category dropdown — discord caps select menus at 25 options. we have 17
  // categories so it fits in one menu. picking a category jumps to that
  // category's first page.
  function buildHelpCategoryRow(page) {
    const totalPages = HELP_PAGES.length;
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const currentCategory = HELP_PAGES[safe].category;
    const menu = new StringSelectMenuBuilder()
      .setCustomId('help_cat')
      .setPlaceholder('jump to a category…')
      .addOptions(HELP_CATEGORIES.slice(0, 25).map((cat, idx) => ({
        label: cat.name.slice(0, 100),
        value: String(CATEGORY_FIRST_PAGE[idx]),
        description: `${cat.cmds.length} command${cat.cmds.length === 1 ? '' : 's'}`.slice(0, 100),
        default: cat.name === currentCategory,
      })));
    return new ActionRowBuilder().addComponents(menu);
  }

  // helper: build the full set of components shown beneath a help embed.
  function buildHelpComponents(page) {
    return [buildHelpCategoryRow(page), buildHelpRow(page)];
  }


function buildGcEmbed(username, groups, avatarUrl, page) {
  const totalPages = Math.max(1, Math.ceil(groups.length / GC_PER_PAGE));
  const slice = groups.slice(page * GC_PER_PAGE, page * GC_PER_PAGE + GC_PER_PAGE);
  const groupLines = slice.length
    ? slice.map(g => `• [${g.group.name}](https://www.roblox.com/communities/${g.group.id}/about)`).join('\n')
    : ' no groups ';
  const embed = new EmbedBuilder()
    .setColor(0x2C2F33)
    .setTitle('Group Check')
    .setDescription(`${username}\n\n**Groups**\n${groupLines}`)
    .setFooter({ text: `${getBotName()} • Page ${page + 1} of ${totalPages}` });
  if (avatarUrl) embed.setAuthor({ name: username, iconURL: avatarUrl });
  return embed;
}

function buildFlaggedSection(userGroupIds) {
  const allFlagged = loadFlaggedGroups();
  const matched = allFlagged.filter(g => userGroupIds.has(String(g.id)));
  return matched;
}

function buildGcNotInGroupEmbed(displayName, userGroupIds) {
  let desc = `**${displayName}** hasn't joined the group yet.\nAsk them to join before verifying.\n\n **Group ID:** \`${getGroupId()}\`\n **Link:** [Click to Join](${getGroupLink()})`;
  const matchedFlagged = buildFlaggedSection(userGroupIds);
  if (matchedFlagged.length > 0) {
    const lines = matchedFlagged.map(g => {
      const label = g.name ? `**[${g.name}](https://www.roblox.com/communities/${g.id}/about)**` : `**[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)**`;
      return `${label} \`${g.id}\``;
    });
    desc += `\n\n**Flagged Groups (${matchedFlagged.length}):**\n${lines.join('\n')}`;
  }
  return new EmbedBuilder()
    .setColor(0x2C2F33)
    .setTitle('Not In Group')
    .setDescription(desc)
    .setFooter({ text: `${getBotName()} • ${getBotName()}`, iconURL: getLogoUrl() })
    .setTimestamp()
}

function buildGcInGroupEmbed(displayName, userGroupIds) {
  const matchedFlagged = buildFlaggedSection(userGroupIds);
  let desc;
  if (matchedFlagged.length > 0) {
    desc = `**${displayName}** is in a flagged group, please have them leave before verifying. They're good for verification but still in the flagged group.\n\n **Group ID:** \`${getGroupId()}\`\n **Link:** [View Group](${getGroupLink()})`;
    const lines = matchedFlagged.map(g => {
      const label = g.name ? `**[${g.name}](https://www.roblox.com/communities/${g.id}/about)**` : `**[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)**`;
      return `${label} \`${g.id}\``;
    });
    desc += `\n\n**Flagged Groups (${matchedFlagged.length}):**\n${lines.join('\n')}`;
  } else {
    desc = `**${displayName}** is in the group and ready to be verified.\n\n **Group ID:** \`${getGroupId()}\`\n **Link:** [View Group](${getGroupLink()})`;
  }
  return new EmbedBuilder()
    .setColor(0x2C2F33)
    .setTitle('In Group')
    .setDescription(desc)
    .setFooter({ text: `${getBotName()} • ${getBotName()}`, iconURL: getLogoUrl() })
    .setTimestamp()
}

// build a "flag a group from this list" select menu row from the user's groups.
// returns null when there's nothing flaggable left to show.
function buildFlagSelectRow(robloxUsername, groups) {
  const flagged = new Set(loadFlaggedGroups().map(g => String(g.id)));
  const candidates = (groups || []).filter(g => !flagged.has(String(g.group.id))).slice(0, 25);
  if (candidates.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`flag gc:${encodeURIComponent(robloxUsername).slice(0, 70)}`)
    .setPlaceholder('flag a group from this list')
    .setMinValues(1)
    .setMaxValues(Math.min(candidates.length, 25))
    .addOptions(candidates.map(g => ({
      label: String(g.group.name).slice(0, 100),
      value: String(g.group.id),
      description: `id: ${g.group.id}`.slice(0, 100),
    })));
  return new ActionRowBuilder().addComponents(menu);
}

function buildGcRow(username, groups, page) {
  const totalPages = Math.ceil(groups.length / GC_PER_PAGE);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gc ${page - 1} ${username}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`gc ${page + 1} ${username}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
  );
}

function buildVmInterfaceEmbed(guild) {
  return baseEmbed().setColor(0x2C2F33).setTitle('voicemaster')
    .setDescription('use the buttons below to manage your vc')
    .addFields({ name: 'buttons', value: [
      '🔒 **lock** the vc', '🔓 **unlock** the vc',
      '👻 **ghost** the vc', '👁️ **reveal** the vc',
      '✏️ **rename**', '👑 **claim** the vc',
      '➕ **increase** user limit', '➖ **decrease** user limit',
      '🗑️ **delete**', '📋 **view** channel info',
    ].join('\n') }).setThumbnail(guild?.iconURL() ?? null);
}

function buildVmInterfaceRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm unlock').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm ghost').setEmoji('👻').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm reveal').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm claim').setEmoji('👑').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm info').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm limit up').setEmoji('➕').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm limit down').setEmoji('➖').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    )
  ];
}


// caches
const gcCache          = new Map();
const striptagPending  = new Map(); // userid { tagname, members, rank2roleid }


// slash commands
const GUILD_ONLY_COMMANDS = new Set(['ban', 'kick', 'unban', 'purge', 'timeout', 'mute', 'unmute', 'hush', 'lock', 'unlock', 'nuke']);

// contexts for commands that work everywhere (guilds, bot dms, and user install dms)
const ALL_CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
// both guild install and user install
const ALL_INSTALLS = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];

const slashCommands = [
  new SlashCommandBuilder().setName('help').setDescription('shows the command list')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('roblox').setDescription('look up a roblox user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('username').setDescription('roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('gc').setDescription('list roblox groups for a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('username').setDescription('roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('rg').setDescription('change the roblox group used by .gc and verify')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('link').setDescription('roblox group link or id').setRequired(true)),
  new SlashCommandBuilder().setName('cookie').setDescription('set the roblox account cookie used by the bot (owner only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('cookie').setDescription('the .ROBLOSECURITY cookie value').setRequired(true)),
  new SlashCommandBuilder().setName('hb').setDescription('hardban a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to ban').setRequired(false))
    .addStringOption(o => o.setName('id').setDescription('user id if not in server').setRequired(false))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('ban').setDescription('ban a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('kick').setDescription('kick a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('unban').setDescription('unban a user by id')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('id').setDescription('user id to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('purge').setDescription('delete messages in bulk')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('amount').setDescription('how many messages to delete (1 100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('timeout').setDescription('timeout a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('duration in minutes').setRequired(false).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('untimeout').setDescription('remove a timeout')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('mute').setDescription('mute a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('unmute').setDescription('remove a mute')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('hush').setDescription('auto delete all messages from a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('unhush').setDescription('remove auto delete from a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('nuke').setDescription('delete and recreate the channel (clears all messages)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('lock').setDescription('lock the current channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('unlock').setDescription('unlock the current channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('grouproles').setDescription('list roblox group roles')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('wlmanager').setDescription('manage whitelist managers')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('what to do').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addUserOption(o => o.setName('user').setDescription('user (for add/remove)').setRequired(false)),
  new SlashCommandBuilder().setName('jail').setDescription('jail a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to jail').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('unjail').setDescription('release a user from jail')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to unjail').setRequired(true)),
  new SlashCommandBuilder().setName('prefix').setDescription('change or view the bot prefix')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('new').setDescription('new prefix').setRequired(false)),
  new SlashCommandBuilder().setName('status').setDescription('change the bot status')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('type').setDescription('type').setRequired(true)
      .addChoices({ name: 'playing', value: 'playing' }, { name: 'watching', value: 'watching' }, { name: 'listening', value: 'listening' }, { name: 'competing', value: 'competing' }, { name: 'custom', value: 'custom' }))
    .addStringOption(o => o.setName('text').setDescription('status text').setRequired(true)),
  new SlashCommandBuilder().setName('presence').setDescription('change the bot online status')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('state').setDescription('online state').setRequired(true)
      .addChoices(
        { name: 'online', value: 'online' },
        { name: 'idle', value: 'idle' },
        { name: 'do not disturb', value: 'dnd' },
        { name: 'invisible', value: 'invisible' }
      )),
  new SlashCommandBuilder().setName('whitelist').setDescription('manage the whitelist')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('what to do').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }, { name: 'check', value: 'check' }))
    .addUserOption(o => o.setName('user').setDescription('user (for add/remove/check)').setRequired(false)),
  new SlashCommandBuilder().setName('joinserver').setDescription('get a one-click link that adds the bot to the server behind an invite link (WL managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('invite').setDescription('a discord invite link or invite code').setRequired(true)),
  new SlashCommandBuilder().setName('permcheck').setDescription('show what bot-level roles a user has (wl manager / temp owner / whitelisted)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('the user to check (defaults to you)').setRequired(false)),
  new SlashCommandBuilder().setName('invite').setDescription('grab the invite link for the bot (whitelist managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('setlogchanneltag').setDescription('set the channel where tag logs go')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('channel for tag logs').setRequired(true)),
  // NEW COMMANDS
  new SlashCommandBuilder().setName('unhb').setDescription('remove a hardban')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('id').setDescription('user id to un hardban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),

  // bleed.bot inspired commands (autorole/joindm/server setup removed)
  new SlashCommandBuilder().setName('warn').setDescription('warn a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('warnings').setDescription('show warnings for a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to check').setRequired(true)),
  new SlashCommandBuilder().setName('clearwarns').setDescription('clear all warnings for a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to clear').setRequired(true)),
  new SlashCommandBuilder().setName('delwarn').setDescription('delete a specific warning by index')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
    .addIntegerOption(o => o.setName('index').setDescription('warning number from /warnings').setRequired(true).setMinValue(1)),


  new SlashCommandBuilder().setName('role').setDescription('Set a Roblox group role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('roblox').setDescription('roblox username').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('target group role').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder().setName('setrole').setDescription('register a roblox group role by name and id')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('name').setDescription('role name (used in /role)').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('roblox group role id').setRequired(true)),

  new SlashCommandBuilder().setName('setroleperms').setDescription('Allow a Discord role to use /role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('action').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addRoleOption(o => o.setName('role').setDescription('discord role').setRequired(false)),

  new SlashCommandBuilder().setName('tempowner').setDescription('Grant a user temporary access to all bot commands')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),

  new SlashCommandBuilder().setName('untempowner').setDescription('Revoke temp owner access from a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),

  new SlashCommandBuilder().setName('setlogchannel').setDescription('Set the channel for bot action logs')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('log channel').setRequired(true)),

  new SlashCommandBuilder().setName('logstatus').setDescription('Check the current log channel setting')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  new SlashCommandBuilder().setName('setverifyrole').setDescription('Set the role given on verification')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addRoleOption(o => o.setName('role').setDescription('role to give verified users').setRequired(true)),

  new SlashCommandBuilder().setName('setuptickets').setDescription('Send a ticket panel to a channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('channel for the panel').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('what the panel offers (default: both)').setRequired(false)
      .addChoices(
        { name: 'verification only', value: 'verification' },
        { name: 'tag only',          value: 'tag' },
        { name: 'both',              value: 'both' },
      ))
    .addStringOption(o => o.setName('title').setDescription('override the default title').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('override the default description').setRequired(false))
    .addStringOption(o => o.setName('color').setDescription('hex color e.g. 4A0E0E (default: dark red)').setRequired(false))
    .addStringOption(o => o.setName('placeholder').setDescription('dropdown placeholder text').setRequired(false)),

  new SlashCommandBuilder().setName('closeticket').setDescription('Close and delete the current ticket channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  new SlashCommandBuilder().setName('ticket').setDescription('Ticket management')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addSubcommand(s => s.setName('supportroles').setDescription('Add or remove support roles for ticket actions')
      .addStringOption(o => o.setName('action').setDescription('action').setRequired(true)
        .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
      .addRoleOption(o => o.setName('role').setDescription('discord role').setRequired(false))),

  new SlashCommandBuilder().setName('tag').setDescription('Rank a Roblox user (same as /role) logged to the tag log')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('roblox').setDescription('roblox username').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('registered roblox group role name').setRequired(true)),

  new SlashCommandBuilder().setName('taglog').setDescription('View the most recent tag log entries')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('limit').setDescription('how many entries to show (default 10)').setRequired(false).setMinValue(1).setMaxValue(50)),

  new SlashCommandBuilder().setName('r').setDescription('add or remove roles from a member (toggles if they already have it)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('member').setDescription('member to give/remove roles').setRequired(true))
    .addRoleOption(o => o.setName('role1').setDescription('first role').setRequired(true))
    .addRoleOption(o => o.setName('role2').setDescription('second role').setRequired(false))
    .addRoleOption(o => o.setName('role3').setDescription('third role').setRequired(false))
    .addRoleOption(o => o.setName('role4').setDescription('fourth role').setRequired(false))
    .addRoleOption(o => o.setName('role5').setDescription('fifth role').setRequired(false)),

  new SlashCommandBuilder().setName('inrole').setDescription('list all members with a specific role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addRoleOption(o => o.setName('role').setDescription('role to check').setRequired(true)),

  new SlashCommandBuilder().setName('leaveserver').setDescription('force the bot to leave a server (WL managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('serverid').setDescription('server ID to leave (leave blank to leave current server)').setRequired(false)),

  // roblox / rank commands
  new SlashCommandBuilder().setName('rid').setDescription('look up a Roblox user by their numeric ID')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('id').setDescription('numeric Roblox user ID').setRequired(true)),
  new SlashCommandBuilder().setName('rankup').setDescription('promote members up the configured rank ladder')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user1').setDescription('member to rank up').setRequired(true))
    .addUserOption(o => o.setName('user2').setDescription('additional member').setRequired(false))
    .addUserOption(o => o.setName('user3').setDescription('additional member').setRequired(false))
    .addUserOption(o => o.setName('user4').setDescription('additional member').setRequired(false))
    .addUserOption(o => o.setName('user5').setDescription('additional member').setRequired(false))
    .addIntegerOption(o => o.setName('levels').setDescription('how many ranks to jump (default 1)').setRequired(false).setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder().setName('setrankroles').setDescription('configure the rank ladder for this server')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('action').setRequired(true)
      .addChoices({ name: 'set', value: 'set' }, { name: 'list', value: 'list' }, { name: 'clear', value: 'clear' }))
    .addRoleOption(o => o.setName('role1').setDescription('1st (lowest) rank role').setRequired(false))
    .addRoleOption(o => o.setName('role2').setDescription('2nd rank role').setRequired(false))
    .addRoleOption(o => o.setName('role3').setDescription('3rd rank role').setRequired(false))
    .addRoleOption(o => o.setName('role4').setDescription('4th rank role').setRequired(false))
    .addRoleOption(o => o.setName('role5').setDescription('5th (highest) rank role').setRequired(false)),
  new SlashCommandBuilder().setName('fileroles').setDescription('download the rank ladder for this server as a JSON file')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  // utility
  new SlashCommandBuilder().setName('servers').setDescription('list all servers the bot is in (WL managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('logo').setDescription('change the embed logo used across the bot')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('url').setDescription('image URL for the new logo (leave blank to see current)').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('reset to default').setRequired(false)
      .addChoices({ name: 'reset', value: 'reset' })),
  new SlashCommandBuilder().setName('name').setDescription('change the bot display name used in all embeds')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('text').setDescription('new display name (leave blank to see current)').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('reset to default').setRequired(false)
      .addChoices({ name: 'reset', value: 'reset' })),

  // bridged prefix-only slash commands removed — discord caps total slash
  // commands at 130, and the explicit list above already exceeds that when
  // combined with bridges. use `/cmd <name> <args>` to run any prefix command
  // that doesn't have its own slash entry (e.g. /cmd ping, /cmd snipe).
  // /cmd lets you run any prefix only command that didn't get its own slash.
  // useful for things like .editsnipe, .drag, .cleanup, etc.
  new SlashCommandBuilder().setName('cmd').setDescription('run any prefix only command')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('name').setDescription('the prefix command name (without the prefix)').setRequired(true))
    .addStringOption(o => o.setName('args').setDescription('arguments to pass to the command').setRequired(false)),
  // /vanityset binds a vanity tag and a role - members repping /<vanity> in their
  // status get the role automatically (handled by the presenceupdate listener)
  new SlashCommandBuilder().setName('vanityset').setDescription('set the vanity code and role for status repping')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('vanity').setDescription('vanity code without the slash (e.g. repent)').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('role to give while repping').setRequired(true)),
  // /restore needs a real attachment option so users can drag the zip in.
  // the slash-to-prefix bridge picks the attachment up via interaction.options.data
  // and exposes it as message.attachments for the existing prefix handler
  new SlashCommandBuilder().setName('restore').setDescription('restore json state files from a .backup zip')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addAttachmentOption(o => o.setName('zip').setDescription('a .zip produced by /backup').setRequired(true)),
  // /autorole - pick a role that gets handed to anyone who joins the server.
  // pass action=off (or omit role with action=remove) to clear it.
  new SlashCommandBuilder().setName('autorole').setDescription('give a role to anyone who joins the server')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('what to do').setRequired(true)
      .addChoices(
        { name: 'set',    value: 'set'    },
        { name: 'remove', value: 'remove' },
        { name: 'status', value: 'status' }
      ))
    .addRoleOption(o => o.setName('role').setDescription('role to hand out (only needed for set)').setRequired(false)),

  new SlashCommandBuilder().setName('alts').setDescription('check if a user has multiple Discord accounts linked to the same Roblox profile')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to check (defaults to you)').setRequired(false)),

  // --- moderation extras ---
  new SlashCommandBuilder().setName('softban').setDescription('ban then instantly unban (clears their recent messages)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to softban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),

  new SlashCommandBuilder().setName('tempmute').setDescription('mute someone for a set amount of time')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to mute').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('like 10m, 2h, 1d').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),

  new SlashCommandBuilder().setName('tempban').setDescription('ban someone for a limited time')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to tempban').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('like 1h, 7d').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),

  new SlashCommandBuilder().setName('massban').setDescription('ban a list of user IDs at once')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('ids').setDescription('space separated user IDs').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),

  new SlashCommandBuilder().setName('slowmode').setDescription('set channel slowmode (0 to turn off)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('seconds').setDescription('slowmode delay in seconds (0-21600)').setRequired(true).setMinValue(0).setMaxValue(21600)),

  new SlashCommandBuilder().setName('cases').setDescription('view mod cases for a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to look up').setRequired(true)),

  new SlashCommandBuilder().setName('case').setDescription('view a specific mod case by number')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('number').setDescription('case number').setRequired(true)),

  new SlashCommandBuilder().setName('delcase').setDescription('delete a mod case')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('number').setDescription('case number to delete').setRequired(true)),

  new SlashCommandBuilder().setName('note').setDescription('add a staff note to a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to note').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('the note').setRequired(true)),

  new SlashCommandBuilder().setName('notes').setDescription('view all notes on a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to look up').setRequired(true)),

  // --- purge variants ---
  new SlashCommandBuilder().setName('purgebot').setDescription('delete recent bot messages')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('amount').setDescription('how many to delete (default 20)').setRequired(false).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder().setName('purgeuser').setDescription("delete a user's recent messages")
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('whose messages to delete').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('how many (default 20)').setRequired(false).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder().setName('purgematch').setDescription('delete messages that contain certain text')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('text').setDescription('text to match').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('how many to scan (default 50)').setRequired(false).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder().setName('purgelinks').setDescription('delete recent messages that have links')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('amount').setDescription('how many to delete (default 20)').setRequired(false).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder().setName('purgeimages').setDescription('delete recent messages that have images')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('amount').setDescription('how many to delete (default 20)').setRequired(false).setMinValue(1).setMaxValue(100)),

  // --- nicknames ---
  new SlashCommandBuilder().setName('nick').setDescription("change someone's nickname")
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to rename').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('new nickname (leave blank to clear)').setRequired(false)),

  new SlashCommandBuilder().setName('resetnick').setDescription("clear someone's nickname")
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to reset').setRequired(true)),

  new SlashCommandBuilder().setName('nickall').setDescription('add a prefix to every member nickname')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('prefix').setDescription('the prefix to add').setRequired(true)),

  // --- fun / utility ---
  new SlashCommandBuilder().setName('say').setDescription('make the bot send a message')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('text').setDescription('what to say').setRequired(true)),

  new SlashCommandBuilder().setName('flip').setDescription('flip a coin'),

  new SlashCommandBuilder().setName('choose').setDescription('pick a random option from a list')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('options').setDescription('comma separated options').setRequired(true)),

  new SlashCommandBuilder().setName('invitelb').setDescription('show who has the most server invites')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  // --- dm ---
  new SlashCommandBuilder().setName('dm').setDescription('send a DM to a user as the bot')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('who to DM').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('what to send').setRequired(true)),
].map(c => c.toJSON());

// status helper
function applyStatus(statusData) {
  const typeMap = { playing: ActivityType.Playing, streaming: ActivityType.Streaming, listening: ActivityType.Listening, watching: ActivityType.Watching, competing: ActivityType.Competing, custom: ActivityType.Custom };
  client.user.setActivity({ name: statusData.text, type: typeMap[statusData.type] ?? ActivityType.Playing });
}

// changes the green/yellow/red dot next to the bots name
function applyPresence(state) {
  const okStates = ['online', 'idle', 'dnd', 'invisible'];
  if (!okStates.includes(state)) state = 'online';
  try { client.user.setStatus(state); } catch (e) {}
}

// ready

  // ───── tempban + giveaway helpers ─────
  async function unbanFromTempban(guildId, userId) {
    const tb = loadTempbans();
    if (!tb[guildId]?.[userId]) return;
    delete tb[guildId][userId];
    saveTempbans(tb);
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.bans.remove(userId, 'tempban expired');
    } catch (e) { console.log('[tempban] unban failed for ' + userId + ':', e.message); }
  }

  async function endGiveaway(messageId, replyChannel) {
    const gdata = loadGiveaways();
    const g = gdata[messageId];
    if (!g) { if (replyChannel) replyChannel.send('giveaway not found.').catch(() => {}); return; }
    delete gdata[messageId];
    saveGiveaways(gdata);
    try {
      const ch = await client.channels.fetch(g.channelId);
      const msg = await ch.messages.fetch(messageId);
      const reaction = msg.reactions.cache.get('🎉');
      let entrants = [];
      if (reaction) {
        const users = await reaction.users.fetch();
        entrants = users.filter(u => !u.bot).map(u => u.id);
      }
      if (!entrants.length) {
        await ch.send('🎉 giveaway for **' + g.prize + '** ended — no entrants.');
        return;
      }
      const winners = [];
      const pool = [...entrants];
      for (let i = 0; i < g.winners && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        winners.push(pool.splice(idx, 1)[0]);
      }
      await ch.send('🎉 giveaway for **' + g.prize + '** ended! winner' + (winners.length !== 1 ? 's' : '') + ': ' + winners.map(id => '<@' + id + '>').join(', '));
    } catch (e) { console.log('[giveaway] end failed:', e.message); }
  }

  client.once('clientReady', async () => {
  console.log(`logged in as ${client.user.tag}`);

  // 1. initialise postgres schema (idempotent — also runs at startup before login)
  if (dbPool) {
    await initDbSchema();

    // 2. migrate existing JSON files into postgres (first run only)
    const migrations = [
      ['bot config',      CONFIG_FILE],
      ['tags',            TAGS_FILE],
      ['tagged members',  TAGGED_MEMBERS_FILE],
      ['whitelist',       WHITELIST_FILE],
      ['verify',          VERIFY_FILE],
      ['rankup',          RANKUP_FILE],
      ['queue',           QUEUE_FILE],
      ['attendance log',  ATLOG_FILE],
      ['raid stats',      RAID_STATS_FILE],
      ['warns',           WARNS_FILE],
      ['vanity',          VANITY_FILE],
      ['autorole',        AUTOROLE_FILE],
      ['welcome',         WELCOME_FILE],
      ['antiinvite',      ANTIINVITE_FILE],
      ['altdentifier',    ALTDENTIFIER_FILE],
      ['joindm',          JOINDM_FILE],
      ['logs',            LOGS_FILE],
      ['autoresponder',   AUTORESPONDER_FILE],
      ['activity check',  ACTIVITY_CHECK_FILE],
      ['tickets',         TICKETS_FILE],
      ['ticket support',  TICKET_SUPPORT_FILE],
      ['tag log',         TAG_LOG_FILE],
    ];
    for (const [table, file] of migrations) {
      await migrateJsonToDb(table, file);
    }

    // 3. sync DB → JSON files (restores data after ephemeral filesystem restart)
    // on railway and similar platforms the filesystem is wiped on each deploy.
    // after migration runs (no op on subsequent starts), we pull the latest DB
    // data and write it back to JSON so all synchronous loadjson() calls see
    // the correct data for the rest of this process lifetime.
    const dbToJsonSync = [
      ['bot config',      CONFIG_FILE],
      ['tags',            TAGS_FILE],
      ['tagged members',  TAGGED_MEMBERS_FILE],
      ['whitelist',       WHITELIST_FILE],
      ['verify',          VERIFY_FILE],
      ['rankup',          RANKUP_FILE],
      ['queue',           QUEUE_FILE],
      ['attendance log',  ATLOG_FILE],
      ['raid stats',      RAID_STATS_FILE],
      ['warns',           WARNS_FILE],
      ['vanity',          VANITY_FILE],
      ['autorole',        AUTOROLE_FILE],
      ['welcome',         WELCOME_FILE],
      ['antiinvite',      ANTIINVITE_FILE],
      ['altdentifier',    ALTDENTIFIER_FILE],
      ['joindm',          JOINDM_FILE],
      ['logs',            LOGS_FILE],
      ['autoresponder',   AUTORESPONDER_FILE],
      ['activity check',  ACTIVITY_CHECK_FILE],
      ['tickets',         TICKETS_FILE],
      ['ticket support',  TICKET_SUPPORT_FILE],
      ['tag log',         TAG_LOG_FILE],
    ];
    for (const [table, file] of dbToJsonSync) {
      try {
        const dbData = await dbLoad(table);
        if (dbData !== null) {
          // write JSON without triggering another DB mirror (use fs directly)
          const json = JSON.stringify(dbData, null, 2);
          const dir = path.dirname(file);
          try { fs.mkdirSync(dir, { recursive: true }); } catch {}
          fs.writeFileSync(file, json, 'utf8');
        }
      } catch (err) {
        console.error(`[pg] db→json sync failed for ${table}: ${err.message}`);
      }
    }
    console.log('[pg] db→json sync complete');

    // 4. check control signal on startup
    await checkBotStatus();

    // 5. poll bot status every 30 s
    setInterval(checkBotStatus, 30_000);
  }

  const cfg = loadConfig();
  if (cfg.status) applyStatus(cfg.status);
  if (cfg.presence) applyPresence(cfg.presence);


    // resume pending tempbans
    try {
      const tb = loadTempbans();
      for (const [gid, users] of Object.entries(tb)) {
        for (const [uid, info] of Object.entries(users)) {
          const remain = info.until - Date.now();
          if (remain <= 0) await unbanFromTempban(gid, uid);
          else setTimeout(() => unbanFromTempban(gid, uid).catch(() => {}), Math.min(remain, 2147483000));
        }
      }
    } catch (e) { console.log('[tempban resume]', e.message); }
    // resume pending giveaways
    try {
      const gdata = loadGiveaways();
      for (const [mid, g] of Object.entries(gdata)) {
        const remain = g.endsAt - Date.now();
        if (remain <= 0) await endGiveaway(mid);
        else setTimeout(() => endGiveaway(mid).catch(() => {}), Math.min(remain, 2147483000));
      }
    } catch (e) { console.log('[giveaway resume]', e.message); }

    if (fs.existsSync(REBOOT_FILE)) {
    const { channelId, messageId } = loadJSON(REBOOT_FILE);
    fs.unlinkSync(REBOOT_FILE);
    try { const ch = await client.channels.fetch(channelId); const msg = await ch.messages.fetch(messageId); await msg.edit('Restarted successfully.'); } catch {}
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    // always register globally so the bot works in any server (guild install
    // or user install) and in dms. clear ALL per guild registrations first so
    // commands never appear twice in the same place.
    for (const [gid] of client.guilds.cache) {
      try { await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: [] }); } catch {}
    }
    const guildId = process.env.GUILD_ID;
    if (guildId && !client.guilds.cache.has(guildId)) {
      try { await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] }); } catch {}
    }
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('slash commands registered globally (any server + DMs, no duplicates)');
  } catch (err) { console.error('failed to register slash commands:', err.message); }

  const startupChannelId = process.env.STARTUP_CHANNEL_ID;
  if (startupChannelId) {
    try {
      const ch = await client.channels.fetch(startupChannelId);
      await ch.send({
        embeds: [
          baseEmbed()
            .setColor(0x2C2F33)
            .setTitle(`${client.user.username} is online`)
            .setDescription('online and ready')
            .setTimestamp()
        ]
      });
    } catch (err) { console.error('failed to send startup embed:', err.message); }
  }
});

// message delete snipe

client.on('messageDelete', message => {
    if (message.partial || message.author?.bot || !message.content) return;
    snipeCache.set(message.channel.id, {
      content: message.content,
      author: message.author?.tag ?? 'unknown',
      avatarUrl: message.author?.displayAvatarURL() ?? null,
      deletedAt: Date.now(),
    });
  });

  // ─── tiny in-process zip writer (for .backup) ─────────────────────────────
// minimal PKZIP writer using node's built in zlib. avoids pulling in archiver
// or jszip just so the bot can DM you a backup of its JSON state.
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function _crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
// builds a zip from a list like [{ name, data }]. used by .backup
function buildZipBuffer(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const compressed = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = compressed.length < data.length
    const stored = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = _crc32(data)
    const nameBuf = Buffer.from(name, 'utf8')

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6); lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12)
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(stored.length, 18); lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28)
    local.push(lfh, nameBuf, stored)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0x0800, 8)
    cdh.writeUInt16LE(method, 10); cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0x21, 14)
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(stored.length, 20); cdh.writeUInt32LE(data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32)
    cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36); cdh.writeUInt32LE(0, 38)
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)

    offset += lfh.length + nameBuf.length + stored.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...local, centralBuf, eocd])
}

// opposite of buildzipbuffer. takes a zip buffer and gives back the files.
// handles normal zips (stored or deflated), since thats what backup makes.
function parseZipBuffer(buf) {
  // find the end-of-zip marker by scanning backwards
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD)')
  const totalEntries = buf.readUInt16LE(eocd + 10)
  const cdOffset     = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central dir entry at ${p}`)
    const method     = buf.readUInt16LE(p + 10)
    const compSize   = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen    = buf.readUInt16LE(p + 28)
    const extraLen   = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff   = buf.readUInt32LE(p + 42)
    const name       = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    // jump to the file header so we know where the file bytes start
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`)
    const lNameLen  = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const stored    = buf.slice(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(stored)
    else if (method === 8) data = zlib.inflateRawSync(stored)
    else throw new Error(`unsupported compression method ${method} for ${name}`)
    if (data.length !== uncompSize) throw new Error(`size mismatch for ${name} (${data.length} != ${uncompSize})`)
    entries.push({ name, data })
  }
  return entries
}

// antinuke stuff
// each server has its own settings saved in antinuke.json
// the idea: if someone does too many bad things too fast, punish them
// its OFF by default so you have to turn it on with .antinuke enable
// the hardcoded perm people + the server owner cant get punished
// also the bot itself obviously
// default punishment is 'strip' (just take their roles) so if it messes up
// at least nobody gets banned by accident
const ANTINUKE_FILE = path.join(__dirname, 'antinuke.json');
const DEFAULT_ANTINUKE_THRESHOLDS = {
  channelDelete:   { count: 3, window: 10000 },
  channelCreate:   { count: 5, window: 10000 },
  roleDelete:      { count: 3, window: 10000 },
  roleCreate:      { count: 5, window: 10000 },
  ban:             { count: 3, window: 10000 },
  kick:            { count: 3, window: 10000 },
  webhookCreate:   { count: 2, window: 10000 },
  memberRoleAdmin: { count: 1, window: 1000 },  // any single administrator perm grant
  botAdd:          { count: 1, window: 1000 },  // any non-whitelisted bot add
  emojiDelete:     { count: 5, window: 10000 },
};
function loadAntinuke()      { return loadJSON(ANTINUKE_FILE) || {}; }
function saveAntinuke(data)  { saveJSON(ANTINUKE_FILE, data); }
function getAntinukeCfg(guildId) {
  const all = loadAntinuke();
  if (!all[guildId]) all[guildId] = { enabled: false, logChannelId: null, whitelist: [], punishment: 'strip', thresholds: { ...DEFAULT_ANTINUKE_THRESHOLDS } };
  // if i added new threshold types later, fill them in so old configs dont break
  all[guildId].thresholds = { ...DEFAULT_ANTINUKE_THRESHOLDS, ...(all[guildId].thresholds || {}) };
  return { all, cfg: all[guildId] };
}
function setAntinukeCfg(guildId, mutator) {
  const { all, cfg } = getAntinukeCfg(guildId);
  mutator(cfg);
  all[guildId] = cfg;
  saveAntinuke(all);
  return cfg;
}

// keeps a list of timestamps in memory so we know how fast someone is doing stuff
// shape is: guild -> user -> action -> [time, time, time...]
const _anukeWindow = new Map();
function _anukePush(guildId, actorId, action, windowMs) {
  if (!_anukeWindow.has(guildId)) _anukeWindow.set(guildId, new Map());
  const g = _anukeWindow.get(guildId);
  if (!g.has(actorId)) g.set(actorId, new Map());
  const a = g.get(actorId);
  const list = a.get(action) || [];
  const now = Date.now();
  const fresh = list.filter(t => now - t < windowMs);
  fresh.push(now);
  a.set(action, fresh);
  return fresh.length;
}
function _anukeReset(guildId, actorId, action) {
  _anukeWindow.get(guildId)?.get(actorId)?.set(action, []);
}

// look at the audit log to figure out who did the thing
// only counts if it happened in the last 10 seconds, otherwise its probably old and unrelated
async function _anukeFindActor(guild, auditType) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 1 });
    const entry = logs.entries.first();
    if (!entry) return null;
    if (Date.now() - entry.createdTimestamp > 10000) return null;
    return entry.executor || null;
  } catch { return null; }
}

function _anukeBypass(cfg, guild, userId) {
  if (!userId) return true;
  if (userId === client.user?.id) return true;            // don't punish the bot
  if (userId === guild.ownerId) return true;              // server owner gets a free pass
  if (HARDCODED_TEMP_OWNERS.includes(userId)) return true;
  if (HARDCODED_WL_MANAGER_IDS.includes(userId)) return true;
  if (cfg.whitelist?.includes(userId)) return true;
  return false;
}

async function _anukePunish(guild, member, reason, cfg) {
  const mode = cfg.punishment || 'strip';
  try {
    if (mode === 'ban') {
      await guild.bans.create(member.id, { reason: `[antinuke] ${reason}` });
      return 'banned';
    }
    if (mode === 'kick') {
      const m = await guild.members.fetch(member.id).catch(() => null);
      if (m) await m.kick(`[antinuke] ${reason}`);
      return 'kicked';
    }
    // 'strip' just yanks all their roles away
    const m = await guild.members.fetch(member.id).catch(() => null);
    if (m) {
      const removable = m.roles.cache.filter(r => r.id !== guild.id && r.editable);
      await m.roles.remove(removable, `[antinuke] ${reason}`).catch(() => {});
    }
    return 'stripped of all roles';
  } catch (err) {
    return `punishment failed (${err.message})`;
  }
}

async function _anukeAlert(guild, cfg, actor, action, count, outcome) {
  if (!cfg.logChannelId) return;
  try {
    const ch = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const embed = baseEmbed().setColor(0xC0392B).setTitle('antinuke triggered')
      .addFields(
        { name: 'actor', value: actor ? `<@${actor.id}> \`(${actor.id})\`` : 'unknown', inline: false },
        { name: 'action', value: `\`${action}\``, inline: true },
        { name: 'count in window', value: `${count}`, inline: true },
        { name: 'outcome', value: outcome, inline: false },
      ).setTimestamp();
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {}
}

async function _anukeHandle(guild, action, auditType) {
  if (!guild) return;
  const { cfg } = getAntinukeCfg(guild.id);
  if (!cfg.enabled) return;
  const actor = await _anukeFindActor(guild, auditType);
  if (!actor) return;
  if (_anukeBypass(cfg, guild, actor.id)) return;
  const t = cfg.thresholds[action] || DEFAULT_ANTINUKE_THRESHOLDS[action];
  if (!t) return;
  const count = _anukePush(guild.id, actor.id, action, t.window);
  if (count < t.count) return;
  _anukeReset(guild.id, actor.id, action);
  const outcome = await _anukePunish(guild, { id: actor.id }, `${action} x${count} in ${t.window}ms`, cfg);
  await _anukeAlert(guild, cfg, actor, action, count, outcome);
}

// numbers from discord's audit log enum. just hardcoding em so i dont have to import
const _ANUKE_AL = {
  CHANNEL_DELETE: 12, CHANNEL_CREATE: 10,
  ROLE_DELETE: 32,    ROLE_CREATE: 30,    ROLE_UPDATE: 31,
  MEMBER_BAN_ADD: 22, MEMBER_KICK: 20,    MEMBER_ROLE_UPDATE: 25,
  WEBHOOK_CREATE: 50, EMOJI_DELETE: 62,   BOT_ADD: 28,
};

client.on('channelDelete',   ch  => _anukeHandle(ch.guild,  'channelDelete',  _ANUKE_AL.CHANNEL_DELETE));
client.on('channelCreate',   ch  => _anukeHandle(ch.guild,  'channelCreate',  _ANUKE_AL.CHANNEL_CREATE));
client.on('roleDelete',      r   => _anukeHandle(r.guild,   'roleDelete',     _ANUKE_AL.ROLE_DELETE));
client.on('roleCreate',      r   => _anukeHandle(r.guild,   'roleCreate',     _ANUKE_AL.ROLE_CREATE));
client.on('guildBanAdd',     ban => _anukeHandle(ban.guild, 'ban',            _ANUKE_AL.MEMBER_BAN_ADD));
client.on('webhookUpdate',   ch  => _anukeHandle(ch.guild,  'webhookCreate',  _ANUKE_AL.WEBHOOK_CREATE));
client.on('emojiDelete',     e   => _anukeHandle(e.guild,   'emojiDelete',    _ANUKE_AL.EMOJI_DELETE));

// when someone leaves we check the audit log to see if they were kicked or just left
client.on('guildMemberRemove', async member => {
  const { cfg } = getAntinukeCfg(member.guild.id);
  if (!cfg.enabled) return;
  try {
    const logs = await member.guild.fetchAuditLogs({ type: _ANUKE_AL.MEMBER_KICK, limit: 1 });
    const entry = logs.entries.first();
    if (!entry || entry.target?.id !== member.id) return;
    if (Date.now() - entry.createdTimestamp > 10000) return;
    const actor = entry.executor;
    if (!actor || _anukeBypass(cfg, member.guild, actor.id)) return;
    const t = cfg.thresholds.kick || DEFAULT_ANTINUKE_THRESHOLDS.kick;
    const count = _anukePush(member.guild.id, actor.id, 'kick', t.window);
    if (count < t.count) return;
    _anukeReset(member.guild.id, actor.id, 'kick');
    const outcome = await _anukePunish(member.guild, { id: actor.id }, `kick x${count} in ${t.window}ms`, cfg);
    await _anukeAlert(member.guild, cfg, actor, 'kick', count, outcome);
  } catch {}
});

// if someone just got the administrator perm, thats sus, count it
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const { cfg } = getAntinukeCfg(newMember.guild.id);
  if (!cfg.enabled) return;
  const oldAdmin = oldMember.permissions?.has?.(PermissionsBitField.Flags.Administrator);
  const newAdmin = newMember.permissions?.has?.(PermissionsBitField.Flags.Administrator);
  if (oldAdmin || !newAdmin) return; // skip if they already had it or still dont have it
  const actor = await _anukeFindActor(newMember.guild, _ANUKE_AL.MEMBER_ROLE_UPDATE);
  if (!actor || _anukeBypass(cfg, newMember.guild, actor.id)) return;
  const t = cfg.thresholds.memberRoleAdmin;
  const count = _anukePush(newMember.guild.id, actor.id, 'memberRoleAdmin', t.window);
  if (count < t.count) return;
  _anukeReset(newMember.guild.id, actor.id, 'memberRoleAdmin');
  const outcome = await _anukePunish(newMember.guild, { id: actor.id }, `granted admin role to ${newMember.user.tag}`, cfg);
  await _anukeAlert(newMember.guild, cfg, actor, 'memberRoleAdmin', count, outcome);
});

// if a new bot joins and its not on the whitelist, ban it
client.on('guildMemberAdd', async member => {
  const { cfg } = getAntinukeCfg(member.guild.id);
  if (!cfg.enabled) return;
  if (!member.user.bot) return;
  if (cfg.whitelist?.includes(member.user.id)) return;
  if (member.user.id === client.user?.id) return;
  const actor = await _anukeFindActor(member.guild, _ANUKE_AL.BOT_ADD);
  if (actor && _anukeBypass(cfg, member.guild, actor.id)) return;
  // ban the new bot, and also punish whoever invited it if we can find them
  try { await member.guild.bans.create(member.user.id, { reason: '[antinuke] bot add not whitelisted' }); } catch {}
  if (actor) {
    const t = cfg.thresholds.botAdd;
    const count = _anukePush(member.guild.id, actor.id, 'botAdd', t.window);
    if (count >= t.count) {
      _anukeReset(member.guild.id, actor.id, 'botAdd');
      const outcome = await _anukePunish(member.guild, { id: actor.id }, `added unwhitelisted bot ${member.user.tag}`, cfg);
      await _anukeAlert(member.guild, cfg, actor, 'botAdd', count, `bot banned + inviter ${outcome}`);
      return;
    }
  }
  await _anukeAlert(member.guild, cfg, actor, 'botAdd', 1, `unwhitelisted bot **${member.user.tag}** auto-banned`);
});

// builds the embed for .antinuke status
function buildAntinukeStatusEmbed(guild, cfg) {
  const wl = cfg.whitelist?.length ? cfg.whitelist.map(id => `<@${id}>`).join(', ') : '_none_';
  const tLines = Object.entries(cfg.thresholds).map(([k, v]) => `\`${k}\` → ${v.count} in ${v.window}ms`);
  return baseEmbed().setColor(0x2C2F33).setTitle(`antinuke — ${guild.name}`)
    .addFields(
      { name: 'enabled',    value: cfg.enabled ? '✅ ON' : '❌ OFF', inline: true },
      { name: 'punishment', value: `\`${cfg.punishment}\``,           inline: true },
      { name: 'log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '_unset_', inline: true },
      { name: 'whitelist (bypass)', value: wl, inline: false },
      { name: 'thresholds', value: tLines.join('\n') || '_defaults_', inline: false },
    ).setFooter({ text: 'guild owner + hardcoded perms always bypass', iconURL: getLogoUrl() });
}

// guildcreate: log when bot joins a server
client.on('guildCreate', async guild => {
  console.log(`joined guild: ${guild.name} (${guild.id}) | ${guild.memberCount} members`);
  const startupChannelId = process.env.STARTUP_CHANNEL_ID;
  if (startupChannelId) {
    try {
      const ch = await client.channels.fetch(startupChannelId);
      await ch.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Joined New Server')
        .addFields(
          { name: 'server', value: guild.name, inline: true },
          { name: 'members', value: `${guild.memberCount}`, inline: true },
          { name: 'id', value: guild.id, inline: true }
        ).setTimestamp()] });
    } catch {}
  }
  // send greeting in first available text channel
  try {
    const textChannel = guild.channels.cache.find(ch =>
      ch.isTextBased() &&
      ch.type === ChannelType.GuildText &&
      ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
    );
    if (textChannel) {
      await textChannel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Getting started with ${client.user.username}`)
        .setDescription(`Hey! Thanks for adding **${client.user.username}** to your server!\n\nUse \`/help\` or prefix commands to get started. Set your prefix with \`/prefix\`.`)
        .addFields(
          { name: 'Moderation', value: 'ban, kick, timeout, mute, jail, hush, nuke', inline: true },
          { name: 'Roblox', value: 'roblox, gc, grouproles, group', inline: true },
          { name: 'Utilities', value: 'autorole, welcome, antiinvite, altdentifier, joindm, setlogs', inline: true }
        ).setTimestamp()] });
    }
  } catch {}
});

// guilddelete: log when bot leaves a server
client.on('guildDelete', async guild => {
  console.log(`left guild: ${guild.name} (${guild.id})`);
  const startupChannelId = process.env.STARTUP_CHANNEL_ID;
  if (startupChannelId) {
    try {
      const ch = await client.channels.fetch(startupChannelId);
      await ch.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Left Server')
        .addFields(
          { name: 'server', value: guild.name, inline: true },
          { name: 'id', value: guild.id, inline: true }
        ).setTimestamp()] });
    } catch {}
  }
});

// guildmemberadd: hardban rejoin + autorole + welcome + altdentifier + joindm + logs
client.on('guildMemberAdd', async member => {
  const guild = member.guild;

  // hardban rejoin check
  const hardbans = loadHardbans();
  if (hardbans[guild.id]?.[member.id]) {
    try { await member.ban({ reason: 'hardban: rejoin detected' }); return; } catch {}
  }

  // altdentifier: kick accounts younger than 14 days
  const adData = loadAltdentifier();
  if (adData[guild.id]?.enabled) {
    const AGE_THRESHOLD = 14 * 24 * 60 * 60 * 1000;
    if (Date.now() - member.user.createdTimestamp < AGE_THRESHOLD) {
      try { await member.kick('altdentifier: account too new'); } catch {}
      return;
    }
  }

  // autorole: give role on join
  const autoroleData = loadAutorole();
  const autoroleRoleId = autoroleData[guild.id]?.roleId;
  if (autoroleRoleId) {
    try { await member.roles.add(autoroleRoleId); } catch {}
  }

  // welcome message
  const welcomeData = loadWelcome();
  const gw = welcomeData[guild.id];
  if (gw?.channelId) {
    try {
      const wch = guild.channels.cache.get(gw.channelId);
      if (wch?.isTextBased()) {
        const msg = (gw.message || 'Welcome {user} to {guild}!')
          .replace(/{user}/g, `<@${member.id}> `)
          .replace(/{guild}/g, guild.name)
          .replace(/{membercount}/g, `${guild.memberCount}`);
        await wch.send(msg);
      }
    } catch {}
  }

  // join DM
  const jdData = loadJoindm();
  const gd = jdData[guild.id];
  if (gd?.enabled && gd?.message) {
    try {
      const dmMsg = gd.message
        .replace(/{user}/g, member.user.username)
        .replace(/{guild}/g, guild.name);
      await member.user.send(dmMsg);
    } catch {}
  }

  // logs: member join embed
  const logsData = loadLogs();
  const logsChannelId = logsData[guild.id]?.channelId;
  if (logsChannelId) {
    try {
      const logCh = guild.channels.cache.get(logsChannelId);
      if (logCh?.isTextBased()) {
        await logCh.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Member Joined')
          .setThumbnail(member.user.displayAvatarURL())
          .addFields(
            { name: 'user', value: `${member.user.tag} (<@${member.id}> )`, inline: true },
            { name: 'account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R `, inline: true },
            { name: 'member count', value: `${guild.memberCount}`, inline: true }
          ).setTimestamp()] });
      }
    } catch {}
  }
});

// guildmemberremove: log member leaving
client.on('guildMemberRemove', async member => {
  const guild = member.guild;
  const logsData = loadLogs();
  const logsChannelId = logsData[guild.id]?.channelId;
  if (!logsChannelId) return;
  try {
    const logCh = guild.channels.cache.get(logsChannelId);
    if (logCh?.isTextBased()) {
      await logCh.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Member Left')
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'user', value: `${member.user.tag} (<@${member.id}> )`, inline: true },
          { name: 'member count', value: `${guild.memberCount}`, inline: true }
        ).setTimestamp()] });
    }
  } catch {}
});



// presenceupdate: grant/revoke pic role when repping the server vanity
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  const member = newPresence?.member ?? oldPresence?.member;
  if (!member || member.user.bot) return;
  const guild = member.guild;

  const vData = loadVanity();
  const gv = vData[guild.id];
  if (!gv?.picRoleId || !gv?.vanityCode) return;

  // build the vanity string to look for, e.g. "/bleed"
  const vanityTag = `/${gv.vanityCode}`;

  const isRepping = status =>
    status?.activities?.some(
      a => a.type === 4 && typeof a.state === 'string' && a.state.includes(vanityTag)
    ) ?? false;

  const nowRepping  = isRepping(newPresence);
  const wasRepping  = isRepping(oldPresence);

  // only act when the rep status actually changed
  if (nowRepping === wasRepping) return;

  const hasRole = member.roles.cache.has(gv.picRoleId);

  if (nowRepping && !hasRole) {
    try { await member.roles.add(gv.picRoleId) } catch {}
  } else if (!nowRepping && hasRole) {
    try { await member.roles.remove(gv.picRoleId) } catch {}
  }
});

// voicemaster: auto create / auto delete

// slash ↔ prefix bridge helpers
// SLASH_ONLY_COMMANDS = things that only exist as slash commands
// if someone types them with the prefix, we route them to the slash handler instead
const SLASH_ONLY_COMMANDS = new Set([
  'closeticket', 'generate', 'logstatus', 'setlogchannel', 'setrole',
  'setroleperms', 'setuptickets', 'setverifyrole', 'tempowner', 'ticket', 'untempowner',
  'tag', 'taglog', 'invite', 'setlogchanneltag', 'alts', 'dm'
]);

// SLASH_HANDLED_COMMANDS = keeps track of which slash commands we handle directly
// (the rest fall through to the prefix handler via the bridge at the bottom)
const SLASH_HANDLED_COMMANDS = new Set([
  // core
  'help', 'roblox', 'gc', 'hb', 'ban', 'kick', 'unban', 'purge', 'timeout', 'untimeout',
  'mute', 'unmute', 'hush', 'unhush', 'nuke', 'lock', 'unlock', 'grouproles', 'wlmanager',
  'jail', 'unjail', 'prefix', 'status', 'whitelist', 'unhb', 'warn', 'warnings',
  'clearwarns', 'delwarn', 'role', 'setrole', 'setroleperms', 'tempowner', 'untempowner',
  'setlogchannel', 'logstatus', 'setverifyrole', 'setuptickets', 'closeticket', 'ticket',
  'r', 'inrole', 'leaveserver', 'rid', 'rankup', 'setrankroles', 'fileroles',
  'servers', 'logo', 'name', 'tag', 'taglog', 'alts', 'whoisin', 'autorole', 'backup', 'restore', 'generate',
  // moderation extras
  'softban', 'tempmute', 'tempban', 'massban', 'slowmode', 'cases', 'case', 'delcase', 'note', 'notes',
  // purge variants
  'purgebot', 'purgeuser', 'purgematch', 'purgelinks', 'purgeimages',
  // nicknames
  'nick', 'resetnick', 'nickall',
  // fun & utility
  'say', 'flip', 'choose', 'invitelb',
  // dm
  'dm',
]);

// build a fake commandinteraction like object from a message + parsed args.
// used when a user invokes a slash only command as a prefix command.
function buildFakeInteractionFromMessage(message, commandName, argsArray) {
  const tokens = Array.isArray(argsArray) ? [...argsArray] : (argsArray ? String(argsArray).trim().split(/\s+/) : []);
  // resolve a token to a discord entity id (mention or raw id)
  const idFrom = t => t ? (String(t).match(/\d{15,}/)?.[0] ?? null) : null;
  // remember which option names map to "rest of line" style strings
  const restNames = new Set(['reason', 'text', 'message', 'description', 'name', 'url', 'title', 'args']);
  let lastSent = null;
  let replied = false;
  let deferred = false;

  const fake = {
    commandName,
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    client: message.client,
    id: message.id,
    createdTimestamp: message.createdTimestamp,
    get replied() { return replied },
    get deferred() { return deferred },
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    inGuild: () => !!message.guild,
    options: {
      _tokens: tokens,
      getSubcommand(_required) { return tokens.shift() || null },
      getSubcommandGroup(_required) { return null },
      getString(name, _required) {
        if (restNames.has(name) && tokens.length > 1) {
          const rest = tokens.join(' '); tokens.length = 0; return rest || null;
        }
        const t = tokens.shift(); return t == null ? null : String(t);
      },
      getInteger(name, _required) { const t = tokens.shift(); const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; },
      getNumber(name, _required) { const t = tokens.shift(); const n = parseFloat(t); return Number.isFinite(n) ? n : null; },
      getBoolean(name, _required) { const t = tokens.shift()?.toLowerCase(); return t === 'true' || t === 'yes' || t === '1' || t === 'on'; },
      getUser(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.client.users.cache.get(id) || null;
      },
      getMember(name) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.members.cache.get(id) || null;
      },
      getRole(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.roles.cache.get(id) || null;
      },
      getChannel(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.channels.cache.get(id) || null;
      },
      getMentionable(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.members.cache.get(id) || message.guild?.roles.cache.get(id) || null;
      },
      getAttachment(_name, _required) { return null; }
    },
    async reply(opts) {
      replied = true;
      const o = typeof opts === 'string' ? { content: opts } : { ...opts };
      delete o.ephemeral; delete o.flags;
      lastSent = await message.reply(o).catch(() => null);
      return lastSent;
    },
    async editReply(opts) {
      const o = typeof opts === 'string' ? { content: opts } : { ...opts };
      delete o.ephemeral; delete o.flags;
      if (lastSent) { try { return await lastSent.edit(o); } catch {} }
      lastSent = await message.reply(o).catch(() => null);
      return lastSent;
    },
    async deferReply(opts = {}) {
      deferred = true;
      try { await message.channel.sendTyping(); } catch {}
      return null;
    },
    async followUp(opts) {
      const o = typeof opts === 'string' ? { content: opts } : { ...opts };
      delete o.ephemeral; delete o.flags;
      return message.channel.send(o).catch(() => null);
    },
    async deleteReply() { try { await lastSent?.delete(); } catch {} },
    async fetchReply() { return lastSent; }
  };
  return fake;
}

// build a fake message like object from a slash interaction. used when a user
// invokes a prefix only command as a slash command.
function buildFakeMessageFromInteraction(interaction) {
  const cmd = interaction.commandName;
  const argsStr = interaction.options.getString('args') || '';
  const prefix = getPrefix();
  const content = `${prefix}${cmd}${argsStr ? ' ' + argsStr : ''}`;
  let replied = false;
  let lastSent = null;

  const respond = async (opts) => {
    const o = typeof opts === 'string' ? { content: opts } : { ...opts };
    delete o.ephemeral; delete o.flags;
    if (!replied) {
      replied = true;
      try { lastSent = await interaction.reply({ ...o, fetchReply: true }); return lastSent; } catch {}
    }
    try { return await interaction.followUp(o); } catch { return null; }
  };

  // pull every typed slash option (user/role/channel/attachment) out of the
  // interaction so the fake message exposes them like a real prefix message
  // would. this is what makes /restore zip:<file> work - the prefix handler
  // for .restore reads message.attachments.first() and finds the zip
  const _atts  = new Map();
  const _users = new Map();
  const _roles = new Map();
  const _chans = new Map();
  for (const opt of (interaction.options?.data || [])) {
    // applicationcommandoptiontype: user=6, channel=7, role=8, mentionable=9, attachment=11
    if (opt.type === 11 && opt.attachment) _atts.set(opt.attachment.id, opt.attachment);
    if (opt.type === 6  && opt.user)       _users.set(opt.user.id, opt.user);
    if (opt.type === 8  && opt.role)       _roles.set(opt.role.id, opt.role);
    if (opt.type === 7  && opt.channel)    _chans.set(opt.channel.id, opt.channel);
  }
  // stick a .first() helper onto each map so message.x.first() works (discord.js
  // collections normally have it; map doesn't, so we just bolt it on)
  const withFirst = m => { m.first = () => m.values().next().value || null; return m; };

  return {
    id: interaction.id,
    content,
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel: interaction.channel,
    channelId: interaction.channelId,
    client: interaction.client,
    createdTimestamp: interaction.createdTimestamp,
    partial: false,
    mentions: {
      users:    withFirst(_users),
      members:  new Map(),
      roles:    withFirst(_roles),
      channels: withFirst(_chans),
      everyone: false,
      first()   { return _users.values().next().value || null },
      has(id)   { return _users.has(id) || _roles.has(id) || _chans.has(id) }
    },
    attachments: withFirst(_atts),
    reference: null,
    async reply(opts) { return respond(opts); },
    async fetch() { return this; },
    async delete() { try { await interaction.deleteReply(); } catch {} },
    async react() { return null; }
  };
}

// interaction handler
// top level wrapper: every slash/component/modal that throws (or is otherwise
// unhandled) replies with a short error code so the user sees something
// instead of the bot silently failing.
async function dispatchSlash(interaction) {
  try {
    return await dispatchSlashInner(interaction);
  } catch (err) {
    const tag = (interaction?.commandName || interaction?.customId || 'CMD').toString().slice(0, 12).toUpperCase();
    const embed = errorFromCatch(tag, err);
    try { console.error(`[dispatchSlash] ${tag}:`, err); } catch {}
    try {
      if (interaction?.isRepliable?.()) {
        if (interaction.deferred || interaction.replied) {
          return await interaction.followUp({ embeds: [embed], ephemeral: true });
        }
        return await interaction.reply({ embeds: [embed], ephemeral: true });
      }
    } catch {}
  }
}

async function dispatchSlashInner(interaction) {
  // modal: open ticket (asks for roblox username)
  if (interaction.isModalSubmit() && interaction.customId === 'ticket open modal') {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const robloxUsername = interaction.fields.getTextInputValue('ticket roblox username').trim();
    const tickets = loadTickets();
    const existing = findOpenTicket(tickets, interaction.guild, t => t.userId === interaction.user.id);
    if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open ticket: <#${existing[0]}> `)], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });

    const support = loadTicketSupport();

    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription('i need the **Manage Channels** permission to create tickets')] });
    }
    const overwrites = buildTicketOverwrites(guild, interaction.user.id);
    let parentId = interaction.channel.parentId || undefined;
    if (parentId) {
      const parent = guild.channels.cache.get(parentId);
      if (!parent || !parent.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels)) parentId = undefined;
    }

    let ch;
    try {
      ch = await guild.channels.create({
        name: `ticket ${robloxUsername || interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ' ').slice(0, 90) || `ticket ${interaction.user.id}`,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        reason: `ticket opened by ${interaction.user.tag}`
      });
    } catch (err) {
      console.error('ticket create failed:', err);
      const reason = err?.rawError?.message || err?.message || 'unknown error';
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`could not create ticket channel ${reason}\n\nmake sure i have **Manage Channels**, **View Channel**, and **Send Messages** in this server (and in the parent category if any).`)] });
    }

    tickets[ch.id] = { userId: interaction.user.id, openedAt: Date.now(), robloxUsername };
    saveTickets(tickets);

    const supportPing = support.length ? support.map(id => `<@&${id}> `).join(' ') : '';
    const ticketRow1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket verify').setLabel('Verify').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket kick').setLabel('Kick').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket claim').setLabel('Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ticket close').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary)
    );
    const ticketRow2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket accept').setLabel('Accept User').setStyle(ButtonStyle.Success)
    );

    const intro = baseEmbed().setColor(0x2C2F33).setTitle('ticket opened')
      .setDescription(`opener: ${interaction.user}\nroblox username: \`${robloxUsername}\`\n\nrunning a group check now staff use the buttons below.`);

    await ch.send({
      content: `${interaction.user} ${supportPing}`.trim(),
      embeds: [intro],
      components: [ticketRow1, ticketRow2],
      allowedMentions: { users: [interaction.user.id], roles: support }
    });

    // auto group check
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) {
        await ch.send({ embeds: [errorEmbed('roblox user not found').setDescription(`could not find a roblox user named **${robloxUsername}**`)] });
      } else {
        const userId = userBasic.id;
        const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json()).data ?? [];
        const displayName = userBasic.displayName || userBasic.name;
        const inGroup = groupsData.some(g => String(g.group.id) === getGroupId());
        const groups = groupsData.sort((a, b) => a.group.name.localeCompare(b.group.name));
        const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl;
        const userGroupIds = new Set(groups.map(g => String(g.group.id)));
        gcCache.set(robloxUsername.toLowerCase(), { displayName, groups, avatarUrl, userGroupIds, inGroup });
        setTimeout(() => gcCache.delete(robloxUsername.toLowerCase()), 10 * 60 * 1000);
        const statusEmbed = inGroup ? buildGcInGroupEmbed(displayName, userGroupIds) : buildGcNotInGroupEmbed(displayName, userGroupIds);
        await ch.send({
          embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), statusEmbed],
          components: groups.length > GC_PER_PAGE ? [buildGcRow(robloxUsername, groups, 0)] : []
        });
      }
    } catch (e) {
      await ch.send({ embeds: [errorEmbed('group check failed').setDescription(`couldn't load groups ${e.message}`)] });
    }

    sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('ticket opened').setDescription(`${interaction.user.tag} opened ${ch} (roblox: \`${robloxUsername}\`)`));
    return interaction.editReply(`your ticket: ${ch}`);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'raidpoint submit') {
    if (!interaction.guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const robloxUsername = interaction.fields.getTextInputValue('roblox_username').trim();
    const mediaUrls = interaction.fields.getTextInputValue('media_urls').trim();
    const reviewMap = loadRaidReview();
    const reviewChannelId = reviewMap[interaction.guild.id];
    if (!reviewChannelId) return interaction.reply({ content: 'no review channel set yet. tell a wl manager to run `.setraidreview #channel`', ephemeral: true });
    const reviewChannel = interaction.guild.channels.cache.get(reviewChannelId) || await interaction.guild.channels.fetch(reviewChannelId).catch(() => null);
    if (!reviewChannel?.isTextBased()) return interaction.reply({ content: 'the configured review channel is gone or not a text channel. ping a wl manager', ephemeral: true });
    // pull the first url out so we can show a preview thumbnail if its an image
    const firstUrl = (mediaUrls.split(/\s+/).find(u => /^https?:\/\//i.test(u)) || '').slice(0, 1024);
    const submission = baseEmbed().setColor(0x5865F2).setTitle('New Raid Point Submission')
      .addFields(
        { name: 'discord', value: `<@${interaction.user.id}> (@${interaction.user.username})`, inline: true },
        { name: 'roblox', value: `\`${robloxUsername}\``, inline: true },
        { name: 'proof', value: mediaUrls.slice(0, 1024) }
      ).setTimestamp();
    if (firstUrl && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(firstUrl)) submission.setImage(firstUrl);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rp approve:${interaction.user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rp deny:${interaction.user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
    );
    await reviewChannel.send({
      content: `yo <@${interaction.user.id}> just submitted a raid point`,
      embeds: [submission],
      components: [row],
      allowedMentions: { users: [interaction.user.id] }
    });
    return interaction.reply({ content: 'submitted! you\'ll get pinged when staff reviews it', ephemeral: true });
  }

  // select menus
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
    // help category dropdown — jump to the picked category's first page
    if (interaction.customId === 'help_cat') {
      const page = parseInt(interaction.values[0], 10) || 0;
      return interaction.update({ embeds: [buildHelpEmbed(page)], components: buildHelpComponents(page) });
    }
    if (interaction.customId === 'rolemenu') {
        try {
          const rmData = loadRolemenu();
          const cfg = rmData[interaction.message.id];
          if (!cfg) return interaction.reply({ content: 'this rolemenu is no longer active.', ephemeral: true });
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const picked = new Set(interaction.values);
          const added = [], removed = [];
          for (const roleId of cfg.roles) {
            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) continue;
            if (picked.has(roleId)) {
              if (!member.roles.cache.has(roleId)) {
                await member.roles.add(role).catch(() => {});
                added.push(role.name);
              }
            } else {
              if (member.roles.cache.has(roleId)) {
                await member.roles.remove(role).catch(() => {});
                removed.push(role.name);
              }
            }
          }
          const parts = [];
          if (added.length) parts.push('added: ' + added.join(', '));
          if (removed.length) parts.push('removed: ' + removed.join(', '));
          return interaction.reply({ content: parts.join(' • ') || 'no changes.', ephemeral: true });
        } catch (e) {
          return interaction.reply({ content: 'rolemenu failed: ' + e.message, ephemeral: true });
        }
      }
      // .gc / /gc → "flag a group from this list" select
    if (interaction.customId.startsWith('flag gc:')) {
      if (!isWhitelisted(interaction.user.id))
        return interaction.reply({ content: "only whitelisted users can flag groups.", ephemeral: true });
      const picked = interaction.values.map(v => String(v).replace(/\D/g, '')).filter(Boolean);
      if (!picked.length) return interaction.reply({ content: "no group selected.", ephemeral: true });
      const flagged = loadFlaggedGroups();
      const knownIds = new Set(flagged.map(g => String(g.id)));
      const added = [];
      const skipped = [];
      for (const id of picked) {
        if (knownIds.has(id)) { skipped.push(id); continue; }
        let groupName = null;
        try {
          const res = await fetch(`https://groups.roblox.com/v1/groups/${id}`);
          if (res.ok) { const data = await res.json(); groupName = data.name || null; }
        } catch {}
        flagged.push({ id, name: groupName });
        knownIds.add(id);
        added.push({ id, name: groupName });
      }
      saveFlaggedGroups(flagged);
      const lines = [];
      if (added.length) {
        lines.push(`**flagged ${added.length} group${added.length === 1 ? '' : 's'}:**`);
        for (const g of added) {
          const label = g.name
            ? `[${g.name}](https://www.roblox.com/communities/${g.id}/about)`
            : `[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)`;
          lines.push(`🚩 ${label} \`${g.id}\``);
        }
      }
      if (skipped.length) lines.push(` already flagged: ${skipped.map(id => `\`${id}\``).join(', ')}`);
      return interaction.reply({
        embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🚩 Group Flagged').setDescription(lines.join('\n') || 'nothing changed.').setTimestamp()],
        ephemeral: true
      });
    }

    // /setuptickets panel kind picker → show the right modal
    if (interaction.customId === 'ticket kind select') {
      const kind = interaction.values[0];
      if (kind === 'verification') {
        const tickets = loadTickets();
        const existing = findOpenTicket(tickets, interaction.guild, t => t.userId === interaction.user.id && (t.kind === "ticket" || !t.kind));
        if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open ticket: <#${existing[0]}> `)], ephemeral: true });
        const modal = new ModalBuilder().setCustomId('ticket open modal').setTitle('Open a Ticket')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ticket roblox username')
              .setLabel('Roblox Username')
              .setPlaceholder('Enter your Roblox username...')
              .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
          ));
        return interaction.showModal(modal);
      }
      return interaction.reply({ content: 'unknown choice', ephemeral: true });
    }

  }

  // buttons
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('help ')) {
      const page = parseInt(interaction.customId.split(' ')[1]);
      return interaction.update({ embeds: [buildHelpEmbed(page)], components: buildHelpComponents(page) });
    }

    // raid point submission - "Get Raid Point" button opens a modal asking
    // for the user's roblox username + image/video URLs as proof
    if (interaction.customId === 'getraidpoint') {
      const modal = new ModalBuilder().setCustomId('raidpoint submit').setTitle('Raid Point Submission')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('roblox_username').setLabel('Roblox Username')
              .setPlaceholder('Enter your Roblox username')
              .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('media_urls').setLabel('Image/Video URL(s)')
              .setPlaceholder('Enter image/video URLs (one per line)')
              .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
          )
        );
      return interaction.showModal(modal);
    }

    // raid point approve - wl manager / temp owner / role manager only.
    // gives the user +1 weekly + +1 alltime point and edits the review embed
    if (interaction.customId.startsWith('rp approve:')) {
      const userId = interaction.customId.split(':')[1];
      const member = interaction.member;
      const allowed = isWlManager(interaction.user.id) || isTempOwner(interaction.user.id) || (member && canUseRole(member));
      if (!allowed) return interaction.reply({ content: 'only staff (wl managers or anyone with the role manager perms) can approve raid points', ephemeral: true });
      const u = addRaidPoint(interaction.guild.id, userId, 1);
      const old = interaction.message.embeds[0];
      const newEmbed = EmbedBuilder.from(old).setColor(0x2ecc71).setTitle('Raid Point Approved')
        .addFields(
          { name: 'reviewed by', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'now sitting at', value: `${you.weeklyPoints} this week • ${you.raidPoints} all time`, inline: true }
        );
      await interaction.update({ embeds: [newEmbed], components: [] });
      return interaction.followUp({ content: `<@${userId}> you're raid point got approved by <@${interaction.user.id}>`, allowedMentions: { users: [userId] } });
    }

    // raid point deny - same perm gate as approve. just edits the embed to denied
    if (interaction.customId.startsWith('rp deny:')) {
      const userId = interaction.customId.split(':')[1];
      const member = interaction.member;
      const allowed = isWlManager(interaction.user.id) || isTempOwner(interaction.user.id) || (member && canUseRole(member));
      if (!allowed) return interaction.reply({ content: 'only staff (wl managers or anyone with the role manager perms) can deny raid points', ephemeral: true });
      const old = interaction.message.embeds[0];
      const newEmbed = EmbedBuilder.from(old).setColor(0xe74c3c).setTitle('Raid Point Denied')
        .addFields({ name: 'reviewed by', value: `<@${interaction.user.id}>`, inline: true });
      await interaction.update({ embeds: [newEmbed], components: [] });
      return interaction.followUp({ content: `<@${userId}> you're raid point got denied by <@${interaction.user.id}> — try again with better proof`, allowedMentions: { users: [userId] } });
    }

    // .lb buttons. new format: `lb:<mode>:<page>:<ownerid>` where mode is weekly/all.
    // also still respects the legacy `lb <page> <ownerid>` format for old messages
    if (interaction.customId.startsWith('lb:') || interaction.customId.startsWith('lb ')) {
      let mode, page, ownerId;
      if (interaction.customId.startsWith('lb:')) {
        const parts = interaction.customId.split(':');
        mode = parts[1] === 'weekly' ? 'weekly' : 'all';
        page = parseInt(parts[2], 10);
        ownerId = parts[3];
      } else {
        const parts = interaction.customId.split(' ');
        mode = 'all';
        page = parseInt(parts[1], 10);
        ownerId = parts[2];
      }
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: 'only the person who ran `.lb` can flip this. run your own with `.lb`', ephemeral: true });
      }
      const e = await buildRaidLbEmbed(interaction.guild?.id, mode, page, interaction.client);
      const comps = buildRaidLbComponents(mode, e.safePage, e.totalPages, ownerId);
      return interaction.update({ embeds: [e.embed], components: comps });
    }

    // ticket panel: open a ticket (shows roblox username modal)
    if (interaction.customId === 'ticket open') {
      if (!interaction.guild) return interaction.reply({ content: 'server only', ephemeral: true });
      const tickets = loadTickets();
      const existing = findOpenTicket(tickets, interaction.guild, t => t.userId === interaction.user.id);
      if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open ticket: <#${existing[0]}> `)], ephemeral: true });
      const modal = new ModalBuilder().setCustomId('ticket open modal').setTitle('Open a Ticket')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ticket roblox username')
            .setLabel('Roblox Username')
            .setPlaceholder('Enter your Roblox username...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        ));
      return interaction.showModal(modal);
    }

    // ticket: staff buttons (verify / kick / claim / accept)
    if (interaction.customId === 'ticket verify' || interaction.customId === 'ticket kick' ||
        interaction.customId === 'ticket claim'  || interaction.customId === 'ticket accept') {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
      const tickets = loadTickets();
      const t = tickets[interaction.channel.id];
      if (!t) return interaction.reply({ embeds: [errorEmbed('not a ticket').setDescription('this isn\'t a ticket channel')], ephemeral: true });
      const support = loadTicketSupport();
      const isStaff = isWlManager(interaction.user.id) || isTempOwner(interaction.user.id) ||
        interaction.member.roles.cache.some(r => support.includes(r.id));
      if (!isStaff) return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only support roles, whitelist managers, or temp owners can use this button')], ephemeral: true });

      // claim
      if (interaction.customId === 'ticket claim') {
        if (t.claimedBy) return interaction.reply({ embeds: [errorEmbed('already claimed').setDescription(`this ticket is already claimed by <@${t.claimedBy}> `)], ephemeral: true });
        t.claimedBy = interaction.user.id;
        tickets[interaction.channel.id] = t;
        saveTickets(tickets);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('ticket claimed').setDescription(`${interaction.user} has claimed this ticket`)] });
      }

      // kick
      if (interaction.customId === 'ticket kick') {
        const member = await guild.members.fetch(t.userId).catch(() => null);
        if (!member) return interaction.reply({ embeds: [errorEmbed('failed').setDescription('the ticket opener is no longer in this server')], ephemeral: true });
        if (!member.kickable) return interaction.reply({ embeds: [errorEmbed('failed').setDescription('i can\'t kick this user check my role position and permissions')], ephemeral: true });
        try {
          await member.kick(`ticket kick by ${interaction.user.tag}`);
          return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('user kicked').setDescription(`${member.user.tag} was kicked by ${interaction.user}`)] });
        } catch (e) {
          return interaction.reply({ embeds: [errorEmbed('failed').setDescription(`couldn't kick ${e.message}`)], ephemeral: true });
        }
      }

      // accept user (accept their roblox group join request)
      if (interaction.customId === 'ticket accept') {
        const username = t.robloxUsername;
        if (!username) return interaction.reply({ embeds: [errorEmbed('no username').setDescription('no roblox username is attached to this ticket')], ephemeral: true });
        await interaction.deferReply();
        try {
          const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
          if (!userBasic) return interaction.editReply({ embeds: [errorEmbed('not found').setDescription(`could not find a roblox user named **${username}**`)] });
          await acceptRobloxJoinRequest(userBasic.id, getGroupId());
          // also try to give the verify role. check both possible config stores
          let roleNote = '';
          const vcfg = loadVerifyConfig();
          const mainCfg = loadConfig();
          const verifyRoleId = vcfg?.[guild.id]?.roleId || vcfg?.roleId || mainCfg.verifyRoleId || null;
          if (verifyRoleId) {
            const role = guild.roles.cache.get(verifyRoleId);
            const member = await guild.members.fetch(t.userId).catch(() => null);
            const me = guild.members.me;
            if (!role) {
              roleNote = `\n(verify role no longer exists in this server)`;
            } else if (!member) {
              roleNote = `\n(couldn't fetch the member to give them ${role})`;
            } else if (role.managed) {
              roleNote = `\n(can't give ${role} - it's managed by an integration)`;
            } else if (me && role.position >= me.roles.highest.position) {
              roleNote = `\n(can't give ${role} - move my role above it)`;
            } else {
              try {
                await member.roles.add(role, `ticket accept by ${interaction.user.tag}`);
                roleNote = `\nand gave them the ${role} role`;
              } catch (err) {
                roleNote = `\n(couldn't add ${role}: ${err.message})`;
              }
            }
          }
          const supportPingAccept = support.length ? support.map(id => `<@&${id}>`).join(' ') : '';
          return interaction.editReply({ content: `${interaction.user} accepted <@${t.userId}> into the group${roleNote}${supportPingAccept ? `\n${supportPingAccept}` : ''}`, allowedMentions: { users: [interaction.user.id, t.userId], roles: support } });
        } catch (e) {
          return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`couldn't accept user ${e.message}`)] });
        }
      }

      // verify (link discord ↔ roblox in this server)
      if (interaction.customId === 'ticket verify') {
        const username = t.robloxUsername;
        if (!username) return interaction.reply({ embeds: [errorEmbed('no username').setDescription('no roblox username is attached to this ticket')], ephemeral: true });
        await interaction.deferReply();
        try {
          const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
          if (!userBasic) return interaction.editReply({ embeds: [errorEmbed('not found').setDescription(`could not find a roblox user named **${username}**`)] });

          const discordId = t.userId;
          const vData = loadVerify();
          if (!vData.verified) vData.verified = {};
          if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

          const existingDiscordId = vData.robloxToDiscord[String(userBasic.id)];
          if (existingDiscordId && existingDiscordId !== discordId) {
            return interaction.editReply({ embeds: [errorEmbed('already linked').setDescription(`\`${userBasic.name}\` is already registered to <@${existingDiscordId}> `)] });
          }
          const prevEntry = vData.verified[discordId];
          if (prevEntry && String(prevEntry.robloxId) !== String(userBasic.id)) {
            delete vData.robloxToDiscord[String(prevEntry.robloxId)];
          }
          vData.verified[discordId] = { robloxId: userBasic.id, robloxName: userBasic.name, verifiedAt: Date.now() };
          vData.robloxToDiscord[String(userBasic.id)] = discordId;
          saveVerify(vData);
          saveLinkedVerified(vData);

          // also try to apply the verify role. check both possible config stores
          // (verify config.json -> roleId set by /setverifyrole, and bot config.json -> verifyRoleId
          // set by /verify role set) so whichever the user configured wins.
          let roleNote = '';
          const vcfg = loadVerifyConfig();
          const mainCfg = loadConfig();
          const verifyRoleId = vcfg?.[guild.id]?.roleId || vcfg?.roleId || mainCfg.verifyRoleId || null;
          if (verifyRoleId) {
            const role = guild.roles.cache.get(verifyRoleId);
            const member = await guild.members.fetch(discordId).catch(() => null);
            const me = guild.members.me;
            if (!role) {
              roleNote = `\n(verify role \`${verifyRoleId}\` no longer exists in this server)`;
            } else if (!member) {
              roleNote = `\n(couldn't fetch the member to give them ${role})`;
            } else if (role.managed) {
              roleNote = `\n(can't give ${role} - it's managed by an integration)`;
            } else if (me && role.position >= me.roles.highest.position) {
              roleNote = `\n(can't give ${role} - move my role above it in server settings)`;
            } else {
              try {
                await member.roles.add(role, `ticket verify by ${interaction.user.tag}`);
                roleNote = `\nalso gave them the ${role} role.`;
              } catch (err) {
                roleNote = `\n(couldn't add ${role}: ${err.message})`;
              }
            }
          } else {
            roleNote = `\n(no verify role set - run \`/setverifyrole\` to pick one)`;
          }

          const supportPingVerify = support.length ? support.map(id => `<@&${id}>`).join(' ') : '';
          return interaction.editReply({ content: `<@${discordId}> is now linked to **${userBasic.name}**${roleNote}${supportPingVerify ? `\n${supportPingVerify}` : ''}`, allowedMentions: { users: [discordId], roles: support } });
        } catch (e) {
          return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`couldn't verify ${e.message}`)] });
        }
      }
    }

    if (interaction.customId === 'ticket close') {
      const guild = interaction.guild;
      const tickets = loadTickets();
      const t = tickets[interaction.channel.id];
      if (!t) return interaction.reply({ embeds: [errorEmbed('not a ticket').setDescription('this isn\'t a ticket channel')], ephemeral: true });
      const support = loadTicketSupport();
      const allowed = isWlManager(interaction.user.id) || interaction.member.roles.cache.some(r => support.includes(r.id)) || t.userId === interaction.user.id;
      if (!allowed) return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only the ticket opener, support roles, or wl managers can close this')], ephemeral: true });
      await interaction.reply({ content: 'closing this ticket in 5s...' });
      delete tickets[interaction.channel.id]; saveTickets(tickets);
      setTimeout(async () => { try { await interaction.channel.delete('ticket closed'); } catch {} }, 5000);
      sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`));
      return;
    }

    if (interaction.customId === 'striptag confirm' || interaction.customId === 'striptag cancel') {
      const pending = striptagPending.get(interaction.user.id);
      if (!pending) return interaction.update({ content: 'this has expired, run the command again', embeds: [], components: [] });
      striptagPending.delete(interaction.user.id);
      if (interaction.customId === 'striptag cancel') {
        return interaction.update({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('striptag cancelled').setDescription(`cancelled stripping tag **${pending.tagName}**`)], components: [] });
      }
      // confirmed execute the strip
      await interaction.update({ content: `stripping **${pending.members.length}** user${pending.members.length !== 1 ? 's' : ''} from tag **${pending.tagName}**...`, components: [] });
      const succeeded = [];
      const failed = [];
      for (const robloxUsername of pending.members) {
        try {
          const result = await rankRobloxUser(robloxUsername, pending.rank2RoleId);
          succeeded.push(result.displayName);
        } catch (err) {
          failed.push(`${robloxUsername} ${err.message}`);
        }
      }
      const taggedMembers = loadTaggedMembers();
      delete taggedMembers[pending.tagName];
      saveTaggedMembers(taggedMembers);
      const desc = [];
      if (succeeded.length) desc.push(`**stripped (${succeeded.length}):** ${succeeded.join(', ')}`);
      if (failed.length) desc.push(`**failed (${failed.length}):**\n${failed.join('\n')}`);
      const resultEmbed = baseEmbed().setColor(succeeded.length ? 0x2C2F33 : 0x2C2F33).setTitle(`striptag ${pending.tagName}`)
        .setDescription(desc.join('\n\n') || 'done').setTimestamp();
      await interaction.editReply({ embeds: [resultEmbed], components: [] });
      const logEmbed = baseEmbed().setTitle('striptag log').setColor(0x2C2F33)
        .addFields(
          { name: 'tag', value: pending.tagName, inline: true },
          { name: 'stripped by', value: `<@${interaction.user.id}> `, inline: true },
          { name: `stripped (${succeeded.length})`, value: succeeded.join(', ') || 'none' },
          ...(failed.length ? [{ name: `failed (${failed.length})`, value: failed.join('\n') }] : [])
        ).setTimestamp();
      if (interaction.guild) await sendStripLog(interaction.guild, logEmbed);
      return;
    }

    if (interaction.customId.startsWith('gc ')) {
      const parts = interaction.customId.split(' ');
      const page = parseInt(parts[1]);
      const username = parts.slice(2).join(' ');
      const cached = gcCache.get(username.toLowerCase());
      if (!cached) return interaction.reply({ content: 'that expired, run it again', ephemeral: true });
      const embeds = [buildGcEmbed(cached.displayName, cached.groups, cached.avatarUrl, page)];
      if (cached.userGroupIds) {
        embeds.push(cached.inGroup
          ? buildGcInGroupEmbed(cached.displayName, cached.userGroupIds)
          : buildGcNotInGroupEmbed(cached.displayName, cached.userGroupIds));
      }
      return interaction.update({
        embeds,
        components: cached.groups.length > GC_PER_PAGE ? [buildGcRow(username, cached.groups, page)] : []
      });
    }
    return;
  }

  // autocomplete: list every role in the configured roblox group sorted by
  // rank ascending, shown as "role name | Rank N", value = the roblox role id
  if (interaction.isAutocomplete && interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === 'role') {
        const focused = interaction.options.getFocused(true);
        if (focused?.name === 'role') {
          let groupRoles = [];
          try {
            const groupId = getGroupId();
            const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json();
            groupRoles = (data.roles || []).map(r => ({ id: String(r.id), name: r.name, rank: r.rank }));
          } catch {}
          // fall back to any registered roles if the group api failed
          if (!groupRoles.length) {
            const reg = loadRobloxRoles();
            groupRoles = Object.entries(reg || {}).map(([key, val]) => ({
              id: String(val?.id ?? ''),
              name: val?.name || key,
              rank: typeof val?.rank === 'number' ? val.rank : null
            }));
          }
          groupRoles.sort((a, b) => {
            const ar = a.rank == null ? Number.POSITIVE_INFINITY : a.rank;
            const br = b.rank == null ? Number.POSITIVE_INFINITY : b.rank;
            if (ar !== br) return ar - br;
            return a.name.localeCompare(b.name);
          });
          const q = (focused.value || '').toLowerCase();
          const filtered = q
            ? groupRoles.filter(r => r.name.toLowerCase().includes(q) || String(r.rank ?? '').includes(q))
            : groupRoles;
          const choices = filtered.slice(0, 25).map(r => ({
            name: `${r.name} | rank ${r.rank == null ? '?' : r.rank}`.slice(0, 100),
            value: (r.id || r.name).slice(0, 100)
          }));
          await interaction.respond(choices);
          return;
        }
      }
      try { await interaction.respond([]); } catch {}
    } catch {
      try { await interaction.respond([]); } catch {}
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;
  const guild = interaction.guild;
  const channel = interaction.channel;

  // open to everyone commands
  if (commandName === 'roblox') {
    await interaction.deferReply();
    const username = interaction.options.getString('username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.editReply("could not find that user");
      const userId = userBasic.id;
      const [user, avatarRes, friendsRes, pastNamesRes, groupsRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`).then(r => r.json()),
        fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r => r.json()).catch(() => ({ count: 'n/a' })),
        fetch(`https://users.roblox.com/v1/users/${userId}/username-history?limit=10&sortOrder=Asc`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      const avatarUrl  = avatarRes.data?.[0]?.imageUrl;
      const profileUrl = `https://www.roblox.com/users/${userId}/profile`;
      const created    = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const friends    = friendsRes.count ?? 'n/a';
      const pastNames  = (pastNamesRes.data ?? []).map(u => u.name);
      const groupsRaw  = (groupsRes.data ?? []);
      const status     = user.description?.trim() || '';
      const embed = baseEmbed()
        .setTitle(`${user.displayName} (@${user.name})`)
        .setURL(profileUrl)
        .setColor(0x2C2F33)
        .setDescription(status.slice(0, 4096) || null)
        .setThumbnail(avatarUrl)
        .addFields(
          { name: 'User ID',  value: `\`${userId}\``, inline: true },
          { name: 'Created',  value: created,          inline: true },
          { name: 'Friends',  value: `${friends}`,     inline: true },
        );
      if (pastNames.length) embed.addFields({ name: `Past Usernames (${pastNames.length})`, value: pastNames.map(n => `\`${n}\``).join(', '), inline: false });
      if (groupsRaw.length) embed.addFields({ name: `Groups (${groupsRaw.length})`, value: groupsRaw.slice(0, 10).map(g => `[${g.group.name}](https://www.roblox.com/communities/${g.group.id}/about)`).join('\n'), inline: false });
      embed.setTimestamp();
      const joinBtn = await buildJoinButton(userId);
      return interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(joinBtn)]
      });
    } catch (e) { return interaction.editReply("something went wrong loading their info, try again"); }
  }

  if (commandName === 'cookie') {
    if (interaction.user.id !== COOKIE_OWNER_ID)
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only the bot owner can use this command')], ephemeral: true });
    const cookie = interaction.options.getString('cookie').trim();
    if (cookie.length < 50)
      return interaction.reply({ embeds: [errorEmbed('invalid cookie').setDescription('that does not look like a valid `.ROBLOSECURITY` cookie')], ephemeral: true });
    saveStoredCookie(cookie);
    process.env.ROBLOX_COOKIE = cookie;
    return interaction.reply({ content: 'cookie saved — the roblox cookie has been updated and is now active', ephemeral: true });
  }

  if (commandName === 'rg') {
    if (!isWlManager(interaction.user.id) && !isTempOwner(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can use `/rg`')], ephemeral: true });
    const link = interaction.options.getString('link');
    const parsed = parseRobloxGroupLink(link);
    if (!parsed) return interaction.reply({ embeds: [errorEmbed('invalid link').setDescription('give a roblox group link like `https://www.roblox.com/communities/12345/about` or just the group id')], ephemeral: true });
    setGroupConfig(parsed);
    return interaction.reply(`group updated — now using group \`${parsed.groupId}\`\n${parsed.groupLink}`);
  }

  if (commandName === 'gc') {
    await interaction.deferReply();
    const username = interaction.options.getString('username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.editReply("could not find that user")
      const userId = userBasic.id;
      const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json()).data ?? [];
      const displayName = userBasic.displayName || userBasic.name;
      const inFraidGroup = groupsData.some(g => String(g.group.id) === getGroupId());
      const groups = groupsData.sort((a, b) => a.group.name.localeCompare(b.group.name));
      const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl;
      const userGroupIds = new Set(groups.map(g => String(g.group.id)));
      gcCache.set(username.toLowerCase(), { displayName, groups, avatarUrl, userGroupIds, inGroup: inFraidGroup });
      setTimeout(() => gcCache.delete(username.toLowerCase()), 10 * 60 * 1000);
      const flagRow = buildFlagSelectRow(username, groups);
      const pageRow = groups.length > GC_PER_PAGE ? buildGcRow(username, groups, 0) : null;
      const components = [pageRow, flagRow].filter(Boolean);
      if (!inFraidGroup) {
        return interaction.editReply({
          embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcNotInGroupEmbed(displayName, userGroupIds)],
          components
        });
      }
      return interaction.editReply({
        embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcInGroupEmbed(displayName, userGroupIds)],
        components
      });
    } catch (err) { return interaction.editReply({ embeds: [errorFromCatch('GC01', err)] }) }
  }

  if (commandName === 'help') {
    // unwhitelisted users get nothing silent ignore so they can't even tell help exists
    if (!isWhitelisted(interaction.user.id)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can pull up the full help list', ephemeral: true });
    return interaction.reply({ embeds: [buildHelpEmbed(0)], components: buildHelpComponents(0) });
  }

  if (commandName === 'purge') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const amount = interaction.options.getInteger('amount');
    try {
      const deleted = await channel.bulkDelete(amount, true);
      return interaction.reply({ content: `deleted **${deleted.size}** messages`, ephemeral: true });
    } catch (err) { return interaction.reply({ content: `couldn't purge ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'hb') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    const rawId  = interaction.options.getString('id');
    if (!target && !rawId) return interaction.reply({ content: "provide a user mention or their ID", ephemeral: true });
    const userId = target?.id ?? rawId;
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return interaction.reply({ content: "that doesn't look like a real id", ephemeral: true });
    try {
      await guild.members.ban(userId, { reason: `hardban by ${interaction.user.tag}: ${reason}`, deleteMessageSeconds: 0 });
      let username = target?.tag ?? userId;
      if (!target) { try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {} }
      const hardbans = loadHardbans();
      if (!hardbans[guild.id]) hardbans[guild.id] = {};
      hardbans[guild.id][userId] = { reason, bannedBy: interaction.user.id, at: Date.now() };
      saveHardbans(hardbans);
      return interaction.reply(`hardbanned **${username}** by ${interaction.user.tag} reason: ${reason}`);
    } catch (err) { return interaction.reply({ content: `couldn't ban ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'unhb') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const userId = interaction.options.getString('id');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return interaction.reply({ content: "that's not a valid user id", ephemeral: true });
    try {
      await guild.members.unban(userId, reason);
      const hardbans = loadHardbans();
      if (hardbans[guild.id]) delete hardbans[guild.id][userId];
      saveHardbans(hardbans);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return interaction.reply({ embeds: [baseEmbed().setTitle('hardban removed').setColor(0x2C2F33)
        .addFields({ name: 'user', value: username, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }, { name: 'reason', value: reason }).setTimestamp()] });
    } catch (err) { return interaction.reply({ content: `couldn't remove hardban ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'ban') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    if (!target.bannable) return interaction.reply({ content: "can't ban them, they might be above me", ephemeral: true });
    const reason = interaction.options.getString('reason') || 'no reason';
    await target.ban({ reason, deleteMessageSeconds: 86400 });
    return interaction.reply(`banned **${target.user.tag}** by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'kick') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    if (!target.kickable) return interaction.reply({ content: "can't kick them, they might be above me", ephemeral: true });
    const reason = interaction.options.getString('reason') || 'no reason';
    try { await target.kick(reason); } catch { return interaction.reply({ content: "couldn't kick them", ephemeral: true }); }
    return interaction.reply(`kicked **${target.user.tag}** by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'unban') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const userId = interaction.options.getString('id');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return interaction.reply({ content: "that's not a valid user id", ephemeral: true });
    try {
      await guild.members.unban(userId, reason);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return interaction.reply(`unbanned **${username}** by ${interaction.user.tag} reason: ${reason}`);
    } catch (err) { return interaction.reply({ content: `couldn't unban ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'timeout') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target  = interaction.options.getMember('user');
    const minutes = interaction.options.getInteger('minutes') || 5;
    const reason  = interaction.options.getString('reason') || 'no reason';
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(minutes * 60 * 1000, reason); } catch { return interaction.reply({ content: "couldn't time them out", ephemeral: true }); }
    return interaction.reply(`timed out **${target.user.tag}** for ${minutes}m by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'untimeout') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(null); } catch { return interaction.reply({ content: "couldn't remove their timeout", ephemeral: true }); }
    return interaction.reply(`removed timeout from **${target.user.tag}** by ${interaction.user.tag}`);
  }

  if (commandName === 'mute') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/mute`')], ephemeral: true });
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(28 * 24 * 60 * 60 * 1000, reason); } catch { return interaction.reply({ content: "couldn't mute them", ephemeral: true }); }
    // dm the muted user a notification (kept as embed since it's a DM, not a channel reply)
    try {
      await target.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('you have been muted')
        .setDescription(`you were muted in **${guild.name}**`)
        .addFields({ name: 'reason', value: reason }, { name: 'moderator', value: interaction.user.tag })] });
    } catch {}
    return interaction.reply(`muted **${target.user.tag}** (dm sent) by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'unmute') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(null); } catch { return interaction.reply({ content: "couldn't unmute them", ephemeral: true }); }
    return interaction.reply(`unmuted **${target.user.tag}** by ${interaction.user.tag}`);
  }

  if (commandName === 'hush') {
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const hushedData = loadHushed();
    if (hushedData[target.id]) return interaction.reply({ content: `**${target.tag}** is already hushed`, ephemeral: true });
    hushedData[target.id] = { hushedBy: interaction.user.id, at: Date.now() };
    saveHushed(hushedData);
    return interaction.reply(`hushed **${target.tag}** by ${interaction.user.tag}`);
  }

  if (commandName === 'unhush') {
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const hushedData = loadHushed();
    if (!hushedData[target.id]) return interaction.reply({ content: `**${target.tag}** isn't hushed`, ephemeral: true });
    delete hushedData[target.id];
    saveHushed(hushedData);
    return interaction.reply({ embeds: [baseEmbed().setTitle('unhushed').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'lock') {
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      return interaction.reply('channel locked');
    } catch { return interaction.reply({ content: "couldn't lock the channel, check my perms", ephemeral: true }); }
  }

  if (commandName === 'unlock') {
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
      return interaction.reply('channel unlocked');
    } catch { return interaction.reply({ content: "couldn't unlock the channel, check my perms", ephemeral: true }); }
  }

  if (commandName === 'nuke') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    try {
      const ch = channel;
      const newCh = await ch.clone({
        name:     ch.name,
        topic:    ch.topic,
        nsfw:     ch.nsfw,
        parent:   ch.parentId,
        position: ch.rawPosition,
        permissionOverwrites: ch.permissionOverwrites.cache
      });
      await ch.delete();
      await newCh.send(`channel nuked by **${interaction.user.tag}**`);
    } catch (err) {
      return interaction.reply({ content: `couldn't nuke ${err.message}`, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (commandName === 'grouproles') {
    const groupId = process.env.ROBLOX_GROUP_ID;
    if (!groupId) return interaction.reply({ content: '`ROBLOX GROUP ID` isn\'t set', ephemeral: true });
    await interaction.deferReply();
    try {
      const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json();
      if (!data.roles?.length) return interaction.editReply('no roles found for this group');
      const lines = data.roles.sort((a, b) => a.rank - b.rank).map(r => `\`${String(r.rank).padStart(3, '0')}\` **${r.name}** ID: \`${r.id}\``);
      return interaction.editReply({ embeds: [baseEmbed().setTitle('group roles').setColor(0x2C2F33).setDescription(lines.join('\n')).setFooter({ text: `group id: ${groupId}` }).setTimestamp()] });
    } catch { return interaction.editReply("couldn't load group roles, try again"); }
  }

  if (commandName === 'jail') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { return interaction.reply({ embeds: [await jailMember(guild, target, reason, interaction.user.tag)] }); }
    catch (e) { return interaction.reply({ content: `jail failed ${e.message}`, ephemeral: true }); }
  }

  if (commandName === 'unjail') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { return interaction.reply({ embeds: [await unjailMember(guild, target, interaction.user.tag)] }); }
    catch (e) { return interaction.reply({ content: `unjail failed ${e.message}`, ephemeral: true }); }
  }

  if (commandName === 'prefix') {
    const newPrefix = interaction.options.getString('new');
    const p = getPrefix();
    if (!newPrefix) return interaction.reply({ content: `current prefix is \`${p}\``, ephemeral: true });
    if (newPrefix.length > 5) return interaction.reply({ content: "prefix can't be more than 5 chars", ephemeral: true });
    const cfg = loadConfig(); cfg.prefix = newPrefix; saveConfig(cfg);
    return interaction.reply({ content: `prefix updated to \`${newPrefix}\`` });
  }

  if (commandName === 'status') {
    const type = interaction.options.getString('type');
    const text = interaction.options.getString('text');
    const statusData = { type, text };
    applyStatus(statusData);
    const cfg = loadConfig(); cfg.status = statusData; saveConfig(cfg);
    return interaction.reply({ content: `status changed to **${type}** ${text}` });
  }

  // change the online dot (online / idle / dnd / invisible)
  if (commandName === 'presence') {
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: "only whitelist managers can do this", ephemeral: true });
    const state = interaction.options.getString('state');
    applyPresence(state);
    const cfg = loadConfig(); cfg.presence = state; saveConfig(cfg);
    return interaction.reply({ content: `presence changed to **${state}**` });
  }

  if (commandName === 'wlmanager') {
    const sub  = interaction.options.getString('action');
    const mgrs = loadWlManagers();
    if (sub === 'list') {
      if (!canUseAny(interaction.user.id)) return interaction.reply({ content: "only whitelist managers can view the manager list", ephemeral: true });
      // only show ids from the json file (no env stuff so the list stays clean)
      const all = [...new Set(mgrs)];
      if (!all.length) return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription('no managers set')] });
      // go grab the usernames so it doesnt just say a bunch of numbers
      const lines = [];
      let n = 1;
      for (const id of all) {
        let name = id;
        try {
          const u = await client.users.fetch(id);
          name = u.username;
        } catch (e) {
          name = 'unknown user';
        }
        lines.push(n + '. ' + name);
        n = n + 1;
      }
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription(lines.join('\n')).setTimestamp()] });
    }
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: "you're not a whitelist manager", ephemeral: true });
    if (sub === 'add') {
      // temp owners can use every wl manager command EXCEPT promoting other wl managers
      if (!isRealWlManager(interaction.user.id)) return interaction.reply({ content: "temp owners can't add whitelist managers — only real whitelist managers can do that", ephemeral: true });
      const target = interaction.options.getUser('user');
      if (!target) return interaction.reply({ content: "provide a user", ephemeral: true })
      if (isBlockedFromWhitelist(target.id)) return interaction.reply({ content: `**${target.tag}** can't be added to the whitelist managers.`, ephemeral: true });
      if (mgrs.includes(target.id)) return interaction.reply({ content: `**${target.tag}** is already a whitelist manager`, ephemeral: true });
      mgrs.push(target.id); saveWlManagers(mgrs);
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist manager added').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'added by', value: interaction.user.tag, inline: true }).setTimestamp()] });
    }
    if (sub === 'remove') {
      // temp owners are explicitly NOT allowed to remove wl managers
      if (!isRealWlManager(interaction.user.id)) return interaction.reply({ content: "temp owners can't remove whitelist managers — only real whitelist managers can do that", ephemeral: true });
      const target = interaction.options.getUser('user');
      if (!target) return interaction.reply({ content: "provide a user", ephemeral: true })
      if (!mgrs.includes(target.id)) return interaction.reply({ content: `**${target.tag}** isn't a whitelist manager`, ephemeral: true });
      saveWlManagers(mgrs.filter(id => id !== target.id));
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist manager removed').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'removed by', value: interaction.user.tag, inline: true }).setTimestamp()] });
    }
  }

  if (commandName === 'whitelist') {
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: "you can't manage the whitelist", ephemeral: true });
    const sub = interaction.options.getString('action');
    // always read fresh from disk so check/list never returns stale data
    const wl = loadWhitelist();
    if (sub === 'add') {
      const target = interaction.options.getUser('user');
      if (!target) { try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; } }
      if (isBlockedFromWhitelist(target.id)) return interaction.reply({ content: `**${target.tag}** can't be added to the whitelist.`, ephemeral: true });
      if (wl.includes(target.id)) return interaction.reply({ content: `**${target.tag}** is already on the whitelist`, ephemeral: true });
      wl.push(target.id); saveWhitelist(wl);
      return interaction.reply(`added **${target.tag}** to the whitelist`);
    }
    if (sub === 'remove') {
      const target = interaction.options.getUser('user');
      if (!target) { try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; } }
      // re read + filter to avoid stale array writes if the file changed
      const fresh = loadWhitelist();
      if (!fresh.includes(target.id)) return interaction.reply({ content: `**${target.tag}** isn't on the whitelist`, ephemeral: true });
      saveWhitelist(fresh.filter(id => id !== target.id));
      return interaction.reply(`removed **${target.tag}** from the whitelist`);
    }
    if (sub === 'list') {
      // re read fresh
      const fresh = loadWhitelist();
      if (!fresh.length) return interaction.reply('the whitelist is empty');
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist').setColor(0x2C2F33).setDescription(fresh.map((id, i) => `${i + 1}. <@${id}> (\`${id}\`)`).join('\n')).setTimestamp()] });
    }
    if (sub === 'check') {
      const target = interaction.options.getUser('user') || interaction.user;
      // re read so a recent add/remove shows up immediately
      const fresh = loadWhitelist();
      const onWl = fresh.includes(target.id);
      const isMgr = isWlManager(target.id);
      const lines = [];
      lines.push(`**${target.tag}** (\`${target.id}\`)`);
      lines.push(onWl ? '✓ on the whitelist' : '✗ not on the whitelist');
      if (isMgr) lines.push('• also a whitelist manager');
      return interaction.reply({ content: lines.join('\n'), ephemeral: true });
    }
  }

  // /joinserver <invite>: validate the invite & reply with a one-click oauth link pre-targeted at the server
  if (commandName === 'joinserver') {
    if (!isWlManager(interaction.user.id) && !isTempOwner(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can use `/joinserver`')], ephemeral: true });

    const raw = interaction.options.getString('invite', true);
    const inviteCode = (raw.match(/(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)([\w-]+)/i)?.[1] || raw).trim();

    let invite;
    try { invite = await client.fetchInvite(inviteCode); }
    catch (e) {
      return interaction.reply({ embeds: [errorEmbed('invalid invite').setDescription(`that invite is invalid or expired (${e.message})`)], ephemeral: true });
    }

    const targetGuildId = invite.guild?.id;
    if (!targetGuildId)
      return interaction.reply({ embeds: [errorEmbed('not a server invite').setDescription('that invite is for a Group DM, not a server — bots can\'t join Group DMs')], ephemeral: true });

    if (client.guilds.cache.has(targetGuildId))
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('already in that server')
        .setDescription(`I'm already in **${invite.guild.name}** (\`${targetGuildId}\`). nothing to do.`)], ephemeral: true });

    const clientId = client.user?.id || process.env.CLIENT_ID || '';
    if (!clientId) return interaction.reply({ embeds: [errorCode('E JOIN 001', 'bot client id not available yet try again in a few seconds')], ephemeral: true });

    const installUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot+applications.commands&guild_id=${targetGuildId}&disable_guild_select=true`;
    const embed = baseEmbed().setColor(0x2C2F33).setTitle('join server')
      .setDescription([
        `**heads up:** Discord doesn't let bots accept invite links on their own — only a human with **Manage Server** in the target server can authorize me.`,
        ``,
        `**target server:** ${invite.guild.name} \`(${targetGuildId})\``,
        invite.memberCount ? `**members:** ~${invite.memberCount}` : null,
        ``,
        `[**click here to add me to that server**](${installUrl})`,
        `(opens the Discord auth dialog with the server pre-selected — one click and I'm in)`,
      ].filter(Boolean).join('\n'));
    if (invite.guild.icon) embed.setThumbnail(`https://cdn.discordapp.com/icons/${targetGuildId}/${invite.guild.icon}.png`);
    // ping the requester so they get a notification with the install link (NOT ephemeral
    // anymore - ephemeral replies can't ping anyone)
    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      allowedMentions: { users: [interaction.user.id] },
    });
  }

  // /permcheck [user]: anyone can check anyone's bot permissions. ephemeral so it
  // doesn't spam the channel.
  if (commandName === 'permcheck') {
    const target = interaction.options.getUser('user') || interaction.user;
    const id = target.id;
    const wlMgr = isWlManager(id);
    const tempOwn = isTempOwner(id);
    const whitelisted = isWhitelisted(id);
    const lines = [
      `**user:** <@${id}> \`(${id})\``,
      ``,
      `${wlMgr ? '✅' : '❌'} whitelist manager`,
      `${tempOwn ? '✅' : '❌'} temp owner`,
      `${whitelisted ? '✅' : '❌'} whitelisted`,
    ];
    if (!wlMgr && !tempOwn && !whitelisted) lines.push('', '_no bot-level permissions — this user can only run public commands._');
    const embed = baseEmbed().setColor(0x2C2F33).setTitle('permission check').setDescription(lines.join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'invite') {
    if (!canUseAny(interaction.user.id)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
    const clientId = client.user?.id || process.env.CLIENT_ID || '';
    if (!clientId) {
      return interaction.reply({ embeds: [errorCode('E INV 001', 'bot client id not available yet try again in a few seconds')], ephemeral: true });
    }
    // server invite (bot perms = administrator) and roblox account add link
    const serverInvite = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&integration_type=0&scope=bot+applications.commands`;
    const userInstall = `https://discord.com/oauth2/authorize?client_id=${clientId}&integration_type=1&scope=applications.commands`;
    const robloxOauth = `https://apis.roblox.com/oauth/v1/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fwww.roblox.com%2Fhome&scope=openid%20profile%20group%3Aread%20group%3Awrite%20user.advanced.add_friends%3Awrite&response_type=code&prompt=login`;
    const embed = baseEmbed().setColor(0x2C2F33).setTitle(`Invite ${getBotName()}`)
      .setDescription([
        `**Server invite (bot)** adds the bot to your server`,
        `[click here to add to a server](${serverInvite})`,
        ``,
        `**User install** use the bot's commands anywhere`,
        `[click here to install on your account](${userInstall})`,
        ``,
        `**Roblox account link** connect the bot to your Roblox account`,
        `[click here to authorize on Roblox](${robloxOauth})`,
      ].join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'setlogchanneltag') {
    if (!canUseAny(interaction.user.id)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
    const ch = interaction.options.getChannel('channel');
    if (!ch) { try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; } }
    const cfg = loadConfig();
    cfg.tagLogChannelId = ch.id;
    saveConfig(cfg);
    return interaction.reply(`tag logs will now go to <#${ch.id}> `);
  }

  // NEW command handlers

  if (commandName === 'config') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const setting = interaction.options.getString('setting');
    const value = interaction.options.getString('value');
    const cfg = loadConfig();
    if (!cfg.serverConfig) cfg.serverConfig = {};
    if (!cfg.serverConfig[guild.id]) cfg.serverConfig[guild.id] = {};
    cfg.serverConfig[guild.id][setting] = value;
    saveConfig(cfg);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Config Updated')
      .addFields({ name: setting, value: value, inline: true }).setTimestamp()] });
  }

  if (commandName === 'logo') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const url = interaction.options.getString('url');
    const action = interaction.options.getString('action');
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.logoUrl;
      saveConfig(cfg);
      return interaction.reply({ content: `embed logo reset to default: ${getLogoUrl()}` });
    }
    if (!url) {
      return interaction.reply({ content: `current logo: ${getLogoUrl()}` });
    }
    cfg.logoUrl = url;
    saveConfig(cfg);
    return interaction.reply({ content: `embed logo updated: ${url}` });
  }

  if (commandName === 'name') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const text = interaction.options.getString('text');
    const action = interaction.options.getString('action');
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.customName;
      saveConfig(cfg);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Reset')
        .setDescription(`embed name has been reset to **${client.user?.username || 'Bot'}**`).setTimestamp()] });
    }
    if (!text) {
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Current Name')
        .setDescription(`current embed name: **${getBotName()}**`).setTimestamp()] });
    }
    cfg.customName = text;
    saveConfig(cfg);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Updated')
      .setDescription(`embed name changed to **${text}**`).setTimestamp()] });
  }

  if (commandName === 'group') {
    await interaction.deferReply();
    const username = interaction.options.getString('username');
    const action = interaction.options.getString('action');
    const value = interaction.options.getString('value');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.editReply("could not find that user");
      const groupId = process.env.ROBLOX_GROUP_ID;
      if (action === 'check') {
        const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userBasic.id}/groups/roles`)).json()).data ?? [];
        const membership = groupsData.find(g => String(g.group.id) === String(groupId));
        return interaction.editReply({ embeds: [baseEmbed().setColor(membership ? 0x23D160 : 0xFF3860).setTitle('Group Check')
          .addFields(
            { name: 'user', value: userBasic.name, inline: true },
            { name: 'in group', value: membership ? 'yes' : 'no', inline: true },
            { name: 'role', value: membership?.role?.name ?? 'n/a', inline: true }
          ).setTimestamp()] });
      }
      if (action === 'rank') {
        if (!value) return interaction.editReply("provide a role ID to rank to");
        const result = await rankRobloxUser(username, value);
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Ranked')
          .addFields({ name: 'user', value: result.displayName, inline: true }, { name: 'role id', value: value, inline: true }).setTimestamp()] });
      }
      if (action === 'exile') {
        const cookie = process.env.ROBLOX_COOKIE;
        if (!cookie || !groupId) return interaction.editReply('ROBLOX COOKIE or ROBLOX GROUP ID not configured');
        const csrfRes = await fetch('https://auth.roblox.com/v2/logout', { method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
        const csrfToken = csrfRes.headers.get('x-csrf-token');
        const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userBasic.id}`, {
          method: 'DELETE', headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken }
        });
        if (!res.ok) return interaction.editReply(`couldn't exile HTTP ${res.status}`);
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Exiled')
          .addFields({ name: 'user', value: userBasic.name, inline: true }, { name: 'exiled by', value: interaction.user.tag, inline: true }).setTimestamp()] });
      }
    } catch (err) { return interaction.editReply(`something went wrong ${err.message}`); }
  }

  if (commandName === 'setverifyrole') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const role = interaction.options.getRole('role');
    const vc = loadVerifyConfig();
    if (!vc[guild.id]) vc[guild.id] = {};
    vc[guild.id].roleId = role.id;
    saveVerifyConfig(vc);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Role Set')
      .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'set by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'verify') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const vc = loadVerifyConfig();
    const vwl = loadVerifyWhitelist();
    const guildVc = vc[guild.id];
    if (!guildVc?.roleId) return interaction.reply({ content: "verify role isn't set use `/setverifyrole` first", ephemeral: true });
    const guildVwl = vwl[guild.id] || { roles: [], users: [] };
    const member = interaction.member;
    const isAllowed = guildVwl.users.includes(interaction.user.id) ||
      member.roles.cache.some(r => guildVwl.roles.includes(r.id)) ||
      member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (!isAllowed) return interaction.reply({ content: "you are not allowed to verify users", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try {
      await target.roles.add(guildVc.roleId, `verified by ${interaction.user.tag}`);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verified')
        .setThumbnail(target.user.displayAvatarURL())
        .addFields(
          { name: 'user', value: target.user.tag, inline: true },
          { name: 'verified by', value: interaction.user.tag, inline: true },
          { name: 'role given', value: `<@&${guildVc.roleId}> `, inline: true }
        ).setTimestamp()] });
    } catch (err) { return interaction.reply({ content: `couldn't verify ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'vwl') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const role = interaction.options.getRole('role');
    const vwl = loadVerifyWhitelist();
    if (!vwl[guild.id]) vwl[guild.id] = { roles: [], users: [] };
    if (vwl[guild.id].roles.includes(role.id)) return interaction.reply({ content: `<@&${role.id}> is already whitelisted`, ephemeral: true });
    vwl[guild.id].roles.push(role.id);
    saveVerifyWhitelist(vwl);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Whitelist Role Added')
      .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'added by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'vwluser') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    const vwl = loadVerifyWhitelist();
    if (!vwl[guild.id]) vwl[guild.id] = { roles: [], users: [] };
    if (vwl[guild.id].users.includes(target.id)) return interaction.reply({ content: `**${target.tag}** is already whitelisted`, ephemeral: true });
    vwl[guild.id].users.push(target.id);
    saveVerifyWhitelist(vwl);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Whitelist User Added')
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'added by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'vunwl') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const role = interaction.options.getRole('role');
    const target = interaction.options.getUser('user');
    if (!role && !target) return interaction.reply({ content: "provide a role or user to remove", ephemeral: true });
    const vwl = loadVerifyWhitelist();
    if (!vwl[guild.id]) return interaction.reply({ content: "nothing is whitelisted", ephemeral: true });
    const lines = [];
    if (role) {
      if (!vwl[guild.id].roles.includes(role.id)) return interaction.reply({ content: `<@&${role.id}> isn't whitelisted`, ephemeral: true });
      vwl[guild.id].roles = vwl[guild.id].roles.filter(id => id !== role.id);
      lines.push(`role: ${role}`);
    }
    if (target) {
      if (!vwl[guild.id].users.includes(target.id)) return interaction.reply({ content: `**${target.tag}** isn't whitelisted`, ephemeral: true });
      vwl[guild.id].users = vwl[guild.id].users.filter(id => id !== target.id);
      lines.push(`user: ${target.tag}`);
    }
    saveVerifyWhitelist(vwl);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Whitelist Removed')
      .setDescription(lines.join('\n'))
      .addFields({ name: 'removed by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  // server setup commands removed

  // /warn
  if (commandName === 'warn') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'you need **Moderate Members** to warn', ephemeral: true });
    const target = interaction.options.getMember('user') ?? interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') ?? 'no reason given';
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const userId = target.id ?? target.user?.id;
    const userTag = target.user?.tag ?? target.tag ?? 'Unknown';
    const warnsData = loadWarns();
    if (!warnsData[guild.id]) warnsData[guild.id] = {};
    if (!warnsData[guild.id][userId]) warnsData[guild.id][userId] = [];
    warnsData[guild.id][userId].push({ reason, mod: interaction.user.tag, ts: Date.now() });
    saveWarns(warnsData);
    const count = warnsData[guild.id][userId].length;
    return interaction.reply({ embeds: [warnEmbed('Member Warned')
      .setThumbnail(target.user?.displayAvatarURL() ?? target.displayAvatarURL?.() ?? null)
      .addFields(
        { name: 'user', value: `<@${userId}> (${userTag})`, inline: true },
        { name: 'warned by', value: interaction.user.tag, inline: true },
        { name: 'total warnings', value: `${count}`, inline: true },
        { name: 'reason', value: reason }
      )] });
  }

  if (commandName === 'warnings') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const target = interaction.options.getUser('user');
    const warnsData = loadWarns();
    const list = warnsData[guild.id]?.[target.id] ?? [];
    if (!list.length) return interaction.reply({ embeds: [infoEmbed('No Warnings')
      .setDescription(`**${target.tag}** has no warnings`)] });
    const lines = list.map((w, i) =>
      `**${i + 1}.** ${w.reason} by **${w.mod}** <t:${Math.floor(w.ts / 1000)}:R `
    ).join('\n');
    return interaction.reply({ embeds: [warnEmbed(`Warnings ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(lines)
      .addFields({ name: 'total', value: `${list.length}`, inline: true })] });
  }

  if (commandName === 'clearwarns') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'you need **Moderate Members** to clear warns', ephemeral: true });
    const target = interaction.options.getUser('user');
    const warnsData = loadWarns();
    const count = warnsData[guild.id]?.[target.id]?.length ?? 0;
    if (!warnsData[guild.id]) warnsData[guild.id] = {};
    warnsData[guild.id][target.id] = [];
    saveWarns(warnsData);
    return interaction.reply({ embeds: [successEmbed('Warnings Cleared')
      .addFields(
        { name: 'user', value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: 'cleared', value: `${count} warning${count !== 1 ? 's' : ''}`, inline: true },
        { name: 'cleared by', value: interaction.user.tag, inline: true }
      )] });
  }

  if (commandName === 'delwarn') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'you need **Moderate Members**', ephemeral: true });
    const target = interaction.options.getUser('user');
    const idx = interaction.options.getInteger('index') - 1;
    const warnsData = loadWarns();
    const list = warnsData[guild.id]?.[target.id] ?? [];
    if (!list[idx]) return interaction.reply({ content: `no warning at index **${idx + 1}**`, ephemeral: true });
    const removed = list.splice(idx, 1)[0];
    saveWarns(warnsData);
    return interaction.reply({ embeds: [successEmbed('Warning Removed')
      .addFields(
        { name: 'user', value: `<@${target.id}> `, inline: true },
        { name: 'removed #', value: `${idx + 1}`, inline: true },
        { name: 'reason was', value: removed.reason }
      )] });
  }

  // /serverinfo
  if (commandName === 'role') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseRole(interaction.member))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('you don\'t have permission to use `/role`. ask a wl manager to allow your role with `/setroleperms add`.')], ephemeral: true });

    const robloxUsername = interaction.options.getString('roblox');
    const roleInput = interaction.options.getString('role');
    const roles = loadRobloxRoles();
    let lookup = roles[roleInput] || roles[roleInput.toLowerCase()];
    // if the user picked an autocomplete suggestion, the value is the numeric
    // roblox role id - resolve it against the live group roles for display
    if (!lookup && /^\d+$/.test(roleInput)) {
      try {
        const groupId = getGroupId();
        const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json();
        const match = (data.roles || []).find(r => String(r.id) === roleInput);
        if (match) lookup = { id: String(match.id), name: match.name, rank: match.rank };
      } catch {}
      if (!lookup) lookup = { id: roleInput, name: roleInput };
    }
    if (!lookup) {
      const listEmbed = await buildRegisteredRolesEmbed();
      return interaction.reply({ embeds: [errorEmbed('unknown role').setDescription(`no roblox group role named **${roleInput}** is registered.`), listEmbed], ephemeral: true });
    }
    const roleName = lookup.name || roleInput;

    await interaction.deferReply();
    try {
      const result = await rankRobloxUser(robloxUsername, lookup.id);
      const e = baseEmbed().setColor(0x2C2F33).setTitle('roblox role set')
        .setDescription(`set **${result.displayName}** to **${lookup.name || roleName}**`)
        .addFields(
          { name: 'roblox', value: `[${result.displayName}](https://www.roblox.com/users/${result.userId}/profile)`, inline: true },
          { name: 'role', value: `${lookup.name || roleName} \`${lookup.id}\``, inline: true },
          { name: 'set by', value: interaction.user.tag, inline: false }
        );
      if (result.avatarUrl) e.setThumbnail(result.avatarUrl);
      await interaction.editReply({ embeds: [e] });
      sendBotLog(guild, e);
    } catch (err) {
      await interaction.editReply({ embeds: [errorEmbed('failed').setDescription(err.message)] });
    }
    return;
  }

  // /r original discord role toggle (wl managers only)
  if (commandName === 'r') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use this command', ephemeral: true });

    const targetMember = interaction.options.getMember('member');
    if (!targetMember) return interaction.reply({ content: 'that user is not in this server', ephemeral: true });

    const roleOptions = ['role1', 'role2', 'role3', 'role4', 'role5']
      .map(k => interaction.options.getRole(k))
      .filter(Boolean);

    if (!roleOptions.length) return interaction.reply({ content: 'provide at least one role', ephemeral: true });

    const added = [], removed = [], failed = [];
    for (const role of roleOptions) {
      try {
        if (targetMember.roles.cache.has(role.id)) {
          await targetMember.roles.remove(role);
          removed.push(role.toString());
        } else {
          await targetMember.roles.add(role);
          added.push(role.toString());
        }
      } catch { failed.push(role.name); }
    }

    const lines = [];
    if (added.length)   lines.push(`Added ${added.join(', ')} to ${targetMember}`);
    if (removed.length) lines.push(`Removed ${removed.join(', ')} from ${targetMember}`);
    if (failed.length)  lines.push(`Failed: ${failed.join(', ')} (missing perms?)`);

    return interaction.reply({ content: lines.join('\n') || 'nothing changed' });
  }

  // /setrole register a roblox group role name → id
  if (commandName === 'setrole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setrole`')], ephemeral: true });
    const name = interaction.options.getString('name').trim();
    const id = interaction.options.getString('id').trim();
    if (!/^\d+$/.test(id)) return interaction.reply({ embeds: [errorEmbed('bad id').setDescription('role id must be numeric')], ephemeral: true });
    const roles = loadRobloxRoles();
    roles[name] = { id, name };
    saveRobloxRoles(roles);
    return interaction.reply(`role registered — saved roblox group role **${name}** → \`${id}\``);
  }

  // /setroleperms allow discord role to use /role
  if (commandName === 'setroleperms') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setroleperms`')], ephemeral: true });
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    let perms = loadRolePerms();
    if (action === 'list') {
      const desc = perms.length ? perms.map(id => `<@&${id}> `).join('\n') : 'no roles allowed yet';
      return interaction.reply({ embeds: [infoEmbed('role permissions').setDescription(desc)] });
    }
    if (!role) return interaction.reply({ embeds: [errorEmbed('missing role').setDescription('pick a discord role')], ephemeral: true });
    if (action === 'add') {
      if (perms.includes(role.id)) return interaction.reply({ embeds: [errorEmbed('already allowed').setDescription(`${role} can already use /role`)], ephemeral: true });
      perms.push(role.id); saveRolePerms(perms);
      let syncLine = '';
      try { const res = await grantRoleToOpenTickets(guild, role.id); syncLine = `\nsynced ${res.updated} open ticket${res.updated === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}`; } catch {}
      return interaction.reply(`${role} can now use \`/role\` and see tickets${syncLine}`);
    }
    if (action === 'remove') {
      perms = perms.filter(id => id !== role.id); saveRolePerms(perms);
      let syncLine = '';
      try { const res = await revokeRoleFromOpenTickets(guild, role.id); syncLine = `\nsynced ${res.updated} open ticket${res.updated === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}`; } catch {}
      return interaction.reply(`${role} can no longer use \`/role\` or see tickets${syncLine}`);
    }
    return;
  }

  // /tempowner
  if (commandName === 'tempowner') {
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/tempowner`')], ephemeral: true });
    const target = interaction.options.getUser('user');
    const ids = loadTempOwners();
    if (ids.includes(target.id)) return interaction.reply({ embeds: [errorEmbed('already temp owner').setDescription(`${target} is already a temp owner`)], ephemeral: true });
    ids.push(target.id); saveTempOwners(ids);
    try { await target.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('temp owner granted').setDescription(`you were granted temp owner access${guild ? ` in **${guild.name}**` : ''}. you now have access to every bot command.`)] }); } catch {}
    const e = `temp owner granted — ${target} now has access to every bot command (granted by ${interaction.user.tag})`;
    if (guild) sendBotLog(guild, e);
    return interaction.reply(e);
  }

  if (commandName === 'untempowner') {
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/untempowner`')], ephemeral: true });
    const target = interaction.options.getUser('user');
    let ids = loadTempOwners();
    if (!ids.includes(target.id)) return interaction.reply({ embeds: [errorEmbed('not a temp owner').setDescription(`${target} isn't a temp owner`)], ephemeral: true });
    ids = ids.filter(id => id !== target.id); saveTempOwners(ids);
    const e = `temp owner revoked — ${target} no longer has temp owner access (revoked by ${interaction.user.tag})`;
    if (guild) sendBotLog(guild, e);
    return interaction.reply(e);
  }

  // /setlogchannel + /logstatus
  if (commandName === 'setlogchannel') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setlogchannel`')], ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ embeds: [errorEmbed('bad channel').setDescription('pick a text channel')], ephemeral: true });
    const cfg = loadConfig(); cfg.logChannelId = ch.id; saveConfig(cfg);
    return interaction.reply(`bot action logs will be sent to ${ch}`);
  }

  if (commandName === 'logstatus') {
    const cfg = loadConfig();
    if (!cfg.logChannelId) return interaction.reply({ embeds: [infoEmbed('log channel').setDescription('no log channel set. use `/setlogchannel` to set one.')] });
    return interaction.reply({ embeds: [infoEmbed('log channel').setDescription(`current log channel: <#${cfg.logChannelId}> `)] });
  }

  // /setverifyrole
  if (commandName === 'setverifyrole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setverifyrole`')], ephemeral: true });
    const role = interaction.options.getRole('role');
    const cfg = loadVerifyConfig(); cfg.roleId = role.id; saveVerifyConfig(cfg);
    return interaction.reply(`verify role set — verified users will receive ${role}`);
  }

  // /setuptickets — sends the ticket panel to a channel.
  // panel can offer verification tickets, tag tickets, or both (default).
  if (commandName === 'setuptickets') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use /setuptickets', ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    const rawType = (interaction.options.getString('type') || 'both').toLowerCase();
    const kind = ['verification', 'tag', 'both'].includes(rawType) ? rawType : 'both';
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ content: 'pick a text channel', ephemeral: true });

    // panel content — admins can override any of these via the slash options
    const title       = interaction.options.getString('title') || 'ぞメtickets';
    const description = interaction.options.getString('description')
      || 'before u open a ticket make sure to join the roblox group.\n\ntickets without ur actual roblox username will be closed';
    const placeholder = interaction.options.getString('placeholder') || 'open a ticket...';

    // optional custom hex color — strip the # if they included it
    const rawColor = interaction.options.getString('color');
    let panelColor = 0x4A0E0E;
    if (rawColor) {
      const parsed = parseInt(rawColor.replace('#', ''), 16);
      if (!isNaN(parsed)) panelColor = parsed;
    }

    // keep the panel embed simple — just title + description, no footer / no extras
    const panel = new EmbedBuilder()
      .setColor(panelColor)
      .setTitle(title)
      .setDescription(description);

    const menuOptions = [];
    if (kind === 'verification' || kind === 'both') {
      menuOptions.push({ label: 'verification ticket', value: 'verification', description: 'get verified with your roblox account' });
    }
    if (kind === 'tag' || kind === 'both') {
      menuOptions.push({ label: 'tag ticket', value: 'tag', description: 'request a roblox tag (needs approval)' });
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket kind select')
      .setPlaceholder(placeholder)
      .addOptions(menuOptions);
    const row = new ActionRowBuilder().addComponents(menu);
    try {
      await ch.send({ embeds: [panel], components: [row] });
      return interaction.reply({ content: `ticket panel sent to ${ch}`, ephemeral: true });
    } catch {
      return interaction.reply({ content: "couldn't send to that channel — check my permissions", ephemeral: true });
    }
  }

  // /closeticket — closes the current ticket channel after a short delay
  if (commandName === 'closeticket') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const tickets = loadTickets();
    const t = tickets[interaction.channel.id];
    if (!t) return interaction.reply({ content: "this isn't a ticket channel", ephemeral: true });
    const support = loadTicketSupport();
    const allowed = isWlManager(interaction.user.id) || interaction.member.roles.cache.some(r => support.includes(r.id)) || t.userId === interaction.user.id;
    if (!allowed) return interaction.reply({ content: 'only the ticket opener, support roles, or wl managers can close this', ephemeral: true });
    await interaction.reply({ content: 'closing this ticket in 5s...' });
    delete tickets[interaction.channel.id]; saveTickets(tickets);
    setTimeout(async () => {
      try { await interaction.channel.delete('ticket closed'); } catch {}
    }, 5000);
    sendBotLog(guild, `ticket closed: #${interaction.channel.name} closed by ${interaction.user.tag}`);
    return;
  }

  // /ticket supportroles
  if (commandName === 'ticket') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'supportroles') {
      if (!canUseAny(interaction.user.id))
        return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can manage support roles')], ephemeral: true });
      const action = interaction.options.getString('action');
      const role = interaction.options.getRole('role');
      let support = loadTicketSupport();
      if (action === 'list') {
        const desc = support.length ? support.map(id => `<@&${id}> `).join('\n') : 'no support roles set';
        return interaction.reply({ embeds: [infoEmbed('ticket support roles').setDescription(desc)] });
      }
      if (!role) return interaction.reply({ embeds: [errorEmbed('missing role').setDescription('pick a role')], ephemeral: true });
      if (action === 'add') {
        if (support.includes(role.id)) return interaction.reply({ embeds: [errorEmbed('already added').setDescription(`${role} is already a support role`)], ephemeral: true });
        support.push(role.id); saveTicketSupport(support);
        return interaction.reply(`${role} added to ticket support`);
      }
      if (action === 'remove') {
        support = support.filter(id => id !== role.id); saveTicketSupport(support);
        return interaction.reply(`${role} removed from ticket support`);
      }
    }
    return;
  }

  // /give1 give the bot and user the highest role possible
  if (commandName === 'give1') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/give1`')], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const me = await guild.members.fetchMe();
      const myTopPos = me.roles.highest.position;
      // create a new role positioned just below the bot's top managed role (highest possible)
      const newRole = await guild.roles.create({
        name: 'top',
        color: 0x2C2F33,
        permissions: PermissionsBitField.Resolver?.Administrator ? [PermissionsBitField.Flags.Administrator] : ['Administrator'],
        reason: `requested by ${interaction.user.tag}`
      });
      try { await newRole.setPosition(Math.max(1, myTopPos - 1)); } catch {}
      await me.roles.add(newRole).catch(() => {});
      const targetMember = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (targetMember) await targetMember.roles.add(newRole).catch(() => {});
      return interaction.editReply(`done — gave ${newRole} to me and ${interaction.user}`);
    } catch (err) {
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(err.message)] });
    }
  }


  // /tag same as /role (rank a roblox user) but logged to the tag log
  // plain text only - no embed, no logo.
  if (commandName === 'tag') {
    // works in dms and guilds guild requires role perms; dms require WL manager
    const allowedDm = !guild && isWlManager(interaction.user.id);
    const allowedGuild = !!guild && canUseRole(interaction.member);
    if (!allowedDm && !allowedGuild)
      return interaction.reply({ content: 'you don\'t have permission to use `/tag`. in a server: ask a wl manager to allow your role with `/setroleperms add`. in DMs: only whitelist managers can tag.', ephemeral: true });

    const robloxUsername = (interaction.options.getString('roblox') || '').trim();
    const roleName = (interaction.options.getString('role') || '').trim();
    if (!robloxUsername || !roleName) {
      try {
        return interaction.reply({
          content: 'not the right format',
          ephemeral: true
        });
      } catch { return; }
    }

    const roles = loadRobloxRoles();
    const lookup = roles[roleName] || roles[roleName.toLowerCase()];
    if (!lookup) return interaction.reply({ content: `no roblox group role named **${roleName}** is registered. use \`/setrole\` first.`, ephemeral: true });

    await interaction.deferReply();
    try {
      const result = await rankRobloxUser(robloxUsername, lookup.id);
      appendTagLog({
        action: 'tag', tag: lookup.name || roleName, roblox: result.displayName,
        robloxId: result.userId, giverId: interaction.user.id, giverTag: interaction.user.tag, guildId: guild?.id
      });
      const text = `tagged **${result.displayName}** as **${lookup.name || roleName}**\nroblox: <https://www.roblox.com/users/${result.userId}/profile>\ngiven by: ${interaction.user.tag} (<@${interaction.user.id}>)`;
      await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
      try { if (guild) sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('tag given').setDescription(text)); } catch {}
    } catch (err) {
      await interaction.editReply({ content: `failed: ${err.message}` });
    }
    return;
  }

  // /alts — check if a roblox account is linked to more than one discord user
  if (commandName === 'alts') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/alts`')], ephemeral: true });

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const vData = loadVerify();

    // find the roblox id linked to this discord user
    const userVerify = vData.verified?.[targetUser.id];
    if (!userVerify) {
      return interaction.reply({
        embeds: [infoEmbed('alts').setDescription(`<@${targetUser.id}> has no verified Roblox account linked`)],
        ephemeral: true
      });
    }

    const robloxId = String(userVerify.robloxId);
    const robloxName = userVerify.robloxUsername || robloxId;

    // find every discord account mapped to this same roblox id
    const linkedAccounts = [];
    for (const [discordId, verifyEntry] of Object.entries(vData.verified || {})) {
      if (String(verifyEntry.robloxId) === robloxId) {
        linkedAccounts.push(discordId);
      }
    }

    // also check robloxToDiscord for any extra mappings
    if (vData.robloxToDiscord?.[robloxId]) {
      const mapped = vData.robloxToDiscord[robloxId];
      if (!linkedAccounts.includes(mapped)) linkedAccounts.push(mapped);
    }

    let desc = `**Roblox:** [\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)\n\n`;
    if (linkedAccounts.length <= 1) {
      desc += `no alternate accounts found — only one Discord account is linked to this Roblox profile`;
    } else {
      desc += `**${linkedAccounts.length} Discord accounts linked to this Roblox profile:**\n`;
      desc += linkedAccounts.map(id => `• <@${id}> (\`${id}\`)`).join('\n');
    }

    return interaction.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('alt check').setDescription(desc)],
      allowedMentions: { parse: [] }
    });
  }

  // /dm — lets wl managers dm someone from the bot
  if (commandName === 'dm') {
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use this', ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const msgText    = interaction.options.getString('message');

    if (!targetUser) return interaction.reply({ content: 'pick a user to DM', ephemeral: true });
    if (!msgText)    return interaction.reply({ content: 'include a message to send', ephemeral: true });

    try {
      await targetUser.send(msgText);
      return interaction.reply({ content: `DM sent to **${targetUser.tag}**`, ephemeral: true });
    } catch {
      return interaction.reply({ content: `couldn't DM **${targetUser.tag}** — they probably have DMs off`, ephemeral: true });
    }
  }

  // /taglog recent tag log entries
  if (commandName === 'taglog') {
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can view the tag log')], ephemeral: true });
    const limit = interaction.options.getInteger('limit') ?? 10;
    const entries = loadTagLog().slice(-limit).reverse();
    if (!entries.length) return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag log').setDescription('no entries yet')] });
    const lines = entries.map(e => {
      const when = `<t:${Math.floor((e.ts || Date.now()) / 1000)}:R `;
      return `${when} **${e.giverTag || e.giverId}** tagged **${e.roblox}** as **${e.tag}**`;
    }).join('\n').slice(0, 4000);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`tag log last ${entries.length}`).setDescription(lines)] });
  }


  // /inrole
  if (commandName === 'inrole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    await interaction.deferReply();
    const role = interaction.options.getRole('role');
    await fetchMembersCached(guild);
    const members = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(role.id));

    if (!members.size) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Members with ${role.name}`).setDescription('nobody has this role')] });

    const lines = [...members.values()]
      .sort((a, b) => a.user.username.localeCompare(b.user.username))
      .map((m, i) => `${String(i + 1).padStart(2, '0')} ${m} (${m.user.username})`)
      .join('\n');

    const chunks = [];
    const CHUNK = 4000;
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));

    for (let i = 0; i < chunks.length; i++) {
      const e = baseEmbed().setColor(0x2C2F33)
        .setTitle(i === 0 ? `Members with ${role.name}` : `Members with ${role.name} (cont.)`)
        .setDescription(chunks[i])
        .setFooter({ text: `${members.size} total member${members.size !== 1 ? 's' : ''}`, iconURL: getLogoUrl() });
      if (i === 0) await interaction.editReply({ embeds: [e] });
      else await interaction.followUp({ embeds: [e] });
    }
    return;
  }

  // /leaveserver (WL managers only)
  if (commandName === 'leaveserver') {
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use this command', ephemeral: true });

    const serverId = interaction.options.getString('serverid');

    if (serverId) {
      const targetGuild = client.guilds.cache.get(serverId);
      if (!targetGuild) return interaction.reply({ content: `I am not in a server with ID \`${serverId}\``, ephemeral: true });
      await interaction.reply({ content: `leaving **${targetGuild.name}**...`, ephemeral: true });
      try { await targetGuild.leave(); } catch (e) { return interaction.editReply({ content: `couldn't leave ${e.message}` }); }
      return;
    }

    if (!guild) return interaction.reply({ content: 'use this in a server or provide a server id', ephemeral: true });
    await interaction.reply({ content: `leaving **${guild.name}**...`, ephemeral: true });
    try { await guild.leave(); } catch (e) { return interaction.editReply({ content: `couldn't leave ${e.message}` }); }
    return;
  }

  // cleanup (delete non pinned messages)
  if (commandName === 'whoisin') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const input = interaction.options.getString('game')?.trim();
    if (!input) return interaction.reply({ content: 'provide a Roblox game URL or place ID', ephemeral: true });
    await interaction.deferReply();
    await interaction.editReply({ content: 'fetching group members and game servers...' });
    const WHOISIN_GROUP = 206868002;
    try {
      // parse place ID supports:
      // roblox.com/games/start?placeid=123&gameinstanceid=...
      // roblox.com/games/123/game name
      // raw numeric place ID
      let placeId = null;
      const qsMatch = input.match(/[?&]place[iI][dD]=(\d+)/i);
      const pathMatch = input.match(/roblox\.com\/games\/(\d+)/i);
      if (qsMatch) placeId = qsMatch[1];
      else if (pathMatch) placeId = pathMatch[1];
      else if (/^\d+$/.test(input)) placeId = input;
      if (!placeId) return interaction.editReply({ content: "couldn't parse a place ID paste a Roblox game URL or server link, e.g. `roblox.com/games/start?placeId=123&gameInstanceId=...`" });

      // resolve place ID → universe ID
      const placeDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`)).json();
      const universeId = placeDetail?.data?.[0]?.universeId;
      if (!universeId) return interaction.editReply({ content: `couldn't find a game for place ID \`${placeId}\` make sure the game exists and is public` });

      // get game name
      let gameName = `Place ${placeId}`;
      try { const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json(); if (gr?.data?.[0]?.name) gameName = gr.data[0].name; } catch {}

      // load all group members (paginated)
      await interaction.editReply({ content: 'loading group members...' });
      const memberIds = new Set();
      const memberNames = {};
      let cur = '';
      do {
        try {
          const res = await (await fetch(`https://members.roblox.com/v1/groups/${WHOISIN_GROUP}/users?limit=100&sortOrder=Asc${cur ? `&cursor=${cur}` : ''}`)).json();
          for (const m of (res.data || [])) { memberIds.add(m.user.userId); memberNames[m.user.userId] = m.user.username; }
          cur = res.nextPageCursor || '';
        } catch { cur = ''; break; }
      } while (cur);
      if (!memberIds.size) return interaction.editReply({ content: 'could not load group members Roblox API may be unavailable' });

      // scan all public servers, collect player tokens
      await interaction.editReply({ content: `loaded **${memberIds.size}** group members, scanning servers...` });
      const allTokens = [];
      let sCur = ''; let serverCount = 0;
      do {
        try {
          const res = await (await fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100${sCur ? `&cursor=${sCur}` : ''}`)).json();
          for (const srv of (res.data || [])) { serverCount++; for (const p of (srv.players || [])) { if (p.playerToken) allTokens.push(p.playerToken); } }
          sCur = res.nextPageCursor || '';
        } catch { sCur = ''; break; }
      } while (sCur);

      if (!allTokens.length) return interaction.editReply({ content: `scanned **${serverCount}** server${serverCount !== 1 ? 's' : ''} no players found (game may be empty or servers private)` });

      // resolve player tokens → roblox user ids via thumbnail batch API
      await interaction.editReply({ content: `resolving **${allTokens.length}** player${allTokens.length !== 1 ? 's' : ''} across **${serverCount}** server${serverCount !== 1 ? 's' : ''}...` });
      const resolvedIds = new Set();
      for (let i = 0; i < allTokens.length; i += 100) {
        try {
          const batch = allTokens.slice(i, i + 100).map((token, idx) => ({ requestId: `${i + idx}`, token, type: 'AvatarHeadShot', size: '150x150', format: 'png', isCircular: false }));
          const res = await (await fetch('https://thumbnails.roblox.com/v1/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })).json();
          for (const item of (res.data || [])) { if (item.targetId && item.targetId !== 0) resolvedIds.add(item.targetId); }
        } catch {}
      }

      // filter to group members only
      const inGame = [...resolvedIds].filter(id => memberIds.has(id));
      if (!inGame.length) return interaction.editReply({ content: `no group members found in **${gameName}**\n*(checked ${serverCount} server${serverCount !== 1 ? 's' : ''}, ${resolvedIds.size} total player${resolvedIds.size !== 1 ? 's' : ''})*` });

      const lines = inGame.map(id => `• \`${memberNames[id] || id}\``).join('\n');
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle(`Group members in ${gameName}`)
        .setDescription(`**${inGame.length}** group member${inGame.length !== 1 ? 's' : ''} currently in game:\n\n${lines}`)
        .setFooter({ text: `${serverCount} server${serverCount !== 1 ? 's' : ''} scanned • group ${WHOISIN_GROUP}` })
        .setTimestamp()] });
    } catch (err) { return interaction.editReply({ content: `whoisin failed ${err.message}` }); }
  }

  // attend
  if (commandName === 'rollcall') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !canUseAny(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to use this', ephemeral: true });
    const rcEmbed = new EmbedBuilder().setColor(0x2C2F33)
      .setTitle('RAID QUEUE')
      .setDescription('REACT TO THIS MESSAGE IF YOU ARE IN GAME/ IN QUEUE.');
    const rcMsg = await interaction.reply({ embeds: [rcEmbed], fetchReply: true });
    await rcMsg.react('✅');
    const qData = loadQueue();
    if (!qData[guild.id]) qData[guild.id] = {};
    qData[guild.id].rollCall = { messageId: rcMsg.id, channelId: rcMsg.channelId };
    saveQueue(qData);
  }

  // endrollcall
  if (commandName === 'endrollcall') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !canUseAny(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to use this', ephemeral: true });
    const qData = loadQueue();
    const rc = qData[guild.id]?.rollCall;
    if (!rc) return interaction.reply({ content: 'no active roll call start one with `/rollcall` first', ephemeral: true });
    await interaction.deferReply();
    try {
      const rcChannel = guild.channels.cache.get(rc.channelId);
      if (!rcChannel) return interaction.editReply({ content: "couldn't find the roll call channel" });
      const rcMsg = await rcChannel.messages.fetch(rc.messageId);
      const reaction = rcMsg.reactions.cache.get('✅');
      let reactors = [];
      if (reaction) {
        await reaction.users.fetch();
        reactors = [...reaction.users.cache.values()].filter(u => !u.bot);
      }
      if (!reactors.length) {
        delete qData[guild.id].rollCall;
        saveQueue(qData);
        return interaction.editReply({ content: 'roll call closed no reactions found' });
      }
      const vData = loadVerify();
      const queueChannelId = qData[guild.id]?.channelId;
      const queueChannel = queueChannelId ? guild.channels.cache.get(queueChannelId) : null;
      // new rollcall summary channel
      const rollCallChannelId = qData[guild.id]?.rollCallChannelId;
      const rollCallChannel = rollCallChannelId ? guild.channels.cache.get(rollCallChannelId) : null;
      let logged = 0; const skipped = []; const loggedEntries = [];
      const summaryRows = [];
      for (const user of reactors) {
        const userVerify = vData.verified?.[user.id];
        if (!userVerify) { skipped.push(user); continue; }
        let avatarUrl = null;
        try {
          const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userVerify.robloxId}&size=420x420&format=Png&isCircular=false`)).json();
          avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
        } catch {}
        const rcAttendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
          .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
          .addFields({ name: 'Discord', value: `<@${user.id}> `, inline: false }, { name: 'Roblox', value: `\`${userVerify.robloxName}\``, inline: false })
          .setTimestamp().setFooter({ text: `roll call • ${getBotName()}`, iconURL: getLogoUrl() });
        if (avatarUrl) rcAttendEmbed.setThumbnail(avatarUrl);
        if (queueChannel) { await queueChannel.send({ embeds: [rcAttendEmbed] }); addRaidStat(guild.id, user.id); }
        else if (rollCallChannel) { addRaidStat(guild.id, user.id); }
        loggedEntries.push({ discordId: user.id, robloxName: userVerify.robloxName });
        summaryRows.push({ discordId: user.id, discordName: user.username, robloxId: userVerify.robloxId, robloxName: userVerify.robloxName });
        logged++;
        await new Promise(r => setTimeout(r, 300));
      }
      // big summary in the rollcall channel - clickable discord + roblox names
      if (rollCallChannel && summaryRows.length) {
        const lines = summaryRows.map((r, i) =>
          `**${i + 1}.** [${r.discordName}](https://discord.com/users/${r.discordId}) — Roblox: [${r.robloxName}](https://www.roblox.com/users/${r.robloxId}/profile)`
        );
        const skippedLine = skipped.length ? `\n\n*${skipped.length} skipped (not registered)*` : '';
        const summaryEmbed = baseEmbed().setColor(0x2C2F33)
          .setTitle('Rollcall — Who Was In')
          .setDescription(lines.join('\n') + skippedLine)
          .setFooter({ text: `${summaryRows.length} member${summaryRows.length !== 1 ? 's' : ''} • closed by ${interaction.user.username} • ${getBotName()}`, iconURL: getLogoUrl() })
          .setTimestamp();
        try { await rollCallChannel.send({ embeds: [summaryEmbed] }); } catch (e) { console.error('rollcall summary post failed:', e.message); }
      }
      appendAtLog(guild.id, { ts: Date.now(), by: interaction.user.id, channelId: rc.channelId, queueChannelId: queueChannel?.id || null, logged: loggedEntries, skipped: skipped.map(u => u.id) });
      delete qData[guild.id].rollCall;
      saveQueue(qData);
      const skipNote = skipped.length ? `\n${skipped.length} skipped (not registered)` : '';
      const summaryNote = rollCallChannel ? `\nsummary posted to ${rollCallChannel}` : (rollCallChannelId ? '\n(rollcall channel set but couldn\'t find it, check perms)' : `\nset a summary channel with \`/setrollcallchannel\``);
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Roll Call Closed').setDescription(`logged **${logged}** member${logged !== 1 ? 's' : ''}${queueChannel ? ` to ${queueChannel}` : ''}${skipNote}${summaryNote}`).setTimestamp()] });
    } catch (err) {
      return interaction.editReply({ content: `failed to close roll call ${err.message}` });
    }
  }

  // /pregister
  if (commandName === 'pregister') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/pregister`', ephemeral: true });

    const robloxInput  = interaction.options.getString('roblox')?.trim();
    const targetUser   = interaction.options.getUser('user');
    const rawId        = interaction.options.getString('userid')?.trim();

    if (!targetUser && !rawId) return interaction.reply({ content: 'provide a Discord user via the `user` option or their ID via `userid`', ephemeral: true });
    const discordId = targetUser ? targetUser.id : rawId.replace(/[<@!>]/g, '');
    if (!/^\d{17,20}$/.test(discordId)) return interaction.reply({ content: "that doesn't look like a valid Discord user ID", ephemeral: true });

    let resolvedUser = targetUser;
    if (!resolvedUser) {
      try { resolvedUser = await client.users.fetch(discordId); } catch { return interaction.reply({ content: "could not find that Discord user", ephemeral: true }); }
    }

    await interaction.deferReply();
    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false })
      })).json();
      const robloxUser = res.data?.[0];
      if (!robloxUser) return interaction.editReply({ content: `could not find a Roblox user named \`${robloxInput}\`` });

      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

      const existingDiscordId = vData.robloxToDiscord[String(robloxUser.id)];
      if (existingDiscordId && existingDiscordId !== discordId) {
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
          .setDescription(`\`${robloxUser.name}\` is already registered to a different Discord account`)] });
      }

      const prevEntry = vData.verified[discordId];
      if (prevEntry && String(prevEntry.robloxId) !== String(robloxUser.id)) {
        delete vData.robloxToDiscord[String(prevEntry.robloxId)];
      }

      vData.verified[discordId]                    = { robloxId: robloxUser.id, robloxName: robloxUser.name, verifiedAt: Date.now() };
      vData.robloxToDiscord[String(robloxUser.id)] = discordId;
      saveVerify(vData);
      saveLinkedVerified(vData);

      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json();
      const avatarUrl  = avatarData.data?.[0]?.imageUrl ?? null;

      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Registration Successful')
        .setThumbnail(avatarUrl ?? getLogoUrl())
        .setDescription(`<@${discordId}> is now registered as **${robloxUser.name}**`)
        .addFields(
          { name: 'Discord',       value: `<@${discordId}> `, inline: true },
          { name: 'Roblox',        value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
          { name: 'registered by', value: `<@${interaction.user.id}> `, inline: true }
        ).setTimestamp()] });
    } catch (err) { return interaction.editReply({ content: `pregister failed ${err.message}` }); }
  }

  // /verify
  if (commandName === 'verify') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!hasTicketAccess(interaction.user.id, interaction.member)) return interaction.reply({ content: 'only whitelist managers, temp owners, or ticket support roles can use `/verify`', ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'role') {
      const action = interaction.options.getString('action');
      if (action === 'set') {
        const role = interaction.options.getRole('role');
        if (!role) return interaction.reply({ content: 'provide a role to set', ephemeral: true });
        const cfg = loadConfig(); cfg.verifyRoleId = role.id; saveConfig(cfg);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verify role set')
          .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'set by', value: interaction.user.tag, inline: true }).setTimestamp()] });
      }
      if (action === 'remove') {
        const cfg = loadConfig(); delete cfg.verifyRoleId; saveConfig(cfg);
        return interaction.reply({ content: 'verify role removed' });
      }
    }

    if (sub === 'user') {
      const cfg = loadConfig();
      if (!cfg.verifyRoleId) return interaction.reply({ content: 'no verify role set use `/verify role set` first', ephemeral: true });
      const target = interaction.options.getMember('user');
      if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
      const role = guild.roles.cache.get(cfg.verifyRoleId);
      if (!role) return interaction.reply({ content: "couldn't find the configured verify role it may have been deleted", ephemeral: true });
      if (target.roles.cache.has(role.id)) return interaction.reply({ content: `<@${target.id}> already has ${role}`, ephemeral: true });
      try {
        await target.roles.add(role);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verified')
          .addFields(
            { name: 'user',        value: `<@${target.id}> `, inline: true },
            { name: 'role',        value: `${role}`, inline: true },
            { name: 'verified by', value: interaction.user.tag, inline: true }
          ).setTimestamp()] });
      } catch { return interaction.reply({ content: "couldn't add the role check my permissions", ephemeral: true }); }
    }
  }

  // registeredlist
  if (commandName === 'registeredlist') {
    await interaction.deferReply();
    const vData = loadVerify();
    const entries = Object.entries(vData.verified || {});
    if (!entries.length) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verified Accounts').setDescription('no one has linked their Roblox account yet')] });
    const lines = entries.map(([discordId, { robloxName, robloxId }]) => `<@${discordId}> → [\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)`);
    const PAGE_SIZE = 20; const pages = []; for (let i = 0; i < lines.length; i += PAGE_SIZE) pages.push(lines.slice(i, i + PAGE_SIZE));
    const totalPages = pages.length;
    const buildPage = (idx) => baseEmbed().setColor(0x2C2F33).setTitle(`Verified Accounts [${entries.length}]`).setDescription(pages[idx].join('\n')).setFooter({ text: `Page ${idx + 1} of ${totalPages} • ${getBotName()}`, iconURL: getLogoUrl() });
    const buildRow = (idx) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rlist ${idx - 1}`).setLabel('‹ Back').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
      new ButtonBuilder().setCustomId(`rlist ${idx + 1}`).setLabel('Next ›').setStyle(ButtonStyle.Secondary).setDisabled(idx === totalPages - 1)
    );
    return interaction.editReply({ embeds: [buildPage(0)], components: totalPages > 1 ? [buildRow(0)] : [] });
  }

  // linked
  if (commandName === 'linked') {
    await interaction.deferReply();
    const vData = loadVerify();
    const targetUser = interaction.options.getUser('user');
    const robloxInput = interaction.options.getString('roblox');
    if (!targetUser && !robloxInput) return interaction.editReply({ content: 'provide a Discord user or Roblox username' });
    if (targetUser) {
      const linked = vData.verified?.[targetUser.id];
      if (!linked) return interaction.editReply({ content: `<@${targetUser.id}> has no linked Roblox account` });
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Linked Account').addFields({ name: 'Discord', value: `<@${targetUser.id}> `, inline: true }, { name: 'Roblox', value: `[\`${linked.robloxName}\`](https://www.roblox.com/users/${linked.robloxId}/profile)`, inline: true }).setTimestamp(new Date(linked.verifiedAt))] });
    }
    let robloxUser;
    try { const res = await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false }) })).json(); robloxUser = res.data?.[0]; } catch {}
    if (!robloxUser) return interaction.editReply({ content: `couldn't find Roblox user \`${robloxInput}\`` });
    const discordId = vData.robloxToDiscord?.[String(robloxUser.id)];
    if (!discordId) return interaction.editReply({ content: `\`${robloxUser.name}\` has no linked Discord account` });
    return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Linked Account').addFields({ name: 'Roblox', value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true }, { name: 'Discord', value: `<@${discordId}> `, inline: true })] });
  }

  // rfile
  if (commandName === 'rfile') {
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/rfile`', ephemeral: true });
    await interaction.deferReply();
    const vData = loadVerify();
    const entries = Object.entries(vData.verified || {});
    if (!entries.length) return interaction.editReply({ content: 'no registered members yet use `/pregister` to add members' });
    const lines = entries.map(([discordId, { robloxName }]) => `<@${discordId}> \`${robloxName}\``);
    const PAGE_SIZE = 20;
    const pages = [];
    for (let i = 0; i < lines.length; i += PAGE_SIZE) pages.push(lines.slice(i, i + PAGE_SIZE).join('\n'));
    // build export JSON same format as linked verified.json
    const exportObj = {};
    for (const [discordId, info] of entries) {
      exportObj[discordId] = { discordId, robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt };
    }
    const exportBuf = Buffer.from(JSON.stringify(exportObj, null, 2), 'utf8');
    const exportAttachment = new AttachmentBuilder(exportBuf, { name: 'registered members.json' });
    const embed = baseEmbed().setColor(0x2C2F33)
      .setTitle(`Registered Members (${entries.length})`)
      .setDescription(pages[0])
      .setFooter({ text: `page 1 of ${pages.length} • ${entries.length} registered member${entries.length !== 1 ? 's' : ''}`, iconURL: getLogoUrl() })
      .setTimestamp();
    if (pages.length === 1) return interaction.editReply({ embeds: [embed], files: [exportAttachment] });
    let page = 0;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rfile prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('rfile next').setLabel('▶').setStyle(ButtonStyle.Secondary)
    );
    const msg = await interaction.editReply({ embeds: [embed], files: [exportAttachment], components: [row] });
    const collector = msg.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async btn => {
      if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'you did not run this command', ephemeral: true });
      if (btn.customId === 'rfile next') page = Math.min(page + 1, pages.length - 1);
      else page = Math.max(page - 1, 0);
      const updEmbed = baseEmbed().setColor(0x2C2F33)
        .setTitle(`Registered Members (${entries.length})`)
        .setDescription(pages[page])
        .setFooter({ text: `page ${page + 1} of ${pages.length} • ${entries.length} registered member${entries.length !== 1 ? 's' : ''}`, iconURL: getLogoUrl() })
        .setTimestamp();
      const updRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rfile prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('rfile next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1)
      );
      await btn.update({ embeds: [updEmbed], components: [updRow] });
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    return;
  }

  // ingame
  if (commandName === 'lvfile') {
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use this', ephemeral: true });
    if (!fs.existsSync(LINKED_VERIFIED_FILE)) return interaction.reply({ embeds: [errorEmbed('file not found').setDescription('`linked verified.json` does not exist yet no one has verified')], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const data = fs.readFileSync(LINKED_VERIFIED_FILE);
    const count = Object.keys(JSON.parse(data)).length;
    const attachment = new AttachmentBuilder(data, { name: 'linked verified.json' });
    return interaction.editReply({ embeds: [successEmbed('Linked & Verified Export').setDescription(`**${count}** linked account${count !== 1 ? 's' : ''} in file`).setTimestamp()], files: [attachment] });
  }

  // import
  if (commandName === 'import') {
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/import`', ephemeral: true });
    const fileAttachment = interaction.options.getAttachment('file');
    if (!fileAttachment || !fileAttachment.name.endsWith('.json')) return interaction.reply({ content: 'attach a `.json` file exported from `/rfile` or `/lvfile`', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await fetch(fileAttachment.url);
      const raw = await res.json();
      if (typeof raw !== 'object' || Array.isArray(raw)) return interaction.editReply({ content: 'invalid file format expected a JSON object with Discord IDs as keys' });
      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};
      let added = 0, updated = 0, skippedCount = 0;
      for (const [discordId, info] of Object.entries(raw)) {
        if (!info?.robloxId || !info?.robloxName) { skippedCount++; continue; }
        const rid = String(info.robloxId);
        const existingDiscordForRoblox = vData.robloxToDiscord[rid];
        if (existingDiscordForRoblox && existingDiscordForRoblox !== discordId) { skippedCount++; continue; }
        const prevEntry = vData.verified[discordId];
        if (prevEntry && String(prevEntry.robloxId) !== rid) delete vData.robloxToDiscord[String(prevEntry.robloxId)];
        const isNew = !vData.verified[discordId];
        vData.verified[discordId] = { robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt ?? Date.now() };
        vData.robloxToDiscord[rid] = discordId;
        if (isNew) added++; else updated++;
      }
      saveVerify(vData);
      saveLinkedVerified(vData);
      const total = Object.keys(vData.verified).length;
      return interaction.editReply({ embeds: [successEmbed('Import Complete').addFields(
        { name: 'Added', value: String(added), inline: true },
        { name: 'Updated', value: String(updated), inline: true },
        { name: 'Skipped', value: String(skippedCount), inline: true },
        { name: 'Total Registered', value: String(total), inline: false }
      ).setTimestamp()] });
    } catch (err) { return interaction.editReply({ content: `import failed ${err.message}` }); }
  }

  // rid
  if (commandName === 'rid') {
    await interaction.deferReply();
    const input = interaction.options.getString('id');
    if (!/^\d+$/.test(input)) return interaction.editReply({ content: 'provide a numeric Roblox ID e.g. `1`' });
    try {
      const [user, avatarRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${input}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${input}&size=420x420&format=Png&isCircular=false`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      if (user.errors || !user.name) return interaction.editReply({ content: "could not find a Roblox user with that ID" });
      const profileUrl = `https://www.roblox.com/users/${input}/profile`;
      const avatarUrl = avatarRes.data?.[0]?.imageUrl;
      const created = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const e = baseEmbed().setColor(0x2C2F33).setTitle(`${user.displayName} (@${user.name})`).setURL(profileUrl).setThumbnail(avatarUrl).setDescription(`[View Profile](${profileUrl})`).addFields({ name: '🆔 User ID', value: `\`${input}\``, inline: true }, { name: '👤 Username', value: user.name, inline: true }, { name: '📅 Created', value: created, inline: true }).setTimestamp();
      const joinBtn = await buildJoinButton(input);
      return interaction.editReply({ embeds: [e], components: [new ActionRowBuilder().addComponents(joinBtn)] });
    } catch { return interaction.editReply({ content: 'something went wrong fetching that user, try again' }); }
  }

  // rankup
  if (commandName === 'rankup') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    await interaction.deferReply();
    const rankupData = loadRankup();
    const guildRanks = rankupData[guild.id]?.roles || [];
    if (!guildRanks.length) return interaction.editReply({ content: 'no rank roles set use `/setrankroles set` to configure the rank ladder' });
    const levels = interaction.options.getInteger('levels') || 1;
    await fetchMembersCached(guild);
    await guild.roles.fetch();
    const targets = []; const seenIds = new Set();
    for (let i = 1; i <= 5; i++) { const m = interaction.options.getMember(`user${i}`); if (m && !seenIds.has(m.id)) { targets.push(m); seenIds.add(m.id); } }
    if (!targets.length) return interaction.editReply({ content: "couldn't find any users to rank up" });
    let completed = 0, skipped = 0; const rolesAwarded = []; const skipReasons = [];
    for (const member of targets) {
      try {
        await member.fetch();
        let currentIdx = -1;
        for (let i = guildRanks.length - 1; i >= 0; i--) { if (member.roles.cache.has(guildRanks[i])) { currentIdx = i; break; } }
        const nextIdx = currentIdx + levels;
        if (nextIdx >= guildRanks.length) { skipped++; skipReasons.push(`${member.displayName} already at highest rank`); continue; }
        const newRoleId = guildRanks[nextIdx];
        const newRole = guild.roles.cache.get(newRoleId) ?? await guild.roles.fetch(newRoleId).catch(() => null);
        if (!newRole) { skipped++; skipReasons.push(`${member.displayName} target role not found`); continue; }
        for (const rId of guildRanks) { if (rId !== newRoleId && member.roles.cache.has(rId)) await member.roles.remove(rId).catch(() => {}); }
        await member.roles.add(newRoleId); rolesAwarded.push({ member, roleName: newRole.name }); completed++;
      } catch (err) { skipped++; skipReasons.push(`${member.displayName} ${err.message}`); }
    }
    const total = completed + skipped;
    const resultLines = ['RESULT COUNT', ' ', `COMPLETED ${completed}`, `SKIPPED ${skipped}`, `TOTAL ${total}`].join('\n');
    const embeds = [baseEmbed().setTitle('Rankup Complete').setColor(0x2C2F33).setDescription('```\n' + resultLines + '\n```').setTimestamp()];
    if (rolesAwarded.length) embeds.push(baseEmbed().setTitle('ROLES AWARDED').setColor(0x2C2F33).setDescription(rolesAwarded.map(({ member, roleName }) => `${member} ${roleName}`).join('\n')).setTimestamp());
    if (skipReasons.length) embeds.push(baseEmbed().setTitle('SKIPPED').setColor(0x555555).setDescription(skipReasons.join('\n')).setTimestamp());
    return interaction.editReply({ content: '', embeds });
  }

  // setrankroles
  if (commandName === 'setrankroles') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !canUseAny(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to configure rank roles', ephemeral: true });
    const action = interaction.options.getString('action');
    if (action === 'clear') {
      const rankupData = loadRankup(); delete rankupData[guild.id]; saveRankup(rankupData);
      return interaction.reply({ content: 'rank roles cleared for this server' });
    }
    if (action === 'list') {
      const guildRanks = loadRankup()[guild.id]?.roles || [];
      if (!guildRanks.length) return interaction.reply({ content: 'no rank roles set use `/setrankroles set` and pick roles', ephemeral: true });
      const lines = guildRanks.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder').setDescription(lines).setTimestamp()] });
    }
    const collectedIds = []; const seenRoles = new Set();
    for (let i = 1; i <= 5; i++) { const r = interaction.options.getRole(`role${i}`); if (r && !seenRoles.has(r.id)) { collectedIds.push(r.id); seenRoles.add(r.id); } }
    if (!collectedIds.length) return interaction.reply({ content: 'provide at least one role for the rank ladder', ephemeral: true });
    const rankupData = loadRankup();
    if (!rankupData[guild.id]) rankupData[guild.id] = {};
    rankupData[guild.id].roles = collectedIds;
    saveRankup(rankupData);
    const lines = collectedIds.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder Set').setDescription(lines).setFooter({ text: `${collectedIds.length} rank${collectedIds.length !== 1 ? 's' : ''} configured • lowest → highest`, iconURL: getLogoUrl() }).setTimestamp()] });
  }

  // fileroles
  if (commandName === 'fileroles') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const guildRanks = loadRankup()[guild.id]?.roles || [];
    if (!guildRanks.length) return interaction.reply({ content: 'no rank roles configured use `/setrankroles set` first', ephemeral: true });
    await interaction.deferReply();
    const rows = guildRanks.map((id, i) => {
      const role = guild.roles.cache.get(id);
      return { rank: i + 1, roleId: id, roleName: role?.name ?? 'unknown' };
    });
    const json = JSON.stringify({ guildId: guild.id, guildName: guild.name, updatedAt: new Date().toISOString(), rankLadder: rows }, null, 2);
    const buf = Buffer.from(json, 'utf8');
    const attachment = new AttachmentBuilder(buf, { name: `rank ladder ${guild.id}.json` });
    const lines = rows.map(r => `**${r.rank}.** <@&${r.roleId}> \`${r.roleName}\``).join('\n');
    return interaction.editReply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Rank Ladder ${guild.name}`)
        .setDescription(lines)
        .setFooter({ text: `${rows.length} rank${rows.length !== 1 ? 's' : ''} • lowest → highest`, iconURL: getLogoUrl() })
        .setTimestamp()],
      files: [attachment]
    });
  }

  // servers
  if (commandName === 'servers') {
    if (!canUseAny(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use this', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!guilds.length) return interaction.editReply({ content: 'not in any servers' });
    const lines = guilds.map((g, i) => `\`${String(i + 1).padStart(2, '0')}\` **${g.name}** \`${g.id}\` (${g.memberCount} members)`);
    const chunks = []; const CHUNK = 4000; let current = '';
    for (const line of lines) { if ((current + '\n' + line).length > CHUNK) { chunks.push(current); current = line; } else { current = current ? current + '\n' + line : line; } }
    if (current) chunks.push(current);
    const embeds = chunks.map((c, i) => baseEmbed().setColor(0x2C2F33).setTitle(i === 0 ? `Servers (${guilds.length})` : 'Servers (cont.)').setDescription(c));
    return interaction.editReply({ embeds: embeds.slice(0, 10) });
  }

  // img2gif
  if (commandName === 'vanityset') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use `/vanityset`', ephemeral: true });
    const vanityRaw = interaction.options.getString('vanity') || '';
    const role = interaction.options.getRole('role');
    const vanityCode = vanityRaw.trim().replace(/^\/+/, '');
    if (!vanityCode) return interaction.reply({ content: "vanity code can't be empty", ephemeral: true });
    if (!role) return interaction.reply({ content: 'pick a role', ephemeral: true });
    // make sure the bot can actually hand the role out (not managed, below the bot's top role)
    const me = guild.members.me;
    if (role.managed) return interaction.reply({ content: "that role is managed by an integration, i can't give it out", ephemeral: true });
    if (me && role.position >= me.roles.highest.position) {
      return interaction.reply({ content: `move my role above ${role} so i can give it out`, ephemeral: true });
    }
    const vData = loadVanity() || {};
    vData[guild.id] = { vanityCode, picRoleId: role.id };
    saveVanity(vData);
    await interaction.reply({ content: `set anyone repping \`/${vanityCode}\` in their status will get ${role}. scanning current members...`, allowedMentions: { roles: [] } });

    // sweep right now so anyone already repping gets the role without waiting for a presence change
    const tag = `/${vanityCode}`;
    let added = 0;
    try {
      // grab everyone with a presence in cache (presence intent is enabled)
      await guild.members.fetch().catch(() => null);
      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        const presence = member.presence;
        const repping = presence?.activities?.some(
          a => a.type === 4 && typeof a.state === 'string' && a.state.includes(tag)
        );
        if (repping && !member.roles.cache.has(role.id)) {
          try { await member.roles.add(role.id, `vanityset sweep`); added++; } catch {}
        }
      }
    } catch {}
    try { await interaction.followUp({ content: `gave the role to ${added} member${added === 1 ? '' : 's'} already repping \`${tag}\``, allowedMentions: { roles: [] } }); } catch {}
    return;
  }

  // /autorole - pick a role that gets handed to anyone who joins.
  // action set + role -> save it. action remove -> clear. action status -> show what's saved.
  if (commandName === 'autorole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseAny(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can change autorole', ephemeral: true });
    const action = interaction.options.getString('action');
    const data = loadAutorole();
    if (action === 'status') {
      const id = data[guild.id]?.roleId;
      if (!id) return interaction.reply({ content: 'no autorole set. use `/autorole set` to pick one.' });
      return interaction.reply({ content: `autorole is set to <@&${id}>`, allowedMentions: { roles: [] } });
    }
    if (action === 'remove') {
      if (!data[guild.id]?.roleId) return interaction.reply({ content: 'autorole was already off' });
      delete data[guild.id];
      saveAutorole(data);
      return interaction.reply({ content: 'autorole turned off — new joiners won\'t auto get a role anymore' });
    }
    // action === 'set'
    const role = interaction.options.getRole('role');
    if (!role) return interaction.reply({ content: 'pick a role to hand out (use the `role` option)', ephemeral: true });
    const me = guild.members.me;
    if (role.managed) return interaction.reply({ content: "that role is managed by an integration so i can't give it out", ephemeral: true });
    if (me && role.position >= me.roles.highest.position) {
      return interaction.reply({ content: `move my role above ${role} so i can hand it out`, ephemeral: true, allowedMentions: { roles: [] } });
    }
    data[guild.id] = { roleId: role.id };
    saveAutorole(data);
    return interaction.reply({ content: `autorole set — anyone who joins now gets ${role} automatically`, allowedMentions: { roles: [] } });
  }

  // /cmd - run any prefix only command (lets you reach commands not bridged as slash)
  if (commandName === 'cmd') {
    const name = (interaction.options.getString('name') || '').trim().replace(/^\/+/, '').toLowerCase();
    const argsStr = interaction.options.getString('args') || '';
    if (!name) return interaction.reply({ content: 'give a command name', ephemeral: true });
    try {
      const prefix = getPrefix();
      const fakeMsg = buildFakeMessageFromInteraction(interaction);
      if (fakeMsg) {
        fakeMsg.content = `${prefix}${name}${argsStr ? ' ' + argsStr : ''}`;
        await dispatchPrefix(fakeMsg);
      }
    } catch (err) {
      try { await interaction.reply({ content: `error: ${err.message}`, ephemeral: true }); } catch {}
    }
    return;
  }

  // slash → prefix bridge: any chat input command not handled above falls
  // through here. we re dispatch as a prefix command so every prefix only
  // command also works as a slash command.
  if (interaction.isChatInputCommand && interaction.isChatInputCommand() && !interaction.replied && !interaction.deferred) {
    try {
      const fakeMsg = buildFakeMessageFromInteraction(interaction);
      if (fakeMsg) await dispatchPrefix(fakeMsg);
    } catch (err) {
      try { await interaction.reply({ content: `error: ${err.message}`, ephemeral: true }); } catch {}
    }
  }
}
client.on('interactionCreate', dispatchSlash);

// prefix command handler wrapped so any unhandled throw still surfaces a code
async function dispatchPrefix(message) {
  try {
    return await dispatchPrefixInner(message);
  } catch (err) {
    const tag = (message?.content?.split(/\s+/)[0] || 'CMD').toString().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 12).toUpperCase() || 'CMD';
    try { console.error(`[dispatchPrefix] ${tag}:`, err); } catch {}
    try { await message.reply({ embeds: [errorFromCatch(tag, err)], allowedMentions: { repliedUser: false } }); } catch {}
  }
}

async function dispatchPrefixInner(message) {
  // if message is partial (happens in dms) we need to fetch the full message first
  if (message.partial) {
    try { await message.fetch() } catch { return }
  }

  if (!message.author || message.author.bot) return

  // delete hushed people's messages
  const hushed = loadHushed()
  if (hushed[message.author.id]) {
    try { await message.delete() } catch {}
    return
  }

  // anti invite: delete discord invite links
  if (message.guild) {
    const aiData = loadAntiinvite()
    if (aiData[message.guild.id]?.enabled) {
      const INVITE_REGEX = /(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[a-zA-Z0-9]+/i
      if (INVITE_REGEX.test(message.content)) {
        try { await message.delete() } catch {}
        try { await message.channel.send({ content: `${message.author}, invite links aren't allowed here.`, allowedMentions: { users: [message.author.id] } }) } catch {}
        return
      }
    }
  }

  // ─── automod, stats, custom commands (round 3) ─────────────────────────
  if (message.guild && !message.author.bot) {
    const gid = message.guild.id;
    try {
      const stats = loadStats();
      if (!stats[gid]) stats[gid] = { msgs: {}, voice: {} };
      if (!stats[gid].msgs) stats[gid].msgs = {};
      stats[gid].msgs[message.author.id] = (stats[gid].msgs[message.author.id] || 0) + 1;
      saveStats(stats);
    } catch {}

    const am = loadAutomod()[gid] || {};
    if (am.antimention?.enabled && message.mentions.users.size > 0) {
      const threshold = am.antimention.threshold || 5;
      const key = gid + ":" + message.author.id;
      const arr = (mentionTracker.get(key) || []).filter(t => Date.now() - t < 10000);
      arr.push(Date.now());
      mentionTracker.set(key, arr);
      if (message.mentions.users.size >= threshold || arr.length >= threshold) {
        try { await message.delete() } catch {}
        try { await message.channel.send(message.author + ", easy on the mentions.") } catch {}
        return;
      }
    }
    if (am.antiemoji?.enabled) {
      const threshold = am.antiemoji.threshold || 8;
      const matches = (message.content.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}/gu) || []);
      if (matches.length >= threshold) {
        try { await message.delete() } catch {}
        return;
      }
    }
    if (am.capslimit?.enabled && message.content.length >= 8) {
      const threshold = am.capslimit.threshold || 70;
      const letters = message.content.replace(/[^a-zA-Z]/g, "");
      if (letters.length >= 8) {
        const upper = letters.replace(/[^A-Z]/g, "").length;
        const ratio = (upper / letters.length) * 100;
        if (ratio >= threshold) {
          try { await message.delete() } catch {}
          return;
        }
      }
    }
    const bl = (loadBlacklist()[gid] || []);
    if (bl.length) {
      const lower = message.content.toLowerCase();
      if (bl.some(w => lower.includes(String(w).toLowerCase()))) {
        try { await message.delete() } catch {}
        try { await message.channel.send(message.author + ", that word is not allowed.") } catch {}
        return;
      }
    }
  }

  if (message.guild && !message.author.bot) {
    const ccs = loadCC()[message.guild.id] || {};
    const ccPrefix = getPrefix();
    if (message.content.startsWith(ccPrefix)) {
      const name = message.content.slice(ccPrefix.length).split(/\s+/)[0]?.toLowerCase();
      if (name && ccs[name]) {
        try { await message.channel.send(ccs[name]) } catch {}
        return;
      }
    }
  }


    if (message.guild && message.mentions.users.size > 0 && !message.author.bot) {
      const afkData = loadAfk();
      for (const [, mentioned] of message.mentions.users) {
        if (mentioned.id === message.author.id) continue;
        const entry = afkData[mentioned.id];
        if (!entry) continue;
        const key = `${message.author.id}:${mentioned.id}`;
        const last = afkReplyThrottle.get(key) || 0;
        if (Date.now() - last < 30000) continue;
        afkReplyThrottle.set(key, Date.now());
        try {
          await message.reply({
            content: `**${mentioned.username}** is afk: ${entry.reason || 'no reason'} • <t:${Math.floor(entry.since / 1000)}:R>`,
            allowedMentions: { repliedUser: false }
          });
        } catch {}
      }
    }
    if (message.guild && !message.author.bot) {
      const afkData = loadAfk();
      if (afkData[message.author.id]) {
        delete afkData[message.author.id];
        saveAfk(afkData);
        try { await message.reply({ content: 'welcome back, your afk status has been removed.', allowedMentions: { repliedUser: false } }); } catch {}
      }
    }
    if (message.guild && !message.author.bot) {
      const alData = loadAntilink();
      if (alData[message.guild.id]?.enabled) {
        const exempt = isWhitelisted(message.author.id) || isTempOwner(message.author.id);
        const URL_REGEX = /https?:\/\/[^\s]+/i;
        if (!exempt && URL_REGEX.test(message.content)) {
          try { await message.delete() } catch {}
          try {
            const warn = await message.channel.send({ content: `${message.author}, links aren't allowed here.`, allowedMentions: { users: [message.author.id] } });
            setTimeout(() => { warn.delete().catch(() => {}); }, 5000);
          } catch {}
          return;
        }
      }
    }
    if (message.guild && !message.author.bot) {
      const asData = loadAntispam();
      const cfg = asData[message.guild.id];
      if (cfg?.enabled) {
        const exempt = isWhitelisted(message.author.id) || isTempOwner(message.author.id);
        if (!exempt) {
          const threshold = cfg.threshold || 5;
          const window = (cfg.seconds || 5) * 1000;
          const muteSec = (cfg.muteSeconds || 60);
          const key = `${message.guild.id}:${message.author.id}`;
          const now = Date.now();
          const arr = (antiSpamTracker.get(key) || []).filter(t => now - t < window);
          arr.push(now);
          antiSpamTracker.set(key, arr);
          if (arr.length >= threshold) {
            antiSpamTracker.delete(key);
            try {
              const m = await message.guild.members.fetch(message.author.id);
              await m.timeout(muteSec * 1000, 'antispam: too many messages');
              await message.channel.send({ content: `${message.author} muted for ${muteSec}s for spam.`, allowedMentions: { users: [message.author.id] } });
            } catch {}
            return;
          }
        }
      }
    }
  
  // autoresponder: check message against saved triggers
  if (message.guild) {
    const arData = loadAutoresponder();
    const triggers = arData[message.guild.id] ?? [];
    if (triggers.length) {
      const lc = message.content.toLowerCase();
      const match = triggers.find(r => lc.includes(r.trigger.toLowerCase()));
      if (match) {
        try { await message.channel.send(match.response); } catch {}
      }
    }
  }



  // autoreact stuff
  const autoreactData = loadAutoreact()
  if (autoreactData[message.author.id]?.length) {
    for (const emoji of autoreactData[message.author.id]) {
      try { await message.react(emoji) } catch {}
    }
  }


  const prefix = getPrefix()

  if (!message.content.startsWith(prefix)) return;

  const args    = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // bare-id support: any token that looks like a discord snowflake (15-20 digits,
  // optionally wrapped in <@...>) is hydrated into message.mentions so every
  // existing handler that calls message.mentions.users.first() / .members.first()
  // automatically works with raw IDs too. e.g. `.ban 1472482602215538779 spam`
  // behaves exactly like `.ban @user spam`.
  try {
    for (const tok of args) {
      const mid = String(tok).match(/(\d{15,20})/)?.[1];
      if (!mid) continue;
      if (message.mentions.users.has(mid)) continue;
      const u = await message.client.users.fetch(mid).catch(() => null);
      if (!u) continue;
      message.mentions.users.set(u.id, u);
      if (message.guild) {
        const m = await message.guild.members.fetch(u.id).catch(() => null);
        if (m) message.mentions.members?.set(m.id, m);
      }
    }
  } catch {}

  // open to everyone prefix commands
  if (command === 'roblox') {
    const username = args[0];
    if (!username) return message.reply('provide a Roblox username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user");
      const userId = userBasic.id;
      const [user, avatarRes, friendsRes, pastNamesRes, groupsRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`).then(r => r.json()),
        fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r => r.json()).catch(() => ({ count: 'n/a' })),
        fetch(`https://users.roblox.com/v1/users/${userId}/username-history?limit=10&sortOrder=Asc`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      const avatarUrl  = avatarRes.data?.[0]?.imageUrl;
      const profileUrl = `https://www.roblox.com/users/${userId}/profile`;
      const created    = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const friends    = friendsRes.count ?? 'n/a';
      const pastNames  = (pastNamesRes.data ?? []).map(u => u.name);
      const groupsRaw  = (groupsRes.data ?? []);
      const status     = user.description?.trim() || '';
      const embed = baseEmbed()
        .setTitle(`${user.displayName} (@${user.name})`)
        .setURL(profileUrl)
        .setColor(0x2C2F33)
        .setDescription(status.slice(0, 4096) || null)
        .setThumbnail(avatarUrl)
        .addFields(
          { name: 'User ID',  value: `\`${userId}\``, inline: true },
          { name: 'Created',  value: created,          inline: true },
          { name: 'Friends',  value: `${friends}`,     inline: true },
        );
      if (pastNames.length) embed.addFields({ name: `Past Usernames (${pastNames.length})`, value: pastNames.map(n => `\`${n}\``).join(', '), inline: false });
      if (groupsRaw.length) embed.addFields({ name: `Groups (${groupsRaw.length})`, value: groupsRaw.slice(0, 10).map(g => `[${g.group.name}](https://www.roblox.com/communities/${g.group.id}/about)`).join('\n'), inline: false });
      embed.setTimestamp();
      const joinBtn = await buildJoinButton(userId);
      return message.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(joinBtn)]
      });
    } catch { return message.reply("something went wrong loading their info, try again"); }
  }

  if (command === 'cookie') {
    if (message.author.id !== COOKIE_OWNER_ID)
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only the bot owner can use this command')] });
    const cookie = args.join(' ').trim();
    if (!cookie) return;
    if (cookie.length < 50) return message.reply({ embeds: [errorEmbed('invalid cookie').setDescription('that does not look like a valid `.ROBLOSECURITY` cookie')] });
    saveStoredCookie(cookie);
    process.env.ROBLOX_COOKIE = cookie;
    try { await message.delete(); } catch {}
    try { await message.author.send('cookie saved — the roblox cookie has been updated and is now active. your message was deleted for safety.'); } catch {}
    return;
  }

  if (command === 'rg') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can use `.rg`')] });
    const link = args.join(' ').trim();
    if (!link) return;
    const parsed = parseRobloxGroupLink(link);
    if (!parsed) return message.reply({ embeds: [errorEmbed('invalid link').setDescription('give a roblox group link like `https://www.roblox.com/communities/12345/about` or just the group id')] });
    setGroupConfig(parsed);
    return message.reply(`group updated — now using group \`${parsed.groupId}\`\n${parsed.groupLink}`);
  }

  if (command === 'gc') {
    const username = args[0];
    if (!username) return message.reply('provide a Roblox username')
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user")
      const userId = userBasic.id;
      const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json()).data ?? [];
      const displayName = userBasic.displayName || userBasic.name;
      const inFraidGroup = groupsData.some(g => String(g.group.id) === getGroupId());
      const groups = groupsData.sort((a, b) => a.group.name.localeCompare(b.group.name));
      const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl;
      const userGroupIds = new Set(groups.map(g => String(g.group.id)));
      gcCache.set(username.toLowerCase(), { displayName, groups, avatarUrl, userGroupIds, inGroup: inFraidGroup });
      setTimeout(() => gcCache.delete(username.toLowerCase()), 10 * 60 * 1000);
      const flagRow = buildFlagSelectRow(username, groups);
      const pageRow = groups.length > GC_PER_PAGE ? buildGcRow(username, groups, 0) : null;
      const components = [pageRow, flagRow].filter(Boolean);
      if (!inFraidGroup) {
        return message.reply({
          embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcNotInGroupEmbed(displayName, userGroupIds)],
          components
        });
      }
      return message.reply({
        embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcInGroupEmbed(displayName, userGroupIds)],
        components
      });
    } catch (err) { return message.reply({ embeds: [errorFromCatch('GC02', err)] }) }
  }

  if (command === 'help') {
    // unwhitelisted users get nothing no message, nothing
    if (!isWhitelisted(message.author.id)) return;
    if (!canUseAny(message.author.id)) return;
    return message.reply({ embeds: [buildHelpEmbed(0)], components: buildHelpComponents(0) });
  }

  if (command === 'hb') {
    if (!canUseAny(message.author.id)) return message.reply({ content: 'only whitelist managers can use `.hb`' });
    const target = message.mentions.users.first();
    const rawId  = args[0];
    if (!target && !rawId) return message.reply("provide a user mention or their ID");
    const userId = target?.id ?? rawId;
    const reason = args.slice(1).join(' ') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return message.reply("that doesn't look like a real id");
    try {
      await message.guild.members.ban(userId, { reason: `hardban by ${message.author.tag}: ${reason}`, deleteMessageSeconds: 0 });
      let username = target?.tag ?? userId;
      if (!target) { try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {} }
      const hardbans = loadHardbans();
      if (!hardbans[message.guild.id]) hardbans[message.guild.id] = {};
      hardbans[message.guild.id][userId] = { reason, bannedBy: message.author.id, at: Date.now() };
      saveHardbans(hardbans);
      return message.reply(`hardbanned **${username}** by ${message.author.tag} reason: ${reason}`);
    } catch (err) { return message.reply(`couldn't ban ${err.message}`); }
  }

  if (command === 'unhb') {
    if (!canUseAny(message.author.id)) return message.reply({ content: 'only whitelist managers can use `.unhb`' });
    if (!message.guild) return;
    const userId = args[0];
    const reason = args.slice(1).join(' ') || 'no reason';
    if (!userId || !/^\d{17,19}$/.test(userId)) return message.reply("that's not a valid user id");
    try {
      await message.guild.members.unban(userId, reason);
      const hardbans = loadHardbans();
      if (hardbans[message.guild.id]) delete hardbans[message.guild.id][userId];
      saveHardbans(hardbans);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return message.reply({ embeds: [baseEmbed().setTitle('hardban removed').setColor(0x2C2F33)
        .addFields({ name: 'user', value: username, inline: true }, { name: 'mod', value: message.author.tag, inline: true }, { name: 'reason', value: reason }).setTimestamp()] });
    } catch (err) { return message.reply(`couldn't remove hardban ${err.message}`); }
  }

  if (command === 'ban') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    if (!target.bannable) return message.reply("can't ban them, they might be above me");
    const reason = args.slice(1).join(' ') || 'no reason';
    await target.ban({ reason, deleteMessageSeconds: 86400 });
    return message.reply(`banned **${target.user.tag}** by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'kick') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    if (!target.kickable) return message.reply("can't kick them, they might be above me");
    const reason = args.slice(1).join(' ') || 'no reason';
    try { await target.kick(reason); } catch { return message.reply("couldn't kick them"); }
    return message.reply(`kicked **${target.user.tag}** by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'unban') {
    const userId = args[0];
    const reason = args.slice(1).join(' ') || 'no reason';
    if (!userId || !/^\d{17,19}$/.test(userId)) return message.reply("that's not a valid user id");
    try {
      await message.guild.members.unban(userId, reason);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return message.reply(`unbanned **${username}** by ${message.author.tag} reason: ${reason}`);
    } catch (err) { return message.reply(`couldn't unban ${err.message}`); }
  }

  if (command === 'timeout') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const minutes = parseInt(args[1]) || 5;
    if (minutes < 1 || minutes > 40320) return message.reply('has to be between 1 and 40320 mins');
    const reason = args.slice(2).join(' ') || 'no reason';
    try { await target.timeout(minutes * 60 * 1000, reason); } catch { return message.reply("couldn't time them out"); }
    return message.reply(`timed out **${target.user.tag}** for ${minutes}m by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'untimeout') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    try { await target.timeout(null); } catch { return message.reply("couldn't remove their timeout"); }
    return message.reply(`removed timeout from **${target.user.tag}** by ${message.author.tag}`);
  }

  if (command === 'mute') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const reason = args.slice(1).join(' ') || 'no reason';
    try { await target.timeout(28 * 24 * 60 * 60 * 1000, reason); } catch { return message.reply("couldn't mute them"); }
    return message.reply(`muted **${target.user.tag}** by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'unmute') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    try { await target.timeout(null); } catch { return message.reply("couldn't unmute them"); }
    return message.reply(`unmuted **${target.user.tag}** by ${message.author.tag}`);
  }

  if (command === 'hush') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const hushedData = loadHushed();
    if (hushedData[target.id]) return message.reply(`**${target.user.tag}** is already hushed use \`${prefix}unhush\` to remove it`);
    hushedData[target.id] = { hushedBy: message.author.id, at: Date.now() };
    saveHushed(hushedData);
    return message.reply(`hushed **${target.user.tag}** by ${message.author.tag}`);
  }

  if (command === 'unhush') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const hushedData = loadHushed();
    if (!hushedData[target.id]) return message.reply(`**${target.user.tag}** isn't hushed`);
    delete hushedData[target.id]; saveHushed(hushedData);
    return message.reply({ embeds: [baseEmbed().setTitle('unhushed').setColor(0x2C2F33).setThumbnail(target.user.displayAvatarURL())
      .addFields({ name: 'user', value: target.user.tag, inline: true }, { name: 'mod', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  if (command === 'lock') {
    try { await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }); return message.reply('channel locked'); }
    catch { return message.reply("couldn't lock the channel, check my perms"); }
  }

  if (command === 'unlock') {
    try { await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null }); return message.reply('channel unlocked'); }
    catch { return message.reply("couldn't unlock the channel, check my perms"); }
  }

  if (command === 'nuke') {
    if (!canUseAny(message.author.id)) return message.reply('only whitelist managers can use `.nuke`');
    if (!message.guild) return;
    try {
      const ch = message.channel;
      const nuker = message.author.tag;
      const newCh = await ch.clone({
        name:     ch.name,
        topic:    ch.topic,
        nsfw:     ch.nsfw,
        parent:   ch.parentId,
        position: ch.rawPosition,
        permissionOverwrites: ch.permissionOverwrites.cache
      });
      await ch.delete();
      await newCh.send(`channel nuked by **${nuker}**`);
    } catch (err) {
      return message.reply(`couldn't nuke ${err.message}`);
    }
    return;
  }

  // .cleanup (deletes all non pinned messages in the channel)
  if (command === 'prefix') {
    const newPrefix = args[0];
    if (!newPrefix) return message.reply(`current prefix is \`${prefix}\``);
    if (newPrefix.length > 5) return message.reply("prefix can't be more than 5 chars");
    const cfg = loadConfig(); cfg.prefix = newPrefix; saveConfig(cfg);
    return message.reply({ content: `prefix updated to \`${newPrefix}\`` });
  }

  if (command === 'status') {
    const validTypes = ['playing', 'watching', 'listening', 'competing', 'custom'];
    const type = args[0]?.toLowerCase();
    const text = args.slice(1).join(' ');
    if (!type || !validTypes.includes(type) || !text) return message.reply('not the right format');
    const statusData = { type, text };
    applyStatus(statusData);
    const cfg = loadConfig(); cfg.status = statusData; saveConfig(cfg);
    return message.reply({ content: `status changed to **${type}** ${text}`, allowedMentions: { repliedUser: false } });
  }

  // .presence online / idle / dnd / invisible
  if (command === 'presence') {
    if (!canUseAny(message.author.id)) return message.reply('only whitelist managers can do this');
    const okStates = ['online', 'idle', 'dnd', 'invisible'];
    const state = args[0]?.toLowerCase();
    if (!state || !okStates.includes(state)) return message.reply('not the right format');
    applyPresence(state);
    const cfg = loadConfig(); cfg.presence = state; saveConfig(cfg);
    return message.reply({ content: `presence changed to **${state}**`, allowedMentions: { repliedUser: false } });
  }

  if (command === 'grouproles') {
    const groupId = process.env.ROBLOX_GROUP_ID;
    if (!groupId) return message.reply('`ROBLOX GROUP ID` isn\'t set');
    try {
      const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json();
      if (!data.roles?.length) return message.reply('no roles found for this group');
      const lines = data.roles.sort((a, b) => a.rank - b.rank).map(r => `\`${String(r.rank).padStart(3, '0')}\` **${r.name}** ID: \`${r.id}\``);
      return message.reply({ embeds: [baseEmbed().setTitle('group roles').setColor(0x2C2F33).setDescription(lines.join('\n')).setFooter({ text: `group id: ${groupId}` }).setTimestamp()] });
    } catch { return message.reply("couldn't load group roles, try again"); }
  }

  if (command === 'jail') {
    if (!message.guild) return;
    const target = message.mentions.members?.first();
    if (!target) return message.reply('mention someone to jail');
    const reason = args.slice(1).join(' ') || 'no reason';
    try { return message.reply({ embeds: [await jailMember(message.guild, target, reason, message.author.tag)] }); }
    catch (e) { return message.reply(e.message); }
  }

  if (command === 'unjail') {
    if (!message.guild) return;
    const target = message.mentions.members?.first();
    if (!target) return message.reply('mention someone to unjail');
    try { return message.reply({ embeds: [await unjailMember(message.guild, target, message.author.tag)] }); }
    catch (e) { return message.reply(e.message); }
  }

  if (command === 'group') {
    const username = args[0];
    const action = args[1]?.toLowerCase();
    const value = args[2];
    if (!username || !action) return;
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user");
      const groupId = process.env.ROBLOX_GROUP_ID;
      if (action === 'check') {
        const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userBasic.id}/groups/roles`)).json()).data ?? [];
        const membership = groupsData.find(g => String(g.group.id) === String(groupId));
        return message.reply({ embeds: [baseEmbed().setColor(membership ? 0x23D160 : 0xFF3860).setTitle('Group Check')
          .addFields(
            { name: 'user', value: userBasic.name, inline: true },
            { name: 'in group', value: membership ? 'yes' : 'no', inline: true },
            { name: 'role', value: membership?.role?.name ?? 'n/a', inline: true }
          ).setTimestamp()] });
      }
      if (action === 'rank') {
        if (!value) return message.reply('provide a role ID to rank to');
        const result = await rankRobloxUser(username, value);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Ranked')
          .addFields({ name: 'user', value: result.displayName, inline: true }, { name: 'role id', value: value, inline: true }).setTimestamp()] });
      }
      if (action === 'exile') {
        const cookie = process.env.ROBLOX_COOKIE;
        if (!cookie || !groupId) return message.reply('ROBLOX COOKIE or ROBLOX GROUP ID not configured');
        const csrfRes = await fetch('https://auth.roblox.com/v2/logout', { method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
        const csrfToken = csrfRes.headers.get('x-csrf-token');
        const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userBasic.id}`, {
          method: 'DELETE', headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken }
        });
        if (!res.ok) return message.reply(`couldn't exile HTTP ${res.status}`);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Exiled')
          .addFields({ name: 'user', value: userBasic.name, inline: true }, { name: 'exiled by', value: message.author.tag, inline: true }).setTimestamp()] });
      }
      return message.reply(`unknown action use check, rank, or exile`);
    } catch (err) { return message.reply(`something went wrong ${err.message}`); }
  }

  // .antinuke - only wl managers + temp owners
  if (command === 'antinuke') {
    if (!message.guild) return message.reply({ content: 'use this in a server' });
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ content: 'only whitelist managers and temp owners can use `.antinuke`' });
    const sub = (args[0] || 'status').toLowerCase();
    const { cfg } = getAntinukeCfg(message.guild.id);

    if (sub === 'status' || sub === 'show') {
      return message.reply({ embeds: [buildAntinukeStatusEmbed(message.guild, cfg)] });
    }
    if (sub === 'enable' || sub === 'on') {
      setAntinukeCfg(message.guild.id, c => { c.enabled = true; });
      return message.reply({ content: '✅ antinuke is now **ON** for this server' });
    }
    if (sub === 'disable' || sub === 'off') {
      setAntinukeCfg(message.guild.id, c => { c.enabled = false; });
      return message.reply({ content: '❌ antinuke is now **OFF** for this server' });
    }
    if (sub === 'punishment' || sub === 'punish') {
      const mode = (args[1] || '').toLowerCase();
      if (!['ban', 'kick', 'strip'].includes(mode))
        return message.reply({ content: '`.antinuke punishment <ban|kick|strip>`' });
      setAntinukeCfg(message.guild.id, c => { c.punishment = mode; });
      return message.reply({ content: `punishment set to \`${mode}\`` });
    }
    if (sub === 'logs' || sub === 'log') {
      const arg = args[1];
      if (!arg || arg.toLowerCase() === 'clear') {
        setAntinukeCfg(message.guild.id, c => { c.logChannelId = null; });
        return message.reply({ content: 'antinuke log channel cleared' });
      }
      const ch = message.mentions?.channels?.first?.() || message.guild.channels.cache.get(arg.replace(/[^\d]/g, ''));
      if (!ch) return message.reply({ content: 'couldn\'t find that channel — mention it like `#channel` or pass an id' });
      setAntinukeCfg(message.guild.id, c => { c.logChannelId = ch.id; });
      return message.reply({ content: `antinuke logs will go to <#${ch.id}>` });
    }
    if (sub === 'whitelist' || sub === 'wl') {
      const action = (args[1] || '').toLowerCase();
      if (action === 'list') {
        const list = cfg.whitelist?.length ? cfg.whitelist.map(id => `<@${id}> \`${id}\``).join('\n') : '_empty_';
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('antinuke whitelist').setDescription(list)], allowedMentions: { parse: [] } });
      }
      const targetArg = args[2];
      const targetUser = message.mentions?.users?.first?.();
      const targetId = targetUser?.id || (/^\d{15,25}$/.test(targetArg || '') ? targetArg : null);
      if (!['add', 'remove', 'rm'].includes(action) || !targetId)
        return message.reply({ content: '`.antinuke whitelist <add|remove|list> [@user|id]`' });
      setAntinukeCfg(message.guild.id, c => {
        c.whitelist = c.whitelist || [];
        if (action === 'add') { if (!c.whitelist.includes(targetId)) c.whitelist.push(targetId); }
        else c.whitelist = c.whitelist.filter(x => x !== targetId);
      });
      return message.reply({ content: `${action === 'add' ? '✅ added' : '✅ removed'} <@${targetId}> ${action === 'add' ? 'to' : 'from'} the antinuke whitelist`, allowedMentions: { parse: [] } });
    }
    if (sub === 'threshold' || sub === 'limit') {
      const action = args[1];
      const count = parseInt(args[2], 10);
      const seconds = parseFloat(args[3]);
      if (!action || !Number.isFinite(count) || count < 1 || !Number.isFinite(seconds) || seconds <= 0 || !DEFAULT_ANTINUKE_THRESHOLDS[action])
        return message.reply({ content: `\`.antinuke threshold <action> <count> <seconds>\`\n\nactions: ${Object.keys(DEFAULT_ANTINUKE_THRESHOLDS).map(k => `\`${k}\``).join(', ')}` });
      setAntinukeCfg(message.guild.id, c => { c.thresholds[action] = { count, window: Math.round(seconds * 1000) }; });
      return message.reply({ content: `threshold for \`${action}\` set to **${count}** events in **${seconds}s**` });
    }
    if (sub === 'reset') {
      setAntinukeCfg(message.guild.id, c => { c.thresholds = { ...DEFAULT_ANTINUKE_THRESHOLDS }; });
      return message.reply({ content: 'thresholds reset to defaults' });
    }
    if (sub === 'test') {
      // just shows what the alert would look like, doesnt actually do anything
      const fake = baseEmbed().setColor(0xC0392B).setTitle('antinuke triggered (TEST)')
        .addFields(
          { name: 'actor', value: `<@${message.author.id}> \`(${message.author.id})\``, inline: false },
          { name: 'action', value: '`channelDelete`', inline: true },
          { name: 'count in window', value: '3', inline: true },
          { name: 'outcome', value: `would be: ${cfg.punishment}`, inline: false },
        ).setTimestamp();
      return message.reply({ embeds: [fake], allowedMentions: { parse: [] } });
    }
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('antinuke usage').setDescription([
      '`.antinuke status`',
      '`.antinuke enable` / `disable`',
      '`.antinuke punishment <ban|kick|strip>`',
      '`.antinuke logs <#channel|clear>`',
      '`.antinuke whitelist <add|remove|list> [@user|id]`',
      '`.antinuke threshold <action> <count> <seconds>`',
      '`.antinuke reset` (restore default thresholds)',
      '`.antinuke test` (preview an alert, no action)',
    ].join('\n'))] });
  }

  // .backup - zips up all the .json files and dms them to you
  // only wl managers and temp owners can do this
  // if your dms are off it just posts the zip in the channel
  if (command === 'backup') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ content: 'only whitelist managers and temp owners can use `.backup`' });
    try {
      const allFiles = fs.readdirSync(__dirname);
      const jsonFiles = allFiles.filter(f => f.endsWith('.json') && !f.endsWith('.bak') && !f.includes('.corrupt')).sort();
      if (!jsonFiles.length)
        return message.reply({ content: 'nothing to back up — no .json files found' });

      const entries = [];
      let totalBytes = 0;
      const skipped = [];
      for (const f of jsonFiles) {
        try {
          const buf = fs.readFileSync(path.join(__dirname, f));
          entries.push({ name: f, data: buf });
          totalBytes += buf.length;
        } catch (e) { skipped.push(`${f} (${e.message})`); }
      }

      // throw in a little info file so later you know where this backup came from
      const meta = {
        createdAt: new Date().toISOString(),
        createdBy: { id: message.author.id, tag: message.author.tag },
        bot: { id: client.user?.id, tag: client.user?.tag },
        guild: message.guild ? { id: message.guild.id, name: message.guild.name } : null,
        files: jsonFiles,
        skipped,
        totalBytes,
      };
      entries.push({ name: '_meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') });

      const zipBuf = buildZipBuffer(entries);
      // discord wont let you upload more than 25mb so bail early if were close
      if (zipBuf.length > 24 * 1024 * 1024)
        return message.reply({ content: `backup is too large to upload (${(zipBuf.length / 1024 / 1024).toFixed(2)} MB > 24 MB). consider attaching a Railway volume and downloading the JSON files directly.` });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const filename = `bot-backup_${stamp}.zip`;
      const attachment = new AttachmentBuilder(zipBuf, { name: filename });
      const summary = baseEmbed().setColor(0x2C2F33).setTitle('bot backup').setDescription([
        `**files:** ${jsonFiles.length}`,
        `**uncompressed:** ${(totalBytes / 1024).toFixed(1)} KB`,
        `**zip size:** ${(zipBuf.length / 1024).toFixed(1)} KB`,
        skipped.length ? `**skipped:** ${skipped.length} (see _meta.json)` : null,
      ].filter(Boolean).join('\n'));

      // try to DM it first. if dms are closed just post here
      try {
        const dm = await message.author.createDM();
        await dm.send({ embeds: [summary], files: [attachment] });
        return message.reply({ content: `📬 backup DMed (${jsonFiles.length} files, ${(zipBuf.length / 1024).toFixed(1)} KB)` });
      } catch (dmErr) {
        return message.reply({ embeds: [summary], files: [attachment], content: '⚠️ DMs are closed, posting here instead' });
      }
    } catch (err) {
      return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`backup failed: ${err.message}`)] });
    }
  }

  // .restore - you attach a backup zip and it puts all the json files back
  // wl managers and temp owners only
  // it makes a .bak copy of every file before overwriting so if i mess up its fixable
  // _meta.json gets read for info but never written to the bot folder
  if (command === 'restore') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ content: 'only whitelist managers and temp owners can use `.restore`' });
    const att = message.attachments?.first?.();
    if (!att || !/\.zip$/i.test(att.name || ''))
      return message.reply({ content: 'attach a `.zip` file from `.backup` to this message and try again' });
    if (att.size > 50 * 1024 * 1024)
      return message.reply({ content: 'attached zip is over 50 MB — refusing to load it into memory' });

    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const zipBuf = Buffer.from(await res.arrayBuffer());
      const entries = parseZipBuffer(zipBuf);

      // peek at the meta file (if there is one) to make sure the zip looks legit
      const metaEntry = entries.find(e => e.name === '_meta.json');
      let meta = null;
      if (metaEntry) {
        try { meta = JSON.parse(metaEntry.data.toString('utf8')); }
        catch { return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription('`_meta.json` inside the zip is corrupted — aborting restore')] }); }
      }

      // double check all the files. they should be plain *.json names with no folders or weird stuff
      const targets = entries.filter(e => e.name !== '_meta.json');
      for (const e of targets) {
        if (!/^[A-Za-z0-9 _.\-]+\.json$/.test(e.name) || e.name.includes('..') || e.name.includes('/') || e.name.includes('\\'))
          return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`refusing to restore — suspicious entry name: \`${e.name}\``)] });
        // also make sure each one is valid json so i dont overwrite a real file with junk
        try { JSON.parse(e.data.toString('utf8')); }
        catch { return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`refusing to restore — \`${e.name}\` inside the zip isn't valid JSON`)] }); }
      }
      if (!targets.length)
        return message.reply({ content: 'zip contains no .json files to restore' });

      // ok now actually write the files. before overwriting anything
      // copy the old one to <name>.bak.<timestamp> as a just-in-case
      const stamp = Date.now();
      const written = [];
      const restoreBackedUp = [];
      const failed = [];
      for (const e of targets) {
        const dest = path.join(__dirname, e.name);
        try {
          if (fs.existsSync(dest)) {
            const bk = `${dest}.bak.${stamp}`;
            try { fs.copyFileSync(dest, bk); restoreBackedUp.push(path.basename(bk)); } catch {}
          }
          fs.writeFileSync(dest, e.data);
          written.push(e.name);
        } catch (err) { failed.push(`${e.name} (${err.message})`); }
      }

      const summary = baseEmbed().setColor(0x2C2F33).setTitle('restore complete').setDescription([
        `**restored:** ${written.length} file${written.length !== 1 ? 's' : ''}`,
        `**pre-restore backups:** ${restoreBackedUp.length} (saved as \`<name>.bak.${stamp}\`)`,
        failed.length ? `**failed:** ${failed.length}\n${failed.map(f => `• ${f}`).join('\n')}` : null,
        meta?.createdAt ? `**source backup created:** ${meta.createdAt}` : null,
        meta?.createdBy?.tag ? `**source backup author:** ${meta.createdBy.tag} \`(${meta.createdBy.id})\`` : null,
        '',
        '⚠️ in-memory state (snipe cache, antinuke event windows, etc.) was NOT replaced. restart the bot to fully reload from the new files.',
      ].filter(Boolean).join('\n'));
      return message.reply({ embeds: [summary], allowedMentions: { parse: [] } });
    } catch (err) {
      return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`restore failed: ${err.message}`)] });
    }
  }

  // .permcheck [user / id / mention]: anyone can check anyone's bot permissions
  if (command === 'permcheck') {
    const arg = args[0];
    let targetId = message.author.id;
    if (arg) {
      const m = message.mentions?.users?.first?.();
      if (m) targetId = m.id;
      else if (/^\d{15,25}$/.test(arg)) targetId = arg;
      else return message.reply({ content: '`.permcheck [@user or user id]`' });
    }
    const wlMgr = isWlManager(targetId);
    const tempOwn = isTempOwner(targetId);
    const whitelisted = isWhitelisted(targetId);
    const lines = [
      `**user:** <@${targetId}> \`(${targetId})\``,
      ``,
      `${wlMgr ? '✅' : '❌'} whitelist manager`,
      `${tempOwn ? '✅' : '❌'} temp owner`,
      `${whitelisted ? '✅' : '❌'} whitelisted`,
    ];
    if (!wlMgr && !tempOwn && !whitelisted) lines.push('', '_no bot-level permissions — this user can only run public commands._');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('permission check').setDescription(lines.join('\n'))],
      allowedMentions: { parse: [] },
    });
  }

  if (command === 'wlmanager') {
    const sub = args[0]?.toLowerCase();
    const mgrs = loadWlManagers();
    if (!canUseAny(message.author.id)) return message.reply({ content: 'only whitelist managers can use this' });
    if (sub === 'list') {
      // only the json file ids no env vars or anything
      const all = [...new Set(mgrs)];
      if (!all.length) return message.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription('no managers set')] });
      // grab usernames so its not a wall of numbers
      const lines = [];
      let n = 1;
      for (const id of all) {
        let name = id;
        try {
          const u = await client.users.fetch(id);
          name = u.username;
        } catch (e) {
          name = 'unknown user';
        }
        lines.push(n + '. ' + name);
        n = n + 1;
      }
      return message.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription(lines.join('\n')).setTimestamp()] });
    }
    if (sub === 'add') {
      // temp owners can use every wl manager command EXCEPT promoting other wl managers
      if (!isRealWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription("temp owners can't add whitelist managers — only real whitelist managers can do that. you can still hand out regular whitelist with `.whitelist add @user`")] });
      const target = message.mentions.users?.first();
      if (!target) return message.reply('mention a user to add');
      if (isBlockedFromWhitelist(target.id)) return message.reply(`**${target.tag}** can't be added to the whitelist managers.`);
      if (mgrs.includes(target.id)) return message.reply(`**${target.tag}** is already a whitelist manager`);
      mgrs.push(target.id); saveWlManagers(mgrs);
      return message.reply({ embeds: [baseEmbed().setTitle('whitelist manager added').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'added by', value: message.author.tag, inline: true }).setTimestamp()] });
    }
    if (sub === 'remove') {
      // temp owners are explicitly NOT allowed to remove wl managers
      if (!isRealWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription("temp owners can't remove whitelist managers — only real whitelist managers can do that")] });
      const target = message.mentions.users?.first();
      if (!target) return message.reply('mention a user to remove');
      if (!mgrs.includes(target.id)) return message.reply(`**${target.tag}** isn't a whitelist manager`);
      saveWlManagers(mgrs.filter(id => id !== target.id));
      return message.reply({ embeds: [baseEmbed().setTitle('whitelist manager removed').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'removed by', value: message.author.tag, inline: true }).setTimestamp()] });
    }
    return;
  }

  // whitelist is handled via the slash dispatcher; the prefix → slash bridge below
  // re routes `.whitelist ...` to `/whitelist ...` automatically.

  // warn system
  if (command === 'warn') {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply('you need **Moderate Members** to warn');
    const target = message.mentions.members.first();
    if (!target) return;
    const reason = args.slice(1).join(' ') || 'no reason given';
    const warnsData = loadWarns();
    if (!warnsData[message.guild.id]) warnsData[message.guild.id] = {};
    if (!warnsData[message.guild.id][target.id]) warnsData[message.guild.id][target.id] = [];
    warnsData[message.guild.id][target.id].push({ reason, mod: message.author.tag, ts: Date.now() });
    saveWarns(warnsData);
    const count = warnsData[message.guild.id][target.id].length;
    return message.reply({ embeds: [warnEmbed('Member Warned')
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: 'user',           value: `${target.user.tag}`, inline: true },
        { name: 'warned by',      value: message.author.tag,   inline: true },
        { name: 'total warnings', value: `${count}`,           inline: true },
        { name: 'reason',         value: reason }
      )] });
  }

  if (command === 'warnings' || command === 'warns') {
    if (!message.guild) return;
    const target = message.mentions.users.first();
    if (!target) return;
    const warnsData = loadWarns();
    const list = warnsData[message.guild.id]?.[target.id] ?? [];
    if (!list.length) return message.reply({ embeds: [infoEmbed('No Warnings')
      .setDescription(`**${target.tag}** has no warnings`)] });
    const lines = list.map((w, i) =>
      `**${i + 1}.** ${w.reason} by **${w.mod}** <t:${Math.floor(w.ts / 1000)}:R `
    ).join('\n');
    return message.reply({ embeds: [warnEmbed(`Warnings ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(lines)
      .addFields({ name: 'total', value: `${list.length}`, inline: true })] });
  }

  if (command === 'clearwarns') {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply('you need **Moderate Members**');
    const target = message.mentions.users.first();
    if (!target) return;
    const warnsData = loadWarns();
    const count = warnsData[message.guild.id]?.[target.id]?.length ?? 0;
    if (!warnsData[message.guild.id]) warnsData[message.guild.id] = {};
    warnsData[message.guild.id][target.id] = [];
    saveWarns(warnsData);
    return message.reply({ embeds: [successEmbed('Warnings Cleared')
      .addFields(
        { name: 'user',    value: target.tag,         inline: true },
        { name: 'cleared', value: `${count}`,         inline: true },
        { name: 'by',      value: message.author.tag, inline: true }
      )] });
  }

  // info commands
  if (command === 'purge' || command === 'c') {
    if (!message.guild) return;
    const amount = parseInt(args[0], 10);
    if (isNaN(amount) || amount < 1 || amount > 100) return message.reply('provide a number between 1 and 100');
    try {
      const deleted = await message.channel.bulkDelete(amount, true);
      const confirm = await message.channel.send(`deleted **${deleted.size}** messages`);
      setTimeout(() => confirm.delete().catch(() => {}), 4000);
    } catch (err) { return message.reply(`couldn't purge ${err.message}`); }
    return;
  }

  // .delwarn
  if (command === 'delwarn') {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply('you need **Moderate Members** to delete warnings');
    const target = message.mentions.users.first();
    const idx    = parseInt(args[1], 10) - 1;
    if (!target)      return;
    if (isNaN(idx))   return message.reply('give the warning number to delete (e.g. `.delwarn @user 2`)');
    const warnsData = loadWarns();
    const list = warnsData[message.guild.id]?.[target.id] ?? [];
    if (!list[idx]) return message.reply(`no warning at index **${idx + 1}**`);
    const removed = list.splice(idx, 1)[0];
    saveWarns(warnsData);
    return message.reply({ embeds: [successEmbed('Warning Removed')
      .addFields(
        { name: 'user',       value: `<@${target.id}> `, inline: true },
        { name: 'removed #',  value: `${idx + 1}`,      inline: true },
        { name: 'reason was', value: removed.reason }
      )] });
  }

  // .roleinfo
  if (command === 'config') {
    if (!message.guild) return;
    const setting = args[0];
    const value   = args.slice(1).join(' ');
    if (!setting || !value) return;
    const cfg = loadConfig();
    if (!cfg.serverConfig) cfg.serverConfig = {};
    if (!cfg.serverConfig[message.guild.id]) cfg.serverConfig[message.guild.id] = {};
    cfg.serverConfig[message.guild.id][setting] = value;
    saveConfig(cfg);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Config Updated')
      .addFields({ name: setting, value: value, inline: true }).setTimestamp()] });
  }

  // .logo
  if (command === 'logo') {
    if (!message.guild) return;
    const action = args[0]?.toLowerCase();
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.logoUrl;
      saveConfig(cfg);
      return message.reply({ content: `embed logo reset to default: ${getLogoUrl()}`, allowedMentions: { repliedUser: false } });
    }
    if (!args[0]) {
      return message.reply({ content: `current logo: ${getLogoUrl()}`, allowedMentions: { repliedUser: false } });
    }
    cfg.logoUrl = args[0];
    saveConfig(cfg);
    return message.reply({ content: `embed logo updated: ${args[0]}`, allowedMentions: { repliedUser: false } });
  }

  // .name
  if (command === 'name') {
    if (!message.guild) return;
    const action = args[0]?.toLowerCase();
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.customName;
      saveConfig(cfg);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Reset')
        .setDescription(`embed name has been reset to **${client.user?.username || 'Bot'}**`).setTimestamp()] });
    }
    const newName = args.join(' ');
    if (!newName) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Current Name')
        .setDescription(`current embed name: **${getBotName()}**`).setTimestamp()] });
    }
    cfg.customName = newName;
    saveConfig(cfg);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Updated')
      .setDescription(`embed name changed to **${newName}**`).setTimestamp()] });
  }

  // .flag
  if (command === 'flag') {
    if (!message.guild) return;
    const groupId = args[0]?.replace(/\D/g, '');
    if (!groupId) return;
    const flagged = loadFlaggedGroups();
    if (flagged.some(g => g.id === groupId)) return message.reply(`group \`${groupId}\` is already flagged`);
    let groupName = null;
    try {
      const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}`);
      if (res.ok) { const data = await res.json(); groupName = data.name || null; }
    } catch {}
    flagged.push({ id: groupId, name: groupName });
    saveFlaggedGroups(flagged);
    const label = groupName ? `**[${groupName}](https://www.roblox.com/communities/${groupId}/about)**` : `group \`${groupId}\``;
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🚩 Group Flagged')
      .setDescription(`${label} has been added to the flagged groups list.\n ID: \`${groupId}\``)
      .setTimestamp()] });
  }

  // .unflag
  if (command === 'unflag') {
    if (!message.guild) return;
    const groupId = args[0]?.replace(/\D/g, '');
    if (!groupId) return;
    const flagged = loadFlaggedGroups();
    const idx = flagged.findIndex(g => g.id === groupId);
    if (idx === -1) return message.reply(`group \`${groupId}\` isn't in the flagged list`);
    const [removed] = flagged.splice(idx, 1);
    saveFlaggedGroups(flagged);
    const label = removed.name ? `**${removed.name}**` : `group \`${groupId}\``;
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('✅ Group Unflagged')
      .setDescription(`${label} has been removed from the flagged groups list.\n ID: \`${groupId}\``)
      .setTimestamp()] });
  }

  // .flagged  list every flagged group (hidden from help)
  if (command === 'flagged') {
    const flagged = loadFlaggedGroups();
    if (!flagged.length) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🚩 Flagged Groups')
        .setDescription('there are no flagged groups right now.').setTimestamp()] });
    }
    const lines = flagged.map((g, i) => {
      const label = g.name
        ? `**[${g.name}](https://www.roblox.com/communities/${g.id}/about)**`
        : `**[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)**`;
      return `${i + 1}. ${label} \`${g.id}\``;
    });
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`🚩 Flagged Groups (${flagged.length})`)
      .setDescription(lines.join('\n').slice(0, 4000)).setTimestamp()] });
  }

  // .role / .r (WL managers only)
  if (command === 'role' || command === 'r') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply({ content: 'only whitelist managers can use `.role`' });

    // support both @mention and raw user ID for the target member
    let targetMember = message.mentions.members?.first();
    if (!targetMember && args[0] && /^\d+$/.test(args[0])) {
      try { targetMember = await message.guild.members.fetch(args[0]); } catch {}
    }
    if (!targetMember) return;

    // collect roles from @mentions AND any raw role ids in args (skip the first arg if it was a user ID)
    const collectedRoles = new Map();
    // add all @mentioned roles
    for (const [id, role] of (message.mentions.roles ?? [])) collectedRoles.set(id, role);
    // scan all args for numeric ids that aren't the user's ID
    const userArgId = targetMember.id;
    for (const arg of args) {
      if (!/^\d+$/.test(arg)) continue;
      if (arg === userArgId) continue;
      if (collectedRoles.has(arg)) continue;
      const found = message.guild.roles.cache.get(arg);
      if (found) collectedRoles.set(arg, found);
      else {
        // try fetching it
        try {
          const fetched = await message.guild.roles.fetch(arg);
          if (fetched) collectedRoles.set(fetched.id, fetched);
        } catch {}
      }
    }

    if (collectedRoles.size === 0) return message.reply('mention at least one role or provide a role ID to add or remove');

    const added = [];
    const removed = [];
    const failed = [];

    for (const [, role] of collectedRoles) {
      try {
        if (targetMember.roles.cache.has(role.id)) {
          await targetMember.roles.remove(role);
          removed.push(`<@&${role.id}> `);
        } else {
          await targetMember.roles.add(role);
          added.push(`<@&${role.id}> `);
        }
      } catch {
        failed.push(role.name);
      }
    }

    const lines = [];
    if (added.length)   lines.push(`➕ Added ${added.join(', ')} to ${targetMember}`);
    if (removed.length) lines.push(`➖ Removed ${removed.join(', ')} from ${targetMember}`);
    if (failed.length)  lines.push(`❌ Failed: ${failed.join(', ')} (missing perms?)`);

    return message.reply({ content: lines.join('\n') || 'nothing changed' });
  }

  // .inrole
  if (command === 'inrole') {
    if (!message.guild) return;

    // support both @role mention and raw role ID
    let role = message.mentions.roles?.first();
    if (!role && args[0] && /^\d+$/.test(args[0])) {
      role = message.guild.roles.cache.get(args[0]);
      if (!role) {
        try { role = await message.guild.roles.fetch(args[0]); } catch {}
      }
    }
    if (!role) return;

    await fetchMembersCached(message.guild);
    const members = message.guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(role.id));

    if (!members.size) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Members with ${role.name}`).setDescription('nobody has this role')] });

    const lines = [...members.values()]
      .sort((a, b) => a.user.username.localeCompare(b.user.username))
      .map((m, i) => `${String(i + 1).padStart(2, '0')} ${m} (${m.user.username})`)
      .join('\n');

    const chunks = [];
    const CHUNK = 4000;
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));

    for (let i = 0; i < chunks.length; i++) {
      const e = baseEmbed().setColor(0x2C2F33)
        .setTitle(i === 0 ? `Members with ${role.name}` : `Members with ${role.name} (cont.)`)
        .setDescription(chunks[i])
        .setFooter({ text: `${members.size} total member${members.size !== 1 ? 's' : ''}`, iconURL: getLogoUrl() });
      await message.reply({ embeds: [e] });
    }
    return;
  }

  // .rid
  if (command === 'rid') {
    const input = args[0];
    if (!input) return;
    if (!/^\d+$/.test(input)) return message.reply('provide a numeric Roblox ID e.g. `.rid 1`');
    try {
      const [user, avatarRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${input}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${input}&size=420x420&format=Png&isCircular=false`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      if (user.errors || !user.name) return message.reply("could not find a Roblox user with that ID");
      const profileUrl = `https://www.roblox.com/users/${input}/profile`;
      const avatarUrl = avatarRes.data?.[0]?.imageUrl;
      const created = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const e = baseEmbed()
        .setColor(0x2C2F33)
        .setTitle(`${user.displayName} (@${user.name})`)
        .setURL(profileUrl)
        .setThumbnail(avatarUrl)
        .setDescription(`[View Profile](${profileUrl})`)
        .addFields(
          { name: '🆔 User ID',   value: `\`${input}\``, inline: true },
          { name: '👤 Username',  value: user.name,       inline: true },
          { name: '📅 Created',   value: created,         inline: true },
        )
        .setTimestamp();
      const joinBtn = await buildJoinButton(input);
      return message.reply({
        embeds: [e],
        components: [new ActionRowBuilder().addComponents(joinBtn)]
      });
    } catch { return message.reply("something went wrong fetching that user, try again"); }
  }

  // .id
  // changes the group id and link saved in config
  if (command === 'id') {
    if (!loadWhitelist().includes(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Not Whitelisted').setDescription("you are not whitelisted for this")] });
    const newGroupId = args[0];
    if (!newGroupId || isNaN(newGroupId)) return;
    try {
      const cfgPath = path.join(__dirname, 'config.json');
      const cfg = loadJSON(cfgPath);
      cfg.groupId = newGroupId;
      cfg.groupLink = `https://www.roblox.com/communities/${newGroupId}/about`;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      return message.reply({ content: `group id updated to \`${newGroupId}\`\nnew link: ${cfg.groupLink}` });
    } catch (err) {
      return message.reply({ content: `something went wrong saving that ${err.message}` });
    }
  }

  // .joinserver <invite link> (WL managers + temp owners)
  // bots can NOT auto-accept invites (discord API restriction). this command instead
  // validates the invite, fetches server info, and replies with a one-click oauth2
  // install link pre-targeted at that server (guild_id + disable_guild_select=true)
  // so the target server's owner just clicks once to add the bot.
  if (command === 'joinserver') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ content: 'only whitelist managers and temp owners can use `.joinserver`' });

    const raw = args[0];
    if (!raw) return message.reply({ content: '`.joinserver <invite link or code>`' });

    // accept full urls (discord.gg/x, discord.com/invite/x, discordapp.com/invite/x) or bare codes
    const inviteCode = (raw.match(/(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)([\w-]+)/i)?.[1] || raw).trim();

    let invite;
    try {
      invite = await client.fetchInvite(inviteCode);
    } catch (e) {
      return message.reply({ content: `that invite is invalid or expired (${e.message})` });
    }

    const targetGuildId = invite.guild?.id;
    if (!targetGuildId) {
      return message.reply({ content: 'that invite is for a Group DM, not a server — bots can\'t join Group DMs' });
    }

    if (client.guilds.cache.has(targetGuildId)) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('already in that server')
        .setDescription(`I'm already in **${invite.guild.name}** (\`${targetGuildId}\`). nothing to do.`)] });
    }

    const clientId = client.user?.id || process.env.CLIENT_ID || '';
    if (!clientId) return message.reply({ content: 'bot client id not ready, try again in a few seconds' });

    // pre-target the oauth dialog at the invite's server so the target server owner just clicks once
    const installUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot+applications.commands&guild_id=${targetGuildId}&disable_guild_select=true`;

    const embed = baseEmbed().setColor(0x2C2F33).setTitle('join server')
      .setDescription([
        `**heads up:** Discord doesn't let bots accept invite links on their own — only a human with **Manage Server** in the target server can authorize me.`,
        ``,
        `**target server:** ${invite.guild.name} \`(${targetGuildId})\``,
        invite.memberCount ? `**members:** ~${invite.memberCount}` : null,
        ``,
        `[**click here to add me to that server**](${installUrl})`,
        `(opens the Discord auth dialog with the server pre-selected — one click and I'm in)`,
      ].filter(Boolean).join('\n'));
    if (invite.guild.icon) embed.setThumbnail(`https://cdn.discordapp.com/icons/${targetGuildId}/${invite.guild.icon}.png`);
    // ping the user who ran the command so they get an actual notification with the install link
    return message.reply({
      content: `<@${message.author.id}>`,
      embeds: [embed],
      allowedMentions: { users: [message.author.id] },
    });
  }

  // .leaveserver (WL managers only)
  if (command === 'leaveserver') {
    if (!canUseAny(message.author.id))
      return message.reply({ content: 'only whitelist managers can use `.leaveserver`' });

    const serverId = args[0];

    if (serverId) {
      const targetGuild = client.guilds.cache.get(serverId);
      if (!targetGuild) return message.reply(`I am not in a server with ID \`${serverId}\``);
      const reply = await message.reply({ content: `leaving **${targetGuild.name}**...` });
      try { await targetGuild.leave(); } catch (e) { return reply.edit(`couldn't leave ${e.message}`); }
      return;
    }

    if (!message.guild) return message.reply('use this in a server or provide a server id as an argument');
    await message.reply({ content: `leaving **${message.guild.name}**...` });
    try { await message.guild.leave(); } catch (e) { return message.reply(`couldn't leave ${e.message}`); }
    return;
  }

  // .servers (WL managers only)
  if (command === 'servers') {
    if (!canUseAny(message.author.id))
      return message.reply({ content: 'only whitelist managers can use `.servers`' });

    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!guilds.length) return message.reply('not in any servers');

    const lines = guilds.map((g, i) => `\`${String(i + 1).padStart(2, '0')}\` **${g.name}** \`${g.id}\` (${g.memberCount} members)`);

    const chunks = [];
    const CHUNK = 4000;
    let current = '';
    for (const line of lines) {
      if ((current + '\n' + line).length > CHUNK) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      const e = baseEmbed().setColor(0x2C2F33)
        .setTitle(i === 0 ? `Servers (${guilds.length})` : `Servers (cont.)`)
        .setDescription(chunks[i]);
      await message.reply({ embeds: [e] });
    }
    return;
  }


  // .rankup
  if (command === 'rankup') {
    if (!message.guild) return;

    // optional "3x" anywhere in args to jump n ranks at once
    // (so .rankup @user 3x works the same as .rankup 3x @user, ppl type both ways)
    let levels = 1;
    const argsCleaned = [];
    for (const a of args) {
      if (a && /^\d+x$/i.test(a)) {
        levels = Math.min(Math.max(parseInt(a, 10), 1), 20);
      } else if (a) {
        argsCleaned.push(a);
      }
    }

    const rankup = loadRankup();
    const guildRanks = rankup[message.guild.id]?.roles || [];
    if (!guildRanks.length)
      return message.reply(`no rank roles set use \`${prefix}setrankroles @role1 @role2 ...\` to configure the rank ladder`);

    const rawTokens = argsCleaned;
    if (!rawTokens.length) return;

    await fetchMembersCached(message.guild);

    // collect unique members from mentions + any bare username/ID tokens
    const mentionedMembers = [...(message.mentions.members?.values() ?? [])];
    const seenIds = new Set(mentionedMembers.map(m => m.id));
    const allTargets = [...mentionedMembers];

    for (const token of rawTokens) {
      const clean = token.replace(/[<@!>]/g, '').trim();
      if (!clean || !(/\w/.test(clean)) || seenIds.has(clean)) continue;
      if (/^\d{17,19}$/.test(clean)) {
        const m = message.guild.members.cache.get(clean);
        if (m && !seenIds.has(m.id)) { allTargets.push(m); seenIds.add(m.id); }
        continue;
      }
      const found = message.guild.members.cache.find(m =>
        m.user.username.toLowerCase() === clean.toLowerCase() ||
        m.displayName.toLowerCase() === clean.toLowerCase()
      );
      if (found && !seenIds.has(found.id)) { allTargets.push(found); seenIds.add(found.id); }
    }

    if (!allTargets.length) return message.reply("couldn't find any users to rank up");

    await message.guild.roles.fetch();

    const status = await message.reply({ content: `ranking up **${allTargets.length}** user${allTargets.length !== 1 ? 's' : ''}...` });

    let completed = 0, skipped = 0;
    const rolesAwarded = [];
    const skipReasons = [];

    for (const member of allTargets) {
      try {
        await member.fetch();
        let currentIdx = -1;
        for (let i = guildRanks.length - 1; i >= 0; i--) {
          if (member.roles.cache.has(guildRanks[i])) { currentIdx = i; break; }
        }
        const nextIdx = currentIdx + levels;
        if (nextIdx >= guildRanks.length) { skipped++; skipReasons.push(`${member.displayName} already at highest rank`); continue; }
        const newRoleId = guildRanks[nextIdx];
        const newRole = message.guild.roles.cache.get(newRoleId) ?? await message.guild.roles.fetch(newRoleId).catch(() => null);
        if (!newRole) { skipped++; skipReasons.push(`${member.displayName} target role not found`); continue; }
        // remove old rank roles, add new one
        for (const rId of guildRanks) {
          if (rId !== newRoleId && member.roles.cache.has(rId))
            await member.roles.remove(rId).catch(() => {});
        }
        await member.roles.add(newRoleId);
        rolesAwarded.push({ member, roleName: newRole.name });
        completed++;
      } catch (err) { skipped++; skipReasons.push(`${member.displayName} ${err.message}`); }
    }

    const total = completed + skipped;
    const resultLines = [
      'RESULT COUNT',
      ' ',
      `COMPLETED ${completed}`,
      `SKIPPED ${skipped}`,
      `TOTAL ${total}`,
    ].join('\n');

    const summaryEmbed = baseEmbed()
      .setTitle('Rankup Complete')
      .setColor(0x2C2F33)
      .setDescription('```\n' + resultLines + '\n```')
      .setTimestamp();

    const embeds = [summaryEmbed];

    if (rolesAwarded.length) {
      const awardLines = rolesAwarded.map(({ member, roleName }) => `${member} ${roleName}`).join('\n');
      embeds.push(baseEmbed().setTitle('ROLES AWARDED').setColor(0x2C2F33).setDescription(awardLines).setTimestamp());
    }
    if (skipReasons.length) {
      embeds.push(baseEmbed().setTitle('SKIPPED').setColor(0x555555).setDescription(skipReasons.join('\n')).setTimestamp());
    }

    return status.edit({ content: '', embeds });
  }

  // .setrankroles
  if (command === 'setrankroles') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !canUseAny(message.author.id))
      return message.reply({ content: 'you need to be whitelisted to configure rank roles' });

    const sub = args[0]?.toLowerCase();

    if (sub === 'clear') {
      const rankup = loadRankup();
      delete rankup[message.guild.id];
      saveRankup(rankup);
      return message.reply({ content: 'rank roles cleared for this server' });
    }

    if (sub === 'list') {
      const guildRanks = loadRankup()[message.guild.id]?.roles || [];
      if (!guildRanks.length) return message.reply(`no rank roles set use \`${prefix}setrankroles @role1 @role2 ...\` to configure`);
      const lines = guildRanks.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder').setDescription(lines).setTimestamp()] });
    }

    const collectedIds = [];
    const seen = new Set();
    // parse role mentions in the exact order they appear in the message text
    for (const match of message.content.matchAll(/<@&(\d+)>/g)) {
      const id = match[1];
      if (!seen.has(id) && message.guild.roles.cache.has(id)) { collectedIds.push(id); seen.add(id); }
    }
    // also handle any bare numeric role ids in args
    for (const arg of args) {
      if (!/^\d+$/.test(arg) || seen.has(arg)) continue;
      const r = message.guild.roles.cache.get(arg);
      if (r) { collectedIds.push(r.id); seen.add(r.id); }
    }

    if (!collectedIds.length)
      return;

    const rankup = loadRankup();
    if (!rankup[message.guild.id]) rankup[message.guild.id] = {};
    rankup[message.guild.id].roles = collectedIds;
    saveRankup(rankup);

    const lines = collectedIds.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder Set')
      .setDescription(lines)
      .setFooter({ text: `${collectedIds.length} rank${collectedIds.length !== 1 ? 's' : ''} configured • lowest → highest`, iconURL: getLogoUrl() })
      .setTimestamp()] });
  }

  // .fileroles
  if (command === 'fileroles') {
    if (!message.guild) return;
    const guildRanks = loadRankup()[message.guild.id]?.roles || [];
    if (!guildRanks.length)
      return message.reply(`no rank roles configured use \`${prefix}setrankroles @lowest @next @highest\` first`);
    const rows = guildRanks.map((id, i) => {
      const role = message.guild.roles.cache.get(id);
      return { rank: i + 1, roleId: id, roleName: role?.name ?? 'unknown' };
    });
    const json = JSON.stringify({ guildId: message.guild.id, guildName: message.guild.name, updatedAt: new Date().toISOString(), rankLadder: rows }, null, 2);
    const buf = Buffer.from(json, 'utf8');
    const attachment = new AttachmentBuilder(buf, { name: `rank ladder ${message.guild.id}.json` });
    const lines = rows.map(r => `**${r.rank}.** <@&${r.roleId}> \`${r.roleName}\``).join('\n');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Rank Ladder ${message.guild.name}`)
        .setDescription(lines)
        .setFooter({ text: `${rows.length} rank${rows.length !== 1 ? 's' : ''} • lowest → highest`, iconURL: getLogoUrl() })
        .setTimestamp()],
      files: [attachment]
    });
  }



  // .rfile
  if (command === 'rfile') {
    if (!canUseAny(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `.rfile`')] });
    const vData   = loadVerify();
    const entries = Object.entries(vData.verified || {});
    if (!entries.length) return message.reply({ content: 'no registered members yet use `/pregister` to add members' });
    const lines = entries.map(([discordId, { robloxName }]) => `<@${discordId}> \`${robloxName}\``);
    const PAGE_SIZE = 20;
    const pages = [];
    for (let i = 0; i < lines.length; i += PAGE_SIZE) pages.push(lines.slice(i, i + PAGE_SIZE).join('\n'));
    // build export JSON
    const exportObj = {};
    for (const [discordId, info] of entries) {
      exportObj[discordId] = { discordId, robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt };
    }
    const exportBuf = Buffer.from(JSON.stringify(exportObj, null, 2), 'utf8');
    const exportAttachment = new AttachmentBuilder(exportBuf, { name: 'registered members.json' });
    let page = 0;
    const makeEmbed = () => baseEmbed().setColor(0x2C2F33)
      .setTitle(`Registered Members (${entries.length})`)
      .setDescription(pages[page])
      .setFooter({ text: `page ${page + 1} of ${pages.length} • ${entries.length} registered member${entries.length !== 1 ? 's' : ''}`, iconURL: getLogoUrl() })
      .setTimestamp();
    const makeRow = () => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rfile prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('rfile next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1)
    );
    const msg = await message.reply({ embeds: [makeEmbed()], files: [exportAttachment], components: pages.length > 1 ? [makeRow()] : [] });
    if (pages.length === 1) return;
    const collector = msg.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async btn => {
      if (btn.user.id !== message.author.id) return btn.reply({ content: 'you did not run this command', ephemeral: true });
      if (btn.customId === 'rfile next') page = Math.min(page + 1, pages.length - 1);
      else page = Math.max(page - 1, 0);
      await btn.update({ embeds: [makeEmbed()], components: [makeRow()] });
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    return;
  }

  // .lvfile
  if (command === 'lvfile') {
    if (!canUseAny(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `.lvfile`')] });
    if (!fs.existsSync(LINKED_VERIFIED_FILE)) {
      return message.reply({ embeds: [errorEmbed('file not found').setDescription('`linked verified.json` does not exist yet no one has verified')] });
    }
    const data = fs.readFileSync(LINKED_VERIFIED_FILE);
    const count = Object.keys(JSON.parse(data)).length;
    const attachment = new AttachmentBuilder(data, { name: 'linked verified.json' });
    return message.reply({
      embeds: [successEmbed('Linked & Verified Export')
        .setDescription(`**${count}** linked account${count !== 1 ? 's' : ''} in file`)
        .setTimestamp()],
      files: [attachment]
    });
  }

  // .import
  // .import (attach a registered members.json or linked verified.json)
  // bulk imports registered users from a rfile/lvfile JSON export. WL managers only.
  if (command === 'import') {
    if (!canUseAny(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `.import`')] });
    const attachment = message.attachments.first();
    if (!attachment || !attachment.name.endsWith('.json')) return;
    const status = await message.reply({ content: 'importing registered users...' });
    try {
      const res = await fetch(attachment.url);
      const raw = await res.json();
      if (typeof raw !== 'object' || Array.isArray(raw)) return status.edit({ embeds: [errorEmbed('invalid file').setDescription('expected a JSON object with Discord IDs as keys')] });
      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};
      let added = 0, updated = 0, skippedCount = 0;
      for (const [discordId, info] of Object.entries(raw)) {
        if (!info?.robloxId || !info?.robloxName) { skippedCount++; continue; }
        const rid = String(info.robloxId);
        const existingDiscordForRoblox = vData.robloxToDiscord[rid];
        if (existingDiscordForRoblox && existingDiscordForRoblox !== discordId) { skippedCount++; continue; }
        const prevEntry = vData.verified[discordId];
        if (prevEntry && String(prevEntry.robloxId) !== rid) delete vData.robloxToDiscord[String(prevEntry.robloxId)];
        const isNew = !vData.verified[discordId];
        vData.verified[discordId] = { robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt ?? Date.now() };
        vData.robloxToDiscord[rid] = discordId;
        if (isNew) added++; else updated++;
      }
      saveVerify(vData);
      saveLinkedVerified(vData);
      const total = Object.keys(vData.verified).length;
      return status.edit({ embeds: [successEmbed('Import Complete').addFields(
        { name: 'Added', value: String(added), inline: true },
        { name: 'Updated', value: String(updated), inline: true },
        { name: 'Skipped', value: String(skippedCount), inline: true },
        { name: 'Total Registered', value: String(total), inline: false }
      ).setTimestamp()] });
    } catch (err) { return status.edit({ embeds: [errorEmbed('import failed').setDescription(err.message)] }); }
  }

  // .register
  // .register robloxusername
  // self service: links the calling discord user to a roblox account.
  if (command === 'register') {
    const robloxInput = args[0]?.trim();
    if (!robloxInput) return;

    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false })
      })).json();
      const robloxUser = res.data?.[0];
      if (!robloxUser)
        return message.reply({ content: `could not find a Roblox user named \`${robloxInput}\`` });

      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

      const existingDiscordId = vData.robloxToDiscord[String(robloxUser.id)];
      if (existingDiscordId && existingDiscordId !== message.author.id) {
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
          .setDescription(`\`${robloxUser.name}\` is already registered to a different account contact a staff member`)] });
      }

      const prevEntry = vData.verified[message.author.id];
      if (prevEntry && String(prevEntry.robloxId) !== String(robloxUser.id)) {
        delete vData.robloxToDiscord[String(prevEntry.robloxId)];
      }

      vData.verified[message.author.id]               = { robloxId: robloxUser.id, robloxName: robloxUser.name, verifiedAt: Date.now() };
      vData.robloxToDiscord[String(robloxUser.id)]     = message.author.id;
      saveVerify(vData);
      saveLinkedVerified(vData);

      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json();
      const avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;

      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Registration Successful')
        .setThumbnail(avatarUrl ?? getLogoUrl())
        .setDescription(`You are now registered as **${robloxUser.name}**`)
        .addFields(
          { name: 'Discord', value: `<@${message.author.id}> `, inline: true },
          { name: 'Roblox',  value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true }
        ).setTimestamp()] });
    } catch (err) { return message.reply(`register failed ${err.message}`); }
  }

  // .pregister
  // .pregister robloxusername @user (or userid)
  // registers another discord user to a roblox account. WL managers only.
  if (command === 'pregister') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id)) return message.reply({ content: 'only whitelist managers can use `.pregister`' });
    const robloxInput = args[0]?.trim();
    const discordRaw  = args[1]?.trim();
    if (!robloxInput || !discordRaw) return;

    // resolve discord user support mention or raw id
    const discordId = discordRaw.replace(/[<@!>]/g, '');
    if (!/^\d{17,20}$/.test(discordId)) return message.reply('provide a valid Discord user mention or ID as the second argument');
    let discordUser;
    try { discordUser = await client.users.fetch(discordId); } catch { return message.reply("could not find that Discord user"); }

    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false })
      })).json();
      const robloxUser = res.data?.[0];
      if (!robloxUser) return message.reply({ content: `could not find a Roblox user named \`${robloxInput}\`` });

      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

      const existingDiscordId = vData.robloxToDiscord[String(robloxUser.id)];
      if (existingDiscordId && existingDiscordId !== discordId) {
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
          .setDescription(`\`${robloxUser.name}\` is already registered to a different Discord account`)] });
      }

      const prevEntry = vData.verified[discordId];
      if (prevEntry && String(prevEntry.robloxId) !== String(robloxUser.id)) {
        delete vData.robloxToDiscord[String(prevEntry.robloxId)];
      }

      vData.verified[discordId]                    = { robloxId: robloxUser.id, robloxName: robloxUser.name, verifiedAt: Date.now() };
      vData.robloxToDiscord[String(robloxUser.id)] = discordId;
      saveVerify(vData);
      saveLinkedVerified(vData);

      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json();
      const avatarUrl  = avatarData.data?.[0]?.imageUrl ?? null;

      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Registration Successful')
        .setThumbnail(avatarUrl ?? getLogoUrl())
        .setDescription(`<@${discordId}> is now registered as **${robloxUser.name}**`)
        .addFields(
          { name: 'Discord',       value: `<@${discordId}> `, inline: true },
          { name: 'Roblox',        value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
          { name: 'registered by', value: `<@${message.author.id}> `, inline: true }
        ).setTimestamp()] });
    } catch (err) { return message.reply(`pregister failed ${err.message}`); }
  }

  // .verify
  // .verify @user gives the configured verify role to a user
  // .verify role set @role sets which role is given on verify
  // .verify role remove clears the verify role
  if (command === 'verify') {
    if (!message.guild) return;
    if (!hasTicketAccess(message.author.id, message.member)) return message.reply({ content: 'only whitelist managers, temp owners, or ticket support roles can use `.verify`' });

    const sub = args[0]?.toLowerCase();

    // .verify role set / remove
    if (sub === 'role') {
      const action = args[1]?.toLowerCase();
      if (action === 'set') {
        const role = message.mentions.roles.first();
        if (!role) return message.reply('mention a role e.g. `.verify role set @Verified`');
        const cfg = loadConfig(); cfg.verifyRoleId = role.id; saveConfig(cfg);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verify role set')
          .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'set by', value: message.author.tag, inline: true }).setTimestamp()] });
      }
      if (action === 'remove') {
        const cfg = loadConfig(); delete cfg.verifyRoleId; saveConfig(cfg);
        return message.reply({ content: 'verify role removed' });
      }
      return;
    }

    // .verify @user
    const cfg = loadConfig();
    if (!cfg.verifyRoleId) return message.reply(`no verify role set use \`${prefix}verify role set @role\` first`);
    let target = message.mentions.members?.first();
    if (!target && args[0] && /^\d{17,20}$/.test(args[0])) {
      try { target = await message.guild.members.fetch(args[0]); } catch {}
    }
    if (!target) return;
    const role = message.guild.roles.cache.get(cfg.verifyRoleId);
    if (!role) return message.reply("couldn't find the configured verify role it may have been deleted");
    if (target.roles.cache.has(role.id)) return message.reply({ content: `${target} already has ${role}` });
    try {
      await target.roles.add(role);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verified')
        .addFields(
          { name: 'user',        value: `${target}`, inline: true },
          { name: 'role',        value: `${role}`, inline: true },
          { name: 'verified by', value: message.author.tag, inline: true }
        ).setTimestamp()] });
    } catch { return message.reply("couldn't add the role check my permissions"); }
  }

  // .registeredlist
  if (command === 'registeredlist') {
    const vData   = loadVerify();
    const entries = Object.entries(vData.verified || {});

    if (!entries.length) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Verified Accounts')
        .setDescription('no one has linked their Roblox account yet')] });
    }

    // build one line per user: discord mention → roblox username (linked profile)
    const lines = [];
    for (const [discordId, { robloxName, robloxId }] of entries) {
      lines.push(`<@${discordId}> → [\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)`);
    }

    // split into pages of 20 so embeds don't hit the 4096 char description limit
    const PAGE_SIZE = 20;
    const pages     = [];
    for (let i = 0; i < lines.length; i += PAGE_SIZE) {
      pages.push(lines.slice(i, i + PAGE_SIZE));
    }

    const totalPages = pages.length;
    const buildPage  = (idx) => baseEmbed().setColor(0x2C2F33)
      .setTitle(`Verified Accounts [${entries.length}]`)
      .setDescription(pages[idx].join('\n'))
      .setFooter({ text: `Page ${idx + 1} of ${totalPages} • ${getBotName()}`, iconURL: getLogoUrl() });

    if (totalPages === 1) {
      return message.reply({ embeds: [buildPage(0)] });
    }

    // multi page with buttons
    const buildRow = (idx) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rlist ${idx - 1}`).setLabel('‹ Back').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
      new ButtonBuilder().setCustomId(`rlist ${idx + 1}`).setLabel('Next ›').setStyle(ButtonStyle.Secondary).setDisabled(idx === totalPages - 1)
    );

    const reply = await message.reply({ embeds: [buildPage(0)], components: [buildRow(0)] });

    const collector = reply.createMessageComponentCollector({ time: 5 * 60 * 1000 });
    collector.on('collect', async i => {
      if (i.user.id !== message.author.id) return i.reply({ content: 'only the user who ran this command can navigate', ephemeral: true });
      const page = parseInt(i.customId.split(' ')[1]);
      await i.update({ embeds: [buildPage(page)], components: [buildRow(page)] });
    });
    collector.on('end', () => reply.edit({ components: [] }).catch(() => {}));
    return;
  }

  if (command === 'linked') {
    const vData = loadVerify();
    const mention = message.mentions.users.first();

    if (mention) {
      const linked = vData.verified?.[mention.id];
      if (!linked) return message.reply({ content: `${mention} has no linked Roblox account` });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Linked Account')
        .addFields(
          { name: 'Discord', value: `${mention}`, inline: true },
          { name: 'Roblox',  value: `[\`${linked.robloxName}\`](https://www.roblox.com/users/${linked.robloxId}/profile)`, inline: true }
        )
        .setTimestamp(new Date(linked.verifiedAt))] });
    }

    // lookup by roblox username
    const inputName = args[0];
    if (!inputName) return;

    let robloxUser;
    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [inputName], excludeBannedUsers: false })
      })).json();
      robloxUser = res.data?.[0];
    } catch {}

    if (!robloxUser) return message.reply({ content: `couldn't find Roblox user \`${inputName}\`` });

    const discordId = vData.robloxToDiscord?.[String(robloxUser.id)];
    if (!discordId) return message.reply({ content: `\`${robloxUser.name}\` has no linked Discord account` });

    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
      .setTitle('Linked Account')
      .addFields(
        { name: 'Roblox',  value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
        { name: 'Discord', value: `<@${discordId}> `, inline: true }
      )] });
  }

  // .attend
  if (command === 'setrollcallchannel') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !canUseAny(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const ch = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    if (!ch || !ch.isTextBased?.()) return message.reply(`provide a text channel like \`${prefix}setrollcallchannel #channel\``);
    const qData = loadQueue();
    if (!qData[message.guild.id]) qData[message.guild.id] = {};
    qData[message.guild.id].rollCallChannelId = ch.id;
    saveQueue(qData);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rollcall Channel Set').setDescription(`when you run \`${prefix}endrollcall\` the full list of who reacted (with clickable Discord + Roblox names) will get posted in ${ch}`).setTimestamp()] });
  }

  // .lb - raid leaderboard. shows who has been in the most rollcalls/raids
  // (uses the same raid stats that .endrollcall already updates so the count = how many rollcalls they were in)
  // paginated 10 per page with transparent < / > buttons (secondary style).
  // .rmanager @role - flips a discord role's permission to use /role and .role.
  // wl manager only. if the role's already allowed it gets removed. basically a
  // shortcut for /setroleperms add+remove since typing that out gets old fast
  if (command === 'rmanager') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only wl managers can mess with the role manager list')] });
    const role = message.mentions.roles.first();
    if (!role) return message.reply('mention a role bro. like `.rmanager @raidLead`');
    const perms = loadRolePerms();
    let action;
    let next;
    if (perms.includes(role.id)) {
      next = perms.filter(id => id !== role.id);
      action = 'removed';
    } else {
      next = [...perms, role.id];
      action = 'added';
    }
    saveRolePerms(next);
    // sync existing open tickets so the role gains/loses view right now
    let syncLine = '';
    try {
      const res = action === 'added'
        ? await grantRoleToOpenTickets(message.guild, role.id)
        : await revokeRoleFromOpenTickets(message.guild, role.id);
      syncLine = `\nsynced ${res.updated} open ticket${res.updated === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}`;
    } catch {}
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Role Manager Updated')
      .setDescription(`${action} ${role} — anyone with this role ${action === 'added' ? 'can now use' : 'can no longer use'} \`/role\` and \`.role\`${syncLine}`)
      .setTimestamp()] });
  }

  // .autorole @role - hand a role to anyone who joins from now on.
  // .autorole off / .autorole remove turns it off. .autorole status / no args shows current.
  // wl manager only since this hits every new member.
  if (command === 'autorole') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply('only whitelist managers can change autorole');
    const sub = (args[0] || '').toLowerCase();
    const data = loadAutorole();
    if (!sub || sub === 'status') {
      const id = data[message.guild.id]?.roleId;
      if (!id) return message.reply('no autorole set. do `.autorole @role` to pick one.');
      return message.reply({ content: `autorole is set to <@&${id}>`, allowedMentions: { roles: [] } });
    }
    if (sub === 'off' || sub === 'remove' || sub === 'disable' || sub === 'clear') {
      if (!data[message.guild.id]?.roleId) return message.reply('autorole was already off');
      delete data[message.guild.id];
      saveAutorole(data);
      return message.reply('autorole turned off — new joiners won\'t auto get a role anymore');
    }
    const role = message.mentions.roles.first();
    if (!role) return message.reply('mention a role like `.autorole @member` (or do `.autorole off`)');
    const me = message.guild.members.me;
    if (role.managed) return message.reply("that role is managed by an integration so i can't hand it out");
    if (me && role.position >= me.roles.highest.position) return message.reply(`move my role above ${role} so i can hand it out`);
    data[message.guild.id] = { roleId: role.id };
    saveAutorole(data);
    return message.reply({ content: `autorole set — anyone who joins now gets ${role} automatically`, allowedMentions: { roles: [] } });
  }

  // .rom @role / .rom add @role / .rom remove @role / .rom list
  // shorthand alias of .rmanager. registers a discord role as a "role of management"
  // so members with it can use /role + .role. without a registered rom role,
  // /role and .role are blocked. wl manager only.
  if (command === 'rom') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only wl managers can change the rom list')] });
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'list' || (!sub && !message.mentions.roles.first())) {
      const perms = loadRolePerms();
      if (!perms.length) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('rom roles').setDescription('no rom roles registered yet. do `.rom @role` to add one.')] });
      const lines = perms.map((id, i) => `${i + 1}. <@&${id}>`).join('\n');
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('rom roles').setDescription(lines).setFooter({ text: 'anyone with one of these roles can use /role and see tickets' })] });
    }
    const role = message.mentions.roles.first();
    if (!role) return message.reply('mention a role like `.rom @raidLead` (or `.rom list` to see them all)');
    const perms = loadRolePerms();
    let action, next;
    if (sub === 'remove' || sub === 'rm' || sub === 'del') {
      if (!perms.includes(role.id)) return message.reply(`${role} isn't a rom role`);
      next = perms.filter(id => id !== role.id);
      action = 'removed';
    } else if (sub === 'add' || !sub) {
      if (perms.includes(role.id)) return message.reply(`${role} is already a rom role`);
      next = [...perms, role.id];
      action = 'added';
    } else {
      return message.reply('use `.rom @role`, `.rom add @role`, `.rom remove @role`, or `.rom list`');
    }
    saveRolePerms(next);
    let syncLine = '';
    try {
      const res = action === 'added'
        ? await grantRoleToOpenTickets(message.guild, role.id)
        : await revokeRoleFromOpenTickets(message.guild, role.id);
      syncLine = `\nsynced ${res.updated} open ticket${res.updated === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}`;
    } catch {}
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('rom updated')
      .setDescription(`${action} ${role} — anyone with this role ${action === 'added' ? 'can now use' : 'can no longer use'} \`/role\`, \`.role\`, and see tickets${syncLine}`)
      .setTimestamp()] });
  }

  // .setupraidpoints - drops the raid point submission embed in the current
  // channel. has a button that opens the modal. wl managers only
  if (command === 'setupraidpoints') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only wl managers can set this up')] });
    const e = baseEmbed().setColor(0x5865F2).setTitle('Raid Point Submission')
      .setDescription('did you just hop in a raid? tap the button below to submit you\'re raid point. someone will look it over and either approve or deny it.')
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('getraidpoint').setLabel('Get Raid Point').setStyle(ButtonStyle.Primary)
    );
    return message.channel.send({ embeds: [e], components: [row] });
  }

  // .setraidreview #channel - sets the channel where raid point submissions
  // get sent for staff to approve / deny
  if (command === 'setraidreview') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only wl managers can set the review channel')] });
    const ch = message.mentions.channels.first();
    if (!ch?.isTextBased?.()) return message.reply('mention a text channel like `.setraidreview #raid-reviews`');
    const data = loadRaidReview();
    data[message.guild.id] = ch.id;
    saveRaidReview(data);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Raid Review Channel Set')
      .setDescription(`raid point submissions will now drop into ${ch}. staff can approve or deny em from there`)
      .setTimestamp()] });
  }

  // .lb - raid point leaderboard. now uses raid POINTS instead of raid count.
  // toggle weekly / all time with the buttons. weekly resets every monday utc
  if (command === 'lb') {
    if (!message.guild) return;
    const mode = (args[0] || '').toLowerCase() === 'weekly' ? 'weekly' : 'all';
    const e = await buildRaidLbEmbed(message.guild.id, mode, 0, message.client);
    const comps = buildRaidLbComponents(mode, 0, e.totalPages, message.author.id);
    return message.reply({ embeds: [e.embed], components: comps });
  }

  // .lbreset - wipe the raid leaderboard for this server.
  // wl managers + temp owners can run it (anyone iswlmanager() returns true for).
  if (command === 'lbreset') {
    if (!message.guild) return;
    if (!canUseAny(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can wipe the raid leaderboard')] });
    const all = loadRaidStats();
    const had = Object.keys(all[message.guild.id] || {}).length;
    delete all[message.guild.id];
    saveRaidStats(all);
    return message.reply({ embeds: [successEmbed('Raid Leaderboard Wiped')
      .setDescription(`cleared **${had}** member${had !== 1 ? 's' : ''} from the raid leaderboard for this server`)
      .addFields({ name: 'wiped by', value: message.author.tag })] });
  }

  // .rollcall
  if (command === 'rollcall') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !canUseAny(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const rcEmbed = new EmbedBuilder().setColor(0x2C2F33)
      .setTitle('RAID QUEUE')
      .setDescription('REACT TO THIS MESSAGE IF YOU ARE IN GAME/ IN QUEUE.');
    const rcMsg = await message.channel.send({ embeds: [rcEmbed] });
    await rcMsg.react('✅');
    const qData = loadQueue();
    if (!qData[message.guild.id]) qData[message.guild.id] = {};
    qData[message.guild.id].rollCall = { messageId: rcMsg.id, channelId: rcMsg.channelId };
    saveQueue(qData);
    return;
  }

  // .endrollcall
  if (command === 'endrollcall') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !canUseAny(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const qData = loadQueue();
    const rc = qData[message.guild.id]?.rollCall;
    if (!rc) return message.reply(`no active roll call start one with \`${prefix}rollcall\` first`);
    const status = await message.reply({ content: 'closing roll call and logging attendance...' });
    try {
      const rcChannel = message.guild.channels.cache.get(rc.channelId);
      if (!rcChannel) return status.edit({ content: "couldn't find the roll call channel" });
      const rcMsg = await rcChannel.messages.fetch(rc.messageId);
      const reaction = rcMsg.reactions.cache.get('✅');
      let reactors = [];
      if (reaction) { await reaction.users.fetch(); reactors = [...reaction.users.cache.values()].filter(u => !u.bot); }
      if (!reactors.length) {
        delete qData[message.guild.id].rollCall;
        saveQueue(qData);
        return status.edit({ content: 'roll call closed no reactions found' });
      }
      const vData = loadVerify();
      const queueChannelId = qData[message.guild.id]?.channelId;
      const queueChannel = queueChannelId ? message.guild.channels.cache.get(queueChannelId) : null;
      // the new rollcall summary channel - set with .setrollcallchannel
      const rollCallChannelId = qData[message.guild.id]?.rollCallChannelId;
      const rollCallChannel = rollCallChannelId ? message.guild.channels.cache.get(rollCallChannelId) : null;
      let logged = 0; const skipped = []; const loggedEntries = [];
      // for the summary embed - keep both names so we can build clickable links
      const summaryRows = [];
      for (const user of reactors) {
        const userVerify = vData.verified?.[user.id];
        if (!userVerify) { skipped.push(user); continue; }
        let avatarUrl = null;
        try {
          const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userVerify.robloxId}&size=420x420&format=Png&isCircular=false`)).json();
          avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
        } catch {}
        const rcAttendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
          .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
          .addFields({ name: 'Discord', value: `<@${user.id}> `, inline: false }, { name: 'Roblox', value: `\`${userVerify.robloxName}\``, inline: false })
          .setTimestamp().setFooter({ text: `roll call • ${getBotName()}`, iconURL: getLogoUrl() });
        if (avatarUrl) rcAttendEmbed.setThumbnail(avatarUrl);
        if (queueChannel) { await queueChannel.send({ embeds: [rcAttendEmbed] }); addRaidStat(message.guild.id, user.id); }
        else if (rollCallChannel) { addRaidStat(message.guild.id, user.id); } // still credit the raid stat even if no queue channel
        loggedEntries.push({ discordId: user.id, robloxName: userVerify.robloxName });
        summaryRows.push({ discordId: user.id, discordName: user.username, robloxId: userVerify.robloxId, robloxName: userVerify.robloxName });
        logged++;
        await new Promise(r => setTimeout(r, 300));
      }
      // post the big summary embed in the rollcall channel - every1 in the rollcall, with clickable names
      if (rollCallChannel && summaryRows.length) {
        const lines = summaryRows.map((r, i) =>
          `**${i + 1}.** [${r.discordName}](https://discord.com/users/${r.discordId}) — Roblox: [${r.robloxName}](https://www.roblox.com/users/${r.robloxId}/profile)`
        );
        const skippedLine = skipped.length ? `\n\n*${skipped.length} skipped (not registered)*` : '';
        const summaryEmbed = baseEmbed().setColor(0x2C2F33)
          .setTitle('Rollcall — Who Was In')
          .setDescription(lines.join('\n') + skippedLine)
          .setFooter({ text: `${summaryRows.length} member${summaryRows.length !== 1 ? 's' : ''} • closed by ${message.author.username} • ${getBotName()}`, iconURL: getLogoUrl() })
          .setTimestamp();
        try { await rollCallChannel.send({ embeds: [summaryEmbed] }); } catch (e) { console.error('rollcall summary post failed:', e.message); }
      }
      appendAtLog(message.guild.id, { ts: Date.now(), by: message.author.id, channelId: rc.channelId, queueChannelId: queueChannel?.id || null, logged: loggedEntries, skipped: skipped.map(u => u.id) });
      delete qData[message.guild.id].rollCall;
      saveQueue(qData);
      const skipNote = skipped.length ? `\n${skipped.length} skipped (not registered)` : '';
      const summaryNote = rollCallChannel ? `\nsummary posted to ${rollCallChannel}` : (rollCallChannelId ? '\n(rollcall channel set but couldn\'t find it, check perms)' : `\nset a summary channel with \`${prefix}setrollcallchannel #channel\``);
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Roll Call Closed').setDescription(`logged **${logged}** member${logged !== 1 ? 's' : ''}${queueChannel ? ` to ${queueChannel}` : ''}${skipNote}${summaryNote}`).setTimestamp()] });
    } catch (err) {
      return status.edit({ content: `failed to close roll call ${err.message}` });
    }
  }

  // .atlog
  // show recent rollcall attendance logs. usage:
  // .atlog → list the last 10 sessions
  // .atlog <n → show full details of session #n from the list
  // .atlog clear → wipe all logs for this guild (wl manager only)
  if (command === 'atlog') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !canUseAny(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const all = loadAtLog();
    const sessions = all[message.guild.id] || [];
    // helper: render a discord id as "<@id (`robloxname`)" if they're registered via .register
    const _vForLog = loadVerify();
    const renderUser = (id) => {
      const r = _vForLog?.verified?.[id]?.robloxName;
      return r ? `<@${id}> (\`${r}\`)` : `<@${id}> `;
    };

    if (args[0]?.toLowerCase() === 'clear') {
      if (!canUseAny(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can clear attendance logs')] });
      delete all[message.guild.id];
      saveAtLog(all);
      return message.reply('logs cleared — all rollcall logs for this server have been wiped');
    }

    if (!sessions.length) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Attendance Log').setDescription('no rollcall sessions logged yet run `.endrollcall` to record one')] });

    // newest first
    const recent = [...sessions].reverse();

    // detail view
    if (args[0] && /^\d+$/.test(args[0])) {
      const idx = parseInt(args[0], 10) - 1;
      const s = recent[idx];
      if (!s) return message.reply({ embeds: [errorEmbed('not found').setDescription(`no session #${idx + 1} there are only **${recent.length}** logged`)] });
      const lines = s.logged.length
        ? s.logged.map(e => `• <@${e.discordId}> \`${e.robloxName}\``).join('\n')
        : ' no registered users logged ';
      const skipLine = s.skipped?.length ? `\n\n**Skipped (${s.skipped.length}):** ${s.skipped.map(id => renderUser(id)).join(', ')}` : '';
      const embed = baseEmbed().setColor(0x2C2F33)
        .setTitle(`Attendance Log Session #${idx + 1}`)
        .setDescription(`<t:${Math.floor(s.ts / 1000)}:F (<t:${Math.floor(s.ts / 1000)}:R )\nclosed by ${renderUser(s.by)}${s.queueChannelId ? ` • posted to <#${s.queueChannelId}> ` : ''}\n\n**Logged (${s.logged.length}):**\n${lines}${skipLine}`);
      return message.reply({ embeds: [embed] });
    }

    // list view (last 10)
    const top = recent.slice(0, 10);
    const listLines = top.map((s, i) => `**${i + 1}.** <t:${Math.floor(s.ts / 1000)}:R **${s.logged.length}** logged${s.skipped?.length ? `, ${s.skipped.length} skipped` : ''} • by ${renderUser(s.by)}`);
    const embed = baseEmbed().setColor(0x2C2F33)
      .setTitle('Attendance Log')
      .setDescription(`${listLines.join('\n')}\n\n use \`${prefix}atlog <number \` to view a session's details `)
      .setFooter({ text: `${recent.length} session${recent.length !== 1 ? 's' : ''} on record` });
    return message.reply({ embeds: [embed] });
  }

  // .whoisin
  // .whoisin <roblox game URL or place ID
  // checks which members of group 206868002 are currently in that game.
  if (command === 'whoisin') {
    if (!message.guild) return;
    const input = args[0];
    if (!input) return;
    const WHOISIN_GROUP = 206868002;
    const status = await message.reply({ content: 'fetching group members and game servers...' });
    try {
      // parse place ID supports:
      // roblox.com/games/start?placeid=123&gameinstanceid=...
      // roblox.com/games/123/game name
      // raw numeric place ID
      let placeId = null;
      const qsMatch = input.match(/[?&]place[iI][dD]=(\d+)/i);
      const pathMatch = input.match(/roblox\.com\/games\/(\d+)/i);
      if (qsMatch) placeId = qsMatch[1];
      else if (pathMatch) placeId = pathMatch[1];
      else if (/^\d+$/.test(input)) placeId = input;
      if (!placeId) return status.edit({ content: "couldn't parse a place ID paste a Roblox game URL or server link, e.g. `roblox.com/games/start?placeId=123&gameInstanceId=...`" });

      // resolve place ID → universe ID
      const placeDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`)).json();
      const universeId = placeDetail?.data?.[0]?.universeId;
      if (!universeId) return status.edit({ content: `couldn't find a game for place ID \`${placeId}\` make sure the game exists and is public` });

      // get game name
      let gameName = `Place ${placeId}`;
      try { const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json(); if (gr?.data?.[0]?.name) gameName = gr.data[0].name; } catch {}

      // load ALL group members (paginated)
      await status.edit({ content: 'loading group members...' });
      const memberIds = new Set();
      const memberNames = {};
      let cur = '';
      do {
        try {
          const res = await (await fetch(`https://members.roblox.com/v1/groups/${WHOISIN_GROUP}/users?limit=100&sortOrder=Asc${cur ? `&cursor=${cur}` : ''}`)).json();
          for (const m of (res.data || [])) { memberIds.add(m.user.userId); memberNames[m.user.userId] = m.user.username; }
          cur = res.nextPageCursor || '';
        } catch { cur = ''; break; }
      } while (cur);
      if (!memberIds.size) return status.edit({ content: 'could not load group members Roblox API may be unavailable' });

      // scan all public game servers, collect player tokens
      await status.edit({ content: `loaded **${memberIds.size}** group members, scanning servers...` });
      const allTokens = [];
      let sCur = ''; let serverCount = 0;
      do {
        try {
          const res = await (await fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100${sCur ? `&cursor=${sCur}` : ''}`)).json();
          for (const srv of (res.data || [])) { serverCount++; for (const p of (srv.players || [])) { if (p.playerToken) allTokens.push(p.playerToken); } }
          sCur = res.nextPageCursor || '';
        } catch { sCur = ''; break; }
      } while (sCur);

      if (!allTokens.length) return status.edit({ content: `scanned **${serverCount}** server${serverCount !== 1 ? 's' : ''} no players found (game may be empty or servers private)` });

      // resolve player tokens → roblox user ids via thumbnail batch API
      await status.edit({ content: `resolving **${allTokens.length}** player${allTokens.length !== 1 ? 's' : ''} across **${serverCount}** server${serverCount !== 1 ? 's' : ''}...` });
      const resolvedIds = new Set();
      for (let i = 0; i < allTokens.length; i += 100) {
        try {
          const batch = allTokens.slice(i, i + 100).map((token, idx) => ({ requestId: `${i + idx}`, token, type: 'AvatarHeadShot', size: '150x150', format: 'png', isCircular: false }));
          const res = await (await fetch('https://thumbnails.roblox.com/v1/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })).json();
          for (const item of (res.data || [])) { if (item.targetId && item.targetId !== 0) resolvedIds.add(item.targetId); }
        } catch {}
      }

      // cross reference: keep only players who are group members
      const inGame = [...resolvedIds].filter(id => memberIds.has(id));
      if (!inGame.length) return status.edit({ content: `no group members found in **${gameName}**\n*(checked ${serverCount} server${serverCount !== 1 ? 's' : ''}, ${resolvedIds.size} total player${resolvedIds.size !== 1 ? 's' : ''})*` });

      const lines = inGame.map(id => `• \`${memberNames[id] || id}\``).join('\n');
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle(`Group members in ${gameName}`)
        .setDescription(`**${inGame.length}** group member${inGame.length !== 1 ? 's' : ''} currently in game:\n\n${lines}`)
        .setFooter({ text: `${serverCount} server${serverCount !== 1 ? 's' : ''} scanned • group ${WHOISIN_GROUP}` })
        .setTimestamp()] });
    } catch (err) {
      return status.edit({ content: `whoisin failed ${err.message}` });
    }
  }


  // .ingame


  // ───── new commands (added per user request) ─────────────────────────

  // helper: parse durations like 30s, 10m, 2h, 7d, 1w. returns ms or null
  function parseDuration(input) {
    if (!input) return null;
    const m = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|sec|secs|seconds?|m|min|mins?|minutes?|h|hr|hrs?|hours?|d|day|days?|w|wk|weeks?)?$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2] || 'm';
    if (/^s/.test(unit)) return n * 1000;
    if (/^m/.test(unit)) return n * 60 * 1000;
    if (/^h/.test(unit)) return n * 60 * 60 * 1000;
    if (/^d/.test(unit)) return n * 24 * 60 * 60 * 1000;
    if (/^w/.test(unit)) return n * 7 * 24 * 60 * 60 * 1000;
    return null;
  }
  function fmtDur(ms) {
    if (ms <= 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function pickIdFromArg(token) {
    if (!token) return null;
    const m = String(token).match(/\d{15,}/);
    return m ? m[0] : null;
  }

  // .tempban @user [duration] [reason]
  if (command === 'tempban') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const userId = pickIdFromArg(args[0]);
    if (!userId) return message.reply(`<@${message.author.id}> .tempban @user [duration] [reason]`);
    const ms = parseDuration(args[1]);
    if (!ms) return message.reply('invalid duration. try 10m, 2h, 1d.');
    const reason = args.slice(2).join(' ') || 'no reason';
    try {
      await message.guild.bans.create(userId, { reason: 'tempban: ' + reason });
    } catch (e) { return message.reply('ban failed: ' + e.message); }
    const tb = loadTempbans();
    if (!tb[message.guild.id]) tb[message.guild.id] = {};
    tb[message.guild.id][userId] = { until: Date.now() + ms, reason, mod: message.author.id };
    saveTempbans(tb);
    setTimeout(() => unbanFromTempban(message.guild.id, userId).catch(() => {}), Math.min(ms, 2147483000));
    return message.reply('tempbanned <@' + userId + '> for ' + fmtDur(ms) + ' (' + reason + ')');
  }

  // .lockdown - lock every text channel
  if (command === 'lockdown') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    await message.reply('locking down every text channel...');
    let locked = 0, failed = 0;
    for (const [, ch] of message.guild.channels.cache) {
      if (!ch.isTextBased?.() || ch.isThread?.()) continue;
      try {
        await ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        locked++;
      } catch { failed++; }
    }
    return message.channel.send('lockdown done. locked ' + locked + ' channels' + (failed ? ', ' + failed + ' failed' : ''));
  }

  // .unlockdown - reverse lockdown
  if (command === 'unlockdown') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    await message.reply('unlocking every text channel...');
    let unlocked = 0, failed = 0;
    for (const [, ch] of message.guild.channels.cache) {
      if (!ch.isTextBased?.() || ch.isThread?.()) continue;
      try {
        await ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        unlocked++;
      } catch { failed++; }
    }
    return message.channel.send('lockdown lifted. unlocked ' + unlocked + ' channels' + (failed ? ', ' + failed + ' failed' : ''));
  }

  // .massban id1 id2 id3 ...
  if (command === 'massban') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const ids = args.flatMap(a => String(a).split(/[,\s]+/)).map(pickIdFromArg).filter(Boolean);
    if (!ids.length) return message.reply(`<@${message.author.id}> .massban id1 id2 id3 ... (15+ digit ids)`);
    await message.reply('massbanning ' + ids.length + ' user' + (ids.length !== 1 ? 's' : '') + '...');
    const hb = loadHardbans();
    if (!hb[message.guild.id]) hb[message.guild.id] = [];
    let banned = 0, failed = 0;
    for (const id of ids) {
      try {
        await message.guild.bans.create(id, { reason: 'massban by ' + message.author.tag });
        if (!hb[message.guild.id].includes(id)) hb[message.guild.id].push(id);
        banned++;
      } catch { failed++; }
    }
    saveHardbans(hb);
    return message.channel.send('massban done. banned ' + banned + (failed ? ', ' + failed + ' failed' : ''));
  }

  // .modlogs @user - show all warns + tempbans + jails for this user
  if (command === 'modlogs') {
    if (!message.guild) return message.reply('server only.');
    const userId = pickIdFromArg(args[0]) || message.author.id;
    const lines = [];
    const warnsData = loadWarns();
    const userWarns = warnsData[message.guild.id]?.[userId] || [];
    if (userWarns.length) {
      lines.push('**warnings (' + userWarns.length + ')**');
      userWarns.slice(-10).forEach((w, i) => {
        lines.push(' • ' + (w.reason || 'no reason') + ' — by <@' + (w.mod || '?') + '> <t:' + Math.floor((w.timestamp || w.ts || 0) / 1000) + ':R>');
      });
    }
    const tb = loadTempbans()[message.guild.id]?.[userId];
    if (tb) lines.push('**tempban** until <t:' + Math.floor(tb.until / 1000) + ':f> (' + (tb.reason || 'no reason') + ')');
    const hb = loadHardbans()[message.guild.id] || [];
    if (hb.includes(userId)) lines.push('**hardbanned**');
    const notes = loadNotes()[message.guild.id]?.[userId] || [];
    if (notes.length) {
      lines.push('**staff notes (' + notes.length + ')**');
      notes.slice(-5).forEach(n => lines.push(' • ' + n.text + ' — by <@' + n.mod + '> <t:' + Math.floor(n.ts / 1000) + ':R>'));
    }
    if (!lines.length) return message.reply('no mod actions on record for <@' + userId + '>');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('mod logs for ' + userId).setDescription(lines.join('\n')).setTimestamp()],
      allowedMentions: { users: [] }
    });
  }

  // .slowmode [seconds] - 0/off to disable
  if (command === 'slowmode') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const arg = (args[0] || '').toLowerCase();
    let secs;
    if (arg === 'off' || arg === '0' || arg === '') secs = 0;
    else if (/^\d+$/.test(arg)) secs = parseInt(arg, 10);
    else { const ms = parseDuration(arg); secs = ms ? Math.floor(ms / 1000) : NaN; }
    if (!Number.isFinite(secs) || secs < 0 || secs > 21600) return message.reply(`<@${message.author.id}> .slowmode [seconds 0-21600 | off]`);
    try {
      await message.channel.setRateLimitPerUser(secs, 'slowmode by ' + message.author.tag);
      return message.reply(secs ? 'slowmode set to ' + secs + 's' : 'slowmode disabled');
    } catch (e) { return message.reply('slowmode failed: ' + e.message); }
  }

  // .note @user [text]
  if (command === 'note') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const userId = pickIdFromArg(args[0]);
    const text = args.slice(1).join(' ').trim();
    if (!userId || !text) return message.reply(`<@${message.author.id}> .note @user [text]`);
    const notes = loadNotes();
    if (!notes[message.guild.id]) notes[message.guild.id] = {};
    if (!notes[message.guild.id][userId]) notes[message.guild.id][userId] = [];
    notes[message.guild.id][userId].push({ text, mod: message.author.id, ts: Date.now() });
    saveNotes(notes);
    return message.reply('note saved for <@' + userId + '>');
  }

  // .notes @user
  if (command === 'notes') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const userId = pickIdFromArg(args[0]);
    if (!userId) return message.reply(`<@${message.author.id}> .notes @user`);
    const list = loadNotes()[message.guild.id]?.[userId] || [];
    if (!list.length) return message.reply('no notes for <@' + userId + '>');
    const lines = list.slice(-15).map((n, i) => '`' + (i + 1) + '.` ' + n.text + ' — by <@' + n.mod + '> <t:' + Math.floor(n.ts / 1000) + ':R>');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('notes for ' + userId).setDescription(lines.join('\n')).setTimestamp()],
      allowedMentions: { users: [] }
    });
  }

  // .snipe - last deleted message in this channel
  if (command === 'snipe') {
    const s = snipeCache.get(message.channel.id);
    if (!s) return message.reply('nothing to snipe.');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setAuthor({ name: s.author, iconURL: s.avatarUrl || undefined })
        .setDescription(s.content)
        .setFooter({ text: 'deleted ' + Math.round((Date.now() - s.deletedAt) / 1000) + 's ago' })]
    });
  }

  // .avatar [@user]
  if (command === 'avatar' || command === 'av') {
    const userId = pickIdFromArg(args[0]) || message.author.id;
    const user = await message.client.users.fetch(userId).catch(() => null);
    if (!user) return message.reply('couldn\'t find that user.');
    const url = user.displayAvatarURL({ size: 1024, extension: 'png' });
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(user.tag + "'s avatar").setURL(url).setImage(url)]
    });
  }

  // .serverinfo / .si
  if (command === 'serverinfo' || command === 'si') {
    if (!message.guild) return message.reply('server only.');
    const g = message.guild;
    const owner = await g.fetchOwner().catch(() => null);
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(g.name).setThumbnail(g.iconURL({ size: 256 }) || null)
        .addFields(
          { name: 'id', value: '`' + g.id + '`', inline: true },
          { name: 'owner', value: owner ? '<@' + owner.id + '>' : 'unknown', inline: true },
          { name: 'created', value: '<t:' + Math.floor(g.createdTimestamp / 1000) + ':D>', inline: true },
          { name: 'members', value: String(g.memberCount), inline: true },
          { name: 'channels', value: String(g.channels.cache.size), inline: true },
          { name: 'roles', value: String(g.roles.cache.size), inline: true },
        ).setTimestamp()]
    });
  }

  // .userinfo / .ui / .whois [@user]
  if (command === 'userinfo' || command === 'ui' || command === 'whois') {
    if (!message.guild) return message.reply('server only.');
    const userId = pickIdFromArg(args[0]) || message.author.id;
    const member = await message.guild.members.fetch(userId).catch(() => null);
    if (!member) return message.reply('couldn\'t find that member.');
    const roles = member.roles.cache.filter(r => r.id !== message.guild.id).map(r => '<@&' + r.id + '>').slice(0, 20).join(' ') || 'none';
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(member.user.tag).setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'id', value: '`' + member.id + '`', inline: true },
          { name: 'nickname', value: member.nickname || 'none', inline: true },
          { name: 'joined', value: member.joinedTimestamp ? '<t:' + Math.floor(member.joinedTimestamp / 1000) + ':R>' : 'unknown', inline: true },
          { name: 'created', value: '<t:' + Math.floor(member.user.createdTimestamp / 1000) + ':R>', inline: true },
          { name: 'roles', value: roles },
        ).setTimestamp()],
      allowedMentions: { users: [] }
    });
  }

  // .afk [reason]
  if (command === 'afk') {
    if (!message.guild) return message.reply('server only.');
    const reason = args.join(' ').trim() || 'afk';
    const afkData = loadAfk();
    afkData[message.author.id] = { reason, since: Date.now() };
    saveAfk(afkData);
    return message.reply('you\'re now afk: ' + reason);
  }

  // .activitycheck - send button, members react
  if (command === 'activitycheck' || command === 'ac') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const checks = loadActivityCheck();
    checks[message.guild.id] = { active: true, checkins: [], startedBy: message.author.id, startedAt: Date.now() };
    saveActivityCheck(checks);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ac checkin').setLabel('check in').setStyle(ButtonStyle.Success).setEmoji('✅')
    );
    return message.channel.send({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('activity check').setDescription('hit the button below to confirm you\'re active.\nstarted by <@' + message.author.id + '>').setTimestamp()],
      components: [row]
    });
  }

  // .poll "question" "opt1" "opt2" ... up to 10 options
  if (command === 'poll') {
    if (!message.guild) return message.reply('server only.');
    const raw = message.content.slice(prefix.length + command.length).trim();
    const parts = [...raw.matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2]);
    if (parts.length < 3) return message.reply(`<@${message.author.id}> .poll "question" "opt1" "opt2" ... (up to 10 options)`);
    const question = parts[0];
    const opts = parts.slice(1, 11);
    const NUM = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const desc = opts.map((o, i) => NUM[i] + ' ' + o).join('\n');
    const sent = await message.channel.send({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('📊 ' + question).setDescription(desc).setFooter({ text: 'poll by ' + message.author.tag }).setTimestamp()]
    });
    for (let i = 0; i < opts.length; i++) { try { await sent.react(NUM[i]); } catch {} }
    return;
  }

  // .raidpoints @user / .rp @user
  if (command === 'raidpoints' || command === 'rp') {
    if (!message.guild) return message.reply('server only.');
    const userId = pickIdFromArg(args[0]) || message.author.id;
    const stats = loadRaidStats()[message.guild.id]?.[userId];
    if (!stats) return message.reply('<@' + userId + '> has no raid points yet.');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('raid points').setDescription('<@' + userId + '>')
        .addFields(
          { name: 'all-time', value: String(stats.raidPoints || 0), inline: true },
          { name: 'this week', value: String(stats.weeklyPoints || 0), inline: true },
          { name: 'total raids', value: String(stats.totalRaids || 0), inline: true },
        ).setTimestamp()],
      allowedMentions: { users: [] }
    });
  }

  // .removepoint @user [count=1]
  if (command === 'removepoint' || command === 'removepoints') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const userId = pickIdFromArg(args[0]);
    if (!userId) return message.reply(`<@${message.author.id}> .removepoint @user [count=1]`);
    const count = parseInt(args[1], 10) || 1;
    const stats = loadRaidStats();
    const u = stats[message.guild.id]?.[userId];
    if (!u) return message.reply('that user has no points to subtract.');
    u.raidPoints = Math.max(0, (u.raidPoints || 0) - count);
    u.weeklyPoints = Math.max(0, (u.weeklyPoints || 0) - count);
    stats[message.guild.id][userId] = u;
    saveRaidStats(stats);
    return message.reply('removed ' + count + ' point' + (count !== 1 ? 's' : '') + ' from <@' + userId + '>. now at ' + u.raidPoints + ' all-time.');
  }

  // .grouprank @robloxUser - check rank in tracked group
  if (command === 'grouprank') {
    const username = args[0];
    if (!username) return message.reply(`<@${message.author.id}> .grouprank [robloxUsername]`);
    const groupId = process.env.ROBLOX_GROUP_ID;
    if (!groupId) return message.reply('ROBLOX_GROUP_ID is not set.');
    try {
      const ub = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!ub) return message.reply('couldn\'t find that roblox user.');
      const grp = (await (await fetch('https://groups.roblox.com/v1/users/' + ub.id + '/groups/roles')).json()).data || [];
      const found = grp.find(g => String(g.group?.id) === String(groupId));
      if (!found) return message.reply('**' + ub.name + '** is not in the tracked group.');
      return message.reply('**' + ub.name + '** is rank `' + found.role.rank + '` — **' + found.role.name + '** in ' + (found.group?.name || groupId));
    } catch (e) { return message.reply('lookup failed: ' + e.message); }
  }

  // .welcome [setup #channel msg | off | status]
  if (command === 'welcome') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || '').toLowerCase();
    const data = loadWelcome();
    if (sub === 'off' || sub === 'disable') {
      delete data[message.guild.id];
      saveWelcome(data);
      return message.reply('welcome message disabled.');
    }
    if (sub === 'status' || !sub) {
      const c = data[message.guild.id];
      if (!c) return message.reply('welcome message is off. use `.welcome setup #channel [text]`');
      return message.reply('welcome → <#' + c.channelId + '>\nmessage: ' + (c.message || '(default)'));
    }
    if (sub === 'setup' || sub === 'set') {
      const chId = pickIdFromArg(args[1]);
      if (!chId) return message.reply(`<@${message.author.id}> .welcome setup #channel [text]\nplaceholders: {user}, {guild}, {membercount}`);
      const text = args.slice(2).join(' ').trim() || 'welcome {user} to {guild}!';
      data[message.guild.id] = { channelId: chId, message: text };
      saveWelcome(data);
      return message.reply('welcome set. new joiners will be greeted in <#' + chId + '>');
    }
    return message.reply('subcommands: setup, off, status');
  }

  // .rolemenu create #channel "title" @role1 @role2 ...
  if (command === 'rolemenu') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || '').toLowerCase();
    if (sub !== 'create') return message.reply(`<@${message.author.id}> .rolemenu create #channel "title" @role1 @role2 ...`);
    const chId = pickIdFromArg(args[1]);
    const ch = chId ? message.guild.channels.cache.get(chId) : null;
    if (!ch || !ch.isTextBased?.()) return message.reply('provide a valid text channel.');
    const raw = message.content.slice(prefix.length + command.length).trim();
    const titleMatch = raw.match(/"([^"]+)"/);
    const title = titleMatch ? titleMatch[1] : 'pick your roles';
    const roleIds = [...raw.matchAll(/<@&(\d+)>|\b(\d{15,})\b/g)].map(m => m[1] || m[2]).filter(id => message.guild.roles.cache.has(id));
    if (!roleIds.length) return message.reply('mention at least one role.');
    const options = roleIds.slice(0, 25).map(id => ({ label: message.guild.roles.cache.get(id).name.slice(0, 100), value: id }));
    const menu = new StringSelectMenuBuilder().setCustomId('rolemenu').setPlaceholder('pick a role').setMinValues(0).setMaxValues(options.length).addOptions(options);
    const row = new ActionRowBuilder().addComponents(menu);
    const sent = await ch.send({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(title).setDescription('select roles from the dropdown to toggle them.')],
      components: [row]
    });
    const rmData = loadRolemenu();
    rmData[sent.id] = { guildId: message.guild.id, roles: roleIds };
    saveRolemenu(rmData);
    return message.reply('rolemenu posted in <#' + ch.id + '>');
  }

  // .giveaway start [duration] [winners] [prize] | end [msgid]
  if (command === 'giveaway' || command === 'gw') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'end') {
      const msgId = pickIdFromArg(args[1]);
      if (!msgId) return message.reply(`<@${message.author.id}> .giveaway end [msgid]`);
      await endGiveaway(msgId, message.channel).catch(e => message.reply('end failed: ' + e.message));
      return;
    }
    if (sub !== 'start') return message.reply(`<@${message.author.id}> .giveaway start [duration] [winners] [prize] | .giveaway end [msgid]`);
    const ms = parseDuration(args[1]);
    if (!ms) return message.reply('invalid duration. try 10m, 1h, 1d.');
    const winners = Math.max(1, parseInt(args[2], 10) || 1);
    const prize = args.slice(3).join(' ').trim();
    if (!prize) return message.reply('give a prize description.');
    const endsAt = Date.now() + ms;
    const sent = await message.channel.send({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🎉 giveaway: ' + prize)
        .setDescription('react with 🎉 to enter\nwinners: **' + winners + '**\nends <t:' + Math.floor(endsAt / 1000) + ':R>')
        .setFooter({ text: 'hosted by ' + message.author.tag })]
    });
    try { await sent.react('🎉'); } catch {}
    const gdata = loadGiveaways();
    gdata[sent.id] = { guildId: message.guild.id, channelId: message.channel.id, prize, winners, endsAt, host: message.author.id };
    saveGiveaways(gdata);
    setTimeout(() => endGiveaway(sent.id).catch(() => {}), Math.min(ms, 2147483000));
    return;
  }

  // .antilink on/off/status
  if (command === 'antilink') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAntilink();
    if (sub === 'on' || sub === 'enable') {
      data[message.guild.id] = { enabled: true };
      saveAntilink(data);
      return message.reply('antilink enabled. urls will be auto-deleted (whitelisted users exempt).');
    }
    if (sub === 'off' || sub === 'disable') {
      delete data[message.guild.id];
      saveAntilink(data);
      return message.reply('antilink disabled.');
    }
    return message.reply('antilink is ' + (data[message.guild.id]?.enabled ? 'on' : 'off'));
  }

  // .antispam on/off/status [threshold] [seconds] [muteSeconds]
  if (command === 'antispam') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAntispam();
    if (sub === 'on' || sub === 'enable') {
      const threshold = parseInt(args[1], 10) || 5;
      const seconds = parseInt(args[2], 10) || 5;
      const muteSeconds = parseInt(args[3], 10) || 60;
      data[message.guild.id] = { enabled: true, threshold, seconds, muteSeconds };
      saveAntispam(data);
      return message.reply('antispam enabled. mute on ' + threshold + ' messages in ' + seconds + 's, mute lasts ' + muteSeconds + 's.');
    }
    if (sub === 'off' || sub === 'disable') {
      delete data[message.guild.id];
      saveAntispam(data);
      return message.reply('antispam disabled.');
    }
    const c = data[message.guild.id];
    if (!c) return message.reply('antispam is off');
    return message.reply('antispam: ' + c.threshold + ' messages in ' + c.seconds + 's → ' + c.muteSeconds + 's mute');
  }

  // .antiinvite on/off/status
  if (command === 'antiinvite') {
    if (!message.guild) return message.reply('server only.');
    if (!isWhitelisted(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAntiinvite();
    if (sub === 'on' || sub === 'enable') {
      data[message.guild.id] = { enabled: true };
      saveAntiinvite(data);
      return message.reply('antiinvite enabled. discord invite links will be auto-deleted.');
    }
    if (sub === 'off' || sub === 'disable') {
      delete data[message.guild.id];
      saveAntiinvite(data);
      return message.reply('antiinvite disabled.');
    }
    return message.reply('antiinvite is ' + (data[message.guild.id]?.enabled ? 'on' : 'off'));
  }

  // ════════════════════════════════════════════════════════════════════
  // ROUND 3 — 100 NEW COMMANDS
  // ════════════════════════════════════════════════════════════════════

  const wlOk = uid => isWhitelisted(uid);
  const pickRoleId = t => { if (!t) return null; const m = String(t).match(/\d{15,}/); return m ? m[0] : null; };
  const pickChId   = t => { if (!t) return null; const m = String(t).match(/\d{15,}/); return m ? m[0] : null; };
  const isHex = s => /^#?[0-9a-fA-F]{6}$/.test(s || '');
  const toColor = s => parseInt(String(s).replace(/^#/, ''), 16);

  // ───── CHANNEL MGMT (10) ────────────────────────────────────────────
  if (command === 'createchannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const name = args[0];
    if (!name) return message.reply(`<@${message.author.id}> .createchannel [name] [text|voice]`);
    const type = (args[1] || 'text').toLowerCase() === 'voice' ? 2 : 0;
    try {
      const ch = await message.guild.channels.create({ name, type });
      return message.reply('created <#' + ch.id + '>');
    } catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'delchannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = pickChId(args[0]) || message.channel.id;
    const ch = message.guild.channels.cache.get(id);
    if (!ch) return message.reply('channel not found.');
    try { await ch.delete('delchannel by ' + message.author.tag); return message.channel.id !== id ? message.reply('deleted #' + ch.name) : null; }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'clonechannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = pickChId(args[0]) || message.channel.id;
    const ch = message.guild.channels.cache.get(id);
    if (!ch || !ch.clone) return message.reply('can\'t clone that.');
    try { const c = await ch.clone(); return message.reply('cloned to <#' + c.id + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'renamechannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = pickChId(args[0]);
    const newName = args.slice(1).join(' ').trim();
    if (!id || !newName) return message.reply(`<@${message.author.id}> .renamechannel #channel [newname]`);
    const ch = message.guild.channels.cache.get(id);
    if (!ch) return message.reply('channel not found.');
    try { await ch.setName(newName); return message.reply('renamed to ' + newName); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'hidechannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = pickChId(args[0]) || message.channel.id;
    const ch = message.guild.channels.cache.get(id);
    if (!ch) return message.reply('channel not found.');
    try { await ch.permissionOverwrites.edit(message.guild.roles.everyone, { ViewChannel: false }); return message.reply('hidden ' + ch.name); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'unhidechannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = pickChId(args[0]) || message.channel.id;
    const ch = message.guild.channels.cache.get(id);
    if (!ch) return message.reply('channel not found.');
    try { await ch.permissionOverwrites.edit(message.guild.roles.everyone, { ViewChannel: null }); return message.reply('unhidden ' + ch.name); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'settopic') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const idArg = pickChId(args[0]);
    const ch = idArg ? message.guild.channels.cache.get(idArg) : message.channel;
    const text = (idArg ? args.slice(1) : args).join(' ').trim();
    if (!ch) return message.reply('channel not found.');
    try { await ch.setTopic(text || ''); return message.reply('topic updated.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'archivechannel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = pickChId(args[0]) || message.channel.id;
    const ch = message.guild.channels.cache.get(id);
    if (!ch) return message.reply('channel not found.');
    try {
      await ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false, ViewChannel: false });
      return message.reply('archived ' + ch.name);
    } catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'pin') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    let target = null;
    if (message.reference?.messageId) target = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    else if (args[0]) target = await message.channel.messages.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('reply to a message or give a message id.');
    try { await target.pin(); return message.reply('pinned.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'unpin') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    let target = null;
    if (message.reference?.messageId) target = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    else if (args[0]) target = await message.channel.messages.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('reply to a message or give a message id.');
    try { await target.unpin(); return message.reply('unpinned.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }

  // ───── VOICE (10) ───────────────────────────────────────────────────
  if (command === 'vckick') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .vckick @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m?.voice.channel) return message.reply('that user isn\'t in a voice channel.');
    try { await m.voice.disconnect(); return message.reply('disconnected <@' + uid + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vcmove') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    const chId = pickChId(args[1]);
    if (!uid || !chId) return message.reply(`<@${message.author.id}> .vcmove @user #voice`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m?.voice.channel) return message.reply('that user isn\'t in a voice channel.');
    try { await m.voice.setChannel(chId); return message.reply('moved <@' + uid + '> to <#' + chId + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vcmute') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .vcmute @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m?.voice.channel) return message.reply('that user isn\'t in a voice channel.');
    try { await m.voice.setMute(true); return message.reply('vc-muted <@' + uid + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vcunmute') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .vcunmute @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m?.voice.channel) return message.reply('that user isn\'t in a voice channel.');
    try { await m.voice.setMute(false); return message.reply('vc-unmuted <@' + uid + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vcdeafen') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .vcdeafen @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m?.voice.channel) return message.reply('that user isn\'t in a voice channel.');
    try { await m.voice.setDeaf(true); return message.reply('vc-deafened <@' + uid + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vcundeafen') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .vcundeafen @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m?.voice.channel) return message.reply('that user isn\'t in a voice channel.');
    try { await m.voice.setDeaf(false); return message.reply('vc-undeafened <@' + uid + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vclimit') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const chId = pickChId(args[0]);
    const n = parseInt(args[1], 10);
    if (!chId || !Number.isFinite(n) || n < 0 || n > 99) return message.reply(`<@${message.author.id}> .vclimit #voice [0-99]`);
    const ch = message.guild.channels.cache.get(chId);
    if (!ch || ch.type !== 2) return message.reply('not a voice channel.');
    try { await ch.setUserLimit(n); return message.reply('user limit set to ' + n); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vcname') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const chId = pickChId(args[0]);
    const newName = args.slice(1).join(' ').trim();
    if (!chId || !newName) return message.reply(`<@${message.author.id}> .vcname #voice [newname]`);
    const ch = message.guild.channels.cache.get(chId);
    if (!ch || ch.type !== 2) return message.reply('not a voice channel.');
    try { await ch.setName(newName); return message.reply('renamed.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'vctotal') {
    if (!message.guild) return message.reply('server only.');
    let total = 0;
    for (const [, ch] of message.guild.channels.cache) if (ch.type === 2) total += ch.members.size;
    return message.reply(total + ' members in voice across ' + message.guild.channels.cache.filter(c => c.type === 2).size + ' channels.');
  }
  if (command === 'vcdisconnectall') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const chId = pickChId(args[0]);
    if (!chId) return message.reply(`<@${message.author.id}> .vcdisconnectall #voice`);
    const ch = message.guild.channels.cache.get(chId);
    if (!ch || ch.type !== 2) return message.reply('not a voice channel.');
    let n = 0;
    for (const [, m] of ch.members) { try { await m.voice.disconnect(); n++; } catch {} }
    return message.reply('disconnected ' + n + ' members.');
  }

  // ───── ROLE MGMT (10) ───────────────────────────────────────────────
  if (command === 'createrole') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const colorArg = args.find(a => isHex(a));
    const name = args.filter(a => a !== colorArg).join(' ').trim();
    if (!name) return message.reply(`<@${message.author.id}> .createrole [name] [hex]`);
    try { const r = await message.guild.roles.create({ name, color: colorArg ? toColor(colorArg) : undefined }); return message.reply('created role <@&' + r.id + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'delrole') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const rid = pickRoleId(args[0]);
    const role = rid && message.guild.roles.cache.get(rid);
    if (!role) return message.reply(`<@${message.author.id}> .delrole @role`);
    try { await role.delete('delrole by ' + message.author.tag); return message.reply('deleted role.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'rolecolor') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const rid = pickRoleId(args[0]); const hex = args[1];
    if (!rid || !isHex(hex)) return message.reply(`<@${message.author.id}> .rolecolor @role [hex]`);
    const role = message.guild.roles.cache.get(rid);
    if (!role) return message.reply('role not found.');
    try { await role.setColor(toColor(hex)); return message.reply('color updated.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'rolename') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const rid = pickRoleId(args[0]); const nn = args.slice(1).join(' ').trim();
    if (!rid || !nn) return message.reply(`<@${message.author.id}> .rolename @role [name]`);
    const role = message.guild.roles.cache.get(rid);
    if (!role) return message.reply('role not found.');
    try { await role.setName(nn); return message.reply('renamed.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'rolepos') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const rid = pickRoleId(args[0]); const pos = parseInt(args[1], 10);
    if (!rid || !Number.isFinite(pos)) return message.reply(`<@${message.author.id}> .rolepos @role [pos]`);
    const role = message.guild.roles.cache.get(rid);
    if (!role) return message.reply('role not found.');
    try { await role.setPosition(pos); return message.reply('position set.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'rolehoist') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const rid = pickRoleId(args[0]);
    const role = rid && message.guild.roles.cache.get(rid);
    if (!role) return message.reply(`<@${message.author.id}> .rolehoist @role`);
    try { await role.setHoist(!role.hoist); return message.reply('hoist now ' + (!role.hoist)); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'rolemention') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const rid = pickRoleId(args[0]);
    const role = rid && message.guild.roles.cache.get(rid);
    if (!role) return message.reply(`<@${message.author.id}> .rolemention @role`);
    try { await role.setMentionable(!role.mentionable); return message.reply('mentionable now ' + (!role.mentionable)); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'rolemembers') {
    if (!message.guild) return message.reply('server only.');
    const rid = pickRoleId(args[0]);
    const role = rid && message.guild.roles.cache.get(rid);
    if (!role) return message.reply(`<@${message.author.id}> .rolemembers @role`);
    await message.guild.members.fetch().catch(() => {});
    const list = role.members.map(m => '<@' + m.id + '>').slice(0, 50).join(', ');
    return message.reply({ content: role.members.size + ' members:\n' + (list || 'none'), allowedMentions: { users: [] } });
  }
  if (command === 'allroles') {
    if (!message.guild) return message.reply('server only.');
    const list = message.guild.roles.cache.filter(r => r.id !== message.guild.id).sort((a, b) => b.position - a.position).map(r => r.name + ' (' + r.members.size + ')').slice(0, 80).join('\n');
    return message.reply('```\n' + list + '\n```');
  }
  if (command === 'removeallroles') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .removeallroles @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m) return message.reply('member not found.');
    try { await m.roles.set([]); return message.reply('stripped all roles from <@' + uid + '>'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }

  // ───── UTILITY (15) ─────────────────────────────────────────────────
  if (command === 'ping') {
    const sent = await message.reply('pinging...');
    const rt = sent.createdTimestamp - message.createdTimestamp;
    return sent.edit('pong • ' + rt + 'ms api • ws ' + Math.round(message.client.ws.ping) + 'ms');
  }
  if (command === 'uptime') {
    const s = Math.floor(process.uptime());
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return message.reply('up: ' + d + 'd ' + h + 'h ' + m + 'm ' + sec + 's');
  }
  if (command === 'botinfo') {
    return message.reply('servers: ' + message.client.guilds.cache.size + ' • users: ' + message.client.users.cache.size + ' • node: ' + process.version + ' • mem: ' + (process.memoryUsage().rss / 1024 / 1024).toFixed(0) + ' MB');
  }
  if (command === 'members') {
    if (!message.guild) return message.reply('server only.');
    return message.reply('total members: ' + message.guild.memberCount);
  }
  if (command === 'online') {
    if (!message.guild) return message.reply('server only.');
    await message.guild.members.fetch().catch(() => {});
    const n = message.guild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size;
    return message.reply('online: ' + n);
  }
  if (command === 'bots') {
    if (!message.guild) return message.reply('server only.');
    await message.guild.members.fetch().catch(() => {});
    return message.reply('bots: ' + message.guild.members.cache.filter(m => m.user.bot).size);
  }
  if (command === 'humans') {
    if (!message.guild) return message.reply('server only.');
    await message.guild.members.fetch().catch(() => {});
    return message.reply('humans: ' + message.guild.members.cache.filter(m => !m.user.bot).size);
  }
  if (command === 'roleinfo') {
    if (!message.guild) return message.reply('server only.');
    const rid = pickRoleId(args[0]);
    const role = rid && message.guild.roles.cache.get(rid);
    if (!role) return message.reply(`<@${message.author.id}> .roleinfo @role`);
    return message.reply('**' + role.name + '** • id `' + role.id + '` • members ' + role.members.size + ' • color #' + role.color.toString(16).padStart(6, '0') + ' • hoist ' + role.hoist + ' • mentionable ' + role.mentionable + ' • created <t:' + Math.floor(role.createdTimestamp / 1000) + ':R>');
  }
  if (command === 'channelinfo') {
    if (!message.guild) return message.reply('server only.');
    const id = pickChId(args[0]) || message.channel.id;
    const ch = message.guild.channels.cache.get(id);
    if (!ch) return message.reply('channel not found.');
    return message.reply('**' + ch.name + '** • id `' + ch.id + '` • type ' + ch.type + ' • created <t:' + Math.floor(ch.createdTimestamp / 1000) + ':R>' + (ch.topic ? '\ntopic: ' + ch.topic : ''));
  }
  if (command === 'emoji') {
    if (!message.guild) return message.reply('server only.');
    const m = (args[0] || '').match(/<a?:\w+:(\d+)>/);
    const id = m ? m[1] : args[0];
    const e = message.guild.emojis.cache.get(id);
    if (!e) return message.reply('not a server emoji.');
    return message.reply(e.name + ' • id `' + e.id + '` • ' + e.imageURL());
  }
  if (command === 'emojis') {
    if (!message.guild) return message.reply('server only.');
    const list = message.guild.emojis.cache.map(e => e.toString()).slice(0, 50).join(' ');
    return message.reply(message.guild.emojis.cache.size + ' emojis:\n' + (list || 'none'));
  }
  if (command === 'servericon') {
    if (!message.guild) return message.reply('server only.');
    const url = message.guild.iconURL({ size: 1024 });
    return message.reply(url || 'no icon set.');
  }
  if (command === 'banner') {
    const uid = pickIdFromArg(args[0]) || message.author.id;
    const u = await message.client.users.fetch(uid, { force: true }).catch(() => null);
    if (!u?.bannerURL()) return message.reply('that user has no banner.');
    return message.reply(u.bannerURL({ size: 1024 }));
  }
  if (command === 'invites') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    try {
      const inv = await message.guild.invites.fetch();
      if (!inv.size) return message.reply('no active invites.');
      const lines = inv.map(i => '`' + i.code + '` by ' + (i.inviter?.tag || '?') + ' • uses ' + i.uses).slice(0, 20).join('\n');
      return message.reply(lines);
    } catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'permissions' || command === 'perms') {
    if (!message.guild) return message.reply('server only.');
    const uid = pickIdFromArg(args[0]) || message.author.id;
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m) return message.reply('member not found.');
    const perms = m.permissions.toArray().slice(0, 30).join(', ');
    return message.reply('<@' + uid + '> perms: ' + (perms || 'none'));
  }

  // ───── INFO (5) ─────────────────────────────────────────────────────
  if (command === 'inviteinfo') {
    const code = (args[0] || '').replace(/.*\//, '');
    if (!code) return message.reply(`<@${message.author.id}> .inviteinfo [code]`);
    try {
      const i = await message.client.fetchInvite(code);
      return message.reply('server: ' + (i.guild?.name || '?') + ' • channel: #' + (i.channel?.name || '?') + ' • members: ' + (i.memberCount || '?') + ' • inviter: ' + (i.inviter?.tag || '?'));
    } catch (e) { return message.reply('invalid invite.'); }
  }
  if (command === 'firstmsg') {
    try {
      const msgs = await message.channel.messages.fetch({ after: '0', limit: 1 });
      const first = msgs.first();
      if (!first) return message.reply('no messages found.');
      return message.reply('first msg: ' + first.url + '\nby ' + first.author.tag + '\n' + (first.content || '(no text)').slice(0, 500));
    } catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'msgcount') {
    if (!message.guild) return message.reply('server only.');
    const uid = pickIdFromArg(args[0]) || message.author.id;
    const msgs = await message.channel.messages.fetch({ limit: 100 });
    const n = msgs.filter(m => m.author.id === uid).size;
    return message.reply('<@' + uid + '> sent ' + n + ' of the last 100 messages here.');
  }
  if (command === 'roles') {
    if (!message.guild) return message.reply('server only.');
    const uid = pickIdFromArg(args[0]) || message.author.id;
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m) return message.reply('member not found.');
    const list = m.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.name).join(', ');
    return message.reply('<@' + uid + '> has: ' + (list || 'no roles'));
  }
  if (command === 'usercount') {
    if (!message.guild) return message.reply('server only.');
    return message.reply('this server has ' + message.guild.memberCount + ' members.');
  }

  // ───── LOGGING (5) ──────────────────────────────────────────────────
  function setLogChannel(kind) {
    return async () => {
      if (!message.guild) return message.reply('server only.');
      if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
      const chId = pickChId(args[0]);
      if (!chId) return message.reply(`<@${message.author.id}> .` + command + ' #channel');
      const data = loadLogChannels();
      if (!data[message.guild.id]) data[message.guild.id] = {};
      data[message.guild.id][kind] = chId;
      saveLogChannels(data);
      return message.reply(kind + ' log → <#' + chId + '>');
    };
  }
  if (command === 'setjoinlog')  return setLogChannel('join')();
  if (command === 'setleavelog') return setLogChannel('leave')();
  if (command === 'setvoicelog') return setLogChannel('voice')();
  if (command === 'setmsglog')   return setLogChannel('msg')();
  if (command === 'logsoff') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const data = loadLogChannels();
    delete data[message.guild.id];
    saveLogChannels(data);
    return message.reply('all extra logs disabled.');
  }

  // ───── REACTION ROLES (5) ───────────────────────────────────────────
  if (command === 'rradd') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const msgId = pickIdFromArg(args[0]);
    const emoji = args[1];
    const rid = pickRoleId(args[2]);
    if (!msgId || !emoji || !rid) return message.reply(`<@${message.author.id}> .rradd [msgid] [emoji] @role`);
    const target = await message.channel.messages.fetch(msgId).catch(() => null);
    if (!target) return message.reply('message not found in this channel.');
    try { await target.react(emoji); } catch { return message.reply('can\'t react with that emoji.'); }
    const data = loadReactionRoles();
    if (!data[msgId]) data[msgId] = { guildId: message.guild.id, channelId: message.channel.id, map: {} };
    const eKey = emoji.match(/<a?:\w+:(\d+)>/)?.[1] || emoji;
    data[msgId].map[eKey] = rid;
    saveReactionRoles(data);
    return message.reply('reaction role added.');
  }
  if (command === 'rrremove') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const msgId = pickIdFromArg(args[0]);
    const emoji = args[1];
    if (!msgId || !emoji) return message.reply(`<@${message.author.id}> .rrremove [msgid] [emoji]`);
    const data = loadReactionRoles();
    const eKey = emoji.match(/<a?:\w+:(\d+)>/)?.[1] || emoji;
    if (!data[msgId]?.map[eKey]) return message.reply('not registered.');
    delete data[msgId].map[eKey];
    if (!Object.keys(data[msgId].map).length) delete data[msgId];
    saveReactionRoles(data);
    return message.reply('removed.');
  }
  if (command === 'rrlist') {
    const msgId = pickIdFromArg(args[0]);
    if (!msgId) return message.reply(`<@${message.author.id}> .rrlist [msgid]`);
    const data = loadReactionRoles()[msgId];
    if (!data) return message.reply('no reaction roles on that message.');
    const lines = Object.entries(data.map).map(([e, r]) => '`' + e + '` → <@&' + r + '>').join('\n');
    return message.reply({ content: lines, allowedMentions: { roles: [] } });
  }
  if (command === 'rrclear') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const msgId = pickIdFromArg(args[0]);
    if (!msgId) return message.reply(`<@${message.author.id}> .rrclear [msgid]`);
    const data = loadReactionRoles();
    if (!data[msgId]) return message.reply('nothing to clear.');
    delete data[msgId];
    saveReactionRoles(data);
    return message.reply('cleared.');
  }
  if (command === 'rrpost') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const chId = pickChId(args[0]);
    const text = args.slice(1).join(' ').trim() || 'react below to grab roles';
    const ch = chId && message.guild.channels.cache.get(chId);
    if (!ch?.isTextBased?.()) return message.reply(`<@${message.author.id}> .rrpost #channel [text]`);
    const sent = await ch.send(text);
    return message.reply('posted. message id: `' + sent.id + '`. now use .rradd ' + sent.id + ' [emoji] @role');
  }

  // ───── CUSTOM COMMANDS (5) ──────────────────────────────────────────
  if (command === 'ccadd') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const name = (args[0] || '').toLowerCase();
    const resp = args.slice(1).join(' ').trim();
    if (!name || !resp) return message.reply(`<@${message.author.id}> .ccadd [name] [response]`);
    const data = loadCC();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    data[message.guild.id][name] = resp;
    saveCC(data);
    return message.reply('saved. invoke with `' + getPrefix() + name + '`');
  }
  if (command === 'ccdel') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const name = (args[0] || '').toLowerCase();
    const data = loadCC();
    if (!data[message.guild.id]?.[name]) return message.reply('no such custom command.');
    delete data[message.guild.id][name];
    saveCC(data);
    return message.reply('deleted.');
  }
  if (command === 'cclist') {
    if (!message.guild) return message.reply('server only.');
    const data = loadCC()[message.guild.id] || {};
    const keys = Object.keys(data);
    if (!keys.length) return message.reply('no custom commands.');
    return message.reply('custom commands: ' + keys.map(k => '`' + k + '`').join(', '));
  }
  if (command === 'ccedit') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const name = (args[0] || '').toLowerCase();
    const resp = args.slice(1).join(' ').trim();
    if (!name || !resp) return message.reply(`<@${message.author.id}> .ccedit [name] [response]`);
    const data = loadCC();
    if (!data[message.guild.id]?.[name]) return message.reply('no such custom command.');
    data[message.guild.id][name] = resp;
    saveCC(data);
    return message.reply('updated.');
  }
  if (command === 'ccshow') {
    if (!message.guild) return message.reply('server only.');
    const name = (args[0] || '').toLowerCase();
    const resp = loadCC()[message.guild.id]?.[name];
    if (!resp) return message.reply('no such custom command.');
    return message.reply('`' + name + '` → ' + resp);
  }

  // ───── EMBED BUILDER (5) ────────────────────────────────────────────
  if (command === 'embed') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const raw = message.content.slice(prefix.length + command.length).trim();
    const parts = [...raw.matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2]);
    const chId = pickChId(parts[0]);
    if (!chId) return message.reply(`<@${message.author.id}> .embed #channel "title" "desc" [hex]`);
    const ch = message.guild.channels.cache.get(chId);
    if (!ch?.isTextBased?.()) return message.reply('not a text channel.');
    const title = parts[1] || '';
    const desc = parts[2] || '';
    const colorHex = parts[3] && isHex(parts[3]) ? toColor(parts[3]) : 0x2C2F33;
    const eb = baseEmbed().setColor(colorHex);
    if (title) eb.setTitle(title);
    if (desc) eb.setDescription(desc);
    const sent = await ch.send({ embeds: [eb] });
    return message.reply('posted. id: `' + sent.id + '`');
  }
  if (command === 'embedjson') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const chId = pickChId(args[0]);
    const ch = chId && message.guild.channels.cache.get(chId);
    if (!ch?.isTextBased?.()) return message.reply(`<@${message.author.id}> .embedjson #channel {json}`);
    const json = message.content.slice(message.content.indexOf(args[0]) + args[0].length).trim();
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { return message.reply('invalid json: ' + e.message); }
    try { const sent = await ch.send({ embeds: [parsed] }); return message.reply('posted. id: `' + sent.id + '`'); }
    catch (e) { return message.reply('send failed: ' + e.message); }
  }
  if (command === 'embededit') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const raw = message.content.slice(prefix.length + command.length).trim();
    const parts = [...raw.matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2]);
    const msgId = pickIdFromArg(parts[0]);
    if (!msgId) return message.reply(`<@${message.author.id}> .embededit [msgid] "title" "desc"`);
    const target = await message.channel.messages.fetch(msgId).catch(() => null);
    if (!target?.embeds[0]) return message.reply('no embed found.');
    const eb = baseEmbed().setColor(target.embeds[0].color || 0x2C2F33);
    if (parts[1]) eb.setTitle(parts[1]);
    if (parts[2]) eb.setDescription(parts[2]);
    try { await target.edit({ embeds: [eb] }); return message.reply('edited.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'embedfield') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const raw = message.content.slice(prefix.length + command.length).trim();
    const parts = [...raw.matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2]);
    const msgId = pickIdFromArg(parts[0]);
    if (!msgId || !parts[1] || !parts[2]) return message.reply(`<@${message.author.id}> .embedfield [msgid] "name" "value"`);
    const target = await message.channel.messages.fetch(msgId).catch(() => null);
    if (!target?.embeds[0]) return message.reply('no embed found.');
    const eb = baseEmbed().setColor(target.embeds[0].color || 0x2C2F33);
    if (target.embeds[0].title) eb.setTitle(target.embeds[0].title);
    if (target.embeds[0].description) eb.setDescription(target.embeds[0].description);
    for (const f of target.embeds[0].fields || []) eb.addFields(f);
    eb.addFields({ name: parts[1], value: parts[2] });
    try { await target.edit({ embeds: [eb] }); return message.reply('field added.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'embedcolor') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const msgId = pickIdFromArg(args[0]);
    const hex = args[1];
    if (!msgId || !isHex(hex)) return message.reply(`<@${message.author.id}> .embedcolor [msgid] [hex]`);
    const target = await message.channel.messages.fetch(msgId).catch(() => null);
    if (!target?.embeds[0]) return message.reply('no embed found.');
    const eb = baseEmbed().setColor(toColor(hex));
    if (target.embeds[0].title) eb.setTitle(target.embeds[0].title);
    if (target.embeds[0].description) eb.setDescription(target.embeds[0].description);
    for (const f of target.embeds[0].fields || []) eb.addFields(f);
    try { await target.edit({ embeds: [eb] }); return message.reply('color updated.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }

  // invite leaderboard
  if (command === 'invitelb') {
    if (!message.guild) return message.reply('server only.');
    try {
      const inv = await message.guild.invites.fetch();
      const totals = {};
      for (const i of inv.values()) {
        if (!i.inviter) continue;
        totals[i.inviter.id] = (totals[i.inviter.id] || 0) + i.uses;
      }
      const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (!ranked.length) return message.reply('no invite stats yet.');
      return message.reply('**top inviters**\n' + ranked.map(([id, n], i) => (i + 1) + '. <@' + id + '> — ' + n).join('\n'));
    } catch (e) { return message.reply('failed: ' + e.message); }
  }
  // nickname commands
  if (command === 'nick') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    const nn = args.slice(1).join(' ').trim();
    if (!uid) return message.reply(`<@${message.author.id}> .nick @user [name]`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m) return message.reply('member not found.');
    try { await m.setNickname(nn || null); return message.reply('nick updated.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'resetnick') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .resetnick @user`);
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m) return message.reply('member not found.');
    try { await m.setNickname(null); return message.reply('nick reset.'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'nickall') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const prefixText = args.join(' ').trim();
    if (!prefixText) return message.reply(`<@${message.author.id}> .nickall [prefix]`);
    await message.reply('renaming everyone to start with "' + prefixText + '"... this may take a while.');
    await message.guild.members.fetch().catch(() => {});
    let n = 0;
    for (const [, m] of message.guild.members.cache) {
      if (m.user.bot) continue;
      try { await m.setNickname(prefixText + ' ' + m.user.username); n++; } catch {}
    }
    return message.channel.send('renamed ' + n + ' members.');
  }

  // mod extras — softban, tempmute, temban, cases, notes etc
  if (command === 'softban') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .softban @user [reason]`);
    const reason = args.slice(1).join(' ') || 'softban';
    try {
      await message.guild.bans.create(uid, { reason, deleteMessageSeconds: 86400 });
      await message.guild.bans.remove(uid, 'softban auto-unban');
      return message.reply('softbanned <@' + uid + '> (msgs cleared).');
    } catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'tempmute') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    const ms = parseDuration(args[1]);
    if (!uid || !ms) return message.reply(`<@${message.author.id}> .tempmute @user [duration] [reason]`);
    const reason = args.slice(2).join(' ') || 'no reason';
    const m = await message.guild.members.fetch(uid).catch(() => null);
    if (!m) return message.reply('member not found.');
    try { await m.timeout(ms, reason); return message.reply('muted <@' + uid + '> for ' + fmtDur(ms) + ' (' + reason + ')'); }
    catch (e) { return message.reply('failed: ' + e.message); }
  }
  if (command === 'cases') {
    if (!message.guild) return message.reply('server only.');
    const uid = pickIdFromArg(args[0]) || message.author.id;
    const list = loadCases()[message.guild.id]?.filter(c => c.user === uid) || [];
    if (!list.length) return message.reply('no cases for <@' + uid + '>');
    return message.reply(list.slice(-10).map(c => '`#' + c.id + '` ' + c.action + ' — ' + c.reason + ' (by <@' + c.mod + '>)').join('\n'));
  }
  if (command === 'case') {
    if (!message.guild) return message.reply('server only.');
    const id = parseInt(args[0], 10);
    if (!id) return message.reply(`<@${message.author.id}> .case [#]`);
    const c = loadCases()[message.guild.id]?.find(x => x.id === id);
    if (!c) return message.reply('case not found.');
    return message.reply('**case #' + c.id + '** ' + c.action + '\nuser: <@' + c.user + '>\nmod: <@' + c.mod + '>\nreason: ' + c.reason + '\nat: <t:' + Math.floor(c.ts / 1000) + ':f>');
  }
  if (command === 'delcase') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const id = parseInt(args[0], 10);
    if (!id) return message.reply(`<@${message.author.id}> .delcase [#]`);
    const data = loadCases();
    if (!data[message.guild.id]) return message.reply('case not found.');
    const before = data[message.guild.id].length;
    data[message.guild.id] = data[message.guild.id].filter(c => c.id !== id);
    if (data[message.guild.id].length === before) return message.reply('case not found.');
    saveCases(data);
    return message.reply('case deleted.');
  }

  // ───── FUN (5) ──────────────────────────────────────────────────────
  if (command === 'say') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const text = args.join(' ').trim();
    if (!text) return message.reply(`<@${message.author.id}> .say [text]`);
    try { await message.delete(); } catch {}
    return message.channel.send({ content: text, allowedMentions: { parse: [] } });
  }
  if (command === 'flip') {
    return message.reply(Math.random() < 0.5 ? 'heads' : 'tails');
  }
  if (command === 'choose') {
    const opts = args.join(' ').split(/[,|]/).map(s => s.trim()).filter(Boolean);
    if (opts.length < 2) return message.reply(`<@${message.author.id}> give me at least 2 options separated by commas`);
    return message.reply('i pick: ' + opts[Math.floor(Math.random() * opts.length)]);
  }

  // purge variants — purgebot, purgeuser, purgematch, purgelinks, purgeimages
  async function bulkDelete(filter, n) {
    const limit = Math.min(100, parseInt(n, 10) || 100);
    const msgs = await message.channel.messages.fetch({ limit });
    const target = msgs.filter(filter).filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    if (!target.size) return 0;
    await message.channel.bulkDelete(target, true);
    return target.size;
  }
  if (command === 'purgebot') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    try { await message.delete(); } catch {}
    const n = await bulkDelete(m => m.author.bot, args[0]);
    const r = await message.channel.send('purged ' + n + ' bot messages.');
    setTimeout(() => r.delete().catch(() => {}), 4000);
    return;
  }
  if (command === 'purgeuser') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const uid = pickIdFromArg(args[0]);
    if (!uid) return message.reply(`<@${message.author.id}> .purgeuser @user [n]`);
    try { await message.delete(); } catch {}
    const n = await bulkDelete(m => m.author.id === uid, args[1]);
    const r = await message.channel.send('purged ' + n + ' messages from <@' + uid + '>.');
    setTimeout(() => r.delete().catch(() => {}), 4000);
    return;
  }
  if (command === 'purgematch') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const text = args.slice(0, -1).join(' ').trim() || args.join(' ').trim();
    const num = parseInt(args[args.length - 1], 10);
    const limit = Number.isFinite(num) ? num : 100;
    const search = Number.isFinite(num) ? args.slice(0, -1).join(' ') : args.join(' ');
    if (!search) return message.reply(`<@${message.author.id}> .purgematch [text] [n]`);
    try { await message.delete(); } catch {}
    const n = await bulkDelete(m => m.content.toLowerCase().includes(search.toLowerCase()), limit);
    const r = await message.channel.send('purged ' + n + ' matching messages.');
    setTimeout(() => r.delete().catch(() => {}), 4000);
    return;
  }
  if (command === 'purgelinks') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    try { await message.delete(); } catch {}
    const n = await bulkDelete(m => /https?:\/\//i.test(m.content), args[0]);
    const r = await message.channel.send('purged ' + n + ' messages with links.');
    setTimeout(() => r.delete().catch(() => {}), 4000);
    return;
  }
  if (command === 'purgeimages') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    try { await message.delete(); } catch {}
    const n = await bulkDelete(m => m.attachments.size > 0 || m.embeds.some(e => e.image || e.thumbnail), args[0]);
    const r = await message.channel.send('purged ' + n + ' messages with images.');
    setTimeout(() => r.delete().catch(() => {}), 4000);
    return;
  }

  // ───── AUTO-MOD (7) ─────────────────────────────────────────────────
  if (command === 'raidmode') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAutomod();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    if (sub === 'on') {
      data[message.guild.id].raidmode = true;
      saveAutomod(data);
      let n = 0;
      for (const [, ch] of message.guild.channels.cache) {
        if (ch.isTextBased?.() && !ch.isThread?.()) { try { await ch.setRateLimitPerUser(30, 'raidmode'); n++; } catch {} }
      }
      return message.reply('raidmode ON • slowmode 30s applied to ' + n + ' channels.');
    }
    if (sub === 'off') {
      delete data[message.guild.id].raidmode;
      saveAutomod(data);
      let n = 0;
      for (const [, ch] of message.guild.channels.cache) {
        if (ch.isTextBased?.() && !ch.isThread?.()) { try { await ch.setRateLimitPerUser(0, 'raidmode off'); n++; } catch {} }
      }
      return message.reply('raidmode OFF • slowmode cleared from ' + n + ' channels.');
    }
    return message.reply('raidmode is ' + (data[message.guild.id]?.raidmode ? 'on' : 'off'));
  }
  if (command === 'antimention') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAutomod();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    if (sub === 'on') {
      data[message.guild.id].antimention = { threshold: parseInt(args[1], 10) || 5 };
      saveAutomod(data);
      return message.reply('antimention on. threshold: ' + data[message.guild.id].antimention.threshold);
    }
    if (sub === 'off') { delete data[message.guild.id].antimention; saveAutomod(data); return message.reply('antimention off.'); }
    const c = data[message.guild.id]?.antimention;
    return message.reply('antimention: ' + (c ? 'on (threshold ' + c.threshold + ')' : 'off'));
  }
  if (command === 'antiemoji') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAutomod();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    if (sub === 'on') {
      data[message.guild.id].antiemoji = { threshold: parseInt(args[1], 10) || 10 };
      saveAutomod(data);
      return message.reply('antiemoji on. threshold: ' + data[message.guild.id].antiemoji.threshold);
    }
    if (sub === 'off') { delete data[message.guild.id].antiemoji; saveAutomod(data); return message.reply('antiemoji off.'); }
    const c = data[message.guild.id]?.antiemoji;
    return message.reply('antiemoji: ' + (c ? 'on (threshold ' + c.threshold + ')' : 'off'));
  }
  if (command === 'blacklistword') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || '').toLowerCase();
    const data = loadBlacklist();
    if (!data[message.guild.id]) data[message.guild.id] = [];
    if (sub === 'add') {
      const w = args.slice(1).join(' ').toLowerCase().trim();
      if (!w) return message.reply(`<@${message.author.id}> .blacklistword add [word]`);
      if (!data[message.guild.id].includes(w)) data[message.guild.id].push(w);
      saveBlacklist(data);
      return message.reply('added.');
    }
    if (sub === 'remove' || sub === 'rm') {
      const w = args.slice(1).join(' ').toLowerCase().trim();
      data[message.guild.id] = data[message.guild.id].filter(x => x !== w);
      saveBlacklist(data);
      return message.reply('removed.');
    }
    if (sub === 'list' || sub === '') {
      if (!data[message.guild.id].length) return message.reply('no blacklisted words.');
      return message.reply('blacklisted: ' + data[message.guild.id].map(w => '`' + w + '`').join(', '));
    }
    return message.reply(`<@${message.author.id}> .blacklistword add/remove/list`);
  }
  if (command === 'autopurge') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const chId = pickChId(args[0]) || message.channel.id;
    const sec = (args[1] || '').toLowerCase();
    const data = loadAutomod();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    if (!data[message.guild.id].autopurge) data[message.guild.id].autopurge = {};
    if (sec === 'off' || sec === '0') {
      delete data[message.guild.id].autopurge[chId];
      saveAutomod(data);
      return message.reply('autopurge disabled in <#' + chId + '>');
    }
    const n = parseInt(sec, 10);
    if (!Number.isFinite(n) || n < 5) return message.reply(`<@${message.author.id}> .autopurge #channel [seconds | off] (min 5)`);
    data[message.guild.id].autopurge[chId] = n;
    saveAutomod(data);
    return message.reply('autopurge: messages in <#' + chId + '> deleted after ' + n + 's.');
  }
  if (command === 'capslimit') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const sub = (args[0] || 'status').toLowerCase();
    const data = loadAutomod();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    if (sub === 'on') {
      data[message.guild.id].capslimit = { threshold: parseInt(args[1], 10) || 70 };
      saveAutomod(data);
      return message.reply('capslimit on. threshold: ' + data[message.guild.id].capslimit.threshold + '% caps.');
    }
    if (sub === 'off') { delete data[message.guild.id].capslimit; saveAutomod(data); return message.reply('capslimit off.'); }
    const c = data[message.guild.id]?.capslimit;
    return message.reply('capslimit: ' + (c ? 'on (' + c.threshold + '% caps)' : 'off'));
  }
  if (command === 'setautoroleage') {
    if (!message.guild) return message.reply('server only.');
    if (!wlOk(message.author.id)) return message.reply('only whitelisted users can use this.');
    const days = parseInt(args[0], 10);
    const data = loadAutomod();
    if (!data[message.guild.id]) data[message.guild.id] = {};
    if (!Number.isFinite(days) || days < 0) {
      delete data[message.guild.id].autoroleAge;
      saveAutomod(data);
      return message.reply('autorole age requirement removed.');
    }
    data[message.guild.id].autoroleAge = days;
    saveAutomod(data);
    return message.reply('autorole now requires accounts to be ' + days + '+ days old.');
  }



  // prefix → slash bridge: any prefix command not handled above falls
  // through here. we re dispatch as a slash command so every slash only
  // command also works as a prefix command.
  try {
    if (SLASH_ONLY_COMMANDS.has(command) || command === 'whitelist') {
      const fakeInt = buildFakeInteractionFromMessage(message, command, args);
      if (fakeInt) await dispatchSlash(fakeInt);
    }
  } catch (err) {
    try { await message.reply(`error: ${err.message}`); } catch {}
  }
}

  // ─── round 3 listeners: voice stats, reaction roles, log channels ──────
  client.on('voiceStateUpdate', async (oldS, newS) => {
    try {
      const guildId = (newS.guild || oldS.guild).id;
      const userId  = (newS.member?.id) || (oldS.member?.id);
      if (!userId) return;
      const k = guildId + ':' + userId;
      // joined or moved into a channel
      if (!oldS.channelId && newS.channelId) {
        voiceJoinTimes.set(k, Date.now());
      }
      // left a channel — accumulate stats
      if (oldS.channelId && !newS.channelId) {
        const start = voiceJoinTimes.get(k);
        voiceJoinTimes.delete(k);
        if (start) {
          const secs = Math.round((Date.now() - start) / 1000);
          const stats = loadStats();
          if (!stats[guildId]) stats[guildId] = { msgs: {}, voice: {} };
          if (!stats[guildId].voice) stats[guildId].voice = {};
          stats[guildId].voice[userId] = (stats[guildId].voice[userId] || 0) + secs;
          saveStats(stats);
        }
      }
      // voice log
      const vlog = loadLogChannels()[guildId]?.voice;
      if (vlog) {
        const ch = (newS.guild || oldS.guild).channels.cache.get(vlog);
        if (ch?.isTextBased()) {
          const tag = newS.member?.user?.tag || oldS.member?.user?.tag || userId;
          if (!oldS.channelId && newS.channelId) await ch.send(tag + ' joined voice ' + (newS.channel?.name || newS.channelId));
          else if (oldS.channelId && !newS.channelId) await ch.send(tag + ' left voice ' + (oldS.channel?.name || oldS.channelId));
          else if (oldS.channelId !== newS.channelId) await ch.send(tag + ' moved voice from ' + (oldS.channel?.name || oldS.channelId) + ' to ' + (newS.channel?.name || newS.channelId));
        }
      }
    } catch {}
  });

  // shared helper: figure out which role (if any) a reaction maps to.
  // returns { guild, member, role } or null if nothing should happen.
  async function resolveReactionRole(reaction, user) {
    if (user.bot) return null;
    if (reaction.partial) {
      try { await reaction.fetch(); }
      catch (err) { console.error('[rr] failed to fetch partial reaction:', err.message); return null; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); }
      catch (err) { console.error('[rr] failed to fetch partial message:', err.message); return null; }
    }
    const guild = reaction.message.guild;
    if (!guild) return null;
    const rrAll = loadReactionRoles();
    const entry = rrAll[reaction.message.id];
    if (!entry) return null;
    // map can be stored under .map (new) or directly on the entry (old layout).
    // also accept storage by emoji id, full <:name:id> form, or unicode name.
    const map = entry.map || entry;
    const emoji = reaction.emoji;
    const candidates = [
      emoji.id,
      emoji.name,
      emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : null,
    ].filter(Boolean);
    let roleId = null;
    for (const k of candidates) {
      if (typeof map[k] === 'string') { roleId = map[k]; break; }
    }
    if (!roleId) return null;
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      console.error(`[rr] role ${roleId} no longer exists in guild ${guild.id}`);
      return null;
    }
    const member = await guild.members.fetch(user.id).catch(err => {
      console.error('[rr] failed to fetch member:', err.message);
      return null;
    });
    if (!member) return null;
    return { guild, member, role, user };
  }

  // dm the reactor when we know exactly why a role couldn't be granted —
  // way easier to debug than silent failures in the bot console.
  async function notifyReactionRoleFailure(user, guild, role, reason) {
    try {
      await user.send(
        `couldn't give you the **${role.name}** role in **${guild.name}** — ${reason}.\n` +
        `ask a server admin to fix this (the bot probably needs Manage Roles, ` +
        `or its highest role needs to sit above **${role.name}**).`
      );
    } catch {}
  }

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      const ctx = await resolveReactionRole(reaction, user);
      if (!ctx) return;
      const { guild, member, role } = ctx;
      // already has it — nothing to do
      if (member.roles.cache.has(role.id)) return;
      // pre-flight checks so we can give the user a real reason instead of failing silently
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      if (!me) {
        console.error('[rr] could not resolve bot member in guild', guild.id);
        return;
      }
      if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        console.error('[rr] missing Manage Roles permission in guild', guild.id);
        await notifyReactionRoleFailure(user, guild, role, 'i am missing the **Manage Roles** permission');
        return;
      }
      if (role.managed) {
        console.error(`[rr] role ${role.id} is managed (bot/integration role) — cannot assign`);
        await notifyReactionRoleFailure(user, guild, role, 'that role is managed by an integration and cannot be given out');
        return;
      }
      if (role.comparePositionTo(me.roles.highest) >= 0) {
        console.error(`[rr] role ${role.id} (${role.name}) is at or above bot's highest role`);
        await notifyReactionRoleFailure(user, guild, role, 'that role sits above my highest role in the role list');
        return;
      }
      try {
        await member.roles.add(role.id, 'reaction role');
      } catch (err) {
        console.error('[rr] add role failed:', err.message);
        await notifyReactionRoleFailure(user, guild, role, `discord refused: ${err.message}`);
      }
    } catch (err) { console.error('[rr] reactionAdd error:', err.message); }
  });

  client.on('messageReactionRemove', async (reaction, user) => {
    try {
      const ctx = await resolveReactionRole(reaction, user);
      if (!ctx) return;
      const { guild, member, role } = ctx;
      if (!member.roles.cache.has(role.id)) return;
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
      if (role.managed || role.comparePositionTo(me.roles.highest) >= 0) return;
      try {
        await member.roles.remove(role.id, 'reaction role removed');
      } catch (err) {
        console.error('[rr] remove role failed:', err.message);
      }
    } catch (err) { console.error('[rr] reactionRemove error:', err.message); }
  });

  client.on('guildMemberAdd', async member => {
    try {
      const ch = loadLogChannels()[member.guild.id]?.join;
      if (!ch) return;
      const lc = member.guild.channels.cache.get(ch);
      if (lc?.isTextBased()) await lc.send(member.user.tag + ' joined the server (id ' + member.id + ')');
    } catch {}
  });

  client.on('guildMemberRemove', async member => {
    try {
      const ch = loadLogChannels()[member.guild.id]?.leave;
      if (!ch) return;
      const lc = member.guild.channels.cache.get(ch);
      if (lc?.isTextBased()) await lc.send(member.user.tag + ' left the server (id ' + member.id + ')');
    } catch {}
  });

  client.on('messageDelete', async message => {
    try {
      if (!message.guild || message.author?.bot) return;
      const ch = loadLogChannels()[message.guild.id]?.msg;
      if (!ch) return;
      const lc = message.guild.channels.cache.get(ch);
      if (lc?.isTextBased()) {
        const txt = (message.content || '(no text)').slice(0, 1500);
        await lc.send('msg deleted in <#' + message.channel.id + '> by ' + (message.author?.tag || 'unknown') + ': ' + txt);
      }
    } catch {}
  });

  client.on('messageUpdate', async (oldM, newM) => {
    try {
      if (!newM.guild || newM.author?.bot) return;
      if (oldM.content === newM.content) return;
      const ch = loadLogChannels()[newM.guild.id]?.msg;
      if (!ch) return;
      const lc = newM.guild.channels.cache.get(ch);
      if (lc?.isTextBased()) {
        const oldT = (oldM.content || '(empty)').slice(0, 700);
        const newT = (newM.content || '(empty)').slice(0, 700);
        await lc.send('msg edited in <#' + newM.channel.id + '> by ' + (newM.author?.tag || 'unknown') + '\nbefore: ' + oldT + '\nafter: ' + newT);
      }
    } catch {}
  });
  
client.on('messageCreate', dispatchPrefix);



// survive transient errors so the bot doesn't crash mid write and lose data.
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason); });

// graceful shutdown: try to log out cleanly so any in flight writes finish.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down...`);
  try { await client.destroy(); } catch {}
  // close the postgres pool so pending queries can drain
  if (dbPool) { try { await dbPool.end(); } catch {} }
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// startup: prepare the postgres schema BEFORE we attempt to log in. this means
// (a) any module-level dbsave calls during init have their tables ready, and
// (b) the schema is built even when the bot can't reach discord (e.g. when
// DISCORD_TOKEN is unset / invalid), so the next valid token brings up a fully
// configured bot with no first-run errors.
;(async () => {
  if (dbPool) {
    try {
      await initDbSchema();
    } catch (err) {
      console.error('[pg] startup schema init failed:', err.message);
    }
  }

  const token = (process.env.DISCORD_TOKEN || '').trim();
  if (!token) {
    console.error('───────────────────────────────────────────────────────────');
    console.error(' DISCORD_TOKEN is not set.');
    console.error(' add it as a secret in the Replit "Secrets" tab and');
    console.error(' restart the "Discord Bot" workflow to bring the bot online.');
    console.error(' (the postgres schema has been prepared so the bot will');
    console.error('  come up cleanly the moment a valid token is provided.)');
    console.error('───────────────────────────────────────────────────────────');
    // keep the process alive so the workflow stays in "running" state.
    // restarting the workflow after adding the token will re-run this whole
    // module and pick up the new env value.
    setInterval(() => {}, 60_000);
    return;
  }
  try {
    await client.login(token);
  } catch (err) {
    console.error('[discord] login failed:', err.message);
  }
})();
