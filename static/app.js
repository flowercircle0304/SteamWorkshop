'use strict';
const TOKEN = document.querySelector('meta[name=wsm-token]').content;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const prefs = JSON.parse(localStorage.getItem('wsm-prefs') || '{}');
const S = {
  games: [], meta: {}, cur: prefs.cur || null, sel: null,
  filter: 'all', sort: prefs.sort || 'order', view: prefs.view || 'list', q: '',
  running: [],  // 実行中のゲームの AppID（このツールの連携分は除く）
  multi: new Set(),  // 複数選択中の ID
  steam: { connected: false, appid: null, persona: '', supports: {}, items: {}, busy: false, error: '' },
};
const savePrefs = () => localStorage.setItem('wsm-prefs', JSON.stringify({ cur: S.cur, sort: S.sort, view: S.view }));

// ---------------------------------------------------------------- utils
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = b => { if (!b) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; };
const fmtDate = t => t ? new Date(t * 1000).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
const fmtNum = n => n ? Number(n).toLocaleString('ja-JP') : '0';
const stripBB = s => String(s || '').replace(/\[url=([^\]]+)\]/gi, '').replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
const capsule = id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_184x69.jpg`;
const header = id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="#1c2230"/><text x="8" y="6.5" font-size="4" text-anchor="middle" fill="#3b475a">MOD</text></svg>');

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3800);
}

async function api(path, body = {}) {
  const r = await fetch('/api/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WSM-Token': TOKEN }, body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || r.statusText);
  return d;
}

// ---------------------------------------------------------------- data
const game = () => S.games.find(g => g.appid === S.cur);
const titleOf = it => S.meta[it.id]?.title || profTitle(it.id) || `#${it.id}`;
// プロファイルに残っている名前（Steam から消えた MOD でも名前が分かる）
function profTitle(id) {
  for (const g of S.games || []) for (const p of Object.values(g.state?.profiles || {})) {
    const m = p.mods?.find(x => x.id === id && x.title); if (m) return m.title;
  }
  return '';
}
// Steam で入手できない MOD（作者が削除・非公開にした、または Steam により公開停止）
const unavailable = id => S.meta[id]?.ok === false;
const unavailReason = id => (S.meta[id]?.banned ? 'Steam により公開停止されています' : '作者が削除したか、非公開にしています');
const isOn = (g, id) => !g.state.disabled.includes(id);
const sst = it => (S.steam.appid === it.appid ? S.steam.items[it.id] : null);  // Steamクライアント上の状態
const hasUpdate = it => {
  const st = sst(it); if (st?.needsUpdate || it.needsUpdate) return true;
  if (st || it.steamChecked) return false;  // Steam の記録・状態があればそれに従う（Web の日時は説明文の編集やベータ版向けの更新でも変わるため）
  const m = S.meta[it.id]; return it.installed && m?.time_updated && it.timeupdated && m.time_updated > it.timeupdated + 60;
};
const isUnsub = it => { const st = sst(it); return st ? !st.subscribed : (it.ghost || (it.installed && it.subscribed === false)); };

// 適用中のプロファイルにあるのに、このPCに無い（未購読の）MOD を一覧に仮の行として加える
// → プロファイルの MOD 数と一覧の数が一致し、そこから購読できる
function addProfileGhosts(g) {
  if (!g) return;
  g.items = g.items.filter(i => !i.ghost);
  const p = g.state.profiles?.[g.state.appliedProfile];
  if (!p?.mods) return;
  const have = new Set(g.items.map(i => i.id));
  for (const m of p.mods) {
    if (!have.has(m.id)) g.items.push({ id: m.id, appid: g.appid, path: null, installed: false, subscribed: false, ghost: true, size: 0, timeupdated: 0, timetouched: 0 });
  }
}

function orderedIds(g) {
  const ids = new Set(g.items.map(i => i.id));
  const ord = g.state.order.filter(id => ids.has(id));
  const rest = g.items.filter(i => !ord.includes(i.id)).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ja')).map(i => i.id);
  return [...ord, ...rest];
}

async function load(keepSel = true) {
  $('#btn-refresh').disabled = true;
  try {
    const d = await api('scan');
    S.games = d.games;
    S.games.forEach(addProfileGhosts);
    Object.assign(S.meta, d.meta);
    $('#libs').innerHTML = 'Steam: ' + esc(d.steamPath || '未検出') + '<br>ライブラリ: ' + d.libraries.length;
    if (!game()) S.cur = S.games[0]?.appid || null;
    if (!keepSel) S.sel = null;
    renderAll();
    fetchMissingMeta();
    if (S.cur && prefs.steamAlways && !isRunning(S.cur)) steamConnect(true);
    gameRead(game());
    onGameShown(game());
  } catch (e) { toast('スキャン失敗: ' + e.message, 'err'); }
  finally { $('#btn-refresh').disabled = false; }
}

async function fetchMissingMeta(force = false) {
  const ids = S.games.flatMap(g => g.items.map(i => i.id)).filter(id => force || !S.meta[id]);
  if (!ids.length) return;
  $('#status').dataset.loading = '1'; renderStatus();
  try {
    for (let i = 0; i < ids.length; i += 300) {
      Object.assign(S.meta, await api('meta', { ids: ids.slice(i, i + 300), force }));
      renderAll();
    }
    if (force) toast('ワークショップ情報を更新しました', 'ok');
  } catch (e) { toast('Steam API 取得失敗: ' + e.message, 'err'); }
  finally { delete $('#status').dataset.loading; renderStatus(); }
}

async function saveState(patch) {
  const g = game();
  const d = await api('update', { appid: g.appid, ...patch });
  g.state = d.state;
}

// ---------------------------------------------------------------- render
function renderAll() { renderGames(); renderHeader(); renderItems(); renderDetail(); renderSide(); renderStatus(); renderSteam(); }

function renderGames() {
  $('#games').innerHTML = S.games.map(g => `
    <li data-app="${g.appid}" class="${g.appid === S.cur ? 'active' : ''}">
      <img src="${capsule(g.appid)}" onerror="this.src='${PLACEHOLDER}'" alt="">
      <span class="gname" title="${esc(g.name)}">${esc(g.name)}</span>
      ${isRunning(g.appid) ? '<span class="run-dot" title="プレイ中"></span>' : ''}
      <span class="gcount">${g.items.length}</span>
    </li>`).join('') || '<li class="empty">ワークショップアイテムがありません</li>';
}

function renderHeader() {
  const g = game();
  const el = $('#gh-body');
  if (!g) { el.innerHTML = '<h2>ゲームが見つかりません</h2>'; return; }
  const on = g.items.filter(i => isOn(g, i.id)).length;
  const upd = g.items.filter(hasUpdate).length;
  const size = g.items.reduce((a, i) => a + i.size, 0);
  $('#game-header').style.backgroundImage = `url(${header(g.appid)})`;
  renderPlay();
  el.innerHTML = `
    <div><h2>${esc(g.name)}</h2><div class="sub">AppID ${g.appid} ・ ${esc(g.library)}${gameSyncOn(g)
      ? (g.state.gamePending ? ' ・ <span class="gs pending" title="ゲームの終了後に設定ファイルへ書き込みます">⏳ ゲーム終了後に反映</span>'
        : ` ・ <span class="gs" title="${esc(g.adapter)}と有効/無効を同期しています">🔗 ゲーム内MOD設定と連動</span>`) : ''}</div></div>
    <div class="stats">
      <div class="stat"><b>${g.items.length}</b><span>アイテム</span></div>
      <div class="stat"><b style="color:var(--ok)">${on}</b><span>有効</span></div>
      <div class="stat"><b style="color:var(--warn)">${upd}</b><span>更新あり</span></div>
      <div class="stat"><b>${fmtSize(size)}</b><span>合計サイズ</span></div>
    </div>`;
}

function visibleItems(g) {
  const byId = Object.fromEntries(g.items.map(i => [i.id, i]));
  const order = orderedIds(g);
  const pos = Object.fromEntries(order.map((id, n) => [id, n]));
  let list = order.map(id => byId[id]);
  const q = S.q.trim().toLowerCase();
  if (q) list = list.filter(i => { const m = S.meta[i.id] || {}; return i.id.includes(q) || (m.title || '').toLowerCase().includes(q) || (m.tags || []).some(t => t.toLowerCase().includes(q)); });
  const f = S.filter;
  if (f === 'enabled') list = list.filter(i => isOn(g, i.id));
  if (f === 'disabled') list = list.filter(i => !isOn(g, i.id));
  if (f === 'update') list = list.filter(hasUpdate);
  if (f === 'missing') list = list.filter(i => !i.installed);
  if (f === 'unsub') list = list.filter(isUnsub);
  const cmp = {
    title: (a, b) => titleOf(a).localeCompare(titleOf(b), 'ja'),
    size: (a, b) => b.size - a.size,
    updated: (a, b) => (S.meta[b.id]?.time_updated || b.timeupdated) - (S.meta[a.id]?.time_updated || a.timeupdated),
    subs: (a, b) => (S.meta[b.id]?.subscriptions || 0) - (S.meta[a.id]?.subscriptions || 0),
  }[S.sort];
  if (cmp) list.sort(cmp);
  return { list, pos };
}

function renderItems() {
  const g = game(); const box = $('#items');
  box.className = 'items ' + S.view;
  $$('#view button').forEach(b => b.classList.toggle('active', b.dataset.v === S.view));
  $('#sort').value = S.sort;
  if (!g) { box.innerHTML = ''; return; }
  const { list, pos } = visibleItems(g);
  const canDrag = S.sort === 'order';
  box.innerHTML = list.map(it => {
    const m = S.meta[it.id] || {};
    const on = isOn(g, it.id);
    const st = sst(it);
    const badges = [
      canDrag ? `<span class="badge order">#${pos[it.id] + 1}</span>` : '',
      hasUpdate(it) ? (isQueued(it)
        ? '<span class="badge update" title="ゲームの終了後に更新します">⏳ 終了後に更新</span>'
        : `<span class="badge update clickable" data-update="${it.id}" title="クリックで更新">更新あり ⬇</span>`) : '',
      st?.downloading ? `<span class="badge dl">DL中 ${Math.round((st.progress || 0) * 100)}%</span>` : '',
      it.ghost && unavailable(it.id) ? `<span class="badge removed" title="プロファイル「${esc(g.state.appliedProfile || '')}」に入っていますが、Steam で見つかりません（${unavailReason(it.id)}）。入手できません">Steamで見つかりません</span>` : '',
      it.ghost && !unavailable(it.id) && !st?.subscribed ? `<span class="badge missing clickable" data-ghostsub="${it.id}" title="プロファイル「${esc(g.state.appliedProfile || '')}」に入っていますが、このPCにはありません。クリックで購読">未導入・購読する</span>` : '',
      !it.installed && !st?.downloading && !it.ghost ? '<span class="badge missing">未DL</span>' : '',
      isUnsub(it) && !it.ghost ? '<span class="badge unsub">未購読</span>' : '',
      st?.disabledLocally ? '<span class="badge sdis">Steamで無効</span>' : '',
      m.ok === false && !it.ghost ? `<span class="badge removed" title="Steam で見つかりません（${unavailReason(it.id)}）。このPCにあるファイルは使えますが、プロファイルを共有しても相手は入手できません">公開終了</span>` : '',
      depBadge(g, it),
    ].join('');
    const prog = st?.downloading ? `<div class="progress"><i style="width:${Math.round((st.progress || 0) * 100)}%"></i></div>` : '';
    return `
    <div class="item ${on ? '' : 'off'} ${S.sel === it.id ? 'sel' : ''} ${S.multi.has(it.id) ? 'msel' : ''}" data-id="${it.id}" draggable="${canDrag && S.view === 'list'}">
      <span class="handle ${canDrag ? '' : 'disabled'}" title="ドラッグで並べ替え">⋮⋮</span>
      <label class="toggle" title="${on ? 'クリックで無効にする' : 'クリックで有効にする'}（${esc(toggleHint(g))}）"><input type="checkbox" ${on ? 'checked' : ''} data-toggle="${it.id}"><span></span></label>
      <img class="thumb" loading="lazy" src="${esc(m.preview || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="">
      <div class="body">
        <div class="title" title="${esc(titleOf(it))}">${esc(titleOf(it))}</div>
        <div class="meta-line"><span>${fmtSize(it.size || m.file_size)}</span><span>更新 ${fmtDate(m.time_updated || it.timeupdated)}</span>${S.view === 'list' && m.tags?.length ? `<span>${esc(m.tags.slice(0, 3).join(' / '))}</span>` : ''}</div>${prog}
      </div>
      <div class="badges">${badges}</div>
    </div>`;
  }).join('') || '<div class="empty">該当するアイテムはありません</div>';
  renderSelbar();
}

function renderDetail() {
  const g = game(); const el = $('#tab-info');
  const it = g?.items.find(i => i.id === S.sel);
  if (!it) {
    el.innerHTML = '<p class="hint">左のリストからMODを選択すると詳細が表示されます。<br><br>ショートカット:<br>・Space … 選択中MODの有効/無効<br>・↑↓ … 選択の移動<br>・Ctrl+F … 検索</p>';
    return;
  }
  const m = S.meta[it.id] || {};
  const on = isOn(g, it.id);
  const st = sst(it);
  const stText = !st ? `${it.subscribed ? '購読中' : '未購読'}${it.installed ? ' / インストール済み' : ''}${it.needsUpdate ? ' / 更新待ち' : ''}（Steam の記録）` : [st.subscribed ? '購読中' : '未購読', st.installed ? 'インストール済み' : '',
    st.needsUpdate ? '更新待ち' : '', st.downloading ? `ダウンロード中 ${Math.round((st.progress || 0) * 100)}%` : '',
    st.disabledLocally ? 'Steamで無効' : ''].filter(Boolean).join(' / ');
  el.innerHTML = `
    <img class="d-preview" src="${esc(m.preview || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="">
    <div class="d-title">${esc(titleOf(it))}</div>
    <div class="tags">${(m.tags || []).map(t => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>
    <div class="d-actions">
      ${hasUpdate(it) ? `<button class="primary small" data-act="update" ${isQueued(it) ? 'disabled' : ''}>${isQueued(it) ? '⏳ 終了後に更新' : '⬇ 更新する'}</button>` : ''}
      <button class="${on ? 'danger' : 'primary'} small" data-act="toggle">${on ? '無効にする' : '有効にする'}</button>
      <button class="ghost small" data-act="folder" ${it.installed ? '' : 'disabled'}>📁 フォルダ</button>
      <button class="ghost small" data-act="web">🌐 ブラウザで開く</button>
      <button class="ghost small" data-act="steam">Steamで開く</button>
    </div>
    <div class="d-actions">
      ${isUnsub(it) ? '<button class="primary small" data-act="subscribe">購読する</button>' : '<button class="danger small" data-act="unsubscribe">購読解除</button>'}
      <button class="ghost small" data-act="download" ${isUnsub(it) ? 'disabled' : ''}>⬇ ${hasUpdate(it) ? '今すぐ更新' : '再ダウンロード'}</button>
    </div>
    <dl class="d-grid">
      <dt>ID</dt><dd>${it.id}</dd>
      <dt>Steam</dt><dd>${esc(stText)}</dd>
      <dt>サイズ</dt><dd>${fmtSize(it.size || m.file_size)}</dd>
      <dt>ローカル更新</dt><dd>${fmtDate(it.timeupdated)}</dd>
      <dt>最新版</dt><dd>${fmtDate(m.time_updated)} ${hasUpdate(it) ? '<span class="badge update">更新あり</span>' : ''}</dd>
      <dt>公開日</dt><dd>${fmtDate(m.time_created)}</dd>
      <dt>購読数</dt><dd>${fmtNum(m.subscriptions)}　★ ${fmtNum(m.favorited)}</dd>
      <dt>パス</dt><dd>${esc(it.path || '未ダウンロード')}</dd>
    </dl>
    ${detailExtras(g, it)}
    <div class="desc">${esc(stripBB(m.description) || '説明はありません')}</div>
    <label>メモ<textarea id="note" placeholder="このMODについてのメモ（自分用）">${esc(g.state.notes[it.id] || '')}</textarea></label>`;
  afterDetail(g, it);
}

function renderSide() {
  const g = game(); if (!g) return;
  const ps = Object.entries(g.state.profiles || {});
  $('#profiles').innerHTML = ps.map(([n, p]) => {
    const mods = profileMods(g, p);
    const on = mods.filter(m => m.enabled);
    const miss = missingMods(g, mods).length;
    const drift = profileDrift(g, p).added.length;
    const gone = mods.filter(m => unavailable(m.id)).length;
    return `
    <li class="${miss ? 'warn' : ''}"><div class="pn">${esc(n)}${p.imported ? '<span class="ptag">共有</span>' : ''}
        <small>${fmtDate(p.saved)} ・ 有効 ${on.length} / ${mods.length} 件${miss ? ` ・ 不足 ${miss} 件` : ''}${drift ? ` ・ <span title="このプロファイルを保存したあとに追加した MOD です。共有する前に上書き保存すると含まれます">保存後に追加 ${drift} 件</span>` : ''}${gone ? ` ・ <span class="gone" title="Steam で削除・非公開・公開停止になっていて、入手できない MOD です">Steamで見つからない ${gone} 件</span>` : ''}</small></div>
      <div class="pacts">
        <button class="primary small" data-papply="${esc(n)}">適用</button>
        <button class="ghost small" data-pdiff="${esc(n)}" title="今の状態との違いを表示">比較</button>
        <button class="ghost small" data-pcode="${esc(n)}" title="共有コードをコピー">📋 コード</button>
        <button class="ghost small" data-pfile="${esc(n)}" title="ファイルに保存">⬇</button>
        <button class="ghost small" data-pren="${esc(n)}" title="名前を変更">✎</button>
        <button class="ghost small" data-pdel="${esc(n)}" title="削除">✕</button>
      </div></li>`;
  }).join('') || '<li class="hint">保存されたプロファイルはありません</li>';
  $('#game-sync-box').classList.toggle('hidden', !g.adapter);
  $('#game-sync').checked = g.state.gameSync !== false;
  $('#game-sync-label').textContent = g.adapter || '';
  const d = g.state.deploy;
  $('#dep-path').value = d.path || ''; $('#dep-mode').value = d.mode || 'junction'; $('#dep-naming').value = d.naming || 'id';
  $('#dep-result').textContent = g.state.deployed?.length ? `現在 ${g.state.deployed.length} 件をデプロイ中` : '';
}

function renderStatus() {
  const g = game();
  const loading = $('#status').dataset.loading ? '<span>⏳ Steamから情報を取得中…</span>' : '';
  if (!g) { $('#status').innerHTML = loading; return; }
  const { list } = visibleItems(g);
  $('#status').innerHTML = `<span>表示 ${list.length} / ${g.items.length}</span><span>有効 ${g.items.filter(i => isOn(g, i.id)).length}</span><span>選択中: ${S.sel ? esc(titleOf(g.items.find(i => i.id === S.sel) || { id: S.sel })) : 'なし'}</span>${loading}`;
}

// ---------------------------------------------------------------- actions
async function setEnabled(ids, on, opts = {}) {
  const g = game();
  if (!opts.skipDeps) { ids = resolveDeps(g, ids, on); if (!ids) return; }
  pushUndo(g, on ? '有効にする' : '無効にする');
  let dis = new Set(g.state.disabled);
  ids.forEach(id => on ? dis.delete(id) : dis.add(id));
  g.state.disabled = [...dis];
  renderItems(); renderHeader(); renderDetail(); renderStatus();
  try { await saveState({ disabled: g.state.disabled }); } catch (e) { toast(e.message, 'err'); }
  gameWrite(g);
  if (steamSync(g) && S.steam.supports?.disable !== false) {
    if (!S.steam.connected || S.steam.appid !== g.appid) await steamConnect(true);
    const subs = S.steam.supports?.disable ? ids.filter(id => S.steam.items[id]?.subscribed) : [];
    if (subs.length && await steamAction('set_disabled', subs, { disabled: !on })) {
      subs.forEach(id => { S.steam.items[id].disabledLocally = !on; });
      renderItems();
    }
  }
}

function select(id) { S.sel = id; renderItems(); renderDetail(); renderStatus(); }

async function openTarget(target) { try { await api('open', { target }); } catch (e) { toast(e.message, 'err'); } }

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- steam
let pollTimer = null;
const steamSync = g => !!g.state.steamSync;

function applySteamItems(g, list) {
  for (const st of list) {
    S.steam.items[st.id] = st;
    let it = g.items.find(i => i.id === st.id);
    if (!it && st.subscribed) {  // Steamで購読しているがフォルダが無い（未DL/別ライブラリ）
      it = { id: st.id, appid: g.appid, path: null, installed: false, subscribed: true, size: 0, timeupdated: 0, timetouched: 0 };
      g.items.push(it);
    }
    if (it && st.installed && st.folder) { it.path = st.folder; it.installed = true; it.size = st.size || it.size; it.timeupdated = st.timestamp || it.timeupdated; }
  }
}

async function steamConnect(quiet = false) {
  const g = game(); if (!g) return;
  S.steam.busy = true; S.steam.error = ''; renderSteam();
  try {
    const d = await api('steam/connect', { appid: g.appid, ids: g.items.map(i => i.id) });
    if (S.cur !== g.appid) return;
    Object.assign(S.steam, { connected: true, appid: g.appid, persona: d.persona, supports: d.supports, dll: d.dll, items: {} });
    applySteamItems(g, d.items);
    renderAll();
    fetchMissingMeta();
    schedulePoll();
  } catch (e) {
    Object.assign(S.steam, { connected: false, appid: null, items: {}, error: e.message });
    if (!quiet) toast(e.message, 'err');
    renderAll();
  } finally { S.steam.busy = false; renderSteam(); }
}

async function steamDisconnect() {
  clearTimeout(pollTimer);
  try { await api('steam/disconnect'); } catch { /* ignore */ }
  Object.assign(S.steam, { connected: false, appid: null, items: {}, error: '' });
  renderAll();
}

async function steamAction(action, ids, extra = {}) {
  const g = game();
  if (!S.steam.connected || S.steam.appid !== g.appid) await steamConnect();
  if (!S.steam.connected) return null;
  try {
    const r = await api('steam/action', { appid: g.appid, action, ids, ...extra });
    if (['subscribe', 'unsubscribe', 'download'].includes(action)) { ids.forEach(id => watching.add(id)); schedulePoll(800); }
    return r;
  } catch (e) {
    if (/通信が切れ|応答しません/.test(e.message)) { S.steam.connected = false; renderSteam(); }
    toast('Steam: ' + e.message, 'err'); return null;
  }
}

const watching = new Set();  // 操作直後で状態変化を追いかけるID
function schedulePoll(ms = 1500) {
  clearTimeout(pollTimer);
  const active = Object.values(S.steam.items).some(s => s.downloading) || watching.size;
  if (S.steam.connected && active) pollTimer = setTimeout(pollSteam, ms);
}
let watchRounds = 0;
async function pollSteam() {
  const g = game(); if (!g || S.steam.appid !== g.appid) return;
  const ids = [...new Set([...watching, ...Object.values(S.steam.items).filter(s => s.downloading).map(s => s.id)])];
  try {
    const before = JSON.stringify(ids.map(id => S.steam.items[id]));
    const d = await api('steam/status', { appid: g.appid, ids });
    applySteamItems(g, d.items);
    const finished = d.items.some(s => !s.downloading && S.steam.items[s.id]?.installed) && before.includes('"downloading":true');
    if (++watchRounds > 8) { watching.clear(); watchRounds = 0; }
    renderItems(); renderHeader(); renderDetail(); renderStatus();
    if (finished) toast('ダウンロードが完了しました', 'ok');
  } catch { /* 次回再試行 */ }
  schedulePoll();
}

async function pushSteam(g) {
  if (!S.steam.connected || S.steam.appid !== g.appid) await steamConnect(true);
  if (!S.steam.supports?.disable) return false;
  const subs = g.items.filter(i => S.steam.items[i.id]?.subscribed).map(i => i.id);
  const off = subs.filter(id => !isOn(g, id)), on = subs.filter(id => isOn(g, id));
  if (off.length) await steamAction('set_disabled', off, { disabled: true });
  if (on.length) await steamAction('set_disabled', on, { disabled: false });
  if (S.steam.supports.loadOrder && g.state.orderCustom) await steamAction('set_load_order', orderedIds(g).filter(id => subs.includes(id)));
  subs.forEach(id => { S.steam.items[id].disabledLocally = !isOn(g, id); });
  renderItems();
  return true;
}
async function steamSyncState(g) {
  if (!S.steam.supports?.disable) { toast('このSteam APIは同期に未対応です', 'err'); return; }
  await pushSteam(g);
  await steamConnect(true);
  toast('Steamに同期しました', 'ok');
}

function renderSteam() {
  const pill = $('#steam-pill'); const s = S.steam; const g = game();
  pill.className = 'steam-pill ' + (s.busy ? 'busy' : s.connected ? 'on' : s.error ? 'err' : '');
  $('.txt', pill).textContent = s.busy ? 'Steam 接続中…' : s.connected ? `Steam: ${s.persona || '接続中'}`
    : (g && isRunning(g.appid)) ? 'Steam 一時停止（プレイ中）' : 'Steam: 必要なときだけ接続';
  pill.title = s.error || (s.connected
    ? `${g?.name || ''} として接続中。接続中は Steam 上でこのゲームが「実行中」になります（操作が終わると自動で切断／クリックで今すぐ切断）`
    : '購読・更新・検索などの操作をするときだけ Steam に接続します（接続中は Steam 上でそのゲームが「実行中」になります）。クリックで今すぐ接続');
  if ($('#steam-always')) $('#steam-always').checked = !!prefs.steamAlways;
  const subs = Object.values(s.items).filter(x => x.subscribed).length;
  $('#steam-info').innerHTML = s.connected
    ? `<b>● 接続中</b><br>ユーザー: <b>${esc(s.persona)}</b><br>ゲーム: ${esc(g?.name)}（購読 ${subs} 件）<br>
       <span class="muted">ローカル無効化: ${s.supports?.disable ? '対応' : '非対応'} ／ ロード順: ${s.supports?.loadOrder ? '対応' : '非対応'}<br>API: ${esc(s.dll || '')}</span>`
    : `<b class="muted">○ 未接続（必要なときだけ接続します）</b><br><span class="muted">購読状態と更新の有無は Steam の記録ファイルから読んでいます。</span>${s.error ? `<br><span style="color:var(--bad)">${esc(s.error)}</span>` : ''}`;
  if (g) $('#steam-sync').checked = steamSync(g);
  const ups = g ? updatable(g) : [];
  const queued = g ? ups.filter(isQueued).length : 0;
  const btn = $('#btn-dl-updates');
  btn.classList.toggle('hidden', !ups.length);
  btn.textContent = queued && queued === ups.length ? `⏳ 終了後に更新 (${queued})`
    : g && isRunning(g.appid) ? `更新 (${ups.length})・終了後` : `⬇ 更新を全てDL (${ups.length})`;
  btn.title = g && isRunning(g.appid) ? 'ゲームの実行中は更新できないため、終了後に自動で更新します' : '更新のあるMODをSteamでダウンロードします';
}

// ---------------------------------------------------------------- events
$('#games').addEventListener('click', e => {
  const li = e.target.closest('li[data-app]'); if (!li) return;
  if (S.cur === li.dataset.app) return;
  S.cur = li.dataset.app; S.sel = null; savePrefs();
  Object.assign(S.steam, { connected: false, appid: null, items: {} });
  renderAll();
  if (prefs.steamAlways && !isRunning(S.cur)) steamConnect(true);
  gameRead(game());
  S.multi.clear();
  onGameShown(game());
});

// steam events
$('#steam-pill').onclick = () => {
  if (S.steam.busy) return;
  if (S.steam.connected) steamDisconnect(); else steamConnect();
};
$('#btn-steam-connect').onclick = () => steamConnect();
$('#steam-always').onchange = e => {
  prefs.steamAlways = e.target.checked;
  localStorage.setItem('wsm-prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('wsm-prefs') || '{}'), steamAlways: prefs.steamAlways }));
  if (prefs.steamAlways && !S.steam.connected && !isRunning(S.cur)) steamConnect(true);
};
$('#btn-steam-disconnect').onclick = () => steamDisconnect();
$('#steam-sync').onchange = async e => {
  const g = game(); g.state.steamSync = e.target.checked;
  try { await saveState({ steamSync: e.target.checked }); } catch (err) { toast(err.message, 'err'); }
};
$('#btn-steam-syncnow').onclick = () => steamSyncState(game());
$('#btn-dl-updates').onclick = async () => {
  const ids = updatable(game()).map(i => i.id);
  if (ids.length) await updateMods(ids);
};
$('#btn-sub').onclick = async () => {
  const raw = $('#sub-id').value; const id = (raw.match(/id=(\d+)/) || raw.match(/(\d{5,})/) || [])[1];
  if (!id) { toast('IDを認識できません', 'err'); return; }
  if (await steamAction('subscribe', [id])) { $('#sub-id').value = ''; toast('購読しました', 'ok'); fetchMissingMeta(); }
};

$('#items').addEventListener('click', e => {
  const up = e.target.closest('[data-update]');
  if (up) { updateMods([up.dataset.update]); return; }
  if (e.target.closest('.toggle')) return;  // スイッチの操作は下の change で処理（行の選択はしない）
  const it = e.target.closest('.item'); if (it) selectFromClick(it.dataset.id, e);
});
$('#items').addEventListener('dblclick', e => {
  const it = e.target.closest('.item'); if (!it || e.target.closest('.toggle')) return;
  const g = game(); setEnabled([it.dataset.id], !isOn(g, it.dataset.id));
});
// トグルスイッチ: 詳細の「無効にする / 有効にする」と同じ処理（保存・ゲーム設定・Steam 同期）
$('#items').addEventListener('change', e => {
  const tg = e.target.closest('[data-toggle]'); if (!tg) return;
  setEnabled([tg.dataset.toggle], tg.checked);
});

// drag & drop load order
let dragId = null;
$('#items').addEventListener('dragstart', e => { const it = e.target.closest('.item'); if (!it) return; dragId = it.dataset.id; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
$('#items').addEventListener('dragend', () => { dragId = null; $$('.item').forEach(x => x.classList.remove('dragging', 'drag-over')); });
$('#items').addEventListener('dragover', e => {
  const it = e.target.closest('.item'); if (!it || !dragId) return;
  e.preventDefault(); $$('.drag-over').forEach(x => x.classList.remove('drag-over')); it.classList.add('drag-over');
});
$('#items').addEventListener('drop', async e => {
  const it = e.target.closest('.item'); if (!it || !dragId || it.dataset.id === dragId) return;
  e.preventDefault();
  const g = game(); pushUndo(g, '並べ替え');
  const order = orderedIds(g).filter(id => id !== dragId);
  order.splice(order.indexOf(it.dataset.id), 0, dragId);
  g.state.order = order; renderItems();
  try { await saveState({ order, orderCustom: true }); } catch (err) { toast(err.message, 'err'); }
  gameWrite(g);
  if (steamSync(g)) pushSteam(g);
});

$('#tab-info').addEventListener('click', e => {
  const g = game(); const id = S.sel;
  const tag = e.target.closest('[data-tag]');
  if (tag) { S.q = tag.dataset.tag; $('#search').value = S.q; renderItems(); renderStatus(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const it = g.items.find(i => i.id === id);
  if (act === 'toggle') setEnabled([id], !isOn(g, id));
  if (act === 'folder') openTarget(it.path);
  if (act === 'web') openTarget(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`);
  if (act === 'steam') openTarget(`steam://url/CommunityFilePage/${id}`);
  if (act === 'subscribe') steamAction('subscribe', [id]).then(r => r && toast('購読しました。ダウンロードを開始します', 'ok'));
  if (act === 'unsubscribe' && confirm(`「${titleOf(it)}」の購読を解除しますか？\nSteamがファイルを削除します。`))
    steamAction('unsubscribe', [id]).then(r => r && toast('購読を解除しました', 'ok'));
  if (act === 'download') steamAction('download', [id]).then(r => r && toast('ダウンロードを開始しました', 'ok'));
  if (act === 'update') updateMods([id]);
});
let noteTimer;
$('#tab-info').addEventListener('input', e => {
  if (e.target.id !== 'note') return;
  const g = game(); g.state.notes[S.sel] = e.target.value;
  clearTimeout(noteTimer); noteTimer = setTimeout(() => saveState({ notes: g.state.notes }).catch(err => toast(err.message, 'err')), 500);
});

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  S.filter = b.dataset.f; $$('#filters .chip').forEach(c => c.classList.toggle('active', c === b)); renderItems(); renderStatus();
});
$('#sort').addEventListener('change', e => { S.sort = e.target.value; savePrefs(); renderItems(); });
$('#view').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; S.view = b.dataset.v; savePrefs(); renderItems(); });
$('#search').addEventListener('input', e => { S.q = e.target.value; renderItems(); renderStatus(); });
$('#btn-refresh').onclick = () => load();
$('#btn-meta').onclick = () => fetchMissingMeta(true);
$('#btn-all-on').onclick = () => setEnabled(visibleItems(game()).list.map(i => i.id), true);
$('#btn-all-off').onclick = () => setEnabled(visibleItems(game()).list.map(i => i.id), false);

$('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  $$('.tab').forEach(t => t.classList.toggle('active', t === b));
  $$('.tab-body').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.t));
});

// profiles
// プロファイル → [{id, enabled}]（旧形式は disabled/order から組み立てる）
function profileMods(g, p) {
  if (p.mods) return p.mods;
  const ids = [...p.order, ...orderedIds(g).filter(id => !p.order.includes(id))];
  return ids.map(id => ({ id, enabled: !p.disabled.includes(id) }));
}
// 有効なのにインストールされていない MOD
const missingMods = (g, mods) => mods.filter(m => m.enabled && !g.items.some(i => i.id === m.id && i.installed));

async function profile(action, name, extra = {}) {
  const g = game();
  if (action === 'apply') pushUndo(g, `プロファイル「${name}」の適用`);
  try {
    const d = await api('profile', { appid: g.appid, action, name, ...extra });
    g.state = d.state; addProfileGhosts(g); renderAll();
    toast({ save: '保存しました', apply: `「${name}」を適用しました`, delete: '削除しました', rename: '名前を変更しました' }[action], 'ok');
    if (action === 'apply') {
      await gameWrite(g, true);
      if (steamSync(g)) pushSteam(g);
      let miss = missingMods(g, profileMods(g, g.state.profiles[name]));
      const unk = miss.map(m => m.id).filter(id => !S.meta[id]);
      if (unk.length) { try { Object.assign(S.meta, await api('meta', { ids: unk })); renderAll(); } catch { /* オフライン */ } }
      if (miss.length) showMissing(miss, `「${name}」で有効になっている MOD のうち ${miss.length} 件がインストールされていません。`);
    }
    return d;
  } catch (e) { toast(e.message, 'err'); return null; }
}
$('#btn-profile-save').onclick = () => {
  const n = $('#profile-name').value.trim(); if (!n) return;
  const g = game();
  if (g.state.profiles[n] && !confirm(`「${n}」を今の状態で上書きしますか？`)) return;
  profile('save', n, { mods: orderedIds(g) }); $('#profile-name').value = '';
};
$('#profiles').addEventListener('click', async e => {
  const g = game();
  const t = e.target.closest('button'); if (!t) return;
  const { papply, pdel, pcode, pfile, pren } = t.dataset;
  if (papply) { if (g.state.profiles[papply]?.imported) showDiff(g, papply); else profile('apply', papply, { current: g.items.map(i => i.id) }); }
  if (t.dataset.pdiff) showDiff(g, t.dataset.pdiff);
  if (pdel && confirm(`プロファイル「${pdel}」を削除しますか？`)) profile('delete', pdel);
  if (pren) { const nn = prompt('新しい名前', pren); if (nn && nn.trim() !== pren) profile('rename', pren, { newName: nn.trim() }); }
  if ((pfile || pcode) && !(await confirmProfileFresh(g, pfile || pcode))) return;
  if (pfile) download(`${safeFile(g.name)}_${safeFile(pfile)}.wsmprofile`, JSON.stringify(exportData(g, [pfile]), null, 2));
  if (pcode) {
    const code = await encodeShare(g, pcode);
    try {
      await navigator.clipboard.writeText(code);
      toast(`共有コードをコピーしました（${code.length} 文字）`, 'ok');
    } catch {  // クリップボードが使えない環境では欄に表示して選択状態にする
      const ta = $('#prof-code'); ta.value = code; ta.focus(); ta.select();
      toast('下の欄に共有コードを表示しました。Ctrl+C でコピーしてください');
    }
  }
});
// プロファイルを保存したあとに増えた/無くなった MOD
function profileDrift(g, p) {
  if (p.imported) return { added: [] };  // もらったプロファイルは自分の MOD と比べない
  const ids = new Set(profileMods(g, p).map(m => m.id));
  const now = g.items.filter(i => !i.ghost && i.installed);
  return { added: now.filter(i => !ids.has(i.id)).map(i => i.id) };
}
async function confirmProfileFresh(g, name) {
  const gone = profileMods(g, g.state.profiles[name]).filter(m => unavailable(m.id));
  if (gone.length) toast(`「${name}」の ${gone.length} 件は Steam で見つからない（削除・非公開・公開停止）ため、共有した相手は入手できません: ${gone.slice(0, 3).map(m => titleOf(m)).join('、')}${gone.length > 3 ? ' ほか' : ''}`, 'err');
  const { added } = profileDrift(g, g.state.profiles[name]);
  if (!added.length) return true;
  const list = added.slice(0, 8).map(id => '・' + titleOf({ id })).join('\n') + (added.length > 8 ? `\n…ほか ${added.length - 8} 件` : '');
  if (confirm(`「${name}」を保存したあとに追加した MOD が ${added.length} 件あり、このプロファイルには入っていません。\n${list}\n\n今の状態で上書き保存してから共有しますか？\n（キャンセルすると保存済みの内容のまま共有します）`)) {
    await profile('save', name, { mods: orderedIds(g) });
  }
  return true;
}
$('#btn-prof-export-all').onclick = () => {
  const g = game(); const names = Object.keys(g.state.profiles);
  if (!names.length) { toast('保存されたプロファイルがありません', 'err'); return; }
  download(`${safeFile(g.name)}_profiles.wsmprofile`, JSON.stringify(exportData(g, names), null, 2));
};
$('#prof-import-file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { await importProfiles(JSON.parse(await f.text())); } catch (err) { toast('読み込み失敗: ' + err.message, 'err'); }
};
$('#btn-prof-import-code').onclick = async () => {
  const code = $('#prof-code').value.trim(); if (!code) return;
  try { if (await importProfiles(await decodeShare(code))) $('#prof-code').value = ''; }
  catch (err) { toast('共有コードを読み込めません: ' + err.message, 'err'); }
};

const safeFile = s => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

// ファイル形式（タイトル付き。人が読んでも分かるように）
function exportData(g, names) {
  return {
    format: 'wsm-profiles', version: 1, app: g.appid, game: g.name, exported: new Date().toISOString(),
    profiles: names.map(n => ({
      name: n, customOrder: !!g.state.profiles[n].customOrder, mods: profileMods(g, g.state.profiles[n]).map(m => ({ id: m.id, title: S.meta[m.id]?.title || m.title || '', enabled: m.enabled })),
    })),
  };
}

// 共有コード: "WSM1." + base64url(deflate(JSON))。無効な MOD は ID の前に "-"
async function encodeShare(g, name) {
  const mods = profileMods(g, g.state.profiles[name]);
  const json = JSON.stringify({ a: g.appid, g: g.name, n: name, c: g.state.profiles[name].customOrder ? 1 : 0, m: mods.map(m => (m.enabled ? '' : '-') + m.id).join(',') });
  const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  let bin = ''; new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
  return 'WSM1.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decodeShare(code) {
  const m = code.replace(/\s+/g, '').match(/WSM1\.([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('WSM1. で始まるコードではありません');
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  const d = JSON.parse(text);
  return { format: 'wsm-profiles', app: String(d.a), game: d.g, profiles: [{ name: d.n, customOrder: !!d.c,
    mods: String(d.m || '').split(',').filter(Boolean).map(x => ({ id: x.replace(/^-/, ''), enabled: !x.startsWith('-') })) }] };
}

// ファイル/共有コード/旧エクスポート形式を読み込んでプロファイルに追加
async function importProfiles(d) {
  let profiles = d.profiles;
  if (!profiles && Array.isArray(d.mods)) profiles = [{ name: d.name ? `${d.name} の構成` : 'インポート', mods: d.mods }];
  if (!Array.isArray(profiles) || !profiles.length) throw new Error('プロファイルが含まれていません');
  let g = game();
  const app = String(d.app || '');
  if (app && app !== g.appid) {
    const other = S.games.find(x => x.appid === app);
    const label = d.game || d.name || `AppID ${app}`;
    if (other) {
      if (!confirm(`「${label}」のプロファイルです。${other.name} に読み込みますか？`)) return false;
      S.cur = other.appid; S.sel = null; savePrefs(); g = other;
      Object.assign(S.steam, { connected: false, appid: null, items: {} });
    } else if (!confirm(`「${label}」のプロファイルですが、このPCにはそのゲームのアイテムがありません。\n現在のゲーム（${g.name}）に読み込みますか？`)) return false;
  }
  const r = await api('profile', { appid: g.appid, action: 'import', profiles });
  g.state = r.state;
  // タイトル表示用に情報を取得
  const ids = [...new Set(profiles.flatMap(p => (p.mods || []).map(m => String(m.id))))].filter(id => !S.meta[id]);
  if (ids.length) { try { Object.assign(S.meta, await api('meta', { ids })); } catch { /* オフラインでも続行 */ } }
  renderAll();
  if (S.steam.appid !== g.appid && prefs.steamAlways && !isRunning(g.appid)) steamConnect(true);
  const n = r.added.length;
  toast(`${n} 件のプロファイルを読み込みました: ${r.added.join('、')}`, 'ok');
  if (n === 1) showDiff(g, r.added[0]);
  return true;
}

// 足りない MOD の一覧（購読ボタン付き）
function showMissing(list, hint) {
  const ok = list.filter(m => !unavailable(m.id)), gone = list.filter(m => unavailable(m.id));
  $('#missing-hint').textContent = hint + (ok.length ? ' 購読すると Steam がダウンロードします。' : '');
  const ids = ok.map(m => m.id);
  const row = (m, btn) => { const meta = S.meta[m.id] || {}; return `
      <div class="col-row"><img src="${esc(meta.preview || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'">
        <span class="t">${esc(meta.title || m.title || titleOf(m))}${unavailable(m.id) ? `<br><small class="hint">${unavailReason(m.id)}</small>` : ''}</span>
        ${btn}<button class="ghost small" data-mopen="${m.id}">ページ</button></div>`; };
  $('#missing-list').innerHTML =
    (ids.length ? `<p><button class="primary small" data-msub="${ids.join(',')}">まとめて購読 (${ids.length})</button></p>` : '') +
    ok.map(m => row(m, `<button class="primary small" data-msub="${m.id}">購読</button>`)).join('') +
    (gone.length ? `<div class="sect-title gone">Steam で見つからないため入手できない（${gone.length}）</div>
      <p class="hint">作者が削除・非公開にしたか、Steam により公開停止になった MOD です。プロファイルを共有した人の PC には残っていても、ほかの人はダウンロードできません。このため MOD の数が ${gone.length} 件少なくなります。</p>` +
      gone.map(m => row(m, '<span class="badge removed">入手不可</span>')).join('') : '');
  $('#missing-modal').classList.remove('hidden');
  if (gone.length) toast(`${gone.length} 件の MOD は Steam で見つからない（削除・非公開・公開停止）ため入手できません`, 'err');
}
$('#items').addEventListener('click', async e => {
  const b = e.target.closest('[data-ghostsub]'); if (!b) return;
  if (unavailable(b.dataset.ghostsub)) return;
  e.stopPropagation();
  const id = b.dataset.ghostsub;
  if (await steamAction('subscribe', [id])) { waitForInstall(game().appid, [id]); toast('購読しました。ダウンロードが終わると自動で有効にしてゲームの設定に反映します', 'ok'); }
}, true);
$('#missing-modal').addEventListener('click', async e => {
  if (e.target.id === 'missing-modal' || e.target.closest('[data-close-missing]')) { $('#missing-modal').classList.add('hidden'); return; }
  const o = e.target.closest('[data-mopen]'); if (o) openTarget(`steam://url/CommunityFilePage/${o.dataset.mopen}`);
  const b = e.target.closest('[data-msub]'); if (!b) return;
  const ids = b.dataset.msub.split(',');
  b.disabled = true;
  if (await steamAction('subscribe', ids)) {
    waitForInstall(game().appid, ids);
    toast(`${ids.length} 件を購読しました。ダウンロードが終わると自動でゲームの設定に反映します`, 'ok');
    const sel = ids.length > 1 ? '#missing-list [data-msub]' : `#missing-list [data-msub="${ids[0]}"]`;
    $$(sel).forEach(x => { x.disabled = true; x.textContent = '購読済み'; });
  } else b.disabled = false;
});

// deploy
const depCfg = () => ({ path: $('#dep-path').value.trim(), mode: $('#dep-mode').value, naming: $('#dep-naming').value });
$('#btn-dep-save').onclick = async () => { try { await saveState({ deploy: depCfg() }); toast('デプロイ設定を保存しました', 'ok'); } catch (e) { toast(e.message, 'err'); } };
$('#btn-dep-open').onclick = () => openTarget($('#dep-path').value.trim());
$('#btn-deploy').onclick = async () => {
  const g = game();
  try {
    await saveState({ deploy: depCfg() });
    const r = await api('deploy', { appid: g.appid });
    g.state.deployed = r.deployed;
    $('#dep-result').textContent = `配置 ${r.deployed.length} 件（旧配置 ${r.removed} 件を解除）` + (r.skipped.length ? `\nスキップ:\n・` + r.skipped.join('\n・') : '');
    toast(`${r.deployed.length} 件をデプロイしました`, 'ok');
  } catch (e) { toast('デプロイ失敗: ' + e.message, 'err'); }
};
$('#btn-undeploy').onclick = async () => {
  const g = game();
  if (!confirm('このツールが配置したMODをデプロイ先から取り外しますか？（ワークショップ本体は消えません）')) return;
  try { const r = await api('undeploy', { appid: g.appid }); g.state.deployed = []; $('#dep-result').textContent = `${r.removed.length} 件を取り外しました`; toast('取り外しました', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};

// export / import
const enabledIds = g => orderedIds(g).filter(id => isOn(g, id));
$('#btn-copy-ids').onclick = async () => { await navigator.clipboard.writeText(enabledIds(game()).join('\n')); toast('IDをコピーしました', 'ok'); };
$('#btn-copy-links').onclick = async () => { await navigator.clipboard.writeText(enabledIds(game()).map(id => `${titleOf({ id })}\thttps://steamcommunity.com/sharedfiles/filedetails/?id=${id}`).join('\n')); toast('URLをコピーしました', 'ok'); };
$('#btn-export-json').onclick = () => {
  const g = game();
  const data = { app: g.appid, name: g.name, exported: new Date().toISOString(),
    mods: orderedIds(g).map(id => ({ id, title: titleOf({ id }), enabled: isOn(g, id) })) };
  download(`workshop_${g.appid}.json`, JSON.stringify(data, null, 2));
};
$('#import-json').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try {
    const d = JSON.parse(await f.text()); const g = game();
    if (String(d.app) !== g.appid && !confirm(`別のゲーム(${d.name || d.app})のリストです。適用しますか？`)) return;
    const have = new Set(g.items.map(i => i.id));
    const mods = (d.mods || []).map(m => ({ ...m, id: String(m.id) }));
    const order = mods.map(m => m.id).filter(id => have.has(id));
    const off = new Set(mods.filter(m => !m.enabled).map(m => m.id));
    const listed = new Set(mods.map(m => m.id));
    g.items.forEach(i => { if (!listed.has(i.id)) off.add(i.id); });
    pushUndo(g, 'リストの読み込み');
    await saveState({ order, disabled: [...off] }); renderAll();
    gameWrite(g, true);
    const missing = mods.filter(m => m.enabled !== false && !have.has(m.id));
    toast(`読み込みました${missing.length ? `（未購読 ${missing.length} 件）` : ''}`, missing.length ? '' : 'ok');
    if (missing.length) showMissing(missing, `リストのうち ${missing.length} 件がインストールされていません。`);
  } catch (err) { toast('読み込み失敗: ' + err.message, 'err'); }
};

// collection modal
$('#btn-collection').onclick = () => $('#modal').classList.remove('hidden');
$('#modal-close').onclick = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
$('#btn-col').onclick = async () => {
  const raw = $('#col-id').value; const id = (raw.match(/id=(\d+)/) || raw.match(/(\d{5,})/) || [])[1];
  if (!id) { toast('IDを認識できません', 'err'); return; }
  $('#col-result').innerHTML = '<p class="hint">取得中…</p>';
  try {
    const d = await api('collection', { id });
    Object.assign(S.meta, d.meta);
    const have = new Set(S.games.flatMap(g => g.items.map(i => i.id)));
    const missing = d.children.filter(c => !have.has(c));
    $('#col-result').innerHTML = `<p><b>${esc(d.title || id)}</b> — ${d.children.length} 件中 <span style="color:var(--ok)">${d.children.length - missing.length} 件購読済み</span>、<span style="color:var(--warn)">${missing.length} 件未購読</span>
      ${missing.length ? `<button class="primary small" data-suball="${missing.join(',')}">未購読を全て購読 (${missing.length})</button>` : ''}</p>` +
      d.children.map(c => { const m = d.meta[c] || {}; const ok = have.has(c); return `
        <div class="col-row"><img src="${esc(m.preview || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'"><span class="t">${esc(m.title || c)}</span>
        ${ok ? '<span class="badge" style="color:var(--ok);border-color:#24553c">購読済み</span>' : `<button class="primary small" data-sub="${c}">購読</button> <button class="ghost small" data-open="${c}">ページ</button>`}</div>`; }).join('');
  } catch (e) { $('#col-result').innerHTML = ''; toast(e.message, 'err'); }
};
$('#col-result').addEventListener('click', async e => {
  const o = e.target.closest('[data-open]'); if (o) openTarget(`steam://url/CommunityFilePage/${o.dataset.open}`);
  const b = e.target.closest('[data-sub],[data-suball]'); if (!b) return;
  const ids = (b.dataset.sub || b.dataset.suball).split(',');
  b.disabled = true;
  if (await steamAction('subscribe', ids)) { b.textContent = '購読しました'; toast(`${ids.length} 件を購読しました`, 'ok'); }
  else b.disabled = false;
});

// keyboard
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === 'Escape') { $$('.modal').forEach(x => x.classList.add('hidden')); if (S.multi.size) { S.multi.clear(); renderItems(); } }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  const g = game(); if (!g) return;
  const ids = visibleItems(g).list.map(i => i.id);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = ids.indexOf(S.sel) + (e.key === 'ArrowDown' ? 1 : -1);
    if (ids[Math.max(0, Math.min(ids.length - 1, n))]) select(ids[Math.max(0, Math.min(ids.length - 1, n))]);
    $('.item.sel')?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === ' ' && S.sel) { e.preventDefault(); setEnabled(S.multi.size > 1 ? [...S.multi] : [S.sel], !isOn(g, S.sel)); }
});

// ---------------------------------------------------------------- updates
const queuedUpdates = {};  // appid -> Set(ids)  ゲーム終了後に更新するもの
const isQueued = it => !!queuedUpdates[it.appid]?.has(it.id);
const updatable = g => g.items.filter(i => i.installed && hasUpdate(i) && !isUnsub(i));

async function updateMods(ids) {
  const g = game(); if (!g || !ids.length) return;
  if (isRunning(g.appid)) {  // 実行中のゲームの MOD は Steam が更新できない
    const q = (queuedUpdates[g.appid] ||= new Set());
    ids.forEach(id => q.add(id));
    saveQueue();
    toast(`ゲームの実行中は更新できないため、終了後に自動で更新します（${q.size} 件）`);
    renderItems(); renderDetail(); renderSteam();
    return;
  }
  await backupBeforeUpdate(g, ids);
  if (await steamAction('download', ids)) {
    ids.forEach(id => { if (S.steam.items[id]) S.steam.items[id].downloading = true; });
    toast(`${ids.length} 件の更新を開始しました`, 'ok');
    renderItems(); renderDetail();
  }
}
async function runQueuedUpdates(appid) {
  const ids = [...queuedUpdates[appid]]; delete queuedUpdates[appid]; saveQueue();
  await steamConnect(true);
  if (S.steam.connected && S.steam.appid === appid) {
    toast(`ゲームが終了したので ${ids.length} 件の更新を開始します`);
    await updateMods(ids);
  }
}

// ---------------------------------------------------------------- game settings
const gameSyncOn = g => !!g?.adapter && g.state.gameSync !== false;
async function gameRead(g) {
  if (!gameSyncOn(g)) return;
  try {
    const r = await api('game/read', { appid: g.appid });
    if (r.state) { g.state = r.state; renderAll(); }
    if (r.flushed) toast('保留していた変更をゲームの設定に反映しました', 'ok');
  } catch (e) { toast('ゲーム設定の読み込みに失敗: ' + e.message, 'err'); }
}
async function gameWrite(g, announce = false) {
  if (!gameSyncOn(g)) return;
  try {
    const r = await api('game/write', { appid: g.appid });
    if (r.state) g.state.gamePending = r.state.gamePending;
    if (r.pending) toast('ゲームの実行中のため、終了後にゲーム内の設定へ反映します');
    else if (announce && r.written) toast('ゲーム内のMOD設定に反映しました', 'ok');
    renderHeader();
  } catch (e) { toast('ゲーム設定への書き込みに失敗: ' + e.message, 'err'); }
}
$('#game-sync').onchange = async e => {
  const g = game();
  try { await saveState({ gameSync: e.target.checked }); renderHeader(); if (e.target.checked) gameRead(g); }
  catch (err) { toast(err.message, 'err'); }
};

// ---------------------------------------------------------------- launch
const isRunning = appid => S.running.includes(appid);
function renderPlay() {
  const g = game(); if (!g) return;
  const run = isRunning(g.appid);
  const btn = $('#btn-play');
  btn.classList.toggle('running', run);
  btn.textContent = run ? '● プレイ中' : '▶ プレイ';
  btn.title = run ? 'このゲームは実行中です' : 'Steam でゲームを起動';
  const l = g.state.launch || { args: '', deploy: false };
  if (document.activeElement !== $('#launch-args')) $('#launch-args').value = l.args || '';
  $('#launch-deploy').checked = !!l.deploy;
  const ps = Object.keys(g.state.profiles || {});
  $('#launch-profile').innerHTML = '<option value="">（適用しない）</option>' +
    ps.map(n => `<option value="${esc(n)}" ${n === l.profile ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('#launch-deploy-hint').textContent = g.state.deploy?.path ? `デプロイ先: ${g.state.deploy.path}` : '※ デプロイ先は「デプロイ」タブで設定してください';
}

const launchCfg = () => ({ args: $('#launch-args').value.trim(), deploy: $('#launch-deploy').checked, profile: $('#launch-profile').value });

$('#btn-play').onclick = async () => {
  const g = game(); if (!g) return;
  if (isRunning(g.appid)) { toast(`${g.name} は既に実行中です`); return; }
  if (launchCfg().deploy && !g.state.deploy?.path) { toast('デプロイ先が設定されていません', 'err'); return; }
  const btn = $('#btn-play'); btn.disabled = true; btn.textContent = '起動中…';
  try {
    clearTimeout(pollTimer);
    const r = await api('launch', { appid: g.appid, launch: launchCfg() });
    if (r.applied) pushUndo(g, `起動時のプロファイル「${r.applied}」`);
    if (r.state) g.state = r.state; else g.state.launch = launchCfg();
    Object.assign(S.steam, { connected: false, appid: null, items: {} });
    toast(`${g.name} を起動しています` + (r.applied ? `（プロファイル「${r.applied}」を適用）` : '')
      + (r.deployed ? `（MOD ${r.deployed.deployed.length} 件をデプロイ）` : ''), 'ok');
    renderAll();
  } catch (e) { toast('起動に失敗しました: ' + e.message, 'err'); }
  finally { btn.disabled = false; renderPlay(); }
};
$('#btn-play-opt').onclick = e => { e.stopPropagation(); $('#play-pop').classList.toggle('hidden'); };
$('#play-pop').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => $('#play-pop').classList.add('hidden'));
$('#btn-launch-save').onclick = async () => {
  const g = game();
  try { await saveState({ launch: launchCfg() }); $('#play-pop').classList.add('hidden'); toast('起動オプションを保存しました', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};

// 実行中のゲームを監視（Steam のレジストリ値を読むだけなので軽い）
async function pollRunning() {
  try {
    const r = await api('running');
    for (const a of r.flushed || []) {  // ゲーム終了後に、保留していた設定を書き込んだ
      const g = S.games.find(x => x.appid === a);
      if (g && r.states?.[a]) { g.state = r.states[a]; if (a === S.cur) renderAll(); }
      toast(`${g?.name || a}: 保留していた変更をゲームの設定に反映しました`, 'ok');
    }
    const running = r.running.filter(id => id !== r.ours);
    if (S.steam.connected && r.ours !== S.steam.appid) { S.steam.connected = false; renderSteam(); renderDetail(); }
    if (running.join() !== S.running.join()) {
      const wasCur = isRunning(S.cur); S.running = running;
      // 遊んでいたゲームが終了したら連携を再開
      if (wasCur && !isRunning(S.cur) && queuedUpdates[S.cur]?.size) runQueuedUpdates(S.cur);
      else if (wasCur && !isRunning(S.cur) && prefs.steamAlways && !S.steam.connected) steamConnect(true);
      if (wasCur && !isRunning(S.cur)) gameRead(game());
      renderGames(); renderPlay(); renderSteam();
    }
  } catch { /* ignore */ }
  setTimeout(pollRunning, 4000);
}
// 初期化（実行中のゲームを確認してから読み込む）は features.js の最後で行う
