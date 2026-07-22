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
// 世代数(依存関係の深さ)を最優先で最小化しつつ、同じ世代内で複数の親ペアから同じ子が
// 作れる場合は「そのペアを得るまでに必要な配合回数の概算(stepsCost)」が少ない方を選ぶことで、
// 世代数が同じ中では配合の総回数もなるべく少なくなるようにする(単純な最初に見つかった組み合わせ
// 採用ではなく、コスト比較で選ぶ)。
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
  // 各パルを得るまでに必要な配合回数の概算(親同士の重複=同じパルの再利用は考慮しない単純合算のため、
  // 実際の最終ステップ数の下限目安。同じ世代内での親ペア選びのタイブレークにのみ使う)。
  const stepsCost = new Map(ownedPals.map(p => [p.id, 0]));

  for (let gen = 1; gen <= maxGenerations; gen++) {
    const pool = [...obtainedIds].map(id => pals.find(p => p.id === id));
    const newlyObtained = []; // このgenerationで新しく生まれたパル
    const newlyObtainedBestParents = new Map(); // id -> {parentA, parentB, childPower, exact, isExample, cost}

    for (let i = 0; i < pool.length; i++) {
      for (let j = i; j < pool.length; j++) {
        const a = pool[i];
        const b = pool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (obtainedIds.has(child.id)) continue;

        const cost = stepsCost.get(a.id) + stepsCost.get(b.id) + 1;
        const existing = newlyObtainedBestParents.get(child.id);
        if (!existing || cost < existing.cost) {
          if (!existing) newlyObtained.push(child);
          newlyObtainedBestParents.set(child.id, { parentA: a, parentB: b, childPower, exact, isExample, cost });
        }
      }
    }

    for (const child of newlyObtained) {
      obtainedIds.add(child.id);
      const best = newlyObtainedBestParents.get(child.id);
      obtainedVia.set(child.id, best);
      stepsCost.set(child.id, best.cost);
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

// findBreedingRouteと同様だが、「requiredPalIdsで指定した所持パルのうち少なくとも1匹を、経路の
// どこかで実際に配合の親として使ったルート」だけを探す(OR条件。全員を使う必要は無い、単に
// 持っているだけでは条件を満たさない)。requiredPalIdsが空配列の場合はfindBreedingRouteと完全に
// 同じ挙動になる。
//
// 世代ごとの閉包集合を2色に分けて育てる:
//   withoutIds: 経由必須パルを1匹も親として使っていない系統で手に入るパル(初期値=手持ち全部。
//               経由必須パル自身もここに留まり続け、何度でも他のパルとの組み合わせに使える)
//   withIds:    経由必須パルを少なくとも1匹、既に親として使った系統で手に入るパル(初期値=空)
// without×without の結果は通常without行き、ただし片方が経由必須パルのいずれかならwithへ昇格。
// with×(without∪with) の結果は常にwith行き(既に経由済みの系統なので)。
// targetPalがwithIdsに現れた時点で確定・backtrackする。
function findBreedingRouteVia(pals, targetPal, ownedPals, requiredPalIds, exampleMap = {}, maxGenerations = 10) {
  const reqIdSet = new Set(requiredPalIds || []);
  if (reqIdSet.size === 0) {
    return findBreedingRoute(pals, targetPal, ownedPals, exampleMap, maxGenerations);
  }
  if (![...reqIdSet].some(id => ownedPals.some(p => p.id === id))) {
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
  // findBreedingRouteと同様、同じ世代内で複数の親ペアから同じ子が作れる場合は
  // 配合回数の概算(stepsCost、色ごとに別管理)が少ない方を選ぶ。
  const withoutIds = new Set(ownedPals.map(p => p.id));
  const withIds = new Set();
  const viaWithout = new Map(); // id -> { parentA, parentAColor, parentB, parentBColor, childPower, exact, isExample, cost }
  const viaWith = new Map();
  const stepsCostWithout = new Map(ownedPals.map(p => [p.id, 0]));
  const stepsCostWith = new Map();

  for (let gen = 1; gen <= maxGenerations; gen++) {
    const withoutPool = [...withoutIds].map(id => pals.find(p => p.id === id));
    const withPool = [...withIds].map(id => pals.find(p => p.id === id));

    const newWithout = [];
    const newWithoutParents = new Map();
    const newWith = [];
    const newWithParents = new Map();

    const considerWithout = (child, entry, cost) => {
      const existing = newWithoutParents.get(child.id);
      if (!existing || cost < existing.cost) {
        if (!existing) newWithout.push(child);
        newWithoutParents.set(child.id, { ...entry, cost });
      }
    };
    const considerWith = (child, entry, cost) => {
      const existing = newWithParents.get(child.id);
      if (!existing || cost < existing.cost) {
        if (!existing) newWith.push(child);
        newWithParents.set(child.id, { ...entry, cost });
      }
    };

    // 1. without × without (両方とも"without"色)
    for (let i = 0; i < withoutPool.length; i++) {
      for (let j = i; j < withoutPool.length; j++) {
        const a = withoutPool[i], b = withoutPool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;

        // 経由必須パルを自分自身とだけ配合しても実質的には何も進んでいないので「使った」扱いにしない
        // (同じ種を持ったままwith集合へ無意味に昇格させてしまうのを防ぐ)。
        const usesRequired = (reqIdSet.has(a.id) || reqIdSet.has(b.id)) && a.id !== b.id;
        const entry = { parentA: a, parentAColor: "without", parentB: b, parentBColor: "without", childPower, exact, isExample };
        const cost = stepsCostWithout.get(a.id) + stepsCostWithout.get(b.id) + 1;
        if (usesRequired) {
          if (!withIds.has(child.id)) considerWith(child, entry, cost);
        } else {
          if (!withoutIds.has(child.id)) considerWithout(child, entry, cost);
        }
      }
    }

    // 2a. with × without ("with"色 × "without"色、常にwith行き)
    for (const a of withPool) {
      for (const b of withoutPool) {
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (withIds.has(child.id)) continue;
        const cost = stepsCostWith.get(a.id) + stepsCostWithout.get(b.id) + 1;
        considerWith(child, { parentA: a, parentAColor: "with", parentB: b, parentBColor: "without", childPower, exact, isExample }, cost);
      }
    }

    // 2b. with × with (両方とも"with"色、常にwith行き)
    for (let i = 0; i < withPool.length; i++) {
      for (let j = i; j < withPool.length; j++) {
        const a = withPool[i], b = withPool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (withIds.has(child.id)) continue;
        const cost = stepsCostWith.get(a.id) + stepsCostWith.get(b.id) + 1;
        considerWith(child, { parentA: a, parentAColor: "with", parentB: b, parentBColor: "with", childPower, exact, isExample }, cost);
      }
    }

    for (const c of newWithout) {
      withoutIds.add(c.id);
      const best = newWithoutParents.get(c.id);
      viaWithout.set(c.id, best);
      stepsCostWithout.set(c.id, best.cost);
    }
    for (const c of newWith) {
      withIds.add(c.id);
      const best = newWithParents.get(c.id);
      viaWith.set(c.id, best);
      stepsCostWith.set(c.id, best.cost);
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

// findBreedingRouteViaのAND版。「requiredGroupsで指定したグループそれぞれについて、
// 少なくとも1匹をそのグループのメンバーから経路のどこかで実際に配合の親として使ったルート」を探す
// (グループ内はOR、グループ間はAND)。requiredGroupsは配列の配列(例: 各スキルごとの候補パルid配列)で、
// 1グループ1要素なら「その個体を必ず使う」、1グループのみなら「その中の誰か1匹を使う」の意味になる
// (前者は個々のパル全員必須、後者は②本体のOR条件と同じ意味になり、この関数はどちらも表現できる)。
// requiredGroupsが空(またはグループが無い)場合はfindBreedingRouteと完全に同じ挙動になる。
//
// OR版(findBreedingRouteVia)の「使ったか(with)/未使用か(without)」の2状態では「どのグループを
// 満たしたか」を区別できないため、グループiごとに1ビットを割り当てたビットマスクで「これまでに
// 満たしたグループの集合」を管理し、全ビットが立った状態(fullMask)にtargetPalが到達した時点で
// 全グループを満たしたとみなし確定する(マスクは配合するたびに単調に増加していくだけなので、
// 負のコストが無いのと同様に無限ループの心配は無い)。1匹のパルが複数グループに同時に属する場合
// (例: 1匹で2つのスキルを持っている)は、そのパルを親に使った時点で該当する全ビットが一度に立つ。
function findBreedingRouteViaAll(pals, targetPal, ownedPals, requiredGroups, exampleMap = {}, maxGenerations = 10) {
  const groups = (requiredGroups || []).map(g => [...new Set(g || [])]).filter(g => g.length > 0);
  if (groups.length === 0) {
    return findBreedingRoute(pals, targetPal, ownedPals, exampleMap, maxGenerations);
  }
  if (!groups.every(g => g.some(id => ownedPals.some(p => p.id === id)))) {
    return { found: false, generations: 0, steps: [], reason: "required-pal-not-owned" };
  }
  if (ownedPals.some(p => p.id === targetPal.id)) {
    return { found: true, generations: 0, steps: [], reason: "already-owned" };
  }
  if (ownedPals.length === 0) {
    return { found: false, generations: 0, steps: [], reason: "no-owned-pals" };
  }

  const bitOf = new Map();
  groups.forEach((g, i) => {
    const bit = 1 << i;
    for (const id of g) bitOf.set(id, (bitOf.get(id) || 0) | bit);
  });
  const fullMask = (1 << groups.length) - 1;
  const stateKey = (id, mask) => `${id}:${mask}`;

  // obtainedByMask.get(mask) = そのmaskちょうどで到達可能なパルidの集合
  const obtainedByMask = new Map([[0, new Set(ownedPals.map(p => p.id))]]);
  const via = new Map(); // "id:mask" -> { parentA, parentAMask, parentB, parentBMask, childPower, exact, isExample, cost }
  const stepsCost = new Map(ownedPals.map(p => [stateKey(p.id, 0), 0]));

  for (let gen = 1; gen <= maxGenerations; gen++) {
    const pool = [];
    for (const [mask, ids] of obtainedByMask) {
      for (const id of ids) pool.push({ pal: pals.find(p => p.id === id), mask });
    }

    const newByMask = new Map(); // mask -> Map(childId -> entry)
    const consider = (childId, mask, entry) => {
      const already = obtainedByMask.get(mask);
      if (already && already.has(childId)) return; // このmaskでは既に到達済み
      if (!newByMask.has(mask)) newByMask.set(mask, new Map());
      const bucket = newByMask.get(mask);
      const existing = bucket.get(childId);
      if (!existing || entry.cost < existing.cost) bucket.set(childId, entry);
    };

    for (let i = 0; i < pool.length; i++) {
      for (let j = i; j < pool.length; j++) {
        const a = pool[i], b = pool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a.pal, b.pal, exampleMap);
        if (unknown) continue;

        // 経由必須パルを自分自身とだけ配合しても実質的には何も進んでいないので「使った」扱いにしない
        let childMask = a.mask | b.mask;
        if (a.pal.id !== b.pal.id) {
          childMask |= (bitOf.get(a.pal.id) || 0);
          childMask |= (bitOf.get(b.pal.id) || 0);
        }

        const cost = stepsCost.get(stateKey(a.pal.id, a.mask)) + stepsCost.get(stateKey(b.pal.id, b.mask)) + 1;
        consider(child.id, childMask, {
          parentA: a.pal, parentAMask: a.mask,
          parentB: b.pal, parentBMask: b.mask,
          childPower, exact, isExample, cost
        });
      }
    }

    let anyNew = false;
    for (const [mask, bucket] of newByMask) {
      if (!obtainedByMask.has(mask)) obtainedByMask.set(mask, new Set());
      const set = obtainedByMask.get(mask);
      for (const [id, entry] of bucket) {
        if (set.has(id)) continue;
        set.add(id);
        via.set(stateKey(id, mask), entry);
        stepsCost.set(stateKey(id, mask), entry.cost);
        anyNew = true;
      }
    }

    const fullMaskSet = obtainedByMask.get(fullMask);
    if (fullMaskSet && fullMaskSet.has(targetPal.id)) {
      const steps = [];
      const visited = new Set();

      function backtrack(id, mask) {
        const key = stateKey(id, mask);
        if (visited.has(key)) return;
        visited.add(key);
        const v = via.get(key);
        if (!v) return; // 手持ち初期パル(mask=0)はここで終端
        backtrack(v.parentA.id, v.parentAMask);
        backtrack(v.parentB.id, v.parentBMask);
        steps.push({
          parentA: v.parentA,
          parentB: v.parentB,
          child: pals.find(p => p.id === id),
          childPower: v.childPower,
          exact: v.exact,
          isExample: v.isExample
        });
      }
      backtrack(targetPal.id, fullMask);

      return { found: true, generations: gen, steps, reason: "bred-via-all" };
    }

    if (!anyNew) break;
  }

  return { found: false, generations: maxGenerations, steps: [], reason: "not-found-within-limit" };
}

// findBreedingRouteViaの複数目標版。「牧場で飼育する複数種に、同じスキル系統を全員継承させたい」
// といったケースのために、1回のBFSで複数のtargetPalsを同時に追いかける。
// findBreedingRouteViaと同じ「経由必須パルを使ったか(with)/未使用か(without)」の2色の閉包を、
// 1匹見つかった時点で止めずに全targetPalsが見つかる(またはこれ以上何も生まれなくなる/世代上限)まで
// 育て続けるのがポイント。同じ1つの閉包を全targetで共有するため、あるtargetPalが先に"with"色で
// 生まれれば、それ以降は他のtargetPalを作るための親としてそのまま再利用できる
// (with×何か=常にwith行きなので、スキル継承済み扱いも自動的に引き継がれる)。
// 戻り値:
//   results: [{ targetPal, found, alreadyOwned, generation? }] targetPalsと同じ順
//   steps: 全targetの依存を合成した1本の配合手順(世代の若い順、同じ祖先を複数targetが共有する場合は
//          1回だけ登場する)。各stepの finalForTargetIds に「このstepの子がそのままtargetPalであるid」を入れる
//          (中間素材としてのみ使われるstepは空配列)。
function findBreedingRouteMultiVia(pals, targetPals, ownedPals, requiredPalIds, exampleMap = {}, maxGenerations = 10) {
  const reqIdSet = new Set(requiredPalIds || []);
  const makeResults = (mapFn) => targetPals.map(tp => mapFn(tp));

  if (reqIdSet.size === 0 || ![...reqIdSet].some(id => ownedPals.some(p => p.id === id))) {
    return { results: makeResults(tp => ({ targetPal: tp, found: false, alreadyOwned: false, reason: "required-pal-not-owned" })), steps: [] };
  }
  if (ownedPals.length === 0) {
    return { results: makeResults(tp => ({ targetPal: tp, found: false, alreadyOwned: false, reason: "no-owned-pals" })), steps: [] };
  }

  const ownedIdSet = new Set(ownedPals.map(p => p.id));
  const alreadyOwned = new Set(targetPals.filter(tp => ownedIdSet.has(tp.id)).map(tp => tp.id));
  const remaining = new Set(targetPals.filter(tp => !ownedIdSet.has(tp.id)).map(tp => tp.id));
  const foundAtGen = new Map();

  const withoutIds = new Set(ownedPals.map(p => p.id));
  const withIds = new Set();
  const viaWithout = new Map();
  const viaWith = new Map();
  const stepsCostWithout = new Map(ownedPals.map(p => [p.id, 0]));
  const stepsCostWith = new Map();
  const genOf = new Map(); // "color:id" -> このパル(色)が最初に得られた世代(初期所持は0)
  ownedPals.forEach(p => genOf.set("without:" + p.id, 0));

  for (let gen = 1; gen <= maxGenerations && remaining.size > 0; gen++) {
    const withoutPool = [...withoutIds].map(id => pals.find(p => p.id === id));
    const withPool = [...withIds].map(id => pals.find(p => p.id === id));

    const newWithout = [];
    const newWithoutParents = new Map();
    const newWith = [];
    const newWithParents = new Map();

    const considerWithout = (child, entry, cost) => {
      const existing = newWithoutParents.get(child.id);
      if (!existing || cost < existing.cost) {
        if (!existing) newWithout.push(child);
        newWithoutParents.set(child.id, { ...entry, cost });
      }
    };
    const considerWith = (child, entry, cost) => {
      const existing = newWithParents.get(child.id);
      if (!existing || cost < existing.cost) {
        if (!existing) newWith.push(child);
        newWithParents.set(child.id, { ...entry, cost });
      }
    };

    for (let i = 0; i < withoutPool.length; i++) {
      for (let j = i; j < withoutPool.length; j++) {
        const a = withoutPool[i], b = withoutPool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        const usesRequired = (reqIdSet.has(a.id) || reqIdSet.has(b.id)) && a.id !== b.id;
        const entry = { parentA: a, parentAColor: "without", parentB: b, parentBColor: "without", childPower, exact, isExample };
        const cost = stepsCostWithout.get(a.id) + stepsCostWithout.get(b.id) + 1;
        if (usesRequired) {
          if (!withIds.has(child.id)) considerWith(child, entry, cost);
        } else {
          if (!withoutIds.has(child.id)) considerWithout(child, entry, cost);
        }
      }
    }

    for (const a of withPool) {
      for (const b of withoutPool) {
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (withIds.has(child.id)) continue;
        const cost = stepsCostWith.get(a.id) + stepsCostWithout.get(b.id) + 1;
        considerWith(child, { parentA: a, parentAColor: "with", parentB: b, parentBColor: "without", childPower, exact, isExample }, cost);
      }
    }

    for (let i = 0; i < withPool.length; i++) {
      for (let j = i; j < withPool.length; j++) {
        const a = withPool[i], b = withPool[j];
        const { child, childPower, exact, isExample, unknown } = breedOnce(pals, a, b, exampleMap);
        if (unknown) continue;
        if (withIds.has(child.id)) continue;
        const cost = stepsCostWith.get(a.id) + stepsCostWith.get(b.id) + 1;
        considerWith(child, { parentA: a, parentAColor: "with", parentB: b, parentBColor: "with", childPower, exact, isExample }, cost);
      }
    }

    for (const c of newWithout) {
      withoutIds.add(c.id);
      const best = newWithoutParents.get(c.id);
      viaWithout.set(c.id, best);
      stepsCostWithout.set(c.id, best.cost);
      genOf.set("without:" + c.id, gen);
    }
    for (const c of newWith) {
      withIds.add(c.id);
      const best = newWithParents.get(c.id);
      viaWith.set(c.id, best);
      stepsCostWith.set(c.id, best.cost);
      genOf.set("with:" + c.id, gen);
    }

    for (const id of [...remaining]) {
      if (withIds.has(id)) {
        foundAtGen.set(id, gen);
        remaining.delete(id);
      }
    }

    if (newWithout.length === 0 && newWith.length === 0) break;
  }

  // 見つかった全targetの依存を合成する。同じ祖先を複数targetが共有していても、
  // neededKeysの重複チェックにより1回しか辿らない(=無駄な再計算をしない)。
  const neededKeys = new Set();
  function markNeeded(id, color) {
    const key = color + ":" + id;
    if (neededKeys.has(key)) return;
    neededKeys.add(key);
    const via = color === "with" ? viaWith.get(id) : viaWithout.get(id);
    if (!via) return;
    markNeeded(via.parentA.id, via.parentAColor);
    markNeeded(via.parentB.id, via.parentBColor);
  }
  for (const tp of targetPals) {
    if (foundAtGen.has(tp.id)) markNeeded(tp.id, "with");
  }

  const entries = [];
  for (const key of neededKeys) {
    const sep = key.indexOf(":");
    const color = key.slice(0, sep);
    const id = Number(key.slice(sep + 1));
    const via = color === "with" ? viaWith.get(id) : viaWithout.get(id);
    if (!via) continue; // 初期所持パルはstepなし
    entries.push({ gen: genOf.get(key) || 0, id, color, via });
  }
  entries.sort((x, y) => x.gen - y.gen || x.id - y.id);

  const targetIdSet = new Set(targetPals.map(tp => tp.id));
  const steps = entries.map(e => ({
    parentA: e.via.parentA,
    parentB: e.via.parentB,
    child: pals.find(p => p.id === e.id),
    childPower: e.via.childPower,
    exact: e.via.exact,
    isExample: e.via.isExample,
    finalForTargetIds: (e.color === "with" && targetIdSet.has(e.id)) ? [e.id] : []
  }));

  const results = targetPals.map(tp => {
    if (alreadyOwned.has(tp.id)) return { targetPal: tp, found: true, alreadyOwned: true };
    if (foundAtGen.has(tp.id)) return { targetPal: tp, found: true, alreadyOwned: false, generation: foundAtGen.get(tp.id) };
    return { targetPal: tp, found: false, alreadyOwned: false, reason: "not-found-within-limit" };
  });

  return { results, steps };
}

// タマゴサイズ別の孵化時間の目安(時間)。ユーザーのワールド設定に合わせた値。
// 基準値(palworld.wiki.gg「Egg Incubator」記事、適温でない場合): Normal=6h, Large=36h, Huge=72h。
// ユーザー環境ではHugeの実測値が2h(基準値の1/36)だったため、ワールド設定の孵化速度倍率が
// 全サイズに一律で効くとみなし、Normal/Largeも同じ1/36倍で換算した。
const EGG_HATCH_HOURS = { Normal: 6 / 36, Large: 36 / 36, Huge: 72 / 36 };

// タマゴサイズが判明していないパルは、実際より短く見積もって最適ルートから不当に除外してしまう
// (=本来もっと速いルートを見逃す)ことを避けるため、安全側(既知のサイズの中で最も時間がかかる値)に倒して計算する。
// EGG_HATCH_HOURSの大小関係(通常はHuge>Large>Normalだが、ユーザー環境の設定次第で入れ替わりうる)に
// 依存しないよう、特定のサイズ名を決め打ちせずMath.maxで安全側の値を毎回動的に求める。
// 表示用のバッジ(app.js)はpal.eggSizeそのもの(null=不明)を見るので、ここでの仮定とは独立している。
const WORST_CASE_HATCH_HOURS = Math.max(...Object.values(EGG_HATCH_HOURS));

function getHatchHours(pal) {
  return pal.eggSize && EGG_HATCH_HOURS[pal.eggSize] != null ? EGG_HATCH_HOURS[pal.eggSize] : WORST_CASE_HATCH_HOURS;
}

// 任意の配合ステップ列(トポロジカル順、最後のステップの子が目的のパル)について、
// 依存関係のない配合は並行して進められる前提で合計孵化時間(クリティカルパス)を計算する。
// findBreedingRouteMinHatchTime専用ではなく、findBreedingRoute/findBreedingRouteViaの結果を
// 表示用に評価する際にも使う(ステップ自体はhatchHoursフィールドを持たなくてもよい)。
function computeCriticalPathHours(steps, ownedIds) {
  if (steps.length === 0) return 0;
  const ready = new Map();
  for (const id of ownedIds) ready.set(id, 0);
  let lastChildId = null;
  for (const s of steps) {
    const aReady = ready.has(s.parentA.id) ? ready.get(s.parentA.id) : 0;
    const bReady = ready.has(s.parentB.id) ? ready.get(s.parentB.id) : 0;
    ready.set(s.child.id, Math.max(aReady, bReady) + getHatchHours(s.child));
    lastChildId = s.child.id;
  }
  return ready.get(lastChildId);
}

// 「世代数」ではなく「配合で生まれるタマゴの孵化時間の合計」が最小になる経路をダイクストラ法で探す。
// 複数の配合を並行して進められる(=両親がそれぞれ独立に用意できるなら待ち時間は長い方だけで済む)ことを
// 前提に、あるパルを手に入れるまでのコストを「両親のコストの大きい方 + 自分自身のタマゴの孵化時間」として
// 定義し、これを状態ごとの最短コストとして確定させていく(コストに負値が無いためダイクストラ法が使える)。
// タマゴサイズ(孵化時間)が不明なパルはgetHatchHoursが安全側の値を返すため、経路から除外されることはない。
//
// requiredPalIdsを指定した場合はfindBreedingRouteViaと同様(OR条件、少なくとも1匹を実際に配合の
// 親として使えばよい)、状態を「経由必須パルをいずれか1匹でも実際に配合の親として使ったか(色:
// "with"/"without")」で2色に分けて管理し、それぞれ独立に最短コストを求める。
// requiredPalIdsが未指定/空の場合は常に"without"色のみを使う(色の区別を実質無視する)。
//
// 戻り値: { found, totalHatchHours, steps: [{parentA, parentB, child, hatchHours, exact, isExample}], reason }
function findBreedingRouteMinHatchTime(pals, targetPal, ownedPals, exampleMap = {}, requiredPalIds = null) {
  const reqIdSet = new Set(requiredPalIds || []);
  if (reqIdSet.size > 0 && ![...reqIdSet].some(id => ownedPals.some(p => p.id === id))) {
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

  const targetKeyGoal = key(targetPal.id, reqIdSet.size > 0 ? "with" : "without");
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

      const usesRequired = (reqIdSet.has(uPal.id) || reqIdSet.has(vPal.id)) && uPal.id !== vPal.id;
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
    reason: reqIdSet.size > 0 ? "bred-via-min-hatch" : "bred-min-hatch"
  };
}

// findBreedingRouteMinHatchTimeのAND版(findBreedingRouteViaAllの孵化時間最小モード版)。
// 「requiredGroupsの各グループについて、少なくとも1匹をそのメンバーから実際に配合の親として
// 使ったルート」の中で孵化時間合計が最小になるものをダイクストラ法で探す(グループ内OR/グループ間AND、
// 詳細はfindBreedingRouteViaAllのコメント参照)。状態をビットマスクで管理する
// (findBreedingRouteMinHatchTimeの"with"/"without"2色を、複数ビットに一般化したもの)。
function findBreedingRouteMinHatchTimeAll(pals, targetPal, ownedPals, exampleMap = {}, requiredGroups = null) {
  const groups = (requiredGroups || []).map(g => [...new Set(g || [])]).filter(g => g.length > 0);
  if (groups.length > 0 && !groups.every(g => g.some(id => ownedPals.some(p => p.id === id)))) {
    return { found: false, totalHatchHours: 0, steps: [], reason: "required-pal-not-owned" };
  }
  if (ownedPals.some(p => p.id === targetPal.id)) {
    return { found: true, totalHatchHours: 0, steps: [], reason: "already-owned" };
  }
  if (ownedPals.length === 0) {
    return { found: false, totalHatchHours: 0, steps: [], reason: "no-owned-pals" };
  }

  const bitOf = new Map();
  groups.forEach((g, i) => {
    const bit = 1 << i;
    for (const id of g) bitOf.set(id, (bitOf.get(id) || 0) | bit);
  });
  const fullMask = groups.length > 0 ? (1 << groups.length) - 1 : 0;

  const key = (id, mask) => `${id}:${mask}`;
  const dist = new Map();
  const via = new Map();
  const finalized = new Set();

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
    const k = key(p.id, 0);
    if (!dist.has(k)) {
      dist.set(k, 0);
      heapPush(0, k);
    }
  }

  const targetKeyGoal = key(targetPal.id, fullMask);
  let found = false;

  while (heap.length > 0) {
    const [d, uKey] = heapPop();
    if (finalized.has(uKey)) continue;
    if (d > dist.get(uKey)) continue;
    finalized.add(uKey);
    if (uKey === targetKeyGoal) { found = true; break; }

    const sep = uKey.lastIndexOf(":");
    const uId = Number(uKey.slice(0, sep));
    const uMask = Number(uKey.slice(sep + 1));
    const uPal = pals.find(p => p.id === uId);

    for (const vKey of finalized) {
      const vSep = vKey.lastIndexOf(":");
      const vId = Number(vKey.slice(0, vSep));
      const vMask = Number(vKey.slice(vSep + 1));
      const vPal = pals.find(p => p.id === vId);
      const vDist = dist.get(vKey);

      const { child, exact, isExample, unknown } = breedOnce(pals, uPal, vPal, exampleMap);
      if (unknown) continue;
      const hatchHours = getHatchHours(child);

      let childMask = uMask | vMask;
      if (uPal.id !== vPal.id) {
        if (bitOf.has(uPal.id)) childMask |= bitOf.get(uPal.id);
        if (bitOf.has(vPal.id)) childMask |= bitOf.get(vPal.id);
      }
      const newCost = Math.max(d, vDist) + hatchHours;
      const childKey = key(child.id, childMask);
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
    if (!v) return;
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
    reason: groups.length > 0 ? "bred-via-all-min-hatch" : "bred-min-hatch"
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    computeChildPower, findClosestPals, breedOnce, findBreedingCombos, findBreedingRoute, findBreedingRouteVia,
    findBreedingRouteViaAll, findBreedingRouteMultiVia, EGG_HATCH_HOURS, getHatchHours, findBreedingRouteMinHatchTime,
    findBreedingRouteMinHatchTimeAll, computeCriticalPathHours
  };
}
