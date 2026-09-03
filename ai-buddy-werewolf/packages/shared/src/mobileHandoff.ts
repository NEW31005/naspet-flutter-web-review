/**
 * モバイル引継ぎパッケージのfilesをSHA-256計算用に正規化する。
 * Web Labと本番バックエンドで同じ実装を使い、JSONのキー順差を排除する。
 */
export function canonicalizeMobileHandoffFiles(files: Record<string, string>): string {
  return Object.keys(files)
    .sort()
    .map((path) => `${path}\u0000${files[path] ?? ''}`)
    .join('\u0000');
}
