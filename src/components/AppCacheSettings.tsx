import {useCallback, useEffect, useRef, useState} from 'react';
import {CheckCircle2, Info, Loader2, Monitor, RefreshCw, ShieldCheck, Trash2, TriangleAlert} from 'lucide-react';
import {bridge} from '../bridge';
import {formatBytes} from '../../shared/bytes';
import type {AppCacheInfo} from '../../shared/types';
import {Button, SectionHeading} from './ui';
import '../app-cache.css';

type CacheOperation = 'scan' | 'clear';

export function AppCacheSettings({desktop}: {desktop: boolean}) {
  const [cache, setCache] = useState<AppCacheInfo | null>(null);
  const [busy, setBusy] = useState<CacheOperation | null>(desktop ? 'scan' : null);
  const [error, setError] = useState('');
  const [freedBytes, setFreedBytes] = useState<number | null>(null);
  const pending = useRef(false);
  const requestVersion = useRef(0);

  const run = useCallback(async (operation: CacheOperation) => {
    if (!desktop || pending.current) return;
    pending.current = true;
    const request = ++requestVersion.current;
    setBusy(operation);
    setError('');
    setFreedBytes(null);
    try {
      if (operation === 'clear') {
        const result = await bridge.clearAppCache();
        if (request !== requestVersion.current) return;
        setCache(result.cache);
        setFreedBytes(result.freedBytes);
      } else {
        const result = await bridge.appCache();
        if (request !== requestVersion.current) return;
        setCache(result);
      }
    } catch (cause) {
      if (request !== requestVersion.current) return;
      const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
      setError((operation === 'clear' ? '清理缓存失败' : '缓存占用计算失败') + (message.trim() ? '：' + message : '，请稍后重试。'));
    } finally {
      if (request === requestVersion.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    // Scan only while this settings section is mounted; cancel StrictMode's discarded mount.
    const timer = window.setTimeout(() => void run('scan'), 0);
    return () => {
      window.clearTimeout(timer);
      requestVersion.current++;
      pending.current = false;
    };
  }, [desktop, run]);

  const info = desktop ? cache : null;
  const working = desktop && busy !== null;
  const scannedAt = info && Number.isFinite(info.scannedAt) && info.scannedAt > 0 ? new Date(info.scannedAt) : null;
  const hasWarnings = !!info?.warnings.length;

  return <section className="surface panel app-cache-settings" aria-label="应用缓存" aria-busy={working}>
    <SectionHeading title="应用缓存" sub="查看本机占用，清理网页缓存与可移除的更新安装包"/>
    <dl className="app-cache-metrics">
      <div className="app-cache-total"><dt>总占用</dt><dd>{info ? formatBytes(info.totalBytes) : '—'}</dd></div>
      <div><dt>网页缓存</dt><dd>{info ? formatBytes(info.browserBytes) : '—'}</dd></div>
      <div><dt>更新安装包</dt><dd>{info ? formatBytes(info.updateBytes) : '—'}</dd></div>
    </dl>
    <div className="app-cache-notes">
      <p><ShieldCheck size={15} aria-hidden="true"/><span>清理后，账号、设置、模型变动记录、工具配置和备份均会保留。</span></p>
      <p><Info size={15} aria-hidden="true"/><span>正在下载或等待安装的更新包会保留，不参与清理。{info && info.protectedBytes > 0 && <>当前保留 {formatBytes(info.protectedBytes)}。</>}</span></p>
    </div>
    <div className="app-cache-feedback" aria-live="polite" aria-atomic="true">
      {!desktop ? <p className="app-cache-message"><Monitor size={15} aria-hidden="true"/><span>浏览器预览无法读取本机应用缓存。请在 Lumi 桌面应用中计算占用或清理缓存。</span></p>
        : working ? <p className="app-cache-message"><Loader2 size={15} className="spin" aria-hidden="true"/><span>{busy === 'clear' ? '正在清理缓存并重新计算占用…' : '正在计算缓存占用…'}{info && '占用与计算时间仍为上次结果。'}</span></p>
        : error ? <p className="app-cache-message error" role="alert"><TriangleAlert size={15} aria-hidden="true"/><span>{error}{info && '当前显示上次计算结果，可重新计算。'}</span></p>
        : freedBytes !== null ? <p className="app-cache-message success"><CheckCircle2 size={15} aria-hidden="true"/><span>{hasWarnings ? '缓存清理已结束' : '缓存清理完成'}，已释放 {formatBytes(freedBytes)}。{hasWarnings && '部分缓存未能处理，请查看下方提示。'}</span></p>
        : null}
    </div>
    {hasWarnings && <div className="app-cache-warnings" role="note" aria-label="缓存操作提示">
      <p><TriangleAlert size={15} aria-hidden="true"/><span>部分缓存未能完整统计或清理，占用可能不完整。</span></p>
      <ul>{info!.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </div>}
    <div className="app-cache-footer">
      <span className="app-cache-timestamp">{!desktop ? '占用仅支持桌面应用' : scannedAt ? <>上次计算 <time dateTime={scannedAt.toISOString()}>{scannedAt.toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false})}</time></> : '尚未完成计算'}</span>
      <div className="app-cache-actions">
        <Button type="button" disabled={!desktop || working} busy={desktop && busy === 'scan'} onClick={() => void run('scan')}>{busy !== 'scan' && <RefreshCw size={15} aria-hidden="true"/>}{desktop && busy === 'scan' ? '计算中…' : '重新计算'}</Button>
        <Button type="button" variant="primary" disabled={!desktop || working || !info} busy={desktop && busy === 'clear'} onClick={() => void run('clear')}>{busy !== 'clear' && <Trash2 size={15} aria-hidden="true"/>}{desktop && busy === 'clear' ? '清理中…' : '清理缓存'}</Button>
      </div>
    </div>
  </section>;
}
