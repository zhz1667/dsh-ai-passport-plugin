/**
 * 插件 × 假宿主的集成测试。
 *
 * 覆盖的是"插件到底有没有正确接上 DSH"这件事——不涉及蓝牙硬件：
 *   任务列表/新建/下发/中断、状态事件驱动更新、完成提醒、
 *   审批瀑布的三种结局（设备批 / 交回网页 / 设备无响应）、余额两条路径、语音识别与注入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRuntime } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'
import { FakeHost } from './fake-host.js'
import { MSG, TASK_STATE } from '../lib/protocol/constants.js'

/** 用 mock 传输起一个完整的运行时，并接上假宿主。 */
async function setupRuntime(hostOptions = {}, configOverrides = {}) {
  const host = new FakeHost(hostOptions)
  const config = normalizeConfig({ transport: 'mock', autoConnect: false, ...configOverrides })
  const runtime = createRuntime({ config, logger: () => {} })
  await runtime.connect()
  // 等握手落地（mock 传输是异步冒泡的）
  await new Promise((resolve) => setTimeout(resolve, 40))
  runtime.attachHost(host)
  return { host, runtime, config }
}

/**
 * 等一个事件出现。
 *
 * 为什么不能"发完事件立刻断言"：完成提醒要先 await 把消息通过 BLE 发给设备，
 * 之后才广播给面板（这个顺序保证设备先响铃、面板后刷新）。
 * 直接断言会落在 await 之前的时刻，看到的是假失败。
 */
function waitForEvent(runtime, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`等待事件 ${type} 超时`))
    }, timeoutMs)
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type !== type) return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

/** 观察宿主发往设备的消息（借助 mock 传输记录的"设备收件箱"）。 */
function sentByHost(runtime) {
  return runtime.link.transport.received.map((entry) => entry.message)
}

/**
 * 等设备**真的**收到满足条件的那条 `task.state`，返回它。
 *
 * 为什么不能"发完 sleep 一下就断言"：主机的发送要经过链路队列异步落地，
 * 固定 sleep 是在跟投递赛跑 —— 这个用例第一版就栽在这里（睡 20ms 时那条
 * 状态还在队列里，断言看到的是上一条 idle，报了一个假失败）。
 * 轮询等待既快又稳：条件一旦成立立刻返回，超时才报错并附上最后一条实际内容。
 */
async function waitForDeviceTaskState(runtime, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = sentByHost(runtime).filter((message) => message.type === MSG.TASK_STATE).at(-1)
    if (last && predicate(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`等待设备收到预期的 task.state 超时，最后一条：${JSON.stringify(last)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 触发某个已注册的协议处理器，模拟"设备发来一条消息"。 */
async function invokeHandler(runtime, type, payload) {
  const handler = runtime.link.handlers.get(type)
  assert.ok(handler, `没有注册 ${type} 的处理器`)
  const replies = []
  await handler(
    { type, ...payload },
    {
      msgId: 1,
      channel: 0,
      reply: async (replyType, replyPayload) => {
        replies.push({ type: replyType, ...replyPayload })
      },
    },
  )
  return replies
}

function teardown({ runtime }) {
  return runtime.dispose()
}

// ══════════════════════════════════════════════════════════════════════════
//  状态聚合（精简版的核心）
//
//  设备只显示四态之一，而四态必须由主机聚合 —— 判断"当前状态"需要同时知道
//  有几个会话在跑、有没有审批挂起、刚才是否结束，这些只有主机侧完整。
// ══════════════════════════════════════════════════════════════════════════

test('状态：无会话时是空闲，且初始就补推一次给设备', async () => {
  const { runtime } = await setupRuntime()
  // 链路就绪时会 force 推一次：否则设备在没有任何状态变化时会停在默认值
  runtime.domains.state.onLinkReady()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const sent = runtime.domains.state.snapshot()
  assert.equal(sent.state, TASK_STATE.IDLE, '没有会话时应为空闲')
  await teardown({ runtime })
})

test('状态：turn/start → 运行中；turn/end → 已完成', async () => {
  const { host, runtime } = await setupRuntime()
  const { state } = runtime.domains
  state.onLinkReady()

  host.addSession({ id: 'session-a', title: '重构登录模块' })
  host.startTurn('session-a')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.snapshot().state, TASK_STATE.RUNNING, '有轮次在跑就是运行中')

  host.endTurn('session-a', { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.snapshot().state, TASK_STATE.COMPLETED, '结束后应短暂显示已完成')
  // 完成态要带上标题，否则设备只能显示一句泛泛的"任务刚刚结束"
  assert.match(state.snapshot().title, /重构登录模块/)
  await teardown({ runtime })
})

test('状态：「已完成」只停留一段时间，之后回落到空闲', async () => {
  const { host, runtime } = await setupRuntime()
  const { state } = runtime.domains
  host.addSession({ id: 'session-b', title: 'B' })
  host.startTurn('session-b')
  host.endTurn('session-b', { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.snapshot().state, TASK_STATE.COMPLETED)

  // 直接把停留期判定条件拨到过去，避免测试真的等 8 秒
  state.completedUntil = Date.now() - 1
  assert.equal(state.snapshot().state, TASK_STATE.IDLE, '停留期过后必须回落到空闲')
  await teardown({ runtime })
})

test('状态：待审批优先级高于运行中', async () => {
  const { host, runtime } = await setupRuntime()
  const { state } = runtime.domains
  host.addSession({ id: 'session-c', title: 'C' })
  host.startTurn('session-c')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.snapshot().state, TASK_STATE.RUNNING)

  // 审批挂起时必须压过"运行中"——它在等一个人，其它状态都只是信息
  state.setApproval('写文件')
  assert.equal(state.snapshot().state, TASK_STATE.WAITING_APPROVAL, '待审批必须压过运行中')
  assert.equal(state.snapshot().title, '写文件')

  state.setApproval(null)
  assert.equal(state.snapshot().state, TASK_STATE.RUNNING, '审批结束后回到运行中')
  await teardown({ runtime })
})

test('状态：同一状态不重复推送（避免设备反复响提示音）', async () => {
  const { host, runtime } = await setupRuntime()
  const { state } = runtime.domains
  host.addSession({ id: 'session-d', title: 'D' })
  host.startTurn('session-d')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const sent = []
  const original = runtime.link.send.bind(runtime.link)
  runtime.link.send = (type, payload) => {
    sent.push({ type, payload })
    return Promise.resolve({})
  }
  // 连续推 5 次，状态没变 → 一次都不该发出去
  for (let i = 0; i < 5; i += 1) state.push()
  runtime.link.send = original
  assert.equal(sent.length, 0, '状态未变化时不应重复推送')
  await teardown({ runtime })
})

test('状态：并发任务数变化必须重新下发（设备不能停在"1 个任务执行中"）', async () => {
  // 真机反馈：同时开两个任务，设备上一直显示"1 个任务执行中"。
  // 根因是主机按**状态**去重，而「运行中」的标题里写着计数 —— 状态没变、
  // 标题变了，第二个任务的推送就被吞掉了。
  const { host, runtime } = await setupRuntime()
  const { state } = runtime.domains
  state.onLinkReady()

  host.addSession({ id: 'session-m1', title: '重构登录模块' })
  host.addSession({ id: 'session-m2', title: '修复导出乱码' })

  host.startTurn('session-m1')
  const first = await waitForDeviceTaskState(runtime, (message) => message.title === '1 个任务执行中')
  assert.ok(first, '第一个任务开始时设备应显示 1')

  host.startTurn('session-m2')
  await waitForDeviceTaskState(runtime, (message) => message.title === '2 个任务执行中')
  assert.equal(state.snapshot().runningCount, 2, '主机侧必须知道有两个任务在跑')

  // 结束其中一个：状态仍是 running，但计数必须回落 —— 否则设备会一直显示 2
  host.endTurn('session-m1', { kind: 'completed' })
  const remaining = await waitForDeviceTaskState(runtime, (message) => message.title === '1 个任务执行中')
  assert.equal(remaining.state, TASK_STATE.RUNNING, '还有一个任务在跑，状态仍是运行中')

  // 全部结束：回到「已完成」并带上刚结束的任务标题
  host.endTurn('session-m2', { kind: 'completed' })
  const done = await waitForDeviceTaskState(
    runtime,
    (message) => message.state === TASK_STATE.COMPLETED && /修复导出乱码/.test(message.title ?? ''),
  )
  assert.ok(done, '全部结束后设备应显示已完成 + 刚结束的任务标题')
  await teardown({ runtime })
})

test('审批：设备放行 → allowed-once，且不交回下游', async () => {
  const { host, runtime } = await setupRuntime()
  const asked = new Promise((resolve) => runtime.subscribe((event) => {
    if (event.type === 'approval.asked') resolve(event)
  }))

  const pending = host.askApproval({ toolName: 'read', reason: '读取配置文件' })
  const request = await asked
  assert.ok(request.id, '审批请求应带 id')
  assert.equal(request.risk, 'low', '只读工具应标为低风险')

  // 模拟用户在设备上选了"允许"
  const decided = runtime.domains.approval.decide(request.id, 'allow')
  assert.equal(decided, true)

  const result = await pending
  assert.equal(result.outcome, 'allowed-once', '设备放行必须映射成 allowed-once')
  assert.equal(result.via, 'listener', '不应交回下游')
  await teardown({ runtime })
})

test('审批：设备拒绝 → rejected', async () => {
  const { host, runtime } = await setupRuntime()
  const asked = new Promise((resolve) => runtime.subscribe((event) => {
    if (event.type === 'approval.asked') resolve(event)
  }))
  const pending = host.askApproval({ toolName: 'read' })
  const request = await asked
  runtime.domains.approval.decide(request.id, 'deny')
  const result = await pending
  assert.equal(result.outcome, 'rejected')
  await teardown({ runtime })
})

test('审批：默认所有工具（含写操作）都上设备批', async () => {
  // 真机返工记录：之前默认 readOnlyToolsOnDevice=true，写操作被静默交回
  // 电脑端 —— 用户在设备上看不到任何弹窗，以为审批功能没实现。
  // 现在默认全部上设备：设备端默认停在「拒绝」、允许需二次确认、超时按拒绝上报，
  // 安全性不受影响。
  const { host, runtime } = await setupRuntime()
  const events = []
  runtime.subscribe((event) => events.push(event))

  const asked = new Promise((resolve) => runtime.subscribe((event) => {
    if (event.type === 'approval.asked') resolve(event)
  }))
  const pending = host.askApproval({ toolName: 'bash', reason: '执行构建' })
  const request = await asked
  assert.equal(request.toolName, 'bash', '写操作也应送到设备')
  runtime.domains.approval.decide(request.id, 'allow')
  const result = await pending
  assert.equal(result.via, 'listener', '写操作默认应在设备上批（不交回下游）')
  assert.equal(events.filter((event) => event.type === 'approval.asked').length, 1, '应向设备发起审批')
  await teardown({ runtime })
})

test('审批：readOnlyToolsOnDevice=true 时写操作交回下游，不在设备上批', async () => {
  // 显式开启"只读限制"配置时，写操作才回电脑端（该配置功能保留覆盖）。
  const { host, runtime } = await setupRuntime({}, {
    approval: { enabled: true, timeoutMs: 5000, readOnlyToolsOnDevice: true },
  })
  const events = []
  runtime.subscribe((event) => events.push(event))

  const result = await host.askApproval({ toolName: 'bash', reason: '执行构建' })
  assert.equal(result.via, 'fallback-downstream', '开启只读限制后写操作必须回电脑端审批')
  assert.equal(result.outcome, 'allowed-once') // 假宿主的兜底值
  assert.equal(events.filter((event) => event.type === 'approval.asked').length, 0, '不应向设备发起审批')
  await teardown({ runtime })
})

test('审批默认不超时：timeoutMs=0 时不自动结算，一直等用户作答', async () => {
  const { host, runtime } = await setupRuntime({}, { approval: { enabled: true, timeoutMs: 0 } })
  const events = []
  runtime.subscribe((event) => events.push(event))

  const pending = host.askApproval({ toolName: 'bash', reason: '执行构建' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(events.filter((e) => e.type === 'approval.settled').length, 0, '0 = 不超时，不该自动结算')
  assert.equal(runtime.snapshot().approvals.length, 1, '审批应仍挂在设备上')

  // 用户在设备上作答（等同于设备端按下「允许一次」）→ 正常结算
  const id = runtime.snapshot().approvals[0].id
  await invokeHandler(runtime, MSG.APPROVE, { id, decision: 'allow', scope: 'once' })
  const result = await pending
  assert.equal(result.via, 'listener', '由设备作答（经我们的监听者返回）')
  assert.equal(result.outcome, 'allowed-once')
  await teardown({ runtime })
})

test('审批：设备无响应时交回下游，绝不默认放行', async () => {
  const { host, runtime } = await setupRuntime({}, { approval: { enabled: true, timeoutMs: 5000, readOnlyToolsOnDevice: true } })
  const asked = new Promise((resolve) => runtime.subscribe((event) => {
    if (event.type === 'approval.asked') resolve(event)
  }))
  const pending = host.askApproval({ toolName: 'read' })

  // 模拟蓝牙掉线：设备永远不会作答
  runtime.link.transport.simulateDrop('test-drop')
  await asked

  const result = await pending
  assert.equal(result.via, 'fallback-downstream', '设备不可用时应交回电脑端')
  assert.notEqual(result.outcome, 'allowed-once-rejected-by-device')
  await teardown({ runtime })
})

test('审批：请求方中断 → cancelled', async () => {
  const { host, runtime } = await setupRuntime()
  const asked = new Promise((resolve) => runtime.subscribe((event) => {
    if (event.type === 'approval.asked') resolve(event)
  }))
  const controller = new AbortController()
  const pending = host.askApproval({ toolName: 'read', signal: controller.signal })
  await asked
  controller.abort()
  const result = await pending
  assert.equal(result.outcome, 'cancelled')
  await teardown({ runtime })
})

test('审批：设备审批关闭时全部交回下游', async () => {
  const { host, runtime } = await setupRuntime({}, { approval: { enabled: false, timeoutMs: 5000, readOnlyToolsOnDevice: true } })
  const result = await host.askApproval({ toolName: 'read' })
  assert.equal(result.via, 'fallback-downstream')
  await teardown({ runtime })
})

test('余额：账号路径把充值 + 赠金合并，且只算同一币种', async () => {
  const { host, runtime } = await setupRuntime()
  const balance = await runtime.domains.balance.refresh({ push: false })
  assert.equal(balance.currency, 'CNY')
  assert.equal(balance.totalBalance, 42.5, '30 元充值 + 12.5 元赠金')
  assert.equal(balance.rechargeBalance, 30)
  assert.equal(balance.bonusBalance, 12.5)
  assert.equal(balance.source, 'account')
  assert.ok(host.calls.some((entry) => entry.method === 'account.getBalance'))
  await teardown({ runtime })
})

test('余额：账号未登录 → 明确失败，且不缓存成 0', async () => {
  const { host, runtime } = await setupRuntime({ notLoggedIn: true, noAccount: false })
  const balance = await runtime.domains.balance.refresh({ push: false })
  assert.equal(balance, null, '未登录必须返回 null，而不是 0')
  assert.match(runtime.snapshot().balanceError, /未获取到余额/)
  assert.equal(runtime.snapshot().balance, null)
  await teardown({ runtime })
})

test('余额：平台报错时同样不伪造数据', async () => {
  const { runtime } = await setupRuntime({ balanceFails: 'HTTP 503' })
  const balance = await runtime.domains.balance.refresh({ push: false })
  assert.equal(balance, null)
  assert.match(runtime.snapshot().balanceError, /未获取到余额/)
  await teardown({ runtime })
})

test('语音：识别提供者缺失时给出可操作的说明，而不是静默失败', async () => {
  const { runtime } = await setupRuntime({ speechProvider: null })
  await runtime.domains.voice.refreshCatalog()
  const snapshot = runtime.snapshot()
  assert.match(String(snapshot.speechError), /没有可用的识别提供者/)
  await assert.rejects(() => runtime.domains.voice.prepare(), /没有可用的识别提供者|没有启用语音识别服务/)
  await teardown({ runtime })
})

test('语音：有提供者时能读到就绪状态并触发准备', async () => {
  const { host, runtime } = await setupRuntime({ speechProvider: { id: 'sensevoice-local', name: 'SenseVoiceSmall', phase: 'unprepared' } })
  const info = await runtime.domains.voice.refreshCatalog()
  assert.equal(info.providerId, 'sensevoice-local')
  assert.equal(info.ready, false)
  assert.match(String(info.detail), /尚未准备/)
  await runtime.domains.voice.prepare()
  assert.ok(host.calls.some((entry) => entry.method === 'speech.prepare'))
  await teardown({ runtime })
})

test('Agent 工具：注册了预期的一整套，且设备未连接时给出可操作的错误', async () => {
  const { host, runtime } = await setupRuntime()
  const { registerTools } = await import('../lib/tools/index.js')
  const disposers = registerTools(host, runtime, () => {})

  const names = [...host.registeredTools.keys()].sort()
  assert.deepEqual(names, [
    'ap_balance',
    'ap_device_ask',
    'ap_device_notify',
    'ap_device_status',
  ])

  // 先断开，再调用需要连接的工具
  await runtime.link.stop()
  await assert.rejects(
    () => host.registeredTools.get('ap_device_notify').execute({ text: '你好' }),
    /未连接/,
  )

  // status 工具在断开时也要能正常返回，而不是抛错
  const status = await host.registeredTools.get('ap_device_status').execute({})
  assert.equal(status.connected, false)
  assert.ok(status.hint, '未连接时应给出下一步提示')

  for (const dispose of disposers) dispose()
  await teardown({ runtime })
})

test('面板动作分发：全部动作都能被识别，未知动作明确报错', async () => {
  const { runtime } = await setupRuntime()
  const dispatch = runtime.dispatch

  await dispatch('device.ping', {})
  await dispatch('device.toast', { text: '测试' })
  await dispatch('device.refresh', {})
  await dispatch('balance.refresh', {})

  // 运行期改录音上限（面板下拉的后端动作）：写进配置快照，坏值吸附到档位
  const cap = await dispatch('voice.setMaxSeconds', { seconds: 120 })
  assert.equal(cap.message, '录音上限已设为 120 秒')
  assert.equal(cap.state.config.voice.maxSeconds, 120, '新上限应出现在快照里')
  const capped = await dispatch('voice.setMaxSeconds', { seconds: 9999 })
  assert.equal(capped.state.config.voice.maxSeconds, 360, '超过协议天花板应吸附到 360')

  await assert.rejects(() => dispatch('nope.nope', {}), /未知的面板动作/)
  await teardown({ runtime })
})

test('配置归一化：越界与非法值被钳制，不抛错', () => {
  const config = normalizeConfig({
    transport: 'not-a-transport',
    mtuPayload: 99999,
    tasks: { maxItems: 999 },
    approval: { timeoutMs: 1 },
    voice: { maxSeconds: -5 },
    logLevel: 'nonsense',
  })
  assert.equal(config.transport, 'bridge', '非法传输名退回默认')
  assert.equal(config.mtuPayload, 512, 'MTU 上限 512')
  assert.equal(config.tasks.maxItems, 50, '任务数上限 50')
  assert.equal(config.approval.timeoutMs, 5000, '审批超时下限 5 秒')
  // 录音上限是离散档位：越界/非法值吸附到最近的合法档位，绝不抛错
  assert.equal(config.voice.maxSeconds, 60, '录音上限最小值 60 秒（-5 吸附到 60）')
  assert.equal(config.logLevel, 'info')
})

test('配置归一化：录音上限支持 60 / 120 / 360 三档，越界吸附且不超协议天花板', () => {
  const pick = (value) => normalizeConfig({ voice: { maxSeconds: value } }).voice.maxSeconds

  assert.equal(pick(60), 60)
  assert.equal(pick(120), 120)
  assert.equal(pick(360), 360)
  assert.equal(pick(9999), 360, '不得超过协议硬上限 360 秒')
  assert.equal(pick(0), 60, '0 吸附到最小档')
  assert.equal(pick('120'), 120, '字符串数字也要认')
  assert.equal(pick(undefined), 60, '缺省即默认 60 秒')
  assert.equal(pick('abc'), 60, '非数字退回默认，不抛错')
  // 空配置的默认值
  assert.equal(normalizeConfig({}).voice.maxSeconds, 60)
})

test('协议：设备请求余额会拿到数据并通过 reply 回给设备', async () => {
  const { runtime } = await setupRuntime()
  const replies = await invokeHandler(runtime, MSG.BALANCE_REQ, {})
  const balance = replies.find((message) => message.type === MSG.BALANCE)
  assert.ok(balance, '宿主应把余额回给设备')
  assert.equal(balance.totalBalance, 42.5)
  await teardown({ runtime })
})

test('★ 接线：链路握手完成时自动把录音上限下发给设备', async () => {
  // 设备端只保存内存态上限（不写 NVS），所以每次就绪都必须重发 ——
  // 这条测的是 link.on('ready') 上的接线，漏了它设备会一直用固件默认值。
  const { runtime } = await setupRuntime({}, { voice: { maxSeconds: 120 } })
  const configMsg = sentByHost(runtime).find((message) => message.type === MSG.CONFIG)
  assert.ok(configMsg, `应当下发 config 消息，实际发出：${sentByHost(runtime).map((m) => m.type).join(',')}`)
  assert.equal(configMsg.maxRecordSeconds, 120)
  await teardown({ runtime })
})

