require('dotenv').config();

const express = require('express');
// ✅ FIXED: Support for default, named, and legacy exports
const TelegramBot = require('node-telegram-bot-api').TelegramBot || require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const dns = require('dns');

// ==================== CONFIGURATION FROM .env ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPER_ADMIN_IDS = process.env.SUPER_ADMIN_IDS ? process.env.SUPER_ADMIN_IDS.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || null;
const REFERRAL_CHANNEL_ID = process.env.REFERRAL_CHANNEL_ID || null;
const PROXY_URL = process.env.PROXY_URL || null;
const TELEGRAM_API_URL = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
const CHANNEL_INVITE_LINK = process.env.CHANNEL_INVITE_LINK || null;

if (!BOT_TOKEN) {
    console.error('❌ FATAL ERROR: BOT_TOKEN not found in .env file!');
    process.exit(1);
}

const app = express();
const employees = {};
const pendingUsers = {};
const verifiedUsers = new Set();
const manuallyVerified = new Set();

// ==================== ADMIN CONFIGURATION ====================
// Super admin can see everything
const superAdmins = new Set(SUPER_ADMIN_IDS);

// Normal admins: each can only have ONE active group
const normalAdmins = new Map(); // adminId -> groupId (only one group per admin)
const adminGroups = new Map(); // groupId -> adminId (which admin owns this group)
const approvedGroups = new Set(); // Groups approved by admins
const pendingGroups = {}; // Groups waiting for approval

// Track which admin approved which group
const groupApprovedBy = new Map(); // groupId -> adminId

// ✅ Auto-verify super admins
SUPER_ADMIN_IDS.forEach(adminId => {
    if (adminId) {
        verifiedUsers.add(adminId);
        console.log(`✅ Super Admin ${adminId} auto-verified`);
    }
});

console.log(`✅ Total Super Admins: ${superAdmins.size}`);
console.log(`✅ Super Admins: ${Array.from(superAdmins).join(', ') || 'None'}`);

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
        if (PROXY_URL.startsWith('http://') || PROXY_URL.startsWith('https://')) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            console.log(`✅ Using HTTP proxy: ${PROXY_URL}`);
            return new HttpsProxyAgent(PROXY_URL);
        }
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
            
            bot.on('polling_error', handlePollingError);
            bot.on('error', handleBotError);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
                const me = await bot.getMe();
                console.log(`✅ Bot reconnected successfully! (${me.username})`);
                retryCount = 0;
                pollingActive = true;
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

function setupCommandHandlers() {
    console.log('🔄 Setting up command handlers...');
}

// Initialize bot
console.log('🤖 Initializing bot...');
bot = createBot();

if (!bot) {
    console.error('❌ Failed to create bot. Exiting...');
    process.exit(1);
}

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
        approvedGroups: approvedGroups.size,
        pendingGroups: Object.keys(pendingGroups).length,
        normalAdmins: normalAdmins.size,
        superAdmins: superAdmins.size,
        version: '3.9',
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

// ==================== ADMIN HELPER FUNCTIONS ====================

function isSuperAdmin(userId) {
    return superAdmins.has(userId);
}

function isNormalAdmin(userId) {
    return normalAdmins.has(userId);
}

function isAdmin(userId) {
    return isSuperAdmin(userId) || isNormalAdmin(userId);
}

function canAdminApproveGroup(adminId, groupId) {
    // Super admin can approve any group
    if (isSuperAdmin(adminId)) {
        return true;
    }
    
    // Normal admin: check if they already have an active group
    if (normalAdmins.has(adminId)) {
        const existingGroup = normalAdmins.get(adminId);
        if (existingGroup) {
            // Check if this is the same group (they're trying to re-approve)
            if (existingGroup === groupId) {
                return true;
            }
            // They already have a different active group
            return false;
        }
    }
    
    // Check if this group is already assigned to someone else
    if (adminGroups.has(groupId)) {
        const owner = adminGroups.get(groupId);
        if (owner !== adminId) {
            return false; // Group belongs to someone else
        }
    }
    
    return true;
}

function getAdminGroup(adminId) {
    if (isSuperAdmin(adminId)) {
        return null; // Super admin has no single group
    }
    return normalAdmins.get(adminId) || null;
}

function getGroupAdmin(groupId) {
    return adminGroups.get(groupId) || null;
}

function isGroupOwner(adminId, groupId) {
    if (isSuperAdmin(adminId)) {
        return true;
    }
    const owner = adminGroups.get(groupId);
    return owner === adminId;
}

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
        console.log(`[VERIFICATION] No channel configured, allowing user ${userId}`);
        return true;
    }

    if (isAdmin(userId)) {
        console.log(`[VERIFICATION] Admin ${userId} bypassed channel check`);
        return true;
    }

    if (manuallyVerified.has(userId)) {
        console.log(`[VERIFICATION] User ${userId} manually verified by admin`);
        return true;
    }

    try {
        let channelId = REFERRAL_CHANNEL_ID;
        if (channelId.startsWith('@')) {
            channelId = channelId.substring(1);
        }

        try {
            const chatMember = await bot.getChatMember(`@${channelId}`, userId);
            const isMember = chatMember.status !== 'left' && chatMember.status !== 'kicked';
            console.log(`[VERIFICATION] User ${userId} channel member: ${isMember}`);
            if (isMember) return true;
        } catch (err) {
            console.log(`[VERIFICATION] Channel check failed:`, err.message);
        }

        return false;
    } catch (error) {
        console.log(`[VERIFICATION] Failed to check membership for user ${userId}:`, error.message);
        return false;
    }
}

function isGroupAllowed(groupId) {
    return approvedGroups.has(groupId);
}

function isGroup(chat) {
    return chat && (chat.type === 'group' || chat.type === 'supergroup');
}

async function sendGroupVerificationRequest(chatId, adminId) {
    const groupIdStr = chatId.toString();
    
    if (approvedGroups.has(groupIdStr)) {
        console.log(`[GROUP] Group ${chatId} already approved`);
        return;
    }
    
    if (pendingGroups[groupIdStr]) {
        console.log(`[GROUP] Group ${chatId} already pending approval`);
        return;
    }

    // Check if this admin already has an active group
    if (normalAdmins.has(adminId) && normalAdmins.get(adminId)) {
        const existingGroup = normalAdmins.get(adminId);
        const groupMessage = `❌ *You already have an active group!*\n\n` +
            `You can only have ONE active group at a time.\n\n` +
            `📋 Your current group ID: \`${existingGroup}\`\n\n` +
            `To approve this new group, you must first revoke your current group:\n` +
            `🔄 /revokegroup\n\n` +
            `After revoking, you can approve a new group.`;
        
        try {
            await bot.sendMessage(chatId, groupMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error(`[GROUP] Failed to send message to group ${chatId}:`, error.message);
        }
        
        // Also notify the admin privately
        try {
            await bot.sendMessage(adminId, `❌ *Cannot approve new group*\n\n` +
                `You already have an active group: \`${existingGroup}\`\n\n` +
                `Please use /revokegroup to revoke your current group first, then try again.`, 
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            console.log(`Failed to notify admin ${adminId}:`, err.message);
        }
        
        return;
    }

    pendingGroups[groupIdStr] = {
        timestamp: Date.now(),
        chatId: chatId,
        adminId: adminId
    };

    const groupMessage = `🔐 *Group Verification Required*\n\n` +
        `This group needs approval from the admin who added the bot.\n\n` +
        `📋 *Group ID:* \`${chatId}\`\n` +
        `👤 *Admin ID:* \`${adminId}\`\n\n` +
        `⏳ Please wait for admin approval.\n\n` +
        `*Note:* Each admin can approve ONLY ONE group at a time.`;

    try {
        await bot.sendMessage(chatId, groupMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`[GROUP] Failed to send verification request to group ${chatId}:`, error.message);
    }

    // Notify the specific admin about pending group
    const adminMessage = `🔔 *New Group Verification Request*\n\n` +
        `A new group is requesting access to the bot.\n\n` +
        `📋 *Group ID:* \`${chatId}\`\n` +
        `🕐 *Requested at:* ${new Date().toLocaleString()}\n\n` +
        `*Action:*\n` +
        `✅ Approve: /approvegroup ${chatId}\n\n` +
        `*Note:* You can approve ONLY ONE group at a time.\n` +
        `You currently have ${normalAdmins.has(adminId) && normalAdmins.get(adminId) ? 'an active group' : 'no active group'}.`;

    try {
        await bot.sendMessage(adminId, adminMessage, { parse_mode: 'Markdown' });
    } catch (err) {
        console.log(`Failed to notify admin ${adminId}:`, err.message);
    }
    
    // Also notify super admins
    const superAdminMessage = `🔔 *New Group Verification Request*\n\n` +
        `Group ID: \`${chatId}\`\n` +
        `Requested by Admin: \`${adminId}\`\n` +
        `Time: ${new Date().toLocaleString()}\n\n` +
        `This admin ${normalAdmins.has(adminId) && normalAdmins.get(adminId) ? 'already has a group' : 'has no group yet'}.`;
    
    for (const superAdminId of SUPER_ADMIN_IDS) {
        try {
            await bot.sendMessage(superAdminId, superAdminMessage, { parse_mode: 'Markdown' });
        } catch (err) {
            console.log(`Failed to notify super admin ${superAdminId}:`, err.message);
        }
    }
    
    console.log(`[GROUP] Group ${chatId} pending approval by admin ${adminId}`);
}

async function sendVerificationRequest(chatId, userId) {
    if (!REFERRAL_CHANNEL_ID) {
        console.log(`[VERIFICATION] No channel configured, auto-verifying user ${userId}`);
        verifiedUsers.add(userId);
        return;
    }

    if (isAdmin(userId)) {
        console.log(`[VERIFICATION] Admin ${userId} auto-verified`);
        verifiedUsers.add(userId);
        return;
    }

    if (manuallyVerified.has(userId)) {
        console.log(`[VERIFICATION] User ${userId} manually verified, skipping`);
        verifiedUsers.add(userId);
        return;
    }

    const channelName = REFERRAL_CHANNEL_ID.replace('@', '');
    const inviteLink = CHANNEL_INVITE_LINK || `https://t.me/${channelName}`;
    
    let message = '🔐 *Verification Required*\n\n';
    message += 'To use this bot, you must join our referral channel:\n';
    message += `📢 Channel: [${channelName}](${inviteLink})\n\n`;
    message += '1️⃣ Click "Join Channel" below\n';
    message += '2️⃣ Join the channel\n';
    message += '3️⃣ Return here and click "✅ I have joined!"\n\n';
    message += '⚠️ *Note:* If verification fails, contact an admin.';
    
    const verificationKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📢 Join Channel', url: inviteLink }],
                [{ text: '✅ I have joined!', callback_data: 'verify_membership' }]
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
    const isGroupChat = isGroup(msg.chat);
    
    // ✅ Check if user is admin
    if (userId && isAdmin(userId)) {
        console.log(`[VERIFICATION] Admin ${userId} auto-verified`);
        return true;
    }
    
    // ✅ Check if manually verified
    if (userId && manuallyVerified.has(userId)) {
        console.log(`[VERIFICATION] User ${userId} manually verified`);
        verifiedUsers.add(userId);
        return true;
    }
    
    // ✅ GROUP CHAT VERIFICATION
    if (isGroupChat) {
        const groupIdStr = chatId.toString();
        
        // Check if group is already approved
        if (approvedGroups.has(groupIdStr)) {
            if (userId && !verifiedUsers.has(userId)) {
                verifiedUsers.add(userId);
                console.log(`[VERIFICATION] Auto-verified user ${userId} via approved group ${chatId}`);
            }
            return true;
        }
        
        // Check if group is pending
        if (pendingGroups[groupIdStr]) {
            try {
                await bot.sendMessage(chatId, '⏳ *Your group is pending admin approval.*\n\nPlease wait for the admin to approve this group.', { parse_mode: 'Markdown' });
            } catch (e) {}
            return false;
        }
        
        // New group request - check if the user who added the bot is an admin
        if (userId && isAdmin(userId)) {
            await sendGroupVerificationRequest(chatId, userId);
        } else {
            // Non-admin user added the bot - notify admins
            const groupMessage = `🔐 *Group Verification Required*\n\n` +
                `This group needs to be approved by an admin.\n\n` +
                `📋 *Group ID:* \`${chatId}\`\n\n` +
                `Please contact an admin to approve this group.\n\n` +
                `*Note:* Only admins can approve groups.`;
            
            try {
                await bot.sendMessage(chatId, groupMessage, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error(`[GROUP] Failed to send message to group ${chatId}:`, error.message);
            }
            
            // Notify super admins
            for (const superAdminId of SUPER_ADMIN_IDS) {
                try {
                    await bot.sendMessage(superAdminId, 
                        `🔔 *Group Needs Admin Approval*\n\n` +
                        `Group ID: \`${chatId}\`\n` +
                        `Added by non-admin user: ${userId || 'Unknown'}\n\n` +
                        `A super admin or normal admin needs to approve this group.`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (err) {
                    console.log(`Failed to notify super admin ${superAdminId}:`, err.message);
                }
            }
        }
        return false;
    }
    
    // ✅ PERSONAL CHAT VERIFICATION
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

async function sendAdminNotification(message, parseMode = 'Markdown', targetGroupId = null) {
    let sent = false;
    
    // If target group is specified, send to that group's admin
    if (targetGroupId) {
        const adminId = adminGroups.get(targetGroupId.toString());
        if (adminId) {
            try {
                await bot.sendMessage(adminId, message, { parse_mode: parseMode });
                sent = true;
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err.message);
            }
        }
    }
    
    // Always send to super admins
    for (const adminId of SUPER_ADMIN_IDS) {
        if (adminId && adminId.trim()) {
            try {
                await bot.sendMessage(adminId.trim(), message, { parse_mode: parseMode });
                sent = true;
            } catch (err) {
                if (!err.message.includes('bot can\'t initiate conversation')) {
                    console.error(`Failed to notify super admin ${adminId}:`, err.message);
                }
            }
        }
    }
    
    if (!sent) {
        console.log('📝 Notification:', message.substring(0, 100));
    }
}

function sendGroupAdminNotification(message, parseMode = 'Markdown', groupId) {
    const adminId = adminGroups.get(groupId);
    if (adminId) {
        try {
            bot.sendMessage(adminId, message, { parse_mode: parseMode });
        } catch (err) {
            console.log(`Failed to send to group admin:`, err.message);
        }
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
                
                // Send to group admin
                const groupId = emp.currentChatId && isGroup({ chat: { id: emp.currentChatId } }) ? emp.currentChatId.toString() : null;
                if (groupId) {
                    sendGroupAdminNotification(`⚠️ Activity Alert\n\n${userMention} has been on ${activityDisplay} for ${durationFormatted}`, 'Markdown', groupId);
                }
                // Also send to super admins
                sendAdminNotification(`⚠️ Activity Alert\n\n${userMention} has been on ${activityDisplay} for ${durationFormatted}`, 'Markdown');
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
                const lateMessage = `⚠️ LATE ARRIVAL\n\n${userMention} started work late!\n⏱️ Late by: ${lateDurationText}`;
                
                // Send to group admin
                const groupId = emp.currentChatId && isGroup({ chat: { id: emp.currentChatId } }) ? emp.currentChatId.toString() : null;
                if (groupId) {
                    sendGroupAdminNotification(lateMessage, 'Markdown', groupId);
                }
                // Also send to super admins
                sendAdminNotification(lateMessage, 'Markdown');
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

// ==================== ADMIN COMMANDS ====================

// Add a normal admin (Super Admin only)
bot.onText(/\/addadmin (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const newAdminId = match[1].trim();
    
    if (!isSuperAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only Super Admins can add new admins.');
        return;
    }
    
    if (isAdmin(newAdminId)) {
        await bot.sendMessage(msg.chat.id, `❌ User ${newAdminId} is already an admin.`);
        return;
    }
    
    // Add to admin list
    normalAdmins.set(newAdminId, null); // No group assigned yet
    verifiedUsers.add(newAdminId);
    
    await bot.sendMessage(msg.chat.id, `✅ User ${newAdminId} has been added as a normal admin.\n\nThey can approve ONE group at a time.`);
    
    // Notify the new admin
    try {
        await bot.sendMessage(newAdminId, '✅ *You have been added as an admin!*\n\n' +
            'You can approve ONE group at a time.\n\n' +
            'To approve a group:\n' +
            '1. Add the bot to a group\n' +
            '2. Send /start in the group\n' +
            '3. Use /approvegroup [group_id] to approve\n\n' +
            'To revoke your current group: /revokegroup\n\n' +
            'Use /help to see all commands.', 
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.log(`Failed to notify new admin ${newAdminId}:`, err.message);
    }
    
    await sendAdminNotification(`👤 *New Admin Added*\n\nNew Admin ID: ${newAdminId}\nAdded by: ${msg.from.first_name}`);
});

// Remove a normal admin (Super Admin only)
bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const targetAdminId = match[1].trim();
    
    if (!isSuperAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only Super Admins can remove admins.');
        return;
    }
    
    if (isSuperAdmin(targetAdminId)) {
        await bot.sendMessage(msg.chat.id, '❌ Cannot remove a Super Admin.');
        return;
    }
    
    if (!isNormalAdmin(targetAdminId)) {
        await bot.sendMessage(msg.chat.id, `❌ User ${targetAdminId} is not an admin.`);
        return;
    }
    
    // Get the admin's group if any
    const groupId = normalAdmins.get(targetAdminId);
    if (groupId) {
        // Remove the group from approved groups
        approvedGroups.delete(groupId);
        adminGroups.delete(groupId);
        groupApprovedBy.delete(groupId);
        
        // Notify the group
        try {
            await bot.sendMessage(groupId, '❌ *Group Access Revoked*\n\nYour group has been revoked by the super admin.');
        } catch (err) {
            console.log(`Failed to notify group ${groupId}:`, err.message);
        }
    }
    
    // Remove admin
    normalAdmins.delete(targetAdminId);
    
    await bot.sendMessage(msg.chat.id, `✅ Admin ${targetAdminId} has been removed.`);
    await sendAdminNotification(`👤 *Admin Removed*\n\nRemoved Admin ID: ${targetAdminId}\nRemoved by: ${msg.from.first_name}`);
});

// Approve a group
bot.onText(/\/approvegroup (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const groupId = match[1].trim();
    
    if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
        return;
    }
    
    // Check if group already approved
    if (approvedGroups.has(groupId)) {
        await bot.sendMessage(msg.chat.id, `ℹ️ Group ${groupId} is already approved.`);
        return;
    }
    
    // Check if group is pending
    if (!pendingGroups[groupId]) {
        await bot.sendMessage(msg.chat.id, `❌ Group ${groupId} is not pending approval.`);
        return;
    }
    
    // Check if this is the admin who should approve this group
    const pendingAdminId = pendingGroups[groupId].adminId;
    if (pendingAdminId && pendingAdminId !== userId && !isSuperAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, `❌ This group was requested by another admin (${pendingAdminId}).\n\nOnly that admin or a Super Admin can approve it.`);
        return;
    }
    
    // Check if admin can approve
    if (!canAdminApproveGroup(userId, groupId)) {
        if (isNormalAdmin(userId)) {
            const existingGroup = normalAdmins.get(userId);
            if (existingGroup && existingGroup !== groupId) {
                await bot.sendMessage(msg.chat.id, `❌ You already have an active group (ID: ${existingGroup}).\n\nYou can only have ONE group at a time.\n\nUse /revokegroup to revoke your current group first.`);
                return;
            }
        }
        await bot.sendMessage(msg.chat.id, `❌ You cannot approve this group.`);
        return;
    }
    
    // Approve the group
    approvedGroups.add(groupId);
    delete pendingGroups[groupId];
    
    // Store the admin who approved this group
    if (isNormalAdmin(userId)) {
        normalAdmins.set(userId, groupId);
        adminGroups.set(groupId, userId);
        groupApprovedBy.set(groupId, userId);
    } else {
        // Super admin approving
        groupApprovedBy.set(groupId, 'super_admin');
        adminGroups.set(groupId, 'super_admin');
    }
    
    const adminType = isSuperAdmin(userId) ? 'Super Admin' : 'Admin';
    await bot.sendMessage(msg.chat.id, `✅ Group ${groupId} has been approved by ${adminType}!`);
    
    // Notify the group
    try {
        await bot.sendMessage(groupId, '✅ *Group Approved!*\n\nThis group has been approved and can now use the bot.\n\nUse the buttons below to start tracking attendance.', { 
            parse_mode: 'Markdown',
            ...mainKeyboard 
        });
    } catch (err) {
        console.log(`Failed to notify group ${groupId}:`, err.message);
    }
    
    await sendAdminNotification(`✅ *Group Approved*\n\nGroup ID: ${groupId}\nApproved by: ${msg.from.first_name}\nAdmin Type: ${adminType}`);
});

// Deny a group (Super Admin only)
bot.onText(/\/denygroup (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const groupId = match[1].trim();
    
    if (!isSuperAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only Super Admins can deny groups.');
        return;
    }
    
    delete pendingGroups[groupId];
    
    await bot.sendMessage(msg.chat.id, `❌ Group ${groupId} has been denied.`);
    
    try {
        await bot.sendMessage(groupId, '❌ *Group Denied*\n\nThis group has been denied access to the bot.\n\nPlease contact a Super Admin for more information.');
    } catch (err) {
        console.log(`Failed to notify group ${groupId}:`, err.message);
    }
    
    await sendAdminNotification(`❌ *Group Denied*\n\nGroup ID: ${groupId}\nDenied by: ${msg.from.first_name}`);
});

// Revoke group access (Normal Admin only - revoke their own group)
bot.onText(/\/revokegroup/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!isNormalAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only normal admins can revoke their own group.');
        return;
    }
    
    const groupId = normalAdmins.get(userId);
    if (!groupId) {
        await bot.sendMessage(msg.chat.id, '❌ You don\'t have any group approved.');
        return;
    }
    
    // Revoke the group
    approvedGroups.delete(groupId);
    adminGroups.delete(groupId);
    groupApprovedBy.delete(groupId);
    normalAdmins.set(userId, null);
    
    await bot.sendMessage(msg.chat.id, `✅ Your group ${groupId} has been revoked.\n\nYou can now approve a new group if needed.`);
    
    // Notify the group
    try {
        await bot.sendMessage(groupId, '❌ *Group Access Revoked*\n\nYour group access has been revoked by the admin.\n\nPlease contact your admin for more information.');
    } catch (err) {
        console.log(`Failed to notify group ${groupId}:`, err.message);
    }
    
    await sendAdminNotification(`🔄 *Group Revoked*\n\nGroup ID: ${groupId}\nRevoked by: ${msg.from.first_name}`);
});

// Super Admin revoke any group
bot.onText(/\/revokegroup (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const groupId = match[1].trim();
    
    if (!isSuperAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only Super Admins can revoke groups.');
        return;
    }
    
    if (!approvedGroups.has(groupId)) {
        await bot.sendMessage(msg.chat.id, `❌ Group ${groupId} is not approved.`);
        return;
    }
    
    // Find which admin owns this group
    let ownerAdminId = adminGroups.get(groupId);
    if (ownerAdminId && ownerAdminId !== 'super_admin') {
        // Remove from normal admin's list
        normalAdmins.set(ownerAdminId, null);
    }
    
    // Remove group
    approvedGroups.delete(groupId);
    adminGroups.delete(groupId);
    groupApprovedBy.delete(groupId);
    
    await bot.sendMessage(msg.chat.id, `✅ Group ${groupId} has been revoked.`);
    
    // Notify the group
    try {
        await bot.sendMessage(groupId, '❌ *Group Access Revoked*\n\nYour group access has been revoked by the Super Admin.');
    } catch (err) {
        console.log(`Failed to notify group ${groupId}:`, err.message);
    }
    
    await sendAdminNotification(`🔄 *Group Revoked by Super Admin*\n\nGroup ID: ${groupId}\nRevoked by: ${msg.from.first_name}`);
});

// List pending groups
bot.onText(/\/pendinggroups/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
        return;
    }
    
    const pendingList = Object.keys(pendingGroups);
    
    if (pendingList.length === 0) {
        await bot.sendMessage(msg.chat.id, '📋 No pending group requests.');
        return;
    }
    
    let message = '*Pending Group Requests:*\n\n';
    pendingList.forEach((groupId, index) => {
        const request = pendingGroups[groupId];
        const time = new Date(request.timestamp).toLocaleString();
        const adminId = request.adminId || 'Unknown';
        message += `${index + 1}. Group ID: \`${groupId}\`\n`;
        message += `   Requested by Admin: ${adminId}\n`;
        message += `   Time: ${time}\n`;
        if (isSuperAdmin(userId) || adminId === userId) {
            message += `   Approve: /approvegroup ${groupId}\n`;
        }
        message += '\n';
    });
    
    if (isSuperAdmin(userId)) {
        message += '\n*Super Admin:* You can approve or deny any group.';
        message += '\nDeny: /denygroup [group_id]';
    } else {
        message += '\n*Note:* You can approve ONE group at a time.';
        const currentGroup = normalAdmins.get(userId);
        if (currentGroup) {
            message += `\n📋 Your current group: \`${currentGroup}\``;
            message += `\n🔄 Use /revokegroup to revoke it first.`;
        }
    }
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// List approved groups
bot.onText(/\/approvedgroups/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
        return;
    }
    
    const approvedList = Array.from(approvedGroups);
    
    if (approvedList.length === 0) {
        await bot.sendMessage(msg.chat.id, '📋 No approved groups.');
        return;
    }
    
    let message = '*Approved Groups:*\n\n';
    approvedList.forEach((groupId, index) => {
        const adminId = groupApprovedBy.get(groupId);
        const adminName = adminId === 'super_admin' ? 'Super Admin' : adminId || 'Unknown';
        message += `${index + 1}. Group ID: \`${groupId}\`\n`;
        message += `   Approved by: ${adminName}\n`;
    });
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// My group (for normal admins)
bot.onText(/\/mygroup/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!isNormalAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only normal admins can view their group.');
        return;
    }
    
    const groupId = normalAdmins.get(userId);
    if (!groupId) {
        await bot.sendMessage(msg.chat.id, '📋 You don\'t have any group approved yet.\n\n' +
            'To approve a group:\n' +
            '1. Add the bot to a group\n' +
            '2. Send /start in the group\n' +
            '3. Use /approvegroup [group_id] to approve');
        return;
    }
    
    const isApproved = approvedGroups.has(groupId);
    const status = isApproved ? '✅ Active' : '⏳ Pending';
    
    let message = `*Your Group:*\n\n`;
    message += `📋 Group ID: \`${groupId}\`\n`;
    message += `📊 Status: ${status}\n\n`;
    message += `*Actions:*\n`;
    message += `🔄 /revokegroup - Revoke this group (to approve a new one)\n`;
    message += `📊 /status - View employee status\n`;
    message += `📋 /report - View daily report`;
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// List all admins (Super Admin only)
bot.onText(/\/listadmins/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!isSuperAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Only Super Admins can view all admins.');
        return;
    }
    
    let message = '*👑 Super Admins:*\n\n';
    Array.from(superAdmins).forEach(id => {
        message += `- \`${id}\` (Full Access)\n`;
    });
    
    message += '\n*👤 Normal Admins:*\n\n';
    if (normalAdmins.size === 0) {
        message += 'No normal admins configured.\n';
        message += '\nTo add: /addadmin [user_id]';
    } else {
        for (const [adminId, groupId] of normalAdmins) {
            const groupStatus = groupId ? `Group: ${groupId}` : 'No group yet';
            message += `- \`${adminId}\` (${groupStatus})\n`;
        }
    }
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// Manual verification for users (All admins)
bot.onText(/\/verify (\d+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const targetUserId = match[1];
    
    if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
        return;
    }
    
    manuallyVerified.add(targetUserId);
    verifiedUsers.add(targetUserId);
    delete pendingUsers[targetUserId];
    
    await bot.sendMessage(msg.chat.id, `✅ User ${targetUserId} has been manually verified.`);
    
    try {
        await bot.sendMessage(targetUserId, '✅ You have been manually verified by an admin! You can now use the bot.\n\nClick /start to begin.');
    } catch (err) {
        console.log(`Failed to notify user ${targetUserId}:`, err.message);
    }
});

// Unverify a user (All admins)
bot.onText(/\/unverify (\d+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const targetUserId = match[1];
    
    if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
        return;
    }
    
    manuallyVerified.delete(targetUserId);
    verifiedUsers.delete(targetUserId);
    
    await bot.sendMessage(msg.chat.id, `❌ User ${targetUserId} has been unverified.`);
});

// List verified users (All admins)
bot.onText(/\/listverified/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
        return;
    }
    
    let message = '*Verified Users:*\n\n';
    message += `Total: ${verifiedUsers.size}\n\n`;
    message += 'User IDs:\n';
    const users = Array.from(verifiedUsers).slice(0, 50);
    users.forEach(id => {
        message += `- ${id}\n`;
    });
    if (verifiedUsers.size > 50) {
        message += `\n... and ${verifiedUsers.size - 50} more`;
    }
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// ==================== CALLBACK QUERY HANDLER ====================

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const data = callbackQuery.data;

    if (data === 'verify_membership') {
        if (isAdmin(userId)) {
            verifiedUsers.add(userId);
            delete pendingUsers[userId];
            await bot.answerCallbackQuery(callbackQuery.id, '✅ Admin auto-verified!');
            await bot.sendMessage(chatId, '✅ *Admin Verified!*\n\nYou are an admin, so you\'re automatically verified.', { 
                parse_mode: 'Markdown',
                ...mainKeyboard 
            });
            return;
        }

        if (manuallyVerified.has(userId)) {
            verifiedUsers.add(userId);
            delete pendingUsers[userId];
            await bot.answerCallbackQuery(callbackQuery.id, '✅ Verified successfully!');
            await bot.sendMessage(chatId, '✅ *Verification Successful!*\n\nYou can now use the bot. Click /start to begin.', { 
                parse_mode: 'Markdown',
                ...mainKeyboard 
            });
            return;
        }

        if (!REFERRAL_CHANNEL_ID) {
            verifiedUsers.add(userId);
            delete pendingUsers[userId];
            await bot.answerCallbackQuery(callbackQuery.id, '✅ Auto-verified!');
            await bot.sendMessage(chatId, '✅ *Verification Successful!*\n\nYou can now use the bot. Click /start to begin.', { 
                parse_mode: 'Markdown',
                ...mainKeyboard 
            });
            return;
        }

        await bot.answerCallbackQuery(callbackQuery.id, '⏳ Checking your membership...');

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
            await bot.answerCallbackQuery(callbackQuery.id, '❌ Verification failed. Please try again.');
            
            const failMessage = `⚠️ *Unable to verify your membership automatically.*\n\n` +
                `Please try these steps:\n` +
                `1️⃣ Click the "Join Channel" button below\n` +
                `2️⃣ Join the channel\n` +
                `3️⃣ Wait 5-10 seconds\n` +
                `4️⃣ Click the "✅ I have joined!" button again\n\n` +
                `*Still having issues?*\n` +
                `Contact an admin for manual verification.\n\n` +
                `Admins: ${Array.from(superAdmins).join(', ')}`;
            
            await bot.sendMessage(chatId, failMessage, { parse_mode: 'Markdown' });
            
            sendAdminNotification(
                `⚠️ *Verification Issue*\n\n` +
                `User: ${callbackQuery.from.first_name}\n` +
                `User ID: ${userId}\n` +
                `Failed to verify channel membership.\n\n` +
                `Use /verify ${userId} to manually verify this user.`,
                'Markdown'
            );
        }
    }
});

// ==================== COMMAND HANDLERS ====================

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id.toString() : null;
    const isSuperAdminUser = isSuperAdmin(userId);
    const isNormalAdminUser = isNormalAdmin(userId);
    const currentGroup = isNormalAdminUser ? normalAdmins.get(userId) : null;
    
    let helpMessage = `*🤖 Attendance Bot Help*\n\n`;
    helpMessage += `Work Hours: 8:00 AM Mexico Time\n`;
    helpMessage += `Late Threshold: 15 minutes\n`;
    helpMessage += `Activity Limit: 15 minutes\n\n`;
    
    if (isSuperAdminUser) {
        helpMessage += `*👑 SUPER ADMIN COMMANDS*\n\n`;
        helpMessage += `📋 *Admin Management:*\n`;
        helpMessage += `👤 /addadmin [user_id] - Add a normal admin\n`;
        helpMessage += `👤 /removeadmin [user_id] - Remove a normal admin\n`;
        helpMessage += `📋 /listadmins - List all admins\n\n`;
        
        helpMessage += `📋 *Group Management:*\n`;
        helpMessage += `📋 /pendinggroups - List pending groups\n`;
        helpMessage += `📊 /approvedgroups - List approved groups\n`;
        helpMessage += `✅ /approvegroup [group_id] - Approve a group\n`;
        helpMessage += `❌ /denygroup [group_id] - Deny a group\n`;
        helpMessage += `🔄 /revokegroup [group_id] - Revoke a group\n\n`;
        
        helpMessage += `👤 *User Management:*\n`;
        helpMessage += `✅ /verify [user_id] - Verify a user\n`;
        helpMessage += `❌ /unverify [user_id] - Unverify a user\n`;
        helpMessage += `📋 /listverified - List verified users\n\n`;
        
        helpMessage += `📊 *Reports:*\n`;
        helpMessage += `📊 /status - View ALL employees\n`;
        helpMessage += `📋 /report - View ALL reports\n`;
        helpMessage += `🕐 /mytime - Check Mexico time\n\n`;
        
        helpMessage += `*Note:* As Super Admin, you have access to ALL groups and ALL reports.`;
        
    } else if (isNormalAdminUser) {
        helpMessage += `*👤 NORMAL ADMIN COMMANDS*\n\n`;
        
        if (currentGroup) {
            helpMessage += `✅ *Your Active Group:* \`${currentGroup}\`\n\n`;
        } else {
            helpMessage += `⏳ *No Active Group*\n\n`;
        }
        
        helpMessage += `📋 *Your Info:*\n`;
        helpMessage += `📋 /mygroup - View your group\n`;
        helpMessage += `🔄 /revokegroup - Revoke your group (to approve a new one)\n\n`;
        
        helpMessage += `📋 *Group Management:*\n`;
        helpMessage += `📋 /pendinggroups - List pending groups\n`;
        helpMessage += `📊 /approvedgroups - List approved groups\n`;
        helpMessage += `✅ /approvegroup [group_id] - Approve a group (ONE at a time)\n\n`;
        
        if (currentGroup) {
            helpMessage += `📊 *Your Group Reports:*\n`;
            helpMessage += `📊 /status - View your group employees\n`;
            helpMessage += `📋 /report - View your group report\n`;
            helpMessage += `🕐 /mytime - Check Mexico time\n\n`;
        }
        
        helpMessage += `👤 *User Management:*\n`;
        helpMessage += `✅ /verify [user_id] - Verify a user\n`;
        helpMessage += `❌ /unverify [user_id] - Unverify a user\n`;
        helpMessage += `📋 /listverified - List verified users\n\n`;
        
        helpMessage += `*⚠️ IMPORTANT:*\n`;
        helpMessage += `You can approve ONLY ONE group at a time.\n`;
        if (currentGroup) {
            helpMessage += `✅ Your current group: \`${currentGroup}\`\n`;
            helpMessage += `To approve a different group, first use /revokegroup`;
        } else {
            helpMessage += `To approve a group:\n`;
            helpMessage += `1. Add bot to group\n`;
            helpMessage += `2. Send /start in group\n`;
            helpMessage += `3. Use /approvegroup [group_id]`;
        }
        
        helpMessage += `\n\n*Need help?* Contact a Super Admin.`;
        
    } else {
        // Regular user
        helpMessage += `*👤 USER COMMANDS*\n\n`;
        helpMessage += `📋 /start - Start the bot\n`;
        helpMessage += `📊 /status - View employee status\n`;
        helpMessage += `📋 /report - View daily report\n`;
        helpMessage += `🕐 /mytime - Check Mexico time\n`;
        helpMessage += `❓ /help - Show this message\n\n`;
        
        helpMessage += `*Buttons:*\n`;
        helpMessage += `🟢 上班 - Start work\n`;
        helpMessage += `🔴 下班 - Finish work\n`;
        helpMessage += `🍚 吃饭 - Meal break\n`;
        helpMessage += `🚬 抽烟 - Smoke break\n`;
        helpMessage += `🚽 厕所 - Restroom break\n`;
        helpMessage += `📦 下楼拿外卖 - Delivery break\n`;
        helpMessage += `↩️ 返回 - Return from break\n\n`;
        
        helpMessage += `*How to use:*\n`;
        helpMessage += `1. Click 上班 to start work\n`;
        helpMessage += `2. Use break buttons when taking breaks\n`;
        helpMessage += `3. Click 返回 when returning from break\n`;
        helpMessage += `4. Click 下班 when finishing work\n\n`;
        
        helpMessage += `*Verification:*\n`;
        helpMessage += `- Personal chat: Must join referral channel\n`;
        helpMessage += `- Groups: Must be approved by admin\n`;
        helpMessage += `- Admins: Auto-verified`;
    }
    
    try {
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /help:', error.message);
    }
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroupChat = isGroup(msg.chat);
    const userId = msg.from ? msg.from.id.toString() : null;
    
    if (isGroupChat) {
        const verified = await verifyUserAndGroup(msg);
        if (!verified) {
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
        
        // Only notify admins if user is not an admin
        if (!isAdmin(userId)) {
            const adminMessage = `👤 *User Active*\n\n${mentionUser(name, telegramId)} started using the bot.`;
            await sendAdminNotification(adminMessage, 'Markdown');
        }
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
    const userId = msg.from ? msg.from.id.toString() : null;
    
    // If it's a group, check if approved
    if (isGroupChat && !isGroupAllowed(chatId)) {
        try {
            await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot.');
        } catch (e) {}
        return;
    }
    
    // For personal chats, verify user
    if (!isGroupChat) {
        const verified = await verifyUserAndGroup(msg);
        if (!verified) return;
    }
    
    // If it's a normal admin, only show their group
    if (isNormalAdmin(userId) && !isSuperAdmin(userId)) {
        const adminGroupId = normalAdmins.get(userId);
        if (!adminGroupId) {
            await bot.sendMessage(chatId, '📊 You don\'t have any group approved yet.\n\nUse /pendinggroups to see pending groups.');
            return;
        }
        
        // Filter employees by group
        const groupEmployees = {};
        for (const [telegramId, emp] of Object.entries(employees)) {
            if (emp.currentChatId && emp.currentChatId.toString() === adminGroupId) {
                groupEmployees[telegramId] = emp;
            }
        }
        
        if (Object.keys(groupEmployees).length === 0) {
            await bot.sendMessage(chatId, '📊 No employees in your group yet.');
            return;
        }
        
        const working = [];
        const away = [];
        const late = [];
        
        for (const [telegramId, emp] of Object.entries(groupEmployees)) {
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
        
        let statusMessage = `*Your Group Status*\n\n`;
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
        return;
    }
    
    // Super admin or regular user - show all employees
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
    const userId = msg.from ? msg.from.id.toString() : null;
    
    // If it's a group, check if approved
    if (isGroupChat && !isGroupAllowed(chatId)) {
        try {
            await bot.sendMessage(chatId, '❌ This group is not authorized to use this bot.');
        } catch (e) {}
        return;
    }
    
    // For personal chats, verify user
    if (!isGroupChat) {
        const verified = await verifyUserAndGroup(msg);
        if (!verified) return;
    }
    
    // If it's a normal admin, only show their group
    if (isNormalAdmin(userId) && !isSuperAdmin(userId)) {
        const adminGroupId = normalAdmins.get(userId);
        if (!adminGroupId) {
            await bot.sendMessage(chatId, '📊 You don\'t have any group approved yet.\n\nUse /pendinggroups to see pending groups.');
            return;
        }
        
        // Filter employees by group
        const groupEmployees = {};
        for (const [telegramId, emp] of Object.entries(employees)) {
            if (emp.currentChatId && emp.currentChatId.toString() === adminGroupId) {
                groupEmployees[telegramId] = emp;
            }
        }
        
        if (Object.keys(groupEmployees).length === 0) {
            await bot.sendMessage(chatId, '📊 No employees in your group yet.');
            return;
        }
        
        let reportMessage = '*Your Group Daily Report*\n\n';
        for (const [telegramId, emp] of Object.entries(groupEmployees)) {
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
        return;
    }
    
    // Super admin or regular user - show all employees
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
    const userId = msg.from ? msg.from.id.toString() : null;
    
    if (userId && isAdmin(userId)) {
        console.log(`[BUTTON] Admin ${userId} bypassed verification`);
        await callback();
        return;
    }
    
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
                const lateMessage = `⚠️ LATE ARRIVAL\n\n${mentionUser(name, telegramId)} started work at ${actualTimeFormatted}\nLate by: ${lateDurationText}`;
                
                // Send to group admin
                const groupId = chatId && isGroup({ chat: { id: chatId } }) ? chatId.toString() : null;
                if (groupId) {
                    sendGroupAdminNotification(lateMessage, 'Markdown', groupId);
                }
                sendAdminNotification(lateMessage, 'Markdown');
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
            
            const summaryMessage = `📊 *Work Summary*\n\n${mentionUser(name, telegramId)}\n⏱️ Work Duration: ${formatDurationWithSeconds(workDurationMs)}\n⏱️ Break Time: ${formatDurationWithSeconds(totalBreaks)}`;
            
            // Send to group admin
            const groupId = chatId && isGroup({ chat: { id: chatId } }) ? chatId.toString() : null;
            if (groupId) {
                sendGroupAdminNotification(summaryMessage, 'Markdown', groupId);
            }
            sendAdminNotification(summaryMessage, 'Markdown');
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
            
            const breakMessage = `⏱️ *Break Summary*\n\n${mentionUser(name, telegramId)}\n📊 ${activityDisplay}: ${formatDurationWithSeconds(durationMs)}`;
            
            // Send to group admin
            const groupId = chatId && isGroup({ chat: { id: chatId } }) ? chatId.toString() : null;
            if (groupId) {
                sendGroupAdminNotification(breakMessage, 'Markdown', groupId);
            }
            sendAdminNotification(breakMessage, 'Markdown');
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
console.log('🚀 Starting Employee Attendance Bot v3.9');
console.log('================================================');
console.log(`✅ Timezone: ${MEXICO_TIMEZONE}`);
console.log(`✅ Work start: ${WORK_START_HOUR}:${WORK_START_MINUTE} AM`);
console.log(`✅ Late threshold: ${LATE_THRESHOLD_MINUTES} minutes`);
console.log(`✅ Super Admins: ${Array.from(superAdmins).join(', ') || 'None'}`);
console.log(`✅ Normal Admins: ${normalAdmins.size}`);
console.log(`✅ Approved Groups: ${approvedGroups.size}`);
console.log(`✅ Pending Groups: ${Object.keys(pendingGroups).length}`);
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
        reconnectBot();
    }
}, 3000);
