import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  forgetLabAccessCode,
  getLabAccessCode,
  isStaticLab,
  rememberLabAccessCode,
  validateLabAccess,
} from '../runtime/access.js';

export function AccessGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'locked' | 'ready'>(
    isStaticLab ? 'checking' : 'ready',
  );
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isStaticLab) return;
    const saved = getLabAccessCode();
    if (!saved) {
      setStatus('locked');
      return;
    }
    void validateLabAccess(saved)
      .then(() => setStatus('ready'))
      .catch(() => {
        forgetLabAccessCode();
        setStatus('locked');
      });
  }, []);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await validateLabAccess(code.trim());
      rememberLabAccessCode(code.trim());
      setCode('');
      setStatus('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'checking') {
    return <div className="access-shell"><div className="spinner" /></div>;
  }
  if (status === 'locked') {
    return (
      <main className="access-shell">
        <form className="access-card" onSubmit={unlock}>
          <div className="access-mark">☯</div>
          <h1>AIバディ人狼</h1>
          <p className="muted">しんちゃん専用 Phase0 Lab</p>
          <label className="field">
            合言葉
            <input
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="専用アクセスコード"
              autoFocus
            />
          </label>
          <button className="primary" type="submit" disabled={submitting || !code.trim()}>
            {submitting ? '確認中…' : '実験室へ入る'}
          </button>
          {error && <div className="errorbox small">{error}</div>}
          <p className="muted small">
            設定・プロンプト・試合データはこの端末のブラウザ内だけに保存されます。
            APIキーはブラウザへ配布されません。
          </p>
        </form>
      </main>
    );
  }
  return <>{children}</>;
}
