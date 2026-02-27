require('dotenv').config();
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const { CronJob } = require('cron');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const moment = require('moment-jalaali');
const CONFIG = {
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
        topicId: process.env.TELEGRAM_TOPIC_ID ? parseInt(process.env.TELEGRAM_TOPIC_ID) : null,
        adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID
    },
    vu: {
        username: process.env.VU_USERNAME,
        password: process.env.VU_PASSWORD,
        courseUrls: process.env.COURSE_URLS.split(',')
    },
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 5,
    debug: process.env.DEBUG_MODE === 'true' || false,
    chromePath: process.env.CHROME_PATH || null,
    httpProxy: process.env.HTTP_PROXY || null
};

if (CONFIG.httpProxy) {
    console.log("Using Proxy: ", CONFIG.httpProxy)
}
const bot = new TelegramBot(CONFIG.telegram.token, {
    polling: true,
    request: {
        proxy: CONFIG.httpProxy
    }
});

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

        let chromePath;
        if (CONFIG.chromePath) {
            chromePath = CONFIG.chromePath;
        } else {
            chromePath = this.findChromePath();
            console.log("couldnt find chrome path in .env, trying to guess...")
        }

        console.log('chrome path:', chromePath);

        this.browser = await puppeteer.launch({
            headless: true,
            executablePath: chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disk-cache-size=0',
                '--media-cache-size=0'
            ]
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1920, height: 1080 });
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

                let sectionElements = document.querySelectorAll('li.section.course-section[data-for="section"]');

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

                    let activityContainer = section.querySelector('ul[data-for="cmlist"]') || section;
                    let activityElements = activityContainer.querySelectorAll('li.activity[data-for="cmitem"]');

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

                        const activityItem = activity.querySelector('.activity-item[data-activityname]');
                        if (activityItem && activityItem.dataset.activityname) {
                            activityName = activityItem.dataset.activityname.trim();
                        } else {
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

                        const activityType = activity.className.match(/modtype_(\w+)/)?.[1] ||
                            activity.className.match(/modtype-(\w+)/)?.[1] ||
                            'unknown';

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

            const cookies = await this.page.cookies();
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const userAgent = await this.page.evaluate(() => navigator.userAgent);

            const response = await axios.get(fileUrl, {
                headers: {
                    'Cookie': cookieString,
                    'User-Agent': userAgent,
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                },
                responseType: 'arraybuffer',
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                validateStatus: (status) => status === 200
            });

            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || '';
            console.log(`📄 Content-Type: ${contentType}`);
            console.log(`📡 Response status: ${response.status}`);

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
                const commonExts = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'txt', 'zip', 'rar']);
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

            const filesDir = path.join(process.cwd(), 'files');
            if (!fsSync.existsSync(filesDir)) {
                fsSync.mkdirSync(filesDir, { recursive: true });
            }
            const savedFilePath = path.join(filesDir, fileName);
            fsSync.writeFileSync(savedFilePath, buffer);
            console.log(`💾 File saved to: ${savedFilePath}`);

            console.log(`📤 Sending file to Telegram: ${fileName} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

            const sendOptions = {
                caption: `📎 ${fileName}`
            };

            if (CONFIG.telegram.topicId) {
                sendOptions.message_thread_id = CONFIG.telegram.topicId;
            }

            if (buffer.length > 50 * 1024 * 1024) {
                console.log(`⚠️ File too large (${(buffer.length / 1024 / 1024).toFixed(2)} MB), sending link only`);
                await this.sendTelegramMessage(`📎 فایل خیلی بزرگ است (${(buffer.length / 1024 / 1024).toFixed(2)} MB)\n${fileName}\n🔗 ${fileUrl}`);
            } else {
                await bot.sendDocument(CONFIG.telegram.chatId, savedFilePath, sendOptions, {
                    filename: fileName
                });
            }

            this.courseData[courseId].sentFiles[fileUrl] = {
                sent: true,
                fileName: fileName,
                filePath: savedFilePath,
                sentAt: new Date().toISOString()
            };

            await this.saveData();

            console.log(`✅ File sent: ${fileName}`);
            return true;
        } catch (error) {
            console.error(`❌ Error downloading/sending file ${fileName}:`, error.message);

            try {
                await this.sendTelegramMessage(`⚠️ خطا در دانلود فایل\n📎 ${fileName}\n🔗 ${fileUrl}`);
            } catch (telegramError) {
                console.error('Failed to send error message:', telegramError.message);
            }

            return false;
        }
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

        const now = new Date();
        const persianDate = now.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' });
        const persianTime = now.toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour12: false });
        const dateTimeStr = `${persianDate}, ${persianTime}`;

        const englishDateTime = dateTimeStr
            .replace(/۰/g, '0')
            .replace(/۱/g, '1')
            .replace(/۲/g, '2')
            .replace(/۳/g, '3')
            .replace(/۴/g, '4')
            .replace(/۵/g, '5')
            .replace(/۶/g, '6')
            .replace(/۷/g, '7')
            .replace(/۸/g, '8')
            .replace(/۹/g, '9');

        message += `🕐 ${englishDateTime}`;

        try {
            if (this.courseMessageIds[courseId]) {
                const editOptions = {
                    chat_id: CONFIG.telegram.chatId,
                    message_id: this.courseMessageIds[courseId],
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                };

                if (CONFIG.telegram.topicId) {
                    editOptions.message_thread_id = CONFIG.telegram.topicId;
                }

                await bot.editMessageText(message, editOptions);
                console.log(`✏️ Updated overview message for course ${courseId}`);
            } else {
                const sendOptions = {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                };

                if (CONFIG.telegram.topicId) {
                    sendOptions.message_thread_id = CONFIG.telegram.topicId;
                }

                const sentMsg = await bot.sendMessage(CONFIG.telegram.chatId, message, sendOptions);
                this.courseMessageIds[courseId] = sentMsg.message_id;
                console.log(`📤 Sent new overview message for course ${courseId}`);
            }
        } catch (error) {
            console.error('Error sending/updating course overview:', error.message);
            if (error.message.includes('message to edit not found')) {
                const sendOptions = {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                };

                if (CONFIG.telegram.topicId) {
                    sendOptions.message_thread_id = CONFIG.telegram.topicId;
                }

                const sentMsg = await bot.sendMessage(CONFIG.telegram.chatId, message, sendOptions);
                this.courseMessageIds[courseId] = sentMsg.message_id;
            }
        }
    }
    async sendOrUpdateDeadlineOverview() {
        console.log('⏰ Updating deadline overview message...');

        const allDeadlines = [];

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
                        allDeadlines.push({
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
                    if (dateInfo.daysRemaining !== null && dateInfo.daysRemaining < 0) {
                    } else {
                        allDeadlines.push({
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
        }

        allDeadlines.sort((a, b) => {
            if (a.dateInfo.daysRemaining === null) return 1;
            if (b.dateInfo.daysRemaining === null) return -1;
            return a.dateInfo.daysRemaining - b.dateInfo.daysRemaining;
        });

        let message = '📃 <b>لیست رویداد ها</b>\n\n';

        if (allDeadlines.length === 0) {
            message += '✅ هیچ تکلیف یا آزمون فعالی وجود ندارد!\n\n';
        } else {
            const byCourse = {};
            for (const item of allDeadlines) {
                if (!byCourse[item.courseName]) {
                    byCourse[item.courseName] = [];
                }
                byCourse[item.courseName].push(item);
            }

            for (const [courseName, items] of Object.entries(byCourse)) {
                message += `📚 <b>${courseName}</b>\n\n`;
                for (const item of items) {
                    const isQuiz = item.isQuiz;
                    const emoji = item.eventType === 'opened' ? '🔓' : (isQuiz ? '❓' : '📝');
                    const label = item.eventType === 'opened' ? 'باز شدن' : (isQuiz ? 'بسته می‌شود' : 'مهلت');
                    message += `${emoji} <b>${item.activityName}</b>\n`;
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

        const now = new Date();
        const persianDate = now.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' });
        const persianTime = now.toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour12: false });
        const dateTimeStr = `${persianDate}, ${persianTime}`;

        const englishDateTime = dateTimeStr
            .replace(/۰/g, '0')
            .replace(/۱/g, '1')
            .replace(/۲/g, '2')
            .replace(/۳/g, '3')
            .replace(/۴/g, '4')
            .replace(/۵/g, '5')
            .replace(/۶/g, '6')
            .replace(/۷/g, '7')
            .replace(/۸/g, '8')
            .replace(/۹/g, '9');

        message += `🕐 آخرین به‌روزرسانی: ${englishDateTime}`;

        try {
            if (this.deadlineMessageId) {
                const editOptions = {
                    chat_id: CONFIG.telegram.chatId,
                    message_id: this.deadlineMessageId,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                };

                if (CONFIG.telegram.topicId) {
                    editOptions.message_thread_id = CONFIG.telegram.topicId;
                }

                await bot.editMessageText(message, editOptions);
                console.log('✏️ Updated deadline overview message');
            } else {
                const sendOptions = {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                };

                if (CONFIG.telegram.topicId) {
                    sendOptions.message_thread_id = CONFIG.telegram.topicId;
                }

                const sentMsg = await bot.sendMessage(CONFIG.telegram.chatId, message, sendOptions);
                this.deadlineMessageId = sentMsg.message_id;
                await fs.writeFile('deadline_message_id.json', JSON.stringify({ messageId: this.deadlineMessageId }, null, 2));
                console.log('📤 Sent new deadline overview message');
            }
        } catch (error) {
            console.error('Error sending/updating deadline overview:', error.message);
            if (error.message.includes('message to edit not found') || error.message.includes('message_id_invalid')) {
                const sendOptions = {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                };

                if (CONFIG.telegram.topicId) {
                    sendOptions.message_thread_id = CONFIG.telegram.topicId;
                }

                const sentMsg = await bot.sendMessage(CONFIG.telegram.chatId, message, sendOptions);
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
            const day = match[2];
            const monthName = match[3];
            const year = match[4];
            const time = match[5];
            const months = {
                'January': '01', 'February': '02', 'March': '03', 'April': '04',
                'May': '05', 'June': '06', 'July': '07', 'August': '08',
                'September': '09', 'October': '10', 'November': '11', 'December': '12'
            };
            const month = months[monthName];
            if (!month) return { formatted: deadlineText, daysRemaining: null };
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
            const gregorianDate = `${year}-${month}-${day.padStart(2, '0')}`;
            const shamsiDate = this.convertToShamsi(gregorianDate);
            const deadline = new Date(year, parseInt(month) - 1, parseInt(day));
            const now = new Date();
            const diffTime = deadline - now;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            const dayOfWeek = deadline.getDay();
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
            const deadline = new Date(year, month, day);
            const now = new Date();
            const diffTime = deadline - now;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays > 0 ? diffDays : 0;
        } catch (error) {
            return null;
        }
    }
    isInQuietHours() {
        try {
            const now = new Date();
            const fmt = new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Tehran',
                hour12: false,
                hour: '2-digit',
                minute: '2-digit'
            }).format(now);
            const parts = fmt.split(':');
            const hour = parseInt(parts[0].replace(/^0+/, '') || '0', 10);
            const minute = parseInt(parts[1].replace(/^0+/, '') || '0', 10);
            if (isNaN(hour) || isNaN(minute)) return false;
            const totalMinutes = hour * 60 + minute;
            const quietStart = 0 * 60 + 30;
            const quietEnd = 7 * 60 + 30;
            return totalMinutes >= quietStart && totalMinutes < quietEnd;
        } catch (error) {
            console.error('Error determining Tehran time for quiet hours check:', error.message);
            return false;
        }
    }
    async sendTelegramMessage(message, options = {}) {
        try {
            const sendOptions = {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                ...options
            };

            if (CONFIG.telegram.topicId) {
                sendOptions.message_thread_id = CONFIG.telegram.topicId;
            }

            await bot.sendMessage(CONFIG.telegram.chatId, message, sendOptions);
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
        await this.sendTelegramMessage(message);
    }
    async checkAndSendReminders() {
        console.log('⏰ Checking for assignment reminders...');

        const now = new Date();
        const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        for (const [courseId, course] of Object.entries(this.courseData)) {
            for (const [sectionName, activities] of Object.entries(course.sections)) {
                for (const activity of activities) {
                    if (!['assign', 'mod_assign', 'quiz', 'mod_quiz'].includes(activity.type)) continue;

                    const isQuiz = activity.type === 'quiz' || activity.type === 'mod_quiz';

                    const reminderKey = `${courseId}_${activity.url}`;

                    if (this.sentReminders[reminderKey]) {
                        continue;
                    }

                    try {
                        const details = isQuiz ? await this.extractQuizDetails(activity.url) : await this.extractAssignmentDetails(activity.url);
                        const deadlineField = isQuiz ? 'closed' : 'deadline';

                        if (details[deadlineField] && details[deadlineField] !== 'نامشخص') {
                            const match = details[deadlineField].match(/(\d+)\s+(\w+)\s+(\d+)،\s*(.+)/);
                            if (!match) continue;

                            const day = match[1];
                            const monthName = match[2];
                            const year = match[3];
                            const time = match[4];

                            const months = {
                                'January': '01', 'February': '02', 'March': '03', 'April': '04',
                                'May': '05', 'June': '06', 'July': '07', 'August': '08',
                                'September': '09', 'October': '10', 'November': '11', 'December': '12'
                            };

                            const month = months[monthName];
                            if (!month) continue;

                            const timeMatch = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
                            let hours = 0;
                            let minutes = 0;

                            if (timeMatch) {
                                hours = parseInt(timeMatch[1]);
                                minutes = parseInt(timeMatch[2]);
                                const period = timeMatch[3].toUpperCase();

                                if (period === 'PM' && hours !== 12) {
                                    hours += 12;
                                } else if (period === 'AM' && hours === 12) {
                                    hours = 0;
                                }
                            }

                            const deadline = new Date(year, parseInt(month) - 1, parseInt(day), hours, minutes);

                            const hoursUntilDeadline = (deadline - now) / (1000 * 60 * 60);

                            if (hoursUntilDeadline <= 0) {
                                console.log(`⏭️ Skipping reminder for ${activity.name} - deadline has passed`);
                                continue;
                            }

                            if (hoursUntilDeadline > 0 && hoursUntilDeadline <= 24) {
                                const lastDayReminderKey = `${courseId}_${activity.url}_lastday`;

                                if (this.sentLastDayReminders[lastDayReminderKey]) {
                                    console.log(`📅 Last day reminder already sent for: ${activity.name}`);
                                    continue;
                                }

                                const dateInfo = this.formatPersianDate(details[deadlineField]);

                                let message = `⏰ <b>یادآوری: مهلت ${isQuiz ? 'آزمون' : 'تکلیف'} رو به پایان است!</b>\n\n`;
                                message += `🎓 درس: ${course.name}\n`;
                                message += `📍 بخش: ${sectionName}\n\n`;
                                message += `${isQuiz ? '❓' : '📝'} ${activity.name}\n\n`;
                                message += `⏰ ${isQuiz ? 'بسته می‌شود' : 'مهلت'}: ${dateInfo.formatted}\n`;

                                const hoursRemaining = Math.floor(hoursUntilDeadline);
                                const minutesRemaining = Math.floor((hoursUntilDeadline - hoursRemaining) * 60);

                                if (hoursRemaining === 0) {
                                    message += `🔴 <b>فقط ${minutesRemaining} دقیقه دیگر!</b>`;
                                } else {
                                    message += `🔴 <b>فقط ${hoursRemaining} ساعت و ${minutesRemaining} دقیقه دیگر!</b>`;
                                }

                                await this.sendTelegramMessage(message, {
                                    reply_markup: {
                                        inline_keyboard: [[
                                            { text: `🔗 مشاهده ${isQuiz ? 'آزمون' : 'تکلیف'}`, url: activity.url }
                                        ]]
                                    }
                                });

                                this.sentLastDayReminders[lastDayReminderKey] = {
                                    sentAt: now.toISOString(),
                                    deadline: deadline.toISOString(),
                                    courseName: course.name,
                                    activityName: activity.name
                                };

                                this.sentReminders[reminderKey] = {
                                    sentAt: now.toISOString(),
                                    deadline: deadline.toISOString(),
                                    courseName: course.name,
                                    activityName: activity.name
                                };

                                await this.saveData();

                                console.log(`⏰ Sent last day reminder for: ${activity.name}`);

                                await new Promise(r => setTimeout(r, 2000));
                            }
                        }
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
                    `🚨 <b>خرابی در چرخه بررسی دوره‌ها</b>\n\n${error.message}`,
                    { parse_mode: 'HTML' }
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