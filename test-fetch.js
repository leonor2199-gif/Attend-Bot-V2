require('dotenv').config();

const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`;

console.log('Testing Telegram with Node fetch...');

const controller = new AbortController();

const timeout = setTimeout(() => {
    controller.abort();
}, 15000);

fetch(url, {
    signal: controller.signal
})
    .then(async (response) => {
        clearTimeout(timeout);

        console.log('HTTP status:', response.status);
        console.log('Response:', await response.text());
    })
    .catch((error) => {
        clearTimeout(timeout);

        console.error('FETCH ERROR:', error);
    });