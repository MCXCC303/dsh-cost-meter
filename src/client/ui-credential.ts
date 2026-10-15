/**
 * 密钥输入控件与钱包图标。
 *
 * 迁移自原 `02-validators-helpers-sidebar.js` 1215–1327 行:
 * `CredentialField` / `SecretMigrationNotice` / `WalletIcon`。
 *
 * `CredentialField` 是 write-only 的密钥输入(v1.6.8):值只沿 setCredential 单向
 * 送入 DSH 凭据库,服务端永不回传明文(state 里的 apiKey 恒为空串),因此输入框
 * **永不回填**——已配置与否由服务端 describe() 得来,只显示「已配置(来源 x)」。
 */

// TODO(types): 平台种子 react 由 src/client/seeds.d.ts 以 any 兜底,待补真实类型后收紧。
import React from 'react'

const { createElement: el, useState, useRef } = React

/**
 * 密钥保存/清除结果提示。
 *
 * TODO(migrate): 依赖 03-settings-panels-main.js 的 cmMsg(设置面板分片尚未迁移),
 * 待共享提示组件落地后改为 import;此处内联同一实现以保证渲染结果一致。
 */
const cmMsg = (m: any) => (m != null ? el('div', { className: 'cm-msg ' + m.kind }, m.text) : null)

/**
 * 密钥输入控件(v1.6.8,write-only)。
 *
 * 密钥不再经 updateConfig 写入配置:值只沿 setCredential 单向送入 DSH 凭据库,
 * 服务端永不回传明文(state 里的 apiKey 恒为空串),因此输入框**永不回填**——
 * 已配置与否由服务端 describe() 得来,只显示「已配置(来源 x)」这类状态文案。
 *
 * 注意:本组件在 return 之前无条件调用全部 Hook(项目有 Hook 顺序门禁扫描)。
 *
 * TODO(types): props 来自设置面板宿主调用(api 为 RPC 客户端、t 为翻译函数),
 * 边界先按 any 收口,待各分节组件迁移完成后统一抽出 CredentialFieldProps。
 */
export function CredentialField({ target, configured, source, t, api, placeholder, disabled }: any) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const pending = useRef(false)
  const blocked = disabled === true || busy
  const save = async () => {
    const value = text.trim()
    if (value.length === 0 || blocked || pending.current) return
    pending.current = true
    setBusy(true)
    setMsg(null)
    try {
      const result = await api.setCredential(target, value)
      setText('')
      setEditing(false)
      setMsg({ kind: 'ok', text: result?.message ?? t('credentialSave') })
    } catch (error: any) {
      setMsg({ kind: 'err', text: String(error?.message ?? error) })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const clear = async () => {
    if (blocked || pending.current) return
    pending.current = true
    setBusy(true)
    setMsg(null)
    try {
      const result = await api.clearCredential(target)
      setText('')
      setEditing(false)
      setMsg({ kind: 'ok', text: result?.message ?? t('credentialClear') })
    } catch (error: any) {
      setMsg({ kind: 'err', text: String(error?.message ?? error) })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const cancel = () => { setText(''); setEditing(false) }
  // 浏览器可能忽略 password 的 autocomplete=off,并把前一个文本框当用户名。
  // 概览打开时不挂载密码框;明确编辑后使用独立 form,避免串到宿主会话搜索。
  return el('div', { className: 'cm-field' },
    editing ? el('form', { className: 'cm-field', autoComplete: 'off', onSubmit: (event: any) => { event.preventDefault(); void save() } },
      el('input', {
        className: 'cm-input',
        type: 'password',
        name: 'cm-credential-' + target,
        autoFocus: true,
        value: text,
        placeholder: typeof placeholder === 'string' ? placeholder : '',
        disabled: blocked,
        autoComplete: 'new-password',
        'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-bwignore': 'true',
        'aria-label': t('credentialInputHint'),
        onChange: (event: any) => setText(event.target.value),
      }),
      el('div', { className: 'cm-buttons' },
        el('button', {
          className: 'cm-btn small',
          type: 'submit',
          disabled: blocked || text.trim().length === 0,
        }, busy ? t('credentialSaving') : t('credentialSave')),
        el('button', { className: 'cm-btn small', type: 'button', onClick: cancel, disabled: busy }, t('cancel'))))
      : el('button', { className: 'cm-btn small', type: 'button', onClick: () => setEditing(true), disabled: blocked }, t('credentialEdit')),
    configured === true
      ? el('button', { className: 'cm-btn small', type: 'button', onClick: clear, disabled: blocked }, t('credentialClear'))
      : null,
    el('span', { className: 'cm-hint' },
      configured === true
        ? t('credentialConfiguredOf', { source: typeof source === 'string' && source.length > 0 ? source : 'unknown' })
        : t('credentialNotConfigured')),
    el('span', { className: 'cm-hint' }, t('credentialInputHint')),
    cmMsg(msg))
}

/**
 * 存量明文密钥未迁出提示(v1.6.8)。
 * 仅在服务端报告有密钥无法自动导入凭据库时渲染,列出需要手动导出的环境变量名。
 *
 * TODO(types): t 为翻译函数,pending 为服务端下发的环境变量名数组。
 */
export function SecretMigrationNotice({ pending, t }: any) {
  if (!Array.isArray(pending) || pending.length === 0) return null
  return el('div', { className: 'cm-msg err' },
    el('div', null, t('secretMigrationPending')),
    el('div', null, pending.join('、')))
}

// ── 钱包图标:官方填充式单色 SVG(16×16),与 @deepseek-ai/dsh-client-ui-primitives 同构 ──

/**
 * 钱包图标(余额行/余额图的通用占位图形)。
 *
 * TODO(types): size/className 为标准 SVG 透传属性,待 seeds.d.ts 落地后可换
 * `{ size?: number; className?: string }`。
 */
export function WalletIcon({ size = 16, className }: any) {
  return el('svg', { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    el('path', {
      d: 'M4 4H12A2 2 0 0 1 14 6V11.5A2 2 0 0 1 12 13.5H4A2 2 0 0 1 2 11.5V6A2 2 0 0 1 4 4ZM4 5.3H12A0.7 0.7 0 0 1 12.7 6V11.5A0.7 0.7 0 0 1 12 12.2H4A0.7 0.7 0 0 1 3.3 11.5V6A0.7 0.7 0 0 1 4 5.3Z',
      fill: 'currentColor',
      fillRule: 'evenodd',
    }),
    el('path', { d: 'M3.3 5.3H12.7V7.1H3.3Z', fill: 'currentColor' }),
    el('path', { d: 'M8 2.8A1.3 1.3 0 1 0 8 5.4A1.3 1.3 0 1 0 8 2.8Z', fill: 'currentColor' }))
}
