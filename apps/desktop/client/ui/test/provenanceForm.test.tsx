/**
 * ProvenanceForm 组件测试（E10.2a Wave 4——design §3.3 扩展面）。
 *
 * 覆盖（10.2a 两新字段；五字段既有面守卫在 materialsPage.test.tsx 不重复）：
 * - **标题（name 域）**：装载服务器名 + maxlength=MATERIAL_NAME_MAX_CHARS（单源契约）+
 *   blur 未改零 IPC + blur 落盘走独立 `materials:update-name` 通道（不混 provenance patch）
 *   + 成功后 slice force 重拉清单（列表名刷新联动——事件面 belt 在 materialsSlice.test）
 *   + **name 专属 toast**（`materials.provenance.nameSaved`，CR-5——不再错位显「出处信息已更新」）
 *   + **跨字段草稿保留**（CR-5——saveName 成功 dirty 按字段实际分歧重算，简介未 blur 草稿
 *   不被 detail force 重拉的基线重置吞掉）；
 * - **标题空串拒绝**（name 非空约束）：空/纯空白 blur = 不发 IPC + 回显存量
 *   （mirror 设定页 CR P17 卡名 rejectEmpty 先例）+ **拒绝后 dirty 重算**（CR-4——空名分歧
 *   已消，无他字段草稿则回声抑制解除，服务器刷新恢复接收）；
 * - **简介（provenance.description）**：blur 落盘 partial patch 只发 description +
 *   清空归一 null（既有归一惯例）+ maxlength=MATERIAL_DESCRIPTION_MAX_CHARS（CR-6 UI 面）；
 * - **回声抑制基线含 name**：编辑中（dirty）detail 服务器刷新不覆写草稿。
 *
 * mock 形态照 spec/ui/testing.md + materialsPage.test.tsx 谱：真实 useAppStore 两步落种 +
 * useI18n mock（t 返回键名）+ hand-made vi.fn 挂桥 + data-* 锚。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { ProvenanceForm } from '../src/features/materials/ProvenanceForm';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import { MATERIAL_DESCRIPTION_MAX_CHARS, MATERIAL_NAME_MAX_CHARS, type Material } from '@orison/shared-contracts';

const MATERIAL_ID = 'mat-aaaaaaaaaaaa';

// ── fixtures ──

function materialFixture(over: Partial<Material> = {}): Material {
  return {
    materialId: MATERIAL_ID,
    scope: 'project',
    projectId: '00001',
    kind: 'prose',
    name: '节奏控制入门',
    format: 'srt',
    provenance: {
      medium: 'video',
      tier: 'unspecified',
      sourcePath: 'materials/节奏控制入门.srt',
      via: 'builtin-subtitle',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T08:00:00.000Z',
      author: null,
      lang: null,
      originDate: null,
      description: null,
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: 42000,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters: [],
    chunkSpans: [],
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: 'ready',
    ...over,
  };
}

function detailFixture(material: Material) {
  return {
    material,
    derivedAbsPath: 'C:/proj-1/materials/.derived/节奏控制入门.md',
    sourceAbsPath: 'C:/proj-1/materials/节奏控制入门.srt',
  };
}

// ── 桥 mock（文件级单 mock）──

const listMaterialsSpy = vi.fn(async (): Promise<never[]> => []);
const getMaterialSpy = vi.fn(async () => detailFixture(materialFixture()));
const updateNameSpy = vi.fn(async () => ({ ok: true, material: materialFixture() }));
const updateProvenanceSpy = vi.fn(async () => ({ ok: true, material: materialFixture() }));

function installBridge() {
  (window as any).orisonDesktop = {
    listMaterials: listMaterialsSpy,
    getMaterial: getMaterialSpy,
    deleteMaterial: vi.fn(async () => ({ ok: true, removedSourceFile: true, removedDerivedFile: true })),
    reingestMaterial: vi.fn(async () => ({ ok: true, outcome: 'reused', materialId: MATERIAL_ID })),
    importMaterials: vi.fn(),
    updateMaterialProvenance: updateProvenanceSpy,
    updateMaterialName: updateNameSpy,
    onMaterialChanged: () => () => {},
    pathForFile: vi.fn(() => ''),
    readFile: vi.fn(async () => null),
    showItemInFolder: vi.fn(),
  };
}

/** 两步落种（mirror materialsPage.test.tsx：先 currentProject 触发项目订阅 reset，后落数据）。 */
function seedState(over: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
    mainView: 'page',
    activePage: 'materials',
  } as any);
  useAppStore.setState({
    materialsScope: 'project',
    materialsListLoadedFor: 'project:00001',
    materialsList: [],
    materialsListLoading: false,
    materialsListError: null,
    materialDetail: null,
    materialDetailId: null,
    materialDetailLoading: false,
    materialDetailError: null,
    materialsImporting: false,
    materialsImportProgress: null,
    materialsImportFeedback: null,
    ...over,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  delete (window as any).orisonDesktop;
});

async function renderFormAndGetField(field: string): Promise<HTMLInputElement | HTMLTextAreaElement> {
  const { container } = render(<ProvenanceForm materialId={MATERIAL_ID} />);
  const el = await waitFor(() => {
    const node = container.querySelector(`[data-provenance-field="${field}"]`) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    expect(node).not.toBeNull();
    expect((node as HTMLInputElement).disabled).toBe(false); // 草稿装载完成
    return node!;
  });
  return el;
}

describe('标题（name 域——materials:update-name 通道）', () => {
  it('装载服务器名 + maxlength 单源（MATERIAL_NAME_MAX_CHARS）+ blur 未改零 IPC', async () => {
    seedState();
    const nameInput = (await renderFormAndGetField('name')) as HTMLInputElement;
    await waitFor(() => {
      expect(nameInput.value).toBe('节奏控制入门');
    });
    expect(nameInput.getAttribute('maxlength')).toBe(String(MATERIAL_NAME_MAX_CHARS));
    // 未改动 blur：与服务器基线相同 → 零 IPC。
    fireEvent.blur(nameInput);
    expect(updateNameSpy).not.toHaveBeenCalled();
    expect(updateProvenanceSpy).not.toHaveBeenCalled();
  });

  it('blur 落盘走独立 update-name 通道（不混 provenance patch）+ 成功 toast + slice force 重拉清单', async () => {
    seedState(); // currentProject 在位：slice ok 路径 force 重拉清单不走「无项目」守卫
    const nameInput = (await renderFormAndGetField('name')) as HTMLInputElement;
    await waitFor(() => {
      expect(nameInput.value).toBe('节奏控制入门');
    });
    fireEvent.change(nameInput, { target: { value: '节奏控制入门（重制版）' } });
    fireEvent.blur(nameInput);
    await waitFor(() => {
      expect(updateNameSpy).toHaveBeenCalledWith({
        materialId: MATERIAL_ID,
        name: '节奏控制入门（重制版）',
      });
    });
    expect(updateProvenanceSpy).not.toHaveBeenCalled(); // name 非 provenance 域（design §3.1）
    await waitFor(() => {
      // CR-5：name 专属 toast 键（不再错位显「出处信息已更新」）。
      expect(useToastStore.getState().toasts[0]?.message).toBe('materials.provenance.nameSaved');
    });
    // 标题保存后列表名刷新联动：slice ok 路径 force 重拉清单（事件面 belt 见 materialsSlice.test）。
    await waitFor(() => {
      expect(listMaterialsSpy).toHaveBeenCalled();
    });
  });

  it('CR-5：标题保存成功不清跨字段草稿——简介未 blur 草稿在 detail 刷新后保留', async () => {
    seedState();
    const nameInput = (await renderFormAndGetField('name')) as HTMLInputElement;
    const descField = (await renderFormAndGetField('description')) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(nameInput.value).toBe('节奏控制入门');
    });
    // 简介草稿（change 不 blur——未落盘）+ 标题改名 blur 落盘。
    fireEvent.change(descField, { target: { value: '讲节奏与张力的系列课' } });
    fireEvent.change(nameInput, { target: { value: '节奏控制入门（重制版）' } });
    fireEvent.blur(nameInput);
    await waitFor(() => {
      expect(updateNameSpy).toHaveBeenCalledWith({
        materialId: MATERIAL_ID,
        name: '节奏控制入门（重制版）',
      });
    });
    // 模拟 slice force 重拉 / material:changed 驱动的 detail 刷新（服务器基线——简介仍 null）。
    // 旧实现 saveName 成功 setDirty(false) → 基线重置把简介草稿清回 ''。
    act(() => {
      useAppStore.setState({
        materialDetail: detailFixture(materialFixture()),
      } as any);
    });
    // 🔑 CR-5：跨字段草稿保留（name 已对齐存回值、简介草稿不动）。
    expect(nameInput.value).toBe('节奏控制入门（重制版）');
    expect(descField.value).toBe('讲节奏与张力的系列课');
  });

  it('空/纯空白 blur：不发 IPC + 回显存量（name 非空约束——CR P17 rejectEmpty 先例）+ 拒绝后 dirty 重算（CR-4）', async () => {
    seedState();
    const nameInput = (await renderFormAndGetField('name')) as HTMLInputElement;
    await waitFor(() => {
      expect(nameInput.value).toBe('节奏控制入门');
    });
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.blur(nameInput);
    expect(updateNameSpy).not.toHaveBeenCalled();
    // 拒绝空值：输入框回弹服务器基线（视觉提示），不落盘。
    await waitFor(() => {
      expect(nameInput.value).toBe('节奏控制入门');
    });
    // 🔑 CR-4：拒绝分支按字段实际分歧重算 dirty——空名分歧已消且无他字段草稿 → dirty 归零，
    // 回声抑制解除（服务器刷新恢复接收）。旧实现 dirty 卡 true → 刷新全吞、name 永停旧值。
    act(() => {
      useAppStore.setState({
        materialDetail: detailFixture(materialFixture({ name: '外部刷新后的新标题' })),
      } as any);
    });
    await waitFor(() => {
      expect(nameInput.value).toBe('外部刷新后的新标题');
    });
  });
});

describe('简介（provenance.description——既有 patch 面）', () => {
  it('blur 落盘 partial patch 只发 description（摄取期 null → 后补）', async () => {
    seedState();
    const descField = (await renderFormAndGetField('description')) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(descField.value).toBe(''); // 服务器 null → 空串承载
    });
    fireEvent.change(descField, { target: { value: '讲节奏与张力的系列课' } });
    fireEvent.blur(descField);
    await waitFor(() => {
      expect(updateProvenanceSpy).toHaveBeenCalledWith({
        materialId: MATERIAL_ID,
        patch: { description: '讲节奏与张力的系列课' },
      });
    });
    expect(updateNameSpy).not.toHaveBeenCalled();
  });

  it('清空 blur 归一 null（清空语义——「未知」即 null）', async () => {
    seedState(); // 清残留 detail（上一测遗留会让 mount 装载去重——once-mock 不被消费）
    getMaterialSpy.mockImplementationOnce(
      async () => detailFixture(materialFixture({
        provenance: { ...materialFixture().provenance, description: '旧简介文本' },
      })),
    );
    const descField = (await renderFormAndGetField('description')) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(descField.value).toBe('旧简介文本');
    });
    fireEvent.change(descField, { target: { value: '' } });
    fireEvent.blur(descField);
    await waitFor(() => {
      expect(updateProvenanceSpy).toHaveBeenCalledWith({
        materialId: MATERIAL_ID,
        patch: { description: null },
      });
    });
  });

  it('maxlength 单源（MATERIAL_DESCRIPTION_MAX_CHARS——CR-6 UI 面，与 handler/schema 同常量）', async () => {
    seedState();
    const descField = (await renderFormAndGetField('description')) as HTMLTextAreaElement;
    expect(descField.getAttribute('maxlength')).toBe(String(MATERIAL_DESCRIPTION_MAX_CHARS));
  });
});

describe('回声抑制（基线含 name——10.2a dirty 门控覆盖）', () => {
  it('编辑中 detail 服务器刷新（旧名）不覆写草稿', async () => {
    seedState();
    const nameInput = (await renderFormAndGetField('name')) as HTMLInputElement;
    await waitFor(() => {
      expect(nameInput.value).toBe('节奏控制入门');
    });
    fireEvent.change(nameInput, { target: { value: '用户输入中的新标题' } });
    // 模拟 material:changed 驱动的 detail 刷新（服务器仍是旧名）——dirty 草稿不被覆写。
    act(() => {
      useAppStore.setState({
        materialDetail: detailFixture(materialFixture()),
      } as any);
    });
    expect(nameInput.value).toBe('用户输入中的新标题');
  });
});
