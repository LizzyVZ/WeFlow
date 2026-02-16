import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { ContactCacheService } from './contactCacheService'
import { existsSync } from 'fs'
import { basename, join } from 'path'

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
}

const WEIXIN_DLL_OFFSET = 0x2674280n

const fixSnsUrl = (url: string, token?: string) => {
    if (!url) return url

    let fixedUrl = url.replace('http://', 'https://').replace(/\/150($|\?)/, '/0$1')
    if (!token || fixedUrl.includes('token=')) return fixedUrl

    const connector = fixedUrl.includes('?') ? '&' : '?'
    return `${fixedUrl}${connector}token=${token}&idx=1`
}

const detectImageMime = (buf: Buffer, fallback: string = 'image/jpeg') => {
    if (!buf || buf.length < 4) return fallback
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'

    if (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) return 'image/png'

    if (buf.length >= 6) {
        const sig = buf.subarray(0, 6).toString('ascii')
        if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
    }

    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp'

    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
    return fallback
}

class SnsService {
    private contactCache: ContactCacheService
    private imageCache = new Map<string, string>()

    private nativeDecryptInit = false
    private nativeDecryptReady = false
    private nativeDecryptError = ''
    private nativeDecryptDllPath = ''
    private nativeKoffi: any = null
    private nativeWeixinLib: any = null
    private nativeDecryptFn: any = null

    constructor() {
        const config = new ConfigService()
        this.contactCache = new ContactCacheService(config.get('cachePath') as string)
    }

    async getTimeline(limit: number = 20, offset: number = 0, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
        const result = await wcdbService.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)

        if (result.success && result.timeline) {
            const enrichedTimeline = result.timeline.map((post: any) => {
                const contact = this.contactCache.get(post.username)
                const fixedMedia = (post.media || []).map((m: any) => ({
                    url: fixSnsUrl(m.url, m.token),
                    thumb: fixSnsUrl(m.thumb, m.token),
                    md5: m.md5,
                    token: m.token,
                    key: m.key,
                    encIdx: m.encIdx || m.enc_idx,
                    livePhoto: m.livePhoto
                        ? {
                            ...m.livePhoto,
                            url: fixSnsUrl(m.livePhoto.url, m.livePhoto.token),
                            thumb: fixSnsUrl(m.livePhoto.thumb, m.livePhoto.token),
                            token: m.livePhoto.token,
                            key: m.livePhoto.key,
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

    private parseSnsKey(key?: string | number): bigint | null {
        if (key === undefined || key === null) return null
        if (typeof key === 'number') return BigInt(Math.trunc(key))
        const raw = String(key).trim()
        if (!raw) return null
        try {
            return BigInt(raw)
        } catch {
            return null
        }
    }

    private resolveWeixinDllPath(): string | null {
        const candidates: string[] = []
        if (process.env.WEFLOW_WEIXIN_DLL) candidates.push(process.env.WEFLOW_WEIXIN_DLL)

        const weixinExe = process.env.WEFLOW_WEIXIN_EXE
        if (weixinExe) {
            const dir = weixinExe.replace(/\\Weixin\.exe$/i, '')
            if (dir && dir !== weixinExe) candidates.push(join(dir, 'Weixin.dll'))
        }

        const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
        const localAppData = process.env.LOCALAPPDATA || ''
        candidates.push(
            join(programFiles, 'Tencent', 'Weixin', 'Weixin.dll'),
            'D:\\weixindata\\Weixin\\Weixin.dll',
            'C:\\Users\\16586\\Desktop\\sns\\Weixin.dll'
        )
        if (localAppData) candidates.push(join(localAppData, 'Tencent', 'xwechat', 'Weixin.dll'))

        for (const p of candidates) {
            if (p && existsSync(p)) return p
        }
        return null
    }

    private ensureNativeDecryptor(): boolean {
        if (this.nativeDecryptInit) return this.nativeDecryptReady
        this.nativeDecryptInit = true

        try {
            const dllPath = this.resolveWeixinDllPath()
            if (!dllPath) {
                this.nativeDecryptError = 'Weixin.dll not found, set WEFLOW_WEIXIN_DLL if needed'
                return false
            }

            const koffi = require('koffi')
            const kernel32 = koffi.load('kernel32.dll')
            const getModuleHandleW = kernel32.func('void* __stdcall GetModuleHandleW(str16 lpModuleName)')

            const weixinLib = koffi.load(dllPath)

            let modulePtr = getModuleHandleW('Weixin.dll')
            if (!modulePtr) modulePtr = getModuleHandleW(basename(dllPath))
            if (!modulePtr) {
                this.nativeDecryptError = `GetModuleHandleW 失败: ${dllPath}`
                return false
            }

            const base = koffi.address(modulePtr) as bigint
            const decryptAddr = base + WEIXIN_DLL_OFFSET

            // Koffi requires an external pointer object (not raw Number/BigInt).
            // Build a temporary uint64 box, decode it to void*, then decode function pointer.
            const addrBox = new BigUint64Array(1)
            addrBox[0] = decryptAddr
            const decryptPtr = koffi.decode(addrBox, 'void *')
            if (!decryptPtr) {
                this.nativeDecryptError = `Decode function pointer failed: ${decryptAddr.toString(16)}`
                return false
            }

            const decryptProto = koffi.proto('uint64 __fastcall SnsImageDecrypt(void* src, uint64 len, void* dst, uint64 key)')
            this.nativeDecryptFn = koffi.decode(decryptPtr, decryptProto)
            this.nativeKoffi = koffi
            this.nativeWeixinLib = weixinLib
            this.nativeDecryptReady = true
            this.nativeDecryptDllPath = dllPath
            console.info('[SNS] Native decrypt enabled:', this.nativeDecryptDllPath)
            return true
        } catch (e: any) {
            this.nativeDecryptError = e?.message || String(e)
            this.nativeDecryptReady = false
            console.warn('[SNS] Native decrypt init failed:', this.nativeDecryptError)
            return false
        }
    }

    private decryptSnsEncryptedImage(data: Buffer, key: string | number): Buffer {
        const parsedKey = this.parseSnsKey(key)
        if (!parsedKey) return data
        if (!this.ensureNativeDecryptor()) return data

        const out = Buffer.allocUnsafe(data.length)
        try {
            this.nativeDecryptFn(
                data,
                BigInt(data.length),
                out,
                parsedKey
            )
            return out
        } catch (e: any) {
            this.nativeDecryptError = e?.message || String(e)
            console.warn('[SNS] Native decrypt call failed:', this.nativeDecryptError)
            return data
        }
    }

    async proxyImage(url: string, key?: string | number): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }
        const cacheKey = `${url}|${key ?? ''}`

        if (this.imageCache.has(cacheKey)) {
            return { success: true, dataUrl: this.imageCache.get(cacheKey) }
        }

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
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive'
                    }
                }

                const req = https.request(options, (res: any) => {
                    if (res.statusCode !== 200) {
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
                    stream.on('end', () => {
                        const raw = Buffer.concat(chunks)
                        const xEnc = String(res.headers['x-enc'] || '').trim()
                        const shouldDecrypt = xEnc === '1' && key !== undefined && key !== null && String(key).trim().length > 0
                        const decoded = shouldDecrypt ? this.decryptSnsEncryptedImage(raw, key as string | number) : raw

                        const contentType = detectImageMime(decoded, (res.headers['content-type'] || 'image/jpeg') as string)
                        const dataUrl = `data:${contentType};base64,${decoded.toString('base64')}`

                        this.imageCache.set(cacheKey, dataUrl)
                        resolve({ success: true, dataUrl })
                    })
                    stream.on('error', (e: any) => resolve({ success: false, error: e.message }))
                })

                req.on('error', (e: any) => resolve({ success: false, error: e.message }))
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }
}

export const snsService = new SnsService()



