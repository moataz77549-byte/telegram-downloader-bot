require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const logger = require('./logger');
const DownloaderService = require('./services/downloader');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// تخزين الطلبات المؤقتة في الذاكرة (للحد من الطلبات وتخزين البيانات بين الأزرار)
const userSessions = new Map();
const rateLimitMap = new Map();

// إعداد القائمة البيضاء
const whitelistedUsers = (process.env.WHITELISTED_USERS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// 1. ميدل وير للتحقق من القائمة البيضاء
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return; // تجاهل التحديثات التي لا تحتوي على مستخدم

    if (whitelistedUsers.length > 0 && !whitelistedUsers.includes(userId)) {
        logger.warn(`Unauthorized access attempt by User: ${userId}`);
        return ctx.reply('عذراً، أنت غير مصرح لك باستخدام هذا البوت.');
    }
    return next();
});

// 2. ميدل وير للحد من الطلبات (3 طلبات كل ساعة)
bot.use(async (ctx, next) => {
    if (!ctx.message || !ctx.message.text) return next();
    
    const userId = ctx.from.id;
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    if (!rateLimitMap.has(userId)) {
        rateLimitMap.set(userId, { count: 0, firstRequest: now });
    }

    const userData = rateLimitMap.get(userId);

    // إعادة تعيين العداد إذا مرت ساعة
    if (now - userData.firstRequest > oneHour) {
        userData.count = 0;
        userData.firstRequest = now;
    }

    // السماح بمرور الأوامر العادية، وحساب الروابط فقط
    if (ctx.message.text.includes('youtube.com') || ctx.message.text.includes('youtu.be')) {
        if (userData.count >= 3) {
            const remainingMins = Math.ceil((oneHour - (now - userData.firstRequest)) / 60000);
            return ctx.reply(`لقد تجاوزت الحد المسموح (3 طلبات/ساعة). يرجى المحاولة بعد ${remainingMins} دقيقة.`);
        }
        // لا نزيد العداد هنا، بل نزيد عند بدء التحميل الفعلي لضمان عدم احتساب المحاولات الفاشلة أو الاستفسارات
    }
    
    return next();
});

// أمر البدء
bot.start((ctx) => {
    ctx.reply(
        'مرحباً بك! أرسل رابط يوتيوب لتحميله.\n' +
        'لإقتطاع جزء محدد، أرسل الرابط مع وقت البداية والنهاية هكذا:\n' +
        '`https://youtu.be/xxx 00:01:00 00:02:30`',
        { parse_mode: 'Markdown' }
    );
});

// معالجة الروابط
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    
    // استخراج الرابط والأوقات (إن وجدت)
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
    if (!urlMatch || (!text.includes('youtube.com') && !text.includes('youtu.be'))) {
        return; // تجاهل الرسائل العادية
    }

    const url = urlMatch[0];
    const timeRegex = /\b(\d{2}:\d{2}:\d{2})\b/g;
    const times = text.match(timeRegex);
    
    let startTime = null, endTime = null;
    if (times && times.length >= 2) {
        startTime = times[0];
        endTime = times[1];
    }

    // حفظ بيانات الجلسة المؤقتة
    const sessionId = ctx.from.id.toString();
    userSessions.set(sessionId, { url, startTime, endTime });

    // عرض أزرار الجودة
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🎬 360p', 'dl_360p'), Markup.button.callback('🎬 480p', 'dl_480p')],
        [Markup.button.callback('🎬 720p', 'dl_720p'), Markup.button.callback('🎬 1080p', 'dl_1080p')],
        [Markup.button.callback('🎵 MP3 (128kbps)', 'dl_mp3_128'), Markup.button.callback('🎵 MP3 (320kbps)', 'dl_mp3_320')],
        [Markup.button.callback('🌟 أفضل جودة', 'dl_best')]
    ]);

    let msg = `الرابط: ${url}\n`;
    if (startTime && endTime) msg += `القص: من ${startTime} إلى ${endTime}\n`;
    msg += `\nاختر الجودة المطلوبة:`;

    await ctx.reply(msg, keyboard);
});

// معالجة الضغط على الأزرار
bot.action(/dl_(.+)/, async (ctx) => {
    const format = ctx.match[1];
    const userId = ctx.from.id;
    const sessionId = userId.toString();
    const sessionData = userSessions.get(sessionId);

    if (!sessionData) {
        return ctx.answerCbQuery('انتهت الجلسة، يرجى إرسال الرابط مجدداً.', { show_alert: true });
    }

    // زيادة عداد الاستخدام عند بدء التحميل الفعلي
    const userData = rateLimitMap.get(userId);
    if (userData) userData.count += 1;

    await ctx.answerCbQuery();
    const processingMsg = await ctx.reply('⏳ جاري المعالجة والتحميل، يرجى الانتظار...');

    let filePath = null;
    try {
        filePath = await DownloaderService.processMedia(
            sessionData.url, 
            format, 
            sessionData.startTime, 
            sessionData.endTime
        );

        await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, '📤 جاري رفع الملف للتليجرام...');

        if (format.startsWith('mp3')) {
            await ctx.replyWithAudio({ source: filePath });
        } else {
            await ctx.replyWithVideo({ source: filePath });
        }

        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

    } catch (error) {
        logger.error(`Process Error: ${error.message}`);
        let errorMsg = '❌ حدث خطأ أثناء التحميل. تأكد من الرابط أو حاول لاحقاً.';
        
        if (error.message === 'FILE_TOO_LARGE') {
            errorMsg = '❌ الملف كبير جداً (أكثر من 50 ميجا). يرجى اختيار جودة أقل أو قص الفيديو.';
        } else if (error.message === 'DOWNLOAD_FAILED_FILE_NOT_FOUND') {
            errorMsg = '❌ فشل التحميل، لم يتم العثور على الملف الناتج.';
        }
        
        await ctx.reply(errorMsg);
        // في حالة الخطأ، يمكننا إعادة المحاولة لاحقاً، لذا قد نخصم من العداد إذا أردت
    } finally {
        if (filePath) {
            DownloaderService.cleanup(filePath);
        }
        userSessions.delete(sessionId);
    }
});

// خادم Express بسيط لضمان بقاء Render يعمل
app.get('/', (req, res) => res.send('Bot is running...'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Web server is listening on port ${PORT}`);
});

// تشغيل البوت
bot.launch().then(() => {
    logger.info('Telegram Bot is successfully running!');
}).catch(err => {
    logger.error(`Bot failed to start: ${err.message}`);
});

// التعامل مع إيقاف التشغيل بأمان
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
