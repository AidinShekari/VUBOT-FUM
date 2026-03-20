require('dotenv').config();
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const { CronJob } = require('cron');
const fs = require('fs').promises;
const http = require('http');
const https = require('https');
const moment = require('moment-jalaali');
const API_PROVIDER = (process.env.API_PROVIDER || process.env.TELEGRAM_API_PROVIDER || 'BALE').trim().toUpperCase();
const API_BASE_URL = (
    process.env.API_BASE_URL || process.env.TELEGRAM_API_BASE_URL ||
    (API_PROVIDER === 'TELEGRAM' ? 'https://api.telegram.org' : 'https://tapi.bale.ai')
).replace(/\/+$/, '');
const parseCsv = (value) => (value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
const parseCoursesFromEnv = () => {
    const raw = (process.env.COURSES || '').trim();
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map(item => {
                    if (typeof item === 'string') {
                        return { url: item.trim(), chatId: '' };
                    }
                    if (!item || typeof item !== 'object') return null;
                    const url = typeof item.url === 'string' ? item.url.trim() : '';
                    const chatId = item.chatId === undefined || item.chatId === null
                        ? ''
                        : String(item.chatId).trim();
                    if (!url) return null;
                    return { url, chatId };
                })
                .filter(Boolean);
        } catch (error) {
            console.error('Invalid COURSES JSON in env:', error.message);
            return [];
        }
    }

    // Backward compatibility with old COURSE_URLS + COURSE_CHAT_IDS envs.
    const legacyUrls = parseCsv(process.env.COURSE_URLS);
    const legacyChatIds = parseCsv(process.env.COURSE_CHAT_IDS);
    return legacyUrls.map((url, i) => ({
        url,
        chatId: (legacyChatIds[i] || '').trim()
    }));
};
const getCourseIdFromUrl = (url) => {
    try {
        return new URL(url).searchParams.get('id') || '';
    } catch (error) {
        return '';
    }
};
const buildCourseChatIdMap = (courses) => {
    const map = {};
    for (const course of courses) {
        const url = (course && course.url ? String(course.url) : '').trim();
        const chatId = (course && course.chatId ? String(course.chatId) : '').trim();
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
const COURSE_CHAT_ID_MAP = buildCourseChatIdMap(COURSES);
const CONFIG = {
    telegram: {
        token: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
        globalChatId: process.env.GLOBAL_CHAT_ID || process.env.GLOBAL_TELEGRAM_CHAT_ID || process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID,
        topicId: (process.env.TOPIC_ID || process.env.TELEGRAM_TOPIC_ID) ? parseInt(process.env.TOPIC_ID || process.env.TELEGRAM_TOPIC_ID) : null,
        adminChatId: process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID || ''
    },
    vu: {
        username: "4042350",
        password: "Shekari!@#$5",
        courseUrls: COURSE_URLS,
        courseChatIdMap: COURSE_CHAT_ID_MAP
    },
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 5,
    debug: process.env.DEBUG_MODE === 'true' || false,
    chromePath: process.env.CHROME_PATH || null,
    httpProxy: process.env.HTTP_PROXY || null,
    quietHoursEnabled: false  // true = quiet hours فعال، false = غیرفعال
};
if (CONFIG.httpProxy) {
    console.log('Using Proxy:', CONFIG.httpProxy);
}
const botOptions = {
    polling: true,
    baseApiUrl: API_BASE_URL
};
if (CONFIG.httpProxy) {
    botOptions.request = { proxy: CONFIG.httpProxy };
}
const bot = new TelegramBot(CONFIG.telegram.token, botOptions);
let monitor = null;
const DATA_FILE = 'course_data.json';
class VUMonitor {
    constructor() {
        this.browser = null;
        this.page = null;
        this.courseData = {};
        this.cronJob = null;
        this.isFirstRun = false;
        this.courseMessageIds = {};
        this.sentReminders = {};
        this.sentLastDayReminders = {};
        this.deadlineMessageId = null;
    }
    getCourseExtraChatId(courseId, courseUrl = '') {
        if (courseId && CONFIG.vu.courseChatIdMap[courseId]) {
            return CONFIG.vu.courseChatIdMap[courseId];
        }
        if (courseUrl && CONFIG.vu.courseChatIdMap[courseUrl]) {
            return CONFIG.vu.courseChatIdMap[courseUrl];
        }
        return null;
    }
    getCourseTargetChatIds(courseId, courseUrl = '') {
        const targets = new Set();
        if (CONFIG.telegram.globalChatId) {
            targets.add(String(CONFIG.telegram.globalChatId));
        }
        const extraChatId = this.getCourseExtraChatId(courseId, courseUrl);
        if (extraChatId) {
            targets.add(String(extraChatId));
        }
        return Array.from(targets);
    }
    getChatScopedOptions(baseOptions, chatId) {
        const options = { ...baseOptions };
        if (CONFIG.telegram.topicId && String(chatId) === String(CONFIG.telegram.globalChatId)) {
            options.message_thread_id = CONFIG.telegram.topicId;
        }
        return options;
    }
    getStoredCourseMessageIds(courseId, chatId) {
        const stored = this.courseMessageIds[courseId];
        const key = String(chatId);
        if (Array.isArray(stored)) {
            if (String(CONFIG.telegram.globalChatId) === key) {
                return stored;
            }
            return [];
        }
        if (stored && typeof stored === 'object' && Array.isArray(stored[key])) {
            return stored[key];
        }
        return [];
    }
    setStoredCourseMessageIds(courseId, chatId, ids) {
        const key = String(chatId);
        const prev = this.courseMessageIds[courseId];
        if (!prev || Array.isArray(prev)) {
            this.courseMessageIds[courseId] = {};
            if (Array.isArray(prev) && CONFIG.telegram.globalChatId) {
                this.courseMessageIds[courseId][String(CONFIG.telegram.globalChatId)] = prev;
            }
        }
        this.courseMessageIds[courseId][key] = ids;
    }
    findChromePath() {
        const possiblePaths = process.platform === 'win32' ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
        ] : [
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/snap/bin/chromium'
        ];
        
            const chromePath = possiblePaths.find(path => path && require('fs').existsSync(path));
            if (chromePath) {
                return chromePath;
            }
        
        return null;
    }
    async isBrowserHealthy() {
        try {
            if (!this.browser || !this.browser.isConnected()) {
                return false;
            }
            if (!this.page || this.page.isClosed()) {
                return false;
            }
            await this.page.evaluate(() => true);
            return true;
        } catch (error) {
            console.log('⚠️ Browser health check failed:', error.message);
            return false;
        }
    }
    
    async clearBrowserCache() {
        try {
            if (!this.page || this.page.isClosed()) {
                return;
            }
            
            const client = await this.page.target().createCDPSession();
            await client.send('Network.clearBrowserCache');
            await client.send('Network.clearBrowserCookies');
            await client.detach();
            
            console.log('🧹 Browser cache cleared');
        } catch (error) {
            console.log('⚠️ Could not clear browser cache:', error.message);
        }
    }
    async initialize() {
        console.log('🚀 Initializing VU Monitor...');
        
        await this.loadData();
        
        if (this.browser) {
            try {
                await this.browser.close();
                console.log('🔄 Closed existing browser');
            } catch (error) {
                console.log('⚠️ Error closing existing browser:', error.message);
            }
        }
        const chromePath = CONFIG.chromePath || this.findChromePath() || '/usr/bin/chromium-browser';
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disk-cache-size=0',
            '--media-cache-size=0'
        ];
        if (CONFIG.httpProxy) {
            launchArgs.push(`--proxy-server=${CONFIG.httpProxy}`);
        }

        this.browser = await puppeteer.launch({
            headless: true,
            executablePath: chromePath,
            args: launchArgs
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1920, height: 1080 });
        
        // Disable cache to prevent disk usage buildup
        await this.page.setCacheEnabled(false);
        
        await new Promise(r => setTimeout(r, 1000));
        console.log('✅ Browser initialized');
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
            this.deadlineMessageId = JSON.parse(deadlineMsgData).messageId;
            console.log('⏰ Loaded deadline message ID');
        } catch (error) {
            console.log('⏰ No deadline message ID found');
            this.deadlineMessageId = null;
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
        if (this.deadlineMessageId) {
            await fs.writeFile('deadline_message_id.json', JSON.stringify({ messageId: this.deadlineMessageId }, null, 2));
        }
    }
    async login() {
        console.log('🔐 Logging in...');
        
        const maxRetries = 3;
        let retryCount = 0;
        
        while (retryCount < maxRetries) {
            try {
                const isHealthy = await this.isBrowserHealthy();
                if (!isHealthy) {
                    console.log('🔧 Browser not healthy, reinitializing...');
                    await this.initialize();
                }
                
                console.log('📍 Navigating to VU login page...');
                await this.page.goto('https://vu.um.ac.ir/login/index.php', {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
                
                await new Promise(r => setTimeout(r, 5000));
                const loginBtnSelector = '.btn.login-identityprovider-btn.btn-block';
                try {
                    await this.page.waitForSelector(loginBtnSelector, { timeout: 10000 });
                    await this.page.click(loginBtnSelector);
                    console.log('🔘 Clicked OAuth2 button');
                    await new Promise(r => setTimeout(r, 5000));
                } catch (err) {
                    console.log('⚠️ OAuth2 button not found or already redirected:', err.message);
                }
                console.log('⏳ Waiting for login page...');
                await this.page.waitForSelector('input[name="UserID"], input[placeholder*="کاربری"]', { timeout: 30000 });
                
                await new Promise(r => setTimeout(r, 2000));
                
                await this.page.evaluate(() => {
                    const inputs = document.querySelectorAll('input');
                    inputs.forEach(input => input.value = '');
                });
                
                console.log('📝 Entering credentials...');
                const usernameSelector = await this.page.$('input[name="UserID"]') ? 'input[name="UserID"]' : 'input[placeholder*="کاربری"]';
                const passwordSelector = await this.page.$('input[name="password"]') ? 'input[name="password"]' : 'input[placeholder*="رمز"]';
                
                await this.page.waitForSelector(usernameSelector, { visible: true, timeout: 10000 });
                await this.page.click(usernameSelector);
                await this.page.type(usernameSelector, CONFIG.vu.username, { delay: 100 });
                
                await this.page.waitForSelector(passwordSelector, { visible: true, timeout: 10000 });
                await this.page.click(passwordSelector);
                await this.page.type(passwordSelector, CONFIG.vu.password, { delay: 100 });
                
                const captchaImg = await this.page.$('#captcha-img');
                if (captchaImg) {
                    console.log('🧩 Captcha detected, handling...');
                    
                    const captchaSrc = await this.page.$eval('#captcha-img', el => el.src);
                    const base64Data = captchaSrc.replace(/^data:image\/\w+;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    await bot.sendPhoto(CONFIG.telegram.adminChatId, buffer, {
                        caption: '🔒 لطفا کد امنیتی را وارد کنید:'
                    });
                    
                    const captchaCode = await this.waitForTelegramResponse();
                    console.log(`✅ Captcha code received: ${captchaCode}`);
                    
                    await this.page.type('input[name="mysecpngco"]', captchaCode);
                    
                    await new Promise(r => setTimeout(r, 1000));
                }
                console.log('🔐 Submitting login form...');
                
                const navigationPromise = this.page.waitForNavigation({
                    waitUntil: ['domcontentloaded', 'networkidle2'],
                    timeout: 120000
                }).catch(err => {
                    console.log('⚠️ Navigation timeout, checking if login succeeded anyway...');
                    return null;
                });
                
                const loginButtonClicked = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const loginButton = buttons.find(button => button.textContent.includes('ورود'));
                    if (loginButton) {
                        loginButton.click();
                        return true;
                    }
                    return false;
                });
                
                if (!loginButtonClicked) {
                    throw new Error('Login button not found');
                }
                
                console.log('⏳ Waiting for login redirect...');
                await navigationPromise;
                
                console.log('⏳ Waiting for session to establish...');
                await new Promise(r => setTimeout(r, 8000));
                
                const currentUrl = this.page.url();
                console.log(`📍 Current URL after login: ${currentUrl}`);
                
                if (currentUrl.includes('vu.um.ac.ir')) {
                    console.log('✅ Login successful');
                    return;
                } else {
                    throw new Error('Login failed - unexpected URL: ' + currentUrl);
                }
            } catch (error) {
                retryCount++;
                console.error(`❌ Login attempt ${retryCount} failed:`, error.message);
                
                if (retryCount < maxRetries) {
                    console.log(`🔄 Retrying login (${retryCount}/${maxRetries})...`);
                    
                    try {
                        console.log('🔄 Reinitializing browser for retry...');
                        await this.initialize();
                        console.log('✅ Browser reinitialized');
                    } catch (initError) {
                        console.error('Error reinitializing browser:', initError.message);
                        await new Promise(r => setTimeout(r, 5000));
                        try {
                            await this.initialize();
                        } catch (finalError) {
                            throw new Error(`Failed to reinitialize browser: ${finalError.message}`);
                        }
                    }
                    
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    throw new Error(`Login failed after ${maxRetries} attempts: ${error.message}`);
                }
            }
        }
    }
    async waitForTelegramResponse() {
        console.log('⏳ Waiting for captcha code from Telegram...');
        
        return new Promise((resolve) => {
            const checkUpdates = async () => {
                try {
                    const updates = await bot.getUpdates({
                        offset: -1,
                        limit: 1,
                        timeout: 0
                    });
                    if (updates.length > 0) {
                        const update = updates[0];
                        const message = update.message;
                        
                        if (message &&
                            message.chat.id.toString() === CONFIG.telegram.adminChatId &&
                            message.text &&
                            (Date.now() / 1000 - message.date) < 30) {
                            
                            await bot.sendMessage(CONFIG.telegram.adminChatId, '✅ کد دریافت شد, در حال ورود...');
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
        
        try {
            await this.page.goto(courseUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 90000
            });
            
            await new Promise(r => setTimeout(r, 4000));
            
            console.log(`📍 Navigated to: ${this.page.url()}`);
        } catch (error) {
            console.error(`❌ Failed to navigate to course: ${error.message}`);
            throw error;
        }
        const courseName = await this.page.evaluate(() => {
            const breadcrumb = document.querySelector('.breadcrumb li:last-child');
            if (breadcrumb) {
                return breadcrumb.textContent.trim();
            }
            
            const header = document.querySelector('.page-header-headings h1');
            if (header) {
                return header.textContent.trim();
            }
            
            return 'Unknown Course';
        });
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
        let sections;
        try {
            sections = await this.extractSections();
        } catch (error) {
            if (error && error.message === 'LOGIN_REQUIRED') {
                console.log('🔐 Login required detected while extracting sections. Attempting to login and retry once...');
                try {
                    await this.login();
                    sections = await this.extractSections();
                } catch (err) {
                    console.error('❌ Still cannot extract sections after login attempt:', err.message);
                    return { hasChanges: false, newItems: [], updatedItems: [] };
                }
            } else {
                throw error;
            }
        }
        
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
    async extractSections() {
        const sections = {};
        try {
            await new Promise(r => setTimeout(r, 5000));
            const currentUrl = await this.page.url();
            try {
                const loginIndicators = await this.page.evaluate(() => {
                    const hasLoginInputs = !!(
                        document.querySelector('input[name="UserID"]') ||
                        document.querySelector('input[placeholder*="کاربری"]') ||
                        document.querySelector('input[name="password"]') ||
                        document.querySelector('input[placeholder*="رمز"]')
                    );
                    const hasLoginForm = !!(
                        document.querySelector('form[action*="login"]') ||
                        document.querySelector('.loginform') ||
                        document.querySelector('#page-login-index')
                    );
                    return { hasLoginInputs, hasLoginForm };
                });
                if (currentUrl.includes('oauth.um.ac.ir') || currentUrl.includes('login') || loginIndicators.hasLoginInputs || loginIndicators.hasLoginForm) {
                    console.log('🔐 Page appears to be a login page — aborting extraction');
                    throw new Error('LOGIN_REQUIRED');
                }
            } catch (err) {
            }
            const activities = await this.page.evaluate(() => {
                const result = {};
                
                // New Moodle 4.x structure with data-for="section" attributes
                let sectionElements = document.querySelectorAll('li.section.course-section[data-for="section"]');
                
                // Fallback selectors for different Moodle versions
                if (sectionElements.length === 0) {
                    sectionElements = document.querySelectorAll('ul.topics > li.section');
                }
                if (sectionElements.length === 0) {
                    sectionElements = document.querySelectorAll('ul.weeks > li.section');
                }
                if (sectionElements.length === 0) {
                    sectionElements = document.querySelectorAll('li.section');
                }
                
                sectionElements.forEach((section, index) => {
                    let sectionName = '';
                    
                    // New structure: h3 with sectionname class and data-for="section_title"
                    const sectionNameElement = section.querySelector('h3.sectionname[data-for="section_title"]') ||
                                             section.querySelector('h3[class*="sectionname"]') ||
                                             section.querySelector('.sectionname') ||
                                             section.querySelector('h3');
                    
                    if (sectionNameElement) {
                        sectionName = sectionNameElement.textContent.trim();
                    }
                    
                    if (!sectionName || sectionName === '') {
                        sectionName = `بخش ${index}`;
                    }
                    
                    const activities = [];
                    
                    // New structure: activities within ul[data-for="cmlist"]
                    let activityContainer = section.querySelector('ul[data-for="cmlist"]') || section;
                    let activityElements = activityContainer.querySelectorAll('li.activity[data-for="cmitem"]');
                    
                    // Fallback selectors
                    if (activityElements.length === 0) {
                        activityElements = activityContainer.querySelectorAll('li.activity.activity-wrapper');
                    }
                    if (activityElements.length === 0) {
                        activityElements = activityContainer.querySelectorAll('li.activity');
                    }
                    if (activityElements.length === 0) {
                        activityElements = section.querySelectorAll('li[class*="modtype_"]');
                    }
                    
                    activityElements.forEach(activity => {
                        let activityName = 'Unknown';
                        
                        // Best method: use data-activityname attribute from .activity-item
                        const activityItem = activity.querySelector('.activity-item[data-activityname]');
                        if (activityItem && activityItem.dataset.activityname) {
                            activityName = activityItem.dataset.activityname.trim();
                        } else {
                            // Fallback: extract from .instancename, removing hidden elements
                            const instanceElement = activity.querySelector('.instancename') ||
                                                  activity.querySelector('.activityname a span') ||
                                                  activity.querySelector('.activityname');
                            
                            if (instanceElement) {
                                const clone = instanceElement.cloneNode(true);
                                const iconsToRemove = clone.querySelectorAll('.accesshide, .badge, .sr-only');
                                iconsToRemove.forEach(icon => icon.remove());
                                activityName = clone.textContent.trim();
                            }
                        }
                        
                        // Extract activity type from class (modtype_resource, modtype_forum, etc.)
                        const activityType = activity.className.match(/modtype_(\w+)/)?.[1] ||
                                            activity.className.match(/modtype-(\w+)/)?.[1] ||
                                            'unknown';
                        
                        // Extract activity URL
                        const activityLink = activity.querySelector('a.aalink.stretched-link') ||
                                            activity.querySelector('a.aalink') ||
                                            activity.querySelector('a[href*="/mod/"]') ||
                                            activity.querySelector('.activityname a');
                        const activityUrl = activityLink ? activityLink.href : '';
                        
                        if (activityName && activityName !== 'Unknown' && activityUrl) {
                            activities.push({
                                name: activityName,
                                type: activityType,
                                url: activityUrl
                            });
                        }
                    });
                    
                    if (activities.length > 0) {
                        result[sectionName] = activities;
                    }
                });
                
                return result;
            });
            return activities;
        } catch (error) {
            console.error('Error extracting sections:', error.message);
            return {};
        }
    }
    async extractQuizDetails(quizUrl) {
        try {
            await this.page.goto(quizUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await new Promise(r => setTimeout(r, 3000));
            const details = await this.page.evaluate(() => {
                let opened = 'نامشخص';
                let closed = 'نامشخص';
                
                const activityDates = document.querySelector('[data-region="activity-dates"]');
                if (activityDates) {
                    const datesDivs = activityDates.querySelectorAll('.description-inner > div');
                    
                    datesDivs.forEach(div => {
                        const text = div.textContent;
                        
                        if (text.includes('باز شده:') || text.includes('Opened:')) {
                            const match = text.match(/(?:باز شده:|Opened:)\s*(.+)/);
                            if (match) {
                                opened = match[1].trim();
                            }
                        }
                        
                        if (text.includes('بسته شده:') || text.includes('Closed:')) {
                            const match = text.match(/(?:بسته شده:|Closed:)\s*(.+)/);
                            if (match) {
                                closed = match[1].trim();
                            }
                        }
                    });
                }
                return { opened, closed };
            });
            return { success: true, ...details };
        } catch (error) {
            console.error('Error extracting quiz details:', error.message);
            return { success: false, error: error.message };
        }
    }
    async extractResourceFileUrl(resourceUrl) {
        try {
            // Try to download directly from resource URL by following redirects with cookies
            // Moodle's mod/resource/view.php redirects to the actual pluginfile.php
            const result = await this.followRedirectsForFileUrl(resourceUrl);
            if (result && result.url) {
                return result;
            }
            
            // Fallback: use Puppeteer to navigate and extract URL
            await this.page.goto(resourceUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await new Promise(r => setTimeout(r, 3000));
            
            // Check if we were redirected directly to the file
            const currentUrl = this.page.url();
            if (currentUrl.includes('pluginfile.php')) {
                const fileName = decodeURIComponent(currentUrl.split('/').pop().split('?')[0]);
                return { url: currentUrl, fileName };
            }
            
            // Extract file URL from resource page
            const fileInfo = await this.page.evaluate(() => {
                // Look for direct download link
                const resourceLink = document.querySelector('.resourceworkaround a[href*="pluginfile.php"]') ||
                                   document.querySelector('.resourcecontent a[href*="pluginfile.php"]') ||
                                   document.querySelector('a[href*="pluginfile.php"]');
                
                if (resourceLink) {
                    const url = resourceLink.href;
                    const fileName = resourceLink.textContent.trim() || 
                                   decodeURIComponent(url.split('/').pop().split('?')[0]);
                    return { url, fileName };
                }
                
                // Look for embedded object/iframe
                const objectTag = document.querySelector('object[data*="pluginfile.php"]');
                if (objectTag) {
                    const url = objectTag.data;
                    const fileName = decodeURIComponent(url.split('/').pop().split('?')[0]);
                    return { url, fileName };
                }
                
                const iframeTag = document.querySelector('iframe[src*="pluginfile.php"]');
                if (iframeTag) {
                    const url = iframeTag.src;
                    const fileName = decodeURIComponent(url.split('/').pop().split('?')[0]);
                    return { url, fileName };
                }
                
                return null;
            });
            
            return fileInfo;
        } catch (error) {
            console.error('Error extracting resource file URL:', error.message);
            return null;
        }
    }
    
    async followRedirectsForFileUrl(startUrl, redirectsLeft = 10) {
        // Follow redirects with session cookies using GET to find the final file URL
        // Moodle redirects resource/view.php to pluginfile.php
        if (redirectsLeft < 0) {
            return null;
        }

        const cookies = await this.page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const userAgent = await this.page.evaluate(() => navigator.userAgent);

        const urlObj = new URL(startUrl);
        const client = urlObj.protocol === 'https:' ? https : http;

        return await new Promise((resolve) => {
            const req = client.request(urlObj, {
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': userAgent,
                    'Accept': '*/*'
                },
                timeout: 30000
            }, (res) => {
                const statusCode = res.statusCode || 0;
                const headers = res.headers || {};

                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                    res.resume(); // Discard body
                    const redirectUrl = new URL(headers.location, startUrl).toString();
                    console.log(`↪️ Redirect ${statusCode}: ${redirectUrl}`);
                    this.followRedirectsForFileUrl(redirectUrl, redirectsLeft - 1)
                        .then(resolve)
                        .catch(() => resolve(null));
                    return;
                }

                if (statusCode >= 200 && statusCode < 300) {
                    const contentType = (headers['content-type'] || '').toString();
                    const contentDisposition = (headers['content-disposition'] || '').toString();
                    
                    // Check if this is a file (not HTML)
                    if (!contentType.includes('text/html')) {
                        let fileName = '';
                        
                        // Try to get filename from Content-Disposition header
                        // Format: attachment; filename="file.pdf" or filename*=UTF-8''file.pdf
                        const filenameMatch = contentDisposition.match(/filename[*]?=['"]?(?:UTF-8'')?([^'";]+)/i);
                        if (filenameMatch) {
                            fileName = decodeURIComponent(filenameMatch[1].trim());
                        } else {
                            // Extract from URL
                            fileName = decodeURIComponent(startUrl.split('/').pop().split('?')[0]);
                        }
                        
                        console.log(`✅ Found file: ${fileName} (${contentType})`);
                        
                        // Read the body since we need it
                        const chunks = [];
                        res.on('data', (chunk) => chunks.push(chunk));
                        res.on('end', () => {
                            resolve({ 
                                url: startUrl, 
                                fileName, 
                                contentType,
                                buffer: Buffer.concat(chunks)
                            });
                        });
                        return;
                    } else {
                        // Got HTML - might be login page or error
                        const chunks = [];
                        res.on('data', (chunk) => chunks.push(chunk));
                        res.on('end', () => {
                            const html = Buffer.concat(chunks).toString('utf8');
                            console.log(`⚠️ Got HTML response (first 200 chars): ${html.substring(0, 200)}`);
                            resolve(null);
                        });
                        return;
                    }
                }
                
                res.resume();
                console.log(`⚠️ Unexpected status ${statusCode} for ${startUrl}`);
                resolve(null);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.on('error', (err) => {
                console.log(`⚠️ Request error: ${err.message}`);
                resolve(null);
            });
            req.end();
        });
    }
    async extractAssignmentDetails(assignmentUrl) {
        try {
            await this.page.goto(assignmentUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await new Promise(r => setTimeout(r, 3000));
            const details = await this.page.evaluate(() => {
                let opened = 'نامشخص';
                let deadline = 'نامشخص';
                const attachments = [];
                
                const activityDates = document.querySelector('[data-region="activity-dates"]');
                if (activityDates) {
                    const datesDivs = activityDates.querySelectorAll('.description-inner > div');
                    
                    datesDivs.forEach(div => {
                        const text = div.textContent;
                        
                        if (text.includes('باز شده:') || text.includes('Opened:')) {
                            const match = text.match(/(?:باز شده:|Opened:)\s*(.+)/);
                            if (match) {
                                opened = match[1].trim();
                            }
                        }
                        
                        if (text.includes('مهلت:') || text.includes('Due:')) {
                            const match = text.match(/(?:مهلت:|Due:)\s*(.+)/);
                            if (match) {
                                deadline = match[1].trim();
                            }
                        }
                    });
                }
                
                const introSection = document.querySelector('.activity-description#intro') ||
                                    document.querySelector('div.activity-description') ||
                                    document.querySelector('#intro');
                
                if (introSection) {
                    const fileLinks = introSection.querySelectorAll('a[href*="pluginfile.php"]');
                    
                    fileLinks.forEach(link => {
                        const url = link.href;
                        let fileName = link.textContent.trim();
                        
                        if (!fileName || fileName === '') {
                            const urlParts = url.split('/');
                            fileName = urlParts[urlParts.length - 1].split('?')[0];
                            fileName = decodeURIComponent(fileName);
                        }
                        
                        const exists = attachments.find(a => a.url === url);
                        const isValidFile = url && fileName &&
                                          !url.includes('/theme/image.php') &&
                                          !url.includes('/core/') &&
                                          fileName.length > 2;
                        
                        if (isValidFile && !exists) {
                            attachments.push({ url, fileName });
                        }
                    });
                }
                
                if (deadline === 'نامشخص') {
                    const tables = document.querySelectorAll('.submissionstatustable, .generaltable');
                    
                    for (const table of tables) {
                        const rows = table.querySelectorAll('tr');
                        
                        for (const row of rows) {
                            const cells = row.querySelectorAll('td, th');
                            
                            for (let i = 0; i < cells.length - 1; i++) {
                                const cellText = cells[i].textContent.trim();
                                
                                if (cellText.includes('مهلت') ||
                                    cellText.includes('Due date') ||
                                    cellText.includes('تاریخ') ||
                                    cellText.toLowerCase().includes('deadline')) {
                                    
                                    deadline = cells[i + 1].textContent.trim();
                                    break;
                                }
                            }
                            
                            if (deadline !== 'نامشخص') break;
                        }
                        
                        if (deadline !== 'نامشخص') break;
                    }
                }
                return { opened, deadline, attachments };
            });
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
            
            // Check if we got an HTML page (login redirect) instead of a file
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
                let n = (name || '').trim();
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
            
            if (CONFIG.telegram.topicId) {
                sendOptions.message_thread_id = CONFIG.telegram.topicId;
            }
            
            if (buffer.length > 5 * 1024 * 1024) {
                console.log(`⚠️ File too large (${(buffer.length / 1024 / 1024).toFixed(2)} MB), sending link only`);
                await this.sendTelegramMessage(`📎 فایل خیلی بزرگ است (${(buffer.length / 1024 / 1024).toFixed(2)} MB)\n${fileName}\n🔗 ${fileUrl}`, {
                    chatIds: this.getCourseTargetChatIds(courseId)
                });
            } else {
                const targetChatIds = this.getCourseTargetChatIds(courseId);
                for (const chatId of targetChatIds) {
                    await this.sendDocumentViaApi({
                        chatId,
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

        const cookies = await this.page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const userAgent = await this.page.evaluate(() => navigator.userAgent);

        const urlObj = new URL(fileUrl);
        const client = urlObj.protocol === 'https:' ? https : http;

        return await new Promise((resolve, reject) => {
            const req = client.request(urlObj, {
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': userAgent,
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity',
                    'Connection': 'keep-alive'
                },
                timeout: 120000
            }, (res) => {
                const statusCode = res.statusCode || 0;
                const headers = res.headers || {};

                if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                    res.resume();
                    const redirectUrl = new URL(headers.location, fileUrl).toString();
                    this.downloadWithSessionCookies(redirectUrl, redirectsLeft - 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    res.resume();
                    reject(new Error(`Download failed with status ${statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        buffer: Buffer.concat(chunks),
                        contentType: (headers['content-type'] || '').toString(),
                        statusCode
                    });
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error('Download timeout'));
            });
            req.on('error', reject);
            req.end();
        });
    }
    async sendDocumentViaApi({ chatId, buffer, fileName, caption, contentType }) {
        const boundary = `----NodeBoundary${Date.now().toString(16)}`;
        const safeFileName = (fileName || 'file.bin').replace(/\"/g, '');
        const mimeType = contentType || 'application/octet-stream';

        const fields = [
            { name: 'chat_id', value: String(chatId) },
            { name: 'caption', value: caption || '' }
        ];

        if (CONFIG.telegram.topicId && String(chatId) === String(CONFIG.telegram.globalChatId)) {
            fields.push({ name: 'message_thread_id', value: String(CONFIG.telegram.topicId) });
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
        const endpoint = new URL(`${API_BASE_URL}/bot${CONFIG.telegram.token}/sendDocument`);
        const client = endpoint.protocol === 'https:' ? https : http;

        return await new Promise((resolve, reject) => {
            const req = client.request(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                },
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
    async sendOrUpdateCourseOverview(courseId, courseName, courseUrl, allSections) {
        let message = `🎓 <b>${courseName}</b>\n`;
        message += `🔗 <a href="${courseUrl}">لینک درس</a>\n\n`;
        
        let sectionsMsg = '';
        for (const [sectionName, activities] of Object.entries(allSections)) {
            let sectionMsg = `📍 <b>${sectionName}</b>\n`;
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
        message += `📃 <b>لیست رویداد ها</b>\n\n`;

        const courseDeadlines = this.collectCourseDeadlineItems(courseId);
        message += this.renderDeadlineItems(courseDeadlines, {
            emptyMessage: '✅ فعلا رویداد فعالی برای این درس وجود ندارد.\n\n'
        });

        message += `━━━━━━━━━━━━━━━━━\n`;
        message += `${this.getUpdateScheduleNotice()}\n`;
        message += `🕐 ${this.getShamsiUtcTimestamp()}`;
        const formattedMessage = this.toMarkdown(message);
        const messageParts = this.splitCourseOverviewMessage(formattedMessage);
        const baseOptions = {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        };
        const targetChatIds = this.getCourseTargetChatIds(courseId, courseUrl);

        for (const chatId of targetChatIds) {
            const existingIds = this.getStoredCourseMessageIds(courseId, chatId);
            const finalIds = [];
            const scopedOptions = this.getChatScopedOptions(baseOptions, chatId);

            try {
                for (let i = 0; i < messageParts.length; i++) {
                    const part = messageParts[i];
                    const existingId = existingIds[i];

                    if (existingId) {
                        try {
                            await bot.editMessageText(part, {
                                chat_id: chatId,
                                message_id: existingId,
                                ...scopedOptions
                            });
                            finalIds.push(existingId);
                        } catch (editErr) {
                            if (editErr.message && editErr.message.includes('message to edit not found')) {
                                const sentMsg = await bot.sendMessage(chatId, part, scopedOptions);
                                finalIds.push(sentMsg.message_id);
                            } else {
                                throw editErr;
                            }
                        }
                    } else {
                        const sentMsg = await bot.sendMessage(chatId, part, scopedOptions);
                        finalIds.push(sentMsg.message_id);
                    }
                }

                this.setStoredCourseMessageIds(courseId, chatId, finalIds);
            } catch (error) {
                console.error(`Error sending/updating course overview for chat ${chatId}:`, error.message);
                if (error.message.includes('message to edit not found')) {
                    const sentIds = [];
                    for (const part of messageParts) {
                        const sentMsg = await bot.sendMessage(chatId, part, scopedOptions);
                        sentIds.push(sentMsg.message_id);
                    }
                    this.setStoredCourseMessageIds(courseId, chatId, sentIds);
                }
            }
        }

        console.log(`✏️ Updated overview message for course ${courseId} in ${messageParts.length} part(s)`);
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
    collectCourseDeadlineItems(courseId, course = this.courseData[courseId]) {
        if (!course) {
            return [];
        }

        const items = [];
        const assignments = course.assignments || {};

        for (const [url, details] of Object.entries(assignments)) {
            let activityName = 'Unknown';
            let activityType = 'assign';

            for (const activities of Object.values(course.sections || {})) {
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
                    items.push({
                        courseId,
                        courseName: course.name,
                        activityName,
                        activityType,
                        url,
                        dateInfo: openedInfo,
                        isQuiz,
                        eventType: 'opened'
                    });
                }
            }

            if (details[deadlineField] && details[deadlineField] !== 'نامشخص') {
                const dateInfo = this.formatPersianDate(details[deadlineField]);
                if (dateInfo.daysRemaining === null || dateInfo.daysRemaining >= 0) {
                    items.push({
                        courseId,
                        courseName: course.name,
                        activityName,
                        activityType,
                        url,
                        dateInfo,
                        isQuiz,
                        eventType: 'deadline'
                    });
                }
            }
        }

        return this.sortDeadlineItems(items);
    }
    sortDeadlineItems(items) {
        return items.sort((a, b) => {
            if (a.dateInfo.daysRemaining === null) return 1;
            if (b.dateInfo.daysRemaining === null) return -1;
            return a.dateInfo.daysRemaining - b.dateInfo.daysRemaining;
        });
    }
    renderDeadlineItems(items, options = {}) {
        const {
            groupByCourse = false,
            emptyMessage = '✅ هیچ تکلیف یا آزمون فعالی وجود ندارد!\n\n'
        } = options;

        if (!items || items.length === 0) {
            return emptyMessage;
        }

        let message = '';
        const renderItem = (item) => {
            const emoji = item.eventType === 'opened' ? '🔓' : (item.isQuiz ? '❓' : '📝');
            const label = item.eventType === 'opened' ? 'باز شدن' : (item.isQuiz ? 'بسته می‌شود' : 'مهلت');
            let itemMessage = `${emoji} <b>${item.activityName}</b>\n`;
            itemMessage += `${label}: ${item.dateInfo.formatted}\n`;

            const days = item.dateInfo.daysRemaining;
            if (days === null) {
                itemMessage += 'ℹ️ زمان نامشخص\n';
            } else if (days < 0) {
                itemMessage += '❌ <b>گذشته</b>\n';
            } else if (days === 0) {
                itemMessage += '🔴 <b>امروز</b>\n';
            } else if (days === 1) {
                itemMessage += '⚠️ <b>1 روز باقی مانده</b>\n';
            } else if (days <= 3) {
                itemMessage += `⚠️ ${days} روز دیگر\n`;
            } else if (days <= 7) {
                itemMessage += `🟡 ${days} روز دیگر\n`;
            } else {
                itemMessage += `✅ ${days} روز دیگر\n`;
            }

            return itemMessage + '\n';
        };

        if (groupByCourse) {
            const byCourse = {};
            for (const item of items) {
                if (!byCourse[item.courseName]) {
                    byCourse[item.courseName] = [];
                }
                byCourse[item.courseName].push(item);
            }

            for (const [courseName, courseItems] of Object.entries(byCourse)) {
                message += `📚 <b>${courseName}</b>\n\n`;
                for (const item of courseItems) {
                    message += renderItem(item);
                }
                message += '━━━━━━━━━━━━━━━━━\n\n';
            }

            return message;
        }

        for (const item of items) {
            message += renderItem(item);
        }

        return message;
    }
    async sendOrUpdateDeadlineOverview() {
        console.log('⏰ Updating deadline overview message...');
        
        const allDeadlines = [];
        
        for (const [courseId, course] of Object.entries(this.courseData)) {
            allDeadlines.push(...this.collectCourseDeadlineItems(courseId, course));
        }

        this.sortDeadlineItems(allDeadlines);

        let message = '📃 <b>لیست رویداد ها</b>\n\n';
        message += this.renderDeadlineItems(allDeadlines, { groupByCourse: true });
        message += `${this.getUpdateScheduleNotice()}\n`;
        message += `🕐 آخرین به‌روزرسانی (UTC): ${this.getShamsiUtcTimestamp()}`;
        const formattedMessage = this.toMarkdown(message);
        
        try {
            if (this.deadlineMessageId) {
                const editOptions = {
                    chat_id: CONFIG.telegram.globalChatId,
                    message_id: this.deadlineMessageId,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                };
                
                if (CONFIG.telegram.topicId) {
                    editOptions.message_thread_id = CONFIG.telegram.topicId;
                }
                
                await bot.editMessageText(formattedMessage, editOptions);
                console.log('✏️ Updated deadline overview message');
            } else {
                const sendOptions = {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                };
                
                if (CONFIG.telegram.topicId) {
                    sendOptions.message_thread_id = CONFIG.telegram.topicId;
                }
                
                const sentMsg = await bot.sendMessage(CONFIG.telegram.globalChatId, formattedMessage, sendOptions);
                this.deadlineMessageId = sentMsg.message_id;
                await fs.writeFile('deadline_message_id.json', JSON.stringify({ messageId: this.deadlineMessageId }, null, 2));
                console.log('📤 Sent new deadline overview message');
            }
        } catch (error) {
            console.error('Error sending/updating deadline overview:', error.message);
            if (error.message.includes('message to edit not found') || error.message.includes('message_id_invalid')) {
                const sendOptions = {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                };
                
                if (CONFIG.telegram.topicId) {
                    sendOptions.message_thread_id = CONFIG.telegram.topicId;
                }
                
                const sentMsg = await bot.sendMessage(CONFIG.telegram.globalChatId, formattedMessage, sendOptions);
                this.deadlineMessageId = sentMsg.message_id;
                await fs.writeFile('deadline_message_id.json', JSON.stringify({ messageId: this.deadlineMessageId }, null, 2));
            }
        }
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
                    
                    const openedChanged = newDetails.opened !== oldDetails.opened;
                    let deadlineChanged = newDetails.deadline !== oldDetails.deadline;
                    let oldDeadlineInfo = null;
                    let newDeadlineInfo = null;
                    if (deadlineChanged) {
                        if (oldDetails.deadline && oldDetails.deadline !== 'نامشخص') {
                            oldDeadlineInfo = this.formatPersianDate(oldDetails.deadline);
                        }
                        if (newDetails.deadline && newDetails.deadline !== 'نامشخص') {
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
                    const newAttachmentUrls = (newDetails.attachments || []).map(a => a.url).sort();
                    
                    if (JSON.stringify(oldAttachmentUrls) !== JSON.stringify(newAttachmentUrls)) {
                        if (!hasUpdate) {
                            updateMessage = `🔄 <b>تغییر در فایل‌های تمرین</b>\n\n`;
                            updateMessage += `📚 درس: ${courseName}\n`;
                            updateMessage += `📝 ${item.activity.name}\n\n`;
                        }
                        hasUpdate = true;
                        
                        const addedFiles = newDetails.attachments.filter(newAtt =>
                            !oldAttachmentUrls.includes(newAtt.url)
                        );
                        
                        const removedFiles = oldDetails.attachments.filter(oldAtt =>
                            !newAttachmentUrls.includes(oldAtt.url)
                        );
                        
                        if (addedFiles.length > 0) {
                            updateMessage += `\n➕ <b>فایل‌های جدید اضافه شده:</b>\n`;
                            addedFiles.forEach(att => {
                                updateMessage += ` 📄 ${att.fileName}\n`;
                            });
                        }
                        
                        if (removedFiles.length > 0) {
                            const receivedNoAttachmentData = (newDetails.attachments || []).length === 0 && (oldDetails.attachments || []).length > 0;
                            if (receivedNoAttachmentData) {
                                console.log(`⚠️ No attachment data received for ${item.activity.name}; skipping deleted-file notification`);
                            } else {
                                updateMessage += `\n➖ <b>فایل‌های حذف شده:</b>\n`;
                                removedFiles.forEach(att => {
                                    updateMessage += ` 📄 ${att.fileName}\n`;
                                });
                            }
                        }
                    }
                    
                    if (hasUpdate) {
                        await this.sendTelegramMessage(updateMessage, {
                            chatIds: this.getCourseTargetChatIds(courseId),
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔗 مشاهده تمرین', url: item.activity.url }
                                ]]
                            }
                        });
                        
                        const addedFiles = newDetails.attachments.filter(newAtt =>
                            !oldAttachmentUrls.includes(newAtt.url)
                        );
                        
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
                    
                    const openedChanged = newDetails.opened !== oldDetails.opened;
                    let closedChanged = newDetails.closed !== oldDetails.closed;
                    let oldClosedInfo = null;
                    let newClosedInfo = null;
                    if (closedChanged) {
                        if (oldDetails.closed && oldDetails.closed !== 'نامشخص') {
                            oldClosedInfo = this.formatPersianDate(oldDetails.closed);
                        }
                        if (newDetails.closed && newDetails.closed !== 'نامشخص') {
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
                if (this.courseData[courseId].sentNotifications[item.activity.url]) {
                    console.log(`📭 Notification already sent for: ${item.activity.name}`);
                    continue;
                }
                
                let message = `🆕 <b>تکلیف جدید</b>\n\n`;
                message += `🎓 درس: ${courseName}\n`;
                message += `📍 بخش: ${item.section}\n\n`;
                message += `📝 ${item.activity.name}\n\n`;
                
                try {
                    let details = await this.extractAssignmentDetails(item.activity.url);
                    if (!details || details.success === false) {
                        console.log(`⚠️ Couldn't fetch assignment details for ${item.activity.name} — sending basic notification and skipping attachments`);
                        details = { opened: 'نامشخص', deadline: 'نامشخص', attachments: [] };
                    }
                    
                    let isLastDay = false;
                    let isExpired = false;
                    if (details.deadline && details.deadline !== 'نامشخص') {
                        const deadlineCheck = this.formatPersianDate(details.deadline);
                        if (deadlineCheck.daysRemaining !== null) {
                            if (deadlineCheck.daysRemaining < 0) {
                                isExpired = true;
                            } else if (deadlineCheck.daysRemaining === 0) {
                                isLastDay = true;
                            }
                        }
                    }
                    if (isExpired) {
                        console.log(`⏭️ Skipping expired assignment: ${item.activity.name}`);
                        this.courseData[courseId].assignments[item.activity.url] = details;
                        await this.saveData();
                        continue;
                    }
                    
                    if (isLastDay) {
                        message = `⏰ <b>یادآوری تکلیف</b>\n\n`;
                        message += `🎓 درس: ${courseName}\n`;
                        message += `📍 بخش: ${item.section}\n\n`;
                        message += `📝 ${item.activity.name}\n\n`;
                    }
                    
                    if (details.opened && details.opened !== 'نامشخص') {
                        const openedInfo = this.formatPersianDate(details.opened);
                        message += `📅 باز شده: ${openedInfo.formatted}\n`;
                    }
                    
                    if (details.deadline && details.deadline !== 'نامشخص') {
                        const dateInfo = this.formatPersianDate(details.deadline);
                        message += `⏰ مهلت: ${dateInfo.formatted}\n`;
                        
                        if (dateInfo.daysRemaining !== null) {
                            if (dateInfo.daysRemaining < 0) {
                                message += `❌ <b>مهلت گذشته است!</b> (${Math.abs(dateInfo.daysRemaining)} روز پیش)\n`;
                            } else if (dateInfo.daysRemaining === 0) {
                                message += `🔴 <b>امروز آخرین مهلت است!</b>\n`;
                            } else if (dateInfo.daysRemaining === 1) {
                                message += `⚠️ <b>فقط 1 روز باقی مانده</b>\n`;
                            } else if (dateInfo.daysRemaining <= 3) {
                                message += `⚠️ ${dateInfo.daysRemaining} روز دیگر\n`;
                            } else {
                                message += `✅ ${dateInfo.daysRemaining} روز دیگر\n`;
                            }
                        }
                    }
                    
                    if (!isLastDay && details.attachments && details.attachments.length > 0) {
                        message += `\n📎 <b>فایل‌های ضمیمه:</b>\n`;
                        details.attachments.forEach(att => {
                            message += `📄 ${att.fileName}\n`;
                        });
                    }
                    
                    await this.sendTelegramMessage(message, {
                        chatIds: this.getCourseTargetChatIds(courseId),
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 مشاهده تکلیف', url: item.activity.url }
                            ]]
                        }
                    });
                    
                    if (!isLastDay && details.attachments && details.attachments.length > 0) {
                        console.log(`📎 Found ${details.attachments.length} attachment(s) for assignment`);
                        
                        for (const att of details.attachments) {
                            await this.downloadAndSendFile(att.url, att.fileName, courseId);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else if (isLastDay) {
                        console.log(`📅 Last day - skipping file attachments for: ${item.activity.name}`);
                    }
                    
                    this.courseData[courseId].assignments[item.activity.url] = details;
                    
                    this.courseData[courseId].sentNotifications[item.activity.url] = {
                        sent: true,
                        sentAt: new Date().toISOString(),
                        activityName: item.activity.name
                    };
                    
                    await this.saveData();
                    
                } catch (error) {
                    console.error('Error getting assignment details:', error.message);
                    if (!message.includes('مهلت:')) {
                        await this.sendTelegramMessage(message, {
                            chatIds: this.getCourseTargetChatIds(courseId),
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔗 مشاهده تکلیف', url: item.activity.url }
                                ]]
                            }
                        });
                    }
                }
            }
            else if (activityType === 'quiz' || activityType === 'mod_quiz') {
                if (this.courseData[courseId].sentNotifications[item.activity.url]) {
                    console.log(`📭 Notification already sent for: ${item.activity.name}`);
                    continue;
                }
                
                let message = `🆕 <b>آزمون جدید</b>\n\n`;
                message += `🎓 درس: ${courseName}\n`;
                message += `📍 بخش: ${item.section}\n\n`;
                message += `❓ ${item.activity.name}\n\n`;
                
                try {
                    let details = await this.extractQuizDetails(item.activity.url);
                    if (!details || details.success === false) {
                        console.log(`⚠️ Couldn't fetch quiz details for ${item.activity.name} — sending basic notification`);
                        details = { opened: 'نامشخص', closed: 'نامشخص' };
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
                        message += `📅 باز شده: ${openedInfo.formatted}\n`;
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
                    
                    await this.sendTelegramMessage(message, {
                        chatIds: this.getCourseTargetChatIds(courseId),
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 مشاهده آزمون', url: item.activity.url }
                            ]]
                        }
                    });
                    
                    this.courseData[courseId].sentNotifications[item.activity.url] = {
                        sent: true,
                        sentAt: new Date().toISOString(),
                        activityName: item.activity.name
                    };
                    
                    this.courseData[courseId].assignments[item.activity.url] = details;
                    
                    await this.saveData();
                    
                } catch (error) {
                    console.error('Error getting quiz details:', error.message);
                    await this.sendTelegramMessage(message, {
                        chatIds: this.getCourseTargetChatIds(courseId),
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 مشاهده آزمون', url: item.activity.url }
                            ]]
                        }
                    });
                    
                    this.courseData[courseId].sentNotifications[item.activity.url] = {
                        sent: true,
                        sentAt: new Date().toISOString(),
                        activityName: item.activity.name
                    };
                    
                    await this.saveData();
                }
            }
            else if (activityType === 'resource' || activityType === 'mod_resource') {
                if (this.courseData[courseId].sentNotifications[item.activity.url]) {
                    console.log(`📭 Notification already sent for: ${item.activity.name}`);
                    continue;
                }
                
                let message = `🆕 <b>فایل جدید</b>\n\n`;
                message += `🎓 درس: ${courseName}\n`;
                message += `📍 بخش: ${item.section}\n\n`;
                message += `📁 ${item.activity.name}\n`;
                
                try {
                    console.log(`📥 Extracting file URL for: ${item.activity.name}`);
                    console.log(`📍 Resource URL: ${item.activity.url}`);
                    
                    // Extract file URL from resource page (follows redirects with cookies)
                    let fileInfo = await this.extractResourceFileUrl(item.activity.url);
                    
                    // Fallback: try direct download from resource URL if extraction failed
                    if (!fileInfo || !fileInfo.url) {
                        console.log(`⚠️ Could not extract file URL, trying direct download from resource URL...`);
                        try {
                            const directResult = await this.downloadWithSessionCookies(item.activity.url);
                            if (directResult && !directResult.contentType.includes('text/html')) {
                                // Got a file directly, extract filename from URL
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
                            // Already downloaded by followRedirectsForFileUrl
                            buffer = fileInfo.buffer;
                            contentType = fileInfo.contentType;
                            console.log(`✅ Using pre-downloaded buffer (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
                        } else if (fileInfo.directBuffer) {
                            // Downloaded directly from resource URL
                            buffer = fileInfo.directBuffer;
                            contentType = fileInfo.contentType;
                        } else {
                            // Download from extracted URL
                            console.log(`📥 Downloading from: ${fileInfo.url}`);
                            const downloadResult = await this.downloadWithSessionCookies(fileInfo.url);
                            buffer = downloadResult.buffer;
                            contentType = downloadResult.contentType;
                        }
                        
                        // Check if we got HTML instead of file
                        if (contentType.includes('text/html')) {
                            const preview = buffer.toString('utf8').substring(0, 200);
                            console.log(`⚠️ Received HTML instead of file. Preview: ${preview}`);
                            throw new Error('Received HTML instead of file - session may have expired');
                        }
                        
                        const fileSizeMB = buffer.length / (1024 * 1024);
                        console.log(`📄 File size: ${fileSizeMB.toFixed(2)} MB, Content-Type: ${contentType}`);
                        
                        if (fileSizeMB <= 100) {
                            // Build full caption with notification details
                            let caption = `🆕 <b>فایل جدید</b>\n\n`;
                            caption += `🎓 درس: ${courseName}\n`;
                            caption += `📍 بخش: ${item.section}\n\n`;
                            caption += `📎 ${fileInfo.fileName}`;
                            
                            // Convert HTML to Markdown for Telegram
                            const formattedCaption = this.toMarkdown(caption);
                            
                            // Send file with full notification as caption
                            const targetChatIds = this.getCourseTargetChatIds(courseId);
                            for (const chatId of targetChatIds) {
                                console.log(`📤 Sending file to chat ${chatId}...`);
                                await this.sendDocumentViaApi({
                                    chatId,
                                    buffer,
                                    fileName: fileInfo.fileName,
                                    caption: formattedCaption,
                                    contentType
                                });
                            }
                            console.log(`✅ File uploaded: ${fileInfo.fileName}`);
                        } else {
                            // File too large, just send link
                            message += `🔗 ${item.activity.url}\n`;
                            message += `⚠️ حجم فایل: ${fileSizeMB.toFixed(2)} MB (بیش از 100 مگابایت)\n`;
                            
                            await this.sendTelegramMessage(message, {
                                chatIds: this.getCourseTargetChatIds(courseId),
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '🔗 دانلود فایل', url: item.activity.url }
                                    ]]
                                }
                            });
                        }
                    } else {
                        // Couldn't extract file URL, send link only
                        console.log(`⚠️ Could not extract file URL for: ${item.activity.name}`);
                        message += `🔗 ${item.activity.url}\n`;
                        await this.sendTelegramMessage(message, {
                            chatIds: this.getCourseTargetChatIds(courseId),
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔗 دانلود فایل', url: item.activity.url }
                                ]]
                            }
                        });
                    }
                } catch (error) {
                    console.error(`❌ Error downloading resource file: ${error.message}`);
                    message += `🔗 ${item.activity.url}\n`;
                    await this.sendTelegramMessage(message, {
                        chatIds: this.getCourseTargetChatIds(courseId),
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔗 دانلود فایل', url: item.activity.url }
                            ]]
                        }
                    });
                }
                
                this.courseData[courseId].sentNotifications[item.activity.url] = {
                    sent: true,
                    sentAt: new Date().toISOString(),
                    activityName: item.activity.name
                };
                
                await this.saveData();
                
                console.log(`📁 Notified about new file: ${item.activity.name}`);
            }
        }
    }
    buildCourseMessage(course, item) {
        const emoji = this.getEmoji(item.activity.type);
        
        let message = `🎓 درس: ${course.name}\n\n`;
        message += `📍 بخش: ${item.section}\n\n`;
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
    formatPersianDate(deadlineText) {
        try {
            const match = deadlineText.match(/(\w+)،\s*(\d+)\s+(\w+)\s+(\d+)،\s*(.+)/);
            if (!match) return { formatted: deadlineText, daysRemaining: null };
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
            // Compare by UTC day boundaries so remaining days match the UTC
            // timestamp shown in the footer (last update time).
            const deadlineUtc = new Date(Date.UTC(year, month, day));
            const nowUtc = new Date();
            nowUtc.setUTCHours(0, 0, 0, 0);
            const diffTime = deadlineUtc.getTime() - nowUtc.getTime();
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
            return { formatted: deadlineText, daysRemaining: null };
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
            const deadlineUtc = new Date(Date.UTC(year, month, day));
            const nowUtc = new Date();
            nowUtc.setUTCHours(0, 0, 0, 0);
            const diffTime = deadlineUtc.getTime() - nowUtc.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            return diffDays > 0 ? diffDays : 0;
        } catch (error) {
            return null;
        }
    }
    isInQuietHours() {
        try {
            // Check if quiet hours is disabled via env
            if (!CONFIG.quietHoursEnabled) {
                console.log('🕐 Quiet hours is DISABLED via QUIET_HOURS_ENABLED=false');
                return false;
            }
            
            // Server timezone is Asia/Tehran, use local time directly
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();
            
            // Always log for debugging timezone issues
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
    getShamsiUtcTimestamp() {
        // Jalali date with UTC time (HH:mm) for consistent footer display.
        return moment.utc().format('jYYYY/jMM/jDD HH:mm [UTC]');
    }
    getUpdateScheduleNotice() {
        return `ℹ️ پیام ها هر ${CONFIG.checkInterval} دقیقه از طریق پورتال و ویو آپدیت خواهند شد.`;
    }
    async sendTelegramMessage(message, options = {}) {
        try {
            const { chatIds, ...rawOptions } = options;
            const formattedMessage = this.toMarkdown(message);
            const baseOptions = {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                ...rawOptions
            };

            const targets = Array.isArray(chatIds) && chatIds.length > 0
                ? chatIds.map(id => String(id))
                : [String(CONFIG.telegram.globalChatId)];

            const validTargets = targets.filter(id => id && id !== 'undefined' && id !== 'null');
            if (validTargets.length === 0) {
                console.log('⚠️ No valid Telegram chat ID configured for this message');
                return;
            }

            for (const chatId of validTargets) {
                const sendOptions = this.getChatScopedOptions(baseOptions, chatId);
                await bot.sendMessage(chatId, formattedMessage, sendOptions);
            }

            console.log('✅ Telegram notification sent');
        } catch (error) {
            console.error('❌ Failed to send Telegram message:', error.message);
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

        const nowUtc = new Date(); // current UTC moment

        for (const [courseId, course] of Object.entries(this.courseData)) {
            for (const [sectionName, activities] of Object.entries(course.sections || {})) {
                for (const activity of activities) {
                    if (!['assign', 'mod_assign', 'quiz', 'mod_quiz'].includes(activity.type)) continue;

                    const isQuiz = activity.type === 'quiz' || activity.type === 'mod_quiz';
                    const lastDayReminderKey = `${courseId}_${activity.url}_lastday`;

                    // Already sent last-day reminder → skip
                    if (this.sentLastDayReminders[lastDayReminderKey]) {
                        console.log(`📅 Last day reminder already sent for: ${activity.name}`);
                        continue;
                    }

                    try {
                        // Use cached details; only fetch if not present
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

                        // ------------------------------------------------------------------
                        // Parse deadline as UTC (matching footer timestamp convention)
                        // Expected format: "DayName، DD MonthName YYYY، HH:MM AM/PM"
                        // e.g. "شنبه، 23 اسفند 1404 - ساعت 23:59"  ← already formatted
                        // Raw Moodle format: "Saturday, 14 June 2025, 11:59 PM"
                        // ------------------------------------------------------------------
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

                        // Build deadline as UTC timestamp (consistent with footer)
                        const deadlineUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

                        const msUntilDeadline = deadlineUtc.getTime() - nowUtc.getTime();
                        const hoursUntilDeadline = msUntilDeadline / (1000 * 60 * 60);

                        console.log(
                            `📅 ${activity.name}: deadline UTC=${deadlineUtc.toISOString()}, ` +
                            `now UTC=${nowUtc.toISOString()}, hoursLeft=${hoursUntilDeadline.toFixed(2)}`
                        );

                        // Skip if already expired
                        if (hoursUntilDeadline <= 0) {
                            console.log(`⏭️ Skipping reminder for ${activity.name} - deadline has passed`);
                            continue;
                        }

                        // Only send reminder when ≤ 24 hours remain
                        if (hoursUntilDeadline > 24) {
                            console.log(`✅ ${activity.name}: ${hoursUntilDeadline.toFixed(1)}h left, no reminder yet`);
                            continue;
                        }

                        // Build reminder message
                        const dateInfo = this.formatPersianDate(deadlineText);
                        let message = `⏰ *یادآوری: مهلت ${isQuiz ? 'آزمون' : 'تکلیف'} رو به پایان است!*\n\n`;
                        message += `🎓 درس: ${course.name}\n`;
                        message += `📍 بخش: ${sectionName}\n\n`;
                        message += `${isQuiz ? '❓' : '📝'} ${activity.name}\n\n`;
                        message += `⏰ ${isQuiz ? 'بسته می‌شود' : 'مهلت'}: ${dateInfo.formatted}\n`;

                        const hoursRemaining  = Math.floor(hoursUntilDeadline);
                        const minutesRemaining = Math.floor((hoursUntilDeadline - hoursRemaining) * 60);

                        if (hoursRemaining === 0) {
                            message += `🔴 *فقط ${minutesRemaining} دقیقه دیگر!*`;
                        } else {
                            message += `🔴 *فقط ${hoursRemaining} ساعت و ${minutesRemaining} دقیقه دیگر!*`;
                        }

                        // Send to BOTH global chat AND course-specific chat
                        const targetChatIds = this.getCourseTargetChatIds(courseId, course.url);
                        console.log(`📤 Sending reminder for "${activity.name}" to chats: ${targetChatIds.join(', ')}`);

                        await this.sendTelegramMessage(message, {
                            chatIds: targetChatIds,
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: `🔗 مشاهده ${isQuiz ? 'آزمون' : 'تکلیف'}`, url: activity.url }
                                ]]
                            }
                        });

                        // Persist so we never send twice
                        const reminderRecord = {
                            sentAt: nowUtc.toISOString(),
                            deadline: deadlineUtc.toISOString(),
                            courseName: course.name,
                            activityName: activity.name
                        };

                        this.sentLastDayReminders[lastDayReminderKey] = reminderRecord;
                        // Also mark in sentReminders for backward compatibility
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
                console.log('⏸️ Within quiet hours (00:30-07:30 Asia/Tehran). Skipping this check cycle.');
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
            const isHealthy = await this.isBrowserHealthy();
            if (!isHealthy) {
                console.log('🔧 Browser not healthy, reinitializing...');
                await this.initialize();
            }
            
            console.log('🔍 Checking if already logged in...');
            let needsLogin = true;
            
            try {
                const testUrl = CONFIG.vu.courseUrls[0];
                await this.page.goto(testUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                await new Promise(r => setTimeout(r, 3000));
                
                const currentUrl = this.page.url();
                console.log(`📍 Current URL: ${currentUrl}`);
                
                if (currentUrl.includes('oauth.um.ac.ir') || currentUrl.includes('login')) {
                    console.log('🔐 Session expired, login required');
                    needsLogin = true;
                } else if (currentUrl.includes('vu.um.ac.ir')) {
                    console.log('✅ Already logged in, session is active');
                    needsLogin = false;
                } else {
                    console.log('⚠️ Unexpected URL, will attempt login');
                    needsLogin = true;
                }
            } catch (error) {
                console.log('⚠️ Could not verify session:', error.message);
                console.log('🔄 Reinitializing browser and will login...');
                await this.initialize();
                needsLogin = true;
            }
            
            if (needsLogin) {
                await this.login();
            }
            for (const courseUrl of CONFIG.vu.courseUrls) {
                try {
                    const isStillHealthy = await this.isBrowserHealthy();
                    if (!isStillHealthy) {
                        console.log('🔧 Browser became unhealthy, reinitializing...');
                        await this.initialize();
                        await this.login();
                    }
                    try {
                        await this.runWithTimeout(this.checkCourse(courseUrl), 120000, `Course check timed out for ${courseUrl}`);
                    } catch (timeoutErr) {
                        console.error(`⏱️ Timeout while checking course ${courseUrl}:`, timeoutErr.message);
                        try {
                            const loginBtnSelector = '.btn.login-identityprovider-btn.btn-block';
                            const loginBtnExists = await this.page.$(loginBtnSelector);
                            if (loginBtnExists) {
                                await this.page.click(loginBtnSelector);
                                console.log('🔘 Clicked login identity provider button after timeout');
                                await new Promise(r => setTimeout(r, 2000));
                            }
                        } catch (btnErr) {
                            console.log('⚠️ Could not click login identity provider button after timeout:', btnErr.message);
                        }
                        continue;
                    }
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (error) {
                    console.error(`❌ Error checking course ${courseUrl}:`, error.message);
                    try {
                        const loginBtnSelector = '.btn.login-identityprovider-btn.btn-block';
                        const loginBtnExists = await this.page.$(loginBtnSelector);
                        if (loginBtnExists) {
                            await this.page.click(loginBtnSelector);
                            console.log('🔘 Clicked login identity provider button');
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    } catch (btnErr) {
                        console.log('⚠️ Could not click login identity provider button:', btnErr.message);
                    }
                    if (error.message.includes('navigation') ||
                        error.message.includes('timeout') ||
                        error.message.includes('frame') ||
                        error.message.includes('Target closed')) {
                        console.log('🔄 Reinitializing browser and re-logging in...');
                        try {
                            await this.initialize();
                            await this.login();
                            console.log('✅ Successfully recovered from error');
                        } catch (recoveryError) {
                            console.error('❌ Failed to recover:', recoveryError.message);
                        }
                    }
                }
            }
            console.log('\n✅ Check cycle completed\n');
            
            // Clear browser cache to prevent disk usage buildup
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
                await bot.sendMessage(
                    CONFIG.telegram.adminChatId,
                    this.toMarkdown(`🚨 <b>خرابی در چرخه بررسی دوره‌ها</b>\n\n${error.message}`),
                    { parse_mode: 'Markdown' }
                );
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
        if (this.browser) {
            try {
                await this.browser.close();
                console.log('🔒 Browser closed');
            } catch (error) {
                console.error('Error closing browser:', error.message);
            }
        }
        this.browser = null;
        this.page = null;
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
