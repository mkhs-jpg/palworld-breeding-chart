// パル配合ルート検索 メインロジック
// breeding.js の findBreedingRoute / findBreedingCombos を利用する

const LS_KEYS = {
  pals: "pbh_pals_data",
  owned: "pbh_owned_ids",
  pinned: "pbh_pinned_ids",
  excluded: "pbh_excluded_ids",
  ghToken: "pbh_github_token",
  palSkills: "pbh_pal_skills"
};

// GitHub連携(手持ちデータのバックアップ)の保存先。
// 公開ページ(main)とは別のuserdataブランチに保存することで、ローカルからのmainへのpushと
// 競合せず、ビルドスクリプト(build-data.js)の複製対象とも干渉しない。
const GH_SYNC = {
  repo: "mkhs-jpg/palworld-breeding-chart",
  path: "userdata.json",
  branch: "userdata"
};
const DATA_VERSION = 19; // pals-data.jsonのversionと一致させる。同梱データを更新したら上げる

let PALS = [];
let BREEDING_EXAMPLES = {};
let SKILLS = []; // パッシブスキル一覧(出典: skills-data.json、gamewith.jp)。{id, name, category, effect}
// 所持パルごとにタグ付けした「持たせているパッシブスキル」({ [palId]: number[](スキルid) })。
// ゲーム内の個体固有情報でありwikiデータからは分からないため、ユーザーが手動でタグ付けする。
let palSkills = {};
let selectedSkillIds = []; // スキル継承タブで選択中のスキルid配列(複数選択可、未選択は空配列)
let selectedMultiTargetIds = []; // スキル継承タブ④「複数の作りたいパルをまとめて計算」で選択中のtargetパルid配列
// スキル継承タブ③の「作りたいパル」選択・並び順は、配合ルート検索タブの③(selectedTargetId/targetSortMode)
// とは独立させている(ユーザー要望: 2つの機能を混同しないようにしたい)。①②のスキル候補も
// requiredPalIds(配合ルート検索タブの②)には書き込まない。
let skillTargetId = null;
let skillTargetSortMode = "aiueo";
let ownedIds = new Set();
let ownedSortMode = "aiueo"; // "aiueo" | "no"
let targetSortMode = "aiueo";
let selectedTargetId = null;
let requiredPalIds = []; // ②で指定した「必ず経由する所持パル」(複数選択可、任意、未指定は空配列)
let routeMode = "generations"; // "generations"(最短世代、既定) | "hatchtime"(孵化時間最小)
let paldexSortMode = "aiueo";
let paldexWorkSortType = null; // 指定した作業適性タイプの高い順に並べる(未指定はnull、あいうえお順/図鑑No順を優先)
let paldexOwnedOnly = false; // trueなら所持パルだけに絞り込む
let comboParentId = null; // 総当り配合タブで親として選択中の所持パル(未選択はnull)
let comboNewOnly = false; // trueなら「持っていない子パル」だけを表示

// ピン留めした「作りたいパル」のid一覧(順序=ピン留めした順)。localStorageに永続化する。
// ピン留め中のパルは①(所持パル)や②(経由必須パル)を変更するたびに現在の設定でライブ再計算され、
// 結果カルーセル(横スワイプ)の先頭に常に表示され続ける(計算履歴のように追い出されない)。
let pinnedIds = [];

// ピン留めルートの計算結果キャッシュ(palId -> {signature, route})。
// renderCarousel()は他の操作(パル図鑑の並び替え等、本来ルート計算に無関係な操作)でも
// 頻繁に呼ばれるため、①②③や探索方法や除外設定が実際に変わっていない限りは
// 「何も操作していないのに結果が変わって見える」ことが絶対に起きないよう、
// 直前と同じ条件(signature)なら再計算せずキャッシュした結果をそのまま使う。
const pinnedRouteCache = new Map();
function computeRouteSignature(targetPal) {
  const ownedKey = [...ownedIds].sort((a, b) => a - b).join(",");
  const excludedKey = [...excludedIds].sort((a, b) => a - b).join(",");
  const requiredKey = [...requiredPalIds].sort((a, b) => a - b).join(",");
  return `${targetPal.id}|${ownedKey}|${excludedKey}|${requiredKey}|${routeMode}`;
}

// 「今は配合に使えない」として除外中のパルid(性別が合わない等、実機で判明した一時的な制約)。
// localStorageに永続化し、以後の全ての計算(①②の変更、ピン留めのライブ再計算含む)で
// 所持パルの候補から取り除かれる。①のチェック自体は外さない(所持していないことにはしない)。
let excludedIds = new Set();

// 計算結果のスワイプ履歴(①②③で計算した「作りたいパル」の結果を最大件数分さかのぼれる)
const MAX_HISTORY = 5;
let resultHistory = []; // [{ targetPal, route, ownedIdSet, requiredIds }]
let historyCursor = -1; // resultHistory内の現在位置(戻ってから分岐した場合の切り捨てに使う)
let activeTargetId = null; // 現在カルーセルで表示中のパルid(ピン留め有無に関わらずこのidの位置を追従表示する)
let currentSlideIndex = -1; // 直近renderCarousel()時点でのlastSlides配列上の表示位置
let lastSlides = []; // 直近renderCarousel()で実際に描画したスライドの配列(ナビ操作やコピー/ピン操作から参照する)
let transientMessage = null; // 計算ボタン誤操作時などの単発案内メッセージ(セットされている間は先頭スライドとして表示)

// 作業適性タイプの英語キー→日本語表示名。wikiのwork_suitabilityフィールドの表記に合わせる。
const WORK_TYPE_JA = {
  "Kindling": "火おこし",
  "Watering": "水やり",
  "Planting": "種まき",
  "Generating Electricity": "発電",
  "Handiwork": "手作業",
  "Gathering": "採集",
  "Lumbering": "伐採",
  "Mining": "採掘",
  "Medicine Production": "製薬",
  "Cooling": "冷却",
  "Transporting": "運搬",
  "Farming": "牧場"
};

// タマゴサイズの英語キー→日本語表示名。
const EGG_SIZE_JA = { "Normal": "普通", "Large": "デカ", "Huge": "キョダイ" };

// 孵化時間(breeding.jsのEGG_HATCH_HOURS、時間単位の小数)を「◯時間◯分」形式の読みやすい表記に変換する。
function formatHatchHours(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

init();

function init() {
  loadPalsData().then(() => {
    loadOwned();
    loadPinned();
    loadExcluded();
    loadPalSkills();
    renderTargetSelect();
    renderSkillTargetToggleList();
    renderSkillTagFilterRow();
    renderSkillToggleList();
    renderOwnedToggleList();
    renderRequiredToggleList();
    renderPaldexList();
    renderCarousel();
    updateExcludedIndicator();
    bindEvents();
  });
}

// データはdata.js(自動生成、EMBEDDED_PALS_DATA / EMBEDDED_BREEDING_EXAMPLES)から読み込む。
// サーバーを立てずにindex.htmlをダブルクリックで開いても動くよう、fetchではなく
// <script>で先読みしたJS変数を直接参照する方式にしている。
function loadPalsData() {
  const saved = localStorage.getItem(LS_KEYS.pals);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.version === DATA_VERSION) {
        PALS = parsed.pals;
        BREEDING_EXAMPLES = (typeof EMBEDDED_BREEDING_EXAMPLES !== "undefined") ? EMBEDDED_BREEDING_EXAMPLES : {};
        return Promise.resolve();
      }
    } catch (e) { /* fallthrough to embedded data */ }
  }

  PALS = EMBEDDED_PALS_DATA.pals;
  BREEDING_EXAMPLES = (typeof EMBEDDED_BREEDING_EXAMPLES !== "undefined") ? EMBEDDED_BREEDING_EXAMPLES : {};
  localStorage.setItem(LS_KEYS.pals, JSON.stringify({ version: DATA_VERSION, pals: PALS }));
  return Promise.resolve();
}

function loadPalSkills() {
  SKILLS = (typeof EMBEDDED_SKILLS_DATA !== "undefined") ? EMBEDDED_SKILLS_DATA.skills : [];
  const saved = localStorage.getItem(LS_KEYS.palSkills);
  if (saved) {
    try {
      palSkills = JSON.parse(saved);
    } catch (e) {
      palSkills = {};
    }
  }
}

function savePalSkills() {
  localStorage.setItem(LS_KEYS.palSkills, JSON.stringify(palSkills));
}

function loadOwned() {
  const saved = localStorage.getItem(LS_KEYS.owned);
  if (saved) ownedIds = new Set(JSON.parse(saved));
}

function saveOwned() {
  localStorage.setItem(LS_KEYS.owned, JSON.stringify([...ownedIds]));
}

function loadPinned() {
  const saved = localStorage.getItem(LS_KEYS.pinned);
  if (saved) {
    try {
      pinnedIds = JSON.parse(saved);
    } catch (e) {
      pinnedIds = [];
    }
  }
}

function savePinned() {
  localStorage.setItem(LS_KEYS.pinned, JSON.stringify(pinnedIds));
}

// ピン留め状態を切り替え、③選択リストと結果カルーセルの両方を最新化する。
// ピン留めした瞬間は、いま画面に表示されているルートをそのままキャッシュへ引き継ぐ。
// これが無いと、「あるモードで計算→モード切替(履歴はスナップショット表示のまま)→ピン留め」の
// 手順で、ピン留めスライドが現在のモードで新規計算され、同じパルの履歴スライドと入れ替わる形で
// 表示中のルートが突然変わってしまう(2026-07に実際に報告されたバグの根本原因)。
function togglePinned(id) {
  const idx = pinnedIds.indexOf(id);
  if (idx === -1) {
    pinnedIds.push(id);
    const displayed = lastSlides.find(s => s.targetPal && s.targetPal.id === id && s.route);
    if (displayed) {
      const targetPal = PALS.find(p => p.id === id);
      if (targetPal) pinnedRouteCache.set(id, { signature: computeRouteSignature(targetPal), route: displayed.route });
    }
  } else {
    pinnedIds.splice(idx, 1);
    pinnedRouteCache.delete(id);
  }
  savePinned();
  transientMessage = null;
  renderTargetSelect(document.getElementById("targetSearch").value);
  renderCarousel();
}

function loadExcluded() {
  const saved = localStorage.getItem(LS_KEYS.excluded);
  if (saved) {
    try {
      excludedIds = new Set(JSON.parse(saved));
    } catch (e) {
      excludedIds = new Set();
    }
  }
}

function saveExcluded() {
  localStorage.setItem(LS_KEYS.excluded, JSON.stringify([...excludedIds]));
}

function updateExcludedIndicator() {
  const el = document.getElementById("excludedIndicator");
  if (!el) return;
  if (excludedIds.size === 0) {
    el.innerHTML = "";
    return;
  }
  const names = [...excludedIds].map(id => { const p = PALS.find(x => x.id === id); return p ? p.name : null; }).filter(Boolean);
  el.innerHTML = `除外中(今は使えない): ${names.join("、")} <button type="button" class="secondary" id="clearExcludedBtn" style="padding:2px 10px; font-size:0.8rem;">解除</button>`;
  document.getElementById("clearExcludedBtn").addEventListener("click", clearExcluded);
}

function clearExcluded() {
  excludedIds.clear();
  saveExcluded();
  updateExcludedIndicator();
  renderCarousel();
}

// ---------- GitHub連携(手持ちデータのバックアップ・別端末との同期) ----------
// Fine-grained PAT(このリポジトリ限定・Contents読み書きのみ)をユーザーが一度入力すると
// 「管理者モード」になり、userdataブランチのuserdata.jsonへ保存/読み込みできる。
// トークンはlocalStorageにのみ保存し、外部には送信しない(GitHub API呼び出しを除く)。

function getGhToken() {
  return localStorage.getItem(LS_KEYS.ghToken) || "";
}

function setGhToken(token) {
  if (token) localStorage.setItem(LS_KEYS.ghToken, token);
  else localStorage.removeItem(LS_KEYS.ghToken);
  updateSyncUi();
}

function setSyncStatus(msg, isError = false) {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "var(--status-critical)" : "var(--ink-secondary)";
}

function updateSyncUi() {
  const hasToken = !!getGhToken();
  document.getElementById("syncSetup").style.display = hasToken ? "none" : "";
  document.getElementById("syncActions").style.display = hasToken ? "" : "none";
}

function ghHeaders(token) {
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github+json"
  };
}

// UTF-8安全なbase64エンコード/デコード(データはid数値のみだが将来の拡張に備える)
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghSave() {
  const token = getGhToken();
  if (!token) return;
  setSyncStatus("保存中...");
  const api = `https://api.github.com/repos/${GH_SYNC.repo}/contents/${GH_SYNC.path}`;
  try {
    // 既存ファイルのsha取得(更新時に必要。無ければ新規作成)
    let sha = null;
    const getRes = await fetch(`${api}?ref=${GH_SYNC.branch}`, { headers: ghHeaders(token) });
    if (getRes.status === 200) sha = (await getRes.json()).sha;
    else if (getRes.status === 401 || getRes.status === 403) { setSyncStatus("トークンが無効か権限不足です。連携解除して再設定してください。", true); return; }

    const payload = {
      version: 2,
      savedAt: new Date().toISOString(),
      owned: [...ownedIds],
      pinned: pinnedIds,
      excluded: [...excludedIds],
      palSkills
    };
    const body = {
      message: "userdata: 手持ちデータを保存",
      content: toBase64(JSON.stringify(payload, null, 2)),
      branch: GH_SYNC.branch
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(api, { method: "PUT", headers: { ...ghHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (putRes.ok) {
      setSyncStatus(`保存しました(${new Date().toLocaleString("ja-JP")})`);
    } else {
      const err = await putRes.json().catch(() => ({}));
      setSyncStatus(`保存に失敗しました(${putRes.status}): ${err.message || ""}`, true);
    }
  } catch (e) {
    setSyncStatus("保存に失敗しました(通信エラー): " + e.message, true);
  }
}

async function ghLoad() {
  const token = getGhToken();
  if (!token) return;
  setSyncStatus("読み込み中...");
  const api = `https://api.github.com/repos/${GH_SYNC.repo}/contents/${GH_SYNC.path}`;
  try {
    const res = await fetch(`${api}?ref=${GH_SYNC.branch}`, { headers: ghHeaders(token) });
    if (res.status === 404) { setSyncStatus("まだ保存データがありません。先に「GitHubに保存」を実行してください。", true); return; }
    if (!res.ok) { setSyncStatus(`読み込みに失敗しました(${res.status})`, true); return; }
    const json = await res.json();
    const data = JSON.parse(fromBase64(json.content));

    ownedIds = new Set(data.owned || []);
    pinnedIds.length = 0;
    (data.pinned || []).forEach(id => pinnedIds.push(id));
    excludedIds = new Set(data.excluded || []);
    palSkills = data.palSkills || {};
    requiredPalIds = requiredPalIds.filter(id => ownedIds.has(id));
    saveOwned();
    savePinned();
    saveExcluded();
    savePalSkills();
    pinnedRouteCache.clear();

    renderOwnedToggleList(document.getElementById("ownedSearch").value);
    renderRequiredToggleList();
    renderTargetSelect(document.getElementById("targetSearch").value);
    renderSkillTargetToggleList(document.getElementById("skillTargetSearch") ? document.getElementById("skillTargetSearch").value : "");
    renderSkillToggleList(document.getElementById("skillSearch") ? document.getElementById("skillSearch").value : "");
    renderPaldexList(document.getElementById("paldexSearch").value);
    updateExcludedIndicator();
    renderCarousel();

    const savedAt = data.savedAt ? new Date(data.savedAt).toLocaleString("ja-JP") : "不明";
    setSyncStatus(`読み込みました(保存日時: ${savedAt}、所持${ownedIds.size}体)`);
  } catch (e) {
    setSyncStatus("読み込みに失敗しました(通信エラー): " + e.message, true);
  }
}

function bindSyncEvents() {
  document.getElementById("syncSetupToggle").addEventListener("click", () => {
    const form = document.getElementById("syncTokenForm");
    form.style.display = form.style.display === "none" ? "" : "none";
  });
  document.getElementById("syncTokenSave").addEventListener("click", () => {
    const input = document.getElementById("syncTokenInput");
    const token = input.value.trim();
    if (!token) { setSyncStatus("トークンを入力してください。", true); return; }
    setGhToken(token);
    input.value = "";
    setSyncStatus("トークンを設定しました。「GitHubに保存」でバックアップできます。");
  });
  document.getElementById("ghSaveBtn").addEventListener("click", ghSave);
  document.getElementById("ghLoadBtn").addEventListener("click", ghLoad);
  document.getElementById("ghDisconnectBtn").addEventListener("click", () => {
    setGhToken("");
    setSyncStatus("連携を解除しました(トークンをこの端末から削除しました)。");
  });
  updateSyncUi();
}

// 特定のパルを「今は配合に使えない」として除外/解除し、その文脈のターゲットパルについて
// 別ルートを再計算して履歴に積む(既存のルート探索設定(②/探索方法)はそのまま引き継ぐ)。
function toggleExcludedAndRecompute(id, targetId) {
  if (excludedIds.has(id)) excludedIds.delete(id); else excludedIds.add(id);
  saveExcluded();
  updateExcludedIndicator();

  const targetPal = PALS.find(p => p.id === targetId);
  if (!targetPal) { renderCarousel(); return; }
  const owned = PALS.filter(p => ownedIds.has(p.id));
  const route = computeRoute(targetPal, owned);
  pushHistorySlide(targetPal, route, new Set(ownedIds), [...requiredPalIds], { reset: false });
}

// paldexIdは "005B" "テラ01" "ボス01" のような文字列形式のため、
// 数値部分とバリアント/接頭辞部分に分けて自然順ソートできるようにする。
function parsePaldexId(paldexId) {
  const str = String(paldexId);
  const match = str.match(/^(\d+)(.*)$/);
  if (match) {
    return { prefixRank: 0, num: Number(match[1]), suffix: match[2] };
  }
  // "テラ01" "ボス01" 等、数値で始まらないもの(番外編)は末尾に回す
  return { prefixRank: 1, num: 0, suffix: str };
}

function sortPals(pals, mode) {
  const list = [...pals];
  if (mode === "no") {
    return list.sort((a, b) => {
      const pa = parsePaldexId(a.paldexId);
      const pb = parsePaldexId(b.paldexId);
      if (pa.prefixRank !== pb.prefixRank) return pa.prefixRank - pb.prefixRank;
      if (pa.num !== pb.num) return pa.num - pb.num;
      return pa.suffix.localeCompare(pb.suffix);
    });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function renderTargetSelect(filterText = "") {
  const list = document.getElementById("targetToggleList");
  const hidden = document.getElementById("targetPalSelect");

  let filtered = PALS;
  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    filtered = PALS.filter(p => {
      const nameKatakana = toKatakana(p.name || "");
      const nameMatch = nameKatakana.includes(query);
      const nameEnMatch = p.nameEn && p.nameEn.toLowerCase().includes(query);
      return nameMatch || nameEnMatch;
    });
  }

  const sorted = sortPals(filtered, targetSortMode);

  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${selectedTargetId === p.id ? 'on' : ''}" data-id="${p.id}">${p.name}<button type="button" class="target-pin-btn ${pinnedIds.includes(p.id) ? 'pinned' : ''}" data-pin-id="${p.id}" title="ピン留め/解除" aria-label="ピン留め">📌</button></div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".target-pin-btn")) return; // ピンボタンのクリックは選択トグルと独立させる
      const id = Number(el.dataset.id);
      // 単一選択: 同じものをクリックしたら解除、違うものなら切り替え
      if (selectedTargetId === id) {
        selectedTargetId = null;
      } else {
        selectedTargetId = id;
      }
      hidden.value = selectedTargetId || "";
      // 全トグルの表示を更新
      list.querySelectorAll(".owned-toggle").forEach(t => {
        t.classList.toggle("on", Number(t.dataset.id) === selectedTargetId);
      });
      updateTargetSelected();
    });

    const pinBtn = el.querySelector(".target-pin-btn");
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePinned(Number(pinBtn.dataset.pinId));
    });
  });

  updateTargetSelected();
}

function updateTargetSelected() {
  const el = document.getElementById("targetSelected");
  if (selectedTargetId) {
    const pal = PALS.find(p => p.id === selectedTargetId);
    el.textContent = pal ? `選択中: ${pal.name}` : "未選択";
  } else {
    el.textContent = "未選択";
  }
}

// ひらがなをカタカナに変換するユーティリティ（ひらがな検索対応用）
function toKatakana(str) {
  return str.replace(/[\u3041-\u3096]/g, function(match) {
    var chr = match.charCodeAt(0) + 0x60;
    return String.fromCharCode(chr);
  });
}

function renderOwnedToggleList(filterText = "") {
  const list = document.getElementById("ownedToggleList");
  
  let filtered = PALS;
  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    filtered = PALS.filter(p => {
      const nameKatakana = toKatakana(p.name || "");
      const nameMatch = nameKatakana.includes(query);
      const nameEnMatch = p.nameEn && p.nameEn.toLowerCase().includes(query);
      return nameMatch || nameEnMatch;
    });
  }

  const sorted = sortPals(filtered, ownedSortMode);

  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${ownedIds.has(p.id) ? "on" : ""}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (ownedIds.has(id)) ownedIds.delete(id); else ownedIds.add(id);
      saveOwned();
      el.classList.toggle("on");
      updateOwnedCount();
      // ①の所持パルが変わったら②(経由必須パル)の候補も更新し、
      // 経由必須に指定していたパルが手放されたら指定を自動解除する。
      requiredPalIds = requiredPalIds.filter(rid => ownedIds.has(rid));
      renderRequiredToggleList();
      // スキル継承タブの②(スキルを持たせている所持パル)も①の変更に追従させる
      renderSkillPalTagList();
      // ピン留めしたパルのルートは①の変更に追従してライブ再計算するため再描画する。
      renderCarousel();
    });
  });

  updateOwnedCount();
}

// ②(任意)必ず経由する所持パルの候補リスト。①で現在選ばれている所持パルだけを候補にする複数選択リスト
// (指定した中の少なくとも1匹を経路のどこかで実際に配合の親として使ったルートを探すOR条件。
// 複数選んでも全員を使う必要はない)。
function renderRequiredToggleList() {
  const list = document.getElementById("requiredToggleList");
  const owned = PALS.filter(p => ownedIds.has(p.id));
  const sorted = sortPals(owned, ownedSortMode);

  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${requiredPalIds.includes(p.id) ? "on" : ""}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (requiredPalIds.includes(id)) {
        requiredPalIds = requiredPalIds.filter(rid => rid !== id);
      } else {
        requiredPalIds = [...requiredPalIds, id];
      }
      el.classList.toggle("on", requiredPalIds.includes(id));
      updateRequiredSelected();
      // ピン留めしたパルのルートは②の変更に追従してライブ再計算するため再描画する。
      renderCarousel();
    });
  });

  updateRequiredSelected();
}

function updateRequiredSelected() {
  const el = document.getElementById("requiredSelected");
  if (requiredPalIds.length > 0) {
    const names = requiredPalIds.map(id => PALS.find(p => p.id === id)).filter(Boolean).map(p => p.name);
    el.textContent = `指定中: ${names.join("、")}`;
  } else {
    el.textContent = "未指定";
  }
}

function updateOwnedCount() {
  document.getElementById("ownedCount").textContent = `選択中: ${ownedIds.size}体`;
}

// ---------- パル図鑑 ----------

function renderPaldexList(filterText = "") {
  const list = document.getElementById("paldexList");

  let filtered = PALS;
  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    filtered = PALS.filter(p => {
      const nameKatakana = toKatakana(p.name || "");
      const nameMatch = nameKatakana.includes(query);
      const nameEnMatch = p.nameEn && p.nameEn.toLowerCase().includes(query);
      return nameMatch || nameEnMatch;
    });
  }

  if (paldexOwnedOnly) {
    filtered = filtered.filter(p => ownedIds.has(p.id));
  }

  const sorted = paldexWorkSortType
    ? sortByWorkSuitability(filtered, paldexWorkSortType)
    : sortPals(filtered, paldexSortMode);

  list.innerHTML = sorted.map(p => {
    const workHtml = (p.workSuitability && p.workSuitability.length > 0)
      ? `<div class="paldex-work-list">${p.workSuitability
          .map(w => {
            const isSorted = w.type === paldexWorkSortType;
            return `<span class="paldex-work-badge${isSorted ? " sorted" : ""}">${WORK_TYPE_JA[w.type] || w.type} Lv.${w.level}</span>`;
          })
          .join("")}</div>`
      : `<div class="paldex-work-list"><span class="paldex-work-empty">作業適性データなし</span></div>`;

    const eggHtml = p.eggSize
      ? `<span class="egg-size-badge egg-size-${p.eggSize.toLowerCase()}">🥚 ${EGG_SIZE_JA[p.eggSize]}</span>`
      : `<span class="paldex-work-empty">卵サイズ不明</span>`;

    return `
      <div class="paldex-entry" data-id="${p.id}">
        <img class="paldex-icon" src="images/pal-${p.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">
        <span class="paldex-name">${p.name}</span>
        <span class="paldex-meta">No.${p.paldexId} ${p.attribute}</span>
        <span class="paldex-stats">HP${p.hp} 攻${p.attack} 防${p.defense}</span>
        ${eggHtml}
        ${workHtml}
      </div>
    `;
  }).join("");

  list.querySelectorAll(".paldex-entry").forEach(el => {
    el.addEventListener("click", () => {
      jumpToTargetFromPaldex(Number(el.dataset.id));
    });
  });
}

// 指定した作業適性タイプのLvが高い順に並べる。データが無い/その適性を持たないパルはLv.0扱いで末尾に回る。
function getWorkLevel(pal, type) {
  if (!pal.workSuitability) return 0;
  const entry = pal.workSuitability.find(w => w.type === type);
  return entry ? entry.level : 0;
}

function sortByWorkSuitability(pals, type) {
  const list = [...pals];
  return list.sort((a, b) => {
    const diff = getWorkLevel(b, type) - getWorkLevel(a, type);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, "ja");
  });
}

function setPaldexSort(mode) {
  paldexSortMode = mode;
  paldexWorkSortType = null;
  document.getElementById("paldexWorkSort").value = "";
  document.getElementById("paldexSortAiueo").classList.toggle("on", mode === "aiueo");
  document.getElementById("paldexSortNo").classList.toggle("on", mode === "no");
  renderPaldexList(document.getElementById("paldexSearch").value);
}

function setPaldexWorkSort(type) {
  paldexWorkSortType = type || null;
  // 作業適性順を選んだら、あいうえお順/図鑑No順ボタンの見た目はどちらもオフにする(併用しない)。
  // プルダウンを「指定なし」に戻したら、元のあいうえお順/図鑑No順の見た目を復元する。
  document.getElementById("paldexSortAiueo").classList.toggle("on", !paldexWorkSortType && paldexSortMode === "aiueo");
  document.getElementById("paldexSortNo").classList.toggle("on", !paldexWorkSortType && paldexSortMode === "no");
  renderPaldexList(document.getElementById("paldexSearch").value);
}

function setPaldexOwnedOnly(checked) {
  paldexOwnedOnly = checked;
  renderPaldexList(document.getElementById("paldexSearch").value);
}

// 図鑑からパルをクリックしたら、配合ルート検索タブに切り替えて③(作りたいパル)にセットする。
// 自動計算はしない(①の所持パル選択はユーザーに委ねる)。
function jumpToTargetFromPaldex(palId) {
  selectedTargetId = palId;
  document.getElementById("targetPalSelect").value = palId;
  renderTargetSelect(document.getElementById("targetSearch").value);
  switchView("breeding");
  document.getElementById("targetSelected").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- タブ切り替え(配合ルート検索 / パル図鑑) ----------

function switchView(view) {
  const views = {
    breeding: ["breedingView", "tabBreeding"],
    paldex: ["paldexView", "tabPaldex"],
    combos: ["combosView", "tabCombos"],
    skills: ["skillsView", "tabSkills"]
  };
  for (const [key, [viewId, tabId]] of Object.entries(views)) {
    document.getElementById(viewId).style.display = key === view ? "" : "none";
    document.getElementById(tabId).classList.toggle("on", key === view);
  }
  // 総当りタブは①の所持パル変更に追従させるため、開くたびに最新の所持リストで再描画する
  if (view === "combos") {
    renderComboParentList(document.getElementById("comboParentSearch").value);
    renderComboResults();
  }
  // スキル継承タブも①の所持パル変更に追従させるため、開くたびに最新の状態で再描画する
  if (view === "skills") {
    renderSkillToggleList(document.getElementById("skillSearch").value);
    renderSkillPalTagList();
    renderSkillTargetToggleList(document.getElementById("skillTargetSearch").value);
    renderSkillMultiTargetToggleList(document.getElementById("skillMultiTargetSearch").value);
  }
}

// ---------- 総当り配合(親1匹×所持パル全員で1回の配合で作れるパル一覧) ----------

function renderComboParentList(filterText = "") {
  const list = document.getElementById("comboParentList");
  let owned = PALS.filter(p => ownedIds.has(p.id));

  // 選択中の親が①から外されていたら選択解除
  if (comboParentId != null && !ownedIds.has(comboParentId)) comboParentId = null;

  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    owned = owned.filter(p => {
      const nameMatch = toKatakana(p.name || "").includes(query);
      const nameEnMatch = p.nameEn && p.nameEn.toLowerCase().includes(query);
      return nameMatch || nameEnMatch;
    });
  }

  const sorted = sortPals(owned, ownedSortMode);
  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${comboParentId === p.id ? "on" : ""}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      comboParentId = comboParentId === id ? null : id;
      list.querySelectorAll(".owned-toggle").forEach(t => {
        t.classList.toggle("on", Number(t.dataset.id) === comboParentId);
      });
      renderComboResults();
    });
  });
}

function renderComboResults() {
  const box = document.getElementById("comboResults");
  const countEl = document.getElementById("comboParentSelected");

  if (comboParentId == null) {
    countEl.textContent = "未選択";
    box.innerHTML = `<p class="hint">上の一覧から親にするパルを1匹選んでください。</p>`;
    return;
  }
  const parent = PALS.find(p => p.id === comboParentId);
  countEl.textContent = `親: ${parent.name}`;

  const owned = PALS.filter(p => ownedIds.has(p.id));
  // 子パルごとに「どの相手と配合すれば生まれるか」をまとめる(自分自身との配合=同種も含む)
  const byChild = new Map();
  for (const b of owned) {
    const r = breedOnce(PALS, parent, b, BREEDING_EXAMPLES);
    if (r.unknown || !r.child) continue;
    if (!byChild.has(r.child.id)) byChild.set(r.child.id, { child: r.child, partners: [] });
    byChild.get(r.child.id).partners.push(b);
  }

  let entries = [...byChild.values()].sort((a, b) => a.child.name.localeCompare(b.child.name, "ja"));
  const totalKinds = entries.length;
  if (comboNewOnly) entries = entries.filter(e => !ownedIds.has(e.child.id));

  if (entries.length === 0) {
    box.innerHTML = `<p class="hint">${comboNewOnly ? "この親からは、まだ持っていないパルは生まれません。" : "計算可能な組み合わせがありません。"}</p>`;
    return;
  }

  const rows = entries.map(e => {
    const c = e.child;
    const isOwned = ownedIds.has(c.id);
    const eggBadge = `<span class="egg-size-badge egg-size-${(c.eggSize || "unknown").toLowerCase()}">🥚 ${EGG_SIZE_JA[c.eggSize] || "不明"}</span>`;
    const newBadge = isOwned ? "" : `<span class="badge required">未所持</span>`;
    const partnerNames = e.partners.map(p => p.name).join("、");
    return `
      <div class="combo-row" data-id="${c.id}">
        <div class="combo-child">
          <img class="paldex-icon" src="images/pal-${c.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">
          <span class="paldex-name">${c.name}</span>
          ${eggBadge}
          ${newBadge}
        </div>
        <div class="combo-partners">相手: ${partnerNames}</div>
      </div>
    `;
  }).join("");

  const summary = comboNewOnly
    ? `「${parent.name}」から1回の配合で作れるパル: ${totalKinds}種類(うち未所持 ${entries.length}種類)`
    : `「${parent.name}」から1回の配合で作れるパル: ${totalKinds}種類`;

  box.innerHTML = `<p class="hint" style="margin-bottom:8px;">${summary}。パル名をクリックすると配合ルート検索の③にセットされます。</p>${rows}`;

  box.querySelectorAll(".combo-row").forEach(el => {
    el.addEventListener("click", () => {
      jumpToTargetFromPaldex(Number(el.dataset.id));
    });
  });
}

// ---------- スキル継承(パッシブスキルを持つ所持パルを②の経由候補として使う) ----------
// SKILLSはwikiやゲーム内データから機械的には分からない「個体固有情報」なので、
// ①の所持パルとスキルの対応(palSkills)はユーザーが手動でタグ付けする。
// スキルは複数選択できる(1匹の所持パルが複数のスキルを持っている場合や、複数種類のスキルを
// まとめて継承したい場合を踏まえた作り)。選んだスキルごとに候補グループを作り、
// findBreedingRouteViaAll/findBreedingRouteMinHatchTimeAll(グループ内OR/グループ間AND)へ渡すことで
// 「選んだスキルそれぞれについて少なくとも1匹の候補が使われるルート」を計算する。
// 「候補全体のうちどれか1匹だけ使えばよい」ルートは②のOR条件アルゴリズム(findBreedingRouteVia)を
// そのまま使うが、状態(requiredPalIds)は共有せずcandidateIdsを直接渡す(タブ間を独立させるため)。

// スキルのcategoryキー→日本語見出し。SKILLSのcategoryフィールド(work/combat)に対応する。
const SKILL_CATEGORY_JA = { work: "作業系", combat: "戦闘系" };

// スキルのtagsキー→日本語ラベル。skills-data.jsonのtagsフィールド(effect文字列から機械的に導出)に対応する。
const SKILL_TAG_JA = {
  moveSpeed: "移動速度", workSpeed: "作業速度", attack: "攻撃力", defense: "防御力",
  elementalDamage: "属性ダメージ", hunger: "満腹度", sanity: "SAN値", stamina: "スタミナ",
  tradePrice: "取引価格", cooldown: "クールタイム", eggTime: "孵化時間短縮", other: "その他"
};

// タグによる絞り込み(複数選択可、OR条件。選んだタグのいずれかを持つスキルだけを表示する。
// 未選択なら絞り込みなし)。①のスキル一覧に検索と組み合わせて適用する。
let skillTagFilters = new Set();

function renderSkillTagFilterRow() {
  const row = document.getElementById("skillTagFilterRow");
  const tags = [...new Set(SKILLS.flatMap(s => s.tags || []))]
    .sort((a, b) => (SKILL_TAG_JA[a] || a).localeCompare(SKILL_TAG_JA[b] || b, "ja"));

  row.innerHTML = `<span class="hint">絞り込み:</span>` + tags.map(t => `
    <button type="button" class="sort-toggle-btn ${skillTagFilters.has(t) ? "on" : ""}" data-tag="${t}">${SKILL_TAG_JA[t] || t}</button>
  `).join("");

  row.querySelectorAll("[data-tag]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      if (skillTagFilters.has(tag)) skillTagFilters.delete(tag); else skillTagFilters.add(tag);
      btn.classList.toggle("on", skillTagFilters.has(tag));
      renderSkillToggleList(document.getElementById("skillSearch").value);
    });
  });
}

// ①スキルを選ぶ。複数選択可(継承したいスキルが複数ある場合に対応)。
// 作業系/戦闘系のカテゴリ見出しで種類ごとにグループ分けして表示し、タグ絞り込み(skillTagFilters)も適用する。
function renderSkillToggleList(filterText = "") {
  const list = document.getElementById("skillToggleList");
  let filtered = SKILLS;
  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    filtered = filtered.filter(s => {
      const nameMatch = toKatakana(s.name || "").includes(query);
      const effectMatch = toKatakana(s.effect || "").includes(query);
      return nameMatch || effectMatch;
    });
  }
  if (skillTagFilters.size > 0) {
    filtered = filtered.filter(s => (s.tags || []).some(t => skillTagFilters.has(t)));
  }

  const categories = [...new Set(SKILLS.map(s => s.category))];
  list.innerHTML = categories.map(cat => {
    const items = filtered.filter(s => s.category === cat);
    if (items.length === 0) return "";
    const rows = items.map(s => `
      <div class="owned-toggle skill-toggle ${selectedSkillIds.includes(s.id) ? "on" : ""}" data-id="${s.id}">
        <span class="skill-toggle-name">${s.name}</span>
        <span class="skill-toggle-effect">${s.effect}</span>
      </div>
    `).join("");
    return `<div class="skill-category-heading">${SKILL_CATEGORY_JA[cat] || cat}</div>${rows}`;
  }).join("");

  if (filtered.length === 0) {
    list.innerHTML = `<p class="hint">条件に一致するスキルがありません。</p>`;
  }

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (selectedSkillIds.includes(id)) {
        selectedSkillIds = selectedSkillIds.filter(sid => sid !== id);
      } else {
        selectedSkillIds = [...selectedSkillIds, id];
      }
      el.classList.toggle("on", selectedSkillIds.includes(id));
      updateSkillSelected();
      renderSkillPalTagList();
    });
  });

  updateSkillSelected();
}

function updateSkillSelected() {
  const el = document.getElementById("skillSelected");
  const card = document.getElementById("skillPalTaggingCard");
  const skills = selectedSkillIds.map(id => SKILLS.find(s => s.id === id)).filter(Boolean);
  el.textContent = skills.length > 0 ? `選択中: ${skills.map(s => s.name).join("、")}` : "未選択";
  card.style.display = skills.length > 0 ? "" : "none";
}

// ②選んだスキルそれぞれについて、それを持たせている所持パルを選ぶ。
// 1匹が複数のスキルを持っている場合も踏まえ、選択中のスキルごとに独立したチェックリストを並べて表示する
// (同じ所持パルが複数のリストにまたがってチェックされていてもよい)。①の所持パルだけが候補になる。
function renderSkillPalTagList() {
  const container = document.getElementById("skillPalTagList");
  if (selectedSkillIds.length === 0) {
    container.innerHTML = "";
    return;
  }
  const owned = PALS.filter(p => ownedIds.has(p.id));
  const sorted = sortPals(owned, ownedSortMode);

  container.innerHTML = selectedSkillIds.map(skillId => {
    const skill = SKILLS.find(s => s.id === skillId);
    const rows = sorted.map(p => `
      <div class="owned-toggle ${(palSkills[p.id] || []).includes(skillId) ? "on" : ""}" data-id="${p.id}" data-skill-id="${skillId}">${p.name}</div>
    `).join("");
    return `
      <div class="skill-tag-group">
        <div class="skill-category-heading">「${skill ? skill.name : "?"}」を持たせている所持パル <span class="skill-tag-count" data-skill-count-id="${skillId}"></span></div>
        <div class="owned-toggle-list" style="max-height:150px;">${rows}</div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      const skillId = Number(el.dataset.skillId);
      const skillIds = palSkills[id] || [];
      if (skillIds.includes(skillId)) {
        palSkills[id] = skillIds.filter(sid => sid !== skillId);
        if (palSkills[id].length === 0) delete palSkills[id];
      } else {
        palSkills[id] = [...skillIds, skillId];
      }
      savePalSkills();
      el.classList.toggle("on", (palSkills[id] || []).includes(skillId));
      updateSkillPalTagCount(skillId);
    });
  });

  selectedSkillIds.forEach(skillId => updateSkillPalTagCount(skillId));
}

function updateSkillPalTagCount(skillId) {
  const el = document.querySelector(`[data-skill-count-id="${skillId}"]`);
  if (!el) return;
  const count = Object.values(palSkills).filter(ids => ids.includes(skillId)).length;
  el.textContent = `(${count}匹)`;
}

// ③作りたいパルを選択。配合ルート検索タブの③(selectedTargetId)とは独立したskillTargetIdを使う
// (スキル継承タブと配合ルート検索タブは別機能として完全に分離する、というユーザー要望による)。
function renderSkillTargetToggleList(filterText = "") {
  const list = document.getElementById("skillTargetToggleList");
  let filtered = PALS;
  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    filtered = PALS.filter(p => {
      const nameMatch = toKatakana(p.name || "").includes(query);
      const nameEnMatch = p.nameEn && p.nameEn.toLowerCase().includes(query);
      return nameMatch || nameEnMatch;
    });
  }

  const sorted = sortPals(filtered, skillTargetSortMode);

  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${skillTargetId === p.id ? "on" : ""}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      skillTargetId = skillTargetId === id ? null : id;
      list.querySelectorAll(".owned-toggle").forEach(t => {
        t.classList.toggle("on", Number(t.dataset.id) === skillTargetId);
      });
      updateSkillTargetSelected();
    });
  });

  updateSkillTargetSelected();
}

function updateSkillTargetSelected() {
  const el = document.getElementById("skillTargetSelected");
  if (!el) return;
  if (skillTargetId) {
    const pal = PALS.find(p => p.id === skillTargetId);
    el.textContent = pal ? `選択中: ${pal.name}` : "未選択";
  } else {
    el.textContent = "未選択";
  }
}

// ④「複数の作りたいパルをまとめて計算」(牧場で飼育する複数種に同じスキルを継承させたい、等)。
// ③(単体、skillTargetId)とは独立した複数選択リスト。findBreedingRouteMultiViaに渡し、
// 選んだ複数のtargetパルを1回のBFSでまとめて追いかけることで、あるtargetが先に生まれれば
// それ以降は他のtargetを作るための親としてそのまま再利用できる(=まとめて計算する意味がある)。
function renderSkillMultiTargetToggleList(filterText = "") {
  const list = document.getElementById("skillMultiTargetToggleList");
  let filtered = PALS;
  if (filterText) {
    const query = toKatakana(filterText.toLowerCase().trim());
    filtered = PALS.filter(p => {
      const nameMatch = toKatakana(p.name || "").includes(query);
      const nameEnMatch = p.nameEn && p.nameEn.toLowerCase().includes(query);
      return nameMatch || nameEnMatch;
    });
  }

  const sorted = sortPals(filtered, skillTargetSortMode);

  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${selectedMultiTargetIds.includes(p.id) ? "on" : ""}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (selectedMultiTargetIds.includes(id)) {
        selectedMultiTargetIds = selectedMultiTargetIds.filter(tid => tid !== id);
      } else {
        selectedMultiTargetIds = [...selectedMultiTargetIds, id];
      }
      el.classList.toggle("on", selectedMultiTargetIds.includes(id));
      updateSkillMultiTargetSelected();
    });
  });

  updateSkillMultiTargetSelected();
}

function updateSkillMultiTargetSelected() {
  const el = document.getElementById("skillMultiTargetSelected");
  if (!el) return;
  if (selectedMultiTargetIds.length === 0) {
    el.textContent = "未選択";
    return;
  }
  const names = selectedMultiTargetIds.map(id => { const p = PALS.find(x => x.id === id); return p ? p.name : id; });
  el.textContent = `選択中(${names.length}匹): ${names.join("、")}`;
}

function calcSkillMultiRoute() {
  const hint = document.getElementById("skillMultiCalcHint");
  if (selectedSkillIds.length === 0) {
    hint.textContent = "①でスキルを選択してください。";
    return;
  }
  if (selectedMultiTargetIds.length === 0) {
    hint.textContent = "④で作りたいパルを1匹以上選択してください。";
    return;
  }

  const candidateIds = [...new Set(
    selectedSkillIds.flatMap(skillId =>
      PALS.filter(p => ownedIds.has(p.id) && (palSkills[p.id] || []).includes(skillId)).map(p => p.id)
    )
  )];
  const emptySkillNames = selectedSkillIds
    .filter(skillId => !PALS.some(p => ownedIds.has(p.id) && (palSkills[p.id] || []).includes(skillId)))
    .map(skillId => { const s = SKILLS.find(x => x.id === skillId); return s ? s.name : skillId; });
  if (emptySkillNames.length > 0) {
    hint.textContent = `②で「${emptySkillNames.join("、")}」を持たせている所持パルを選んでください。`;
    return;
  }
  hint.textContent = "";

  const owned = PALS.filter(p => ownedIds.has(p.id));
  const availableOwned = owned.filter(p => !excludedIds.has(p.id));
  const targetPals = selectedMultiTargetIds.map(id => PALS.find(p => p.id === id)).filter(Boolean);

  const multi = findBreedingRouteMultiVia(PALS, targetPals, availableOwned, candidateIds, BREEDING_EXAMPLES, 10);
  renderSkillMultiRouteResults(multi, new Set(ownedIds), candidateIds);
}

// computeCriticalPathHours(breeding.js)は「配列末尾のstepの子」を目的のパルとみなす単一target前提のため、
// 複数targetが混ざったまとめルートにはそのまま使えない。同じ前提(依存の無い配合は並行実行できる)で
// 全stepの用意完了時刻(ready)を前から計算し、targetの最終step全てのうち一番遅いものを「全員揃う時刻」とする。
function computeMultiCriticalPathHours(steps, ownedIds) {
  if (steps.length === 0) return 0;
  const ready = new Map();
  for (const id of ownedIds) ready.set(id, 0);
  let maxFinalReady = 0;
  for (const s of steps) {
    const aReady = ready.has(s.parentA.id) ? ready.get(s.parentA.id) : 0;
    const bReady = ready.has(s.parentB.id) ? ready.get(s.parentB.id) : 0;
    const childReady = Math.max(aReady, bReady) + getHatchHours(s.child);
    ready.set(s.child.id, childReady);
    if (s.finalForTargetIds.length > 0) maxFinalReady = Math.max(maxFinalReady, childReady);
  }
  return maxFinalReady;
}

function renderSkillMultiRouteResults(multi, ownedIdSet, requiredIds) {
  const box = document.getElementById("skillMultiRouteResults");
  const { results, steps } = multi;

  const statusRows = results.map(r => {
    if (r.hasSkillAlready) return `<li>「${r.targetPal.name}」: すでに持っています(スキル保持個体として登録済み)</li>`;
    if (r.found && r.generation !== undefined) {
      const note = r.alreadyOwned ? "(すでに持っていますが、スキル継承済みの個体をもう1匹作るルート)" : "";
      return `<li>「${r.targetPal.name}」: <strong>${r.generation}世代目</strong>で到達${note}</li>`;
    }
    if (r.alreadyOwned) return `<li>「${r.targetPal.name}」: すでに持っています(スキル継承ルートは見つかりませんでした)</li>`;
    const msg = r.reason === "required-pal-not-owned"
      ? "候補パルが所持リストから外れています"
      : "10世代以内に到達できませんでした";
    return `<li>「${r.targetPal.name}」: ${msg}</li>`;
  }).join("");

  if (steps.length === 0) {
    box.innerHTML = `<div class="card"><h2>まとめて計算した結果</h2><ul class="hint">${statusRows}</ul></div>`;
    return;
  }

  const palColorMap = buildPalColorMap(steps);
  const palTag = (pal) => {
    const isOwned = ownedIdSet.has(pal.id);
    const ownedClass = isOwned ? "pal-tag-owned" : "pal-tag-bred";
    const color = !isOwned ? palColorMap.get(pal.id) : null;
    const colorStyle = color ? ` style="border-color:${color}; color:${color};"` : "";
    const icon = `<img class="pal-tag-icon" src="images/pal-${pal.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">`;
    return `<span class="pal-tag ${ownedClass}"${colorStyle} data-pal-id="${pal.id}">${icon}${pal.name}</span>`;
  };

  const stepsHtml = steps.map((s, i) => {
    const usesRequired = requiredIds.some(id => s.parentA.id === id || s.parentB.id === id);
    const eggBadge = `<span class="egg-size-badge egg-size-${(s.child.eggSize || "unknown").toLowerCase()}">🥚 ${EGG_SIZE_JA[s.child.eggSize] || "不明"}</span>`;
    const finalNames = s.finalForTargetIds.map(id => { const p = PALS.find(x => x.id === id); return p ? p.name : id; });
    const finalBadge = finalNames.length > 0 ? `<span class="badge required">🎯 目標: ${finalNames.join("、")}</span>` : "";
    return `
      <div class="route-step">
        <div class="route-gen-badge">${i + 1}</div>
        <div class="route-formula">
          ${palTag(s.parentA)} ×
          ${palTag(s.parentB)} →
          ${palTag(s.child)}
          ${eggBadge}
          ${usesRequired ? '<span class="badge required">候補使用</span>' : ""}
          ${finalBadge}
        </div>
      </div>
    `;
  }).join("");

  const displayHatchHours = computeMultiCriticalPathHours(steps, ownedIdSet);
  const summaryLine = `全${results.length}匹のうち到達できたのは<strong>${results.filter(r => r.found).length}匹</strong>。合計<strong>${steps.length}回の配合</strong>(孵化時間合計 目安 <strong>${formatHatchHours(displayHatchHours)}</strong>、並行実行前提)でまとめて用意できます。`;

  box.innerHTML = `
    <div class="card">
      <h2>まとめて計算した結果</h2>
      <ul class="hint" style="margin-bottom:10px;">${statusRows}</ul>
      <p class="result-summary">${summaryLine}</p>
      <div>${stepsHtml}</div>
    </div>
  `;
}

// 選んだスキルそれぞれについて、そのスキルを持たせている所持パル(候補グループ)を求め、
// 「候補全体のうち少なくとも1匹を使うルート」と「選んだスキルそれぞれについて少なくとも1匹の候補を
// 使うルート(スキルが複数あれば、その全スキル分を満たす)」の2つを計算しスキル継承タブ内に表示する。
// 配合ルート検索タブの②(requiredPalIds)には反映しない(スキル継承タブと配合ルート検索タブは
// 別機能として完全に独立させている、というユーザー要望による)。
function calcSkillRoute() {
  const hint = document.getElementById("skillCalcHint");
  if (selectedSkillIds.length === 0) {
    hint.textContent = "①でスキルを選択してください。";
    return;
  }
  if (!skillTargetId) {
    hint.textContent = "③で作りたいパルを選択してください。";
    return;
  }

  // スキルごとの候補グループ(グループ内OR/グループ間ANDのアルゴリズムにそのまま渡す)
  const groups = selectedSkillIds.map(skillId =>
    PALS.filter(p => ownedIds.has(p.id) && (palSkills[p.id] || []).includes(skillId)).map(p => p.id)
  );
  const emptySkillNames = selectedSkillIds
    .filter((skillId, i) => groups[i].length === 0)
    .map(skillId => { const s = SKILLS.find(x => x.id === skillId); return s ? s.name : skillId; });
  if (emptySkillNames.length > 0) {
    hint.textContent = `②で「${emptySkillNames.join("、")}」を持たせている所持パルを選んでください。`;
    return;
  }
  hint.textContent = "";

  const candidateIds = [...new Set(groups.flat())];

  const targetPal = PALS.find(p => p.id === skillTargetId);
  const owned = PALS.filter(p => ownedIds.has(p.id));
  const availableOwned = owned.filter(p => !excludedIds.has(p.id));

  // 配合ルート検索タブの②(requiredPalIds)は書き換えない(スキル継承タブと配合ルート検索タブは
  // 独立させる、というユーザー要望による)。OR版はcomputeRoute(グローバルrequiredPalIds依存)を
  // 使わず、candidateIdsを直接渡すfindBreedingRouteVia系をここで呼ぶ。
  let routeAny = routeMode === "hatchtime"
    ? findBreedingRouteMinHatchTime(PALS, targetPal, availableOwned, BREEDING_EXAMPLES, candidateIds)
    : findBreedingRouteVia(PALS, targetPal, availableOwned, candidateIds, BREEDING_EXAMPLES, 10);
  let routeAllSkills = routeMode === "hatchtime"
    ? findBreedingRouteMinHatchTimeAll(PALS, targetPal, availableOwned, BREEDING_EXAMPLES, groups)
    : findBreedingRouteViaAll(PALS, targetPal, availableOwned, groups, BREEDING_EXAMPLES, 10);

  // 「作りたいパル」を既に持っている場合(候補の中の1匹自身が対象、等)、素のfindBreedingRouteVia系は
  // 即座にalready-ownedを返してルートを一切出さない。配合ルート検索タブのbuildSlideHtmlと同様、
  // 対象パル自身を所持プールから除いてもう1匹分のルートを試算し直す(性別が合う個体が欲しい場合等のため)。
  let alreadyOwnedNote = false;
  if (routeAny.reason === "already-owned" || routeAllSkills.reason === "already-owned") {
    alreadyOwnedNote = true;
    const ownedWithoutTarget = owned.filter(p => p.id !== targetPal.id);
    const availableWithoutTarget = ownedWithoutTarget.filter(p => !excludedIds.has(p.id));
    const groupsWithoutTarget = groups.map(g => g.filter(id => id !== targetPal.id));
    if (routeAny.reason === "already-owned" && ownedWithoutTarget.length > 0) {
      const availableWithoutTargetForAny = ownedWithoutTarget.filter(p => !excludedIds.has(p.id));
      routeAny = routeMode === "hatchtime"
        ? findBreedingRouteMinHatchTime(PALS, targetPal, availableWithoutTargetForAny, BREEDING_EXAMPLES, candidateIds)
        : findBreedingRouteVia(PALS, targetPal, availableWithoutTargetForAny, candidateIds, BREEDING_EXAMPLES, 10);
    }
    if (routeAllSkills.reason === "already-owned" && availableWithoutTarget.length > 0) {
      routeAllSkills = routeMode === "hatchtime"
        ? findBreedingRouteMinHatchTimeAll(PALS, targetPal, availableWithoutTarget, BREEDING_EXAMPLES, groupsWithoutTarget)
        : findBreedingRouteViaAll(PALS, targetPal, availableWithoutTarget, groupsWithoutTarget, BREEDING_EXAMPLES, 10);
    }
  }

  renderSkillRouteResults(targetPal, routeAny, routeAllSkills, candidateIds, new Set(ownedIds), alreadyOwnedNote);
}

// スキル継承タブ内に「候補全体のうちどれか1匹を使うルート」「選んだスキルそれぞれを満たすルート」の
// 2枚を並べて表示する。配合ルート検索タブのカルーセル(ピン留め・除外・代替組み合わせ等)とは
// 独立した読み取り専用表示。
function renderSkillRouteResults(targetPal, routeAny, routeAllSkills, requiredIds, ownedIdSet, alreadyOwnedNote) {
  const box = document.getElementById("skillRouteResults");
  const allLabel = selectedSkillIds.length > 1
    ? "選んだスキルをそれぞれ少なくとも1匹の候補でカバーするルート"
    : "候補全員を実際に使うルート";
  box.innerHTML =
    buildSkillRouteCard("候補のうち少なくとも1匹を使うルート", targetPal, routeAny, ownedIdSet, requiredIds, alreadyOwnedNote) +
    buildSkillRouteCard(allLabel, targetPal, routeAllSkills, ownedIdSet, requiredIds, alreadyOwnedNote);
}

function buildSkillRouteCard(label, targetPal, route, ownedIdSet, requiredIds, alreadyOwnedNote) {
  // 「作りたいパル」を既に持っている場合、calcSkillRoute側で対象パル自身を除いた
  // もう1匹分のルートに置き換え済み(それでも作れない/候補が対象パル自身しかいない等の場合はここに来る)。
  const ownedHint = alreadyOwnedNote
    ? `<p class="hint" style="margin-bottom:10px;">「${targetPal.name}」はすでに持っています。性別が合う個体が欲しい場合など、もう1匹配合したい時のルート:</p>`
    : "";
  if (route.reason === "already-owned") {
    return `<div class="card"><h2>${label}</h2><p class="hint">「${targetPal.name}」はすでに持っているパルの中にあります。</p></div>`;
  }
  if (route.reason === "required-pal-not-owned" || route.reason === "no-owned-pals") {
    const msg = alreadyOwnedNote
      ? `「${targetPal.name}」自身を除くと候補パルが所持リストにいません(候補が「${targetPal.name}」自身しかいなかった可能性があります)。`
      : "候補パルが所持リストから外れています。②を選び直してください。";
    return `<div class="card"><h2>${label}</h2>${ownedHint}<p class="hint">${msg}</p></div>`;
  }

  const isHatchMode = route.totalHatchHours !== undefined;
  if (!route.found) {
    const limitNote = isHatchMode ? "" : "10世代以内に";
    return `<div class="card"><h2>${label}</h2>${ownedHint}<p class="hint">${limitNote}「${targetPal.name}」へ到達できませんでした。</p></div>`;
  }

  const palColorMap = buildPalColorMap(route.steps);
  const palTag = (pal) => {
    const isOwned = ownedIdSet.has(pal.id);
    const ownedClass = isOwned ? "pal-tag-owned" : "pal-tag-bred";
    const color = !isOwned ? palColorMap.get(pal.id) : null;
    const colorStyle = color ? ` style="border-color:${color}; color:${color};"` : "";
    const icon = `<img class="pal-tag-icon" src="images/pal-${pal.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">`;
    return `<span class="pal-tag ${ownedClass}"${colorStyle} data-pal-id="${pal.id}">${icon}${pal.name}</span>`;
  };

  const stepsHtml = route.steps.map((s, i) => {
    const usesRequired = requiredIds.some(id => s.parentA.id === id || s.parentB.id === id);
    const eggBadge = `<span class="egg-size-badge egg-size-${(s.child.eggSize || "unknown").toLowerCase()}">🥚 ${EGG_SIZE_JA[s.child.eggSize] || "不明"}</span>`;
    return `
      <div class="route-step">
        <div class="route-gen-badge">${i + 1}</div>
        <div class="route-formula">
          ${palTag(s.parentA)} ×
          ${palTag(s.parentB)} →
          ${palTag(s.child)}
          ${eggBadge}
          ${usesRequired ? '<span class="badge required">候補使用</span>' : ""}
        </div>
      </div>
    `;
  }).join("");

  const displayHatchHours = isHatchMode ? route.totalHatchHours : computeCriticalPathHours(route.steps, ownedIdSet);
  const summaryLine = `「${targetPal.name}」まで <strong>${route.steps.length}回の配合</strong>(孵化時間合計 目安 <strong>${formatHatchHours(displayHatchHours)}</strong>)で到達できます。`;

  return `
    <div class="card">
      <h2>${label}</h2>
      ${ownedHint}
      <p class="result-summary">${summaryLine}</p>
      <div>${stepsHtml}</div>
    </div>
  `;
}

function bindEvents() {
  document.getElementById("ownedSearch").addEventListener("input", (e) => {
    renderOwnedToggleList(e.target.value);
  });
  document.getElementById("targetSearch").addEventListener("input", (e) => {
    renderTargetSelect(e.target.value);
  });
  document.getElementById("btnCalc").addEventListener("click", calcRoute);

  document.getElementById("ownedSortAiueo").addEventListener("click", () => setOwnedSort("aiueo"));
  document.getElementById("ownedSortNo").addEventListener("click", () => setOwnedSort("no"));
  document.getElementById("targetSortAiueo").addEventListener("click", () => setTargetSort("aiueo"));
  document.getElementById("targetSortNo").addEventListener("click", () => setTargetSort("no"));
  document.getElementById("routeModeGenerations").addEventListener("click", () => setRouteMode("generations"));
  document.getElementById("routeModeHatchTime").addEventListener("click", () => setRouteMode("hatchtime"));

  document.getElementById("tabBreeding").addEventListener("click", () => switchView("breeding"));
  document.getElementById("tabPaldex").addEventListener("click", () => switchView("paldex"));
  document.getElementById("tabCombos").addEventListener("click", () => switchView("combos"));
  document.getElementById("tabSkills").addEventListener("click", () => switchView("skills"));
  document.getElementById("comboParentSearch").addEventListener("input", (e) => {
    renderComboParentList(e.target.value);
  });
  document.getElementById("comboNewOnly").addEventListener("change", (e) => {
    comboNewOnly = e.target.checked;
    renderComboResults();
  });
  document.getElementById("skillSearch").addEventListener("input", (e) => {
    renderSkillToggleList(e.target.value);
  });
  document.getElementById("skillTargetSearch").addEventListener("input", (e) => {
    renderSkillTargetToggleList(e.target.value);
  });
  document.getElementById("skillTargetSortAiueo").addEventListener("click", () => setSkillTargetSort("aiueo"));
  document.getElementById("skillTargetSortNo").addEventListener("click", () => setSkillTargetSort("no"));
  document.getElementById("btnSkillCalc").addEventListener("click", calcSkillRoute);
  document.getElementById("skillMultiTargetSearch").addEventListener("input", (e) => {
    renderSkillMultiTargetToggleList(e.target.value);
  });
  document.getElementById("btnSkillMultiCalc").addEventListener("click", calcSkillMultiRoute);
  document.getElementById("paldexSearch").addEventListener("input", (e) => {
    renderPaldexList(e.target.value);
  });
  document.getElementById("paldexSortAiueo").addEventListener("click", () => setPaldexSort("aiueo"));
  document.getElementById("paldexSortNo").addEventListener("click", () => setPaldexSort("no"));
  document.getElementById("paldexWorkSort").addEventListener("change", (e) => setPaldexWorkSort(e.target.value));
  document.getElementById("paldexOwnedOnly").addEventListener("change", (e) => setPaldexOwnedOnly(e.target.checked));

  bindCarouselEvents();
  bindSyncEvents();
}

// 計算結果カルーセル: パルタグ/コピー/ピンボタンのクリックはスライドが動的に再構築されるためイベント委譲で受ける。
// 矢印/ドット/手動スワイプ(scroll)のいずれからも現在位置(currentSlideIndex)を追従させる。
function bindCarouselEvents() {
  const carousel = document.getElementById("resultCarousel");

  carousel.addEventListener("click", (e) => {
    const excludeBtn = e.target.closest(".pal-exclude-btn[data-exclude-id]");
    if (excludeBtn) { toggleExcludedAndRecompute(Number(excludeBtn.dataset.excludeId), Number(excludeBtn.dataset.contextTargetId)); return; }
    const tag = e.target.closest(".pal-tag[data-pal-id]");
    if (tag) { jumpToTarget(Number(tag.dataset.palId)); return; }
    const copyBtn = e.target.closest(".copy-route-btn[data-copy-index]");
    if (copyBtn) { copyRouteText(Number(copyBtn.dataset.copyIndex)); return; }
    const pinBtn = e.target.closest(".pin-toggle-btn[data-pin-id]");
    if (pinBtn) { togglePinned(Number(pinBtn.dataset.pinId)); return; }
  });

  let scrollDebounce = null;
  carousel.addEventListener("scroll", () => {
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      if (lastSlides.length <= 1) return;
      const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
      if (idx !== currentSlideIndex && idx >= 0 && idx < lastSlides.length) {
        currentSlideIndex = idx;
        if (lastSlides[idx].targetPal) activeTargetId = lastSlides[idx].targetPal.id;
        updateDots();
      }
    }, 120);
  });

  document.getElementById("carouselPrev").addEventListener("click", () => {
    if (currentSlideIndex > 0) {
      currentSlideIndex--;
      if (lastSlides[currentSlideIndex].targetPal) activeTargetId = lastSlides[currentSlideIndex].targetPal.id;
      scrollToSlide(currentSlideIndex);
      updateDots();
    }
  });
  document.getElementById("carouselNext").addEventListener("click", () => {
    if (currentSlideIndex < lastSlides.length - 1) {
      currentSlideIndex++;
      if (lastSlides[currentSlideIndex].targetPal) activeTargetId = lastSlides[currentSlideIndex].targetPal.id;
      scrollToSlide(currentSlideIndex);
      updateDots();
    }
  });
  document.getElementById("resultDots").addEventListener("click", (e) => {
    const dot = e.target.closest(".result-dot[data-index]");
    if (dot) {
      currentSlideIndex = Number(dot.dataset.index);
      if (lastSlides[currentSlideIndex] && lastSlides[currentSlideIndex].targetPal) {
        activeTargetId = lastSlides[currentSlideIndex].targetPal.id;
      }
      scrollToSlide(currentSlideIndex);
      updateDots();
    }
  });
}

function setOwnedSort(mode) {
  ownedSortMode = mode;
  document.getElementById("ownedSortAiueo").classList.toggle("on", mode === "aiueo");
  document.getElementById("ownedSortNo").classList.toggle("on", mode === "no");
  renderOwnedToggleList(document.getElementById("ownedSearch").value);
}

// 配合ルート検索タブの③専用(スキル継承タブとは独立)。
function setTargetSort(mode) {
  targetSortMode = mode;
  document.getElementById("targetSortAiueo").classList.toggle("on", mode === "aiueo");
  document.getElementById("targetSortNo").classList.toggle("on", mode === "no");
  const searchVal = document.getElementById("targetSearch") ? document.getElementById("targetSearch").value : "";
  renderTargetSelect(searchVal);
}

// スキル継承タブ専用(③④で共有、配合ルート検索タブとは独立)。
function setSkillTargetSort(mode) {
  skillTargetSortMode = mode;
  document.getElementById("skillTargetSortAiueo").classList.toggle("on", mode === "aiueo");
  document.getElementById("skillTargetSortNo").classList.toggle("on", mode === "no");
  const skillSearchVal = document.getElementById("skillTargetSearch") ? document.getElementById("skillTargetSearch").value : "";
  renderSkillTargetToggleList(skillSearchVal);
  const skillMultiSearchVal = document.getElementById("skillMultiTargetSearch") ? document.getElementById("skillMultiTargetSearch").value : "";
  renderSkillMultiTargetToggleList(skillMultiSearchVal);
}

// ---------- 配合ルート計算 ----------

// routeModeが"hatchtime"なら孵化時間最小のダイクストラ探索、そうでなければ従来の世代数ベースのBFSを使う。
// requiredPalIdsが指定されていれば、どちらのモードでも「経由必須パルのうち少なくとも1匹」を
// 実際に使ったルートだけを探す(複数指定しても全員を使う必要はない)。
// excludedIdsに入っているパルは「今は配合に使えない(性別が合わない等)」として所持リストから一時的に除く。
function computeRoute(targetPal, owned) {
  const availableOwned = owned.filter(p => !excludedIds.has(p.id));
  if (routeMode === "hatchtime") {
    return findBreedingRouteMinHatchTime(PALS, targetPal, availableOwned, BREEDING_EXAMPLES, requiredPalIds);
  }
  if (requiredPalIds.length > 0) {
    return findBreedingRouteVia(PALS, targetPal, availableOwned, requiredPalIds, BREEDING_EXAMPLES, 10);
  }
  return findBreedingRoute(PALS, targetPal, availableOwned, BREEDING_EXAMPLES, 10);
}

function setRouteMode(mode) {
  routeMode = mode;
  document.getElementById("routeModeGenerations").classList.toggle("on", mode === "generations");
  document.getElementById("routeModeHatchTime").classList.toggle("on", mode === "hatchtime");
  // ピン留め中のパルはモード変更にもライブ追従させる(履歴側の過去の計算結果はそのモード時点の表示のまま残す)。
  renderCarousel();
}

function calcRoute() {
  if (!selectedTargetId) {
    showCarouselMessage(`<p class="hint">③で作りたいパルを選択してください。</p>`);
    return;
  }
  const targetPal = PALS.find(p => p.id === selectedTargetId);
  const owned = PALS.filter(p => ownedIds.has(p.id));

  if (owned.length === 0) {
    showCarouselMessage(`<p class="hint">①で持っているパルを1体以上選んでください。</p>`);
    return;
  }

  const route = computeRoute(targetPal, owned);
  // ボタンでの計算実行は新しい調査の起点とみなし、履歴をリセットして1件目のスライドにする。
  pushHistorySlide(targetPal, route, new Set(ownedIds), [...requiredPalIds], { reset: true });
}

// パル名クリックで、そのパルを新たな「作りたいパル」として選択し直し、結果をスライドとして履歴に追加する。
// 現在表示中の位置より後ろの履歴は切り捨ててから追加する(ブラウザの戻る→別リンククリックと同じ挙動)。
// 経由必須パルの指定はドリルダウン中も引き継ぐ。
function jumpToTarget(palId) {
  selectedTargetId = palId;
  document.getElementById("targetPalSelect").value = palId;
  renderTargetSelect(document.getElementById("targetSearch").value);

  const targetPal = PALS.find(p => p.id === palId);
  const owned = PALS.filter(p => ownedIds.has(p.id));
  const route = computeRoute(targetPal, owned);
  pushHistorySlide(targetPal, route, new Set(ownedIds), [...requiredPalIds], { reset: false });

  document.getElementById("resultCarousel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// 計算結果カルーセルに単発のメッセージ(未選択時の案内等)だけを、ピン留めスライドの手前に表示する。
// (履歴自体はクリアしないが、この案内は次の実際の計算/ドリルダウンで自動的に消える)
function showCarouselMessage(html) {
  transientMessage = html;
  renderCarousel();
}

// resultHistoryにスライドを積んでカルーセルを再描画する。
// reset:true は新しい調査の起点(履歴を1件にリセット)、false は現在位置より後ろを切り捨てて追加。
function pushHistorySlide(targetPal, route, ownedIdSet, requiredIds, { reset }) {
  transientMessage = null;
  if (reset) {
    resultHistory = [{ targetPal, route, ownedIdSet, requiredIds }];
    historyCursor = 0;
  } else {
    resultHistory = resultHistory.slice(0, historyCursor + 1);
    resultHistory.push({ targetPal, route, ownedIdSet, requiredIds });
    if (resultHistory.length > MAX_HISTORY) resultHistory.shift();
    historyCursor = resultHistory.length - 1;
  }
  activeTargetId = targetPal.id;
  renderCarousel();
}

// ピン留め中のパルは①(所持パル)/②(経由必須パル)の現在の設定でルートをその場で再計算する。
// 同じパルが計算履歴(resultHistory)側にもある場合は重複表示を避けるため履歴側から除外する。
function getCombinedSlides() {
  const pinnedSet = new Set(pinnedIds);
  const owned = PALS.filter(p => ownedIds.has(p.id));

  const pinnedSlides = pinnedIds
    .map(id => PALS.find(p => p.id === id))
    .filter(Boolean)
    .map(targetPal => {
      const signature = computeRouteSignature(targetPal);
      const cached = pinnedRouteCache.get(targetPal.id);
      const route = (cached && cached.signature === signature) ? cached.route : computeRoute(targetPal, owned);
      pinnedRouteCache.set(targetPal.id, { signature, route });
      return {
        targetPal,
        route,
        ownedIdSet: new Set(ownedIds),
        requiredIds: [...requiredPalIds],
        pinned: true
      };
    });

  const historySlides = resultHistory
    .filter(h => !pinnedSet.has(h.targetPal.id))
    .map(h => ({ targetPal: h.targetPal, route: h.route, ownedIdSet: h.ownedIdSet, requiredIds: h.requiredIds, pinned: false }));

  return [...pinnedSlides, ...historySlides];
}

function renderCarousel() {
  const carousel = document.getElementById("resultCarousel");
  const prevBtn = document.getElementById("carouselPrev");
  const nextBtn = document.getElementById("carouselNext");
  const dots = document.getElementById("resultDots");

  const routeSlides = getCombinedSlides();

  if (!transientMessage && routeSlides.length === 0) {
    carousel.innerHTML = `<div class="result-slide"><p class="hint">①と③を選択してから「配合ルートを計算する」ボタンを押すか、③のパル名横の📌でピン留めしてください。</p></div>`;
    prevBtn.style.display = "none";
    nextBtn.style.display = "none";
    dots.innerHTML = "";
    lastSlides = [];
    return;
  }

  lastSlides = [];
  const htmlParts = [];
  if (transientMessage) {
    htmlParts.push(`<div class="result-slide">${transientMessage}</div>`);
    lastSlides.push({ message: true });
  }
  routeSlides.forEach(s => {
    htmlParts.push(buildSlideHtml(s.targetPal, s.route, s.ownedIdSet, s.requiredIds, lastSlides.length, s.pinned));
    lastSlides.push(s);
  });
  carousel.innerHTML = htmlParts.join("");

  if (transientMessage) {
    currentSlideIndex = 0;
  } else {
    let idx = activeTargetId != null
      ? lastSlides.findIndex(s => s.targetPal && s.targetPal.id === activeTargetId)
      : 0;
    if (idx === -1) idx = lastSlides.length - 1;
    currentSlideIndex = idx;
    activeTargetId = lastSlides[idx].targetPal.id;
  }

  const showControls = lastSlides.length > 1;
  prevBtn.style.display = showControls ? "flex" : "none";
  nextBtn.style.display = showControls ? "flex" : "none";
  dots.innerHTML = showControls
    ? lastSlides
        .map((_, i) => `<button type="button" class="result-dot ${i === currentSlideIndex ? "on" : ""}" data-index="${i}" aria-label="結果${i + 1}へ"></button>`)
        .join("")
    : "";

  scrollToSlide(currentSlideIndex, false);
}

function updateDots() {
  document.querySelectorAll("#resultDots .result-dot").forEach((d, i) => {
    d.classList.toggle("on", i === currentSlideIndex);
  });
}

function scrollToSlide(index, smooth = true) {
  const carousel = document.getElementById("resultCarousel");
  if (!carousel || index < 0) return;
  carousel.scrollTo({ left: index * carousel.clientWidth, behavior: smooth ? "smooth" : "auto" });
}

// ルート内で複数回登場するパル(前世代の子が次世代の親として再利用されるケース)に
// 同一の色を割り当てて、どこで再利用されているか視覚的に追いやすくする。
// 色はCSS変数(--cat-1〜--cat-8、検証済みcategoricalパレット)を固定順で参照する。
// 8種を超える再利用パルは色分けせず既定スタイルのままにする(循環させない)。
const ROUTE_REUSE_COLOR_VARS = [
  "var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)",
  "var(--cat-5)", "var(--cat-6)", "var(--cat-7)", "var(--cat-8)"
];

// 計算結果をプレーンテキストに変換する(クリップボードコピー用)。
function buildRouteText(targetPal, route, requiredIds, ownedIdSet) {
  const reqIds = requiredIds || [];
  const requiredPals = reqIds.map(id => PALS.find(p => p.id === id)).filter(Boolean);
  const isHatchMode = route.totalHatchHours !== undefined;
  const displayHatchHours = isHatchMode ? route.totalHatchHours : computeCriticalPathHours(route.steps, ownedIdSet || new Set());
  const lines = [
    `「${targetPal.name}」まで${route.steps.length}回の配合(孵化時間合計 目安${formatHatchHours(displayHatchHours)})で到達`
  ];
  route.steps.forEach((s, i) => {
    const usesRequired = reqIds.some(id => s.parentA.id === id || s.parentB.id === id);
    const eggInfo = `(${EGG_SIZE_JA[s.child.eggSize] || "不明"})`;
    lines.push(`${i + 1}回目: ${s.parentA.name} × ${s.parentB.name} → ${s.child.name}${eggInfo}${usesRequired ? "(経由指定)" : ""}`);
  });
  if (requiredPals.length > 0) lines.push(`※「経由指定」は、指定したパル(${requiredPals.map(p => p.name).join("、")})のうち実際に配合に使われたものがあるステップです(全員を使う必要はありません)。`);

  const availableOwnedIds = ownedIdSet ? [...ownedIdSet].filter(id => !excludedIds.has(id)) : [];
  let altCombos = availableOwnedIds.length > 0
    ? findBreedingCombos(PALS, targetPal, availableOwnedIds, BREEDING_EXAMPLES)
    : [];
  if (reqIds.length > 0) {
    altCombos = altCombos.filter(c => reqIds.some(id => c.parentA.id === id || c.parentB.id === id));
  }
  const lastStep = route.steps[route.steps.length - 1];
  if (lastStep) {
    altCombos = altCombos.filter(c => {
      const sameAsMain = (c.parentA.id === lastStep.parentA.id && c.parentB.id === lastStep.parentB.id) ||
                          (c.parentA.id === lastStep.parentB.id && c.parentB.id === lastStep.parentA.id);
      return !sameAsMain;
    });
  }
  if (altCombos.length > 0) {
    lines.push(`所持パルだけで直接作れる他の組み合わせ(${altCombos.length}件):`);
    altCombos.forEach(c => lines.push(`・${c.parentA.name} × ${c.parentB.name} → ${targetPal.name}`));
  }

  return lines.join("\n");
}

// クリップボードコピー。file://で開いた場合など navigator.clipboard が使えない/失敗する環境向けに
// document.execCommand("copy") へのフォールバックを用意する。
async function copyRouteText(index) {
  const h = lastSlides[index];
  if (!h || h.message || !h.route.found) return;
  const text = buildRouteText(h.targetPal, h.route, h.requiredIds, h.ownedIdSet);
  const btn = document.querySelector(`.copy-route-btn[data-copy-index="${index}"]`);
  const showResult = (label) => {
    if (!btn) return;
    const original = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = original;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = btn.dataset.originalLabel; }, 1500);
  };

  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    showResult("コピーしました");
    return;
  } catch (e) {
    // フォールバックへ
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    showResult("コピーしました");
  } catch (e) {
    showResult("コピーに失敗しました");
  } finally {
    document.body.removeChild(ta);
  }
}

function buildPalColorMap(steps) {
  const countById = new Map();
  for (const s of steps) {
    for (const pal of [s.parentA, s.parentB, s.child]) {
      countById.set(pal.id, (countById.get(pal.id) || 0) + 1);
    }
  }

  const reusedIds = [...countById.entries()]
    .filter(([, count]) => count >= 2)
    .map(([id]) => id);

  const colorMap = new Map();
  reusedIds.slice(0, ROUTE_REUSE_COLOR_VARS.length).forEach((id, i) => {
    colorMap.set(id, ROUTE_REUSE_COLOR_VARS[i]);
  });
  return colorMap;
}

// 1回分の計算結果を、カルーセルの1スライド分のHTML文字列として組み立てる。
// パルタグのクリックハンドラは #resultCarousel 側のイベント委譲(bindCarouselEvents)で受けるため、ここでは付与しない。
// requiredIds: そのスライド計算時点で指定されていた「必ず経由する所持パル」のid配列(未指定なら空配列)。
function buildSlideHtml(targetPal, route, ownedIdSet, requiredIds, slideIndex, pinned) {
  const reqIds = requiredIds || [];
  const requiredPals = reqIds.map(id => PALS.find(p => p.id === id)).filter(Boolean);
  const pinBtnHtml = `<button type="button" class="secondary pin-toggle-btn ${pinned ? "pinned" : ""}" data-pin-id="${targetPal.id}">${pinned ? "📌 ピン留め中" : "📌 ピン留めする"}</button>`;

  if (route.reason === "already-owned") {
    // 「既に持っている」だけで終わらせず、性別が合う個体を追加で配合したい場合等のために
    // 対象パル自身を所持プールから除いた上でもう1匹分のルートを試算する。
    const ownedWithoutTarget = ownedIdSet ? [...ownedIdSet].filter(pid => pid !== targetPal.id) : [];
    const ownedPalsWithoutTarget = PALS.filter(p => ownedWithoutTarget.includes(p.id));
    const altRoute = ownedPalsWithoutTarget.length > 0 ? computeRoute(targetPal, ownedPalsWithoutTarget) : null;

    if (altRoute && altRoute.found && altRoute.steps.length > 0) {
      const altHtml = buildSlideHtml(targetPal, altRoute, new Set(ownedWithoutTarget), reqIds, slideIndex, pinned);
      return altHtml.replace(
        '<div class="route-actions">',
        `<p class="hint" style="margin-bottom:10px;">「${targetPal.name}」はすでに持っています。性別が合う個体が欲しい場合など、もう1匹配合したい時のルート:</p><div class="route-actions">`
      );
    }

    return `
      <div class="result-slide">
        <div class="route-actions">
          <p class="result-summary" style="margin-bottom:0;">「${targetPal.name}」はすでに持っているパルの中にあります。</p>
          ${pinBtnHtml}
        </div>
      </div>
    `;
  }

  if (route.reason === "required-pal-not-owned") {
    return `
      <div class="result-slide">
        <div class="route-actions">
          <p class="result-summary" style="margin-bottom:0;">経由指定したパルが所持パルから外れています。②で選び直してください。</p>
          ${pinBtnHtml}
        </div>
      </div>
    `;
  }

  const isHatchMode = route.totalHatchHours !== undefined;

  if (!route.found) {
    const limitNote = isHatchMode ? "" : "10世代以内に";
    const summary = requiredPals.length > 0
      ? `「${requiredPals.map(p => p.name).join("、")}」を使った配合ルートは、${limitNote}「${targetPal.name}」へ到達できませんでした。`
      : `持っているパルの組み合わせでは、${limitNote}「${targetPal.name}」へ到達できませんでした。`;
    return `
      <div class="result-slide">
        <div class="route-actions">
          <p class="result-summary" style="margin-bottom:0;">${summary}</p>
          ${pinBtnHtml}
        </div>
        <p class="hint">中間素材となるパルを他の方法で入手すると経路が見つかりやすくなります。</p>
      </div>
    `;
  }

  const palColorMap = buildPalColorMap(route.steps);

  const palTag = (pal) => {
    const isOwned = ownedIdSet && ownedIdSet.has(pal.id);
    const isExcluded = excludedIds.has(pal.id);
    const ownedClass = isOwned ? "pal-tag-owned" : "pal-tag-bred";
    // 色分けは「配合で生まれるパル」同士の再利用を追うためのものなので、
    // 持っているパル(常に緑背景で固定)には適用しない。
    const color = !isOwned ? palColorMap.get(pal.id) : null;
    const colorStyle = color ? ` style="border-color:${color}; color:${color};"` : "";
    const icon = `<img class="pal-tag-icon" src="images/pal-${pal.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">`;
    const excludeBtn = `<button type="button" class="pal-exclude-btn ${isExcluded ? "excluded" : ""}" data-exclude-id="${pal.id}" data-context-target-id="${targetPal.id}" title="このパルは今使えない(性別が合わない等)。押すと別ルートを再計算します">🚫</button>`;
    return `<span class="pal-tag ${ownedClass}${isExcluded ? " pal-tag-excluded" : ""}"${colorStyle} data-pal-id="${pal.id}" title="クリックでこのパルへの配合ルートを見る">${icon}${pal.name}${excludeBtn}</span>`;
  };

  const stepsHtml = route.steps.map((s, i) => {
    const usesRequired = reqIds.some(id => s.parentA.id === id || s.parentB.id === id);
    const eggBadge = `<span class="egg-size-badge egg-size-${(s.child.eggSize || "unknown").toLowerCase()}">🥚 ${EGG_SIZE_JA[s.child.eggSize] || "不明"}</span>`;
    return `
    <div class="route-step">
      <div class="route-gen-badge">${i + 1}</div>
      <div class="route-formula">
        ${palTag(s.parentA)} ×
        ${palTag(s.parentB)} →
        ${palTag(s.child)}
        ${eggBadge}
        ${usesRequired ? '<span class="badge required">経由指定</span>' : ""}
      </div>
    </div>
  `;
  }).join("");

  const requiredNote = requiredPals.length > 0
    ? `<p class="hint" style="margin-top:6px;">※「経由指定」バッジは、指定したパル(${requiredPals.map(p => p.name).join("、")})のうち実際に配合に使われたものがあるステップです(全員を使う必要はありません)。</p>`
    : "";

  // メインルートは(タイブレークがあっても)候補のうち1通りしか選ばないため、所持パルだけで
  // 直接targetPalを作れる他の親ペア(性別違いの個体を用意したい場合等の代替候補)があれば別途列挙する。
  const availableOwnedIds = ownedIdSet ? [...ownedIdSet].filter(id => !excludedIds.has(id)) : [];
  let altCombos = availableOwnedIds.length > 0
    ? findBreedingCombos(PALS, targetPal, availableOwnedIds, BREEDING_EXAMPLES)
    : [];
  // 経由必須パル指定時は、指定したパルのうち少なくとも1匹をその組み合わせの親として使うものだけを残す
  if (reqIds.length > 0) {
    altCombos = altCombos.filter(c => reqIds.some(id => c.parentA.id === id || c.parentB.id === id));
  }
  // メインルートの最終ステップと同じ親ペアは重複表示しない
  const lastStep = route.steps[route.steps.length - 1];
  if (lastStep) {
    altCombos = altCombos.filter(c => {
      const sameAsMain = (c.parentA.id === lastStep.parentA.id && c.parentB.id === lastStep.parentB.id) ||
                          (c.parentA.id === lastStep.parentB.id && c.parentB.id === lastStep.parentA.id);
      return !sameAsMain;
    });
  }

  const altCombosHtml = altCombos.length > 0 ? `
    <div class="alt-combos" style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border);">
      <details class="alt-combos-details">
        <summary class="alt-combos-summary">🔀 所持パルだけで「${targetPal.name}」を直接作れる他の組み合わせ(${altCombos.length}件)</summary>
        <div class="alt-combos-body">
          ${altCombos.map(c => `
            <div class="route-step">
              <div class="route-gen-badge">↔</div>
              <div class="route-formula">
                ${palTag(c.parentA)} ×
                ${palTag(c.parentB)} →
                ${palTag(targetPal)}
              </div>
            </div>
          `).join("")}
        </div>
      </details>
    </div>
  ` : "";

  const displayHatchHours = isHatchMode ? route.totalHatchHours : computeCriticalPathHours(route.steps, ownedIdSet || new Set());
  const summaryLine = `「${targetPal.name}」まで <strong>${route.steps.length}回の配合</strong>(孵化時間合計 目安 <strong>${formatHatchHours(displayHatchHours)}</strong>)で到達できます。`;

  return `
    <div class="result-slide">
      <div class="route-actions">
        <p class="result-summary">${summaryLine}</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${pinBtnHtml}
          <button type="button" class="secondary copy-route-btn" data-copy-index="${slideIndex}">結果をコピー</button>
        </div>
      </div>
      <div class="route-legend">
        <span class="legend-item"><span class="legend-swatch legend-owned"></span>持っているパル</span>
        <span class="legend-item"><span class="legend-swatch legend-bred"></span>配合で生まれるパル</span>
        <span class="legend-item">パル名をクリックするとそのパルへのルートを表示します</span>
      </div>
      <div>${stepsHtml}</div>
      ${requiredNote}
      ${altCombosHtml}
    </div>
  `;
}
