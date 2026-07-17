// Palworld 配合(交配)計算ロジック
// データベース検索方式 ＋ 未知の組み合わせは公式Rank式フォールバック
// 公式: 子のCombi Rank = floor((親1power + 親2power + 1) / 2)
// ※power(Combi Rank)は値が低いほどレア・強力、高いほど雑魚(最大1500程度)。

function computeChildPower(powerA, powerB) {
  return Math.floor((powerA + powerB + 1) / 2);
}

// 指定したパワー値に対して最も近いパルを探す（同差の場合はPaldex番号が小さい方を優先）
function findClosestPals(pals, targetPower) {
  let bestDiff = Infinity;
  let candidates = [];
  for (const p of pals) {
    const diff = Math.abs(p.power - targetPower);
    if (diff < bestDiff) {
      bestDiff = diff;
      candidates = [p];
    } else if (diff === bestDiff) {
      candidates.push(p);
    }
  }
  candidates.sort((a, b) => a.id - b.id);
  return { diff: bestDiff, candidates, winner: candidates[0] };
}

// 親2体を配合した結果生まれる子(1体)を返す
function breedOnce(pals, parentA, parentB, exampleMap = {}) {
  // 1. 実例データベース優先検索
  const sortedNames = [parentA.name, parentB.name].sort();
  const key = `${sortedNames[0]},${sortedNames[1]}`;
  if (exampleMap && exampleMap[key]) {
    const childName = exampleMap[key];
    const childPal = pals.find(p => p.name === childName);
    if (childPal) {
      return {
        child: childPal,
        childPower: childPal.power,
        exact: true,
        isExample: true,
        tiedWith: []
      };
    }
  }

  // 2. 実例にない場合の公式Rankフォールバック
  // どちらかのpower(Combi Rank)が未設定の場合は計算不能なので、フォールバックせず「不明」を返す。
  if (parentA.power == null || parentB.power == null) {
    return { child: null, childPower: null, exact: false, isExample: false, unknown: true, tiedWith: [] };
  }

  const childPower = computeChildPower(parentA.power, parentB.power);
  const { diff, candidates, winner } = findClosestPals(pals, childPower);
  return {
    child: winner,
    childPower,
    exact: diff === 0,
    isExample: false,
    tiedWith: candidates.filter(c => c.id !== winner.id)
  };
}

// targetPal を1回の配合で作れる親の組み合わせを全探索する(全パル総当り用)
// pals: 全パルリスト, targetPal: 目的のパル, ownedIds: 手持ちパルのidの配列(nullなら全パル対象)
function findBreedingCombos(pals, targetPal, ownedIds = null, exampleMap = {}) {
  const pool = ownedIds
    ? pals.filter(p => ownedIds.includes(p.id))
    : pals;

  const results = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      const { child, childPower, exact, isExample, unknown, tiedWith } = breedOnce(pals, a, b, exampleMap);
      if (unknown) continue;

      if (child.id === targetPal.id) {
        results.push({
          parentA: a,
          parentB: b,
          childPower,
          exact,
          isExample,
          tiedWith: tiedWith.map(c => c.name)
        });
      }
    }
  }

  // 実例一致しているものを最優先し、次に完全一致、その他でソート
  results.sort((r1, r2) => {
    if (r1.isExample !== r2.isExample) return r1.isExample ? -1 : 1;
    if (r1.exact !== r2.exact) return r1.exact ? -1 : 1;
    return 0;
  });

  return results;
}

// 手持ちパルを起点に、目的のパルへ到達するまでの配合経路を幅優先探索で求める。
// 各世代で「今まで手に入っているパル全部」同士を掛け合わせて生まれる新しいパルを
// 手持ちに追加していき、目的のパルが生まれた時点の経路を返す。
// pals: 全パルデータ, targetPal: 目的のパル, ownedPals: 手持ちパル配列, maxGenerations: 最大世代数
// 戻り値: { found: bool, generations: number, steps: [{parentA, parentB, child, childPower, exact, isExample}], ownedAtEnd: [Pal] } | null
function findBreedingRoute(pals, targetPal, ownedPals, exampleMap = {}, maxGenerations = 6) {
  if (ownedPals.some(p => p.id === targetPal.id)) {
    return { found: true, generations: 0, steps: [], reason: "already-owned" };
  }
  if (ownedPals.length === 0) {
    return { found: false, generations: 0, steps: [], reason: "no-owned-pals" };
  }

  // ownedのidセットと、そのパルがどうやって手に入ったか(手持ち初期 or 配合)を記録
  const obtainedIds = new Set(ownedPals.map(p => p.id));
  const obtainedVia = new Map(); // id -> {parentA, parentB, childPower, exact, isExample} 手持ち初期はundefined
  let frontier = [...ownedPals]; // 今の世代で使える全パル(このgenerationまでに手に入った分)

  for (let gen = 1; gen <= maxGenerations; gen++) {
    const pool = [...obtainedIds].map(id => pals.find(p => p.id === id));
    const newlyObtained = []; // このgenerationで新しく生まれたパル
    const newlyObtainedFirstParents = new Map(); // id -> {parentA, parentB, childPower, exact, isExample}

    for (let i = 0; i < pool.length; i++) {
      for (let j = i; j < pool.length; j++) {
        const a = pool[i];
        const b = pool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;

        if (!obtainedIds.has(child.id) && !newlyObtainedFirstParents.has(child.id)) {
          newlyObtainedFirstParents.set(child.id, { parentA: a, parentB: b, childPower, exact, isExample });
          newlyObtained.push(child);
        }
      }
    }

    for (const child of newlyObtained) {
      obtainedIds.add(child.id);
      obtainedVia.set(child.id, newlyObtainedFirstParents.get(child.id));
    }

    if (obtainedIds.has(targetPal.id)) {
      // targetPalに至る経路を逆算でたどる
      const steps = [];
      const visited = new Set();

      function backtrack(id) {
        if (visited.has(id)) return;
        visited.add(id);
        const via = obtainedVia.get(id);
        if (!via) return; // 手持ち初期パルはステップなし
        backtrack(via.parentA.id);
        backtrack(via.parentB.id);
        steps.push({
          parentA: via.parentA,
          parentB: via.parentB,
          child: pals.find(p => p.id === id),
          childPower: via.childPower,
          exact: via.exact,
          isExample: via.isExample
        });
      }
      backtrack(targetPal.id);

      return { found: true, generations: gen, steps, reason: "bred" };
    }

    if (newlyObtained.length === 0) {
      // これ以上新しいパルが生まれない(手詰まり)
      break;
    }
  }

  return { found: false, generations: maxGenerations, steps: [], reason: "not-found-within-limit" };
}

// findBreedingRouteと同様だが、「requiredPalIdで指定した所持パルを、経路のどこかで実際に
// 配合の親として使ったルート」だけを探す。単に持っているだけでは条件を満たさない。
//
// 世代ごとの閉包集合を2色に分けて育てる:
//   withoutIds: 経由必須パルをまだ親として使っていない系統で手に入るパル(初期値=手持ち全部。
//               経由必須パル自身もここに留まり続け、何度でも他のパルとの組み合わせに使える)
//   withIds:    経由必須パルを既に親として使った系統で手に入るパル(初期値=空)
// without×without の結果は通常without行き、ただし片方が経由必須パル自身ならwithへ昇格。
// with×(without∪with) の結果は常にwith行き(既に経由済みの系統なので)。
// targetPalがwithIdsに現れた時点で確定・backtrackする。
function findBreedingRouteVia(pals, targetPal, ownedPals, requiredPalId, exampleMap = {}, maxGenerations = 10) {
  if (!ownedPals.some(p => p.id === requiredPalId)) {
    return { found: false, generations: 0, steps: [], reason: "required-pal-not-owned" };
  }
  if (ownedPals.some(p => p.id === targetPal.id)) {
    return { found: true, generations: 0, steps: [], reason: "already-owned" };
  }
  if (ownedPals.length === 0) {
    return { found: false, generations: 0, steps: [], reason: "no-owned-pals" };
  }

  // 同じパル(id)がwithout側/with側の両方に別々に存在しうる(例: 違う親同士を配合したら
  // たまたま経由必須パルと同じ種が生まれた、等)ため、backtrackは id 単体ではなく
  // 「id + どちらの色から来た参照か」で管理する。via側にも親それぞれの色を記録しておく。
  const withoutIds = new Set(ownedPals.map(p => p.id));
  const withIds = new Set();
  const viaWithout = new Map(); // id -> { parentA, parentAColor, parentB, parentBColor, childPower, exact, isExample }
  const viaWith = new Map();

  for (let gen = 1; gen <= maxGenerations; gen++) {
    const withoutPool = [...withoutIds].map(id => pals.find(p => p.id === id));
    const withPool = [...withIds].map(id => pals.find(p => p.id === id));

    const newWithout = [];
    const newWithoutParents = new Map();
    const newWith = [];
    const newWithParents = new Map();

    // 1. without × without (両方とも"without"色)
    for (let i = 0; i < withoutPool.length; i++) {
      for (let j = i; j < withoutPool.length; j++) {
        const a = withoutPool[i], b = withoutPool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;

        // 経由必須パルを自分自身とだけ配合しても実質的には何も進んでいないので「使った」扱いにしない
        // (同じ種を持ったままwith集合へ無意味に昇格させてしまうのを防ぐ)。
        const usesRequired = (a.id === requiredPalId || b.id === requiredPalId) && a.id !== b.id;
        const entry = { parentA: a, parentAColor: "without", parentB: b, parentBColor: "without", childPower, exact, isExample };
        if (usesRequired) {
          if (!withIds.has(child.id) && !newWithParents.has(child.id)) {
            newWithParents.set(child.id, entry);
            newWith.push(child);
          }
        } else {
          if (!withoutIds.has(child.id) && !newWithoutParents.has(child.id)) {
            newWithoutParents.set(child.id, entry);
            newWithout.push(child);
          }
        }
      }
    }

    // 2a. with × without ("with"色 × "without"色、常にwith行き)
    for (const a of withPool) {
      for (const b of withoutPool) {
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (!withIds.has(child.id) && !newWithParents.has(child.id)) {
          newWithParents.set(child.id, { parentA: a, parentAColor: "with", parentB: b, parentBColor: "without", childPower, exact, isExample });
          newWith.push(child);
        }
      }
    }

    // 2b. with × with (両方とも"with"色、常にwith行き)
    for (let i = 0; i < withPool.length; i++) {
      for (let j = i; j < withPool.length; j++) {
        const a = withPool[i], b = withPool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (!withIds.has(child.id) && !newWithParents.has(child.id)) {
          newWithParents.set(child.id, { parentA: a, parentAColor: "with", parentB: b, parentBColor: "with", childPower, exact, isExample });
          newWith.push(child);
        }
      }
    }

    for (const c of newWithout) {
      withoutIds.add(c.id);
      viaWithout.set(c.id, newWithoutParents.get(c.id));
    }
    for (const c of newWith) {
      withIds.add(c.id);
      viaWith.set(c.id, newWithParents.get(c.id));
    }

    if (withIds.has(targetPal.id)) {
      const steps = [];
      const visited = new Set();

      function backtrack(id, color) {
        const key = color + ":" + id;
        if (visited.has(key)) return;
        visited.add(key);
        const via = color === "with" ? viaWith.get(id) : viaWithout.get(id);
        if (!via) return; // 手持ち初期パルはこの色ではステップなし(=もともと持っていた個体)
        backtrack(via.parentA.id, via.parentAColor);
        backtrack(via.parentB.id, via.parentBColor);
        steps.push({
          parentA: via.parentA,
          parentB: via.parentB,
          child: pals.find(p => p.id === id),
          childPower: via.childPower,
          exact: via.exact,
          isExample: via.isExample
        });
      }
      backtrack(targetPal.id, "with");

      return { found: true, generations: gen, steps, reason: "bred-via" };
    }

    if (newWithout.length === 0 && newWith.length === 0) {
      break;
    }
  }

  return { found: false, generations: maxGenerations, steps: [], reason: "not-found-within-limit" };
}

// タマゴサイズ別の孵化時間の目安(時間)。
// 出典: palworld.wiki.gg「Egg Incubator」記事のIncubation Time表、
// 適温でない場合(インキュベーション速度×1.0)の値を基準に採用(適温にすると最大半分まで短縮される)。
const EGG_HATCH_HOURS = { Normal: 6, Large: 36, Huge: 72 };

function getHatchHours(pal) {
  return pal.eggSize ? (EGG_HATCH_HOURS[pal.eggSize] != null ? EGG_HATCH_HOURS[pal.eggSize] : null) : null;
}

// 「世代数」ではなく「配合で生まれるタマゴの孵化時間の合計」が最小になる経路をダイクストラ法で探す。
// 複数の配合を並行して進められる(=両親がそれぞれ独立に用意できるなら待ち時間は長い方だけで済む)ことを
// 前提に、あるパルを手に入れるまでのコストを「両親のコストの大きい方 + 自分自身のタマゴの孵化時間」として
// 定義し、これを状態ごとの最短コストとして確定させていく(コストに負値が無いためダイクストラ法が使える)。
// タマゴサイズ(孵化時間)が不明なパルが生まれる組み合わせは、不明な値を仮定せず経路から除外する。
//
// requiredPalIdを指定した場合はfindBreedingRouteViaと同様、状態を「経由必須パルを実際に配合の親として
// 使ったか(color: "with"/"without")」で2色に分けて管理し、それぞれ独立に最短コストを求める。
// requiredPalIdが未指定の場合は常に"without"色のみを使う(色の区別を実質無視する)。
//
// 戻り値: { found, totalHatchHours, steps: [{parentA, parentB, child, hatchHours, exact, isExample}], reason }
function findBreedingRouteMinHatchTime(pals, targetPal, ownedPals, exampleMap = {}, requiredPalId = null) {
  if (requiredPalId != null && !ownedPals.some(p => p.id === requiredPalId)) {
    return { found: false, totalHatchHours: 0, steps: [], reason: "required-pal-not-owned" };
  }
  if (ownedPals.some(p => p.id === targetPal.id)) {
    return { found: true, totalHatchHours: 0, steps: [], reason: "already-owned" };
  }
  if (ownedPals.length === 0) {
    return { found: false, totalHatchHours: 0, steps: [], reason: "no-owned-pals" };
  }

  const key = (id, color) => `${id}:${color}`;
  const dist = new Map(); // "id:color" -> 現時点で判明している最短の合計孵化時間(時間)
  const via = new Map(); // "id:color" -> {parentAKey, parentBKey, parentA, parentB, child, hatchHours, exact, isExample}
  const finalized = new Set();

  // lazy-deletion方式の単純な二分ヒープ(状態数は最大 パル数×2 程度なので十分高速)
  const heap = [];
  function heapPush(d, k) {
    heap.push([d, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }
  function heapPop() {
    if (heap.length === 0) return null;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let smallest = i;
        if (l < heap.length && heap[l][0] < heap[smallest][0]) smallest = l;
        if (r < heap.length && heap[r][0] < heap[smallest][0]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }

  for (const p of ownedPals) {
    const k = key(p.id, "without");
    if (!dist.has(k)) {
      dist.set(k, 0);
      heapPush(0, k);
    }
  }

  const targetKeyGoal = key(targetPal.id, requiredPalId != null ? "with" : "without");
  let found = false;

  while (heap.length > 0) {
    const [d, uKey] = heapPop();
    if (finalized.has(uKey)) continue; // 古いエントリ
    if (d > dist.get(uKey)) continue; // より良い値が既に見つかっている古いエントリ
    finalized.add(uKey);
    if (uKey === targetKeyGoal) { found = true; break; }

    const sep = uKey.lastIndexOf(":");
    const uId = Number(uKey.slice(0, sep));
    const uColor = uKey.slice(sep + 1);
    const uPal = pals.find(p => p.id === uId);

    for (const vKey of finalized) {
      const vSep = vKey.lastIndexOf(":");
      const vId = Number(vKey.slice(0, vSep));
      const vColor = vKey.slice(vSep + 1);
      const vPal = pals.find(p => p.id === vId);
      const vDist = dist.get(vKey);

      const { child, exact, isExample, unknown } = breedOnce(pals, uPal, vPal, exampleMap);
      if (unknown) continue;
      const hatchHours = getHatchHours(child);
      if (hatchHours == null) continue; // 孵化時間不明なパルが生まれる組み合わせは採用しない

      const usesRequired = requiredPalId != null && (uPal.id === requiredPalId || vPal.id === requiredPalId) && uPal.id !== vPal.id;
      const childColor = (uColor === "with" || vColor === "with" || usesRequired) ? "with" : "without";
      const newCost = Math.max(d, vDist) + hatchHours;
      const childKey = key(child.id, childColor);
      const cur = dist.has(childKey) ? dist.get(childKey) : Infinity;
      if (newCost < cur) {
        dist.set(childKey, newCost);
        via.set(childKey, { parentAKey: uKey, parentBKey: vKey, parentA: uPal, parentB: vPal, child, hatchHours, exact, isExample });
        heapPush(newCost, childKey);
      }
    }
  }

  if (!found) {
    return { found: false, totalHatchHours: 0, steps: [], reason: "not-found" };
  }

  const steps = [];
  const visited = new Set();
  function backtrack(k) {
    if (visited.has(k)) return;
    visited.add(k);
    const v = via.get(k);
    if (!v) return; // 手持ち初期パル(コスト0)はここで終端
    backtrack(v.parentAKey);
    backtrack(v.parentBKey);
    steps.push({
      parentA: v.parentA,
      parentB: v.parentB,
      child: v.child,
      hatchHours: v.hatchHours,
      exact: v.exact,
      isExample: v.isExample
    });
  }
  backtrack(targetKeyGoal);

  return {
    found: true,
    totalHatchHours: dist.get(targetKeyGoal),
    steps,
    reason: requiredPalId != null ? "bred-via-min-hatch" : "bred-min-hatch"
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    computeChildPower, findClosestPals, breedOnce, findBreedingCombos, findBreedingRoute, findBreedingRouteVia,
    EGG_HATCH_HOURS, getHatchHours, findBreedingRouteMinHatchTime
  };
}
