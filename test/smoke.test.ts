import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'

describe('toolchain', () => {
  it('can synthesize an empty stack', () => {
    const app = new App()
    const stack = new Stack(app, 'Smoke', { env: { account: '111111111111', region: 'us-east-1' } })
    expect(Template.fromStack(stack).toJSON()).toBeDefined()
  })
})
