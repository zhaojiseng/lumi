import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import {resolveRange,statisticsFilters} from '../../shared/range';
import type { DashboardQuery,LocalUsage, LocalUsageRow, Tool } from '../../shared/types';
interface Counters { input: number; output: number; cache: number; write: number; }
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
function counters(u: any): Counters { return { input: n(u.input_tokens), output: n(u.output_tokens), cache: n(u.cached_input_tokens ?? u.cache_read_input_tokens), write: n(u.cache_creation_input_tokens) }; }
export function codexDelta(current: Counters, previous: Counters, last?: Counters): Counters {
  // Some Codex versions reset cumulative counters during compaction.
  if (current.input < previous.input || current.output < previous.output) return last || current;
  return { input: current.input - previous.input, output: current.output - previous.output, cache: Math.max(0, current.cache - previous.cache), write: Math.max(0, current.write - previous.write) };
}
async function walk(root: string, cutoff: number, warnings: string[], files: string[], depth = 0) {
  if (depth > 9 || files.length >= 2000) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (e: any) { if (e.code !== 'ENOENT') warnings.push(`无法读取目录：${root}`); return; }
  for (const e of entries) {
    if (files.length >= 2000) break;
    const p = path.join(root, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) await walk(p, cutoff, warnings, files, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { const s = await stat(p); if (s.mtimeMs >= cutoff) { if (s.size <= 32 * 1024 * 1024) files.push(p); else warnings.push(`跳过超过 32 MB 的会话：${e.name}`); } } catch { warnings.push(`无法读取会话：${e.name}`); }
    }
  }
}
export class LocalUsageService {
  private cache = new Map<string, { at: number; data: LocalUsage }>();
  private inFlight = new Map<string, Promise<LocalUsage>>();
  private home: string;
  private respectEnvironment: boolean;
  constructor(home?: string) { this.home = home || process.env.LUMI_TEST_HOME || os.homedir(); this.respectEnvironment = !home && !process.env.LUMI_TEST_HOME; }
  async scan(query: DashboardQuery): Promise<LocalUsage> {
    const key=JSON.stringify([resolveRange(query).range,statisticsFilters(query)]);
    const cached = this.cache.get(key); if (cached && Date.now() - cached.at < 60000) return cached.data;
    if (this.inFlight.has(key)) return this.inFlight.get(key)!;
    const request = this.read(query); this.inFlight.set(key, request);
    try { const data = await request; this.cache.set(key, { at: Date.now(), data });if(this.cache.size>12)this.cache.delete(this.cache.keys().next().value!);return data; } finally { this.inFlight.delete(key); }
  }
  private async read(query: DashboardQuery): Promise<LocalUsage> {
    const window=resolveRange(query),filters=statisticsFilters(query),cutoff=window.start_timestamp*1000;
    const warnings: string[] = []; const rows = new Map<string, LocalUsageRow>();
    if(filters.tokenIds?.length)return {rows:[],filesScanned:0,warnings:['本机会话不包含 API 令牌 ID，无法按令牌筛选。清除令牌筛选后查看本地统计。'],scannedAt:Date.now()};
    const sessions = new Map<string, Set<string>>(); const codexSeen = new Set<string>();
    const claudeMessages = new Map<string, { timestamp: number; model: string; count: Counters; session: string }>();
    const codexRoot = this.respectEnvironment && process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(this.home, '.codex');
    const claudeRoot = this.respectEnvironment && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(this.home, '.claude');
    const codexFiles: string[] = []; const claudeFiles: string[] = [];
    await Promise.all([walk(path.join(codexRoot, 'sessions'), cutoff, warnings, codexFiles), walk(path.join(codexRoot, 'archived_sessions'), cutoff, warnings, codexFiles), walk(path.join(claudeRoot, 'projects'), cutoff, warnings, claudeFiles)]);
    if (codexFiles.length >= 2000 || claudeFiles.length >= 2000) warnings.push('本次扫描达到 2000 个文件上限，统计可能不完整。');
    const add = (tool: Tool, timestamp: number, model: string, c: Counters, session: string) => {
      if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > window.end_timestamp*1000+999 || filters.models?.length && !filters.models.includes(model) || !(c.input + c.output + c.cache + c.write)) return;
      const date = new Date(timestamp).toLocaleDateString('sv-SE'); const key = `${tool}|${date}|${model}`;
      const r = rows.get(key) || { tool, date, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, sessions: 0 };
      r.inputTokens += c.input; r.outputTokens += c.output; r.cacheReadTokens += c.cache; r.cacheWriteTokens += c.write; r.requests++;
      const ids = sessions.get(key) || new Set<string>(); ids.add(session); sessions.set(key, ids); r.sessions = ids.size; rows.set(key, r);
    };
    let filesScanned = 0;
    for (const [tool, files] of [['codex', codexFiles], ['claude', claudeFiles]] as [Tool, string[]][]) {
      for (const file of files) {
        let previous: Counters = { input: 0, output: 0, cache: 0, write: 0 }; let model = 'unknown'; let session = path.basename(file);
        const stream = createReadStream(file, { encoding: 'utf8' }); const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            let e: any; try { e = JSON.parse(line); } catch { continue; }
            if (tool === 'codex') {
              if (e.type === 'session_meta') session = e.payload?.id || session;
              if (e.type === 'turn_context') model = e.payload?.model || model;
              if (e.type !== 'event_msg' || e.payload?.type !== 'token_count' || !e.payload.info) continue;
              const info = e.payload.info; const timestamp = Date.parse(e.timestamp);
              const current = info.total_token_usage ? counters(info.total_token_usage) : undefined;
              const last = info.last_token_usage ? counters(info.last_token_usage) : undefined;
              if (!current && !last) continue;
              const delta = current ? codexDelta(current, previous, last) : last!;
              if (current) previous = current;
              const signature = `${session}|${e.timestamp}|${JSON.stringify(current || last)}`;
              if (codexSeen.has(signature)) continue; codexSeen.add(signature);
              // Codex's input counter includes cached input tokens. Report uncached input separately.
              add(tool, timestamp, info.model || model, { ...delta, input: Math.max(0, delta.input - delta.cache) }, session);
            } else {
              if (e.type !== 'assistant' || !e.message?.usage || e.isApiErrorMessage) continue;
              const msg = e.message; const id = msg.id || e.uuid; if (!id) continue;
              const timestamp = Date.parse(e.timestamp); if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
              const c = counters(msg.usage); const key = `${e.sessionId || session}|${id}`;
              const old = claudeMessages.get(key);
              // Streamed assistant snapshots reuse message.id; keep the largest completed usage.
              if (!old || c.output >= old.count.output) claudeMessages.set(key, { timestamp, model: msg.model || 'unknown', count: c, session: e.sessionId || session });
            }
          }
          filesScanned++;
        } catch { warnings.push(`会话读取不完整：${path.basename(file)}`); } finally { lines.close(); stream.destroy(); }
      }
    }
    for (const m of claudeMessages.values()) add('claude', m.timestamp, m.model, m.count, m.session);
    return { rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)), filesScanned, warnings: [...new Set(warnings)], scannedAt: Date.now() };
  }
}
