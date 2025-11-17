const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'mynavi-config.json');
const CSV_BASE_DIR = __dirname;

try {
  contextBridge.exposeInMainWorld('electronAPI', {
    startScraper: () => ipcRenderer.invoke('scraper:start'),
    sendEnter: () => ipcRenderer.invoke('scraper:enter'),
    stopScraper: () => ipcRenderer.invoke('scraper:stop'),

    loadConfig: () => {
      try {
        const raw = fs.readFileSync(CONFIG_PATH, { encoding: 'utf8' });
        return { ok: true, content: raw };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    saveConfig: content => {
      try {
        // JSON 形式の簡易チェック
        JSON.parse(content);
      } catch (e) {
        return { ok: false, error: 'JSON の構文エラー: ' + e.message };
      }

      try {
        fs.writeFileSync(CONFIG_PATH, content, { encoding: 'utf8' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    readCsv: relativePath => {
      try {
        const targetPath = path.isAbsolute(relativePath)
          ? relativePath
          : path.join(CSV_BASE_DIR, relativePath);
        const raw = fs.readFileSync(targetPath, { encoding: 'utf8' });
        return { ok: true, content: raw, path: targetPath };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    onLog: callback => {
      ipcRenderer.on('log', (_event, message) => {
        callback(message);
      });
    },

    onStatus: callback => {
      ipcRenderer.on('status', (_event, status) => {
        callback(status);
      });
    },
  });
} catch (e) {
  // preload 内でのエラーはレンダラーから見えにくいので、コンソールに明示的に出す
  // npm start を実行しているターミナルにスタックトレースが出る想定
  // これが出ているかどうかを確認してもらう
  // eslint-disable-next-line no-console
  console.error('[preload] 初期化エラー', e);
}


