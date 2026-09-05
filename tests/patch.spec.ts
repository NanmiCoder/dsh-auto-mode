import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { parsePatchEffects } from '../src/patch.js'
import { assessTool, hardDenyReason } from '../src/policy.js'
import { resolveRoots } from '../src/paths.js'
import { ArtifactRegistry } from '../src/artifacts.js'

const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/protected/dsh' })
const exec = (input: string) => ({ name: 'apply_patch', arguments: { input } }) as ToolExecution
describe('patch mutation policy', () => {
  it('guards every supplied payload instead of trusting an ambiguous preferred field', () => {
    const input = '*** Begin Patch\n*** Delete File: /protected/dsh/settings.yaml\n*** End Patch'
    const patch = '*** Begin Patch\n*** Add File: safe.txt\n+safe\n*** End Patch'
    expect(hardDenyReason({ ...exec(input), arguments: { input, patch } }, roots)).toMatch(/DSH_HOME/)
  })
  it('retains both rename destinations and deletion semantics', () => {
    const input = '*** Begin Patch\n*** Update File: a/file.txt\n*** Move to: b/file.txt\n@@\n-old\n+new\n*** Delete File: other.txt\n*** End Patch'
    expect(parsePatchEffects(input)).toEqual([
      { kind: 'delete', path: 'a/file.txt' }, { kind: 'create-or-overwrite', path: 'b/file.txt' }, { kind: 'delete', path: 'other.txt' },
    ])
    expect(assessTool(exec(input), roots, new ArtifactRegistry())).toMatchObject({ decision: 'ask', classifierEligible: false })
  })
  it('requires approval for third-party native edits and alternate dialects', () => {
    expect(assessTool(exec('*** Begin Patch\n*** Add File: src/a.ts\n+test\n*** End Patch'), roots, new ArtifactRegistry())).toMatchObject({ decision: 'ask', classifierEligible: false })
    for (const input of ['--- a/x\n+++ b/x', '*** Begin Patch\n*** Add File: x\n+ok\nmalformed\n*** End Patch', '*** Begin Patch\n*** Update File: x\n*** End Patch']) {
      expect(assessTool(exec(input), roots, new ArtifactRegistry())).toMatchObject({ decision: 'ask', classifierEligible: false })
    }
  })
  it('guards both move paths and unified critical paths even with malformed bodies', () => {
    for (const input of ['*** Begin Patch\n*** Update File: /protected/dsh/settings.yaml\n*** Move to: x\n@@\n+x\n*** End Patch', '*** Begin Patch\n*** Update File: x\n*** Move to: /protected/dsh/settings.yaml\n@@\n+x\n*** End Patch', '--- a/x\n+++ /protected/dsh/settings.yaml\nmalformed']) {
      expect(hardDenyReason(exec(input), roots)).toMatch(/DSH_HOME/)
    }
  })
})
