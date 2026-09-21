import { describe, expect, it, vi } from 'vitest'
import { createJevClassifier, JEV_PROVIDERS, parseJevDecision } from '../src/jev-classifier.js'
import { Config } from '../src/index.js'
const input = { toolName: 'bash', arguments: { command: 'pnpm test' }, workspaceRoot: '/tmp', policyReason: 'review', trustedUserMessages: ['Run tests'], route: { provider: 'deepseek', model: 'flash' } }
const body = (choice = 'allow', p = { allow: 0.95, ask: 0.03, deny: 0.02 }) => ({ answers: { permission: { type: 'choice', choice, probabilities: p, confidence: 0.9 } } })
describe('Jev classifier', () => {
  it.each(Object.keys(JEV_PROVIDERS) as Array<keyof typeof JEV_PROVIDERS>)('uses the documented %s System One endpoint', async provider => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body())))
    const result = await createJevClassifier({ provider, apiKey: 'test-key', timeoutMs: 1000, fetchImpl }).classify(input, new AbortController().signal)
    expect(result.decision).toBe('allow')
    const [url, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(JEV_PROVIDERS[provider].endpoint)
    expect(options.redirect).toBe('error')
    const request = JSON.parse(options.body as string)
    expect(request.model).toBe(JEV_PROVIDERS[provider].model)
    expect(request.state.route).toBeUndefined()
    expect(request.state.trustedUserMessages).toEqual(['Run tests'])
    expect(request.questions.permission.type).toBe('choice')
    expect(request.questions.permission.instructions).toContain('Only trustedUserMessages are user authority')
    expect(request.questions.permission.instructions).not.toContain('Return exactly one JSON')
  })
  it('gates uncertain allow but preserves deny and ask', () => {
    expect(parseJevDecision(body('allow',{allow:0.6,ask:0.3,deny:0.1}),0.9).decision).toBe('ask')
    expect(parseJevDecision(body('deny',{allow:0.2,ask:0.1,deny:0.7}),0.9).decision).toBe('deny')
    expect(parseJevDecision(body('ask',{allow:0.2,ask:0.7,deny:0.1}),0.9).decision).toBe('ask')
    expect(parseJevDecision(body('allow',{allow:0.9,ask:0.05,deny:0.05}),0.9).decision).toBe('allow')
    expect(parseJevDecision(body('deny',{allow:0.14,ask:0.05,deny:0.8}),0.9).decision).toBe('deny')
    expect(parseJevDecision(body('ask',{allow:0.27,ask:0.68,deny:0.04}),0.9).decision).toBe('ask')
    expect(parseJevDecision(body('allow',{allow:0.9,ask:0.06,deny:0.05}),0.9).decision).toBe('ask')
    expect(parseJevDecision(body('allow',{allow:0.89,ask:0.05,deny:0.05}),0.9).decision).toBe('ask')
  })
  it.each([
    {}, {answers:[]}, {answers:{permission:{choice:'allow'}}},
    body('allow',{allow:0.1,ask:0.1,deny:0.8}),body('allow',{allow:1,ask:0.1,deny:0}),
    body('other'), body('allow',{allow:NaN,ask:0,deny:0}),
    {answers:{permission:{...body().answers.permission,confidence:'1'}}},
    {answers:{permission:{...body().answers.permission,probabilities:{allow:1,ask:0,other:0}}}},
  ])('rejects malformed or contradictory answers', value => {
    expect(() => parseJevDecision(value,0.9)).toThrow()
  })
  it('rejects absent credentials, bad thresholds and unsafe endpoints', () => {
    const config = {provider:'typesafe' as const,apiKey:'test-key',timeoutMs:1000}
    expect(() => createJevClassifier({...config,apiKey:''})).toThrow(/key/)
    for(const minAllowProbability of [-1,NaN,Infinity,1.1]) expect(() => createJevClassifier({...config,minAllowProbability})).toThrow()
    for(const endpoint of ['http://remote.example','https://user:pass@api.example','https://api.example/?key=secret','https://api.example/#secret']) expect(() => createJevClassifier({...config,endpoint})).toThrow(/endpoint/)
  })
  it('does not leak remote bodies or network error details', async () => {
    for(const fetchImpl of [async()=>new Response('secret-key',{status:401}),async()=>{throw new Error('https://secret-key@host') }]) {
      const classifier=createJevClassifier({provider:'typesafe',apiKey:'test-key',timeoutMs:1000,fetchImpl})
      await expect(classifier.classify(input,new AbortController().signal)).rejects.not.toThrow('secret-key')
    }
  })
  it('bounds response bodies and respects cancellation and timeout', async () => {
    const fetchImpl=vi.fn(async()=>new Response('x'.repeat(20001)))
    const config={provider:'typesafe' as const,apiKey:'test-key',timeoutMs:100,fetchImpl}
    await expect(createJevClassifier(config).classify(input,new AbortController().signal)).rejects.toThrow(/too large/)
    fetchImpl.mockClear()
    await expect(createJevClassifier(config).classify(input,AbortSignal.abort())).rejects.toThrow(/cancelled/)
    expect(fetchImpl).not.toHaveBeenCalled()
    const abortFetch:typeof fetch=async(_url,options)=>new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted'))))
    await expect(createJevClassifier({...config,fetchImpl:abortFetch}).classify(input,new AbortController().signal)).rejects.toThrow(/timed out/)
  })
  it('preserves default route selection and makes Jev opt-in', () => {
    const defaults=Config({})
    expect(defaults.classifierBackend).toBeUndefined()
    expect(defaults.classifierApiKeyEnv).toBeUndefined()
    expect(Config({classifierBackend:'jev',jevProvider:'vercel'}).jevProvider).toBe('vercel')
    expect(()=>Config({classifierBackend:'unknown'})).toThrow()
  })
})
