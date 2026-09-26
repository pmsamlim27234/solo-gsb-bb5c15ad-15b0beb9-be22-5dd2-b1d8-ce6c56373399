import { describe, expect, it } from 'vitest';
import { alignCues, type AlignGroup, type GroupKind } from '../align';
import { applyMigration, planMigration } from '../migrate';
import { defaultStateFor, type GroupState, type Resolution } from '../merge';
import { parseSrt, type Cue } from '../srt';

const cue = (text: string, start = 0, end = 1000): Cue => ({ id: 0, start, end, text });

function mkGroup(aIdx: number[], bIdx: number[]): AlignGroup {
  const kind: GroupKind =
    aIdx.length === 0
      ? 'B-only'
      : bIdx.length === 0
        ? 'A-only'
        : aIdx.length === 1 && bIdx.length === 1
          ? '1:1'
          : aIdx.length > 1
            ? 'N:1'
            : '1:N';
  return { id: `g-${aIdx.join('.')}-${bIdx.join('.')}`, aIdx, bIdx, kind, textSim: 0, timeOverlap: 0, confidence: 0 };
}

/** 生成默认状态后按 patch 覆盖决定（模拟人工审校）。 */
function decided(
  g: AlignGroup,
  cuesA: Cue[],
  cuesB: Cue[],
  patch: Partial<Resolution>,
): GroupState {
  const s = defaultStateFor(g, cuesA, cuesB);
  return { ...s, resolved: true, resolution: { ...s.resolution, ...patch } };
}

describe('planMigration：匹配口径', () => {
  it('仅当 A、B 各自拼接后的原始文本完全相同时才可匹配（归一化相同不算）', () => {
    const cuesA = [cue('你好，世界！')];
    const oldB = [cue('你好，世界！')];
    const newB = [cue('你好世界')]; // 归一化后相同，原始文本不同
    const oldG = [mkGroup([0], [0])];
    const newG = [mkGroup([0], [0])];
    const plan = planMigration(oldG, newG, cuesA, oldB, newB);
    expect(plan.ok).toBe(true);
    expect(plan.matchCount).toBe(0);
    expect(plan.pairs).toEqual([]);
    expect(plan.unmatched).toEqual([0]);
  });

  it('多对一拼接文本相同才匹配：拆分不同的组不对应', () => {
    const cuesA = [cue('你好'), cue('世界')];
    const cuesB = [cue('你好世界')];
    // 旧组 N:1（A 两条 ↔ B 一条）；新组 1:1 + 仅A：键不同
    const oldG = [mkGroup([0, 1], [0])];
    const newG = [mkGroup([0], [0]), mkGroup([1], [])];
    const plan = planMigration(oldG, newG, cuesA, cuesB, cuesB);
    expect(plan.pairs).toEqual([]);
    expect(plan.unmatched).toEqual([0]);
  });

  it('空输入安全', () => {
    expect(planMigration([], [], [], [], [])).toEqual({
      ok: true,
      matchCount: 0,
      pairs: [],
      ambiguous: [],
      unmatched: [],
    });
    const plan = planMigration([mkGroup([0], [])], [], [cue('甲')], [], []);
    expect(plan.unmatched).toEqual([0]);
  });
});

describe('planMigration：全局最优顺序一对一', () => {
  it('完全一致的对齐全部一一迁移', () => {
    const cuesA = [cue('甲'), cue('乙'), cue('丙')];
    const cuesB = [cue('甲B'), cue('乙'), cue('丙')];
    const oldG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const newG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const plan = planMigration(oldG, newG, cuesA, cuesB, cuesB);
    expect(plan.matchCount).toBe(3);
    expect(plan.pairs).toEqual([
      { oldIndex: 0, newIndex: 0 },
      { oldIndex: 1, newIndex: 1 },
      { oldIndex: 2, newIndex: 2 },
    ]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it('不允许交叉：旧 [P,Q] 对新 [Q,P] 时最优匹配数为 1，且两个可行配对均为歧义', () => {
    const cuesA = [cue('甲'), cue('乙')];
    const oldG = [mkGroup([0], []), mkGroup([1], [])];
    const newG = [mkGroup([1], []), mkGroup([0], [])]; // 新顺序为 [乙, 甲]
    const plan = planMigration(oldG, newG, cuesA, [], []);
    expect(plan.matchCount).toBe(1);
    expect(plan.pairs).toEqual([]);
    expect(plan.ambiguous).toEqual([
      { oldIndex: 0, candidates: [1] },
      { oldIndex: 1, candidates: [0] },
    ]);
  });

  it('重复台词：一个旧组对两个相同新组时为歧义，不按下标猜配', () => {
    const cuesA = [cue('重复台词'), cue('重复台词')];
    const oldG = [mkGroup([0], [])];
    const newG = [mkGroup([0], []), mkGroup([1], [])];
    const plan = planMigration(oldG, newG, cuesA, [], []);
    expect(plan.matchCount).toBe(1);
    expect(plan.pairs).toEqual([]);
    expect(plan.ambiguous).toEqual([{ oldIndex: 0, candidates: [0, 1] }]);
  });

  it('重复台词：两个旧组竞争同一个新组时双方均为歧义', () => {
    const cuesA = [cue('重复台词'), cue('重复台词')];
    const oldG = [mkGroup([0], []), mkGroup([1], [])];
    const newG = [mkGroup([0], [])];
    const plan = planMigration(oldG, newG, cuesA, [], []);
    expect(plan.matchCount).toBe(1);
    expect(plan.pairs).toEqual([]);
    expect(plan.ambiguous).toEqual([
      { oldIndex: 0, candidates: [0] },
      { oldIndex: 1, candidates: [0] },
    ]);
  });

  it('重复台词：新旧各两条且顺序一致时唯一对应，可以迁移', () => {
    const cuesA = [cue('重复台词'), cue('重复台词')];
    const oldG = [mkGroup([0], []), mkGroup([1], [])];
    const newG = [mkGroup([0], []), mkGroup([1], [])];
    const plan = planMigration(oldG, newG, cuesA, [], []);
    expect(plan.matchCount).toBe(2);
    expect(plan.pairs).toEqual([
      { oldIndex: 0, newIndex: 0 },
      { oldIndex: 1, newIndex: 1 },
    ]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('部分组在新对齐中消失：可迁移的迁移，消失的列为无对应', () => {
    const cuesA = [cue('甲'), cue('乙'), cue('丙')];
    const oldB = [cue('甲'), cue('乙'), cue('丙')];
    const newB = [cue('甲'), cue('贰'), cue('丙')]; // 乙 → 贰，文本不同
    const oldG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const newG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const plan = planMigration(oldG, newG, cuesA, oldB, newB);
    expect(plan.matchCount).toBe(2);
    expect(plan.pairs).toEqual([
      { oldIndex: 0, newIndex: 0 },
      { oldIndex: 2, newIndex: 2 },
    ]);
    expect(plan.unmatched).toEqual([1]);
  });
});

describe('applyMigration：迁移内容', () => {
  it('迁移 A/B/自定义文本选择，时间选择使用新组默认值', () => {
    const cuesA = [cue('甲'), cue('乙'), cue('丙')];
    const cuesB = [cue('甲B'), cue('乙'), cue('丙C')];
    const newG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const oldG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const oldStates = [
      decided(oldG[0], cuesA, cuesB, { text: 'B', time: 'union' }),
      defaultStateFor(oldG[1], cuesA, cuesB),
      decided(oldG[2], cuesA, cuesB, {
        text: 'custom',
        customText: '自定义丙',
        time: 'custom',
        customStart: '00:00:01,000',
        customEnd: '00:00:02,000',
      }),
    ];
    const plan = planMigration(oldG, newG, cuesA, cuesB, cuesB);
    const states = applyMigration(newG, cuesA, cuesB, oldStates, plan);

    expect(states[0].resolved).toBe(true);
    expect(states[0].resolution.text).toBe('B');
    expect(states[0].resolution.time).toBe('A'); // 新组默认值，不迁移时间选择

    expect(states[1].resolved).toBe(true); // 文本一致，自动解决

    expect(states[2].resolved).toBe(true);
    expect(states[2].resolution.text).toBe('custom');
    expect(states[2].resolution.customText).toBe('自定义丙');
    expect(states[2].resolution.time).toBe('A'); // 自定义时间同样不迁移
    expect(states[2].resolution.customStart).toBe('');
    expect(states[2].resolution.customEnd).toBe('');
  });

  it('未解决的旧冲突组迁移后仍未解决', () => {
    const cuesA = [cue('甲')];
    const cuesB = [cue('甲B')];
    const oldG = [mkGroup([0], [0])];
    const newG = [mkGroup([0], [0])];
    const oldStates = [defaultStateFor(oldG[0], cuesA, cuesB)]; // 冲突且未解决
    expect(oldStates[0].isConflict).toBe(true);
    expect(oldStates[0].resolved).toBe(false);
    const plan = planMigration(oldG, newG, cuesA, cuesB, cuesB);
    const states = applyMigration(newG, cuesA, cuesB, oldStates, plan);
    expect(states[0].isConflict).toBe(true);
    expect(states[0].resolved).toBe(false);
  });

  it('单边组迁移保留/丢弃决定', () => {
    const cuesA = [cue('仅A内容')];
    const oldG = [mkGroup([0], [])];
    const newG = [mkGroup([0], [])];
    const oldStates = [decided(oldG[0], cuesA, [], { keep: false })];
    const plan = planMigration(oldG, newG, cuesA, [], []);
    expect(plan.pairs).toHaveLength(1);
    const states = applyMigration(newG, cuesA, [], oldStates, plan);
    expect(states[0].resolution.keep).toBe(false);
  });

  it('无对应与歧义组不迁移，新组保持默认值', () => {
    const cuesA = [cue('甲'), cue('重复'), cue('重复')];
    const oldB = [cue('甲'), cue('重复')];
    const newB = [cue('甲'), cue('重复'), cue('重复')];
    const oldG = [mkGroup([0], [0]), mkGroup([1], [1])];
    const newG = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    // 旧组 1（重复）对新组 1、2 均可行 → 歧义
    const oldStates = [
      decided(oldG[0], cuesA, oldB, { text: 'B' }),
      decided(oldG[1], cuesA, oldB, { text: 'B' }),
    ];
    const plan = planMigration(oldG, newG, cuesA, oldB, newB);
    expect(plan.pairs).toEqual([{ oldIndex: 0, newIndex: 0 }]);
    expect(plan.ambiguous).toEqual([{ oldIndex: 1, candidates: [1, 2] }]);
    const states = applyMigration(newG, cuesA, newB, oldStates, plan);
    expect(states[0].resolution.text).toBe('B'); // 已迁移
    expect(states[1].resolution.text).toBe('A'); // 歧义，保持新组默认
    expect(states[2].resolution.text).toBe('A'); // 新组，默认
  });
});

describe('集成：校准后重新对齐并迁移', () => {
  const srtA = `1
00:00:01,000 --> 00:00:03,000
第一段字幕内容

2
00:00:04,000 --> 00:00:06,000
第二段字幕内容

3
00:00:07,000 --> 00:00:09,000
第三段字幕内容
`;
  // B 整体后移 10 秒，首条文本略有差异，末尾多一条仅 B 内容
  const srtB = `1
00:00:11,000 --> 00:00:13,000
第一段字幕内容。

2
00:00:14,000 --> 00:00:16,000
第二段字幕内容

3
00:00:17,000 --> 00:00:19,000
第三段字幕内容

4
00:00:20,000 --> 00:00:22,000
仅 B 版本有的内容
`;

  it('重新对齐同结构时决定全部迁移，时间选择回到新组默认', () => {
    const cuesA = parseSrt(srtA);
    const cuesB = parseSrt(srtB);
    const oldGroups = alignCues(cuesA, cuesB);
    expect(oldGroups.map((g) => g.kind)).toEqual(['1:1', '1:1', '1:1', 'B-only']);

    // 人工决定：组 1 用 B 文本 + 并集时间；仅 B 组丢弃
    const oldStates = oldGroups.map((g) => defaultStateFor(g, cuesA, cuesB));
    oldStates[0] = {
      ...oldStates[0],
      resolved: true,
      resolution: { ...oldStates[0].resolution, text: 'B', time: 'union' },
    };
    oldStates[3] = {
      ...oldStates[3],
      resolved: true,
      resolution: { ...oldStates[3].resolution, keep: false },
    };

    // 模拟新校准：B 时间轴整体移回，重新对齐得到同构分组
    const cuesBCal = cuesB.map((c) => ({ ...c, start: c.start - 10000, end: c.end - 10000 }));
    const newGroups = alignCues(cuesA, cuesBCal);
    expect(newGroups.map((g) => g.kind)).toEqual(['1:1', '1:1', '1:1', 'B-only']);

    const plan = planMigration(oldGroups, newGroups, cuesA, cuesB, cuesBCal);
    expect(plan.ok).toBe(true);
    expect(plan.matchCount).toBe(4);
    expect(plan.pairs).toHaveLength(4);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unmatched).toEqual([]);

    const states = applyMigration(newGroups, cuesA, cuesBCal, oldStates, plan);
    expect(states[0].resolved).toBe(true);
    expect(states[0].resolution.text).toBe('B');
    expect(states[0].resolution.time).toBe('A'); // 时间选择用新组默认值
    expect(states[3].resolution.keep).toBe(false); // 丢弃决定迁移
    // 迁移结果可直接进入现有合并链路
    expect(states.every((s) => s.resolved)).toBe(true);
  });
});
