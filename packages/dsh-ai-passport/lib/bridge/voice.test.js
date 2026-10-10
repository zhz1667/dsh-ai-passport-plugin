/**
 * 语音流式重组的单元测试。
 *
 * 为什么需要它：这是"设备一次录音分多条 BLE 消息上行"最容易出错的一环。
 * 旧实现按 4bit seq 去重，第 2 条消息的 seq 从 0 重来会被全部当重复丢掉 ——
 * 只剩第一条 ~0.26 秒音频，而且**不报错、只是识别出半句话**，极难察觉。
 * 改成按到达顺序拼接后，这里用"跨两条消息、seq 各自从 0 开始"的场景锁死行为。
 *
 * 独立于硬件/真机：只测 voice.js 的纯逻辑（重组 + ADPCM 解码 + WAV）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assembleWav, decodeImaAdpcm, decodeImaAdpcmDetailed, staleSessionMs, VoiceDomain } from './voice.js'
import { AUDIO, MSG } from '../protocol/constants.js'

const HEADER = 4

/** 构造一个语音分片：4 字节头（flags/msgId/seq）+ 载荷。 */
function chunk({ flags = 0, msgId = 1, seq = 0, payload }) {
  const head = Buffer.alloc(HEADER)
  head[0] = flags & 0x0f
  head[1] = 1 // channel，此处不参与重组
  head[2] = (msgId >> 4) & 0xff
  head[3] = ((msgId & 0x0f) << 4) | (seq & 0x0f)
  return Buffer.concat([head, payload])
}

/** 构造一段自洽的 ADPCM 字节流：块头(4B) + 若干数据字节。 */
function adpcmBytes(dataLen) {
  const buf = Buffer.alloc(4 + dataLen)
  buf.writeInt16LE(0, 0)      // predictor
  buf.writeUInt8(0, 2)        // stepIndex
  buf.writeUInt8(0, 3)        // 保留
  for (let i = 4; i < buf.length; i++) buf[i] = 0 // 数据（全 0，解出直流）
  return buf
}

function newSession() {
  return {
    parts: [],
    messages: 0,
    packets: 0,
    startedAt: Date.now(),
    format: { sampleRate: 16000, bits: 16, channels: 1, codec: 'ima-adpcm' },
  }
}

test('跨多条消息的音频按到达顺序拼接（seq 各自从 0 重来不丢）', () => {
  const session = newSession()
  const adpcm = adpcmBytes(16)
  const half = adpcm.length / 2

  // 模拟设备分两条 ap_link_send_voice 上行：
  //   消息 1: seq 0 (FIRST) + seq 1 (LAST)
  //   消息 2: seq 0 (FIRST) + seq 1 (LAST)   ← seq 重置，旧实现这里会全丢
  const msg1 = [
    { flags: 0b0001, seq: 0, payload: adpcm.subarray(0, half) },
    { flags: 0b0010, seq: 1, payload: adpcm.subarray(half) },
  ]
  const msg2 = [
    { flags: 0b0001, seq: 0, payload: adpcm.subarray(0, half) },
    { flags: 0b0010, seq: 1, payload: adpcm.subarray(half) },
  ]

  // 手工把分片载荷按到达顺序塞进 session.parts（等价 #onVoiceBytes 的追加）
  for (const c of [...msg1, ...msg2]) {
    const ch = chunk({ ...c, msgId: 1 })
    session.parts.push(ch.subarray(HEADER))
    if (c.flags & 0b0001) session.messages += 1
    session.packets += 1
  }

  assert.equal(session.messages, 2, '应收到 2 条消息的 FIRST')
  assert.equal(session.packets, 4, '应收到 4 个分片')

  const wav = assembleWav(session)
  assert.ok(wav, '拼接后应能产出 WAV')
  // 两条消息 = adpcm 两遍 → 压缩字节应为 adpcm.length * 2
  assert.equal(wav.compressedBytes, adpcm.length * 2, '压缩字节 = 两条消息之和')
  // 解码 PCM = (压缩字节 - 4 块头) * 4 采样字节，两条消息各解一遍
  assert.ok(wav.pcmBytes > 0, '应解出 PCM')
})

test('空会话 / 不足一个块头 → 返回 null（不拿残缺音频去猜）', () => {
  assert.equal(assembleWav({ parts: [] }), null, '无分片返回 null')

  const s = newSession()
  s.parts.push(Buffer.from([1, 2, 3])) // 只有 3 字节，不够 4 字节块头
  assert.equal(assembleWav(s), null, '不足块头返回 null')
})

test('ADPCM 解码：块头 + 数据 → 采样数正确', () => {
  const dataLen = 8
  const adpcm = adpcmBytes(dataLen)
  const pcm = decodeImaAdpcm(adpcm)
  // 每字节 2 个 4bit 采样 × 2 字节/采样 = 4 字节输出/数据字节
  assert.equal(pcm.length, dataLen * 4, 'PCM 字节数 = 数据字节 × 4')
})

/**
 * ★ 回归钉子（真机根因）：音频通道不重传，中途丢 N 字节会让"固定 508 步长"的块头
 * 定位永久错位 —— 数据字节被当块头解，PCM 变饱和噪声，识别返回空文本，
 * 症状就是"录音超过约 5 秒就识别不到内容"（实测在 4.95s 处丢了 160 字节）。
 * 这里用同一量级的丢字节手工构造现场，锁住"必须能重同步"。
 */
test('ADPCM 丢字节：中途少 160 字节也能重同步，不再整段报废', () => {
  const BLOCKS = 8
  const BLOCK = 508
  const stream = Buffer.alloc(BLOCKS * BLOCK)
  for (let b = 0; b < BLOCKS; b += 1) {
    const off = b * BLOCK
    stream.writeInt16LE(0, off) // predictor
    stream.writeUInt8(0, off + 2) // stepIndex
    stream.writeUInt8(0, off + 3) // 保留字节恒为 0
    for (let i = off + 4; i < off + BLOCK; i += 1) stream[i] = 0x11
  }

  // 从第 2 块的数据区中间挖掉 160 字节（真机实测的丢失量级）
  const cut = BLOCK + 200
  const damaged = Buffer.concat([stream.subarray(0, cut), stream.subarray(cut + 160)])

  // 先确认现场确实是错位的：第二块本该在 1016 处，现在那里不是合法块头
  assert.notEqual(damaged[1016 + 3], 0, '构造出的流在丢字节后应当已经错位')

  const { pcm, resyncs, skippedBytes } = decodeImaAdpcmDetailed(damaged)
  assert.equal(resyncs, 1, '应当恰好重同步一次')
  assert.ok(skippedBytes > 0 && skippedBytes <= BLOCK, `跳过的字节应在半块以内，实际 ${skippedBytes}`)

  // 旧实现从错位点之后就全是噪声，而且只会"解"出第一块；重同步后应解出大部分块
  const decodedBlocks = pcm.length / 4 / 504
  assert.ok(decodedBlocks > BLOCKS - 3, `应解出大部分块，实际 ${decodedBlocks.toFixed(2)} 块`)
})

test('干净的流不会被误判成需要重同步（need=3 的意义）', () => {
  const stream = Buffer.alloc(6 * 508)
  for (let b = 0; b < 6; b += 1) {
    const off = b * 508
    stream.writeUInt8(0, off + 2)
    stream.writeUInt8(0, off + 3)
  }
  const { resyncs, skippedBytes } = decodeImaAdpcmDetailed(stream)
  assert.equal(resyncs, 0, '干净流不应触发重同步')
  assert.equal(skippedBytes, 0, '干净流不应跳过任何字节')
})

/** 最小语音域外壳：只提供域真正用到的 link/config/logger 面。 */
function makeVoiceDomain(voiceConfig = {}) {
  const logs = []
  const sent = []
  const handlers = new Map()
  const link = {
    transport: { on: () => {}, off: () => {} },
    onMessage(type, handler) {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    async send(type, payload) {
      sent.push({ type, payload })
    },
    stats: { gaps: 0, bytesDropped: 0 },
  }
  const domain = new VoiceDomain({
    link,
    config: { voice: { maxSeconds: 60, ...voiceConfig } },
    logger: (_level, message) => logs.push(message),
    broadcast: () => {},
    domainState: { voiceLog: [] },
  })
  return { domain, handlers, logs, sent }
}

const startSession = (handlers, sessionId) =>
  handlers.get(MSG.VOICE_BEGIN)({
    type: MSG.VOICE_BEGIN, sessionId, sampleRate: 16000, bits: 16, channels: 1, codec: 'ima-adpcm',
  })

const endSession = (handlers, sessionId) =>
  handlers.get(MSG.VOICE_END)(
    { type: MSG.VOICE_END, sessionId, durationMs: 12_000, maxRms: 1234 },
    { msgId: 1, channel: 0, reply: async () => {} },
  )

test('★ 回归：孤儿会话阈值必须大于协议允许的最长录音', () => {
  // 旧实现写死 10 秒，而协议上限是 15 秒（AUDIO.MAX_SECONDS）——
  // 于是 10~15 秒的正常录音会被当成"陈旧会话"静默丢掉，设备端毫无提示。
  assert.ok(
    staleSessionMs() > AUDIO.MAX_SECONDS * 1000,
    `阈值 ${staleSessionMs()}ms 必须大于协议上限 ${AUDIO.MAX_SECONDS * 1000}ms`,
  )
})

test('★ 回归：12 秒的录音不会被当成陈旧会话丢掉', async () => {
  const { domain, handlers, logs } = makeVoiceDomain()
  await startSession(handlers, 5)

  const session = domain.sessions.get(5)[0]
  session.parts.push(adpcmBytes(8)) // 够一个块头，能走到组装那一步
  session.startedAt = Date.now() - 12_000 // 12 秒前开始：旧实现（10 秒阈值）会在这里判孤儿

  await endSession(handlers, 5)

  assert.ok(!logs.some((m) => m.includes('丢弃陈旧会话')), '12 秒的录音不该被判为陈旧会话')
  // 走到"时长判定"说明会话真的被取出来了（片段只有 1ms，按误碰丢弃）
  assert.ok(
    logs.some((m) => m.includes('录音过短')),
    `应当取到会话并走到时长判定，实际日志：${logs.join(' | ')}`,
  )
})

test('真正的孤儿会话仍会被清理（阈值没有被放宽到失效）', async () => {
  const { domain, handlers, logs } = makeVoiceDomain({ maxSeconds: 60 })
  await startSession(handlers, 6)
  // 远超"配置上限 + 余量"：确实等不到 voice.end 的残留（阈值本身由 staleSessionMs 推导）
  domain.sessions.get(6)[0].startedAt = Date.now() - (staleSessionMs(60) + 5_000)

  await endSession(handlers, 6)

  assert.ok(logs.some((m) => m.includes('丢弃陈旧会话')), '超过阈值的残留会话应当被清掉')
})

test('★ 录音上限通过 config 消息下发给设备（字段名与固件 handle_config 对齐）', async () => {
  const { domain, sent } = makeVoiceDomain({ maxSeconds: 120 })
  const seconds = await domain.pushConfig()
  assert.equal(seconds, 120)

  const message = sent.find((m) => m.type === MSG.CONFIG)
  assert.ok(message, '应当下发 config 消息')
  assert.equal(message.payload.maxRecordSeconds, 120)
})

test('录音上限缺省/非法时回退到协议上限，绝不下发 0', async () => {
  for (const bad of [0, undefined, null, 'abc']) {
    const { domain, sent } = makeVoiceDomain({ maxSeconds: bad })
    const seconds = await domain.pushConfig()
    assert.equal(seconds, AUDIO.MAX_SECONDS, `maxSeconds=${String(bad)} 应当回退到协议上限`)
    assert.equal(sent.find((m) => m.type === MSG.CONFIG).payload.maxRecordSeconds, AUDIO.MAX_SECONDS)
  }
})

test('孤儿阈值跟随配置的录音上限（120s 配置 → 阈值 125s）', () => {
  assert.equal(staleSessionMs(120), 125_000)
  assert.equal(staleSessionMs(360), 365_000)
})
