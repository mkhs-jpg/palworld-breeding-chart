// パル配合ルート検索 メインロジック
// breeding.js の findBreedingRoute / findBreedingCombos を利用する

const LS_KEYS = {
  pals: "pbh_pals_data",
  owned: "pbh_owned_ids",
  pinned: "pbh_pinned_ids"
};
const DATA_VERSION = 10; // pals-data.jsonのversionと一致させる。同梱データを更新したら上げる

let PALS = [];
let BREEDING_EXAMPLES = {};
let ownedIds = new Set();
let ownedSortMode = "aiueo"; // "aiueo" | "no"
let targetSortMode = "aiueo";
let selectedTargetId = null;
let requiredPalId = null; // ②で指定した「必ず経由する所持パル」(任意、未指定はnull)
let paldexSortMode = "aiueo";
let paldexWorkSortType = null; // 指定した作業適性タイプの高い順に並べる(未指定はnull、あいうえお順/図鑑No順を優先)
let paldexOwnedOnly = false; // trueなら所持パルだけに絞り込む

// ピン留めした「作りたいパル」のid一覧(順序=ピン留めした順)。localStorageに永続化する。
// ピン留め中のパルは①(所持パル)や②(経由必須パル)を変更するたびに現在の設定でライブ再計算され、
// 結果カルーセル(横スワイプ)の先頭に常に表示され続ける(計算履歴のように追い出されない)。
let pinnedIds = [];

// 計算結果のスワイプ履歴(①②③で計算した「作りたいパル」の結果を最大件数分さかのぼれる)
const MAX_HISTORY = 5;
let resultHistory = []; // [{ targetPal, route, ownedIdSet, requiredPalId }]
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

init();

function init() {
  loadPalsData().then(() => {
    loadOwned();
    loadPinned();
    renderTargetSelect();
    renderOwnedToggleList();
    renderRequiredToggleList();
    renderPaldexList();
    renderCarousel();
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
function togglePinned(id) {
  const idx = pinnedIds.indexOf(id);
  if (idx === -1) pinnedIds.push(id); else pinnedIds.splice(idx, 1);
  savePinned();
  transientMessage = null;
  renderTargetSelect(document.getElementById("targetSearch").value);
  renderCarousel();
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
      if (requiredPalId != null && !ownedIds.has(requiredPalId)) {
        requiredPalId = null;
      }
      renderRequiredToggleList();
      // ピン留めしたパルのルートは①の変更に追従してライブ再計算するため再描画する。
      renderCarousel();
    });
  });

  updateOwnedCount();
}

// ②(任意)必ず経由する所持パルの候補リスト。①で現在選ばれている所持パルだけを候補にする単一選択リスト。
function renderRequiredToggleList() {
  const list = document.getElementById("requiredToggleList");
  const owned = PALS.filter(p => ownedIds.has(p.id));
  const sorted = sortPals(owned, ownedSortMode);

  list.innerHTML = sorted.map(p => `
    <div class="owned-toggle ${requiredPalId === p.id ? "on" : ""}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      requiredPalId = requiredPalId === id ? null : id;
      list.querySelectorAll(".owned-toggle").forEach(t => {
        t.classList.toggle("on", Number(t.dataset.id) === requiredPalId);
      });
      updateRequiredSelected();
      // ピン留めしたパルのルートは②の変更に追従してライブ再計算するため再描画する。
      renderCarousel();
    });
  });

  updateRequiredSelected();
}

function updateRequiredSelected() {
  const el = document.getElementById("requiredSelected");
  if (requiredPalId != null) {
    const pal = PALS.find(p => p.id === requiredPalId);
    el.textContent = pal ? `指定中: ${pal.name}` : "未指定";
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

    return `
      <div class="paldex-entry" data-id="${p.id}">
        <img class="paldex-icon" src="images/pal-${p.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">
        <span class="paldex-name">${p.name}</span>
        <span class="paldex-meta">No.${p.paldexId} ${p.attribute}</span>
        <span class="paldex-stats">HP${p.hp} 攻${p.attack} 防${p.defense}</span>
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
  const isBreeding = view === "breeding";
  document.getElementById("breedingView").style.display = isBreeding ? "" : "none";
  document.getElementById("paldexView").style.display = isBreeding ? "none" : "";
  document.getElementById("tabBreeding").classList.toggle("on", isBreeding);
  document.getElementById("tabPaldex").classList.toggle("on", !isBreeding);
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

  document.getElementById("tabBreeding").addEventListener("click", () => switchView("breeding"));
  document.getElementById("tabPaldex").addEventListener("click", () => switchView("paldex"));
  document.getElementById("paldexSearch").addEventListener("input", (e) => {
    renderPaldexList(e.target.value);
  });
  document.getElementById("paldexSortAiueo").addEventListener("click", () => setPaldexSort("aiueo"));
  document.getElementById("paldexSortNo").addEventListener("click", () => setPaldexSort("no"));
  document.getElementById("paldexWorkSort").addEventListener("change", (e) => setPaldexWorkSort(e.target.value));
  document.getElementById("paldexOwnedOnly").addEventListener("change", (e) => setPaldexOwnedOnly(e.target.checked));

  bindCarouselEvents();
}

// 計算結果カルーセル: パルタグ/コピー/ピンボタンのクリックはスライドが動的に再構築されるためイベント委譲で受ける。
// 矢印/ドット/手動スワイプ(scroll)のいずれからも現在位置(currentSlideIndex)を追従させる。
function bindCarouselEvents() {
  const carousel = document.getElementById("resultCarousel");

  carousel.addEventListener("click", (e) => {
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

function setTargetSort(mode) {
  targetSortMode = mode;
  document.getElementById("targetSortAiueo").classList.toggle("on", mode === "aiueo");
  document.getElementById("targetSortNo").classList.toggle("on", mode === "no");
  const searchVal = document.getElementById("targetSearch") ? document.getElementById("targetSearch").value : "";
  renderTargetSelect(searchVal);
}

// ---------- 配合ルート計算 ----------

// requiredPalIdが指定されていればfindBreedingRouteVia、無ければ通常のfindBreedingRouteを使う。
function computeRoute(targetPal, owned) {
  if (requiredPalId != null) {
    return findBreedingRouteVia(PALS, targetPal, owned, requiredPalId, BREEDING_EXAMPLES, 10);
  }
  return findBreedingRoute(PALS, targetPal, owned, BREEDING_EXAMPLES, 10);
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
  pushHistorySlide(targetPal, route, new Set(ownedIds), requiredPalId, { reset: true });
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
  pushHistorySlide(targetPal, route, new Set(ownedIds), requiredPalId, { reset: false });

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
function pushHistorySlide(targetPal, route, ownedIdSet, requiredId, { reset }) {
  transientMessage = null;
  if (reset) {
    resultHistory = [{ targetPal, route, ownedIdSet, requiredId }];
    historyCursor = 0;
  } else {
    resultHistory = resultHistory.slice(0, historyCursor + 1);
    resultHistory.push({ targetPal, route, ownedIdSet, requiredId });
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
    .map(targetPal => ({
      targetPal,
      route: computeRoute(targetPal, owned),
      ownedIdSet: new Set(ownedIds),
      requiredId: requiredPalId,
      pinned: true
    }));

  const historySlides = resultHistory
    .filter(h => !pinnedSet.has(h.targetPal.id))
    .map(h => ({ targetPal: h.targetPal, route: h.route, ownedIdSet: h.ownedIdSet, requiredId: h.requiredId, pinned: false }));

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
    htmlParts.push(buildSlideHtml(s.targetPal, s.route, s.ownedIdSet, s.requiredId, lastSlides.length, s.pinned));
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
function buildRouteText(targetPal, route, requiredId) {
  const requiredPal = requiredId != null ? PALS.find(p => p.id === requiredId) : null;
  const lines = [`「${targetPal.name}」まで${route.generations}世代の配合で到達`];
  route.steps.forEach((s, i) => {
    const usesRequired = requiredId != null && (s.parentA.id === requiredId || s.parentB.id === requiredId);
    lines.push(`${i + 1}世代目: ${s.parentA.name} × ${s.parentB.name} → ${s.child.name}${usesRequired ? "(経由指定)" : ""}`);
  });
  if (requiredPal) lines.push(`※「経由指定」は「${requiredPal.name}」を実際に配合に使ったステップです。`);
  return lines.join("\n");
}

// クリップボードコピー。file://で開いた場合など navigator.clipboard が使えない/失敗する環境向けに
// document.execCommand("copy") へのフォールバックを用意する。
async function copyRouteText(index) {
  const h = lastSlides[index];
  if (!h || h.message || !h.route.found) return;
  const text = buildRouteText(h.targetPal, h.route, h.requiredId);
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
// requiredId: そのスライド計算時点で指定されていた「必ず経由する所持パル」のid(未指定ならnull)。
function buildSlideHtml(targetPal, route, ownedIdSet, requiredId, slideIndex, pinned) {
  const requiredPal = requiredId != null ? PALS.find(p => p.id === requiredId) : null;
  const pinBtnHtml = `<button type="button" class="secondary pin-toggle-btn ${pinned ? "pinned" : ""}" data-pin-id="${targetPal.id}">${pinned ? "📌 ピン留め中" : "📌 ピン留めする"}</button>`;

  if (route.reason === "already-owned") {
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

  if (!route.found) {
    const summary = requiredPal
      ? `「${requiredPal.name}」を使った配合ルートは、10世代以内に「${targetPal.name}」へ到達できませんでした。`
      : `持っているパルの組み合わせでは、10世代以内に「${targetPal.name}」へ到達できませんでした。`;
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
    const ownedClass = isOwned ? "pal-tag-owned" : "pal-tag-bred";
    // 色分けは「配合で生まれるパル」同士の再利用を追うためのものなので、
    // 持っているパル(常に緑背景で固定)には適用しない。
    const color = !isOwned ? palColorMap.get(pal.id) : null;
    const colorStyle = color ? ` style="border-color:${color}; color:${color};"` : "";
    const icon = `<img class="pal-tag-icon" src="images/pal-${pal.paldexId.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.display='none'">`;
    return `<span class="pal-tag ${ownedClass}"${colorStyle} data-pal-id="${pal.id}" title="クリックでこのパルへの配合ルートを見る">${icon}${pal.name}</span>`;
  };

  const stepsHtml = route.steps.map((s, i) => {
    const usesRequired = requiredId != null && (s.parentA.id === requiredId || s.parentB.id === requiredId);
    return `
    <div class="route-step">
      <div class="route-gen-badge">${i + 1}</div>
      <div class="route-formula">
        ${palTag(s.parentA)} ×
        ${palTag(s.parentB)} →
        ${palTag(s.child)}
        ${usesRequired ? '<span class="badge required">経由指定</span>' : ""}
      </div>
    </div>
  `;
  }).join("");

  const requiredNote = requiredPal
    ? `<p class="hint" style="margin-top:6px;">※「経由指定」バッジは「${requiredPal.name}」を実際に配合に使ったステップです。</p>`
    : "";

  return `
    <div class="result-slide">
      <div class="route-actions">
        <p class="result-summary">「${targetPal.name}」まで <strong>${route.generations}世代</strong> の配合で到達できます。</p>
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
    </div>
  `;
}
