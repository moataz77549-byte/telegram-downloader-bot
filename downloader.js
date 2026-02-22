const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('../logger');

const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

// التأكد من وجود مجلد التحميل
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

class DownloaderService {
    static getFormatString(format) {
        switch (format) {
            case '360p': return 'bestvideo[height<=360]+bestaudio/best[height<=360]';
            case '480p': return 'bestvideo[height<=480]+bestaudio/best[height<=480]';
            case '720p': return 'bestvideo[height<=720]+bestaudio/best[height<=720]';
            case '1080p': return 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
            case 'mp3_128': return 'bestaudio/best';
            case 'mp3_320': return 'bestaudio/best';
            case 'best': return 'bestvideo+bestaudio/best';
            default: return 'best';
        }
    }

    static async processMedia(url, format, startTime, endTime) {
        const id = uuidv4();
        const isAudio = format.startsWith('mp3');
        const ext = isAudio ? 'mp3' : 'mp4';
        const finalPath = path.join(DOWNLOAD_DIR, `${id}.${ext}`);
        
        let formatStr = this.getFormatString(format);
        let command = `yt-dlp -f "${formatStr}" --merge-output-format mp4 -o "${finalPath}" "${url}"`;

        if (isAudio) {
            const audioQuality = format === 'mp3_320' ? '320K' : '128K';
            command = `yt-dlp -f "${formatStr}" --extract-audio --audio-format mp3 --audio-quality ${audioQuality} -o "${finalPath}" "${url}"`;
        }

        // إذا كان هناك وقت محدد للقص (استخدام ميزة التفريغ الخاصة بـ yt-dlp و ffmpeg)
        if (startTime && endTime) {
            command += ` --external-downloader ffmpeg --external-downloader-args "ffmpeg_i:-ss ${startTime} -to ${endTime}"`;
        }

        try {
            logger.info(`Starting download: ${url} | Format: ${format}`);
            // زيادة المهلة الزمنية لضمان عدم الفشل في الملفات الكبيرة
            await execPromise(command, { timeout: 900000 }); // 15 دقيقة حد أقصى
            
            if (!fs.existsSync(finalPath)) {
                throw new Error('DOWNLOAD_FAILED_FILE_NOT_FOUND');
            }

            // التأكد من حجم الملف (تليجرام يرفض أكثر من 50 ميجابايت للبوتات العادية)
            const stats = fs.statSync(finalPath);
            const fileSizeMB = stats.size / (1024 * 1024);
            
            if (fileSizeMB > 49.5) {
                fs.unlinkSync(finalPath);
                throw new Error('FILE_TOO_LARGE');
            }

            return finalPath;
        } catch (error) {
            logger.error(`Download Error: ${error.message}`);
            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
            throw error;
        }
    }

    static cleanup(filePath) {
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                logger.info(`Cleaned up temp file: ${filePath}`);
            } catch (err) {
                logger.error(`Cleanup error: ${err.message}`);
            }
        }
    }
}

module.exports = DownloaderService;
