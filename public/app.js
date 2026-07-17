let state = { album: { pages: [] }, photos: [], missing: [] };
let selectedPhoto = null;
let saveTimer = null;

const $ = (sel) => document.querySelector(sel);

async function load() {
  const res = await fetch('/api/state');
  state = await res.json();
  render();
}

function scheduleSave() {
  $('#save-status').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const res = await fetch('/api/album', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.album),
    });
    $('#save-status').textContent = res.ok ? '保存済み' : '保存失敗!';
  }, 500);
}

function usedCount(file) {
  let n = 0;
  for (const p of state.album.pages) for (const ph of p.photos) if (ph.file === file) n++;
  return n;
}

function renderLibrary() {
  $('#photo-count').textContent = `(${state.photos.length}枚)`;
  const grid = $('#photo-grid');
  grid.innerHTML = '';
  if (state.photos.length === 0) {
    grid.innerHTML = '<p class="hint">photos/ フォルダにまだ写真がありません。</p>';
    return;
  }
  for (const name of state.photos) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell' + (name === selectedPhoto ? ' selected' : '');
    cell.title = name;
    cell.setAttribute('aria-label', name);
    cell.setAttribute('aria-pressed', String(name === selectedPhoto));
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/api/thumb/' + encodeURIComponent(name);
    cell.appendChild(img);
    const n = usedCount(name);
    if (n > 0) {
      const badge = document.createElement('span');
      badge.className = 'used';
      badge.textContent = '使用中';
      cell.appendChild(badge);
    }
    cell.onclick = () => {
      selectedPhoto = selectedPhoto === name ? null : name;
      render();
    };
    grid.appendChild(cell);
  }
}

function renderPages() {
  const wrap = $('#pages');
  wrap.innerHTML = '';
  state.album.pages.forEach((page, pi) => {
    const card = document.createElement('div');
    card.className = 'page-card';

    const no = document.createElement('div');
    no.className = 'page-no';
    no.textContent = `ページ ${pi + 1} / ${state.album.pages.length}`;
    card.appendChild(no);

    const title = document.createElement('input');
    title.className = 'title';
    title.value = page.title;
    title.placeholder = 'ページタイトル(英語)';
    title.oninput = () => { page.title = title.value; scheduleSave(); };
    card.appendChild(title);

    const slots = document.createElement('div');
    slots.className = 'slots';
    page.photos.forEach((ph, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';

      const img = document.createElement('img');
      img.src = '/api/thumb/' + encodeURIComponent(ph.file);
      img.title = ph.file;
      slot.appendChild(img);

      const cap = document.createElement('input');
      cap.className = 'caption';
      cap.value = ph.caption;
      cap.placeholder = 'Caption (English)';
      cap.oninput = () => { ph.caption = cap.value; scheduleSave(); };
      slot.appendChild(cap);

      const up = miniBtn('↑', i === 0, () => {
        [page.photos[i - 1], page.photos[i]] = [page.photos[i], page.photos[i - 1]];
        scheduleSave(); render();
      });
      const down = miniBtn('↓', i === page.photos.length - 1, () => {
        [page.photos[i + 1], page.photos[i]] = [page.photos[i], page.photos[i + 1]];
        scheduleSave(); render();
      });
      const del = miniBtn('✕', false, () => {
        page.photos.splice(i, 1);
        scheduleSave(); render();
      });
      slot.append(up, down, del);
      slots.appendChild(slot);

      if (state.missing.includes(ph.file)) {
        const warn = document.createElement('div');
        warn.className = 'warn';
        warn.textContent = `⚠ ${ph.file} が photos/ に見つかりません`;
        slots.appendChild(warn);
      }
    });
    card.appendChild(slots);

    const add = document.createElement('button');
    add.className = 'add-photo';
    add.textContent = selectedPhoto ? '＋ 選択中の写真を追加' : '＋ 追加(左で写真を選択)';
    add.disabled = !selectedPhoto || page.photos.length >= 4;
    if (page.photos.length >= 4) add.textContent = '写真は4枚まで (ADR-0005)';
    add.onclick = () => {
      page.photos.push({ file: selectedPhoto, caption: '' });
      selectedPhoto = null;
      scheduleSave(); render();
    };
    card.appendChild(add);

    wrap.appendChild(card);
  });
}

function miniBtn(label, disabled, onclick) {
  const b = document.createElement('button');
  b.className = 'mini';
  b.textContent = label;
  b.disabled = disabled;
  b.onclick = onclick;
  return b;
}

function render() {
  renderLibrary();
  renderPages();
}

$('#reload-photos').onclick = load;

$('#export-pdf').onclick = async () => {
  const btn = $('#export-pdf');
  btn.disabled = true;
  btn.textContent = '書き出し中…';
  try {
    const res = await fetch('/api/pdf', { method: 'POST' });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'PDF 生成に失敗しました');
    const mb = (r.bytes / 1024 / 1024).toFixed(1);
    let summary = `${r.pages}ページ・写真${r.photoCount}枚・${mb}MB`;
    if (r.bytes > 19 * 1024 * 1024) summary += ' ⚠ コンビニのサイズ上限を超える可能性があります';
    $('#export-summary').textContent = summary;
    const warnList = $('#export-warnings');
    warnList.innerHTML = '';
    for (const w of r.warnings || []) {
      const li = document.createElement('li');
      li.textContent = `⚠ ${w}`;
      warnList.appendChild(li);
    }
    $('#export-result').hidden = false;
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'PDF を書き出す';
  }
};

$('#close-dialog').onclick = () => { $('#export-result').hidden = true; };

load();
