/* ═══════════════════════════════════════════════════════════════════════════
   MiniGames — application
   ───────────────────────────────────────────────────────────────────────────
   Adding a league: drop configs/<slug>.json in, add a line to configs/index.json.
   No code changes. Games, payouts, rules and deadlines all live in the config.

   URLs are hash-routed:  #/<league>/<page>[/<arg>]
     #/dynasty                 overview
     #/dynasty/tactician       a game page
     #/dynasty/history         history
     #/dynasty/report/7        weekly report, week 7
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const API = 'https://api.sleeper.app/v1';
const $ = id => document.getElementById(id);

/* Config-derived globals, populated by applyConfig() before the app boots. */
let LEAGUE_CONFIG = null, LEAGUES_INDEX = [];
let SLUG, LIVE_ID, TEST_ID, STORE, SEASON_IDS, SHEETS, SHEETS_API;
let NAME_ALIASES, WEEK1_DATE, TYREEK_RECORD, DEADLINES, GAMES = [];

/* Runtime state */
let rosters = [], users = [], matchups = {}, transactions = {}, players = {};
let sheets = { tactician: [], long_game: [], sleeper_picks: [], turducken: [], meta: {} };
let isTest = false;
let saved = {};          // re-read in applyConfig once STORE exists
let histData = {};
window._standings = {};

const VALID_COLORS = ['green','gold','red','blue','purple','orange','teal'];

/* ── ROUTER ──────────────────────────────────────────────────────────────── */

function parseHash(){
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { slug: parts[0] || null, page: parts[1] || 'overview', arg: parts[2] || null };
}

/* Navigate. Only ever sets the hash — rendering happens in renderRoute via
   the hashchange listener, so there is exactly one code path into a page. */
function go(page, arg){
  const next = '#/' + SLUG + '/' + page + (arg != null ? '/' + arg : '');
  if(location.hash === next) renderRoute();   // hashchange won't fire; render directly
  else location.hash = next;
}

function currentPageId(){
  const { page } = parseHash();
  if(page === 'overview' || page === 'history' || page === 'report') return 'page-' + page;
  if(GAMES.some(g => g.id === page)) return 'page-game-' + page;
  return 'page-overview';
}

function renderRoute(){
  const { slug, page, arg } = parseHash();

  // Switching leagues via URL: reload so every module re-inits from scratch.
  if(slug && SLUG && slug.toLowerCase() !== SLUG){
    try { localStorage.setItem('mg_last_league', slug.toLowerCase()); } catch(e){}
    location.reload();
    return;
  }

  const id = currentPageId();
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === id));

  const game = GAMES.find(g => g.id === page);

  // Desktop nav state
  setNavCurrent($('navOverview'), page === 'overview');
  setNavCurrent($('navHistory'),  page === 'history');
  setNavCurrent($('navReport'),   page === 'report');
  setNavCurrent($('navGamesBtn'), !!game);
  document.querySelectorAll('.nav-dropdown-item').forEach(b =>
    b.setAttribute('aria-current', String(b.dataset.game === page)));

  // Mobile tab state
  setNavCurrent($('tabOverview'), page === 'overview');
  setNavCurrent($('tabGames'),    !!game);
  setNavCurrent($('tabHistory'),  page === 'history');
  setNavCurrent($('tabReport'),   page === 'report');

  // Game rail — visible only on a game page
  const rail = $('gameRail');
  if(rail){
    rail.hidden = !game;
    rail.querySelectorAll('.rail-item').forEach(b =>
      b.setAttribute('aria-current', String(b.dataset.game === page)));
  }

  document.title = (game ? game.name + ' · ' : page === 'history' ? 'History · ' : page === 'report' ? 'Weekly Report · ' : '')
    + (LEAGUE_CONFIG ? LEAGUE_CONFIG.leagueName : 'MiniGames') + ' · ' + (LEAGUE_CONFIG ? LEAGUE_CONFIG.season : '');

  // Lazy loads
  if(page === 'history' && !Object.keys(histData).length) loadHistory();
  if(page === 'report') buildReport(arg);

  closeAllMenus();
  window.scrollTo(0, 0);
}

function setNavCurrent(el, on){
  if(!el) return;
  if(el.classList.contains('nav-tab')){
    if(on) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  } else {
    el.setAttribute('aria-current', String(!!on));
  }
}

window.addEventListener('hashchange', renderRoute);

/* ── CONFIG BOOTSTRAP ────────────────────────────────────────────────────── */

function normalizeGame(g, i){
  const color = VALID_COLORS.includes(g.color) ? g.color : VALID_COLORS[i % VALID_COLORS.length];
  return {
    // Spread first so any config field a builder needs survives normalization.
    // (decidedWeek and teaserFacts were both silently dropped before this.)
    ...g,
    id: g.id,
    name: g.name || g.id,
    builder: g.builder || null,
    color,
    cls: 'g-' + color,
    payout: Number(g.payout) || 0,
    payoutLabel: '$' + (Number(g.payout) || 0),
    typeLabel: g.typeLabel || '',
    weeks: g.weeks || '',
    activeWeeks: Array.isArray(g.activeWeeks) ? g.activeWeeks : [],
    decidedWeek: Number(g.decidedWeek) || null,
    blurb: g.blurb || g.desc || '',
    desc: g.desc || g.blurb || '',
    highlight: g.highlight || '',
    emptyHint: g.emptyHint || 'No data yet.',
    rules: Array.isArray(g.rules) ? g.rules : []
  };
}

function applyConfig(cfg){
  LEAGUE_CONFIG = cfg;
  SLUG        = cfg.slug;
  LIVE_ID     = cfg.liveId;
  TEST_ID     = cfg.testId || cfg.liveId;
  STORE       = cfg.storeKey || 'minigames_' + (cfg.slug || 'default');
  SEASON_IDS  = cfg.seasons || [];
  SHEETS      = cfg.sheets || {};
  SHEETS_API  = cfg.sheetsApi || '';
  NAME_ALIASES = cfg.nameAliases || {};
  WEEK1_DATE  = new Date(cfg.week1Date || '2026-09-04');
  TYREEK_RECORD = cfg.tyreekRecord || 64.9;
  DEADLINES   = cfg.deadlines || [];
  GAMES       = (cfg.games || []).map(normalizeGame);

  // Read the saved store HERE — not at parse time, when STORE is still undefined.
  // (That bug is why the team picker used to reappear on every visit.)
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); }
  catch(e){ saved = {}; }

  const ln = $('leagueName');
  if(ln) ln.textContent = cfg.leagueName || 'League';
  const hs = $('headerSeason');
  if(hs) hs.textContent = '· ' + (cfg.season || '');
  document.title = (cfg.leagueName || 'MiniGames') + ' · ' + (cfg.season || '');
}

async function fetchJSON(url){
  const r = await fetch(url, { cache: 'no-cache' });
  if(!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

/* Resolve which league to show. Never blocks on a choice — falls through to
   the first configured league so a first-time visitor lands on content. */
function resolveSlug(index){
  const fromHash = parseHash().slug;
  if(fromHash && index.some(e => e.slug === fromHash.toLowerCase())) return fromHash.toLowerCase();

  const legacy = new URLSearchParams(location.search).get('league');
  if(legacy && index.some(e => e.slug === legacy.toLowerCase())) return legacy.toLowerCase();

  let remembered = null;
  try { remembered = localStorage.getItem('mg_last_league'); } catch(e){}
  if(remembered && index.some(e => e.slug === remembered)) return remembered;

  return index[0].slug;
}

async function bootstrap(){
  let index;
  try {
    index = await fetchJSON('configs/index.json');
    if(!Array.isArray(index) || !index.length) throw new Error('empty index');
  } catch(err){
    console.error(err);
    return fatal(
      'Can\'t load the league list',
      'configs/index.json didn\'t load. If you\'re opening this file directly from disk, ' +
      'run a local server instead — fetch() is blocked on file:// URLs. Try: python3 -m http.server'
    );
  }

  LEAGUES_INDEX = index;
  const slug = resolveSlug(index);
  const entry = index.find(e => e.slug === slug);

  try {
    const cfg = await fetchJSON(entry.config);
    cfg.slug = entry.slug;
    applyConfig(cfg);
    try { localStorage.setItem('mg_last_league', entry.slug); } catch(e){}
  } catch(err){
    console.error(err);
    return fatal('Can\'t load ' + entry.name, entry.config + ' is missing or isn\'t valid JSON.');
  }

  if(!GAMES.length){
    return fatal('No games configured', 'Add a "games" array to ' + entry.config + ' — see configs/_template.json.');
  }

  // Normalize the URL so every session has a real, shareable hash.
  const h = parseHash();
  if(h.slug !== SLUG){
    history.replaceState(null, '', '#/' + SLUG + (h.slug ? '/' + h.page + (h.arg ? '/' + h.arg : '') : ''));
  }

  startApp();
}

function fatal(title, msg){
  const st = $('splashStatus'), br = document.querySelector('.splash-brand'),
        tg = document.querySelector('.splash-tagline'), dots = document.querySelector('.splash-dots');
  if(dots) dots.style.display = 'none';
  if(tg) tg.textContent = title;
  if(st) st.textContent = msg;
  if(br) br.textContent = '⚠️';
  const a = $('splashActions');
  if(a) a.innerHTML = '<button class="btn btn-primary" onclick="location.reload()">Try again</button>';
}

function splashStatus(txt){ const el = $('splashStatus'); if(el) el.textContent = txt; }
function hideSplash(){
  const el = $('splashOverlay');
  if(!el || el.classList.contains('hide')) return;
  el.classList.add('hide');
  setTimeout(() => { el.style.display = 'none'; }, 400);
}

/* ── HELPERS ─────────────────────────────────────────────────────────────── */

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function setStatus(state, txt){
  const dot = $('sDot'), el = $('sTxt');
  if(dot) dot.className = 'sdot ' + state;
  if(el) el.textContent = txt;
  const bar = $('loadBar');
  if(bar) bar.classList.toggle('on', state === 'loading');
}
function setUpdated(){
  const el = $('lastUpdated');
  if(!el) return;
  el.textContent = '· Updated ' + new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  el.style.display = 'inline';
}

async function fetchWithTimeout(url, ms = 8000, opts = {}){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function slGet(path){
  const r = await fetchWithTimeout(API + path, 8000);
  if(!r.ok) throw new Error(r.status);
  return r.json();
}
async function csvGet(url){
  if(!url) return [];
  try {
    const r = await fetch(url);
    if(!r.ok) return [];
    const txt = await r.text();
    const lines = txt.trim().split('\n');
    if(lines.length < 2) return [];
    const parseLine = line => {
      const out = []; let cur = '', inQ = false;
      for(let i = 0; i < line.length; i++){
        const c = line[i];
        if(c === '"') inQ = !inQ;
        else if(c === ',' && !inQ){ out.push(cur.trim()); cur = ''; }
        else cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/^"|"$/g,'').trim());
    return lines.slice(1).map(line => {
      const vals = parseLine(line).map(v => v.replace(/^"|"$/g,'').trim());
      const obj = {};
      headers.forEach((h,i) => obj[h] = vals[i] || '');
      return obj;
    }).filter(o => Object.values(o).some(v => v !== ''));
  } catch(e){ console.warn('csvGet failed:', e); return []; }
}

function weekDate(w){
  const d = new Date(WEEK1_DATE);
  d.setDate(d.getDate() + (w - 1) * 7);
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function tName(roster){
  const u = users.find(u => u.user_id === roster.owner_id) || {};
  return (u.metadata && u.metadata.team_name && u.metadata.team_name.trim()) || u.display_name || `Team ${roster.roster_id}`;
}
function dName(roster){
  const u = users.find(u => u.user_id === roster.owner_id) || {};
  return u.display_name || '';
}
function avatarUrl(roster){
  const u = users.find(u => u.user_id === roster.owner_id) || {};
  if(u.metadata && u.metadata.avatar && u.metadata.avatar.startsWith('http')) return u.metadata.avatar;
  if(u.avatar) return `https://sleepercdn.com/avatars/thumbs/${u.avatar}`;
  return null;
}
function pName(pid){
  if(!pid || !players[pid]) return pid || '?';
  const p = players[pid];
  return `${p.first_name || ''} ${p.last_name || ''}`.trim() || pid;
}
function initials(name){
  return String(name || '?').trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase() || '?';
}
function myPts(rid, w){ const e = (matchups[w] || []).find(m => m.roster_id === rid); return e ? e.points : null; }
function oppPts(rid, w){
  const e = (matchups[w] || []).find(m => m.roster_id === rid);
  if(!e) return null;
  const o = (matchups[w] || []).find(m => m.matchup_id === e.matchup_id && m.roster_id !== rid);
  return o ? o.points : null;
}
function heistElig(rid){
  const s = new Set();
  [1,2,3,4].forEach(w => (transactions[w] || []).forEach(tx => {
    if(tx.adds) Object.entries(tx.adds).forEach(([pid, r]) => { if(r === rid) s.add(pid); });
  }));
  return [...s];
}
function saveStore(){ try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch(e){} }
function capSt(gameId, arr){ window._standings[gameId] = arr; }

function myTeamId(){ return (saved.myTeam && saved.myTeam.user_id) || null; }
function myRoster(){ const uid = myTeamId(); return uid ? rosters.find(r => r.owner_id === uid) : null; }

function avHtml(url, cls, phCls, fallback){
  return url
    ? `<img src="${esc(url)}" class="${cls}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${phCls}',textContent:'${fallback||'🏈'}'}))">`
    : `<div class="${phCls}">${fallback || '🏈'}</div>`;
}

function teamCell(roster, rankNum = null){
  const tn = tName(roster), dn = dName(roster);
  const showSub = dn && dn !== tn;
  return `
    ${rankNum !== null ? `<td class="rank-num">${rankNum}</td>` : ''}
    <td><div class="team-cell">${avHtml(avatarUrl(roster), 'av large', 'av-placeholder')}<div><div class="team-name">${esc(tn)}${roster.owner_id === myTeamId() ? '<span class="me-flag">YOU</span>' : ''}</div>${showSub ? `<div class="team-display">${esc(dn)}</div>` : ''}</div></div></td>`;
}

/* Prefix a header with '>' to right-align that column. */
function mkTable(headers){
  const t = document.createElement('table');
  t.className = 't';
  const ths = headers.map(h => {
    const right = h.startsWith('>');
    return `<th scope="col" class="${right ? 'th-r' : ''}">${esc(right ? h.slice(1) : h)}</th>`;
  }).join('');
  t.innerHTML = `<thead><tr>${ths}</tr></thead><tbody></tbody>`;
  return t;
}
function emptyCard(game, icon){
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-head"><div><div class="card-title" style="color:var(--g)">${esc(game.name)}</div>
    <div class="card-sub">${esc(game.weeks)} · ${game.payoutLabel}</div></div></div>
    <div class="card-empty"><div class="icon">${icon || '📊'}</div>${esc(game.emptyHint)}</div>`;
  return card;
}

/* ── DATA LOADING ────────────────────────────────────────────────────────── */

async function loadLeague(lid){
  const [league, ros, usr] = await Promise.all([
    slGet(`/league/${lid}`), slGet(`/league/${lid}/rosters`), slGet(`/league/${lid}/users`)
  ]);
  rosters = ros; users = usr;
  if(league.avatar){
    const url = `https://sleepercdn.com/avatars/thumbs/${league.avatar}`;
    const wrap = $('leagueAvatarWrap');
    if(wrap) wrap.innerHTML = avHtml(url, 'league-avatar', 'league-avatar-placeholder');
  }
  const ln = $('leagueName');
  if(ln && league.name) ln.textContent = league.name;
  return league;
}
async function loadMatchups(lid){
  setStatus('loading', 'Loading matchups…');
  const wks = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17];
  const res = await Promise.all(wks.map(w => slGet(`/league/${lid}/matchups/${w}`).catch(() => [])));
  wks.forEach((w,i) => matchups[w] = res[i] || []);
}
async function loadTx(lid){
  setStatus('loading', 'Loading transactions…');
  const res = await Promise.all([1,2,3,4].map(w => slGet(`/league/${lid}/transactions/${w}`).catch(() => [])));
  [1,2,3,4].forEach((w,i) => transactions[w] = res[i] || []);
}

function collectPlayerIds(){
  const ids = new Set();
  rosters.forEach(r => {
    (r.players || []).forEach(id => ids.add(id));
    (r.taxi || []).forEach(id => ids.add(id));
    (r.reserve || []).forEach(id => ids.add(id));
  });
  Object.values(matchups).forEach(wk => (wk || []).forEach(m => {
    (m.starters || []).forEach(id => ids.add(id));
    if(m.players_points) Object.keys(m.players_points).forEach(id => ids.add(id));
  }));
  ids.delete('0');
  return ids;
}

const PLAYER_CACHE_KEY = 'mg_players_v1';
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000;

function loadPlayersFromCache(){
  try {
    const raw = localStorage.getItem(PLAYER_CACHE_KEY);
    if(!raw) return null;
    const { t, data } = JSON.parse(raw);
    return (Date.now() - t > PLAYER_CACHE_TTL) ? null : data;
  } catch(e){ return null; }
}
function savePlayersToCache(min){
  try { localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ t: Date.now(), data: min })); } catch(e){}
}

async function loadPlayers(){
  setStatus('loading', 'Loading player names…');
  const ids = collectPlayerIds();
  if(!ids.size){ players = {}; return; }

  const cached = loadPlayersFromCache();
  if(cached){
    players = {};
    ids.forEach(id => { if(cached[id]) players[id] = cached[id]; });
    if([...ids].every(id => players[id])) return;
  }

  try {
    const r = await fetchWithTimeout(`${API}/players/nfl`, 20000);
    if(!r.ok) return;
    const all = await r.json();
    const min = {};
    Object.keys(all).forEach(id => {
      const p = all[id];
      if(!p) return;
      min[id] = {
        first_name: p.first_name || '', last_name: p.last_name || '',
        full_name: p.full_name || '', position: p.position || '', team: p.team || ''
      };
    });
    savePlayersToCache(min);
    players = {};
    ids.forEach(id => { if(min[id]) players[id] = min[id]; });
  } catch(e){
    console.warn('players fetch failed — continuing without names', e);
    players = players || {};
  }
}

async function loadSheets(){
  setStatus('loading', 'Loading sheet data…');

  // Preferred: one Apps Script web app call returning every tab.
  if(SHEETS_API){
    try {
      // Cold starts run a few seconds; the cache keeps warm calls quick.
      const r = await fetchWithTimeout(SHEETS_API, 25000);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if(!data || !data.tabs) throw new Error('unexpected payload');
      sheets.tactician     = data.tabs.tactician     || [];
      sheets.long_game     = data.tabs.long_game     || [];
      sheets.sleeper_picks = data.tabs.sleeper_picks || [];
      sheets.turducken     = data.tabs.turducken     || [];
      const mo = {};
      (data.tabs.meta || []).forEach(r2 => { if(r2.key) mo[r2.key] = r2.value; });
      sheets.meta = mo;
      return;
    } catch(e){
      console.warn('sheetsApi failed, falling back to published CSVs', e);
      if(!SHEETS || !SHEETS.tactician) throw e;
    }
  }

  // Fallback: the published CSV urls.
  const [tac, lng, slp, trd, met] = await Promise.all([
    csvGet(SHEETS.tactician), csvGet(SHEETS.long_game),
    csvGet(SHEETS.sleeper_picks), csvGet(SHEETS.turducken), csvGet(SHEETS.meta)
  ]);
  sheets.tactician = tac; sheets.long_game = lng;
  sheets.sleeper_picks = slp; sheets.turducken = trd;
  const mo = {};
  met.forEach(r => { if(r.key) mo[r.key] = r.value; });
  sheets.meta = mo;
}

async function loadLive(){
  isTest = false;
  setStatus('loading', 'Connecting to Sleeper…');
  splashStatus('Connecting to Sleeper…');
  try {
    await loadLeague(LIVE_ID);
    splashStatus('Loading matchups & sheets…');
    await Promise.all([ loadMatchups(LIVE_ID), loadTx(LIVE_ID), loadSheets() ]);
    setStatus('ok', `✓ Live · ${users.length} teams`);
    setUpdated();
    buildAll();
    // Player names load in the background — don't block the dashboard on 5MB.
    loadPlayers()
      .then(() => { try { buildAll(); } catch(e){} })
      .catch(e => console.warn('players load failed', e))
      .finally(() => { setStatus('ok', `✓ Live · ${users.length} teams`); setUpdated(); });
  } catch(e){
    console.error(e);
    setStatus('err', 'Could not connect — try refreshing');
    splashStatus('Could not reach Sleeper. Check your connection and refresh.');
    hideSplash();
  }
}

/* ── NAVIGATION ──────────────────────────────────────────────────────────── */

function closeAllMenus(){
  $('navGamesMenu')?.classList.remove('open');
  $('navGamesBtn')?.setAttribute('aria-expanded','false');
  $('leagueSwitch')?.classList.remove('open');
  $('leagueBtn')?.setAttribute('aria-expanded','false');
}

function toggleMenu(btnId, menuId){
  const btn = $(btnId), menu = $(menuId);
  if(!btn || !menu) return;
  const open = menu.classList.contains('open');
  closeAllMenus();
  if(!open){
    menu.classList.add('open');
    btn.setAttribute('aria-expanded','true');
  }
}

document.addEventListener('click', e => {
  if(e.target.closest('#navGamesDropdown') || e.target.closest('#leagueBtn') || e.target.closest('#leagueSwitch')) return;
  closeAllMenus();
});
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  closeAllMenus();
  closeGameSheet();
  closePicker();
});

function buildLeagueSwitcher(){
  const btn = $('leagueBtn'), menu = $('leagueSwitch');
  if(!btn || !menu) return;

  // One league? The header is just a header — no menu, no caret.
  if(LEAGUES_INDEX.length < 2){
    btn.classList.add('solo');
    btn.removeAttribute('aria-haspopup');
    btn.removeAttribute('aria-expanded');
    return;
  }

  menu.innerHTML = '<div class="lswitch-label">Your leagues</div>' + LEAGUES_INDEX.map(e => `
    <button class="lswitch-item" role="menuitem" data-slug="${esc(e.slug)}" aria-current="${e.slug === SLUG}">
      <span class="lswitch-name">${esc(e.name || e.slug)}</span>
      ${e.tagline ? `<span class="lswitch-tag">${esc(e.tagline)}</span>` : ''}
    </button>`).join('');

  menu.querySelectorAll('.lswitch-item').forEach(item => {
    item.onclick = () => {
      const slug = item.dataset.slug;
      closeAllMenus();
      if(slug === SLUG) return;
      try { localStorage.setItem('mg_last_league', slug); } catch(err){}
      location.hash = '#/' + slug;   // renderRoute detects the mismatch and reloads
    };
  });

  btn.onclick = () => toggleMenu('leagueBtn','leagueSwitch');
}

function buildNav(){
  // Desktop games dropdown
  const menu = $('navGamesMenu'), btn = $('navGamesBtn');
  if(menu && btn){
    btn.onclick = () => toggleMenu('navGamesBtn','navGamesMenu');
    menu.innerHTML = GAMES.map(g => `
      <button class="nav-dropdown-item ${g.cls}" role="menuitem" data-game="${esc(g.id)}" aria-current="false">
        <span>${esc(g.name)}</span><span class="nav-drop-pill">${g.payoutLabel}</span>
      </button>`).join('');
    menu.querySelectorAll('.nav-dropdown-item').forEach(b => {
      b.onclick = () => { closeAllMenus(); go(b.dataset.game); };
    });
  }

  // Game rail
  const rail = $('gameRail');
  if(rail){
    rail.innerHTML = GAMES.map(g => `
      <button class="rail-item ${g.cls}" data-game="${esc(g.id)}" aria-current="false">
        <span class="rail-dot"></span>${esc(g.name)}
      </button>`).join('');
    rail.querySelectorAll('.rail-item').forEach(b => { b.onclick = () => go(b.dataset.game); });
  }

  // Mobile game sheet
  const list = $('mobGameList');
  if(list){
    list.innerHTML = GAMES.map(g => `
      <button class="mob-game-item ${g.cls}" data-game="${esc(g.id)}">
        <span class="mob-game-dot"></span>
        <span class="mob-game-info">
          <span class="mob-game-name">${esc(g.name)}</span>
          <span class="mob-game-meta">${esc(g.typeLabel)}${g.weeks ? ' · ' + esc(g.weeks) : ''}</span>
        </span>
        <span class="mob-game-payout">${g.payoutLabel}</span>
      </button>`).join('');
    list.querySelectorAll('.mob-game-item').forEach(b => {
      b.onclick = () => { closeGameSheet(); go(b.dataset.game); };
    });
  }
}

function openGameSheet(){
  $('mobOverlay')?.classList.add('open');
  $('mobSheet')?.classList.add('open');
}
function closeGameSheet(){
  $('mobOverlay')?.classList.remove('open');
  $('mobSheet')?.classList.remove('open');
}

/* ── OVERVIEW: game cards (leaders merged in) ────────────────────────────── */

function leaderFor(gameId){
  const arr = window._standings[gameId] || [];
  const lead = arr[0];
  if(!lead) return null;
  const ros = rosters.find(r => String(r.roster_id) === String(lead.rid));
  return ros ? { ros, val: lead.val } : null;
}

function myRankIn(gameId){
  const mr = myRoster();
  if(!mr) return null;
  const arr = window._standings[gameId] || [];
  const idx = arr.findIndex(x => String(x.rid) === String(mr.roster_id));
  return idx < 0 ? null : idx + 1;
}

function buildGames(){
  const grid = $('gamesGrid');
  if(!grid) return;
  grid.innerHTML = '';

  GAMES.forEach(g => {
    const card = document.createElement('div');
    card.className = 'game-card ' + g.cls;

    const lead = leaderFor(g.id);
    const rank = myRankIn(g.id);

    const leaderHtml = lead ? `
      <div class="game-leader">
        ${avHtml(avatarUrl(lead.ros), 'game-leader-av', 'game-leader-ph')}
        <div class="game-leader-info">
          <div class="game-leader-label">Leading</div>
          <div class="game-leader-name">${esc(tName(lead.ros))}${lead.ros.owner_id === myTeamId() ? '<span class="me-flag">YOU</span>' : ''}</div>
        </div>
        <div class="game-leader-val">${esc(lead.val)}</div>
      </div>`
      : `<div class="game-leader pending">
           <div class="game-leader-ph">⏳</div>
           <div class="game-leader-info">
             <div class="game-leader-label">Leading</div>
             <div class="game-leader-name">Nothing to score yet</div>
           </div>
           <div class="game-leader-val">—</div>
         </div>`;

    const rankHtml = rank
      ? `<span class="game-myrank">You: <strong>#${rank}</strong></span>`
      : '';

    card.innerHTML = `
      <button class="game-card-open" data-game="${esc(g.id)}">
        <span class="game-pill">${esc(g.typeLabel)}</span>
        <span class="game-title">${esc(g.name)}</span>
        <span class="game-weeks">${esc(g.weeks)}</span>
        <span class="game-desc">${esc(g.blurb)}</span>
      </button>
      ${leaderHtml}
      <div class="game-footer">
        <div><span class="game-payout">${g.payoutLabel}</span>${rankHtml}</div>
        <button class="expand-btn" data-rules="gr_${esc(g.id)}" aria-expanded="false">Rules ↓</button>
      </div>
      <div class="game-rules" id="gr_${esc(g.id)}">
        ${g.highlight ? `<div class="rules-highlight">${esc(g.highlight)}</div>` : ''}
        <ul class="rules-list">${g.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>`;

    card.querySelector('.game-card-open').onclick = () => go(g.id);
    card.querySelector('.expand-btn').onclick = e => toggleRules(e.currentTarget);
    grid.appendChild(card);
  });

  const pot = GAMES.reduce((a, g) => a + g.payout, 0);
  const note = $('potNote');
  if(note) note.textContent = `${GAMES.length} games · $${pot} on the line`;
}

function toggleRules(btn){
  const el = $(btn.dataset.rules);
  if(!el) return;
  const open = el.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Rules ↑' : 'Rules ↓';
}


/* ── TRAILER ─────────────────────────────────────────────────────────────────
   Config-driven, per league. Renders nothing when the league has no trailer.
   Shows big once, then collapses to a slim link so it never gets in the way
   of the standings on repeat visits. */
function buildTrailer(){
  const wrap = $('trailerSlot');
  if(!wrap) return;
  const t = LEAGUE_CONFIG && LEAGUE_CONFIG.trailer;
  if(!t || !t.src){ wrap.innerHTML = ''; return; }

  const seen = !!saved.trailerSeen;
  const isEmbed = /youtube|youtu\.be|vimeo|player\./i.test(t.src);

  if(seen){
    wrap.innerHTML = `<button class="trailer-mini" onclick="openTrailer()">
      <span class="trailer-mini-icon" aria-hidden="true">▶</span>
      <span>${esc(t.miniLabel || 'Watch the trailer')}</span></button>`;
    return;
  }

  wrap.innerHTML = `<div class="trailer" id="trailerBox">
    <button class="trailer-poster" onclick="openTrailer()" aria-label="Play the trailer">
      ${t.poster ? `<img src="${esc(t.poster)}" alt="">` : '<span class="trailer-fallback"></span>'}
      <span class="trailer-play" aria-hidden="true">▶</span>
      ${t.caption ? `<span class="trailer-caption">${esc(t.caption)}</span>` : ''}
    </button>
    <button class="trailer-skip" onclick="dismissTrailer()">Skip</button>
  </div>`;
  wrap.dataset.embed = String(isEmbed);
}

function openTrailer(){
  const t = LEAGUE_CONFIG && LEAGUE_CONFIG.trailer;
  const wrap = $('trailerSlot');
  if(!t || !wrap) return;
  const isEmbed = /youtube|youtu\.be|vimeo|player\./i.test(t.src);

  wrap.innerHTML = `<div class="trailer playing">
    ${isEmbed
      ? `<iframe src="${esc(t.src)}${t.src.includes('?') ? '&' : '?'}autoplay=1" title="${esc(t.title || 'League trailer')}"
           allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`
      : `<video src="${esc(t.src)}" ${t.poster ? `poster="${esc(t.poster)}"` : ''}
           controls autoplay playsinline preload="metadata"></video>`}
    <button class="trailer-skip" onclick="dismissTrailer()">Close</button>
  </div>`;
  markTrailerSeen();
}

function markTrailerSeen(){
  if(saved.trailerSeen) return;
  saved.trailerSeen = true;
  saveStore();
}

function dismissTrailer(){
  markTrailerSeen();
  buildTrailer();
}

/* ── OVERVIEW: my team strip ─────────────────────────────────────────────── */

function buildMyStrip(){
  const wrap = $('myStrip');
  if(!wrap) return;
  const mr = myRoster();

  if(!mr){
    wrap.innerHTML = rosters.length
      ? `<button class="my-prompt" onclick="openPicker()">👋 Pick your team to see your standings<span>tap here</span></button>`
      : '';
    return;
  }

  const chips = GAMES.map(g => {
    const rank = myRankIn(g.id);
    if(!rank) return `<button class="my-chip empty" onclick="go('${g.id}')">${esc(g.name)} <span class="rank rank-mid">—</span></button>`;
    const cls = rank === 1 ? 'rank-1' : rank <= 3 ? 'rank-good' : rank <= 7 ? 'rank-mid' : 'rank-low';
    return `<button class="my-chip" onclick="go('${g.id}')">${esc(g.name)} <span class="rank ${cls}">${rank === 1 ? '👑 ' : ''}#${rank}</span></button>`;
  }).join('');

  wrap.innerHTML = `<div class="my-strip">
    <div class="my-strip-head">
      <div class="my-strip-title">
        ${avatarUrl(mr) ? `<img src="${esc(avatarUrl(mr))}" class="my-strip-av" alt="">` : ''}
        ${esc(tName(mr))} — Your Season
      </div>
      <button class="my-strip-change" onclick="openPicker()">change team</button>
    </div>
    <div class="my-strip-chips">${chips}</div>
  </div>`;
}

/* ── OVERVIEW: countdowns ────────────────────────────────────────────────── */

function fmtCountdown(ms){
  if(ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if(d >= 2) return `${d}d ${h}h`;
  if(d >= 1) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m ${String(sec).padStart(2,'0')}s`;
}

function buildCountdowns(){
  const wrap = $('countdownStrip');
  if(!wrap) return;
  if(!DEADLINES || !DEADLINES.length){ wrap.innerHTML = ''; return; }

  const now = Date.now();
  const show = DEADLINES.filter(d => now - new Date(d.date).getTime() < 14 * 86400 * 1000);
  if(!show.length){ wrap.innerHTML = ''; return; }

  wrap.innerHTML = `<div class="countdown-strip">${show.map(d => {
    const g = GAMES.find(x => x.id === d.gameId);
    const dt = new Date(d.date);
    const dateStr = dt.toLocaleDateString('en-US', { month:'short', day:'numeric' })
      + ' · ' + dt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    return `<button class="cd-card ${g ? g.cls : ''}" onclick="go('${esc(d.gameId)}')">
      <span><span class="cd-label">${esc(d.label)}</span><span class="cd-sub">${esc(dateStr)}</span></span>
      <span class="cd-time" data-deadline="${esc(d.date)}">—</span>
    </button>`;
  }).join('')}</div>`;
  tickCountdowns();
}

function tickCountdowns(){
  document.querySelectorAll('[data-deadline]').forEach(el => {
    const f = fmtCountdown(new Date(el.dataset.deadline).getTime() - Date.now());
    if(f){ el.textContent = f; el.classList.remove('cd-locked'); }
    else { el.textContent = 'Locked ✓'; el.classList.add('cd-locked'); }
  });
}
setInterval(tickCountdowns, 1000);

/* ── OVERVIEW: calendar ──────────────────────────────────────────────────── */

function buildCalendar(){
  const grid = $('calGrid'), legend = $('calLegend');
  if(!grid) return;

  // Span whatever the games actually claim — don't hardcode the regular season,
  // or games running through the playoffs look like they stop at W14.
  const totalWeeks = Math.max(14, ...GAMES.map(g => Math.max(0, ...g.activeWeeks)));
  const REG_WEEKS = 14;

  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `140px repeat(${totalWeeks},1fr) 56px`;
  grid.style.minWidth = (140 + totalWeeks * 40 + 56) + 'px';

  grid.appendChild(Object.assign(document.createElement('div'), { className: 'cal-head' }));
  for(let w = 1; w <= totalWeeks; w++){
    const h = document.createElement('div');
    h.className = 'cal-head' + (w > REG_WEEKS ? ' cal-head-po' : '');
    h.innerHTML = `<div class="wnum">W${w}${w === 12 ? ' <span style="color:var(--gold);">★</span>' : ''}</div>`
      + `<div class="wdate">${w > REG_WEEKS ? 'playoffs' : weekDate(w)}</div>`;
    grid.appendChild(h);
  }
  const prizeHead = document.createElement('div');
  prizeHead.className = 'cal-head';
  prizeHead.innerHTML = '<div class="wnum">Prize</div>';
  grid.appendChild(prizeHead);

  GAMES.forEach(g => {
    const label = document.createElement('div');
    label.className = 'cal-label ' + g.cls;
    label.innerHTML = `<span style="color:var(--g);">${esc(g.name)}</span>`;
    grid.appendChild(label);

    for(let w = 1; w <= totalWeeks; w++){
      const cell = document.createElement('div');
      const on = g.activeWeeks.includes(w);
      const decided = g.decidedWeek === w;
      cell.className = 'cal-cell ' + g.cls + (on ? ' on' : ' off')
        + (decided ? ' cal-decided' : '') + (w > REG_WEEKS ? ' cal-po' : '');
      if(decided) cell.innerHTML = '<span class="cal-crown" aria-hidden="true">👑</span>';
      cell.title = decided
        ? `${g.name} — winner decided in Week ${w}`
        : `${g.name} — Week ${w}${on ? ' (active)' : ''}`;
      grid.appendChild(cell);
    }

    const prize = document.createElement('div');
    prize.className = 'cal-label ' + g.cls;
    prize.style.justifyContent = 'center';
    prize.innerHTML = `<span style="color:var(--g);font-family:var(--mono);font-size:12px;">${g.payoutLabel}</span>`;
    grid.appendChild(prize);
  });

  if(legend){
    legend.innerHTML = GAMES.map(g =>
      `<span class="cal-leg-item ${g.cls}"><span class="cal-leg-dot"></span>${esc(g.name)} ${g.payoutLabel}</span>`
    ).join('')
    + '<span class="cal-leg-item"><span style="font-size:12px;">👑</span>winner decided</span>';
  }
}

/* ── GAME PAGES ──────────────────────────────────────────────────────────── */

const BUILDERS = {
  longgame:  buildLongGame,
  tactician: buildTactician,
  cardiac:   buildCardiac,
  sleeper:   buildSleeperGame,
  comeback:  buildComeback,
  comingsoon: buildComingSoon,
  topscore:   buildTopScore
};

function buildGamePages(){
  const container = $('gamePages');
  if(!container) return;
  container.innerHTML = '';

  GAMES.forEach(g => {
    const page = document.createElement('div');
    page.className = 'page ' + g.cls;
    page.id = 'page-game-' + g.id;

    // Compact header — the standings table stays above the fold.
    const head = document.createElement('div');
    head.className = 'gp-head';
    head.innerHTML = `
      <div class="gp-head-top">
        <div class="gp-head-main">
          <span class="game-pill">${esc(g.typeLabel)}</span>
          <h1 class="gp-title">${esc(g.name)}</h1>
          <div class="gp-meta">${esc(g.weeks)}</div>
          <p class="gp-blurb">${esc(g.blurb)}</p>
        </div>
        <div>
          <div class="gp-payout-label">Prize</div>
          <div class="gp-payout">${g.payoutLabel}</div>
        </div>
      </div>
      <div class="gp-actions">
        <button class="expand-btn" data-detail="gpd_${esc(g.id)}" aria-expanded="false">Full rules ↓</button>
      </div>
      <div class="gp-detail" id="gpd_${esc(g.id)}">
        ${g.desc && g.desc !== g.blurb ? `<p>${esc(g.desc)}</p>` : ''}
        ${g.highlight ? `<div class="rules-highlight">${esc(g.highlight)}</div>` : ''}
        <ul class="rules-list">${g.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>`;
    head.querySelector('.expand-btn').onclick = e => toggleDetail(e.currentTarget);
    page.appendChild(head);

    const data = document.createElement('div');
    data.id = 'gd_' + g.id;
    const builder = g.builder ? BUILDERS[g.builder] : null;
    if(builder){
      try { builder(data, g); }
      catch(err){
        console.error('builder failed for ' + g.id, err);
        data.appendChild(emptyCard(g, '⚠️'));
      }
    } else {
      // No builder wired up — scored by hand. Say so instead of showing nothing.
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-head"><div class="card-title" style="color:var(--g)">Scored by hand</div></div>
        <div class="card-empty"><div class="icon">✍️</div>This one is tracked in the group chat, not here. Rules are above.</div>`;
      data.appendChild(card);
    }
    page.appendChild(data);

    container.appendChild(page);
  });
}

function toggleDetail(btn){
  const el = $(btn.dataset.detail);
  if(!el) return;
  const open = el.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Full rules ↑' : 'Full rules ↓';
}

function buildSkeletonPages(){
  const container = $('gamePages');
  if(!container || container.children.length) return;
  GAMES.forEach(g => {
    const page = document.createElement('div');
    page.className = 'page ' + g.cls;
    page.id = 'page-game-' + g.id;
    page.innerHTML = `<div class="skel skel-card" style="margin-bottom:18px;"></div>`
      + '<div class="skel skel-row"></div>'.repeat(5);
    container.appendChild(page);
  });
}

/* ── TEAM PICKER ─────────────────────────────────────────────────────────── */

function openPicker(){
  hideSplash();
  const list = $('pickerList');
  if(!list || !rosters.length) return;
  list.innerHTML = '';
  [...rosters].sort((a,b) => tName(a).localeCompare(tName(b))).forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'picker-item';
    btn.innerHTML = `${avHtml(avatarUrl(r), 'game-leader-av', 'game-leader-ph')}
      <span><span class="picker-item-name">${esc(tName(r))}</span><br><span class="picker-item-sub">${esc(dName(r))}</span></span>`;
    btn.onclick = () => setMyTeam(r);
    list.appendChild(btn);
  });
  $('pickerOverlay')?.classList.add('open');
}
function closePicker(){ $('pickerOverlay')?.classList.remove('open'); }
function setMyTeam(r){
  saved.myTeam = { user_id: r.owner_id, name: tName(r) };
  saveStore();
  closePicker();
  buildAll();
}
function maybePromptTeam(){
  if(!myTeamId() && rosters.length && !window._pickerShown){
    window._pickerShown = true;
    openPicker();
  } else {
    hideSplash();
  }
}

/* ═══ GAME BUILDERS ═════════════════════════════════════════════════════════
   Each takes (panel, game). Card subtitles are derived from the game config,
   so payouts can never drift out of sync with configs/<league>.json.
   ═══════════════════════════════════════════════════════════════════════════ */

function gameCardHead(g, title, sub){
  return `<div class="card-head">
    <div><div class="card-title" style="color:var(--g)">${esc(title || g.name)}</div>
    <div class="card-sub">${esc(sub || g.weeks)} · ${g.payoutLabel}</div></div>
    ${isTest ? '<span class="badge badge-test">Test Data</span>' : ''}
  </div>`;
}

/* ── CARDIAC KING ────────────────────────────────────────────────────────── */
function buildCardiac(panel, g){
  const rows = rosters.map(r => {
    const rid = r.roster_id;
    const diffs = [1,2,3,4].map(w => {
      const m = myPts(rid,w), o = oppPts(rid,w);
      return (m !== null && o !== null) ? Math.abs(m - o) : null;
    });
    const valid = diffs.filter(d => d !== null);
    let avg = null;
    if(valid.length >= 3){
      const s = [...valid].sort((a,b) => a - b);
      avg = s.slice(0,3).reduce((a,b) => a + b, 0) / 3;
    }
    return { r, diffs, avg };
  }).sort((a,b) => (a.avg ?? 999) - (b.avg ?? 999));

  capSt('cardiac', rows.filter(x => x.avg !== null).map(x => ({ rid: x.r.roster_id, val: x.avg.toFixed(1) + ' avg' })));

  if(!rows.some(x => x.avg !== null)){ panel.appendChild(emptyCard(g, '💔')); return; }

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = gameCardHead(g, null, 'Closest 3 of 4');
  const t = mkTable(['','Team','>W1','>W2','>W3','>W4','>Best 3 Avg']);
  rows.forEach(({ r, diffs, avg }, i) => {
    const lead = i === 0 && avg !== null;
    const tr = document.createElement('tr');
    if(lead) tr.className = 'leader-row';
    tr.innerHTML = `
      <td class="rank-num">${i+1}</td>
      ${teamCell(r)}
      ${diffs.map(d => `<td class="mv r">${d !== null ? d.toFixed(1) : '—'}</td>`).join('')}
      <td class="mv r bold" style="color:${lead ? 'var(--g)' : 'var(--text2)'};">${lead ? '<span class="badge badge-green">👑</span> ' : ''}${avg !== null ? avg.toFixed(1) : '—'}</td>`;
    t.querySelector('tbody').appendChild(tr);
  });
  card.appendChild(t);
  panel.appendChild(card);
}

/* ── COMEBACK KID ────────────────────────────────────────────────────────── */
function buildComeback(panel, g){
  const rows = rosters.map(r => {
    const scores = [10,11,12,13,14].map(w => myPts(r.roster_id, w));
    let best = null;
    for(let i = 0; i < 4; i++){
      if(scores[i] !== null && scores[i+1] !== null){
        const j = scores[i+1] - scores[i];
        if(j > 0 && (best === null || j > best)) best = j;
      }
    }
    return { r, scores, best };
  }).sort((a,b) => (b.best || 0) - (a.best || 0));

  capSt('comeback', rows.filter(x => x.best !== null).map(x => ({ rid: x.r.roster_id, val: '+' + x.best.toFixed(1) })));

  if(!rows.some(x => x.best !== null)){ panel.appendChild(emptyCard(g, '📉')); return; }

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = gameCardHead(g, null, 'Best single jump');
  const t = mkTable(['','Team','>W10','>W11','>W12','>W13','>W14','>Best Jump']);
  rows.forEach(({ r, scores, best }, i) => {
    const lead = i === 0 && best !== null;
    const tr = document.createElement('tr');
    if(lead) tr.className = 'leader-row';
    tr.innerHTML = `
      <td class="rank-num">${i+1}</td>
      ${teamCell(r)}
      ${scores.map(s => `<td class="mv r">${s !== null ? s.toFixed(1) : '—'}</td>`).join('')}
      <td class="mv r bold" style="color:${lead ? 'var(--g)' : 'var(--text2)'};">${lead ? '<span class="badge badge-green">👑</span> ' : ''}${best !== null ? '+' + best.toFixed(1) : '—'}</td>`;
    t.querySelector('tbody').appendChild(tr);
  });
  card.appendChild(t);
  panel.appendChild(card);
}

/* ── THE SLEEPER ─────────────────────────────────────────────────────────── */
function buildSleeperGame(panel, g){
  const sheetPicks = sheets.sleeper_picks || [];
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = gameCardHead(g, null, 'Baseline W1–4 → Performance W5–14');

  const t = mkTable(['','Team','Pick','>Baseline Avg','>Perf Avg','>Delta']);
  const arr = [];
  let leader = { delta: -Infinity, name: '' };

  rosters.forEach(roster => {
    const rid = roster.roster_id;
    const elig = heistElig(rid);
    const sheetPick = sheetPicks.find(row => row.roster_id === String(rid));
    const savedPick = ((saved.sleeper || {})[rid]) || {};
    const pickedPid = sheetPick ? (elig.find(pid => pName(pid) === sheetPick.player_name) || '') : (savedPick.pick || '');

    // Baseline: the sheet wins if the commissioner entered one, because league
    // matchup data only covers weeks the player was rostered by somebody — the
    // truest sleepers sit on waivers in W1-4 and would otherwise score nothing.
    const sheetBaseline = sheetPick ? parseFloat(sheetPick.baseline) : NaN;
    let baseAvg = null;
    if(!isNaN(sheetBaseline)){
      baseAvg = sheetBaseline;
    } else {
      const baseScores = [1,2,3,4].map(w => {
        for(const m of (matchups[w] || [])){
          if(m.players_points && m.players_points[pickedPid] !== undefined) return m.players_points[pickedPid];
        }
        return null;
      }).filter(s => s !== null);
      baseAvg = baseScores.length ? baseScores.reduce((a,b) => a + b, 0) / baseScores.length : null;
    }

    const perfScores = [5,6,7,8,9,10,11,12,13,14].map(w => {
      if(!pickedPid) return null;
      const e = (matchups[w] || []).find(m => m.roster_id === rid);
      if(!e || !e.players_points || !(e.starters || []).includes(pickedPid)) return null;
      return e.players_points[pickedPid] || 0;
    }).filter(s => s !== null);

    let perfAvg = null;
    if(perfScores.length){
      const sorted = [...perfScores].sort((a,b) => a - b);
      const trimmed = sorted.length > 1 ? sorted.slice(1) : sorted;
      perfAvg = trimmed.reduce((a,b) => a + b, 0) / trimmed.length;
    }

    const delta = (baseAvg !== null && perfAvg !== null) ? perfAvg - baseAvg : null;
    if(delta !== null){
      if(delta > leader.delta) leader = { delta, name: tName(roster) };
      arr.push({ rid, val: (delta > 0 ? '+' : '') + delta.toFixed(1), _d: delta });
    }

    const pickDisplay = sheetPick
      ? `<span style="font-weight:600;color:var(--g);">${esc(sheetPick.player_name)}</span>`
      : `<select style="width:160px;" aria-label="Sleeper pick for ${esc(tName(roster))}" onchange="saveSleeperPick(${rid},this.value)">
           <option value="">— Select —</option>
           ${elig.map(pid => `<option value="${esc(pid)}"${pid === pickedPid ? ' selected' : ''}>${esc(pName(pid))}</option>`).join('')}
         </select>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="rank-num">—</td>
      ${teamCell(roster)}
      <td class="tdc">${pickDisplay}</td>
      <td class="mv r">${baseAvg !== null ? baseAvg.toFixed(1) : '—'}</td>
      <td class="mv r">${perfAvg !== null ? perfAvg.toFixed(1) : '—'}</td>
      <td class="mv r bold" style="color:${delta !== null ? (delta > 0 ? 'var(--c1)' : delta < 0 ? 'var(--c3)' : 'var(--text2)') : 'var(--text3)'};">${delta !== null ? (delta > 0 ? '+' : '') + delta.toFixed(1) : '—'}</td>`;
    t.querySelector('tbody').appendChild(tr);
  });

  capSt('sleeper', arr.sort((a,b) => b._d - a._d));
  card.appendChild(t);
  if(leader.delta > -Infinity){
    const ldr = document.createElement('div');
    ldr.className = 'leader-note';
    ldr.textContent = `Current leader: ${leader.name} · ${leader.delta > 0 ? '+' : ''}${leader.delta.toFixed(1)} avg pts`;
    card.appendChild(ldr);
  }
  panel.appendChild(card);
}

function saveSleeperPick(rid, pid){
  if(!saved.sleeper) saved.sleeper = {};
  saved.sleeper[rid] = { pick: pid };
  saveStore();
}

/* ── THE TACTICIAN ───────────────────────────────────────────────────────── */

/* Tiebreak by best single week, then second-best, then third — high-card style.
   Unlike bench points this is a ratio at every level, so roster strength cancels
   out and a stacked team isn't structurally penalised. */
function cmpWeekEffs(a, b){
  const n = Math.max(a.length, b.length);
  for(let i = 0; i < n; i++){
    const x = a[i] === undefined ? -1 : a[i];
    const y = b[i] === undefined ? -1 : b[i];
    if(x !== y) return y - x;
  }
  return 0;
}

function buildTactician(panel, g){
  const sheetMax = sheets.tactician || [];

  const sleeperActual = {};
  for(let w = 1; w <= 14; w++){
    (matchups[w] || []).forEach(m => {
      if(!sleeperActual[m.roster_id]) sleeperActual[m.roster_id] = {};
      if(m.points > 0) sleeperActual[m.roster_id][w] = m.points;
    });
  }

  const hasData = sheetMax.length > 0 || Object.keys(sleeperActual).length > 0;
  if(!hasData){ panel.appendChild(emptyCard(g, '📈')); return; }

  const byRoster = {};
  rosters.forEach(r => {
    const rid = String(r.roster_id);
    byRoster[rid] = { actual: 0, max: 0, bench: 0, count: 0, weekData: {} };
    for(let w = 1; w <= 14; w++){
      const act = sleeperActual[r.roster_id]?.[w];
      const sheetRow = sheetMax.find(s => String(s.roster_id) === rid && String(s.week) === String(w));
      const mx = sheetRow ? parseFloat(sheetRow.max_pts || 0) : 0;
      if(act !== undefined){
        if(mx > 0){
          byRoster[rid].actual += act;
          byRoster[rid].max += mx;
          byRoster[rid].bench += (mx - act);
          byRoster[rid].count++;
        }
        byRoster[rid].weekData[w] = { act, mx };
      }
    }
  });

  const rows = rosters.map(r => {
    const d = byRoster[String(r.roster_id)] || { actual:0, max:0, bench:0, count:0, weekData:{} };
    const weekEffs = Object.values(d.weekData)
      .filter(x => x.mx > 0)
      .map(x => x.act / x.mx)
      .sort((x, y) => y - x);
    return { r, d, weekEffs, avg: d.max > 0 ? d.actual / d.max : 0 };
  }).sort((a,b) => (b.avg - a.avg) || cmpWeekEffs(a.weekEffs, b.weekEffs) || (a.d.bench - b.d.bench));

  capSt('tactician', rows.filter(x => x.avg > 0).map(x => ({ rid: x.r.roster_id, val: (x.avg * 100).toFixed(2) + '%' })));

  if(!rows.some(x => x.avg > 0)){ panel.appendChild(emptyCard(g, '📈')); return; }

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = gameCardHead(g, null, 'Season average · Actual ÷ Max possible');
  const t = mkTable(['','Team','>Actual Pts','>Max Possible','>Bench','>Best Week','','>Efficiency']);
  rows.forEach(({ r, d, weekEffs, avg }, i) => {
    const pct = (avg * 100).toFixed(2);
    const best = weekEffs.length ? (weekEffs[0] * 100).toFixed(1) + '%' : '—';
    const lead = i === 0;
    const barColor = avg > 0.9 ? 'var(--c1)' : avg > 0.8 ? 'var(--c2)' : 'var(--c3)';
    const tr = document.createElement('tr');
    if(lead) tr.className = 'leader-row';
    tr.innerHTML = `
      <td class="rank-num">${i+1}</td>
      ${teamCell(r)}
      <td class="mv r">${d.actual.toFixed(1)}</td>
      <td class="mv r">${d.max.toFixed(1)}</td>
      <td class="mv r" style="color:var(--text3);">${d.bench.toFixed(1)}</td>
      <td class="mv r" style="color:var(--text3);">${best}</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor};"></div></div></td>
      <td class="mv r bold" style="color:${barColor};">${lead ? '<span class="badge badge-gold">👑</span> ' : ''}${pct}%</td>`;
    t.querySelector('tbody').appendChild(tr);
  });
  card.appendChild(t);
  panel.appendChild(card);

  // Weekly breakdown
  const weeks = [];
  for(let w = 1; w <= 14; w++){
    if(rosters.some(r => (sleeperActual[r.roster_id]?.[w]) > 0)) weeks.push(String(w));
  }
  if(!weeks.length) return;

  const wcard = document.createElement('div');
  wcard.className = 'card';
  const whead = document.createElement('div');
  whead.className = 'card-head';
  whead.innerHTML = `<div><div class="card-title" style="color:var(--g)">Weekly Breakdown</div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      ${weeks.map((wk,i) => `<button class="week-btn${i === 0 ? ' week-btn-active' : ''}" onclick="showTacticianWeek('${wk}',this)">W${wk}</button>`).join('')}
    </div>`;
  wcard.appendChild(whead);

  const wtContainer = document.createElement('div');
  wtContainer.id = 'tacticianWeekTable';
  wcard.appendChild(wtContainer);

  window._tacEffData = sheetMax;
  renderTacticianWeek(weeks[0], wtContainer);
  panel.appendChild(wcard);
}

function renderTacticianWeek(wk, container){
  const effData = window._tacEffData || [];
  const sheetMax = sheets.tactician || [];
  container.innerHTML = '';

  const wRows = rosters.map(r => {
    const rid = String(r.roster_id);
    const sheetRow = effData.find(d => String(d.roster_id) === rid && String(d.week) === String(wk));
    const maxRow = sheetMax.find(s => String(s.roster_id) === rid && String(s.week) === String(wk));
    const act = sheetRow ? parseFloat(sheetRow.actual_pts || 0)
      : ((matchups[wk] || []).find(m => m.roster_id === r.roster_id)?.points || 0);
    const mx = maxRow ? parseFloat(maxRow.max_pts || 0) : 0;
    return { r, act, mx, eff: mx > 0 ? act / mx : 0 };
  }).filter(row => row.act > 0 || row.mx > 0).sort((a,b) => (b.eff - a.eff) || ((a.mx - a.act) - (b.mx - b.act)));

  if(!wRows.length){
    container.innerHTML = '<div class="card-empty">No data for this week yet.</div>';
    return;
  }

  const wt = mkTable(['','Team','>Actual','>Max','>Bench','','>Efficiency']);
  wRows.forEach((row, ri) => {
    const pct = (row.eff * 100).toFixed(2);
    const lead = ri === 0;
    const barColor = row.eff > 0.9 ? 'var(--c1)' : row.eff > 0.8 ? 'var(--c2)' : 'var(--c3)';
    const tr = document.createElement('tr');
    if(lead) tr.className = 'leader-row';
    tr.innerHTML = `
      <td class="rank-num">${ri+1}</td>
      ${teamCell(row.r)}
      <td class="mv r">${row.act.toFixed(1)}</td>
      <td class="mv r">${row.mx > 0 ? row.mx.toFixed(1) : '—'}</td>
      <td class="mv r" style="color:var(--text3);">${row.mx > 0 ? (row.mx - row.act).toFixed(1) : '—'}</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor};"></div></div></td>
      <td class="mv r bold" style="color:${barColor};">${lead ? '<span class="badge badge-gold">👑</span> ' : ''}${pct}%</td>`;
    wt.querySelector('tbody').appendChild(tr);
  });
  container.appendChild(wt);
}

function showTacticianWeek(wk, btn){
  document.querySelectorAll('.week-btn').forEach(b => b.classList.remove('week-btn-active'));
  btn.classList.add('week-btn-active');
  const container = $('tacticianWeekTable');
  if(container) renderTacticianWeek(wk, container);
}

/* ── THE LONG GAME ───────────────────────────────────────────────────────── */
function buildLongGame(panel, g){
  const data = sheets.long_game || [];

  // Was a bug here: the empty state used to render inside the has-data branch,
  // so it showed under a populated table and never showed when data was missing.
  if(!data.length){ panel.appendChild(emptyCard(g, '📊')); return; }

  const WKS = Array.from({ length: 17 }, (_, i) => 'w' + (i + 1));
  const WLABELS = Array.from({ length: 17 }, (_, i) => 'W' + (i + 1));

  const rows = rosters.map(r => {
    const row = data.find(d => d.roster_id === String(r.roster_id))
      || data.find(d => (d.team_name || '').toLowerCase() === (tName(r) || '').toLowerCase())
      || data.find(d => (d.team_name || '').toLowerCase() === (dName(r) || '').toLowerCase())
      || {};
    const vals = WKS.map(w => row[w] ? parseFloat(row[w]) : null);
    const first = vals.find(v => v !== null);
    const last = [...vals].reverse().find(v => v !== null);
    const gain = (first != null && last != null && first !== last) ? (last - first) : null;
    return { r, row, vals, gain };
  }).sort((a,b) => (b.gain || 0) - (a.gain || 0));

  capSt('longgame', rows.filter(x => x.gain !== null)
    .map(x => ({ rid: x.r.roster_id, val: (x.gain > 0 ? '+' : '') + x.gain.toLocaleString() })));

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = gameCardHead(g, null, 'KTC Superflex value · W1–W17 incl. playoffs');

  const t = mkTable(['','Team','Player','>W1','>Current','>Trend','>Gain']);
  rows.forEach(({ r, row, vals, gain }, i) => {
    const lead = i === 0 && gain !== null && gain > 0;
    const tr = document.createElement('tr');
    if(lead) tr.className = 'leader-row';

    const nonNull = vals.filter(v => v !== null);
    const minV = nonNull.length ? Math.min(...nonNull) : 0;
    const maxV = nonNull.length ? Math.max(...nonNull) : 1;
    const range = (maxV - minV) || 1;
    const svgW = 120, svgH = 28, pad = 3;
    let path = '', started = false;
    vals.forEach((v, vi) => {
      if(v === null) return;
      const x = pad + (vi / (WKS.length - 1)) * (svgW - pad * 2);
      const y = svgH - pad - ((v - minV) / range) * (svgH - pad * 2);
      path += (started ? ' L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
      started = true;
    });
    const sparkColor = gain > 0 ? 'var(--c1)' : gain < 0 ? 'var(--c3)' : 'var(--text3)';
    const spark = path
      ? `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="Value trend"><path d="${path}" fill="none" stroke="${sparkColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : '<span style="color:var(--text3);font-size:11px;">—</span>';

    tr.innerHTML = `
      <td class="rank-num">${i+1}</td>
      ${teamCell(r)}
      <td class="tdc" style="font-weight:500;font-size:13px;">${esc(row.player_name || '—')}</td>
      <td class="mv r">${nonNull[0]?.toLocaleString() || '—'}</td>
      <td class="mv r">${[...vals].reverse().find(v => v !== null)?.toLocaleString() || '—'}</td>
      <td style="padding:6px 14px;">${spark}</td>
      <td class="mv r bold" style="color:${gain > 0 ? 'var(--c1)' : gain < 0 ? 'var(--c3)' : 'var(--text3)'};">${lead ? '<span class="badge badge-green">👑</span> ' : ''}${gain !== null ? (gain > 0 ? '+' : '') + gain.toLocaleString() : '—'}</td>`;
    t.querySelector('tbody').appendChild(tr);
  });
  card.appendChild(t);

  // Expandable full weekly grid
  const wrap = document.createElement('div');
  wrap.style.borderTop = '1px solid var(--border)';
  const btn = document.createElement('button');
  btn.className = 'expand-btn';
  btn.style.cssText = 'width:100%;border:none;border-radius:0;padding:10px 20px;text-align:left;display:flex;justify-content:space-between;';
  btn.setAttribute('aria-expanded','false');
  btn.textContent = 'Show weekly values ↓';
  const body = document.createElement('div');
  body.style.cssText = 'display:none;overflow-x:auto;';
  btn.onclick = () => {
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Hide weekly values ↑' : 'Show weekly values ↓';
  };
  const wt = mkTable(['Team','Player', ...WLABELS.map(l => '>' + l)]);
  rows.forEach(({ r, row, vals }) => {
    const wtr = document.createElement('tr');
    wtr.innerHTML = `${teamCell(r)}
      <td class="tdc" style="font-weight:500;font-size:12px;">${esc(row.player_name || '—')}</td>
      ${vals.map(v => `<td class="mv r" style="font-size:11px;">${v !== null ? v.toLocaleString() : '—'}</td>`).join('')}`;
    wt.querySelector('tbody').appendChild(wtr);
  });
  body.appendChild(wt);
  wrap.appendChild(btn);
  wrap.appendChild(body);
  card.appendChild(wrap);

  panel.appendChild(card);
}

/* ── THE GHOST — highest single-player week ──────────────────────────────── */
function buildTopScore(panel, g){
  const REG_WEEKS = Math.max(...(g.activeWeeks.length ? g.activeWeeks : [14]));

  // Best single starter performance per roster, regular season only.
  const best = {};
  for(let w = 1; w <= REG_WEEKS; w++){
    (matchups[w] || []).forEach(m => {
      if(!m.players_points || !m.starters) return;
      m.starters.forEach(pid => {
        const pts = m.players_points[pid] || 0;
        if(pts <= 0) return;
        const cur = best[m.roster_id];
        if(!cur || pts > cur.pts) best[m.roster_id] = { pts, pid, w, rid: m.roster_id };
      });
    });
  }

  const rows = rosters
    .map(r => ({ r, best: best[r.roster_id] || null }))
    .sort((a, b) => (b.best ? b.best.pts : -1) - (a.best ? a.best.pts : -1));

  // One entry per roster — leader cards and My Season rank off this.
  capSt('topgun', rows.filter(x => x.best).map(x => ({ rid: x.r.roster_id, val: x.best.pts.toFixed(1) + ' pts' })));

  const top = rows.find(x => x.best);
  if(!top){ panel.appendChild(emptyCard(g, '👻')); return; }

  // Record banner
  if(top.best.pts > TYREEK_RECORD){
    const hero = document.createElement('div');
    hero.className = 'tyreek-hero';
    hero.innerHTML = `<div class="tyreek-icon">👑</div><div class="tyreek-txt">
      <h3>Record broken!</h3>
      <p>${esc(pName(top.best.pid))} — ${top.best.pts.toFixed(1)} pts in Week ${top.best.w} for ${esc(tName(top.r))}.
      The old mark was ${TYREEK_RECORD}, set by ${esc(LEAGUE_CONFIG.tyreekHolder)} in ${LEAGUE_CONFIG.tyreekYear}.</p></div>`;
    panel.appendChild(hero);
  } else {
    const safe = document.createElement('div');
    safe.className = 'tyreek-safe';
    safe.innerHTML = `<div class="icon">👻</div><div class="label">${TYREEK_RECORD} still stands</div>
      <div class="sub">${esc(LEAGUE_CONFIG.tyreekHolder)}, Week ${LEAGUE_CONFIG.tyreekWeek}, ${LEAGUE_CONFIG.tyreekYear} ·
      Closest so far: <strong style="color:var(--text);">${top.best.pts.toFixed(1)}</strong>
      (${esc(pName(top.best.pid))}, W${top.best.w}) — ${(TYREEK_RECORD - top.best.pts).toFixed(1)} short</div>`;
    panel.appendChild(safe);
  }

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = gameCardHead(g, null, 'Best single starter week · W1–W' + REG_WEEKS);
  const t = mkTable(['', 'Team', 'Player', 'Week', '>Score', '>vs Record']);
  rows.forEach(({ r, best: b }, i) => {
    const lead = i === 0 && b;
    const tr = document.createElement('tr');
    if(lead) tr.className = 'leader-row';
    if(!b){
      tr.innerHTML = `<td class="rank-num">—</td>${teamCell(r)}
        <td class="tdc" style="color:var(--text3);">—</td><td class="mv">—</td>
        <td class="mv r">—</td><td class="mv r">—</td>`;
    } else {
      const diff = b.pts - TYREEK_RECORD;
      tr.innerHTML = `
        <td class="rank-num">${i+1}</td>
        ${teamCell(r)}
        <td class="tdc" style="font-weight:600;">${esc(pName(b.pid))}</td>
        <td class="mv">W${b.w}</td>
        <td class="mv r bold" style="color:var(--g);">${lead ? '<span class="badge badge-green">👑</span> ' : ''}${b.pts.toFixed(1)}</td>
        <td class="mv r" style="color:${diff > 0 ? 'var(--c1)' : 'var(--text3)'};">${diff > 0 ? '+' + diff.toFixed(1) : diff.toFixed(1)}</td>`;
    }
    t.querySelector('tbody').appendChild(tr);
  });
  card.appendChild(t);
  panel.appendChild(card);
}

/* ── COMING SOON — a game that's announced but not yet specced ───────────── */
function buildComingSoon(panel, g){
  const facts = Array.isArray(g.teaserFacts) ? g.teaserFacts : [];
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-head"><div>
      <div class="card-title" style="color:var(--g)">${esc(g.teaser || 'Coming soon')}</div>
      <div class="card-sub">${esc(g.weeks)} · ${g.payoutLabel}</div>
    </div></div>
    <div class="teaser-body">
      <div class="teaser-mark">🦃</div>
      <p class="teaser-line">${esc(g.desc)}</p>
      ${facts.length ? `<dl class="teaser-facts">${facts.map(f => `
        <div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>` : ''}
    </div>`;
  panel.appendChild(card);
}

/* ═══ HISTORY ═══════════════════════════════════════════════════════════════ */

function normalizeName(n){
  if(!n) return n;
  return NAME_ALIASES[n] || NAME_ALIASES[n.toLowerCase()] || n;
}

function slimSeason(d){
  return {
    league: { name: (d.league && d.league.name) || '' },
    rosters: (d.rosters || []).map(r => ({
      roster_id: r.roster_id, owner_id: r.owner_id,
      settings: { wins: r.settings?.wins || 0, losses: r.settings?.losses || 0,
                  fpts: r.settings?.fpts || 0, fpts_decimal: r.settings?.fpts_decimal || 0 }
    })),
    users: (d.users || []).map(u => ({
      user_id: u.user_id, display_name: u.display_name, avatar: u.avatar,
      metadata: { team_name: (u.metadata && u.metadata.team_name) || '', avatar: (u.metadata && u.metadata.avatar) || '' }
    })),
    matchups: Object.fromEntries(Object.entries(d.matchups || {}).map(([w, arr]) =>
      [w, (arr || []).map(m => ({ roster_id: m.roster_id, matchup_id: m.matchup_id, points: m.points || 0 }))])),
    bracket: d.bracket || [], id: d.id, year: d.year
  };
}

async function fetchSeason(s){
  const [league, ros, usr] = await Promise.all([
    slGet(`/league/${s.id}`), slGet(`/league/${s.id}/rosters`), slGet(`/league/${s.id}/users`)
  ]);
  const wks = [1,2,3,4,5,6,7,8,9,10,11,12,13,14];
  const mRes = await Promise.all(wks.map(w => slGet(`/league/${s.id}/matchups/${w}`).catch(() => [])));
  const mData = {};
  wks.forEach((w,i) => mData[w] = mRes[i] || []);
  let bracket = [];
  try { bracket = await slGet(`/league/${s.id}/winners_bracket`); } catch(e){}
  return slimSeason({ league, rosters: ros, users: usr, matchups: mData, bracket, id: s.id, year: s.year });
}

async function loadHistory(){
  const container = $('historyContent');
  if(!container) return;
  container.innerHTML = `<div class="hist-note" id="histLoadMsg" style="padding:16px 0;">Loading league history…</div>`
    + '<div class="skel skel-row"></div>'.repeat(3);

  let loaded = 0;
  await Promise.all(SEASON_IDS.map(async s => {
    if(histData[s.year]) return;
    const isLive = s.id === LIVE_ID;
    const key = 'mg_hist_' + s.id;
    if(!isLive){
      try {
        const cached = localStorage.getItem(key);
        if(cached){ histData[s.year] = JSON.parse(cached); loaded++; return; }
      } catch(e){}
    }
    try {
      const data = await fetchSeason(s);
      histData[s.year] = data;
      loaded++;
      if(!isLive){ try { localStorage.setItem(key, JSON.stringify(data)); } catch(e){} }
      const msg = $('histLoadMsg');
      if(msg) msg.textContent = `Loading league history… ${loaded}/${SEASON_IDS.length} seasons`;
    } catch(e){ console.warn('history: failed ' + s.year, e); }
  }));

  buildManagerNames();
  buildHistoryPage(container);
}

function hTN(r,u){ const x = u.find(v => v.user_id === r.owner_id) || {}; return (x.metadata && x.metadata.team_name && x.metadata.team_name.trim()) || x.display_name || `Team ${r.roster_id}`; }
function hDN(r,u){ const x = u.find(v => v.user_id === r.owner_id) || {}; return normalizeName(x.display_name || ''); }
function hAV(r,u){
  const x = u.find(v => v.user_id === r.owner_id) || {};
  if(x.metadata && x.metadata.avatar && x.metadata.avatar.startsWith('http')) return x.metadata.avatar;
  if(x.avatar) return `https://sleepercdn.com/avatars/thumbs/${x.avatar}`;
  return null;
}
/* Identity across seasons.
   Sleeper's user_id never changes — not when someone renames their team, and
   not when they rename their username. So key history on the id and look the
   display name up separately. nameAliases still works, and now accepts either
   a user_id (someone who made a second Sleeper account) or an old username. */
function hKey(r,u){
  const x = u.find(v => v.user_id === r.owner_id) || {};
  const id = r.owner_id || x.user_id || '';
  if(id && NAME_ALIASES[id]) return NAME_ALIASES[id];
  if(id) return id;
  return normalizeName(x.display_name || '') || hTN(r,u);
}

/* id -> the name to show, taken from the most recent season they appear in. */
let MANAGER_NAMES = {};
function buildManagerNames(){
  MANAGER_NAMES = {};
  Object.keys(histData).map(Number).sort((a,b) => b - a).forEach(year => {
    const d = histData[year];
    d.rosters.forEach(r => {
      const key = hKey(r, d.users);
      if(!MANAGER_NAMES[key]) MANAGER_NAMES[key] = hDN(r, d.users) || hTN(r, d.users);
    });
  });
}
function hLabel(key){ return MANAGER_NAMES[key] || key; }

function getChampion(d){
  if(!d.bracket || !d.bracket.length) return null;
  const last = [...d.bracket].sort((a,b) => (b.r || 0) - (a.r || 0))[0];
  return (last && last.w) ? (d.rosters.find(r => r.roster_id === last.w) || null) : null;
}
function getRunnerUp(d){
  if(!d.bracket || !d.bracket.length) return null;
  const last = [...d.bracket].sort((a,b) => (b.r || 0) - (a.r || 0))[0];
  return (last && last.l) ? (d.rosters.find(r => r.roster_id === last.l) || null) : null;
}
function getHighScore(d){
  let best = { pts: 0, roster: null, week: null };
  Object.entries(d.matchups).forEach(([w, wk]) => wk.forEach(m => {
    if((m.points || 0) > best.pts) best = { pts: m.points, roster: d.rosters.find(r => r.roster_id === m.roster_id), week: w };
  }));
  return best;
}
function getTopScorer(d){
  const tot = {};
  d.rosters.forEach(r => tot[r.roster_id] = 0);
  Object.values(d.matchups).forEach(wk => wk.forEach(m => tot[m.roster_id] = (tot[m.roster_id] || 0) + (m.points || 0)));
  const top = Object.entries(tot).sort((a,b) => b[1] - a[1])[0];
  return { roster: d.rosters.find(r => r.roster_id === parseInt(top[0])), total: top[1] };
}

function buildH2H(filterNames = null){
  const h2h = {}, allNames = new Set();
  Object.values(histData).forEach(data => {
    Object.values(data.matchups).forEach(wk => {
      const byMid = {};
      wk.forEach(m => { (byMid[m.matchup_id] ||= []).push(m); });
      Object.values(byMid).forEach(pair => {
        if(pair.length !== 2) return;
        const [a,b] = pair;
        const ra = data.rosters.find(r => r.roster_id === a.roster_id);
        const rb = data.rosters.find(r => r.roster_id === b.roster_id);
        if(!ra || !rb) return;
        const na = hKey(ra, data.users), nb = hKey(rb, data.users);
        if(!na || !nb || na === nb) return;
        if(filterNames && (!filterNames.has(na) || !filterNames.has(nb))) return;
        allNames.add(na); allNames.add(nb);
        h2h[na] ||= {}; h2h[nb] ||= {};
        h2h[na][nb] ||= { w:0, l:0 }; h2h[nb][na] ||= { w:0, l:0 };
        if((a.points || 0) > (b.points || 0)){ h2h[na][nb].w++; h2h[nb][na].l++; }
        else if((b.points || 0) > (a.points || 0)){ h2h[nb][na].w++; h2h[na][nb].l++; }
      });
    });
  });
  return { h2h, names: [...allNames].sort((a,b) => hLabel(a).localeCompare(hLabel(b))) };
}

function buildAllTimeStandings(filterNames = null){
  const stats = {};
  Object.values(histData).forEach(data => {
    const champ = getChampion(data), ru = getRunnerUp(data);
    const champKey = champ ? hKey(champ, data.users) : null;
    const ruKey = ru ? hKey(ru, data.users) : null;
    data.rosters.forEach(r => {
      const key = hKey(r, data.users);
      if(!key) return;
      if(filterNames && !filterNames.has(key)) return;
      stats[key] ||= { name:hLabel(key), wins:0, losses:0, seasons:0, titles:0, runnerUps:0, ptsFor:0, maxPts:0, weekScores:[], av:hAV(r, data.users) };
      stats[key].seasons++;
      stats[key].wins += r.settings?.wins || 0;
      stats[key].losses += r.settings?.losses || 0;
      stats[key].ptsFor += (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100;
      if(champKey && key === champKey) stats[key].titles++;
      if(ruKey && key === ruKey) stats[key].runnerUps++;
      Object.values(data.matchups).forEach(wk => wk.forEach(m => {
        if(m.roster_id === r.roster_id && m.points > 0){
          stats[key].weekScores.push(m.points);
          if(m.points > stats[key].maxPts) stats[key].maxPts = m.points;
        }
      }));
    });
  });
  return Object.values(stats).map(s => {
    s.winPct = s.wins / ((s.wins + s.losses) || 1);
    s.avgScore = s.weekScores.length ? s.weekScores.reduce((a,b) => a + b, 0) / s.weekScores.length : 0;
    return s;
  }).sort((a,b) => b.winPct - a.winPct);
}

function buildRecordBook(){
  const rec = {
    highScore:{val:0,name:'',year:'',week:''}, lowScore:{val:Infinity,name:'',year:'',week:''},
    bigMargin:{val:0,winName:'',lossName:'',year:'',week:''}, mostPts:{val:0,name:'',year:''}, mostWins:null
  };
  const winsByName = {};
  Object.entries(histData).forEach(([year, data]) => {
    const { rosters, users, matchups } = data;
    const seasonTots = {};
    rosters.forEach(r => seasonTots[r.roster_id] = 0);
    Object.entries(matchups).forEach(([w, wk]) => {
      const byMid = {};
      wk.forEach(m => {
        seasonTots[m.roster_id] = (seasonTots[m.roster_id] || 0) + (m.points || 0);
        (byMid[m.matchup_id] ||= []).push(m);
      });
      wk.forEach(m => {
        const r = rosters.find(x => x.roster_id === m.roster_id);
        if(!r) return;
        const name = hKey(r, users), pts = m.points || 0;
        if(pts > rec.highScore.val) rec.highScore = { val:pts, name, year, week:w };
        if(pts > 0 && pts < rec.lowScore.val) rec.lowScore = { val:pts, name, year, week:w };
      });
      Object.values(byMid).forEach(pair => {
        if(pair.length !== 2) return;
        const [a,b] = pair;
        const margin = Math.abs((a.points || 0) - (b.points || 0));
        if(margin > rec.bigMargin.val){
          const win = a.points > b.points ? a : b, lose = a.points > b.points ? b : a;
          const rw = rosters.find(r => r.roster_id === win.roster_id), rl = rosters.find(r => r.roster_id === lose.roster_id);
          if(rw && rl) rec.bigMargin = { val:margin, winName:hKey(rw,users), lossName:hKey(rl,users), year, week:w };
        }
      });
    });
    const topRid = Object.entries(seasonTots).sort((a,b) => b[1] - a[1])[0];
    if(topRid){
      const r = rosters.find(x => x.roster_id === parseInt(topRid[0]));
      if(r && topRid[1] > rec.mostPts.val) rec.mostPts = { val: topRid[1], name: hKey(r, users), year };
    }
    rosters.forEach(r => {
      const name = hKey(r, users);
      winsByName[name] = (winsByName[name] || 0) + (r.settings?.wins || 0);
    });
  });
  const topW = Object.entries(winsByName).sort((a,b) => b[1] - a[1])[0];
  if(topW) rec.mostWins = { val: topW[1], name: topW[0] };
  if(rec.lowScore.val === Infinity) rec.lowScore.val = 0;
  return rec;
}

function buildHistoryPage(container){
  const years = Object.keys(histData).map(Number).sort((a,b) => b - a);
  if(!years.length){
    container.innerHTML = '<div class="card"><div class="card-empty"><div class="icon">📚</div>No history loaded yet.</div></div>';
    return;
  }
  window._histView = 'current';

  container.innerHTML = `
    <div class="hist-toolbar">
      <div class="seg" role="group" aria-label="Which managers to include">
        <button class="seg-btn" id="hViewCurrent" aria-pressed="true" onclick="setHistView('current')">Current managers</button>
        <button class="seg-btn" id="hViewHistoric" aria-pressed="false" onclick="setHistView('historic')">All-time</button>
      </div>
      <div class="hist-note" id="hViewDesc">Head-to-head and standings for current managers only — all seasons included</div>
    </div>
    <div class="hist-season-strip" id="histStrip"></div>
    <div id="histViewContent"></div>`;

  const strip = $('histStrip');
  const allBtn = document.createElement('button');
  allBtn.className = 'hist-year-btn active';
  allBtn.textContent = 'All-Time';
  allBtn.dataset.year = 'all';
  allBtn.onclick = () => switchHistView('all', allBtn);
  strip.appendChild(allBtn);
  years.forEach(y => {
    const b = document.createElement('button');
    b.className = 'hist-year-btn';
    b.textContent = y;
    b.dataset.year = y;
    b.onclick = () => switchHistView(y, b);
    strip.appendChild(b);
  });

  buildAllTimeView($('histViewContent'));
}

function setHistView(mode){
  window._histView = mode;
  $('hViewCurrent').setAttribute('aria-pressed', String(mode === 'current'));
  $('hViewHistoric').setAttribute('aria-pressed', String(mode !== 'current'));
  const desc = $('hViewDesc');
  if(desc) desc.textContent = mode === 'current'
    ? 'Head-to-head and standings for current managers only — all seasons included'
    : 'Every manager who has ever played in this league';
  const active = document.querySelector('.hist-year-btn.active');
  const year = active ? active.dataset.year : 'all';
  const content = $('histViewContent');
  if(!content) return;
  if(year === 'all') buildAllTimeView(content); else buildSeasonView(content, parseInt(year));
}

function switchHistView(year, btn){
  document.querySelectorAll('.hist-year-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const content = $('histViewContent');
  if(!content) return;
  if(year === 'all') buildAllTimeView(content); else buildSeasonView(content, parseInt(year));
}

function getCurrentFilter(){
  if(window._histView !== 'current') return null;
  const ids = new Set();
  (users || []).forEach(u => {
    const id = u.user_id || '';
    ids.add(NAME_ALIASES[id] || id);
    // legacy: configs that aliased by username still resolve
    const n = normalizeName(u.display_name || '');
    if(n) ids.add(n);
  });
  return ids.size ? ids : null;
}

function buildAllTimeView(container){
  container.innerHTML = '';
  const filter = getCurrentFilter();
  const seasonCount = Object.keys(histData).length;

  // Standings
  const sc = document.createElement('div');
  sc.className = 'card';
  sc.innerHTML = `<div class="card-head"><div><div class="card-title">All-Time Standings</div>
    <div class="card-sub">${filter ? 'Current managers' : 'All managers'} · ${seasonCount} seasons · by win %</div></div></div>`;
  const sb = document.createElement('div');
  buildAllTimeStandings(filter).forEach((s, i) => {
    const pct = (s.winPct * 100).toFixed(1);
    const col = s.winPct > 0.55 ? 'var(--c1)' : s.winPct < 0.45 ? 'var(--c3)' : 'var(--text2)';
    const row = document.createElement('div');
    row.className = 'stand-row';
    row.innerHTML = `
      <div class="stand-rank${i === 0 ? ' top' : ''}">${i+1}</div>
      <div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
          <span class="stand-name">${esc(s.name)}</span>
          ${s.titles ? `<span class="trophy">🏆 ${s.titles}</span>` : ''}
          ${s.runnerUps ? `<span class="trophy silver">🥈 ${s.runnerUps}</span>` : ''}
        </div>
        <div class="stand-meta">
          <span><strong style="color:var(--c1);font-size:13px;">${s.wins}</strong>W <strong style="color:var(--c3);font-size:13px;">${s.losses}</strong>L</span>
          <span>${s.seasons} seasons</span>
          <span>Avg ${s.avgScore.toFixed(1)}/wk</span>
          <span>Best ${s.maxPts.toFixed(1)}</span>
        </div>
      </div>
      <div>
        <div class="stand-pct" style="color:${col};">${pct}%</div>
        <div class="stand-bar"><div style="height:100%;width:${pct}%;background:${col};border-radius:3px;"></div></div>
      </div>`;
    sb.appendChild(row);
  });
  sc.appendChild(sb);
  container.appendChild(sc);

  // Record book
  const r = buildRecordBook();
  const rc = document.createElement('div');
  rc.className = 'card';
  rc.innerHTML = `<div class="card-head"><div><div class="card-title">The Record Book</div>
    <div class="card-sub">All-time marks across ${seasonCount} seasons</div></div></div>`;
  const rb = document.createElement('div');
  rb.style.padding = '4px 20px';
  [
    { icon:'🔥', title:`Highest single week · W${r.highScore.week}, ${r.highScore.year}`, name:hLabel(r.highScore.name), val:r.highScore.val.toFixed(2) },
    { icon:'😬', title:`Lowest single week · W${r.lowScore.week}, ${r.lowScore.year}`, name:hLabel(r.lowScore.name), val:r.lowScore.val.toFixed(2) },
    { icon:'💥', title:`Biggest margin · W${r.bigMargin.week} ${r.bigMargin.year} over ${r.bigMargin.lossName ? hLabel(r.bigMargin.lossName) : '?'}`, name:hLabel(r.bigMargin.winName), val:r.bigMargin.val.toFixed(1) },
    { icon:'📈', title:`Most points in a season · ${r.mostPts.year}`, name:hLabel(r.mostPts.name), val:r.mostPts.val.toFixed(1) },
    { icon:'👑', title:'Most all-time wins', name:r.mostWins ? hLabel(r.mostWins.name) : '—', val:r.mostWins ? r.mostWins.val + ' W' : '—' }
  ].forEach(item => {
    const row = document.createElement('div');
    row.className = 'rec-row';
    row.innerHTML = `<div class="rec-icon">${item.icon}</div>
      <div style="flex:1;min-width:0;"><div class="rec-title">${esc(item.title)}</div><div class="rec-name">${esc(item.name || '—')}</div></div>
      <div class="rec-val">${esc(item.val || '—')}</div>`;
    rb.appendChild(row);
  });
  rc.appendChild(rb);
  container.appendChild(rc);

  // H2H
  const { h2h, names } = buildH2H(filter);
  const hc = document.createElement('div');
  hc.className = 'card';
  hc.innerHTML = `<div class="card-head"><div><div class="card-title">Head-to-Head</div>
    <div class="card-sub">${filter ? 'Current managers' : 'All managers'} · read across from each row</div></div></div>`;
  const hw = document.createElement('div');
  hw.className = 'h2h-wrap';
  const ht = document.createElement('table');
  ht.className = 'h2h-table';
  ht.innerHTML = `<thead><tr><th scope="col" class="h2h-row-head">↓ vs →</th>${
    names.map(n => { const L = hLabel(n);
      return `<th scope="col" title="${esc(L)}">${esc(L.length > 9 ? L.slice(0,8) + '…' : L)}</th>`; }).join('')}</tr></thead>`;
  const tb = document.createElement('tbody');
  names.forEach(rn => {
    const tr = document.createElement('tr');
    const totW = Object.values(h2h[rn] || {}).reduce((a,b) => a + b.w, 0);
    const totL = Object.values(h2h[rn] || {}).reduce((a,b) => a + b.l, 0);
    tr.innerHTML = `<td class="h2h-row-head"><div style="font-weight:700;font-size:12px;">${esc(hLabel(rn))}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);">${totW}W–${totL}L</div></td>`
      + names.map(cn => {
        if(rn === cn) return '<td class="h2h-self">—</td>';
        const rec = h2h[rn]?.[cn];
        if(!rec || (!rec.w && !rec.l)) return '<td class="h2h-even" style="color:var(--text3);">—</td>';
        const cls = rec.w > rec.l ? 'h2h-win' : rec.l > rec.w ? 'h2h-loss' : 'h2h-even';
        const pct = ((rec.w / (rec.w + rec.l)) * 100).toFixed(0);
        return `<td class="${cls}" title="${esc(hLabel(rn))} vs ${esc(hLabel(cn))}: ${rec.w}W ${rec.l}L">
          <div style="font-weight:800;font-size:14px;line-height:1.1;">${rec.w}–${rec.l}</div>
          <div style="font-size:10px;font-weight:600;opacity:.75;">${pct}%</div></td>`;
      }).join('');
    tb.appendChild(tr);
  });
  ht.appendChild(tb);
  hw.appendChild(ht);
  hc.appendChild(hw);
  container.appendChild(hc);

  // Champions
  const tc = document.createElement('div');
  tc.className = 'card';
  tc.innerHTML = `<div class="card-head"><div class="card-title">Champions</div></div>`;
  const tbody = document.createElement('div');
  Object.keys(histData).map(Number).sort((a,b) => b - a).forEach(year => {
    const data = histData[year];
    const champ = getChampion(data), ru = getRunnerUp(data), hs = getHighScore(data);
    const row = document.createElement('div');
    row.className = 'champ-row';
    if(!champ){
      row.innerHTML = `<div class="champ-year">${year}</div>
        <div class="champ-ph" style="background:var(--surface2);border-color:var(--border);">🏈</div>
        <div style="flex:1;"><div class="champ-label" style="color:var(--text3);">In progress</div>
        <div class="champ-name" style="color:var(--text3);">TBD</div></div>`;
    } else {
      row.innerHTML = `<div class="champ-year">${year}</div>
        ${avHtml(hAV(champ, data.users), 'champ-av', 'champ-ph', '🏆')}
        <div style="flex:1;min-width:0;">
          <div class="champ-label">Champion</div>
          <div class="champ-name">${esc(hTN(champ, data.users))}</div>
          ${ru ? `<div class="champ-sub">Runner-up: ${esc(hTN(ru, data.users))}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="champ-sub" style="font-family:var(--mono);">High score</div>
          <div style="font-family:var(--mono);font-size:13px;font-weight:600;">${hs.pts.toFixed(2)}</div>
          <div class="champ-sub">${esc(hs.roster ? hTN(hs.roster, data.users) : '?')}</div>
        </div>`;
    }
    tbody.appendChild(row);
  });
  tc.appendChild(tbody);
  container.appendChild(tc);
}

function buildSeasonView(container, year){
  const data = histData[year];
  if(!data){ container.innerHTML = `<div class="card"><div class="card-empty">No data for ${year}.</div></div>`; return; }
  container.innerHTML = '';

  const { rosters: ros, users: usr, matchups: mus } = data;
  const champ = getChampion(data), ru = getRunnerUp(data);
  const hs = getHighScore(data), ts = getTopScorer(data);

  const hc = document.createElement('div');
  hc.className = 'card';
  hc.innerHTML = `<div class="card-head"><div><div class="card-title">${year} Season</div>
    <div class="card-sub">${esc(data.league.name || '')}</div></div></div>`
    + (champ ? `<div style="display:flex;align-items:center;gap:16px;padding:18px 20px;border-bottom:1px solid var(--border);">
        ${avHtml(hAV(champ, usr), 'champ-av', 'champ-ph', '🏆')}
        <div><div class="champ-label">🏆 ${year} Champion</div>
        <div style="font-size:21px;font-weight:800;">${esc(hTN(champ, usr))}</div>
        <div class="champ-sub">${esc(hDN(champ, usr))}${ru ? ' · Runner-up: ' + esc(hTN(ru, usr)) : ''}</div></div>
      </div>`
      : `<div style="padding:18px 20px;border-bottom:1px solid var(--border);" class="hist-note">⏳ ${year} — in progress</div>`)
    + `<div style="display:grid;grid-template-columns:1fr 1fr;">
        <div style="padding:14px 20px;border-right:1px solid var(--border);">
          <div class="rec-title">🔥 High score</div>
          <div style="font-family:var(--display);font-size:20px;font-weight:700;margin:3px 0;">${hs.pts.toFixed(2)}</div>
          <div class="champ-sub">${esc(hs.roster ? hTN(hs.roster, usr) + ' · W' + hs.week : '')}</div>
        </div>
        <div style="padding:14px 20px;">
          <div class="rec-title">📈 Top scorer</div>
          <div style="font-family:var(--display);font-size:20px;font-weight:700;margin:3px 0;">${ts.total.toFixed(1)}</div>
          <div class="champ-sub">${esc(ts.roster ? hTN(ts.roster, usr) : '')}</div>
        </div>
      </div>`;
  container.appendChild(hc);

  const pf = {}, maxPf = {};
  ros.forEach(r => { pf[r.roster_id] = 0; maxPf[r.roster_id] = 0; });
  Object.values(mus).forEach(wk => wk.forEach(m => {
    pf[m.roster_id] = (pf[m.roster_id] || 0) + (m.points || 0);
    if((m.points || 0) > maxPf[m.roster_id]) maxPf[m.roster_id] = m.points || 0;
  }));

  const sc = document.createElement('div');
  sc.className = 'card';
  sc.innerHTML = `<div class="card-head"><div class="card-title">${year} Regular Season</div></div>`;
  const sb = document.createElement('div');
  [...ros].sort((a,b) => (b.settings?.wins || 0) - (a.settings?.wins || 0)).forEach((r, i) => {
    const w = r.settings?.wins || 0, l = r.settings?.losses || 0;
    const pct = ((w / ((w + l) || 1)) * 100).toFixed(1);
    const weeksPlayed = Object.values(mus).filter(wk => wk.find(m => m.roster_id === r.roster_id && m.points > 0)).length;
    const isChamp = champ && r.roster_id === champ.roster_id;
    const isRu = ru && r.roster_id === ru.roster_id;
    const row = document.createElement('div');
    row.className = 'stand-row';
    if(isChamp) row.style.background = 'var(--gold-bg)';
    row.innerHTML = `
      <div class="stand-rank${i === 0 ? ' top' : ''}">${i+1}</div>
      <div style="display:flex;align-items:center;gap:12px;min-width:0;">
        ${avHtml(hAV(r, usr), 'av', 'av-placeholder')}
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="stand-name" style="font-size:15px;">${esc(hTN(r, usr))}</span>
            ${isChamp ? '<span class="trophy" style="font-size:11px;padding:2px 8px;">🏆 Champ</span>' : ''}
            ${isRu ? '<span class="trophy silver" style="font-size:11px;padding:2px 8px;">🥈 2nd</span>' : ''}
          </div>
          <div class="stand-meta" style="margin-top:3px;">
            <span><strong style="color:var(--c1);">${w}</strong>W–<strong style="color:var(--c3);">${l}</strong>L</span>
            <span>${pct}%</span>
            <span>PF ${(pf[r.roster_id] || 0).toFixed(1)}</span>
            <span>Avg ${(weeksPlayed ? pf[r.roster_id] / weeksPlayed : 0).toFixed(1)}</span>
            <span>Best ${(maxPf[r.roster_id] || 0).toFixed(1)}</span>
          </div>
        </div>
      </div>
      <div></div>`;
    sb.appendChild(row);
  });
  sc.appendChild(sb);
  container.appendChild(sc);
}

/* ═══ WEEKLY REPORT ═════════════════════════════════════════════════════════
   Renders to a real <canvas> rather than SVG-in-an-<img>, for two reasons:
   fonts loaded by the page actually apply, and there's no cross-origin
   tainting to trip over (we draw initials, never remote avatars).
   ═══════════════════════════════════════════════════════════════════════════ */

const REPORT_W = 1080;
let _reportWeek = null;

function weeksWithScores(){
  const out = [];
  for(let w = 1; w <= 17; w++){
    if((matchups[w] || []).some(m => (m.points || 0) > 0)) out.push(w);
  }
  return out;
}

function buildReportWeeks(){
  const sel = $('reportWeek');
  if(!sel) return;
  const weeks = weeksWithScores();
  const current = sel.value;
  sel.innerHTML = weeks.length
    ? weeks.map(w => `<option value="${w}">Week ${w}</option>`).join('')
    : '<option value="">—</option>';
  if(current && weeks.includes(Number(current))) sel.value = current;
  else if(weeks.length) sel.value = String(weeks[weeks.length - 1]);
}

function reportData(week){
  const wk = matchups[week] || [];
  let top = null;
  wk.forEach(m => {
    if((m.points || 0) > 0 && (!top || m.points > top.points)){
      const ros = rosters.find(r => r.roster_id === m.roster_id);
      if(ros) top = { name: tName(ros), points: m.points };
    }
  });

  const leaders = GAMES.map(g => {
    const l = leaderFor(g.id);
    return { game: g, name: l ? tName(l.ros) : null, val: l ? l.val : null };
  });

  const now = Date.now();
  const upcoming = (DEADLINES || [])
    .map(d => ({ ...d, ms: new Date(d.date).getTime() - now }))
    .filter(d => d.ms > 0)
    .sort((a,b) => a.ms - b.ms)[0] || null;

  return { top, leaders, upcoming };
}

function buildReport(argWeek){
  const sel = $('reportWeek');
  if(!sel) return;
  if(!sel.options.length || !sel.value) buildReportWeeks();

  if(argWeek && [...sel.options].some(o => o.value === String(argWeek))) sel.value = String(argWeek);
  const week = Number(sel.value);
  _reportWeek = week || null;

  const wrap = $('reportCanvas'), textEl = $('reportText');
  if(!week){
    if(wrap) wrap.innerHTML = '<div class="card-empty"><div class="icon">📊</div>No scored weeks yet. The report unlocks once Week 1 posts.</div>';
    if(textEl) textEl.textContent = '';
    return;
  }

  const data = reportData(week);
  if(textEl) textEl.textContent = reportText(week, data);

  const render = () => {
    const canvas = drawReport(week, data);
    if(wrap){
      wrap.innerHTML = '';
      canvas.style.maxWidth = '100%';
      canvas.style.height = 'auto';
      canvas.setAttribute('role','img');
      canvas.setAttribute('aria-label', `Week ${week} report card`);
      wrap.appendChild(canvas);
    }
  };
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(render).catch(render);
  else render();
}

function reportText(week, { top, leaders, upcoming }){
  const lines = [];
  lines.push(`🏈 ${(LEAGUE_CONFIG.leagueName || 'League').toUpperCase()} — WEEK ${week}`);
  lines.push('');
  if(top) lines.push(`🔥 Top score: ${top.name} — ${top.points.toFixed(1)}`);
  lines.push('');
  lines.push('👑 MINIGAME LEADERS');
  leaders.forEach(l => {
    lines.push(l.name ? `${l.game.name} · ${l.name} ${l.val}` : `${l.game.name} · not started`);
  });
  if(upcoming){
    lines.push('');
    lines.push(`⏰ ${upcoming.label} in ${fmtCountdown(upcoming.ms)}`);
  }
  lines.push('');
  lines.push(reportUrl(week));
  return lines.join('\n');
}

function reportUrl(week){
  return location.origin + location.pathname + '#/' + SLUG + '/report/' + week;
}

function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawReport(week, { top, leaders, upcoming }){
  const rowH = 92;
  const headH = 470;
  const footH = upcoming ? 190 : 130;
  const H = headH + leaders.length * rowH + footH;

  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = REPORT_W * dpr;
  canvas.height = H * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);

  const BG = cssVar('--bg') || '#f4f1ec';
  const SURF = cssVar('--surface') || '#ffffff';
  const TEXT = cssVar('--text') || '#1c1916';
  const TEXT2 = cssVar('--text2') || '#5c5248';
  const TEXT3 = cssVar('--text3') || '#6f645b';
  const BORDER = cssVar('--border') || '#ddd8ce';
  const ACCENT = cssVar('--accent') || '#2d6a4f';

  const PAD = 64;
  c.fillStyle = BG;
  c.fillRect(0, 0, REPORT_W, H);
  c.fillStyle = ACCENT;
  c.fillRect(0, 0, REPORT_W, 14);

  const truncate = (txt, font, max) => {
    c.font = font;
    let s = String(txt);
    if(c.measureText(s).width <= max) return s;
    while(s.length > 1 && c.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };
  const line = y => {
    c.strokeStyle = BORDER; c.lineWidth = 1;
    c.beginPath(); c.moveTo(PAD, y + .5); c.lineTo(REPORT_W - PAD, y + .5); c.stroke();
  };

  let y = 96;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';

  // Eyebrow
  c.fillStyle = TEXT3;
  c.font = '500 24px "Roboto Mono", monospace';
  c.fillText((LEAGUE_CONFIG.leagueName || 'League').toUpperCase(), PAD, y);

  // Week
  y += 84;
  c.fillStyle = TEXT;
  c.font = '900 84px Fraunces, Georgia, serif';
  c.fillText('Week ' + week, PAD, y);

  c.fillStyle = TEXT3;
  c.font = '400 26px "Roboto Mono", monospace';
  c.textAlign = 'right';
  c.fillText('MiniGames · ' + (LEAGUE_CONFIG.season || ''), REPORT_W - PAD, y);
  c.textAlign = 'left';

  y += 42;
  line(y);

  // Top score
  y += 56;
  c.fillStyle = TEXT3;
  c.font = '500 22px "Roboto Mono", monospace';
  c.fillText('TOP SCORE THIS WEEK', PAD, y);

  y += 54;
  if(top){
    c.fillStyle = TEXT;
    const f = '700 44px Fraunces, Georgia, serif';
    c.font = f;
    c.fillText(truncate(top.name, f, REPORT_W - PAD * 2 - 240), PAD, y);
    c.fillStyle = ACCENT;
    c.font = '700 44px "Roboto Mono", monospace';
    c.textAlign = 'right';
    c.fillText(top.points.toFixed(1), REPORT_W - PAD, y);
    c.textAlign = 'left';
  } else {
    c.fillStyle = TEXT3;
    c.font = '400 32px "IBM Plex Sans", sans-serif';
    c.fillText('No scores posted yet', PAD, y);
  }

  y += 40;
  line(y);

  // Leaders
  y += 54;
  c.fillStyle = TEXT3;
  c.font = '500 22px "Roboto Mono", monospace';
  c.fillText('MINIGAME LEADERS', PAD, y);

  y += 26;
  leaders.forEach(l => {
    const col = cssVar('--game-' + l.game.color) || ACCENT;

    // Card
    c.fillStyle = SURF;
    roundRect(c, PAD, y, REPORT_W - PAD * 2, rowH - 12, 12);
    c.fill();
    c.fillStyle = col;
    roundRect(c, PAD, y, 6, rowH - 12, 3);
    c.fill();

    const tx = PAD + 34;
    c.fillStyle = col;
    c.font = '700 30px Fraunces, Georgia, serif';
    c.fillText(truncate(l.game.name, '700 30px Fraunces, Georgia, serif', 420), tx, y + 36);

    c.fillStyle = l.name ? TEXT2 : TEXT3;
    c.font = '500 25px "IBM Plex Sans", sans-serif';
    c.fillText(truncate(l.name || 'Not started', '500 25px "IBM Plex Sans", sans-serif', 420), tx, y + 68);

    c.textAlign = 'right';
    c.fillStyle = l.val ? col : TEXT3;
    c.font = '700 34px "Roboto Mono", monospace';
    c.fillText(l.val || '—', REPORT_W - PAD - 26, y + 54);
    c.textAlign = 'left';

    y += rowH;
  });

  // Deadline
  y += 22;
  if(upcoming){
    const g = GAMES.find(x => x.id === upcoming.gameId);
    const col = g ? (cssVar('--game-' + g.color) || ACCENT) : ACCENT;
    c.fillStyle = col;
    roundRect(c, PAD, y, REPORT_W - PAD * 2, 84, 12);
    c.fill();
    c.fillStyle = '#ffffff';
    c.font = '600 26px "IBM Plex Sans", sans-serif';
    c.fillText('⏰ ' + upcoming.label, PAD + 28, y + 51);
    c.textAlign = 'right';
    c.font = '700 30px "Roboto Mono", monospace';
    c.fillText(fmtCountdown(upcoming.ms) || 'Locked', REPORT_W - PAD - 28, y + 51);
    c.textAlign = 'left';
    y += 108;
  }

  // Footer
  c.fillStyle = TEXT3;
  c.font = '400 24px "Roboto Mono", monospace';
  c.textAlign = 'center';
  c.fillText(location.host || 'dynastyminigames.com', REPORT_W / 2, y + 40);
  c.textAlign = 'left';

  return canvas;
}

function roundRect(c, x, y, w, h, r){
  c.beginPath();
  if(c.roundRect) c.roundRect(x, y, w, h, r);
  else {
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
}

function reportStatus(msg){
  const el = $('reportStatus');
  if(!el) return;
  el.textContent = msg;
  clearTimeout(window._reportStatusT);
  window._reportStatusT = setTimeout(() => { el.textContent = ''; }, 2600);
}

async function copyText(txt, okMsg){
  try {
    await navigator.clipboard.writeText(txt);
    reportStatus(okMsg);
  } catch(e){
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); reportStatus(okMsg); }
    catch(err){ reportStatus('Copy failed — select the text below instead'); }
    ta.remove();
  }
}

function copyReportText(){
  const txt = $('reportText')?.textContent || '';
  if(!txt) return reportStatus('Nothing to copy yet');
  copyText(txt, 'Copied — paste it in the group chat');
}
function copyReportLink(){
  if(!_reportWeek) return reportStatus('Pick a week first');
  copyText(reportUrl(_reportWeek), 'Link copied');
}
function downloadReportImage(){
  const canvas = $('reportCanvas')?.querySelector('canvas');
  if(!canvas) return reportStatus('Nothing to download yet');
  canvas.toBlob(blob => {
    if(!blob) return reportStatus('Image export failed');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${SLUG}-week-${_reportWeek}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    reportStatus('Saved — drop it in Sleeper or your group text');
  }, 'image/png');
}

/* ═══ INIT ══════════════════════════════════════════════════════════════════ */

function buildAll(){
  buildTrailer();
  buildGames();
  buildMyStrip();
  buildCountdowns();
  buildCalendar();
  buildGamePages();
  buildReportWeeks();
  maybePromptTeam();
  renderRoute();
}

/* The nav sticks below the header, so its offset must track the header's real
   height — which shifts when webfonts land or the viewport narrows. */
function syncHeaderOffset(){
  const h = document.querySelector('.header');
  if(h) document.documentElement.style.setProperty('--header-h', h.offsetHeight + 'px');
}
window.addEventListener('resize', syncHeaderOffset);
if(document.fonts && document.fonts.ready) document.fonts.ready.then(syncHeaderOffset).catch(() => {});

function startApp(){
  syncHeaderOffset();
  buildLeagueSwitcher();
  buildNav();
  buildTrailer();
  buildCalendar();
  buildGames();
  buildCountdowns();
  buildSkeletonPages();
  renderRoute();
  loadLive();
}

bootstrap();

// Safety net: never leave someone staring at the splash forever.
setTimeout(() => {
  const el = $('splashOverlay');
  if(el && !el.classList.contains('hide') && !$('splashActions')?.innerHTML){
    console.warn('splash still up after 15s — forcing hide');
    hideSplash();
  }
}, 15000);
