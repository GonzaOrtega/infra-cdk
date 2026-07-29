import { describe, expect, it } from 'vitest'
import * as api from '../src/index'

describe('public API', () => {
  it('exports exactly the documented surface', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'GithubOidcStack',
        'MonitoredFn',
        'PlatformStack',
        'applyGovernance',
        'defineStages',
        'isStageName',
        'resolveStage',
      ].sort(),
    )
  })
})
