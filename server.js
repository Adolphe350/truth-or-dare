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
app.get('/know-me', (req, res) => res.sendFile(path.join(__dirname, 'public', 'know-me.html')));
app.get('/truth-only', (req, res) => res.sendFile(path.join(__dirname, 'public', 'truth-only.html')));
app.get('/dare-only', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dare-only.html')));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ===================== AI =====================

const langInstructions = {
  en: 'Write in simple English. Use easy words that anyone can understand. Short sentences.',
  fr: 'Écris en français simple. Utilise des mots faciles que tout le monde comprend. Phrases courtes.'
};

const truthDarePrefix = {
  en: { truth: 'TRUTH:', dare: 'DARE:' },
  fr: { truth: 'VÉRITÉ:', dare: 'ACTION:' }
};

async function generateTruthOrDare(playerName, previousQuestions = [], lang = 'en', mode = 'mixed') {
  const categories = ['family', 'sex', 'faith/church', 'ex relationships', 'embarrassing moments', 'fears', 'fantasies', 'opinions', 'childhood', 'dreams', 'guilty pleasures', 'loyalty', 'money', 'love & heartbreak'];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const isTruth = mode === 'truth-only' ? true : mode === 'dare-only' ? false : Math.random() > 0.3;
  const prefix = truthDarePrefix[lang] || truthDarePrefix.en;
  const langNote = langInstructions[lang] || langInstructions.en;

  const prompt = `You host a Truth or Dare game for two close people. Generate ONE ${isTruth ? 'truth question' : 'dare'} for ${playerName}.

Topic: ${category}

${langNote}

Rules:
- ${isTruth ? 'Ask something personal they would not normally admit' : 'Give a fun dare they can do right now'}
- Use the player name
- 1 sentence only
- Be creative, fun, a bit provocative
- Do NOT repeat: ${previousQuestions.slice(-5).join(' | ')}

Reply with ONLY "${isTruth ? prefix.truth : prefix.dare}" followed by the question/dare. Nothing else.`;

  return await callAI(prompt);
}

async function generateKnowMeQuestion(aboutPlayer, guesser, previousQuestions = [], lang = 'en') {
  const langNote = langInstructions[lang] || langInstructions.en;

  const prompt = `You host a "How Well Do You Know Me?" game. Generate ONE question about ${aboutPlayer} that ${guesser} must guess.

${langNote}

Topics (pick one): favorite color, favorite food, dream place, biggest fear, church, first crush, embarrassing moment, favorite movie, pet peeve, guilty pleasure, favorite song, nickname, talent, worst date, comfort food, dream job, favorite verse, favorite artist, insecurity, childhood memory, ideal date, worst habit, favorite season, favorite show, regret, love language, morning/night person, cats/dogs, number of exes, most used app, turn-off, dealbreaker

Rules:
- Simple words
- 1 short question
- Format: "What is ${aboutPlayer}'s..." or "Who..." or "How many..."
- Do NOT repeat: ${previousQuestions.slice(-5).join(' | ')}

Reply ONLY with the question. Nothing else.`;

  return await callAI(prompt);
}

async function callAI(prompt) {
  try {
    return await generateWithClaude(prompt);
  } catch (err) {
    console.error('Claude failed:', err.message);
    try {
      return await generateWithGPT(prompt);
    } catch (err2) {
      console.error('GPT failed:', err2.message);
      return 'TRUTH: What is your biggest secret?';
    }
  }
}

async function generateWithClaude(prompt) {
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  });
  const response = await client.send(new ConverseCommand({
    modelId: 'us.anthropic.claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 100, temperature: 1.0 }
  }));
  return response.output.message.content[0].text.trim();
}

async function generateWithGPT(prompt) {
  const response = await axios.post(
    `${process.env.AZURE_FOUNDRY_ENDPOINT}/chat/completions`,
    { model: 'gpt-5.5-1', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 100, temperature: 1.1 },
    { headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_FOUNDRY_KEY }, timeout: 30000 }
  );
  return response.data.choices[0].message.content.trim();
}

// ===================== SOCKET =====================

io.on('connection', (socket) => {

  socket.on('create-room', (data) => {
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    rooms.set(roomId, {
      id: roomId,
      gameType: data.gameType || 'truth-or-dare',
      lang: data.lang || 'en',
      players: [{ id: socket.id, name: data.name }],
      previousQuestions: [],
      confirmations: new Set(),
      sameDevice: data.sameDevice || false,
      currentRound: 0
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room-created', { roomId, players: rooms.get(roomId).players });
  });

  socket.on('join-room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit('error', { message: 'Room not found!' }); return; }
    if (room.players.length >= 2) { socket.emit('error', { message: 'Room full!' }); return; }
    room.players.push({ id: socket.id, name: data.name });
    socket.join(data.roomId);
    socket.roomId = data.roomId;
    io.to(data.roomId).emit('player-joined', { players: room.players, roomId: data.roomId });
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
    await sendNextQuestion(room);
  });

  socket.on('confirm-next', async () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.sameDevice) {
      room.confirmations.add(`${socket.id}-${Date.now()}`);
    } else {
      room.confirmations.add(socket.id);
    }
    const needed = room.sameDevice ? 1 : 2;
    io.to(socket.roomId).emit('confirmation-update', { confirmations: room.confirmations.size, needed });
    if (room.confirmations.size >= needed) {
      room.confirmations.clear();
      await sendNextQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) rooms.delete(socket.roomId);
        else io.to(socket.roomId).emit('player-left', { players: room.players });
      }
    }
  });
});

async function sendNextQuestion(room) {
  room.currentRound++;
  const idx = room.currentRound % 2;
  const otherIdx = (idx + 1) % 2;
  const target = room.players[idx];
  const other = room.players[otherIdx];

  let question;
  if (room.gameType === 'know-me') {
    question = await generateKnowMeQuestion(target.name, other.name, room.previousQuestions, room.lang);
  } else {
    question = await generateTruthOrDare(target.name, room.previousQuestions, room.lang, room.gameType);
  }
  room.previousQuestions.push(question);
  io.to(room.id).emit('new-question', {
    question,
    targetPlayer: target.name,
    guesser: other.name,
    confirmations: 0,
    needed: room.sameDevice ? 1 : 2
  });
}

setInterval(() => { for (const [id, room] of rooms) { if (room.players.length === 0) rooms.delete(id); } }, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🎲 Dare AI running on port ${PORT}`));
