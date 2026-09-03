/**
 * シード付き決定論的乱数。
 * 呼び出し順に依存しないよう、(シード + ラベル列) から毎回独立に値を導出する。
 * リプレイ・フェーズ再実行時も同じラベルなら同じ値になる。
 */

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RngLabel = string | number;

/** [0,1) の決定論的乱数を1つ返す。 */
export function rand(seed: string, ...labels: RngLabel[]): number {
  const key = `${seed}::${labels.join('/')}`;
  const h = xmur3(key);
  return mulberry32(h())();
}

/** 0..(n-1) の整数を返す。 */
export function randInt(n: number, seed: string, ...labels: RngLabel[]): number {
  if (n <= 0) throw new Error('randInt: n must be > 0');
  return Math.floor(rand(seed, ...labels) * n);
}

/** 配列から決定論的に1要素選ぶ。 */
export function pickOne<T>(items: readonly T[], seed: string, ...labels: RngLabel[]): T {
  if (items.length === 0) throw new Error('pickOne: empty array');
  const v = items[randInt(items.length, seed, ...labels)];
  return v as T;
}

/** 決定論的シャッフル(Fisher–Yates)。元配列は変更しない。 */
export function shuffle<T>(items: readonly T[], seed: string, ...labels: RngLabel[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1, seed, ...labels, i);
    const a = arr[i] as T;
    const b = arr[j] as T;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}
