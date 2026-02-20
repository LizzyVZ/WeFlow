import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { ContactCacheService } from './contactCacheService'
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { basename, join } from 'path'
import crypto from 'crypto'
import { WasmService } from './wasmService'

export interface SnsLivePhoto {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
}

export interface SnsMedia {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
    livePhoto?: SnsLivePhoto
}

export interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: SnsMedia[]
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[]
    rawXml?: string
    linkTitle?: string
    linkUrl?: string
}



const fixSnsUrl = (url: string, token?: string, isVideo: boolean = false) => {
    if (!url) return url

    let fixedUrl = url.replace('http://', 'https://')

    // 只有非视频（即图片）才需要处理 /150 变 /0
    if (!isVideo) {
        fixedUrl = fixedUrl.replace(/\/150($|\?)/, '/0$1')
    }

    if (!token || fixedUrl.includes('token=')) return fixedUrl

    // 根据用户要求，视频链接组合方式为: BASE_URL + "?" + "token=" + token + "&idx=1" + 原有参数
    if (isVideo) {
        const urlParts = fixedUrl.split('?')
        const baseUrl = urlParts[0]
        const existingParams = urlParts[1] ? `&${urlParts[1]}` : ''
        return `${baseUrl}?token=${token}&idx=1${existingParams}`
    }

    const connector = fixedUrl.includes('?') ? '&' : '?'
    return `${fixedUrl}${connector}token=${token}&idx=1`
}

const detectImageMime = (buf: Buffer, fallback: string = 'image/jpeg') => {
    if (!buf || buf.length < 4) return fallback

    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'

    // PNG
    if (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) return 'image/png'

    // GIF
    if (buf.length >= 6) {
        const sig = buf.subarray(0, 6).toString('ascii')
        if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
    }

    // WebP
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp'

    // BMP
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'

    // MP4: 00 00 00 18 / 20 / ... + 'ftyp'
    if (buf.length > 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'

    // Fallback logic for video
    if (fallback.includes('video') || fallback.includes('mp4')) return 'video/mp4'

    return fallback
}

export const isVideoUrl = (url: string) => {
    if (!url) return false
    // 排除 vweixinthumb 域名 (缩略图)
    if (url.includes('vweixinthumb')) return false
    return url.includes('snsvideodownload') || url.includes('video') || url.includes('.mp4')
}

import { Isaac64 } from './isaac64'

const extractVideoKey = (xml: string): string | undefined => {
    if (!xml) return undefined
    // 匹配 <enc key="2105122989" ... /> 或 <enc key="2105122989">
    const match = xml.match(/<enc\s+key="(\d+)"/i)
    return match ? match[1] : undefined
}

class SnsService {
    private configService: ConfigService
    private contactCache: ContactCacheService
    private imageCache = new Map<string, string>()

    constructor() {
        this.configService = new ConfigService()
        this.contactCache = new ContactCacheService(this.configService.get('cachePath') as string)
    }

    private getSnsCacheDir(): string {
        const cachePath = this.configService.getCacheBasePath()
        const snsCacheDir = join(cachePath, 'sns_cache')
        if (!existsSync(snsCacheDir)) {
            mkdirSync(snsCacheDir, { recursive: true })
        }
        return snsCacheDir
    }

    private getCacheFilePath(url: string): string {
        const hash = crypto.createHash('md5').update(url).digest('hex')
        const ext = isVideoUrl(url) ? '.mp4' : '.jpg'
        return join(this.getSnsCacheDir(), `${hash}${ext}`)
    }

    async getTimeline(limit: number = 20, offset: number = 0, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
        const result = await wcdbService.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)

        if (result.success && result.timeline) {
            const enrichedTimeline = result.timeline.map((post: any) => {
                const contact = this.contactCache.get(post.username)
                const isVideoPost = post.type === 15

                // 尝试从 rawXml 中提取视频解密密钥 (针对视频号视频)
                const videoKey = extractVideoKey(post.rawXml || '')

                const fixedMedia = (post.media || []).map((m: any) => ({
                    // 如果是视频动态，url 是视频，thumb 是缩略图
                    url: fixSnsUrl(m.url, m.token, isVideoPost),
                    thumb: fixSnsUrl(m.thumb, m.token, false),
                    md5: m.md5,
                    token: m.token,
                    // 只有在视频动态 (Type 15) 下才尝试将 XML 提取的 videoKey 赋予主媒体
                    // 对于图片或实况照片的静态部分，应保留原始 m.key (由 DLL/DB 提供)，避免由于错误的 Isaac64 密钥导致图片解密损坏
                    key: isVideoPost ? (videoKey || m.key) : m.key,
                    encIdx: m.encIdx || m.enc_idx,
                    livePhoto: m.livePhoto
                        ? {
                            ...m.livePhoto,
                            url: fixSnsUrl(m.livePhoto.url, m.livePhoto.token, true),
                            thumb: fixSnsUrl(m.livePhoto.thumb, m.livePhoto.token, false),
                            token: m.livePhoto.token,
                            // 实况照片的视频部分优先使用从 XML 提取的 Key
                            key: videoKey || m.livePhoto.key || m.key,
                            encIdx: m.livePhoto.encIdx || m.livePhoto.enc_idx
                        }
                        : undefined
                }))

                return {
                    ...post,
                    avatarUrl: contact?.avatarUrl,
                    nickname: post.nickname || contact?.displayName || post.username,
                    media: fixedMedia
                }
            })
            return { ...result, timeline: enrichedTimeline }
        }

        return result
    }

    async debugResource(url: string): Promise<{ success: boolean; status?: number; headers?: any; error?: string }> {
        return new Promise((resolve) => {
            try {
                const https = require('https')
                const urlObj = new URL(url)

                const options = {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive',
                        'Range': 'bytes=0-10'
                    }
                }

                const req = https.request(options, (res: any) => {
                    resolve({
                        success: true,
                        status: res.statusCode,
                        headers: {
                            'x-enc': res.headers['x-enc'],
                            'x-time': res.headers['x-time'],
                            'content-length': res.headers['content-length'],
                            'content-type': res.headers['content-type']
                        }
                    })
                    req.destroy()
                })

                req.on('error', (e: any) => resolve({ success: false, error: e.message }))
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }



    async proxyImage(url: string, key?: string | number): Promise<{ success: boolean; dataUrl?: string; videoPath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }
        const cacheKey = `${url}|${key ?? ''}`

        if (this.imageCache.has(cacheKey)) {
            return { success: true, dataUrl: this.imageCache.get(cacheKey) }
        }

        const result = await this.fetchAndDecryptImage(url, key)
        if (result.success) {
            // 如果是视频，返回本地文件路径 (需配合 webSecurity: false 或自定义协议)
            if (result.contentType?.startsWith('video/')) {
                // Return cachePath directly for video
                // 注意：fetchAndDecryptImage 需要修改以返回 cachePath
                return { success: true, videoPath: result.cachePath }
            }

            if (result.data && result.contentType) {
                const dataUrl = `data:${result.contentType};base64,${result.data.toString('base64')}`
                this.imageCache.set(cacheKey, dataUrl)
                return { success: true, dataUrl }
            }
        }
        return { success: false, error: result.error }
    }

    async downloadImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; error?: string }> {
        return this.fetchAndDecryptImage(url, key)
    }

    /**
     * 导出朋友圈动态
     * 支持筛选条件（用户名、关键词）和媒体文件导出
     */
    async exportTimeline(options: {
        outputDir: string
        format: 'json' | 'html'
        usernames?: string[]
        keyword?: string
        exportMedia?: boolean
        startTime?: number
        endTime?: number
    }, progressCallback?: (progress: { current: number; total: number; status: string }) => void): Promise<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; error?: string }> {
        const { outputDir, format, usernames, keyword, exportMedia = false, startTime, endTime } = options

        try {
            // 确保输出目录存在
            if (!existsSync(outputDir)) {
                mkdirSync(outputDir, { recursive: true })
            }

            // 1. 分页加载全部帖子
            const allPosts: SnsPost[] = []
            const pageSize = 50
            let endTs: number | undefined = endTime  // 使用 endTime 作为分页起始上界
            let hasMore = true

            progressCallback?.({ current: 0, total: 0, status: '正在加载朋友圈数据...' })

            while (hasMore) {
                const result = await this.getTimeline(pageSize, 0, usernames, keyword, startTime, endTs)
                if (result.success && result.timeline && result.timeline.length > 0) {
                    allPosts.push(...result.timeline)
                    // 下一页的 endTs 为当前最后一条帖子的时间 - 1
                    const lastTs = result.timeline[result.timeline.length - 1].createTime - 1
                    endTs = lastTs
                    hasMore = result.timeline.length >= pageSize
                    // 如果已经低于 startTime，提前终止
                    if (startTime && lastTs < startTime) {
                        hasMore = false
                    }
                    progressCallback?.({ current: allPosts.length, total: 0, status: `已加载 ${allPosts.length} 条动态...` })
                } else {
                    hasMore = false
                }
            }

            if (allPosts.length === 0) {
                return { success: true, filePath: '', postCount: 0, mediaCount: 0 }
            }

            progressCallback?.({ current: 0, total: allPosts.length, status: `共 ${allPosts.length} 条动态，准备导出...` })

            // 2. 如果需要导出媒体，创建 media 子目录并下载
            let mediaCount = 0
            const mediaDir = join(outputDir, 'media')

            if (exportMedia) {
                if (!existsSync(mediaDir)) {
                    mkdirSync(mediaDir, { recursive: true })
                }

                // 收集所有媒体下载任务
                const mediaTasks: { media: SnsMedia; postId: string; mi: number }[] = []
                for (const post of allPosts) {
                    post.media.forEach((media, mi) => mediaTasks.push({ media, postId: post.id, mi }))
                }

                // 并发下载（5路）
                let done = 0
                const concurrency = 5
                const runTask = async (task: typeof mediaTasks[0]) => {
                    const { media, postId, mi } = task
                    try {
                        const isVideo = isVideoUrl(media.url)
                        const ext = isVideo ? 'mp4' : 'jpg'
                        const fileName = `${postId}_${mi}.${ext}`
                        const filePath = join(mediaDir, fileName)

                        if (existsSync(filePath)) {
                            ;(media as any).localPath = `media/${fileName}`
                            mediaCount++
                        } else {
                            const result = await this.fetchAndDecryptImage(media.url, media.key)
                            if (result.success && result.data) {
                                await writeFile(filePath, result.data)
                                ;(media as any).localPath = `media/${fileName}`
                                mediaCount++
                            } else if (result.success && result.cachePath) {
                                const cachedData = await readFile(result.cachePath)
                                await writeFile(filePath, cachedData)
                                ;(media as any).localPath = `media/${fileName}`
                                mediaCount++
                            }
                        }
                    } catch (e) {
                        console.warn(`[SnsExport] 媒体下载失败: ${task.media.url}`, e)
                    }
                    done++
                    progressCallback?.({ current: done, total: mediaTasks.length, status: `正在下载媒体 (${done}/${mediaTasks.length})...` })
                }

                // 控制并发的执行器
                const queue = [...mediaTasks]
                const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
                    while (queue.length > 0) {
                        const task = queue.shift()!
                        await runTask(task)
                    }
                })
                await Promise.all(workers)
            }

            // 2.5 下载头像
            const avatarMap = new Map<string, string>()
            if (format === 'html') {
                if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true })
                const uniqueUsers = [...new Map(allPosts.filter(p => p.avatarUrl).map(p => [p.username, p])).values()]
                let avatarDone = 0
                const avatarQueue = [...uniqueUsers]
                const avatarWorkers = Array.from({ length: Math.min(5, avatarQueue.length) }, async () => {
                    while (avatarQueue.length > 0) {
                        const post = avatarQueue.shift()!
                        try {
                            const fileName = `avatar_${crypto.createHash('md5').update(post.username).digest('hex').slice(0, 8)}.jpg`
                            const filePath = join(mediaDir, fileName)
                            if (existsSync(filePath)) {
                                avatarMap.set(post.username, `media/${fileName}`)
                            } else {
                                const result = await this.fetchAndDecryptImage(post.avatarUrl!)
                                if (result.success && result.data) {
                                    await writeFile(filePath, result.data)
                                    avatarMap.set(post.username, `media/${fileName}`)
                                }
                            }
                        } catch (e) { /* 头像下载失败不影响导出 */ }
                        avatarDone++
                        progressCallback?.({ current: avatarDone, total: uniqueUsers.length, status: `正在下载头像 (${avatarDone}/${uniqueUsers.length})...` })
                    }
                })
                await Promise.all(avatarWorkers)
            }

            // 3. 生成输出文件
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            let outputFilePath: string

            if (format === 'json') {
                outputFilePath = join(outputDir, `朋友圈导出_${timestamp}.json`)
                const exportData = {
                    exportTime: new Date().toISOString(),
                    totalPosts: allPosts.length,
                    filters: {
                        usernames: usernames || [],
                        keyword: keyword || ''
                    },
                    posts: allPosts.map(p => ({
                        id: p.id,
                        username: p.username,
                        nickname: p.nickname,
                        createTime: p.createTime,
                        createTimeStr: new Date(p.createTime * 1000).toLocaleString('zh-CN'),
                        contentDesc: p.contentDesc,
                        type: p.type,
                        media: p.media.map(m => ({
                            url: m.url,
                            thumb: m.thumb,
                            localPath: (m as any).localPath || undefined
                        })),
                        likes: p.likes,
                        comments: p.comments,
                        linkTitle: (p as any).linkTitle,
                        linkUrl: (p as any).linkUrl
                    }))
                }
                await writeFile(outputFilePath, JSON.stringify(exportData, null, 2), 'utf-8')
            } else {
                // HTML 格式
                outputFilePath = join(outputDir, `朋友圈导出_${timestamp}.html`)
                const html = this.generateHtml(allPosts, { usernames, keyword }, avatarMap)
                await writeFile(outputFilePath, html, 'utf-8')
            }

            progressCallback?.({ current: allPosts.length, total: allPosts.length, status: '导出完成！' })

            return { success: true, filePath: outputFilePath, postCount: allPosts.length, mediaCount }
        } catch (e: any) {
            console.error('[SnsExport] 导出失败:', e)
            return { success: false, error: e.message || String(e) }
        }
    }

    /**
     * 生成朋友圈 HTML 导出文件
     */
    private generateHtml(posts: SnsPost[], filters: { usernames?: string[]; keyword?: string }, avatarMap?: Map<string, string>): string {
        const escapeHtml = (str: string) => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/\n/g, '<br>')

        const formatTime = (ts: number) => {
            const d = new Date(ts * 1000)
            const now = new Date()
            const isCurrentYear = d.getFullYear() === now.getFullYear()
            const pad = (n: number) => String(n).padStart(2, '0')
            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`
            const m = d.getMonth() + 1, day = d.getDate()
            return isCurrentYear ? `${m}月${day}日 ${timeStr}` : `${d.getFullYear()}年${m}月${day}日 ${timeStr}`
        }

        // 生成头像首字母
        const avatarLetter = (name: string) => {
            const ch = name.charAt(0)
            return escapeHtml(ch || '?')
        }

        let filterInfo = ''
        if (filters.keyword) filterInfo += `关键词: "${escapeHtml(filters.keyword)}" `
        if (filters.usernames && filters.usernames.length > 0) filterInfo += `筛选用户: ${filters.usernames.length} 人`

        const postsHtml = posts.map(post => {
            const mediaCount = post.media.length
            const gridClass = mediaCount === 1 ? 'grid-1' : mediaCount === 2 || mediaCount === 4 ? 'grid-2' : 'grid-3'

            const mediaHtml = post.media.map((m, mi) => {
                const localPath = (m as any).localPath
                if (localPath) {
                    if (isVideoUrl(m.url)) {
                        return `<div class="mi"><video src="${escapeHtml(localPath)}" controls preload="metadata"></video></div>`
                    }
                    return `<div class="mi"><img src="${escapeHtml(localPath)}" loading="lazy" onclick="openLb(this.src)" alt=""></div>`
                }
                return `<div class="mi ml"><a href="${escapeHtml(m.url)}" target="_blank">查看媒体</a></div>`
            }).join('')

            const linkHtml = post.linkTitle && post.linkUrl
                ? `<a class="lk" href="${escapeHtml(post.linkUrl)}" target="_blank"><span class="lk-t">${escapeHtml(post.linkTitle)}</span><span class="lk-a">›</span></a>`
                : ''

            const likesHtml = post.likes.length > 0
                ? `<div class="interactions"><div class="likes">♥ ${post.likes.map(l => `<span>${escapeHtml(l)}</span>`).join('、')}</div></div>`
                : ''

            const commentsHtml = post.comments.length > 0
                ? `<div class="interactions${post.likes.length > 0 ? ' cmt-border' : ''}"><div class="cmts">${post.comments.map(c => {
                    const ref = c.refNickname ? `<span class="re">回复</span><b>${escapeHtml(c.refNickname)}</b>` : ''
                    return `<div class="cmt"><b>${escapeHtml(c.nickname)}</b>${ref}：${escapeHtml(c.content)}</div>`
                }).join('')}</div></div>`
                : ''

            const avatarSrc = avatarMap?.get(post.username)
            const avatarHtml = avatarSrc
                ? `<div class="avatar"><img src="${escapeHtml(avatarSrc)}" alt=""></div>`
                : `<div class="avatar">${avatarLetter(post.nickname)}</div>`

            return `<div class="post">
${avatarHtml}
<div class="body">
<div class="hd"><span class="nick">${escapeHtml(post.nickname)}</span><span class="tm">${formatTime(post.createTime)}</span></div>
${post.contentDesc ? `<div class="txt">${escapeHtml(post.contentDesc)}</div>` : ''}
${mediaHtml ? `<div class="mg ${gridClass}">${mediaHtml}</div>` : ''}
${linkHtml}
${likesHtml}
${commentsHtml}
</div></div>`
        }).join('\n')

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>朋友圈导出</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;-webkit-font-smoothing:antialiased}
:root{--bg:#F0EEE9;--card:rgba(255,255,255,.92);--t1:#3d3d3d;--t2:#666;--t3:#999;--accent:#8B7355;--border:rgba(0,0,0,.08);--bg3:rgba(0,0,0,.03)}
@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--card:rgba(40,40,40,.85);--t1:#e0e0e0;--t2:#aaa;--t3:#777;--accent:#c4a882;--border:rgba(255,255,255,.1);--bg3:rgba(255,255,255,.06)}}
.container{max-width:800px;margin:0 auto;padding:20px 24px 60px}

/* 页面标题 */
.feed-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 4px}
.feed-hd h2{font-size:20px;font-weight:700}
.feed-hd .info{font-size:12px;color:var(--t3)}

/* 帖子卡片 - 头像+内容双列 */
.post{background:var(--card);border-radius:16px;border:1px solid var(--border);padding:20px;margin-bottom:24px;display:flex;gap:16px;box-shadow:0 2px 8px rgba(0,0,0,.02);transition:transform .2s,box-shadow .2s}
.post:hover{transform:translateY(-2px);box-shadow:0 8px 16px rgba(0,0,0,.06)}
.avatar{width:48px;height:48px;border-radius:12px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;flex-shrink:0;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.body{flex:1;min-width:0}
.hd{display:flex;flex-direction:column;margin-bottom:8px}
.nick{font-size:15px;font-weight:700;color:var(--accent);margin-bottom:2px}
.tm{font-size:12px;color:var(--t3)}
.txt{font-size:15px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin-bottom:12px}

/* 媒体网格 */
.mg{display:grid;gap:6px;margin-bottom:12px;max-width:320px}
.grid-1{max-width:300px}
.grid-1 .mi{border-radius:12px}
.grid-1 .mi img{aspect-ratio:auto;max-height:480px;object-fit:contain;background:var(--bg3)}
.grid-2{grid-template-columns:1fr 1fr}
.grid-3{grid-template-columns:1fr 1fr 1fr}
.mi{overflow:hidden;border-radius:12px;background:var(--bg3);position:relative;aspect-ratio:1}
.mi img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in;transition:opacity .2s}
.mi img:hover{opacity:.9}
.mi video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.ml{display:flex;align-items:center;justify-content:center}
.ml a{color:var(--accent);text-decoration:none;font-size:13px}

/* 链接卡片 */
.lk{display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--t1);font-size:14px;margin-bottom:12px;transition:background .15s}
.lk:hover{background:var(--border)}
.lk-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.lk-a{color:var(--t3);font-size:18px;flex-shrink:0}

/* 互动区域 */
.interactions{margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);font-size:13px}
.interactions.cmt-border{border-top:none;padding-top:0;margin-top:8px}
.likes{color:var(--accent);font-weight:500;line-height:1.8}
.cmts{background:var(--bg3);border-radius:8px;padding:8px 12px;line-height:1.4}
.cmt{margin-bottom:4px;color:var(--t2)}
.cmt:last-child{margin-bottom:0}
.cmt b{color:var(--accent);font-weight:500}
.re{color:var(--t3);margin:0 4px;font-size:12px}

/* 灯箱 */
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out}
.lb.on{display:flex}
.lb img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px}

/* 回到顶部 */
.btt{position:fixed;right:24px;bottom:32px;width:44px;height:44px;border-radius:50%;background:var(--card);box-shadow:0 2px 12px rgba(0,0,0,.12);border:1px solid var(--border);cursor:pointer;font-size:18px;display:none;align-items:center;justify-content:center;z-index:100;color:var(--t2)}
.btt:hover{transform:scale(1.1)}
.btt.show{display:flex}

/* 页脚 */
.ft{text-align:center;padding:32px 0 24px;font-size:12px;color:var(--t3)}
</style>
</head>
<body>
<div class="container">
    <div class="feed-hd"><h2>朋友圈</h2><span class="info">共 ${posts.length} 条${filterInfo ? ` · ${filterInfo}` : ''}</span></div>
    ${postsHtml}
    <div class="ft">由 WeFlow 导出 · ${new Date().toLocaleString('zh-CN')}</div>
</div>
<div class="lb" id="lb" onclick="closeLb()"><img id="lbi" src=""></div>
<button class="btt" id="btt" onclick="scrollTo({top:0,behavior:'smooth'})">↑</button>
<script>
function openLb(s){document.getElementById('lbi').src=s;document.getElementById('lb').classList.add('on');document.body.style.overflow='hidden'}
function closeLb(){document.getElementById('lb').classList.remove('on');document.body.style.overflow=''}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeLb()})
window.addEventListener('scroll',function(){document.getElementById('btt').classList.toggle('show',window.scrollY>600)})
</script>
</body>
</html>`
    }

    private async fetchAndDecryptImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; cachePath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }

        const isVideo = isVideoUrl(url)
        const cachePath = this.getCacheFilePath(url)

        // 1. 尝试从磁盘缓存读取
        if (existsSync(cachePath)) {
            try {
                // 对于视频，不读取整个文件到内存，只确认存在即可
                if (isVideo) {
                    return { success: true, cachePath, contentType: 'video/mp4' }
                }

                const data = await readFile(cachePath)
                const contentType = detectImageMime(data)
                return { success: true, data, contentType, cachePath }
            } catch (e) {
                console.warn(`[SnsService] 读取缓存失败: ${cachePath}`, e)
            }
        }

        if (isVideo) {
            // 视频专用下载逻辑 (下载 -> 解密 -> 缓存)
            return new Promise(async (resolve) => {
                const tmpPath = join(require('os').tmpdir(), `sns_video_${Date.now()}_${Math.random().toString(36).slice(2)}.enc`)

                try {
                    const https = require('https')
                    const urlObj = new URL(url)
                    const fs = require('fs')

                    const fileStream = fs.createWriteStream(tmpPath)

                    const options = {
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'MicroMessenger Client',
                            'Accept': '*/*',
                            // 'Accept-Encoding': 'gzip, deflate, br', // 视频流通常不压缩，去掉以免 stream 处理复杂
                            'Connection': 'keep-alive'
                        }
                    }

                    const req = https.request(options, (res: any) => {
                        if (res.statusCode !== 200 && res.statusCode !== 206) {
                            fileStream.close()
                            fs.unlink(tmpPath, () => { }) // 删除临时文件
                            resolve({ success: false, error: `HTTP ${res.statusCode}` })
                            return
                        }

                        res.pipe(fileStream)
                        fileStream.on('finish', async () => {
                            fileStream.close()

                            try {
                                const encryptedBuffer = await readFile(tmpPath)
                                const raw = encryptedBuffer // 引用，方便后续操作


                                if (key && String(key).trim().length > 0) {
                                    try {
                                        const keyText = String(key).trim()
                                        let keystream: Buffer

                                        try {
                                            const wasmService = WasmService.getInstance()
                                            // 只需要前 128KB (131072 bytes) 用于解密头部
                                            keystream = await wasmService.getKeystream(keyText, 131072)
                                        } catch (wasmErr) {
                                            // 打包漏带 wasm 或 wasm 初始化异常时，回退到纯 TS ISAAC64
                                            const isaac = new Isaac64(keyText)
                                            keystream = isaac.generateKeystreamBE(131072)
                                        }

                                        const decryptLen = Math.min(keystream.length, raw.length)

                                        // XOR 解密
                                        for (let i = 0; i < decryptLen; i++) {
                                            raw[i] ^= keystream[i]
                                        }

                                        // 验证 MP4 签名 ('ftyp' at offset 4)
                                        const ftyp = raw.subarray(4, 8).toString('ascii')
                                        if (ftyp !== 'ftyp') {
                                            // 可以在此处记录解密可能失败的标记，但不打印详细 hex
                                        }
                                    } catch (err) {
                                        console.error(`[SnsService] 视频解密出错: ${err}`)
                                    }
                                }

                                // 写入最终缓存 (覆盖)
                                await writeFile(cachePath, raw)

                                // 删除临时文件
                                try { await import('fs/promises').then(fs => fs.unlink(tmpPath)) } catch (e) { }

                                resolve({ success: true, data: raw, contentType: 'video/mp4', cachePath })
                            } catch (e: any) {
                                console.error(`[SnsService] 视频处理失败:`, e)
                                resolve({ success: false, error: e.message })
                            }
                        })
                    })

                    req.on('error', (e: any) => {
                        fs.unlink(tmpPath, () => { })
                        resolve({ success: false, error: e.message })
                    })

                    req.setTimeout(15000, () => {
                        req.destroy()
                        fs.unlink(tmpPath, () => { })
                        resolve({ success: false, error: '请求超时' })
                    })

                    req.end()

                } catch (e: any) {
                    resolve({ success: false, error: e.message })
                }
            })
        }

        // 图片逻辑 (保持流式处理)
        return new Promise((resolve) => {
            try {
                const https = require('https')
                const zlib = require('zlib')
                const urlObj = new URL(url)

                const options = {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'MicroMessenger Client',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive'
                    }
                }

                const req = https.request(options, (res: any) => {
                    if (res.statusCode !== 200 && res.statusCode !== 206) {
                        resolve({ success: false, error: `HTTP ${res.statusCode}` })
                        return
                    }

                    const chunks: Buffer[] = []
                    let stream = res

                    const encoding = res.headers['content-encoding']
                    if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip())
                    else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
                    else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())

                    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
                    stream.on('end', async () => {
                        const raw = Buffer.concat(chunks)
                        const xEnc = String(res.headers['x-enc'] || '').trim()

                        let decoded = raw

                        // 图片逻辑
                        const shouldDecrypt = (xEnc === '1' || !!key) && key !== undefined && key !== null && String(key).trim().length > 0
                        if (shouldDecrypt) {
                            try {
                                const keyStr = String(key).trim()
                                if (/^\d+$/.test(keyStr)) {
                                    // 使用 WASM 版本的 Isaac64 解密图片
                                    // 修正逻辑：使用带 reverse 且修正了 8字节对齐偏移的 getKeystream
                                    const wasmService = WasmService.getInstance()
                                    const keystream = await wasmService.getKeystream(keyStr, raw.length)

                                    const decrypted = Buffer.allocUnsafe(raw.length)
                                    for (let i = 0; i < raw.length; i++) {
                                        decrypted[i] = raw[i] ^ keystream[i]
                                    }

                                    decoded = decrypted
                                }
                            } catch (e) {
                                console.error('[SnsService] TS Decrypt Error:', e)
                            }
                        }

                        // 写入磁盘缓存
                        try {
                            await writeFile(cachePath, decoded)
                        } catch (e) {
                            console.warn(`[SnsService] 写入缓存失败: ${cachePath}`, e)
                        }

                        const contentType = detectImageMime(decoded, (res.headers['content-type'] || 'image/jpeg') as string)
                        resolve({ success: true, data: decoded, contentType, cachePath })
                    })
                    stream.on('error', (e: any) => resolve({ success: false, error: e.message }))
                })

                req.on('error', (e: any) => resolve({ success: false, error: e.message }))
                req.setTimeout(15000, () => {
                    req.destroy()
                    resolve({ success: false, error: '请求超时' })
                })
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }
}

export const snsService = new SnsService()
