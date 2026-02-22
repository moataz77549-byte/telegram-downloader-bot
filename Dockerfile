FROM node:20-bullseye-slim

# تثبيت ffmpeg و python3 (مطلوب لـ yt-dlp)
RUN apt-get update && apt-get install -y ffmpeg python3 curl && rm -rf /var/lib/apt/lists/*

# تثبيت أحدث نسخة من yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# إنشاء مجلد للملفات المؤقتة
RUN mkdir -p downloads

CMD ["npm", "start"]
