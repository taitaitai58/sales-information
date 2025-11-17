import { chromium, Page, BrowserContext, type Browser } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';

/**
 * インターンシップ詳細テーブルの1行を表す型
 */
type InternshipRow = {
  heading: string;
  value: string;
};

/**
 * CSV に保存する企業情報のレコード型
 */
type CsvRecord = {
  companyName: string;
  phone: string;
  email: string;
  industry: string;
  headOffice: string;
  tableUrl: string;
  tableJson: string;
  annualRecruitment: string;
  companySize: string;
};

// グローバル状態管理
let globalContext: BrowserContext | null = null;
let isPaused = false;
let shouldStop = false;

// マイナビサイトのURL
const TOP_URL = 'https://job.mynavi.jp/27/pc/';

// ファイルパス設定
const USER_DATA_DIR = path.join(__dirname, 'mynavi-user-data');
const OUTPUT_CSV = path.join(__dirname, 'mynavi_internships.csv');
const CONFIG_PATH = path.join(__dirname, 'mynavi-config.json');
const SESSION_FILE = path.join(__dirname, 'sheet-session.json');

// Google スプレッドシート用の設定
const GOOGLE_USER_DATA_DIR = path.join(
  __dirname,
  process.env.SHEET_USER_DATA_DIR || 'google-user-data',
);
// Chrome リモートデバッグ用のポートとホスト（環境変数で上書き可能）
const REMOTE_DEBUG_PORT = Number(process.env.SHEET_REMOTE_DEBUG_PORT || 9223);
const REMOTE_DEBUG_HOST = process.env.SHEET_REMOTE_DEBUG_HOST || '127.0.0.1';

// Chrome プロセス管理用
let chromeProcess: ChildProcess | null = null;

/**
 * マイナビスクレイピング用の設定ファイルの型
 */
type MynaviConfig = {
  SEARCH_URL: string;
  START_PAGE: number;
  MAX_COMPANIES?: number | undefined;
  SPREADSHEET_URL?: string | undefined;
  CSV_PATH?: string | undefined;
  GAS_UPLOAD_URL?: string | undefined;
  GAS_UPLOAD_TOKEN?: string | undefined;
};

/**
 * Google Apps Script へのアップロード設定
 */
type GasConfig = {
  uploadUrl: string;
  token: string | null;
};

/**
 * スプレッドシート同期に必要な設定（必須項目）
 */
type RequiredSheetConfig = {
  spreadsheetUrl: string;
  csvPath: string;
};

/**
 * 設定ファイル（mynavi-config.json）を読み込む
 * 読み込みに失敗した場合はデフォルト値を返す
 */
function loadConfig(): MynaviConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as Partial<MynaviConfig>;
    if (!parsed.SEARCH_URL || typeof parsed.SEARCH_URL !== 'string') {
      throw new Error('SEARCH_URL が設定ファイルに定義されていません。');
    }
    const startPage =
      typeof parsed.START_PAGE === 'number' && parsed.START_PAGE >= 1
        ? Math.floor(parsed.START_PAGE)
        : 1;
    // 環境変数から MAX_COMPANIES を優先的に読み取る（Electron アプリから渡される場合がある）
    let maxCompanies = undefined;
    if (process.env.MAX_COMPANIES) {
      const envMaxCompanies = parseInt(process.env.MAX_COMPANIES, 10);
      if (Number.isFinite(envMaxCompanies) && envMaxCompanies >= 1) {
        maxCompanies = Math.floor(envMaxCompanies);
      }
    }
    // 環境変数が設定されていない場合は設定ファイルから読み取る
    if (maxCompanies === undefined) {
      maxCompanies =
        typeof parsed.MAX_COMPANIES === 'number' && parsed.MAX_COMPANIES >= 1
          ? Math.floor(parsed.MAX_COMPANIES)
          : undefined;
    }
    return {
      SEARCH_URL: parsed.SEARCH_URL,
      START_PAGE: startPage,
      MAX_COMPANIES: maxCompanies,
      SPREADSHEET_URL: parsed.SPREADSHEET_URL,
      CSV_PATH: parsed.CSV_PATH,
      GAS_UPLOAD_URL: parsed.GAS_UPLOAD_URL,
      GAS_UPLOAD_TOKEN: parsed.GAS_UPLOAD_TOKEN,
    };
  } catch (error) {
    console.warn(
      '設定ファイル mynavi-config.json の読み込みに失敗したため、デフォルトの SEARCH_URL を使用します。',
      error,
    );
    return {
      SEARCH_URL:
        'https://job.mynavi.jp/27/pc/corpinfo/searchCorpListByGenCond/index/?cond=HR:13,14,25,26,27,28,29,30/ER:1',
      START_PAGE: 1,
    };
  }
}

/**
 * GAS アップロード設定を取得する
 * GAS_UPLOAD_URL が設定されていない場合は null を返す
 */
function getGasConfig(config: MynaviConfig): GasConfig | null {
  if (!config.GAS_UPLOAD_URL) {
    console.warn('GAS_UPLOAD_URL が設定されていないため、GAS へのアップロードはスキップされます。');
    return null;
  }

  return {
    uploadUrl: config.GAS_UPLOAD_URL,
    token: config.GAS_UPLOAD_TOKEN ?? null,
  };
}

/**
 * スプレッドシート同期に必要な設定を取得する
 * 必須項目が設定されていない場合はエラーを投げる
 */
function getSheetConfig(config: MynaviConfig): RequiredSheetConfig {
  const spreadsheetUrl = config.SPREADSHEET_URL;
  const csvPath = config.CSV_PATH;

  if (!spreadsheetUrl) {
    throw new Error('SPREADSHEET_URL が設定されていません。mynavi-config.json を確認してください。');
  }
  if (!csvPath) {
    throw new Error('CSV_PATH が設定されていません。mynavi-config.json を確認してください。');
  }

  return { spreadsheetUrl, csvPath };
}

const CONFIG = loadConfig();
const { SEARCH_URL, START_PAGE } = CONFIG;
const GAS_CONFIG = getGasConfig(CONFIG);

// ユーザーエージェント（一般的な Chrome on Mac）
// 必要に応じて更新してください
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 正規表現パターン
const PHONE_REGEX = /0\d{1,4}-\d{1,4}-\d{3,4}/g;
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// ページ遷移などの待ち時間（ミリ秒）
// サーバー負荷軽減のため、必要に応じて調整してください（例: 500, 1000, 2000 など）
const DELAY_MS = 300;

/**
 * Chrome プロファイルのロックファイルを削除する
 * 前回の実行が異常終了した場合に残るロックファイルをクリーンアップ
 */
function cleanupProfileLocks(profileDir: string) {
  const lockFiles = ['SingletonSocket', 'SingletonCookie', 'SingletonLock'];
  for (const file of lockFiles) {
    const fullPath = path.join(profileDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // 失敗しても無視（別プロセスが本当に使用中の可能性がある）
      }
    }
  }
}

/**
 * Google スプレッドシートの URL から CSV エクスポート用の URL を生成する
 */
function buildCsvExportUrl(spreadsheetUrl: string): string {
  const match = spreadsheetUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) {
    throw new Error(
      `スプレッドシートの URL 形式が想定外です: ${spreadsheetUrl}\n` +
        '例: https://docs.google.com/spreadsheets/d/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/edit',
    );
  }
  const sheetId = match[1];
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
}

/**
 * CSV ファイルパスを解決する（相対パスの場合は絶対パスに変換）
 */
function resolveCsvPath(csvPath: string): string {
  if (path.isAbsolute(csvPath)) {
    return csvPath;
  }
  return path.join(__dirname, csvPath);
}

/**
 * Google ユーザーデータディレクトリが存在しない場合は作成する
 */
function ensureUserDataDir() {
  if (!fs.existsSync(GOOGLE_USER_DATA_DIR)) {
    fs.mkdirSync(GOOGLE_USER_DATA_DIR, { recursive: true });
  }
}

/**
 * Chrome の実行ファイルパスを検出する
 * 環境変数 CHROME_PATH が設定されている場合はそれを使用
 * それ以外は一般的なインストール場所を順に確認
 */
function detectChromeExecutable(): string {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates: string[] = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  throw new Error(
    'Chrome の実行ファイルが見つかりませんでした。CHROME_PATH 環境変数でパスを指定するか、Google Chrome をインストールしてください。',
  );
}

/**
 * Chrome DevTools Protocol (CDP) エンドポイントが準備完了するまで待機する
 * @param url CDP エンドポイントの URL
 * @param timeoutMs タイムアウト時間（ミリ秒、デフォルト: 15秒）
 */
function waitForCdpReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (Date.now() > deadline) {
        reject(new Error('Chrome のリモートデバッグエンドポイントに接続できませんでした。'));
        return;
      }

      const req = http.get(`${url.replace(/\/$/, '')}/json/version`, res => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          res.resume();
          resolve();
        } else {
          res.resume();
          setTimeout(tryOnce, 500);
        }
      });

      req.on('error', () => {
        setTimeout(tryOnce, 500);
      });
    };

    tryOnce();
  });
}

/**
 * Chrome をリモートデバッグモードで起動する
 * 既に起動中の場合は既存の CDP URL を返す
 * @returns CDP エンドポイントの URL
 */
async function launchChromeRemoteDebugging(): Promise<string> {
  if (chromeProcess && !chromeProcess.killed) {
    return `http://${REMOTE_DEBUG_HOST}:${REMOTE_DEBUG_PORT}`;
  }

  ensureUserDataDir();
  const chromePath = detectChromeExecutable();

  const args = [
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    `--user-data-dir=${GOOGLE_USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  chromeProcess = spawn(chromePath, args, {
    stdio: 'ignore',
    detached: false,
  });

  const cdpUrl = `http://${REMOTE_DEBUG_HOST}:${REMOTE_DEBUG_PORT}`;
  await waitForCdpReady(cdpUrl);
  return cdpUrl;
}

/**
 * 起動中の Chrome プロセスを終了する
 */
function terminateChromeProcess() {
  if (chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill();
  }
  chromeProcess = null;
}

/**
 * Playwright の storageState の型（簡易版）
 */
type StorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

/**
 * 保存済みのセッション情報を読み込む
 * @returns セッション情報（存在しない場合は null）
 */
function loadSession(): StorageState | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(SESSION_FILE, { encoding: 'utf8' });
    return JSON.parse(raw) as StorageState;
  } catch {
    return null;
  }
}

/**
 * セッション情報をファイルに保存する
 * @param state 保存するセッション情報
 */
function saveSession(state: StorageState) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2), { encoding: 'utf8' });
}

/**
 * 保存済みのセッション情報を使用して CSV をダウンロードする
 * @param state セッション情報
 * @param csvUrl CSV エクスポート用の URL
 */
async function downloadCsvWithSession(state: StorageState, csvUrl: string): Promise<string> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({ storageState: state });
  try {
    const response = await context.request.get(csvUrl, {
      timeout: 60_000,
      headers: {
        Accept: 'text/csv,application/csv;q=0.9,*/*;q=0.8',
      },
    });

    if (response.status() !== 200) {
      const preview = (await response.text()).slice(0, 500);
      throw new Error(
        `CSV の取得に失敗しました: ${response.status()} ${response.statusText()}\n${preview}`,
      );
    }

    return await response.text();
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * インタラクティブに Google スプレッドシートへのログインセッションを取得する
 * ユーザーがブラウザでログインした後、Enter キーを押すまで待機
 * @param spreadsheetUrl 対象のスプレッドシート URL
 * @returns 取得したセッション情報
 */
async function captureSessionInteractive(spreadsheetUrl: string): Promise<StorageState> {
  const cdpUrl = await launchChromeRemoteDebugging();
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(spreadsheetUrl, { waitUntil: 'domcontentloaded' });

    console.log(
      'ブラウザで Google アカウントにログインし、対象のスプレッドシートが開けることを確認してください。',
    );
    console.log('ログインが完了したら、このターミナルに戻って Enter キーを押してください。');

    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    });

    const storageState = await context.storageState();
    saveSession(storageState);
    return storageState;
  } finally {
    await Promise.all(browser.contexts().map(ctx => ctx.close()));
    await browser.close();
    terminateChromeProcess();
    process.stdin.pause();
  }
}

/**
 * セッション情報を確保して CSV をダウンロードする
 * 保存済みのセッションが有効な場合はそれを使用し、無効な場合は新規取得
 * @param spreadsheetUrl 対象のスプレッドシート URL
 */
async function ensureSessionAndDownload(spreadsheetUrl: string): Promise<string> {
  const csvUrl = buildCsvExportUrl(spreadsheetUrl);
  const existingState = loadSession();

  if (existingState) {
    try {
      return await downloadCsvWithSession(existingState, csvUrl);
    } catch (error) {
      console.warn('保存済みのセッションで CSV の取得に失敗しました。ログインを再取得します。', error);
    }
  }

  const updatedState = await captureSessionInteractive(spreadsheetUrl);
  return await downloadCsvWithSession(updatedState, csvUrl);
}

/**
 * スプレッドシートから CSV をダウンロードして保存する
 * SPREADSHEET_URL または CSV_PATH が設定されていない場合はスキップ
 * @param config 設定オブジェクト
 */
async function downloadCsvFromSpreadsheet(config: MynaviConfig) {
  if (!config.SPREADSHEET_URL || !config.CSV_PATH) {
    console.log('SPREADSHEET_URL または CSV_PATH が設定されていないため、シートからの同期はスキップします。');
    return;
  }

  const { spreadsheetUrl, csvPath } = getSheetConfig(config);
  const csvText = await ensureSessionAndDownload(spreadsheetUrl);

  const outputPath = resolveCsvPath(csvPath);
  fs.writeFileSync(outputPath, csvText, { encoding: 'utf8' });

  console.log(`スプレッドシートから CSV をダウンロードし、保存しました: ${outputPath}`);
}

/**
 * CSV ファイルのヘッダー行を確保する
 * ファイルが存在しない場合は新規作成、既存ファイルのヘッダーが古い場合は更新
 */
async function ensureCsvHeader() {
  const header =
    '日付,担当者,温度感,受付ブロック,商談中,営業目的,採用ターゲット,企業名,電話番号,メールアドレス,HP,担当者様,備考,リスト元,企業規模,業界,本社地域,年間採用人数,上場,属性\n';
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(OUTPUT_CSV, header, { encoding: 'utf8' });
    return;
  }

  // 既存ファイルのヘッダーが古い場合は上書き（過去のデータは消える）
  const content = fs.readFileSync(OUTPUT_CSV, { encoding: 'utf8' });
  const firstLine = content.split('\n')[0] ?? '';
  if (firstLine.trim() !== header.trim()) {
    const [, ...rest] = content.split('\n');
    const newContent = [header.trim(), ...rest].join('\n');
    fs.writeFileSync(OUTPUT_CSV, newContent, { encoding: 'utf8' });
  }
}

/**
 * シグナルハンドラーを設定する（SIGINT, SIGTERM）
 * 安全に処理を終了できるようにする
 */
function setupSignalHandlers() {
  const handler = (signal: NodeJS.Signals) => {
    console.log(`${signal} を受信しました。現在の処理を安全に終了します...`);
    shouldStop = true;
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

/**
 * インタラクティブな制御を設定する
 * p: 一時停止/再開
 * q: 安全に終了
 * Ctrl+C: 安全に終了
 */
function setupInteractiveControls() {
  if (process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // 一部環境では setRawMode が失敗する場合があるので無視
    }
  }

  process.stdin.resume();
  process.stdin.on('data', data => {
    const key = data.toString();

    // Ctrl+C
    if (key === '\u0003') {
      console.log('Ctrl+C を受信しました。現在の処理が一区切りついたら終了します。');
      shouldStop = true;
      return;
    }

    const trimmed = key.trim().toLowerCase();
    if (trimmed === 'p') {
      isPaused = !isPaused;
      console.log(isPaused ? '一時停止中... (再開するには p キーを押してください)' : '再開しました。');
    } else if (trimmed === 'q') {
      console.log('終了要求(q)を受信しました。現在の企業の処理が終わり次第終了します。');
      shouldStop = true;
    }
  });
}

/**
 * 一時停止中の場合、再開されるまで待機する
 */
async function waitIfPaused() {
  while (isPaused && !shouldStop) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * 企業名を正規化する（改行、タブ、余分な空白を削除、「PICK UP」を削除）
 * @param companyName 正規化する企業名
 * @returns 正規化された企業名
 */
function normalizeCompanyName(companyName: string): string {
  return companyName
    .trim()
    .replace(/\s*PICK UP\s*/gi, '') // 「PICK UP」を削除（大文字小文字を区別しない）
    .replace(/[\n\r\t]+/g, ' ') // 改行、タブを空白に変換
    .replace(/\s+/g, ' ') // 連続する空白を1つに
    .trim();
}

/**
 * 企業名が既に存在するかどうかをチェックする（セットには追加しない）
 * @param companyName チェックする企業名
 * @param existingCompanies 既存の企業名セット（正規化済み）
 * @returns 既に存在する場合は true、存在しない場合は false
 */
function checkCompanyExists(companyName: string, existingCompanies: Set<string>): boolean {
  if (!companyName) {
    return false;
  }
  const normalized = normalizeCompanyName(companyName);
  return existingCompanies.has(normalized);
}

/**
 * 企業名が既に処理済みかどうかをチェックし、未処理の場合はセットに追加する
 * @param companyName チェックする企業名
 * @param existingCompanies 既存の企業名セット（正規化済み）
 * @returns 既に存在する場合は true、新規追加した場合は false
 */
function checkAndAddCompany(companyName: string, existingCompanies: Set<string>): boolean {
  if (!companyName) {
    return false;
  }
  const normalized = normalizeCompanyName(companyName);
  if (existingCompanies.has(normalized)) {
    return true;
  }
  existingCompanies.add(normalized);
  return false;
}

/**
 * レコードを保存する（重複チェック付き）
 * @param record 保存するレコード
 * @param existingCompanies 既存の企業名セット
 * @param logMessage 保存完了時のログメッセージ（オプション）
 * @returns 既に存在してスキップした場合は true、保存した場合は false
 */
async function saveRecordIfNew(
  record: CsvRecord,
  existingCompanies: Set<string>,
  logMessage?: string,
): Promise<boolean> {
  // 企業名を正規化
  const normalizedCompanyName = normalizeCompanyName(record.companyName);
  
  // 既にセットに存在する場合はスキップ（同じ実行内で既に処理された企業）
  if (existingCompanies.has(normalizedCompanyName)) {
    const skipMessage = logMessage
      ? `既に処理済みの企業(${logMessage})のためスキップ: ${record.companyName}`
      : `既に処理済みの企業のためスキップ: ${record.companyName}`;
    console.log(skipMessage);
    return true;
  }
  // セットに追加して、同じ実行内での重複処理を防ぐ
  existingCompanies.add(normalizedCompanyName);
  await appendCsvRecord(record, GAS_CONFIG);
  const saveMessage = logMessage
    ? `保存完了(${logMessage}): ${record.companyName}`
    : `保存完了: ${record.companyName} (phone=${record.phone}, email=${record.email})`;
  console.log(saveMessage);
  return false;
}

/**
 * CSV行をパースする（簡易版、ダブルクォートで囲まれた値を考慮）
 * @param line CSV行
 * @returns パースされた値の配列
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // エスケープされたダブルクォート
        current += '"';
        i++; // 次の文字をスキップ
      } else {
        // クォートの開始/終了
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // フィールドの区切り
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current); // 最後のフィールド
  return result;
}

/**
 * CSVファイル全体を正しくパースする（改行を含むフィールドに対応）
 * @param content CSVファイルの内容
 * @returns パースされた行の配列（各行はフィールドの配列）
 */
function parseCsvContent(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // エスケープされたダブルクォート
        currentField += '"';
        i += 2;
        continue;
      } else {
        // クォートの開始/終了（クォート自体は保存しない）
        inQuotes = !inQuotes;
        i++;
        continue;
      }
    }

    if (char === ',' && !inQuotes) {
      // フィールドの区切り
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      // 行の区切り（クォート外の改行のみ）
      if (char === '\r' && nextChar === '\n') {
        // CRLFの場合は両方をスキップ
        i += 2;
      } else {
        i++;
      }
      // 現在のフィールドを追加して行を完成
      currentRow.push(currentField);
      if (currentRow.length > 0 && currentRow.some(f => f.trim())) {
        // 空でない行のみ追加
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      continue;
    }

    // 通常の文字（クォート内の文字も含む）
    currentField += char;
    i++;
  }

  // 最後のフィールドと行を追加
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 0 && currentRow.some(f => f.trim())) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * 既存の CSV ファイルから企業名のセットを読み込む
 * 重複チェックに使用される
 * 新しいCSV構造では企業名は8番目の列（インデックス7）
 */
function loadExistingCompanyNames(): Set<string> {
  const companies = new Set<string>();
  if (!fs.existsSync(OUTPUT_CSV)) {
    return companies;
  }

  const content = fs.readFileSync(OUTPUT_CSV, { encoding: 'utf8' });
  const rows = parseCsvContent(content);
  
  // ヘッダー行を除外（最初の行）
  const dataRows = rows.slice(1);

  for (const fields of dataRows) {
    // 企業名は8番目の列（インデックス7）
    if (fields.length > 7) {
      const companyName = fields[7]?.trim() || '';
      if (companyName) {
        // 正規化してからセットに追加
        const normalized = normalizeCompanyName(companyName);
        if (normalized) {
          companies.add(normalized);
        }
      }
    }
  }

  return companies;
}

/**
 * Google Apps Script に1行のデータをアップロードする
 * @param gas GAS 設定
 * @param row アップロードする行データ
 * @returns GAS からの応答テキスト
 */
async function postRowToGas(gas: GasConfig, row: string[]): Promise<string> {
  const url = new URL(gas.uploadUrl);
  const body = JSON.stringify({
    row,
    token: gas.token ?? '',
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (gas.token) {
    headers['X-Auth-Token'] = gas.token;
  }

  // タイムアウト付きで fetch 実行（デフォルト 30 秒だと長すぎるため 10 秒に制限）
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('GAS への行アップロードがタイムアウトしました（10 秒経過）');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `GAS への行アップロードに失敗しました: ${res.status} ${res.statusText}\n${text}`,
    );
  }

  return text || `HTTP ${res.status}`;
}

/**
 * CSV 用に文字列をエスケープする（ダブルクォートを2つに変換）
 * @param value エスケープする文字列
 * @returns エスケープされた文字列
 */
function escapeCsvValue(value: string): string {
  return value.replace(/"/g, '""');
}

/**
 * CSV ファイルに1レコードを追加する
 * オプションで GAS にもアップロードする
 * @param record 追加するレコード
 * @param gasConfig GAS 設定（null の場合はアップロードしない）
 */
async function appendCsvRecord(record: CsvRecord, gasConfig: GasConfig | null) {
  // タイムスタンプを生成（アップロード時間）
  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const listSource = `マイナビ(${timestamp})`;

  // 新しいCSV構造: 日付,担当者,温度感,受付ブロック,商談中,営業目的,採用ターゲット,企業名,電話番号,メールアドレス,HP,担当者様,備考,リスト元,企業規模,業界,本社地域,年間採用人数,上場,属性
  // 企業名(8), 電話番号(9), メールアドレス(10), 企業規模(15), 業界(16), 本社地域(17), 年間採用人数(18) に対応する値を格納
  // table_urlは備考(13)に入れる
  // リスト元(14)は「マイナビ(タイムスタンプ)」
  // 他の部分は空文字列
  const line = `"","","","","","","","${escapeCsvValue(record.companyName)}","${escapeCsvValue(record.phone)}","${escapeCsvValue(record.email)}","","","${escapeCsvValue(record.tableUrl)}","${escapeCsvValue(listSource)}","${escapeCsvValue(record.companySize)}","${escapeCsvValue(record.industry)}","${escapeCsvValue(record.headOffice)}","${escapeCsvValue(record.annualRecruitment)}","",""\n`;
  fs.appendFileSync(OUTPUT_CSV, line, { encoding: 'utf8' });

  if (gasConfig) {
    const row = [
      '', // 日付
      '', // 担当者
      '', // 温度感
      '', // 受付ブロック
      '', // 商談中
      '', // 営業目的
      '', // 採用ターゲット
      record.companyName, // 企業名
      record.phone, // 電話番号
      record.email, // メールアドレス
      '', // HP
      '', // 担当者様
      record.tableUrl, // 備考
      listSource, // リスト元
      record.companySize, // 企業規模
      record.industry, // 業界
      record.headOffice, // 本社地域
      record.annualRecruitment, // 年間採用人数
      '', // 上場
      '', // 属性
    ];
    try {
      console.log('GAS へ行をアップロードします...');
      const resp = await postRowToGas(gasConfig, row);
      console.log(`  GAS 応答: ${resp}`);
    } catch (err) {
      console.error('GAS へのアップロード中にエラーが発生しました（CSV への保存は完了しています）:', err);
    }
  }
}

/**
 * インターンシップコースのデータ
 */
type CourseData = {
  companyName: string;
  tableRows: InternshipRow[];
  phones: string[];
  emails: string[];
  sourceUrl: string;
};

/**
 * 企業のメタ情報（業種・本社所在地・年間採用人数・企業規模）
 */
type CompanyMeta = {
  industry: string;
  headOffice: string;
  annualRecruitment: string;
  companySize: string;
};

/**
 * ページから企業名（h1要素）を抽出する
 * @param page ページオブジェクト
 * @param fallback 取得できない場合のフォールバック値
 * @returns 抽出した企業名（取得できない場合は fallback または空文字列）
 */
async function extractCompanyName(page: Page, fallback: string = ''): Promise<string> {
  const companyName = (await page.textContent('h1').catch(() => null))?.trim();
  return companyName || fallback;
}

/**
 * テキストから電話番号とメールアドレスを抽出する
 * @param text 抽出元のテキスト
 * @returns 電話番号とメールアドレスの配列
 */
function extractContactInfo(text: string): { phones: string[]; emails: string[] } {
  const phones = Array.from(text.matchAll(PHONE_REGEX), m => m[0]);
  const emails = Array.from(text.matchAll(EMAIL_REGEX), m => m[0]);
  return { phones, emails };
}

/**
 * インターンシップ詳細テーブルから行データを抽出する
 * @param page ページオブジェクト
 * @param tableSelector テーブルのセレクタ
 * @returns 抽出したテーブル行データ
 */
async function extractTableRows(page: Page, tableSelector: string): Promise<InternshipRow[]> {
  return await page.$$eval(
    tableSelector + ' tr',
    rows =>
      rows
        .map(row => {
          const headingEl = row.querySelector<HTMLTableCellElement>('td.heading');
          const valueEl = row.querySelector<HTMLTableCellElement>('td.sameSize');
          if (!headingEl || !valueEl) return null;
          const heading = headingEl.textContent?.trim() ?? '';
          const value = valueEl.textContent?.trim() ?? '';
          return heading ? { heading, value } : null;
        })
        .filter((r): r is { heading: string; value: string } => !!r),
  );
}

/**
 * インターンシップ詳細ページからテーブルデータを抽出する
 * @param page ページオブジェクト
 * @param internshipUrl インターンシップ詳細ページの URL
 * @param companyNameHint 企業名のヒント（取得できない場合のフォールバック）
 * @returns 抽出したコースデータ（取得できない場合は null）
 */
async function extractInternshipTable(page: Page, internshipUrl: string, companyNameHint: string): Promise<CourseData | null> {
  // 既に同じ URL を開いている場合は無駄なリロードを避ける
  if (page.url() !== internshipUrl) {
    await page.goto(internshipUrl, { waitUntil: 'domcontentloaded' });
  }

  // 企業名 h1
  const companyName = await extractCompanyName(page, companyNameHint);

  // インターンシップ詳細テーブル取得
  // 企業によってクラス構成が微妙に異なるケースがあるため、
  // 以前のような「.dataTable.last.dataTable02.ver02」だけでなく、
  // よりゆるいセレクタでテーブルを探す。
  const TABLE_SELECTOR = 'table.dataTable.last.dataTable02.ver02, table.dataTable02';

  try {
    await page.waitForSelector(TABLE_SELECTOR, {
      timeout: 10_000,
    });
  } catch {
    console.warn('詳細テーブルが見つからずスキップ:', internshipUrl);
    return null;
  }

  const tableRows = await extractTableRows(page, TABLE_SELECTOR);

  const joinedText = tableRows.map(r => r.value).join('\n');
  const { phones, emails } = extractContactInfo(joinedText);

  return {
    companyName,
    tableRows,
    phones,
    emails,
    sourceUrl: internshipUrl,
  };
}

/**
 * 企業概要ページから業種と本社所在地を抽出する
 * 業種: div.heading2 > div.category > ul > li > span.noLink のテキストを結合
 * 本社: div.heading2 > div.place 内の dl から dt=本社 の dd テキスト
 * 年間採用人数: li.recruitDataItem 内の「過去3年間の新卒採用者数」テーブルから3年間の平均を計算
 * @param page ページオブジェクト
 */
async function extractCompanyMetaFromOutline(page: Page): Promise<CompanyMeta> {
  const { industry, headOffice, annualRecruitment, companySize } = await page.evaluate(() => {
    const result: { industry: string; headOffice: string; annualRecruitment: string; companySize: string } = {
      industry: '',
      headOffice: '',
      annualRecruitment: '',
      companySize: '',
    };

    const industrySpans = Array.from(
      document.querySelectorAll<HTMLSpanElement>('div.heading2 div.category ul li span.noLink'),
    );
    const industryTexts = industrySpans
      .map(span => span.textContent?.trim() || '')
      .filter(Boolean);
    result.industry = industryTexts.join(' / ');

    const placeDlList = Array.from(
      document.querySelectorAll<HTMLDListElement>('div.heading2 div.place .placeItem dl'),
    );
    for (const dl of placeDlList) {
      const dt = dl.querySelector('dt');
      const dd = dl.querySelector('dd');
      const heading = dt?.textContent?.trim();
      if (heading === '本社' && dd) {
        result.headOffice = (dd.textContent || '').trim();
        break;
      }
    }

    // 企業規模の抽出: div.place .placeItem 内の最後の dl の dd を取得
    const placeItem = document.querySelector('div.heading2 div.place .placeItem');
    if (placeItem) {
      const dlList = Array.from(placeItem.querySelectorAll<HTMLDListElement>('dl'));
      if (dlList.length > 0) {
        const lastDl = dlList[dlList.length - 1];
        if (lastDl) {
          const lastDd = lastDl.querySelector('dd');
          if (lastDd) {
            result.companySize = (lastDd.textContent || '').trim();
          }
        }
      }
    }

    // 年間採用人数の抽出: 過去3年間の新卒採用者数の平均を計算
    const recruitDataItems = Array.from(
      document.querySelectorAll<HTMLLIElement>('li.recruitDataItem'),
    );
    for (const item of recruitDataItems) {
      const rowDiv = item.querySelector('div.row');
      if (rowDiv && rowDiv.textContent?.includes('過去3年間の新卒採用者数')) {
        const table = item.querySelector('table');
        if (table) {
          const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr.recruitText'));
          const recruitmentNumbers: number[] = [];
          
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>('td'));
            // 2番目のセル（採用者数）を取得
            if (cells.length >= 2 && cells[1]) {
              const recruitCell = cells[1];
              const span = recruitCell.querySelector('span');
              if (span) {
                const num = parseInt(span.textContent?.trim() || '0', 10);
                if (!isNaN(num)) {
                  recruitmentNumbers.push(num);
                }
              }
            }
          }
          
          if (recruitmentNumbers.length > 0) {
            const average = Math.round(
              recruitmentNumbers.reduce((sum, num) => sum + num, 0) / recruitmentNumbers.length
            );
            result.annualRecruitment = String(average);
          }
        }
        break;
      }
    }

    return result;
  });

  return {
    industry: industry || '取得失敗',
    headOffice: headOffice || '取得失敗',
    annualRecruitment: annualRecruitment || '',
    companySize: companySize || '',
  };
}

/**
 * 検索結果ページをページネーションしながら企業を順次スクレイピングする
 * START_PAGE より前のページは「企業リンク収集＋スクレイピング」をスキップし、
 * 「次の100社」でページだけ進める
 * @param page 検索結果ページのページオブジェクト
 * @param existingCompanies 既に処理済みの企業名セット（重複チェック用）
 * @param maxCompanies 一回の実行でCSVに追加する企業の最大数（未指定の場合は制限なし）
 */
async function processAllCompaniesFromSearch(
  page: Page,
  existingCompanies: Set<string>,
  maxCompanies?: number,
) {
  let pageIndex = 1;
  let lastProcessedPageIndex = 0;
  let addedCompanyCount = 0; // 今回の実行で新規追加した企業数
  // eslint-disable-next-line no-constant-condition
  while (true) {
    lastProcessedPageIndex = pageIndex;
    if (shouldStop) {
      console.log('停止フラグが立ったため、検索結果の取得を中断します。');
      break;
    }

    // 取得件数の上限に達した場合は処理を終了
    if (maxCompanies !== undefined && addedCompanyCount >= maxCompanies) {
      console.log(
        `取得件数の上限(${maxCompanies}件)に達したため、処理を終了します。今回追加した企業数: ${addedCompanyCount}件`,
      );
      break;
    }

    await waitIfPaused();

    const companyData = await page
      .$$eval('a[id^="corpNameLink["]', elements =>
        elements.map(el => {
          const anchor = el as HTMLAnchorElement;
          return {
            name: anchor.textContent?.trim() || '',
            url: anchor.href,
          };
        }),
      )
      .catch(() => [] as Array<{ name: string; url: string }>);

    if (pageIndex >= START_PAGE) {
      console.log(`検索結果ページ${pageIndex}で企業リンク取得: ${companyData.length}件`);

      // 検索結果ページはそのまま保持し、別タブ（ページ）で企業詳細を開く
      const detailPage = await page.context().newPage();

      for (const { name: companyNameFromSearch, url: companyUrl } of companyData) {
        if (shouldStop) {
          console.log('停止フラグが立ったため、企業ループを終了します。');
          break;
        }

        // 取得件数の上限に達した場合は処理を終了
        if (maxCompanies !== undefined && addedCompanyCount >= maxCompanies) {
          console.log(
            `取得件数の上限(${maxCompanies}件)に達したため、処理を終了します。今回追加した企業数: ${addedCompanyCount}件`,
          );
          break;
        }

        await waitIfPaused();

        try {
          // 企業名はaタグの値を使用（outlineのh1は使用しない）
          if (!companyNameFromSearch) {
            console.warn(`検索結果ページから企業名を取得できませんでした。スキップ: ${companyUrl}`);
            continue;
          }

          // CSVにすでに存在する場合は、ページ遷移前にスキップ
          if (checkCompanyExists(companyNameFromSearch, existingCompanies)) {
            console.log(`既に CSV に存在する企業のためスキップ: ${companyNameFromSearch}`);
            // セットに追加して、同じ実行内での重複処理を防ぐ（正規化した値を追加）
            const normalized = normalizeCompanyName(companyNameFromSearch);
            existingCompanies.add(normalized);
            continue;
          }

          // 企業名を確定（aタグの値を使用）
          const finalCompanyName = companyNameFromSearch;

          console.log(`企業ページ処理開始: ${companyUrl} (企業名: ${finalCompanyName})`);
          // 負荷軽減のため、企業ごとの処理の前に待機
          await detailPage.waitForTimeout(DELAY_MS);
          await detailPage.goto(companyUrl, { waitUntil: 'domcontentloaded' });

          // outline ページから業種・本社情報を取得
          const companyMeta = await extractCompanyMetaFromOutline(detailPage);

          // outline ページから「インターンシップ（is）」ページに遷移
          // URL 文字列から outline → is に差し替えるだけにする（タブのリンクは参照しない）
          let isPageUrl: string | null = null;
          const currentUrl = detailPage.url();
          if (currentUrl.includes('outline')) {
            // 負荷軽減のため、タブ遷移前に待機
            await detailPage.waitForTimeout(DELAY_MS);
            isPageUrl = currentUrl.replace('outline', 'is');
          }

          if (!isPageUrl) {
            console.warn('インターンシップ(is)ページへの URL を特定できませんでした。スキップ:', companyUrl);
            continue;
          }

          await detailPage.goto(isPageUrl, { waitUntil: 'domcontentloaded' });

          // is ページ上のインターンシップ一覧（internList courseList）から各コースのリンクを取得
          const courseLinks = await detailPage
            .$$eval('div.internList.courseList a[href*="displayInternship"]', elements =>
              elements.map(el => (el as HTMLAnchorElement).href),
            )
            .catch(() => [] as string[]);

          const courseDataList: CourseData[] = [];

          if (courseLinks.length === 0) {
            console.warn(
              'インターンシップコースのリンクが見つかりませんでした。is ページ自体からテーブル取得を試みます:',
              isPageUrl,
            );

            // ~/is ページ自体に既に詳細テーブルがあるケースを考慮して取得を試みる
            const dataOnIs = await extractInternshipTable(
              detailPage,
              isPageUrl,
              finalCompanyName,
            ).catch(() => null);

            if (dataOnIs) {
              // 企業名はaタグの値を使用（h1から取得した値は使用しない）
              dataOnIs.companyName = finalCompanyName;
              courseDataList.push(dataOnIs);
              console.log('is ページ自体から詳細テーブルを取得しました。');
            } else {
              console.warn(
                'is ページにも詳細テーブルが無かったため、企業情報のみ保存します:',
                isPageUrl,
              );

              const record: CsvRecord = {
                companyName: finalCompanyName || '(企業名不明)',
                phone: '詳細無し',
                email: '詳細無し',
                industry: companyMeta.industry,
                headOffice: companyMeta.headOffice,
                tableUrl: isPageUrl ?? companyUrl,
                tableJson: JSON.stringify('詳細無し'),
                annualRecruitment: companyMeta.annualRecruitment,
                companySize: companyMeta.companySize,
              };
              const skipped = await saveRecordIfNew(record, existingCompanies, 'コース無し');
              if (skipped) {
                continue;
              }
              addedCompanyCount++;
              if (maxCompanies !== undefined && addedCompanyCount >= maxCompanies) {
                break;
              }
              continue;
            }
          } else {
            console.log(`インターンシップコース: ${courseLinks.length}件`);

            for (const courseUrl of courseLinks) {
              if (shouldStop) {
                console.log('停止フラグが立ったため、コースループを終了します。');
                break;
              }

              await waitIfPaused();

              // 各コース詳細へ移動する前に待機
              await detailPage.waitForTimeout(DELAY_MS);
              const data = await extractInternshipTable(
                detailPage,
                courseUrl,
                finalCompanyName,
              );
              if (data) {
                // 企業名はaタグの値を使用（h1から取得した値は使用しない）
                data.companyName = finalCompanyName;
                courseDataList.push(data);

                // 電話番号とメールアドレスの両方が取得できたコースを見つけたら、
                // それ以上その企業のコースは調べない（パフォーマンス最適化）
                if (data.phones.length > 0 && data.emails.length > 0) {
                  console.log(
                    '電話番号とメールアドレス両方を含むコースを検出したため、残りのコースはスキップします。',
                  );
                  break;
                }
              }
            }
          }

          // 企業ごとに 1 レコードだけ CSV に保存する
          if (courseDataList.length === 0) {
            const record: CsvRecord = {
              companyName: finalCompanyName,
              phone: '取得失敗',
              email: '取得失敗',
              industry: companyMeta.industry,
              headOffice: companyMeta.headOffice,
              tableUrl: isPageUrl ?? '',
              tableJson: JSON.stringify([]),
              annualRecruitment: companyMeta.annualRecruitment,
              companySize: companyMeta.companySize,
            };
            const skipped = await saveRecordIfNew(record, existingCompanies, 'テーブルなし');
            if (skipped) {
              continue;
            }
            addedCompanyCount++;
            if (maxCompanies !== undefined && addedCompanyCount >= maxCompanies) {
              break;
            }
            continue;
          }

          // 優先度: 両方あり > 電話のみ > email のみ > どちらもなし
          const scored = courseDataList.map(c => {
            const hasPhone = c.phones.length > 0;
            const hasEmail = c.emails.length > 0;
            let score = 0;
            if (hasPhone && hasEmail) score = 3;
            else if (hasPhone) score = 2;
            else if (hasEmail) score = 1;
            return { course: c, score, hasPhone, hasEmail };
          });

          scored.sort((a, b) => b.score - a.score);
          const best = scored[0]!;
          const bestCourse = best.course;

          const phone = bestCourse.phones[0] ?? '無記載';
          const email = bestCourse.emails[0] ?? '無記載';

          const record: CsvRecord = {
            companyName: finalCompanyName, // aタグの値を使用
            phone,
            email,
            industry: companyMeta.industry,
            headOffice: companyMeta.headOffice,
            tableUrl: bestCourse ? bestCourse.sourceUrl : '',
            tableJson: JSON.stringify(bestCourse ? bestCourse.tableRows : []),
            annualRecruitment: companyMeta.annualRecruitment,
            companySize: companyMeta.companySize,
          };
          const skipped = await saveRecordIfNew(record, existingCompanies);
          if (!skipped) {
            addedCompanyCount++;
          }

          // 取得件数の上限に達した場合は処理を終了
          if (maxCompanies !== undefined && addedCompanyCount >= maxCompanies) {
            console.log(
              `取得件数の上限(${maxCompanies}件)に達したため、処理を終了します。今回追加した企業数: ${addedCompanyCount}件`,
            );
            break;
          }

          // 以前は「電話番号とメールアドレスが両方取得できた企業に出会ったら終了」していたが、
          // まだページ途中で打ち切られてしまうため、現在は継続してスクレイピングを行う。
        } catch (e) {
          console.error('企業処理中にエラー:', e);
        }
      }
      await detailPage.close();
      if (shouldStop) {
        console.log('停止フラグが立ったため、ページネーションを終了します。');
        break;
      }
      // 取得件数の上限に達した場合は処理を終了
      if (maxCompanies !== undefined && addedCompanyCount >= maxCompanies) {
        console.log(
          `取得件数の上限(${maxCompanies}件)に達したため、処理を終了します。今回追加した企業数: ${addedCompanyCount}件`,
        );
        break;
      }
    } else {
      console.log(`検索結果ページ${pageIndex}は START_PAGE(${START_PAGE}) より前のためスキップします。`);
    }

    const nextButton = await page.$('#lowerNextPage');
    if (!nextButton) {
      console.log(`次のページボタンが見つからないため、検索結果の取得を終了します。(最終ページ: ${lastProcessedPageIndex})`);
      break;
    }

    const nextButtonClass = (await nextButton.getAttribute('class')) ?? '';
    if (nextButtonClass.includes('disabled')) {
      console.log(`次のページボタンが無効のため、これ以上ページはありません。(最終ページ: ${lastProcessedPageIndex})`);
      break;
    }

    pageIndex += 1;
    await page.waitForTimeout(DELAY_MS);

    console.log('「次の100社」ボタンをクリックして次ページへ移動します。');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      nextButton.click(),
    ]);
  }
}

/**
 * メイン処理
 * 1. スプレッドシートから最新の CSV を同期
 * 2. CSV ヘッダーを確保
 * 3. ブラウザを起動してマイナビにログイン
 * 4. 検索結果ページから企業情報をスクレイピング
 */
async function main() {
  // スクレイピング開始前に、スプレッドシートから最新の CSV を同期
  await downloadCsvFromSpreadsheet(CONFIG);

  await ensureCsvHeader();

  setupSignalHandlers();

  const existingCompanies = loadExistingCompanyNames();

  cleanupProfileLocks(USER_DATA_DIR);
  globalContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    userAgent: USER_AGENT,
  });
  const context = globalContext;

  console.log('ブラウザを起動しました。初回はマイナビに手動でログインしてください。');

  const page = await context.newPage();
  // まずトップページに遷移してログインしてもらう
  await page.goto(TOP_URL, { waitUntil: 'domcontentloaded' });

  console.log('マイナビのトップページを開きました。ここでマイページにログインしてください。ログインが完了したらターミナルで Enter を押してください。');

  // Enter キー入力待ち（ログイン完了の合図）
  await new Promise<void>(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  console.log('ログイン完了を受け取りました。p: 一時停止/再開, q: 安全に終了, Ctrl+C: 安全に終了 で制御できます。');
  setupInteractiveControls();

  // ログイン完了後に検索結果ページへ移動し、ここからスクレイピング開始
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  console.log('検索結果ページを開きました。ここから企業一覧のスクレイピングを開始します。');

  // ページネーションを辿りながら、START_PAGE 以降の企業を順次スクレイピング
  await processAllCompaniesFromSearch(page, existingCompanies, CONFIG.MAX_COMPANIES);

  await context.close();
  globalContext = null;

  if (process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // 無視
    }
  }
  process.stdin.removeAllListeners('data');
  process.stdin.pause();

  console.log('すべての処理が完了しました。検索結果ページの最終ページ番号は、上記ログの「最終ページ: N」を参照してください。');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


