import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import crypto from 'crypto';
import { GameEngine } from './game/gameEngine';

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../public')));

const GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes

// Each table is a unique room with its own game instance
interface TableRoom {
  id: string;
  game: GameEngine;
  readyForNext: Set<string>;  // uses playerId
  createdAt: Date;
  // Session management
  playerSockets: Map<string, string>;   // playerId → socketId
  socketPlayers: Map<string, string>;   // socketId → playerId
  disconnectTimers: Map<string, NodeJS.Timeout>; // playerId → removal timer
}

const tables: Map<string, TableRoom> = new Map();

function generateTableId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function generatePlayerId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Create table API
app.get('/api/create-table', (req, res) => {
  const ante = parseInt(req.query.ante as string) || 5;
  const id = generateTableId();
  tables.set(id, {
    id,
    game: new GameEngine(ante),
    readyForNext: new Set(),
    createdAt: new Date(),
    playerSockets: new Map(),
    socketPlayers: new Map(),
    disconnectTimers: new Map(),
  });
  res.json({ tableId: id, url: `/table/${id}` });
});

// Serve the game page for any table URL
app.get('/table/:tableId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Helper: emit to all sockets in a table room
function emitToTable(tableId: string, event: string, data: any) {
  io.to(tableId).emit(event, data);
}

// Helper: send personalized game state to each player in a table
function sendPersonalizedState(table: TableRoom) {
  for (const [playerId, socketId] of table.playerSockets) {
    const playerSocket = io.sockets.sockets.get(socketId);
    if (playerSocket) {
      playerSocket.emit('gameState', table.game.getPublicState(playerId));
    }
  }
}

// Helper: get playerId from socketId for a table
function getPlayerId(table: TableRoom, socketId: string): string | undefined {
  return table.socketPlayers.get(socketId);
}

io.on('connection', (socket) => {
  let currentTableId: string | null = null;
  let currentPlayerId: string | null = null;

  socket.on('joinTable', (data: { tableId: string; name: string; chips: number; playerId?: string }) => {
    const table = tables.get(data.tableId);
    if (!table) {
      socket.emit('error', 'Table not found');
      return;
    }

    // Check if reconnecting with an existing playerId
    if (data.playerId) {
      const existingPlayer = table.game.getState().players.find(p => p.id === data.playerId);
      if (existingPlayer) {
        // Reconnect! Cancel any disconnect timer
        const timer = table.disconnectTimers.get(data.playerId);
        if (timer) {
          clearTimeout(timer);
          table.disconnectTimers.delete(data.playerId);
        }

        // Update socket mappings
        const oldSocketId = table.playerSockets.get(data.playerId);
        if (oldSocketId) {
          table.socketPlayers.delete(oldSocketId);
        }
        table.playerSockets.set(data.playerId, socket.id);
        table.socketPlayers.set(socket.id, data.playerId);

        // Mark player as connected
        existingPlayer.connected = true;

        currentTableId = data.tableId;
        currentPlayerId = data.playerId;
        socket.join(data.tableId);

        // Send session info back
        socket.emit('session', { playerId: data.playerId, reconnected: true });
        emitToTable(data.tableId, 'message', `${existingPlayer.name} reconnected`);
        sendPersonalizedState(table);
        socket.emit('ledger', table.game.getLedger());
        return;
      }
    }

    // New player joining
    const playerId = generatePlayerId();
    const success = table.game.addPlayer(playerId, data.name, data.chips);
    if (success) {
      currentTableId = data.tableId;
      currentPlayerId = playerId;

      // Set up socket mappings
      table.playerSockets.set(playerId, socket.id);
      table.socketPlayers.set(socket.id, playerId);

      socket.join(data.tableId);

      // Send session info to client for storage
      socket.emit('session', { playerId, reconnected: false });

      emitToTable(data.tableId, 'message', `${data.name} joined the table`);
      sendPersonalizedState(table);
      socket.emit('ledger', table.game.getLedger());
    } else {
      socket.emit('error', 'Could not join — table may be full or game in progress');
    }
  });

  socket.on('startHand', () => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    if (table.game.canStartHand()) {
      table.game.startHand();
      sendPersonalizedState(table);
      emitToTable(currentTableId, 'message', `Hand #${table.game.getState().handNumber} started. Arrange your cards!`);
    }
  });

  socket.on('arrangeCards', (data: { nlheCards: string[]; ploCards: string[] }) => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const success = table.game.arrangeCards(currentPlayerId, data.nlheCards, data.ploCards);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      emitToTable(currentTableId, 'message', `${player?.name} is ready`);

      if (table.game.allPlayersArranged() || table.game.getState().phase === 'complete') {
        // All arranged — send showdown state (flop is dealt by engine)
        emitToTable(currentTableId, 'gameState', table.game.getPublicState());

        // Schedule turn after 1.2s
        const tId = currentTableId;
        setTimeout(() => {
          const t = tables.get(tId);
          if (!t) return;
          t.game.dealTurn();
          emitToTable(tId, 'gameState', t.game.getPublicState());

          // Schedule river after another 1.2s
          setTimeout(() => {
            const t2 = tables.get(tId);
            if (!t2) return;
            t2.game.dealRiver();
            emitToTable(tId, 'gameState', t2.game.getPublicState());

            const state = t2.game.getState();
            if (state.winnerId) {
              const winner = state.players.find(p => p.id === state.winnerId);
              emitToTable(tId, 'message', `🏆 ${winner?.name} SCOOPS the pot of $${state.pot}!`);
            } else {
              emitToTable(tId, 'message', `No scoop! Pot of $${state.pot} carries over to next hand.`);
            }

            // Send updated ledger
            emitToTable(tId, 'ledger', t2.game.getLedger());
          }, 1200);
        }, 1200);
      } else {
        sendPersonalizedState(table);
      }
    } else {
      socket.emit('error', 'Invalid card arrangement');
    }
  });

  socket.on('nextHand', () => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;
    if (table.game.getState().phase !== 'complete') return;

    table.readyForNext.add(currentPlayerId);
    const player = table.game.getState().players.find(p => p.id === currentPlayerId);
    emitToTable(currentTableId, 'message', `${player?.name} is ready for next hand`);

    // Auto-vote bots
    for (const p of table.game.getState().players) {
      if (p.id.startsWith('bot-')) {
        table.readyForNext.add(p.id);
      }
    }

    emitToTable(currentTableId, 'readyForNext', Array.from(table.readyForNext));

    // Check if ALL connected players are ready
    const connectedPlayers = table.game.getState().players.filter(p => p.connected);
    const allReady = connectedPlayers.every(p => table.readyForNext.has(p.id));

    if (allReady && connectedPlayers.length >= 2) {
      table.readyForNext.clear();
      table.game.resetForNextHand();
      emitToTable(currentTableId, 'readyForNext', []);
      sendPersonalizedState(table);
      emitToTable(currentTableId, 'message', 'All players ready. Click Deal to start.');
    }
  });

  socket.on('addChips', (data: { amount: number }) => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const success = table.game.addChips(currentPlayerId, data.amount);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      emitToTable(currentTableId, 'message', `${player?.name} added $${data.amount} chips`);
      sendPersonalizedState(table);
      emitToTable(currentTableId, 'ledger', table.game.getLedger());
    }
  });

  socket.on('proposeJuicer', (data: { multiplier: number }) => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const multiplier = Math.max(1, Math.min(10, data.multiplier || 1));
    const success = table.game.proposeJuicer(currentPlayerId, multiplier);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      const extraAnte = table.game.getState().ante * multiplier;
      emitToTable(currentTableId, 'message', `🧃 ${player?.name} proposed a JUICER! (+$${extraAnte} per player). All must agree.`);
      emitToTable(currentTableId, 'gameState', table.game.getPublicState());
    } else {
      socket.emit('error', 'Cannot propose juicer right now');
    }
  });

  socket.on('proposeBumpItUp', (data: { newAnte: number }) => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const newAnte = Math.max(1, data.newAnte || 10);
    const success = table.game.proposeBumpItUp(currentPlayerId, newAnte);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      emitToTable(currentTableId, 'message', `⬆️ ${player?.name} proposed BUMP IT UP! Ante → $${newAnte}. All must agree.`);
      emitToTable(currentTableId, 'gameState', table.game.getPublicState());
    } else {
      socket.emit('error', 'Cannot propose bump right now');
    }
  });

  socket.on('acceptJuicer', () => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const success = table.game.acceptSideBet(currentPlayerId);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      emitToTable(currentTableId, 'message', `✅ ${player?.name} accepted the juicer`);
      emitToTable(currentTableId, 'gameState', table.game.getPublicState());

      const sideBet = table.game.getSideBetStatus();
      if (sideBet && sideBet.resolved && !sideBet.rejected) {
        emitToTable(currentTableId, 'message', `🧃 JUICER IS ON! Extra antes will be collected next hand.`);
      }
    }
  });

  socket.on('rejectJuicer', () => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const success = table.game.rejectSideBet(currentPlayerId);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      emitToTable(currentTableId, 'message', `❌ ${player?.name} rejected the juicer`);
      emitToTable(currentTableId, 'gameState', table.game.getPublicState());
    }
  });

  socket.on('getLedger', () => {
    if (!currentTableId) return;
    const table = tables.get(currentTableId);
    if (!table) return;
    socket.emit('ledger', table.game.getLedger());
  });

  socket.on('swapSeat', (data: { seatIndex: number }) => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const success = table.game.swapSeat(currentPlayerId, data.seatIndex);
    if (success) {
      const player = table.game.getState().players.find(p => p.id === currentPlayerId);
      emitToTable(currentTableId, 'message', `${player?.name} moved to seat ${data.seatIndex + 1}`);
      sendPersonalizedState(table);
    }
  });

  socket.on('simulate', (data: { botCount?: number }) => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const state = table.game.getState();

    // Only allow simulation during waiting phase
    if (state.phase !== 'waiting') {
      socket.emit('error', 'Can only simulate during waiting phase');
      return;
    }

    const botCount = Math.min(4, Math.max(1, data?.botCount || 1));
    const botNames = ['Bot_Alice', 'Bot_Bob', 'Bot_Charlie', 'Bot_Dave', 'Bot_Eve'];
    const addedBots: string[] = [];

    // Add bots (up to table capacity)
    for (let i = 0; i < botCount; i++) {
      if (table.game.getState().players.length >= 5) break;

      const botId = `bot-${crypto.randomBytes(4).toString('hex')}`;
      const botName = botNames[i % botNames.length];
      const success = table.game.addPlayer(botId, botName, 500);
      if (success) {
        table.playerSockets.set(botId, 'bot');
        addedBots.push(botId);
        emitToTable(currentTableId, 'message', `🤖 ${botName} joined for simulation`);
      }
    }

    if (addedBots.length === 0) {
      socket.emit('error', 'Table is full');
      return;
    }

    // Start the hand
    table.game.startHand();
    sendPersonalizedState(table);
    emitToTable(currentTableId, 'message', `Hand #${table.game.getState().handNumber} started (simulation). Arrange your cards!`);

    // Auto-arrange all bots' cards (first 2 = NLHE, last 4 = PLO)
    for (const botId of addedBots) {
      const botHand = table.game.getState().playerHands.get(botId);
      if (botHand) {
        const cards = botHand.allCards;
        table.game.arrangeCards(botId, [cards[0], cards[1]], [cards[2], cards[3], cards[4], cards[5]]);
      }
    }

    emitToTable(currentTableId, 'message', `🤖 ${addedBots.length} bot(s) arranged cards automatically`);
    sendPersonalizedState(table);
  });

  socket.on('leaveTable', () => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    // Explicit leave = permanent removal (cash out)
    const player = table.game.removePlayer(currentPlayerId);
    if (player) {
      table.readyForNext.delete(currentPlayerId);
      table.playerSockets.delete(currentPlayerId);
      table.socketPlayers.delete(socket.id);
      const timer = table.disconnectTimers.get(currentPlayerId);
      if (timer) { clearTimeout(timer); table.disconnectTimers.delete(currentPlayerId); }

      socket.leave(currentTableId);
      emitToTable(currentTableId, 'message', `${player.name} left the table (cashed out $${player.chips})`);
      emitToTable(currentTableId, 'ledger', table.game.getLedger());

      // Check if remaining players are all ready for next
      const remaining = table.game.getState().players.filter(p => p.connected);
      if (remaining.length >= 2 && table.game.getState().phase === 'complete') {
        const allReady = remaining.every(p => table.readyForNext.has(p.id));
        if (allReady) {
          table.readyForNext.clear();
          table.game.resetForNextHand();
          emitToTable(currentTableId, 'readyForNext', []);
          emitToTable(currentTableId, 'message', 'All players ready. Click Deal to start.');
        }
      }
      sendPersonalizedState(table);
    }
    currentTableId = null;
    currentPlayerId = null;
  });

  socket.on('disconnect', () => {
    if (!currentTableId || !currentPlayerId) return;
    const table = tables.get(currentTableId);
    if (!table) return;

    const playerId = currentPlayerId;
    const player = table.game.getState().players.find(p => p.id === playerId);
    if (!player) return;

    // Mark as disconnected but DON'T remove
    player.connected = false;
    table.socketPlayers.delete(socket.id);

    emitToTable(currentTableId, 'message', `${player.name} disconnected (30 min to reconnect)`);
    sendPersonalizedState(table);

    // Start grace period timer
    const timer = setTimeout(() => {
      const t = tables.get(currentTableId!);
      if (!t) return;

      // Time's up — remove player permanently
      const removedPlayer = t.game.removePlayer(playerId);
      if (removedPlayer) {
        t.readyForNext.delete(playerId);
        t.playerSockets.delete(playerId);
        t.disconnectTimers.delete(playerId);
        emitToTable(currentTableId!, 'message', `${removedPlayer.name} timed out (removed after 30 min)`);
        emitToTable(currentTableId!, 'ledger', t.game.getLedger());
        sendPersonalizedState(t);
      }
    }, GRACE_PERIOD_MS);

    table.disconnectTimers.set(playerId, timer);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Scoop Poker server running on http://localhost:${PORT}`);
});
