const ACCESS_KEY = 'aibw.lab.access.v1';

export const isStaticLab = import.meta.env.VITE_STATIC_LAB === 'true';

/**
 * 愛言葉は入力しやすさを優先し、前後空白・大文字小文字・全角英数字を吸収する。
 * 秘密値そのものはリポジトリへ置かない。
 */
export function normalizeLabAccessCode(code: string): string {
  return code.normalize('NFKC').trim().toLowerCase();
}

export function getLabAccessCode(): string | null {
  if (!isStaticLab) return null;
  try {
    return sessionStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

export function rememberLabAccessCode(code: string): void {
  sessionStorage.setItem(ACCESS_KEY, normalizeLabAccessCode(code));
}

export function forgetLabAccessCode(): void {
  sessionStorage.removeItem(ACCESS_KEY);
}

export async function validateLabAccess(code: string): Promise<void> {
  const endpoint = import.meta.env.VITE_LAB_PROXY_URL;
  if (!endpoint) throw new Error('Lab中継URLが設定されていません');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lab-Access': normalizeLabAccessCode(code),
    },
    body: JSON.stringify({ action: 'auth' }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? '愛言葉を確認できませんでした');
  }
}
