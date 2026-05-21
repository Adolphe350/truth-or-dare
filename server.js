require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ===================== STATS =====================

const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let stats = {
  totalVisits: 0,
  totalRoomsCreated: 0,
  totalGamesStarted: 0,
  totalQuestionsGenerated: 0,
  totalPlayers: 0,
  uniqueNames: [],
  gameTypeCounts: { 'truth-or-dare': 0, 'truth-only': 0, 'dare-only': 0, 'know-me': 0 },
  langCounts: { en: 0, fr: 0 },
  dailyStats: {},
  monthlyStats: {},
  lastUpdated: null
};

let recentActivity = []; // last 50 events

try {
  if (fs.existsSync(STATS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    stats = { ...stats, ...loaded };
    if (!Array.isArray(stats.uniqueNames)) stats.uniqueNames = [];
  }
  if (fs.existsSync(ACTIVITY_FILE)) {
    recentActivity = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
  }
} catch(e) { console.error('Stats load error:', e.message); }

function saveStats() {
  try {
    stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(recentActivity.slice(0,50), null, 2));
  } catch(e) { console.error('Stats save error:', e.message); }
}

function today() { return new Date().toISOString().split('T')[0]; }
function monthKey(dateStr = today()) { return String(dateStr).slice(0, 7); }
function emptyBucket() { return { visits:0, rooms:0, games:0, questions:0 }; }
function emptyAggregate() {
  return {
    totalVisits: 0,
    totalRoomsCreated: 0,
    totalGamesStarted: 0,
    totalQuestionsGenerated: 0,
    totalPlayers: 0,
    uniqueNames: [],
    gameTypeCounts: { 'truth-or-dare': 0, 'truth-only': 0, 'dare-only': 0, 'know-me': 0 },
    langCounts: { en: 0, fr: 0 },
    dailyStats: {}
  };
}
function ensureDay(dateStr) {
  if (!stats.dailyStats[dateStr]) stats.dailyStats[dateStr] = emptyBucket();
  const mk = monthKey(dateStr);
  if (!stats.monthlyStats[mk]) stats.monthlyStats[mk] = emptyAggregate();
  if (!stats.monthlyStats[mk].dailyStats[dateStr]) stats.monthlyStats[mk].dailyStats[dateStr] = emptyBucket();
}

function trackVisit() {
  try {
    stats.totalVisits++;
    const d = today();
    const mk = monthKey(d);
    ensureDay(d);
    stats.dailyStats[d].visits++;
    stats.monthlyStats[mk].totalVisits++;
    stats.monthlyStats[mk].dailyStats[d].visits++;
    saveStats();
  } catch(e) {}
}

function trackRoom(gameType, lang) {
  try {
    stats.totalRoomsCreated++;
    if (stats.gameTypeCounts[gameType] !== undefined) stats.gameTypeCounts[gameType]++;
    if (stats.langCounts[lang] !== undefined) stats.langCounts[lang]++;
    const d = today();
    const mk = monthKey(d);
    ensureDay(d);
    stats.dailyStats[d].rooms++;
    stats.monthlyStats[mk].totalRoomsCreated++;
    stats.monthlyStats[mk].dailyStats[d].rooms++;
    if (stats.monthlyStats[mk].gameTypeCounts[gameType] !== undefined) stats.monthlyStats[mk].gameTypeCounts[gameType]++;
    if (stats.monthlyStats[mk].langCounts[lang] !== undefined) stats.monthlyStats[mk].langCounts[lang]++;
    saveStats();
  } catch(e) {}
}

function trackGame() {
  try {
    stats.totalGamesStarted++;
    const d = today();
    const mk = monthKey(d);
    ensureDay(d);
    stats.dailyStats[d].games++;
    stats.monthlyStats[mk].totalGamesStarted++;
    stats.monthlyStats[mk].dailyStats[d].games++;
    saveStats();
  } catch(e) {}
}

function trackQuestion() {
  try {
    stats.totalQuestionsGenerated++;
    const d = today();
    const mk = monthKey(d);
    ensureDay(d);
    stats.dailyStats[d].questions++;
    stats.monthlyStats[mk].totalQuestionsGenerated++;
    stats.monthlyStats[mk].dailyStats[d].questions++;
    if (stats.totalQuestionsGenerated % 10 === 0) saveStats(); // save every 10 questions
  } catch(e) {}
}

function trackPlayer(name, roomId, gameType, lang) {
  try {
    stats.totalPlayers++;
    if (!stats.uniqueNames.includes(name)) stats.uniqueNames.push(name);
    const mk = monthKey();
    if (!stats.monthlyStats[mk]) stats.monthlyStats[mk] = emptyAggregate();
    stats.monthlyStats[mk].totalPlayers++;
    if (!stats.monthlyStats[mk].uniqueNames.includes(name)) stats.monthlyStats[mk].uniqueNames.push(name);
    recentActivity.unshift({ type:'join', name, roomId, gameType, lang, ts: new Date().toISOString() });
    recentActivity = recentActivity.slice(0, 50);
    saveStats();
  } catch(e) {}
}

function buildScopedStats(scopeMonth) {
  if (!scopeMonth || scopeMonth === 'all') {
    return {
      scope: 'all',
      month: 'all',
      totalVisits: stats.totalVisits,
      totalRoomsCreated: stats.totalRoomsCreated,
      totalGamesStarted: stats.totalGamesStarted,
      totalQuestionsGenerated: stats.totalQuestionsGenerated,
      totalPlayers: stats.totalPlayers,
      uniqueNames: Array.isArray(stats.uniqueNames) ? stats.uniqueNames : [],
      gameTypeCounts: stats.gameTypeCounts || emptyAggregate().gameTypeCounts,
      langCounts: stats.langCounts || emptyAggregate().langCounts,
      dailyStats: stats.dailyStats || {},
      monthsAvailable: Object.keys(stats.monthlyStats || {}).sort().reverse()
    };
  }

  const monthData = stats.monthlyStats?.[scopeMonth] || emptyAggregate();
  return {
    scope: 'month',
    month: scopeMonth,
    totalVisits: monthData.totalVisits || 0,
    totalRoomsCreated: monthData.totalRoomsCreated || 0,
    totalGamesStarted: monthData.totalGamesStarted || 0,
    totalQuestionsGenerated: monthData.totalQuestionsGenerated || 0,
    totalPlayers: monthData.totalPlayers || 0,
    uniqueNames: Array.isArray(monthData.uniqueNames) ? monthData.uniqueNames : [],
    gameTypeCounts: monthData.gameTypeCounts || emptyAggregate().gameTypeCounts,
    langCounts: monthData.langCounts || emptyAggregate().langCounts,
    dailyStats: monthData.dailyStats || {},
    monthsAvailable: Object.keys(stats.monthlyStats || {}).sort().reverse()
  };
}

// ===================== ADMIN ROUTES =====================

const ADMIN_USER = process.env.ADMIN_USERNAME || 'irankundaadolphe@gmail.com';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'Pindiri2020@';

function isAdmin(req) {
  const username = String(req.query.username || req.headers['x-admin-user'] || '').trim().toLowerCase();
  const password = String(req.query.password || req.query.pw || req.headers['x-admin-pw'] || '').trim();
  return username === ADMIN_USER.toLowerCase() && password === ADMIN_PW;
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/stats', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const scopeMonth = (req.query.month || 'all').trim();
  const scoped = buildScopedStats(scopeMonth);
  const activeRooms = [];
  for (const [id, room] of rooms) {
    activeRooms.push({
      id, gameType: room.gameType, lang: room.lang,
      players: room.players.map(p => p.name),
      rounds: room.currentRound, started: room.gameStarted || false
    });
  }
  res.json({
    ...scoped,
    lastUpdated: stats.lastUpdated,
    uniqueNamesCount: scoped.uniqueNames.length,
    uniqueNames: scoped.uniqueNames.slice(-20),
    activeRooms,
    activeRoomsCount: rooms.size,
    recentActivity: scopeMonth === 'all'
      ? recentActivity.slice(0, 20)
      : recentActivity.filter(a => String(a.ts || '').startsWith(scopeMonth + '-')).slice(0, 20),
    serverTime: new Date().toISOString(),
    adminUser: ADMIN_USER
  });
});

// ===================== END STATS =====================

app.use(express.json());

function withVisitTracking(handler) {
  return (req, res) => { trackVisit(); handler(req, res); };
}

app.get('/truth-or-dare', withVisitTracking((req, res) => res.sendFile(path.join(__dirname, 'public', 'truth-or-dare.html'))));
app.get('/know-me',       withVisitTracking((req, res) => res.sendFile(path.join(__dirname, 'public', 'know-me.html'))));
app.get('/truth-only',    withVisitTracking((req, res) => res.sendFile(path.join(__dirname, 'public', 'truth-only.html'))));
app.get('/dare-only',     withVisitTracking((req, res) => res.sendFile(path.join(__dirname, 'public', 'dare-only.html'))));
app.get('/',              withVisitTracking((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))));
app.get('/test-ai',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'test-ai.html')));
app.post('/api/test-ai',  async (req, res) => {
  try {
    const q1 = await generateTruthOrDare('Alice', [], 'en', 'truth-or-dare');
    const q2 = await generateTruthOrDare('Bob',   [q1], 'en', 'dare-only');
    const q3 = await generateKnowMe('Alice', 'Bob', [q1,q2], 'en');
    res.json({ ok:true, questions:[q1,q2,q3] });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});
app.use(express.static(path.join(__dirname, 'public')));

// ===================== CONSTANTS =====================

// Safe chars — no 0,O,1,I,L to avoid confusion
const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const HOT_TOPICS = [
  'feminism', 'toxic masculinity', 'divorce', 'God and religion',
  'abortion', 'gender roles', 'money in relationships', 'LGBTQ+',
  'social media addiction', 'age gaps in relationships',
  'staying with someone who cheated', 'marrying outside your tribe',
  'polygamy', 'women paying bills', 'men crying in public',
  'virginity before marriage', 'long-distance relationships',
  'following your dream vs a stable job'
];

const langInstructions = {
  en: 'Write in very simple everyday English. Use short words. Short sentences. Anyone should understand it easily.',
  fr: 'Écris en français très simple. Mots courts. Phrases courtes. Tout le monde doit comprendre facilement.'
};

const prefixes = {
  en: { truth: 'TRUTH:', dare: 'DARE:', hottake: 'TOPIC:' },
  fr: { truth: 'VÉRITÉ:', dare: 'ACTION:', hottake: 'SUJET:' }
};

// ===================== ROOMS =====================
const rooms = new Map();

function genRoomId() {
  return Array.from({length:6}, ()=>SAFE_CHARS[Math.floor(Math.random()*SAFE_CHARS.length)]).join('');
}

function sanitizeCode(code) {
  // Normalize ambiguous chars
  return code.toUpperCase()
    .replace(/0/g,'Q').replace(/O/g,'Q') // both → Q (safe)
    .replace(/1/g,'2').replace(/I/g,'J').replace(/L/g,'M')
    .replace(/[^A-Z2-9]/g,'');
}

// ===================== AI =====================

async function generateTruthOrDare(playerName, previousQuestions=[], lang='en', mode='truth-or-dare') {
  const cats = ['family','sex','faith & church','ex relationships','embarrassing moments',
    'fears','fantasies','opinions','childhood','dreams','guilty pleasures','loyalty','money','love & heartbreak'];
  const cat = cats[Math.floor(Math.random()*cats.length)];
  const isTruth = mode==='truth-only' ? true : mode==='dare-only' ? false : Math.random()>0.35;
  const p = prefixes[lang]||prefixes.en;
  const ln = langInstructions[lang]||langInstructions.en;

  const prompt = `Truth or Dare game for two close people. ONE ${isTruth?'truth question':'dare challenge'} for ${playerName}.
Topic: ${cat}
${ln}
Rules: address ${playerName} by name, 1 sentence, personal, creative, a little provocative.
No repeats: ${previousQuestions.slice(-8).join(' | ')}
Reply ONLY with "${isTruth?p.truth:p.dare}" then the question/dare.`;
  return callAI(prompt);
}

async function generateKnowMe(aboutPlayer, guesser, previousQuestions=[], lang='en') {
  const ln = langInstructions[lang]||langInstructions.en;
  const prompt = `"How Well Do You Know Me?" game. ONE question about ${aboutPlayer} that ${guesser} must guess.
${ln}
Topics: favorite color, food, dream place, biggest fear, church, first crush, embarrassing moment, favorite movie,
pet peeve, guilty pleasure, song, nickname, talent, worst date, comfort food, dream job, artist, insecurity,
childhood memory, ideal date, worst habit, season, show, regret, love language, number of exes, turn-off, dealbreaker
Rules: 1 short question. "What is ${aboutPlayer}'s…" or "Who is…" or "How many…"
No repeats: ${previousQuestions.slice(-8).join(' | ')}
Reply ONLY with the question.`;
  return callAI(prompt);
}

async function generateHotTake(topic, lang='en') {
  const ln = langInstructions[lang]||langInstructions.en;
  const p = prefixes[lang]||prefixes.en;
  const prompt = `Controversial discussion game. Write ONE short provocative question about "${topic}" for two people to discuss.
${ln}
Rules: make them share their real opinion, 1 sentence, personal and thought-provoking.
Reply ONLY with "${p.hottake}" then the question.`;
  return callAI(prompt);
}

async function callAI(prompt) {
  try { return await generateWithClaude(prompt); }
  catch(e) {
    console.error('Claude failed:', e.message);
    try { return await generateWithGPT(prompt); }
    catch(e2) { console.error('GPT failed:', e2.message); return 'TRUTH: What is your biggest secret you have never told anyone?'; }
  }
}

async function generateWithClaude(prompt) {
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION||'us-east-1',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  });
  const r = await client.send(new ConverseCommand({
    modelId: 'us.anthropic.claude-sonnet-4-6',
    messages: [{ role:'user', content:[{ text: prompt }] }],
    inferenceConfig: { maxTokens:120, temperature:0.99 }
  }));
  return r.output.message.content[0].text.trim();
}

async function generateWithGPT(prompt) {
  const r = await axios.post(
    `${process.env.AZURE_FOUNDRY_ENDPOINT}/chat/completions`,
    { model:'gpt-5.5-1', messages:[{role:'user',content:prompt}], max_completion_tokens:120, temperature:1.0 },
    { headers:{'Content-Type':'application/json','api-key':process.env.AZURE_FOUNDRY_KEY}, timeout:30000 }
  );
  return r.data.choices[0].message.content.trim();
}

// ===================== QUEUE REFILL =====================

async function refillQueue(room) {
  if (room.refilling) return;
  room.refilling = true;
  // Fill each player's queue up to 15 questions
  const jobs = [];
  for (let pidx = 0; pidx < 2; pidx++) {
    const needed = 15 - (room.queues[pidx]||[]).length;
    if (needed <= 0) continue;
    const target = room.players[pidx]?.name;
    const other  = room.players[(pidx+1)%2]?.name;
    if (!target || !other) continue;
    for (let i = 0; i < Math.min(needed, 5); i++) {
      if (room.gameType === 'know-me')
        jobs.push({ pidx, p: generateKnowMe(target, other, room.previousQuestions, room.lang).catch(()=>null) });
      else
        jobs.push({ pidx, p: generateTruthOrDare(target, room.previousQuestions, room.lang, room.gameType).catch(()=>null) });
    }
  }
  const results = await Promise.allSettled(jobs.map(j=>j.p));
  results.forEach((r, i) => {
    if (r.status==='fulfilled' && r.value) {
      if (!room.queues[jobs[i].pidx]) room.queues[jobs[i].pidx] = [];
      room.queues[jobs[i].pidx].push(r.value);
    }
  });
  room.refilling = false;
  // Always keep refilling
  const minQ = Math.min((room.queues[0]||[]).length, (room.queues[1]||[]).length);
  if (minQ < 10) setTimeout(()=>refillQueue(room), 800);
}

// ===================== SEND NEXT QUESTION =====================

async function sendNextQuestion(room) {
  room.currentRound++;

  // Insert hot take every 3 rounds
  if (room.currentRound > 1 && room.currentRound % 3 === 0 && room.hotTopicsUsed < HOT_TOPICS.length) {
    const topicIdx = room.hotTopicsUsed % HOT_TOPICS.length;
    const topic = HOT_TOPICS[topicIdx];
    room.hotTopicsUsed++;
    const q = await generateHotTake(topic, room.lang);
    room.previousQuestions.push(q);
    const p1 = room.players[0]?.name || 'Player 1';
    const p2 = room.players[1]?.name || 'Player 2';
    trackQuestion();
    io.to(room.id).emit('new-question', {
      question: q.replace(/^(TOPIC:|SUJET:)\s*/i,''),
      targetPlayer: `${p1} & ${p2}`,
      isHotTake: true,
      topic,
      confirmations: 0,
      needed: room.sameDevice ? 1 : 2
    });
    return;
  }

  const idx = room.currentRound % 2;
  const otherIdx = (idx+1)%2;
  const target = room.players[idx];
  const other  = room.players[otherIdx];

  // Pop from this player's dedicated queue — correct name guaranteed
  let question;
  if (room.queues && room.queues[idx] && room.queues[idx].length > 0) {
    question = room.queues[idx].shift();
  } else {
    // Fallback: generate on the fly
    if (room.gameType === 'know-me') question = await generateKnowMe(target.name, other.name, room.previousQuestions, room.lang);
    else question = await generateTruthOrDare(target.name, room.previousQuestions, room.lang, room.gameType);
  }
  room.previousQuestions.push(question);
  trackQuestion();

  // Refill both queues in background
  const minQ = Math.min((room.queues?.[0]||[]).length, (room.queues?.[1]||[]).length);
  if (minQ < 8) setImmediate(()=>refillQueue(room));

  io.to(room.id).emit('new-question', {
    question,
    targetPlayer: target.name,
    guesser: other.name,
    isHotTake: false,
    confirmations: 0,
    needed: room.sameDevice ? 1 : 2
  });
}

// ===================== SOCKET =====================

io.on('connection', (socket) => {

  // Unified create-or-join: first player creates, second player joins automatically
  socket.on('enter-room', (data) => {
    const roomId = (data.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,6);
    if (!roomId) { socket.emit('error', { message: 'Enter a room code.' }); return; }

    const isNewRoom = !rooms.has(roomId);
    if (isNewRoom) {
      // Create the room
      rooms.set(roomId, {
        id: roomId,
        gameType: data.gameType||'truth-or-dare',
        lang: data.lang||'en',
        players: [],
        previousQuestions: [],
        queues: [[], []],
        confirmations: new Set(),
        confirmedPlayers: new Set(),
        sameDevice: false,
        currentRound: 0,
        hotTopicsUsed: 0,
        refilling: false,
        gameStarted: false
      });
      trackRoom(data.gameType||'truth-or-dare', data.lang||'en');
    }

    const room = rooms.get(roomId);
    if (room.players.length >= 2) {
      const existing = room.players.find(p => p.name === data.name);
      if (!existing) { socket.emit('error', { message: 'Room is full!' }); return; }
      existing.id = socket.id; // rejoin
    } else {
      // Remove stale entry for same name then add
      room.players = room.players.filter(p => p.name !== data.name);
      room.players.push({ id: socket.id, name: data.name });
      trackPlayer(data.name, roomId, room.gameType, room.lang);
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = data.name;

    if (room.players.length === 1) {
      // First player — show waiting screen
      socket.emit('room-created', { roomId, players: room.players });
    } else {
      // Second player — notify both
      io.to(roomId).emit('player-joined', { players: room.players, roomId });
    }
  });

  socket.on('create-room', (data) => {
    // Legacy same-device path
    let roomId = data.customCode
      ? data.customCode.toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,6)
      : genRoomId();
    if (!roomId) roomId = genRoomId();
    // If custom code taken, try variations
    if (rooms.has(roomId) && rooms.get(roomId).players.length >= 2) {
      socket.emit('error', { message: 'That code is already in use. Try another.' }); return;
    }
    // Allow rejoining own room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        gameType: data.gameType||'truth-or-dare',
        lang: data.lang||'en',
        players: [],
        previousQuestions: [],
        queues: [[], []], // one queue per player index
        confirmations: new Set(),
        confirmedPlayers: new Set(),
        sameDevice: data.sameDevice||false,
        currentRound: 0,
        hotTopicsUsed: 0,
        refilling: false,
        gameStarted: false
      });
      trackRoom(data.gameType||'truth-or-dare', data.lang||'en');
    }
    const room = rooms.get(roomId);
    // Remove stale socket entry for same name
    room.players = room.players.filter(p => p.name !== data.name);
    room.players.push({ id: socket.id, name: data.name });
    trackPlayer(data.name, roomId, room.gameType, room.lang);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = data.name;
    socket.emit('room-created', { roomId, players: room.players });
  });

  socket.on('join-room', (data) => {
    const code = (data.roomId||'').toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,6);
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'Room not found. Check the code.' }); return; }
    // Allow rejoin if same name
    const existing = room.players.find(p => p.name === data.name);
    if (existing) { existing.id = socket.id; }
    else if (room.players.length >= 2) { socket.emit('error', { message: 'Room is full!' }); return; }
    else { room.players.push({ id: socket.id, name: data.name }); }
    socket.join(code);
    socket.roomId = code;
    socket.playerName = data.name;
    io.to(code).emit('player-joined', { players: room.players, roomId: code });
  });

  socket.on('same-device-mode', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.players.length < 2) {
      room.players.push({ id: 'same-device-p2', name: data.name2 });
      room.sameDevice = true;
      io.to(socket.roomId).emit('player-joined', { players: room.players, roomId: socket.roomId });
    }
  });

  socket.on('start-game', async () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.players.length < 2) return;
    room.confirmations.clear();
    room.confirmedPlayers.clear();
    room.gameStarted = true;
    trackGame();
    // Pre-generate 20 questions immediately
    refillQueue(room);
    // Small delay to let first batch generate, then send first question
    setTimeout(()=>sendNextQuestion(room), 1500);
  });

  socket.on('confirm-next', async () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    if (room.sameDevice) {
      room.confirmations.add(`${socket.id}-${Date.now()}`);
      room.confirmedPlayers.clear();
    } else {
      room.confirmations.add(socket.id);
      room.confirmedPlayers.add(socket.id);
    }

    const needed = room.sameDevice ? 1 : 2;
    // Tell everyone who's confirmed
    io.to(socket.roomId).emit('confirmation-update', {
      confirmations: room.confirmations.size,
      needed,
      confirmedSocketId: socket.id
    });

    if (room.confirmations.size >= needed) {
      room.confirmations.clear();
      room.confirmedPlayers.clear();
      await sendNextQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        // Don't remove player on disconnect — allow rejoin by name
        setTimeout(() => {
          // Clean up after 5 min if still disconnected
          if (!io.sockets.adapter.rooms.get(socket.roomId)) rooms.delete(socket.roomId);
        }, 5 * 60 * 1000);
      }
    }
  });
});

// Cleanup rooms with no activity for 2 hours
setInterval(() => { for (const [id, room] of rooms) { if (room.players.length === 0) rooms.delete(id); } }, 30*60*1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🎲 Dare AI running on port ${PORT}`));
