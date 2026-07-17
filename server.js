// 自己紹介アルバムメーカー — ローカル Web アプリ (ADR-0004)
// 状態は album.json と photos/ フォルダのみ。PDF はコンビニ入稿仕様 (ADR-0002)。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const ROOT = __dirname;
const PHOTOS_DIR = path.join(ROOT, 'photos');
const CONVERTED_DIR = path.join(PHOTOS_DIR, '.converted'); // HEIC → JPEG 変換キャッシュ
const THUMBS_DIR = path.join(ROOT, '.thumbs');
const ALBUM_PATH = path.join(ROOT, 'album.json');
const PDF_PATH = path.join(ROOT, 'album.pdf');

const PORT = 5858;

// ---- 印刷仕様 (PrintSpec, ADR-0002 固定値) ----
const A4 = { w: 595.28, h: 841.89 }; // pt
const mm = (v) => (v * 72) / 25.4;
const MARGIN = mm(10); // 余白 5mm 以上の要件に対し 10mm で安全側
const DPI = 300;
const JPEG_QUALITY = 82;
// LINE 経由などで再圧縮された低解像度写真の検出しきい値。
// 配置枠に対する実効解像度がこれを下回ると印刷で粗く見えるため警告する
const MIN_DPI_WARN = 180;

// コラージュモード: 各写真の枠を拡大し、重なりを許して大きく見せる (ADR-0005 改訂)
const COLLAGE_ZOOM = 1.3;
// 縦方向は横より強めに拡大し、紙の上下いっぱいまで使う
const COLLAGE_ZOOM_V = 1.5;
const PHOTO_SCALE = { min: 0.7, max: 1.5 }; // 写真ごとのサイズ調整の許容範囲

// ---- フォント (macOS 同梱フォントを埋め込む。無ければ Helvetica にフォールバック) ----
const FONT_DIR = '/System/Library/Fonts/Supplemental';
const TITLE_FONT_FILE = path.join(FONT_DIR, 'Arial Rounded Bold.ttf');
const CAPTION_FONT_FILE = path.join(FONT_DIR, 'Bradley Hand Bold.ttf');
const TITLE_SIZE = 40;
const CAPTION_SIZE = { single: 20, stack: 16, grid: 13 };

// ---- 8ページ構成プリセット (ADR-0006) ----
const PRESET_PAGES = [
  { title: "Hello! I'm ...", photos: [] },
  { title: 'My Family', photos: [] },
  { title: 'My Town', photos: [] },
  { title: 'My Home', photos: [] },
  { title: 'My School', photos: [] },
  { title: 'My Hobbies', photos: [] },
  { title: 'My Favorites', photos: [] },
  { title: 'Thank You', photos: [] },
];

for (const dir of [PHOTOS_DIR, CONVERTED_DIR, THUMBS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---- アルバム定義 (album.json) ----
function loadAlbum() {
  try {
    return JSON.parse(fs.readFileSync(ALBUM_PATH, 'utf8'));
  } catch {
    const album = { pages: structuredClone(PRESET_PAGES) };
    saveAlbum(album);
    return album;
  }
}
function saveAlbum(album) {
  fs.writeFileSync(ALBUM_PATH, JSON.stringify(album, null, 2));
}

// ---- 写真フォルダ ----
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);

function listPhotos() {
  return fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => !f.startsWith('.') && IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort();
}

// HEIC は sharp が読めないため macOS 標準の sips で JPEG に変換してキャッシュする
function resolvePhotoPath(name) {
  const src = path.join(PHOTOS_DIR, path.basename(name));
  if (!fs.existsSync(src)) return null;
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') return src;
  const converted = path.join(CONVERTED_DIR, path.basename(name, ext) + '.jpg');
  if (!fs.existsSync(converted) || fs.statSync(converted).mtimeMs < fs.statSync(src).mtimeMs) {
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', converted], { stdio: 'ignore' });
  }
  return converted;
}

// ---- キャプション (ADR-0003: 短い英文のみ。Helvetica で表せない文字は落とす) ----
function sanitizeText(text) {
  return String(text || '').replace(/[^\x20-\x7E]/g, '').trim();
}

// ---- PDF 生成 ----
async function embedPhoto(pdfDoc, name, boxW, boxH) {
  const file = resolvePhotoPath(name);
  if (!file) return null;
  const pxW = Math.round((boxW / 72) * DPI);
  const pxH = Math.round((boxH / 72) * DPI);
  const buf = await sharp(file)
    .rotate() // EXIF の向きを反映
    .resize({ width: pxW, height: pxH, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return pdfDoc.embedJpg(buf);
}

function containRect(img, box) {
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

// box を中心基準で縦横それぞれ拡大し、余白(bounds)からはみ出さない範囲に収める
function expandBox(box, factorW, factorH, bounds) {
  const w = Math.min(box.w * factorW, bounds.w);
  const h = Math.min(box.h * factorH, bounds.h);
  let x = box.x - (w - box.w) / 2;
  let y = box.y - (h - box.h) / 2;
  x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.w - w));
  y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.h - h));
  return { x, y, w, h };
}

function drawCenteredText(page, font, text, size, y, color) {
  let s = size;
  const maxW = A4.w - MARGIN * 2;
  while (s > 8 && font.widthOfTextAtSize(text, s) > maxW) s -= 1;
  const w = font.widthOfTextAtSize(text, s);
  page.drawText(text, { x: (A4.w - w) / 2, y, size: s, font, color });
}

// レイアウトは写真枚数から導出する (ADR-0005): 1枚 / 2段 / 2×2 グリッド
function photoBoxes(count, content) {
  const G = mm(6);
  if (count <= 1) {
    return [{ x: content.x, y: content.y, w: content.w, h: content.h }];
  }
  if (count === 2) {
    const h = (content.h - G) / 2;
    return [
      { x: content.x, y: content.y + h + G, w: content.w, h },
      { x: content.x, y: content.y, w: content.w, h },
    ];
  }
  const w = (content.w - G) / 2;
  const h = (content.h - G) / 2;
  return [
    { x: content.x, y: content.y + h + G, w, h },
    { x: content.x + w + G, y: content.y + h + G, w, h },
    { x: content.x, y: content.y, w, h },
    { x: content.x + w + G, y: content.y, w, h },
  ].slice(0, count);
}

async function embedFontFile(pdfDoc, file, fallback) {
  try {
    return await pdfDoc.embedFont(fs.readFileSync(file), { subset: true });
  } catch {
    return await pdfDoc.embedFont(fallback);
  }
}

async function buildPdf(album) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const fontBold = await embedFontFile(pdfDoc, TITLE_FONT_FILE, StandardFonts.HelveticaBold);
  const font = await embedFontFile(pdfDoc, CAPTION_FONT_FILE, StandardFonts.Helvetica);
  const ink = rgb(0.15, 0.15, 0.2);
  const sub = rgb(0.3, 0.3, 0.38);
  let photoCount = 0;
  const warnings = [];

  for (const pageDef of album.pages) {
    const page = pdfDoc.addPage([A4.w, A4.h]);
    const title = sanitizeText(pageDef.title);
    const titleY = A4.h - MARGIN - TITLE_SIZE;
    if (title) drawCenteredText(page, fontBold, title, TITLE_SIZE, titleY, ink);

    const photos = (pageDef.photos || []).slice(0, 4);
    const collage = pageDef.layout === 'collage' && photos.length > 1;
    const capSize =
      photos.length <= 1 ? CAPTION_SIZE.single : photos.length === 2 ? CAPTION_SIZE.stack : CAPTION_SIZE.grid;
    const captionH = capSize + 12; // 写真の下に確保するキャプション帯
    const content = {
      x: MARGIN,
      y: MARGIN,
      w: A4.w - MARGIN * 2,
      h: titleY - mm(4) - MARGIN,
    };
    let boxes = photoBoxes(photos.length, content);
    if (collage && photos.length === 2) {
      // 2枚コラージュは大きめの枠を対角(上左・下右)に配置する
      const w = content.w * 0.74;
      const h = content.h * 0.68;
      boxes = [
        { x: content.x, y: content.y + content.h - h, w, h },
        { x: content.x + content.w - w, y: content.y, w, h },
      ];
    }

    const entries = photos.map((ph, i) => {
      // 2枚コラージュは専用ボックスがすでに大きいので COLLAGE_ZOOM を掛けない
      const zoomW = collage && photos.length !== 2 ? COLLAGE_ZOOM : 1;
      const zoomH = collage && photos.length !== 2 ? COLLAGE_ZOOM_V : 1;
      const scale = Math.min(PHOTO_SCALE.max, Math.max(PHOTO_SCALE.min, Number(ph.scale) || 1));
      const fw = zoomW * scale;
      const fh = zoomH * scale;
      const box = fw === 1 && fh === 1 ? boxes[i] : expandBox(boxes[i], fw, fh, content);
      const z = Math.max(-1, Math.min(1, Math.round(Number(ph.z) || 0)));
      return { file: ph.file, caption: ph.caption, box, z };
    });
    // コラージュは重なり順(z: 奥 -1 / 標準 0 / 手前 +1)、同順なら下の写真から描く。
    // 上段が前面に重なり、各写真の下端(キャプション位置)が覆われずに残る
    if (collage) entries.sort((a, b) => a.z - b.z || a.box.y - b.box.y);

    const pendingCaptions = []; // コラージュでは写真が重なるため、キャプションは最後に最前面へ描く
    for (const { file, caption, box } of entries) {
      const imgBox = { x: box.x, y: box.y + captionH, w: box.w, h: box.h - captionH };
      const img = await embedPhoto(pdfDoc, file, imgBox.w, imgBox.h);
      if (!img) continue;
      const drawn = containRect(img, imgBox);
      if (collage) {
        // 紙の上下いっぱいに広げる: 上半分の枠は上端へ、下半分の枠は下端へ寄せる
        const boxCenter = box.y + box.h / 2;
        const contentMid = content.y + content.h / 2;
        drawn.y = boxCenter > contentMid ? imgBox.y + imgBox.h - drawn.h : imgBox.y;
      }
      if (collage) {
        // 重なっても写真の輪郭が分かるよう、ポラロイド風の白フチを敷く
        page.drawRectangle({
          x: drawn.x - 5,
          y: drawn.y - 5,
          width: drawn.w + 10,
          height: drawn.h + 10,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.78, 0.78, 0.8),
          borderWidth: 0.75,
        });
      }
      page.drawImage(img, { x: drawn.x, y: drawn.y, width: drawn.w, height: drawn.h });
      photoCount++;
      const effDpi = Math.round(img.width / (drawn.w / 72));
      if (effDpi < MIN_DPI_WARN) {
        warnings.push(`${file} は解像度が低め(約${effDpi}dpi)。印刷で粗く見える可能性があります`);
      }
      const cap = sanitizeText(caption);
      if (cap) {
        let s = capSize;
        while (s > 9 && font.widthOfTextAtSize(cap, s) > box.w) s -= 1;
        const w = font.widthOfTextAtSize(cap, s);
        // キャプションは描画された写真のすぐ下に置く(セル最下部だと写真と離れる)
        const capY = Math.max(content.y, drawn.y - s - 8);
        const capX = box.x + (box.w - w) / 2;
        if (collage) {
          pendingCaptions.push({ cap, x: capX, y: capY, s, w });
        } else {
          page.drawText(cap, { x: capX, y: capY, size: s, font, color: sub });
        }
      }
    }
    for (const c of pendingCaptions) {
      // 重なった写真の上でも読めるよう、白いチップを敷いてから描く
      page.drawRectangle({
        x: c.x - 5,
        y: c.y - 4,
        width: c.w + 10,
        height: c.s + 8,
        color: rgb(1, 1, 1),
        opacity: 0.9,
      });
      page.drawText(c.cap, { x: c.x, y: c.y, size: c.s, font, color: sub });
    }
  }

  const bytes = await pdfDoc.save();
  fs.writeFileSync(PDF_PATH, bytes);
  return { pages: album.pages.length, photoCount, bytes: bytes.length, warnings };
}

// ---- HTTP ----
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/state', (req, res) => {
  const album = loadAlbum();
  const photos = listPhotos();
  const known = new Set(photos);
  const missing = [];
  for (const p of album.pages) {
    for (const ph of p.photos || []) {
      if (!known.has(ph.file)) missing.push(ph.file);
    }
  }
  res.json({ album, photos, missing });
});

app.put('/api/album', (req, res) => {
  const album = req.body;
  if (!album || !Array.isArray(album.pages)) {
    return res.status(400).json({ error: 'pages が必要です' });
  }
  for (const p of album.pages) {
    p.title = String(p.title || '');
    p.layout = p.layout === 'collage' ? 'collage' : 'grid';
    p.photos = (p.photos || []).slice(0, 4).map((ph) => ({
      file: path.basename(String(ph.file || '')),
      caption: String(ph.caption || ''),
      scale: Math.min(PHOTO_SCALE.max, Math.max(PHOTO_SCALE.min, Number(ph.scale) || 1)),
      z: Math.max(-1, Math.min(1, Math.round(Number(ph.z) || 0))),
    }));
  }
  saveAlbum(album);
  res.json({ ok: true });
});

app.get('/api/thumb/:name', async (req, res) => {
  try {
    const name = path.basename(req.params.name);
    const src = resolvePhotoPath(name);
    if (!src) return res.status(404).end();
    const thumb = path.join(THUMBS_DIR, name.replace(/\.[^.]+$/, '') + '.jpg');
    if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(src).mtimeMs) {
      await sharp(src).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(thumb);
    }
    res.sendFile(thumb, { dotfiles: 'allow' });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/pdf', async (req, res) => {
  try {
    const result = await buildPdf(loadAlbum());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/album.pdf', (req, res) => {
  if (!fs.existsSync(PDF_PATH)) return res.status(404).send('まだ PDF がありません');
  res.sendFile(PDF_PATH);
});

app.listen(PORT, () => {
  console.log(`アルバムメーカー起動: http://localhost:${PORT}`);
  console.log(`写真フォルダ: ${PHOTOS_DIR}`);
});
