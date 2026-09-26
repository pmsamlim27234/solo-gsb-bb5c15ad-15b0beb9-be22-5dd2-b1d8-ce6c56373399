/**
 * 重新校准后的审校决定迁移。
 *
 * 对相同两份字幕应用新校准并重新对齐后，在旧对齐组与新对齐组之间做全局最优的
 * 顺序一对一匹配，只把“所有最优方案中都对应同一新组”的旧组决定迁移到新组：
 *
 *  - 可匹配口径：仅当两组 A 侧、B 侧各自拼接后的原始文本均完全相同
 *    （不做归一化；单边组的另一侧视为空串）；
 *  - 全局方案：按匹配键求最长公共子序列——匹配组数最多、保持顺序、不交叉、一对一；
 *  - 可迁移判定：配对 (i, j) 出现在所有最优方案中，当且仅当它可行
 *    （f[i][j] + 1 + g[i+1][j+1] = L，其中 f/g 为前/后缀最优匹配数，L 为全局最优值），
 *    且它是其所在层（f[i][j] + 1）上唯一可行的配对——每个最优方案在每一层恰好
 *    选取一个可行配对，故层内唯一 ⟺ 被所有最优方案共同包含。重复台词造成的多解
 *    归属一律视为歧义，不按下标猜配；
 *  - 迁移内容：A/B/自定义文本选择（含自定义文本）与单边保留/丢弃决定；
 *    时间轴选择一律使用新组默认值。
 */
import type { AlignGroup } from './align';
import { defaultStateFor, mergedText, type GroupState } from './merge';
import type { Cue } from './srt';

export interface MigratePair {
  oldIndex: number;
  newIndex: number;
}

export interface MigrateAmbiguous {
  oldIndex: number;
  /** 该旧组在各最优方案中可能对应的新组下标 */
  candidates: number[];
}

export interface MigratePlan {
  /** false 表示组数乘积过大，未计算（界面应提示并仅允许取消） */
  ok: boolean;
  /** 最优顺序一对一方案的匹配组数 */
  matchCount: number;
  /** 所有最优方案一致、可安全迁移的配对 */
  pairs: MigratePair[];
  /** 存在多个可能对应（或对应被其他旧组竞争）的旧组，不迁移 */
  ambiguous: MigrateAmbiguous[];
  /** 任何最优方案中都没有对应新组的旧组下标 */
  unmatched: number[];
}

/** 组数乘积上限：超出时放弃计算，避免全表 DP 占用过多内存。 */
const CELL_LIMIT = 16_000_000;

/** 组的匹配键：A、B 两侧各自拼接后的原始文本（不归一化），以 NUL 分隔。 */
export function groupKey(group: AlignGroup, cuesA: Cue[], cuesB: Cue[]): string {
  return `${mergedText(cuesA, group.aIdx)}\u0000${mergedText(cuesB, group.bIdx)}`;
}

/**
 * 计算旧对齐组 → 新对齐组的迁移方案。
 * oldCuesB / newCuesB 分别为旧、新对齐实际使用的 B 时间轴（文本相同，仅时间可能不同）。
 */
export function planMigration(
  oldGroups: AlignGroup[],
  newGroups: AlignGroup[],
  cuesA: Cue[],
  oldCuesB: Cue[],
  newCuesB: Cue[],
): MigratePlan {
  const n = oldGroups.length;
  const m = newGroups.length;
  if (n === 0) return { ok: true, matchCount: 0, pairs: [], ambiguous: [], unmatched: [] };
  if (m === 0)
    return {
      ok: true,
      matchCount: 0,
      pairs: [],
      ambiguous: [],
      unmatched: oldGroups.map((_, i) => i),
    };
  if ((n + 1) * (m + 1) > CELL_LIMIT)
    return { ok: false, matchCount: 0, pairs: [], ambiguous: [], unmatched: [] };

  // 匹配键映射为整数 id，加速 DP 内层比较
  const keyId = new Map<string, number>();
  const idOf = (k: string): number => {
    let id = keyId.get(k);
    if (id === undefined) {
      id = keyId.size;
      keyId.set(k, id);
    }
    return id;
  };
  const oldIds = oldGroups.map((g) => idOf(groupKey(g, cuesA, oldCuesB)));
  const newIds = newGroups.map((g) => idOf(groupKey(g, cuesA, newCuesB)));

  // 新组下标按键分组：旧组 i 的候选即键相同的新组
  const newByKey = new Map<number, number[]>();
  newIds.forEach((id, j) => {
    const list = newByKey.get(id);
    if (list) list.push(j);
    else newByKey.set(id, [j]);
  });

  const width = m + 1;
  // f[i][j] = old[0..i) 与 new[0..j) 的最优匹配组数（LCS 长度）
  const f = new Int32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const row = i * width;
    const up = row - width;
    const oi = oldIds[i - 1];
    for (let j = 1; j <= m; j++) {
      let v = f[up + j] >= f[row + j - 1] ? f[up + j] : f[row + j - 1];
      if (oi === newIds[j - 1]) {
        const d = f[up + j - 1] + 1;
        if (d > v) v = d;
      }
      f[row + j] = v;
    }
  }
  const L = f[n * width + m];

  // 反向逐行求 g[i][j] = old[i..n) 与 new[j..m) 的最优匹配数；同时收集旧组 i 的可行配对
  const viable: number[][] = oldGroups.map(() => []);
  const viableLevel: number[][] = oldGroups.map(() => []);
  const levelCount = new Map<number, number>();
  let gNext = new Int32Array(m + 1); // i = n：全零
  for (let i = n - 1; i >= 0; i--) {
    const gCur = new Int32Array(m + 1);
    const oi = oldIds[i];
    for (let j = m - 1; j >= 0; j--) {
      let v = gNext[j] >= gCur[j + 1] ? gNext[j] : gCur[j + 1];
      if (oi === newIds[j]) {
        const d = gNext[j + 1] + 1;
        if (d > v) v = d;
      }
      gCur[j] = v;
    }
    const fRow = i * width;
    const cand = newByKey.get(oi);
    if (cand) {
      for (const j of cand) {
        const level = f[fRow + j] + 1;
        // 可行 ⟺ f[i][j] + 1 + g[i+1][j+1] = L
        if (level + gNext[j + 1] === L) {
          viable[i].push(j);
          viableLevel[i].push(level);
          levelCount.set(level, (levelCount.get(level) ?? 0) + 1);
        }
      }
    }
    gNext = gCur;
  }

  const pairs: MigratePair[] = [];
  const ambiguous: MigrateAmbiguous[] = [];
  const unmatched: number[] = [];
  for (let i = 0; i < n; i++) {
    const cand = viable[i];
    if (cand.length === 0) {
      unmatched.push(i);
      continue;
    }
    // 可行且为所在层唯一可行配对 ⟺ 出现在所有最优方案中
    const t = cand.findIndex((_, k) => levelCount.get(viableLevel[i][k]) === 1);
    if (t >= 0) pairs.push({ oldIndex: i, newIndex: cand[t] });
    else ambiguous.push({ oldIndex: i, candidates: [...cand] });
  }
  return { ok: true, matchCount: L, pairs, ambiguous, unmatched };
}

/**
 * 按迁移方案生成新对齐的各组状态：新组先取默认值，可迁移配对再覆盖
 * 文本选择（A/B/自定义，含自定义文本）与单边保留/丢弃；时间轴选择保留新组默认值。
 */
export function applyMigration(
  newGroups: AlignGroup[],
  cuesA: Cue[],
  newCuesB: Cue[],
  oldStates: GroupState[],
  plan: MigratePlan,
): GroupState[] {
  const states = newGroups.map((g) => defaultStateFor(g, cuesA, newCuesB));
  if (!plan.ok) return states;
  for (const { oldIndex, newIndex } of plan.pairs) {
    const old = oldStates[oldIndex];
    if (!old) continue;
    const cur = states[newIndex];
    states[newIndex] = {
      isConflict: cur.isConflict,
      resolved: old.resolved,
      resolution: {
        ...cur.resolution, // 时间选择（含自定义时间）保留新组默认值
        text: old.resolution.text,
        customText: old.resolution.customText,
        keep: old.resolution.keep,
      },
    };
  }
  return states;
}
