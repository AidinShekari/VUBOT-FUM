# VU Bot

VU Bot monitors Moodle courses on `vu.um.ac.ir` and sends course updates to Bale or Telegram-compatible bot APIs. It logs in to the Ferdowsi University virtual learning system, checks configured course pages on a schedule, detects new or changed activities, and sends notifications for files, assignments, quizzes, deadlines, and reminders.

## Features

- Monitors one or more VU/Moodle course URLs.
- Supports Bale by default and Telegram through the Telegram Bot API.
- Uses OAuth login for `vu.um.ac.ir`.
- Sends notifications for new course activities.
- Tracks assignments and quizzes with open/close/deadline dates.
- Sends assignment attachments when files are small enough.
- Sends Google Calendar buttons for deadline-based activities.
- Maintains an editable deadline overview message.
- Supports a global chat plus optional per-course chat IDs.
- Stores local state so duplicate notifications are avoided.
- Supports optional forum topic/thread routing for the global chat.

## Requirements

- Node.js 18 or newer recommended.
- npm.
- A Bale or Telegram bot token.
- VU username and password.
- Course URLs from `https://vu.um.ac.ir/course/view.php?id=...`.

## Installation

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Then edit `.env` with your bot token, chat IDs, VU credentials, and course list.

## Configuration

### Messaging Platform

```env
API_PROVIDER=BALE
BALE_API_BASE_URL=
TG_API_BASE_URL=
```

`API_PROVIDER` can be:

- `BALE`: uses `https://tapi.bale.ai`.
- `TELEGRAM`: uses `https://api.telegram.org`.
- `BOTH`: sends to both Bale and Telegram, using each platform's token and chat IDs.

`BALE_API_BASE_URL` and `TG_API_BASE_URL` are optional. Set them only if you need custom Telegram-compatible API endpoints.

### Bot Settings

```env
BALE_BOT_TOKEN=your_bale_bot_token
TG_BOT_TOKEN=your_telegram_bot_token
GLOBAL_CHAT_ID_BALE=your_bale_chat_id
GLOBAL_CHAT_ID_TG=your_telegram_chat_id
TOPIC_ID=
ADMIN_CHAT_ID=
BOT_POLLING=false
```

- `BALE_BOT_TOKEN`: token for your Bale bot.
- `TG_BOT_TOKEN`: token for your Telegram bot.
- `GLOBAL_CHAT_ID_BALE`: main Bale chat where course overviews and notifications are sent when Bale is active.
- `GLOBAL_CHAT_ID_TG`: main Telegram chat where course overviews and notifications are sent when Telegram is active.
- `TOPIC_ID`: optional. Used when the global chat is a forum/supergroup topic.
- `ADMIN_CHAT_ID`: optional. Reserved for admin/captcha-related flows.
- `BOT_POLLING`: optional. Defaults to `false`; leave it disabled unless you add inbound bot handlers.

### Proxy

```env
TG_SOCKS_PROXY=socks5://user:pass@host:port
HTTP_PROXY=
```

- `TG_SOCKS_PROXY`: optional SOCKS proxy for Telegram API requests.
- `HTTP_PROXY`: optional HTTP proxy for bot API requests. If `TG_SOCKS_PROXY` is set, Telegram uses the SOCKS proxy.

### VU Login

```env
VU_USERNAME=your_vu_username
VU_PASSWORD=your_vu_password
```

These values are required for the OAuth login flow. Do not commit `.env`; it is ignored by `.gitignore`.

### Courses

The recommended format is JSON:

```env
COURSES='[
  {
    "url": "https://vu.um.ac.ir/course/view.php?id=12345",
    "chatid_bale": "optional_bale_chat",
    "chatid_tg": "optional_telegram_chat"
  }
]'
```

Each item supports:

- `url`: required course URL.
- `chatid_bale`: optional extra Bale chat for this specific course. Legacy `chatId` is still accepted as a Bale fallback.
- `chatid_tg`: optional extra Telegram chat for this specific course.

If the matching per-course chat is set, updates for that course are sent to both the active platform's global chat and the per-course chat. With `API_PROVIDER=BOTH`, Bale uses `chatid_bale` and Telegram uses `chatid_tg`.

Legacy comma-separated config is still supported:

```env
COURSE_URLS=https://vu.um.ac.ir/course/view.php?id=12345,https://vu.um.ac.ir/course/view.php?id=67890
COURSE_CHAT_IDS_BALE=bale_chat_for_first_course,bale_chat_for_second_course
COURSE_CHAT_IDS_TG=tg_chat_for_first_course,tg_chat_for_second_course
```

### Other Settings

```env
CHECK_INTERVAL=5
DEBUG_MODE=false
CHROME_PATH=
```

- `CHECK_INTERVAL`: minutes between monitoring cycles. Default is `5`.
- `DEBUG_MODE`: enables additional debug behavior where implemented.
- `CHROME_PATH`: currently kept for compatibility with older browser-based versions.

## Running

```bash
npm start
```

The bot will:

1. Load local state files if they exist.
2. Log in to VU.
3. Check all configured courses.
4. Send or update course/deadline messages.
5. Schedule future checks using `CHECK_INTERVAL`.

The cron timezone is `Asia/Tehran`.

## Runtime Files

The bot creates local JSON files to remember what it already sent:

- `course_data.json`
- `message_ids.json`
- `deadline_message_id.json`
- `course_deadline_message_ids.json`
- `reminders.json`
- `last_day_reminders.json`

These files are intentionally ignored by git because they are machine/runtime state.

## Git-Ignored Files

The repository ignores:

- `.env` and other local env files.
- `node_modules/`.
- generated runtime JSON files.
- downloaded/generated folders such as `files/` and `sample_html/`.
- logs and OS/editor files.

## OAuth Login Notes

VU currently redirects `https://vu.um.ac.ir/login/index.php` directly into the OAuth provider flow. The bot handles that direct redirect and posts credentials to the detected OAuth login form.

If login fails:

1. Confirm `VU_USERNAME` and `VU_PASSWORD` are correct.
2. Confirm the course URLs are accessible by that account in a normal browser.
3. Check whether `oauth.um.ac.ir` is requiring extra verification or blocking automated requests.
4. Review console logs for the final login URL and error message.

## Deployment Tips

For a long-running server, use a process manager such as `pm2`:

```bash
npm install -g pm2
pm2 start app.js --name vu-bot
pm2 save
```

Or run it with systemd, Docker, or another supervisor. The important part is that the process stays alive so scheduled checks can continue.

## Common Problems

### No Notifications

Check:

- `BALE_BOT_TOKEN` and/or `TG_BOT_TOKEN` is valid for the active provider.
- `GLOBAL_CHAT_ID_BALE`, `GLOBAL_CHAT_ID_TG`, or the per-course `chatid_bale` / `chatid_tg` is correct.
- The bot is added to the target chat.
- For Telegram groups, the bot has permission to send messages.
- `COURSES` is valid JSON.

### Duplicate or Missing Overview Messages

The bot stores editable message IDs in `message_ids.json` and `deadline_message_id.json`. If those messages were manually deleted from the chat, the bot may need one successful cycle to recreate or re-register them.

## Development

Syntax-check the main file:

```bash
node --check app.js
```

Run locally:

```bash
npm start
```

Keep `.env` and runtime JSON files out of commits. Only commit source, package files, `.env.example`, `.gitignore`, and documentation.
