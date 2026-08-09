require('dotenv').config();

const express = require('express');
// ✅ FIXED: Support for default, named, and legacy exports
const TelegramBot = require('node-telegram-bot-api').TelegramBot || require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const dns = require('dns');

// ==================== CONFIGURATION FROM .env ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || null;
const PORT = process.env.PORT || 3000;
const ALLOWED_GROUP_IDS = process.env.ALLOWED_GROUP_IDS ? process.env.ALLOWED_GROUP_IDS.split(',') : [];
const REFERRAL_CHANNEL_ID = process.env.REFERRAL_CHANNEL_ID || null;
const PROXY_URL = process.env.PROXY_URL || null;
const TELEGRAM_API_URL = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';

if (!BOT_TOKEN) {
    console.error('❌ FATAL ERROR: BOT_TOKEN not found in .env file!');
    process.exit(1);
}

const app = express();
const employees = {};
const pendingUsers = {};
const verifiedUsers = new Set();

// ==================== DNS Pre-resolution ====================
console.log('🔍 Resolving Telegram API domain...');
dns.lookup('api.telegram.org', (err, address) => {
    if (!err) {
        console.log(`✅ Resolved api.telegram.org to: ${address}`);
    } else {
        console.log('⚠️ DNS resolution failed. Will retry on connection.');
    }
});

// ==================== PROXY SETUP ====================
function getProxyAgent() {
    if (!PROXY_URL) return null;
    
    try {
        // For HTTP/HTTPS proxies
        if (PROXY_URL.startsWith('http://') || PROXY_URL.startsWith('https://')) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            console.log(`✅ Using HTTP proxy: ${PROXY_URL}`);
            return new HttpsProxyAgent(PROXY_URL);
        }
        // For SOCKS5 proxies
        else if (PROXY_URL.startsWith('socks5://') || PROXY_URL.startsWith('socks://')) {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            console.log(`✅ Using SOCKS5 proxy: ${PROXY_URL}`);
            return new SocksProxyAgent(PROXY_URL);
        }
    } catch (err) {
        console.log('⚠️ Failed to setup proxy:', err.message);
        console.log('💡 Trying direct connection...');
        return null;
    }
    
    return null;
}

// ==================== BOT INITIALIZATION ====================
let bot = null;
let pollingActive = false;
let retryCount = 0;
const MAX_RETRIES = 10;
let reconnectTimer = null;

function createBot() {
    try {
        let botOptions = {
            polling: true,
            onlyFirstMatch: false,
            pollingTimeout: 60,
            pollingInterval: 300,
            retryTimeout: 10000,
            request: {
                strictSSL: false,
            }
        };

        // Add proxy if configured
        const agent = getProxyAgent();
        if (agent) {
            botOptions.request = { agent: agent };
        }

        const newBot = new TelegramBot(BOT_TOKEN, botOptions);
        console.log('✅ Bot instance created successfully');
        return newBot;
    } catch (err) {
        console.error('❌ Failed to create bot:', err.message);
        return null;
    }
}

function handlePollingError(error) {
    console.error('📡 Polling error:', error.message);
    
    if (error.message.includes('ETIMEDOUT') || 
        error.message.includes('ECONNRESET') || 
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('getaddrinfo') ||
        error.message.includes('connect') ||
        error.message.includes('timeout')) {
        
        console.log('🔄 Network error detected. Attempting to reconnect...');
        reconnectBot();
    }
}

function handleBotError(error) {
    console.error('❌ Bot error:', error.message);
    if (error.message.includes('polling')) {
        reconnectBot();
    }
}

function reconnectBot() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (retryCount >= MAX_RETRIES) {
        console.error(`❌ Max retries (${MAX_RETRIES}) reached. Please check your network connection.`);
        console.log('💡 Try:');
        console.log('  1. Check your internet connection');
        console.log('  2. Set PROXY_URL in .env if needed');
        console.log('  3. Try TELEGRAM_API_URL=https://tg.i-c-a.su in .env');
        return;
    }

    retryCount++;
    const delay = Math.min(1000 * Math.pow(1.5, retryCount), 30000);
    
    console.log(`🔄 Reconnection attempt ${retryCount}/${MAX_RETRIES} in ${(delay/1000).toFixed(1)}s...`);
    
    reconnectTimer = setTimeout(async () => {
        try {
            if (bot) {
                try {
                    await bot.stopPolling();
                } catch (e) {
                    // Ignore stop errors
                }
            }
            
            console.log('🔄 Creating new bot instance...');
            bot = createBot();
            
            if (!bot) {
                console.log('⚠️ Bot creation failed');
                reconnectBot();
                return;
            }
            
            // Setup error handlers for new bot
            bot.on('polling_error', handlePollingError);
            bot.on('error', handleBotError);
            
            // Wait for connection
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
                const me = await bot.getMe();
                console.log(`✅ Bot reconnected successfully! (${me.username})`);
                retryCount = 0;
                pollingActive = true;
                
                // Re-setup all command handlers
                setupCommandHandlers();
            } catch (err) {
                console.log('⚠️ Bot instance created but connection failed:', err.message);
                reconnectBot();
            }
        } catch (err) {
            console.error('❌ Reconnection failed:', err.message);
            reconnectBot();
        }
    }, delay);
}

// ==================== SETUP COMMAND HANDLERS ====================
function setupCommandHandlers() {
    // Setup all the command handlers here
    // This function will be called again on reconnection
    console.log('🔄 Setting up command handlers...');
}

// Initialize bot
console.log('🤖 Initializing bot...');
bot = createBot();

if (!bot) {
    console.error('❌ Failed to create bot. Exiting...');
    process.exit(1);
}

// Setup error handlers
bot.on('polling_error', handlePollingError);
bot.on('error', handleBotError);

// ==================== HEARTBEAT KEEP-ALIVE ====================
let heartbeatInterval = null;
let lastHeartbeat = Date.now();

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    heartbeatInterval = setInterval(async () => {
        try {
            if (bot) {
                await bot.getMe();
                const now = Date.now();
                if (now - lastHeartbeat > 120000) {
                    console.log('💓 Heartbeat: Connection verified');
                }
                lastHeartbeat = now;
            }
        } catch (err) {
            console.log('⚠️ Heartbeat: Connection issue detected');
            if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONN')) {
                reconnectBot();
            }
        }
    }, 30000);
}

// Start heartbeat after bot is ready
setTimeout(startHeartbeat, 5000);

// ==================== EXPRESS SERVER ====================
app.get('/', (req, res) => res.send('Employee Attendance Bot is running!'));
app.get('/health', (req, res) => {
    res.status(200).json({
        status: pollingActive ? 'healthy' : 'degraded',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        employees: Object.keys(employees).length,
        verifiedUsers: verifiedUsers.size,
        retryCount: retryCount,
        version: '3.5',
        connection: {
            status: pollingActive ? 'connected' : 'disconnected',
            proxy: PROXY_URL ? 'configured' : 'none',
            apiUrl: TELEGRAM_API_URL
        }
    });
});

const server = app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// ==================== TIMEZONE CONFIGURATION ====================
const MEXICO_TIMEZONE = 'America/Mexico_City';
const WORK_START_HOUR = 8;
const WORK_START_MINUTE = 0;
const LATE_THRESHOLD_MINUTES = 15;
const ACTIVITY_TIMEOUT = 15 * 60 * 1000;

let reminderInterval = null;
let lateCheckInterval = null;
let keepAliveInterval = null;

const ACTIVITIES = {
    '吃饭': { type: 'meal', name: 'Meal Time' },
    '抽烟': { type: 'smoke', name: 'Smoke Break' },
    '厕所': { type: 'restroom', name: 'Restroom' },
    '下楼拿外卖': { type: 'delivery', name: 'Delivery' }
};

// ==================== TIME HELPER FUNCTIONS ====================

function getMexicoDate() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE }));
}

function getTodayWorkStartMexico() {
    const mexicoNow = getMexicoDate();
    const workStart = new Date(mexicoNow);
    workStart.setHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);
    return workStart;
}

function isUserLate(startTimestamp) {
    if (!startTimestamp) return false;
    
    const startDate = new Date(startTimestamp);
    const startMexicoStr = startDate.toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE });
    const startMexicoDate = new Date(startMexicoStr);
    
    const startHour = startMexicoDate.getHours();
    const startMinute = startMexicoDate.getMinutes();
    
    const minutesAfter8 = (startHour - WORK_START_HOUR) * 60 + (startMinute - WORK_START_MINUTE);
    return minutesAfter8 > LATE_THRESHOLD_MINUTES;
}

function getLateDuration(startTimestamp) {
    if (!startTimestamp) return 0;
    
    const startDate = new Date(startTimestamp);
    const startMexicoStr = startDate.toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE });
    const startMexicoDate = new Date(startMexicoStr);
    const workStartMexico = getTodayWorkStartMexico();
    const lateMs = startMexicoDate.getTime() - workStartMexico.getTime();
    return Math.max(0, lateMs);
}

function formatMexicoTime(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: false,
        timeZone: MEXICO_TIMEZONE
    });
}

function formatDurationWithSeconds(ms) {
    if (!ms || ms < 0) return '0s';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function getLateDurationFormatted(startTimestamp) {
    return formatDurationWithSeconds(getLateDuration(startTimestamp));
}

// ==================== GROUP & CHANNEL VERIFICATION FUNCTIONS ====================

async function isUserMemberOfChannel(userId) {
    if (!REFERRAL_CHANNEL_ID) {
        return true;
    }

    try {
        const chatMember = await bot.getChatMember(REFERRAL_CHANNEL_ID, userId);
        return chatMember.status !== 'left' && chatMember.status !== 'kicked';
    } catch (error) {
        console.log(`[VERIFICATION] Failed to check membership for user ${userId}:`, error.message);
        return false;
    }
}

function isGroupAllowed(groupId) {
    if (ALLOWED_GROUP_IDS.length === 0) {
        return true;
    }
    const groupIdStr = groupId.toString();
    return ALLOWED_GROUP_IDS.includes(groupIdStr);
}

function isGroup(chat) {
    return chat && (chat.type === 'group' || chat.type === 'supergroup');
}

async function sendVerificationRequest(chatId, userId) {
    let message = '🔐 *Verification Required*\n\n';
    message += 'To use this bot, you must join our referral channel:\n';
    message += `📢 Channel: [Click here to join](https://t.me/${REFERRAL_CHANNEL_ID.replace('@', '')})\n\n`;
    message += 'After joining, click the button below to verify.';
    
    const verificationKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ I have joined!', callback_data: 'verify_membership' }],
                [{ text: '📢 Join Channel', url: `https://t.me/${REFERRAL_CHANNEL_ID.replace('@', '')}` }]
            ]
        }
    };
    
    try {
        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            ...verificationKeyboard 
        });
    } catch (error) {
        console.error(`[VERIFICATION] Failed to send verification to ${chatId}:`, error.message);
    }
}

async function verifyUserAndGroup(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id.toString() : null;
    
    if (isGroup(msg.chat)) {
        if (!isGroupAllowed(chatId)) {
            try {
                await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot. Please contact the administrator.');
            } catch (e) {
                console.log('Failed to send unauthorized message');
            }
            return false;
        }
        
        if (userId && !verifiedUsers.has(userId)) {
            verifiedUsers.add(userId);
            console.log(`[VERIFICATION] Auto-verified user ${userId} via allowed group`);
        }
        return true;
    }
    
    if (!userId) {
        try {
            await bot.sendMessage(chatId, '❌ Could not identify you. Please try again.');
        } catch (e) {}
        return false;
    }
    
    if (verifiedUsers.has(userId)) {
        return true;
    }
    
    if (pendingUsers[userId]) {
        const timeElapsed = Date.now() - pendingUsers[userId].timestamp;
        if (timeElapsed > 300000) {
            delete pendingUsers[userId];
            await sendVerificationRequest(chatId, userId);
            return false;
        }
        return false;
    }
    
    await sendVerificationRequest(chatId, userId);
    pendingUsers[userId] = { timestamp: Date.now() };
    return false;
}

// ==================== NOTIFICATION FUNCTIONS ====================

async function sendNotification(message, parseMode = 'Markdown') {
    let sent = false;
    if (GROUP_CHAT_ID) {
        try {
            await bot.sendMessage(GROUP_CHAT_ID, message, { parse_mode: parseMode });
            sent = true;
        } catch (err) {
            console.error(`Failed to send to group:`, err.message);
        }
    }
    for (const adminId of ADMIN_IDS) {
        if (adminId && adminId.trim()) {
            try {
                await bot.sendMessage(adminId.trim(), message, { parse_mode: parseMode });
                sent = true;
            } catch (err) {
                if (!err.message.includes('bot can\'t initiate conversation')) {
                    console.error(`Failed to notify admin ${adminId}:`, err.message);
                }
            }
        }
    }
    if (!sent) {
        console.log('📝 Notification:', message.substring(0, 100));
    }
}

function mentionUser(name, telegramId) {
    return `[${name}](tg://user?id=${telegramId})`;
}

async function getUserInfo(msg) {
    if (msg.chat.type === 'channel') {
        const telegramId = 'channel_' + msg.chat.id;
        const name = 'Channel User';
        if (!employees[telegramId]) {
            employees[telegramId] = {
                name: name, telegramId: telegramId, status: 'off',
                workStart: null, workEnd: null, currentActivity: null,
                activityStart: null, reminderSent: false, lateNotified: false,
                currentChatId: msg.chat.id,
                totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 },
                dailyReport: { workStart: null, workEnd: null, totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 } }
            };
        }
        return { telegramId, name };
    }
    
    const from = msg.from;
    if (!from) throw new Error('Cannot identify user');
    
    const telegramId = from.id.toString();
    const name = from.first_name + (from.last_name ? ' ' + from.last_name : '');
    
    if (!employees[telegramId]) {
        employees[telegramId] = {
            name: name, telegramId: telegramId, status: 'off',
            workStart: null, workEnd: null, currentActivity: null,
            activityStart: null, reminderSent: false, lateNotified: false,
            currentChatId: msg.chat.id,
            totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 },
            dailyReport: { workStart: null, workEnd: null, totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 } }
        };
    } else {
        employees[telegramId].currentChatId = msg.chat.id;
    }
    
    return { telegramId, name };
}

function checkActivityTimeouts() {
    const now = Date.now();
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        if (emp.status === 'away' && emp.currentActivity && emp.activityStart && !emp.reminderSent) {
            const duration = now - emp.activityStart;
            if (duration >= ACTIVITY_TIMEOUT) {
                let activityDisplay = '';
                for (const [key, config] of Object.entries(ACTIVITIES)) {
                    if (config.type === emp.currentActivity) {
                        activityDisplay = config.name;
                        break;
                    }
                }
                const durationFormatted = formatDurationWithSeconds(duration);
                const userMention = mentionUser(emp.name, telegramId);
                const reminderMessage = `⚠️ ACTIVITY REMINDER\n\n${userMention} has been on ${activityDisplay} for over 15 minutes!\n\n⏱️ Duration: ${durationFormatted}\n\nPlease click 返回 (Back) to continue working.`;
                bot.sendMessage(emp.currentChatId || telegramId, reminderMessage, { parse_mode: 'Markdown' }).catch(() => {});
                sendNotification(`⚠️ Activity Alert\n\n${userMention} has been on ${activityDisplay} for ${durationFormatted}`, 'Markdown');
                emp.reminderSent = true;
            }
        }
    }
}

function checkLateArrivals() {
    const mexicoNow = getMexicoDate();
    const currentHour = mexicoNow.getHours();
    
    if (currentHour < 8 || currentHour > 12) return;
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        if (emp.status !== 'off' && emp.workStart && !emp.lateNotified) {
            if (isUserLate(emp.workStart)) {
                const lateDurationText = formatDurationWithSeconds(getLateDuration(emp.workStart));
                const userMention = mentionUser(emp.name, telegramId);
                sendNotification(`⚠️ LATE ARRIVAL\n\n${userMention} started work late!\n⏱️ Late by: ${lateDurationText}`, 'Markdown');
                emp.lateNotified = true;
                console.log(`[LATE] ${emp.name} - ${lateDurationText}`);
            }
        }
    }
}

function startKeepAlive() {
    keepAliveInterval = setInterval(() => {
        console.log(`💓 Keep-alive ping at ${new Date().toISOString()}`);
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 14 * 60 * 1000);
}

function startReminderSystems() {
    if (reminderInterval) clearInterval(reminderInterval);
    reminderInterval = setInterval(() => checkActivityTimeouts(), 60 * 1000);
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    lateCheckInterval = setInterval(() => checkLateArrivals(), 60 * 1000);
}

const mainKeyboard = {
    reply_markup: {
        keyboard: [['上班', '下班'], ['吃饭', '抽烟'], ['厕所', '下楼拿外卖'], ['返回']],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// ==================== CALLBACK QUERY HANDLER ====================

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const data = callbackQuery.data;

    if (data === 'verify_membership') {
        const isMember = await isUserMemberOfChannel(userId);
        
        if (isMember) {
            verifiedUsers.add(userId);
            delete pendingUsers[userId];
            
            await bot.answerCallbackQuery(callbackQuery.id, '✅ Verified successfully! You can now use the bot.');
            await bot.sendMessage(chatId, '✅ *Verification Successful!*\n\nYou can now use the bot. Click /start to begin.', { 
                parse_mode: 'Markdown',
                ...mainKeyboard 
            });
            
            console.log(`[VERIFICATION] User ${userId} verified via channel membership`);
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, '❌ You haven\'t joined the channel yet!');
            await bot.sendMessage(chatId, '❌ You are not a member of the referral channel. Please join first and try again.');
            await sendVerificationRequest(chatId, userId);
        }
    }
});

// ==================== COMMAND HANDLERS ====================

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `*Bot Usage Guide*

Work Hours: 8:00 AM Mexico Time
Late Threshold: 15 minutes
Activity Limit: 15 minutes

*Commands:*
/start - Welcome message
/status - View employee status
/report - View daily report
/mytime - Check Mexico time
/help - Show this message

*Buttons:*
上班 - Start work
下班 - Finish work
吃饭, 抽烟, 厕所, 下楼拿外卖 - Take breaks
返回 - Return from break

*Verification:*
- Groups: Must be allowed by admin
- Personal: Must join referral channel
- One-time verification only`;
    try {
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /help:', error.message);
    }
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroupChat = isGroup(msg.chat);
    
    if (isGroupChat) {
        if (!isGroupAllowed(chatId)) {
            try {
                await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot. Please contact the administrator.');
            } catch (e) {}
            return;
        }
        
        const welcomeMessage = `👋 Welcome to the Attendance Bot!\n\nThis group is authorized to use the bot.\n\nUse the buttons below to track attendance.`;
        try {
            await bot.sendMessage(chatId, welcomeMessage, mainKeyboard);
        } catch (e) {}
        return;
    }
    
    const verified = await verifyUserAndGroup(msg);
    if (!verified) {
        return;
    }
    
    try {
        const { name, telegramId } = await getUserInfo(msg);
        employees[telegramId].currentChatId = chatId;
        const welcomeMessage = `Welcome ${name}!\n\nWork Hours: 8:00 AM Mexico Time\nActivity Limit: 15 minutes\n\nUse the buttons below to track your work.`;
        await bot.sendMessage(chatId, welcomeMessage, mainKeyboard);
        await sendNotification(`User Active\n\n${mentionUser(name, telegramId)} started using the bot.`, 'Markdown');
    } catch (error) {
        console.error('Error in /start:', error);
        try {
            await bot.sendMessage(chatId, '❌ Error identifying user.');
        } catch (e) {}
    }
});

bot.onText(/\/mytime/, async (msg) => {
    const chatId = msg.chat.id;
    const mexicoTime = getMexicoDate();
    const workStartTime = getTodayWorkStartMexico();
    const timeMessage = `*Current Mexico Time*\n\n📅 Date: ${mexicoTime.toLocaleDateString('zh-CN')}\n⏱️ Time: ${formatMexicoTime(mexicoTime.getTime())}\n\n🏢 Work Start: ${formatMexicoTime(workStartTime.getTime())}\n⏰ Late After: 8:15 AM`;
    try {
        await bot.sendMessage(chatId, timeMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /mytime:', error.message);
    }
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroupChat = isGroup(msg.chat);
    
    if (isGroupChat && !isGroupAllowed(chatId)) {
        try {
            await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot.');
        } catch (e) {}
        return;
    }
    
    if (!isGroupChat) {
        const verified = await verifyUserAndGroup(msg);
        if (!verified) return;
    }
    
    const working = [];
    const away = [];
    const late = [];
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        if (emp.status === 'working') {
            let workingText = `${emp.name}`;
            if (isUserLate(emp.workStart)) {
                workingText += ` (Late by ${getLateDurationFormatted(emp.workStart)})`;
                late.push(emp.name);
            }
            working.push(workingText);
        } else if (emp.status === 'away') {
            let activityDisplay = '';
            for (const [key, config] of Object.entries(ACTIVITIES)) {
                if (config.type === emp.currentActivity) {
                    activityDisplay = config.name;
                    break;
                }
            }
            const duration = emp.activityStart ? Date.now() - emp.activityStart : 0;
            away.push(`${emp.name} - ${activityDisplay} (${formatDurationWithSeconds(duration)})`);
        }
    }
    
    let statusMessage = '*Employee Status*\n\n';
    statusMessage += '🟢 WORKING\n';
    statusMessage += working.length > 0 ? working.join('\n') : 'None\n';
    if (late.length > 0) statusMessage += `\n⚠️ Late Arrivals: ${late.length}\n`;
    statusMessage += '\n🟡 AWAY\n';
    statusMessage += away.length > 0 ? away.join('\n') : 'None';
    
    try {
        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /status:', error.message);
    }
});

bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroupChat = isGroup(msg.chat);
    
    if (isGroupChat && !isGroupAllowed(chatId)) {
        try {
            await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot.');
        } catch (e) {}
        return;
    }
    
    if (!isGroupChat) {
        const verified = await verifyUserAndGroup(msg);
        if (!verified) return;
    }
    
    if (Object.keys(employees).length === 0) {
        try {
            await bot.sendMessage(chatId, 'No employee data available yet.');
        } catch (e) {}
        return;
    }
    
    let reportMessage = '*Daily Work Report*\n\n';
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        const workStart = emp.dailyReport.workStart || emp.workStart;
        const workEnd = emp.dailyReport.workEnd || emp.workEnd;
        const totals = emp.dailyReport.totals || emp.totals;
        
        let totalWorkMs = 0;
        if (workStart && workEnd) {
            totalWorkMs = workEnd - workStart;
            totalWorkMs -= (totals.meal + totals.smoke + totals.restroom + totals.delivery);
        }
        
        reportMessage += `*${emp.name}*\n`;
        reportMessage += `Start: ${formatMexicoTime(workStart)}\n`;
        reportMessage += `Finish: ${formatMexicoTime(workEnd)}\n`;
        if (isUserLate(workStart)) reportMessage += `⚠️ Late by: ${getLateDurationFormatted(workStart)}\n`;
        reportMessage += `\n*Breakdown:*\n`;
        reportMessage += `🍚 Meal: ${formatDurationWithSeconds(totals.meal)}\n`;
        reportMessage += `🚬 Smoke: ${formatDurationWithSeconds(totals.smoke)}\n`;
        reportMessage += `🚽 Restroom: ${formatDurationWithSeconds(totals.restroom)}\n`;
        reportMessage += `📦 Delivery: ${formatDurationWithSeconds(totals.delivery)}\n`;
        reportMessage += `\n✅ Total Work: ${formatDurationWithSeconds(totalWorkMs)}\n\n`;
    }
    
    try {
        await bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /report:', error.message);
    }
});

// ==================== BUTTON HANDLERS ====================

async function handleButtonWithVerification(msg, callback) {
    const chatId = msg.chat.id;
    const isGroupChat = isGroup(msg.chat);
    
    if (isGroupChat) {
        if (!isGroupAllowed(chatId)) {
            try {
                await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot.');
            } catch (e) {}
            return;
        }
        await callback();
        return;
    }
    
    const verified = await verifyUserAndGroup(msg);
    if (!verified) return;
    await callback();
}

bot.onText(/上班/, async (msg) => {
    await handleButtonWithVerification(msg, async () => {
        const chatId = msg.chat.id;
        try {
            const { telegramId, name } = await getUserInfo(msg);
            const emp = employees[telegramId];
            emp.currentChatId = chatId;
            
            if (emp.status === 'working') {
                await bot.sendMessage(chatId, '❌ You have already started work today!');
                return;
            }
            if (emp.status === 'away') {
                await bot.sendMessage(chatId, '❌ Please finish your current activity (click 返回) before starting work.');
                return;
            }
            
            const now = Date.now();
            emp.status = 'working';
            emp.workStart = now;
            emp.workEnd = null;
            emp.currentActivity = null;
            emp.activityStart = null;
            emp.reminderSent = false;
            emp.lateNotified = false;
            emp.totals = { meal: 0, smoke: 0, restroom: 0, delivery: 0 };
            emp.dailyReport = { workStart: now, workEnd: null, totals: { ...emp.totals } };
            
            const late = isUserLate(now);
            const actualTimeFormatted = formatMexicoTime(now);
            
            let response = `✅ ${name} started work\n⏱️ ${actualTimeFormatted}`;
            
            if (late) {
                const lateDurationText = formatDurationWithSeconds(getLateDuration(now));
                response += `\n\n⚠️ You are late!\n⏱️ Late by: ${lateDurationText}`;
                await sendNotification(`⚠️ LATE ARRIVAL\n\n${mentionUser(name, telegramId)} started work at ${actualTimeFormatted}\nLate by: ${lateDurationText}`, 'Markdown');
            } else {
                console.log(`[ON TIME] ${name} started at ${actualTimeFormatted}`);
            }
            
            await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
            console.log(`[LOG] ${name} started at ${actualTimeFormatted} ${late ? '(LATE)' : '(ON TIME)'}`);
        } catch (error) {
            console.error('Error in 上班:', error);
            try {
                await bot.sendMessage(chatId, '❌ Error processing request.');
            } catch (e) {}
        }
    });
});

bot.onText(/下班/, async (msg) => {
    await handleButtonWithVerification(msg, async () => {
        const chatId = msg.chat.id;
        try {
            const { telegramId, name } = await getUserInfo(msg);
            const emp = employees[telegramId];
            
            if (emp.status !== 'working' && emp.status !== 'away') {
                await bot.sendMessage(chatId, '❌ You haven\'t started work yet! Please click 上班 first.');
                return;
            }
            
            if (emp.status === 'away') {
                if (emp.currentActivity && emp.activityStart) {
                    const durationMs = Date.now() - emp.activityStart;
                    const activityType = emp.currentActivity;
                    if (emp.totals[activityType] !== undefined) {
                        emp.totals[activityType] += durationMs;
                        if (emp.dailyReport.totals[activityType] !== undefined) {
                            emp.dailyReport.totals[activityType] += durationMs;
                        }
                    }
                    emp.status = 'working';
                    emp.currentActivity = null;
                    emp.activityStart = null;
                    emp.reminderSent = false;
                }
            }
            
            const now = Date.now();
            emp.workEnd = now;
            emp.dailyReport.workEnd = now;
            emp.status = 'off';
            
            let workDurationMs = emp.workEnd - emp.workStart;
            const totalBreaks = emp.totals.meal + emp.totals.smoke + emp.totals.restroom + emp.totals.delivery;
            workDurationMs -= totalBreaks;
            
            const response = `✅ ${name} finished work\n\n📊 Work Summary:\n⏱️ Work Duration: ${formatDurationWithSeconds(workDurationMs)}\n⏱️ Break Time: ${formatDurationWithSeconds(totalBreaks)}`;
            await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
        } catch (error) {
            console.error('Error in 下班:', error);
            try {
                await bot.sendMessage(chatId, '❌ Error processing request.');
            } catch (e) {}
        }
    });
});

for (const [activityText, config] of Object.entries(ACTIVITIES)) {
    bot.onText(new RegExp(activityText), async (msg) => {
        await handleButtonWithVerification(msg, async () => {
            const chatId = msg.chat.id;
            try {
                const { telegramId, name } = await getUserInfo(msg);
                const emp = employees[telegramId];
                
                if (emp.status !== 'working') {
                    await bot.sendMessage(chatId, '❌ You must start work first (click 上班) before taking a break.');
                    return;
                }
                if (emp.status === 'away') {
                    await bot.sendMessage(chatId, '❌ You are already on a break. Please click 返回 to continue working.');
                    return;
                }
                
                const now = Date.now();
                emp.status = 'away';
                emp.currentActivity = config.type;
                emp.activityStart = now;
                emp.reminderSent = false;
                
                const response = `✅ ${name} started ${config.name}\n⏱️ ${formatMexicoTime(now)}\n⏱️ Time limit: 15 minutes`;
                await bot.sendMessage(chatId, response, mainKeyboard);
            } catch (error) {
                console.error(`Error in ${activityText}:`, error);
                try {
                    await bot.sendMessage(chatId, '❌ Error processing request.');
                } catch (e) {}
            }
        });
    });
}

bot.onText(/返回/, async (msg) => {
    await handleButtonWithVerification(msg, async () => {
        const chatId = msg.chat.id;
        try {
            const { telegramId, name } = await getUserInfo(msg);
            const emp = employees[telegramId];
            
            if (emp.status !== 'away' || !emp.currentActivity || !emp.activityStart) {
                await bot.sendMessage(chatId, '❌ You don\'t have any active activity to return from.');
                return;
            }
            
            const now = Date.now();
            const durationMs = now - emp.activityStart;
            const activityType = emp.currentActivity;
            
            if (emp.totals[activityType] !== undefined) {
                emp.totals[activityType] += durationMs;
                if (emp.dailyReport.totals[activityType] !== undefined) {
                    emp.dailyReport.totals[activityType] += durationMs;
                }
            }
            
            let activityDisplay = '';
            for (const [key, config] of Object.entries(ACTIVITIES)) {
                if (config.type === activityType) {
                    activityDisplay = config.name;
                    break;
                }
            }
            
            emp.status = 'working';
            emp.currentActivity = null;
            emp.activityStart = null;
            emp.reminderSent = false;
            
            const response = `✅ ${name} returned\n\n📊 Activity: ${activityDisplay}\n⏱️ Duration: ${formatDurationWithSeconds(durationMs)}`;
            await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
        } catch (error) {
            console.error('Error in 返回:', error);
            try {
                await bot.sendMessage(chatId, '❌ Error processing request.');
            } catch (e) {}
        }
    });
});

// ==================== ERROR HANDLING ====================
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (bot) {
        bot.stopPolling().then(() => {
            server.close(() => process.exit(0));
        }).catch(() => {
            server.close(() => process.exit(0));
        });
    } else {
        server.close(() => process.exit(0));
    }
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (bot) {
        bot.stopPolling().then(() => {
            server.close(() => process.exit(0));
        }).catch(() => {
            server.close(() => process.exit(0));
        });
    } else {
        server.close(() => process.exit(0));
    }
});

// ==================== STARTUP ====================
console.log('🚀 Starting Employee Attendance Bot v3.5');
console.log('================================================');
console.log(`✅ Timezone: ${MEXICO_TIMEZONE}`);
console.log(`✅ Work start: ${WORK_START_HOUR}:${WORK_START_MINUTE} AM`);
console.log(`✅ Late threshold: ${LATE_THRESHOLD_MINUTES} minutes`);
console.log(`✅ Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'None'}`);
console.log(`✅ Group Chat: ${GROUP_CHAT_ID || 'Not set'}`);
console.log(`✅ Allowed Groups: ${ALLOWED_GROUP_IDS.length > 0 ? ALLOWED_GROUP_IDS.join(', ') : 'All groups allowed'}`);
console.log(`✅ Referral Channel: ${REFERRAL_CHANNEL_ID || 'Not set'}`);
console.log(`✅ API URL: ${TELEGRAM_API_URL}`);
console.log(`✅ Proxy: ${PROXY_URL || 'Not set'}`);
console.log(`✅ Max Retries: ${MAX_RETRIES}`);
console.log('================================================');

startReminderSystems();
startKeepAlive();

console.log('🎉 Bot is running!');
console.log(`🕐 Current Mexico Time: ${formatMexicoTime(getMexicoDate().getTime())}`);
console.log(`🏢 Work Start (Mexico): ${formatMexicoTime(getTodayWorkStartMexico().getTime())}`);
console.log('================================================');
console.log('💡 Health check available at: http://localhost:' + PORT + '/health');
console.log('================================================');

// Set polling active after successful connection
setTimeout(async () => {
    try {
        if (bot) {
            const me = await bot.getMe();
            console.log(`✅ Bot connected as: ${me.username}`);
            pollingActive = true;
            retryCount = 0;
        }
    } catch (err) {
        console.log('⚠️ Initial connection check failed, will retry...');
        // Try to reconnect if initial connection fails
        reconnectBot();
    }
}, 3000);