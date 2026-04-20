/**
 * SQLite 측정 이력 저장/조회
 * Uses Node.js built-in sqlite (node:sqlite) available since Node 22+
 * Falls back to JSON file storage for older Node versions
 */

import fs from 'fs';
import path from 'path';

export interface SpeedRecord {
  id?: number;
  isp: string;
  measured_at: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  sla_result: 'pass' | 'fail' | 'unknown';
  complaint_filed: boolean;
  complaint_result: 'success' | 'failed' | 'skipped' | 'not_applicable';
  raw_data: string;
  error: string;
}

export interface Stats {
  total: number;
  sla_pass: number;
  sla_fail: number;
  complaints_filed: number;
  avg_download_mbps: number;
  avg_upload_mbps: number;
  avg_ping_ms: number;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number };
  all(...params: unknown[]): Record<string, unknown>[];
}

function openSqlite(dbPath: string): SqliteDb | null {
  try {
    // Node 22.5+ built-in sqlite
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDb;
    };
    return new DatabaseSync(dbPath);
  } catch {
    return null;
  }
}

// ─── JSON fallback store ───────────────────────────────────────────────────

interface JsonStore {
  records: SpeedRecord[];
  nextId: number;
}

function readJsonStore(storePath: string): JsonStore {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw) as JsonStore;
  } catch {
    return { records: [], nextId: 1 };
  }
}

function writeJsonStore(storePath: string, store: JsonStore): void {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
}

// ─── SpeedDatabase ────────────────────────────────────────────────────────

export class SpeedDatabase {
  private dbPath: string;
  private db: SqliteDb | null;
  private jsonPath: string;
  private usingJson: boolean;

  constructor(dbPath: string) {
    // Expand ~ in path
    if (dbPath.startsWith('~/') || dbPath === '~') {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      dbPath = path.join(home, dbPath.slice(2));
    }

    this.dbPath = dbPath;
    this.jsonPath = dbPath.replace(/\.db$/, '.json');

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = openSqlite(dbPath);
    this.usingJson = this.db === null;

    if (!this.usingJson) {
      this.initDb();
      console.log(`DB: SQLite (${dbPath})`);
    } else {
      console.log(`DB: JSON fallback (${this.jsonPath})`);
    }
  }

  private initDb(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS speed_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isp TEXT NOT NULL,
        measured_at TEXT NOT NULL,
        download_mbps REAL DEFAULT 0,
        upload_mbps REAL DEFAULT 0,
        ping_ms REAL DEFAULT 0,
        sla_result TEXT DEFAULT 'unknown',
        complaint_filed INTEGER DEFAULT 0,
        complaint_result TEXT DEFAULT 'skipped',
        raw_data TEXT DEFAULT '{}',
        error TEXT DEFAULT ''
      )
    `);
  }

  save(record: Omit<SpeedRecord, 'id'>): number {
    if (!this.usingJson && this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO speed_records
          (isp, measured_at, download_mbps, upload_mbps, ping_ms,
           sla_result, complaint_filed, complaint_result, raw_data, error)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = stmt.run(
        record.isp,
        record.measured_at,
        record.download_mbps,
        record.upload_mbps,
        record.ping_ms,
        record.sla_result,
        record.complaint_filed ? 1 : 0,
        record.complaint_result,
        record.raw_data,
        record.error
      );

      return info.lastInsertRowid;
    } else {
      // JSON fallback
      const store = readJsonStore(this.jsonPath);
      const id = store.nextId++;
      store.records.push({ ...record, id });
      writeJsonStore(this.jsonPath, store);
      return id;
    }
  }

  getHistory(limit = 50, month?: string): SpeedRecord[] {
    if (!this.usingJson && this.db) {
      let query = 'SELECT * FROM speed_records';
      const params: unknown[] = [];

      if (month) {
        query += ' WHERE measured_at LIKE ?';
        params.push(`${month}%`);
      }

      query += ' ORDER BY measured_at DESC LIMIT ?';
      params.push(limit);

      const rows = this.db.prepare(query).all(...params);

      return rows.map((row) => ({
        id: row.id as number,
        isp: row.isp as string,
        measured_at: row.measured_at as string,
        download_mbps: (row.download_mbps as number) || 0,
        upload_mbps: (row.upload_mbps as number) || 0,
        ping_ms: (row.ping_ms as number) || 0,
        sla_result: (row.sla_result as 'pass' | 'fail' | 'unknown') || 'unknown',
        complaint_filed: Boolean(row.complaint_filed),
        complaint_result:
          (row.complaint_result as SpeedRecord['complaint_result']) || 'skipped',
        raw_data: (row.raw_data as string) || '{}',
        error: (row.error as string) || '',
      }));
    } else {
      // JSON fallback
      const store = readJsonStore(this.jsonPath);
      let records = [...store.records];

      if (month) {
        records = records.filter((r) => r.measured_at.startsWith(month));
      }

      records.sort((a, b) => b.measured_at.localeCompare(a.measured_at));
      return records.slice(0, limit);
    }
  }

  /** 오늘(KST 기준) 측정 기록 조회 */
  getTodayRecords(timezone = 'Asia/Seoul'): SpeedRecord[] {
    // measured_at은 UTC ISO 문자열(`...Z`)로 저장되므로, startsWith로 비교하면
    // KST 00:00–08:59(UTC 전날) 시간대의 기록이 누락된다.
    // 각 레코드의 UTC 시각을 타임존 로컬 날짜로 변환해서 비교한다.
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: timezone }); // YYYY-MM-DD
    return this.getHistory(9999).filter((r) => {
      const recordDate = new Date(r.measured_at);
      if (isNaN(recordDate.getTime())) return false;
      const localDate = recordDate.toLocaleDateString('sv-SE', { timeZone: timezone });
      return localDate === todayStr;
    });
  }

  /** 오늘 감면 신청 성공 여부 */
  hasTodayComplaintSuccess(timezone = 'Asia/Seoul'): boolean {
    return this.getTodayRecords(timezone).some((r) => r.complaint_result === 'success');
  }

  getStats(month?: string): Stats {
    const records = this.getHistory(9999, month);

    if (records.length === 0) {
      return {
        total: 0,
        sla_pass: 0,
        sla_fail: 0,
        complaints_filed: 0,
        avg_download_mbps: 0,
        avg_upload_mbps: 0,
        avg_ping_ms: 0,
      };
    }

    return {
      total: records.length,
      sla_pass: records.filter((r) => r.sla_result === 'pass').length,
      sla_fail: records.filter((r) => r.sla_result === 'fail').length,
      complaints_filed: records.filter((r) => r.complaint_filed).length,
      avg_download_mbps:
        records.reduce((s, r) => s + r.download_mbps, 0) / records.length,
      avg_upload_mbps:
        records.reduce((s, r) => s + r.upload_mbps, 0) / records.length,
      avg_ping_ms: records.reduce((s, r) => s + r.ping_ms, 0) / records.length,
    };
  }

  close(): void {
    this.db?.close();
  }
}
