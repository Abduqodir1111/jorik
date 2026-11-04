import { useEffect, useRef, useState } from 'react';

export function useNotificationSound() {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem('jorik-sound') !== 'off'; } catch { return true; }
  });
  const [status, setStatus] = useState('');
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const context = useRef<AudioContext | null>(null);
  const buffer = useRef<AudioBuffer | null>(null);
  const last = useRef(0);
  useEffect(() => {
    const ctx = new AudioContext();
    context.current = ctx;
    let active = true;
    fetch('/audio/incoming.wav').then(r => {
      if (!r.ok) throw new Error('audio');
      return r.arrayBuffer();
    }).then(b => ctx.decodeAudioData(b)).then(b => { if (active) buffer.current = b; }).catch(() => { if (active) setStatus('Не удалось загрузить звук. Обновите страницу.'); });
    const unlock = () => { if (ctx.state === 'suspended') void ctx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { active = false; window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); void ctx.close(); context.current = null; };
  }, []);
  const play = (preview = false) => {
    const ctx = context.current;
    if (!ctx || !buffer.current || (!preview && !enabledRef.current)) return;
    if (!preview && (ctx.state !== 'running' || Date.now() - last.current < 1500)) return;
    const start = () => {
      if (ctx.state !== 'running' || !buffer.current) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer.current;
      source.connect(ctx.destination);
      source.start();
      last.current = Date.now();
      if (preview) setStatus('Пример: мягкий двойной сигнал.');
    };
    if (preview) void ctx.resume().then(start).catch(() => setStatus('Браузер заблокировал звук. Разрешите воспроизведение для сайта.'));
    else start();
  };
  return { play, settings: <section className="settings-card">
    <h2>Звук новых сообщений</h2>
    <label><input type="checkbox" checked={enabled} onChange={e => {
      const value = e.target.checked; setEnabled(value);
      try { localStorage.setItem('jorik-sound', value ? 'on' : 'off'); } catch {}
    }} /> Звуковое уведомление для Telegram и Instagram</label>
    <p>Мягкий двойной сигнал. После открытия страницы нажмите любую кнопку, чтобы браузер разрешил звук. Настройка сохраняется в этом браузере.</p>
    <button type="button" onClick={() => play(true)}>▶ Послушать пример</button>
    <p role="status">{status}</p>
  </section> };
}
