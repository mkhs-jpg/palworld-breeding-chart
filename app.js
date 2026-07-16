// パル配合ルート検索 メインロジック
// breeding.js の findBreedingRoute / findBreedingCombos を利用する

const LS_KEYS = {
  pals: "pbh_pals_data",
  owned: "pbh_owned_ids"
};
const DATA_VERSION = 8; // pals-data.jsonのversionと一致させる。同梱データを更新したら上げる

let PALS = [];
let BREEDING_EXAMPLES = {};
let ownedIds = new Set();
let ownedSortMode = "aiueo"; // "aiueo" | "no"
let targetSortMode = "aiueo";
let selectedTargetId = null;
let requiredPalId = null; // ②で指定した「必ず経由する所持パル」(任意、未指定はnull)

// 計算結果のスワイプ履歴(①②③で計算した「作りたいパル」の結果を最大件数分さかのぼれる)
const MAX_HISTORY = 5;
let resultHistory = []; // [{ targetPal, route, ownedIdSet, requiredPalId }]
let currentSlideIndex = -1;

init();

function init() {
  loadPalsData().then(() => {
    loadOwned();
    renderTargetSelect();
    renderOwnedToggleList();
    renderRequiredToggleList();
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
    <div class="owned-toggle ${selectedTargetId === p.id ? 'on' : ''}" data-id="${p.id}">${p.name}</div>
  `).join("");

  list.querySelectorAll(".owned-toggle").forEach(el => {
    el.addEventListener("click", () => {
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
  });

  updateTargetSelected();
}

function updateTargetSelected() {
  const el = document.getElementById("targetSelected");
  if (selectedTargetId) {
    const pal = PALS.find(p => p.id === selectedTargetId);
    el.textContent = pal ? `選択中: ${pal.name}${pal.nameEn ? "（" + pal.nameEn + "）" : ""}` : "未選択";
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

  bindCarouselEvents();
}

// 計算結果カルーセル: パルタグのクリックはスライドが動的に再構築されるためイベント委譲で受ける。
// 矢印/ドット/手動スワイプ(scroll)のいずれからも現在位置(currentSlideIndex)を追従させる。
function bindCarouselEvents() {
  const carousel = document.getElementById("resultCarousel");

  carousel.addEventListener("click", (e) => {
    const tag = e.target.closest(".pal-tag[data-pal-id]");
    if (tag) jumpToTarget(Number(tag.dataset.palId));
  });

  let scrollDebounce = null;
  carousel.addEventListener("scroll", () => {
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      if (resultHistory.length <= 1) return;
      const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
      if (idx !== currentSlideIndex && idx >= 0 && idx < resultHistory.length) {
        currentSlideIndex = idx;
        updateDots();
      }
    }, 120);
  });

  document.getElementById("carouselPrev").addEventListener("click", () => {
    if (currentSlideIndex > 0) {
      currentSlideIndex--;
      scrollToSlide(currentSlideIndex);
      updateDots();
    }
  });
  document.getElementById("carouselNext").addEventListener("click", () => {
    if (currentSlideIndex < resultHistory.length - 1) {
      currentSlideIndex++;
      scrollToSlide(currentSlideIndex);
      updateDots();
    }
  });
  document.getElementById("resultDots").addEventListener("click", (e) => {
    const dot = e.target.closest(".result-dot[data-index]");
    if (dot) {
      currentSlideIndex = Number(dot.dataset.index);
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

// 計算結果カルーセルに単発のメッセージ(未選択時の案内等)だけを表示し、履歴はクリアする。
function showCarouselMessage(html) {
  resultHistory = [];
  currentSlideIndex = -1;
  document.getElementById("resultCarousel").innerHTML = `<div class="result-slide">${html}</div>`;
  document.getElementById("carouselPrev").style.display = "none";
  document.getElementById("carouselNext").style.display = "none";
  document.getElementById("resultDots").innerHTML = "";
}

// resultHistoryにスライドを積んでカルーセルを再描画する。
// reset:true は新しい調査の起点(履歴を1件にリセット)、false は現在位置より後ろを切り捨てて追加。
function pushHistorySlide(targetPal, route, ownedIdSet, requiredId, { reset }) {
  if (reset) {
    resultHistory = [{ targetPal, route, ownedIdSet, requiredId }];
    currentSlideIndex = 0;
  } else {
    resultHistory = resultHistory.slice(0, currentSlideIndex + 1);
    resultHistory.push({ targetPal, route, ownedIdSet, requiredId });
    if (resultHistory.length > MAX_HISTORY) resultHistory.shift();
    currentSlideIndex = resultHistory.length - 1;
  }
  renderCarousel();
}

function renderCarousel() {
  const carousel = document.getElementById("resultCarousel");
  const prevBtn = document.getElementById("carouselPrev");
  const nextBtn = document.getElementById("carouselNext");
  const dots = document.getElementById("resultDots");

  carousel.innerHTML = resultHistory
    .map(h => buildSlideHtml(h.targetPal, h.route, h.ownedIdSet, h.requiredId))
    .join("");

  const showControls = resultHistory.length > 1;
  prevBtn.style.display = showControls ? "flex" : "none";
  nextBtn.style.display = showControls ? "flex" : "none";
  dots.innerHTML = showControls
    ? resultHistory
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
function buildSlideHtml(targetPal, route, ownedIdSet, requiredId) {
  const requiredPal = requiredId != null ? PALS.find(p => p.id === requiredId) : null;

  if (route.reason === "already-owned") {
    return `<div class="result-slide"><p class="result-summary">「${targetPal.name}」はすでに持っているパルの中にあります。</p></div>`;
  }

  if (route.reason === "required-pal-not-owned") {
    return `<div class="result-slide"><p class="result-summary">経由指定したパルが所持パルから外れています。②で選び直してください。</p></div>`;
  }

  if (!route.found) {
    const summary = requiredPal
      ? `「${requiredPal.name}」を使った配合ルートは、10世代以内に「${targetPal.name}」へ到達できませんでした。`
      : `持っているパルの組み合わせでは、10世代以内に「${targetPal.name}」へ到達できませんでした。`;
    return `
      <div class="result-slide">
        <p class="result-summary">${summary}</p>
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
    return `<span class="pal-tag ${ownedClass}"${colorStyle} data-pal-id="${pal.id}" title="クリックでこのパルへの配合ルートを見る">${pal.name}</span>`;
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
        ${s.isExample
          ? '<span class="badge exact">実例一致</span>'
          : s.exact
            ? '<span class="badge approx-exact">推定(完全)</span>'
            : '<span class="badge approx">推定(最近傍)</span>'}
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
      <p class="result-summary">「${targetPal.name}」まで <strong>${route.generations}世代</strong> の配合で到達できます。</p>
      <div class="route-legend">
        <span class="legend-item"><span class="legend-swatch legend-owned"></span>持っているパル</span>
        <span class="legend-item"><span class="legend-swatch legend-bred"></span>配合で生まれるパル</span>
        <span class="legend-item">パル名をクリックするとそのパルへのルートを表示します</span>
      </div>
      <div>${stepsHtml}</div>
      <p class="hint" style="margin-top:10px;">※「実例一致」は実機または配合表サイトで確認された信頼性の高い配合ルートです。「推定」は実例がない組み合わせに対して公式Rank値計算を適用した予測結果です。</p>
      ${requiredNote}
    </div>
  `;
}
