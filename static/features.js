'use strict';
/* 追加機能: 前提MOD / バックアップ / ワークショップ検索 / お掃除 / 複数選択 / 元に戻す / 差分 /
   更新予約の保存 / 更新履歴 / ツールの更新確認 / Windows通知   （app.js のあとに読み込む） */

S.deps = {};        // appid -> { wid: {provides, requires, requiresItems, missing} }
S.backups = {};     // wid -> [版]
S.changelog = {};   // wid -> [{time, text}] | 'loading' | {error}
const fprefs = JSON.parse(localStorage.getItem('wsm-features') || '{}');
const saveFprefs = () => localStorage.setItem('wsm-features', JSON.stringify(fprefs));
fprefs.autoBackup ??= true;
fprefs.notify ??= true;

// ======================================================== ゲーム表示時
function onGameShown(g) {
  if (!g) return;
  loadDeps(g);
  setTimeout(() => autoBackup(g), 3000);
}

// ======================================================== #6 スイッチの説明
function toggleHint(g) {
  if (gameSyncOn(g)) return 'ゲーム内のMOD設定に反映されます';
  if (steamSync(g) && S.steam.supports?.disable) return 'Steam のローカル無効化に反映されます';
  if (g.state.deploy?.path) return 'デプロイ時に反映されます';
  return 'このツール内の管理のみ（プロファイル・デプロイで使用）';
}

// ======================================================== #1 前提MOD / #12 依存順
async function loadDeps(g) {
  try {
    const r = await api('deps', { appid: g.appid });
    S.deps[g.appid] = r.supported ? r.graph : null;
    $('#btn-autosort').classList.toggle('hidden', !r.supported);
    if (S.cur === g.appid) { renderItems(); renderDetail(); }
  } catch { /* 前提情報が無くても続行 */ }
}
const depInfo = (g, id) => S.deps[g.appid]?.[id];
const dependentsOf = (g, id) => Object.entries(S.deps[g.appid] || {}).filter(([, d]) => d.requiresItems.includes(id)).map(([w]) => w);
const itemOn = (g, id) => isOn(g, id) && g.items.some(i => i.id === id && i.installed);

function depProblems(g, it) {
  const d = depInfo(g, it.id); if (!d || !isOn(g, it.id)) return null;
  const off = d.requiresItems.filter(w => !itemOn(g, w));
  return off.length || d.missing.length ? { off, missing: d.missing } : null;
}
function depBadge(g, it) {
  const p = depProblems(g, it); if (!p) return '';
  const names = [...p.off.map(w => titleOf({ id: w })), ...p.missing];
  return `<span class="badge dep" title="前提MODが${p.off.length ? '無効' : '見つかりません'}: ${esc(names.join(', '))}">⚠ 前提${p.off.length ? 'OFF' : '不足'}</span>`;
}
// 有効にするときは前提も有効に、無効にするときは依存しているMODも一緒に無効にするか確認
function resolveDeps(g, ids, on) {
  if (!S.deps[g.appid]) return ids;
  const set = new Set(ids);
  if (on) {
    const stack = [...ids];
    while (stack.length) {
      const d = depInfo(g, stack.pop()); if (!d) continue;
      for (const w of d.requiresItems) if (!set.has(w) && !isOn(g, w)) { set.add(w); stack.push(w); }
    }
    const added = [...set].filter(id => !ids.includes(id));
    if (added.length) toast(`前提MOD ${added.length} 件も有効にしました: ${added.map(id => titleOf({ id })).join('、')}`);
    return [...set];
  }
  const extra = new Set(); const stack = [...ids];
  while (stack.length) {
    for (const w of dependentsOf(g, stack.pop())) if (!set.has(w) && !extra.has(w) && isOn(g, w)) { extra.add(w); stack.push(w); }
  }
  if (!extra.size) return ids;
  const names = [...extra].map(id => '・' + titleOf({ id })).slice(0, 12).join('\n');
  if (confirm(`次の ${extra.size} 件のMODがこのMODを必要としています。\n${names}\n\n[OK] 一緒に無効にする　[キャンセル] このMODだけ無効にする`)) return [...set, ...extra];
  return ids;
}
// 前提が先に来るように並べる（それ以外は今の順番を保つ）
function depSortedOrder(g) {
  const order = orderedIds(g); const graph = S.deps[g.appid] || {};
  const out = []; const done = new Set(); const visiting = new Set();
  const visit = id => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const w of (graph[id]?.requiresItems || [])) if (order.includes(w)) visit(w);
    visiting.delete(id); done.add(id); out.push(id);
  };
  order.forEach(visit);
  return out;
}
async function autoSortByDeps() {
  const g = game(); if (!S.deps[g.appid]) return;
  const order = depSortedOrder(g);
  const moved = order.filter((id, n) => orderedIds(g)[n] !== id).length;
  if (!moved) { toast('既に前提MODが先に来る順番になっています', 'ok'); return; }
  pushUndo(g, '依存順に整列');
  await saveState({ order, orderCustom: true });
  if (S.sort !== 'order') { S.sort = 'order'; savePrefs(); }
  renderAll(); gameWrite(g);
  if (steamSync(g)) pushSteam(g);
  toast(`前提MODが先に来るように並べ替えました（${moved} 件移動）`, 'ok');
}

// ======================================================== #10 元に戻す
const undoStack = [];
function pushUndo(g, label) {
  undoStack.push({ appid: g.appid, label, disabled: [...g.state.disabled], order: [...g.state.order], orderCustom: !!g.state.orderCustom });
  if (undoStack.length > 30) undoStack.shift();
  renderUndo();
}
function renderUndo() {
  const b = $('#btn-undo'); const last = undoStack[undoStack.length - 1];
  b.disabled = !last; b.title = last ? `元に戻す: ${last.label}（Ctrl+Z）` : '元に戻す操作はありません';
}
async function undo() {
  const u = undoStack.pop(); renderUndo(); if (!u) return;
  const g = S.games.find(x => x.appid === u.appid); if (!g) return;
  if (S.cur !== u.appid) { S.cur = u.appid; savePrefs(); }
  try {
    const d = await api('update', { appid: g.appid, disabled: u.disabled, order: u.order, orderCustom: u.orderCustom });
    g.state = d.state; renderAll(); gameWrite(g);
    if (steamSync(g)) pushSteam(g);
    toast(`元に戻しました: ${u.label}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ======================================================== #7 複数選択
let anchor = null;
function selectFromClick(id, e) {
  const g = game();
  if (e.shiftKey && (anchor || S.sel)) {
    const ids = visibleItems(g).list.map(i => i.id);
    const a = ids.indexOf(anchor || S.sel), b = ids.indexOf(id);
    if (!e.ctrlKey) S.multi.clear();
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => S.multi.add(x));
  } else if (e.ctrlKey || e.metaKey) {
    if (!S.multi.size && S.sel) S.multi.add(S.sel);
    S.multi.has(id) ? S.multi.delete(id) : S.multi.add(id);
    anchor = id;
  } else { S.multi.clear(); anchor = id; }
  select(id);
}
function renderSelbar() {
  const bar = $('#selbar'); const n = S.multi.size;
  bar.classList.toggle('hidden', n < 2);
  if (n < 2) return;
  const g = game(); const ids = [...S.multi];
  const upd = g.items.filter(i => S.multi.has(i.id) && hasUpdate(i)).length;
  bar.innerHTML = `<b>${n} 件を選択中</b>
    <button class="primary small" data-sb="on">有効にする</button>
    <button class="ghost small" data-sb="off">無効にする</button>
    ${upd ? `<button class="primary small" data-sb="update">⬇ 更新 (${upd})</button>` : ''}
    <button class="ghost small" data-sb="backup">バックアップ</button>
    <button class="danger small" data-sb="unsub">購読解除</button>
    <button class="ghost small" data-sb="clear">選択解除 (Esc)</button>
    <span class="hint">Ctrl+クリックで追加 / Shift+クリックで範囲選択 / ${fmtSize(ids.reduce((a, id) => a + (g.items.find(i => i.id === id)?.size || 0), 0))}</span>`;
}
$('#selbar').addEventListener('click', async e => {
  const a = e.target.closest('[data-sb]')?.dataset.sb; if (!a) return;
  const g = game(); const ids = [...S.multi];
  if (a === 'on') setEnabled(ids, true);
  if (a === 'off') setEnabled(ids, false);
  if (a === 'update') updateMods(g.items.filter(i => S.multi.has(i.id) && hasUpdate(i)).map(i => i.id));
  if (a === 'backup') { const r = await api('backup/create', { appid: g.appid, ids: ids.filter(id => g.items.find(i => i.id === id)?.installed) }).catch(err => toast(err.message, 'err')); if (r) toast(`${r.created.length} 件をバックアップしました（同じ版は省略）`, 'ok'); S.backups = {}; renderDetail(); }
  if (a === 'unsub' && confirm(`${ids.length} 件の購読を解除しますか？\nSteam がファイルを削除します。`)) { if (await steamAction('unsubscribe', ids)) toast(`${ids.length} 件の購読を解除しました`, 'ok'); }
  if (a === 'clear') { S.multi.clear(); renderItems(); }
});

// ======================================================== #2 バックアップ
const backedUp = new Set();  // このセッションで自動バックアップ済み
async function backupBeforeUpdate(g, ids) {
  const targets = ids.filter(id => g.items.find(i => i.id === id)?.installed);
  if (!targets.length) return;
  try {
    const r = await api('backup/create', { appid: g.appid, ids: targets, reason: 'before-update' });
    targets.forEach(id => backedUp.add(id)); delete S.backups[targets[0]];
    if (r.created.length) toast(`更新前に ${r.created.length} 件をバックアップしました`, 'ok');
  } catch (e) { toast('バックアップに失敗しました（更新は続けます）: ' + e.message, 'err'); }
}
// 更新が見つかったら、Steam が自動で更新してしまう前に今の版を保存しておく
async function autoBackup(g) {
  if (!fprefs.autoBackup || !g || S.cur !== g.appid) return;
  const ids = updatable(g).map(i => i.id).filter(id => !backedUp.has(id));
  if (!ids.length) return;
  ids.forEach(id => backedUp.add(id));
  try {
    const r = await api('backup/create', { appid: g.appid, ids, reason: 'auto' });
    if (r.created.length) toast(`更新のある ${r.created.length} 件の今の版を自動でバックアップしました`);
  } catch { /* 次回 */ }
}
async function loadBackups(g, id) {
  try { S.backups[id] = (await api('backup/list', { appid: g.appid, id })).items; } catch { S.backups[id] = []; }
  if (S.sel === id) renderDetail();
}
const REASONS = { manual: '手動', auto: '自動', 'before-update': '更新前', 'before-restore': '復元前' };

// ======================================================== #11 更新履歴
async function loadChangelog(id) {
  S.changelog[id] = 'loading';
  try { S.changelog[id] = (await api('changelog', { id })).entries; } catch (e) { S.changelog[id] = { error: e.message }; }
  if (S.sel === id) renderDetail();
}

// ======================================================== 詳細パネルの追加分
function detailExtras(g, it) {
  const parts = [];
  // 前提MOD
  const d = depInfo(g, it.id);
  if (d) {
    const req = d.requiresItems.map(w => `<li class="${itemOn(g, w) ? 'ok' : 'bad'}" data-goto="${w}">${itemOn(g, w) ? '✓' : '✗'} ${esc(titleOf({ id: w }))}${itemOn(g, w) ? '' : '（無効）'}</li>`)
      .concat(d.missing.map(mid => `<li class="bad">✗ ${esc(mid)}（見つかりません）</li>`));
    const users = dependentsOf(g, it.id);
    parts.push(`<div class="sect-box"><div class="sect-title">前提MOD</div>
      ${req.length ? `<ul class="deplist">${req.join('')}</ul>` : '<p class="hint">前提MODはありません</p>'}
      ${users.length ? `<div class="sect-title" style="margin-top:8px">このMODを必要とするMOD（${users.length}）</div><ul class="deplist">${users.map(w => `<li data-goto="${w}" class="${isOn(g, w) ? '' : 'muted'}">${esc(titleOf({ id: w }))}${isOn(g, w) ? '' : '（無効）'}</li>`).join('')}</ul>` : ''}</div>`);
  }
  // 更新履歴
  const cl = S.changelog[it.id];
  let clHtml = `<button class="ghost small" data-x="changelog">📝 更新履歴を表示</button>`;
  if (cl === 'loading') clHtml = '<p class="hint">読み込み中…</p>';
  else if (cl?.error) clHtml = `<p class="hint">取得できませんでした: ${esc(cl.error)}</p>`;
  else if (Array.isArray(cl)) {
    clHtml = cl.length ? `<ul class="changelog">${cl.slice(0, 8).map(e => `<li class="${it.timeupdated && e.time > it.timeupdated + 60 ? 'new' : ''}">
      <b>${new Date(e.time * 1000).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}${it.timeupdated && e.time > it.timeupdated + 60 ? ' <span class="badge update">未適用</span>' : ''}</b>
      <div>${esc(e.text || '（説明なし）')}</div></li>`).join('')}</ul>` : '<p class="hint">更新履歴はありません</p>';
  }
  parts.push(`<div class="sect-box"><div class="sect-title">更新履歴 <a href="#" data-x="changelog-web" class="mini">Steamで見る</a></div>${clHtml}</div>`);
  // バックアップ
  const bk = S.backups[it.id];
  const rows = Array.isArray(bk) ? (bk.length ? bk.map(v => `<li>
      <span>${new Date((v.timeupdated || v.created) * 1000).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })} の版
        <small>${fmtSize(v.size)}・${REASONS[v.reason] || v.reason}${String(v.timeupdated) === String(it.timeupdated) ? '・今の版' : ''}</small></span>
      <span><button class="primary small" data-restore="${v.key}" ${String(v.timeupdated) === String(it.timeupdated) ? 'disabled' : ''}>この版に戻す</button>
      <button class="ghost small" data-bdel="${v.key}" title="バックアップを削除">✕</button></span></li>`).join('')
    : '<li class="hint">バックアップはありません</li>') : '<li class="hint">読み込み中…</li>';
  parts.push(`<div class="sect-box"><div class="sect-title">バックアップ <button class="ghost small" data-x="backup" ${it.installed ? '' : 'disabled'}>今の版を保存</button></div>
    <ul class="bklist">${rows}</ul><p class="hint">更新する前と、更新が見つかったときに自動で保存します（1件につき最新 3 版）。</p></div>`);
  return parts.join('');
}
function afterDetail(g, it) {
  if (!(it.id in S.backups)) { S.backups[it.id] = null; loadBackups(g, it.id); }
  if (hasUpdate(it) && !(it.id in S.changelog)) loadChangelog(it.id);
}
$('#tab-info').addEventListener('click', async e => {
  const g = game(); const it = g?.items.find(i => i.id === S.sel); if (!it) return;
  const go = e.target.closest('[data-goto]'); if (go) { select(go.dataset.goto); $('.item.sel')?.scrollIntoView({ block: 'nearest' }); return; }
  const x = e.target.closest('[data-x]')?.dataset.x;
  if (x === 'changelog') loadChangelog(it.id);
  if (x === 'changelog-web') { e.preventDefault(); openTarget(`https://steamcommunity.com/sharedfiles/filedetails/changelog/${it.id}`); }
  if (x === 'backup') {
    try { const r = await api('backup/create', { appid: g.appid, ids: [it.id], reason: 'manual' }); toast(r.created.length ? 'バックアップしました' : 'この版は既にバックアップ済みです', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    loadBackups(g, it.id);
  }
  const rs = e.target.closest('[data-restore]')?.dataset.restore;
  if (rs) {
    if (isRunning(g.appid)) { toast('ゲームの実行中は戻せません。ゲームを終了してください', 'err'); return; }
    if (!confirm(`「${titleOf(it)}」をこの版に戻しますか？\n今の版もバックアップしてから戻します。\n※ Steam が後で最新版に更新し直すことがあります。`)) return;
    try { await api('backup/restore', { appid: g.appid, id: it.id, key: rs }); toast('バックアップから戻しました', 'ok'); delete S.backups[it.id]; await load(); }
    catch (err) { toast('戻せませんでした: ' + err.message, 'err'); }
  }
  const bd = e.target.closest('[data-bdel]')?.dataset.bdel;
  if (bd && confirm('このバックアップを削除しますか？（元に戻せません）')) {
    try { await api('backup/delete', { appid: g.appid, id: it.id, key: bd }); loadBackups(g, it.id); } catch (err) { toast(err.message, 'err'); }
  }
});

// ======================================================== #8 プロファイルの差分
function profileDiff(g, name) {
  const p = g.state.profiles[name]; const mods = profileMods(g, p);
  const inProfile = new Map(mods.map(m => [m.id, m.enabled]));
  const turnOn = [], turnOff = [], missing = [];
  for (const m of mods) {
    const have = g.items.some(i => i.id === m.id && i.installed);
    if (m.enabled && !have) missing.push(m.id);
    else if (m.enabled && have && !isOn(g, m.id)) turnOn.push(m.id);
    else if (!m.enabled && isOn(g, m.id) && have) turnOff.push(m.id);
  }
  g.items.forEach(i => { if (!inProfile.has(i.id) && isOn(g, i.id)) turnOff.push(i.id); });  // プロファイルに無いものは無効になる
  const cur = orderedIds(g).filter(id => inProfile.has(id)); const want = mods.map(m => m.id).filter(id => cur.includes(id));
  const orderChanged = p.customOrder && cur.join() !== want.join();
  return { turnOn, turnOff, missing, orderChanged };
}
function showDiff(g, name) {
  const d = profileDiff(g, name);
  const list = (ids, cls) => ids.map(id => `<li class="${cls}">${esc(titleOf({ id }))}</li>`).join('');
  const none = !d.turnOn.length && !d.turnOff.length && !d.missing.length && !d.orderChanged;
  $('#diff-title').textContent = `「${name}」と今の状態の比較`;
  $('#diff-body').innerHTML = none ? '<p>今の状態と同じです。適用しても何も変わりません。</p>' : `
    ${d.turnOn.length ? `<div class="sect-title">有効になる（${d.turnOn.length}）</div><ul class="difflist">${list(d.turnOn, 'on')}</ul>` : ''}
    ${d.turnOff.length ? `<div class="sect-title">無効になる（${d.turnOff.length}）</div><ul class="difflist">${list(d.turnOff, 'off')}</ul>` : ''}
    ${d.missing.length ? `<div class="sect-title">インストールされていない（${d.missing.length}）</div><ul class="difflist">${list(d.missing, 'miss')}</ul><p class="hint">適用後に「まとめて購読」できます。</p>` : ''}
    ${d.orderChanged ? '<p class="hint">ロード順も変わります。</p>' : ''}`;
  $('#diff-apply').dataset.name = name;
  $('#diff-modal').classList.remove('hidden');
}
$('#diff-modal').addEventListener('click', e => {
  if (e.target.id === 'diff-modal' || e.target.closest('[data-close]')) $('#diff-modal').classList.add('hidden');
});
$('#diff-apply').onclick = () => {
  const g = game(); const name = $('#diff-apply').dataset.name;
  $('#diff-modal').classList.add('hidden');
  profile('apply', name, { current: g.items.map(i => i.id) });
};

// ======================================================== #9 更新予約の保存
function saveQueue() {
  localStorage.setItem('wsm-queue', JSON.stringify(Object.fromEntries(Object.entries(queuedUpdates).map(([a, s]) => [a, [...s]]))));
}
function restoreQueue() {
  try {
    const q = JSON.parse(localStorage.getItem('wsm-queue') || '{}');
    for (const [a, ids] of Object.entries(q)) if (ids.length) queuedUpdates[a] = new Set(ids);
  } catch { /* ignore */ }
}
// 起動時: 予約したゲームがもう終了していれば更新を始める
function runPendingQueue() {
  const a = S.cur;
  if (a && queuedUpdates[a]?.size && !isRunning(a)) runQueuedUpdates(a);
}

// ======================================================== #4 ワークショップ検索
const search = { page: 1, ids: [], total: 0, busy: false };
function openSearch() {
  const g = game(); if (!g) return;
  $('#ws-title').textContent = `${g.name} のワークショップを探す`;
  $('#search-modal').classList.remove('hidden');
  if (!search.ids.length || search.appid !== g.appid) runSearch(true);
  $('#ws-q').focus();
}
async function runSearch(reset) {
  const g = game(); if (!g || search.busy) return;
  if (isRunning(g.appid)) { $('#ws-results').innerHTML = '<p class="hint">ゲームの実行中は検索できません（Steam 連携を一時停止しています）。ゲームを終了してから使ってください。</p>'; return; }
  if (reset) { search.page = 1; search.ids = []; search.appid = g.appid; $('#ws-results').innerHTML = '<p class="hint">検索中…</p>'; }
  search.busy = true; $('#ws-more').disabled = true;
  try {
    const r = await api('steam/search', { appid: g.appid, text: $('#ws-q').value.trim(), sort: $('#ws-sort').value, page: search.page });
    Object.assign(S.meta, r.meta); search.total = r.total;
    search.ids.push(...r.ids.filter(id => !search.ids.includes(id)));
    renderSearch();
  } catch (e) { $('#ws-results').innerHTML = `<p class="hint">検索できませんでした: ${esc(e.message)}</p>`; }
  finally { search.busy = false; $('#ws-more').disabled = false; }
}
function renderSearch() {
  const g = game(); const have = new Set(g.items.filter(i => !isUnsub(i)).map(i => i.id));  // 購読をやめて残っているだけのものは除く
  $('#ws-count').textContent = `${search.ids.length} / ${fmtNum(search.total)} 件`;
  $('#ws-more').classList.toggle('hidden', search.ids.length >= search.total);
  $('#ws-results').innerHTML = search.ids.map(id => {
    const m = S.meta[id] || {};
    return `<div class="ws-card">
      <img src="${esc(m.preview || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" loading="lazy" alt="">
      <div class="ws-body"><div class="title" title="${esc(m.title)}">${esc(m.title || '#' + id)}</div>
        <div class="meta-line"><span>👥 ${fmtNum(m.subscriptions)}</span><span>${fmtSize(m.file_size)}</span><span>${fmtDate(m.time_updated)}</span></div>
        <div class="row">${have.has(id) ? '<span class="badge" style="color:var(--ok);border-color:#24553c">購読済み</span>'
          : `<button class="primary small" data-wsub="${id}">購読</button>`}<button class="ghost small" data-wopen="${id}">ページ</button></div></div></div>`;
  }).join('') || '<p class="hint">見つかりませんでした</p>';
}
$('#btn-search').onclick = openSearch;
$('#ws-go').onclick = () => runSearch(true);
$('#ws-q').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(true); });
$('#ws-sort').onchange = () => runSearch(true);
$('#ws-more').onclick = () => { search.page += 1; runSearch(false); };
$('#search-modal').addEventListener('click', async e => {
  if (e.target.id === 'search-modal' || e.target.closest('[data-close]')) { $('#search-modal').classList.add('hidden'); return; }
  const o = e.target.closest('[data-wopen]'); if (o) openTarget(`steam://url/CommunityFilePage/${o.dataset.wopen}`);
  const b = e.target.closest('[data-wsub]'); if (!b) return;
  b.disabled = true;
  if (await steamAction('subscribe', [b.dataset.wsub])) { b.textContent = '購読しました'; toast('購読しました。ダウンロードを開始します', 'ok'); }
  else b.disabled = false;
});

// ======================================================== #5 お掃除
async function openCleanup() {
  const g = game(); if (!g) return;
  $('#cleanup-modal').classList.remove('hidden');
  $('#cl-body').innerHTML = '<p class="hint">確認中…</p>';
  let bk = { items: {}, total: 0 };
  try { bk = await api('backup/summary'); } catch { /* ignore */ }
  renderCleanup(g, bk);
}
function renderCleanup(g, bk) {
  const connected = true;  // 購読状態は Steam の記録ファイルから判定できる
  const leftovers = g.items.filter(i => i.installed && isUnsub(i));
  const removed = g.items.filter(i => S.meta[i.id]?.ok === false && !isUnsub(i));
  const big = [...g.items].filter(i => i.installed).sort((a, b) => b.size - a.size).slice(0, 8);
  const row = (i, extra) => `<div class="col-row"><img src="${esc(S.meta[i.id]?.preview || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'">
    <span class="t">${esc(titleOf(i))}<br><small class="hint">${fmtSize(i.size)}${isOn(g, i.id) ? '' : '・無効'}</small></span>${extra}</div>`;
  const bkItems = Object.entries(bk.items[g.appid] || {});
  const bkSize = bkItems.reduce((a, [, vs]) => a + vs.reduce((x, v) => x + (v.size || 0), 0), 0);
  $('#cl-body').innerHTML = `
    <div class="sect-title">購読していないのに残っているファイル（${connected ? leftovers.length : '?'}）</div>
    ${!connected ? `<p class="hint">${isRunning(g.appid) ? 'ゲームの実行中は判定できません。' : 'Steam に接続すると判定できます。'}</p>`
      : leftovers.length ? `<p><label class="check"><input type="checkbox" id="cl-all" checked> すべて選択</label></p>` +
        leftovers.map(i => row(i, `<input type="checkbox" class="cl-pick" value="${i.id}" checked>`)).join('') +
        `<p><button class="danger small" id="cl-delete">選んだものをごみ箱へ（${fmtSize(leftovers.reduce((a, i) => a + i.size, 0))}）</button></p>`
      : '<p class="hint">ありません 👍</p>'}
    <div class="sect-title">公開が終了したMOD（${removed.length}）</div>
    ${removed.length ? removed.map(i => row(i, `<button class="ghost small" data-clunsub="${i.id}">購読解除</button>`)).join('') : '<p class="hint">ありません 👍</p>'}
    <div class="sect-title">容量の大きいMOD</div>
    ${big.map(i => row(i, `<button class="ghost small" data-clgoto="${i.id}">表示</button>`)).join('')}
    <div class="sect-title">このゲームのバックアップ（${bkItems.length} 件・${fmtSize(bkSize)}／全体 ${fmtSize(bk.total)}）</div>
    ${bkItems.length ? bkItems.map(([w, vs]) => `<div class="col-row"><span class="t">${esc(titleOf({ id: w }))}<br><small class="hint">${vs.length} 版・${fmtSize(vs.reduce((a, v) => a + (v.size || 0), 0))}</small></span>
      <button class="ghost small" data-clbk="${w}" data-keys="${vs.map(v => v.key).join(',')}">古い版を削除</button></div>`).join('') : '<p class="hint">ありません</p>'}`;
  const all = $('#cl-all'); if (all) all.onchange = () => $$('.cl-pick').forEach(c => { c.checked = all.checked; });
}
$('#btn-cleanup').onclick = openCleanup;
$('#cleanup-modal').addEventListener('click', async e => {
  const g = game();
  if (e.target.id === 'cleanup-modal' || e.target.closest('[data-close]')) { $('#cleanup-modal').classList.add('hidden'); return; }
  if (e.target.id === 'cl-delete') {
    const ids = $$('.cl-pick').filter(c => c.checked).map(c => c.value); if (!ids.length) return;
    const size = g.items.filter(i => ids.includes(i.id)).reduce((a, i) => a + i.size, 0);
    if (!confirm(`${ids.length} 件のフォルダ（${fmtSize(size)}）をごみ箱へ移動しますか？\nごみ箱から元に戻せます。`)) return;
    try { const r = await api('cleanup/delete', { appid: g.appid, ids }); toast(`${r.deleted.length} 件をごみ箱へ移動しました`, 'ok'); await load(); openCleanup(); }
    catch (err) { toast(err.message, 'err'); }
  }
  const u = e.target.closest('[data-clunsub]')?.dataset.clunsub;
  if (u && confirm(`「${titleOf({ id: u })}」の購読を解除しますか？`)) { if (await steamAction('unsubscribe', [u])) { toast('購読を解除しました', 'ok'); e.target.disabled = true; } }
  const go = e.target.closest('[data-clgoto]')?.dataset.clgoto;
  if (go) { $('#cleanup-modal').classList.add('hidden'); select(go); $('.item.sel')?.scrollIntoView({ block: 'nearest' }); }
  const bkb = e.target.closest('[data-clbk]');
  if (bkb) {
    const keys = bkb.dataset.keys.split(',');
    const it = g.items.find(i => i.id === bkb.dataset.clbk);
    const del = keys.filter(k => !it || k !== String(it.timeupdated));  // 今の版と同じものは残す
    if (!del.length) { toast('今の版以外のバックアップはありません'); return; }
    if (!confirm(`${del.length} 件の古いバックアップを削除しますか？（元に戻せません）`)) return;
    for (const k of del) await api('backup/delete', { appid: g.appid, id: bkb.dataset.clbk, key: k }).catch(() => {});
    delete S.backups[bkb.dataset.clbk]; toast('削除しました', 'ok'); openCleanup();
  }
});

// ======================================================== #13 ツールの更新確認 / 設定
let toolUpd = null;
async function checkToolUpdate(manual = false) {
  try {
    const r = await api('tool/update');
    toolUpd = r;
    if (r.available && !S.toolInstalling) showUpdateBanner(r);
    renderToolUpdateBox();
    if (manual && r.configured && !r.available && !r.error) toast('最新のバージョンです', 'ok');
    if (manual && r.error) toast(`確認できませんでした: ${r.error}`, 'err');
  } catch { /* オフライン */ }
}
function showUpdateBanner(r) {
  $('#update-banner').innerHTML = `🎉 新しいバージョン v${esc(r.latest)} があります（今は v${esc(r.current)}）
    ${r.canInstall ? '<button class="primary small" data-install-update>今すぐ更新</button>' : ''}
    <button class="${r.canInstall ? 'ghost' : 'primary'} small" data-open-update>${r.canInstall ? '変更内容' : 'ダウンロード'}</button>
    <span class="grow"></span><button class="ghost small" data-hide-banner>✕</button>`;
  $('#update-banner').classList.remove('hidden');
}
function renderToolUpdateBox() {
  const r = toolUpd, box = $('#tool-update'); if (!box || !r) return;
  box.innerHTML = !r.configured ? '更新の確認先が設定されていません'
    : r.error ? `確認できませんでした: ${esc(r.error)}`
    : r.available ? `v${esc(r.latest)} が公開されています ${r.canInstall ? '<button class="primary small" data-install-update>今すぐ更新</button>' : ''}
        <button class="ghost small" data-open-update>${r.canInstall ? '変更内容' : 'ダウンロード'}</button>`
    : `最新です（v${esc(r.current)}）`;
  $('#tool-notes').textContent = r.available && r.notes ? r.notes : '';
  $('#tool-notes').classList.toggle('hidden', !(r.available && r.notes));
}
async function installToolUpdate() {
  const r = toolUpd; if (!r?.available) return;
  const busy = Object.values(queuedUpdates).some(s => s.size);
  if (!confirm(`Workshop Manager を v${r.latest} に更新します。\n\nダウンロードが終わると、ツールは自動で再起動します。`
    + (busy ? '\n（MOD のダウンロード中です。残りは再起動後に続きから行います）' : ''))) return;
  S.toolInstalling = true;
  const bar = $('#update-banner');
  bar.classList.remove('hidden');
  const show = st => {
    const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
    bar.innerHTML = st.phase === 'download' ? `⬇ v${esc(st.version || r.latest)} をダウンロード中… ${pct}%（${fmtSize(st.done || 0)} / ${fmtSize(st.total || 0)}）`
      : st.phase === 'verify' ? '🔒 ファイルを確認しています…'
      : st.phase === 'install' ? '📦 入れ替えています…'
      : st.phase === 'restart' ? `✅ v${esc(st.version || r.latest)} に更新しました。再起動します…`
      : st.phase === 'error' ? `⚠ 更新できませんでした: ${esc(st.error)} <button class="ghost small" data-open-update>リリースページを開く</button><span class="grow"></span><button class="ghost small" data-hide-banner>✕</button>`
      : '';
  };
  try {
    show(await api('tool/install'));
    for (;;) {
      await new Promise(res => setTimeout(res, 400));
      const st = await api('tool/install/status');
      show(st);
      if (st.phase === 'error') { S.toolInstalling = false; toast(st.error, 'err'); return; }
      if (st.phase === 'restart') { localStorage.setItem('wsm-updated-to', st.version || r.latest); return; }
    }
  } catch (e) {
    S.toolInstalling = false;
    if (bar.textContent.includes('再起動')) return;  // 終了処理で通信が切れた
    show({ phase: 'error', error: e.message }); toast(e.message, 'err');
  }
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-install-update]')) { $('#settings-modal').classList.add('hidden'); installToolUpdate(); }
  else if (e.target.closest('[data-open-update]') && toolUpd?.url) openTarget(toolUpd.url);
  else if (e.target.closest('[data-hide-banner]')) $('#update-banner').classList.add('hidden');
});
(async () => {  // 更新して再起動したあとに知らせる
  const to = localStorage.getItem('wsm-updated-to'); if (!to) return;
  localStorage.removeItem('wsm-updated-to');
  const c = await api('config').catch(() => null);
  if (c?.version === to) toast(`v${to} に更新しました`, 'ok');
  else if (c) toast(`更新後のバージョンが v${c.version} のままです。もう一度お試しください`, 'err');
})();
async function openSettings() {
  const c = await api('config').catch(() => ({}));
  $('#set-version').textContent = 'v' + (c.version || '');
  $('#set-update-url').value = c.updateUrl || '';
  $('#set-update-url').placeholder = c.defaultUpdateUrl ? `空欄なら ${c.defaultUpdateUrl}` : '例: https://api.github.com/repos/<ユーザー>/<リポジトリ>/releases/latest';
  $('#set-notify').checked = !!fprefs.notify;
  $('#set-autobackup').checked = !!fprefs.autoBackup;
  $('#settings-modal').classList.remove('hidden');
  checkToolUpdate();
}
$('#btn-settings').onclick = openSettings;
$('#settings-modal').addEventListener('click', e => {
  if (e.target.id === 'settings-modal' || e.target.closest('[data-close]')) $('#settings-modal').classList.add('hidden');
});
$('#set-save').onclick = async () => {
  fprefs.notify = $('#set-notify').checked; fprefs.autoBackup = $('#set-autobackup').checked; saveFprefs();
  try { await api('config', { updateUrl: $('#set-update-url').value.trim() }); toast('設定を保存しました', 'ok'); checkToolUpdate(); }
  catch (e) { toast(e.message, 'err'); }
};
$('#set-check').onclick = () => checkToolUpdate(true);
$('#set-test-notify').onclick = () => api('notify', { title: 'Workshop Manager', text: '通知のテストです' }).catch(e => toast(e.message, 'err'));

// ======================================================== #15 MOD更新の通知
async function checkModUpdates() {
  if (!fprefs.notify) return;
  const all = S.games.flatMap(g => g.items.filter(i => i.installed && !isUnsub(i)));
  if (!all.length) return;
  try {
    for (let i = 0; i < all.length; i += 300) Object.assign(S.meta, await api('meta', { ids: all.slice(i, i + 300).map(x => x.id), force: true }));
  } catch { return; }
  const notified = JSON.parse(localStorage.getItem('wsm-notified') || '{}');
  const fresh = all.filter(i => hasUpdate(i) && notified[i.id] !== S.meta[i.id]?.time_updated);
  if (!fresh.length) { renderAll(); return; }
  fresh.forEach(i => { notified[i.id] = S.meta[i.id]?.time_updated; });
  localStorage.setItem('wsm-notified', JSON.stringify(notified));
  const names = fresh.slice(0, 3).map(i => titleOf(i)).join('、') + (fresh.length > 3 ? ` ほか ${fresh.length - 3} 件` : '');
  api('notify', { title: `MODの更新が ${fresh.length} 件あります`, text: names }).catch(() => {});
  toast(`MODの更新が ${fresh.length} 件あります: ${names}`);
  renderAll();
  autoBackup(game());
}

// ======================================================== その他のイベント
$('#btn-undo').onclick = undo;
$('#btn-autosort').onclick = autoSortByDeps;
document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (e.ctrlKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'a' && !typing) {
    e.preventDefault(); const g = game(); if (!g) return;
    visibleItems(g).list.forEach(i => S.multi.add(i.id)); renderItems();
  }
});

// ======================================================== 初期化
restoreQueue();
renderUndo();
pollRunning().finally(async () => {
  await load();
  runPendingQueue();
  setTimeout(checkToolUpdate, 4000);
  setTimeout(checkModUpdates, 60 * 1000);
  setInterval(checkModUpdates, 30 * 60 * 1000);
});
