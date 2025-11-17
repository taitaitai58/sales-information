#!/bin/zsh

set -e

echo "=== 営業向け 自動セットアップ＆GUI 起動スクリプト ==="
echo "このまま待てば自動で環境構築 → リクナビ架電リスト収集ツール(Electron) を起動します。"
echo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js がインストールされていません。自動インストールを試みます。"
  if command -v brew >/dev/null 2>&1; then
    echo "Homebrew が見つかりました。Node.js をインストールします..."
    brew install node
  else
    echo "エラー: Homebrew が見つからなかったため、Node.js を自動インストールできません。"
    echo "IT 担当者に以下を依頼してください。"
    echo "1) Homebrew のインストール（ https://brew.sh/ ）"
    echo "2) その後、ターミナルで: brew install node"
    exit 1
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "エラー: npm が見つかりません。Node.js のインストールを確認してください。"
  exit 1
fi

echo "1/3: 必要なライブラリをインストールします（初回は数分かかります）..."
npm install

if ! command -v npx >/dev/null 2>&1; then
  echo "エラー: npx が見つかりません。Node.js のインストールを確認してください。"
  exit 1
fi

echo
echo "2/3: Playwright のブラウザを準備します（初回のみ）..."
npx playwright install chromium

echo
echo "3/3: リクナビ架電リスト収集ツール(Electron アプリ)を起動します。"
echo "ウィンドウが開いたら、画面のボタンに従って操作してください。"
echo

npm start


