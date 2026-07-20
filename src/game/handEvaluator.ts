/**
 * Hand evaluator for both NLHE and PLO hands.
 * 
 * NLHE: Best 5-card hand from 2 hole cards + 5 community cards (can use 0, 1, or 2 hole cards)
 * PLO: Best 5-card hand using EXACTLY 2 of 4 hole cards + EXACTLY 3 of 5 community cards
 */

const RANK_VALUES: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const HAND_RANKS = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
} as const;

export interface HandResult {
  rank: number;
  rankName: string;
  cards: string[];
  kickers: number[];
}

function getRank(card: string): number {
  return RANK_VALUES[card[0]];
}

function getSuit(card: string): string {
  return card[1];
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const result: T[][] = [];
  const [first, ...rest] = arr;
  // Include first
  for (const combo of combinations(rest, k - 1)) {
    result.push([first, ...combo]);
  }
  // Exclude first
  for (const combo of combinations(rest, k)) {
    result.push(combo);
  }
  return result;
}

function evaluate5Cards(cards: string[]): HandResult {
  const ranks = cards.map(getRank).sort((a, b) => b - a);
  const suits = cards.map(getSuit);

  const isFlush = suits.every(s => s === suits[0]);

  // Check straight
  let isStraight = false;
  let straightHigh = 0;

  // Normal straight check
  if (ranks[0] - ranks[4] === 4 && new Set(ranks).size === 5) {
    isStraight = true;
    straightHigh = ranks[0];
  }
  // Wheel (A-2-3-4-5)
  if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true;
    straightHigh = 5;
  }

  // Count rank occurrences
  const counts: Record<number, number> = {};
  for (const r of ranks) {
    counts[r] = (counts[r] || 0) + 1;
  }
  const groups = Object.entries(counts)
    .map(([rank, count]) => ({ rank: Number(rank), count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isStraight && isFlush) {
    const rankVal = straightHigh === 14 ? HAND_RANKS.ROYAL_FLUSH : HAND_RANKS.STRAIGHT_FLUSH;
    const name = straightHigh === 14 ? 'Royal Flush' : 'Straight Flush';
    return { rank: rankVal, rankName: name, cards, kickers: [straightHigh] };
  }

  if (groups[0].count === 4) {
    return {
      rank: HAND_RANKS.FOUR_OF_A_KIND,
      rankName: 'Four of a Kind',
      cards,
      kickers: [groups[0].rank, groups[1].rank]
    };
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return {
      rank: HAND_RANKS.FULL_HOUSE,
      rankName: 'Full House',
      cards,
      kickers: [groups[0].rank, groups[1].rank]
    };
  }

  if (isFlush) {
    return { rank: HAND_RANKS.FLUSH, rankName: 'Flush', cards, kickers: ranks };
  }

  if (isStraight) {
    return { rank: HAND_RANKS.STRAIGHT, rankName: 'Straight', cards, kickers: [straightHigh] };
  }

  if (groups[0].count === 3) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
    return {
      rank: HAND_RANKS.THREE_OF_A_KIND,
      rankName: 'Three of a Kind',
      cards,
      kickers: [groups[0].rank, ...kickers]
    };
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = groups.filter(g => g.count === 2).map(g => g.rank).sort((a, b) => b - a);
    const kicker = groups.find(g => g.count === 1)!.rank;
    return {
      rank: HAND_RANKS.TWO_PAIR,
      rankName: 'Two Pair',
      cards,
      kickers: [...pairs, kicker]
    };
  }

  if (groups[0].count === 2) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
    return {
      rank: HAND_RANKS.ONE_PAIR,
      rankName: 'One Pair',
      cards,
      kickers: [groups[0].rank, ...kickers]
    };
  }

  return { rank: HAND_RANKS.HIGH_CARD, rankName: 'High Card', cards, kickers: ranks };
}

function compareHands(a: HandResult, b: HandResult): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0; // tie
}

/**
 * NLHE evaluation: best 5-card hand from 2 hole cards + 5 board cards.
 * Can use 0, 1, or 2 hole cards.
 */
export function evaluateNLHE(holeCards: string[], board: string[]): HandResult {
  const allCards = [...holeCards, ...board];
  const allCombos = combinations(allCards, 5);

  let best: HandResult | null = null;
  for (const combo of allCombos) {
    const result = evaluate5Cards(combo);
    if (!best || compareHands(result, best) > 0) {
      best = result;
    }
  }
  return best!;
}

/**
 * PLO evaluation: best 5-card hand using EXACTLY 2 of 4 hole cards + EXACTLY 3 of 5 board cards.
 */
export function evaluatePLO(holeCards: string[], board: string[]): HandResult {
  const holeCombos = combinations(holeCards, 2);
  const boardCombos = combinations(board, 3);

  let best: HandResult | null = null;
  for (const hc of holeCombos) {
    for (const bc of boardCombos) {
      const fiveCards = [...hc, ...bc];
      const result = evaluate5Cards(fiveCards);
      if (!best || compareHands(result, best) > 0) {
        best = result;
      }
    }
  }
  return best!;
}

/**
 * Compare two hand results. Returns:
 *  > 0 if a wins
 *  < 0 if b wins
 *  0 if tie
 */
export { compareHands };
