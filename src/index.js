'use strict'

// @sxedward/koishi-plugin-waifu-draw
// Koishi v4 抽老婆插件：抽取名字 / 整数情缘 / 照片，个人统计，控制台面板与管理员命令维护名单。

const fs = require('node:fs/promises')
const path = require('node:path')
const { h, Logger, Schema } = require('koishi')

const name = 'waifu-draw'
const logger = new Logger(name)

const DATA_DIR = path.join('data', name)
const PHOTO_DIR = path.join(DATA_DIR, 'photos')
const USERS_FILE = 'users.json'
const WIVES_FILE = 'wives.json'
const TOP_COUNT = 7
const MAX_PHOTO_SIZE = 12 * 1024 * 1024

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

const Config = Schema.object({
  admins: Schema.array(Schema.string().description('管理员用户 ID，可填 123456 或 onebot:123456。面板中也可直接增减。'))
    .default([])
    .description('管理员名单。列表中的用户可在聊天中使用老婆添加 / 老婆删除命令，并可查看老婆名单；也兼容 Koishi 权限等级 4 及以上的用户。'),

  waifus: Schema.array(Schema.object({
    name: Schema.string().required().description('老婆名字，例如：小红。名字不要重复。'),
    photo: Schema.string().required().description('照片文件名，例如：小红.jpg。推荐与名字一致并放在下方照片目录中；也支持相对应用目录的路径或 http(s) 图片 URL。'),
  }).role('table'))
    .default([])
    .description('老婆名单（面板方式维护）。增加一行即新增一位可抽取老婆，删除一行即从抽取池中移除。聊天命令增改的结果保存在 wives.json；如果这里的内容发生变化，重载时会以这里的名单为准。'),

  photoDir: Schema.string()
    .default(PHOTO_DIR)
    .description('照片存放目录（相对 Koishi 应用目录），默认 data/waifu-draw/photos。命名规则：推荐“老婆名字.jpg/png/webp/gif”，与名单中的“照片”字段一致；支持 jpg、jpeg、png、webp、gif、bmp。命令附带图片时会自动按“老婆名字.扩展名”保存到此目录。'),

  cooldown: Schema.natural()
    .min(0)
    .max(86400)
    .default(10)
    .description('抽老婆冷却时间（秒），按用户计算。0 表示不限制。'),

  dailyLimit: Schema.natural()
    .min(0)
    .max(100000)
    .default(20)
    .description('每位用户每天最多抽取次数（按自然日 00:00 重置）。0 表示不限制。'),

  sendPhoto: Schema.boolean()
    .default(true)
    .description('抽中时是否一并发送照片。关闭后只发送名字与情缘。'),
})

function normalizeConfig(config = {}) {
  const waifus = Array.isArray(config.waifus) ? config.waifus : []
  return {
    admins: (Array.isArray(config.admins) ? config.admins : []).map((id) => String(id).trim()).filter(Boolean),
    waifus: normalizeWives(waifus),
    photoDir: String(config.photoDir || PHOTO_DIR),
    cooldown: Number.isFinite(config.cooldown) ? Math.max(0, config.cooldown) : 10,
    dailyLimit: Number.isFinite(config.dailyLimit) ? Math.max(0, config.dailyLimit) : 20,
    sendPhoto: config.sendPhoto !== false,
  }
}

function normalizeWives(list) {
  const seen = new Set()
  const result = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const wifeName = String(item.name || '').trim()
    if (!wifeName || seen.has(wifeName)) continue
    seen.add(wifeName)
    result.push({ name: wifeName, photo: String(item.photo || '').trim() })
  }
  return result
}

function wifeSignature(list) {
  return JSON.stringify(normalizeWives(list))
}

function emptyRecord() {
  return { wives: {}, total: 0, lastDraw: 0, day: '', dayCount: 0 }
}

function sanitizeRecord(input) {
  const record = emptyRecord()
  if (!input || typeof input !== 'object') return record
  if (input.wives && typeof input.wives === 'object' && !Array.isArray(input.wives)) {
    for (const [wifeName, value] of Object.entries(input.wives)) {
      if (!value || typeof value !== 'object') continue
      const count = Math.floor(Number(value.count) || 0)
      const rawBond = value.bond !== undefined ? value.bond : value.intimacy
      const bond = Math.floor(Number(rawBond) || 0)
      if (count <= 0) continue
      record.wives[wifeName] = { count, bond: Math.max(0, bond) }
    }
  }
  record.total = Math.max(0, Math.floor(Number(input.total) || 0))
  record.lastDraw = Math.max(0, Number(input.lastDraw) || 0)
  record.day = typeof input.day === 'string' ? input.day : ''
  record.dayCount = Math.max(0, Math.floor(Number(input.dayCount) || 0))
  return record
}

// 统计与抽取记录只按「平台:用户」区分，刻意不含 guildId / channelId，
// 因此同一用户跨任意群的抽取都会汇入同一份记录（单人全局汇总，不分群）。
function userKey(session) {
  const platform = String(session.platform || 'unknown')
  const userId = String(session.userId || 'unknown')
  return `${platform}:${userId}`
}

function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isAdmin(config, session) {
  if (session.user && Number(session.user.authority) >= 4) return true
  const userId = String(session.userId || '')
  const fullId = `${session.platform || ''}:${userId}`
  return config.admins.includes(userId) || config.admins.includes(fullId)
}

function topBy(record, primary, allowed) {
  const secondary = primary === 'bond' ? 'count' : 'bond'
  return Object.entries(record.wives)
    .filter(([wifeName, value]) => value.count > 0 && (!allowed || allowed.has(wifeName)))
    .sort((a, b) => (
      b[1][primary] - a[1][primary]
      || b[1][secondary] - a[1][secondary]
      || a[0].localeCompare(b[0], 'zh-CN')
    ))
    .slice(0, TOP_COUNT)
}

function safeFileName(value) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60)
  return cleaned || 'waifu'
}

module.exports.name = name
module.exports.Config = Config
module.exports.usage = '发送“抽老婆”抽取老婆、情缘与照片（首次抽到会提示），发送“老婆统计”查看单人全局汇总（不分群）；管理员可用“老婆添加 / 老婆删除”维护名单。'

module.exports.apply = async (ctx, rawConfig) => {
  const config = normalizeConfig(rawConfig)
  const dataDir = path.resolve(ctx.baseDir, DATA_DIR)
  const usersFile = path.join(dataDir, USERS_FILE)
  const wivesFile = path.join(dataDir, WIVES_FILE)
  const photoDir = path.isAbsolute(config.photoDir)
    ? path.resolve(config.photoDir)
    : path.resolve(ctx.baseDir, config.photoDir)

  let records = {}
  let wives = []
  let wivesSignature = ''
  let saveTimer = null
  let saveChain = Promise.resolve()

  async function writeJson(file, value) {
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(temporary, file)
  }

  function persistUsers() {
    saveChain = saveChain
      .then(() => writeJson(usersFile, records))
      .catch((error) => logger.warn(`保存用户数据失败：${error.message}`))
    return saveChain
  }

  function persistWives() {
    saveChain = saveChain
      .then(() => writeJson(wivesFile, { signature: wivesSignature, wives }))
      .catch((error) => logger.warn(`保存老婆名单失败：${error.message}`))
    return saveChain
  }

  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persistUsers()
    }, 300)
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(await fs.readFile(usersFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const result = {}
        for (const [key, value] of Object.entries(parsed)) result[key] = sanitizeRecord(value)
        records = result
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`读取用户数据失败，将使用空数据：${error.message}`)
    }

    wivesSignature = wifeSignature(config.waifus)
    try {
      const parsed = JSON.parse(await fs.readFile(wivesFile, 'utf8'))
      if (parsed && Array.isArray(parsed.wives) && parsed.signature === wivesSignature) {
        wives = normalizeWives(parsed.wives)
        return
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`读取老婆名单失败，将使用面板名单：${error.message}`)
    }
    wives = normalizeWives(config.waifus)
    await persistWives()
  }

  function resolveLocalPhoto(photo) {
    const value = String(photo || '').trim()
    if (!value) return null
    if (!path.isAbsolute(value) && !value.includes('/') && !value.includes('\\')) {
      return path.resolve(photoDir, value)
    }
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ctx.baseDir, value)
  }

  async function buildPhotoElement(photo) {
    if (!config.sendPhoto) return null
    const value = String(photo || '').trim()
    if (!value) return null
    if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return h.image(value)

    const file = resolveLocalPhoto(value)
    if (!file) return null
    try {
      const buffer = await fs.readFile(file)
      if (!buffer.length) throw new Error('文件为空')
      if (buffer.length > MAX_PHOTO_SIZE) throw new Error('图片超过 12 MB')
      const mime = MIME_TYPES[path.extname(file).toLowerCase()] || 'image/jpeg'
      return h.image(buffer, mime)
    } catch (error) {
      logger.warn(`读取老婆照片失败（${file}）：${error.message}`)
      return h.text(`（照片读取失败：${path.basename(file)}，请检查面板中的照片文件名）`)
    }
  }

  async function fileExists(file) {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }

  async function uniquePhotoPath(baseName, extension) {
    let candidate = path.join(photoDir, `${baseName}${extension}`)
    let index = 2
    while (await fileExists(candidate)) {
      candidate = path.join(photoDir, `${baseName}-${index}${extension}`)
      index += 1
    }
    return candidate
  }

  async function saveAttachedPhoto(element, wifeName) {
    const attrs = element?.attrs || {}
    const source = String(attrs.url || attrs.src || '').trim()
    if (!source) throw new Error('消息中没有可用的图片链接')

    let buffer
    let mime = ''
    const dataMatch = source.match(/^data:image\/([^;,]+);base64,([\s\S]+)$/i)
    if (dataMatch) {
      mime = `image/${dataMatch[1].toLowerCase()}`
      buffer = Buffer.from(dataMatch[2], 'base64')
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoishiWaifuDraw/1.0)' },
      })
      if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
      mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase()
      buffer = Buffer.from(await response.arrayBuffer())
    } else {
      throw new Error('不支持的图片来源，请附带图片或填写文件名 / http(s) 链接')
    }

    if (!buffer.length) throw new Error('图片内容为空')
    if (buffer.length > MAX_PHOTO_SIZE) throw new Error('图片超过 12 MB')
    const extension = EXTENSIONS[mime] || path.extname(source.split(';')[0]).toLowerCase() || '.jpg'
    const file = await uniquePhotoPath(safeFileName(wifeName), extension)
    await fs.writeFile(file, buffer)
    return path.basename(file)
  }

  async function tryDeletePhoto(photo) {
    const value = String(photo || '').trim()
    if (!value) return ''
    if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return '（照片是链接，未删除文件）'

    const file = resolveLocalPhoto(value)
    if (!file) return ''
    const relative = path.relative(photoDir, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return '（照片不在插件照片目录内，未删除文件）'
    try {
      await fs.unlink(file)
      return '，并已删除对应照片文件'
    } catch (error) {
      return `（照片文件删除失败：${error.message}）`
    }
  }

  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(photoDir, { recursive: true })
  await loadState()

  ctx.on('dispose', async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      await persistUsers()
    }
    await saveChain
  })

  ctx.command('抽老婆', '抽取一位老婆，显示名字、情缘和照片')
    .alias('waifu.draw')
    .action(async ({ session }) => {
      const key = userKey(session)
      const record = records[key] || (records[key] = emptyRecord())
      const now = Date.now()
      const today = dayKey(now)

      if (record.day !== today) {
        record.day = today
        record.dayCount = 0
        scheduleSave()
      }

      if (config.cooldown > 0 && record.lastDraw > 0) {
        const remaining = Math.ceil((config.cooldown * 1000 - (now - record.lastDraw)) / 1000)
        if (remaining > 0) return `抽老婆冷却中，还需等待 ${remaining} 秒。`
      }

      if (config.dailyLimit > 0 && record.dayCount >= config.dailyLimit) {
        return `今天的 ${config.dailyLimit} 次抽取机会已用完，明天 00:00 后再来吧。`
      }

      if (!wives.length) return '管理员还没有添加老婆，请让管理员在插件面板或使用“老婆添加”命令添加。'

      const wife = wives[Math.floor(Math.random() * wives.length)]
      const bond = 1 + Math.floor(Math.random() * 100)
      const isFirst = !record.wives[wife.name] || record.wives[wife.name].count <= 0
      const own = record.wives[wife.name] || (record.wives[wife.name] = { count: 0, bond: 0 })
      own.count += 1
      own.bond += bond
      record.total += 1
      record.lastDraw = now
      record.dayCount += 1
      scheduleSave()

      const text = [
        `抽到了：${wife.name}`,
        `情缘：${bond}%（本次，1%~100% 整数）`,
        `累计情缘：${own.bond}%　累计次数：${own.count} 次`,
        ...(isFirst ? [`★ 首次抽到「${wife.name}」！`] : []),
      ].join('\n')

      const elements = [h.text(text)]
      if (wife.photo) {
        const photoElement = await buildPhotoElement(wife.photo)
        if (photoElement) elements.push(photoElement)
      }
      return elements
    })

  ctx.command('老婆统计', '查询我的老婆数量、占比以及情缘 / 次数前 7 名（单人全局汇总，不分群）')
    .alias('waifu.stats')
    .alias('我的老婆')
    .action(({ session }) => {
      // 单人全局汇总：只看当前用户自己的记录，且该记录跨所有群合并（键不含群 ID）。
      const record = records[userKey(session)] || emptyRecord()
      const allowed = new Set(wives.map((wife) => wife.name))
      const owned = Object.entries(record.wives)
        .filter(([wifeName, value]) => value.count > 0 && allowed.has(wifeName))
        .length
      const percent = wives.length > 0 ? (owned / wives.length * 100).toFixed(2) : '0.00'

      const lines = [
        '【老婆统计】（单人全局汇总，不分群）',
        `老婆数量：${owned} / ${wives.length}`,
        `已有占比：${percent}%（小数保留两位）`,
        `累计抽取：${record.total} 次`,
      ]

      const byBond = topBy(record, 'bond', allowed)
      lines.push('', '累计情缘 TOP7：')
      if (byBond.length) {
        byBond.forEach(([wifeName, value], index) => {
          lines.push(`${index + 1}. ${wifeName}　${value.bond}%`)
        })
      } else {
        lines.push('暂无记录，快去抽老婆吧。')
      }

      const byCount = topBy(record, 'count', allowed)
      lines.push('', '累计次数 TOP7：')
      if (byCount.length) {
        byCount.forEach(([wifeName, value], index) => {
          lines.push(`${index + 1}. ${wifeName}　${value.count} 次`)
        })
      } else {
        lines.push('暂无记录，快去抽老婆吧。')
      }

      return lines.join('\n')
    })

  ctx.command('老婆名单', '查看当前可抽取的老婆名单（仅管理员）', { authority: 1 })
    .alias('waifu.list')
    .action(({ session }) => {
      if (!isAdmin(config, session)) return '只有插件面板中设置的管理员可以查看老婆名单。'
      if (!wives.length) return '当前老婆名单为空，请在插件面板或使用“老婆添加”命令添加。'
      return [
        `当前老婆名单（共 ${wives.length} 位）：`,
        ...wives.map((wife, index) => `${index + 1}. ${wife.name}　照片：${wife.photo || '（未设置）'}`),
        '',
        `照片目录：${photoDir}`,
      ].join('\n')
    })

  ctx.command('老婆添加 <name> [photo]', '管理员添加老婆及照片（可直接在消息中附带图片）')
    .alias('waifu.add')
    .action(async ({ session }, nameValue, photoValue) => {
      if (!isAdmin(config, session)) return '只有插件面板中设置的管理员可以添加老婆。'
      const wifeName = String(nameValue || '').trim()
      if (!wifeName) return '请提供老婆名字，例如：老婆添加 小红 小红.jpg'
      if (wives.some((wife) => wife.name === wifeName)) return `“${wifeName}”已经在名单中了。`

      let photo = String(photoValue || '').trim()
      if (!photo) {
        const elements = Array.isArray(session.elements) ? session.elements : []
        const image = elements.find((element) => element && (element.type === 'image' || element.type === 'img'))
        if (!image) return '请提供照片文件名 / http(s) 图片链接，或在消息中附带一张图片。'
        try {
          photo = await saveAttachedPhoto(image, wifeName)
        } catch (error) {
          return `保存图片失败：${error.message}`
        }
      }

      wives.push({ name: wifeName, photo })
      await persistWives()
      return `已添加老婆“${wifeName}”，照片：${photo}\n当前共 ${wives.length} 位。`
    })

  ctx.command('老婆删除 <name>', '管理员删除老婆及对应照片')
    .alias('waifu.remove')
    .option('keep', '-k 保留照片文件，只从名单中移除')
    .action(async ({ session, options }, nameValue) => {
      if (!isAdmin(config, session)) return '只有插件面板中设置的管理员可以删除老婆。'
      const wifeName = String(nameValue || '').trim()
      const index = wives.findIndex((wife) => wife.name === wifeName)
      if (index < 0) return `名单中没有“${wifeName}”。`

      const [removed] = wives.splice(index, 1)
      await persistWives()
      const photoNote = options?.keep ? '（已保留照片文件）' : await tryDeletePhoto(removed.photo)
      return `已删除老婆“${wifeName}”${photoNote}\n当前共 ${wives.length} 位。`
    })

  logger.info(`已加载，照片目录：${photoDir}，老婆数量：${wives.length}`)
}
