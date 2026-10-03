// Identify the crawler honestly so site owners can see who we are and block us via robots.txt
export const BOT_NAME = 'MenuBuffBot';
export const USER_AGENT = `${BOT_NAME}/0.1 (+https://github.com/comacrae/menubuff)`;

export const OUT_DIR = new URL('../out/', import.meta.url);
