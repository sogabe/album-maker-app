# 自己紹介アルバムメーカー

ホームステイに持っていく紙の自己紹介アルバムを作るためのローカル Web アプリ。
コンビニのネットワークプリントに入稿できる A4 PDF を出力します。

設計の経緯は [docs/domain-model.md](docs/domain-model.md) と [docs/adr/](docs/adr/) を参照。

## 使い方

### 1. 写真を集める

スマホからテーマごとに写真を選び(各テーマ 2〜4 枚、計 16〜24 枚)、AirDrop や LINE で
Mac へ送ってこのフォルダの `photos/` に入れる。

- iPhone の HEIC 写真はそのままで OK(自動で JPEG に変換されます)
- LINE 経由の写真も使えます。ただし LINE は画像を縮小・再圧縮するため解像度が
  落ちていることが多く、印刷で粗くなる写真は PDF 書き出し時に警告が表示されます。
  警告が出た写真は、大写真ページを避けて 2×2 グリッドの小さい枠で使うか、
  LINE で「オリジナル画質」で送り直す(または AirDrop に切り替える)と改善します

### 2. アプリを起動する

```bash
npm install   # 初回のみ
npm start
```

ブラウザで <http://localhost:5858> を開く。

### 3. アルバムを作る

8 ページ(表紙 / My Family / My Town / My Home / My School / My Hobbies /
My Favorites / 裏表紙)がプリセットされています。

1. 左の写真一覧でクリックして選択 → ページの「＋ 追加」で割り当て(1 ページ最大 4 枚)
2. 各写真に短い英語キャプションを入力(日本語は PDF に出ません)
3. 編集は自動保存されます(`album.json`)

レイアウトは写真の枚数で自動的に決まります: 1 枚 = 大写真 / 2 枚 = 上下 2 段 /
3〜4 枚 = 2×2 グリッド。

PDF のフォントは Mac 同梱のものを埋め込んでいます(タイトル: Arial Rounded Bold、
キャプション: Bradley Hand)。変えたい場合は `server.js` 冒頭の `TITLE_FONT_FILE` /
`CAPTION_FONT_FILE` を `/System/Library/Fonts/Supplemental/` 内の別の `.ttf`
(例: `Chalkduster.ttf`、`Comic Sans MS.ttf`)に差し替え、`TITLE_SIZE` /
`CAPTION_SIZE` でサイズを調整してください。

### 4. 印刷する

1. 「PDF を書き出す」→ `album.pdf` ができる(A4 縦・余白 10mm・300dpi)
2. `album.pdf` をコンビニのネットワークプリントに登録
   - セブン: [netprint](https://www.printing.ne.jp/)
   - ファミマ・ローソン: [ネットワークプリント](https://networkprint.ne.jp/)
3. 店頭で A4(カラー)を選んで印刷し、クリアファイル等に綴じる

まず 1 部試し刷りして色と文字を確認してから本番を刷ること。
