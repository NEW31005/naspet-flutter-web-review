const ACCESS_KEY = 'aibw.lab.access.v1';

export const isStaticLab = import.meta.env.VITE_STATIC_LAB === 'true';

export function getLabAccessCode(): string | null {
  if (!isStaticLab) return null;
  try {
    return sessionStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

export function rememberLabAccessCode(code: string): void {
  sessionStorage.setItem(ACCESS_KEY, code);
}

export function forgetLabAccessCode(): void {
  sessionStorage.removeItem(ACCESS_KEY);
}

export async function validateLabAccess(code: string): Promise<void> {
  const endpoint = import.meta.env.VITE_LAB_PROXY_URL;
  if (!endpoint) throw new Error('Lab中継URLが設定されていません');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lab-Access': code },
    body: JSON.stringify({ action: 'auth' }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? '合言葉を確認できませんでした');
  }
}
