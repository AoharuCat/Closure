import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子2 CR 批（CR-6）：UI 镜像漂移守卫——双文件 fixture 对拍测试。
//
// 机制（详 test/fixtures/chainObservabilitySamples.ts 文件头）：agent 侧 fixture（agent 类型
// 注解锚，gate = tsconfig.fixtures.json 挂 typecheck script）≡ ui 侧副本（ui 镜像类型注解锚，
// gate = ui tsconfig 含 src/**）。本测试 deep-equal 两侧——任一侧漂移即红，强制两文件同步改；
// 同步链的终点是镜像类型本身的编译 gate（agent 类型改 → agent fixture 红 → 对拍红 → ui 副本
// 改 → ui 镜像 stale 编译红）。UI 包不依赖 agent 包（跨包 import 拖 agent 类型图进 ui tsc，
// pino / zod-to-json-schema 等 ui 缺依赖——故走数据对拍非类型直连）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  ARTIFACT_DATA_SAMPLES,
  ARTIFACT_SUMMARY_SAMPLES,
  PAUSE_KIND_SAMPLES,
  TOOL_EVENT_SAMPLES,
} from './fixtures/chainObservabilitySamples';
import {
  ARTIFACT_DATA_SAMPLES as UI_ARTIFACT_DATA_SAMPLES,
  ARTIFACT_SUMMARY_SAMPLES as UI_ARTIFACT_SUMMARY_SAMPLES,
  PAUSE_KIND_SAMPLES as UI_PAUSE_KIND_SAMPLES,
  TOOL_EVENT_SAMPLES as UI_TOOL_EVENT_SAMPLES,
} from '../../client/ui/src/shared/store/chainObservabilityMirror.samples';

describe('CR-6 UI 镜像漂移守卫——双文件 fixture 对拍', () => {
  it('agent 类型锚样本 ≡ ui 镜像锚样本（deep-equal；任一侧漂移即红，强制两文件同步改）', () => {
    expect(UI_ARTIFACT_SUMMARY_SAMPLES).toEqual(ARTIFACT_SUMMARY_SAMPLES);
    expect(UI_ARTIFACT_DATA_SAMPLES).toEqual(ARTIFACT_DATA_SAMPLES);
    expect(UI_TOOL_EVENT_SAMPLES).toEqual(TOOL_EVENT_SAMPLES);
    expect(UI_PAUSE_KIND_SAMPLES).toEqual(PAUSE_KIND_SAMPLES);
  });

  it('覆盖面守卫：五 kind + artifact data 两档 seq + tool ±resultCount + 全五 pauseKind（fixture 空转守卫）', () => {
    expect(new Set(ARTIFACT_SUMMARY_SAMPLES.map((s) => s.kind))).toEqual(
      new Set(['brief-card', 'items', 'findings', 'route-decision', 'line']),
    );
    expect(ARTIFACT_DATA_SAMPLES.map((d) => d.seq)).toEqual([-1, 2]);
    expect(TOOL_EVENT_SAMPLES.filter((t) => t.resultCount !== undefined)).toHaveLength(1);
    expect(TOOL_EVENT_SAMPLES.filter((t) => t.resultCount === undefined)).toHaveLength(1);
    expect(new Set(PAUSE_KIND_SAMPLES)).toEqual(
      new Set(['final', 'escalate', 'brief', 'draft', 'revision-guard']),
    );
  });
});
