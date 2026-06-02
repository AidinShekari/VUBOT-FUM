require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
let SocksProxyAgent = null;
try {
    ({ SocksProxyAgent } = require('socks-proxy-agent'));
} catch (error) {
    SocksProxyAgent = null;
}
const { CronJob } = require('cron');
const fs = require('fs').promises;
const http = require('http');
const https = require('https');
const axios = require('axios');
const moment = require('moment-jalaali');
const { parseDocument } = require('htmlparser2');
const { selectAll, selectOne } = require('css-select');
const { textContent, getAttributeValue } = require('domutils');
const normalizeApiProvider = (value) => {
    const provider = (value || 'BALE').trim().toUpperCase();
    return ['BALE', 'TELEGRAM', 'BOTH'].includes(provider) ? provider : 'BALE';
};
const API_PROVIDER = normalizeApiProvider(process.env.API_PROVIDER || process.env.TELEGRAM_API_PROVIDER);
const ACTIVE_PLATFORMS = API_PROVIDER === 'BOTH'
    ? ['bale', 'telegram']
    : [API_PROVIDER === 'TELEGRAM' ? 'telegram' : 'bale'];
const PLATFORM_LABELS = {
    bale: 'Bale',
    telegram: 'Telegram'
};
const parseCsv = (value) => (value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
const getFirstEnv = (...names) => {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return '';
};
const parseBoolean = (value, defaultValue = false) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};
// ─── Telegram premium (custom) emoji ─────────────────────────────────────────
// Premium emoji only render on Telegram (HTML parse mode, via <tg-emoji>) and
// only for bots that own a Fragment username. Bale keeps the plain emoji.
const USE_PREMIUM_EMOJI = parseBoolean(process.env.USE_PREMIUM_EMOJI, true);
const PREMIUM_EMOJI_MAP = [
    ['⭐️', '4956591756519932897'],
    ['🗓', '4956214413578207998'],
    ['📊', '5431577498364158238'],
    ['📈', '5373001317042101552'],
    ['📉', '5361748661640372834'],
    ['📥', '5433811242135331842'],
    ['📤', '5433614747381538714'],
    ['📪', '5350310124349053625'],
    ['📬', '5350421256627838238'],
    ['📭', '5352896944496728039'],
    ['📂', '5431721976769027887'],
    ['📁', '5433653135799228968'],
    ['✔️', '6037088297061191007'],
    ['⚠️', '6037255895275015803'],
    ['🚫', '6039591820613127611'],
    ['‼️', '6039866092929683270'],
    ['🟢', '6039690609155903995'],
    ['🔴', '6039708450450050609'],
    ['💲', '6037191595319627499'],
    ['🗣️', '6037212589119770375'],
    ['📣', '6037631219582110913'],
    ['⚡️', '6037220740967697584'],
    ['❓', '6037630738545774536'],
    ['💬', '6039520378127126241'],
    ['🔔', '6039712977345580805'],
    ['🔼', '6037522410880634278'],
    ['🔽', '6037507275415883903'],
    ['🕯', '6037265047850324263'],
    ['📌', '6037579284837567462'],
    ['✅', '5123163417326126159'],
    ['🔗', '4958689671950369798'],
    ['❌', '4958526153955476488'],
    ['📚', '5373098009640836781'],
    ['🎓', '5375163339154399459'],
    ['📎', '5305265301917549162'],
    ['📝', '5230982773086365287'],
    ['🕐', '5386367538735104399'],
    ['🆕', '4956287101604725699'],
    ['🟡', '5852626860516577393'],
    ['🔓', '5296369303661067030'],
    ['🚨', '5395695537687123235'],
    ['🔄', '4956371914323920049'],
    ['📅', '5413879192267805083'],
    ['ℹ️', '4958529074533238201']
];
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Match each emoji even if it appears with/without a trailing variation selector (FE0F).
const PREMIUM_EMOJI_MATCHERS = PREMIUM_EMOJI_MAP.map(([emoji, id]) => {
    const base = emoji.replace(/️/g, '');
    return {
        id,
        display: emoji,
        base,
        regex: new RegExp(escapeRegExp(base) + '\\uFE0F?', 'g')
    };
});
const getObjectValue = (object, ...keys) => {
    for (const key of keys) {
        if (object[key] !== undefined && object[key] !== null && String(object[key]).trim() !== '') {
            return String(object[key]).trim();
        }
    }
    return '';
};
const getActiveChatPlatform = () => (API_PROVIDER === 'TELEGRAM' ? 'telegram' : 'bale');
const getPlatformEnv = (platform, ...names) => {
    const prefixedNames = names.flatMap(name => {
        if (platform === 'telegram') {
            return [`TG_${name}`, `TELEGRAM_${name}`, name];
        }
        return [`BALE_${name}`, name];
    });
    return getFirstEnv(...prefixedNames);
};
const normalizeCourseConfig = (item) => {
    if (typeof item === 'string') {
        return { url: item.trim(), chatId_bale: '', chatId_tg: '' };
    }
    if (!item || typeof item !== 'object') return null;

    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url) return null;

    return {
        url,
        chatId_bale: getObjectValue(
            item,
            'chatId_bale',
            'chatid_bale',
            'chatIdBale',
            'baleChatId',
            'chatId',
            'chatid'
        ),
        chatId_tg: getObjectValue(
            item,
            'chatId_tg',
            'chatid_tg',
            'chatIdTg',
            'telegramChatId',
            'tgChatId'
        )
    };
};
const parseCoursesFromEnv = () => {
    const raw = (process.env.COURSES || '').trim();
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map(normalizeCourseConfig)
                .filter(Boolean);
        } catch (error) {
            console.error('Invalid COURSES JSON in env:', error.message);
            return [];
        }
    }

    // Backward compatibility with old COURSE_URLS + COURSE_CHAT_IDS envs.
    const legacyUrls = parseCsv(process.env.COURSE_URLS);
    const legacyBaleChatIds = parseCsv(
        process.env.COURSE_CHAT_IDS_BALE ||
        process.env.COURSE_BALE_CHAT_IDS ||
        process.env.COURSE_CHAT_IDS
    );
    const legacyTelegramChatIds = parseCsv(
        process.env.COURSE_CHAT_IDS_TG ||
        process.env.COURSE_TG_CHAT_IDS ||
        process.env.COURSE_TELEGRAM_CHAT_IDS
    );
    return legacyUrls.map((url, i) => ({
        url,
        chatId_bale: (legacyBaleChatIds[i] || '').trim(),
        chatId_tg: (legacyTelegramChatIds[i] || '').trim()
    }));
};
const getCourseIdFromUrl = (url) => {
    try {
        return new URL(url).searchParams.get('id') || '';
    } catch (error) {
        return '';
    }
};
const buildCourseChatIdMap = (courses, platform = getActiveChatPlatform()) => {
    const map = {};
    const chatIdKey = platform === 'telegram' ? 'chatId_tg' : 'chatId_bale';
    for (const course of courses) {
        const url = (course && course.url ? String(course.url) : '').trim();
        const chatId = (course && course[chatIdKey] ? String(course[chatIdKey]) : '').trim();
        if (!url) continue;
        if (!chatId) continue;
        const courseId = getCourseIdFromUrl(url);
        if (courseId) {
            map[courseId] = chatId;
        }
        map[url] = chatId;
    }
    return map;
};
const COURSES = parseCoursesFromEnv();
const COURSE_URLS = COURSES.map(c => c.url);
const COURSE_CHAT_ID_MAPS = {
    bale: buildCourseChatIdMap(COURSES, 'bale'),
    telegram: buildCourseChatIdMap(COURSES, 'telegram')
};
const getGlobalChatId = (platform) => platform === 'telegram'
    ? getFirstEnv(
        'GLOBAL_CHAT_ID_TG',
        'GLOBAL_TG_CHAT_ID',
        'GLOBAL_TELEGRAM_CHAT_ID',
        'TELEGRAM_CHAT_ID',
        'CHAT_ID_TG',
        API_PROVIDER !== 'BOTH' ? 'GLOBAL_CHAT_ID' : '',
        API_PROVIDER !== 'BOTH' ? 'CHAT_ID' : ''
    )
    : getFirstEnv(
        'GLOBAL_CHAT_ID_BALE',
        'GLOBAL_BALE_CHAT_ID',
        'CHAT_ID_BALE',
        'GLOBAL_CHAT_ID',
        'CHAT_ID'
    );
const getApiBaseUrl = (platform) => {
    const value = platform === 'telegram'
        ? getFirstEnv(
            'TG_API_BASE_URL',
            'TELEGRAM_API_BASE_URL',
            API_PROVIDER !== 'BOTH' ? 'API_BASE_URL' : ''
        )
        : getFirstEnv(
            'BALE_API_BASE_URL',
            API_PROVIDER !== 'BOTH' ? 'API_BASE_URL' : ''
        );

    return (value || (platform === 'telegram'
        ? 'https://api.telegram.org'
        : 'https://tapi.bale.ai')).replace(/\/+$/, '');
};
const normalizeSocksProxyUrl = (proxyUrl, platform) => {
    if (!proxyUrl) return '';
    if (platform === 'telegram' && proxyUrl.toLowerCase().startsWith('socks5://')) {
        return `socks5h://${proxyUrl.slice('socks5://'.length)}`;
    }
    return proxyUrl;
};
const buildPlatformConfig = (platform) => ({
    name: platform,
    label: PLATFORM_LABELS[platform],
    token: platform === 'telegram'
        ? getFirstEnv('TG_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', API_PROVIDER !== 'BOTH' ? 'BOT_TOKEN' : '')
        : getFirstEnv('BALE_BOT_TOKEN', 'BOT_TOKEN'),
    globalChatId: getGlobalChatId(platform),
    topicId: getPlatformEnv(platform, 'TOPIC_ID')
        ? parseInt(getPlatformEnv(platform, 'TOPIC_ID'), 10)
        : null,
    adminChatId: getPlatformEnv(platform, 'ADMIN_CHAT_ID'),
    apiBaseUrl: getApiBaseUrl(platform),
    httpProxy: getPlatformEnv(platform, 'HTTP_PROXY'),
    socksProxy: platform === 'telegram'
        ? normalizeSocksProxyUrl(getFirstEnv('TG_SOCKS_PROXY', 'TELEGRAM_SOCKS_PROXY', 'SOCKS_PROXY'), platform)
        : '',
    pollingEnabled: parseBoolean(getPlatformEnv(platform, 'BOT_POLLING', 'POLLING', 'ENABLE_POLLING'), false),
    courseChatIdMap: COURSE_CHAT_ID_MAPS[platform] || {}
});
const PLATFORM_CONFIGS = {
    bale: buildPlatformConfig('bale'),
    telegram: buildPlatformConfig('telegram')
};
const DEFAULT_PLATFORM = getActiveChatPlatform();
const CONFIG = {
    apiProvider: API_PROVIDER,
    activePlatforms: ACTIVE_PLATFORMS,
    platforms: PLATFORM_CONFIGS,
    telegram: PLATFORM_CONFIGS[DEFAULT_PLATFORM],
    vu: {
        username: process.env.VU_USERNAME || process.env.VU_USER || '',
        password: process.env.VU_PASSWORD || process.env.VU_PASS || '',
        courseUrls: COURSE_URLS,
        courseChatIdMap: COURSE_CHAT_ID_MAPS[DEFAULT_PLATFORM],
        courseChatIdMaps: COURSE_CHAT_ID_MAPS
    },
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 5,
    debug: process.env.DEBUG_MODE === 'true' || false,
    chromePath: process.env.CHROME_PATH || null,
    httpProxy: process.env.HTTP_PROXY || null,
    quietHoursEnabled: false  // true = quiet hours فعال، false = غیرفعال
};
for (const platform of CONFIG.activePlatforms) {
    const platformConfig = CONFIG.platforms[platform];
    if (platformConfig.socksProxy) {
        console.log(`Using ${platformConfig.label} SOCKS proxy`);
        if (platformConfig.httpProxy) {
            console.log(`Ignoring ${platformConfig.label} HTTP proxy because SOCKS proxy is configured`);
        }
    } else if (platformConfig.httpProxy) {
        console.log(`Using ${platformConfig.label} HTTP proxy`);
    }
}
const createRequestOptions = (platformConfig) => {
    const requestOptions = {};

    if (platformConfig.httpProxy && !platformConfig.socksProxy) {
        requestOptions.proxy = platformConfig.httpProxy;
    }

    if (platformConfig.socksProxy) {
        if (!SocksProxyAgent) {
            throw new Error('SOCKS proxy support requires the socks-proxy-agent package. Run npm install first.');
        }
        requestOptions.proxy = null;
        requestOptions.agent = new SocksProxyAgent(platformConfig.socksProxy);
        requestOptions.tunnel = false;
    }

    return Object.keys(requestOptions).length > 0 ? requestOptions : null;
};
const botInstances = {};
function getBot(platform = DEFAULT_PLATFORM) {
    const platformConfig = CONFIG.platforms[platform];
    if (!platformConfig) {
        throw new Error(`Unknown bot platform: ${platform}`);
    }
    if (!botInstances[platform]) {
        if (!platformConfig.token) {
            throw new Error(`${platformConfig.label} bot token is not configured. Set ${platform === 'telegram' ? 'TG_BOT_TOKEN' : 'BALE_BOT_TOKEN'} in .env.`);
        }
        const botOptions = {
            polling: platformConfig.pollingEnabled,
            baseApiUrl: platformConfig.apiBaseUrl
        };
        const requestOptions = createRequestOptions(platformConfig);
        if (requestOptions) {
            botOptions.request = requestOptions;
        }
        botInstances[platform] = new TelegramBot(platformConfig.token, botOptions);
        if (platformConfig.pollingEnabled) {
            botInstances[platform].on('polling_error', (error) => {
                const message = error?.message || String(error);
                const code = error?.code ? ` ${error.code}` : '';
                console.error(`❌ ${platformConfig.label} polling error${code}: ${message}`);
            });
        }
    }
    return botInstances[platform];
}
let monitor = null;
const DATA_FILE = 'course_data.json';
class VUMonitor {
    constructor() {
        this.cookieJar = [];
        this.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        this.lastUrl = '';
        this.lastHtml = '';
        this.httpClient = axios.create({
            responseType: 'arraybuffer',
            validateStatus: () => true,
            maxRedirects: 0
        });
        this.courseData = {};
        this.cronJob = null;
        this.isFirstRun = false;
        this.courseMessageIds = {};
        this.sentReminders = {};
        this.sentLastDayReminders = {};
        this.deadlineMessageIds = {};
        this.deadlineMessageHistoryIds = {};
    }
    getPlatformConfig(platform) {
        return CONFIG.platforms[platform] || null;
    }
    getStorageKey(targetOrChatId, platform = DEFAULT_PLATFORM) {
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        if (!target) return '';
        return target.platform === 'bale'
            ? String(target.chatId)
            : `${target.platform}:${target.chatId}`;
    }
    normalizeChatTarget(targetOrChatId, platform = DEFAULT_PLATFORM) {
        if (targetOrChatId && typeof targetOrChatId === 'object') {
            const targetPlatform = targetOrChatId.platform || platform || DEFAULT_PLATFORM;
            const chatId = targetOrChatId.chatId === undefined || targetOrChatId.chatId === null
                ? ''
                : String(targetOrChatId.chatId).trim();
            if (!chatId) return null;
            return { platform: targetPlatform, chatId };
        }

        const chatId = targetOrChatId === undefined || targetOrChatId === null
            ? ''
            : String(targetOrChatId).trim();
        if (!chatId) return null;
        return { platform: platform || DEFAULT_PLATFORM, chatId };
    }
    addTarget(targets, platform, chatId) {
        const target = this.normalizeChatTarget({ platform, chatId });
        if (!target) return;
        targets.set(`${target.platform}:${target.chatId}`, target);
    }
    getCourseExtraChatId(courseId, courseUrl = '', platform = DEFAULT_PLATFORM) {
        const map = CONFIG.vu.courseChatIdMaps?.[platform] || {};
        if (courseId && map[courseId]) {
            return map[courseId];
        }
        if (courseUrl && map[courseUrl]) {
            return map[courseUrl];
        }
        return null;
    }
    getCourseTargetChatIds(courseId, courseUrl = '') {
        const targets = new Map();
        for (const platform of CONFIG.activePlatforms) {
            const platformConfig = this.getPlatformConfig(platform);
            if (!platformConfig || !platformConfig.token) {
                continue;
            }
            if (platformConfig.globalChatId) {
                this.addTarget(targets, platform, platformConfig.globalChatId);
            }
            const extraChatId = this.getCourseExtraChatId(courseId, courseUrl, platform);
            if (extraChatId) {
                this.addTarget(targets, platform, extraChatId);
            }
        }
        return Array.from(targets.values());
    }
    getDeadlineOverviewTargetChatIds() {
        const targets = new Map();
        for (const platform of CONFIG.activePlatforms) {
            const platformConfig = this.getPlatformConfig(platform);
            if (!platformConfig || !platformConfig.token) continue;
            if (platformConfig.globalChatId) {
                this.addTarget(targets, platform, platformConfig.globalChatId);
            }
        }
        return Array.from(targets.values());
    }
    getCourseIdsForChatId(chatId, platform = DEFAULT_PLATFORM) {
        const targetChatId = chatId === undefined || chatId === null
            ? ''
            : String(chatId).trim();
        const courseIds = new Set();

        if (!targetChatId) {
            return courseIds;
        }

        const map = CONFIG.vu.courseChatIdMaps?.[platform] || {};
        for (const [key, mappedChatId] of Object.entries(map)) {
            const normalizedMappedChatId = mappedChatId === undefined || mappedChatId === null
                ? ''
                : String(mappedChatId).trim();

            if (normalizedMappedChatId !== targetChatId) {
                continue;
            }

            const courseId = getCourseIdFromUrl(key) || String(key).trim();
            if (courseId) {
                courseIds.add(courseId);
            }
        }

        return courseIds;
    }
    normalizeMessageId(rawMessageId) {
        if (rawMessageId === undefined || rawMessageId === null) {
            return null;
        }
        if (typeof rawMessageId === 'number' && Number.isFinite(rawMessageId)) {
            return rawMessageId;
        }
        const parsed = parseInt(String(rawMessageId).trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    getChatScopedOptions(baseOptions, targetOrChatId, platform = DEFAULT_PLATFORM) {
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        const platformConfig = target ? this.getPlatformConfig(target.platform) : null;
        const options = { ...baseOptions };
        if (
            platformConfig?.topicId &&
            target &&
            String(target.chatId) === String(platformConfig.globalChatId)
        ) {
            options.message_thread_id = platformConfig.topicId;
        }
        return options;
    }
    async deleteTelegramMessage(targetOrChatId, messageId, platform = DEFAULT_PLATFORM) {
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        if (!target) return 'invalid';
        const normalizedMessageId = this.normalizeMessageId(messageId);
        if (normalizedMessageId === null) return 'invalid';
        try {
            await getBot(target.platform).deleteMessage(target.chatId, normalizedMessageId);
            return 'deleted';
        } catch (error) {
            const message = error?.message || '';
            if (message.includes('message to delete not found') || message.includes('message_id_invalid')) {
                return 'not_found';
            }
            if (message.includes('message cannot be deleted')) {
                return 'cannot_delete';
            }
            if (!message.includes('message to delete not found') && !message.includes('message cannot be deleted')) {
                console.log(`⚠️ Could not delete message ${normalizedMessageId} in ${target.platform} chat ${target.chatId}:`, message);
            }
            return 'error';
        }
    }
    isDeadlineOverviewMessageText(text = '') {
        if (!text) return false;
        const normalized = String(text)
            .replace(/[*_`~]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return normalized.includes('لیست رویداد ها');
    }
    extractDeadlineOverviewMessageIdFromUpdate(update, targetChatId) {
        const updateKinds = ['message', 'edited_message', 'channel_post', 'edited_channel_post'];
        for (const kind of updateKinds) {
            const payload = update?.[kind];
            if (!payload || !payload.chat) {
                continue;
            }
            if (String(payload.chat.id) !== String(targetChatId)) {
                continue;
            }
            if (!this.isDeadlineOverviewMessageText(payload.text || payload.caption || '')) {
                continue;
            }
            const messageId = this.normalizeMessageId(payload.message_id);
            if (messageId !== null) {
                return messageId;
            }
        }
        return null;
    }
    getStoredDeadlineMessageCandidates(targetOrChatId, platform = DEFAULT_PLATFORM) {
        const key = this.getStorageKey(targetOrChatId, platform);
        const candidates = [];

        const primaryId = this.normalizeMessageId(this.deadlineMessageIds[key]);
        if (primaryId !== null) {
            candidates.push(primaryId);
        }

        const history = Array.isArray(this.deadlineMessageHistoryIds[key])
            ? this.deadlineMessageHistoryIds[key]
            : [];
        for (const rawId of history) {
            const messageId = this.normalizeMessageId(rawId);
            if (messageId !== null && !candidates.includes(messageId)) {
                candidates.push(messageId);
            }
        }

        return candidates;
    }
    setDeadlineMessageHistory(targetOrChatId, ids, platform = DEFAULT_PLATFORM) {
        const key = this.getStorageKey(targetOrChatId, platform);
        const normalizedUnique = [];
        for (const rawId of ids || []) {
            const messageId = this.normalizeMessageId(rawId);
            if (messageId !== null && !normalizedUnique.includes(messageId)) {
                normalizedUnique.push(messageId);
            }
        }
        if (normalizedUnique.length > 0) {
            this.deadlineMessageHistoryIds[key] = normalizedUnique.slice(0, 20);
        } else {
            delete this.deadlineMessageHistoryIds[key];
        }
    }
    registerDeadlineMessageId(targetOrChatId, messageId, platform = DEFAULT_PLATFORM) {
        const key = this.getStorageKey(targetOrChatId, platform);
        const normalizedMessageId = this.normalizeMessageId(messageId);
        if (normalizedMessageId === null) {
            return;
        }
        const existing = this.getStoredDeadlineMessageCandidates(targetOrChatId, platform);
        const merged = [normalizedMessageId, ...existing];
        this.setDeadlineMessageHistory(targetOrChatId, merged, platform);
        this.deadlineMessageIds[key] = normalizedMessageId;
    }
    async findRecentDeadlineOverviewMessageIds(targetOrChatId, limit = 100, platform = DEFAULT_PLATFORM) {
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        if (!target) return [];
        try {
            const boundedLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 100));
            const updates = await getBot(target.platform).getUpdates({
                offset: -boundedLimit,
                limit: boundedLimit,
                timeout: 0
            });

            if (!Array.isArray(updates) || updates.length === 0) {
                return [];
            }

            const foundIds = [];
            for (let i = updates.length - 1; i >= 0; i -= 1) {
                const messageId = this.extractDeadlineOverviewMessageIdFromUpdate(updates[i], target.chatId);
                if (messageId !== null && !foundIds.includes(messageId)) {
                    foundIds.push(messageId);
                }
            }

            return foundIds;
        } catch (error) {
            console.log(`Could not inspect recent updates for ${target.platform} chat ${target.chatId}: ${error.message}`);
            return [];
        }
    }
    async cleanupDuplicateDeadlineOverviewMessages(targetOrChatId, keepMessageId, candidateIds = [], platform = DEFAULT_PLATFORM) {
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        if (!target) return;
        const keepId = this.normalizeMessageId(keepMessageId);
        if (keepId === null) {
            return;
        }

        const toReview = [];
        for (const rawId of [...candidateIds, ...this.getStoredDeadlineMessageCandidates(target)]) {
            const messageId = this.normalizeMessageId(rawId);
            if (messageId !== null && messageId !== keepId && !toReview.includes(messageId)) {
                toReview.push(messageId);
            }
        }

        const undeletedIds = [];
        for (const messageId of toReview) {
            const deleteStatus = await this.deleteTelegramMessage(target, messageId);
            if (deleteStatus === 'cannot_delete' || deleteStatus === 'error') {
                undeletedIds.push(messageId);
            }
        }

        this.setDeadlineMessageHistory(target, [keepId, ...undeletedIds]);
        this.deadlineMessageIds[this.getStorageKey(target)] = keepId;
    }
    getStoredCourseMessageIds(courseId, targetOrChatId, platform = DEFAULT_PLATFORM) {
        const stored = this.courseMessageIds[courseId];
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        const key = this.getStorageKey(target);
        if (Array.isArray(stored)) {
            const platformConfig = target ? this.getPlatformConfig(target.platform) : null;
            if (target && String(platformConfig?.globalChatId) === String(target.chatId)) {
                return stored;
            }
            return [];
        }
        if (stored && typeof stored === 'object' && Array.isArray(stored[key])) {
            return stored[key];
        }
        return [];
    }
    setStoredCourseMessageIds(courseId, targetOrChatId, ids, platform = DEFAULT_PLATFORM) {
        const target = this.normalizeChatTarget(targetOrChatId, platform);
        const key = this.getStorageKey(target);
        const prev = this.courseMessageIds[courseId];
        if (!prev || Array.isArray(prev)) {
            this.courseMessageIds[courseId] = {};
            const platformConfig = target ? this.getPlatformConfig(target.platform) : null;
            if (Array.isArray(prev) && platformConfig?.globalChatId) {
                this.courseMessageIds[courseId][this.getStorageKey({
                    platform: target.platform,
                    chatId: platformConfig.globalChatId
                })] = prev;
            }
        }
        this.courseMessageIds[courseId][key] = ids;
    }
    resetSession() {
        this.cookieJar = [];
        this.lastUrl = '';
        this.lastHtml = '';
    }
    isBrowserHealthy() {
        return this.cookieJar.length > 0;
    }
    async clearBrowserCache() {
        console.log('🧹 HTTP session active; no browser cache to clear');
    }
    async initialize() {
        console.log('🚀 Initializing VU Monitor...');
        await this.loadData();
        this.resetSession();
        console.log('✅ HTTP session initialized');
    }
    defaultCookiePath(pathname = '/') {
        if (!pathname || !pathname.startsWith('/')) return '/';
        if (pathname === '/') return '/';
        const lastSlash = pathname.lastIndexOf('/');
        return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
    }
    storeCookies(setCookieHeaders, requestUrl) {
        const urlObj = new URL(requestUrl);
        const headers = Array.isArray(setCookieHeaders)
            ? setCookieHeaders
            : setCookieHeaders ? [setCookieHeaders] : [];

        for (const rawHeader of headers) {
            if (!rawHeader || typeof rawHeader !== 'string') continue;
            const parts = rawHeader.split(';').map(part => part.trim()).filter(Boolean);
            const [nameValue, ...attributes] = parts;
            const splitIndex = nameValue.indexOf('=');
            if (splitIndex <= 0) continue;

            const cookie = {
                name: nameValue.slice(0, splitIndex).trim(),
                value: nameValue.slice(splitIndex + 1).trim(),
                domain: urlObj.hostname.toLowerCase(),
                path: this.defaultCookiePath(urlObj.pathname),
                secure: false,
                expiresAt: null
            };

            for (const attribute of attributes) {
                const attrIndex = attribute.indexOf('=');
                const rawKey = attrIndex >= 0 ? attribute.slice(0, attrIndex) : attribute;
                const rawValue = attrIndex >= 0 ? attribute.slice(attrIndex + 1) : '';
                const key = rawKey.trim().toLowerCase();
                const value = rawValue.trim();

                if (key === 'domain' && value) {
                    cookie.domain = value.replace(/^\./, '').toLowerCase();
                } else if (key === 'path' && value) {
                    cookie.path = value;
                } else if (key === 'secure') {
                    cookie.secure = true;
                } else if (key === 'max-age') {
                    const seconds = parseInt(value, 10);
                    if (Number.isFinite(seconds)) {
                        cookie.expiresAt = Date.now() + (seconds * 1000);
                    }
                } else if (key === 'expires' && value) {
                    const expiresAt = Date.parse(value);
                    if (!Number.isNaN(expiresAt)) {
                        cookie.expiresAt = expiresAt;
                    }
                }
            }

            this.cookieJar = this.cookieJar.filter(existing => !(
                existing.name === cookie.name &&
                existing.domain === cookie.domain &&
                existing.path === cookie.path
            ));

            if (cookie.expiresAt && cookie.expiresAt <= Date.now()) {
                continue;
            }

            this.cookieJar.push(cookie);
        }
    }
    domainMatches(hostname, cookieDomain) {
        const normalizedHost = String(hostname || '').toLowerCase();
        const normalizedDomain = String(cookieDomain || '').toLowerCase();
        return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
    }
    pathMatches(pathname, cookiePath) {
        const normalizedPathname = pathname || '/';
        const normalizedCookiePath = cookiePath || '/';
        return normalizedPathname === normalizedCookiePath || normalizedPathname.startsWith(normalizedCookiePath.endsWith('/') ? normalizedCookiePath : `${normalizedCookiePath}/`);
    }
    getCookieHeader(targetUrl) {
        const urlObj = new URL(targetUrl);
        const now = Date.now();
        this.cookieJar = this.cookieJar.filter(cookie => !cookie.expiresAt || cookie.expiresAt > now);

        return this.cookieJar
            .filter(cookie => this.domainMatches(urlObj.hostname, cookie.domain))
            .filter(cookie => this.pathMatches(urlObj.pathname, cookie.path))
            .filter(cookie => !cookie.secure || urlObj.protocol === 'https:')
            .sort((a, b) => (b.path || '').length - (a.path || '').length)
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
    }
    absoluteUrl(url, baseUrl) {
        try {
            return new URL(url, baseUrl).toString();
        } catch (error) {
            return '';
        }
    }
    parseHtml(html = '') {
        return parseDocument(html || '');
    }
    queryOne(root, selector) {
        try {
            return selectOne(selector, root);
        } catch (error) {
            return null;
        }
    }
    queryAll(root, selector) {
        try {
            return selectAll(selector, root);
        } catch (error) {
            return [];
        }
    }
    nodeText(node) {
        return node ? this.cleanText(textContent(node)).replace(/\s+/g, ' ').trim() : '';
    }
    nodeAttr(node, attr) {
        return node ? (getAttributeValue(node, attr) || '') : '';
    }
    cleanText(value = '') {
        let text = String(value || '');
        text = this.fixMojibake(text);
        return text
            .normalize('NFC')
            .replace(/\uFEFF/g, '')
            .trim();
    }
    fixMojibake(value = '') {
        const text = String(value || '');
        if (!/[ÃÂØÙÛ]|[\u0080-\u009F]/.test(text)) {
            return text;
        }

        try {
            const candidate = Buffer.from(text, 'latin1').toString('utf8');
            const score = (s) => {
                const persianChars = (s.match(/[\u0600-\u06FF]/g) || []).length;
                const mojibakeMarks = (s.match(/[ÃÂØÙÛ]|[\u0080-\u009F]/g) || []).length;
                const replacementChars = (s.match(/\uFFFD/g) || []).length;
                return persianChars - (mojibakeMarks * 2) - (replacementChars * 4);
            };

            return score(candidate) > score(text) ? candidate : text;
        } catch (error) {
            return text;
        }
    }
    toEnglishDigits(value = '') {
        return String(value || '')
            .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
            .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
    }
    addWeekdayToEnglishDate(dateText) {
        const match = String(dateText || '').trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})،\s*(.+)$/);
        if (!match) return '';

        const day = parseInt(match[1], 10);
        const monthName = match[2];
        const year = parseInt(match[3], 10);
        const time = match[4].trim();
        const months = {
            January: 0, February: 1, March: 2, April: 3,
            May: 4, June: 5, July: 6, August: 7,
            September: 8, October: 9, November: 10, December: 11
        };
        const month = months[monthName];
        if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return '';

        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const weekday = weekdays[new Date(year, month, day).getDay()];
        return `${weekday}، ${day} ${monthName} ${year}، ${time}`;
    }
    extractActivityStartDate(activityNode) {
        const availabilityNode =
            this.queryOne(activityNode, '.availabilityinfo .description-inner') ||
            this.queryOne(activityNode, '.availabilityinfo') ||
            this.queryOne(activityNode, '.isrestricted .description-inner') ||
            this.queryOne(activityNode, '.isrestricted');
        const availabilityText = this.nodeText(availabilityNode);
        if (!availabilityText) return '';

        const match = availabilityText.match(/(?:از|from)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}،\s*\d{1,2}:\d{2}\s*(?:AM|PM))/i);
        if (!match) return '';

        return this.addWeekdayToEnglishDate(match[1]);
    }
    buildActivityUrlFromModuleId(activityNode, activityType, currentUrl) {
        const moduleId =
            this.nodeAttr(activityNode, 'data-id') ||
            this.nodeAttr(activityNode, 'id').match(/^module-(\d+)$/)?.[1];
        if (!moduleId) return '';

        const moodleType = String(activityType || '').replace(/^mod_/, '');
        if (!moodleType || moodleType === 'unknown') return '';

        return this.absoluteUrl(`/mod/${moodleType}/view.php?id=${moduleId}`, currentUrl);
    }
    async request(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body = null,
            followRedirects = true,
            timeout = 120000,
            referer = ''
        } = options;

        const requestUrl = new URL(url);
        const requestHeaders = {
            'User-Agent': this.userAgent,
            'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
            ...headers
        };

        const cookieHeader = this.getCookieHeader(requestUrl.toString());
        if (cookieHeader) {
            requestHeaders.Cookie = cookieHeader;
        }
        if (referer) {
            requestHeaders.Referer = referer;
        }

        const bodyBuffer = body === null || body === undefined
            ? null
            : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        if (bodyBuffer && requestHeaders['Content-Length'] === undefined) {
            requestHeaders['Content-Length'] = bodyBuffer.length;
        }

        try {
            const response = await this.httpClient.request({
                url: requestUrl.toString(),
                method,
                headers: requestHeaders,
                data: bodyBuffer,
                timeout
            });

            this.storeCookies(response.headers['set-cookie'], requestUrl.toString());

            const statusCode = response.status || 0;
            const location = response.headers?.location;

            if (followRedirects && [301, 302, 303, 307, 308].includes(statusCode) && location) {
                const redirectUrl = this.absoluteUrl(location, requestUrl.toString());
                const shouldSwitchToGet = statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method.toUpperCase() === 'POST');
                const redirectHeaders = { ...headers };
                if (shouldSwitchToGet) {
                    for (const headerName of Object.keys(redirectHeaders)) {
                        if (['content-type', 'content-length', 'origin'].includes(headerName.toLowerCase())) {
                            delete redirectHeaders[headerName];
                        }
                    }
                }
                return await this.request(redirectUrl, {
                    method: shouldSwitchToGet ? 'GET' : method,
                    headers: redirectHeaders,
                    body: shouldSwitchToGet ? null : bodyBuffer,
                    followRedirects: true,
                    timeout,
                    referer: requestUrl.toString()
                });
            }

            const responseBuffer = Buffer.isBuffer(response.data)
                ? response.data
                : Buffer.from(response.data || '');

            return {
                statusCode,
                headers: response.headers || {},
                buffer: responseBuffer,
                text: responseBuffer.toString('utf8'),
                finalUrl: requestUrl.toString()
            };
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                throw new Error('Request timeout');
            }
            throw error;
        }
    }
    async fetchHtmlPage(url, options = {}) {
        const response = await this.request(url, {
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                ...(options.headers || {})
            },
            ...options
        });
        this.lastUrl = response.finalUrl;
        this.lastHtml = response.text;
        return response;
    }
    isLoginPage(currentUrl = '', html = '') {
        const normalizedUrl = String(currentUrl || '');
        if (normalizedUrl.includes('oauth.um.ac.ir') || normalizedUrl.includes('/login/')) {
            return true;
        }

        const document = this.parseHtml(html);
        return Boolean(
            this.queryOne(document, 'input[name="UserID"]') ||
            this.queryOne(document, 'input[name="username"]') ||
            this.queryOne(document, '#page-login-index') ||
            this.queryOne(document, '.loginform') ||
            this.queryOne(document, 'form[action*="login"]')
        );
    }
    extractHiddenFields(formNode) {
        const fields = {};
        for (const input of this.queryAll(formNode, 'input[type="hidden"]')) {
            const name = this.nodeAttr(input, 'name');
            if (!name) continue;
            fields[name] = this.nodeAttr(input, 'value');
        }
        return fields;
    }
    extractFormFields(formNode) {
        const fields = {};
        for (const input of this.queryAll(formNode, 'input[name]')) {
            const name = this.nodeAttr(input, 'name');
            if (!name) continue;

            const type = this.nodeAttr(input, 'type').toLowerCase();
            if (['button', 'file', 'image', 'reset', 'submit'].includes(type)) {
                continue;
            }
            if ((type === 'checkbox' || type === 'radio') && !this.nodeAttr(input, 'checked')) {
                continue;
            }

            fields[name] = this.nodeAttr(input, 'value');
        }
        return fields;
    }
    findOAuthLoginForm(document) {
        const userIdInput = this.queryOne(document, 'input[name="UserID"]');
        return (
            this.queryOne(document, 'form[name="LoginForm"]') ||
            this.queryOne(document, 'form.login-form') ||
            this.closestAncestor(userIdInput, 'form')
        );
    }
    closestAncestor(node, tagName) {
        const target = String(tagName || '').toLowerCase();
        let current = node;
        while (current) {
            if (String(current.name || '').toLowerCase() === target) {
                return current;
            }
            current = current.parent;
        }
        return null;
    }
    buildCredentialPayload(formNode, usernameNames = ['username', 'UserID'], passwordNames = ['password']) {
        const payload = this.extractFormFields(formNode);
        const inputNames = this.queryAll(formNode, 'input[name]').map(input => this.nodeAttr(input, 'name')).filter(Boolean);

        const usernameName =
            usernameNames.find(name => inputNames.includes(name)) ||
            inputNames.find(name => /^(user(id|name)?|login)$/i.test(name)) ||
            usernameNames[0];
        const passwordName =
            passwordNames.find(name => inputNames.includes(name)) ||
            inputNames.find(name => /pass(word)?/i.test(name)) ||
            passwordNames[0];

        payload[usernameName] = CONFIG.vu.username;
        payload[passwordName] = CONFIG.vu.password;
        return payload;
    }
    formActionUrl(formNode, pageUrl) {
        const action = this.nodeAttr(formNode, 'action');
        return action ? this.absoluteUrl(action, pageUrl) : pageUrl;
    }
    urlOrigin(url) {
        try {
            return new URL(url).origin;
        } catch (error) {
            return '';
        }
    }
    assertVuCredentialsConfigured() {
        if (!CONFIG.vu.username || !CONFIG.vu.password) {
            throw new Error('VU credentials are not configured. Set VU_USERNAME and VU_PASSWORD in .env.');
        }
    }
    encodeForm(data) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(data || {})) {
            params.append(key, value === undefined || value === null ? '' : String(value));
        }
        return params.toString();
    }
    async tryDirectMoodleLogin() {
        this.assertVuCredentialsConfigured();
        const loginPage = await this.fetchHtmlPage('https://vu.um.ac.ir/login/index.php');
        const document = this.parseHtml(loginPage.text);
        const form = this.queryOne(document, 'form#login, form.login-form[action*="/login/index.php"]');
        if (!form) {
            return false;
        }

        const payload = this.buildCredentialPayload(form, ['username'], ['password']);

        const actionUrl = this.formActionUrl(form, loginPage.finalUrl);
        const result = await this.fetchHtmlPage(actionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: this.urlOrigin(actionUrl)
            },
            body: this.encodeForm(payload),
            referer: loginPage.finalUrl
        });

        return !this.isLoginPage(result.finalUrl, result.text) && result.finalUrl.includes('vu.um.ac.ir');
    }
    async tryOAuthLogin() {
        this.assertVuCredentialsConfigured();
        const loginPage = await this.fetchHtmlPage('https://vu.um.ac.ir/login/index.php');
        const document = this.parseHtml(loginPage.text);
        let oauthPage = loginPage;
        let oauthDocument = document;
        let form = this.findOAuthLoginForm(oauthDocument);

        if (!form) {
            const oauthLink = this.queryOne(document, '.login-identityprovider-btn[href], a[href*="/auth/oauth2/login.php"], a[href*="oauth"]');
            if (!oauthLink) {
                return !this.isLoginPage(loginPage.finalUrl, loginPage.text);
            }

            const oauthUrl = this.absoluteUrl(this.nodeAttr(oauthLink, 'href'), loginPage.finalUrl);
            oauthPage = await this.fetchHtmlPage(oauthUrl, { referer: loginPage.finalUrl });
            oauthDocument = this.parseHtml(oauthPage.text);
            form = this.findOAuthLoginForm(oauthDocument);
        }

        if (!form) {
            return !this.isLoginPage(oauthPage.finalUrl, oauthPage.text);
        }

        const payload = this.buildCredentialPayload(form, ['UserID', 'username'], ['password']);

        const actionUrl = this.formActionUrl(form, oauthPage.finalUrl);
        const result = await this.fetchHtmlPage(actionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: this.urlOrigin(actionUrl)
            },
            body: this.encodeForm(payload),
            referer: oauthPage.finalUrl
        });

        return !this.isLoginPage(result.finalUrl, result.text) && result.finalUrl.includes('vu.um.ac.ir');
    }
    async ensureLoggedIn(force = false) {
        if (!force && this.cookieJar.length > 0 && CONFIG.vu.courseUrls[0]) {
            try {
                const probe = await this.fetchHtmlPage(CONFIG.vu.courseUrls[0], { timeout: 30000 });
                if (!this.isLoginPage(probe.finalUrl, probe.text)) {
                    return true;
                }
            } catch (error) {
                console.log('⚠️ Session probe failed:', error.message);
            }
        }

        await this.login();
        return true;
    }
    async loadData() {
        try {
            const data = await fs.readFile(DATA_FILE, 'utf8');
            this.courseData = JSON.parse(data);
            this.isFirstRun = false;
            console.log('📂 Loaded existing course data');
        } catch (error) {
            console.log('📂 No existing data found, starting fresh (first run)');
            this.courseData = {};
            this.isFirstRun = true;
        }
        
        try {
            const msgData = await fs.readFile('message_ids.json', 'utf8');
            this.courseMessageIds = JSON.parse(msgData);
            console.log('📬 Loaded message IDs');
        } catch (error) {
            console.log('📬 No message IDs found');
            this.courseMessageIds = {};
        }
        try {
            const deadlineMsgData = await fs.readFile('deadline_message_id.json', 'utf8');
            const parsed = JSON.parse(deadlineMsgData);
            this.deadlineMessageIds = {};
            this.deadlineMessageHistoryIds = {};

            if (parsed && typeof parsed === 'object') {
                if (parsed.messageIds && typeof parsed.messageIds === 'object' && !Array.isArray(parsed.messageIds)) {
                    for (const [chatId, messageId] of Object.entries(parsed.messageIds)) {
                        const normalizedId = this.normalizeMessageId(messageId);
                        if (normalizedId !== null) {
                            this.deadlineMessageIds[String(chatId)] = normalizedId;
                        }
                    }
                } else if (parsed.messageId !== undefined) {
                    // Backward compatibility with old single-message storage format.
                    const normalizedId = this.normalizeMessageId(parsed.messageId);
                    const platformConfig = this.getPlatformConfig(DEFAULT_PLATFORM);
                    if (normalizedId !== null && platformConfig?.globalChatId) {
                        this.deadlineMessageIds[this.getStorageKey({
                            platform: DEFAULT_PLATFORM,
                            chatId: platformConfig.globalChatId
                        })] = normalizedId;
                    }
                } else {
                    // Backward compatibility in case IDs were stored as a direct chatId -> messageId map.
                    for (const [chatId, messageId] of Object.entries(parsed)) {
                        const normalizedId = this.normalizeMessageId(messageId);
                        if (normalizedId !== null) {
                            this.deadlineMessageIds[String(chatId)] = normalizedId;
                        }
                    }
                }

                if (parsed.historyIds && typeof parsed.historyIds === 'object' && !Array.isArray(parsed.historyIds)) {
                    for (const [chatId, ids] of Object.entries(parsed.historyIds)) {
                        if (Array.isArray(ids)) {
                            this.setDeadlineMessageHistory(chatId, ids);
                        }
                    }
                }
            }

            console.log('⏰ Loaded deadline message ID(s)');
        } catch (error) {
            console.log('⏰ No deadline message IDs found');
            this.deadlineMessageIds = {};
            this.deadlineMessageHistoryIds = {};
        }
        
        try {
            const reminderData = await fs.readFile('reminders.json', 'utf8');
            this.sentReminders = JSON.parse(reminderData);
            console.log('⏰ Loaded reminder history');
        } catch (error) {
            console.log('⏰ No reminder history found');
            this.sentReminders = {};
        }
        
        try {
            const lastDayData = await fs.readFile('last_day_reminders.json', 'utf8');
            this.sentLastDayReminders = JSON.parse(lastDayData);
            console.log('📅 Loaded last day reminder history');
        } catch (error) {
            console.log('📅 No last day reminder history found');
            this.sentLastDayReminders = {};
        }
        this.cleanExpiredReminders();
    }
    async saveData() {
        this.cleanExpiredReminders();
        await fs.writeFile(DATA_FILE, JSON.stringify(this.courseData, null, 2));
        await fs.writeFile('message_ids.json', JSON.stringify(this.courseMessageIds, null, 2));
        await fs.writeFile('reminders.json', JSON.stringify(this.sentReminders, null, 2));
        await fs.writeFile('last_day_reminders.json', JSON.stringify(this.sentLastDayReminders, null, 2));
        await fs.writeFile('deadline_message_id.json', JSON.stringify({
            messageIds: this.deadlineMessageIds,
            historyIds: this.deadlineMessageHistoryIds
        }, null, 2));
    }
    async login() {
        console.log('🔐 Logging in...');

        const maxRetries = 3;
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                this.resetSession();

                console.log('🔐 Trying direct Moodle login...');
                if (await this.tryDirectMoodleLogin()) {
                    console.log('✅ Login successful');
                    return;
                }

                console.log('🔐 Direct login did not complete, trying OAuth2 login...');
                if (await this.tryOAuthLogin()) {
                    console.log('✅ OAuth2 login successful');
                    return;
                }

                throw new Error(`Login failed - final URL: ${this.lastUrl || 'unknown'}`);
            } catch (error) {
                retryCount++;
                console.error(`❌ Login attempt ${retryCount} failed:`, error.message);

                if (retryCount < maxRetries) {
                    console.log(`🔄 Retrying login (${retryCount}/${maxRetries})...`);
                    this.resetSession();
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    throw new Error(`Login failed after ${maxRetries} attempts: ${error.message}`);
                }
            }
        }
    }
    async waitForTelegramResponse() {
        console.log('⏳ Waiting for captcha code from Telegram...');
        const adminPlatform = CONFIG.activePlatforms.find(platform => {
            const platformConfig = this.getPlatformConfig(platform);
            return platformConfig?.token && platformConfig?.adminChatId;
        }) || DEFAULT_PLATFORM;
        const adminConfig = this.getPlatformConfig(adminPlatform);
        
        return new Promise((resolve) => {
            const checkUpdates = async () => {
                try {
                    const updates = await getBot(adminPlatform).getUpdates({
                        offset: -1,
                        limit: 1,
                        timeout: 0
                    });
                    if (updates.length > 0) {
                        const update = updates[0];
                        const message = update.message;
                        
                        if (message &&
                            message.chat.id.toString() === adminConfig.adminChatId &&
                            message.text &&
                            (Date.now() / 1000 - message.date) < 30) {
                            
                            await getBot(adminPlatform).sendMessage(adminConfig.adminChatId, '✅ کد دریافت شد, در حال ورود...');
                            resolve(message.text.trim());
                            return;
                        }
                    }
                } catch (error) {
                    console.error('Error checking Telegram updates:', error.message);
                }
                
                setTimeout(checkUpdates, 2000);
            };
            
            checkUpdates();
        });
    }
    async checkCourse(courseUrl) {
        console.log(`📚 Checking course: ${courseUrl}`);

        let coursePage;
        try {
            coursePage = await this.fetchHtmlPage(courseUrl, { timeout: 90000 });
            console.log(`📍 Navigated to: ${coursePage.finalUrl}`);
        } catch (error) {
            console.error(`❌ Failed to fetch course page: ${error.message}`);
            throw error;
        }

        if (this.isLoginPage(coursePage.finalUrl, coursePage.text)) {
            console.log('🔐 Login required detected while opening course. Attempting to login and retry once...');
            await this.login();
            coursePage = await this.fetchHtmlPage(courseUrl, { timeout: 90000 });
        }

        const document = this.parseHtml(coursePage.text);
        const courseName =
            this.nodeText(this.queryOne(document, '.breadcrumb li:last-child')) ||
            this.nodeText(this.queryOne(document, '.page-header-headings h1')) ||
            'Unknown Course';
        console.log(`📖 Course: ${courseName}`);

        const courseId = new URL(courseUrl).searchParams.get('id');
        if (!this.courseData[courseId]) {
            this.courseData[courseId] = {
                name: courseName,
                url: courseUrl,
                sections: {},
                assignments: {},
                sentFiles: {},
                sentNotifications: {},
                lastChecked: null
            };
        }
        
        if (!this.courseData[courseId].sentFiles) {
            this.courseData[courseId].sentFiles = {};
        }
        
        if (!this.courseData[courseId].sentNotifications) {
            this.courseData[courseId].sentNotifications = {};
        }

        const sections = this.extractSections(coursePage.text, coursePage.finalUrl);
        
        try {
            if (!this.courseData[courseId].assignments) {
                this.courseData[courseId].assignments = {};
            }
            for (const [secName, activities] of Object.entries(sections)) {
                for (const activity of activities) {
                    const url = activity.url;
                    const type = activity.type;
                    if (!url) continue;
                    if (type === 'assign' || type === 'mod_assign') {
                        const stored = this.courseData[courseId].assignments[url];
                        const needsFetch = !stored || !stored.deadline || stored.deadline === 'نامشخص' || !stored.opened || stored.opened === 'نامشخص';
                        if (needsFetch) {
                            try {
                                const details = await this.extractAssignmentDetails(url);
                                if (details && details.success !== false) {
                                    this.courseData[courseId].assignments[url] = details;
                                    await this.saveData();
                                } else {
                                    console.log(`⚠️ Skipping storing details for ${url} due to fetch failure`);
                                }
                                await new Promise(r => setTimeout(r, 500));
                            } catch (e) {
                                console.error('Error fetching assignment details for', url, e.message);
                            }
                        }
                    }
                    if (type === 'quiz' || type === 'mod_quiz') {
                        const stored = this.courseData[courseId].assignments[url];
                        const needsFetch = !stored || !stored.opened || stored.opened === 'نامشخص' || !stored.closed || stored.closed === 'نامشخص';
                        if (needsFetch) {
                            try {
                                const details = await this.extractQuizDetails(url);
                                if (details && details.success !== false) {
                                    if ((!details.opened || details.opened === 'نامشخص') && activity.opened) {
                                        details.opened = activity.opened;
                                    }
                                    this.courseData[courseId].assignments[url] = details;
                                    await this.saveData();
                                } else {
                                    console.log(`⚠️ Skipping storing quiz details for ${url} due to fetch failure`);
                                }
                                await new Promise(r => setTimeout(r, 500));
                            } catch (e) {
                                console.error('Error fetching quiz details for', url, e.message);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Error ensuring stored assignment/quiz details:', err.message);
        }
        
        const changes = this.detectChanges(courseId, sections);
        
        if (changes.updatedItems.length > 0) {
            await this.checkForUpdates(courseId, courseName, changes.updatedItems);
        }
        
        await this.sendOrUpdateCourseOverview(courseId, courseName, courseUrl, sections);
        
        if (changes.hasChanges) {
            await this.notifyNewActivities(courseId, courseName, changes);
        }
        this.courseData[courseId].sections = sections;
        this.courseData[courseId].lastChecked = new Date().toISOString();
        this.pruneExpired(courseId);
        await this.saveData();
        return changes;
    }
    extractSections(html, currentUrl) {
        const sections = {};
        try {
            if (this.isLoginPage(currentUrl, html)) {
                console.log('🔐 Page appears to be a login page — aborting extraction');
                return sections;
            }

            const document = this.parseHtml(html);
            let sectionElements = this.queryAll(document, 'li.section.course-section[data-for="section"]');
            if (sectionElements.length === 0) {
                sectionElements = this.queryAll(document, 'ul.topics > li.section');
            }
            if (sectionElements.length === 0) {
                sectionElements = this.queryAll(document, 'ul.weeks > li.section');
            }
            if (sectionElements.length === 0) {
                sectionElements = this.queryAll(document, 'li.section');
            }

            sectionElements.forEach((section, index) => {
                const sectionName =
                    this.nodeText(this.queryOne(section, 'h3.sectionname[data-for="section_title"]')) ||
                    this.nodeText(this.queryOne(section, 'h3[class*="sectionname"]')) ||
                    this.nodeText(this.queryOne(section, '.sectionname')) ||
                    this.nodeText(this.queryOne(section, 'h3')) ||
                    `بخش ${index}`;

                let activityElements = this.queryAll(section, 'ul[data-for="cmlist"] li.activity[data-for="cmitem"]');
                if (activityElements.length === 0) {
                    activityElements = this.queryAll(section, 'li.activity.activity-wrapper');
                }
                if (activityElements.length === 0) {
                    activityElements = this.queryAll(section, 'li.activity');
                }
                if (activityElements.length === 0) {
                    activityElements = this.queryAll(section, 'li[class*="modtype_"], li[class*="modtype-"]');
                }

                const activities = [];
                for (const activity of activityElements) {
                    const activityItem = this.queryOne(activity, '.activity-item[data-activityname]');
                    const activityName =
                        this.nodeAttr(activityItem, 'data-activityname') ||
                        this.nodeText(this.queryOne(activity, '.instancename')) ||
                        this.nodeText(this.queryOne(activity, '.activityname a span')) ||
                        this.nodeText(this.queryOne(activity, '.activityname'));

                    const className = this.nodeAttr(activity, 'class');
                    const activityType =
                        className.match(/modtype_(\w+)/)?.[1] ||
                        className.match(/modtype-(\w+)/)?.[1] ||
                        'unknown';

                    const activityLink =
                        this.queryOne(activity, 'a.aalink.stretched-link[href]') ||
                        this.queryOne(activity, 'a.aalink[href]') ||
                        this.queryOne(activity, 'a[href*="/mod/"]') ||
                        this.queryOne(activity, '.activityname a[href]');
                    const activityHref = this.nodeAttr(activityLink, 'href');
                    const activityUrl =
                        (activityHref ? this.absoluteUrl(activityHref, currentUrl) : '') ||
                        this.buildActivityUrlFromModuleId(activity, activityType, currentUrl);
                    const opened = this.extractActivityStartDate(activity);

                    if (activityName && activityUrl) {
                        const activityData = {
                            name: activityName,
                            type: activityType,
                            url: activityUrl
                        };
                        if (opened) {
                            activityData.opened = opened;
                        }
                        activities.push(activityData);
                    }
                }

                if (activities.length > 0) {
                    sections[sectionName] = activities;
                }
            });

            return sections;
        } catch (error) {
            console.error('Error extracting sections:', error.message);
            return sections;
        }
    }
    async extractQuizDetails(quizUrl) {
        try {
            const page = await this.fetchHtmlPage(quizUrl, { timeout: 60000 });
            if (this.isLoginPage(page.finalUrl, page.text)) {
                throw new Error('LOGIN_REQUIRED');
            }

            const document = this.parseHtml(page.text);
            let opened = 'نامشخص';
            let closed = 'نامشخص';

            for (const div of this.queryAll(document, '[data-region="activity-dates"] .description-inner > div')) {
                const text = this.nodeText(div);
                let match = text.match(/(?:باز شده:|Opened:)\s*(.+)/);
                if (match) {
                    opened = match[1].trim();
                }
                match = text.match(/(?:بسته شده:|Closed:)\s*(.+)/);
                if (match) {
                    closed = match[1].trim();
                }
            }

            const details = { opened, closed };
            return { success: true, ...details };
        } catch (error) {
            console.error('Error extracting quiz details:', error.message);
            return { success: false, error: error.message };
        }
    }
    async extractResourceFileUrl(resourceUrl) {
        try {
            const result = await this.followRedirectsForFileUrl(resourceUrl);
            if (result && result.url) {
                return result;
            }

            const page = await this.fetchHtmlPage(resourceUrl, { timeout: 60000 });
            const currentUrl = page.finalUrl;
            if (currentUrl.includes('pluginfile.php')) {
                const fileName = this.cleanText(decodeURIComponent(currentUrl.split('/').pop().split('?')[0]));
                return { url: currentUrl, fileName };
            }

            const document = this.parseHtml(page.text);
            const resourceLink =
                this.queryOne(document, '.resourceworkaround a[href*="pluginfile.php"]') ||
                this.queryOne(document, '.resourcecontent a[href*="pluginfile.php"]') ||
                this.queryOne(document, 'a[href*="pluginfile.php"]');

            if (resourceLink) {
                const url = this.absoluteUrl(this.nodeAttr(resourceLink, 'href'), currentUrl);
                const fileName = this.nodeText(resourceLink) || this.cleanText(decodeURIComponent(url.split('/').pop().split('?')[0]));
                return { url, fileName };
            }

            const objectTag = this.queryOne(document, 'object[data*="pluginfile.php"]');
            if (objectTag) {
                const url = this.absoluteUrl(this.nodeAttr(objectTag, 'data'), currentUrl);
                const fileName = this.cleanText(decodeURIComponent(url.split('/').pop().split('?')[0]));
                return { url, fileName };
            }

            const iframeTag = this.queryOne(document, 'iframe[src*="pluginfile.php"]');
            if (iframeTag) {
                const url = this.absoluteUrl(this.nodeAttr(iframeTag, 'src'), currentUrl);
                const fileName = this.cleanText(decodeURIComponent(url.split('/').pop().split('?')[0]));
                return { url, fileName };
            }

            return null;
        } catch (error) {
            console.error('Error extracting resource file URL:', error.message);
            return null;
        }
    }
    
    async followRedirectsForFileUrl(startUrl, redirectsLeft = 10) {
        if (redirectsLeft < 0) {
            return null;
        }

        try {
            const response = await this.request(startUrl, {
                method: 'GET',
                headers: { Accept: '*/*' },
                followRedirects: false,
                timeout: 30000
            });

            const statusCode = response.statusCode || 0;
            const headers = response.headers || {};

            if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                const redirectUrl = this.absoluteUrl(headers.location, startUrl);
                console.log(`↪️ Redirect ${statusCode}: ${redirectUrl}`);
                return await this.followRedirectsForFileUrl(redirectUrl, redirectsLeft - 1);
            }

            if (statusCode >= 200 && statusCode < 300) {
                const contentType = String(headers['content-type'] || '');
                const contentDisposition = String(headers['content-disposition'] || '');

                if (!contentType.includes('text/html')) {
                    let fileName = this.cleanText(decodeURIComponent(startUrl.split('/').pop().split('?')[0]));
                    const filenameMatch = contentDisposition.match(/filename[*]?=['"]?(?:UTF-8'')?([^'";]+)/i);
                    if (filenameMatch) {
                        fileName = this.cleanText(decodeURIComponent(filenameMatch[1].trim()));
                    }

                    console.log(`✅ Found file: ${fileName} (${contentType})`);
                    return {
                        url: response.finalUrl,
                        fileName,
                        contentType,
                        buffer: response.buffer
                    };
                }

                console.log(`⚠️ Got HTML response (first 200 chars): ${response.text.substring(0, 200)}`);
                return null;
            }

            console.log(`⚠️ Unexpected status ${statusCode} for ${startUrl}`);
            return null;
        } catch (error) {
            console.log(`⚠️ Request error: ${error.message}`);
            return null;
        }
    }
    async extractAssignmentDetails(assignmentUrl) {
        try {
            const page = await this.fetchHtmlPage(assignmentUrl, { timeout: 60000 });
            if (this.isLoginPage(page.finalUrl, page.text)) {
                throw new Error('LOGIN_REQUIRED');
            }

            const document = this.parseHtml(page.text);
            let opened = 'نامشخص';
            let deadline = 'نامشخص';
            const attachments = [];

            for (const div of this.queryAll(document, '[data-region="activity-dates"] .description-inner > div')) {
                const text = this.nodeText(div);
                let match = text.match(/(?:باز شده:|Opened:)\s*(.+)/);
                if (match) {
                    opened = match[1].trim();
                }
                match = text.match(/(?:مهلت:|Due:)\s*(.+)/);
                if (match) {
                    deadline = match[1].trim();
                }
            }

            const introSection =
                this.queryOne(document, '.activity-description#intro') ||
                this.queryOne(document, 'div.activity-description') ||
                this.queryOne(document, '#intro');

            if (introSection) {
                for (const link of this.queryAll(introSection, 'a[href*="pluginfile.php"]')) {
                    const url = this.absoluteUrl(this.nodeAttr(link, 'href'), page.finalUrl);
                    let fileName = this.nodeText(link);
                    if (!fileName) {
                        fileName = this.cleanText(decodeURIComponent(url.split('/').pop().split('?')[0]));
                    }
                    fileName = this.cleanText(fileName);

                    const exists = attachments.find(item => item.url === url);
                    const isValidFile = url && fileName &&
                        !url.includes('/theme/image.php') &&
                        !url.includes('/core/') &&
                        fileName.length > 2;

                    if (isValidFile && !exists) {
                        attachments.push({ url, fileName });
                    }
                }
            }

            if (deadline === 'نامشخص') {
                for (const row of this.queryAll(document, '.submissionstatustable tr, .generaltable tr')) {
                    const cells = this.queryAll(row, 'td, th');
                    for (let i = 0; i < cells.length - 1; i++) {
                        const cellText = this.nodeText(cells[i]);
                        if (
                            cellText.includes('مهلت') ||
                            cellText.includes('Due date') ||
                            cellText.includes('تاریخ') ||
                            cellText.toLowerCase().includes('deadline')
                        ) {
                            deadline = this.nodeText(cells[i + 1]) || deadline;
                            break;
                        }
                    }
                    if (deadline !== 'نامشخص') {
                        break;
                    }
                }
            }

            const details = { opened, deadline, attachments };
            return { success: true, ...details };
        } catch (error) {
            console.error('Error extracting assignment details:', error.message);
            return { success: false, error: error.message };
        }
    }
    async downloadAndSendFile(fileUrl, fileName, courseId) {
        try {
            if (this.courseData[courseId].sentFiles[fileUrl]) {
                console.log(`📎 File already sent: ${fileName}`);
                return false;
            }
            console.log(`📥 Downloading file: ${fileName}`);

            const { buffer, contentType, statusCode } = await this.downloadWithSessionCookies(fileUrl);
            console.log(`📄 Content-Type: ${contentType}`);
            console.log(`📡 Response status: ${statusCode}`);
            
            if (contentType.includes('text/html')) {
                const bodyText = buffer.toString('utf8').substring(0, 500);
                console.log(`⚠️ Received HTML instead of file: ${bodyText.substring(0, 200)}...`);
                throw new Error('Received HTML page instead of file - session may have expired');
            }
            
            if (buffer.length < 100) {
                throw new Error('Downloaded content too small - likely an error');
            }
            
            console.log(`✅ Downloaded file size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
            
            const normalizeDuplicateExtension = (name) => {
                let n = this.cleanText(name || '');
                n = n.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '');
                n = n.replace(/\s*\.\s*/g, '.').replace(/\.+/g, '.');
                n = n.replace(/[\s\.]+$/g, '').replace(/^\s+/g, '');
                n = n.replace(/[<>:"/\\|?*]/g, '_');
                const parts = n.split('.');
                if (parts.length <= 2) return n;
                const ext = parts[parts.length - 1].toLowerCase();
                const commonExts = new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','jpg','jpeg','png','txt','zip','rar']);
                const target = commonExts.has(ext) ? ext : ext;
                let i = parts.length - 2;
                while (i >= 1) {
                    const p = parts[i].toLowerCase();
                    if (p === target) {
                        parts.splice(i, 1);
                    }
                    i--;
                }
                return parts.join('.');
            };
            fileName = normalizeDuplicateExtension(fileName);

            console.log(`📤 Sending file to Telegram: ${fileName} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
            
            const sendOptions = {
                caption: `📎 ${fileName}`
            };
            
            if (buffer.length > 5 * 1024 * 1024) {
                console.log(`⚠️ File too large (${(buffer.length / 1024 / 1024).toFixed(2)} MB), sending link only`);
                await this.sendTelegramMessage(`📎 فایل خیلی بزرگ است (${(buffer.length / 1024 / 1024).toFixed(2)} MB)\n${fileName}\n🔗 ${fileUrl}`, {
                    chatIds: this.getCourseTargetChatIds(courseId)
                });
            } else {
                const targetChatIds = this.getCourseTargetChatIds(courseId);
                for (const target of targetChatIds) {
                    await this.sendDocumentViaApi({
                        platform: target.platform,
                        chatId: target.chatId,
                        buffer,
                        fileName,
                        caption: sendOptions.caption,
                        contentType
                    });
                }
            }
            
            this.courseData[courseId].sentFiles[fileUrl] = {
                sent: true,
                fileName: fileName,
                sentAt: new Date().toISOString()
            };
            
            await this.saveData();
            
            console.log(`✅ File sent: ${fileName}`);
            return true;
        } catch (error) {
            console.error(`❌ Error downloading/sending file ${fileName}:`, error.message);
            
            try {
                await this.sendTelegramMessage(`⚠️ خطا در دانلود فایل\n📎 ${fileName}\n🔗 ${fileUrl}`, {
                    chatIds: this.getCourseTargetChatIds(courseId)
                });
            } catch (telegramError) {
                console.error('Failed to send error message:', telegramError.message);
            }
            
            return false;
        }
    }
    async downloadWithSessionCookies(fileUrl, redirectsLeft = 5) {
        if (redirectsLeft < 0) {
            throw new Error('Too many redirects while downloading file');
        }

        const response = await this.request(fileUrl, {
            method: 'GET',
            headers: {
                Accept: '*/*',
                'Accept-Encoding': 'identity',
                Connection: 'keep-alive'
            },
            followRedirects: true,
            timeout: 120000
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Download failed with status ${response.statusCode}`);
        }

        return {
            buffer: response.buffer,
            contentType: String(response.headers['content-type'] || ''),
            statusCode: response.statusCode
        };
    }
    async sendDocumentViaApi({ chatId, platform = DEFAULT_PLATFORM, buffer, fileName, caption, contentType, parseMode = 'Markdown' }) {
        const target = this.normalizeChatTarget({ platform, chatId });
        if (!target) {
            throw new Error('No valid chat ID provided for sendDocument');
        }
        const platformConfig = this.getPlatformConfig(target.platform);
        if (!platformConfig?.token) {
            throw new Error(`${PLATFORM_LABELS[target.platform] || target.platform} bot token is not configured`);
        }
        const boundary = `----NodeBoundary${Date.now().toString(16)}`;
        const safeFileName = (fileName || 'file.bin').replace(/\"/g, '');
        const mimeType = contentType || 'application/octet-stream';

        const fields = [
            { name: 'chat_id', value: String(target.chatId) },
            { name: 'caption', value: caption || '' },
            { name: 'parse_mode', value: parseMode }
        ];

        if (platformConfig.topicId && String(target.chatId) === String(platformConfig.globalChatId)) {
            fields.push({ name: 'message_thread_id', value: String(platformConfig.topicId) });
        }

        const chunks = [];
        for (const field of fields) {
            chunks.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
                `${field.value}\r\n`
            ));
        }

        chunks.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="document"; filename="${safeFileName}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
        ));
        chunks.push(buffer);
        chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const body = Buffer.concat(chunks);
        const endpoint = new URL(`${platformConfig.apiBaseUrl}/bot${platformConfig.token}/sendDocument`);
        const client = endpoint.protocol === 'https:' ? https : http;
        const requestOptions = createRequestOptions(platformConfig);

        return await new Promise((resolve, reject) => {
            const req = client.request(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                },
                ...(requestOptions?.agent ? { agent: requestOptions.agent } : {}),
                timeout: 120000
            }, (res) => {
                const responseChunks = [];
                res.on('data', (chunk) => responseChunks.push(chunk));
                res.on('end', () => {
                    const statusCode = res.statusCode || 0;
                    const responseText = Buffer.concat(responseChunks).toString('utf8');

                    if (statusCode < 200 || statusCode >= 300) {
                        reject(new Error(`sendDocument failed with status ${statusCode}: ${responseText}`));
                        return;
                    }

                    try {
                        const data = JSON.parse(responseText);
                        if (data && data.ok) {
                            resolve(data);
                            return;
                        }
                        reject(new Error(`sendDocument API error: ${responseText}`));
                    } catch (parseError) {
                        reject(new Error(`sendDocument parse error: ${responseText}`));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error('sendDocument timeout'));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    detectChanges(courseId, newSections) {
        const oldSections = this.courseData[courseId]?.sections || {};
        const oldAssignments = this.courseData[courseId]?.assignments || {};
        const changes = {
            hasChanges: false,
            newItems: [],
            updatedItems: []
        };
        for (const [sectionName, activities] of Object.entries(newSections)) {
            const oldActivities = oldSections[sectionName] || [];
            
            for (const activity of activities) {
                const exists = oldActivities.find(a =>
                    a.name === activity.name && a.url === activity.url
                );
                if (!exists) {
                    changes.hasChanges = true;
                    changes.newItems.push({
                        section: sectionName,
                        activity: activity
                    });
                } else {
                    const activityType = activity.type;
                    if (activityType === 'assign' || activityType === 'mod_assign' ||
                        activityType === 'quiz' || activityType === 'mod_quiz') {
                        const oldDetails = oldAssignments[activity.url];
                        if (oldDetails) {
                            changes.updatedItems.push({
                                section: sectionName,
                                activity: activity,
                                oldDetails: oldDetails
                            });
                        }
                    }
                }
            }
        }
        return changes;
    }
    // ─── Course overview: global chat only ───────────────────────────────────
    async sendOrUpdateCourseOverview(courseId, courseName, courseUrl, allSections) {
        let message = `🎓 <b>${courseName}</b>\n`;
        message += `🔗 <a href="${courseUrl}">لینک درس</a>\n\n`;
        
        let sectionsMsg = '';
        for (const [sectionName, activities] of Object.entries(allSections)) {
            let sectionMsg = `📂 <b>${sectionName}</b>\n`;
            let hasActivities = false;
            for (const activity of activities) {
                const isDeadlineBased = ['assign', 'mod_assign', 'quiz', 'mod_quiz'].includes(activity.type);
                if (isDeadlineBased && !this.courseData[courseId].assignments[activity.url]) {
                    continue;
                }
                const emoji = this.getEmoji(activity.type);
                sectionMsg += ` ${emoji} <a href="${activity.url}">${activity.name}</a>\n`;
                hasActivities = true;
            }
            if (hasActivities) {
                sectionsMsg += sectionMsg + '\n';
            }
        }
        message += sectionsMsg;
        
        if (sectionsMsg.trim() === '') {
            message += `📭 هنوز محتوایی اضافه نشده است.\n`;
        }
        
        message += `━━━━━━━━━━━━━━━━━\n`;
        message += `🕐 ${this.getLocalTimestamp()}`;

        const baseOptions = {
            disable_web_page_preview: true
        };

        // Send overview to global chats ONLY — not to per-course extra chats.
        const globalTargets = CONFIG.activePlatforms
            .map(platform => {
                const platformConfig = this.getPlatformConfig(platform);
                if (!platformConfig?.token || !platformConfig.globalChatId) return null;
                return { platform, chatId: String(platformConfig.globalChatId) };
            })
            .filter(Boolean);

        if (globalTargets.length === 0) {
            console.log(`⚠️ No global chat ID configured; skipping course overview for ${courseId}`);
            return;
        }

        for (const target of globalTargets) {
            const chatId = target.chatId;
            const platformBot = getBot(target.platform);
            const existingIds = this.getStoredCourseMessageIds(courseId, target);
            const finalIds = [];
            const formatted = this.formatForPlatform(message, target.platform);
            const messageParts = this.splitCourseOverviewMessage(formatted.text);
            const scopedOptions = this.getChatScopedOptions(
                { ...baseOptions, parse_mode: formatted.parse_mode },
                target
            );

            try {
                for (let i = 0; i < messageParts.length; i++) {
                    const part = messageParts[i];
                    const existingId = existingIds[i];

                    if (existingId) {
                        try {
                            await platformBot.editMessageText(part, {
                                chat_id: chatId,
                                message_id: existingId,
                                ...scopedOptions
                            });
                            finalIds.push(existingId);
                        } catch (editErr) {
                            if (editErr.message && editErr.message.includes('message to edit not found')) {
                                const sentMsg = await platformBot.sendMessage(chatId, part, scopedOptions);
                                finalIds.push(sentMsg.message_id);
                            } else {
                                throw editErr;
                            }
                        }
                    } else {
                        const sentMsg = await platformBot.sendMessage(chatId, part, scopedOptions);
                        finalIds.push(sentMsg.message_id);
                    }
                }

                // Delete any extra old parts if message got shorter
                for (const extraId of existingIds.slice(messageParts.length)) {
                    await this.deleteTelegramMessage(target, extraId);
                }

                this.setStoredCourseMessageIds(courseId, target, finalIds);
            } catch (error) {
                console.error(`Error sending/updating course overview for ${target.platform} chat ${chatId}:`, error.message);
                if (error.message.includes('message to edit not found')) {
                    const sentIds = [];
                    for (const part of messageParts) {
                        const sentMsg = await platformBot.sendMessage(chatId, part, scopedOptions);
                        sentIds.push(sentMsg.message_id);
                    }
                    for (const existingId of existingIds) {
                        await this.deleteTelegramMessage(target, existingId);
                    }
                    this.setStoredCourseMessageIds(courseId, target, sentIds);
                }
            }
        }

        console.log(`✏️ Updated overview message for course ${courseId} in ${messageParts.length} part(s)`);
    }
    // ─── Startup cleanup: delete any overview messages sent to non-global chats
    // and any previously sent per-course overview messages stored in message_ids.json
    async cleanupNonGlobalOverviewMessages() {
        const globalKeys = new Set(CONFIG.activePlatforms
            .map(platform => {
                const platformConfig = this.getPlatformConfig(platform);
                if (!platformConfig?.globalChatId) return null;
                return this.getStorageKey({ platform, chatId: platformConfig.globalChatId });
            })
            .filter(Boolean));
        let changed = false;

        for (const [courseId, stored] of Object.entries(this.courseMessageIds || {})) {
            if (!stored || Array.isArray(stored) || typeof stored !== 'object') {
                continue;
            }

            for (const [chatId, messageIds] of Object.entries(stored)) {
                // Keep global chat messages — delete everything else
                if (globalKeys.has(String(chatId))) {
                    continue;
                }

                if (Array.isArray(messageIds)) {
                    for (const messageId of messageIds) {
                        await this.deleteTelegramMessage(chatId, messageId);
                    }
                }

                delete this.courseMessageIds[courseId][chatId];
                changed = true;
                console.log(`🧹 Removed course overview messages for course ${courseId} from chat ${chatId}`);
            }
        }

        if (changed) {
            await fs.writeFile('message_ids.json', JSON.stringify(this.courseMessageIds, null, 2));
            console.log('✅ Cleaned non-global overview message IDs');
        }
    }
    async cleanupPerCourseDeadlineMessages() {
        const globalKeys = new Set(CONFIG.activePlatforms
            .map(platform => {
                const platformConfig = this.getPlatformConfig(platform);
                if (!platformConfig?.globalChatId) return null;
                return this.getStorageKey({ platform, chatId: platformConfig.globalChatId });
            })
            .filter(Boolean));

        const keysToRemove = Object.keys(this.deadlineMessageIds).filter(k => !globalKeys.has(k));
        if (keysToRemove.length === 0) return;

        for (const key of keysToRemove) {
            const messageId = this.deadlineMessageIds[key];
            const target = key.includes(':')
                ? { platform: key.split(':')[0], chatId: key.split(':').slice(1).join(':') }
                : { platform: 'bale', chatId: key };
            await this.deleteTelegramMessage(target, messageId);
            delete this.deadlineMessageIds[key];
            console.log(`🧹 Deleted per-course deadline message from ${target.platform} chat ${target.chatId}`);
        }

        await fs.writeFile('deadline_message_id.json', JSON.stringify({
            messageIds: this.deadlineMessageIds,
            historyIds: this.deadlineMessageHistoryIds
        }, null, 2));
        console.log('✅ Cleaned up per-course deadline messages');
    }
    splitCourseOverviewMessage(message) {
        const TELEGRAM_LIMIT = 3900;

        if (!message || message.length <= TELEGRAM_LIMIT) {
            return [message];
        }

        const midpoint = Math.floor(message.length / 2);
        let splitIndex = message.lastIndexOf('\n', midpoint);
        if (splitIndex < 0 || splitIndex < Math.floor(message.length * 0.25)) {
            splitIndex = midpoint;
        }

        const part1Body = message.slice(0, splitIndex).trim();
        const part2Body = message.slice(splitIndex).trim();

        const part1 = `📚 (1/2)\n${part1Body}`;
        const part2 = `📚 (2/2)\n${part2Body}`;

        if (part1.length > TELEGRAM_LIMIT || part2.length > TELEGRAM_LIMIT) {
            const hardSplit = Math.floor((message.length - 16) / 2);
            return [
                `📚 (1/2)\n${message.slice(0, hardSplit).trim()}`,
                `📚 (2/2)\n${message.slice(hardSplit).trim()}`
            ];
        }

        return [part1, part2];
    }
    buildDeadlineOverviewMessage(deadlines) {
        let message = '📃 <b>لیست رویداد ها</b>\n\n';

        if (deadlines.length === 0) {
            message += '✅ هیچ تکلیف یا آزمون فعالی وجود ندارد!\n\n';
        } else {
            const byCourse = {};
            for (const item of deadlines) {
                const bucketKey = item.courseId || item.courseName;
                if (!byCourse[bucketKey]) {
                    byCourse[bucketKey] = {
                        courseName: item.courseName,
                        items: []
                    };
                }
                byCourse[bucketKey].items.push(item);
            }

            for (const { courseName, items } of Object.values(byCourse)) {
                message += `📚 <b>${courseName}</b>\n\n`;
                for (const item of items) {
                    const isQuiz = item.isQuiz;
                    const emoji = item.eventType === 'opened' ? (isQuiz ? '🟢' : '🔓') : (isQuiz ? '❓' : '📝');
                    const label = item.eventType === 'opened' ? (isQuiz ? 'شروع آزمون' : 'باز شدن') : (isQuiz ? 'بسته می‌شود' : 'مهلت');
                    const googleCalendarUrl = this.buildGoogleCalendarButton(
                        courseName,
                        item.activityName,
                        item.url,
                        item.eventDateText
                    ).url;
                    message += `${emoji} <a href="${googleCalendarUrl}">${item.activityName}</a>\n`;
                    message += `${label}: ${item.dateInfo.formatted}\n`;
                    const days = item.dateInfo.daysRemaining;
                    if (days === null) {
                        message += `ℹ️ زمان نامشخص\n`;
                    } else if (days < 0) {
                        message += `❌ <b>گذشته</b>\n`;
                    } else if (days === 0) {
                        message += `🔴 <b>امروز</b>\n`;
                    } else if (days === 1) {
                        message += `⚠️ <b>1 روز باقی مانده</b>\n`;
                    } else if (days <= 3) {
                        message += `⚠️ ${days} روز دیگر\n`;
                    } else if (days <= 7) {
                        message += `🟡 ${days} روز دیگر\n`;
                    } else {
                        message += `✅ ${days} روز دیگر\n`;
                    }
                    message += '\n';
                }
                message += '━━━━━━━━━━━━━━━━━\n\n';
            }
        }

        message += `🕐 آخرین به‌روزرسانی: ${this.getLocalTimestamp()}`;
        return message;
    }
    async sendOrUpdateDeadlineOverview() {
        console.log('⏰ Updating deadline overview message...');
        
        const allDeadlines = [];
        const addedEvents = new Set();
        
        for (const [courseId, course] of Object.entries(this.courseData)) {
            const assignments = course.assignments || {};
            
            for (const [url, details] of Object.entries(assignments)) {
                let activityName = 'Unknown';
                let activityType = 'assign';
                
                for (const [sectionName, activities] of Object.entries(course.sections || {})) {
                    const activity = activities.find(a => a.url === url);
                    if (activity) {
                        activityName = activity.name;
                        activityType = activity.type;
                        break;
                    }
                }
                
                const isQuiz = activityType === 'quiz' || activityType === 'mod_quiz';
                const deadlineField = isQuiz ? 'closed' : 'deadline';
                if (details.opened && details.opened !== 'نامشخص') {
                    const openedInfo = this.formatPersianDate(details.opened);
                    if (openedInfo.daysRemaining !== null && openedInfo.daysRemaining > 0) {
                        addedEvents.add(`${courseId}|${url}|opened`);
                        allDeadlines.push({
                            courseId: String(courseId),
                            courseName: course.name,
                            activityName,
                            activityType,
                            url,
                            eventDateText: details.opened,
                            dateInfo: openedInfo,
                            isQuiz,
                            eventType: 'opened'
                        });
                    }
                }
                if (details[deadlineField] && details[deadlineField] !== 'نامشخص') {
                    const dateInfo = this.formatPersianDate(details[deadlineField]);
                    if (dateInfo.daysRemaining !== null && dateInfo.daysRemaining < 0) {
                        // skip expired
                    } else {
                        addedEvents.add(`${courseId}|${url}|deadline`);
                        allDeadlines.push({
                            courseId: String(courseId),
                            courseName: course.name,
                            activityName,
                            activityType,
                            url,
                            eventDateText: details[deadlineField],
                            dateInfo,
                            isQuiz,
                            eventType: 'deadline'
                        });
                    }
                }
            }

            for (const activities of Object.values(course.sections || {})) {
                for (const activity of activities) {
                    const activityType = activity.type;
                    const isQuiz = activityType === 'quiz' || activityType === 'mod_quiz';
                    if (!isQuiz || !activity.opened || activity.opened === 'نامشخص') continue;

                    const url = activity.url || `${course.url}#${activity.name}`;
                    const eventKey = `${courseId}|${url}|opened`;
                    if (addedEvents.has(eventKey)) continue;

                    const openedInfo = this.formatPersianDate(activity.opened);
                    if (openedInfo.daysRemaining === null || openedInfo.daysRemaining <= 0) continue;

                    addedEvents.add(eventKey);
                    allDeadlines.push({
                        courseId: String(courseId),
                        courseName: course.name,
                        activityName: activity.name,
                        activityType,
                        url,
                        eventDateText: activity.opened,
                        dateInfo: openedInfo,
                        isQuiz: true,
                        eventType: 'opened'
                    });
                }
            }
        }
        
        allDeadlines.sort((a, b) => {
            if (a.dateInfo.daysRemaining === null) return 1;
            if (b.dateInfo.daysRemaining === null) return -1;
            return a.dateInfo.daysRemaining - b.dateInfo.daysRemaining;
        });

        const targetChatIds = this.getDeadlineOverviewTargetChatIds();
        if (targetChatIds.length === 0) {
            console.log('⚠️ No chat IDs configured; skipping deadline overview');
            return;
        }

        const baseOptions = {
            disable_web_page_preview: true
        };
        const nextDeadlineMessageIds = {};

        for (const target of targetChatIds) {
            const key = this.getStorageKey(target);
            const chatId = target.chatId;
            const platformBot = getBot(target.platform);
            const platformConfig = this.getPlatformConfig(target.platform);
            const existingMessageId = this.normalizeMessageId(this.deadlineMessageIds[key]);
            const scopedOptions = this.getChatScopedOptions(
                { ...baseOptions, parse_mode: target.platform === 'telegram' ? 'HTML' : 'Markdown' },
                target
            );
            const isGlobalChat = platformConfig?.globalChatId
                && String(chatId) === String(platformConfig.globalChatId);
            let keepExistingIdOnFailure = existingMessageId !== null;

            let chatDeadlines = allDeadlines;
            if (!isGlobalChat) {
                const allowedCourseIds = this.getCourseIdsForChatId(chatId, target.platform);
                chatDeadlines = allowedCourseIds.size > 0
                    ? allDeadlines.filter(item => allowedCourseIds.has(String(item.courseId)))
                    : [];
            }
            const formattedMessage = this.formatForPlatform(
                this.buildDeadlineOverviewMessage(chatDeadlines),
                target.platform
            ).text;
            const recentMatchedIds = await this.findRecentDeadlineOverviewMessageIds(target, 100);
            const allCandidateIds = [
                ...this.getStoredDeadlineMessageCandidates(target),
                ...recentMatchedIds
            ];
            const uniqueCandidateIds = [];
            for (const rawId of allCandidateIds) {
                const messageId = this.normalizeMessageId(rawId);
                if (messageId !== null && !uniqueCandidateIds.includes(messageId)) {
                    uniqueCandidateIds.push(messageId);
                }
            }
            uniqueCandidateIds.sort((a, b) => b - a);
            const editTargetId = uniqueCandidateIds.length > 0 ? uniqueCandidateIds[0] : null;
            keepExistingIdOnFailure = keepExistingIdOnFailure || editTargetId !== null;

            try {
                if (editTargetId !== null) {
                    let activeMessageId = editTargetId;
                    let wasEdited = false;
                    try {
                        await platformBot.editMessageText(formattedMessage, {
                            chat_id: chatId,
                            message_id: activeMessageId,
                            ...scopedOptions
                        });
                        wasEdited = true;
                    } catch (editError) {
                        const editMessage = editError?.message || '';
                        const missingEditTarget = editMessage.includes('message to edit not found')
                            || editMessage.includes('message_id_invalid');

                        if (editMessage.includes('message is not modified')) {
                            wasEdited = true;
                        } else if (missingEditTarget) {
                            const fallbackCandidates = uniqueCandidateIds.slice(1);
                            for (const fallbackId of fallbackCandidates) {
                                try {
                                    await platformBot.editMessageText(formattedMessage, {
                                        chat_id: chatId,
                                        message_id: fallbackId,
                                        ...scopedOptions
                                    });
                                    activeMessageId = fallbackId;
                                    wasEdited = true;
                                    break;
                                } catch (fallbackError) {
                                    const fallbackMessage = fallbackError?.message || '';
                                    const fallbackMissing = fallbackMessage.includes('message to edit not found')
                                        || fallbackMessage.includes('message_id_invalid');
                                    if (fallbackMessage.includes('message is not modified')) {
                                        activeMessageId = fallbackId;
                                        wasEdited = true;
                                        break;
                                    }
                                    if (!fallbackMissing) {
                                        throw fallbackError;
                                    }
                                }
                            }
                        } else {
                            throw editError;
                        }
                    }

                    if (wasEdited) {
                        this.registerDeadlineMessageId(target, activeMessageId);
                        await this.cleanupDuplicateDeadlineOverviewMessages(target, activeMessageId, uniqueCandidateIds);
                        nextDeadlineMessageIds[key] = activeMessageId;
                        console.log(`Updated deadline overview message in ${target.platform} chat ${chatId}`);
                    } else {
                        console.log(`Could not find an editable deadline overview message in ${target.platform} chat ${chatId}; skipped re-send to avoid duplicates`);
                    }
                } else {
                    const sentMsg = await platformBot.sendMessage(chatId, formattedMessage, scopedOptions);
                    this.registerDeadlineMessageId(target, sentMsg.message_id);
                    nextDeadlineMessageIds[key] = sentMsg.message_id;
                    console.log(`Sent new deadline overview message in ${target.platform} chat ${chatId}`);
                }
            } catch (error) {
                console.error(`Error sending/updating deadline overview for ${target.platform} chat ${chatId}:`, error.message);
                if (keepExistingIdOnFailure && existingMessageId !== null) {
                    nextDeadlineMessageIds[key] = existingMessageId;
                }
            }
        }

        this.deadlineMessageIds = nextDeadlineMessageIds;
        for (const [key, messageId] of Object.entries(this.deadlineMessageIds)) {
            this.registerDeadlineMessageId(key, messageId);
        }
        await fs.writeFile('deadline_message_id.json', JSON.stringify({
            messageIds: this.deadlineMessageIds,
            historyIds: this.deadlineMessageHistoryIds
        }, null, 2));
    }
    async checkForUpdates(courseId, courseName, updatedItems) {
        for (const item of updatedItems) {
            try {
                const activityType = item.activity.type;
                let updateMessage = '';
                let hasUpdate = false;
                
                if (activityType === 'assign' || activityType === 'mod_assign') {
                    const newDetails = await this.extractAssignmentDetails(item.activity.url);
                    if (!newDetails || newDetails.success === false) {
                        console.log(`⚠️ Couldn't fetch assignment details for ${item.activity.name}, skipping update check`);
                        continue;
                    }
                    const oldDetails = item.oldDetails;
                    
                    let isExpired = false;
                    if (newDetails.deadline !== 'نامشخص') {
                        const newDeadlineInfo = this.formatPersianDate(newDetails.deadline);
                        if (newDeadlineInfo.daysRemaining !== null && newDeadlineInfo.daysRemaining < 0) {
                            isExpired = true;
                        }
                    }
                    if (isExpired) {
                        console.log(`⏭️ Skipping update for expired assignment: ${item.activity.name}`);
                        this.courseData[courseId].assignments[item.activity.url] = newDetails;
                        await this.saveData();
                        continue;
                    }
                    
                    const hasKnownDate = (value) => value && value !== 'نامشخص';
                    const openedChanged = hasKnownDate(newDetails.opened) && newDetails.opened !== oldDetails.opened;
                    let deadlineChanged = hasKnownDate(newDetails.deadline) && newDetails.deadline !== oldDetails.deadline;
                    let oldDeadlineInfo = null;
                    let newDeadlineInfo = null;
                    if (deadlineChanged) {
                        if (hasKnownDate(oldDetails.deadline)) {
                            oldDeadlineInfo = this.formatPersianDate(oldDetails.deadline);
                        }
                        if (hasKnownDate(newDetails.deadline)) {
                            newDeadlineInfo = this.formatPersianDate(newDetails.deadline);
                        }
                        if (oldDeadlineInfo && newDeadlineInfo &&
                            oldDeadlineInfo.daysRemaining !== null && newDeadlineInfo.daysRemaining !== null &&
                            oldDeadlineInfo.daysRemaining < 0 && newDeadlineInfo.daysRemaining < 0) {
                            deadlineChanged = false;
                        }
                    }
                    const dateChanged = openedChanged || deadlineChanged;
                    if (dateChanged) {
                        hasUpdate = true;
                        updateMessage = `🔄 <b>تغییر در تاریخ تمرین</b>\n\n`;
                        updateMessage += `📚 درس: ${courseName}\n`;
                        updateMessage += `📝 ${item.activity.name}\n\n`;
                        if (openedChanged) {
                            updateMessage += `📅 تاریخ باز شدن:\n`;
                            if (oldDetails.opened !== 'نامشخص') {
                                const oldOpenedInfo = this.formatPersianDate(oldDetails.opened);
                                updateMessage += ` قبلی: ${oldOpenedInfo.formatted}\n`;
                            }
                            if (newDetails.opened !== 'نامشخص') {
                                const newOpenedInfo = this.formatPersianDate(newDetails.opened);
                                updateMessage += ` جدید: ${newOpenedInfo.formatted}\n`;
                            }
                            updateMessage += `\n`;
                        }
                        if (deadlineChanged) {
                            updateMessage += `⏰ مهلت تحویل:\n`;
                            if (oldDetails.deadline !== 'نامشخص') {
                                if (!oldDeadlineInfo) oldDeadlineInfo = this.formatPersianDate(oldDetails.deadline);
                                updateMessage += ` قبلی: ${oldDeadlineInfo.formatted}\n`;
                            }
                            if (newDetails.deadline !== 'نامشخص') {
                                if (!newDeadlineInfo) newDeadlineInfo = this.formatPersianDate(newDetails.deadline);
                                updateMessage += ` جدید: ${newDeadlineInfo.formatted}\n`;
                                if (newDeadlineInfo.daysRemaining !== null) {
                                    if (newDeadlineInfo.daysRemaining < 0) {
                                        updateMessage += ` ❌ <b>مهلت گذشته است!</b> (${Math.abs(newDeadlineInfo.daysRemaining)} روز پیش)\n`;
                                    } else if (newDeadlineInfo.daysRemaining === 0) {
                                        updateMessage += ` 🔴 <b>امروز آخرین مهلت است!</b>\n`;
                                    } else if (newDeadlineInfo.daysRemaining === 1) {
                                        updateMessage += ` ⚠️ <b>فقط 1 روز باقی مانده</b>\n`;
                                    } else if (newDeadlineInfo.daysRemaining <= 3) {
                                        updateMessage += ` ⚠️ ${newDeadlineInfo.daysRemaining} روز دیگر\n`;
                                    } else {
                                        updateMessage += ` ✅ ${newDeadlineInfo.daysRemaining} روز دیگر\n`;
                                    }
                                }
                            }
                        }
                    }
                    
                    const oldAttachmentUrls = (oldDetails.attachments || []).map(a => a.url).sort();
                    const addedFiles = newDetails.attachments.filter(newAtt =>
                        !oldAttachmentUrls.includes(newAtt.url)
                    );
                    
                    if (hasUpdate) {
                        const googleCalendarButton = this.buildGoogleCalendarButton(
                            courseName,
                            item.activity.name,
                            item.activity.url,
                            newDetails.deadline
                        );
                        await this.sendTelegramMessage(updateMessage, {
                            chatIds: this.getCourseTargetChatIds(courseId),
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔗 مشاهده تمرین', url: item.activity.url }],
                                    [googleCalendarButton]
                                ]
                            }
                        });
                        
                        for (const att of addedFiles) {
                            await this.downloadAndSendFile(att.url, att.fileName, courseId);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                    
                    this.courseData[courseId].assignments[item.activity.url] = newDetails;
                    await this.saveData();
                } else if (activityType === 'quiz' || activityType === 'mod_quiz') {
                    const newDetails = await this.extractQuizDetails(item.activity.url);
                    if (!newDetails || newDetails.success === false) {
                        console.log(`⚠️ Couldn't fetch quiz details for ${item.activity.name}, skipping update check`);
                        continue;
                    }
                    const oldDetails = item.oldDetails;
                    
                    let isExpired = false;
                    if (newDetails.closed !== 'نامشخص') {
                        const newClosedInfo = this.formatPersianDate(newDetails.closed);
                        if (newClosedInfo.daysRemaining !== null && newClosedInfo.daysRemaining < 0) {
                            isExpired = true;
                        }
                    }
                    if (isExpired) {
                        console.log(`⏭️ Skipping update for expired quiz: ${item.activity.name}`);
                        this.courseData[courseId].assignments[item.activity.url] = newDetails;
                        await this.saveData();
                        continue;
                    }
                    
                    const hasKnownDate = (value) => value && value !== 'نامشخص';
                    const openedChanged = hasKnownDate(newDetails.opened) && newDetails.opened !== oldDetails.opened;
                    let closedChanged = hasKnownDate(newDetails.closed) && newDetails.closed !== oldDetails.closed;
                    let oldClosedInfo = null;
                    let newClosedInfo = null;
                    if (closedChanged) {
                        if (hasKnownDate(oldDetails.closed)) {
                            oldClosedInfo = this.formatPersianDate(oldDetails.closed);
                        }
                        if (hasKnownDate(newDetails.closed)) {
                            newClosedInfo = this.formatPersianDate(newDetails.closed);
                        }
                        if (oldClosedInfo && newClosedInfo &&
                            oldClosedInfo.daysRemaining !== null && newClosedInfo.daysRemaining !== null &&
                            oldClosedInfo.daysRemaining < 0 && newClosedInfo.daysRemaining < 0) {
                            closedChanged = false;
                        }
                    }
                    const dateChanged = openedChanged || closedChanged;
                    if (dateChanged) {
                        hasUpdate = true;
                        updateMessage = `🔄 <b>تغییر در تاریخ آزمون</b>\n\n`;
                        updateMessage += `📚 درس: ${courseName}\n`;
                        updateMessage += `❓ ${item.activity.name}\n\n`;
                        if (openedChanged) {
                            updateMessage += `📅 تاریخ باز شدن:\n`;
                            if (oldDetails.opened !== 'نامشخص') {
                                const oldOpenedInfo = this.formatPersianDate(oldDetails.opened);
                                updateMessage += ` قبلی: ${oldOpenedInfo.formatted}\n`;
                            }
                            if (newDetails.opened !== 'نامشخص') {
                                const newOpenedInfo = this.formatPersianDate(newDetails.opened);
                                updateMessage += ` جدید: ${newOpenedInfo.formatted}\n`;
                            }
                            updateMessage += `\n`;
                        }
                        if (closedChanged) {
                            updateMessage += `⏰ بسته می‌شود:\n`;
                            if (oldDetails.closed !== 'نامشخص') {
                                if (!oldClosedInfo) oldClosedInfo = this.formatPersianDate(oldDetails.closed);
                                updateMessage += ` قبلی: ${oldClosedInfo.formatted}\n`;
                            }
                            if (newDetails.closed !== 'نامشخص') {
                                if (!newClosedInfo) newClosedInfo = this.formatPersianDate(newDetails.closed);
                                updateMessage += ` جدید: ${newClosedInfo.formatted}\n`;
                                if (newClosedInfo.daysRemaining !== null) {
                                    if (newClosedInfo.daysRemaining < 0) {
                                        updateMessage += ` ❌ <b>مهلت گذشته است!</b> (${Math.abs(newClosedInfo.daysRemaining)} روز پیش)\n`;
                                    } else if (newClosedInfo.daysRemaining === 0) {
                                        updateMessage += ` 🔴 <b>امروز آخرین مهلت است!</b>\n`;
                                    } else if (newClosedInfo.daysRemaining === 1) {
                                        updateMessage += ` ⚠️ <b>فقط 1 روز باقی مانده</b>\n`;
                                    } else if (newClosedInfo.daysRemaining <= 3) {
                                        updateMessage += ` ⚠️ ${newClosedInfo.daysRemaining} روز دیگر\n`;
                                    } else {
                                        updateMessage += ` ✅ ${newClosedInfo.daysRemaining} روز دیگر\n`;
                                    }
                                }
                            }
                        }
                    }
                    
                    if (hasUpdate) {
                        await this.sendTelegramMessage(updateMessage, {
                            chatIds: this.getCourseTargetChatIds(courseId),
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔗 مشاهده آزمون', url: item.activity.url }
                                ]]
                            }
                        });
                    }
                    
                    this.courseData[courseId].assignments[item.activity.url] = newDetails;
                    await this.saveData();
                }
            } catch (error) {
                console.error('Error checking for updates:', error.message);
            }
        }
    }
    async notifyNewActivities(courseId, courseName, changes) {
        for (const item of changes.newItems) {
            const activityType = item.activity.type;
            
            if (activityType === 'assign' || activityType === 'mod_assign') {
                const platformsToNotify = this.getPlatformsNotYetNotified(courseId, item.activity.url);
                if (platformsToNotify.length === 0) {
                    console.log(`📭 Notification already sent for: ${item.activity.name}`);
                    continue;
                }
                const notifyTargets = this.getCourseTargetChatIds(courseId).filter(t => platformsToNotify.includes(t.platform));

                let message = this.buildNewAssignmentMessage(courseName, item.section, item.activity.name);

                try {
                    let details = await this.extractAssignmentDetails(item.activity.url);
                    if (!details || details.success === false) {
                        console.log(`⚠️ Couldn't fetch assignment details for ${item.activity.name} — sending basic notification and skipping attachments`);
                        details = { opened: 'نامشخص', deadline: 'نامشخص', attachments: [] };
                    }

                    let isExpired = false;
                    if (details.deadline && details.deadline !== 'نامشخص') {
                        const deadlineCheck = this.formatPersianDate(details.deadline);
                        if (deadlineCheck.daysRemaining !== null) {
                            if (deadlineCheck.daysRemaining < 0) {
                                isExpired = true;
                            }
                        }
                    }
                    if (isExpired) {
                        console.log(`⏭️ Skipping expired assignment: ${item.activity.name}`);
                        this.courseData[courseId].assignments[item.activity.url] = details;
                        await this.saveData();
                        continue;
                    }

                    message = this.buildNewAssignmentMessage(courseName, item.section, item.activity.name, details);

                    const sendResult = await this.sendTelegramMessage(message, {
                        chatIds: notifyTargets,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔗 مشاهده تکلیف', url: item.activity.url }],
                                [this.buildGoogleCalendarButton(courseName, item.activity.name, item.activity.url, details.deadline)]
                            ]
                        }
                    });

                    if (details.attachments && details.attachments.length > 0) {
                        console.log(`📎 Found ${details.attachments.length} attachment(s) for assignment`);

                        for (const att of details.attachments) {
                            await this.downloadAndSendFile(att.url, att.fileName, courseId);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }

                    this.courseData[courseId].assignments[item.activity.url] = details;
                    const sentPlatforms = platformsToNotify.filter(platform => sendResult.sentPlatforms.includes(platform));
                    if (sentPlatforms.length > 0) {
                        this.markNotificationSent(courseId, item.activity.url, sentPlatforms, item.activity.name);
                        this.recordNotificationMessageIds(courseId, item.activity.url, sendResult.sentMessages);
                    }

                    await this.saveData();

                } catch (error) {
                    console.error('Error getting assignment details:', error.message);
                    if (!message.includes('مهلت:')) {
                        const fallbackResult = await this.sendTelegramMessage(message, {
                            chatIds: notifyTargets,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔗 مشاهده تکلیف', url: item.activity.url }],
                                    [this.buildGoogleCalendarButton(courseName, item.activity.name, item.activity.url)]
                                ]
                            }
                        });
                        const sentPlatforms = platformsToNotify.filter(platform => fallbackResult.sentPlatforms.includes(platform));
                        if (sentPlatforms.length > 0) {
                            this.markNotificationSent(courseId, item.activity.url, sentPlatforms, item.activity.name);
                            this.recordNotificationMessageIds(courseId, item.activity.url, fallbackResult.sentMessages);
                            await this.saveData();
                        }
                    }
                }
            }
            else if (activityType === 'quiz' || activityType === 'mod_quiz') {
                const platformsToNotify = this.getPlatformsNotYetNotified(courseId, item.activity.url);
                if (platformsToNotify.length === 0) {
                    console.log(`📭 Notification already sent for: ${item.activity.name}`);
                    continue;
                }
                const notifyTargets = this.getCourseTargetChatIds(courseId).filter(t => platformsToNotify.includes(t.platform));

                let message = `🆕 <b>آزمون جدید</b>\n\n`;
                message += `🎓 درس: ${courseName}\n`;
                message += `📂 بخش: ${item.section}\n\n`;
                message += `❓ ${item.activity.name}\n\n`;

                try {
                    let details = await this.extractQuizDetails(item.activity.url);
                    if (!details || details.success === false) {
                        console.log(`⚠️ Couldn't fetch quiz details for ${item.activity.name} — sending basic notification`);
                        details = { opened: 'نامشخص', closed: 'نامشخص' };
                    }
                    if ((!details.opened || details.opened === 'نامشخص') && item.activity.opened) {
                        details.opened = item.activity.opened;
                    }

                    let isExpired = false;
                    if (details.closed && details.closed !== 'نامشخص') {
                        const closedCheck = this.formatPersianDate(details.closed);
                        if (closedCheck.daysRemaining !== null && closedCheck.daysRemaining < 0) {
                            isExpired = true;
                        }
                    }
                    if (isExpired) {
                        console.log(`⏭️ Skipping expired quiz: ${item.activity.name}`);
                        this.courseData[courseId].assignments[item.activity.url] = details;
                        await this.saveData();
                        continue;
                    }

                    if (details.opened && details.opened !== 'نامشخص') {
                        const openedInfo = this.formatPersianDate(details.opened);
                        message += `📅 شروع آزمون: ${openedInfo.formatted}\n`;
                        if (openedInfo.daysRemaining !== null) {
                            if (openedInfo.daysRemaining === 0) {
                                message += `🔴 <b>امروز</b>\n`;
                            } else if (openedInfo.daysRemaining === 1) {
                                message += `⚠️ <b>1 روز باقی مانده</b>\n`;
                            } else if (openedInfo.daysRemaining > 1) {
                                message += `✅ ${openedInfo.daysRemaining} روز دیگر\n`;
                            }
                        }
                    }

                    if (details.closed && details.closed !== 'نامشخص') {
                        const dateInfo = this.formatPersianDate(details.closed);
                        message += `⏰ بسته می‌شود: ${dateInfo.formatted}\n`;

                        if (dateInfo.daysRemaining !== null) {
                            if (dateInfo.daysRemaining === 0) {
                                message += `🔴 <b>امروز آخرین فرصت است!</b>\n`;
                            } else if (dateInfo.daysRemaining === 1) {
                                message += `⚠️ <b>فقط 1 روز باقی مانده</b>\n`;
                            } else if (dateInfo.daysRemaining <= 3) {
                                message += `⚠️ ${dateInfo.daysRemaining} روز دیگر\n`;
                            } else {
                                message += `✅ ${dateInfo.daysRemaining} روز دیگر\n`;
                            }
                        }
                    }

                    const sendResult = await this.sendTelegramMessage(message, {
                        chatIds: notifyTargets,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 مشاهده آزمون', url: item.activity.url }
                            ]]
                        }
                    });

                    const sentPlatforms = platformsToNotify.filter(platform => sendResult.sentPlatforms.includes(platform));
                    if (sentPlatforms.length > 0) {
                        this.markNotificationSent(courseId, item.activity.url, sentPlatforms, item.activity.name);
                        this.recordNotificationMessageIds(courseId, item.activity.url, sendResult.sentMessages);
                    }
                    this.courseData[courseId].assignments[item.activity.url] = details;

                    await this.saveData();

                } catch (error) {
                    console.error('Error getting quiz details:', error.message);
                    const fallbackResult = await this.sendTelegramMessage(message, {
                        chatIds: notifyTargets,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 مشاهده آزمون', url: item.activity.url }
                            ]]
                        }
                    });

                    const sentPlatforms = platformsToNotify.filter(platform => fallbackResult.sentPlatforms.includes(platform));
                    if (sentPlatforms.length > 0) {
                        this.markNotificationSent(courseId, item.activity.url, sentPlatforms, item.activity.name);
                        this.recordNotificationMessageIds(courseId, item.activity.url, fallbackResult.sentMessages);
                    }
                    await this.saveData();
                }
            }
            else if (activityType === 'resource' || activityType === 'mod_resource') {
                const platformsToNotify = this.getPlatformsNotYetNotified(courseId, item.activity.url);
                if (platformsToNotify.length === 0) {
                    console.log(`📭 Notification already sent for: ${item.activity.name}`);
                    continue;
                }
                const notifyTargets = this.getCourseTargetChatIds(courseId).filter(t => platformsToNotify.includes(t.platform));

                let message = `🆕 <b>فایل جدید</b>\n\n`;
                message += `🎓 درس: ${courseName}\n`;
                message += `📂 بخش: ${item.section}\n\n`;
                message += `📁 ${item.activity.name}\n`;
                const resourceSentPlatforms = new Set();

                try {
                    console.log(`📥 Extracting file URL for: ${item.activity.name}`);
                    console.log(`📍 Resource URL: ${item.activity.url}`);

                    let fileInfo = await this.extractResourceFileUrl(item.activity.url);

                    if (!fileInfo || !fileInfo.url) {
                        console.log(`⚠️ Could not extract file URL, trying direct download from resource URL...`);
                        try {
                            const directResult = await this.downloadWithSessionCookies(item.activity.url);
                            if (directResult && !directResult.contentType.includes('text/html')) {
                                const fileName = item.activity.name || 'file';
                                fileInfo = {
                                    url: item.activity.url,
                                    fileName,
                                    directBuffer: directResult.buffer,
                                    contentType: directResult.contentType
                                };
                                console.log(`✅ Direct download successful: ${fileName}`);
                            }
                        } catch (directErr) {
                            console.log(`⚠️ Direct download failed: ${directErr.message}`);
                        }
                    }

                    if (fileInfo && fileInfo.url) {
                        console.log(`📥 Downloading resource file: ${fileInfo.fileName}`);
                        console.log(`🔗 File URL: ${fileInfo.url}`);

                        let buffer, contentType;

                        if (fileInfo.buffer) {
                            buffer = fileInfo.buffer;
                            contentType = fileInfo.contentType;
                            console.log(`✅ Using pre-downloaded buffer (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
                        } else if (fileInfo.directBuffer) {
                            buffer = fileInfo.directBuffer;
                            contentType = fileInfo.contentType;
                        } else {
                            console.log(`📥 Downloading from: ${fileInfo.url}`);
                            const downloadResult = await this.downloadWithSessionCookies(fileInfo.url);
                            buffer = downloadResult.buffer;
                            contentType = downloadResult.contentType;
                        }

                        if (contentType.includes('text/html')) {
                            const preview = buffer.toString('utf8').substring(0, 200);
                            console.log(`⚠️ Received HTML instead of file. Preview: ${preview}`);
                            throw new Error('Received HTML instead of file - session may have expired');
                        }

                        const fileSizeMB = buffer.length / (1024 * 1024);
                        console.log(`📄 File size: ${fileSizeMB.toFixed(2)} MB, Content-Type: ${contentType}`);

                        if (fileSizeMB <= 100) {
                            let caption = `🆕 <b>فایل جدید</b>\n\n`;
                            caption += `🎓 درس: ${courseName}\n`;
                            caption += `📂 بخش: ${item.section}\n\n`;
                            caption += `📎 ${fileInfo.fileName}`;

                            for (const target of notifyTargets) {
                                console.log(`📤 Sending file to ${target.platform} chat ${target.chatId}...`);
                                const formattedCaption = this.formatForPlatform(caption, target.platform);
                                try {
                                    await this.sendDocumentViaApi({
                                        platform: target.platform,
                                        chatId: target.chatId,
                                        buffer,
                                        fileName: fileInfo.fileName,
                                        caption: formattedCaption.text,
                                        parseMode: formattedCaption.parse_mode,
                                        contentType
                                    });
                                    resourceSentPlatforms.add(target.platform);
                                } catch (error) {
                                    console.error(`❌ Failed to send file to ${target.platform} chat ${target.chatId}:`, error.message);
                                }
                            }
                            console.log(`✅ File uploaded: ${fileInfo.fileName}`);
                        } else {
                            message += `🔗 ${item.activity.url}\n`;
                            message += `⚠️ حجم فایل: ${fileSizeMB.toFixed(2)} MB (بیش از 100 مگابایت)\n`;

                            const sendResult = await this.sendTelegramMessage(message, {
                                chatIds: notifyTargets,
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '🔗 دانلود فایل', url: item.activity.url }
                                    ]]
                                }
                            });
                            sendResult.sentPlatforms.forEach(platform => resourceSentPlatforms.add(platform));
                        }
                    } else {
                        console.log(`⚠️ Could not extract file URL for: ${item.activity.name}`);
                        message += `🔗 ${item.activity.url}\n`;
                        const sendResult = await this.sendTelegramMessage(message, {
                            chatIds: notifyTargets,
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔗 دانلود فایل', url: item.activity.url }
                                ]]
                            }
                        });
                        sendResult.sentPlatforms.forEach(platform => resourceSentPlatforms.add(platform));
                    }
                } catch (error) {
                    console.error(`❌ Error downloading resource file: ${error.message}`);
                    message += `🔗 ${item.activity.url}\n`;
                    const sendResult = await this.sendTelegramMessage(message, {
                        chatIds: notifyTargets,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 دانلود فایل', url: item.activity.url }
                            ]]
                        }
                    });
                    sendResult.sentPlatforms.forEach(platform => resourceSentPlatforms.add(platform));
                }

                const sentPlatforms = platformsToNotify.filter(platform => resourceSentPlatforms.has(platform));
                if (sentPlatforms.length > 0) {
                    this.markNotificationSent(courseId, item.activity.url, sentPlatforms, item.activity.name);
                }
                await this.saveData();

                console.log(`📁 Notified about new file: ${item.activity.name}`);
            }
        }
    }
    buildCourseMessage(course, item) {
        const emoji = this.getEmoji(item.activity.type);
        
        let message = `🎓 درس: ${course.name}\n\n`;
        message += `📂 بخش: ${item.section}\n\n`;
        message += `${emoji} ${item.activity.name}\n\n`;
        message += `🔗 لینک: ${item.activity.url}`;
        
        return message;
    }
    getEmoji(activityType) {
        const emojiMap = {
            'assign': '📝',
            'resource': '📁',
            'url': '🔗',
            'forum': '💬',
            'quiz': '❓',
            'page': '📄',
            'folder': '📂',
            'label': '🏷️'
        };

        return emojiMap[activityType] || '📌';
    }
    getPlatformsNotYetNotified(courseId, url) {
        const record = this.courseData[courseId]?.sentNotifications?.[url];
        if (!record) return [...CONFIG.activePlatforms];
        const sentPlatforms = record.platforms || (record.sent ? [DEFAULT_PLATFORM] : []);
        return CONFIG.activePlatforms.filter(p => !sentPlatforms.includes(p));
    }
    markNotificationSent(courseId, url, platforms, activityName) {
        const existing = this.courseData[courseId].sentNotifications?.[url];
        const prevPlatforms = existing?.platforms || (existing?.sent ? [DEFAULT_PLATFORM] : []);
        const prevMessageIds = existing?.messageIds && typeof existing.messageIds === 'object' && !Array.isArray(existing.messageIds)
            ? { ...existing.messageIds }
            : {};
        this.courseData[courseId].sentNotifications[url] = {
            sent: true,
            sentAt: new Date().toISOString(),
            activityName,
            platforms: [...new Set([...prevPlatforms, ...platforms])],
            messageIds: prevMessageIds
        };
    }
    recordNotificationMessageIds(courseId, url, sentMessages = []) {
        const record = this.courseData[courseId]?.sentNotifications?.[url];
        if (!record) return;
        if (!record.messageIds || typeof record.messageIds !== 'object' || Array.isArray(record.messageIds)) {
            record.messageIds = {};
        }
        for (const sentMessage of sentMessages) {
            const target = this.normalizeChatTarget(sentMessage);
            const messageId = this.normalizeMessageId(sentMessage?.messageId);
            if (!target || messageId === null) continue;
            const key = this.getStorageKey(target);
            const existing = Array.isArray(record.messageIds[key]) ? record.messageIds[key] : [];
            if (!existing.includes(messageId)) {
                record.messageIds[key] = [messageId, ...existing].slice(0, 20);
            }
        }
    }
    convertToShamsi(gregorianDate) {
        try {
            const m = moment(gregorianDate, 'YYYY-MM-DD');
            return m.format('jYYYY/jMM/jDD');
        } catch (error) {
            console.error('Error converting date:', error.message);
            return null;
        }
    }
    getPersianDayName(dayNumber) {
        const persianDays = {
            0: 'یکشنبه',
            1: 'دوشنبه',
            2: 'سه‌شنبه',
            3: 'چهارشنبه',
            4: 'پنج‌شنبه',
            5: 'جمعه',
            6: 'شنبه'
        };
        
        return persianDays[dayNumber] || '';
    }
    getPersianMonthName(monthNumber) {
        const persianMonths = {
            1: 'فروردین',
            2: 'اردیبهشت',
            3: 'خرداد',
            4: 'تیر',
            5: 'مرداد',
            6: 'شهریور',
            7: 'مهر',
            8: 'آبان',
            9: 'آذر',
            10: 'دی',
            11: 'بهمن',
            12: 'اسفند'
        };
        
        return persianMonths[monthNumber] || '';
    }
    getPersianMonthNumber(monthName = '') {
        const normalized = this.cleanText(monthName)
            .replace(/ي/g, 'ی')
            .replace(/ك/g, 'ک');
        const persianMonths = {
            'فروردین': 1,
            'اردیبهشت': 2,
            'خرداد': 3,
            'تیر': 4,
            'مرداد': 5,
            'شهریور': 6,
            'مهر': 7,
            'آبان': 8,
            'آذر': 9,
            'دی': 10,
            'بهمن': 11,
            'اسفند': 12
        };

        return persianMonths[normalized];
    }
    getDateDiffDays(date) {
        const targetLocal = new Date(date);
        targetLocal.setHours(0, 0, 0, 0);
        const nowLocal = new Date();
        nowLocal.setHours(0, 0, 0, 0);
        const diffTime = targetLocal.getTime() - nowLocal.getTime();
        return Math.round(diffTime / (1000 * 60 * 60 * 24));
    }
    parsePersianMoodleDateTime(dateText) {
        const text = this.toEnglishDigits(this.cleanText(dateText)).replace(/\s+/g, ' ').trim();
        const match = text.match(/(\d{1,2})\s+([\u0600-\u06FF]+)\s+(\d{4})(?:\s*(?:[،,]|-)?\s*(?:ساعت)?\s*(\d{1,2}):(\d{2}))?/);
        if (!match) return null;

        const day = parseInt(match[1], 10);
        const month = this.getPersianMonthNumber(match[2]);
        const year = parseInt(match[3], 10);
        const hours = match[4] !== undefined ? parseInt(match[4], 10) : 23;
        const minutes = match[5] !== undefined ? parseInt(match[5], 10) : 59;
        if (!month) return null;

        const parsed = moment(
            `${year}/${month}/${day} ${hours}:${minutes}`,
            'jYYYY/jM/jD H:m',
            true
        );

        return parsed.isValid() ? parsed.toDate() : null;
    }
    parseMoodleDateTime(dateText) {
        if (!dateText || dateText === 'نامشخص') return null;

        const persianDate = this.parsePersianMoodleDateTime(dateText);
        if (persianDate) return persianDate;

        const cleanDateText = this.toEnglishDigits(this.cleanText(dateText));
        const match = cleanDateText.match(/(\w+)[،,]\s*(\d+)\s+(\w+)\s+(\d+)[،,]\s*(.+)/);
        if (!match) return null;

        const day = parseInt(match[2], 10);
        const monthName = match[3];
        const year = parseInt(match[4], 10);
        const time = match[5].trim();

        const months = {
            'January': 0, 'February': 1, 'March': 2, 'April': 3,
            'May': 4, 'June': 5, 'July': 6, 'August': 7,
            'September': 8, 'October': 9, 'November': 10, 'December': 11
        };
        const month = months[monthName];
        if (month === undefined) return null;

        let hours = 23;
        let minutes = 59;

        const timeMatch12 = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
        const timeMatch24 = time.match(/^(\d{1,2}):(\d{2})$/);
        if (timeMatch12) {
            hours = parseInt(timeMatch12[1], 10);
            minutes = parseInt(timeMatch12[2], 10);
            const period = timeMatch12[3].toUpperCase();
            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;
        } else if (timeMatch24) {
            hours = parseInt(timeMatch24[1], 10);
            minutes = parseInt(timeMatch24[2], 10);
        }

        const parsed = new Date(year, month, day, hours, minutes, 0);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    formatGoogleCalendarDate(date) {
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const min = String(date.getUTCMinutes()).padStart(2, '0');
        const ss = String(date.getUTCSeconds()).padStart(2, '0');
        return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
    }
    buildGoogleCalendarButton(courseName, activityName, activityUrl, dueText = 'نامشخص') {
        const title = `تمرین: ${activityName}`;
        const detailsParts = [
            `درس: ${courseName}`,
            dueText && dueText !== 'نامشخص' ? `مهلت: ${dueText}` : null,
            `لینک تمرین: ${activityUrl}`
        ].filter(Boolean);

        const params = new URLSearchParams({
            action: 'TEMPLATE',
            text: title,
            details: detailsParts.join('\n')
        });

        const dueDate = this.parseMoodleDateTime(dueText);
        if (dueDate) {
            const start = new Date(dueDate.getTime() - 60 * 60 * 1000);
            params.set('dates', `${this.formatGoogleCalendarDate(start)}/${this.formatGoogleCalendarDate(dueDate)}`);
        }

        return {
            text: '🗓️ اضافه کردن در تقویم گوگل',
            url: `https://calendar.google.com/calendar/render?${params.toString()}`
        };
    }
    buildDaysRemainingLine(daysRemaining) {
        if (daysRemaining === null || daysRemaining === undefined) return '';
        if (daysRemaining < 0) return `❌ مهلت گذشته است! (${Math.abs(daysRemaining)} روز پیش)\n`;
        if (daysRemaining === 0) return `🔴 امروز آخرین مهلت است!\n`;
        if (daysRemaining === 1) return `⚠️ فقط 1 روز باقی مانده\n`;
        if (daysRemaining <= 3) return `⚠️ ${daysRemaining} روز دیگر\n`;
        return `✅ ${daysRemaining} روز دیگر\n`;
    }
    buildNewAssignmentMessage(courseName, sectionName, activityName, details = {}) {
        let message = `🆕 تکلیف جدید\n\n`;
        message += `🎓 درس: ${courseName}\n`;
        message += `📂 بخش: ${sectionName}\n\n`;
        message += `📝 ${activityName}\n\n`;

        if (details.opened && details.opened !== 'نامشخص') {
            const openedInfo = this.formatPersianDate(details.opened);
            message += `📅 باز شده: ${openedInfo.formatted}\n`;
        }

        if (details.deadline && details.deadline !== 'نامشخص') {
            const deadlineInfo = this.formatPersianDate(details.deadline);
            message += `⏰ مهلت: ${deadlineInfo.formatted}\n`;
            message += this.buildDaysRemainingLine(deadlineInfo.daysRemaining);
        }

        if (details.attachments && details.attachments.length > 0) {
            message += `\n📎 فایل‌های ضمیمه:\n`;
            for (const att of details.attachments) {
                message += `📄 ${this.cleanText(att.fileName)}\n`;
            }
        }

        return message;
    }
    formatPersianDate(deadlineText) {
        try {
            const cleanDeadlineText = this.toEnglishDigits(this.cleanText(deadlineText));
            const persianDate = this.parsePersianMoodleDateTime(cleanDeadlineText);
            if (persianDate) {
                const shamsiDate = moment(persianDate).format('jYYYY/jMM/jDD');
                const shamsiParts = shamsiDate.split('/');
                const shamsiMonth = this.getPersianMonthName(parseInt(shamsiParts[1], 10));
                const persianDayName = this.getPersianDayName(persianDate.getDay());
                const hours = String(persianDate.getHours()).padStart(2, '0');
                const minutes = String(persianDate.getMinutes()).padStart(2, '0');
                const formattedShamsi = `${parseInt(shamsiParts[2], 10)} ${shamsiMonth} ${shamsiParts[0]}`;

                return {
                    formatted: `${persianDayName}، ${formattedShamsi} - ساعت ${hours}:${minutes}`,
                    daysRemaining: this.getDateDiffDays(persianDate),
                    shamsiDate
                };
            }

            const match = cleanDeadlineText.match(/(\w+)،\s*(\d+)\s+(\w+)\s+(\d+)،\s*(.+)/);
            if (!match) return { formatted: cleanDeadlineText, daysRemaining: null };
            const day = parseInt(match[2]);
            const monthName = match[3];
            const year = parseInt(match[4]);
            const time = match[5];
            const months = {
                'January': 0, 'February': 1, 'March': 2, 'April': 3,
                'May': 4, 'June': 5, 'July': 6, 'August': 7,
                'September': 8, 'October': 9, 'November': 10, 'December': 11
            };
            const month = months[monthName];
            if (month === undefined) return { formatted: deadlineText, daysRemaining: null };
            let time24 = time;
            const timeMatch = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
            if (timeMatch) {
                let hours = parseInt(timeMatch[1]);
                const minutes = timeMatch[2];
                const period = timeMatch[3].toUpperCase();
                
                if (period === 'PM' && hours !== 12) {
                    hours += 12;
                } else if (period === 'AM' && hours === 12) {
                    hours = 0;
                }
                
                time24 = `${hours.toString().padStart(2, '0')}:${minutes}`;
            }
            const gregorianDate = `${year}-${(month+1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            const shamsiDate = this.convertToShamsi(gregorianDate);

            // Use local system time for day-boundary comparisons (Windows-friendly)
            const deadlineLocal = new Date(year, month, day);
            deadlineLocal.setHours(0, 0, 0, 0);
            const nowLocal = new Date();
            nowLocal.setHours(0, 0, 0, 0);
            const diffTime = deadlineLocal.getTime() - nowLocal.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

            const dayOfWeek = new Date(year, month, day).getDay();
            const persianDayName = this.getPersianDayName(dayOfWeek);
            let formattedShamsi = shamsiDate;
            if (shamsiDate) {
                const shamsiParts = shamsiDate.split('/');
                const shamsiMonth = this.getPersianMonthName(parseInt(shamsiParts[1]));
                formattedShamsi = `${shamsiParts[2]} ${shamsiMonth} ${shamsiParts[0]}`;
            }
            const formatted = `${persianDayName}، ${formattedShamsi} - ساعت ${time24}`;
            return {
                formatted,
                daysRemaining: diffDays,
                shamsiDate
            };
        } catch (error) {
            console.error('Error formatting date:', error.message);
            return { formatted: this.cleanText(deadlineText), daysRemaining: null };
        }
    }
    calculateDaysRemaining(deadlineText) {
        try {
            const match = deadlineText.match(/(\d+)\s+(\w+)\s+(\d+)/);
            if (!match) return null;
            const day = parseInt(match[1]);
            const monthName = match[2];
            const year = parseInt(match[3]);
            const months = {
                'January': 0, 'February': 1, 'March': 2, 'April': 3,
                'May': 4, 'June': 5, 'July': 6, 'August': 7,
                'September': 8, 'October': 9, 'November': 10, 'December': 11
            };
            const month = months[monthName];
            if (month === undefined) return null;

            // Use local system time (Windows-friendly)
            const deadlineLocal = new Date(year, month, day);
            deadlineLocal.setHours(0, 0, 0, 0);
            const nowLocal = new Date();
            nowLocal.setHours(0, 0, 0, 0);
            const diffTime = deadlineLocal.getTime() - nowLocal.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            return diffDays > 0 ? diffDays : 0;
        } catch (error) {
            return null;
        }
    }
    isInQuietHours() {
        try {
            if (!CONFIG.quietHoursEnabled) {
                console.log('🕐 Quiet hours is DISABLED via QUIET_HOURS_ENABLED=false');
                return false;
            }
            
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();
            
            console.log(`🕐 Quiet hours check - Local: ${now.toLocaleString()}, Hours: ${hour}, Minutes: ${minute}`);
            
            const totalMinutes = hour * 60 + minute;
            const quietStart = 0 * 60 + 30;  // 00:30
            const quietEnd = 7 * 60 + 30;    // 07:30
            const isQuiet = totalMinutes >= quietStart && totalMinutes < quietEnd;
            console.log(`🕐 totalMinutes: ${totalMinutes}, quietStart: ${quietStart}, quietEnd: ${quietEnd}, isQuiet: ${isQuiet}`);
            return isQuiet;
        } catch (error) {
            console.error('Error determining time for quiet hours check:', error.message);
            return false;
        }
    }
    toMarkdown(message) {
        if (!message) return '';
        return message
            .replace(/<a\s+href="([^"]+)">([\s\S]*?)<\/a>/gi, '[$2]($1)')
            .replace(/<b>([\s\S]*?)<\/b>/gi, '*$1*')
            .replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '');
    }
    escapeHtml(value = '') {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    // Convert the internal HTML-ish message into valid Telegram HTML, escaping
    // any stray special characters in the dynamic content while preserving the
    // intentional <b>/<a>/<i> tags.
    toHtml(message) {
        if (!message) return '';
        const tokenRe = /<a\s+href="[^"]*">|<\/a>|<\/?b>|<\/?strong>|<\/?i>|<br\s*\/?>/gi;
        let result = '';
        let lastIndex = 0;
        let match;
        while ((match = tokenRe.exec(message)) !== null) {
            result += this.escapeHtml(message.slice(lastIndex, match.index));
            const tag = match[0];
            const lower = tag.toLowerCase();
            if (lower.startsWith('<br')) {
                result += '\n';
            } else if (lower.startsWith('<a')) {
                const href = tag.match(/href="([^"]*)"/i);
                result += `<a href="${this.escapeHtml(href ? href[1] : '')}">`;
            } else if (lower === '<strong>') {
                result += '<b>';
            } else if (lower === '</strong>') {
                result += '</b>';
            } else {
                result += lower;
            }
            lastIndex = tokenRe.lastIndex;
        }
        result += this.escapeHtml(message.slice(lastIndex));
        return result;
    }
    // Wrap known emoji in <tg-emoji> so Telegram renders them as premium emoji.
    applyPremiumEmoji(text) {
        if (!text || !USE_PREMIUM_EMOJI) return text;
        let result = text;
        for (const matcher of PREMIUM_EMOJI_MATCHERS) {
            if (result.indexOf(matcher.base) === -1) continue;
            matcher.regex.lastIndex = 0;
            result = result.replace(
                matcher.regex,
                `<tg-emoji emoji-id="${matcher.id}">${matcher.display}</tg-emoji>`
            );
        }
        return result;
    }
    // Format an internal message for a specific platform:
    //  - Telegram → HTML with premium <tg-emoji> entities
    //  - Bale (and others) → Markdown with plain emoji (unchanged behaviour)
    formatForPlatform(message, platform) {
        if (platform === 'telegram') {
            return { text: this.applyPremiumEmoji(this.toHtml(message)), parse_mode: 'HTML' };
        }
        return { text: this.toMarkdown(message), parse_mode: 'Markdown' };
    }
    // Returns local system time as a Jalali (Shamsi) timestamp — Windows-friendly
    getLocalTimestamp() {
        return moment().format('jYYYY/jMM/jDD HH:mm');
    }
    async sendTelegramMessage(message, options = {}) {
        try {
            const { chatIds, ...rawOptions } = options;
            const baseOptions = {
                disable_web_page_preview: true,
                ...rawOptions
            };

            const targets = Array.isArray(chatIds) && chatIds.length > 0
                ? chatIds
                    .map(target => this.normalizeChatTarget(target))
                    .filter(Boolean)
                : CONFIG.activePlatforms
                    .map(platform => {
                        const platformConfig = this.getPlatformConfig(platform);
                        if (!platformConfig?.token || !platformConfig.globalChatId) return null;
                        return { platform, chatId: String(platformConfig.globalChatId) };
                    })
                    .filter(Boolean);

            if (targets.length === 0) {
                console.log('⚠️ No valid chat ID configured for this message');
                return { ok: false, sentPlatforms: [], sentMessages: [] };
            }

            const sentPlatforms = [];
            const sentMessages = [];
            let failedCount = 0;
            for (const target of targets) {
                const formatted = this.formatForPlatform(message, target.platform);
                const sendOptions = this.getChatScopedOptions(
                    { ...baseOptions, parse_mode: baseOptions.parse_mode || formatted.parse_mode },
                    target
                );
                try {
                    const sentMessage = await getBot(target.platform).sendMessage(target.chatId, formatted.text, sendOptions);
                    sentPlatforms.push(target.platform);
                    const messageId = this.normalizeMessageId(sentMessage?.message_id);
                    if (messageId !== null) {
                        sentMessages.push({
                            platform: target.platform,
                            chatId: target.chatId,
                            messageId
                        });
                    }
                } catch (error) {
                    failedCount++;
                    console.error(`❌ Failed to send ${target.platform} bot message:`, error.message);
                }
            }

            const uniqueSentPlatforms = [...new Set(sentPlatforms)];
            if (failedCount > 0) {
                return { ok: false, sentPlatforms: uniqueSentPlatforms, sentMessages };
            }

            console.log('✅ Bot notification sent');
            return { ok: true, sentPlatforms: uniqueSentPlatforms, sentMessages };
        } catch (error) {
            console.error('❌ Failed to send bot message:', error.message);
            return { ok: false, sentPlatforms: [], sentMessages: [] };
        }
    }
    async sendCourseOverview(courseId) {
        const course = this.courseData[courseId];
        if (!course) return;
        let message = `📚 <b>${course.name}</b>\n\n`;
        message += `🔗 ${course.url}\n\n`;
        message += `━━━━━━━━━━━━━━━━━\n\n`;
        for (const [sectionName, activities] of Object.entries(course.sections)) {
            if (activities.length > 0) {
                message += `<b>${sectionName}</b>\n`;
                
                activities.forEach(activity => {
                    const emoji = this.getEmoji(activity.type);
                    message += `${emoji} ${activity.name}\n`;
                });
                
                message += `\n`;
            }
        }
        await this.sendTelegramMessage(message, {
            chatIds: this.getCourseTargetChatIds(courseId, course.url)
        });
    }

    async checkAndSendReminders() {
        console.log('⏰ Checking for assignment reminders...');

        const nowLocal = new Date(); // current local system time

        for (const [courseId, course] of Object.entries(this.courseData)) {
            for (const [sectionName, activities] of Object.entries(course.sections || {})) {
                for (const activity of activities) {
                    if (!['assign', 'mod_assign', 'quiz', 'mod_quiz'].includes(activity.type)) continue;

                    const isQuiz = activity.type === 'quiz' || activity.type === 'mod_quiz';
                    const lastDayReminderKey = `${courseId}_${activity.url}_lastday`;

                    if (this.sentLastDayReminders[lastDayReminderKey]) {
                        console.log(`📅 Last day reminder already sent for: ${activity.name}`);
                        continue;
                    }

                    try {
                        let details = (course.assignments || {})[activity.url];
                        if (!details) {
                            details = isQuiz
                                ? await this.extractQuizDetails(activity.url)
                                : await this.extractAssignmentDetails(activity.url);
                            if (details && details.success !== false) {
                                if (!this.courseData[courseId].assignments) {
                                    this.courseData[courseId].assignments = {};
                                }
                                this.courseData[courseId].assignments[activity.url] = details;
                            }
                        }

                        const deadlineField = isQuiz ? 'closed' : 'deadline';
                        const deadlineText = details && details[deadlineField];

                        if (!deadlineText || deadlineText === 'نامشخص') continue;

                        // Parse deadline using local system time (Windows-friendly)
                        const rawMatch = deadlineText.match(
                            /(\w+)،\s*(\d+)\s+(\w+)\s+(\d+)،\s*(.+)/
                        );
                        if (!rawMatch) {
                            console.log(`⚠️ Could not parse deadline for ${activity.name}: "${deadlineText}"`);
                            continue;
                        }

                        const day   = parseInt(rawMatch[2]);
                        const monthName = rawMatch[3];
                        const year  = parseInt(rawMatch[4]);
                        const timeStr = rawMatch[5].trim();

                        const months = {
                            'January':1,'February':2,'March':3,'April':4,
                            'May':5,'June':6,'July':7,'August':8,
                            'September':9,'October':10,'November':11,'December':12
                        };
                        const month = months[monthName];
                        if (!month) {
                            console.log(`⚠️ Unknown month "${monthName}" for ${activity.name}`);
                            continue;
                        }

                        // Parse time (12h or 24h)
                        let hours = 23, minutes = 59;
                        const timeMatch12 = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
                        const timeMatch24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
                        if (timeMatch12) {
                            hours = parseInt(timeMatch12[1]);
                            minutes = parseInt(timeMatch12[2]);
                            const period = timeMatch12[3].toUpperCase();
                            if (period === 'PM' && hours !== 12) hours += 12;
                            else if (period === 'AM' && hours === 12) hours = 0;
                        } else if (timeMatch24) {
                            hours = parseInt(timeMatch24[1]);
                            minutes = parseInt(timeMatch24[2]);
                        }

                        // Build deadline using local system time (Windows-friendly)
                        const deadlineLocal = new Date(year, month - 1, day, hours, minutes, 0);

                        const msUntilDeadline = deadlineLocal.getTime() - nowLocal.getTime();
                        const hoursUntilDeadline = msUntilDeadline / (1000 * 60 * 60);

                        console.log(
                            `📅 ${activity.name}: deadline Local=${deadlineLocal.toISOString()}, ` +
                            `now Local=${nowLocal.toISOString()}, hoursLeft=${hoursUntilDeadline.toFixed(2)}`
                        );

                        if (hoursUntilDeadline <= 0) {
                            console.log(`⏭️ Skipping reminder for ${activity.name} - deadline has passed`);
                            continue;
                        }

                        if (hoursUntilDeadline > 24) {
                            console.log(`✅ ${activity.name}: ${hoursUntilDeadline.toFixed(1)}h left, no reminder yet`);
                            continue;
                        }

                        const dateInfo = this.formatPersianDate(deadlineText);
                        let message = `⏰ *یادآوری: مهلت ${isQuiz ? 'آزمون' : 'تکلیف'} رو به پایان است!*\n\n`;
                        message += `🎓 درس: ${course.name}\n`;
                        message += `📂 بخش: ${sectionName}\n\n`;
                        message += `${isQuiz ? '❓' : '📝'} ${activity.name}\n\n`;
                        message += `⏰ ${isQuiz ? 'بسته می‌شود' : 'مهلت'}: ${dateInfo.formatted}\n`;

                        const hoursRemaining  = Math.floor(hoursUntilDeadline);
                        const minutesRemaining = Math.floor((hoursUntilDeadline - hoursRemaining) * 60);

                        if (hoursRemaining === 0) {
                            message += `🔴 *فقط ${minutesRemaining} دقیقه دیگر!*`;
                        } else {
                            message += `🔴 *فقط ${hoursRemaining} ساعت و ${minutesRemaining} دقیقه دیگر!*`;
                        }

                        const targetChatIds = this.getCourseTargetChatIds(courseId, course.url);
                        console.log(`📤 Sending reminder for "${activity.name}" to chats: ${targetChatIds.map(target => `${target.platform}:${target.chatId}`).join(', ')}`);

                        await this.sendTelegramMessage(message, {
                            chatIds: targetChatIds,
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: `🔗 مشاهده ${isQuiz ? 'آزمون' : 'تکلیف'}`, url: activity.url }
                                ]]
                            }
                        });

                        const reminderRecord = {
                            sentAt: nowLocal.toISOString(),
                            deadline: deadlineLocal.toISOString(),
                            courseName: course.name,
                            activityName: activity.name
                        };

                        this.sentLastDayReminders[lastDayReminderKey] = reminderRecord;
                        const reminderKey = `${courseId}_${activity.url}`;
                        this.sentReminders[reminderKey] = reminderRecord;

                        await this.saveData();

                        console.log(`⏰ Sent last-day reminder for: ${activity.name}`);
                        await new Promise(r => setTimeout(r, 2000));

                    } catch (error) {
                        console.error(`Error checking reminder for ${activity.name}:`, error.message);
                    }
                }
            }
        }

        console.log('✅ Reminder check completed');
    }

    async checkAllCourses() {
        console.log('\n' + '='.repeat(50));
        console.log('🔄 Starting course check cycle...');
        console.log('='.repeat(50) + '\n');
        try {
            if (this.isInQuietHours && this.isInQuietHours()) {
                console.log('⏸️ Within quiet hours (00:30-07:30). Skipping this check cycle.');
                return;
            }
        } catch (err) {
            console.error('Error checking quiet hours:', err.message);
        }
        try {
            if (!CONFIG.vu.courseUrls || CONFIG.vu.courseUrls.length === 0) {
                console.log('⚠️ No COURSES configured, skipping check cycle.');
                return;
            }

            console.log('🔍 Checking session state...');
            await this.ensureLoggedIn();

            for (const courseUrl of CONFIG.vu.courseUrls) {
                try {
                    await this.ensureLoggedIn();
                    try {
                        await this.runWithTimeout(this.checkCourse(courseUrl), 120000, `Course check timed out for ${courseUrl}`);
                    } catch (timeoutErr) {
                        console.error(`⏱️ Timeout while checking course ${courseUrl}:`, timeoutErr.message);
                        continue;
                    }
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (error) {
                    console.error(`❌ Error checking course ${courseUrl}:`, error.message);
                    if (
                        error.message.includes('LOGIN_REQUIRED') ||
                        error.message.includes('timeout') ||
                        error.message.includes('Request timeout')
                    ) {
                        console.log('🔄 Resetting session and re-logging in...');
                        try {
                            this.resetSession();
                            await this.login();
                            console.log('✅ Successfully recovered from error');
                        } catch (recoveryError) {
                            console.error('❌ Failed to recover:', recoveryError.message);
                        }
                    }
                }
            }
            console.log('\n✅ Check cycle completed\n');
            
            await this.clearBrowserCache();
            
            try {
                await this.sendOrUpdateDeadlineOverview();
            } catch (err) {
                console.error('Error updating deadline overview:', err.message);
            }
            
            await this.checkAndSendReminders();
            if (this.isFirstRun) {
                this.isFirstRun = false;
            }
        } catch (error) {
            console.error('❌ Error during check cycle:', error.message);
            try {
                for (const platform of CONFIG.activePlatforms) {
                    const platformConfig = this.getPlatformConfig(platform);
                    if (!platformConfig?.token || !platformConfig.adminChatId) {
                        continue;
                    }
                    const formattedError = this.formatForPlatform(
                        `🚨 <b>خرابی در چرخه بررسی دوره‌ها</b>\n\n${error.message}`,
                        platform
                    );
                    await getBot(platform).sendMessage(
                        platformConfig.adminChatId,
                        formattedError.text,
                        { parse_mode: formattedError.parse_mode }
                    );
                }
            } catch (telegramError) {
                console.error('Failed to send error notification:', telegramError.message);
            }
        }
    }
    async runWithTimeout(promise, ms, errMsg) {
        return await Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(errMsg || 'Operation timed out')), ms))
        ]);
    }
    async start() {
        await this.initialize();
        await this.cleanupNonGlobalOverviewMessages();
        await this.cleanupPerCourseDeadlineMessages();
        await this.checkAllCourses();
        console.log('⏳ Startup check completed');
        const cronExpression = `*/${CONFIG.checkInterval} * * * *`;
        const job = new CronJob(
            cronExpression,
            async () => {
                await this.checkAllCourses();
            },
            null,
            true,
            'Asia/Tehran'
        );
        this.cronJob = job;
        console.log(`⏰ Scheduled to run every ${CONFIG.checkInterval} minutes (Asia/Tehran timezone)`);
        console.log(`ℹ️ Subsequent checks will run on the configured interval`);
    }
    async stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            console.log('⏰ Cron job stopped');
        }
        this.resetSession();
        process.exit(0);
    }
    pruneExpired(courseId) {
        if (!this.courseData[courseId]) return;
        const course = this.courseData[courseId];
        if (!course.assignments) return;
        const assignments = course.assignments;
        const toDelete = [];
        for (const [url, details] of Object.entries(assignments)) {
            const deadlineField = details.deadline ? 'deadline' : (details.closed ? 'closed' : null);
            if (!deadlineField) continue;
            const info = this.formatPersianDate(details[deadlineField]);
            if (info.daysRemaining !== null && info.daysRemaining < 0) {
                toDelete.push(url);
            }
        }
        for (const url of toDelete) {
            delete assignments[url];
            if (course.sentNotifications && course.sentNotifications[url]) {
                delete course.sentNotifications[url];
            }
        }
        if (course.sentFiles) {
            const currentFileUrls = new Set();
            for (const details of Object.values(assignments)) {
                for (const att of details.attachments || []) {
                    currentFileUrls.add(att.url);
                }
            }
            const fileToDelete = [];
            for (const fileUrl of Object.keys(course.sentFiles)) {
                if (!currentFileUrls.has(fileUrl)) {
                    fileToDelete.push(fileUrl);
                }
            }
            for (const f of fileToDelete) {
                delete course.sentFiles[f];
            }
        }
    }
    cleanExpiredReminders() {
        const now = new Date();
        const fields = ['sentReminders', 'sentLastDayReminders'];
        for (const field of fields) {
            const toDelete = [];
            for (const [key, item] of Object.entries(this[field])) {
                if (item.deadline && new Date(item.deadline) < now) {
                    toDelete.push(key);
                }
            }
            for (const k of toDelete) {
                delete this[field][k];
            }
        }
    }
}
if (require.main === module) {
    const configuredPlatforms = CONFIG.activePlatforms.filter(platform => CONFIG.platforms[platform]?.token);
    if (configuredPlatforms.length === 0) {
        throw new Error('No bot token is configured. Set BALE_BOT_TOKEN and/or TG_BOT_TOKEN in .env.');
    }
    for (const platform of configuredPlatforms) {
        getBot(platform);
    }
    monitor = new VUMonitor();
    monitor.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
    process.on('SIGINT', async () => {
        console.log('\n\n🛑 Shutting down...');
        await monitor.stop();
    });
    process.on('SIGTERM', async () => {
        console.log('\n\n🛑 Shutting down...');
        await monitor.stop();
    });
}

module.exports = {
    CONFIG,
    VUMonitor
};
