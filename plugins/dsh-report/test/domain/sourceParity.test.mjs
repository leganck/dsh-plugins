/**
 * sourceParity.test.mjs —— 与 workbench Go 源码的**逐字节**等价断言。
 *
 * 为什么放在插件测试里：模板 / guidance / HOST_INSTRUCTIONS / 分页 hint 是逐字节契
 * （07 分册 §6.4），手抄极易错。本测试直接解析 Go 源码里的字符串字面量并对比，
 * 让「迁移是否跑偏」在 CI 即暴露。
 *
 * 跳过条件：插件被移出 workbench 仓库（找不到 `../../internal/report/templates.go`）时 skip，
 * 这样插件可以独立发布而不红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_GUIDANCE,
  DEFAULT_TEMPLATES,
  GUIDANCE_COMMON,
} from '../../lib/domain/briefDefaults.js'
import { HOST_INSTRUCTIONS } from '../../lib/domain/brief.js'
import { GATHER_HINT_COMPLETE, GATHER_HINT_MORE } from '../../lib/domain/gather.js'
import { goSourceAvailable, readGoDomainStrings } from './goSource.mjs'

const SKIP_REASON = goSourceAvailable()
  ? false
  : '未找到 workbench Go 源码（插件被移出仓库），跳过源级 parity'

test('默认模板与 guidance 与 Go report 侧逐字节一致', { skip: SKIP_REASON }, () => {
  const go = readGoDomainStrings()
  for (const key of ['week', 'month', 'quarter', 'year']) {
    assert.equal(DEFAULT_TEMPLATES[key], go.templates[key], `template ${key} 与 templates.go 不一致`)
    assert.equal(DEFAULT_GUIDANCE[key], go.guidance[key], `guidance ${key} 与 templates.go 不一致`)
  }
})

test('Go 的两份默认文案（report vs settings）本身逐字节相等', { skip: SKIP_REASON }, () => {
  const go = readGoDomainStrings()
  for (const key of ['week', 'month', 'quarter', 'year']) {
    assert.equal(go.templates[key], go.settingsTemplates[key], `template ${key} 两份不一致`)
    assert.equal(go.guidance[key], go.settingsGuidance[key], `guidance ${key} 两份不一致`)
  }
})

test('GUIDANCE_COMMON 等于 Go reportGuidanceCommon', { skip: SKIP_REASON }, () => {
  const go = readGoDomainStrings()
  const suffix = '周报主题建议 3–6 个。'
  assert.equal(go.guidance.week.endsWith(suffix), true, '周报 guidance 结构变化，需同步本测试')
  const expected = go.guidance.week.slice(0, go.guidance.week.length - suffix.length)
  assert.equal(GUIDANCE_COMMON, expected)
})

test('HOST_INSTRUCTIONS 与 Go persist.go 常量逐字节一致', { skip: SKIP_REASON }, () => {
  const go = readGoDomainStrings()
  assert.equal(HOST_INSTRUCTIONS, go.hostInstructions)
})

test('分页 hint 与 Go gather.go 逐字节一致', { skip: SKIP_REASON }, () => {
  const go = readGoDomainStrings()
  assert.equal(GATHER_HINT_MORE, go.gatherHints.more)
  assert.equal(GATHER_HINT_COMPLETE, go.gatherHints.complete)
})

test('默认模板里保留占位符原样（替换只发生在 brief 拼装时）', { skip: SKIP_REASON }, () => {
  const go = readGoDomainStrings()
  for (const key of ['week', 'month', 'quarter', 'year']) {
    assert.equal(go.templates[key].includes('YYYY-MM-DD 至 YYYY-MM-DD'), true, `${key} 模板缺占位符`)
    assert.equal(DEFAULT_TEMPLATES[key].includes('YYYY-MM-DD 至 YYYY-MM-DD'), true)
  }
})
