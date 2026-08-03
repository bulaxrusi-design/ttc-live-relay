# Migration from Device Lab v2

1. Press **STOP BRIDGE** in the old app and disable its `ChatGPT screen help`
   accessibility service.
2. Disable Auto Clicker or other gesture-automation accessibility services during
   measured sessions. Competing gesture dispatch invalidates action and TTC data.
3. Revoke the GitHub personal access token used by v2. v3 does not use a GitHub
   token on the phone or poll repository branches.
4. Keep v2 installed only until the first v3 smoke test passes, then uninstall it
   so the two foreground services cannot be confused.
5. Install v3, configure its WSS enrollment token and exact game packages, enable
   only `Device Lab Live game gestures`, and grant a fresh screen-capture session.

Do not reuse the former GitHub PAT as the WSS enrollment token. Generate a new,
random 32-byte value on the relay host and never put it in screenshots, chat, or
source control.
