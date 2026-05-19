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

// Route pages
app.get('/truth-or-dare', (req, res) => res.sendFile(path.join(__dirname, 'public', 'truth-or-dare.html')));
app.get('/know-me', (req, res) => res.sendFile(path.join(__dirname, 'public', 'know-me.html')));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const rooms = new Map();

// ===================== AI QUESTION GENERATION =====================

async function generateTruthOrDare(playerName, category, previousQuestions = []) {
  const categories = ['family secrets', 'sexual experiences', 'critical thinking dilemmas', 'Christian faith & morality', 'ex relationships', 'embarrassing moments', 'deep fears', 'wild fantasies', 'controversial opinions', 'childhood memories', 'future dreams', 'guilty pleasures', 'friendship loyalty', 'money & greed', 'love & heartbreak'];
  const selectedCategory = category || categories[Math.floor(Math.random() * categories.length)];
  
  const prompt = `You are the host of an intense, no-holds-barred Truth or Dare game between two close friends/partners. Generate ONE ${Math.random() > 0.3 ? 'truth question' : 'dare challenge'} for ${playerName}.

Category: ${selectedCategory}

Rules:
- Be creative, provocative, and fun
- Questions should be personal and revealing
- Dares should be doable but embarrassing/thrilling
- Don't repeat these previous questions: ${previousQuestions.slice(-5).join('; ')}
- Address the player by name
- Keep it to 1-2 sentences max
- Mix between spicy, deep, funny, and uncomfortable
- For truths: ask something they'd normally never admit
- For dares: make it something memorable

Respond with ONLY the question/dare text, nothing else. Start with either "TRUTH:" or "DARE:" followed by the question/challenge.`;

  return await callAI(prompt);
}

async function generateKnowMeQuestion(aboutPlayer, guesser, previousQuestions = []) {
  const topics = ['favorite color', 'favorite food', 'dream vacation', 'biggest fear', 'church name', 'first crush name', 'most embarrassing moment', 'favorite movie', 'pet peeve', 'guilty pleasure food', 'favorite song', 'childhood nickname', 'biggest secret talent', 'worst date story', 'comfort food', 'dream job as a kid', 'favorite Bible verse', 'most-listened artist', 'biggest insecurity', 'favorite childhood memory', 'ideal date night', 'worst habit', 'favorite season', 'go-to comfort show', 'biggest regret', 'love language', 'zodiac sign', 'shoe size', 'morning or night person', 'cats or dogs', 'number of exes', 'last person they texted', 'most used app', 'hidden talent', 'biggest turn-off', 'relationship dealbreaker'];
  
  const prompt = `You are hosting a "How Well Do You Know Me?" game. Generate ONE personal question about ${aboutPlayer} that ${guesser} has to guess the answer to.

Available topics for inspiration: ${topics.slice(0, 10).join(', ')}

Previous questions asked (don't repeat): ${previousQuestions.slice(-5).join('; ')}

Rules:
- The question should be about ${aboutPlayer}'s preferences, experiences, or personality
- It should be something ${guesser} might know if they pay attention
- Mix easy and hard questions
- Include personal stuff: favorites, habits, memories, beliefs, relationships
- Make it fun and revealing
- Keep to one clear question
- Frame it as "What is ${aboutPlayer}'s..." or "How many..." or "What does ${aboutPlayer}..."

Respond with ONLY the question text, nothing else.`;

  return await callAI(prompt);
}

async function callAI(prompt) {
  const useGPT = Math.random() > 0.5;
  try {
    return useGPT ? await generateWithGPT55(prompt) : await generateWithClaude(prompt);
  } catch (err) {
    console.error('Primary AI failed:', err.message);
    try {
      return useGPT ? await generateWithClaude(prompt) : await generateWithGPT55(prompt);
    } catch (err2) {
      console.error('Both AI failed:', err2.message);
      return 'TRUTH: What is your most embarrassing secret that no one else knows?';
    }
  }
}

async function generateWithGPT55(prompt) {
  const response = await axios.post(
    `${process.env.AZURE_FOUNDRY_ENDPOINT}/chat/completions`,
    {
      model: 'gpt-5.5-1',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 200,
      temperature: 1.1
    },
    {
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_FOUNDRY_KEY },
      timeout: 30000
    }
  );
  return response.data.choices[0].message.content.trim();
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
    inferenceConfig: { maxTokens: 200, temperature: 1.0 }
  }));
  return response.output.message.content[0].text.trim();
}

// ===================== SOCKET.IO =====================

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create-room', (data) => {
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    rooms.set(roomId, {
      id: roomId,
      gameType: data.gameType || 'truth-or-dare',
      players: [{ id: socket.id, name: data.name, ready: false }],
      currentQuestion: null,
      currentPlayer: null,
      previousQuestions: [],
      confirmations: new Set(),
      sameDevice: data.sameDevice || false,
      gameStarted: false,
      // Know Me specific
      scores: {},
      knowMeState: null, // { phase, aboutPlayer, guesser, question, guess, realAnswer }
      answerCount: 0,
      currentRound: 0
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = data.name;
    socket.emit('room-created', { roomId, players: rooms.get(roomId).players });
  });

  socket.on('join-room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit('error', { message: 'Room not found! Check the code.' }); return; }
    if (room.players.length >= 2) { socket.emit('error', { message: 'Room is full!' }); return; }
    room.players.push({ id: socket.id, name: data.name, ready: false });
    socket.join(data.roomId);
    socket.roomId = data.roomId;
    socket.playerName = data.name;
    io.to(data.roomId).emit('player-joined', { players: room.players, roomId: data.roomId });
  });

  socket.on('same-device-mode', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.players.length < 2) {
      room.players.push({ id: 'same-device-p2', name: data.name2, ready: false });
      room.sameDevice = true;
      room.scores[room.players[0].name] = 0;
      room.scores[data.name2] = 0;
      io.to(socket.roomId).emit('player-joined', { players: room.players, roomId: socket.roomId });
    }
  });

  socket.on('start-game', async (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.players.length < 2) return;
    room.gameStarted = true;
    room.confirmations.clear();
    room.scores[room.players[0].name] = 0;
    room.scores[room.players[1].name] = 0;

    if (room.gameType === 'truth-or-dare') {
      const targetPlayer = room.players[Math.floor(Math.random() * room.players.length)];
      room.currentPlayer = targetPlayer;
      const question = await generateTruthOrDare(targetPlayer.name, data?.category, room.previousQuestions);
      room.currentQuestion = question;
      room.previousQuestions.push(question);
      io.to(socket.roomId).emit('new-question', {
        question, targetPlayer: targetPlayer.name,
        confirmations: 0, needed: room.sameDevice ? 1 : 2
      });
    } else if (room.gameType === 'know-me') {
      await startKnowMeRound(room);
    }
  });

  socket.on('confirm-next', async (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.confirmations.add(room.sameDevice ? `${socket.id}-${Date.now()}` : socket.id);
    const needed = room.sameDevice ? 1 : 2;
    io.to(socket.roomId).emit('confirmation-update', { confirmations: room.confirmations.size, needed });

    if (room.confirmations.size >= needed) {
      room.confirmations.clear();

      if (room.gameType === 'truth-or-dare') {
        const currentIdx = room.players.findIndex(p => p.name === room.currentPlayer?.name);
        const nextIdx = (currentIdx + 1) % room.players.length;
        const targetPlayer = room.players[nextIdx];
        room.currentPlayer = targetPlayer;
        const question = await generateTruthOrDare(targetPlayer.name, data?.category, room.previousQuestions);
        room.currentQuestion = question;
        room.previousQuestions.push(question);
        io.to(socket.roomId).emit('new-question', {
          question, targetPlayer: targetPlayer.name,
          confirmations: 0, needed
        });
      } else if (room.gameType === 'know-me') {
        await startKnowMeRound(room);
      }
    }
  });

  socket.on('know-me-answer', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.knowMeState) return;

    const state = room.knowMeState;
    
    if (state.phase === 'guessing') {
      state.guess = data.answer;
      state.phase = 'revealing';
      // Now ask the person the question is about for the real answer
      io.to(socket.roomId).emit('know-me-need-real-answer', {
        aboutPlayer: state.aboutPlayer,
        question: state.question
      });
    } else if (state.phase === 'revealing') {
      state.realAnswer = data.answer;
      state.phase = 'done';
      
      // Simple similarity check for scoring
      const guess = state.guess.toLowerCase().trim();
      const real = state.realAnswer.toLowerCase().trim();
      const correct = real.includes(guess) || guess.includes(real) || 
                      levenshteinSimilarity(guess, real) > 0.6;
      
      if (correct) {
        room.scores[state.guesser] = (room.scores[state.guesser] || 0) + 1;
      }

      io.to(socket.roomId).emit('know-me-reveal', {
        question: state.question,
        guess: state.guess,
        realAnswer: state.realAnswer,
        guesser: state.guesser,
        aboutPlayer: state.aboutPlayer,
        correct,
        scores: room.scores
      });
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) { rooms.delete(socket.roomId); }
        else { io.to(socket.roomId).emit('player-left', { players: room.players }); }
      }
    }
  });
});

async function startKnowMeRound(room) {
  room.currentRound++;
  // Alternate who is being asked about
  const aboutIdx = room.currentRound % 2;
  const guesserIdx = (aboutIdx + 1) % 2;
  const aboutPlayer = room.players[aboutIdx].name;
  const guesser = room.players[guesserIdx].name;

  const question = await generateKnowMeQuestion(aboutPlayer, guesser, room.previousQuestions);
  room.previousQuestions.push(question);
  
  room.knowMeState = {
    phase: 'guessing',
    aboutPlayer,
    guesser,
    question,
    guess: null,
    realAnswer: null
  };

  io.to(room.id).emit('know-me-question', {
    question,
    aboutPlayer,
    guesser,
    scores: room.scores
  });
}

function levenshteinSimilarity(a, b) {
  if (a.length === 0) return 0;
  if (b.length === 0) return 0;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) matrix[i][j] = matrix[i-1][j-1];
      else matrix[i][j] = Math.min(matrix[i-1][j-1]+1, matrix[i][j-1]+1, matrix[i-1][j]+1);
    }
  }
  const dist = matrix[b.length][a.length];
  return 1 - dist / Math.max(a.length, b.length);
}

// Clean up old rooms every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.players.length === 0) rooms.delete(id);
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎲 Dare AI running on port ${PORT}`);
});
