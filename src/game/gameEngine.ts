import { createOrderedDeck, generateGameDeck, generateSeed, ShuffleResult } from '../rng/mersenneTwister';
import { evaluateNLHE, evaluatePLO, compareHands, HandResult } from './handEvaluator';

export interface Player {
  id: string;
  name: string;
  chips: number;
  seatIndex: number;
  connected: boolean;
  buyIn: number;       // total amount bought in for
}

export interface LedgerEntry {
  playerId: string;
  playerName: string;
  buyIn: number;
  cashOut: number;
  profit: number;
}

export interface PlayerHand {
  playerId: string;
  allCards: string[];         // 6 cards dealt
  nlheCards: string[] | null; // 2 cards arranged on top (NLHE)
  ploCards: string[] | null;  // 4 cards arranged on bottom (PLO)
  arranged: boolean;
}

export interface HandResults {
  playerId: string;
  nlheResult: HandResult;
  ploResult: HandResult;
}

export type GamePhase =
  | 'waiting'      // waiting for players
  | 'dealing'      // cards being dealt
  | 'arranging'    // players arranging their 6 cards into 2+4
  | 'showdown'     // NLHE hands exposed, board dealt, winner determined
  | 'complete';    // hand complete

// Side bet types — extensible for future additions
export type SideBetType = 'juicer' | 'bump_it_up';

export interface SideBetProposal {
  type: SideBetType;
  proposedBy: string;
  multiplier: number;       // juicer: how many extra antes. bump_it_up: new ante amount
  accepted: Set<string>;    // player IDs who agreed
  rejected: boolean;        // if any player rejects, it's dead
  resolved: boolean;        // proposal has been accepted or rejected
}

export interface GameState {
  phase: GamePhase;
  players: Player[];
  playerHands: Map<string, PlayerHand>;
  board: string[];
  pot: number;
  carryOverPot: number;  // accumulated pot from previous chops
  ante: number;
  deck: string[];
  deckIndex: number;
  lastDeckState: string[];
  seeds: number[];
  results: HandResults[];
  winnerId: string | null;
  handNumber: number;
  ledger: Map<string, LedgerEntry>;
  activeSideBet: SideBetProposal | null;
  juicerActive: boolean;   // whether the current hand has an active juicer
}

export class GameEngine {
  private state: GameState;

  constructor(ante: number = 5) {
    const initialDeck = createOrderedDeck();
    const { deck, seed } = generateGameDeck(initialDeck);

    this.state = {
      phase: 'waiting',
      players: [],
      playerHands: new Map(),
      board: [],
      pot: 0,
      carryOverPot: 0,
      ante,
      deck,
      deckIndex: 0,
      lastDeckState: deck,
      seeds: [seed],
      results: [],
      winnerId: null,
      handNumber: 0,
      ledger: new Map(),
      activeSideBet: null,
      juicerActive: false,
    };
  }

  getState(): GameState {
    return this.state;
  }

  addPlayer(id: string, name: string, chips: number): boolean {
    if (this.state.players.length >= 6) return false;
    if (this.state.players.find(p => p.id === id)) return false;

    this.state.players.push({
      id,
      name,
      chips,
      seatIndex: this.state.players.length,
      connected: true,
      buyIn: chips,
    });

    // Initialize ledger
    this.state.ledger.set(id, {
      playerId: id,
      playerName: name,
      buyIn: chips,
      cashOut: 0,
      profit: 0,
    });

    return true;
  }

  removePlayer(id: string): Player | undefined {
    const player = this.state.players.find(p => p.id === id);
    if (player) {
      // Update ledger with cash out
      const entry = this.state.ledger.get(id);
      if (entry) {
        entry.cashOut = player.chips;
        entry.profit = player.chips - entry.buyIn;
      }
      this.state.players = this.state.players.filter(p => p.id !== id);
    }
    return player;
  }

  addChips(playerId: string, amount: number): boolean {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || amount <= 0) return false;

    player.chips += amount;
    player.buyIn += amount;

    // Update ledger
    const entry = this.state.ledger.get(playerId);
    if (entry) {
      entry.buyIn += amount;
    }

    return true;
  }

  canStartHand(): boolean {
    // Allow start if no side bet, or if the side bet is fully resolved (accepted by all)
    const sideBetOk = !this.state.activeSideBet || (this.state.activeSideBet.resolved && !this.state.activeSideBet.rejected);
    return this.state.players.length >= 2 && this.state.phase === 'waiting' && sideBetOk;
  }

  /**
   * Propose a Juicer side bet. Requires all players to accept.
   * Multiplier = how many extra antes on top of the normal one.
   * e.g. multiplier=1 means each player puts in 2x ante total (1 normal + 1 juicer).
   */
  proposeJuicer(proposerId: string, multiplier: number): boolean {
    if (this.state.phase !== 'waiting') return false;
    if (this.state.activeSideBet) return false;
    if (multiplier < 1) return false;
    if (!this.state.players.find(p => p.id === proposerId)) return false;

    const accepted = new Set<string>();
    accepted.add(proposerId);

    this.state.activeSideBet = {
      type: 'juicer',
      proposedBy: proposerId,
      multiplier,
      accepted,
      rejected: false,
      resolved: false,
    };

    if (this.state.players.length === 1) {
      this.state.activeSideBet.resolved = true;
      this.state.juicerActive = true;
    }

    return true;
  }

  /**
   * Propose a "Bump It Up" side bet. Permanently changes the ante to a new amount.
   * Requires all players to accept.
   */
  proposeBumpItUp(proposerId: string, newAnte: number): boolean {
    if (this.state.phase !== 'waiting') return false;
    if (this.state.activeSideBet) return false;
    if (newAnte <= 0 || newAnte === this.state.ante) return false;
    if (!this.state.players.find(p => p.id === proposerId)) return false;

    const accepted = new Set<string>();
    accepted.add(proposerId);

    this.state.activeSideBet = {
      type: 'bump_it_up',
      proposedBy: proposerId,
      multiplier: newAnte, // reusing multiplier field to store the new ante amount
      accepted,
      rejected: false,
      resolved: false,
    };

    if (this.state.players.length === 1) {
      this.state.activeSideBet.resolved = true;
      this.state.ante = newAnte;
    }

    return true;
  }

  /**
   * A player accepts the active side bet proposal.
   */
  acceptSideBet(playerId: string): boolean {
    const bet = this.state.activeSideBet;
    if (!bet || bet.resolved || bet.rejected) return false;
    if (!this.state.players.find(p => p.id === playerId)) return false;

    bet.accepted.add(playerId);

    // Check if all players accepted
    if (this.state.players.every(p => bet.accepted.has(p.id))) {
      bet.resolved = true;
      if (bet.type === 'juicer') {
        this.state.juicerActive = true;
      } else if (bet.type === 'bump_it_up') {
        this.state.ante = bet.multiplier;
      }
    }

    return true;
  }

  /**
   * A player rejects the active side bet proposal. Kills it immediately.
   */
  rejectSideBet(playerId: string): boolean {
    const bet = this.state.activeSideBet;
    if (!bet || bet.resolved || bet.rejected) return false;
    if (!this.state.players.find(p => p.id === playerId)) return false;

    bet.rejected = true;
    bet.resolved = true;
    this.state.juicerActive = false;
    this.state.activeSideBet = null;

    return true;
  }

  getSideBetStatus() {
    const bet = this.state.activeSideBet;
    if (!bet) return null;
    return {
      type: bet.type,
      proposedBy: bet.proposedBy,
      multiplier: bet.multiplier,
      accepted: Array.from(bet.accepted),
      rejected: bet.rejected,
      resolved: bet.resolved,
      totalPlayers: this.state.players.length,
    };
  }

  startHand(): boolean {
    if (!this.canStartHand()) return false;

    this.state.handNumber++;
    this.state.phase = 'dealing';
    this.state.board = [];
    this.state.results = [];
    this.state.winnerId = null;
    this.state.playerHands = new Map();

    // Shuffle from last deck state (Mersenne Twister with new seed)
    const { deck, seed } = generateGameDeck(this.state.lastDeckState);
    this.state.deck = deck;
    this.state.lastDeckState = deck;
    this.state.seeds.push(seed);
    this.state.deckIndex = 0;

    // Collect antes (+ juicer if active)
    this.state.pot = this.state.carryOverPot;
    const antePerPlayer = this.state.juicerActive
      ? this.state.ante * (1 + this.state.activeSideBet!.multiplier)
      : this.state.ante;
    for (const player of this.state.players) {
      player.chips -= antePerPlayer;
      this.state.pot += antePerPlayer;
    }

    // Clear juicer after collecting
    this.state.juicerActive = false;
    this.state.activeSideBet = null;

    // Deal 6 cards to each player
    for (const player of this.state.players) {
      const cards = this.state.deck.slice(this.state.deckIndex, this.state.deckIndex + 6);
      this.state.deckIndex += 6;

      this.state.playerHands.set(player.id, {
        playerId: player.id,
        allCards: cards,
        nlheCards: null,
        ploCards: null,
        arranged: false,
      });
    }

    this.state.phase = 'arranging';
    return true;
  }

  /**
   * Player arranges their 6 cards: 2 for NLHE (top), 4 for PLO (bottom).
   */
  arrangeCards(playerId: string, nlheCards: string[], ploCards: string[]): boolean {
    if (this.state.phase !== 'arranging') return false;

    const hand = this.state.playerHands.get(playerId);
    if (!hand) return false;

    // Validate: must use exactly their 6 dealt cards
    if (nlheCards.length !== 2 || ploCards.length !== 4) return false;

    const allArranged = [...nlheCards, ...ploCards].sort();
    const allDealt = [...hand.allCards].sort();
    if (JSON.stringify(allArranged) !== JSON.stringify(allDealt)) return false;

    hand.nlheCards = nlheCards;
    hand.ploCards = ploCards;
    hand.arranged = true;

    // Check if all players have arranged
    const allReady = Array.from(this.state.playerHands.values()).every(h => h.arranged);
    if (allReady) {
      this.proceedToShowdown();
    }

    return true;
  }

  allPlayersArranged(): boolean {
    return Array.from(this.state.playerHands.values()).every(h => h.arranged);
  }

  /**
   * Begin showdown — deals the flop (3 cards) only.
   * Turn and river are dealt separately via dealTurn() and dealRiver().
   */
  private proceedToShowdown(): void {
    this.state.phase = 'showdown';

    // Deal flop (3 cards)
    this.state.board = this.state.deck.slice(this.state.deckIndex, this.state.deckIndex + 3);
    this.state.deckIndex += 3;
  }

  /**
   * Deal the turn card (4th community card).
   */
  dealTurn(): boolean {
    if (this.state.phase !== 'showdown') return false;
    if (this.state.board.length !== 3) return false;

    const turn = this.state.deck[this.state.deckIndex];
    this.state.deckIndex += 1;
    this.state.board.push(turn);
    return true;
  }

  /**
   * Deal the river card (5th community card) and evaluate hands.
   */
  dealRiver(): boolean {
    if (this.state.phase !== 'showdown') return false;
    if (this.state.board.length !== 4) return false;

    const river = this.state.deck[this.state.deckIndex];
    this.state.deckIndex += 1;
    this.state.board.push(river);

    // Now evaluate all hands with the complete board
    this.state.results = [];
    for (const [playerId, hand] of this.state.playerHands) {
      const nlheResult = evaluateNLHE(hand.nlheCards!, this.state.board);
      const ploResult = evaluatePLO(hand.ploCards!, this.state.board);
      this.state.results.push({ playerId, nlheResult, ploResult });
    }

    // Determine winner
    this.determineWinner();
    return true;
  }

  private determineWinner(): void {
    const results = this.state.results;

    // Find best NLHE hand
    let bestNLHE = results[0];
    let nlheTied = false;
    for (let i = 1; i < results.length; i++) {
      const cmp = compareHands(results[i].nlheResult, bestNLHE.nlheResult);
      if (cmp > 0) {
        bestNLHE = results[i];
        nlheTied = false;
      } else if (cmp === 0) {
        nlheTied = true;
      }
    }

    // Find best PLO hand
    let bestPLO = results[0];
    let ploTied = false;
    for (let i = 1; i < results.length; i++) {
      const cmp = compareHands(results[i].ploResult, bestPLO.ploResult);
      if (cmp > 0) {
        bestPLO = results[i];
        ploTied = false;
      } else if (cmp === 0) {
        ploTied = true;
      }
    }

    // A player scoops only if they win BOTH hands outright (no ties)
    if (!nlheTied && !ploTied && bestNLHE.playerId === bestPLO.playerId) {
      // SCOOP - one player wins both
      this.state.winnerId = bestNLHE.playerId;
      const winner = this.state.players.find(p => p.id === bestNLHE.playerId)!;
      winner.chips += this.state.pot;
      this.state.carryOverPot = 0;
    } else {
      // No scoop - pot carries over
      this.state.winnerId = null;
      this.state.carryOverPot = this.state.pot;
    }

    this.state.phase = 'complete';
  }

  /**
   * Reset for next hand (keeps carry-over pot if no winner).
   * Game is perpetual — this just resets hand state.
   */
  resetForNextHand(): void {
    this.state.phase = 'waiting';
    this.state.pot = 0;
    this.state.board = [];
    this.state.results = [];
    this.state.winnerId = null;
    this.state.playerHands = new Map();
    this.state.activeSideBet = null;
    this.state.juicerActive = false;
  }

  getLedger(): LedgerEntry[] {
    // Update live players' current profit in ledger
    for (const player of this.state.players) {
      const entry = this.state.ledger.get(player.id);
      if (entry) {
        entry.cashOut = player.chips;
        entry.profit = player.chips - entry.buyIn;
      }
    }
    return Array.from(this.state.ledger.values());
  }

  getPublicState(requestingPlayerId?: string) {
    const hands: Record<string, any> = {};

    for (const [playerId, hand] of this.state.playerHands) {
      if (this.state.phase === 'showdown' || this.state.phase === 'complete') {
        // Show NLHE cards to everyone, PLO cards to everyone at showdown
        hands[playerId] = {
          nlheCards: hand.nlheCards,
          ploCards: hand.ploCards,
          arranged: hand.arranged,
        };
      } else if (playerId === requestingPlayerId) {
        // Only show own cards during arranging
        hands[playerId] = {
          allCards: hand.allCards,
          nlheCards: hand.nlheCards,
          ploCards: hand.ploCards,
          arranged: hand.arranged,
        };
      } else {
        hands[playerId] = {
          arranged: hand.arranged,
        };
      }
    }

    return {
      phase: this.state.phase,
      players: this.state.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        seatIndex: p.seatIndex,
        connected: p.connected,
      })),
      hands,
      board: this.state.board,
      pot: this.state.pot,
      carryOverPot: this.state.carryOverPot,
      ante: this.state.ante,
      results: this.state.phase === 'complete' || this.state.phase === 'showdown'
        ? this.state.results.map(r => ({
            playerId: r.playerId,
            nlhe: { rankName: r.nlheResult.rankName, cards: r.nlheResult.cards },
            plo: { rankName: r.ploResult.rankName, cards: r.ploResult.cards },
          }))
        : [],
      winnerId: this.state.winnerId,
      handNumber: this.state.handNumber,
      sideBet: this.getSideBetStatus(),
    };
  }
}
