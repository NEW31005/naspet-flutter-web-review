/** 設定・プロンプト編集画面(ファイルをそのまま編集する管理UI) */
import { useEffect, useRef, useState } from 'react';
import { api, type ConfigResponse } from '../api.js';
import { ErrorBox, Spinner, TopBar } from '../components.js';

export function Settings() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [selected, setSelected] = useState<{ kind: 'config' | 'prompt'; name: string } | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  const open = async (kind: 'config' | 'prompt', name: string) => {
    setError(null);
    setStatus(null);
    try {
      const res = await api.readFile(kind, name);
      setSelected({ kind, name });
      setText(res.text);
    } catch (e) {
      setError(String(e));
    }
  };

  const save = async () => {
    if (!selected) return;
    setStatus(null);
    setError(null);
    try {
      await api.writeFile(selected.kind, selected.name, text);
      setStatus(`${selected.name} を保存しました。次の新規試合(またはLabの再読込)から反映されます。`);
    } catch (e) {
      setError(String(e));
    }
  };

  const exportForMobile = async () => {
    setError(null);
    try {
      const bundle = await api.exportMobileBundle();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `ai-buddy-mobile-handoff-${bundle.source.configVersions.prompts}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`モバイル引継ぎパッケージを書き出しました。SHA-256: ${bundle.integrity.digest}`);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const importBundle = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const value: unknown = JSON.parse(await file.text());
      await api.importMobileBundle(value);
      setConfig(await api.config());
      setSelected(null);
      setStatus('検証済みの引継ぎパッケージを読み込みました。次の新規試合から反映されます。');
    } catch (cause) {
      setError(String(cause));
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <>
      <TopBar title="設定・プロンプト" back="/" />
      <div className="page">
        <div className="card">
          <h2>📦 本番モバイルへ持ち越す</h2>
          <div className="muted small">
            現在のルール・能力・人格・モデル設定・全プロンプトを、バージョンとSHA-256付きの固定形式で書き出します。
            APIキーや愛言葉は含みません。本番ではプロンプトとLLM呼び出しをサーバー側に置いてください。
          </div>
          <div className="row">
            <button className="primary" onClick={() => void exportForMobile()}>
              モバイル引継ぎパッケージを書き出す
            </button>
            <button onClick={() => importRef.current?.click()}>引継ぎパッケージを読み込む</button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void importBundle(event.target.files?.[0])}
            />
          </div>
          {status && <div className="factbox">{status}</div>}
        </div>
        <div className="card">
          <h2>📁 設定ファイル</h2>
          <div className="muted small">
            ルール(組数/役職/日数/助言回数/同票処理/信頼度補正)・助言メニュー・能力アンロック・モデル/単価・バディはすべてここから変更できます。
            保存後、新しい試合を開始すると反映されます(コード変更・再起動は不要)。
          </div>
          <div className="row">
            {config?.editable.config.map((name) => (
              <button
                key={name}
                className={selected?.name === name ? 'primary' : 'ghost'}
                onClick={() => open('config', name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <h2>📝 プロンプト(v{config?.promptVersion})</h2>
          <div className="muted small">
            評価・発言・役職別プロンプトを編集できます。version.json
            を上げるとプロンプトバージョンとして試合に記録されます。
          </div>
          <div className="row">
            {config?.editable.prompts.map((name) => (
              <button
                key={name}
                className={selected?.name === name ? 'primary' : 'ghost'}
                onClick={() => open('prompt', name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        {selected && (
          <div className="card">
            <h2>✏️ {selected.name}</h2>
            <textarea rows={20} value={text} onChange={(e) => setText(e.target.value)} />
            <button className="primary" onClick={save}>
              保存(JSON/スキーマ検証あり)
            </button>
          </div>
        )}
        {error && <ErrorBox error={error} />}
        {!config && !error && <Spinner />}
      </div>
    </>
  );
}
