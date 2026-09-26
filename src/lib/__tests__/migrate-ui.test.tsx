import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalibratePanel } from '../../components/CalibratePanel';
import { MigrateDialog } from '../../components/MigrateDialog';
import type { AlignGroup, GroupKind } from '../align';
import { DEFAULT_CALIB_OPTIONS, fitCalibration, selectAnchors } from '../calibrate';
import { planMigration } from '../migrate';
import { defaultStateFor } from '../merge';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt, type Cue } from '../srt';

const noop = () => {};

const cue = (text: string): Cue => ({ id: 0, start: 0, end: 1000, text });

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
  return { id: `g-${aIdx}-${bIdx}`, aIdx, bIdx, kind, textSim: 0, timeOverlap: 0, confidence: 0 };
}

describe('MigrateDialog 渲染冒烟', () => {
  it('分列可迁移 / 歧义 / 无对应，并提供确认与取消入口', () => {
    const cuesA = [cue('甲'), cue('重复'), cue('重复')];
    const oldB = [cue('甲'), cue('重复')];
    const newB = [cue('甲'), cue('重复'), cue('重复')];
    // 旧组：1:1（甲）、1:1（重复）、仅A（重复）；新组：1:1（甲）、1:1（重复）×2
    const oldGroups = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [])];
    const newGroups = [mkGroup([0], [0]), mkGroup([1], [1]), mkGroup([2], [2])];
    const oldStates = oldGroups.map((g) => defaultStateFor(g, cuesA, oldB));
    const plan = planMigration(oldGroups, newGroups, cuesA, oldB, newB);
    expect(plan.pairs).toHaveLength(1);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.unmatched).toHaveLength(1);

    const html = renderToString(
      <MigrateDialog
        plan={plan}
        oldGroups={oldGroups}
        newGroups={newGroups}
        oldStates={oldStates}
        cuesA={cuesA}
        oldCuesB={oldB}
        newCuesB={newB}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('迁移审校决定预览');
    expect(html).toContain('可迁移');
    expect(html).toContain('歧义');
    expect(html).toContain('无对应');
    expect(html).toContain('→ 新 #');
    expect(html).toContain('候选新组');
    expect(html).toContain('确认迁移并重新对齐');
    expect(html).toContain('取消（保留当前工作区）');
  });

  it('组数过大无法计算时仅允许取消', () => {
    const html = renderToString(
      <MigrateDialog
        plan={{ ok: false, matchCount: 0, pairs: [], ambiguous: [], unmatched: [] }}
        oldGroups={[mkGroup([0], [])]}
        newGroups={[mkGroup([0], [])]}
        oldStates={[defaultStateFor(mkGroup([0], []), [cue('甲')], [])]}
        cuesA={[cue('甲')]}
        oldCuesB={[]}
        newCuesB={[]}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('无法计算迁移匹配');
    expect(html).toContain('取消（保留当前工作区）');
    expect(html).not.toContain('确认迁移并重新对齐');
  });
});

describe('CalibratePanel 迁移模式', () => {
  it('迁移模式下展示迁移说明与预览按钮', () => {
    const a = parseSrt(SAMPLE_A);
    const b = parseSrt(SAMPLE_B);
    const anchors = selectAnchors(a, b, DEFAULT_CALIB_OPTIONS);
    const fit = fitCalibration(a, b, anchors, new Set());
    const html = renderToString(
      <CalibratePanel
        nameA="a.srt"
        nameB="b.srt"
        cuesA={a}
        cuesB={b}
        anchors={anchors}
        fit={fit}
        options={DEFAULT_CALIB_OPTIONS}
        onOptions={noop}
        disabled={new Set()}
        forced={new Set()}
        onToggle={noop}
        onReset={noop}
        applied={true}
        aligning={false}
        onApply={noop}
        onUseOriginal={noop}
        onBack={noop}
        migrate={true}
      />,
    );
    expect(html).toContain('迁移模式');
    expect(html).toContain('重新应用校准并预览迁移');
    expect(html).toContain('恢复原始 B 时间并预览迁移');
    expect(html).toContain('取消迁移，返回工作区');
  });
});
