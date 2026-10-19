FROM node:22-bookworm-slim

# Office 문서 변환(LibreOffice), PDF 렌더링(poppler), 한글 글꼴
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer libreoffice-calc poppler-utils \
    fonts-noto-cjk fonts-nanum fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
