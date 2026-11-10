// Browser half of Handoff Hub: a sidebar entry and a full management page.
// Plain __ModuleLoader__ CJS, same shape as the shipped client plugins; React
// comes from the browser module table and every visible string goes through the
// Client locale service. The Host routes are same-origin and loopback-only.
//
// The loader id must match this package's name. The public release sync rewrites
// the local `@local/dsh-handoff-hub` id to `dsh-handoff-hub`.
window.__ModuleLoader__.load({
  id: 'dsh-handoff-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'handoff-hub'
    const API = '/handoff-hub'
    const REFRESH_MS = 5000
    const FALLBACK_LOCALE = Object.freeze({ active: 'zh', revision: 0 })
    const fallbackSubscribe = () => () => {}
    const fallbackSnapshot = () => FALLBACK_LOCALE
    let translate = (key) => key
    let localeService = null

    const DICT_ZH = {
      nav: '对话组',
      title: '对话组',
      subtitle: '同一工作区的模型会话，通过交接文档保持同步。',
      room: '交接室',
      refresh: '刷新',
      nudgeAll: '提醒全部',
      autoTitle: '目录变更自动提醒',
      autoHint: '文档变化后去抖 30 秒，只提醒交接文档较旧的会话；短时间多批变更合并为一条。开关仅本次运行生效。',
      on: '开启',
      off: '关闭',
      members: '已登记会话',
      memberCount: (count) => `${count} 个`,
      empty: '还没有会话登记。让模型调用 handoff_join，或从下方邀请活跃会话。',
      unregistered: '同工作区的未登记会话',
      invite: '邀请加入',
      nudge: '提醒',
      remove: '移出',
      confirmRemove: '确认移出',
      cancel: '取消',
      live: '活跃',
      idle: '未运行',
      missingDoc: '文档未创建',
      updated: (time) => `更新于 ${time}`,
      warnings: '警告',
      loadFailed: '加载失败',
      retry: '重试',
      nudged: (count) => `已提醒 ${count} 个会话`,
      nudgedPartial: (ok, failed) => `${ok} 个已提醒，${failed} 个失败`,
      removed: '已移出（交接文档保留）',
      invited: '邀请已发送',
      autoChanged: (state) => `自动提醒已${state}`,
      noUnregistered: '没有未登记的同工作区会话',
      doc: '文档',
      session: '会话',
      working: '处理中…',
      close: '关闭',
      loadErrorHint: '确认插件已启用，或刷新页面后重试。'
    }

    const DICT_EN = {
      nav: 'Sessions',
      title: 'Session group',
      subtitle: 'Model sessions in one workspace, kept in sync through handoff documents.',
      room: 'Handoff room',
      refresh: 'Refresh',
      nudgeAll: 'Nudge all',
      autoTitle: 'Auto reminder on directory changes',
      autoHint: 'After a document change, debounce 30s, notify only sessions whose handoff document is stale, and merge short bursts into one reminder; the switch lasts until reload.',
      on: 'On',
      off: 'Off',
      members: 'Registered sessions',
      memberCount: (count) => `${count}`,
      empty: 'No session is registered yet. Ask a model to call handoff_join, or invite a live session below.',
      unregistered: 'Live sessions not in the group',
      invite: 'Invite',
      nudge: 'Nudge',
      remove: 'Remove',
      confirmRemove: 'Confirm remove',
      cancel: 'Cancel',
      live: 'Live',
      idle: 'Idle',
      missingDoc: 'Document not created',
      updated: (time) => `updated ${time}`,
      warnings: 'Warnings',
      loadFailed: 'Could not load the group',
      retry: 'Retry',
      nudged: (count) => `Nudged ${count} session(s)`,
      nudgedPartial: (ok, failed) => `${ok} delivered, ${failed} failed`,
      removed: 'Removed from the group (document kept)',
      invited: 'Invitation sent',
      autoChanged: (state) => `Auto reminder is now ${state}`,
      noUnregistered: 'No live unregistered session in this workspace',
      doc: 'Document',
      session: 'Session',
      working: 'Working…',
      close: 'Close',
      loadErrorHint: 'Check that the plugin is enabled, then refresh the page and retry.'
    }

    const CSS = `
      .hh-page { box-sizing: border-box; height: 100%; overflow: auto; padding: 28px 32px 48px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
        font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .hh-inner { max-width: 980px; margin: 0 auto; }
      .hh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .hh-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
      .hh-subtitle { margin: 5px 0 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
      .hh-actions { display: flex; gap: 8px; flex: 0 0 auto; }
      .hh-room { margin-top: 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .hh-room code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px;
        color: var(--dsw-alias-label-primary); word-break: break-all; }
      .hh-card { margin-top: 16px; padding: 16px 18px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
      .hh-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .hh-card-title { margin: 0; font-size: 14px; font-weight: 600; }
      .hh-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .hh-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
        padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .hh-row:first-of-type { border-top: 0; }
      .hh-main { min-width: 0; flex: 1; }
      .hh-name { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 600; font-size: 13px; }
      .hh-sid { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 400;
        font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .hh-doc { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .hh-path { margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .hh-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px;
        border-radius: 999px; font-size: 11px; font-weight: 500; }
      .hh-badge-live { color: var(--dsw-alias-state-success-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
      .hh-badge-idle { color: var(--dsw-alias-state-idle-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 14%, transparent); }
      .hh-badge-warn { color: var(--dsw-alias-state-warn-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
      .hh-row-actions { display: flex; gap: 6px; flex: 0 0 auto; padding-top: 2px; }
      .hh-btn { appearance: none; cursor: pointer; height: 28px; padding: 0 11px; border-radius: 7px;
        border: 1px solid var(--dsw-alias-border-l2); background: transparent;
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; font-weight: 500; }
      .hh-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
      .hh-btn:disabled { cursor: default; opacity: 0.5; }
      .hh-btn-primary { border-color: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-brand-primary); }
      .hh-btn-danger { border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-state-error-primary); }
      .hh-btn-ghost { border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .hh-switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; padding: 0;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: transparent;
        cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; }
      .hh-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
        border-radius: 50%; background: var(--dsw-alias-label-secondary);
        transition: transform 0.15s ease, background 0.15s ease; }
      .hh-switch.hh-on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .hh-switch.hh-on::after { transform: translateX(16px); background: var(--dsw-alias-bg-base); }
      .hh-switch:disabled { cursor: default; opacity: 0.5; }
      .hh-auto-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .hh-notice { margin-top: 14px; padding: 9px 12px; border-radius: 8px; font-size: 12px; }
      .hh-notice-ok { color: var(--dsw-alias-state-success-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
      .hh-notice-error { color: var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
      .hh-empty { padding: 18px 0 8px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .hh-warn { margin-top: 8px; color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
      .hh-error { margin-top: 16px; padding: 18px; border: 1px solid var(--dsw-alias-state-error-primary);
        border-radius: 12px; color: var(--dsw-alias-state-error-primary); font-size: 13px; }
      .hh-error p { margin: 4px 0 12px; color: var(--dsw-alias-label-secondary); }
    `

    function dictFor(language) {
      return language === 'en' ? DICT_EN : DICT_ZH
    }

    function tr(key, ...args) {
      const dict = dictFor(localeService?.getSnapshot?.()?.active || 'zh')
      const value = dict[key]
      if (typeof value === 'function') return value(...args)
      if (typeof value === 'string') return value
      return key
    }

    function shortId(value) {
      const text = String(value || '')
      return text.length > 10 ? `…${text.slice(-8)}` : text
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms)) return ''
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return ''
      }
    }

    function Icon({ size = 16, active = false }) {
      return h(
        'svg',
        {
          viewBox: '0 0 32 32',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', opacity: active ? 1 : 0.78 }
        },
        h('path', { d: 'M6 7.5h20v13.5H16l-6.5 5v-5H6z' }),
        h('path', { d: 'M11 12.5h10M11 16.5h6', opacity: 0.75 })
      )
    }

    async function readState() {
      const response = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message || `HTTP ${response.status}`)
      }
      return data
    }

    async function runAction(action, payload) {
      const response = await fetch(`${API}/action`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-handoff-hub': '1'
        },
        body: JSON.stringify({ action, ...payload })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message || `HTTP ${response.status}`)
      }
      return data
    }

    function Page() {
      const locale = useSyncExternalStore(
        localeService?.subscribe || fallbackSubscribe,
        localeService?.getSnapshot || fallbackSnapshot,
        localeService?.getSnapshot || fallbackSnapshot
      )
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [confirmId, setConfirmId] = useState(null)
      const alive = useRef(true)

      const load = useCallback(async (quiet) => {
        if (!quiet) setState((current) => ({ ...current, status: current.data ? current.status : 'loading' }))
        try {
          const data = await readState()
          if (alive.current) setState({ status: 'ready', data, error: null })
        } catch (error) {
          if (alive.current) setState((current) => ({ status: 'error', data: current.data, error: error.message || String(error) }))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load(false)
        const timer = setInterval(() => {
          void load(true)
        }, REFRESH_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      useEffect(() => {
        if (!confirmId) return undefined
        const timer = setTimeout(() => setConfirmId(null), 5000)
        return () => clearTimeout(timer)
      }, [confirmId])

      const data = state.data
      const autoOn = data?.autoRemind?.enabled === true

      const act = useCallback(async (name, payload, busyKey) => {
        setBusy(busyKey)
        setNotice(null)
        try {
          const result = await runAction(name, payload)
          if (name === 'nudge') {
            const delivered = Array.isArray(result.delivered) ? result.delivered.length : 0
            const failed = Array.isArray(result.failed) ? result.failed.length : 0
            setNotice({
              kind: failed > 0 && delivered === 0 ? 'error' : 'ok',
              text: failed > 0 ? tr('nudgedPartial', delivered, failed) : tr('nudged', delivered)
            })
          } else if (name === 'remove') {
            setNotice({ kind: 'ok', text: tr('removed') })
            setConfirmId(null)
          } else if (name === 'invite') {
            setNotice({ kind: 'ok', text: tr('invited') })
          } else if (name === 'auto') {
            setNotice({ kind: 'ok', text: tr('autoChanged', result.autoRemind?.enabled ? tr('on') : tr('off')) })
          }
          await load(true)
        } catch (error) {
          setNotice({ kind: 'error', text: error.message || String(error) })
        } finally {
          setBusy('')
        }
      }, [load])

      const members = data?.participants || []
      const unregistered = data?.unregistered || []
      const warnings = data?.warnings || []

      if (state.status === 'loading' && !data) {
        return h('div', { className: 'hh-page' }, h('style', null, CSS), h('div', { className: 'hh-inner' },
          h('p', { className: 'hh-muted' }, tr('working'))
        ))
      }

      if (state.status === 'error' && !data) {
        return h('div', { className: 'hh-page' }, h('style', null, CSS), h('div', { className: 'hh-inner' },
          h('div', { className: 'hh-error' },
            h('strong', null, tr('loadFailed')),
            h('p', null, state.error || tr('loadErrorHint')),
            h('button', { type: 'button', className: 'hh-btn', onClick: () => void load(false) }, tr('retry'))
          )
        ))
      }

      return h('div', { className: 'hh-page', 'data-locale': locale.active }, h('style', null, CSS), h('div', { className: 'hh-inner' },
        h('header', { className: 'hh-head' },
          h('div', null,
            h('h1', { className: 'hh-title' }, tr('title')),
            h('p', { className: 'hh-subtitle' }, tr('subtitle'))
          ),
          h('div', { className: 'hh-actions' },
            h('button', {
              type: 'button',
              className: 'hh-btn',
              disabled: Boolean(busy),
              onClick: () => void load(false)
            }, tr('refresh'))
          )
        ),
        data?.room ? h('div', { className: 'hh-room' }, `${tr('room')}: `, h('code', null, data.room)) : null,
        notice ? h('div', {
          className: `hh-notice ${notice.kind === 'error' ? 'hh-notice-error' : 'hh-notice-ok'}`,
          role: 'status'
        }, notice.text) : null,
        h('section', { className: 'hh-card' },
          h('div', { className: 'hh-auto-line' },
            h('div', null,
              h('h2', { className: 'hh-card-title' }, tr('autoTitle')),
              h('div', { className: 'hh-muted', style: { marginTop: 4 } }, tr('autoHint'))
            ),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': autoOn,
              'aria-label': tr('autoTitle'),
              className: `hh-switch${autoOn ? ' hh-on' : ''}`,
              disabled: Boolean(busy),
              onClick: () => void act('auto', { enabled: !autoOn }, 'auto')
            })
          )
        ),
        h('section', { className: 'hh-card' },
          h('div', { className: 'hh-card-head' },
            h('h2', { className: 'hh-card-title' }, `${tr('members')} · ${tr('memberCount', members.length)}`),
            h('button', {
              type: 'button',
              className: 'hh-btn hh-btn-primary',
              disabled: Boolean(busy) || members.length === 0,
              onClick: () => void act('nudge', {}, 'nudge-all')
            }, tr('nudgeAll'))
          ),
          members.length === 0
            ? h('div', { className: 'hh-empty' }, tr('empty'))
            : members.map((member) => h('div', { className: 'hh-row', key: member.sessionId },
              h('div', { className: 'hh-main' },
                h('div', { className: 'hh-name' },
                  h('span', null, member.name),
                  h('span', { className: `hh-badge ${member.live ? 'hh-badge-live' : 'hh-badge-idle'}` },
                    member.live ? tr('live') : tr('idle')),
                  h('span', { className: 'hh-sid' }, shortId(member.sessionId))
                ),
                h('div', { className: 'hh-doc' },
                  member.doc,
                  member.meta?.exists
                    ? ` · ${formatBytes(member.meta.bytes)} · ${tr('updated', formatTime(member.meta.mtimeMs))}`
                    : ` · ${tr('missingDoc')}`
                ),
                h('div', { className: 'hh-path', title: member.absolute }, member.absolute)
              ),
              h('div', { className: 'hh-row-actions' },
                h('button', {
                  type: 'button',
                  className: 'hh-btn',
                  disabled: Boolean(busy),
                  onClick: () => void act('nudge', { targetSessionId: member.sessionId }, `nudge:${member.sessionId}`)
                }, tr('nudge')),
                h('button', {
                  type: 'button',
                  className: `hh-btn ${confirmId === member.sessionId ? 'hh-btn-danger' : 'hh-btn-ghost'}`,
                  disabled: Boolean(busy),
                  onClick: () => {
                    if (confirmId === member.sessionId) void act('remove', { targetSessionId: member.sessionId }, `remove:${member.sessionId}`)
                    else setConfirmId(member.sessionId)
                  }
                }, confirmId === member.sessionId ? tr('confirmRemove') : tr('remove'))
              )
            ))
        ),
        h('section', { className: 'hh-card' },
          h('div', { className: 'hh-card-head' },
            h('h2', { className: 'hh-card-title' }, `${tr('unregistered')} · ${tr('memberCount', unregistered.length)}`)
          ),
          unregistered.length === 0
            ? h('div', { className: 'hh-empty' }, tr('noUnregistered'))
            : unregistered.map((entry) => h('div', { className: 'hh-row', key: entry.sessionId },
              h('div', { className: 'hh-main' },
                h('div', { className: 'hh-name' },
                  h('span', null, entry.title || shortId(entry.sessionId)),
                  h('span', { className: 'hh-sid' }, shortId(entry.sessionId)),
                  entry.running ? h('span', { className: 'hh-badge hh-badge-live' }, tr('live')) : null
                )
              ),
              h('div', { className: 'hh-row-actions' },
                h('button', {
                  type: 'button',
                  className: 'hh-btn hh-btn-primary',
                  disabled: Boolean(busy),
                  onClick: () => void act('invite', { targetSessionId: entry.sessionId }, `invite:${entry.sessionId}`)
                }, tr('invite'))
              )
            ))
        ),
        warnings.length > 0
          ? h('div', { className: 'hh-warn' }, `${tr('warnings')}: ${warnings.slice(0, 3).join('; ')}`)
          : null
      ))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'handoff-hub: panel copy')
        translate = ctx.locale.bind(NS)
        localeService = ctx.locale

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'handoff-hub',
          order: 5,
          locale: NS,
          label: () => translate('nav')
        }, Icon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'handoff-hub',
          locale: NS
        }, Page))
      }
    }
  }
})
