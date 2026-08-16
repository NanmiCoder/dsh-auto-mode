import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('bundled Auto preset', () => {
  it('keeps automatic authorization inside workspace-write by default', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const autoBlock = patch.match(/^      auto:\n([\s\S]*?)(?=^      danger-full-access:)/m)?.[1]

    expect(autoBlock).toBeDefined()
    expect(autoBlock).toContain('sandbox: workspace-write')
    expect(autoBlock).toContain('approval: ask')
    expect(autoBlock).not.toContain('sandbox: danger-full-access')
  })
})
