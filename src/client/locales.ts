/** Locale namespace owned by the Auto permission client. */
export const AUTO_MODE_LOCALE_NAMESPACE = 'dsh-auto-mode.permission'

/** Simplified Chinese copy for every plugin-owned permission surface. */
export const zh = {
  'preset.label': '自动审批',
  'preset.description': '在工作区沙箱内执行；自动审查风险，并可为必要的越界访问提供一次性审批。',
  'dialog.title': '确认启用自动审批？',
  'dialog.description': '自动审批在日常操作中继续使用 DSH 的“可写入工作区”操作系统级文件沙箱；仅当任务明确需要范围小且可恢复的越界操作时，才会自动批准一次精确的权限提升。删除或覆盖已有数据仍需用户直接且明确授权，且授权不会延伸到其他目标。文件沙箱不限制读取、网络访问或外部服务；Windows 上仅提供部分约束，DSH 工具链之外的代码也不受本策略约束。',
  'dialog.acknowledge': '我已了解风险，并愿意继续',
  'dialog.cancel': '取消',
  'dialog.confirm': '启用自动审批',
  'dialog.close': '关闭',
} satisfies Record<string, string>

/** Locale keys consumed by the compatibility layer. */
export type AutoModeLocaleKey = keyof typeof zh

/** English copy, checked against the Chinese source key set. */
export const en = {
  'preset.label': 'Auto',
  'preset.description': 'Workspace-sandboxed execution with automatic review and one-shot approval for wider access.',
  'dialog.title': 'Enable Auto?',
  'dialog.description': 'Auto keeps DSH\u2019s workspace-write operating-system file sandbox for ordinary work and can approve one exact wider request when a narrow, reversible step is clearly required by your task. Deleting or overwriting pre-existing data still requires exact direct-user authority and never extends to another target. The file sandbox does not restrict reads, network access, or external services; Windows enforcement is partial, and code outside the DSH tool pipeline remains outside this policy.',
  'dialog.acknowledge': 'I understand the risks and want to continue',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Enable Auto',
  'dialog.close': 'Close',
} satisfies Record<AutoModeLocaleKey, string>

/** Stable translation function passed from the official locale service. */
export type AutoModeTranslate = (key: AutoModeLocaleKey) => string

/** English fallback for direct use outside an assembled DSH client. */
export const translateEnglish: AutoModeTranslate = key => en[key]
