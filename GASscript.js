//以下のファイルをスプレッドシートに連携したGASにコピペしてください


const AUTH_TOKEN = 'change-me';//トークン(漏洩しないように)
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const SHEET_NAME = 'シート1'; // 実際のシート名に変更

function doPost(e) {
  try {
    // --- JSON ボディ取得 ---
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService
        .createTextOutput('No body')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    const bodyText = e.postData.contents;
    /** @type {{ row?: string[]; token?: string }} */
    const data = JSON.parse(bodyText);

    // --- 認証チェック（ヘッダー or ボディの token を使用） ---
    const headers = e && e.headers ? e.headers : {};
    const tokenHeader =
      headers['X-Auth-Token'] ||
      headers['x-auth-token'] ||
      '';

    const tokenBody = typeof data.token === 'string' ? data.token : '';
    const token = tokenHeader || tokenBody;

    if (AUTH_TOKEN && token !== AUTH_TOKEN) {
      return ContentService
        .createTextOutput('Unauthorized')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    if (!data.row || !Array.isArray(data.row)) {
      return ContentService
        .createTextOutput('Invalid payload: row is required')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    const row = data.row;

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('シートが見つかりません: ' + SHEET_NAME);
    }

    sheet.appendRow(row);
    console.log('Appended row:', JSON.stringify(row));

    return ContentService
      .createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    console.error('doPost error', err);
    return ContentService
      .createTextOutput('Error: ' + err)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}