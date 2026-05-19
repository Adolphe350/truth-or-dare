require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.get('/truth-or-dare', (req, res) => res.sendFile(path.join(__dirname, 'public', 'truth-or-dare.html')));
app.get('/know-me',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'know-me.html')));
app.get('/truth-only',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'truth-only.html')));
app.get('/dare-only',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'dare-only.html')));
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
  const needed = 30 - room.queue.length;
  if (needed <= 0) { room.refilling = false; return; }
  const batch = Math.min(needed, 10);
  const jobs = Array.from({length: batch}, (_, i) => {
    const idx = (room.currentRound + room.queue.length + i + 1) % 2;
    const otherIdx = (idx+1)%2;
    if (!room.players[idx] || !room.players[otherIdx]) return null;
    const target = room.players[idx].name;
    const other  = room.players[otherIdx].name;
    if (room.gameType === 'know-me') return generateKnowMe(target, other, room.previousQuestions, room.lang).catch(()=>null);
    return generateTruthOrDare(target, room.previousQuestions, room.lang, room.gameType).catch(()=>null);
  }).filter(Boolean);
  const results = await Promise.allSettled(jobs);
  results.forEach(r => { if (r.status==='fulfilled' && r.value) room.queue.push(r.value); });
  room.refilling = false;
  // Always keep refilling — game never runs out
  if (room.queue.length < 20) setTimeout(()=>refillQueue(room), 800);
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

  // Pop from pre-generated queue if available (instant!)
  let question;
  if (room.queue.length > 0) {
    question = room.queue.shift();
  } else {
    // Fallback: generate on the fly
    if (room.gameType === 'know-me') question = await generateKnowMe(target.name, other.name, room.previousQuestions, room.lang);
    else question = await generateTruthOrDare(target.name, room.previousQuestions, room.lang, room.gameType);
  }
  room.previousQuestions.push(question);

  // Refill queue in background
  if (room.queue.length < 15) setImmediate(()=>refillQueue(room));

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

  socket.on('create-room', (data) => {
    let roomId = data.customCode ? sanitizeCode(data.customCode).substring(0,6) : genRoomId();
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
        queue: [],
        confirmations: new Set(),
        confirmedPlayers: new Set(),
        sameDevice: data.sameDevice||false,
        currentRound: 0,
        hotTopicsUsed: 0,
        refilling: false
      });
    }
    const room = rooms.get(roomId);
    // Remove stale socket entry for same name
    room.players = room.players.filter(p => p.name !== data.name);
    room.players.push({ id: socket.id, name: data.name });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = data.name;
    socket.emit('room-created', { roomId, players: room.players });
  });

  socket.on('join-room', (data) => {
    const code = sanitizeCode(data.roomId||'');
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
