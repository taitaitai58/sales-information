import { chromium, Page, BrowserContext, type Browser } from 'playwright';
import fs from 'fs';
import path from 'path';

/**
 * CSV に保存する企業情報のレコード型
 */
type CsvRecord = {
  companyName: string;
  phone: string;
  email: string;
  sourceUrl: string;
};

/**
 * リクナビスクレイピング用の設定ファイルの型（マイナビと同じ構造）
 */
type RikunabiConfig = {
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

// グローバル状態管理
let globalContext: BrowserContext | null = null;
let isPaused = false;
let shouldStop = false;

// ファイルパス設定
const OUTPUT_CSV = path.join(__dirname, 'rikunabi_companies.csv');
const CONFIG_PATH = path.join(__dirname, 'rikunabi-config.json');

// ユーザーエージェント（一般的な Chrome on Mac）
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 正規表現パターン
const PHONE_REGEX = /0\d{1,4}-\d{1,4}-\d{3,4}/g;
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// ページ遷移などの待ち時間（ミリ秒）
const DELAY_MS = 1000;

// 検索結果ページのURL（デフォルト）
const DEFAULT_SEARCH_URL =
  'https://job.rikunabi.com/2026/s/?ms=0&b=68&b=69&b=70&b=77&b=78&b=72&b=73&b=71&b=74&b=76&b=75&b=79&isc=r21rcnc01260';

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
 * CSV ファイルのヘッダー行を確保する
 * ファイルが存在しない場合は新規作成
 */
async function ensureCsvHeader() {
  const header = '会社,電話番号,email,取得元のURL\n';
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(OUTPUT_CSV, header, { encoding: 'utf8' });
  }
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
 * 設定ファイル（rikunabi-config.json）を読み込む
 * 読み込みに失敗した場合はデフォルト値を返す
 */
function loadConfig(): RikunabiConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as Partial<RikunabiConfig>;
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
      '設定ファイル rikunabi-config.json の読み込みに失敗したため、デフォルトの SEARCH_URL を使用します。',
      error,
    );
    return {
      SEARCH_URL: DEFAULT_SEARCH_URL,
      START_PAGE: 1,
    };
  }
}

/**
 * GAS アップロード設定を取得する
 * GAS_UPLOAD_URL が設定されていない場合は null を返す
 */
function getGasConfig(config: RikunabiConfig): GasConfig | null {
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
 * CSV ファイルに1レコードを追加する
 * オプションで GAS にもアップロードする
 * @param record 追加するレコード
 * @param gasConfig GAS 設定（null の場合はアップロードしない）
 */
async function appendCsvRecord(record: CsvRecord, gasConfig: GasConfig | null) {
  // CSVファイルへの保存（リクナビ用のシンプルな構造）
  const line = `"${escapeCsvValue(record.companyName)}","${escapeCsvValue(record.phone)}","${escapeCsvValue(record.email)}","${escapeCsvValue(record.sourceUrl)}"\n`;
  fs.appendFileSync(OUTPUT_CSV, line, { encoding: 'utf8' });
  console.log(`保存完了: ${record.companyName} (phone=${record.phone}, email=${record.email})`);

  // GAS へのアップロード（リクナビのCSV構造: 会社,電話番号,email,取得元のURL）
  if (gasConfig) {
    const row = [
      record.companyName, // 会社
      record.phone, // 電話番号
      record.email, // email
      record.sourceUrl, // 取得元のURL
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
 * 企業ページから電話番号とメールアドレスを抽出する
 * @param page ページオブジェクト
 * @returns 電話番号とメールアドレスの配列
 */
async function extractContactInfo(page: Page): Promise<{ phone: string; email: string }> {
  try {
    // company-data04のIDを持つdivを探す
    const companyDataDiv = await page.$('#company-data04');
    if (!companyDataDiv) {
      console.log('#company-data04 が見つかりませんでした');
      return { phone: '', email: '' };
    }

    // company-data04の内容をJSON化して取得
    const data = await companyDataDiv.evaluate(el => {
      // innerHTMLを取得
      const html = el.innerHTML;
      // textContentも取得（フォールバック用）
      const text = el.textContent || '';
      return {
        html,
        text,
      };
    });

    if (!data.html && !data.text) {
      console.log('#company-data04 の内容が空です');
      return { phone: '', email: '' };
    }

    // HTMLエンティティをデコード（&nbsp;を空白に変換）
    let text = data.html || data.text;
    text = text.replace(/&nbsp;/g, ' ');
    // <br>タグを改行に変換
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // その他のHTMLタグを削除
    text = text.replace(/<[^>]+>/g, '');
    // 連続する空白や改行を整理（全角スペースも含む）
    text = text.replace(/[\s\u3000]+/g, ' ').trim();

    // デバッグ用
    console.log('抽出対象テキスト（最初の300文字）:', text.substring(0, 300));

    // 【TEL】の後の電話番号を抽出
    // パターン: 【TEL】の後に任意の空白（全角含む）があり、その後に0から始まる数字とハイフンの組み合わせ
    const telMatch = text.match(/【TEL】[\s\u3000]*([0-9-]+)/);
    const phone = telMatch && telMatch[1] ? telMatch[1].trim() : '';

    // 【E-Mail】の後のメールアドレスを抽出
    // パターン: 【E-Mail】の後に任意の空白（全角含む）があり、その後にメールアドレス
    const emailMatch = text.match(/【E-Mail】[\s\u3000]*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    const email = emailMatch && emailMatch[1] ? emailMatch[1].trim() : '';

    // もし【TEL】や【E-Mail】のパターンで見つからない場合、直接電話番号とメールアドレスのパターンを探す
    let finalPhone = phone;
    let finalEmail = email;

    if (!finalPhone) {
      // 電話番号パターン: 0から始まる数字とハイフンの組み合わせ
      const phonePattern = /0\d{1,4}-\d{1,4}-\d{3,4}/;
      const phoneMatch = text.match(phonePattern);
      finalPhone = phoneMatch ? phoneMatch[0] : '';
    }

    if (!finalEmail) {
      // メールアドレスパターン
      const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
      const emailMatch = text.match(emailPattern);
      finalEmail = emailMatch ? emailMatch[0] : '';
    }

    if (!finalPhone && !finalEmail) {
      console.log('電話番号とメールアドレスの両方が取得できませんでした。');
      console.log('抽出対象テキスト全体:', text);
    }

    return { phone: finalPhone, email: finalEmail };
  } catch (error) {
    console.error('連絡先情報の抽出中にエラー:', error);
    return { phone: '', email: '' };
  }
}

/**
 * 検索結果ページから全ての企業リンクを取得する
 * @param page 検索結果ページのページオブジェクト
 * @returns 企業名とURLの配列
 */
async function extractCompanyLinks(page: Page): Promise<Array<{ name: string; url: string }>> {
  try {
    // リクナビの検索結果ページから企業リンクを取得
    // セレクタ: a.ts-h-search-cassetteTitleMain または a.js-h-search-cassetteTitleMain
    // 企業ページの基本URLのみを取得（/entries/や/seminars/などのサブページは除外）
    const companyLinks = await page.$$eval(
      'a.ts-h-search-cassetteTitleMain, a.js-h-search-cassetteTitleMain',
      elements =>
        elements.map(el => {
          const anchor = el as HTMLAnchorElement;
          const href = anchor.getAttribute('href') || '';
          // 相対URLの場合は絶対URLに変換
          let fullUrl = href;
          if (!href.startsWith('http')) {
            if (href.startsWith('/')) {
              fullUrl = `https://job.rikunabi.com${href}`;
            } else {
              fullUrl = `https://job.rikunabi.com/${href}`;
            }
          }
          const name = anchor.textContent?.trim() || '';
          return {
            name,
            url: fullUrl,
          };
        })
        .filter(link => {
          // 企業ページの基本URLのみをフィルタ（/entries/や/seminars/などのサブページは除外）
          // パターン: /2026/company/r[数字]/ で終わるURLのみ
          const companyUrlPattern = /\/2026\/company\/r\d+\/?$/;
          return link.name && companyUrlPattern.test(link.url);
        }),
    );
    return companyLinks;
  } catch (error) {
    console.error('企業リンクの取得中にエラー:', error);
    return [];
  }
}

/**
 * 検索結果ページをページネーションしながら企業を順次スクレイピングする
 * @param page 検索結果ページのページオブジェクト
 * @param searchUrl 検索結果ページのURL
 * @param gasConfig GAS 設定（null の場合はアップロードしない）
 */
async function processAllCompaniesFromSearch(page: Page, searchUrl: string, gasConfig: GasConfig | null) {
  let pageIndex = 1;
  let processedCount = 0;

  // 検索結果ページに移動
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  console.log('検索結果ページを開きました。');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shouldStop) {
      console.log('停止フラグが立ったため、検索結果の取得を中断します。');
      break;
    }

    await waitIfPaused();

    // 現在のページから企業リンクを取得
    const companyLinks = await extractCompanyLinks(page);
    console.log(`検索結果ページ${pageIndex}で企業リンク取得: ${companyLinks.length}件`);

    if (companyLinks.length === 0) {
      console.log('企業リンクが見つかりませんでした。処理を終了します。');
      break;
    }

    // 別タブ（ページ）で企業詳細を開く
    const detailPage = await page.context().newPage();

    for (const { name: companyName, url: companyUrl } of companyLinks) {
      if (shouldStop) {
        console.log('停止フラグが立ったため、企業ループを終了します。');
        break;
      }

      await waitIfPaused();

      try {
        if (!companyName) {
          console.warn(`検索結果ページから企業名を取得できませんでした。スキップ: ${companyUrl}`);
          continue;
        }

        console.log(`企業ページ処理開始: ${companyUrl} (企業名: ${companyName})`);

        // 負荷軽減のため、企業ごとの処理の前に待機
        await detailPage.waitForTimeout(DELAY_MS);
        
        // 企業ページの基本URLに移動（末尾のスラッシュを統一）
        const normalizedUrl = companyUrl.replace(/\/$/, '') || companyUrl;
        await detailPage.goto(normalizedUrl, { waitUntil: 'domcontentloaded' });
        
        // ページが完全に読み込まれるまで少し待機
        await detailPage.waitForTimeout(500);

        // 連絡先情報を抽出
        const { phone, email } = await extractContactInfo(detailPage);

        // CSVに保存
        const record: CsvRecord = {
          companyName,
          phone: phone || '取得失敗',
          email: email || '取得失敗',
          sourceUrl: companyUrl,
        };

        await appendCsvRecord(record, gasConfig);
        processedCount++;

        console.log(`処理完了: ${companyName} (電話: ${phone || 'なし'}, メール: ${email || 'なし'})`);
      } catch (e) {
        console.error('企業処理中にエラー:', e);
      }
    }

    await detailPage.close();

    if (shouldStop) {
      console.log('停止フラグが立ったため、ページネーションを終了します。');
      break;
    }

    // 次のページボタンを探す
    // リクナビのページネーション構造: li.ts-h-search-pagerItem.ts-h-search-pagerItem_next > a.ts-h-search-pagerBtn.ts-h-search-pagerBtn_next
    const nextButton = await page.$('li.ts-h-search-pagerItem_next a.ts-h-search-pagerBtn_next').catch(() => null);
    if (!nextButton) {
      console.log(`次のページボタンが見つからないため、検索結果の取得を終了します。(最終ページ: ${pageIndex})`);
      break;
    }

    // ボタンが無効かどうかをチェック（親要素のliにdisabledクラスがあるか、リンクが存在しないか）
    const nextButtonParent = await page.$('li.ts-h-search-pagerItem_next').catch(() => null);
    if (!nextButtonParent) {
      console.log(`次のページボタンの親要素が見つからないため、検索結果の取得を終了します。(最終ページ: ${pageIndex})`);
      break;
    }

    const parentClass = (await nextButtonParent.getAttribute('class')) ?? '';
    const isDisabled = parentClass.includes('disabled') || parentClass.includes('ts-h-search-pagerItem_disabled');
    
    if (isDisabled) {
      console.log(`次のページボタンが無効のため、これ以上ページはありません。(最終ページ: ${pageIndex})`);
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

  console.log(`処理が完了しました。合計 ${processedCount} 件の企業を処理しました。`);
}

/**
 * メイン処理
 * 1. CSV ヘッダーを確保
 * 2. ブラウザを起動
 * 3. 検索結果ページから企業情報をスクレイピング
 */
async function main() {
  // 設定ファイルを読み込む
  const CONFIG = loadConfig();
  const GAS_CONFIG = getGasConfig(CONFIG);

  // 設定ファイルから検索URLを取得（必須）
  const searchUrl = CONFIG.SEARCH_URL;

  console.log(`検索URL: ${searchUrl}`);

  await ensureCsvHeader();

  setupSignalHandlers();

  globalContext = await chromium.launchPersistentContext(
    path.join(__dirname, 'rikunabi-user-data'),
    {
      headless: false,
      userAgent: USER_AGENT,
    },
  );
  const context = globalContext;

  console.log('ブラウザを起動しました。ログインは不要です。');
  console.log('p: 一時停止/再開, q: 安全に終了, Ctrl+C: 安全に終了 で制御できます。');
  setupInteractiveControls();

  const page = await context.newPage();

  // 検索結果ページから企業情報をスクレイピング
  await processAllCompaniesFromSearch(page, searchUrl, GAS_CONFIG);

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

  console.log('すべての処理が完了しました。');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

