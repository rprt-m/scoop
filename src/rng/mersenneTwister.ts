import MersenneTwister = require('mersenne-twister');
import crypto from 'crypto';

export interface ShuffleResult {
  deck: string[];
  seed: number;
}

const SUITS = ['s', 'h', 'd', 'c'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

export function createOrderedDeck(): string[] {
  const deck: string[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

export function generateSeed(): number {
  return crypto.randomBytes(4).readUInt32BE(0);
}

/**
 * Fisher-Yates shuffle driven by Mersenne Twister.
 * Produces a uniform random permutation regardless of input order.
 */
function fisherYatesShuffle(deck: string[], mt: MersenneTwister): string[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(mt.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Generates the next game deck by shuffling the previous deck state
 * with a new MT19937 seed. This mirrors PokerNow's approach:
 * each deck is a shuffle of the last shuffled deck.
 */
export function generateGameDeck(lastDeck: string[], newSeed?: number): ShuffleResult {
  const seed = newSeed ?? generateSeed();
  const mt = new MersenneTwister(seed);
  const deck = fisherYatesShuffle(lastDeck, mt);
  return { deck, seed };
}
