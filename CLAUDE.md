# CLAUDE.md — album-maker-app

ホームステイに持っていく紙の自己紹介アルバムを作るローカル Web アプリ。
コンビニ入稿用の A4 PDF を出力する。**アルバムの完成が最優先で、アプリは手段**(ADR-0001)。

## 最初に読むもの

- [docs/domain-model.md](docs/domain-model.md) — ドメインモデル全体像
- [docs/adr/](docs/adr/) — 設計判断の理由(0001〜0006)。**設計を変えるときは必ず ADR を追加または改訂する**
- [docs/glossary.md](docs/glossary.md) — 用語集。コード・会話でこの用語を使う

## アーキテクチャ

- [server.js](server.js) — 単一ファイルの Node サーバ(express)。API・HEIC 変換・PDF 生成すべてここ
- [public/](public/) — 素の HTML/CSS/JS(ビルドなし、フレームワークなし)
- 永続状態は `album.json`(アルバム定義)と `photos/`(画像ソース)だけ。DB なし
- `photos/.converted/`(HEIC→JPEG キャッシュ)と `.thumbs/`(サムネイル)は再生成可能なキャッシュ

## 実行

```bash
npm start        # http://localhost:5858
```

Claude Code からは `.claude/launch.json` の `album-maker` を preview_start で起動する。
`node server.js` はホットリロードなし — server.js を変えたら再起動が必要。

## 固定の制約(勝手に変えない)

- PrintSpec は固定値: A4 縦 / 300dpi / 余白 10mm / PDF 1 ファイル(ADR-0002)。設定項目にしない
- 1 ページ = 1 テーマ、写真は最大 4 枚、レイアウトは枚数から自動導出(ADR-0005)。レイアウト選択 UI を作らない。
  許される調整はページ単位のコラージュモード(`Page.layout`)、写真単位の大きさ(`Photo.scale` 0.7〜1.5)、
  コラージュ時の重なり順(`Photo.z` -1/0/+1)のみ(ADR-0005 改訂)
- キャプションは短い英文のみ(ADR-0003)。PDF 生成時に非 ASCII は除去される(sanitizeText)
- フォントは macOS 同梱 TTF を埋め込む(タイトル: Arial Rounded Bold / キャプション: Bradley Hand)。ttc は pdf-lib で埋め込めないので使わない
- 機能追加の判断基準は「今回のアルバム完成に必要か」。汎用化・複数アルバム対応はスコープ外

## 検証のやり方

**`photos/` と `album.json` には利用者の実データが入っている。テスト前に必ず退避し、終わったら復元すること。**

1. `album.json` / `album.pdf` をスクラッチディレクトリにバックアップ
2. sharp で SVG からテスト画像を生成して `photos/` に置く(低解像度テストは幅 500px 程度)
3. `PUT /api/album` でテストデータ投入 → `POST /api/pdf` で生成
4. PDF の見た目確認: pdf-lib でページ分割 → `sips -s format png` で PNG 化 → Read で目視
5. テスト画像・`.thumbs` のテスト分を削除し、バックアップを復元

## ハマりどころ(過去に踏んだもの)

- express の `res.sendFile` はドットで始まるパスセグメント(`.thumbs` 等)をデフォルトで 404 にする → `{ dotfiles: 'allow' }` が必要
- CSS で `display: flex` を当てた要素は HTML の `hidden` 属性が効かなくなる → `[hidden] { display: none }` を併記
- HEIC は sharp のプリビルドでは読めない → macOS の `sips` で JPEG に変換してから処理(server.js の resolvePhotoPath)
- iPhone 写真は EXIF 回転を持つ → sharp は必ず `.rotate()` を通す
- LINE 経由の画像は縮小済みのことが多い → PDF 生成時に実効 180dpi 未満を警告する仕組みがある(MIN_DPI_WARN)
