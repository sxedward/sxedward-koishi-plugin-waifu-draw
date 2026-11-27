'use strict'

// 不依赖真实 Koishi 的冒烟测试：用最小 mock 模拟 Koishi 的 Schema / Logger / h / Context。
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

class MockSchema {
  constructor(type, value) {
    this.type = type
    this.value = value
  }

  static string() { return new MockSchema('string') }
  static number() { return new MockSchema('number') }
  static natural() { return new MockSchema('number') }
  static boolean() { return new MockSchema('boolean') }
  static object(value = {}) { return new MockSchema('object', value) }
  static array(value) { return new MockSchema('array', value) }

  default(value) { this.defaultValue = value; return this }
  description(value) { this.descriptionValue = value; return this }
  required() { this.requiredValue = true; return this }
  role(value) { this.roleValue = value; return this }
  min() { return this }
  max() { return this }
}

const mockKoishi = {
  Schema: MockSchema,
  Logger: class Logger {
    info() {}
    warn(message) { this.lastWarning = message }
  },
  h: {
    text: (content) => ({ type: 'text', attrs: { content } }),
    image: (src, mime) => ({ type: 'image', attrs: { url: src, mime } }),
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'koishi') return mockKoishi
  return originalLoad.call(this, request, parent, isMain)
}
const plugin = require('../src/index.js')
Module._load = originalLoad

function createContext(baseDir) {
  const commands = new Map()
  const dispose = []
  const context = {
    baseDir,
    command(definition, description, options) {
      const commandName = definition.split(/\s+/)[0]
      const command = {
        definition,
        description,
        options,
        aliases: [],
        optionsList: [],
        handler: null,
        alias(...names) { this.aliases.push(...names); return this },
        option(name, description) { this.optionsList.push({ name, description }); return this },
        action(handler) { this.handler = handler; return this },
      }
      commands.set(commandName, command)
      return command
    },
    on(event, handler) {
      if (event === 'dispose') dispose.push(handler)
    },
  }
  return { context, commands, dispose }
}

function session(userId = '10001', platform = 'onebot', authority = 1) {
  return { userId, platform, user: { authority } }
}

function textOf(result) {
  const items = Array.isArray(result) ? result : [result]
  return items.map((item) => (typeof item === 'string' ? item : item.attrs?.content || '')).join('\n')
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const baseConfig = {
  admins: ['10001'],
  waifus: [
    { name: '小红', photo: '小红.jpg' },
    { name: '小美', photo: '小美.png' },
  ],
  photoDir: 'data/waifu-draw/photos',
  cooldown: 0,
  dailyLimit: 0,
  sendPhoto: true,
}

async function prepare(baseDir, config = baseConfig) {
  await fs.mkdir(path.join(baseDir, 'data', 'waifu-draw', 'photos'), { recursive: true })
  await fs.writeFile(path.join(baseDir, 'data', 'waifu-draw', 'photos', '小红.jpg'), Buffer.from('fake-jpeg'))
  await fs.writeFile(path.join(baseDir, 'data', 'waifu-draw', 'photos', '小美.png'), Buffer.from('fake-png'))
  const { context, commands, dispose } = createContext(baseDir)
  await plugin.apply(context, config)
  return { commands, dispose }
}

async function run() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-test-'))
  try {
    const { commands, dispose } = await prepare(baseDir)
    assert.deepEqual([...commands.keys()], ['抽老婆', '老婆统计', '老婆名单', '老婆添加', '老婆删除'])

    const draw = commands.get('抽老婆').handler
    const stats = commands.get('老婆统计').handler
    const list = commands.get('老婆名单').handler

    // 抽 40 次，两种老婆都覆盖到；检查情缘格式和照片元素。
    const seen = new Set()
    for (let index = 0; index < 40; index += 1) {
      const result = await draw({ session: session() })
      assert.ok(Array.isArray(result), '抽老婆应返回消息元素数组')
      assert.match(textOf(result), /抽到了：(小红|小美)/)
      const match = textOf(result).match(/情缘：(\d+)%（本次，1%~100% 整数）/)
      assert.ok(match, '应显示整数情缘')
      assert.ok(Number(match[1]) >= 1 && Number(match[1]) <= 100, '情缘必须在 1~100 之间')
      assert.equal(result.filter((item) => item.type === 'image').length, 1, '应附带一张照片')
      seen.add(textOf(result).match(/抽到了：(.+)/)[1])
    }
    assert.equal(seen.size, 2, '随机抽取应覆盖两位老婆')

    // 统计：数量、两位小数占比、两个 TOP7 排行。
    const statsText = textOf(stats({ session: session() }))
    assert.match(statsText, /老婆数量：2 \/ 2/)
    assert.match(statsText, /已有占比：100\.00%/)
    assert.match(statsText, /累计情缘 TOP7：/)
    assert.match(statsText, /累计次数 TOP7：/)
    assert.match(statsText, /小红　\d+%/)
    assert.match(statsText, /小美　\d+ 次/)
    assert.match(statsText, /单人全局汇总，不分群/)

    // 首次抽到提示：只用一位老婆，第一次必提示、第二次不再提示。
    const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-first-'))
    const firstConfig = { ...baseConfig, waifus: [{ name: '唯一', photo: '小红.jpg' }] }
    const first = await prepare(firstDir, firstConfig)
    const firstDraw = first.commands.get('抽老婆').handler
    const firstResult = textOf(await firstDraw({ session: session() }))
    assert.match(firstResult, /★ 首次抽到「唯一」！/, '首次抽到应给出提示')
    const secondResult = textOf(await firstDraw({ session: session() }))
    assert.doesNotMatch(secondResult, /首次抽到/, '重复抽到同一老婆不应再提示')
    // 另一用户首次抽到仍应提示（提示按用户自己计算）。
    assert.match(textOf(await firstDraw({ session: session('20002', 'onebot', 1) })), /★ 首次抽到「唯一」！/)

    // 跨群汇总：同一用户在不同群抽，统计应合并为一份（不分群）。
    const crossDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-cross-'))
    const cross = await prepare(crossDir, firstConfig)
    const crossDraw = cross.commands.get('抽老婆').handler
    const groupA = { ...session(), guildId: 'group-a' }
    const groupB = { ...session(), guildId: 'group-b' }
    await crossDraw({ session: groupA })
    await crossDraw({ session: groupB })
    const crossStats = textOf(cross.commands.get('老婆统计').handler({ session: session() }))
    assert.match(crossStats, /累计抽取：2 次/, '不同群的抽取应合并到同一用户统计')

    // 权限：管理员可看名单，普通用户不可看。
    assert.match(textOf(list({ session: session() })), /当前老婆名单（共 2 位）/)
    const denied = textOf(list({ session: session('99999', 'onebot', 1) }))
    assert.match(denied, /只有插件面板中设置的管理员/)
    assert.match(textOf(list({ session: session('99999', 'onebot', 4) })), /照片目录：/)

    // 持久化：卸载后重新加载，统计保留。
    await Promise.all(dispose.map((handler) => handler()))
    const reloaded = await prepare(baseDir)
    const reloadedStats = textOf(reloaded.commands.get('老婆统计').handler({ session: session() }))
    assert.match(reloadedStats, /累计抽取：40 次/)

    // CD 限制。
    const cdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-cd-'))
    const cdConfig = { ...baseConfig, cooldown: 3600, dailyLimit: 0 }
    const cd = await prepare(cdDir, cdConfig)
    await cd.commands.get('抽老婆').handler({ session: session() })
    const cdBlocked = textOf(await cd.commands.get('抽老婆').handler({ session: session() }))
    assert.match(cdBlocked, /冷却中，还需等待 \d+ 秒/)

    // 每日次数限制。
    const limitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-limit-'))
    const limitConfig = { ...baseConfig, cooldown: 0, dailyLimit: 2 }
    const limit = await prepare(limitDir, limitConfig)
    const limitDraw = limit.commands.get('抽老婆').handler
    await limitDraw({ session: session() })
    await limitDraw({ session: session() })
    const limitBlocked = textOf(await limitDraw({ session: session() }))
    assert.match(limitBlocked, /今天的 2 次抽取机会已用完/)

    // 照片缺失时仍显示文字并给出提示。
    const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-missing-'))
    const missingConfig = {
      ...baseConfig,
      waifus: [{ name: '小透明', photo: '不存在.jpg' }],
      cooldown: 0,
      dailyLimit: 0,
    }
    const missing = await prepare(missingDir, missingConfig)
    const missingResult = textOf(await missing.commands.get('抽老婆').handler({ session: session() }))
    assert.match(missingResult, /抽到了：小透明/)
    assert.match(missingResult, /照片读取失败：不存在\.jpg/)

    // 管理员命令：按文件名添加、权限校验、重复名字、附带图片自动保存、持久化。
    const manageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-manage-'))
    const manage = await prepare(manageDir)
    const manageList = manage.commands.get('老婆名单').handler
    const add = manage.commands.get('老婆添加').handler
    const remove = manage.commands.get('老婆删除').handler
    const photoDir = path.join(manageDir, 'data', 'waifu-draw', 'photos')

    assert.match(textOf(await add({ session: session(), options: {} }, '小丽', '小丽.jpg')), /已添加老婆“小丽”，照片：小丽\.jpg/)
    await fs.writeFile(path.join(photoDir, '小丽.jpg'), Buffer.from('fake-jpeg'))
    assert.match(textOf(manageList({ session: session() })), /当前老婆名单（共 3 位）/)
    assert.match(textOf(await add({ session: session('99999', 'onebot', 1), options: {} }, '无权', 'x.jpg')), /只有插件面板中设置的管理员/)
    assert.match(textOf(await add({ session: session(), options: {} }, '小丽', 'x.jpg')), /已经在名单中/)

    const imageSession = session()
    const base64 = Buffer.from('fake-png-bytes').toString('base64')
    imageSession.elements = [{ type: 'image', attrs: { url: `data:image/png;base64,${base64}` } }]
    assert.match(
      textOf(await add({ session: imageSession, options: {} }, '小云')),
      /已添加老婆“小云”，照片：小云\.png/,
    )
    assert.ok(await exists(path.join(photoDir, '小云.png')), '附带的图片应自动保存到照片目录')

    await Promise.all(manage.dispose.map((handler) => handler()))
    const manageReloaded = await prepare(manageDir)
    const reloadedList = manageReloaded.commands.get('老婆名单').handler
    assert.match(textOf(reloadedList({ session: session() })), /小云\.png/, '命令添加的名单应跨重启保留')

    assert.match(
      textOf(await manageReloaded.commands.get('老婆删除').handler({ session: session(), options: { keep: true } }, '小云')),
      /已保留照片文件/,
    )
    assert.ok(await exists(path.join(photoDir, '小云.png')), '-k 应保留照片文件')
    assert.match(
      textOf(await manageReloaded.commands.get('老婆删除').handler({ session: session(), options: {} }, '小丽')),
      /已删除对应照片文件/,
    )
    assert.ok(!(await exists(path.join(photoDir, '小丽.jpg'))), '默认删除应移除照片文件')
    assert.match(textOf(reloadedList({ session: session() })), /当前老婆名单（共 2 位）/)

    const overridden = await prepare(manageDir, {
      ...baseConfig,
      waifus: [{ name: '面板老婆', photo: '小红.jpg' }],
    })
    assert.match(
      textOf(overridden.commands.get('老婆名单').handler({ session: session() })),
      /当前老婆名单（共 1 位）：\n1\. 面板老婆/,
      '面板名单变化后应覆盖命令维护的名单',
    )

    // 空名单不应崩溃。
    const empty = createContext(await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-draw-empty-')))
    await plugin.apply(empty.context, { ...baseConfig, waifus: [] })
    assert.match(textOf(await empty.commands.get('抽老婆').handler({ session: session() })), /还没有添加老婆/)
    assert.match(textOf(empty.commands.get('老婆统计').handler({ session: session() })), /已有占比：0\.00%/)

    // 先让仍有延迟落盘定时器的上下文完成写入，再删临时目录（避免 Windows 上 rmdir 竞态）。
    for (const handle of [cd, limit, missing, first, cross]) {
      await Promise.all(handle.dispose.map((handler) => handler()))
    }
    for (const dir of [cdDir, limitDir, missingDir, manageDir, firstDir, crossDir]) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    console.log('smoke tests passed: draw / stats / admin / persistence / cooldown / daily limit / missing photo / manage commands / panel override / empty list / first-draw hint / cross-group')
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
