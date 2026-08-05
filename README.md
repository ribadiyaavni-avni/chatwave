# ChatWave — Flask + MySQL PWA chat with WhatsApp-style WebRTC calls

## Run locally (XAMPP)
1. Start **MySQL** in the XAMPP Control Panel (Apache is not needed).
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
3. Start the app:
   ```
   python app.py
   ```
4. Open http://localhost:5000 — the `chatwave` database, and the
   `users`, `messages`, and new `calls` tables are created automatically.
   Existing `users` and `messages` data is left untouched.

## Calls
- WebRTC peer-to-peer media (audio + video). Flask-SocketIO is used ONLY
  for signaling: call lifecycle, SDP offer/answer, ICE candidates.
- STUN defaults to Google's public servers. To add TURN (needed when both
  peers are behind strict NATs), set environment variables before running:
  ```
  TURN_URLS=turn:your.turn.host:3478
  TURN_USERNAME=user
  TURN_CREDENTIAL=pass
  ```
- Call history is stored in the `calls` MySQL table and every finished
  call also appears inside the chat thread (missed / declined / duration),
  plus in the Calls tab on the home screen.

## Testing calls on two devices
Browsers only allow camera/microphone on `localhost` or HTTPS. To test
from a phone on your LAN, either use an HTTPS tunnel (e.g. `ngrok http 5000`)
or run Flask with a self-signed certificate. On the same PC, two different
browsers (or one normal + one incognito window) on `localhost` work as-is.

## Environment variables
```
MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DB
SECRET_KEY
STUN_URLS, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
```
