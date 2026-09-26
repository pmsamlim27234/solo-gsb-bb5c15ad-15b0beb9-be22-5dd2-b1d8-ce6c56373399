import type { AlignGroup, GroupKind } from '../lib/align';
import { mergedText, type GroupState } from '../lib/merge';
import type { MigratePlan } from '../lib/migrate';
import type { Cue } from '../lib/srt';

const KIND_LABEL: Record<GroupKind, string> = {
  '1:1': '一对一',
  '1:N': '一对多',
  'N:1': '多对一',
  'A-only': '仅 A',
  'B-only': '仅 B',
};

/** 每个分区最多展示的条数，超出部分折叠为统计。 */
const ROW_CAP = 100;

interface MigrateDialogProps {
  plan: MigratePlan;
  oldGroups: AlignGroup[];
  newGroups: AlignGroup[];
  oldStates: GroupState[];
  cuesA: Cue[];
  /** 旧对齐实际使用的 B 时间轴 */
  oldCuesB: Cue[];
  /** 新对齐使用的 B 时间轴（新校准或原始 B） */
  newCuesB: Cue[];
  onConfirm(): void;
  onCancel(): void;
}

/**
 * 重新校准并迁移审校决定的确认预览：分列可迁移 / 歧义 / 无对应三类，
 * 确认后一次性提交新对齐与迁移结果，取消则保留当前工作区。
 */
export function MigrateDialog(props: MigrateDialogProps) {
  const { plan, oldGroups, newGroups, oldStates, cuesA, oldCuesB } = props;

  return (
    <div className="migrate-overlay">
      <div className="migrate-dialog" role="dialog" aria-modal="true" aria-label="迁移审校决定预览">
        <h2>迁移审校决定预览</h2>
        {!plan.ok ? (
          <>
            <div className="cal-notice warn">
              对齐组数量过大（旧 {oldGroups.length} 组 × 新 {newGroups.length}
              组），无法计算迁移匹配。可取消并保留当前工作区；若不需要迁移决定，请改用「时间轴校准」直接重新对齐。
            </div>
            <div className="migrate-actions">
              <button className="btn ghost lg" onClick={props.onCancel}>
                取消（保留当前工作区）
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="migrate-sub">
              已对相同两份字幕应用新校准并重新对齐：新对齐共 {newGroups.length} 组，最优顺序匹配{' '}
              {plan.matchCount} 组。仅「可迁移」中的旧组决定会迁入新组（A/B/自定义文本选择与单边保留/丢弃；
              时间轴选择使用新组默认值）；确认后消重、断行、阅读节奏与切点吸附的采纳将清空。
            </p>
            <div className="migrate-summary">
              <span className="stat-chip ok">
                可迁移 <strong>{plan.pairs.length}</strong>
              </span>
              <span className="stat-chip">
                歧义 <strong>{plan.ambiguous.length}</strong>
              </span>
              <span className="stat-chip bad">
                无对应 <strong>{plan.unmatched.length}</strong>
              </span>
            </div>

            <div className="migrate-section">
              <h3>
                可迁移 <span className="tag ok">{plan.pairs.length}</span>
                <span className="migrate-hint">所有最优匹配方案中对应同一新组，决定将被迁移</span>
              </h3>
              {plan.pairs.length === 0 ? (
                <div className="migrate-none">没有可迁移的决定。</div>
              ) : (
                <div className="migrate-list">
                  {plan.pairs.slice(0, ROW_CAP).map(({ oldIndex, newIndex }) => {
                    const g = oldGroups[oldIndex];
                    return (
                      <div className="migrate-row ok" key={oldIndex}>
                        <span className="mono">
                          旧 #{oldIndex + 1} → 新 #{newIndex + 1}
                        </span>
                        <span className="tag dim">{KIND_LABEL[g.kind]}</span>
                        <span className="tag go">{decisionLabel(g, oldStates[oldIndex])}</span>
                        <span className="txt">{snippetOf(g, cuesA, oldCuesB)}</span>
                      </div>
                    );
                  })}
                  {plan.pairs.length > ROW_CAP && (
                    <div className="migrate-more">…其余 {plan.pairs.length - ROW_CAP} 条从略</div>
                  )}
                </div>
              )}
            </div>

            <div className="migrate-section">
              <h3>
                歧义 <span className="tag low">{plan.ambiguous.length}</span>
                <span className="migrate-hint">重复台词等导致多个最优对应，不按下标猜配，决定不迁移</span>
              </h3>
              {plan.ambiguous.length === 0 ? (
                <div className="migrate-none">没有歧义项。</div>
              ) : (
                <div className="migrate-list">
                  {plan.ambiguous.slice(0, ROW_CAP).map(({ oldIndex, candidates }) => {
                    const g = oldGroups[oldIndex];
                    return (
                      <div className="migrate-row amb" key={oldIndex}>
                        <span className="mono">旧 #{oldIndex + 1}</span>
                        <span className="tag dim">{KIND_LABEL[g.kind]}</span>
                        <span className="mono">
                          候选新组 {candidates.map((j) => `#${j + 1}`).join(' / ')}
                        </span>
                        <span className="txt">{snippetOf(g, cuesA, oldCuesB)}</span>
                      </div>
                    );
                  })}
                  {plan.ambiguous.length > ROW_CAP && (
                    <div className="migrate-more">…其余 {plan.ambiguous.length - ROW_CAP} 条从略</div>
                  )}
                </div>
              )}
            </div>

            <div className="migrate-section">
              <h3>
                无对应 <span className="tag bad">{plan.unmatched.length}</span>
                <span className="migrate-hint">新对齐中没有对应组，决定不迁移</span>
              </h3>
              {plan.unmatched.length === 0 ? (
                <div className="migrate-none">全部旧组都有对应。</div>
              ) : (
                <div className="migrate-list">
                  {plan.unmatched.slice(0, ROW_CAP).map((oldIndex) => {
                    const g = oldGroups[oldIndex];
                    return (
                      <div className="migrate-row miss" key={oldIndex}>
                        <span className="mono">旧 #{oldIndex + 1}</span>
                        <span className="tag dim">{KIND_LABEL[g.kind]}</span>
                        <span className="tag">{decisionLabel(g, oldStates[oldIndex])}</span>
                        <span className="txt">{snippetOf(g, cuesA, oldCuesB)}</span>
                      </div>
                    );
                  })}
                  {plan.unmatched.length > ROW_CAP && (
                    <div className="migrate-more">…其余 {plan.unmatched.length - ROW_CAP} 条从略</div>
                  )}
                </div>
              )}
            </div>

            <div className="migrate-actions">
              <button className="btn ghost lg" onClick={props.onCancel}>
                取消（保留当前工作区）
              </button>
              <button className="btn primary lg" onClick={props.onConfirm}>
                确认迁移并重新对齐（迁移 {plan.pairs.length} 组决定）
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 旧组已做决定的简要描述：单边组为保留/丢弃，其余为文本选择（未解决的标注）。 */
function decisionLabel(g: AlignGroup, s: GroupState | undefined): string {
  if (!s) return '—';
  if (g.kind === 'A-only' || g.kind === 'B-only') {
    return s.resolution.keep ? '保留' : '丢弃';
  }
  const t = s.resolution.text;
  const label = t === 'custom' ? '自定义文本' : `版本 ${t}`;
  return s.resolved ? label : `${label} · 未解决`;
}

function snippetOf(g: AlignGroup, cuesA: Cue[], cuesB: Cue[]): string {
  const t = mergedText(cuesA, g.aIdx) || mergedText(cuesB, g.bIdx);
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > 0 ? one.slice(0, 50) : '（空）';
}
