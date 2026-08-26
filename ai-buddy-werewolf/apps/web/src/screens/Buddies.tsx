/** バディ設定画面: 名前・人格・話し方・能力値(0-100)を編集 */
import { useEffect, useState } from 'react';
import type { BuddiesConfig, BuddyConfig } from '@aibw/shared';
import { api } from '../api.js';
import { ErrorBox, Spinner, TopBar } from '../components.js';

export function Buddies() {
  const [config, setConfig] = useState<BuddiesConfig | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then((c) => setConfig(c.buddies))
      .catch((e) => setError(String(e)));
  }, []);

  const update = (index: number, patch: (b: BuddyConfig) => BuddyConfig) => {
    if (!config) return;
    const roster = config.roster.map((b, i) => (i === index ? patch(structuredClone(b)) : b));
    setConfig({ ...config, roster });
  };

  const save = async () => {
    if (!config) return;
    setStatus(null);
    setError(null);
    try {
      await api.writeFile('config', 'buddies.json', JSON.stringify(config, null, 2));
      setStatus('保存しました。次の新規試合から反映されます。');
    } catch (e) {
      setError(String(e));
    }
  };

  if (!config) {
    return (
      <>
        <TopBar title="バディ設定" back="/" />
        <div className="page">{error ? <ErrorBox error={error} /> : <Spinner />}</div>
      </>
    );
  }

  return (
    <>
      <TopBar title="バディ設定" back="/" />
      <div className="page">
        <div className="notice small">
          人格・口調は「どう表現するか」にだけ影響し、推論力・虚言力・親密度は人格と独立に設定します(役職はゲーム開始時に自動付与)。
        </div>
        {config.roster.map((b, i) => (
          <div key={b.id} className="card">
            <div className="row spread">
              <h2>
                {b.persona.name} <span className="badge">{b.persona.archetype}</span>
              </h2>
              <span className="muted small">id: {b.id}</span>
            </div>
            <div className="grid2">
              <label className="field">
                名前
                <input
                  value={b.persona.name}
                  onChange={(e) =>
                    update(i, (x) => ((x.persona.name = e.target.value), x))
                  }
                />
              </label>
              <label className="field">
                一人称
                <input
                  value={b.persona.firstPerson}
                  onChange={(e) => update(i, (x) => ((x.persona.firstPerson = e.target.value), x))}
                />
              </label>
              <label className="field">
                主人の呼び方
                <input
                  value={b.persona.masterCall}
                  onChange={(e) => update(i, (x) => ((x.persona.masterCall = e.target.value), x))}
                />
              </label>
              <label className="field">
                キャラクター性
                <input
                  value={b.persona.archetype}
                  onChange={(e) => update(i, (x) => ((x.persona.archetype = e.target.value), x))}
                />
              </label>
            </div>
            <label className="field">
              性格
              <input
                value={b.persona.personality}
                onChange={(e) => update(i, (x) => ((x.persona.personality = e.target.value), x))}
              />
            </label>
            <label className="field">
              話し方・口調
              <input
                value={b.persona.speechStyle}
                onChange={(e) => update(i, (x) => ((x.persona.speechStyle = e.target.value), x))}
              />
            </label>
            <div className="grid2">
              <label className="field">
                発言の長さ
                <select
                  value={b.persona.verbosity}
                  onChange={(e) =>
                    update(
                      i,
                      (x) => (
                        (x.persona.verbosity = e.target.value as 'short' | 'medium' | 'long'), x
                      ),
                    )
                  }
                >
                  <option value="short">短い</option>
                  <option value="medium">普通</option>
                  <option value="long">長い</option>
                </select>
              </label>
              <label className="field">
                感情表現
                <input
                  value={b.persona.emotion}
                  onChange={(e) => update(i, (x) => ((x.persona.emotion = e.target.value), x))}
                />
              </label>
            </div>
            {(['reasoning', 'deception', 'trust'] as const).map((key) => (
              <label key={key} className="field">
                {key === 'reasoning' ? '推論力' : key === 'deception' ? '虚言力' : '親密度'}:{' '}
                {b.abilities[key]}
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={b.abilities[key]}
                  onChange={(e) =>
                    update(i, (x) => ((x.abilities[key] = Number(e.target.value)), x))
                  }
                />
              </label>
            ))}
          </div>
        ))}
        <div className="actionbar">
          <button className="primary" onClick={save}>
            すべて保存
          </button>
        </div>
        {status && <div className="factbox">{status}</div>}
        {error && <ErrorBox error={error} />}
      </div>
    </>
  );
}
