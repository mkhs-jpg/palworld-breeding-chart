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

init();

function init() {
  loadPalsData().then(() => {
    loadOwned();
    renderTargetSelect();
    renderOwnedToggleList();
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
    });
  });

  updateOwnedCount();
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

function calcRoute() {
  if (!selectedTargetId) {
    document.getElementById("calcResult").innerHTML =
      `<p class="hint">②で作りたいパルを選択してください。</p>`;
    return;
  }
  const targetPal = PALS.find(p => p.id === selectedTargetId);
  const owned = PALS.filter(p => ownedIds.has(p.id));

  if (owned.length === 0) {
    document.getElementById("calcResult").innerHTML =
      `<p class="hint">①で持っているパルを1体以上選んでください。</p>`;
    return;
  }

  const route = findBreedingRoute(PALS, targetPal, owned, BREEDING_EXAMPLES, 10);
  renderRouteResult(targetPal, route, ownedIds);
}

// パル名クリックで、そのパルを新たな「作りたいパル」として選択し直し、即座に再計算する
function jumpToTarget(palId) {
  selectedTargetId = palId;
  document.getElementById("targetPalSelect").value = palId;
  renderTargetSelect(document.getElementById("targetSearch").value);
  document.getElementById("calcResult").scrollIntoView({ behavior: "smooth", block: "start" });
  calcRoute();
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

function renderRouteResult(targetPal, route, ownedIdSet) {
  const container = document.getElementById("calcResult");

  if (route.reason === "already-owned") {
    container.innerHTML = `<p class="result-summary">「${targetPal.name}」はすでに持っているパルの中にあります。</p>`;
    return;
  }

  if (!route.found) {
    container.innerHTML = `
      <p class="result-summary">持っているパルの組み合わせでは、10世代以内に「${targetPal.name}」へ到達できませんでした。</p>
      <p class="hint">中間素材となるパルを他の方法で入手すると経路が見つかりやすくなります。</p>
    `;
    return;
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

  const stepsHtml = route.steps.map((s, i) => `
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
      </div>
    </div>
  `).join("");

  container.innerHTML = `
    <p class="result-summary">「${targetPal.name}」まで <strong>${route.generations}世代</strong> の配合で到達できます。</p>
    <div class="route-legend">
      <span class="legend-item"><span class="legend-swatch legend-owned"></span>持っているパル</span>
      <span class="legend-item"><span class="legend-swatch legend-bred"></span>配合で生まれるパル</span>
      <span class="legend-item">パル名をクリックするとそのパルへのルートを表示します</span>
    </div>
    <div>${stepsHtml}</div>
    <p class="hint" style="margin-top:10px;">※「実例一致」は実機または配合表サイトで確認された信頼性の高い配合ルートです。「推定」は実例がない組み合わせに対して公式Rank値計算を適用した予測結果です。</p>
  `;

  container.querySelectorAll(".pal-tag[data-pal-id]").forEach(el => {
    el.addEventListener("click", () => {
      jumpToTarget(Number(el.dataset.palId));
    });
  });
}
