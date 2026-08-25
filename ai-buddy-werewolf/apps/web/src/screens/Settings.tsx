/** 実験設定画面: 普段使う日本語UIと、開発者向け原文編集を分離する。 */
import { useEffect, useRef, useState } from 'react';
import { api, type ConfigResponse } from '../api.js';
import { ErrorBox, Spinner, TopBar } from '../components.js';
import {
  CONFIG_FILE_META,
  PROMPT_FILE_META,
  configFileLabel,
  promptFileLabel,
} from '../uiLabels.js';
import { EasySettings } from './EasySettings.js';

export function Settings() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [selected, setSelected] = useState<{ kind: 'config' | 'prompt'; name: string } | null>(null);
  const [text, setText] = useState('');
  const [promptVersion, setPromptVersion] = useState('');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const refreshConfig = async () => {
    const next = await api.config();
    setConfig(next);
    setPromptVersion(next.promptVersion);
  };

  useEffect(() => {
    void refreshConfig().catch((cause) => setError(String(cause)));
  }, []);

  const open = async (kind: 'config' | 'prompt', name: string) => {
    setError(null);
    setStatus(null);
    try {
      const res = await api.readFile(kind, name);
      setSelected({ kind, name });
      setText(res.text);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const saveAdvanced = async () => {
    if (!selected || selected.kind !== 'config') return;
    setStatus(null);
    setError(null);
    try {
      await api.writeFile('config', selected.name, text);
      await refreshConfig();
      setSettingsRevision((revision) => revision + 1);
      setStatus(`${configFileLabel(selected.name)}を保存しました。次の新規試合から反映されます。`);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const savePrompt = async () => {
    if (!selected || selected.kind !== 'prompt' || selected.name === 'version.json') return;
    setStatus(null);
    setError(null);
    if (!promptVersion.trim()) {
      setError('プロンプトの版番号を入力してください。');
      return;
    }
    try {
      await api.writeFile('prompt', selected.name, text);
      await api.writeFile(
        'prompt',
        'version.json',
        JSON.stringify({ version: promptVersion.trim() }, null, 2),
      );
      await refreshConfig();
      setStatus(`${promptFileLabel(selected.name)}と版番号を保存しました。次の新規試合から反映されます。`);
    } catch (cause) {
      setError(String(cause));
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
      setStatus(`本番モバイル用データを書き出しました。改ざん確認番号: ${bundle.integrity.digest}`);
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
      await refreshConfig();
      setSettingsRevision((revision) => revision + 1);
      setSelected(null);
      setStatus('検証済みの本番モバイル用データを読み込みました。次の新規試合から反映されます。');
    } catch (cause) {
      setError(String(cause));
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const promptNames = config?.editable.prompts.filter((name) => name !== 'version.json') ?? [];

  return (
    <>
      <TopBar title="実験設定" back="/" />
      <div className="page">
        <div className="card handoff-card">
          <h2>📦 本番モバイルへ持ち越す</h2>
          <div className="muted small">
            ここで調整したルール・バディ・AIモデル・全プロンプトを、ひとつのファイルにまとめます。本番モバイル側は同じ内容を読み込めます。APIキーと愛言葉は含みません。
          </div>
          <div className="row">
            <button className="primary" onClick={() => void exportForMobile()}>
              本番モバイル用データを書き出す
            </button>
            <button onClick={() => importRef.current?.click()}>保存データを読み込む</button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void importBundle(event.target.files?.[0])}
            />
          </div>
        </div>

        <EasySettings key={settingsRevision} onSaved={refreshConfig} />

        <div className="card prompt-settings">
          <div>
            <h2>📝 AIへの指示文（プロンプト）</h2>
            <div className="muted small">
              変えたい役割を日本語名から選び、指示文を直接調整します。文中の <span className="mono">{'{{名前}}'}</span> のような置換記号は消さないでください。
            </div>
          </div>
          <label className="field compact-version">
            プロンプトの版番号
            <span className="setting-help">内容を変えたら番号も更新すると、試合ごとの差を追跡できます。</span>
            <input value={promptVersion} onChange={(event) => setPromptVersion(event.target.value)} />
          </label>
          <div className="file-choice-grid">
            {promptNames.map((name) => (
              <button
                key={name}
                className={selected?.kind === 'prompt' && selected.name === name ? 'primary' : 'ghost'}
                onClick={() => void open('prompt', name)}
              >
                {promptFileLabel(name)}
              </button>
            ))}
          </div>
          {selected?.kind === 'prompt' && (
            <div className="editor-block">
              <div>
                <h3>{promptFileLabel(selected.name)}</h3>
                <div className="muted small">{PROMPT_FILE_META[selected.name]?.description}</div>
                <div className="mono technical-name">内部ファイル名: {selected.name}</div>
              </div>
              <textarea rows={20} value={text} onChange={(event) => setText(event.target.value)} />
              <button className="primary" onClick={() => void savePrompt()}>
                この指示文と版番号を保存
              </button>
            </div>
          )}
        </div>

        <details className="card advanced-settings">
          <summary>🛠 開発者向け詳細設定（JSON原文）</summary>
          <div className="notice small">
            通常は上の「かんたん設定」で十分です。ここは能力の解放条件など、すべての内部項目を直接変更したい場合に使います。壊れたJSONは保存時に拒否されます。
          </div>
          <div className="file-choice-grid">
            {config?.editable.config.map((name) => (
              <button
                key={name}
                className={selected?.kind === 'config' && selected.name === name ? 'primary' : 'ghost'}
                onClick={() => void open('config', name)}
              >
                {configFileLabel(name)}
              </button>
            ))}
          </div>
          {selected?.kind === 'config' && (
            <div className="editor-block">
              <div>
                <h3>{configFileLabel(selected.name)}</h3>
                <div className="muted small">{CONFIG_FILE_META[selected.name]?.description}</div>
                <div className="mono technical-name">内部ファイル名: {selected.name}</div>
              </div>
              <textarea rows={20} value={text} onChange={(event) => setText(event.target.value)} />
              <button className="primary" onClick={() => void saveAdvanced()}>
                この詳細設定を保存（内容チェックあり）
              </button>
            </div>
          )}
        </details>

        {status && <div className="factbox">{status}</div>}
        {error && <ErrorBox error={error} />}
        {!config && !error && <Spinner label="実験設定を読み込み中…" />}
      </div>
    </>
  );
}
