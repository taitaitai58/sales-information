const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// GPU 周りのクラッシュ回避のため、ハードウェアアクセラレーションを無効化
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let scraperProcess = null;

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // preload で Node.js の require/fs を使うため明示的に無効化
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function startScraper() {
  if (scraperProcess) {
    sendToRenderer('log', 'スクレイピングはすでに実行中です。');
    return;
  }

  // 設定ファイルから MAX_COMPANIES を読み取る
  const fs = require('fs');
  const configPath = path.join(__dirname, 'mynavi-config.json');
  let maxCompanies = undefined;
  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, { encoding: 'utf8' });
      const config = JSON.parse(configContent);
      if (typeof config.MAX_COMPANIES === 'number' && config.MAX_COMPANIES >= 1) {
        maxCompanies = Math.floor(config.MAX_COMPANIES);
      }
    }
  } catch (e) {
    sendToRenderer('log', `設定ファイルの読み込みエラー（MAX_COMPANIES は無視されます）: ${e.message}`);
  }

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const args = ['ts-node', 'scrape-mynavi.ts'];

  // 環境変数として MAX_COMPANIES を渡す
  const env = { ...process.env };
  if (maxCompanies !== undefined) {
    env.MAX_COMPANIES = String(maxCompanies);
  }

  sendToRenderer('log', `スクレイピングを開始します: ${cmd} ${args.join(' ')}`);
  if (maxCompanies !== undefined) {
    sendToRenderer('log', `取得件数上限: ${maxCompanies}件`);
  }
  sendToRenderer('status', { running: true });

  scraperProcess = spawn(cmd, args, {
    cwd: __dirname,
    env: env,
  });

  scraperProcess.stdout.on('data', data => {
    sendToRenderer('log', data.toString());
  });

  scraperProcess.stderr.on('data', data => {
    sendToRenderer('log', data.toString());
  });

  scraperProcess.on('exit', (code, signal) => {
    sendToRenderer(
      'log',
      `スクレイピングプロセスが終了しました (code=${code}, signal=${signal ?? 'none'}).`,
    );
    sendToRenderer('status', { running: false });
    scraperProcess = null;
  });

  scraperProcess.on('error', err => {
    sendToRenderer('log', `スクレイピングプロセス起動エラー: ${err.message}`);
    sendToRenderer('status', { running: false });
    scraperProcess = null;
  });
}

function sendEnterToScraper() {
  if (!scraperProcess || scraperProcess.killed || !scraperProcess.stdin.writable) {
    sendToRenderer('log', 'スクレイピングプロセスが動作していないため、Enter を送信できません。');
    return;
  }
  scraperProcess.stdin.write('\n');
  sendToRenderer('log', '[Electron] Enter キーをスクレイピングプロセスに送信しました。');
}

function stopScraper() {
  if (!scraperProcess || scraperProcess.killed) {
    sendToRenderer('log', 'スクレイピングプロセスはすでに停止しています。');
    return;
  }

  sendToRenderer('log', 'スクレイピングプロセスを終了します...');
  // まずは通常の SIGTERM
  scraperProcess.kill();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // アプリ終了時には子プロセスも確実に終了させる
  if (scraperProcess && !scraperProcess.killed) {
    scraperProcess.kill();
    scraperProcess = null;
  }
});

app.on('window-all-closed', () => {
  // macOS でもウィンドウを閉じたらアプリを終了させる（npm start を止めるため）
  app.quit();
});

// IPC handlers
ipcMain.handle('scraper:start', () => {
  startScraper();
});

ipcMain.handle('scraper:enter', () => {
  sendEnterToScraper();
});

ipcMain.handle('scraper:stop', () => {
  stopScraper();
});


