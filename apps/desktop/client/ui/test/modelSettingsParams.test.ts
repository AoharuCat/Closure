import { describe, expect, it } from 'vitest';
import type { ApiKeyEntry, DiscoveredModel } from '@orison/shared-contracts';
import { MODEL_DEFAULT_RANGES } from '@orison/shared-contracts';
import {
  draftCustomHeadersRecord,
  draftToKey,
  emptyKeyDraft,
  emptyModelDefaults,
  emptyModelPricing,
  findKeyDraftIssue,
  formatParamRangeLabel,
  isKeyDirty,
  keyToDraft,
} from '../src/features/model-settings/utils';

// ── 09-12 子3 W4：KeyDraft 三投影（keyToDraft / draftToKey / isKeyDirty）的子3 字段面。
// 该页是手写表单（无 FIELD_SPEC 自动对拍）——往返 + dirty 判定是契约锚（design §5.1/§5.3）。──

const FULL_MODEL: DiscoveredModel = {
  id: 'm-full',
  alias: 'Full',
  capability: 'text',
  enabled: true,
  defaults: {
    temperature: 0.7,
    topP: 0.9,
    frequencyPenalty: -0.2,
    presencePenalty: 0.3,
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
  },
  extraBody: { safe_prompt: true, vendor: { min_p: 0.05 } },
  pricing: { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.2 },
};

const FULL_KEY: ApiKeyEntry = {
  id: 'key_001',
  name: 'Params relay',
  protocol: 'openai-compatible',
  apiKey: 'sk-test',
  baseUrl: 'https://relay.example.com/v1',
  customHeaders: { 'X-Route-Tag': 'closure', 'X-Num': '12345' },
  timeoutSeconds: 90,
  streamingDisabled: true,
  verifySsl: true,
  models: [FULL_MODEL, { id: 'm-plain', alias: 'Plain', capability: 'text', enabled: false }],
};

const fullDraft = () => keyToDraft(FULL_KEY);

describe('model-settings utils 子3 projections', () => {
  it('keyToDraft → draftToKey 全字段往返（headers record↔数组、数值 string 中间态、extraBody JSON 文本）', () => {
    const key = draftToKey(fullDraft(), 'key_001');
    expect(key.customHeaders).toEqual({ 'X-Route-Tag': 'closure', 'X-Num': '12345' });
    expect(key.timeoutSeconds).toBe(90);
    expect(key.streamingDisabled).toBe(true);
    expect(key.verifySsl).toBe(true);
    expect(key.models[0]?.defaults).toEqual(FULL_MODEL.defaults);
    expect(key.models[0]?.extraBody).toEqual(FULL_MODEL.extraBody);
    expect(key.models[0]?.pricing).toEqual(FULL_MODEL.pricing);
    // 无子3 字段的模型：三键全 ABSENT（二态写侧不落空对象/空串）。
    expect(key.models[1]?.defaults).toBeUndefined();
    expect(key.models[1]?.extraBody).toBeUndefined();
    expect(key.models[1]?.pricing).toBeUndefined();
    // 二次往返稳定（draft 中间态无漂移）。
    expect(draftToKey(keyToDraft(key), 'key_001')).toEqual(key);
  });

  it('空草稿投影：全 ABSENT（旧键保存不添新键）', () => {
    const draft = emptyKeyDraft();
    draft.name = 'Bare';
    draft.apiKey = 'sk';
    draft.baseUrl = 'https://relay.example.com/v1';
    draft.models = [
      { id: 'm', alias: 'm', capability: 'text', enabled: true, defaults: emptyModelDefaults(), extraBody: '', pricing: emptyModelPricing() },
    ];
    const key = draftToKey(draft, 'key_x');
    expect(key.customHeaders).toBeUndefined();
    expect(key.timeoutSeconds).toBeUndefined();
    expect(key.streamingDisabled).toBeUndefined();
    expect(key.verifySsl).toBeUndefined();
    expect(key.models[0]?.defaults).toBeUndefined();
    expect(key.models[0]?.extraBody).toBeUndefined();
    expect(key.models[0]?.pricing).toBeUndefined();
  });

  it('dirty：顺序无关（headers 按 name 排序归一比较）；数值/文本变更 dirty', () => {
    // 顺序重排 ≠ dirty。
    const reordered = fullDraft();
    reordered.customHeaders = [...reordered.customHeaders].reverse();
    expect(isKeyDirty(reordered, FULL_KEY)).toBe(false);

    // header 值变更 → dirty。
    const changedValue = fullDraft();
    changedValue.customHeaders = changedValue.customHeaders.map((h) =>
      h.name === 'X-Route-Tag' ? { ...h, value: 'other' } : h,
    );
    expect(isKeyDirty(changedValue, FULL_KEY)).toBe(true);

    // header 增删 → dirty。
    const added = fullDraft();
    added.customHeaders = [...added.customHeaders, { name: 'X-New', value: 'v' }];
    expect(isKeyDirty(added, FULL_KEY)).toBe(true);

    // defaults 数值变更（string 中间态）→ dirty。
    const changedTemp = fullDraft();
    changedTemp.models[0]!.defaults.temperature = '0.9';
    expect(isKeyDirty(changedTemp, FULL_KEY)).toBe(true);

    // timeout string ↔ persisted number 同口径。
    const changedTimeout = fullDraft();
    changedTimeout.timeoutSeconds = '120';
    expect(isKeyDirty(changedTimeout, FULL_KEY)).toBe(true);

    // 布尔开关变更 → dirty。
    const toggled = fullDraft();
    toggled.streamingDisabled = false;
    expect(isKeyDirty(toggled, FULL_KEY)).toBe(true);

    // extraBody 文本变更 → dirty。
    const changedExtra = fullDraft();
    changedExtra.models[0]!.extraBody = '{"safe_prompt": false}';
    expect(isKeyDirty(changedExtra, FULL_KEY)).toBe(true);
  });

  it('CLI 形态投影：采样族/上限/extraBody/传输面三件套剥除，contextWindow 与 verifySsl 保留', () => {
    const draft = fullDraft();
    draft.protocol = 'antigravity-cli';
    draft.cliExecutable = 'C:/agy/bin/agy.exe';
    const key = draftToKey(draft, 'key_001');
    expect(key.protocol).toBe('antigravity-cli');
    expect(key.cliExecutable).toBe('C:/agy/bin/agy.exe');
    expect(key.customHeaders).toBeUndefined();
    expect(key.timeoutSeconds).toBeUndefined();
    expect(key.streamingDisabled).toBeUndefined();
    expect(key.verifySsl).toBe(true); // CLI 容忍（refine 放行）
    // 模型面：仅 contextWindow 存活（refine 拒其余——协议切换后草稿残留防泄漏）。
    expect(key.models[0]?.defaults).toEqual({ contextWindow: 131_072 });
    expect(key.models[0]?.extraBody).toBeUndefined();
    expect(key.models[0]?.pricing).toEqual(FULL_MODEL.pricing); // 元数据放行
  });

  it('draftCustomHeadersRecord：空名行丢弃、空 map = undefined', () => {
    const draft = emptyKeyDraft();
    draft.customHeaders = [
      { name: '', value: 'orphan' }, // 未填名的行
      { name: ' X-Space ', value: 'trimmed' },
    ];
    expect(draftCustomHeadersRecord(draft)).toEqual({ 'X-Space': 'trimmed' });
    draft.customHeaders = [{ name: '', value: 'x' }];
    expect(draftCustomHeadersRecord(draft)).toBeUndefined();
  });

  it('findKeyDraftIssue：NaN 数值 / 坏 JSON / 非对象 JSON / 非法 header 名各报各键；干净草稿 null', () => {
    const clean = fullDraft();
    expect(findKeyDraftIssue(clean)).toBeNull();

    const badTemp = fullDraft();
    badTemp.models[0]!.defaults.temperature = 'abc';
    expect(findKeyDraftIssue(badTemp)).toEqual({
      key: 'settings.modelParamNumberInvalid',
      vars: { model: 'm-full', field: 'temperature' },
    });

    const badPricing = fullDraft();
    badPricing.models[0]!.pricing.inputPerMillion = '1..5';
    expect(findKeyDraftIssue(badPricing)?.key).toBe('settings.modelParamNumberInvalid');

    const badJson = fullDraft();
    badJson.models[0]!.extraBody = '{"broken":';
    expect(findKeyDraftIssue(badJson)).toEqual({ key: 'settings.extraBodyInvalid', vars: { model: 'm-full' } });

    const nonObject = fullDraft();
    nonObject.models[0]!.extraBody = '[1, 2]';
    expect(findKeyDraftIssue(nonObject)?.key).toBe('settings.extraBodyInvalid');

    const badHeader = fullDraft();
    badHeader.customHeaders = [...badHeader.customHeaders, { name: 'Bad Header', value: 'v' }];
    expect(findKeyDraftIssue(badHeader)).toEqual({
      key: 'settings.customHeaderNameInvalid',
      vars: { name: 'Bad Header' },
    });

    const badTimeout = fullDraft();
    badTimeout.timeoutSeconds = 'soon';
    expect(findKeyDraftIssue(badTimeout)?.vars?.field).toBe('timeoutSeconds');
  });

  // ── CR-7（09-12 子3 CR 批）：数值域前置核校（域常量单源——本地报字段名，不死在保存面 generic 文案） ──
  it('CR-7: 采样族越域本地报 range 键（temperature 55）；timeout 90.5 报 integer 键；timeout 9999999 报 range 键', () => {
    const hot = fullDraft();
    hot.models[0]!.defaults.temperature = '55';
    expect(findKeyDraftIssue(hot)).toEqual({
      key: 'settings.modelParamRangeInvalid',
      vars: { model: 'm-full', field: 'temperature', min: 0, max: 2 },
    });

    const fracTimeout = fullDraft();
    fracTimeout.timeoutSeconds = '90.5';
    expect(findKeyDraftIssue(fracTimeout)).toEqual({
      key: 'settings.modelParamIntegerInvalid',
      vars: { model: 'Params relay', field: 'timeoutSeconds' },
    });

    const hugeTimeout = fullDraft();
    hugeTimeout.timeoutSeconds = '9999999';
    expect(findKeyDraftIssue(hugeTimeout)).toEqual({
      key: 'settings.modelParamRangeInvalid',
      vars: { model: 'Params relay', field: 'timeoutSeconds', min: 1, max: 86400 },
    });

    // 整数族字段（contextWindow）0/负/小数 → integer 键；pricing 负值 → pricing 键。
    const zeroWindow = fullDraft();
    zeroWindow.models[0]!.defaults.contextWindow = '0';
    expect(findKeyDraftIssue(zeroWindow)?.key).toBe('settings.modelParamIntegerInvalid');
    const negPricing = fullDraft();
    negPricing.models[0]!.pricing.inputPerMillion = '-1';
    expect(findKeyDraftIssue(negPricing)?.key).toBe('settings.pricingRangeInvalid');

    // 域边界值合法（0 与 2 都过——非「只报非零」）。
    const edges = fullDraft();
    edges.models[0]!.defaults.temperature = '0';
    expect(findKeyDraftIssue(edges)).toBeNull();
  });

  // ── CR-8：十六进制/科学计数法形态拒（Number() 重释落盘变形） ──
  it('CR-8: "0x10"/"1e3" 数字形态本地报 number 键；draftToKey 防御性丢弃不变形落盘', () => {
    for (const weird of ['0x10', '1e3']) {
      const hex = fullDraft();
      hex.models[0]!.defaults.temperature = weird;
      expect(findKeyDraftIssue(hex)?.key).toBe('settings.modelParamNumberInvalid');
      // 投影防御：即便绕过前置校验，draftNum 只认十进制——不重释成 16/1000 落盘。
      const projected = draftToKey(hex, 'key_001');
      expect(projected.models[0]?.defaults?.temperature).toBeUndefined();
    }
    const hexTimeout = fullDraft();
    hexTimeout.timeoutSeconds = '0x10';
    expect(findKeyDraftIssue(hexTimeout)?.key).toBe('settings.modelParamNumberInvalid');
  });

  // ── CR-9：header 名 case-insensitive 去重 ──
  it('CR-9: X-Tag/x-tag 大小写变体重复 → duplicate 键（同名冲突不上 wire）', () => {
    const dup = fullDraft();
    dup.customHeaders = [...dup.customHeaders, { name: 'x-route-tag', value: 'other' }];
    expect(findKeyDraftIssue(dup)).toEqual({
      key: 'settings.customHeaderNameDuplicate',
      vars: { name: 'x-route-tag' },
    });
    // 不同名（仅大小写不同才算重复）合法。
    const distinct = fullDraft();
    distinct.customHeaders = [...distinct.customHeaders, { name: 'X-Other', value: 'v' }];
    expect(findKeyDraftIssue(distinct)).toBeNull();
  });

  // ── CR-10：新键 transport-only 编辑也算 dirty ──
  it('CR-10: 新键（无 persisted key）只配超时/流式禁用/证书 → dirty=true（未保存改动不再无警告丢弃）', () => {
    const timeoutOnly = emptyKeyDraft();
    timeoutOnly.timeoutSeconds = '120';
    expect(isKeyDirty(timeoutOnly, undefined)).toBe(true);

    const fuseOnly = emptyKeyDraft();
    fuseOnly.streamingDisabled = true;
    expect(isKeyDirty(fuseOnly, undefined)).toBe(true);

    const sslOnly = emptyKeyDraft();
    sslOnly.verifySsl = true;
    expect(isKeyDirty(sslOnly, undefined)).toBe(true);

    // 真空草稿仍非 dirty（回归锚）。
    expect(isKeyDirty(emptyKeyDraft(), undefined)).toBe(false);
  });

  // ── CR-11：数字草稿 trim 对齐 headersDirty ──
  it('CR-11: 数字草稿纯空白差异非 dirty（" 0.7" vs persisted 0.7）', () => {
    const spaced = fullDraft();
    spaced.models[0]!.defaults.temperature = ' 0.7';
    expect(isKeyDirty(spaced, FULL_KEY)).toBe(false);
    const spacedPricing = fullDraft();
    spacedPricing.models[0]!.pricing.inputPerMillion = ' 1.5';
    expect(isKeyDirty(spacedPricing, FULL_KEY)).toBe(false);
  });

  // ── CR-15：range 占位从域常量派生 ──
  it('CR-15: formatParamRangeLabel 从域常量格式化（0–2 紧排 / -2 – 2 负下界加空格），不手抄', () => {
    expect(formatParamRangeLabel(MODEL_DEFAULT_RANGES.temperature)).toBe('0–2');
    expect(formatParamRangeLabel(MODEL_DEFAULT_RANGES.topP)).toBe('0–1');
    expect(formatParamRangeLabel(MODEL_DEFAULT_RANGES.frequencyPenalty)).toBe('-2 – 2');
    expect(formatParamRangeLabel(MODEL_DEFAULT_RANGES.presencePenalty)).toBe('-2 – 2');
  });
});
