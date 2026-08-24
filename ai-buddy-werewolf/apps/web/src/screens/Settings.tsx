/** 設定・プロンプト編集画面(ファイルをそのまま編集する管理UI) */
import { useEffect, useState } from 'react';
import { api, type ConfigResponse } from '../api.js';
import { ErrorBox, Spinner, TopBar } from '../components.js';

export function Settings() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [selected, setSelected] = useState<{ kind: 'config' | 'prompt'; name: string } | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <TopBar title="設定・プロンプト" back="/" />
      <div className="page">
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
            {status && <div className="factbox">{status}</div>}
          </div>
        )}
        {error && <ErrorBox error={error} />}
        {!config && !error && <Spinner />}
      </div>
    </>
  );
}
