// レンダラープロセス側の UI ロジック

const logArea = document.getElementById('log');
const startButton = document.getElementById('start');
const loginDoneButton = document.getElementById('loginDone');
const stopButton = document.getElementById('stop');
const clearLogButton = document.getElementById('clearLog');
const configStatus = document.getElementById('configStatus');
const loadConfigButton = document.getElementById('loadConfig');
const saveConfigButton = document.getElementById('saveConfig');
const reloadCsvButton = document.getElementById('reloadCsv');
const csvPreviewArea = document.getElementById('csvPreview');

// 設定フォームの要素
const searchUrlInput = document.getElementById('searchUrl');
const startPageInput = document.getElementById('startPage');
const maxCompaniesInput = document.getElementById('maxCompanies');
const spreadsheetUrlInput = document.getElementById('spreadsheetUrl');
const csvPathInput = document.getElementById('csvPath');
const gasUploadUrlInput = document.getElementById('gasUploadUrl');
const gasUploadTokenInput = document.getElementById('gasUploadToken');

if (!window.electronAPI) {
  // preload 側の初期化に失敗している場合は、明示的に知らせる
  if (configStatus) {
    configStatus.textContent =
      'Electron の preload スクリプトの初期化に失敗している可能性があります（window.electronAPI が未定義）。';
    configStatus.style.color = '#ff3b30';
  }
}

function applyConfigToForm(config) {
  if (!config) return;

  if (searchUrlInput) searchUrlInput.value = config.SEARCH_URL ?? '';
  if (startPageInput) startPageInput.value = config.START_PAGE != null ? String(config.START_PAGE) : '1';
  if (maxCompaniesInput) maxCompaniesInput.value = config.MAX_COMPANIES != null ? String(config.MAX_COMPANIES) : '';
  if (spreadsheetUrlInput) spreadsheetUrlInput.value = config.SPREADSHEET_URL ?? '';
  if (csvPathInput) csvPathInput.value = config.CSV_PATH ?? 'mynavi_internships.csv';
  if (gasUploadUrlInput) gasUploadUrlInput.value = config.GAS_UPLOAD_URL ?? '';
  if (gasUploadTokenInput) gasUploadTokenInput.value = config.GAS_UPLOAD_TOKEN ?? '';
}

function collectConfigFromForm() {
  const startPageRaw = startPageInput ? startPageInput.value.trim() : '1';
  const startPage = parseInt(startPageRaw || '1', 10);
  const maxCompaniesRaw = maxCompaniesInput ? maxCompaniesInput.value.trim() : '';
  const maxCompanies = maxCompaniesRaw ? parseInt(maxCompaniesRaw, 10) : undefined;

  const config = {
    SEARCH_URL: searchUrlInput ? searchUrlInput.value.trim() : '',
    START_PAGE: Number.isFinite(startPage) && startPage > 0 ? startPage : 1,
    SPREADSHEET_URL: spreadsheetUrlInput ? spreadsheetUrlInput.value.trim() : '',
    CSV_PATH: csvPathInput ? csvPathInput.value.trim() || 'mynavi_internships.csv' : 'mynavi_internships.csv',
    GAS_UPLOAD_URL: gasUploadUrlInput ? gasUploadUrlInput.value.trim() : '',
    GAS_UPLOAD_TOKEN: gasUploadTokenInput ? gasUploadTokenInput.value.trim() : '',
  };

  // MAX_COMPANIES が有効な値の場合のみ追加
  if (Number.isFinite(maxCompanies) && maxCompanies > 0) {
    config.MAX_COMPANIES = maxCompanies;
  }

  return config;
}

function appendLog(message) {
  if (!logArea) return;
  const text = `[${new Date().toLocaleTimeString()}] ${message}`;
  logArea.value += (logArea.value ? '\n' : '') + text;
  logArea.scrollTop = logArea.scrollHeight;
}

function setRunningState(running) {
  if (running) {
    startButton.disabled = true;
    stopButton.disabled = false;
    loginDoneButton.disabled = false;
  } else {
    startButton.disabled = false;
    stopButton.disabled = true;
    loginDoneButton.disabled = true;
  }
}

startButton.addEventListener('click', async () => {
  appendLog('スクレイピングの起動を要求しました。');
  await window.electronAPI.startScraper();
});

loginDoneButton.addEventListener('click', async () => {
  appendLog('「ログイン完了」ボタンから Enter を送信します。');
  await window.electronAPI.sendEnter();
});

stopButton.addEventListener('click', async () => {
  appendLog('停止要求を送りました。プロセス終了を待ちます。');
  await window.electronAPI.stopScraper();
});

clearLogButton.addEventListener('click', () => {
  if (logArea) {
    logArea.value = '';
  }
});

reloadCsvButton.addEventListener('click', () => {
  if (!csvPathInput) {
    if (csvPreviewArea) {
      csvPreviewArea.value = 'CSV_PATH の入力欄が見つかりません。';
    }
    return;
  }

  const csvPath = csvPathInput.value.trim() || 'mynavi_internships.csv';
  const result = window.electronAPI.readCsv(csvPath);

  if (result.ok) {
    if (csvPreviewArea) {
      // サイズが大きい場合は先頭数万文字に制限
      const maxLength = 40000;
      const content =
        result.content.length > maxLength
          ? result.content.slice(0, maxLength) + '\n...\n（※ 長いので途中まで表示しています）'
          : result.content;
      csvPreviewArea.value = content;
    }
    configStatus.textContent = `CSV を読み込みました: ${csvPath}`;
    configStatus.style.color = '#34c759';
  } else {
    if (csvPreviewArea) {
      csvPreviewArea.value = `CSV 読み込みエラー: ${result.error}`;
    }
    configStatus.textContent = 'CSV 読み込みエラー: ' + result.error;
    configStatus.style.color = '#ff3b30';
  }
});

loadConfigButton.addEventListener('click', () => {
  const result = window.electronAPI.loadConfig();
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.content);
      applyConfigToForm(parsed);
      configStatus.textContent = '設定を読み込みました。';
      configStatus.style.color = '#34c759';
    } catch (e) {
      configStatus.textContent = '読み込みエラー: JSON の構文が不正です。IT 担当者に確認してください。';
      configStatus.style.color = '#ff3b30';
    }
  } else {
    configStatus.textContent = '読み込みエラー: ' + result.error;
    configStatus.style.color = '#ff3b30';
  }
});

saveConfigButton.addEventListener('click', () => {
  const configObject = collectConfigFromForm();
  const content = JSON.stringify(configObject, null, 2);
  const result = window.electronAPI.saveConfig(content);
  if (result.ok) {
    configStatus.textContent = '設定を保存しました。';
    configStatus.style.color = '#34c759';
  } else {
    configStatus.textContent = '保存エラー: ' + result.error;
    configStatus.style.color = '#ff3b30';
  }
});

window.electronAPI.onLog(message => {
  appendLog(message);
});

window.electronAPI.onStatus(status => {
  setRunningState(!!status.running);
});

// 初期状態
setRunningState(false);
loadConfigButton.click();


