# VU Bot - Ferdowsi University Moodle Monitor

A bot that monitors Ferdowsi University's virtual learning platform (VU) for new assignments, quizzes, and course updates. It sends notifications to Telegram or Bale channels/groups with deadline reminders and file attachments.

## Features

- 🔄 Automatic course monitoring at configurable intervals
- 📝 New assignment notifications with deadline info
- ❓ Quiz notifications with open/close times
- 📎 Automatic file attachment downloads and uploads
- ⏰ Deadline reminders (24 hours before due + last day reminders)
- 📅 Persian (Shamsi/Jalali) date conversion
- 🔐 Captcha handling via admin chat
- 📃 Live-updating deadline overview message
- 📱 Support for both Telegram and Bale messaging platforms
- 🎯 Per-course chat ID routing for separate notification channels

## Prerequisites

- Node.js 18+
- Chromium/Chrome browser
- Telegram or Bale Bot Token
- Telegram/Bale Group/Channel

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
# Messaging Platform
API_PROVIDER=BALE                       # TELEGRAM or BALE (default: BALE)
API_BASE_URL=                           # Optional: custom API URL

# Bot Configuration
BOT_TOKEN=your_bot_token
GLOBAL_CHAT_ID=your_chat_id             # Main chat for all notifications
TOPIC_ID=                               # Optional: for forum groups
ADMIN_CHAT_ID=                          # For captcha handling

# Course Configuration (JSON format - recommended)
COURSES='[{"url":"https://vu.um.ac.ir/course/view.php?id=12345","chatId":"optional_specific_chat"}]'

# Or legacy format (comma-separated)
COURSE_URLS=https://vu.um.ac.ir/course/view.php?id=12345
COURSE_CHAT_IDS=                        # Optional: per-course chat IDs

# Other Settings
CHECK_INTERVAL=5                        # Minutes between checks (default: 5)
DEBUG_MODE=false
CHROME_PATH=                            # Optional: Chrome executable path
HTTP_PROXY=                             # Optional: proxy for bot requests
```

## Course Configuration

### JSON Format (Recommended)
```env
COURSES='[
  {"url": "https://vu.um.ac.ir/course/view.php?id=123"},
  {"url": "https://vu.um.ac.ir/course/view.php?id=456", "chatId": "-100123456789"}
]'
```

### Legacy Format
```env
COURSE_URLS=https://vu.um.ac.ir/course/view.php?id=123,https://vu.um.ac.ir/course/view.php?id=456
COURSE_CHAT_IDS=,-100123456789
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

| Variable | Description |
| --- | --- |
| `API_PROVIDER` | Messaging platform: `TELEGRAM` or `BALE` (default: `BALE`) |
| `API_BASE_URL` | Custom API URL (auto-set based on provider) |
| `BOT_TOKEN` | Bot token from @BotFather or Bale |
| `GLOBAL_CHAT_ID` | Main chat/group ID for all notifications |
| `TOPIC_ID` | Topic ID for forum groups (optional) |
| `ADMIN_CHAT_ID` | Admin chat ID for captcha handling |
| `COURSES` | JSON array of course objects with url and optional chatId |
| `COURSE_URLS` | Legacy: comma-separated course URLs |
| `COURSE_CHAT_IDS` | Legacy: comma-separated per-course chat IDs |
| `CHECK_INTERVAL` | Check interval in minutes (default: 5) |
| `DEBUG_MODE` | Enable debug logging (`true`/`false`) |
| `CHROME_PATH` | Chrome/Chromium executable path (optional) |
| `HTTP_PROXY` | Proxy URL for bot requests (optional) |

## Data Files

The bot creates these files to persist state:
- `course_data.json` - Course sections and activity data
- `message_ids.json` - Telegram message IDs for editing
- `deadline_message_id.json` - Deadline overview message ID
- `reminders.json` - Sent reminder history
- `last_day_reminders.json` - Last day reminder history

## License

MIT

## Author

Aidin Shekari
