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
API_BASE_URL=
```

`API_PROVIDER` can be:

- `BALE`: uses `https://tapi.bale.ai`.
- `TELEGRAM`: uses `https://api.telegram.org`.

`API_BASE_URL` is optional. Set it only if you need a custom Telegram-compatible API endpoint.

### Bot Settings

```env
BOT_TOKEN=your_bot_token
GLOBAL_CHAT_ID=your_chat_id
TOPIC_ID=
ADMIN_CHAT_ID=
```

- `BOT_TOKEN`: required. Token for your Bale or Telegram bot.
- `GLOBAL_CHAT_ID`: main chat where course overviews and notifications are sent.
- `TOPIC_ID`: optional. Used when the global chat is a forum/supergroup topic.
- `ADMIN_CHAT_ID`: optional. Reserved for admin/captcha-related flows.

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
    "chatId": "optional_specific_chat"
  }
]'
```

Each item supports:

- `url`: required course URL.
- `chatId`: optional extra chat for this specific course.

If `chatId` is set, updates for that course are sent to both `GLOBAL_CHAT_ID` and the per-course chat.

Legacy comma-separated config is still supported:

```env
COURSE_URLS=https://vu.um.ac.ir/course/view.php?id=12345,https://vu.um.ac.ir/course/view.php?id=67890
COURSE_CHAT_IDS=chat_for_first_course,chat_for_second_course
```

### Other Settings

```env
CHECK_INTERVAL=5
DEBUG_MODE=false
CHROME_PATH=
HTTP_PROXY=
```

- `CHECK_INTERVAL`: minutes between monitoring cycles. Default is `5`.
- `DEBUG_MODE`: enables additional debug behavior where implemented.
- `CHROME_PATH`: currently kept for compatibility with older browser-based versions.
- `HTTP_PROXY`: optional proxy for bot API requests.

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

### Push Rejected After Resetting History

If you intentionally reset the repository history, a normal push may fail because the remote has old commits. Replace the remote branch with:

```bash
git push --force-with-lease origin main
```

Use this only when you really want GitHub history to match the new local history.

### No Notifications

Check:

- `BOT_TOKEN` is valid.
- `GLOBAL_CHAT_ID` or per-course `chatId` is correct.
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
