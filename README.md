# VU Bot - Ferdowsi University Moodle Monitor

A Telegram bot that monitors Ferdowsi University's virtual learning platform (VU) for new assignments, quizzes, and course updates. It sends notifications to a Telegram channel/group with deadline reminders and file attachments.

## Features

- 🔄 Automatic course monitoring at configurable intervals
- 📝 New assignment notifications with deadline info
- ❓ Quiz notifications with open/close times
- 📎 Automatic file attachment downloads and uploads to Telegram
- ⏰ Deadline reminders (24 hours before due)
- 📅 Persian (Shamsi) date conversion
- 🔐 Captcha handling via Telegram admin
- 📃 Live-updating deadline overview message

## Prerequisites

- Node.js 18+
- Chromium/Chrome browser
- Telegram Bot Token
- Telegram Group/Channel

## Installation

1. Clone the repository:
```bash
git clone https://github.com/AidinShekari/VUBOT-FUM.git
cd VUBOT-FUM
```

2. Install dependencies:
```bash
npm install
```

3. Copy the example environment file and configure it:
```bash
cp .env.example .env
```

4. Edit `.env` with your credentials:
```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_TOPIC_ID=your_topic_id
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id
VU_USERNAME=your_student_id
VU_PASSWORD=your_password
COURSE_URLS=https://vu.um.ac.ir/course/view.php?id=12345
CHECK_INTERVAL=10
```

## Usage

Run the bot:
```bash
node app.js
```

For production, use PM2:
```bash
npm install -g pm2
pm2 start app.js --name vubot
pm2 save
```

## Environment Variables

| Variable                 | Description                             |
| ------------------------ | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | Telegram bot token from @BotFather      |
| `TELEGRAM_CHAT_ID`       | Target chat/group ID for notifications  |
| `TELEGRAM_TOPIC_ID`      | (Optional) Topic ID for forum groups    |
| `TELEGRAM_ADMIN_CHAT_ID` | Admin chat ID for captcha handling      |
| `VU_USERNAME`            | University student ID                   |
| `VU_PASSWORD`            | University password                     |
| `COURSE_URLS`            | Comma-separated course URLs to monitor  |
| `CHECK_INTERVAL`         | Check interval in minutes (default: 10) |
| `DEBUG_MODE`             | Enable debug logging (true/false)       |
| `CHROME_PATH`            | (Optional) Set Chrome executable path   |
| `HTTP_PROXY`             | (Optional) Set Proxy for telegram bot   |

## License

MIT

## Author

Aidin Shekari
