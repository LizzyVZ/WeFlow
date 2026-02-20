import { useEffect, useState, useRef, useCallback } from 'react'
import { RefreshCw, Search, X, Download, FolderOpen, FileJson, FileText, Image, CheckCircle, AlertCircle, Calendar, Users, Info, ChevronLeft, ChevronRight } from 'lucide-react'
import { ImagePreview } from '../components/ImagePreview'
import JumpToDateDialog from '../components/JumpToDateDialog'
import './SnsPage.scss'
import { SnsPost } from '../types/sns'
import { SnsPostItem } from '../components/Sns/SnsPostItem'
import { SnsFilterPanel } from '../components/Sns/SnsFilterPanel'

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
}

export default function SnsPage() {
    const [posts, setPosts] = useState<SnsPost[]>([])
    const [loading, setLoading] = useState(false)
    const [hasMore, setHasMore] = useState(true)
    const loadingRef = useRef(false)

    // Filter states
    const [searchKeyword, setSearchKeyword] = useState('')
    const [selectedUsernames, setSelectedUsernames] = useState<string[]>([])
    const [jumpTargetDate, setJumpTargetDate] = useState<Date | undefined>(undefined)

    // Contacts state
    const [contacts, setContacts] = useState<Contact[]>([])
    const [contactSearch, setContactSearch] = useState('')
    const [contactsLoading, setContactsLoading] = useState(false)

    // UI states
    const [showJumpDialog, setShowJumpDialog] = useState(false)
    const [previewImage, setPreviewImage] = useState<{ src: string, isVideo?: boolean, liveVideoPath?: string } | null>(null)
    const [debugPost, setDebugPost] = useState<SnsPost | null>(null)

    // 导出相关状态
    const [showExportDialog, setShowExportDialog] = useState(false)
    const [exportFormat, setExportFormat] = useState<'json' | 'html'>('html')
    const [exportFolder, setExportFolder] = useState('')
    const [exportMedia, setExportMedia] = useState(false)
    const [exportDateRange, setExportDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' })
    const [isExporting, setIsExporting] = useState(false)
    const [exportProgress, setExportProgress] = useState<{ current: number; total: number; status: string } | null>(null)
    const [exportResult, setExportResult] = useState<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; error?: string } | null>(null)
    const [refreshSpin, setRefreshSpin] = useState(false)
    const [calendarPicker, setCalendarPicker] = useState<{ field: 'start' | 'end'; month: Date } | null>(null)

    const postsContainerRef = useRef<HTMLDivElement>(null)
    const [hasNewer, setHasNewer] = useState(false)
    const [loadingNewer, setLoadingNewer] = useState(false)
    const postsRef = useRef<SnsPost[]>([])
    const scrollAdjustmentRef = useRef<number>(0)

    // Sync posts ref
    useEffect(() => {
        postsRef.current = posts
    }, [posts])

    // Maintain scroll position when loading newer posts
    useEffect(() => {
        if (scrollAdjustmentRef.current !== 0 && postsContainerRef.current) {
            const container = postsContainerRef.current;
            const newHeight = container.scrollHeight;
            const diff = newHeight - scrollAdjustmentRef.current;
            if (diff > 0) {
                container.scrollTop += diff;
            }
            scrollAdjustmentRef.current = 0;
        }
    }, [posts])

    const loadPosts = useCallback(async (options: { reset?: boolean, direction?: 'older' | 'newer' } = {}) => {
        const { reset = false, direction = 'older' } = options
        if (loadingRef.current) return

        loadingRef.current = true
        if (direction === 'newer') setLoadingNewer(true)
        else setLoading(true)

        try {
            const limit = 20
            let startTs: number | undefined = undefined
            let endTs: number | undefined = undefined

            if (reset) {
                // If jumping to date, set endTs to end of that day
                if (jumpTargetDate) {
                    endTs = Math.floor(jumpTargetDate.getTime() / 1000) + 86399
                }
            } else if (direction === 'newer') {
                const currentPosts = postsRef.current
                if (currentPosts.length > 0) {
                    const topTs = currentPosts[0].createTime

                    const result = await window.electronAPI.sns.getTimeline(
                        limit,
                        0,
                        selectedUsernames,
                        searchKeyword,
                        topTs + 1,
                        undefined
                    );

                    if (result.success && result.timeline && result.timeline.length > 0) {
                        if (postsContainerRef.current) {
                            scrollAdjustmentRef.current = postsContainerRef.current.scrollHeight;
                        }

                        const existingIds = new Set(currentPosts.map((p: SnsPost) => p.id));
                        const uniqueNewer = result.timeline.filter((p: SnsPost) => !existingIds.has(p.id));

                        if (uniqueNewer.length > 0) {
                            setPosts(prev => [...uniqueNewer, ...prev]);
                        }
                        setHasNewer(result.timeline.length >= limit);
                    } else {
                        setHasNewer(false);
                    }
                }
                setLoadingNewer(false);
                loadingRef.current = false;
                return;
            } else {
                // Loading older
                const currentPosts = postsRef.current
                if (currentPosts.length > 0) {
                    endTs = currentPosts[currentPosts.length - 1].createTime - 1
                }
            }

            const result = await window.electronAPI.sns.getTimeline(
                limit,
                0,
                selectedUsernames,
                searchKeyword,
                startTs, // default undefined
                endTs
            )

            if (result.success && result.timeline) {
                if (reset) {
                    setPosts(result.timeline)
                    setHasMore(result.timeline.length >= limit)

                    // Check for newer items above topTs
                    const topTs = result.timeline[0]?.createTime || 0;
                    if (topTs > 0) {
                        const checkResult = await window.electronAPI.sns.getTimeline(1, 0, selectedUsernames, searchKeyword, topTs + 1, undefined);
                        setHasNewer(!!(checkResult.success && checkResult.timeline && checkResult.timeline.length > 0));
                    } else {
                        setHasNewer(false);
                    }

                    if (postsContainerRef.current) {
                        postsContainerRef.current.scrollTop = 0
                    }
                } else {
                    if (result.timeline.length > 0) {
                        setPosts(prev => [...prev, ...result.timeline!])
                    }
                    if (result.timeline.length < limit) {
                        setHasMore(false)
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load SNS timeline:', error)
        } finally {
            setLoading(false)
            setLoadingNewer(false)
            loadingRef.current = false
        }
    }, [selectedUsernames, searchKeyword, jumpTargetDate])

    // Load Contacts
    const loadContacts = useCallback(async () => {
        setContactsLoading(true)
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions) {
                const systemAccounts = ['filehelper', 'fmessage', 'newsapp', 'weixin', 'qqmail', 'tmessage', 'floatbottle', 'medianote', 'brandsessionholder'];
                const initialContacts = result.sessions
                    .filter((s: any) => {
                        if (!s.username) return false;
                        const u = s.username.toLowerCase();
                        if (u.includes('@chatroom') || u.endsWith('@chatroom') || u.endsWith('@openim')) return false;
                        if (u.startsWith('gh_')) return false;
                        if (systemAccounts.includes(u) || u.includes('helper') || u.includes('sessionholder')) return false;
                        return true;
                    })
                    .map((s: any) => ({
                        username: s.username,
                        displayName: s.displayName || s.username,
                        avatarUrl: s.avatarUrl
                    }))
                setContacts(initialContacts)

                const usernames = initialContacts.map((c: { username: string }) => c.username)
                const enriched = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
                if (enriched.success && enriched.contacts) {
                    setContacts(prev => prev.map(c => {
                        const extra = enriched.contacts![c.username]
                        if (extra) {
                            return {
                                ...c,
                                displayName: extra.displayName || c.displayName,
                                avatarUrl: extra.avatarUrl || c.avatarUrl
                            }
                        }
                        return c
                    }))
                }
            }
        } catch (error) {
            console.error('Failed to load contacts:', error)
        } finally {
            setContactsLoading(false)
        }
    }, [])

    // Initial Load & Listeners
    useEffect(() => {
        loadContacts()
    }, [loadContacts])

    useEffect(() => {
        const handleChange = () => {
            // wxid changed, reset everything
            setPosts([]); setHasMore(true); setHasNewer(false);
            setSelectedUsernames([]); setSearchKeyword(''); setJumpTargetDate(undefined);
            loadContacts();
            loadPosts({ reset: true });
        }
        window.addEventListener('wxid-changed', handleChange as EventListener)
        return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
    }, [loadContacts, loadPosts])

    useEffect(() => {
        const timer = setTimeout(() => {
            loadPosts({ reset: true })
        }, 500)
        return () => clearTimeout(timer)
    }, [selectedUsernames, searchKeyword, jumpTargetDate, loadPosts])

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const { scrollTop, clientHeight, scrollHeight } = e.currentTarget
        if (scrollHeight - scrollTop - clientHeight < 400 && hasMore && !loading && !loadingNewer) {
            loadPosts({ direction: 'older' })
        }
        if (scrollTop < 10 && hasNewer && !loading && !loadingNewer) {
            loadPosts({ direction: 'newer' })
        }
    }

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const container = postsContainerRef.current
        if (!container) return
        if (e.deltaY < -20 && container.scrollTop <= 0 && hasNewer && !loading && !loadingNewer) {
            loadPosts({ direction: 'newer' })
        }
    }

    return (
        <div className="sns-page-layout">
            <div className="sns-main-viewport" onScroll={handleScroll} onWheel={handleWheel} ref={postsContainerRef}>
                <div className="sns-feed-container">
                    <div className="feed-header">
                        <h2>朋友圈</h2>
                        <div className="header-actions">
                            <button
                                onClick={() => {
                                    setExportResult(null)
                                    setExportProgress(null)
                                    setExportDateRange({ start: '', end: '' })
                                    setShowExportDialog(true)
                                }}
                                className="icon-btn export-btn"
                                title="导出朋友圈"
                            >
                                <Download size={20} />
                            </button>
                            <button
                                onClick={() => {
                                    setRefreshSpin(true)
                                    loadPosts({ reset: true })
                                    setTimeout(() => setRefreshSpin(false), 800)
                                }}
                                disabled={loading || loadingNewer}
                                className="icon-btn refresh-btn"
                                title="从头刷新"
                            >
                                <RefreshCw size={20} className={(loading || loadingNewer || refreshSpin) ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    {loadingNewer && (
                        <div className="status-indicator loading-newer">
                            <RefreshCw size={16} className="spinning" />
                            <span>正在检查更新的动态...</span>
                        </div>
                    )}

                    {!loadingNewer && hasNewer && (
                        <div className="status-indicator newer-hint" onClick={() => loadPosts({ direction: 'newer' })}>
                            有新动态，点击查看
                        </div>
                    )}

                    <div className="posts-list">
                        {posts.map(post => (
                            <SnsPostItem
                                key={post.id}
                                post={post}
                                onPreview={(src, isVideo, liveVideoPath) => setPreviewImage({ src, isVideo, liveVideoPath })}
                                onDebug={(p) => setDebugPost(p)}
                            />
                        ))}
                    </div>

                    {loading && posts.length === 0 && (
                        <div className="initial-loading">
                            <div className="loading-pulse">
                                <div className="pulse-circle"></div>
                                <span>正在加载朋友圈...</span>
                            </div>
                        </div>
                    )}

                    {loading && posts.length > 0 && (
                        <div className="status-indicator loading-more">
                            <RefreshCw size={16} className="spinning" />
                            <span>正在加载更多...</span>
                        </div>
                    )}

                    {!hasMore && posts.length > 0 && (
                        <div className="status-indicator no-more">已经到底啦</div>
                    )}

                    {!loading && posts.length === 0 && (
                        <div className="no-results">
                            <div className="no-results-icon"><Search size={48} /></div>
                            <p>未找到相关动态</p>
                            {(selectedUsernames.length > 0 || searchKeyword || jumpTargetDate) && (
                                <button onClick={() => {
                                    setSearchKeyword(''); setSelectedUsernames([]); setJumpTargetDate(undefined);
                                }} className="reset-inline">
                                    重置筛选条件
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <SnsFilterPanel
                searchKeyword={searchKeyword}
                setSearchKeyword={setSearchKeyword}
                jumpTargetDate={jumpTargetDate}
                setJumpTargetDate={setJumpTargetDate}
                onOpenJumpDialog={() => setShowJumpDialog(true)}
                selectedUsernames={selectedUsernames}
                setSelectedUsernames={setSelectedUsernames}
                contacts={contacts}
                contactSearch={contactSearch}
                setContactSearch={setContactSearch}
                loading={contactsLoading}
            />

            {/* Dialogs and Overlays */}
            {previewImage && (
                <ImagePreview
                    src={previewImage.src}
                    isVideo={previewImage.isVideo}
                    liveVideoPath={previewImage.liveVideoPath}
                    onClose={() => setPreviewImage(null)}
                />
            )}

            <JumpToDateDialog
                isOpen={showJumpDialog}
                onClose={() => setShowJumpDialog(false)}
                onSelect={(date) => {
                    setJumpTargetDate(date)
                    setShowJumpDialog(false)
                }}
                currentDate={jumpTargetDate || new Date()}
            />

            {debugPost && (
                <div className="modal-overlay" onClick={() => setDebugPost(null)}>
                    <div className="debug-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="debug-dialog-header">
                            <h3>原始数据</h3>
                            <button className="close-btn" onClick={() => setDebugPost(null)}>
                                <X size={20} />
                            </button>
                        </div>
                        <div className="debug-dialog-body">
                            <pre className="json-code">
                                {JSON.stringify(debugPost, null, 2)}
                            </pre>
                        </div>
                    </div>
                </div>
            )}

            {/* 导出对话框 */}
            {showExportDialog && (
                <div className="modal-overlay" onClick={() => !isExporting && setShowExportDialog(false)}>
                    <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="export-dialog-header">
                            <h3>导出朋友圈</h3>
                            <button className="close-btn" onClick={() => !isExporting && setShowExportDialog(false)} disabled={isExporting}>
                                <X size={20} />
                            </button>
                        </div>

                        <div className="export-dialog-body">
                            {/* 筛选条件提示 */}
                            {(selectedUsernames.length > 0 || searchKeyword) && (
                                <div className="export-filter-info">
                                    <span className="filter-badge">筛选导出</span>
                                    {searchKeyword && <span className="filter-tag">关键词: "{searchKeyword}"</span>}
                                    {selectedUsernames.length > 0 && (
                                        <span className="filter-tag">
                                            <Users size={12} />
                                            {selectedUsernames.length} 个联系人
                                            <span className="sync-hint">（同步自侧栏筛选）</span>
                                        </span>
                                    )}
                                </div>
                            )}

                            {!exportResult ? (
                                <>
                                    {/* 格式选择 */}
                                    <div className="export-section">
                                        <label className="export-label">导出格式</label>
                                        <div className="export-format-options">
                                            <button
                                                className={`format-option ${exportFormat === 'html' ? 'active' : ''}`}
                                                onClick={() => setExportFormat('html')}
                                                disabled={isExporting}
                                            >
                                                <FileText size={20} />
                                                <span>HTML</span>
                                                <small>浏览器可直接查看</small>
                                            </button>
                                            <button
                                                className={`format-option ${exportFormat === 'json' ? 'active' : ''}`}
                                                onClick={() => setExportFormat('json')}
                                                disabled={isExporting}
                                            >
                                                <FileJson size={20} />
                                                <span>JSON</span>
                                                <small>结构化数据</small>
                                            </button>
                                        </div>
                                    </div>

                                    {/* 输出路径 */}
                                    <div className="export-section">
                                        <label className="export-label">输出目录</label>
                                        <div className="export-path-row">
                                            <input
                                                type="text"
                                                value={exportFolder}
                                                readOnly
                                                placeholder="点击选择输出目录..."
                                                className="export-path-input"
                                            />
                                            <button
                                                className="export-browse-btn"
                                                onClick={async () => {
                                                    const result = await window.electronAPI.sns.selectExportDir()
                                                    if (!result.canceled && result.filePath) {
                                                        setExportFolder(result.filePath)
                                                    }
                                                }}
                                                disabled={isExporting}
                                            >
                                                <FolderOpen size={16} />
                                            </button>
                                        </div>
                                    </div>

                                    {/* 时间范围 */}
                                    <div className="export-section">
                                        <label className="export-label"><Calendar size={14} /> 时间范围（可选）</label>
                                        <div className="export-date-row">
                                            <div className="date-picker-trigger" onClick={() => {
                                                if (!isExporting) setCalendarPicker(prev => prev?.field === 'start' ? null : { field: 'start', month: exportDateRange.start ? new Date(exportDateRange.start) : new Date() })
                                            }}>
                                                <Calendar size={14} />
                                                <span className={exportDateRange.start ? '' : 'placeholder'}>
                                                    {exportDateRange.start || '开始日期'}
                                                </span>
                                                {exportDateRange.start && (
                                                    <X size={12} className="clear-date" onClick={(e) => { e.stopPropagation(); setExportDateRange(prev => ({ ...prev, start: '' })) }} />
                                                )}
                                            </div>
                                            <span className="date-separator">至</span>
                                            <div className="date-picker-trigger" onClick={() => {
                                                if (!isExporting) setCalendarPicker(prev => prev?.field === 'end' ? null : { field: 'end', month: exportDateRange.end ? new Date(exportDateRange.end) : new Date() })
                                            }}>
                                                <Calendar size={14} />
                                                <span className={exportDateRange.end ? '' : 'placeholder'}>
                                                    {exportDateRange.end || '结束日期'}
                                                </span>
                                                {exportDateRange.end && (
                                                    <X size={12} className="clear-date" onClick={(e) => { e.stopPropagation(); setExportDateRange(prev => ({ ...prev, end: '' })) }} />
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* 媒体导出 */}
                                    <div className="export-section">
                                        <div className="export-toggle-row">
                                            <div className="toggle-label">
                                                <Image size={16} />
                                                <span>导出媒体文件（图片/视频）</span>
                                            </div>
                                            <button
                                                className={`toggle-switch${exportMedia ? ' active' : ''}`}
                                                onClick={() => !isExporting && setExportMedia(!exportMedia)}
                                                disabled={isExporting}
                                            >
                                                <span className="toggle-knob" />
                                            </button>
                                        </div>
                                        {exportMedia && (
                                            <p className="export-media-hint">媒体文件将保存到输出目录的 media 子目录中，可能需要较长时间</p>
                                        )}
                                    </div>

                                    {/* 同步提示 */}
                                    <div className="export-sync-hint">
                                        <Info size={14} />
                                        <span>将同步主页面的联系人范围筛选及关键词搜索</span>
                                    </div>

                                    {/* 进度条 */}
                                    {isExporting && exportProgress && (
                                        <div className="export-progress">
                                            <div className="export-progress-bar">
                                                <div
                                                    className="export-progress-fill"
                                                    style={{ width: exportProgress.total > 0 ? `${Math.round((exportProgress.current / exportProgress.total) * 100)}%` : '100%' }}
                                                />
                                            </div>
                                            <span className="export-progress-text">{exportProgress.status}</span>
                                        </div>
                                    )}

                                    {/* 操作按钮 */}
                                    <div className="export-actions">
                                        <button
                                            className="export-cancel-btn"
                                            onClick={() => setShowExportDialog(false)}
                                            disabled={isExporting}
                                        >
                                            取消
                                        </button>
                                        <button
                                            className="export-start-btn"
                                            disabled={!exportFolder || isExporting}
                                            onClick={async () => {
                                                setIsExporting(true)
                                                setExportProgress({ current: 0, total: 0, status: '准备导出...' })
                                                setExportResult(null)

                                                // 监听进度
                                                const removeProgress = window.electronAPI.sns.onExportProgress((progress: any) => {
                                                    setExportProgress(progress)
                                                })

                                                try {
                                                    const result = await window.electronAPI.sns.exportTimeline({
                                                        outputDir: exportFolder,
                                                        format: exportFormat,
                                                        usernames: selectedUsernames.length > 0 ? selectedUsernames : undefined,
                                                        keyword: searchKeyword || undefined,
                                                        exportMedia,
                                                        startTime: exportDateRange.start ? Math.floor(new Date(exportDateRange.start).getTime() / 1000) : undefined,
                                                        endTime: exportDateRange.end ? Math.floor(new Date(exportDateRange.end + 'T23:59:59').getTime() / 1000) : undefined
                                                    })
                                                    setExportResult(result)
                                                } catch (e: any) {
                                                    setExportResult({ success: false, error: e.message || String(e) })
                                                } finally {
                                                    setIsExporting(false)
                                                    removeProgress()
                                                }
                                            }}
                                        >
                                            {isExporting ? '导出中...' : '开始导出'}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                /* 导出结果 */
                                <div className="export-result">
                                    {exportResult.success ? (
                                        <>
                                            <div className="export-result-icon success">
                                                <CheckCircle size={48} />
                                            </div>
                                            <h4>导出成功</h4>
                                            <p>共导出 {exportResult.postCount} 条动态{exportResult.mediaCount ? `，${exportResult.mediaCount} 个媒体文件` : ''}</p>
                                            <div className="export-result-actions">
                                                <button
                                                    className="export-open-btn"
                                                    onClick={() => {
                                                        if (exportFolder) {
                                                            window.electronAPI.shell.openExternal(`file://${exportFolder}`)
                                                        }
                                                    }}
                                                >
                                                    <FolderOpen size={16} />
                                                    打开目录
                                                </button>
                                                <button
                                                    className="export-done-btn"
                                                    onClick={() => setShowExportDialog(false)}
                                                >
                                                    完成
                                                </button>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="export-result-icon error">
                                                <AlertCircle size={48} />
                                            </div>
                                            <h4>导出失败</h4>
                                            <p className="error-text">{exportResult.error}</p>
                                            <button
                                                className="export-done-btn"
                                                onClick={() => setExportResult(null)}
                                            >
                                                重试
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* 日期选择弹窗 */}
            {calendarPicker && (
                <div className="calendar-overlay" onClick={() => setCalendarPicker(null)}>
                    <div className="calendar-modal" onClick={e => e.stopPropagation()}>
                        <div className="calendar-header">
                            <div className="title-area">
                                <Calendar size={18} />
                                <h3>选择{calendarPicker.field === 'start' ? '开始' : '结束'}日期</h3>
                            </div>
                            <button className="close-btn" onClick={() => setCalendarPicker(null)}>
                                <X size={18} />
                            </button>
                        </div>
                        <div className="calendar-view">
                            <div className="calendar-nav">
                                <button className="nav-btn" onClick={() => setCalendarPicker(prev => prev ? { ...prev, month: new Date(prev.month.getFullYear(), prev.month.getMonth() - 1, 1) } : null)}>
                                    <ChevronLeft size={18} />
                                </button>
                                <span className="current-month">
                                    {calendarPicker.month.getFullYear()}年{calendarPicker.month.getMonth() + 1}月
                                </span>
                                <button className="nav-btn" onClick={() => setCalendarPicker(prev => prev ? { ...prev, month: new Date(prev.month.getFullYear(), prev.month.getMonth() + 1, 1) } : null)}>
                                    <ChevronRight size={18} />
                                </button>
                            </div>
                            <div className="calendar-weekdays">
                                {['日', '一', '二', '三', '四', '五', '六'].map(d => <div key={d} className="weekday">{d}</div>)}
                            </div>
                            <div className="calendar-days">
                                {(() => {
                                    const y = calendarPicker.month.getFullYear()
                                    const m = calendarPicker.month.getMonth()
                                    const firstDay = new Date(y, m, 1).getDay()
                                    const daysInMonth = new Date(y, m + 1, 0).getDate()
                                    const cells: (number | null)[] = []
                                    for (let i = 0; i < firstDay; i++) cells.push(null)
                                    for (let i = 1; i <= daysInMonth; i++) cells.push(i)
                                    const today = new Date()
                                    return cells.map((day, i) => {
                                        if (day === null) return <div key={i} className="day-cell empty" />
                                        const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                                        const isToday = day === today.getDate() && m === today.getMonth() && y === today.getFullYear()
                                        const currentVal = calendarPicker.field === 'start' ? exportDateRange.start : exportDateRange.end
                                        const isSelected = dateStr === currentVal
                                        return (
                                            <div
                                                key={i}
                                                className={`day-cell${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}`}
                                                onClick={() => {
                                                    setExportDateRange(prev => ({ ...prev, [calendarPicker.field]: dateStr }))
                                                    setCalendarPicker(null)
                                                }}
                                            >{day}</div>
                                        )
                                    })
                                })()}
                            </div>
                        </div>
                        <div className="quick-options">
                            <button onClick={() => {
                                if (calendarPicker.field === 'start') {
                                    const d = new Date(); d.setMonth(d.getMonth() - 1)
                                    setExportDateRange(prev => ({ ...prev, start: d.toISOString().split('T')[0] }))
                                } else {
                                    setExportDateRange(prev => ({ ...prev, end: new Date().toISOString().split('T')[0] }))
                                }
                                setCalendarPicker(null)
                            }}>{calendarPicker.field === 'start' ? '一个月前' : '今天'}</button>
                            <button onClick={() => {
                                if (calendarPicker.field === 'start') {
                                    const d = new Date(); d.setMonth(d.getMonth() - 3)
                                    setExportDateRange(prev => ({ ...prev, start: d.toISOString().split('T')[0] }))
                                } else {
                                    const d = new Date(); d.setMonth(d.getMonth() - 1)
                                    setExportDateRange(prev => ({ ...prev, end: d.toISOString().split('T')[0] }))
                                }
                                setCalendarPicker(null)
                            }}>{calendarPicker.field === 'start' ? '三个月前' : '一个月前'}</button>
                        </div>
                        <div className="dialog-footer">
                            <button className="cancel-btn" onClick={() => setCalendarPicker(null)}>取消</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
