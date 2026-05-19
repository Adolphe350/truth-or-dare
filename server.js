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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Game rooms storage
const rooms = new Map();

// AI Question generation
async function generateQuestion(playerName, category, previousQuestions = []) {
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

  // Randomly pick between Claude Sonnet and GPT-5.5
  const useGPT = Math.random() > 0.5;
  
  try {
    if (useGPT) {
      return await generateWithGPT55(prompt);
    } else {
      return await generateWithClaude(prompt);
    }
  } catch (err) {
    console.error('Primary AI failed, trying fallback:', err.message);
    try {
      // Fallback to the other model
      if (useGPT) {
        return await generateWithClaude(prompt);
      } else {
        return await generateWithGPT55(prompt);
      }
    } catch (err2) {
      console.error('Both AI models failed:', err2.message);
      return getFallbackQuestion(playerName, selectedCategory);
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
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.AZURE_FOUNDRY_KEY
      },
      timeout: 30000
    }
  );
  return response.data.choices[0].message.content.trim();
}

async function generateWithClaude(prompt) {
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const response = await client.send(new ConverseCommand({
    modelId: 'us.anthropic.claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 200, temperature: 1.0 }
  }));
  
  return response.output.message.content[0].text.trim();
}

function getFallbackQuestion(playerName, category) {
  const fallbacks = [
    `TRUTH: ${playerName}, what's the most scandalous thing you've done that no one in this room knows about?`,
    `TRUTH: ${playerName}, who was your worst kiss and why?`,
    `DARE: ${playerName}, send a voice note to your most recent ex saying "I still think about you sometimes."`,
    `TRUTH: ${playerName}, what's one thing you'd change about your faith journey?`,
    `DARE: ${playerName}, let the other player go through your recent search history for 30 seconds.`,
    `TRUTH: ${playerName}, what's the biggest lie you've told a family member?`,
    `TRUTH: ${playerName}, if you had to pick one ex to spend a weekend with, who and why?`,
    `DARE: ${playerName}, post "I'm single and ready to mingle" on your Instagram story right now.`,
    `TRUTH: ${playerName}, what's your most controversial Christian opinion that you'd never say in church?`,
    `TRUTH: ${playerName}, what's the highest number of people you talked to at the same time romantically?`
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// API endpoint for generating questions
app.post('/api/question', async (req, res) => {
  const { playerName, category, previousQuestions } = req.body;
  try {
    const question = await generateQuestion(playerName, category, previousQuestions || []);
    res.json({ question, model: 'ai' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate question' });
  }
});

// Socket.IO for real-time sync
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('create-room', (data) => {
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    rooms.set(roomId, {
      id: roomId,
      players: [{ id: socket.id, name: data.name, ready: false }],
      currentQuestion: null,
      currentPlayer: null,
      previousQuestions: [],
      confirmations: new Set(),
      sameDevice: data.sameDevice || false,
      gameStarted: false
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room-created', { roomId, players: rooms.get(roomId).players });
  });

  socket.on('join-room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found! Check the code.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full!' });
      return;
    }
    room.players.push({ id: socket.id, name: data.name, ready: false });
    socket.join(data.roomId);
    socket.roomId = data.roomId;
    io.to(data.roomId).emit('player-joined', { players: room.players, roomId: data.roomId });
  });

  socket.on('start-game', async (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.players.length < 2) return;
    room.gameStarted = true;
    room.confirmations.clear();
    
    // Pick random player for first question
    const targetPlayer = room.players[Math.floor(Math.random() * room.players.length)];
    room.currentPlayer = targetPlayer;
    
    const question = await generateQuestion(targetPlayer.name, data?.category);
    room.currentQuestion = question;
    room.previousQuestions.push(question);
    
    io.to(socket.roomId).emit('new-question', {
      question,
      targetPlayer: targetPlayer.name,
      confirmations: 0,
      needed: room.sameDevice ? 1 : 2
    });
  });

  socket.on('confirm-next', async (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    room.confirmations.add(socket.id);
    const needed = room.sameDevice ? 1 : 2;
    
    io.to(socket.roomId).emit('confirmation-update', {
      confirmations: room.confirmations.size,
      needed
    });
    
    if (room.confirmations.size >= needed) {
      room.confirmations.clear();
      
      // Pick next player (alternate or random)
      const currentIdx = room.players.findIndex(p => p.name === room.currentPlayer?.name);
      const nextIdx = (currentIdx + 1) % room.players.length;
      const targetPlayer = room.players[nextIdx];
      room.currentPlayer = targetPlayer;
      
      const question = await generateQuestion(targetPlayer.name, data?.category, room.previousQuestions);
      room.currentQuestion = question;
      room.previousQuestions.push(question);
      
      io.to(socket.roomId).emit('new-question', {
        question,
        targetPlayer: targetPlayer.name,
        confirmations: 0,
        needed
      });
    }
  });

  socket.on('same-device-mode', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.sameDevice = true;
      // Add second player on same device
      if (room.players.length < 2) {
        room.players.push({ id: 'same-device-p2', name: data.name2, ready: false });
      }
      io.to(socket.roomId).emit('player-joined', { players: room.players, roomId: socket.roomId });
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(socket.roomId);
        } else {
          io.to(socket.roomId).emit('player-left', { players: room.players });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎲 Truth or Dare AI running on port ${PORT}`);
});
