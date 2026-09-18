// 09-12 agy provider W4：novelModel 的 CLI 形态语义——默认清单不含 CLI 键（HTTP
// 运行时消费者：NovelModelSelector / resolveNovelModelRuntime），includeCli 供任务档
// 指派面开启；preferredRef 直指 CLI 模型时运行时解析落 null（不构造残缺 HTTP 运行时）。
import { describe, expect, it } from 'vitest';
import type { ApiKeyEntry } from '@orison/shared-contracts';
import {
  listNovelTextModelRefs,
  resolveNovelModelRuntime,
} from '../src/shared/model/novelModel';

const httpKey: ApiKeyEntry = {
  id: 'key_http',
  name: 'Relay',
  protocol: 'openai-compatible',
  baseUrl: 'https://relay.example.com',
  apiKey: 'sk-test',
  models: [{ id: 'gpt-4o', alias: 'GPT-4o Omni', capability: 'text', enabled: true }],
};

const cliKey: ApiKeyEntry = {
  id: 'key_cli',
  name: 'Antigravity',
  protocol: 'antigravity-cli',
  cliExecutable: 'C:/agy/bin/agy.exe',
  models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true }],
};

describe('novelModel CLI-form semantics（09-12 agy provider W4）', () => {
  it('default listing excludes CLI keys (HTTP runtime consumers must not see them)', () => {
    const options = listNovelTextModelRefs([httpKey, cliKey]);
    expect(options).toHaveLength(1);
    expect(options[0]!.ref).toEqual({ keyId: 'key_http', modelId: 'gpt-4o' });
    expect(options[0]!.protocol).toBe('openai-compatible');
  });

  it('includeCli surfaces CLI text models with their protocol for the assignment face', () => {
    const options = listNovelTextModelRefs([httpKey, cliKey], { includeCli: true });
    expect(options).toHaveLength(2);
    const cli = options.find((o) => o.ref.keyId === 'key_cli')!;
    expect(cli.ref).toEqual({ keyId: 'key_cli', modelId: 'gemini-3.8-pro-high' });
    expect(cli.protocol).toBe('antigravity-cli');
  });

  it('resolveNovelModelRuntime falls back to an HTTP option, never a CLI one', () => {
    const runtime = resolveNovelModelRuntime([httpKey, cliKey], null);
    expect(runtime).toEqual({
      keyId: 'key_http',
      modelId: 'gpt-4o',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-test',
    });
  });

  it('a preferredRef pointing at a CLI model yields null runtime (no half-built HTTP face)', () => {
    const runtime = resolveNovelModelRuntime([httpKey, cliKey], {
      keyId: 'key_cli',
      modelId: 'gemini-3.8-pro-high',
    });
    expect(runtime).toBeNull();
  });

  it('a CLI-only config yields an empty default listing and null runtime', () => {
    expect(listNovelTextModelRefs([cliKey])).toEqual([]);
    expect(resolveNovelModelRuntime([cliKey], null)).toBeNull();
  });
});
