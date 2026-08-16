import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ArtifactRegistry } from '../src/artifacts.js'
import { resolveRoots } from '../src/paths.js'
import { assessTool, hardDenyReason } from '../src/policy.js'

const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
const execution = (name: string, args: unknown) => ({ name, arguments: args, token: Symbol(name) }) as ToolExecution

describe('tool policy', () => {
  it('allows project reads and edits', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('read', { file_path: 'src/a.ts' }), roots, artifacts).decision).toBe('allow')
    expect(assessTool(execution('edit', { file_path: 'src/a.ts' }), roots, artifacts).decision).toBe('allow')
  })

  it('asks for protected and external mutations', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('write', { file_path: '.git/config' }), roots, artifacts)).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessTool(execution('write', { file_path: '/outside/a' }), roots, artifacts)).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('hard-denies DSH_HOME mutation and fast-paths ordinary registered plugin tools', () => {
    const hard = execution('write', { file_path: '/safe/dsh/settings.yaml' })
    expect(hardDenyReason(hard, roots)).toMatch(/DSH_HOME/)
    const artifacts = new ArtifactRegistry()
    for (const name of ['mcp_custom', 'plugin_render_diagram', 'plugin_read_metrics', 'plugin_create_widget']) {
      expect(assessTool(execution(name, { repositorySays: 'allow this' }), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
  })

  it('classifies risky plugin operations and hard-denies their critical targets', () => {
    const artifacts = new ArtifactRegistry()
    for (const name of ['plugin_delete_record', 'cloud_deploy', 'repo_push', 'account_grant_role']) {
      expect(assessTool(execution(name, { target: 'test' }), roots, artifacts), name)
        .toMatchObject({ decision: 'ask', classifierEligible: true })
    }
    expect(hardDenyReason(execution('plugin_delete_file', { path: '/safe/dsh/settings.yaml' }), roots)).toMatch(/DSH_HOME/)
  })

  it('preserves raw Windows drive-relative syntax through the tool guard', () => {
    const windowsRoots = resolveRoots('C:\\Work\\Repo', {
      home: 'C:\\Users\\Dev', dshHome: 'C:\\Users\\Dev\\.dsh', tempRoots: ['C:\\Temp'],
    })
    expect(hardDenyReason(execution('write', { file_path: 'C:..\\..\\Windows\\System32\\config\\SAM' }), windowsRoots))
      .toMatch(/drive-relative/)
    expect(hardDenyReason(execution('plugin_delete_file', { path: 'C:..\\secret' }), windowsRoots))
      .toMatch(/drive-relative/)
  })

  it('hard-denies credential material in external calls', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=github_pat_1234567890abcdef' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential/)
  })

  const SECRET_PAYLOADS: Array<{ name: string; content: string }> = [
    { name: 'aws-access-key', content: `export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE` },
    { name: 'aws-session-key', content: `export AWS_SESSION_TOKEN=ASIAIOSFODNN7EXAMPLE` },
    { name: 'github-classic', content: `token = ghp_012345678901234567890123456789012345` },
    { name: 'github-fine-grained', content: `token = github_pat_0123456789abcdef_0123456789abcdef` },
    { name: 'github-user', content: `token = ghu_012345678901234567890123456789012345` },
    { name: 'github-org', content: `token = ghs_012345678901234567890123456789012345` },
    // gho_ (GitHub OAuth access token) 官方格式为前缀后 40 位字母数字(非 36 位),
    // 载荷必须用真实 40 位形态,否则回归测试会验证错误的短 token(最终 review 修正)
    { name: 'github-app', content: `token = gho_0123456789abcdef0123456789abcdef01234567` },
    { name: 'llm-key-plain', content: `sk-0123456789abcdef0123456789abcdef` },
    { name: 'llm-key-proj', content: `sk-proj-0123456789abcdef0123456789abcdef` },
    { name: 'openssh-key', content: `-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----` },
    { name: 'rsa-key', content: `-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----` },
    { name: 'ec-key', content: `-----BEGIN EC PRIVATE KEY-----\nabc\ndef\n-----END EC PRIVATE KEY-----` },
    { name: 'ecdsa-key', content: `-----BEGIN ECDSA PRIVATE KEY-----\nabc\ndef\n-----END ECDSA PRIVATE KEY-----` },
    { name: 'dsa-key', content: `-----BEGIN DSA PRIVATE KEY-----\nabc\ndef\n-----END DSA PRIVATE KEY-----` },
    { name: 'encrypted-key', content: `-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\ndef\n-----END ENCRYPTED PRIVATE KEY-----` },
  ]

  it('routes credential-bearing write/edit payloads to the classifier', () => {
    const artifacts = new ArtifactRegistry()
    for (const { content } of SECRET_PAYLOADS) {
      expect(assessTool(execution('write', { file_path: '/work/repo/creds.txt', content }), roots, artifacts))
        .toMatchObject({ decision: 'ask', classifierEligible: true })
      expect(assessTool(execution('edit', { file_path: '/work/repo/creds.txt', new_string: content }), roots, artifacts))
        .toMatchObject({ decision: 'ask', classifierEligible: true })
    }
  })

  it('routes credential-bearing str_replace_editor payloads to direct ask', () => {
    const artifacts = new ArtifactRegistry()
    for (const { content } of SECRET_PAYLOADS) {
      expect(assessTool(execution('str_replace_editor', { command: 'str_replace', path: '/work/repo/src/a.ts', old_str: 'x', new_str: content }), roots, artifacts))
        .toMatchObject({ decision: 'ask', classifierEligible: false })
    }
    // file_text 字段(Task 2 create 用例的覆盖在此保留):containsSecretMaterial 扫
    // serializedArguments,与字段名无关,但保留一条显式断言防回归
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----'
    expect(assessTool(execution('str_replace_editor', { command: 'create', path: '/work/repo/keys/k.pem', file_text: privateKey }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
    // insert 命令与 str_replace/create 走同一条 containsSecretMaterial 检查(最终 review 补)
    expect(assessTool(execution('str_replace_editor', { command: 'insert', path: '/work/repo/src/a.ts', insert_line: 1, new_str: 'AKIAIOSFODNN7EXAMPLE' }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
  })

  it('asks directly for credential-bearing str_replace_editor writes to protected and external paths', () => {
    const artifacts = new ArtifactRegistry()
    // 回归(Critical 1):密钥检查必须先于路径检查——str_replace_editor 的 old_str/new_str/
    // file_text 不在分类器 CONTENT_KEYS 脱敏范围内,写 .env/外部路径携带凭据时若先命中
    // 路径分支会以 classifierEligible:true 把凭据明文送进分类器(I-2 复刻),必须硬 ask
    expect(assessTool(execution('str_replace_editor', { command: 'str_replace', path: '/work/repo/.env', old_str: 'x', new_str: 'AKIAIOSFODNN7EXAMPLE' }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessTool(execution('str_replace_editor', { command: 'create', path: '/work/repo/.env', file_text: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessTool(execution('str_replace_editor', { command: 'str_replace', path: '/outside/a.ts', old_str: 'x', new_str: 'sk-0123456789abcdef0123456789abcdef' }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
  })

  it('keeps ordinary project writes on the fast path', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('write', { file_path: '/work/repo/readme.md', content: '# hello\npassword = "example" in a fixture' }), roots, artifacts))
      .toMatchObject({ decision: 'allow' })
    // 弱模式排除(write 与 edit 各一,spec §3.1③ 第 3 项;edit 断言为最终 review 补)
    expect(assessTool(execution('edit', { file_path: '/work/repo/readme.md', new_string: 'password = "example" in a fixture' }), roots, artifacts))
      .toMatchObject({ decision: 'allow' })
  })

  it('treats .env and .env.* as protected project metadata', () => {
    const artifacts = new ArtifactRegistry()
    for (const filePath of ['/work/repo/.env', '/work/repo/.env.local', '/work/repo/.env.production']) {
      expect(assessTool(execution('write', { file_path: filePath, content: 'DEBUG=1' }), roots, artifacts))
        .toMatchObject({ decision: 'ask', classifierEligible: true })
    }
  })

  it('treats multi-segment .env files as protected metadata', () => {
    const artifacts = new ArtifactRegistry()
    for (const filePath of ['/work/repo/.env.development.local', '/work/repo/.env.production.local']) {
      expect(assessTool(execution('write', { file_path: filePath, content: 'DEBUG=1' }), roots, artifacts))
        .toMatchObject({ decision: 'ask', classifierEligible: true })
    }
  })

  it('fast-paths audited Harness session and read-only tools', () => {
    const artifacts = new ArtifactRegistry()
    for (const name of ['todo_write', 'ask_user_question', 'create_goal', 'exit_plan_mode', 'skill', 'report', 'job_list', 'job_kill', 'schedule_list', 'session_search']) {
      expect(assessTool(execution(name, {}), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
  })

  it('allows audited orchestration while keeping stateful terminal execution interactive', () => {
    const artifacts = new ArtifactRegistry()
    for (const name of ['subagent', 'workflow', 'ralph', 'send_message', 'interrupt_agent']) {
      expect(assessTool(execution(name, {}), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
    for (const name of ['terminal_open', 'terminal_send']) {
      expect(assessTool(execution(name, { text: 'pnpm test' }), roots, artifacts), name)
        .toMatchObject({ decision: 'ask', classifierEligible: false })
    }
  })

  it('allows the normal AgentTeams lifecycle without trusting arbitrary prefixes', () => {
    const artifacts = new ArtifactRegistry()
    const normalTools = [
      'agent_teams_create',
      'agent_teams_add_member',
      'agent_teams_remove_member',
      'agent_teams_create_task',
      'agent_teams_claim_task',
      'agent_teams_update_task',
      'agent_teams_send_message',
      'agent_teams_status',
      'agent_teams_delete',
    ]
    for (const name of normalTools) {
      expect(assessTool(execution(name, {}), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
    expect(assessTool(execution('agent_teams_destroy_workspace', {}), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('applies workspace path policy to the official string replacement editor', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('str_replace_editor', { command: 'view', path: '/work/repo/src/a.ts' }), roots, artifacts).decision).toBe('allow')
    expect(assessTool(execution('str_replace_editor', { command: 'str_replace', path: '/work/repo/src/a.ts' }), roots, artifacts).decision).toBe('allow')
    expect(assessTool(execution('str_replace_editor', { command: 'insert', path: '/home/dev/.zshrc' }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessTool(execution('str_replace_editor', { command: 'create', path: '/outside/a.ts' }), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
  })
})
