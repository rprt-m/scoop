declare module 'mersenne-twister' {
  class MersenneTwister {
    constructor(seed?: number);
    random(): number;
    random_int(): number;
    random_int31(): number;
    random_incl(): number;
    random_excl(): number;
    random_long(): number;
    init_seed(seed: number): void;
    init_by_array(initKey: number[], keyLength: number): void;
  }
  export = MersenneTwister;
}
